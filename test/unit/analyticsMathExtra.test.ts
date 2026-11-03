import { describe, expect, it } from "vitest";
import { normalizeGenre, round, statusBucket, valueRating } from "../../src/utils/analyticsMath";

describe("analyticsMath extra coverage", () => {
  it("preserves already-normalized genre labels with punctuation", () => {
    expect(normalizeGenre("Action-Adventure / Soulslike")).toBe("Action-Adventure / Soulslike");
    expect(normalizeGenre(false)).toBe("false");
  });

  it("treats non-matching progress labels as unplayed", () => {
    expect(statusBucket("Paused")).toBe("unplayed");
    expect(statusBucket("Queued")).toBe("unplayed");
  });

  it("classifies negative cost-per-hour as Excellent under current thresholds", () => {
    expect(valueRating(-1)).toBe("Excellent");
  });

  it("rounds with zero decimals and preserves negative values", () => {
    expect(round(12.6, 0)).toBe(13);
    expect(round(-1.234, 2)).toBe(-1.23);
  });
});
