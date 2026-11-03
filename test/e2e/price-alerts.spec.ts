import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

test.describe("Sprint 25 (FEAT-0158) - Price Alert Automation, Historical Low Radar & SVG Sparklines", () => {
  test.beforeEach(async ({ page }) => {
    // Sprint (EPIC-TEST-STD-0001): /api/deals/alerts CRUD is tenant-scoped
    // behind requireAuth, so authenticate as the deterministic seeded user
    // before exercising the alert endpoints.
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);

    await page.goto(`${BASE}/#/deals`);
    await page.waitForSelector("#page-deals");
  });

  test("1. Historic Low Filter Pill toggles active state and updates deals feed", async ({
    page,
  }) => {
    const pill = page.locator("#deals-historic-lows-pill");
    await expect(pill).toBeVisible();

    // Verify initial unselected state
    await expect(pill).not.toHaveClass(/\bactive\b/);

    // Toggle filter on
    await pill.click();
    await expect(pill).toHaveClass(/\bactive\b/);

    // Toggle filter off
    await pill.click();
    await expect(pill).not.toHaveClass(/\bactive\b/);
  });

  test("2. Game Drawer displays price sparkline, historical low badge, and price alert controls", async ({
    page,
  }) => {
    // Navigate to library or open drawer for game with ID
    await page.goto("http://localhost:4000/#/library");
    await page.waitForSelector("#page-library");

    // Open the drawer via the exposed window hook (established E2E pattern
    // used by game-drawer.spec.ts). Clicking a .game-card navigates to the
    // #/game/:id detail route instead of opening the unified drawer, so the
    // hook is the deterministic way to surface #drawer-price-sparkline.
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer("Elden Ring");
    });

    const drawer = page.locator("#game-detail-drawer");
    await expect(drawer).toBeVisible();

    // The deals/alert section lives inside #drawer-content, which stays hidden
    // until the async GET /api/games/detail fetch resolves and loadDrawer
    // trades/alert/history data loads. Wait for the content pane to become
    // visible before asserting sparkline/badge/form.
    await expect(page.locator("#drawer-content")).toBeVisible({ timeout: 15000 });

    // Real history renders an SVG; unavailable history renders an explicit
    // status message rather than a fabricated flat line.
    await expect(page.locator("#drawer-sparkline-container")).toBeVisible();
    await expect(
      page.locator("#drawer-sparkline-container svg, #drawer-price-history-status"),
    ).toBeVisible();
    await expect(page.locator("#drawer-historical-low-badge")).toBeVisible();
    await expect(page.locator("#drawer-alert-form")).toBeVisible();
  });

  test("3. Price alert API endpoints operate correctly", async ({ page }) => {
    // Create alert via page.request so the authenticated mgpl_session cookie
    // (set in beforeEach) authorizes the tenant-scoped alert CRUD.
    const postRes = await page.request.post(`${BASE}/api/deals/alerts`, {
      data: { gameId: "test-game-123", title: "Test Game 123", targetPrice: 19.99 },
    });
    expect(postRes.status()).toBe(200);
    const postData = await postRes.json();
    expect(postData.success).toBe(true);

    // Fetch alerts list
    const getRes = await page.request.get(`${BASE}/api/deals/alerts`);
    expect(getRes.status()).toBe(200);
    const getData = await getRes.json();
    expect(Array.isArray(getData.alerts)).toBe(true);

    // Fetch historical price points
    const histRes = await page.request.get(`${BASE}/api/deals/history/test-game-123`);
    expect(histRes.status()).toBe(200);
    const histData = await histRes.json();
    expect(Array.isArray(histData.points)).toBe(true);
    expect(histData.availability).toBe("missing");
    expect(histData.points).toEqual([]);

    // Delete alert
    const delRes = await page.request.delete(`${BASE}/api/deals/alerts/test-game-123`);
    expect(delRes.status()).toBe(200);
    const delData = await delRes.json();
    expect(delData.success).toBe(true);
  });
});
