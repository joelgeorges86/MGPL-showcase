import { readdirSync, readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const probeDir = "../../scripts/probes/act08";
const runsDir = path.resolve(process.cwd(), "DOCS/research/act08-runs");
const runRecords = () => readdirSync(runsDir).filter((f) => f.endsWith(".json"));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ACT-08 probe library", () => {
  it("defaults to dry-run and refuses --run with --dry-run", async () => {
    const lib = await import(`${probeDir}/lib.mjs`);
    expect(lib.parseArgs([]).mode).toBe("dry-run");
    expect(lib.parseArgs(["--run"]).mode).toBe("run");
    expect(() => lib.parseArgs(["--run", "--dry-run"])).toThrow(lib.UsageError);
    expect(() => lib.parseArgs(["--unknown"])).toThrow(lib.UsageError);
  });

  it("computes cost from usage metadata and labels it computed", async () => {
    const lib = await import(`${probeDir}/lib.mjs`);
    const rates = await lib.loadRates();
    const cost = lib.computeGenerateCost(rates, "gemini-2.5-flash", {
      promptTokenCount: 1000,
      cachedContentTokenCount: 400,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 50,
    });
    // (600 * 0.30 + 400 * 0.03 + 150 * 2.50) / 1e6
    expect(cost.computed_cost_usd).toBeCloseTo(0.000567, 9);
    expect(cost).not.toHaveProperty("cost_charged_usd");
  });

  it("enforces the request cap before sending and drops credential headers", async () => {
    const lib = await import(`${probeDir}/lib.mjs`);
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const capture = lib.createCapture({ maxRequests: 2, baseFetch });
    const init = {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
    };
    await capture.fetch("https://example.invalid/a", init);
    await capture.fetch("https://example.invalid/b", init);
    await expect(capture.fetch("https://example.invalid/c", init)).rejects.toMatchObject({
      capReached: true,
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(capture.attempts).toBe(2);
    expect(capture.exchanges[0].request_headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.stringify(capture.exchanges)).not.toContain("Bearer");
  });
});

describe("ACT-08 P-1 schema derivation", () => {
  it("derives the response schema from the AppGames_Staging DDL in src/db.ts", async () => {
    const p1 = await import(`${probeDir}/p1-structured-output.mjs`);
    const source = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");
    const { columns, unmapped } = p1.parseTableColumns(source, "AppGames_Staging");
    const { modelColumns, schema } = p1.buildResponseSchema(columns);
    expect(modelColumns.map((c: { name: string }) => c.name)).toEqual([
      "title",
      "publisher",
      "original_game_release_date",
      "confidence_score",
      "steam_app_id",
      "studio",
      "tags",
      "source_citation",
    ]);
    expect(schema.properties.title).toEqual({ type: "STRING" });
    expect(schema.properties.confidence_score).toEqual({ type: "NUMBER", minimum: 0, maximum: 1 });
    expect(schema.properties.publisher.nullable).toBe(true);
    expect(unmapped).toEqual(["UNIQUE(run_id, game_id)"]);

    const valid = Object.fromEntries(modelColumns.map((c: { name: string }) => [c.name, null]));
    valid.title = "A";
    valid.confidence_score = 0.1;
    expect(p1.validate(valid, modelColumns)).toEqual([]);
    expect(p1.validate({ ...valid, confidence_score: 2 }, modelColumns)).toHaveLength(1);
    expect(p1.validate({ ...valid, title: null }, modelColumns)).toHaveLength(1);
    expect(p1.validate({ ...valid, extra: 1 }, modelColumns)).toHaveLength(1);
  });
});

describe("ACT-08 dry-runs send nothing", () => {
  it.each([
    ["p1-structured-output.mjs", []],
    ["p2-context-cache.mjs", []],
    ["p5-code-execution.mjs", []],
    ["p8-rate-quota.mjs", ["--max-requests", "10"]],
  ])("%s dry-run makes no network call and writes no record", async (file, argv) => {
    const probe = await import(`${probeDir}/${file}`);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = runRecords();
    await expect(probe.main(argv)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runRecords()).toEqual(before);
  });

  it("P-8 refuses to run without --max-requests", async () => {
    const p8 = await import(`${probeDir}/p8-rate-quota.mjs`);
    const lib = await import(`${probeDir}/lib.mjs`);
    expect(() => p8.parseP8Args(["--run"])).toThrow(lib.UsageError);
    expect(() => p8.parseP8Args([])).toThrow(/mandatory/);
  });

  it("P-4 reference check reports missing fixtures instead of passing", async () => {
    const p4 = await import(`${probeDir}/p4-embeddings.mjs`);
    const fixture = { reference_blob: "x", dimensions: 2, fixtures: ["a", "b"] };
    expect(p4.checkReference(fixture, { a: [1, 0], b: [0, 1] })).toEqual([]);
    expect(p4.checkReference(fixture, { a: [1, 0] })).toHaveLength(2);
    expect(p4.checkReference(fixture, { __error: "missing" })).toHaveLength(1);
  });
});
