import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// AI-084 (#163): /api/users account administration must be admin-only, and the
// check must run before any database access. The database module is replaced
// so that this suite never opens SQLite; any use of it is recorded and throws.
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

// Tokens are resolved without a real signing key: "user-token" is a signed-in
// user, "admin-token" an admin; anything else is invalid.
vi.mock("../../src/lib/auth", () => ({
  SESSION_COOKIE: "mgpl_session",
  verifyToken: (token: string) => {
    if (token === "user-token") return { userId: "u1", email: "u@x.io", role: "user" };
    if (token === "admin-token") return { userId: "a1", email: "a@x.io", role: "admin" };
    throw new Error("invalid token");
  },
  hashPassword: async () => "hash",
  clearSessionCookie: () => undefined,
}));

type Captured = { status: number; body: unknown; nextCalled: boolean };

async function call(
  method: string,
  url: string,
  token?: string,
  body: Record<string, unknown> = {},
): Promise<Captured> {
  const { default: router } = await import("../../src/routes/users");
  return new Promise((resolve) => {
    const captured: Captured = { status: 200, body: undefined, nextCalled: false };
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const req = { method, url, originalUrl: url, path: url, headers, body, cookies: {} };
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(payload: unknown) {
        captured.body = payload;
        resolve(captured);
        return res;
      },
      send(payload?: unknown) {
        captured.body = payload;
        resolve(captured);
        return res;
      },
      setHeader() {
        return res;
      },
      cookie() {
        return res;
      },
      clearCookie() {
        return res;
      },
    };
    (router as unknown as (rq: unknown, rs: unknown, nx: () => void) => void)(req, res, () => {
      captured.nextCalled = true;
      resolve(captured);
    });
  });
}

const ADMIN_ROUTES: Array<[string, string, Record<string, unknown>]> = [
  ["GET", "/", {}],
  ["GET", "/some-user-id", {}],
  ["POST", "/", { email: "new@x.io", password: "password123" }],
  ["PUT", "/some-user-id", { password: "password123" }],
  ["DELETE", "/some-user-id", {}],
];

describe("/api/users admin guard (AI-084)", () => {
  // Load the router once, with a generous limit, before the timed tests: a cold
  // import of the route and its dependencies can take several seconds on a
  // loaded machine (WU-011 gate run, 2026-10-06). The tests still re-import it
  // after vi.resetModules(), which is then fast because the transform is cached.
  beforeAll(async () => {
    await import("../../src/routes/users");
  }, 60_000);

  beforeEach(() => {
    dbCalls.length = 0;
    vi.resetModules();
  });

  it("answers 401 without a session, before any database access", async () => {
    for (const [method, url, body] of ADMIN_ROUTES) {
      const r = await call(method, url, undefined, body);
      expect(r.status, `${method} ${url}`).toBe(401);
    }
    expect(dbCalls).toEqual([]);
  });

  it("answers 401 for an invalid token", async () => {
    for (const [method, url, body] of ADMIN_ROUTES) {
      const r = await call(method, url, "forged-token", body);
      expect(r.status, `${method} ${url}`).toBe(401);
    }
    expect(dbCalls).toEqual([]);
  });

  it("answers 403 for a signed-in user without the admin role, before any database access", async () => {
    for (const [method, url, body] of ADMIN_ROUTES) {
      const r = await call(method, url, "user-token", body);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.body).toEqual({ error: "Forbidden" });
    }
    expect(dbCalls).toEqual([]);
  });

  it("lets an admin through to the handler", async () => {
    // The replaced database throws, so the handler answers 500; reaching it is the point.
    const r = await call("GET", "/", "admin-token");
    expect(r.status).toBe(500);
    expect(dbCalls.length).toBeGreaterThan(0);
  });

  it("keeps DELETE /me open to any signed-in user", async () => {
    const r = await call("DELETE", "/me", "user-token");
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
    expect(dbCalls.length).toBeGreaterThan(0);
  });
});
