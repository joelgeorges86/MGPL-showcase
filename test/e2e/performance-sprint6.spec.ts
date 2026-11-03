import { test, expect } from "../fixtures";

const BASE = "http://localhost:4000";

/**
 * Sprint 6 (PI-GTM-2026-001) — P90 Performance Verification.
 *
 * Validates the three complex query paths named in the WUD:
 *   1. Catalog pagination (GET /api/games?page=N&limit=24)
 *   2. Multi-genre facets (GET /api/games?genre=a,b,c&genreMode=any)
 *   3. Comparison matrix rendering (click-to-render after the explicit
 *      "Analyze Benchmark" action, honoring the Chapter 23 explicit-trigger rule)
 *
 * Budget: the documented P90 latency ceiling for complex queries is 2s
 * (DPM-10 / [perf] logging). End-to-end round-trips through the full Express
 * stack are measured with real wall-clock timing; renders use performance.now().
 */

function p90(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
  return sorted[Math.min(sorted.length - 1, idx)];
}

test.describe("Sprint 6 (PI-GTM-2026-001) - P90 Performance Verification", () => {
  const P90_BUDGET_MS = 2000;
  const SAMPLES = 5;

  test("1. Multi-genre facet query round-trips under the 2s P90 budget", async ({ page }: { page: any }) => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      const res = await page.request.get(
        `${BASE}/api/games?genre=${encodeURIComponent("Action,RPG,Indie")}&genreMode=any&limit=24`
      );
      const elapsed = Date.now() - t0;
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.games)).toBe(true);
      samples.push(elapsed);
    }
    expect(p90(samples)).toBeLessThan(P90_BUDGET_MS);
  });

  test("2. Catalog pagination round-trips under the 2s P90 budget", async ({ page }: { page: any }) => {
    // Sample valid pages only: the seeded catalog yields a finite page count,
    // and out-of-range pages are clamped by the API (never 500).
    const firstRes = await page.request.get(`${BASE}/api/games?page=1&limit=12`);
    const firstBody = await firstRes.json();
    expect(firstBody.success).toBe(true);
    const totalPages = Math.max(1, Number(firstBody.totalPages) || 1);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const pageNum = Math.min(totalPages, i + 1);
      const t0 = Date.now();
      const res = await page.request.get(`${BASE}/api/games?page=${pageNum}&limit=12`);
      const elapsed = Date.now() - t0;
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(Number(body.page)).toBe(pageNum);
      samples.push(elapsed);
    }
    expect(p90(samples)).toBeLessThan(P90_BUDGET_MS);
  });

  test("3. Comparison matrix click-to-render stays under the 2s P90 budget", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.waitForSelector("#page-compare");

    // Open the multi-select dropdown and pick two games.
    await page.locator("#compare-select-trigger").click();
    const boxes = page.locator("#compare-games-list .compare-game-checkbox");
    await expect(boxes.first()).toBeVisible({ timeout: 15000 });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.locator("#compare-select-trigger").click();

    const runBtn = page.locator("#btn-run-compare");
    await expect(runBtn).toBeEnabled();

    // Measure wall-clock time from the explicit user action (click) until the
    // comparison matrix body enters the DOM. The comparison POST + render are
    // included (Chapter 23 explicit-trigger rule).
    const start = Date.now();
    await runBtn.click();
    await page.waitForFunction(() => {
      return !!document.querySelector('#matrix-body tr[data-compare-cluster]');
    }, { timeout: 20000 });
    const renderMs = Date.now() - start;

    expect(renderMs).toBeGreaterThanOrEqual(0);
    expect(renderMs).toBeLessThan(P90_BUDGET_MS);
    await expect(page.locator("#matrix-body")).toBeVisible();
  });
});
