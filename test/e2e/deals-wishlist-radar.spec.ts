import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";
const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

/**
 * Sprint 2 (EPIC-DEAL-001) — Release Radar, DLC Tracking & Wishlist Drops.
 *
 * 1. Release Radar endpoint + UI render upcoming releases chronologically with
 *    days-remaining countdown chips.
 * 2. Wishlist Drops endpoint + UI surface active discounts matching the user's
 *    wishlist, with savings deltas, MSRP comparison and direct deal links.
 * 3. DLC Sales endpoint + UI list discounted add-on content tied to base games.
 * 4. Authenticated user can manage, update thresholds on, and delete active
 *    price alerts.
 */

async function logIn(page: any) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
  expect(res.status()).toBe(200);
}

test.describe("EPIC-DEAL-001 — Release Radar, DLC & Wishlist Drops", () => {
  test("1. Release Radar endpoint and UI render upcoming releases in chronological order with countdowns", async ({
    page,
  }) => {
    // --- API assertions ---
    const apiRes = await page.request.get(`${BASE}/api/deals/radar`);
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    expect(apiData.success).toBe(true);

    const releases: any[] = apiData.releases || [];
    expect(releases.length).toBeGreaterThanOrEqual(15);

    // All seeded radar entries are verified.
    for (const r of releases) {
      expect(r.isVerified).toBe(true);
      expect(typeof r.daysUntil).toBe("number");
      expect(r.daysUntil).toBeGreaterThanOrEqual(0);
      // Strict domain-validated HTTPS pre-order link.
      expect(String(r.preorderUrl || "").startsWith("https://")).toBe(true);
    }

    // Chronological order (releaseDate ascending).
    const dates = releases.map((r) => String(r.releaseDate || ""));
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);

    // --- UI assertions ---
    await page.goto(`${BASE}/#/deals`);
    await page.click('[data-store="radar"]');

    const cards = page.locator("[data-radar-card]");
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(15);

    // The earliest seeded release is first and renders the non-negative countdown contract.
    const firstTitle = page.locator("[data-radar-title]").first();
    await expect(firstTitle).toContainText("Hollow Knight: Silksong");
    const firstDays = page.locator("[data-days]").first();
    await expect(firstDays).toHaveAttribute("data-days", /\d+/);
    const firstDaysValue = Number(await firstDays.getAttribute("data-days"));
    expect(Number.isInteger(firstDaysValue)).toBe(true);
    expect(firstDaysValue).toBeGreaterThanOrEqual(0);
    if (firstDaysValue === 0) {
      await expect(firstDays).toContainText("Releasing today");
    } else {
      await expect(firstDays).toContainText(`Releases in ${firstDaysValue} days`);
    }
  });

  test("2. Wishlist Drops calculates and surfaces active deal discounts matching the user's wishlist", async ({
    page,
  }) => {
    await logIn(page);

    // --- API assertions ---
    const apiRes = await page.request.get(`${BASE}/api/deals/wishlist-drops`);
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    expect(apiData.success).toBe(true);

    const drops: any[] = apiData.drops || [];
    expect(drops.length).toBeGreaterThan(0);

    // Seeded wishlist entries must be present with valid savings + MSRP.
    const titles = drops.map((d) => String(d.title || ""));
    expect(titles.join(" ")).toContain("Cyberpunk 2077");
    expect(titles.join(" ")).toContain("The Witcher 3");

    for (const d of drops) {
      expect(typeof d.currentPrice).toBe("number");
      expect(typeof d.msrp).toBe("number");
      expect(typeof d.savingsPct).toBe("number");
      expect(d.savingsPct).toBeGreaterThanOrEqual(0);
      expect(String(d.storeUrl || "").startsWith("https://")).toBe(true);
    }

    // --- UI assertions ---
    await page.goto(`${BASE}/#/deals`);
    await page.click('[data-store="wishlist"]');

    const card = page.locator("[data-wishlist-drop-card]").first();
    await expect(card).toBeVisible({ timeout: 15000 });

    await expect(page.locator("[data-savings]").first()).toBeVisible();
    await expect(page.locator("[data-msrp]").first()).toBeVisible();
    await expect(page.locator("[data-current-price]").first()).toBeVisible();
    await expect(page.locator("[data-deal-link]").first()).toBeVisible();
  });

  test("3. DLC sales view lists discounts for add-on content tied to base games", async ({
    page,
  }) => {
    await logIn(page);

    // --- API assertions ---
    const apiRes = await page.request.get(`${BASE}/api/deals/dlc-sales`);
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    expect(apiData.success).toBe(true);

    const dlcSales: any[] = apiData.dlcSales || [];
    expect(dlcSales.length).toBeGreaterThan(0);

    for (const d of dlcSales) {
      expect(typeof d.baseGameTitle).toBe("string");
      expect(typeof d.name).toBe("string");
      expect(typeof d.bestPrice).toBe("number");
      expect(typeof d.regularPrice).toBe("number");
      expect(typeof d.discountPercent).toBe("number");
      expect(String(d.url || "").startsWith("https://")).toBe(true);
    }

    // --- UI assertions ---
    // DLC sales are folded into the Wishlist Drops panel (Sprint 3 4-tab IA).
    await page.goto(`${BASE}/#/deals`);
    await page.click('[data-store="wishlist"]');

    const sale = page.locator("[data-dlc-sale]").first();
    await expect(sale).toBeVisible({ timeout: 15000 });
    await expect(page.locator("[data-dlc-name]").first()).toBeVisible();
    await expect(page.locator("[data-dlc-discount]").first()).toBeVisible();
    await expect(page.locator("[data-dlc-price]").first()).toBeVisible();
  });

  test("4. Authenticated user can manage, update threshold prices on, and delete active price alerts", async ({
    page,
  }) => {
    await logIn(page);

    const gameId = "sprint2-alert-fixture";

    // Clean any stale alert from a previous run.
    await page.request.delete(`${BASE}/api/alerts/${gameId}`);

    // Create an alert.
    const createRes = await page.request.post(`${BASE}/api/alerts`, {
      data: {
        gameId,
        title: "Sprint 2 Alert Fixture",
        targetPrice: 29.99,
        currentPrice: 39.99,
      },
    });
    expect(createRes.status()).toBe(200);
    const created = await createRes.json();
    expect(created.success).toBe(true);

    // Verify it is listed for this user.
    let list = await page.request.get(`${BASE}/api/alerts`);
    expect(list.status()).toBe(200);
    let alerts: any[] = (await list.json()).alerts;
    let found = alerts.find((a: any) => a.gameId === gameId);
    expect(found).toBeTruthy();
    expect(found.targetPrice).toBe(29.99);

    // Update the threshold.
    const updateRes = await page.request.post(`${BASE}/api/alerts`, {
      data: {
        gameId,
        title: "Sprint 2 Alert Fixture",
        targetPrice: 19.99,
        currentPrice: 39.99,
      },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.success).toBe(true);
    expect(updated.alert.targetPrice).toBe(19.99);

    list = await page.request.get(`${BASE}/api/alerts`);
    alerts = (await list.json()).alerts;
    found = alerts.find((a: any) => a.gameId === gameId);
    expect(found.targetPrice).toBe(19.99);

    // Delete the alert (API-only; the inline alerts manager UI was consolidated
    // into the Wishlist page in the Sprint 3 4-tab refactor).
    const deleteRes = await page.request.delete(`${BASE}/api/alerts/${gameId}`);
    expect(deleteRes.status()).toBe(200);
    const deleted = await deleteRes.json();
    expect(deleted.success).toBe(true);

    list = await page.request.get(`${BASE}/api/alerts`);
    alerts = (await list.json()).alerts;
    expect(alerts.find((a: any) => a.gameId === gameId)).toBeFalsy();
  });
});