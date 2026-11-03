# ACT-08 documentation integration findings — 2026-09-18

## Scope

This change integrates the Principal Operator-supplied ACT-08 evidence, harness inventory, proposed `AGENTS.md` amendment, current v3.6 operating-plan DOCX, and supporting builder documentation. It does **not** amend `AGENTS.md`, apply register corrections, authorize ACT-08 probes, or merge anything.

## Artifact verification

The following supplied artifacts were verified in `C:\Users\joelg\Downloads` or the current repository workspace and integrated into this branch:

- `DOCS/registers/harness-inventory-2026-09-18.md`
- `DOCS/research/ACT-08-phase1-results-and-gemini-charter.md`
- `DOCS/specs/AGENTS-md-amendment-authorized-probe-work-units.md`
- `DOCS/specs/ACT-08-google-cloud-capability-exploration.md`
- `DOCS/MGPL_Joint_AI_Agent_Operating_Plan_v3_6___Capability_Scoped_Proposed_Master_Specification.docx`
- `DOCS/build/build_v36.js`

`DOCS/build/build_v36.js` was present in the occupied repository workspace but absent from the `develop` base used for this isolated branch, so it was explicitly integrated. `DOCS/build/README.md` now documents that it requires the `docx` npm package and is not part of the application build.

## §3.1 authorization divergence

The proposed `DOCS/specs/AGENTS-md-amendment-authorized-probe-work-units.md` does not agree with the current `AGENTS.md` because the proposed section has not landed there.

The current `AGENTS.md` has no:

1. `§3.1 Authorized probe work units` section;
2. bounded billable-external-call row in the §3 authority table;
3. ACT-08 ledger entry, scope, spend guidance, or expiry;
4. scoped-credential, fixture-only, and clean-feature-branch preconditions; or
5. rule stating that chat-asserted authority never authorizes a probe.

Conclusion: the amendment remains a proposal and confers no authorization for an agent to run ACT-08 Phase 2 or batch probes. The Phase 1 calls recorded in the supplied evidence were Principal-Operator-executed, so they did not rely on agent authorization. Landing §3.1 is a separate future governance change and is not included in this integration.

## Proposed register corrections — intentionally not applied

These are recorded for review only:

1. **H-12 closes.** Remove or revise the operating-plan statement that treats parallel subagents as read-only investigation aids. The inventory found that Explore/Plan subagents retain shell access and can write indirectly.
2. **AI-028 withdrawn.** Retain `MCP_DOCKER` in the qualified/active evidence where appropriate because the inventory records an authenticated GitHub-capable route. Mark the prior removal work unit withdrawn with its reason rather than deleting the evidence.
3. **`gh api` ladder rung.** Reconcile the documented GitHub fallback ladder with local policy. The inventory reports that `.claude/settings.json` denies `Bash(gh api *)` and `PowerShell(gh api *)`, making the documented third rung unreachable under that configuration.
4. **§8 messaging wording.** Narrow the broad claim that no messaging mechanism exists. Claude-to-Claude messaging exists, while no available route reaches Codex; the Codex handoff specifically requires Principal Operator routing.
5. **`EnterWorktree` baseRef default.** Correct or explicitly override the `fresh` default so an automatically created worktree branches from `develop`, not `origin/<default-branch>`/`main`, in accordance with repository policy.
6. **`mcp_faf-mcp_*` identification.** Identify and qualify the fifteen-tool MCP server before relying on the surrounding register findings. Until identified, treat its agent, Git, and trust operations as an unqualified write-capable surface.

No item above changes repository policy in this branch.

## Validation record

The canonical PowerShell gate runner was executed after `doppler setup --project mgpl --config dev` and `npm ci`:

- Environment doctor: **passed**.
- TypeScript verification: **passed**.
- Client JavaScript syntax: **passed** — 28/28 scripts.
- Spell check: **passed** — 0 issues.
- Unit tests: **passed** — 30 files, 185 tests.
- Playwright E2E: **failed** — exit code 1. The existing suite reported failures including analytics visualization and library sorting, with repeated `hardware_price_history.priceId` uniqueness warnings during the run.
- Security/quality gate stage: **not reached** because the canonical runner stops after the Playwright failure.

The E2E failures are unrelated to this documentation-only integration and were not altered or suppressed.

## Fresh-worktree contract

After creating this worktree, the required setup was performed before validation:

1. `doppler setup --project mgpl --config dev`
2. `npm ci`

A fresh worktree lacks both Doppler scope and `node_modules`; without these steps the canonical chain fails at the environment doctor or the unit stage. This is the known five-defect worktree contract. The setup script that would automate it does not exist yet; this change does not create one.

## Unrelated checkout warning

The original checkout, `C:\dev\MGPL`, was on `feature/ai-031-doctor-git-instrumentation` with an unrelated modification to `.claude/settings.json`. The working file had been reduced to `{ "permissions": {} }` while the committed version contains the repository deny rules, including rules relevant to `gh api`. That change was not copied, reverted, or committed by this task. The original checkout requires Principal-Operator review before any commit or cleanup.
