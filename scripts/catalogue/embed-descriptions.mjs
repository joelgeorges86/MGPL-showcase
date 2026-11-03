// Task proposal 032, WU-032 (#199): one embedding per described game, for "games like X" (#158).
//
//   node scripts/catalogue/embed-descriptions.mjs [--limit N]                       (dry run)
//   node scripts/catalogue/embed-descriptions.mjs --run --entry "#199" --reserve 3 \
//        --out <the entry's output folder> \
//        --sample-summary <the accepted sample-description-....summary.json> [--limit N] [--batch 100]
//
// Reads the description drafts the WU-029 and WU-030 runs wrote to --out
// (enrich-gemini-description-wikipedia.jsonl and enrich-gemini-description-none.jsonl), takes
// the latest record per game and keeps the games whose latest record is `ok` (the same rule as
// sample-check.mjs). Each game's text is its Wikidata label, a full stop and its description.
// The texts go to text-embedding-005 in us-central1 through the AGENTS.md section 3.1 run guard,
// in batches of --batch (default 100, at most 250), one request at a time, as SEMANTIC_SIMILARITY
// at 768 dimensions with autoTruncate off. Every vector is written to
//   <out>/embed-descriptions-text-embedding-005-768.jsonl
// with the text's SHA-256 and the run and attempt it came from; a game already embedded with
// the same text is skipped, so an interrupted run resumes and a changed description is embedded
// again. An aggregate record of the run is written beside it.
//
// --run starts only after the Principal Operator has accepted the 100-record sample check of the
// description drafts (AGENTS.md section 3.1, entry #199; task proposal 033): --sample-summary must
// be that summary, with accepted_by and accepted_at filled in, meeting its line, and naming
// exactly the description files read here, by name and SHA-256. This is checked before a run is
// opened.
//
// The console shows counts and costs only, never a title, a description or a vector, and an
// error is named only by its kind. The embedding outputs are written only to --out, which must be
// the folder the entry names; the run guard keeps its spend ledger and lock in its records folder.
// cspell:words wikidata jsonl aiplatform embs genai qids
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, truncateSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GuardRefusal,
  ROOT,
  UsageError,
  createCapture,
  createClient,
  errorKind,
  expectedEndpoint,
  forbidNetwork,
  isMain,
  loadRates,
  maxPredictCostUsd,
  openRun,
  parseArgs,
  printDryRun,
  rateRef,
  round,
  utcStamp,
} from "../probes/act08/lib.mjs";
import {
  FRICTION_OPTIONS,
  GENRE_FLAGS,
  PRIMARY_GENRES,
  cliMessage,
  entryHeadroom,
  outputFile,
} from "./enrich-gemini.mjs";
import { DEFAULT_DATA_DIR, appendJsonl, readJsonl, sleepMs } from "./lib.mjs";
import { isInside } from "./match-titles.mjs";
import { ACCEPTANCE_LINE, canonicalJson, latestOk } from "./sample-check.mjs";

export const SCRIPT = "embed-descriptions";
export const MODEL = "text-embedding-005";
export const LOCATION = "us-central1";
export const DIMENSIONS = 768;
export const TASK_TYPE = "SEMANTIC_SIMILARITY";
export const DEFAULT_BATCH = 100;
export const MAX_BATCH = 250;
/**
 * The model takes at most 2,048 tokens per text and 20,000 per request. Without a local tokenizer
 * the only provable bound is the UTF-8 byte count: every token stands for at least one byte. So a
 * text is sent only if it is at most 2,000 bytes, and a request's texts total at most 19,000 bytes.
 * The margins (48 tokens a text, 1,000 a request) cover any tokens the service adds around a text.
 */
export const MAX_TEXT_BYTES = 2_000;
export const MAX_REQUEST_BYTES = 19_000;
export const MAX_RESERVE_USD = 5;
export const REQUEST_TIMEOUT_MS = 120_000;
export const BACKOFF_MS = Object.freeze([5_000, 20_000, 60_000]);
export const STOP_AFTER_FAILURES = 3;
export const SCHEMA = "mgpl-embedding/1";
export const TEXT_KINDS = Object.freeze(["description", "title", "friction", "genre"]);

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const RETRYABLE = (status) => status === 429 || (status >= 500 && status < 600);
const YNU = ["yes", "no", "unknown"];

function compareScalarOrder(a, b) {
  const ac = Array.from(a);
  const bc = Array.from(b);
  const len = Math.min(ac.length, bc.length);
  for (let i = 0; i < len; i++) {
    const diff = ac[i].codePointAt(0) - bc[i].codePointAt(0);
    if (diff !== 0) return diff;
  }
  return ac.length - bc.length;
}

export function vectorsFile(out, kind = "description") {
  if (!TEXT_KINDS.includes(kind))
    throw new UsageError("--text must be description, title, friction or genre", "WU034_EMB_TEXT_KIND");
  if (kind === "description") return path.join(out, `${SCRIPT}-${MODEL}-${DIMENSIONS}.jsonl`);
  return path.join(out, `${SCRIPT}-${kind}-${MODEL}-${DIMENSIONS}.jsonl`);
}

/** The text embedded for one game: its label, a full stop unless it ends in one, its description. */
export function textFor(label, description) {
  const t = label.trim();
  return /[.!?]$/.test(t) ? `${t} ${description}` : `${t}. ${description}`;
}

function validateGeneratedDraft(kind, val) {
  if (!val || typeof val !== "object" || Array.isArray(val))
    throw new UsageError(`${kind} draft must be an object`, "WU034_EMB_SHAPE");
  const expected =
    kind === "friction"
      ? FRICTION_OPTIONS
      : {
          ...Object.fromEntries(GENRE_FLAGS.map((f) => [f, YNU])),
          primary_genre: PRIMARY_GENRES,
        };
  const keys = Object.keys(expected);
  const actual = Object.keys(val);
  if (
    actual.length !== keys.length ||
    !keys.every((k) => Object.hasOwn(val, k) && expected[k].includes(val[k]))
  ) {
    throw new UsageError(`${kind} draft fails strict shape/enum validation`, "WU034_EMB_SHAPE");
  }
}

export function embeddingText(kind, record) {
  if (!TEXT_KINDS.includes(kind))
    throw new UsageError("--text must be description, title, friction or genre", "WU034_EMB_TEXT_KIND");
  if (kind === "description") {
    if (
      !record ||
      typeof record.label !== "string" ||
      !record.label.trim() ||
      typeof record.description !== "string" ||
      !record.description.trim()
    ) {
      throw new UsageError("description requires non-empty label and description", "WU034_EMB_SHAPE");
    }
    return textFor(record.label, record.description);
  }
  if (kind === "title") {
    if (!record || typeof record.label !== "string")
      throw new UsageError("title requires a string label", "WU034_TITLE_INPUT");
    const normLabel = record.label.trim().normalize("NFC");
    if (!normLabel) throw new UsageError("title label must not be blank", "WU034_TITLE_INPUT");
    const rawAliases = record.aliases ?? [];
    if (!Array.isArray(rawAliases) || !rawAliases.every((a) => typeof a === "string"))
      throw new UsageError("title aliases must be an array of strings", "WU034_TITLE_INPUT");
    const uniqueAliases = new Set();
    for (const a of rawAliases) {
      const norm = a.trim().normalize("NFC");
      if (norm && norm !== normLabel) uniqueAliases.add(norm);
    }
    const sorted = [...uniqueAliases].sort(compareScalarOrder);
    return [normLabel, ...sorted].join("\n");
  }
  const val =
    record && typeof record === "object" && kind in record
      ? record[kind]
      : record && typeof record === "object" && "generated" in record
        ? record.generated
        : record;
  validateGeneratedDraft(kind, val);
  return canonicalJson(val);
}

/**
 * The games to embed, from the description drafts and the Wikidata labels, ordered by QID
 * number: { items, eligible, no_title, too_long }. Each item is { qid, text, text_sha256,
 * description_run_id, description_attempt_id }.
 */
export function buildItems(recordLists, labels) {
  const ok = latestOk(recordLists, "description");
  const qids = [...ok.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const items = [];
  let noTitle = 0;
  let tooLong = 0;
  for (const qid of qids) {
    const label = labels.get(qid);
    if (typeof label !== "string" || !label.trim()) {
      noTitle++;
      continue;
    }
    const r = ok.get(qid);
    const text = textFor(label, r.generated.description);
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      tooLong++;
      continue;
    }
    items.push({
      qid,
      text,
      text_sha256: sha256(text),
      description_run_id: r.run_id ?? null,
      description_attempt_id: r.attempt_id ?? null,
    });
  }
  return { items, eligible: qids.length, no_title: noTitle, too_long: tooLong };
}

/** Batches of at most `size` texts whose UTF-8 bytes total at most MAX_REQUEST_BYTES, in order. */
export function planBatches(items, size = DEFAULT_BATCH) {
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    const b = Buffer.byteLength(it.text, "utf8");
    if (b > MAX_TEXT_BYTES) throw new UsageError("a text over the per-text byte limit was planned");
    if (cur.length && (cur.length >= size || bytes + b > MAX_REQUEST_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += b;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** The SDK call's arguments for one batch. */
export function embedParams(texts) {
  return {
    model: MODEL,
    contents: texts,
    config: { taskType: TASK_TYPE, outputDimensionality: DIMENSIONS, autoTruncate: false },
  };
}

/** The body @google/genai 2.23.0 sends for embedParams(texts), byte for byte (a test checks). */
export function predictBody(texts) {
  return JSON.stringify({
    instances: texts.map((content) => ({ content, task_type: TASK_TYPE })),
    parameters: { outputDimensionality: DIMENSIONS, autoTruncate: false },
  });
}

/** The largest guard bound among the batches: what the reservation must hold for one request. */
export function planBound(rates, batches) {
  let most = 0;
  for (const b of batches) {
    const v = maxPredictCostUsd(rates, MODEL, predictBody(b.map((i) => i.text))).max_cost_usd;
    if (v > most) most = v;
  }
  return most;
}

/** A vector as base64 of little-endian float32. */
export function encodeVector(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString("base64");
}

export function decodeVector(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** What is wrong with an answer for `n` texts, or null. */
export function answerProblem(res, n) {
  const embs = res?.embeddings;
  if (!Array.isArray(embs) || embs.length !== n) return "wrong number of embeddings";
  for (const e of embs) {
    const v = e?.values;
    if (!Array.isArray(v) || v.length !== DIMENSIONS) return "an embedding has the wrong size";
    if (!v.every((x) => typeof x === "number" && Number.isFinite(x)))
      return "an embedding has a value that is not a finite number";
    if (e?.statistics?.truncated === true) return "a text was truncated";
  }
  return null;
}

function labelsFrom(catalogueDir, wanted) {
  const file = path.join(catalogueDir, "wikidata.jsonl");
  if (!existsSync(file)) throw new UsageError("--catalogue has no wikidata.jsonl");
  const labels = new Map();
  for (const r of readJsonl(file)) if (wanted.has(r?.qid)) labels.set(r.qid, r.label);
  return labels;
}

/**
 * The description draft files in --out that exist, each read once: its name, the SHA-256 of the
 * bytes read and the records parsed from those same bytes. The acceptance check and the plan both
 * use this one snapshot, so what is embedded is exactly what the hashes describe.
 */
export function snapshotDrafts(out, kind = "description") {
  const files = ["wikipedia", "none"]
    .map((c) => outputFile(out, kind, c))
    .filter((f) => existsSync(f));
  if (!files.length)
    throw new UsageError(
      `--out holds no ${kind} drafts (enrich-gemini-${kind}-*.jsonl)`,
      kind === "description" ? undefined : "WU034_EMB_PROMOTED_INPUT",
    );
  return files.map((file) => {
    const name = path.basename(file);
    const bytes = readFileSync(file);
    const records = bytes
      .toString("utf8")
      .split("\n")
      .flatMap((l, i) => {
        if (!l.trim()) return [];
        try {
          return [JSON.parse(l)];
        } catch {
          throw new UsageError(`${name}: line ${i + 1} is not JSON`);
        }
      });
    return { file, name, sha256: sha256(bytes), records };
  });
}

export function snapshotDescriptions(out) {
  return snapshotDrafts(out, "description");
}

/**
 * The Principal Operator's acceptance of the sample check (AGENTS.md section 3.1,
 * entry #199 / EMB-2). Refuses unless the summary is a matching-kind summary from sample-check.mjs,
 * with accepted_by and accepted_at filled in, complete, of 100 rows and within the line; its sheet
 * and meta file (beside it) are the ones scored; and its inputs are exactly the snapshot's files,
 * by name and SHA-256, each once.
 */
export function checkAcceptance(summaryFile, snapshot, kind = "description") {
  if (!TEXT_KINDS.includes(kind))
    throw new UsageError("--text must be description, title, friction or genre", "WU034_EMB_TEXT_KIND");
  if (kind === "title") {
    return { record: null, ordered: snapshot };
  }
  const fail = (why, code) => {
    throw new UsageError(`the ${kind} sample check is not accepted: ${why}`, code);
  };
  if (!summaryFile)
    fail(
      `--run needs --sample-summary, the accepted sample-${kind}-....summary.json`,
      "WU034_EMB_SAMPLE_REQUIRED",
    );
  const read = (f, what, code) => {
    try {
      return readFileSync(f);
    } catch {
      return fail(`${what} cannot be read`, code);
    }
  };
  const text = read(summaryFile, path.basename(summaryFile), "WU034_EMB_SAMPLE_REQUIRED").toString(
    "utf8",
  );
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    fail("the summary is not JSON", "WU034_EMB_SAMPLE_REQUIRED");
  }
  if (s?.schema !== "mgpl-sample-check-summary/1" || s.kind !== kind)
    fail(`the file is not a ${kind} sample-check summary`, "WU034_EMB_SAMPLE_KIND");
  const by = typeof s.accepted_by === "string" ? s.accepted_by.trim() : "";
  const at = typeof s.accepted_at === "string" ? s.accepted_at.trim() : "";
  if (!by || !at) fail("accepted_by and accepted_at are not filled in", "WU034_EMB_SAMPLE_REQUIRED");
  if (Number.isNaN(Date.parse(at))) fail("accepted_at is not a date", "WU034_EMB_SAMPLE_REQUIRED");
  const c = s.counts && typeof s.counts === "object" ? s.counts : {};
  if (
    s.n !== ACCEPTANCE_LINE.of ||
    s.complete !== true ||
    s.meets_line !== true ||
    c.unchecked !== 0 ||
    typeof c.wrong !== "number" ||
    c.wrong > ACCEPTANCE_LINE.max_wrong
  )
    fail(
      "the sample does not meet its line (100 rows, all checked, at most 3 wrong)",
      "WU034_EMB_SAMPLE_REQUIRED",
    );
  const sheetName = typeof s.sheet === "string" ? s.sheet : "";
  if (!/^[^/\\]+\.csv$/.test(sheetName) || sheetName.startsWith("."))
    fail("the summary does not name its sheet", "WU034_EMB_SAMPLE_REQUIRED");
  const sheet = path.join(path.dirname(summaryFile), sheetName);
  if (sha256(read(sheet, sheetName, "WU034_EMB_INPUT_HASH")) !== s.sheet_sha256)
    fail("the sheet changed after it was scored", "WU034_EMB_INPUT_HASH");
  const meta = sheet.replace(/\.csv$/, ".meta.json");
  if (sha256(read(meta, path.basename(meta), "WU034_EMB_INPUT_HASH")) !== s.meta_sha256)
    fail("the meta file changed after it was scored", "WU034_EMB_INPUT_HASH");
  const inputs = Array.isArray(s.inputs) ? s.inputs : [];
  const ordered = inputs.map((i) =>
    snapshot.find((f) => f.name === i?.file && f.sha256 === i?.sha256),
  );
  if (
    inputs.length !== snapshot.length ||
    ordered.some((f) => !f) ||
    new Set(ordered).size !== ordered.length
  )
    fail(
      `its inputs are not the ${kind} files read now (names and SHA-256)`,
      "WU034_EMB_INPUT_HASH",
    );
  return {
    record: {
      summary: path.basename(summaryFile),
      summary_sha256: sha256(text),
      seed: s.seed ?? null,
      accepted_at: at,
      inputs_order: ordered.map((f) => f.name),
    },
    ordered,
  };
}

/**
 * The text hash of each game already embedded, from the vectors file (the latest wins). With
 * `repair`, an incomplete last line left by an interrupted run is cut off;
 * without it (the dry run) the file is only read, and such a line is ignored.
 */
export function doneHashes(file, { repair = false, kind = "description" } = {}) {
  const done = new Map();
  if (!existsSync(file)) return done;
  const accept = (r) => {
    if (
      r?.schema === SCHEMA &&
      r.model === MODEL &&
      r.dimensions === DIMENSIONS &&
      (r.text_kind ?? "description") === kind
    )
      done.set(r.qid, r.text_sha256);
  };
  // Split bytes before decoding so a multibyte character crossing a read stays intact.
  // Keep one record at a time, never the full vector file or its parsed vectors.
  const fd = openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let completeBytes = 0;
  let line = 0;
  try {
    let size;
    while ((size = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const bytes = Buffer.concat([pending, chunk.subarray(0, size)]);
      let start = 0;
      let end;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        line++;
        const text = bytes.subarray(start, end).toString("utf8");
        if (text.trim()) {
          let record;
          try {
            record = JSON.parse(text);
          } catch {
            throw new UsageError(`${path.basename(file)}: line ${line} is not JSON`);
          }
          accept(record);
        }
        completeBytes += end - start + 1;
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
  } finally {
    closeSync(fd);
  }
  // Only repair after every completed line has parsed, and only in the guarded run path.
  if (repair && pending.length) {
    let record;
    let valid = true;
    try {
      record = JSON.parse(pending.toString("utf8"));
    } catch {
      valid = false;
    }
    if (valid) {
      accept(record);
      appendFileSync(file, "\n", "utf8");
    } else truncateSync(file, completeBytes);
  }
  return done;
}

function samePath(a, b, platform = process.platform) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isValidUtcIso(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(str))
    return false;
  const ms = Date.parse(str);
  if (!Number.isFinite(ms)) return false;
  const iso = new Date(ms).toISOString();
  return str.includes(".") ? iso === str : iso.replace(/\.000Z$/, "Z") === str;
}

export function buildTitleItems(catalogueDir) {
  const wikiFile = path.join(catalogueDir, "wikidata.jsonl");
  if (!existsSync(wikiFile))
    throw new UsageError("--catalogue has no wikidata.jsonl", "WU034_TITLE_INPUT");
  const xidsFile = path.join(catalogueDir, "wikidata-xids.jsonl");
  const aliasesByQid = new Map();
  let aliasesSourceAbsent = true;
  if (existsSync(xidsFile)) {
    aliasesSourceAbsent = false;
    const seenXids = new Set();
    for (const r of readJsonl(xidsFile)) {
      if (!r || typeof r !== "object" || typeof r.qid !== "string" || !/^Q[1-9][0-9]*$/.test(r.qid))
        throw new UsageError("wikidata-xids.jsonl has an invalid qid", "WU034_TITLE_INPUT");
      if (seenXids.has(r.qid))
        throw new UsageError(`duplicate qid in wikidata-xids.jsonl: ${r.qid}`, "WU034_TITLE_INPUT");
      seenXids.add(r.qid);
      if (r.aliases !== undefined) {
        if (!Array.isArray(r.aliases) || !r.aliases.every((a) => typeof a === "string"))
          throw new UsageError("wikidata-xids.jsonl aliases must be string[]", "WU034_TITLE_INPUT");
        aliasesByQid.set(r.qid, r.aliases);
      }
    }
  }
  const seenWiki = new Set();
  const rawEligible = [];
  let noTitle = 0;
  for (const r of readJsonl(wikiFile)) {
    if (!r || typeof r !== "object" || typeof r.qid !== "string" || !/^Q[1-9][0-9]*$/.test(r.qid))
      throw new UsageError("wikidata.jsonl has an invalid qid", "WU034_TITLE_INPUT");
    if (seenWiki.has(r.qid))
      throw new UsageError(`duplicate qid in wikidata.jsonl: ${r.qid}`, "WU034_TITLE_INPUT");
    seenWiki.add(r.qid);
    if (typeof r.label !== "string" || !r.label.trim()) {
      noTitle++;
      continue;
    }
    rawEligible.push({ qid: r.qid, label: r.label });
  }
  rawEligible.sort((a, b) => Number(a.qid.slice(1)) - Number(b.qid.slice(1)));
  const items = [];
  let tooLong = 0;
  for (const row of rawEligible) {
    const text = embeddingText("title", {
      label: row.label,
      aliases: aliasesByQid.get(row.qid) ?? [],
    });
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      tooLong++;
      continue;
    }
    items.push({
      qid: row.qid,
      text,
      text_sha256: sha256(text),
      text_kind: "title",
    });
  }
  return {
    items,
    eligible: rawEligible.length,
    no_title: noTitle,
    too_long: tooLong,
    aliases_source_absent: aliasesSourceAbsent,
  };
}

const PROMOTED_KEYS = new Set([
  "schema",
  "qid",
  "kind",
  "text_sha256",
  "promoted_at",
  "sample_summary_sha256",
  "draft_file",
]);

export function buildPromotedItems(promotedFile, orderedSnapshot, acceptedRecord, kind) {
  if (!promotedFile || !existsSync(promotedFile))
    throw new UsageError(`--text ${kind} requires --promoted-input <path>`, "WU034_EMB_PROMOTED_INPUT");
  let rawLines;
  try {
    rawLines = readFileSync(promotedFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
  } catch {
    throw new UsageError("--promoted-input cannot be read", "WU034_EMB_PROMOTED_INPUT");
  }
  if (!rawLines.length)
    throw new UsageError("--promoted-input has no rows", "WU034_EMB_PROMOTED_INPUT");

  const lists = orderedSnapshot.map((f) => f.records);
  const ok = latestOk(lists, kind);
  const winningFileByQid = new Map();
  for (const f of orderedSnapshot) {
    for (const r of f.records) {
      if (r?.qid && ok.get(r.qid) === r) winningFileByQid.set(r.qid, f.name);
    }
  }

  const seenQids = new Set();
  const selected = [];
  for (let i = 0; i < rawLines.length; i++) {
    let row;
    try {
      row = JSON.parse(rawLines[i]);
    } catch {
      throw new UsageError(`--promoted-input line ${i + 1} is not JSON`, "WU034_EMB_PROMOTED_INPUT");
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new UsageError(`--promoted-input line ${i + 1} is not an object`, "WU034_EMB_PROMOTED_INPUT");
    const keys = Object.keys(row);
    if (keys.length !== PROMOTED_KEYS.size || keys.some((k) => !PROMOTED_KEYS.has(k)))
      throw new UsageError(`--promoted-input line ${i + 1} has invalid keys`, "WU034_EMB_PROMOTED_INPUT");
    if (row.schema !== "mgpl-promoted-embedding-input/2")
      throw new UsageError(`--promoted-input line ${i + 1} has invalid schema`, "WU034_EMB_PROMOTED_INPUT");
    if (typeof row.qid !== "string" || !/^Q[1-9][0-9]*$/.test(row.qid))
      throw new UsageError(`--promoted-input line ${i + 1} has invalid qid`, "WU034_EMB_PROMOTED_INPUT");
    if (seenQids.has(row.qid))
      throw new UsageError(`--promoted-input has duplicate qid ${row.qid}`, "WU034_EMB_PROMOTED_INPUT");
    seenQids.add(row.qid);
    if (row.kind !== kind)
      throw new UsageError(`--promoted-input line ${i + 1} kind mismatch`, "WU034_EMB_PROMOTED_INPUT");
    if (typeof row.text_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.text_sha256))
      throw new UsageError(`--promoted-input line ${i + 1} has invalid text_sha256`, "WU034_EMB_PROMOTED_INPUT");
    if (
      typeof row.sample_summary_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.sample_summary_sha256) ||
      row.sample_summary_sha256 !== acceptedRecord.summary_sha256
    ) {
      throw new UsageError(
        `--promoted-input line ${i + 1} sample_summary_sha256 mismatch`,
        "WU034_EMB_PROMOTED_INPUT",
      );
    }
    if (!isValidUtcIso(row.promoted_at))
      throw new UsageError(`--promoted-input line ${i + 1} has invalid promoted_at`, "WU034_EMB_PROMOTED_INPUT");
    if (typeof row.draft_file !== "string" || !acceptedRecord.inputs_order.includes(row.draft_file))
      throw new UsageError(`--promoted-input line ${i + 1} has invalid draft_file`, "WU034_EMB_PROMOTED_INPUT");

    const draftRec = ok.get(row.qid);
    if (!draftRec || winningFileByQid.get(row.qid) !== row.draft_file)
      throw new UsageError(
        `--promoted-input qid ${row.qid} is not the latest ok record in ${row.draft_file}`,
        "WU034_EMB_PROMOTED_INPUT",
      );
    let text;
    try {
      text = embeddingText(kind, { [kind]: draftRec.generated });
    } catch {
      throw new UsageError(
        `--promoted-input qid ${row.qid} draft failed validation`,
        "WU034_EMB_PROMOTED_INPUT",
      );
    }
    const actualHash = sha256(text);
    if (actualHash !== row.text_sha256)
      throw new UsageError(`--promoted-input qid ${row.qid} text_sha256 mismatch`, "WU034_EMB_PROMOTED_INPUT");
    selected.push({
      qid: row.qid,
      text,
      text_sha256: actualHash,
      text_kind: kind,
      draft_file: row.draft_file,
      draft_run_id: draftRec.run_id ?? null,
      draft_attempt_id: draftRec.attempt_id ?? null,
      promoted_at: row.promoted_at,
      sample_summary_sha256: row.sample_summary_sha256,
    });
  }

  selected.sort((a, b) => Number(a.qid.slice(1)) - Number(b.qid.slice(1)));
  const items = [];
  let tooLong = 0;
  for (const s of selected) {
    if (Buffer.byteLength(s.text, "utf8") > MAX_TEXT_BYTES) {
      tooLong++;
      continue;
    }
    items.push(s);
  }
  return {
    items,
    eligible: ok.size,
    not_selected: ok.size - selected.length,
    no_title: 0,
    too_long: tooLong,
  };
}

/**
 * deps (tests only): dir (records folder), agentsPath, root, now, sleep, makeClient(holder,
 * httpOptions), baseFetch, log, interrupts, catalogue (folder), onCapture(capture).
 */
export async function main(argv, deps = {}) {
  const args = parseArgs(argv, {
    entry: "string",
    out: "string",
    catalogue: "string",
    limit: "int",
    batch: "int",
    reserve: "string",
    text: "string",
    "promoted-input": "string",
    "show-refusal": "boolean",
    "sample-summary": "string",
  });
  const log = deps.log ?? ((s) => console.log(s));
  const kind = args.text ?? "description";
  if (!TEXT_KINDS.includes(kind))
    throw new UsageError("--text must be description, title, friction or genre", "WU034_EMB_TEXT_KIND");
  if (kind === "title" && (args["promoted-input"] !== undefined || args["sample-summary"] !== undefined))
    throw new UsageError(
      "--promoted-input and --sample-summary are forbidden with --text title",
      "WU034_TITLE_FLAGS",
    );
  if (kind === "description" && args["promoted-input"] !== undefined)
    throw new UsageError(
      "--promoted-input is only valid with --text friction or genre",
      "WU034_EMB_PROMOTED_INPUT",
    );
  const size = args.batch ?? DEFAULT_BATCH;
  if (size > MAX_BATCH) throw new UsageError(`--batch must be at most ${MAX_BATCH}`);
  if (!args.out) throw new UsageError("--out <the entry's output folder> is required");
  const root = deps.root ?? ROOT;
  if (isInside(args.out, root))
    throw new UsageError("--out must be a folder outside the repository");
  const out = path.resolve(args.out);
  const catDir = path.resolve(deps.catalogue ?? args.catalogue ?? DEFAULT_DATA_DIR);
  const rates = await loadRates();
  const endpoint = expectedEndpoint(MODEL, "predict", LOCATION);
  const file = vectorsFile(out, kind);

  let snapshot = null;
  let accepted = null;
  let built = null;

  const buildDescription = (files) => {
    const lists = files.map((f) => f.records);
    const ok = latestOk(lists, "description");
    const labels = labelsFrom(catDir, new Set(ok.keys()));
    return buildItems(lists, labels);
  };

  if (kind === "title") {
    built = buildTitleItems(catDir);
  } else if (kind === "friction" || kind === "genre") {
    if (!args["promoted-input"])
      throw new UsageError(
        `--text ${kind} requires --promoted-input <path>`,
        "WU034_EMB_PROMOTED_INPUT",
      );
    snapshot = snapshotDrafts(out, kind);
    deps.afterSnapshot?.();
    const acc = checkAcceptance(args["sample-summary"], snapshot, kind);
    accepted = acc.record;
    built = buildPromotedItems(path.resolve(args["promoted-input"]), acc.ordered, accepted, kind);
  } else {
    snapshot = snapshotDescriptions(out);
    deps.afterSnapshot?.();
  }

  if (args.mode === "dry-run") {
    if (kind === "description") built = buildDescription(snapshot);
    const restore = forbidNetwork();
    try {
      const done = doneHashes(file, { kind });
      const queued = built.items
        .filter((i) => done.get(i.qid) !== i.text_sha256)
        .slice(0, args.limit ?? Infinity);
      const batches = planBatches(queued, size);
      const bound = batches.length ? planBound(rates, batches) : 0;
      const chars = queued.reduce((n, i) => n + i.text.length, 0);
      printDryRun([
        `script: ${SCRIPT}; the AGENTS.md section 3.1 entry is given with --entry on --run`,
        `model: ${MODEL}, ${DIMENSIONS} dimensions, task type ${TASK_TYPE}, text kind ${kind}, autoTruncate off; endpoint (expected): ${endpoint}`,
        `games: ${built.eligible} eligible; ${built.no_title} without a Wikidata label; ${built.too_long} too long; ${done.size} already embedded; ${queued.length} queued`,
        `requests: ${batches.length} (batches of up to ${size} texts and ${MAX_REQUEST_BYTES} UTF-8 bytes), one at a time`,
        `characters: ${chars}; at most $${round((Buffer.byteLength(JSON.stringify(queued.map((i) => i.text)), "utf8") / 1000) * rates.models[MODEL].input_per_1000_count)} at the input rate if every byte were billed`,
        `guard bound per request: up to $${bound} (what the reservation must hold, not the cost)`,
        "outputs on --run: only in --out, the entry's output folder; nothing is sent now",
      ]);
    } finally {
      restore();
    }
    return 0;
  }

  if (!args.entry || !/^#\d+$/.test(args.entry))
    throw new UsageError('--run needs --entry "#NNN", the section 3.1 entry for this script');
  if (args.reserve === undefined || !/^\d+(\.\d+)?$/.test(args.reserve))
    throw new UsageError(
      `--run needs --reserve, a dollar amount above 0 and at most ${MAX_RESERVE_USD}`,
    );
  const reserve = Number(args.reserve);
  if (!(reserve > 0 && reserve <= MAX_RESERVE_USD))
    throw new UsageError(`--reserve must be above 0 and at most ${MAX_RESERVE_USD}`);
  const headroom = await entryHeadroom({
    entry: args.entry,
    dir: deps.dir,
    agentsPath: deps.agentsPath,
    mode: kind,
    script: "scripts/catalogue/embed-descriptions.mjs",
  });
  if (!samePath(path.resolve(root, headroom.writes_to), out))
    throw new UsageError(
      `--out must be the output location entry ${args.entry} names in AGENTS.md section 3.1`,
    );
  if (reserve > headroom.usd)
    throw new UsageError(`--reserve is $${reserve}; entry ${args.entry} has $${headroom.usd} left`);
  if (headroom.requests < 1) throw new UsageError(`entry ${args.entry} has no requests left`);
  if (kind === "description") {
    const acc = checkAcceptance(args["sample-summary"], snapshot, "description");
    accepted = acc.record;
    built = buildDescription(acc.ordered);
  }

  await mkdir(out, { recursive: true });
  const plan = (doneMap) => {
    const q = built.items
      .filter((i) => doneMap.get(i.qid) !== i.text_sha256)
      .slice(0, args.limit ?? Infinity);
    const b = planBatches(q, size);
    return { queued: q, batches: b, bound: b.length ? planBound(rates, b) : 0 };
  };
  const tooBig = (b) => `one request can cost up to $${b}; --reserve $${reserve} cannot hold it`;
  const first = plan(doneHashes(file, { kind }));
  if (!first.queued.length)
    throw new UsageError("nothing to do: every game is embedded", "WU034_NOTHING_TO_DO");
  if (first.bound > reserve) throw new UsageError(tooBig(first.bound));

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepMs;
  const run = openRun({
    entry: args.entry,
    scriptUrl: import.meta.url,
    mode: kind,
    maxRequests: headroom.requests,
    maxUsd: reserve,
    rates,
    dir: deps.dir,
    agentsPath: deps.agentsPath,
    root,
    now,
  });

  const interrupts = deps.interrupts ?? process;
  let stop = null;
  const onSigint = () => {
    stop = stop ?? "operator interrupt (SIGINT)";
  };
  interrupts.once("SIGINT", onSigint);
  const counts = { embedded: 0, failed: 0 };
  let done = new Map();
  let queued = [];
  let batches = [];
  let bound = 0;
  let billable = 0;
  let unpriced = 0;
  let committed = 0;
  let endStatus = "failed";
  let capture = null;
  try {
    done = doneHashes(file, { repair: true, kind });
    ({ queued, batches, bound } = plan(done));
    if (queued.length && bound > reserve) stop = tooBig(bound);
    capture = createCapture({
      maxRequests: headroom.requests,
      guard: run,
      ...(deps.baseFetch ? { baseFetch: deps.baseFetch } : {}),
    });
    deps.onCapture?.(capture);
    const als = new AsyncLocalStorage();
    // The capture keeps every exchange; its bodies (the texts and the vectors) are dropped once
    // the request settles, so they never reach a record and memory stays flat.
    const holder = {
      fetch(input, init) {
        const slot = als.getStore();
        const before = capture.exchanges.length;
        const p = capture.fetch(input, init);
        const ex = capture.exchanges.length > before ? capture.exchanges.at(-1) : null;
        if (slot && ex) slot.exchange = ex;
        const drop = () => {
          if (ex) ex.request_body = ex.response_body = null;
        };
        return p.then(
          (res) => {
            drop();
            return res;
          },
          (e) => {
            drop();
            if (slot) slot.error = e;
            throw e;
          },
        );
      },
    };
    const httpOptions = { timeout: REQUEST_TIMEOUT_MS };
    const ai = deps.makeClient
      ? deps.makeClient(holder, httpOptions)
      : await createClient(holder, httpOptions, LOCATION);

    let failuresInRow = 0;
    for (const batch of batches) {
      if (stop) break;
      let answer = null;
      let slot = null;
      for (let attempt = 0; attempt <= BACKOFF_MS.length && !stop; attempt++) {
        slot = {};
        try {
          answer = await als.run(slot, () =>
            ai.models.embedContent(embedParams(batch.map((i) => i.text))),
          );
        } catch (e) {
          answer = null;
          // The capture's own request cap is not a transient error: stop at once, as cap_reached.
          if (slot.error?.capReached || e?.capReached) {
            stop = "request cap reached (count)";
            break;
          }
          const g =
            slot.error instanceof GuardRefusal ? slot.error : e instanceof GuardRefusal ? e : null;
          if (g) {
            stop = `run guard refused (${g.check})`;
            break;
          }
          const status = e?.status ?? null;
          if ((status === null || RETRYABLE(status)) && attempt < BACKOFF_MS.length) {
            await sleep(BACKOFF_MS[attempt]);
            continue;
          }
          stop = `request failed (${status ?? errorKind(e)})`;
          break;
        }
        break;
      }
      if (!answer) {
        if (!stop) stop = "request failed";
        break;
      }
      const problem = answerProblem(answer, batch.length);
      const attemptNo = slot.exchange?.attempt ?? null;
      const g = slot.exchange?.guard;
      if (g?.outcome === "priced") billable += answer?.metadata?.billableCharacterCount ?? 0;
      else unpriced++;
      if (problem) {
        counts.failed += batch.length;
        failuresInRow++;
        if (failuresInRow >= STOP_AFTER_FAILURES) {
          stop = `${STOP_AFTER_FAILURES} unusable answers in a row`;
          break;
        }
        continue;
      }
      failuresInRow = 0;
      const at = new Date(now()).toISOString();
      batch.forEach((it, i) => {
        appendJsonl(file, {
          schema: SCHEMA,
          qid: it.qid,
          model: MODEL,
          dimensions: DIMENSIONS,
          task_type: TASK_TYPE,
          text_kind: kind,
          text_sha256: it.text_sha256,
          ...(kind === "description"
            ? {
                description: {
                  run_id: it.description_run_id,
                  attempt_id: it.description_attempt_id,
                },
              }
            : {}),
          ...(kind === "friction" || kind === "genre"
            ? {
                draft: {
                  file: it.draft_file,
                  run_id: it.draft_run_id,
                  attempt_id: it.draft_attempt_id,
                  promoted_at: it.promoted_at,
                  sample_summary_sha256: it.sample_summary_sha256,
                },
              }
            : {}),
          vector_f32le_b64: encodeVector(answer.embeddings[i].values),
          run_id: run.run_id,
          attempt_id: attemptNo ? `${run.run_id}:${attemptNo}` : null,
          at,
        });
      });
      counts.embedded += batch.length;
    }
    endStatus = stop
      ? stop.startsWith("operator")
        ? "stopped"
        : stop.includes("(dollars)") || stop.includes("(count)")
          ? "cap_reached"
          : "failed"
      : "completed";
    if (counts.failed > 0 && endStatus !== "stopped") {
      if (!stop) stop = `${counts.failed} games had unusable answers`;
      endStatus = "failed";
    }
  } catch (e) {
    stop = stop ?? (e instanceof UsageError ? e.message : `unexpected error (${errorKind(e)})`);
    endStatus = "failed";
  } finally {
    interrupts.removeListener("SIGINT", onSigint);
    run.end(endStatus);
  }

  committed = 0;
  for (const ex of capture?.exchanges ?? []) {
    const g = ex.guard;
    committed += g?.outcome === "priced" ? g.computed_cost_usd : bound;
  }
  const stamp = utcStamp(new Date(now()));
  const aggregate = {
    script: SCRIPT,
    ledger_entry: args.entry,
    run_id: run.run_id,
    executed_by: `${headroom.lane}, the lane AGENTS.md section 3.1 entry ${args.entry} names`,
    model: MODEL,
    dimensions: DIMENSIONS,
    task_type: TASK_TYPE,
    mode: kind,
    text_kind: kind,
    endpoint_expected: endpoint,
    rate: rateRef(rates, MODEL),
    batch: size,
    reservation: { max_requests: headroom.requests, max_usd: reserve },
    sample_check: accepted,
    games: {
      ...(kind === "description" ? { with_ok_description: built.eligible } : { eligible: built.eligible }),
      ...(built.not_selected !== undefined ? { not_selected: built.not_selected } : {}),
      ...(built.aliases_source_absent !== undefined
        ? { aliases_source_absent: built.aliases_source_absent }
        : {}),
      no_title: built.no_title,
      too_long: built.too_long,
      already_embedded: done.size,
      queued: queued.length,
      ...counts,
    },
    requests_sent: capture ? capture.attempts : 0,
    billable_characters: billable,
    unpriced_requests: unpriced,
    stop_reason: stop,
    end_status: endStatus,
    computed_cost_usd: round(committed),
    computed_cost_note:
      "answered requests at their computed cost (metadata.billableCharacterCount); any other request at the largest guard bound. Computed, not charged; reconciliation against the billing export follows (AGENTS.md section 3.1)",
  };
  const aggName =
    kind === "description"
      ? `${SCRIPT}-${stamp}-aggregate.json`
      : `${SCRIPT}-${kind}-${stamp}-${run.run_id}.aggregate.json`;
  await writeFile(path.join(out, aggName), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
  log(
    `${SCRIPT}: ${stop ? `ended (${stop})` : "done"}; run ${run.run_id}; ${endStatus}; requests ${aggregate.requests_sent}; games embedded ${counts.embedded}, failed ${counts.failed}; computed_cost_usd ${aggregate.computed_cost_usd}; written to --out`,
  );
  return endStatus === "completed" || endStatus === "cap_reached" ? 0 : 1;
}

export async function cli(argv, log = (s) => console.error(s)) {
  try {
    return (await main(argv)) ?? 0;
  } catch (e) {
    log(`${SCRIPT}: ${cliMessage(e, argv.includes("--show-refusal"))}`);
    return e instanceof UsageError || e instanceof GuardRefusal ? 2 : 1;
  }
}

if (isMain(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
