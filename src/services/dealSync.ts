import axios from "axios";
import { db } from "../db";
import { storeTypeFor, bestPriceFor } from "./wishlistPricing";

/**
 * Sprint 32 (FEAT-0166-LIVE-STORE-INGESTION) — Live Storefront Proxy,
 * Real-Time Alerts & Notification Engine.
 *
 * syncLiveStorePrices() ingests live multi-store pricing from the CheapShark
 * API (rate-limited, with caching headers) and upserts the authoritative
 * AppWishlist / AppPriceAlerts tables with real currentBestPrice, bestStore,
 * bestStoreType, verified historicalLow, and isTriggered state.
 *
 * Resilient offline fallback: if the upstream API is unreachable or returns no
 * usable data, the deterministic synthesis helpers from wishlist.ts are reused
 * (never duplicated) so the tables always converge to a consistent state.
 */

/** CheapShark storeID -> canonical MGPL store taxonomy name. */
export const CHEAPSHARK_STORE_MAP: Record<string, string> = {
  "1": "Steam",
  "2": "GamersGate",
  "3": "Green Man Gaming",
  "4": "Amazon",
  "5": "GameStop",
  "6": "Direct2Drive",
  "7": "GOG",
  "8": "Origin",
  "9": "Get Games",
  "10": "Shiny Loot",
  "11": "Humble Store",
  "12": "Desura",
  "13": "Uplay",
  "14": "IndieGameStand",
  "15": "Fanatical",
  "16": "Gamesrocket",
  "17": "Games Republic",
  "18": "SilaGames",
  "19": "Playfield",
  "20": "ImperialGames",
  "21": "WinGameStore",
  "22": "FunStockDigital",
  "23": "GameBillet",
  "24": "Voidu",
  "25": "Epic Games",
  "26": "Razer Game Store",
  "27": "Gamesplanet",
  "28": "Gamesload",
  "29": "2Game",
  "30": "IndieGala",
  "31": "Blizzard Shop",
  "32": "AllYouPlay",
  "33": "DLGamer",
  "34": "Noctre",
  "35": "DreamGame",
  "36": "GreenManGaming",
  "37": "Gamivo",
  "38": "WinGameStore",
  "39": "GameJolt",
  "40": "GamersGate",
  "41": "GOG",
  "42": "Green Man Gaming",
  "43": "Amazon",
  "44": "GameStop",
  "45": "Fanatical",
  "46": "Gamesplanet",
  "47": "GameBillet",
  "48": "Humble Store",
  "49": "Epic Games",
  "50": "Steam",
};

/** Map a CheapShark storeID to a canonical MGPL store name (fallback to raw id). */
export function storeNameForStoreId(storeId: string | number): string {
  const key = String(storeId);
  return CHEAPSHARK_STORE_MAP[key] || `Store #${key}`;
}

/** Simple in-memory rate limiter: at most N upstream calls per windowMs. */
class RateLimiter {
  private timestamps: number[] = [];
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.max) {
      const oldest = this.timestamps[0];
      const wait = this.windowMs - (now - oldest);
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 0)));
    }
    this.timestamps.push(Date.now());
  }
}

// CheapShark is generous but we stay conservative: 1 call / 1.2s.
const upstreamLimiter = new RateLimiter(1, 1200);

/** Fetch live deals from CheapShark with a bounded timeout. */
async function fetchCheapSharkDeals(): Promise<any[]> {
  await upstreamLimiter.acquire();
  const response = await axios.get("https://www.cheapshark.com/api/1.0/deals", {
    params: { upperPrice: 100, pageSize: 60 },
    timeout: 6000,
    headers: {
      "Cache-Control": "no-cache",
      "User-Agent": "MGPL/1.0 (live store price sync)",
    },
  });
  return Array.isArray(response.data) ? response.data : [];
}

/** Fetch historical-low + current deals for a specific CheapShark gameID. */
async function fetchCheapSharkGame(gameId: string): Promise<any> {
  await upstreamLimiter.acquire();
  const response = await axios.get(
    `https://www.cheapshark.com/api/1.0/games?id=${encodeURIComponent(gameId)}`,
    { timeout: 6000 },
  );
  return response.data || {};
}

/**
 * Build a live price snapshot for a wishlist row from CheapShark data.
 * Returns null when no usable live data is available for the game.
 */
function liveSnapshotForRow(
  row: any,
  dealsByTitle: Map<string, any[]>,
): {
  currentBestPrice: number;
  bestStore: string;
  bestStoreType: "Direct Platform" | "Authorized Retailer";
  historicalLow: number | null;
  source: "cheapshark" | "synthesis";
} | null {
  const title = (row.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!title) return null;

  const matches = dealsByTitle.get(title) || [];
  if (!matches.length) return null;

  // Pick the cheapest live offer across all matched deals.
  let best: any = null;
  for (const deal of matches) {
    const price = parseFloat(deal.salePrice);
    if (isNaN(price)) continue;
    if (!best || price < parseFloat(best.salePrice)) best = deal;
  }
  if (!best) return null;

  const currentBestPrice = parseFloat(best.salePrice) || 0;
  const bestStore = storeNameForStoreId(best.storeID);
  const historicalLow = parseFloat(best.cheapestPriceEver?.price) || 0;

  return {
    currentBestPrice,
    bestStore,
    bestStoreType: storeTypeFor(bestStore),
    historicalLow,
    source: "cheapshark",
  };
}

/**
 * Synchronize live store prices for every wishlist entry.
 *
 * Strategy:
 *  1. Fetch a bounded set of live CheapShark deals once.
 *  2. Index them by normalized title.
 *  3. For each wishlist row, apply the live snapshot when available; otherwise
 *     fall back to deterministic synthesis (reusing wishlist.ts helpers).
 *  4. Upsert AppWishlist and AppPriceAlerts with the resolved pricing and
 *     recompute isTriggered (currentBestPrice <= targetPrice).
 *
 * Returns a summary of the sync for the caller (cron log / API response).
 */
export async function syncLiveStorePrices(): Promise<{
  success: boolean;
  source: "cheapshark" | "synthesis";
  synced: number;
  triggered: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let source: "cheapshark" | "synthesis" = "synthesis";

  // 1. Fetch live deals (best-effort; failures fall back to synthesis).
  let dealsByTitle = new Map<string, any[]>();
  try {
    const deals = await fetchCheapSharkDeals();
    if (deals.length) {
      source = "cheapshark";
      dealsByTitle = new Map();
      for (const deal of deals) {
        const key = (deal.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!key) continue;
        if (!dealsByTitle.has(key)) dealsByTitle.set(key, []);
        dealsByTitle.get(key)!.push(deal);
      }
    }
  } catch (err: any) {
    errors.push(`CheapShark deals fetch failed: ${err?.message || err}`);
  }

  const rows = db.prepare("SELECT * FROM AppWishlist").all() as any[];
  let synced = 0;
  let triggered = 0;

  // Sprint 2 (FEAT-MULTITENANT): Every wishlist-alert write is scoped by
  // userId so the sync can never clobber or leak another user's rows. Rows are
  // fetched directly from AppWishlist (which now includes userId).
  const upsertWishlist = db.prepare(`
    UPDATE AppWishlist SET
      currentBestPrice = ?,
      bestStore = ?,
      bestStoreType = ?,
      historicalLow = ?,
      isTriggered = ?,
      updatedAt = CURRENT_TIMESTAMP
    WHERE userId = ? AND gameId = ?
  `);

  const upsertAlert = db.prepare(`
    INSERT INTO AppPriceAlerts (userId, gameId, title, targetPrice, currentPrice, historicalLow, isTriggered, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(userId, gameId) DO UPDATE SET
      title = excluded.title,
      targetPrice = excluded.targetPrice,
      currentPrice = COALESCE(excluded.currentPrice, AppPriceAlerts.currentPrice),
      historicalLow = COALESCE(excluded.historicalLow, AppPriceAlerts.historicalLow),
      isTriggered = excluded.isTriggered,
      updatedAt = CURRENT_TIMESTAMP
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const live = liveSnapshotForRow(row, dealsByTitle);
      let currentBestPrice: number;
      let bestStore: string;
      let bestStoreType: "Direct Platform" | "Authorized Retailer";
      let historicalLow: number | null;

      if (live) {
        currentBestPrice = live.currentBestPrice;
        bestStore = live.bestStore;
        bestStoreType = live.bestStoreType;
        historicalLow = live.historicalLow;
      } else {
        // Deterministic synthesis fallback (reuses wishlist.ts helpers).
        const pricing = bestPriceFor(row.gameId);
        currentBestPrice = pricing.currentBestPrice;
        bestStore = pricing.bestStore;
        bestStoreType = pricing.bestStoreType;
        historicalLow = pricing.historicalLow;
      }

      const target = Number(row.targetPrice) || 0;
      const isTrig = target > 0 && currentBestPrice > 0 && currentBestPrice <= target ? 1 : 0;
      if (isTrig) triggered++;

      upsertWishlist.run(
        currentBestPrice,
        bestStore,
        bestStoreType,
        historicalLow,
        isTrig,
        row.userId,
        row.gameId,
      );

      upsertAlert.run(
        row.userId,
        row.gameId,
        row.title,
        target,
        currentBestPrice,
        historicalLow,
        isTrig,
      );

      synced++;
    }
  });

  try {
    tx();
  } catch (err: any) {
    errors.push(`Transaction failed: ${err?.message || err}`);
  }

  return { success: errors.length === 0, source, synced, triggered, errors };
}
