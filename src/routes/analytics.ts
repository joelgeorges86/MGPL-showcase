import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireRole, ANALYTICS_ROLES } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';
import { safeArray } from '../utils/ingest';
import { normalizeGenre, statusBucket, valueRating, round } from '../utils/analyticsMath';

/**
 * Analytics Visualizer (FEAT-0152)
 *
 * Aggregates live data across AppGames, AppTracking, AppOwnership,
 * AppDealsWishlist and AppCompletionRoadmapCache to power the interactive
 * Backlog Analytics dashboard.
 *
 * Sprint 5 (EPIC-07): ALL endpoints are server-side role-gated to
 * `ANALYTICS_ROLES` (admin | Product | Data | Leadership). Standard
 * user/staff sessions receive 403 and every denied attempt is appended to the
 * immutable `analytics_access_logs` table by the requireRole middleware.
 *
 * Data access mirrors the raw better-sqlite3 pattern used in games.ts:
 * space-containing columns are quoted and defensive fallbacks are applied so
 * the route remains resilient to schema drift.
 */
const router = Router();

/**
 * GET /api/analytics/summary
 * Returns genre, platform, completion-velocity and cost-per-hour aggregates.
 */
router.get('/summary', requireRole(...ANALYTICS_ROLES), (_req: Request, res: Response) => {
  try {
    // ---- Genre distribution (AppGames."Primary Genre") ----
    const genreRows = db
      .prepare(
        `SELECT "Primary Genre" AS genre, COUNT(*) AS count
         FROM AppGames
         WHERE "Primary Genre" IS NOT NULL AND "Primary Genre" != ''
         GROUP BY "Primary Genre"
         ORDER BY count DESC`
      )
      .all() as { genre: string; count: number }[];

    const totalGames = db
      .prepare('SELECT COUNT(*) AS count FROM AppGames')
      .get() as { count: number };

    const genres = genreRows.map((row) => {
      const name = normalizeGenre(row.genre);
      const count = Number(row.count) || 0;
      const percentage = totalGames.count > 0 ? round((count / totalGames.count) * 100, 1) : 0;
      return { name, count, percentage };
    });

    // ---- Platform distribution (AppOwnership."Platform" + hours) ----
    const platformRows = db
      .prepare(
        `SELECT o."Platform" AS platform, COUNT(*) AS gameCount
         FROM AppOwnership o
         WHERE o."Platform" IS NOT NULL AND o."Platform" != ''
         GROUP BY o."Platform"
         ORDER BY gameCount DESC`
      )
      .all() as { platform: string; gameCount: number }[];

    const totalOwnership = db
      .prepare('SELECT COUNT(*) AS count FROM AppOwnership')
      .get() as { count: number };

    // Hours per platform: prefer AppTracking."Played Platform", fall back to
    // joining ownership platform by GameID.
    const hoursByPlatform = new Map<string, number>();
    const playedPlatformRows = db
      .prepare(
        `SELECT "Played Platform" AS platform, SUM("Hours Played") AS hours
         FROM AppTracking
         WHERE "Played Platform" IS NOT NULL AND "Played Platform" != ''
         GROUP BY "Played Platform"`
      )
      .all() as { platform: string; hours: number }[];
    playedPlatformRows.forEach((row) => {
      hoursByPlatform.set(row.platform, Number(row.hours) || 0);
    });

    const ownershipHoursRows = db
      .prepare(
        `SELECT o."Platform" AS platform, SUM(t."Hours Played") AS hours
         FROM AppOwnership o
         LEFT JOIN AppTracking t ON o.GameID = t.GameID
         WHERE o."Platform" IS NOT NULL AND o."Platform" != ''
         GROUP BY o."Platform"`
      )
      .all() as { platform: string; hours: number }[];
    ownershipHoursRows.forEach((row) => {
      const current = hoursByPlatform.get(row.platform) || 0;
      hoursByPlatform.set(row.platform, current + (Number(row.hours) || 0));
    });

    const platforms = platformRows.map((row) => {
      const platform = row.platform;
      const gameCount = Number(row.gameCount) || 0;
      const totalHours = round(hoursByPlatform.get(platform) || 0, 1);
      const ownedPercentage =
        totalOwnership.count > 0 ? round((gameCount / totalOwnership.count) * 100, 1) : 0;
      return { platform, gameCount, totalHours, ownedPercentage };
    });

    // ---- Completion velocity (AppTracking."Play Status") ----
    const statusRows = db
      .prepare(
        `SELECT "Play Status" AS status, COUNT(*) AS count
         FROM AppTracking
         WHERE "Play Status" IS NOT NULL
         GROUP BY "Play Status"`
      )
      .all() as { status: string; count: number }[];

    let completed = 0;
    let inProgress = 0;
    let unplayed = 0;
    statusRows.forEach((row) => {
      const bucket = statusBucket(row.status);
      const count = Number(row.count) || 0;
      if (bucket === 'completed') completed += count;
      else if (bucket === 'inProgress') inProgress += count;
      else unplayed += count;
    });

    const trackedTotal = completed + inProgress + unplayed;
    const completionRate = trackedTotal > 0 ? round((completed / trackedTotal) * 100, 1) : 0;

    // Recent activity intervals bucketed by "Last Played Date" / "Completed Date".
    const now = new Date();
    const intervalDefs = [
      { label: 'Last 30 Days', days: 30 },
      { label: 'Last 90 Days', days: 90 },
      { label: 'Last 365 Days', days: 365 },
    ];

    const activityRows = db
      .prepare(
        `SELECT "Last Played Date" AS lastPlayed, "Completed Date" AS completedDate,
                "Play Status" AS status
         FROM AppTracking`
      )
      .all() as { lastPlayed: string | null; completedDate: string | null; status: string }[];

    const intervals = intervalDefs.map((def) => {
      const cutoff = new Date(now.getTime() - def.days * 24 * 60 * 60 * 1000);
      let iCompleted = 0;
      let iInProgress = 0;
      let iUnplayed = 0;
      activityRows.forEach((row) => {
        const bucket = statusBucket(row.status);
        const dateStr = bucket === 'completed' ? row.completedDate : row.lastPlayed;
        if (!dateStr) return;
        const d = new Date(String(dateStr).replace(' ', 'T'));
        if (isNaN(d.getTime()) || d < cutoff) return;
        if (bucket === 'completed') iCompleted += 1;
        else if (bucket === 'inProgress') iInProgress += 1;
        else iUnplayed += 1;
      });
      return {
        label: def.label,
        completed: iCompleted,
        inProgress: iInProgress,
        unplayed: iUnplayed,
      };
    });

    // ---- Value metrics (cost-per-hour) ----
    // Join ownership price with tracking hours. Since most rows are unpriced,
    // fall back to AppDealsWishlist.targetPrice when available.
    const wishlistPrices = new Map<string, number>();
    const wishlistRows = db
      .prepare('SELECT gameTitle, targetPrice FROM AppDealsWishlist')
      .all() as { gameTitle: string; targetPrice: number }[];
    wishlistRows.forEach((row) => {
      if (row.targetPrice != null) wishlistPrices.set(row.gameTitle, Number(row.targetPrice));
    });

    const valueRows = db
      .prepare(
        `SELECT g.GameID AS gameId, g."Game Title" AS title,
                o."Price Paid" AS pricePaid, t."Hours Played" AS hours
         FROM AppGames g
         LEFT JOIN AppOwnership o ON g.GameID = o.GameID
         LEFT JOIN AppTracking t ON g.GameID = t.GameID`
      )
      .all() as { gameId: string; title: string; pricePaid: number | null; hours: number }[];

    const seen = new Set<string>();
    let totalSpent = 0;
    let totalHours = 0;
    let pricedCount = 0;
    let freeOrUnpricedCount = 0;
    const breakdown: {
      gameId: string;
      title: string;
      price: number;
      hours: number;
      cph: number | null;
      rating: string;
    }[] = [];

    valueRows.forEach((row) => {
      const gameId = row.gameId;
      if (!gameId || seen.has(gameId)) return;
      seen.add(gameId);

      const title = row.title || 'Untitled Game';
      const hours = Number(row.hours) || 0;
      let price = row.pricePaid != null ? Number(row.pricePaid) : 0;
      if (price <= 0 && wishlistPrices.has(title)) {
        price = wishlistPrices.get(title) || 0;
      }

      totalHours += hours;
      if (price > 0) {
        totalSpent += price;
        pricedCount += 1;
      } else {
        freeOrUnpricedCount += 1;
      }

      const cph = price > 0 && hours > 0 ? round(price / hours, 2) : null;
      breakdown.push({
        gameId,
        title,
        price: round(price, 2),
        hours: round(hours, 1),
        cph,
        rating: valueRating(cph),
      });
    });

    const overallCph = totalHours > 0 && totalSpent > 0 ? round(totalSpent / totalHours, 2) : 0;

    res.json({
      success: true,
      genres,
      platforms,
      velocity: {
        statusSummary: { completed, inProgress, unplayed, total: trackedTotal },
        intervals,
        completionRate,
      },
      valueSummary: {
        totalSpent: round(totalSpent, 2),
        totalHours: round(totalHours, 1),
        overallCph,
        pricedCount,
        freeOrUnpricedCount,
        valueRating: valueRating(overallCph > 0 ? overallCph : null),
        breakdown,
      },
    });
  } catch (err) {
    console.error('Analytics summary error:', err);
    sendApiError(res, 500, 'Failed to compute analytics summary');
  }
});

/**
 * GET /api/analytics/sessions
 * Session Intelligence & Fleet Power Telemetry (FEAT-0163).
 *
 * Aggregates AppPlaySessions joined with Devices and AppGames to report:
 *   - Attributed playtime hours per device profile (fleet split).
 *   - Estimated energy consumption (kWh) and battery cycles consumed.
 *   - Weekly session aggregation for trendline generation.
 *
 * Power model (matches devices.ts precedent):
 *   powerDraw = (tdpWatts ?? 0) + 6
 *   energyKwh = (durationSeconds / 3600) * powerDraw
 *   batteryCycles = energyKwh / batteryWh   (only when batteryWh > 0)
 *   batteryRuntimeHours = batteryWh / powerDraw
 *
 * Sessions with a null deviceId are bucketed as "Unattributed" so legacy rows
 * never silently drop. Sessions with null startedAt/endedAt fall back to
 * createdAt for weekly bucketing.
 */
router.get('/sessions', requireRole(...ANALYTICS_ROLES), (_req: Request, res: Response) => {
  try {
    // Sprint 1A (EPICSEC01): unified fallback — a non-array query result
    // hydrates to [] instead of leaking nulls downstream.
    const sessions = safeArray(
      db
        .prepare(
          `SELECT
           ps."sessionUuid" as sessionUuid,
           ps."gameId" as gameId,
           ps."startedAt" as startedAt,
           ps."endedAt" as endedAt,
           ps."durationSeconds" as durationSeconds,
           ps."deviceId" as deviceId,
           ps."createdAt" as createdAt,
           g."Game Title" as title,
           d."deviceName" as deviceName,
           d."formFactor" as deviceType,
           d."tdpWatts" as tdpWatts,
           d."batteryWh" as batteryWh
         FROM "AppPlaySessions" ps
         LEFT JOIN "AppGames" g ON g."GameID" = ps."gameId"
         LEFT JOIN "Devices" d ON d."deviceId" = ps."deviceId"`
        )
        .all(),
    ) as Array<{
      sessionUuid: string;
      gameId: string;
      startedAt: string | null;
      endedAt: string | null;
      durationSeconds: number;
      deviceId: string | null;
      createdAt: string | null;
      title: string | null;
      deviceName: string | null;
      deviceType: string | null;
      tdpWatts: number | null;
      batteryWh: number | null;
    }>;

    const totalSeconds = sessions.reduce((sum, s) => sum + (Number(s.durationSeconds) || 0), 0);
    const totalHours = round(totalSeconds / 3600, 2);

    // ---- Per-device attribution ------------------------------------------
    const deviceMap = new Map<string, {
      deviceId: string;
      deviceName: string;
      deviceType: string;
      playtimeSeconds: number;
      sessionCount: number;
      tdpWatts: number | null;
      batteryWh: number | null;
    }>();

    sessions.forEach((s) => {
      const key = s.deviceId || 'unattributed';
      const entry = deviceMap.get(key) || {
        deviceId: key,
        deviceName: s.deviceName || (key === 'unattributed' ? 'Unattributed' : key),
        deviceType: s.deviceType || (key === 'unattributed' ? 'Unknown' : 'Unknown'),
        playtimeSeconds: 0,
        sessionCount: 0,
        tdpWatts: s.tdpWatts != null ? Number(s.tdpWatts) : null,
        batteryWh: s.batteryWh != null ? Number(s.batteryWh) : null,
      };
      entry.playtimeSeconds += Number(s.durationSeconds) || 0;
      entry.sessionCount += 1;
      deviceMap.set(key, entry);
    });

    const sessionDistribution = Array.from(deviceMap.values())
      .map((d) => {
        const playtimeHours = round(d.playtimeSeconds / 3600, 2);
        const powerDraw = (d.tdpWatts ?? 0) + 6;
        const estimatedEnergyKwh = round((d.playtimeSeconds / 3600) * powerDraw, 3);
        const batteryCycles =
          d.batteryWh != null && d.batteryWh > 0
            ? round(estimatedEnergyKwh / d.batteryWh, 3)
            : null;
        const batteryRuntimeHours =
          d.batteryWh != null && d.batteryWh > 0 && powerDraw > 0
            ? round(d.batteryWh / powerDraw, 2)
            : null;
        return {
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          deviceType: d.deviceType,
          playtimeHours,
          sharePct: totalHours > 0 ? round((playtimeHours / totalHours) * 100, 1) : 0,
          sessionCount: d.sessionCount,
          estimatedEnergyKwh,
          batteryCycles,
          batteryRuntimeHours,
          batteryWh: d.batteryWh,
          tdpWatts: d.tdpWatts,
        };
      })
      .sort((a, b) => b.playtimeHours - a.playtimeHours);

    // ---- Weekly aggregation (fall back to createdAt for bucketing) --------
    const weeklyMap = new Map<string, number>();
    sessions.forEach((s) => {
      const raw = s.startedAt || s.createdAt;
      if (!raw) return;
      const d = new Date(String(raw).replace(' ', 'T'));
      if (isNaN(d.getTime())) return;
      const weekStart = new Date(d);
      const day = (d.getDay() + 6) % 7; // Monday-based week
      weekStart.setDate(d.getDate() - day);
      weekStart.setHours(0, 0, 0, 0);
      const key = weekStart.toISOString().slice(0, 10);
      weeklyMap.set(key, (weeklyMap.get(key) || 0) + (Number(s.durationSeconds) || 0));
    });

    const weekly = Array.from(weeklyMap.entries())
      .map(([weekStart, seconds]) => ({
        weekStart,
        playtimeHours: round(seconds / 3600, 2),
      }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    // ---- Per-game aggregation --------------------------------------------
    const gameMap = new Map<string, { gameId: string; title: string; playtimeSeconds: number; sessionCount: number }>();
    sessions.forEach((s) => {
      const entry = gameMap.get(s.gameId) || {
        gameId: s.gameId,
        title: s.title || 'Untitled Game',
        playtimeSeconds: 0,
        sessionCount: 0,
      };
      entry.playtimeSeconds += Number(s.durationSeconds) || 0;
      entry.sessionCount += 1;
      gameMap.set(s.gameId, entry);
    });

    const byGame = Array.from(gameMap.values())
      .map((g) => ({
        gameId: g.gameId,
        title: g.title,
        playtimeHours: round(g.playtimeSeconds / 3600, 2),
        sessionCount: g.sessionCount,
      }))
      .sort((a, b) => b.playtimeHours - a.playtimeHours);

    res.json({
      success: true,
      sessionCount: sessions.length,
      totalHours,
      sessionDistribution,
      weekly,
      byGame,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Analytics sessions error:', err);
    sendApiError(res, 500, 'Failed to compute session analytics');
  }
});

/**
 * GET /api/analytics/perf
 * Performance telemetry (Sprint 34 / FEAT-0168).
 *
 * Returns process uptime, memory usage, per-table SQLite row counts and a
 * benchmark of the full library join query (AppGames ⋈ AppOwnership ⋈
 * AppTracking). The query benchmark target is < 15ms; a warning is logged if
 * the threshold is exceeded so regressions surface in server logs.
 */
router.get('/perf', requireRole(...ANALYTICS_ROLES), (_req: Request, res: Response) => {
  try {
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.round(process.uptime());

    // Per-table row counts across all application tables.
    const tableRows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as { name: string }[];
    const sqliteTableCounts: Record<string, number> = {};
    for (const t of tableRows) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number };
        sqliteTableCounts[t.name] = Number(row.c) || 0;
      } catch (e) {
        sqliteTableCounts[t.name] = -1;
      }
    }

    // Benchmark the full library join query (mirrors analytics /summary value
    // join and the games.ts catalog read path).
    const benchmarkSql = `SELECT g.GameID AS gameId, g."Game Title" AS title,
            o."Price Paid" AS pricePaid, t."Hours Played" AS hours
         FROM AppGames g
         LEFT JOIN AppOwnership o ON g.GameID = o.GameID
         LEFT JOIN AppTracking t ON g.GameID = t.GameID`;
    const t0 = process.hrtime.bigint();
    const benchmarkRows = db.prepare(benchmarkSql).all() as any[];
    const t1 = process.hrtime.bigint();
    const queryBenchmarkMs = Number(t1 - t0) / 1e6;

    if (queryBenchmarkMs >= 15) {
      console.warn(
        `[perf] Library join benchmark exceeded 15ms threshold: ${queryBenchmarkMs.toFixed(2)}ms`
      );
    }

    res.json({
      success: true,
      uptimeSeconds,
      memoryRssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      sqliteTableCounts,
      queryBenchmarkMs: Math.round(queryBenchmarkMs * 100) / 100,
      benchmarkRows: benchmarkRows.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Analytics perf error:', err);
    sendApiError(res, 500, 'Failed to compute performance telemetry');
  }
});

export default router;
