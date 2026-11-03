# Independent Review: MGPL Agent Operating Model Change (2026-10-18)

```text
AUDITOR VERDICT
---------------
Document: "MGPL Governance Change — Independent Review and Implementation Handoff"
          (ChatGPT-authored change request carrying operator-approved decisions A–I)
          SHA-256 d18c7f49b976993e8e95b2640a76efc7323bff0ebe767796489bdeb6d5f26f5f
Auditor:  Claude Desktop lane (Claude; session configured as claude-opus-5-5)
Date:     2026-10-18
Basis:    joelgeorges86/MGPL develop @ e2e709da9171adae1dead5d65e20e25744fb5d7c
          (merge of PR #210, committed 2026-10-18T20:24:59-04:00)
Verdict:  FAIL on the 06 scale: blocking findings, so revise before adoption.
          On the change request's own scale: PASS WITH REQUIRED CORRECTIONS.
```

## Summary

None of the operator's decisions A–I conflicts irreconcilably with binding governance, and none needs reversing. Most of the intent is already partly in place: ChatGPT is already Researcher and Specifier Primary, Antigravity is already Discovery Primary and was assessed on Gemini 3.8 Flash, and Cline × Google Vertex is already "Do not use". Implementing the change as written still has 12 blocking gaps:

- The current Document Auditor slot does not allow Claude Desktop to audit ChatGPT-authored documents. That limits this review itself.
- The request names no implementer PACE order and no PR-reviewer PACE role.
- The independence rules it relies on cannot be checked under the shared GitHub token.
- Its Phase 4 hands this PR's document check to an OpenAI agent, which is the author's vendor.
- No authorization or ceiling is recorded for DeepSeek or for pay-per-use credit.
- Six further corrections are needed so that the amendment states the record accurately.

Every gap can be closed with one author revision (Phase 2) and four operator inputs (section 11).

**How the two scales map.** Under 06, any finding that must be fixed before adoption makes the verdict FAIL. That is exactly what the request calls "Pass with required corrections": revise, then adopt. Nothing found here is "Blocked" in the sense of preventing compliant implementation once the operator supplies the inputs in section 11.

### Auditor standing (read this first)

Claude Desktop's current Document Auditor slot reads _"non-Claude-authored, non-OpenAI-authored documents only"_. That wording appears in AGENTS.md §14.2 (line 933), 04 Role 14 (line 170), `10-pace-roster.json` (line 150) and the Claude profile (line 52). The request is ChatGPT-authored.

- **The vendor rule is met.** Claude (Anthropic) does not share a vendor with ChatGPT (OpenAI) (§14.4, line 945).
- **The slot restriction is not met.** PR #209's auditor applied it exactly that way: "Alternate and Contingency excluded for OpenAI-authored documents."
- **The restriction looks like a drafting error, but it binds until amended.** It contradicts the position recorded as accepted in 08 §3.2 (lines 321–333). There, Claude Desktop said that for ChatGPT-authored documents it is "the only backup to DeepSeek that isn't an OpenAI-family model".

**This verdict is therefore advisory until the operator records an exception** (blocker B-2). The exception must cover three things:

1. this review;
2. the Phase 2 re-check;
3. the post-placement audit of the PR diff.

---

## 1. Findings

Each finding uses the 06 fields. "Blocking" means it must be corrected in the author's revision (or by an operator input) before placement.

### 1.1 Blocking findings (required corrections)

**R-1. The Document Auditor role contradicts decision B.** High · Verified

- **Location:** AGENTS.md §14.2 line 933; 04 Role 14 lines 165–174; `10-pace-roster.json` lines 145–161; profile 19 line 52; profile 18 line 52.
- **Description:** Claude Desktop cannot audit OpenAI-authored documents under the current slot, and ChatGPT cannot audit its own vendor's work. The binding matrix therefore leaves Claude Code (Emergency) as the only eligible auditor of a ChatGPT-authored document. Decision B makes Claude Desktop the routine auditor of exactly those documents.
- **Correction:** Re-slot Role 14 as follows. The two empty slots are recorded gaps, not left blank silently.

  | Level | Agent          | Eligible for                                                          |
  | ----- | -------------- | --------------------------------------------------------------------- |
  | P     | Claude Desktop | non-Anthropic-authored documents only                                 |
  | A     | ChatGPT        | non-OpenAI-authored documents only                                    |
  | C     | unassigned     | recorded gap                                                          |
  | E     | Claude Code    | non-Anthropic-authored documents only; never for a document it placed |

  Record that E shares a provider and an account with P, as a correlated-failure exception. Record also that a Claude-authored document then has exactly one eligible auditor (ChatGPT). Mirror the change in §14.2, 10, 18 and 19.

**R-2. No implementer PACE order is given, and the current order conflicts with decisions A, F and G.** High · Verified

- **Location:** 04 Roles 3–8; 10 lines 45–98; AGENTS.md §14.2 line 934; 11 `github_copilot_pro.best_roles`.
- **Description:** Four conflicts:
  - **Decision A.** Cline × ChatGPT Subscription is Primary in every implementer role, but cannot implement the default WUD (ChatGPT-authored) under the Specifier-and-Implementer vendor rule (04 line 49).
  - **Decision G.** Copilot Pro holds implementer slots: Backend E, DevOps E, Cloud A and Specialized E.
  - **Decision F.** Codex holds no implementer slot.
  - **Decision D.** Antigravity sits at C or E.

  A pure "skip the ineligible vendor" filter on the current order sends every ChatGPT-authored WUD to Claude Code. That inverts the intended outcome ("Antigravity, Cline and Codex develop; Claude Code reviews code"). The request never states the new order, and the reviewer cannot invent it.

- **Correction:** The operator states the order, or accepts the default in section 5.2. Remove Copilot Pro from the implementer roles (G).

**R-3. No PACE role exists for reviewing implementation PRs.** High · Verified

- **Location:** 04 (16 roles, none of them a code reviewer); AGENTS.md §5 step 4 (Codex hard-coded).
- **Description:** Decision C needs a role with a PACE line. 08 Finding 3.2 accepted "Add Reviewer (code and security) to PACE", and #139 (AI-070, open) records that it was never added.
- **Correction:** Add **Role 17 — Reviewer (code and security)**, using the accepted name:

  | Level | Agent       | When                                                                           |
  | ----- | ----------- | ------------------------------------------------------------------------------ |
  | P     | Claude Code | default                                                                        |
  | A     | Codex       | when Claude Code implemented or placed the change, or is unavailable or capped |
  | C     | unassigned  | recorded gap                                                                   |
  | E     | unassigned  | recorded gap                                                                   |

  Rules: the reviewer is never the implementing agent; it is read-only; reviews are commit-bound; a review goes stale on a new commit; findings are posted on the PR. Reference #139, and do not claim to close it.

**R-4. "Claude Code must not review its own implementation" cannot be checked as written.** High · Verified

- **Location:** AGENTS.md §10.2 line 609 and §5 step 9 (one GitHub token shared by every lane and the operator); request decision C.
- **Description:** GitHub cannot tell which lane wrote a commit or a comment. §5 step 9 warns against rules that "read as a control and verify nothing".
- **Correction:** CODE_REVIEW_WORKFLOW must require two records, both self-reported until #63:
  - **The PR body states:** the implementing lane (harness × model × effort), the WUD's path and SHA-256, and the WUD author's vendor.
  - **Each review comment states:** the reviewing lane, model and effort, the reviewed head SHA, and the implementing lane named in the PR body.

**R-5. Phase 4 gives the document-consistency check to an agent from the author's vendor.** High · Verified

- **Location:** Request Phase 4 ("confirm that the new role matrix, AGENTS.md and workflow documents agree"); §14.4 line 945; 06 §6.
- **Description:** Codex (OpenAI) is a valid §5 code reviewer for this PR, because it is a different agent. It cannot be the independent document auditor of ChatGPT-authored governance text. The other candidate, Claude Code (Role 14 E), is this PR's placement lane, so it would be auditing its own placement. PR #209 shows such an audit catching a placement defect.
- **Correction:** Phase 4 needs both of the following, as #191 had both:
  - the Codex `/review` that current §5 requires;
  - a post-placement document audit by Claude Desktop on the PR head, under the B-2 exception.

**R-6. "Vendor" is undefined where a harness serves several vendors.** Medium · Sourced

- **Location:** Request decisions D, E, F and I; the operator's Usage Strategy (2026-10-14), Capacity sheet ("Antigravity … Gemini and Claude/GPT models"); Copilot ("several vendors' models").
- **Description:** The vendor rules are evaluated on agent names. Antigravity can run Claude or GPT models. If it did, it would silently share a vendor with Claude Code or Codex.
- **Correction:** Add to §14.4: _vendor means the upstream vendor of the model actually selected for the work, not the harness_. Restrict Antigravity lanes to Gemini models, which decision D already implies. The prompt template records the selected model (R-13).

**R-7. No DeepSeek execution authorization exists, and pay-per-use credit has no ceiling.** High · Verified, interpretation Inferred

- **Location:** AGENTS.md §3 table line 65; §3.1 conditions 1 and 3; `lib.mjs` `parseAuthorizations` lines 775–846; the Usage Strategy Capacity and Money controls sheets (2026-10-14).
- **Description:** Four gaps:
  - **DeepSeek.** DeepSeek appears in binding text only as PACE slots. No ceiling, scope or expiry is recorded. §3.1 cannot hold it: its conditions require the `mgpl-agent` Vertex service account and named Vertex endpoints, and the run guard parses its tables.
  - **OpenAI credit.** The operator's own 2026-10-14 record shows ChatGPT Plus (serving ChatGPT, Codex and Cline × ChatGPT) with 2,503 credits and "Automatic reload is ON". The control to turn that off was "Not started".
  - **Claude usage credit.** Claude Pro was "using usage credits" ($20.39) once its weekly limit was hit. Decision C adds Claude Code review load to that same account.
  - **The interpretation behind all three.** Reading a harness's metered inference as a §3 "billable external API call" is this reviewer's interpretation. The operator may rule otherwise, but only by amendment.
- **Correction:** Add a new **§3.2** with the elements in section 6. Until its DeepSeek entry is complete, Cline × DeepSeek slots are recorded as inactive. Do not invent a figure.

**R-8. The Gemini scope clarification must keep the whole record.** Medium · Verified

- **Location:** Request D ("The historical Gemini failures applied to the Gemini chatbot evaluation"); 07 lines 43–46, 95 and 503; 11 lines 62–81 and 135–158; 17 lines 11, 38–39, 43 and 53–55; 02 line 32; AGENTS.md §16 line 997.
- **Description:** The premise is incomplete. The record holds two Gemini-model disqualifications:
  - Gemini 3.1 Pro on the chat surface;
  - Cline × Google Vertex on Gemini 2.5 Pro (18/85; "fabricated a NameError claim").

  Antigravity was assessed separately on Gemini 3.8 Flash High and placed, with a known limitation: "One supporting-detail fabrication in Phase 1". The universal wording sits in 02 line 32, §16 line 997, 17 lines 38–39 and 43, 11 line 79 and the non-binding project request `RESEARCH-REQ-model-configuration-2026-10-14` (constraint 1: "Antigravity may be used only with its Claude or GPT models"). 17 line 54 ("No further Google integration remains") is also stale, given the Vertex ledger entries.

- **Correction:**
  - Scope the exclusion to "Gemini 3.1 Pro (chat surface)" and "Cline × Google Vertex as a model route".
  - Record Antigravity × Gemini as separately assessed, carrying its known limitations.
  - Make every change append-only: dated amendment notes. Never edit 07, 08, 01, 02, the §16 rows or existing 13 entries.

**R-9. §3.1 must stay byte-identical, and the request misdescribes it.** Medium · Verified

- **Location:** Request H ("narrowly specified billable Vertex AI probe authorization") and E; AGENTS.md lines 71–227.
- **Description:** §3.1 now holds 7 entries, under a $275 window, a $20 stop line and an expiry of 2026-11-06. They include two production enrichment entries in the operator's lane: #158 at $160 and #207 at $110. #117's lane, "Cline × ChatGPT Subscription", runs a script that calls Vertex. That is not the "Cline × Vertex" model route that decision E distrusts.
- **Correction:** The amendment does not restate, summarize or alter §3.1. It may say: _"§3.1 is unchanged; the untrusted Cline × Google Vertex model route is distinct from §3.1 lanes that run a named script."_ Placement verifies §3.1 byte-identity and the parser result (section 8).

**R-10. The effective point, the evaluation end and the transition are undefined.** Medium · Inferred

- **Location:** Request A ("initial two-week evaluation") and Phase 5 ("required effective state under MGPL's current rules"). The current rules do not define one.
- **Description:** Three questions are unanswered:
  - **After the evaluation.** Does the allocation lapse or continue?
  - **Open PRs.** Which reviewer rule applies to a PR open at activation?
  - **Default branch.** `main` is the repository's default, and lanes that read it, such as GitHub's cloud agent, keep the old text until promotion.
- **Correction:** The §16 row and the 04 header state four things:
  - the amendment takes effect at its merge commit into `develop`;
  - the evaluation runs from that merge to merge + 14 days;
  - it **remains in force until amended** (reverting would be an operator choice);
  - a review made after the effective point follows the new rule, including any re-review of a stale pre-activation review.

  Promotion to `main` stays a separate operator decision.

**R-11. Independence across the four §14.3 dimensions cannot be met, and must be recorded rather than claimed.** Medium · Verified

- **Location:** AGENTS.md §14.3 lines 939–941; Usage Strategy Capacity sheet; #139 item 3; request I.
- **Description:** The tool inventory makes several shared dimensions unavoidable:
  - one operator workstation hosts every local harness;
  - ChatGPT, Codex and Cline × ChatGPT share one ChatGPT Plus account;
  - Claude Desktop and Claude Code share one Claude Pro account;
  - Cline carries both the DeepSeek and the OpenAI routes.

  Request I also adds a "serving platform" dimension that §14.3 does not contain.

- **Correction:**
  - Add a short **independence map** to 04 §1: harness, upstream vendor, account and execution host per agent.
  - Record the standing exceptions with their named risk, and mark each affected slot pair in every role this amendment changes.
  - Keep §14.3's four dimensions. Adopting "serving platform" would be a separate, explicit operator decision.
  - Leave #139 open, with its acceptance criteria intact.

**R-14. §2's harness routing omits Antigravity.** Medium · Verified

- **Location:** AGENTS.md §2 lines 42–47; `.clinerules/02-workforce-routing.md` line 5 ("The three real agents are Cline, Claude Code, and Codex").
- **Description:** Antigravity will write to feature branches. The single-lock rule and the harness list do not name it.
- **Correction:** Amend §2 as follows:
  - **Antigravity:** engineering execution on native Gemini models only.
  - **Claude Code:** also the default read-only reviewer of implementation PRs.
  - **Codex:** selected implementation of WUDs not authored by OpenAI, plus exceptional review.
  - **All harnesses:** the single lock applies to every harness named.

  Update the restatement in `.clinerules/02` (see section 7).

### 1.2 Non-blocking findings (recommended)

**R-12. Make the prompt-writer and content-writer separation party-neutral.** Medium

Profile 19 lines 80–85 bars _Claude_ from writing both the prompt and the content of one work unit under independent review. ChatGPT now holds both Primaries, so the rule should name the roles, not Claude. Add it to §14.4. This request's own flow complies: ChatGPT authored the content and Claude Desktop writes the placement prompt.

**R-13. Some items under "Preserve" in request I are new.** Low

"No unauthorized automatic model or effort switching" appears nowhere in binding text. Adopt it under decision I, but record it as new in §16. Add model pre-selection fields to 05 (section 3). These are the minimum 05 change the request permits.

**R-15. Record Codex as implementer without erasing its history.** Medium

- **Location:** 11 lines 172–192 (not fit as "Implementer (accepted as unverified by operator)"; "Node v22.23.2 unavailable in Codex environment"); 07 line 503 ("Do not use: … Codex (ChatGPT extension)"); #141 open.
- **Correction:** Add decision F as a dated note and keep the limitations. Condition it: Codex implements only on a route that runs the full §4 chain locally and records `.mgpl/gate-evidence.json`.

**R-16. Keep the GitHub-lane wording off the staging folder.** Low

Decision G's "ChatGPT or Claude … prepares the need for an issue" must not read as permission to write under `_staging\issues\`, which §3.3 reserves and §11.2 item 23 prohibits. Say instead that they draft the text, and the operator places and names the file (§10.1). Add to the Roles 10 and 16 rules:

- prefer deterministic `gh`/REST operations;
- hourly service-rate replenishment does not replenish the monthly AI-credit balance.

**R-17. Define WUD without creating a role.** Low

State that a WUD is the work unit's specification, the output of Role 2 (Specifier / Architect). ChatGPT's Role 2 Primary keeps "pending bounded specification test" unless the operator records the evaluation as that test.

**R-18. Optional: adopt vendor-level independence for code review.** Low

08 Finding 3.2 accepted "the reviewer must not share the author's vendor or model family". The new allocation already satisfies it in every routine pairing (section 5.3), so adopting it now costs nothing.

**R-19. Non-blocking operating risk: one Claude Pro account carries both review gates.** Medium · Sourced

Claude Desktop (document audit) and Claude Code (PR review) share one Claude Pro account, whose weekly limit was being exhausted in about 3 days on 2026-10-14. Moving authoring to ChatGPT frees some Claude capacity; the two review gates add load. When the allowance is spent:

- PR review moves to Codex (Role 17 A);
- Claude-authored documents go to ChatGPT (Role 14 A);
- otherwise work waits.

Usage credit is not spent without a §3.2 entry. Track this in the evaluation.

---

## 2. What is already consistent with current governance

| #   | Item                                                                                                                                                | Evidence                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | ChatGPT is already Researcher Primary and Specifier/Architect Primary (pending its test)                                                            | 04 Roles 2 and 11; §14.2 line 935              |
| 2   | Antigravity is already Discovery Primary, and placed C for Backend and Specialized and E for Frontend. It was assessed on **Gemini 3.8 Flash High** | 04 lines 58, 66, 102 and 109; 11 lines 135–158 |
| 3   | The exclusion record names **Gemini 3.1 Pro (chat)**                                                                                                | 07 lines 43 and 503; 01 line 123               |
| 4   | Cline × Google Vertex is already "Do not use", so decision E matches the record                                                                     | 07 lines 45, 95 and 503                        |
| 5   | ChatGPT author → Claude Desktop auditor meets the vendor rule                                                                                       | §14.4 line 945                                 |
| 6   | Code review is read-only, posted on the PR, commit-bound, and stale on a new commit. Decision C keeps all four                                      | §5 steps 7–8; CODE_REVIEW_WORKFLOW line 25     |
| 7   | The Codex review for this governance PR is still required, as Phase 4 states                                                                        | §5 step 4; precedent PRs #175 and #191         |
| 8   | Merging to `develop` and `main` is operator-only                                                                                                    | §5 steps 9–10; §11.2 items 1–2; §10.7          |
| 9   | GitHub-lane filing conditions and P-A-E items are preserved by G                                                                                    | §10.1 conditions 1–5; §11.3                    |
| 10  | Every lane named already exists in the roster, so no new agent or subscription is added                                                             | 04; 11                                         |
| 11  | The gates, two-failure rule and evidence discipline are untouched                                                                                   | §4; §13                                        |
| 12  | Claude Code can be the placement lane for a ChatGPT-authored document                                                                               | 04 Role 13 A; §14.4 line 946                   |

---

## 3. Conflict and amendment matrix

| Document (current location)                           | Current requirement                                                                  | Proposed change                                                                                                                                                                                                                                                                                                                                                                             | Reason                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| AGENTS.md §2, lines 42–47                             | Three harnesses: Cline, Claude Code, Codex                                           | Add Antigravity (Gemini models only; engineering execution). Claude Code adds "default read-only PR reviewer". Codex adds "selected implementation (non-OpenAI-authored WUDs), exceptional review". Single lock covers all four                                                                                                                                                             | D, C, F; R-14              |
| AGENTS.md §3, new §3.2 between lines 227 and 229      | Billable call = Approval required unless a §3.1 entry covers it; §3.1 is Vertex-only | New §3.2 for metered model inference by agent lanes (section 6). §3.1 unchanged                                                                                                                                                                                                                                                                                                             | E, H; R-7, R-9             |
| AGENTS.md §5 step 4, line 322                         | "Run Codex `/review` against `develop`…"                                             | Obtain the independent review that CODE_REVIEW_WORKFLOW requires: Claude Code by default; Codex when Claude Code implemented or placed the change, or is unavailable                                                                                                                                                                                                                        | C                          |
| AGENTS.md §5 step 5, line 323                         | "…Codex review findings…"                                                            | "…independent review findings, naming the reviewing lane…"                                                                                                                                                                                                                                                                                                                                  | C; R-4                     |
| AGENTS.md §5 step 7, lines 325–330                    | "The Codex review is posted on the pull request itself…"                             | "The independent review is posted…" Everything else unchanged                                                                                                                                                                                                                                                                                                                               | C                          |
| AGENTS.md §5, line 343                                | "…including its own Codex review."                                                   | "…including its own independent review."                                                                                                                                                                                                                                                                                                                                                    | C                          |
| AGENTS.md §14.2, lines 930–937                        | P/A/C/E summaries                                                                    | Update Prompt Author, Document Writer (Content), Document Auditor and Implementer; add Reviewer (code and security). Other rows unchanged                                                                                                                                                                                                                                                   | A, B, C, D, F, G; R-1–R-3  |
| AGENTS.md §14.4, lines 943–947                        | Auditor independence; author-reviewer separation; prompt-author separation           | Add: (a) the Specifier–Implementer vendor rule, restated from 04 line 49; (b) reviewer ≠ implementing agent; (c) vendor = upstream vendor of the selected model; (d) model and effort pre-selected and recorded, no automatic switching (new); (e) prompt writer ≠ content writer for one work unit under independent review                                                                | C, I; R-4, R-6, R-12, R-13 |
| AGENTS.md §15.2, lines 966–989                        | Governance file list                                                                 | Add each new file placed (section 7)                                                                                                                                                                                                                                                                                                                                                        | Systems of record          |
| AGENTS.md §16                                         | Change history                                                                       | One row: "Amendment within v1.2 (#ISSUE): agent operating model…", with effective point, evaluation window and what is new                                                                                                                                                                                                                                                                  | R-10, R-13                 |
| `DOCS/CODE_REVIEW_WORKFLOW.md`, whole file (25 lines) | Codex `/review` is the required pre-PR review                                        | Default reviewer Claude Code (read-only, separate checkout of the PR head), Codex as alternate (keep its `/review` steps for that case). Add the lane-identification requirements (R-4). Keep: gates first, P0/P1 resolution, re-review on a material diff change, PR posting with SHA, staleness, the fallback ladder verbatim, no merge authority. Keep the file path; AGENTS.md links it | C; R-4                     |
| 04 header, lines 1–5                                  | v1.0, 2026-10-01                                                                     | Add an amendment line (date, issue, effective point)                                                                                                                                                                                                                                                                                                                                        | R-10                       |
| 04 §1, lines 18–20                                    | Slot configuration; correlated-failure rule                                          | Add the independence map, the vendor definition and the standing exceptions                                                                                                                                                                                                                                                                                                                 | R-6, R-11                  |
| 04 Role 1, lines 24–38                                | P Claude Desktop, A ChatGPT                                                          | P ChatGPT, A Claude Desktop; C and E unchanged; E subject to §3.2                                                                                                                                                                                                                                                                                                                           | A                          |
| 04 Roles 3–8, lines 51–103                            | P Cline × ChatGPT; Copilot in four slots; no Codex                                   | Per section 5.2, or as the operator states                                                                                                                                                                                                                                                                                                                                                  | A, D, E, F, G; R-2         |
| 04 Role 9, lines 105–112                              | P Antigravity                                                                        | Unchanged; note "Gemini models only"                                                                                                                                                                                                                                                                                                                                                        | D, R-6                     |
| 04 Roles 10 and 16                                    | Copilot Pro P                                                                        | Unchanged levels; add the R-16 rules                                                                                                                                                                                                                                                                                                                                                        | G                          |
| 04 Role 12, lines 139–154                             | P Claude Desktop, A ChatGPT                                                          | P ChatGPT (file-persistence caveat, Finding 4.23: the operator or placement lane saves and hashes), A Claude Desktop; E Cline × ChatGPT recorded as a correlated-failure exception (same account as P)                                                                                                                                                                                      | A; R-11                    |
| 04 Role 13                                            | P ChatGPT                                                                            | Unchanged; note that ChatGPT never places a document it authored, so Claude Code (A) places ChatGPT-authored text                                                                                                                                                                                                                                                                           | §14.4                      |
| 04 Role 14, lines 165–174                             | Section 1, R-1                                                                       | Section 1, R-1                                                                                                                                                                                                                                                                                                                                                                              | B                          |
| 04, new Role 17                                       | none                                                                                 | Reviewer (code and security), section 1 R-3                                                                                                                                                                                                                                                                                                                                                 | C                          |
| 04, new "Not placed" note                             | none                                                                                 | Gemini 3.1 Pro (chat surface) and Cline × Google Vertex (model route): not placed, history in 07, 08 and 17                                                                                                                                                                                                                                                                                 | D, E; R-8                  |
| `10-pace-roster.json`                                 | Mirrors 04 v1.0                                                                      | Mirror every 04 change. Add `reviewer_code_security`. Add `model`, `effort` and `last_verified` to changed slots only where an observation exists (section 5.4)                                                                                                                                                                                                                             | parity                     |
| `11-agent-capability-matrix.json`                     | See R-8 and R-15                                                                     | Append-only notes on `antigravity` (models as observed; Gemini-only lane), `gemini_3.1_pro` (scope: chat surface), `chatgpt_plus`, `claude_desktop`, `claude_code` (Reviewer P), `codex` (decision F with conditions), `github_copilot_pro` (Implementer (Cloud) withdrawn under G) and `cline_deepseek_v4_pro` (authorization status). Remove no historical field                          | D, F, G; R-8, R-15         |
| `13-change-log.json`                                  | Versions 1.0–1.2                                                                     | Append one `versions` entry dated 2026-10-18 that references the issue. Existing entries byte-identical                                                                                                                                                                                                                                                                                     | change history             |
| Profile 17 (Gemini)                                   | "excluded from all MGPL roles"; "No further Google integration remains"              | Append a dated "Scope clarification" section (R-8). No deletion                                                                                                                                                                                                                                                                                                                             | D                          |
| Profile 18 (ChatGPT)                                  | Placements v1.2                                                                      | Append dated "Placements (amendment)". No deletion                                                                                                                                                                                                                                                                                                                                          | A, B                       |
| Profile 19 (Claude)                                   | Placements v1.2                                                                      | Append dated "Placements (amendment)": Claude Desktop P Document Auditor and A Prompt Author / Content; Claude Code P Reviewer (code and security); the vendor-overlap note stays. No deletion                                                                                                                                                                                              | B, C                       |
| 05 Prompt Author Template, sections 3–4               | No lane or model fields                                                              | Add an "Assigned lane" block to both templates: harness, exact model, effort, WUD author vendor, implementer vendor, separation check, reviewer lane, "do not change model or effort"                                                                                                                                                                                                       | I; R-6, R-13               |
| 06 Auditor Verdict Format                             | none                                                                                 | **No change.** Used as is                                                                                                                                                                                                                                                                                                                                                                   | B                          |
| 02 Manual, 01 Justification, 03, 07, 08, 09, 12       | Historical v1.1/v1.2 record                                                          | **No change** (CR §4; append-only principle). The 17 note and §16 row scope 02 line 32                                                                                                                                                                                                                                                                                                      | scope                      |
| `.clinerules/02-workforce-routing.md`, line 5         | "three real agents are Cline, Claude Code, and Codex"                                | One sentence: name the four harnesses and point to AGENTS.md §2                                                                                                                                                                                                                                                                                                                             | R-14 (recommended)         |

---

## 4. Separation of duties

### 4.1 This change's own flow

| Step                           | Lane                                            | Check                                                                            |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Content author                 | ChatGPT                                         | —                                                                                |
| Independent audit (Phases 1–2) | Claude Desktop                                  | Vendor-independent of ChatGPT; **needs the B-2 exception**                       |
| Placement prompt               | Claude Desktop (Prompt Author P, still binding) | Not the content author (profile 19 note); does not execute it (§14.4)            |
| Placement                      | Claude Code (Role 13 A)                         | Not the author (§14.4)                                                           |
| §5 code review                 | Codex                                           | Different agent from author and placer; required until effective                 |
| Post-placement document audit  | Claude Desktop                                  | Not author, not placer, not the OpenAI vendor; **needs the B-2 exception** (R-5) |
| Merge, Done, close             | Principal Operator                              | §5 step 9; §10.3                                                                 |

### 4.2 Recording the auditor exception

Recording it on the issue is the narrowest fix, and §14.4 contemplates "an explicit operator-recorded exception". The alternative is Claude Code auditing its own placement, which no text prohibits but which removes the independent placement check.

---

## 5. PACE corrections in detail

### 5.1 Changed non-implementer roles

| Role                                 | P                                                                                 | A                                                                                      | C                                      | E                                                                 | Exceptions to record                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1 Prompt Author                      | ChatGPT                                                                           | Claude Desktop                                                                         | M365 (restricted, bounded review only) | Cline × DeepSeek (inactive until §3.2)                            | —                                                                                                                  |
| 12 Document Writer (Content)         | ChatGPT (no file persistence; saved and hashed by the operator or placement lane) | Claude Desktop                                                                         | M365 (restricted)                      | Cline × ChatGPT Subscription                                      | E shares the ChatGPT Plus account with P                                                                           |
| 14 Document Auditor                  | Claude Desktop (non-Anthropic-authored only)                                      | ChatGPT (non-OpenAI-authored only)                                                     | unassigned (gap)                       | Claude Code (non-Anthropic-authored; never for its own placement) | E shares the Anthropic provider and Claude Pro account with P. Claude-authored documents have one eligible auditor |
| 17 Reviewer (code and security), new | Claude Code                                                                       | Codex (when Claude Code implemented or placed the change, or is unavailable or capped) | unassigned (gap)                       | unassigned (gap)                                                  | —                                                                                                                  |

### 5.2 Implementer roles: the reviewer's proposed default (operator to accept or amend, blocker B-3)

This is a recommendation, not approved intent. It follows the request's summary line and moves the fewest slots needed to remove the conflicts in R-2.

**Roles 3 (Frontend), 4 (Backend), 5 (DevOps), 7 (Cloud) and 8 (Specialized):**

| Level | Agent                                                                                     | Vendor    | Eligibility                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P     | Antigravity × Gemini 3.8 Flash; Gemini 4 Argon only when explicitly selected and recorded | Google    | Frontend keeps "conditional on browser automation being active"                                                                 |
| A     | Cline × DeepSeek                                                                          | DeepSeek  | Active only once a §3.2 entry is in force                                                                                       |
| C     | Cline × ChatGPT Subscription; or Codex, if the operator designates it for that work unit  | OpenAI    | WUDs not authored by OpenAI only. Codex shares C's provider and account, so it substitutes for C and is not an additional level |
| E     | Claude Code                                                                               | Anthropic | WUDs not authored by Anthropic only. Its PR is reviewed by Codex                                                                |

**Role 6 (Database).** Antigravity stays excluded (Finding 4.8 is not revisited by the request).

| Level | Agent                                                | Eligibility                      |
| ----- | ---------------------------------------------------- | -------------------------------- |
| P     | Cline × ChatGPT Subscription, or a Codex designation | non-OpenAI-authored WUDs only    |
| A     | Cline × DeepSeek                                     | once §3.2 is in force            |
| C     | Claude Code                                          | non-Anthropic-authored WUDs only |
| E     | unassigned                                           | unchanged                        |

**Standing exceptions for these rows:**

- A and C share the Cline harness.
- Every local lane shares the operator workstation.
- C and a Codex designation share the ChatGPT Plus account.

### 5.3 Routing that results

| WUD author                                | Eligible implementers, in order                                                   | PR reviewer                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| ChatGPT (OpenAI), the default             | Antigravity × Gemini → Cline × DeepSeek → Claude Code                             | Claude Code; Codex if Claude Code implemented |
| Claude Desktop (Anthropic), the alternate | Antigravity × Gemini → Cline × DeepSeek → Cline × ChatGPT, or a Codex designation | Claude Code                                   |

Every routine pairing is vendor-distinct across author, implementer and reviewer (see R-18).

### 5.4 Model and effort observations (decision D: "do not fabricate supported controls")

| Lane                             | What the repository records                                | What the amendment may state                                                                                             |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Antigravity × Gemini 3.8 Flash   | "Gemini 3.8 Flash High", assessed 2026-10-01 (11 line 137) | Model and setting as recorded, last verified 2026-10-01, unless the operator supplies a newer observation                |
| Antigravity × Gemini 4 Argon     | Nothing                                                    | "Not recorded. Not selectable until the operator records availability and controls observed in the client, with a date." |
| Codex, Claude Code, Cline routes | Model names in 11 (2026-10-01)                             | Leave as recorded; add fields only from new operator observation                                                         |

---

## 6. Authorization and spending

### 6.1 Gaps

| Item                                   | Status in binding text                       | Effect                                                                                       |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cline × DeepSeek (metered API)         | No authorization, ceiling, scope or expiry   | Decision E cannot be activated until a §3.2 entry exists                                     |
| ChatGPT Plus credit with auto-reload   | No ceiling. Auto-reload was ON on 2026-10-14 | Codex, Cline × ChatGPT and ChatGPT can draw paid credit without a ceiling                    |
| Claude usage credit                    | No ceiling                                   | Claude Code review and Claude Desktop audit may draw paid credit once the allowance is spent |
| Antigravity spend beyond Google AI Pro | None recorded                                | Antigravity runs within the subscription only                                                |
| Copilot                                | "Additional usage disabled" (2026-10-14)     | No exposure, which matches decision G                                                        |
| §3.1 Vertex                            | Complete and unchanged                       | Unaffected; ends 2026-11-06 00:00 UTC                                                        |

### 6.2 Proposed §3.2: what the author's text must contain

This is a specification for ChatGPT to write from, not drafted text; the auditor does not originate content (06 §6).

1. **Title and placement.** "### 3.2 Metered model inference by agent lanes", between §3.1 and §3.3. The run guard bounds §3.1 at the next `###` heading, so the guard and §3.1 are unaffected.
2. **Default.** Agent lanes run within subscription allowances. Inference charged per use to the operator's accounts (a DeepSeek API balance, ChatGPT credit, Claude usage credit) is a billable external call under §3. It is authorized only by an entry in this section. §3.1 is unchanged and does not apply.
3. **Entry fields.** Route (harness × provider × account); lane; permitted models; work covered; monthly ceiling (USD); optional per-work-unit ceiling; provider-side stop mechanism, and whether it is a hard stop; stop line; expiry; who records charges, when and where.
4. **Initial DeepSeek entry.**
   - Route: Cline on the operator workstation, with the key held in Cline's settings by the operator.
   - Models: `deepseek-v4-pro`, the repository record of 2026-10-01; the operator confirms.
   - Work covered: implementation, tests and debugging for an approved work unit dispatched by prompt. Not authoring, research or audit.
   - Ceiling, stop line and expiry: **operator values**.
   - Recording: the operator posts the provider's charge figures on the governance issue at day 7 and day 14. This uses an existing record, not a new tracker.
5. **Stop conditions.** Ceiling reached; balance at or under the stop line; any charge not attributable to an authorized work unit; any charge after expiry. The lane stops and reports.
6. **Never.** An agent reads, prints or changes the key (§6; §11.2 item 6). An agent adds a DeepSeek call to application code or scripts; that is a new external integration (§3 table). Sensitive or Prohibited data is sent (§12). The Cline × Google Vertex model route is used.
7. **Residual risk, stated.** If the provider cannot hard-stop at the ceiling, say so, as §3.1 does for the billing export.
8. **ChatGPT and Claude credit.** No entry. The text states that consumption beyond the allowance is not authorized. The operator turns auto-reload off or caps it (provider setting), or adds an entry with a ceiling.

**Missing values (operator only):**

- monthly ceiling;
- per-work-unit ceiling (optional);
- stop line;
- expiry or review date;
- billing mode (prepaid or postpaid) and whether auto top-up is off;
- confirmation of the model list.

---

## 7. Final proposed file list

Paths are from develop @ `e2e709d`.

**Modify (required):**

1. `AGENTS.md`: §2, new §3.2, §5 (steps 4, 5 and 7, line 343), §14.2, §14.4, §15.2, §16. **§3.1 stays byte-identical.**
2. `DOCS/CODE_REVIEW_WORKFLOW.md`
3. `DOCS/governance/v1.2/companion/04-PACE-Role-Matrix-v1.0.md`
4. `DOCS/governance/v1.2/companion/05-Prompt-Author-Template-v1.0.md`
5. `DOCS/governance/v1.2/data/10-pace-roster.json`
6. `DOCS/governance/v1.2/data/11-agent-capability-matrix.json`
7. `DOCS/governance/v1.2/data/13-change-log.json`
8. `DOCS/governance/v1.2/agents/17-Gemini-profile-update.md` (append only)
9. `DOCS/governance/v1.2/agents/18-ChatGPT-profile-update.md` (append only)
10. `DOCS/governance/v1.2/agents/19-Claude-profile-update.md` (append only)

**Create:**

11. `DOCS/governance/v1.2/assessment/20-Independent-Review-Agent-Operating-Model-2026-10-18.md` (required by request §4). This is the final verdict record after the Phase 2 re-check.
12. `DOCS/governance/v1.2/integration/21-Agent-Operating-Model-Change-Request-2026-10-18.md` (recommended). The final ChatGPT change request, as the record of decisions A–I that the §16 row cites.

**Modify (recommended):**

13. `.clinerules/02-workforce-routing.md`: one sentence (R-14).

**Not modified:**

- `cspell.json`. Spelling covers only `src/`, `public/` and `test/`.
- Every file under `scripts/`, `gates/` and `.github/`.
- 01, 02, 03, 06, 07, 08, 09, 12, 15, 16.
- `DOCS/registers/*`. The harness inventory is a dated, expiring register, and no spending register exists. Model observations go in the roster's slot fields; charges go on the issue (section 6).

**Classification for CI.** Every file above is under `DOCS/`, or is Markdown outside `src/`, `public/` and `test/`. The PR therefore falls under the §4 documentation rule, and E2E is not required.

---

## 8. Claude Code placement prompt

Two things happen before this prompt is sent:

- The operator fills every `<…>` value and deletes the optional lines not approved.
- The author's revision has passed the Claude Desktop re-check.

A value left in angle brackets means stop.

````markdown
# Placement: MGPL agent operating model amendment (<WORK-ID>, #<ISSUE>)

## Your role

You are Claude Code acting as Document Writer (Placement), Alternate (04 Role 13). You place
text that ChatGPT authored and Claude Desktop audited. You are not its author, auditor or
reviewer. You do not review or audit this PR afterwards. You change no wording. The only
change you may make yourself is Prettier whitespace. A content defect you notice is reported,
not fixed (§13.3).

## Inputs (all required; stop if any is missing)

- Approved draft: `<DRAFT_PATH>`, expected SHA-256 `<DRAFT_SHA256>`, revision `<REV>`
- Audit clearance of that exact SHA-256: `<VERDICT_REF>` (PASS or PASS-WITH-FINDINGS, no open blocking finding)
- Operator exception for the Claude Desktop audit (B-2): `<EXCEPTION_COMMENT_URL>`
- Issue: #<ISSUE>, work ID <WORK-ID>. Branch: `feature/<ISSUE>-agent-operating-model`

## Preconditions (check and report each; stop on any failure)

1. `Get-FileHash -Algorithm SHA256 <DRAFT_PATH>` equals `<DRAFT_SHA256>`.
2. Issue #<ISSUE> exists and is open. No open PR, and no remote branch other than yours,
   touches any file in Scope (`gh pr list --state open`, `git ls-remote --heads origin`).
3. Do not use the existing `C:\dev\MGPL` checkout for this work. On 2026-10-18 it had an
   uncommitted change to `DOCS/doc_audit_log.md`, and its local `develop` was behind
   `origin/develop`. Leave both untouched.
4. `git fetch origin develop`, then create a new worktree on the branch from `origin/develop`, and
   run `& 'C:\Program Files\Git\bin\bash.exe' scripts/setup-worktree.sh` there
   (mgpl-gate-runner skill, prerequisite 4). Record the base SHA.
5. If the base is not `e2e709da9171adae1dead5d65e20e25744fb5d7c`, list the commits since then that
   touch any file in Scope. If any does, stop: the draft's anchors may be stale.
6. Every anchor in the draft occurs exactly once in its target file at the base. Report any that do not, and stop.

## Scope

Modify exactly:

- `AGENTS.md`
- `DOCS/CODE_REVIEW_WORKFLOW.md`
- `DOCS/governance/v1.2/companion/04-PACE-Role-Matrix-v1.0.md`
- `DOCS/governance/v1.2/companion/05-Prompt-Author-Template-v1.0.md`
- `DOCS/governance/v1.2/data/10-pace-roster.json`
- `DOCS/governance/v1.2/data/11-agent-capability-matrix.json`
- `DOCS/governance/v1.2/data/13-change-log.json`
- `DOCS/governance/v1.2/agents/17-Gemini-profile-update.md`
- `DOCS/governance/v1.2/agents/18-ChatGPT-profile-update.md`
- `DOCS/governance/v1.2/agents/19-Claude-profile-update.md`
- `.clinerules/02-workforce-routing.md` [OPTIONAL: delete this line if not approved]

Create exactly:

- `DOCS/governance/v1.2/assessment/20-Independent-Review-Agent-Operating-Model-2026-10-18.md`
- `DOCS/governance/v1.2/integration/21-Agent-Operating-Model-Change-Request-2026-10-18.md` [OPTIONAL]

Do not modify any other file, including `cspell.json`, anything under `scripts/`, `gates/` or
`.github/`, and AGENTS.md §3.1.

## Task

1. Apply each block in the draft, in order, verbatim: replace, insert after anchor, append,
   or new file, as the block states. Create the two new files from the draft's blocks.
2. Run `npx prettier --write` on exactly the changed files. Then run every check in
   "Verification". If Prettier changed anything other than whitespace, or re-padded a table
   whose cell contents then differ, stop and report.
3. Commit with the message `docs(governance): agent operating model amendment (#<ISSUE>, <WORK-ID>)`.
   Put the draft SHA-256 in the commit body.
4. Run the full gate chain: `npm run gates`, which is the mgpl-gate-runner helper. Then run
   `node scripts/mgpl-gate-guard.js verify`, which must exit 0. Also run `npm run format:check` and `npm run lint`.
5. Push only `feature/<ISSUE>-agent-operating-model`. Open a PR to `develop`:
   `gh pr create --base develop --head feature/<ISSUE>-agent-operating-model --title "docs(governance): agent operating model amendment (#<ISSUE>)" --body-file <path>`.
   Use the body template below.
6. Comment the PR URL on #<ISSUE> (§10.6). You may set the issue to `Needs validation` (§10.3).
   Change nothing else on the board.
7. Stop. Report using the Final report format.

## Verification (record each command and its output)

Run these in Git Bash from the worktree root, after Prettier and again on the final head.
Do not re-fetch `origin/develop` between precondition 4 and these checks.

a. Only the scoped files changed: `git diff --name-only origin/develop` (working tree) and
`git diff --name-only origin/develop...HEAD` (committed) each list exactly the Scope files.

b. §3.1 byte-identical:

```
node --input-type=module -e "import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';const n=t=>t.replace(/\r\n/g,'\n');const s=t=>{const a=t.search(/^### 3\.1 Authorized billable work units\s*$/m);const r=t.slice(a);const k=r.search(/\n#{2,3} /);return k<0?r:r.slice(0,k+1)};const b=n(execFileSync('git',['show','origin/develop:AGENTS.md']).toString());const h=n(readFileSync('AGENTS.md','utf8'));console.log(s(b)===s(h)?'3.1 IDENTICAL':'3.1 CHANGED')"
```

It must print `3.1 IDENTICAL`.

c. The run guard parses the same authorizations in base and head:

```
node --input-type=module -e "import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';import {parseAuthorizations} from './scripts/probes/act08/lib.mjs';const f=a=>a.entries.length+' '+JSON.stringify(a.window)+' '+a.entries.map(e=>e.id).join(',');const b=f(parseAuthorizations(execFileSync('git',['show','origin/develop:AGENTS.md']).toString()));const h=f(parseAuthorizations(readFileSync('AGENTS.md','utf8')));console.log(b===h?'LEDGER SAME: '+h:'LEDGER DIFFERS\nbase '+b+'\nhead '+h)"
```

At base `e2e709d` this prints:
`LEDGER SAME: 7 {"end_ms":1793923200000,"total_usd":275,"stop_line_usd":20} #117,#185,#192,#158,#199,#207,#208`

d. `npm run check:agents` passes, and the section count is not lower than the base's.

e. The three JSON files parse:

```
node -e "for (const f of process.argv.slice(1)) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('JSON OK')" DOCS/governance/v1.2/data/10-pace-roster.json DOCS/governance/v1.2/data/11-agent-capability-matrix.json DOCS/governance/v1.2/data/13-change-log.json
```

f. History preserved:

- `git diff --numstat origin/develop -- DOCS/governance/v1.2/agents/` shows 0 deleted lines per profile.
- `13-change-log.json` keeps every base entry:
  ```
  node --input-type=module -e "import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';const p='DOCS/governance/v1.2/data/13-change-log.json';const b=JSON.parse(execFileSync('git',['show','origin/develop:'+p]).toString());const h=JSON.parse(readFileSync(p,'utf8'));const keep=k=>b[k].every((e,i)=>JSON.stringify(e)===JSON.stringify(h[k][i]));console.log(keep('versions')&&keep('findings')?'13 HISTORY KEPT':'13 HISTORY CHANGED')"
  ```
- `11-agent-capability-matrix.json`: list every pre-existing value that changed or was removed. Each one must be named by a draft block:
  ```
  node --input-type=module -e "import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';const p='DOCS/governance/v1.2/data/11-agent-capability-matrix.json';const flat=(o,k='',r={})=>{if(o&&typeof o==='object'){for(const [x,v] of Object.entries(o))flat(v,k+'/'+x,r)}else r[k]=o;return r};const b=flat(JSON.parse(execFileSync('git',['show','origin/develop:'+p]).toString()));const h=flat(JSON.parse(readFileSync(p,'utf8')));const d=Object.keys(b).filter(k=>JSON.stringify(b[k])!==JSON.stringify(h[k]));console.log(d.length?d.map(k=>k+': '+JSON.stringify(b[k])+' -> '+JSON.stringify(h[k])).join('\n'):'11: NO PRE-EXISTING VALUE CHANGED')"
  ```

g. Cross-file agreement. For every role the amendment changes, produce one table of P/A/C/E
as written in AGENTS.md §14.2, in 04 and in 10. Any mismatch is a content defect: stop
and report it. Do not fix it.

h. No residual mandatory Codex review: `git grep -n "Codex" -- AGENTS.md DOCS/CODE_REVIEW_WORKFLOW.md`.
Every hit must be one of the following, and you report them all:

- the alternate reviewer;
- the §2 harness line;
- the §6.1.1 agent list;
- the §16 history.

## Rules

- Reserved and Prohibited actions in AGENTS.md §3.3, §10.7 and §11.2 apply in full. In particular, never:
  - push to `develop` or `main`, merge, or force-push;
  - delete a branch, worktree or stash;
  - write under `_staging\issues\`;
  - set Priority, Work type, `Backlog`, `Ready` or `Done`;
  - close an issue;
  - read or print a secret.
- One harness per branch (§2). Confirm that no other harness holds the branch before you write.
- Evidence (§13.2): report a gate that did not run as "not run". E2E is CI-owned; report it as
  "not required (docs-only rule, §4)" only if CI says so.
- Two-failure rule (§13.1): a second failure on the same defect is a handoff. Report both attempts and stop.
- Do not run or simulate the Codex review or the document audit. The operator dispatches both.

## PR body template

```
## Summary
Governance-only placement of the agent operating model amendment (decisions A–I, 2026-10-18).
<one line per file changed>

## Placement provenance
- Content: <DRAFT_PATH> rev <REV>, SHA-256 <DRAFT_SHA256>. Author: ChatGPT (Document Writer, Content).
- Audit clearance: <VERDICT_REF> (Claude Desktop, under operator exception <EXCEPTION_COMMENT_URL>).
- Placement lane: Claude Code (Document Writer, Placement, Alternate). Model <model>, effort <effort>.
- Base: <base SHA>. Head: <head SHA>.

## Validation evidence
<checks a–h with outputs; gate chain results; gate-guard verify>

## Reviews required before merge (current AGENTS.md §5; the amendment is not yet effective)
1. Codex /review against develop, posted on this PR, naming the head SHA it reviewed.
2. Claude Desktop post-placement document audit of the same head (exception <EXCEPTION_COMMENT_URL>).
Claude Code placed this change and does not review or audit it.

## Known risks / limitations
<from the draft and the review's open items>

## Deployment notes
Documentation only. No runtime, schema, gate, script or test change. Takes effect at merge into develop (Principal Operator).

Refs #<ISSUE>
Refs #139
```

## Final report format

Report a file-by-file diff summary (lines added and removed, and what changed). Report checks
a–h with their outputs, the gate results, the PR URL and the head SHA. Then give the
AGENTS.md §7 end-of-turn JSON with `issue_ref: "#<ISSUE>"`.

## End of prompt
````

---

## 9. Validation checklist

For the Phase 2 re-check, the Codex review, the post-placement audit and the operator.

**Governance consistency**

- [ ] Changed roles agree in AGENTS.md §14.2, 04 and 10 (check g).
- [ ] §5, CODE_REVIEW_WORKFLOW, 04 Role 17 and §14.4 describe the same reviewer rule, alternate and evidence (R-3, R-4).
- [ ] Role 14 lets Claude Desktop audit ChatGPT-authored documents and bars it from Claude-authored ones (R-1).
- [ ] The Gemini scope wording names the chat surface and the Cline × Vertex route. Antigravity's limitations are retained. No historical text is deleted (R-8; check f).
- [ ] The §16 row states the effective point (merge into `develop`), the evaluation window, "in force until amended", and what is new (R-10, R-13).
- [ ] Every new slot gap and correlated-failure exception is recorded (R-11). #139 is referenced, not closed.

**Permissions and spending**

- [ ] §3.1 is byte-identical, and the parser output is unchanged (checks b, c).
- [ ] §3.3, §10, §11 and §12 are unchanged. No reserved action has moved tier.
- [ ] §3.2 holds operator-supplied values only. If a value is missing, the DeepSeek lane is recorded as inactive.
- [ ] Pay-per-use ChatGPT and Claude credit is stated as unauthorized without an entry.
- [ ] No lane gains authority beyond decisions A–I. The GitHub lane still cannot write under `_staging\issues\`.

**Validity**

- [ ] The JSON parses (check e). Prettier `--check` passes on every changed file. `npm run check:agents` passes.
- [ ] Only the scoped files changed (check a).

**Review independence**

- [ ] The Codex review names the current head SHA and is not stale.
- [ ] Claude Desktop's audit names the same head, and the exception is on record.
- [ ] Claude Code neither reviewed nor audited.
- [ ] The PR body names the author, placement lane, models and draft SHA-256.

**Mandatory gates**

- [ ] The full mgpl-gate-runner chain passes on the final head. `mgpl-gate-guard verify` exits 0.
- [ ] CI lint-test passes. E2E is reported as skipped under the docs-only rule, not as passed.

---

## 10. Activation checklist (operator)

1. File the governance issue (B-1), and record the Claude Desktop exception on it (B-2).
2. Answer B-3 (implementer order) and B-4 (§3.2 values, or "DeepSeek inactive"). If you have them, supply the Antigravity observations: models available, effort controls shown and date. Without them, the defaults in 5.4 apply.
3. Set ChatGPT credit auto-reload off, or cap it, in the provider settings. Decide on Claude usage credit (R-7).
4. Send sections 1, 3, 5 and 6 to ChatGPT. ChatGPT returns revision N in **block format**: target path, operation, exact anchor text from develop @ `e2e709d`, new text. Save it to a file and take its SHA-256.
5. Claude Desktop re-checks revision N against this review and returns a verdict bound to that SHA-256.
6. Dispatch section 8 to Claude Code.
7. Dispatch the Codex `/review` on the PR head, then the Claude Desktop post-placement audit of the same head. Any new commit makes both stale.
8. Merge into `develop` yourself. The amendment takes effect at that merge commit. Post the merge SHA and the evaluation end date (merge + 14 days) on the issue.
9. Set `Done` and close the issue (§10.3, §10.6).
10. Decide when to promote to `main`. Until then, lanes that read the default branch see the old text.
11. On day 7 and day 14, post on the issue, from existing records only:
    - work units accepted;
    - first-pass gate results and correction rounds;
    - review findings;
    - quota use;
    - DeepSeek charges;
    - interventions.

---

## 11. Outstanding blockers

Only these prevent compliant implementation.

| #   | Blocker                                                                                                                                                                                                | Why it blocks                                                                                                                           | Resolution                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | **No change-request identifier exists.** The 40 most recent issues and PRs (through #210) and every open issue were checked; none covers this change. The search API was not available in this session | §5 branch name `feature/<task-id>-…`; §10.6 PR linkage; the request says not to invent one                                              | The operator files a Governance issue. Proposed title: _"AI-0NN: Activate the 2026-10-18 agent operating model (ChatGPT writes, Claude Desktop audits, Antigravity/Cline/Codex implement, Claude Code reviews code)"_. The highest work ID seen is AI-091 (#199). The body cites decisions A–I, this review and the Activation checklist as acceptance criteria. Refs #139, #63 |
| B-2 | **Claude Desktop is outside its Role 14 slot for this audit**                                                                                                                                          | Otherwise no eligible auditor is both non-OpenAI and not the placer: P is recused, A is excluded, C is the same vendor, E is the placer | One operator comment on the issue: an exception to the 04 Role 14 restriction, allowing Claude Desktop to audit this ChatGPT-authored change request, its revisions and the placed PR diff                                                                                                                                                                                      |
| B-3 | **Implementer PACE order not decided** (R-2)                                                                                                                                                           | Roles 3–8 cannot be written without inventing an order                                                                                  | "Accept 5.2", or state the order                                                                                                                                                                                                                                                                                                                                                |
| B-4 | **DeepSeek ceiling values missing** (R-7). This blocks only decision E's DeepSeek activation                                                                                                           | A billable call without a recorded ceiling is reserved (§3, §3.3)                                                                       | Supply the six values in 6.2, or accept "Cline × DeepSeek inactive until a §3.2 entry is placed"                                                                                                                                                                                                                                                                                |

Not blockers: the author's revision (Phase 2) is the normal next step; the Gemini 4 Argon observations have a safe default (5.4).

---

## Verified items

- §2 lines 42–47.
- §3 line 65.
- §3.1 structure and parser bounds: `lib.mjs` lines 775–781.
- §5 lines 322–343.
- §10.2 line 609.
- §14.2–14.4 lines 926–947.
- 04 Roles 1–16.
- `10-pace-roster.json` and `11-agent-capability-matrix.json` entries cited.
- 08 §3.2 and Finding 3.2.
- 07 lines 43–46, 95 and 503.
- 01 line 123.
- 17 lines 11, 38–55.
- 19 lines 52 and 80–85.
- PR #209 audit eligibility statement.
- PR #191 and #175 review precedents.
- Open issues #139, #141 and #63.
- CI docs-only classification (`pull-request-validation.yml` line 90).
- cspell scope (`package.json` `test:spell`).
- Prettier coverage of `**/*.md` and `**/*.json` (`scripts/check-format-changed.js` lines 12–13).

## Unverified items

- **Sourced from the operator's records, not live:** the subscription state, credit balances and the auto-reload setting, from the Usage Strategy of 2026-10-14. The operator confirms current values.
- **No record:** Gemini 4 Argon availability and controls.
- **Not checked:** the current DeepSeek billing mode.
- **Duplicate search was by listing, not full-text search,** because the search API was unavailable.

## Scope

- **In scope:** the change request against develop @ `e2e709d` and the 12 sources it names, plus the files they depend on (03, 07, 08, 01, `.clinerules/02`, `lib.mjs`, CI workflow, `package.json`), the related issues and PRs, and the operator's 2026-10-14 project records.
- **Not reviewed:** the amendment text, which does not yet exist (Phase 2).
- **Not done:** any file change, commit or merge. None was made or is claimed.
