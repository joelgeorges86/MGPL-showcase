import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 3 (WUD-3.3 / EPICUX03 + EPICEOT03) — Gamer Profile Foundations &
 * Privacy Integration.
 *
 *   GET /api/profile/dashboard
 *
 * Aggregates the local-first player identity into a single privacy-aware
 * payload consumed by the #/profile route:
 *
 *   - profile       : privacy-minimized identity (displayName, gamerTag, avatarUrl,
 *                     profileVisibility — the DB stays authoritative).
 *   - summary       : lifetime totals derived from the shared library's
 *                     AppTracking state.
 *   - achievements  : showcase entries (trophy progress, completed titles,
 *                     personal ratings) for the achievement grid.
 *   - playHistory   : chronological play timeline from AppTracking.
 *   - recentSessions: last completed play sessions from AppPlaySessions.
 *
 * Every route here requires an authenticated session (requireAuth). The
 * payload is strictly privacy-minimized: no email, no tokens, no remote IDs.
 */

const router = Router();
router.use(requireAuth);

interface ProfileDashboardRow {
  gameId: string;
  title: string | null;
  playStatus: string | null;
  hoursPlayed: number | null;
  lastPlayedDate: string | null;
  completedDate: string | null;
  playedPlatform: string | null;
  trophyProgress: number | null;
  personalRating: number | null;
  achievementNotes: string | null;
}

function loadProfileRow(userId: string): {
  displayName: string | null;
  gamerTag: string | null;
  avatarUrl: string | null;
  profileVisibility: string | null;
} {
  const row = db
    .prepare('SELECT displayName, gamerTag, avatarUrl, profileVisibility FROM AuthUsers WHERE id = ?')
    .get(userId) as
    | { displayName: string | null; gamerTag: string | null; avatarUrl: string | null; profileVisibility: string | null }
    | undefined;
  return {
    displayName: row?.displayName ?? null,
    gamerTag: row?.gamerTag ?? null,
    avatarUrl: row?.avatarUrl ?? null,
    // Legacy rows converge to the privacy default; DB is authoritative.
    profileVisibility: row?.profileVisibility === 'public' ? 'public' : 'private',
  };
}

function loadDashboardRows(): ProfileDashboardRow[] {
  return db
    .prepare(
      `SELECT
         t."GameID" AS gameId,
         g."Game Title" AS title,
         t."Play Status" AS playStatus,
         t."Hours Played" AS hoursPlayed,
         t."Last Played Date" AS lastPlayedDate,
         t."Completed Date" AS completedDate,
         t."Played Platform" AS playedPlatform,
         t."Trophy Progress" AS trophyProgress,
         t."Personal Rating (1-10)" AS personalRating,
         t."achievementNotes" AS achievementNotes
       FROM "AppTracking" t
       LEFT JOIN "AppGames" g ON g."GameID" = t."GameID"`
    )
    .all() as ProfileDashboardRow[];
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

router.get('/dashboard', (_req: Request, res: Response) => {
  try {
    const authed = _req as AuthedRequest;
    const profile = loadProfileRow(authed.user!.userId);
    const rows = loadDashboardRows();

    let totalHoursPlayed = 0;
    let gamesPlaying = 0;
    let gamesCompleted = 0;
    const achievements: Array<{
      gameId: string;
      title: string;
      trophyProgress: number | null;
      playStatus: string | null;
      personalRating: number | null;
      completedDate: string | null;
    }> = [];

    for (const row of rows) {
      const hours = toNumber(row.hoursPlayed) ?? 0;
      totalHoursPlayed += hours;
      const status = String(row.playStatus || '').toLowerCase();
      if (status.includes('playing') || status.includes('active')) gamesPlaying += 1;
      if (status.includes('completed')) gamesCompleted += 1;

      // Achievement showcase: trophy progress OR a completed title OR a rating.
      if (
        toNumber(row.trophyProgress) !== null ||
        status.includes('completed') ||
        toNumber(row.personalRating) !== null
      ) {
        achievements.push({
          gameId: row.gameId,
          title: row.title || 'Untitled Game',
          trophyProgress: toNumber(row.trophyProgress),
          playStatus: row.playStatus || null,
          personalRating: toNumber(row.personalRating),
          completedDate: row.completedDate || null,
        });
      }
    }

    achievements.sort(
      (a, b) =>
        (b.trophyProgress ?? 0) - (a.trophyProgress ?? 0) ||
        String(b.completedDate || '').localeCompare(String(a.completedDate || ''))
    );

    const playHistory = rows
      .filter((row) => row.lastPlayedDate || (toNumber(row.hoursPlayed) ?? 0) > 0)
      .map((row) => ({
        gameId: row.gameId,
        title: row.title || 'Untitled Game',
        hoursPlayed: Math.round((toNumber(row.hoursPlayed) ?? 0) * 10) / 10,
        lastPlayedAt: row.lastPlayedDate || null,
        playStatus: row.playStatus || null,
        platform: row.playedPlatform || null,
      }))
      .sort((a, b) => String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')));

    let recentSessions: Array<{
      gameId: string;
      title: string | null;
      startedAt: string | null;
      endedAt: string | null;
      durationSeconds: number;
    }> = [];
    try {
      recentSessions = db
        .prepare(
          `SELECT s.gameId, g."Game Title" AS title, s.startedAt, s.endedAt, s.durationSeconds
           FROM AppPlaySessions s
           LEFT JOIN "AppGames" g ON g."GameID" = s.gameId
           ORDER BY COALESCE(s.createdAt, s.startedAt) DESC
           LIMIT 5`
        )
        .all() as Array<{
        gameId: string;
        title: string | null;
        startedAt: string | null;
        endedAt: string | null;
        durationSeconds: number;
      }>;
    } catch {
      recentSessions = [];
    }

    return res.json({
      success: true,
      profile,
      summary: {
        totalHoursPlayed: Math.round(totalHoursPlayed * 10) / 10,
        totalGames: rows.length,
        gamesPlaying,
        gamesCompleted,
        achievementsUnlocked: achievements.filter((a) => a.trophyProgress !== null).length,
      },
      achievements,
      playHistory,
      recentSessions,
    });
  } catch (err: any) {
    console.error('GET /api/profile/dashboard error:', err?.message || err);
    return sendApiError(res, 500, 'Failed to load profile dashboard');
  }
});

export default router;
