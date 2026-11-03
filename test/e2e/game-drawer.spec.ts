import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:4000';

const ALEX = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

test.describe('Unified Cross-Hub Game Drawer & Aggregated Detail API (FEAT-0148)', () => {

  test.beforeEach(async ({ page }: { page: any }) => {
    // Sprint (EPIC-TEST-STD-0001): price-alert CRUD is tenant-scoped behind
    // requireAuth (src/routes/alerts.ts), so authenticate as the deterministic
    // seeded user before seeding alerts via /api/deals/alerts.
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);

    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');
  });

  test('1. Drawer opens on game item and exposes accessible dialog semantics', async ({ page }: { page: any }) => {
    // Open the drawer via the exposed window hook (established E2E pattern).
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });

    const drawer = page.locator('#game-detail-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(drawer).toHaveAttribute('aria-label', 'Game Details');
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');

    // Title should reflect the requested game.
    await expect(page.locator('#game-detail-title')).toHaveText('Elden Ring');

    // Close button must be accessible.
    await expect(page.locator('#game-detail-close')).toHaveAttribute('aria-label', 'Close details');
  });

  test('2. Aggregated metrics render (HLTB, Deals/Alerts, Fleet rating, Installed mods)', async ({ page }: { page: any }) => {
    // Seed a price alert so the Deals section has data to render.
    const alertResponse = await page.request.post(`${BASE}/api/deals/alerts`, {
      data: {
        gameTitle: 'Elden Ring',
        price: 39.99,
        targetPrice: 40.0,
        historicalLow: 34.99,
      },
    });
    expect(alertResponse.ok()).toBeTruthy();

    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });

    // Wait for the aggregated content to populate.
    await page.waitForFunction(() => {
      const content = document.getElementById('drawer-content');
      return content && !content.classList.contains('hidden');
    }, { timeout: 15000 });

    // Fleet Headroom rating should be a valid playability label.
    const fleetRating = await page.locator('#drawer-fleet-rating').textContent();
    expect(fleetRating).toMatch(/Optimal|Playable|Tweaks Needed/);

    // Deals & Alerts section should reflect the seeded alert.
    await expect(page.locator('#drawer-deals')).toContainText('price alert');

    // HLTB section should expose the three time-to-beat slots (may be "—" if uncached).
    await expect(page.locator('#drawer-hltb-main')).toBeVisible();
    await expect(page.locator('#drawer-hltb-extra')).toBeVisible();
    await expect(page.locator('#drawer-hltb-complete')).toBeVisible();

    // Installed Mods section should render (empty state or populated list).
    await expect(page.locator('#drawer-mods')).toBeVisible();
  });

  test('3. Aggregated detail API returns unified payload', async ({ page }: { page: any }) => {
    const res = await page.request.get(`${BASE}/api/games/detail?title=Elden%20Ring`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.gameTitle).toBe('Elden Ring');
    expect(body.gameDomain).toBe('eldenring');
    expect(body.deals).toBeTruthy();
    expect(Array.isArray(body.deals.alerts)).toBe(true);
    expect(typeof body.deals.alertCount).toBe('number');
    expect(body.mods).toBeTruthy();
    expect(typeof body.mods.count).toBe('number');
    expect(Array.isArray(body.mods.installedMods)).toBe(true);
    expect(body.hltb).toBeTruthy();
    expect(body.fleetHeadroom).toBeTruthy();
    expect(typeof body.fleetHeadroom.rating).toBe('string');
  });

  test('4. Drawer closes via close button, backdrop, and Escape key', async ({ page }: { page: any }) => {
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    await expect(page.locator('#game-detail-drawer')).toBeVisible();

    // Close via the accessible close button.
    await page.locator('#game-detail-close').click();
    await expect(page.locator('#game-detail-drawer')).toBeHidden();

    // Reopen and close via backdrop click.
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await page.locator('#game-detail-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#game-detail-drawer')).toBeHidden();

    // Reopen and close via Escape key.
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#game-detail-drawer')).toBeHidden();
  });

  test('5. No accessibility violations on interactive drawer elements', async ({ page }: { page: any }) => {
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    await expect(page.locator('#game-detail-drawer')).toBeVisible();

    // The dialog must be labelled and the close control must have an accessible name.
    const dialog = page.locator('#game-detail-drawer');
    await expect(dialog).toHaveAttribute('aria-label', 'Game Details');
    await expect(dialog).toHaveAttribute('role', 'dialog');

    const closeBtn = page.locator('#game-detail-close');
    await expect(closeBtn).toHaveAttribute('aria-label', 'Close details');
    await expect(closeBtn).toBeEnabled();

    // Backdrop must be dismissible and not trap focus on a hidden element.
    const backdrop = page.locator('#game-detail-backdrop');
    await expect(backdrop).toBeVisible();
  });
});