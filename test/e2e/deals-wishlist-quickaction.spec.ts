import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";
const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
const UNOWNED_GAME_ID = "space-marine-2";
const UNOWNED_GAME_TITLE = "Warhammer 40,000: Space Marine 2";

/**
 * Sprint 4 (EPIC-DEAL-001) — Wishlist Quick-Action Integration & UI Link
 * Traceability.
 *
 * 1. Search an unowned game via the Ctrl+K command palette and open its
 *    quick-view drawer.
 * 2. Click "Add to Wishlist" and verify the item lands in the local SQLite
 *    AppWishlist table and the button flips to "Remove from Wishlist".
 * 3. Verify the newly-added item surfaces under the Wishlist Drops tab.
 * 4. Verify every rendered store link carries a whitelisted HTTPS target and
 *    an attribution badge.
 */

async function logIn(page: any) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
  expect(res.status()).toBe(200);
}

test.describe("EPIC-DEAL-001 — Wishlist Quick-Action & Link Traceability", () => {
  test("1. User searches an unowned game via Ctrl+K and opens its quick-view drawer", async ({
    page,
  }) => {
    await logIn(page);

    // Remove any stale wishlist entry for a deterministic start.
    await page.request.delete(`${BASE}/api/wishlist/${UNOWNED_GAME_ID}`);

    await page.goto(`${BASE}/#/home`);
    await page.keyboard.press("Control+K");

    const palette = page.locator("#command-palette");
    await expect(palette).toBeVisible();

    await page.fill("#command-palette-input", "Space Marine");

    const option = page.locator(".palette-option", {
      hasText: UNOWNED_GAME_TITLE,
    });
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.click();

    const drawer = page.locator("#game-detail-drawer");
    await expect(drawer).toBeVisible();

    // The unowned game keeps the wishlist footer visible.
    await expect(page.locator("#drawer-wishlist-bar")).toBeVisible();
    await expect(page.locator("#game-detail-title")).toContainText(
      UNOWNED_GAME_TITLE,
    );
  });

  test("2. Clicking Add to Wishlist registers the item in AppWishlist and updates UI state", async ({
    page,
  }) => {
    await logIn(page);

    await page.request.delete(`${BASE}/api/wishlist/${UNOWNED_GAME_ID}`);

    await page.goto(`${BASE}/#/home`);
    await page.keyboard.press("Control+K");
    await page.fill("#command-palette-input", "Space Marine");

    const option = page.locator(".palette-option", {
      hasText: UNOWNED_GAME_TITLE,
    });
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.click();

    const wishlistBtn = page.locator("#drawer-wishlist-add-btn");
    await expect(wishlistBtn).toBeVisible();

    // Initial state: "add".
    await expect(wishlistBtn).toHaveAttribute("data-wishlist-state", "add");

    await wishlistBtn.click();

    // Button flips to remove state.
    await expect(wishlistBtn).toHaveAttribute("data-wishlist-state", "remove");
    await expect(wishlistBtn).toContainText("Remove from Wishlist");

    // Toast notification container appears.
    await expect(page.locator("#toast-container")).toContainText(
      UNOWNED_GAME_TITLE,
    );

    // Authoritative DB check via the API.
    const list = await page.request.get(`${BASE}/api/wishlist`);
    expect(list.status()).toBe(200);
    const items: any[] = (await list.json()).wishlist || [];
    const found = items.find((i) => i.gameId === UNOWNED_GAME_ID);
    expect(found).toBeTruthy();
    expect(found.title).toBe(UNOWNED_GAME_TITLE);
  });

  test("3. Newly wishlisted item appears under the Wishlist Drops tab", async ({
    page,
  }) => {
    await logIn(page);

    await page.request.delete(`${BASE}/api/wishlist/${UNOWNED_GAME_ID}`);
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: UNOWNED_GAME_ID, title: UNOWNED_GAME_TITLE },
    });

    await page.goto(`${BASE}/#/deals?tab=wishlist`);

    const card = page.locator(
      `[data-wishlist-drop-card][data-game-id="${UNOWNED_GAME_ID}"]`,
    );
    await expect(card).toBeVisible({ timeout: 15000 });

    // Attribution link is present on the drop card with an HTTPS target.
    const attribution = card.locator("[data-attribution-link]");
    await expect(attribution.first()).toBeVisible();
    const href = await attribution.first().getAttribute("href");
    expect(String(href || "").startsWith("https://")).toBe(true);
  });

  test("4. All rendered store links carry verified HTTPS targets and attribution badges", async ({
    page,
  }) => {
    await logIn(page);

    for (const tab of ["sales", "giveaways", "wishlist"]) {
      await page.goto(`${BASE}/#/deals?tab=${tab}`);
      await page.waitForTimeout(1000);

      const links = page.locator(
        '[data-attribution-link], [data-deal-view], .freebie-claim-btn',
      );

      const count = await links.count();
      for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        if (!(await link.isVisible())) continue;
        const href = await link.getAttribute("href");
        if (!href || href === "#") continue;
        expect(href.startsWith("https://")).toBe(true);
      }

      // Each attribution link must nest a visible attribution badge.
      const attributionLinks = page.locator("[data-attribution-link]");
      const attrCount = await attributionLinks.count();
      for (let i = 0; i < attrCount; i++) {
        const link = attributionLinks.nth(i);
        if (!(await link.isVisible())) continue;
        await expect(link.locator("[data-attribution-badge]")).toBeAttached();
      }
    }

    // Services/API documentation panel exposes strict-HTTPS reference links.
    await page.goto(`${BASE}/#/settings`);
    const services = page.locator("#services-reference");
    await expect(services).toBeVisible();

    const serviceLinks = services.locator("[data-service-docs]");
    const serviceCount = await serviceLinks.count();
    expect(serviceCount).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < serviceCount; i++) {
      const href = await serviceLinks.nth(i).getAttribute("href");
      expect(String(href || "").startsWith("https://")).toBe(true);
    }
  });
});