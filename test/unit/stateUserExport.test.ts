import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// AI-084 (#163): GET /api/state/export/me ("Export My Data") returns only the
// signed-in user's rows, with no email address and no credential fields. The
// database module is replaced by an in-memory SQLite database holding two
// users' rows.
vi.mock("../../src/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  const owned = [
    "AppDevices",
    "AppPriceAlerts",
    "AppGameTags",
    "AppGameNotes",
    "AppPlatformHandles",
    "AppWishlist",
    "device_builds",
    "device_reviews",
    "review_votes",
  ];
  db.exec(`CREATE TABLE AuthUsers (id TEXT PRIMARY KEY, email TEXT, passwordHash TEXT, displayName TEXT,
    avatarUrl TEXT, gamerTag TEXT, profileVisibility TEXT, libraryVisibility TEXT, role TEXT, createdAt TEXT, updatedAt TEXT)`);
  db.exec(
    `CREATE TABLE AuthPlatformLinks (id TEXT PRIMARY KEY, userId TEXT, platform TEXT, publicId TEXT, tokenEnc TEXT, tokenIv TEXT)`,
  );
  db.exec(
    `CREATE TABLE AppFriendships (id TEXT PRIMARY KEY, userId TEXT, friendId TEXT, status TEXT)`,
  );
  for (const t of owned)
    db.exec(`CREATE TABLE "${t}" (id TEXT PRIMARY KEY, userId TEXT, label TEXT)`);
  const user = db.prepare(
    `INSERT INTO AuthUsers VALUES (?, ?, 'hash-value', ?, NULL, NULL, 'private', 'private', 'user', 'now', 'now')`,
  );
  user.run("u1", "one@x.io", "One");
  user.run("u2", "two@x.io", "Two");
  for (const t of owned) {
    db.prepare(`INSERT INTO "${t}" VALUES (?, ?, ?)`).run(`${t}-u1`, "u1", "mine");
    db.prepare(`INSERT INTO "${t}" VALUES (?, ?, ?)`).run(`${t}-u2`, "u2", "theirs");
  }
  const link = db.prepare(
    `INSERT INTO AuthPlatformLinks VALUES (?, ?, 'steam', 'pub', 'secret-cipher', 'secret-iv')`,
  );
  link.run("l1", "u1");
  link.run("l2", "u2");
  const friend = db.prepare(`INSERT INTO AppFriendships VALUES (?, ?, ?, 'accepted')`);
  friend.run("f1", "u1", "u2"); // u1 asked u2
  friend.run("f2", "u3", "u1"); // u3 asked u1
  friend.run("f3", "u2", "u3"); // not involving u1
  return { db };
});

vi.mock("../../src/lib/auth", () => ({
  SESSION_COOKIE: "mgpl_session",
  verifyToken: (token: string) => {
    if (token === "u1-token") return { userId: "u1", email: "one@x.io", role: "user" };
    throw new Error("invalid token");
  },
}));

type Captured = { status: number; body: unknown };

async function exportMe(token?: string): Promise<Captured> {
  const { default: router } = await import("../../src/routes/state");
  return new Promise((resolve) => {
    const captured: Captured = { status: 200, body: undefined };
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const req = {
      method: "GET",
      url: "/export/me",
      originalUrl: "/export/me",
      path: "/export/me",
      headers,
      cookies: {},
    };
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
      setHeader() {
        return res;
      },
    };
    (router as unknown as (rq: unknown, rs: unknown, nx: () => void) => void)(req, res, () =>
      resolve(captured),
    );
  });
}

type Payload = {
  version: number;
  scope: string;
  account: Record<string, unknown> | null;
  data: Record<string, Array<Record<string, unknown>>>;
};

describe("GET /api/state/export/me (AI-084)", () => {
  // Load the router once, with a generous limit, before the timed tests: a cold
  // import of the route and its dependencies can take several seconds on a
  // loaded machine (WU-011 gate run, 2026-10-06). The tests still re-import it
  // after vi.resetModules(), which is then fast because the transform is cached.
  beforeAll(async () => {
    await import("../../src/routes/state");
  }, 60_000);

  beforeEach(() => {
    vi.resetModules();
  });

  it("answers 401 without a session or with an invalid token", async () => {
    expect((await exportMe()).status).toBe(401);
    expect((await exportMe("forged-token")).status).toBe(401);
  });

  it("returns only the signed-in user's rows, from the owned tables only", async () => {
    const r = await exportMe("u1-token");
    expect(r.status).toBe(200);
    const p = r.body as Payload;
    expect(p.version).toBe(1);
    expect(p.scope).toBe("user");
    expect(Object.keys(p.data).sort()).toEqual(
      [
        "alerts",
        "appDevices",
        "builderBuilds",
        "deviceReviews",
        "friendships",
        "notes",
        "platformHandles",
        "platformLinks",
        "reviewVotes",
        "tags",
        "wishlist",
      ].sort(),
    );
    for (const [key, rows] of Object.entries(p.data)) {
      if (key === "friendships") continue;
      expect(rows.length, key).toBe(1);
      expect(rows[0].userId, key).toBe("u1");
    }
    expect(p.data.friendships.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("returns no email address and no credential fields", async () => {
    const p = (await exportMe("u1-token")).body as Payload;
    expect(p.account).toMatchObject({ id: "u1", displayName: "One" });
    expect(p.account).not.toHaveProperty("email");
    expect(p.account).not.toHaveProperty("passwordHash");
    expect(p.data.platformLinks[0]).toMatchObject({ id: "l1", platform: "steam" });
    expect(p.data.platformLinks[0]).not.toHaveProperty("tokenEnc");
    expect(p.data.platformLinks[0]).not.toHaveProperty("tokenIv");
    expect(JSON.stringify(p)).not.toMatch(/secret-cipher|secret-iv|hash-value|one@x\.io/);
  });
});
