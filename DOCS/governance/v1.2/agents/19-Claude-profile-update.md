# Agent Profile Update — Claude Desktop (Opus 5.5)

**Version:** 1.0
**Date:** October 1, 2026
**Agent:** Claude Desktop — Opus 5.5 (xhigh) (Anthropic)
**Model:** Opus 5.5, xhigh effort
**Tier:** Max (5x), downgrade to Pro next month

## Change

Claude Desktop is promoted to Primary for the Document Writer (Content)
role and the Prompt Author role. The promotions reflect the results of the
October 1, 2026 reformat test.

## Rationale

Claude Desktop produced the strongest reformat test result in the
assessment set:

- All 28 Prohibited actions preserved with original numbering
- All 13 P-A-E actions preserved
- All 12 Permitted actions preserved
- All governing rules preserved
- Both findings 3.5 and 3.6 preserved in full
- P-A-E workflow format preserved verbatim
- No fabrications of any kind
- Produced a persistent markdown file
- Flagged two source citation errors (Finding 4.20 misreference, Finding 37
  does not exist)
- Flagged a test-design issue (the product name was not in the source
  excerpts provided)
- Documented source attribution for every section

The two source citation errors Claude found were real. They existed in the
Operations Governance Manual v1.1 and had not been caught during the
original document production. Claude detected them from within the source
material and reported them separately without altering the content it was
asked to reformat.

That behavior — preserve the source faithfully, flag errors separately — is
exactly what the Document Writer (Content) role and Prompt Author role
require.

## PACE Placements (v1.2)

| Role                        | Level                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| Prompt Author               | **Primary**                                                         |
| Document Writer (Content)   | **Primary**                                                         |
| Specifier / Architect       | Alternate (pending bounded specification test)                      |
| Researcher                  | Alternate                                                           |
| Document Auditor            | Alternate (non-Claude-authored, non-OpenAI-authored documents only) |
| Adversarial Reviewer        | Alternate (pending bounded test)                                    |
| Document Writer (Placement) | Not placed pending test                                             |
| Implementer (any specialty) | Not placed                                                          |

## Known Limitations (carried forward)

- **Memory conflict.** The Claude Memory store held MGPL architecture
  facts, which met the Reserved Action definition of prohibited memory.
  Memory generation is now off. The existing files remain; deletion is an
  operator decision.
- **Shared-identity risk.** Every connector acts as the operator. This
  does not affect the Document Writer (Content) or Prompt Author roles,
  which do not use connectors. It does affect any role that holds
  credentials or executes actions.
- **Vendor overlap with Claude Code.** The two share a vendor, so Claude
  Desktop cannot audit Claude Code's work or vice versa without an
  operator-recorded exception.
- **Plan downgrade.** Max (5x) becomes Pro next month. Pro limits may
  constrain long sessions.

## No New Findings

The reformat test produced no new findings about Claude Desktop. The
existing profile stands.

## Note on Governance Roles

Claude Desktop is now Primary for both Prompt Author and Document Writer
(Content). These are distinct roles. The Prompt Author writes prompts for
other Agents. The Document Writer (Content) produces governance prose.
Claude must not perform both for the same work unit — the prompt writer
and the content writer must be different parties when the artifact is
subject to independent review.

## Operating-model addendum authored 2026-10-19

Effective at the operator’s merge into `develop` of the PR for governance issue #139 (work ID AI-070), using the adoption mechanism in AGENTS.md §16. The adoption comment, merge SHA and evaluation end date are recorded on that issue.

The original profile above remains dated assessment history.

Role 1 Prompt Author and Role 12 Content Writer become Alternate. Role 14 Document Auditor becomes Primary for non-Anthropic-authored documents only. Option (b) assigns Claude Desktop WUD authorship for Frontend, DevOps, Database, Cloud and other work outside Antigravity qualifications. Both Role 2 pending bounded specification tests remain; this assignment is not a test result. Prompt and content authors must be different parties for a work unit under independent review.

Role 14 Emergency remains Claude Code, non-Anthropic-authored documents only and never its own placement. CF-AUDIT names its shared Anthropic provider/account with Claude Desktop and requires the operator’s adoption-comment-and-merge mechanism in AGENTS.md §16. Anthropic-authored documents have only ChatGPT Alternate as eligible auditor. A shared Claude allowance failure removes Primary and Emergency together and stops new option-(b) WUD authoring; 04 §3 distinguishes already-authored/validly audited work from new work that waits. No usage-credit spending is authorized and no current billing settings are asserted.

For this amendment’s transition, the original Role 14 slot restriction still binds Claude Desktop; its re-checks are advisory. Cline × ChatGPT Subscription mechanically places, Claude Code formally audits the placed head, Codex performs current §5 review and the operator merges, subject to the unresolved retained-source authorship/reviewer determination. Neither withdrawn B-2 nor the original review’s §8 placement prompt authorizes a different transition. See AGENTS.md §16 and integration/25.

**End of Claude Profile Update.**
