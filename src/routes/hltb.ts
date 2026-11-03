import { Router, Request, Response } from "express";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import path from "path";
import { HowLongToBeatService, HowLongToBeatEntry } from "howlongtobeat";
import { sendApiError } from "../middleware/errorSanitizer";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });
const dbWrite: DatabaseType = openDatabase(dbPath);
const hltbService = new HowLongToBeatService();

const router = Router();

/**
 * Parse a numeric value from a raw DB cell, falling back to a text regex parse
 * (mirrors compare.ts). Returns null when nothing parseable is present.
 */
function parseHours(numeric: unknown, text: unknown): number | null {
  if (numeric !== null && numeric !== undefined && numeric !== "") {
    const n = Number(numeric);
    if (!Number.isNaN(n)) return n;
  }
  if (text !== null && text !== undefined) {
    const match = String(text).match(/([\d.]+)/);
    if (match) {
      const n = parseFloat(match[1]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

/**
 * Ensure the AppCompletionRoadmapCache table exists (idempotent).
 */
function ensureCacheTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS AppCompletionRoadmapCache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gameTitle TEXT UNIQUE,
        mainStory REAL,
        mainExtra REAL,
        completionist REAL,
        hltbScore REAL,
        cachedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `,
      )
      .run();
  } catch (e) {
    console.error("Failed to ensure AppCompletionRoadmapCache table:", e);
  }
}

/**
 * Ensure the targetStyle column exists on AppTracking (idempotent).
 */
function ensureTargetStyleColumn() {
  try {
    const info = dbWrite.prepare('PRAGMA table_info("AppTracking")').all() as any[];
    const hasColumn = info.some((c) => c.name === "targetStyle");
    if (!hasColumn) {
      dbWrite.prepare('ALTER TABLE "AppTracking" ADD COLUMN "targetStyle" TEXT').run();
    }
  } catch (e) {
    console.error("Failed to ensure targetStyle column:", e);
  }
}

/**
 * Resolve HLTB metrics for a title. Priority:
 *   1. AppCompletionRoadmapCache (title-keyed, live HLTB values)
 *   2. AppCompletionRoadmap (production roadmap, numeric + text fallback)
 *   3. Live HowLongToBeatService.search() -> cache into AppCompletionRoadmapCache
 * Returns { mainStory, mainExtra, completionist, hltbScore, source }.
 */
async function resolveHltbMetrics(gameTitle: string): Promise<{
  mainStory: number | null;
  mainExtra: number | null;
  completionist: number | null;
  hltbScore: number | null;
  source: string;
}> {
  const title = (gameTitle || "").trim();
  if (!title) {
    return {
      mainStory: null,
      mainExtra: null,
      completionist: null,
      hltbScore: null,
      source: "none",
    };
  }

  // 1. Title-keyed cache
  try {
    const cached = db
      .prepare(
        'SELECT "mainStory", "mainExtra", "completionist", "hltbScore" FROM "AppCompletionRoadmapCache" WHERE "gameTitle" = ?',
      )
      .get(title) as any;
    if (cached) {
      return {
        mainStory: cached.mainStory ?? null,
        mainExtra: cached.mainExtra ?? null,
        completionist: cached.completionist ?? null,
        hltbScore: cached.hltbScore ?? null,
        source: "cache",
      };
    }
  } catch (e) {
    // fall through
  }

  // 2. Production roadmap (numeric + text fallback)
  try {
    const row = db
      .prepare(
        'SELECT "main_story_hours", "completionist_hours", "Main Story Time", "Estimated 100% Completion Time" FROM "AppCompletionRoadmap" WHERE "Game Title" = ?',
      )
      .get(title) as any;
    if (row) {
      const mainStory = parseHours(row.main_story_hours, row["Main Story Time"]);
      const completionist = parseHours(
        row.completionist_hours,
        row["Estimated 100% Completion Time"],
      );
      if (mainStory !== null || completionist !== null) {
        const mainExtra = mainStory !== null ? Math.round(mainStory * 1.5 * 10) / 10 : null;
        const hltbScore = mainStory !== null ? Math.round(mainStory * 10) / 10 : null;
        return { mainStory, mainExtra, completionist, hltbScore, source: "roadmap" };
      }
    }
  } catch (e) {
    // fall through
  }

  // 3. Live HLTB fetch -> cache
  try {
    const results = await hltbService.search(title);
    if (results && results.length > 0) {
      const best: HowLongToBeatEntry = results[0];
      const mainStory = best.gameplayMain ?? null;
      const mainExtra = best.gameplayMainExtra ?? null;
      const completionist = best.gameplayCompletionist ?? null;
      const hltbScore = mainStory !== null ? Math.round(mainStory * 10) / 10 : null;
      ensureCacheTable();
      dbWrite
        .prepare(
          `
        INSERT INTO "AppCompletionRoadmapCache" ("gameTitle", "mainStory", "mainExtra", "completionist", "hltbScore")
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT("gameTitle") DO UPDATE SET
          "mainStory" = excluded."mainStory",
          "mainExtra" = excluded."mainExtra",
          "completionist" = excluded."completionist",
          "hltbScore" = excluded."hltbScore",
          "cachedAt" = CURRENT_TIMESTAMP
      `,
        )
        .run(title, mainStory, mainExtra, completionist, hltbScore);
      return { mainStory, mainExtra, completionist, hltbScore, source: "hltb" };
    }
  } catch (e) {
    console.error("HLTB live search failed:", e);
  }

  return { mainStory: null, mainExtra: null, completionist: null, hltbScore: null, source: "none" };
}

/**
 * GET /api/hltb/search?game=<title>
 * Returns HLTB time-to-beat metrics for a single game.
 */
router.get("/search", async (req: Request, res: Response) => {
  try {
    const game = typeof req.query.game === "string" ? req.query.game : "";
    if (!game) {
      return res.status(400).json({ success: false, error: "game query parameter is required" });
    }
    const metrics = await resolveHltbMetrics(game);
    res.json({ success: true, game, ...metrics });
  } catch (error) {
    console.error("HLTB search error:", error);
    sendApiError(res, 500, "Failed to search HLTB metrics");
  }
});

/**
 * GET /api/hltb/summary
 * Aggregate backlog metrics across tracked games:
 *   - totalHoursMain / totalHoursCompletionist (sum of time-to-beat)
 *   - averageGameLength (mean main-story hours)
 *   - completedCount / remainingCount
 *   - completionPercent (completed / tracked)
 *   - games[] with per-game HLTB + progress
 */
router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const rows = db
      .prepare(
        `
      SELECT
        g."GameID" as gameId,
        g."Game Title" as title,
        g."cover_url" as coverUrl,
        t."Play Status" as playStatus,
        t."Hours Played" as hoursPlayed,
        t."Completed Date" as completedDate,
        r."main_story_hours" as mainStoryHours,
        r."completionist_hours" as completionistHours,
        r."Main Story Time" as mainStoryText,
        r."Estimated 100% Completion Time" as completionistText
      FROM "AppGames" g
      LEFT JOIN "AppTracking" t ON t."GameID" = g."GameID"
      LEFT JOIN "AppCompletionRoadmap" r ON r."GameID" = g."GameID"
      WHERE t."GameID" IS NOT NULL
      ORDER BY g."Game Title" ASC
    `,
      )
      .all() as Array<{
      gameId: string;
      title: string | null;
      coverUrl: string | null;
      playStatus: string | null;
      hoursPlayed: number | null;
      completedDate: string | null;
      mainStoryHours: number | null;
      completionistHours: number | null;
      mainStoryText: string | null;
      completionistText: string | null;
    }>;

    const games = rows.map((row) => {
      const mainStory = parseHours(row.mainStoryHours, row.mainStoryText);
      const completionist = parseHours(row.completionistHours, row.completionistText);
      const mainExtra = mainStory !== null ? Math.round(mainStory * 1.5 * 10) / 10 : null;
      const hoursPlayed =
        row.hoursPlayed !== null && row.hoursPlayed !== undefined ? Number(row.hoursPlayed) : 0;
      const status = (row.playStatus || "").toLowerCase();
      const isCompleted =
        !!row.completedDate ||
        status.includes("completed") ||
        status.includes("finished") ||
        status.includes("100%");
      const targetHours = mainStory ?? mainExtra ?? completionist ?? 0;
      const progressPercent =
        targetHours > 0 ? Math.min(100, Math.round((hoursPlayed / targetHours) * 100)) : 0;
      return {
        gameId: row.gameId,
        title: row.title ?? null,
        coverUrl: row.coverUrl ?? null,
        playStatus: row.playStatus ?? null,
        hoursPlayed,
        completed: isCompleted,
        hltb: { mainStory, mainExtra, completionist },
        progressPercent,
      };
    });

    const withHours = games.filter(
      (g) => g.hltb.mainStory !== null || g.hltb.completionist !== null,
    );
    const totalHoursMain = withHours.reduce((sum, g) => sum + (g.hltb.mainStory ?? 0), 0);
    const totalHoursCompletionist = withHours.reduce(
      (sum, g) => sum + (g.hltb.completionist ?? 0),
      0,
    );
    const averageGameLength =
      withHours.length > 0 ? Math.round((totalHoursMain / withHours.length) * 10) / 10 : 0;
    const completedCount = games.filter((g) => g.completed).length;
    const remainingCount = games.length - completedCount;
    const completionPercent =
      games.length > 0 ? Math.round((completedCount / games.length) * 100) : 0;

    res.json({
      success: true,
      totalGames: games.length,
      totalHoursMain: Math.round(totalHoursMain * 10) / 10,
      totalHoursCompletionist: Math.round(totalHoursCompletionist * 10) / 10,
      averageGameLength,
      completedCount,
      remainingCount,
      completionPercent,
      games,
    });
  } catch (error) {
    console.error("HLTB summary error:", error);
    sendApiError(res, 500, "Failed to build backlog summary");
  }
});

/**
 * POST /api/hltb/progress
 * Body: { gameId, hoursPlayed?, targetStyle? }
 * Updates AppTracking hoursPlayed + targetStyle, returns remaining time-to-beat.
 */
router.post("/progress", async (req: Request, res: Response) => {
  try {
    const { gameId, hoursPlayed, targetStyle } = req.body || {};
    if (!gameId) {
      return res.status(400).json({ success: false, error: "gameId is required" });
    }

    ensureTargetStyleColumn();

    const game = db
      .prepare('SELECT "GameID", "Game Title" as title FROM "AppGames" WHERE "GameID" = ?')
      .get(gameId) as any;
    if (!game) {
      return res.status(404).json({ success: false, error: "Game not found" });
    }

    const current = db
      .prepare('SELECT "Hours Played" as hoursPlayed FROM "AppTracking" WHERE "GameID" = ?')
      .get(gameId) as any;
    const currentHours =
      current && current.hoursPlayed !== null && current.hoursPlayed !== undefined
        ? Number(current.hoursPlayed)
        : 0;
    const newHours =
      hoursPlayed !== undefined && hoursPlayed !== null ? Number(hoursPlayed) : currentHours;

    const metrics = await resolveHltbMetrics(game.title);
    const targetHours =
      targetStyle === "completionist"
        ? (metrics.completionist ?? metrics.mainExtra ?? metrics.mainStory ?? 0)
        : targetStyle === "mainExtra"
          ? (metrics.mainExtra ?? metrics.mainStory ?? 0)
          : (metrics.mainStory ?? metrics.mainExtra ?? metrics.completionist ?? 0);

    const remaining =
      targetHours > 0 ? Math.max(0, Math.round((targetHours - newHours) * 10) / 10) : null;
    const progressPercent =
      targetHours > 0 ? Math.min(100, Math.round((newHours / targetHours) * 100)) : 0;

    dbWrite
      .prepare(
        `
      INSERT INTO "AppTracking" ("GameID", "Hours Played", "targetStyle")
      VALUES (?, ?, ?)
      ON CONFLICT("GameID") DO UPDATE SET
        "Hours Played" = excluded."Hours Played",
        "targetStyle" = excluded."targetStyle"
    `,
      )
      .run(gameId, newHours, targetStyle || null);

    res.json({
      success: true,
      gameId,
      title: game.title,
      hoursPlayed: newHours,
      targetStyle: targetStyle || null,
      hltb: metrics,
      targetHours,
      remainingHours: remaining,
      progressPercent,
    });
  } catch (error) {
    console.error("HLTB progress error:", error);
    sendApiError(res, 500, "Failed to update progress");
  }
});

export default router;
