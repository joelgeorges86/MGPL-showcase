# FILEMAP — MGPL Repository Map

## Project Purpose

The **Multi-Platform Game Library Dashboard (MGPL)** is a self-hosted, multi-source game library manager that unifies library ingestion, hardware playability matching, price arbitrage, mod management, retro preservation, backlog/session tracking, and PWA offline sync. See `DOCS/SYSTEM_STATE_BRIEF.md` for the authoritative current-state brief.

## Tech Stack

- **Node.js**: v22 LTS runtime
- **Express**: v4 lightweight routing/API server
- **SQLite (WAL mode)**: `better-sqlite3` — single source of truth; authoritative DDL in `src/db.ts`
- **TypeScript**: v5.5 static typing (`tsc` build, `tsx` dev)
- **Frontend**: Vanilla JS SPA (no framework) + PWA (Service Worker + IndexedDB)
- **Tests**: Playwright E2E (`test/e2e`, 80 specs / 405 recorded cases) + axe-core accessibility

## Directory Structure

- `src/` — Express backend: `index.ts` entry, `routes/` (50 modules), `services/`, `lib/`, `middleware/`, `utils/`, `seed/`, `jobs/`, and `db.ts` (authoritative DDL)
- `public/` — Frontend SPA assets: vanilla JS modules, `index.html`, `style.css`, `sw.js`, `manifest.json`, icons
- `test/` — Playwright E2E specs, `global-setup.ts`, `fixtures.ts`, `helpers/`
- `scripts/` — Enrichment, sync, diagnostics, integrity check, and gate-runner utilities
- `gates/` — DoD quality (`q1–q5`) and security (`s1–s4`) gate scripts
- `DOCS/` — Architecture, audit, UAT, and threat documentation
- `.ai/` — AI workspace changelog
- `.clinerules/` — Operating doctrine (Vibe Coding Manual)
- `backups/` — Intentional DB/snapshot audit trail (DB binaries are gitignored)

## Key Files

- `src/index.ts` — Application entry point; middleware chain; mounts all ~50 route modules
- `src/db.ts` — better-sqlite3 connection (WAL PRAGMAs) + authoritative DDL + boot self-heal + seeding
- `src/routes/state.ts` — Full state export/import/validate engine (25+ tables)
- `src/services/headroom.ts` — Playability compatibility engine (multi-axis headroom + tier derivation)
- `src/services/modManager.ts` — Mods Hub deterministic manifests, conflict detection, load order
- `src/services/scheduler.ts` — node-cron background jobs (deals, sync, DPM, mods)
- `playwright.config.ts` — E2E harness (workers:1, seeded test DB, hermetic external mocks)

## Off-Limits Zones

These files/directories are strictly off-limits for AI modification:

- `.env*` — local secrets and environment configuration
- `*.db*` / `data/` — live SQLite databases and WAL/SHM files
- `node_modules/` — package dependency tree
- `.git/` — version control internals
- `backups/` — committed audit trail (read-only reference)
