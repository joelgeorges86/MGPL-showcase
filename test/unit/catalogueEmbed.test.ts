// WU-032 (#199, task proposal 032): the description embeddings script. Offline only: the global
// fetch throws for the whole file, the SDK gets a stub fetch and a stub credential, the run guard
// works in a temporary records folder with a temporary AGENTS.md that carries a test entry, and
// every file goes to a temporary folder. Invented games only.
// cspell:words aiplatform genai vertexai wikidata Driftwood Lanterns Emberfall unpriceable xids
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = process.cwd();
const NOW = Date.parse("2026-10-20T12:00:00Z");
const ENTRY = "#992";
const DESC_MARK = "lantern-lit canals";

let em: any;
let lib: any;
let GoogleGenAI: any;
const realFetch = globalThis.fetch;
const dirs: string[] = [];

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("network access in a catalogue embedding test");
  }) as typeof fetch;
  lib = await import("../../scripts/probes/act08/lib.mjs");
  em = await import("../../scripts/catalogue/embed-descriptions.mjs");
  ({ GoogleGenAI } = await import("@google/genai"));
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
const jsonl = (file: string, rows: unknown[]) =>
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("embedding resume records", () => {
  const record = (hash = "first") => ({
    schema: "mgpl-embedding/1",
    model: "text-embedding-005",
    dimensions: 768,
    text_kind: "title",
    qid: "Q1",
    text_sha256: hash,
  });

  it("keeps the latest matching hash across byte chunks and preserves dry-run bytes", () => {
    const file = path.join(tmp("embed-chunks-"), "vectors.jsonl");
    const empty = JSON.stringify({ ...record(), padding: "" });
    const first = JSON.stringify({
      ...record(),
      padding: "x".repeat(65535 - (empty.length - 2)) + "é🎮",
    });
    const content =
      first + "\r\n\n" + JSON.stringify(record("latest")) + "\n" + JSON.stringify(record("tail"));
    writeFileSync(file, content);
    expect(em.doneHashes(file, { kind: "title" }).get("Q1")).toBe("latest");
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(em.doneHashes(file, { kind: "title", repair: true }).get("Q1")).toBe("tail");
    expect(readFileSync(file, "utf8")).toBe(content + "\n");
  });

  it("truncates only an interrupted tail and refuses earlier corruption without modifying bytes", () => {
    const file = path.join(tmp("embed-tail-"), "vectors.jsonl");
    const prefix = JSON.stringify(record()) + "\n";
    writeFileSync(file, prefix + '{"partial":');
    expect(em.doneHashes(file, { kind: "title", repair: true }).get("Q1")).toBe("first");
    expect(readFileSync(file, "utf8")).toBe(prefix);
    const corrupt = prefix + "invalid\n" + '{"partial":';
    writeFileSync(file, corrupt);
    expect(() => em.doneHashes(file, { kind: "title", repair: true })).toThrow(
      /line 2 is not JSON/,
    );
    expect(readFileSync(file, "utf8")).toBe(corrupt);
  });

  it("reads a file beyond Node's string limit with a small heap in both modes", () => {
    const file = path.join(tmp("embed-large-"), "vectors.jsonl");
    const moduleUrl = new URL("../../scripts/catalogue/embed-descriptions.mjs", import.meta.url)
      .href;
    const script = `
      import { openSync, writeSync, closeSync, statSync } from 'node:fs';
      import { doneHashes } from ${JSON.stringify(moduleUrl)};
      const file = ${JSON.stringify(file)};
      const row = ${JSON.stringify(record())};
      const line = JSON.stringify({...row, padding: 'x'.repeat(8000)}) + '\\n';
      const block = line.repeat(128);
      const fd = openSync(file, 'w');
      try { for (let i = 0; i < 530; i++) writeSync(fd, block); }
      finally { closeSync(fd); }
      if (statSync(file).size <= 0x1fffffe8) throw Error('fixture too small');
      for (const repair of [false, true]) {
        const result = doneHashes(file, {kind: 'title', repair});
        if (result.size !== 1 || result.get('Q1') !== 'first') throw Error('wrong hashes');
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=128", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 60000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 65000);
});

const desc = (qid: string, status: string, at: string, text?: string) => ({
  schema: "mgpl-enrichment/1",
  qid,
  task: "description",
  status,
  label: "generated",
  generated: {
    description: status === "ok" ? (text ?? `A quiet game of ${DESC_MARK} for ${qid}.`) : null,
  },
  run_id: "run-d",
  attempt_id: `run-d:${qid}`,
  at,
});

/** An output folder with description drafts for Q1..Qn, and a catalogue with their labels. */
function fixtures(n = 5, extra: { none?: unknown[]; noLabel?: string[] } = {}) {
  const out = tmp("embed-out-");
  const wiki = Array.from({ length: n }, (_, i) => desc(`Q${i + 1}`, "ok", "2026-10-14T01:00:00Z"));
  wiki.push(desc("Q900", "insufficient", "2026-10-14T01:00:00Z"));
  jsonl(path.join(out, "enrich-gemini-description-wikipedia.jsonl"), wiki);
  jsonl(path.join(out, "enrich-gemini-description-none.jsonl"), extra.none ?? []);
  const cat = tmp("embed-cat-");
  const names = ["Driftwood Lanterns", "Emberfall Tactics", "Harbor of Echoes", "Copper Orchard"];
  jsonl(
    path.join(cat, "wikidata.jsonl"),
    Array.from({ length: n }, (_, i) => `Q${i + 1}`)
      .filter((q) => !(extra.noLabel ?? []).includes(q))
      .map((q, i) => ({ qid: q, label: names[i % names.length] + ` ${i + 1}` })),
  );
  return { out, cat };
}

function records() {
  const dir = tmp("embed-gcp-");
  writeFileSync(
    path.join(dir, "credit-position-1.json"),
    JSON.stringify({ read_at: new Date(NOW - 3_600_000).toISOString(), balance_usd: 271 }),
  );
  return dir;
}

/** AGENTS.md with one more ledger row: a test entry naming this script and the output folder. */
function agentsWithEntry(out: string, cap = "3000", usd = "$5") {
  const text = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const row = `| ${ENTRY} (EMB) | \`scripts/catalogue/embed-descriptions.mjs\`: test entry | \`us-central1-aiplatform.googleapis.com\`, location \`us-central1\`, \`predict\` only | Principal Operator | ${cap} | ${usd} | \`${out}\` | 2026-10-12 | 2026-11-06 |`;
  const ls = text.split("\n");
  const at = ls.findIndex((l) => l.startsWith("| #117 (P-9)"));
  ls.splice(at + 1, 0, row);
  const file = path.join(tmp("embed-agents-"), "AGENTS.md");
  writeFileSync(file, ls.join("\n"));
  return file;
}

function makeClient(holder: any, httpOptions: any = {}) {
  return new GoogleGenAI({
    vertexai: true,
    project: "mgpl-508415",
    location: "us-central1",
    googleAuthOptions: {
      authClient: { getRequestHeaders: async () => new Headers({ Authorization: "Bearer test" }) },
    },
    httpOptions: { ...httpOptions, fetch: holder.fetch },
  });
}

const vec = (seed: number) => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) / 3);

/** A stub Vertex: answers each predict with one 768-value vector per text. */
function stubVertex(
  opts: { fail?: number[]; badSize?: boolean; badCalls?: number[]; noMetadata?: boolean } = {},
) {
  let call = 0;
  const bodies: string[] = [];
  const fn = vi.fn(async (_url: string, init: any) => {
    call++;
    bodies.push(init.body);
    if (opts.fail?.includes(call)) return new Response("{}", { status: 503 });
    const req = JSON.parse(init.body);
    const n = req.instances.length;
    return new Response(
      JSON.stringify({
        predictions: req.instances.map((_: unknown, i: number) => ({
          embeddings: {
            values: opts.badSize || opts.badCalls?.includes(call) ? [0.1] : vec(call * 1000 + i),
            statistics: { token_count: 10, truncated: false },
          },
        })),
        ...(opts.noMetadata ? {} : { metadata: { billableCharacterCount: 40 * n } }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return Object.assign(fn, { bodies });
}

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const descFiles = (out: string) =>
  ["wikipedia", "none"]
    .map((c) => path.join(out, `enrich-gemini-description-${c}.jsonl`))
    .filter((f) => existsSync(f));

/** An accepted description sample-check summary, with its sheet and meta file, naming `files`. */
function acceptedSummary(
  out: string,
  over: Record<string, unknown> = {},
  files: string[] = descFiles(out),
) {
  const dir = tmp("embed-sample-");
  const sheet = path.join(dir, "sample-description-t1.csv");
  const meta = path.join(dir, "sample-description-t1.meta.json");
  writeFileSync(sheet, "n,qid,verdict\n1,Q1,correct\n");
  writeFileSync(meta, '{"schema":"mgpl-sample-check/1"}\n');
  const summary = {
    schema: "mgpl-sample-check-summary/1",
    kind: "description",
    seed: "t1",
    sheet: path.basename(sheet),
    sheet_sha256: sha(readFileSync(sheet)),
    meta_sha256: sha(readFileSync(meta)),
    inputs: files.map((f) => ({
      file: path.basename(f),
      sha256: sha(readFileSync(f)),
      records: 1,
    })),
    n: 100,
    counts: { correct: 97, minor: 0, wrong: 3, unverifiable: 0, unchecked: 0 },
    checked: 100,
    complete: true,
    meets_line: true,
    accepted_by: "Principal Operator",
    accepted_at: "2026-10-14T15:00:00Z",
    ...over,
  };
  const file = path.join(dir, "sample-description-t1.summary.json");
  writeFileSync(file, JSON.stringify(summary));
  return file;
}

async function runMain(
  extra: string[] = [],
  opts: {
    out?: string;
    cat?: string;
    dir?: string;
    stub?: any;
    agents?: string;
    sleep?: any;
    onCapture?: (c: any) => void;
    afterSnapshot?: () => void;
    /** The --sample-summary to pass: by default an accepted one for the current files; null omits it. */
    summary?: string | null;
  } = {},
) {
  const fx = opts.out ? { out: opts.out, cat: opts.cat as string } : fixtures();
  const summary = opts.summary === undefined ? acceptedSummary(fx.out) : opts.summary;
  const dir = opts.dir ?? records();
  const stub = opts.stub ?? stubVertex();
  const logs: string[] = [];
  const sleep = opts.sleep ?? vi.fn(async () => {});
  const code = await em.main(
    [
      "--run",
      "--entry",
      ENTRY,
      "--reserve",
      "1",
      "--out",
      fx.out,
      ...(summary === null ? [] : ["--sample-summary", summary]),
      ...extra,
    ],
    {
      dir,
      catalogue: fx.cat,
      agentsPath: opts.agents ?? agentsWithEntry(fx.out),
      now: () => NOW,
      sleep,
      baseFetch: stub,
      makeClient,
      log: (s: string) => logs.push(s),
      interrupts: new EventEmitter(),
      onCapture: opts.onCapture,
      afterSnapshot: opts.afterSnapshot,
    },
  );
  return { code, out: fx.out, cat: fx.cat, dir, logs, stub, sleep };
}

describe("texts and batches", () => {
  it("joins the label and the description with one full stop", () => {
    expect(em.textFor("Harbor of Echoes", "A game.")).toBe("Harbor of Echoes. A game.");
    expect(em.textFor("Wait, What?", "A game.")).toBe("Wait, What? A game.");
  });

  it("takes the latest ok description per game, ordered by QID, and counts what it skips", () => {
    const wiki = [desc("Q10", "ok", "t1"), desc("Q2", "ok", "t1"), desc("Q3", "ok", "t1")];
    const none = [desc("Q3", "insufficient", "t2"), desc("Q2", "ok", "t2", "Second draft.")];
    const labels = new Map([
      ["Q10", "Ten"],
      ["Q2", "Two"],
    ]);
    const b = em.buildItems([wiki, none], labels);
    expect(b.items.map((i: any) => i.qid)).toEqual(["Q2", "Q10"]);
    expect(b.items[0].text).toBe("Two. Second draft.");
    expect(b.items[0].text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatchObject({ eligible: 2, no_title: 0, too_long: 0 });
    // The limit is UTF-8 bytes, not characters: "L. " plus 1,000 "é" is 1,003 characters but
    // 2,003 bytes, over the 2,000-byte limit. "L. " plus 1,997 ASCII letters is exactly 2,000.
    const long = em.buildItems(
      [[desc("Q1", "ok", "t", "é".repeat(1_000))], [desc("Q2", "ok", "t", "a".repeat(1_997))]],
      new Map([
        ["Q1", "L"],
        ["Q2", "L"],
      ]),
    );
    expect(em.MAX_TEXT_BYTES).toBe(2_000);
    expect(long).toMatchObject({ too_long: 1 });
    expect(long.items.map((i: any) => i.qid)).toEqual(["Q2"]);
    expect(em.buildItems([wiki], new Map()).no_title).toBe(3);
  });

  it("cuts batches by count and by UTF-8 bytes, within the model's token limits", () => {
    // 19,000 bytes a request: ten texts of 1,900 bytes fill one exactly.
    expect(em.MAX_REQUEST_BYTES).toBe(19_000);
    const ascii = Array.from({ length: 25 }, (_, i) => ({ qid: `Q${i}`, text: "a".repeat(1_900) }));
    expect(em.planBatches(ascii, 100).map((b: any[]) => b.length)).toEqual([10, 10, 5]);
    // 950 "é" is 950 characters and 1,900 bytes: batches are cut by bytes, not characters.
    const accented = ascii.map((it) => ({ ...it, text: "é".repeat(950) }));
    expect(em.planBatches(accented, 100).map((b: any[]) => b.length)).toEqual([10, 10, 5]);
    // A request's texts never exceed 19,000 bytes, and a text over 2,000 bytes is never planned.
    for (const b of em.planBatches(accented, 250))
      expect(
        b.reduce((n: number, it: any) => n + Buffer.byteLength(it.text), 0),
      ).toBeLessThanOrEqual(19_000);
    expect(() => em.planBatches([{ qid: "Q1", text: "a".repeat(2_001) }])).toThrow(/byte limit/);
    const small = Array.from({ length: 7 }, (_, i) => ({ qid: `Q${i}`, text: "a" }));
    expect(em.planBatches(small, 3).map((b: any[]) => b.length)).toEqual([3, 3, 1]);
  });

  it("builds the body @google/genai sends, byte for byte", async () => {
    let sent = "";
    const ai = makeClient({
      fetch: async (_u: string, init: any) => {
        sent = init.body;
        return new Response(
          JSON.stringify({
            predictions: [
              { embeddings: { values: [0], statistics: {} } },
              { embeddings: { values: [0], statistics: {} } },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const texts = ["One. A game.", "Two été. “Quoted”"];
    await ai.models.embedContent(em.embedParams(texts));
    expect(sent).toBe(em.predictBody(texts));
  });

  it("round-trips a vector through little-endian float32", () => {
    const v = vec(3);
    const back = em.decodeVector(em.encodeVector(v));
    expect(back).toHaveLength(768);
    back.forEach((x: number, i: number) => expect(x).toBeCloseTo(v[i], 6));
    expect(Buffer.from(em.encodeVector([1]), "base64")).toEqual(Buffer.from([0, 0, 0x80, 0x3f]));
  });

  it("rejects answers of the wrong count or size, non-finite values and truncated texts", () => {
    const good = { embeddings: [{ values: vec(1), statistics: { truncated: false } }] };
    expect(em.answerProblem(good, 1)).toBeNull();
    expect(em.answerProblem(good, 2)).toMatch(/number/);
    expect(em.answerProblem({ embeddings: [{ values: [1] }] }, 1)).toMatch(/size/);
    const nan = vec(1);
    nan[5] = NaN;
    expect(em.answerProblem({ embeddings: [{ values: nan }] }, 1)).toMatch(/finite/);
    expect(
      em.answerProblem({ embeddings: [{ values: vec(1), statistics: { truncated: true } }] }, 1),
    ).toMatch(/truncated/);
  });
});

describe("the run", () => {
  it("embeds every game once, records each vector with its text hash, and logs no text", async () => {
    const r = await runMain(["--batch", "2"]);
    expect(r.code).toBe(0);
    const recs = lines(em.vectorsFile(r.out));
    expect(recs.map((x: any) => x.qid)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    for (const x of recs) {
      expect(x).toMatchObject({
        schema: "mgpl-embedding/1",
        model: "text-embedding-005",
        dimensions: 768,
        task_type: "SEMANTIC_SIMILARITY",
      });
      expect(em.decodeVector(x.vector_f32le_b64)).toHaveLength(768);
      expect(x.attempt_id).toMatch(/:\d+$/);
    }
    expect(r.stub).toHaveBeenCalledTimes(3);
    const led = lines(path.join(r.dir, "spend-ledger.jsonl"));
    expect(
      led.filter((l: any) => l.type === "attempt").every((l: any) => l.method === "predict"),
    ).toBe(true);
    const results = led.filter((l: any) => l.type === "result");
    expect(results.map((l: any) => l.outcome)).toEqual(["priced", "priced", "priced"]);
    expect(results[0].computed_cost_usd).toBeCloseTo((80 / 1000) * 0.000025, 12);
    expect(led.at(-1)).toMatchObject({ type: "end", status: "completed" });
    expect(existsSync(path.join(r.dir, "spend-ledger.lock"))).toBe(false);
    const all =
      r.logs.join("\n") +
      readdirSync(r.out)
        .filter((f) => f.endsWith("aggregate.json"))
        .map((f) => readFileSync(path.join(r.out, f), "utf8"))
        .join("");
    expect(all).not.toContain(DESC_MARK);
    expect(all).not.toContain("Driftwood");
    expect(r.logs[0]).toMatch(/games embedded 5, failed 0/);
  });

  it("keeps no text or vector in memory once a request settles", async () => {
    let cap: any = null;
    await runMain(["--batch", "2"], { onCapture: (c: any) => (cap = c) });
    expect(cap.exchanges).toHaveLength(3);
    for (const ex of cap.exchanges) {
      expect(ex.request_body).toBeNull();
      expect(ex.response_body).toBeNull();
      expect(ex.guard.outcome).toBe("priced");
    }
  });

  it("resumes: a second run has nothing to do, and a changed description is embedded again", async () => {
    const first = await runMain();
    const again = runMain([], { out: first.out, cat: first.cat, dir: first.dir });
    await expect(again).rejects.toThrow(/nothing to do/);
    jsonl(path.join(first.out, "enrich-gemini-description-none.jsonl"), [
      desc("Q2", "ok", "2026-10-14T05:00:00Z", "A new draft."),
    ]);
    const third = await runMain([], { out: first.out, cat: first.cat, dir: first.dir });
    expect(third.code).toBe(0);
    const recs = lines(em.vectorsFile(first.out));
    expect(recs.filter((x: any) => x.qid === "Q2")).toHaveLength(2);
    expect(third.logs[0]).toMatch(/games embedded 1,/);
  });

  it("retries a 503 after a pause, and every attempt is on the ledger", async () => {
    const stub = stubVertex({ fail: [1] });
    const r = await runMain([], { stub });
    expect(r.code).toBe(0);
    expect(r.sleep).toHaveBeenCalledWith(5_000);
    const led = lines(path.join(r.dir, "spend-ledger.jsonl"));
    expect(led.filter((l: any) => l.type === "attempt")).toHaveLength(2);
    expect(led.filter((l: any) => l.type === "result").map((l: any) => l.outcome)).toEqual([
      "http_error",
      "priced",
    ]);
  });

  it("writes nothing for an answer of the wrong size, and stops after three in a row", async () => {
    const r = await runMain(["--batch", "1"], { stub: stubVertex({ badSize: true }) });
    expect(r.code).toBe(1);
    expect(existsSync(em.vectorsFile(r.out)) ? lines(em.vectorsFile(r.out)) : []).toEqual([]);
    expect(r.stub).toHaveBeenCalledTimes(3);
    expect(r.logs[0]).toMatch(/3 unusable answers in a row/);
  });

  it("ends as failed, with exit 1, when the last batch's answer is unusable", async () => {
    const r = await runMain(["--batch", "2"], { stub: stubVertex({ badCalls: [3] }) });
    expect(r.code).toBe(1);
    expect(lines(em.vectorsFile(r.out)).map((x: any) => x.qid)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(r.logs[0]).toMatch(/1 games had unusable answers.*failed; .*games embedded 4, failed 1/);
    const led = lines(path.join(r.dir, "spend-ledger.jsonl"));
    expect(led.at(-1)).toMatchObject({ type: "end", status: "failed" });
  });

  it("ends as failed when a bad batch is followed by good ones, and a rerun embeds the rest", async () => {
    const r = await runMain(["--batch", "2"], { stub: stubVertex({ badCalls: [1] }) });
    expect(r.stub).toHaveBeenCalledTimes(3);
    expect(r.code).toBe(1);
    expect(r.logs[0]).toMatch(/games embedded 3, failed 2/);
    const again = await runMain(["--batch", "2"], { out: r.out, cat: r.cat, dir: r.dir });
    expect(again.code).toBe(0);
    expect(again.logs[0]).toMatch(/games embedded 2, failed 0/);
  });

  it("ends as failed when the only batch's answer is unusable", async () => {
    const r = await runMain([], { stub: stubVertex({ badSize: true }) });
    expect(r.stub).toHaveBeenCalledTimes(1);
    expect(r.code).toBe(1);
    expect(existsSync(em.vectorsFile(r.out)) ? lines(em.vectorsFile(r.out)) : []).toEqual([]);
  });

  it("repairs the vectors file only under the run's lock", async () => {
    // An interrupted run left an incomplete last line. While another run holds the lock, this run
    // is refused and the file is left exactly as it was.
    const first = await runMain(["--limit", "2"]);
    const file = em.vectorsFile(first.out);
    const torn = readFileSync(file, "utf8") + '{"schema":"mgpl-embedding/1","qid":"Q3"';
    writeFileSync(file, torn);
    writeFileSync(
      path.join(first.dir, "spend-ledger.lock"),
      JSON.stringify({ run_id: "other", entry: ENTRY, pid: 1, at: new Date(NOW).toISOString() }),
    );
    await expect(runMain([], { out: first.out, cat: first.cat, dir: first.dir })).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(torn);
    // With the lock free, the run repairs the file, then embeds the rest.
    rmSync(path.join(first.dir, "spend-ledger.lock"));
    const r = await runMain([], { out: first.out, cat: first.cat, dir: first.dir });
    expect(r.code).toBe(0);
    expect(lines(file).map((x: any) => x.qid)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
  });

  it("stops at once, as cap_reached, when the request cap is used up", async () => {
    const fx = fixtures();
    const r = await runMain(["--batch", "1"], { ...fx, agents: agentsWithEntry(fx.out, "2") });
    expect(r.stub).toHaveBeenCalledTimes(2);
    expect(r.sleep).not.toHaveBeenCalled();
    expect(r.code).toBe(0);
    const led = lines(path.join(r.dir, "spend-ledger.jsonl"));
    expect(led.at(-1)).toMatchObject({ type: "end", status: "cap_reached" });
    expect(lines(em.vectorsFile(r.out))).toHaveLength(2);
  });

  it("records which accepted sample it ran under, without the operator's name", async () => {
    const fx = fixtures();
    const summary = acceptedSummary(fx.out, { accepted_by: "Ada Reviewer" });
    const r = await runMain([], { ...fx, summary });
    expect(r.code).toBe(0);
    const agg = JSON.parse(
      readFileSync(
        path.join(r.out, readdirSync(r.out).find((f) => f.endsWith("aggregate.json")) as string),
        "utf8",
      ),
    );
    expect(agg.sample_check).toEqual({
      summary: path.basename(summary),
      summary_sha256: sha(readFileSync(summary)),
      seed: "t1",
      accepted_at: "2026-10-14T15:00:00Z",
      inputs_order: [
        "enrich-gemini-description-wikipedia.jsonl",
        "enrich-gemini-description-none.jsonl",
      ],
    });
    expect(JSON.stringify(agg) + r.logs.join("\n")).not.toContain("Ada Reviewer");
  });

  it("builds the plan in the order the accepted sample was drawn in", async () => {
    // Q1 has two ok drafts with the same time, one in each file. On a tie the file read later
    // wins, so the order decides which draft is embedded.
    const fx = fixtures();
    const t = "2026-10-14T01:00:00Z";
    const wiki = path.join(fx.out, "enrich-gemini-description-wikipedia.jsonl");
    const none = path.join(fx.out, "enrich-gemini-description-none.jsonl");
    jsonl(wiki, [desc("Q1", "ok", t, "The draft in the wikipedia file.")]);
    jsonl(none, [desc("Q1", "ok", t, "The draft in the none file.")]);
    const label = "Driftwood Lanterns 1";
    // Drawn as none, then wikipedia: the wikipedia draft is the latest.
    const r = await runMain([], { ...fx, summary: acceptedSummary(fx.out, {}, [none, wiki]) });
    expect(r.code).toBe(0);
    expect(lines(em.vectorsFile(r.out))[0].text_sha256).toBe(
      sha(`${label}. The draft in the wikipedia file.`),
    );
    // Drawn as wikipedia, then none: the none draft is the latest.
    const fx2 = fixtures();
    jsonl(path.join(fx2.out, "enrich-gemini-description-wikipedia.jsonl"), [
      desc("Q1", "ok", t, "The draft in the wikipedia file."),
    ]);
    jsonl(path.join(fx2.out, "enrich-gemini-description-none.jsonl"), [
      desc("Q1", "ok", t, "The draft in the none file."),
    ]);
    const r2 = await runMain([], { ...fx2 });
    expect(lines(em.vectorsFile(r2.out))[0].text_sha256).toBe(
      sha(`${label}. The draft in the none file.`),
    );
  });

  it("checks the acceptance against the bytes it embeds, read once", async () => {
    // The summary describes a replacement file; the file is swapped in only after the run has
    // read it. The run must refuse: what it read is not what was accepted.
    const fx = fixtures();
    const none = path.join(fx.out, "enrich-gemini-description-none.jsonl");
    const original = readFileSync(none);
    jsonl(none, [desc("Q2", "ok", "2026-10-14T05:00:00Z", "A replacement draft.")]);
    const replacement = readFileSync(none);
    const summary = acceptedSummary(fx.out);
    writeFileSync(none, original);
    const dir = records();
    await expect(
      runMain([], { ...fx, dir, summary, afterSnapshot: () => writeFileSync(none, replacement) }),
    ).rejects.toThrow(/not the description files read now/);
    expect(existsSync(path.join(dir, "spend-ledger.jsonl"))).toBe(false);
  });

  it("refuses, before opening a run, without the operator's accepted sample check", async () => {
    const cases: Array<[string, (out: string) => string | null, RegExp]> = [
      ["no --sample-summary", () => null, /needs --sample-summary/],
      [
        "not accepted",
        (o) => acceptedSummary(o, { accepted_by: "", accepted_at: "" }),
        /not filled in/,
      ],
      ["accepted_at empty", (o) => acceptedSummary(o, { accepted_at: "" }), /not filled in/],
      ["accepted_by blank", (o) => acceptedSummary(o, { accepted_by: "  " }), /not filled in/],
      ["accepted_at not a date", (o) => acceptedSummary(o, { accepted_at: "soon" }), /not a date/],
      [
        "4 wrong",
        (o) => acceptedSummary(o, { counts: { wrong: 4, unchecked: 0 } }),
        /meet its line/,
      ],
      ["line not met", (o) => acceptedSummary(o, { meets_line: false }), /meet its line/],
      ["99 rows", (o) => acceptedSummary(o, { n: 99 }), /meet its line/],
      ["incomplete", (o) => acceptedSummary(o, { complete: false }), /meet its line/],
      [
        "unchecked rows",
        (o) => acceptedSummary(o, { counts: { wrong: 0, unchecked: 2 } }),
        /meet its line/,
      ],
      ["a friction summary", (o) => acceptedSummary(o, { kind: "friction" }), /not a description/],
      ["another schema", (o) => acceptedSummary(o, { schema: "x" }), /not a description/],
      ["a sheet with a path", (o) => acceptedSummary(o, { sheet: "../x.csv" }), /name its sheet/],
      [
        "the sheet edited after scoring",
        (o) => {
          const f = acceptedSummary(o);
          writeFileSync(f.replace(/\.summary\.json$/, ".csv"), "n,qid,verdict\n1,Q1,wrong\n");
          return f;
        },
        /sheet changed/,
      ],
      [
        "the meta file edited after scoring",
        (o) => {
          const f = acceptedSummary(o);
          writeFileSync(f.replace(/\.summary\.json$/, ".meta.json"), "{}\n");
          return f;
        },
        /meta file changed/,
      ],
      [
        "a draft file changed after the sample was drawn",
        (o) => {
          const f = acceptedSummary(o);
          jsonl(path.join(o, "enrich-gemini-description-none.jsonl"), [
            desc("Q2", "ok", "2026-10-14T05:00:00Z", "A later draft."),
          ]);
          return f;
        },
        /not the description files read now/,
      ],
      [
        "a summary of only one of the files",
        (o) => acceptedSummary(o, {}, descFiles(o).slice(0, 1)),
        /not the description files read now/,
      ],
      [
        "one file listed twice",
        (o) => acceptedSummary(o, {}, [descFiles(o)[0], descFiles(o)[0]]),
        /not the description files read now/,
      ],
      ["a missing summary", (o) => path.join(o, "nowhere.summary.json"), /cannot be read/],
    ];
    for (const [name, make, err] of cases) {
      const fx = fixtures();
      const dir = records();
      await expect(runMain([], { ...fx, dir, summary: make(fx.out) }), name).rejects.toThrow(err);
      expect(existsSync(path.join(dir, "spend-ledger.jsonl")), name).toBe(false);
      expect(existsSync(em.vectorsFile(fx.out)), name).toBe(false);
    }
  });

  it("counts an answer with no billable count at its bound", async () => {
    const r = await runMain([], { stub: stubVertex({ noMetadata: true }) });
    const led = lines(path.join(r.dir, "spend-ledger.jsonl"));
    expect(led.find((l: any) => l.type === "result").outcome).toBe("unpriceable");
  });

  it("refuses an output folder the entry does not name, or one inside the repository", async () => {
    const fx = fixtures();
    await expect(
      runMain([], { out: fx.out, cat: fx.cat, agents: agentsWithEntry(tmp("elsewhere-")) }),
    ).rejects.toThrow(/output location entry/);
    await expect(
      em.main(["--run", "--entry", ENTRY, "--reserve", "1", "--out", path.join(ROOT, "test")], {}),
    ).rejects.toThrow(/outside the repository/);
  });

  it("refuses a reserve above the cap or the entry's headroom", async () => {
    await expect(runMain(["--reserve", "6"])).rejects.toThrow(/at most 5/);
    const fx = fixtures();
    await expect(
      runMain(["--reserve", "2"], {
        out: fx.out,
        cat: fx.cat,
        agents: agentsWithEntry(fx.out, "3000", "$1"),
      }),
    ).rejects.toThrow(/has \$1 left/);
  });

  it("dry run: sends nothing, writes nothing and repairs nothing", async () => {
    const fx = fixtures();
    const file = em.vectorsFile(fx.out);
    writeFileSync(file, '{"schema":"mgpl-embedding/1","qid":"Q1"');
    const before = readFileSync(file, "utf8");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => {
      logs.push(s);
    });
    const code = await em.main(["--out", fx.out], { catalogue: fx.cat });
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(fx.out).sort()).toEqual([
      "embed-descriptions-text-embedding-005-768.jsonl",
      "enrich-gemini-description-none.jsonl",
      "enrich-gemini-description-wikipedia.jsonl",
    ]);
  });

  it("WU-034: handles title, friction, and genre modes, whole-QID title skips, and pre-override hashes", () => {
    const out = tmp("embed-wu034-");
    expect(path.basename(em.vectorsFile(out, "description"))).toBe(
      "embed-descriptions-text-embedding-005-768.jsonl",
    );
    expect(path.basename(em.vectorsFile(out, "title"))).toBe(
      "embed-descriptions-title-text-embedding-005-768.jsonl",
    );
    expect(path.basename(em.vectorsFile(out, "friction"))).toBe(
      "embed-descriptions-friction-text-embedding-005-768.jsonl",
    );
    expect(path.basename(em.vectorsFile(out, "genre"))).toBe(
      "embed-descriptions-genre-text-embedding-005-768.jsonl",
    );
    const cat = tmp("embed-cat-wu034-");
    jsonl(path.join(cat, "wikidata.jsonl"), [
      { qid: "Q10", label: "Beta" },
      { qid: "Q2", label: "Alpha" },
      { qid: "Q3", label: "Oversized" },
    ]);
    jsonl(path.join(cat, "wikidata-xids.jsonl"), [
      { qid: "Q2", aliases: ["Zed", "Alpha", "  "] },
      { qid: "Q3", aliases: ["x".repeat(80_001)] },
    ]);
    const titles = em.buildTitleItems(cat);
    expect(titles.too_long).toBe(1);
    expect(titles.items.map((x: any) => `${x.qid}:${x.text}`)).toEqual([
      "Q2:Alpha\nZed",
      "Q10:Beta",
    ]);
  });
});
