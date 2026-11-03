import { test, expect } from "../fixtures";
import path from "path";
import Database from "better-sqlite3";
import { OAUTH_FIXTURES } from "../global-setup";

/**
 * Sprint 3 (FEAT-OAUTH-0001): Third-party authentication E2E suite.
 *
 * Runs fully offline in NODE_ENV=test against the deterministic mock harness
 * wired into /api/auth/oauth/* and /api/auth/openid/*:
 *
 *  - Test 1: Mock Google OAuth 2.0 registers `mock.user@example.com` and issues
 *    a valid httpOnly `mgpl_session` cookie, then `/api/auth/me` resolves the
 *    session. Persisted AuthAccount(provider='google') is verified and the
 *    OAuth-only AuthUser has passwordHash = NULL.
 *
 *  - Test 2: Mock Steam OpenID 2.0 logs in Steam ID `76561198000000001` and
 *    the session is retrieved via `/api/auth/me` (email null — Steam never
 *    supplies a verified email). Persisted AuthAccount(provider='steam') with
 *    passwordHash = NULL is verified directly in the seeded test DB.
 *
 *  - Test 3: Account linking — a signed-in Alex session runs the Steam flow
 *    with `link=1`, and the Steam AuthAccount is attached under the SAME
 *    `userId` (`auth-user-alex-gamer`) with no account-hijack re-owner.
 *
 * Each test uses its own request context so cookie jars stay isolated, and
 * `maxRedirects: 0` lets us assert the 302 Set-Cookie headers directly.
 */

const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

function extractSetCookie(res: { headersArray(): Array<{ name: string; value: string }> }): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
}

function assertSessionCookie(setCookies: string[]): void {
  const session = setCookies.find((c) => c.startsWith("mgpl_session="));
  expect(session).toBeDefined();
  expect(session).toMatch(/HttpOnly/i);
  expect(session).toMatch(/SameSite=Strict/i);
}

function readAuthRow<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

test.describe("Third-party authentication", () => {
  test("mock Google OAuth registers mock.user@example.com and issues a valid mgpl_session cookie", async ({ request }) => {
    // 1. Start flow: 302 to the deterministic mock Google callback with
    //    state + the fixture code (no live Google network call).
    const start = await request.get("/api/auth/oauth/google", { maxRedirects: 0 });
    expect(start.status()).toBe(302);
    const location = start.headers()["location"];
    expect(location).toBeTruthy();
    const startUrl = new URL(location);
    expect(startUrl.searchParams.get("code")).toBe(OAUTH_FIXTURES.google.code);
    const state = startUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    // 2. Mock callback: exchange the code + consumed state, issue cookie,
    //    redirect home.
    const callback = await request.get(location, { maxRedirects: 0 });
    expect(callback.status()).toBe(302);
    assertSessionCookie(extractSetCookie(callback));

    // 3. Session resolves via /api/auth/me with the Google email.
    const me = await request.get("/api/auth/me");
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect(body.user.email).toBe(OAUTH_FIXTURES.google.email);
    expect(typeof body.user.id).toBe("string");

    // 4. Persisted: AuthAccounts(google, mock-google-sub-1) linked to an
    //    OAuth-only AuthUser with passwordHash = NULL.
    const account = readAuthRow<{ userId: string }>(
      "SELECT userId FROM AuthAccounts WHERE provider = 'google' AND providerAccountId = ?",
      OAUTH_FIXTURES.google.sub
    );
    expect(account?.userId).toBeTruthy();
    const authUser = readAuthRow<{ passwordHash: string | null }>(
      "SELECT passwordHash FROM AuthUsers WHERE id = ?",
      account?.userId
    );
    expect(authUser?.passwordHash).toBeNull();
  });

  test("mock Steam OpenID logs in Steam ID 76561198000000001 and retrieves the session via /me", async ({ request }) => {
    // 1. Start flow: 302 to the deterministic mock Steam callback URL.
    const start = await request.get("/api/auth/openid/steam", { maxRedirects: 0 });
    expect(start.status()).toBe(302);
    const location = start.headers()["location"];
    expect(location).toBeTruthy();
    const startUrl = new URL(location);
    expect(startUrl.searchParams.get("openid.mode")).toBe("id_res");
    expect(startUrl.searchParams.get("openid.claimed_id")).toContain(
      OAUTH_FIXTURES.steam.steamId
    );
    expect(startUrl.searchParams.get("state")).toBeTruthy();

    // 2. Mock callback: state consumed, session cookie issued.
    const callback = await request.get(location, { maxRedirects: 0 });
    expect(callback.status()).toBe(302);
    assertSessionCookie(extractSetCookie(callback));

    // 3. Session resolves via /api/auth/me with email null (Steam supplies
    //    no verified email).
    const me = await request.get("/api/auth/me");
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect(body.user.email).toBeNull();

    // 4. Persisted: AuthAccounts(steam, 76561198000000001) on an OAuth-only
    //    AuthUser with passwordHash = NULL.
    const account = readAuthRow<{ userId: string }>(
      "SELECT userId FROM AuthAccounts WHERE provider = 'steam' AND providerAccountId = ?",
      OAUTH_FIXTURES.steam.steamId
    );
    expect(account?.userId).toBeTruthy();
    const authUser = readAuthRow<{ passwordHash: string | null }>(
      "SELECT passwordHash FROM AuthUsers WHERE id = ?",
      account?.userId
    );
    expect(authUser?.passwordHash).toBeNull();
  });

  test("linking Steam account to an existing user session attaches AuthAccount under the same userId", async ({ request }) => {
    // Sign in as the seeded Alex user.
    const login = await request.post("/api/auth/login", {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.status()).toBe(200);

    // Start the Steam flow with the test-only link + deterministic steamId
    // overrides (hard-guarded to NODE_ENV=test).
    const start = await request.get(
      `/api/auth/openid/steam?link=1&steamId=${OAUTH_FIXTURES.steam.linkSteamId}`,
      { maxRedirects: 0 }
    );
    expect(start.status()).toBe(302);
    const location = start.headers()["location"];
    expect(location).toBeTruthy();
    expect(new URL(location).searchParams.get("link")).toBe("1");

    // Mock callback: attaches the Steam identity under the SAME user.
    const callback = await request.get(location, { maxRedirects: 0 });
    expect(callback.status()).toBe(302);

    // Persisted: the Steam account is owned by Alex — never re-owned to the
    // identity user because the explicit link flow routes to
    // linkOAuthAccountToUser().
    const account = readAuthRow<{ userId: string }>(
      "SELECT userId FROM AuthAccounts WHERE provider = 'steam' AND providerAccountId = ?",
      OAUTH_FIXTURES.steam.linkSteamId
    );
    expect(account?.userId).toBe("auth-user-alex-gamer");
  });
});