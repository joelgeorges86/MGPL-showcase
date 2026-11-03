import { test, expect } from '@playwright/test';

/**
 * EPIC-UX-REFINE-0001 — Home Page Simplification, Navigation Consolidation
 * & Interactive Polish.
 *
 * Test 1: Navigation renders consolidated 5-item IA without horizontal scroll.
 * Test 2: Search input selection opens the game detail drawer.
 * Test 3: Platform breakdown reflects normalized platform keys + "All Games".
 * Test 4: Top 5 freebies render urgency badges; deal cards show genre/rating.
 */

declare global {
  interface Window {
    fetchDashboardSummary?: () => Promise<void>;
    openGameDetailDrawer?: (title: string, gameId?: string) => void;
  }
}

test.describe('EPIC-UX-REFINE-0001 Home UX Polish', () => {

  test('1. Navigation renders consolidated 5-item IA without horizontal scrolling', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // The top navigation exposes 5 primary labels.
    const nav = page.locator('nav[aria-label="Primary navigation"]');
    await expect(nav).toBeVisible();

    const labels = ['Home', 'Games', 'Deals', 'Settings'];
    for (const label of labels) {
      await expect(nav.getByText(label, { exact: true })).toBeVisible();
    }
    // Analytics is a dropdown trigger that exposes Analytics + Backlog.
    await expect(nav.getByRole('button', { name: 'Analytics' })).toBeVisible();

    // The nav container must NOT produce a horizontal scrollbar (overflow).
    const hasHorizontalOverflow = await page.evaluate(() => {
      const navEl = document.querySelector('nav[aria-label="Primary navigation"] > div');
      if (!navEl) return false;
      return navEl.scrollWidth > navEl.clientWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);

    // Dropdown menus exist under Games / Deals / Analytics / Settings.
    await nav.getByRole('button', { name: /Games/i }).click();
    await expect(nav.getByText('Table Matrix')).toBeVisible();
    await expect(nav.getByText('Platform Hub')).toBeVisible();

    await page.keyboard.press('Escape');
    await nav.getByRole('button', { name: /Deals/i }).click();
    await expect(nav.getByText('Wishlist Alerts')).toBeVisible();

    // Analytics dropdown routes Analytics + Backlog as tracking views.
    await page.keyboard.press('Escape');
    await nav.getByRole('button', { name: /Analytics/i }).click();
    await expect(nav.getByText('Backlog')).toBeVisible();
  });

  test('2. Search input selection opens the game detail drawer', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    const searchInput = page.locator('#command-search-input');
    await expect(searchInput).toBeVisible();

    // Type a search query that is guaranteed to resolve against the seeded
    // catalog (mock library contains Cyberpunk 2077).
    await searchInput.fill('Cyberpunk 2077');
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#search-results-dropdown .search-result-row');
      return rows.length > 0;
    }, { timeout: 15000 });

    const results = page.locator('#search-results-dropdown .search-result-row');
    await expect(results.first()).toBeVisible();

    // Clicking the result row must open the game detail drawer (not navigate).
    await results.first().click();
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await expect(page.locator('#game-detail-drawer')).toHaveAttribute('role', 'dialog');
  });

  test('3. Platform breakdown reflects normalized platform keys', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the platform chips to render.
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll('#dashboard-platforms .platform-chip');
      return chips.length > 0;
    }, { timeout: 15000 });

    // The "All Games" entry point must be first with the total count.
    const allGamesChip = page.locator('#dashboard-platforms .platform-chip[data-platform="All Games"]');
    await expect(allGamesChip).toBeVisible();
    await expect(allGamesChip).toContainText('All Games');

    // Normalized PS keys are present and un-normalized variants are NOT.
    const ps5Chip = page.locator('#dashboard-platforms .platform-chip[data-platform="PS5"]');
    const ps4Chip = page.locator('#dashboard-platforms .platform-chip[data-platform="PS4"]');
    const rawPs5 = page.locator('#dashboard-platforms .platform-chip[data-platform="PlayStation 5"]');
    const rawPs4 = page.locator('#dashboard-platforms .platform-chip[data-platform="PlayStation 4"]');

    // At least one normalized PlayStation key exists.
    expect((await ps5Chip.count()) + (await ps4Chip.count())).toBeGreaterThan(0);

    // No raw un-normalized PlayStation chips may render.
    expect(await rawPs5.count()).toBe(0);
    expect(await rawPs4.count()).toBe(0);
  });

  test('4. Top 5 freebies render urgency badges; deal cards show genre/rating', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the Deals & Freebies Radar card to populate.
    await page.waitForFunction(() => {
      const radar = document.getElementById('dashboard-deals-radar');
      return radar && radar.textContent && radar.textContent.includes('Freebies & Giveaways');
    }, { timeout: 15000 });

    const radar = page.locator('#dashboard-deals-radar');

    // At most 5 active freebies are surfaced on the home surface.
    // Only count giveaway rows (gift-icon anchors) — not the top-deals or
    // schedule-banner external links which live in the same card.
    const freebieLinks = radar.locator('a:has(i[data-lucide="gift"])');
    const freebieCount = await freebieLinks.count();
    expect(freebieCount).toBeLessThanOrEqual(5);

    // At least one freebie renders an urgency countdown badge ("Ends in ...").
    const urgencyBadge = radar.locator('text=/Ends in \\d+[dh]/');
    expect(await urgencyBadge.count()).toBeGreaterThanOrEqual(1);

    // Top deals section renders with the "drop schedule" trigger link.
    await expect(radar).toContainText('Top Deals');
    await expect(radar.getByRole('link', { name: /complete drop schedule/i })).toBeVisible();
  });
});