// Task proposal 033, WU-033a: the hand sample check of generated catalogue drafts.
// Invented records only; no network and no real drafts.
// cspell:words wikidata jsonl Wilson
import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let m: any;
const tmp: string[] = [];
beforeAll(async () => {
  m = await import("../../scripts/catalogue/sample-check.mjs");
});
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "mgpl-sample-"));
  tmp.push(d);
  return d;
};

const rec = (qid: string, status: string, at: string, extra: Record<string, unknown> = {}) => ({
  schema: "mgpl-enrichment/1",
  qid,
  task: "description",
  status,
  label: "generated",
  generated: { description: status === "ok" ? `Draft for ${qid} at ${at}.` : null },
  inputs: {
    wikidata: `https://www.wikidata.org/w/index.php?title=${qid}&oldid=1`,
    steam: "https://store.steampowered.com/app/10/",
    wikipedia: null,
  },
  run_id: "run-a",
  attempt_id: "run-a:1",
  at,
  ...extra,
});
const jsonl = (file: string, records: unknown[]) =>
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
const many = (count: number) =>
  Array.from({ length: count }, (_, i) => rec(`Q${i + 1}`, "ok", "2026-10-13T20:00:00Z"));

describe("latestOk", () => {
  it("keeps the latest record per game across files, then only ok ones", () => {
    const a = [
      rec("Q1", "ok", "2026-10-13T10:00:00Z"),
      rec("Q2", "rejected", "2026-10-13T10:00:00Z"),
    ];
    const b = [
      rec("Q1", "rejected", "2026-10-13T11:00:00Z"),
      rec("Q2", "ok", "2026-10-13T11:00:00Z"),
      rec("Q3", "insufficient", "2026-10-13T11:00:00Z"),
    ];
    const ok = m.latestOk([a, b], "description");
    expect([...ok.keys()]).toEqual(["Q2"]);
    expect(ok.get("Q2").generated.description).toContain("11:00");
  });
  it("on equal times, the record read later wins", () => {
    const t = "2026-10-13T10:00:00Z";
    const ok = m.latestOk(
      [[rec("Q1", "ok", t)], [{ ...rec("Q1", "ok", t), generated: { description: "later" } }]],
      "description",
    );
    expect(ok.get("Q1").generated.description).toBe("later");
  });
  it("ignores other kinds and refuses unknown schemas, kinds and empty drafts", () => {
    expect(m.latestOk([[{ ...rec("Q1", "ok", "t"), task: "genre" }]], "description").size).toBe(0);
    expect(() => m.latestOk([[{ ...rec("Q1", "ok", "t"), schema: "x" }]], "description")).toThrow(
      m.SampleCheckError,
    );
    expect(() => m.latestOk([[]], "summary")).toThrow(/unknown kind/);
    expect(() =>
      m.latestOk([[{ ...rec("Q1", "ok", "t"), generated: { description: " " } }]], "description"),
    ).toThrow(/no text/);
    expect(() =>
      m.latestOk([[{ ...rec("Q1", "ok", "t"), label: "sourced" }]], "description"),
    ).toThrow(/generated/);
  });
  it("uses canonical JSON for friction and genre drafts", () => {
    const r = { ...rec("Q1", "ok", "t"), task: "genre", generated: { b: 1, a: { d: 2, c: 3 } } };
    expect(m.draftText(r, "genre")).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("drawSample", () => {
  const items = Array.from({ length: 500 }, (_, i) => `Q${i + 1}`);
  it("is repeatable for a seed and differs between seeds", () => {
    const a = m.drawSample(items, 100, "s1");
    expect(m.drawSample(items, 100, "s1")).toEqual(a);
    expect(m.drawSample(items, 100, "s2")).not.toEqual(a);
    expect(new Set(a).size).toBe(100);
    expect(a.every((q: string) => items.includes(q))).toBe(true);
  });
  it("draws a pinned order for a pinned seed, and can pick any item first", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `Q${i + 1}`);
    expect(m.drawSample(ten, 10, "golden")).toEqual([
      "Q5",
      "Q6",
      "Q10",
      "Q1",
      "Q4",
      "Q8",
      "Q3",
      "Q7",
      "Q2",
      "Q9",
    ]);
    const firsts = new Set();
    for (let s = 0; s < 200; s++) firsts.add(m.drawSample(["Q1", "Q2", "Q3"], 1, `s${s}`)[0]);
    expect([...firsts].sort()).toEqual(["Q1", "Q2", "Q3"]);
  });
  it("uses the first 52 bits of SHA-256(seed:index)", () => {
    for (const [seed, i] of [
      ["s", 0],
      ["golden", 7],
      ["t1", 99],
    ] as const) {
      const hex = createHash("sha256").update(`${seed}:${i}`).digest("hex").slice(0, 13);
      expect(m.seededUnit(seed, i)).toBe(Number(BigInt(`0x${hex}`)) / 2 ** 52);
    }
  });
  it("gives units in [0, 1)", () => {
    for (let i = 0; i < 1000; i++) {
      const u = m.seededUnit("s", i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
  it("refuses too few items, a bad n and a bad seed", () => {
    expect(() => m.drawSample(items.slice(0, 5), 6, "s")).toThrow(/fewer than/);
    expect(() => m.drawSample(items, 0, "s")).toThrow(/above 0/);
    expect(() => m.drawSample(items, 5, "a b")).toThrow(/seed/);
  });
});

describe("CSV", () => {
  it("round-trips quotes, commas, newlines and non-ASCII text", () => {
    const rows = [
      ["a", 'say "hi", then go', "line1\nline2", "Pokémon ✓"],
      ["", "x", "y", "z"],
    ];
    const text = m.toCsv(rows);
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(m.parseCsv(text)).toEqual(rows);
    expect(m.parseCsv(text.replace(/\r\n/g, "\n"))).toEqual(rows);
  });
  it("defuses cells a spreadsheet would read as formulas", () => {
    expect(m.parseCsv(m.toCsv([["=SUM(A1)", "+1", "-x", "@y", "ok"]]))).toEqual([
      ["'=SUM(A1)", "'+1", "'-x", "'@y", "ok"],
    ]);
  });
  it("reads unquoted cells as a spreadsheet saves them", () => {
    expect(m.parseCsv("n,verdict\r\n1,correct\r\n2,\r\n")).toEqual([
      ["n", "verdict"],
      ["1", "correct"],
      ["2", ""],
    ]);
    expect(() => m.parseCsv('"open')).toThrow(/quoted/);
  });
});

describe("wilson", () => {
  it("matches known 95% intervals", () => {
    expect(m.wilson(0, 100)).toEqual({ low: 0, high: 0.037 });
    expect(m.wilson(2, 100).high).toBeCloseTo(0.07, 3);
    expect(m.wilson(5, 100).high).toBeCloseTo(0.1118, 3);
    expect(m.wilson(0, 0)).toBeNull();
  });
});

function drawn(count = 150, extra: Record<string, unknown> = {}) {
  const d = dir();
  const a = path.join(d, "run.jsonl");
  jsonl(a, many(count));
  const out = path.join(d, "review");
  const r = m.draw({
    kind: "description",
    inputs: [a],
    seed: "t1",
    out,
    now: new Date("2026-10-14T00:00:00Z"),
    ...extra,
  });
  return { d, a, out, r, csv: path.join(out, "sample-description-t1.csv") };
}
function fill(csv: string, verdicts: (n: number) => string) {
  const t = m.parseCsv(readFileSync(csv, "utf8"));
  const vi = t[0].indexOf("verdict");
  for (let i = 1; i < t.length; i++) t[i][vi] = verdicts(i);
  writeFileSync(csv, m.toCsv(t));
}

describe("draw", () => {
  it("writes the sheet, the page and the meta file, with matching hashes", () => {
    const { out, r, a } = drawn();
    expect(r).toEqual({
      eligible: 150,
      files: [
        "sample-description-t1.csv",
        "sample-description-t1.html",
        "sample-description-t1.meta.json",
      ],
    });
    const meta = JSON.parse(
      readFileSync(path.join(out, "sample-description-t1.meta.json"), "utf8"),
    );
    expect(meta.n).toBe(100);
    expect(meta.inputs[0].sha256).toBe(m.sha256(readFileSync(a)));
    const t = m.parseCsv(readFileSync(path.join(out, "sample-description-t1.csv"), "utf8"));
    expect(t[0]).toEqual([...m.SHEET_COLUMNS]);
    expect(t.length).toBe(101);
    const c = (name: string) => t[0].indexOf(name);
    for (let i = 1; i <= 100; i++) {
      expect(t[i][c("qid")]).toBe(meta.rows[i - 1].qid);
      expect(t[i][c("text_sha256")]).toBe(m.sha256(t[i][c("draft")]));
      expect(t[i][c("verdict")]).toBe("");
    }
  });
  it("takes titles from the Wikidata file when given", () => {
    const d = dir();
    const w = path.join(d, "wikidata.jsonl");
    jsonl(
      w,
      Array.from({ length: 150 }, (_, i) => ({ qid: `Q${i + 1}`, label: `Game ${i + 1}` })),
    );
    const { csv } = drawn(150, { titles: w });
    const t = m.parseCsv(readFileSync(csv, "utf8"));
    expect(t[1][2]).toBe(`Game ${t[1][1].slice(1)}`);
  });
  it("never overwrites, and refuses an output folder inside the repository", () => {
    const { a, out } = drawn();
    expect(() => m.draw({ kind: "description", inputs: [a], seed: "t1", out })).toThrow(
      /already exists; use another seed/,
    );
    expect(() =>
      m.draw({
        kind: "description",
        inputs: [a],
        seed: "t9",
        out: path.join(process.cwd(), "test"),
      }),
    ).toThrow(/outside the repository/);
    const never = path.join(process.cwd(), "test", "sample-check-never-made");
    expect(() => m.draw({ kind: "description", inputs: [a], seed: "t9", out: never })).toThrow(
      /outside the repository/,
    );
    expect(existsSync(never)).toBe(false);
    const d = dir();
    const link = path.join(d, "to-repo");
    symlinkSync(path.join(process.cwd(), "test"), link, "junction");
    const via = path.join(link, "sample-check-never-made-2");
    expect(() => m.draw({ kind: "description", inputs: [a], seed: "t9", out: via })).toThrow(
      /outside the repository/,
    );
    expect(existsSync(path.join(process.cwd(), "test", "sample-check-never-made-2"))).toBe(false);
  });
  it("escapes the drafts in the page and links only https sources", () => {
    const d = dir();
    const a = path.join(d, "x.jsonl");
    const bad = many(3).map((r) => ({
      ...r,
      generated: { description: '<script>alert("x")</script>' },
      inputs: {
        wikidata: "javascript:alert(1)",
        steam: "https://store.steampowered.com/app/1/",
        wikipedia: null,
      },
    }));
    jsonl(a, bad);
    m.draw({ kind: "description", inputs: [a], seed: "h", n: 3, out: path.join(d, "o") });
    const html = readFileSync(path.join(d, "o", "sample-description-h.html"), "utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://store.steampowered.com/app/1/"');
  });
});

describe("score", () => {
  it("counts verdicts, computes the interval and leaves acceptance empty", () => {
    const { csv, out } = drawn();
    fill(csv, (i) => (i <= 2 ? "wrong" : i <= 4 ? "Minor " : i === 5 ? "unverifiable" : "correct"));
    const s = m.score({ sheet: csv, now: new Date("2026-10-15T00:00:00Z") });
    expect(s.counts).toEqual({ correct: 95, minor: 2, wrong: 2, unverifiable: 1, unchecked: 0 });
    expect(s.checked).toBe(99);
    expect(s.error_rate).toBe(0.0202);
    expect(s.complete).toBe(true);
    expect(s.meets_line).toBe(true);
    expect(s.accepted_by).toBe("");
    expect(s.sheet_sha256).toBe(m.sha256(readFileSync(csv)));
    expect(existsSync(path.join(out, "sample-description-t1.summary.json"))).toBe(true);
  });
  it("meets the line only with every row given a verdict and at most 3 wrong", () => {
    const { csv } = drawn();
    fill(csv, (i) => (i === 1 ? "" : "correct"));
    expect(m.score({ sheet: csv }).meets_line).toBe(false);
    fill(csv, (i) => (i <= 4 ? "wrong" : "correct"));
    expect(m.score({ sheet: csv }).meets_line).toBe(false);
    fill(csv, (i) => (i <= 3 ? "wrong" : i <= 40 ? "unverifiable" : "correct"));
    const s = m.score({ sheet: csv });
    expect(s.meets_line).toBe(true);
    expect(s.counts.unverifiable).toBe(37);
    expect(s.checked).toBe(63);
    expect(s.line).toEqual({ of: 100, max_wrong: 3 });
  });
  it("refuses an unknown verdict, an altered row or a changed row count", () => {
    const { csv } = drawn();
    fill(csv, (i) => (i === 7 ? "ok" : "correct"));
    expect(() => m.score({ sheet: csv })).toThrow(/row 7 has a verdict/);
    const t = m.parseCsv(readFileSync(csv, "utf8"));
    t[3][t[0].indexOf("text_sha256")] = "0".repeat(64);
    writeFileSync(csv, m.toCsv(t));
    expect(() => m.score({ sheet: csv })).toThrow(/row 3 does not match/);
    const u = m.parseCsv(readFileSync(csv, "utf8"));
    u[3][u[0].indexOf("text_sha256")] = t[3][t[0].indexOf("text_sha256")];
    u[3][u[0].indexOf("text_sha256")] = m.sha256(u[3][u[0].indexOf("draft")]);
    u[3][u[0].indexOf("draft")] = "A different draft, with the hash cell left as drawn.";
    writeFileSync(csv, m.toCsv(u));
    expect(() => m.score({ sheet: csv })).toThrow(/row 3 does not match/);
    writeFileSync(csv, m.toCsv(t.slice(0, 50)));
    expect(() => m.score({ sheet: csv })).toThrow(/row count/);
  });
  it("accepts a draft the sheet defused with an apostrophe", () => {
    const d = dir();
    const a = path.join(d, "x.jsonl");
    jsonl(
      a,
      many(3).map((r) => ({ ...r, generated: { description: `-${r.qid} starts with a dash.` } })),
    );
    m.draw({ kind: "description", inputs: [a], seed: "f", n: 3, out: path.join(d, "o") });
    const csv = path.join(d, "o", "sample-description-f.csv");
    expect(readFileSync(csv, "utf8")).toContain(`"'-Q`);
    fill(csv, () => "correct");
    expect(m.score({ sheet: csv }).counts.correct).toBe(3);
    expect(m.draftMatches("'plain", m.sha256("plain"))).toBe(false);
  });
  it("refuses a sheet inside the repository and a summary that is not a plain file", () => {
    const { csv, out } = drawn();
    fill(csv, () => "correct");
    const inRepo = mkdtempSync(path.join(process.cwd(), "test", ".sample-check-"));
    tmp.push(inRepo);
    const copy = path.join(inRepo, "sample-description-t1.csv");
    copyFileSync(csv, copy);
    copyFileSync(
      path.join(out, "sample-description-t1.meta.json"),
      copy.replace(/\.csv$/, ".meta.json"),
    );
    expect(() => m.score({ sheet: copy })).toThrow(/outside the repository/);
    expect(existsSync(copy.replace(/\.csv$/, ".summary.json"))).toBe(false);
    mkdirSync(path.join(out, "sample-description-t1.summary.json"));
    expect(() => m.score({ sheet: csv })).toThrow(/not a plain file/);
  });
  it("refuses a dangling link at the summary path and never creates its target", () => {
    const { csv, out } = drawn();
    fill(csv, () => "correct");
    const target = path.join(dir(), "elsewhere", "made-through-link.json");
    mkdirSync(path.dirname(target));
    symlinkSync(target, path.join(out, "sample-description-t1.summary.json"));
    expect(m.entryKind(path.join(out, "sample-description-t1.summary.json"))).toBe("link");
    expect(() => m.score({ sheet: csv })).toThrow(/not a plain file/);
    expect(existsSync(target)).toBe(false);
  });
  it("replaces an unaccepted plain summary and leaves no temporary file", () => {
    const { csv, out } = drawn();
    fill(csv, () => "correct");
    m.score({ sheet: csv });
    fill(csv, (i) => (i === 1 ? "wrong" : "correct"));
    expect(m.score({ sheet: csv }).counts.wrong).toBe(1);
    expect(readdirSync(out).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("never replaces an accepted summary", () => {
    const { csv, out } = drawn();
    fill(csv, () => "correct");
    m.score({ sheet: csv });
    const f = path.join(out, "sample-description-t1.summary.json");
    const s = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...s, accepted_by: "Principal Operator" }));
    expect(() => m.score({ sheet: csv })).toThrow(/already accepted/);
    expect(JSON.parse(readFileSync(f, "utf8")).accepted_by).toBe("Principal Operator");
  });
});

describe("main", () => {
  it("prints counts and file names, never a draft", () => {
    const d = dir();
    const a = path.join(d, "run.jsonl");
    jsonl(a, many(120));
    const b = path.join(d, "fill.jsonl");
    jsonl(b, [rec("Q500", "ok", "2026-10-14T00:00:00Z")]);
    const lines: string[] = [];
    const out = path.join(d, "o");
    m.main(
      ["draw", "--kind", "description", "--in", a, "--in", b, "--seed", "m1", "--out", out],
      (s: string) => lines.push(s),
    );
    const csv = path.join(out, "sample-description-m1.csv");
    fill(csv, () => "correct");
    m.main(["score", "--sheet", csv], (s: string) => lines.push(s));
    expect(lines.join("\n")).not.toContain("Draft for");
    expect(lines[0]).toContain("eligible 121");
    expect(lines[1]).toContain("correct 100");
  });
  it("refuses unknown commands and options", () => {
    expect(() => m.main(["sample"])).toThrow(/draw or score/);
    expect(() => m.main(["draw", "--bogus", "1"])).toThrow(/unknown/);
    expect(() => m.main(["draw", "--seed", "a", "--seed", "b"])).toThrow(/twice/);
    expect(() => m.main(["draw", "--kind", "description", "--seed", "a"])).toThrow(
      /--out is required/,
    );
  });
});
