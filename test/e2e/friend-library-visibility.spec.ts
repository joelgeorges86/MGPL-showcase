import { test, expect } from "../fixtures";

const BASE = "http://localhost:4000";

const OWNER = { email: "friendlib.owner@mgpl.test", password: "FriendLibOwner2026!" };
const FRIEND = { email: "friendlib.friend@mgpl.test", password: "FriendLibFriend2026!" };
const PRIVATE_FRIEND = { email: "friendlib.private@mgpl.test", password: "FriendLibPrivate2026!" };
const NON_FRIEND = { email: "friendlib.nonfriend@mgpl.test", password: "FriendLibNonFriend2026!" };

async function register(ctx: any, user: { email: string; password: string }) {
  const res = await ctx.post(`${BASE}/api/auth/register`, { data: user });
  expect([201, 409]).toContain(res.status());
  if (res.status() === 409) {
    const login = await ctx.post(`${BASE}/api/auth/login`, { data: user });
    expect(login.status()).toBe(200);
  }
}

async function currentUserId(ctx: any): Promise<string> {
  const res = await ctx.get(`${BASE}/api/auth/me`);
  expect(res.status()).toBe(200);
  return (await res.json()).user.id;
}

async function patchProfile(ctx: any, gamerTag: string) {
  const res = await ctx.patch(`${BASE}/api/user/profile`, {
    data: { displayName: gamerTag, gamerTag, profileVisibility: "public" },
  });
  expect(res.status()).toBe(200);
}

async function setLibraryVisibility(ctx: any, libraryVisibility: "private" | "friends") {
  const res = await ctx.patch(`${BASE}/api/user/profile`, { data: { libraryVisibility } });
  expect(res.status()).toBe(200);
}

async function importLibraryGame(ctx: any, title: string) {
  const res = await ctx.post(`${BASE}/api/library/import`, {
    data: { games: [{ title, platform: "Steam" }] },
  });
  expect(res.status()).toBe(200);
}

async function makeFriends(sender: any, receiver: any, receiverTag: string): Promise<void> {
  const request = await sender.post(`${BASE}/api/social/request`, {
    data: { gamerTag: receiverTag },
  });
  expect(request.status()).toBe(201);
  const requestId = (await request.json()).id;
  const accept = await receiver.patch(`${BASE}/api/social/request/${requestId}`, {
    data: { action: "accept" },
  });
  expect(accept.status()).toBe(200);
}

async function removeFriend(ctx: any, friendId: string): Promise<void> {
  const res = await ctx.delete(`${BASE}/api/social/friends/${friendId}`);
  expect(res.status()).toBe(200);
}

test.describe("PI-004 privacy-minimized friend library visibility", () => {
  test("owner, accepted friend, denial, and revocation semantics", async ({ playwright }) => {
    const owner = await playwright.request.newContext();
    const friend = await playwright.request.newContext();
    const privateFriend = await playwright.request.newContext();
    const nonFriend = await playwright.request.newContext();

    try {
      await register(owner, OWNER);
      await register(friend, FRIEND);
      await register(privateFriend, PRIVATE_FRIEND);
      await register(nonFriend, NON_FRIEND);

      await patchProfile(owner, "FriendLibOwner");
      await patchProfile(friend, "FriendLibFriend");
      await patchProfile(privateFriend, "FriendLibPrivate");
      await patchProfile(nonFriend, "FriendLibNonFriend");

      const ownerId = await currentUserId(owner);
      const friendId = await currentUserId(friend);
      const privateFriendId = await currentUserId(privateFriend);

      await importLibraryGame(owner, "Cyberpunk 2077");
      await setLibraryVisibility(owner, "friends");

      const ownerRead = await owner.get(`${BASE}/api/friends/${ownerId}/library`);
      expect(ownerRead.status()).toBe(200);
      const ownerBody = await ownerRead.json();
      expect(ownerBody.games.some((game: any) => game.gameId === "cyberpunk-2077")).toBe(true);

      await makeFriends(friend, owner, "FriendLibOwner");
      const friendRead = await friend.get(`${BASE}/api/friends/${ownerId}/library`);
      expect(friendRead.status()).toBe(200);
      const friendBody = await friendRead.json();
      expect(friendBody).not.toHaveProperty("ownerId");
      expect(friendBody.visibility).toBe("friends");
      expect(friendBody.games.length).toBeGreaterThan(0);
      for (const game of friendBody.games) {
        expect(Object.keys(game).sort()).toEqual([
          "gameId",
          "headerImage",
          "ownershipStatus",
          "platform",
          "title",
        ]);
        expect(game).not.toHaveProperty("email");
        expect(game).not.toHaveProperty("passwordHash");
        expect(game).not.toHaveProperty("targetPrice");
        expect(game).not.toHaveProperty("notes");
        expect(game).not.toHaveProperty("tags");
      }

      await makeFriends(owner, privateFriend, "FriendLibPrivate");
      await importLibraryGame(privateFriend, "Portal 2");
      await setLibraryVisibility(privateFriend, "private");
      const privateDenied = await owner.get(`${BASE}/api/friends/${privateFriendId}/library`);
      expect(privateDenied.status()).toBe(404);

      const nonFriendDenied = await nonFriend.get(`${BASE}/api/friends/${ownerId}/library`);
      expect(nonFriendDenied.status()).toBe(404);

      await removeFriend(owner, friendId);
      const revoked = await friend.get(`${BASE}/api/friends/${ownerId}/library`);
      expect(revoked.status()).toBe(404);
    } finally {
      await owner.dispose();
      await friend.dispose();
      await privateFriend.dispose();
      await nonFriend.dispose();
    }
  });
});
