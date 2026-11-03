import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import axios from "axios";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { sanitizeErrorMessage } from "../utils/errorSanitizer";
import {
  SHUTDOWN_RETRY_MESSAGE,
  ShutdownInProgressError,
  shutdownCheckpoint,
} from "../lib/shutdown";

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

// Closes the handle only once an async callback settles, including when it rejects.
const withDbAsync = async <T>(cb: (db: Database.Database) => Promise<T>): Promise<T> => {
  const db = new Database(dbPath);
  try {
    return await cb(db);
  } finally {
    db.close();
  }
};

// Steam Web API response structures
interface SteamGame {
  appid: number;
  name: string;
  playtime_forever: number;
  img_icon_url?: string;
  img_logo_url?: string;
  rtime_last_played?: number;
}

interface SteamResponse {
  response: {
    games?: SteamGame[];
  };
}

// Steam Web API Sync
router.post("/steam", async (req: Request, res: Response) => {
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID64;

  if (!apiKey || !steamId) {
    return res.status(200).json({
      success: false,
      warnings: ["STEAM_API_KEY or STEAM_ID64 is not configured in .env."],
    });
  }

  try {
    const url = `http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&format=json&include_appinfo=1`;
    const response = await axios.get<SteamResponse>(url);
    const games = response.data?.response?.games;

    if (!Array.isArray(games)) {
      return res
        .status(200)
        .json({ success: false, warnings: ["Invalid response from Steam API"] });
    }

    let syncedCount = 0;

    withDb((db) => {
      // Create statement cache
      const getGameStmt = db.prepare(
        `SELECT "GameID" FROM "AppGames" WHERE "storeUrl" LIKE ? OR "platformStoreUrls" LIKE ?`,
      );
      const getOwnershipStmt = db.prepare(
        `SELECT "GameID" FROM "AppOwnership" WHERE "Store URL" LIKE ?`,
      );

      const insertGameStmt = db.prepare(`
        INSERT INTO "AppGames" ("GameID", "Game Title", "cover_url", "storeUrl", "platformStoreUrls")
        VALUES (@gameId, @title, @coverUrl, @storeUrl, @platformUrls)
      `);

      const insertOwnershipStmt = db.prepare(`
        INSERT INTO "AppOwnership" ("OwnershipID", "GameID", "Platform", "platformCanonical", "Store URL")
        VALUES (@ownershipId, @gameId, 'Steam', 'PC', @storeUrl)
      `);

      const getTrackingStmt = db.prepare(
        `SELECT "Play Status" as playStatus FROM "AppTracking" WHERE "GameID" = ?`,
      );
      const updateTrackingStmt = db.prepare(`
        UPDATE "AppTracking"
        SET "Hours Played" = ?, "Play Status" = ?
        WHERE "GameID" = ?
      `);
      const insertTrackingStmt = db.prepare(`
        INSERT INTO "AppTracking" ("GameID", "Hours Played", "Play Status")
        VALUES (?, ?, ?)
      `);

      for (const game of games) {
        const appId = game.appid;
        const searchPattern = `%store.steampowered.com/app/${appId}%`;

        // 1. Match game
        let gameId = null as string | null;
        const ownershipRow = getOwnershipStmt.get(searchPattern) as { GameID?: string };
        if (ownershipRow?.GameID) {
          gameId = ownershipRow.GameID;
        } else {
          const gameRow = getGameStmt.get(searchPattern, searchPattern) as { GameID?: string };
          if (gameRow?.GameID) {
            gameId = gameRow.GameID;
          }
        }

        const storeUrl = `https://store.steampowered.com/app/${appId}`;
        const title = game.name || "Unknown Steam Game";
        const coverUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`;

        if (!gameId) {
          // Upsert game
          gameId = "G" + randomUUID().substring(0, 8);
          const platformUrls = JSON.stringify({ Steam: storeUrl });

          insertGameStmt.run({
            gameId,
            title,
            coverUrl,
            storeUrl,
            platformUrls,
          });

          // Insert ownership
          insertOwnershipStmt.run({
            ownershipId: "O" + randomUUID().substring(0, 8),
            gameId,
            storeUrl,
          });
        }

        // Update tracking
        const hoursPlayed = parseFloat((game.playtime_forever / 60).toFixed(2));
        const tracking = getTrackingStmt.get(gameId) as { playStatus?: string };

        let currentStatus = tracking ? tracking.playStatus : "Not Started";
        if (!currentStatus) currentStatus = "Not Started";

        let newStatus = currentStatus;
        if (game.playtime_forever > 60 && currentStatus === "Not Started") {
          newStatus = "In Progress";
        }

        if (tracking) {
          updateTrackingStmt.run(hoursPlayed, newStatus, gameId);
        } else {
          insertTrackingStmt.run(gameId, hoursPlayed, newStatus);
        }

        syncedCount++;
      }
    });

    res.json({ success: true, synced: syncedCount, warnings: [] });
  } catch (error: any) {
    // Sprint 1A (EPICSEC04): sync failures are surfaced to the client but the
    // raw error message must be sanitized first (no stacks/paths/secrets).
    res.status(200).json({ success: false, errors: [sanitizeErrorMessage(error)] });
  }
});

// Epic Games manifest file structure
interface EpicManifest {
  DisplayName?: string;
  CatalogItemId?: string;
  InstallLocation?: string;
}

// Epic Games Local Manifest Scanner
router.post("/epic", async (req: Request, res: Response) => {
  const manifestsPath = "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests";
  const warnings: string[] = [];

  try {
    if (!fs.existsSync(manifestsPath)) {
      // Sprint 1A (EPICSEC04): never echo the absolute manifests path to the
      // client — the scan location is an internal detail.
      warnings.push("Epic Games manifest path not found");
      return res.status(200).json({ success: false, warnings });
    }

    const files = fs.readdirSync(manifestsPath);
    const itemFiles = files.filter((f: string) => f.endsWith(".item"));
    let syncedCount = 0;

    await withDbAsync(async (db) => {
      const getGameByNameStmt = db.prepare(
        `SELECT "GameID" FROM "AppGames" WHERE LOWER("Game Title") = LOWER(?)`,
      );

      const insertGameStmt = db.prepare(`
        INSERT INTO "AppGames" ("GameID", "Game Title")
        VALUES (@gameId, @title)
      `);

      // Upsert games into AppGames with storefront = 'Epic Games'
      // Wait, there is no storefront column in AppGames. The task says "with storefront = 'Epic Games'"
      // I will add a column check for 'storefront' on AppGames just in case, and insert it,
      // or map it to Platform in AppOwnership.
      // The task specifically says "AppGames with storefront = 'Epic Games'". I will ensure the column exists.

      const addColumnIfMissing = () => {
        const columns = db.prepare('PRAGMA table_info("AppGames")').all() as Array<{
          name: string;
        }>;
        if (!columns.some((c) => c.name.toLowerCase() === "storefront")) {
          db.prepare('ALTER TABLE "AppGames" ADD COLUMN "storefront" TEXT').run();
        }
      };
      addColumnIfMissing();

      const updateStorefrontStmt = db.prepare(`
        UPDATE "AppGames" SET "storefront" = 'Epic Games' WHERE "GameID" = ?
      `);

      // AI-056: one manifest per iteration. Its writes share one try, so a held lock
      // costs one wait per manifest; the checkpoint lets shutdown stop the loop there.
      for (const file of itemFiles) {
        await shutdownCheckpoint();
        const filePath = path.join(manifestsPath, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const data = JSON.parse(content) as EpicManifest;
          const title = data.DisplayName;

          if (!title) continue;

          let gameId = null as string | null;
          const gameRow = getGameByNameStmt.get(title) as { GameID?: string };

          if (gameRow?.GameID) {
            gameId = gameRow.GameID;
          } else {
            gameId = "G" + randomUUID().substring(0, 8);
            insertGameStmt.run({ gameId, title });
          }

          // Update storefront
          updateStorefrontStmt.run(gameId);
          syncedCount++;
        } catch (e: any) {
          warnings.push(sanitizeErrorMessage(`Error reading ${file}: ${(e as Error).message}`));
        }
      }
    });

    res.json({ success: true, synced: syncedCount, warnings });
  } catch (error: any) {
    if (error instanceof ShutdownInProgressError) {
      res.status(503).json({ success: false, errors: [SHUTDOWN_RETRY_MESSAGE] });
      return;
    }
    res.status(200).json({ success: false, errors: [sanitizeErrorMessage(error)] });
  }
});

// Master Aggregator
router.post("/all-stats", async (req: Request, res: Response) => {
  // Call steam and epic endpoints internally or via logic.
  // Wait, Promise.allSettled requires us to call the endpoints. We can do it locally using axios to localhost.
  const port = process.env.PORT || 4000;
  const baseUrl = `http://127.0.0.1:${port}/api/sync`;
  const authHeaders = req.headers.authorization
    ? { Authorization: req.headers.authorization }
    : req.headers.cookie
      ? { Cookie: req.headers.cookie }
      : {};

  try {
    const [steamRes, epicRes] = await Promise.allSettled([
      axios.post(`${baseUrl}/steam`, {}, { headers: authHeaders }),
      axios.post(`${baseUrl}/epic`, {}, { headers: authHeaders }),
    ]);

    let steamSynced = 0;
    let epicSynced = 0;
    const warnings: string[] = [];

    if (steamRes.status === "fulfilled") {
      const data = steamRes.value.data as {
        synced?: number;
        warnings?: string[];
        errors?: string[];
      };
      steamSynced = data.synced || 0;
      if (data.warnings) {
        warnings.push(...data.warnings);
      }
      if (data.errors) {
        warnings.push(...data.errors);
      }
    } else {
      warnings.push(
        sanitizeErrorMessage(`Steam sync failed: ${(steamRes.reason as Error).message}`),
      );
    }

    if (epicRes.status === "fulfilled") {
      const data = epicRes.value.data as {
        synced?: number;
        warnings?: string[];
        errors?: string[];
      };
      epicSynced = data.synced || 0;
      if (data.warnings) {
        warnings.push(...data.warnings);
      }
      if (data.errors) {
        warnings.push(...data.errors);
      }
    } else {
      warnings.push(sanitizeErrorMessage(`Epic sync failed: ${(epicRes.reason as Error).message}`));
    }

    res.json({
      success: true,
      synced: {
        steam: steamSynced,
        epic: epicSynced,
      },
      warnings,
    });
  } catch (error: any) {
    res.status(200).json({ success: false, errors: [sanitizeErrorMessage(error)] });
  }
});

export default router;
