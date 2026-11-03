# SPEC-GITHUB-PROJECT-SOP — Working Practice for MGPL Delivery

**Status:** PROPOSED — 30-day operating trial
**Version:** v6, 2026-09-22 (supersedes v1–v5)
**Owner:** Principal Operator
**Approval:** Decisions resolved 2026-09-22 (§0). Ready to adopt.
**Effective date:** on commit of §2 to `AGENTS.md`
**Trial start / review date:** to be set on adoption
**Authority:** `AGENTS.md` controls where this document conflicts with it
**Drafted by:** Claude, as a proposal under `DOCS/specs/`
**Target:** §2 only enters `AGENTS.md`; this document stays in `DOCS/specs/`

**Board:** MGPL Delivery, project number 1 (`PVT_kwHOCqPew84BjzKt`). Field values below are the real ones, read from the board on 2026-09-22.

---

## 0. Decisions — resolved 2026-09-22

**D-1 — Agents may move cards. RESOLVED: (a).**

Agents set `Ready` → `In progress` → `Blocked` → `Needs validation` for work they are doing. The operator sets Priority and `Done`, and closes issues. Agents never move another lane's card.

Reasoning: filing and moving carry different risks. Filing inflates a backlog and cleaning one is real work — hence propose-only. Moving a card is trivially reversible and inflates nothing. And the evidence favours (a): the board is currently 50% stale under operator-only maintenance, which is what happens when the only person who can update it has a full-time job.

**This must be made explicit in `.claude/settings.json`, not left as a gap.** Agents can currently run `gh project item-edit` only because AI-035's deny list targeted `gh api` and nobody considered `gh project`. Silent capability is the pattern that caused today's failures. The settings file states the permission; the ledger no longer has to be interpreted.

**D-2 — Section number. RESOLVED: `## 10.`**

`AGENTS.md` ends at `## 9. Keep This Document Current`. Board practice is not a subsection of document-currency, so `9.1` is wrong. Appending as §10 leaves the maintenance section no longer last, which is cosmetic; inserting at §9 and renumbering risks breaking cross-references, which is not.

---

## Revision history

_Trimmed to a decision record on permanent adoption._

**v2** fixed nine defects: `Closes #NN` does not fire on PRs into `develop`; an internal contradiction over what gets tracked; **citations to `AGENTS.md` §19.5 and end-of-turn fields that do not exist**; no `Blocked` status; no default Priority; stale closure that would sweep externally blocked work; a late-firing three-issue rule; an over-broad automation ban; an unanswered authority question.

**v3** fixed six: propose-only decided outside the binding clause; closure left as three options; an inaccurate description of `Refs`; an overcorrection calling GitHub history immutable; a TODO rule conflated with the code lint; an open-ended `keep` exemption.

**v4** fixed three: an adoption step that would have **merged a dummy PR into `develop`**, triggering the staging deploy; `issue_ref` unable to express a proposal; a PR-linkage metric with the wrong denominator.

**v5 — the `[CONFIRM]` markers were not cosmetic.**

Four document reviews treated the unresolved field strings as a formality. Cline read the board and found the SOP's status vocabulary is not a spelling difference — it is a **different model**:

| SOP v4 value                 | Actual board value                                  | Status                                           |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `Todo`                       | `Backlog`, `Ready`                                  | Absent — and the board splits one state into two |
| `In Progress`                | `In progress`                                       | Case mismatch; exact strings are operational     |
| `Blocked`                    | `Blocked`                                           | Match                                            |
| `In Review`                  | `Needs validation`                                  | Absent                                           |
| `Done`                       | `Done`                                              | Match                                            |
| Priority `Unprioritized`     | `High`, `Medium`, `Low` only                        | Absent                                           |
| Work type — no mapping given | `Work unit`, `Finding`, `Environment`, `Governance` | Undefined in v4                                  |

Also fixed in v5: no definition of "session"; no counting rule for the three-proposal limit; `proposed_issues` missing `work_type` despite Work type being required at filing.

**v6 — verification against the live board.** `no-stale-close` does not exist and must be created; the auto-add label is `work-unit`, not `work-item`. My claim that a `Backlog` item has no Priority is contradicted — #55, #57 and #63 all sit in `Backlog` with Priority set — so `Backlog`/`Ready` now means _accepted_ versus _queued_, which fits observed practice and keeps the distinction useful. `gh project item-edit` was confirmed working by a reversible probe on #57, answering the technical half of D-1. And the board holds five closed issues still in `Ready` or `Backlog` with `Done` never used, which §7 now reconciles before the clock starts.

**The board's model is better than mine.** `Backlog` / `Ready` separates _accepted_ from _ready to start_, which pairs naturally with Priority assigned at triage — and dissolves the need for an `Unprioritized` option entirely. v5 adopts the board's vocabulary rather than asking the board to change.

---

## 1. Scope

The board tracks active work. The repository tracks durable evidence. Governance decisions live in `AGENTS.md` and `DOCS/specs/`. This document governs the first only.

The board replaced Jira provisionally, after the Atlassian instance was found to hold only wizard placeholders. It is on trial; §5 sets the criteria for concluding it, so the board either becomes the tracker deliberately or is dropped deliberately rather than by inertia.

---

## 2. Proposed clause for `AGENTS.md`

Only the block below enters `AGENTS.md`, as §10. It is paste-ready; the section numbers are resolved.

> ### 10. MGPL Delivery — Working Practice
>
> MGPL Delivery (project 1) is the single tracker for active work. **No competing active backlog or second task tracker.** Session-local notes and repository evidence documents are permitted where they do not constitute a second work queue. (Distinct from the repository's TODO/FIXME lint, which governs code.)
>
> **"Session" means one continuous agent conversation in one lane.** It ends when that conversation ends, when work passes to another lane, or when the operator closes it. A resumed conversation is a new session. A gate run or review round inside a conversation is not a session boundary.
>
> #### 10.1 Filing authority and what becomes an issue
>
> **During the trial, only the Principal Operator creates issues.** Agents propose issues in their end-of-turn report and do not run `gh issue create`. Agent filing authority may be expanded at the 30-day review.
>
> **The threshold is continuity.** Work that will outlive the current session is tracked by an issue. Work that begins and finishes within one session is reported in the end-of-turn report and nowhere else.
>
> An issue is proposed when work meets **any** of:
>
> - It will not finish within the current session.
> - It is blocked on something or someone else.
> - Another lane, or the Principal Operator, must act on it.
> - It has an external deadline.
> - It is a defect found outside the pull request that introduced it.
>
> An issue is **not** proposed for: a step inside work already in progress; a finding on an open PR, which belongs in the PR review; an idea nobody has committed to doing; or a restatement of something already on the board.
>
> **The three-proposal limit.** An agent that reaches a **fourth** candidate from one investigation stops, lists all candidates in its report, and asks the Principal Operator which to file. Counting rules: count after deduplication; do not count candidates matching an already-open issue; do not count defects fixed within the same session; a group of related failures with one root cause counts as one.
>
> #### 10.2 Issue anatomy
>
> Title: `<WORK-ID>: <imperative summary>` — for example `AI-029: Separate GitHub identity for agents`. Work IDs follow the `AI-0NN` and `ACT-NN` conventions; an unplanned defect uses `fix:` and no work ID.
>
> Body carries, in order:
>
> 1. **Problem** — two or three sentences.
> 2. **Acceptance criteria** — checkable by someone who did not write it. State here if completion requires promotion to `main` rather than merge into `develop`.
> 3. **Evidence** — links to the file, PR, run or document that established it. An issue asserting a defect with no evidence is a hypothesis and says so.
> 4. **Blocked by** — issue numbers, or None.
> 5. **Provenance** — `Proposed by: <agent> / <session>` or `Filed by: Principal Operator`.
>
> The provenance line is **self-reported attribution, not proof**. Every agent and the operator share one GitHub token (AI-029, #63), so the author field carries no information and anyone with the credential can write any value. When separate identities exist, GitHub identity becomes the accountability record.
>
> #### 10.3 Status
>
> The board's exact option strings. They are case-sensitive and used verbatim in `gh project item-edit`.
>
> | Status             | Meaning                                                                         | Who sets it        |
> | ------------------ | ------------------------------------------------------------------------------- | ------------------ |
> | `Backlog`          | Accepted, not yet queued. Priority may or may not be set.                       | Operator at filing |
> | `Ready`            | Queued — next to be picked up. Priority set.                                    | Operator at triage |
> | `In progress`      | An owner is actively executing it. Not merely that a branch exists.             | Agent or operator  |
> | `Blocked`          | Cannot proceed without a dependency or decision.                                | Agent or operator  |
> | `Needs validation` | A PR is open, or operator acceptance is required. The PR URL goes on the issue. | Agent or operator  |
> | `Done`             | **The PR has merged into `develop`.**                                           | **Operator only**  |
>
> **Done is reached at merge into `develop`.** An issue whose acceptance criteria state that completion requires production deployment reaches Done only at promotion to `main`. Absent that statement, `develop` is the completion point.
>
> An item enters `In progress` only from `Ready`. Work that should not proceed is closed as **not planned**, with a one-line reason, by the operator.
>
> #### 10.4 Priority and Work type
>
> **Priority is `High`, `Medium` or `Low`, and is set by the Principal Operator only.** An agent never sets or changes it.
>
> There is no `Unprioritized` option and none is needed: an untriaged issue simply has no Priority value. Priority may be set while an item is still in `Backlog` — current board practice does this and it is fine. `Ready` is the signal that an item is _queued_, not merely prioritised.
>
> An item enters `In progress` from `Ready`. A `Backlog` item does not, except for a production incident or an explicit operator request.
>
> **Work type** is one of `Work unit`, `Finding`, `Environment`, `Governance`, mapped as:
>
> | Work type     | Use for                                                     |
> | ------------- | ----------------------------------------------------------- |
> | `Work unit`   | Planned, specified work with a work ID — `AI-0NN`, `ACT-NN` |
> | `Finding`     | A defect found outside the PR that introduced it            |
> | `Environment` | Tooling, gates, CI, local setup, credentials                |
> | `Governance`  | `AGENTS.md`, specs, authorization, process                  |
>
> A proposed issue names its intended Work type; the operator sets it at filing.
>
> #### 10.5 Work in progress limit
>
> **No more than three items in `In progress` across all lanes at once.** `Blocked` items do not count, and are reported separately at grooming so blocked work cannot accumulate invisibly behind a healthy-looking active count.
>
> Six agent lanes and one part-time operator cannot carry more. An agent asked to start work that would exceed the limit reports the limit, names what is already in flight, and asks which to displace. Finishing beats starting.
>
> #### 10.6 Pull request linkage and closure
>
> GitHub's closing keywords act only on pull requests targeting the repository's **default branch**. MGPL's default is `main` and feature PRs target `develop`, so `Closes #NN` in such a PR is **ignored entirely** — no link is created and nothing closes.
>
> - The PR body carries **`Refs #NN`** as a visible cross-reference. This is text, not GitHub's formal Development linkage.
> - The issue receives the PR URL explicitly when the PR opens.
> - **After an approved PR merges into `develop`, the Principal Operator sets `Done` and closes the issue.** One mechanism, deliberately manual for the trial. A narrowly scoped GitHub Action may be authorised at the 30-day review — not before.
>
> **End-of-turn schema.** Two fields are added in the same commit as this section, or propose-only lives only in prose. The current schema is `{status, summary, gates_passed, next_action, escalation_required, escalation_reason}`.
>
> ```json
> "issue_ref": null,
> "proposed_issues": [
>   {
>     "title": "AI-0NN: Imperative summary",
>     "work_type": "Work unit | Finding | Environment | Governance",
>     "problem": "...",
>     "acceptance_criteria": ["..."],
>     "evidence": ["file path, PR URL, run ID or commit SHA"],
>     "blocked_by": [],
>     "hypothesis": false
>   }
> ]
> ```
>
> `issue_ref` names the existing issue the work belongs to, or `null` for session-local work. `proposed_issues` is empty unless the turn produced candidates; entries carry no issue number, because a proposal has none. `evidence` entries are file paths, URLs, run IDs or commit SHAs — not prose. `hypothesis: true` marks a candidate asserting a defect without evidence.
>
> #### 10.7 What agents do not do on the board
>
> - Create issues during the trial.
> - Set or change Priority.
> - Set `Done`.
> - Close any issue.
> - Delete an issue.
> - Re-open a closed issue silently.
> - Propose an issue duplicating an open one. Search first.
>
> #### 10.8 Automation
>
> Only GitHub Projects' **built-in** workflows are enabled during the trial. No custom tooling, no bespoke scripts.
>
> Permitted: auto-add repository issues carrying the **`work-unit`** label; set newly added items to `Backlog`; archive `Done` items after an agreed retention period.
>
> **Not automated:** `In progress`, `Blocked`, `Needs validation`, `Done`, and issue closure.
>
> #### 10.9 Grooming
>
> A pass every 30 days, aligned to the ledger review. Triage of new issues happens weekly, so nothing sits in `Backlog` for a month.
>
> The operator:
>
> - Assigns Priority to `Backlog` items and moves them to `Ready`.
> - Reports the `Blocked` count and the age of the oldest blocked item.
> - Closes as **not planned** anything untouched for 60 days, with a one-line reason — **except** items labelled `no-stale-close`, which requires a stated reason or target date in the body and is re-examined every grooming. An exemption without a current reason is removed.
> - Confirms nothing sits in `In progress` that is not actually in progress.
>
> Closing stale issues is the point, not a side effect. A backlog accumulates the way tools do, and an issue nobody has touched in two months is not a plan — it is a record that something once seemed interesting.

---

## 3. Issue template

Commit as `.github/ISSUE_TEMPLATE/work-item.md`. Confirmed absent from the repository, so this fills a real gap.

```markdown
## Problem

<Two or three sentences. What is wrong or missing.>

## Acceptance criteria

- [ ] <Checkable by someone who did not write this.>
- [ ] <State here if completion requires promotion to main rather than merge
          into develop.>

## Evidence

<File paths, PR URLs, run IDs or commit SHAs. If none, say
"Hypothesis — not yet evidenced.">

## Blocked by

<Issue numbers, or "None">

---

Proposed by: <agent name> / <session> <!-- self-reported -->
Work type: Work unit | Finding | Environment | Governance
```

---

## 4. Filing authority — reasoning

The rule is in §2.1. The reasoning, which does not belong in `AGENTS.md`:

Attribution does not exist until AI-029 lands, so a filed issue cannot be traced to its author. The board's dominant failure mode is inflation. And agent reports during this period included several that were confidently wrong, one of which reviewed a document it had not read.

**Upgrade path** for the 30-day review if transcription proves burdensome: agents file directly for _evidenced defects, explicitly requested work, blockers, and operator-authorised follow-ups_; they propose for _speculative enhancements, architectural changes, new integrations, and anything past the third candidate_. Priority stays operator-only either way.

Starting restrictive and loosening is recoverable. Starting permissive and tightening means cleaning a board first.

---

## 5. Concluding the trial

1. **Is it current?** Does board status match repository reality?
2. **Did it survive contact?** Are issues closed by merged PRs, or in bulk as stale?
3. **Did it change anything?** Did work get picked up, sequenced or dropped _because of_ the board?

| Measure                 | Target        | How measured                                                                                                     |
| ----------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Status accuracy         | ≥ 90%         | Sample every active item; compare status against repo and PR reality                                             |
| Abandoned `In progress` | 0             | Items `In progress` with no commit or comment in 14 days                                                         |
| PR linkage              | ≥ 80%         | Of PRs **associated with tracked work**, how many carry `Refs #NN`. Session-local work legitimately has no issue |
| Triage latency          | ≤ 7 days      | Time from filing to Priority assignment                                                                          |
| Decision influence      | ≥ 1           | Name one item prioritised, deferred or rejected _because of_ the board                                           |
| Maintenance cost        | < 15 min/week | Recorded weekly triage duration                                                                                  |

If question 3 is no after 30 days, the board is documentation rather than a tracker and should be dropped. Jira was replaced for being placeholder content nobody used; the replacement earns its place on the same test.

---

## 6. Decision record

**Dormant Jira rejected.** A dormant instance is a live credential, a live service and a line in the tool register, kept against a hypothetical — the accumulation problem this SOP resists. If a governance tracker is needed later, that is a decision to make then.

**GitHub history judged sufficient for operational tracking, and not claimed as more.** It provides edit, timeline and deletion history adequate for tracking work. It is **not** an immutable compliance audit log: authors and write-access users can delete edit revisions, at most 100 edits per item are retained, administrators can delete issues, comments can be deleted. _(An earlier draft called the "no immutable audit trail" criticism false. That was an overcorrection and is withdrawn.)_

---

## 7. Adoption

1. Decisions resolved — see §0.
2. **Create the `no-stale-close` label.** It does not exist. `work-unit` does and is the auto-add key.
3. **Reconcile the baseline before the clock starts.** The board holds ten items, **five of them closed issues still sitting in `Ready` or `Backlog`, and `Done` has never been used** — count zero. Starting a 90%-status-accuracy trial from a board that is 50% stale measures the seeding, not the practice. Move closed items to `Done` or remove them from the board, and record the reconciled counts as the baseline.
4. Observe the cross-reference: create a dummy issue, branch from `origin/develop` with a `fix/` prefix — `chore/` and `governance/` are rejected by `doctor.js` — open a **draft** PR into `develop` carrying `Refs #<id>`, record how the reference renders, then close the PR unmerged and the issue. **Do not merge it**: that would alter integration-branch history, trigger the staging deploy, and leave permanent noise, to prove something that no longer matters now closure is manual.
5. Commit §2 to `AGENTS.md` **and add both `issue_ref` and `proposed_issues` to the end-of-turn schema in the same commit.**
6. Add the issue template.
7. Enable only the native workflows in §10.8.
8. Set the trial start and review dates in the header.
9. Run the trial. Decide at 30 days.

---

## 8. Open, outside this document

**Phantom citations remain repository-wide.** `DOCS/specs/ACT-08-google-cloud-capability-exploration.md:193` cites `AGENTS.md` §19.5, which does not exist. A grep for `§19.5` and for `committed` / `pushed` / `pr_url` should run as its own task.

**Doppler has two requirements**, belonging in the agent brief template: a new worktree needs `doppler setup` before anything runs, and ad-hoc commands outside the gate scripts need a `doppler run --` prefix. The gate runner resolves Doppler itself; the binding is the part easy to miss.
