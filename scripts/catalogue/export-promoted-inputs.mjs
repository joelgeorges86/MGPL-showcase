// WU-034: the operator exporter of the promoted reference catalogue. Free: no network call and
// no write to the database.
//
//   node scripts/catalogue/export-promoted-inputs.mjs \
//     --kind <description|friction|genre> \
//     --db <file> --out <bundle folder> \
//     [--summary <accepted summary> --drafts <drafts folder>]  (friction/genre only) \
//     [--qid <QID> ...] [--validate-only]
//
// Produces one kind-specific snapshot, not a mixed dump:
//   friction/genre -> snapshot.jsonl rows of schema "mgpl-promoted-embedding-input/2",
//                     the input scripts/catalogue/embed-descriptions.mjs --promoted-input reads.
//   description    -> snapshot.jsonl rows of schema "mgpl-description-check-input/2",
//                     the input scripts/catalogue/enrich-gemini.mjs --task check --check-input reads.
// manifest.json sits beside snapshot.jsonl: exporter provenance, the verified summary and draft
// hashes and accepted input order, the snapshot hash, and reconciling counts.
//
// The database is opened read-only and read in one transaction. The accepted summary, its
// sheet/meta evidence and the exact named draft bytes are read and verified (the same checks the
// promotion and the consumers run), and the candidate snapshot is re-validated through the
// shipped buildPromotedItems/loadCheckInput validators before publication. Reviewed text and
// draft_file come from the accepted draft records, never from CatalogueDrafts.value/sourced/
// overrides, and Wikipedia source text is never fetched or written.
//
// Publication is one directory rename: the two files are written into a temp bundle folder and
// renamed into place. A destination lock folder keeps cooperating invocations from racing, the
// destination is never overwritten, and only resources this invocation created are cleaned up.
// --validate-only runs the same checks and prints the counts without publishing. See
// DOCS/catalogue/EXPORT.md.
// cspell:words jsonl qid qids sha wikidata steampowered mgpl
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, ROOT } from "./lib.mjs";
import { KINDS, landingPath, latestOk, sha256 } from "./sample-check.mjs";
import { buildPromotedItems, checkAcceptance, embeddingText } from "./embed-descriptions.mjs";
import { loadCheckInput, parseCheckSourceUrl } from "./enrich-gemini.mjs";

export const EMBEDDING_SCHEMA = "mgpl-promoted-embedding-input/2";
export const CHECK_SCHEMA = "mgpl-description-check-input/2";
export const MANIFEST_SCHEMA = "mgpl-catalogue-export/2";
export const SNAPSHOT_NAME = "snapshot.jsonl";
export const MANIFEST_NAME = "manifest.json";

const SELF = fileURLToPath(import.meta.url);
const QID = /^Q[1-9]\d*$/;

/** An error this script wrote. Its message is fixed text or a file's base name. */
export class ExportError extends Error {}
const fail = (msg) => {
  throw new ExportError(msg);
};

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const qidNum = (q) => Number(q.slice(1));

function parseJsonlBytes(bytes, name) {
  const out = [];
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((l, i) => {
      if (!l.trim()) return;
      try {
        out.push(JSON.parse(l));
      } catch {
        fail(`${name}: line ${i + 1} is not JSON`);
      }
    });
  return out;
}

/** True if p, a resolved path with links already resolved, is the repository or inside it. */
function insideRepo(p) {
  const rel = path.relative(realpathSync(ROOT), p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The draft files the accepted summary names, read exactly and in the accepted input order. */
function readDraftSnapshot(draftsDir, inputs) {
  return inputs.map((i) => {
    const name = String(i?.file ?? "");
    if (!name || name.includes("/") || name.includes("\\") || name.startsWith("."))
      fail("the summary names an invalid input file");
    const file = path.join(draftsDir, name);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      fail(`${name} cannot be read`);
    }
    if (sha256(bytes) !== i.sha256) fail(`${name} has changed since the summary was scored`);
    return { name, sha256: sha256(bytes), records: parseJsonlBytes(bytes, name) };
  });
}

/** The promoted rows for one kind, read once on a read-only connection, in one transaction. */
function readCatalogue(dbPath, kind) {
  const db = new Database(dbPath, { fileMustExist: true, readonly: true });
  try {
    return db.transaction(() => {
      const titles = new Map();
      for (const g of db.prepare("SELECT qid, title FROM CatalogueGames").all())
        titles.set(g.qid, g.title);
      const rows = db
        .prepare("SELECT * FROM CatalogueDrafts WHERE kind = ? ORDER BY qid")
        .all(kind);
      return { titles, rows };
    })();
  } finally {
    db.close();
  }
}

/** Whether a pinned source URL conforms to the shipped check-source rule (https Wikipedia rev). */
function conformsPinnedSource(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    parseCheckSourceUrl(url);
    return true;
  } catch {
    return false;
  }
}

const PROVENANCE_FILES = [
  "scripts/catalogue/export-promoted-inputs.mjs",
  "scripts/catalogue/embed-descriptions.mjs",
  "scripts/catalogue/enrich-gemini.mjs",
  "scripts/catalogue/sample-check.mjs",
  "scripts/catalogue/lib.mjs",
];

function defaultGitRun(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The exporter's revision provenance: the HEAD commit, and whether the exporter (or a validator it
 * imports) carries uncommitted changes, so a clean commit means the commit identifies those bytes.
 */
export function resolveProvenance(git = defaultGitRun) {
  const commit = git(["rev-parse", "HEAD"]);
  if (!commit || !/^[0-9a-f]{40,}$/.test(commit))
    fail("cannot resolve the exporter's revision provenance");
  const status = git(["status", "--porcelain", "--", ...PROVENANCE_FILES]);
  return { commit, dirty: status === null || status !== "" };
}

/**
 * Builds the kind-specific snapshot and manifest, and re-validates the snapshot through the
 * shipped validator, all in memory. Throws (ExportError, or UsageError from the shipped
 * validators) on any failed check; nothing is written here.
 */
export function buildExport({
  kind,
  summaryFile = null,
  draftsDir = null,
  dbPath,
  qids = null,
  now = new Date(),
  deps = {},
}) {
  if (!KINDS.includes(kind)) fail("--kind must be description, friction or genre");
  if (!dbPath || !existsSync(dbPath)) fail("--db must name the promoted database");
  if (qids)
    for (const q of qids)
      if (typeof q !== "string" || !QID.test(q)) fail(`${q} is not a valid qid`);
  const wanted = qids && qids.length ? new Set(qids) : null;
  const isEmbedding = kind !== "description";

  // E: the accepted summary, its sheet/meta evidence and the exact named draft bytes.
  let ordered = null;
  let accRecord = null;
  let summarySha256 = null;
  let summaryInputsList = [];
  if (isEmbedding) {
    if (!summaryFile || !existsSync(summaryFile)) fail("--summary must name the accepted summary");
    if (!draftsDir || !existsSync(draftsDir)) fail("--drafts must name the drafts folder");
    let summaryText;
    try {
      summaryText = readFileSync(summaryFile, "utf8");
    } catch {
      fail(`${path.basename(summaryFile)} cannot be read`);
    }
    let s;
    try {
      s = JSON.parse(summaryText);
    } catch {
      fail(`${path.basename(summaryFile)} is not JSON`);
    }
    if (s?.schema !== "mgpl-sample-check-summary/1" || !KINDS.includes(s?.kind))
      fail("the summary is not a sample-check summary");
    if (s.kind !== kind) fail(`the summary is for ${s.kind}, not ${kind}`);
    const inputs = Array.isArray(s.inputs) ? s.inputs : [];
    if (!inputs.length) fail("the summary lists no inputs");
    const snapshot = readDraftSnapshot(draftsDir, inputs);
    const acc = checkAcceptance(summaryFile, snapshot, kind);
    summarySha256 = acc.record.summary_sha256;
    ordered = acc.ordered;
    accRecord = acc.record;
    summaryInputsList = inputs.map((i) => ({ file: String(i.file), sha256: String(i.sha256) }));
  }

  const { titles, rows } = readCatalogue(dbPath, kind);

  // The selected cohort: for E, the rows whose accepted summary is the one supplied; for G, every
  // promoted description row.
  const cohortRows = [];
  const otherHashes = new Set();
  let otherRows = 0;
  for (const r of rows) {
    if (isEmbedding && r.sample_summary_sha256 !== summarySha256) {
      otherRows++;
      otherHashes.add(r.sample_summary_sha256);
    } else {
      cohortRows.push(r);
    }
  }

  // E: the latest ok drafts and the winning file, in the accepted summary's inputs order.
  let ok = null;
  let winningFile = null;
  if (isEmbedding) {
    ok = latestOk(
      ordered.map((f) => f.records),
      kind,
    );
    winningFile = new Map();
    for (const f of ordered)
      for (const r of f.records) if (r?.qid && ok.get(r.qid) === r) winningFile.set(r.qid, f.name);
  }

  // Explicit targets must all be in the selected cohort; never silently reduce the requested set.
  const byQid = new Map(cohortRows.map((r) => [r.qid, r]));
  if (wanted) {
    for (const q of wanted)
      if (!byQid.has(q)) fail(`requested ${q} is not in the selected ${kind} cohort`);
  }

  const outRows = [];
  const counts = {
    requested_kind_rows: rows.length,
    selected_cohort_rows: cohortRows.length,
    other_cohort_rows: otherRows,
    other_cohort_hashes: otherHashes.size,
    selected: 0,
    unselected_narrowed: 0,
    excluded_missing_pinned_source: 0,
  };

  const qidsOrder = cohortRows.map((r) => r.qid).sort((a, b) => qidNum(a) - qidNum(b));
  for (const q of qidsOrder) {
    const row = byQid.get(q);
    if (wanted && !wanted.has(q)) {
      counts.unselected_narrowed++;
      continue;
    }
    if (isEmbedding) {
      if (!ok.has(q)) fail(`${q} has no accepted winning draft record`);
      const rec = ok.get(q);
      const text = embeddingText(kind, { [kind]: rec.generated });
      if (sha256(text) !== row.text_sha256)
        fail(`${q}'s draft digest does not match the promoted row's text_sha256`);
      outRows.push({
        schema: EMBEDDING_SCHEMA,
        qid: q,
        kind,
        text_sha256: sha256(text),
        promoted_at: row.promoted_at,
        sample_summary_sha256: row.sample_summary_sha256,
        draft_file: winningFile.get(q),
      });
    } else {
      // G: the exact database value.description, verified against the promoted text_sha256, and
      // the promoted row's pinned source, promoted_at and sample_summary_sha256.
      let value;
      try {
        value = JSON.parse(row.value);
      } catch {
        fail(`${q}'s value is not JSON`);
      }
      const description = isObj(value) ? value.description : undefined;
      if (typeof description !== "string" || !description.trim())
        fail(`${q}'s description is empty`);
      if (sha256(description) !== row.text_sha256)
        fail(`${q}'s description digest does not match the promoted row's text_sha256`);
      let links;
      try {
        links = JSON.parse(row.links);
      } catch {
        fail(`${q}'s links are not JSON`);
      }
      const pinned = isObj(links) ? links.wikipedia : undefined;
      if (!conformsPinnedSource(pinned)) {
        counts.excluded_missing_pinned_source++;
        continue;
      }
      const out = {
        schema: CHECK_SCHEMA,
        qid: q,
        description,
        description_sha256: sha256(description),
        promoted_at: row.promoted_at,
        sample_summary_sha256: row.sample_summary_sha256,
        source: { url: pinned },
      };
      const title = titles.get(q);
      if (typeof title === "string" && title.trim()) out.title = title;
      outRows.push(out);
    }
    counts.selected++;
  }

  if (!counts.selected) fail("the selection is empty; nothing to export");

  const snapshotText = `${outRows.map((r) => JSON.stringify(r)).join("\n")}\n`;

  // Re-validate the candidate snapshot through the shipped validators, from a scratch file.
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "mgpl-export-validate-"));
  try {
    const scratch = path.join(scratchDir, SNAPSHOT_NAME);
    writeFileSync(scratch, snapshotText, { flag: "wx" });
    if (isEmbedding) buildPromotedItems(scratch, ordered, accRecord, kind);
    else loadCheckInput(scratch);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const provenance = resolveProvenance(deps.git);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    kind,
    generated_at: now.toISOString(),
    exporter: {
      script: path.relative(ROOT, SELF).split(path.sep).join("/"),
      sha256: sha256(readFileSync(SELF)),
      commit: provenance.commit,
      dirty: provenance.dirty,
    },
    database: { path: path.basename(dbPath) },
    snapshot: {
      file: SNAPSHOT_NAME,
      bytes: Buffer.byteLength(snapshotText, "utf8"),
      records: outRows.length,
      sha256: sha256(snapshotText),
    },
    summary: isEmbedding
      ? {
          file: path.basename(summaryFile),
          sha256: summarySha256,
          seed: accRecord.seed,
          accepted_at: accRecord.accepted_at,
          inputs_order: [...accRecord.inputs_order],
          inputs: summaryInputsList,
        }
      : null,
    drafts: isEmbedding ? ordered.map((f) => ({ file: f.name, sha256: f.sha256 })) : [],
    counts,
  };

  return { snapshotText, manifest, counts, rows: outRows };
}

/**
 * Publishes the snapshot and manifest into one completed bundle directory at `out`, using one
 * directory rename and a destination lock. Never overwrites; cleans up only what it created.
 */
export function publish({ out, snapshotText, manifest }) {
  if (!out) fail("--out is required");
  const finalDir = path.resolve(out);
  if (insideRepo(landingPath(finalDir))) fail("--out must be outside the repository");
  const parent = path.dirname(finalDir);
  mkdirSync(parent, { recursive: true });

  if (existsSync(finalDir)) fail(`${path.basename(finalDir)} already exists; use another --out`);

  const lockDir = `${finalDir}.lock`;
  const tempDir = path.join(parent, `.${path.basename(finalDir)}.tmp.${process.pid}`);
  let locked = false;
  let madeTemp = false;
  try {
    try {
      mkdirSync(lockDir);
      locked = true;
    } catch (e) {
      if (e?.code === "EEXIST") fail("another export is publishing to this destination");
      throw e;
    }
    mkdirSync(tempDir);
    madeTemp = true;
    writeFileSync(path.join(tempDir, SNAPSHOT_NAME), snapshotText, { flag: "wx" });
    writeFileSync(path.join(tempDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(tempDir, finalDir);
  } catch (e) {
    if (madeTemp) rmSync(tempDir, { recursive: true, force: true });
    throw e;
  } finally {
    if (locked) {
      try {
        rmdirSync(lockDir);
      } catch {
        /* the lock is advisory; leave it if it cannot be removed */
      }
    }
  }
  return { out: finalDir, files: [SNAPSHOT_NAME, MANIFEST_NAME], manifest };
}

export function writeBundle({ kind, summaryFile, draftsDir, dbPath, out, qids, now = new Date() }) {
  const built = buildExport({ kind, summaryFile, draftsDir, dbPath, qids, now });
  const pub = publish({ out, snapshotText: built.snapshotText, manifest: built.manifest });
  return { ...built, out: pub.out, files: pub.files };
}

export function parseArgs(argv) {
  const opts = { qid: [] };
  const known = new Set(["kind", "summary", "drafts", "out", "db", "qid", "validate-only"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!known.has(name)) fail(`unknown option --${name}`);
    if (name === "validate-only") {
      opts["validate-only"] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
    if (name === "qid") opts.qid.push(v);
    else if (name in opts) fail(`--${name} is given twice`);
    else opts[name] = v;
  }
  return opts;
}

export function main(argv, log = console.log) {
  const opts = parseArgs(argv);
  const dbPath = opts.db ?? process.env.DB_PATH ?? path.resolve(process.cwd(), "mpgl_app.db");
  const qids = opts.qid.length ? opts.qid : null;
  const isEmbedding = opts.kind !== "description";
  const built = buildExport({
    kind: opts.kind,
    summaryFile: isEmbedding ? opts.summary : null,
    draftsDir: isEmbedding ? opts.drafts : null,
    dbPath,
    qids,
    now: new Date(),
  });
  if (opts["validate-only"]) {
    log(
      `validate-only: selected ${built.counts.selected}, narrowed out ${built.counts.unselected_narrowed}, ` +
        `missing a pinned source ${built.counts.excluded_missing_pinned_source}, ` +
        `other cohort rows ${built.counts.other_cohort_rows} (${built.counts.other_cohort_hashes} hashes); no bundle published`,
    );
    return built;
  }
  const pub = publish({
    out: opts.out,
    snapshotText: built.snapshotText,
    manifest: built.manifest,
  });
  log(
    `exported ${built.counts.selected} ${opts.kind} records to ${pub.out}; wrote ${pub.files.join(", ")}`,
  );
  return { ...built, ...pub };
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    const msg =
      e instanceof ExportError
        ? e.message
        : e?.code
          ? `${e.message} (${e.code})`
          : (e?.name ?? "Error");
    console.error(`error: ${msg}`);
    process.exit(2);
  }
}
