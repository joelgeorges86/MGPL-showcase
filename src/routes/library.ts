import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";
import { validatePlatform, logPlatformMismatch } from "../utils/platformValidation";
import { sendApiError } from "../middleware/errorSanitizer";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();
// PI-GTM-2026-001 (EPIC-04): respect DB_PATH like src/db.ts so test runners
// never write catalog rows to the production mpgl_app.db.
const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");

// helper function to run db safely
const withDb = <T>(cb: (db: Database.Database) => T): T => {
  const db = new Database(dbPath);
  try {
    return cb(db);
  } finally {
    db.close();
  }
};

// Supported platform labels (normalized to the codebase's canonical labels).
const PLATFORM_LABELS: Record<string, string> = {
  steam: "Steam",
  gog: "GOG",
  epic: "Epic Games",
  other: "Other",
};

// Build a store URL for a given platform + external id (best-effort).
function buildStoreUrl(platform: string, externalId?: string): string | null {
  if (!externalId) return null;
  const p = platform.toLowerCase();
  if (p === "steam") return `https://store.steampowered.com/app/${externalId}`;
  if (p === "gog") return `https://www.gog.com/en/game/${externalId}`;
  if (p === "epic") return `https://store.epicgames.com/p/${externalId}`;
  return null;
}

// Normalize a title for fuzzy comparison (lowercase, collapse whitespace/punct).
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface ImportItem {
  title?: string;
  platform?: string;
  externalId?: string;
  genre?: string;
  installPath?: string;
}

// Resolve an existing GameID for an import item using external store id first,
// then exact title match, then fuzzy title match.
function resolveGameId(db: Database.Database, item: ImportItem): string | null {
  const platform = (item.platform || "Other").toLowerCase();
  const externalId = item.externalId;

  // 1. External store id match (Steam appid / GOG gameId / Epic CatalogItemId).
  if (externalId) {
    if (platform === "steam") {
      const pattern = `%store.steampowered.com/app/${externalId}%`;
      const row = db
        .prepare(`SELECT "GameID" FROM "AppOwnership" WHERE "Store URL" LIKE ? LIMIT 1`)
        .get(pattern) as { GameID?: string } | undefined;
      if (row?.GameID) return row.GameID;
      const gameRow = db
        .prepare(
          `SELECT "GameID" FROM "AppGames" WHERE "storeUrl" LIKE ? OR "platformStoreUrls" LIKE ? LIMIT 1`,
        )
        .get(pattern, pattern) as { GameID?: string } | undefined;
      if (gameRow?.GameID) return gameRow.GameID;
    } else if (platform === "gog") {
      const pattern = `%gog.com%${externalId}%`;
      const row = db
        .prepare(`SELECT "GameID" FROM "AppOwnership" WHERE "Store URL" LIKE ? LIMIT 1`)
        .get(pattern) as { GameID?: string } | undefined;
      if (row?.GameID) return row.GameID;
    } else if (platform === "epic") {
      const pattern = `%store.epicgames.com%${externalId}%`;
      const row = db
        .prepare(`SELECT "GameID" FROM "AppOwnership" WHERE "Store URL" LIKE ? LIMIT 1`)
        .get(pattern) as { GameID?: string } | undefined;
      if (row?.GameID) return row.GameID;
    }
  }

  // 2. Exact (case-insensitive) title match.
  if (item.title) {
    const exact = db
      .prepare(`SELECT "GameID" FROM "AppGames" WHERE LOWER("Game Title") = LOWER(?) LIMIT 1`)
      .get(item.title) as { GameID?: string } | undefined;
    if (exact?.GameID) return exact.GameID;

    // 3. Fuzzy title match (normalized equality).
    const normalized = normalizeTitle(item.title);
    if (normalized) {
      const all = db.prepare(`SELECT "GameID", "Game Title" FROM "AppGames"`).all() as Array<{
        GameID: string;
        "Game Title"?: string;
      }>;
      const fuzzy = all.find(
        (g) => g["Game Title"] && normalizeTitle(g["Game Title"]) === normalized,
      );
      if (fuzzy) return fuzzy.GameID;
    }
  }

  return null;
}

// POST /api/library/import
// Accepts either a raw array or an envelope: { games: [...] }.
router.post("/import", requireAuth, (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).user!.userId;
  const body = req.body || {};
  const rawItems: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray(body.games)
      ? body.games
      : [];

  const items: ImportItem[] = rawItems
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      title: typeof it.title === "string" ? it.title.trim() : undefined,
      platform: typeof it.platform === "string" ? it.platform.trim() : undefined,
      externalId: typeof it.externalId === "string" ? it.externalId.trim() : undefined,
      genre: typeof it.genre === "string" ? it.genre.trim() : undefined,
      installPath: typeof it.installPath === "string" ? it.installPath.trim() : undefined,
    }));

  const total = items.length;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let rejected = 0;
  const rejections: Array<{ title: string; platform: string; error: string }> = [];

  try {
    withDb((db) => {
      const now = new Date().toISOString();

      const insertGameStmt = db.prepare(`
        INSERT INTO "AppGames" ("GameID", "Game Title", "Primary Genre", "storeUrl", "platformStoreUrls", "Date Added", "Last Modified")
        VALUES (@gameId, @title, @genre, @storeUrl, @platformUrls, @dateAdded, @lastModified)
      `);

      const insertOwnershipStmt = db.prepare(`
        INSERT INTO "AppOwnership" ("OwnershipID", "userId", "GameID", "Platform", "platformCanonical", "Store URL", "Format")
        VALUES (@ownershipId, @userId, @gameId, @platform, @platformCanonical, @storeUrl, @format)
      `);

      const getOwnershipStmt = db.prepare(
        `SELECT "OwnershipID" FROM "AppOwnership" WHERE "userId" = ? AND "GameID" = ? AND LOWER("Platform") = LOWER(?) LIMIT 1`,
      );

      const updateOwnershipStmt = db.prepare(`
        UPDATE "AppOwnership"
        SET "Store URL" = COALESCE(?, "Store URL"),
            "Format" = COALESCE(?, "Format"),
            "platformCanonical" = COALESCE(?, "platformCanonical")
        WHERE "OwnershipID" = ?
      `);

      const updateGameStmt = db.prepare(`
        UPDATE "AppGames"
        SET "Primary Genre" = COALESCE(?, "Primary Genre"),
            "Last Modified" = ?
        WHERE "GameID" = ?
      `);

      const getGamePlatformUrlsStmt = db.prepare(
        `SELECT "platformStoreUrls" FROM "AppGames" WHERE "GameID" = ?`,
      );
      const updatePlatformUrlsStmt = db.prepare(
        `UPDATE "AppGames" SET "platformStoreUrls" = ?, "Last Modified" = ? WHERE "GameID" = ?`,
      );

      const seenInBatch = new Set<string>();

      const run = db.transaction(() => {
        for (const item of items) {
          const title = item.title;
          if (!title) {
            skipped++;
            continue;
          }

          const rawPlatform = (item.platform || "").trim();
          // Keep the deterministic display label for known storefronts and
          // preserve the raw source string otherwise (never destroy source
          // fidelity at ingest).
          const platformLabel =
            PLATFORM_LABELS[rawPlatform.toLowerCase()] || rawPlatform || "Other";

          // PI-GTM-2026-001 (EPIC-04): reject unclassified / malformed platform
          // strings with a structured error log instead of guessing.
          const validation = validatePlatform(rawPlatform || platformLabel);
          if (!validation.ok) {
            rejected++;
            rejections.push({
              title,
              platform: rawPlatform || platformLabel,
              error: validation.error || "Platform validation failed",
            });
            logPlatformMismatch(db, {
              tableName: "library-import",
              rowId: title,
              input: rawPlatform || platformLabel,
              canonical: null,
              reason: "EPIC-04 ingest validation rejection",
            });
            continue;
          }
          const platformCanonical = validation.canonical as string;

          const storeUrl = buildStoreUrl(platformLabel, item.externalId);
          const batchKey = `${platformLabel}::${normalizeTitle(title)}`;
          if (seenInBatch.has(batchKey)) {
            skipped++;
            continue;
          }
          seenInBatch.add(batchKey);

          const existingGameId = resolveGameId(db, item);

          if (existingGameId) {
            // Update platform availability + install metadata WITHOUT touching
            // AppTracking (notes, hoursPlayed) or AppCompletionRoadmap.
            updated++;

            // Upsert ownership row for this platform.
            const ownership = getOwnershipStmt.get(userId, existingGameId, platformLabel) as
              { OwnershipID?: string } | undefined;

            if (ownership?.OwnershipID) {
              updateOwnershipStmt.run(
                storeUrl,
                item.installPath || null,
                platformCanonical,
                ownership.OwnershipID,
              );
            } else {
              insertOwnershipStmt.run({
                ownershipId: "O" + randomUUID().substring(0, 8),
                userId,
                gameId: existingGameId,
                platform: platformLabel,
                platformCanonical,
                storeUrl: storeUrl || null,
                format: item.installPath || null,
              });
            }

            // Refresh genre + last modified on the game row.
            updateGameStmt.run(item.genre || null, now, existingGameId);

            // Merge platform store URL into platformStoreUrls JSON.
            if (storeUrl) {
              const urlsRow = getGamePlatformUrlsStmt.get(existingGameId) as
                { platformStoreUrls?: string } | undefined;
              let urls: Record<string, string> = {};
              if (urlsRow?.platformStoreUrls) {
                try {
                  urls = JSON.parse(urlsRow.platformStoreUrls);
                } catch {
                  urls = {};
                }
              }
              urls[platformLabel] = storeUrl;
              updatePlatformUrlsStmt.run(JSON.stringify(urls), now, existingGameId);
            }
          } else {
            // New game.
            inserted++;
            const gameId = "G" + randomUUID().substring(0, 8);
            const platformUrls = storeUrl ? JSON.stringify({ [platformLabel]: storeUrl }) : null;

            insertGameStmt.run({
              gameId,
              title,
              genre: item.genre || null,
              storeUrl: storeUrl || null,
              platformUrls,
              dateAdded: now,
              lastModified: now,
            });

            insertOwnershipStmt.run({
              ownershipId: "O" + randomUUID().substring(0, 8),
              userId,
              gameId,
              platform: platformLabel,
              platformCanonical,
              storeUrl: storeUrl || null,
              format: item.installPath || null,
            });
          }
        }
      });

      run();
    });

    res.json({ success: true, inserted, updated, skipped, rejected, total, rejections });
  } catch (error: any) {
    console.error("Library import error:", error);
    // Sprint 1A (EPICSEC04): never send the raw error message to the client.
    sendApiError(res, 500, "Library import failed");
  }
});

export default router;
