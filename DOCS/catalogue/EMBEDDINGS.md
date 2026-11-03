# Catalogue Embeddings & Semantic Similarity

_Added by WU-032b (#158). Expands Claude's task proposal 032, section 6.4. Complements `SOURCES.md` and `PROMOTION.md`._

This document defines the storage, validation, atomic loading, freshness lifecycle, and search contract for reference catalogue embeddings in MGPL. It enables local, offline semantic similarity search ("games like QID") over game descriptions without external vector databases, C extensions, or runtime cloud dependencies.

---

## 1. The Schema

Embeddings are stored in the additive `CatalogueEmbeddings` table in SQLite (`src/db.ts`). The table is registered in `AUTHORITATIVE_TABLES` and created on application boot.

| Column                   | Type      | Constraints                                           | Description                                                            |
| ------------------------ | --------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `qid`                    | `TEXT`    | `PRIMARY KEY NOT NULL REFERENCES CatalogueGames(qid)` | Wikidata QID (`Q[1-9][0-9]*`)                                          |
| `model`                  | `TEXT`    | `NOT NULL`                                            | Embedding model identifier (`text-embedding-005`)                      |
| `task_type`              | `TEXT`    | `NOT NULL`                                            | Task type (`SEMANTIC_SIMILARITY`)                                      |
| `dimensions`             | `INTEGER` | `NOT NULL CHECK (dimensions = 768)`                   | Embedding dimensionality                                               |
| `vector`                 | `BLOB`    | `NOT NULL CHECK (length(vector) = 3072)`              | 768 little-endian IEEE 754 32-bit floats                               |
| `text_sha256`            | `TEXT`    | `NOT NULL CHECK (length(text_sha256) = 64)`           | SHA-256 of reconstructed producer text (`textFor(title, description)`) |
| `description_sha256`     | `TEXT`    | `NOT NULL CHECK (length(description_sha256) = 64)`    | SHA-256 of promoted description (`CatalogueDrafts.text_sha256`)        |
| `description_run_id`     | `TEXT`    | `NULLABLE`                                            | Provenance run ID of the description draft                             |
| `description_attempt_id` | `TEXT`    | `NULLABLE`                                            | Provenance attempt ID of the description draft                         |
| `embedding_run_id`       | `TEXT`    | `NOT NULL`                                            | Run ID that generated the embedding vector                             |
| `embedding_attempt_id`   | `TEXT`    | `NULLABLE`                                            | Attempt ID that generated the embedding vector                         |
| `embedded_at`            | `TEXT`    | `NOT NULL`                                            | ISO 8601 timestamp when embedding was generated                        |
| `loaded_at`              | `TEXT`    | `NOT NULL`                                            | ISO 8601 timestamp when record was imported                            |

The schema remains additive and isolated: it has no foreign keys into user library state or `AppGames`.

---

## 2. Producer Contract & Validation

The loader validates records emitted by `scripts/catalogue/embed-descriptions.mjs` (`SCHEMA = "mgpl-embedding/1"`):

1. **Schema & Types**: Rejects missing or non-matching `schema`, `model`, `task_type`, or `dimensions`.
2. **Vector Integrity**:
   - Decodes base64 into little-endian float32 components.
   - Enforces canonical base64 representation (`Buffer.from(b64, 'base64').toString('base64') === b64`).
   - Verifies exact length of 3072 bytes (768 components).
   - Rejects non-finite values (`NaN`, `+Infinity`, `-Infinity`).
   - Rejects zero-norm vectors ($\sqrt{\sum x_i^2} > 0$).
3. **Exact Hash & State Semantics**:
   - The producer hashes `textFor(label, description)`:
     ```ts
     const t = label.trim();
     return /[.!?]$/.test(t) ? `${t} ${description}` : `${t}. ${description}`;
     ```
   - In MGPL, `CatalogueDrafts.value` stores promoted descriptions as JSON objects: `JSON.stringify({ description: rawDescription })` (matching the promotion contract in `src/services/enrichmentPromotion.ts`). The producer does not emit `description_sha256`; that stored column in `CatalogueEmbeddings` is derived directly from the parsed and validated promoted description text (`sha256(rawDescription)`).
   - The loader validates that `CatalogueDrafts.value` is valid JSON containing a non-empty string `description`, reconstructs `textFor(game.title, rawDescription)`, and verifies:
     - `sha256(reconstructedText) === record.text_sha256`
     - `sha256(rawDescription) === draft.text_sha256` (this derived value becomes the stored `description_sha256` column)
   - Verifies description provenance IDs (`run_id`, `attempt_id`) against the promoted draft.

---

## 3. Atomic Loader CLI

Vectors are imported via `scripts/catalogue/load-embeddings.ts`:

```bash
npx tsx scripts/catalogue/load-embeddings.ts \
  --db <database-path> \
  --in <embeddings.jsonl> \
  --review-confirmed true
```

### Safety & Operational Invariants

- **No Implicit Database**: Requires `--db` pointing to an existing SQLite file; refuses to create, seed, or use default databases silently.
- **Explicit Review Confirmation**: Requires `--review-confirmed true`.
- **Bounded Memory & Streaming**: Streams JSONL records line by line without accumulating vectors in memory.
- **All-or-Nothing Atomicity**: Executes within an immediate SQLite transaction. Any syntax error, schema mismatch, or hash discrepancy triggers an immediate `ROLLBACK`. Pre-existing rows remain untouched.
- **Duplicate Handling**:
  - Identical duplicates in the same input collapse idempotently.
  - Conflicting duplicates (different vector, metadata, or hash for the same QID) refuse immediately with line numbers.
  - Re-importing updates existing QIDs idempotently.
- **Safe Output**: Reports only aggregate counts and execution duration; never emits titles, descriptions, vector data, or credentials.

---

## 4. Similarity Search Service

The service `src/services/catalogueSimilarity.ts` exposes `findSimilarCatalogueGames`:

```ts
const results = findSimilarCatalogueGames(db, "Q12345", { limit: 10 });
```

### Search Contract

- **Cosine Similarity**: Computed as $\frac{\mathbf{u} \cdot \mathbf{v}}{\|\mathbf{u}\| \|\mathbf{v}\|}$, normalized to $[-1, 1]$. Correctly handles non-unit vectors and negative similarities.
- **Source Exclusion**: The source QID is excluded from candidate results.
- **Deterministic Ranking**: Ranked descending by similarity score with a stable tie-break on `qid` ascending (`a.qid.localeCompare(b.qid)`).
- **Bounded Top-K Selection**: Default limit 10, maximum 100. Evaluates candidates using bounded top-K collection to avoid heap allocation overhead.
- **Mandatory Disclaimer**: Every response carries `disclaimer: "similarity of generated descriptions, not a verified factual recommendation"`.

### Response Shape

```json
{
  "source_qid": "Q12345",
  "source_title": "Example Game",
  "limit": 10,
  "total_candidates": 103004,
  "disclaimer": "similarity of generated descriptions, not a verified factual recommendation",
  "results": [
    {
      "qid": "Q67890",
      "title": "Similar Game A",
      "similarity": 0.892415
    }
  ]
}
```

---

## 5. Freshness & Invalidation Lifecycle

Embeddings represent the semantic content of a specific title and description binding at embedding time. Any drift invalidates the vector:

1. **Source Freshness**:
   - If the source game's title is modified in `CatalogueGames`, search throws `CatalogueSimilarityError` (`SOURCE_STALE`).
   - If the source description draft is modified or withdrawn in `CatalogueDrafts`, search throws `CatalogueSimilarityError` (`SOURCE_STALE` or `SOURCE_DESCRIPTION_MISSING`).
2. **Candidate Freshness**:
   - Candidates whose title or description has been modified, withdrawn, or deleted are excluded from the candidate pool during search.
   - Changes to an unrelated game do not invalidate other valid candidates.
3. **In-Memory Cache Invalidation & Transaction Isolation**:
   - The service maintains an in-memory index of vectors for fast repeated queries.
   - Invalidation is reactive: the cache tracks SQLite's `total_changes()` and `PRAGMA data_version`. Any insert, update, or delete on the database automatically flags the cache as dirty and triggers a reload.
   - **Transaction Isolation**: During an active caller transaction (`db.inTransaction === true`), the service builds an ephemeral transaction-local index and never reads from or publishes to the shared module cache. If a transaction modifies catalogue state and subsequently rolls back, subsequent non-transaction queries cleanly read committed database state without requiring `forceReload`.
   - `invalidateSimilarityCache(db)` is exported and called upon import.
   - Callers can bypass or force reload via `{ noCache: true }` or `{ forceReload: true }`.

---

## 6. Performance & Benchmark Results

The offline benchmark `scripts/catalogue/benchmark-similarity.ts` evaluates search over 103,005 synthetic 768-dimensional vectors with Mulberry32 deterministic seeding:

```text
=======================================================
       MGPL WU-032b Catalogue Similarity Benchmark
=======================================================
Node Version:             v22.23.2
OS / Architecture:        win32 (10.0.26300) x64
CPU Model:                13th Gen Intel(R) Core(TM) i7-1355U
Total Vectors:            103,005 (768 dimensions)
Sampled Process RSS:      Baseline 63.5 MB -> Peak 1419.7 MB (Delta: +1356.2 MB)
                          [Note: includes synthetic in-memory SQLite DB (~316 MB BLOBs + pages) + V8 heap + 316 MB Float32Array index]
Synthetic Generation:     2509 ms
Cold First-Use (E2E):     1297.64 ms [Includes cold DB load, JSON parsing, float32 decoding & ranking]
Isolated Load & Decode:   1693.65 ms
Post-Unrelated-Write:     1667.5 ms [Full index reload due to SQLite total_changes invalidation]
-------------------------------------------------------
Warmed Queries (50 runs):
  Search-Only (p50 / p95 / p99): 88.54 ms / 119.19 ms / 129.72 ms (mean: 90.89 ms)
  End-to-End  (p50 / p95 / p99): 87.36 ms / 123.57 ms / 133.57 ms (mean: 91.66 ms)
-------------------------------------------------------
Target (< 1.0s) Cold:     NO (FAIL: ~1.3s cold start exceeded 1.0s target)
Target (< 1.0s) Warmed:   YES (PASS)
=======================================================
```

### Analysis & Honest Latency Bounds

- **Cold First-Use vs Warmed**: The cold first-use end-to-end query measures 1297.64 ms (~1.3s). This honestly reflects uncached index construction: reading 103,005 rows from SQLite, parsing JSON description values, verifying hash bindings, and allocating 768-element Float32Array buffers before computing cosine similarities. Warmed queries easily beat the 1.0-second target (p50 ~87 ms, p95 ~124 ms).
- **Post-Unrelated-Write Cost**: Database-wide cache invalidation causes a full index rebuild on the first query following any write (measured at 1667.5 ms).
- **Sampled Process RSS**: Peak sampled RSS reached 1419.7 MB (+1356.2 MB delta). This process-wide metric reflects:
  1. The synthetic in-memory SQLite database (~316 MB raw vector BLOBs plus SQLite b-tree pages and cache).
  2. The V8 heap, object headers, and garbage collector buffers.
  3. The decoded 316 MB `Float32Array` vectors and candidate map in the in-memory index.
     It should not be conflated with the memory footprint of the index in isolation.

### Historical Evidence (Superseded)

```text
[SUPERSEDED - Benchmark R0 in commit e359d97 incorrectly timed cold query against a pre-loaded cache]:
Cold Query (E2E): 129.65 ms (Pre-cached)
Target < 1.0s Met: YES (PASS - superseded)
```

### File-Backed Readiness Evidence (WU-032c)

`scripts/catalogue/benchmark-similarity-filebacked.ts` measures the same search over a disposable **file-backed** SQLite fixture using the authoritative `Catalogue*` DDL extracted from `src/db.ts`, and executes the measurement in a **fresh child process** so population allocations do not contaminate memory figures. Reproducible command (from the repository root):

```bash
node --import tsx scripts/catalogue/benchmark-similarity-filebacked.ts
```

Results at commit `af222f4` (103,005 synthetic vectors, 768 dimensions, seed `0x158032b`, invented records only):

```text
Fixture DB file size:     449.8 MB
Population (parent proc): 11196.09 ms
DB open (excl. cold):     2.21 ms
Cold First-Use (query):   1203.46 ms  [file read + parse + decode + ranking; excludes DB open]
Memory: baseline RSS 48.11 MB -> after-index RSS 527.37 MB (heap 111.79 MB, external 306.08 MB)
  RSS after each reload (MB): 527.37, 911.69, 925.37, 924.46, 930.96, 929.91
Warmed Queries (50):      p50 73.51 ms / p95 172.05 ms / p99 185.15 ms (mean 110.27 ms)
Reload after unrelated write (5 samples): min 3360.13 ms / max 4856.25 ms / mean 3976.75 ms
Target (<1.0s) Cold:      NO (MISS)
Target (<1.0s) Warmed p95: YES (PASS)
```

**Comparison with the in-memory benchmark above — not identical environments:**

| Metric                               | In-memory (WU-032b)       | File-backed (WU-032c)                           | Note                                                                                                               |
| ------------------------------------ | ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Cold first-use                       | 1297.64 ms                | 1203.46 ms                                      | both miss <1.0s                                                                                                    |
| Warmed p95                           | 123.57 ms                 | 172.05 ms                                       | file-backed ~1.4x slower                                                                                           |
| Reload after unrelated write         | 1667.5 ms (single sample) | 3360.13–4856.25 ms (5 samples, mean 3976.75 ms) | file-backed rebuild slower and more variable                                                                       |
| After-first-index RSS (point sample) | 1419.7 MB (contaminated)  | 527.37 MB                                       | both are point samples; the in-memory figure also included a synthetic in-memory DB plus a second diagnostic index |

**Readiness recommendation.** Warmed search meets the 1.0-second target on file-backed storage. Two concerns remain for a controlled import:

1. **Cold first-use (~1.2s)** misses the target; this is a one-time cost per process/first query and does not block a dev import.
2. **Unrelated-write reload cost** is the outstanding concern: any database write (even to an unrelated table) invalidates the cache and forces a full ~103,005-vector rebuild, measured at mean ~4.0s (worst ~4.9s) with sampled RSS roughly doubling (~527 MB → ~931 MB) while the old and new indexes coexist before GC.

**Recommendation: sufficient evidence to proceed with a controlled developer-database import, provided the operator explicitly accepts the cold miss and the unrelated-write reload cost.** Before any production HTTP integration, a bounded follow-up to narrow the cache-invalidation scope (so unrelated writes do not force a full rebuild) is warranted; that follow-up is out of scope for this measurement-only work unit.

**Measurement limitations.**

- `resourceUsage().maxRSS` (`1004592`) is informational only: its units and peak semantics are not verified on win32.
- RSS figures are point samples at discrete moments, not synchronous allocation peaks; they do not capture transient high-water marks.
- `rss` is process-resident memory: V8 `heapUsed`/`external` plus SQLite's own page cache and native allocations. The system filesystem cache is a separate OS-level cache, not charged to this process's RSS. Do not read the after-index point sample as the index size alone, a steady-state bound, or a peak.
- Run-to-run variance is material: three runs on the same machine measured cold first-use ~1.2–1.7s, warm p95 ~172–231 ms, and reload mean ~3.1–4.2s. Figures above are the final representative run, not a stable bound.
- The "cold" query reads a freshly-written fixture from the OS page cache, not from a cold physical disk; true cold-from-disk latency is not measured.
- Local single-host figures cannot resolve target-host RAM, concurrency or production sizing; those require operator-supplied capacity data.

**Fixture retention and disk usage.**

- Automatic fixture deletion has been removed from the benchmark. Each invocation creates an exclusively owned, uniquely named directory under `.tmp_benchmark_filebacked/fixture-*` within the verified scratch tree and retains it on both success and failure paths. The benchmark refuses preexisting symlink or junction scratch parents and ancestors.
- **Location reporting and recovery caveat:** The benchmark reports the original creation path as `fixture_creation_path` with `fixture_location_status: "current_location_unverified"`, explicitly declaring that the current fixture location is unverified and may differ if directories or ancestors were moved or replaced. Diagnostics on failure similarly report `fixture created at <path> (current location unverified; population ..., measurement ...)`. The benchmark does not perform directory scans, follow replacement junctions, or attempt destructive recovery. Operators can inspect the original creation location with this stated caveat.
- **Disk tradeoff:** A representative 103,005-vector fixture occupies ~449.8 MB on disk. Repeated runs accumulate disk usage. There is no automated cleanup, self-reported proven deletion safety, or silent retention. The operator manually removes retained fixtures when no process is using them.

---

## 7. Scope & Unresolved Limitations

1. **No Real Data Loading**: This work unit builds and validates the schema, loader, similarity service, and offline benchmarks on fixtures. Real-data loading into the developer or production database is a separate operator action post-review.
2. **No UI or HTTP Endpoints**: This implementation slice provides the internal service layer. UI components and API routes (e.g. `GET /api/catalogue/games/:qid/similar`) are left for subsequent work units.
3. **No Automatic Import**: The application does not automatically scan or import vector files on boot.
4. **Issue #158 Status**: This delivers the semantic search slice of #158; full completion of #158 remains pending downstream integration.
