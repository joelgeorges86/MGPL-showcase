import { Router, Request, Response } from "express";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import path from "path";
import { sendApiError } from "../middleware/errorSanitizer";

/**
 * Sprint 28 (FEAT-0153) — Backlog Planning, Priority Scoring & Play Session Sync.
 *
 * GET  /api/backlog/summary  -> priority-ordered backlog planning view.
 * POST /api/backlog/session  -> idempotent play-session push (offline queue flush).
 *
 * The AppBacklog table is the single source of truth for backlog priority state,
 * shared by the backlog hub and the smart recommender. AppPlaySessions records
 * one row per completed stopwatch session; sessionUuid is client-generated so
 * offline queue replays are no-ops on the server.
 */

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });
const dbWrite: DatabaseType = openDatabase(dbPath);

const router = Router();

/**
 * Parse a numeric value from a raw DB cell, falling back to a text regex parse.
 * Returns null when nothing parseable is present.
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
 * Ensure the AppBacklog table exists (idempotent). Mirrors the DDL in src/db.ts
 * so the router is self-healing if it is ever mounted before initDb runs.
 */
function ensureBacklogTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS AppBacklog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gameId TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'backlog',
        priorityScore INTEGER DEFAULT 50,
        hltbMainHours REAL,
        hltbMainExtraHours REAL,
        hltbCompletionistHours REAL,
        etaDays REAL,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `,
      )
      .run();
  } catch (e) {
    console.error("Failed to ensure AppBacklog table:", e);
  }
}

/**
 * Ensure the AppPlaySessions table exists (idempotent).
 */
function ensureSessionsTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS AppPlaySessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionUuid TEXT UNIQUE NOT NULL,
        gameId TEXT NOT NULL,
        startedAt DATETIME,
        endedAt DATETIME,
        durationSeconds INTEGER NOT NULL DEFAULT 0,
        deviceId TEXT,
        synced INTEGER DEFAULT 1,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `,
      )
      .run();
  } catch (e) {
    console.error("Failed to ensure AppPlaySessions table:", e);
  }
}

/**
 * Compute a deterministic priority score (0-99) for a backlog row.
 * Higher = play sooner. Factors:
 *   - progress: games already started rank higher than untouched backlog.
 *   - length: shorter games (lower HLTB main hours) rank higher (quick wins).
 *   - status: "playing" > "backlog" > "completed" (completed drops out).
 * Returns a clamped integer.
 */
function computePriorityScore(
  status: string | null,
  hoursPlayed: number,
  mainHours: number | null,
): number {
  let score = 50;
  const s = (status || "").toLowerCase();

  if (/playing|in progress/i.test(s)) score += 25;
  else if (/backlog|not started/i.test(s)) score += 10;
  else if (/completed|finished|100%/i.test(s)) score -= 40;

  // Quick-win bias: shorter games get a boost so the user can clear backlog fast.
  if (mainHours !== null && mainHours > 0) {
    if (mainHours <= 5) score += 15;
    else if (mainHours <= 15) score += 8;
    else if (mainHours <= 30) score += 0;
    else score -= 10;
  }

  // Progress momentum: partially-played games are worth finishing.
  if (mainHours !== null && mainHours > 0 && hoursPlayed > 0) {
    const pct = hoursPlayed / mainHours;
    if (pct >= 0.5) score += 12;
    else if (pct >= 0.25) score += 6;
  }

  return Math.max(0, Math.min(99, Math.round(score)));
}

/**
 * GET /api/backlog/summary
 * Returns a priority-ordered backlog planning view. Lazily backfills AppBacklog
 * from AppGames + AppTracking + AppCompletionRoadmap when the table is empty so
 * existing libraries appear without a manual migration step.
 */
router.get("/summary", (_req: Request, res: Response) => {
  try {
    ensureBacklogTable();

    // Lazy backfill: if AppBacklog is empty, seed it from the live library so
    // the planning view is populated on first visit.
    const backlogCount = (db.prepare('SELECT COUNT(*) AS c FROM "AppBacklog"').get() as any).c;
    if (backlogCount === 0) {
      const seedRows = db
        .prepare(
          `
        SELECT
          g."GameID" as gameId,
          g."Game Title" as title,
          t."Play Status" as playStatus,
          t."Hours Played" as hoursPlayed,
          r."main_story_hours" as mainStoryHours,
          r."completionist_hours" as completionistHours,
          r."Main Story Time" as mainStoryText,
          r."Estimated 100% Completion Time" as completionistText
        FROM "AppGames" g
        LEFT JOIN "AppTracking" t ON t."GameID" = g."GameID"
        LEFT JOIN "AppCompletionRoadmap" r ON r."GameID" = g."GameID"
        WHERE t."GameID" IS NOT NULL
      `,
        )
        .all() as Array<{
        gameId: string;
        title: string | null;
        playStatus: string | null;
        hoursPlayed: number | null;
        mainStoryHours: number | null;
        completionistHours: number | null;
        mainStoryText: string | null;
        completionistText: string | null;
      }>;

      const insert = dbWrite.prepare(`
        INSERT INTO "AppBacklog" ("gameId", "title", "status", "priorityScore", "hltbMainHours", "hltbMainExtraHours", "hltbCompletionistHours", "etaDays")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT("gameId") DO UPDATE SET
          "title" = excluded."title",
          "status" = excluded."status",
          "priorityScore" = excluded."priorityScore",
          "hltbMainHours" = excluded."hltbMainHours",
          "hltbMainExtraHours" = excluded."hltbMainExtraHours",
          "hltbCompletionistHours" = excluded."hltbCompletionistHours",
          "etaDays" = excluded."etaDays",
          "updatedAt" = CURRENT_TIMESTAMP
      `);

      const seedTx = dbWrite.transaction(() => {
        for (const row of seedRows) {
          const mainStory = parseHours(row.mainStoryHours, row.mainStoryText);
          const mainExtra = mainStory !== null ? Math.round(mainStory * 1.5 * 10) / 10 : null;
          const completionist = parseHours(row.completionistHours, row.completionistText);
          const hoursPlayed =
            row.hoursPlayed !== null && row.hoursPlayed !== undefined ? Number(row.hoursPlayed) : 0;
          const status = row.playStatus || "backlog";
          const priority = computePriorityScore(status, hoursPlayed, mainStory);
          const etaDays =
            mainStory !== null && mainStory > 0 ? Math.round((mainStory / 2) * 10) / 10 : null;
          insert.run(
            row.gameId,
            row.title ?? "Untitled Game",
            status,
            priority,
            mainStory,
            mainExtra,
            completionist,
            etaDays,
          );
        }
      });
      seedTx();
    }

    // Build the priority-ordered planning view.
    const rows = db
      .prepare(
        `
      SELECT
        b."gameId" as gameId,
        b."title" as title,
        b."status" as status,
        b."priorityScore" as priorityScore,
        b."hltbMainHours" as hltbMainHours,
        b."hltbMainExtraHours" as hltbMainExtraHours,
        b."hltbCompletionistHours" as hltbCompletionistHours,
        b."etaDays" as etaDays,
        g."cover_url" as coverUrl,
        t."Hours Played" as hoursPlayed,
        t."Completed Date" as completedDate,
        (SELECT COALESCE(SUM("durationSeconds"), 0) FROM "AppPlaySessions" ps WHERE ps."gameId" = b."gameId") as sessionSeconds
      FROM "AppBacklog" b
      LEFT JOIN "AppGames" g ON g."GameID" = b."gameId"
      LEFT JOIN "AppTracking" t ON t."GameID" = b."gameId"
      ORDER BY b."priorityScore" DESC, b."title" ASC
    `,
      )
      .all() as Array<{
      gameId: string;
      title: string | null;
      status: string | null;
      priorityScore: number | null;
      hltbMainHours: number | null;
      hltbMainExtraHours: number | null;
      hltbCompletionistHours: number | null;
      etaDays: number | null;
      coverUrl: string | null;
      hoursPlayed: number | null;
      completedDate: string | null;
      sessionSeconds: number;
    }>;

    const games = rows.map((row) => {
      const hoursPlayed =
        row.hoursPlayed !== null && row.hoursPlayed !== undefined ? Number(row.hoursPlayed) : 0;
      const sessionHours = Math.round((row.sessionSeconds / 3600) * 100) / 100;
      const status = row.status || "backlog";
      const isCompleted = !!row.completedDate || /completed|finished|100%/i.test(status);
      const targetHours =
        row.hltbMainHours ?? row.hltbMainExtraHours ?? row.hltbCompletionistHours ?? 0;
      const progressPercent =
        targetHours > 0 ? Math.min(100, Math.round((hoursPlayed / targetHours) * 100)) : 0;
      return {
        gameId: row.gameId,
        title: row.title ?? null,
        coverUrl: row.coverUrl ?? null,
        status,
        priorityScore: row.priorityScore ?? 50,
        hltb: {
          mainStory: row.hltbMainHours,
          mainExtra: row.hltbMainExtraHours,
          completionist: row.hltbCompletionistHours,
        },
        etaDays: row.etaDays,
        hoursPlayed,
        sessionHours,
        completed: isCompleted,
        progressPercent,
      };
    });

    const active = games.filter((g) => !g.completed);
    const totalHoursMain = active.reduce((sum, g) => sum + (g.hltb.mainStory ?? 0), 0);
    const totalHoursCompletionist = active.reduce((sum, g) => sum + (g.hltb.completionist ?? 0), 0);
    const averagePriority =
      active.length > 0
        ? Math.round(active.reduce((sum, g) => sum + g.priorityScore, 0) / active.length)
        : 0;

    res.json({
      success: true,
      totalGames: games.length,
      activeCount: active.length,
      completedCount: games.length - active.length,
      totalHoursMain: Math.round(totalHoursMain * 10) / 10,
      totalHoursCompletionist: Math.round(totalHoursCompletionist * 10) / 10,
      averagePriority,
      games,
      items: games,
    });
  } catch (error) {
    console.error("Backlog summary error:", error);
    sendApiError(res, 500, "Failed to build backlog summary");
  }
});

/**
 * POST /api/backlog/session
 * Body: { sessionUuid, gameId, startedAt?, endedAt?, durationSeconds, deviceId? }
 * Idempotent: if a session with the same sessionUuid already exists, returns 200
 * with { success: true, duplicate: true } and does NOT double-count hours.
 * On first insert, also adds the session duration to AppTracking "Hours Played"
 * in the same transaction so the aggregate stays consistent.
 */
router.post("/session", (req: Request, res: Response) => {
  try {
    ensureSessionsTable();

    const {
      sessionUuid,
      gameId,
      startedAt,
      endedAt,
      durationSeconds: durationSecInput,
      sessionMinutes: sessionMinInput,
      deviceId,
    } = req.body || {};

    if (!sessionUuid || typeof sessionUuid !== "string") {
      return res.status(400).json({ success: false, error: "sessionUuid is required" });
    }
    if (!gameId || typeof gameId !== "string") {
      return res.status(400).json({ success: false, error: "gameId is required" });
    }

    let durationSeconds = Number(durationSecInput);
    let sessionMinutes = Number(sessionMinInput);

    if (Number.isNaN(durationSeconds) || durationSeconds <= 0) {
      if (!Number.isNaN(sessionMinutes) && sessionMinutes > 0) {
        durationSeconds = sessionMinutes * 60;
      } else {
        durationSeconds = 0;
      }
    }

    if (Number.isNaN(sessionMinutes) || sessionMinutes <= 0) {
      sessionMinutes = Math.round(durationSeconds / 60);
    }

    // Idempotency check: replay of an already-persisted session is a no-op.
    const existing = db
      .prepare(
        'SELECT "id", "sessionUuid", "gameId", "durationSeconds" FROM "AppPlaySessions" WHERE "sessionUuid" = ?',
      )
      .get(sessionUuid) as any;
    if (existing) {
      const durSec = existing.durationSeconds || durationSeconds;
      return res.json({
        success: true,
        duplicate: true,
        sessionUuid,
        session: {
          sessionUuid,
          gameId: existing.gameId || gameId,
          durationSeconds: durSec,
          durationMinutes: Math.round(durSec / 60) || sessionMinutes,
        },
      });
    }

    const game = db
      .prepare('SELECT "GameID" FROM "AppGames" WHERE "GameID" = ?')
      .get(gameId) as any;
    if (!game) {
      return res.status(404).json({ success: false, error: "Game not found" });
    }

    const hours = Math.round((durationSeconds / 3600) * 10000) / 10000;

    const tx = dbWrite.transaction(() => {
      dbWrite
        .prepare(
          `
        INSERT INTO "AppPlaySessions" ("sessionUuid", "gameId", "startedAt", "endedAt", "durationSeconds", "deviceId", "synced")
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `,
        )
        .run(
          sessionUuid,
          gameId,
          startedAt || null,
          endedAt || null,
          durationSeconds,
          deviceId || null,
        );

      // Add session duration to the aggregate hours on AppTracking.
      const current = dbWrite
        .prepare('SELECT "Hours Played" as hoursPlayed FROM "AppTracking" WHERE "GameID" = ?')
        .get(gameId) as any;
      const currentHours =
        current && current.hoursPlayed !== null && current.hoursPlayed !== undefined
          ? Number(current.hoursPlayed)
          : 0;
      const newHours = Math.round((currentHours + hours) * 10000) / 10000;
      dbWrite
        .prepare(
          `
        INSERT INTO "AppTracking" ("GameID", "Hours Played", "Last Played Date")
        VALUES (?, ?, ?)
        ON CONFLICT("GameID") DO UPDATE SET
          "Hours Played" = excluded."Hours Played",
          "Last Played Date" = excluded."Last Played Date"
      `,
        )
        .run(gameId, newHours, endedAt || new Date().toISOString());
    });
    tx();

    res.json({
      success: true,
      duplicate: false,
      sessionUuid,
      gameId,
      durationSeconds,
      hoursAdded: hours,
      session: {
        sessionUuid,
        gameId,
        durationSeconds,
        durationMinutes: sessionMinutes,
      },
    });
  } catch (error) {
    console.error("Backlog session error:", error);
    sendApiError(res, 500, "Failed to record play session");
  }
});

/**
 * GET /api/backlog/velocity
 * Backlog Velocity & Burn-Down (FEAT-0163).
 *
 * Computes the completion burn-down rate from logged play sessions:
 *   - velocityHoursPerWeek: sum of session hours in the rolling 7-day window.
 *   - burnDownEtaDays: (hltbMainHours - actualHoursPlayed) / (velocityHoursPerWeek / 7).
 *   - stalledGames: items with an active status but no logged session in >14 days.
 *
 * actualHoursPlayed is derived from AppPlaySessions (the authoritative session
 * ledger) so the burn-down reflects real logged playtime rather than the
 * aggregate AppTracking column.
 */
router.get("/velocity", (_req: Request, res: Response) => {
  try {
    ensureBacklogTable();
    ensureSessionsTable();

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Rolling 7-day velocity (sum of session seconds in the window).
    const velocityRow = db
      .prepare(
        `SELECT COALESCE(SUM("durationSeconds"), 0) AS seconds
         FROM "AppPlaySessions"
         WHERE COALESCE("startedAt", "createdAt") >= ?`,
      )
      .get(weekAgo.toISOString()) as { seconds: number };
    const velocitySeconds = Number(velocityRow.seconds) || 0;
    const velocityHoursPerWeek = Math.round((velocitySeconds / 3600) * 100) / 100;

    // Per-game session totals + last session timestamp.
    const sessionAgg = db
      .prepare(
        `SELECT
           "gameId" as gameId,
           COALESCE(SUM("durationSeconds"), 0) AS seconds,
           MAX(COALESCE("startedAt", "createdAt")) AS lastSessionAt
         FROM "AppPlaySessions"
         GROUP BY "gameId"`,
      )
      .all() as Array<{ gameId: string; seconds: number; lastSessionAt: string | null }>;

    const sessionByGame = new Map<string, { seconds: number; lastSessionAt: string | null }>();
    sessionAgg.forEach((row) => {
      sessionByGame.set(row.gameId, {
        seconds: Number(row.seconds) || 0,
        lastSessionAt: row.lastSessionAt,
      });
    });

    const rows = db
      .prepare(
        `SELECT
           b."gameId" as gameId,
           b."title" as title,
           b."status" as status,
           b."hltbMainHours" as hltbMainHours,
           b."hltbMainExtraHours" as hltbMainExtraHours,
           b."hltbCompletionistHours" as hltbCompletionistHours
         FROM "AppBacklog" b`,
      )
      .all() as Array<{
      gameId: string;
      title: string | null;
      status: string | null;
      hltbMainHours: number | null;
      hltbMainExtraHours: number | null;
      hltbCompletionistHours: number | null;
    }>;

    const games: Array<{
      gameId: string;
      title: string;
      status: string;
      hltbMainHours: number | null;
      actualHoursPlayed: number;
      remainingHours: number | null;
      burnDownEtaDays: number | null;
      lastSessionAt: string | null;
      stalled: boolean;
      progressPercent: number;
    }> = [];
    const stalledGames: Array<{
      gameId: string;
      title: string;
      status: string;
      lastSessionAt: string | null;
    }> = [];

    rows.forEach((row) => {
      const status = row.status || "backlog";
      const isActive = /playing|in progress|started/i.test(status);
      const agg = sessionByGame.get(row.gameId);
      const actualHoursPlayed = agg ? Math.round((agg.seconds / 3600) * 100) / 100 : 0;
      const lastSessionAt = agg ? agg.lastSessionAt : null;

      const targetHours = row.hltbMainHours ?? row.hltbMainExtraHours ?? row.hltbCompletionistHours;
      const remainingHours =
        targetHours != null && targetHours > 0
          ? Math.max(0, Math.round((targetHours - actualHoursPlayed) * 100) / 100)
          : null;

      let burnDownEtaDays: number | null = null;
      if (remainingHours != null && velocityHoursPerWeek > 0) {
        burnDownEtaDays = Math.round((remainingHours / (velocityHoursPerWeek / 7)) * 10) / 10;
      }

      const progressPercent =
        targetHours != null && targetHours > 0
          ? Math.min(100, Math.round((actualHoursPlayed / targetHours) * 100))
          : 0;

      // Stalled: active status but no session in the last 14 days.
      let stalled = false;
      if (isActive) {
        if (!lastSessionAt) {
          stalled = true;
        } else {
          const last = new Date(String(lastSessionAt).replace(" ", "T"));
          stalled = isNaN(last.getTime()) || last < twoWeeksAgo;
        }
      }

      games.push({
        gameId: row.gameId,
        title: row.title || "Untitled Game",
        status,
        hltbMainHours: row.hltbMainHours,
        actualHoursPlayed,
        remainingHours,
        burnDownEtaDays,
        lastSessionAt,
        stalled,
        progressPercent,
      });

      if (stalled) {
        stalledGames.push({
          gameId: row.gameId,
          title: row.title || "Untitled Game",
          status,
          lastSessionAt,
        });
      }
    });

    // Overall burn-down ETA across all active games.
    const activeGames = games.filter((g) => /playing|in progress|started/i.test(g.status));
    const totalRemaining = activeGames.reduce((sum, g) => sum + (g.remainingHours ?? 0), 0);
    const burnDownEtaDays =
      totalRemaining > 0 && velocityHoursPerWeek > 0
        ? Math.round((totalRemaining / (velocityHoursPerWeek / 7)) * 10) / 10
        : null;

    res.json({
      success: true,
      velocityHoursPerWeek,
      burnDownEtaDays,
      activeGameCount: activeGames.length,
      stalledCount: stalledGames.length,
      games,
      stalledGames,
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    console.error("Backlog velocity error:", error);
    sendApiError(res, 500, "Failed to compute backlog velocity");
  }
});

export default router;
