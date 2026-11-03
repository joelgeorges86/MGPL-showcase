import { test, expect, runAxeScan } from "../fixtures";


const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

/**
 * Sprint 32 (FEAT-0166) — Live Storefront Proxy, Real-Time Alerts & Notification Engine.
 *
 * Test 1: Navigate to #/wishlist and click "Sync Live Deals" to trigger the live
 *         storefront price refresh (accepts either 'cheapshark' or 'synthesis' source).
 * Test 2: Price updates and threshold alert state transitions (isTriggered indicator).
 * Test 3: Authorized retailer taxonomy (Direct Platform vs Authorized Retailer) persists
 *         with live records.
 * Test 4: Zero accessibility violations across the updated Wishlist and Settings interfaces.
 *
 * Sprint (EPIC-TEST-STD-0001): Wishlist routes are tenant-scoped behind requireAuth,
 * so this suite authenticates as the deterministic seeded user (alex.gamer) in
 * beforeEach and drives every API call through `page.request` (which shares the
 * browser cookie jar) instead of the isolated `request` fixture (which would 401).
 */

test.describe("Sprint 32 (FEAT-0166) - Live Storefront Proxy, Real-Time Alerts & Notification Engine", () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as Alex so the browser page AND page.request share the
    // mgpl_session cookie.
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: ALEX,
    });
    expect(login.status()).toBe(200);

    // Clear any leftover wishlist entries so each test starts from a clean slate.
    const listRes = await page.request.get(`${BASE}/api/wishlist`);
    if (listRes.status() === 200) {
      const listData = await listRes.json();
      const items = listData.wishlist || [];
      for (const item of items) {
        await page.request.delete(`${BASE}/api/wishlist/${encodeURIComponent(item.gameId || item.id)}`);
      }
    }
  });

  test("1. Sync Live Deals button triggers a live storefront price refresh", async ({ page }) => {
    // Seed a game so the sync has a row to process.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "live-e2e-sync", title: "Hades", targetPrice: 19.99 },
    });

    await page.goto(`${BASE}/#/wishlist`);
    await page.waitForSelector("#page-wishlist");

    // The Sync Live Deals button is present in the wishlist header.
    const syncBtn = page.locator("#btn-sync-live-prices");
    await expect(syncBtn).toBeVisible();

    // Register the response waiter BEFORE clicking to avoid a race condition.
    const responsePromise = page.waitForResponse(
      (res) => res.url().includes("/api/wishlist/refresh-prices")
    );

    // Click it. The sync may complete in milliseconds (synthesis fallback), so we
    // do NOT assert on the transient "Syncing..." loading state — we wait for the
    // response and confirm the button returns to its idle label.
    await syncBtn.click();

    // The refresh-prices response is network-resilient: accept either live or synthesis.
    const response = await responsePromise;
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(["cheapshark", "synthesis"]).toContain(data.source);

    // The button returns to its idle label after the sync completes.
    await expect(syncBtn).toContainText("Sync Live Deals", { timeout: 15000 });

    // The seeded game still renders in the grid after hot rehydration.
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Hades");

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/live-e2e-sync`);
  });

  test("2. Price updates and threshold alert state transitions (isTriggered indicator)", async ({ page }) => {
    // Seed a game with a very high target so the best price is guaranteed <= target.
    const gameId = "live-e2e-triggered";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Live Triggered Game", targetPrice: 9999 },
    });

    await page.goto(`${BASE}/#/wishlist`);
    await page.waitForSelector("#page-wishlist");

    // Register the response waiter BEFORE clicking to avoid a race condition.
    const responsePromise = page.waitForResponse(
      (res) => res.url().includes("/api/wishlist/refresh-prices")
    );

    // Trigger the live sync.
    await page.locator("#btn-sync-live-prices").click();
    await responsePromise;

    // The card is flagged as triggered after the sync.
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-triggered", "1");
    await expect(card).toContainText("Below Target");

    // The on-sale feed reflects the triggered state.
    const onSaleRes = await page.request.get(`${BASE}/api/wishlist/on-sale`);
    expect(onSaleRes.status()).toBe(200);
    const onSaleData = await onSaleRes.json();
    const found = onSaleData.wishlistDeals.find((d: any) => d.gameID === gameId);
    expect(found).toBeTruthy();
    expect(found.isTriggered).toBe(true);

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("3. Authorized retailer taxonomy persists with live records", async ({ page }) => {
    const gameId = "live-e2e-taxonomy";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Taxonomy Game", targetPrice: 29.99 },
    });

    await page.goto(`${BASE}/#/wishlist`);
    await page.waitForSelector("#page-wishlist");

    // Register the response waiter BEFORE clicking to avoid a race condition.
    const responsePromise = page.waitForResponse(
      (res) => res.url().includes("/api/wishlist/refresh-prices")
    );

    // Trigger the live sync.
    await page.locator("#btn-sync-live-prices").click();
    await responsePromise;

    // The matrix table renders both Direct Platforms and Authorized Key Retailers.
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();
    const matrix = card.locator(".wishlist-matrix-table");
    await expect(matrix).toBeVisible();

    const storeTexts = await matrix.locator("tbody tr td:first-child").allTextContents();
    const joined = storeTexts.join(" ");
    expect(joined).toContain("Steam");
    expect(joined).toContain("GOG");
    expect(joined).toContain("Epic");
    expect(joined).toContain("Fanatical");
    expect(joined).toContain("Green Man Gaming");
    expect(joined).toContain("Gamesplanet");
    expect(joined).toContain("Humble Store");

    // Authorized key retailers are tagged with the 🔑 Authorized badge.
    const authorizedTags = await matrix
      .locator("tbody tr", { hasText: "Fanatical" })
      .locator("text=🔑 Authorized")
      .count();
    expect(authorizedTags).toBeGreaterThanOrEqual(1);

    // Direct platforms are tagged as Direct.
    const directTags = await matrix
      .locator("tbody tr", { hasText: "Steam" })
      .locator("text=Direct")
      .count();
    expect(directTags).toBeGreaterThanOrEqual(1);

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("4. Zero accessibility violations across Wishlist and Settings interfaces", async ({ page }: { page: any }) => {
    // Seed a game so the wishlist grid renders populated content for the audit.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "live-e2e-a11y", title: "Hades", targetPrice: 24.99 },
    });

    await page.goto(`${BASE}/#/wishlist`);
    await page.waitForSelector("#page-wishlist");
    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Hades");

    // Run a local axe-core accessibility audit on the Wishlist interface.
    const wishlistResults = await runAxeScan(page);
    expect(wishlistResults.error).toBeNull();
    expect(wishlistResults.violations).toEqual([]);

    // Navigate to Settings and audit the updated Deal Alerts & Notifications card.
    await page.goto(`${BASE}/#/settings`);
    await page.waitForSelector("#page-settings");
    await expect(page.locator("#btn-enable-notifications")).toBeVisible();
    await expect(page.locator("#notification-permission-status")).toBeVisible();

    const settingsResults = await runAxeScan(page);
    expect(settingsResults.error).toBeNull();
    expect(settingsResults.violations).toEqual([]);


    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/live-e2e-a11y`);
  });
});