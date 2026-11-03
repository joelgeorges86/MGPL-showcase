# CHANGELOG - Multi-Platform Game Library (MGPL) Dashboard

All notable changes to this project will be documented in this file, structured in accordance with Appendix D of the Personal Vibe Coding Manual v4.0.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Engineering hygiene & tooling (2026-08-30)**:
  - Added `scripts/check-client-syntax.js` — `test:client` now glob-scans `public/*.js` (28/28) instead of a hardcoded file list that could drift.
  - Added a **Vitest unit layer** (`vitest.config.ts`, `test/unit/*.test.ts`) covering 8 pure modules: `headroom`, `dealSchema`, `storefrontValidator`, `platformTaxonomy`, `tokenCipher`, `modSchema`, `wishlistPricing`, `storefrontCircuitBreaker` — **61 tests in ~0.5s** (`npm run test:unit`). Playwright E2E stays the integration harness; unit tests give a fast logic feedback loop.
  - **Schema single-source-of-truth**: removed the Prisma runtime entirely (`schema.prisma`, `src/prisma.ts`, `prisma.config.ts`, `@prisma/*` deps, Docker `prisma generate`). `src/db.ts` DDL is now the only schema authority. Rewrote `deals.ts`, `platforms.ts`, `quickMatch.ts`, `tracking.ts`, `users.ts`, `dlcAudit.ts` and `scripts/normalizeDb.ts` from Prisma queries to parameterized better-sqlite3 SQL (with a shared `loadDealGames()` bulk-relation helper). Full E2E suite green (0 failed).
  - New **`DOCS/SPRINT_REFERENCE_MAP.md`**: reconciles the project-sprint scheme (S1–S35, used in source headers) with the git delivery-sprint scheme (Sprint 1A–7) and maps every FEAT/EPIC/WUD/PI-GTM identifier to its sprint. Standardized `alerts.ts` header to `FEAT-0158 (S25)`.
  - Repo hygiene: untracked 15 committed debug/build artifacts (`*.txt` dumps, `*.pyc`, `*.bak`, `.docx`, `image.png`, `hw-profile.json`); added ignore rules; re-encoded `README.md` to UTF-8; regenerated `FILEMAP.md` from reality.
- **Sprint 7 (WUD-28.6 follow-up — Docker production volume convergence)**:
  - Converged the stale `data/mpgl_app.db` Docker volume (25 tables, 1,067 `AppGames`) to the authoritative root `mpgl_app.db` (48 tables, 1,087 `AppGames`) via a `VACUUM INTO` snapshot replace, after a read-only divergence audit.
  - Divergence audit: 24 volume rows had PKs absent from root; business-key dedup proved 16 were logical duplicates and **8 were genuinely exclusive seeded/E2E artifacts** (`AppWishlist` × 6, E2E-import `AppGames`/`AppOwnership` × 2 with zero dependent rows). Preserved them as `backups/vol-exclusive-rows-dump.json` (committed) plus a full volume backup `backups/mpgl_app_data_volume_2026-08-27_220121.db` — zero data loss, recoverable.
  - Post-convergence `data/mpgl_app.db` verified: `journal_mode=wal`, `integrity_check=ok`, `foreign_key_check` **0 violations**, 48 tables, all row counts matching root. Root DB confirmed untouched. Documented in `DOCS/PLATFORM_AUDIT_REPORT.md` Addendum A.4.
- **Sprint 6 (PI-GTM-2026-002 — Integration, Observability, UAT & Go/No-Go)**:
  - New `src/services/integrationMonitor.ts`: Zero-PII in-memory observability registry for all 13 external integrations (`steam`, `psn`, `xbox`, `epic`, `gog`, `ubisoft`, `protondb`, `cheapshark`, `itad`, `gamerpower`, `nexusmods`, `hltb`, `dpm`) tracking success/failure/rate-limit/domain-rejection/token-expiry/stale counters, deterministic read-time staleness vs completeness thresholds, and dependency-free Prometheus text exposition.
  - New `src/routes/observability.ts`: `GET /api/observability/health` (sanitized Zero-PII JSON — static status names + integer counters only), `GET /api/observability/metrics` (text/plain), and `POST /api/observability/record` (exact-match validated event ingestion, never echoes input); rate-limited like `/api/dpm`.
  - New `src/middleware/fallbackRenderer.ts`: global `X-Data-As-Of` / `X-Data-Fresh` freshness headers stamped on every API response plus the `renderModuleFallback` cross-module graceful-fallback envelope (`usingFallback` / `stale` / `dataAsOf`).
  - New `public/admin.js` Integration Health Dashboard rendered at `#/observability` ("Data as of [timestamp]" freshness indicator, per-integration status pills + counters, explicit refresh action); registered in `public/app.js` ROUTES/handleRoute, `public/index.html`, and the `test:client` syntax gate.
  - `src/routes/state.ts`: documented that observability telemetry is ephemeral in-memory runtime state (like the DPM counters and `platform_audit_logs`) intentionally excluded from snapshot export/import round-trips.
  - **Tests**: `test/e2e/security-regression.spec.ts` (11 tests — observability sanitization, freshness headers, exact-match event validation, mod URL sanitization, deals HTTPS domain whitelist, error sanitization, palette token safety, ingestion validation, platform-wide Zero-PII leak scan, 25+ table state snapshot round-trip). Full suite `npx playwright test --workers=1`: **392 passed / 0 failed**.
  - **Fix**: `POST /api/mock/seed` (`src/routes/mock.ts`) now persists `cpuCores` when re-seeding `Devices`, mirroring `test/global-setup.ts` — the previous delete+re-insert wiped the Sprint 5 rig-telemetry columns and deterministically broke `sprint5-hardware.spec.ts` tests 4/8 in full-suite runs.
- **Sprint 5 (EPICUX05 — Hardware Explorer 2.0)**:
  - New `src/services/hardwareExplorer.ts`: PII-free local scan normalization (CPU model/cores, RAM, GPU model/VRAM, storage capacity/free, battery/thermal, `deviceClass`, `scanConfidence`); VRAM is never inferred from the GPU name (Strict Extraction). New `src/routes/hardwareExplorer.ts` exposes `POST /api/scan`, `GET /api/hardware/explorer`, `POST /api/hardware/compatibility` (explicit-trigger Minimum/Recommended/Ultra headroom), filterable `GET /api/hardware/benchmarks`, `GET /api/hardware/components/search`, `GET /api/hardware/components/compare` (≤4 slots + price trends), and `GET /api/hardware/upgrade` (real-spec upgrade advisor with verified retailer links).
  - `src/services/headroom.ts` gains `evaluateTieredCompatibility` + `deriveTierRequirements` (Recommended/Ultra derived deterministically from persisted minimums, labeled `derived: true`).
  - Additive rig-telemetry columns on `Devices` (`cpuCores`, `storageType`, `storageFreeGb`, `scanConfidence`, `deviceClass`, `thermalCapabilities`, `lastScanAt`) + new `community_benchmarks` table (avg FPS / 1% low FPS) seeded by `src/seed/benchmarks.ts`; component price-history trend rows added to `seedHardwarePriceHistory`.
  - State persistence registered in `src/routes/state.ts` (Devices columns + `community_benchmarks` snapshot round-trip).
  - New `public/hardware.js` + `#/hardware` route (Rig Telemetry, Compatibility Checker, Upgrade Advisor, tabbed sticky-header Comparison Tool, filterable Community Benchmarks) with explicit action triggers; cross-links from the `#/devices` hub.
  - **Tests**: `test/e2e/sprint5-hardware.spec.ts` (11 tests — PII-free scan, tiered compatibility, blocked missing-VRAM states, upgrade advisor + whitelisted retailers, component compare, filterable benchmarks, state round-trip, explicit-trigger UI, deep links). `state-ui-backup.spec.ts` snapshot key count 32 → 33.
- **Sprint 4 (EPICUX04 — Mods Hub 2.0)**:
  - New `src/services/modManager.ts`: deterministic per-domain mod manifest (long description, masked author profile, stats, version history/changelog, dependency edges, file-level manifests) plus `ensureModHubSeed`, `getModDetail`, `getDependencyTree`, `detectFileConflicts`, `getLoadOrder`, `saveLoadOrder`.
  - New API routes: `GET /api/mods/detail`, `GET /api/mods/dependencies`, `GET /api/mods/conflicts` (selected-set or active-installed analysis), `GET/PUT /api/mods/load-order`; the `/installed` toggle now syncs `ModLoadOrder` active slots.
  - Additive DDL for `ModVersions`, `ModDependencies`, `ModLoadOrder` (FK-free, keyed by Nexus `gameDomain` slug + `modId`, consistent with `InstalledMods`); registered in `src/routes/state.ts` for JSON snapshot export/import round-trip.
  - New `public/mods.js`: Mod Detail drawer (Description / Screenshots / Changelog / Dependency Tree tabs + stats bar), Load Order Manager (drag-and-drop + keyboard reorder + one-step undo, instant SQLite persistence), and automated file-level conflict badges/strips.
  - Security: every outbound link re-runs `sanitizeModUrl`; author handles masked (zero-PII); descriptions/changelogs pass `sanitizeModDescription`; errors via `safeErrorMessage`. Non-destructive additive DB patterns — no `prisma db push`.
  - **Tests**: `test/e2e/sprint4-mods.spec.ts` (8 tests — detail payload, file-level conflict detection, missing-dependency warnings, load-order persistence, state snapshot round-trip, UI detail view without layout shifts, keyboard reorder + undo + persistence, conflict badges); `test/e2e/state-ui-backup.spec.ts` snapshot key count updated 29 → 32.
- **Sprint 1A (EPICSEC01 / EPICSEC04 — Unified Ingestion Validation & Error Sanitization)**:
  - New shared backend sanitizer: `src/utils/errorSanitizer.ts` (`sanitizeErrorMessage` / `safeErrorMessage`) plus `src/middleware/errorSanitizer.ts` (`sendApiError` / `apiErrorHandler`). `safeToastError` now delegates to the shared server sanitizer; the client mirror `public/safes.js` keeps the stack-strip ordering in sync.
  - `src/index.ts` terminal error handler replaced with the shared `apiErrorHandler` — sanitized, standardized `{ success: false, error }` / `{ error }` responses; full diagnostic detail logged server-side only.
  - New unified ingestion toolkit `src/utils/ingest.ts` (`safeCoerce` str/num/int/bool/arr/obj/nullableStr, `safeIngest`, `validateIngest`) re-exporting `safeHydrate`/`safeArray`/`safeFetchJSON`, wired into the Mods, Compare, Retro Hub, Deals, and Analytics adapters.
  - Eliminated every raw `err.message` / `error.message` leak to clients across Express routes (`games.ts`, `mods.ts`, `sync.ts`, `dashboard.ts`, `library.ts`) and sanitized caller-supplied echoes in the mods URL middleware (paths/secrets redacted).
  - Standardized all 137 `res.status(500)` response sites to route through `sendApiError` with stable fallback messages.
  - Client toast sanitizers: `importer.js`, `retro.js`, `settings.js` now render errors through `window.safeToastError`.
  - **Tests**: `test/e2e/ingestion-sanitization.spec.ts` (8 tests — client privacy-shield redaction, `safeArray`/`safeHydrate` fallbacks, sanitized 400s, body-parser failure handling, retro ingestion hydration, deals array fallback, compare benchmark regression).
- **EPIC-01 (Multi-Genre Filtering Engine)**:
  - `GET /api/games` now accepts `?genre=a,b,c` multi-value facets with `?genreMode=all|any` (intersection default / union). Tokens are strictly sanitized and capped at 20 (`parseGenreFacet`) — never a 500, never a guess.
  - New `GET /api/games/genres` facet endpoint returns the CMS-extensible `AppGenres` list with live game counts; degrades to an empty list when the Steam-tag taxonomy tables are absent.
  - Library ("Game Tab") genre facet pills now narrow via intersection (every selected genre required), matching the backend default; single-genre behavior is unchanged.
  - New dual-mode **Grid / List** view toggle (`#library-view-grid` / `#library-view-list`) above the library tile grid; view mode + every facet survive pagination and mode switches.
- **EPIC-05 (DPM & Platform Hub final closeout — 18/18 defects)**:
  - `headroom.ts`: data-driven CPU requirement (DPM-01), battery-scaled storage headroom (DPM-02), device-side completeness gate returning `Incomplete Specs` for missing CPU/RAM/VRAM/storage (DPM-12).
  - `devices.ts`: deterministic iGPU-aware `hwCategory` (DPM-03), EPIC-04 canonical-platform gating of owned games (DPM-04), `lastScanAt` + `staleSpecs` freshness contract (DPM-06), in-memory TTL cache + `[perf]` duration logging for the P90 ≤ 2s budget (DPM-10), `blockedSpecs`/`staleSpecs`/`usingFallback` response flags (DPM-07/11).
  - `db.ts` / `scheduler.ts`: `runDataFreshnessBaseline()` exported and wired into a **weekly Mon-04:00 cron**; baseline now reports `staleDeviceRows` (DPM-08).
  - `catalog_devices` gains `platformCanonical` (DDL + guarded ALTER + state-snapshot registration); seed adds PS4, PS4 Pro, Switch V2, Xbox Series S 1TB with deterministic canonical derivation (DPM-05).
  - `platforms.ts`: GOG giveaways no longer match bare `drm-free` (HUB-04).
  - `public/index.html` + `app.js`: mobile-first DPM grid + blocked/stale/fallback banners (DPM-09/11), scroll-snap mobile Platform Hub tabs + mobile-first overview grid (HUB-05).
- **Tests**: `test/e2e/multi-genre-filter.spec.ts` (10 tests — backend facets, intersection/union, sanitization, `/genres`, pagination composition, client multi-select pills, pagination-state persistence, Grid/List toggle, axe accessibility).

### Changed
- `fleet-compatibility.spec.ts` CPU-axis assertion updated to the corrected DPM-01 behavior (`missing`/no universal 4-core bar).

### Sprint 6 (PI-GTM-2026-001) - System Integration, WCAG 2.1 AA Audit & UAT Go/No-Go
#### Added
- **Accessibility (WCAG 2.1 AA Hardening)**:
  - `trapFocus` (`app.js`) now filters to *visible* focusables only, matching the browser's default Tab order. Ownership-aware drawers hide wishlist/deals controls via `display:none`; Tab from the last visible control now wraps inside the dialog instead of escaping (WCAG 2.1.2 No Keyboard Trap).
  - `#mods-drawer` now saves/restores focus and traps Tab navigation on open/close (WCAG 2.4.3 / 2.1.2), matching the game-detail drawer and command-palette conventions.
  - `nav.js`: clicking a Settings dropdown action keeps the nav dropdown trigger focused as the menu collapses, so the settings drawer's `saveFocus`/`restoreFocus` cycle returns keyboard focus to a visible element on close (WCAG 2.4.3).
  - New `test/e2e/accessibility-audit-sprint6.spec.ts` (4 tests) closes the two remaining audit gaps: Mods drawer axe scan + dialog semantics + keyboard trap/focus restore, and the rendered Compare matrix axe scan + semantic `<th scope="col">` table verification, plus an ARIA contract sweep (`aria-live` / `aria-expanded` / `aria-pressed`) across the Game Tab / Compare / Retro surfaces.
- **Performance & Stability (P90 verification)**:
  - New `test/e2e/performance-sprint6.spec.ts` (3 tests) verifies the documented 2s P90 latency budget for multi-genre facet queries, catalog pagination round-trips, and comparison-matrix click-to-render after the explicit Analyze action (Chapter 23 explicit-trigger rule).
- **Quality Gates / Tooling**:
  - `test:client` now syntax-checks `public/legal.js` (previously the only unchecked client script).
- **UAT Go/No-Go**: `DOCS/UAT-GO-NOGO.md` records the final gate results and the PI-GTM-2026-001 release decision.
#### Fixed
- `accessibility-nav.spec.ts`: drawer trap test now waits for the drawer's async detail fetch and asserts wrap-to-first-*visible*-focusable semantics (the "Open Full Game Page" link precedes the close button in DOM order).
- `auth-ui.spec.ts`: header button label assertion updated to the current "Login / Sign Up" rendering.
- `legal-compliance.spec.ts`: 30-day-low badge assertion updated to the current "Lowest in 30 days: $" rendering.
- `profile-ui.spec.ts`: settings-drawer focus restore now returns to the nav dropdown trigger (app fix in `nav.js`).
- `wishlist.spec.ts`: drawer add-to-wishlist flow no longer pre-seeds the item — the state-aware drawer button would otherwise flip into Remove mode.

## [1.0.0] - 2026-08-08
### Added
- Unified sync pipeline script (`scripts/sync_all_user_stats.js`) to support playtime, play status, trophy progress, and tracked mod synchronization across Steam, PSN, GOG, and Nexus Mods.
- Automatic SQLite database migrations inside the sync pipeline script to check and dynamically alter tables to add `Trophy Progress` (AppTracking), `trackedModCount` (AppGames), and `modNotifications` (AppGames) columns.
- Express API route `POST /api/sync/all-stats` in `src/routes/games.ts` using `syncLimiter` middleware.
- Routing rewrite middleware in `src/index.ts` to cleanly support `/api/sync/all-stats` and `/api/sync/steam` endpoint rewrites to the unified router.
- Frontend multi-platform "Sync Stats" top navigation button in `public/index.html` styled with Tailwind, featuring a rotating loading spinner, automatic grid refresh on success, and clear summary alerts.
- Compliance documentation files: `FILEMAP.md` in the project root, `.aiignore` in the project root, `.ai/CHANGELOG.md`, `.vscode/cline.json` for AI tool permissions/constraints, and formatted `.vscode/settings.json` workspace settings.

### Changed
- Replaced the single "Sync Steam" top navigation button with the new comprehensive "Sync Stats" button.
- Updated default configuration of `better-sqlite3` connections in backend routes to ensure WAL journal mode and busy timeouts are consistently configured.

### Session - 2026-08-08 14:03 EDT
**Model(s) used:** Gemini 3.6 Flash (Cline Act Mode)
**Branch:** chore/v4-workspace-restructure
**Done:**
- Updated `.vscode/cline.json` `customInstructions` field to mandate automated session logging to `.ai/CHANGELOG.md` upon task completion.
- Verified TypeScript compilation using `npx tsc --noEmit` and confirmed 0 compilation errors.
**Left incomplete:** None. Custom instructions update completed.
**Next session start:** Ready for deployment or other system configuration tasks.

### Session - 2026-08-08 14:10 EDT
**Model(s) used:** Gemini 3.6 Flash (Cline Act Mode)
**Branch:** chore/v4-workspace-restructure
**Done:**
- Refined the playStatus logic in `scripts/sync_all_user_stats.js` for Steam Sync to only set to `'In Progress'` when the current tracking status is `'Not Started'`, matching the precise task constraint.
- Ran `npx tsc --noEmit` to verify 0 compilation errors across TypeScript route files and project bootstrap files.
**Left incomplete:** None. All multi-platform sync pipeline integrations and workspace restructures are 100% complete.
**Next session start:** Production-ready; ready for deployment or custom platform testing with credentials.

### Session - 2026-08-08 16:14 EDT
**Model(s) used:** Gemini 3.6 Flash (Cline Act Mode)
**Branch:** chore/v4-workspace-restructure
**Done:**
- Created and executed a standalone, non-blocking data enrichment script `scripts/enrich_game_data.js` to populate vertical high-resolution cover URLs (`cover_url`) and compute robust laptop playability status (`Laptop Playability`) across all 878 games.
- Integrated error logging to `scripts/enrichment_errors.log` on empty/error responses, strict throttle delay configuration (350ms-300ms), and 100% offline cache optimization.
- Added mapped `cover_url` property support across Prisma `schema.prisma` model and Express REST API endpoint definitions (`src/routes/games.ts`).
**Left incomplete:** None. All games have been enriched successfully.
**Next session start:** Ready for deployment or custom platform testing with credentials.

### Session - 2026-08-08 18:00 EDT
**Model(s) used:** Claude 3.5 Sonnet (Cline Act Mode)
**Branch:** main
**Done:**
- Verified TypeScript compilation using `npx tsc --noEmit` and confirmed 0 compilation errors across the project codebase.
- Summarized the **DLC Audit** feature, documenting:
  - Backend Express route `GET /` in `src/routes/dlcAudit.ts` (mapped to `/api/dlc-audit`) which queries `prisma.appDLC` for unowned expansion records.
  - Integration with a local cache `.cache/dlc_details.json` to merge and enrich missing DLC lists, cosmetic vs. story categories, individual prices, total missing catalog purchase cost, and customized completion friction level/score metrics.
  - Frontend router component `DLCComparisonRouter.tsx` mapping store links (Steam, GOG, Epic, PlayStation Store) alongside an information dashboard illustrating unowned DLC lists, overall completion friction level, and financial missing costs.
- Summarized the **Quick Match** feature, documenting:
  - Backend Express route `GET /` in `src/routes/quickMatch.ts` (mapped to `/api/quick-match`) designed to find matches for session play sessions on custom available minutes, cognitive mental energy (low, moderate, high), hardware profiles, play time ranges, and ROG Ally playability criteria.
  - Utilization of robust in-memory JavaScript filtering (e.g., parsing session minutes, RAM/VRAM numbers, main story hours, and completionist times from roadmaps/frictions) to bypass SQLite numeric/string conversion errors.
**Left incomplete:** None. All feature documentation and validation steps are completed.
**Next session start:** Ready for deployment or additional dashboard integrations.

### Session - 2026-08-10 10:20 EDT
**Model(s) used:** Claude 3.5 Sonnet (Cline Act Mode)
**Branch:** main
**Done:**
- Resolved dependency vulnerabilities by adding `"overrides"` for `"axios": "^1.7.4"` in `package.json` and aligning the direct dependency version.
- Successfully ran `npm install` and verified 0 high-severity vulnerabilities with `npm audit`.
- Implemented **Sprint 1 Backend Keyless Integration Routes**:
    - `src/routes/enrich.ts`: `POST /api/enrich/hltb` for HLTB gameplay hours enrichment. Includes automated SQLite schema migration to add `hltbMainHours` column to `AppGames`.
    - `src/routes/giveaways.ts`: `GET /api/giveaways/active` to fetch active PC giveaways from GamerPower API.
    - `src/routes/devices.ts`: `POST /api/devices/scan-local` using `systeminformation` to detect host hardware. Includes automated creation of `Devices` table with `ON CONFLICT` update logic.
- Registered all new routes in `src/index.ts` under `/api/enrich`, `/api/giveaways`, and `/api/devices`.
- Verified 0 TypeScript compilation errors using `npx tsc --noEmit`.
**Left incomplete:** None.
**Next session start:** Ready for frontend integration of new Sprint 1 endpoints.

### Session - 2026-08-10 10:28 EDT
**Model(s) used:** Claude 3.5 Sonnet (Cline Act Mode)
**Branch:** main
**Done:**
- Built Sprint 2 Multi-Platform Library Sync Routes in `src/routes/sync.ts`.
- Implemented `POST /api/sync/steam` for syncing Steam library using `STEAM_API_KEY` and `STEAM_ID64`, updating `playStatus` correctly.
- Implemented `POST /api/sync/epic` for scanning local Epic Games manifests and dynamically upserting into the database.
- Implemented `POST /api/sync/all-stats` Master Aggregator to call Steam and Epic sync tasks concurrently using `Promise.allSettled`.
- Registered `syncRouter` in `src/index.ts` under `/api/sync`.
- Verified 0 TypeScript compilation errors using `npx tsc --noEmit`.
**Left incomplete:** None.
**Next session start:** Ready for integrating Sprint 2 sync features into the frontend dashboard.

### Session - 2026-08-10 12:08 EDT
**Model(s) used:** Claude 3.5 Sonnet (Cline Act Mode)
**Branch:** main
**Done:**
- Built Sprint 3 Backend Decision Engine & Hardware APIs:
  - Created `src/routes/recommend.ts`: Mapped `GET /api/games/recommend` to filter games based on `maxHours` (satisfying either main story hours or estimated battery runtime), `deviceId`, and `unpluggedOnly` constraints on a newly introduced `GameDeviceProfiles` table.
  - Created `src/routes/compare.ts`: Mapped `GET /api/games/compare` accepts `ids` parameter (min 2, max 4) and fetches titles from `AppGames` joined with `GameDeviceProfiles` and active mod counts from `InstalledMods`.
  - Updated `src/routes/devices.ts`: Added strongly typed `POST /api/devices/upsert` to allow upserting device specifications (deviceId, deviceName, formFactor, gpuModel, vramGb, cpuModel, batteryWh) into the `Devices` table using safe, parameterized `INSERT ... ON CONFLICT DO UPDATE` prepared statements.
  - Resolved routing precedence and path matching issues in `src/index.ts` by ensuring specific route prefixes `/api/games/recommend` and `/api/games/compare` are declared before generic `/api/games` routes.
  - Applied strict Express types (`Request`, `Response`, `NextFunction`) across all modified routers and root configurations to meet typing guidelines.
  - Verified 0 TypeScript compilation errors using `npx tsc --noEmit`.
**Left incomplete:** None.
**Next session start:** Ready for Sprint 3 Frontend integration.

### Session - 2026-08-27 EDT
**Model(s) used:** Cline (Act Mode)
**Branch:** feature/sprint-5-hardware-explorer
**Done:**
- Implemented Hardware Explorer 2.0 (EPICUX05): PII-free local scan (`POST /api/scan`), tiered Minimum/Recommended/Ultra compatibility headroom, real-spec upgrade advisor, ≤4-slot component comparison with sticky headers/tabs/price trends, filterable community benchmark tables, verified retailer whitelist links.
- Additive persistence: `Devices` rig-telemetry columns + `community_benchmarks` table (registered in `src/routes/state.ts`), new `#/hardware` SPA route + `public/hardware.js`, cross-links from `#/devices`.
- All DoD gates green: `npx tsc --noEmit` (0), `npm run test:client` (0), `npm run test:spell` (0), `npx playwright test test/e2e/sprint5-hardware.spec.ts --workers=1` (11/11), plus 60 targeted regression tests (state/device/compare suites).
**Left incomplete:** None.
**Next session start:** Ready for Sprint 6 planning (WCAG/UX audit or next epic).
