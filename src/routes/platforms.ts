import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { CANONICAL_PLATFORMS } from '../lib/platformTaxonomy';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();

/**
 * Platform Intelligence Hub
 * -------------------------
 * Aggregates platform-specific games, trophies/achievements, playtime stats,
 * and active store deals into a single dashboard per platform.
 *
 * Supported platform keys (see WUD-PLATFORM-HUBS / WUD-PLATFORM-EXTEND):
 *   playstation | epic | steam | xbox | gog | ubisoft | ea | battlenet | amazon | itchio | nintendo
 */

// ---------------------------------------------------------------------------
// Platform configuration
// ---------------------------------------------------------------------------

interface PlatformConfig {
  key: string;
  label: string;
  /** EPIC-04 canonical taxonomy label this hub aggregates (AppOwnership.platformCanonical) */
  canonicalLabel: string;
  /** Substrings that match this platform in AppOwnership.Platform */
  ownershipMatches: string[];
  /** Substrings that match this platform in ITAD deal shop names */
  dealMatches: string[];
  /** Substrings that match this platform in GamerPower giveaway platform strings */
  giveawayMatches: string[];
  /** Accent color used by the frontend (Tailwind classes) */
  accent: string;
  /** Lucide icon name */
  icon: string;
}

const PLATFORMS: Record<string, PlatformConfig> = {
  playstation: {
    key: 'playstation',
    label: 'PlayStation',
    canonicalLabel: 'Console – PlayStation',
    ownershipMatches: ['ps5', 'ps4', 'playstation', 'ps3', 'ps vita'],
    dealMatches: ['playstation', 'psn', 'ps5', 'ps4'],
    giveawayMatches: ['playstation', 'ps5', 'ps4', 'psn'],
    accent: 'blue',
    icon: 'gamepad-2',
  },
  epic: {
    key: 'epic',
    label: 'Epic Games',
    canonicalLabel: 'PC',
    ownershipMatches: ['epic'],
    dealMatches: ['epic'],
    giveawayMatches: ['epic'],
    accent: 'violet',
    icon: 'layers',
  },
  steam: {
    key: 'steam',
    label: 'Steam',
    canonicalLabel: 'PC',
    ownershipMatches: ['steam'],
    dealMatches: ['steam'],
    giveawayMatches: ['steam'],
    accent: 'sky',
    icon: 'steam',
  },
  xbox: {
    key: 'xbox',
    label: 'Xbox',
    canonicalLabel: 'Console – Xbox',
    ownershipMatches: ['xbox'],
    dealMatches: ['xbox'],
    giveawayMatches: ['xbox'],
    accent: 'emerald',
    icon: 'gamepad',
  },
  gog: {
    key: 'gog',
    label: 'GOG',
    canonicalLabel: 'PC',
    ownershipMatches: ['gog'],
    dealMatches: ['gog'],
    // HUB-04: 'drm-free' is NOT a GOG-only signal — many giveaways are DRM-free
    // on other storefronts — so matching it would over-aggregate non-GOG deals
    // into the GOG hub. Only an explicit GOG store match counts now.
    giveawayMatches: ['gog'],
    accent: 'amber',
    icon: 'package',
  },
  ubisoft: {
    key: 'ubisoft',
    label: 'Ubisoft Connect',
    canonicalLabel: 'PC',
    ownershipMatches: ['uplay', 'ubisoft'],
    dealMatches: ['ubisoft', 'uplay'],
    giveawayMatches: ['ubisoft', 'uplay'],
    accent: 'cyan',
    icon: 'shield',
  },
  ea: {
    key: 'ea',
    label: 'EA App',
    canonicalLabel: 'PC',
    ownershipMatches: ['origin', 'ea', 'ea app'],
    dealMatches: ['ea', 'origin'],
    giveawayMatches: ['origin', 'ea'],
    accent: 'rose',
    icon: 'zap',
  },
  battlenet: {
    key: 'battlenet',
    label: 'Battle.net',
    canonicalLabel: 'PC',
    ownershipMatches: ['battle.net', 'battlenet', 'blizzard'],
    dealMatches: ['battle.net', 'battlenet', 'blizzard'],
    giveawayMatches: ['battle.net', 'battlenet', 'blizzard'],
    accent: 'blue',
    icon: 'sword',
  },
  amazon: {
    key: 'amazon',
    label: 'Amazon Games',
    canonicalLabel: 'PC',
    ownershipMatches: ['amazon', 'twitch'],
    dealMatches: ['amazon', 'twitch'],
    giveawayMatches: ['amazon', 'prime gaming', 'twitch'],
    accent: 'orange',
    icon: 'shopping-cart',
  },
  itchio: {
    key: 'itchio',
    label: 'Itch.io',
    canonicalLabel: 'PC',
    ownershipMatches: ['itch.io', 'itchio', 'itch'],
    dealMatches: ['itch.io', 'itchio', 'itch'],
    giveawayMatches: ['itch.io', 'itchio', 'itch'],
    accent: 'pink',
    icon: 'heart',
  },
  nintendo: {
    key: 'nintendo',
    label: 'Nintendo',
    canonicalLabel: 'Console – Nintendo',
    ownershipMatches: ['nintendo', 'switch', 'eshop', '3ds', 'wii u'],
    dealMatches: ['nintendo', 'eshop', 'switch'],
    giveawayMatches: ['nintendo', 'switch'],
    accent: 'red',
    icon: 'gamepad-2',
  },
};

const VALID_KEYS = Object.keys(PLATFORMS);

function getPlatform(key: string): PlatformConfig | undefined {
  return PLATFORMS[key.toLowerCase()];
}

function matchesAny(value: string | null | undefined, needles: string[]): boolean {
  if (!value) return false;
  const haystack = value.toLowerCase();
  return needles.some((n) => haystack.includes(n));
}

// ---------------------------------------------------------------------------
// Cache readers (scripts/.cache/)
// ---------------------------------------------------------------------------

interface CachedDeal {
  id: string;
  title: string;
  store: string;
  currentPrice: number;
  regularPrice: number;
  discountCut: number;
  historyLow?: number;
  storeUrl: string;
  boxart?: string;
  type?: string;
}

function readJsonCache(fileName: string): any {
  try {
    const cachePath = path.join(process.cwd(), 'scripts', '.cache', fileName);
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading cache ${fileName}:`, err);
  }
  return null;
}

function getItadDeals(): CachedDeal[] {
  const data = readJsonCache('itad_deals.json');
  if (!data || !Array.isArray(data.list)) return [];
  return data.list.map((item: any) => ({
    id: item.id || item.slug,
    title: item.title,
    store: item.deal?.shop?.name || 'Unknown Store',
    currentPrice: item.deal?.price?.amount ?? 0,
    regularPrice: item.deal?.regular?.amount ?? 0,
    discountCut: item.deal?.cut ?? 0,
    historyLow: item.deal?.historyLow?.amount,
    storeUrl: item.deal?.url || `https://isthereanydeal.com/game/${item.slug}/`,
    boxart: item.assets?.boxart || item.assets?.banner300,
    type: item.type || 'game',
  }));
}

function getGiveaways(): CachedDeal[] {
  const data = readJsonCache('gamerpower_giveaways.json');
  if (!Array.isArray(data)) return [];
  return data.map((item: any) => ({
    id: `giveaway-${item.id}`,
    title: item.title,
    store: item.platforms || 'Free Giveaway',
    currentPrice: 0,
    regularPrice: parseFloat((item.worth || '$0').replace(/[^0-9.]/g, '')) || 0,
    discountCut: 100,
    storeUrl: item.open_giveaway_url || item.gamerpower_url,
    boxart: item.image || item.thumbnail,
    type: 'giveaway',
  }));
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function parseTrophyDifficulty(difficulty: string | null | undefined): number {
  if (!difficulty) return 0;
  const match = difficulty.match(/(\d+)\/10/);
  return match ? parseInt(match[1], 10) : 0;
}

function parseHours(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const match = String(value).match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * GET /api/platforms/:platform/summary
 * Aggregates owned games, playtime, trophies/achievements, and active deals
 * for a single platform.
 */
router.get('/:platform/summary', async (req: Request, res: Response) => {
  const platformKey = (req.params.platform || '').toLowerCase();
  const config = getPlatform(platformKey);

  if (!config) {
    return res.status(400).json({
      success: false,
      error: `Unknown platform '${platformKey}'. Valid platforms: ${VALID_KEYS.join(', ')}`,
    });
  }

  try {
    // 1. Owned games on this platform (join AppGame for cover/genre/title)
    // EPIC-05 (HUB defect): the previous query matched ONLY
    // config.ownershipMatches[0] (e.g. 'ps5' for the PlayStation hub), so rows
    // carrying 'PS4' / 'PlayStation 4' / 'PS3' / 'PS Vita' were silently
    // dropped. Match ANY ownership needle plus the EPIC-04 canonical label.
    // Raw SQL equivalent of the former Prisma appOwnership.findMany with
    // appGame.includes: match ANY ownership needle (LIKE contains) OR the
    // EPIC-04 canonical label, then load the nested relations in bulk.
    const whereOr = [
      ...config.ownershipMatches.map(() => `o."Platform" LIKE ?`),
      `o."platformCanonical" = ?`,
    ].join(' OR ');
    const ownershipParams: string[] = [
      ...config.ownershipMatches.map((m: string) => `%${m}%`),
      config.canonicalLabel,
    ];
    const ownershipRows = db
      .prepare(
        `SELECT o."OwnershipID" AS o_ownershipID, o."GameID" AS o_gameID, o."Platform" AS o_platform,
                o."platformCanonical" AS o_platformCanonical, o."Edition" AS o_edition,
                o."Format" AS o_format, o."Purchase Date" AS o_purchaseDate,
                o."Price Paid" AS o_pricePaid, o."Currency" AS o_currency, o."Store URL" AS o_storeUrl
         FROM AppOwnership o
         WHERE ${whereOr}`,
      )
      .all(...ownershipParams) as any[];

    const gameIds = Array.from(
      new Set(ownershipRows.map((r) => r.o_gameID).filter(Boolean)),
    ) as string[];

    const gamesById = new Map<string, any>();
    if (gameIds.length > 0) {
      const placeholders = gameIds.map(() => '?').join(', ');
      const gameRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "Game Title" AS gameTitle, "Primary Genre" AS primaryGenre,
                  "cover_url" AS cover_url, "headerImage" AS headerImage, "criticScore" AS criticScore,
                  "platformStoreUrls" AS platformStoreUrls, "storeUrl" AS storeUrl
           FROM AppGames WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      for (const g of gameRows) gamesById.set(g.gameID, g);

      const trackingRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "Play Status" AS playStatus, "Hours Played" AS hoursPlayed,
                  "Personal Rating (1-10)" AS personalRating, "Last Played Date" AS lastPlayedDate,
                  "Completed Date" AS completedDate, "Trophy Progress" AS "Trophy_Progress"
           FROM AppTracking WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      for (const t of trackingRows) {
        const g = gamesById.get(t.gameID);
        if (g) g.tracking = t;
      }

      const roadmapRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "Trophy / Platinum Difficulty" AS trophyPlatinumDifficulty,
                  "Estimated 100% Completion Time" AS estimated100CompletionTime,
                  "Missable Content / Trophies?" AS missableContentTrophies,
                  "Trophy Roadmap & Guide URL" AS trophyRoadmapGuideUrl
           FROM AppCompletionRoadmap WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      const roadmapsByGame = new Map<string, any[]>();
      for (const r of roadmapRows) {
        if (!roadmapsByGame.has(r.gameID)) roadmapsByGame.set(r.gameID, []);
        roadmapsByGame.get(r.gameID)!.push(r);
      }

      const reviewRows = db
        .prepare(
          `SELECT "GameID" AS gameID, "Score Numeric" AS scoreNumeric
           FROM AppReviews WHERE "GameID" IN (${placeholders})`,
        )
        .all(...gameIds) as any[];
      const reviewsByGame = new Map<string, any[]>();
      for (const rv of reviewRows) {
        if (!reviewsByGame.has(rv.gameID)) reviewsByGame.set(rv.gameID, []);
        reviewsByGame.get(rv.gameID)!.push(rv);
      }

      for (const g of gamesById.values()) {
        if (g.tracking === undefined) g.tracking = null;
        g.completionRoadmaps = roadmapsByGame.get(g.gameID) || [];
        g.reviews = reviewsByGame.get(g.gameID) || [];
      }
    }

    // Reassemble the Prisma include shape: each ownership row carries `appGame`.
    const ownerships = ownershipRows.map((o) => ({
      platform: o.o_platform,
      platformCanonical: o.o_platformCanonical ?? null,
      edition: o.o_edition,
      format: o.o_format,
      purchaseDate: o.o_purchaseDate,
      pricePaid: o.o_pricePaid,
      currency: o.o_currency,
      storeUrl: o.o_storeUrl,
      appGame: gamesById.get(o.o_gameID) || null,
    }));


    // Filter in-memory to catch multi-token matches (e.g. "PS5" vs "PlayStation 5")
    const filtered = ownerships.filter((o: (typeof ownerships)[number]) =>
      matchesAny(o.platform, config.ownershipMatches)
    );


    // Deduplicate by gameID (a game may be owned on PS4 AND PS5)
    const seen = new Set<string>();
    const ownedGames: any[] = [];
    for (const o of filtered) {
      const game = o.appGame;
      if (!game) continue;
      if (seen.has(game.gameID)) continue;
      seen.add(game.gameID);

      const tracking = game.tracking;
      const roadmap = game.completionRoadmaps?.[0];

      // Calculate review score (average scoreNumeric from reviews, or fallback to game.criticScore or 0)
      let reviewScore = 0;
      if (game.reviews && game.reviews.length > 0) {
        const scores = game.reviews
          .map((r: any) => r.scoreNumeric)
          .filter((s: any) => typeof s === 'number' && !isNaN(s));
        if (scores.length > 0) {
          reviewScore = Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length);
        } else if (game.criticScore) {
          reviewScore = game.criticScore;
        }
      } else if (game.criticScore) {
        reviewScore = game.criticScore;
      }

      // Store URLs / links JSON object or fallback storeUrl
      let platformStoreUrls: Record<string, string> = {};
      if (game.platformStoreUrls) {
        try {
          platformStoreUrls = typeof game.platformStoreUrls === 'string'
            ? JSON.parse(game.platformStoreUrls)
            : (game.platformStoreUrls as Record<string, string>);
        } catch (_) {
          platformStoreUrls = {};
        }
      }
      if (!platformStoreUrls[config.key] && (o.storeUrl || game.storeUrl)) {
        platformStoreUrls[config.key] = o.storeUrl || game.storeUrl || '';
      }

      ownedGames.push({
        gameID: game.gameID,
        title: game.gameTitle || 'Unknown Title',
        genre: game.primaryGenre || 'Game',
        coverUrl: game.cover_url || game.headerImage || null,
        platform: o.platform,
        platformCanonical: o.platformCanonical ?? null,
        edition: o.edition || null,
        format: o.format || null,
        purchaseDate: o.purchaseDate || null,
        pricePaid: o.pricePaid ?? null,
        currency: o.currency || null,
        storeUrl: o.storeUrl || game.storeUrl || null,
        platformStoreUrls,
        // Tracking
        playStatus: tracking?.playStatus || 'Not Started',
        hoursPlayed: tracking?.hoursPlayed ?? 0,
        personalRating: tracking?.personalRating ?? null,
        lastPlayedDate: tracking?.lastPlayedDate || null,
        completedDate: tracking?.completedDate || null,
        trophyProgress: tracking?.Trophy_Progress ?? null,
        reviewScore,
        criticScore: game.criticScore || null,
        // Completion roadmap
        trophyDifficulty: roadmap?.trophyPlatinumDifficulty || null,
        trophyDifficultyScore: parseTrophyDifficulty(roadmap?.trophyPlatinumDifficulty),
        estimated100Hours: parseHours(roadmap?.estimated100CompletionTime),
        missableTrophies: roadmap?.missableContentTrophies || null,
        roadmapUrl: roadmap?.trophyRoadmapGuideUrl || null,
      });
    }

    // 2. Aggregate summary stats
    const totalGames = ownedGames.length;
    const totalPlaytime = ownedGames.reduce((sum, g) => sum + (g.hoursPlayed || 0), 0);
    const completedGames = ownedGames.filter(
      (g) => g.completedDate || (g.playStatus && /completed|finished|100%/i.test(g.playStatus))
    ).length;
    const completionRate = totalGames > 0 ? Math.round((completedGames / totalGames) * 100) : 0;

    // Trophy / achievement stats
    const gamesWithTrophyData = ownedGames.filter((g) => g.trophyDifficultyScore > 0);
    const avgTrophyDifficulty =
      gamesWithTrophyData.length > 0
        ? Math.round(
            (gamesWithTrophyData.reduce((s, g) => s + g.trophyDifficultyScore, 0) /
              gamesWithTrophyData.length) *
              10
          ) / 10
        : 0;
    const platinumCount = ownedGames.filter(
      (g) => g.trophyDifficultyScore >= 7 || /platinum/i.test(g.trophyDifficulty || '')
    ).length;

    // 3. Recent accolades / platinum wall (games with high difficulty or completed)
    const recentAccolades = ownedGames
      .filter((g) => g.completedDate || g.trophyDifficultyScore >= 7)
      .sort((a, b) => {
        const da = a.completedDate ? new Date(a.completedDate).getTime() : 0;
        const db = b.completedDate ? new Date(b.completedDate).getTime() : 0;
        return db - da;
      })
      .slice(0, 12);

    // 4. Active deals & giveaways matching this platform
    const itadDeals = getItadDeals();
    const giveaways = getGiveaways();

    const platformDeals = itadDeals.filter((d) => matchesAny(d.store, config.dealMatches));
    const platformGiveaways = giveaways.filter((d) =>
      matchesAny(d.store, config.giveawayMatches)
    );

    const activeDeals = [...platformDeals, ...platformGiveaways]
      .sort((a, b) => b.discountCut - a.discountCut)
      .slice(0, 20);

    res.json({
      success: true,
      platform: config.key,
      label: config.label,
      summary: {
        totalGames,
        totalPlaytime: Math.round(totalPlaytime * 10) / 10,
        completedGames,
        completionRate,
        trophyCount: gamesWithTrophyData.length,
        avgTrophyDifficulty,
        platinumCount,
      },
      ownedGames,
      recentAccolades,
      activeDeals,
    });
  } catch (err: any) {
    console.error(`Error in /api/platforms/${platformKey}/summary:`, err);
    sendApiError(res, 500, 'Failed to load platform summary');
  }
});

/**
 * GET /api/platforms/taxonomy
 * EPIC-04: returns the canonical platform taxonomy plus live per-label counts
 * from AppOwnership (canonical + unclassified), proving taxonomy coverage.
 */
router.get('/taxonomy', (_req: Request, res: Response) => {
  try {
    const counts = db
      .prepare(
        `SELECT COALESCE("platformCanonical", 'Unclassified') AS canonical, COUNT(*) AS cnt
         FROM "AppOwnership" GROUP BY canonical ORDER BY cnt DESC`,
      )
      .all() as Array<{ canonical: string; cnt: number }>;
    const total = (db.prepare('SELECT COUNT(*) AS c FROM "AppOwnership"').get() as any)?.c ?? 0;
    res.json({
      success: true,
      taxonomy: CANONICAL_PLATFORMS,
      total,
      counts,
    });
  } catch (err: any) {
    console.error('Error in /api/platforms/taxonomy:', err);
    sendApiError(res, 500, 'Failed to load platform taxonomy');
  }
});

/**
 * GET /api/platforms/audit-log
 * EPIC-04: returns recent immutable platform_audit_logs entries (append-only),
 * newest first, capped at ?limit (default 100, max 1000).
 */
router.get('/audit-log', (req: Request, res: Response) => {
  try {
    const rawLimit = parseInt(String(req.query.limit || '100'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;
    const entries = db
      .prepare(
        `SELECT id, "tableName" AS tableName, "rowId" AS rowId, field,
                "oldValue" AS oldValue, "newValue" AS newValue, reason, operator, createdAt
         FROM "platform_audit_logs" ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
    res.json({ success: true, count: (entries as any[]).length, entries });
  } catch (err: any) {
    console.error('Error in /api/platforms/audit-log:', err);
    sendApiError(res, 500, 'Failed to load platform audit log');
  }
});

/**
 * GET /api/platforms
 * Lists all supported platforms with their labels (for the tab bar).
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    platforms: Object.values(PLATFORMS).map((p) => ({
      key: p.key,
      label: p.label,
      accent: p.accent,
      icon: p.icon,
    })),
  });
});

export default router;
