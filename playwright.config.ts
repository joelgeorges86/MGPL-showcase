import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  // Sprint (EPIC-TEST-STD-0001): deterministic single-worker lockdown.
  // Full-suite runs MUST execute serially — a single worker guarantees
  // exclusive access to the shared test_mgpl.db so SQLITE_BUSY transaction
  // collisions and cross-spec state contamination are impossible. CI may
  // override with --workers=N only when each worker targets an isolated DB.
  timeout: 30 * 1000,
  expect: {
    timeout: 5 * 1000,
  },
  // Deterministic green runs: a single worker guarantees serial execution and
  // shared-SQLite isolation. The wishlist/state suites seed and clean the same
  // test DB, so running spec files in parallel across workers would race on
  // SQLITE_BUSY and cross-contaminate seeded state.
  // Sprint 1 (EPIC-TEST-STD-0001): workers:1 is the mandatory local/test-mode
  // concurrency cap. CI builds may override via --workers=N, but never against
  // the shared test_mgpl.db in local dev.
  fullyParallel: false,
  workers: 1,

  // Concise structured output for local dev and gate runs. The benchmark runner
  // (scripts/test-runner.ts) overrides this with --reporter=json per-invocation
  // so it can parse per-suite metrics without replaying the suite.
  reporter: "list",

  // Deterministic test seeding: global-setup initializes a fresh
  // ./data/test_mgpl.db, applies WAL/busy_timeout PRAGMAs, and seeds the 13
  // authoritative tables with deterministic records before any spec runs.
  globalSetup: "./test/global-setup.ts",

  use: {
    baseURL: "http://localhost:4000",
    trace: "retain-on-failure",
  },

  webServer: {
    // Run only the API server (no Vite) — the E2E suite drives the SPA shell
    // and API directly against :4000, so the Vite dev server is unnecessary
    // and would only add startup latency and port churn.
    command: "npm run dev:server",
    url: "http://localhost:4000",
    reuseExistingServer: false,
    timeout: 120 * 1000,
    // The E2E suite issues hundreds of API requests from a single IP, which
    // would otherwise trip the production rate limit (300 req / 15 min).
    // NODE_ENV=test relaxes CSP script sources and enables the server-side
    // external-API mocks; DISABLE_CRON=true keeps the scheduler from hitting
    // live storefront APIs; DB_PATH isolates the suite to the seeded test DB.
    env: {
      ...process.env,
      NODE_ENV: "test",
      DISABLE_CRON: "true",
      DB_PATH: "./data/test_mgpl.db",
      RATE_LIMIT_MAX: "100000",
      // Sprint 1 (EPIC-DEAL-001): deterministic circuit-breaker thresholds so
      // the deals-security spec can trip the breaker with two failed requests
      // and zero backoff, with a long reset window to keep it OPEN mid-test.
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: "2",
      CIRCUIT_BREAKER_BACKOFF_MS: "0",
      CIRCUIT_BREAKER_MAX_BACKOFF_MS: "0",
      CIRCUIT_BREAKER_RESET_MS: "60000",
      // Sprint 2 (WUD-2.1 / EPIC-01): deterministic AES-256-GCM token
      // encryption key so the profile-sync spec can prove encrypted at-rest
      // token storage (64 hex chars = 32 bytes).
      MGPL_TOKEN_ENC_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    },
  },
});
