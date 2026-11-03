import { test, expect } from "@playwright/test";

/**
 * Dedicated API rate-limiting regression suite (Gap-4).
 *
 * The global API limiter (300/15 min) is deliberately raised to 100000 in test
 * mode so the E2E suite never trips it. This spec instead targets the fixed,
 * low-window per-endpoint limiters that are the real DoS surface in production:
 *
 *   GET /api/dpm/health            -> 5 req / 1s   (src/routes/dpm.ts)
 *   GET /api/dpm/metrics           -> 10 req / 5s  (src/routes/dpm.ts)
 *   GET /api/observability/health  -> 5 req / 1s   (src/routes/observability.ts)
 *
 * Each test verifies the full contract:
 *   - a 429 is returned once the window quota is consumed,
 *   - the 429 body is sanitized JSON (status/message only — no stack/paths),
 *   - a `retry-after` header is present on the limited response,
 *   - normal traffic recovers automatically after the window elapses.
 *
 * These windows are short (1s / 5s) and the spec runs serially (single worker),
 * so the transient 429 state can never bleed into later specs.
 */

const BASE = "http://localhost:4000";

/** Send `count` rapid sequential GETs and return the responses. */
async function burst(request: import("@playwright/test").APIRequestContext, url: string, count: number) {
  return Promise.all(
    Array.from({ length: count }, () => request.get(url)),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe("API Rate Limiting (per-endpoint limiters)", () => {
  test("1. DPM health limiter (5/sec) returns sanitized 429 + Retry-After, then recovers", async ({ request }) => {
    const responses = await burst(request, `${BASE}/api/dpm/health`, 8);
    const limited = responses.filter((r) => r.status() === 429);
    const passed = responses.filter((r) => r.status() === 200);

    // Window quota is 5; a burst of 8 must trip the limiter.
    expect(limited.length).toBeGreaterThan(0);
    expect(passed.length).toBeLessThanOrEqual(5);

    const firstLimited = limited[0];
    expect(firstLimited.headers()["retry-after"]).toBeDefined();
    const body = await firstLimited.json();
    expect(body).toHaveProperty("status", "error");
    expect(typeof body.message).toBe("string");
    // Sanitized contract: exactly status + message, nothing else.
    expect(Object.keys(body).sort()).toEqual(["message", "status"]);

    // Window recovery: after ~1.1s the counter resets.
    await sleep(1200);
    const recovered = await request.get(`${BASE}/api/dpm/health`);
    expect(recovered.status()).toBe(200);
  });

  test("2. DPM metrics limiter (10/5s) returns 429 + Retry-After, then recovers", async ({ request }) => {
    const responses = await burst(request, `${BASE}/api/dpm/metrics`, 14);
    const limited = responses.filter((r) => r.status() === 429);
    const passed = responses.filter((r) => r.status() === 200);

    expect(limited.length).toBeGreaterThan(0);
    expect(passed.length).toBeLessThanOrEqual(10);
    expect(limited[0].headers()["retry-after"]).toBeDefined();

    // 5s window recovery.
    await sleep(5200);
    const recovered = await request.get(`${BASE}/api/dpm/metrics`);
    expect(recovered.status()).toBe(200);
  });

  test("3. Observability health limiter (5/sec) returns sanitized 429, then recovers", async ({ request }) => {
    const responses = await burst(request, `${BASE}/api/observability/health`, 8);
    const limited = responses.filter((r) => r.status() === 429);
    const passed = responses.filter((r) => r.status() === 200);

    expect(limited.length).toBeGreaterThan(0);
    expect(passed.length).toBeLessThanOrEqual(5);
    expect(limited[0].headers()["retry-after"]).toBeDefined();

    const body = await limited[0].json();
    expect(body).toHaveProperty("status", "error");
    expect(Object.keys(body).sort()).toEqual(["message", "status"]);

    await sleep(1200);
    const recovered = await request.get(`${BASE}/api/observability/health`);
    expect(recovered.status()).toBe(200);
  });
});
