# Claude Handoff — MGPL Governance Integration

**To:** Claude Desktop (Opus 5.5)
**From:** Operator
**Date:** October 1, 2026
**Purpose:** Integrate the MGPL v1.2 governance release package into the MGPL repository.

## What You Are Doing

You are placing a set of governance files into the MGPL repository. This is a bounded placement task. You are not authoring new content. You are not reformatting. You are placing files at the correct paths and reporting completion.

## The Package

The release package is at `/mgpl-governance-v1.2/`. It contains 15 files organized in a directory structure:

```
/mgpl-governance-v1.2/
├── /core/
│   ├── 01-Justification-Document-v1.2.md
│   └── 02-Operations-Governance-Manual-v1.2.md
├── /companion/
│   ├── 03-Reserved-Actions-Register-v1.0.md
│   ├── 04-PACE-Role-Matrix-v1.0.md
│   ├── 05-Prompt-Author-Template-v1.0.md
│   └── 06-Auditor-Verdict-Format-v1.0.md
├── /assessment/
│   ├── 07-Agent-Assessment-Final-Report-v1.1.md
│   ├── 08-Formal-Response-to-Agent-Feedback-v1.1.md
│   └── 09-Reformat-Test-Results.md
├── /data/
│   ├── 10-pace-roster.json
│   ├── 11-agent-capability-matrix.json
│   ├── 12-reserved-actions.json
│   └── 13-change-log.json
├── /integration/
│   ├── 14-AGENTS.md
│   └── 15-CLAUDE-HANDOFF.md
└── /agents/
    ├── 16-M365-profile-update.md
    ├── 17-Gemini-profile-update.md
    ├── 18-ChatGPT-profile-update.md
    └── 19-Claude-profile-update.md
```

## Your Task

1. Create the directory structure in the MGPL repository at `docs/governance/v1.2/`.
2. Place each file at its correct path.
3. Update the repository's `AGENTS.md` to the content of file 14.
4. Report the commit SHA of the placement commit.
5. Do not modify any other file.
6. Do not push to main. Push to a feature branch and open a PR.

## Files You Are Placing

**Core documents:**

- `docs/governance/v1.2/core/01-Justification-Document-v1.2.md`
- `docs/governance/v1.2/core/02-Operations-Governance-Manual-v1.2.md`

**Companion documents:**

- `docs/governance/v1.2/companion/03-Reserved-Actions-Register-v1.0.md`
- `docs/governance/v1.2/companion/04-PACE-Role-Matrix-v1.0.md`
- `docs/governance/v1.2/companion/05-Prompt-Author-Template-v1.0.md`
- `docs/governance/v1.2/companion/06-Auditor-Verdict-Format-v1.0.md`

**Assessment documents:**

- `docs/governance/v1.2/assessment/07-Agent-Assessment-Final-Report-v1.1.md`
- `docs/governance/v1.2/assessment/08-Formal-Response-to-Agent-Feedback-v1.1.md`
- `docs/governance/v1.2/assessment/09-Reformat-Test-Results.md`

**Data files:**

- `docs/governance/v1.2/data/10-pace-roster.json`
- `docs/governance/v1.2/data/11-agent-capability-matrix.json`
- `docs/governance/v1.2/data/12-reserved-actions.json`
- `docs/governance/v1.2/data/13-change-log.json`

**Integration:**

- `AGENTS.md` (replace existing)

**Agent profiles:**

- `docs/governance/v1.2/agents/16-M365-profile-update.md`
- `docs/governance/v1.2/agents/17-Gemini-profile-update.md`
- `docs/governance/v1.2/agents/18-ChatGPT-profile-update.md`
- `docs/governance/v1.2/agents/19-Claude-profile-update.md`

## What You Must Not Do

- Do not rename any file.
- Do not modify content.
- Do not reformat content.
- Do not add commentary or editorial notes.
- Do not push to main or develop.
- Do not run any gate that modifies repository state.
- Do not touch any file outside the paths listed.

## Reserved Actions That Apply

You are permitted to:

- Create new files in `docs/governance/v1.2/`
- Modify `AGENTS.md` (this is within scope)
- Push a feature branch
- Open a pull request

You are prohibited from:

- Committing to main or develop
- Reading or modifying secrets
- Modifying any file outside the listed paths
- Force pushing
- Deleting any branch

## Evidence to Report

After completion, report:

- The commit SHA of the placement commit
- The list of files created (with paths)
- The diff summary for `AGENTS.md`
- Any pre-existing working tree changes that you did not make
- Any file you could not place and why

## Acceptance Criteria

1. All files placed at correct paths.
2. `AGENTS.md` replaced with file 14 content.
3. Feature branch pushed.
4. Pull request opened targeting develop.
5. Completion report includes the four evidence items above.
6. No file outside the listed paths was modified.

## End of Handoff
