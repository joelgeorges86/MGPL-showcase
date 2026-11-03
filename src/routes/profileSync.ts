import { Router, Request, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { sendApiError } from "../middleware/errorSanitizer";
import { encryptToken, decryptToken, isTokenEncryptionConfigured } from "../lib/tokenCipher";
import { adapterForPlatform, allAdapters, PLATFORM_LABELS, maskHandle } from "../services/adapters";
import type { PlatformKey, PlatformProfile, PlatformGameEntry } from "../services/adapters";
import { safeCoerce } from "../utils/ingest";

const router = Router();

// Sprint 2 (WUD-2.1 / EPIC-01): Every profile-sync route requires an
// authenticated session. Tokens are stored encrypted in the local SQLite
// AuthPlatformLinks WAL table and are NEVER returned by any endpoint — only
// masked display handles and numeric gameplay summaries are ever exposed.
router.use(requireAuth);

/** Map a platform key to its public-handle column on AppPlatformHandles. */
const HANDLE_COLUMN_FOR_PLATFORM: Record<PlatformKey, string> = {
  steam: "steamUsername",
  psn: "psnId",
  xbox: "xboxGamertag",
  gog: "gogUsername",
  epic: "epicUsername",
  ubisoft: "ubisoftUsername",
};

function cuidLike(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function isPlatformKey(value: string): value is PlatformKey {
  return allAdapters.some((a) => a.key === value);
}

function ensureHandleRow(userId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO AppPlatformHandles
       (id, userId, steamUsername, psnId, xboxGamertag, gogUsername, epicUsername,
        ubisoftUsername, hidePlatformIds, createdAt, updatedAt)
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(cuidLike(), userId);
}

function loadPlatformLinks(userId: string): Array<{
  platform: string;
  publicId: string | null;
  displayHandle: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
}> {
  return db
    .prepare(
      `SELECT platform, publicId, displayHandle, connectedAt, lastSyncedAt
       FROM AuthPlatformLinks WHERE userId = ? ORDER BY platform ASC`,
    )
    .all(userId) as Array<{
    platform: string;
    publicId: string | null;
    displayHandle: string | null;
    connectedAt: string | null;
    lastSyncedAt: string | null;
  }>;
}

function readVisibility(userId: string): boolean {
  const row = db
    .prepare("SELECT hidePlatformIds FROM AppPlatformHandles WHERE userId = ?")
    .get(userId) as { hidePlatformIds: number } | undefined;
  return row ? row.hidePlatformIds === 1 : false;
}

/**
 * GET /api/profile-sync/platforms
 * Returns every platform's connection state with masked handles. Tokens are
 * never returned; `encryptionConfigured` hints at whether Connect is available.
 */
router.get("/platforms", (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const hide = readVisibility(authed.user!.userId);
    const links = loadPlatformLinks(authed.user!.userId).map((l) => ({
      platform: l.platform,
      label: PLATFORM_LABELS[l.platform as PlatformKey] ?? l.platform,
      connected: true,
      displayHandle: hide ? maskHandle(l.publicId ?? "") : (l.displayHandle ?? l.publicId),
      lastSyncedAt: l.lastSyncedAt,
    }));
    // Always include unconnected platforms so the client can render the full
    // Connect grid without hard-coding the platform list.
    const connected = new Set(links.map((l) => l.platform));
    const all = allAdapters.map((a) => {
      if (connected.has(a.key)) return links.find((l) => l.platform === a.key)!;
      return {
        platform: a.key,
        label: PLATFORM_LABELS[a.key],
        connected: false,
        displayHandle: null,
        lastSyncedAt: null,
      };
    });
    res.json({
      success: true,
      hidePlatformIds: hide,
      encryptionConfigured: isTokenEncryptionConfigured(),
      platforms: all,
    });
  } catch (err: any) {
    console.error("Error in GET /api/profile-sync/platforms:", err?.message || err);
    sendApiError(res, 500, "Failed to load platform sync state");
  }
});

/**
 * POST /api/profile-sync/connect
 * { platform, publicId, token } -> validates, encrypts the token at rest,
 * stores the link in AuthPlatformLinks, syncs the public handle into
 * AppPlatformHandles, and returns the masked display handle. When
 * MGPL_TOKEN_ENC_KEY is not configured this fails closed (400) so a plaintext
 * token is never persisted.
 */
router.post("/connect", (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = safeCoerce.obj(req.body);
  try {
    const platformRaw = safeCoerce.str(body.platform).toLowerCase().trim();
    const publicId = safeCoerce.str(body.publicId).trim();
    const token = safeCoerce.str(body.token).trim();

    if (!isPlatformKey(platformRaw)) {
      return res.status(400).json({ success: false, error: "Unsupported platform." });
    }
    const adapter = adapterForPlatform(platformRaw)!;
    if (!publicId || !adapter.validatePublicId(publicId)) {
      return res
        .status(400)
        .json({ success: false, error: `Invalid ${PLATFORM_LABELS[platformRaw]} public ID.` });
    }
    if (token.length < 4) {
      return res
        .status(400)
        .json({ success: false, error: "Token is required and must be at least 4 characters." });
    }
    if (!isTokenEncryptionConfigured()) {
      return res.status(400).json({
        success: false,
        error:
          "Local token encryption is not configured (MGPL_TOKEN_ENC_KEY). Connect is blocked until an encryption key is set.",
      });
    }

    const encrypted = encryptToken(token);
    const displayHandle = maskHandle(publicId);
    const userId = authed.user!.userId;

    ensureHandleRow(userId);

    db.prepare(
      `INSERT INTO AuthPlatformLinks
         (id, userId, platform, publicId, displayHandle, tokenEnc, tokenIv, connectedAt, lastSyncedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
       ON CONFLICT(userId, platform) DO UPDATE SET
         publicId = excluded.publicId,
         displayHandle = excluded.displayHandle,
         tokenEnc = excluded.tokenEnc,
         tokenIv = excluded.tokenIv,
         connectedAt = CURRENT_TIMESTAMP,
         lastSyncedAt = NULL`,
    ).run(
      cuidLike(),
      userId,
      platformRaw,
      publicId,
      displayHandle,
      encrypted.tokenEnc,
      encrypted.tokenIv,
    );

    const handleColumn = HANDLE_COLUMN_FOR_PLATFORM[platformRaw];
    db.prepare(
      `UPDATE AppPlatformHandles SET ${handleColumn} = ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?`,
    ).run(publicId, userId);

    res.json({
      success: true,
      connected: {
        platform: platformRaw,
        label: PLATFORM_LABELS[platformRaw],
        publicId,
        displayHandle,
        connected: true,
      },
      message: `Connected ${PLATFORM_LABELS[platformRaw]} as ${displayHandle}.`,
    });
  } catch (err: any) {
    console.error("Error in POST /api/profile-sync/connect:", err?.message || err);
    sendApiError(res, 500, "Failed to connect platform account");
  }
});

/**
 * POST /api/profile-sync/disconnect
 * { platform } -> removes the encrypted token link and clears the public
 * handle. Never touches OAuth AuthAccounts rows (sign-in identity stays intact).
 */
router.post("/disconnect", (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = safeCoerce.obj(req.body);
  try {
    const platformRaw = safeCoerce.str(body.platform).toLowerCase().trim();
    if (!isPlatformKey(platformRaw)) {
      return res.status(400).json({ success: false, error: "Unsupported platform." });
    }
    const userId = authed.user!.userId;
    const removed = db
      .prepare("DELETE FROM AuthPlatformLinks WHERE userId = ? AND platform = ?")
      .run(userId, platformRaw);
    if (removed.changes > 0) {
      const handleColumn = HANDLE_COLUMN_FOR_PLATFORM[platformRaw];
      db.prepare(
        `UPDATE AppPlatformHandles SET ${handleColumn} = NULL, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?`,
      ).run(userId);
    }
    res.json({ success: true, platform: platformRaw, wasConnected: removed.changes > 0 });
  } catch (err: any) {
    console.error("Error in POST /api/profile-sync/disconnect:", err?.message || err);
    sendApiError(res, 500, "Failed to disconnect platform account");
  }
});

/**
 * POST /api/profile-sync/sync
 * { platform } -> runs the platform adapter with the decrypted local token and
 * persists a unified library/playtime/achievement summary. Tokens are used
 * server-side only and never appear in the response.
 */
router.post("/sync", async (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = safeCoerce.obj(req.body);
  try {
    const platformRaw = safeCoerce.str(body.platform).toLowerCase().trim();
    if (!isPlatformKey(platformRaw)) {
      return res.status(400).json({ success: false, error: "Unsupported platform." });
    }
    const userId = authed.user!.userId;
    const link = db
      .prepare(
        "SELECT publicId, tokenEnc, tokenIv FROM AuthPlatformLinks WHERE userId = ? AND platform = ?",
      )
      .get(userId, platformRaw) as
      { publicId: string; tokenEnc: string; tokenIv: string } | undefined;
    if (!link) {
      return res.status(404).json({ success: false, error: "Platform is not connected." });
    }

    const token = decryptToken(link.tokenEnc, link.tokenIv);
    const adapter = adapterForPlatform(platformRaw)!;
    const profile = await adapter.syncProfile({
      platform: platformRaw,
      publicId: link.publicId,
      token,
    });

    const updated = persistSyncedProfile(userId, profile);
    db.prepare(
      "UPDATE AuthPlatformLinks SET lastSyncedAt = CURRENT_TIMESTAMP WHERE userId = ? AND platform = ?",
    ).run(userId, platformRaw);

    res.json({
      success: true,
      platform: platformRaw,
      syncedGames: profile.games.length,
      updatedTracking: updated,
      summary: {
        platform: profile.platform,
        publicId: profile.publicId,
        syncedAt: profile.syncedAt,
        totalPlaytimeMinutes: profile.games.reduce((sum, g) => sum + g.playtimeMinutes, 0),
        achievements: profile.games.reduce((sum, g) => sum + (g.achievements ?? 0), 0),
      },
    });
  } catch (err: any) {
    console.error("Error in POST /api/profile-sync/sync:", err?.message || err);
    sendApiError(res, 500, "Failed to sync platform profile");
  }
});

/**
 * Persist a synced profile into the unified local profile (AppTracking
 * playtime/achievement/date columns + AppOwnership ownership rows). Matching is
 * title-based against the local catalog and is strictly non-destructive.
 */
function persistSyncedProfile(userId: string, profile: PlatformProfile): number {
  let updated = 0;
  const findGame = db.prepare(
    `SELECT "GameID" AS gameId FROM "AppGames" WHERE lower(trim("Game Title")) = lower(trim(?)) LIMIT 1`,
  );
  const getTracking = db.prepare(
    `SELECT "Hours Played" AS h, "Trophy Progress" AS tp FROM "AppTracking" WHERE "GameID" = ?`,
  );
  const upsertTracking = db.prepare(
    `INSERT INTO "AppTracking" ("GameID", "Hours Played", "Last Played Date", "Trophy Progress", "Played Platform")
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT("GameID") DO UPDATE SET
       "Hours Played" = COALESCE(excluded."Hours Played", "AppTracking"."Hours Played"),
       "Last Played Date" = COALESCE(excluded."Last Played Date", "AppTracking"."Last Played Date"),
       "Trophy Progress" = COALESCE(excluded."Trophy Progress", "AppTracking"."Trophy Progress"),
       "Played Platform" = COALESCE(excluded."Played Platform", "AppTracking"."Played Platform")`,
  );

  const insertOwnership = db.prepare(
    `INSERT OR IGNORE INTO "AppOwnership"
       ("OwnershipID", "userId", "GameID", "Platform", "platformCanonical", "Store URL", "Format")
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  );

  const tx = db.transaction(() => {
    for (const game of profile.games) {
      persistGameEntry(userId, game, findGame, getTracking, upsertTracking, insertOwnership);
      updated += 1;
    }
  });
  try {
    tx();
  } catch (err: any) {
    console.error("persistSyncedProfile transaction failed:", err?.message || err);
  }
  return updated;
}

function persistGameEntry(
  userId: string,
  game: PlatformGameEntry,
  findGame: { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown },
  getTracking: { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown },
  upsertTracking: { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown },
  insertOwnership: { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown },
): void {
  const matched = findGame.get(game.title) as { gameId: string } | undefined;
  if (!matched) return;

  const hours = Math.round((game.playtimeMinutes / 60) * 10) / 10;
  const existing = getTracking.get(matched.gameId) as
    { h: number | null; tp: number | null } | undefined;
  const hoursToWrite =
    hours > 0 ? Math.max(hours, Number(existing?.h) || 0) : (existing?.h ?? null);
  const trophyToWrite =
    game.achievements !== undefined
      ? Math.max(game.achievements, Number(existing?.tp) || 0)
      : (existing?.tp ?? null);

  upsertTracking.run(
    matched.gameId,
    hoursToWrite,
    game.lastPlayedAt ?? null,
    trophyToWrite,
    PLATFORM_LABELS[game.platform] ?? game.platform,
  );

  // Lightweight ownership row for the platform so the unified profile's
  // library view reflects the connection (idempotent INSERT OR IGNORE).
  const ownershipId = `${game.platform}:${game.gameId}:${userId}`;
  insertOwnership.run(
    ownershipId,
    userId,
    matched.gameId,
    PLATFORM_LABELS[game.platform] ?? game.platform,
    "PC",
  );
}

/**
 * GET /api/profile-sync/visibility
 * Returns the authenticated user's Hide Platform IDs state.
 */
router.get("/visibility", (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    res.json({ success: true, hidePlatformIds: readVisibility(authed.user!.userId) });
  } catch (err: any) {
    console.error("Error in GET /api/profile-sync/visibility:", err?.message || err);
    sendApiError(res, 500, "Failed to load platform visibility");
  }
});

/**
 * POST /api/profile-sync/visibility
 * { hidePlatformIds: boolean } -> toggles masked display of platform handles
 * across every public profile view. Persisted on AppPlatformHandles so the
 * DB is authoritative (UI state alone is never trusted).
 */
router.post("/visibility", (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = safeCoerce.obj(req.body);
  try {
    const hide = body.hidePlatformIds === true;
    const userId = authed.user!.userId;
    ensureHandleRow(userId);
    db.prepare(
      "UPDATE AppPlatformHandles SET hidePlatformIds = ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?",
    ).run(hide ? 1 : 0, userId);
    res.json({ success: true, hidePlatformIds: hide });
  } catch (err: any) {
    console.error("Error in POST /api/profile-sync/visibility:", err?.message || err);
    sendApiError(res, 500, "Failed to update platform visibility");
  }
});

export default router;
