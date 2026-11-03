# AI-024 — E2E Transport Stability

## Status

Specification only. No application, test, configuration, or harness implementation
is included in this work unit.

## Problem statement

The full canonical gate chain cannot reliably pass. During full Playwright suite
execution, `test/e2e/rate-limiting.spec.ts:74:7` intermittently fails with:

```text
Error: apiRequestContext.get: read ECONNRESET
GET http://localhost:4000/api/observability/health
```

The failure occurs in the observability health limiter scenario after the test has
issued a burst of requests intended to verify the `5/sec` limiter, sanitized `429`
responses, and recovery. The exact cause is unknown.

This is an operational reliability problem, not merely a flaky assertion. The
repository guard blocks a push without green evidence, so an unreliable canonical
chain makes the normal path to landing any change unreliable. The cost is larger
than any single blocked work unit because every branch that requires the complete
gate chain inherits the instability.

Work Unit D remains separate and untouched while this stability work unit is
investigated.

## Evidence to date

The intermittency register and investigation notes record the following ordered
sequence of **nine full-suite runs** relevant to this work unit:

1. Early full diagnostic pass: `409/409 passed`.
2. Early full diagnostic pass: `409/409 passed`.
3. Canonical full gate chain: `408 passed, 1 failed` at
   `rate-limiting.spec.ts:74:7` with `ECONNRESET`.
4. Canonical full gate chain rerun: `408 passed, 1 failed` at the same location.
5. Canonical full gate chain: `408 passed, 1 failed` at the same location.
6. Canonical full gate chain: `408 passed, 1 failed` at the same location.
7. Full canonical-equivalent run after diagnostic cleanup: `409/409 passed`.
8. Clean-process canonical gate chain after cleanup: `408 passed, 1 failed` at
   the same location.
9. Full suite invoked with `rate-limiting.spec.ts` appended to the CLI argument
   list: `409/409 passed`; Playwright still ran the file at positions 249–251, so
   this was not a valid reorder experiment.

The broader investigation also established that the isolated rate-limiting spec
passed `3/3` on both the D branch and a clean `origin/develop` tree, and a narrow
neighborhood around the target passed `17/17`. A passing full suite is evidence
only for that run; it does not establish that the intermittency is resolved.

The exact server state at the time of the reset has never been captured.

### Hypotheses investigated and current evidence

#### Work Unit D causation — ruled out

- The isolated rate-limiting spec passed `3/3` on the D branch.
- The identical isolated spec passed `3/3` on clean `origin/develop`.
- Work Unit D validation runs once during startup from `src/index.ts`.
- It is not invoked per request and is not reached by
  `/api/observability/health`.

#### Unbounded resource accumulation — not supported

- The instrumented full suite completed `409/409`.
- The server remained available during that run.
- No restart or configuration-validation loop was observed.
- Server-only monotonic memory or handle growth was not proven.

This does not prove that no transport or socket resource condition exists; it only
means the available evidence does not establish unbounded accumulation.

#### `express-rate-limit` `MemoryStore` growth — ruled out for the installed default

- No external store is supplied, so the installed default is the in-memory
  `MemoryStore`.
- The store rotates its current and previous maps on the limiter window.
- Expired entries are cleared, and the store exposes `resetKey()` and `resetAll()`.

This rules out the investigated theory of unbounded growth in the default limiter
store, not every possible interaction between the limiter and transport behavior.

#### Preceding test state through 378 tests — not supported as a deterministic cause

The target rate-limiting spec passed in all tested reduced-prefix runs through 378
tests, including prefixes of 69, 134, 193, 241, 300, and 378 tests. The spec also
passed in isolation and in full diagnostic runs. The failure therefore does not
follow reliably from simply running the preceding suite state, although a
suite-level interaction remains unproven.

#### Scheduler / cron activity — ruled out for the E2E process

Playwright sets `DISABLE_CRON=true`. `initSyncScheduler()` returns before
registering cron jobs or the ten-second startup sync. No scheduler activity was
observed in the run logs. Scheduled background work is therefore not supported as
the cause in the configured E2E process.

#### Orphaned diagnostic processes — insufficient explanation

Four consecutive canonical failures occurred while diagnostic attempts had left
`ts-node-dev` descendants and samplers around port 4000. A later green run occurred
after cleanup, which created a plausible correlation. However, the canonical chain
failed again after a clean process-table preflight, with port 4000 free and no
remaining MGPL or diagnostic processes. Orphaned processes are therefore not
sufficient to explain the failures.

### Current conclusion

The cause remains unknown. The reset-time server state has never been captured, and
the evidence does not identify whether the reset originates in the application,
the limiter, the HTTP/socket layer, Playwright request handling, or a suite-level
interaction.

## What is still untested

1. **A valid reorder experiment.** The prior attempt appended the test path to the
   CLI arguments, but Playwright still executed the file at positions 249–251.
   A supported ordering mechanism must be used before drawing conclusions from test
   position.
2. **Spec attribution versus socket concentration.** The failure may belong to the
   rate-limiting spec, or the spec may merely be where the problem is observed
   because it holds the largest number of concurrent in-flight sockets in a short
   interval.
3. **Direct reproduction outside Playwright.** It is not known whether the same
   reset can be provoked by issuing the equivalent burst directly against a
   normally-started server.

The third item is the first priority. If a plain script that saturates
`/api/observability/health` reproduces the reset against a normally-started server,
the investigation moves onto the application, limiter, or HTTP transport rather
than the Playwright harness. If it does not reproduce, the scope narrows toward
Playwright, suite interaction, or test-specific request behavior.

## Proposed approaches

### 1. Reproduce outside Playwright with a direct load script — first priority

Create a bounded, local-only diagnostic script that starts or targets a normally
started MGPL server and issues the same request burst and recovery sequence against
`/api/observability/health`. Capture status codes, request completion, socket errors,
server exit state, and timing without changing production code.

**Would establish:** whether the reset is reproducible independently of Playwright.
An independent reproduction would move the investigation toward the application,
limiter, Node HTTP server, or socket lifecycle. A non-reproduction would narrow the
problem toward Playwright or full-suite interaction.

**Cost:** one bounded diagnostic implementation and a small number of controlled
runs. It must not become an open-ended load test or leave background processes.

### 2. Valid reorder experiment using a supported Playwright mechanism

Use Playwright-supported test discovery or project configuration to place the
rate-limiting spec at a controlled position, and verify the actual execution order
from the test output before interpreting the result.

**Would establish:** whether the failure correlates with preceding test state or
with the target spec’s location in the suite.

**Cost:** temporary test-runner configuration or a narrowly scoped diagnostic
manifest, plus repeated full-suite runs and explicit cleanup. The production test
assertions must remain unchanged.

### 3. Server-side instrumentation inside the application

Add diagnostic-only instrumentation at the application boundary for
`/api/observability/health` that records connection lifecycle and socket errors,
including handler entry/exit, aborted requests, client disconnects, response
completion, and relevant server error events. Instrumentation must be sanitized,
bounded, and removable or gated outside the diagnostic run.

**Would establish:** the server-side state at or immediately before the reset,
including whether the request reaches the handler, whether the response is
aborted, and whether Node reports a socket or connection error.

**Cost:** application code changes, focused validation, careful cleanup, and a new
diagnostic run. This is preferred over external process sampling, which failed to
capture the relevant state in four diagnostic rounds.

### 4. Compare `/api/observability/health` with `/api/dpm/health`

Exercise the corresponding `/api/dpm/health` route under the same request pattern.
It uses the same limiter configuration and has not exhibited the observed reset.

**Would establish:** whether the behavior is specific to the observability health
handler or shared by routes using the same limiter configuration. A difference
would focus investigation on route-specific handling; parity would focus it on the
shared limiter or transport path.

**Cost:** low. This should be run alongside the direct load script and must record
comparable request counts, timing, status codes, and socket outcomes.

## Acceptance criteria

This work unit is accepted when one of the following outcomes is achieved:

### Stability outcome

- The full canonical gate chain passes on **five consecutive runs**;
- the `rate-limiting.spec.ts` assertions are unchanged;
- no transport retries are added to mask failures;
- the run evidence records the process-table preflight and the result of every
  canonical run.

### Root-cause outcome

- The cause of the reset is identified with evidence from a reproducible experiment
  or reset-time server-side instrumentation; and
- a corrective fix is specified with its own explicit acceptance criteria before
  implementation begins.

A single green run, a passing isolated test, or a test-order change without verified
execution order does not satisfy acceptance.

## Explicit non-goals

- Do not weaken the rate-limiting test assertions.
- Do not add transport retries to conceal the reset.
- Do not disable, skip, quarantine, or otherwise suppress the rate-limiting spec.
- Do not reduce the request burst merely to make the test pass.
- Do not alter Work Unit D while this work unit is active.
- Do not introduce new infrastructure, external services, or production writes.
- Do not run unbounded diagnostics or leave samplers, servers, or child processes
  running after a checkpoint.

The test exists to provide an availability signal. Masking the signal would defeat
the purpose of this work unit.

## Budget and checkpoints

Four diagnostic rounds have already been spent investigating this incident. AI-024
has its own scheduled budget and must not become open-ended retry work.

Each checkpoint must report:

1. The exact command or diagnostic method used.
2. Whether the process table and port 4000 were clean before execution.
3. The number of runs and complete pass/fail results.
4. Whether reset-time server state was captured.
5. The resulting hypothesis classification and the next bounded step.

Recommended checkpoints are:

- **Checkpoint 1:** direct non-Playwright burst against a normally-started server.
- **Checkpoint 2:** comparison with `/api/dpm/health` under equivalent load.
- **Checkpoint 3:** valid Playwright ordering experiment.
- **Checkpoint 4:** server-side instrumentation only if the first three do not
  identify the cause.
- **Checkpoint 5:** five consecutive canonical green runs or a root-cause/fix
  specification.

Stop and report if a checkpoint exhausts its allocated attempt budget without
producing new evidence. Do not substitute repeated canonical retries for a bounded
experiment.

## Deliverable boundary

This document defines the E2E transport stability work unit. Implementation belongs
in follow-up work after the specification is reviewed. The specification PR is
documentation-only; the canonical chain is expected to remain red because of the
known `ECONNRESET` described above.