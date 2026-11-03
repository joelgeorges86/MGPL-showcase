import type { Server } from "http";
import { SHUTDOWN_BUSY_TIMEOUT_MS, type CloseAllResult, type ShortenResult } from "./dbHandles";

// AI-043: graceful shutdown on SIGTERM / SIGINT.
//
// In the container Node runs as PID 1. Node's built-in SIGTERM handling re-raises
// the signal with the default action, which the kernel never applies to a PID
// namespace's init, so without an application handler SIGTERM is ignored and
// Docker kills the process after its 10 s grace period (exit 137).
//
// Order: shorten every SQLite handle's busy timeout, stop accepting connections,
// drop idle keep-alive sockets, let in-flight requests finish for at most
// drainTimeoutMs, close every SQLite handle, exit.
//
// The drain deadline is a timer on the same event loop that runs better-sqlite3's
// synchronous calls, so a call waiting on a lock delays it by the whole wait.
// Shortening the busy timeout first caps that delay at SHUTDOWN_BUSY_TIMEOUT_MS for
// each call made during the drain. It cannot shorten a call already waiting when the
// signal arrives: the handler only runs once that call returns.
//
// AI-056: the handler also only runs once the synchronous callback containing that
// call returns. A loop of per-item writes, each catching its own error, is one such
// callback, and its length follows its input, so no stop grace period covers it.
// Those loops await shutdownCheckpoint() between items and take at most one lock
// per item (BEGIN IMMEDIATE), so shutdown waits for one call plus the drain.

export const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

let shutdownStarted = false;

export function isShuttingDown(): boolean {
  return shutdownStarted;
}

// Test-only: the flag is process-wide, and each test builds its own handler.
export function resetShutdownStateForTests(): void {
  shutdownStarted = false;
}

// Client-facing message for a request cut short by shutdown. Every interrupted
// loop is idempotent per item, so retrying the whole request is safe.
export const SHUTDOWN_RETRY_MESSAGE = "Server is shutting down; retry the request";

export class ShutdownInProgressError extends Error {
  constructor() {
    super("Server is shutting down");
    this.name = "ShutdownInProgressError";
  }
}

// Gives a pending SIGTERM / SIGINT handler its turn, then rejects with
// ShutdownInProgressError once shutdown has started. libuv delivers signals in the
// poll phase. One setImmediate queued from an I/O callback runs in the same loop
// iteration's check phase, before any later poll, so a signal that arrived during
// the previous item would not be seen yet. The second hop crosses a poll phase.
export function shutdownCheckpoint(): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() =>
      setImmediate(() => (shutdownStarted ? reject(new ShutdownInProgressError()) : resolve())),
    );
  });
}

export interface ShutdownDeps {
  server: Server;
  closeDatabases: () => CloseAllResult;
  shortenBusyTimeouts: () => ShortenResult;
  drainTimeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: NodeJS.Signals) => void {
  const {
    server,
    closeDatabases,
    shortenBusyTimeouts,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    exit = (code: number) => process.exit(code),
    log = (message: string) => console.log(message),
  } = deps;

  let shuttingDown = false;
  let exited = false;
  let drainTimer: NodeJS.Timeout | undefined;

  // A request in flight at close() leaves its keep-alive socket idle once the
  // response finishes, and nothing else would close it before the drain timeout.
  server.on("request", (_req, res) => {
    res.on("finish", () => {
      if (shuttingDown) setImmediate(() => server.closeIdleConnections());
    });
  });

  const finish = (code: number, reason: string): void => {
    if (exited) return;
    exited = true;
    if (drainTimer) clearTimeout(drainTimer);
    let result: CloseAllResult = { registered: 0, closed: 0, failed: 0 };
    let threw = false;
    try {
      result = closeDatabases();
    } catch {
      threw = true;
    }
    // Assert the invariant, not a count: every registered handle is closed now.
    // A handle closed early or failing to close breaks it and exits non-zero.
    const clean = !threw && result.failed === 0 && result.closed === result.registered;
    const exitCode = clean ? code : 1;
    log(
      `[shutdown] ${reason}; closed ${result.closed} of ${result.registered} registered ` +
        `SQLite handle(s), ${result.failed} failed${threw ? ", closeDatabases threw" : ""}; ` +
        `exiting ${exitCode}`,
    );
    exit(exitCode);
  };

  return (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second signal must never re-enter the drain or leave the process hanging.
      finish(1, `${signal} received during shutdown, forcing exit`);
      return;
    }
    shuttingDown = true;
    shutdownStarted = true;
    const startedAt = Date.now();
    let busyTimeouts: string;
    try {
      const result = shortenBusyTimeouts();
      busyTimeouts =
        `SQLite busy timeout ${SHUTDOWN_BUSY_TIMEOUT_MS} ms on ${result.shortened} of ` +
        `${result.registered} registered handle(s), ${result.failed} failed`;
    } catch {
      busyTimeouts = "SQLite busy timeout not shortened";
    }
    log(
      `[shutdown] ${signal} received; ${busyTimeouts}; ` +
        `draining HTTP connections (max ${drainTimeoutMs} ms)`,
    );

    drainTimer = setTimeout(() => {
      server.closeAllConnections();
      finish(0, `drain timeout after ${drainTimeoutMs} ms, remaining connections destroyed`);
    }, drainTimeoutMs);

    server.close(() => finish(0, `HTTP server closed after ${Date.now() - startedAt} ms`));
    // Idle keep-alive sockets would otherwise hold server.close() open.
    server.closeIdleConnections();
  };
}

export function installShutdownHandlers(deps: ShutdownDeps): (signal: NodeJS.Signals) => void {
  const handler = createShutdownHandler(deps);
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return handler;
}
