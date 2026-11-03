import { Router, Request, Response } from "express";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import path from "path";
import { sendApiError } from "../middleware/errorSanitizer";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });
const router = Router();

export interface SuggestionParams {
  timeAvailable?: number | string; // 30, 60, 120, 'any', '<30m', '30-90m', '2h+'
  energyLevel?: "low" | "medium" | "high" | "any" | string;
  installedOnly?: boolean;
  deviceId?: string;
}

export interface RecommendationCard {
  gameId: string;
  title: string;
  coverUrl: string | null;
  matchScore: number; // 0 - 100 percentage
  timeRemainingHrs: number | null;
  playabilityBadge: string;
  reasonTags: string[];
  genres: string[];
  primaryGenre: string | null;
  hoursPlayed: number;
  playStatus: string | null;
}

/**
 * Helper to fetch game genres from database
 */
function getGameGenres(
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

    if (rows?.length > 0) {
      return rows.map((r) => r.name);
    }
  } catch (e) {
    // fallback if table does not exist
  }
  return primaryGenre ? [primaryGenre] : [];
}

/**
 * Infer playability badge for a game on a given target device spec
 */
function computePlayabilityBadgeWithDevice(
  game: { minRamGb?: number | null; minVramGb?: number | null; gameId: string },
  device?: { ramGb?: number; vramGb?: number } | null,
): string {
  if (!device) return "30-60 FPS Playable";

  const devRam = device.ramGb ?? 16;
  const devVram = device.vramGb ?? 6;
  const minRam = game.minRamGb ?? 8;
  const minVram = game.minVramGb ?? 2;

  if (devRam < minRam || devVram < minVram) {
    return "Low FPS / Tweaks Needed";
  } else if (devRam >= minRam + 8 && devVram >= minVram + 4) {
    return "60 FPS Great";
  } else {
    return "30-60 FPS Playable";
  }
}

/**
 * POST /api/recommender/suggest
 * Session Recommender & Backlog Grooming Engine
 */
router.post("/suggest", (req: Request, res: Response) => {
  try {
    const body: SuggestionParams = req.body || {};

    const rawTime = body.timeAvailable;
    let maxTimeHrs: number | null = null;
    let minTimeHrs: number | null = null;

    if (rawTime === 30 || rawTime === "30" || rawTime === "<30m" || rawTime === "15m") {
      maxTimeHrs = 0.5;
    } else if (rawTime === 60 || rawTime === "60" || rawTime === "30-90m" || rawTime === "1h") {
      minTimeHrs = 0.5;
      maxTimeHrs = 1.5;
    } else if (
      rawTime === 120 ||
      rawTime === "120" ||
      rawTime === "2h+" ||
      rawTime === "2h" ||
      rawTime === "4h+"
    ) {
      minTimeHrs = 1.5;
    }

    const energyLevel = (body.energyLevel ?? "any").toString().toLowerCase();
    const installedOnly = Boolean(body.installedOnly);
    const deviceId = body.deviceId || undefined;

    // Fetch owned, active games joined with HLTB, friction, tracking, and ownership data
    const query = `
      SELECT DISTINCT
        g."GameID" as gameId,
        g."Game Title" as title,
        g."cover_url" as coverUrl,
        g."Primary Genre" as primaryGenre,
        g."Min RAM GB" as minRamGb,
        g."Min VRAM GB" as minVramGb,
        r."main_story_hours" as mainStoryHours,
        f."Cognitive / Mental Energy Required" as cognitiveEnergy,
        f."Core Session Loop Length" as sessionLoop,
        f."Suspend / Pause Friendly?" as suspendFriendly,
        f."Always-Online Required?" as alwaysOnline,
        t."Hours Played" as hoursPlayed,
        t."Play Status" as playStatus,
        p."estimatedBatteryRuntime" as estimatedBatteryRuntime,
        (
          SELECT COUNT(1) 
          FROM "AppOwnership" o 
          WHERE o."GameID" = g."GameID" 
            AND (o."Store URL" IS NOT NULL OR o."Platform" IS NOT NULL)
        ) as ownershipCount
      FROM "AppGames" g
      JOIN "AppOwnership" o ON o."GameID" = g."GameID"
      LEFT JOIN "AppCompletionRoadmap" r ON r."GameID" = g."GameID"
      LEFT JOIN "AppGameFriction" f ON f."GameID" = g."GameID"
      LEFT JOIN "AppTracking" t ON t."GameID" = g."GameID"
      LEFT JOIN "GameDeviceProfiles" p ON p."gameId" = g."GameID" AND (p."deviceId" = ? OR p."deviceId" IS NULL)
      WHERE (g."Active" IS NULL OR LOWER(g."Active") IN ('true', '1', 'yes'))
    `;

    const rows = db.prepare(query).all(deviceId || "") as Array<{
      gameId: string;
      title: string | null;
      coverUrl: string | null;
      primaryGenre: string | null;
      minRamGb: number | null;
      minVramGb: number | null;
      mainStoryHours: number | null;
      cognitiveEnergy: string | null;
      sessionLoop: string | null;
      suspendFriendly: string | null;
      alwaysOnline: string | null;
      hoursPlayed: number | null;
      playStatus: string | null;
      estimatedBatteryRuntime: number | null;
      ownershipCount: number;
    }>;

    // Pre-fetch active device specs to avoid N+1 queries in loop
    let activeDevice: { ramGb?: number; vramGb?: number } | null = null;
    if (deviceId) {
      try {
        activeDevice =
          (db
            .prepare('SELECT ramGb, vramGb FROM "Devices" WHERE "deviceId" = ? OR id = ?')
            .get(deviceId, deviceId) as { ramGb?: number; vramGb?: number } | undefined) || null;
      } catch (e) {
        // Table or query fallback
      }
    }

    // Batch fetch all game genre mappings to avoid N+1 queries in loop
    const genreMap = new Map<string, string[]>();
    try {
      const genreRows = db
        .prepare(
          `
        SELECT m."GameID" as gameId, g."GenreName" as name
        FROM "AppGenres" g
        JOIN "AppGameGenreMap" m ON m."GenreID" = g."GenreID"
      `,
        )
        .all() as { gameId: string; name: string }[];

      for (const r of genreRows) {
        if (!genreMap.has(r.gameId)) {
          genreMap.set(r.gameId, []);
        }
        genreMap.get(r.gameId)!.push(r.name);
      }
    } catch (e) {
      // fallback if table does not exist
    }

    const results: RecommendationCard[] = [];

    for (const row of rows) {
      if (installedOnly && row.ownershipCount === 0) {
        continue;
      }

      let score = 70; // Base baseline score
      const reasonTags: string[] = [];

      const storyHours =
        row.mainStoryHours !== null && row.mainStoryHours !== undefined
          ? Number(row.mainStoryHours)
          : null;
      const hoursPlayed =
        row.hoursPlayed !== null && row.hoursPlayed !== undefined ? Number(row.hoursPlayed) : 0;
      const cogEnergy = (row.cognitiveEnergy || "").toLowerCase();

      // 1. Time Fit Evaluation
      if (maxTimeHrs !== null || minTimeHrs !== null) {
        if (storyHours !== null) {
          if (maxTimeHrs === 0.5 && storyHours <= 5) {
            score += 15;
            reasonTags.push("Fits short session");
          } else if (maxTimeHrs === 0.5 && storyHours <= 12) {
            score += 10;
            reasonTags.push("Fits 30m window");
          } else if (
            minTimeHrs === 0.5 &&
            maxTimeHrs === 1.5 &&
            storyHours > 3 &&
            storyHours <= 25
          ) {
            score += 15;
            reasonTags.push("Fits 30-90m window");
          } else if (minTimeHrs === 1.5 && storyHours > 15) {
            score += 15;
            reasonTags.push("Great for long sessions");
          } else {
            score += 5;
          }
        } else {
          reasonTags.push("Fits play window");
        }
      }

      // 2. Cognitive Energy Evaluation
      if (energyLevel !== "any") {
        if (energyLevel === "low") {
          if (
            cogEnergy.includes("low") ||
            cogEnergy.includes("casual") ||
            cogEnergy.includes("relax") ||
            cogEnergy.includes("cozy")
          ) {
            score += 15;
            reasonTags.push("Relaxing / Low Energy");
          } else if (cogEnergy.includes("high") || cogEnergy.includes("competitive")) {
            score -= 15;
          }
        } else if (energyLevel === "medium") {
          if (cogEnergy.includes("moderate") || cogEnergy.includes("medium") || cogEnergy === "") {
            score += 15;
            reasonTags.push("Balanced Focus");
          }
        } else if (energyLevel === "high") {
          if (
            cogEnergy.includes("high") ||
            cogEnergy.includes("tactical") ||
            cogEnergy.includes("reflex") ||
            cogEnergy.includes("competitive")
          ) {
            score += 15;
            reasonTags.push("High Focus Challenge");
          } else if (cogEnergy.includes("casual") || cogEnergy.includes("relax")) {
            score -= 10;
          }
        }
      }

      // 3. Backlog Grooming Signal
      const playStatus = (row.playStatus || "").toLowerCase();
      if (
        hoursPlayed === 0 ||
        playStatus.includes("backlog") ||
        playStatus.includes("unplayed") ||
        playStatus.includes("want to play")
      ) {
        score += 10;
        reasonTags.push("Backlog Pick");
      } else if (playStatus.includes("playing") || playStatus.includes("active")) {
        score += 8;
        reasonTags.push("Currently Playing");
      }

      // 4. Suspend / Pause & Battery Benefits
      const suspend = (row.suspendFriendly || "").toLowerCase();
      if (suspend.includes("yes") || suspend.includes("friendly") || suspend.includes("true")) {
        score += 5;
        reasonTags.push("Pause Friendly");
      }

      const playabilityBadge = computePlayabilityBadgeWithDevice(
        { minRamGb: row.minRamGb, minVramGb: row.minVramGb, gameId: row.gameId },
        activeDevice,
      );

      if (playabilityBadge === "60 FPS Great") {
        score += 10;
        reasonTags.push("Great on active device");
      } else if (playabilityBadge === "30-60 FPS Playable") {
        score += 5;
      }

      // Clamp match score between 0 and 99%
      const finalMatchScore = Math.min(99, Math.max(35, Math.round(score)));
      const genres = genreMap.get(row.gameId) ?? (row.primaryGenre ? [row.primaryGenre] : []);

      // Unique reason tags only (max 3)
      const uniqueTags = Array.from(new Set(reasonTags)).slice(0, 3);
      if (uniqueTags.length === 0) {
        uniqueTags.push("Recommended Pick");
      }

      results.push({
        gameId: row.gameId,
        title: row.title || "Untitled Game",
        coverUrl: row.coverUrl || null,
        matchScore: finalMatchScore,
        timeRemainingHrs: storyHours,
        playabilityBadge,
        reasonTags: uniqueTags,
        genres,
        primaryGenre: row.primaryGenre || null,
        hoursPlayed,
        playStatus: row.playStatus || null,
      });
    }

    // Sort descending by match score
    results.sort((a, b) => b.matchScore - a.matchScore);

    res.json({
      success: true,
      count: results.length,
      recommendations: results.slice(0, 24),
    });
  } catch (error) {
    console.error("Session Recommender error:", error);
    sendApiError(res, 500, "Failed to compute session recommendations");
  }
});

export default router;
