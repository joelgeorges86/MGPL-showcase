/**
 * Sprint 2 (WUD-2.2 / EPIC-02) — Advanced Deal Arbitrage & Price History
 * Automation.
 *
 * Ingests multi-source deal feeds (IsThereAnyDeal, GG.deals, Deku Deals) using
 * safeFetchJSONWithBackoff (exponential backoff + per-source rate limiting) and
 * the strict `dealSchema` validators. Every record passes through
 * `parseDealRecord`, which enforces the verified storefront whitelist, rejects
 * grey-market domains (G2A, Kinguin, CDKeys, ...) by default, and rejects
 * out-of-bounds prices (negative or > $999.99).
 *
 * Accepted deals are persisted as local price-history baseline points
 * (AppDealPriceHistory) so the client can render 24-month pure-SVG sparklines,
 * 30-day-low detection, and verified all-time-low badges. Wishlist / price
 * alert rows are updated with the resolved best price + trigger state.
 */

import { db } from "../db";
import { parseDealRecord, sanitizePrice } from "../utils/dealSchema";
import {
  canonicalStoreName,
  isWhitelistedStoreName,
  storeUrlForWhitelistedStore,
} from "../utils/storefrontValidator";
import { safeFetchJSONWithBackoff, RateLimiter } from "./adapters/request";
import { safeArray, safeHydrate } from "../utils/ingest";
import { storeTypeFor } from "./wishlistPricing";
import { shutdownCheckpoint } from "../lib/shutdown";

const sourceLimiter = new RateLimiter(2);

export type DealSource = "itad" | "ggdeals" | "dekudeals";

export interface AggregatedDeal {
  id: string;
  title: string;
  store: string;
  currentPrice: number;
  regularPrice: number;
  discountCut: number;
  storeUrl: string;
  boxart?: string;
  gameID?: string;
  dealID?: string;
  steamAppID?: string;
  historyLow?: number;
  lowest30d?: number;
  source: DealSource;
}

/** Canonical whitelisted store display name, or null when unauthorized. */
function resolveStore(raw: string): string | null {
  const canonical = canonicalStoreName(String(raw || "").trim());
  return isWhitelistedStoreName(canonical) ? canonical : null;
}

/** Build an AggregatedDeal from raw source fields via the strict schema. */
function buildDeal(
  source: DealSource,
  raw: {
    title: string;
    store: string;
    currentPrice: number;
    regularPrice?: number;
    discountCut?: number;
    historyLow?: number;
    boxart?: string;
    gameID?: string;
    dealID?: string;
    steamAppID?: string;
  },
): AggregatedDeal | null {
  const store = resolveStore(raw.store);
  if (!store) return null;
  const storeUrl = storeUrlForWhitelistedStore(store, raw.title);

  const parsed = parseDealRecord({
    title: raw.title,
    store,
    currentPrice: raw.currentPrice,
    regularPrice: raw.regularPrice ?? raw.currentPrice,
    discountCut: raw.discountCut ?? 0,
    storeUrl,
    boxart: raw.boxart,
    gameID: raw.gameID,
    dealID: raw.dealID,
    steamAppID: raw.steamAppID,
  });
  if (!parsed) return null;

  const historyLow = sanitizePrice(raw.historyLow);
  return {
    ...parsed,
    storeUrl,
    historyLow: historyLow ?? undefined,
    source,
  };
}

function itadEndpoint(): string {
  return "https://api.isthereanydeal.com/deals/v2?country=US&limit=60";
}

/** IsThereAnyDeal: `{ list: [{ title, deal: { shop, price, regular, cut, historyLow } }] }`. */
async function fetchItadDeals(): Promise<AggregatedDeal[]> {
  const apiKey = process.env.ITAD_API_KEY || "";
  const init: RequestInit | undefined = apiKey
    ? { headers: { "ITAD-API-Key": apiKey } }
    : undefined;
  await sourceLimiter.acquire();
  const data = await safeFetchJSONWithBackoff<any>(itadEndpoint(), { attempts: 3 }, null, init);
  const list = safeArray<any>(safeHydrate<any>(data)?.list);
  const out: AggregatedDeal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const deal = safeHydrate<any>(item.deal);
    const shop = safeHydrate<any>(deal.shop);
    const price = safeHydrate<any>(deal.price);
    const regular = safeHydrate<any>(deal.regular);
    const low = safeHydrate<any>(deal.historyLow);
    const built = buildDeal("itad", {
      title: String(item.title || "").trim(),
      store: String(shop.name || "").trim(),
      currentPrice: Number(price.amount),
      regularPrice: Number(regular.amount),
      discountCut: Number(deal.cut),
      historyLow: Number(low.amount),
      boxart: safeHydrate<any>(item.assets)?.boxart || "",
      gameID: String(item.slug || ""),
      dealID: String(item.id || ""),
    });
    if (built) out.push(built);
  }
  return out;
}

function ggDealsEndpoint(): string {
  return "https://api.gg.deals/v1/deals/active/?country=US&limit=60";
}

/** GG.deals: `{ deals: [{ name, price, msrp, discount, shop }] }`. */
async function fetchGgDeals(): Promise<AggregatedDeal[]> {
  await sourceLimiter.acquire();
  const data = await safeFetchJSONWithBackoff<any>(ggDealsEndpoint(), { attempts: 3 }, null);
  const list = safeArray<any>(safeHydrate<any>(data)?.deals || safeHydrate<any>(data)?.results);
  const out: AggregatedDeal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const shop = safeHydrate<any>(item.shop);
    const built = buildDeal("ggdeals", {
      title: String(item.name || item.title || "").trim(),
      store: String(shop.name || item.store || "").trim(),
      currentPrice: Number(item.price ?? item.currentPrice),
      regularPrice: Number(item.msrp ?? item.regularPrice),
      discountCut: Number(item.discount ?? item.discountPercent),
      historyLow: Number(item.lowestPrice ?? item.historyLow),
      boxart: String(item.image || item.thumb || ""),
      gameID: String(item.gameId || item.slug || ""),
      dealID: String(item.id || ""),
      steamAppID: String(item.steamAppId || item.steamAppID || ""),
    });
    if (built) out.push(built);
  }
  return out;
}

function dekuDealsEndpoint(): string {
  return "https://api.dekudeals.com/api/v1/deals/active";
}

/** Deku Deals: `{ deals: [{ name, price, msrp, discount, store }] }`. */
async function fetchDekuDeals(): Promise<AggregatedDeal[]> {
  await sourceLimiter.acquire();
  const data = await safeFetchJSONWithBackoff<any>(dekuDealsEndpoint(), { attempts: 3 }, null);
  const list = safeArray<any>(safeHydrate<any>(data)?.deals || safeHydrate<any>(data)?.results);
  const out: AggregatedDeal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const built = buildDeal("dekudeals", {
      title: String(item.name || item.title || "").trim(),
      store: String(item.store || item.shop || "").trim(),
      currentPrice: Number(item.price ?? item.currentPrice),
      regularPrice: Number(item.msrp ?? item.regularPrice),
      discountCut: Number(item.discount ?? item.discountPercent),
      historyLow: Number(item.lowestPrice ?? item.historyLow),
      boxart: String(item.image || item.thumb || ""),
      gameID: String(item.gameId || item.slug || ""),
      dealID: String(item.id || ""),
      steamAppID: String(item.steamAppId || item.steamAppID || ""),
    });
    if (built) out.push(built);
  }
  return out;
}

/** gameId fallback key for a deal (used for history persistence). */
function dealGameKey(deal: AggregatedDeal): string {
  return deal.gameID || deal.steamAppID || normTitleKey(deal.title);
}

function normTitleKey(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Persist a price-history baseline point for a deal. Idempotent per
 * (gameId, store, day) so repeated ingests never duplicate history rows.
 */
export function recordPricePoint(
  gameId: string,
  title: string,
  store: string,
  price: number,
): void {
  const safePrice = sanitizePrice(price);
  if (safePrice === null) return;
  const key = String(gameId || "").trim();
  if (!key) return;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO AppDealPriceHistory (gameId, title, store, price, recordedAt)
       VALUES (?, ?, ?, ?, date('now'))`,
    ).run(key, String(title || "").slice(0, 300), store, safePrice);
  } catch (err: any) {
    console.error("recordPricePoint failed:", err?.message || err);
  }
}

/** Lowest observed price in the last 30 days (null when no history yet). */
export function lowest30dFor(gameId: string): number | null {
  try {
    const row = db
      .prepare(
        `SELECT MIN(price) AS low FROM AppDealPriceHistory
         WHERE gameId = ? AND store != 'Synthesis' AND recordedAt >= date('now', '-30 days')`,
      )
      .get(gameId) as { low: number | null } | undefined;
    return row && row.low !== null && Number.isFinite(Number(row.low)) ? Number(row.low) : null;
  } catch {
    return null;
  }
}

/** Verified all-time low from the local history baseline (null when none). */
export function allTimeLowFor(gameId: string): number | null {
  try {
    const row = db
      .prepare(
        `SELECT MIN(price) AS low FROM AppDealPriceHistory WHERE gameId = ? AND store != 'Synthesis'`,
      )
      .get(gameId) as { low: number | null } | undefined;
    return row && row.low !== null && Number.isFinite(Number(row.low)) ? Number(row.low) : null;
  } catch {
    return null;
  }
}

export interface HistoryPoint {
  date: string;
  price: number;
  store: string;
}

export type HistoryAvailability = "real" | "stale" | "synthetic-only" | "missing";

export interface PriceHistorySnapshot {
  points: HistoryPoint[];
  availability: HistoryAvailability;
  latestObservedAt: string | null;
  coveredPeriod: { from: string; to: string } | null;
  freshnessBoundDays: number;
}

export const HISTORY_FRESHNESS_BOUND_DAYS = 30;

function downsampleHistory(rows: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (rows.length <= maxPoints) return rows.reverse();
  const bucketSize = Math.ceil(rows.length / maxPoints);
  const out: HistoryPoint[] = [];
  for (let i = 0; i < rows.length; i += bucketSize) {
    const bucket = rows.slice(i, i + bucketSize);
    const min = bucket.reduce((m, r) => (r.price < m ? r.price : m), bucket[0].price);
    out.push({ date: bucket[0].date, price: min, store: bucket[0].store });
  }
  return out.reverse();
}

/**
 * Return observed history plus an explicit freshness/availability contract.
 * Synthetic baseline rows are excluded unless includeSynthetic is explicitly
 * true, which is reserved for the existing offline/demo arbitrage feed.
 */
export function getPriceHistorySnapshot(
  gameId: string,
  months = 24,
  maxPoints = 48,
  includeSynthetic = false,
): PriceHistorySnapshot {
  const freshnessBoundDays = HISTORY_FRESHNESS_BOUND_DAYS;
  try {
    const allRows = db
      .prepare(
        `SELECT recordedAt AS date, price, store FROM AppDealPriceHistory
         WHERE gameId = ? AND recordedAt >= date('now', ?)
         ORDER BY recordedAt ASC`,
      )
      .all(gameId, `-${months} months`) as HistoryPoint[];
    const observedRows = allRows.filter((row) => row.store !== "Synthesis");
    const syntheticRows = allRows.filter((row) => row.store === "Synthesis");
    const latestObservedAt = observedRows.length
      ? observedRows[observedRows.length - 1].date
      : null;
    const coveredPeriod = observedRows.length
      ? { from: observedRows[0].date, to: observedRows[observedRows.length - 1].date }
      : null;
    const latestMs = latestObservedAt ? Date.parse(`${latestObservedAt.replace(" ", "T")}Z`) : NaN;
    const stale = Number.isFinite(latestMs)
      ? Date.now() - latestMs > freshnessBoundDays * 24 * 60 * 60 * 1000
      : false;
    const availability: HistoryAvailability = observedRows.length
      ? stale
        ? "stale"
        : "real"
      : syntheticRows.length
        ? "synthetic-only"
        : "missing";

    return {
      points: downsampleHistory(includeSynthetic ? allRows : observedRows, maxPoints),
      availability,
      latestObservedAt,
      coveredPeriod,
      freshnessBoundDays,
    };
  } catch {
    return {
      points: [],
      availability: "missing",
      latestObservedAt: null,
      coveredPeriod: null,
      freshnessBoundDays,
    };
  }
}

/**
 * Return price history for the last `months` (default 24), newest first.
 * When more than `maxPoints` rows exist they are downsampled by bucketing into
 * even day-ranges so the sparkline stays readable without a charting library.
 */
export function getPriceHistory(gameId: string, months = 24, maxPoints = 48): HistoryPoint[] {
  return getPriceHistorySnapshot(gameId, months, maxPoints).points;
}

/**
 * Seed a deterministic 24-month history baseline for a title when no local
 * history exists yet. Deterministic per gameKey so offline/demo runs render
 * stable sparklines; real ingestion appends genuine points on top.
 */
export function seedHistoryBaseline(
  gameKey: string,
  title: string,
  currentPrice: number,
  forceSynthetic = false,
): void {
  const key = String(gameKey || "").trim();
  if (!key) return;
  try {
    const existing =
      (
        db.prepare("SELECT COUNT(*) AS c FROM AppDealPriceHistory WHERE gameId = ?").get(key) as {
          c: number;
        }
      )?.c ?? 0;
    if (existing > 0 && !forceSynthetic) return;
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }
    const base = Math.abs(hash) % 20;
    const months = 24;
    const tx = db.transaction(() => {
      for (let m = months; m >= 1; m -= 1) {
        const drift = ((base + m * 7) % 30) / 100; // 0..0.29 drift
        const price = Math.max(0.99, Math.round(currentPrice * (0.5 + drift) * 100) / 100);
        db.prepare(
          `INSERT OR IGNORE INTO AppDealPriceHistory (gameId, title, store, price, recordedAt)
           VALUES (?, ?, 'Synthesis', ?, date('now', ?))`,
        ).run(key, String(title || "").slice(0, 300), price, `-${m} months`);
      }
    });
    tx();
  } catch (err: any) {
    console.error("seedHistoryBaseline failed:", err?.message || err);
  }
}

/**
 * De-duplicate deals by normalized title + store, keeping the lowest price.
 */
function dedupeDeals(deals: AggregatedDeal[]): AggregatedDeal[] {
  const seen = new Map<string, AggregatedDeal>();
  for (const deal of deals) {
    const key = `${normTitleKey(deal.title)}|${deal.store}`;
    const existing = seen.get(key);
    if (!existing || deal.currentPrice < existing.currentPrice) {
      seen.set(key, deal);
    }
  }
  return Array.from(seen.values());
}

/**
 * Title-matched upsert of the resolved best price into AppWishlist and
 * AppPriceAlerts. Strictly non-destructive: only lowers currentBestPrice /
 * historicalLow and flips isTriggered when the target threshold is met.
 */
export function updateWishlistAlerts(deal: AggregatedDeal): number {
  const key = normTitleKey(deal.title);
  if (!key) return 0;
  let affected = 0;
  try {
    const wishlistRows = db
      .prepare("SELECT id, userId, gameId, targetPrice FROM AppWishlist")
      .all() as Array<{ id: number; userId: string; gameId: string; targetPrice: number | null }>;
    const updateWishlist = db.prepare(
      `UPDATE AppWishlist SET
         currentBestPrice = CASE
           WHEN ? < currentBestPrice OR currentBestPrice IS NULL THEN ?
           ELSE currentBestPrice END,
         bestStore = CASE
           WHEN ? < currentBestPrice OR currentBestPrice IS NULL THEN ?
           ELSE bestStore END,
         bestStoreType = CASE
           WHEN ? < currentBestPrice OR currentBestPrice IS NULL THEN ?
           ELSE bestStoreType END,
         historicalLow = MIN(COALESCE(historicalLow, ?), ?),
         isTriggered = CASE
           WHEN targetPrice > 0 AND ? <= targetPrice THEN 1
           ELSE isTriggered END,
         updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    const updateAlert = db.prepare(
      `UPDATE AppPriceAlerts SET
         currentPrice = CASE
           WHEN ? < currentPrice OR currentPrice IS NULL THEN ?
           ELSE currentPrice END,
         historicalLow = MIN(COALESCE(historicalLow, ?), ?),
         isTriggered = CASE
           WHEN targetPrice > 0 AND ? <= targetPrice THEN 1
           ELSE isTriggered END,
         updatedAt = CURRENT_TIMESTAMP
       WHERE userId = ? AND gameId = ?`,
    );

    for (const row of wishlistRows) {
      if (normTitleKey(row.gameId) !== key) continue;
      const historicalLow = deal.historyLow ?? deal.currentPrice;
      updateWishlist.run(
        deal.currentPrice,
        deal.currentPrice,
        deal.currentPrice,
        deal.store,
        deal.currentPrice,
        storeTypeFor(deal.store),
        historicalLow,
        historicalLow,
        deal.currentPrice,
        row.id,
      );
      updateAlert.run(
        deal.currentPrice,
        deal.currentPrice,
        historicalLow,
        historicalLow,
        deal.currentPrice,
        row.userId,
        row.gameId,
      );
      affected += 1;
    }
  } catch (err: any) {
    console.error("updateWishlistAlerts failed:", err?.message || err);
  }
  return affected;
}

/**
 * Seed a deterministic demo arbitrage baseline from the local catalog so the
 * Deal Finder always renders sparkline cards offline (no network required).
 * Real ingestion appends genuine points on top of these deterministic ones.
 */
export function seedDemoArbitrage(): void {
  const demo: Array<{ key: string; title: string; price: number }> = [
    { key: "cyberpunk-2077", title: "Cyberpunk 2077", price: 16.49 },
    { key: "the-witcher-3", title: "The Witcher 3: Wild Hunt", price: 9.99 },
    { key: "elden-ring", title: "Elden Ring", price: 39.99 },
    { key: "hades", title: "Hades", price: 12.49 },
    { key: "hollow-knight", title: "Hollow Knight", price: 7.49 },
    { key: "celeste", title: "Celeste", price: 4.99 },
  ];
  // AI-056: each seed catches its own write error, so a held lock cost six waits
  // in one synchronous stretch. BEGIN IMMEDIATE makes it one; still never throws.
  try {
    db.transaction(() => {
      for (const d of demo) {
        seedHistoryBaseline(d.key, d.title, d.price, true);
      }
    }).immediate();
  } catch (err: any) {
    console.error("seedDemoArbitrage failed:", err?.message || err);
  }
}

export interface ArbitrageFeedResult {
  success: boolean;
  source: string;
  deals: number;
  persisted: number;
  triggered: number;
  errors: string[];
}

/**
 * Run the full multi-source arbitrage ingestion: fetch ITAD / GG.deals / Deku
 * Deals, validate through dealSchema, persist price-history baseline points,
 * and refresh wishlist/alert trigger state. Resilient per source — one
 * upstream failure never aborts the others.
 */
export async function ingestAllDeals(): Promise<ArbitrageFeedResult> {
  const errors: string[] = [];
  const [itad, gg, deku] = await Promise.allSettled([
    fetchItadDeals(),
    fetchGgDeals(),
    fetchDekuDeals(),
  ]);

  const allDeals: AggregatedDeal[] = [];
  for (const [label, settled] of [
    ["itad", itad],
    ["ggdeals", gg],
    ["dekudeals", deku],
  ] as Array<[DealSource, PromiseSettledResult<AggregatedDeal[]>]>) {
    if (settled.status === "fulfilled") {
      allDeals.push(...settled.value);
    } else {
      errors.push(`${label}: ${(settled.reason as Error)?.message || "fetch failed"}`);
    }
  }

  const unique = dedupeDeals(allDeals);
  let persisted = 0;
  let triggered = 0;

  // AI-056: the deal count follows the upstream feeds, and each helper catches its
  // own write errors, so a held lock cost up to three waits per deal with the
  // event loop blocked throughout. One transaction per deal takes the write lock
  // first (its only wait), and the checkpoint between deals lets shutdown stop.
  const persistDeal = db.transaction((deal: AggregatedDeal): number => {
    const gameKey = dealGameKey(deal);
    recordPricePoint(gameKey, deal.title, deal.store, deal.currentPrice);
    seedHistoryBaseline(gameKey, deal.title, deal.currentPrice);
    return updateWishlistAlerts(deal);
  });

  for (const deal of unique) {
    await shutdownCheckpoint();
    try {
      triggered += persistDeal.immediate(deal);
      persisted += 1;
    } catch (err: any) {
      console.error("ingestAllDeals persist failed:", err?.message || err);
    }
  }

  return {
    success: errors.length < 3,
    source: "multi",
    deals: unique.length,
    persisted,
    triggered,
    errors,
  };
}

export interface ArbitrageDealCard {
  gameKey: string;
  title: string;
  store: string;
  storeUrl: string;
  currentPrice: number;
  regularPrice: number | null;
  lowest30d: number | null;
  historyLow: number | null;
  isLowestEver: boolean;
  history: HistoryPoint[];
}

/**
 * Build the active arbitrage feed for the client: the most recently recorded
 * distinct game/price rows, enriched with 30-day low, verified all-time low,
 * and the price-history series for the 24-month sparkline.
 */
export function getArbitrageFeed(limit = 24): ArbitrageDealCard[] {
  try {
    const rows = db
      .prepare(
        `SELECT h.gameId, h.title, h.store, h.price, h.recordedAt
         FROM AppDealPriceHistory h
         JOIN (
           SELECT gameId, MAX(recordedAt) AS maxDate
           FROM AppDealPriceHistory GROUP BY gameId
         ) m ON h.gameId = m.gameId AND h.recordedAt = m.maxDate
         ORDER BY h.recordedAt DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ gameId: string; title: string | null; store: string; price: number }>;

    return rows.map((r) => {
      const gameKey = r.gameId;
      let history = getPriceHistorySnapshot(gameKey, 24, 48, true).points;
      if (history.length < 2) {
        seedHistoryBaseline(gameKey, r.title || gameKey, Number(r.price) || 0, true);
        history = getPriceHistorySnapshot(gameKey, 24, 48, true).points;
      }
      const historyLow = allTimeLowFor(gameKey);
      const lowest30d = lowest30dFor(gameKey);
      return {
        gameKey,
        title: r.title || gameKey,
        store: r.store,
        storeUrl: storeUrlForWhitelistedStore(r.store, r.title || r.gameId),
        currentPrice: Number(r.price) || 0,
        regularPrice: null,
        lowest30d,
        historyLow,
        isLowestEver: historyLow !== null && historyLow <= Number(r.price),
        history,
      };
    });
  } catch (err: any) {
    console.error("getArbitrageFeed failed:", err?.message || err);
    return [];
  }
}
