// #158 / WU-032b: Offline performance benchmark for catalogue semantic similarity search.
// Evaluates cosine similarity search over 103,005 synthetic 768-dimensional vectors.
// Uses a reproducible fixed PRNG seed to ensure non-identical, deterministic vectors.
// cspell:words jsonl qids cpus
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  buildSimilarityIndex,
  DIMENSIONS,
  findSimilarCatalogueGames,
  getSimilarityIndex,
  invalidateSimilarityCache,
  rankSimilarCandidates,
  sha256,
  textFor,
  VECTOR_BYTES,
} from "../../src/services/catalogueSimilarity";

export const BENCHMARK_COUNT = 103005;
export const BENCHMARK_SEED = 0x158032b;
export const BENCHMARK_WARM_QUERIES = 50;

/** Mulberry32 32-bit deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BenchmarkMetrics {
  node_version: string;
  os_platform: string;
  os_arch: string;
  cpu_model: string;
  total_vectors: number;
  dimensions: number;
  memory_baseline_mb: number;
  memory_peak_sampled_rss_mb: number;
  memory_delta_sampled_rss_mb: number;
  memory_peak_mb: number;
  memory_delta_mb: number;
  data_generation_ms: number;
  index_load_and_decode_ms: number;
  cold_query_e2e_ms: number;
  post_unrelated_write_e2e_ms: number;
  warm_queries_count: number;
  warm_search_only: {
    min_ms: number;
    max_ms: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    mean_ms: number;
  };
  warm_end_to_end: {
    min_ms: number;
    max_ms: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    mean_ms: number;
  };
  targets: {
    cold_first_use_under_one_second: boolean;
    warmed_p95_under_one_second: boolean;
  };
  under_one_second_target_met: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function runSimilarityBenchmark(
  count = BENCHMARK_COUNT,
  warmIterations = BENCHMARK_WARM_QUERIES,
  seed = BENCHMARK_SEED,
): BenchmarkMetrics {
  const initialMem = process.memoryUsage().rss / (1024 * 1024);

  const db: DatabaseType = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE CatalogueGames (
      qid TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      steam_appid TEXT,
      wikidata_url TEXT NOT NULL,
      loaded_at TEXT NOT NULL
    );

    CREATE TABLE CatalogueDrafts (
      qid TEXT NOT NULL REFERENCES CatalogueGames(qid),
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      sourced TEXT,
      overrides TEXT,
      text_sha256 TEXT NOT NULL,
      links TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      run_id TEXT,
      attempt_id TEXT,
      drafted_at TEXT NOT NULL,
      sample_summary_sha256 TEXT NOT NULL,
      sample_seed TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      promoted_at TEXT NOT NULL,
      PRIMARY KEY (qid, kind)
    );

    CREATE TABLE CatalogueEmbeddings (
      qid TEXT PRIMARY KEY NOT NULL REFERENCES CatalogueGames(qid),
      model TEXT NOT NULL,
      task_type TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      text_sha256 TEXT NOT NULL,
      description_sha256 TEXT NOT NULL,
      description_run_id TEXT,
      description_attempt_id TEXT,
      embedding_run_id TEXT NOT NULL,
      embedding_attempt_id TEXT,
      embedded_at TEXT NOT NULL,
      loaded_at TEXT NOT NULL
    );
  `);

  const rng = mulberry32(seed);

  const insertGame = db.prepare(`
    INSERT INTO CatalogueGames (qid, title, wikidata_url, loaded_at)
    VALUES (?, ?, ?, '2026-10-15T00:00:00Z')
  `);
  const insertDraft = db.prepare(`
    INSERT INTO CatalogueDrafts (
      qid, kind, value, label, text_sha256, links, model, prompt_version,
      run_id, attempt_id, drafted_at, sample_summary_sha256, sample_seed,
      accepted_by, promoted_at
    ) VALUES (
      ?, 'description', ?, 'generated', ?, '[]', 'gemini-3.8-flash', 'v1',
      'run-bench', 'run-bench:1', '2026-10-15T00:00:00Z', '0000', 'seed',
      'Principal Operator', '2026-10-15T00:00:00Z'
    )
  `);
  const insertEmbedding = db.prepare(`
    INSERT INTO CatalogueEmbeddings (
      qid, model, task_type, dimensions, vector, text_sha256, description_sha256,
      description_run_id, description_attempt_id, embedding_run_id, embedding_attempt_id,
      embedded_at, loaded_at
    ) VALUES (
      ?, 'text-embedding-005', 'SEMANTIC_SIMILARITY', ?, ?, ?, ?,
      'run-bench', 'run-bench:1', 'emb-bench', 'emb-bench:1',
      '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z'
    )
  `);

  const tGenStart = performance.now();
  const vectorBuffer = Buffer.alloc(VECTOR_BYTES);

  const populateTx = db.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const qid = `Q${i}`;
      const title = `Synthetic Game ${i}`;
      const desc = `Synthetic description for game ${i} exhibiting varied characteristics.`;
      const descSha = sha256(desc);
      const text = textFor(title, desc);
      const textSha = sha256(text);
      const draftValue = JSON.stringify({ description: desc });

      // Generate non-identical pseudo-random vector with non-unit norm
      for (let j = 0; j < DIMENSIONS; j++) {
        const val = (rng() - 0.5) * 2;
        vectorBuffer.writeFloatLE(val, j * 4);
      }

      insertGame.run(qid, title, `https://www.wikidata.org/wiki/${qid}`);
      insertDraft.run(qid, draftValue, descSha);
      insertEmbedding.run(qid, DIMENSIONS, vectorBuffer, textSha, descSha);
    }
  });

  populateTx();
  const tGenEnd = performance.now();
  const dataGenerationMs = Math.round(tGenEnd - tGenStart);

  // 1. Invalidate cache immediately before cold query to ensure an honest cold start
  invalidateSimilarityCache(db);

  // 2. Measure honest cold first-use end-to-end query on Q1 (includes DB load, JSON parsing, vector decoding and ranking)
  const tColdStart = performance.now();
  const coldResult = findSimilarCatalogueGames(db, "Q1", { limit: 10 });
  const tColdEnd = performance.now();
  const coldQueryE2eMs = Math.round((tColdEnd - tColdStart) * 100) / 100;

  if (coldResult.results.length === 0) {
    throw new Error("Benchmark verification failed: cold query returned 0 results");
  }

  // 3. Measure isolated index load and decode time without caching (diagnostic metric)
  const tLoadStart = performance.now();
  buildSimilarityIndex(db, { cache: false });
  const tLoadEnd = performance.now();
  const indexLoadAndDecodeMs = Math.round((tLoadEnd - tLoadStart) * 100) / 100;

  // Cache is warm after findSimilarCatalogueGames above; retrieve reference for search-only benchmark
  const index = getSimilarityIndex(db);

  const peakMem = process.memoryUsage().rss / (1024 * 1024);

  // 4. Warmed query measurements over warmIterations different source QIDs
  const searchOnlyTimes: number[] = [];
  const endToEndTimes: number[] = [];

  for (let iter = 1; iter <= warmIterations; iter++) {
    const targetId = Math.floor(rng() * count) + 1;
    const qid = `Q${targetId}`;

    const tE2e0 = performance.now();
    findSimilarCatalogueGames(db, qid, { limit: 10 });
    const tE2e1 = performance.now();
    endToEndTimes.push(tE2e1 - tE2e0);

    // Search-only: measure pure candidate dot product and ranking time
    const sourceCandidate = index.candidatesByQid.get(qid);
    if (sourceCandidate) {
      const tSearch0 = performance.now();
      rankSimilarCandidates(
        sourceCandidate.vector,
        sourceCandidate.norm,
        qid,
        index.candidates,
        10,
      );
      const tSearch1 = performance.now();
      searchOnlyTimes.push(tSearch1 - tSearch0);
    }
  }

  // 5. Unrelated write scenario: execute an unrelated write and measure subsequent query latency
  db.prepare(
    "INSERT INTO CatalogueGames (qid, title, wikidata_url, loaded_at) VALUES ('Q999999', 'Unrelated Game', 'https://www.wikidata.org/wiki/Q999999', '2026-10-15T00:00:00Z')",
  ).run();
  const tUnrelated0 = performance.now();
  findSimilarCatalogueGames(db, "Q1", { limit: 10 });
  const tUnrelated1 = performance.now();
  const postUnrelatedWriteE2eMs = Math.round((tUnrelated1 - tUnrelated0) * 100) / 100;

  searchOnlyTimes.sort((a, b) => a - b);
  endToEndTimes.sort((a, b) => a - b);

  const mean = (arr: number[]) =>
    Math.round((arr.reduce((acc, v) => acc + v, 0) / arr.length) * 100) / 100;

  db.close();

  const peakSampled = Math.round(peakMem * 10) / 10;
  const deltaSampled = Math.round((peakMem - initialMem) * 10) / 10;
  const coldTargetMet = coldQueryE2eMs < 1000;
  const warmTargetMet = percentile(endToEndTimes, 95) < 1000;

  return {
    node_version: process.version,
    os_platform: `${process.platform} (${os.release()})`,
    os_arch: os.arch(),
    cpu_model: os.cpus()[0]?.model || "unknown",
    total_vectors: count,
    dimensions: DIMENSIONS,
    memory_baseline_mb: Math.round(initialMem * 10) / 10,
    memory_peak_sampled_rss_mb: peakSampled,
    memory_delta_sampled_rss_mb: deltaSampled,
    memory_peak_mb: peakSampled,
    memory_delta_mb: deltaSampled,
    data_generation_ms: dataGenerationMs,
    index_load_and_decode_ms: indexLoadAndDecodeMs,
    cold_query_e2e_ms: coldQueryE2eMs,
    post_unrelated_write_e2e_ms: postUnrelatedWriteE2eMs,
    warm_queries_count: warmIterations,
    warm_search_only: {
      min_ms: Math.round(searchOnlyTimes[0] * 100) / 100,
      max_ms: Math.round(searchOnlyTimes[searchOnlyTimes.length - 1] * 100) / 100,
      p50_ms: Math.round(percentile(searchOnlyTimes, 50) * 100) / 100,
      p95_ms: Math.round(percentile(searchOnlyTimes, 95) * 100) / 100,
      p99_ms: Math.round(percentile(searchOnlyTimes, 99) * 100) / 100,
      mean_ms: mean(searchOnlyTimes),
    },
    warm_end_to_end: {
      min_ms: Math.round(endToEndTimes[0] * 100) / 100,
      max_ms: Math.round(endToEndTimes[endToEndTimes.length - 1] * 100) / 100,
      p50_ms: Math.round(percentile(endToEndTimes, 50) * 100) / 100,
      p95_ms: Math.round(percentile(endToEndTimes, 95) * 100) / 100,
      p99_ms: Math.round(percentile(endToEndTimes, 99) * 100) / 100,
      mean_ms: mean(endToEndTimes),
    },
    targets: {
      cold_first_use_under_one_second: coldTargetMet,
      warmed_p95_under_one_second: warmTargetMet,
    },
    under_one_second_target_met: coldTargetMet && warmTargetMet,
  };
}

export function main(): void {
  console.log(
    `[benchmark] Starting catalogue similarity benchmark over ${BENCHMARK_COUNT} vectors...`,
  );
  const metrics = runSimilarityBenchmark();

  console.log("\n=======================================================");
  console.log("       MGPL WU-032b Catalogue Similarity Benchmark     ");
  console.log("=======================================================");
  console.log(`Node Version:             ${metrics.node_version}`);
  console.log(`OS / Architecture:        ${metrics.os_platform} ${metrics.os_arch}`);
  console.log(`CPU Model:                ${metrics.cpu_model}`);
  console.log(
    `Total Vectors:            ${metrics.total_vectors.toLocaleString()} (${metrics.dimensions} dimensions)`,
  );
  console.log(
    `Sampled Process RSS:      Baseline ${metrics.memory_baseline_mb} MB -> Peak ${metrics.memory_peak_sampled_rss_mb} MB (Delta: +${metrics.memory_delta_sampled_rss_mb} MB)`,
  );
  console.log(
    `                          [Note: includes synthetic in-memory SQLite DB (~316 MB BLOBs + pages) + V8 heap + 316 MB Float32Array index]`,
  );
  console.log(`Synthetic Generation:     ${metrics.data_generation_ms} ms`);
  console.log(
    `Cold First-Use (E2E):     ${metrics.cold_query_e2e_ms} ms [Includes cold DB load, JSON parsing, float32 decoding & ranking]`,
  );
  console.log(`Isolated Load & Decode:   ${metrics.index_load_and_decode_ms} ms`);
  console.log(
    `Post-Unrelated-Write:     ${metrics.post_unrelated_write_e2e_ms} ms [Full index reload due to SQLite total_changes invalidation]`,
  );
  console.log("-------------------------------------------------------");
  console.log(`Warmed Queries (${metrics.warm_queries_count} runs):`);
  console.log(
    `  Search-Only (p50 / p95 / p99): ${metrics.warm_search_only.p50_ms} ms / ${metrics.warm_search_only.p95_ms} ms / ${metrics.warm_search_only.p99_ms} ms (mean: ${metrics.warm_search_only.mean_ms} ms)`,
  );
  console.log(
    `  End-to-End  (p50 / p95 / p99): ${metrics.warm_end_to_end.p50_ms} ms / ${metrics.warm_end_to_end.p95_ms} ms / ${metrics.warm_end_to_end.p99_ms} ms (mean: ${metrics.warm_end_to_end.mean_ms} ms)`,
  );
  console.log("-------------------------------------------------------");
  console.log(
    `Target (< 1.0s) Cold:     ${metrics.targets.cold_first_use_under_one_second ? "YES (PASS)" : "NO (FAIL: ~1.3s cold start exceeded 1.0s target)"}`,
  );
  console.log(
    `Target (< 1.0s) Warmed:   ${metrics.targets.warmed_p95_under_one_second ? "YES (PASS)" : "NO (FAIL)"}`,
  );
  console.log("=======================================================\n");
  console.log(JSON.stringify(metrics, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
