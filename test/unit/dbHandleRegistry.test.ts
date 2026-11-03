import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// AI-043: every SQLite handle opened while the app's modules load must be in the
// shutdown registry, or shutdown cannot close it. The better-sqlite3 constructor
// is replaced by a recorder, so no real database is opened (the unit layer must
// not open SQLite). What is asserted is the invariant, not a count: a module that
// opens a handle without openDatabase() makes constructed exceed registered.

const constructed = vi.hoisted(() => [] as Array<{ open: boolean }>);

vi.mock("better-sqlite3", () => {
  // db.ts runs initDb() at load, so the stand-in answers queries with empty
  // results. Only construction and close are under test.
  const statement = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => [],
    iterate: () => [][Symbol.iterator](),
    pluck: () => statement,
    raw: () => statement,
    expand: () => statement,
  };
  class RecordingDatabase {
    open = true;
    constructor() {
      constructed.push(this);
    }
    close() {
      this.open = false;
    }
    pragma() {
      return [];
    }
    prepare() {
      return statement;
    }
    exec() {
      return this;
    }
    transaction<T extends (...args: unknown[]) => unknown>(fn: T) {
      return fn;
    }
    function() {
      return this;
    }
  }
  return { default: RecordingDatabase };
});

describe("SQLite handle registry at module load", () => {
  it("registers every handle opened by db.ts and the route modules", async () => {
    process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mgpl-reg-")), "x.db");
    const { closeAllDatabases } = await import("../../src/lib/dbHandles");

    const dbLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("../../src/db");
    expect(dbLog).toHaveBeenCalledWith(expect.stringContaining("auditRows=0."));
    dbLog.mockRestore();

    const routesDir = path.resolve(__dirname, "../../src/routes");
    for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith(".ts"))) {
      await import(path.join(routesDir, file));
    }

    expect(constructed.length).toBeGreaterThan(0);
    const result = closeAllDatabases();
    expect(result).toEqual({
      registered: constructed.length,
      closed: constructed.length,
      failed: 0,
    });
    expect(constructed.filter((h) => h.open)).toHaveLength(0);
  }, 60_000);
});
