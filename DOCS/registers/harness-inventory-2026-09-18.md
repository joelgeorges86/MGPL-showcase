# Harness Inventory — 2026-09-18

**Type:** Environment register. Expires.
**Method:** Seven agent routes were asked an identical read-only question in the same repository on the same machine within one working session. Each was told to name tools rather than describe capabilities, and that an inability reported accurately is a useful result.
**Scope:** What each route exposes. Not what any product is documented to do.

---

## How to read this

Every row is a **route**, not a vendor. The same product name appears with wildly different tool surfaces depending on the surface it runs on — Codex ranges from roughly 12 tools to 585, GitHub Copilot from 3 to 60+, depending only on where the session runs and what folder it was given.

A capability claim is valid for the recorded combination of product, surface, mode, and access. Change any of those and it is re-established, not assumed.

**This register goes stale.** Routes gain and lose tools, connectors authenticate and lapse, settings reset. Re-verify anything here before relying on it. A figure more than thirty days old should be treated as unverified.

---

## Summary

| Route                                   | Tools                   | Native worktree | Operator-absent execution           | Shell approval    | Can write | Can verify |
| --------------------------------------- | ----------------------- | --------------- | ----------------------------------- | ----------------- | --------- | ---------- |
| Cline — ChatGPT provider                | 9                       | no              | no                                  | gated             | yes       | yes        |
| Cline — Claude Code provider            | 14 direct + 15 deferred | `EnterWorktree` | **`RemoteTrigger` — authenticated** | gated             | yes       | yes        |
| Codex — VS Code                         | ~585                    | no              | no                                  | gated             | yes       | yes        |
| Codex — Desktop                         | ~12                     | via shell only  | no                                  | **none observed** | yes       | yes        |
| GitHub Copilot — VS Code                | 60+                     | GitKraken CLI   | no                                  | gated             | yes       | yes        |
| GitHub Copilot — Desktop, chat only     | 3                       | no              | no                                  | n/a               | no        | no         |
| GitHub Copilot — Desktop, folder access | 10                      | no              | no                                  | n/a               | **yes**   | **no**     |

---

## The four questions, answered by all seven

### Native Git worktree management

Three distinct mechanisms exist, on three different routes.

- **`EnterWorktree` / `ExitWorktree`** — Cline on the Claude Code provider. Creates or reuses a worktree and switches the working directory. Documented as "only use when explicitly instructed."
- **`mcp_gitkraken_cli_git_worktree`** — GitHub Copilot in VS Code, via GitKraken CLI.
- **Shell `git worktree`** — Codex Desktop, ungated.

**None of the three addresses the five known worktree defects.** A fresh worktree still lacks a secrets binding, lacks installed dependencies, has an empty database, and may carry a branch name the environment doctor rejects. A native tool replaces one shell command; it does not produce a working copy.

**One trap found by inspection rather than execution:** `EnterWorktree` defaults `worktree.baseRef` to `fresh`, which branches from `origin/<default-branch>` — main. Repository policy requires branching from develop. That setting is not present in `.claude/settings.json`, so a bare invocation would have silently violated the branching rule.

### Operator-absent execution

**One route only.**

`RemoteTrigger` — Cline on the Claude Code provider. Cloud-hosted routines that run independent of the session, including webhook triggers on repository events. **Verified authenticated:** a read-only `list` returned HTTP 200 with an empty result set. Zero routines currently exist.

Everything else is session-scoped or not scheduling at all:

- `CronCreate` — same route. Session-only, in-memory, fires only while the session is idle, expires after 7 days. Its `durable` parameter is documented as a no-op. The name is misleading.
- `create_goal` — Codex VS Code. Records a goal. Does not execute work.
- No other route has any scheduling mechanism.

### Parallel subagents, and whether they are read-only

**Available on three routes. Not read-only on any of them.**

Cline on Claude Code exposes `Agent` with named types. `Explore` and `Plan` exclude `Edit`, `Write`, and `NotebookEdit` — but retain `Bash` and `PowerShell`. A subagent can therefore write via `sed -i`, a heredoc, or `git`. The exclusion is not a write barrier.

`general-purpose` and `claude` types have unrestricted tool access. Only `claude-code-guide` is genuinely read-only, and it is scoped to documentation questions.

Codex VS Code exposes parallel agents with a four-agent limit, also not read-only.

**This closes open item H-12, and the answer contradicts the operating plan.** Section 13 permits parallel subagents as read-only investigation aids. They are not read-only.

### Inter-agent messaging

**All seven routes agree: no mechanism reaches Codex from any other agent.**

What does exist:

- `SendMessage` / `ListAgents` — Cline on Claude Code. Claude-to-Claude only. `ListAgents` confirmed this session as `mgpl-4c [2128f3]` with no peers currently reachable. Cannot reach Codex, a different product that would not appear in the listing.
- `codex-reply`, `create_conversation` — Codex routes. Continues or creates a Codex thread. Intra-Codex only.

**Consequence.** The independent-diagnosis handoff rule added to `AGENTS.md` §8 assumes the Principal Operator routes the package to Codex by hand. That assumption is correct and is now verified across seven routes.

The rule's general statement that "no mechanism exists" is too strong — Claude-to-Claude coordination has one. The rule should be narrowed to say the Codex handoff specifically requires operator routing.

---

## GitHub access — six or more independent routes

| Route                        | Surface              | Tools   | Status                                                      |
| ---------------------------- | -------------------- | ------- | ----------------------------------------------------------- |
| MCP_DOCKER                   | Cline on Claude Code | 44      | **Authenticated as `joelgeorges86`.** Verified by `get_me`. |
| `mcp__codex_apps__github_*`  | Codex VS Code        | ~90     | Unverified                                                  |
| `github-pull-request_*`      | Copilot VS Code      | several | Unverified                                                  |
| `mcp_github_mcp_se_*`        | Copilot VS Code      | several | Unverified                                                  |
| `mcp_docker_ai_mcp_*`        | Copilot VS Code      | several | Unverified                                                  |
| GitKraken issue and PR tools | Copilot VS Code      | several | Unverified                                                  |

**This violates the operating plan's one-capability-one-primary-implementation rule six times over on a single capability.**

### Two consequences

**MCP_DOCKER must not be removed.** It is queued for removal as unreachable and unused. It holds 44 authenticated GitHub tools including `create_pull_request`, `pull_request_read`, `list_issues`, `search_code`, and `get_commit`. That work unit is withdrawn, with the reason recorded here.

Note that `merge_pull_request` is among them. Repository policy forbids agent merges regardless of tool availability; that prohibition is now a live distinction rather than a hypothetical one.

**The fallback ladder has an unreachable rung.** Repository rules define a four-route ladder for GitHub operations. Route 3 is `gh api`. `.claude/settings.json` denies `Bash(gh api *)` and `PowerShell(gh api *)`. If Routes 1 and 2 fail together, the documented next step is blocked by the repository's own policy.

---

## Route-specific findings

### Cline — ChatGPT provider

Nine tools. No `Agent`, no `Workflow`, no cron, no messaging, no worktree.

**Could not identify its own provider or model.** The same extension on the Claude Code provider named its model accurately and flagged that the session framing said otherwise. Self-knowledge differs by route.

Plan and Act modes expose the **same** tool set. The difference is permission, not capability — which the operating plan asserts and had never been verified.

### Cline — Claude Code provider

The largest set of operationally relevant capabilities. `EnterWorktree`, `RemoteTrigger`, `SendMessage`, `Agent`, `Workflow`, `Skill`, `CronCreate`, `Monitor`.

Correctly identified an `Artifact` publishing path as an egress route: publishing sends content to claude.ai. A gate report or register published that way leaves the repository. This is a context-exposure question and appears in no register.

Could not install harness hooks — the safety classifier treats harness configuration as self-modification regardless of which file is targeted. It reported this rather than routing around it with a heredoc.

**This settles AI-026's design.** A hook-based worktree contract always terminates in "operator pastes this in." A script does not. AI-026 is a script.

### Codex — VS Code

Roughly 585 tools. Most are unrelated to MGPL: Zillow, Figma, the Adobe creative suite, parental controls, restaurant booking.

Relevant: a second GitHub route (~90 tools, including `fetch_workflow_job_logs` and `get_commit_combined_status`), `mcp__cloudflare_api__execute`, `mcp__codex_security__*` (20 tools), Gmail with send, Google Drive with write, and `sites_create_source_repository_write_credential`.

**The reviewer lane holds the largest attack surface of any agent in the roster, against a charter of independent diff review.** That gap between charter and reach is the finding. Most of those connectors are account-level and shared beyond MGPL, so removal is not a simple decision — but the gap should be recorded.

### Codex — Desktop

Roughly 12 tools. No third-party connectors at all.

**`shell` has no approval gate in this configuration.** It reported executing `git worktree list` and `gcloud auth list` without prompting, and drew the conclusion itself: worktree creation here would be a shell side effect rather than a governed tool call. The same applies to `gh`, `gcloud`, and anything else a shell reaches.

It named a tool present in its own listing that it could not describe, and declined to characterise it rather than guessing.

**Same product as the VS Code route. 12 tools against 585.**

### GitHub Copilot — VS Code

60+ tools. Found three things no other route did:

- **GitKraken CLI** — native worktree, full Git operations, GitLens launchpad, start-review
- **Sentry MCP, 19 tools** — `whoami`, `get_issue_details`, `search_events`, `analyze_issue_with_seer`. These would settle whether anything actually reaches Sentry, which open item H-2 left partly unresolved.
- **`session_store_sql`** — searches prior Copilot sessions. Persistent memory across sessions, which repository policy prohibits for architecture facts.

**Unaccounted for: `mcp_faf-mcp_*`, fifteen tools** including `faf_agents`, `faf_gemini`, `faf_git`, `faf_sync`, `faf_trust`. The route reported no established MGPL behaviour for it. Its origin and purpose are unknown. **It should be identified before anything else in this register is acted on** — an unidentified MCP server with agent, Git, and trust operations is connected to a session holding workspace write.

### GitHub Copilot — Desktop

Two distinct configurations, and the difference matters.

**Chat only: 3 tools.** No filesystem, no repository, no shell. It reported a specific git state — branch, commit, clean worktree — that was harness-injected context rather than something it read. That context is a snapshot and presented as fact.

**With folder access: 10 tools**, including `create_file`, `insert_edit_into_file`, and `replace_string_in_file`.

**This is the only route that can write and cannot verify.** No terminal, no git, no test execution, no gate chain, no evidence recording, no push. It can modify MGPL source and leave uncommitted changes that nothing downstream can attribute.

That is the same shape as a conflicted worktree sitting undetected: a state nothing checks for. The evidence chain assumes whoever edits can also produce gate evidence; this route breaks that assumption silently.

**Recommended constraint: this route does not edit MGPL files.**

Notably, with folder access it reported git state as UNVERIFIED because it has no terminal — more access produced a more accurate account of its own limits than the chat-only configuration did.

---

## What this changes in the operating plan

| Finding                                          | Effect                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Parallel subagents are not read-only             | **H-12 closes.** Section 13's permission for read-only subagent investigation is wrong as written.                      |
| Six or more GitHub routes                        | Section 14.1's one-capability-one-primary-implementation is violated. A primary and a single fallback should be named.  |
| `gh api` denied by local settings                | Section 5's fallback ladder has an unreachable third rung. Either the deny rule or the ladder is wrong.                 |
| MCP_DOCKER is authenticated                      | AI-028 withdrawn.                                                                                                       |
| No messaging reaches Codex                       | The §8 handoff rule's operator-routing assumption is correct; its general claim that no mechanism exists is too strong. |
| Worktree tools do not solve the worktree problem | AI-026 remains a script. Confirmed by a route that could not install hooks and said so.                                 |
| Plan and Act expose the same tools               | Mode is a permission control, not a capability control. Previously asserted, now verified.                              |

---

## Open

- **`mcp_faf-mcp_*` is unidentified.** Fifteen tools, agent and Git and trust operations, connected to a write-capable session. Identify before acting on anything else here.
- `RemoteTrigger` is authenticated and unused. Creating a routine is an approval decision, not an experiment — it would be a standing unattended writer against the repository.
- Sentry MCP tools are present and unexercised. One `whoami` would advance H-2.
- Five of six GitHub routes are unverified. Only MCP_DOCKER has been authenticated.
- Codex VS Code's connector set reaches Cloudflare, Gmail, Drive, and site credential creation. Account-level, shared beyond MGPL, not simply removable. Recorded rather than resolved.
