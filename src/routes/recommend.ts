import { Router, Request, Response } from "express";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import path from "path";
import { sendApiError } from "../middleware/errorSanitizer";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });
const dbWrite: DatabaseType = openDatabase(dbPath);

const router = Router();

/**
 * Interface for game recommendations
 */
interface GameRecommendation {
  gameId: string;
  title: string | null;
  mainStoryHours: number | null;
  estimatedBatteryRuntime: number | null;
  isWithinTimeLimit: boolean;
  genres: string[];
  storageSize: string | null;
  coverUrl: string | null;
  focusLevel?: string | null;
}

/**
 * Ensure GameDeviceProfiles table exists
 */
function ensureGameDeviceProfilesTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS "GameDeviceProfiles" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "gameId" TEXT NOT NULL,
        "deviceId" TEXT NOT NULL,
        "estimatedBatteryRuntime" REAL,
        "isPluggedOnly" INTEGER DEFAULT 0,
        "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("gameId", "deviceId")
      )
    `,
      )
      .run();
  } catch (e) {
    console.error("Failed to ensure GameDeviceProfiles table:", e);
  }
}

/**
 * Helper to infer focus level from genres when cognitive energy is missing
 */
function inferFocusLevel(genres: string[], primaryGenre: string | null): string {
  const allGenres = [...genres, primaryGenre ?? ""].map((g) => g.toLowerCase());
  const genreText = allGenres.join(" ");

  const casualKeywords = [
    "casual",
    "relax",
    "cozy",
    "puzzle",
    "card",
    "board",
    "simulation",
    "family",
    "indie",
    "trivia",
    "party",
  ];
  const highKeywords = [
    "tactical",
    "reflex",
    "competitive",
    "souls-like",
    "soulslike",
    "action",
    "fps",
    "shooter",
    "fighting",
    "racing",
    "strategy",
    "survival",
  ];

  if (casualKeywords.some((kw) => genreText.includes(kw))) {
    return "casual";
  }
  if (highKeywords.some((kw) => genreText.includes(kw))) {
    return "high";
  }
  return "moderate";
}

/**
 * Helper to get all genres for a game, falling back to primary genre
 */
function getGenresForGame(
  database: DatabaseType,
  gameId: string,
  primaryGenre: string | null,
): string[] {
  try {
    const rows = database
      .prepare(
        `
      SELECT g."GenreName" as name
      FROM "AppGenres" g
      JOIN "AppGameGenreMap" m ON m."GenreID" = g."GenreID"
      WHERE m."GameID" = ?
    `,
      )
      .all(gameId) as { name: string }[];

    if (rows.length > 0) {
      return rows.map((r) => r.name);
    }
  } catch (e) {
    console.warn(`Failed to fetch genres for game ${gameId}:`, e);
  }
  return primaryGenre ? [primaryGenre] : [];
}

/**
 * Parse and validate maxHours query parameter
 */
function parseMaxHours(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) || parsed <= 0 ? 0 : parsed;
}

/**
 * Parse boolean query parameter
 */
function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/**
 * GET /api/games/recommend
 * Returns game recommendations filtered by maxHours, focusLevel, deviceContext/deviceId, unpluggedOnly.
 * Only returns active owned games.
 */
router.get("/", (req: Request, res: Response) => {
  try {
    // Ensure tables exist
    ensureGameDeviceProfilesTable();

    const maxHours = req.query.maxHours as string | undefined;
    const focusLevel = req.query.focusLevel as string | undefined;
    const deviceContext = req.query.deviceContext as string | undefined;
    const deviceId = req.query.deviceId as string | undefined;
    const unpluggedOnly = req.query.unpluggedOnly as string | undefined;

    const maxHoursNum = parseMaxHours(maxHours);
    const deviceIdFilter = deviceId || null;
    const isHandheldContext = deviceContext === "handheld" || parseBoolean(unpluggedOnly);

    // SQL query with LEFT JOIN GameDeviceProfiles and joins to AppCompletionRoadmap and AppGameFriction
    let sql = `
      SELECT DISTINCT
        g."GameID" as gameId,
        g."Game Title" as title,
        g."cover_url" as coverUrl,
        g."Storage Size" as storageSize,
        g."Primary Genre" as primaryGenre,
        r."main_story_hours" as mainStoryHours,
        r."Main Story Time" as mainStoryText,
        f."Cognitive / Mental Energy Required" as cognitiveEnergy,
        p."estimatedBatteryRuntime" as estimatedBatteryRuntime,
        p."deviceId" as profileDeviceId,
        p."isPluggedOnly" as isPluggedOnly
      FROM "AppGames" g
      JOIN "AppOwnership" o ON o."GameID" = g."GameID"
      LEFT JOIN "GameDeviceProfiles" p ON p."gameId" = g."GameID"
      LEFT JOIN "AppCompletionRoadmap" r ON r."GameID" = g."GameID"
      LEFT JOIN "AppGameFriction" f ON f."GameID" = g."GameID"
      WHERE (g."Active" IS NULL OR LOWER(g."Active") = 'true' OR LOWER(g."Active") = '1' OR LOWER(g."Active") = 'yes' OR g."Active" = '1')
    `;

    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (deviceIdFilter) {
      conditions.push('(p."deviceId" = ? OR p."deviceId" IS NULL)');
      params.push(deviceIdFilter);
    }

    if (isHandheldContext) {
      conditions.push('(p."isPluggedOnly" IS NULL OR p."isPluggedOnly" = 0)');
    }

    if (conditions.length > 0) {
      sql += " AND " + conditions.join(" AND ");
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      gameId: string;
      title: string | null;
      coverUrl: string | null;
      storageSize: string | null;
      primaryGenre: string | null;
      mainStoryHours: number | null;
      mainStoryText: string | null;
      cognitiveEnergy: string | null;
      estimatedBatteryRuntime: number | null;
      profileDeviceId: string | null;
      isPluggedOnly: number | null;
    }>;

    const filteredRows = rows.filter((row) => {
      const genres = getGenresForGame(db, row.gameId, row.primaryGenre);
      const effectiveFocus = row.cognitiveEnergy || inferFocusLevel(genres, row.primaryGenre);
      const focusLower = effectiveFocus.toLowerCase();

      // Focus level filtering
      if (focusLevel && focusLevel !== "all") {
        if (focusLevel === "casual") {
          if (
            !focusLower.includes("relax") &&
            !focusLower.includes("low") &&
            !focusLower.includes("casual")
          ) {
            return false;
          }
        } else if (focusLevel === "moderate") {
          if (
            !focusLower.includes("moderate") &&
            (focusLower.includes("high") || focusLower.includes("competitive"))
          ) {
            return false;
          }
        } else if (focusLevel === "high") {
          if (
            !focusLower.includes("high") &&
            !focusLower.includes("tactical") &&
            !focusLower.includes("reflex") &&
            !focusLower.includes("competitive")
          ) {
            return false;
          }
        }
      }

      return true;
    });

    const recommendations: GameRecommendation[] = filteredRows.map((row) => {
      let storyHours: number | null =
        row.mainStoryHours !== null && row.mainStoryHours !== undefined
          ? Number(row.mainStoryHours)
          : null;
      if ((storyHours === null || Number.isNaN(storyHours)) && row.mainStoryText) {
        const match = row.mainStoryText.match(/([\d.]+)/);
        if (match) {
          storyHours = parseFloat(match[1]);
        }
      }

      let batteryHours =
        row.estimatedBatteryRuntime !== null && row.estimatedBatteryRuntime !== undefined
          ? Number(row.estimatedBatteryRuntime)
          : null;
      const validStoryHours =
        storyHours !== null && !Number.isNaN(storyHours) && storyHours > 0 ? storyHours : null;

      // Calculate battery runtime estimation if device spec exists in fleet Devices table
      if ((batteryHours === null || Number.isNaN(batteryHours)) && deviceIdFilter) {
        try {
          const dev = db
            .prepare('SELECT batteryWh FROM "Devices" WHERE "deviceId" = ? OR id = ?')
            .get(deviceIdFilter, deviceIdFilter) as { batteryWh?: number } | undefined;
          if (dev && dev.batteryWh && dev.batteryWh > 0) {
            batteryHours = parseFloat((dev.batteryWh / 21.0).toFixed(1));
          }
        } catch (e) {
          // fallback
        }
      }

      const validBatteryHours =
        batteryHours !== null && !Number.isNaN(batteryHours) && batteryHours > 0
          ? batteryHours
          : null;

      let isWithinTimeLimit = true;

      if (maxHoursNum > 0) {
        if (validStoryHours !== null) {
          isWithinTimeLimit = validStoryHours <= maxHoursNum;
        } else if (validBatteryHours !== null) {
          isWithinTimeLimit = validBatteryHours <= maxHoursNum;
        }
      }

      const gameGenres = getGenresForGame(db, row.gameId, row.primaryGenre);
      const effectiveFocus = row.cognitiveEnergy ?? inferFocusLevel(gameGenres, row.primaryGenre);

      return {
        gameId: row.gameId,
        title: row.title ?? null,
        mainStoryHours: validStoryHours,
        estimatedBatteryRuntime: validBatteryHours,
        isWithinTimeLimit,
        genres: gameGenres,
        storageSize: row.storageSize,
        coverUrl: row.coverUrl,
        focusLevel: effectiveFocus,
      };
    });

    res.json({
      success: true,
      recommendations,
    });
  } catch (error) {
    console.error("Recommendation error:", error);
    sendApiError(res, 500, "Failed to generate recommendations");
  }
});

export default router;
