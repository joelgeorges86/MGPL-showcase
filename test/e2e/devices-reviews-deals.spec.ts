import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";
const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

/**
 * Sprint 4 (EPIC-DEV-001) — Hardware Deals, Price History, Alerts & Verified
 * Community Reviews E2E spec.
 *
 * 1. Device detail modal renders seller links + a 12-month SVG price history.
 * 2. Authenticated user can set a hardware price drop alert.
 * 3. Submitting a review for an owned device auto-applies the Verified Owner badge.
 * 4. Up-voting a review increments the helpfulness score.
 */

async function logIn(page: any) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
  expect(res.status()).toBe(200);
}

test.describe("EPIC-DEV-001 — Hardware Deals, Price History & Community Reviews", () => {
  test("1. Device detail page displays seller links and 12-month SVG price history chart", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/devices`);
    await page.waitForLoadState("networkidle");

    await page.click('[data-devices-tab="prebuilts"]');
    await expect(
      page.locator('[data-testid="catalog-card"]').first(),
    ).toBeVisible({
      timeout: 15000,
    });

    // Narrow the catalog to brand "Valve" so the Steam Deck OLED card (sorted
    // alphabetically, not on the default first page) is guaranteed co-visible.
    await page.selectOption("#catalog-filter-brand", "Valve");
    await page.click("#catalog-filter-apply");
    await expect(
      page.locator('[data-testid="catalog-card"]').first(),
    ).toBeVisible({ timeout: 15000 });

    // Open the detail modal for the Steam Deck OLED (known seeded catalog id).
    const card = page.locator(
      '[data-testid="catalog-card"][data-device-id="steam-deck-oled"]',
    );
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();

    const modal = page.locator("#device-detail-modal");
    await expect(modal).toBeVisible({ timeout: 15000 });

    // Seller links panel renders at least one (Amazon / Best Buy / Newegg).
    const sellerLinks = page.locator('[data-testid="device-seller-link"]');
    await expect(sellerLinks.first()).toBeVisible({ timeout: 15000 });
    expect(await sellerLinks.count()).toBeGreaterThanOrEqual(1);

    // 12-month price history chart renders as a native SVG with a polyline.
    const chart = page.locator('[data-testid="device-price-history"]');
    await expect(chart).toBeVisible({ timeout: 15000 });
    await expect(chart.locator("svg polyline")).toBeVisible({ timeout: 15000 });
  });

  test("2. Authenticated user can set a hardware price drop alert", async ({
    page,
  }) => {
    await logIn(page);

    const res = await page.request.post(
      `${BASE}/api/devices/steam-deck-oled/alerts`,
      {
        data: { targetPrice: 399.99 },
      },
    );
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deviceId).toBe("steam-deck-oled");
    expect(data.targetPrice).toBe(399.99);

    // The alert is persisted in AppPriceAlerts keyed by gameId = device id.
    const list = await page.request.get(`${BASE}/api/alerts`);
    expect(list.status()).toBe(200);
    const alerts = (await list.json()).alerts;
    const found = alerts.find((a: any) => a.gameId === "steam-deck-oled");
    expect(found).toBeTruthy();
    expect(found.targetPrice).toBe(399.99);
  });

  test("3. Submitting a review for an owned device automatically applies the Verified Owner badge", async ({
    page,
  }) => {
    await logIn(page);

    // Register an owned device matching the catalog device name so the review
    // endpoint detects verified ownership by normalized name.
    const deviceName = `Steam Deck OLED ${Date.now()}`;
    const deviceRes = await page.request.post(`${BASE}/api/devices`, {
      data: { deviceName, deviceType: "handheld" },
    });
    expect(deviceRes.status()).toBe(201);

    // Submit a review for a different catalog device? No — ownership detection
    // matches against the catalog device name, so submit against a catalog
    // device whose name matches an owned fleet device. Use Steam Deck OLED with
    // a fleet device named exactly "Steam Deck OLED".
    await page.request.delete(
      `${BASE}/api/devices/${(await deviceRes.json()).device.id}`,
    );

    const ownedRes = await page.request.post(`${BASE}/api/devices`, {
      data: { deviceName: "Steam Deck OLED", deviceType: "handheld" },
    });
    expect(ownedRes.status()).toBe(201);
    const ownedId = (await ownedRes.json()).device.id;

    try {
      const reviewRes = await page.request.post(
        `${BASE}/api/devices/steam-deck-oled/reviews`,
        {
          data: {
            rating: 5,
            title: "Owned device review",
            body: "Verified owner review body.",
            pros: ["Screen"],
            cons: [],
          },
        },
      );
      expect(reviewRes.status()).toBe(201);
      const reviewData = await reviewRes.json();
      expect(reviewData.success).toBe(true);
      expect(reviewData.review.isVerifiedOwner).toBe(true);

      // Re-fetch the public review list and confirm the badge is surfaced.
      const listRes = await page.request.get(
        `${BASE}/api/devices/steam-deck-oled/reviews`,
      );
      expect(listRes.status()).toBe(200);
      const listed = (await listRes.json()).reviews;
      const mine = listed.find(
        (r: any) => r.reviewId === reviewData.review.reviewId,
      );
      expect(mine).toBeTruthy();
      expect(mine.isVerifiedOwner).toBe(true);
    } finally {
      await page.request.delete(`${BASE}/api/devices/${ownedId}`);
    }
  });

  test("4. Up-voting a review increments the helpfulness score dynamically", async ({
    page,
  }) => {
    await logIn(page);

    // Fetch the seeded reviews for a device that has baseline data
    // (steam-deck-oled is seeded with an Editor's Pick review).
    const listRes = await page.request.get(
      `${BASE}/api/devices/steam-deck-oled/reviews`,
    );
    expect(listRes.status()).toBe(200);
    const reviews = (await listRes.json()).reviews;
    expect(reviews.length).toBeGreaterThan(0);

    const target = reviews[0];
    const before = Number(target.helpfulScore);

    const voteRes = await page.request.post(
      `${BASE}/api/reviews/${target.reviewId}/vote`,
      {
        data: { voteType: "up" },
      },
    );
    expect(voteRes.status()).toBe(200);
    const voteData = await voteRes.json();
    expect(voteData.success).toBe(true);
    expect(Number(voteData.helpfulScore)).toBe(before + 1);
  });
});
