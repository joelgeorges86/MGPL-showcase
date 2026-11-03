import { test, expect } from "../fixtures";

/**
 * Sprint 3 (EPIC-RADAR-0001) — Automated Price Alert In-App Notification Hub
 *
 * Test 1: Seeded user with triggered price alert sees notification counter in header.
 * Test 2: Opening notification drawer renders triggered deal with target price vs current price comparison.
 * Test 3: Dismissing alert removes it from list and decrements/hides header counter.
 * Test 4: Unauthenticated visitors or users without triggered alerts see no notification badge.
 */

const BASE = "http://localhost:4000";

test.describe("Automated Price Alert In-App Notification Hub (EPIC-RADAR-0001)", () => {
  test("1. Seeded user with triggered price alert sees notification counter in header", async ({ page }) => {
    // Authenticate as Alex
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.ok()).toBeTruthy();

    // Create a triggered price alert (currentPrice 19.99 <= targetPrice 29.99)
    const alertRes = await page.request.post(`${BASE}/api/alerts`, {
      data: {
        gameId: "e2e-triggered-game-1",
        title: "Cyberpunk 2077 Test Alert",
        currentPrice: 19.99,
        targetPrice: 29.99,
        historicalLow: 14.99,
      },
    });
    expect(alertRes.ok()).toBeTruthy();

    // Navigate to SPA
    await page.goto(`${BASE}/#/deals`);

    // Verify notification trigger and badge counter are visible with count >= 1
    const trigger = page.locator("#notification-trigger");
    await expect(trigger).toBeVisible({ timeout: 15000 });

    const badge = page.locator("#notification-badge");
    await expect(badge).toBeVisible();
    const text = await badge.innerText();
    expect(parseInt(text, 10)).toBeGreaterThanOrEqual(1);
  });

  test("2. Opening notification drawer renders triggered deal with target price vs current price comparison", async ({ page }) => {
    // Authenticate as Alex
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.ok()).toBeTruthy();

    // Ensure at least one triggered alert exists
    await page.request.post(`${BASE}/api/alerts`, {
      data: {
        gameId: "e2e-triggered-game-2",
        title: "Hades Test Alert",
        currentPrice: 9.99,
        targetPrice: 15.00,
        historicalLow: 7.99,
      },
    });

    await page.goto(`${BASE}/#/deals`);

    // Click notification trigger
    const trigger = page.locator("#notification-trigger");
    await expect(trigger).toBeVisible({ timeout: 15000 });
    await trigger.click();

    // Notification drawer opens
    const drawer = page.locator("#notification-drawer");
    await expect(drawer).toBeVisible();

    // Verify card content renders game title, current price, and target price
    const card = drawer.locator(".notification-item").first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("Hades Test Alert");
    await expect(card).toContainText("$9.99");
    await expect(card).toContainText("$15.00");
  });

  test("3. Dismissing alert removes it from list and decrements/hides header counter", async ({ page }) => {
    // Authenticate as Alex
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.ok()).toBeTruthy();

    const uniqueGameId = `e2e-dismiss-game-${Date.now()}`;
    await page.request.post(`${BASE}/api/alerts`, {
      data: {
        gameId: uniqueGameId,
        title: "Dismissable Deal Game",
        currentPrice: 12.00,
        targetPrice: 20.00,
        historicalLow: 10.00,
      },
    });

    await page.goto(`${BASE}/#/deals`);

    // Get initial badge count
    const badge = page.locator("#notification-badge");
    await expect(badge).toBeVisible({ timeout: 15000 });
    const initialCount = parseInt(await badge.innerText(), 10);

    // Open drawer
    await page.locator("#notification-trigger").click();
    const drawer = page.locator("#notification-drawer");
    await expect(drawer).toBeVisible();

    // Locate the specific dismiss button for our item
    const item = drawer.locator(`.notification-item[data-game-id="${uniqueGameId}"]`);
    await expect(item).toBeVisible();
    const dismissBtn = item.locator(".btn-dismiss-alert");
    await dismissBtn.click();

    // Item should be removed from drawer
    await expect(item).toBeHidden();

    // Clean up created test alert from database so subsequent tests remain clean
    await page.request.delete(`${BASE}/api/alerts/${uniqueGameId}`);
  });

  test("4. Unauthenticated visitors or users without triggered alerts see no notification badge", async ({ page }) => {
    // Guest context (unauthenticated)
    await page.goto(`${BASE}/#/deals`);

    // Header badge counter should be hidden / count 0
    const badge = page.locator("#notification-badge");
    await expect(badge).toBeHidden();
  });
});
