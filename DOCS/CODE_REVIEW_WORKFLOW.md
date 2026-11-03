# MGPL Code Review Workflow

Role 17 supplies independent, read-only code and security review for substantive MGPL changes: Claude Code Primary, Codex Alternate, Contingency and Emergency unassigned. Use an eligible Alternate when Primary implemented or placed the change, is unavailable or is capped. Neither reviews its own implementation or placement. This review supplements the hard gates and does not authorize merge. This workflow becomes effective by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; the transition itself uses the pre-amendment Codex rule.

1. Work on a `feature/*` branch created from `develop` in an isolated worktree when another harness may be active.
2. Run `npm run doctor` then `npm run gates` (the canonical gate chain — see `AGENTS.md` §4).
3. Review the approved WUD or applicable source specification, diff against `develop`, affected tests, security implications and governance requirements. Claude Code performs the assigned read-only review. When Codex is assigned, enter `/review` and select **Review against a base branch** with `develop` as the base. For unfinished local work, select **Review uncommitted changes** first.
4. Resolve every actionable P0/P1 finding. Resolve lower-priority findings or document why they are accepted.
5. Re-run affected gates after fixes. Repeat the assigned review on every new head; for Codex use `/review`, and for Claude Code repeat its read-only examination. A material diff change requires re-review, and even a nonmaterial new commit makes the previous review stale.
6. Open the PR to `develop` with `gh pr create --base develop --head feature/[branch-name] --title "..." --body-file [real-path]`, including gate results, review findings, risks, and deployment notes.

   Confirm `gh auth status` shows you are logged in as `joelgeorges86` (with at least `repo` scope) first, and double-check that `--base develop` and `--head feature/[branch-name]` are the right way around - a reversed PR creates a no-op merge that looks successful but delivers nothing.

   If the GitHub MCP tool or `gh` fails with `Bad credentials`, `Authentication Failed`, `401`, `403`, a missing/expired token, or insufficient scopes, do not treat GitHub as unavailable. Move to the next working route:

   1. GitHub MCP tool, if authenticated and available.
   2. GitHub CLI high-level commands (`gh pr view/comment/checks`, `gh issue create`).
   3. GitHub CLI low-level REST, for example `gh api repos/joelgeorges86/MGPL/...`.
   4. Standard git remote transport (`git push origin feature/[branch-name]`), then open the PR from the browser UI.
   5. Browser GitHub UI navigation (manual user flow).
   6. Human escalation / handoff with a sanitized summary of the failed route and the exact error.

   Never print or log tokens or secrets; report route names and sanitized errors only. This ladder does not change branch or deployment restrictions (see AGENTS.md section 5).

The assigned review must remain read-only. It reports prioritized findings and does not grant approval to merge. The review is posted on the pull request itself and names the commit SHA it reviewed; it goes stale when the PR gains a later commit (AGENTS.md §5 steps 7-8). The Principal Operator merges to `develop` and promotes to `main` (AGENTS.md §5 steps 9-10); no agent performs either while agent merge authority is suspended pending #63.

The PR body records implementing and placing lanes, actual models and efforts, WUD path and SHA-256, WUD author and upstream vendor, and the separation check. WUD may be `none` with a reason; retain applicable source-package or specification path/hash/author provenance. The review comment names the reviewer lane, actual model and effort, full reviewed head SHA and implementing/placing lanes reported in the PR. Non-secret account and host references support the check; shared-token attribution is self-reported, not identity proof (§10.2).

The option-(b) pairing of a Claude Desktop WUD, OpenAI implementation and Claude Code review shares Anthropic provider/account between specification and review. Its named risk is CF-REVIEW in 04 §3, adopted only through AGENTS.md §16. Artifact-level restrictions still apply. Claude Code fallback requires ChatGPT WUD authorship or substantive re-authorship, required independent document audit, and Codex as reviewer. A change of reviewer never cures WUD-author/implementer vendor overlap. If neither reviewer is eligible and available, work waits.

For the one-time transition see AGENTS.md §16: Cline × ChatGPT Subscription places, Claude Code formally document-audits the placed head under current Role 14 E, Codex performs the existing `/review`, and the operator merges. Formal audit and PR review name the same placed head and are renewed after every new commit. Advisory Claude Desktop or DeepSeek input cannot replace either. No conclusion about retained Codex-source authorship or reviewer independence is granted by this workflow.

## Governance transition for #139 (AI-070)

For this amendment, the current Codex §5 review remains required. The operator accepts that review provided Codex and Claude agree on the same final placed head, with their actual assessments recorded at the same commit SHA. This conditional review arrangement does not replace the formal placed-head document audit, mandatory gates, stale-review reruns or operator-exclusive merge. #139 stays open until its other criteria are independently verified.
