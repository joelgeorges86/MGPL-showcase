// #158 / WU-032c: File-backed catalogue similarity readiness benchmark.
// Populates a file-backed SQLite fixture with invented catalogue records, then
// measures cold/warm/reload latency and memory in a fresh child process so that population
// allocations do not contaminate the search-process memory figures.
// Fixtures are uniquely created under .tmp_benchmark_filebacked/ and retained without automatic
// deletion. Reports identify the original fixture_creation_path with status current_location_unverified
// because paths or ancestor directories may be moved or substituted.
// A representative 103,005-vector fixture occupies ~450 MB; repeated runs accumulate
// disk usage and require manual operator cleanup when idle.
// cspell:words jsonl qids cpus
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DIMENSIONS,
  findSimilarCatalogueGames,
  invalidateSimilarityCache,
  sha256,
  textFor,
  VECTOR_BYTES,
} from "../../src/services/catalogueSimilarity";
import { mulberry32 } from "./benchmark-similarity";

export const FIXTURE_COUNT = 103005;
export const FIXTURE_SEED = 0x158032b;
export const WARM_QUERIES = 50;
export const RELOAD_SAMPLES = 5;
export const RESULT_LIMIT = 10;
export const SCRATCH_PARENT_NAME = ".tmp_benchmark_filebacked";
export const FIXTURE_DB_NAME = "fixture.db";
export const UNRELATED_TABLE = "BenchmarkUnrelated";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SRC_DB_PATH = path.resolve(path.dirname(SCRIPT_PATH), "..", "..", "src", "db.ts");

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return round(sorted[idx]);
}

function mb(bytes: number): number {
  return round(bytes / (1024 * 1024));
}

/** Extract the authoritative CREATE TABLE statement from src/db.ts so the fixture schema never drifts. */
export function extractTableDdl(table: string): string {
  const source = readFileSync(SRC_DB_PATH, "utf8");
  const match = source.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`),
  );
  if (!match) throw new Error(`Could not find DDL for ${table} in src/db.ts`);
  return match[0];
}

export function resolveScratchParent(cwd = process.cwd()): string {
  return path.resolve(cwd, SCRATCH_PARENT_NAME);
}

export interface OwnedScratchDir {
  readonly path: string;
  readonly parent: string;
}

/**
 * Fail closed if any component of targetPath or its existing ancestors is a symbolic link or junction.
 */
export function assertNoSymlinkAncestry(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  let curr = resolved;
  while (curr && curr !== root) {
    try {
      const stat = lstatSync(curr);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing scratch path containing symlink or junction: ${curr}`);
      }
    } catch (err: unknown) {
      const errorWithCode = err as { code?: string };
      if (errorWithCode?.code === "ENOENT") {
        const parentDir = path.dirname(curr);
        if (parentDir === curr) break;
        curr = parentDir;
        continue;
      }
      throw err;
    }
    const parentDir = path.dirname(curr);
    if (parentDir === curr) break;
    curr = parentDir;
  }
}

// Ownership is established at creation, not by basename: tracks uniquely created directories.
const ownedScratchPaths = new Set<string>();

/** Atomically create an exclusively-owned unique scratch directory under the verified parent. */
export function createScratchDir(parent = resolveScratchParent()): OwnedScratchDir {
  const resolvedParent = path.resolve(parent);
  if (path.basename(resolvedParent) !== SCRATCH_PARENT_NAME) {
    throw new Error(`Refusing to create scratch outside the verified parent: ${resolvedParent}`);
  }
  // Refuse preexisting junction or symlink parent or ancestors before creation.
  assertNoSymlinkAncestry(resolvedParent);
  mkdirSync(resolvedParent, { recursive: true });
  // Re-verify after mkdirSync to ensure no linked path was substituted.
  assertNoSymlinkAncestry(resolvedParent);
  const owned = mkdtempSync(path.join(resolvedParent, "fixture-"));
  assertNoSymlinkAncestry(owned);
  ownedScratchPaths.add(owned);
  return { path: owned, parent: resolvedParent };
}

/** Create the three authoritative catalogue tables plus one invented unrelated table. */
export function createFixtureSchema(db: DatabaseType): void {
  for (const table of ["CatalogueGames", "CatalogueDrafts", "CatalogueEmbeddings"]) {
    db.exec(extractTableDdl(table));
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${UNRELATED_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL);`,
  );
}

export function populateFixture(dbPath: string, count: number, seed: number): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createFixtureSchema(db);

    const rng = mulberry32(seed);
    const vectorBuffer = Buffer.alloc(VECTOR_BYTES);
    const ts = "2026-10-15T00:00:00Z";

    const insertGame = db.prepare(
      "INSERT INTO CatalogueGames (qid, title, wikidata_url, loaded_at) VALUES (?, ?, ?, ?)",
    );
    const insertDraft = db.prepare(`
    INSERT INTO CatalogueDrafts (
      qid, kind, value, label, text_sha256, links, model, prompt_version,
      run_id, attempt_id, drafted_at, sample_summary_sha256, sample_seed,
      accepted_by, promoted_at
    ) VALUES (
      ?, 'description', ?, 'generated', ?, '[]', 'gemini-3.8-flash', 'v1',
      'run-bench', 'run-bench:1', ?, '0000', 'seed', 'Principal Operator', ?
    )
  `);
    const insertEmbedding = db.prepare(`
    INSERT INTO CatalogueEmbeddings (
      qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
      description_run_id, description_attempt_id, embedding_run_id, embedding_attempt_id,
      embedded_at, loaded_at
    ) VALUES (
      ?, 'text-embedding-005', 'SEMANTIC_SIMILARITY', ?, ?, ?, ?,
      'run-bench', 'run-bench:1', 'emb-bench', 'emb-bench:1', ?, ?
    )
  `);

    const populateTx = db.transaction(() => {
      for (let i = 1; i <= count; i++) {
        const qid = `Q${i}`;
        const title = `Synthetic Game ${i}`;
        const desc = `Synthetic description for game ${i} exhibiting varied characteristics.`;
        const descSha = sha256(desc);
        const textSha = sha256(textFor(title, desc));
        const draftValue = JSON.stringify({ description: desc });

        for (let j = 0; j < DIMENSIONS; j++) {
          const val = (rng() - 0.5) * 2;
          vectorBuffer.writeFloatLE(val, j * 4);
        }

        insertGame.run(qid, title, `https://www.wikidata.org/wiki/${qid}`, ts);
        insertDraft.run(qid, draftValue, descSha, ts, ts);
        insertEmbedding.run(qid, DIMENSIONS, vectorBuffer, textSha, descSha, ts, ts);
      }
    });
    populateTx();
  } finally {
    db.close();
  }
}

export interface MeasurementResult {
  db_open_ms: number;
  cold_first_use_ms: number;
  cold_first_use_includes_db_open: boolean;
  baseline_rss_bytes: number;
  baseline_heap_used_bytes: number;
  after_first_index_rss_bytes: number;
  after_first_index_heap_used_bytes: number;
  after_first_index_external_bytes: number;
  warm_queries_count: number;
  warm_times_ms: number[];
  warm_p50_ms: number;
  warm_p95_ms: number;
  warm_p99_ms: number;
  warm_mean_ms: number;
  reload_samples_count: number;
  reload_times_ms: number[];
  reload_min_ms: number;
  reload_max_ms: number;
  reload_mean_ms: number;
  rss_samples_bytes: number[];
  max_rss_value: number | null;
  max_rss_units_note: string;
  cold_result_count: number;
}

/** Run the latency/memory measurement. Must execute in a fresh child process. */
export function runMeasurement(
  dbPath: string,
  count: number,
  warmQueries: number,
  reloadSamples: number,
): MeasurementResult {
  const baselineRss = process.memoryUsage().rss;
  const baselineHeapUsed = process.memoryUsage().heapUsed;

  // DB open is measured and reported separately; it is NOT included in cold_first_use_ms.
  const tOpen0 = performance.now();
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    const tOpen1 = performance.now();
    const dbOpenMs = tOpen1 - tOpen0;

    // First uncached public-service query: includes reading all rows from the file-backed DB,
    // description parsing, vector decoding and ranking (inside the index build).
    invalidateSimilarityCache(db);
    const tCold0 = performance.now();
    const coldResult = findSimilarCatalogueGames(db, "Q1", { limit: RESULT_LIMIT });
    const tCold1 = performance.now();
    const coldMs = tCold1 - tCold0;

    if (coldResult.results.length !== RESULT_LIMIT) {
      throw new Error(
        `Cold query returned ${coldResult.results.length} results, expected ${RESULT_LIMIT}`,
      );
    }
    const expectedQids = coldResult.results.map((r) => r.qid).join(",");

    const afterFirstIndex = process.memoryUsage();

    // Warmed queries over deterministic QIDs.
    const warmTimes: number[] = [];
    for (let i = 0; i < warmQueries; i++) {
      const qid = `Q${(i % count) + 1}`;
      const t0 = performance.now();
      const res = findSimilarCatalogueGames(db, qid, { limit: RESULT_LIMIT });
      const t1 = performance.now();
      if (res.results.length !== RESULT_LIMIT) {
        throw new Error(
          `Warm query ${qid} returned ${res.results.length} results, expected ${RESULT_LIMIT}`,
        );
      }
      warmTimes.push(t1 - t0);
    }

    // Unrelated-table writes: each invalidates the total_changes/data_version counter, forcing a
    // full index rebuild on the next query. Correctness of results is verified before and after.
    const reloadTimes: number[] = [];
    const rssSamples: number[] = [afterFirstIndex.rss];
    for (let i = 0; i < reloadSamples; i++) {
      db.prepare(`INSERT INTO ${UNRELATED_TABLE} (note) VALUES (?)`).run(`reload-${i}`);
      const t0 = performance.now();
      const res = findSimilarCatalogueGames(db, "Q1", { limit: RESULT_LIMIT });
      const t1 = performance.now();
      if (res.results.length !== RESULT_LIMIT) {
        throw new Error(
          `Reload ${i} returned ${res.results.length} results, expected ${RESULT_LIMIT}`,
        );
      }
      if (res.results.map((r) => r.qid).join(",") !== expectedQids) {
        throw new Error(`Reload ${i} returned different results after an unrelated write`);
      }
      reloadTimes.push(t1 - t0);
      rssSamples.push(process.memoryUsage().rss);
    }

    let maxRss: number | null = null;
    try {
      const ru = process.resourceUsage();
      maxRss = typeof ru.maxRSS === "number" ? ru.maxRSS : null;
    } catch {
      // maxRss remains null when resourceUsage is unavailable
    }

    warmTimes.sort((a, b) => a - b);
    const reloadSorted = [...reloadTimes].sort((a, b) => a - b);

    return {
      db_open_ms: round(dbOpenMs),
      cold_first_use_ms: round(coldMs),
      cold_first_use_includes_db_open: false,
      baseline_rss_bytes: baselineRss,
      baseline_heap_used_bytes: baselineHeapUsed,
      after_first_index_rss_bytes: afterFirstIndex.rss,
      after_first_index_heap_used_bytes: afterFirstIndex.heapUsed,
      after_first_index_external_bytes: afterFirstIndex.external,
      warm_queries_count: warmQueries,
      warm_times_ms: warmTimes.map(round),
      warm_p50_ms: percentile(warmTimes, 50),
      warm_p95_ms: percentile(warmTimes, 95),
      warm_p99_ms: percentile(warmTimes, 99),
      warm_mean_ms: mean(warmTimes),
      reload_samples_count: reloadSamples,
      reload_times_ms: reloadTimes.map(round),
      reload_min_ms: round(reloadSorted[0]),
      reload_max_ms: round(reloadSorted[reloadSorted.length - 1]),
      reload_mean_ms: mean(reloadTimes),
      rss_samples_bytes: rssSamples,
      max_rss_value: maxRss,
      max_rss_units_note:
        "process.resourceUsage().maxRSS; units and peak semantics are platform-dependent and not verified on win32 (informational only, not a measured high-water mark)",
      cold_result_count: coldResult.results.length,
    };
  } finally {
    db.close();
  }
}

/**
 * Non-deleting compatibility helper.
 * Automatic filesystem deletion has been removed from the benchmark per PR #203 retention policy.
 * Fixtures are retained for manual operator inspection at their original creation path (current location
 * unverified if moved or replaced); this function performs no filesystem deletion and leaves all
 * directories and files intact.
 */
export function cleanupScratchDir(owned?: OwnedScratchDir): void {
  void owned;
  // Retain fixtures without deletion.
}

function currentCommitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export interface FileBackedMetrics extends MeasurementResult {
  node_version: string;
  os_platform: string;
  os_arch: string;
  cpu_model: string;
  commit_sha: string;
  total_vectors: number;
  dimensions: number;
  seed: number;
  scratch_dir_name: string;
  fixture_creation_path: string;
  fixture_location_status: "current_location_unverified";
  database_file_bytes: number;
  population_ms: number;
  cold_first_use_under_one_second: boolean;
  warmed_p95_under_one_second: boolean;
}

export function runFullBenchmark(
  count = FIXTURE_COUNT,
  warmQueries = WARM_QUERIES,
  reloadSamples = RELOAD_SAMPLES,
  seed = FIXTURE_SEED,
  scratchParent = resolveScratchParent(),
  spawnSyncFn: typeof spawnSync = spawnSync,
): FileBackedMetrics {
  const owned = createScratchDir(scratchParent);
  const dbPath = path.join(owned.path, FIXTURE_DB_NAME);

  let populationCompleted = false;
  let measurementCompleted = false;
  let primaryError: unknown = null;
  let metrics: FileBackedMetrics | null = null;
  try {
    const tPop0 = performance.now();
    populateFixture(dbPath, count, seed);
    const tPop1 = performance.now();
    populationCompleted = true;
    const databaseFileBytes = statSync(dbPath).size;

    // Measurement runs in a fresh child process so population allocations do not inflate RSS.
    const child = spawnSyncFn(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT_PATH,
        "measure",
        dbPath,
        String(count),
        String(warmQueries),
        String(reloadSamples),
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 },
    );
    if (child.error) {
      throw new Error(`Measurement child process failed to terminate: ${child.error.message}`);
    }
    if (child.status !== 0) {
      throw new Error(`Measurement child process failed (status ${child.status}): ${child.stderr}`);
    }
    const measurement = JSON.parse(child.stdout.trim()) as MeasurementResult;
    measurementCompleted = true;

    metrics = {
      node_version: process.version,
      os_platform: `${process.platform} (${os.release()})`,
      os_arch: os.arch(),
      cpu_model: os.cpus()[0]?.model || "unknown",
      commit_sha: currentCommitSha(),
      total_vectors: count,
      dimensions: DIMENSIONS,
      seed,
      scratch_dir_name: SCRATCH_PARENT_NAME,
      fixture_creation_path: owned.path,
      fixture_location_status: "current_location_unverified",
      database_file_bytes: databaseFileBytes,
      population_ms: round(tPop1 - tPop0),
      ...measurement,
      cold_first_use_under_one_second: measurement.cold_first_use_ms < 1000,
      warmed_p95_under_one_second: measurement.warm_p95_ms < 1000,
    };
  } catch (err) {
    primaryError = err;
  }

  // Automatic fixture deletion has been removed per PR #203 retention policy.
  // Fixtures are retained on both success and failure paths; report the original creation path
  // with an explicit caveat that the current location is unverified.
  if (primaryError !== null) {
    console.error(
      `[benchmark] fixture created at ${owned.path} (current location unverified; population ${
        populationCompleted ? "completed" : "incomplete"
      }, measurement ${measurementCompleted ? "completed" : "incomplete"})`,
    );
    throw primaryError;
  }
  if (metrics === null) {
    throw new Error("benchmark produced no metrics");
  }
  return metrics;
}

export function printReport(m: FileBackedMetrics): void {
  console.log("===========================================================");
  console.log("  MGPL WU-032c File-Backed Catalogue Similarity Benchmark   ");
  console.log("===========================================================");
  console.log(`Node Version:             ${m.node_version}`);
  console.log(`OS / Architecture:        ${m.os_platform} ${m.os_arch}`);
  console.log(`CPU Model:                ${m.cpu_model}`);
  console.log(`Commit (source identity): ${m.commit_sha}`);
  console.log(
    `Total Vectors:            ${m.total_vectors.toLocaleString()} (${m.dimensions} dimensions, seed 0x${m.seed.toString(16)})`,
  );
  console.log(`Fixture DB file size:     ${(m.database_file_bytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(
    `Fixture creation path:   ${m.fixture_creation_path} (current location unverified; may differ if moved or replaced)`,
  );
  console.log(
    "Retention policy:        Automatic deletion disabled. Fixture retained at creation path (~450 MB); operator removes manually when idle.",
  );
  console.log(`Population (parent proc): ${m.population_ms} ms`);
  console.log("-----------------------------------------------------------");
  console.log(`DB open (excl. cold):     ${m.db_open_ms} ms`);
  console.log(
    `Cold First-Use (query):   ${m.cold_first_use_ms} ms [file read + parse + decode + ranking; excludes DB open]`,
  );
  console.log(
    `Memory: baseline RSS ${mb(m.baseline_rss_bytes)} MB -> after-index RSS ${mb(
      m.after_first_index_rss_bytes,
    )} MB (heap ${mb(m.after_first_index_heap_used_bytes)} MB, external ${mb(
      m.after_first_index_external_bytes,
    )} MB)`,
  );
  console.log(`  RSS samples after each reload (MB): ${m.rss_samples_bytes.map(mb).join(", ")}`);
  console.log(`  resourceUsage().maxRSS: ${m.max_rss_value ?? "n/a"} (${m.max_rss_units_note})`);
  console.log("-----------------------------------------------------------");
  console.log(`Warmed Queries (${m.warm_queries_count} runs):`);
  console.log(
    `  E2E p50 / p95 / p99: ${m.warm_p50_ms} ms / ${m.warm_p95_ms} ms / ${m.warm_p99_ms} ms (mean ${m.warm_mean_ms} ms)`,
  );
  console.log(
    `Reload after unrelated write (${m.reload_samples_count} samples): min ${m.reload_min_ms} ms / max ${m.reload_max_ms} ms / mean ${m.reload_mean_ms} ms`,
  );
  console.log(`  Reload times (ms): ${m.reload_times_ms.join(", ")}`);
  console.log("-----------------------------------------------------------");
  console.log(
    `Target (< 1.0s) Cold:     ${m.cold_first_use_under_one_second ? "YES (PASS)" : "NO (MISS)"}`,
  );
  console.log(
    `Target (< 1.0s) Warmed p95: ${m.warmed_p95_under_one_second ? "YES (PASS)" : "NO (MISS)"}`,
  );
  console.log("===========================================================");
  console.log(JSON.stringify(m, null, 2));
}

export function main(): void {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? "run";

  if (subcommand === "measure") {
    const dbPath = args[1];
    const count = Number(args[2]);
    const warmQueries = Number(args[3]);
    const reloadSamples = Number(args[4]);
    if (
      !dbPath ||
      !Number.isFinite(count) ||
      !Number.isFinite(warmQueries) ||
      !Number.isFinite(reloadSamples)
    ) {
      console.error("measure requires: <dbPath> <count> <warmQueries> <reloadSamples>");
      process.exit(1);
    }
    console.log(JSON.stringify(runMeasurement(dbPath, count, warmQueries, reloadSamples)));
    return;
  }

  if (subcommand === "populate") {
    const owned = createScratchDir();
    const count = args[2] ? Number(args[2]) : FIXTURE_COUNT;
    const seed = args[3] ? Number(args[3]) : FIXTURE_SEED;
    const dbPath = path.join(owned.path, FIXTURE_DB_NAME);
    let populationCompleted = false;
    try {
      const t0 = performance.now();
      populateFixture(dbPath, count, seed);
      const t1 = performance.now();
      populationCompleted = true;
      console.log(
        JSON.stringify({
          db_path: dbPath,
          fixture_creation_path: owned.path,
          fixture_location_status: "current_location_unverified",
          population_ms: round(t1 - t0),
          database_file_bytes: statSync(dbPath).size,
        }),
      );
    } catch (err) {
      console.error(
        `[benchmark] fixture created at ${owned.path} (current location unverified; population ${
          populationCompleted ? "completed" : "incomplete"
        }, measurement incomplete)`,
      );
      throw err;
    }
    return;
  }

  printReport(runFullBenchmark());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
