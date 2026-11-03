// Helper cases for ai056-preprod-contended-stop-test/run.sh. Runs the real helper
// under node with helper-stub.mjs preloaded, one scenario per case.
//   B  behaviour: exit code; no side effect for a refusal (no module load, no
//      fetch); never any attempt on the Docker socket; finishing within 20 s.
//      A positive control shows the side-effect recording works.
//   F  format: the exact set of TARGET_FAIL markers.
// Exits nonzero if any case fails.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = process.env.HELPER || path.join(here, "..", "ai056-preprod-contended-stop-helper.mjs");
const preload = pathToFileURL(path.join(here, "helper-stub.mjs")).href;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ai056-helper-"));

const mi = (root, at = "/data") =>
  `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n515 506 8:1 ${root} ${at} rw,relatime master:1 - ext4 /dev/sda1 rw\n`;
const good = {
  mountinfo: mi("/opt/mgpl/data-preprod"),
  dbFile: "file",
  lookup: ["172.18.0.2"],
  reverse: ["mgpl-preprod-app.mgpl-preprod_default"],
};
const testEnv = {
  mountinfo: mi("/opt/mgpl/data-test"),
  dbFile: "missing",
  lookup: ["172.20.0.2"],
  reverse: ["mgpl-test-app.mgpl-test_default"],
};
const ALL = ["app_name", "data_mount_root", "db_file"];
const CALLER_VALUES = {
  MGPL_TARGET_DOPPLER_CONFIG: "preprod",
  MGPL_TARGET_COMPOSE_PROJECT: "mgpl-preprod",
  MGPL_TARGET_DB_PATH: "/data/mgpl-preprod.db",
  MGPL_TARGET_DATA_SOURCE: "/opt/mgpl/data-preprod",
  MGPL_TARGET_NETWORK: "mgpl-preprod_default",
  DOPPLER_CONFIG: "preprod",
  DB_PATH: "/data/mgpl-preprod.db",
};

// [name, scenario, expected exit, expected TARGET_FAIL markers, extra env, expected events]
const refuse = (name, scenario, fails, env = {}) => [name, scenario, 2, fails, env, []];
const cases = [
  refuse("mountinfo-unreadable", { ...good, mountinfo: { error: "EACCES" } }, ["data_mount_root"]),
  refuse("mountinfo-malformed", { ...good, mountinfo: "garbage\n\x00\x01 not mountinfo\n" }, ["data_mount_root"]),
  refuse("mountinfo-not-text", { ...good, mountinfo: 42 }, ["data_mount_root"]),
  refuse("mountinfo-no-data-mount", { ...good, mountinfo: "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n" }, ["data_mount_root"]),
  refuse("mountinfo-two-data-mounts", { ...good, mountinfo: mi("/opt/mgpl/data-preprod") + mi("/opt/mgpl/data-test").split("\n")[1] + "\n" }, ["data_mount_root"]),
  refuse("mount-root-test-env", { ...good, mountinfo: mi("/opt/mgpl/data-test") }, ["data_mount_root"]),
  refuse("mount-root-near-preprod2", { ...good, mountinfo: mi("/opt/mgpl/data-preprod2") }, ["data_mount_root"]),
  refuse("mount-root-escaped-space", { ...good, mountinfo: mi("/opt/mgpl/data\\040preprod") }, ["data_mount_root"]),
  refuse("mount-root-not-host-path", { ...good, mountinfo: mi("/data") }, ["data_mount_root"]),
  refuse("db-file-missing", { ...good, dbFile: "missing" }, ["db_file"]),
  refuse("db-file-is-directory", { ...good, dbFile: "dir" }, ["db_file"]),
  refuse("lookup-fails", { ...good, lookup: { error: "ENOTFOUND" } }, ["app_name"]),
  refuse("lookup-server-failure", { ...good, lookup: { error: "ESERVFAIL" } }, ["app_name"]),
  refuse("lookup-hangs", { ...good, lookup: "hang" }, ["app_name"]),
  refuse("lookup-two-addresses", { ...good, lookup: ["172.18.0.2", "172.18.0.3"] }, ["app_name"]),
  refuse("lookup-malformed", { ...good, lookup: "not-an-array" }, ["app_name"]),
  refuse("reverse-server-failure", { ...good, reverse: { error: "ESERVFAIL" } }, ["app_name"]),
  refuse("reverse-hangs", { ...good, reverse: "hang" }, ["app_name"]),
  refuse("reverse-empty", { ...good, reverse: [] }, ["app_name"]),
  refuse("reverse-two-names", { ...good, reverse: ["mgpl-preprod-app.mgpl-preprod_default", "other.mgpl-preprod_default"] }, ["app_name"]),
  refuse("reverse-malformed", { ...good, reverse: [42] }, ["app_name"]),
  refuse("reverse-null", { ...good, reverse: null }, ["app_name"]),
  refuse("reverse-near-network", { ...good, reverse: ["mgpl-preprod-app.mgpl-preprod_default2"] }, ["app_name"]),
  refuse("reverse-trailing-dot", { ...good, reverse: ["mgpl-preprod-app.mgpl-preprod_default."] }, ["app_name"]),
  refuse("reverse-test-env", { ...good, reverse: ["mgpl-test-app.mgpl-test_default"] }, ["app_name"]),
  refuse("production-like", { mountinfo: mi("/opt/mgpl/data", "/app/data"), dbFile: "missing", lookup: ["172.19.0.2"], reverse: ["mgpl-app.mgpl_default"] }, ALL),
  refuse("test-env", testEnv, ALL),
  // The caller hands over every preprod value it could; the helper must not read them.
  refuse("caller-supplies-preprod-values-target-is-test", testEnv, ALL, CALLER_VALUES),
  ["verified-then-bad-n", good, 7, [], { N: "0" }, []],
  // Positive control: a verified target goes on to the database, and the recording sees it.
  ["positive-control-verified-reaches-database", good, 1, [], {}, ["load better-sqlite3"]],
];

let failed = 0, failedB = 0;
for (const [name, scenario, want, wantFails, env, wantEvents] of cases) {
  const eventsFile = path.join(work, `${name}.events`);
  fs.writeFileSync(eventsFile, "");
  const r = spawnSync(process.execPath, ["--import", preload, helper], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, N: "65", ...env, AI056_STUB: JSON.stringify(scenario), AI056_STUB_EVENTS: eventsFile },
    encoding: "utf8",
    timeout: 20000,
  });
  const out = `${r.stdout}${r.stderr}`;
  const events = fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
  const b = [], f = [];
  if (r.error?.code === "ETIMEDOUT") b.push("hung (case bound 20 s)");
  if (r.status !== want) b.push(`exit=${r.status} (want ${want})`);
  if (events.some((e) => e.startsWith("docker-socket"))) b.push(`used the Docker socket: ${events.filter((e) => e.startsWith("docker-socket")).join(", ")}`);
  const sideEffects = events.filter((e) => !e.startsWith("docker-socket"));
  if (JSON.stringify(sideEffects) !== JSON.stringify(wantEvents)) b.push(`side effects ${JSON.stringify(sideEffects)} (want ${JSON.stringify(wantEvents)})`);
  const gotFails = [...out.matchAll(/TARGET_FAIL (\S+)/g)].map((m) => m[1]).sort();
  if (JSON.stringify(gotFails) !== JSON.stringify([...wantFails].sort())) f.push(`TARGET_FAIL ${JSON.stringify(gotFails)} (want ${JSON.stringify(wantFails)})`);
  if (b.length || f.length) {
    failed++;
    if (b.length) failedB++;
    console.log(`FAIL  ${name.padEnd(46)}${b.length ? ` B: ${b.join("; ")}` : ""}${f.length ? ` F: ${f.join("; ")}` : ""}`);
    if (process.env.VERBOSE) console.log(out.replace(/^/gm, "      | "));
  } else {
    console.log(`PASS  ${name.padEnd(46)} exit=${r.status}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`helper cases passed: ${cases.length - failed}; failed: ${failed} (for a defect, B: ${failedB})`);
process.exit(failed ? 1 : 0);
