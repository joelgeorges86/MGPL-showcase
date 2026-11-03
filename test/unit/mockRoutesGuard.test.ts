import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// AI-081 (#160): the test-data routes must answer 404 outside test mode,
// before any handler touches the database. The database module is replaced
// so that this suite never opens SQLite; any call into it fails the test.
const dbCalls: string[] = [];
vi.mock("../../src/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        dbCalls.push(String(prop));
        throw new Error(`database touched: ${String(prop)}`);
      },
    },
  ),
}));

type Captured = { status: number; body: unknown; nextCalled: boolean };

async function call(method: string, url: string): Promise<Captured> {
  const { default: router } = await import("../../src/routes/mock");
  return new Promise((resolve) => {
    const captured: Captured = { status: 200, body: undefined, nextCalled: false };
    const req = { method, url, originalUrl: url, path: url, headers: {}, body: {} };
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: unknown) {
        captured.body = body;
        resolve(captured);
        return res;
      },
    };
    (router as any)(req, res, () => {
      captured.nextCalled = true;
      resolve(captured);
    });
  });
}

describe("mock routes guard (AI-081)", () => {
  // Load the router once, with a generous limit, before the timed tests: a cold
  // import of the route and its dependencies can take several seconds on a
  // loaded machine (WU-011 gate run, 2026-10-06). The tests still re-import it
  // after vi.resetModules(), which is then fast because the transform is cached.
  beforeAll(async () => {
    await import("../../src/routes/mock");
  }, 60_000);

  const original = process.env.NODE_ENV;

  beforeEach(() => {
    dbCalls.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  for (const env of ["production", "staging", "development"]) {
    it(`answers 404 for every route, and an unknown path, when NODE_ENV=${env}`, async () => {
      process.env.NODE_ENV = env;
      for (const [method, url] of [
        ["POST", "/seed"],
        ["DELETE", "/clear"],
        ["GET", "/status"],
        ["POST", "/upstream"],
        ["POST", "/breaker/reset"],
        ["GET", "/no-such-route"],
      ]) {
        const r = await call(method, url);
        expect(r.status, `${method} ${url}`).toBe(404);
        expect(r.body).toEqual({ success: false, error: "Not available outside test mode" });
      }
      expect(dbCalls).toEqual([]);
    });
  }

  it("reports the bar as enabled in test mode", async () => {
    process.env.NODE_ENV = "test";
    const r = await call("GET", "/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, enabled: true });
    expect(dbCalls).toEqual([]);
  });

  it("mockRoutesEnabled() is true only for NODE_ENV=test", async () => {
    const { mockRoutesEnabled } = await import("../../src/routes/mock");
    process.env.NODE_ENV = "test";
    expect(mockRoutesEnabled()).toBe(true);
    for (const env of ["production", "staging", "development", ""]) {
      process.env.NODE_ENV = env;
      expect(mockRoutesEnabled()).toBe(false);
    }
  });
});
