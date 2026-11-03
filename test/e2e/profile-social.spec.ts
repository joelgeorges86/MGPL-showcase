import { test, expect } from "../fixtures";

/**
 * Sprint 3 (EPIC-PROFILE-0001) — privacy-minimized Friend Suggestions & Social Connections.
 *
 * Test 1: User A sends a friend request to User B via @gamerTag -> User B
 *         receives the pending request -> User B accepts -> both users see
 *         each other in /api/social/friends with the privacy-minimized public card.
 * Test 2: Platform suggestion discovery — User A and User B share a matching
 *         platform handle with public visibility -> both appear in each
 *         other's /api/social/suggestions.
 * Test 3: User B switches profileVisibility to "private" -> User B disappears
 *         from User A's suggestions (privacy boundary).
 * Test 4: User A unfriends User B -> the connection is removed from BOTH
 *         users' friend lists.
 *
 * Each test owns independent APIRequestContext cookie jars so sessions never
 * leak. Registrations use unique emails + gamerTags so the shared
 * deterministic seed dataset is never mutated.
 */

const BASE = "http://localhost:4000";

const USER_A = { email: "social.a@mgpl.test", password: "SocialPassA2026!" };
const USER_B = { email: "social.b@mgpl.test", password: "SocialPassB2026!" };

const SUGGEST_A = { email: "suggest.a@mgpl.test", password: "SuggestPassA2026!" };
const SUGGEST_B = { email: "suggest.b@mgpl.test", password: "SuggestPassB2026!" };

const PRIV_A = { email: "privacy.a@mgpl.test", password: "PrivacyPassA2026!" };
const PRIV_B = { email: "privacy.b@mgpl.test", password: "PrivacyPassB2026!" };

const UNFRIEND_A = { email: "unfriend.a@mgpl.test", password: "UnfriendPassA2026!" };
const UNFRIEND_B = { email: "unfriend.b@mgpl.test", password: "UnfriendPassB2026!" };

const SOCIAL_CARD_KEYS = ["avatarUrl", "displayName", "gamerTag", "id", "platformHandles"];

async function registerUser(ctx: any, user: { email: string; password: string }): Promise<void> {
  const register = await ctx.post(`${BASE}/api/auth/register`, { data: user });
  expect(register.status()).toBe(201);
}

async function publishProfile(
  ctx: any,
  displayName: string,
  gamerTag: string,
  visibility: "public" | "private" = "public"
): Promise<void> {
  const res = await ctx.patch(`${BASE}/api/user/profile`, {
    data: { displayName, gamerTag, profileVisibility: visibility },
  });
  expect(res.status()).toBe(200);
}

async function setSteamHandle(ctx: any, steamUsername: string): Promise<void> {
  const res = await ctx.patch(`${BASE}/api/user/platform-handles`, { data: { steamUsername } });
  expect(res.status()).toBe(200);
}

async function getFriends(ctx: any): Promise<any[]> {
  const res = await ctx.get(`${BASE}/api/social/friends`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.friends)).toBe(true);
  return body.friends;
}

test.describe("Sprint 3 (EPIC-PROFILE-0001) — privacy-minimized social connections", () => {
  test("1. Friend request via @gamerTag, accept, and mutual friendship", async ({ playwright }) => {
    const ctxA = await playwright.request.newContext();
    const ctxB = await playwright.request.newContext();
    try {
      // User A and User B both register as public profiles.
      await registerUser(ctxA, USER_A);
      await publishProfile(ctxA, "Social User A", "SocialUserA", "public");
      await registerUser(ctxB, USER_B);
      await publishProfile(ctxB, "Social User B", "SocialUserB", "public");

      // User A sends a friend request to User B's @gamerTag (with "@" prefix
      // to exercise the "@"-insensitive resolution).
      const requestRes = await ctxA.post(`${BASE}/api/social/request`, {
        data: { gamerTag: "@SocialUserB" },
      });
      expect(requestRes.status()).toBe(201);
      const requestBody = await requestRes.json();
      expect(requestBody.status).toBe("pending");
      expect(typeof requestBody.id).toBe("string");
      const requestId = requestBody.id;

      // User B sees the pending request with a privacy-minimized sender card.
      const inbox = await ctxB.get(`${BASE}/api/social/requests`);
      expect(inbox.status()).toBe(200);
      const inboxBody = await inbox.json();
      const pending = inboxBody.requests.find((r: any) => r.id === requestId);
      expect(pending).toBeTruthy();
      expect(pending.status).toBe("pending");
      expect(pending.source).toBe("manual");
      expect(Object.keys(pending.from).sort()).toEqual(SOCIAL_CARD_KEYS);
      expect(pending.from.gamerTag).toBe("SocialUserA");
      expect("email" in pending.from).toBe(false);

      // User B accepts the request.
      const accept = await ctxB.patch(`${BASE}/api/social/request/${requestId}`, {
        data: { action: "accept" },
      });
      expect(accept.status()).toBe(200);
      expect((await accept.json()).status).toBe("accepted");

      // Both users see each other in /api/social/friends (bidirectional).
      const aFriends = await getFriends(ctxA);
      const bFriends = await getFriends(ctxB);
      const bFromA = aFriends.find((f: any) => f.gamerTag === "SocialUserB");
      const aFromB = bFriends.find((f: any) => f.gamerTag === "SocialUserA");
      expect(bFromA).toBeTruthy();
      expect(aFromB).toBeTruthy();

      // Friend cards honor the privacy-minimized contract.
      for (const card of [bFromA, aFromB]) {
        expect(Object.keys(card).sort()).toEqual(SOCIAL_CARD_KEYS);
        expect("email" in card).toBe(false);
        expect(typeof card.id).toBe("string");
      }
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });

  test("2. Shared platform handle surfaces public users in suggestions", async ({ playwright }) => {
    const ctxA = await playwright.request.newContext();
    const ctxB = await playwright.request.newContext();
    try {
      await registerUser(ctxA, SUGGEST_A);
      await publishProfile(ctxA, "Suggest User A", "SuggestUserA", "public");
      await registerUser(ctxB, SUGGEST_B);
      await publishProfile(ctxB, "Suggest User B", "SuggestUserB", "public");

      // Both users claim the same public Steam handle.
      await setSteamHandle(ctxA, "SharedSteamHandle");
      await setSteamHandle(ctxB, "SharedSteamHandle");

      // Each user discovers the other in /api/social/suggestions.
      const aRes = await ctxA.get(`${BASE}/api/social/suggestions`);
      expect(aRes.status()).toBe(200);
      const aBody = await aRes.json();
      const bSuggestion = aBody.suggestions.find((s: any) => s.gamerTag === "SuggestUserB");
      expect(bSuggestion).toBeTruthy();
      expect(Object.keys(bSuggestion).sort()).toEqual(SOCIAL_CARD_KEYS);

      const bRes = await ctxB.get(`${BASE}/api/social/suggestions`);
      expect(bRes.status()).toBe(200);
      const bBody = await bRes.json();
      const aSuggestion = bBody.suggestions.find((s: any) => s.gamerTag === "SuggestUserA");
      expect(aSuggestion).toBeTruthy();
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });

  test("3. Private profiles disappear from suggestions", async ({ playwright }) => {
    const ctxA = await playwright.request.newContext();
    const ctxB = await playwright.request.newContext();
    try {
      await registerUser(ctxA, PRIV_A);
      await publishProfile(ctxA, "Privacy User A", "PrivacyUserA", "public");
      await registerUser(ctxB, PRIV_B);
      await publishProfile(ctxB, "Privacy User B", "PrivacyUserB", "public");

      await setSteamHandle(ctxA, "SameHandlePrivacy");
      await setSteamHandle(ctxB, "SameHandlePrivacy");

      // User B is public -> visible in User A's suggestions.
      const before = await ctxA.get(`${BASE}/api/social/suggestions`);
      const beforeBody = await before.json();
      expect(beforeBody.suggestions.some((s: any) => s.gamerTag === "PrivacyUserB")).toBe(true);

      // User B switches to private.
      const privatize = await ctxB.patch(`${BASE}/api/user/profile`, {
        data: { profileVisibility: "private" },
      });
      expect(privatize.status()).toBe(200);

      // User B disappears from User A's suggestions (privacy boundary).
      const after = await ctxA.get(`${BASE}/api/social/suggestions`);
      const afterBody = await after.json();
      expect(afterBody.suggestions.some((s: any) => s.gamerTag === "PrivacyUserB")).toBe(false);
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });

  test("4. Unfriending removes the connection from both friend lists", async ({ playwright }) => {
    const ctxA = await playwright.request.newContext();
    const ctxB = await playwright.request.newContext();
    try {
      await registerUser(ctxA, UNFRIEND_A);
      await publishProfile(ctxA, "Unfriend User A", "UnfriendUserA", "public");
      await registerUser(ctxB, UNFRIEND_B);
      await publishProfile(ctxB, "Unfriend User B", "UnfriendUserB", "public");

      // Establish the friendship: A -> B -> accept.
      const requestRes = await ctxA.post(`${BASE}/api/social/request`, {
        data: { gamerTag: "UnfriendUserB" },
      });
      expect(requestRes.status()).toBe(201);
      const requestId = (await requestRes.json()).id;
      const accept = await ctxB.patch(`${BASE}/api/social/request/${requestId}`, {
        data: { action: "accept" },
      });
      expect(accept.status()).toBe(200);

      // Both users are friends beforehand.
      const aFriendsBefore = await getFriends(ctxA);
      const bFriendsBefore = await getFriends(ctxB);
      expect(aFriendsBefore.some((f: any) => f.gamerTag === "UnfriendUserB")).toBe(true);
      expect(bFriendsBefore.some((f: any) => f.gamerTag === "UnfriendUserA")).toBe(true);

      // User A reads B's profile id from the friend card and unfriends.
      const bCard = aFriendsBefore.find((f: any) => f.gamerTag === "UnfriendUserB");
      const remove = await ctxA.delete(`${BASE}/api/social/friends/${bCard.id}`);
      expect(remove.status()).toBe(200);

      // The single canonical row is gone for BOTH directions.
      const aFriendsAfter = await getFriends(ctxA);
      const bFriendsAfter = await getFriends(ctxB);
      expect(aFriendsAfter.some((f: any) => f.gamerTag === "UnfriendUserB")).toBe(false);
      expect(bFriendsAfter.some((f: any) => f.gamerTag === "UnfriendUserA")).toBe(false);
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });
});