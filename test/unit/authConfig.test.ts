import { describe, expect, it } from "vitest";
import { resolveJwtSecret } from "../../src/lib/auth";

describe("JWT configuration", () => {
  it("rejects a production process without JWT_SECRET", () => {
    expect(() => resolveJwtSecret({ NODE_ENV: "production" })).toThrow(
      "JWT_SECRET is required when NODE_ENV=production.",
    );
  });

  it("preserves the deterministic fallback outside production", () => {
    expect(resolveJwtSecret({ NODE_ENV: "test" })).toBe(
      "dev-only-insecure-secret-do-not-use-in-prod",
    );
  });

  it("uses the configured secret in production", () => {
    expect(resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: "configured-test-secret" })).toBe(
      "configured-test-secret",
    );
  });
});
