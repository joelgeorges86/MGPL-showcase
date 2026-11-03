import { describe, expect, it } from "vitest";
import { safeErrorMessage, sanitizeErrorMessage } from "../../src/utils/errorSanitizer";

describe("errorSanitizer", () => {
  it("sanitizes secret-like key/value pairs and filesystem paths", () => {
    const input =
      "token=abcdef password=hunter2 at C:/Users/joelg/OneDrive/PC Build/MGPL/src/index.ts:10";
    const result = sanitizeErrorMessage(input);
    expect(result).toContain("[redacted]");
    expect(result).toContain("[path]");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("abcdef");
  });

  it("removes stack traces and file URLs from Error objects", () => {
    const error = new Error(
      "Boom\n    at run (C:/repo/src/file.ts:10:2)\n    at next (file://secret.ts)",
    );
    expect(sanitizeErrorMessage(error)).toBe("Boom");
  });

  it("handles object-shaped and nullish errors with fallback text", () => {
    expect(sanitizeErrorMessage({ message: "client_secret=abc" }, "fallback")).toBe("[redacted]");
    expect(safeErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  it("caps pathological payloads to the max output length", () => {
    const long = "x".repeat(500);
    expect(sanitizeErrorMessage(long).length).toBeLessThanOrEqual(240);
  });
});
