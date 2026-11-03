import { describe, expect, it } from "vitest";
import {
  anyStoreAtOrBelowTarget,
  bestPriceFor,
  synthesizeStorePrices,
} from "../../src/services/wishlistPricing";

describe("wishlistPricing additional coverage", () => {
  it("treats exact best-price matches as triggered", () => {
    const best = bestPriceFor("exact-trigger-game");
    expect(anyStoreAtOrBelowTarget("exact-trigger-game", best.currentBestPrice)).toBe(true);
  });

  it("keeps discount percentages within the documented deterministic range", () => {
    const offers = synthesizeStorePrices("range-check-game");
    for (const offer of offers) {
      expect(offer.discountPercent).toBeGreaterThanOrEqual(0);
      expect(offer.discountPercent).toBeLessThan(45);
    }
  });

  it("never marks more than one synthesized offer as best", () => {
    const offers = synthesizeStorePrices("single-best-game");
    expect(offers.filter((offer) => offer.isBest)).toHaveLength(1);
  });
});
