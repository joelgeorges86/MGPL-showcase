# MGPL (Multi-Game Preservation Library) Deployment Guide

## Production Deployment (Docker Orchestration)

MGPL v1.0.0 is containerized using a multi-stage `Dockerfile` and orchestrated with `docker-compose`.

### Prerequisites

- Docker Engine 20.10+
- Docker Compose v2.0+

### Quick Start with Docker Compose

1. Clone the repository and navigate to the project root:

   ```bash
   git clone https://github.com/joelgeorges86/MGPL.git
   cd MGPL
   ```

2. Start the production service:

   ```bash
   docker-compose up -d --build
   ```

3. Verify application health:
   ```bash
   curl -f http://localhost:4000/healthz
   curl -f http://localhost:4000/livez
   ```

### Volume Persistence

SQLite database data is persistently stored in the host `./data` directory mapped to `/app/data/mpgl_app.db` inside the container.

### Environment Configuration

Key environment variables configurable in `docker-compose.yml` or `.env`:

- `PORT`: Service port (default: `4000`)
- `NODE_ENV`: Application environment (`production` / `development`)
- `DB_PATH`: Path to SQLite database file (`/app/data/mpgl_app.db`)
- `RATE_LIMIT_MAX`: API rate limit ceiling (default: `300` per 15 minutes)

### Security Features

- Non-root container user (`USER node`).
- Production Security Headers via Helmet (CSP, HSTS, Frameguard).
- Container Health Probe monitoring (`HEALTHCHECK`).

---

## MGPL v1.1 - Staging & Pre-Deployment Scaffolding

### Staging Compose Harness (Hetzner Node)

The staging stack is defined in `docker-compose.staging.yml` and runs three
services on the Hetzner staging node:

- **`app`** — the production Node/Express build (container `mgpl-staging`).
  Maps port `4000:4000`, mounts the shared `./data:/data` volume, and
  overrides the environment with `NODE_ENV=staging`,
  `DB_PATH=/data/mgpl-staging.db`, `RATE_LIMIT_MAX=100000`, and
  `DISABLE_CRON=true` (the scheduler honors this flag and skips background
  sync jobs). Restart policy is `unless-stopped`.
- **`litestream`** — sidecar replication container sharing the `/data`
  volume with `app` and mounting `./litestream.yml` read-only.
- **`caddy`** — internal reverse proxy sidecar mounting `./Caddyfile` to
  `/etc/caddy/Caddyfile`, listening on `2080` for Cloudflare Tunnel ingress.

Secrets are injected at runtime by Doppler:

```bash
doppler secrets download --config dev --format docker --no-file > .env.doppler
docker compose -f docker-compose.staging.yml up -d --build
```

CI/CD rolling deploys only recreate the `app` service without touching the
`litestream`/`caddy` sidecars:

```bash
docker compose -f docker-compose.staging.yml pull
docker compose -f docker-compose.staging.yml up -d --no-deps app
```

The staging healthcheck uses `wget --spider` against `/healthz` (the runner
image installs both `curl` and `wget`).

### Litestream SQLite Replication

`litestream.yml` replicates `/data/mgpl-staging.db` to two independent
S3-compatible object stores:

- **Primary — Cloudflare R2** (`mgpl-db-replica`): endpoint `${R2_ENDPOINT}`,
  credentials `${R2_ACCESS_KEY_ID}` / `${R2_SECRET_ACCESS_KEY}`, 1-second
  sync-interval, 168h (7-day) retention.
- **Secondary — Backblaze B2** (`mgpl-db-backup`): endpoint `${B2_ENDPOINT}`,
  credentials `${B2_ACCESS_KEY_ID}` / `${B2_SECRET_ACCESS_KEY}`, 30-second
  sync-interval, 168h (7-day) retention.

The app applies `PRAGMA journal_mode = WAL`, `busy_timeout = 5000`, and
`foreign_keys = ON` on connection boot (`src/db.ts`), which is required for
Litestream continuous WAL replication. All credentials are supplied via
Doppler at runtime.

Post-restore integrity is validated by the PI-004 recovery drill with
`src/scripts/verify-restored-db.ts` (compiled to
`dist/scripts/verify-restored-db.js` and executed inside the isolated restored
app container), which asserts `PRAGMA integrity_check` returns `ok`,
`PRAGMA foreign_key_check` reports zero violations, and the 10 required tables
declared in its `REQUIRED_TABLES` list are present.

### Reverse Proxy & Ingress

- `Caddyfile` listens on internal port `2080` (Cloudflare Tunnel ingress),
  routes `staging.mgpl.io` and `mgpl.io` to the `app:4000` upstream over the
  Compose network, applies HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, strips the `Server`
  banner, and emits structured JSON access logs to `/var/log/caddy/access.log`.
- `cloudflared/config.yml` maps both hostnames to `http://localhost:2080` with
  a 404 catch-all. TLS terminates at Cloudflare; the origin is plain HTTP on
  the loopback interface.

### CI/CD Staging Pipeline

`.github/workflows/deploy-staging.yml` triggers on every push/merge to
`develop` and runs four sequential jobs:

1. **Lint & Test** — `npm ci`, `npx tsc --noEmit`, `npm run test:client`,
   `npm run test:spell`, `npm run test:unit`, then the master gate suite
   `bash gates/run-all.sh` (Security S1–S4 + Quality Q1–Q5).
2. **Playwright E2E Suite** — installs Chromium (`npx playwright install
--with-deps chromium`) and runs `npm run test:e2e` (the full 407-test
   suite, serialized on the seeded `./data/test_mgpl.db`).
3. **Build & Push** — gated on jobs 1 and 2 both passing; multi-stage Docker
   build pushed to GitHub Container Registry (`ghcr.io`), tagged with both the
   commit SHA and the floating `staging` tag.
4. **Deploy over Tailscale** — joins the Tailnet with a Tailscale OAuth API
   client (`secrets.TS_OAUTH_CLIENT_ID` + `secrets.TS_OAUTH_SECRET`; the
   runner is an ephemeral node tagged `tag:ci`), SSHes to the staging node
   over its Tailscale IP, runs `docker compose -f docker-compose.staging.yml
pull && ... up -d --no-deps app`, then polls `/healthz` in a retry loop
   until HTTP 200.

   > **Tailscale OAuth setup (Principal Operator):** create an OAuth API
   > client at https://tailscale.com/s/oauth-clients with the writable
   > `auth_keys` scope and permission to apply the `tag:ci` tag; ensure the
   > tailnet ACL allows `tag:ci` to reach the staging node. Store the client
   > ID/secret as GitHub repository secrets `TS_OAUTH_CLIENT_ID` and
   > `TS_OAUTH_SECRET` (replacing the old `TS_AUTHKEY`).
