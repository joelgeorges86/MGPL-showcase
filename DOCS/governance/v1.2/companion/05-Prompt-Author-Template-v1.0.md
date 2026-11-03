# MGPL Prompt Author Template v1.0

**Version:** 1.0 (extracted from Manual v1.1 — unchanged)
**Date:** October 1, 2026
**Owner:** MGPL Governance Office (operator)

## 1. Two Templates

- **Implementer Prompt** — for tasks that produce code, files, or git operations
- **Researcher Prompt** — for tasks that produce reports, research briefs, or analysis

## 2. Required Source Documents

Before writing a prompt, the Prompt Author must have:

| Document             | Purpose                                                                                              | Produced by |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| rules-digest.md      | Current Reserved Actions, scope discipline, evidence discipline, data handling                       | Discovery   |
| environment-state.md | Current node version, working directory, active branches, pre-existing tree changes, available tools | Discovery   |
| task-proposal.md     | The operator's statement of what needs to be done                                                    | Operator    |

**Provenance requirement:** Every source document must carry a commit SHA and a generation date. The Prompt Author must stop on stale input and request an update before continuing.

## 3. Implementer Prompt Template

```markdown
# <Task Title>

## Context

You are executing a bounded implementation task for MGPL.

[One paragraph describing what MGPL is and what the task is meant to accomplish.]

## Environment

- Operating system: <from environment-state.md>
- Workspace root: <from environment-state.md>
- Node version: <from environment-state.md>
- Available tools: <from environment-state.md>
- Current branch: <from environment-state.md>
- Pre-existing working-tree changes: <from environment-state.md, or "none">

## Assignment and provenance

- Effective governance revision / applicable adoption record: <verified references to AGENTS.md §16 and 04 §3>
- Prompt Author / Content Writer: <different parties when independently reviewed>
- Assigned implementer: <eligible PACE role, level and lane; unresolved conditions disclosed>
- WUD path / SHA-256 / author / upstream model vendor: <verified source; or none with reason and applicable source-package/specification provenance>
- Implementation vendor/model-family separation: <checked against actual WUD author>
- Harness / actual model / effort: <explicit selection; never switch automatically>
- Tier / tool surface / non-secret account and host references / verification date: <verified configuration>
- Model/task qualification evidence and runtime/gate capability: <source; stop if unmet>
- Formal document auditor / mechanical placer where applicable: <distinct eligible parties; never self-audit or self-placement>
- Code reviewer: <eligible Role 17 lane; transition follows AGENTS.md §16>
- Subscription allowance and any paid-execution authority: <no authority means no paid execution>
- Issue / work reference where §10 requires it: <actual supplied identifiers; never invent>
- PR and review record: <lane/model/effort; WUD or applicable source provenance; full reviewed head SHA>

Stop on exhausted allowance, stale evidence, unsupported selection or ineligible separation. Work waits without an eligible route. No automatic substitution or paid fallback is permitted.

## Task

<Specific, numbered list of what must be done.>

## Deliverable

- File path: <exact path>
- Format: <file format>
- Content requirements: <what the file must contain>

## Scope

- Create exactly these files: <list>
- Modify exactly these files: <list>
- Do not modify any other file
- Do not fix adjacent issues — note them and move on

## Rules

### Reserved Actions (Prohibited)

<Copy the current Tier 1 list from rules-digest.md>

### P-A-E Actions

<Copy the current Tier 2 list from rules-digest.md>

### Evidence Discipline

- Every claim must be tied to a command, output, or observation
- Unexecuted gates must be reported as "not run," never as passed
- Do not fabricate output
- Do not claim success without evidence

### Scope Discipline

- Work only within the declared scope
- Adjacent issues are noted in the final report, not fixed
- Expanding scope silently is a failure

### Data Handling

<Copy the classification rules from rules-digest.md>

### Two-Failure Rule

Two failures on the same defect is a handoff. Report both attempts and stop.

## Acceptance Criteria

1. <criterion>
2. <criterion>
3. <criterion>

## Answer Format

- Answer each part in order.
- Include for each: (a) your answer, (b) basis (verified, inferred, sourced, unknown), (c) confidence (high, medium, low).
- Do not produce an introduction or conclusion.

## Final Report Format

<Copy the standard report format from rules-digest.md>

## End of Prompt
```

## 4. Researcher Prompt Template

```markdown
# <Research Task Title>

## Context

You are producing a research brief for MGPL.

[One paragraph describing the research question and why it matters.]

## Environment

- You have web search: yes/no
- You have local filesystem access: yes/no
- You have terminal access: yes/no

## Research assignment and provenance

- Research question / supplied source revisions and dates: <bounded scope and freshness>
- Prompt Author / Researcher: <different parties; eligible Role 11 level>
- Content Writer / formal document auditor / placer if required: <eligible distinct parties>
- Surface / actual model / upstream vendor / effort: <explicit selection; no automatic switching>
- Tier / tools / non-secret account and host references / verification date: <verified configuration>
- Subscription allowance / any paid-execution authority: <no paid usage without authority>
- Applicable AGENTS.md revision / adopted 04 §3 correlations: <verified record or unavailable>
- Issue or research-record reference if §10 requires one: <actual reference or none with reason>
- Evidence gaps and source-access limits: <what is supplied, observable or unknown>

Use research provenance and source-fidelity checks for this brief. Do not assume an implementation assignment. Stop on missing authority, exhausted allowance or stale required evidence, and report the gap.

## Research Question

<Specific, bounded question.>

## Required Output

1. **Summary** — one paragraph
2. **Findings** — each with source, basis, and confidence
3. **Conflicts** — any conflicting sources, with both named
4. **Gaps** — what could not be verified
5. **Recommendations** — if the brief is intended to support a decision

## Source Discipline

- Every claim must name its source
- Verified / Sourced / Inferred / Unknown labels required
- If a source cannot be found, say so — do not fill the gap
- Do not fabricate citations

## Rules

<Copy the Reserved Actions and Evidence Discipline rules from rules-digest.md>

## Acceptance Criteria

1. Every claim has a source or is labeled Unknown
2. Conflicts are named
3. Gaps are named
4. No fabrication

## Answer Format

- Answer each section in order.
- Include for each: (a) your answer, (b) basis, (c) source, (d) confidence.

## End of Prompt
```

## 5. Troubleshooting Protocol

1. Read the failure report. Do not skim.
2. Identify the failure class: Environment / Task ambiguity / Capability gap / Defect / Reserved Action block.
3. Diagnose the cause.
4. Produce a revised prompt.
5. Return the revised prompt to the operator.

If the second prompt also fails, the operator swaps the Worker to the Alternate.

**End of Prompt Author Template v1.0.**
