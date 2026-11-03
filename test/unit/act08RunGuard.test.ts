// WU-006 (#125, #114, #157): the ACT-08 cost corrections and the AGENTS.md §3.1 run guard.
// Offline only: every test works in a temporary records folder, and fetch is replaced for the
// whole file by one that throws, so no test can reach the network.
// cspell:words aiplatform unpriceable IHDR pbody
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const probeDir = "../../scripts/probes/act08";
const ROOT = process.cwd();
const AGENTS = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
const P9_URL = pathToFileURL(
  path.join(ROOT, "scripts", "probes", "act08", "p9-grounded-retrieval.mjs"),
).href;
const HOST = "us-central1-aiplatform.googleapis.com";
const MODEL_PATH =
  "/v1beta1/projects/mgpl-508415/locations/us-central1/publishers/google/models/gemini-2.5-flash";
const GOOD_URL = `https://${HOST}${MODEL_PATH}:generateContent`;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const HOUR = 3_600_000;

let lib: any;
let ledgerCli: any;
let rates: any;
const realFetch = globalThis.fetch;
const dirs: string[] = [];

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("network access in an ACT-08 guard test");
  }) as typeof fetch;
  lib = await import(`${probeDir}/lib.mjs`);
  ledgerCli = await import(`${probeDir}/ledger.mjs`);
  rates = await lib.loadRates();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function records(opts: { balance?: number; readAt?: number; credit?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "act08-guard-"));
  dirs.push(dir);
  if (opts.credit !== false) {
    writeFileSync(
      path.join(dir, "credit-position-1.json"),
      JSON.stringify({
        read_at: new Date(opts.readAt ?? NOW - HOUR).toISOString(),
        balance_usd: opts.balance ?? 298.87,
        source: "test",
      }),
    );
  }
  return dir;
}

function agents(dir: string, edit: (text: string) => string) {
  const file = path.join(dir, "AGENTS.test.md");
  writeFileSync(file, edit(AGENTS));
  return file;
}

function lines(dir: string) {
  const file = path.join(dir, "spend-ledger.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function seed(dir: string, objs: object[]) {
  writeFileSync(
    path.join(dir, "spend-ledger.jsonl"),
    objs.map((o) => JSON.stringify(o)).join("\n") + "\n",
    { flag: "a" },
  );
}

function open(dir: string, over: Record<string, unknown> = {}) {
  return lib.openRun({
    entry: "#117",
    scriptUrl: P9_URL,
    maxRequests: 10,
    maxUsd: 2,
    rates,
    dir,
    now: () => NOW,
    ...over,
  });
}

function body(over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "Which studio made the game?" }] }],
    generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 }, ...config },
    ...over,
  });
}

const init = (b = body(), headers: Record<string, string> = {}) => ({
  method: "POST",
  body: b,
  headers: { "Content-Type": "application/json", ...headers },
});

const usageResponse = (usage: object) =>
  new Response(JSON.stringify({ usageMetadata: usage }), { status: 200 });

function refusal(fn: () => unknown, check: string) {
  try {
    fn();
  } catch (e: any) {
    expect(e).toBeInstanceOf(lib.GuardRefusal);
    expect(e.check).toBe(check);
    return e.message as string;
  }
  throw new Error(`expected a ${check} refusal`);
}

async function refusalAt(run: unknown, initObj: unknown, check: string) {
  const capture = lib.createCapture({
    guard: run,
    baseFetch: vi.fn(async () => usageResponse({ promptTokenCount: 1, candidatesTokenCount: 1 })),
  });
  try {
    await capture.fetch(GOOD_URL, initObj);
  } catch (e: any) {
    expect(e).toBeInstanceOf(lib.GuardRefusal);
    expect(e.check).toBe(check);
    return e.message as string;
  }
  throw new Error(`expected a ${check} refusal`);
}

describe("no network", () => {
  it("fetch throws for this whole file", () => {
    expect(() => globalThis.fetch("https://example.invalid/")).toThrow(/network access/);
  });
});

describe("Part A: inconsistent usage is unpriceable, never a number (#125)", () => {
  it("the 09-22 P-2 usage (9 prompt, 46,562 cached, 75 output) is unpriceable", () => {
    const c = lib.computeGenerateCost(rates, "gemini-2.5-flash", {
      promptTokenCount: 9,
      cachedContentTokenCount: 46562,
      candidatesTokenCount: 75,
    });
    expect(c.unpriceable).toBe(true);
    expect(c.computed_cost_usd).toBeNull();
    expect(c.reason).toMatch(/exceeds promptTokenCount/);
  });

  it.each([
    [{ promptTokenCount: -1 }],
    [{ promptTokenCount: 10, candidatesTokenCount: 1.5 }],
    [{ promptTokenCount: 10, thoughtsTokenCount: Number.NaN }],
    [{ candidatesTokenCount: 3 }],
    [undefined],
  ])("refuses to price %j", (usage) => {
    expect(lib.computeGenerateCost(rates, "gemini-2.5-flash", usage).unpriceable).toBe(true);
  });

  it("prices a valid case with cache, tool use and thinking", () => {
    const c = lib.computeGenerateCost(rates, "gemini-2.5-flash", {
      promptTokenCount: 1000,
      cachedContentTokenCount: 400,
      toolUsePromptTokenCount: 100,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 50,
    });
    // (700 * 0.30 + 400 * 0.03 + 150 * 2.50) / 1e6
    expect(c.computed_cost_usd).toBeCloseTo(0.000597, 9);
  });

  it("uses the long-context rates above 200K prompt tokens (Gemini 2.5 Pro)", () => {
    const c = lib.computeGenerateCost(rates, "gemini-2.5-pro", {
      promptTokenCount: 300000,
      candidatesTokenCount: 1000,
    });
    expect(c.context_tier).toBe(">200K");
    // (300000 * 2.50 + 1000 * 15.00) / 1e6
    expect(c.computed_cost_usd).toBeCloseTo(0.765, 9);
  });

  it("throws for a model with no rate", () => {
    expect(() => lib.computeGenerateCost(rates, "gemini-9-ultra", { promptTokenCount: 1 })).toThrow(
      /No published rate/,
    );
  });

  it("a total that includes an unpriceable item is unpriceable, not smaller", () => {
    const t = lib.sumComputedCosts([
      { computed_cost_usd: 0.25 },
      { unpriceable: true, computed_cost_usd: null },
      null,
    ]);
    expect(t.computed_cost_usd).toBeNull();
    expect(t.computed_cost_usd_priced_items_only).toBe(0.25);
    expect(t.unpriceable_items).toBe(1);
    expect(lib.sumComputedCosts([{ computed_cost_usd: 0.25 }, null]).computed_cost_usd).toBe(0.25);
  });
});

describe("Part B: embeddings are priced on billableCharacterCount (#114)", () => {
  it("the 09-24 P-4 responses sum to 1,664 billable characters and $0.0000416", () => {
    const rec = JSON.parse(
      readFileSync(
        path.join(ROOT, "DOCS/research/act08-runs/p4-embeddings-20260924T235551Z.json"),
        "utf8",
      ),
    );
    const billable = lib.billableCharactersFrom(
      rec.exchanges.map((x: { response_body: string }) => x.response_body),
    );
    expect(billable).toBe(1664);
    const c = lib.computeEmbeddingCost(rates, "text-embedding-005", {
      billableCharacters: billable,
      characters: 1896,
      tokens: 474,
    });
    expect(c.computed_cost_usd).toBeCloseTo(0.0000416, 12);
    expect(c.computed_cost_usd_on_string_length).toBeCloseTo(0.0000474, 12);
  });

  it("is unpriceable, not string length, when the field is absent", () => {
    expect(lib.billableCharactersFrom([JSON.stringify({ predictions: [] })])).toBeNull();
    const c = lib.computeEmbeddingCost(rates, "text-embedding-005", {
      billableCharacters: null,
      characters: 1896,
    });
    expect(c.unpriceable).toBe(true);
    expect(c.computed_cost_usd).toBeNull();
  });
});

describe("the §3.1 ledger parser", () => {
  it("reads entries #117, #185, #192, #158 and #199 and the totals from the real AGENTS.md", () => {
    const auth = lib.parseAuthorizations(AGENTS);
    expect(auth.window).toEqual({
      end_ms: Date.parse("2026-11-06T00:00:00Z"),
      total_usd: 275,
      stop_line_usd: 20,
    });
    expect(auth.entries.length).toBeGreaterThanOrEqual(5);
    expect(auth.entries.slice(0, 5).map((entry: any) => entry.id)).toEqual([
      "#117",
      "#185",
      "#192",
      "#158",
      "#199",
    ]);
    expect(auth.entries[0]).toMatchObject({
      id: "#117",
      script: "scripts/probes/act08/p9-grounded-retrieval.mjs",
      host: HOST,
      location: "us-central1",
      methods: ["generateContent"],
      lane: "Implementer: Cline × ChatGPT Subscription",
      request_cap: 50,
      dollar_cap_usd: 5,
      writes_to: "DOCS/research/act08-runs/",
      added_ms: Date.parse("2026-10-06T00:00:00Z"),
      expires_ms: Date.parse("2026-11-06T00:00:00Z"),
    });
    expect(auth.entries[1]).toMatchObject({
      id: "#185",
      script: "scripts/probes/act08/p11-library-screenshot.mjs",
      host: HOST,
      location: "us-central1",
      methods: ["generateContent"],
      lane: "Principal Operator",
      request_cap: 40,
      dollar_cap_usd: 6,
      writes_to: "../_staging/prompt-author/prototype-output/",
      added_ms: Date.parse("2026-10-13T00:00:00Z"),
      expires_ms: Date.parse("2026-11-06T00:00:00Z"),
    });
    expect(auth.entries[2]).toMatchObject({
      id: "#192",
      script: "scripts/probes/act08/p11-library-screenshot.mjs",
      host: "aiplatform.googleapis.com",
      location: "global",
      methods: ["generateContent"],
      lane: "Principal Operator",
      request_cap: 40,
      dollar_cap_usd: 12,
      writes_to: "../_staging/prompt-author/prototype-output/",
      added_ms: Date.parse("2026-10-13T00:00:00Z"),
      expires_ms: Date.parse("2026-11-06T00:00:00Z"),
    });
    expect(auth.entries[3]).toMatchObject({
      id: "#158",
      script: "scripts/catalogue/enrich-gemini.mjs",
      host: "aiplatform.googleapis.com",
      location: "global",
      methods: ["generateContent"],
      lane: "Principal Operator",
      request_cap: 200000,
      dollar_cap_usd: 160,
      writes_to: "../_staging/enrichment-output/",
      added_ms: Date.parse("2026-10-13T00:00:00Z"),
      expires_ms: Date.parse("2026-11-06T00:00:00Z"),
    });
    expect(auth.entries[4]).toMatchObject({
      id: "#199",
      script: "scripts/catalogue/embed-descriptions.mjs",
      host: HOST,
      location: "us-central1",
      methods: ["predict"],
      lane: "Principal Operator",
      request_cap: 3000,
      dollar_cap_usd: 5,
      writes_to: "../_staging/enrichment-output/",
      added_ms: Date.parse("2026-10-14T00:00:00Z"),
      expires_ms: Date.parse("2026-11-06T00:00:00Z"),
    });
  });

  it.each([
    [
      "an extra Totals cell",
      (t: string) =>
        t.replace("| $20                        |", "| $20                        | x |"),
    ],
    [
      "a qualifier in the endpoint cell",
      (t: string) =>
        t.replace("`generateContent` only |", "`generateContent` only for gemini-2.5-flash |"),
    ],
    [
      "a second method",
      (t: string) =>
        t.replace("`generateContent` only |", "`generateContent`, `countTokens` only |"),
    ],
    [
      "a duplicate entry",
      (t: string) => {
        const row = t.split("\n").find((l) => l.startsWith("| #117 (P-9)")) as string;
        return t.replace(row, `${row}\n${row}`);
      },
    ],
  ])("refuses %s", (_label, edit) => {
    refusal(() => lib.parseAuthorizations(edit(AGENTS)), "ledger");
  });

  it("refuses a table whose header changed", () => {
    refusal(
      () => lib.parseAuthorizations(AGENTS.replace("| Request cap |", "| Requests    |")),
      "ledger",
    );
  });
});

describe("openRun refusals (§3.1 conditions 4, 6, 7)", () => {
  it("opens a run: reservation on disk, lock held, end line and lock removal on end", () => {
    const dir = records();
    const run = open(dir);
    expect(lines(dir)).toEqual([
      expect.objectContaining({ type: "reservation", entry: "#117", max_usd: 2, max_requests: 10 }),
    ]);
    expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(true);
    run.end("completed");
    run.end("completed");
    expect(lines(dir).map((l) => l.type)).toEqual(["reservation", "end"]);
    expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(false);
  });

  it("refuses an entry that is not in the ledger, or a different script", () => {
    const dir = records();
    refusal(() => open(dir, { entry: "#999" }), "entry");
    refusal(
      () => open(dir, { scriptUrl: pathToFileURL(path.join(ROOT, "scripts/x.mjs")).href }),
      "entry",
    );
  });

  it("refuses an expired entry", () => {
    const dir = records({ readAt: Date.parse("2026-10-20T11:00:00Z") });
    const a = agents(dir, (t) =>
      t.replace("| 2026-10-06 | 2026-11-06 |", "| 2026-10-06 | 2026-10-20 |"),
    );
    const msg = refusal(
      () => open(dir, { agentsPath: a, now: () => Date.parse("2026-10-20T12:00:00Z") }),
      "expiry",
    );
    expect(msg).toMatch(/#117 expired/);
  });

  it("refuses at the window end even when the entry has not expired", () => {
    const dir = records({ readAt: Date.parse("2026-11-06T00:30:00Z") });
    const a = agents(dir, (t) =>
      t.replace("| 2026-10-06 | 2026-11-06 |", "| 2026-10-06 | 2026-11-30 |"),
    );
    const msg = refusal(
      () => open(dir, { agentsPath: a, now: () => Date.parse("2026-11-06T01:00:00Z") }),
      "expiry",
    );
    expect(msg).toMatch(/window ended/);
  });

  it("refuses while another run holds the lock", () => {
    const dir = records();
    open(dir);
    refusal(() => open(dir), "one-run");
  });

  it("refuses while a lock file exists with no reservation (a run killed while opening)", () => {
    const dir = records();
    writeFileSync(path.join(dir, "spend-ledger.lock"), JSON.stringify({ run_id: "r9" }));
    const msg = refusal(() => open(dir), "one-run");
    expect(msg).toMatch(/run r9/);
    expect(lines(dir)).toEqual([]);
  });

  it("refuses while a reservation has no end line, even without a lock", () => {
    const dir = records();
    seed(dir, [{ type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 }]);
    refusal(() => open(dir), "one-run");
    expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(false);
  });

  it("refuses when attempts across runs plus maxRequests exceed the entry's cap", () => {
    const dir = records();
    const attempts = Array.from({ length: 45 }, (_, i) => ({
      type: "attempt",
      run_id: "r0",
      entry: "#117",
      attempt_id: `r0:${i + 1}`,
      max_cost_usd: 0,
    }));
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 0.01, max_requests: 45 },
      ...attempts,
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
    ]);
    refusal(() => open(dir, { maxRequests: 6 }), "count");
    open(dir, { maxRequests: 5 }).end("completed");
  });

  it("refuses when the ledger cannot be parsed in full", () => {
    const dir = records();
    writeFileSync(path.join(dir, "spend-ledger.jsonl"), '{"type":"reservation"\n');
    refusal(() => open(dir), "count");
  });

  it("refuses a ledger line it cannot use, rather than skipping it", () => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: "3",
        flagged: false,
        credit_record: "c",
      },
    ]);
    const msg = refusal(() => open(dir), "count");
    expect(msg).toMatch(/billed_usd must be a non-negative number/);
  });

  it.each([
    [
      "a run reserved twice",
      [
        { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
        { type: "end", run_id: "r0", entry: "#117", status: "completed" },
        { type: "reservation", run_id: "r0", entry: "#117", max_usd: 0.1, max_requests: 1 },
        { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      ],
      /reserved twice/,
    ],
    [
      "an attempt with no reservation",
      [{ type: "attempt", run_id: "x", entry: "#117", attempt_id: "x:1", max_cost_usd: 300 }],
      /has no reservation/,
    ],
    [
      "two results for one attempt",
      [
        { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
        { type: "attempt", run_id: "r0", entry: "#117", attempt_id: "r0:1", max_cost_usd: 4 },
        {
          type: "result",
          run_id: "r0",
          entry: "#117",
          attempt_id: "r0:1",
          outcome: "no_response",
          computed_cost_usd: null,
        },
        {
          type: "result",
          run_id: "r0",
          entry: "#117",
          attempt_id: "r0:1",
          outcome: "priced",
          computed_cost_usd: 0,
        },
        { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      ],
      /two results/,
    ],
    [
      "a reconciliation of a run that has not ended",
      [
        { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
        {
          type: "reconciliation",
          by: "prompt-author",
          run_id: "r0",
          billed_usd: 0,
          credit_record: "credit-position-1.json",
        },
      ],
      /has not ended/,
    ],
    [
      "an attempt after its run ended",
      [
        { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
        { type: "end", run_id: "r0", entry: "#117", status: "completed" },
        { type: "attempt", run_id: "r0", entry: "#117", attempt_id: "r0:1", max_cost_usd: 1 },
      ],
      /after its end line/,
    ],
  ])("refuses a ledger with %s", (_label, seedLines, pattern) => {
    const dir = records();
    seed(dir, seedLines as object[]);
    const msg = refusal(() => open(dir, { maxUsd: 0.5 }), "count");
    expect(msg).toMatch(pattern as RegExp);
  });

  it.each([
    [
      "an explanation with no note",
      [{ type: "explained", run_id: "r0", by: "operator" }],
      /written note/,
    ],
    [
      "an explanation with a blank note",
      [{ type: "explained", run_id: "r0", note: "   ", by: "operator" }],
      /written note/,
    ],
  ])("refuses %s, so the stop stays", (_label, extra, pattern) => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: 2,
        credit_record: "credit-position-1.json",
      },
      ...(extra as object[]),
    ]);
    const msg = refusal(() => open(dir, { maxUsd: 0.5 }), "count");
    expect(msg).toMatch(pattern as RegExp);
  });

  it.each([
    [
      "a result naming another run or entry",
      {
        type: "result",
        run_id: "other",
        entry: "#999",
        attempt_id: "r0:1",
        outcome: "priced",
        computed_cost_usd: 0,
      },
      /attempt r0:1 is run r0/,
    ],
    ["a result after its run ended", "late", /after its run ended/],
    [
      "a result with an unknown outcome",
      {
        type: "result",
        run_id: "r0",
        entry: "#117",
        attempt_id: "r0:1",
        outcome: "free",
        computed_cost_usd: null,
      },
      /outcome must be one of/,
    ],
    [
      "a priced result with no cost",
      {
        type: "result",
        run_id: "r0",
        entry: "#117",
        attempt_id: "r0:1",
        outcome: "priced",
        computed_cost_usd: null,
      },
      /a priced result needs/,
    ],
  ])("refuses %s, which could lower a liability", (_label, result, pattern) => {
    const dir = records();
    const res =
      result === "late"
        ? {
            type: "result",
            run_id: "r0",
            entry: "#117",
            attempt_id: "r0:1",
            outcome: "priced",
            computed_cost_usd: 0,
          }
        : result;
    const lines0: object[] = [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
      { type: "attempt", run_id: "r0", entry: "#117", attempt_id: "r0:1", max_cost_usd: 4 },
    ];
    const endLine = { type: "end", run_id: "r0", entry: "#117", status: "completed" };
    seed(
      dir,
      result === "late" ? [...lines0, endLine, res as object] : [...lines0, res as object, endLine],
    );
    const msg = refusal(() => open(dir, { maxUsd: 0.5 }), "count");
    expect(msg).toMatch(pattern as RegExp);
  });

  it("refuses a reconciliation that names an unknown credit record", () => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: 0.1,
        credit_record: "missing.json",
      },
    ]);
    refusal(() => open(dir, { maxUsd: 0.5 }), "reconciliation");
  });

  it("refuses a reservation over the entry's dollar cap", () => {
    const dir = records();
    refusal(() => open(dir, { maxUsd: 5.01 }), "dollars");
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
    ]);
    refusal(() => open(dir, { maxUsd: 1.5 }), "dollars");
    open(dir, { maxUsd: 1 }).end("completed");
  });

  it("refuses a reservation over the window total", () => {
    const dir = records();
    const a = agents(dir, (t) =>
      t.replace("| $275                  |", "| $3                    |"),
    );
    const msg = refusal(() => open(dir, { agentsPath: a, maxUsd: 4 }), "dollars");
    expect(msg).toMatch(/window total/);
  });

  it("refuses a missing, stale, future-dated or malformed credit record", () => {
    refusal(() => open(records({ credit: false })), "credit");
    refusal(() => open(records({ readAt: NOW - 49 * HOUR })), "credit");
    refusal(() => open(records({ readAt: NOW + 2 * HOUR })), "credit");
    const dir = records();
    writeFileSync(path.join(dir, "credit-position-2.json"), "{ not json");
    refusal(() => open(dir), "credit");
  });

  it("refuses when balance minus unreconciled liabilities minus the reservation is under the stop line", () => {
    refusal(() => open(records({ balance: 21.99 })), "credit");
    open(records({ balance: 22 })).end("completed");
  });

  it("refuses while a reconciliation difference over max(10%, $1) is unexplained, whatever the line says", () => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: 1.5,
        flagged: false,
        credit_record: "credit-position-1.json",
      },
    ]);
    refusal(() => open(dir), "reconciliation");
    seed(dir, [{ type: "explained", run_id: "r0", note: "late export rows", by: "operator" }]);
    open(dir).end("completed");
  });

  it("refuses after any card charge", () => {
    const dir = records();
    seed(dir, [{ type: "card_charge", note: "statement line" }]);
    refusal(() => open(dir), "card-charge");
  });
});

describe("liability (§3.1 conditions 6 and 7)", () => {
  it("a refreshed credit record does not lower liability; only reconciliation does", () => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 4, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
    ]);
    writeFileSync(
      path.join(dir, "credit-position-2.json"),
      JSON.stringify({ read_at: new Date(NOW - 60_000).toISOString(), balance_usd: 298 }),
    );
    refusal(() => open(dir, { maxUsd: 2 }), "dollars");
    seed(dir, [
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: 0.5,
        flagged: false,
        credit_record: "credit-position-2.json",
      },
    ]);
    open(dir, { maxUsd: 2 }).end("completed");
  });

  it("counts the billed figure when it is above the computed one", () => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: 3,
        credit_record: "credit-position-1.json",
      },
      { type: "explained", run_id: "r0", note: "billed above computed: late rows", by: "operator" },
    ]);
    refusal(() => open(dir, { maxUsd: 2.5 }), "dollars");
    open(dir, { maxUsd: 1.5 }).end("completed");
  });

  it("an unreconciled run counts against the stop line even with a fresh balance", () => {
    const dir = records({ balance: 25 });
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 2, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
    ]);
    // With the entry cap raised out of the way: 25 - 2 (unreconciled) - 3.5 = 19.5, under $20.
    const a = agents(dir, (t) => t.replace("| $5         |", "| $50        |"));
    refusal(() => open(dir, { maxUsd: 3.5, agentsPath: a }), "credit");
    // 25 - 2 - 2 = 21: allowed.
    open(dir, { maxUsd: 2 }).end("completed");
  });
});

describe("admit, inside the capture fetch (§3.1 conditions 3, 4, 5)", () => {
  it.each([
    ["host", `https://us-east1-aiplatform.googleapis.com${MODEL_PATH}:generateContent`],
    ["HTTPS", `http://${HOST}${MODEL_PATH}:generateContent`],
    ["project", GOOD_URL.replace("mgpl-508415", "other-project")],
    ["location", GOOD_URL.replace("locations/us-central1", "locations/europe-west4")],
    ["method", GOOD_URL.replace(":generateContent", ":streamGenerateContent")],
    ["query string", `${GOOD_URL}?alt=sse`],
  ])("refuses a wrong %s without sending or recording an attempt", async (_label, url) => {
    const dir = records();
    const run = open(dir);
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ maxRequests: 10, baseFetch, guard: run });
    await expect(capture.fetch(url, init())).rejects.toMatchObject({ check: "endpoint" });
    expect(baseFetch).not.toHaveBeenCalled();
    expect(lines(dir).filter((l) => l.type === "attempt")).toHaveLength(0);
    run.end("stopped");
  });

  it("refuses a request that carries an API key", async () => {
    const run = open(records());
    const capture = lib.createCapture({ baseFetch: vi.fn(), guard: run });
    await expect(
      capture.fetch(GOOD_URL, init(body(), { "x-goog-api-key": "k" })),
    ).rejects.toMatchObject({ check: "endpoint" });
  });

  it.each([
    ["a model with no rate", GOOD_URL.replace("gemini-2.5-flash", "gemini-9-ultra"), body()],
    ["no maxOutputTokens", GOOD_URL, body({}, { maxOutputTokens: undefined })],
    ["no thinking budget", GOOD_URL, body({}, { thinkingConfig: undefined })],
    ["a dynamic thinking budget", GOOD_URL, body({}, { thinkingConfig: { thinkingBudget: -1 } })],
    ["an unknown tool", GOOD_URL, body({ tools: [{ urlContext: {} }] })],
    ["an explicit cache", GOOD_URL, body({ cachedContent: "projects/x/cachedContents/1" })],
    ["more than one candidate", GOOD_URL, body({}, { candidateCount: 2 })],
    ["image output", GOOD_URL, body({}, { responseModalities: ["TEXT", "IMAGE"] })],
    ["an unknown request field", GOOD_URL, body({ extraOutputs: true })],
    ["a service tier (Priority is priced higher)", GOOD_URL, body({ serviceTier: "PRIORITY" })],
  ])("refuses %s (condition 5)", async (_label, url, b) => {
    const run = open(records());
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ baseFetch, guard: run });
    await expect(capture.fetch(url, init(b))).rejects.toMatchObject({ check: "dollars" });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("bounds a request by body bytes, the larger output ceiling and the grounding fee", () => {
    const b = body({ tools: [{ googleSearch: {} }] });
    const m = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", b);
    const bytes = Buffer.byteLength(b, "utf8");
    expect(m.output_ceiling_tokens).toBe(65536);
    expect(m.grounding).toBe(true);
    // Grounded: the whole input context (1,048,576 tokens) at the highest text input rate.
    expect(m.input_ceiling_tokens).toBe(1048576);
    expect(m.max_cost_usd).toBeCloseTo((1048576 * 0.3 + 65536 * 2.5) / 1e6 + 0.035, 8);
    const plain = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", body());
    expect(plain.input_ceiling_tokens).toBe(Buffer.byteLength(body(), "utf8"));
    expect(bytes).toBeLessThan(1048576);
    const big = lib.maxRequestCostUsd(
      rates,
      "gemini-2.5-flash",
      body({}, { maxOutputTokens: 70000, thinkingConfig: { thinkingBudget: 8000 } }),
    );
    expect(big.output_ceiling_tokens).toBe(78000);
  });

  it("writes and flushes the attempt line before the request is sent, and the result after", async () => {
    const dir = records();
    const run = open(dir);
    const seen: string[] = [];
    const baseFetch = vi.fn(async () => {
      const last = lines(dir).at(-1);
      seen.push(`${last.type}:${last.attempt_id}`);
      return usageResponse({ promptTokenCount: 20, candidatesTokenCount: 10 });
    });
    const capture = lib.createCapture({ maxRequests: 10, baseFetch, guard: run });
    await capture.fetch(GOOD_URL, init());
    expect(seen).toEqual([`attempt:${run.run_id}:1`]);
    const last = lines(dir).at(-1);
    expect(last).toMatchObject({ type: "result", outcome: "priced", http_status: 200 });
    expect(last.computed_cost_usd).toBeCloseTo((20 * 0.3 + 10 * 2.5) / 1e6, 12);
    run.end("completed");
  });

  it("records a failed request by its kind only, never by its message (WU-029)", async () => {
    const dir = records();
    const run = open(dir);
    const failures = [
      Object.assign(new TypeError("fetch failed: SECRET-TEXT"), {
        cause: { code: "ECONNRESET", message: "SECRET-TEXT" },
      }),
      Object.assign(new Error("SECRET-TEXT"), { name: "AbortError" }),
      Object.assign(new Error("SECRET-TEXT"), { name: "odd name: SECRET-TEXT", code: "lower" }),
    ];
    let k = 0;
    const capture = lib.createCapture({
      maxRequests: 10,
      guard: run,
      baseFetch: vi.fn(async () => {
        throw failures[k++];
      }),
    });
    for (let i = 0; i < failures.length; i++)
      await expect(capture.fetch(GOOD_URL, init())).rejects.toThrow(/SECRET-TEXT/);
    run.end("stopped");
    const results = lines(dir).filter((l: any) => l.type === "result");
    expect(results.map((r: any) => r.reason)).toEqual([
      "TypeError (ECONNRESET)",
      "AbortError",
      "Error",
    ]);
    expect(capture.exchanges.map((e: any) => e.network_error)).toEqual([
      "TypeError (ECONNRESET)",
      "AbortError",
      "Error",
    ]);
    expect(readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")).not.toContain("SECRET");
  });

  it("counts a request with no response, an error or unpriceable usage at its maximum", async () => {
    const dir = records();
    const b = body();
    const max = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", b).max_cost_usd;
    const run = open(dir, { maxUsd: 0.3 });
    const capture = lib.createCapture({
      maxRequests: 10,
      guard: run,
      baseFetch: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    await expect(capture.fetch(GOOD_URL, init(b))).rejects.toThrow(/socket hang up/);
    expect(lines(dir).at(-1)).toMatchObject({ type: "result", outcome: "no_response" });
    // 0.3 - max < max: the second request no longer fits.
    expect(0.3 - max).toBeLessThan(max);
    await expect(capture.fetch(GOOD_URL, init(b))).rejects.toMatchObject({ check: "dollars" });
    run.end("stopped");

    const dir2 = records();
    const run2 = open(dir2, { maxUsd: 0.3 });
    const capture2 = lib.createCapture({
      guard: run2,
      baseFetch: vi.fn(async () =>
        usageResponse({ promptTokenCount: 5, cachedContentTokenCount: 9 }),
      ),
    });
    await capture2.fetch(GOOD_URL, init(b));
    expect(lines(dir2).at(-1)).toMatchObject({ outcome: "unpriceable" });
    await expect(capture2.fetch(GOOD_URL, init(b))).rejects.toMatchObject({ check: "dollars" });
    run2.end("stopped");

    const dir3 = records();
    const run3 = open(dir3, { maxUsd: 0.3 });
    const capture3 = lib.createCapture({
      guard: run3,
      baseFetch: vi.fn(async () =>
        usageResponse({ promptTokenCount: 50, candidatesTokenCount: 20 }),
      ),
    });
    await capture3.fetch(GOOD_URL, init(b));
    await capture3.fetch(GOOD_URL, init(b));
    expect(lines(dir3).filter((l) => l.type === "attempt")).toHaveLength(2);
    run3.end("completed");
  });

  it("stops at the run's request cap", async () => {
    const dir = records();
    const run = open(dir, { maxRequests: 1 });
    const baseFetch = vi.fn(async () =>
      usageResponse({ promptTokenCount: 1, candidatesTokenCount: 1 }),
    );
    const capture = lib.createCapture({ guard: run, baseFetch });
    await capture.fetch(GOOD_URL, init());
    await expect(capture.fetch(GOOD_URL, init())).rejects.toMatchObject({
      check: "count",
      capReached: true,
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    run.end("cap_reached");
  });

  it("re-reads AGENTS.md before each request: a cap lowered mid-run stops the run", async () => {
    const dir = records();
    const earlier = Array.from({ length: 45 }, (_, i) => ({
      type: "attempt",
      run_id: "r0",
      entry: "#117",
      attempt_id: `r0:${i + 1}`,
      max_cost_usd: 0,
    }));
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 0.01, max_requests: 45 },
      ...earlier,
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
    ]);
    const a = agents(dir, (t) => t);
    const run = open(dir, { maxRequests: 5, agentsPath: a });
    writeFileSync(a, AGENTS.replace("| 50          |", "| 45          |"));
    const msg = await refusalAt(run, init(), "count");
    expect(msg).toMatch(/1 more would exceed its cap of 45/);
    run.end("cap_reached");
  });

  it("refuses mid-run once a card charge is recorded", async () => {
    const dir = records();
    const run = open(dir);
    seed(dir, [{ type: "card_charge", note: "statement line" }]);
    await refusalAt(run, init(), "card-charge");
    run.end("stopped");
  });

  it.each([
    [
      "a file reference",
      { contents: [{ role: "user", parts: [{ fileData: { fileUri: "gs://b/large.mp4" } }] }] },
    ],
    ["inline media", { contents: [{ role: "user", parts: [{ inlineData: { data: "AA==" } }] }] }],
    ["media in the system instruction", { systemInstruction: { parts: [{ fileData: {} }] } }],
    ["code execution", { tools: [{ codeExecution: {} }] }],
    ["function calling", { tools: [{ functionDeclarations: [] }] }],
  ])("refuses %s, which can bring input the body does not show", async (_label, over) => {
    const run = open(records());
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ baseFetch, guard: run });
    await expect(capture.fetch(GOOD_URL, init(body(over)))).rejects.toMatchObject({
      check: "dollars",
    });
    expect(baseFetch).not.toHaveBeenCalled();
    run.end("stopped");
  });

  it("refuses a Request object, which could carry headers admit() does not see", async () => {
    const run = open(records());
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ baseFetch, guard: run });
    const req = new Request(GOOD_URL, { method: "POST", headers: { "x-goog-api-key": "k" } });
    await expect(capture.fetch(req, init())).rejects.toMatchObject({ check: "endpoint" });
    expect(baseFetch).not.toHaveBeenCalled();
    run.end("stopped");
  });

  it("finds an API key in headers given as pairs or as a Headers object", async () => {
    const run = open(records());
    for (const headers of [[["X-Goog-Api-Key", "k"]], new Headers({ "x-goog-api-key": "k" })]) {
      await refusalAt(run, { method: "POST", body: body(), headers }, "endpoint");
    }
    run.end("stopped");
  });

  it("re-checks the credit record before each request: stale, or under the stop line", async () => {
    let t = NOW;
    const dir = records({ readAt: NOW - 47 * HOUR });
    const run = open(dir, { now: () => t });
    t = NOW + 2 * HOUR;
    await refusalAt(run, init(), "credit");
    t = NOW;
    writeFileSync(
      path.join(dir, "credit-position-2.json"),
      JSON.stringify({ read_at: new Date(NOW - 60_000).toISOString(), balance_usd: 21 }),
    );
    // 21 - this run's open $2 reservation is under $20.
    await refusalAt(run, init(), "credit");
    run.end("stopped");
  });

  it("re-checks reconciliation before each request", async () => {
    const dir = records();
    seed(dir, [
      { type: "reservation", run_id: "r0", entry: "#117", max_usd: 1, max_requests: 1 },
      { type: "end", run_id: "r0", entry: "#117", status: "completed" },
    ]);
    const run = open(dir, { maxUsd: 1 });
    seed(dir, [
      {
        type: "reconciliation",
        by: "prompt-author",
        run_id: "r0",
        billed_usd: 2.5,
        credit_record: "credit-position-1.json",
      },
    ]);
    await refusalAt(run, init(), "reconciliation");
    run.end("stopped");
  });

  it("reads the request once: what is admitted is what is sent", async () => {
    const run = open(records());
    const clean = body();
    const media = body({
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "gs://b/large.mp4" } }] }],
    });
    let headerReads = 0;
    let bodyReads = 0;
    const tricky = {
      method: "POST",
      get headers() {
        headerReads += 1;
        return headerReads === 1
          ? { "Content-Type": "application/json" }
          : { "x-goog-api-key": "k" };
      },
      get body() {
        bodyReads += 1;
        return bodyReads === 1 ? clean : media;
      },
    };
    const sent: Request[] = [];
    const baseFetch = vi.fn(async (url: string, sendInit: RequestInit) => {
      sent.push(new Request(url, sendInit));
      return usageResponse({ promptTokenCount: 5, candidatesTokenCount: 5 });
    });
    const capture = lib.createCapture({ baseFetch, guard: run });
    await capture.fetch(GOOD_URL, tricky);
    expect(headerReads).toBe(1);
    expect(bodyReads).toBe(1);
    expect(sent[0].headers.has("x-goog-api-key")).toBe(false);
    expect(await sent[0].text()).toBe(clean);
    run.end("completed");
  });

  it("refuses a fetch option it has no rule for", async () => {
    const run = open(records());
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ baseFetch, guard: run });
    await expect(capture.fetch(GOOD_URL, { ...init(), keepalive: true })).rejects.toMatchObject({
      check: "endpoint",
    });
    expect(baseFetch).not.toHaveBeenCalled();
    run.end("stopped");
  });

  it("refuses when the entry is reassigned to another script mid-run", async () => {
    const dir = records();
    const a = agents(dir, (t) => t);
    const run = open(dir, { agentsPath: a });
    writeFileSync(
      a,
      AGENTS.replace(
        "`scripts/probes/act08/p9-grounded-retrieval.mjs`:",
        "`scripts/probes/act08/p10-other.mjs`:",
      ),
    );
    await refusalAt(run, init(), "entry");
    run.end("stopped");
  });

  it("exposes no way to admit or settle except through a capture built on a real run", () => {
    const run = open(records());
    expect(run.admit).toBeUndefined();
    expect(run.settle).toBeUndefined();
    expect(Object.isFrozen(run)).toBe(true);
    expect(() =>
      lib.createCapture({ guard: { run_id: run.run_id, entry: "#117", admit: () => "x" } }),
    ).toThrow(lib.GuardRefusal);
    run.end("stopped");
  });

  it("keeps an in-flight request at its maximum: a second one waits for room", async () => {
    const dir = records();
    const grounded = body({ tools: [{ googleSearch: {} }] });
    const max = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", grounded).max_cost_usd;
    const run = open(dir, { maxUsd: 0.6 });
    let release: (r: Response) => void = () => {};
    const baseFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const capture = lib.createCapture({ guard: run, baseFetch });
    const first = capture.fetch(GOOD_URL, init(grounded));
    await Promise.resolve();
    expect(max * 2).toBeGreaterThan(0.6);
    await expect(capture.fetch(GOOD_URL, init(grounded))).rejects.toMatchObject({
      check: "dollars",
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    release(usageResponse({ promptTokenCount: 10, candidatesTokenCount: 10 }));
    await first;
    const results = lines(dir).filter((l) => l.type === "result");
    expect(results).toHaveLength(1);
    run.end("completed");
  });

  it("prices with the rates taken at openRun(), whatever happens to the caller's copy", async () => {
    const dir = records();
    const myRates = structuredClone(rates);
    const grounded = body({ tools: [{ googleSearch: {} }] });
    const run = open(dir, { maxUsd: 0.6, rates: myRates });
    let release: (r: Response) => void = () => {};
    const capture = lib.createCapture({
      guard: run,
      baseFetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const first = capture.fetch(GOOD_URL, init(grounded));
    await Promise.resolve();
    myRates.models["gemini-2.5-flash"].input_le_200k = 0;
    myRates.models["gemini-2.5-flash"].output_le_200k = 0;
    release(usageResponse({ promptTokenCount: 100000, candidatesTokenCount: 60000 }));
    await first;
    const result = lines(dir).find((l) => l.type === "result");
    // (100,000 * 0.30 + 60,000 * 2.50) / 1e6 + 0.035 grounding fee
    expect(result.computed_cost_usd).toBeCloseTo(0.215, 9);
    // 0.60 - 0.215 = 0.385 left, under the next grounded request's maximum.
    await expect(capture.fetch(GOOD_URL, init(grounded))).rejects.toMatchObject({
      check: "dollars",
    });
    run.end("completed");
  });

  it("records no result for a response that arrives after the run ended", async () => {
    const dir = records();
    const run = open(dir, { maxUsd: 1 });
    let release: (r: Response) => void = () => {};
    const capture = lib.createCapture({
      guard: run,
      baseFetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const pendingFetch = capture.fetch(GOOD_URL, init());
    await Promise.resolve();
    run.end("stopped");
    release(usageResponse({ promptTokenCount: 10, candidatesTokenCount: 10 }));
    await pendingFetch;
    expect(lines(dir).filter((l) => l.type === "result")).toHaveLength(0);
    // The ledger stays valid, and the unanswered attempt keeps its maximum.
    const s = ledgerCli.ledgerStatus({ dir, now: () => NOW });
    expect(s.runs[0].computed_usd).toBeGreaterThan(0.1);
  });

  it("refuses after the run has ended", async () => {
    const run = open(records());
    run.end("completed");
    await refusalAt(run, init(), "one-run");
  });
});

describe("an interrupted run, and ledger.mjs", () => {
  it("a killed run blocks the next one until close-interrupted, and keeps its liability", async () => {
    const dir = records();
    const killed = open(dir, { maxUsd: 4 });
    refusal(() => open(dir, { maxUsd: 0.5 }), "one-run");
    const log = vi.fn();
    await ledgerCli.main(["close-interrupted", "--run", killed.run_id, "--by", "operator"], {
      dir,
      now: () => NOW,
      log,
    });
    expect(lines(dir).at(-1)).toMatchObject({ type: "end", status: "interrupted" });
    expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(false);
    refusal(() => open(dir, { maxUsd: 1.5 }), "dollars");
    open(dir, { maxUsd: 1 }).end("completed");
  });

  it("reconcile flags a difference over max(10%, $1); explain clears it", async () => {
    const dir = records();
    open(dir, { maxUsd: 1 }).end("completed");
    const id = lines(dir)[0].run_id;
    const log = vi.fn();
    await ledgerCli.main(
      [
        "reconcile",
        "--run",
        id,
        "--billed-usd",
        "1.5",
        "--credit-record",
        "credit-position-1.json",
        "--by",
        "prompt-author",
      ],
      { dir, now: () => NOW, log },
    );
    expect(lines(dir).at(-1)).toMatchObject({
      type: "reconciliation",
      by: "prompt-author",
      flagged: true,
      billed_usd: 1.5,
    });
    refusal(() => open(dir), "reconciliation");
    await ledgerCli.main(["explain", "--run", id, "--note", "late rows", "--by", "operator"], {
      dir,
      now: () => NOW,
      log,
    });
    open(dir).end("completed");
    expect(ledgerCli.differenceFlagged(1.05, 1)).toBe(false);
    expect(ledgerCli.differenceFlagged(20, 15)).toBe(true);
  });

  it("status reports counts, liabilities and the credit record's age, and writes nothing", async () => {
    const dir = records();
    open(dir, { maxUsd: 1 }).end("completed");
    const before = readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8");
    const s = ledgerCli.ledgerStatus({ dir, now: () => NOW });
    expect(s.entries[0]).toMatchObject({ entry: "#117", attempts: 0, liabilities_usd: 1 });
    expect(s.credit).toMatchObject({ record: "credit-position-1.json", age_hours: 1, fresh: true });
    expect(readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")).toBe(before);
  });

  it("card-charge appends a line that stops every run", async () => {
    const dir = records();
    await ledgerCli.main(["card-charge", "--note", "statement", "--by", "operator"], {
      dir,
      now: () => NOW,
      log: vi.fn(),
    });
    refusal(() => open(dir), "card-charge");
  });

  it("rejects unknown commands and missing flags", () => {
    expect(() => ledgerCli.parseLedgerArgs(["wipe"])).toThrow(lib.UsageError);
    expect(() => ledgerCli.parseLedgerArgs(["reconcile", "--run", "x"])).toThrow(/needs --/);
    expect(() =>
      ledgerCli.parseLedgerArgs(["explain", "--run", "x", "--note", "  ", "--by", "operator"]),
    ).toThrow(/must not be blank/);
  });
});

describe("proposal 021: inline PNG and JPEG images in a guarded request", () => {
  /** A PNG with only a signature and an IHDR chunk: enough for the header, and tiny. */
  function png(width: number, height: number, pad = 0) {
    const b = Buffer.alloc(33 + pad);
    Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  }
  /** A JPEG with SOI, one APP0 segment and a baseline start-of-frame. */
  function jpeg(width: number, height: number) {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
    const sof = Buffer.alloc(19);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
  }
  const image = (mimeType: string, buf: Buffer) => ({
    contents: [
      {
        role: "user",
        parts: [
          { text: "List every game tile." },
          { inlineData: { mimeType, data: buf.toString("base64") } },
        ],
      },
    ],
  });

  it("reads an image's size from its own header", () => {
    expect(lib.imageSize("image/png", png(1852, 5055))).toEqual({ width: 1852, height: 5055 });
    expect(lib.imageSize("image/jpeg", jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(lib.imageSize("image/png", jpeg(10, 10))).toBeNull();
    const badSignature = png(10, 10);
    badSignature[0] = 0;
    expect(lib.imageSize("image/png", badSignature)).toBeNull();
    expect(lib.imageSize("image/jpeg", png(10, 10))).toBeNull();
    expect(lib.imageSize("image/png", png(10, 10).subarray(0, 20))).toBeNull();
    // Google's crop formula: units of floor(shorter side / 1.5) px; 258 tokens up to 384 px.
    expect(lib.imageTokens({ width: 960, height: 540 })).toBe(6 * 258);
    expect(lib.imageTokens({ width: 540, height: 960 })).toBe(6 * 258);
    expect(lib.imageTokens({ width: 1852, height: 5055 })).toBe(2 * 5 * 258);
    expect(lib.imageTokens({ width: 300, height: 200 })).toBe(258);
    expect(lib.imageTokens({ width: 384, height: 384 })).toBe(258);
    expect(lib.imageTokens({ width: 385, height: 384 })).toBe(2 * 2 * 258);
  });

  it("bounds an image request by the model's whole input context, never by the estimate", () => {
    // A small, highly compressed image: bytes plus the estimate would be far below the
    // context, so the context bounds it (Codex pre-dispatch review of WU-021, finding 1).
    for (const [mime, buf, tiles] of [
      ["image/png", png(960, 540), 6],
      ["image/png", png(1852, 5055, 2000), 10],
      ["image/jpeg", jpeg(1920, 1080), 6],
    ] as const) {
      const b = body(image(mime, buf));
      const m = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", b);
      expect(m.image_tile_tokens).toBe(tiles * 258);
      expect(m.input_ceiling_tokens).toBe(1048576);
      expect(m.max_cost_usd).toBeCloseTo((1048576 * 0.3 + 65536 * 2.5) / 1e6, 8);
    }
    // A body larger than the context keeps its own, larger bound.
    const big = body(image("image/png", png(960, 540, 1_200_000)));
    const mb = lib.maxRequestCostUsd(rates, "gemini-2.5-flash", big);
    expect(mb.input_ceiling_tokens).toBe(Buffer.byteLength(big, "utf8") + 6 * 258);
    // No context in rates.json: an image request is refused.
    const noCtx = structuredClone(rates);
    delete noCtx.models["gemini-2.5-flash"].max_input_tokens;
    expect(() =>
      lib.maxRequestCostUsd(noCtx, "gemini-2.5-flash", body(image("image/png", png(960, 540)))),
    ).toThrow(/max_input_tokens/);
    // A text-only request is bounded exactly as before.
    expect(lib.maxRequestCostUsd(rates, "gemini-2.5-flash", body()).image_tile_tokens).toBe(0);
  });

  it("admits and sends an image request through the capture", async () => {
    const run = open(records());
    const baseFetch = vi.fn(async () =>
      usageResponse({ promptTokenCount: 5418, candidatesTokenCount: 900 }),
    );
    const capture = lib.createCapture({ baseFetch, guard: run });
    await capture.fetch(GOOD_URL, init(body(image("image/png", png(1852, 5055, 100)))));
    expect(baseFetch).toHaveBeenCalledTimes(1);
    run.end("completed");
  });

  it.each([
    ["a GIF", (d: string) => ({ inlineData: { mimeType: "image/gif", data: d } })],
    ["video", (d: string) => ({ inlineData: { mimeType: "video/mp4", data: d } })],
    ["audio", (d: string) => ({ inlineData: { mimeType: "audio/wav", data: d } })],
    ["no media type", (d: string) => ({ inlineData: { data: d } })],
    [
      "data that is not base64",
      () => ({ inlineData: { mimeType: "image/png", data: "not base64!" } }),
    ],
    [
      "an extra field",
      (d: string) => ({ inlineData: { mimeType: "image/png", data: d, fileUri: "gs://x" } }),
    ],
    [
      "a PNG type with no PNG header",
      () => ({ inlineData: { mimeType: "image/png", data: "AAAA" } }),
    ],
    [
      "text and an image in one part",
      (d: string) => ({ text: "x", inlineData: { mimeType: "image/png", data: d } }),
    ],
  ])("refuses %s", async (_label, makePart) => {
    const run = open(records());
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ baseFetch, guard: run });
    // Each case uses a valid PNG unless the case is about the data: only its own rule refuses.
    const part = makePart(png(800, 600).toString("base64"));
    const b = body({ contents: [{ role: "user", parts: [part] }] });
    await expect(capture.fetch(GOOD_URL, init(b))).rejects.toMatchObject({ check: "dollars" });
    expect(baseFetch).not.toHaveBeenCalled();
    run.end("stopped");
  });

  it.each(["image/gif", "video/mp4", "audio/wav", "image/webp"])(
    "refuses the media type %s by its own rule, whatever the data",
    async (mimeType) => {
      const run = open(records());
      const capture = lib.createCapture({ baseFetch: vi.fn(), guard: run });
      const part = { inlineData: { mimeType, data: png(800, 600).toString("base64") } };
      const b = body({ contents: [{ role: "user", parts: [part] }] });
      await expect(capture.fetch(GOOD_URL, init(b))).rejects.toThrow(
        /mimeType must be image\/png or image\/jpeg/,
      );
      run.end("stopped");
    },
  );
});

describe("the global endpoint and Gemini 3 thinking levels (WU-026)", () => {
  const P9_ENDPOINT = "`us-central1-aiplatform.googleapis.com`, location `us-central1`";
  const GLOBAL_ENDPOINT = "`aiplatform.googleapis.com`, location `global`";
  const GLOBAL_URL =
    "https://aiplatform.googleapis.com/v1beta1/projects/mgpl-508415/locations/global/publishers/google/models/gemini-3.8-flash:generateContent";
  const levelBody = (thinkingConfig: Record<string, unknown>) =>
    body({}, { maxOutputTokens: 4096, thinkingConfig });
  /** AGENTS.md with only the #117 row's endpoint cell replaced. */
  const p9Endpoint = (t: string, cell: string) => {
    const row = t.split("\n").find((l) => l.startsWith("| #117 (P-9)")) as string;
    return t.replace(row, row.replace(P9_ENDPOINT, cell));
  };

  it("gives each location its one host", () => {
    expect(lib.hostFor("global")).toBe("aiplatform.googleapis.com");
    expect(lib.hostFor("us-central1")).toBe("us-central1-aiplatform.googleapis.com");
    for (const bad of ["", "Global", "us-central1.evil.example", "us-central1/x", undefined])
      expect(() => lib.hostFor(bad)).toThrow(/not a Vertex AI location/);
    expect(lib.expectedEndpoint("gemini-3.8-flash", "generateContent", "global")).toBe(GLOBAL_URL);
  });

  it.each([
    [
      "the global host with a regional location",
      "`aiplatform.googleapis.com`, location `us-central1`",
    ],
    [
      "a regional host with location global",
      "`us-central1-aiplatform.googleapis.com`, location `global`",
    ],
    ["another region's host", "`us-east1-aiplatform.googleapis.com`, location `us-central1`"],
  ])("refuses an entry naming %s", (_label, cell) => {
    refusal(() => lib.parseAuthorizations(p9Endpoint(AGENTS, cell)), "ledger");
  });

  it("admits a global request for a global entry, and refuses a regional one", async () => {
    const dir = records();
    const a = agents(dir, (t) => p9Endpoint(t, GLOBAL_ENDPOINT));
    expect(lib.parseAuthorizations(readFileSync(a, "utf8")).entries[0]).toMatchObject({
      id: "#117",
      host: "aiplatform.googleapis.com",
      location: "global",
    });
    const run = open(dir, { agentsPath: a });
    const baseFetch = vi.fn(async () =>
      usageResponse({ promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 }),
    );
    const capture = lib.createCapture({ maxRequests: 10, baseFetch, guard: run });
    await capture.fetch(GLOBAL_URL, init(levelBody({ thinkingLevel: "LOW" })));
    expect(baseFetch).toHaveBeenCalledTimes(1);
    for (const url of [
      GOOD_URL,
      GLOBAL_URL.replace("locations/global", "locations/us-central1"),
      `https://us-central1-aiplatform.googleapis.com${new URL(GLOBAL_URL).pathname}`,
    ]) {
      await expect(
        capture.fetch(url, init(levelBody({ thinkingLevel: "LOW" }))),
      ).rejects.toMatchObject({ check: "endpoint" });
    }
    expect(baseFetch).toHaveBeenCalledTimes(1);
    run.end("completed");
  });

  it("refuses a global request for a regional entry", async () => {
    const run = open(records());
    const baseFetch = vi.fn();
    const capture = lib.createCapture({ maxRequests: 10, baseFetch, guard: run });
    await expect(
      capture.fetch(GLOBAL_URL.replace("gemini-3.8-flash", "gemini-2.5-flash"), init()),
    ).rejects.toMatchObject({ check: "endpoint" });
    expect(baseFetch).not.toHaveBeenCalled();
    run.end("stopped");
  });

  it("dates each rate by its own read, when the row has one", () => {
    expect(lib.rateRef(rates, "gemini-3.8-flash").read_at).toBe("2026-10-13T15:30:00Z");
    expect(lib.rateRef(rates, "gemini-2.5-flash").read_at).toBe(rates.read_at);
  });

  it("bounds a thinking level by the model's whole output ceiling", () => {
    const m = lib.maxRequestCostUsd(rates, "gemini-3.8-flash", levelBody({ thinkingLevel: "LOW" }));
    expect(m.output_ceiling_tokens).toBe(4096 + 65536);
    expect(m.max_cost_usd).toBeCloseTo(
      (Buffer.byteLength(levelBody({ thinkingLevel: "LOW" }), "utf8") * 0.75 +
        (4096 + 65536) * 3.75) /
        1e6,
      8,
    );
    for (const level of ["MINIMAL", "MEDIUM", "HIGH"])
      expect(
        lib.maxRequestCostUsd(rates, "gemini-3.8-flash", levelBody({ thinkingLevel: level }))
          .output_ceiling_tokens,
      ).toBe(4096 + 65536);
  });

  it.each([
    ["a level and a budget together", { thinkingLevel: "LOW", thinkingBudget: 0 }],
    ["a lower-case minimal level", { thinkingLevel: "minimal" }],
    ["an unknown level", { thinkingLevel: "NONE" }],
    ["a lower-case level", { thinkingLevel: "low" }],
    ["an unknown thinking field", { thinkingBudget: 0, includeThoughts: true }],
  ])("refuses %s", (_label, thinkingConfig) => {
    refusal(
      () => lib.maxRequestCostUsd(rates, "gemini-3.8-flash", levelBody(thinkingConfig)),
      "dollars",
    );
  });
});

// WU-032 (#199): the admission rule for an embeddings predict request (§3.1 condition 5).
describe("the predict rule", () => {
  const EMB_URL = pathToFileURL(
    path.join(ROOT, "scripts", "catalogue", "embed-descriptions.mjs"),
  ).href;
  const EMB = "text-embedding-005";
  const PREDICT_URL = `https://${HOST}/v1beta1/projects/mgpl-508415/locations/us-central1/publishers/google/models/${EMB}:predict`;
  const T = Date.parse("2026-10-15T12:00:00Z");
  const pbody = (
    texts: string[] = ["One. A game."],
    params: any = { outputDimensionality: 768, autoTruncate: false },
    extra: any = {},
  ) =>
    JSON.stringify({
      instances: texts.map((content) => ({ content, task_type: "SEMANTIC_SIMILARITY" })),
      ...(params === undefined ? {} : { parameters: params }),
      ...extra,
    });
  const rate = () => rates.models[EMB].input_per_1000_count;

  it("bounds a request by its body's UTF-8 bytes at the input rate", () => {
    for (const texts of [
      ["One. A game."],
      ["Été — ½ ✓", "two"],
      Array(100).fill("x".repeat(400)),
    ]) {
      const b = pbody(texts);
      const bytes = Buffer.byteLength(b, "utf8");
      const r = lib.maxPredictCostUsd(rates, EMB, b);
      expect(r.input_bytes).toBe(bytes);
      expect(r.max_cost_usd).toBe(Math.ceil((bytes / 1000) * rate() * 1e9) / 1e9);
      expect(r.max_cost_usd).toBeGreaterThanOrEqual(
        (texts.reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0) / 1000) * rate(),
      );
      expect(r.fees_usd).toBe(0);
    }
  });

  it.each([
    [
      "an unknown top-level field",
      JSON.stringify({
        instances: [{ content: "a" }],
        parameters: { autoTruncate: false },
        labels: {},
      }),
      /predict field "labels"/,
    ],
    [
      "a title on an instance",
      JSON.stringify({
        instances: [{ content: "a", title: "t" }],
        parameters: { autoTruncate: false },
      }),
      /instances\[0\]\.title/,
    ],
    ["no parameters", JSON.stringify({ instances: [{ content: "a" }] }), /autoTruncate/],
    [
      "autoTruncate left on",
      pbody(undefined, { autoTruncate: true }),
      /autoTruncate must be false/,
    ],
    [
      "autoTruncate unset",
      pbody(undefined, { outputDimensionality: 768 }),
      /autoTruncate must be false/,
    ],
    [
      "an unknown parameter",
      pbody(undefined, { autoTruncate: false, mimeType: "x" }),
      /parameters\.mimeType/,
    ],
    [
      "a bad dimension",
      pbody(undefined, { autoTruncate: false, outputDimensionality: 0 }),
      /outputDimensionality/,
    ],
    ["no instances", pbody([]), /no instances/],
    ["an empty text", pbody([""]), /non-empty string/],
    ["a body that is not JSON", "{", /not JSON/],
  ])("refuses %s", (_name, b, re) => {
    expect(refusal(() => lib.maxPredictCostUsd(rates, EMB, b), "dollars")).toMatch(re);
  });

  it("refuses a model with no per-count rate, and a method with no rule", () => {
    expect(
      refusal(() => lib.maxPredictCostUsd(rates, "gemini-2.5-flash", pbody()), "dollars"),
    ).toMatch(/input_per_1000_count/);
    expect(
      refusal(() => lib.maxCostForMethodUsd(rates, EMB, "countTokens", pbody()), "dollars"),
    ).toMatch(/method countTokens/);
    expect(
      lib.maxCostForMethodUsd(rates, "gemini-2.5-flash", "generateContent", body()).max_cost_usd,
    ).toBe(lib.maxRequestCostUsd(rates, "gemini-2.5-flash", body()).max_cost_usd);
  });

  function openEmb(dir: string, over: Record<string, unknown> = {}) {
    return lib.openRun({
      entry: "#199",
      scriptUrl: EMB_URL,
      mode: "description",
      maxRequests: 5,
      maxUsd: 1,
      rates,
      dir,
      now: () => T,
      ...over,
    });
  }
  const predictInit = (b = pbody()) => ({
    method: "POST",
    body: b,
    headers: { "Content-Type": "application/json" },
  });
  const embResponse = (meta: object | null) =>
    new Response(
      JSON.stringify({
        predictions: [{ embeddings: { values: [0.1], statistics: { token_count: 3 } } }],
        ...(meta ? { metadata: meta } : {}),
      }),
      { status: 200 },
    );

  it("admits a predict request under #199 and prices its answer on billableCharacterCount", async () => {
    const dir = records({ readAt: T - HOUR });
    const run = openEmb(dir);
    const capture = lib.createCapture({
      guard: run,
      baseFetch: vi.fn(async () => embResponse({ billableCharacterCount: 1234 })),
    });
    await capture.fetch(PREDICT_URL, predictInit());
    run.end("completed");
    const led = lines(dir);
    const attempt = led.find((l: any) => l.type === "attempt");
    expect(attempt).toMatchObject({ method: "predict", model: EMB, grounding: false });
    expect(attempt.max_cost_usd).toBe(lib.maxPredictCostUsd(rates, EMB, pbody()).max_cost_usd);
    const result = led.find((l: any) => l.type === "result");
    expect(result).toMatchObject({ outcome: "priced" });
    expect(result.computed_cost_usd).toBe(lib.round((1234 / 1000) * rate()));
  });

  it("counts a predict answer with no billable count at its bound", async () => {
    const dir = records({ readAt: T - HOUR });
    const run = openEmb(dir);
    const capture = lib.createCapture({
      guard: run,
      baseFetch: vi.fn(async () => embResponse(null)),
    });
    await capture.fetch(PREDICT_URL, predictInit());
    run.end("completed");
    const result = lines(dir).find((l: any) => l.type === "result");
    expect(result).toMatchObject({ outcome: "unpriceable", computed_cost_usd: null });
  });

  it("refuses generateContent under #199 and predict under #117", async () => {
    const dir = records({ readAt: T - HOUR });
    const run = openEmb(dir);
    const gen = `https://${HOST}${MODEL_PATH}:generateContent`;
    const capture = lib.createCapture({ guard: run, baseFetch: vi.fn() });
    await expect(capture.fetch(gen, init())).rejects.toMatchObject({ check: "endpoint" });
    run.end("completed");
    const dir2 = records();
    const p9 = open(dir2);
    const c2 = lib.createCapture({ guard: p9, baseFetch: vi.fn() });
    await expect(c2.fetch(PREDICT_URL, predictInit())).rejects.toMatchObject({ check: "endpoint" });
    p9.end("completed");
  });

  it("refuses a predict request whose bound the reservation cannot hold", async () => {
    const dir = records({ readAt: T - HOUR });
    const run = openEmb(dir, { maxUsd: 0.000001 });
    const capture = lib.createCapture({ guard: run, baseFetch: vi.fn() });
    await expect(
      capture.fetch(PREDICT_URL, predictInit(pbody(Array(100).fill("x".repeat(400))))),
    ).rejects.toMatchObject({ check: "dollars" });
    run.end("completed");
  });
});

// Append to test/unit/act08RunGuard.test.ts using existing lib, AGENTS, it and expect bindings.
it("WU-034 preserves original entries and totals when two ledger rows are appended", () => {
  const before = lib.parseAuthorizations(AGENTS);
  const lines = AGENTS.split("\n");
  let index = -1;
  lines.forEach((line: string, i: number) => {
    if (/^\| #\d+/.test(line)) index = i;
  });
  expect(index).toBeGreaterThanOrEqual(0);
  lines.splice(
    index + 1,
    0,
    "| #999990 (JDG) | `scripts/catalogue/enrich-gemini.mjs`: check | `aiplatform.googleapis.com`, location `global`, `generateContent` only | Principal Operator | 12000 | $110 | `../_staging/enrichment-output/` | 2026-10-16 | 2026-11-06 |",
    "| #999991 (EMB-2) | `scripts/catalogue/embed-descriptions.mjs`: text | `us-central1-aiplatform.googleapis.com`, location `us-central1`, `predict` only | Principal Operator | 8000 | $5 | `../_staging/enrichment-output/` | 2026-10-16 | 2026-11-06 |",
  );
  const after = lib.parseAuthorizations(lines.join("\n"));
  expect(after.window).toEqual(before.window);
  expect(after.entries).toHaveLength(before.entries.length + 2);
  expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
});

const wu034Modes = ["description", "friction", "genre", "check", "title"];
const wu034En = "scripts/catalogue/enrich-gemini.mjs";
const wu034Em = "scripts/catalogue/embed-descriptions.mjs";
for (const label of ["S3", "JDG", "EMB", "EMB-2", null]) {
  for (const script of [wu034En, wu034Em]) {
    for (const mode of wu034Modes) {
      it(`WU-034 admission matrix ${label}/${script}/${mode}`, () => {
        const permitted =
          (script === wu034En &&
            label === "S3" &&
            ["description", "friction", "genre"].includes(mode)) ||
          (script === wu034En && label === "JDG" && mode === "check") ||
          (script === wu034Em && label === "EMB" && mode === "description") ||
          (script === wu034Em &&
            label === "EMB-2" &&
            ["title", "friction", "genre"].includes(mode));
        const entry = { id: "#990", label, script };
        if (permitted) expect(() => lib.assertEntryMode(entry, { script, mode })).not.toThrow();
        else {
          try {
            lib.assertEntryMode(entry, { script, mode });
            throw new Error("expected mode refusal");
          } catch (e: any) {
            expect(e.code).toBe("WU034_MODE_ENTRY");
            expect(e.check).toBe("mode");
          }
        }
      });
    }
  }
}

function wu034OpenOptions(dir: string, agentsPath: string) {
  return {
    entry: "#158",
    scriptUrl: pathToFileURL(path.join(ROOT, wu034En)).href,
    mode: "description",
    maxRequests: 1,
    maxUsd: 1,
    rates,
    dir,
    agentsPath,
    now: () => Date.parse("2026-10-20T12:00:00Z"),
    root: ROOT,
  };
}

describe("explicit WU-034 operator waiver", () => {
  function options(dir: string, over: Record<string, unknown> = {}) {
    return {
      ...wu034OpenOptions(
        dir,
        agents(dir, (t) => t),
      ),
      entry: "#207",
      mode: "check",
      maxUsd: 300,
      operatorWaiver: lib.WU034_OPERATOR_WAIVER,
      ...over,
    };
  }
  it("waives missing credit evidence and entry/window dollars, with truthful reservation metadata", async () => {
    const dir = records({ credit: false });
    const run = lib.openRun(options(dir));
    const response = usageResponse({ promptTokenCount: 1, candidatesTokenCount: 1 });
    const send = vi.fn(async () => response);
    const capture = lib.createCapture({ guard: run, baseFetch: send });
    try {
      await capture.fetch(
        lib.expectedEndpoint("gemini-3.8-flash", "generateContent", "global"),
        init(body({}, { thinkingConfig: { thinkingLevel: "LOW" } })),
      );
      expect(send).toHaveBeenCalledTimes(1);
      await expect(
        capture.fetch(
          lib.expectedEndpoint("gemini-3.8-flash", "generateContent", "global"),
          init(body({}, { thinkingConfig: { thinkingLevel: "LOW" } })),
        ),
      ).rejects.toMatchObject({ check: "count" });
      const reservation = lines(dir)[0];
      expect(reservation.operator_waiver).toBe(lib.WU034_OPERATOR_WAIVER);
      expect(reservation.credit_check_waived).toBe(true);
      expect(reservation.credit_record).toBeNull();
      expect(lines(dir).some((r: any) => r.type === "result" && r.outcome === "priced")).toBe(true);
    } finally {
      run.end();
    }
    expect(lib.summarizeLedger(lib.readLedger(dir)).openRuns).toHaveLength(0);
  });
  it("leaves the normal credit and dollar refusals intact without the flag", () => {
    const dir = records({ credit: false });
    refusal(() => lib.openRun(options(dir, { operatorWaiver: undefined })), "dollars");
    refusal(() => lib.openRun(options(dir, { operatorWaiver: undefined, maxUsd: 1 })), "credit");
    expect(lines(dir)).toHaveLength(0);
  });
  it("rejects a wrong reference or a different entry before recording a reservation", () => {
    const dir = records({ credit: false });
    refusal(() => lib.openRun(options(dir, { operatorWaiver: "approved" })), "operator-waiver");
    refusal(
      () => lib.openRun(options(dir, { entry: "#158", mode: "description" })),
      "operator-waiver",
    );
    expect(lines(dir)).toHaveLength(0);
  });
  it("retains the request cap, expiry and corrupt-ledger refusal", () => {
    const dir = records({ credit: false });
    refusal(() => lib.openRun(options(dir, { maxRequests: 12001 })), "count");
    refusal(
      () => lib.openRun(options(dir, { now: () => Date.parse("2026-11-06T00:00:00Z") })),
      "expiry",
    );
    writeFileSync(path.join(dir, "spend-ledger.jsonl"), "invalid\n");
    refusal(() => lib.openRun(options(dir)), "count");
  });
  it("retains endpoint/model restrictions, the run reservation and lock", async () => {
    const dir = records({ credit: false });
    const opts = options(dir, { maxUsd: 0.000000001 });
    const run = lib.openRun(opts);
    const send = vi.fn(async () => usageResponse({ promptTokenCount: 1, candidatesTokenCount: 1 }));
    const capture = lib.createCapture({ guard: run, baseFetch: send });
    try {
      refusal(() => lib.openRun(opts), "one-run");
      await expect(
        capture.fetch(
          lib.expectedEndpoint("gemini-2.5-flash", "generateContent", "global"),
          init(),
        ),
      ).rejects.toMatchObject({ check: "operator-waiver" });
      await expect(
        capture.fetch(
          lib.expectedEndpoint("gemini-3.8-flash", "generateContent", "global"),
          init(body({}, { thinkingConfig: { thinkingLevel: "LOW" } })),
        ),
      ).rejects.toMatchObject({ check: "dollars" });
      expect(send).not.toHaveBeenCalled();
      expect(lines(dir).filter((r: any) => r.type === "attempt")).toHaveLength(0);
    } finally {
      run.end();
    }
  });
});
it("WU-034 openRun missing catalogue mode refuses before lock or reservation", () => {
  const dir = records({ readAt: Date.parse("2026-10-20T11:00:00Z") });
  const file = agents(dir, (t) => t);
  const opts: any = wu034OpenOptions(dir, file);
  delete opts.mode;
  let run: any;
  try {
    expect(() => {
      run = lib.openRun(opts);
    }).toThrowError(expect.objectContaining({ code: "WU034_MODE_ENTRY" }));
  } finally {
    if (run) run.end();
  }
  expect(existsSync(path.join(dir, "spend-ledger.lock"))).toBe(false);
  expect(lines(dir).filter((r: any) => r.type === "reservation")).toHaveLength(0);
});
it("WU-034 admit refuses an entry relabelled after reservation", async () => {
  const dir = records({ readAt: Date.parse("2026-10-20T11:00:00Z") });
  const file = agents(dir, (t) => t);
  const run = lib.openRun(wu034OpenOptions(dir, file));
  try {
    writeFileSync(file, readFileSync(file, "utf8").replace("#158 (S3)", "#158 (JDG)"));
    const url = lib.expectedEndpoint("gemini-3.1-flash-lite", "generateContent", "global");
    const baseFetch = vi.fn(async () =>
      usageResponse({ promptTokenCount: 1, candidatesTokenCount: 1 }),
    );
    const capture = lib.createCapture({ guard: run, baseFetch });
    await expect(
      capture.fetch(url, {
        method: "POST",
        body: body(),
        headers: { "Content-Type": "application/json" },
      }),
    ).rejects.toMatchObject({ code: "WU034_MODE_ENTRY", check: "mode" });
    expect(baseFetch).not.toHaveBeenCalled();
    expect(lines(dir).filter((r: any) => r.type === "attempt")).toHaveLength(0);
  } finally {
    run.end();
  }
});
