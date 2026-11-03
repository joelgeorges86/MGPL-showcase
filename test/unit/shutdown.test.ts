import http from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeAllDatabases,
  shortenBusyTimeouts,
  SHUTDOWN_BUSY_TIMEOUT_MS,
  trackHandle,
} from "../../src/lib/dbHandles";
import {
  createShutdownHandler,
  installShutdownHandlers,
  isShuttingDown,
  resetShutdownStateForTests,
  shutdownCheckpoint,
  ShutdownInProgressError,
} from "../../src/lib/shutdown";

// AI-043: exercises the shutdown handler against a real HTTP server, because
// idle keep-alive sockets are what actually hold server.close() open.

type Harness = {
  server: http.Server;
  port: number;
  exit: ReturnType<typeof vi.fn>;
  closeDatabases: ReturnType<typeof vi.fn>;
  shortenBusyTimeouts: ReturnType<typeof vi.fn>;
  exited: Promise<number>;
};

const servers: http.Server[] = [];

async function startServer(
  handler: http.RequestListener,
  closeResult = { registered: 3, closed: 3, failed: 0 },
): Promise<Harness> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const exit = vi.fn((code: number) => resolveExit(code));
  const closeDatabases = vi.fn(() => closeResult);
  const shortenBusyTimeouts = vi.fn(() => ({
    registered: closeResult.registered,
    shortened: closeResult.registered,
    failed: 0,
  }));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    exit,
    closeDatabases,
    shortenBusyTimeouts,
    exited,
  };
}

// Stands in for a better-sqlite3 handle whose write contends for a lock another
// connection holds and never releases (Litestream checkpointing, a script). As in
// SQLite's busy handler, the write waits for the handle's current busy timeout and
// then throws SQLITE_BUSY. better-sqlite3 is synchronous, so the wait blocks the
// event loop, and every timer on it, for its whole length.
function contendedHandle(busyTimeoutMs: number) {
  const handle = {
    open: true,
    busyTimeoutMs,
    pragma(source: string) {
      const match = /^busy_timeout = (\d+)$/.exec(source);
      if (match) handle.busyTimeoutMs = Number(match[1]);
    },
    write() {
      const until = Date.now() + handle.busyTimeoutMs;
      while (Date.now() < until) {
        /* blocked on the lock */
      }
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    },
    close() {
      handle.open = false;
    },
  };
  return handle;
}

// #180: a test that signals while a request is in flight must wait until the server's
// request handler has started. A socket whose request is not yet parsed counts as idle,
// so closeIdleConnections() would destroy it, and the request would fail with
// ECONNRESET instead of being in flight. A fixed timer cannot guarantee that the
// request has been parsed on a loaded machine; this promise can.
function handlerEntered(): { entered: Promise<void>; enter: () => void } {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  return { entered, enter };
}

function get(
  port: number,
  agent: http.Agent,
  path = "/",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

afterEach(() => {
  resetShutdownStateForTests();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("createShutdownHandler", () => {
  it("exits 0 promptly with an idle keep-alive connection open", async () => {
    const h = await startServer((_req, res) => res.end("ok"));
    const agent = new http.Agent({ keepAlive: true });
    await get(h.port, agent);

    const started = Date.now();
    createShutdownHandler({ ...h, drainTimeoutMs: 5000, log: () => {} })("SIGTERM");

    await expect(h.exited).resolves.toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.closeDatabases).toHaveBeenCalledTimes(1);
    agent.destroy();
  });

  it("lets an in-flight request finish before closing the databases", async () => {
    const order: string[] = [];
    const { entered, enter } = handlerEntered();
    const h = await startServer((_req, res) => {
      enter();
      setTimeout(() => {
        order.push("response");
        res.end("done");
      }, 150);
    });
    h.closeDatabases.mockImplementation(() => {
      order.push("closeDatabases");
      return { registered: 3, closed: 3, failed: 0 };
    });
    // Installed before traffic arrives, as in src/index.ts.
    const handler = createShutdownHandler({ ...h, drainTimeoutMs: 5000, log: () => {} });
    const agent = new http.Agent({ keepAlive: true });
    const pending = get(h.port, agent);
    await entered;

    const started = Date.now();
    handler("SIGTERM");

    await expect(pending).resolves.toEqual({ status: 200, body: "done" });
    await expect(h.exited).resolves.toBe(0);
    expect(order).toEqual(["response", "closeDatabases"]);
    // Must not wait out the drain timeout once the in-flight response is done.
    expect(Date.now() - started).toBeLessThan(1000);
    agent.destroy();
  });

  it("destroys a hung request at the drain timeout and still exits 0", async () => {
    const { entered, enter } = handlerEntered();
    const h = await startServer(() => {
      enter(); // never responds
    });
    const agent = new http.Agent({ keepAlive: true });
    const pending = get(h.port, agent).catch((err: Error) => err);
    await entered;

    const started = Date.now();
    createShutdownHandler({ ...h, drainTimeoutMs: 100, log: () => {} })("SIGTERM");

    await expect(h.exited).resolves.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(h.closeDatabases).toHaveBeenCalledTimes(1);
    expect(await pending).toBeInstanceOf(Error);
    agent.destroy();
  });

  it("forces exit 1 on a second signal and never exits twice", async () => {
    const { entered, enter } = handlerEntered();
    const h = await startServer(() => {
      enter(); // never responds
    });
    const agent = new http.Agent({ keepAlive: true });
    get(h.port, agent).catch(() => {});
    await entered;

    const handler = createShutdownHandler({ ...h, drainTimeoutMs: 200, log: () => {} });
    handler("SIGTERM");
    handler("SIGINT");

    await expect(h.exited).resolves.toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.closeDatabases).toHaveBeenCalledTimes(1);
    agent.destroy();
  });

  it("exits 1 when a database handle fails to close", async () => {
    const h = await startServer((_req, res) => res.end("ok"), {
      registered: 3,
      closed: 2,
      failed: 1,
    });
    const log = vi.fn();
    createShutdownHandler({ ...h, log })("SIGTERM");

    await expect(h.exited).resolves.toBe(1);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("closed 2 of 3 registered SQLite handle(s), 1 failed; exiting 1"),
    );
  });

  it("exits 1 when fewer handles close than are registered, even with no failure", async () => {
    // e.g. a registered handle closed early by other code: the invariant, not a
    // constant count, is what shutdown asserts.
    const h = await startServer((_req, res) => res.end("ok"), {
      registered: 15,
      closed: 14,
      failed: 0,
    });
    const log = vi.fn();
    createShutdownHandler({ ...h, log })("SIGTERM");

    await expect(h.exited).resolves.toBe(1);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("closed 14 of 15 registered SQLite handle(s), 0 failed; exiting 1"),
    );
  });

  it("logs both counts and exits 0 when every registered handle closes", async () => {
    const h = await startServer((_req, res) => res.end("ok"), {
      registered: 15,
      closed: 15,
      failed: 0,
    });
    const log = vi.fn();
    createShutdownHandler({ ...h, log })("SIGTERM");

    await expect(h.exited).resolves.toBe(0);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("closed 15 of 15 registered SQLite handle(s), 0 failed; exiting 0"),
    );
  });

  it("holds the drain bound when a write blocks the event loop on a lock during the drain", async () => {
    // db.ts's busy timeout. Before the fix the write below blocked the loop for all
    // of it, the drain deadline timer could not fire, and exit came at ~10.2 s.
    const handle = trackHandle(contendedHandle(10_000));
    const { entered, enter } = handlerEntered();
    const h = await startServer(() => {
      enter(); // never responds, so only the drain deadline ends the drain
    });
    const agent = new http.Agent({ keepAlive: true });
    const pending = get(h.port, agent).catch((err: Error) => err);
    await entered;

    const drainTimeoutMs = 300;
    const handler = createShutdownHandler({
      server: h.server,
      exit: h.exit,
      closeDatabases: closeAllDatabases,
      shortenBusyTimeouts,
      drainTimeoutMs,
      log: () => {},
    });
    const started = Date.now();
    handler("SIGTERM");

    // Work reaching SQLite mid-drain (an in-flight request, a scheduled job), timed
    // so its wait straddles the drain deadline.
    let writeError: unknown;
    setTimeout(() => {
      try {
        handle.write();
      } catch (err) {
        writeError = err;
      }
    }, 200);

    await expect(h.exited).resolves.toBe(0);
    const elapsed = Date.now() - started;
    expect(writeError).toMatchObject({ code: "SQLITE_BUSY" });
    // The deadline can be late by at most one shortened wait.
    expect(elapsed).toBeLessThan(drainTimeoutMs + SHUTDOWN_BUSY_TIMEOUT_MS + 500);
    expect(handle.open).toBe(false);
    expect(await pending).toBeInstanceOf(Error);
    agent.destroy();
  }, 30_000);

  it("shortens busy timeouts before draining and carries on if that throws", async () => {
    const h = await startServer((_req, res) => res.end("ok"));
    h.shortenBusyTimeouts.mockImplementation(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    createShutdownHandler({ ...h, log })("SIGTERM");

    await expect(h.exited).resolves.toBe(0);
    expect(h.shortenBusyTimeouts).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("busy timeout not shortened"));
  });

  it("exits 1 when closeDatabases throws", async () => {
    const h = await startServer((_req, res) => res.end("ok"));
    h.closeDatabases.mockImplementation(() => {
      throw new Error("boom");
    });
    createShutdownHandler({ ...h, log: () => {} })("SIGTERM");

    await expect(h.exited).resolves.toBe(1);
  });
});

describe("installShutdownHandlers", () => {
  it("registers the same handler for SIGTERM and SIGINT", async () => {
    const h = await startServer((_req, res) => res.end("ok"));
    const handler = installShutdownHandlers({ ...h, log: () => {} });
    try {
      expect(process.listeners("SIGTERM")).toContain(handler);
      expect(process.listeners("SIGINT")).toContain(handler);
    } finally {
      process.removeListener("SIGTERM", handler);
      process.removeListener("SIGINT", handler);
    }
  });
});

// AI-056: a loop of per-item writes, each catching its own error, is one synchronous
// stretch unless it yields. The SIGTERM handler, like the timer standing in for it
// here, only runs when the loop yields, so without a checkpoint shutdown waits for
// the whole payload.
describe("shutdownCheckpoint", () => {
  const ITEM_WAIT_MS = 50;
  const SIGNAL_AT_MS = 120;

  it("resolves before shutdown and rejects with ShutdownInProgressError after", async () => {
    const h = await startServer((_req, res) => res.end("ok"));
    await expect(shutdownCheckpoint()).resolves.toBeUndefined();
    expect(isShuttingDown()).toBe(false);

    createShutdownHandler({ ...h, log: () => {} })("SIGTERM");

    expect(isShuttingDown()).toBe(true);
    await expect(shutdownCheckpoint()).rejects.toBeInstanceOf(ShutdownInProgressError);
    await expect(h.exited).resolves.toBe(0);
  });

  it("without a checkpoint, a per-item write loop runs to the end before the handler runs", async () => {
    const handle = contendedHandle(ITEM_WAIT_MS);
    let written = 0;
    let writtenWhenSignalHandled = -1;
    setTimeout(() => (writtenWhenSignalHandled = written), SIGNAL_AT_MS);

    const items = 20;
    await (async () => {
      for (let i = 0; i < items; i++) {
        try {
          handle.write();
        } catch {
          // caught per item, as the routes do, so the loop carries on
        }
        written++;
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));

    expect(writtenWhenSignalHandled).toBe(items);
  });

  it("stops a per-item write loop after the item in progress when shutdown starts", async () => {
    const handle = contendedHandle(ITEM_WAIT_MS);
    const h = await startServer((_req, res) => res.end("ok"));
    const handler = createShutdownHandler({ ...h, drainTimeoutMs: 1000, log: () => {} });
    let written = 0;

    const started = Date.now();
    setTimeout(() => handler("SIGTERM"), SIGNAL_AT_MS);
    const loop = (async () => {
      for (let i = 0; i < 40; i++) {
        await shutdownCheckpoint();
        try {
          handle.write();
        } catch {
          // caught per item
        }
        written++;
      }
    })();

    await expect(loop).rejects.toBeInstanceOf(ShutdownInProgressError);
    const stoppedAfter = Date.now() - started;
    // Items finished before the signal, plus the one in progress when it landed.
    expect(written).toBeLessThanOrEqual(Math.ceil(SIGNAL_AT_MS / ITEM_WAIT_MS) + 1);
    expect(stoppedAfter).toBeLessThan(SIGNAL_AT_MS + 2 * ITEM_WAIT_MS + 250);
    await expect(h.exited).resolves.toBe(0);
  });
});
