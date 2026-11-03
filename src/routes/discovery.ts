import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 3 (WUD-3.2 / EPICUX02 + EPICEOT04) — Game Discovery 2.0.
 *
 *   POST /api/discovery/rails    -> mood-based personalized recommendation rails
 *   POST /api/discovery/surprise -> "Surprise Me" single seeded pick
 *
 * Both endpoints are public (the library is a local-first shared catalog, the
 * same posture as the legacy session recommender at /api/recommender/suggest).
 *
 * The mood taxonomy maps editorial mood states onto genre/energy signals, and
 * every rail surfaces the same unified game-card contract consumed by the
 * library + discovery client modules (gameId, title, coverUrl, genres,
 * matchScore, reasonTags, hoursPlayed, playStatus, criticScore,
 * mainStoryHours) so one card renderer works everywhere.
 */

const router = Router();

export interface DiscoveryGameCard {
  gameId: string;
  title: string;
  coverUrl: string | null;
  genres: string[];
  primaryGenre: string | null;
  matchScore: number;
  reasonTags: string[];
  hoursPlayed: number;
  playStatus: string | null;
  criticScore: number | null;
  mainStoryHours: number | null;
}

export interface MoodSpec {
  key: string;
  label: string;
  blurb: string;
  genres: string[];
  reason: string;
}

/** Editorial mood taxonomy (WUD-3.2). Keys are the stable API values. */
export const MOODS: Record<string, MoodSpec> = {
  cozy: {
    key: 'cozy',
    label: 'Cozy & Chill',
    blurb: 'Low-pressure worlds, relaxing loops, zero rush.',
    genres: ['Simulation', 'Strategy', 'Casual', 'Puzzle', 'Management'],
    reason: 'Relaxed, low-energy pick',
  },
  story: {
    key: 'story',
    label: 'Story-Driven',
    blurb: 'Deep narratives and worlds you can sink into.',
    genres: ['RPG', 'Adventure', 'Action RPG', 'Narrative', 'Story'],
    reason: 'Narrative-heavy pick',
  },
  focused: {
    key: 'focused',
    label: 'Focused & Competitive',
    blurb: 'Skill-forward sessions that reward mastery.',
    genres: ['Shooter', 'Strategy', 'Sports', 'Racing', 'Tactics'],
    reason: 'High-focus skill pick',
  },
  fast: {
    key: 'fast',
    label: 'Fast & Chaotic',
    blurb: 'Quick bursts of high energy, action, and mayhem.',
    genres: ['Action', 'Roguelike', 'Platformer', 'Shooter', 'Metroidvania'],
    reason: 'Quick-session high-energy pick',
  },
  immersive: {
    key: 'immersive',
    label: 'Deep Immersion',
    blurb: 'Long-form worlds made for extended sessions.',
    genres: ['RPG', 'Simulation', 'Action RPG', 'Open World'],
    reason: 'Long-session immersion pick',
  },
};

const MOOD_KEYS = Object.keys(MOODS);

/** Map a game's Primary Genre (and mapped genre tags) into a normalized bucket. */
function normalizeGenre(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();
}

function genreMatchesMood(genre: string, moodGenres: string[]): boolean {
  const normalized = normalizeGenre(genre);
  if (!normalized) return false;
  return moodGenres.some((g) => {
    const n = normalizeGenre(g);
    return normalized === n || normalized.includes(n) || n.includes(normalized);
  });
}

interface LibraryRow {
  gameId: string;
  title: string | null;
  primaryGenre: string | null;
  coverUrl: string | null;
  criticScore: number | null;
  hoursPlayed: number | null;
  playStatus: string | null;
  lastPlayedDate: string | null;
  mainStoryHours: number | null;
  storageSize: string | null;
}

/** Full library join: catalog + tracking + completion roadmap (read-only). */
function loadLibraryRows(): LibraryRow[] {
  return db
    .prepare(
      `SELECT
         g."GameID" AS gameId,
         g."Game Title" AS title,
         g."Primary Genre" AS primaryGenre,
         g."cover_url" AS coverUrl,
         g."criticScore" AS criticScore,
         t."Hours Played" AS hoursPlayed,
         t."Play Status" AS playStatus,
         t."Last Played Date" AS lastPlayedDate,
         r."main_story_hours" AS mainStoryHours,
         g."Storage Size" AS storageSize
       FROM "AppGames" g
       LEFT JOIN "AppTracking" t ON t."GameID" = g."GameID"
       LEFT JOIN "AppCompletionRoadmap" r ON r."GameID" = g."GameID"
       WHERE g."Active" IS NULL OR g."Active" <> 'No'`
    )
    .all() as LibraryRow[];
}

/** Genre tags for a game via the CMS-extensible AppGenres taxonomy. */
function loadGenresFor(gameId: string): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT n."GenreName" AS name
         FROM "AppGenres" n
         JOIN "AppGameGenreMap" m ON m."GenreID" = n."GenreID"
         WHERE m."GameID" = ?`
      )
      .all(gameId) as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    // Steam-tag taxonomy tables may be absent on a fresh checkout.
    return [];
  }
}

function parseHours(value: number | string | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseScore(value: number | string | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Deterministic mulberry32 PRNG so "Surprise Me" is seed-reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Score a library row for the active mood. Reuses the session recommender's
 * scoring spirit (genre affinity + backlog grooming + playability) so rails
 * stay deterministic against the same seeded catalog.
 */
function scoreForMood(row: LibraryRow, mood: MoodSpec): { score: number; reasonTags: string[] } {
  let score = 0;
  const reasonTags: string[] = [];
  const genres = loadGenresFor(row.gameId);
  const allGenres = [row.primaryGenre, ...genres].filter(Boolean) as string[];
  const matchCount = allGenres.filter((g) => genreMatchesMood(g, mood.genres)).length;

  if (matchCount > 0) {
    score += 30 + Math.min(20, matchCount * 10);
    reasonTags.push(mood.reason);
  }

  const critic = parseScore(row.criticScore);
  if (critic !== null && critic >= 75) {
    score += Math.min(15, Math.round((critic - 75) / 5));
  }

  const hoursPlayed = parseHours(row.hoursPlayed) ?? 0;
  const status = String(row.playStatus || '').toLowerCase();
  if (hoursPlayed === 0 || status.includes('backlog') || status.includes('unplayed') || status.includes('not started')) {
    score += 10;
    reasonTags.push('Backlog pick');
  } else if (status.includes('playing') || status.includes('active')) {
    score += 8;
    reasonTags.push('Currently playing');
  } else if (status.includes('completed')) {
    score -= 4;
    reasonTags.push('Completed');
  }

  // Recommend reachable titles slightly higher than giant grinds.
  const mainStory = parseHours(row.mainStoryHours);
  if (mainStory !== null && mainStory > 0 && mainStory <= 12) {
    score += 5;
    reasonTags.push('Short campaign');
  }

  return { score, reasonTags: Array.from(new Set(reasonTags)).slice(0, 3) };
}

function toCard(row: LibraryRow, mood: MoodSpec): DiscoveryGameCard {
  const { score, reasonTags } = scoreForMood(row, mood);
  const genres = loadGenresFor(row.gameId);
  return {
    gameId: row.gameId,
    title: row.title || 'Untitled Game',
    coverUrl: row.coverUrl || null,
    genres,
    primaryGenre: row.primaryGenre || null,
    matchScore: Math.min(99, Math.max(0, Math.round(score))),
    reasonTags,
    hoursPlayed: Math.round((parseHours(row.hoursPlayed) ?? 0) * 10) / 10,
    playStatus: row.playStatus || null,
    criticScore: parseScore(row.criticScore),
    mainStoryHours: parseHours(row.mainStoryHours),
  };
}

/**
 * POST /api/discovery/rails
 * Body: { mood?: 'cozy'|'story'|'focused'|'fast'|'immersive' }
 * Returns 3-4 personalized rails derived from the catalog + tracking state.
 */
router.post('/rails', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { mood?: string };
    const moodKey = MOOD_KEYS.includes(String(body.mood || '')) ? String(body.mood) : 'cozy';
    const mood = MOODS[moodKey];

    const rows = loadLibraryRows();
    if (rows.length === 0) {
      return res.json({ success: true, mood: moodKey, moodLabel: mood.label, rails: [] });
    }

    const scored = rows
      .map((row) => ({ row, card: toCard(row, mood) }))
      .sort((a, b) => b.card.matchScore - a.card.matchScore);

    const topMoodPicks = scored.slice(0, 8).map((s) => s.card);

    // Backlog Gems: unplayed / backlogged titles, mood-aware.
    const backlogGems = scored
      .filter(({ row }) => {
        const status = String(row.playStatus || '').toLowerCase();
        const hours = parseHours(row.hoursPlayed) ?? 0;
        return hours === 0 || status.includes('backlog') || status.includes('unplayed') || status.includes('not started');
      })
      .slice(0, 6)
      .map((s) => s.card);

    // Quick Session: short campaigns that fit a single sitting.
    const quickPlay = scored
      .filter(({ row }) => {
        const mainStory = parseHours(row.mainStoryHours);
        return mainStory !== null && mainStory > 0 && mainStory <= 4;
      })
      .slice(0, 6)
      .map((s) => s.card);

    // Community Favorites: best reviewed titles in the mood's genre space.
    const communityFavorites = rows
      .filter((row) => parseScore(row.criticScore) !== null && genreMatchesMood(row.primaryGenre || '', mood.genres))
      .sort((a, b) => (parseScore(b.criticScore) ?? 0) - (parseScore(a.criticScore) ?? 0))
      .slice(0, 6)
      .map((row) => toCard(row, mood));

    const rails: Array<{ railId: string; title: string; reason: string; games: DiscoveryGameCard[] }> = [];
    if (topMoodPicks.length > 0) {
      rails.push({ railId: 'moodPicks', title: `Top picks for your ${mood.label} mood`, reason: mood.blurb, games: topMoodPicks });
    }
    if (backlogGems.length > 0) {
      rails.push({ railId: 'backlogGems', title: 'Backlog gems', reason: 'Unplayed titles worth your time', games: backlogGems });
    }
    if (quickPlay.length > 0) {
      rails.push({ railId: 'quickPlay', title: 'Quick sessions', reason: 'Short campaigns that fit a single sitting', games: quickPlay });
    }
    if (communityFavorites.length > 0) {
      rails.push({ railId: 'communityFavorites', title: 'Community favorites', reason: 'Best-reviewed titles in this space', games: communityFavorites });
    }

    return res.json({ success: true, mood: moodKey, moodLabel: mood.label, rails });
  } catch (err: any) {
    console.error('POST /api/discovery/rails error:', err?.message || err);
    return sendApiError(res, 500, 'Failed to build discovery rails');
  }
});

/**
 * POST /api/discovery/surprise
 * Body: { seed?: number }
 * Returns a single seeded pick so tests (and "roll again") are reproducible.
 */
router.post('/surprise', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as { seed?: number };
    const rows = loadLibraryRows();
    if (rows.length === 0) {
      return res.json({ success: true, game: null });
    }
    const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : Date.now();
    const rand = mulberry32(Math.floor(seed) % 2147483647);
    const pick = rows[Math.floor(rand() * rows.length)];
    const mood = MOODS.cozy; // neutral scoring for surprise picks
    return res.json({ success: true, seed, game: toCard(pick, mood) });
  } catch (err: any) {
    console.error('POST /api/discovery/surprise error:', err?.message || err);
    return sendApiError(res, 500, 'Failed to pick a surprise game');
  }
});

export default router;
