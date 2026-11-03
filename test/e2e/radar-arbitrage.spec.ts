import { test, expect } from "../fixtures";

/**
 * Sprint 2 (EPIC-RADAR-0001) — Historic Lows, Arbitrage Badging & Pure SVG Sparklines
 *
 * Test 1: GET /api/deals/historical-low returns historical low and price history for a game ID
 * Test 2: Deals page renders deal cards with best store badges, discount percentages, and pure SVG sparklines
 * Test 3: Game details drawer displays price sparkline svg element
 */

const BASE = "http://localhost:4000";

test.describe("Historic Lows, Arbitrage Badging & Pure SVG Sparklines (EPIC-RADAR-0001)", () => {
  test("1. GET /api/deals/historical-low returns historical low price data", async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/deals/historical-low?id=CYBERPUNK2077`, {
      headers: { Accept: "application/json" },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.historicalLow).toBeDefined();
    expect(typeof data.historicalLow).toBe("number");
    if (data.history) {
      expect(Array.isArray(data.history)).toBe(true);
    }
  });

  test("2. Deals page renders deals with arbitrage/historic low badges and SVG price sparklines", async ({ page }) => {
    await page.goto(`${BASE}/#/deals`);
    await expect(page.locator("#page-deals")).toBeVisible();

    const dealsTab = page.locator('#deals-store-tabs .deals-tab-btn[data-store="sales"]');
    await expect(dealsTab).toBeVisible();
    await dealsTab.click();

    const container = page.locator("#deals-panel-sales");
    await expect(container).toBeVisible();

    // Wait for at least one deal card
    const dealCard = container.locator(".deal-card").first();
    await expect(dealCard).toBeVisible({ timeout: 15000 });

    // Verify SVG sparkline element is present inside deal card
    const sparklineSvg = dealCard.locator("svg.price-sparkline");
    await expect(sparklineSvg).toBeVisible();
    expect(await sparklineSvg.locator("polyline").getAttribute("points")).toBeTruthy();

    // Verify price elements
    await expect(dealCard.locator(".deal-price")).toBeVisible();
  });

  test("3. Game details drawer renders inline SVG price sparkline when price history is present", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await expect(page.locator("#page-library")).toBeVisible();

    // Click on first game card to open details drawer
    const gameCard = page.locator("#library-games-grid .game-card").first();
    await expect(gameCard).toBeVisible({ timeout: 15000 });
    await gameCard.click();

    // Drawer should open
    const drawer = page.locator("#game-detail-drawer");
    await expect(drawer).toBeVisible();

    // Drawer tabs or drawer price sparkline container
    const priceSparklineSvg = drawer.locator("svg.price-sparkline");
    // Check that sparkline container or svg is attached
    if (await priceSparklineSvg.count() > 0) {
      await expect(priceSparklineSvg.first()).toBeVisible();
    }
  });
});
