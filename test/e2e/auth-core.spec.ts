import { test, expect } from "../fixtures";

/**
 * Sprint 1 (FEAT-AUTH-0001): Native auth core — session cookie + JWT flow.
 *
 * Uses the HTTP API directly (request context) to verify the auth contract:
 * registration, login success, invalid credential rejection (401 with the
 * generic error), /me session retrieval, and logout. Runs against the seeded
 * test DB (DB_PATH=./data/test_mgpl.db), which contains the deterministic
 * mock users seeded by test/global-setup.ts.
 */

const BASE = "http://localhost:4000";

test.describe("Auth core", () => {
  test("registration issues an httpOnly mgpl_session cookie and returns the public user", async ({ request }) => {
    const email = `e2e-auth-${Date.now()}@mgpl.io`;
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email, password: "E2EPass2026!" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.user).toMatchObject({ email, role: "user" });
    expect(typeof body.user.id).toBe("string");

    const setCookie = res.headers()["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("mgpl_session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });

  test("seeded user can log in and retrieve their session via /me", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ email: "alex.gamer@mgpl.io", role: "user" });
    expect(typeof body.user.id).toBe("string");

    // Reuse the cookie jar from the login response.
    const me = await request.get(`${BASE}/api/auth/me`);
    expect(me.status()).toBe(200);
    const meBody = await me.json();
    expect(meBody.user).toMatchObject({ email: "alex.gamer@mgpl.io", role: "user" });
  });

  test("invalid credentials return 401 with a generic error (no user enumeration)", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "WrongPass2026!" },
    });

    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid email or password");

    // Unknown account gets the exact same generic error.
    const unknown = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "ghost@mgpl.io", password: "Whatever2026!" },
    });
    expect(unknown.status()).toBe(401);
    expect((await unknown.json()).error).toBe("Invalid email or password");
  });

  test("unauthenticated /me returns 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/me`);
    expect(res.status()).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  test("logout clears the session and subsequent /me returns 401", async ({ request }) => {
    const login = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "jordan.dev@mgpl.io", password: "SecureDev2026!" },
    });
    expect(login.status()).toBe(200);

    const logout = await request.post(`${BASE}/api/auth/logout`);
    expect(logout.status()).toBe(200);
    expect((await logout.json()).success).toBe(true);

    const me = await request.get(`${BASE}/api/auth/me`);
    expect(me.status()).toBe(401);
  });
});