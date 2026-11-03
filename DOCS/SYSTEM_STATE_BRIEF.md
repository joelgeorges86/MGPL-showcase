# MGPL — Current State of System Brief

**Multi-Platform Game Library (MGPL) / Machine-Advanced Global Product Laboratory**
**Document type:** Engineering Architecture — Current State Assessment & Subsystem Deep-Dive
**Repository:** `joelgeorges86/MGPL` · **Branch authority:** root `AGENTS.md`; verify the active branch and commit before use
**Last verified:** 2026-09-04 (source and configuration reconciliation; live database counts below remain the 2026-08-30 snapshot)

---

## Executive Summary

MGPL is a **self-hosted, single-service multi-platform game library dashboard** that unifies library ingestion, hardware playability, price arbitrage, mod management, retro preservation, account-scoped state, and PWA offline sync in one codebase. It is built on Node.js 22 / Express / TypeScript with a single SQLite data layer (better-sqlite3, WAL mode) and is deployed as a containerized stack with Litestream replication, Caddy reverse proxying, and a Cloudflare Tunnel ingress.

The platform was delivered incrementally across **Sprints 1–7** (internal numbering to Sprint 28 in historical audit documentation). Earlier UAT records remain historical evidence. The current suite contains **407 Playwright tests across 81 spec files**. The September 4, 2026 serialized baseline completed with 407 passed and 0 failed.

### Current live-data snapshot (verified against `mpgl_app.db`)

| Domain                                              | Table                                                       | Rows      |
| --------------------------------------------------- | ----------------------------------------------------------- | --------- |
| Catalog                                             | `AppGames`                                                  | 1,087     |
| Ownership                                           | `AppOwnership`                                              | 1,238     |
| Tracking / Backlog                                  | `AppTracking` / `AppBacklog`                                | 980 / 980 |
| Genre mapping                                       | `AppGameGenreMap`                                           | 10,109    |
| Playability matrix                                  | `GameDeviceProfiles`                                        | 3,264     |
| Perf profiles                                       | `game_performance_profiles`                                 | 17,392    |
| Hardware prices                                     | `hardware_price_history`                                    | 2,340     |
| Fleet devices                                       | `Devices`                                                   | 13        |
| Auth users                                          | `AuthUsers`                                                 | 3         |
| Installed mods                                      | `InstalledMods`                                             | 4         |
| Deals / alerts                                      | `AppPriceAlerts` / `AppWishlist`                            | 12 / 1    |
| Tags / notes                                        | `AppGameTags` / `AppGameNotes`                              | 6 / 4     |
| Community                                           | `community_benchmarks` / `release_radar`                    | 45 / 16   |
| Catalog devices                                     | `catalog_devices`                                           | 58        |
| **Privacy-sensitive empty tables at snapshot time** | `Users`, `AppDevices`, `AppFriendships`, `AppRetroTracking` | **0**     |

`PRAGMA journal_mode` = **wal** · integrity check **ok** · `foreign_key_check` **0 violations** (WUD-28.6 audit).

---

## 1. System Identity & Purpose

The application is a comprehensive tool for **managing, syncing, and tracking a personal gaming collection**, enriched with:

- **Multi-source library ingestion** — Steam, GOG, Epic, PSN, Xbox, Ubisoft, plus custom/local catalogs.
- **Hardware profile matching** — persisted device specs and per-game playability tiering (Minimum / Recommended / Ultra) with multi-axis headroom.
- **Price arbitrage & deals radar** — multi-store deal feeds (CheapShark, ITAD, GG.deals, Deku Deals, GamerPower), historical lows, 24-month sparklines, price alerts, and wishlist drops.
- **Mods Hub** — deterministic mod catalogs with detail pages, dependency trees, file-conflict detection, and a SQLite-backed load-order manager.
- **Retro preservation hub** — legal re-release directory, emulator resources, and a sandboxed client-side WebAssembly runner (zero hosting of copyrighted assets).
- **Backlog & play sessions** — priority-scored backlog, stopwatch session tracking, completion velocity, and cost-per-hour analytics.
- **Privacy-minimized social / profile** — real accounts exist, while public profiles restrict exposure to approved gaming identity fields; platform-handle masking, granular consent, and Global Privacy Control (GPC) auto-opt-out remain enforced.

---

## 2. Technology Stack (verified from `package.json`)

| Layer         | Technology                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Node.js 22 LTS                                                                                                                          |
| Web framework | Express 4.18 (`cookie-parser`, `cors`, `compression`, `helmet` 8, `express-rate-limit` 8)                                               |
| Language      | TypeScript 5.5 (dev via `tsx`, build via `tsc`)                                                                                         |
| Data layer    | `better-sqlite3` 13 — synchronous, WAL mode, authoritative DDL in `src/db.ts` (single source of truth since 2026-08-30; Prisma removed) |
| Auth/security | `argon2` (Argon2id), `jsonwebtoken` (HS256), AES-256-GCM (`node:crypto`)                                                                |
| Integrations  | `axios`, `node-cron`, `psn-api`, `howlongtobeat`, `systeminformation`, `vscode-ripgrep`                                                 |
| Test/QA       | `@playwright/test` 1.62 + `@axe-core/playwright`, `cspell` 10                                                                           |
| Infra         | Docker (multi-stage), Litestream 0.3, Caddy 2, `cloudflared`, Tailscale, Doppler, GitHub Actions                                        |

---

## 3. Architecture & Subsystem Initialization

### 3.1 Process bootstrap (`src/index.ts`)

Initialization order (verified):

1. `dotenv.config()` loads `.env`. Configured keys: `PORT`, `STEAM_API_KEY`, `STEAM_ID64`, `PSN_NPSSO_CODE`, `ITAD_API_KEY`, `NEXUSMODS_API_KEY`, `OPENCRITIC_API_KEY`, `GOG_USERNAME`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`.
2. `installExternalMocks()` — installs a deterministic server-side axios adapter, **active only when `NODE_ENV === 'test'`** so the E2E suite is hermetic (no upstream network calls).
3. Middleware chain (in order):
   - `helmet` — CSP (production: strict allow-listed CDNs + `unsafe-inline` scripts; test: adds `unsafe-eval`), HSTS 1yr + preload, `frameguard: deny`, `noSniff`.
   - `compression()` — gzip for all responses.
   - `express.static(public)` — SPA assets.
   - `cors` — allowlist `localhost:5173/4000/64420`.
   - `express.json({ limit: '25mb' })` — sized for full-DB state snapshots.
   - `cookieParser()`.
   - `dataAsOfHeader` — stamps `X-Data-As-Of` / `X-Data-Fresh` on every API response.
4. Rate limiting: global `300 req / 15 min` (`RATE_LIMIT_MAX`), dedicated sync limiter `10 req / 5 min`, per-endpoint limiters for `/api/dpm` and `/api/observability`.
5. Route mounting (~50 modules under `/api/*`) — see Section 5.
6. SPA fallback: non-`/api` GET → `public/index.html` (hash routing / deep links).
7. Terminal `apiErrorHandler` — sanitized, standardized error envelope (`{ success: false, error }` or legacy `{ error }`).
8. `app.listen(4000, '0.0.0.0')` → `initSyncScheduler()`.

### 3.2 Data layer (`src/db.ts`)

- Opens `better-sqlite3` at `DB_PATH || ./mpgl_app.db` and applies boot PRAGMAs: **`journal_mode = WAL`, `busy_timeout = 10000`, `foreign_keys = ON`**.
- **Single source of truth:** `src/db.ts` DDL is the only schema authority. The Prisma runtime layer (`schema.prisma`, `src/prisma.ts`) was removed on 2026-08-30; all route queries now use the shared `db` connection.
- `initDb()` performs **guarded, non-destructive self-healing migrations**:
  - Legacy-shape detection + drop for stale `AppPriceAlerts` / `catalog_devices` (purely deterministic seed data).
  - `CREATE TABLE IF NOT EXISTS` + additive `ALTER` for the authoritative schema.
  - Idempotent seeding: `seedDeviceCatalog`, `seedBuilderComponents`, `seedPerformanceProfiles`, `seedReviews`, `seedHardwarePriceHistory`, `seedRadar`, `seedCommunityBenchmarks`, `ensureModHubSeed`.
  - Boot-time mod-catalog re-sanitization (`reSanitizeModCatalog`) — soft-quarantines non-whitelisted `Mods.sourceUrl` records.
  - EPIC-04 canonical platform-label normalization with append-only `platform_audit_logs` entries.

### 3.3 Frontend (`public/` — vanilla JS, no framework)

28 modules: `app.js` (SPA hash router, focus trap), `nav.js`, `drawer.js`, `game-detail.js`, `compare.js`, `deals.js`, `wishlist.js`, `analytics.js`, `admin.js`, `hardware.js`, `devices.js`, `reviews.js`, `builder.js`, `performance.js`, `mods.js`, `retro.js`, `discovery.js`, `profile-dashboard.js`, `profile.js`, `settings.js`, `auth.js`, `importer.js`, `legal.js`, `consent.js`, `safes.js`, `storage.js` (IndexedDB `OfflineStorage`), `palette.js`, `sw.js` (Service Worker `mgpl-dashboard-v3` + `mgpl-api-cache-v1`).

## 4. Complete Database Schema

### 4.1 Catalog and content tables

| Model                  | Table                  | Purpose                                                                                                                                                                                    |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppGame`              | `AppGames`             | Canonical game catalog — 107 mapped columns incl. genres, `ROG Ally/Laptop Playability`, min RAM/VRAM, SSD required, Nexus/OpenCritic/Store URLs, `trackedModCount`, `synopsis` (Sprint 7) |
| `AppOwnership`         | `AppOwnership`         | Per-platform ownership — `platformCanonical` (EPIC-04 taxonomy), `Store URL`, price paid, purchase date, edition/format                                                                    |
| `AppTracking`          | `AppTracking`          | Play status, rating (1-10), hours played, tuning notes, trophy progress                                                                                                                    |
| `AppReview`            | `AppReviews`           | Aggregated review metadata (source, score, worth-playing grade, verification)                                                                                                              |
| `AppDLC`               | `AppDLCs`              | DLC catalog + availability/ownership status                                                                                                                                                |
| `AppGameSetting`       | `AppGameSettings`      | Per-game recommended settings & tuning notes (resolution, framerate, VRAM, TDP)                                                                                                            |
| `AppGameFriction`      | `AppGameFriction`      | Save system, session loop, offline/launcher friction, handheld UI legibility                                                                                                               |
| `AppCompletionRoadmap` | `AppCompletionRoadmap` | HLTB main/completionist hours, trophy platinum difficulty, roadmap guide URL                                                                                                               |
| `AppGameGenreMap`      | `AppGameGenreMap`      | Game↔genre many-to-many (10,109 rows)                                                                                                                                                      |
| `AppGenres`            | `AppGenres`            | Genre taxonomy                                                                                                                                                                             |

### 4.2 Playability, backlog & sessions

| Model             | Table                | Purpose                                                                             |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `AppBacklog`      | `AppBacklog`         | Priority-scored backlog (status, `priorityScore`, HLTB hours, `etaDays`) — 980 rows |
| `AppPlaySessions` | `AppPlaySessions`    | Stopwatch session tracking (`sessionUuid`, duration, device, sync flag) — 116 rows  |
| `AppDevice`       | `GameDeviceProfiles` | Device↔game performance tiers — 3,264 rows                                          |
| `InstalledMods`   | `InstalledMods`      | User-installed mods (`UNIQUE(gameId, modId)`) — 4 rows                              |
| `Mods`            | `Mods`               | Global non-PII mod catalog (`UNIQUE(gameId, modName, sourceDomain)` + `is_active`)  |

### 4.3 Identity, auth & multi-tenant state

| Model                | Table                | Purpose                                                                                 |
| -------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `AuthUser`           | `AuthUsers`          | Canonical user (`email`/`gamerTag` unique, `role`, `profileVisibility`)                 |
| `AuthAccount`        | `AuthAccounts`       | OAuth provider links (Google/Steam) with optional locally-encrypted session token       |
| `AppPlatformHandles` | `AppPlatformHandles` | Privacy-minimized public handles per storefront + `hidePlatformIds`                     |
| `AuthPlatformLinks`  | `AuthPlatformLinks`  | AES-256-GCM encrypted token vault (`tokenEnc`/`tokenIv`), `UNIQUE(userId, platform)`    |
| `AppWishlist`        | `AppWishlist`        | Wishlist incl. `bestStoreType` (`Direct Platform`/`Authorized Retailer`), `isTriggered` |
| `AppPriceAlerts`     | `AppPriceAlerts`     | Alert thresholds, `currentPrice`, `historicalLow`, `isTriggered`, `acknowledged`        |
| `AppGameTags`        | `AppGameTags`        | User tags — `UNIQUE(userId, gameId, tagName)`                                           |
| `AppGameNotes`       | `AppGameNotes`       | User markdown notes — `UNIQUE(userId, gameId)`                                          |
| `AppFriendships`     | `AppFriendships`     | Social connections (`UNIQUE(userId, friendId)`, status machine)                         |
| `AppDevices`         | `AppDevices`         | User-scoped device profiles (`desktop`/`laptop`/`handheld`/`console`)                   |

### 4.4 Operational tables

`Devices` (fleet rig telemetry: cpuCores, storageType, storageFreeGb, scanConfidence, deviceClass, thermalCapabilities, lastScanAt) · `catalog_devices` / `catalog_device_specs` · `community_benchmarks` · `compatibility_rules` · `device_builds` · `device_components` · `device_reviews` · `review_votes` · `game_performance_profiles` · `hardware_price_history` · `release_radar` · `ModVersions` · `ModDependencies` · `ModLoadOrder` · `AppDealPriceHistory` · `AppDealsWishlist` · `AppCompletionRoadmapCache` · `analytics_access_logs` (immutable) · `platform_audit_logs` (immutable, append-only) · `AccountLinks` (legacy) · `Users` (legacy, 0 rows).

## 5. Complete API Surface (grouped by mounted prefix)

> All mounts resolved from `src/index.ts` + per-file `router.*` definitions.

**Identity & session (`/api/auth`, `/api/user`, `/api/users`)**
`POST /api/auth/register|login|logout` · `GET /api/auth/me` · `GET /api/auth/oauth/google`, `/oauth/google/callback`, `/openid/steam`, `/openid/steam/callback` · `GET|PATCH /api/user/profile` · `GET /api/user/accounts` · `DELETE /api/user/accounts/:provider` · `GET|PATCH /api/user/platform-handles` · `GET /api/user/u/:gamerTag` · `POST /api/user/password` · `GET|POST /api/users`, `PUT /api/users/:id`, `DELETE /api/users/:id`, `DELETE /api/users/me`.

**Catalog & library (`/api/games`, `/api/library`)**
`GET /api/games`, `/genres`, `/detail`, `/stats/summary`, `/quick-matcher`, `/:gameId`, `/:gameId/nexus-stats` · `PATCH /api/games/:gameId/{tags,notes,tuning,review,rating}` · `PATCH /api/games/dlc/status`, `/batch-status` · `POST /api/games/:id/launch`, `/:gameId/auto-preset` · `GET /api/games/backup/{db,tuning}` · `POST /api/games/backup/restore-tuning`, `/sync/steam`, `/sync/all-stats` · `POST /api/library/import`.

**Sync / enrichment / tracking / quick-match**
`POST /api/sync/{steam,epic,all-stats}` · `POST /api/enrich/hltb` · `GET /api/dlc-audit/*` · `POST /api/tracking/session` · `GET /api/tracking/last-played` · `GET /api/quick-match`.

**Deals / pricing / wishlist / alerts**
`GET /api/deals/{search,historical-low,history/:gameId,by-store,on-sale,releases/this-week,radar,wishlist-drops,dlc-sales}` · `POST /api/deals/wishlist/sync` · `GET|POST /api/deals/arbitrage`, `POST /api/deals/arbitrage/ingest`, `GET /api/deals/arbitrage/:gameId/history` · `GET|POST|DELETE /api/wishlist`, `GET /api/wishlist/{status/:gameId,compare/:gameId,on-sale,search}`, `POST /api/wishlist/refresh-prices` · `GET|POST|DELETE /api/alerts`, `GET /api/alerts/triggered`, `POST /api/alerts/triggered/:id/acknowledge`.

**Hardware / fleet / playability / builder**
`POST /api/scan` · `GET /api/hardware/{explorer,benchmarks,components/search,components/compare,upgrade}` · `POST /api/hardware/compatibility` · `GET /api/hardware/components` · `GET|POST|PATCH|DELETE /api/devices` (fleet) · `PATCH /api/devices/:id/primary` · `POST /api/devices/:deviceId/compatibility/:gameId` · `GET /api/catalog/{devices,devices/:id,compare}` · `GET /api/devices/:id/{pricing,price-history,reviews}` · `POST /api/devices/:id/{alerts,reviews}` · `POST /api/reviews/:id/vote` · `PATCH /api/reviews/:id/editors-pick` · `GET /api/performance/{devices,matrix,compare,recommendations}` · `GET|POST /api/builder/{components,validate,builds,share/:slug}`.

**Mods / retro / community / discovery**
`GET /api/mods/{trending,search,installed,compatibility,aggregation/status,providers,detail,dependencies,conflicts,load-order,listings}` · `POST /api/mods/{installed,ingest}` · `PUT /api/mods/load-order` · `GET /api/retro/{catalog,systems,resources,tracking}` · `POST|DELETE /api/retro/tracking` · `GET /api/protondb/:appId` · `GET /api/hltb/{search,summary}` · `POST /api/hltb/progress` · `POST /api/discovery/{rails,surprise}` · `GET /api/recommender/suggest` · `GET /api/games/recommend`.

**Profile / social / state / observability / platform**
`GET /api/profile/dashboard` · `GET /api/social/{friends,suggestions,requests}` · `POST /api/social/request` · `PATCH /api/social/request/:id` · `DELETE /api/social/friends/:id` · `GET|POST /api/profile-sync/visibility` · `POST /api/profile-sync/sync` · `GET /api/state/export` · `POST /api/state/{import,validate}` · `GET /api/observability/{health,metrics}` · `POST /api/observability/record` · `GET /api/dpm/{health,metrics}` · `GET /api/platforms/{,taxonomy,audit-log,:platform/summary}` · `GET /api/backlog/{summary,velocity}` · `POST /api/backlog/session` · `GET /api/dashboard/summary` · `GET /api/analytics/{summary,sessions,perf}` (role-gated) · `GET /api/giveaways/active` · `POST|DELETE /api/mock/{upstream,breaker/reset,seed,clear}` · `GET /healthz`, `/livez`, `/api/health`.

## 6. Frontend Modules (by responsibility)

| Module                                                                        | Responsibility                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `app.js`                                                                      | SPA hash router (`ROUTES`/`handleRoute`), focus trap (`trapFocus`, WCAG 2.1.2), drawer orchestration |
| `nav.js`                                                                      | Left-rail IA, dropdowns, deep-link navigation (`#/platforms?store=steam`)                            |
| `drawer.js` / `game-detail.js`                                                | Game detail drawer + rendering                                                                       |
| `compare.js`                                                                  | Compare matrix (≤4 games), tile/list dual-mode persistence                                           |
| `deals.js` / `wishlist.js`                                                    | Deals hub, radar, historical-low sparklines, wishlist quick-actions                                  |
| `analytics.js`                                                                | Pure-SVG visualizer — donut, stacked bars, value scorecards, weekly sparklines                       |
| `admin.js`                                                                    | Integration Health Dashboard (`#/observability`), freshness indicator                                |
| `hardware.js` / `devices.js` / `reviews.js` / `builder.js` / `performance.js` | Hardware Explorer 2.0, fleet UI, community reviews, PC builder, perf matrix                          |
| `mods.js` / `retro.js`                                                        | Mods Hub, Retro preservation hub (legal directory + WASM runner)                                     |
| `discovery.js` / `profile-dashboard.js`                                       | Mood rails + Surprise Me, gamer profile/privacy dashboard                                            |
| `consent.js`                                                                  | Granular consent + GPC + Do-Not-Sell/Share (see Section 12)                                          |
| `storage.js` / `sw.js`                                                        | IndexedDB `mgpl_offline_db` cache + Service Worker                                                   |
| `safes.js` / `palette.js`                                                     | XSS-safe helpers, deterministic theme palette                                                        |
| `auth.js` / `settings.js` / `profile.js` / `importer.js` / `legal.js`         | Auth UI, settings, profile, CSV import, legal pages                                                  |

---

## 7. External Integrations & Services

**Platform adapters (`src/services/adapters/`)** — unified registry (`index.ts`): `steam`, `xbox`, `psn` (via `psn-api`), `epic`, `gog`, `ubisoft`. Shared plumbing in `request.ts` (`safeFetchJSONWithBackoff` + per-source `RateLimiter`), `synth.ts` (deterministic synthesis fallback), `types.ts` (`PlatformAdapter` contract, `maskHandle`). `protonDb.ts` — community compatibility tiers with local TTL cache.

**Domain services (`src/services/`)** — `scheduler.ts` (cron orchestration), `dealAggregator.ts` (ITAD/GG.deals/Deku), `dealSync.ts` (CheapShark live sync), `wishlistPricing.ts` (store-type taxonomy + synthesis), `integrationMonitor.ts` (privacy-minimized observability), `modManager.ts`, `modCatalogSanitizer.ts`, `nexusService.ts`, `hardwareExplorer.ts`, `headroom.ts`, `steamSpecs.ts`, `devicePlayability.ts`, `externalMocks.ts`.

**Cron schedule (`scheduler.ts`)** — deals/giveaways 6h · storefront library ingestion daily 03:00 · live price sync 4h · DPM freshness weekly Mon 04:00 · mods aggregation hourly · mod-link sanitization hourly · startup sync +10s. All honor `DISABLE_CRON=true`.

## 8. Deep Dive — Playability / Compatibility Engine

### 8.1 Headroom evaluation core (`src/services/headroom.ts`)

Pure, deterministic, dependency-free multi-axis compatibility math. Key contracts:

- **Inputs:** `DeviceSpecs` (id, name, type, cpuModel/cores, ramGb, gpuModel/vramGb, gpuType, storageType/freeGb, isPortable) and `GameRequirements` (`Min RAM GB`, `Min VRAM GB`, `Storage Size`, `SSD Required?`, optional `Min CPU Cores`).
- **Power profile:** `Plugged-In` vs `Battery Saver`; battery saver applies a **0.75× effective-performance multiplier** to RAM/VRAM/CPU headroom. Only valid for portable devices.
- **Per-axis results:** each of `ram`, `vram`, `storage`, `cpu` returns `{ deviceValue, requiredValue, marginGbOrPct, status, note }` where status ∈ `optimal | playable | bottleneck | unsupported | missing`.
- **Overall rating:** `Optimal | Playable | Bottlenecked | Unsupported | Incomplete Specs` + `primaryBottleneck` (`CPU | RAM | VRAM | Storage`).
- **Completeness gate (DPM-12):** a `null` device value on any read axis produces **`Incomplete Specs`** (blocked state) — never a silent pass. `parseRequirementGb()` tolerates strings like `"70 GB"`.

### 8.2 Tier derivation (`deriveTierRequirements` / `evaluateTieredCompatibility`)

Sprint 5 (EPICUX05) adds **three-tier** evaluation — Minimum / Recommended / Ultra:

| Tier        | RAM                      | VRAM          | Storage       | CPU cores           |
| ----------- | ------------------------ | ------------- | ------------- | ------------------- |
| Minimum     | persisted min            | persisted min | persisted min | persisted (or null) |
| Recommended | 2× min (rounded to even) | 1.5× min      | = min         | max(8, min + 4)     |
| Ultra       | 4× min                   | 2.5× min      | 1.25× min     | max(12, min + 8)    |

Unknown minimums stay `null` → that axis is honestly "not evaluated." Every tier runs through the same single-tier engine so the completeness gate applies uniformly.

### 8.3 PII-free local hardware scan (`src/services/hardwareExplorer.ts`)

- Uses `systeminformation` (`si.system/cpu/mem/graphics/diskLayout/fsSize/battery/cpuTemperature`) via `Promise.all`, **each sensor individually guarded** — one unavailable sensor degrades to `null` instead of failing the scan.
- **Strict extraction:** VRAM is read from the GPU adapter's reported `vram` and **never inferred from the model name**; when unreadable the scan sets `scanConfidence: 'partial'` and `missingFields`, and consumers show a "Missing VRAM / Refresh device scan required" block.
- Device-class derivation: handheld keyword families → handheld; battery-present → laptop; else desktop; `unknown` only on total query failure.
- Hardware-retailer whitelist (`amazon.com`, `bestbuy.com`, `newegg.com`) with `verifiedRetailerLinks()` asserting the HTTPS hostname before any buy link is returned.

### 8.4 DPM resilience & telemetry (`src/services/devicePlayability.ts` + `src/routes/dpm.ts`)

- **Prometheus-compatible counters** (`dpm_requests_total`, `dpm_cache_hits_total`, `dpm_cache_misses_total`, `dpm_degraded_fallback_total`, `dpm_retries_total`, `dpm_errors_total`, `dpm_rejected_total`) + `dpm_health_status` gauge.
- **Bounded retry** (`withDpmRetry`) — retries transient `SQLITE_BUSY` / cold-cache failures before serving the degraded fallback; never throws a 5xx.
- **TTL fallback cache** keyed by normalized device id with LRU eviction; `cacheInvalidate(id)` on device writes.
- **Degraded-state payload** (`buildDpmFallbackPayload`) — specs stay `null` (never fabricated), `usingFallback: true`, `blockedSpecs: true` so the UI renders a blocked "Refresh device scan required" state (Anti-Stale Input Rule, Ch. 22.6).
- **Endpoints:** `GET /api/dpm/health` (sanitized `{ status: "ok", timestamp }` only, 5 req/s) and `GET /api/dpm/metrics` (text/plain, 10 req/5s).

### 8.5 Auth-gated compatibility route (`src/routes/compatibility.ts`)

`POST /api/devices/:deviceId/compatibility/:gameId` — `requireAuth`; device must belong to the caller (`WHERE id = ? AND userId = ?`); game matched case/hyphen-insensitively against `AppGames`; result = device + game + `evaluation`.

### 8.6 Related surfaces

`GameDeviceProfiles` (3,264 rows) + `game_performance_profiles` (17,392 rows) + `community_benchmarks` (45 rows) feed the performance matrix (`/api/performance/*`), the Hardware Explorer benchmark tables, and the compare matrix (`/api/games/compare`, `/api/compare`). `steamSpecs.ts` (Sprint 7) enriches games with Steam-sourced spec data.

## 9. Deep Dive — Mod Manager (`src/services/modManager.ts`, `src/routes/mods.ts`)

### 9.1 Deterministic per-domain manifests

`DOMAIN_MANIFESTS` is a static, hand-curated catalog keyed by normalized game domain (`cyberpunk2077`, `skyrimspecialedition`, …). Each `ManifestMod` carries: `modId`, `modName`, `author`, `category`, `provider` (Nexus Mods | ModDB | CurseForge | GitHub | Modrinth), whitelisted `sourceUrl`, `downloads`, `activeInstalls`, `ratingCount`, `version`, `minVramGb`/`minRamGb`, `summary`, `longDescription`, `files[]` (normalized relative paths), `dependencies[]` (`{ dependsOn, isHard }`), `versionHistory[]`, and `screenshots[]`. Detail pages, dependency trees, and conflict warnings render **instantly with no live external API**.

### 9.2 Security contract (EPICSEC01/02/05)

- Every outbound `sourceUrl` re-runs through `sanitizeModUrl()` before serving (see §11.2 for the exact-match whitelist rules).
- Author handles are masked via `maskModAuthorHandle()` (`a••••z` convention) to minimize public identity exposure.
- Descriptions/changelogs script-injection-stripped via `sanitizeModDescription()` (HTML tags, `on*` handlers, `javascript:/vbscript:/data:` schemes, control chars).
- Error text passes through `safeErrorMessage()`.

### 9.3 Conflict detection (`detectFileConflicts`)

- Analyzes either the supplied `selectedModIds` or, when empty, the active `InstalledMods` set for the domain.
- **File conflicts:** normalized relative paths are intersected pairwise — any overlap = hard file conflict (`modA`/`modB` + shared `filePaths`).
- **Missing hard dependencies:** every `isHard` dependency edge is checked against the analyzed set; a missing dependency is reported as `type: 'missing-dependency'`.
- Deterministic ordering; `conflictCount` = report total.

### 9.4 Dependency trees (`getDependencyTree`)

- Bounded traversal — `MAX_DEPENDENCY_DEPTH = 5`, `MAX_DEPENDENCY_BRANCH = 8` — building a `DependencyNode` tree (`{ modId, modName, isHard, depth, children }`). Guards against cyclic graphs.

### 9.5 Load order (`ModLoadOrder` table)

- `getLoadOrder(db, domain)` reads active rows ordered by `position`; **auto-seeds** via `ensureModHubSeed(db)` when empty.
- `saveLoadOrder(db, domain, orderedModIds)` runs an atomic transaction: deactivates every row for the domain (`isActive = 0`), then upserts the supplied ordered `modIds` with positions `0..n` using `ON CONFLICT(gameDomain, modId) DO UPDATE`. SQLite-backed and registered in `src/routes/state.ts` for snapshot round-trip.

### 9.6 Ingestion pipeline (`POST /api/mods/ingest`)

1. `sanitizeModSourceUrl` middleware validates `sourceUrl` (HTTPS + exact-match domain whitelist + no userinfo/trailing dot + GitHub `/owner/repo/releases/` path constraint) and verifies any supplied `sourceDomain` matches the sanitized URL.
2. `safeCoerce` hydrates the body (malformed payloads → safe fallbacks).
3. `validateModMetadata` enforces the strict metadata schema: `download_count`/`active_installs`/`rating_count` → non-negative integers; `version_tag` → safe slug charset; `author_handle` → **stored masked**; `description` → script-injection-proof.
4. `INSERT ... ON CONFLICT(gameId, modName, sourceDomain) DO UPDATE` upserts, always setting `is_active = 1`.

### 9.7 Boot-time & hourly re-sanitization (`src/services/modCatalogSanitizer.ts`)

`reSanitizeModCatalog(db)` re-validates every persisted `Mods.sourceUrl`; non-compliant records are **soft-quarantined** (`is_active = 0`, never destructive), compliant-but-quarantined records are reactivated, and every mutation is appended to the immutable `platform_audit_logs`. Runs at `initDb()` boot and on an hourly cron; also exposed as `scripts/mod-link-sweep.ts` CLI.

### 9.8 Supporting services

- `nexusService.ts` — Nexus Mods game-domain slug resolution + mod/collection counts (cached to `scripts/.cache/nexus_*.json`; graceful API degradation).
- `src/jobs/mod-aggregation.ts` — hourly aggregation health probe with `GET /api/mods/aggregation/status`.
- `mods.js` frontend — trending/search/installed/compatibility drawers, dependency trees, and load-order drag UI.

## 10. Deep Dive — State Export / Import Round-Trip (`src/routes/state.ts`)

### 10.1 Registered tables (state-persistence contract, Ch. 22.6 / App. D.4)

`TABLE_COLUMNS` registers **25+ tables** for snapshot export/import, each with an explicit allowlist of writable columns (intersected with the live schema at runtime so we never write to a column that does not exist):

`AppDevices` · `catalog_devices` · `catalog_device_specs` · `Devices` · `AppDealsWishlist` · `AppDealPriceHistory` · `AppPriceAlerts` · `InstalledMods` · `Mods` · `ModVersions` · `ModDependencies` · `ModLoadOrder` · `AppCompletionRoadmapCache` · `AppTracking` · `AppGameTags` · `AppGameNotes` · `AppPlatformHandles` · `AuthPlatformLinks` · `AppWishlist` · `AppRetroTracking` · `AppGames` · `AppBacklog` · `AppPlaySessions` · `AppFriendships` · `device_components` · `device_builds` · `compatibility_rules` · `game_performance_profiles` · `device_reviews` · `review_votes` · `hardware_price_history` · `release_radar` · `community_benchmarks`.

**Intentionally excluded** (documented in the module header):

- `platform_audit_logs` — immutable append-only audit table; must never be rewritten by snapshots.
- `analytics_access_logs` — immutable audit.
- `integrationMonitor` telemetry + DPM counters — ephemeral in-memory runtime state, not portable user data.

### 10.2 Export (`GET /api/state/export`)

- Versioned JSON snapshot (`SNAPSHOT_VERSION = 1`).
- **Runtime introspection via `PRAGMA table_info`** for registered tables supports guarded compatibility checks while `src/db.ts` remains the sole schema authority.
- Identifier quoting (`quoteIdent`) prevents injection through column names.
- Optional legacy keys are included only when their columns exist.

### 10.3 Validate (`POST /api/state/validate`)

- Structural validation (must be a JSON object, `version === 1`).
- Confirms every table key maps to a registered `DATA_KEY_TO_TABLE`; unknown keys → descriptive `{ valid: false, errors: [...] }`.
- `OPTIONAL_DATA_KEYS` marks keys added by later features as non-required so **older snapshots restore cleanly** (wishlist, mods, retro, builder, benchmarks, etc.).
- Returns an itemized per-table record-count summary with **zero writes** (dry run).

### 10.4 Import (`POST /api/state/import`)

- **Conflict-key discovery at runtime:** `hasUniqueConstraint(table, columns)` inspects `PRAGMA index_list` + `PRAGMA index_info` to find real UNIQUE/PRIMARY KEY constraints, so `ON CONFLICT(<cols>)` never throws "does not match any PRIMARY KEY or UNIQUE constraint."
- **Upsert semantics (never destructive):** for each table, an INSERT with conflict targets; when a conflicting row exists, only the non-conflict columns are updated. `INSERT OR IGNORE` is used where no unique constraint exists.
- **Atomic restore:** the whole restore runs inside a transaction; invalid rows are skipped individually with sanitized logs (a bad row never aborts the restore).
- **Post-restore verification:** re-counts every restored table and returns authoritative counts (`restored.*Count`), proving the round-trip (no loss, no duplication, uniqueness intact).

### 10.5 Verified via tests

`state-backup.spec.ts`, `state-resilience.spec.ts`, `state-ui-backup.spec.ts`, and `security-regression.spec.ts` (the "25+ table state snapshot round-trip" case) prove export → import → `PRAGMA table_info` + FK integrity checks with zero loss. The predeploy snapshot flow (`scripts/pre-deploy-snapshot.ts`) snapshots both DB and metadata before production deploys.

## 11. Deep Dive — Deals Security Pipeline

### 11.1 Storefront whitelist & grey-market rejection (`src/utils/storefrontValidator.ts`)

- **Exact-match `ALLOWED_STOREFRONT_HOSTS`** (subdomains NOT implicitly trusted): direct platforms `store.steampowered.com`, `gog.com`, `www.gog.com`, `store.epicgames.com`; authorized key retailers `fanatical.com`, `greenmangaming.com`, `humblebundle.com`, `gamesplanet.com`, `gamebillet.com`; giveaway feed `gamerpower.com`.
- **`GREY_MARKET_DOMAINS`** matched by suffix (subdomains + locale variants caught): `g2a.com`, `kinguin.net`, `eneba.com`, `cdkeys.com`, `gamivo.com`.
- `isWhitelistedUrl(url)` = not grey-market → HTTPS → hostname in exact allowlist. `canonicalStoreName()` normalizes aliases (CheapShark storeID labels, ITAD shop names); `storeUrlForWhitelistedStore()` rebuilds **direct canonical store search URLs** so the API never exposes a third-party redirect host.
- `ALLOWED_STORE_NAMES` gates store display names; unknown stores are rejected at parse time.

### 11.2 Deal/giveaway schema validation (`src/utils/dealSchema.ts`)

- `sanitizePrice()` — finite, bounds `[0.00, 999.99]`, rounded to cents (float-noise-free, stable DB values). `sanitizeDiscount()` — finite, `[0, 100]`.
- `parseDealRecord()` — requires title + whitelisted store + in-bounds price; **strips unknown/extraneous payload keys** (explicit allowlist copy); returns `null` (rejected) for any violation.
- `parseGiveawayRecord()` — always free (`price 0`, `discount 100`); the claim URL **must** pass grey-market + whitelist gates; freeform `platforms` display text is never treated as an outbound link.
- `parseDealFeed()` drops rejections silently so one poisoned record never blocks a feed.

### 11.3 Circuit breaker + stale-while-revalidate (`src/utils/storefrontCircuitBreaker.ts`)

Per-storefront state machine:

- **CLOSED** → requests flow until `FAILURE_THRESHOLD` consecutive failures (default 5, env-configurable).
- **OPEN** → requests short-circuit for `RESET_MS` (default 60s); callers are served the **cached last-good snapshot** (stale-but-valid, re-validated through the schema before serving).
- **HALF_OPEN** → one probe after the reset window; success → CLOSED, failure → re-OPEN.
- **Exponential per-storefront backoff** (`BACKOFF_BASE_MS`, capped at `MAX_BACKOFF_MS`).
- Singleton `circuitBreaker` registry + `primeSnapshot`/`resetAll` helpers for deterministic E2E.

### 11.4 Live price sync (`src/services/dealSync.ts`)

- `CHEAPSHARK_STORE_MAP` maps CheapShark storeIDs (1–50) to canonical MGPL store names.
- Rate limiter: **1 upstream call per 1.2s**; bounded 6s axios timeout; `no-cache` headers.
- `syncLiveStorePrices()` fetches live deals, buckets by normalized title, and for every wishlist row (user-scoped) resolves `currentBestPrice` / `bestStore` / `bestStoreType` / `historicalLow`, computing `isTriggered = (target > 0 && currentBestPrice <= target) ? 1 : 0`.
- **Resilient fallback:** if the upstream is unreachable, deterministic synthesis (`bestPriceFor` from `wishlistPricing.ts`) is reused — never duplicated — so tables always converge.
- Writes are multi-tenant scoped (`WHERE userId = ? AND gameId = ?`), using `ON CONFLICT(userId, gameId) DO UPDATE` with `COALESCE` guards so a sync can never clobber existing `currentPrice`/`historicalLow` with nulls.

### 11.5 Store-type taxonomy (`src/services/wishlistPricing.ts`)

`DIRECT_STORES = [Steam, GOG, Epic, PlayStation, Xbox]`; `KEY_RETAILERS = [Fanatical, Green Man Gaming, Gamesplanet, GameBillet, Humble Store]`. `storeTypeFor()` → `'Direct Platform' | 'Authorized Retailer'`, persisted on `AppWishlist.bestStoreType` and surfaced on every recommendation (Ch. 24).

### 11.6 Arbitrage aggregation (`src/services/dealAggregator.ts` + `src/routes/dealArbitrage.ts`)

`ingestAllDeals()` runs ITAD / GG.deals / Deku Deals through `Promise.allSettled` (one source failing never aborts the others), dedupes, validates every record through `dealSchema`, records price-history baseline points (`AppDealPriceHistory`), seeds history baselines, and refreshes wishlist/alert trigger state. `getArbitrageFeed()` serves the latest rows enriched with 30-day low, verified all-time low, and the 24-month sparkline series. All endpoints are rate-limited and sanitized.

### 11.7 Giveaway phishing defense

`parseGiveawayRecord` rejects grey-market / non-HTTPS / non-whitelisted claim URLs; only verified GamerPower HTTPS links are surfaced as claimable freebies. See `DOCS/threat-matrix-deals.md` for the full threat→mitigation→enforcement matrix.

## 12. Security & Privacy Posture

### 12.1 Authentication & sessions

- **Argon2id** hashing (`memoryCost 19456`/19 MiB, `timeCost 2`, `parallelism 1`); plaintext storage strictly forbidden.
- Stateless **HS256 JWT** (7-day), issued as `mgpl_session` cookie — `httpOnly`, `SameSite=Strict`, `Secure` in production — shared by native, Google OAuth, and Steam OpenID login paths (`src/lib/auth.ts`).
- Middleware: `requireAuth` (401), `optionalAuth` (guest no-op), `requireRole(...)` — server-side role gate for analytics with **immutable `analytics_access_logs`** on every denial.

### 12.2 Privacy-minimized identity boundaries

- `Users` = 0 rows; only `AuthUsers` (3) holds hashed credentials.
- Steam adapter pulls **only public `SteamID64` + numeric playtime/achievements**; platform tokens **AES-256-GCM encrypted at rest** (`tokenCipher.ts`, fail-closed when `MGPL_TOKEN_ENC_KEY` unset).
- Mod author handles and platform handles **masked** before persistence/serving.
- `integrationMonitor` + DPM telemetry emit only static keys / integer counters — never payloads, tokens, or raw errors.
- `errorSanitizer` (`sendApiError`/`apiErrorHandler`) guarantees no stack/path/secret leakage in any client response.

### 12.3 Auto opt-outs & consent (`public/consent.js`)

- Granular consent (`mgpl_consent_settings`): **Strictly Necessary** (locked) / **Functional** / **Analytics & Telemetry**.
- **Default = opt-out**: non-essential categories default `false`; only "Accept All" opts in.
- **Global Privacy Control**: `navigator.globalPrivacyControl === true` forces analytics OFF, suppresses the banner entirely ("GPC is the signal"), and persists `gpcActive`.
- CCPA/CPRA **Do-Not-Sell/Share** (`mgpl_dns`) with Account Settings privacy tab + `mgpl:privacy-changed` events.

### 12.4 Transport & headers

Helmet CSP/HSTS (1yr, subdomains, preload)/frameguard-deny/noSniff + Caddy HSTS/X-Frame-Options/nosniff/Referrer-Policy + Server-banner strip. Rate limits at global, sync, DPM, and observability layers.

---

## 13. Testing & Quality Harness (DoD)

- **79 Playwright specs** in `test/e2e/` (verified count) across auth, library, deals/security, devices/hardware/fleet, mods, retro, social, privacy-consent, accessibility, PWA/offline, state round-trip, and sprint regressions.
- `playwright.config.ts`: `testDir: ./test/e2e`, **`workers: 1`** (mandatory serial for shared-SQLite isolation), `fullyParallel: false`, 30s timeout, `retain-on-failure` traces; `globalSetup` seeds fresh `./data/test_mgpl.db`.
- **Hermetic externals:** `externalMocks.ts` installs a deterministic axios adapter (test mode only) with canary records (grey-market store/URL, negative & overflow prices) + mutable upstream-failure overrides.
- **DoD gates (`package.json` + `gates/`):**
  1. CSpell dictionary governance (`cspell.json`)
  2. `npx tsc --noEmit`
  3. `node -c public/*.js` (all 26 client scripts)
  4. `npx playwright test` — Sprint 6 recorded **392 passed / 0 failed**
  5. Automated git commit + push on green
- **Gate scripts (`gates/`):** `q1–q5` (lint/test/coverage/bundle/types), `s1–s4` (SAST/dep-audit/secret-scan/transport), `quality.sh`, `security.sh`, `run-all.sh`.
- **Axe WCAG 2.1 AA:** 5 surfaces scanned, zero critical/serious (color-contrast excluded by documented convention). **P90 performance:** multi-genre facet, pagination, compare render all ≤ 2s.

## 14. Deployment & Infrastructure

### 14.1 Container orchestration

- **`Dockerfile`** — multi-stage `node:22-alpine`; `tsc` build; production runner installs `curl`/`wget` for health probes, runs as non-root `USER node`, `HEALTHCHECK` against `/healthz`.
- **`docker-compose.yml`** — single production service `mgpl-app` (port 4000, `./data:/app/data`, `RATE_LIMIT_MAX=300`).
- **`docker-compose.staging.yml`** — three services on the Hetzner staging node:
  - `app` (`mgpl-staging`, `NODE_ENV=staging`, `DB_PATH=/data/mgpl-staging.db`, `DISABLE_CRON=true`)
  - `litestream` — continuous SQLite WAL replication sidecar (shares `/data`)
  - `caddy` — internal reverse proxy on `:2080`

### 14.2 Litestream replication (`litestream.yml`)

- Primary: **Cloudflare R2** (`mgpl-db-replica`, 1s sync, 168h retention).
- Secondary: **Backblaze B2** (`mgpl-db-backup`, 30s sync, 168h retention).
- `snapshot-interval: 24h`; requires `journal_mode=WAL` (applied on every boot).
- Post-restore integrity validated by `scripts/vcm-integrity-check.sh` (`PRAGMA integrity_check`, `foreign_key_check`, 13 authoritative tables).

### 14.3 Reverse proxy & ingress

- **`Caddyfile`** — `auto_https off` (TLS at Cloudflare), security headers, JSON access logs; routes `staging.mgpl.io` / `mgpl.io` (and catch-all) → `app:4000`.
- **`cloudflared/`** — Cloudflare Tunnel mapping both hostnames to `http://localhost:2080`.

### 14.4 CI/CD (`deploy-staging.yml`)

Triggers on push/merge to `develop`; three sequential jobs: **lint-test** (npm ci, tsc, client syntax, cspell) → **build-push** (multi-stage Docker build → GHCR, SHA + `staging` tags) → **deploy** (Tailscale ephemeral auth → SSH to Hetzner → `docker compose up -d --no-deps app` → `/healthz` retry loop).

### 14.5 Secrets

Doppler runtime injection (`doppler secrets download --format docker --no-file > .env.doppler`); secrets mounted read-only into `app` + `litestream` services. `.env*` is in the off-limits zone per `FILEMAP.md`.

---

## 15. Sprint / Feature Delivery History

| Sprint   | Deliverables                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1A / 1B  | Unified ingestion validation, backend error sanitization (EPICSEC04), domain whitelist governance, DPM observability (EPICSEC06)                |
| 2        | Multi-tenant state (tags/notes/wishlist/alerts), cross-platform profile sync (AES-256 token vault), deal arbitrage, ProtonDB, mods hardening    |
| 3        | Left-rail IA, discovery rails + Surprise Me, gamer profile & privacy, OAuth 2.0 (Google) + OpenID 2.0 (Steam)                                   |
| 4        | Mods Hub 2.0 (detail pages, conflicts, load order), dual-mode tile view, compare cluster, wishlist quick-actions                                |
| 5        | Hardware Explorer 2.0 (PII-free scan, tiered compatibility, upgrade advisor, component compare), role-gated analytics, mods whitelist ingestion |
| 6        | Integration Health Dashboard, freshness headers (`X-Data-As-Of`), security regression suite, WCAG 2.1 AA audit, UAT GO (315 E2E)                |
| 6.1      | Hardened remediation patch (GAP-001..006)                                                                                                       |
| 7        | Break-fixes across library/DPM/compare/mods/retro + Steam spec enrichment (`steamSpecs.ts`) + retro emulator resource hub                       |
| WUD-28.6 | Docker volume convergence — root `mpgl_app.db` authoritative; zero data loss, auditable dump                                                    |

**UAT sign-off:** `DOCS/UAT-GO-NOGO.md` — GO with all DoD gates at zero failures (CSpell 0, tsc 0, client JS 0, E2E 315 passed).

## 16. Current Data State (live-verified 2026-08-30)

`AppGames` 1,087 · `AppOwnership` 1,238 · `AppTracking` 980 · `AppBacklog` 980 · `AppPlaySessions` 116 · `AppGameGenreMap` 10,109 · `GameDeviceProfiles` 3,264 · `game_performance_profiles` 17,392 · `hardware_price_history` 2,340 · `Devices` 13 · `AuthUsers` 3 · `InstalledMods` 4 · `AppPriceAlerts` 12 · `AppGameTags` 6 · `AppGameNotes` 4 · `AppWishlist` 1 · `catalog_devices` 58 · `community_benchmarks` 45 · `release_radar` 16 · **privacy-minimized social/device tables** (`Users`, `AppFriendships`, `AppDevices`, `AppRetroTracking`) = **0**.

`PRAGMA journal_mode` = **wal** · `PRAGMA integrity_check` = **ok** · `PRAGMA foreign_key_check` = **0 violations** (per WUD-28.6 audit Addendum A.4).

---

## 17. Known Observations & Gaps

1. **Retro preservation** is fully scaffolded (routes + `retro.js` + WASM runner contract + emulator resource whitelist) but `AppRetroTracking` has **0 rows** in the live DB — no persisted tracking activity.
2. **Social graph** (`AppFriendships`, `social.ts`) is implemented but empty (0 rows) — no active friendships yet.
3. **`Mods` global catalog** = 0 rows (4 mods live in `InstalledMods`); deterministic manifests power detail views, but catalog ingestion has not been populated in the current snapshot.
4. **Data layer is now single-source** — Prisma runtime was removed (2026-08-30); `src/db.ts` DDL is the sole schema authority, eliminating DDL/ORM drift (see `DOCS/SPRINT_REFERENCE_MAP.md` for the sprint convention).
5. **`README.md` is UTF-16 encoded** (renders as mojibake in UTF-8 tooling) — cosmetic; worth re-encoding to UTF-8.
6. **`Mods` table name case-sensitivity** — SQLite table names are case-insensitive; the lowercase `mods`/`devices` naming rules in `db.ts` exist to avoid colliding with legacy tables (`Devices`).
7. `AppWishlist` shows a single row — active wishlist/alert population is minimal in the current snapshot (12 alerts, 1 wishlist item).

---

## Appendix A — Route Module Inventory (50 files in `src/routes/`)

`alerts` · `analytics` · `auth` · `backlog` · `builder` · `compare` · `compatibility` · `dashboard` · `dealArbitrage` · `deals` · `deviceCatalog` · `devicePricing` · `deviceReviews` · `devices` · `discovery` · `dlcAudit` · `dpm` · `enrich` · `fleet` · `games` · `giveaways` · `hardware` · `hardwareExplorer` · `health` · `hltb` · `library` · `mock` · `mods` · `notes` · `oauth` · `observability` · `performance` · `platforms` · `profileDashboard` · `profileSync` · `protonDb` · `quickMatch` · `recommend` · `recommender` · `retro` · `social` · `state` · `sync` · `tags` · `tracking` · `user` · `users` · `wishlist`

## Appendix B — Verifiable Source References

| Concern                                            | Reference                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server bootstrap, middleware, route mounts         | `src/index.ts`                                                                                                                                                 |
| Authoritative DDL, WAL PRAGMAs, self-heal, seeding | `src/db.ts`                                                                                                                                                    |
| Session auth / JWT / Argon2id                      | `src/lib/auth.ts`, `src/middleware/auth.ts`                                                                                                                    |
| AES-256-GCM token vault                            | `src/lib/tokenCipher.ts`                                                                                                                                       |
| Canonical platform taxonomy                        | `src/lib/platformTaxonomy.ts`                                                                                                                                  |
| Playability engine                                 | `src/services/headroom.ts`, `hardwareExplorer.ts`, `devicePlayability.ts`, `src/routes/compatibility.ts`, `dpm.ts`                                             |
| Mods ecosystem                                     | `src/services/modManager.ts`, `modCatalogSanitizer.ts`, `nexusService.ts`, `src/routes/mods.ts`, `src/middleware/modUrlSanitizer.ts`, `src/utils/modSchema.ts` |
| State round-trip                                   | `src/routes/state.ts`                                                                                                                                          |
| Deals security                                     | `src/utils/dealSchema.ts`, `storefrontValidator.ts`, `storefrontCircuitBreaker.ts`, `src/services/dealSync.ts`, `dealAggregator.ts`, `wishlistPricing.ts`      |
| Observability                                      | `src/services/integrationMonitor.ts`, `src/routes/observability.ts`, `src/middleware/fallbackRenderer.ts`                                                      |
| Consent & privacy                                  | `public/consent.js`, `public/settings.js`, `test/e2e/privacy-consent.spec.ts`                                                                                  |
| Scheduler                                          | `src/services/scheduler.ts`, `src/jobs/mod-aggregation.ts`                                                                                                     |
| Test harness                                       | `playwright.config.ts`, `test/global-setup.ts`, `test/fixtures.ts`, `test/e2e/*` (81 specs / 407 tests), `src/services/externalMocks.ts`                       |
| Deployment                                         | `Dockerfile`, `docker-compose*.yml`, `litestream.yml`, `Caddyfile`, `cloudflared/`, `.github/workflows/deploy-staging.yml`, `DEPLOYMENT.md`                    |
| Governance                                         | `.clinerules/*`, `DOCS/*`, `.ai/CHANGELOG.md`, `cspell.json`                                                                                                   |

---

_End of Current State of System Brief. Verified against `main` (HEAD `5b48d2c`) and the live `mpgl_app.db` (WAL mode, 49 tables)._
