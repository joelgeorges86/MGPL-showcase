// AI-056 / #108 preprod contended-stop helper. Runs inside a container from the
// app image, on the preprod compose network, with the preprod data mount. It has
// no Docker socket and no other privilege beyond what the probe needs.
// 0. Refuses to run unless it can show, by itself, that the target is preprod.
// 1. Checks the tuning columns exist (so ensureTuningColumns() makes no write).
// 2. Registers a throwaway probe account (password random, never printed).
// 3. Holds BEGIN IMMEDIATE on the live DB: a second connection holding the write lock.
// 4. Posts restore-tuning with N profiles and records the response.
// 5. Keeps the lock for HOLD_MS (longer than the 30 s grace), then ROLLBACK.
// Driven by ai056-preprod-contended-stop-driver.sh, which has the usage.
//
// Target check. The helper establishes the target from what it can observe itself,
// and takes nothing about the target from its caller (no environment variable,
// argument or file). Every marker must equal the preprod value (an allowlist):
//   data_mount_root  the host directory behind its own /data, read from
//                    /proc/self/mountinfo (the mount's root within the host
//                    filesystem; on preprod /opt/mgpl is on the root filesystem,
//                    so this is the host path): /opt/mgpl/data-preprod
//   db_file          the file it will lock exists as a regular file:
//                    /data/mgpl-preprod.db
//   app_name         the one address "app" resolves to, reverse-resolved by
//                    Docker's embedded DNS as <container>.<network>:
//                    mgpl-preprod-app.mgpl-preprod_default
// It then talks to that verified address, not to the name. What it cannot see
// without the Docker API, and so does not check: the app's DOPPLER_CONFIG and its
// DB_PATH (that the app it calls uses the file it locks). The driver checks both.
//
// Bounds: DNS lookups 5 s each, register 15 s, the restore at most HOLD_MS, and a
// hard deadline of HOLD_MS + 60 s after which the process exits (code 8), which
// releases any lock it holds.
//
// Exit codes, and what each leaves behind (the app itself is never stopped by
// the helper; the driver does that):
//   0  pass. Account created; lock taken and released; no probe rows.
//   2  target not shown to be preprod. Nothing: database not opened, no account,
//      no lock.
//   7  bad N. Nothing (checked before the database is opened).
//   4  tuning columns missing. Database opened and read; no account, no lock.
//   3  register failed. No lock. Account: none if the log has no
//      REGISTER_ATTEMPT; otherwise not established unless status=201.
//   5  restore did not end with the 503 shutdown response. Account created;
//      lock taken and released.
//   6  probe rows were written. Account created; lock taken and released;
//      ai056-probe-* rows now exist in AppTracking on preprod.
//   8  hard deadline reached. Any lock released at exit; the log shows how far
//      it got.
//   1  uncaught error. Any lock released at exit; the log shows how far it got.
import fs from "node:fs";
import dns from "node:dns";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const t0 = Date.now();
const log = (m) => console.log(`${new Date().toISOString()} +${Date.now() - t0}ms ${m}`);

const HOLD_MS = Number(process.env.HOLD_MS || 45000);
setTimeout(() => {
  log(`ABORT: hard deadline of ${HOLD_MS + 60000} ms reached; exiting releases any lock`);
  process.exit(8);
}, HOLD_MS + 60000).unref();

const REQUIRED = {
  data_mount_root: "/opt/mgpl/data-preprod",
  db_file: "/data/mgpl-preprod.db",
  app_name: "mgpl-preprod-app.mgpl-preprod_default",
};

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: "ETIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// /proc/self/mountinfo: id parent major:minor root mountpoint options [optional...] - fstype source superopts
const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
function dataMountRoot() {
  let text;
  try {
    text = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch (e) {
    return { found: undefined, note: `cannot read /proc/self/mountinfo: ${e.code || e.message}` };
  }
  if (typeof text !== "string") return { found: undefined, note: "mountinfo is not text" };
  const roots = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 10 || f.indexOf("-", 6) === -1) continue; // not a well-formed entry: ignored, never trusted
    if (unescape(f[4]) === "/data") roots.push(unescape(f[3]));
  }
  if (roots.length === 1) return { found: roots[0] };
  return { found: undefined, note: roots.length ? `${roots.length} mounts at /data: ${JSON.stringify(roots)}` : "no mount at /data" };
}

function dbFile() {
  try {
    return fs.statSync(REQUIRED.db_file).isFile() ? { found: REQUIRED.db_file } : { found: undefined, note: "not a regular file" };
  } catch (e) {
    return { found: undefined, note: e.code || e.message };
  }
}

async function appName() {
  let addrs;
  try {
    addrs = await withTimeout(dns.promises.lookup("app", { all: true }), 5000, 'lookup of "app"');
  } catch (e) {
    return { found: undefined, note: `lookup of "app" failed: ${e.code || e.message}` };
  }
  if (!Array.isArray(addrs) || addrs.length !== 1 || typeof addrs[0]?.address !== "string") {
    return { found: undefined, note: `"app" must resolve to exactly one address, got ${JSON.stringify(addrs)}` };
  }
  const ip = addrs[0].address;
  let names;
  try {
    names = await withTimeout(dns.promises.reverse(ip), 5000, `reverse lookup of ${ip}`);
  } catch (e) {
    return { found: undefined, note: `reverse lookup of ${ip} failed: ${e.code || e.message}` };
  }
  if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== "string") {
    return { found: undefined, note: `${ip} must reverse-resolve to exactly one name, got ${JSON.stringify(names)}` };
  }
  return { found: names[0], ip };
}

for (const k of Object.keys(process.env).filter((k) => k.startsWith("MGPL_TARGET_"))) {
  log(`IGNORED ${k}: target values from the caller are not read`);
}
const observed = { data_mount_root: dataMountRoot(), db_file: dbFile(), app_name: await appName() };
const failed = [];
for (const [k, want] of Object.entries(REQUIRED)) {
  const { found, note } = observed[k];
  log(`TARGET ${k}: found ${found === undefined ? "(none)" : JSON.stringify(found)}, required ${JSON.stringify(want)}${note ? ` (${note})` : ""}`);
  if (found !== want) failed.push(k);
}
if (failed.length) {
  for (const k of failed) log(`TARGET_FAIL ${k}`);
  log("ABORT: target is not shown to be preprod; database not opened, nothing registered, no lock taken");
  process.exit(2);
}
const APP_IP = observed.app_name.ip;
log(`TARGET verified as preprod by the helper itself: ${Object.values(REQUIRED).join(" ")} (app at ${APP_IP})`);

const N = Number(process.env.N);
if (!Number.isInteger(N) || N < 1) {
  log(`ABORT: N must be a positive integer, got ${JSON.stringify(process.env.N)}`);
  process.exit(7);
}
const BASE = `http://${APP_IP}:4000`;

const require = createRequire("/app/package.json");
const Database = require("better-sqlite3");
// fileMustExist: never create a database at the wrong path.
const db = new Database(REQUIRED.db_file, { fileMustExist: true });
db.pragma("busy_timeout = 10000");

const cols = db.prepare('PRAGMA table_info("AppTracking")').all().map((c) => c.name.toLowerCase());
const need = ["targettdp", "targetfps", "resolution", "cpuboost", "tuningnotes", "playnotes", "achievementnotes", "tags"];
const missing = need.filter((c) => !cols.includes(c));
log(`tuning columns missing=${JSON.stringify(missing)}`);
if (missing.length) {
  log("ABORT: ensureTuningColumns() would write under the lock");
  process.exit(4);
}
const countProbe = () =>
  db.prepare("SELECT COUNT(*) AS n FROM AppTracking WHERE GameID LIKE 'ai056-probe-%'").get().n;
const rowsBefore = countProbe();
log(`probe rows before=${rowsBefore}`);

const email = `ai056-probe-${Date.now()}@example.invalid`;
log(`REGISTER_ATTEMPT account=${email}`);
let cookie;
try {
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: randomBytes(18).toString("base64url") }),
    signal: AbortSignal.timeout(15000),
  });
  cookie = (reg.headers.get("set-cookie") || "").match(/mgpl_session=([^;]+)/)?.[1];
  log(`register status=${reg.status} account=${email} session=${cookie ? "yes" : "no"}`);
} catch (e) {
  log(`register ended without response: ${e.name} ${e.cause?.code || e.message}`);
}
if (!cookie) process.exit(3);

db.exec("BEGIN IMMEDIATE");
log(`LOCK_HELD BEGIN IMMEDIATE on ${REQUIRED.db_file}`);

const profiles = Array.from({ length: N }, (_, i) => ({
  gameId: `ai056-probe-${String(i + 1).padStart(6, "0")}`,
  targetTdp: "15W",
  targetFps: "60",
}));
const body = JSON.stringify({ profiles });
const sent = Date.now();
let shutdown503 = false;
log(`REQUEST_SENT restore-tuning profiles=${N} bytes=${body.length}`);
try {
  const r = await fetch(`${BASE}/api/games/backup/restore-tuning`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `mgpl_session=${cookie}` },
    body,
    signal: AbortSignal.timeout(HOLD_MS),
  });
  const text = await r.text();
  shutdown503 = r.status === 503 && text.includes("Server is shutting down");
  log(`restore response status=${r.status} after ${Date.now() - sent} ms body=${text.slice(0, 200)}`);
} catch (e) {
  log(`restore request ended without response after ${Date.now() - sent} ms: ${e.name} ${e.cause?.code || e.message}`);
}

const rest = HOLD_MS - (Date.now() - t0);
if (rest > 0) await new Promise((r) => setTimeout(r, rest));
db.exec("ROLLBACK");
log("LOCK_RELEASED ROLLBACK");
const rowsAfter = countProbe();
log(`probe rows after=${rowsAfter}`);
db.close();

if (!shutdown503) {
  log("FAIL: the restore did not end with the 503 shutdown response");
  process.exit(5);
}
if (rowsAfter !== rowsBefore) {
  log(`FAIL: probe rows changed from ${rowsBefore} to ${rowsAfter}`);
  process.exit(6);
}
