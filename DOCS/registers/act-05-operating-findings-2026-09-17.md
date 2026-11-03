# ACT-05 Operating Findings — 2026-09-17

## Scope

Record three operating findings that previously existed only in session
conversation. This register defines the adoption sequence and bounded work-unit
scope for each finding. No GitHub ruleset, secret, merge, application behavior, or
Work Unit D/E implementation is changed by this record.

## Adoption sequence

### ACT-05-WU-01 — Stabilize required GitHub status-check contexts

**Finding:** Required status-check contexts have carried an event suffix in the
GitHub working context, while earlier configuration attempts used the wrong form
three separate times: first job IDs instead of display names, then display names
without the event suffix, and then the event-suffixed working context.

**Observed context forms:**

- Workflow job display names: `Lint & Test`; `Playwright E2E Suite`.
- Ruleset API context values observed by this agent:
  `Pull Request Validation / Lint & Test` and
  `Pull Request Validation / Playwright E2E Suite`.
- Principal-Operator-reported GitHub working contexts:
  `Pull Request Validation / Lint & Test (pull_request)` and
  `Pull Request Validation / Playwright E2E Suite (pull_request)`.

**Bounded scope:** Review and, after approval, restrict
`.github/workflows/pull-request-validation.yml` to the intended `pull_request`
event configuration so the required contexts remain stable. Re-verify the actual
check-run names and ruleset-required contexts after the workflow change. Do not
edit rulesets as part of this work unit.

**Acceptance criteria:**

1. The workflow trigger configuration contains only the approved event and branch
   scope.
2. The two resulting check contexts are recorded exactly as GitHub presents them.
3. The ruleset API and observed check-run context forms are reconciled in the tool
   register.
4. No job-ID context or context-without-event-suffix assumption remains in the operating
   documentation.

**Approval boundary:** Documentation and workflow scope only. Ruleset mutation,
branch-protection changes, and merge remain outside this work-unit authorization.

### ACT-05-WU-02 — Remove unreachable and unused `MCP_DOCKER`

**Finding:** `MCP_DOCKER` is configured, unreachable, and unused. It fails to
connect during sessions, appears in no active role profile, and is already
classified as `neverEnabled` in the repository-owned role-profile document. It is a
removal candidate under the tool-removal criteria.

**Bounded scope:** Locate and remove stale `MCP_DOCKER` configuration references,
then verify that the active MCP configuration, role profiles, and tool register no
longer present it as an available configured server. Preserve the existing
infrastructure-disabled-by-default policy and do not provision replacement
infrastructure.

**Acceptance criteria:**

1. No active MCP configuration contains an enabled or connect-attempting
   `MCP_DOCKER` entry.
2. No role profile lists `MCP_DOCKER` as enabled or conditional.
3. The removal disposition and verification evidence are recorded in the tool
   register.
4. No credential values, infrastructure resources, or unrelated MCP entries are
   changed.

**Approval boundary:** Local configuration/documentation removal only. Secret
changes, infrastructure provisioning, and provider-side actions remain
Principal-Operator-owned.

### ACT-05-WU-03 — Decide authority for the environment-dependent E2E gate

**Finding:** The canonical gate chain is environment-dependent. The full E2E suite
has passed reliably in CI, including two green runs of approximately 18 minutes,
while local runs fail roughly half the time at
`test/e2e/rate-limiting.spec.ts:74:7` with `ECONNRESET`. Because the local chain
cannot reliably produce green E2E evidence, the current guard blocks every branch
from pushing when the local transport failure occurs.

**Decision required:** Principal Operator decision. This register does not
recommend a direction.

**Option A — CI-authoritative E2E:** Make the CI E2E check authoritative for the
E2E portion of the gate. The local chain would remain authoritative for doctor,
TypeScript, client syntax, spelling, unit tests, and security/quality gates. The
push guard and evidence record would change so local E2E is diagnostic/non-
authoritative, while a successful required CI E2E check is the authoritative E2E
evidence.

**Option B — Local-authoritative E2E:** Keep the local E2E suite as required gate
evidence. No guard or evidence-policy relaxation would occur. Branches would
continue to be blocked whenever local transport instability prevents a green
canonical chain, even when CI passes.

**Option C — Temporary dual-evidence policy:** Require successful CI E2E evidence
and record the local E2E result as explicitly labeled diagnostic evidence while
the transport issue remains unresolved. The guard and evidence record would change
to distinguish authoritative CI E2E from local diagnostic execution; a failed local
diagnostic run would not be represented as a green local gate.

**Acceptance criteria:**

1. The Principal Operator records one selected option and its effective date.
2. The selected policy defines which environment is authoritative for E2E.
3. The push guard, required checks, and evidence record are updated only under a
   separately approved implementation work unit.
4. No retry, assertion weakening, test disabling, or Work Unit D modification is
   used to manufacture local green evidence.

**Approval boundary:** Decision and policy only. This entry authorizes no ruleset,
guard, evidence-schema, workflow, or test implementation.

#### Principal Operator decision — recorded 2026-09-17

**Selected option:** **Option A — CI-authoritative E2E.**

The Principal Operator decided that CI is authoritative for the end-to-end suite.
The local canonical chain covers environment doctor, TypeScript, client syntax,
spelling, unit tests, and the S1–S4 and Q1–Q5 security and quality gates. The local
chain will not run Playwright as part of its authoritative scope.

**Reasoning:**

- The operating plan already places server-side CI at the enforcement boundary and
  local guards as supplementary. The current arrangement inverts that relationship:
  a local guard blocks pushes on the strength of a suite that CI runs more reliably
  than the development machine does.
- CI has passed the full suite on every observed run at approximately eighteen
  minutes. Local execution fails approximately half the time on a transport error
  that has not been traced to the application, on a machine that also serves as the
  operator's work computer.
- A gate that fails half the time for environmental reasons is not reliably
  enforcing quality. It produces noise that must be worked around, and work-around
  behavior creates pressure to bypass the gate.

**Accepted trade-off:** An end-to-end regression may surface after push rather than
before it. For a single operator pushing to a protected branch that requires the CI
check, this is a delay of minutes rather than an escaped defect.

**Explicit non-resolution:** This decision does not resolve the local transport
failure. ACT-05-WU-03 remains open as a lower-priority investigation and is
reclassified from **blocking** to **diagnostic**. The reclassification must not be
read as evidence that the `ECONNRESET` cause has been fixed.

**Implementation reference:** The approved implementation is specified in
`DOCS/specs/ACT-05-WU-05-ci-authoritative-e2e-split.md`. No implementation is
authorized by this decision record alone.

### ACT-05-WU-04 extension — Fresh-worktree equivalence findings

The worktree-environment investigation now records five independent ways a fresh
worktree can be silently non-equivalent to the established development worktree:

1. **No Doppler scope:** a fresh worktree has no local Doppler project/config
   binding, so commands that require injected runtime configuration cannot run
   correctly.
2. **Empty database:** a fresh worktree can use a database with
   `ownershipRows=0` and `lastAudit=none`; data-dependent checks and the
   `dist/**` bundle check can then be skipped or vacuous while the chain still
   appears successful.
3. **Missing dependencies:** a fresh worktree has no `node_modules`, so the unit
   gate can fail with `vitest is not recognized` even though the source and lockfile
   are correct.
4. **Branch-prefix rejection:** `scripts/doctor.js` accepts only `feature/*`,
   `fix/*`, and `hotfix/*` branch prefixes. A documentation branch must therefore
   use an accepted `fix/*` name to pass the current doctor.
5. **Missing setup verification:** there is no single setup command that prepares
   all of the above prerequisites and verifies the resulting worktree before the
   canonical gate is attempted. The operator currently discovers failures one at a
   time through later gate execution.

These five traps each cost time during the current worktree sequence. They should
be treated as one setup-contract problem rather than five unrelated doctor checks.
The proposed solution is specified in
`DOCS/specs/ACT-05-WU-04-gate-evidence-environment-contract.md`.

## Cross-cutting constraints

- The canonical local E2E chain is not rerun as part of this documentation record.
- Work Units D and E remain not started.
- No rulesets, secrets, merges, or production resources are changed.
- Any implementation arising from these findings requires its own reviewed work
  unit and gate evidence.
