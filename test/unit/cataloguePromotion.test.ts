// Task proposal 033, WU-033b: the Catalogue* tables and their reviewed promotion.
// Invented records only; no network, no real catalogue data and no app database.
// cspell:words wikidata jsonl qids oldid licence
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applySteamFacts,
  canonicalJson,
  CATALOGUE_FACT_FIELDS,
  CataloguePromotionError,
  FRICTION_VALUES,
  GENRE_VALUES,
  latestDrafts,
  promoteCatalogueDrafts,
  promoteCatalogueFacts,
  SAMPLE_LINE,
} from "../../src/services/enrichmentPromotion";
import { main, parseArgs } from "../../scripts/catalogue/promote-catalogue";

let sc: any;
let enrich: any;
let agreement: any;
beforeAll(async () => {
  sc = await import("../../scripts/catalogue/sample-check.mjs");
  enrich = await import("../../scripts/catalogue/enrich-gemini.mjs");
  agreement = await import("../../scripts/catalogue/agreement.mjs");
});

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "mgpl-promote-"));
  tmp.push(d);
  return d;
};
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const jsonl = (file: string, records: unknown[]) =>
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const DB_SOURCE = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");
const TABLES = ["CatalogueGames", "CatalogueFacts", "CatalogueDrafts"] as const;
function ddl(table: string) {
  const s = DB_SOURCE.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`),
  )?.[0];
  if (!s) throw new Error(`no ${table} DDL in src/db.ts`);
  return s;
}
function catalogueDb(file = ":memory:") {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec(TABLES.map(ddl).join("\n"));
  return db;
}
const count = (db: Database.Database, sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

// --- Fixtures ---------------------------------------------------------------

const N = 130;
const qid = (i: number) => `Q${i + 1}`;
const wdUrl = (q: string) => `https://www.wikidata.org/w/index.php?title=${q}&oldid=7`;
const steamUrl = (id: number) => `https://store.steampowered.com/app/${id}/`;
const wikidataRec = (i: number) => ({
  qid: qid(i),
  revision: 7,
  label: `Game ${i + 1}`,
  steam_app_ids: [String(1000 + i)],
  source: {
    name: "wikidata",
    licence: "CC0-1.0",
    url: `https://www.wikidata.org/wiki/${qid(i)}`,
    revision_url: wdUrl(qid(i)),
    fetched_at: "2026-10-10T00:00:00Z",
  },
});
const src = (i: number) => [
  { name: "wikidata", url: wdUrl(qid(i)), fetched_at: "2026-10-10T00:00:00Z" },
  { name: "steam", url: steamUrl(1000 + i), fetched_at: "2026-10-10T00:00:00Z" },
];
const field = (status: string, value: unknown, i: number, basis: unknown = "equal") => ({
  status,
  value,
  sources: status === "agree" ? src(i) : src(i).slice(0, 1),
  values: {},
  ...(status === "agree" ? { basis } : {}),
});
const agreementRec = (i: number, over: Record<string, unknown> = {}) => ({
  qid: qid(i),
  steam_appid: 1000 + i,
  fields: {
    title: field("agree", `Game ${i + 1}`, i),
    release_date: field(i % 2 ? "agree" : "conflict", "2001-02-03", i, "release event Q1406"),
    developers: field("agree", ["Studio"], i, [{ steam: "Studio", wikidata: "Q5" }]),
    publishers: field("single", null, i),
    platforms: field("partial", ["windows"], i),
    ...over,
  },
  store: null,
  context: {},
});
const FRICTION_OK = {
  save_system: "checkpoints",
  time_between_saves: "5_to_15_min",
  suspend_friendly: "yes",
  session_loop: "15_to_45_min",
  cognitive_load: "medium",
  third_party_launcher: "no",
  always_online: "no",
};
const GENRE_OK = {
  ...Object.fromEntries(Object.keys(GENRE_VALUES).map((k) => [k, "no"])),
  primary_genre: "Puzzle",
};
const generatedFor = (kind: string, i: number) =>
  kind === "description"
    ? { description: `A drafted description of game ${i + 1}.` }
    : kind === "friction"
      ? { ...FRICTION_OK }
      : { ...GENRE_OK };
const draft = (
  kind: string,
  i: number,
  status = "ok",
  at = "2026-10-13T10:00:00Z",
  extra = {},
) => ({
  schema: "mgpl-enrichment/1",
  qid: qid(i),
  steam_appid: String(1000 + i),
  task: kind,
  status,
  label: "generated",
  generated: status === "ok" ? generatedFor(kind, i) : null,
  ...(kind === "friction"
    ? {
        sourced: {
          save_anytime: i === 0 ? true : null,
          steam_cloud: true,
          note: "Steam's own store categories",
          source: steamUrl(1000 + i),
        },
      }
    : {}),
  inputs: { wikidata: wdUrl(qid(i)), steam: steamUrl(1000 + i), wikipedia: null },
  model: "gemini-3.1-flash-lite",
  prompt_version: "s3-v1",
  run_id: "run-a",
  attempt_id: "run-a:1",
  at,
  ...extra,
});

type Fixture = {
  d: string;
  wikidata: string;
  agreement: string;
  drafts: string[];
  summary: string;
  sheet: string;
};
/**
 * Writes the catalogue files, two draft files (a first pass in which the last ten games are
 * rejected, and a fill pass for five of them), draws a sample with sample-check.mjs, marks
 * every row `correct` (or as given), scores it and, unless told not to, accepts it.
 */
function fixture(
  kind = "description",
  opts: { wrong?: number; accept?: boolean; firstExtra?: Record<string, unknown> } = {},
): Fixture {
  const d = dir();
  const wikidata = path.join(d, "wikidata.jsonl");
  const agreementFile = path.join(d, "agreement.jsonl");
  jsonl(
    wikidata,
    Array.from({ length: N }, (_, i) => wikidataRec(i)),
  );
  jsonl(
    agreementFile,
    Array.from({ length: N }, (_, i) => agreementRec(i)),
  );
  const first = path.join(d, `${kind}-a.jsonl`);
  const fill = path.join(d, `${kind}-b.jsonl`);
  jsonl(
    first,
    Array.from({ length: N }, (_, i) =>
      draft(
        kind,
        i,
        i >= N - 10 ? "rejected" : "ok",
        "2026-10-13T10:00:00Z",
        i === 0 ? (opts.firstExtra ?? {}) : {},
      ),
    ),
  );
  jsonl(
    fill,
    [0, 1, 2, 3, 4].map((k) => draft(kind, N - 10 + k, "ok", "2026-10-14T10:00:00Z")),
  );
  const drew = sc.draw({ kind, inputs: [first, fill], seed: "t1", out: d, titles: wikidata });
  const sheet = path.join(d, drew.files[0]);
  const table = sc.parseCsv(readFileSync(sheet, "utf8"));
  const v = table[0].indexOf("verdict");
  table.slice(1).forEach((row: string[], i: number) => {
    row[v] = i < (opts.wrong ?? 0) ? "wrong" : "correct";
  });
  writeFileSync(sheet, sc.toCsv(table));
  sc.score({ sheet });
  const summary = sheet.replace(/\.csv$/, ".summary.json");
  if (opts.accept !== false) accept(summary);
  return { d, wikidata, agreement: agreementFile, drafts: [first, fill], summary, sheet };
}
function accept(summary: string, by = "Principal Operator", at = "2026-10-14T15:00:00Z") {
  const s = JSON.parse(readFileSync(summary, "utf8"));
  writeFileSync(
    summary,
    `${JSON.stringify({ ...s, accepted_by: by, accepted_at: at }, null, 2)}\n`,
  );
}
function editSummary(summary: string, edit: (s: any) => void) {
  const s = JSON.parse(readFileSync(summary, "utf8"));
  edit(s);
  writeFileSync(summary, JSON.stringify(s));
}
const NOW = new Date("2026-10-14T16:00:00Z");
const loadFacts = (db: Database.Database, f: Fixture) =>
  promoteCatalogueFacts(db, {
    wikidataFile: f.wikidata,
    agreementFile: f.agreement,
    reviewConfirmed: true,
    now: NOW,
  });
const promote = (db: Database.Database, f: Fixture, kind: any = "description", over = {}) =>
  promoteCatalogueDrafts(db, {
    kind,
    draftFiles: f.drafts,
    summaryFile: f.summary,
    reviewConfirmed: true,
    now: NOW,
    ...over,
  });

// --- Schema -----------------------------------------------------------------

describe("the Catalogue* tables in src/db.ts", () => {
  it("are listed in AUTHORITATIVE_TABLES with exactly the DDL's columns", () => {
    const db = catalogueDb();
    for (const t of TABLES) {
      const block = DB_SOURCE.match(new RegExp(`\\n  ${t}: \\{([\\s\\S]*?)\\n  \\},`))?.[1];
      expect(block, t).toBeTruthy();
      const listed = [...(block as string).matchAll(/^\s+(\w+): "/gm)].map((x) => x[1]);
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(listed, t).toEqual(cols);
    }
    db.close();
  });
  it("refuse a malformed QID, a non-generated label, an unknown kind and an orphan row", () => {
    const db = catalogueDb();
    const game = db.prepare(
      "INSERT INTO CatalogueGames (qid, title, steam_appid, wikidata_url, loaded_at) VALUES (?, 't', NULL, 'u', 'n')",
    );
    for (const bad of ["Q0", "Q12a", "q12", "Q", "12"])
      expect(() => game.run(bad), bad).toThrow(/CHECK/);
    game.run("Q12");
    const ins = db.prepare(
      `INSERT INTO CatalogueDrafts (qid, kind, value, label, text_sha256, links, model,
       prompt_version, drafted_at, sample_summary_sha256, sample_seed, accepted_by, promoted_at)
       VALUES (?, ?, '{}', ?, 'h', '{}', 'm', 'p', 'a', 's', 'seed', 'op', 'n')`,
    );
    expect(() => ins.run("Q12", "description", "sourced")).toThrow(/CHECK/);
    expect(() => ins.run("Q12", "summary", "generated")).toThrow(/CHECK/);
    expect(() => ins.run("Q13", "description", "generated")).toThrow(/FOREIGN KEY/);
    ins.run("Q12", "description", "generated");
    db.close();
  });
});

describe("constants shared with the catalogue scripts", () => {
  it("match enrich-gemini.mjs, sample-check.mjs and agreement.mjs", () => {
    expect(FRICTION_VALUES).toEqual(enrich.FRICTION_OPTIONS);
    expect(Object.keys(GENRE_VALUES)).toEqual([...enrich.GENRE_FLAGS, "primary_genre"]);
    for (const f of enrich.GENRE_FLAGS) expect(GENRE_VALUES[f]).toEqual(["yes", "no", "unknown"]);
    expect(GENRE_VALUES.primary_genre).toEqual(enrich.PRIMARY_GENRES);
    expect(SAMPLE_LINE).toEqual(sc.ACCEPTANCE_LINE);
    expect([...CATALOGUE_FACT_FIELDS]).toEqual(agreement.FIELDS);
  });
  it("canonicalJson and latestDrafts agree with sample-check.mjs", () => {
    const v = { b: [1, { d: 2, c: "é" }], a: null };
    expect(canonicalJson(v)).toBe(sc.canonicalJson(v));
    const a = [draft("genre", 0), draft("genre", 1, "rejected"), draft("description", 2)];
    const b = [
      draft("genre", 0, "insufficient", "2026-10-14T00:00:00Z"),
      draft("genre", 1, "ok", "2026-10-13T10:00:00Z"),
    ];
    const ours = [...latestDrafts([a, b], "genre")].filter(([, r]) => r.status === "ok");
    expect(ours.map(([q]) => q)).toEqual([...sc.latestOk([a, b], "genre").keys()]);
    expect(ours.map(([q]) => q)).toEqual(["Q2"]);
  });
});

// --- Facts ------------------------------------------------------------------

describe("promoteCatalogueFacts", () => {
  it("loads every game and only the agree fields, with basis and source links", () => {
    const f = fixture();
    const db = catalogueDb();
    const r = loadFacts(db, f);
    expect(r).toMatchObject({ games: N, items_compared: N });
    expect(r.per_field).toEqual({
      title: N,
      release_date: N / 2,
      developers: N,
      publishers: 0,
      platforms: 0,
    });
    expect(count(db, "SELECT count(*) n FROM CatalogueFacts")).toBe(N * 2 + N / 2);
    expect(db.prepare("SELECT * FROM CatalogueGames WHERE qid = 'Q2'").get()).toEqual({
      qid: "Q2",
      title: "Game 2",
      steam_appid: "1001",
      wikidata_url: wdUrl("Q2"),
      loaded_at: NOW.toISOString(),
    });
    const fact = db
      .prepare("SELECT * FROM CatalogueFacts WHERE qid = 'Q2' AND field = 'developers'")
      .get() as any;
    expect(JSON.parse(fact.value)).toEqual(["Studio"]);
    expect(JSON.parse(fact.basis)).toEqual([{ steam: "Studio", wikidata: "Q5" }]);
    expect(JSON.parse(fact.sources)).toEqual(src(1));
    expect(
      count(db, "SELECT count(*) n FROM CatalogueFacts WHERE field IN ('publishers', 'platforms')"),
    ).toBe(0);
    db.close();
  });
  it("replaces an item's facts on reload, and leaves items not in the files alone", () => {
    const f = fixture();
    const db = catalogueDb();
    loadFacts(db, f);
    db.prepare(
      "INSERT INTO CatalogueGames (qid, title, steam_appid, wikidata_url, loaded_at) VALUES ('Q999', 'Kept', NULL, 'u', 'n')",
    ).run();
    db.prepare(
      "INSERT INTO CatalogueFacts (qid, field, value, basis, sources, loaded_at) VALUES ('Q999', 'title', '\"Kept\"', NULL, '[]', 'n')",
    ).run();
    jsonl(f.agreement, [
      agreementRec(1, { title: field("conflict", null, 1) }),
      ...Array.from({ length: N - 2 }, (_, i) => agreementRec(i + 2)),
    ]);
    const r = loadFacts(db, f);
    expect(r.items_compared).toBe(N - 1);
    expect(
      count(db, "SELECT count(*) n FROM CatalogueFacts WHERE qid = 'Q2' AND field = 'title'"),
    ).toBe(0);
    expect(count(db, "SELECT count(*) n FROM CatalogueFacts WHERE qid = 'Q2'")).toBe(2);
    expect(count(db, "SELECT count(*) n FROM CatalogueFacts WHERE qid = 'Q1'")).toBe(2);
    expect(count(db, "SELECT count(*) n FROM CatalogueFacts WHERE qid = 'Q999'")).toBe(1);
    expect(count(db, "SELECT count(*) n FROM CatalogueGames")).toBe(N + 1);
    db.close();
  });
  it("refuses, and writes nothing, on any bad input", () => {
    const f = fixture();
    // Replaces Q4's agreement record, so only the damage is new.
    const swap = (r: unknown) =>
      jsonl(
        f.agreement,
        Array.from({ length: N }, (_, i) => (i === 3 ? r : agreementRec(i))),
      );
    const cases: Array<[string, () => void, RegExp]> = [
      ["no review", () => {}, /review confirmation/],
      [
        "agreement item not in Wikidata",
        () => appendFileSync(f.agreement, JSON.stringify(agreementRec(N + 5)) + "\n"),
        /not in the Wikidata file/,
      ],
      [
        "not JSON",
        () => appendFileSync(f.agreement, "{oops\n"),
        /agreement.jsonl: line \d+ is not JSON/,
      ],
      [
        "duplicate item",
        () => appendFileSync(f.agreement, JSON.stringify(agreementRec(3)) + "\n"),
        /twice/,
      ],
      [
        "a source on another host",
        () =>
          swap(
            agreementRec(3, {
              title: {
                ...field("agree", "x", 3),
                sources: [{ name: "x", url: "https://example.com/a" }],
              },
            }),
          ),
        /not an allowed source link/,
      ],
      [
        "an agree field with no sources",
        () => swap(agreementRec(3, { title: { ...field("agree", "x", 3), sources: [] } })),
        /no source links/,
      ],
      [
        "a plain-http link",
        () =>
          appendFileSync(
            f.wikidata,
            JSON.stringify({
              ...wikidataRec(N + 1),
              source: { revision_url: "http://www.wikidata.org/x" },
            }) + "\n",
          ),
        /not an allowed source link/,
      ],
      [
        "a Wikidata item listed twice",
        () => appendFileSync(f.wikidata, JSON.stringify(wikidataRec(3)) + "\n"),
        /Wikidata file lists Q4 twice/,
      ],
      [
        "a link carrying a user name",
        () =>
          swap(
            agreementRec(3, {
              title: {
                ...field("agree", "x", 3),
                sources: [
                  { name: "x", url: "https://someone@www.wikidata.org/w/index.php?oldid=1" },
                ],
              },
            }),
          ),
        /not an allowed source link/,
      ],
      [
        "a link on another port",
        () =>
          swap(
            agreementRec(3, {
              title: {
                ...field("agree", "x", 3),
                sources: [{ name: "x", url: "https://store.steampowered.com:8443/app/1/" }],
              },
            }),
          ),
        /not an allowed source link/,
      ],
      ["a bad Steam ID", () => swap({ ...agreementRec(3), steam_appid: "12a" }), /not a number/],
      ["a missing status", () => swap(agreementRec(3, { title: {} })), /no status/],
    ];
    const wd = readFileSync(f.wikidata);
    const ag = readFileSync(f.agreement);
    for (const [name, damage, err] of cases) {
      writeFileSync(f.wikidata, wd);
      writeFileSync(f.agreement, ag);
      damage();
      const db = catalogueDb();
      expect(
        () =>
          promoteCatalogueFacts(db, {
            wikidataFile: f.wikidata,
            agreementFile: f.agreement,
            reviewConfirmed: name !== "no review",
          }),
        name,
      ).toThrow(err);
      expect(count(db, "SELECT count(*) n FROM CatalogueGames"), name).toBe(0);
      db.close();
    }
  });
  it("checks every field before the first write", () => {
    const f = fixture();
    // The duplicate is the last line, so a loader that wrote as it read would have written rows.
    appendFileSync(
      f.agreement,
      JSON.stringify(agreementRec(0, { title: field("agree", 5, 0) })) + "\n",
    );
    const db = catalogueDb();
    expect(() => loadFacts(db, f)).toThrow(CataloguePromotionError);
    expect(count(db, "SELECT count(*) n FROM CatalogueFacts")).toBe(0);
    db.close();
  });
});

// --- Drafts -----------------------------------------------------------------

describe("promoteCatalogueDrafts", () => {
  it("promotes each game's latest ok draft under the accepted sample", () => {
    const f = fixture();
    const db = catalogueDb();
    loadFacts(db, f);
    const r = promote(db, f);
    expect(r).toMatchObject({
      kind: "description",
      promoted: N - 5,
      withdrawn: 0,
      overridden_by_steam: 0,
      latest_status: { ok: N - 5, rejected: 5 },
      sample_seed: "t1",
    });
    const row = db.prepare("SELECT * FROM CatalogueDrafts WHERE qid = ?").get(qid(N - 8)) as any;
    const text = `A drafted description of game ${N - 7}.`;
    expect(row).toMatchObject({
      kind: "description",
      label: "generated",
      text_sha256: sha(text),
      model: "gemini-3.1-flash-lite",
      prompt_version: "s3-v1",
      run_id: "run-a",
      attempt_id: "run-a:1",
      drafted_at: "2026-10-14T10:00:00Z",
      sample_summary_sha256: sha(readFileSync(f.summary)),
      sample_seed: "t1",
      accepted_by: "Principal Operator",
      promoted_at: NOW.toISOString(),
      sourced: null,
      overrides: null,
    });
    expect(JSON.parse(row.value)).toEqual({ description: text });
    expect(JSON.parse(row.links)).toEqual({
      wikidata: wdUrl(qid(N - 8)),
      steam: steamUrl(1000 + N - 8),
      wikipedia: null,
    });
    expect(count(db, "SELECT count(*) n FROM CatalogueDrafts WHERE qid = ?", qid(N - 1))).toBe(0);
    db.close();
  });
  it("withdraws a promoted draft whose game's latest record is no longer ok", () => {
    const f = fixture();
    const db = catalogueDb();
    loadFacts(db, f);
    promote(db, f);
    // A later pass rejects Q1 and Q2; the operator draws and accepts a new sample of the new files.
    const d = f.d;
    const later = path.join(d, "description-c.jsonl");
    jsonl(later, [
      draft("description", 0, "rejected", "2026-10-15T00:00:00Z"),
      draft("description", 1, "insufficient", "2026-10-15T00:00:00Z"),
    ]);
    const drew = sc.draw({ kind: "description", inputs: [...f.drafts, later], seed: "t2", out: d });
    const sheet = path.join(d, drew.files[0]);
    const table = sc.parseCsv(readFileSync(sheet, "utf8"));
    const v = table[0].indexOf("verdict");
    for (const row of table.slice(1)) row[v] = "correct";
    writeFileSync(sheet, sc.toCsv(table));
    sc.score({ sheet });
    const summary = sheet.replace(/\.csv$/, ".summary.json");
    accept(summary);
    const r = promote(db, { ...f, drafts: [...f.drafts, later], summary });
    expect(r).toMatchObject({ promoted: N - 7, withdrawn: 2, sample_seed: "t2" });
    expect(count(db, "SELECT count(*) n FROM CatalogueDrafts WHERE qid IN ('Q1', 'Q2')")).toBe(0);
    db.close();
  });
  it("refuses until the operator has accepted the sample", () => {
    const f = fixture("description", { accept: false });
    const db = catalogueDb();
    loadFacts(db, f);
    expect(() => promote(db, f)).toThrow(/not been accepted/);
    accept(f.summary, "Principal Operator", "");
    expect(() => promote(db, f)).toThrow(/not been accepted/);
    accept(f.summary, "  ", "2026-10-14T15:00:00Z");
    expect(() => promote(db, f)).toThrow(/not been accepted/);
    accept(f.summary, "Principal Operator", "yesterday");
    expect(() => promote(db, f)).toThrow(/not a date/);
    expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(0);
    accept(f.summary);
    expect(promote(db, f).promoted).toBe(N - 5);
    db.close();
  });
  it("refuses a sample over the line, even when accepted", () => {
    const f = fixture("description", { wrong: 4 });
    const db = catalogueDb();
    loadFacts(db, f);
    expect(() => promote(db, f)).toThrow(/does not meet the line/);
    // Editing the summary's own verdict does not get round the counts.
    editSummary(f.summary, (s) => (s.meets_line = true));
    expect(() => promote(db, f)).toThrow(/does not meet the line/);
    // Nor does editing its counts: they are counted again from the sheet.
    editSummary(f.summary, (s) => {
      s.counts.wrong = 3;
      s.counts.correct += 1;
    });
    expect(() => promote(db, f)).toThrow(/counts are not the sheet's verdicts/);
    expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(0);
    db.close();
  });
  it("refuses a sheet rewritten after scoring, even with its hash updated in the summary", () => {
    const f = fixture("description", { wrong: 3 });
    const t = sc.parseCsv(readFileSync(f.sheet, "utf8"));
    const v = t[0].indexOf("verdict");
    t[5][v] = "wrong";
    writeFileSync(f.sheet, sc.toCsv(t));
    editSummary(f.summary, (s) => (s.sheet_sha256 = sha(readFileSync(f.sheet))));
    const db = catalogueDb();
    loadFacts(db, f);
    expect(() => promote(db, f)).toThrow(/counts are not the sheet's verdicts/);
    db.close();
  });
  it("refuses a sample that is not 100 distinct drawn rows", () => {
    const cases: Array<[string, (m: any, t: string[][]) => void, RegExp]> = [
      ["no rows", (m, t) => ((m.rows = []), t.splice(1)), /has 0 rows, not 100/],
      ["one row less", (m, t) => (m.rows.pop(), t.pop()), /has 99 rows, not 100/],
      [
        "a game twice",
        (m, t) => {
          m.rows[1].qid = m.rows[0].qid;
          t[2][t[0].indexOf("qid")] = m.rows[0].qid;
        },
        /repeats a row or a game/,
      ],
      ["a row number twice", (m) => (m.rows[1].n = m.rows[0].n), /repeats a row or a game/],
      [
        "a malformed row",
        (m) => (m.rows[3].text_sha256 = "x"),
        /row of the meta file is malformed/,
      ],
      ["a sheet row missing", (_m, t) => t.pop(), /sheet's rows are not the meta file's rows/],
      [
        "a sheet draft changed",
        (_m, t) => (t[4][t[0].indexOf("draft")] = "Another text."),
        /sheet row 4 does not match the drawn record/,
      ],
      [
        "an unknown verdict",
        (_m, t) => (t[7][t[0].indexOf("verdict")] = "fine"),
        /verdict that is not one of/,
      ],
      [
        "no verdict column",
        (_m, t) => (t[0][t[0].indexOf("verdict")] = "v"),
        /no "verdict" column/,
      ],
    ];
    for (const [name, edit, err] of cases) {
      const f = fixture();
      const metaFile = f.sheet.replace(/\.csv$/, ".meta.json");
      const m = JSON.parse(readFileSync(metaFile, "utf8"));
      const t = sc.parseCsv(readFileSync(f.sheet, "utf8"));
      edit(m, t);
      // A forger who rewrites the sheet and meta file updates their hashes in the summary.
      const metaText = JSON.stringify(m);
      writeFileSync(metaFile, metaText);
      writeFileSync(f.sheet, sc.toCsv(t));
      editSummary(f.summary, (s) => {
        s.meta_sha256 = sha(metaText);
        s.sheet_sha256 = sha(readFileSync(f.sheet));
      });
      const db = catalogueDb();
      loadFacts(db, f);
      expect(() => promote(db, f), name).toThrow(err);
      expect(count(db, "SELECT count(*) n FROM CatalogueDrafts"), name).toBe(0);
      db.close();
    }
  });
  it("refuses counts that are not whole numbers", () => {
    const f = fixture();
    editSummary(f.summary, (s) => (s.counts.minor = -1));
    const db = catalogueDb();
    loadFacts(db, f);
    expect(() => promote(db, f)).toThrow(/counts are not whole numbers/);
    db.close();
  });
  it("accepts exactly 3 wrong", () => {
    const f = fixture("description", { wrong: 3 });
    const db = catalogueDb();
    loadFacts(db, f);
    expect(promote(db, f).promoted).toBe(N - 5);
    db.close();
  });
  it("refuses, and writes nothing, when the record of the review does not hold together", () => {
    const base = fixture();
    const cases: Array<[string, (f: Fixture) => any, RegExp]> = [
      ["no review", () => ({ reviewConfirmed: false }), /review confirmation/],
      ["another kind", () => ({ kind: "genre" }), /is for description, not genre/],
      ["an unknown kind", () => ({ kind: "summary" }), /unknown kind/],
      ["no draft files", () => ({ draftFiles: [] }), /give the draft files/],
      ["the sheet edited after scoring", (f) => appendFileSync(f.sheet, "\n"), /sheet has changed/],
      [
        "the meta file edited",
        (f) => appendFileSync(f.sheet.replace(/\.csv$/, ".meta.json"), " "),
        /meta file has changed/,
      ],
      [
        "a draft file changed",
        (f) => appendFileSync(f.drafts[1], JSON.stringify(draft("description", 0)) + "\n"),
        /not the ones the sample was drawn from/,
      ],
      [
        "the files in another order",
        (f) => ({ draftFiles: [f.drafts[1], f.drafts[0]] }),
        /not the ones the sample was drawn from/,
      ],
      [
        "a file left out",
        (f) => ({ draftFiles: [f.drafts[0]] }),
        /not the ones the sample was drawn from/,
      ],
      [
        "a sheet name with a path",
        (f) => editSummary(f.summary, (s) => (s.sheet = "../x.csv")),
        /does not name its sheet/,
      ],
      [
        "a summary for another seed",
        (f) => editSummary(f.summary, (s) => (s.seed = "t9")),
        /meta file does not match/,
      ],
      [
        "an incomplete sheet",
        (f) => editSummary(f.summary, (s) => (s.counts.unchecked = 1)),
        /does not meet the line/,
      ],
      [
        "a sample of 99",
        (f) => editSummary(f.summary, (s) => (s.n = 99)),
        /does not meet the line/,
      ],
      ["not a summary", (f) => writeFileSync(f.summary, "[]"), /not a sample-check summary/],
      ["no summary", (f) => rmSync(f.summary), /could not be read/],
    ];
    const snapshot = (f: Fixture) =>
      [f.summary, f.sheet, f.sheet.replace(/\.csv$/, ".meta.json"), ...f.drafts].map(
        (p) => [p, readFileSync(p)] as const,
      );
    const saved = snapshot(base);
    for (const [name, damage, err] of cases) {
      for (const [p, b] of saved) writeFileSync(p, b);
      const over = damage(base) ?? {};
      const db = catalogueDb();
      loadFacts(db, base);
      expect(() => promote(db, base, over.kind ?? "description", over), name).toThrow(err);
      expect(count(db, "SELECT count(*) n FROM CatalogueDrafts"), name).toBe(0);
      db.close();
    }
  });
  it("refuses a summary that is not one, or that says it is incomplete", () => {
    for (const [edit, err] of [
      [(x: any) => (x.schema = "mgpl-sample-check-summary/0"), /not a sample-check summary/],
      [(x: any) => (x.complete = false), /does not meet the line/],
      [(x: any) => delete x.counts, /no counts/],
    ] as Array<[(x: any) => void, RegExp]>) {
      const f = fixture();
      editSummary(f.summary, edit);
      const db = catalogueDb();
      loadFacts(db, f);
      expect(() => promote(db, f)).toThrow(err);
      db.close();
    }
  });
  it("refuses, outside the sample too, a record of another schema or an ok draft not labelled generated", () => {
    for (const [bad, err] of [
      [{ ...draft("description", 3), schema: "mgpl-enrichment/0" }, /not mgpl-enrichment\/1/],
      [
        { ...draft("description", 3, "ok", "2026-10-16T00:00:00Z"), label: "sourced" },
        /not labelled generated/,
      ],
    ] as Array<[unknown, RegExp]>) {
      const f = fixture();
      // Rewrite a draft file, its hash in the meta file and summary, and the meta file's hash,
      // as a forger of the whole record would. Only the record checks are left to refuse.
      appendFileSync(f.drafts[1], JSON.stringify(bad) + "\n");
      const metaFile = f.sheet.replace(/\.csv$/, ".meta.json");
      const m = JSON.parse(readFileSync(metaFile, "utf8"));
      m.inputs[1].sha256 = sha(readFileSync(f.drafts[1]));
      const text = JSON.stringify(m);
      writeFileSync(metaFile, text);
      editSummary(f.summary, (x) => {
        x.inputs = m.inputs;
        x.meta_sha256 = sha(text);
      });
      const db = catalogueDb();
      loadFacts(db, f);
      expect(() => promote(db, f)).toThrow(err);
      expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(0);
      db.close();
    }
  });
  it("refuses when a sampled draft is not the latest ok draft that was checked", () => {
    // The files match the summary's hashes only if they are the drawn ones, so this is reached
    // only by a later draft for a sampled game with every hash rewritten to match. Simulate that.
    const f = fixture();
    const metaFile = f.sheet.replace(/\.csv$/, ".meta.json");
    const m = JSON.parse(readFileSync(metaFile, "utf8"));
    const q = m.rows[0].qid;
    const i = Number(q.slice(1)) - 1;
    appendFileSync(
      f.drafts[1],
      JSON.stringify({
        ...draft("description", i, "ok", "2026-10-16T00:00:00Z"),
        generated: { description: "A later, unchecked draft." },
      }) + "\n",
    );
    m.inputs[1].sha256 = sha(readFileSync(f.drafts[1]));
    const text = JSON.stringify(m);
    writeFileSync(metaFile, text);
    editSummary(f.summary, (s) => {
      s.inputs = m.inputs;
      s.meta_sha256 = sha(text);
    });
    const db = catalogueDb();
    loadFacts(db, f);
    expect(() => promote(db, f)).toThrow(/latest ok draft with the text that was checked/);
    db.close();
  });
  it("refuses until the catalogue facts are promoted", () => {
    const f = fixture();
    const db = catalogueDb();
    expect(() => promote(db, f)).toThrow(
      /not in CatalogueGames; promote the catalogue facts first/,
    );
    expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(0);
    db.close();
  });
  it("refuses a draft with a link to another host, no model, or the wrong label", () => {
    for (const [extra, err] of [
      [
        {
          inputs: { wikidata: wdUrl("Q1"), steam: "https://steam.example/app/1/", wikipedia: null },
        },
        /Steam link is not an allowed/,
      ],
      [
        {
          inputs: {
            wikidata: wdUrl("Q1"),
            steam: null,
            wikipedia: "https://de.wikipedia.org/w/index.php?oldid=1",
          },
        },
        /Wikipedia link is not an allowed/,
      ],
      [{ model: "" }, /names no model/],
      [{ prompt_version: undefined }, /names no prompt version/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const d = dir();
      const wd = path.join(d, "w.jsonl");
      const ag = path.join(d, "a.jsonl");
      jsonl(
        wd,
        Array.from({ length: N }, (_, i) => wikidataRec(i)),
      );
      jsonl(ag, []);
      const file = path.join(d, "drafts.jsonl");
      jsonl(
        file,
        Array.from({ length: N }, (_, i) =>
          draft("description", i, "ok", "2026-10-13T10:00:00Z", i === N - 1 ? extra : {}),
        ),
      );
      // Draw a sample that leaves the last game out, so the bad record is not in the sheet.
      let drew: any;
      let seed = 0;
      for (;;) {
        drew = sc.draw({ kind: "description", inputs: [file], seed: `s${seed}`, out: d });
        const meta = JSON.parse(readFileSync(path.join(d, drew.files[2]), "utf8"));
        if (!meta.rows.some((r: any) => r.qid === qid(N - 1))) break;
        seed++;
      }
      const sheet = path.join(d, drew.files[0]);
      const t = sc.parseCsv(readFileSync(sheet, "utf8"));
      const v = t[0].indexOf("verdict");
      for (const row of t.slice(1)) row[v] = "correct";
      writeFileSync(sheet, sc.toCsv(t));
      sc.score({ sheet });
      const summary = sheet.replace(/\.csv$/, ".summary.json");
      accept(summary);
      const db = catalogueDb();
      promoteCatalogueFacts(db, { wikidataFile: wd, agreementFile: ag, reviewConfirmed: true });
      expect(() =>
        promoteCatalogueDrafts(db, {
          kind: "description",
          draftFiles: [file],
          summaryFile: summary,
          reviewConfirmed: true,
        }),
      ).toThrow(err);
      expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(0);
      db.close();
    }
  });
});

describe("friction and genre drafts", () => {
  it("Steam's Save Anytime overrides a drafted save system, and the draft is kept beside it", () => {
    const f = fixture("friction");
    const db = catalogueDb();
    loadFacts(db, f);
    const r = promote(db, f, "friction");
    expect(r).toMatchObject({ promoted: N - 5, overridden_by_steam: 1 });
    const row = db.prepare("SELECT * FROM CatalogueDrafts WHERE qid = 'Q1'").get() as any;
    expect(JSON.parse(row.value).save_system).toBe("save_anywhere");
    expect(JSON.parse(row.overrides)).toEqual({
      save_system: {
        draft: "checkpoints",
        value: "save_anywhere",
        basis: "Steam category 79 (Save Anytime)",
        source: steamUrl(1000),
      },
    });
    expect(JSON.parse(row.sourced).save_anytime).toBe(true);
    // The hash is of the draft the reviewer checked, not of the overridden value.
    expect(row.text_sha256).toBe(sha(canonicalJson(FRICTION_OK)));
    const other = db.prepare("SELECT * FROM CatalogueDrafts WHERE qid = 'Q2'").get() as any;
    expect(JSON.parse(other.value)).toEqual(FRICTION_OK);
    expect(other.overrides).toBeNull();
    db.close();
  });
  it("refuses a Steam fact that would override a draft without its Steam link", () => {
    for (const [name, sourced] of [
      ["no source", { save_anytime: true, note: "x" }],
      ["a null source", { save_anytime: true, source: null }],
    ] as Array<[string, Record<string, unknown>]>) {
      const f = fixture("friction", { firstExtra: { sourced } });
      const db = catalogueDb();
      loadFacts(db, f);
      expect(() => promote(db, f, "friction"), name).toThrow(
        /"Save Anytime" fact has no Steam link/,
      );
      expect(count(db, "SELECT count(*) n FROM CatalogueDrafts"), name).toBe(0);
      db.close();
    }
    // Without the category, a missing link changes nothing and is accepted.
    const f = fixture("friction", { firstExtra: { sourced: { save_anytime: null } } });
    const db = catalogueDb();
    loadFacts(db, f);
    expect(promote(db, f, "friction").overridden_by_steam).toBe(0);
    db.close();
  });
  it("applySteamFacts changes nothing when Steam does not list the category", () => {
    for (const sourced of [
      null,
      { save_anytime: null },
      { save_anytime: false },
      { save_anytime: "true" },
    ]) {
      const v = { ...FRICTION_OK };
      expect(applySteamFacts(v, sourced as any)).toEqual({});
      expect(v).toEqual(FRICTION_OK);
    }
    const v = { ...FRICTION_OK, save_system: "save_anywhere" };
    expect(applySteamFacts(v, { save_anytime: true })).toEqual({});
  });
  it("genre drafts promote as drafted", () => {
    const f = fixture("genre");
    const db = catalogueDb();
    loadFacts(db, f);
    expect(promote(db, f, "genre")).toMatchObject({ promoted: N - 5, overridden_by_steam: 0 });
    const row = db.prepare("SELECT * FROM CatalogueDrafts WHERE qid = 'Q3'").get() as any;
    expect(JSON.parse(row.value)).toEqual(GENRE_OK);
    expect(row.sourced).toBeNull();
    db.close();
  });
  it("refuses a draft with a value outside the options, or a missing or extra field", () => {
    for (const [kind, generated, err] of [
      [
        "friction",
        { ...FRICTION_OK, save_system: "anywhere" },
        /outside the options for save_system/,
      ],
      ["friction", { ...FRICTION_OK, extra: "x" }, /expected fields/],
      ["genre", { ...GENRE_OK, primary_genre: undefined }, /expected fields/],
      ["genre", { ...GENRE_OK, is_rpg: true }, /outside the options for is_rpg/],
    ] as Array<[string, Record<string, unknown>, RegExp]>) {
      const f = fixture(kind);
      const db = catalogueDb();
      loadFacts(db, f);
      // A later draft for a game outside the sample, in a new file, with a new accepted sample.
      const meta = JSON.parse(readFileSync(f.sheet.replace(/\.csv$/, ".meta.json"), "utf8"));
      const sampled = new Set(meta.rows.map((r: any) => r.qid));
      const i = Array.from({ length: N - 10 }, (_, k) => k).find(
        (k) => !sampled.has(qid(k)),
      ) as number;
      const extra = path.join(f.d, `${kind}-c.jsonl`);
      jsonl(extra, [{ ...draft(kind, i, "ok", "2026-10-15T00:00:00Z"), generated }]);
      const out = dir();
      const drew = sc.draw({ kind, inputs: [...f.drafts, extra], seed: "t1", out });
      const sheet = path.join(out, drew.files[0]);
      const t = sc.parseCsv(readFileSync(sheet, "utf8"));
      const v = t[0].indexOf("verdict");
      for (const row of t.slice(1)) row[v] = "correct";
      writeFileSync(sheet, sc.toCsv(t));
      sc.score({ sheet });
      const summary = sheet.replace(/\.csv$/, ".summary.json");
      accept(summary);
      expect(
        () => promote(db, { ...f, drafts: [...f.drafts, extra], summary }, kind),
        String(err),
      ).toThrow(err);
      expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(0);
      db.close();
    }
  });
});

// --- The command ------------------------------------------------------------

describe("promote-catalogue.ts", () => {
  it("parses only its own options and always needs --review-confirmed true", () => {
    expect(
      parseArgs(["facts", "--wikidata", "w", "--agreement", "a", "--review-confirmed", "true"]),
    ).toMatchObject({ command: "facts" });
    expect(
      parseArgs([
        "drafts",
        "--kind",
        "genre",
        "--in",
        "a",
        "--in",
        "b",
        "--summary",
        "s",
        "--review-confirmed",
        "true",
      ]).inputs,
    ).toEqual(["a", "b"]);
    for (const argv of [
      [],
      ["promote"],
      ["facts", "--wikidata", "w", "--agreement", "a"],
      ["facts", "--wikidata", "w", "--agreement", "a", "--review-confirmed", "yes"],
      ["facts", "--wikidata", "w", "--wikidata", "x", "--review-confirmed", "true"],
      ["facts", "--wikidata", "w", "--summary", "s", "--review-confirmed", "true"],
      ["facts", "--in", "w", "--review-confirmed", "true"],
      ["drafts", "--kind", "--in", "a", "--review-confirmed", "true"],
      ["drafts", "--kind", "genre", "--wikidata", "w", "--review-confirmed", "true"],
    ])
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(CataloguePromotionError);
  });
  it("refuses a database without the Catalogue* tables, and creates none", () => {
    const d = dir();
    const file = path.join(d, "empty.db");
    new Database(file).close();
    expect(() =>
      main(["facts", "--wikidata", "w", "--agreement", "a", "--review-confirmed", "true"], {
        openDb: () => new Database(file),
        log: () => {},
      }),
    ).toThrow(/no CatalogueGames table/);
    const db = new Database(file);
    expect(count(db, "SELECT count(*) n FROM sqlite_master WHERE type = 'table'")).toBe(0);
    db.close();
  });
  it("runs both steps against a database file and prints counts, never a draft", () => {
    const f = fixture();
    const file = path.join(f.d, "dev.db");
    catalogueDb(file).close();
    const lines: string[] = [];
    const deps = { openDb: () => new Database(file), log: (l: string) => lines.push(l), now: NOW };
    main(
      ["facts", "--wikidata", f.wikidata, "--agreement", f.agreement, "--review-confirmed", "true"],
      deps,
    );
    main(
      [
        "drafts",
        "--kind",
        "description",
        "--in",
        f.drafts[0],
        "--in",
        f.drafts[1],
        "--summary",
        f.summary,
        "--review-confirmed",
        "true",
      ],
      deps,
    );
    expect(JSON.parse(lines[0])).toMatchObject({ games: N, facts: N * 2 + N / 2 });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: "description", promoted: N - 5 });
    expect(lines.join("\n")).not.toMatch(/drafted description|Game \d/);
    const db = new Database(file);
    expect(count(db, "SELECT count(*) n FROM CatalogueDrafts")).toBe(N - 5);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    expect(() =>
      main(
        [
          "drafts",
          "--kind",
          "friction",
          "--in",
          f.drafts[0],
          "--summary",
          f.summary,
          "--review-confirmed",
          "true",
        ],
        deps,
      ),
    ).toThrow(/is for description, not friction/);
    expect(() =>
      main(
        [
          "drafts",
          "--kind",
          "summary",
          "--in",
          "a",
          "--summary",
          "s",
          "--review-confirmed",
          "true",
        ],
        deps,
      ),
    ).toThrow(/--kind must be one of/);
    expect(() =>
      main(["drafts", "--kind", "genre", "--summary", "s", "--review-confirmed", "true"], deps),
    ).toThrow(/at least one --in/);
  });
});
