import { Router } from "express";
import path from "path";
import fs from "fs";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import { gameDomainForTitle } from "./games";
import { sendApiError } from "../middleware/errorSanitizer";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });

const router = Router();

/**
 * Reads the cached ITAD deals file. Mirrors the logic in games.ts so the
 * dashboard radar and the deals hub stay consistent.
 */
function getCachedItadDeals(): any[] {
  try {
    const dealsPath = path.join(process.cwd(), "scripts", ".cache", "itad_deals.json");
    if (fs.existsSync(dealsPath)) {
      const raw = fs.readFileSync(dealsPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : parsed.list || [];
    }
  } catch (err) {
    console.warn("Failed to load ITAD deals cache:", err);
  }
  return [];
}

/**
 * Reads the cached GamerPower giveaways file. Mirrors the logic in games.ts.
 */
function getCachedGiveaways(): any[] {
  try {
    const giveawaysPath = path.join(
      process.cwd(),
      "scripts",
      ".cache",
      "gamerpower_giveaways.json",
    );
    if (fs.existsSync(giveawaysPath)) {
      const raw = fs.readFileSync(giveawaysPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.warn("Failed to load GamerPower giveaways cache:", err);
  }
  return [];
}

/**
 * EPIC-UX-REFINE-0001: Normalize platform taxonomy strings so variant labels
 * (e.g. "PlayStation 4"/"PS4", "PlayStation 5"/"PS5") collapse into canonical
 * keys. Preserves the native string when no mapping applies.
 */
function normalizePlatform(name: string | null | undefined): string {
  const n = String(name || "").trim();
  if (!n) return "Unknown";
  const lower = n.toLowerCase();
  if (
    (lower.includes("playstation") && lower.includes("4")) ||
    /^ps4$/i.test(n) ||
    lower.includes("ps4")
  )
    return "PS4";
  if (
    (lower.includes("playstation") && lower.includes("5")) ||
    /^ps5$/i.test(n) ||
    lower.includes("ps5")
  )
    return "PS5";
  if (/^ps3$/i.test(n) || lower.includes("ps3")) return "PS3";
  if (/^ps vita$/i.test(n) || lower.includes("ps vita")) return "PS Vita";
  if (
    lower.includes("xbox series") ||
    lower.includes("xbox one") ||
    lower.includes("xbox 360") ||
    lower.includes("xbox")
  )
    return "Xbox";
  if (lower.includes("nintendo switch") || lower.includes("nintendo")) return "Nintendo";
  if (lower.includes("steam")) return "Steam";
  if (lower.includes("gog")) return "GOG";
  if (lower.includes("epic")) return "Epic Games";
  if (lower.includes("ubisoft")) return "Ubisoft Connect";
  if (lower.includes("battle") || lower.includes("blizzard")) return "Battle.net";
  if (lower.includes("ea ") || lower.includes("origin")) return "EA App";
  if (lower.includes("amazon")) return "Amazon Games";
  if (lower.includes("itch") || lower.includes("itch.io")) return "Itch.io";
  return n;
}

/** FEAT-0160/EPIC-UX-REFINE-0001: resolve genre + rating enrichment for a deal title. */
interface DealEnrichment {
  genres: string[];
  rating: number | null;
  coverUrl: string | null;
  steamScore: number | null;
  openCriticScore: number | null;
  compositeScore: number | null;
}
function enrichDeal(title: string): DealEnrichment {
  try {
    const row = db
      .prepare(
        `
      SELECT "Game Title" AS title, "Primary Genre" AS genre, "GameID" AS gameId, cover_url AS coverUrl
      FROM AppGames
      WHERE LOWER(TRIM("Game Title")) = LOWER(TRIM(?))
      LIMIT 1
    `,
      )
      .get(title) as
      | {
          title: string;
          genre: string | null;
          gameId: string;
          coverUrl: string | null;
        }
      | undefined;
    if (row) {
      const genres = (row.genre || "")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
        .slice(0, 3);
      return {
        genres,
        rating: null,
        coverUrl: row.coverUrl || null,
        steamScore: null,
        openCriticScore: null,
        compositeScore: null,
      };
    }
  } catch (e) {
    /* table absent */
  }

  // Fallback: match on AppTracking title for owned games.
  try {
    const trackRow = db
      .prepare(
        `
      SELECT t."GameID" AS gameId
      FROM AppTracking t
      WHERE LOWER(TRIM(t."Game Title")) = LOWER(TRIM(?))
      LIMIT 1
    `,
      )
      .get(title) as { gameId: string } | undefined;
    if (trackRow) {
      const gameRow = db
        .prepare(
          `
        SELECT "Primary Genre" AS genre, "GameID" AS gameId, cover_url AS coverUrl
        FROM AppGames WHERE "GameID" = ?
        LIMIT 1
      `,
        )
        .get(trackRow.gameId) as
        { genre: string | null; gameId: string; coverUrl: string | null } | undefined;
      const genres = (gameRow?.genre || "")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
        .slice(0, 3);
      return {
        genres,
        rating: null,
        coverUrl: gameRow?.coverUrl || null,
        steamScore: null,
        openCriticScore: null,
        compositeScore: null,
      };
    }
  } catch (e) {
    /* tracking absent */
  }

  return {
    genres: [],
    rating: null,
    coverUrl: null,
    steamScore: null,
    openCriticScore: null,
    compositeScore: null,
  };
}
/** EPIC-UX-REFINE-0002: resolve deterministic review scores + composite score
 * (VCM Ch 23.6) for a deal title via AppReviews. Returns nulls when absent. */
interface ReviewEnrichment {
  steamScore: number | null;
  openCriticScore: number | null;
  compositeScore: number | null;
}
function enrichDealReviews(title: string): ReviewEnrichment {
  try {
    const rows = db
      .prepare(
        `
      SELECT r."Review Source" AS source, r."Score Numeric" AS scoreNumeric,
             r."Recommendation Percent" AS recPercent
      FROM AppReviews r
      JOIN AppGames g ON g."GameID" = r."GameID"
      WHERE LOWER(TRIM(g."Game Title")) = LOWER(TRIM(?))
    `,
      )
      .all(title) as Array<{
      source: string | null;
      scoreNumeric: number | null;
      recPercent: number | null;
    }>;
    let steamScore: number | null = null;
    let openCriticScore: number | null = null;
    for (const r of rows) {
      const src = String(r.source || "").toLowerCase();
      if (src.includes("steam")) {
        const v = Number(r.recPercent ?? r.scoreNumeric);
        if (!Number.isNaN(v)) steamScore = Math.max(0, Math.min(100, Math.round(v)));
      } else if (src.includes("opencritic")) {
        const v = Number(r.scoreNumeric ?? r.recPercent);
        if (!Number.isNaN(v)) openCriticScore = Math.max(0, Math.min(100, Math.round(v)));
      }
    }
    const vals = [steamScore, openCriticScore].filter(
      (x): x is number => x !== null && !Number.isNaN(x),
    );
    const compositeScore = vals.length
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : null;
    return { steamScore, openCriticScore, compositeScore };
  } catch (e) {
    /* reviews table absent */
  }
  return { steamScore: null, openCriticScore: null, compositeScore: null };
}

/** EPIC-UX-REFINE-0002: resolve the composite review score for a gameId so the
 * featured spotlight library fallback can render a review score badge. */
function scoresForFeaturedGame(gameId: string | null | undefined): number | null {
  if (!gameId) return null;
  try {
    const rows = db
      .prepare(
        `
      SELECT "Review Source" AS source, "Score Numeric" AS scoreNumeric,
             "Recommendation Percent" AS recPercent
      FROM AppReviews
      WHERE "GameID" = ?
    `,
      )
      .all(gameId) as Array<{
      source: string | null;
      scoreNumeric: number | null;
      recPercent: number | null;
    }>;
    let steamScore: number | null = null;
    let openCriticScore: number | null = null;
    for (const r of rows) {
      const src = String(r.source || "").toLowerCase();
      if (src.includes("steam")) {
        const v = Number(r.recPercent ?? r.scoreNumeric);
        if (!Number.isNaN(v)) steamScore = Math.max(0, Math.min(100, Math.round(v)));
      } else if (src.includes("opencritic")) {
        const v = Number(r.scoreNumeric ?? r.recPercent);
        if (!Number.isNaN(v)) openCriticScore = Math.max(0, Math.min(100, Math.round(v)));
      }
    }
    const vals = [steamScore, openCriticScore].filter(
      (x): x is number => x !== null && !Number.isNaN(x),
    );
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  } catch (e) {
    /* reviews table absent */
  }
  return null;
}

/** EPIC-UX-REFINE-0002: normalize a giveaway's raw platform string into a
 * short store badge label (Epic, Steam, GOG, Humble, Itch.io, IndieGala,
 * Stove, DRM-Free fallback). */
function storeBadgeForGiveaway(g: any): string {
  const raw = String(g?.platforms || g?.title || "").toLowerCase();
  if (raw.includes("epic")) return "Epic";
  if (raw.includes("steam")) return "Steam";
  if (raw.includes("gog")) return "GOG";
  if (raw.includes("humble")) return "Humble";
  if (raw.includes("itch")) return "Itch.io";
  if (raw.includes("indiegala")) return "IndieGala";
  if (raw.includes("stove")) return "Stove";
  if (raw.includes("amazon")) return "Amazon";
  return "Free Giveaway";
}

/** EPIC-UX-REFINE-0002: deterministic mod category taxonomy derived from the
 * game's primary genre so Top Modded cards can render tag pills without a
 * dedicated mod taxonomy table. */
function modTaxonomyFor(genre: string | null | undefined): string[] {
  const g = String(genre || "").toLowerCase();
  if (g.includes("rpg") || g.includes("action")) return ["Total Conversion", "Graphics", "Fixes"];
  if (g.includes("shooter")) return ["Graphics", "Fixes", "Gameplay"];
  if (g.includes("strategy") || g.includes("simulation"))
    return ["Total Conversion", "UI", "Balance"];
  if (g.includes("roguelike") || g.includes("metroidvania")) return ["Gameplay", "Fixes"];
  if (g.includes("survival") || g.includes("sandbox")) return ["Content", "Graphics", "Fixes"];
  if (g.includes("horror")) return ["Graphics", "Fixes"];
  if (g.includes("adventure")) return ["Content", "Graphics"];
  return ["Graphics", "Fixes"];
}

/**
 * GET /api/dashboard/summary
 * Aggregated home-dashboard payload:
 *  - lastPlayed: most recent tracked game from AppTracking
 *  - freebiesAndDeals: active giveaways + top price alerts from the deals cache
 *  - platformBreakdown: total owned game count + counts per platform
 *  - moddableGames: owned games matching recognized mod domains with mod counts
 *  - fleetSummary: active device count + primary hardware preset rating
 */
router.get("/summary", (_req, res) => {
  try {
    // ---- lastPlayed -------------------------------------------------------
    let lastPlayed: any = null;
    try {
      const row = db
        .prepare(
          `
        SELECT t."GameID" AS gameId, g."Game Title" AS title, g."Primary Genre" AS genre,
               t."Play Status" AS playStatus, t."Hours Played" AS hoursPlayed,
               t."Last Played Date" AS lastPlayedDate, t."Played Platform" AS playedPlatform,
               g.cover_url AS coverUrl, g.headerImage AS headerImage, g.storeUrl AS storeUrl
        FROM AppTracking t
        LEFT JOIN AppGames g ON g.GameID = t."GameID"
        WHERE t."Last Played Date" IS NOT NULL
        ORDER BY t."Last Played Date" DESC
        LIMIT 1
      `,
        )
        .get() as any;
      if (row) {
        lastPlayed = {
          gameId: row.gameId,
          title: row.title || "Unknown Game",
          genre: row.genre || null,
          playStatus: row.playStatus || "Not Started",
          hoursPlayed: row.hoursPlayed || 0,
          lastPlayedDate: row.lastPlayedDate || null,
          playedPlatform: row.playedPlatform || null,
          coverUrl: row.coverUrl || row.headerImage || null,
          storeUrl: row.storeUrl || null,
        };
      }
    } catch (e) {
      console.warn("Dashboard lastPlayed query failed:", e);
    }

    // ---- freebiesAndDeals -------------------------------------------------
    const giveaways = getCachedGiveaways();
    const deals = getCachedItadDeals();

    const activeGiveaways = giveaways
      .filter((g: any) => g && g.title)
      .slice(0, 5)
      .map((g: any) => ({
        id: g.id ?? null,
        title: g.title,
        worth: g.worth ?? null,
        platforms: g.platforms ?? null,
        url: g.open_giveaway_url || g.gamerpower_url || null,
        image: g.image || g.thumbnail || null,
        // Sprint 6.1 (stability): normalize "N/A"/empty end dates to null so the
        // client renders "No expiry listed" instead of "Ending soon" for a
        // giveaway with no declared expiry (parity with deals.ts normalization).
        endAt:
          g.end_date &&
          String(g.end_date).trim() !== "" &&
          String(g.end_date).trim().toUpperCase() !== "N/A"
            ? String(g.end_date)
            : null,
        // EPIC-UX-REFINE-0002: rich-media freebie card fields.
        description: g.description || null,
        type: g.type || null,
        store: storeBadgeForGiveaway(g),
      }));

    // Top price alerts: deals with the deepest discount cut, excluding freebies.
    // EPIC-UX-REFINE-0001: each top deal card is enriched with genre badges and
    // (when available) a composite rating sourced from the local catalog.
    // EPIC-UX-REFINE-0002: cards also carry cover art + review score pills +
    // the verified 30-day low baseline (EU Omnibus Directive) for the tooltip.
    const topDeals = deals
      .filter((d: any) => d && d.title && d.deal && d.deal.cut)
      .sort((a: any, b: any) => (Number(b.deal.cut) || 0) - (Number(a.deal.cut) || 0))
      .slice(0, 5)
      .map((d: any) => {
        const enrichment = enrichDeal(d.title);
        const reviews = enrichDealReviews(d.title);
        return {
          id: d.id ?? d.slug ?? null,
          title: d.title,
          store: d.deal?.shop?.name ?? null,
          currentPrice: d.deal?.price?.amount ?? null,
          regularPrice: d.deal?.regular?.amount ?? null,
          discountCut: d.deal?.cut ?? null,
          url: d.deal?.url ?? null,
          boxart: d.assets?.boxart ?? d.assets?.banner300 ?? null,
          genres: enrichment.genres,
          rating: enrichment.rating,
          coverUrl: enrichment.coverUrl || d.assets?.boxart || d.assets?.banner300 || null,
          steamScore: reviews.steamScore,
          openCriticScore: reviews.openCriticScore,
          compositeScore: reviews.compositeScore,
          lowest30d: d.deal?.storeLow?.amount ?? null,
          historyLow: d.deal?.historyLow?.amount ?? null,
        };
      });

    const freebiesAndDeals = {
      giveaways: activeGiveaways,
      deals: topDeals,
      giveawayCount: activeGiveaways.length,
      dealCount: topDeals.length,
    };

    // ---- platformBreakdown ------------------------------------------------
    // Per-platform quick-lists (top 8 owned games each) ranked by composite
    // score descending so the dashboard surfaces the highest-rated titles.
    let platformBreakdown: {
      total: number;
      platforms: Array<{ name: string; count: number }>;
      platformGames: Record<
        string,
        Array<{
          gameId: string;
          title: string;
          coverUrl: string | null;
          steamScore: number | null;
          openCriticScore: number | null;
          compositeScore: number | null;
          isModdable: boolean;
          genres: string[];
        }>
      >;
    } = { total: 0, platforms: [], platformGames: {} };
    try {
      const totalRow = db
        .prepare('SELECT COUNT(DISTINCT "GameID") AS total FROM AppOwnership')
        .get() as { total: number };
      const rawRows = db
        .prepare(
          `
        SELECT "Platform" AS name, COUNT(*) AS count
        FROM AppOwnership
        WHERE "Platform" IS NOT NULL AND "Platform" != ''
        GROUP BY "Platform"
        ORDER BY count DESC
      `,
        )
        .all() as Array<{ name: string; count: number }>;

      // EPIC-UX-REFINE-0001: aggregate counts on normalized platform keys so
      // "PlayStation 4"/"PS4" collapse into "PS4" and "PlayStation 5"/"PS5"
      // collapse into "PS5" (deduplicated ownership counts). Keep a reverse
      // map of normalized key -> raw platform names so the per-platform game
      // mini-list can still query the original DB labels.
      const merged = new Map<string, number>();
      const rawByKey = new Map<string, string[]>();
      for (const r of rawRows) {
        const key = normalizePlatform(r.name);
        merged.set(key, (merged.get(key) || 0) + r.count);
        if (!rawByKey.has(key)) rawByKey.set(key, []);
        rawByKey.get(key)!.push(r.name);
      }
      const rows = Array.from(merged.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      // Resolve raw platform labels for a normalized key (exact matched first).
      const rawLabelsFor = (key: string): string[] => rawByKey.get(key) || [key];

      // Review scores keyed by GameID (steam + openCritic).
      const scoresByGame: Record<
        string,
        { steamScore: number | null; openCriticScore: number | null }
      > = {};
      try {
        const reviewRows = db
          .prepare(
            `
          SELECT "GameID" AS gameId, "Review Source" AS source,
                 "Score Numeric" AS scoreNumeric, "Recommendation Percent" AS recPercent
          FROM AppReviews
          WHERE "GameID" IS NOT NULL AND "GameID" != ''
        `,
          )
          .all() as Array<{
          gameId: string;
          source: string | null;
          scoreNumeric: number | null;
          recPercent: number | null;
        }>;
        for (const r of reviewRows) {
          const k = String(r.gameId ?? "");
          if (!k) continue;
          if (!scoresByGame[k]) scoresByGame[k] = { steamScore: null, openCriticScore: null };
          const src = String(r.source || "").toLowerCase();
          if (src.includes("steam")) {
            const v = Number(r.recPercent ?? r.scoreNumeric);
            if (!Number.isNaN(v))
              scoresByGame[k].steamScore = Math.max(0, Math.min(100, Math.round(v)));
          } else if (src.includes("opencritic")) {
            const v = Number(r.scoreNumeric ?? r.recPercent);
            if (!Number.isNaN(v))
              scoresByGame[k].openCriticScore = Math.max(0, Math.min(100, Math.round(v)));
          }
        }
      } catch (e) {
        /* reviews table absent */
      }

      const composite = (s: {
        steamScore: number | null;
        openCriticScore: number | null;
      }): number | null => {
        const vals = [s.steamScore, s.openCriticScore].filter(
          (x): x is number => x !== null && !Number.isNaN(x),
        );
        if (!vals.length) return null;
        return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      };

      const platformGames: Record<string, any[]> = {};
      for (const p of rows) {
        // Query against all raw platform labels that normalized to this key so
        // the mini-list joins "PlayStation 4" + "PS4" rows into one "PS4" card.
        const labels = rawLabelsFor(p.name);
        const placeholders = labels.map(() => "?").join(",");
        const owned = db
          .prepare(
            `
          SELECT g."GameID" AS gameId, g."Game Title" AS title, g.cover_url AS coverUrl,
                 g.nexusUrl AS nexusUrl, g.nexusModCount AS nexusModCount, g.trackedModCount AS trackedModCount
          FROM AppOwnership o
          JOIN AppGames g ON g."GameID" = o."GameID"
          WHERE o."Platform" IN (${placeholders})
          GROUP BY g."GameID"
        `,
          )
          .all(...labels) as Array<{
          gameId: string;
          title: string;
          coverUrl: string | null;
          nexusUrl: string | null;
          nexusModCount: number | null;
          trackedModCount: number | null;
        }>;

        const games = owned
          .map((g) => {
            const scores = scoresByGame[String(g.gameId ?? "")] || {
              steamScore: null,
              openCriticScore: null,
            };
            const domain = gameDomainForTitle(g.title);
            const hasNexusSignal = !!(g.nexusUrl || g.nexusModCount || g.trackedModCount);
            return {
              gameId: g.gameId,
              title: g.title || "Unknown Game",
              coverUrl: g.coverUrl || null,
              steamScore: scores.steamScore,
              openCriticScore: scores.openCriticScore,
              compositeScore: composite(scores),
              isModdable: !!domain && domain !== "unknown" && hasNexusSignal,
              genres: [],
            };
          })
          .sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1))
          .slice(0, 8);
        platformGames[p.name] = games;
      }

      platformBreakdown = {
        total: totalRow.total || 0,
        platforms: rows.map((r) => ({ name: r.name, count: r.count })),
        platformGames,
      };
    } catch (e) {
      console.warn("Dashboard platformBreakdown query failed:", e);
    }

    // ---- moddableGames ----------------------------------------------------
    let moddableGames: Array<{
      gameId: string;
      title: string;
      domain: string;
      modCount: number;
      nexusUrl: string | null;
      coverUrl: string | null;
      genre: string | null;
      modTags: string[];
    }> = [];
    try {
      const rows = db
        .prepare(
          `
        SELECT g."GameID" AS gameId, g."Game Title" AS title, g.nexusUrl AS nexusUrl,
               g.nexusModCount AS nexusModCount, g.trackedModCount AS trackedModCount,
               g.cover_url AS coverUrl, g."Primary Genre" AS genre
        FROM AppGames g
        WHERE EXISTS (
          SELECT 1 FROM AppOwnership o WHERE o."GameID" = g."GameID"
        )
        AND (g.nexusUrl IS NOT NULL OR g.nexusModCount IS NOT NULL OR g.trackedModCount IS NOT NULL)
        ORDER BY COALESCE(g.nexusModCount, g.trackedModCount, 0) DESC
        LIMIT 12
      `,
        )
        .all() as Array<{
        gameId: string;
        title: string;
        nexusUrl: string | null;
        nexusModCount: number | null;
        trackedModCount: number | null;
        coverUrl: string | null;
        genre: string | null;
      }>;

      moddableGames = rows
        .map((r) => {
          const domain = gameDomainForTitle(r.title);
          if (!domain || domain === "unknown") return null;
          const modCount = Number(r.nexusModCount ?? r.trackedModCount ?? 0);
          return {
            gameId: r.gameId,
            title: r.title,
            domain,
            modCount,
            nexusUrl: r.nexusUrl || null,
            coverUrl: r.coverUrl || null,
            genre: r.genre || null,
            modTags: modTaxonomyFor(r.genre),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 8);
    } catch (e) {
      console.warn("Dashboard moddableGames query failed:", e);
    }

    // ---- featured spotlight ----------------------------------------------
    // EPIC-UX-REFINE-0002: server-computed "Featured Spotlight" card. Top-rated
    // deal of the day OR urgent giveaway:
    //   1) active giveaway with the nearest future expiry (urgency)
    //   2) else the deepest-discount top deal with cover art / review score
    //   3) else fall back to the most recently played game
    let featured: any = null;
    try {
      const futureGiveaways = activeGiveaways
        .filter((g: any) => {
          const t = new Date(String(g.endAt || "").replace(" ", "T")).getTime();
          return !Number.isNaN(t) && t > Date.now();
        })
        .sort(
          (a: any, b: any) =>
            new Date(String(a.endAt || "").replace(" ", "T")).getTime() -
            new Date(String(b.endAt || "").replace(" ", "T")).getTime(),
        );
      const urgentGiveaway = futureGiveaways.length ? futureGiveaways[0] : null;
      const bestDeal = topDeals.length ? topDeals[0] : null;

      if (urgentGiveaway) {
        const genres = urgentGiveaway.type ? ["Freebie", String(urgentGiveaway.type)] : ["Freebie"];
        featured = {
          kind: "giveaway",
          title: urgentGiveaway.title,
          coverUrl: urgentGiveaway.image || null,
          genres: genres.slice(0, 3),
          reviewScore: null,
          synopsis:
            urgentGiveaway.description ||
            "Free limited-time giveaway ΓÇö claim it before the timer runs out.",
          price: urgentGiveaway.worth || "FREE",
          store: urgentGiveaway.store || "Free Giveaway",
          url: urgentGiveaway.url || "#",
          endAt: urgentGiveaway.endAt || null,
        };
      } else if (bestDeal) {
        const reviewScore =
          bestDeal.compositeScore ?? bestDeal.steamScore ?? bestDeal.openCriticScore ?? null;
        featured = {
          kind: "deal",
          title: bestDeal.title,
          coverUrl: bestDeal.coverUrl || null,
          genres: (bestDeal.genres || []).slice(0, 3),
          reviewScore,
          synopsis:
            "Deal of the day ΓÇö the deepest discount currently tracked across authorized storefronts.",
          price: bestDeal.currentPrice,
          store: bestDeal.store || "Store",
          url: bestDeal.url || "#",
          endAt: null,
        };
      } else if (lastPlayed) {
        const reviewScores = scoresForFeaturedGame(lastPlayed.gameId);
        featured = {
          kind: "library",
          title: lastPlayed.title,
          coverUrl: lastPlayed.coverUrl || null,
          genres: lastPlayed.genre ? [lastPlayed.genre] : [],
          reviewScore: reviewScores,
          synopsis: `Continue playing ΓÇö last played on ${
            lastPlayed.playedPlatform || "your library"
          } with ${lastPlayed.hoursPlayed || 0}h played.`,
          price: null,
          store: lastPlayed.playedPlatform || "MGPL Library",
          url: lastPlayed.storeUrl || "#",
          endAt: null,
        };
      }
    } catch (e) {
      console.warn("Dashboard featured spotlight failed:", e);
      featured = null;
    }

    // ---- fleetSummary -----------------------------------------------------
    let fleetSummary: {
      totalDevices: number;
      activeDevices: Array<{
        deviceId: string;
        deviceName: string;
        cpu: string | null;
        gpu: string | null;
        ramGb: number | null;
        vramGb: number | null;
        tdpWatt: number | null;
      }>;
    } = { totalDevices: 0, activeDevices: [] };
    try {
      const rows = db
        .prepare(
          `
        SELECT deviceId, deviceName, cpuModel, gpuModel, ramGb, vramGb, tdpWatts
        FROM Devices
        WHERE isArchived = 0 OR isArchived IS NULL
        ORDER BY updatedAt DESC
      `,
        )
        .all() as any[];

      const activeDevices = (rows || []).map((r) => ({
        deviceId: r.deviceId,
        deviceName: r.deviceName || "Unnamed Device",
        cpu: r.cpuModel || null,
        gpu: r.gpuModel || null,
        ramGb: r.ramGb ?? null,
        vramGb: r.vramGb ?? null,
        tdpWatt: r.tdpWatts ?? null,
      }));

      fleetSummary = {
        totalDevices: activeDevices.length,
        activeDevices,
      };
    } catch (e) {
      console.warn("Dashboard fleetSummary query failed:", e);
    }

    return res.json({
      success: true,
      summary: {
        lastPlayed,
        featured,
        freebiesAndDeals,
        platformBreakdown,
        moddableGames,
        fleetSummary,
      },
    });
  } catch (err: any) {
    console.error("Dashboard summary error:", err);
    // Sprint 1A (EPICSEC04): never send the raw error message to the client.
    return sendApiError(res, 500, "Failed to load dashboard summary");
  }
});

export default router;
