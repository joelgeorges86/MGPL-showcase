# ACT-03 Workspace Drift — 2026-09-15

## Scope

Workspace/framework drift review for MGPL. No application schema, database, environment file, credential, or OAuth implementation was changed by ACT-03. The pre-existing uncommitted OAuth fix in `src/routes/oauth.ts` was preserved.

## Changes made

1. Removed the stale `schema.prisma` file association from `.vscode/settings.json`.
2. Added `.vscode/extensions.json` with recommendations for the active MGPL stack and `prisma.prisma` in `unwantedRecommendations`.
3. Classified repository Prisma references below.

## Runtime/package verification

The following were not found in active runtime/package metadata:

- `schema.prisma` file
- `@prisma/client` dependency or import
- Prisma package dependency in `package.json` or `package-lock.json`
- Prisma import from TypeScript or JavaScript source
- Prisma generation step in `Dockerfile` or Docker Compose files
- Prisma query usage in active application code

The schema authority remains `src/db.ts` using `better-sqlite3`, consistent with `AGENTS.md`.

## Prisma reference classification

### Historical/documentation references

These references describe previous architecture or historical work and are not active Prisma runtime dependencies:

- `.ai/CHANGELOG.md` — historical notes describing Prisma removal and older enrichment work.
- `DOCS/SYSTEM_STATE_BRIEF.md` — current-state documentation that explicitly says the Prisma runtime was removed; wording should be reviewed separately if any stale historical sentence is misleading.
- `DOCS/PLATFORM_AUDIT_REPORT.md` — stale audit text still describing a Prisma schema alongside `src/db.ts`; this is documentation drift and should be corrected in a separate documentation work unit.

### Stale architectural comments or scripts

These are not active Prisma dependencies, but their wording conflicts with the current architecture and should be cleaned in a separate reviewed documentation/code-comment task:

- `scripts/auth-ddl.sql` — comments refer to `prisma db execute` and `schema.prisma` even though the current project uses raw SQL through the application/database authority.
- `src/db.ts` — comments refer to Prisma models, Prisma parity, or `schema.prisma` even though no Prisma runtime is present.
- `src/routes/state.ts` — comment refers to a `schema.prisma`-managed table.
- `test/global-setup.ts` — comments refer to Prisma parity and a regenerated Prisma client.

These references were not rewritten by ACT-03 because they are source/documentation wording changes beyond workspace drift and could obscure the historical migration record.

### Architectural prohibition

- `AGENTS.md` — authoritative current rule stating that Prisma is removed and must not be reintroduced. This is an active governance rule, not stale drift.

## Extension state

- `prisma.prisma` was installed in the VS Code environment during baseline inspection.
- Workspace `unwantedRecommendations` now identifies `prisma.prisma`.
- The extension was not uninstalled globally by ACT-03; Principal Operator may disable/uninstall it for this workspace or machine.

## Recommended workspace extensions

The new recommendations file covers the actual repository workflow:

- Node/TypeScript quality: ESLint, Prettier, CSpell
- Vanilla frontend/UI: Playwright, Tailwind CSS
- Configuration/operations: YAML, Docker, Containers, PowerShell, REST Client
- Persistence: SQLite Viewer
- Source control/CI: GitLens, GitHub Actions, GitHub Pull Requests
- Active agent harnesses: Claude Code, Cline, ChatGPT/Codex extension

## Verification

- No `schema.prisma` file found: PASS
- No Prisma package in package metadata: PASS
- No `@prisma/client` import found: PASS
- No Prisma association remains in workspace settings: PASS after ACT-03
- `.vscode/extensions.json` created: PASS after ACT-03
- OAuth working-tree change preserved: PASS; `src/routes/oauth.ts` remains the only pre-existing application-code modification
- `.env`, `.env.doppler.preprod`, `.env.doppler.test` untouched: PASS

## Principal Operator follow-up

1. Disable or uninstall `prisma.prisma` for this workspace/machine.
2. Create a separate reviewed work unit to clean stale Prisma wording in documentation/comments/scripts.
3. Do not reintroduce Prisma dependencies, schema files, generation steps, or query code.
