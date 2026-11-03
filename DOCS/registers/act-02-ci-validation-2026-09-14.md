# ACT-02 CI Validation — 2026-09-14

## Scope

Added a pull-request validation workflow for PRs targeting `develop`. This workflow validates code and tests only. It does not build or push Docker images, access GHCR, join Tailscale, SSH to staging, deploy, or mutate infrastructure.

## Added workflow

- `.github/workflows/pull-request-validation.yml`

## Trigger

```yaml
on:
  pull_request:
    branches:
      - develop
```

## Validation jobs

### `lint-test`

Runs on `ubuntu-latest` and executes:

1. `npm ci`
2. `npm run lint`
3. `npm run format:check`
4. `npx tsc --noEmit`
5. `npm run test:client`
6. `npm run test:spell`
7. `npm run test:unit`
8. `bash gates/run-all.sh`

### `test-e2e`

Runs after `lint-test` and executes:

1. `npm ci`
2. `npx playwright install --with-deps chromium`
3. `npm run test:e2e`
4. Uploads `test-results/` as `playwright-traces` on failure

The repository Playwright configuration sets one worker, so the E2E job uses the required serialized execution.

## Safety verification

The new workflow contains no:

- Docker build or push action
- GHCR login
- `packages: write` permission
- Tailscale action
- SSH command
- staging deployment command
- production deployment command
- Cloudflare or infrastructure mutation

The workflow declares only:

```yaml
permissions:
  contents: read
```

## Local verification

- Workflow file is non-empty: PASS
- `pull_request` trigger targeting `develop`: PASS
- Forbidden deployment/mutation terms scan: PASS
- `git diff --check`: PASS
- Prettier check for the workflow: PASS
- Existing workflow remains push-to-`develop` staging/deployment workflow: unchanged

## External verification limitation

GitHub branch-protection inspection was attempted through `gh api` for `develop`, but GitHub returned HTTP 403 stating that branch protection requires GitHub Pro or a public repository. No branch-protection setting was changed.

Principal Operator action remains required:

1. Enable branch protection/rulesets for `develop` using the GitHub UI or an eligible GitHub plan.
2. Require the PR validation checks from this workflow.
3. Confirm `main` remains human-only for promotion.
4. Create a deliberately failing PR and verify that the required check is red and merge is blocked.

## ACT-02 status

- PR workflow added: **complete**
- Local workflow safety/content validation: **passed**
- Existing deploy workflow changed: **no**
- Branch protection enabled: **not completed; Principal Operator action required**
- Deliberately failing PR test: **not completed; requires GitHub branch protection/ruleset**
- Draft PR: **to be opened after commit/push**
