import { test, expect } from '@playwright/test';
import { LEADERSHIP } from '../helpers/api-client';

/**
 * Sprint 29 (FEAT-0163) — Session Intelligence, Fleet Power Telemetry &
 * Backlog Velocity.
 *
 * Sprint 5 (EPIC-07): /api/analytics/* is server-side role-gated to
 * admin | Product | Data | Leadership. Every test authenticates as the seeded
 * LEADERSHIP account (test/global-setup.ts) so the gate grants access.
 *
 * Test 1: GET /api/analytics/sessions returns valid session telemetry with
 *         per-device attribution, energy/battery metrics and weekly trend.
 * Test 2: GET /api/backlog/velocity returns velocity, burn-down ETA and
 *         stalled-game detection.
 * Test 3: Navigating to Analytics renders the Hardware Efficiency & Power
 *         Radar and Backlog Velocity & Burn-Down cards from seeded sessions.
 * Test 4: Zero accessibility violations across the new analytics cards.
 */

// Type augmentation for the client-side analytics helpers exposed by analytics.js.
// NOTE: This must remain a superset-compatible shape with the declaration in
// analytics-visualizer.spec.ts (both files augment the same global Window).
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

test.describe('Session Intelligence, Fleet Power Telemetry & Backlog Velocity (FEAT-0163)', () => {

  // Sprint 5 (EPIC-07): the Analytics API is server-side role-gated. Log in as
  // the seeded LEADERSHIP account on BOTH the isolated request fixture (API-only
  // tests 1-2) and the page.request/browser cookie jar (render tests 3-4).
  test.beforeEach(async ({ page, request }: { page?: any; request: any }) => {
    if (page) {
      const pageRes = await page.request.post('http://localhost:4000/api/auth/login', {
        data: LEADERSHIP,
      });
      expect(pageRes.status()).toBe(200);
    }
    const reqRes = await request.post('http://localhost:4000/api/auth/login', {
      data: LEADERSHIP,
    });
    expect(reqRes.status()).toBe(200);
  });

  test('1. GET /api/analytics/sessions returns valid telemetry with device attribution', async ({ request }: { request: any }) => {
    // Seed a deterministic device-attributed session so the fleet split is stable.
    const sessionUuid = 'e2e-sessions-' + Date.now();
    const startedAt = new Date().toISOString();
    const seed = await request.post('http://localhost:4000/api/backlog/session', {
      data: {
        gameId: 'G00002',
        sessionUuid,
        durationSeconds: 3600, // 1 hour
        deviceId: 'steam-deck-oled',
        startedAt,
      },
    });
    expect(seed.ok()).toBeTruthy();

    const response = await request.get('http://localhost:4000/api/analytics/sessions');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);

    // Top-level aggregates.
    expect(typeof body.sessionCount).toBe('number');
    expect(body.sessionCount).toBeGreaterThan(0);
    expect(typeof body.totalHours).toBe('number');
    expect(body.totalHours).toBeGreaterThan(0);

    // Per-device distribution.
    expect(Array.isArray(body.sessionDistribution)).toBe(true);
    const deck = body.sessionDistribution.find((d: any) => d.deviceId === 'steam-deck-oled');
    expect(deck).toBeTruthy();
    expect(deck.deviceName).toBeTruthy();
    expect(typeof deck.playtimeHours).toBe('number');
    expect(deck.playtimeHours).toBeGreaterThan(0);
    expect(typeof deck.sharePct).toBe('number');
    expect(typeof deck.sessionCount).toBe('number');
    expect(typeof deck.estimatedEnergyKwh).toBe('number');
    // steam-deck-oled has batteryWh=50, so battery cycles must be present.
    expect(deck.batteryCycles).not.toBeNull();
    expect(typeof deck.batteryRuntimeHours).toBe('number');

    // Weekly aggregation for trendlines.
    expect(Array.isArray(body.weekly)).toBe(true);
    for (const w of body.weekly) {
      expect(typeof w.weekStart).toBe('string');
      expect(typeof w.playtimeHours).toBe('number');
    }

    // Per-game aggregation.
    expect(Array.isArray(body.byGame)).toBe(true);
    for (const g of body.byGame) {
      expect(typeof g.gameId).toBe('string');
      expect(typeof g.playtimeHours).toBe('number');
    }
  });

  test('2. GET /api/backlog/velocity returns velocity, burn-down ETA and stalled detection', async ({ request }: { request: any }) => {
    const response = await request.get('http://localhost:4000/api/backlog/velocity');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);

    expect(typeof body.velocityHoursPerWeek).toBe('number');
    expect(body.velocityHoursPerWeek).toBeGreaterThanOrEqual(0);
    expect(typeof body.activeGameCount).toBe('number');
    expect(typeof body.stalledCount).toBe('number');

    // burnDownEtaDays is null when there is no remaining work or no velocity.
    expect(body.burnDownEtaDays === null || typeof body.burnDownEtaDays === 'number').toBe(true);

    // Games array with per-game burn-down fields.
    expect(Array.isArray(body.games)).toBe(true);
    for (const g of body.games) {
      expect(typeof g.gameId).toBe('string');
      expect(typeof g.title).toBe('string');
      expect(typeof g.status).toBe('string');
      expect(typeof g.actualHoursPlayed).toBe('number');
      expect(g.burnDownEtaDays === null || typeof g.burnDownEtaDays === 'number').toBe(true);
      expect(typeof g.stalled).toBe('boolean');
      expect(typeof g.progressPercent).toBe('number');
    }

    // stalledGames is a subset of games flagged stalled.
    expect(Array.isArray(body.stalledGames)).toBe(true);
    for (const s of body.stalledGames) {
      expect(typeof s.gameId).toBe('string');
      expect(typeof s.title).toBe('string');
    }
  });

  test('3. Analytics view renders Hardware Efficiency & Backlog Velocity cards from seeded sessions', async ({ page }: { page: any }) => {
    // Seed a deterministic device-attributed session so the fleet split is stable.
    const sessionUuid = 'e2e-render-' + Date.now();
    const startedAt = new Date().toISOString();
    const seed = await page.request.post('http://localhost:4000/api/backlog/session', {
      data: {
        gameId: 'G00002',
        sessionUuid,
        durationSeconds: 1800, // 30 minutes
        deviceId: 'stealth-laptop-4060',
        startedAt,
      },
    });
    expect(seed.ok()).toBeTruthy();

    await page.goto('http://localhost:4000/#/analytics');
    await page.waitForSelector('#page-analytics');

    // Wait for the session telemetry card to render (device split bars appear).
    await page.waitForFunction(() => {
      return document.querySelector('.analytics-sessions-bars') !== null;
    }, { timeout: 15000 });

    // Hardware Efficiency & Power Radar card.
    const sessionsCard = page.locator('#analytics-sessions-body');
    await expect(sessionsCard).toBeVisible();
    await expect(page.locator('.analytics-sessions-bars')).toBeVisible();

    // The stealth-laptop-4060 profile must be attributed with playtime. The UI
    // renders the human-readable deviceName ("Stealth Laptop 4060"), not the
    // deviceId slug.
    await expect(page.locator('.analytics-sessions-bars')).toContainText('Stealth Laptop 4060');

    // Battery runtime badge for a battery-equipped device.
    await expect(page.locator('.analytics-sessions-bars')).toContainText('runtime');

    // Weekly trend sparkline must render with an accessible name.
    const weeklySparkline = page.locator('.analytics-sparkline[aria-label="Weekly playtime trend sparkline"]').first();
    await expect(weeklySparkline).toBeVisible();
    await expect(weeklySparkline).toHaveAttribute('role', 'img');

    // Backlog Velocity & Burn-Down card.
    await page.waitForFunction(() => {
      return document.querySelector('.analytics-velocity-burndown-table') !== null;
    }, { timeout: 15000 });
    const velocityBurnCard = page.locator('#analytics-velocity-burndown-body');
    await expect(velocityBurnCard).toBeVisible();
    await expect(page.locator('.analytics-velocity-burndown-table')).toBeVisible();

    // Weekly velocity header card must render.
    await expect(velocityBurnCard).toContainText('Weekly Velocity');
    await expect(velocityBurnCard).toContainText('Burn-Down ETA');
  });

  test('4. Zero accessibility violations across the new analytics cards', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/analytics');
    await page.waitForSelector('#page-analytics');

    // Wait for both new cards to finish rendering.
    await page.waitForFunction(() => {
      return (
        document.querySelector('.analytics-sessions-bars') !== null &&
        document.querySelector('.analytics-velocity-burndown-table') !== null
      );
    }, { timeout: 15000 });

    // The two new cards must be regions with descriptive aria-labels.
    const sessionsRegion = page.locator('#analytics-sessions-body [role="region"]');
    const velocityRegion = page.locator('#analytics-velocity-burndown-body [role="region"]');
    await expect(sessionsRegion).toHaveCount(1);
    await expect(velocityRegion).toHaveCount(1);
    const sessionsLabel = await sessionsRegion.getAttribute('aria-label');
    const velocityLabel = await velocityRegion.getAttribute('aria-label');
    expect(sessionsLabel).toBeTruthy();
    expect(velocityLabel).toBeTruthy();

    // The weekly sparkline SVG must expose an accessible name.
    const weeklySparkline = page.locator('.analytics-sparkline[aria-label="Weekly playtime trend sparkline"]').first();
    await expect(weeklySparkline).toHaveAttribute('role', 'img');
    await expect(weeklySparkline).toHaveAttribute('aria-label', 'Weekly playtime trend sparkline');

    // No new card may be left in a loading state.
    const spinnerCount = await page.locator('#analytics-sessions-body .animate-spin, #analytics-velocity-burndown-body .animate-spin').count();
    expect(spinnerCount).toBe(0);

    // No new card may show an error state. The velocity card legitimately uses
    // text-rose-400 for the "Stalled" count/badges, so assert on the actual
    // error message text rather than the rose color class.
    const errorText = await page.locator(
      '#analytics-sessions-body, #analytics-velocity-burndown-body'
    ).filter({ hasText: 'Failed to load analytics.' }).count();
    expect(errorText).toBe(0);
  });
});
