import { test, expect } from "../fixtures";

/**
 * Sprint 1 (EPIC-PROFILE-0001) — Profile identity, password & privacy API.
 *
 * Test 1: Seeded user `alex.gamer@mgpl.io` retrieves their profile (privacy
 *         default "private", hasPassword true, no PII in the payload) and
 *         updates `gamerTag` to `@AlexCyber` + `profileVisibility` to "public".
 * Test 2: A user attempting to claim an already-taken `gamerTag` receives 409.
 * Test 3: A user changes their password (current verified via Argon2id), logs
 *         in with the new password, and the old password now returns 401.
 *         State is restored to the seeded password (non-destructive contract).
 * Test 4: Unauthenticated calls to /api/user/* return 401.
 *
 * Each Playwright test gets its own isolated APIRequestContext cookie jar, so
 * login sessions never leak between tests.
 */

const BASE = "http://localhost:4000";

test.describe("Sprint 1 (EPIC-PROFILE-0001) — Profile & Password Security", () => {
  test("1. Seeded user retrieves a private, PII-free profile and publishes it", async ({
    request,
  }) => {
    // Login as the seeded tenant.
    const login = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.status()).toBe(200);
    const loginBody = await login.json();
    expect(loginBody.user.id).toBe("auth-user-alex-gamer");

    // GET /api/user/profile returns the public profile shape.
    const getRes = await request.get(`${BASE}/api/user/profile`);
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();

    // Privacy-minimized: the payload must never expose the email address.
    expect(Object.keys(getBody.profile).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "gamerTag",
      "hasPassword",
      "id",
      "libraryVisibility",
      "profileVisibility",
    ]);

    expect(getBody.profile.id).toBe("auth-user-alex-gamer");
    expect(getBody.profile.displayName).toBe("Alex Gamer");
    expect(getBody.profile.gamerTag).toBeNull();
    expect(getBody.profile.avatarUrl).toBeNull();
    // Privacy default: new profiles must default to "private".
    expect(getBody.profile.profileVisibility).toBe("private");
    // Local-password account.
    expect(getBody.profile.hasPassword).toBe(true);

    // Publish the digital identity: claim `@AlexCyber` and go public.
    const patchRes = await request.patch(`${BASE}/api/user/profile`, {
      data: { gamerTag: "@AlexCyber", profileVisibility: "public" },
    });
    expect(patchRes.status()).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.profile.gamerTag).toBe("@AlexCyber");
    expect(patchBody.profile.profileVisibility).toBe("public");
    expect(patchBody.profile.hasPassword).toBe(true);

    // The persisted state is authoritative — a subsequent GET agrees.
    const verifyRes = await request.get(`${BASE}/api/user/profile`);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.profile.gamerTag).toBe("@AlexCyber");
    expect(verifyBody.profile.profileVisibility).toBe("public");
  });

  test("2. Claiming a taken gamerTag returns 409 Conflict", async ({ request }) => {
    // Login as the seeded tenant.
    const login = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.status()).toBe(200);

    // Jordan's seeded handle is `JordanDev` — Alex cannot claim it.
    const conflict = await request.patch(`${BASE}/api/user/profile`, {
      data: { gamerTag: "JordanDev" },
    });
    expect(conflict.status()).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.error).toContain("taken");

    // Uniqueness is @- and case-insensitive: `@jordandev` collides too.
    const caseInsensitive = await request.patch(`${BASE}/api/user/profile`, {
      data: { gamerTag: "@jordandev" },
    });
    expect(caseInsensitive.status()).toBe(409);

    // The failed attempt must NOT have mutated Alex's persisted handle.
    const profileRes = await request.get(`${BASE}/api/user/profile`);
    const profileBody = await profileRes.json();
    expect(profileBody.profile.gamerTag).toBe("@AlexCyber");
  });

  test("3. Password change verifies the current password, then invalidates the old one", async ({
    request,
  }) => {
    const NEW_PASSWORD = "NewPass2026!";

    // Login with the seeded credential pair.
    const login = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.status()).toBe(200);

    // Wrong current password is rejected with 400 BEFORE any re-hash.
    const wrongCurrent = await request.post(`${BASE}/api/user/password`, {
      data: { currentPassword: "TotallyWrong2026!", newPassword: NEW_PASSWORD },
    });
    expect(wrongCurrent.status()).toBe(400);

    // Change the password successfully.
    const change = await request.post(`${BASE}/api/user/password`, {
      data: { currentPassword: "GamerPass2026!", newPassword: NEW_PASSWORD },
    });
    expect(change.status()).toBe(200);
    expect((await change.json()).success).toBe(true);

    // The new password authenticates.
    const newLogin = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: NEW_PASSWORD },
    });
    expect(newLogin.status()).toBe(200);

    // The old password is now invalid — 401.
    const oldLogin = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(oldLogin.status()).toBe(401);
    expect((await oldLogin.json()).error).toBe("Invalid email or password");

    // Non-destructive contract: restore the seeded password so the shared
    // deterministic dataset stays intact for the rest of the suite.
    const restoreLogin = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: NEW_PASSWORD },
    });
    expect(restoreLogin.status()).toBe(200);
    const restore = await request.post(`${BASE}/api/user/password`, {
      data: { currentPassword: NEW_PASSWORD, newPassword: "GamerPass2026!" },
    });
    expect(restore.status()).toBe(200);

    // Confirm the seeded credential pair works again.
    const restoredLogin = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(restoredLogin.status()).toBe(200);
  });

  test("4. Unauthenticated calls to /api/user/* return 401", async ({ request }) => {
    // GET /api/user/profile
    const getRes = await request.get(`${BASE}/api/user/profile`);
    expect(getRes.status()).toBe(401);
    expect((await getRes.json()).error).toBe("Unauthorized");

    // PATCH /api/user/profile
    const patchRes = await request.patch(`${BASE}/api/user/profile`, {
      data: { displayName: "Should Not Apply" },
    });
    expect(patchRes.status()).toBe(401);
    expect((await patchRes.json()).error).toBe("Unauthorized");

    // POST /api/user/password
    const pwRes = await request.post(`${BASE}/api/user/password`, {
      data: { currentPassword: "Whatever2026!", newPassword: "NewPass2026!" },
    });
    expect(pwRes.status()).toBe(401);
    expect((await pwRes.json()).error).toBe("Unauthorized");
  });
});
