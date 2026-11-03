# MGPL Tool Qualification Register

## Register metadata

- Reviewed: 2026-09-15
- Scope: MCP servers involved in Cline/VS Code role profiles
- Credential policy: names and credential-field names only; no credential values recorded
- Active canonical Cline MCP configuration: `C:\Users\joelg\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Legacy Cline CLI/data MCP configuration: moved outside the active path to `C:\Users\joelg\.cline\data\settings\cline_mcp_settings.legacy-disabled-20260915.json`
- Infrastructure profile: disabled by default

## Environment facts

- GitHub repository branch protection is implemented through repository rulesets,
  not the classic branch-protection endpoint. The authoritative verification
  routes are `gh api repos/joelgeorges86/MGPL/rules/branches/develop` and
  `gh api repos/joelgeorges86/MGPL/rules/branches/main`.
- As of 2026-09-15, `develop` is covered by ruleset `23483712` and `main` is
  covered by ruleset `23484013`. The classic `/branches/<branch>/protection`
  endpoint returns 404 for these branches because no classic protection object
  exists.
- Both rulesets expose four rules: deletion protection, non-fast-forward
  protection, pull-request requirements, and required-status-check policy.
- The ruleset endpoint currently reports the unsuffixed required-status-check
  values `Pull Request Validation / Lint & Test` and `Pull Request Validation /
Playwright E2E Suite` for both branches; strict required-status policy is
  enabled on `develop` and disabled on `main` as of the recorded verification.
- The current GitHub working contexts reported for the `pull_request` event are
  `Pull Request Validation / Lint & Test (pull_request)` and `Pull Request
Validation / Playwright E2E Suite (pull_request)`. Record both forms because
  the ruleset API and the check-context display can differ.
- The deliberate-failure verification associated with PR #41 is
  **Principal-Operator-reported and not independently verified by this agent**.
  The Principal Operator reported observing the merge control disabled in the
  GitHub interface on 2026-09-17. The available API metadata for PR #41 only
  establishes that the PR was closed and that its Lint & Test and Playwright E2E
  checks completed successfully; it does not independently establish the
  disabled merge-control observation.

## Appendix J field table

| Name                   | Type                     | Publisher / maintainer                                                  | Exact version                                                           | Source repository / endpoint                                                             | Transport       | Credentials required (names only)                            | Reachable systems                                             | Read/write capability                                                   | Default state | Role profiles                                            | Package integrity / qualification                                                                                     | Last reviewed | Upgrade/removal owner                     | Fallback                                                        |
| ---------------------- | ------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `fetch`                | Local MCP executable     | Local reviewed executable; package origin not re-resolved during ACT-04 | Existing local executable; version not exposed by names-only inspection | `mcp-fetch-venv/Scripts/mcp-server-fetch.exe`                                            | stdio           | None recorded                                                | Public documentation/URL retrieval subject to server behavior | Read/retrieval                                                          | Enabled       | Implementation, Review, Research                         | Existing local executable retained; version qualification remains open                                                | 2026-09-15    | Principal Operator / tool owner           | Browser or official documentation route                         |
| `sqlite`               | npm MCP server           | `spences10` maintainer; no repository URL published in npm metadata     | `mcp-sqlite-tools@0.1.0`                                                | npm registry package `mcp-sqlite-tools`; source repository not published in npm metadata | stdio           | `SQLITE_DEFAULT_PATH`                                        | Local MGPL data directory when enabled                        | Potential database read/write; disabled until reviewed                  | Disabled      | Conditional Implementation; conditional Infrastructure   | Exact npm version verified; publisher/source qualification incomplete; marked non-first-party and disabled by default | 2026-09-15    | Principal Operator / tool owner           | Repository SQLite scripts and SQLite CLI                        |
| `playwright`           | Browser automation MCP   | Microsoft Playwright MCP maintainers                                    | `@playwright/mcp@0.0.81`                                                | `https://github.com/microsoft/playwright-mcp.git`                                        | stdio           | None recorded                                                | Browser pages permitted by the active browser profile         | Browser read/action capability; state-changing actions require approval | Disabled      | Conditional Implementation, Review                       | Exact version verified through npm metadata; Apache-2.0; official Microsoft Playwright MCP source                     | 2026-09-15    | Principal Operator / tool owner           | Committed Playwright CLI/tests and VS Code Playwright extension |
| `cloudflare-api`       | Hosted MCP server        | Cloudflare                                                              | Remote endpoint; server version not exposed                             | `https://mcp.cloudflare.com/mcp`                                                         | Streamable HTTP | Provider OAuth or approved Cloudflare token; names only      | Cloudflare account/zone resources authorized by the session   | Potential broad read/write; disabled by default                         | Disabled      | Conditional Infrastructure only                          | Official Cloudflare endpoint; local OAuth state removed; provider-side revocation not independently verified          | 2026-09-15    | Principal Operator / infrastructure owner | Cloudflare dashboard or approved API route                      |
| `google-bigquery`      | Hosted MCP server        | Google Cloud                                                            | Remote endpoint; server version not exposed                             | `https://bigquery.googleapis.com/mcp`                                                    | Streamable HTTP | Google Cloud OAuth/ADC or provider authorization; names only | Authorized BigQuery projects/datasets                         | Potential read/write; disabled by default                               | Disabled      | Conditional Infrastructure only                          | Official Google endpoint; no active role profile enabled                                                              | 2026-09-15    | Principal Operator / cloud owner          | `gcloud`/official Google Cloud tools                            |
| `google-cloud-storage` | Hosted MCP server        | Google Cloud                                                            | Remote endpoint; server version not exposed                             | `https://storage.googleapis.com/storage/mcp`                                             | Streamable HTTP | Google Cloud OAuth/ADC or provider authorization; names only | Authorized GCS buckets/objects                                | Potential read/write; disabled by default                               | Disabled      | Conditional Infrastructure only                          | Official Google endpoint; no active role profile enabled                                                              | 2026-09-15    | Principal Operator / cloud owner          | `gcloud`/official Google Cloud tools                            |
| `atlassian`            | Hosted MCP server        | Atlassian                                                               | Remote endpoint; server version not exposed                             | `https://mcp.atlassian.com/v1/mcp/authv2`                                                | Streamable HTTP | Atlassian OAuth; names only                                  | Authorized Jira/Confluence/Atlassian resources                | Potential read/write; disabled by default                               | Disabled      | Conditional Review, Research; conditional Infrastructure | Official Atlassian endpoint; consolidated with the duplicate `jira` route; local OAuth state removed                  | 2026-09-15    | Principal Operator / Atlassian owner      | Atlassian UI/API                                                |
| `microsoft-learn`      | Hosted documentation MCP | Microsoft                                                               | Remote endpoint; server version not exposed                             | `https://learn.microsoft.com/api/mcp`                                                    | Streamable HTTP | None recorded                                                | Microsoft Learn documentation                                 | Read/retrieval                                                          | Disabled      | Research; conditional Review                             | Official Microsoft Learn endpoint; disabled in the canonical default configuration                                    | 2026-09-15    | Principal Operator / tool owner           | Browser or Microsoft Learn search                               |

## Removed or disabled entries

| Entry                                                | Disposition                                 | Reason                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `filesystem`                                         | Removed from canonical active configuration | Duplicated native Cline file access; unnecessary workspace filesystem exposure                                                |
| `memory`                                             | Removed from canonical active configuration | Persistent cross-task memory was not required and added stale-data/privacy risk                                               |
| `github.com/executeautomation/mcp-playwright`        | Removed from canonical active configuration | Duplicate browser implementation; official Microsoft Playwright MCP retained                                                  |
| `github` using `@modelcontextprotocol/server-github` | Removed from canonical active configuration | Legacy package route; official GitHub MCP server is not installed through this legacy npm package in the active configuration |
| `jira`                                               | Removed from canonical active configuration | Duplicate Atlassian endpoint; `atlassian` is the single retained route                                                        |
| `MCP_DOCKER`                                         | Removed from canonical active configuration | Infrastructure gateway was broad and not required for routine work; infrastructure remains disabled by default                |

## Pinning results

- No active local MCP launcher uses `npx -y`.
- No active local MCP launcher uses `@latest`.
- `@playwright/mcp` is pinned to `0.0.81`.
- `mcp-sqlite-tools` is pinned to `0.1.0` and disabled by default because npm metadata did not publish a source repository.
- Hosted remote servers use fixed endpoint URLs but do not expose independently pin-able server versions; they remain disabled by default and are qualified by publisher/endpoint rather than package version.

## Security notes

- No credential value is stored in this register.
- No `.env`, `.env.doppler.preprod`, `.env.doppler.test`, or `.env.template` file was modified.
- Local Cline OAuth state for Cloudflare and Atlassian/Jira was removed before consolidation.
- Provider-side revocation and OneDrive web-history cleanup remain separately recorded as unverified where the local environment could not authenticate.
- `mcp-sqlite-tools` is third-party/non-first-party from the available package metadata and is disabled by default.
- Infrastructure and cloud-data MCP servers are disabled by default.
- MCP calls require explicit approval unless a server is independently qualified as read-only.
