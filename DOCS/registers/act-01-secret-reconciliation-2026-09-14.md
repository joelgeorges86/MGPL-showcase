# ACT-01 Secret Name Reconciliation — 2026-09-14

## Scope and safety

This is a names-only reconciliation. No secret values were read, printed, copied, rotated, entered, or deleted. No `.env*` file was modified or removed.

Sources compared:

- Local files: `.env`, `.env.doppler.preprod`, `.env.doppler.test`, `.env.template`
- Doppler: project `mgpl`, config `dev`, queried with `doppler secrets --only-names`
- Tracked source/configuration references: `process.env.*`, `${NAME}`, shell assignments, and related environment references

## Principal Operator actions still required

1. Rotate every credential represented in the three OneDrive-synced plaintext files at its issuing provider.
2. Enter replacement values into the intended Doppler config using a secure interactive method.
3. Run:

   ```powershell
   doppler run -- npm run doctor
   doppler run -- npm run test:unit
   ```

4. Confirm both commands pass without printing secret values.
5. Delete `.env`, `.env.doppler.preprod`, and `.env.doppler.test` only after validation.
6. Review OneDrive version history and Recycle Bin for retained copies.
7. Record rotation dates and issuing providers in the private credential register, not in this repository file.

## Doppler `mgpl/dev` names observed

- `CHEAPSHARK_BASE_URL`
- `CURSEFORGE_API_KEY`
- `CURSEFORGE_API_KEY_PROFILE`
- `DATABASE_URL`
- `DOPPLER_CONFIG`
- `DOPPLER_ENVIRONMENT`
- `DOPPLER_PROJECT`
- `GAMERPOWER_BASE_URL`
- `HCLOUD_TOKEN`
- `HETZNER`
- `ITAD_API_KEY`
- `JIRA_API_TOKEN`
- `MODRINTH_API_KEY`
- `NEXUSMODS_API_KEY`
- `OPENCRITIC_API_KEY`
- `PORT`
- `PSN_NPSSO_CODE`
- `ROVO_DEV_API`
- `SENTRY_DSN`
- `SESSION_SECRET`
- `STEAM_API_KEY`
- `STEAM_ID64`
- `STEAMGRIDDB_API_KEY`
- `TS_API_ACCESS_TOKENS`
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_CLIENT_ID_API`
- `TS_OAUTH_SECRET`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRE`
- `TWITCH_CLIENT_SECRET`

## Local plaintext file names and variable names

### `.env`

- `GOG_USERNAME`
- `ITAD_API_KEY`
- `NEXUSMODS_API_KEY`
- `OPENCRITIC_API_KEY`
- `PORT`
- `PSN_NPSSO_CODE`
- `STEAM_API_KEY`
- `STEAM_ID64`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

### `.env.doppler.preprod`

- `CHEAPSHARK_BASE_URL`
- `CLIENT_ORIGIN`
- `CLOUDFLARED_TUNNEL_CREDENTIALS_B64`
- `CLOUDFLARED_TUNNEL_ID`
- `DATABASE_URL`
- `DB_PATH`
- `DISABLE_CRON`
- `DOPPLER_CONFIG`
- `DOPPLER_ENVIRONMENT`
- `DOPPLER_PROJECT`
- `JWT_SECRET`
- `NODE_ENV`
- `PORT`
- `RATE_LIMIT_MAX`
- `SESSION_SECRET`
- `TAILSCALE_AUTHKEY`

### `.env.doppler.test`

- `CHEAPSHARK_BASE_URL`
- `CLIENT_ORIGIN`
- `CLOUDFLARED_TUNNEL_CREDENTIALS_B64`
- `CLOUDFLARED_TUNNEL_ID`
- `DATABASE_URL`
- `DB_PATH`
- `DISABLE_CRON`
- `DOPPLER_CONFIG`
- `DOPPLER_ENVIRONMENT`
- `DOPPLER_PROJECT`
- `NODE_ENV`
- `PORT`
- `RATE_LIMIT_MAX`
- `SESSION_SECRET`
- `TAILSCALE_AUTHKEY`

## `.env*` names missing from `mgpl/dev`

These names appear in local plaintext files or `.env.template` but were not observed in the names-only `mgpl/dev` result:

### Runtime/application names

- `B2_ACCESS_KEY_ID`
- `B2_ENDPOINT`
- `B2_SECRET_ACCESS_KEY`
- `CLIENT_ORIGIN`
- `CLOUDFLARED_TUNNEL_CREDENTIALS_B64`
- `CLOUDFLARED_TUNNEL_ID`
- `DB_PATH`
- `DISABLE_CRON`
- `DPM_PLAYABILITY_LIMIT`
- `EPIC_OAUTH_TOKEN`
- `GAMERPOWER_BASE_URL`
- `GOG_OAUTH_TOKEN`
- `GOG_USERNAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `HW_SCAN_LIMIT`
- `JWT_SECRET`
- `MGPL_INTEGRATION_STALE_MS`
- `MGPL_TOKEN_ENC_KEY`
- `NEXUS_API_KEY`
- `NEXUS_MODS_API_KEY`
- `NODE_ENV`
- `OAUTH_REDIRECT_URL`
- `PSN_NPSSO_TOKEN`
- `PSN_OAUTH_TOKEN`
- `R2_ACCESS_KEY_ID`
- `R2_ENDPOINT`
- `R2_SECRET_ACCESS_KEY`
- `RATE_LIMIT_MAX`
- `SMOKE_BASE_URL`
- `SNAPSHOT_BASE_URL`
- `STEAM_ID`
- `TAILSCALE_AUTHKEY`
- `UBISOFT_OAUTH_TOKEN`
- `XBOX_API_KEY`

### Local `.env` names specifically missing from `mgpl/dev`

- `GOG_USERNAME`

`ITAD_API_KEY`, `NEXUSMODS_API_KEY`, `OPENCRITIC_API_KEY`, `PORT`, `PSN_NPSSO_CODE`, `STEAM_API_KEY`, `STEAM_ID64`, `TWITCH_CLIENT_ID`, and `TWITCH_CLIENT_SECRET` were observed in the Doppler names-only output.

### Preproduction/test names specifically missing from `mgpl/dev`

- `CLIENT_ORIGIN`
- `CLOUDFLARED_TUNNEL_CREDENTIALS_B64`
- `CLOUDFLARED_TUNNEL_ID`
- `DB_PATH`
- `DISABLE_CRON`
- `DOPPLER_CONFIG` — a same-named Doppler entry exists; verify config-specific value.
- `DOPPLER_ENVIRONMENT` — a same-named Doppler entry exists; verify environment-specific value.
- `DOPPLER_PROJECT` — a same-named Doppler entry exists; verify project-specific value.
- `JWT_SECRET`
- `NODE_ENV`
- `RATE_LIMIT_MAX`
- `TAILSCALE_AUTHKEY`

## Doppler `mgpl/dev` names not represented in `.env.template`

- `CURSEFORGE_API_KEY`
- `CURSEFORGE_API_KEY_PROFILE`
- `HCLOUD_TOKEN`
- `HETZNER`
- `JIRA_API_TOKEN`
- `MODRINTH_API_KEY`
- `ROVO_DEV_API`
- `TS_API_ACCESS_TOKENS`
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_CLIENT_ID_API`
- `TS_OAUTH_SECRET`
- `TWITCH_CLIENT_SECRE`

These may be tooling, infrastructure, or integration credentials rather than application runtime variables. Each requires an owner, purpose, environment, and rotation status before being classified as an application secret.

## Naming drift and duplicates requiring review

### Twitch

Doppler contains both:

- `TWITCH_CLIENT_SECRE`
- `TWITCH_CLIENT_SECRET`

The local files and source references use `TWITCH_CLIENT_SECRET`. Determine whether `TWITCH_CLIENT_SECRE` is a stale typo or a separate credential before deleting either name.

### Nexus Mods

The repository references multiple names:

- `NEXUS_API_KEY`
- `NEXUS_MODS_API_KEY`
- `NEXUSMODS_API_KEY`

Doppler currently contains `NEXUSMODS_API_KEY`. Select one canonical name only after confirming the consuming code and any deployment configuration.

### Tailscale

The repository and local environment use `TAILSCALE_AUTHKEY`, while Doppler also contains:

- `TS_API_ACCESS_TOKENS`
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_CLIENT_ID_API`
- `TS_OAUTH_SECRET`

These likely represent different Tailscale integration surfaces. Do not merge or delete them without mapping each to its consumer.

### Application versus tooling credentials

Doppler contains names that are not part of the application `.env.template`, including Jira, Rovo, Hetzner, Cloudflare-adjacent, CurseForge, Modrinth, and Tailscale-related names. Separate these into:

- Application runtime config
- Staging/deployment config
- Agent/MCP tooling config
- Human-only operator credentials
- Retired/unknown credentials

## ACT-01 status

- Names-only inventory: **complete**
- Doppler names-only inventory: **complete**
- Source/config reference inventory: **complete**
- Credential rotation: **not performed by this session; provider-side action remains Principal Operator-owned**
- Secret values entered into Doppler: **not performed by this session**
- `npm run doctor` under Doppler: **passed on September 15, 2026**
- `npm run test:unit` under Doppler: **passed on September 15, 2026 — 29 files / 180 tests**
- Plaintext `.env*` deletion: **`.env`, `.env.doppler.preprod`, and `.env.doppler.test` are absent from the worktree after `git reset --hard`; deletion provenance and retained copies are not independently verified**
- OneDrive history/Recycle Bin review: **not independently verified; browser MCP was unavailable**

## Next action

Principal Operator must rotate and enter credentials, then run the two Doppler-injected validation commands. After both pass, ACT-01 can proceed to plaintext-file removal and retention review.

## Rotation record

This table records evidence, not assumptions. No provider-side credential rotation was performed or independently verified by this session. `Not performed` means this session did not rotate the credential; `unverified` means provider revocation or historical retention was not confirmed.

| name                                        | provider            | rotation date                                          | old key revoked                |
| ------------------------------------------- | ------------------- | ------------------------------------------------------ | ------------------------------ |
| `ITAD_API_KEY`                              | IsThereAnyDeal      | Not performed                                          | unverified                     |
| `NEXUSMODS_API_KEY`                         | Nexus Mods          | Not performed; canonical variable cleanup only         | unverified                     |
| `OPENCRITIC_API_KEY`                        | OpenCritic          | Not performed                                          | unverified                     |
| `PSN_NPSSO_CODE`                            | PlayStation Network | Not performed                                          | unverified                     |
| `STEAM_API_KEY`                             | Steam Web API       | Not performed                                          | unverified                     |
| `STEAMGRIDDB_API_KEY`                       | SteamGridDB         | Not performed                                          | unverified                     |
| `TWITCH_CLIENT_ID`                          | Twitch              | Not performed                                          | unverified                     |
| `TWITCH_CLIENT_SECRET`                      | Twitch              | Not performed                                          | unverified                     |
| `SESSION_SECRET`                            | MGPL application    | Not performed                                          | unverified                     |
| `JWT_SECRET`                                | MGPL application    | Not performed                                          | unverified                     |
| `MGPL_TOKEN_ENC_KEY`                        | MGPL application    | Not performed                                          | unverified                     |
| `GOOGLE_CLIENT_SECRET`                      | Google OAuth        | Not performed; OAuth code validation only              | unverified                     |
| `CLOUDFLARED_TUNNEL_CREDENTIALS_B64`        | Cloudflare Tunnel   | Not performed                                          | unverified                     |
| `TAILSCALE_AUTHKEY`                         | Tailscale           | Not performed                                          | unverified                     |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2       | Not performed; old R2 token names removed from Doppler | provider revocation unverified |
| `B2_ACCESS_KEY_ID` / `B2_SECRET_ACCESS_KEY` | Backblaze B2        | Not performed                                          | unverified                     |

### Principal-Operator-reported rotation update

The following provider-side actions are reported by the Principal Operator and
were not independently verified by this agent. No secret values were read or
printed during this session.

| name                          | provider       | rotation date | old key revoked |
| ----------------------------- | -------------- | ------------- | --------------- |
| `STEAM_API_KEY`               | Steam          | 2026-09-14    | yes             |
| `TWITCH_CLIENT_SECRET`        | Twitch         | 2026-09-14    | yes             |
| `HCLOUD_TOKEN`                | Hetzner        | 2026-09-14    | yes             |
| `GOOGLE_CLIENT_ID / _SECRET`  | Google Cloud   | 2026-09-14    | yes             |
| `R2_*`                        | Cloudflare     | 2026-09-14    | yes             |
| `B2_*`                        | Backblaze      | 2026-09-14    | yes             |
| `SENTRY_DSN`                  | Sentry         | 2026-09-14    | yes             |
| `SESSION_SECRET / JWT_SECRET` | self-generated | 2026-09-14    | n/a             |
| `TWITCH_CLIENT_SECRE`         | Twitch         | —             | orphan, deleted |

The reported exposure involved plaintext `.env` files in the former
OneDrive-synced directory at `C:\Users\joelg\OneDrive\PC Build\MGPL`. The
repository has since moved to `C:\dev\MGPL`.
