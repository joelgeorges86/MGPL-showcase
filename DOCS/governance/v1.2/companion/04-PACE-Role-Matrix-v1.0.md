# MGPL PACE Role Matrix v1.0

**Version:** 1.0 (extracted from Manual v1.2)
**Date:** October 1, 2026
**Amendment authored:** October 19, 2026; effect and adoption are governed by AGENTS.md §16.
**Owner:** MGPL Governance Office (operator)

## 1. PACE Structure

| Level               | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| **P — Primary**     | Preferred Agent for the role                                    |
| **A — Alternate**   | Second choice; takes work when Primary is unavailable or capped |
| **C — Contingency** | Third choice; takes routine work or overflow                    |
| **E — Emergency**   | Last resort; used only when P, A, and C are all unavailable     |

**Emergency definition (corrected v1.2):** Emergency is used only when Primary, Alternate, and Contingency are all unavailable. Routine overflow goes to the deepest available tier that is not Primary, or waits for the Primary.

**Slot configuration:** Each slot records model, effort, tier, tool surface, and last-verified date.

**Correlated-failure rules:** No single harness, provider, account, or execution host may hold two of the four levels in any role. Where a substitution is unavoidable, record it as a correlated-failure exception with the specific risk named.

## 2. Roles and PACE Assignments

### Role 1 — Prompt Author

| Level | Agent                | Eligibility / availability                        |
| ----- | -------------------- | ------------------------------------------------- |
| P     | ChatGPT              | Different party from content writer and executor. |
| A     | Claude Desktop       | Different party from content writer and executor. |
| C     | M365 Copilot Premium | Bounded review only; no synthesis.                |
| E     | Cline × DeepSeek     | Execution inactive; §3.2 grants no spending.      |

**Named correlations:** CF-HOST; CF-MODEL. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

**Agent-specific rules:**

- The Prompter must not execute the task it writes the prompt for.
- The Prompter does not need local filesystem access.
- The Prompter must declare assumptions explicitly when source documents do not cover a needed fact.
- Prompt Author inputs (rules-digest.md, environment-state.md) must carry a commit SHA and generation date. Stop on stale input.

### Role 2 — Specifier / Architect

| Level | Agent                                                                      |
| ----- | -------------------------------------------------------------------------- |
| P     | ChatGPT (Plus) — pending bounded specification test                        |
| A     | Claude Desktop (Opus 5.5) — pending bounded specification test             |
| C     | M365 Copilot Premium — with authorship exclusion if it authored the source |
| E     | Codex                                                                      |

**Agent-specific rules:** The Specifier must not share a vendor or model family with the Implementer for the same work unit.

### Role 3 — Implementer (Frontend)

| Level | Agent                                                    | Eligibility / availability                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P     | Cline × ChatGPT Subscription / operator-designated Codex | Option (b): Claude Desktop WUD; non-OpenAI WUD only. One level, not independent backups. Codex needs an eligible local runtime and full §4 gate evidence. Cline Frontend remains conditional on citation-discipline follow-up; no clearance is claimed. |
| A     | Cline × DeepSeek                                         | Execution inactive; no §3.2 spending authorization.                                                                                                                                                                                                     |
| C     | Claude Code                                              | Unavailable for a Claude Desktop WUD. Requires ChatGPT authorship or substantive re-authorship, required independent document audit and Codex reviewer assignment; otherwise unavailable.                                                               |
| E     | Unassigned                                               | Unavailable: no assigned lane; Antigravity not qualified for this specialty.                                                                                                                                                                            |

**Named correlations:** CF-HOST; CF-OPTION. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 4 — Implementer (Backend)

| Level | Agent                                                    | Eligibility / availability                                                                                                           |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| P     | Antigravity × Gemini 3.8 Flash High                      | Assessed bounded backend or comparable specialized work only; WUD vendor/model family must differ from Google. No Argon inheritance. |
| A     | Cline × DeepSeek                                         | Execution inactive; no §3.2 spending authorization.                                                                                  |
| C     | Cline × ChatGPT Subscription / operator-designated Codex | Non-OpenAI WUD only; both routes occupy this one level. Codex needs an eligible local runtime and full §4 gate evidence.             |
| E     | Claude Code                                              | Non-Anthropic WUD only, with required independent document audit and Codex as reviewer.                                              |

**Named correlations:** CF-HOST; CF-BOUNDED. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 5 — Implementer (DevOps)

| Level | Agent                                                    | Eligibility / availability                                                                                                                                                                |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P     | Cline × ChatGPT Subscription / operator-designated Codex | Option (b): Claude Desktop WUD; non-OpenAI WUD only. One level, not independent backups. Codex needs an eligible local runtime and full §4 gate evidence.                                 |
| A     | Cline × DeepSeek                                         | Execution inactive; no §3.2 spending authorization.                                                                                                                                       |
| C     | Claude Code                                              | Unavailable for a Claude Desktop WUD. Requires ChatGPT authorship or substantive re-authorship, required independent document audit and Codex reviewer assignment; otherwise unavailable. |
| E     | Unassigned                                               | Unavailable: no assigned lane; Antigravity not qualified for this specialty.                                                                                                              |

**Named correlations:** CF-HOST; CF-OPTION. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 6 — Implementer (Database)

| Level | Agent                                                    | Eligibility / availability                                                                                                                                                                |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P     | Cline × ChatGPT Subscription / operator-designated Codex | Option (b): Claude Desktop WUD; non-OpenAI WUD only. One level, not independent backups. Codex needs an eligible local runtime and full §4 gate evidence.                                 |
| A     | Cline × DeepSeek                                         | Execution inactive; no §3.2 spending authorization.                                                                                                                                       |
| C     | Claude Code                                              | Unavailable for a Claude Desktop WUD. Requires ChatGPT authorship or substantive re-authorship, required independent document audit and Codex reviewer assignment; otherwise unavailable. |
| E     | Unassigned                                               | Unavailable: no assigned lane; Antigravity not qualified for this specialty.                                                                                                              |

**Named correlations:** CF-HOST; CF-OPTION. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 7 — Implementer (Cloud)

| Level | Agent                                                    | Eligibility / availability                                                                                                                                                                |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P     | Cline × ChatGPT Subscription / operator-designated Codex | Option (b): Claude Desktop WUD; non-OpenAI WUD only. One level, not independent backups. Codex needs an eligible local runtime and full §4 gate evidence.                                 |
| A     | Cline × DeepSeek                                         | Execution inactive; no §3.2 spending authorization.                                                                                                                                       |
| C     | Claude Code                                              | Unavailable for a Claude Desktop WUD. Requires ChatGPT authorship or substantive re-authorship, required independent document audit and Codex reviewer assignment; otherwise unavailable. |
| E     | Unassigned                                               | Unavailable: no assigned lane; Antigravity not qualified for this specialty.                                                                                                              |

**Named correlations:** CF-HOST; CF-OPTION. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 8 — Implementer (Specialized)

| Level | Agent                                                    | Eligibility / availability                                                                                                           |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| P     | Antigravity × Gemini 3.8 Flash High                      | Assessed bounded backend or comparable specialized work only; WUD vendor/model family must differ from Google. No Argon inheritance. |
| A     | Cline × DeepSeek                                         | Execution inactive; no §3.2 spending authorization.                                                                                  |
| C     | Cline × ChatGPT Subscription / operator-designated Codex | Non-OpenAI WUD only; both routes occupy this one level. Codex needs an eligible local runtime and full §4 gate evidence.             |
| E     | Claude Code                                              | Non-Anthropic WUD only, with required independent document audit and Codex as reviewer.                                              |

**Named correlations:** CF-HOST; CF-BOUNDED; CF-OPTION for work outside qualification. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

For work outside the assessed comparable specialized class, use the complete option-(b) P/A/C/E order and conditions of Role 5; this adds no Antigravity qualification.

### Role 9 — Schema & Architecture Discovery

| Level | Agent                        | Eligibility / availability                      |
| ----- | ---------------------------- | ----------------------------------------------- |
| P     | Antigravity                  | Gemini 3.8 Flash High: assessed discovery only. |
| A     | ChatGPT (Plus)               | Existing Alternate retained.                    |
| C     | Claude Code                  | Existing Contingency retained.                  |
| E     | Cline × ChatGPT Subscription | Existing Emergency retained.                    |

**Named correlations:** CF-HOST; CF-DISCOVERY. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 10 — GitHub Implementer

| Level | Agent                        | Eligibility / availability                                              |
| ----- | ---------------------------- | ----------------------------------------------------------------------- |
| P     | Copilot Pro                  | Small, bounded GitHub work; prefer deterministic authorized operations. |
| A     | ChatGPT (Plus)               | Existing Alternate retained; never file own authored text.              |
| C     | Cline × ChatGPT Subscription | Existing Contingency retained; §10.1 author/filer separation.           |
| E     | Cline × DeepSeek             | Existing Emergency retained; execution inactive under §3.2.             |

**Named correlations:** CF-HOST; CF-GITHUB. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

**Agent-specific rules:**

- gh token must be fine-grained: Contents Read and write, Pull requests Read and write, Issues Read and write, Projects Read and write, Metadata Read, Actions Read.
- No Administration, no Secrets, no Environments.
- Must not force push.
- Must not delete branches that are not the Agent's own feature branches.

### Role 11 — Researcher

| Level | Agent                     |
| ----- | ------------------------- |
| P     | ChatGPT (Plus)            |
| A     | Claude Desktop (Opus 5.5) |
| C     | M365 Copilot Premium      |
| E     | DeepSeek Agent            |

### Role 12 — Document Writer (Content)

| Level | Agent                        | Eligibility / availability                                               |
| ----- | ---------------------------- | ------------------------------------------------------------------------ |
| P     | ChatGPT                      | Historical persistence caveat retained; no self-placement or self-audit. |
| A     | Claude Desktop               | No self-placement or self-audit.                                         |
| C     | M365 Copilot Premium         | Bounded review only; no synthesis.                                       |
| E     | Cline × ChatGPT Subscription | Different party from prompt writer, placer and auditor.                  |

**Named correlations:** CF-HOST; CF-CONTENT; CF-MODEL. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

**Agent-specific rules:**

- Must not originate factual claims without verification.
- Must submit every produced document to the Document Auditor.
- Must not weaken the Reserved Actions.
- Cannot save files — placement handled by the Placement role.
- Must demonstrate source fidelity: every claim traceable to source, no fabrication, no renamed concepts, no added structure.

### Role 13 — Document Writer (Placement)

| Level | Agent                        | Eligibility / availability                                  |
| ----- | ---------------------------- | ----------------------------------------------------------- |
| P     | ChatGPT (Plus)               | Existing Primary retained; never own content.               |
| A     | Claude Code                  | Existing Alternate retained; never audit own placement.     |
| C     | Cline × ChatGPT Subscription | Existing Contingency retained.                              |
| E     | Cline × DeepSeek             | Existing Emergency retained; execution inactive under §3.2. |

**Named correlations:** CF-HOST; CF-PLACEMENT. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

No author places its own content. Artifact creation in a delivery archive is content delivery, not repository placement.

### Role 14 — Document Auditor

| Level | Agent          | Eligibility / availability                                                                                        |
| ----- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| P     | Claude Desktop | Non-Anthropic-authored documents only; no own content or placement.                                               |
| A     | ChatGPT (Plus) | Non-OpenAI-authored documents only; no own content or placement.                                                  |
| C     | Unassigned     | Unavailable: no assigned lane.                                                                                    |
| E     | Claude Code    | Non-Anthropic-authored documents only; never its own placement or content; Emergency only when P/A/C unavailable. |

**Named correlations:** CF-HOST; CF-AUDIT. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

Only ChatGPT Alternate can audit Anthropic-authored documents under these slots; no second eligible auditor is claimed. Retain the §14.4 vendor/model-family restriction.

**Auditor independence rule:** An Auditor must not audit an artifact it authored, and must not share a vendor or model family with the artifact's author, without an explicit operator-recorded exception.

### Role 15 — Adversarial Reviewer — Specifications and Evidence

| Level | Agent                | Condition                                                                |
| ----- | -------------------- | ------------------------------------------------------------------------ |
| P     | DeepSeek Agent       | Exclude artifacts it authored or assessments it is defending             |
| A     | Claude Desktop       | When independent of the artifact's author and supplied complete evidence |
| C     | Codex                | Bounded document/specification review                                    |
| E     | M365 Copilot Premium | Only when it did not author the artifact                                 |

### Role 16 — GitHub Analyst

| Level | Agent                        | Eligibility / availability                                              |
| ----- | ---------------------------- | ----------------------------------------------------------------------- |
| P     | Copilot Pro                  | Small, bounded GitHub work; prefer deterministic authorized operations. |
| A     | ChatGPT (Plus)               | Existing Alternate retained; never file own authored text.              |
| C     | Cline × ChatGPT Subscription | Existing Contingency retained; §10.1 author/filer separation.           |
| E     | Cline × DeepSeek             | Existing Emergency retained; execution inactive under §3.2.             |

**Named correlations:** CF-HOST; CF-GITHUB. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

### Role 17 — Reviewer (code and security)

| Level | Agent       | Eligibility / availability                                                             |
| ----- | ----------- | -------------------------------------------------------------------------------------- |
| P     | Claude Code | Read-only default; never own implementation or placement.                              |
| A     | Codex       | When Primary unavailable, capped or conflicted; never own implementation or placement. |
| C     | Unassigned  | Unavailable: no assigned lane.                                                         |
| E     | Unassigned  | Unavailable: no assigned lane.                                                         |

**Named correlations:** CF-HOST; CF-REVIEW. Each is adopted only by the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16; see 04 §3.

Review is read-only, posted on the PR with the reviewed full head SHA, and stale after any new commit. #139 is a partially overlapping source issue, not closed by this amendment.

## 3. Amendment operation and named correlations

The adoption mechanism is the operator’s adoption comment on governance issue #139, posted before merge and citing the SHA-256 of the final authoritative `edit-blocks.json`. The comment explicitly adopts option (b), every changed PACE assignment, and every named correlated-failure exception in 04 §3. The operator-approved merge of that issue’s PR into `develop` makes this amendment effective only when the required pre-merge comment exists; the comment alone grants no authority.

For AI-070, PR #213 merged on 2026-10-20 at 17:47:01 UTC (`9764e11fc82251b81e4441e07fcc19bf9981470c`) before the required operator adoption comment; the operator confirmed no comment was posted. That merge did not activate this amendment. Under the narrow prospective correction in AGENTS.md §16, operator adoption on #139 must precede an independently reviewed, formally audited, gated corrective PR; only the operator’s later corrective merge into `develop` activates these assignments and exceptions. The ordinary pre-merge adoption rule remains in force. Record the actual adoption comment, corrective merge SHA/time and evaluation end date on #139. No role table, qualification or correlated-failure entry is changed by this sequencing clarification.

The following named exceptions record the four §14.3 dimensions: harness, upstream provider, account and execution host. Serving platform is recorded as configuration evidence, not added as a fifth §14.3 dimension. Each exception requires explicit adoption by the mechanism above. None waives an artifact-level vendor, authorship, placement or review restriction. Unknown independence is not assumed.

| Exception    | Affected slots and risk                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF-HOST      | Roles 1–17: all local slots share the operator workstation. A host outage can defeat all local levels together. Remote host independence is unknown and never inferred.                                                                                                                                                                                                                                             |
| CF-MODEL     | Roles 1/2/11/12/15: a Microsoft-branded surface may use an OpenAI or Anthropic upstream model. Record the actual selected model before dispatch; possible provider overlap is acknowledged, never permission to ignore artifact restrictions.                                                                                                                                                                       |
| CF-OPTION    | Roles 3/5/6/7 and Role 8 outside qualification: Primary Cline × ChatGPT and inactive Alternate Cline × DeepSeek share Cline; Codex is an OpenAI/provider/account substitution inside Primary, not another level. Claude Desktop WUD author and Claude Code fallback share Anthropic, so fallback remains unavailable until the WUD is substantively authored by ChatGPT and audited as required; Codex must review. |
| CF-BOUNDED   | Roles 4/8 assessed classes: inactive Alternate and Contingency Cline routes share Cline; Contingency Codex and Cline × ChatGPT share OpenAI/account. No independent extra level is claimed.                                                                                                                                                                                                                         |
| CF-DISCOVERY | Role 9 Alternate ChatGPT and Emergency Cline × ChatGPT share OpenAI and the ChatGPT Plus account; both may fail together.                                                                                                                                                                                                                                                                                           |
| CF-GITHUB    | Roles 10/16 Alternate ChatGPT and Contingency Cline × ChatGPT share OpenAI/account; Contingency and inactive Emergency share Cline. Copilot’s actual upstream model can add provider overlap and must be checked.                                                                                                                                                                                                   |
| CF-CONTENT   | Role 12 Primary ChatGPT and Emergency Cline × ChatGPT share OpenAI/account. M365 remains bounded-review-only and can add upstream overlap.                                                                                                                                                                                                                                                                          |
| CF-PLACEMENT | Role 13 Primary ChatGPT and Contingency Cline × ChatGPT share OpenAI/account; Contingency and inactive Emergency share Cline. This acknowledges backup correlation, not permission for self-placement.                                                                                                                                                                                                              |
| CF-AUDIT     | Role 14 Primary Claude Desktop and Emergency Claude Code share Anthropic provider and account. Exhaustion or provider failure can remove both; Anthropic-authored documents have only ChatGPT Alternate.                                                                                                                                                                                                            |
| CF-REVIEW    | Role 17 local Primary and Alternate share the workstation. The option-(b) Anthropic WUD author and Claude Code reviewer share provider/account across roles. Distinct-agent code review remains required; no three-vendor independence is claimed.                                                                                                                                                                  |

### Configuration and qualification evidence

| Route                        | Harness / surface          | Upstream vendor                      | Account correlation                                                         | Execution host                                     |
| ---------------------------- | -------------------------- | ------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------- |
| ChatGPT                      | Chat surface               | OpenAI for the selected OpenAI model | ChatGPT Plus shared with Cline × ChatGPT and Codex, as supplied evidence    | No independent host asserted                       |
| Cline × ChatGPT / Codex      | Separate harnesses         | OpenAI                               | Same supplied ChatGPT Plus account; not independent levels                  | Local workstation where dispatched; validate route |
| Claude Desktop / Claude Code | Separate surfaces          | Anthropic                            | Shared Claude allowance/account as supplied evidence                        | Local workstation for local execution              |
| Cline × DeepSeek             | Cline                      | DeepSeek                             | Execution inactive; no billing observation claimed                          | Local workstation where dispatched                 |
| Antigravity                  | Antigravity                | Google Gemini only                   | Existing Google AI Pro allowance, supplied evidence; verify before dispatch | Local workstation where dispatched                 |
| M365 / Copilot               | Microsoft-branded surfaces | Actual selected model developer      | Provider/account independence not inferred                                  | No independent host asserted                       |

Every dispatch records exact model, effort, tier, tool surface, non-secret account/host references, last-verified date, qualification source and separation check. The historical configurations are dated October 1, 2026 and do not establish present availability, supported controls or entitlement. Never switch model, effort or vendor automatically.

Gemini 3.8 Flash High is qualified only for assessed discovery, bounded backend and comparable specialized work. Retain the 4–7-day lockout risk, unsupported Windows kernel sandbox and Phase 1 supporting-detail fabrication. Gemini 4 Argon inherits no qualification and has no supplied current client-control observation; it is unavailable for dispatch without its own evidence and explicit assignment. Database remains excluded. Antigravity’s former Frontend Emergency slot, conditional on browser automation, is removed; browser automation alone does not qualify it.

Codex’s historical runtime/implementation caveat remains. Its selected implementation route must support the full local §4 gate chain and commit-bound evidence; assignment is not a new test pass. Role 2 retains both pending bounded specification tests; option (b) does not assert those tests passed. Researcher Role 11 assignments remain unchanged. GitHub Roles 10/16 keep their backup levels; hourly service-rate replenishment does not replenish monthly AI-credit balance. §10.1 author/filer separation, content near-match handling and reserved staging paths remain binding.

### Capacity and evaluation

When the shared Claude allowance is exhausted, Role 14 Primary and Emergency fail together, and option-(b) WUD authoring stops. New work that needs either service waits. Work whose WUD is already authored and validly audited may proceed only while its implementation and review lanes remain eligible and available; an exhausted Claude Code review lane may use independent Codex review where permitted. When ChatGPT Plus is exhausted, the option-(b) Primary, the ChatGPT authorship precondition for the Claude Code fallback, and Role 17 Alternate fail. An existing ChatGPT-authored, validly audited WUD does not require fresh authorship solely because of that exhaustion, but still needs an available independent reviewer. No paid route is added. Record blocked-work duration and cause, including authoring, audit, implementation and review delays, on the governance issue as evaluation evidence.

The evaluation lasts from the activating merge timestamp (for AI-070, the later operator-controlled corrective merge, not PR #213) through that timestamp + 14 days. Record results at day 7/day 14 using the existing governance issue. At day 14 the operator records retain, revise or revert; without a decision assignments continue until amended. If no eligible, available slot exists, work waits. No new tracker, automation or paid route is created.

**End of PACE Role Matrix v1.0.**
