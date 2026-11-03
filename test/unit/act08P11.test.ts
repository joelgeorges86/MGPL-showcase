// Task proposal 021: the P-11 library-page probe. Offline only: the global fetch throws for the
// whole file, the SDK gets a stub fetch and a stub credential, the run guard works in a temporary
// records folder with a temporary AGENTS.md that carries a test entry, and every file goes to a
// temporary folder. Invented titles only.
// cspell:words aiplatform genai vertexai IHDR Starfall VBOR cands
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const probeDir = "../../scripts/probes/act08";
const ROOT = process.cwd();
const NOW = Date.parse("2026-10-20T12:00:00Z");
const ENTRY = "#990";

let lib: any;
let p11: any;
let GoogleGenAI: any;
let norm: (s: string) => string;
const realFetch = globalThis.fetch;
const dirs: string[] = [];

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("network access in an ACT-08 P-11 test");
  }) as typeof fetch;
  lib = await import(`${probeDir}/lib.mjs`);
  p11 = await import(`${probeDir}/p11-library-screenshot.mjs`);
  ({ GoogleGenAI } = await import("@google/genai"));
  ({ normTitle: norm } = await import("../../scripts/catalogue/lib.mjs"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

function png(width: number, height: number) {
  const b = Buffer.alloc(64);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// The reference list: invented titles, with a comment, a blank line and a title the page
// does not show; "Invented Extra" is not on it.
const REFERENCE = [
  "# reference list (invented)",
  "Starfall Odyssey",
  "",
  "Night Harbor",
  "MARVEL'S COPPER HAWK",
  "Quiet Meadow",
].join("\r\n");

/** One page image, a reference list, and a catalogue. */
function inputs() {
  const pages = tmp("p11-pages-");
  writeFileSync(path.join(pages, "page1.png"), png(1000, 2000));
  const reference = path.join(tmp("p11-ref-"), "titles.txt");
  writeFileSync(reference, REFERENCE);
  const cat = tmp("p11-cat-");
  const PS4 = "Q5014725";
  const PS5 = "Q63184502";
  const rec = (qid: string, label: string, year: number, plats: string[]) => ({
    qid,
    label,
    release_dates: [{ iso: `${year}-01-01`, precision: "day" }],
    platforms: plats.map((id) => ({ id })),
  });
  writeFileSync(
    path.join(cat, "wikidata.jsonl"),
    [
      rec("Q1", "Starfall Odyssey", 2020, [PS4, PS5]),
      rec("Q2", "Night Harbor", 2012, []),
      rec("Q3", "Night Harbor", 2019, []),
      rec("Q4", "Copper Hawk", 2025, [PS5]),
      // Six items share one invented title: more candidates than a choice prompt takes.
      ...[1, 2, 3, 4, 5, 6].map((n) => rec(`Q6${n}`, "Six Way Fork", 2000 + n, [])),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  return { pages, cat, reference };
}

function records() {
  const dir = tmp("p11-gcp-");
  writeFileSync(
    path.join(dir, "credit-position-1.json"),
    JSON.stringify({ read_at: new Date(NOW - 3_600_000).toISOString(), balance_usd: 298 }),
  );
  return dir;
}

/** AGENTS.md with one more ledger row: a test entry naming this script and the output folder. */
function agentsWithEntry(out: string, cap = "40", usd = "$12") {
  const text = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const row = `| #990 (P-11) | \`scripts/probes/act08/p11-library-screenshot.mjs\`: test entry | \`aiplatform.googleapis.com\`, location \`global\`, \`generateContent\` only | Principal Operator | ${cap} | ${usd} | \`${out}\` | 2026-10-12 | 2026-11-06 |`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("| #117 (P-9)"));
  lines.splice(at + 1, 0, row);
  const file = path.join(tmp("p11-agents-"), "AGENTS.md");
  writeFileSync(file, lines.join("\n"));
  return file;
}

const makeClient = (capture: any) =>
  new GoogleGenAI({
    vertexai: true,
    project: "mgpl-508415",
    location: "global",
    googleAuthOptions: {
      authClient: { getRequestHeaders: async () => new Headers({ Authorization: "Bearer test" }) },
    },
    httpOptions: { fetch: capture.fetch },
  });

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const replyText = (text: string, prompt = 1200, out = 300) =>
  json({
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: out },
  });
const reply = (value: unknown, prompt = 1200, out = 300) =>
  replyText(JSON.stringify(value), prompt, out);

/** A stub Vertex: the page request gets the tiles; a choice request gets candidate 2. */
function stubVertex(tiles: unknown[]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const image = body.contents[0].parts.some((p: any) => p.inlineData);
    return image ? reply({ tiles }) : reply({ choice: 2 }, 90, 5);
  });
}

const TILES = [
  { title: "Starfall Odyssey", platforms: ["PS4"], ps_plus: true, position: 1 },
  { title: "Starfall Odyssey", platforms: ["PS5"], ps_plus: true, position: 2 },
  { title: "Night Harbor", platforms: ["PS5"], ps_plus: false, position: 3 },
  { title: "Marvel's Copper Hawk", platforms: ["PS5"], ps_plus: false, position: 4 },
  { title: "Invented Extra", platforms: ["PS5"], ps_plus: false, position: 5 },
];

describe("P-11 building blocks", () => {
  it("fetch throws for this whole file", () => {
    expect(() => globalThis.fetch("https://example.invalid/")).toThrow(/network access/);
  });

  it("reads the reference list: one title per line, normalized, skipping comments and blanks", () => {
    const ref = p11.readReference(REFERENCE);
    expect(ref.size).toBe(4);
    for (const t of ["starfall odyssey", "Night Harbor", "Marvel's Copper Hawk", "QUIET MEADOW"])
      expect(ref.has(norm(t))).toBe(true);
    expect(p11.readReference("# only a comment\n\n").size).toBe(0);
  });

  it("scores the reading against the reference list and the page's tile count", () => {
    const read = TILES.map(({ title, platforms, ps_plus }) => ({ title, platforms, ps_plus }));
    const { score, notInReference } = p11.scoreReading(read, p11.readReference(REFERENCE), 24);
    expect(score).toEqual({
      expected_tiles: 24,
      read_tiles: 5,
      completeness: 0.208333333,
      distinct_titles: 4,
      in_reference: 3,
      not_in_reference: 1,
      precision: 0.75,
      badges_counted_not_scored: { ps4: 1, ps5: 4, ps_plus: 2, no_platform: 0 },
    });
    expect(notInReference).toEqual(["Invented Extra"]);
    const none = p11.scoreReading(read, null, 24);
    expect(none.score).toMatchObject({
      in_reference: null,
      not_in_reference: null,
      precision: null,
    });
    expect(none.notInReference).toEqual([]);
  });

  it("finds at most 5 page images", () => {
    const { pages } = inputs();
    expect(p11.findPages(pages)).toEqual([
      { image: path.join(pages, "page1.png"), mimeType: "image/png", bytes: 64 },
    ]);
    for (let i = 2; i <= 6; i++) writeFileSync(path.join(pages, `page${i}.jpg`), png(1, 1));
    expect(() => p11.findPages(pages)).toThrow(/at most 5/);
    expect(() => p11.findPages(tmp("p11-empty-"))).toThrow(/no .png/);
  });

  it("bounds every choice prompt, so the planned reservation holds for any input", async () => {
    const rates = await lib.loadRates();
    const cand = (n: number) => ({ qid: `Q${n}`, label: "x", first_year: 2000, playstation: [] });
    expect(() =>
      p11.choicePrompt({ title: "x", platforms: [] }, [1, 2, 3, 4, 5, 6].map(cand)),
    ).toThrow(/at most 5/);
    const long = "\u0001".repeat(500) + "Ω".repeat(500);
    const worst = p11.worstChoiceBound(rates);
    for (const label of [long, '"'.repeat(500), "x".repeat(500)]) {
      const params = p11.choiceParams({ title: label, platforms: ["PS4", "PS5", "Xbox"] }, [
        ...[1, 2, 3, 4, 5].map((n) => ({
          qid: `Q${n}`,
          label,
          first_year: null,
          playstation: ["PS4", "PS5", "PS6"],
        })),
      ]);
      const b = lib.maxRequestCostUsd(rates, p11.MODEL, p11.vertexBody(params)).max_cost_usd;
      expect(b).toBeLessThanOrEqual(worst);
    }
    expect(p11.planUsd([0.5, 0.25], 0.1)).toBe(2.75);
    // A malformed date read through the catalogue never prints a long year (Codex re-review r3, finding 2).
    const { buildIndex } = await import("../../scripts/catalogue/match-titles.mjs");
    const idx = buildIndex([
      { qid: "Q1", label: "x", release_dates: [{ iso: "1e20-01-01" }], platforms: [] },
    ]);
    const odd = idx.items.get("Q1");
    expect(Number.isInteger(odd.first_year)).toBe(true);
    const prompt = p11.choicePrompt({ title: "x", platforms: [] }, [
      { ...odd, playstation: [] },
      { qid: "Q2", label: "y", first_year: 2001, playstation: [] },
    ]);
    expect(prompt).toContain("first released unknown;");
    expect(prompt).toContain("first released 2001;");
    expect(prompt).not.toMatch(/\d{5,}/);
  });

  it("uses Gemini 3.8 Flash on the global endpoint, thinking level LOW and no temperature", () => {
    expect(p11.MODEL).toBe("gemini-3.8-flash");
    expect(p11.P11_LOCATION).toBe("global");
    const game = { title: "Night Harbor", platforms: ["PS5"] };
    const cand = { qid: "Q2", label: "Night Harbor", first_year: 2012, playstation: [] };
    for (const params of [
      p11.readParams({ mimeType: "image/png" }, "AAAA"),
      p11.choiceParams(game, [cand, { ...cand, qid: "Q3" }]),
    ]) {
      expect(params.model).toBe("gemini-3.8-flash");
      expect(params.config.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
      expect(params.config).not.toHaveProperty("temperature");
      const gc = JSON.parse(p11.vertexBody(params)).generationConfig;
      expect(gc.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
      expect(gc).not.toHaveProperty("temperature");
    }
  });

  it("refuses an output folder inside the repository", () => {
    expect(() => p11.checkOutDir(path.join(ROOT, "DOCS", "research"))).toThrow(/outside/);
    expect(() => p11.checkOutDir(path.join(ROOT, "..private"))).toThrow(/outside/);
    expect(() => p11.checkOutDir(ROOT)).toThrow(/outside/);
    expect(() => p11.checkOutDir(undefined)).toThrow(/--out/);
    const out = tmp("p11-out-");
    expect(p11.checkOutDir(out)).toBe(path.resolve(out));
  });

  it("builds exactly the body the SDK sends, and the guard admits it", async () => {
    const rates = await lib.loadRates();
    const seen: string[] = [];
    const client = makeClient({
      fetch: async (_url: string, init: RequestInit) => {
        seen.push(String(init.body));
        return reply({ tiles: [] });
      },
    });
    const data = png(1852, 5055).toString("base64");
    const game = { title: "Night Harbor", platforms: ["PS5"] };
    const cands = [
      { qid: "Q2", label: "Night Harbor", first_year: 2012, playstation: [] },
      { qid: "Q3", label: "Night Harbor", first_year: 2019, playstation: [] },
    ];
    for (const params of [
      p11.readParams({ mimeType: "image/png" }, data),
      p11.choiceParams(game, cands),
    ]) {
      await client.models.generateContent(params);
      expect(JSON.parse(seen.at(-1) as string)).toEqual(JSON.parse(p11.vertexBody(params)));
      const bound = lib.maxRequestCostUsd(rates, p11.MODEL, seen.at(-1));
      expect(bound.max_cost_usd).toBeGreaterThan(0);
    }
    const bound = lib.maxRequestCostUsd(rates, p11.MODEL, seen[0]);
    expect(bound.image_tile_tokens).toBe(10 * 258);
    expect(bound.input_ceiling_tokens).toBe(1048576);
  });
});

describe("P-11 dry-run", () => {
  it("prints bounds and counts, sends nothing and writes nothing", async () => {
    const { pages, cat, reference } = inputs();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a.join(" ")));
    await expect(
      p11.main(["--pages", pages, "--catalogue", cat, "--reference", reference]),
    ).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = logs.join("\n");
    expect(text).toMatch(/pages: 1; tiles per page: 24; reference titles: 4/);
    expect(text).toMatch(/plan: \$[0-9.]+ reserved at most \(every page bound and 20 choices\)/);
    expect(text).toMatch(/page 1: guard bound \$/);
    expect(text).toContain(
      "endpoint (expected): https://aiplatform.googleapis.com/v1beta1/projects/mgpl-508415/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
    );
    expect(text).toContain("thinking level LOW");
    expect(text).not.toMatch(/Starfall|Night Harbor|page1/);
  });
});

describe("P-11 --run through the real guard (stubbed Vertex)", () => {
  async function run(
    extra: string[] = [],
    stub = stubVertex(TILES),
    entryOut?: string,
    caps: [string, string] = ["40", "$12"],
  ) {
    const { pages, cat, reference } = inputs();
    const out = tmp("p11-out-");
    const dir = records();
    const logs: string[] = [];
    const code = await p11.main(
      [
        "--run",
        "--entry",
        ENTRY,
        "--pages",
        pages,
        "--catalogue",
        cat,
        "--out",
        out,
        "--reference",
        reference,
        ...extra,
      ],
      {
        dir,
        agentsPath: agentsWithEntry(entryOut ?? out, ...caps),
        now: () => NOW,
        baseFetch: stub,
        makeClient,
        log: (s: string) => logs.push(s),
        interrupts: new EventEmitter(),
      },
    );
    return { code, out, dir, logs, stub };
  }

  it("reads the page, matches it, asks one choice, and writes only to --out", async () => {
    const { code, out, dir, logs, stub } = await run();
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(2);
    const files = readdirSync(out).sort();
    expect(files).toHaveLength(2);
    const agg = JSON.parse(
      readFileSync(
        path.join(
          out,
          files.find((f) => f.endsWith("aggregate.json"))!,
        ),
        "utf8",
      ),
    );
    expect(agg).toMatchObject({
      probe: "p11-library-screenshot",
      ledger_entry: ENTRY,
      pages: 1,
      tiles_per_page: 24,
      reference_titles: 4,
      requests_sent: 2,
      stop_reason: null,
      choices: { asked: 1, picked: 1 },
      access: { "Subscription Access": 2, "Owned License": 3 },
    });
    expect(agg.reading[0]).toMatchObject({ read_tiles: 5, in_reference: 3, not_in_reference: 1 });
    expect(agg.matching.by_status).toEqual({ confirmed: 1, suggested: 2, not_found: 1 });
    // No title, file name or local path in the aggregate or on the console.
    const aggText = JSON.stringify(agg) + logs.join("\n");
    expect(aggText).not.toMatch(
      /Starfall|Night Harbor|Copper Hawk|Quiet Meadow|Invented|page1|titles\.txt|p11-pages-|p11-ref-/i,
    );
    const results = JSON.parse(
      readFileSync(
        path.join(
          out,
          files.find((f) => f.endsWith("results.json"))!,
        ),
        "utf8",
      ),
    );
    expect(results.choices).toEqual([{ title: "Night Harbor", choice: 2, picked: "Q3" }]);
    // The titles not on the reference list are kept locally, per page, for the operator.
    expect(results.pages[0].not_in_reference).toEqual(["Invented Extra"]);
    // Request bodies (the image) are never written.
    expect(JSON.stringify(results)).not.toMatch(/inlineData|iVBOR/);
    const ledger = readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(ledger.filter((l) => l.type === "attempt")).toHaveLength(2);
    expect(ledger.at(-1)).toMatchObject({ type: "end", status: "completed" });
  });

  it("stops at a failed page request and still ends the run", async () => {
    const failing = vi.fn(async () =>
      json({ error: { code: 500, message: "backend error", status: "INTERNAL" } }, 500),
    );
    const { code, dir, logs } = await run([], failing);
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/STOPPED \(page 1 failed/);
    const end = readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .at(-1);
    expect(end).toMatchObject({ type: "end", status: "failed" });
  });

  it("refuses an --out that is not the output location its entry names, before any request", async () => {
    const stub = stubVertex(TILES);
    await expect(run([], stub, tmp("p11-elsewhere-"))).rejects.toThrow(
      /output location entry #990 names/,
    );
    expect(stub).not.toHaveBeenCalled();
    expect(p11.samePath("C:\\Dev\\Out", "c:\\dev\\out", "win32")).toBe(true);
    expect(p11.samePath("/a/Out", "/a/out", "linux")).toBe(false);
  });

  it("stops at an unusable response, sends nothing more, and ends the run as failed", async () => {
    const goodTile = { title: "Night Harbor", platforms: ["PS5"], ps_plus: false, position: 1 };
    for (const [label, page, choice, sent] of [
      ["not JSON", () => replyText("tiles: Night Harbor"), null, 1],
      ["no tiles list", () => reply({ rows: [] }), null, 1],
      [
        "a tile's ps_plus is not true or false",
        () => reply({ tiles: [{ ...goodTile, ps_plus: "no" }] }),
        null,
        1,
      ],
      [
        "a tile's platforms are not PS4 or PS5",
        () => reply({ tiles: [{ ...goodTile, platforms: ["Xbox"] }] }),
        null,
        1,
      ],
      [
        "the choice is not one of the candidates",
        () => reply({ tiles: [goodTile] }),
        () => reply({ choice: 7 }, 90, 5),
        2,
      ],
      ["not JSON", () => reply({ tiles: [goodTile] }), () => replyText("two", 90, 5), 2],
    ] as const) {
      const stub = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const image = body.contents[0].parts.some((p: any) => p.inlineData);
        return image ? page() : (choice as any)();
      });
      const { code, dir, logs, out } = await run([], stub);
      expect(code).toBe(1);
      expect(stub).toHaveBeenCalledTimes(sent);
      expect(logs.join("\n")).toContain(`unusable response (${label})`);
      expect(logs.join("\n")).not.toMatch(/Night Harbor/);
      const ledger = readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(ledger.at(-1)).toMatchObject({ type: "end", status: "failed" });
      const agg = readdirSync(out).find((f) => f.endsWith("aggregate.json"))!;
      expect(readFileSync(path.join(out, agg), "utf8")).not.toMatch(/Night Harbor/);
    }
  });

  it("shows an error it did not write by its type only, never by its text", async () => {
    const { pages, cat } = inputs();
    writeFileSync(path.join(pages, "page2.png"), png(10, 10));
    mkdirSync(path.join(pages, "Sky Harbor.png"));
    const logs: string[] = [];
    const code = await p11.cli(["--pages", pages, "--catalogue", cat], (s: string) => logs.push(s));
    expect(code).toBe(1);
    expect(logs).toEqual([
      "p11-library-screenshot: stopped (Error EISDIR); the details are not shown, because they may name a personal file",
    ]);
    // Usage errors never carry an argument's value (Codex re-review r2, finding 1).
    const usage: string[] = [];
    const say = (s: string) => usage.push(s);
    expect(await p11.cli([path.join(pages, "My Hidden Library Sky.png")], say)).toBe(2);
    expect(await p11.cli(["--tiles-per-page", "Synthetic Private Title"], say)).toBe(2);
    expect(await p11.cli(["--Synthetic-Private-Title"], say)).toBe(2);
    expect(
      await p11.cli(
        [
          "--pages",
          pages,
          "--catalogue",
          cat,
          "--reference",
          path.join(pages, "Synthetic Title.txt"),
        ],
        say,
      ),
    ).toBe(2);
    expect(usage).toEqual([
      "p11-library-screenshot: unexpected argument (not shown)",
      "p11-library-screenshot: --tiles-per-page must be a positive integer (the value is not shown)",
      "p11-library-screenshot: unknown flag (not shown)",
      "p11-library-screenshot: --reference must be a text file of titles, one per line",
    ]);
    expect(p11.usageMessage("--pages holds 2 images; at most 5 are read")).toBe(
      "--pages holds 2 images; at most 5 are read",
    );
    expect(p11.usageMessage("anything else with Synthetic Title")).toBe(
      "usage error (details not shown)",
    );
    // A guard refusal shows only its check, unless the operator asks (Codex re-review r3, finding 1).
    const refusal = new lib.GuardRefusal(
      "credit",
      "credit-position-Synthetic Private.json is not valid JSON",
    );
    expect(p11.cliMessage(refusal)).toBe(
      "RUN GUARD REFUSED (credit); the reason is not shown (add --show-refusal to see it)",
    );
    expect(p11.cliMessage(refusal, true)).toBe(refusal.message);
  });

  it("refuses to start when the whole plan does not fit what the entry has left", async () => {
    for (const [caps, re] of [
      [["40", "$1"], /the plan needs up to \$[0-9.]+; entry #990 has \$1 left/],
      [["10", "$12"], /the plan needs up to 21 requests; entry #990 has 10 left/],
    ] as const) {
      const stub = stubVertex(TILES);
      await expect(run([], stub, undefined, caps as unknown as [string, string])).rejects.toThrow(
        re,
      );
      expect(stub).not.toHaveBeenCalled();
    }
  });

  it("leaves a title with more than 5 candidates ambiguous, with no choice request", async () => {
    const stub = stubVertex([
      { title: "Six Way Fork", platforms: ["PS5"], ps_plus: false, position: 1 },
    ]);
    const { code, out } = await run([], stub);
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);
    const agg = JSON.parse(
      readFileSync(
        path.join(
          out,
          readdirSync(out).find((f) => f.endsWith("aggregate.json"))!,
        ),
        "utf8",
      ),
    );
    expect(agg.choices).toEqual({ asked: 0, picked: 0, skipped_too_many_candidates: 1 });
    expect(agg.matching.by_status).toEqual({ ambiguous: 1 });
  });

  it("refuses --run without --entry, or with --out inside the repository", async () => {
    const { pages, cat } = inputs();
    await expect(
      p11.main(["--run", "--pages", pages, "--catalogue", cat, "--out", tmp("p11-out-")]),
    ).rejects.toThrow(/--entry/);
    await expect(
      p11.main([
        "--run",
        "--entry",
        ENTRY,
        "--pages",
        pages,
        "--catalogue",
        cat,
        "--out",
        path.join(ROOT, "DOCS"),
      ]),
    ).rejects.toThrow(/outside the repository/);
    expect(existsSync(path.join(ROOT, "DOCS", "p11-library-screenshot"))).toBe(false);
  });
});
