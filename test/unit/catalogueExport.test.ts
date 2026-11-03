// WU-034: the operator exporter of the promoted reference catalogue
// (scripts/catalogue/export-promoted-inputs.mjs). Invented records only; no network, no real
// catalogue data and no app database.
// cspell:words jsonl qid qids sha wikidata steampowered mgpl vcol
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let ex: any;
let sample: any;
let embed: any;
let enrich: any;
beforeAll(async () => {
  ex = await import("../../scripts/catalogue/export-promoted-inputs.mjs");
  sample = await import("../../scripts/catalogue/sample-check.mjs");
  embed = await import("../../scripts/catalogue/embed-descriptions.mjs");
  enrich = await import("../../scripts/catalogue/enrich-gemini.mjs");
});

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "mgpl-export-"));
  tmp.push(d);
  return d;
};
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

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

const NOW = "2026-10-20T12:00:00Z";
const qid = (i: number) => `Q${i + 1}`;
const wdUrl = (q: string) => `https://www.wikidata.org/w/index.php?title=${q}&oldid=7`;
const steamUrl = (id: number) => `https://store.steampowered.com/app/${id}/`;
const wikiUrl = (q: string) =>
  `https://en.wikipedia.org/w/index.php?title=${q}&oldid=${Number(q.slice(1)) + 1000}`;

function valueFor(kind: string, i: number): Record<string, unknown> {
  if (kind === "description") return { description: `A drafted description of game ${i + 1}.` };
  let n = i;
  const entries =
    kind === "friction"
      ? Object.entries(enrich.FRICTION_OPTIONS)
      : [
          ...enrich.GENRE_FLAGS.map((k: string) => [k, ["yes", "no", "unknown"]]),
          ["primary_genre", enrich.PRIMARY_GENRES],
        ];
  return Object.fromEntries(
    entries.map(([k, choices]: [string, string[]]) => {
      const v = choices[n % choices.length];
      n = Math.floor(n / choices.length);
      return [k, v];
    }),
  );
}

function draftRec(kind: string, i: number, over: Record<string, unknown> = {}) {
  const rec: Record<string, unknown> = {
    schema: "mgpl-enrichment/1",
    qid: qid(i),
    task: kind,
    context: "none",
    status: "ok",
    label: "generated",
    generated: valueFor(kind, i),
    at: NOW,
    model: "synthetic-model",
    prompt_version: "synthetic-v1",
    run_id: "run-a",
    attempt_id: "run-a:1",
    ...over,
  };
  if (kind === "description" && rec.inputs === undefined)
    rec.inputs = { wikidata: wdUrl(qid(i)), steam: steamUrl(1000 + i), wikipedia: wikiUrl(qid(i)) };
  return rec;
}

function addGame(db: Database.Database, q: string, title: string) {
  db.prepare(
    "INSERT INTO CatalogueGames (qid, title, steam_appid, wikidata_url, loaded_at) VALUES (?, ?, NULL, ?, ?)",
  ).run(q, title, wdUrl(q), NOW);
}

function addDraftRow(
  db: Database.Database,
  r: any,
  kind: string,
  summarySha: string,
  over: any = {},
) {
  const value = over.value ?? (kind === "description" ? r.generated : { ...r.generated });
  const text = kind === "description" ? r.generated.description : sample.canonicalJson(r.generated);
  const textSha = over.text_sha256 ?? sha(text);
  const links =
    over.links ??
    (kind === "description"
      ? {
          wikidata: wdUrl(r.qid),
          steam: steamUrl(Number(r.qid.slice(1)) + 1000),
          wikipedia: r.inputs?.wikipedia ?? null,
        }
      : {
          wikidata: wdUrl(r.qid),
          steam: steamUrl(Number(r.qid.slice(1)) + 1000),
          wikipedia: null,
        });
  db.prepare(
    `INSERT INTO CatalogueDrafts (qid, kind, value, label, sourced, overrides, text_sha256, links,
       model, prompt_version, run_id, attempt_id, drafted_at, sample_summary_sha256, sample_seed,
       accepted_by, promoted_at)
     VALUES (?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 't1', 'Principal Operator', ?)`,
  ).run(
    r.qid,
    kind,
    JSON.stringify(value),
    over.sourced ?? null,
    over.overrides ?? null,
    textSha,
    JSON.stringify(links),
    r.model,
    r.prompt_version,
    r.run_id,
    r.attempt_id,
    r.at,
    over.sample_summary_sha256 ?? summarySha,
    over.promoted_at ?? NOW,
  );
}

function accept(summary: string) {
  const s = JSON.parse(readFileSync(summary, "utf8"));
  s.accepted_by = "Principal Operator";
  s.accepted_at = NOW;
  writeFileSync(summary, `${JSON.stringify(s, null, 2)}\n`);
}

/**
 * Builds a synthetic promoted catalogue for one kind: 100 ok draft records in one draft file, a
 * drawn/scored/accepted 100-row sample check, and a database with the games and the promoted
 * drafts of that cohort. Returns everything the exporter needs.
 */
function fixture(
  kind: string,
  over: { draft?: (i: number) => Record<string, unknown>; dbRow?: (r: any) => any } = {},
) {
  const d = dir();
  const draftsDir = path.join(d, "drafts");
  mkdirSync(draftsDir);
  const name = `enrich-gemini-${kind}-none.jsonl`;
  const draftFile = path.join(draftsDir, name);
  const rows = Array.from({ length: 100 }, (_, i) => draftRec(kind, i, over.draft?.(i) ?? {}));
  writeFileSync(draftFile, jsonl(rows));

  const samples = path.join(d, "samples");
  mkdirSync(samples);
  const drew = sample.draw({
    kind,
    inputs: [draftFile],
    seed: "t1",
    out: samples,
    n: 100,
    now: new Date(NOW),
  });
  const sheet = path.join(samples, drew.files[0]);
  const table = sample.parseCsv(readFileSync(sheet, "utf8"));
  const vcol = table[0].indexOf("verdict");
  for (const row of table.slice(1)) row[vcol] = "correct";
  writeFileSync(sheet, sample.toCsv(table));
  sample.score({ sheet, now: new Date(NOW) });
  const summary = sheet.replace(/\.csv$/, ".summary.json");
  accept(summary);

  const summarySha = sha(readFileSync(summary));
  const dbFile = path.join(d, "cat.db");
  const db = catalogueDb(dbFile);
  for (const r of rows) addGame(db, r.qid, `Game ${Number(r.qid.slice(1))}`);
  for (const r of rows) addDraftRow(db, r, kind, summarySha, over.dbRow?.(r) ?? {});
  db.close();
  return { d, draftsDir, name, draftFile, summary, summarySha, dbFile, rows };
}

const lines = (out: string) =>
  readFileSync(path.join(out, "snapshot.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("export-promoted-inputs.mjs", () => {
  it("exports a friction mgpl-promoted-embedding-input/2 snapshot the shipped validator accepts", () => {
    const f = fixture("friction");
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    const rows = built.snapshotText.trim().split("\n").map(JSON.parse);
    expect(rows.length).toBe(100);
    expect(rows.every((r) => r.schema === ex.EMBEDDING_SCHEMA && r.kind === "friction")).toBe(true);
    expect(
      rows.every((r) => r.sample_summary_sha256 === f.summarySha && r.draft_file === f.name),
    ).toBe(true);
    for (const r of rows) {
      const rec = f.rows.find((x) => x.qid === r.qid);
      expect(r.text_sha256).toBe(sha(embed.embeddingText("friction", { friction: rec.generated })));
    }
    expect(built.counts).toMatchObject({
      selected: 100,
      selected_cohort_rows: 100,
      other_cohort_rows: 0,
    });
  });

  it("exports a genre snapshot separately", () => {
    const f = fixture("genre");
    const built = ex.buildExport({
      kind: "genre",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    expect(
      built.snapshotText
        .trim()
        .split("\n")
        .map(JSON.parse)
        .every((r) => r.kind === "genre"),
    ).toBe(true);
    expect(built.manifest.snapshot.records).toBe(100);
  });

  it("exports a description snapshot from the promoted database row (no summary or drafts)", () => {
    const f = fixture("description");
    const built = ex.buildExport({ kind: "description", dbPath: f.dbFile, now: new Date(NOW) });
    const rows = built.snapshotText.trim().split("\n").map(JSON.parse);
    expect(rows.length).toBe(100);
    expect(rows.every((r) => r.schema === ex.CHECK_SCHEMA)).toBe(true);
    for (const r of rows) {
      const rec = f.rows.find((x) => x.qid === r.qid);
      expect(r.description).toBe(rec.generated.description);
      expect(r.description_sha256).toBe(sha(rec.generated.description));
      expect(r.source.url).toBe(rec.inputs.wikipedia);
      expect(r.title).toBe(`Game ${Number(r.qid.slice(1))}`);
    }
    expect(built.manifest.summary).toBeNull();
    expect(built.manifest.drafts).toEqual([]);
  });

  it("G follows the database mapping when database and accepted-draft descriptions differ", () => {
    const f = fixture("description", {
      dbRow: (r) =>
        r.qid === "Q1"
          ? {
              value: { description: "A different database description." },
              text_sha256: sha("A different database description."),
            }
          : {},
    });
    const built = ex.buildExport({ kind: "description", dbPath: f.dbFile, now: new Date(NOW) });
    const q1 = built.snapshotText
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((r) => r.qid === "Q1");
    expect(q1.description).toBe("A different database description.");
    expect(q1.description_sha256).toBe(sha("A different database description."));
  });

  it("derives E text from the accepted draft bytes, never from the database value/sourced/overrides", () => {
    const f = fixture("friction", {
      dbRow: () => ({ value: "not-even-json", sourced: "garbage", overrides: "garbage" }),
    });
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    const rows = built.snapshotText.trim().split("\n").map(JSON.parse);
    for (const r of rows) {
      const rec = f.rows.find((x) => x.qid === r.qid);
      expect(r.text_sha256).toBe(sha(embed.embeddingText("friction", { friction: rec.generated })));
    }
  });

  it("refuses when the derived E digest does not match the promoted row's text_sha256", () => {
    const f = fixture("friction", {
      dbRow: (r) => (r.qid === "Q1" ? { text_sha256: "f".repeat(64) } : {}),
    });
    expect(() =>
      ex.buildExport({
        kind: "friction",
        summaryFile: f.summary,
        draftsDir: f.draftsDir,
        dbPath: f.dbFile,
        now: new Date(NOW),
      }),
    ).toThrow(/digest does not match/);
  });

  it("selects the supplied-summary-hash cohort and reports other cohorts unselected", () => {
    const f = fixture("friction", {
      dbRow: (r) => (Number(r.qid.slice(1)) <= 50 ? {} : { sample_summary_sha256: "0".repeat(64) }),
    });
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    expect(built.counts).toMatchObject({
      requested_kind_rows: 100,
      selected_cohort_rows: 50,
      selected: 50,
      other_cohort_rows: 50,
      other_cohort_hashes: 1,
    });
  });

  it("supports explicit QID narrowing and reconciles the unselected count", () => {
    const f = fixture("friction");
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      qids: ["Q1", "Q3"],
      now: new Date(NOW),
    });
    expect(built.counts.selected).toBe(2);
    expect(built.counts.unselected_narrowed).toBe(98);
    expect(
      built.snapshotText
        .trim()
        .split("\n")
        .map(JSON.parse)
        .map((r) => r.qid),
    ).toEqual(["Q1", "Q3"]);
  });

  it("refuses the whole request when any explicit target is out of cohort", () => {
    const f = fixture("friction");
    expect(() =>
      ex.buildExport({
        kind: "friction",
        summaryFile: f.summary,
        draftsDir: f.draftsDir,
        dbPath: f.dbFile,
        qids: ["Q1", "Q999"],
        now: new Date(NOW),
      }),
    ).toThrow(/not in the selected friction cohort/);
  });

  it("resolves timestamp ties in the accepted summary's inputs order", () => {
    const d = dir();
    const draftsDir = path.join(d, "drafts");
    mkdirSync(draftsDir);
    const name1 = "enrich-gemini-friction-none.jsonl";
    const name2 = "enrich-gemini-friction-wikipedia.jsonl";
    const rows = Array.from({ length: 100 }, (_, i) => draftRec("friction", i));
    writeFileSync(path.join(draftsDir, name1), jsonl(rows));
    writeFileSync(path.join(draftsDir, name2), jsonl([draftRec("friction", 0)]));
    const samples = path.join(d, "samples");
    mkdirSync(samples);
    const drew = sample.draw({
      kind: "friction",
      inputs: [path.join(draftsDir, name1), path.join(draftsDir, name2)],
      seed: "t2",
      out: samples,
      n: 100,
      now: new Date(NOW),
    });
    const sheet = path.join(samples, drew.files[0]);
    const table = sample.parseCsv(readFileSync(sheet, "utf8"));
    const vcol = table[0].indexOf("verdict");
    for (const row of table.slice(1)) row[vcol] = "correct";
    writeFileSync(sheet, sample.toCsv(table));
    sample.score({ sheet, now: new Date(NOW) });
    const summary = sheet.replace(/\.csv$/, ".summary.json");
    accept(summary);
    const summarySha = sha(readFileSync(summary));
    const dbFile = path.join(d, "cat.db");
    const db = catalogueDb(dbFile);
    for (const r of rows) addGame(db, r.qid, `Game ${Number(r.qid.slice(1))}`);
    for (const r of rows) addDraftRow(db, r, "friction", summarySha);
    db.close();

    const built = ex.buildExport({
      kind: "friction",
      summaryFile: summary,
      draftsDir,
      dbPath: dbFile,
      now: new Date(NOW),
    });
    const snap = built.snapshotText.trim().split("\n").map(JSON.parse);
    expect(snap.find((r) => r.qid === "Q1").draft_file).toBe(name2);
    expect(snap.find((r) => r.qid === "Q2").draft_file).toBe(name1);
    expect(built.manifest.summary.inputs_order).toEqual([name1, name2]);
  });

  it("excludes and counts descriptions whose database source is missing while a draft source exists", () => {
    const f = fixture("description", {
      dbRow: (r) =>
        r.qid === "Q1"
          ? {
              links: {
                wikidata: wdUrl(r.qid),
                steam: steamUrl(Number(r.qid.slice(1)) + 1000),
                wikipedia: null,
              },
            }
          : {},
    });
    const built = ex.buildExport({ kind: "description", dbPath: f.dbFile, now: new Date(NOW) });
    expect(built.counts.selected).toBe(99);
    expect(built.counts.excluded_missing_pinned_source).toBe(1);
    expect(built.snapshotText).not.toContain('"Q1"');
  });

  it("enforces strict generated shapes and enums through the shipped validator", () => {
    const f = fixture("friction", {
      draft: (i) =>
        i === 0
          ? { generated: { ...valueFor("friction", 0), save_system: "not-a-real-value" } }
          : {},
    });
    expect(() =>
      ex.buildExport({
        kind: "friction",
        summaryFile: f.summary,
        draftsDir: f.draftsDir,
        dbPath: f.dbFile,
        now: new Date(NOW),
      }),
    ).toThrow();
  });

  it("validate-only runs the same checks and publishes nothing", () => {
    const f = fixture("friction");
    const out = path.join(f.d, "bundle");
    const logs: string[] = [];
    const r = ex.main(
      [
        "--kind",
        "friction",
        "--summary",
        f.summary,
        "--drafts",
        f.draftsDir,
        "--db",
        f.dbFile,
        "--out",
        out,
        "--validate-only",
      ],
      (s: string) => logs.push(s),
    );
    expect(r.counts.selected).toBe(100);
    expect(existsSync(out)).toBe(false);
    expect(logs.join("\n")).toMatch(/validate-only/);
  });

  it("publishes snapshot.jsonl and manifest.json together via one directory rename", () => {
    const f = fixture("friction");
    const out = path.join(f.d, "bundle");
    const r = ex.writeBundle({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      out,
      now: new Date(NOW),
    });
    expect(readdirSync(out).sort()).toEqual(["manifest.json", "snapshot.jsonl"]);
    expect(existsSync(`${out}.lock`)).toBe(false);
    expect(readdirSync(f.d).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(readFileSync(path.join(out, "manifest.json"), "utf8")).toContain(ex.MANIFEST_SCHEMA);
  });

  it("never overwrites an existing destination and respects the destination lock", () => {
    const f = fixture("friction");
    const out = path.join(f.d, "bundle");
    mkdirSync(out);
    expect(() => ex.publish({ out, snapshotText: "x\n", manifest: {} })).toThrow(/already exists/);
    const out2 = path.join(f.d, "bundle2");
    mkdirSync(`${out2}.lock`);
    expect(() => ex.publish({ out: out2, snapshotText: "x\n", manifest: {} })).toThrow(
      /another export/,
    );
    expect(existsSync(`${out2}.lock`)).toBe(true);
  });

  it("manifest carries provenance, verified hashes, input order, snapshot hash and reconciling counts", () => {
    const f = fixture("friction");
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    const m = built.manifest;
    expect(m.schema).toBe(ex.MANIFEST_SCHEMA);
    expect(m.kind).toBe("friction");
    expect(m.exporter.script).toBe("scripts/catalogue/export-promoted-inputs.mjs");
    expect(m.exporter.sha256).toBe(
      sha(
        readFileSync(path.resolve(process.cwd(), "scripts/catalogue/export-promoted-inputs.mjs")),
      ),
    );
    expect(m.summary.sha256).toBe(f.summarySha);
    expect(m.summary.inputs_order).toEqual([f.name]);
    expect(m.drafts).toEqual([{ file: f.name, sha256: sha(readFileSync(f.draftFile)) }]);
    expect(m.exporter.commit).toMatch(/^[0-9a-f]{40,}$/);
    expect(typeof m.exporter.dirty).toBe("boolean");
    expect(m.snapshot.sha256).toBe(sha(built.snapshotText));
    expect(m.snapshot.records).toBe(m.counts.selected);
    expect(m.counts.requested_kind_rows).toBe(
      m.counts.selected_cohort_rows + m.counts.other_cohort_rows,
    );
    expect(m.counts.selected_cohort_rows).toBe(
      m.counts.selected + m.counts.unselected_narrowed + m.counts.excluded_missing_pinned_source,
    );
  });

  it("refuses when the accepted draft bytes changed after scoring", () => {
    const f = fixture("friction");
    writeFileSync(f.draftFile, `${readFileSync(f.draftFile, "utf8")}x\n`);
    expect(() =>
      ex.buildExport({
        kind: "friction",
        summaryFile: f.summary,
        draftsDir: f.draftsDir,
        dbPath: f.dbFile,
        now: new Date(NOW),
      }),
    ).toThrow(/changed since the summary was scored/);
  });

  it("parses repeatable --qid and refuses unknown options", () => {
    expect(ex.parseArgs(["--kind", "friction", "--qid", "Q1", "--qid", "Q2"]).qid).toEqual([
      "Q1",
      "Q2",
    ]);
    expect(() => ex.parseArgs(["--nope", "x"])).toThrow(/unknown option/);
    expect(() => ex.parseArgs(["--kind"])).toThrow(/needs a value/);
  });

  it("reads the database read-only without modifying it", () => {
    const f = fixture("friction");
    const before = sha(readFileSync(f.dbFile));
    ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    expect(sha(readFileSync(f.dbFile))).toBe(before);
  });

  it("counts multiple foreign rows sharing one summary hash as rows, not distinct hashes", () => {
    const f = fixture("friction", {
      dbRow: (r) => (Number(r.qid.slice(1)) <= 97 ? {} : { sample_summary_sha256: "0".repeat(64) }),
    });
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    expect(built.counts.other_cohort_rows).toBe(3);
    expect(built.counts.other_cohort_hashes).toBe(1);
    expect(built.counts.requested_kind_rows).toBe(
      built.counts.selected_cohort_rows + built.counts.other_cohort_rows,
    );
  });

  it("treats a selected row without an accepted winning record as fatal", () => {
    const f = fixture("friction");
    const db = new Database(f.dbFile);
    addGame(db, "Q200", "Game 200");
    db.prepare(
      "INSERT INTO CatalogueDrafts (qid, kind, value, label, text_sha256, links, model, prompt_version, drafted_at, sample_summary_sha256, sample_seed, accepted_by, promoted_at) VALUES ('Q200', 'friction', '{}', 'generated', ?, '{}', 'm', 'p', 'a', ?, 't1', 'op', 'n')",
    ).run("f".repeat(64), f.summarySha);
    db.close();
    expect(() =>
      ex.buildExport({
        kind: "friction",
        summaryFile: f.summary,
        draftsDir: f.draftsDir,
        dbPath: f.dbFile,
        now: new Date(NOW),
      }),
    ).toThrow(/Q200 has no accepted winning draft record/);
  });

  it("resolves exporter revision provenance from the repository and refuses when unavailable", () => {
    const f = fixture("friction");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
    });
    expect(built.manifest.exporter.commit).toBe(head);
    expect(() =>
      ex.buildExport({
        kind: "friction",
        summaryFile: f.summary,
        draftsDir: f.draftsDir,
        dbPath: f.dbFile,
        now: new Date(NOW),
        deps: { git: () => null },
      }),
    ).toThrow(/cannot resolve the exporter's revision provenance/);
  });

  it("marks a dirty checkout so the manifest does not imply the commit identifies the bytes", () => {
    const f = fixture("friction");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const fakeGit = (args: string[]) =>
      args[0] === "rev-parse" ? head : " M scripts/catalogue/export-promoted-inputs.mjs";
    const built = ex.buildExport({
      kind: "friction",
      summaryFile: f.summary,
      draftsDir: f.draftsDir,
      dbPath: f.dbFile,
      now: new Date(NOW),
      deps: { git: fakeGit },
    });
    expect(built.manifest.exporter.dirty).toBe(true);
  });
});
