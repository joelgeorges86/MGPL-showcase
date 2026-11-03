import { describe, it, expect } from "vitest";
import {
  storeTypeFor,
  synthesizeStorePrices,
  bestPriceFor,
  anyStoreAtOrBelowTarget,
  ALL_STORES,
  DIRECT_STORES,
  KEY_RETAILERS,
} from "../../src/services/wishlistPricing";

describe("wishlistPricing: store-type taxonomy", () => {
  it("classifies key retailers vs direct platforms", () => {
    expect(storeTypeFor("Steam")).toBe("Direct Platform");
    expect(storeTypeFor("GOG")).toBe("Direct Platform");
    expect(storeTypeFor("Fanatical")).toBe("Authorized Retailer");
    expect(storeTypeFor("Green Man Gaming")).toBe("Authorized Retailer");
    expect(storeTypeFor("Humble Store")).toBe("Authorized Retailer");
  });

  it("exposes the full taxonomy lists", () => {
    expect(DIRECT_STORES).toContain("Steam");
    expect(KEY_RETAILERS).toContain("GameBillet");
    expect(ALL_STORES.length).toBe(DIRECT_STORES.length + KEY_RETAILERS.length);
  });
});

describe("wishlistPricing: deterministic synthesis", () => {
  it("produces stable per-store offers with exactly one best", () => {
    const offers = synthesizeStorePrices("game-123");
    expect(offers.length).toBe(ALL_STORES.length);
    expect(offers.filter((o) => o.isBest).length).toBe(1);
    // Deterministic: same input => same output
    expect(offers).toEqual(synthesizeStorePrices("game-123"));
    expect(offers).not.toEqual(synthesizeStorePrices("game-456"));
  });

  it("resolves the best price with store type", () => {
    const best = bestPriceFor("game-123");
    expect(best.currentBestPrice).toBeGreaterThan(0);
    expect(["Direct Platform", "Authorized Retailer"]).toContain(best.bestStoreType);
    expect(best.bestStore).toBeTruthy();
    expect(best.historicalLow).toBeNull();
  });

  it("reports when any store hits a target", () => {
    expect(anyStoreAtOrBelowTarget("game-123", 999999)).toBe(true);
    expect(anyStoreAtOrBelowTarget("game-123", 0)).toBe(false);
    expect(anyStoreAtOrBelowTarget("game-123", -1)).toBe(false);
  });
});
