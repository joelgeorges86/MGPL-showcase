# AI-056: cooperative cancellation in per-item SQLite write loops (#108)

Branch `feature/ai-056-cooperative-cancellation`, from `develop` at `6d23340` (tree
`0eccd8444b8f0feb4b59b49c689272baeb3cdf62`). Fix commits `5e27a3c`, `f68c3f9`, `0463fca`.

## 1. The bound

**Shutdown waits for the SQLite call in progress when the signal lands, then the drain.**
It does not grow with the size of the request in flight. The call can be up to that
handle's busy timeout: 10 s for `db.ts`, 5 s for the route handles, which keep
better-sqlite3's default. One call on an unregistered per-request handle (`library.ts`,
`sync.ts`) can make the drain late. This is the only stated form of the bound. It is not
tied to any `stop_grace_period` value, and this change does not touch the 30 s setting.

Stated exceptions, all independent of the payload:

- The six single-game handlers in section 3.2 make up to **two** caught calls in a row.
  They belong to #109 (AI-057) and are not changed here.
- `POST /api/state/import` takes **one** lock wait, then processes every row without
  yielding (section 3.1). The lock-free processing time grows with the payload. It was
  not measured.

### Why a flag check alone would not work

A loop of synchronous better-sqlite3 calls never gives the event loop a turn. The SIGTERM
handler is a JS callback on that same loop, so it cannot set a flag while the loop runs.
`shutdownCheckpoint()` (`src/lib/shutdown.ts`) does two things:

1. It yields past a poll phase, which is where libuv delivers a pending signal. It uses
   two `setImmediate` hops, because one hop queued from an I/O callback resumes in the
   same iteration's check phase, before any later poll.
2. It rejects with `ShutdownInProgressError` once the handler has run.

Each loop also takes **at most one lock wait per item**. It uses either one
`BEGIN IMMEDIATE` per item or chunk (`.immediate()`), or one `try` around the item's
writes, so the first lock failure ends the item. Without that, one item's run of caught
statements (UPDATE, UPDATE, INSERT in restore-tuning) would be several calls, not one.

## 2. Enumeration: how the search was done

Two mechanical searches ran against the `develop` tree (`git archive 6d23340`), plus
recorded greps. No reading was involved.

**AST scan.** `scripts/probes/ai056-write-loop-scan.mjs --root <tree> --all` parses all
118 non-test `.ts` files under `src/` with the TypeScript compiler. Its rules are in the
file header:

- **Loop:** `for` / `for-of` / `for-in` / `while` / `do`, and callbacks of
  `forEach` / `map` / `flatMap` / `reduce` / `filter` / `some` / `every` / `find`.
- **Write:** `.run(`, a DB-receiver `.exec(`, and `transaction(...)` invoked directly or
  through a variable.
- **Writer:** a named function containing a write or a call to another writer, resolved
  by name across files to a fixpoint.
- **CAUGHT-IN-LOOP:** a write or writer call sits in a `try` whose `catch` is inside the
  loop body.
- **HELPER-CATCHES:** the loop calls a writer that catches internally.

**Scanner gap found during the work.** The first version did not treat a transaction held
in a variable (`const tx = db.transaction(fn); tx(x)`) as a write. Fixing that added two
catch-and-continue loops on `develop`, both outside request reach: `db.ts:1587` (boot
migration) and `normalizeDb_better.ts:103` (CLI). Writes made through other indirection,
such as a function passed as a value or a method on an object held in a map, are still not
followed. That is a known limitation of the search.

### 2.1 Raw scan output, `develop` 6d23340

```
src/db.ts:1042	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn normalizePlatformLabels	writes@1050,1053,1064,1067
src/db.ts:1587	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn rebuildTableUserScoped	writes@1608,1614,1615,1624,1627,1628,1630,1638
src/db.ts:1688	ForOf	UNCAUGHT	no-tx	no-checkpoint	fn ensureAuthUserProfileColumns	writes@1690
src/db.ts:1716	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn verifySchemaIntegrity	writes@1733
src/db.ts:1730	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn verifySchemaIntegrity	writes@1733
src/routes/backlog.ts:196	ForOf	UNCAUGHT	in-tx	no-checkpoint	GET /summary	writes@206
src/routes/deals.ts:554	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /wishlist/sync	writes@556
src/routes/devices.ts:193	ForOf	UNCAUGHT	no-tx	no-checkpoint	fn ensureDevicesTable	writes@195
src/routes/devices.ts:604	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn compute	writes@605
src/routes/devices.ts:629	.map()	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn compute	writes@716
src/routes/games.ts:461	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn backfillSynopses	writes@461
src/routes/games.ts:2198	ForOf	UNCAUGHT	no-tx	no-checkpoint	fn ensureTuningColumns	writes@2200
src/routes/games.ts:2222	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	PATCH /:gameId/tags	writes@2224
src/routes/games.ts:2283	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	PATCH /:gameId/notes	writes@2285
src/routes/games.ts:2344	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	PATCH /:gameId/tuning	writes@2346
src/routes/games.ts:2406	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	PATCH /:gameId/review	writes@2408
src/routes/games.ts:2476	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	PATCH /:gameId/rating	writes@2497
src/routes/games.ts:2523	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	PATCH /dlc/status	writes@2525
src/routes/games.ts:2566	ForOf	CAUGHT-IN-LOOP	in-tx	no-checkpoint	PATCH /batch-status	writes@2569
src/routes/games.ts:2567	ForOf	CAUGHT-IN-LOOP	in-tx	no-checkpoint	PATCH /batch-status	writes@2569
src/routes/games.ts:2822	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	POST /:id/launch	writes@2824
src/routes/games.ts:2928	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	POST /:gameId/auto-preset	writes@2930
src/routes/games.ts:3059	ForOf	CAUGHT-IN-LOOP	in-tx	no-checkpoint	POST /backup/restore-tuning	writes@3069,3100
src/routes/games.ts:3067	ForOf	CAUGHT-IN-LOOP	in-tx	no-checkpoint	POST /backup/restore-tuning	writes@3069
src/routes/games.ts:3165	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	POST /sync/steam	writes@3185,3192,3209
src/routes/hardwareExplorer.ts:109	ForOf	UNCAUGHT	no-tx	no-checkpoint	fn ensureHardwareExplorerTables	writes@111
src/routes/library.ts:188	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /import	writes@212,243,250,262,277,285,295	via logPlatformMismatch
src/routes/mock.ts:450	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /seed	writes@450
src/routes/mock.ts:478	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /seed	writes@479
src/routes/mock.ts:518	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /seed	writes@518
src/routes/mock.ts:527	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /seed	writes@527
src/routes/mock.ts:537	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /seed	writes@537
src/routes/mock.ts:553	ForOf	UNCAUGHT	in-tx	no-checkpoint	POST /seed	writes@554
src/routes/profileSync.ts:318	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn persistSyncedProfile	writes@319	via persistGameEntry
src/routes/state.ts:539	ForOf	CAUGHT-IN-LOOP	in-tx	no-checkpoint	POST /import	writes@591,599,601
src/routes/state.ts:586	ForOf	CAUGHT-IN-LOOP	in-tx	no-checkpoint	POST /import	writes@591,599,601
src/routes/sync.ts:97	ForOf	UNCAUGHT	no-tx	no-checkpoint	POST /steam	writes@122,131,151,153
src/routes/sync.ts:222	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	POST /epic	writes@238,242
src/scripts/normalizeDb.ts:39	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn normalizeAppGames	writes@91
src/scripts/normalizeDb.ts:109	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn normalizeAppOwnerships	writes@128
src/scripts/normalizeDb.ts:146	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn normalizeAppTracking	writes@171
src/scripts/normalizeDb.ts:189	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn normalizeAppReviews	writes@214
src/scripts/normalizeDb.ts:232	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn normalizeFriction	writes@263
src/scripts/normalizeDb_better.ts:103	ForOf	CAUGHT-IN-LOOP	no-tx	no-checkpoint	fn runNormalization	writes@120,159
src/scripts/normalizeDb_better.ts:119	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn runNormalization	writes@120
src/scripts/seed-db.ts:96	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@96
src/scripts/seed-db.ts:97	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@98
src/scripts/seed-db.ts:116	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@117
src/scripts/seed-db.ts:129	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@130
src/scripts/seed-db.ts:140	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@140
src/scripts/seed-db.ts:141	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@141
src/scripts/seed-db.ts:142	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@142
src/scripts/seed-db.ts:143	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@143
src/scripts/seed-db.ts:144	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn main	writes@144
src/seed/benchmarks.ts:174	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedCommunityBenchmarks	writes@176
src/seed/benchmarks.ts:175	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedCommunityBenchmarks	writes@176
src/seed/components.ts:226	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedBuilderComponents	writes@227
src/seed/components.ts:240	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedBuilderComponents	writes@241
src/seed/devices.ts:617	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedDeviceCatalog	writes@618,629
src/seed/performance.ts:223	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedPerformanceProfiles	writes@229
src/seed/performance.ts:226	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedPerformanceProfiles	writes@229
src/seed/performance.ts:227	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedPerformanceProfiles	writes@229
src/seed/radar.ts:236	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedRadar	writes@238
src/seed/reviews.ts:99	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedReviews	writes@100
src/seed/reviews.ts:168	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedHardwarePriceHistory	writes@182
src/seed/reviews.ts:171	For	UNCAUGHT	in-tx	no-checkpoint	fn seedHardwarePriceHistory	writes@182
src/seed/reviews.ts:181	.forEach()	UNCAUGHT	in-tx	no-checkpoint	fn seedHardwarePriceHistory	writes@182
src/seed/reviews.ts:192	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn seedHardwarePriceHistory	writes@204
src/seed/reviews.ts:193	For	UNCAUGHT	in-tx	no-checkpoint	fn seedHardwarePriceHistory	writes@204
src/seed/reviews.ts:203	.forEach()	UNCAUGHT	in-tx	no-checkpoint	fn seedHardwarePriceHistory	writes@204
src/services/dealAggregator.ts:313	For	UNCAUGHT	in-tx	no-checkpoint	fn seedHistoryBaseline	writes@316
src/services/dealAggregator.ts:387	ForOf	UNCAUGHT	no-tx	no-checkpoint	fn updateWishlistAlerts	writes@390,402
src/services/dealAggregator.ts:433	ForOf	HELPER-CATCHES	no-tx	no-checkpoint	fn seedDemoArbitrage	writes@434	via seedHistoryBaseline	helper-catch seedHistoryBaseline
src/services/dealAggregator.ts:478	ForOf	HELPER-CATCHES	no-tx	no-checkpoint	fn ingestAllDeals	writes@480,481,483	via recordPricePoint,seedHistoryBaseline,updateWishlistAlerts	helper-catch recordPricePoint,seedHistoryBaseline,updateWishlistAlerts
src/services/dealSync.ts:237	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn syncLiveStorePrices	writes@262,272
src/services/enrichmentPromotion.ts:61	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn promoteReviewedEnrichmentRun	writes@65
src/services/modCatalogSanitizer.ts:68	ForOf	HELPER-CATCHES	no-tx	no-checkpoint	fn reSanitizeModCatalog	writes@74,77,90,94	via appendAudit	helper-catch appendAudit
src/services/modManager.ts:714	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn ensureModHubSeed	writes@718,721,731
src/services/modManager.ts:716	.forEach()	UNCAUGHT	in-tx	no-checkpoint	fn ensureModHubSeed	writes@718,721,731
src/services/modManager.ts:717	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn ensureModHubSeed	writes@718
src/services/modManager.ts:720	ForOf	UNCAUGHT	in-tx	no-checkpoint	fn ensureModHubSeed	writes@721
src/services/modManager.ts:1134	.forEach()	UNCAUGHT	in-tx	no-checkpoint	fn saveLoadOrder	writes@1135
SUMMARY files=118 loops=681 write_loops=82 UNCAUGHT=53 CAUGHT-IN-LOOP=26 HELPER-CATCHES=3 writers=64
```

`WRITERS addColumnIfMissing appendAudit backfillSynopses bootstrapDatabase compute ensureAuthUserProfileColumns ensureBacklogTable ensureCacheTable ensureDevicesTable ensureGameDeviceProfilesTable ensureHandleRow ensureHardwareExplorerTables ensureHltbColumn ensureInstalledModsTable ensureModHubSeed ensureSessionsTable ensureSynopsisColumn ensureTargetStyleColumn ensureTuningColumns executeCompare fetchWithCircuitBreaker getLoadOrder getModsAggregationStatus handleSystemScan ingestAllDeals initDb initSyncScheduler linkOAuthAccountToUser logPlatformMismatch main normalizeAppGames normalizeAppOwnerships normalizeAppReviews normalizeAppTracking normalizeFriction normalizePlatformLabels persistGameEntry persistScanTelemetry persistSyncedProfile promoteReviewedEnrichmentRun reSanitizeModCatalog rebuildTableUserScoped recordPricePoint requireRole resolveHltbMetrics runAutoSync runModsAggregationJob runNormalization saveLoadOrder seedBuilderComponents seedCommunityBenchmarks seedDemoArbitrage seedDeviceCatalog seedHardwarePriceHistory seedHistoryBaseline seedPerformanceProfiles seedRadar seedReviews syncLiveStorePrices updateWishlistAlerts upsertOAuthUser verifySchemaIntegrity writeAnalyticsAccessAudit writeAudit`

### 2.2 Raw grep output, `develop` 6d23340

```
$ grep -rlE '\.run\(|\.exec\(|\.transaction\(' src --include='*.ts' | grep -v __tests__ | sort | wc -l
50
$ grep -rlE '\.run\(|\.exec\(|\.transaction\(' src --include='*.ts' | grep -v __tests__ | sort
src/db.ts
src/jobs/mod-aggregation.ts
src/lib/oauth.ts
src/middleware/auth.ts
src/routes/alerts.ts
src/routes/auth.ts
src/routes/backlog.ts
src/routes/builder.ts
src/routes/compare.ts
src/routes/deals.ts
src/routes/devicePricing.ts
src/routes/deviceReviews.ts
src/routes/devices.ts
src/routes/enrich.ts
src/routes/fleet.ts
src/routes/games.ts
src/routes/hardwareExplorer.ts
src/routes/hltb.ts
src/routes/library.ts
src/routes/mock.ts
src/routes/mods.ts
src/routes/notes.ts
src/routes/profileSync.ts
src/routes/recommend.ts
src/routes/retro.ts
src/routes/social.ts
src/routes/state.ts
src/routes/sync.ts
src/routes/tags.ts
src/routes/tracking.ts
src/routes/user.ts
src/routes/users.ts
src/routes/wishlist.ts
src/scripts/normalizeDb.ts
src/scripts/normalizeDb_better.ts
src/scripts/schema-tools/schemaTooling.ts
src/scripts/seed-db.ts
src/seed/benchmarks.ts
src/seed/components.ts
src/seed/devices.ts
src/seed/performance.ts
src/seed/radar.ts
src/seed/reviews.ts
src/services/dealAggregator.ts
src/services/dealSync.ts
src/services/enrichmentPromotion.ts
src/services/modCatalogSanitizer.ts
src/services/modManager.ts
src/utils/platformValidation.ts
src/utils/storefrontCircuitBreaker.ts

$ grep -rnE -A3 'catch *(\([^)]*\))? *\{' src --include='*.ts' | grep -v __tests__ | grep -E -- '-[0-9]+-\s*continue;'
src/db.ts-1592-      continue;
src/routes/games.ts-2239-        continue;
src/routes/games.ts-2300-        continue;
src/routes/games.ts-2361-        continue;
src/routes/games.ts-2423-        continue;
src/routes/games.ts-2501-        continue;
src/routes/games.ts-2541-        continue;
src/routes/games.ts-2584-            continue;
src/routes/games.ts-2839-        continue;
src/routes/games.ts-2945-        continue;
src/routes/games.ts-3028-        continue;
src/routes/games.ts-3093-            continue;
src/scripts/normalizeDb.ts-99-      continue;
src/scripts/normalizeDb.ts-136-      continue;
src/scripts/normalizeDb.ts-179-      continue;
src/scripts/normalizeDb.ts-222-      continue;
src/scripts/normalizeDb.ts-271-      continue;
src/scripts/normalizeDb_better.ts-153-            continue;
src/scripts/normalizeDb_better.ts-171-        continue;

$ grep -rnE 'RETURNING' src --include='*.ts' | grep -v __tests__
(exit 1; no matches)
$ grep -rnE '\.iterate\(' src --include='*.ts' | grep -v __tests__
(exit 1; no matches)
$ grep -rnE 'for await|Promise\.all(Settled)?\(' src --include='*.ts' | grep -v __tests__
src/routes/devices.ts:344:    const [cpu, mem, graphics] = await Promise.all([
src/routes/sync.ts:269:    const [steamRes, epicRes] = await Promise.allSettled([
src/services/dealAggregator.ts:455:  const [itad, gg, deku] = await Promise.allSettled([
src/services/hardwareExplorer.ts:199:  const [system, cpu, mem, graphics, disks, fs, battery, temperature] = await Promise.all([
$ grep -rnE 'CREATE TABLE[^(]*(DLC|Tracking)' src --include='*.ts' | grep -v __tests__
src/db.ts:256:    CREATE TABLE IF NOT EXISTS AppRetroTracking (
src/db.ts:412:    CREATE TABLE IF NOT EXISTS AppTracking (
$ grep -rn "openDatabase\|new Database(" src --include='*.ts' | grep -v __tests__ | grep -v "src/scripts\|src/seed"
src/db.ts:2:import { openDatabase } from "./lib/dbHandles";
src/db.ts:18:export const db: DatabaseType = openDatabase(dbPath);
src/lib/dbHandles.ts:40:export function openDatabase(
src/lib/dbHandles.ts:44:  return trackHandle(new Database(filename, options));
src/routes/backlog.ts:3:import { openDatabase } from "../lib/dbHandles";
src/routes/backlog.ts:20:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/backlog.ts:21:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/compare.ts:3:import { openDatabase } from "../lib/dbHandles";
src/routes/compare.ts:21:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/compare.ts:22:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/dashboard.ts:5:import { openDatabase } from "../lib/dbHandles";
src/routes/dashboard.ts:10:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/devices.ts:4:import { openDatabase } from "../lib/dbHandles";
src/routes/devices.ts:23:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/enrich.ts:4:import { openDatabase } from "../lib/dbHandles";
src/routes/enrich.ts:9:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/games.ts:7:import { openDatabase } from "../lib/dbHandles";
src/routes/games.ts:18:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/games.ts:20:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/hltb.ts:3:import { openDatabase } from "../lib/dbHandles";
src/routes/hltb.ts:9:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/hltb.ts:10:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/library.ts:16:  const db = new Database(dbPath);
src/routes/recommend.ts:3:import { openDatabase } from "../lib/dbHandles";
src/routes/recommend.ts:8:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/recommend.ts:9:const dbWrite: DatabaseType = openDatabase(dbPath);
src/routes/recommender.ts:3:import { openDatabase } from "../lib/dbHandles";
src/routes/recommender.ts:8:const db: DatabaseType = openDatabase(dbPath, { readonly: true });
src/routes/sync.ts:16:  const db = new Database(dbPath);
```

## 3. Triage of every CAUGHT-IN-LOOP / HELPER-CATCHES row (29)

### 3.1 Loop length set by the request or the data: the defect #108 describes

| #   | Loop (develop line)             | Route                                   | Length set by                 | Waits per item before                 | Change                                                                            | Cooperative |
| --- | ------------------------------- | --------------------------------------- | ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- | ----------- |
| 1   | `games.ts:3059` (+`3067` inner) | `POST /api/games/backup/restore-tuning` | request payload               | 2 (3 if legacy `AppTrackings` exists) | per-profile `.immediate()` + checkpoint                                           | yes         |
| 2   | `games.ts:2566` (+`2567` inner) | `PATCH /api/games/batch-status`         | request payload (`gameIds`)   | 1 (2 with the legacy table)           | per-game `.immediate()` + checkpoint                                              | yes         |
| 3   | `games.ts:3165`                 | `POST /api/games/sync/steam`            | Steam library size            | 1 (one `try` per game)                | checkpoint                                                                        | yes         |
| 4   | `sync.ts:222`                   | `POST /api/sync/epic`                   | manifest directory size       | 1 (one `try` per manifest)            | checkpoint; `withDbAsync` closes the handle after the loop                        | yes         |
| 5   | `devices.ts:629` (`.map`)       | `GET /api/devices/playability`          | catalog size (DB)             | 1 per game                            | upserts moved out of the sync compute; 200-row `.immediate()` chunks + checkpoint | yes         |
| 6   | `dealAggregator.ts:478`         | `POST /api/deals/arbitrage/ingest`      | upstream feed size            | up to 3 (three catching helpers)      | per-deal `.immediate()` + checkpoint                                              | yes         |
| 7   | `state.ts:586` (+`539` outer)   | `POST /api/state/import`                | request payload (25 MB limit) | 1 per row, under a deferred BEGIN     | `restore.immediate()`: one wait for the whole import                              | **no**      |

Rows 3–6 were not in #108; they were found by the scan. Row 5 is a public, rate-limited
GET.

**Why row 7 is not cooperative.** A checkpoint must yield to the event loop. The import is
one transaction on `db.ts`'s shared connection. While it yields, any other request on that
connection would run inside the open transaction, so the restore would stop being atomic.
The route is documented as an "Atomic restore", and it is §6.1.2's portable DR snapshot
route. Keeping it atomic while allowing cancellation would need a dedicated connection
holding the write lock across yields. Every other writer would then wait on that lock for
the whole import. That trade is for the Principal Operator. With `.immediate()`, a held
lock costs one wait instead of one wait per row, but the rows are then processed without
a checkpoint.

### 3.2 Constant length: not driven by the payload

| Loop                    | Route                                                     | Real lock waits                                                                                  | Disposition                                                             |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `games.ts:2222`         | `PATCH /:gameId/tags`                                     | 2: UPDATE `AppTracking`, then the fallback INSERT (`AppTrackings` is not in `initDb()`'s schema) | #109 (AI-057) owns this catch-then-fallback-then-404 shape; not changed |
| `games.ts:2283`         | `PATCH /:gameId/notes`                                    | 2                                                                                                | #109                                                                    |
| `games.ts:2344`         | `PATCH /:gameId/tuning`                                   | 2                                                                                                | #109                                                                    |
| `games.ts:2406`         | `PATCH /:gameId/review`                                   | 2                                                                                                | #109                                                                    |
| `games.ts:2822`         | `POST /:id/launch`                                        | 2                                                                                                | #109                                                                    |
| `games.ts:2928`         | `POST /:gameId/auto-preset`                               | 2                                                                                                | #109                                                                    |
| `games.ts:2476`         | `PATCH /:gameId/rating`                                   | 1 (four candidate tables; only `AppTracking` exists)                                             | none needed                                                             |
| `games.ts:2523`         | `PATCH /dlc/status`                                       | 0 (none of the four candidate DLC tables exists)                                                 | none needed                                                             |
| `dealAggregator.ts:433` | `GET /api/deals/arbitrage` (seeds when the feed is empty) | 6 (six seeds, each catching)                                                                     | one `.immediate()`: 1 wait (`0463fca`)                                  |

Table existence comes from the `CREATE TABLE[^(]*(DLC|Tracking)` grep in section 2.2.

### 3.3 Not reachable from a request handler

| Loop                                               | Reached from                                                | Note                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `db.ts:1587` `rebuildTableUserScoped`              | `initDb()` at boot                                          | runs before `installShutdownHandlers`; there is no handler to delay                                                                       |
| `db.ts:1716`, `1730` `verifySchemaIntegrity`       | `initDb()` at boot                                          | same                                                                                                                                      |
| `modCatalogSanitizer.ts:68` `reSanitizeModCatalog` | boot, and the hourly cron `15 * * * *` (`scheduler.ts:250`) | **same shape**, with row count set by the `Mods` table; the cron is off where `DISABLE_CRON=true` (preprod); proposed as a separate issue |
| `scripts/normalizeDb*.ts` (6 loops)                | CLI                                                         | out of process                                                                                                                            |

### 3.4 The other 53 write loops (UNCAUGHT)

The first failed write throws out of the loop, so a lock that stays held costs one wait.
**Limitation:** under a lock taken and released repeatedly, each write in such a loop can
wait part of a busy timeout and then succeed. The bound above assumes the held-lock model
that the probe and #108 use.

### 3.5 After the fix: loops that await the checkpoint

```
src/routes/devices.ts:453	For	CAUGHT-IN-LOOP	no-tx	checkpoint	fn persistPlayabilityProfiles	writes@460
src/routes/games.ts:2598	ForOf	UNCAUGHT	no-tx	checkpoint	PATCH /batch-status	writes@2600
src/routes/games.ts:3141	ForOf	CAUGHT-IN-LOOP	no-tx	checkpoint	POST /backup/restore-tuning	writes@3144
src/routes/games.ts:3195	ForOf	CAUGHT-IN-LOOP	no-tx	checkpoint	POST /sync/steam	writes@3216,3223,3240
src/routes/sync.ts:239	ForOf	CAUGHT-IN-LOOP	no-tx	checkpoint	POST /epic	writes@256,260
src/services/dealAggregator.ts:492	ForOf	CAUGHT-IN-LOOP	no-tx	checkpoint	fn ingestAllDeals	writes@495
SUMMARY files=118 loops=684 write_loops=84 UNCAUGHT=53 CAUGHT-IN-LOOP=29 HELPER-CATCHES=2 writers=64
```

## 4. Demonstrated failing first: probe records

`scripts/probes/ai043-contended-shutdown.mjs <appDir> restore [profiles] [shortened|app] [app|legacy]`
works like this:

- **Setup.** The child runs the app's real `initDb()` and mounts the real games router.
  The parent holds `BEGIN IMMEDIATE` on the scratch database and posts a restore-tuning
  request.
- **Signal.** SIGTERM is sent 1 s after the request.
- **Timeouts.** `shortened` puts every registered handle at 250 ms before the request.
  That is the drain-time state, and the 47 s case in #108. `app` keeps the app's own
  timeouts.
- **Schema.** `legacy` also creates the `AppTrackings` candidate table.

The probe ran inside images built locally from `git archive`: `mgpl-ai056-local:6d23340`
(`develop`) and `mgpl-ai056-local:5e27a3c` (the fix). Docker Desktop, Linux containers.

### 4.1 Before: `develop` 6d23340

The first legacy attempt failed on a probe bug, not on the app: `GameID` and `gameId` are
the same column name to SQLite. It was fixed and rerun at 12:41:19Z.

```
===== image mgpl-ai056-local:6d23340 (sha256:87801a00550dd22fe8d3b6f6371d82ae2e4efe9be97489979585885d7a0faaf1), scenario restore 65 shortened app (2026-09-25T12:38:28Z)
+31910 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+31914 ms [shutdown] HTTP server closed after 1 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+31905 ms restore response 200 {"success":true,"importedCount":0,"errors":"65 error(s)"}
RESULT scenario=restore profiles=65 busy=shortened tables=app exit=0 signal_to_exit_ms=31923 drain_timeout_ms=5000
===== image mgpl-ai056-local:6d23340 (sha256:87801a00550dd22fe8d3b6f6371d82ae2e4efe9be97489979585885d7a0faaf1), scenario restore 65 shortened legacy (2026-09-25T12:39:04Z)
SqliteError: duplicate column name: gameId
    at Database.exec (/app/node_modules/better-sqlite3/lib/methods/wrappers.js:9:14)
    at runRestoreParent (file:///probes/ai043-contended-shutdown.mjs:262:12)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5) {
  code: 'SQLITE_ERROR'
}
===== image mgpl-ai056-local:6d23340 (sha256:87801a00550dd22fe8d3b6f6371d82ae2e4efe9be97489979585885d7a0faaf1), scenario restore 10 app app (2026-09-25T12:39:05Z)
+99261 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+99265 ms [shutdown] HTTP server closed after 3 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+99257 ms restore response 200 {"success":true,"importedCount":0,"errors":"10 error(s)"}
RESULT scenario=restore profiles=10 busy=app tables=app exit=0 signal_to_exit_ms=99279 drain_timeout_ms=5000
===== image mgpl-ai056-local:6d23340 (sha256:87801a00550dd22fe8d3b6f6371d82ae2e4efe9be97489979585885d7a0faaf1), scenario restore 65 shortened legacy (2026-09-25T12:41:19Z)
+50577 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+50590 ms [shutdown] HTTP server closed after 12 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+50572 ms restore response 200 {"success":true,"importedCount":0,"errors":"65 error(s)"}
RESULT scenario=restore profiles=65 busy=shortened tables=legacy exit=0 signal_to_exit_ms=50628 drain_timeout_ms=5000
```

### 4.2 After: fix 5e27a3c

```
===== image mgpl-ai056-local:5e27a3c (sha256:2ba770c4b2563376dc9ad26cf3e85cb491f276c58bf728b23b3294b7e1eee4f8), scenario restore 65 shortened app (2026-09-25T12:43:29Z)
+23 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+32 ms [shutdown] HTTP server closed after 7 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+31 ms restore response 503 {"error":"Server is shutting down; retry the request"}
RESULT scenario=restore profiles=65 busy=shortened tables=app exit=0 signal_to_exit_ms=36 drain_timeout_ms=5000
===== image mgpl-ai056-local:5e27a3c (sha256:2ba770c4b2563376dc9ad26cf3e85cb491f276c58bf728b23b3294b7e1eee4f8), scenario restore 65 shortened legacy (2026-09-25T12:43:34Z)
+23 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+29 ms [shutdown] HTTP server closed after 5 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+28 ms restore response 503 {"error":"Server is shutting down; retry the request"}
RESULT scenario=restore profiles=65 busy=shortened tables=legacy exit=0 signal_to_exit_ms=34 drain_timeout_ms=5000
===== image mgpl-ai056-local:5e27a3c (sha256:2ba770c4b2563376dc9ad26cf3e85cb491f276c58bf728b23b3294b7e1eee4f8), scenario restore 10 app app (2026-09-25T12:43:36Z)
+3989 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+3994 ms [shutdown] HTTP server closed after 4 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+3993 ms restore response 503 {"error":"Server is shutting down; retry the request"}
RESULT scenario=restore profiles=10 busy=app tables=app exit=0 signal_to_exit_ms=3999 drain_timeout_ms=5000
===== image mgpl-ai056-local:5e27a3c (sha256:2ba770c4b2563376dc9ad26cf3e85cb491f276c58bf728b23b3294b7e1eee4f8), scenario restore 650 app legacy (2026-09-25T12:43:42Z)
+3987 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 3 of 3 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+3993 ms [shutdown] HTTP server closed after 4 ms; closed 3 of 3 registered SQLite handle(s), 0 failed; exiting 0
+3992 ms restore response 503 {"error":"Server is shutting down; retry the request"}
RESULT scenario=restore profiles=650 busy=app tables=legacy exit=0 signal_to_exit_ms=3999 drain_timeout_ms=5000
```

### 4.3 Summary (signal to exit, measured)

| Profiles | Busy timeouts        | Schema | `develop` 6d23340     | fix 5e27a3c      |
| -------- | -------------------- | ------ | --------------------- | ---------------- |
| 65       | 250 ms (drain state) | app    | 31,923 ms, exit 0     | 36 ms, exit 0    |
| 65       | 250 ms (drain state) | legacy | **50,628 ms**, exit 0 | 34 ms, exit 0    |
| 10       | app (games.ts 5 s)   | app    | 99,279 ms, exit 0     | 3,999 ms, exit 0 |
| 650      | app (games.ts 5 s)   | legacy | not run               | 3,999 ms, exit 0 |

- **The 47 s case.** Codex's 47.019 s is the legacy row: three contended writes per
  profile (65 × 3 × 250 ms ≈ 48.75 s). With `initDb()`'s schema the second candidate
  table does not exist, so it is two writes and 31.9 s.
- **Before.** The shutdown handler ran only after every profile had failed. The restore
  then answered `200 success:true, importedCount 0` with 65 errors.
- **After.** The in-flight call finishes and the next checkpoint throws. The request gets
  `503 "Server is shutting down; retry the request"`.
- **App timeouts.** The call in flight is `games.ts`'s 5 s wait. It started 1 s before the
  signal, so the exit comes 4.0 s after it. With 650 profiles the time is the same 4.0 s.
- **Not run.** The 650-profile case was not run on `develop`. By arithmetic it would take
  about 2.7 h.

### 4.4 Regression: the AI-043 scenarios on both images

```
===== image mgpl-ai056-local:6d23340 (sha256:87801a00550dd22fe8d3b6f6371d82ae2e4efe9be97489979585885d7a0faaf1), scenario drain (2026-09-25T12:44:03Z)
+2 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 1 of 1 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+5003 ms [shutdown] drain timeout after 5000 ms, remaining connections destroyed; closed 1 of 1 registered SQLite handle(s), 0 failed; exiting 0
RESULT scenario=drain exit=0 signal_to_exit_ms=5007 drain_timeout_ms=5000 app_busy_timeout_ms=10000
===== image mgpl-ai056-local:6d23340 (sha256:87801a00550dd22fe8d3b6f6371d82ae2e4efe9be97489979585885d7a0faaf1), scenario blocked (2026-09-25T12:44:12Z)
+9002 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 1 of 1 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+14009 ms [shutdown] drain timeout after 5000 ms, remaining connections destroyed; closed 1 of 1 registered SQLite handle(s), 0 failed; exiting 0
RESULT scenario=blocked exit=0 signal_to_exit_ms=14017 drain_timeout_ms=5000 app_busy_timeout_ms=10000
===== image mgpl-ai056-local:5e27a3c (sha256:2ba770c4b2563376dc9ad26cf3e85cb491f276c58bf728b23b3294b7e1eee4f8), scenario drain (2026-09-25T12:44:28Z)
+2 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 1 of 1 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+5004 ms [shutdown] drain timeout after 5000 ms, remaining connections destroyed; closed 1 of 1 registered SQLite handle(s), 0 failed; exiting 0
RESULT scenario=drain exit=0 signal_to_exit_ms=5008 drain_timeout_ms=5000 app_busy_timeout_ms=10000
===== image mgpl-ai056-local:5e27a3c (sha256:2ba770c4b2563376dc9ad26cf3e85cb491f276c58bf728b23b3294b7e1eee4f8), scenario blocked (2026-09-25T12:44:36Z)
+8994 ms [shutdown] SIGTERM received; SQLite busy timeout 250 ms on 1 of 1 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
+13999 ms [shutdown] drain timeout after 5000 ms, remaining connections destroyed; closed 1 of 1 registered SQLite handle(s), 0 failed; exiting 0
RESULT scenario=blocked exit=0 signal_to_exit_ms=14003 drain_timeout_ms=5000 app_busy_timeout_ms=10000
```

The results are unchanged: `drain` 5.0 s, `blocked` 14.0 s. `blocked` is the bound itself:
one 10 s call (9 s of it after the signal) plus the 5 s drain.

## 5. Preprod: contended `docker stop` not done

Following the prompt, the first step was a redeploy of preprod from `develop`:

- The `develop` tree was copied to `/opt/mgpl-build/develop-6d23340/` on the host.
- The image was built there as `mgpl-preprod-app:develop-6d23340`
  (`sha256:8c3daffaa29813b5f249443880a95ddc9944fe16c898b34abbf5ed26a8ec7726`), between
  12:54:18Z and 12:54:35Z.

Before that, the host compose file was diffed against `develop`'s. The only difference is
`stop_grace_period: 30s` and its comment.

**Recreating the container was refused by the agent's permission layer as a production
deploy, and was not attempted again.** Preprod is unchanged. It still runs
`mgpl-preprod-app:ai043-5cb1f02` (= `latest`) with the `ai043-5cb1f02` grace override, so
the contended `docker stop` criterion was **not tested**. The new build directory and
image tag are the only additions on the host.

## 6. Proposed wording for #90's criterion (for the operator to apply)

> `docker stop mgpl-preprod-app`, with another connection holding the SQLite write lock
> and a request of any size writing when SIGTERM lands, exits 0 or 143 (never 137) and
> logs `closed N of N registered SQLite handle(s), 0 failed`. The time from signal to exit
> is at most the SQLite call in progress when the signal lands plus the drain. It must not
> grow with the in-flight request's size: demonstrate that with two request sizes an order
> of magnitude apart. Record the elapsed time and the log.
