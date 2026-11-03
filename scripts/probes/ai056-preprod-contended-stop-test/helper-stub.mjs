// Test-only preload for ai056-preprod-contended-stop-test/helper-cases.mjs:
//   node --import ./helper-stub.mjs ../ai056-preprod-contended-stop-helper.mjs
// Supplies what the helper observes, from the scenario in AI056_STUB (JSON), and
// records every side effect the helper attempts in the file AI056_STUB_EVENTS, one
// per line. The helper has no switch for any of this; it is intercepted from
// outside, the way the helper would see a real container.
//
// Scenario: { mountinfo: "<text>" | {error: "EACCES"},
//             dbFile: "file" | "dir" | "missing",
//             lookup: ["<ip>", ...] | {error: "ENOTFOUND"} | "hang" | <anything else, returned as is>,
//             reverse: ["<name>", ...] | {error: "ENOTFOUND"} | "hang" | <anything else> }
// Events: "load <module>" (better-sqlite3 is never really loaded), "fetch <url>",
// "docker-socket <how>" (any attempt to reach /var/run/docker.sock).
import fs from "node:fs";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import Module from "node:module";

const stub = JSON.parse(process.env.AI056_STUB || "{}");
const eventsFile = process.env.AI056_STUB_EVENTS;
const appendFileSync = fs.appendFileSync;
const event = (e) => eventsFile && appendFileSync(eventsFile, `${e}\n`);
const err = (code) => Object.assign(new Error(`stub ${code}`), { code });
const SOCKET = "/var/run/docker.sock";

const readFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (p === SOCKET) event("docker-socket read");
  if (p !== "/proc/self/mountinfo") return readFileSync.call(this, p, ...rest);
  if (stub.mountinfo && typeof stub.mountinfo === "object") throw err(stub.mountinfo.error);
  return stub.mountinfo;
};
const statSync = fs.statSync;
fs.statSync = function (p, ...rest) {
  if (p === SOCKET) event("docker-socket stat");
  if (p !== "/data/mgpl-preprod.db") return statSync.call(this, p, ...rest);
  if (stub.dbFile === "missing") throw err("ENOENT");
  return { isFile: () => stub.dbFile === "file", isDirectory: () => stub.dbFile === "dir" };
};

const answer = (v) => {
  if (v === "hang") return new Promise(() => {});
  if (v && typeof v === "object" && !Array.isArray(v) && v.error) return Promise.reject(err(v.error));
  return Promise.resolve(v);
};
dns.promises.lookup = async (name, opts) => {
  if (name !== "app") throw err("ENOTFOUND");
  const v = await answer(stub.lookup);
  return Array.isArray(v) && opts?.all ? v.map((address) => (typeof address === "string" ? { address, family: 4 } : address)) : v;
};
dns.promises.reverse = async () => answer(stub.reverse);

const request = http.request;
http.request = function (opts, ...rest) {
  if (opts && opts.socketPath === SOCKET) event("docker-socket http");
  return request.call(this, opts, ...rest);
};
const connect = net.connect;
net.connect = net.createConnection = function (opts, ...rest) {
  if ((opts && opts.path === SOCKET) || opts === SOCKET) event("docker-socket connect");
  return connect.call(this, opts, ...rest);
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "better-sqlite3") {
    event("load better-sqlite3");
    throw err("STUB_NO_DATABASE");
  }
  return load.call(this, request, ...rest);
};
globalThis.fetch = async (url) => {
  event(`fetch ${url}`);
  throw err("STUB_NO_NETWORK");
};
