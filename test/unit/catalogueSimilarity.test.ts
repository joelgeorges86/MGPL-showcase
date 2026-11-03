// #158 / WU-032b: Unit and integration tests for CatalogueEmbeddings and similarity search.
// Tests additive schema, atomic loader, validation/rollback, cosine similarity ranking,
// freshness invalidation and CLI interface on temporary fixture databases.
// cspell:words wikidata jsonl qids oldid licence nonnull
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CatalogueEmbeddingsError,
  CatalogueSimilarityError,
  computeRecordDigest,
  decodeVector,
  DEFAULT_LIMIT,
  DIMENSIONS,
  DISCLAIMER,
  encodeVector,
  findSimilarCatalogueGames,
  invalidateSimilarityCache,
  loadCatalogueEmbeddings,
  MODEL,
  parsePromotedDescription,
  rankSimilarCandidates,
  SCHEMA,
  sha256,
  TASK_TYPE,
  textFor,
  VECTOR_BYTES,
} from "../../src/services/catalogueSimilarity";
import {
  promoteCatalogueDrafts,
  promoteCatalogueFacts,
} from "../../src/services/enrichmentPromotion";
import {
  cli as runLoaderCli,
  parseArgs as parseLoaderArgs,
} from "../../scripts/catalogue/load-embeddings";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d && existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

function createTempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "mgpl-sim-test-"));
  tmpDirs.push(d);
  return d;
}

const DB_SOURCE = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");

function getTableDdl(table: string): string {
  const match = DB_SOURCE.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`),
  );
  if (!match) throw new Error(`Could not find DDL for ${table} in src/db.ts`);
  return match[0];
}

const REQUIRED_TABLES = ["CatalogueGames", "CatalogueDrafts", "CatalogueEmbeddings"] as const;

function createTestDb(filePath = ":memory:"): DatabaseType {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  for (const t of REQUIRED_TABLES) {
    db.exec(getTableDdl(t));
  }
  return db;
}

function makeVector(components: Record<number, number> = {}): Float32Array {
  const v = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i++) {
    v[i] = components[i] ?? 0;
  }
  return v;
}

function createProducerRecord(params: {
  qid: string;
  title: string;
  description: string;
  vector: Float32Array;
  runId?: string;
  attemptId?: string | null;
  descRunId?: string | null;
  descAttemptId?: string | null;
  at?: string;
}) {
  const reconstructedText = textFor(params.title, params.description);
  return {
    schema: SCHEMA,
    qid: params.qid,
    model: MODEL,
    dimensions: DIMENSIONS,
    task_type: TASK_TYPE,
    text_sha256: sha256(reconstructedText),
    description: {
      run_id: params.descRunId ?? "run-desc-1",
      attempt_id: params.descAttemptId ?? "run-desc-1:1",
    },
    vector_f32le_b64: encodeVector(params.vector),
    run_id: params.runId ?? "run-emb-1",
    attempt_id: params.attemptId ?? "run-emb-1:1",
    at: params.at ?? "2026-10-15T00:00:00Z",
  };
}

function seedCatalogueGame(
  db: DatabaseType,
  qid: string,
  title: string,
  description: string,
  descRunId = "run-desc-1",
  descAttemptId = "run-desc-1:1",
) {
  const descSha = sha256(description);
  const draftValue = JSON.stringify({ description });
  db.prepare(
    `
    INSERT OR REPLACE INTO CatalogueGames (qid, title, wikidata_url, loaded_at)
    VALUES (?, ?, ?, '2026-10-15T00:00:00Z')
  `,
  ).run(qid, title, `https://www.wikidata.org/wiki/${qid}`);

  db.prepare(
    `
    INSERT OR REPLACE INTO CatalogueDrafts (
      qid, kind, value, label, text_sha256, links, model, prompt_version,
      run_id, attempt_id, drafted_at, sample_summary_sha256, sample_seed,
      accepted_by, promoted_at
    ) VALUES (
      ?, 'description', ?, 'generated', ?, '[]', 'gemini-3.8-flash', 'v1',
      ?, ?, '2026-10-15T00:00:00Z', '0000', 'seed-1',
      'Principal Operator', '2026-10-15T00:00:00Z'
    )
  `,
  ).run(qid, draftValue, descSha, descRunId, descAttemptId);
}

// ===========================================================================
// Test Suite 1: Schema creation, registration and constraints
// ===========================================================================
describe("1. Schema creation, registration and constraints", () => {
  it("creates and registers CatalogueEmbeddings in AUTHORITATIVE_TABLES", () => {
    const db = createTestDb();
    const info = db.prepare("PRAGMA table_info(CatalogueEmbeddings)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(info.length).toBeGreaterThan(0);
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("qid");
    expect(colNames).toContain("model");
    expect(colNames).toContain("task_type");
    expect(colNames).toContain("dimensions");
    expect(colNames).toContain("vector");
    expect(colNames).toContain("text_sha256");
    expect(colNames).toContain("description_sha256");
    expect(colNames).toContain("loaded_at");

    // Check AUTHORITATIVE_TABLES in src/db.ts contains CatalogueEmbeddings
    expect(DB_SOURCE).toContain("CatalogueEmbeddings:");
    expect(DB_SOURCE).toContain('dimensions: "INTEGER"');
    expect(DB_SOURCE).toContain('vector: "BLOB"');
  });

  it("enforces foreign key constraints against CatalogueGames", () => {
    const db = createTestDb();
    const v = makeVector({ 0: 1.0 });
    const buf = Buffer.from(v.buffer, v.byteOffset, VECTOR_BYTES);

    // Q999 does not exist in CatalogueGames
    expect(() => {
      db.prepare(
        `
        INSERT INTO CatalogueEmbeddings (
          qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
          embedding_run_id, embedded_at, loaded_at
        ) VALUES (
          'Q999', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?,
          '${sha256("text")}', '${sha256("desc")}', 'run-1', '2026-10-15', '2026-10-15'
        )
      `,
      ).run(buf);
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces dimensions, vector length and hash length constraints", () => {
    const db = createTestDb();
    seedCatalogueGame(db, "Q10", "Game 10", "Description 10");

    // Invalid dimension (must be 768)
    expect(() => {
      db.prepare(
        `
        INSERT INTO CatalogueEmbeddings (
          qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
          embedding_run_id, embedded_at, loaded_at
        ) VALUES (
          'Q10', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 512, ?,
          '${sha256("text")}', '${sha256("desc")}', 'run-1', '2026-10-15', '2026-10-15'
        )
      `,
      ).run(Buffer.alloc(3072));
    }).toThrow(/CHECK constraint failed/);

    // Invalid vector length (must be exactly 3072 bytes)
    expect(() => {
      db.prepare(
        `
        INSERT INTO CatalogueEmbeddings (
          qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
          embedding_run_id, embedded_at, loaded_at
        ) VALUES (
          'Q10', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?,
          '${sha256("text")}', '${sha256("desc")}', 'run-1', '2026-10-15', '2026-10-15'
        )
      `,
      ).run(Buffer.alloc(100));
    }).toThrow(/CHECK constraint failed/);

    // Invalid text_sha256 length (must be 64 characters)
    expect(() => {
      db.prepare(
        `
        INSERT INTO CatalogueEmbeddings (
          qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
          embedding_run_id, embedded_at, loaded_at
        ) VALUES (
          'Q10', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?,
          'short-hash', '${sha256("desc")}', 'run-1', '2026-10-15', '2026-10-15'
        )
      `,
      ).run(Buffer.alloc(3072));
    }).toThrow(/CHECK constraint failed/);
  });
});

// ===========================================================================
// Test Suite 2: Valid import, idempotent reloading and exact hash semantics
// ===========================================================================
describe("2. Valid import, idempotent reloading and exact hash semantics", () => {
  it("imports valid records, preserves provenance and is idempotent", async () => {
    const dir = createTempDir();
    const db = createTestDb();

    // Test different punctuation endings per producer textFor contract
    const games = [
      { qid: "Q1", title: "Game Without Period", desc: "A fascinating simulation." },
      { qid: "Q2", title: "Game With Period.", desc: "An epic adventure." },
      { qid: "Q3", title: "Game With Exclamation!", desc: "A thrilling ride!" },
      { qid: "Q4", title: "Game With Question?", desc: "A puzzling mystery?" },
      { qid: "Q5", title: "  Game With Whitespace  ", desc: "A spaced journey." },
    ];

    for (const g of games) {
      seedCatalogueGame(db, g.qid, g.title, g.desc, "run-d1", "run-d1:1");
    }

    const records = games.map((g, idx) => {
      const v = makeVector({ [idx]: idx + 1 });
      return createProducerRecord({
        qid: g.qid,
        title: g.title,
        description: g.desc,
        vector: v,
        runId: `run-emb-${idx}`,
        attemptId: `run-emb-${idx}:1`,
        descRunId: "run-d1",
        descAttemptId: "run-d1:1",
        at: "2026-10-15T12:00:00Z",
      });
    });

    const jsonlPath = path.join(dir, "valid-embeddings.jsonl");
    writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result1 = await loadCatalogueEmbeddings(db, {
      inputFile: jsonlPath,
      reviewConfirmed: true,
      now: new Date("2026-10-15T13:00:00Z"),
    });

    expect(result1.loaded).toBe(5);
    expect(result1.processed).toBe(5);
    expect(result1.duplicates_skipped).toBe(0);

    // Verify row contents and provenance
    const rows = db.prepare("SELECT * FROM CatalogueEmbeddings ORDER BY qid").all() as any[];
    expect(rows).toHaveLength(5);
    expect(rows[0].qid).toBe("Q1");
    expect(rows[0].model).toBe(MODEL);
    expect(rows[0].dimensions).toBe(768);
    expect(rows[0].embedding_run_id).toBe("run-emb-0");
    expect(rows[0].embedding_attempt_id).toBe("run-emb-0:1");
    expect(rows[0].description_run_id).toBe("run-d1");
    expect(rows[0].description_attempt_id).toBe("run-d1:1");
    expect(rows[0].embedded_at).toBe("2026-10-15T12:00:00Z");
    expect(rows[0].loaded_at).toBe("2026-10-15T13:00:00.000Z");

    // Idempotent reload: running again succeeds without creating duplicate rows or erroring
    const result2 = await loadCatalogueEmbeddings(db, {
      inputFile: jsonlPath,
      reviewConfirmed: true,
      now: new Date("2026-10-15T14:00:00Z"),
    });

    expect(result2.loaded).toBe(5);
    const countAfter = db.prepare("SELECT COUNT(*) AS n FROM CatalogueEmbeddings").get() as {
      n: number;
    };
    expect(countAfter.n).toBe(5);

    // Identical duplicate in the same file is collapsed without error
    const doubleRecords = [...records, records[0]];
    const doublePath = path.join(dir, "double-embeddings.jsonl");
    writeFileSync(doublePath, doubleRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result3 = await loadCatalogueEmbeddings(db, {
      inputFile: doublePath,
      reviewConfirmed: true,
    });
    expect(result3.processed).toBe(6);
    expect(result3.loaded).toBe(5);
    expect(result3.duplicates_skipped).toBe(1);
  });
});

// ===========================================================================
// Test Suite 3: Validation, refusals and atomic rollback
// ===========================================================================
describe("3. Validation, refusals and atomic rollback", () => {
  let db: DatabaseType;
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
    db = createTestDb();
    seedCatalogueGame(db, "Q1", "Valid Game 1", "Description 1");
    seedCatalogueGame(db, "Q2", "Valid Game 2", "Description 2");
  });

  it("refuses malformed JSON", async () => {
    const file = path.join(dir, "bad.jsonl");
    const rec1 = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 1.0 }),
    });
    writeFileSync(file, JSON.stringify(rec1) + "\nnot-json\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true }),
    ).rejects.toThrow(/Line 2: malformed JSON/);
  });

  it("refuses non-canonical base64 encoding", async () => {
    const file = path.join(dir, "bad-b64.jsonl");
    const rec = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 1 }),
    });
    // Add extra whitespace inside base64 string (non-canonical)
    rec.vector_f32le_b64 = rec.vector_f32le_b64 + " ";
    writeFileSync(file, JSON.stringify(rec) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true }),
    ).rejects.toThrow(/not canonically encoded/);
  });

  it("refuses wrong byte length and non-finite / NaN values", async () => {
    const file1 = path.join(dir, "wrong-len.jsonl");
    const rec1 = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 1 }),
    });
    // Truncate base64 by 4 bytes
    const buf = Buffer.from(rec1.vector_f32le_b64, "base64").subarray(0, 3068);
    rec1.vector_f32le_b64 = buf.toString("base64");
    writeFileSync(file1, JSON.stringify(rec1) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file1, reviewConfirmed: true }),
    ).rejects.toThrow(/byte length mismatch/);

    const file2 = path.join(dir, "nan.jsonl");
    const buf2 = Buffer.alloc(VECTOR_BYTES);
    buf2.writeFloatLE(NaN, 0);
    for (let i = 1; i < DIMENSIONS; i++) buf2.writeFloatLE(1.0, i * 4);
    const rec2 = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 1: 1 }),
    });
    rec2.vector_f32le_b64 = buf2.toString("base64");
    writeFileSync(file2, JSON.stringify(rec2) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file2, reviewConfirmed: true }),
    ).rejects.toThrow(/not a finite number/);
  });

  it("refuses zero-norm vectors", async () => {
    const file = path.join(dir, "zero-norm.jsonl");
    const rec = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector(), // all zeros
    });
    writeFileSync(file, JSON.stringify(rec) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true }),
    ).rejects.toThrow(/zero or invalid L2 norm/);
  });

  it("refuses unknown games and unpromoted descriptions", async () => {
    const file = path.join(dir, "unknown.jsonl");
    const rec = createProducerRecord({
      qid: "Q999", // not in CatalogueGames
      title: "Unknown Game",
      description: "Some text",
      vector: makeVector({ 0: 1 }),
    });
    writeFileSync(file, JSON.stringify(rec) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true }),
    ).rejects.toThrow(/game 'Q999' not found in CatalogueGames/);
  });

  it("refuses stale description / title hash mismatches", async () => {
    const file = path.join(dir, "mismatch.jsonl");
    const rec = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 1 }),
    });
    // Tamper with text_sha256
    rec.text_sha256 = sha256("different text");
    writeFileSync(file, JSON.stringify(rec) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true }),
    ).rejects.toThrow(/text_sha256 mismatch/);
  });

  it("refuses conflicting duplicates in the same input", async () => {
    const file = path.join(dir, "conflicting-dup.jsonl");
    const rec1 = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 1.0 }),
    });
    const rec2 = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 2.0 }), // different vector!
    });
    writeFileSync(file, [JSON.stringify(rec1), JSON.stringify(rec2)].join("\n") + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);
  });

  it("rolls back all rows atomically on late bad row and preserves prior database", async () => {
    // 1. Initial valid load
    const initialFile = path.join(dir, "initial.jsonl");
    const rec1 = createProducerRecord({
      qid: "Q1",
      title: "Valid Game 1",
      description: "Description 1",
      vector: makeVector({ 0: 1.0 }),
      runId: "run-initial",
    });
    writeFileSync(initialFile, JSON.stringify(rec1) + "\n");
    await loadCatalogueEmbeddings(db, { inputFile: initialFile, reviewConfirmed: true });

    const initialRow = db
      .prepare("SELECT * FROM CatalogueEmbeddings WHERE qid = 'Q1'")
      .get() as any;
    expect(initialRow.embedding_run_id).toBe("run-initial");

    // 2. Second batch: row 1 is a valid update/insert for Q2, row 2 is invalid (unknown QID)
    const badBatchFile = path.join(dir, "bad-batch.jsonl");
    const rec2 = createProducerRecord({
      qid: "Q2",
      title: "Valid Game 2",
      description: "Description 2",
      vector: makeVector({ 1: 1.0 }),
    });
    const recBad = createProducerRecord({
      qid: "Q999",
      title: "Nonexistent",
      description: "None",
      vector: makeVector({ 0: 1.0 }),
    });
    writeFileSync(badBatchFile, [JSON.stringify(rec2), JSON.stringify(recBad)].join("\n") + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: badBatchFile, reviewConfirmed: true }),
    ).rejects.toThrow(/game 'Q999' not found/);

    // Q2 must NOT have been committed (atomic rollback of row 1)
    const q2 = db.prepare("SELECT * FROM CatalogueEmbeddings WHERE qid = 'Q2'").get();
    expect(q2).toBeUndefined();

    // Q1 must still exist completely intact
    const q1After = db.prepare("SELECT * FROM CatalogueEmbeddings WHERE qid = 'Q1'").get() as any;
    expect(q1After.embedding_run_id).toBe("run-initial");
  });
});

// ===========================================================================
// Test Suite 4: Cosine similarity ordering, negative scores, ties and limits
// ===========================================================================
describe("4. Cosine similarity ordering, negative scores, ties and limits", () => {
  let db: DatabaseType;

  beforeEach(async () => {
    db = createTestDb();

    // Set up 7 games with known analytical vectors (all non-unit):
    // Source: Q1 -> u = [3, 4] (norm = 5)
    // Q2 -> v1 = [6, 8]  (norm = 10, cosine = 1.0)
    // Q3 -> v2 = [-4, 3] (norm = 5,  cosine = 0.0, orthogonal)
    // Q4 -> v3 = [-3, -4](norm = 5,  cosine = -1.0, opposite angle)
    // Q5 -> v4 = [12, 16](norm = 20, cosine = 1.0, exact tie with Q2)
    // Q6 -> v5 = [3, 0]  (norm = 3,  cosine = 0.6)
    // Q7 -> v6 = [-3, 0] (norm = 3,  cosine = -0.6)

    const vectors: Record<string, Float32Array> = {
      Q1: makeVector({ 0: 3, 1: 4 }),
      Q2: makeVector({ 0: 6, 1: 8 }),
      Q3: makeVector({ 0: -4, 1: 3 }),
      Q4: makeVector({ 0: -3, 1: -4 }),
      Q5: makeVector({ 0: 12, 1: 16 }),
      Q6: makeVector({ 0: 3, 1: 0 }),
      Q7: makeVector({ 0: -3, 1: 0 }),
    };

    const dir = createTempDir();
    const records = [];
    for (const [qid, vec] of Object.entries(vectors)) {
      const title = `Game ${qid}`;
      const desc = `Description for ${qid}`;
      seedCatalogueGame(db, qid, title, desc);
      records.push(createProducerRecord({ qid, title, description: desc, vector: vec }));
    }

    const file = path.join(dir, "vectors.jsonl");
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true });
  });

  it("calculates exact cosine ranking, handles ties stably, and handles negative scores", () => {
    const res = findSimilarCatalogueGames(db, "Q1", { limit: 10 });

    expect(res.source_qid).toBe("Q1");
    expect(res.source_title).toBe("Game Q1");
    expect(res.disclaimer).toBe(DISCLAIMER);
    expect(res.total_candidates).toBe(6); // Q1 is excluded!

    // Verify ordering and tie-break:
    // Q2 and Q5 both have cosine = 1.0. Stable tie-break by QID ascending: Q2 comes before Q5!
    expect(res.results).toHaveLength(6);
    expect(res.results[0].qid).toBe("Q2");
    expect(res.results[0].similarity).toBeCloseTo(1.0, 5);

    expect(res.results[1].qid).toBe("Q5");
    expect(res.results[1].similarity).toBeCloseTo(1.0, 5);

    expect(res.results[2].qid).toBe("Q6");
    expect(res.results[2].similarity).toBeCloseTo(0.6, 5);

    expect(res.results[3].qid).toBe("Q3");
    expect(res.results[3].similarity).toBeCloseTo(0.0, 5);

    expect(res.results[4].qid).toBe("Q7");
    expect(res.results[4].similarity).toBeCloseTo(-0.6, 5);

    expect(res.results[5].qid).toBe("Q4");
    expect(res.results[5].similarity).toBeCloseTo(-1.0, 5);
  });

  it("respects limits and bounds", () => {
    const res = findSimilarCatalogueGames(db, "Q1", { limit: 2 });
    expect(res.results).toHaveLength(2);
    expect(res.results[0].qid).toBe("Q2");
    expect(res.results[1].qid).toBe("Q5");
  });

  it("validates input QID and limits", () => {
    expect(() => findSimilarCatalogueGames(db, "invalid")).toThrow(/Invalid QID/);
    expect(() => findSimilarCatalogueGames(db, "Q1", { limit: 0 })).toThrow(/between 1 and 100/);
    expect(() => findSimilarCatalogueGames(db, "Q1", { limit: 101 })).toThrow(/between 1 and 100/);
    expect(() => findSimilarCatalogueGames(db, "Q1", { limit: 3.5 })).toThrow(/between 1 and 100/);
  });
});

// ===========================================================================
// Test Suite 5: Freshness and invalidation of source and candidate vectors
// ===========================================================================
describe("5. Freshness and invalidation of source and candidate vectors", () => {
  let db: DatabaseType;

  beforeEach(async () => {
    db = createTestDb();
    const dir = createTempDir();

    seedCatalogueGame(db, "Q1", "Source Game", "Source description");
    seedCatalogueGame(db, "Q2", "Candidate A", "Candidate description A");
    seedCatalogueGame(db, "Q3", "Candidate B", "Candidate description B");

    const records = [
      createProducerRecord({
        qid: "Q1",
        title: "Source Game",
        description: "Source description",
        vector: makeVector({ 0: 1.0 }),
      }),
      createProducerRecord({
        qid: "Q2",
        title: "Candidate A",
        description: "Candidate description A",
        vector: makeVector({ 0: 0.9, 1: 0.1 }),
      }),
      createProducerRecord({
        qid: "Q3",
        title: "Candidate B",
        description: "Candidate description B",
        vector: makeVector({ 0: 0.5, 1: 0.5 }),
      }),
    ];

    const file = path.join(dir, "freshness.jsonl");
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await loadCatalogueEmbeddings(db, { inputFile: file, reviewConfirmed: true });
  });

  it("throws when source game description is edited or withdrawn", () => {
    // Initial search succeeds
    expect(findSimilarCatalogueGames(db, "Q1").results).toHaveLength(2);

    // Edit source description in CatalogueDrafts without re-embedding
    const editedDesc = "Edited description";
    db.prepare(
      `
      UPDATE CatalogueDrafts
      SET value = ?, text_sha256 = ?
      WHERE qid = 'Q1'
    `,
    ).run(JSON.stringify({ description: editedDesc }), sha256(editedDesc));

    expect(() => findSimilarCatalogueGames(db, "Q1")).toThrow(/description has been modified/);

    // Withdraw description draft (label changed or row deleted)
    db.prepare("DELETE FROM CatalogueDrafts WHERE qid = 'Q1'").run();
    expect(() => findSimilarCatalogueGames(db, "Q1")).toThrow(/No promoted generated description/);
  });

  it("throws when source game title is edited", () => {
    db.prepare("UPDATE CatalogueGames SET title = 'New Title' WHERE qid = 'Q1'").run();
    expect(() => findSimilarCatalogueGames(db, "Q1")).toThrow(
      /title\/description binding has been modified/,
    );
  });

  it("excludes candidates whose title or description has been modified or withdrawn, while preserving unrelated candidates", () => {
    // Initially both Candidate A (Q2) and Candidate B (Q3) are returned
    const initial = findSimilarCatalogueGames(db, "Q1");
    expect(initial.results.map((r) => r.qid)).toEqual(["Q2", "Q3"]);

    // Modify Candidate A's description
    const changedDesc = "Changed A";
    db.prepare(
      `
      UPDATE CatalogueDrafts
      SET value = ?, text_sha256 = ?
      WHERE qid = 'Q2'
    `,
    ).run(JSON.stringify({ description: changedDesc }), sha256(changedDesc));

    // Query again: Candidate A is excluded, but Candidate B remains completely valid!
    const afterDescChange = findSimilarCatalogueGames(db, "Q1");
    expect(afterDescChange.results.map((r) => r.qid)).toEqual(["Q3"]);

    // Now edit Candidate B's title
    db.prepare("UPDATE CatalogueGames SET title = 'Changed B' WHERE qid = 'Q3'").run();

    // Now both candidates are stale -> 0 results
    const afterTitleChange = findSimilarCatalogueGames(db, "Q1");
    expect(afterTitleChange.results).toHaveLength(0);
  });
});

// ===========================================================================
// Test Suite 6: CLI parsing, refusal of missing database, safe reporting
// ===========================================================================
describe("6. CLI parsing, refusal of missing database, safe reporting", () => {
  it("refuses missing arguments and missing review confirmation", () => {
    expect(() => parseLoaderArgs([])).toThrow(/--db <database.db> is required/);
    expect(() => parseLoaderArgs(["--invalid"])).toThrow(/usage:/);
    expect(() => parseLoaderArgs(["--db", "some.db"])).toThrow(/--in <file.jsonl> is required/);
    expect(() =>
      parseLoaderArgs(["--db", "some.db", "--in", "embs.jsonl", "--review-confirmed", "false"]),
    ).toThrow(/--review-confirmed true is required/);
  });

  it("refuses if database file does not exist and never creates it", async () => {
    const dir = createTempDir();
    const missingDb = path.join(dir, "missing.db");
    const dummyIn = path.join(dir, "dummy.jsonl");
    writeFileSync(dummyIn, "{}\n");

    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runLoaderCli(
      ["--db", missingDb, "--in", dummyIn, "--review-confirmed", "true"],
      (msg) => errors.push(msg),
    );

    expect(code).toBe(2);
    expect(errors[0]).toContain("Database file does not exist");
    expect(existsSync(missingDb)).toBe(false); // Did NOT create the database!
  });

  it("prints aggregate counts only and no payload data on successful execution", async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "test.db");
    const db = createTestDb(dbPath);
    seedCatalogueGame(db, "Q1", "Safe Title", "Safe Description");
    db.close();

    const inPath = path.join(dir, "embs.jsonl");
    const rec = createProducerRecord({
      qid: "Q1",
      title: "Safe Title",
      description: "Safe Description",
      vector: makeVector({ 0: 1.0 }),
    });
    writeFileSync(inPath, JSON.stringify(rec) + "\n");

    const logs: string[] = [];
    const code = await runLoaderCli(
      ["--db", dbPath, "--in", inPath, "--review-confirmed", "true"],
      () => {},
    );

    // Run main directly with log capture to check output
    const { main: runMain } = await import("../../scripts/catalogue/load-embeddings");
    await runMain(["--db", dbPath, "--in", inPath, "--review-confirmed", "true"], {
      log: (line) => logs.push(line),
    });

    expect(logs.length).toBeGreaterThan(0);
    const output = logs.join("\n");
    expect(output).toContain("Catalogue embeddings import completed: 1 loaded");
    expect(output).not.toContain("Safe Title");
    expect(output).not.toContain("Safe Description");
    expect(output).not.toContain(rec.vector_f32le_b64);
  });
});

// ===========================================================================
// Test Suite 7: Regression P1 - Actual promotion-to-loader boundary & JSON validation
// ===========================================================================
describe("7. Regression P1: Actual promotion-to-loader boundary & JSON validation", () => {
  let dir: string;
  let db: DatabaseType;

  beforeEach(() => {
    dir = createTempDir();
    db = createTestDb();
  });

  it("integrates with promoteCatalogueFacts and promoteCatalogueDrafts, loads embeddings and searches", async () => {
    const sc = await import("../../scripts/catalogue/sample-check.mjs");
    const N = 130;
    const wdFile = path.join(dir, "wd.jsonl");
    const agFile = path.join(dir, "ag.jsonl");
    const drFile = path.join(dir, "dr.jsonl");

    const wdUrl = (q: string) => `https://www.wikidata.org/w/index.php?title=${q}&oldid=7`;
    const steamUrl = (id: number) => `https://store.steampowered.com/app/${id}/`;
    const src = (i: number) => [
      { name: "wikidata", url: wdUrl(`Q${i + 1}`), fetched_at: "2026-10-15T00:00:00Z" },
      { name: "steam", url: steamUrl(2000 + i), fetched_at: "2026-10-15T00:00:00Z" },
    ];
    const factField = (status: string, value: unknown, i: number, basis: unknown = "equal") => ({
      status,
      value,
      sources: status === "agree" ? src(i) : src(i).slice(0, 1),
      values: {},
      ...(status === "agree" ? { basis } : {}),
    });

    const wdRows = Array.from({ length: N }, (_, i) => ({
      qid: `Q${i + 1}`,
      revision: 7,
      label: `Promoted Game ${i + 1}`,
      steam_app_ids: [String(2000 + i)],
      source: {
        name: "wikidata",
        licence: "CC0-1.0",
        url: `https://www.wikidata.org/wiki/Q${i + 1}`,
        revision_url: wdUrl(`Q${i + 1}`),
        fetched_at: "2026-10-15T00:00:00Z",
      },
    }));
    writeFileSync(wdFile, wdRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const agRows = Array.from({ length: N }, (_, i) => ({
      qid: `Q${i + 1}`,
      steam_appid: 2000 + i,
      fields: {
        title: factField("agree", `Promoted Game ${i + 1}`, i),
        release_date: factField("agree", "2020-01-01", i),
        developers: factField("agree", ["Studio"], i, [{ steam: "Studio", wikidata: "Q5" }]),
        publishers: factField("single", null, i),
        platforms: factField("partial", ["windows"], i),
      },
      store: null,
      context: {},
    }));
    writeFileSync(agFile, agRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const drRows = Array.from({ length: N }, (_, i) => ({
      schema: "mgpl-enrichment/1",
      qid: `Q${i + 1}`,
      steam_appid: String(2000 + i),
      task: "description",
      status: "ok",
      label: "generated",
      generated: { description: `Promoted description for game ${i + 1}.` },
      inputs: { wikidata: wdUrl(`Q${i + 1}`), steam: steamUrl(2000 + i), wikipedia: null },
      model: "gemini-3.1-flash-lite",
      prompt_version: "s3-v1",
      run_id: "run-desc-real",
      attempt_id: "run-desc-real:1",
      at: "2026-10-15T01:00:00Z",
    }));
    writeFileSync(drFile, drRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // Execute actual promoteCatalogueFacts
    db.exec(getTableDdl("CatalogueFacts"));
    promoteCatalogueFacts(db, {
      wikidataFile: wdFile,
      agreementFile: agFile,
      reviewConfirmed: true,
      now: new Date("2026-10-15T02:00:00Z"),
    });

    // Draw and accept sample
    const drew = sc.draw({
      kind: "description",
      inputs: [drFile],
      seed: "seed1",
      out: dir,
      titles: wdFile,
    });
    const sheet = path.join(dir, drew.files[0]);
    const table = sc.parseCsv(readFileSync(sheet, "utf8"));
    const vc = table[0].indexOf("verdict");
    for (let r = 1; r < table.length; r++) table[r][vc] = "correct";
    writeFileSync(sheet, sc.toCsv(table));
    sc.score({ sheet });

    const summaryFile = sheet.replace(/\.csv$/, ".summary.json");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    summary.accepted_by = "Principal Operator";
    summary.accepted_at = "2026-10-15T02:00:00Z";
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");

    // Execute actual promoteCatalogueDrafts
    promoteCatalogueDrafts(db, {
      kind: "description",
      draftFiles: [drFile],
      summaryFile,
      reviewConfirmed: true,
      now: new Date("2026-10-15T03:00:00Z"),
    });

    // Verify draft stored in DB is JSON stringified
    const draftRow = db
      .prepare("SELECT value, text_sha256 FROM CatalogueDrafts WHERE qid = 'Q1'")
      .get() as { value: string; text_sha256: string };
    expect(draftRow.value).toBe(
      JSON.stringify({ description: "Promoted description for game 1." }),
    );
    expect(draftRow.text_sha256).toBe(sha256("Promoted description for game 1."));

    // Produce matching vectors and import
    const v1 = makeVector({ 0: 1.0 });
    const v2 = makeVector({ 0: 0.8, 1: 0.6 });
    const embFile = path.join(dir, "promoted-embs.jsonl");
    const embRecs = [
      createProducerRecord({
        qid: "Q1",
        title: "Promoted Game 1",
        description: "Promoted description for game 1.",
        vector: v1,
        descRunId: "run-desc-real",
        descAttemptId: "run-desc-real:1",
      }),
      createProducerRecord({
        qid: "Q2",
        title: "Promoted Game 2",
        description: "Promoted description for game 2.",
        vector: v2,
        descRunId: "run-desc-real",
        descAttemptId: "run-desc-real:1",
      }),
    ];
    writeFileSync(embFile, embRecs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const loadRes = await loadCatalogueEmbeddings(db, {
      inputFile: embFile,
      reviewConfirmed: true,
    });
    expect(loadRes.loaded).toBe(2);

    // Search Q1
    const searchRes = findSimilarCatalogueGames(db, "Q1");
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0].qid).toBe("Q2");
    expect(searchRes.results[0].title).toBe("Promoted Game 2");
    expect(searchRes.results[0].similarity).toBeCloseTo(0.8, 5);
  });

  it("preserves exact whitespace and punctuation in parsed promoted description", async () => {
    const complexDesc =
      "  Punctuation test: does it preserve newlines?\nYes!\tAnd tabs? Absolutely.  ";
    seedCatalogueGame(db, "Q1", "Whitespace Game", complexDesc);

    const v = makeVector({ 0: 1.0 });
    const embFile = path.join(dir, "ws.jsonl");
    const rec = createProducerRecord({
      qid: "Q1",
      title: "Whitespace Game",
      description: complexDesc,
      vector: v,
    });
    writeFileSync(embFile, JSON.stringify(rec) + "\n");

    const res = await loadCatalogueEmbeddings(db, { inputFile: embFile, reviewConfirmed: true });
    expect(res.loaded).toBe(1);

    const row = db
      .prepare("SELECT text_sha256, description_sha256 FROM CatalogueEmbeddings WHERE qid = 'Q1'")
      .get() as { text_sha256: string; description_sha256: string };
    expect(row.description_sha256).toBe(sha256(complexDesc));
    expect(row.text_sha256).toBe(sha256(textFor("Whitespace Game", complexDesc)));
  });

  it("refuses malformed JSON or invalid shape in CatalogueDrafts.value safely without plain-text fallback", async () => {
    // 1. Plain text stored value (legacy or corrupt)
    db.prepare(
      `INSERT INTO CatalogueGames (qid, title, wikidata_url, loaded_at) VALUES ('Q1', 'Game 1', 'url', '2026-10-15')`,
    ).run();
    db.prepare(
      `INSERT INTO CatalogueDrafts (qid, kind, value, label, text_sha256, links, model, prompt_version, drafted_at, sample_summary_sha256, sample_seed, accepted_by, promoted_at)
       VALUES ('Q1', 'description', 'plain text description', 'generated', '${sha256("plain text description")}', '[]', 'm', 'v1', '2026-10-15', '0', 's', 'op', '2026-10-15')`,
    ).run();

    const v = makeVector({ 0: 1.0 });
    const embFile = path.join(dir, "malformed-draft.jsonl");
    const rec = createProducerRecord({
      qid: "Q1",
      title: "Game 1",
      description: "plain text description",
      vector: v,
    });
    writeFileSync(embFile, JSON.stringify(rec) + "\n");

    await expect(
      loadCatalogueEmbeddings(db, { inputFile: embFile, reviewConfirmed: true }),
    ).rejects.toThrow(/has malformed promoted description in CatalogueDrafts/);

    // 2. Non-object JSON: array
    db.prepare("UPDATE CatalogueDrafts SET value = '[1, 2, 3]' WHERE qid = 'Q1'").run();
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: embFile, reviewConfirmed: true }),
    ).rejects.toThrow(/has malformed promoted description/);

    // 3. Object missing description field
    db.prepare(
      "UPDATE CatalogueDrafts SET value = '{\"title\":\"No description\"}' WHERE qid = 'Q1'",
    ).run();
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: embFile, reviewConfirmed: true }),
    ).rejects.toThrow(/has malformed promoted description/);

    // 4. Object with empty or whitespace-only description
    db.prepare(
      "UPDATE CatalogueDrafts SET value = '{\"description\":\"   \"}' WHERE qid = 'Q1'",
    ).run();
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: embFile, reviewConfirmed: true }),
    ).rejects.toThrow(/has malformed promoted description/);

    // 5. Source query throws SOURCE_MALFORMED if source has malformed draft JSON
    db.prepare(
      `INSERT INTO CatalogueEmbeddings (qid, model, task_type, dimensions, vector, text_sha256, description_sha256, embedding_run_id, embedded_at, loaded_at)
       VALUES ('Q1', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?, '${sha256("text")}', '${sha256("desc")}', 'run', '2026-10-15', '2026-10-15')`,
    ).run(Buffer.alloc(VECTOR_BYTES));

    expect(() => findSimilarCatalogueGames(db, "Q1")).toThrow(/has malformed promoted description/);

    // 6. Candidate with malformed draft JSON is safely excluded from candidate pool without throwing
    seedCatalogueGame(db, "Q2", "Valid Source", "Valid Source Desc");
    seedCatalogueGame(db, "Q3", "Valid Candidate", "Valid Candidate Desc");
    // Insert valid embeddings for Q2 and Q3
    const v2 = makeVector({ 0: 1.0 });
    const v3 = makeVector({ 0: 0.9 });
    const vBuf2 = Buffer.from(v2.buffer, v2.byteOffset, VECTOR_BYTES);
    const vBuf3 = Buffer.from(v3.buffer, v3.byteOffset, VECTOR_BYTES);
    db.prepare(
      `INSERT OR REPLACE INTO CatalogueEmbeddings (qid, model, task_type, dimensions, vector, text_sha256, description_sha256, embedding_run_id, embedded_at, loaded_at)
       VALUES ('Q2', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?, ?, ?, 'run', '2026-10-15', '2026-10-15')`,
    ).run(vBuf2, sha256(textFor("Valid Source", "Valid Source Desc")), sha256("Valid Source Desc"));
    db.prepare(
      `INSERT OR REPLACE INTO CatalogueEmbeddings (qid, model, task_type, dimensions, vector, text_sha256, description_sha256, embedding_run_id, embedded_at, loaded_at)
       VALUES ('Q3', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?, ?, ?, 'run', '2026-10-15', '2026-10-15')`,
    ).run(
      vBuf3,
      sha256(textFor("Valid Candidate", "Valid Candidate Desc")),
      sha256("Valid Candidate Desc"),
    );

    // Q1 still has malformed draft; searching from Q2 succeeds and returns Q3 while skipping Q1
    const res2 = findSimilarCatalogueGames(db, "Q2");
    expect(res2.results.map((r) => r.qid)).toEqual(["Q3"]);
  });
});

// ===========================================================================
// Test Suite 8: Regression P2 - Transaction-local cache isolation & rollback
// ===========================================================================
describe("8. Regression P2: Transaction-local cache isolation & rollback", () => {
  let db: DatabaseType;
  let dir: string;

  beforeEach(async () => {
    dir = createTempDir();
    db = createTestDb();

    seedCatalogueGame(db, "Q1", "Source Game", "Source description");
    seedCatalogueGame(db, "Q2", "Candidate Game", "Candidate description");

    const v1 = makeVector({ 0: 1.0 });
    const v2 = makeVector({ 0: 0.9, 1: 0.1 });
    const embFile = path.join(dir, "tx-embs.jsonl");
    const recs = [
      createProducerRecord({
        qid: "Q1",
        title: "Source Game",
        description: "Source description",
        vector: v1,
      }),
      createProducerRecord({
        qid: "Q2",
        title: "Candidate Game",
        description: "Candidate description",
        vector: v2,
      }),
    ];
    writeFileSync(embFile, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await loadCatalogueEmbeddings(db, { inputFile: embFile, reviewConfirmed: true });
  });

  it("isolates in-transaction candidate updates and restores committed state upon ROLLBACK without forceReload", () => {
    // 1. Initial query populates shared cache
    const initial = findSimilarCatalogueGames(db, "Q1");
    expect(initial.results[0].title).toBe("Candidate Game");

    // 2. Open transaction, perform temporary edit and rebind text_sha256
    db.exec("BEGIN");
    db.prepare("UPDATE CatalogueGames SET title = 'Temporary Candidate' WHERE qid = 'Q2'").run();
    db.prepare("UPDATE CatalogueEmbeddings SET text_sha256 = ? WHERE qid = 'Q2'").run(
      sha256(textFor("Temporary Candidate", "Candidate description")),
    );

    // 3. Query inside transaction sees ephemeral update
    const inTx = findSimilarCatalogueGames(db, "Q1");
    expect(inTx.results[0].title).toBe("Temporary Candidate");

    // 4. Rollback transaction
    db.exec("ROLLBACK");

    // 5. Subsequent query WITHOUT forceReload MUST return committed state
    const afterRollback = findSimilarCatalogueGames(db, "Q1");
    expect(afterRollback.results[0].title).toBe("Candidate Game");
  });

  it("isolates in-transaction candidate description updates upon ROLLBACK", () => {
    const initial = findSimilarCatalogueGames(db, "Q1");
    expect(initial.results).toHaveLength(1);

    db.exec("BEGIN");
    const tempDesc = "Temporary new description";
    db.prepare("UPDATE CatalogueDrafts SET value = ?, text_sha256 = ? WHERE qid = 'Q2'").run(
      JSON.stringify({ description: tempDesc }),
      sha256(tempDesc),
    );
    db.prepare(
      "UPDATE CatalogueEmbeddings SET text_sha256 = ?, description_sha256 = ? WHERE qid = 'Q2'",
    ).run(sha256(textFor("Candidate Game", tempDesc)), sha256(tempDesc));

    const inTx = findSimilarCatalogueGames(db, "Q1");
    expect(inTx.results).toHaveLength(1);

    db.exec("ROLLBACK");

    const afterRollback = findSimilarCatalogueGames(db, "Q1");
    expect(afterRollback.results[0].title).toBe("Candidate Game");
  });

  it("isolates in-transaction replacement vectors upon ROLLBACK", () => {
    const initial = findSimilarCatalogueGames(db, "Q1");
    const initialSim = initial.results[0].similarity;
    expect(initialSim).toBeGreaterThan(0.5);

    // Opposite vector (similarity ~ -1.0)
    const oppositeVector = makeVector({ 0: -1.0 });
    const oppBuf = Buffer.from(oppositeVector.buffer, oppositeVector.byteOffset, VECTOR_BYTES);

    db.exec("BEGIN");
    db.prepare("UPDATE CatalogueEmbeddings SET vector = ? WHERE qid = 'Q2'").run(oppBuf);

    const inTx = findSimilarCatalogueGames(db, "Q1");
    expect(inTx.results[0].similarity).toBeCloseTo(-1.0, 5);

    db.exec("ROLLBACK");

    const afterRollback = findSimilarCatalogueGames(db, "Q1");
    expect(afterRollback.results[0].similarity).toBeCloseTo(initialSim, 5);
  });

  it("updates cached index upon COMMIT without forceReload", () => {
    const initial = findSimilarCatalogueGames(db, "Q1");
    expect(initial.results[0].title).toBe("Candidate Game");

    db.exec("BEGIN");
    db.prepare("UPDATE CatalogueGames SET title = 'Committed Candidate' WHERE qid = 'Q2'").run();
    db.prepare("UPDATE CatalogueEmbeddings SET text_sha256 = ? WHERE qid = 'Q2'").run(
      sha256(textFor("Committed Candidate", "Candidate description")),
    );

    const inTx = findSimilarCatalogueGames(db, "Q1");
    expect(inTx.results[0].title).toBe("Committed Candidate");

    db.exec("COMMIT");

    const afterCommit = findSimilarCatalogueGames(db, "Q1");
    expect(afterCommit.results[0].title).toBe("Committed Candidate");
  });

  it("invalidates cache across connections on COMMIT and ignores rolled-back writes from second connection", () => {
    const dbPath = path.join(dir, "multi-conn.db");
    const con1 = createTestDb(dbPath);
    con1.pragma("journal_mode = WAL");

    seedCatalogueGame(con1, "Q1", "Multi Game 1", "Desc 1");
    seedCatalogueGame(con1, "Q2", "Multi Game 2", "Desc 2");

    const v1 = makeVector({ 0: 1.0 });
    const v2 = makeVector({ 0: 0.9, 1: 0.1 });
    const vBuf1 = Buffer.from(v1.buffer, v1.byteOffset, VECTOR_BYTES);
    const vBuf2 = Buffer.from(v2.buffer, v2.byteOffset, VECTOR_BYTES);
    con1
      .prepare(
        `INSERT INTO CatalogueEmbeddings (qid, model, task_type, dimensions, vector, text_sha256, description_sha256, embedding_run_id, embedded_at, loaded_at)
       VALUES ('Q1', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?, ?, ?, 'run', '2026-10-15', '2026-10-15')`,
      )
      .run(vBuf1, sha256(textFor("Multi Game 1", "Desc 1")), sha256("Desc 1"));
    con1
      .prepare(
        `INSERT INTO CatalogueEmbeddings (qid, model, task_type, dimensions, vector, text_sha256, description_sha256, embedding_run_id, embedded_at, loaded_at)
       VALUES ('Q2', 'text-embedding-005', 'SEMANTIC_SIMILARITY', 768, ?, ?, ?, 'run', '2026-10-15', '2026-10-15')`,
      )
      .run(vBuf2, sha256(textFor("Multi Game 2", "Desc 2")), sha256("Desc 2"));

    // Con1 queries and caches
    const res1 = findSimilarCatalogueGames(con1, "Q1");
    expect(res1.results[0].title).toBe("Multi Game 2");

    // Con2 opens connection and performs committed update
    const con2 = new Database(dbPath);
    con2.pragma("journal_mode = WAL");
    con2.prepare("UPDATE CatalogueGames SET title = 'Con2 Committed Title' WHERE qid = 'Q2'").run();
    con2
      .prepare("UPDATE CatalogueEmbeddings SET text_sha256 = ? WHERE qid = 'Q2'")
      .run(sha256(textFor("Con2 Committed Title", "Desc 2")));

    // Con1 queries without forceReload -> detects data_version bump and reflects Con2's update
    const resAfterCon2Commit = findSimilarCatalogueGames(con1, "Q1");
    expect(resAfterCon2Commit.results[0].title).toBe("Con2 Committed Title");

    // Con2 begins transaction, performs temporary edit and rolls back
    con2.exec("BEGIN");
    con2
      .prepare("UPDATE CatalogueGames SET title = 'Con2 RolledBack Title' WHERE qid = 'Q2'")
      .run();
    con2.exec("ROLLBACK");

    // Con1 queries without forceReload -> still returns committed state
    const resAfterCon2Rollback = findSimilarCatalogueGames(con1, "Q1");
    expect(resAfterCon2Rollback.results[0].title).toBe("Con2 Committed Title");

    con1.close();
    con2.close();
  });
});

// ===========================================================================
// Test Suite 9: Regression P2 - Order-invariant duplicate conflict refusal & nulls
// ===========================================================================
describe("9. Regression P2: Order-invariant duplicate conflict refusal & nulls", () => {
  let db: DatabaseType;
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
    db = createTestDb();
    seedCatalogueGame(
      db,
      "Q1",
      "Duplicate Test Game",
      "Desc for duplicate test",
      "run-desc",
      "run-desc:1",
    );
  });

  it("refuses duplicate rows with conflicting description run_id in both orders [A, B] and [B, A]", async () => {
    const v = makeVector({ 0: 1.0 });
    const recA = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
    });
    const recB = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc-different",
      descAttemptId: "run-desc:1",
    });

    const fileAB = path.join(dir, "dup-ab.jsonl");
    writeFileSync(fileAB, [JSON.stringify(recA), JSON.stringify(recB)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileAB, reviewConfirmed: true }),
    ).rejects.toThrow();

    const fileBA = path.join(dir, "dup-ba.jsonl");
    writeFileSync(fileBA, [JSON.stringify(recB), JSON.stringify(recA)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileBA, reviewConfirmed: true }),
    ).rejects.toThrow();
  });

  it("refuses duplicate rows with conflicting description attempt_id in both orders", async () => {
    const v = makeVector({ 0: 1.0 });
    const recA = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
    });
    const recB = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:2",
    });

    const fileAB = path.join(dir, "dup-att-ab.jsonl");
    writeFileSync(fileAB, [JSON.stringify(recA), JSON.stringify(recB)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileAB, reviewConfirmed: true }),
    ).rejects.toThrow();

    const fileBA = path.join(dir, "dup-att-ba.jsonl");
    writeFileSync(fileBA, [JSON.stringify(recB), JSON.stringify(recA)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileBA, reviewConfirmed: true }),
    ).rejects.toThrow();
  });

  it("refuses duplicate rows with conflicting embedded_at timestamp in both orders", async () => {
    const v = makeVector({ 0: 1.0 });
    const recA = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
      at: "2026-10-15T10:00:00Z",
    });
    const recB = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
      at: "2026-10-15T11:00:00Z",
    });

    const fileAB = path.join(dir, "dup-at-ab.jsonl");
    writeFileSync(fileAB, [JSON.stringify(recA), JSON.stringify(recB)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileAB, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);

    const fileBA = path.join(dir, "dup-at-ba.jsonl");
    writeFileSync(fileBA, [JSON.stringify(recB), JSON.stringify(recA)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileBA, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);
  });

  it("refuses duplicate rows with conflicting embedding run_id or attempt_id in both orders", async () => {
    const v = makeVector({ 0: 1.0 });
    const recA = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
      runId: "emb-1",
      attemptId: "emb-1:1",
    });
    const recB = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
      runId: "emb-2",
      attemptId: "emb-1:1",
    });

    const fileAB = path.join(dir, "dup-run-ab.jsonl");
    writeFileSync(fileAB, [JSON.stringify(recA), JSON.stringify(recB)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileAB, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);

    const fileBA = path.join(dir, "dup-run-ba.jsonl");
    writeFileSync(fileBA, [JSON.stringify(recB), JSON.stringify(recA)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileBA, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);
  });

  it("handles explicit null provenance correctly: collapses identical null duplicates, refuses conflicts in both orders", async () => {
    // Seed draft with explicit nulls
    db.prepare(
      `INSERT OR REPLACE INTO CatalogueDrafts (
        qid, kind, value, label, text_sha256, links, model, prompt_version,
        run_id, attempt_id, drafted_at, sample_summary_sha256, sample_seed,
        accepted_by, promoted_at
      ) VALUES (
        'Q1', 'description', ?, 'generated', ?, '[]', 'gemini-3.8-flash', 'v1',
        NULL, NULL, '2026-10-15T00:00:00Z', '0000', 'seed-1',
        'Principal Operator', '2026-10-15T00:00:00Z'
      )`,
    ).run(
      JSON.stringify({ description: "Desc for duplicate test" }),
      sha256("Desc for duplicate test"),
    );

    const v = makeVector({ 0: 1.0 });
    const recNull1 = {
      schema: SCHEMA,
      qid: "Q1",
      model: MODEL,
      dimensions: DIMENSIONS,
      task_type: TASK_TYPE,
      text_sha256: sha256(textFor("Duplicate Test Game", "Desc for duplicate test")),
      description: { run_id: null, attempt_id: null },
      vector_f32le_b64: encodeVector(v),
      run_id: "emb-run",
      attempt_id: null,
      at: "2026-10-15T00:00:00Z",
    };
    const recNull2 = structuredClone(recNull1);

    // True identical duplicates with explicit nulls collapse
    const fileNullIdentical = path.join(dir, "null-identical.jsonl");
    writeFileSync(
      fileNullIdentical,
      [JSON.stringify(recNull1), JSON.stringify(recNull2)].join("\n") + "\n",
    );
    const res = await loadCatalogueEmbeddings(db, {
      inputFile: fileNullIdentical,
      reviewConfirmed: true,
    });
    expect(res.loaded).toBe(1);
    expect(res.duplicates_skipped).toBe(1);

    // Conflicting non-null provenance
    const recNonNull = structuredClone(recNull1);
    recNonNull.description.run_id = "non-null-desc";

    const fileNullNonNull = path.join(dir, "null-nonnull.jsonl");
    writeFileSync(
      fileNullNonNull,
      [JSON.stringify(recNull1), JSON.stringify(recNonNull)].join("\n") + "\n",
    );
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileNullNonNull, reviewConfirmed: true }),
    ).rejects.toThrow();

    const fileNonNullNull = path.join(dir, "nonnull-null.jsonl");
    writeFileSync(
      fileNonNullNull,
      [JSON.stringify(recNonNull), JSON.stringify(recNull1)].join("\n") + "\n",
    );
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileNonNullNull, reviewConfirmed: true }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Test Suite 10: Regression P2 - Unambiguous digest serialization (NUL boundaries)
// ===========================================================================

describe("10. Regression P2: unambiguous digest serialization (NUL boundaries)", () => {
  let db: DatabaseType;
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
    db = createTestDb();
    seedCatalogueGame(
      db,
      "Q1",
      "Duplicate Test Game",
      "Desc for duplicate test",
      "run-desc",
      "run-desc:1",
    );
  });

  function baseRecord() {
    return {
      schema: SCHEMA,
      qid: "Q1",
      model: MODEL,
      dimensions: DIMENSIONS,
      task_type: TASK_TYPE,
      text_sha256: sha256(textFor("Duplicate Test Game", "Desc for duplicate test")),
      vector_f32le_b64: encodeVector(makeVector({ 0: 1.0 })),
      run_id: "emb-run",
      attempt_id: "emb-attempt",
      at: "2026-10-15T00:00:00Z",
    };
  }

  it("produces distinct digests for boundary-shifted embedding run_id/attempt_id", () => {
    const a = computeRecordDigest(
      { ...baseRecord(), run_id: "emb\u0000segment", attempt_id: "1" },
      "run-desc",
      "run-desc:1",
    );
    const b = computeRecordDigest(
      { ...baseRecord(), run_id: "emb", attempt_id: "segment\u00001" },
      "run-desc",
      "run-desc:1",
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("produces distinct digests for boundary-shifted description run_id/attempt_id", () => {
    const base = baseRecord();
    const a = computeRecordDigest(base, "d\u0000esc", "run-desc:1");
    const b = computeRecordDigest(base, "d", "esc\u0000run-desc:1");
    expect(a).not.toBe(b);
  });

  it("normalizes null and undefined provenance identically and keeps null distinct from empty string", () => {
    const base = baseRecord();
    expect(computeRecordDigest(base, "run-desc", "run-desc:1")).toBe(
      computeRecordDigest(base, "run-desc", "run-desc:1"),
    );

    // undefined and null embedding attempt_id normalize to the same explicit null
    const attemptNull = computeRecordDigest(
      { ...base, attempt_id: null },
      "run-desc",
      "run-desc:1",
    );
    const attemptUndefined = computeRecordDigest(
      { ...base, attempt_id: undefined },
      "run-desc",
      "run-desc:1",
    );
    expect(attemptUndefined).toBe(attemptNull);

    // null description provenance differs from empty-string description provenance
    const descNull = computeRecordDigest(base, null, null);
    const descEmpty = computeRecordDigest(base, "", "");
    expect(descNull).not.toBe(descEmpty);

    // null embedding attempt_id differs from empty-string embedding attempt_id
    const attemptEmpty = computeRecordDigest({ ...base, attempt_id: "" }, "run-desc", "run-desc:1");
    expect(attemptEmpty).not.toBe(attemptNull);
  });

  it("refuses boundary-shifted embedding run_id/attempt_id as conflicting duplicates in both orders", async () => {
    const v = makeVector({ 0: 1.0 });
    const recA = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
      runId: "emb\u0000segment",
      attemptId: "1",
    });
    const recB = createProducerRecord({
      qid: "Q1",
      title: "Duplicate Test Game",
      description: "Desc for duplicate test",
      vector: v,
      descRunId: "run-desc",
      descAttemptId: "run-desc:1",
      runId: "emb",
      attemptId: "segment\u00001",
    });

    const fileAB = path.join(dir, "nul-boundary-ab.jsonl");
    writeFileSync(fileAB, [JSON.stringify(recA), JSON.stringify(recB)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileAB, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);
    // Atomic rollback: no partial write survived the rejected load
    expect(db.prepare("SELECT * FROM CatalogueEmbeddings WHERE qid = 'Q1'").get()).toBeUndefined();

    const fileBA = path.join(dir, "nul-boundary-ba.jsonl");
    writeFileSync(fileBA, [JSON.stringify(recB), JSON.stringify(recA)].join("\n") + "\n");
    await expect(
      loadCatalogueEmbeddings(db, { inputFile: fileBA, reviewConfirmed: true }),
    ).rejects.toThrow(/conflicting duplicate record for Q1/);
    expect(db.prepare("SELECT * FROM CatalogueEmbeddings WHERE qid = 'Q1'").get()).toBeUndefined();
  });
});
