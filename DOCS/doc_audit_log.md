# Documentation Audit Log

## 2026-09-01 — first run

Baseline audit. Most of the AI MGPL doc suite (System Architecture Overview, Data Model Guide, Coding Standards, Governance & Roadmap, Environment Configuration Matrix, Backup & Disaster Recovery Plan, VS Code Setup Guide, Local Development Workflow, Developer Workstation Prep, External Integration Reference, Official Testing Inventory, AI-Assisted Testing SOP) was refreshed today (`Verified: September 1, 2026` headers) and is accurate against ground truth — correctly labels Vault/Orchestrator/Kubernetes/Prometheus/Grafana/multi-region as not deployed, correctly states real-account auth (no zero-PII claims), no Prisma references, no fictional org structure. Not re-flagging these.

Legacy folder (Master Handbook v5.1, AI Company Handbook v2, Vibe Coding Manual v5.0.6) contains the expected superseded org-doctrine content — working as intended, not flagged.

New findings:

1. **AGENTS.md has drifted out of sync across its 3 copies.** Repo-root `MGPL/AGENTS.md` (canonical) includes a step 4 requiring `Codex /review` against `develop` (referencing `DOCS/CODE_REVIEW_WORKFLOW.md`) and references `$mgpl-gate-runner` in step 3. The mirror at `AI MGPL/AGENTS.md` and the duplicate file `AI MGPL/MGPL_Development_Rules.md` (identical content, different filename) both lack this step — they're stale copies of an older revision. Per AGENTS.md's own instruction ("do not maintain separate copies of these rules elsewhere"), these should be resynced to match the repo-root version, and `MGPL_Development_Rules.md` should probably be deleted rather than kept as a second duplicate.

2. **Stray legacy-style doc in repo root.** `MGPL/Vibe Coding Manual v5.0.3.docx` sits directly in the repo root (not in `DOCS/`), superseded by `AI MGPL/Leagecy/Vibe Coding Manual v5.0.6.docx`. Should be removed from the repo root or moved into Legacy alongside the newer version.

3. **`MGPL_Test_PreProd_Decision_Memo.docx` is stale and didn't get today's refresh.** Still says "Prepared for partner review · Status: Draft for approval" (no partner exists — solo operator), and its infra-readiness table lists Reverse Proxy/TLS, Networking/Ingress, and Data Safety/Backups as "🔴 Missing" — all of which (Caddy, Cloudflare Tunnel, Litestream) are now deployed per ground truth. It also cites "120/120 Playwright tests passing," which conflicts with the current Official Testing Inventory (80 spec files / 405 cases). Needs a refresh pass or should move to Legacy if the decision it documents is already settled.

### Fixes applied same day (2026-09-01)

- Resynced `AI MGPL/AGENTS.md` to match the canonical repo-root version (added the missing Codex `/review` step and `$mgpl-gate-runner` reference).
- Deleted `AI MGPL/MGPL_Development_Rules.md` (the stale duplicate of AGENTS.md).
- Moved `MGPL/Vibe Coding Manual v5.0.3.docx` out of the repo root into `AI MGPL/Leagecy/`, alongside the newer v5.0.6.
- Updated `MGPL_Test_PreProd_Decision_Memo.docx`: header now reads "Status: Implemented — deployed to production"; removed "partner review" / dual sign-off language in favor of a single "Decided by: Joel Georges, Principal Operator" line; flipped the four now-resolved infra rows (Hosting & Hardware, Networking & Ingress, Reverse Proxy & TLS, Data Safety & Backups) from Missing/red to Ready/green with their actual current state (Hetzner VPS, Cloudflare Tunnel DNS, Caddy + Let's Encrypt, Litestream → R2/B2); replaced the hardcoded "120/120 Playwright tests passing" with a pointer to `DOCS/TEST_INVENTORY.md` so it can't go stale again. Left the "Recommended Action Plan" section (§5) untouched — those sub-steps may be partially done but weren't part of the original audit finding and weren't independently verified.

## 2026-09-14 — scheduled run (partial — tooling outage)

**Tooling limitation, reported per instructions rather than guessed around:** the sandbox shell was unreachable all run (a known Windows-update mount issue breaking the workspace VM), and the file-read tool refuses binary `.docx` files outright. Between the two, none of the ~90 `.docx` files under `AI MGPL/` (System Architecture Overview, Governance & Roadmap, Data Model Guide, every PI-003/004/005 PMO doc, the Joint AI Operational Plan series v1.0–v3.3, the AI-vendor whitepapers, Sprint Reviews, `MGPL_Test_PreProd_Decision_Memo.docx`, etc.) could be opened or fact-checked this run. Everything below is from the `.md` files only (repo root, `DOCS/`, and a filename-level pass over `AI MGPL/`) — this is not a full repeat of the 2026-09-01 baseline and should not be read as one.

Re-checked and still clean (no re-flag needed): repo root has no stray Legacy-style docx (the 09-01 fix held), `AI MGPL/Leagecy/` contents are unchanged plus the relocated v5.0.3, `CLAUDE.md` (root and `DOCS/`) are clean `@AGENTS.md` import pointers, `DOCS/AGENTS.md` is a clean pointer (not a drifting copy), and no `MGPL_Development_Rules.md` duplicate has reappeared. All `.md` docs actually read this run (`SYSTEM_STATE_BRIEF.md`, `TEST_INVENTORY.md`, `UAT-GO-NOGO.md`, `PLATFORM_AUDIT_REPORT.md`, `SPRINT_REFERENCE_MAP.md`, `Environment_Configuration_Matrix_Test_Preprod_DIFF.md`, `DPM_PLATFORM_HUB_DEFECT_TRIAGE.md`, `BDR_DRILL_LOG.md`, `CODE_REVIEW_WORKFLOW.md`) check out: no zero-PII claims, no fictional org structure, Prisma mentioned only where explicitly marked historical/removed, infra described consistently with ground truth.

New findings:

1. **`AGENTS.md` mirror is gone from `AI MGPL/` entirely.** The 09-01 entry describes resyncing this mirror; a filename search of the whole `AI MGPL/` tree (any extension) now finds no `AGENTS.md` there at all — not stale, just absent. Could be an intentional consolidation (single-sourcing at the repo root only) or a dropped file. Worth Joel confirming which; not restored automatically.
2. **New stray legacy-style doc, this time in `DOCS/` rather than the repo root.** `MGPL/DOCS/archive-02-routing-and-escalation-v5.0.2.md` — a "Model Routing & Escalation Protocol (Vibe Coding Manual v5.0.2)" describing a three-engine model-routing architecture (DeepSeek/Gemini/Nemotron tiers with escalation rules E-01–E-07). This isn't just outdated, it's a different fictional model-routing layer than current ground truth (only Cline/Claude Code/Codex are real; `AGENTS.md` has no such routing/escalation system). The `archive-` filename prefix suggests someone already meant to retire it but it was left in the live `DOCS/` folder instead of moved to `AI MGPL/Leagecy/`.

Not flagged as new: the `.tmp_master_plan_v2`, `.tmp_chatgpt_whitepaper`, and `.tmp_whitepaper_review` dot-folders under `MGPL/` hold duplicate copies of whitepapers/plans also filed under `DOCS/` or `AI MGPL/` — these read as scratch/working directories (dot-prefixed, likely gitignored) rather than published documentation, so not treated as drift risk this run.

## 2026-09-28 — scheduled run

Full pass this time: all `.md`/`.docx` under `AI MGPL/` (root, `Leagecy/`, `PMO/`) plus repo root and `DOCS/` (including everything new under `DOCS/registers/`, `DOCS/research/`, `DOCS/specs/`, `DOCS/build/` since 09-14 — roughly 35 files tied to ACT-05/07/08 work, the AI-043/AI-056 fixes, and the G-3 restore drill).

New finding:

1. **Live `.clinerules/` files still carry the pre-AGENTS.md model-routing fiction — first time this directory has been checked.** `.clinerules/01-core-contract.md` ("Executive Manager 4-Step Operating Loop") and `.clinerules/02-workforce-routing.md` ("Hybrid Three-Engine Architecture": `deepseek-v4-flash/pro`, `claude-sonnet-5/opus`, `gemini-3.6-flash` tiers, E-01–E-07 escalation ladder) are near word-for-word the same routing/escalation doctrine as the already-flagged (09-14) `DOCS/archive-02-routing-and-escalation-v5.0.2.md` — except these two are _not_ archived, they're the live files Cline actually loads as its rule set. `.clinerules/00-README.md` does carry an explicit precedence note ("AGENTS.md wins on conflict"), so it isn't asserted as unqualified truth, and its last edit (2026-09-01, same day as the baseline audit) predates every prior audit — but no prior run had looked inside `.clinerules/` to catch it. Since AGENTS.md states plainly that there's "no multi-agent override infrastructure" and only Cline/Claude Code/Codex are real, this is worth a cleanup pass (or Joel's explicit call to leave it as subordinate legacy doctrine) rather than leaving two near-duplicate fictional routing docs live in the repo.

Still open, not new (carried from 09-14, unresolved):

- `DOCS/archive-02-routing-and-escalation-v5.0.2.md` is still sitting in live `DOCS/`, not moved to `AI MGPL/Leagecy/`.
- The `AGENTS.md` mirror is still absent from `AI MGPL/` entirely (no restore, no filename anywhere in that tree).

Checked and clean, nothing to report:

- All new `DOCS/registers/`, `DOCS/research/`, `DOCS/specs/`, `DOCS/build/` files (act-01 through act-08, baseline, harness-inventory, mcp-role-profiles.json, tools.md, the AGENTS.md-amendment probe-authorization spec, GitHub Project SOP spec): no zero-PII claims, no fictional org structure (the harness-inventory and role-profile docs describe real AI-agent tooling routes, not a company org chart), Prisma referenced only as explicitly-removed history, infra consistently described as deployed-vs-target-state per ground truth. One apparent hit on "Vault/Kubernetes/Prometheus" in `DOCS/research/act08-runs/p2-context-cache-20260925T000720Z.json` turned out to be a Gemini context-cache probe echoing AGENTS.md's own correct text back at it, not a doc claim.
- `DOCS/TEST_INVENTORY.md` test count updated cleanly to 81 specs / 407 cases; nothing else references a stale count.
- `MGPL_Test_PreProd_Decision_Memo.docx` (repo `DOCS/`) still reads clean from the 09-01 fix — "Implemented — deployed to production," real infra rows, no partner-review language, count now points at `TEST_INVENTORY.md` instead of a hardcoded number.
- No stray legacy-style doc reappeared in the repo root; no reappeared `MGPL_Development_Rules.md` duplicate; `CLAUDE.md` (root and `DOCS/`) and `DOCS/AGENTS.md` are still clean pointers, not drifting copies.
- New `AI MGPL/PMO/` drafts since 09-14 (Gemini/Copilot Capabilities & Role Proposals, Joint AI Agent Operating Plan v3.4/v3.5, "Using GitHub Projects as MGPL," a Credits/billing CSV) are more of the expected proposal-pile growth in a folder meant to hold competing AI-vendor drafts — not presented as adopted/current anywhere checked.
- New `DOCS/MGPL_Joint_AI_Agent_Operating_Plan_v3_6...docx` (repo `DOCS/`, not `AI MGPL/`) is explicitly marked "PROPOSED — not yet effective — pending approval," author correctly "Joel Georges, Principal Operator" — no fictional sign-off chain.

## 2026-09-28 — same-day re-check (second run)

Re-ran shortly after the 12:18 UTC run above. Nothing in `MGPL/` changed since then (file-mtime sweep across the repo, excluding logs/db/build output, turned up only this log file itself). Independently re-verified rather than trusting the earlier entries at face value: confirmed no `AGENTS.md` anywhere under `AI MGPL/`, confirmed `.clinerules/01-core-contract.md` and `02-workforce-routing.md` are still present with their Sep 8 mtimes (still-open finding, unresolved), confirmed `DOCS/archive-02-routing-and-escalation-v5.0.2.md` is still live in `DOCS/` (still-open, unresolved), and confirmed `TEST_INVENTORY.md` and `MGPL_Test_PreProd_Decision_Memo.docx` both still read clean with no stale count/status anywhere else. Also grep-swept every top-level and `PMO/` `.docx` in `AI MGPL/` for zero-PII/anonymous-auth claims, fictional org structure, and infra-as-live claims — all mentions found are correctly framed as explicit rejections ("the phrase 'zero PII system' is rejected") or correctly labeled "pending approval" / "not yet effective" on genuinely-still-proposed specs (v3.3–v3.5). No new findings.

Noted but not flagged: `PC Build/MGPL-governance-docs` is a git worktree of this same repo (linked via `.git/worktrees/`), currently on a different branch/commit, so its `AGENTS.md` differs from the repo-root canonical copy. This is a code branch, not a published documentation mirror — out of scope for this audit and not the kind of drift risk AGENTS.md's "do not maintain separate copies" rule targets. Flagging here only for visibility in case the branch is ever left stale long-term.

### Fixes applied same day (2026-09-28, evening)

- Retired `.clinerules/01-core-contract.md` and `.clinerules/02-workforce-routing.md`: replaced the forked "Executive Manager 4-Step Operating Loop" / "Hybrid Three-Engine Architecture" (DeepSeek/Claude/Gemini tiers, E-01–E-07 escalation ladder) content with short retirement notices pointing to the real equivalents in `AGENTS.md` (§2 Harness Routing, §4 Definition of Done). Files kept (not deleted) so `.clinerules/00-README.md`'s precedence notice still has something to point at, and so Cline's directory-based rule loading doesn't silently lose numbered files. No automated model router or escalation service exists on this project; this is now stated in-file rather than left implicit.
- Moved `DOCS/archive-02-routing-and-escalation-v5.0.2.md` into `AI MGPL/Leagecy/`, alongside the other superseded Vibe Coding Manual material it belongs with. Live `DOCS/` no longer holds a copy.

Both items closes out the two still-open findings carried since 2026-09-14. Changes are local only — not committed (current branch: `feature/gate-telemetry-observation`), consistent with this log's normal "write locally, don't commit" convention; flag if you want these committed/PR'd separately.

## 2026-10-02 — archive classification executed

Executed the operator-approved archive recommendations from the Discovery classification report (`C:\dev\_staging\discovery\docs-archive-classification-2026-10-02.md`, Antigravity, 2026-10-02). 17 files moved from the `DOCS/` root, `DOCS/research/` and `DOCS/build/` into dated folders under `DOCS/archive/`: 1 to `2026-08-obsolete/`, 9 to `2026-09-superseded/` (the report's summary text says 8; its detailed list names 9, which was treated as authoritative), 2 to `2026-09-planning/`, 2 to `2026-09-obsolete/`, 1 to `2026-10-superseded/`, 2 to `2026-10-obsolete/`. No Active file was moved.

Of the 17, 7 were git-tracked and moved with `git mv` (recorded as renames in this commit). The other 10 (nine `.docx` files and the `.pi003-bak` backup) are gitignored by `*.docx` / `*.pi003-bak`, so they were moved on disk only and do not appear in the commit.

Governance references: no active governance document on `develop` references a moved file by its old path. `AGENTS.md` has no match. The five `DOCS/governance/v1.2/` files do not exist on `develop` (they live on `feature/governance-v1.2-v2`) and were not checked here. Mentions of moved files in the earlier entries of this log are historical records of what was read at the time and were left unchanged.

(Note added 2026-10-04: the sentence above about the `DOCS/governance/v1.2/` files was written on 2026-10-02, before the governance v1.2 files landed on `develop` with PR #138. The governance files are now present on `develop`; a later check of them found no references to the moved files.)

Commit: `d613989cf78bb285278f81b53e560f801057b079`

Note: the repository pre-commit hook (lint-staged: eslint/prettier) reformatted `build_v36.js`, `DPM_PLATFORM_HUB_DEFECT_TRIAGE.md` and `UAT-GO-NOGO.md` while staging the archive commit, so those three renames carry formatting-only content changes. The SHA above is the archive commit; this note and the SHA were added in a follow-up commit because amending would change the SHA.
