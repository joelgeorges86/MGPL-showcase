import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../../src/utils/errorSanitizer";

describe("errorSanitizer additional coverage", () => {
  it("sanitizes bearer-style secrets embedded in prose", () => {
    const result = sanitizeErrorMessage("authorization=BearerToken123 refresh_token=xyz");
    expect(result).toBe("[redacted] [redacted]");
  });

  it("returns fallback when sanitization strips everything meaningful", () => {
    expect(sanitizeErrorMessage("   ", "fallback message")).toBe("fallback message");
  });

  it("preserves non-sensitive short messages verbatim", () => {
    expect(sanitizeErrorMessage("Network timeout")).toBe("Network timeout");
  });
});
