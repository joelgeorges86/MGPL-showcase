/**
 * Shared multi-store pricing helpers (Sprint 25.2 / Sprint 32).
 *
 * These pure, deterministic pricing functions are shared between the wishlist
 * route (src/routes/wishlist.ts) and the live storefront price sync
 * (src/services/dealSync.ts). Extracting them into a dedicated module removes
 * the circular dependency between the two, so the route can statically import
 * syncLiveStorePrices() without a fragile dynamic-import dance.
 */

/** Direct storefronts (first-party platforms). */
export const DIRECT_STORES = ["Steam", "GOG", "Epic", "PlayStation", "Xbox"];

/** Authorized key retailers (official resellers of platform keys). */
export const KEY_RETAILERS = [
  "Fanatical",
  "Green Man Gaming",
  "Gamesplanet",
  "GameBillet",
  "Humble Store",
];

/** All stores considered for best-price synthesis and trigger evaluation. */
export const ALL_STORES = [...DIRECT_STORES, ...KEY_RETAILERS];

/** Build a deterministic outbound purchase/search URL for a store. */
export function storeUrlFor(storeName: string, gameId: string): string {
  const term = encodeURIComponent(gameId || "");
  switch (storeName) {
    case "Steam":
      return `https://store.steampowered.com/search/?term=${term}`;
    case "GOG":
      return `https://www.gog.com/en/games?query=${term}`;
    case "Epic":
      return `https://store.epicgames.com/en-US/browse?q=${term}`;
    case "PlayStation":
      return `https://store.playstation.com/en-us/search/${term}`;
    case "Xbox":
      return `https://www.xbox.com/en-US/search?q=${term}`;
    case "Fanatical":
      return `https://www.fanatical.com/en/search?search=${term}`;
    case "Green Man Gaming":
      return `https://www.greenmangaming.com/search/?text=${term}`;
    case "Gamesplanet":
      return `https://www.gamesplanet.com/search?q=${term}`;
    case "GameBillet":
      return `https://www.gamebillet.com/search?q=${term}`;
    case "Humble Store":
      return `https://www.humblebundle.com/store/search?search=${term}`;
    default:
      return `https://store.steampowered.com/search/?term=${term}`;
  }
}

/**
 * Deterministic hash-based price synthesis (mirrors deals.ts /history/:gameId).
 * Produces stable per-store prices for a given gameId so comparison data is
 * reproducible across requests without any external network dependency.
 *
 * Each offer matches the FEAT-0158 contract:
 *   { storeName, currentPrice, regularPrice, discountPercent, url, isBest }
 */
export function synthesizeStorePrices(gameId: string): Array<{
  storeName: string;
  currentPrice: number;
  regularPrice: number;
  discountPercent: number;
  url: string;
  isBest: boolean;
}> {
  let hash = 0;
  const seed = gameId || "unknown";
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const basePrice = 29.99 + (Math.abs(hash) % 40);

  const offers = ALL_STORES.map((storeName, idx) => {
    const storeHash = (Math.abs(hash) + idx * 7919) % 100;
    const discountPercent = storeHash % 45; // 0-44% off
    const currentPrice = Math.round(basePrice * (1 - discountPercent / 100) * 100) / 100;
    return {
      storeName,
      currentPrice,
      regularPrice: Math.round(basePrice * 100) / 100,
      discountPercent,
      url: storeUrlFor(storeName, gameId),
      isBest: false,
    };
  });

  // Mark the lowest-priced store as the best offer.
  const best = offers.reduce((min, o) => (o.currentPrice < min.currentPrice ? o : min), offers[0]);
  best.isBest = true;
  return offers;
}

/**
 * Classify a store as a Direct Platform or Authorized Key Retailer (v5.0.4
 * Chapter 24 store taxonomy). Persisted on AppWishlist.bestStoreType so the
 * recommendation surface can distinguish first-party storefronts from
 * authorized key resellers.
 */
export function storeTypeFor(storeName: string): "Direct Platform" | "Authorized Retailer" {
  return KEY_RETAILERS.includes(storeName) ? "Authorized Retailer" : "Direct Platform";
}

/** Resolve the best (lowest) deterministic price across all stores for a game. */
export function bestPriceFor(gameId: string): {
  currentBestPrice: number;
  bestStore: string;
  bestStoreType: "Direct Platform" | "Authorized Retailer";
  historicalLow: number | null;
} {
  const offers = synthesizeStorePrices(gameId);
  const best = offers.reduce((min, o) => (o.currentPrice < min.currentPrice ? o : min), offers[0]);
  return {
    currentBestPrice: best.currentPrice,
    bestStore: best.storeName,
    bestStoreType: storeTypeFor(best.storeName),
    historicalLow: null,
  };
}

/** True when any authorized store (direct or key retailer) offers <= target. */
export function anyStoreAtOrBelowTarget(gameId: string, targetPrice: number): boolean {
  if (!targetPrice || targetPrice <= 0) return false;
  return synthesizeStorePrices(gameId).some((o) => o.currentPrice <= targetPrice);
}
