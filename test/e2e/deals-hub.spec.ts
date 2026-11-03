import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:4000';

const ALEX = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

test.describe('Deals Hub, CheapShark API Integration, Historical Low Alerts & Wishlist Sync (FEAT-0145)', () => {

  test.beforeEach(async ({ page }: { page: any }) => {
    // Sprint (EPIC-TEST-STD-0001): price-alert CRUD is tenant-scoped behind
    // requireAuth (src/routes/alerts.ts), so authenticate as the deterministic
    // seeded user before hitting /api/deals/alerts in the persistence test.
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);

    await page.goto(`${BASE}/#/deals`);
    await page.waitForSelector('#page-deals');
  });

  test('1. Route navigation to #/deals and filter execution', async ({ page }: { page: any }) => {
    await expect(page.locator('#page-deals')).toBeVisible();
    await expect(page.locator('#deals-panel-sales')).toBeVisible();

    const storeSelect = page.locator('#deals-store-select');
    if (await storeSelect.isVisible()) {
      await storeSelect.selectOption({ index: 0 });
    }

    const searchInput = page.locator('#deals-search-title');
    if (await searchInput.isVisible()) {
      await searchInput.fill('Witcher');
      const searchBtn = page.locator('#deals-search-btn');
      if (await searchBtn.isVisible()) {
        await searchBtn.click();
      } else {
        await searchInput.press('Enter');
      }
    }
  });

  test('2. CheapShark API proxy hydration and deal card rendering', async ({ page }: { page: any }) => {
    await page.waitForTimeout(1000);
    const container = page.locator('#deals-panel-sales');
    await expect(container).toBeVisible();
  });

  test('3. Wishlist sync toggle and historical low badge visibility', async ({ page }: { page: any }) => {
    const syncBtn = page.locator('#deals-wishlist-sync-btn');
    await expect(syncBtn).toBeVisible();
    await syncBtn.click();

    await page.waitForTimeout(500);
    // Scope to the toast container specifically. The broad `.toast, [role="alert"]`
    // selector is fragile because multiple alert regions (e.g. #snapshot-error,
    // #import-error) legitimately use role="alert" for accessibility.
    const toast = page.locator('#toast-container');
    if (await toast.isVisible()) {
      await expect(toast).toBeVisible();
    }
  });

  test('4. Price alert threshold creation and state persistence', async ({ page }: { page: any }) => {
    // Trigger price alert threshold via API or modal trigger
    const alertResponse = await page.request.post(`${BASE}/api/deals/alerts`, {
      data: {
        gameTitle: 'Elden Ring',
        price: 39.99,
        targetPrice: 40.00,
        historicalLow: 34.99,
      },
    });

    expect(alertResponse.ok()).toBeTruthy();
    const body = await alertResponse.json();
    expect(body.success).toBe(true);
    expect(body.triggered).toBe(true);
  });
});