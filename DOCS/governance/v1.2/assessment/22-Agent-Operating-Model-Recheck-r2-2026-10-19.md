# Phase 2 Re-check r2: Exact Amendment Authoring Contract (2026-10-19)

```text
AUDITOR VERDICT (ADVISORY: current Role 14 restriction applies)
---------------
Document: "MGPL Agent Operating Model — Exact Amendment Authoring Contract" (ChatGPT)
          SHA-256 adcae944e688f737d0935e12cac78285141a56481025abc0210adc1a3efd3980
Auditor:  Claude Desktop lane (Claude; session configured as claude-opus-5-5)
Date:     2026-10-19
Basis:    develop @ e2e709da9171adae1dead5d65e20e25744fb5d7c (unchanged)
Verdict:  FAIL: still not placeable. The contract says so itself (section K).
          The direction is acceptable, subject to the corrections below.
```

## Summary

This contract settles most of the policy. It:

- adopts the PR #209 transition lanes (C-2);
- proposes option (b) for routing (C-3);
- states the day-14 default (C-7);
- makes prompt-writer and content-writer separation party-neutral (C-8);
- puts review provenance on the PR (C-6);
- bars Claude usage credit and OpenAI auto-reload spending (C-4);
- carries Antigravity's limitations and the Codex runtime caveat into the capability matrix (C-5, R-15).

The three anchors it names exist exactly once at the base:

- §2 line 42;
- the §14.4 "Prompt Author separation" bullet;
- 05 line 22.

It is still an authoring contract, not a block package. Several items also need correcting before ChatGPT renders the final text: one routing logic error, and some changes beyond the approved decisions.

## Blocking corrections for the block package

**D-1. The "Claude Code conditional" fallback breaks the vendor rule.**

- **Location:** E table (Frontend, DevOps, Database, Cloud rows); §14.2 "Implementer" line.
- **Problem:** In those rows the primary route uses a **Claude-authored** WUD. Claude Code implementing a Claude-authored WUD is Anthropic on Anthropic, which breaks the contract's own C4 "Implementation compatibility" rule and 04 line 49.
- **Correction:** State the condition. The Claude Code fallback requires the WUD to be authored, or re-authored, by ChatGPT, with Codex as the PR reviewer. Without that condition, the fallback slot is ineligible and must be recorded as unavailable.

**D-2. Some changes remove existing assignments that decisions A–I did not touch.**

| Role                                          | Current assignment                                              | What the contract would do                                                                  | Correction                                                                                                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Researcher (Role 11; §14.2 line 935)          | P ChatGPT, A Claude Desktop, C M365, E DeepSeek                 | Missing from the new §14.2 list and the E table, so a "replace the summary" would delete it | Keep it unchanged                                                                                                                                                                                                                                                      |
| Discovery (Role 9)                            | A ChatGPT, C Claude Code, E Cline × ChatGPT                     | "Other separately eligible read-only engineering agents"                                    | Keep A, C and E unchanged                                                                                                                                                                                                                                              |
| GitHub Implementer and Analyst (Roles 10, 16) | A ChatGPT, C Cline × ChatGPT, E Cline × DeepSeek                | "Deterministic authorized operations"                                                       | Keep the levels. Add the deterministic-preference rule, and record E as inactive (DeepSeek)                                                                                                                                                                            |
| Prompt Author (Role 1)                        | C M365 (restricted, bounded review only)                        | "Remaining slots unavailable"                                                               | Keep M365 C. Mark E (Cline × DeepSeek) inactive                                                                                                                                                                                                                        |
| Document Writer (Placement) (Role 13)         | P ChatGPT, A Claude Code, C Cline × ChatGPT, E Cline × DeepSeek | Makes Cline × ChatGPT Primary                                                               | No approved decision covers this, and it isn't needed: the transition uses the existing C slot. Leave Role 13 unchanged except to note that ChatGPT never places a document it authored and that E is inactive. Otherwise the operator approves the re-slot explicitly |

**D-3. The E table is not in PACE form.**

- **Problem:** "Preferred route / fallback" drops the C and E levels, the correlated-failure record (harness, provider, account, execution host) and slot status.
- **Correction:** Render every changed role as the full 04 P/A/C/E table. Use the WUD-author condition per slot, write "unavailable (reason)" for empty slots, and record named exceptions. The new Reviewer role is written in the same form: P Claude Code; A Codex (when not the implementer); C and E unavailable.

**D-4. The Document Auditor wording is too narrow and incomplete.**

- **Problem:** "Claude Desktop Primary for OpenAI-authored documents" leaves documents authored by DeepSeek, M365 or Copilot uncovered.
- **Correction:** Use "non-Anthropic-authored documents"; ChatGPT A stays "non-OpenAI-authored". State Claude Code's E slot either way: kept, as non-Anthropic-authored and never its own placement, with the shared-account exception recorded; or marked unavailable.

**D-5. No exact text is supplied for several items. The placement lane must not compose any of it.**

| Item | Missing text                                                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | The harness bullets (Antigravity; Claude Code's reviewer duty). The new "One execution harness owns a feature branch at a time" sentence repeats the existing line-44 bullet. Either replace that bullet or drop the sentence |
| C2   | Exact replacements for §5 steps 4, 5 and 7 and line 343, with anchors                                                                                                                                                         |
| C3   | The full new §14.2 list. "Replace the outdated role summary" names no anchor and no final text                                                                                                                                |
| C5   | The §16 row and the §15.2 lines                                                                                                                                                                                               |
| D    | The full replacement of `CODE_REVIEW_WORKFLOW.md`, keeping the doctor and gates step, P0/P1 resolution, re-review, the PR command, and the fallback ladder verbatim                                                           |
| F    | The roster JSON and the 13 entry                                                                                                                                                                                              |
| H    | The template section                                                                                                                                                                                                          |
| I    | The `.clinerules/02` sentence                                                                                                                                                                                                 |

## Non-blocking

**D-6. Claude Desktop is now in every work unit.** The C4 work-unit authorship rule (my R-12) and option (b) together put Claude Desktop in each work unit, in one of two ways:

- writing the WUD (OpenAI-implemented work);
- writing the prompt and auditing the WUD (ChatGPT-authored work).

That raises the shared Claude allowance load the contract itself flags. If the operator would rather not carry that load, an operator-accepted alternative is to treat a reviewed WUD as the implementer's prompt for low-risk units. Watch this in the trial.

**D-7. "Paid execution" sits in §14.4.** The rule is right, but compliance depends on provider settings, not on agent behaviour. Reword it so the operator controls auto-reload and usage-credit settings, and an agent that sees paid-credit consumption stops and reports.

**D-8. Profile 17 line 54 is stale.** "No further Google integration remains" is contradicted by the Vertex ledger entries. Note this in the 17 addendum. Do not delete the original line.

**D-9. Role 2 status.** Keep "pending bounded specification test" for both ChatGPT and Claude Desktop, unless the operator records the trial as that test.

## Operator inputs

1. **Issue.** It is still not filed; the newest issue is #210. It blocks the branch name and the §16 row.
2. **Option (b).** Confirm it. The contract marks it "proposed".
3. **D-2, Role 13.** Choose: leave Role 13 unchanged (recommended), or approve the re-slot.
4. **D-4.** Keep Claude Code as Role 14 E, or record it as unavailable.

## Next step

ChatGPT renders the complete block package. That means every target file, with exact anchor and new text, and all of D-1 to D-5 applied. One more advisory re-check follows. Then placement by Cline × ChatGPT, audit by Claude Code, review by Codex, and merge by the operator.
