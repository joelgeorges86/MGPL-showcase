import { describe, expect, it } from "vitest";
import {
  CANONICAL_PLATFORMS,
  isCanonicalPlatform,
  normalizePlatform,
} from "../../src/lib/platformTaxonomy";

describe("platformTaxonomy extra coverage", () => {
  it("accepts canonical labels case-insensitively and returns canonical casing", () => {
    expect(normalizePlatform("console – playstation")).toBe("Console – PlayStation");
    expect(normalizePlatform("mobile – android")).toBe("Mobile – Android");
  });

  it("resolves substring aliases using current precedence rules", () => {
    expect(normalizePlatform("Xbox Cloud Gaming Beta")).toBe("Console – Xbox");
    expect(normalizePlatform("Nintendo Switch OLED")).toBe("Console – Nintendo");
  });

  it("returns null for unknown or empty platform strings", () => {
    expect(normalizePlatform("Sega Saturn")).toBeNull();
    expect(normalizePlatform("   ")).toBeNull();
  });

  it("guards canonical platform membership precisely", () => {
    expect(isCanonicalPlatform(CANONICAL_PLATFORMS[0])).toBe(true);
    expect(isCanonicalPlatform("PC ")).toBe(false);
    expect(isCanonicalPlatform(42)).toBe(false);
  });
});
