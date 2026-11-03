import { describe, expect, it } from "vitest";
import { projectFriendLibraryRow } from "../../src/routes/friends";

describe("friend library projection", () => {
  it("returns only the approved friend-library allowlist", () => {
    const projected = projectFriendLibraryRow({
      gameId: "game-1",
      title: "Allowed Game",
      platform: "Steam",
      ownershipStatus: "Owned",
      headerImage: "https://cdn.example.test/header.jpg",
      email: "owner@example.test",
      passwordHash: "argon2hash",
      tokenEnc: "token",
      targetPrice: 12.34,
      notes: "private note",
      tagName: "private tag",
    } as any);

    expect(projected).toEqual({
      gameId: "game-1",
      title: "Allowed Game",
      platform: "Steam",
      ownershipStatus: "Owned",
      headerImage: "https://cdn.example.test/header.jpg",
    });
    expect(Object.keys(projected).sort()).toEqual([
      "gameId",
      "headerImage",
      "ownershipStatus",
      "platform",
      "title",
    ]);
  });
});
