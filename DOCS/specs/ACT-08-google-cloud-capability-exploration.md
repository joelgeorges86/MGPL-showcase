# ACT-08 — Google Cloud and Gemini Capability Exploration

**Status:** SPECIFIED — awaiting Principal Operator approval
**Owner:** Researcher role (Gemini via Vertex AI), Principal Operator approval per phase
**Date:** 2026-09-17
**Supersedes:** nothing. Extends ACT-07, which remains the approval gate for cloud model routing and object-storage replication.

---

## Purpose

Establish what the Google Cloud and Gemini platform can actually do inside the MGPL environment, by executing each capability rather than reading about it, and record the result as dated evidence.

The intent is deliberately broad. Capabilities are probed whether or not they appear in the current operating plan, because a capability that is never tested cannot be evaluated and a capability that is never evaluated defaults to unused. Where a probe reveals something MGPL could use — now or later — it is recorded as a candidate with its cost, its dependencies, and what it would replace.

**Probe broadly. Adopt narrowly.** Execution of a probe is not adoption, and this work unit authorizes no production change.

---

## Evidence contract — governs every phase

Added 2026-09-18 after a Phase 0 attempt produced a complete inventory report containing fabricated command output.

**What happened.** An agent operating in plan mode, without terminal execution, was asked to run `gcloud` commands and read the billing console. It could do neither. Rather than reporting the limit, it generated plausibly formatted output for both and presented it under source attributions. The fabrication was detected only because the operator ran the same commands manually and compared: the report claimed 10 enabled APIs against an actual 48, named a project number that was not the project's, invented service-account identifiers built on that number, and reconciled an invented cost total by silently altering a figure supplied in the prompt.

Its own plan stated the intent — "simulate console inspection ... using the details provided in the prompt as the basis for the report" — before any of it was written. The simulation then extended to the command output as well.

This is rank-8 agent output presented as rank-1 executable evidence. The following rules apply to every probe, every phase, and every harness.

### 1. Raw output or nothing

Every figure in every ACT-08 artifact carries the **verbatim, unedited output** of the command that produced it, in a fenced block, with the exact command line above it. A summary, a table, or a restatement without the raw block is not evidence and is not accepted.

### 2. Unobtainable is UNVERIFIED, never generated

Where a figure cannot be obtained — the harness has no terminal, the console is unreachable, the API is not exposed, the mode forbids execution — the entry reads `UNVERIFIED — not obtainable from this harness` with a one-line reason. It is never filled in by inference, by arithmetic on figures supplied in the prompt, or by reproducing a plausible format.

**Reporting an inability is a successful outcome.** It establishes an effective-capability boundary per §2.3, which is one of the things this work unit exists to discover.

### 3. Declare the execution mode first

Before any probe, state: the harness, the model, the operating mode, whether terminal execution is available, and whether console access is available. If a requested step falls outside that, say so before running anything rather than after.

### 4. Label who executed

Every command output is marked as one of:

- **Agent-executed** — the agent ran it and the output is its verbatim return
- **Operator-executed** — the Principal Operator ran it and supplied the output
- **Not executed** — with the reason

A figure the agent did not obtain itself is never recorded as agent-executed.

### 5. Identifier cross-check

Every artifact records the project number, the billing account identifier, and the active service-account email, each traced to a specific command. These are the cheapest fabrication tripwire available: they are stable, unguessable, and a generated report gets them wrong.

### 6. No reconciliation by adjustment

Where two figures disagree, both are recorded with their sources and the discrepancy is named. A total is never made to balance by changing a component. The disagreement is the finding.

### 7. Fabrication is a stop condition

If any artifact is found to contain output that was not actually produced by the command it is attributed to, ACT-08 halts. The incident is recorded in the Harness Register against the specific route — model, harness, mode, tools — with the discrepancies named. It is a capability finding about that configuration, not a general statement about a vendor, and it bears directly on that route's suitability for the researcher role, which depends more than any other on truthful sourcing.

### 8. Specification defect acknowledged

The original Phase 0 instruction asked for console figures without saying what to do when the source is unreachable. That omission is recorded as a specification defect, not solely an agent failure. Every probe below now names its source and its unobtainable behaviour.

---

## Precondition — must close before any phase begins

**The billing account currently has no spending ceiling.**

Verified 2026-09-17: promotional credit $320.00; automatic payments active against a payment card with a $100 threshold; a budget alert configured at $20. An alert notifies. It does not stop a charge. On credit exhaustion, spending converts to the card automatically.

MGPL §9.2 requires a written monthly ceiling and a stop condition before any paid pilot starts. A notification is neither.

**Required before Phase 1:** one of —

- Remove the payment method from the billing account so exhaustion produces a hard stop, or
- Implement a budget-triggered billing-disable function, verified by a deliberate test.

The first is preferred: it is a single change, it fails closed, and it matches what §9.2 asks for. Record which was chosen, the date, and — if the second — the deliberate-failure test that proved it disables billing rather than merely reporting.

### Resolution — 2026-09-24

Neither allowed route was taken. The Principal Operator accepts the residual risk and
proceeds on a **procedural** ceiling, recorded here rather than left implicit.

**What is actually in place:**

- Budget `mgpl-phase-a-burn-watch`, $300.00, 2026-08-08 to 2026-11-11, alerting at 50%,
  75% and 90%. **Spend cap status: Not applicable** — this budget notifies, it does not
  stop a charge.
- Promotional credit $320.00 standing between any spend and the payment card.
- A payment card attached, with a $100 automatic-payment threshold.

**What this means:** there is no mechanical ceiling. If the credit is exhausted, spending
continues against the card. The only stop is a person noticing an alert and acting.

**The basis for accepting it:** estimated total ACT-08 spend is under half the credit; all
probe runs are attended; work stops when the operator stops for the day.

**The one mechanical control adopted:** P-8 (rate and quota under sustained load) carries a
hard request counter in the probe itself, not a wall-clock limit. It is the only probe whose
cost is not bounded by its own design. The cap used is recorded with its result.

**Revisit if any of these change:** an unattended or scheduled run is proposed; a probe is
added whose cost is not bounded by its own design; recorded spend passes $100; or Google
makes a spend cap available on this budget (the console now offers spend caps — this budget
reports them as not applicable, and that is worth re-checking).

This resolution supersedes the two-route requirement above **for ACT-08 only**. It does not
amend MGPL §9.2, which continues to require a written ceiling and a stop condition before any
paid pilot. The conflict between §9.2 and this resolution is recorded, not resolved, and is
carried to the 2026-10-22 governance review.

#### Source and discrepancies (evidence contract §4, §6)

- **Source.** The figures under "What is actually in place" are **Operator-supplied**,
  2026-09-24, from the console. They are not agent-verified: the CLI does not expose payment
  methods or credit balances, and `billingbudgets.googleapis.com` is not enabled on the
  project. See `DOCS/research/ACT-08-phase0-refresh-2026-09-24.md` §2.
- **Budget.** The 2026-09-17 record above describes "a budget alert configured at $20". This
  resolution describes a $300.00 budget alerting at 50%, 75% and 90%. Both are recorded. It is
  not established here whether they are the same budget changed, or two budgets.
- **Credit.** $320.00 here is the granted total. The 2026-09-18 Phase 0 inventory (console
  CSV) recorded $299.73 of $300.00 remaining on the Free Credit, plus two $10.00 grants.
  Neither figure is today's remaining balance.
- **Scope of this resolution.** It closes the spend precondition. It does **not** authorize an
  agent to issue billable calls. Under `AGENTS.md` §3 that remains Approval Required. The
  mechanism proposed for it (`DOCS/specs/AGENTS-md-amendment-authorized-probe-work-units.md`,
  §3.1 ledger) has not landed.
- **Superseded for agent spending, 2026-10-05 (#157).** From the merge of `AGENTS.md` §3.1,
  billable calls by agents are governed by §3.1, not by this resolution. This resolution's
  basis (attended runs, total spend under half the credit, revisit above $100) described
  the operator-run probes of September and no longer holds. The Principal Operator decided
  on 2026-10-05 to use the credit before it expires, through unattended agent runs within
  §3.1's caps: $275 to 2026-11-05, with a $20 stop line. The accepted residual risk is
  stated in §3.1: the billing export lags, and a card is on file. This specification grants
  no authority to execute.

---

## Phase 0 — Inventory (read-only, no spend)

Establish what the project can reach before probing anything.

- Enumerate enabled APIs on project `mgpl-508415`.
- Record the service account and ADC identity in use, and the IAM roles attached to each.
- Record region, quota ceilings (RPM, TPM), and any organization policy constraints.
- Record which APIs would require enabling, and what enabling each implies for cost and permission scope.
- Record the current credit balance and expiry, and re-confirm the payment guardrail chosen above.

**Output:** `docs/research/ACT-08-phase0-inventory.md`, under the evidence contract above.

**Explicitly not done in Phase 0:** enabling any API, creating any resource, or issuing any billable request.

### Phase 0 status as of 2026-09-18

Operator-executed, verbatim output held:

- Enabled API list — **48 services**, far broader than the documented architecture. BigQuery across seven APIs, Compute Engine, Cloud SQL, Datastore, Dataform, Dataplex, Analytics Hub, Notebooks, Text-to-Speech, Security Command Center, Model Armor, Edge Cache, and the Agent Registry set are all enabled and none corresponds to a documented MGPL need. Recorded as a default-enabled surface, not a configured one.
- IAM policy — `roles/owner` on the operator's user account; `roles/editor` on the default compute service account; service agents for Vertex AI, Compute, and Notebooks. **`roles/editor` on the default compute service account is the broadest non-owner role and is the primary blast radius.**
- Spanner instances — zero provisioned.

Still UNVERIFIED and requiring console access the current agent route does not have:

- Credit expiry dates for all three credit entries
- Whether the two $10 Developer Program entries are one-time grants or recurring
- Confirmation of payment-method removal as the console now reports it
- Spend to date by service, and whether it reconciles with the harness's own reported per-turn figures
- When and by what the Spanner API was enabled

These are operator-executed or explicitly deferred. They are not to be inferred.

---

## Phase 1 — Capability probes

Each probe is an isolated script under `scripts/probes/`, run under the secrets injector, producing a recorded result. No probe touches the live catalogue, the production database, production infrastructure, or any verified record.

Every probe records: what was executed, the exact model and endpoint, latency, token usage in and out, the cost charged, the result, and the date.

### Already passed (2026-09-17) — carry forward as evidence

| Probe                            | Result         | Note                                                               |
| -------------------------------- | -------------- | ------------------------------------------------------------------ |
| Inference and ADC authentication | PASS, 4,615 ms | Strict JSON returned; ADC discovered with no plaintext key on disk |
| Multimodal vision                | PASS, 7,103 ms | Ingested a base64 image, identified defects, produced triage steps |
| Search grounding                 | PASS, 2,310 ms | Returned a grounded result with citations                          |

Re-run each with token and cost recorded, since the original probes did not capture spend.

### New probes

**P-1 — Structured output under a repository schema.**
Constrain generation to one of MGPL's existing Zod schemas and confirm the response validates without post-processing. Tests whether generated catalogue data can be trusted to a schema rather than parsed defensively.
_Would enable:_ catalogue enrichment that fails closed on malformed output.

**P-2 — Context caching at repository scale.**
Submit a large, stable context (repository tree, rule files, schema authority) twice and measure the cost difference between the first and second call. Confirms whether the implicit cache discount applies at MGPL's actual context size, rather than accepting a published figure.
_Would enable:_ an evidence-based cost estimate for routing an implementation lane through Vertex.

**P-3 — Batch inference.**
Submit a batch of at least 100 records for enrichment against fixture data — never the live catalogue — and record throughput, latency, cost per record, and failure handling. Confirms the batch discount and whether partial failures are reported or silent.
_Would enable:_ AI-014 catalogue remediation at volume.

**P-4 — Embeddings over the game catalogue.**
Generate embeddings for a fixture subset of game titles and descriptions, and test semantic retrieval quality against a set of queries the current keyword search handles poorly.
_Would enable:_ semantic search and recommendation in MGPL itself — not a development tool but a product capability. This is the probe most likely to produce something the application uses rather than something the operator uses.

**P-5 — Code execution sandbox.**
Submit an analysis task requiring computation over supplied data and confirm the sandbox executes it, returning both the code and the result.
_Would enable:_ analysis that currently requires a local script, with the working shown.

**P-6 — Long-context drift audit.**
Submit the full governance document set plus the repository's rule files in a single call and ask for contradictions between them. Compare the findings against those produced by the three reviews conducted on 2026-09-17.
_Would enable:_ whole-corpus audit as a distinct review angle. Measured against a known result, so the probe has an answer key.

**P-7 — Gemini CLI as a terminal surface.**
Install and authenticate the CLI, and confirm what it exposes: file access, shell execution, tool calling, approval behaviour. Record it as a harness with the six factors of §2.3, not as a vendor claim.
_Would enable:_ a second research surface, or reveal that the SDK route is sufficient.

**P-8 — Rate and quota behaviour under sustained load.**
Issue sustained requests until throttling occurs. Record the ceiling, the error returned, and whether the client retries, degrades, or fails. Confirms what happens to a long-running agentic task at the quota boundary.
_Would enable:_ a realistic stop condition for any Vertex-routed work unit.

### Probes deliberately excluded from Phase 1

These reach real infrastructure or real data and require their own approval:

- Object-storage replication to GCS — remains ACT-07, and the restore drill has never run against the two existing targets. A third destination before proving restoration on the first two adds a backup that has not been shown to restore.
- Routing an implementation lane through Vertex — cloud model routing, excluded by §22.1. P-2 and P-8 produce the evidence that would inform that decision; they do not authorize it.
- Any write to the live catalogue, the production database, or any verified record.
- Container mirroring, hosted compute, managed databases, or scheduled cloud jobs. None addresses a current MGPL need, and each adds a credential and a running cost.

---

## Phase 2 — Evaluation

For each probe that passed, record:

- **What it does that MGPL cannot currently do**, or does better than the current route.
- **Cost at MGPL's actual volume**, from the probe's measured figures, not from published rates.
- **Post-credit cost**, since promotional credit expires and the capability must survive it.
- **What it would replace.** A capability that duplicates an existing route without measurable improvement is rejected under §19.5 rather than added alongside.
- **Credential and permission footprint**, and what a compromised session could reach through it.
- **Failure behaviour** — what happens when it is unavailable, throttled, or returns malformed output.

A probe that passes but has no MGPL use is recorded as VERIFIED and unadopted. That is a valid outcome and should not be argued away; knowing a capability exists and is not needed is worth the probe.

---

## Phase 3 — Adoption proposals

Each capability that earns adoption gets its own work unit with its own acceptance criteria and its own approval. They are not adopted as a set.

Adoption of anything in this list remains subject to §22.1: no cloud provisioning, no cloud model routing, no object-storage replication, no new subscription or connector, without a recorded Principal Operator decision.

---

## Acceptance criteria

1. The payment guardrail is closed and recorded before Phase 1 begins.
2. Phase 0 inventory exists with a dated source for every figure.
3. Every probe in Phase 1 has been executed or explicitly deferred with a reason.
4. Every probe result records model, endpoint, latency, tokens, cost, and date.
5. Total spend across ACT-08 is recorded and drawn from promotional credit with no card charge.
6. Phase 2 evaluation names, for each capability, what it replaces or why it is unadopted.
7. No production data, infrastructure, credential, or verified record was changed.
8. Capability claims are recorded per §2.3 as a combination of model, harness, tools, authorization, environment and mode — never as a vendor-level assertion.
9. The Harness and Tool registers carry a dated line for every route exercised.

---

## Stop conditions

- Any charge against the payment card. Stop immediately and report.
- Any condition in `AGENTS.md` §3.1 failing, including the credit stop line and an unexplained reconciliation difference. Do not start a run, or stop the one in progress. (Replaces the earlier $100 line, 2026-10-05, #157.)
- Any probe that would write outside the output location its §3.1 ledger entry names, other than the spend-ledger appends §3.1 requires. Stop and escalate rather than adjusting scope.
- Two failed attempts at the same probe. Diagnostic handoff, not a third attempt.

---

## Non-goals

- This work unit does not adopt any capability.
- It does not authorize cloud provisioning, model routing, or replication.
- It does not change the role assignments in Section 6.
- It does not treat a passing probe as a reason to use a capability MGPL does not need.

---

## Recording

Evidence: `docs/research/ACT-08-*` per phase.
Registers: Harness Register for each route exercised; Tool Qualification Register for each CLI, SDK or server installed; Entitlement Register for credit balance, expiry and observed spend.

Every figure carries the date it was read and the command or console page it came from.
