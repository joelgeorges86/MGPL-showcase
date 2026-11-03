# ACT-05-WU-05 — CI-Authoritative E2E Split

## Status

Implementation specification only. No runner, guard, workflow, ruleset, evidence,
test, or policy file is changed by this specification.

## Decision basis

The Principal Operator selected **Option A — CI-authoritative E2E** for
ACT-05-WU-03 on September 17, 2026. The decision is recorded in
`DOCS/registers/act-05-operating-findings-2026-09-17.md`.

CI is the enforcement boundary for Playwright E2E. The local canonical chain is a
supplementary pre-push validation chain for all non-E2E gates. The local transport
failure remains unresolved diagnostic work under ACT-05-WU-03.

## Known sequencing circularity

This combined implementation work unit is what makes Work Units D and E eligible to
land:
once the approved split is implemented, the local canonical chain will no longer
launch the unreliable local Playwright suite. However, the documentation branch
itself must land before that implementation work begins, and the current canonical
chain still launches Playwright and still fails approximately half the time at
`test/e2e/rate-limiting.spec.ts:74:7` with `ECONNRESET`.

This is a known sequencing circularity, not a reason to weaken the current gate or
to begin implementation before approval. Resolve it by retrying the canonical chain
up to four times when the only failure is the known rate-limit transport error, as
was done for the runner-reconciliation work. A first failure at that exact known
location is diagnostic and retryable; it is not, by itself, a terminal failure for
the documentation branch. Any other failure remains a stop condition and must be
reported without being worked around.

The documentation branch must still produce a valid green evidence record from the
current runner before push. The evidence record belongs to this documentation
commit and does not authorize implementation of the combined work unit.

## Target ownership model

### Local canonical chain

The local canonical chain owns and executes:

1. Environment doctor.
2. TypeScript verification.
3. Client JavaScript syntax validation.
4. Spelling validation.
5. Unit tests.
6. S1–S4 security gates and Q1–Q5 quality gates through `gates/run-all.sh`.

The local chain does **not** launch a browser and does **not** execute Playwright
E2E. It must complete without starting the Playwright web server or browser.

### CI validation boundary

The pull-request workflow remains responsible for both required contexts:

- `Pull Request Validation / Lint & Test (pull_request)`
- `Pull Request Validation / Playwright E2E Suite (pull_request)`

The CI E2E context remains required by the existing branch rulesets. Branch rulesets
are unchanged by this work unit. A pull request cannot merge unless the required CI
E2E context passes.

## Required implementation changes

### 1. Remove Playwright from the local runner

Update:

```text
.agents/skills/mgpl-gate-runner/scripts/run-gates.ps1
```

to remove the local `Playwright E2E` invocation and any local-only prerequisites
whose sole purpose is starting or validating the Playwright server, while retaining
the local environment doctor, types, client syntax, spelling, unit, and security /
quality stages.

The local runner must continue to stop on the first failed local gate and must
record the local-scope result only after all local-owned stages pass.

### 2. Align the guard's required-gate list

Update:

```text
scripts/mgpl-gate-guard.js
```

so its required-gate list drops `Playwright E2E`. The local evidence record must
not claim an E2E result that the local chain did not produce. This is the same
evidence-integrity failure class documented in
`DOCS/specs/ACT-05-WU-04-gate-evidence-environment-contract.md`.

The guard must continue to reject evidence when:

- the evidence status is not passed;
- the commit does not match `HEAD`;
- the runner hash does not match;
- the local gate list does not match the local runner;
- the worktree is dirty;
- the chain identifier or scope is absent or inconsistent.

### 3. Coordinate the evidence-schema change

The evidence record must gain a field identifying the producing chain, for example
an approved `chainScope` or equivalent field with a value such as `local-scope`.
The final field name and schema shape must be selected in coordination with
ACT-05-WU-04.

This work unit must **not** introduce a second, conflicting schema version. The
implementation must use the schema evolution and environment-contract design
approved for ACT-05-WU-04, including its planned provenance fields and standing
evidence-integrity review.

The approved migration policy is **invalidate prior versions**. Once the new
verifier lands, existing schema-version-1 evidence is invalid for push
authorization. Historical copies may remain available for audit, but they cannot
satisfy the new guard. The first push after the change must run the updated chain
and record fresh evidence; this expected re-run must be documented and must not be
reported as an unexplained migration fault.

Because `.mgpl/gate-evidence.json` is gitignored and worktree-local, no migration
code is required. Each worktree naturally replaces its old version-1 file when the
new chain records fresh evidence. The implementation must nevertheless make the
verifier reject old records and make the guard explain the cause with a specific
message equivalent to:

> Gate evidence schema version is no longer accepted; re-run the canonical chain to
> record fresh evidence before pushing.

Historical records outside the ignored path remain audit-only and invalid for push
authorization.

At minimum, a local record must be distinguishable from full CI coverage and must
not be interpreted as evidence that Playwright passed. The evidence verifier must
know which chain produced the record and which gates that chain is permitted to
claim.

### 4. Update gate-runner consistency checks

Update:

```text
scripts/check-gate-runner-consistency.js
```

to assert the new ownership model rather than the current local-Playwright model.
The consistency check must verify all of the following:

- the local PowerShell runner does not invoke Playwright;
- the local PowerShell runner invokes every local-owned gate exactly as specified;
- `gates/run-all.sh` does not invoke Playwright;
- the pull-request workflow still runs the CI E2E job exactly once;
- the pull-request workflow still runs `gates/run-all.sh` exactly once in its
  non-E2E job;
- the local guard gate list matches the local runner's ownership;
- the documentation describes the same local/CI ownership split.

The test must fail if Playwright is reintroduced into the local runner. It must not
pass vacuously merely because Playwright text was removed from one file. The negative
assertion must be paired with positive assertions that the CI workflow still owns
and executes the E2E job.

### 5. Update operating documentation

Update these files in the implementation work unit:

```text
.agents/skills/mgpl-gate-runner/SKILL.md
AGENTS.md
DOCS/TEST_INVENTORY.md
```

They must state that:

- local gates are supplementary and non-E2E;
- CI is authoritative for Playwright E2E;
- the two required PR contexts remain required;
- local gate evidence identifies its limited chain scope;
- a local green record does not represent full coverage;
- a pull request remains unmergeable until the CI E2E context passes.

Any conflicting statement in `.clinerules/04-definition-of-done.md` or other
authoritative gate documentation must be identified and handled in the same
approved implementation work unit; documentation must not silently disagree about
whether local E2E is mandatory.

### 6. Preserve branch rulesets and CI behavior

Do not change repository rulesets, required contexts, branch protection, or merge
policy. Do not remove the CI E2E job. Do not weaken the CI E2E assertions or add
retries to conceal failures.

The intended result is an ownership split, not removal of E2E enforcement:

```text
local: doctor + types + client syntax + spelling + unit + S1-S4/Q1-Q5
CI:    lint-test equivalent + Playwright E2E required context
```

## Acceptance criteria

1. The local canonical chain completes without launching a browser or starting the
   Playwright web server.
2. A local evidence record identifies itself as local-scope using the coordinated
   ACT-05-WU-04 evidence schema.
3. The guard permits a push when the local-scope evidence is valid for the local
   chain and the worktree is clean.
4. The local guard does not claim that Playwright E2E passed.
5. The guard rejects prior-version evidence with the specific re-run instruction
   rather than a generic verification failure.
6. The first post-change push succeeds only after fresh evidence is recorded by the
   updated chain.
7. No migration code is required for the ignored worktree-local evidence file.
8. The consistency check passes against the new local/CI arrangement.
9. The consistency check fails if Playwright is reintroduced to the local runner.
10. The consistency check fails if the CI workflow no longer owns or runs the E2E
    job.
11. Both required CI contexts remain represented and required by the existing
    rulesets.
12. A pull request still cannot merge without the CI Playwright E2E check passing.
13. `SKILL.md`, `AGENTS.md`, `DOCS/TEST_INVENTORY.md`, the local runner, guard,
    evidence verifier, and consistency check describe one coherent ownership model.
14. The implementation does not claim that the local transport failure is fixed;
    ACT-05-WU-03 remains labeled diagnostic and open.

## Schema coordination and landing order

ACT-05-WU-04 should land **first**, or the two specifications should be combined
into one implementation work unit with ACT-05-WU-04 as the schema authority.

The preferred arrangement is a **single coordinated implementation work unit** for
the evidence changes, because both specifications modify the same evidence schema,
guard, verifier, and recorded-evidence compatibility boundary. Splitting them into
independent implementation PRs risks two incompatible schema versions or a period
where the guard writes evidence that the verifier cannot interpret.

If operational sequencing requires separate PRs, ACT-05-WU-04 must land first and
define the versioned schema, provenance fields, migration/grandfathering policy,
and verifier contract. ACT-05-WU-05 may then consume that schema by adding the
chain-scope value and local/CI ownership semantics. ACT-05-WU-05 must not invent a
parallel schema version or field naming convention.

## Non-goals

- Do not resolve the local `ECONNRESET` transport failure in this work unit.
- Do not disable, skip, weaken, or retry the Playwright E2E test in CI.
- Do not change branch rulesets or required check contexts.
- Do not merge, push, or alter production infrastructure.
- Do not make local evidence appear to be full canonical coverage.
- Do not modify Work Unit D or Work Unit E.

## Approval boundary

This specification authorizes no implementation by itself. A separate reviewed
implementation work unit must coordinate the ACT-05-WU-04 evidence-schema changes,
the local runner/guard changes, documentation updates, consistency-check updates,
tests, and migration handling before any code or policy file is modified.
