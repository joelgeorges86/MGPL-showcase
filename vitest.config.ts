import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live under test/unit only. The E2E Playwright specs
    // (test/e2e) must never be picked up by Vitest — they are owned by
    // playwright.config.ts and rely on its webServer/fixtures.
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // Pure-logic suites only: modules under test must not open SQLite or hit
    // the network. Any accidental DB import fails loudly in the suite.
    isolate: true,
    // Task proposal 023: the default 5,000 ms limit per test is too tight for the local gate on
    // the operator's machine, where a test occasionally pauses for about 5 s. Across four full
    // runs with 120 s diagnostic limits, the longest test outside doctorBaseBranch took 5.7 s,
    // and no test reached 20 s. 20 s still fails a hung test.
    testTimeout: 20000,
    hookTimeout: 20000,

    // Gate Q3 — coverage. Scoped to the modules the unit layer actually
    // exercises (utils + lib + the two pure services) so the thresholds are
    // meaningful rather than diluted by hundreds of untested route modules.
    // Thresholds sit just below the current baseline (61.8% lines) so a
    // meaningful regression fails the gate without making it brittle.
    coverage: {
      provider: "v8",
      include: [
        "src/utils/**",
        "src/lib/**",
        "src/services/headroom.ts",
        "src/services/wishlistPricing.ts",
        "src/services/devicePlayability.ts",
      ],
      thresholds: {
        statements: 70,
        functions: 65,
        branches: 60,
        lines: 70,
      },
      reporter: ["text", "text-summary"],
    },
  },
});
