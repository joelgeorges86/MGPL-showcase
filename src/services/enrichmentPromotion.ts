import type { Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// PROVISIONAL AI-014 contract. The marker must be produced by the AI-014 run.
// A JSON file is only an advisory guard if an operator can write it; this
// service never writes the marker and cannot make it a control by itself.
export type Ai014Marker = {
  runId: string;
  source: "live-source-count-regeneration";
  status: "complete";
  generatedAt: string;
  counts: { sourceCount: number; stagingCount: number };
};

export type PromotionOptions = {
  runId: string;
  reviewConfirmed: boolean;
  ai014Marker: Ai014Marker | null;
};

export function promoteReviewedEnrichmentRun(
  db: DatabaseType,
  options: PromotionOptions,
): { runId: string; matchedRows: number } {
  if (!options.runId) throw new Error("run_id is required for promotion");
  if (!options.reviewConfirmed) throw new Error("review confirmation is required for promotion");
  const marker = options.ai014Marker;
  if (!marker || marker.status !== "complete") {
    throw new Error("PROVISIONAL AI-014 count evidence is required for promotion");
  }
  if (marker.runId !== options.runId)
    throw new Error("AI-014 marker runId does not match promotion run_id");
  if (!Number.isFinite(marker.counts.sourceCount) || !Number.isFinite(marker.counts.stagingCount)) {
    throw new Error("AI-014 marker counts must be numeric");
  }

  const rows = db
    .prepare(
      `SELECT game_id, title, publisher, original_game_release_date, confidence_score
       FROM AppGames_Staging WHERE run_id = ? ORDER BY staging_id`,
    )
    .all(options.runId) as Array<{
    game_id: string;
    title: string;
    publisher: string | null;
    original_game_release_date: string | null;
    confidence_score: number;
  }>;

  const update = db.prepare(
    `UPDATE AppGames
     SET "Game Title" = COALESCE(?, "Game Title"),
         publisher = COALESCE(?, publisher),
         originalGameReleaseDate = COALESCE(?, originalGameReleaseDate),
         enrichmentConfidence = COALESCE(?, enrichmentConfidence),
         enrichmentStatus = 'reviewed'
     WHERE "GameID" = ?`,
  );
  const promote = db.transaction(() => {
    const findGame = db.prepare('SELECT 1 FROM AppGames WHERE "GameID" = ?');
    let matchedRows = 0;
    for (const row of rows) {
      if (!findGame.get(row.game_id)) {
        throw new Error(`AppGames row not found for staging game_id ${row.game_id}`);
      }
      const updateResult = update.run(
        row.title,
        row.publisher,
        row.original_game_release_date,
        row.confidence_score,
        row.game_id,
      );
      matchedRows += updateResult.changes;
    }
    return matchedRows;
  });
  return { runId: options.runId, matchedRows: promote() };
}

// ---------------------------------------------------------------------------
// #158 / WU-033b (task proposal 033): the reference game catalogue.
//
// Two reviewed promotions into the Catalogue* tables of src/db.ts:
// - promoteCatalogueFacts loads the catalogue's games and the fields two sources agree on, from
//   the files agreement.mjs and wikidata-ingest.mjs write (DOCS/catalogue/SOURCES.md);
// - promoteCatalogueDrafts loads model drafts of one kind, and refuses unless the Principal
//   Operator has accepted a 100-record sample check of exactly those draft files
//   (scripts/catalogue/sample-check.mjs).
//
// As with the AI-014 marker above, the sample-check files are records of a human review that an
// operator can write. These checks tie a promotion to that record; they are not a control by
// themselves. Every input is read and checked before the first write, and each promotion is one
// transaction, so a refusal or a bad line changes nothing.

export class CataloguePromotionError extends Error {}
function refuse(message: string): never {
  throw new CataloguePromotionError(message);
}

export const CATALOGUE_KINDS = ["description", "friction", "genre"] as const;
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];
/** The agreement fields (agreement.mjs FIELDS). Only status `agree` is promoted. */
export const CATALOGUE_FACT_FIELDS = [
  "title",
  "release_date",
  "developers",
  "publishers",
  "platforms",
] as const;
/** Task proposal 033, decision 2: 100 rows, at most 3 `wrong` (sample-check.mjs ACCEPTANCE_LINE). */
export const SAMPLE_LINE = { of: 100, max_wrong: 3 } as const;

const YNU = ["yes", "no", "unknown"];
/** The values a friction draft may hold (enrich-gemini.mjs FRICTION_OPTIONS). */
export const FRICTION_VALUES: Record<string, readonly string[]> = {
  save_system: [
    "save_anywhere",
    "frequent_autosave",
    "checkpoints",
    "save_points",
    "no_mid_session_saves",
    "unknown",
  ],
  time_between_saves: [
    "under_5_min",
    "5_to_15_min",
    "15_to_30_min",
    "over_30_min",
    "not_applicable",
    "unknown",
  ],
  suspend_friendly: ["yes", "partly", "no", "unknown"],
  session_loop: ["under_15_min", "15_to_45_min", "45_to_90_min", "over_90_min", "unknown"],
  cognitive_load: ["low", "medium", "high", "unknown"],
  third_party_launcher: YNU,
  always_online: YNU,
};
/** The values a genre draft may hold (enrich-gemini.mjs GENRE_FLAGS and PRIMARY_GENRES). */
export const GENRE_VALUES: Record<string, readonly string[]> = {
  is_rpg: YNU,
  is_turn_based: YNU,
  is_action: YNU,
  is_strategy_tactics: YNU,
  is_sim_management: YNU,
  is_roguelike_deckbuilder: YNU,
  is_shooter_fps: YNU,
  is_platformer_metroidvania: YNU,
  is_story_narrative: YNU,
  is_sports_racing: YNU,
  is_horror_survival: YNU,
  primary_genre: [
    "RPG",
    "Action",
    "Strategy / Tactics",
    "Sim / Management",
    "Roguelike / Deckbuilder",
    "Shooter / FPS",
    "Platformer / Metroidvania",
    "Story / Narrative",
    "Sports / Racing",
    "Horror / Survival",
    "Puzzle",
    "Adventure",
    "Other",
    "unknown",
  ],
};

const QID = /^Q[1-9]\d*$/;
const DIGITS = /^\d+$/;
/** The only host each kind of stored link may point at. */
const LINK_HOSTS: Record<string, string> = {
  wikidata: "www.wikidata.org",
  steam: "store.steampowered.com",
  wikipedia: "en.wikipedia.org",
};
const FACT_HOSTS = new Set([LINK_HOSTS.wikidata, LINK_HOSTS.steam]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted at every level (sample-check.mjs canonicalJson). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** A file's bytes, its SHA-256 and its JSON Lines records. Errors name the file and line only. */
function readJsonlFile(file: string): { sha256: string; records: unknown[] } {
  const name = path.basename(file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return refuse(`${name} could not be read`);
  }
  const records: unknown[] = [];
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        records.push(JSON.parse(line));
      } catch {
        refuse(`${name}: line ${i + 1} is not JSON`);
      }
    });
  return { sha256: sha256Hex(bytes), records };
}

function readJsonFile(file: string): { text: string; value: unknown } {
  const name = path.basename(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return refuse(`${name} could not be read`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return refuse(`${name} is not JSON`);
  }
}

/** An https link to the one host allowed for its kind, or null. Anything else refuses. */
function checkLink(v: unknown, host: string | Set<string>, what: string): string | null {
  if (v === null || v === undefined) return null;
  let u: URL | null;
  try {
    u = typeof v === "string" ? new URL(v) : null;
  } catch {
    u = null;
  }
  const ok =
    u &&
    u.protocol === "https:" &&
    (typeof host === "string" ? u.hostname === host : host.has(u.hostname));
  if (!ok || u?.username || u?.password || u?.port) refuse(`${what} is not an allowed source link`);
  return v as string;
}

// --- Facts ------------------------------------------------------------------

export type CatalogueFactsOptions = {
  wikidataFile: string;
  agreementFile: string;
  reviewConfirmed: boolean;
  now?: Date;
};

/**
 * Loads every Wikidata item as a CatalogueGames row (title, the Steam app the agreement step
 * compared, the Wikidata revision link), and replaces each agreement item's CatalogueFacts with
 * its `agree` fields. `partial`, `conflict`, `distinct`, `single` and `none` fields are never
 * promoted (SOURCES.md). Games and facts not in these files are left as they are.
 */
export function promoteCatalogueFacts(db: DatabaseType, options: CatalogueFactsOptions) {
  if (!options.reviewConfirmed) refuse("review confirmation is required for promotion");
  const now = (options.now ?? new Date()).toISOString();

  const games = new Map<string, { title: string | null; url: string; steam: string | null }>();
  for (const w of readJsonlFile(options.wikidataFile).records) {
    if (!isObj(w) || typeof w.qid !== "string" || !QID.test(w.qid))
      refuse("a Wikidata record has no valid qid");
    const r = w as Obj & { qid: string };
    if (games.has(r.qid)) refuse(`the Wikidata file lists ${r.qid} twice`);
    const src = isObj(r.source) ? r.source : {};
    const url =
      checkLink(src.revision_url, LINK_HOSTS.wikidata, `${r.qid}'s Wikidata link`) ??
      checkLink(src.url, LINK_HOSTS.wikidata, `${r.qid}'s Wikidata link`) ??
      refuse(`${r.qid} has no Wikidata link`);
    if (r.label !== null && r.label !== undefined && typeof r.label !== "string")
      refuse(`${r.qid}'s label is not text`);
    games.set(r.qid, { title: (r.label as string | null | undefined) ?? null, url, steam: null });
  }
  if (!games.size) refuse("the Wikidata file has no records");

  const facts: Array<[string, string, string, string | null, string]> = [];
  const replaced = new Set<string>();
  const perField: Record<string, number> = Object.fromEntries(
    CATALOGUE_FACT_FIELDS.map((f) => [f, 0]),
  );
  for (const a of readJsonlFile(options.agreementFile).records) {
    if (!isObj(a) || typeof a.qid !== "string" || !QID.test(a.qid))
      refuse("an agreement record has no valid qid");
    const r = a as Obj & { qid: string };
    const game = games.get(r.qid) ?? refuse(`agreement item ${r.qid} is not in the Wikidata file`);
    if (replaced.has(r.qid)) refuse(`the agreement file lists ${r.qid} twice`);
    replaced.add(r.qid);
    if (r.steam_appid !== null && r.steam_appid !== undefined) {
      if (!DIGITS.test(String(r.steam_appid))) refuse(`${r.qid}'s Steam app ID is not a number`);
      game.steam = String(r.steam_appid);
    }
    if (!isObj(r.fields)) refuse(`${r.qid} has no fields`);
    for (const field of CATALOGUE_FACT_FIELDS) {
      const f = (r.fields as Obj)[field];
      if (!isObj(f) || typeof f.status !== "string") refuse(`${r.qid}.${field} has no status`);
      const fr = f as Obj;
      if (fr.status !== "agree") continue;
      if (fr.value === null || fr.value === undefined)
        refuse(`${r.qid}.${field} agrees on no value`);
      if (!Array.isArray(fr.sources) || !fr.sources.length)
        refuse(`${r.qid}.${field} has no source links`);
      for (const s of fr.sources as unknown[])
        if (!checkLink(isObj(s) ? s.url : undefined, FACT_HOSTS, `a source of ${r.qid}.${field}`))
          refuse(`a source of ${r.qid}.${field} has no link`);
      facts.push([
        r.qid,
        field,
        JSON.stringify(fr.value as Json),
        fr.basis === undefined || fr.basis === null ? null : JSON.stringify(fr.basis as Json),
        JSON.stringify(fr.sources as Json),
      ]);
      perField[field]++;
    }
  }

  const upsertGame = db.prepare(
    `INSERT INTO CatalogueGames (qid, title, steam_appid, wikidata_url, loaded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(qid) DO UPDATE SET title = excluded.title, steam_appid = excluded.steam_appid,
       wikidata_url = excluded.wikidata_url, loaded_at = excluded.loaded_at`,
  );
  const clearFacts = db.prepare("DELETE FROM CatalogueFacts WHERE qid = ?");
  const insertFact = db.prepare(
    `INSERT INTO CatalogueFacts (qid, field, value, basis, sources, loaded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const [qid, g] of games) upsertGame.run(qid, g.title, g.steam, g.url, now);
    for (const qid of replaced) clearFacts.run(qid);
    for (const f of facts) insertFact.run(...f, now);
  })();
  return {
    games: games.size,
    items_compared: replaced.size,
    facts: facts.length,
    per_field: perField,
  };
}

// --- Drafts -----------------------------------------------------------------

export type CatalogueDraftsOptions = {
  kind: CatalogueKind;
  /** The draft files, in the order the sample was drawn from them. */
  draftFiles: string[];
  /** The sample-check summary, beside its sheet and meta file. */
  summaryFile: string;
  reviewConfirmed: boolean;
  now?: Date;
};

type DraftRecord = Obj & {
  qid: string;
  at: string;
  status: string;
  generated: unknown;
};

/** The latest record per game for one kind (sample-check.mjs latestOk, before its ok filter). */
export function latestDrafts(recordLists: unknown[][], kind: CatalogueKind) {
  const latest = new Map<string, DraftRecord>();
  for (const records of recordLists)
    for (const r of records) {
      if (!isObj(r) || r.schema !== "mgpl-enrichment/1")
        refuse("a record is not mgpl-enrichment/1");
      if (r.task !== kind) continue;
      if (typeof r.qid !== "string" || !QID.test(r.qid)) refuse("a record has no valid qid");
      if (typeof r.at !== "string") refuse("a record has no time");
      const prev = latest.get(r.qid);
      if (!prev || r.at >= prev.at) latest.set(r.qid, r as DraftRecord);
    }
  return latest;
}

/** The text a reviewer checked: the description, or the generated values as canonical JSON. */
export function catalogueDraftText(r: DraftRecord, kind: CatalogueKind): string {
  const g = r.generated;
  if (kind === "description") {
    const d = isObj(g) ? g.description : undefined;
    if (typeof d !== "string" || !d.trim()) refuse(`${r.qid}'s description is empty`);
    return d as string;
  }
  if (!isObj(g)) refuse(`${r.qid} has no generated values`);
  return canonicalJson(g);
}

/** The value promoted for an ok draft, checked against the options the model was given. */
function draftValue(r: DraftRecord, kind: CatalogueKind): Obj {
  const g = r.generated;
  if (!isObj(g)) return refuse(`${r.qid} has no generated values`);
  if (kind === "description") {
    catalogueDraftText(r, kind);
    return { description: g.description };
  }
  const allowed = kind === "friction" ? FRICTION_VALUES : GENRE_VALUES;
  const keys = Object.keys(g).sort();
  if (keys.join() !== Object.keys(allowed).sort().join())
    refuse(`${r.qid}'s ${kind} draft does not have the expected fields`);
  for (const k of keys)
    if (typeof g[k] !== "string" || !allowed[k].includes(g[k] as string))
      refuse(`${r.qid}'s ${kind} draft has a value outside the options for ${k}`);
  return { ...g };
}

/** Steam's sourced friction facts, as enrich-gemini.mjs copies them beside the draft. */
function sourcedFacts(r: DraftRecord): Obj | null {
  if (r.sourced === undefined || r.sourced === null) return null;
  if (!isObj(r.sourced)) return refuse(`${r.qid}'s sourced facts are not an object`);
  const source = checkLink(r.sourced.source, LINK_HOSTS.steam, `${r.qid}'s Steam link`);
  // A Steam fact that can replace a drafted value must carry its link (SOURCES.md: every fact
  // keeps a link to the source it came from).
  if (r.sourced.save_anytime === true && !source)
    refuse(`${r.qid}'s Steam "Save Anytime" fact has no Steam link`);
  return r.sourced;
}

const SHEET_VERDICTS = ["correct", "minor", "wrong", "unverifiable"] as const;

/** RFC 4180 CSV, comma-separated, tolerating a byte-order mark and LF or CRLF (sample-check.mjs
 * parseCsv). */
export function parseSheetCsv(text: string): string[][] {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (cell !== "") refuse("the sheet has a quote inside an unquoted cell");
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      cell += c;
      i++;
    }
  }
  if (quoted) refuse("the sheet ends inside a quoted cell");
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** The draft cell is the drawn text, or that text with the apostrophe sample-check.mjs adds to a
 * cell a spreadsheet would read as a formula (sample-check.mjs draftMatches). */
function draftCellMatches(cell: string, hash: unknown): boolean {
  if (sha256Hex(cell) === hash) return true;
  return (
    cell.startsWith("'") && /^[=+\-@\t\r]/.test(cell.slice(1)) && sha256Hex(cell.slice(1)) === hash
  );
}

/**
 * The verdicts, counted from the sheet itself, after checking that the meta file holds exactly
 * SAMPLE_LINE.of distinct rows (numbers 1 to n, distinct games, each with a draft hash) and that
 * the sheet has those rows and no others, each with the game and draft that were drawn.
 */
function countSheet(sheetText: string, rows: unknown[]) {
  if (rows.length !== SAMPLE_LINE.of)
    refuse(`the sample has ${rows.length} rows, not ${SAMPLE_LINE.of}`);
  const byN = new Map<string, { qid: string; text_sha256: string }>();
  const seenGames = new Set<string>();
  for (const r of rows) {
    const o = isObj(r) ? r : {};
    const n = o.n;
    if (
      !Number.isInteger(n) ||
      (n as number) < 1 ||
      (n as number) > SAMPLE_LINE.of ||
      typeof o.qid !== "string" ||
      !QID.test(o.qid) ||
      typeof o.text_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(o.text_sha256)
    )
      refuse("a row of the meta file is malformed");
    if (byN.has(String(n)) || seenGames.has(o.qid as string))
      refuse("the meta file repeats a row or a game");
    byN.set(String(n), { qid: o.qid as string, text_sha256: o.text_sha256 as string });
    seenGames.add(o.qid as string);
  }
  const table = parseSheetCsv(sheetText);
  const header = (table[0] ?? []).map((h) => h.trim());
  const col = (name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? refuse(`the sheet has no "${name}" column`) : i;
  };
  const [cn, cq, ch, cd, cv] = ["n", "qid", "text_sha256", "draft", "verdict"].map(col);
  const body = table.slice(1);
  if (body.length !== rows.length) refuse("the sheet's rows are not the meta file's rows");
  const counts: Record<string, number> = {
    correct: 0,
    minor: 0,
    wrong: 0,
    unverifiable: 0,
    unchecked: 0,
  };
  const seen = new Set<string>();
  for (const row of body) {
    const n = (row[cn] ?? "").trim();
    const m = byN.get(n);
    if (!m || seen.has(n)) refuse("the sheet's rows are not the meta file's rows");
    seen.add(n);
    if (
      (row[cq] ?? "").trim() !== m!.qid ||
      (row[ch] ?? "").trim() !== m!.text_sha256 ||
      !draftCellMatches(row[cd] ?? "", m!.text_sha256)
    )
      refuse(`sheet row ${n} does not match the drawn record`);
    const v = (row[cv] ?? "").trim().toLowerCase();
    if (v === "") counts.unchecked++;
    else if ((SHEET_VERDICTS as readonly string[]).includes(v)) counts[v]++;
    else refuse(`sheet row ${n} has a verdict that is not one of ${SHEET_VERDICTS.join(", ")}`);
  }
  return counts;
}

/**
 * Where Steam states a fact that answers a draft field, Steam's fact wins (SOURCES.md: a value
 * with a source link is never replaced by a generated one). The one such field today: Steam's
 * "Save Anytime" category (79) answers `save_system` as `save_anywhere`. Steam not listing a
 * category is not evidence, so it changes nothing.
 */
export function applySteamFacts(value: Obj, sourced: Obj | null): Record<string, Obj> {
  const overrides: Record<string, Obj> = {};
  if (sourced?.save_anytime === true && value.save_system !== "save_anywhere") {
    overrides.save_system = {
      draft: (value.save_system as Json) ?? null,
      value: "save_anywhere",
      basis: "Steam category 79 (Save Anytime)",
      source: (sourced.source as Json) ?? null,
    };
    value.save_system = "save_anywhere";
  }
  return overrides;
}

/** The accepted sample-check summary, with its sheet and meta file checked against it. */
function acceptedSample(summaryFile: string, kind: CatalogueKind) {
  const { text, value } = readJsonFile(summaryFile);
  const s = isObj(value) ? value : refuse("the summary is not a sample-check summary");
  if (s.schema !== "mgpl-sample-check-summary/1")
    refuse("the summary is not a sample-check summary");
  if (s.kind !== kind) refuse(`the summary is for ${String(s.kind)}, not ${kind}`);
  const by = typeof s.accepted_by === "string" ? s.accepted_by.trim() : "";
  const at = typeof s.accepted_at === "string" ? s.accepted_at.trim() : "";
  if (!by || !at)
    refuse("the sample check has not been accepted: accepted_by and accepted_at are empty");
  if (Number.isNaN(Date.parse(at))) refuse("accepted_at is not a date");
  const counts = isObj(s.counts) ? s.counts : refuse("the summary has no counts");
  if (
    s.n !== SAMPLE_LINE.of ||
    s.complete !== true ||
    s.meets_line !== true ||
    counts.unchecked !== 0 ||
    typeof counts.wrong !== "number" ||
    counts.wrong > SAMPLE_LINE.max_wrong
  )
    refuse("the summary does not meet the line: 100 rows, every row checked, at most 3 wrong");
  for (const k of ["correct", "minor", "wrong", "unverifiable", "unchecked"])
    if (!Number.isInteger(counts[k]) || (counts[k] as number) < 0)
      refuse("the summary's counts are not whole numbers");
  const sheetName = typeof s.sheet === "string" ? s.sheet : "";
  if (!/^[^/\\]+\.csv$/.test(sheetName) || sheetName.startsWith("."))
    refuse("the summary does not name its sheet");
  const dir = path.dirname(summaryFile);
  const sheet = path.join(dir, sheetName);
  const metaFile = sheet.replace(/\.csv$/, ".meta.json");
  let sheetBytes: Buffer;
  try {
    sheetBytes = readFileSync(sheet);
  } catch {
    return refuse(`${sheetName} could not be read`);
  }
  if (sha256Hex(sheetBytes) !== s.sheet_sha256) refuse("the sheet has changed since it was scored");
  const meta = readJsonFile(metaFile);
  if (sha256Hex(meta.text) !== s.meta_sha256)
    refuse("the meta file has changed since it was scored");
  const m = isObj(meta.value)
    ? meta.value
    : refuse("the meta file is not a sample-check meta file");
  if (
    m.schema !== "mgpl-sample-check/1" ||
    m.kind !== kind ||
    m.seed !== s.seed ||
    m.n !== s.n ||
    !Array.isArray(m.rows) ||
    canonicalJson(m.inputs) !== canonicalJson(s.inputs)
  )
    refuse("the meta file does not match the summary");
  // The summary's counts are what the operator read when accepting, but anyone who can edit the
  // summary can edit them. So the verdicts are counted again from the sheet, which must hold the
  // drawn rows, and the count must equal the summary's, on which the line was judged above.
  const recount = countSheet(sheetBytes.toString("utf8"), m.rows as unknown[]);
  for (const k of Object.keys(recount))
    if (recount[k] !== counts[k]) refuse("the summary's counts are not the sheet's verdicts");
  const inputs = Array.isArray(s.inputs) ? s.inputs : refuse("the summary lists no inputs");
  return {
    summarySha256: sha256Hex(text),
    seed: String(s.seed),
    acceptedBy: by,
    inputs: inputs as Array<{ file?: unknown; sha256?: unknown }>,
    rows: m.rows as Array<{ qid?: unknown; text_sha256?: unknown }>,
  };
}

/**
 * Promotes the latest `ok` draft of one kind per game from the draft files, under an accepted
 * sample check of exactly those files. Refuses unless:
 * - review is confirmed;
 * - the summary is accepted (accepted_by and accepted_at filled in by the operator), complete,
 *   for this kind, and within the line;
 * - the sheet and meta file are the ones scored (their SHA-256);
 * - the draft files are the ones the sample was drawn from, in the same order (name and SHA-256);
 * - every sampled draft is still each game's latest `ok` draft, with the text that was checked;
 * - every promoted game is already in CatalogueGames (promoteCatalogueFacts runs first).
 *
 * A game whose latest record is `rejected`, `insufficient` or `failed` gets no draft, and any
 * draft of this kind it had is withdrawn. Games not in the files are left as they are.
 */
export function promoteCatalogueDrafts(db: DatabaseType, options: CatalogueDraftsOptions) {
  if (!options.reviewConfirmed) refuse("review confirmation is required for promotion");
  const kind = options.kind;
  if (!CATALOGUE_KINDS.includes(kind)) refuse("unknown kind");
  if (!options.draftFiles?.length) refuse("give the draft files the sample was drawn from");
  const now = (options.now ?? new Date()).toISOString();
  const sample = acceptedSample(options.summaryFile, kind);

  const files = options.draftFiles.map((f) => ({ name: path.basename(f), ...readJsonlFile(f) }));
  const given = files.map((f) => `${f.name}\u0000${f.sha256}`).join("\n");
  const drawn = sample.inputs.map((i) => `${String(i.file)}\u0000${String(i.sha256)}`).join("\n");
  if (given !== drawn)
    refuse("the draft files are not the ones the sample was drawn from (names, hashes and order)");

  const latest = latestDrafts(
    files.map((f) => f.records),
    kind,
  );
  for (const row of sample.rows) {
    const r = typeof row.qid === "string" ? latest.get(row.qid) : undefined;
    if (!r || r.status !== "ok" || sha256Hex(catalogueDraftText(r, kind)) !== row.text_sha256)
      refuse("a sampled draft is not its game's latest ok draft with the text that was checked");
  }

  const known = db.prepare("SELECT 1 FROM CatalogueGames WHERE qid = ?");
  const rows: unknown[][] = [];
  const withdraw: string[] = [];
  let missing = 0;
  let overridden = 0;
  const statuses: Record<string, number> = {};
  for (const [qid, r] of latest) {
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    if (r.status !== "ok") {
      withdraw.push(qid);
      continue;
    }
    if (r.label !== "generated") refuse(`${qid}'s draft is not labelled generated`);
    if (!known.get(qid)) {
      missing++;
      continue;
    }
    const value = draftValue(r, kind);
    const sourced = kind === "friction" ? sourcedFacts(r) : null;
    const overrides = kind === "friction" ? applySteamFacts(value, sourced) : {};
    if (Object.keys(overrides).length) overridden++;
    const inputs = isObj(r.inputs) ? r.inputs : {};
    const links = {
      wikidata: checkLink(inputs.wikidata, LINK_HOSTS.wikidata, `${qid}'s Wikidata link`),
      steam: checkLink(inputs.steam, LINK_HOSTS.steam, `${qid}'s Steam link`),
      wikipedia: checkLink(inputs.wikipedia, LINK_HOSTS.wikipedia, `${qid}'s Wikipedia link`),
    };
    if (typeof r.model !== "string" || !r.model) refuse(`${qid}'s draft names no model`);
    if (typeof r.prompt_version !== "string" || !r.prompt_version)
      refuse(`${qid}'s draft names no prompt version`);
    rows.push([
      qid,
      kind,
      JSON.stringify(value),
      sourced ? JSON.stringify(sourced) : null,
      Object.keys(overrides).length ? JSON.stringify(overrides) : null,
      sha256Hex(catalogueDraftText(r, kind)),
      JSON.stringify(links),
      r.model,
      r.prompt_version,
      typeof r.run_id === "string" ? r.run_id : null,
      typeof r.attempt_id === "string" ? r.attempt_id : null,
      r.at,
    ]);
  }
  if (missing)
    refuse(`${missing} drafted games are not in CatalogueGames; promote the catalogue facts first`);

  const upsert = db.prepare(
    `INSERT INTO CatalogueDrafts (qid, kind, value, label, sourced, overrides, text_sha256, links,
       model, prompt_version, run_id, attempt_id, drafted_at, sample_summary_sha256, sample_seed,
       accepted_by, promoted_at)
     VALUES (?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(qid, kind) DO UPDATE SET value = excluded.value, label = excluded.label,
       sourced = excluded.sourced, overrides = excluded.overrides,
       text_sha256 = excluded.text_sha256, links = excluded.links, model = excluded.model,
       prompt_version = excluded.prompt_version, run_id = excluded.run_id,
       attempt_id = excluded.attempt_id, drafted_at = excluded.drafted_at,
       sample_summary_sha256 = excluded.sample_summary_sha256, sample_seed = excluded.sample_seed,
       accepted_by = excluded.accepted_by, promoted_at = excluded.promoted_at`,
  );
  const remove = db.prepare("DELETE FROM CatalogueDrafts WHERE qid = ? AND kind = ?");
  const withdrawn = db.transaction(() => {
    for (const row of rows)
      upsert.run(...row, sample.summarySha256, sample.seed, sample.acceptedBy, now);
    let n = 0;
    for (const qid of withdraw) n += remove.run(qid, kind).changes;
    return n;
  })();
  return {
    kind,
    promoted: rows.length,
    overridden_by_steam: overridden,
    withdrawn,
    latest_status: statuses,
    sample_seed: sample.seed,
  };
}
