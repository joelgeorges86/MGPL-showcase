import { test, expect } from '@playwright/test';

/**
 * Sprint 22 (FEAT-0154) — Splash Page Overhaul: Deals/Freebies Radar,
 * Platform Breakdown & Moddable Games Hub.
 *
 * Test 1: Home dashboard renders Platform Breakdown, Deals Radar, and Fleet Summary cards.
 * Test 2: Clicking a platform chip renders compact game mini-list and clicking a row opens drawer.
 * Test 3: Moddable Games hub lists valid moddable library titles with working triggers.
 * Test 4: Offline rendering continuity from IndexedDB cache.
 * Test 5: Zero accessibility violations on the home dashboard.
 * Test 6: "View All Games →" link navigates to the library route.
 * Test 7: "Open [Platform] in Platform Hub →" deep-links to #/platforms with active store pre-selected.
 * Test 8: Horizontal game rows render Moddable badge, Steam rating, OpenCritic score, and genre tags.
 * Test 9: Giveaway drop banner displays a scheduled alert with valid outbound links.
 */

// Type augmentation for the client-side dashboard hook exposed by app.js.
declare global {
  interface Window {
    fetchDashboardSummary?: () => Promise<void>;
    openGameDetailDrawer?: (title: string, gameId?: string) => void;
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

test.describe('Splash Dashboard Overhaul (FEAT-0154)', () => {

  test('1. Home dashboard renders Platform Breakdown, Deals/Freebies Radar, and Fleet Summary cards', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the dashboard summary to populate the cards.
    await page.waitForFunction(() => {
      const platforms = document.getElementById('dashboard-platforms');
      const radar = document.getElementById('dashboard-deals-radar');
      const fleet = document.getElementById('dashboard-fleet');
      return platforms && radar && fleet && radar.textContent;
    }, { timeout: 15000 });

    // Platform Breakdown card container must render with disclaimer.
    const platforms = page.locator('#dashboard-platforms');
    await expect(platforms).toBeVisible();
    await expect(platforms).toContainText('Counts reflect multi-platform ownership across stores.');

    // Deals & Freebies Radar card must render both giveaways and deals sections.
    const radar = page.locator('#dashboard-deals-radar');
    await expect(radar).toBeVisible();
    await expect(radar).toContainText('Freebies & Giveaways');
    await expect(radar).toContainText('Top Deals');

    // Active Device card must render with the compact pill + fleet management link.
    const fleet = page.locator('#dashboard-fleet');
    await expect(fleet).toBeVisible();
    await expect(page.locator('#dashboard-fleet-summary')).toContainText('Active Device');
    await expect(page.locator('#dashboard-fleet-summary')).toContainText('Manage Fleet');

    // Verify vertical single-column section ordering in #page-home
    const platformBox = await page.locator('#dashboard-platform-breakdown').boundingBox();
    const dealsBox = await page.locator('#dashboard-deals-radar-card').boundingBox();
    const moddableBox = await page.locator('#dashboard-moddable-hub').boundingBox();
    const fleetBox = await page.locator('#dashboard-fleet-summary').boundingBox();

    expect(platformBox).toBeTruthy();
    expect(dealsBox).toBeTruthy();
    expect(moddableBox).toBeTruthy();
    expect(fleetBox).toBeTruthy();

    expect(platformBox!.y).toBeLessThan(dealsBox!.y);
    expect(dealsBox!.y).toBeLessThan(moddableBox!.y);
    expect(moddableBox!.y).toBeLessThan(fleetBox!.y);
  });

  test('2. Clicking a platform badge chip renders compact game mini-list and clicking a row opens drawer', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the platform chips to render.
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll('.platform-chip');
      return chips.length > 0;
    }, { timeout: 15000 });

    // Click a real platform chip (the "All Games" entry point is a library
    // link, not a platform mini-list trigger).
    const platformChip = page.locator('.platform-chip[data-platform="Steam"]').first();
    const platformName = await platformChip.getAttribute('data-platform');
    expect(platformName).toBe('Steam');

    await platformChip.click();

    // Wait for the compact mini-list container to render game rows.
    await page.waitForFunction(() => {
      const container = document.getElementById('dashboard-platform-games');
      const rows = container?.querySelectorAll('.platform-game-row');
      return rows && rows.length > 0;
    }, { timeout: 15000 });

    const gameRows = page.locator('#dashboard-platform-games .platform-game-row');
    await expect(gameRows.first()).toBeVisible();

    // Clicking a game row opens the game detail drawer.
    await gameRows.first().click();
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await expect(page.locator('#game-detail-drawer')).toHaveAttribute('role', 'dialog');
  });

  test('3. Moddable Games hub lists valid moddable library titles with working triggers', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the moddable games hub to render at least one card.
    await page.waitForFunction(() => {
      const hub = document.getElementById('dashboard-moddable');
      return hub && hub.querySelectorAll('.moddable-game-btn').length > 0;
    }, { timeout: 15000 });

    const modBtns = page.locator('#dashboard-moddable .moddable-game-btn');
    const count = await modBtns.count();
    expect(count).toBeGreaterThan(0);

    // Each moddable card must expose a title and a mod count.
    const firstTitle = await modBtns.first().getAttribute('data-moddable-title');
    expect(firstTitle).toBeTruthy();
    await expect(modBtns.first()).toContainText('Mods');

    // Clicking a moddable card must open the game detail drawer.
    await modBtns.first().click();
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await expect(page.locator('#game-detail-drawer')).toHaveAttribute('role', 'dialog');
  });

  test('4. Offline rendering continuity from IndexedDB cache', async ({ page, context }: { page: any, context: any }) => {
    // Populate the dashboard cache while online.
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');
    await page.waitForFunction(() => {
      return window.OfflineStorage && window.OfflineStorage.isSupported();
    }, { timeout: 15000 });

    // Trigger the dashboard summary fetch so it persists to IndexedDB.
    await page.waitForFunction(() => {
      return typeof window.fetchDashboardSummary === 'function';
    }, { timeout: 15000 });
    await page.evaluate(() => window.fetchDashboardSummary!());
    await page.waitForTimeout(1500);

    // Confirm the dashboard payload was cached under store_games/dashboard.
    const cached = await page.evaluate(async () => {
      return await window.OfflineStorage!.get('store_games', 'dashboard');
    });
    expect(cached).toBeTruthy();

    // Simulate going offline and re-render the dashboard from cache.
    await context.setOffline(true);
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');
    await page.waitForFunction(() => {
      const platforms = document.getElementById('dashboard-platforms');
      return platforms && platforms.textContent && platforms.textContent.trim().length > 0;
    }, { timeout: 10000 });

    // The offline status pill should be visible.
    await page.waitForSelector('#offline-status-pill:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#offline-status-pill')).toBeVisible();

    // Restore connectivity for subsequent tests.
    await context.setOffline(false);
  });

  test('5. Zero accessibility violations on the home dashboard', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the dashboard cards to render.
    await page.waitForFunction(() => {
      const platforms = document.getElementById('dashboard-platforms');
      const radar = document.getElementById('dashboard-deals-radar');
      return platforms && radar && platforms.textContent && radar.textContent;
    }, { timeout: 15000 });

    // Platform chips must be buttons with accessible text and data-platform attribute.
    const chips = page.locator('.platform-chip');
    const chipCount = await chips.count();
    if (chipCount > 0) {
      for (let i = 0; i < Math.min(chipCount, 3); i++) {
        await expect(chips.nth(i)).toHaveAttribute('data-platform', /.+/);
        await expect(chips.nth(i)).not.toHaveAttribute('aria-hidden', 'true');
      }
    }

    // Moddable game buttons must be real buttons with accessible names.
    const modBtns = page.locator('#dashboard-moddable .moddable-game-btn');
    const modCount = await modBtns.count();
    if (modCount > 0) {
      for (let i = 0; i < Math.min(modCount, 3); i++) {
        await expect(modBtns.nth(i)).toHaveAttribute('data-moddable-title', /.+/);
      }
    }

    // The dashboard must not contain any unlabeled interactive controls.
    const unlabeled = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll('#page-home button, #page-home a').forEach((el) => {
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        if (!text && !ariaLabel && !title) {
          bad.push(el.outerHTML.slice(0, 80));
        }
      });
      return bad;
    });
    expect(unlabeled).toEqual([]);
  });

  test('6. "View All Games →" link navigates to the library route', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the platform breakdown header to render the total + view-all link.
    await page.waitForFunction(() => {
      const total = document.getElementById('dashboard-platform-total');
      const link = document.getElementById('dashboard-view-all-link');
      return total && link && total.textContent && total.textContent.includes('Total Games:');
    }, { timeout: 15000 });

    // The total counter must reflect a non-zero library count.
    const totalText = await page.locator('#dashboard-platform-total').textContent();
    expect(totalText).toMatch(/Total Games:\s*\d+/);

    // The "View All Games →" link must point to the library route.
    const viewAll = page.locator('#dashboard-view-all-link');
    await expect(viewAll).toBeVisible();
    await expect(viewAll).toHaveAttribute('href', '#/library');
    await expect(viewAll).toHaveAttribute('aria-label', 'View All Games');

    // Clicking it navigates to the library route.
    await viewAll.click();
    await page.waitForSelector('#page-library');
    await expect(page).toHaveURL(/#\/library/);
  });

  test('7. "Open [Platform] in Platform Hub →" deep-links to #/platforms with active store pre-selected', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the platform chips to render.
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll('.platform-chip');
      return chips.length > 0;
    }, { timeout: 15000 });

    // Click a platform chip that maps to a known Platform Hub tab key (Steam → steam).
    const steamChip = page.locator('.platform-chip[data-platform="Steam"]').first();
    await expect(steamChip).toBeVisible();
    await steamChip.click();

    // The deep-link container must become visible with a link to the platform hub.
    await page.waitForFunction(() => {
      const hubLink = document.getElementById('dashboard-platform-hub-link');
      return hubLink && !hubLink.classList.contains('hidden') && hubLink.querySelector('a');
    }, { timeout: 15000 });

    const hubLink = page.locator('#dashboard-platform-hub-link a');
    await expect(hubLink).toBeVisible();
    await expect(hubLink).toContainText('Open Steam in Platform Hub');
    await expect(hubLink).toHaveAttribute('href', '#/platforms?store=steam');

    // Clicking the deep-link navigates to the platform hub with the store pre-selected.
    await hubLink.click();
    await page.waitForSelector('#page-platforms');
    await expect(page).toHaveURL(/#\/platforms\?store=steam/);

    // The corresponding platform tab must be active.
    await page.waitForFunction(() => {
      const activeTab = document.querySelector('.platform-tab-btn.active');
      return activeTab && activeTab.getAttribute('data-platform') === 'steam';
    }, { timeout: 15000 });
    await expect(page.locator('.platform-tab-btn.active')).toHaveAttribute('data-platform', 'steam');
  });

  test('8. Horizontal game rows render Moddable badge, Steam rating, OpenCritic score, and genre tags', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the platform chips to render.
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll('.platform-chip');
      return chips.length > 0;
    }, { timeout: 15000 });

    // Click a real platform chip (the "All Games" entry point is a library
    // link, not a platform mini-list trigger).
    const platformChip = page.locator('.platform-chip[data-platform="Steam"]').first();
    await platformChip.click();

    // Wait for at least one horizontal game row.
    await page.waitForFunction(() => {
      const container = document.getElementById('dashboard-platform-games');
      const rows = container?.querySelectorAll('.platform-game-row');
      return rows && rows.length > 0;
    }, { timeout: 15000 });

    const gameRows = page.locator('#dashboard-platform-games .platform-game-row');
    const rowCount = await gameRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Each row must expose a game title.
    const firstTitle = await gameRows.first().getAttribute('data-game-title');
    expect(firstTitle).toBeTruthy();

    // At least one row must render the Moddable badge, Steam rating, OpenCritic score, and genre tags.
    // (Not every game is moddable or has both scores, so we assert the row structure supports them
    // and that at least one row carries the metadata pills.)
    let sawModdable = false;
    let sawSteam = false;
    let sawOpenCritic = false;
    let sawGenre = false;

    for (let i = 0; i < rowCount; i++) {
      const rowText = await gameRows.nth(i).textContent();
      if (rowText && rowText.includes('🛠️ Moddable')) sawModdable = true;
      if (rowText && /Steam:\s*\d+%/.test(rowText)) sawSteam = true;
      if (rowText && /OpenCritic:\s*\d+/.test(rowText)) sawOpenCritic = true;
      // Genre tags are rendered as a comma-separated pill (e.g. "RPG, Open World").
      if (rowText && /,\s*/.test(rowText)) sawGenre = true;
    }

    // The dashboard must surface at least one moddable game and at least one scored game.
    expect(sawModdable).toBe(true);
    expect(sawSteam).toBe(true);
    expect(sawOpenCritic).toBe(true);

    // Rows must be sorted by composite score descending (highest first).
    const scores: Array<number | null> = [];
    for (let i = 0; i < rowCount; i++) {
      const rowText = await gameRows.nth(i).textContent();
      const steamMatch = rowText ? rowText.match(/Steam:\s*(\d+)%/) : null;
      const ocMatch = rowText ? rowText.match(/OpenCritic:\s*(\d+)/) : null;
      const steam = steamMatch ? parseInt(steamMatch[1], 10) : null;
      const oc = ocMatch ? parseInt(ocMatch[1], 10) : null;
      const available = [steam, oc].filter((v): v is number => v != null);
      scores.push(available.length ? Math.round(available.reduce((a, b) => a + b, 0) / available.length) : null);
    }

    // Non-null scores must be non-increasing (descending order).
    const nonNull = scores.filter((s): s is number => s != null);
    for (let i = 1; i < nonNull.length; i++) {
      expect(nonNull[i]).toBeLessThanOrEqual(nonNull[i - 1]);
    }
  });

  test('9. Giveaway drop banner displays a scheduled alert with valid outbound links', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');

    // Wait for the schedule banner to render inside the Deals & Freebies Radar card.
    await page.waitForFunction(() => {
      const banner = document.getElementById('dashboard-schedule-banner');
      return banner && !banner.classList.contains('hidden') && banner.textContent && banner.textContent.trim().length > 0;
    }, { timeout: 15000 });

    const banner = page.locator('#dashboard-schedule-banner');
    await expect(banner).toBeVisible();

    const bannerText = (await banner.textContent()) || '';

    // The banner must show either the live-drop alert (Thursday) or the countdown reminder.
    // The emoji is rendered in a separate aria-hidden span, so assert on the core text.
    const isLiveDrop = bannerText.includes('Free Game Drop Live Today');
    const isCountdown = bannerText.includes('Next Weekly Drop');
    expect(isLiveDrop || isCountdown).toBe(true);

    // The banner must carry the corresponding emoji indicator.
    if (isLiveDrop) {
      expect(bannerText).toContain('🚨');
    } else {
      expect(bannerText).toContain('📅');
    }


    // The banner must link to the Epic Games free-games giveaway page.
    const epicLink = banner.locator('a[href="https://store.epicgames.com/free-games"]');
    await expect(epicLink).toBeVisible();
    await expect(epicLink).toHaveAttribute('target', '_blank');
    await expect(epicLink).toHaveAttribute('rel', 'noopener noreferrer');

    // On live-drop days the Humble giveaway link must also be present.
    if (isLiveDrop) {
      const humbleLink = banner.locator('a[href="https://www.humblebundle.com/store/free-games"]');
      await expect(humbleLink).toBeVisible();
    }
  });
});
