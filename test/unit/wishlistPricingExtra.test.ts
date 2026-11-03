import { describe, expect, it } from "vitest";
import {
  ALL_STORES,
  bestPriceFor,
  storeTypeFor,
  storeUrlFor,
  synthesizeStorePrices,
} from "../../src/services/wishlistPricing";

describe("wishlistPricing extra coverage", () => {
  it("falls back unknown stores to direct-platform classification and Steam search URL", () => {
    expect(storeTypeFor("Unknown Marketplace")).toBe("Direct Platform");
    expect(storeUrlFor("Unknown Marketplace", "my game")).toBe(
      "https://store.steampowered.com/search/?term=my%20game",
    );
  });

  it("returns one offer per store with matching URLs", () => {
    const offers = synthesizeStorePrices("monster-hunter-wilds");
    expect(offers).toHaveLength(ALL_STORES.length);
    for (const offer of offers) {
      expect(offer.url).toBe(storeUrlFor(offer.storeName, "monster-hunter-wilds"));
      expect(offer.regularPrice).toBeGreaterThanOrEqual(offer.currentPrice);
    }
  });

  it("computes the best offer consistently from synthesized offers", () => {
    const offers = synthesizeStorePrices("baldurs-gate-3");
    const best = bestPriceFor("baldurs-gate-3");
    const manualBest = offers.reduce((min, current) =>
      current.currentPrice < min.currentPrice ? current : min,
    );

    expect(best.bestStore).toBe(manualBest.storeName);
    expect(best.currentBestPrice).toBe(manualBest.currentPrice);
    expect(best.historicalLow).toBeNull();
  });
});
