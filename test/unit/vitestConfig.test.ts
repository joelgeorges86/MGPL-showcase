// Task proposal 023: the unit suite's per-test and per-hook limits. Reads the config the gates
// run with; no network, no files written.
import { describe, expect, it } from "vitest";

describe("proposal 023: Vitest limits for the local gate", () => {
  it("allows 20 s per test and per hook, and keeps the unit-only scope", async () => {
    const { default: config } = await import("../../vitest.config");
    const test = (config as { test?: Record<string, unknown> }).test ?? {};
    expect(test.testTimeout).toBe(20000);
    expect(test.hookTimeout).toBe(20000);
    expect(test.include).toEqual(["test/unit/**/*.test.ts"]);
  });
});
