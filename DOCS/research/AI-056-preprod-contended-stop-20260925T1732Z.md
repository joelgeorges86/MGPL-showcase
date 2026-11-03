# AI-056: contended `docker stop` on preprod (#108)

Artifact of record. Host `mgpl-test-preprod-hel1` (`<preprod-tailscale-ip>`), over Tailscale
SSH, 2026-09-25. Code: `develop` at `b1c2395` (AI-056, #119). The stops were run by the
Principal Operator with the scripts below, because the agent's permission layer refused
them. Section 8 has the raw output in full, unedited.
SSH, 2026-09-25. Code: `develop` at `b1c2395` (AI-056, #119). The Principal Operator ran
both stops, because the agent's permission layer refused them. Section 8 has the raw
output in full, unedited.

**The committed scripts did not produce the committed measurements.** The runs at 17:32Z
and 17:37Z used the probe as it stood before review. That version is the helper and driver
in `84ca746`, apart from its usage comments. The scripts now in `scripts/probes/` are a
hardened successor. §5.1 lists what changed, and §5.5 says whether they would produce the
same result: expected yes, not demonstrated.

## 1. Result

| Profiles in flight | Request body | `docker stop` | Exit | Drain (HTTP server closed after) | Handles closed     |
| -----------------: | -----------: | ------------: | ---: | -------------------------------: | ------------------ |
|            **650** | 43,564 bytes |  **4,048 ms** |    0 |                             6 ms | 15 of 15, 0 failed |
|             **65** |  4,369 bytes |  **4,047 ms** |    0 |                             5 ms | 15 of 15, 0 failed |

**Ten times the payload changes the stop time by 1 ms.** For `restore-tuning`, the stop
time did not change with the size of the request in flight. That is the behaviour #108 was
opened to establish.

**What these two runs support.** One route (`restore-tuning`), two sizes (65 and 650
profiles), one lock condition (a second connection holding `BEGIN IMMEDIATE` throughout),
one write handle (`games.ts`'s, with a 5 s busy timeout), and one signal offset (about 1.1 s
into the wait).

- **What holds:** the stop time is the same at both sizes.
- **What does not follow:** that 4,047 ms is reproducible. With two runs, n is too small to
  say so, and the figure depends on where the signal lands in the call (§2).
- **Other routes and conditions** are covered by the bound's design (§3), not by these runs.

Both runs used the same conditions. A second connection held `BEGIN IMMEDIATE` on the live
database. An authenticated `POST /api/games/backup/restore-tuning` was in flight when
SIGTERM landed, and the grace period was 30 s. Both requests got
`503 {"error":"Server is shutting down; retry the request"}`. Both runs counted
`probe rows before=0` and `after=0`, so the restore wrote nothing.

## 2. What the four seconds is

The four seconds is **the rest of one SQLite call that was already waiting when the signal
landed**. It is not the request being serviced, and it is not a grace-period value.

| Event (UTC, 2026-09-25)              | 650 profiles | 65 profiles  |
| ------------------------------------ | ------------ | ------------ |
| Request sent (helper clock)          | 17:32:27.000 | 17:37:36.259 |
| `docker stop` issued (host clock)    | 17:32:28.047 | 17:37:37.355 |
| Signal offset after request          | 1,047 ms     | 1,096 ms     |
| 503 received                         | 17:32:31.966 | 17:37:41.279 |
| Request to 503                       | 4,966 ms     | 5,020 ms     |
| Container `FinishedAt`               | 17:32:31.985 | 17:37:41.293 |
| `docker stop` issued to `FinishedAt` | 3,939 ms     | 3,938 ms     |
| `docker stop` wall time (driver)     | 4,048 ms     | 4,047 ms     |

The route's write handle is `dbWrite` in `src/routes/games.ts:25`. It comes from
`openDatabase(dbPath)` and keeps better-sqlite3's default 5 s busy timeout. The events run
in this order:

1. The first profile's `BEGIN IMMEDIATE` (`restoreTx.immediate`) starts waiting on the held
   lock.
2. SIGTERM arrives about 1.05 to 1.10 s into that wait. The handler cannot run while the
   synchronous call blocks the event loop. Shortening the busy timeout to 250 ms applies
   only to later calls.
3. The wait gives up at about 5 s with `SQLITE_BUSY`, which the route records as that
   profile's error.
4. The loop's next `shutdownCheckpoint()` yields. The handler runs and logs
   `SQLite busy timeout 250 ms on 15 of 15`. The checkpoint then rejects, and the route
   returns 503.
5. The HTTP server closes 5 to 6 ms later. All 15 handles close, and the process exits 0.

**The request was abandoned after its first profile in both runs.** The other 649 and 64
profiles were never attempted. The drain took 5 to 6 ms, because the 503 had already
been sent and nothing else was in flight. So none of the four seconds is drain time.

The two stop times match because the signal landed at about the same point in the same
call in both runs. The time depends on where the signal lands in that one call. Nothing in
it scales with the profile count. A run with a different signal offset would give a
different time, anywhere from about 0 to 5 s plus the drain. It should still give the same
time at both sizes, and that equality is the result.

### What the code before AI-056 would have done here (not run)

Before #119, the restore loop was one synchronous callback that caught each write's error
and continued. The SIGTERM handler could not run until every profile had failed. AI-056
§4.1 measured this with the app's own busy timeouts, as in these runs: **10 profiles took
99,279 ms** from signal to exit, about 10 s per profile (two 5 s waits each).
By arithmetic, 65 profiles would take about 650 s and 650 profiles about 6,500 s. Both are
far past the 30 s grace period, so on preprod both would have been killed at 30 s with
exit 137 and the handles open. This is an inference from the measured rate. The code before
AI-056 was not run on preprod.

## 3. The bound

The bound as AI-056 §1 states it. It is a design claim for every cooperative loop, and
these runs tested it for `restore-tuning` only:

> Shutdown waits for the one SQLite call in progress when the signal lands, up to that
> handle's busy timeout (10 s for `db.ts`, 5 s for the route handles). Then it drains for
> at most 5 s. One call on an unregistered per-request handle (`library.ts`, `sync.ts`) can
> make the drain late. **The time does not grow with the size of the request in flight.**

These runs measured one point inside that bound, on one route. The call was on a 5 s route handle,
3.9 s of it remained at the signal, and the drain took 6 ms. The bound's upper end was not
run. That would be a signal landing at the start of a 10 s wait on `db.ts`'s handle, with
a drain held open for its full 5 s. The AI-043 §0.5 `blocked` run (14.161 s) is the
nearest measured case.

**Stated exceptions.** Neither was exercised here, and neither depends on the payload
except where stated:

- The six single-game handlers make **up to two** caught calls in a row (AI-056 §3.2).
  They are unchanged and belong to #109. This result does not affect them.
  `restore-tuning` is not one of them.
- `POST /api/state/import` stays atomic. It takes one lock wait, then processes every row
  without yielding (AI-056 §3.1). **The time for that lock-free processing grows with the
  payload, up to the 25 MB body limit, and it has not been measured.**

**Coverage.** Only `restore-tuning` was exercised by a contended stop on preprod. Five
other loops were made cooperative in #119 (`batch-status`, `sync/steam`, `sync/epic`,
`devices/playability` and `deals/arbitrage/ingest`). They were not run under a contended
stop, here or on preprod before.

## 4. Preprod before the runs

Recorded live before anything was changed (2026-09-25T16:26Z):

- The app ran `mgpl-preprod-app:ai043-5cb1f02` (`sha256:cf739770…`). It was started from
  two compose files, `/opt/mgpl/docker-compose.preprod.yml` and
  `/opt/mgpl-build/ai043-5cb1f02/grace-override.yml`. `StopTimeout` was 30.
- The 30 s came from the override. The host compose file had no `stop_grace_period`, which
  means Docker's 10 s default. Apart from that block and its comment, the host file was
  identical to `develop`'s.

The redeploy went as follows:

- **Build.** `git archive b1c2395` was extracted to `/opt/mgpl-build/develop-b1c2395/` and
  built as `mgpl-preprod-app:develop-b1c2395`, image
  `sha256:06e3de7d29bf20e9b8d1556f00021b95219fb476c6e9d00d9226fded4308d51e`.
- **Recreate.** The Principal Operator ran it at about 17:14:46Z. The host compose file was
  backed up to `docker-compose.preprod.yml.pre-b1c2395.bak` and replaced with `develop`'s.
  `latest` was retagged, then the container was recreated with
  `docker compose -p mgpl-preprod -f docker-compose.preprod.yml up -d --no-deps --no-build --force-recreate app`.
  The agent's permission layer had refused this step.
- **Verified at 17:21:04Z.** The running image equalled the built image. `StopTimeout` was 30.
  The compose file list was `/opt/mgpl/docker-compose.preprod.yml` only, with SHA-256
  `575db3f7…`, the same as `develop`'s file. The container was healthy. The override is
  retired: it is no longer referenced, but it was not deleted.

## 5. Method

The scripts are `scripts/probes/ai056-preprod-contended-stop-helper.mjs` and
`scripts/probes/ai056-preprod-contended-stop-driver.sh` (pending in PR #127). The method is the same as AI-043
§0.5, with a `restore-tuning` request in place of the part-sent register request.

**The committed scripts are not exactly what ran.** The 17:32Z and 17:37Z runs used the
version in `84ca746`, apart from its usage comments. After two rounds of Codex review, the
current version adds the four things below:

1. A target check in the driver.
2. An independent target check in the helper.
3. One place where the result and exit code are decided.
4. A committed test harness.

None of these changes the measurement: the stop, the lock, the request and the timing are
the same. The current version has not been run on preprod; the runs were not repeated.

### 5.1 The probe scripts

The target check, the exit-code semantics and the test harness are documented with the
scripts themselves in PR #127, not here.

That is deliberate. Those scripts are under review and have open findings against them —
including whether the helper should verify its target through the Docker Engine API at all.
Describing their behaviour in this record would state as settled something that is still
being decided, and would need re-editing each time the review moves.

**This record documents a measurement.** What produced it is stated in _Provenance of the
scripts used for these runs_ below: the 17:32Z and 17:37Z runs used the pre-review version,
and the successors in #127 have not been run on preprod.

For how the probe was invoked on the day, see §5.2.

### 5.2 How the probe ran

- **Helper container.** It runs from `mgpl-preprod-app:develop-b1c2395` on
  `mgpl-preprod_default`, with the data mount `/opt/mgpl/data-preprod -> /data`. It first
  checks that all eight tuning columns exist on `AppTracking`, so `ensureTuningColumns()`
  makes no write under the lock. Both runs logged `missing=[]`. It then registers a probe
  account and holds `BEGIN IMMEDIATE` on `/data/mgpl-preprod.db` for 45 s after its start,
  which is longer than the grace period.
- **Request.** The helper posts `{profiles:[{gameId:"ai056-probe-000001",targetTdp:"15W",targetFps:"60"}, …]}`
  with its session cookie.
- **Driver.** It runs on the host. It waits for `REQUEST_SENT`, sleeps 1 s, and times
  `docker stop mgpl-preprod-app` with the container's own `StopTimeout`. It then records
  `State.ExitCode`, the helper's log and the app's log since the run started. Once the
  helper has released its lock, it restarts the app and waits for it to report healthy.

### 5.1 The committed scripts are not the scripts that ran

The measurements in this record were produced at 17:32Z and 17:37Z by the probe as it
stood before any review. That version is the helper and driver in `84ca746`, apart from the
usage comments added there. **The scripts now committed did not produce the committed
output.** They are a hardened successor, changed over three rounds of Codex review:

| Commit    | Change                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d79ccf8` | Added a preprod target check in the driver, and meaningful exit codes.                                                                                                                                                                                                                                  |
| `99a02db` | The helper checked the target itself through the Docker socket. Added one decision point for the result, codes 3 to 5 with their side effects stated, and the test harness.                                                                                                                             |
| current   | Removed the Docker socket. The helper checks the target from its own mount, its database file and DNS. Every Docker call and every wait now has a time limit, and the helper has a hard deadline. `STATE` reports only what it has confirmed. The harness now asserts behaviour separately from format. |

The raw output in §8 is byte-identical to the operator's files. The evidence is sound. What
the scripts in the repository are is a successor to what produced it. §5.5 says whether they
would produce the same result.

### 5.2 Target check

**Driver.** Before anything else, the driver reads five markers with one
`docker inspect mgpl-preprod-app`, limited to 10 s. It prints what it found against what it
required. On any mismatch it exits 3; by then it has started no helper, written no file and
made no change. **All** five must match:

| Marker                      | Required                 |
| --------------------------- | ------------------------ |
| `DOPPLER_CONFIG` (env)      | `preprod`                |
| compose project label       | `mgpl-preprod`           |
| `DB_PATH` (env)             | `/data/mgpl-preprod.db`  |
| source of the `/data` mount | `/opt/mgpl/data-preprod` |
| networks, exactly           | `mgpl-preprod_default`   |

A missing, empty or `<no value>` marker fails, and so does a near-match such as
`preprod-2`. Output that cannot be parsed, a failed inspect and an inspect that hangs all
fail as well.

`DOPPLER_CONFIG` is the authoritative marker. Doppler injects it from the config that
supplies the container's secrets. The test app on the same host reports `test`. A
production container carries its own config's name, or none.

Production would also fail the other four independently:

- `docker-compose.yml` names its container `mgpl-app`.
- It sets `DB_PATH=/app/data/mpgl_app.db`.
- It mounts `./data` at `/app/data`, not at `/data`.
- It runs on a different host, where no `mgpl-preprod-app` exists.

The driver runs on the host as root, which already has Docker. The check adds no
privilege.

**Helper: an independent check with no privilege.** The helper has no Docker socket. It
takes nothing about the target from its caller: if any `MGPL_TARGET_*` variable is set, it
logs it as ignored. It establishes the target from what it can observe for itself:

| Marker            | How the helper observes it                                                                                                                          | Required                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `data_mount_root` | the root of its own `/data` mount, read from `/proc/self/mountinfo`: the directory within the host filesystem that is mounted                       | `/opt/mgpl/data-preprod`                |
| `db_file`         | the file it will lock exists as a regular file                                                                                                      | `/data/mgpl-preprod.db`                 |
| `app_name`        | `app` must resolve to exactly one address, and Docker's embedded DNS must reverse-resolve that address to exactly one name, `<container>.<network>` | `mgpl-preprod-app.mgpl-preprod_default` |

It then talks to the verified address, not to the name `app`, so the name cannot be
re-resolved to a different container between the check and the requests. Every DNS lookup
is limited to 5 s. It runs all of this before loading `better-sqlite3`, and exits 2 on
any failure.

**Why these observations mean what they say on preprod.** I read these read-only on the
preprod host and checked them in local Docker:

- **Mount root.** `/opt/mgpl/data-preprod` is on the root filesystem (`/dev/sda1`, ext4,
  FSROOT `/`). For a bind mount of it, the root recorded in `mountinfo` is therefore the
  host path itself.
- **Reverse DNS.** Preprod runs Docker 29.8.0. On Docker 29.8.0 locally, reverse-resolving
  a container's address on a user-defined network returned `mgpl-preprod-app.<network>`.

**What the helper can and cannot establish without the socket.**

- **It establishes the objects it touches.**
  - The file it locks is `mgpl-preprod.db`, in the directory mounted from host path
    `/opt/mgpl/data-preprod`.
  - The server it calls is the container named `mgpl-preprod-app`.
  - That container is on the network `mgpl-preprod_default`. Compose names a project's
    default network `<project>_default`, so this also points to the project.
- **It cannot establish two things,** because they are only visible in the target's
  container configuration:
  - **The app's `DOPPLER_CONFIG`,** that is, which environment's secrets it runs with.
  - **The app's `DB_PATH`,** that is, whether the app it calls uses the file it locks.
    It verifies the file and the server separately, but not the link between them.
- **What was lost against `99a02db`.** That version read both of these through the socket,
  and also inspected its own container. Both are still checked, but only by the driver.
  That is a real loss of independence for the two most specific markers. The alternative
  was full control of the host's Docker inside the helper container, a larger risk than
  the one it guarded against.
- **What a production target would need to pass the helper's check:** a host directory
  `/opt/mgpl/data-preprod` containing `mgpl-preprod.db`, and a container named
  `mgpl-preprod-app` on a network named `mgpl-preprod_default`. In other words, it would
  have to be built as preprod.

**Shown against real Docker** (local Docker Desktop, the helper run on its own):

- **No mount, no network:** all three markers failed (no mount at `/data`, `ENOENT`,
  lookup of `app` `ENOTFOUND`). It exited 2.
- **A decoy container named `mgpl-preprod-app` with alias `app` on a network
  `ai056-ptr-test`, with the caller passing preprod values:** it logged `IGNORED` for
  each value. It then found:
  - `data_mount_root` `"/data/docker/volumes/ai056-mi-test/_data"`;
  - no `db_file`;
  - `app_name` `"mgpl-preprod-app.ai056-ptr-test"`.

  It exited 2 with
  `ABORT: target is not shown to be preprod; database not opened, nothing registered, no lock taken`.

### 5.3 Time limits, and what STATE reports

**Every step has a time limit.**

- **Docker calls.** Every call is wrapped in `timeout`: 10 s for inspect and ps, 15 s for
  kill, 20 s for logs and exec, 60 s for stop and start, and 180 s for the helper's
  `docker run`.
- **Waiting for the request.** The driver waits at most 30 s for the helper to send its
  request.
- **Waiting after the stop.** It waits at most 90 s for the helper to finish. The helper
  releases its lock 45 s after it starts.
- **A helper that outlives its wait** is killed, with a 15 s limit. The driver then waits
  at most 15 s more for the client and kills the client if it is still there.
- **The helper's own limits.** It sets its own deadline of `HOLD_MS` + 60 s (105 s). When
  that passes it exits with code 8, and exiting releases any lock it holds. Its register
  request is limited to 15 s and its DNS lookups to 5 s.
- **Interruption.** `INT`, `TERM` and `HUP` go through the same exit path.

**What STATE reports.** The `STATE` line reports only what the driver has confirmed. It
says `unknown` otherwise:

| Field         | Values and when each is reported                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_stopped` | `yes` if this run issued `docker stop`                                                                                                                                      |
| `app_now`     | the app container's live status from a time-limited inspect, or `unknown`                                                                                                   |
| `helper`      | `never-started`; `gone` (not in the time-limited list of running containers); `running`; `unknown` (the list could not be read)                                             |
| `account`     | `yes` only if register returned 201; `no` only if the helper never started, or is gone without logging `REGISTER_ATTEMPT`; otherwise `unknown`                              |
| `lock`        | `not-taken` (helper never started); `not-held` (helper gone: SQLite's lock belongs to the process and is released when it exits); `may-be-held` (helper running); `unknown` |

When the lock is `may-be-held` or `unknown`, an `ACTION` line gives the command that
releases it: `docker kill ai056-helper-<N>`.

The previous version was wrong in two places:

- **The lock.** It reported the lock released once the `docker run` client process had
  exited. A container can outlive its client.
- **The account.** It reported no account whenever there was no `201`. A register request
  that got no answer may still have created one.

### 5.4 Exit codes and what each leaves on preprod

Every path out of the driver goes through its `EXIT` trap, including an unexpected exit or
an interruption. That trap computes the exit code, `RESULT` and `STATE` together, from the
same variables. `RESULT` says `pass` exactly when the exit code is 0.

| Driver exit    | App stopped? | App running now?                                                   | Account            | Lock                                                                               |
| -------------- | ------------ | ------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| 0 pass         | yes, once    | yes: healthy, and `/healthz` reports the database connected        | yes                | not held: the helper container is gone                                             |
| **1 fail**     | **yes**      | **not guaranteed; go and look.** `STATE app_now` is the live state | as `STATE` reports | as `STATE` reports; if `may-be-held` or `unknown`, `ACTION` says how to release it |
| 3 not preprod  | no           | untouched                                                          | no                 | not taken                                                                          |
| 4 precondition | no           | untouched                                                          | no                 | not taken                                                                          |
| 5 no request   | no           | untouched                                                          | as `STATE` reports | as `STATE` reports; the driver has tried to kill the helper                        |

- **Codes 3 and 4 are set before the helper starts.** On those paths the driver starts no
  container and creates no file. The harness asserts that no `run`, `kill`, `stop` or
  `start` call is made.
- **Code 4** covers a bad N, no helper script, no `timeout` command, or the app not being
  healthy.
- **Code 1** means the stop was issued and at least one of these failed afterwards:
  - `docker stop` returned nonzero or ran out of time;
  - the container exited with a code other than 0 or 143;
  - the helper returned nonzero, or was still running after its wait;
  - `docker start` failed;
  - the app was not healthy within 90 s;
  - the `/healthz` request failed, or `/healthz` did not report the database connected.

The helper's own codes:

| Helper exit | Meaning                        | Left behind                                                                     |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------- |
| 0           | pass                           | one account; lock taken and released; no probe rows                             |
| 2           | target not shown to be preprod | nothing; database not opened                                                    |
| 7           | bad N                          | nothing; checked before the database is opened                                  |
| 4           | tuning columns missing         | database read; no account, no lock                                              |
| 3           | register failed                | no lock; account unknown if `REGISTER_ATTEMPT` was logged without `status=201`  |
| 5           | no 503 shutdown response       | one account; lock taken and released                                            |
| 6           | probe rows written             | one account; lock taken and released; **`ai056-probe-*` rows in `AppTracking`** |
| 8           | hard deadline reached          | any lock released at exit; the log shows how far it got                         |
| 1           | uncaught error                 | any lock released at exit; the log shows how far it got                         |

### 5.5 Would the current scripts produce the same result?

**Expected: yes, within a few milliseconds. Not demonstrated,** because the current
scripts have not been run on preprod.

The timed path is the same in every step that affects the measurement:

- the helper holds `BEGIN IMMEDIATE` from a second connection;
- it posts the same request;
- the driver polls for `REQUEST_SENT` every 0.1 s, sleeps 1 s, and times `docker stop`
  with the container's own `StopTimeout`.

What is timed is the app's own shutdown. There are only two differences inside or around
the timed path:

- **`docker stop` now runs under `timeout 60`.** That adds one process start inside the
  timed interval, on the order of a millisecond.
- **The helper posts to the verified address** instead of the name `app`. That is the
  same container, reached without a DNS lookup per request.

Everything else added runs before the request is sent, or after the stop has returned.
That covers the target checks, the register timeout, the deadline, the result decision and
the bounded cleanup.

**If a new check failed on preprod, the scripts would refuse rather than measure
differently.** That would be exit 3 from the driver, or exit 5 from the helper's exit 2.
The helper's checks have not been run on preprod. What supports them there is the
filesystem layout and Docker version above, and the local runs.

### 5.6 Test harness

Run it with `bash scripts/probes/ai056-preprod-contended-stop-test/run.sh`. It needs no
Docker, no network and no preprod. It takes about 4 minutes on Windows (Git Bash), where
starting processes is slow. It exits nonzero if any case fails.

**Every assertion is tagged,** so that a failure against an older script shows whether
the test caught a defect or only a changed wording:

- **B (behaviour):** the defect itself.
  - The exit code.
  - Which side-effecting calls were made: `run`, `kill`, `stop` and `start` for the
    driver; loading the database module or any fetch for the helper.
  - Any use of the Docker socket.
  - Finishing within the case's time limit, so a hang is a failure.
  - `RESULT` saying `pass` exactly when the exit code is 0.
  - `STATE` making no false claim, checked with patterns that also match older wordings.
    An older "released" or "account created: no" is caught.
- **F (format):** the current output contract.
  - `RESULT`'s `code=` token.
  - The exact failed list.
  - `STATE`'s `key=value` tokens.
  - The exact set of `TARGET_FAIL` markers.

**Driver: 35 cases,** run against stub `docker`, `timeout` and `sleep`. The stub `timeout`
divides every limit by 10 and the stub `sleep` divides every wait by 100, so hangs are still
cut off, only faster. The cases are:

- **pass (2);**
- **target not preprod (16):**
  - production-like and test-environment targets;
  - `docker inspect` failing, returning malformed output, and hanging;
  - markers absent, empty and `<no value>`;
  - near-matches;
  - an extra network;
- **preconditions (3);**
- **helper did not send (4):**
  - the helper refusing;
  - the helper hanging before it registers;
  - the helper hanging after a register attempt, where `STATE` must not claim there is
    no account;
  - the helper holding the lock with `kill` failing, where `STATE` must not claim the
    lock is released;
- **after the stop (10):**
  - `docker stop` failing, and `docker stop` hanging;
  - container exit 137;
  - helper exit 5;
  - the helper container outliving its client with `kill` failing;
  - start failing;
  - unhealthy after restart;
  - the `/healthz` request failing;
  - the database reported disconnected;
  - two failures together.

**Helper: 30 cases,** run with `helper-stub.mjs` preloaded. The stub supplies what the helper
observes and records every side effect it attempts. The cases are:

- `mountinfo` unreadable, malformed, not text, without `/data`, with two mounts at `/data`,
  and with wrong, near-miss, escaped and non-host roots;
- the database file missing, or a directory;
- the forward and reverse DNS lookups failing, hanging, returning two answers, returning
  an empty or malformed answer, or answering with a near-miss, a trailing dot or the test
  environment;
- production-like and test-environment targets;
- the caller passing preprod values;
- a verified target with a bad N;
- **a positive control.** A verified target must go on to load the database module, which
  shows that the side-effect recording works. Without it, every "no side effect" check
  would pass trivially.

**What the harness catches in the older scripts.** The harness was run against the helper
and driver at each earlier commit. Only **B** failures count as detecting a defect. A case
that fails only on **F** means the older script behaved correctly and printed a different
format.

The older drivers read the target with per-field `inspect` templates, which the committed
stub does not answer. For them, the driver cases were run with a copy of the harness whose
stub also answers those templates. That copy was kept outside the repository. Without it,
every older driver aborts at its target check, and those failures would say nothing about
defects.

| Version                             | B failures that are real detections                                                                                                                                                                                                                                                                                                                                                      | Discounted                                                                                                 | F only                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `84ca746` driver (the one that ran) | 33 of 35. It stopped the app against every non-preprod target and on every precondition failure. It exited 0 on every failure after the stop. It hung on an `inspect` that hangs, a helper that hangs, and a `docker stop` that hangs.                                                                                                                                                   | 2 (`pass` and exit 143). Their only B failure is a missing `RESULT` line, which is a format difference.    | none                                                                           |
| `84ca746` helper (the one that ran) | 29 of 30. It had no target check, so it went on to the database in every refusal case.                                                                                                                                                                                                                                                                                                   | none. The positive control passes, as it should.                                                           | none                                                                           |
| `d79ccf8` driver                    | 9. It hung on an `inspect` that hangs, on each of three hanging helpers, and on a `docker stop` that hangs. It exited 0 when `/healthz` failed or reported the database disconnected (Codex round 2). It exited 0 when the helper container outlived its client. It returned 4 ("nothing touched") after starting the helper.                                                            | 1 (`target-inspect-malformed-output`): the legacy stub sent the garbage only in reply to the new template. | 25. Its target check and exit codes behaved correctly; only the tokens differ. |
| `d79ccf8` helper                    | 3. It trusted the caller's preprod values and went on to the database while the target was the test environment. It could not verify a real preprod target without values from its caller.                                                                                                                                                                                               | none                                                                                                       | 27. It also refused these targets, with different wording.                     |
| `99a02db` driver                    | 17. It gave the helper the Docker socket in every case that started the helper (Codex round 3). It hung on an `inspect` that hangs, on a `docker stop` that hangs, and on a helper holding the lock when `kill` fails. It claimed there was no account after an unanswered register attempt. It exited 0 and claimed the lock was released while the helper container was still running. | 1 (`target-inspect-malformed-output`), as above.                                                           | 17                                                                             |
| `99a02db` helper                    | 30. Every case caught it reaching for the Docker socket. That is one defect, detected 30 times.                                                                                                                                                                                                                                                                                          | none                                                                                                       | none                                                                           |

The harness catches every defect the three review rounds raised, plus the ones in the
version that actually ran. The two artefacts found while doing this are listed above, not
counted.

### 5.7 How the runs of record were made

- **Helper container.** It ran from `mgpl-preprod-app:develop-b1c2395` on
  `mgpl-preprod_default`, with the data mount `/opt/mgpl/data-preprod -> /data`. It first
  checked that all eight tuning columns exist on `AppTracking`, so `ensureTuningColumns()`
  would make no write under the lock. Both runs logged `missing=[]`. It then registered a probe
  account and held `BEGIN IMMEDIATE` on `/data/mgpl-preprod.db` for 45 s after its start,
  which was longer than the grace period.
- **Request.** The helper posted `{profiles:[{gameId:"ai056-probe-000001",targetTdp:"15W",targetFps:"60"}, …]}`
  with its session cookie.
- **Driver.** It ran on the host. It waited for `REQUEST_SENT`, slept 1 s, and timed
  `docker stop mgpl-preprod-app` with the container's own `StopTimeout`. It then recorded
  `State.ExitCode`, the helper's log and the app's log since the run started. Once the
  helper had released its lock, it restarted the app and waited for it to report healthy. It had no target check, exited 0 whatever happened, and waited on the helper without a time limit.
- **Order.** The 650-profile run went first.

## 6. Litestream: the replica generation changed at each restart

`mgpl-preprod-litestream` kept running throughout. However, at each restart that followed
a run, it started a new generation:

```
time=2026-09-25T17:33:12.943Z level=INFO msg="sync: new generation" db=/data/mgpl-preprod.db generation=0f1767c7040134d1 reason="wal overwritten by another process"
time=2026-09-25T17:37:37.943Z level=ERROR msg="sync error" db=/data/mgpl-preprod.db error="checkpoint: mode=PASSIVE err=database is locked"
time=2026-09-25T17:38:21.942Z level=INFO msg="sync: new generation" db=/data/mgpl-preprod.db generation=7d4d2e300383dc38 reason="wal overwritten by another process"
```

- **Before the runs.** The generation had been `8e783635857e4cbf` through every AI-043
  restart on 2026-09-24 (AI-043 §0.5). It was unchanged across this morning's
  uncontended recreate at 17:14:46Z, and its last segment was written at 17:32:48.368Z.
- **After each new generation.** Snapshots and WAL segments were written to both
  replicas (`mgpl-db-replica` and `mgpl-db-backup`). Replication carried on, but
  point-in-time history is broken at 17:33:12Z and 17:38:21Z.
- **The `ERROR` line** came while the helper held the write lock, 588 ms after the second
  `docker stop`. Litestream recovered on the next sync.
- **Cause: not established.** Each new generation appears within 1 s of the helper
  closing its connection (17:33:11.861Z and 17:38:21.113Z) and of the app starting
  (17:33:12.097Z and 17:38:21.317Z). The app runs no explicit checkpoint (`src/db.ts` sets
  `journal_mode = WAL` only). The AI-043 §0.5 runs used a similar lock-holding helper and
  did not change the generation. That record does not say whether the helper there
  outlived the app, as it did here. This is a hypothesis, and it is proposed for tracking
  rather than treated as explained.

## 7. State left on preprod

- **App.** It runs `mgpl-preprod-app:develop-b1c2395` (`sha256:06e3de7d…`). It was
  restarted at 17:38:21Z and reported healthy at 17:42:48Z. `/healthz` returned
  `"database":"connected"` after each restart.
- **Two probe accounts remain** in `AuthUsers` with role `user`. They were not deleted
  (§3.3):
  - `ai056-probe-1790357546841@example.invalid` (650-profile run)
  - `ai056-probe-1790357856095@example.invalid` (65-profile run)
- **No `ai056-probe-*` rows in `AppTracking`.** Each helper counted them after its
  `ROLLBACK`.
- **Kept on the host:** `/opt/mgpl/docker-compose.preprod.yml.pre-b1c2395.bak`,
  `/opt/mgpl-build/ai043-5cb1f02/` (no longer referenced), and the `develop-6d23340` and
  `develop-b1c2395` build directories. Each run also left
  `/tmp/ai056-contended-<N>.log`. Nothing was deleted.
- **Rollback.** Restore the `.bak`, run
  `docker tag mgpl-preprod-app:ai043-5cb1f02 mgpl-preprod-app:latest`, then run the
  recreate command in §4.

## Provenance of the scripts used for these runs

The two measurements in this record were taken at 2026-09-25T17:32Z and 17:37Z. **The
probe scripts as committed are not the scripts that produced them.**

The runs used the scripts as they existed before any review round. Since then three
review rounds have changed them substantially: an independent preprod target check in both
driver and helper, a single exit trap deciding the result line and the exit code together,
per-code side-effect semantics, a new exit code 5 for the case where the helper registers
an account and then fails before sending its request, and a committed test harness.

Those scripts are under review in PR #127 and are not on `develop` at the time this record
merges. The script paths cited below therefore refer to that pull request, not to files
present in this branch.

**What this does and does not affect.** The raw output in this record is byte-identical to
the files the Principal Operator produced during the runs, so the measurements stand as
recorded. What cannot be claimed is that re-running the current scripts reproduces them:
that has not been tested, and the scripts are still changing.

A reader comparing the committed scripts against the committed output would otherwise
reasonably assume one produced the other. It did not.

## 8. Raw output

Both files in full, as the operator returned them (`run-650.txt`, then `run-65.txt`).

```
===== AI-056 contended docker stop, profiles=650 (2026-09-25T17:32:26.436499336Z)
image=sha256:06e3de7d29bf20e9b8d1556f00021b95219fb476c6e9d00d9226fded4308d51e StopTimeout=30 cfgfiles=/opt/mgpl/docker-compose.preprod.yml state=running/healthy
2026-09-25T17:32:28.046806831Z docker stop mgpl-preprod-app
mgpl-preprod-app
docker stop rc=0 elapsed_ms=4048
State.ExitCode=0 OOMKilled=false StartedAt=2026-09-25T17:14:46.948838896Z FinishedAt=2026-09-25T17:32:31.985405759Z
helper exit=0
--- helper log
2026-09-25T17:32:26.838Z +6ms tuning columns missing=[]
2026-09-25T17:32:26.841Z +9ms probe rows before=0
2026-09-25T17:32:26.999Z +167ms register status=201 account=ai056-probe-1790357546841@example.invalid session=yes
2026-09-25T17:32:26.999Z +167ms LOCK_HELD BEGIN IMMEDIATE on /data/mgpl-preprod.db
2026-09-25T17:32:27.000Z +168ms REQUEST_SENT restore-tuning profiles=650 bytes=43564
2026-09-25T17:32:31.966Z +5134ms restore response status=503 after 4966 ms body={"error":"Server is shutting down; retry the request"}
2026-09-25T17:33:11.860Z +45028ms LOCK_RELEASED ROLLBACK
2026-09-25T17:33:11.861Z +45029ms probe rows after=0
--- app log since 2026-09-25T17:32:26.492409900Z
[shutdown] SIGTERM received; SQLite busy timeout 250 ms on 15 of 15 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
[shutdown] HTTP server closed after 6 ms; closed 15 of 15 registered SQLite handle(s), 0 failed; exiting 0
--- restart
mgpl-preprod-app
state=running/healthy image=sha256:06e3de7d29bf20e9b8d1556f00021b95219fb476c6e9d00d9226fded4308d51e started=2026-09-25T17:33:12.09681763Z
{"status":"healthy","timestamp":"2026-09-25T17:33:17.507Z","uptime":5.27839258,"database":"connected","version":"1.0.0"}
```

```
===== AI-056 contended docker stop, profiles=65 (2026-09-25T17:37:35.713754006Z)
image=sha256:06e3de7d29bf20e9b8d1556f00021b95219fb476c6e9d00d9226fded4308d51e StopTimeout=30 cfgfiles=/opt/mgpl/docker-compose.preprod.yml state=running/healthy
2026-09-25T17:37:37.355132180Z docker stop mgpl-preprod-app
mgpl-preprod-app
docker stop rc=0 elapsed_ms=4047
State.ExitCode=0 OOMKilled=false StartedAt=2026-09-25T17:33:12.09681763Z FinishedAt=2026-09-25T17:37:41.293370579Z
helper exit=0
--- helper log
2026-09-25T17:37:36.093Z +7ms tuning columns missing=[]
2026-09-25T17:37:36.095Z +9ms probe rows before=0
2026-09-25T17:37:36.258Z +172ms register status=201 account=ai056-probe-1790357856095@example.invalid session=yes
2026-09-25T17:37:36.258Z +172ms LOCK_HELD BEGIN IMMEDIATE on /data/mgpl-preprod.db
2026-09-25T17:37:36.259Z +173ms REQUEST_SENT restore-tuning profiles=65 bytes=4369
2026-09-25T17:37:41.279Z +5193ms restore response status=503 after 5020 ms body={"error":"Server is shutting down; retry the request"}
2026-09-25T17:38:21.112Z +45026ms LOCK_RELEASED ROLLBACK
2026-09-25T17:38:21.113Z +45027ms probe rows after=0
--- app log since 2026-09-25T17:37:35.769247102Z
[shutdown] SIGTERM received; SQLite busy timeout 250 ms on 15 of 15 registered handle(s), 0 failed; draining HTTP connections (max 5000 ms)
[shutdown] HTTP server closed after 5 ms; closed 15 of 15 registered SQLite handle(s), 0 failed; exiting 0
--- restart
mgpl-preprod-app
state=running/healthy image=sha256:06e3de7d29bf20e9b8d1556f00021b95219fb476c6e9d00d9226fded4308d51e started=2026-09-25T17:38:21.316975686Z
{"status":"healthy","timestamp":"2026-09-25T17:38:26.767Z","uptime":5.283926433,"database":"connected","version":"1.0.0"}
```
