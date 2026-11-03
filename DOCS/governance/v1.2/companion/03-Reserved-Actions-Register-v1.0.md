# MGPL Reserved Actions Register v1.0

**Version:** 1.0 (extracted from Manual v1.2)
**Effective date:** Upon operator approval
**Supersedes:** The single-tier Reserved Actions list currently in AGENTS.md
**Owner:** MGPL Governance Office (operator)

## 1. The Three Tiers

| Tier           | Definition                                                                                                | Operator involvement                               |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Prohibited** | Never, regardless of who asks, regardless of approval                                                     | None — the action cannot be performed              |
| **P-A-E**      | Propose, Approve, Execute — draft the action, report it, await per-action operator approval, then execute | Required per action                                |
| **Permitted**  | Within scope of an assigned task, no per-action approval required                                         | None — but the action is still logged and reported |

**Precedence rule:** The tier lists are the authority. The tier tests are guidance, not criteria that generate the lists. The most restrictive applicable rule wins.

**Foundational rule:** A Reserved Action does not become permitted because the operator forgot to say no. Silence is not approval.

**Specific-over-general rule:** Specific prohibitions override general permissions. Read-only activity can still disclose restricted information.

## 2. Prohibited Actions (Tier 1)

### Version control and repository

1. Commit, push, or merge to main
2. Merge to develop (was suspended; now Prohibited)
3. Force push
4. Delete any long-lived branch
5. Create, modify, or delete a branch rule
6. Create, modify, or delete a required status check
7. Create, modify, or delete a merge control

### Credentials and secrets

8. Read, print, set, rotate, delete, or enumerate a secret value
9. Create, rotate, or widen any credential or token — except operator-provisioned, scoped credentials, which are permitted for read-only repo access when explicitly authorized by the operator in the session prompt
10. Hold or use a secret-store browsing tool
11. Print any infrastructure identifier in cleartext

### Data and production

12. Operate against the production database
13. Export production data
14. Access production logs without operator-supplied sanitized excerpts — restated as Prohibited, not approval-gated

### Controls and evidence

15. Weaken, disable, skip, bypass, or reconfigure any control that blocked work
16. Record or report gate evidence for a run that did not execute the recorded gates
17. Push a branch carrying an unreverted change to a security control
18. Modify the gate chain itself without an approved work unit naming that change — restated as Prohibited. The exception for authorized control-maintenance is now defined by work unit approval, not by the P-A-E process

### Memory and persistence

19. Hold a persistent memory store containing architecture facts, approvals, or acceptance evidence — clarified: versioned, reviewed repository files (AGENTS.md, CLAUDE.md, .clinerules/*) are excluded. The rule governs vendor-held memory and unversioned stores

### Infrastructure

20. Provision any infrastructure resource
21. Add a domain to an allowlist
22. Modify a firewall rule
23. Modify a DNS record

### Tooling

24. Install any MCP server, plugin, hook, or extension
25. Enable or activate an MCP server that is present but disabled — exception: enabling a pre-installed, inert, operator-authorized extension is now P-A-E (moved from Prohibited per Finding 3.5)

### Staging and issues

26. Write any file under _staging\issues\
27. Edit the body of an existing GitHub issue — moved to P-A-E
28. Delete a branch, worktree, or stash

## 3. P-A-E Actions (Tier 2)

### GitHub project board

1. Set priority on a project board item
2. Set work type on a project board item
3. Set backlog state on a project board item
4. Archive or unarchive a project board item

### GitHub issues

5. Edit the body of an existing GitHub issue
6. Close an existing GitHub issue
7. Reopen an existing GitHub issue
8. Add or remove labels on an existing GitHub issue
9. Add or remove assignees on an existing GitHub issue

### GitHub pull requests

10. Close a pull request without merging
11. Delete a remote feature branch (only the Agent's own feature branches)

### Repository state

12. Modify a file outside the assigned task's declared scope, if the modification is required to complete the assigned task

### Tooling

13. Enable a pre-installed, inert MCP server, plugin, or extension

## 4. Permitted Actions (Tier 3)

Within the scope of an assigned task:

- Read any file in the workspace — except secret values and production material, which are Prohibited
- Run any read-only command — except commands that would read secrets
- Create new files in a scratch or assigned directory
- Modify files that are within the declared scope of the current task
- Run tests, gates, linters, and type checks
- Push a feature branch (never to main or develop)
- Open a pull request
- Comment on pull requests and issues
- Run gh read operations
- Run git read operations
- Create branches locally
- Delete the Agent's own local scratch branches

## 5. The P-A-E Workflow

When an Agent wants to take a Tier 2 action, it must produce a proposal in this exact format:

```
PROPOSED ACTION
---------------
Action: <verb + object>
Scope: <single item, or explicit batch>
Rationale: <why this action>
Reversibility: <how to undo this action>
Dependencies: <what else is affected>
Evidence: <what the operator should inspect before approving>
AWAITING: operator approval
```

**Rules:**

1. One proposal per action. Batching only when explicitly requested.
2. No execution before approval. If approval does not come, the proposal sits.
3. Execute exactly what was approved. If the approved action differs from what was proposed, re-propose before executing.
4. Report completion. Replace AWAITING with EXECUTED and add evidence.
5. **Stale-approval rule (Finding 3.5):** Approval binds to the exact proposed change and the version of the artifact reviewed. If the target changes after approval, re-approval is required.

## 6. What This Revision Does Not Change

- Two-failure handoff rule
- Requirement to stop on any control block
- Prohibition on scope creep
- Prohibition on fabricated evidence
- Requirement to disclose every side effect
- The _staging JSON end-of-turn format
- Filing authority rules for new issues

## 7. Fabrication Rule

The Manual distinguishes two classes of fabrication:

| Class                      | Definition                                     | Treatment                                                                       |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Undisclosed fabrication    | Fabrication caught by the assessor or operator | Treated as a Reserved Action breach. Disqualifying for evidence-sensitive roles |
| Self-disclosed fabrication | Fabrication disclosed by the Agent itself      | Serious finding, correctable through a bounded retest on citation discipline    |

An Agent that self-discloses must be re-tested on a bounded citation-discipline task before the finding is cleared.

**End of Reserved Actions Register v1.0.**
