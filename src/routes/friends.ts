import { Router, Request, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { sendApiError } from "../middleware/errorSanitizer";

const router = Router();

const NOT_FOUND = { error: "Library not found" };

type Visibility = "private" | "friends";

interface FriendLibraryRow {
  gameId: string;
  title: string | null;
  platform: string | null;
  ownershipStatus: string | null;
  headerImage: string | null;
}

function normalizeVisibility(value: unknown): Visibility {
  return value === "friends" ? "friends" : "private";
}

function hasAcceptedFriendship(viewerId: string, friendId: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM AppFriendships
       WHERE status = 'accepted'
         AND ((userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?))
       LIMIT 1`,
    )
    .get(viewerId, friendId, friendId, viewerId) as { id: string } | undefined;
  return Boolean(row);
}

export function projectFriendLibraryRow(row: FriendLibraryRow): FriendLibraryRow {
  return {
    gameId: String(row.gameId),
    title: row.title ?? null,
    platform: row.platform ?? null,
    ownershipStatus: row.ownershipStatus ?? null,
    headerImage: row.headerImage ?? null,
  };
}

/**
 * GET /api/friends/:friendId/library
 *
 * Privacy-minimized friend-library view. All denied states intentionally return
 * 404 (private library, pending/non-friend, blocked/no row, unknown target) so
 * the endpoint cannot be used to enumerate users or relationship state.
 */
router.get("/:friendId/library", requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const viewerId = authed.user!.userId;
  const friendId = String(req.params.friendId || "").trim();

  try {
    if (!friendId) return res.status(404).json(NOT_FOUND);

    const target = db
      .prepare('SELECT id, libraryVisibility FROM "AuthUsers" WHERE id = ? LIMIT 1')
      .get(friendId) as { id: string; libraryVisibility: string | null } | undefined;
    if (!target) return res.status(404).json(NOT_FOUND);

    const isOwner = viewerId === friendId;
    const visibility = normalizeVisibility(target.libraryVisibility);
    if (!isOwner) {
      if (visibility !== "friends" || !hasAcceptedFriendship(viewerId, friendId)) {
        return res.status(404).json(NOT_FOUND);
      }
    }

    const rows = db
      .prepare(
        `SELECT
           g."GameID" AS gameId,
           g."Game Title" AS title,
           o."Platform" AS platform,
           COALESCE(o."Ownership Access Type", o."Format", 'Owned') AS ownershipStatus,
           g."headerImage" AS headerImage
         FROM "AppOwnership" o
         JOIN "AppGames" g ON g."GameID" = o."GameID"
         WHERE o."userId" = ?
         ORDER BY COALESCE(g."Game Title", g."GameID") ASC, COALESCE(o."Platform", '') ASC
         LIMIT 500`,
      )
      .all(friendId) as FriendLibraryRow[];

    return res.json({
      visibility,
      games: rows.map(projectFriendLibraryRow),
    });
  } catch (error) {
    console.error("GET /api/friends/:friendId/library error:", error);
    return sendApiError(res, 500, "Internal Server Error", undefined, { includeSuccess: false });
  }
});

export default router;
