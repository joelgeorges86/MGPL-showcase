// Task proposal 033, WU-033a (#158): the hand sample check of generated catalogue drafts.
// Free; no network call and no billed call.
//
//   node scripts/catalogue/sample-check.mjs draw --kind description --in <drafts.jsonl> [--in <more.jsonl>]
//        --seed <seed> --out <dir> [--n 100] [--titles <wikidata.jsonl>]
//   node scripts/catalogue/sample-check.mjs score --sheet <dir>/sample-description-<seed>.csv
//
// draw: takes the latest record per game for the kind across every --in file (the WU-029 run and
// the WU-030 fill pass), keeps the games whose latest record is `ok`, and picks --n of them at
// random with a seed, so the same inputs and seed always give the same sample. It writes three
// files to --out, which must be outside the repository, and never overwrites one:
//   sample-<kind>-<seed>.csv        the sheet: one row per record, with empty `verdict` and `note`
//   sample-<kind>-<seed>.html       the same rows, with the cited sources as links, for reading
//   sample-<kind>-<seed>.meta.json  the seed, the inputs' SHA-256, and each row's game and text hash
// score: reads the filled sheet, checks every row against the meta file, counts the verdicts and
// writes sample-<kind>-<seed>.summary.json with the error rate and its 95% Wilson interval. The
// summary's `accepted_by` and `accepted_at` are left empty for the Principal Operator to fill in
// by hand; no script writes them, and score refuses to replace a summary that has them.
//
// The console shows counts and file names only, never a draft.
// cspell:words wikidata jsonl Wilson qids
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isMain, readJsonl, ROOT } from "./lib.mjs";

export const KINDS = Object.freeze(["description", "friction", "genre"]);
export const VERDICTS = Object.freeze(["correct", "minor", "wrong", "unverifiable"]);
/** Task proposal 033, decision 2: every row has a verdict and at most 3 are `wrong`, in 100.
 * `unverifiable` rows are counted and reported, not limited (operator, 2026-10-13); they are left
 * out of the error rate's denominator. Meeting the line is not acceptance: the operator decides. */
export const ACCEPTANCE_LINE = Object.freeze({ of: 100, max_wrong: 3 });
export const SHEET_COLUMNS = Object.freeze([
  "n",
  "qid",
  "title",
  "draft",
  "wikidata",
  "steam",
  "wikipedia",
  "text_sha256",
  "verdict",
  "note",
]);
const SCHEMA = "mgpl-enrichment/1";
const SEED_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** An error this script wrote. Its message is always fixed text or a file's base name. */
export class SampleCheckError extends Error {}
const fail = (msg) => {
  throw new SampleCheckError(msg);
};

/** readJsonl, with its error (a base name and a line number) kept as this script's own. */
function readRecords(file) {
  try {
    return readJsonl(file);
  } catch (e) {
    fail(e instanceof Error ? e.message : "a file could not be read");
  }
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted at every level, so equal values always give equal text. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/**
 * The latest record per game for one kind, across the files in the order given, keeping only the
 * games whose latest record is `ok`. Latest is the greatest `at`; on a tie, the later record read.
 * A later `rejected` or `insufficient` record replaces an earlier `ok` one.
 */
export function latestOk(recordLists, kind) {
  if (!KINDS.includes(kind)) fail(`unknown kind; use one of ${KINDS.join(", ")}`);
  const latest = new Map();
  for (const records of recordLists) {
    for (const r of records) {
      if (!r || r.schema !== SCHEMA) fail(`a record is not ${SCHEMA}`);
      if (r.task !== kind) continue;
      if (typeof r.qid !== "string" || !/^Q\d+$/.test(r.qid)) fail("a record has no valid qid");
      if (typeof r.at !== "string") fail("a record has no time");
      const prev = latest.get(r.qid);
      if (!prev || r.at >= prev.at) latest.set(r.qid, r);
    }
  }
  const ok = new Map();
  for (const [qid, r] of latest) {
    if (r.status !== "ok") continue;
    if (r.label !== "generated") fail("an ok record is not labelled generated");
    draftText(r, kind);
    ok.set(qid, r);
  }
  return ok;
}

/** The text a reviewer checks: the description, or the generated values as canonical JSON. */
export function draftText(r, kind) {
  if (kind === "description") {
    const d = r.generated?.description;
    if (typeof d !== "string" || !d.trim()) fail("an ok description record has no text");
    return d;
  }
  if (!r.generated || typeof r.generated !== "object") fail("an ok record has no generated values");
  return canonicalJson(r.generated);
}

/** A number in [0, 1) from the seed and an index: the first 52 bits of SHA-256("seed:index"). */
export function seededUnit(seed, i) {
  const h = createHash("sha256").update(`${seed}:${i}`).digest();
  const hi = h.readUInt32BE(0); // bits 1 to 32
  const lo = h.readUInt32BE(4) >>> 12; // bits 33 to 52
  return (hi * 2 ** 20 + lo) / 2 ** 52;
}

/** n distinct items picked from the list by a partial Fisher-Yates shuffle driven by the seed. */
export function drawSample(items, n, seed) {
  if (!SEED_PATTERN.test(String(seed))) fail("the seed must be 1 to 64 letters, digits or hyphens");
  if (!Number.isInteger(n) || n < 1) fail("--n must be a whole number above 0");
  if (items.length < n) fail(`only ${items.length} eligible records, fewer than --n`);
  const a = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(seededUnit(seed, i) * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** A sheet cell that a spreadsheet would read as a formula gets a leading apostrophe. */
function safeCell(v) {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** CSV text: UTF-8 with a byte-order mark, every field quoted, CRLF line ends (for Excel). */
export function toCsv(rows) {
  const line = (cells) => cells.map((c) => `"${safeCell(c).replace(/"/g, '""')}"`).join(",");
  return `\uFEFF${rows.map(line).join("\r\n")}\r\n`;
}

/** Parses CSV (RFC 4180, comma-separated), tolerating a byte-order mark and LF or CRLF. */
export function parseCsv(text) {
  const s = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
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
      if (cell !== "") fail("the sheet has a quote inside an unquoted cell");
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
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      cell += c;
      i++;
    }
  }
  if (quoted) fail("the sheet ends inside a quoted cell");
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const link = (url, text) =>
  typeof url === "string" && url.startsWith("https://")
    ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(text)}</a>`
    : "";

export function sheetHtml(kind, seed, rows) {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${r.n}</td><td>${escapeHtml(r.title)}<br><small>${escapeHtml(r.qid)}</small></td>` +
        `<td class="d">${escapeHtml(r.draft)}</td><td>${link(r.wikidata, "Wikidata")}<br>` +
        `${link(r.steam, "Steam")}<br>${link(r.wikipedia, "Wikipedia")}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MGPL sample check: ${escapeHtml(kind)} ${escapeHtml(seed)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:16px;max-width:1100px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:6px;vertical-align:top}td.d{max-width:560px}small{color:#666}</style></head>
<body><h1>Sample check: ${escapeHtml(kind)}, seed ${escapeHtml(seed)}</h1>
<p>Every draft below is <strong>generated</strong>. Check each against its cited sources, then enter a verdict in the
CSV sheet with the same name: <code>correct</code>, <code>minor</code>, <code>wrong</code> or <code>unverifiable</code>,
and a note where useful. This page is for reading only; the CSV is what is scored.</p>
<table><thead><tr><th>n</th><th>Game</th><th>Draft</th><th>Sources</th></tr></thead><tbody>
${body}
</tbody></table></body></html>
`;
}

/** True if p, a resolved path with links already resolved, is the repository or inside it. */
function insideRepo(p) {
  const rel = path.relative(realpathSync(ROOT), p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Where a path would land: its nearest existing ancestor with links resolved, plus the rest. */
export function landingPath(p) {
  let existing = path.resolve(p);
  const rest = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

/** The folder, created if needed, provided it is outside the repository. It is checked before it
 * is created, through any link in the part that exists (so a refused folder is never made), and
 * again after. */
function outsideRepo(dir, what = "--out") {
  if (insideRepo(landingPath(dir))) fail(`${what} must be outside the repository`);
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  if (insideRepo(real)) fail(`${what} must be outside the repository`);
  return real;
}

const fileBase = (kind, seed) => `sample-${kind}-${seed}`;

/** draw: see the header. Returns { eligible, files }. */
export function draw({
  kind,
  inputs,
  seed,
  n = ACCEPTANCE_LINE.of,
  out,
  titles = null,
  now = new Date(),
}) {
  if (!KINDS.includes(kind)) fail(`unknown kind; use one of ${KINDS.join(", ")}`);
  if (!SEED_PATTERN.test(String(seed))) fail("the seed must be 1 to 64 letters, digits or hyphens");
  if (!inputs?.length) fail("give at least one --in file");
  const dir = outsideRepo(out);
  const base = fileBase(kind, seed);
  const files = ["csv", "html", "meta.json"].map((ext) => path.join(dir, `${base}.${ext}`));
  for (const f of files)
    if (existsSync(f)) fail(`${path.basename(f)} already exists; use another seed`);
  const inputInfo = [];
  const lists = inputs.map((file) => {
    if (!existsSync(file)) fail(`${path.basename(file)} does not exist`);
    const records = readRecords(file);
    inputInfo.push({
      file: path.basename(file),
      sha256: sha256(readFileSync(file)),
      records: records.length,
    });
    return records;
  });
  const ok = latestOk(lists, kind);
  const qids = [...ok.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const picked = drawSample(qids, n, seed);
  let labels = new Map();
  let titlesInfo = null;
  if (titles) {
    if (!existsSync(titles)) fail(`${path.basename(titles)} does not exist`);
    const want = new Set(picked);
    for (const w of readRecords(titles)) if (want.has(w?.qid)) labels.set(w.qid, w.label ?? "");
    titlesInfo = { file: path.basename(titles), sha256: sha256(readFileSync(titles)) };
  }
  const rows = picked.map((qid, i) => {
    const r = ok.get(qid);
    const draft = draftText(r, kind);
    return {
      n: i + 1,
      qid,
      title: labels.get(qid) ?? "",
      draft,
      wikidata: r.inputs?.wikidata ?? "",
      steam: r.inputs?.steam ?? "",
      wikipedia: r.inputs?.wikipedia ?? "",
      text_sha256: sha256(draft),
      run_id: r.run_id ?? null,
      attempt_id: r.attempt_id ?? null,
    };
  });
  const csv = toCsv([
    [...SHEET_COLUMNS],
    ...rows.map((r) => SHEET_COLUMNS.map((c) => (c === "verdict" || c === "note" ? "" : r[c]))),
  ]);
  const meta = {
    schema: "mgpl-sample-check/1",
    kind,
    seed: String(seed),
    n,
    eligible: qids.length,
    inputs: inputInfo,
    titles: titlesInfo,
    drawn_at: now.toISOString(),
    sheet_sha256_at_draw: sha256(csv),
    rows: rows.map(({ n: rn, qid, text_sha256, run_id, attempt_id }) => ({
      n: rn,
      qid,
      text_sha256,
      run_id,
      attempt_id,
    })),
  };
  writeFileSync(files[0], csv, { flag: "wx" });
  writeFileSync(files[1], sheetHtml(kind, seed, rows), { flag: "wx" });
  writeFileSync(files[2], `${JSON.stringify(meta, null, 2)}\n`, { flag: "wx" });
  return { eligible: qids.length, files: files.map((f) => path.basename(f)) };
}

/** The 95% Wilson score interval for k in n; null when n is 0. */
export function wilson(k, n, z = 1.959963984540054) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return { low: r4(Math.max(0, (c - m) / d)), high: r4(Math.min(1, (c + m) / d)) };
}

/** The sheet's draft cell is the drawn text, or that text with the apostrophe toCsv adds to a
 * cell a spreadsheet would read as a formula. */
export function draftMatches(cell, hash) {
  if (sha256(cell) === hash) return true;
  return (
    cell.startsWith("'") && /^[=+\-@\t\r]/.test(cell.slice(1)) && sha256(cell.slice(1)) === hash
  );
}

/** What a directory entry is, without following a link: absent, file, link or other. A dangling
 * link counts as a link, not as absent. */
export function entryKind(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (e?.code === "ENOENT") return "absent";
    throw e;
  }
  if (st.isSymbolicLink()) return "link";
  return st.isFile() ? "file" : "other";
}

/** Writes the summary to a new file beside it, created exclusively, then renames it into place.
 * A rename replaces the directory entry itself and never writes through a link that appeared
 * after the check. */
function writeSummary(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { flag: "wx" });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** score: see the header. Returns the summary written. */
export function score({ sheet, now = new Date() }) {
  if (!sheet || !sheet.endsWith(".csv")) fail("--sheet must be the .csv file draw wrote");
  if (!existsSync(sheet)) fail(`${path.basename(sheet)} does not exist`);
  const metaFile = sheet.replace(/\.csv$/, ".meta.json");
  const summaryFile = sheet.replace(/\.csv$/, ".summary.json");
  if (!existsSync(metaFile)) fail(`${path.basename(metaFile)} does not exist`);
  if (insideRepo(realpathSync(path.dirname(sheet))))
    fail("the sheet must be outside the repository");
  const summaryEntry = entryKind(summaryFile);
  if (summaryEntry !== "absent" && summaryEntry !== "file")
    fail(`${path.basename(summaryFile)} exists and is not a plain file; move it aside first`);
  const metaText = readFileSync(metaFile, "utf8");
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    fail(`${path.basename(metaFile)} is not JSON`);
  }
  if (meta?.schema !== "mgpl-sample-check/1" || !Array.isArray(meta.rows))
    fail(`${path.basename(metaFile)} is not a sample-check meta file`);
  if (summaryEntry === "file") {
    let prev = null;
    try {
      prev = JSON.parse(readFileSync(summaryFile, "utf8"));
    } catch {
      fail(`${path.basename(summaryFile)} exists and is not JSON; move it aside first`);
    }
    if (prev?.accepted_by || prev?.accepted_at)
      fail(`${path.basename(summaryFile)} is already accepted; it is not replaced`);
  }
  const sheetBytes = readFileSync(sheet);
  const table = parseCsv(sheetBytes.toString("utf8"));
  if (!table.length) fail("the sheet is empty");
  const header = table[0].map((h) => h.trim());
  const col = Object.fromEntries(SHEET_COLUMNS.map((c) => [c, header.indexOf(c)]));
  for (const c of SHEET_COLUMNS) if (col[c] < 0) fail(`the sheet has no "${c}" column`);
  const rows = table.slice(1);
  if (rows.length !== meta.rows.length) fail("the sheet's row count differs from the meta file");
  const counts = Object.fromEntries([...VERDICTS, "unchecked"].map((v) => [v, 0]));
  const byN = new Map(meta.rows.map((r) => [String(r.n), r]));
  const seen = new Set();
  for (const row of rows) {
    const n = (row[col.n] ?? "").trim();
    const m = byN.get(n);
    if (!m || seen.has(n))
      fail(`sheet row "n" ${JSON.stringify(n).slice(0, 12)} is not in the meta file once`);
    seen.add(n);
    if (
      (row[col.qid] ?? "").trim() !== m.qid ||
      (row[col.text_sha256] ?? "").trim() !== m.text_sha256 ||
      !draftMatches(row[col.draft] ?? "", m.text_sha256)
    )
      fail(`sheet row ${n} does not match the drawn record`);
    const v = (row[col.verdict] ?? "").trim().toLowerCase();
    if (v === "") counts.unchecked++;
    else if (VERDICTS.includes(v)) counts[v]++;
    else fail(`sheet row ${n} has a verdict that is not one of ${VERDICTS.join(", ")}`);
  }
  const checked = counts.correct + counts.minor + counts.wrong;
  const complete = counts.unchecked === 0;
  const meetsLine =
    complete && meta.n === ACCEPTANCE_LINE.of && counts.wrong <= ACCEPTANCE_LINE.max_wrong;
  const summary = {
    schema: "mgpl-sample-check-summary/1",
    kind: meta.kind,
    seed: meta.seed,
    sheet: path.basename(sheet),
    sheet_sha256: sha256(sheetBytes),
    meta_sha256: sha256(metaText),
    inputs: meta.inputs,
    n: meta.n,
    counts,
    checked,
    error_rate: checked ? Math.round((counts.wrong / checked) * 1e4) / 1e4 : null,
    wilson95: wilson(counts.wrong, checked),
    complete,
    line: { ...ACCEPTANCE_LINE },
    meets_line: meetsLine,
    scored_at: now.toISOString(),
    accepted_by: "",
    accepted_at: "",
    acceptance_note:
      "accepted_by and accepted_at are filled in by the Principal Operator by hand. No script writes them.",
  };
  writeSummary(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** Splits argv into the command and options; --in may be repeated. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "draw" && cmd !== "score") fail("the command must be draw or score");
  const spec = cmd === "draw" ? ["kind", "in", "seed", "out", "n", "titles"] : ["sheet"];
  const opts = { in: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (!name || !spec.includes(name)) fail("unknown or misplaced option; see the script's header");
    const v = rest[++i];
    if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
    if (name === "in") opts.in.push(v);
    else if (name in opts && name !== "in") fail(`--${name} is given twice`);
    else opts[name] = v;
  }
  if (opts.n !== undefined) {
    if (!/^\d+$/.test(opts.n)) fail("--n must be a whole number");
    opts.n = Number(opts.n);
  }
  return { cmd, opts };
}

export function main(argv, log = console.log) {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === "draw") {
    for (const k of ["kind", "seed", "out"]) if (!opts[k]) fail(`--${k} is required`);
    const r = draw({
      kind: opts.kind,
      inputs: opts.in,
      seed: opts.seed,
      n: opts.n ?? ACCEPTANCE_LINE.of,
      out: opts.out,
      titles: opts.titles ?? null,
    });
    log(`eligible ${r.eligible}; wrote ${r.files.join(", ")}`);
  } else {
    const s = score({ sheet: opts.sheet });
    const c = s.counts;
    log(
      `correct ${c.correct}, minor ${c.minor}, wrong ${c.wrong}, unverifiable ${c.unverifiable}, unchecked ${c.unchecked}`,
    );
    log(
      `error rate ${s.error_rate ?? "n/a"} (95% Wilson ${s.wilson95 ? `${s.wilson95.low}-${s.wilson95.high}` : "n/a"}); ` +
        `complete ${s.complete}; meets the line ${s.meets_line}`,
    );
    log(`wrote ${s.sheet.replace(/\.csv$/, ".summary.json")}`);
  }
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(
      e instanceof SampleCheckError ? `error: ${e.message}` : `error: ${e?.name ?? "Error"}`,
    );
    process.exit(2);
  }
}
