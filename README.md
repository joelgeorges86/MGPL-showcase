# MGPL — Multi-Platform Game Library Dashboard

> **🚧 Work in progress — not ready for use.**
> MGPL is a personal learning project that I am still actively building and tweaking. This repository is a public snapshot shared so others can see the code, architecture, testing and documentation. It is not production software, has no support, and features may be incomplete or change without notice. Please don't deploy it or rely on it.
>
> **How it was built:** I acted as product owner and technical program manager, directing AI coding agents (Claude, ChatGPT, Gemini and Cline) through sprints, code review and automated quality gates. Development history lives in a private repository; this snapshot contains the current source only.
>
> © 2026 Joel Georges. All rights reserved. No license is granted to use, copy or distribute this code; it is shared for viewing only.

**MGPL (Machine-Advanced Global Product Laboratory)** is a self-hosted, multi-source gaming library management system. It unifies catalog ingestion, hardware playability matching, price arbitrage, mod management, retro preservation, and fleet tracking into a single offline-capable PWA.

## Key Features

- **Multi-Source Library Ingestion** — Steam, GOG, Epic, PSN, Xbox, and Ubisoft adapters plus local/CSV catalogs, with canonical platform taxonomy normalization.
- **Hardware & Playability Matching** — persisted device specs, PII-free local hardware scans, and Minimum / Recommended / Ultra compatibility tiers with multi-axis (CPU/RAM/VRAM/Storage) headroom.
- **Price Arbitrage & Deals Radar** — CheapShark, IsThereAnyDeal, GG.deals, Deku Deals, and GamerPower feeds; historical lows, 24-month sparklines, price alerts, and wishlist drops.
- **Mods Hub** — deterministic mod catalogs, dependency trees, file-conflict detection, and a SQLite-backed load-order manager.
- **Retro Preservation Hub** — legal re-release directory, curated emulator resources, and a sandboxed client-side WebAssembly runner (zero hosting of copyrighted assets).
- **Backlog & Play Sessions** — priority-scored backlog, stopwatch session tracking, completion velocity, and cost-per-hour analytics.
- **Privacy-Minimized Identity** — account data is limited to what authentication and platform linking require; public exposure is restricted to approved gaming identity/library fields, with granular consent, Global Privacy Control auto-opt-out, AES-256-GCM at-rest platform tokens, and masked handles.
- **State Snapshots** — full application JSON export/import/restore across 25+ tables.
- **Containerized Production** — Docker orchestration with Litestream replication (Cloudflare R2 + Backblaze B2), Caddy reverse proxy, and Cloudflare Tunnel ingress.

## Tech Stack

Node.js 22 · Express 4 · TypeScript 5.5 · better-sqlite3 (SQLite, WAL mode; schema authority in `src/db.ts`) · Vanilla JS PWA (Service Worker + IndexedDB) · Playwright + axe-core · Docker · Litestream · Caddy

## Quick Start (Local Development)

```bash
npm ci
npm run doctor
doppler run -- npm run dev   # starts tsx watch on http://localhost:4000
```

Full Definition-of-Done gate verification:

```bash
npm run gates
```

## Documentation

- `DOCS/SYSTEM_STATE_BRIEF.md` — authoritative current-state architecture brief
- `DOCS/PLATFORM_AUDIT_REPORT.md` — full-stack audit & volume-convergence report
- `DOCS/UAT-GO-NOGO.md` — UAT go/no-go sign-off
- `DEPLOYMENT.md` — production & staging deployment guide

## Deployment & Production

For container deployment instructions, refer to [DEPLOYMENT.md](DEPLOYMENT.md):

```bash
docker-compose up -d --build
```

## Notes

Personal project, shared publicly as a viewing-only snapshot. `.env*`, live databases (`*.db*`), and `node_modules/` are excluded and off-limits for AI tooling (see `FILEMAP.md`). CI workflows are parked in `.github/workflows-disabled/` in this snapshot so nothing runs or deploys from the public copy.
