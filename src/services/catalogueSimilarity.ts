// #158 / WU-032b: Catalogue embeddings loader and semantic similarity service.
// Ranks games by cosine similarity over text-embedding-005 vectors of promoted descriptions.
// cspell:words qids jsonl
import type { Database as DatabaseType } from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, createReadStream } from "node:fs";
import readline from "node:readline";

export const SCHEMA = "mgpl-embedding/1" as const;
export const MODEL = "text-embedding-005" as const;
export const TASK_TYPE = "SEMANTIC_SIMILARITY" as const;
export const DIMENSIONS = 768 as const;
export const VECTOR_BYTES = DIMENSIONS * 4; // 3072 bytes (768 float32 values)
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
export const DISCLAIMER =
  "similarity of generated descriptions, not a verified factual recommendation" as const;

export class CatalogueEmbeddingsError extends Error {
  readonly code: string;
  constructor(message: string, code = "LOAD_ERROR") {
    super(message);
    this.name = "CatalogueEmbeddingsError";
    this.code = code;
  }
}

export class CatalogueSimilarityError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CatalogueSimilarityError";
    this.code = code;
  }
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Reconstruct precisely the producer text: trimmed title, punctuation, then description. */
export function textFor(label: string, description: string): string {
  const t = label.trim();
  return /[.!?]$/.test(t) ? `${t} ${description}` : `${t}. ${description}`;
}

/**
 * Parse and validate promoted description JSON object from CatalogueDrafts.value.
 * Format: JSON.stringify({ description: rawDescription })
 * Refuses malformed JSON or invalid shape safely; no plain-text fallback.
 */
export function parsePromotedDescription(rawJson: string): string {
  if (typeof rawJson !== "string") {
    throw new Error("Invalid draft value type");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Malformed JSON in draft value");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Draft value is not an object");
  }
  const desc = (parsed as { description?: unknown }).description;
  if (typeof desc !== "string" || !desc.trim()) {
    throw new Error("Draft description is missing or empty");
  }
  return desc;
}

/**
 * Compute a canonical fixed-size SHA-256 digest over every meaningful immutable producer field.
 * Serializes a fixed-order array of validated strings/numbers/nulls with JSON.stringify so field
 * boundaries stay unambiguous even when an accepted string contains an embedded delimiter (e.g.
 * a null byte). Missing/null provenance is normalized to an explicit null, and payload vectors are
 * never stored, so the in-memory duplicate map keeps fixed-size entries.
 */
export function computeRecordDigest(
  record: RawEmbeddingRecord,
  descRun: string | null,
  descAttempt: string | null,
): string {
  const embeddingAttemptId = typeof record.attempt_id === "string" ? record.attempt_id : null;
  const canonical = JSON.stringify([
    record.schema,
    record.qid,
    record.model,
    record.dimensions,
    record.task_type,
    record.text_sha256,
    record.vector_f32le_b64,
    descRun,
    descAttempt,
    record.run_id,
    embeddingAttemptId,
    record.at,
  ]);
  return sha256(canonical);
}

/** Encode Float32Array / number array into little-endian float32 base64. */
export function encodeVector(values: ArrayLike<number>): string {
  if (values.length !== DIMENSIONS) {
    throw new CatalogueEmbeddingsError(
      `Vector dimension mismatch: expected ${DIMENSIONS}, got ${values.length}`,
      "INVALID_DIMENSION",
    );
  }
  const buf = Buffer.alloc(VECTOR_BYTES);
  for (let i = 0; i < DIMENSIONS; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new CatalogueEmbeddingsError(
        `Vector component at index ${i} is not a finite number`,
        "NON_FINITE_VECTOR",
      );
    }
    buf.writeFloatLE(v, i * 4);
  }
  return buf.toString("base64");
}

/** Decode little-endian float32 base64 and validate components and norm. */
export function decodeVector(b64: string): { vector: Float32Array; norm: number } {
  if (typeof b64 !== "string" || !b64) {
    throw new CatalogueEmbeddingsError("Missing vector base64 string", "MALFORMED_VECTOR");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== VECTOR_BYTES) {
    throw new CatalogueEmbeddingsError(
      `Vector byte length mismatch: expected ${VECTOR_BYTES} bytes, got ${buf.length}`,
      "INVALID_BYTE_LENGTH",
    );
  }
  // Canonical base64 verification: re-encoding must strictly match the input base64 string.
  if (buf.toString("base64") !== b64) {
    throw new CatalogueEmbeddingsError(
      "Vector base64 string is not canonically encoded",
      "NON_CANONICAL_BASE64",
    );
  }
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, DIMENSIONS);
  let sumSq = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    const v = f32[i];
    if (!Number.isFinite(v)) {
      throw new CatalogueEmbeddingsError(
        `Vector component at index ${i} is not a finite number`,
        "NON_FINITE_VECTOR",
      );
    }
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm <= 0 || !Number.isFinite(norm)) {
    throw new CatalogueEmbeddingsError("Vector has zero or invalid L2 norm", "ZERO_NORM_VECTOR");
  }
  return { vector: f32, norm };
}

// ---------------------------------------------------------------------------
// Embedding Loader
// ---------------------------------------------------------------------------

export interface LoadEmbeddingsOptions {
  inputFile: string;
  reviewConfirmed: boolean;
  now?: Date | string;
}

export interface LoadEmbeddingsResult {
  processed: number;
  loaded: number;
  duplicates_skipped: number;
  duration_ms: number;
}

const REQUIRED_TABLES = ["CatalogueGames", "CatalogueDrafts", "CatalogueEmbeddings"] as const;

function checkRequiredTables(db: DatabaseType): void {
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const table of REQUIRED_TABLES) {
    if (!stmt.get(table)) {
      throw new CatalogueEmbeddingsError(
        `Database table '${table}' does not exist; run initDb() first`,
        "MISSING_TABLE",
      );
    }
  }
}

interface RawEmbeddingRecord {
  schema?: unknown;
  qid?: unknown;
  model?: unknown;
  dimensions?: unknown;
  task_type?: unknown;
  text_sha256?: unknown;
  description?: unknown;
  vector_f32le_b64?: unknown;
  run_id?: unknown;
  attempt_id?: unknown;
  at?: unknown;
}

export async function loadCatalogueEmbeddings(
  db: DatabaseType,
  options: LoadEmbeddingsOptions,
): Promise<LoadEmbeddingsResult> {
  const startTime = Date.now();
  if (!options.reviewConfirmed) {
    throw new CatalogueEmbeddingsError(
      "review confirmation is required to load catalogue embeddings",
      "REVIEW_CONFIRMATION_REQUIRED",
    );
  }
  if (!options.inputFile || typeof options.inputFile !== "string") {
    throw new CatalogueEmbeddingsError("Input file path is required", "INVALID_INPUT_FILE");
  }
  if (!existsSync(options.inputFile)) {
    throw new CatalogueEmbeddingsError(
      `Input file does not exist: ${options.inputFile}`,
      "FILE_NOT_FOUND",
    );
  }

  checkRequiredTables(db);

  const loadedAt = (
    options.now instanceof Date ? options.now : options.now ? new Date(options.now) : new Date()
  ).toISOString();

  const selectGame = db.prepare("SELECT qid, title FROM CatalogueGames WHERE qid = ?");
  const selectDraft = db.prepare(`
    SELECT qid, value, text_sha256, run_id, attempt_id
    FROM CatalogueDrafts
    WHERE qid = ? AND kind = 'description' AND label = 'generated'
  `);
  const upsertEmbedding = db.prepare(`
    INSERT INTO CatalogueEmbeddings (
      qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
      description_run_id, description_attempt_id, embedding_run_id, embedding_attempt_id,
      embedded_at, loaded_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(qid) DO UPDATE SET
      model = excluded.model,
      task_type = excluded.task_type,
      dimensions = excluded.dimensions,
      vector = excluded.vector,
      text_sha256 = excluded.text_sha256,
      description_sha256 = excluded.description_sha256,
      description_run_id = excluded.description_run_id,
      description_attempt_id = excluded.description_attempt_id,
      embedding_run_id = excluded.embedding_run_id,
      embedding_attempt_id = excluded.embedding_attempt_id,
      embedded_at = excluded.embedded_at,
      loaded_at = excluded.loaded_at
  `);

  const seenQids = new Map<string, { line: number; digest: string }>();
  let processed = 0;
  let loaded = 0;
  let duplicatesSkipped = 0;
  let lineNum = 0;

  // Stream file line by line within an immediate transaction to ensure all-or-nothing atomicity.
  db.exec("BEGIN IMMEDIATE");
  let transactionActive = true;

  try {
    const fileStream = createReadStream(options.inputFile, { encoding: "utf8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      lineNum++;
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      processed++;

      let record: RawEmbeddingRecord;
      try {
        record = JSON.parse(trimmed);
      } catch {
        throw new CatalogueEmbeddingsError(`Line ${lineNum}: malformed JSON`, "MALFORMED_JSON");
      }

      if (record?.schema !== SCHEMA) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: unsupported schema '${String(record?.schema)}'`,
          "UNSUPPORTED_SCHEMA",
        );
      }
      if (typeof record.qid !== "string" || !/^Q[1-9][0-9]*$/.test(record.qid)) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: invalid QID format '${String(record.qid)}'`,
          "INVALID_QID",
        );
      }
      if (record.model !== MODEL) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: unsupported model '${String(record.model)}'`,
          "UNSUPPORTED_MODEL",
        );
      }
      if (record.task_type !== TASK_TYPE) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: unsupported task_type '${String(record.task_type)}'`,
          "UNSUPPORTED_TASK_TYPE",
        );
      }
      if (record.dimensions !== DIMENSIONS || typeof record.dimensions !== "number") {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: dimensions must be integer ${DIMENSIONS}, got ${String(record.dimensions)}`,
          "INVALID_DIMENSION",
        );
      }
      if (typeof record.text_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.text_sha256)) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: invalid text_sha256 format`,
          "INVALID_TEXT_HASH",
        );
      }
      if (typeof record.run_id !== "string" || !record.run_id.trim()) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: embedding run_id is missing or empty`,
          "INVALID_RUN_ID",
        );
      }
      if (
        record.attempt_id !== null &&
        record.attempt_id !== undefined &&
        (typeof record.attempt_id !== "string" || !record.attempt_id.trim())
      ) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: embedding attempt_id must be non-empty string or null`,
          "INVALID_ATTEMPT_ID",
        );
      }
      if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: embedded timestamp 'at' is not a valid date`,
          "INVALID_TIMESTAMP",
        );
      }
      if (!record.description || typeof record.description !== "object") {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: description provenance object is required`,
          "MISSING_DESCRIPTION_PROVENANCE",
        );
      }
      const descProvenance = record.description as { run_id?: unknown; attempt_id?: unknown };
      if (
        descProvenance.run_id !== null &&
        descProvenance.run_id !== undefined &&
        typeof descProvenance.run_id !== "string"
      ) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: description.run_id must be string or null`,
          "INVALID_DESCRIPTION_PROVENANCE",
        );
      }
      if (
        descProvenance.attempt_id !== null &&
        descProvenance.attempt_id !== undefined &&
        typeof descProvenance.attempt_id !== "string"
      ) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: description.attempt_id must be string or null`,
          "INVALID_DESCRIPTION_PROVENANCE",
        );
      }
      if (typeof record.vector_f32le_b64 !== "string") {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: vector_f32le_b64 string is required`,
          "MISSING_VECTOR",
        );
      }

      // Numeric vector decoding and validation (length, finite numbers, canonical b64, non-zero norm)
      decodeVector(record.vector_f32le_b64);
      const vectorBuf = Buffer.from(record.vector_f32le_b64, "base64");

      // State verification against SQLite before duplicate collapse
      const gameRow = selectGame.get(record.qid) as
        { qid: string; title: string | null } | undefined;
      if (!gameRow) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: game '${record.qid}' not found in CatalogueGames`,
          "UNKNOWN_GAME",
        );
      }
      if (typeof gameRow.title !== "string" || !gameRow.title.trim()) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: game '${record.qid}' has missing or empty title in CatalogueGames`,
          "EMPTY_GAME_TITLE",
        );
      }

      const draftRow = selectDraft.get(record.qid) as
        | {
            qid: string;
            value: string;
            text_sha256: string;
            run_id: string | null;
            attempt_id: string | null;
          }
        | undefined;
      if (!draftRow) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: game '${record.qid}' has no accepted promoted description in CatalogueDrafts`,
          "MISSING_PROMOTED_DESCRIPTION",
        );
      }

      let rawDescription: string;
      try {
        rawDescription = parsePromotedDescription(draftRow.value);
      } catch {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: game '${record.qid}' has malformed promoted description in CatalogueDrafts`,
          "MALFORMED_PROMOTED_DESCRIPTION",
        );
      }

      // Reconstruct precisely the producer text and verify text_sha256
      const reconstructedText = textFor(gameRow.title, rawDescription);
      const expectedTextHash = sha256(reconstructedText);
      if (expectedTextHash !== record.text_sha256) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: text_sha256 mismatch for '${record.qid}' (title/description binding does not match current catalogue state)`,
          "TEXT_HASH_MISMATCH",
        );
      }

      // Verify description hash against the promoted draft hash
      const descriptionSha256 = sha256(rawDescription);
      if (descriptionSha256 !== draftRow.text_sha256) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: draft hash corrupted for '${record.qid}'`,
          "DRAFT_HASH_CORRUPTED",
        );
      }

      // Check description provenance against promoted draft
      if (descProvenance.run_id && draftRow.run_id && descProvenance.run_id !== draftRow.run_id) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: description.run_id mismatch for '${record.qid}'`,
          "PROVENANCE_MISMATCH",
        );
      }
      if (
        descProvenance.attempt_id &&
        draftRow.attempt_id &&
        descProvenance.attempt_id !== draftRow.attempt_id
      ) {
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: description.attempt_id mismatch for '${record.qid}'`,
          "PROVENANCE_MISMATCH",
        );
      }

      // Duplicate handling in same input: identical collapses; conflicting refuses
      const digest = computeRecordDigest(
        record,
        (descProvenance.run_id as string) ?? null,
        (descProvenance.attempt_id as string) ?? null,
      );
      const seen = seenQids.get(record.qid);
      if (seen) {
        if (seen.digest === digest) {
          duplicatesSkipped++;
          continue;
        }
        throw new CatalogueEmbeddingsError(
          `Line ${lineNum}: conflicting duplicate record for ${record.qid} (first seen on line ${seen.line})`,
          "CONFLICTING_DUPLICATE",
        );
      }
      seenQids.set(record.qid, { line: lineNum, digest });

      upsertEmbedding.run(
        record.qid,
        record.model,
        record.task_type,
        record.dimensions,
        vectorBuf,
        record.text_sha256,
        descriptionSha256,
        descProvenance.run_id ?? null,
        descProvenance.attempt_id ?? null,
        record.run_id,
        record.attempt_id ?? null,
        record.at,
        loadedAt,
      );
      loaded++;
    }

    db.exec("COMMIT");
    transactionActive = false;
  } catch (error) {
    if (transactionActive && db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback failure should not mask the underlying error
      }
    }
    throw error;
  }

  invalidateSimilarityCache(db);

  return {
    processed,
    loaded,
    duplicates_skipped: duplicatesSkipped,
    duration_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Similarity Service
// ---------------------------------------------------------------------------

export interface SimilarityOptions {
  limit?: number;
  noCache?: boolean;
  forceReload?: boolean;
}

export interface SimilarGameCandidate {
  qid: string;
  title: string;
  similarity: number;
}

export interface SimilarGamesResult {
  source_qid: string;
  source_title: string;
  limit: number;
  total_candidates: number;
  disclaimer: typeof DISCLAIMER;
  results: SimilarGameCandidate[];
}

export interface CachedCandidate {
  qid: string;
  title: string;
  vector: Float32Array;
  norm: number;
  text_sha256: string;
  description_sha256: string;
}

export interface SimilarityIndex {
  dbTotalChanges: number;
  dbDataVersion: number;
  candidates: CachedCandidate[];
  candidatesByQid: Map<string, CachedCandidate>;
}

// Module-level cache keyed by database instance reference
let indexCache = new WeakMap<DatabaseType, SimilarityIndex>();

export function invalidateSimilarityCache(db?: DatabaseType): void {
  if (db) {
    indexCache.delete(db);
  } else {
    indexCache = new WeakMap();
  }
}

export function buildSimilarityIndex(
  db: DatabaseType,
  options?: { cache?: boolean },
): SimilarityIndex {
  checkRequiredTables(db);

  const totalChanges = Number(db.prepare("SELECT total_changes()").pluck().get() ?? 0);
  const dataVersion = Number(db.pragma("data_version", { simple: true }) ?? 0);

  // Fetch only candidate vectors whose title and promoted description binding remains current
  const rows = db
    .prepare(
      `SELECT
        e.qid,
        e.vector,
        g.title,
        d.value AS description_json,
        e.text_sha256,
        e.description_sha256,
        d.text_sha256 AS draft_text_sha256
      FROM CatalogueEmbeddings e
      JOIN CatalogueGames g ON g.qid = e.qid
      JOIN CatalogueDrafts d ON d.qid = e.qid AND d.kind = 'description' AND d.label = 'generated'
      WHERE e.description_sha256 = d.text_sha256`,
    )
    .all() as Array<{
    qid: string;
    vector: Buffer;
    title: string;
    description_json: string;
    text_sha256: string;
    description_sha256: string;
    draft_text_sha256: string;
  }>;

  const candidates: CachedCandidate[] = [];
  const candidatesByQid = new Map<string, CachedCandidate>();

  for (const row of rows) {
    if (!row.title || typeof row.title !== "string") continue;
    if (row.vector.length !== VECTOR_BYTES) continue;

    let rawDescription: string;
    try {
      rawDescription = parsePromotedDescription(row.description_json);
    } catch {
      continue;
    }

    const descriptionSha256 = sha256(rawDescription);
    if (descriptionSha256 !== row.draft_text_sha256) continue;

    // Verify title/description binding hash remains fresh
    const expectedHash = sha256(textFor(row.title, rawDescription));
    if (expectedHash !== row.text_sha256) continue;

    const f32 = new Float32Array(row.vector.buffer, row.vector.byteOffset, DIMENSIONS);
    let sumSq = 0;
    let finite = true;
    for (let i = 0; i < DIMENSIONS; i++) {
      const v = f32[i];
      if (!Number.isFinite(v)) {
        finite = false;
        break;
      }
      sumSq += v * v;
    }
    if (!finite || sumSq <= 0) continue;
    const norm = Math.sqrt(sumSq);

    const candidate: CachedCandidate = {
      qid: row.qid,
      title: row.title,
      vector: f32,
      norm,
      text_sha256: row.text_sha256,
      description_sha256: row.description_sha256,
    };
    candidates.push(candidate);
    candidatesByQid.set(row.qid, candidate);
  }

  const index: SimilarityIndex = {
    dbTotalChanges: totalChanges,
    dbDataVersion: dataVersion,
    candidates,
    candidatesByQid,
  };

  const shouldCache = options?.cache ?? true;
  if (shouldCache && !db.inTransaction) {
    indexCache.set(db, index);
  }
  return index;
}

export function getSimilarityIndex(
  db: DatabaseType,
  options?: { forceReload?: boolean },
): SimilarityIndex {
  if (db.inTransaction) {
    return buildSimilarityIndex(db, { cache: false });
  }
  if (!options?.forceReload) {
    const cached = indexCache.get(db);
    if (cached) {
      try {
        const currentTotalChanges = Number(db.prepare("SELECT total_changes()").pluck().get() ?? 0);
        const currentDataVersion = Number(db.pragma("data_version", { simple: true }) ?? 0);
        if (
          currentTotalChanges === cached.dbTotalChanges &&
          currentDataVersion === cached.dbDataVersion
        ) {
          return cached;
        }
      } catch {
        // Fall through to rebuild
      }
    }
  }
  return buildSimilarityIndex(db, { cache: true });
}

/** Cosine similarity between two vectors u and v. */
export function cosineSimilarity(
  u: Float32Array,
  normU: number,
  v: Float32Array,
  normV: number,
): number {
  let dot = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    dot += u[i] * v[i];
  }
  const denom = normU * normV;
  if (denom <= 0 || !Number.isFinite(denom)) return 0;
  const score = dot / denom;
  // Numerical clamp to [-1, 1]
  return Math.max(-1, Math.min(1, score));
}

export function findSimilarCatalogueGames(
  db: DatabaseType,
  sourceQid: string,
  options?: SimilarityOptions,
): SimilarGamesResult {
  if (typeof sourceQid !== "string" || !/^Q[1-9][0-9]*$/.test(sourceQid)) {
    throw new CatalogueSimilarityError(
      `Invalid QID format: '${String(sourceQid)}'`,
      "INVALID_ARGUMENT",
    );
  }
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CatalogueSimilarityError(
      `Limit must be an integer between 1 and ${MAX_LIMIT}, got ${String(limit)}`,
      "INVALID_ARGUMENT",
    );
  }

  checkRequiredTables(db);

  // 1. Verify source game in CatalogueGames
  const game = db.prepare("SELECT qid, title FROM CatalogueGames WHERE qid = ?").get(sourceQid) as
    { qid: string; title: string | null } | undefined;
  if (!game) {
    throw new CatalogueSimilarityError(
      `Source game '${sourceQid}' not found in CatalogueGames`,
      "SOURCE_NOT_FOUND",
    );
  }
  if (!game.title || typeof game.title !== "string") {
    throw new CatalogueSimilarityError(
      `Source game '${sourceQid}' has missing or empty title`,
      "SOURCE_STALE",
    );
  }

  // 2. Verify source embedding in CatalogueEmbeddings
  const embedding = db
    .prepare(
      `SELECT qid, vector, text_sha256, description_sha256, dimensions
       FROM CatalogueEmbeddings WHERE qid = ?`,
    )
    .get(sourceQid) as
    | {
        qid: string;
        vector: Buffer;
        text_sha256: string;
        description_sha256: string;
        dimensions: number;
      }
    | undefined;
  if (!embedding) {
    throw new CatalogueSimilarityError(
      `No embedding found for source game '${sourceQid}'`,
      "SOURCE_NOT_EMBEDDED",
    );
  }
  if (embedding.dimensions !== DIMENSIONS || embedding.vector.length !== VECTOR_BYTES) {
    throw new CatalogueSimilarityError(
      `Source game '${sourceQid}' embedding vector is malformed`,
      "SOURCE_MALFORMED",
    );
  }

  // 3. Verify source description draft in CatalogueDrafts
  const draft = db
    .prepare(
      `SELECT qid, value, text_sha256, label
       FROM CatalogueDrafts WHERE qid = ? AND kind = 'description'`,
    )
    .get(sourceQid) as
    { qid: string; value: string; text_sha256: string; label: string } | undefined;
  if (!draft || draft.label !== "generated") {
    throw new CatalogueSimilarityError(
      `No promoted generated description found for source game '${sourceQid}'`,
      "SOURCE_DESCRIPTION_MISSING",
    );
  }

  let sourceDescription: string;
  try {
    sourceDescription = parsePromotedDescription(draft.value);
  } catch {
    throw new CatalogueSimilarityError(
      `Source game '${sourceQid}' has malformed promoted description`,
      "SOURCE_MALFORMED",
    );
  }

  // 4. Verify source freshness
  const descriptionSha256 = sha256(sourceDescription);
  if (
    descriptionSha256 !== draft.text_sha256 ||
    embedding.description_sha256 !== draft.text_sha256
  ) {
    throw new CatalogueSimilarityError(
      `Source game '${sourceQid}' description has been modified after embedding`,
      "SOURCE_STALE",
    );
  }
  const expectedSourceHash = sha256(textFor(game.title, sourceDescription));
  if (expectedSourceHash !== embedding.text_sha256) {
    throw new CatalogueSimilarityError(
      `Source game '${sourceQid}' title/description binding has been modified after embedding`,
      "SOURCE_STALE",
    );
  }

  // Decode source vector
  const sourceF32 = new Float32Array(
    embedding.vector.buffer,
    embedding.vector.byteOffset,
    DIMENSIONS,
  );
  let sourceSumSq = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    const v = sourceF32[i];
    if (!Number.isFinite(v)) {
      throw new CatalogueSimilarityError(
        `Source vector for '${sourceQid}' contains non-finite numbers`,
        "SOURCE_MALFORMED",
      );
    }
    sourceSumSq += v * v;
  }
  const normSource = Math.sqrt(sourceSumSq);
  if (normSource <= 0) {
    throw new CatalogueSimilarityError(
      `Source vector for '${sourceQid}' has zero L2 norm`,
      "SOURCE_MALFORMED",
    );
  }

  // 5. Query candidate pool
  let candidates: CachedCandidate[];
  if (options?.noCache) {
    const index = buildSimilarityIndex(db, { cache: false });
    candidates = index.candidates;
  } else {
    const index = getSimilarityIndex(db, { forceReload: options?.forceReload });
    candidates = index.candidates;
  }

  // 6. Rank candidates with bounded top-K selection and stable QID tie-break
  const ranking = rankSimilarCandidates(sourceF32, normSource, sourceQid, candidates, limit);

  return {
    source_qid: sourceQid,
    source_title: game.title,
    limit,
    total_candidates: ranking.totalCandidates,
    disclaimer: DISCLAIMER,
    results: ranking.results,
  };
}

/** Rank candidates using bounded top-K cosine similarity with stable QID tie-break. */
export function rankSimilarCandidates(
  sourceF32: Float32Array,
  normSource: number,
  sourceQid: string,
  candidates: CachedCandidate[],
  limit = DEFAULT_LIMIT,
): { results: SimilarGameCandidate[]; totalCandidates: number } {
  let totalCandidates = 0;
  const top: SimilarGameCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.qid === sourceQid) continue;
    totalCandidates++;

    const similarity = cosineSimilarity(sourceF32, normSource, candidate.vector, candidate.norm);

    if (top.length < limit) {
      top.push({ qid: candidate.qid, title: candidate.title, similarity });
      top.sort((a, b) =>
        b.similarity !== a.similarity ? b.similarity - a.similarity : a.qid.localeCompare(b.qid),
      );
    } else {
      const worst = top[limit - 1];
      const isBetter =
        similarity > worst.similarity ||
        (similarity === worst.similarity && candidate.qid.localeCompare(worst.qid) < 0);

      if (isBetter) {
        top[limit - 1] = { qid: candidate.qid, title: candidate.title, similarity };
        top.sort((a, b) =>
          b.similarity !== a.similarity ? b.similarity - a.similarity : a.qid.localeCompare(b.qid),
        );
      }
    }
  }

  return { results: top, totalCandidates };
}
