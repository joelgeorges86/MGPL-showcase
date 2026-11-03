// AI-043 probe: does the shutdown drain stay bounded when SQLite lock contention
// blocks the event loop? Real SQLite, two OS processes, a real SIGTERM.
//
//   node scripts/probes/ai043-contended-shutdown.mjs <appDir> <scenario>
//
// <appDir> holds a build of the app (dist/lib/*.js and node_modules/better-sqlite3),
// e.g. /app inside the app image. Signals are POSIX-only: run it on Linux, e.g.
//   docker run --rm -v "$PWD/scripts/probes:/probes:ro" --entrypoint node <image> \
//     /probes/ai043-contended-shutdown.mjs /app drain
//
// The parent process holds a write lock on a scratch database from its own
// connection, standing in for Litestream's checkpoint or a script. The child runs
// the app's real shutdown handler and registry against the same file.
//
// Scenarios:
//   drain    SIGTERM with the event loop free; the child keeps writing during the
//            drain (a scheduled job, in-flight requests). A hung request holds the
//            drain open, so only the drain deadline can end it.
//   blocked  SIGTERM arrives while a write is already waiting on the lock, also with
//            a hung request. The handler cannot run until that write returns.
//   restore  AI-056. The child runs the app's real initDb() and the real
//            POST /api/games/backup/restore-tuning handler. SIGTERM arrives 1 s into
//            a restore of <profiles> profiles (default 65), whose loop writes once
//            or more per profile. <busy> is "shortened" (default: every registered
//            handle at SHUTDOWN_BUSY_TIMEOUT_MS before the request, the drain-time
//            state) or "app" (the app's own busy timeouts). <tables> "app" (default)
//            uses initDb()'s schema, where the handler's second candidate table,
//            AppTrackings, does not exist; "legacy" also creates it, as an older
//            database would have, adding one more contended UPDATE per profile.
//              node ... <appDir> restore [profiles] [shortened|app] [app|legacy]
//
// Nothing here touches an app database: the file lives in a fresh temp directory.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_BUSY_TIMEOUT_MS = 10000; // db.ts
const DRAIN_TIMEOUT_MS = 5000; // DEFAULT_DRAIN_TIMEOUT_MS
const WRITE_INTERVAL_MS = 500;

const [, , appDir, scenario, role, dbFile] = process.argv;
const appRequire = createRequire(path.join(path.resolve(appDir ?? "."), "package.json"));

if (role === "--child" && scenario === "restore") {
  runRestoreChild();
} else if (role === "--child") {
  runChild();
} else if (scenario === "restore") {
  const [profiles = "65", busy = "shortened", tables = "app"] = process.argv.slice(4);
  runRestoreParent(Number(profiles), busy, tables).catch((err) => {
    console.error(err);
    process.exit(2);
  });
} else {
  runParent().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

function runChild() {
  const dbHandles = appRequire("./dist/lib/dbHandles.js");
  const { installShutdownHandlers } = appRequire("./dist/lib/shutdown.js");
  const db = dbHandles.openDatabase(dbFile);
  db.pragma(`busy_timeout = ${APP_BUSY_TIMEOUT_MS}`);
  const insert = db.prepare("INSERT INTO probe (at) VALUES (?)");
  const write = (label) => {
    const started = Date.now();
    try {
      insert.run(Date.now());
      console.log(`[child] ${label} write ok after ${Date.now() - started} ms`);
    } catch (err) {
      console.log(`[child] ${label} write ${err.code} after ${Date.now() - started} ms`);
    }
  };

  const server = http.createServer((req, res) => {
    if (req.url === "/write") {
      write("request");
      res.end("done");
    }
    // Any other path hangs: it holds the drain open until the deadline.
  });
  server.listen(0, "127.0.0.1", () => {
    // Builds without shortenBusyTimeouts ignore the extra dependency.
    installShutdownHandlers({
      server,
      closeDatabases: dbHandles.closeAllDatabases,
      shortenBusyTimeouts: dbHandles.shortenBusyTimeouts,
    });
    if (scenario === "drain") {
      process.once("SIGTERM", () => {
        setInterval(() => write("drain"), WRITE_INTERVAL_MS);
      });
    }
    console.log(`READY ${server.address().port}`);
  });
}

async function runParent() {
  if (!appDir || !["drain", "blocked"].includes(scenario)) {
    throw new Error("usage: ai043-contended-shutdown.mjs <appDir> <drain|blocked>");
  }
  const Database = appRequire("better-sqlite3");
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai043-probe-"));
  const file = path.join(dir, "probe.db");
  const holder = new Database(file);
  holder.pragma("journal_mode = WAL");
  holder.exec("CREATE TABLE probe (at INTEGER)");

  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), appDir, scenario, "--child", file],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = [];
  let signalledAt = 0;
  const elapsed = () => (signalledAt ? Date.now() - signalledAt : 0);
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const ready = /^READY (\d+)$/.exec(line);
        if (ready) resolve(Number(ready[1]));
        else lines.push(`+${elapsed()} ms ${line}`);
      }
    });
    child.once("exit", () => reject(new Error("child exited before READY")));
  });

  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, ms: elapsed() })),
  );

  // Another connection takes the write lock and keeps it until the child is gone.
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO probe (at) VALUES (?)").run(Date.now());

  const agent = new http.Agent({ keepAlive: true });
  const request = (urlPath) =>
    http.get({ host: "127.0.0.1", port, path: urlPath, agent }).on("error", () => {});
  request("/hang");
  if (scenario === "blocked") request("/write");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  signalledAt = Date.now();
  child.kill("SIGTERM");
  const result = await exited;

  holder.exec("ROLLBACK");
  holder.close();
  agent.destroy();
  rmSync(dir, { recursive: true, force: true });

  for (const line of lines) console.log(line);
  console.log(
    `RESULT scenario=${scenario} exit=${result.code ?? result.signal} ` +
      `signal_to_exit_ms=${result.ms} drain_timeout_ms=${DRAIN_TIMEOUT_MS} ` +
      `app_busy_timeout_ms=${APP_BUSY_TIMEOUT_MS}`,
  );
}

// AI-056: the app's real restore-tuning handler, mounted as index.ts mounts it.
function runRestoreChild() {
  process.env.DB_PATH = dbFile;
  // Throwaway signing key for this scratch process only; the token never leaves it.
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.DISABLE_CRON = "true";
  const express = appRequire("express");
  const dbHandles = appRequire("./dist/lib/dbHandles.js");
  const { installShutdownHandlers } = appRequire("./dist/lib/shutdown.js");
  appRequire("./dist/db.js").initDb();
  const gamesRouter = appRequire("./dist/routes/games.js").default;
  const { generateToken } = appRequire("./dist/lib/auth.js");
  if (process.env.PROBE_BUSY === "shortened") dbHandles.shortenBusyTimeouts();

  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/games", gamesRouter);
  const server = app.listen(0, "127.0.0.1", () => {
    installShutdownHandlers({
      server,
      closeDatabases: dbHandles.closeAllDatabases,
      shortenBusyTimeouts: dbHandles.shortenBusyTimeouts,
    });
    const token = generateToken({ userId: "ai056-probe", email: "probe@invalid", role: "user" });
    console.log(`READY ${server.address().port} ${token}`);
  });
}

async function runRestoreParent(profiles, busy, tables) {
  if (
    !appDir ||
    !Number.isInteger(profiles) ||
    profiles < 1 ||
    !["shortened", "app"].includes(busy) ||
    !["app", "legacy"].includes(tables)
  ) {
    throw new Error(
      "usage: ai043-contended-shutdown.mjs <appDir> restore [profiles] [shortened|app] [app|legacy]",
    );
  }
  const Database = appRequire("better-sqlite3");
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai056-probe-"));
  const file = path.join(dir, "probe.db");

  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), appDir, "restore", "--child", file],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PROBE_BUSY: busy } },
  );
  const lines = [];
  let requestSentAt = 0;
  let signalledAt = 0;
  const elapsed = () => (signalledAt ? Date.now() - signalledAt : 0);
  const record = (line) => {
    // initDb's boot logging is noise here; keep what happens once the request is sent.
    if (requestSentAt && line.trim()) lines.push(`+${elapsed()} ms ${line}`);
  };
  let stderrBuffered = "";
  child.stderr.on("data", (chunk) => {
    stderrBuffered += chunk;
    let newline;
    while ((newline = stderrBuffered.indexOf("\n")) >= 0) {
      record(stderrBuffered.slice(0, newline));
      stderrBuffered = stderrBuffered.slice(newline + 1);
    }
  });
  const ready = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const match = /^READY (\d+) (\S+)$/.exec(line);
        if (match) resolve({ port: Number(match[1]), token: match[2] });
        else record(line);
      }
    });
    child.once("exit", () => reject(new Error("child exited before READY")));
  });

  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, ms: elapsed() })),
  );

  // Another connection takes the write lock and keeps it until the child is gone.
  const holder = new Database(file);
  if (tables === "legacy") {
    holder.exec(
      // Column names are case-insensitive, so GameID also satisfies "gameId".
      "CREATE TABLE IF NOT EXISTS AppTrackings (GameID TEXT, targetTdp TEXT, " +
        "targetFps TEXT, resolution TEXT, cpuBoost TEXT, tuningNotes TEXT)",
    );
  }
  holder.exec("BEGIN IMMEDIATE");

  const body = JSON.stringify(
    Array.from({ length: profiles }, (_, i) => ({
      gameID: `AI056-PROBE-${i}`,
      targetTdp: "15W",
      targetFps: "60",
      resolution: "1080p",
      cpuBoost: "Disabled",
      tuningNotes: "ai056 probe",
    })),
  );
  const agent = new http.Agent({ keepAlive: true });
  const response = new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: ready.port,
        method: "POST",
        path: "/api/games/backup/restore-tuning",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${ready.token}`,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text, ms: elapsed() }));
      },
    );
    req.on("error", (err) => resolve({ status: `error ${err.code}`, text: "", ms: elapsed() }));
    req.end(body);
  });
  requestSentAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  signalledAt = Date.now();
  child.kill("SIGTERM");
  const result = await exited;
  const restore = await response;

  holder.exec("ROLLBACK");
  holder.close();
  agent.destroy();
  rmSync(dir, { recursive: true, force: true });

  for (const line of lines) console.log(line);
  let summary = restore.text;
  try {
    const parsed = JSON.parse(restore.text);
    summary = JSON.stringify({
      ...parsed,
      errors: Array.isArray(parsed.errors) ? `${parsed.errors.length} error(s)` : parsed.errors,
    });
  } catch {
    // not JSON; print as-is
  }
  console.log(`+${restore.ms} ms restore response ${restore.status} ${summary}`);
  console.log(
    `RESULT scenario=restore profiles=${profiles} busy=${busy} tables=${tables} ` +
      `exit=${result.code ?? result.signal} ` +
      `signal_to_exit_ms=${result.ms} drain_timeout_ms=${DRAIN_TIMEOUT_MS}`,
  );
}
