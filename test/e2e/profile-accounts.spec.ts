import { test, expect } from "../fixtures";

/**
 * Sprint 2 (EPIC-PROFILE-0001) — Storefront Identity Hub & Platform Usernames.
 *
 * Test 1: User with a local password links a fresh Steam identity via the
 *         deterministic mock OpenID flow, then unlinks it successfully.
 * Test 2: OAuth-only user (passwordHash = NULL, single Google provider) tries
 *         to unlink its only provider -> 400 Lockout Prevention.
 * Test 3: User saves all four platform handles and publishes their profile;
 *         an unauthenticated guest resolves the privacy-minimized public profile with
 *         handles and no email.
 * Test 4: User keeps the private visibility default; the public lookup
 *         returns 404 (indistinguishable from an unknown handle).
 *
 * Each test owns its APIRequestContext cookie jar so sessions never leak.
 * The public/private registrations use unique emails + gamerTags so the shared
 * deterministic seed dataset is never mutated.
 */

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

// New Steam identity used ONLY by this spec (17-digit test-mode override).
const MY_STEAM_ID = "76561198000000003";

const PUBLIC_USER = {
  email: "storefront.public@mgpl.test",
  password: "StorefrontPubPass",
  displayName: "Storefront Public User",
  gamerTag: "StorefrontPub",
};

const PRIVATE_USER = {
  email: "storefront.private@mgpl.test",
  password: "StorefrontPrivPass",
  displayName: "Storefront Private User",
  gamerTag: "StorefrontPriv",
};

const PUB_HANDLES = {
  steamUsername: "pubSteam",
  psnId: "pubPsn",
  xboxGamertag: "pubXbox",
  gogUsername: "pubGog",
  // Sprint 2 (WUD-2.1): the identity hub now exposes Epic + Ubisoft handles
  // (null unless set) alongside the original four.
  epicUsername: null,
  ubisoftUsername: null,
};

test.describe("Sprint 2 (EPIC-PROFILE-0001) — Storefront identity hub & platform usernames", () => {
  test("1. User with a local password unlinks a linked provider", async ({ request }) => {
    // Login as the seeded Alex user (has a local password hash).
    const login = await request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);

    // Link a fresh Steam identity through the deterministic mock OpenID flow.
    const start = await request.get(
      `${BASE}/api/auth/openid/steam?link=1&steamId=${MY_STEAM_ID}`,
      { maxRedirects: 0 }
    );
    expect(start.status()).toBe(302);
    const location = start.headers()["location"];
    expect(location).toBeTruthy();
    const callback = await request.get(location, { maxRedirects: 0 });
    expect(callback.status()).toBe(302);

    // GET /api/user/accounts lists the linked provider metadata (privacy-minimized).
    const accountsRes = await request.get(`${BASE}/api/user/accounts`);
    expect(accountsRes.status()).toBe(200);
    const accountsBody = await accountsRes.json();
    expect(Array.isArray(accountsBody.accounts)).toBe(true);
    const steam = accountsBody.accounts.find(
      (a: any) => a.provider === "steam" && a.providerAccountId === MY_STEAM_ID
    );
    expect(steam).toBeTruthy();
    expect(Object.keys(steam).sort()).toEqual(["linkedAt", "provider", "providerAccountId"]);
    expect(steam.linkedAt).toBeTruthy();
    expect("email" in steam).toBe(false);

    // Alex has a local password, so unlinking cannot lock the account out.
    const unlink = await request.delete(`${BASE}/api/user/accounts/steam`);
    expect(unlink.status()).toBe(200);
    expect((await unlink.json()).unlinked).toBe("steam");

    // The provider link is gone afterwards.
    const afterRes = await request.get(`${BASE}/api/user/accounts`);
    const afterBody = await afterRes.json();
    expect(afterBody.accounts.some((a: any) => a.provider === "steam")).toBe(false);
  });

  test("2. OAuth-only user cannot unlink their only provider (400)", async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      // Mock Google OAuth -> OAuth-only AuthUser with passwordHash NULL.
      const start = await ctx.get(`${BASE}/api/auth/oauth/google`, { maxRedirects: 0 });
      expect(start.status()).toBe(302);
      const location = start.headers()["location"];
      expect(location).toBeTruthy();
      const callback = await ctx.get(location, { maxRedirects: 0 });
      expect(callback.status()).toBe(302);

      // Confirms an OAuth-only account (no local password).
      const profileRes = await ctx.get(`${BASE}/api/user/profile`);
      expect(profileRes.status()).toBe(200);
      const profileBody = await profileRes.json();
      expect(profileBody.profile.hasPassword).toBe(false);

      // Exactly one linked provider: google.
      const accountsRes = await ctx.get(`${BASE}/api/user/accounts`);
      const accountsBody = await accountsRes.json();
      expect(accountsBody.accounts.length).toBe(1);
      expect(accountsBody.accounts[0].provider).toBe("google");

      // Lockout prevention: unlinking the ONLY provider without a password is
      // a hard 400.
      const unlink = await ctx.delete(`${BASE}/api/user/accounts/google`);
      expect(unlink.status()).toBe(400);
      const unlinkBody = await unlink.json();
      expect(unlinkBody.error).toContain("unlink");

      // The provider link is still intact.
      const afterRes = await ctx.get(`${BASE}/api/user/accounts`);
      const afterBody = await afterRes.json();
      expect(afterBody.accounts.some((a: any) => a.provider === "google")).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("3. Public profile returns saved platform handles with no PII", async ({ playwright }) => {
    const userCtx = await playwright.request.newContext();
    const guestCtx = await playwright.request.newContext();
    try {
      // Dedicated public storefront identity (unique email + gamerTag).
      const register = await userCtx.post(`${BASE}/api/auth/register`, {
        data: { email: PUBLIC_USER.email, password: PUBLIC_USER.password },
      });
      expect(register.status()).toBe(201);

      // Publish the profile: displayName, gamerTag, public visibility.
      const profileRes = await userCtx.patch(`${BASE}/api/user/profile`, {
        data: {
          displayName: PUBLIC_USER.displayName,
          gamerTag: PUBLIC_USER.gamerTag,
          profileVisibility: "public",
        },
      });
      expect(profileRes.status()).toBe(200);

      // Save all four platform handles.
      const handlesRes = await userCtx.patch(`${BASE}/api/user/platform-handles`, {
        data: PUB_HANDLES,
      });
      expect(handlesRes.status()).toBe(200);
      const handlesBody = await handlesRes.json();
      expect(handlesBody.platformHandles).toEqual(PUB_HANDLES);

      // Unauthenticated guest resolves the public profile — Privacy-minimized.
      const lookup = await guestCtx.get(`${BASE}/api/user/u/${PUBLIC_USER.gamerTag}`);
      expect(lookup.status()).toBe(200);
      const body = await lookup.json();

      // The payload is strictly the public identity contract.
      expect(Object.keys(body).sort()).toEqual([
        "avatarUrl",
        "displayName",
        "gamerTag",
        "platformHandles",
      ]);
      expect("email" in body).toBe(false);
      expect(body.displayName).toBe(PUBLIC_USER.displayName);
      expect(body.gamerTag).toBe(PUBLIC_USER.gamerTag);
      expect(body.avatarUrl).toBeNull();
      expect(body.platformHandles).toEqual(PUB_HANDLES);

      // Lookup is case-insensitive and "@"-insensitive.
      const altLookup = await guestCtx.get(`${BASE}/api/user/u/@${PUBLIC_USER.gamerTag}`);
      expect(altLookup.status()).toBe(200);
    } finally {
      await userCtx.dispose();
      await guestCtx.dispose();
    }
  });

  test("4. Private profile returns 404 on public lookup", async ({ playwright }) => {
    const userCtx = await playwright.request.newContext();
    const guestCtx = await playwright.request.newContext();
    try {
      // Dedicated private user (unique email + gamerTag).
      const register = await userCtx.post(`${BASE}/api/auth/register`, {
        data: { email: PRIVATE_USER.email, password: PRIVATE_USER.password },
      });
      expect(register.status()).toBe(201);

      // Claim a handle WITHOUT changing the private visibility default.
      const profileRes = await userCtx.patch(`${BASE}/api/user/profile`, {
        data: { displayName: PRIVATE_USER.displayName, gamerTag: PRIVATE_USER.gamerTag },
      });
      expect(profileRes.status()).toBe(200);
      const profileBody = await profileRes.json();
      expect(profileBody.profile.profileVisibility).toBe("private");

      // Guest lookup -> 404 (same status as an unknown handle prevents
      // user enumeration).
      const lookup = await guestCtx.get(`${BASE}/api/user/u/${PRIVATE_USER.gamerTag}`);
      expect(lookup.status()).toBe(404);
    } finally {
      await userCtx.dispose();
      await guestCtx.dispose();
    }
  });
});