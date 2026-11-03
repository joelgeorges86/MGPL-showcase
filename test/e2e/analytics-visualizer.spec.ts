import { test, expect } from '@playwright/test';
import { LEADERSHIP } from '../helpers/api-client';

/**
 * Sprint 20 (FEAT-0152) — Interactive Playtime & Backlog Analytics Visualizer.
 *
 * Sprint 5 (EPIC-07): /api/analytics/* is server-side role-gated to
 * admin | Product | Data | Leadership. Every test authenticates as the seeded
 * LEADERSHIP account (test/global-setup.ts) so the gate grants access.
 *
 * Test 1: GET /api/analytics/summary returns a valid structure with aggregates.
 * Test 2: Navigating to the Analytics view renders SVG/Canvas charts.
 * Test 3: Cost-per-hour and genre breakdown calculations are correct.
 * Test 4: Offline rendering works from the IndexedDB cache.
 * Test 5: Zero accessibility violations across the chart cards.
 */

// Type augmentation for the client-side analytics helpers exposed by analytics.js.
// NOTE: This must remain a superset-compatible shape with the declaration in
// session-analytics.spec.ts (both files augment the same global Window).
declare global {
  interface Window {
    __analyticsHelpers?: {
      renderAnalyticsVisualizer: () => Promise<void>;
      buildDonut: (genres: Array<{ name: string; count: number; percentage: number }>) => string;
      buildStackedBars: (platforms: Array<{ platform: string; gameCount: number; totalHours: number; ownedPercentage: number }>) => string;
      buildValueScorecards: (valueSummary: Record<string, unknown>) => string;
      buildVelocity: (velocity: Record<string, unknown>) => string;
      buildSessionsTelemetry: (sessions: Record<string, unknown>) => string;
      buildBacklogVelocity: (velocity: Record<string, unknown>) => string;
      buildWeeklySparkline: (weekly: Array<{ weekStart: string; playtimeHours: number }>) => string;
      STORE: string;
      CACHE_KEY: string;
    };
    OfflineStorage?: {
      save: (storeName: string, key: string, data: unknown) => Promise<void>;
      get: (storeName: string, key: string) => Promise<unknown>;
      getAll: (storeName: string) => Promise<Array<{ key: string; data: unknown; savedAt: number }>>;
      remove: (storeName: string, key: string) => Promise<void>;
      clear: (storeName: string) => Promise<void>;
      isSupported: () => boolean;
    };
  }
}

test.describe('Interactive Playtime & Backlog Analytics Visualizer (FEAT-0152)', () => {

  // Sprint 5 (EPIC-07): the Analytics API is server-side role-gated, so every
  // test authenticates as the seeded LEADERSHIP account before reading.
  test.beforeEach(async ({ page }: { page: any }) => {
    const res = await page.request.post('http://localhost:4000/api/auth/login', {
      data: LEADERSHIP,
    });
    expect(res.status()).toBe(200);
  });

  test('1. GET /api/analytics/summary returns valid structure and aggregates', async ({ page }: { page: any }) => {
    const response = await page.request.get('http://localhost:4000/api/analytics/summary');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.success).toBe(true);

    // Genres: array of { name, count, percentage }
    expect(Array.isArray(body.genres)).toBe(true);
    for (const g of body.genres) {
      expect(typeof g.name).toBe('string');
      expect(typeof g.count).toBe('number');
      expect(typeof g.percentage).toBe('number');
      expect(g.count).toBeGreaterThanOrEqual(0);
      expect(g.percentage).toBeGreaterThanOrEqual(0);
    }

    // Platforms: array of { platform, gameCount, totalHours, ownedPercentage }
    expect(Array.isArray(body.platforms)).toBe(true);
    for (const p of body.platforms) {
      expect(typeof p.platform).toBe('string');
      expect(typeof p.gameCount).toBe('number');
      expect(typeof p.totalHours).toBe('number');
      expect(typeof p.ownedPercentage).toBe('number');
      expect(p.gameCount).toBeGreaterThanOrEqual(0);
      expect(p.totalHours).toBeGreaterThanOrEqual(0);
    }

    // Velocity: statusSummary + intervals + completionRate
    expect(body.velocity).toBeTruthy();
    expect(body.velocity.statusSummary).toBeTruthy();
    expect(typeof body.velocity.statusSummary.completed).toBe('number');
    expect(typeof body.velocity.statusSummary.inProgress).toBe('number');
    expect(typeof body.velocity.statusSummary.unplayed).toBe('number');
    expect(typeof body.velocity.statusSummary.total).toBe('number');
    expect(body.velocity.statusSummary.total).toBeGreaterThan(0);
    expect(Array.isArray(body.velocity.intervals)).toBe(true);
    expect(body.velocity.intervals.length).toBeGreaterThanOrEqual(3);
    expect(typeof body.velocity.completionRate).toBe('number');

    // Value summary: totals + breakdown
    expect(body.valueSummary).toBeTruthy();
    expect(typeof body.valueSummary.totalSpent).toBe('number');
    expect(typeof body.valueSummary.totalHours).toBe('number');
    expect(typeof body.valueSummary.overallCph).toBe('number');
    expect(typeof body.valueSummary.pricedCount).toBe('number');
    expect(typeof body.valueSummary.freeOrUnpricedCount).toBe('number');
    expect(typeof body.valueSummary.valueRating).toBe('string');
    expect(Array.isArray(body.valueSummary.breakdown)).toBe(true);
  });

  test('2. Navigating to Analytics view renders SVG charts', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/analytics');
    await page.waitForSelector('#page-analytics');

    // The page region must be visible with the correct accessibility label.
    await expect(page.locator('#page-analytics')).toBeVisible();
    await expect(page.locator('#page-analytics')).toHaveAttribute('role', 'region');
    await expect(page.locator('#page-analytics')).toHaveAttribute('aria-label', 'Analytics Visualizer');

    // Wait for the analytics data to render (donut SVG appears).
    await page.waitForFunction(() => {
      return document.querySelector('.analytics-donut') !== null;
    }, { timeout: 15000 });

    // Genre donut SVG must render with an accessible label.
    const donut = page.locator('.analytics-donut');
    await expect(donut).toBeVisible();
    await expect(donut).toHaveAttribute('role', 'img');
    await expect(donut).toHaveAttribute('aria-label', 'Genre breakdown donut chart');

    // Platform stacked bars must render.
    await expect(page.locator('.analytics-stacked-bar')).toBeVisible();

    // Value scorecards must render a sparkline SVG.
    await expect(page.locator('.analytics-sparkline').first()).toBeVisible();

    // Fallback data tables must render.
    await expect(page.locator('.analytics-value-table')).toBeVisible();
    await expect(page.locator('.analytics-velocity-table')).toBeVisible();
  });

  test('3. Cost-per-hour and genre breakdown calculations are correct', async ({ page }: { page: any }) => {
    // Fetch the authoritative API payload.
    const response = await page.request.get('http://localhost:4000/api/analytics/summary');
    const body = await response.json();
    expect(body.success).toBe(true);

    // Genre percentages represent each genre's share of ALL games. Games with a
    // NULL/empty genre are excluded from the genre rows, so the percentages sum
    // to <= 100 (not necessarily exactly 100).
    const genreTotalPct = body.genres.reduce((sum: number, g: any) => sum + g.percentage, 0);
    expect(genreTotalPct).toBeGreaterThan(0);
    expect(genreTotalPct).toBeLessThanOrEqual(100);

    // Genre counts must be positive. Percentages are computed against the total
    // game count (which includes games without a genre), so the ratio between
    // any two genres' percentages must equal the ratio between their counts.
    const genreCountSum = body.genres.reduce((sum: number, g: any) => sum + g.count, 0);
    expect(genreCountSum).toBeGreaterThan(0);
    for (const g of body.genres) {
      expect(g.count).toBeGreaterThan(0);
      expect(g.percentage).toBeGreaterThan(0);
    }
    if (body.genres.length >= 2) {
      const a = body.genres[0];
      const b = body.genres[1];
      const pctRatio = a.percentage / b.percentage;
      const countRatio = a.count / b.count;
      expect(Math.abs(pctRatio - countRatio)).toBeLessThan(0.05);
    }

    // Cost-per-hour: overallCph must equal totalSpent / totalHours when both > 0.
    if (body.valueSummary.totalHours > 0 && body.valueSummary.totalSpent > 0) {
      const expectedCph = body.valueSummary.totalSpent / body.valueSummary.totalHours;
      expect(Math.abs(body.valueSummary.overallCph - expectedCph)).toBeLessThan(0.02);
    }

    // Each priced breakdown row must have a consistent cph = price / hours.
    for (const b of body.valueSummary.breakdown) {
      if (b.price > 0 && b.hours > 0) {
        const expected = b.price / b.hours;
        expect(Math.abs(b.cph - expected)).toBeLessThan(0.02);
      }
    }

    // Velocity statusSummary.total must equal the sum of its buckets.
    const ss = body.velocity.statusSummary;
    expect(ss.completed + ss.inProgress + ss.unplayed).toBe(ss.total);
  });

  test('4. Offline rendering works from the IndexedDB cache', async ({ page, context }: { page: any, context: any }) => {
    // Populate the analytics cache while online.
    await page.goto('http://localhost:4000/#/analytics');
    await page.waitForSelector('#page-analytics');
    await page.waitForFunction(() => {
      return window.__analyticsHelpers && window.OfflineStorage && window.OfflineStorage.isSupported();
    }, { timeout: 15000 });

    // Wait for the donut to render (data fetched and cached).
    await page.waitForFunction(() => {
      return document.querySelector('.analytics-donut') !== null;
    }, { timeout: 15000 });

    // Confirm the analytics store now holds a cached record.
    const cached = await page.evaluate(async () => {
      const records = await window.OfflineStorage!.getAll('store_analytics');
      return records.length;
    });
    expect(cached).toBeGreaterThan(0);

    // Simulate going offline.
    await context.setOffline(true);

    // Navigate to the analytics route and confirm charts render from cache.
    await page.goto('http://localhost:4000/#/analytics');
    await page.waitForSelector('#page-analytics');
    await page.waitForFunction(() => {
      return document.querySelector('.analytics-donut') !== null;
    }, { timeout: 15000 });

    await expect(page.locator('.analytics-donut')).toBeVisible();
    await expect(page.locator('.analytics-stacked-bar')).toBeVisible();
    await expect(page.locator('.analytics-value-table')).toBeVisible();
    await expect(page.locator('.analytics-velocity-table')).toBeVisible();

    // Restore connectivity for subsequent tests.
    await context.setOffline(false);
  });

  test('5. Zero accessibility violations across chart cards', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/analytics');
    await page.waitForSelector('#page-analytics');
    await page.waitForFunction(() => {
      return document.querySelector('.analytics-donut') !== null;
    }, { timeout: 15000 });

    // Every chart card must be a region with a descriptive aria-label.
    const cards = page.locator('#page-analytics [role="region"]');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < cardCount; i++) {
      const card = cards.nth(i);
      await expect(card).toHaveAttribute('role', 'region');
      const label = await card.getAttribute('aria-label');
      expect(label).toBeTruthy();
      expect(label!.length).toBeGreaterThan(0);
    }

    // The donut and sparkline SVGs must expose accessible names.
    const donut = page.locator('.analytics-donut');
    await expect(donut).toHaveAttribute('role', 'img');
    await expect(donut).toHaveAttribute('aria-label', 'Genre breakdown donut chart');

    const sparkline = page.locator('.analytics-sparkline').first();
    await expect(sparkline).toHaveAttribute('role', 'img');
    await expect(sparkline).toHaveAttribute('aria-label', 'Trend sparkline');

    // No chart card may be left in a loading state (spinner removed).
    const spinnerCount = await page.locator('#page-analytics .animate-spin').count();
    expect(spinnerCount).toBe(0);

    // No chart card may show an error state. This is scoped to the original
    // four cards: the Sprint 29 velocity/sessions cards legitimately use
    // text-rose-400 for the "Stalled" badge and count, which is not an error.
    const errorCount = await page.locator(
      '#analytics-genre-body .text-rose-400, ' +
      '#analytics-platform-body .text-rose-400, ' +
      '#analytics-value-body .text-rose-400, ' +
      '#analytics-velocity-body .text-rose-400'
    ).count();
    expect(errorCount).toBe(0);
  });
});
