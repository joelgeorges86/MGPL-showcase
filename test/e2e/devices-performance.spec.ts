import { test, expect } from '@playwright/test';

/**
 * Sprint 3 (EPIC-DEV-001) — Cross-Library Performance Matrix, Two-Device
 * Compare & Upgrade Advisor E2E Spec.
 *
 * 1. The Performance grid renders library games with color-coded FPS cells
 *    across all four resolution tiers.
 * 2. Switching reference devices updates FPS projections in real time.
 * 3. Side-by-side comparison mode displays performance deltas and summary
 *    metrics.
 * 4. The Upgrade Advisor renders actionable upgrade suggestions when library
 *    performance falls below the 70% @ 1080p threshold.
 *
 * The `game_performance_profiles` table is seeded idempotently by src/db.ts via
 * src/seed/performance.ts when the test webServer boots. The test DB is
 * pre-seeded with the game catalog + ownership rows by test/global-setup.ts, so
 * the API can compute deterministic per-device FPS matrices without network.
 */

const BASE = 'http://localhost:4000';

async function openPerformanceTab(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/#/devices`);
  await page.waitForLoadState('networkidle');
  await page.click('[data-devices-tab="performance"]');
  await expect(page.locator('#devices-panel-performance')).toBeVisible({
    timeout: 10000,
  });
}

test.describe('EPIC-DEV-001 — Devices Performance Matrix & Advisor', () => {
  test('1. Performance grid renders library games with color-coded FPS cells across all 4 resolution tiers', async ({ page }) => {
    await openPerformanceTab(page);

    const grid = page.locator('[data-testid="perf-grid"]');
    await expect(grid).toBeVisible({ timeout: 10000 });

    // The owned library (seeded) must produce multiple game rows.
    const rows = page.locator('[data-testid="perf-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    expect(await rows.count()).toBeGreaterThan(0);

    // Each row renders all four resolution-tier cells.
    const firstRow = rows.first();
    await expect(firstRow.locator('[data-perf-cell="4k"]')).toBeVisible();
    await expect(firstRow.locator('[data-perf-cell="1440"]')).toBeVisible();
    await expect(firstRow.locator('[data-perf-cell="1080"]')).toBeVisible();
    await expect(firstRow.locator('[data-perf-cell="720"]')).toBeVisible();

    // Every FPS cell is a colored badge (green/yellow/red) with an "FPS" label.
    const firstCell = firstRow.locator('[data-perf-cell="1080"]');
    await expect(firstCell).toContainText('FPS');
    const classAttr = (await firstCell.getAttribute('class')) || '';
    expect(classAttr).toMatch(/text-(emerald|amber|rose)-300/);
  });

  test('2. Switching reference devices updates FPS projections in real time', async ({ page }) => {
    await openPerformanceTab(page);

    const select = page.locator('#perf-device-select');
    await expect(select).toBeVisible({ timeout: 10000 });

    // Read the 1080p cell of the first row for the default device.
    const firstCell = page.locator('[data-testid="perf-row"] [data-perf-cell="1080"]').first();
    await expect(firstCell).toBeVisible({ timeout: 10000 });
    const before = await firstCell.textContent();

    // Select a far-apart catalog device (Switch = Entry/Entry). The option value
    // uses "source::id".
    await select.selectOption('catalog::switch-classic');
    await expect(firstCell).toBeVisible({ timeout: 10000 });

    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-testid="perf-row"] [data-perf-cell="1080"]');
        return el && el.textContent !== prev;
      },
      before,
      { timeout: 10000 },
    );
  });

  test('3. Side-by-side comparison mode displays performance deltas and summary metrics', async ({ page }) => {
    await openPerformanceTab(page);

    // Enable the comparison toggle to expose the Device B selector.
    await page.check('#perf-compare-toggle');
    await expect(page.locator('#perf-device-select-b')).toBeVisible({ timeout: 5000 });

    // Select a low-tier device A and a high-tier device B.
    await page.locator('#perf-device-select').selectOption('catalog::switch-classic');
    await page.locator('#perf-device-select-b').selectOption('catalog::alienware-aurora-r15');

    // Explicit Analyze click (multi-variable state requires a user action).
    await page.click('#perf-analyze-btn');

    const compareTable = page.locator('[data-testid="perf-compare-table"]');
    await expect(compareTable).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="perf-compare-row"]').first()).toBeVisible();

    // Summary header metric renders an average 1080p delta.
    await expect(page.locator('[data-testid="perf-compare-avg-delta"]')).toBeVisible();

    // Delta cells highlight B wins (green) and B losses (red), deterministically
    // present when comparing Entry/Entry vs Flagship/Flagship.
    await expect(page.locator('[data-testid="perf-delta-win"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('4. Upgrade advisor renders actionable upgrade suggestions when library performance falls below threshold', async ({ page }) => {
    await openPerformanceTab(page);

    // Choose the lowest-tier catalog device to force <70% @ 1080p.
    await page.locator('#perf-device-select').selectOption('catalog::switch-classic');

    // Advisor heading + advisory cards appear once the matrix recomputes.
    const advisor = page.locator('#perf-advisor');
    await expect(advisor.locator('[data-testid="perf-advisor-heading"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(advisor.locator('[data-testid="perf-advice"]').first()).toBeVisible();
    expect(await advisor.locator('[data-testid="perf-advice"]').count()).toBeGreaterThanOrEqual(3);
  });
});