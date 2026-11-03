# Environment Configuration Matrix — Test / Preprod Additions (DIFF)

> **Deliverable type:** Standalone diff against `MGPL_Environment_Configuration_Matrix_v1.docx`
> (`DOCS/MGPL_Environment_Configuration_Matrix_v1.docx`, Document ID `MGPL-ENG-CFG-001`, v1.0.0).
> This file is **not** the matrix — it is the exact set of additions/edits the Principal Operator
> applies to the real `.docx`. It contains **no plaintext secrets**; secret rows are marked `[SECRET]`.
>
> **Prepared:** 2026-09-09 · **Reason:** provisioning shared Test + Preprod tiers on a new Hetzner VPS.

---

## Edit 1 — Document metadata

- `Last Updated` → `September 9, 2026`
- Add a note under the title: _"Scope expanded to six environments: Local, Development, Test, Preprod, Staging, Production."_

---

## Edit 2 — Section 1.3 "Document Scope"

Change the first bullet from:

> All four MGPL deployment environments: Local, Development, Staging, and Production.

to:

> All six MGPL deployment environments: Local, Development, Test, Preprod, Staging, and Production.

---

## Edit 3 — Section 2 "Environment Overview" (add two rows)

Append two rows to the Environment Overview table, between **Development** and **Staging**:

| Environment | Short Name | Purpose                                                                                                                                                                    | Primary Users                | Infrastructure                                                                                        | Deployment Trigger                         |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Test**    | `test`     | Shared disposable integration tier. Ephemeral data, relaxed rate limits, cron disabled. Isolated SQLite (`mgpl-test.db`). No Litestream (disposable by design).            | Engineering Team, QA         | Shared Hetzner CX23 VPS (`<preprod-host>`), Cloudflare Tunnel `test.m-gpl.com`, Tailscale-only SSH    | Automatic/manual on `develop` promotion    |
| **Preprod** | `preprod`  | Pre-production mirror closest to Production durability. Litestream WAL replication enabled (R2 + B2). Isolated SQLite (`mgpl-preprod.db`). Gated behind Cloudflare Access. | QA, Product, Release Manager | Shared Hetzner CX23 VPS (`<preprod-host>`), Cloudflare Tunnel `preprod.m-gpl.com`, Tailscale-only SSH | Manual approval gate after Test validation |

---

## Edit 4 — New subsection after Section 2: "Shared Test/Preprod VPS Architecture"

> **2.x Shared non-production VPS (Test + Preprod)**
>
> Test and Preprod are co-located on a **single** shared Hetzner CX23 VPS
> (`<preprod-host>`, `hel1` / eu-central), deliberately separate from the existing
> production VPS (`ubuntu-4gb-hel1-2`). Each tier is an **independent Docker Compose stack**
> with its own application container, its own SQLite file, and its own internal port:
>
> | Property          | Test                               | Preprod                            |
> | ----------------- | ---------------------------------- | ---------------------------------- |
> | Compose file      | `docker-compose.test.yml`          | `docker-compose.preprod.yml`       |
> | SQLite file       | `mgpl-test.db`                     | `mgpl-preprod.db`                  |
> | Litestream        | Omitted (disposable)               | Enabled (mirrors prod durability)  |
> | Cloudflare Tunnel | `mgpl-test` (`b267adb7-…`)         | `mgpl-preprod` (`b70d5771-…`)      |
> | Public hostname   | `test.m-gpl.com`                   | `preprod.m-gpl.com`                |
> | Doppler config    | `test`                             | `preprod`                          |
> | SSH access        | Tailscale-only (no public port 22) | Tailscale-only (no public port 22) |
>
> Caddy runs inside each stack as an internal reverse proxy; Cloudflare Tunnel terminates TLS
> and forwards plain HTTP to each stack's Caddy. The two stacks do **not** share state with each
> other or with the production VPS. Access to both hostnames is gated behind Cloudflare Access
> (identity provider configured manually by the Principal Operator).

---

## Edit 5 — Section 3 "Configuration Matrix Table"

### 5a. Add two columns

Extend the header row from:

> `Configuration Key | Local | Development | Staging | Production`

to:

> `Configuration Key | Local | Development | Test | Preprod | Staging | Production`

### 5b. New configuration-key rows (new subsection "Tunneling & Device Join")

| Configuration Key                    | Test       | Preprod    | Notes                                                                                        |
| ------------------------------------ | ---------- | ---------- | -------------------------------------------------------------------------------------------- |
| `TAILSCALE_AUTHKEY`                  | `[SECRET]` | `[SECRET]` | Reusable pre-auth key scoped `tag:server`; machine-join credential, not env-specific data    |
| `CLOUDFLARED_TUNNEL_ID`              | `[SECRET]` | `[SECRET]` | Test `b267adb7-b152-4e59-bb04-d321f661fbe3` · Preprod `b70d5771-f640-401a-a971-6c4357bc2cf9` |
| `CLOUDFLARED_TUNNEL_CREDENTIALS_B64` | `[SECRET]` | `[SECRET]` | Base64-encoded cloudflared credentials JSON (reconstructed on the host to root-only `0600`)  |

### 5c. Test / Preprod values for existing keys

| Configuration Key                | Test                       | Preprod                       |
| -------------------------------- | -------------------------- | ----------------------------- |
| `APP_ENV` / `NODE_ENV`           | `staging`                  | `production`                  |
| `PORT`                           | `4000`                     | `4000`                        |
| `APP_BASE_URL` / `CLIENT_ORIGIN` | `https://test.m-gpl.com`   | `https://preprod.m-gpl.com`   |
| `LOG_LEVEL`                      | `info`                     | `warn`                        |
| `DATABASE_URL`                   | `file:./data/mgpl-test.db` | `file:./data/mgpl-preprod.db` |
| `DB_PATH`                        | `/data/mgpl-test.db`       | `/data/mgpl-preprod.db`       |
| `SESSION_SECRET`                 | `[SECRET]`                 | `[SECRET]`                    |
| `JWT_SECRET`                     | — (not required)           | `[SECRET]`                    |
| `RATE_LIMIT_MAX`                 | `100000`                   | `300`                         |
| `DISABLE_CRON`                   | `true`                     | `true`                        |

> **Naming rationale (final):** the shared **Test** tier uses `NODE_ENV=staging` — it must
> **not** use literal `NODE_ENV=test` (that installs hermetic external-API mocks via
> `src/services/externalMocks.ts`). **Preprod** uses `NODE_ENV=production` for strict parity,
> which additionally requires `JWT_SECRET` (see `src/lib/auth.ts`).

---

## Edit 6 — Section 4.2 "Secret Storage by Environment"

Append two rows:

| Environment | Secret Store             | Access Method                                                              | Rotation Policy                                                   |
| ----------- | ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Test**    | Doppler config `test`    | Doppler CLI injects runtime secrets into Docker Compose at container start | On compromise or team request (disposable tier)                   |
| **Preprod** | Doppler config `preprod` | Doppler CLI injects runtime secrets into Docker Compose at container start | Scheduled rotation and immediate rotation on suspected compromise |

---

## Edit 7 — Section 6 "Environment-Specific Behavior"

Add **Test** and **Preprod** columns:

| Behavior                        | Test                              | Preprod                           |
| ------------------------------- | --------------------------------- | --------------------------------- |
| SQLite WAL Mode                 | Enabled                           | Enabled                           |
| Litestream Backup / Replication | Disabled (disposable)             | Enabled                           |
| External Deal APIs              | Enabled with Doppler credentials  | Enabled with Doppler credentials  |
| Sentry Error Tracking           | Enabled when `SENTRY_DSN` present | Enabled when `SENTRY_DSN` present |
| Rate Limiting                   | Relaxed (`100000`)                | Enforced (`300`)                  |

---

## Edit 8 — Change Log (Section 10)

Append two entries:

| Date       | Entry                                                   | Action  | By                         | Notes                                                                                                                                                                           |
| ---------- | ------------------------------------------------------- | ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-09 | Cloudflare Tunnels `mgpl-test` / `mgpl-preprod`         | Created | Principal Operator + Cline | Independent locally-managed tunnels, DNS routes `test.m-gpl.com` / `preprod.m-gpl.com`. Production `mgpl` tunnel untouched.                                                     |
| 2026-09-09 | Doppler `test` / `preprod` configs + Tailscale auth key | Created | Principal Operator + Cline | `stg` environment renamed to `preprod` (slug + display name), zero-cost — resolved the 4-environment limit. Non-secret structure by Cline; secret values by Principal Operator. |

---

## Resolution notes & remaining flags

1. ✅ **Doppler 4-environment limit — RESOLVED.** `stg` was renamed to `preprod` (slug + display
   name), consuming no new environment slot. Project now has `dev`, `preprod`, `prd`, `test`.
2. ✅ **`preprod` vs `staging` overlap — RESOLVED.** `stg` _is_ now `preprod`; the abandoned
   staging tier was repurposed rather than duplicated.
3. ⚠ **`SESSION_SECRET` is mandatory** — `src/config.ts` exits(1) without a ≥32-char
   `SESSION_SECRET`, independent of `NODE_ENV`. Set in both configs (separate values).
4. ⚠ **`JWT_SECRET` required for Preprod only** — `NODE_ENV=production` throws without
   `JWT_SECRET` (`src/lib/auth.ts`). Set in `preprod` only.
5. ⚠ **Domain drift** — the matrix references `mgpl.io` / `staging.mgpl.io`, but live infra uses
   `m-gpl.com` (`app.` / `test.` / `preprod.`). Noted, not corrected here.
