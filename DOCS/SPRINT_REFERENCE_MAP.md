# Sprint Reference Map & Numbering Convention

**Purpose:** Reconcile the two sprint-numbering schemes that coexist in this repository and define the canonical convention going forward. This document is the single source of truth for "what shipped when" — see also `DOCS/SYSTEM_STATE_BRIEF.md` and `.ai/CHANGELOG.md`.

---

## 1. The two schemes

| Scheme | Range | Where it appears |
|---|---|---|
| **Project sprints** | S1 – S35 | Source-file headers (`src/**`, `public/**`), `DOCS/PLATFORM_AUDIT_REPORT.md` (S1–S27) |
| **Git delivery sprints** | Sprint 1A – 7 | Git commit subjects, merge PR titles, recent `.ai/CHANGELOG.md` entries |

The two are **not** a 1:1 renumbering of the same events. The git scheme is the current, compressed delivery cadence (Sprint 1A through Sprint 7 covering the last several release cycles); the project scheme is the original long-running feature backlog (S1 through S35). FEAT/EPIC/WUD/PI-GTM identifiers are the stable cross-scheme links.

## 2. Canonical convention (going forward)

1. **Primary anchor** — the unique tracking identifier, in this order of preference:
   `FEAT-XXXX` → `EPIC-XXXX` → `WUD-X.X` → `PI-GTM-XXXX`.
2. **Project sprint** — appended in parentheses when known, e.g. `FEAT-0149 (S17)`.
3. **Git delivery sprint** — never embedded in source headers; reference it in commit messages and the CHANGELOG only.
4. Source headers must use the project scheme (`S N`) **only** when it is verifiable from this map; otherwise omit the sprint label and keep the tracking ID.

## 3. FEAT/EPIC → project sprint map (verified)

| Tracking ID | Project sprint | Feature |
|---|---|---|
| FEAT-0149 | S17 | State export/import engine (`src/routes/state.ts`) |
| FEAT-0152 | — | Backlog analytics visualizer (`public/analytics.js`, `src/routes/analytics.ts`) |
| FEAT-0153 | S28 | Backlog planning, priority scoring & play session tracking (`src/routes/backlog.ts`, `src/db.ts`) |
| FEAT-0156 | S24 | Custom tags, smart binders & player notes (`src/routes/notes.ts`, `src/routes/games.ts`) |
| FEAT-0157 | S25.1 | Price alert automation, historical low radar & pure-SVG sparklines |
| FEAT-0158 | S25 | Wishlist key retailers, DLC catalog, DRM/offline/moddability matrix (`src/routes/alerts.ts`) |
| FEAT-0159 | S26 | Retro preservation hub — legal re-releases (`src/routes/retro.ts`, `public/retro.js`) |
| FEAT-0161 | S27 | Full-platform mock seeding & E2E validation harness (`src/routes/mock.ts`) |
| FEAT-0162 | S28 | Play session stopwatch (`public/app.js`, `public/index.html`) |
| FEAT-0166 | S32 | Live storefront price sync, deal alerts & web notifications (`src/services/dealSync.ts`, `public/app.js`, `public/wishlist.js`) |
| FEAT-0167 | S33 | Custom theme engine, reusable focus helpers, PWA install prompt (`public/app.js`) |
| FEAT-0168 | S34 | gzip compression, SQLite query-optimization indexes, perf telemetry (`src/index.ts`, `src/db.ts`, `src/routes/analytics.ts`) |
| FEAT-0169-V1-RELEASE-GATE | S35 | Container health probes (`src/routes/health.ts`) |
| FEAT-0145 | — | Deals hub, CheapShark integration, historical low alerts & wishlist sync (`test/e2e/deals-hub.spec.ts`) |
| FEAT-0159/S31 | S31 | Retro client ROM patcher, CRC32 validator, save-state slots, Gamepad API (`public/retro.js`) |

## 4. EPIC → project/git sprint map (verified)

| EPIC | Git delivery sprint | Feature |
|---|---|---|
| EPICSEC01 | Sprint 1A | Unified ingestion validation (`safeCoerce` hydration) |
| EPICSEC04 | Sprint 1A | Backend error sanitization (`errorSanitizer.ts`) |
| EPICSEC02 | Sprint 1B | Domain whitelist governance / mod-link re-sanitization |
| EPICSEC06 | Sprint 1B | Device Playability Matrix observability |
| EPIC-01 | Sprint 2 | Cross-platform profile sync, AES-256-GCM token vault (`WUD-2.1`) |
| EPIC-02 | Sprint 2 | Deal arbitrage & price history (`WUD-2.2`) |
| EPIC-03 | Sprint 2 | Multi-genre filtering engine & paginated catalog (`WUD-2.3`) |
| FEAT-MULTITENANT | Sprint 2 | User-scoped tags, notes, wishlist, alerts |
| EPICUX02 | Sprint 3 | Game Discovery 2.0 — mood rails + Surprise Me (`WUD-3.2`) |
| EPICUX03 | Sprint 3 | Gamer Profile foundations & privacy dashboard (`WUD-3.3`) |
| FEAT-OAUTH-0001 | Sprint 3 | Google OAuth 2.0 + Steam OpenID 2.0 |
| EPICUX04 | Sprint 4 | Mods Hub 2.0 — detail pages, conflicts, load order |
| EPICUX05 | Sprint 5 | Hardware Explorer 2.0 — PII-free scan, tiered compatibility |
| EPIC-07 | Sprint 5 | Server-side analytics role gating |
| EPIC-06 | Sprint 5 | HTTPS + exact-match whitelist for mod ingestion |
| EPIC-04 | Sprint 6 (PI-GTM-2026-001) | Canonical platform taxonomy (`platformTaxonomy.ts`) |
| PI-GTM-2026-002 | Sprint 6 | Integration observability, freshness headers, UAT GO |
| GAP-001..006 | Sprint 6.1 | Hardened remediation patch |
| WUD-7.1..7.5 | Sprint 7 | Game synopsis, Steam spec enrichment, retro resource hub, break-fixes |

## 5. Audit-report sprint table (historical S1–S27)

Per `DOCS/PLATFORM_AUDIT_REPORT.md` §1.1: S1–S8 scaffolding · S9–S14 detail drawer/platform matrix/composite scoring · S15–S16 splash + platform hub · S17 state export/import · S18–S19 compare matrix + fleet · S20–S22 deals hub · S23 compare E2E + playability tiers · S24 tags/notes · S25.1 price alerts · S25.2 wishlist/DRM · S26 retro · S27 mock seeding.

---
*Canonical sprint reference. Source headers use the project scheme; git history uses the delivery scheme; this map links them via FEAT/EPIC/WUD/PI-GTM identifiers.*
