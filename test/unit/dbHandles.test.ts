import { describe, expect, it } from "vitest";
import {
  closeAllDatabases,
  shortenBusyTimeouts,
  SHUTDOWN_BUSY_TIMEOUT_MS,
  trackHandle,
} from "../../src/lib/dbHandles";

// AI-043: fake handles only — the unit layer must not open SQLite.

function fakeHandle(opts: { open?: boolean; throws?: boolean; pragmaThrows?: boolean } = {}) {
  const handle = {
    open: opts.open ?? true,
    closeCalls: 0,
    pragmas: [] as string[],
    pragma(source: string) {
      if (opts.pragmaThrows) throw new Error("connection is busy");
      handle.pragmas.push(source);
    },
    close() {
      handle.closeCalls++;
      if (opts.throws) throw new Error("close failed");
      handle.open = false;
    },
  };
  return handle;
}

describe("dbHandles", () => {
  it("closes every open tracked handle and skips ones already closed", () => {
    const a = trackHandle(fakeHandle());
    const b = trackHandle(fakeHandle());
    const alreadyClosed = trackHandle(fakeHandle({ open: false }));

    expect(closeAllDatabases()).toEqual({ registered: 3, closed: 2, failed: 0 });
    expect(a.open).toBe(false);
    expect(b.open).toBe(false);
    expect(alreadyClosed.closeCalls).toBe(0);
  });

  it("keeps closing after a failure and reports the failure count", () => {
    const bad = trackHandle(fakeHandle({ throws: true }));
    const good = trackHandle(fakeHandle());

    expect(closeAllDatabases()).toEqual({ registered: 2, closed: 1, failed: 1 });
    expect(bad.closeCalls).toBe(1);
    expect(good.open).toBe(false);
  });

  it("clears the registry so a second call closes nothing", () => {
    const handle = trackHandle(fakeHandle());
    closeAllDatabases();

    expect(closeAllDatabases()).toEqual({ registered: 0, closed: 0, failed: 0 });
    expect(handle.closeCalls).toBe(1);
  });

  it("shortens the busy timeout on every open tracked handle and counts failures", () => {
    const a = trackHandle(fakeHandle());
    const busy = trackHandle(fakeHandle({ pragmaThrows: true }));
    const closed = trackHandle(fakeHandle({ open: false }));

    expect(shortenBusyTimeouts()).toEqual({ registered: 3, shortened: 1, failed: 1 });
    expect(a.pragmas).toEqual([`busy_timeout = ${SHUTDOWN_BUSY_TIMEOUT_MS}`]);
    expect(closed.pragmas).toEqual([]);
    // Shortening does not unregister: shutdown still closes every handle afterwards.
    expect(closeAllDatabases()).toEqual({ registered: 3, closed: 2, failed: 0 });
    expect(busy.open).toBe(false);
  });
});
