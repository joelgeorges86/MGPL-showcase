import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { db } from "../db";
import { storeNameForStoreId } from "../services/dealSync";
import { storeUrlForWhitelistedStore } from "../utils/storefrontValidator";
import { parseDealRecord, parseGiveawayRecord, parseDealFeed } from "../utils/dealSchema";
import { fetchWithCircuitBreaker } from "../utils/storefrontCircuitBreaker";
import alertsRouter from "./alerts";
import { optionalAuth, AuthedRequest } from "../middleware/auth";
import { sendApiError } from "../middleware/errorSanitizer";
import { safeArray } from "../utils/ingest";
import {
  bestPriceFor,
  storeUrlFor,
  synthesizeStorePrices,
  ALL_STORES,
} from "../services/wishlistPricing";
import { getPriceHistorySnapshot, allTimeLowFor, lowest30dFor } from "../services/dealAggregator";

const router = Router();

/**
 * Raw SQL replacement for the former `prisma.appGame.findMany({ include: {
 * tracking, ownerships, dlcs } })` calls in this route. Loads the catalog games
 * plus their relations in bulk (one query each) and reassembles the nested
 * camelCase shape the client contract expects ΓÇö no N+1 per game.
 */
function loadDealGames(opts: { limit?: number; includeDlcs?: boolean } = {}) {
  const { limit, includeDlcs } = opts;
  const games = db
    .prepare(
      `SELECT "GameID" AS gameID, "Game Title" AS gameTitle, "cover_url" AS cover_url,
              "Original Game Release Date" AS originalGameReleaseDate, "storeUrl" AS storeUrl
       FROM AppGames${limit ? ` LIMIT ${limit}` : ""}`,
    )
    .all() as any[];

  if (games.length === 0) return [];

  const ids = games.map((g) => g.gameID);
  const placeholders = ids.map(() => "?").join(", ");

  const ownerships = db
    .prepare(
      `SELECT "GameID" AS gameID, "Platform" AS platform, "Store URL" AS storeUrl
       FROM AppOwnership WHERE "GameID" IN (${placeholders})`,
    )
    .all(...ids) as any[];

  const tracking = db
    .prepare(
      `SELECT "GameID" AS gameID, "Want to Play?" AS wantToPlay, "Play Status" AS playStatus,
              "Hours Played" AS hoursPlayed
       FROM AppTracking WHERE "GameID" IN (${placeholders})`,
    )
    .all(...ids) as any[];

  const dlcs = includeDlcs
    ? (db
        .prepare(
          `SELECT "GameID" AS gameID, "DLC_ID" AS dlcId FROM AppDLCs WHERE "GameID" IN (${placeholders})`,
        )
        .all(...ids) as any[])
    : [];

  const ownershipsByGame = new Map<string, any[]>();
  for (const o of ownerships) {
    if (!ownershipsByGame.has(o.gameID)) ownershipsByGame.set(o.gameID, []);
    ownershipsByGame.get(o.gameID)!.push({ platform: o.platform, storeUrl: o.storeUrl });
  }
  const trackingByGame = new Map<string, any>();
  for (const t of tracking) trackingByGame.set(t.gameID, t);
  const dlcsByGame = new Map<string, any[]>();
  for (const d of dlcs) {
    if (!dlcsByGame.has(d.gameID)) dlcsByGame.set(d.gameID, []);
    dlcsByGame.get(d.gameID)!.push({ DLC_ID: d.dlcId });
  }

  return games.map((g) => ({
    gameID: g.gameID,
    gameTitle: g.gameTitle,
    cover_url: g.cover_url ?? null,
    originalGameReleaseDate: g.originalGameReleaseDate ?? null,
    tracking: trackingByGame.get(g.gameID) || null,
    ownerships: ownershipsByGame.get(g.gameID) || [],
    dlcs: includeDlcs ? dlcsByGame.get(g.gameID) || [] : [],
  }));
}

interface NormalizedDeal {
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
  dealID?: string;
  gameID?: string;
  steamAppID?: string;
  // Sprint 1 (EPIC-RADAR-0001): Live Freebies hub metadata.
  worth?: string | null;
  giveawayType?: string | null;
  status?: string | null;
  endDate?: string | null;
  // EPIC-UX-REFINE-0002: rich-media card enrichment surfaced to the client.
  genres?: string[];
  steamScore?: number | null;
  openCriticScore?: number | null;
  compositeScore?: number | null;
  coverUrl?: string | null;
  lowest30d?: number | null;
  description?: string | null;
  storeBadge?: string | null;
}

function getCachedItadDeals(): any[] {
  try {
    const cachePath = path.join(process.cwd(), "scripts", ".cache", "itad_deals.json");
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      // Sprint 1A (EPICSEC01): unified fallback ΓÇö malformed cache payloads
      // resolve to [] instead of leaking nulls downstream.
      return safeArray(data && (data as any).list);
    }
  } catch (err) {
    console.error("Error reading ITAD deals cache:", err);
  }
  return [];
}

function getCachedGiveaways(): any[] {
  try {
    const cachePath = path.join(process.cwd(), "scripts", ".cache", "gamerpower_giveaways.json");
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      // Sprint 1A (EPICSEC01): unified fallback ΓÇö malformed cache payloads
      // resolve to [] instead of leaking nulls downstream.
      return safeArray(data);
    }
  } catch (err) {
    console.error("Error reading GamerPower giveaways cache:", err);
  }
  return [];
}

function sanitizeTitle(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * EPIC-UX-REFINE-0002: resolve genre + review-score + cover-art enrichment for
 * a deal title by matching against the local AppGames/AppReviews catalog so the
 * Deals Hub cards can render thumbnails, genre pills and review score badges
 * deterministically (seeded test data in E2E).
 */
interface DealMeta {
  genres: string[];
  steamScore: number | null;
  openCriticScore: number | null;
  compositeScore: number | null;
  coverUrl: string | null;
}
function enrichDealMeta(title: string): DealMeta {
  let gameId: string | null = null;
  let genre: string | null = null;
  let coverUrl: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT "GameID" AS gameId, "Primary Genre" AS genre, cover_url AS coverUrl
         FROM AppGames WHERE LOWER(TRIM("Game Title")) = LOWER(TRIM(?)) LIMIT 1`,
      )
      .get(title) as { gameId: string; genre: string | null; coverUrl: string | null } | undefined;
    if (row) {
      gameId = row.gameId ?? null;
      genre = row.genre ?? null;
      coverUrl = row.coverUrl || null;
    }
  } catch (e) {
    /* table absent */
  }

  if (!gameId) {
    try {
      const trackRow = db
        .prepare(
          `SELECT t."GameID" AS gameId
           FROM AppTracking t
           WHERE LOWER(TRIM(t."Game Title")) = LOWER(TRIM(?)) LIMIT 1`,
        )
        .get(title) as { gameId: string } | undefined;
      if (trackRow) {
        gameId = trackRow.gameId ?? null;
        try {
          const gameRow = db
            .prepare(
              `SELECT "Primary Genre" AS genre, cover_url AS coverUrl
               FROM AppGames WHERE "GameID" = ? LIMIT 1`,
            )
            .get(gameId) as { genre: string | null; coverUrl: string | null } | undefined;
          genre = gameRow?.genre ?? null;
          coverUrl = gameRow?.coverUrl || null;
        } catch (e) {
          /* game row absent */
        }
      }
    } catch (e) {
      /* tracking absent */
    }
  }

  const genres = (genre || "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 3);

  let steamScore: number | null = null;
  let openCriticScore: number | null = null;
  if (gameId) {
    try {
      const rows = db
        .prepare(
          `SELECT "Review Source" AS source, "Score Numeric" AS scoreNumeric,
                  "Recommendation Percent" AS recPercent
           FROM AppReviews WHERE "GameID" = ?`,
        )
        .all(gameId) as Array<{
        source: string | null;
        scoreNumeric: number | null;
        recPercent: number | null;
      }>;
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
    } catch (e) {
      /* reviews table absent */
    }
  }
  const vals = [steamScore, openCriticScore].filter(
    (x): x is number => x !== null && !Number.isNaN(x),
  );
  return {
    genres,
    steamScore,
    openCriticScore,
    compositeScore: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    coverUrl,
  };
}

/**
 * Sprint 1 (EPIC-DEAL-001): normalize a CheapShark deal through strict schema
 * validation. Unwhitelisted stores, out-of-bounds prices, and malformed /
 * grey-market URLs are dropped (null), and the outbound URL is rebuilt onto an
 * authoritative whitelisted HTTPS domain.
 */
function normalizeCheapSharkRecord(item: any): NormalizedDeal | null {
  if (!item || typeof item.title !== "string" || !item.title.trim()) return null;
  const storeName = item.storeID ? storeNameForStoreId(item.storeID) : "CheapShark";
  const meta = enrichDealMeta(item.title);

  const parsed = parseDealRecord({
    id: item.dealID || `cs-${item.gameID}`,
    dealID: item.dealID,
    gameID: item.gameID,
    steamAppID: item.steamAppID,
    title: item.title,
    store: storeName,
    currentPrice: parseFloat(item.salePrice),
    regularPrice: parseFloat(item.normalPrice),
    discountCut: Math.round(parseFloat(item.savings) || 0),
    storeUrl: item.storeUrl || storeUrlForWhitelistedStore(storeName, item.title),
    boxart: item.thumb,
  });
  if (!parsed) return null;

  return {
    ...parsed,
    genres: meta.genres,
    steamScore: meta.steamScore,
    openCriticScore: meta.openCriticScore,
    compositeScore: meta.compositeScore,
    coverUrl: meta.coverUrl || item.thumb || undefined,
    lowest30d: null,
  };
}

/**
 * Sprint 1 (EPIC-DEAL-001): normalize an ITAD deal through strict schema
 * validation. ITAD's own redirect URLs (itad.link / isthereanydeal.com) are not
 * whitelisted destinations, so the outbound URL is rebuilt onto the store's
 * whitelisted HTTPS domain. Non-whitelisted shops are dropped.
 */
function normalizeItadRecord(item: any): NormalizedDeal | null {
  if (!item || typeof item.title !== "string" || !item.title.trim()) return null;
  const storeName = item.deal?.shop?.name || "Unknown Store";
  const meta = enrichDealMeta(item.title);

  const parsed = parseDealRecord({
    id: item.id || item.slug,
    title: item.title,
    store: storeName,
    currentPrice: item.deal?.price?.amount ?? 0,
    regularPrice: item.deal?.regular?.amount ?? 0,
    discountCut: item.deal?.cut ?? 0,
    storeUrl: storeUrlForWhitelistedStore(storeName, item.title),
    boxart: item.assets?.boxart || item.assets?.banner300,
  });
  if (!parsed) return null;

  return {
    ...parsed,
    historyLow: item.deal?.historyLow?.amount ?? null,
    genres: meta.genres,
    steamScore: meta.steamScore,
    openCriticScore: meta.openCriticScore,
    compositeScore: meta.compositeScore,
    coverUrl: meta.coverUrl || item.assets?.boxart || item.assets?.banner300,
    lowest30d: item.deal?.storeLow?.amount ?? null,
  };
}

/** Sprint 1 (EPIC-DEAL-001): normalize a GamerPower giveaway record. */
function normalizeGiveawayRecord(item: any): NormalizedDeal | null {
  const rawPlatforms = String(item.platforms || "");
  const storeBadge = rawPlatforms.toLowerCase().includes("epic")
    ? "Epic"
    : rawPlatforms.toLowerCase().includes("steam")
      ? "Steam"
      : rawPlatforms.toLowerCase().includes("gog")
        ? "GOG"
        : rawPlatforms.toLowerCase().includes("humble")
          ? "Humble"
          : rawPlatforms.toLowerCase().includes("itch")
            ? "Itch.io"
            : rawPlatforms.toLowerCase().includes("indiegala")
              ? "IndieGala"
              : rawPlatforms.toLowerCase().includes("stove")
                ? "Stove"
                : "Free Giveaway";

  const parsed = parseGiveawayRecord({
    id: `giveaway-${item.id}`,
    title: item.title,
    platforms: item.platforms,
    storeUrl: item.open_giveaway_url || item.gamerpower_url,
    image: item.image,
    thumbnail: item.thumbnail,
    worth: item.worth,
    type: item.type,
    status: item.status,
    endDate: item.end_date && item.end_date !== "N/A" ? item.end_date : null,
    description: item.description,
  });
  if (!parsed) return null;

  return { ...parsed, storeBadge };
}

/**
 * GET /api/deals/search
 * Fetches live deals from CheapShark API (https://www.cheapshark.com/api/1.0/deals).
 * Accepts optional query parameters: title, storeID, lowerPrice, upperPrice
 */
router.get("/search", async (req: Request, res: Response) => {
  const title = req.query.title as string | undefined;
  const storeID = req.query.storeID as string | undefined;
  const lowerPrice = req.query.lowerPrice as string | undefined;
  const upperPrice = req.query.upperPrice as string | undefined;

  const params: Record<string, any> = {};
  if (title) params.title = title;
  if (storeID && storeID !== "all") params.storeID = storeID;
  if (lowerPrice) params.lowerPrice = lowerPrice;
  if (upperPrice) params.upperPrice = upperPrice;

  const result = await fetchWithCircuitBreaker("cheapshark.deals", async () => {
    const response = await axios.get("https://www.cheapshark.com/api/1.0/deals", {
      params,
      timeout: 5000,
    });
    return Array.isArray(response.data) ? response.data : [];
  });

  // Healthy upstream: validate + normalize the raw CheapShark payload.
  if (result.ok) {
    const rawDeals = result.data.map((item: any) => {
      const storeName = item.storeID ? storeNameForStoreId(item.storeID) : "CheapShark";
      return {
        ...item,
        store: storeName,
        currentPrice: parseFloat(item.salePrice),
        regularPrice: parseFloat(item.normalPrice),
        discountCut: Math.round(parseFloat(item.savings) || 0),
        storeUrl: item.storeUrl || storeUrlForWhitelistedStore(storeName, item.title),
      };
    });
    const deals = parseDealFeed(rawDeals, normalizeCheapSharkRecord);
    return res.json({
      success: true,
      count: deals.length,
      deals,
      source: "cheapshark",
      circuitState: result.circuit,
    });
  }

  // Upstream failure: prefer the breaker's cached stale snapshot, then fall back
  // to the local ITAD file cache as a last resort.
  const circuitState = result.circuit;
  if (result.stale) {
    const staleDeals = Array.isArray(result.stale) ? result.stale : [];
    const rawDeals = staleDeals.map((item: any) => {
      const storeName = item.storeID ? storeNameForStoreId(item.storeID) : "CheapShark";
      return {
        ...item,
        store: storeName,
        currentPrice: parseFloat(item.salePrice),
        regularPrice: parseFloat(item.normalPrice),
        discountCut: Math.round(parseFloat(item.savings) || 0),
        storeUrl: item.storeUrl || storeUrlForWhitelistedStore(storeName, item.title),
      };
    });
    const deals = parseDealFeed(rawDeals, normalizeCheapSharkRecord);
    if (deals.length > 0) {
      return res.json({
        success: true,
        count: deals.length,
        deals,
        fallback: true,
        source: "stale-snapshot",
        circuitState,
      });
    }
  }

  const rawItadDeals = getCachedItadDeals();
  const fallbackDeals = parseDealFeed(rawItadDeals, normalizeItadRecord);
  return res.json({
    success: true,
    count: fallbackDeals.length,
    deals: fallbackDeals,
    fallback: true,
    source: "itad-cache",
    circuitState,
  });
});

/**
 * GET /api/deals/historical-low
 * Fetches historical low pricing from CheapShark (https://www.cheapshark.com/api/1.0/games?id=...)
 */
router.get("/historical-low", async (req: Request, res: Response) => {
  try {
    const gameId = (req.query.id || req.query.gameId) as string;
    if (!gameId) {
      return res
        .status(400)
        .json({ success: false, error: "id or gameId query parameter is required" });
    }

    const response = await axios.get(
      `https://www.cheapshark.com/api/1.0/games?id=${encodeURIComponent(gameId)}`,
      {
        timeout: 5000,
      },
    );

    const data: any = response.data || {};
    const cheapestPriceEver = data.cheapestPriceEver || {};

    res.json({
      success: true,
      gameId,
      title: data.info?.title || "",
      historicalLow: parseFloat(cheapestPriceEver.price) || 0,
      historicalLowDate: cheapestPriceEver.date
        ? new Date(cheapestPriceEver.date * 1000).toISOString()
        : null,
      deals: data.deals || [],
    });
  } catch (err: any) {
    console.error("CheapShark Historical Low Error:", err?.message || err);

    res.json({
      success: true,
      gameId: req.query.id || req.query.gameId,
      historicalLow: 0,
      deals: [],
      error: "Failed to fetch historical low from CheapShark",
    });
  }
});

/**
 * POST /api/deals/wishlist/sync
 *
 * Accepts array of games or Steam AppID list, syncs items into AppDealsWishlist, and checks current sale prices.
 */
router.post("/wishlist/sync", async (req: Request, res: Response) => {
  try {
    const { items, steamAppIds } = req.body || {};

    let syncedItems: Array<{ steamAppId?: string; gameTitle: string; targetPrice?: number }> = [];

    if (Array.isArray(items) && items.length > 0) {
      syncedItems = items.map((item: any) =>
        typeof item === "string" ? { gameTitle: item } : item,
      );
    } else if (Array.isArray(steamAppIds) && steamAppIds.length > 0) {
      syncedItems = steamAppIds.map((appId: any) => ({
        steamAppId: String(appId),
        gameTitle: `Steam App ${appId}`,
      }));
    } else {
      // Auto-populate from AppGames wishlist or unowned/wantToPlay games
      const appGames = loadDealGames({ limit: 50 });

      syncedItems = appGames
        .filter(
          (g: any) =>
            !g.ownerships ||
            g.ownerships.length === 0 ||
            g.tracking?.wantToPlay?.toLowerCase() === "yes",
        )
        .map((g: any) => ({
          steamAppId: g.gameID?.startsWith("STEAM_") ? g.gameID.replace("STEAM_", "") : undefined,
          gameTitle: g.gameTitle || "Unknown Title",
        }));
    }

    const upsertStmt = db.prepare(`
      INSERT INTO AppDealsWishlist (steamAppId, gameTitle, targetPrice)
      VALUES (?, ?, ?)
      ON CONFLICT(gameTitle) DO UPDATE SET
        steamAppId = COALESCE(excluded.steamAppId, AppDealsWishlist.steamAppId),
        targetPrice = COALESCE(excluded.targetPrice, AppDealsWishlist.targetPrice)
    `);

    db.transaction(() => {
      for (const item of syncedItems) {
        if (item.gameTitle) {
          upsertStmt.run(item.steamAppId || null, item.gameTitle, item.targetPrice ?? 0);
        }
      }
    })();

    const allWishlist = db.prepare("SELECT * FROM AppDealsWishlist").all();

    res.json({
      success: true,
      syncedCount: syncedItems.length,
      wishlist: allWishlist,
    });
  } catch (err: any) {
    console.error("Error in /api/deals/wishlist/sync:", err?.message || err);
    sendApiError(res, 500, "Failed to sync wishlist");
  }
});

// Sprint 2 (FEAT-MULTITENANT): Price-alert CRUD has moved to the dedicated
// user-scoped alerts router (src/routes/alerts.ts). The legacy /api/deals/alerts
// URLs are preserved via nested mounting so the existing client keeps working
// while every alert row is now isolated per authenticated user (401 for guests).
router.use("/alerts", alertsRouter);

/**
 * GET /api/deals/history/:gameId
 * Returns price history points, MSRP, the 30-day lowest verified price, and
 * the all-time low for sparkline + EU Omnibus Directive baseline rendering.
 */
router.get("/history/:gameId", async (req: Request, res: Response) => {
  try {
    const gameId = String(req.params.gameId || "").trim();
    const snapshot = getPriceHistorySnapshot(gameId, 24, 48);
    const points = snapshot.points;
    const historicalLow = allTimeLowFor(gameId);
    const lowestPrice30d = lowest30dFor(gameId);
    const msrp = points.length ? Math.max(...points.map((point) => point.price)) : null;

    res.json({
      success: true,
      gameId,
      msrp,
      lowestPrice30d,
      historicalLow,
      points,
      availability: snapshot.availability,
      latestObservedAt: snapshot.latestObservedAt,
      coveredPeriod: snapshot.coveredPeriod,
      freshnessBoundDays: snapshot.freshnessBoundDays,
    });
  } catch (err: any) {
    console.error("Error in GET /api/deals/history/:gameId:", err?.message || err);
    sendApiError(res, 500, "Failed to fetch price history");
  }
});

/**
 * GET /api/deals/by-store
 * Legacy / store-filter route
 */
router.get("/by-store", (req: Request, res: Response) => {
  const storeQuery = ((req.query.store as string) || "all").toLowerCase();
  const rawItadDeals = getCachedItadDeals();
  const rawGiveaways = getCachedGiveaways();

  let normalized: NormalizedDeal[];

  const itadNormalized: NormalizedDeal[] = parseDealFeed(rawItadDeals, normalizeItadRecord);

  const giveawayNormalized: NormalizedDeal[] = parseDealFeed(rawGiveaways, normalizeGiveawayRecord);

  if (storeQuery === "giveaways") {
    normalized = giveawayNormalized;
  } else if (storeQuery === "all") {
    normalized = [...itadNormalized, ...giveawayNormalized];
  } else {
    normalized = itadNormalized.filter((deal) => {
      const s = deal.store.toLowerCase();
      if (storeQuery === "humble") return s.includes("humble");
      if (storeQuery === "epic") return s.includes("epic");
      if (storeQuery === "steam") return s.includes("steam");
      if (storeQuery === "gog") return s.includes("gog");
      return s.includes(storeQuery);
    });
  }

  res.json({
    success: true,
    store: storeQuery,
    count: normalized.length,
    deals: normalized,
  });
});

/**
 * GET /api/wishlist/on-sale
 */
router.get("/on-sale", async (_req: Request, res: Response) => {
  try {
    const games = loadDealGames();

    const wishlistGames = games.filter((g: any) => {
      const unowned = !g.ownerships || g.ownerships.length === 0;
      const wantToPlay = g.tracking?.wantToPlay?.toLowerCase() === "yes";
      const notStarted = g.tracking?.playStatus?.toLowerCase() === "not started";
      return unowned || wantToPlay || notStarted;
    });

    const itadPool = parseDealFeed(getCachedItadDeals(), normalizeItadRecord);
    const giveawayPool = parseDealFeed(getCachedGiveaways(), normalizeGiveawayRecord);

    const matches: any[] = [];

    wishlistGames.forEach((game: any) => {
      if (!game.gameTitle) return;
      const cleanGameTitle = sanitizeTitle(game.gameTitle);

      const matchingItad = itadPool.find((deal) => {
        if (!deal.title) return false;
        const cleanDealTitle = sanitizeTitle(deal.title);
        return cleanDealTitle.includes(cleanGameTitle) || cleanGameTitle.includes(cleanDealTitle);
      });

      if (matchingItad) {
        matches.push({
          gameID: game.gameID,
          title: game.gameTitle,
          store: matchingItad.store,
          currentPrice: matchingItad.currentPrice,
          regularPrice: matchingItad.regularPrice,
          discountCut: matchingItad.discountCut,
          historyLow: matchingItad.historyLow ?? undefined,
          storeUrl: matchingItad.storeUrl,
          boxart: matchingItad.boxart || game.cover_url,
          source: "itad",
        });
      } else {
        const matchingGiveaway = giveawayPool.find((g) => {
          if (!g.title) return false;
          const cleanGiveawayTitle = sanitizeTitle(g.title);
          return (
            cleanGiveawayTitle.includes(cleanGameTitle) ||
            cleanGameTitle.includes(cleanGiveawayTitle)
          );
        });

        if (matchingGiveaway) {
          matches.push({
            gameID: game.gameID,
            title: game.gameTitle,
            store: matchingGiveaway.store,
            currentPrice: matchingGiveaway.currentPrice,
            regularPrice: matchingGiveaway.regularPrice,
            discountCut: matchingGiveaway.discountCut,
            storeUrl: matchingGiveaway.storeUrl,
            boxart: matchingGiveaway.boxart || game.cover_url,
            source: "gamerpower",
          });
        }
      }
    });

    res.json({
      success: true,
      count: matches.length,
      wishlistDeals: matches,
    });
  } catch (err: any) {
    console.error("Error in /api/wishlist/on-sale:", err);
    sendApiError(res, 500, "Failed to fetch wishlist deals", undefined, { includeSuccess: false });
  }
});

/**
 * GET /api/releases/this-week
 */
router.get("/releases/this-week", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    const games = loadDealGames({ limit: 20, includeDlcs: true });

    const thisWeekReleases = games.map((g: any) => {
      let platforms = ["PC", "PS5", "Xbox Series X"];
      if (g.ownerships && g.ownerships.length > 0) {
        const ownedPlatforms = g.ownerships.map((o: any) => o.platform).filter(Boolean);
        if (ownedPlatforms.length > 0) {
          platforms = Array.from(new Set(ownedPlatforms));
        }
      }

      const releaseDate = g.originalGameReleaseDate || now.toISOString().split("T")[0];
      const hasDlc = g.dlcs && g.dlcs.length > 0;
      const category = hasDlc ? "DLC/Expansion" : "Full Game";

      return {
        gameID: g.gameID,
        title: g.gameTitle || "Unknown Title",
        publisher: g.publisher || "Unknown Publisher",
        genre: g.primaryGenre || "Gaming",
        coverUrl: g.cover_url || g.headerImage,
        releaseDate,
        platforms,
        category,
        isDlc: hasDlc,
      };
    });

    res.json({
      success: true,
      startDate: startOfWeek.toISOString().split("T")[0],
      endDate: endOfWeek.toISOString().split("T")[0],
      count: thisWeekReleases.length,
      releases: thisWeekReleases,
    });
  } catch (err: any) {
    console.error("Error in /api/releases/this-week:", err);
    sendApiError(res, 500, "Failed to fetch release radar");
  }
});

/**
 * Round a numeric value to two decimal places (currency-safe).
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sprint 2 (EPIC-DEAL-001): deterministic discounted-DLC synthesis for a base
 * game. Mirrors the wishlist DLC catalog pattern (cycle taxonomy + stable hash)
 * so DLC sales render without any live network dependency.
 */
const RADAR_DLC_TYPES = ["Expansion", "DLC", "Soundtrack", "Season Pass"] as const;

function synthesizeDlcSales(
  gameId: string,
  title: string,
): Array<{
  baseGameId: string;
  baseGameTitle: string;
  id: string;
  name: string;
  type: string;
  bestPrice: number;
  regularPrice: number;
  discountPercent: number;
  bestStore: string;
  url: string;
}> {
  let hash = 0;
  const seed = gameId || title || "unknown";
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const count = 2 + (Math.abs(hash) % 4); // 2-5 DLCs
  const base = title || gameId || "Game";
  const dlcs: Array<{
    baseGameId: string;
    baseGameTitle: string;
    id: string;
    name: string;
    type: string;
    bestPrice: number;
    regularPrice: number;
    discountPercent: number;
    bestStore: string;
    url: string;
  }> = [];

  for (let i = 0; i < count; i++) {
    const type = RADAR_DLC_TYPES[i % RADAR_DLC_TYPES.length];
    const storeName = ALL_STORES[(Math.abs(hash) + i * 13) % ALL_STORES.length];
    const regularPrice = round2(9.99 + ((Math.abs(hash) + i * 37) % 30));
    const discountPercent = (Math.abs(hash) + i * 29) % 50;
    const bestPrice = round2(regularPrice * (1 - discountPercent / 100));
    dlcs.push({
      baseGameId: gameId,
      baseGameTitle: base,
      id: `dlc-${gameId}-${i + 1}`,
      name: `${base} ΓÇö ${type} ${i + 1}`,
      type,
      bestPrice,
      regularPrice,
      discountPercent,
      bestStore: storeName,
      url: storeUrlFor(storeName, `${base} ${type} ${i + 1}`),
    });
  }
  return dlcs;
}

/**
 * GET /api/deals/radar
 * Sprint 2 (EPIC-DEAL-001): upcoming releases sorted chronologically with
 * days-remaining countdown metadata. Public read (no auth required).
 */
router.get("/radar", (_req: Request, res: Response) => {
  try {
    const rows = db
      .prepare("SELECT * FROM release_radar ORDER BY releaseDate ASC, title ASC")
      .all() as any[];
    const now = Date.now();
    const releases = rows.map((r: any) => {
      const releaseMs = new Date(`${r.releaseDate}T00:00:00Z`).getTime();
      const daysUntil = Number.isNaN(releaseMs)
        ? 0
        : Math.max(0, Math.ceil((releaseMs - now) / 86400000));
      return {
        releaseId: r.releaseId,
        title: r.title,
        releaseDate: r.releaseDate,
        platform: r.platform,
        publisher: r.publisher,
        priceUsd: r.priceUsd,
        preorderUrl: r.preorderUrl,
        bannerUrl: r.bannerUrl,
        isVerified: Number(r.isVerified) === 1,
        daysUntil,
      };
    });
    res.json({ success: true, count: releases.length, releases });
  } catch (err: any) {
    console.error("Error in GET /api/deals/radar:", err?.message || err);
    sendApiError(res, 500, "Failed to fetch release radar");
  }
});

/**
 * GET /api/deals/wishlist-drops
 * Sprint 2 (EPIC-DEAL-001): discounted wishlist items with savings vs. MSRP and
 * a 30-day low. Authenticated users see their AppWishlist rows; guests fall
 * back to the legacy public AppDealsWishlist catalog.
 */
router.get("/wishlist-drops", optionalAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user?.userId;
    let rows: any[] = [];
    if (userId) {
      rows = db
        .prepare("SELECT * FROM AppWishlist WHERE userId = ? ORDER BY createdAt DESC")
        .all(userId) as any[];
    } else {
      rows = db.prepare("SELECT * FROM AppDealsWishlist ORDER BY createdAt DESC").all() as any[];
    }

    const drops = rows.map((row: any) => {
      const title = row.title || row.gameTitle || "Unknown Game";
      const gameId = row.gameId || row.steamAppId || row.gameTitle || title;
      const pricing = bestPriceFor(gameId);
      const offers = synthesizeStorePrices(gameId);
      const bestOffer = offers.reduce(
        (min, o) => (o.currentPrice < min.currentPrice ? o : min),
        offers[0],
      );
      const msrp = Number(bestOffer?.regularPrice) || 0;
      const currentPrice = Number(pricing.currentBestPrice) || 0;
      const historicalLow = Number(pricing.historicalLow) || 0;
      const savingsPct =
        msrp > 0 ? Math.max(0, Math.round(((msrp - currentPrice) / msrp) * 100)) : 0;
      const savingsAmount = msrp > 0 ? Math.max(0, round2(msrp - currentPrice)) : 0;

      return {
        gameId,
        title,
        currentPrice: round2(currentPrice),
        msrp: round2(msrp),
        savingsPct,
        savingsAmount,
        historicalLow: round2(historicalLow),
        lowest30d: round2(historicalLow),
        bestStore: pricing.bestStore,
        bestStoreType: pricing.bestStoreType,
        storeUrl: storeUrlFor(pricing.bestStore, title),
        source: userId ? "wishlist" : "public-wishlist",
      };
    });

    res.json({ success: true, count: drops.length, drops });
  } catch (err: any) {
    console.error("Error in GET /api/deals/wishlist-drops:", err?.message || err);
    sendApiError(res, 500, "Failed to fetch wishlist drops");
  }
});

/**
 * GET /api/deals/dlc-sales
 * Sprint 2 (EPIC-DEAL-001): discounted DLC for base games in the user's
 * wishlist (auth) or the local AppGames library (guest mode).
 */
router.get("/dlc-sales", optionalAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user?.userId;
    let baseGames: Array<{ gameId: string; title: string }> = [];

    if (userId) {
      baseGames = db
        .prepare("SELECT gameId, title FROM AppWishlist WHERE userId = ?")
        .all(userId) as Array<{ gameId: string; title: string }>;
    } else {
      baseGames = db
        .prepare(
          'SELECT "GameID" AS gameId, "Game Title" AS title FROM AppGames WHERE "Game Title" IS NOT NULL LIMIT 8',
        )
        .all() as Array<{ gameId: string; title: string }>;
    }

    const dlcSales: Array<{
      baseGameId: string;
      baseGameTitle: string;
      id: string;
      name: string;
      type: string;
      bestPrice: number;
      regularPrice: number;
      discountPercent: number;
      bestStore: string;
      url: string;
    }> = [];

    for (const bg of baseGames) {
      dlcSales.push(...synthesizeDlcSales(bg.gameId, bg.title));
    }

    res.json({ success: true, count: dlcSales.length, dlcSales });
  } catch (err: any) {
    console.error("Error in GET /api/deals/dlc-sales:", err?.message || err);
    sendApiError(res, 500, "Failed to fetch DLC sales");
  }
});

export default router;
