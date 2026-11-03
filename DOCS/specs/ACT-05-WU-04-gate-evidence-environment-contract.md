# ACT-05-WU-04 — Gate Evidence Environment Contract

## Status

Specification only. Implementation is not included in this work unit.

## Finding

Two worktree-environment traps currently allow materially different verification
conditions to produce indistinguishable gate evidence:

1. A new worktree has no Doppler scope. It can appear structurally ready while the
   gate chain cannot receive the required Doppler-injected runtime environment.
2. A fresh worktree has an empty database. The chain can still proceed with
   `ownershipRows=0`, `lastAudit=none`, and a `dist/**` bundle check that is skipped
   or vacuous rather than exercised against a populated dataset.

The current doctor checks the local Doppler project/config binding, but does not
prove that the current gate process received the required injected environment. It
also does not validate the effective database identity or dataset state.

The worktree investigation now identifies five setup traps that can leave a fresh
worktree silently non-equivalent to the established development worktree:

1. missing Doppler scope;
2. an empty database with `ownershipRows=0` and `lastAudit=none`;
3. missing `node_modules`, causing `vitest is not recognized`;
4. a branch name outside the doctor's accepted `feature/*`, `fix/*`, or `hotfix/*`
   prefixes; and
5. the absence of one setup command that prepares and verifies all prerequisites
   before the gate chain begins.

The current gate evidence records commit, runner hash, gate list, timestamp,
harness, model, and pass status. It does not record environment provenance,
effective database identity, dataset state, ownership-row count, audit freshness,
or whether bundle verification was meaningful against populated data.

As a result, two green evidence records can attest to materially different things:
one may represent a populated database with meaningful data-dependent checks,
while another may represent an empty database where those checks were vacuous.

## Precedent and control failure class

This is not an isolated database-reporting problem. The gate list previously named a
gate that the canonical runner did not execute. That earlier defect allowed the
evidence record to attest to more verification than the runner actually performed.
The empty-database and missing-Doppler conditions are the same class of failure:
the evidence surface can claim more scope or verification quality than was actually
established.

The remedy must therefore be a standing evidence-integrity control, not only a
one-time addition of fields. The evidence field set, gate list, runner behavior,
and environment contract must be reviewed together whenever a gate is added,
removed, renamed, split, made conditional, or changed from local to CI authority.

## Proposed changes

### 1. Define an explicit environment contract

Specify the minimum environment required for each gate class, including:

- whether the process must run through Doppler injection;
- required non-secret runtime-variable presence;
- effective database path/classification;
- schema readiness;
- required seed/population conditions;
- whether `dist/**` validation is applicable and must execute;
- local versus CI authority.

The contract must distinguish “Doppler CLI is configured” from “the current
process received Doppler-injected environment.” It must not print secret values.

### 2. Extend the doctor contract

Add checks that safely report:

- runtime injection provenance without exposing values;
- effective database path classification;
- database existence and readability;
- schema readiness;
- dataset state, including ownership-row count and audit-timestamp presence;
- whether the active database is empty, populated, or otherwise unsuitable for
  the selected gate class.

The doctor must fail or clearly classify an environment that cannot satisfy the
selected canonical gate contract. It must not silently downgrade a populated-data
verification to an empty-data verification.

### 3. Extend and version gate evidence

Increment the evidence schema and add safe, deterministic provenance fields such as:

- execution environment (`local` or `ci`);
- injection status/classification;
- effective database classification and fingerprint;
- dataset state;
- ownership-row count;
- audit freshness/presence;
- bundle-check execution status and measured result;
- gate authority classification where local and CI responsibilities differ.

The evidence verifier must validate the new fields, reject missing required fields,
and reject evidence whose environment contract does not match the gates claimed as
passed.

#### Evidence migration policy — invalidate prior versions

The Principal Operator selected **Option A — invalidate** for prior-version
evidence. Once the new verifier and evidence schema land, schema-version-1 evidence
is no longer valid for push authorization. Historical version-1 records may be
retained for audit and investigation, but they cannot satisfy the new guard.

This policy is intentional. Version-1 records cannot distinguish an empty-database
run from a populated-database run or a local-scope chain from full coverage. The
schema change exists to add those distinctions; grandfathering version-1 records
would accept evidence that provably lacks the fields introduced by the fix, allowing
the defect to survive its own correction.

The first push after the verifier/schema change therefore requires a fresh chain
run and a newly recorded evidence file. This is expected behavior, not a migration
fault: the old ignored worktree-local record is rejected, the updated chain is run,
and the successful run overwrites it with the new schema.

The guard's rejection must name the cause plainly, using wording equivalent to:

> Gate evidence schema version is no longer accepted; re-run the canonical chain to
> record fresh evidence before pushing.

It must not collapse this condition into a generic verification failure.

No migration code or repository-wide evidence-file migration is required because
`.mgpl/gate-evidence.json` is gitignored and worktree-local. Existing version-1
files are naturally replaced when each worktree records fresh evidence on its next
successful run. Any retained copies outside the ignored path are historical audit
artifacts only and remain invalid for push authorization.

### 4. Bind the gate list to actual runner execution

Maintain one authoritative mapping between named gates and the commands that execute
them. The consistency check must prove both directions:

- every named gate is executed by the runner; and
- every blocking runner stage is represented in the evidence record.

This prevents a gate from being named without execution and prevents an executed
blocking stage from being omitted from the evidence.

### 5. Make empty-data behavior explicit

Define whether an empty database is:

- blocking for the canonical gate;
- permitted only for a specifically labeled structural/smoke gate; or
- permitted with a separate non-authoritative evidence classification.

Whichever policy is approved, an empty-data run must not be represented as
equivalent to a populated-data run.

### 6. Establish standing review of the evidence field set

Require a reviewed evidence-contract update whenever any of the following changes:

- the canonical gate list;
- runner command order or coverage;
- local/CI authority;
- database seeding or fixture policy;
- bundle/dist validation behavior;
- doctor prerequisites;
- evidence schema fields or verifier rules.

The review artifact should state what was executed, what was merely configured, and
what the recorded evidence is permitted to claim.

## Proposed setup command

Create a single operator-facing setup script:

```text
scripts/setup-worktree.ps1
```

This specification does not implement the script. Its purpose is to produce a
correct, gate-ready worktree before `run-gates.ps1` is invoked, rather than relying
on a later doctor failure to reveal one missing prerequisite at a time.

### Required setup sequence

The script should perform these bounded steps in order:

1. **Repository and branch inspection**
   - Confirm the repository root and required files.
   - Read the current branch name.
   - Confirm that the branch uses an accepted prefix, or fail with a precise
     remediation message naming the accepted prefixes.
   - Do not rename branches silently.
2. **Doppler binding**
   - Confirm the Doppler CLI is available.
   - Confirm the local worktree is bound to the `mgpl` project and a `dev` config.
   - If the worktree has no binding, run the approved non-secret setup command or
     stop with the exact command the operator must run.
   - Never print secret values.
3. **Dependency installation**
   - Confirm `package.json` and `package-lock.json` are present.
   - Run the repository-approved deterministic dependency installation command when
     `node_modules` is absent or incomplete.
   - Verify that the required local executables, including Vitest, are resolvable
     after installation.
4. **Database state report**
   - Resolve the effective database path using the same rules as the application and
     gate process.
   - Report only safe metadata: existence, path classification, schema readiness,
     ownership-row count, audit-timestamp presence, and whether the database is
     empty or populated.
   - Report whether `dist/**` exists and whether the bundle check can be meaningful.
   - Do not mutate or seed production data.
5. **Final verification**
   - Re-run the branch, Doppler, dependency, executable, and database checks after
     setup.
   - Emit a concise machine-readable or stable human-readable result that the gate
     runner can consume or that the operator can attach to the evidence record.
   - Exit nonzero if the worktree is not ready for the selected gate contract.

### Setup-script acceptance criteria

1. A fresh worktree without Doppler scope is either bound through the approved
   non-secret setup path or fails before the canonical gate begins.
2. A fresh worktree without `node_modules` installs dependencies and verifies that
   Vitest and other required commands resolve.
3. An unacceptable branch prefix is reported before any gate is attempted.
4. Database state is reported as empty, populated, missing, or unsuitable rather
   than being silently treated as equivalent.
5. `dist/**` presence and check applicability are reported explicitly.
6. The final output proves which setup steps ran and which worktree contract they
   established.
7. The script never prints secrets, silently renames branches, writes production
   data, or claims that an empty database is equivalent to a populated one.

The setup script should complement, not replace, the doctor and evidence verifier:
setup establishes readiness, doctor validates the runtime contract, and evidence
records what the gate actually verified.

## Acceptance criteria for a future implementation work unit

1. A fresh worktree without Doppler scope is detected and classified before a
   canonical gate can be recorded as green.
2. A missing, empty, or unsuitable database is detected and classified before
   data-dependent gate evidence is recorded.
3. Populated and empty database runs produce distinguishable evidence records.
4. The evidence verifier rejects records that omit required environment-contract
   fields or claim gates not executed by the runner.
5. The bidirectional gate-list/runner consistency check passes.
6. `dist/**` validation is explicitly recorded as executed and meaningful, skipped
   with a stated policy, or blocked; it cannot disappear silently.
7. Existing schema-version-1 evidence is rejected for push authorization after the
   new verifier lands, while historical copies may be retained for audit only.
8. The first post-change push is documented and tested as requiring a fresh chain
   run and new evidence recording; this is expected behavior, not an unexplained
   failure.
9. The guard emits a specific schema-version rejection message that instructs the
   operator to re-run the chain, rather than a generic verification failure.
10. No migration code is added for `.mgpl/gate-evidence.json`, because the file is
    gitignored and regenerated per worktree.
11. Tests cover missing Doppler scope, missing runtime injection, missing/empty/
    populated databases, vacuous bundle checks, gate-list drift, and evidence
    verification failures, including rejection of prior-version evidence.

## Non-goals

- Do not implement changes to `scripts/doctor.js` in this specification.
- Do not implement changes to `scripts/mgpl-gate-guard.js`.
- Do not modify recorded evidence files.
- Do not change rulesets, required contexts, or workflow authority.
- Do not introduce secrets, secret values, new infrastructure, or production data
  writes.
- Do not treat a single field addition as sufficient without the standing review
  control described above.

## Approval boundary

This specification requires a separate Principal Operator-approved work unit before
implementation. The implementation will affect the doctor, gate runner/guard,
verifier, tests, evidence schema, and handling of every existing evidence file.
