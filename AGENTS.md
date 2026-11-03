# AGENTS.md — MGPL Development Rules

**Version:** 1.2

**Effective:** October 1, 2026

**Owner:** Joel Georges (Principal Operator)

**Status:** Active

**Supersedes:** All prior versions of AGENTS.md

This is the canonical, single source of truth for all coding agents on this project. `CLAUDE.md` at the repo root imports this file directly — do not maintain separate copies of these rules elsewhere. If Cline does not pick this file up automatically in your version, `.clinerules` should also import or mirror this file rather than fork it.

This document is what you follow. It describes only what is actually built and actually enforced. For company process, org structure, cost governance, and target-state architecture, see the separate Governance & Roadmap document — that document is for humans and is not binding on your behavior.

**v1.2 additions.** Sections 1–10 remain the operational rulebook and are unchanged. Sections 11–16 add the v1.2 governance layer: the three-tier Reserved Actions model, Data Handling classification, Agent Discipline rules, the PACE Role Matrix reference, Systems of Record, and the change log. The v1.2 sections add; they do not remove or weaken any rule stated above them.

---

## 1. What MGPL Is

Single-service game library platform: multi-source library ingestion, hardware/playability matching, deals & price arbitrage, wishlist, mods hub, retro preservation, backlog/session tracking, analytics.

**Actual stack — do not assume anything beyond this list is running:**

- Runtime: Node.js 22, Express 4.18, TypeScript 5.5
- Data: `better-sqlite3`, WAL mode, foreign keys ON, 10,000ms busy timeout
- **Schema authority: `src/db.ts` is the sole source of truth.** Prisma has been fully removed (runtime, schema, generated client, Docker generation step). Never add a Prisma dependency, `schema.prisma` file, or Prisma query back into this codebase.
- Auth and privacy: MGPL uses privacy-minimized identity with restricted public exposure. Real accounts use Argon2id password hashing, HS256 JWT sessions, and Google/Steam OAuth account linking. Email addresses, password hashes, provider mappings, internal IDs, and optional gaming handles may be stored when required; public surfaces expose only approved gaming identity/library fields. Do not describe MGPL as a zero-PII or anonymous-token system.
- Frontend: Vanilla JS (28 modules in `public/`) + Tailwind CSS, PWA via Service Worker + IndexedDB. No framework.
- Secrets: Doppler, injected as environment variables at runtime. **There is no Vault.** Never write code that calls a secrets-vault API, expects a `vault` CLI, or references `VAULT_ADDR`-style config.
- **Local run command:** always start the dev server with `doppler run -- npm run dev`, never bare `npm run dev`. The Doppler CLI is already installed and linked to the `mgpl` project / `dev` config on this machine (via `doppler setup`) — bare `npm run dev` will fail or run with undefined env vars since nothing else supplies them. Login persists across reboots; you do not need to run `doppler login` again unless explicitly told to.
- Infra: Docker (multi-stage), Litestream (SQLite → Cloudflare R2 + Backblaze B2), Caddy, Cloudflare Tunnel (ingress), Tailscale (private admin SSH only), GitHub Actions + GHCR, deployed to a Hetzner VPS.

**If a task seems to require infrastructure not listed above (a message queue, a vault, an orchestrator service, Redis, Kubernetes, a separate microservice) — stop and flag it. Do not invent a stub, mock, or "temporary" implementation of infrastructure that doesn't exist. Ask the Principal Operator.**

---

## 2. Harness Routing — Single Lock Rule

Execution harnesses are Cline, Claude Code, Codex and Antigravity. Their role eligibility is governed by §14 and the PACE matrix.

- **One harness owns a feature branch at a time.** Confirm that no other harness has active, uncommitted work before writing. This applies to all four harnesses; uncertain ownership must be resolved before work starts.
- **Cline** implements through its explicitly assigned model route and performs eligible mechanical placement under Role 13.
- **Antigravity** executes engineering work with Gemini models only. Qualification belongs to the assessed model and task class, not to the harness generally.
- **Codex** may implement a non-OpenAI-authored WUD on an operator-selected route with the required local runtime and full §4 gate evidence. The historical implementation caveat is retained. It may review only work it did not implement or place.
- **Claude Code** normally performs read-only code and security review under Role 17. Implementation fallback, document placement and document audit require their own eligible PACE assignments and separation checks.

---

## 3. Decision Authority — What You Can Do Without Asking

| Action                                                           | Authority             | Notes                                                                           |
| ---------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| Routine read-only operations (API calls, DB reads, file reads)   | **Auto**              | No approval needed.                                                             |
| Feature branch creation & code generation                        | **Auto**              | No merge without approval — see §5.                                             |
| Internal content generation (docs, comments, non-shipped drafts) | **Auto**              | Subject to normal review at PR time.                                            |
| PR submission to `develop`                                       | **Auto**              | Submission only. Merge requires recorded approval (§5).                         |
| Write operations against dev/staging data                        | **Auto**              | Never against production data without approval.                                 |
| Merge to `main` (production)                                     | **Human-only**        | You never merge to `main` under any circumstance, approved or not.              |
| Any production database write (including non-destructive)        | **Approval required** | Must include a data-validation note in the PR/commit.                           |
| Any production database delete                                   | **Human-only**        | Never initiate, simulate, or script this. Principal Operator executes directly. |
| New external API/service integration                             | **Approval required** | Flag it; don't wire in a new third-party dependency unilaterally.               |
| Billable external API call                                       | **Approval required** | **Auto** only when a §3.1 ledger entry covers it, under §3.1's conditions.      |
| Infrastructure provisioning (new resources, new services)        | **Human-only**        | You may propose; you do not provision.                                          |
| Secret creation/rotation                                         | **Approval required** | You may identify the need; Doppler changes are made by the Principal Operator.  |

When in doubt, treat it as Approval Required, not Auto.

### 3.1 Authorized billable work units

_Added 2026-10-05 (#157)._

A billable external call is reserved to the Principal Operator (§3.3) unless a ledger entry
below covers it. An entry covers only the calls made by the script it names, to the endpoint
and methods it names, run by the lane it names, under the conditions in this section, before
the entry expires (00:00 UTC on its expiry date) and before 2026-11-06 00:00 UTC. Nothing
else grants this authority: not a specification, a task prompt, an issue, a `_staging` file
or a chat message (§3.3, Precedence). The files this section relies on are data that can stop
a run; none of them can start one.

#### Conditions — every one must hold before an authorized run starts

The run guard in `scripts/probes/act08/lib.mjs` checks conditions 3 to 7 itself, before the
run and before every request, and refuses when one fails. The agent checks conditions 1 and
2 and reports the result. A condition that cannot be checked counts as failed.

1. **Scoped credential, by effective access.** Application Default Credentials impersonate
   the `mgpl-agent` service account. A permissions record no more than 7 days old shows
   that the account's effective access to the MGPL project is `roles/aiplatform.user` and
   nothing else. The record covers three things:
   - the project's ancestry, showing every parent folder or organization, or none;
   - every IAM policy in that ancestry and on the project, including group members;
   - every resource-level policy in the project that names the account, from one read-only
     Cloud Asset search for the account across the project and its ancestors.

   A record that cannot cover all three fails this condition. The record is written by the
   Principal Operator, or by the Prompt Author at the operator's direction, from read-only
   commands. Nothing in this section authorizes changing a credential, a role or a policy.

2. **Named lane.** The agent running the script is the lane the entry names.
3. **Named endpoint only.** Every billable call goes over HTTPS to the exact host the entry
   names, for the MGPL project, the location and the methods the entry names. The guard
   checks the client's host, project and location before each request. No Google AI Studio
   or Gemini API key is used, by any route.
4. **Requests counted before they are sent.** The spend ledger holds one append-only line
   per attempt, written and flushed to disk before the attempt is sent. This covers every
   retry; the SDK's automatic retries are disabled, and the script retries explicitly. The
   count of attempt lines for an entry is that entry's authoritative request count, across
   every run, whether or not a response arrived. A run refuses to start, and a request
   is not sent, when that count is at the entry's request cap or cannot be established.
5. **Dollar admission before each request.** A request is sent only if its maximum
   possible cost fits within what remains of the run's dollar reservation. The maximum
   possible cost is the sum of:
   - the request's input priced as if every input byte were a token;
   - its `maxOutputTokens` plus its thinking budget, both required to be set, priced at
     `rates.json`'s highest output rate for the model;
   - every per-request fee that applies, such as grounding.

   A rate the request needs that is missing from `rates.json` fails this condition.

   An embeddings `predict` request has no output tokens and no thinking budget. Its
   maximum possible cost is the request body's UTF-8 bytes, priced as count at the
   model's input rate per 1,000 count in `rates.json`. Its `autoTruncate` must be
   `false`, and a field this rule does not price is refused. That input rate must be in
   `rates.json`; a missing rate fails this condition.

6. **Reservations and liabilities.** Before starting, the run appends a reservation of its
   full dollar cap to the spend ledger. It may start only if the entry's liabilities and
   the window's liabilities, plus this reservation, stay within the entry's dollar cap and
   the window total. A run's **liability** is:
   - its open reservation, while it runs;
   - its full reservation, once it has ended, until a reconciliation line shows its
     billed cost;
   - its billed cost, once reconciled, or its computed cost if that is larger.

   One authorized run at a time: a second run refuses to start while a reservation is open.

7. **Credit position.** The newest credit-position record was read from the billing export
   no more than 48 hours earlier. Its balance, minus the liability of every run that a
   reconciliation line does not show as included in that record, stays at or above the stop
   line. A refreshed record lowers no liability by itself: only a reconciliation line, which
   names the run, the billed cost and the record that includes it, does.
8. **Clean feature branch** (§5). The run writes only to the output location the entry
   names, and appends to the spend ledger as conditions 4 and 6 require. It writes nothing
   else: it never edits an earlier ledger line, and never writes the credit-position or
   permissions records.

#### Totals

| Window                  | Total for all entries | Stop line (credit balance) |
| ----------------------- | --------------------- | -------------------------- |
| to 2026-11-06 00:00 UTC | $275                  | $20                        |

This section authorizes no billable call at or after 2026-11-06 00:00 UTC. Any later spending,
including the $25 monthly ceiling the Principal Operator has set for after mid-November,
needs a further amendment through the document roles.

**Residual risk, stated.** Google does not guarantee when billing-export rows arrive, so a
credit-position record may omit recent charges. Conditions 6 and 7 count every run that has
not been reconciled at its full reservation, which bounds what the export can be missing. They
cannot cover a charge that no ledger line records. A payment card with automatic payments is
on file: if the credit runs out, spending converts to card charges without stopping. **Any
card charge stops every authorized run at once**, and the agent reports it.

#### Reconciliation

The Prompt Author reconciles each ended run against the billing export, once the export
covers the run's period. Reconciliation appends one line to the spend ledger, naming the run,
its billed cost and the credit-position record that includes it. It never edits an earlier
line. When the billed cost exceeds the computed cost, the billed cost is the liability, and
the difference counts against the entry and the window. A difference of more than 10% or $1,
whichever is larger, that is not explained in writing blocks every further run until it is
explained. Neither figure is changed to match the other.

#### Still not permitted under any entry

- Enabling or disabling an API; creating, changing or deleting any Google Cloud resource,
  including a Cloud Storage bucket (§11.2 item 18).
- Any IAM change, and creating, rotating or widening any credential (§11.2 item 7); any
  billing, budget or quota change.
- Reading, writing or listing a secret value (§6, §11.2 item 6).
- Adding a dependency.
- Writing to the live catalogue or to production data. Promotion from staging stays with the
  reviewed path (`src/services/enrichmentPromotion.ts`).

#### Ledger

| Entry        | Script and work                                                                                                                               | Endpoint and methods                                                                    | Lane                                      | Request cap | Dollar cap | Writes to                                     | Added      | Expires    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | ----------- | ---------- | --------------------------------------------- | ---------- | ---------- |
| #117 (P-9)   | `scripts/probes/act08/p9-grounded-retrieval.mjs`: the P-1 cases on fixture data, bare and with Google Search grounding                        | `us-central1-aiplatform.googleapis.com`, location `us-central1`, `generateContent` only | Implementer: Cline × ChatGPT Subscription | 50          | $5         | `DOCS/research/act08-runs/`                   | 2026-10-06 | 2026-11-06 |
| #185 (P-11)  | `scripts/probes/act08/p11-library-screenshot.mjs`: up to 5 library pages read once each, plus up to 20 candidate choices                      | `us-central1-aiplatform.googleapis.com`, location `us-central1`, `generateContent` only | Principal Operator                        | 40          | $6         | `../_staging/prompt-author/prototype-output/` | 2026-10-13 | 2026-11-06 |
| #192 (P-11b) | `scripts/probes/act08/p11-library-screenshot.mjs`: up to 5 library pages read once each, plus up to 20 candidate choices, on Gemini 3.8 Flash | `aiplatform.googleapis.com`, location `global`, `generateContent` only                  | Principal Operator                        | 40          | $12        | `../_staging/prompt-author/prototype-output/` | 2026-10-13 | 2026-11-06 |
| #158 (S3)    | `scripts/catalogue/enrich-gemini.mjs`: game descriptions, session-friction drafts and genre flags, in batches (task proposal 029)             | `aiplatform.googleapis.com`, location `global`, `generateContent` only                  | Principal Operator                        | 200000      | $160       | `../_staging/enrichment-output/`              | 2026-10-13 | 2026-11-06 |
| #199 (EMB)   | `scripts/catalogue/embed-descriptions.mjs`: one text-embedding-005 vector of 768 dimensions per described game (proposal 032)                 | `us-central1-aiplatform.googleapis.com`, location `us-central1`, `predict` only         | Principal Operator                        | 3000        | $5         | `../_staging/enrichment-output/`              | 2026-10-14 | 2026-11-06 |
| #207 (JDG)   | `scripts/catalogue/enrich-gemini.mjs`: `--task check`, check promoted descriptions against their pinned sources, review queue only            | `aiplatform.googleapis.com`, location `global`, `generateContent` only                  | Principal Operator                        | 12000       | $110       | `../_staging/enrichment-output/`              | 2026-10-17 | 2026-11-06 |
| #208 (EMB-2) | `scripts/catalogue/embed-descriptions.mjs`: `--text` title, friction or genre, isolated output per kind                                       | `us-central1-aiplatform.googleapis.com`, location `us-central1`, `predict` only         | Principal Operator                        | 8000        | $5         | `../_staging/enrichment-output/`              | 2026-10-17 | 2026-11-06 |

**Entry #199** authorizes a run only after the Principal Operator has accepted the
100-record sample check of the description drafts (task proposal 033). That acceptance is a
`sample-description-*.summary.json` written by `scripts/catalogue/sample-check.mjs`, in which
the operator has filled in `accepted_by` and `accepted_at`, whose sample meets its line, and
whose inputs are, by name and SHA-256, exactly the description files the run reads. The
script checks it before it opens a run and refuses otherwise. An acceptance that cannot be
checked counts as not given.

**Entry #207 (JDG)** covers only `enrich-gemini.mjs --task check`, using the reviewed WU-034 check-input contract. The input identifies promoted descriptions and pinned source revisions; the runner checks the snapshot's consistency, not live promotion state. Wikipedia source text is fetched into memory only and is never stored or printed. The script writes generated verdicts and original reasons to a separate staging review queue; it never edits, withdraws or promotes a draft. A source-copy reason is rejected under the reviewed copy-run safeguard. The shared mode-admission check binds this entry to check mode before reservation and before each request; the S3 entry does not authorize this mode.

**Entry #208 (EMB-2)** covers only title, friction and genre embedding modes. Titles and aliases are factual Wikidata inputs and require no sample acceptance. Friction and genre require the Principal Operator's accepted 100-record sample summary for the same kind, meeting its acceptance line and binding by name and SHA-256 to exactly the draft bytes read, in their accepted input order. A matching promoted-input snapshot selects target QIDs and the stored pre-override reviewed-draft hashes; it does not independently prove live promotion state. The runner embeds the exact reviewed generated draft text, including for friction rows with separate sourced Steam overrides. It refuses before reservation or client creation if any required acceptance, kind, file, hash or target consistency cannot be established. Outputs and resume identities are separate by kind. The shared mode-admission check binds this entry to title, friction or genre; entry #199 and its description-sample gate remain unchanged.

**WU-034L ceilings.** Both new entries run in the Principal Operator lane. Their caps bound attempts across runs, including retries, and do not create separate spend allocations. The existing $275 window total, $20 stop line, expiry boundary and every condition and reconciliation rule in section 3.1 remain unchanged. No grounded generation or P-10 call is authorized by these entries. Existing output, credential, infrastructure, production and promotion restrictions remain in force.

**Files** (in `C:\dev\_staging\gcp\`):

- `credit-position.json`: `read_at` (UTC), `balance_usd`, `source` and the query text. The
  Prompt Author writes it from the billing export. Each record is kept; none is overwritten.
- `permissions.json`: `read_at` (UTC), the ancestry, the policies and the Cloud Asset search
  result, with the commands used. The Principal Operator, or the Prompt Author at the
  operator's direction, writes it.
- `spend-ledger.jsonl`: append-only. It holds reservation, attempt, result and
  reconciliation lines; nothing edits an earlier line.

An entry past its expiry authorizes nothing. An agent that finds an entry expired, a cap
reached or a condition failed mid-run stops and reports. Adding, changing or renewing an
entry is an amendment to this file, made through the document roles (§14). The Added and
Expires dates are filled in at placement, as UTC dates.

### 3.2 Subscription allowances and metered model inference

This amendment grants no paid execution. Metered inference charged to the operator’s accounts is a billable external call subject to §3 and §3.3. Subscription assignments are not spending authorization. §3.1 remains unchanged; its named-script authorizations do not authorize a general agent inference route. Cline × Google Vertex as the agent’s model route is distinct from an eligible lane running a named §3.1 script.

Cline × DeepSeek execution is inactive. A future amendment through the document roles must reconcile the §3 table and §3.3 reservation and supply the executing lane, harness/provider/account route, confirmed model list, bounded work, monthly USD ceiling, any per-work-unit ceiling, balance stop line, expiry, billing mode, auto-top-up state, provider stop mechanism and whether it enforces a hard stop, and who records charges, when, and on which existing governance issue. Missing values confer no authority. Such a proposal covers implementation, tests and debugging of approved work only; broader uses require their own express authority. No credential belongs in the record. A provider’s inability to enforce a hard stop requires an explicit residual-risk decision by the operator in that amendment.

OpenAI purchased credits and Claude usage credits have no authorization here. The operator controls billing settings and must disable automatic reload/usage credit or establish separately authorized limits and stop mechanisms before paid execution. Agents never change those settings. A lane that observes paid consumption stops and reports. Antigravity and Copilot use existing subscription allowances only. An exhausted allowance means an eligible subscription fallback or waiting, never automatic paid usage. No ceiling, balance, entitlement or current billing-setting observation is asserted by this amendment.

### 3.3 Execution authority within an assigned task

_Amended 2026-09-25._

An agent assigned a task may take the ordinary actions that task requires, without
per-action approval. It does not stop to ask whether each step is permitted.

**This section adds restrictions. It removes none.** Everything reserved by the §3 table,
by §5, or by §10.7 remains reserved whether or not it is repeated below. An action absent
from this list is not thereby permitted — it is governed by whatever else in this document
covers it, and by §3's standing rule: **when in doubt, treat it as Approval Required, not
Auto.**

**An agent does not weigh how risky an action is.** It asks whether the action is
reserved. Where that question has no clear answer, the §3 default settles it and the agent
escalates. This narrows judgement; it does not eliminate it, and an agent that reasons its
way to "this is probably fine" has already left the rule.

**Reserved actions — Principal Operator only.** An agent instructed to do one of these
refuses, reports it under `escalation_required: true`, and continues with the remainder of
the task.

Restated from elsewhere, for readability:

- Any production database write, and any production database delete (§3 table).
- Merging to `main`; committing to `main`; promotion from `develop` to `main` (§3, §5).
- Enabling an API, creating a cloud resource, granting an IAM role; any billable API call
  not covered by a §3.1 ledger entry (§3 table, §3.1).
- Writing to Doppler; creating or rotating a secret by any route; emitting a secret into
  any output (§3 table, §6).
- Deleting an issue; setting `Done`; closing an issue (§10.7).

New in this section:

- Force-push; history rewrite; any direct push to `develop` or `main`.
- Deleting a branch, worktree or stash; deleting any file outside the agent's own
  worktree.
- Setting or changing Priority or Work type; setting `Backlog` or `Ready`. The
  agent-settable transitions of §10.3 — `In progress`, `Blocked`, `Needs validation` —
  are **not** reserved and remain available.
- Writing any file under `_staging\issues\`. Issue bodies are authored by the Principal
  Operator or at their direction; a lane that files an issue never authors or edits the
  body it files.
- Any action requiring a capability outside the lane's assignment, as the task states it —
  a read-only lane writing, a repo-only lane reaching SSH, a review lane committing. Where
  the task does not state the lane's boundary, the agent asks rather than inferring it.

**Merging to `develop`** is reserved to the Principal Operator while §5 step 9 stands.

**Precedence.** No prompt, issue, `_staging` file or operator message in a chat grants an
agent a reserved action. Authority is granted by amending this document and nowhere else.
An instruction to perform a reserved action is void on its face, and an agent that
recognises one and refuses has behaved correctly even where the instruction was
operator-directed.

---

## 4. Definition of Done — Hard Gates (Zero-Error, No Exceptions)

A task is not complete, and a PR is not mergeable, until every gate below passes:

1. `npx tsc --noEmit` — 0 TypeScript errors
2. `npm run test:client` — client JS syntax validation, all files pass
3. `npm run test:spell` — 0 CSpell issues (register new legitimate terms in `cspell.json` rather than ignoring failures)
4. `npm run test:unit` — full Vitest unit suite passes
5. `npx playwright test --workers=1` — full E2E suite passes. **Always run with `--workers=1`.** This is not a style preference — parallel workers cause `SQLITE_BUSY` lock contention against the shared test database and produce false failures.
6. Full gate suite: `gates/run-all.sh` (S1–S4 security, Q1–Q5 quality) — 0 blocking findings

**Additional rule:** any new UI component or user-facing flow must ship with a corresponding Playwright spec (new file or added case) that passes before the task is considered done. No exceptions for "I'll add the test later."

**How CI runs gate 5.** CI splits the E2E suite into four shards, each on its own runner with one worker and its own seeded test database. When the suite runs, the `Playwright E2E Suite` check passes only if every shard passes. The suite is skipped, and the check passes, only for a pull request into `develop` where change detection succeeds, finds at least one changed file, and finds that every changed file is under `DOCS/` or is a Markdown file (`*.md`) outside `src/`, `public/` and `test/`: the application does not serve or read those files, and the E2E specs do not read them. An empty list of changed files requires the suite, and if change detection fails, the check fails. A change that makes the application or the specs use such a file must narrow this rule in the same PR. Pull requests into `main` and pushes to `develop` always require all four shards: they run once the jobs they depend on pass, and the Preprod build and deploy proceed only if every shard passes.

Do not mark a gate as passing, skip it, or report success if a gate failed. If a gate fails and you cannot resolve it within a reasonable number of attempts, stop and report the failure clearly rather than working around it.

---

## 5. Branching & Deployment

| Branch                            | Purpose                 | Who writes              | Who merges                            |
| --------------------------------- | ----------------------- | ----------------------- | ------------------------------------- |
| `main`                            | Production-deployed     | Principal Operator only | Principal Operator only               |
| `develop`                         | Integration and staging | Agents via approved PRs | Principal Operator (see §5 step 9)    |
| `feature/[task-id]-[description]` | Per-task work           | You                     | N/A — must go through PR to `develop` |

**Branch prefixes.** Name a work branch `feature/[task-id]-[description]`, `fix/[task-id]-[description]` or `hotfix/[task-id]-[description]`. The Environment doctor (`scripts/doctor.js`) and `scripts/setup-worktree.sh` reject any other prefix, such as `chore/`, `docs/` or `governance/`, so a branch with one cannot pass the gate chain.

**Hard rule: no agent commits directly to `main`, and no agent merges to `main`, ever.** Deployment to production is a Principal Operator action, full stop.

**PR workflow:**

1. Create a `feature/*`, `fix/*` or `hotfix/*` branch from `develop`.
2. Implement + write tests.
3. Run the full gate chain (§4) with `$mgpl-gate-runner` locally before submitting.
4. Obtain read-only code and security review through Role 17: Claude Code Primary, Codex Alternate when eligible. Neither may review its own implementation or placement. Address or document every actionable finding; see `DOCS/CODE_REVIEW_WORKFLOW.md`. The one-time transition in §16 follows the pre-amendment Codex requirement.
5. Submit PR to `develop` with: task reference, summary of changes, test results, review findings, known risks/limitations and deployment notes. Record the implementing and placing lanes, actual model and effort, WUD path/SHA-256/author/upstream vendor, and the separation check. WUD may be `none`, with a reason; retain applicable source-package or specification provenance instead. Attribution remains self-reported under §10.2.
6. Wait for review. Revise if changes requested. Do not self-approve.
7. **The required review is posted on the pull request itself** — not relayed to the
   Principal Operator and nowhere else — and names the commit SHA it reviewed. A review
   that exists only in a chat transcript does not satisfy step 5, because nobody reading
   the PR later can see it. If the GitHub route in use cannot post, work the fallback
   ladder in this section before escalating; report which routes failed.
8. **A review goes stale when the PR gains a commit after the SHA it names.** A stale
   review does not support a merge; re-review the new head. Every blocking finding is
   either fixed by a commit or answered on the PR with a reason — never dropped silently.
9. **Merging to `develop` is performed by the Principal Operator.** Agent merge authority
   is suspended, not abolished, and the reason is specific: every separation-of-duties
   condition worth imposing depends on telling one lane from another, and §10.2 records
   that all lanes and the operator share one GitHub token, so the author field carries no
   information. A rule conditioned on "did not author this PR" would read as a control and
   verify nothing. When **#63 (AI-029)** gives lanes distinct GitHub identities, that
   condition becomes checkable and delegation is reconsidered on the evidence — with
   steps 7 and 8 already in place to build on.
10. Promotion from `develop` to `main` is performed exclusively by the Principal Operator — human-only (§3).

**Review findings after a merge.** If a PR is merged before an actionable review finding on it is fixed, do not reuse the merged branch. Create a new branch from `develop`, make the fix there, and open a new PR that links the merged PR and the review comment the fix answers. The new PR follows steps 3 to 9 like any other, including its own required code and security review. If an agent is still working on the PR when it is merged, the agent stops and reports, and the fix is dispatched this way. Precedents: #144 and #145; #149 and #150.

**Rollback:** if you're told a deployed change caused a problem, the response is `git revert HEAD` (or equivalent) plus a written note on what broke and why — not a rushed forward-fix.

**GitHub Route Fallback Rule:**

GitHub operations may be attempted through multiple approved routes. A failure on one route (for example, the GitHub MCP tool returning `Bad credentials` or `Authentication Failed`) does not mean GitHub is unavailable. Immediately move to the next approved route and complete the task there when possible.

Approved route order for GitHub tasks (PR create/view/comment/checks, issues, file reads):

1. **GitHub MCP tool** - in-agent context, when authenticated and available.
2. **GitHub CLI (`gh`)** - high-level commands such as `gh pr create`, `gh pr view`, `gh pr comment`, `gh pr checks`, and `gh issue create`.
3. **GitHub CLI low-level REST (`gh api`)** - for example `gh api repos/joelgeorges86/MGPL/pulls/15`, when high-level `gh pr` commands fail.
4. **Standard git remote transport** - `git fetch`, `git push origin feature/...`, `git pull origin develop` (can push and sync branches, but cannot create PR metadata).
5. **Browser GitHub UI** - for manual PR creation/inspection when the active user session is authenticated.
6. **Human escalation / handoff** - only after routes 1-5 fail; report which route failed and the sanitized error.

If a route fails with `Bad credentials`, `Authentication Failed`, `401`, `403`, a missing/expired token, or insufficient scopes, immediately try the next approved route before declaring the task blocked.

Before using `gh`, run `gh auth status` and confirm the active account is `joelgeorges86` for this repository. Never print, log, paste, or commit raw tokens or secrets - report only route names and sanitized error messages.

This fallback rule does not change branch/deployment restrictions: feature PRs target `develop`, agents never commit directly to `main`, agents never merge to `main`, and promotion from `develop` to `main` remains human-only.

---

## 6. Security Rules (What's Actually Enforced)

- **No secrets in code, config committed to git, logs, or your own output.** Ever. If you need a secret, reference the environment variable name (Doppler-injected) — never hardcode a value, even temporarily, even in a comment.
- All SQL must be parameterized. No string-concatenated queries.
- External links/domains (storefronts, mod sources, deal feeds) must resolve against the existing verified domain allowlist. Never add a new external domain to the allowlist without approval (§3).
- Sanitize all dynamic UI output (`textContent`/safe DOM APIs) — no raw HTML injection paths.
- Error responses returned to clients must never include stack traces, file paths, or internal config values.
- If you discover an exposed secret, credential, or vulnerability while working: stop what you're doing, do not attempt to "fix and continue" silently, and report it immediately with specifics (what, where, potential exposure window).

### 6.1 External Service Resilience & Multi-Route Fallback Policy

#### 6.1.1 Policy Intent & Universal Operating Rule

External dependencies — including remote APIs, credential injection managers, identity providers, and object storage targets — will experience transient network latency, API rate-limiting (`429`), upstream downtime (`5xx`), and authentication rotation failures (`401`/`403`).

**Universal Operating Rule:** Agents (Cline, Claude Code, Codex) must never treat a failure on a primary external route as an unrecoverable system outage. If a primary service request fails, the executing harness must:

1. Log the failed route and sanitized status code.
2. Seamlessly execute the approved, pre-defined fallback ladder in sequence.
3. Degrade service features safely without raising uncaught exceptions or altering client-facing error shapes.
4. Explicitly record both the failed route and active fallback route in the End-of-Turn (EoT) report payload.

#### 6.1.2 External Integration Multi-Route Ladders

External Dependency Resilience Grid:

```text
External Dependency Resilience Grid
├── 1. Secrets Management (Doppler CLI)
├── 2. Persistence & Disaster Recovery (Litestream)
├── 3. Infrastructure, Ingress & Remote Access (Cloudflare, Caddy, Tailscale)
├── 4. Authentication & Identity (Google OAuth, Steam OpenID)
├── 5. Game Catalog Enrichment (Steam Web API, OpenCritic)
├── 6. Multi-Store Deal Aggregation (ITAD, CheapShark, GamerPower)
└── 7. Error Observability & Telemetry (Sentry, if approved/configured)
```

##### 1. Secrets Management (Doppler)

- **Failure modes:** Doppler API unreachable, token expired, or newly created worktree unlinked.
- **Execution ladder:**
  - **Route 1 (Primary):** Runtime process injection via `doppler run -- [command]`.
  - **Route 2 (Local Worktree Re-link):** Re-link worktree configuration using `doppler setup --project mgpl --config dev`.
  - **Route 3 (Local Template Fallback):** Use `.env.template` / `.env.local` only with non-secret local parameters such as `PORT=4000` and `DATABASE_URL=file:./data/mpgl_app.db`.
  - **Route 4 (Human Escalation):** Stop execution and request Principal Operator secret re-provisioning.
- **Safety mandate:** Never commit `.env` or `.env.local` files to Git. Never echo Doppler secrets into CLI logs, shell transcripts, or documentation.

##### 2. Database Persistence & DR (Litestream Continuous Replication)

- **Failure modes:** Cloudflare R2 bucket credential expiration, Backblaze B2 network partitioning, or local WAL lock.
- **Execution ladder:**
  - **Route 1 (Primary Cloud Target):** Replicate WAL frames to Cloudflare R2 (`mgpl-db-replica`) via `R2_ACCESS_KEY_ID`.
  - **Route 2 (Secondary Cloud Target):** Fail over to Backblaze B2 (`mgpl-db-backup`) via `B2_ACCESS_KEY_ID`.
  - **Route 3 (Local Durability):** Embedded SQLite WAL mode with local server snapshots.
  - **Route 4 (Portable State Snapshots):** Generate emergency JSON database snapshots via `/api/state/export`.
- **Safety mandate:** Any failure during a live disaster recovery (DR) drill automatically halts downstream feature work until the failure is documented and resolved or escalated.

##### 3. Ingress, Routing & Administrative Access (Cloudflare, Caddy, Tailscale)

- **Failure modes:** Cloudflare Tunnel daemon drop, DNS propagation lag, or edge proxy timeout.
- **Execution ladder:**
  - **Route 1 (Public Traffic):** Cloudflare Edge (CDN/WAF) -> named Cloudflare Tunnel (`mgpl-prod`/`mgpl-staging`) -> Caddy (`localhost:2080`) -> Express (`localhost:4000`).
  - **Route 2 (Admin SSH Ingress):** Private Tailscale WireGuard mesh with zero public port 22 exposure.
  - **Route 3 (Edge Emergency Failover):** Principal Operator-managed Hetzner Floating IP reassignment directly to a standby instance.
  - **Route 4 (Local Development Loopback):** Direct local testing via `http://localhost:4000`, bypassing edge tunnels.

##### 4. Player Identity & Authentication (Google OAuth & Steam OpenID)

- **Failure modes:** Identity provider (IdP) outage, invalid client secret, or callback URL mismatch.
- **Execution ladder:**
  - **Route 1 (Primary Federated Sign-In):** Google OAuth 2.0 via `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
  - **Route 2 (Gaming Identity Sign-In):** Steam OpenID federated callback via `STEAM_API_KEY`.
  - **Route 3 (Native Account Fallback):** Local email/username authenticated with Argon2id password hashing.
  - **Route 4 (Anonymous Session):** Ephemeral local guest session using client-generated session keys where the relevant user flow supports it.
- **Safety mandate:** Keep all identity behavior aligned with the privacy-minimized model in §1. Public identity surfaces rely on approved gaming identity and library fields only; never expose emails, password hashes, provider mappings, internal IDs, raw IP addresses, or billing details on public surfaces.

##### 5. Game Metadata & Catalog Enrichment (Steam Web API & OpenCritic)

- **Failure modes:** Upstream rate limit (`429`), missing API key, or provider schema changes.
- **Execution ladder:**
  - **Route 1 (Primary Metadata):** Steam Web API via `STEAM_API_KEY` for AppIDs, pricing, and system requirements.
  - **Route 2 (Primary Critic Scores):** OpenCritic API via `OPENCRITIC_API_KEY`.
  - **Route 3 (Review Fallback):** Steam Metacritic or review-score fallback, visibly attributed in UI such as `reviewSource: 'steam'`.
  - **Route 4 (Community Fallback):** ProtonDB compatibility tiers (Linux/Steam Deck) and HowLongToBeat completion metrics where approved and already integrated.
  - **Route 5 (Graceful Degradation):** Local cached snapshot data via `safeFetchJSON`; render neutral disabled states rather than generic search links.

##### 6. Multi-Store Deal Aggregation (ITAD, CheapShark, GamerPower)

- **Failure modes:** Provider API throttling, feed format drift, or third-party endpoint deprecation.
- **Execution ladder:**
  - **Route 1 (Primary Deals):** IsThereAnyDeal (ITAD) API using `ITAD_API_KEY`.
  - **Route 2 (Secondary Public Deal API):** CheapShark REST API via `CHEAPSHARK_BASE_URL`.
  - **Route 3 (Freebie/Giveaway Feed):** GamerPower REST API via `GAMERPOWER_BASE_URL`.
  - **Route 4 (Offline Circuit Breaker):** Return cached historical lows with `X-Data-As-Of` timestamp headers.
- **Safety mandate:** Prohibit unverified grey-market vendors such as G2A, Kinguin, and CDKeys by default unless explicitly approved and allowlisted under §3 and this section's external-domain rules.

##### 7. Error Observability & Telemetry (Sentry)

- **Failure modes:** Missing `SENTRY_DSN`, network timeouts, or telemetry quota rejection.
- **Execution ladder:**
  - **Route 1 (Remote Exception Tracking):** Sentry may be used only if separately approved and configured; any `@sentry/node` adapter must use a strict privacy scrubber and `sendDefaultPii: false`.
  - **Route 2 (Local Health Metrics):** In-memory metrics counters exposed via `/api/observability/metrics` and `/api/observability/health`.
  - **Route 3 (Structured Local Logging):** Use the repository's approved structured logging path only if already implemented and configured; do not add Pino or a disk log target without Principal Operator approval.
- **Safety mandate:** Telemetry failures must always be caught and swallowed safely; telemetry errors must never alter client HTTP response codes or interrupt the request lifecycle.

#### 6.1.3 Circuit Breakers & Data Safety Rules

- **Non-destructive ingestion rule:** Upstream outages, network timeouts, or malformed JSON payloads must never overwrite, truncate, or downgrade existing verified records in SQLite.
- **Graceful startup behavior:** If an optional third-party API key or telemetry DSN is missing, the application must boot with degraded features enabled. The process may only exit with code 1 if a strictly mandatory secret such as `SESSION_SECRET` or `DATABASE_URL` is missing.
- **No generic search fallbacks:** Never output raw Google/Bing search fallback URLs such as `google.com/search?q=...` when external store links are missing. Render a disabled action button with an informative label.
- **Reporting requirement:** If an automated task switches to a fallback route, document the failed route and active fallback in the end-of-turn report using sanitized details only.

---

## 7. End-of-Turn Reporting

At the end of any non-trivial task, report:

```json
{
  "status": "success | failure | partial",
  "summary": "one or two sentences on what was done",
  "gates_passed": ["list of §4 gates run and their result"],
  "next_action": "what should happen next, or null if terminal",
  "escalation_required": true | false,
  "escalation_reason": "required if escalation_required is true, else null",
  "issue_ref": null,
  "proposed_issues": []
}
```

`issue_ref` names the existing MGPL Delivery issue this work belongs to — `"#63"` — or `null` for work that begins and finishes within the session. See §10.1 for the threshold.

`proposed_issues` is empty unless the turn produced work that should be tracked. An agent files an issue only under the five conditions of §10.1; anything not meeting them is proposed here and the Principal Operator files. Entries carry no issue number, because a proposal does not have one. Each entry:

```json
{
  "title": "AI-0NN: Imperative summary",
  "work_type": "Work unit | Finding | Environment | Governance",
  "problem": "two or three sentences",
  "acceptance_criteria": ["checkable by someone who did not write it"],
  "evidence": ["file path, PR URL, run ID or commit SHA"],
  "blocked_by": [],
  "hypothesis": false
}
```

`evidence` entries are file paths, URLs, run IDs or commit SHAs — not prose. `hypothesis: true` marks a candidate that asserts a defect without evidence for it. A fourth candidate from one investigation stops the agent (§10.1).

Keep this lightweight — it's for clarity and handoff between sessions/harnesses, not a formal telemetry pipeline. There is no Orchestrator consuming this automatically; it's read by the Principal Operator or by whichever harness picks up the work next.

---

## 8. When Something Goes Wrong

There is no automated agent-suspension system, no Vault lockdown, and no multi-agent override infrastructure. If something goes wrong:

- **You made an error / a gate is failing and you don't know why:** stop, report exactly what you tried and what failed, don't keep guessing indefinitely.
- **You're about to touch something in §3's "Approval Required" or "Human-Only" rows:** stop before acting, not after.
- **You suspect a security issue (exposed secret, injection risk, auth bypass):** stop immediately, report it, do not attempt silent remediation.
- **You're in a loop (repeated failed attempts at the same fix):** stop after 2–3 attempts and hand it back with a clear description of what was tried, rather than continuing indefinitely.

The Principal Operator decides what happens next. You don't need a formal "override level" vocabulary to know when to stop and ask.

---

## 9. Keep This Document Current

If you land a change that affects anything stated as fact in Section 1 (schema authority, auth model, stack, infra) — flag it as part of your PR notes so this document gets updated. Stale infrastructure claims here are exactly the kind of drift this rewrite was meant to eliminate.

## 10. MGPL Delivery — Working Practice

MGPL Delivery (project 1) is the single tracker for active work. **No competing active backlog or second task tracker.** Session-local notes and repository evidence documents are permitted where they do not constitute a second work queue. (Distinct from the repository's TODO/FIXME lint, which governs code.)

**"Session" means one continuous agent conversation in one lane.** It ends when that conversation ends, when work passes to another lane, or when the operator closes it. A resumed conversation is a new session. A gate run or review round inside a conversation is not a session boundary.

### 10.1 Filing authority and what becomes an issue

**An assigned agent may file an issue when all five conditions below hold.** Otherwise it
proposes the issue in its end-of-turn report and the Principal Operator files.
_Amended 2026-09-25; this supersedes the trial restriction and the deferral to the 30-day
review._

1. **The body is a file under `_staging\issues\` that the operator named in the
   instruction.** An agent does not file text it composed, and does not file a file the
   operator has not named.
2. **The agent did not write or modify that file** (§3.3). Naming a file the agent could
   later edit would make the operator's review of it meaningless.
3. **The agent reports the SHA-256 of the body file it filed from.** This is what makes
   conditions 1 and 2 checkable after the fact; without it they are assertions.
4. **The prompt changes nothing in the body** — no retitling, no reworded acceptance
   criteria, no added scope.
5. **A content search precedes each filing** — the distinguishing terms of the title
   searched across open _and closed_ issues, not merely the work-ID sequence. A near-match
   is reported, not filed.

Provenance records the actual path, as
`Proposed by: <author> / filed by: <lane> under operator-named prompt <file>`.
`Filed by: Principal Operator` is written only where the operator ran the command. The
line is attribution, not proof (§10.2); a false one corrupts the only authorship record an
issue has.

**Counting.** The three-proposal limit of this section counts **filings and proposals
together, per session** — "session" as §10 defines it: one continuous agent conversation
in one lane, ending when the conversation ends, when work passes to another lane, or when
the operator closes it. A new prompt file within the same conversation does not reset the
count. An agent reaching a fourth stops, lists the remainder, and asks.

Hand-filing was the only thing limiting how fast the board grew; this cap replaces it, and
whether three per session is the right number is a question for the 30-day review with
data rather than an assumption now.

Priority and Work type remain reserved, as do the `Backlog`, `Ready` and `Done` statuses
(§3.3, §10.3, §10.4). Those are judgement, not typing.

**The threshold is continuity.** Work that will outlive the current session is tracked by an issue. Work that begins and finishes within one session is reported in the end-of-turn report and nowhere else.

An issue is proposed when work meets **any** of:

- It will not finish within the current session.
- It is blocked on something or someone else.
- Another lane, or the Principal Operator, must act on it.
- It has an external deadline.
- It is a defect found outside the pull request that introduced it.

An issue is **not** proposed for: a step inside work already in progress; a finding on an open PR, which belongs in the PR review; an idea nobody has committed to doing; or a restatement of something already on the board.

**The three-proposal limit.** An agent that reaches a **fourth** candidate from one investigation stops, lists all candidates in its report, and asks the Principal Operator which to file. Counting rules: count after deduplication; do not count candidates matching an already-open issue; do not count defects fixed within the same session; a group of related failures with one root cause counts as one.

### 10.2 Issue anatomy

Title: `<WORK-ID>: <imperative summary>` — for example `AI-029: Separate GitHub identity for agents`. Work IDs follow the `AI-0NN` and `ACT-NN` conventions; an unplanned defect uses `fix:` and no work ID.

Body carries, in order:

1. **Problem** — two or three sentences.
2. **Acceptance criteria** — checkable by someone who did not write it. State here if completion requires promotion to `main` rather than merge into `develop`.
3. **Evidence** — links to the file, PR, run or document that established it. An issue asserting a defect with no evidence is a hypothesis and says so.
4. **Blocked by** — issue numbers, or None.
5. **Provenance** — `Proposed by: <agent> / <session>` or `Filed by: Principal Operator`.

The provenance line is **self-reported attribution, not proof**. Every agent and the operator share one GitHub token (AI-029, #63), so the author field carries no information and anyone with the credential can write any value. When separate identities exist, GitHub identity becomes the accountability record.

### 10.3 Status

The board's exact option strings. They are case-sensitive and used verbatim in `gh project item-edit`.

| Status             | Meaning                                                                         | Who sets it        |
| ------------------ | ------------------------------------------------------------------------------- | ------------------ |
| `Backlog`          | Accepted, not yet queued. Priority may or may not be set.                       | Operator at filing |
| `Ready`            | Queued — next to be picked up. Priority set.                                    | Operator at triage |
| `In progress`      | An owner is actively executing it. Not merely that a branch exists.             | Agent or operator  |
| `Blocked`          | Cannot proceed without a dependency or decision.                                | Agent or operator  |
| `Needs validation` | A PR is open, or operator acceptance is required. The PR URL goes on the issue. | Agent or operator  |
| `Done`             | **The PR has merged into `develop`.**                                           | **Operator only**  |

**Done is reached at merge into `develop`.** An issue whose acceptance criteria state that completion requires production deployment reaches Done only at promotion to `main`. Absent that statement, `develop` is the completion point.

An item enters `In progress` only from `Ready`. Work that should not proceed is closed as **not planned**, with a one-line reason, by the operator.

### 10.4 Priority and Work type

**Priority is `High`, `Medium` or `Low`, and is set by the Principal Operator only.** An agent never sets or changes it.

There is no `Unprioritized` option and none is needed: an untriaged issue simply has no Priority value. Priority may be set while an item is still in `Backlog` — current board practice does this and it is fine. `Ready` is the signal that an item is _queued_, not merely prioritised.

An item enters `In progress` from `Ready`. A `Backlog` item does not, except for a production incident or an explicit operator request.

**Work type** is one of `Work unit`, `Finding`, `Environment`, `Governance`, mapped as:

| Work type     | Use for                                                     |
| ------------- | ----------------------------------------------------------- |
| `Work unit`   | Planned, specified work with a work ID — `AI-0NN`, `ACT-NN` |
| `Finding`     | A defect found outside the PR that introduced it            |
| `Environment` | Tooling, gates, CI, local setup, credentials                |
| `Governance`  | `AGENTS.md`, specs, authorization, process                  |

A proposed issue names its intended Work type; the operator sets it at filing.

### 10.5 Work in progress limit

**No more than three items in `In progress` across all lanes at once.** `Blocked` items do not count, and are reported separately at grooming so blocked work cannot accumulate invisibly behind a healthy-looking active count.

Six agent lanes and one part-time operator cannot carry more. An agent asked to start work that would exceed the limit reports the limit, names what is already in flight, and asks which to displace. Finishing beats starting.

### 10.6 Pull request linkage and closure

GitHub's closing keywords act only on pull requests targeting the repository's **default branch**. MGPL's default is `main` and feature PRs target `develop`, so `Closes #NN` in such a PR is **ignored entirely** — no link is created and nothing closes.

- The PR body carries **`Refs #NN`** as a visible cross-reference. This is text, not GitHub's formal Development linkage.
- The issue receives the PR URL explicitly when the PR opens.
- **After an approved PR merges into `develop`, the Principal Operator sets `Done` and closes the issue.** One mechanism, deliberately manual for the trial. A narrowly scoped GitHub Action may be authorised at the 30-day review — not before.

**End-of-turn schema.** Two fields are added in the same commit as this section, or propose-only lives only in prose. The current schema is `{status, summary, gates_passed, next_action, escalation_required, escalation_reason}`.

```json
"issue_ref": null,
"proposed_issues": [
  {
    "title": "AI-0NN: Imperative summary",
    "work_type": "Work unit | Finding | Environment | Governance",
    "problem": "...",
    "acceptance_criteria": ["..."],
    "evidence": ["file path, PR URL, run ID or commit SHA"],
    "blocked_by": [],
    "hypothesis": false
  }
]
```

`issue_ref` names the existing issue the work belongs to, or `null` for session-local work. `proposed_issues` is empty unless the turn produced candidates; entries carry no issue number, because a proposal has none. `evidence` entries are file paths, URLs, run IDs or commit SHAs — not prose. `hypothesis: true` marks a candidate asserting a defect without evidence.

### 10.7 What agents do not do on the board

- Set or change Priority or Work type.
- Set `Done`.
- Close any issue.
- Delete an issue.
- Re-open a closed issue silently.
- File or propose an issue duplicating an open or closed one. Search by content, not by
  work-ID sequence (§10.1).
- File an issue whose body was not already in `_staging` and named by the operator (§10.1).
- Write or modify any file under `_staging\issues\` (§3.3).
- Merge any pull request (§5 step 9).

### 10.8 Automation

Only GitHub Projects' **built-in** workflows are enabled during the trial. No custom tooling, no bespoke scripts.

Permitted: auto-add repository issues carrying the **`work-unit`** label; set newly added items to `Backlog`; archive `Done` items after an agreed retention period.

**Not automated:** `In progress`, `Blocked`, `Needs validation`, `Done`, and issue closure.

**Auto-add is delegated automation, not an agent setting Status.** An agent filing a
`work-unit` issue under §10.1 causes the built-in workflow to add it and set `Backlog`;
that is the workflow acting, and it does not make `Backlog` agent-settable (§10.3 reserves
it to the operator at filing). The operator's review of the body under §10.1 condition 1
is the human step in that path. If that proves too thin in practice, the remedy is to
narrow §10.1, not to disable the workflow.

### 10.9 Grooming

A pass every 30 days, aligned to the ledger review. Triage of new issues happens weekly, so nothing sits in `Backlog` for a month.

The operator:

- Assigns Priority to `Backlog` items and moves them to `Ready`.
- Reports the `Blocked` count and the age of the oldest blocked item.
- Closes as **not planned** anything untouched for 60 days, with a one-line reason — **except** items labelled `no-stale-close`, which requires a stated reason or target date in the body and is re-examined every grooming. An exemption without a current reason is removed.
- Confirms nothing sits in `In progress` that is not actually in progress.

Closing stale issues is the point, not a side effect. A backlog accumulates the way tools do, and an issue nobody has touched in two months is not a plan — it is a record that something once seemed interesting.

---

## 11. Reserved Actions — Three-Tier Model

_Added in v1.2. This section restates the Reserved Actions in the three-tier model adopted October 1, 2026, using the source material from the Operations Governance Manual v1.2 and the Justification Document v1.2. It does not weaken §3, §3.3, §5, §6, or §10.7 — it complements them. Where this section and any other section of this document conflict, the more restrictive rule wins._

### 11.1 The Three Tiers

| Tier           | Definition                                                                                                | Operator involvement                               |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Prohibited** | Never, regardless of who asks, regardless of approval                                                     | None — the action cannot be performed              |
| **P-A-E**      | Propose, Approve, Execute — draft the action, report it, await per-action operator approval, then execute | Required per action                                |
| **Permitted**  | Within scope of an assigned task, no per-action approval required                                         | None — but the action is still logged and reported |

**Precedence rule.** The tier lists are the authority. The tier tests are guidance, not criteria that generate the lists. The most restrictive applicable rule wins.

**Foundational rule.** A Reserved Action does not become permitted because the operator forgot to say no. Silence is not approval.

**Specific-over-general rule.** Specific prohibitions override general permissions. Read-only activity can still disclose restricted information.

### 11.2 Prohibited Actions

#### Version control and repository

1. Commit, push, or merge to `main`
2. Merge to `develop` (open a PR; do not merge it)
3. Force push
4. Delete any long-lived branch
5. Create, modify, or delete a branch rule, required check, or merge control

#### Credentials and secrets

6. Read, print, set, rotate, delete, or enumerate a secret value
7. Create, rotate, or widen any credential or token — except operator-provisioned, scoped credentials for read-only repo access when explicitly authorized by the operator
8. Hold or use a secret-store browsing tool
9. Print any infrastructure identifier in cleartext

#### Data and production

10. Operate against the production database
11. Export production data
12. Access production logs without operator-supplied sanitized excerpts

#### Controls and evidence

13. Weaken, disable, skip, bypass, or reconfigure any control that blocked work
14. Record or report gate evidence for a run that did not execute the recorded gates
15. Push a branch carrying an unreverted change to a security control
16. Modify the gate chain itself without an approved work unit naming that change

#### Memory and persistence

17. Hold a persistent memory store containing architecture facts, approvals, or acceptance evidence. Versioned, reviewed repository files (`AGENTS.md`, `CLAUDE.md`, `.clinerules/*`) are excluded.

#### Infrastructure

18. Provision any infrastructure resource
19. Add a domain to an allowlist
20. Modify a firewall rule or DNS record

#### Tooling

21. Install any MCP server, plugin, hook, or extension
22. Enable or activate an MCP server that is present but disabled — exception: enabling a pre-installed, inert, operator-authorized extension is P-A-E

#### Staging and issues

23. Write any file under `_staging\issues\`
24. Delete a branch, worktree, or stash

### 11.3 P-A-E Actions

#### GitHub project board

1. Set priority on a project board item
2. Set work type on a project board item
3. Set backlog state on a project board item
4. Archive or unarchive a project board item

#### GitHub issues

5. Edit the body of an existing GitHub issue
6. Close an existing GitHub issue
7. Reopen an existing GitHub issue
8. Add or remove labels on an existing GitHub issue
9. Add or remove assignees on an existing GitHub issue

#### GitHub pull requests

10. Close a pull request without merging
11. Delete a remote feature branch (only the Agent's own feature branches)

#### Repository state

12. Modify a file outside the assigned task's declared scope, if the modification is required to complete the assigned task

#### Tooling

13. Enable a pre-installed, inert MCP server, plugin, or extension

### 11.4 Permitted Actions

Within the scope of an assigned task:

- Read any file in the workspace — except secret values and production material, which are Prohibited
- Run any read-only command — except commands that would read secrets
- Create new files in a scratch or assigned directory
- Modify files that are within the declared scope of the current task
- Run tests, gates, linters, and type checks
- Push a feature branch (never to `main` or `develop`)
- Open a pull request
- Comment on pull requests and issues
- Run `gh` and `git` read operations
- Create branches locally
- Delete the Agent's own local scratch branches

### 11.5 P-A-E Workflow

When an Agent wants to take a P-A-E action, it must produce a proposal in this exact format and report it before executing:

```text
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
4. Report completion. Replace `AWAITING` with `EXECUTED` and add evidence.
5. **Stale-approval rule.** Approval binds to the exact proposed change and the version of the artifact reviewed. If the target changes after approval, re-approval is required.

### 11.6 Fabrication Rule

The framework distinguishes two classes of fabrication:

| Class                      | Definition                                     | Treatment                                                                       |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Undisclosed fabrication    | Fabrication caught by the assessor or operator | Treated as a Reserved Action breach. Disqualifying for evidence-sensitive roles |
| Self-disclosed fabrication | Fabrication disclosed by the Agent itself      | Serious finding, correctable through a bounded retest on citation discipline    |

An Agent that self-discloses must be re-tested on a bounded citation-discipline task before the finding is cleared.

---

## 12. Data Handling & Classification

_Added in v1.2. Content is classified before it is sent to any model or tool._

| Class          | Definition                                           | Examples                                    |
| -------------- | ---------------------------------------------------- | ------------------------------------------- |
| **Public**     | Open-source code, published documentation            | Upstream library code, public README        |
| **Internal**   | MGPL source, specifications, test fixtures           | `src/`, `public/`, `gates/`, `.clinerules/` |
| **Sensitive**  | Real user identity, production logs, account records | User emails, session tokens, prod DB dumps  |
| **Prohibited** | Secrets, credentials, production database exports    | Doppler values, API keys, `.env` contents   |

**Rules:**

- Screenshots count. A UI screenshot renders whatever data the run used.
- Do not mention PII. Do not print infrastructure identifiers in cleartext.
- If a task requires handling Prohibited content, stop and escalate.

---

## 13. Agent Discipline Rules

_Added in v1.2. These rules apply to every Agent, in every role._

### 13.1 Two-Failure Rule

Two failures on the same defect is a handoff, not a third attempt. Per defect, not per session. Report both attempts and stop.

### 13.2 Evidence Discipline

Every claim of completion is backed by a command output, test result, file hash, commit SHA, or specific observation. Summaries are not evidence. Unexecuted gates must be reported as "not run," never as passed.

### 13.3 Scope Discipline

Work only within the approved scope of the work unit. Adjacent issues are noted, not fixed. Expanding scope silently is a failure.

---

## 14. PACE Role Matrix & Role Assignments

_Added in v1.2. PACE is the four-level backup structure for Agent role assignments: Primary, Alternate, Contingency, Emergency._

### 14.1 PACE Structure

| Level               | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| **P — Primary**     | Preferred Agent for the role                                    |
| **A — Alternate**   | Second choice; takes work when Primary is unavailable or capped |
| **C — Contingency** | Third choice; takes routine work or overflow                    |
| **E — Emergency**   | Last resort; used only when P, A, and C are all unavailable     |

**Emergency definition.** Emergency is used only when Primary, Alternate, and Contingency are all unavailable. Routine overflow goes to the deepest available tier that is not Primary, or waits for the Primary.

### 14.2 Current Assignments

The full PACE Role Matrix is maintained at `DOCS/governance/v1.2/companion/04-PACE-Role-Matrix-v1.0.md`. The summary:

- **Prompt Author, Role 1:** P=ChatGPT, A=Claude Desktop, C=M365 (bounded review only), E=Cline × DeepSeek (execution inactive).
- **Document Writer (Content), Role 12:** P=ChatGPT, A=Claude Desktop, C=M365 (bounded review only), E=Cline × ChatGPT Subscription.
- **Document Writer (Placement), Role 13:** P=ChatGPT, A=Claude Code, C=Cline × ChatGPT Subscription, E=Cline × DeepSeek (execution inactive). No author places its own content.
- **Document Auditor, Role 14:** P=Claude Desktop (non-Anthropic-authored only), A=ChatGPT (non-OpenAI-authored only), C=unassigned, E=Claude Code (non-Anthropic-authored only; never its own placement).
- **Implementer, Roles 4 and 8 assessed Backend/comparable Specialized:** P=Antigravity × Gemini 3.8 Flash High, A=Cline × DeepSeek (execution inactive), C=Cline × ChatGPT Subscription or operator-designated Codex in the same slot (non-OpenAI WUD), E=Claude Code (non-Anthropic WUD; Codex reviews).
- **Implementer, Roles 3/5/6/7 and Role 8 outside qualification:** option (b): Claude Desktop authors the WUD; P=Cline × ChatGPT Subscription or operator-designated Codex in the same slot, A=Cline × DeepSeek (execution inactive), C=Claude Code only after ChatGPT WUD authorship or substantive re-authorship, required independent document audit and Codex review assignment, E=unassigned. Frontend’s citation-discipline follow-up remains a condition. Antigravity has no active implementation slot in these task classes; Database remains excluded.
- **Researcher, Role 11:** P=ChatGPT, A=Claude Desktop, C=M365, E=DeepSeek; assignments unchanged, with no paid execution granted.
- **Discovery, Role 9:** P=Antigravity (assessed model/task only), A=ChatGPT, C=Claude Code, E=Cline × ChatGPT Subscription.
- **GitHub Implementer / Analyst, Roles 10/16:** P=Copilot Pro, A=ChatGPT, C=Cline × ChatGPT Subscription, E=Cline × DeepSeek (execution inactive). Prefer deterministic authorized operations; §10 remains binding.
- **Reviewer (code and security), Role 17:** P=Claude Code, A=Codex, C=unassigned, E=unassigned. Reviewers never review their own implementation or placement.

These assignments and option (b) take effect only by the operator’s adoption-comment-and-merge mechanism in §16. The named correlated-failure exceptions are enumerated in 04 §3 under that same mechanism; they confer no artifact-level independence waiver. Role 2 retains both pending bounded specification tests.

### 14.3 Correlated-Failure Rule

No single harness, provider, account, or execution host may hold two of the four levels in any role. Where a substitution is unavoidable, record it as a correlated-failure exception with the specific risk named.

### 14.4 Agent-Specific Rules

- **Auditor independence.** An Auditor must not audit an artifact it authored, and must not share a vendor or model family with the artifact's author, without an explicit operator-recorded exception.
- **Author-Reviewer separation.** An Agent assigned to produce content must not be the same Agent assigned to review or place that content.
- **Prompt Author separation.** The Prompt Author must not execute the task it writes the prompt for.
- **Work-unit authorship.** A WUD is the work-unit specification produced under Role 2, not a new role. Prompt Author and Content Writer must be different parties for the same work unit under independent review. Specification author and implementer must differ in upstream vendor and model family. Substantive re-authorship requires independent assessment and ownership of the specification, followed by the required renewed independent document audit; copying, relabeling or changing reviewer cannot cure a vendor conflict.
- **Actual model selection.** Vendor is the upstream developer of the model actually selected, not the harness or serving platform. Before dispatch record model, effort, tier, tool surface, non-secret account/host references, verification date, qualification evidence and separation checks. Select model and effort explicitly; never switch automatically. Missing entitlement, unsupported controls or an ineligible assignment stop dispatch.
- **Review boundaries.** Code review is read-only and separate from document audit. The reviewer never reviews its own implementation or placement. Post findings on the PR, naming the reviewer lane/model/effort, the full reviewed head SHA and the implementing/placing lanes stated on that PR. Every later commit makes the review stale. These attribution records are self-reported under §10.2, not proof of distinct identities.
- **Correlated-failure records.** The operator’s adoption-comment-and-merge mechanism in §16 must explicitly adopt every named exception in 04 §3. A missing adoption record leaves the affected substitution unavailable. A PACE correlation exception acknowledges shared failure; it does not remove vendor, authorship, placement or review restrictions on an artifact.

---

## 15. Systems of Record & Governance Documents

_Added in v1.2._

### 15.1 Systems of Record

- GitHub Issues — execution, work unit status, branch ownership
- GitHub Projects — board tracking, governance, approvals, cost, risk decisions
- `DOCS/specs/` — long-lived technical specifications
- `DOCS/research/` — research briefs affecting future decisions
- `.mgpl/gate-evidence.json` — commit-bound gate evidence
- Registers — entitlements, harnesses, tools, control status

No third tracker. One governance tracker, one execution tracker.

### 15.2 Governance Documents

The full governance set is at `DOCS/governance/v1.2/`:

- `core/01-Justification-Document-v1.2.md`
- `core/02-Operations-Governance-Manual-v1.2.md`
- `companion/03-Reserved-Actions-Register-v1.0.md`
- `companion/04-PACE-Role-Matrix-v1.0.md`
- `companion/05-Prompt-Author-Template-v1.0.md`
- `companion/06-Auditor-Verdict-Format-v1.0.md`
- `assessment/07-Agent-Assessment-Final-Report-v1.1.md`
- `assessment/08-Formal-Response-to-Agent-Feedback-v1.1.md`
- `assessment/09-Reformat-Test-Results.md`
- `data/10-pace-roster.json`
- `data/11-agent-capability-matrix.json`
- `data/12-reserved-actions.json`
- `data/13-change-log.json`
- `integration/15-CLAUDE-HANDOFF.md`
- `agents/16-M365-profile-update.md`
- `agents/17-Gemini-profile-update.md`
- `agents/18-ChatGPT-profile-update.md`
- `agents/19-Claude-profile-update.md`
- `assessment/20-Agent-Operating-Model-Review-2026-10-18.md` — Historical Claude original review; B-2 and §8 placement prompt superseded; advisory for this transition.
- `assessment/21-Agent-Operating-Model-Recheck-r1-2026-10-19.md` — Historical Claude advisory re-check r1; withdraws B-2.
- `assessment/22-Agent-Operating-Model-Recheck-r2-2026-10-19.md` — Historical Claude advisory re-check r2; source corrections, no clearance.
- `assessment/23-Agent-Operating-Model-DeepSeek-Review-2026-10-19.txt` — Historical supplied DeepSeek advisory review; original not independently available; no formal audit authority.
- `assessment/24-Agent-Operating-Model-Recheck-r3-2026-10-19.txt` — Historical Claude advisory r3; G-1–G-12 source, no clearance of this revision.
- `integration/25-Agent-Operating-Model-Integration-2026-10-19.md` — integration and transition record, with the verbatim original A–I request as historical evidence; authority remains AGENTS.md.

---

## 16. Change Log

| Version | Date               | Change                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | September 2026     | Initial AGENTS.md                                                                                                                                                                                                                                                                                                                                                                                        |
| 1.1     | September 25, 2026 | §3.3 Execution authority added; §10.1 filing authority amended; §10 Working Practice expanded                                                                                                                                                                                                                                                                                                            |
| 1.2     | October 1, 2026    | Sections 11–16 added: Reserved Actions three-tier model, Data Handling classification, Agent Discipline rules, PACE Role Matrix reference, Systems of Record, Change Log. Document Writer (Content) Primary and Prompt Author Primary reassigned to Claude Desktop. M365 removed from content-production roles. Gemini exclusion confirmed.                                                              |
| 1.2     | October 5, 2026    | Amendment within v1.2: §5 states the accepted branch prefixes (#146 Finding D) and the procedure for review findings after a merge (#146 Finding E).                                                                                                                                                                                                                                                     |
| 1.2     | October 5, 2026    | Amendment within v1.2 (WU-004): §4 states how CI runs gate 5: in four shards, and not for pull requests into `develop` that change only documentation files.                                                                                                                                                                                                                                             |
| 1.2     | October 5, 2026    | Amendment within v1.2 (#157): §3.1 authorizes billable work units through a ledger until 2026-11-05: named script and lane, caps checked before each request, a reserve-before-start spend ledger, Vertex AI only, and a credit stop line; §3.3's reserved billable call is narrowed to calls no ledger entry covers.                                                                                    |
| 1.2     | October 13, 2026   | Amendment within v1.2 (#185): §3.1 ledger entry for P-11, the assisted-library-entry probe: Principal Operator lane, 40 requests, $6, per-title results outside the repository.                                                                                                                                                                                                                          |
| 1.2     | October 13, 2026   | Amendment within v1.2 (#192): §3.1 ledger entry for P-11 on Gemini 3.8 Flash at the global endpoint: Principal Operator lane, 40 requests, $12, per-title results outside the repository.                                                                                                                                                                                                                |
| 1.2     | October 13, 2026   | Amendment within v1.2 (#158, WU-029): §3.1 ledger entry for the catalogue enrichment script on Gemini 3.1 Flash-Lite at the global endpoint: Principal Operator lane, 200,000 requests, $160, generated drafts outside the repository.                                                                                                                                                                   |
| 1.2     | October 14, 2026   | Amendment within v1.2 (#199, WU-032): §3.1 condition 5 gains the admission rule for an embeddings `predict` request; a ledger entry for the description embeddings on text-embedding-005 in us-central1 (Principal Operator lane, 3,000 requests, $5, vectors outside the repository), gated on the accepted description sample check.                                                                   |
| 1.2     | October 17, 2026   | Amendment within v1.2 (WU-034L, #207 and #208): adds Principal Operator ledger entries for review-only promoted-description checks (JDG, 12,000 attempts/$110) and separate title/friction/genre embeddings (EMB-2, 8,000 attempts/$5), with exact mode admission and kind-specific generated-text acceptance; retains all existing entries, the $275 window total, $20 stop line and 2026-11-06 expiry. |
| 1.2     | October 20, 2026   | Amendment authored for #139, AI-070: writing/audit and implementer PACE changes; Role 17 code/security review; §3.2 grants no spending; explicit model selection and provenance; named correlation exceptions by the §16 adoption mechanism. Role 13 preserved. Antigravity’s former Frontend Emergency slot (conditional on browser automation) is removed. Historical assessment rows remain evidence. |

### Operating-model amendment: adoption and transition

The adoption mechanism is the operator’s adoption comment on governance issue #139, posted before merge and citing the SHA-256 of the final authoritative `edit-blocks.json`. The comment explicitly adopts option (b), every changed PACE assignment, and every named correlated-failure exception in 04 §3. The operator-approved merge of that issue’s PR into `develop` makes this amendment effective only when the required pre-merge comment exists; the comment alone grants no authority.

Effective through the ordinary route only at an operator merge into `develop` following the adoption mechanism in AGENTS.md §16. The operator records the adoption comment, merge SHA and evaluation end date on issue #139 (work ID AI-070).

**AI-070 sequencing correction (specific to PR #213):** PR #213 was merged into `develop` on 2026-10-20 at 17:47:01 UTC (merge commit `9764e11fc82251b81e4441e07fcc19bf9981470c`) without the required prior operator adoption comment on issue #139. The operator subsequently confirmed that no adoption comment had been posted; issue #139 remained open and had no comments when checked. Thus that merge placed the amendment text but did **not** satisfy the §16 adoption sequence or activate the revised operating model. The ordinary pre-merge rule above remains unchanged for all other amendments. For this specific corrective sequence, the operator must post a truthful, prospective adoption comment on issue #139 citing the received corrective authoritative edit-blocks SHA-256 and explicitly adopting option (b), every changed PACE assignment, and each named correlated-failure exception in 04 §3. **Only after** that comment and the required independent review, formal document audit and gates may the operator merge the separately reviewed corrective PR into `develop`. **That later corrective merge, not PR #213, completes activation** for AI-070. Neither this text nor the comment alone activates assignments or grants reserved authority. Record the actual comment URL, corrective PR and head, corrective merge SHA/time, and evaluation end date on issue #139; do not backdate any of them.

The transition uses the rules in force before this amendment: Cline × ChatGPT Subscription mechanically places at current Role 13 C; Claude Code performs the formal document audit of the placed head at current Role 14 E; Codex performs the existing §5 `/review`; the operator merges. Neither the new assignments nor the adoption comment authorizes that transition. Claude Desktop and DeepSeek input is advisory. The withdrawn B-2 exception and the original review’s §8 Claude Code placement prompt supply no authority. The operator must decide the retained-source authorship/reviewer question from the provenance table before this transition can be relied on.

Evaluate from the activating merge timestamp (for AI-070, the later operator-controlled corrective merge specified above, not PR #213) through that timestamp + 14 days. Record the adoption comment, merge SHA and evaluation end date on the governance issue. Review throughput, correction rounds, gate results, allowance use, attributable authorized charges, operator intervention, and blocked-work duration/cause at day 7 and day 14. At day 14 the operator records retain, revise or revert; absent a decision, assignments continue until amended. Spending or independence violations stop the affected route. Promotion to `main` remains a separate operator action; a lane using `main` must obtain the effective governance revision first. Reviews made after activation use the new rule, including re-review of stale open PRs, except this transition PR follows the pre-amendment review throughout.

When the shared Claude allowance is exhausted, Role 14 Primary and Emergency fail together, and option-(b) WUD authoring stops. New work that needs either service waits. Work whose WUD is already authored and validly audited may proceed only while its implementation and review lanes remain eligible and available; an exhausted Claude Code review lane may use independent Codex review where permitted. When ChatGPT Plus is exhausted, the option-(b) Primary, the ChatGPT authorship precondition for the Claude Code fallback, and Role 17 Alternate fail. An existing ChatGPT-authored, validly audited WUD does not require fresh authorship solely because of that exhaustion, but still needs an available independent reviewer. No paid route is added. Record blocked-work duration and cause, including authoring, audit, implementation and review delays, on the governance issue as evaluation evidence.

Only the content author fills the conspicuous issue and work-ID tokens, as a new author revision requiring new post-format hashes and renewed review. The placer never fills them. Historical profile and capability statements remain dated assessment evidence; the dated addenda identify the operative changes. The integration record preserves the original A–I request and explains superseded transition instructions.

**Issue scope:** #139 (AI-070) remains open; this amendment advances only the Reviewer-role and selected correlated-failure/slot-metadata items. Baseline Justification, nine action-tier contradictions, remaining per-slot evidence, Specifier/Architect, complete change-log verification and no-P0/P1/P2 review remain subject to separate verification. The operator has selected #139, so no duplicate issue is filed. Codex and Claude must agree on the identical final placed head under the operator’s review arrangement; the formal document audit and all existing gates are additional requirements.

**End of AGENTS.md v1.2.**
