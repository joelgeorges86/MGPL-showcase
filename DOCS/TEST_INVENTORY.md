# MGPL — Test Inventory & Sprint Approval Gate Reference

**Repository:** `joelgeorges86/MGPL`
**Purpose:** Single source of truth enumerating (1) every test/check required before a Sprint/feature is approved, and (2) the complete Playwright E2E inventory (81 spec files / **407 test cases**) with the reasoning behind every suite — plus the Vitest unit layer and a gap analysis of additional coverage worth considering.

> Compiled from a live source scan of `test/e2e`, `test/unit`, `package.json`, `.clinerules/04-definition-of-done.md`, `gates/`, `.github/workflows/deploy-staging.yml`, and `DOCS/UAT-GO-NOGO.md`.

---

## 1. Tests & checks required before Sprint approval

The authoritative contract is `.clinerules/04-definition-of-done.md` (DoD), reinforced by `DOCS/UAT-GO-NOGO.md`. A Sprint/feature may only be declared complete/approvable when **every** item below passes with **zero errors**.

### 1.1 DoD hard gates (mandatory, zero-error)

| #   | Gate                         | Command                                                                                         | Purpose                                                                                                                                                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CSpell dictionary governance | `npm run test:spell` (`cspell lint "src/**/*.ts" "public/*.js" "test/**/*.ts"`)                 | Every identifier spelled correctly and every new technical/storefront/third-party term registered in `cspell.json` before gate execution.               |
| 2   | TypeScript verification      | `npx tsc --noEmit` (alias `npm run test:types`)                                                 | Full type-safety check of server (`src/`) and test layer.                                                                                               |
| 3   | Client JS syntax             | `npm run test:client` (`node scripts/check-client-syntax.js`)                                   | `node --check` on every `public/*.js` (glob-based so the gate cannot drift from the filesystem); catches parsing regressions before browser automation. |
| 4   | Playwright E2E suite         | `doppler run -- npx playwright test --workers=1`                                                | Full end-to-end regression — 81 specs / 407 recorded tests, serialized on one worker against the seeded `./data/test_mgpl.db`.                          |
| 5   | Feature integration          | Commit on `feature/*` → open a pull request to `develop` → merge only after gates 1–4 are green | Promotion from `develop` to `main` remains a Principal Operator action.                                                                                 |

DoD policy additionally requires: **any new UI component or user flow must ship a corresponding Playwright spec** (or a test case in an existing spec) verified passing before task sign-off.

### 1.2 Supporting test/validation scripts (`package.json`)

| Script               | Command                                         | Purpose                                                                                                                                |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test:unit`          | `vitest run`                                    | 10 pure-logic unit suites (no SQLite/network) — catches pure-function regressions in <1s.                                              |
| `test:benchmark`     | `ts-node scripts/test-runner.ts`                | Discovers every E2E spec, runs each serially, prints per-suite status / tests / assertions / duration / memory-delta table.            |
| `smoke:postdeploy`   | `ts-node scripts/smoke-test-post-deployment.ts` | Post-deploy probe of the live API surface (health, DPM health, mods, compare, state export, retro); exits non-zero to block promotion. |
| `validate:flags`     | `ts-node scripts/validate-feature-flags.ts`     | Asserts every required env/file feature flag is present before promotion (release-gate guard).                                         |
| `snapshot:predeploy` | `ts-node scripts/pre-deploy-snapshot.ts`        | Writes the authoritative state snapshot + `.meta.json` to `backups/` before a release so a broken rollout can be rolled back.          |

### 1.3 Security (S1–S4) & Quality (Q1–Q5) gates (`gates/`)

Orchestrated by `gates/run-all.sh` → `gates/security.sh` + `gates/quality.sh`.

| Gate | Script              | Intended check                      | Current state                                                                                                                                                                          |
| ---- | ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `s1-sast.sh`        | Static application security testing | ✅ Real — `node scripts/gate-sast.js` (eval/shell-exec/secret-pattern scan of `src/` + `public/`; 3 shell-exec sites hardened to `execFile`/`spawn`)                                   |
| S2   | `s2-dep-audit.sh`   | Dependency audit                    | ✅ Real — `npm audit --audit-level=high` (fails on high/critical findings; baseline 0 vulns)                                                                                           |
| S3   | `s3-secret-scan.sh` | Secret scanning                     | ✅ Real — `node scripts/gate-secret-scan.js` (git-tracked-file secret-pattern scan with documented allowlist)                                                                          |
| S4   | `s4-transport.sh`   | Transport security (HSTS/TLS)       | ✅ Real — `node scripts/gate-transport.js` (helmet HSTS/CSP/frameguard/noSniff + Secure cookie + Caddy HSTS)                                                                           |
| Q1   | `q1-lint.sh`        | Lint and runner consistency         | ✅ Real — `node scripts/gate-lint.js`, `node scripts/check-gate-runner-consistency.js`, ESLint, and Prettier; fails if Playwright ownership drifts between local, shell, or CI runners |
| Q2   | `q2-test.sh`        | Test execution                      | ✅ Real — `npm run test:unit` (Vitest, 61 tests)                                                                                                                                       |
| Q3   | `q3-coverage.sh`    | Code coverage                       | ✅ Real — `npm run test:coverage` (Vitest v8 provider; thresholds 55/50/45/55)                                                                                                         |
| Q4   | `q4-bundle.sh`      | Bundle size                         | ✅ Real — `node scripts/gate-bundle.js` (public 1.5 MB / dist 5 MB budgets)                                                                                                            |
| Q5   | `q5-types.sh`       | Type check                          | ✅ Real (`npx tsc --noEmit`)                                                                                                                                                           |

### 1.4 CI pipeline (`.github/workflows/deploy-staging.yml`)

Push to `develop` → **lint-test**: `npm ci`, `npx tsc --noEmit`, `npm run test:client`, `npm run test:spell`, `npm run test:unit`, then the master gate suite `bash gates/run-all.sh` (S1–S4 security + Q1–Q5 quality; no Playwright). → **test-e2e** (needs lint-test): installs Chromium and runs the full Playwright suite exactly once (`npm run test:e2e`, serialized on the seeded test DB; traces uploaded on failure). → **build-push** (gated on lint-test **and** test-e2e) pushes the GHCR image. → **deploy** joins the Tailnet and polls `/healthz` until HTTP 200.

### 1.5 State-persistence contract (DoD / `08-state-persistence`)

Any new SQLite persistence table must be registered in `src/routes/state.ts`, then verified via `PRAGMA table_info(<table>)` and `PRAGMA foreign_key_check`. Post-restore integrity is validated by `scripts/vcm-integrity-check.sh` (`PRAGMA integrity_check` = ok, FK check = 0 violations, 13 authoritative tables present). E2E proof: `state-backup.spec.ts`, `state-resilience.spec.ts`, `state-ui-backup.spec.ts`, `security-regression.spec.ts` (25+ table round-trip).
---

## 2. Playwright E2E suite — complete inventory with reasoning

**81 spec files · 407 test cases.** All specs run against the deterministically seeded `./data/test_mgpl.db` (see `test/global-setup.ts`), single worker (`playwright.config.ts`), with external storefront APIs and asset hosts mocked (`test/fixtures.ts`).

### 2.1 Authentication, Identity & Profile (8 specs)

#### `auth-core.spec.ts` — Auth core (5 tests)

**Why:** Proves the server-side session contract end-to-end — the foundation every protected route and multi-tenant test builds on.

1. registration issues an httpOnly mgpl_session cookie and returns the public user
2. seeded user can log in and retrieve their session via /me
3. invalid credentials return 401 with a generic error (no user enumeration)
4. unauthenticated /me returns 401
5. logout clears the session and subsequent /me returns 401

#### `auth-ui.spec.ts` — Auth UI (4 tests)

**Why:** Verifies the login/signup modal flow the user actually sees and that the header reflects auth state.

1. Log In button opens the modal, tabs switch, and Escape closes it
2. native login via modal closes it and updates the header with the user email
3. failed login shows an inline error banner and keeps the modal open
4. logout clears the session and restores the Log In button

#### `oauth.spec.ts` — Third-party authentication (3 tests)

**Why:** Google OAuth 2.0 and Steam OpenID are external identity paths; tests use deterministic fixtures to prove account creation/linking without live providers.

1. mock Google OAuth registers mock.user@example.com and issues a valid mgpl_session cookie
2. mock Steam OpenID logs in Steam ID 76561198000000001 and retrieves the session via /me
3. linking Steam account to an existing user session attaches AuthAccount under the same userId

#### `profile-security.spec.ts` — Profile & Password Security (4 tests)

**Why:** PII hygiene, reserved-handle conflict resolution, and password-change semantics protect account integrity.

1. Seeded user retrieves a private, PII-free profile and publishes it
2. Claiming a taken gamerTag returns 409 Conflict
3. Password change verifies the current password, then invalidates the old one
4. Unauthenticated calls to /api/user/* return 401

#### `profile-accounts.spec.ts` — Storefront identity hub & platform usernames (4 tests)

**Why:** Unlinking provider accounts has edge cases (last-provider lockout) that must be guarded.

1. User with a local password unlinks a linked provider
2. OAuth-only user cannot unlink their only provider (400)
3. Public profile returns only approved platform handles under the privacy-minimized identity policy
4. Private profile returns 404 on public lookup

#### `profile-social.spec.ts` — Zero-PII social connections (4 tests)

**Why:** Friend-request lifecycle, privacy-aware suggestions, and correct teardown of social edges.

1. Friend request via @gamerTag, accept, and mutual friendship
2. Shared platform handle surfaces public users in suggestions
3. Private profiles disappear from suggestions
4. Unfriending removes the connection from both friend lists

#### `profile-sync.spec.ts` — Unified Cross-Platform Profile Sync (4 tests)

**Why:** Proves encrypted token-at-rest (AES-256-GCM), adapter-based sync persisting into AppTracking, and UI state reflecting the linked/connected account.

1. Connect stores an encrypted token at rest and returns a masked handle
2. Sync runs the Steam adapter and persists playtime into AppTracking
3. UI: Connect Steam -> state updates to Connected with masked handle
4. Hide Platform IDs masks handles across public profile views

#### `profile-ui.spec.ts` — Settings Drawer, Profile Customizer & Social Hub (4 tests)

**Why:** Settings is a dense surface; verifies tab switching, persistence of visibility/handle changes, and social management via the UI.

1. Open Settings drawer, switch tabs, close via Escape
2. Update @gamerTag + visibility public via UI, header reflects and persists
3. Save platform handles via UI form and see success banner
4. Accept an incoming friend request in Social tab and verify it moves to friends

### 2.2 Security, Privacy & Legal (9 specs)

#### `security-regression.spec.ts` — Sprint 6 Platform-Wide Security Regression (11 tests)

**Why:** Consolidated release-gate invariants: observability must be sanitized Zero-PII, metrics emit only static names, all module responses carry freshness headers, and no env/path/secret can leak.

1. /api/observability/health is a sanitized Zero-PII payload
2. /api/observability/metrics emits only static metric names + integers
3. Module responses carry the 'Data as of' freshness header
4. Observability record endpoint validates exact-match and never echoes input
5. Mod URL sanitization rejects non-https and non-whitelisted schemes
6. External deal links strictly adhere to the HTTPS domain whitelist
7. Error responses are sanitized (no stack traces, paths, or secrets)
8. Palette CSS custom-property values self-heal through the strict sanitizer
9. Ingestion validation hydrates malformed payloads to typed fallbacks
10. No env vars or internal paths leak across representative endpoints
11. State snapshot export covers the full persistence surface (25+ tables)

#### `sprint-1b-whitelist-dpm.spec.ts` — Domain Whitelist Governance & DPM Observability (13 tests)

**Why:** EPICSEC02/06: mod-link ingestion must reject host spoofing (subdomain, userinfo, trailing-dot), GitHub stays releases-only, and Device Playability Matrix must degrade gracefully and stay observable.

1. Ingest rejects subdomain-spoofed hosts, even with query obfuscation
2. Ingest rejects userinfo/credential spoofing
3. Ingest rejects trailing-dot hostnames and does not trust query strings
4. Ingest accepts whitelisted hosts with query params and www normalization
5. GitHub stays releases-only (repo pages rejected, releases accepted)
6. Unknown domains produce sanitized 400 errors
7. Ingestion-time re-sanitization purges stale non-whitelisted records
8. /api/dpm/health returns a sanitized payload
9. /api/dpm/metrics exposes Prometheus-compatible DPM telemetry
10. Playability serves a degraded-state fallback without 5xx when scans are missing
11. Playability TTL cache hit/miss is observable in telemetry
12. Playability enforces strict input validation (overlong deviceId → 400)
13. /api/devices/:id/playable-games serves a graceful fallback and rate-limit headers

#### `ingestion-sanitization.spec.ts` — Unified Ingestion Validation & Error Sanitization (8 tests)

**Why:** EPICSEC04/EPICSEC01: every ingestion path must hydrate malformed payloads to safe fallbacks and sanitize errors so stack traces, paths, and secrets never reach the client.

1. safeToastError redacts stack traces, internal paths and secrets
2. safeArray / safeHydrate resolve malformed ingestion payloads to fallbacks
3. Mods ingest rejects non-whitelisted schemes with a sanitized 400
4. Mods ingest redacts caller-supplied paths and secrets in error echoes
5. Terminal error handler sanitizes body-parser failures (no stack traces)
6. Retro tracking ingestion hydrates malformed payloads and rejects missing fields
7. Deals feed always returns an array (unified fallback)
8. Compare benchmark ingestion still accepts valid payloads after safeCoerce migration

#### `deals-security.spec.ts` — Deals Ingestion Security (4 tests)

**Why:** EPIC-DEAL-001: deal feeds are external input — unwhitelisted sellers, absurd prices, and upstream failures must be handled safely with a circuit breaker.

1. ingestion rejects unwhitelisted and grey-market seller URLs
2. ingestion drops records with out-of-bounds prices
3. circuit breaker trips cleanly to cached fallback on upstream 500s
4. external deal links strictly adhere to the HTTPS domain whitelist

#### `legal-compliance.spec.ts` — Deal Transparency & Legal Compliance (3 tests)

**Why:** EPIC-COMPLIANCE-0001: store links must disclose affiliate relationships, show the 30-day price baseline, and legal footer links must be accessible modals.

1. Affiliate disclosure badges render visibly adjacent to store redirect links
2. 30-day baseline price tooltip renders on discounted deal cards
3. Footer legal links open accessible modals and trap focus correctly

#### `privacy-consent.spec.ts` — Privacy, GPC & Consent (4 tests)

**Why:** EPIC-COMPLIANCE-0001 Sprint 2: consent banner behavior, Global Privacy Control auto-opt-out, and data-export must work for regulatory compliance.

1. Consent banner renders on fresh visit; Reject Non-Essential stores strict-only flags
2. GPC flag detection enforces automatic opt-out
3. Export My Data initiates a valid JSON payload download
4. Reopening consent manager from footer updates stored preferences

#### `data-isolation.spec.ts` — Multi-Tenant Data Isolation (4 tests)

**Why:** FEAT-MULTITENANT: user-scoped records (wishlist, tags, notes, alerts) must be invisible and immutable across tenants, and protected endpoints require auth.

1. Alex creates a wishlist item and a note visible in her own session
2. Jordan cannot see Alex's wishlist item or note
3. Jordan cannot mutate or delete Alex's wishlist/tag/note records (404/403)
4. Unauthenticated requests to protected state endpoints return 401

#### `rate-limiting.spec.ts` — API Rate Limiting (3 tests)

**Why:** Gap-4 regression: the global limiter is raised to 100000 in test mode, so this spec deterministically trips the fixed low-window per-endpoint limiters (`/api/dpm/health` 5/s, `/api/dpm/metrics` 10/5s, `/api/observability/health` 5/s) and asserts the full 429 contract: sanitized JSON body (`status`/`message` only), `Retry-After` header, quota respected, and automatic recovery after the window elapses.

1. DPM health limiter (5/sec) returns sanitized 429 + Retry-After, then recovers
2. DPM metrics limiter (10/5s) returns 429 + Retry-After, then recovers
3. Observability health limiter (5/sec) returns sanitized 429, then recovers

#### `sprint2-ecosystem.spec.ts` — ProtonDB Ingestion & Mods Security Hardening (4 tests)

**Why:** WUD-2.3: ProtonDB tiers must be surfaced without identity leakage, and mod ingestion must enforce schema + script-injection sanitization.

1. GET /api/protondb/:appId returns tier + normalized score, no identity
2. Mod ingest enforces strict schema + script-injection sanitization
3. Mod listings expose sanitized descriptions + compat tags, never raw handles
4. UI: game detail drawer renders the ProtonDB badge beside hardware indicators

### 2.3 Accessibility & Keyboard Navigation (3 specs)

#### `accessibility-nav.spec.ts` — Accessible Navigation & Focus Management (4 tests)

**Why:** EPIC-COMPLIANCE-0001 Sprint 1: WCAG 2.1.2/2.4.3 keyboard operability — skip links, focus trapping, Escape-to-close with focus restore, and aria-labels on icon-only controls.

1. Skip link becomes visible on keyboard focus and shifts focus to #main-content
2. Opening the game detail drawer moves focus inside and traps Tab navigation
3. Pressing Escape closes the drawer and returns focus to the triggering element
4. All icon-only interactive elements supply an accessible aria-label

#### `accessibility-audit.spec.ts` — Automated Axe Accessibility Audit (4 tests)

**Why:** EPIC-COMPLIANCE-0001 Sprint 3: automated axe-core scans prove zero critical/serious violations on the highest-traffic surfaces (color-contrast excluded by documented suite convention).

1. Library catalog discovery grid & navigation header have zero critical/serious violations
2. Open game detail drawer has zero critical/serious violations
3. Fleet management dashboard has zero critical/serious violations
4. Legal policy dialogs and consent banner have zero critical/serious violations

#### `accessibility-audit-sprint6.spec.ts` — Sprint 6 WCAG 2.1 AA Final Audit (4 tests)

**Why:** PI-GTM-2026-001 final GTM audit: dialog semantics, Tab trapping, semantic table structure, and the ARIA contract sweep across WUD surfaces.

1. Mods drawer opens with dialog semantics, moves focus inside, and has zero serious/critical axe violations
2. Mods drawer traps Tab navigation and restores focus on Escape
3. Rendered compare matrix has zero serious/critical axe violations and semantic table structure
4. ARIA contract sweep across the WUD surfaces (aria-live / aria-expanded / aria-pressed)

### 2.4 Library, Catalog & Discovery (10 specs)

#### `catalog-discovery.spec.ts` — Core Game Catalog Discovery & Filter Regression (11 tests)

**Why:** EPIC-TEST-STD-0001 baseline: search, empty states, platform facets, smart-binder pills, sort contracts, and cross-surface navigation must not regress.

1. Typing a matching query filters search results to matching titles
2. Searching for a non-existent title displays the empty search state message
3. Clearing the search input restores the default (hidden dropdown) state
4. Search API contract returns only matching seeded titles (Witcher / Elden)
5. Steam platform facet filters cards to Steam ownerships
6. PlayStation facet filters to PlayStation ownerships and All facet resets the catalog
7. Platform query contract on /api/games filters by owned platform
8. Smart Binder tag pill filters the library and toggling off resets it
9. Platform Hub sort dropdown exposes rating-desc and no price sort (documented gap)
10. Rating-desc sort contract: top cards have >= scores of subsequent cards
11. Navigating across catalog surfaces completes with no uncaught page errors

#### `library-ux.spec.ts` — High-Density Library UX (4 tests)

**Why:** EPIC-UX-LIBRARY-0001: wrapped platform filters (no horizontal scroll), dynamic genre/tag filtering, rating sort, and dense card information.

1. Platform filters render in a wrapped layout without horizontal scroll overflow
2. Filtering by genre or tags updates the rendered game grid dynamically
3. Sorting by Top Reviewed orders cards in descending rating sequence
4. Game cards render completion time, review badges, and platform ownership indicators

#### `library-advanced.spec.ts` — Advanced Library & Drawer UX (4 tests)

**Why:** EPIC-UX-LIBRARY-0002: multi-genre + play-state filters, owned-game drawer context (hide deals/wishlist, show DLC), and deep-linked game pages.

1. Redundant category row is absent; platform facets filter the library
2. Multi-genre selection and Played/Not-Played filters dynamically filter results
3. Opening an owned game drawer hides base deals/wishlist and shows the DLC section
4. Navigating to #/game/:id loads the full page with system requirements and metadata

#### `library-importer.spec.ts` — Multi-Source Library Importer & Deduplication Engine (5 tests)

**Why:** FEAT-0153: importers parse Steam .acf/JSON manifests, dedupe against the existing library, never clobber progress records, and report malformed files clearly.

1. Parses simulated Steam .acf and JSON manifests into a preview table
2. Batch import executes with deduplication against existing library titles
3. Preserves existing game progress/tracking records during platform metadata updates
4. Reports descriptive errors for malformed and empty manifest files
5. Import views and preview table expose accessible ARIA semantics

#### `multi-genre-filter.spec.ts` — Multi-Genre Filtering Engine (10 tests)

**Why:** EPIC-01: genre intersection/union semantics, facet sanitization, genre list endpoint, pagination composition, and client multi-select behavior.

1. Single-genre facet is a zero-regression subset filter
2. Multi-select intersection (?genre=a,b) requires every selected genre
3. genreMode=any switches to union (superset) matching
4. Facet sanitization: hostile / oversized tokens never error and stay capped
5. GET /api/games/genres returns the CMS-extensible facet list
6. Genre facets compose with EPIC-03 pagination metadata
7. Client genre filter checkboxes are multi-select and narrow the grid
8. Genre filter state survives pagination turns
9. Dual-mode Grid/List view toggle preserves facet state and renders the list layout
10. Zero accessibility violations on the genre facets + view toggle

#### `paginated-catalog.spec.ts` — Paginated Catalog Browsing (7 tests)

**Why:** EPIC-03: page/limit contracts (12/24/48), graceful clamping of bad params, legacy no-page contract, pagination controls with live regions, and deep links.

1. GET /api/games?page=&limit= supports 12/24/48 with pagination metadata
2. Invalid, negative, non-numeric, or out-of-range params clamp gracefully
3. Omitting page preserves the legacy full-catalog contract
4. Pagination controls render below the grid with a live-region label
5. Next advances the page label, enables Previous, and syncs the deep link
6. Deep-linking #/library?page=N resolves directly to that page
7. Page-size selector re-renders under the 12/24/48 budget

#### `game-drawer.spec.ts` — Unified Cross-Hub Game Drawer & Aggregated Detail API (5 tests)

**Why:** FEAT-0148: the drawer is a cross-hub integration point — dialog semantics, aggregated metrics, unified detail payload, and dismissal paths.

1. Drawer opens on game item and exposes accessible dialog semantics
2. Aggregated metrics render (HLTB, Deals/Alerts, Fleet rating, Installed mods)
3. Aggregated detail API returns unified payload
4. Drawer closes via close button, backdrop, and Escape key
5. No accessibility violations on interactive drawer elements

#### `game-interactions.spec.ts` — Dynamic Fixtures & User Interaction Workflows (4 tests)

**Why:** EPIC-TEST-STD-0001 Sprint 3: end-to-end user-generated data (wishlist toggle, tags/notes, price alerts) persists and stays tenant-isolated.

1. Wishlist: API-created item renders on the page and UI toggle updates server + counter
2. Tags & Notes: drawer-created tag and markdown note persist after reload
3. Price alerts: target price displays accurately in the Deals/Alerts drawer surface
4. Multi-tenant purity: Alex's dynamic records never bleed into Jordan's views

#### `command-palette.spec.ts` — Global Keyboard Command Palette & Quick Action Engine (5 tests)

**Why:** FEAT-0150: Ctrl+K/Meta+K palette is a power-user surface — open/focus, navigation commands, live game search, dismissal, and accessibility.

1. Opens via Ctrl+K / Meta+K and focuses the search input
2. Navigation command routes to the target page
3. Live game search opens the game detail drawer on Enter
4. Closes via Escape key and backdrop click
5. No accessibility violations on palette dialog elements

#### `recommender-controls.spec.ts` — Recommender Controls Contract (4 tests)

**Why:** Enforces the explicit-action trigger rule (Chapter 23): time/energy buttons bind correctly, toggle state, and "Find Recommendation" fires the POST contract.

1. Time and energy buttons render with the app.js binding contract
2. Selecting a time button toggles its active state
3. Selecting an energy button toggles its active state
4. "Find Recommendation" fires a POST to /api/recommender/suggest

### 2.5 Deals, Pricing, Radar & Wishlist (11 specs)

#### `deals-hub.spec.ts` — Deals Hub, CheapShark Integration, Historical Low Alerts & Wishlist Sync (4 tests)

**Why:** FEAT-0145: the deals hub integrates external CheapShark pricing, historical-low badges, wishlist sync, and price-alert persistence.

1. Route navigation to #/deals and filter execution
2. CheapShark API proxy hydration and deal card rendering
3. Wishlist sync toggle and historical low badge visibility
4. Price alert threshold creation and state persistence

#### `deals-hub-complete.spec.ts` — Deals Hub 4-Tab Navigation, SVG Sanitization & Security (4 tests)

**Why:** EPIC-DEAL-001: 4-tab IA must work without reloads, deep links activate tabs, and rendered SVG price charts must be script-injection safe.

1. Deals Hub renders all 4 sub-tabs and switches panels without page reloads
2. URL query-parameter deep-linking activates the target sub-tab directly
3. rendered SVG price charts contain 0 script tags or unescaped event handlers
4. all deal cards render valid sanitized HTTPS store URLs matching the domain allowlist

#### `deal-arbitrage.spec.ts` — Advanced Deal Arbitrage & Price History (4 tests)

**Why:** WUD-2.2 / EPIC-02: arbitrage cards carry sparkline history + lows, ingestion rejects grey-market/bad prices, and 24-month history endpoints serve the UI + Set Alert flow.

1. GET /api/deals/arbitrage returns cards with sparkline history + lows
2. Ingest persists baseline history and rejects grey-market + bad prices
3. GET /api/deals/arbitrage/:gameId/history returns 24-month points
4. UI: Price Arbitrage tab renders sparkline cards + Set Alert flow

#### `deals-wishlist-quickaction.spec.ts` — Wishlist Quick-Action & Link Traceability (4 tests)

**Why:** EPIC-DEAL-001: quick-add from command palette, AppWishlist registration, Wishlist Drops surfacing, and verified HTTPS link attribution.

1. User searches an unowned game via Ctrl+K and opens its quick-view drawer
2. Clicking Add to Wishlist registers the item in AppWishlist and updates UI state
3. Newly wishlisted item appears under the Wishlist Drops tab
4. All rendered store links carry verified HTTPS targets and attribution badges

#### `deals-wishlist-radar.spec.ts` — Release Radar, DLC & Wishlist Drops (4 tests)

**Why:** EPIC-DEAL-001: upcoming releases with countdowns, wishlist discount drops, DLC sales, and price-alert management.

1. Release Radar endpoint and UI render upcoming releases in chronological order with countdowns
2. Wishlist Drops calculates and surfaces active deal discounts matching the user's wishlist
3. DLC sales view lists discounts for add-on content tied to base games
4. Authenticated user can manage, update threshold prices on, and delete active price alerts

#### `price-alerts.spec.ts` — Price Alert Automation, Historical Low Radar & SVG Sparklines (3 tests)

**Why:** FEAT-0158: historical-low filter, drawer sparkline + alert controls, and the price-alert API contract.

1. Historic Low Filter Pill toggles active state and updates deals feed
2. Game Drawer displays price sparkline, historical low badge, and price alert controls
3. Price alert API endpoints operate correctly

#### `radar-alerts.spec.ts` — Automated Price Alert In-App Notification Hub (4 tests)

**Why:** EPIC-RADAR-0001: the header notification counter, drawer comparison of target vs. current price, dismissal, and the no-alert empty state.

1. Seeded user with triggered price alert sees notification counter in header
2. Opening notification drawer renders triggered deal with target price vs current price comparison
3. Dismissing alert removes it from list and decrements/hides header counter
4. Unauthenticated visitors or users without triggered alerts see no notification badge

#### `radar-arbitrage.spec.ts` — Historic Lows, Arbitrage Badging & Pure SVG Sparklines (3 tests)

**Why:** EPIC-RADAR-0001: historical-low endpoint, arbitrage/low badges + SVG sparklines on the deals page, and drawer sparkline rendering.

1. GET /api/deals/historical-low returns historical low price data
2. Deals page renders deals with arbitrage/historic low badges and SVG price sparklines
3. Game details drawer renders inline SVG price sparkline when price history is present

#### `radar-discovery.spec.ts` — Hidden Gems Engine & Live Freebies Hub (3 tests)

**Why:** EPIC-RADAR-0001: hidden-gems composite-score endpoint, the library quick-toggle, and the freebies shelf.

1. GET /api/games?filter=hidden-gems returns composite >= 80 niche/indie titles
2. Clicking Hidden Gems quick-toggle renders curated list in Library
3. Active Freebies shelf renders giveaways with title, platform badge and claim button

#### `wishlist.spec.ts` — Universal Multi-Store Wishlist, Price Comparison & Target Threshold Alerts (13 tests)

**Why:** FEAT-0158: the richest surface — search/add with target price, multi-store comparison, below-target triggers, filters, drawer add, remove, retailer taxonomy, DRM/offline/moddability badges, and DLC catalog.

1. Search for a game, set a target price, and add it to the wishlist
2. Multi-platform store comparison table renders across stores
3. 🚨 Below Target alert triggers when best store price is at or below target
4. Toggle the Triggered Alerts Only filter
5. Add a game from the Game Detail Drawer
6. Remove a game from the wishlist
7. Zero accessibility violations on the wishlist page
8. Authorized key distributors render in the matrix table with 🔑 Authorized tags
9. DRM, modding, and offline badges render in the matrix table
10. Moddability section shows Nexus badges and community hub links
11. DLC catalog shows pricing, discount, and store tags
12. Toggle the Authorized Key Sellers filter to isolate authorized cards
13. Zero accessibility violations with enriched cards (matrix, moddability, DLC)

#### `live-store-ingestion.spec.ts` — Live Storefront Proxy, Real-Time Alerts & Notification Engine (4 tests)

**Why:** FEAT-0166: live price refresh trigger, isTriggered alert state transitions, authorized-retailer taxonomy persistence, and a11y across Wishlist/Settings.

1. Sync Live Deals button triggers a live storefront price refresh
2. Price updates and threshold alert state transitions (isTriggered indicator)
3. Authorized retailer taxonomy persists with live records
4. Zero accessibility violations across Wishlist and Settings interfaces

### 2.6 Hardware, Fleet & Devices (9 specs)

#### `fleet-compatibility.spec.ts` — Hardware Compatibility & Multi-Axis Headroom Engine (5 tests)

**Why:** EPIC-FLEET-0001: auth gate, optimal/handheld-TDP/incomplete-spec evaluation, and cross-tenant device access control.

1. Unauthenticated compatibility requests return 401
2. Alex evaluates high-end desktop against Cyberpunk 2077 (Optimal)
3. Alex evaluates portable handheld with Battery Saver penalty (TDP scaling)
4. Incomplete device specs return "Incomplete Specs" status with re-scan note
5. Jordan cannot calculate compatibility for Alex's device

#### `fleet-profiles.spec.ts` — Hardware Specs Persistence & Device Profiles (5 tests)

**Why:** EPIC-FLEET-0001: CRUD lifecycle, tenant isolation, required-field validation, and persistence across session rehydration + state export (Anti-Stale Input Rule).

1. Unauthenticated requests to /api/devices return 401
2. Alex creates, retrieves, updates, and deletes a device profile
3. Jordan cannot access or mutate Alex's hardware device profiles
4. POST /api/devices rejects missing required fields (deviceName, deviceType)
5. Device profile persists across session rehydration and exports cleanly via /api/state/export

#### `fleet-ui.spec.ts` — Fleet Dashboard & Interactive Compatibility UI (4 tests)

**Why:** EPIC-FLEET-0001: add-device modal → fleet row, explicit "Analyze Compatibility" trigger, incomplete-spec warning banner, and device deletion propagation.

1. Opens Add Device Modal, fills form, submits, and renders a horizontal fleet row
2. Analyze Compatibility on a fully-specced desktop yields an Optimal multi-axis rating
3. Analyze Compatibility on a device with missing specs shows the Incomplete Specs warning banner
4. Deleting a device removes its fleet row and its option from the drawer device selector

#### `playability-matrix.spec.ts` — Playability Matrix & Fleet Specs (2 tests)

**Why:** FEAT-0142: active-device persistence drives the playability API and the matrix UI fills with correct headroom + battery estimates.

1. Verify active device persistence and playability API calculations
2. Verify playability matrix elements populate with proper headroom and battery estimates

#### `compare-matrix.spec.ts` — Multi-Game Comparison Matrix & Target Device Specs (4 tests)

**Why:** The compare page binds target device specs (GPU/CPU/RAM/VRAM/FPS) and renders a side-by-side matrix with zero axe violations.

1. Compare page renders target device selector and game multi-select
2. Selecting a target device renders GPU/CPU/RAM/VRAM/Target FPS specs
3. Selecting two games renders the side-by-side comparison matrix
4. Zero accessibility violations across the compare page

#### `devices-builder.spec.ts` — Custom PC Builder (4 tests)

**Why:** EPIC-DEV-001: part selection drives live price/wattage, incompatible parts raise a visible warning, and saved/shared builds round-trip.

1. Selecting parts across categories updates real-time total price and estimated wattage
2. Incompatible parts (AM5 CPU + AM4 Motherboard) trigger a visible red compatibility warning banner
3. Authenticated user can save a named build and reload it
4. Accessing a shared build URL renders the read-only build snapshot

#### `devices-catalog.spec.ts` — Devices Hub, Hardware Catalog & Comparison (4 tests)

**Why:** EPIC-DEV-001: top-nav entry, catalog brand/type filtering, side-by-side spec comparison with superior-value highlighting, and active-device management.

1. Devices tab is visible in top nav and loads the devices overview page
2. Prebuilt catalog filters correctly by brand and device type
3. Side-by-side device comparison renders matching specs with superior values highlighted
4. My Devices displays owned hardware and allows setting an active/primary device

#### `devices-performance.spec.ts` — Devices Performance Matrix & Advisor (4 tests)

**Why:** EPIC-DEV-001: color-coded FPS grid across 4 resolution tiers, live reference-device switching, performance deltas, and upgrade advice.

1. Performance grid renders library games with color-coded FPS cells across all 4 resolution tiers
2. Switching reference devices updates FPS projections in real time
3. Side-by-side comparison mode displays performance deltas and summary metrics
4. Upgrade advisor renders actionable upgrade suggestions when library performance falls below threshold

#### `devices-reviews-deals.spec.ts` — Hardware Deals, Price History & Community Reviews (4 tests)

**Why:** EPIC-DEV-001: seller links + 12-month SVG price history, price-drop alerts, Verified Owner badge logic, and review up-voting.

1. Device detail page displays seller links and 12-month SVG price history chart
2. Authenticated user can set a hardware price drop alert
3. Submitting a review for an owned device automatically applies the Verified Owner badge
4. Up-voting a review increments the helpfulness score dynamically

### 2.7 Mods (3 specs)

#### `nexus-mods.spec.ts` — Nexus Mods Integration & Installed Tracker E2E (3 tests)

**Why:** The mod hub must load trending mods from the mocked Nexus surface, search within a game domain, and toggle installed/tracked status.

1. navigates to Nexus Mods Hub and loads trending mods
2. searches for mods within a game domain
3. toggles mod tracking status

#### `sprint4-mods.spec.ts` — Mods Hub 2.0 API (8 tests)

**Why:** Mods Hub 2.0 detail contracts: masked authors, dependency trees, file-conflict detection, missing-dependency guards, load-order persistence, state snapshot round-trip, and keyboard-driven load order UI.

1. Detail payload includes description, masked author, stats, version history and dependency tree
2. File-level conflicts are detected between selected mods
3. Missing hard dependencies are flagged before activation
4. Load order reorders persist to SQLite and read back
5. Mod hub tables round-trip through the state snapshot export/import
6. Mod detail view renders description, author, stats and dependency tree without layout shifts
7. Load Order Manager reorders via keyboard, persists to SQLite, and supports undo
8. File-level conflict warnings appear as inline badges on mod cards

#### `sprint5-mods-analytics.spec.ts` — Mods Ecosystem Ingestion & Analytics Role-Gating (11 tests)

**Why:** EPIC-06/07: mod ingestion enforces HTTPS-only + whitelisted domains, and analytics endpoints enforce role-gated access with an immutable audit log.

1. Mods ingest rejects http:// sourceUrl (HTTPS-only gate)
2. Mods ingest rejects a non-whitelisted domain
3. Mods ingest restricts github.com to release asset paths
4. Mods ingest rejects a mismatched sourceDomain label
5. Mods ingest persists a whitelisted HTTPS URL and listings read it back
6. Mods table round-trips through the state snapshot export/import
7. Analytics API returns 401 for unauthenticated requests
8. Analytics denies the standard user role with 403 and writes an audit log
9. Analytics grants the authorized Leadership role
10. analytics_access_logs is immutable (append-only triggers)
11. Analytics is a top-level nav tab and Retro Hub renders the onboarding panel

### 2.8 Retro Preservation (2 specs)

#### `retro-hub.spec.ts` — Retro Gaming Hub (5 tests)

**Why:** FEAT-0159: the zero-hosting preservation doctrine — system filter bar, legal storefront/remaster outbound links, ROM dropzone semantics, catalog filtering, and a11y.

1. Navigating to #/retro renders the systems filter bar
2. Official storefront and legal remaster outbound links render
3. Local ROM dropzone container renders with accessibility labels
4. Toggling system filter chips updates the rendered catalog list
5. Zero accessibility violations on the Retro Hub page

#### `retro-patcher.spec.ts` — Retro Patcher (5 tests)

**Why:** FEAT-0165: sandboxed client-side patching — dropzone + sandbox controls, IPS/BPS apply with CRC32 verification, save-state IndexedDB persistence, Gamepad wiring, and a11y.

1. Patch dropzone, sandbox controls and gamepad badge render
2. IPS and BPS patches apply with CRC32 verification
3. Save-state slots persist to IndexedDB
4. Gamepad API wiring exposes status badge and polling
5. Zero accessibility violations on the Retro Patcher page

### 2.9 Analytics, Backlog & Sessions (4 specs)

#### `analytics-visualizer.spec.ts` — Interactive Playtime & Backlog Analytics Visualizer (5 tests)

**Why:** FEAT-0152: the analytics summary API shape, SVG chart rendering, cost-per-hour + genre math, offline IndexedDB rendering, and chart-card a11y.

1. GET /api/analytics/summary returns valid structure and aggregates
2. Navigating to Analytics view renders SVG charts
3. Cost-per-hour and genre breakdown calculations are correct
4. Offline rendering works from the IndexedDB cache
5. Zero accessibility violations across chart cards

#### `hltb-insights.spec.ts` — HLTB Insights, Backlog Analytics & Completion Roadmap (4 tests)

**Why:** FEAT-0147: backlog route + summary stats, HLTB time-to-beat badges, progress after logging hours, and SQLite persistence of hours/roadmap.

1. Route navigation to #/backlog and summary stats render
2. HLTB time-to-beat badges render on backlog game cards
3. Progress bar state updates after logging hours
4. SQLite persistence of logged hours and roadmap stats

#### `backlog-sessions.spec.ts` — Backlog Session Tracking, Stopwatch & Offline Sync (4 tests)

**Why:** FEAT-0162/0163: stopwatch UI, idempotent session logging via POST /api/backlog/session, summary API with sessions + priority scores, and IndexedDB offline queueing/sync.

1. Start Session button displays stopwatch timer panel
2. Direct API logging via POST /api/backlog/session with sessionUuid idempotency
3. Backlog summary API includes play sessions and priority scores
4. Client-side IndexedDB offline session queueing and sync

#### `session-analytics.spec.ts` — Session Intelligence, Fleet Power Telemetry & Backlog Velocity (4 tests)

**Why:** FEAT-0163: sessions telemetry with device attribution, backlog velocity + burn-down ETA + stalled detection, analytics cards from seeded sessions, and a11y.

1. GET /api/analytics/sessions returns valid telemetry with device attribution
2. GET /api/backlog/velocity returns velocity, burn-down ETA and stalled detection
3. Analytics view renders Hardware Efficiency & Backlog Velocity cards from seeded sessions
4. Zero accessibility violations across the new analytics cards

### 2.10 State Persistence, Backup & Resilience (3 specs)

#### `state-backup.spec.ts` — State Export/Import & Database Snapshot Engine (4 tests)

**Why:** FEAT-0149: the state persistence contract — versioned export with all table keys, import upsert into SQLite, malformed-payload validation, and persistence across tabs.

1. Export produces a versioned snapshot with all table keys
2. Import upserts a mock payload into SQLite
3. Malformed import payloads return descriptive validation errors
4. Restored data persists across navigation tabs

#### `state-resilience.spec.ts` — Disaster Recovery & Chaos Resilience (4 tests)

**Why:** EPIC-TEST-STD-0001 Sprint 4: tampered/expired sessions degrade to guest mode, malformed imports/FK mismatches are rejected without corruption, provider drops fall back gracefully, and rapid wishlist mutations never throw SQLITE_BUSY.

1. Tampered and expired session cookies return 401 and degrade the browser to guest mode
2. Malformed imports, unknown schema keys, and FK mismatches are rejected without corruption
3. Provider network drops degrade to fallback badges without uncaught exceptions
4. Rapid alternating wishlist mutations settle consistently with zero SQLITE_BUSY

#### `state-ui-backup.spec.ts` — State Snapshot & Backup Management UI (5 tests)

**Why:** FEAT-0164: export download (32 table keys), snapshot upload pre-restore summary, atomic restore + hot-rehydration, invalid JSON errors, and a11y on the Data & Backup UI.

1. Export produces a downloadable snapshot with all 32 table keys
2. Uploading a valid snapshot renders the pre-restore summary table
3. Confirm restore persists atomically and hot-rehydrates the UI
4. Invalid JSON uploads surface descriptive error alerts
5. Zero accessibility violations on the Data & Backup Management UI

### 2.11 PWA, Offline, Theme & Performance (4 specs)

#### `offline-pwa.spec.ts` — Offline-First PWA, Service Worker & IndexedDB Persistence (4 tests)

**Why:** FEAT-0151: SW registration + manifest link, IndexedDB population while online, offline rendering from cache, and the offline status pill toggling on connectivity change.

1. Service worker registers and manifest is linked
2. Online browsing populates IndexedDB offline stores
3. Offline simulation renders dashboard views from IndexedDB cache
4. Offline status pill toggles when connectivity drops and recovers

#### `theme-a11y-pwa.spec.ts` — Theme Engine, A11y & PWA Install (4 tests)

**Why:** FEAT-0167: the custom theme engine applies `data-theme` + CSS custom properties, PWA install prompt works without a top banner, focus traps in drawer/palette, and all four themes are axe-clean.

1. Theme switcher updates data-theme and applies CSS custom properties
2. PWA install engine handles beforeinstallprompt without a top banner
3. Keyboard navigation traps focus in drawer and palette, then restores it
4. Zero accessibility violations across all four themes

#### `performance-benchmark.spec.ts` — Performance & Virtualization (4 tests)

**Why:** FEAT-0168: virtualized library initial-batch render under 500ms, no layout shift on page turns, `/api/analytics/perf` reporting (memory/tables/sub-15ms query), and a11y on the virtualized view.

1. Virtualized library renders an initial 24-card batch in under 500ms
2. Navigating library pages re-renders without layout shift
3. /api/analytics/perf reports memory, table counts and a sub-15ms query benchmark
4. Zero accessibility violations on the virtualized library view

#### `performance-sprint6.spec.ts` — Sprint 6 P90 Performance Verification (3 tests)

**Why:** PI-GTM-2026-001: quantifies P90 latency budgets — genre facet query, catalog pagination, and compare click-to-render must each stay ≤ 2s.

1. Multi-genre facet query round-trips under the 2s P90 budget
2. Catalog pagination round-trips under the 2s P90 budget
3. Comparison matrix click-to-render stays under the 2s P90 budget

### 2.12 Release, Platform, Home/UX & Sprint Suites

#### `release-gate.spec.ts` — Release Gate (v1.0.0) & Health Probes (3 tests)

**Why:** FEAT-0169-V1: container/production readiness — `/healthz` with DB connectivity, `/livez` liveness, and active security headers.

1. GET /healthz returns 200 OK and healthy status with database connectivity
2. GET /livez returns 200 OK alive probe
3. Security headers are active on responses

#### `remediation-regression.spec.ts` — Hardened Remediation & Stability (8 tests)

**Why:** Sprint 6.1 GAP-001..006: sanitized DPM health + rate limiting, trending-mods fallback, read-time whitelist suppression, safeValue compare cells, palette self-healing, mods aggregation status, and safeToastError.

1. GAP-001: /api/dpm/health returns a sanitized payload
2. GAP-001: DPM health enforces a 5 req/sec rate limiter
3. GAP-003/004: trending mods return non-null metadata with a fallback source
4. GAP-003: read-time whitelist suppresses inactive/non-compliant listings
5. GAP-006: compare matrix enforces safeValue on string cells
6. GAP-002: palette CSS custom properties self-heal through the strict sanitizer
7. GAP-003: mods aggregation status endpoint contract
8. safeToastError strips stack traces, internal paths and secrets

#### `platform-mock-verification.spec.ts` — Full-Platform Mock Seeding & E2E Validation (6 tests)

**Why:** FEAT-0161: the seed-dev-bar triggers API seeding that rehydrates Fleet, Wishlist Arbitrage, Games, Retro, and stays axe-clean.

1. Seed Dev Bar UI triggers API seeding and rehydrates active DOM views
2. Fleet Matrix verification across seeded devices and games
3. Wishlist Arbitrage verification for price alerts and badges
4. Moddability & Anti-Cheat tags render in Games library view
5. Retro Hub catalog renders seeded titles with store and patch metadata
6. Zero accessibility violations across primary hydrated views

#### `platform-taxonomy.spec.ts` — Platform Taxonomy & Hub Triage (6 tests)

**Why:** EPIC-04/05: canonical label normalization, taxonomy endpoint with coherent counts, PS4-era hub inclusion (HUB-01), persisted platformCanonical, append-only audit log, and ingest validation of unclassified platforms.

1. normalizePlatform resolves legacy storefront labels to the canonical taxonomy
2. GET /api/platforms/taxonomy returns the 7 canonical values and coherent counts
3. PlayStation hub summary includes PS4-era rows (hub OR-match fix, HUB-01)
4. AppOwnership.platformCanonical is persisted deterministically in SQLite
5. platform_audit_logs is append-only (UPDATE/DELETE triggers abort)
6. Ingest validation rejects unclassified platforms with a structured audit entry

#### `splash-dashboard.spec.ts` — Splash Dashboard Overhaul (9 tests)

**Why:** FEAT-0154: the dashboard's single-column vertical flow — Platform Breakdown → Deals/Freebies Radar → Fleet Summary, with deep links, moddable-game hub, offline rendering, and horizontal rows.

1. Home dashboard renders Platform Breakdown, Deals/Freebies Radar, and Fleet Summary cards
2. Clicking a platform badge chip renders compact game mini-list and clicking a row opens drawer
3. Moddable Games hub lists valid moddable library titles with working triggers
4. Offline rendering continuity from IndexedDB cache
5. Zero accessibility violations on the home dashboard
6. "View All Games →" link navigates to the library route
7. "Open [Platform] in Platform Hub →" deep-links to #/platforms with active store pre-selected
8. Horizontal game rows render Moddable badge, Steam rating, OpenCritic score, and genre tags
9. Giveaway drop banner displays a scheduled alert with valid outbound links

#### `home-enrichment.spec.ts` — Home Enrichment (4 tests)

**Why:** EPIC-UX-REFINE-0002: hero + featured spotlight, freebie cards with expiry urgency, top-deal cards with review badges/price breakdown, and modded-game thumbnails + taxonomy badges.

1. Hero introduction and featured spotlight card render on the home surface
2. Freebie cards display cover art, store badge, value, and expiry urgency timers
3. Top Deal cards display thumbnail, review score badges, and price breakdown
4. Modded game items render thumbnail and mod taxonomy badges

#### `home-ux-polish.spec.ts` — Home UX Polish (4 tests)

**Why:** EPIC-UX-REFINE-0001: consolidated 5-item IA without horizontal scrolling, search selection opening the drawer, normalized platform breakdown, and enriched freebie/deal cards.

1. Navigation renders consolidated 5-item IA without horizontal scrolling
2. Search input selection opens the game detail drawer
3. Platform breakdown reflects normalized platform keys
4. Top 5 freebies render urgency badges; deal cards show genre/rating

#### `detail-visual-polish.spec.ts` — Visual Polish (3 tests)

**Why:** EPIC-UX-POLISH-0001: genre multi-select dropdown, empty-trailer container suppression, and clean rendering across the detail sub-tabs.

1. Library genre filter renders a multi-select checkbox dropdown
2. Game detail page hides empty trailer containers when trailer is null
3. Game detail page renders cleanly across Overview, Specs, Reviews, and Platforms sub-tabs

#### `visual-hotfix.spec.ts` — Visual & Functional Hotfix Verification (2 tests)

**Why:** EPIC-HOTFIX-VISUAL-001: regression check that hotfixes to the genre filter and hero/media block did not break rendering.

1. Library Genre Filter Renders a Multi-Select Checkbox Dropdown
2. Game Detail Hero Banner and Media Block Behavior

#### `tile-view-compare.spec.ts` — Dual-Mode Tile View & Compare Reorganization (7 tests)

**Why:** Sprint 4: persisted grid/list preference, responsive single-row list cards, compare grouped into four logical clusters, capped vs. show-all attributes, mods drawer from badge, and a11y.

1. Grid/List view preference persists across browser sessions
2. List-mode cards render a responsive single row with title, platform badge, genre, rating, and a quick-action CTA
3. Compare matrix groups attributes into four logical clusters
4. Default Compare view caps at 8 key attributes; Show all expands to the full cluster set
5. Community mods drawer (mock) opens from the library mod badge and surfaces compatibility tags
6. Zero axe accessibility violations on the reorganized compare view
7. Mods hub renders the compatibility tags preview panel

#### `tags-notes.spec.ts` — Custom Tags, Smart Collections & Notes (5 tests)

**Why:** FEAT-0156: tag creation/drawer management, debounced note auto-save, smart binders + library filtering, tag deletion, and ARIA semantics.

1. Tag creation API & drawer tag management
2. Notes API & 1000ms debounced auto-save
3. Smart Binders rendering and library tag filtering
4. Tag deletion and clean state
5. ARIA and accessibility attributes on Smart Binders & Drawer Notes

#### `sprint3-ux.spec.ts` — Sprint 3: Unified Navigation & IA, Game Discovery 2.0, Profile Foundations (7 tests)

**Why:** WUD-3.1/3.2/3.3 + EPICUX01/02/03: desktop left rail with aria-current, Ctrl+K palette, mobile bottom tabs + search FAB, mood-rail recommendations, Surprise Me, profile dashboard, and private-visibility enforcement.

1. Desktop left rail is visible, navigates routes, and sets aria-current
2. Left-rail search control and Ctrl+K open the command palette
3. Mobile bottom tab bar + search FAB render on small viewports
4. Mood selector builds personalized recommendation rails
5. Surprise Me renders a single seeded pick
6. Profile dashboard renders identity, privacy, achievements and play history
7. profileVisibility 'private' enforcement — public lookup 404 until made public

#### `sprint5-hardware.spec.ts` — Hardware Explorer 2.0 (11 tests)

**Why:** EPICUX05: PII-free scan persistence, explicit-trigger tiered compatibility, missing-VRAM blocked state (never guessed), upgrade advisor with whitelisted retailers, component comparison, filterable community benchmarks, state-snapshot registration, and reachability.

1. POST /api/scan returns PII-free normalized telemetry and persists it
2. Explicit-trigger compatibility returns Minimum/Recommended/Ultra tiers
3. Missing persisted VRAM produces an explicit blocked state (no guessing)
4. Upgrade advisor returns real-spec suggestions with whitelisted retailers
5. Upgrade advisor blocks gracefully when the rig has no persisted specs
6. Side-by-side component comparison returns specs, benchmarks and trends
7. Community benchmark tables are filterable by resolution and preset
8. State snapshot export registers community_benchmarks and extended Devices columns
9. UI #/hardware renders and compatibility only runs on explicit trigger
10. UI comparison tool renders sticky tabbed comparison after explicit Compare
11. Hardware Explorer is reachable via nav, rail and the Devices cross-link

#### `sprint7-refinements.spec.ts` — Sprint 7: Polish, Break-Fixes & Feature Refinements (10 tests)

**Why:** WUD-7.1..7.5: synopsis in list view/API, DPM count + current-system toggle, Steam requirements enriching comparison, vetted mod providers + legal disclaimer, and whitelist-validated retro resources.

1. 7.1 Library list view shows synopsis and a single primary platform badge
2. 7.1 synopsis is surfaced on the games API payload
3. 7.2 DPM count label syncs with the Library tab page size
4. 7.2 'Display only current system hardware' toggle filters fallback profiles
5. 7.3 Comparison API enriches CPU/GPU/RAM/VRAM from Steam requirements
6. 7.3 Comparison matrix renders non-empty CPU/GPU rows in the UI
7. 7.4 Mods Hub renders approved provider links and the legal disclaimer
8. 7.4 /api/mods/providers returns the vetted whitelist + disclaimer
9. 7.5 Retro Hub renders emulator resource links and an embedded setup video
10. 7.5 /api/retro/resources returns whitelist-validated emulators + setup guide

---

## 3. Unit tests — Vitest (`test/unit`, `npm run test:unit`)

Pure-logic suites only (no SQLite/network, per `vitest.config.ts`). Run before the E2E gates; catch function-level regressions in milliseconds.

| Suite                              | Module under test                    | Reasoning                                                                                                                                                         |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dealSchema.test.ts`               | `src/utils/dealSchema`               | Price/discount sanitizers (bounds, rounding, non-finite) and deal/giveaway record + feed parsing — guarantees malformed external pricing can never poison the DB. |
| `headroom.test.ts`                 | `src/services/headroom`              | Requirement parsing (GB), compatibility evaluation, tier-requirement derivation, and tiered compatibility — the pure math behind the playability matrix.          |
| `modSchema.test.ts`                | `src/utils/modSchema`                | Mod description sanitization (HTML/event handlers/URI schemes), author-handle masking, version-tag sanitization, and metadata validation.                         |
| `platformTaxonomy.test.ts`         | `src/lib/platformTaxonomy`           | `normalizePlatform` resolution (PC / console / mobile / cloud families), canonical platform list, and `isCanonicalPlatform`.                                      |
| `storefrontCircuitBreaker.test.ts` | `src/utils/storefrontCircuitBreaker` | Circuit-breaker state machine CLOSED→OPEN transitions with deterministic env thresholds/backoffs.                                                                 |
| `storefrontValidator.test.ts`      | `src/utils/storefrontValidator`      | Store-name normalization/allowlist, grey-market URL detection, HTTPS + whitelist URL validation, canonical store domains.                                         |
| `tokenCipher.test.ts`              | `src/lib/tokenCipher`                | AES-256-GCM at-rest token vault: configuration detection, encrypt/decrypt round-trip, tamper resistance.                                                          |
| `wishlistPricing.test.ts`          | `src/services/wishlistPricing`       | Store-type taxonomy (Direct Platform vs Authorized Retailer), price synthesis, best-price selection, and at-or-below-target trigger logic.                        |
| `analyticsMath.test.ts`            | `src/utils/analyticsMath`            | Analytics aggregation math: genre normalization, play-status velocity buckets, cost-per-hour value ratings, and NaN-safe rounding.                                |
| `devicePlayability.test.ts`        | `src/services/devicePlayability`     | DPM pure logic: telemetry counters, Prometheus rendering, TTL cache, bounded retry, and degraded-state fallback (no guessed specs).                               |

## 4. Auxiliary / legacy checks

- **`test_api.js`** — retired (Gap-6): the lightweight API smoke script was fully redundant with the E2E suite and `smoke:postdeploy`; the file and its `test:api` script were removed.
- **`test:e2e:all`** — same as DoD gate 4 but explicitly scoped to `test/e2e/`.

## 5. Gap analysis — additional tests to consider

Findings from the inventory review that directly answer "are any additional tests needed?":

1. ✅ **Resolved — gates are now real.** S1 (SAST), S3 (secret scan), S4 (transport), Q1 (lint), Q2 (Vitest), Q3 (v8 coverage with thresholds), Q4 (bundle budgets) are implemented as `scripts/gate-*.js` + `npm` invocations; every gate can genuinely fail.
2. ✅ **Resolved — S2 fails on high/critical.** `npm audit --audit-level=high` runs without `|| true`; current baseline is 0 vulnerabilities.
3. ✅ **Resolved — CI runs the full suite.** `lint-test` now adds `npm run test:unit` + `bash gates/run-all.sh`; a `test-e2e` job (needs lint-test) runs the full 407-test Playwright suite and blocks `build-push`/`deploy` on failure.
4. ✅ **Resolved — dedicated rate-limiting E2E.** `test/e2e/rate-limiting.spec.ts` trips the DPM/observability limiters and asserts 429 + `Retry-After` + sanitized JSON + window recovery.
5. ✅ **Resolved — unit coverage for analytics math + playability.** `src/utils/analyticsMath.ts` extracted from the DB-bound route and covered by `test/unit/analyticsMath.test.ts`; `test/unit/devicePlayability.test.ts` covers DPM telemetry / TTL cache / retry / fallback.
6. ✅ **Resolved — `test_api.js` retired.** Removed (redundant with the E2E suite and `smoke:postdeploy`); the `test:api` script was deleted.
7. ✅ **Resolved — coverage thresholds enforced.** Q3 runs `vitest --coverage` with thresholds 55/50/45/55 (see §1.3).

---

## Appendix — quick reference numbers

- **Playwright specs:** 81 files · **407 test cases** (`playwright test --list --workers=1`)
- **Vitest unit suites:** 10 files
- **DoD hard gates:** 5 (CSpell · tsc · client syntax · Playwright E2E · git deploy)
- **Supporting scripts:** `test:unit`, `test:coverage`, `test:benchmark`, `smoke:postdeploy`, `validate:flags`, `snapshot:predeploy`
- **Gate scripts:** S1–S4 (security) + Q1–Q5 (quality) via `gates/run-all.sh`
- **CI jobs:** lint-test → test-e2e → build-push → deploy (healthz poll)
- **Current verified suite:** 407 tests across 81 spec files. The September 4, 2026 serialized baseline completed with 407 passed and 0 failed. Earlier 315-, 392-, and 405-test results are retained only as historical sprint evidence.

_Maintained by the AI operator per DoD. Regenerate by scanning `test/e2e/*.spec.ts`, `test/unit/*.test.ts`, `package.json`, `gates/`, and `.github/workflows/deploy-staging.yml`._
