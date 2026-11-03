// WU-007 (#117): the P-9 grounded-retrieval probe. Offline only: the global fetch throws for the
// whole file, the SDK is given a stub fetch and a stub credential, and the run guard works in a
// temporary records folder. Nothing here can reach Google.
// cspell:words aiplatform genai vertexai
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const probeDir = "../../scripts/probes/act08";
const ROOT = process.cwd();
const NOW = Date.parse("2026-10-10T12:00:00Z");
const runsDir = path.join(ROOT, "DOCS/research/act08-runs");
const runRecords = () => readdirSync(runsDir).filter((f) => f.endsWith(".json"));

let lib: any;
let p9: any;
let GoogleGenAI: any;
const realFetch = globalThis.fetch;
const dirs: string[] = [];

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("network access in an ACT-08 P-9 test");
  }) as typeof fetch;
  lib = await import(`${probeDir}/lib.mjs`);
  p9 = await import(`${probeDir}/p9-grounded-retrieval.mjs`);
  ({ GoogleGenAI } = await import("@google/genai"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function records() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "act08-p9-"));
  dirs.push(dir);
  writeFileSync(
    path.join(dir, "credit-position-1.json"),
    JSON.stringify({ read_at: new Date(NOW - 3_600_000).toISOString(), balance_usd: 298 }),
  );
  return dir;
}

function ledger(dir: string) {
  const file = path.join(dir, "spend-ledger.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The real SDK, with a stub credential, sending through the guarded capture. */
const makeClient = (capture: any) =>
  new GoogleGenAI({
    vertexai: true,
    project: "mgpl-508415",
    location: "us-central1",
    googleAuthOptions: {
      authClient: { getRequestHeaders: async () => new Headers({ Authorization: "Bearer test" }) },
    },
    httpOptions: { fetch: capture.fetch },
  });

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function answer(title: string, citation: string | null) {
  return {
    title,
    publisher: null,
    original_game_release_date: null,
    confidence_score: 0.5,
    steam_app_id: null,
    studio: null,
    tags: null,
    source_citation: citation,
  };
}

const SOURCE = {
  uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
  title: "store.steampowered.com",
};

function candidate(text: string, grounded: boolean) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        ...(grounded
          ? {
              groundingMetadata: {
                webSearchQueries: ["game"],
                groundingChunks: [{ web: SOURCE }],
                groundingSupports: [],
              },
            }
          : {}),
      },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 },
  };
}

/** A stub Vertex: answers by inspecting the request body the guard admitted. */
function stubVertex({ refuseSchemaWithSearch }: { refuseSchemaWithSearch: boolean }) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const grounded = Array.isArray(body.tools);
    const withSchema = Boolean(body.generationConfig?.responseSchema);
    const prompt = body.contents[0].parts[0].text as string;
    const title = /titled "([^"]+)"/.exec(prompt)?.[1] ?? "?";
    if (grounded && withSchema && refuseSchemaWithSearch) {
      return json(
        {
          error: {
            code: 400,
            message:
              "Unable to submit request because Controlled generation is not supported with Google_search tool.",
            status: "INVALID_ARGUMENT",
          },
        },
        400,
      );
    }
    const value = answer(title, grounded ? `Steam: ${SOURCE.title}` : "Steam store page");
    const text = withSchema ? JSON.stringify(value) : "```json\n" + JSON.stringify(value) + "\n```";
    return json(candidate(text, grounded));
  });
}

describe("P-9 building blocks", () => {
  it("fetch throws for this whole file", () => {
    expect(() => globalThis.fetch("https://example.invalid/")).toThrow(/network access/);
  });

  it("describes every model column in the described-schema prompt", async () => {
    const p1 = await import(`${probeDir}/p1-structured-output.mjs`);
    const source = readFileSync(path.join(ROOT, "src/db.ts"), "utf8");
    const { modelColumns } = p1.buildResponseSchema(p1.parseTableColumns(source, p1.TABLE).columns);
    const prompt = p9.describedSchemaPrompt("Hollow Knight", modelColumns);
    for (const c of modelColumns) expect(prompt).toContain(`- ${c.name}:`);
    expect(prompt).toContain("title: string, required, never null");
    expect(prompt).toContain("confidence_score: number, required, never null, 0 to 1");
  });

  it("reads a JSON object out of fenced or bare text", () => {
    expect(p9.parseJsonText('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    expect(p9.parseJsonText('Here: {"a":1} done').value).toEqual({ a: 1 });
    expect(p9.parseJsonText("no object").ok).toBe(false);
    expect(p9.parseJsonText(null).ok).toBe(false);
  });

  it("classifies a citation against the grounding sources by stated rules", () => {
    const g = { groundingChunks: [{ web: SOURCE }] };
    const f = (c: string | null, gm: unknown = g) => p9.provenanceOf(c, gm).finding;
    expect(f(null)).toBe("null");
    expect(f(`see ${SOURCE.uri}`)).toBe("exact_uri");
    expect(f("https://store.steampowered.com/app/367520/")).toBe("same_host");
    expect(f(" Store.SteamPowered.com ")).toBe("exact_title");
    expect(f("Steam: store.steampowered.com.")).toBe("title_mentioned");
    // a longer host that only starts with the source's domain is not a match
    expect(f("https://store.steampowered.com.evil.invalid/fabricated")).toBe("no_match");
    expect(f("store.steampowered.com-mirror.net")).toBe("no_match");
    expect(f("Steam store page for Hollow Knight")).toBe("no_match");
    expect(f("Steam store page", null)).toBe("no_match");
    expect(p9.PROVENANCE_RULES).toHaveLength(6);
  });

  it("treats a 400 as the schema-with-Search refusal only when it says so", () => {
    const r = (message: string, status = 400) => p9.isSchemaWithSearchRefusal({ status, message });
    expect(
      r(
        "Unable to submit request because Controlled generation is not supported with Google_search tool.",
      ),
    ).toBe(true);
    expect(r("Search Grounding can't be used with JSON/YAML/XML mode.")).toBe(true);
    expect(r("Invalid response_schema: unsupported property")).toBe(false);
    expect(r("Controlled generation is not supported with Google_search tool.", 500)).toBe(false);
  });

  it("builds exactly the body the SDK sends, and the guard admits every planned request", async () => {
    const p1 = await import(`${probeDir}/p1-structured-output.mjs`);
    const source = readFileSync(path.join(ROOT, "src/db.ts"), "utf8");
    const { modelColumns, schema } = p1.buildResponseSchema(
      p1.parseTableColumns(source, p1.TABLE).columns,
    );
    const rates = await lib.loadRates();
    const seen: string[] = [];
    const client = makeClient({
      fetch: async (_url: string, init: RequestInit) => {
        seen.push(String(init.body));
        return json(candidate("{}", false));
      },
    });
    const variants = [
      { grounded: false, form: "schema" },
      { grounded: true, form: "schema" },
      { grounded: true, form: "described" },
    ];
    for (const v of variants) {
      const params = p9.requestParams({ title: "Hollow Knight", ...v, schema, modelColumns });
      await client.models.generateContent(params);
      expect(seen.at(-1)).toBe(p9.vertexBody(params));
      const bound = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", seen.at(-1));
      expect(bound.grounding).toBe(v.grounded);
      expect(bound.max_cost_usd).toBeLessThan(0.52);
    }
  });

  it("reserves what entry #117 has left", async () => {
    const dir = records();
    expect(await p9.entryHeadroom({ dir })).toMatchObject({ requests: 50, usd: 5 });
    writeFileSync(
      path.join(dir, "spend-ledger.jsonl"),
      [
        { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1.25, max_requests: 3 },
        { type: "attempt", run_id: "r0", entry: "#117", attempt_id: "r0:1", max_cost_usd: 0.5 },
        { type: "end", run_id: "r0", entry: "#117", status: "failed" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    expect(await p9.entryHeadroom({ dir })).toMatchObject({ requests: 49, usd: 3.75 });
  });
});

describe("P-9 dry-run", () => {
  it("prints the plan and sends nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = runRecords();
    await expect(p9.main([])).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runRecords()).toEqual(before);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("grounded preflight (schema)");
    expect(text).toContain("total: 6 requests (preflight accepted) or 7 (preflight refused)");
  });
});

describe("P-9 --run through the real guard (stubbed Vertex)", () => {
  async function run(stub: any, dir = records()) {
    let written: any = null;
    const code = await p9.main(["--run"], {
      dir,
      now: () => NOW,
      baseFetch: stub,
      makeClient,
      write: (record: any) => {
        written = record;
        return record.exit_status;
      },
    });
    return { code, record: written, dir };
  }

  it("preflight refused: records the finding and grounds every case with the described schema", async () => {
    const stub = stubVertex({ refuseSchemaWithSearch: true });
    const { code, record, dir } = await run(stub);
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(7);
    expect(record.preflight_finding).toMatchObject({ schema_with_search: "refused", status: 400 });
    expect(record.grounded_form).toBe("described");
    const grounded = record.steps.filter((s: any) => s.mode === "grounded" && !s.error);
    expect(grounded.map((s: any) => s.step)).toEqual(["grounded 1", "grounded 2", "grounded 3"]);
    expect(grounded.every((s: any) => s.schema_honoured)).toBe(true);
    expect(grounded.every((s: any) => s.provenance.finding === "title_mentioned")).toBe(true);
    const bare = record.steps.filter((s: any) => s.mode === "bare");
    expect(bare.every((s: any) => s.provenance.finding === "no_match")).toBe(true);
    expect(record.executed_by).toMatch(/^Implementer: Cline × ChatGPT Subscription, the lane/);
    expect(record.result.provenance_rules).toEqual(p9.PROVENANCE_RULES);
    // grounded cost includes the full grounding fee
    expect(grounded[0].cost.computed_cost_usd).toBeCloseTo((120 * 0.3 + 80 * 2.5) / 1e6 + 0.035, 9);
    const lines = ledger(dir);
    expect(lines[0]).toMatchObject({
      type: "reservation",
      entry: "#117",
      max_usd: 5,
      max_requests: 50,
    });
    expect(lines.filter((l) => l.type === "attempt")).toHaveLength(7);
    expect(lines.filter((l) => l.type === "result")).toHaveLength(7);
    expect(lines.at(-1)).toMatchObject({ type: "end", status: "completed" });
    expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(false);
  });

  it("preflight accepted: keeps the schema and sends 6 requests", async () => {
    const stub = stubVertex({ refuseSchemaWithSearch: false });
    const { code, record, dir } = await run(stub);
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(6);
    expect(record.preflight_finding).toEqual({ schema_with_search: "accepted" });
    expect(record.grounded_form).toBe("schema");
    expect(ledger(dir).at(-1)).toMatchObject({ type: "end", status: "completed" });
  });

  it("stops on a 400 that is not the schema-with-Search refusal", async () => {
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (Array.isArray(body.tools))
        return json(
          {
            error: {
              code: 400,
              message: "Invalid response_schema: unsupported property",
              status: "INVALID_ARGUMENT",
            },
          },
          400,
        );
      return json(candidate(JSON.stringify(answer("x", null)), false));
    });
    const { code, record, dir } = await run(stub);
    expect(code).toBe(1);
    expect(stub).toHaveBeenCalledTimes(4);
    expect(record.preflight_finding).toBeUndefined();
    expect(record.result.stop_reason).toMatch(
      /grounded preflight failed: .*Invalid response_schema/,
    );
    expect(ledger(dir).at(-1)).toMatchObject({ type: "end", status: "failed" });
  });

  it("ends the run when setup after openRun() fails", async () => {
    const dir = records();
    let written: any = null;
    const code = await p9.main(["--run"], {
      dir,
      now: () => NOW,
      baseFetch: vi.fn(),
      makeClient: () => {
        throw new Error("client setup failed");
      },
      write: (record: any) => {
        written = record;
        return record.exit_status;
      },
    });
    expect(code).toBe(1);
    expect(written.error.message).toBe("client setup failed");
    expect(ledger(dir).at(-1)).toMatchObject({ type: "end", status: "failed" });
    expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(false);
  });

  it("stops before the next request on Ctrl+C, and ends the run as stopped", async () => {
    const dir = records();
    const interrupts = new EventEmitter();
    const stub = vi.fn(async () => {
      interrupts.emit("SIGINT");
      return json(candidate(JSON.stringify(answer("x", null)), false));
    });
    let written: any = null;
    const code = await p9.main(["--run"], {
      dir,
      now: () => NOW,
      baseFetch: stub,
      makeClient,
      interrupts,
      write: (record: any) => {
        written = record;
        return record.exit_status;
      },
    });
    expect(code).toBe(1);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(written.steps).toHaveLength(1);
    expect(written.result.stop_reason).toMatch(/operator interrupt/);
    expect(ledger(dir).at(-1)).toMatchObject({ type: "end", status: "stopped" });
    expect(interrupts.listenerCount("SIGINT")).toBe(0);
  });

  it("stops at the first unexpected error and ends the run as failed", async () => {
    const stub = vi.fn(async () =>
      json({ error: { code: 500, message: "backend error", status: "INTERNAL" } }, 500),
    );
    const { code, record, dir } = await run(stub);
    expect(code).toBe(1);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(record.result.stop_reason).toMatch(/bare request failed/);
    expect(ledger(dir).at(-1)).toMatchObject({ type: "end", status: "failed" });
  });

  it("is refused before anything is sent when the records do not allow a run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "act08-p9-empty-"));
    dirs.push(dir);
    const stub = vi.fn();
    await expect(run(stub, dir)).rejects.toBeInstanceOf(lib.GuardRefusal);
    expect(stub).not.toHaveBeenCalled();
  });
});
