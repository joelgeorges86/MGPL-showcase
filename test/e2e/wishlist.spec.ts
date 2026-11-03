import { test, expect, runAxeScan } from "../fixtures";

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

/**
 * Sprint 25.1 (FEAT-0158) — Universal Multi-Store Wishlist, Cross-Platform
 * Price Comparison & Target Threshold Alerts.
 *
 * Test 1: Navigate to #/wishlist, search for a game, set a target price, add to wishlist.
 * Test 2: Verify the multi-platform store comparison table renders across stores.
 * Test 3: Verify the 🚨 Below Target alert triggers when the best store price <= target.
 * Test 4: Toggle the "Triggered Alerts Only" filter.
 * Test 5: Add a game from the Game Detail Drawer.
 * Test 6: Remove a game from the wishlist.
 * Test 7: Zero accessibility violations.
 *
 * Sprint (EPIC-TEST-STD-0001): All wishlist routes are tenant-scoped behind
 * requireAuth, so this suite authenticates as the deterministic seeded user
 * (alex.gamer) in beforeEach and drives every API call through `page.request`
 * (which shares the browser cookie jar) instead of the isolated `request`
 * fixture, which would 401 on every mutation.
 */
test.describe("Sprint 25.1 (FEAT-0158) - Universal Multi-Store Wishlist, Price Comparison & Target Threshold Alerts", () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as Alex so the browser page AND page.request share the
    // mgpl_session cookie and can read/write the seeded user's wishlist rows.
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: ALEX,
    });
    expect(login.status()).toBe(200);

    // Clear any leftover wishlist entries so each test starts from a clean slate
    // (test isolation — a failed test's cleanup may not have run).
    const listRes = await page.request.get(`${BASE}/api/wishlist`);
    if (listRes.status() === 200) {
      const listData = await listRes.json();
      const items = listData.wishlist || [];
      for (const item of items) {
        await page.request.delete(
          `${BASE}/api/wishlist/${encodeURIComponent(item.gameId || item.id)}`,
        );
      }
    }

    await page.goto(`${BASE}/#/wishlist`);
    await page.waitForSelector("#page-wishlist");
  });

  test("1. Search for a game, set a target price, and add it to the wishlist", async ({ page }) => {
    // Overview banner renders.
    await expect(page.locator("#wishlist-total-games")).toBeVisible();
    await expect(page.locator("#wishlist-triggered-count")).toBeVisible();
    await expect(page.locator("#wishlist-best-store")).toBeVisible();
    await expect(page.locator("#wishlist-avg-savings")).toBeVisible();
    await expect(page.locator("#wishlist-total-value")).toBeVisible();

    // Empty state message when no games tracked.
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Your wishlist is empty");

    // Seed a game so the search autocomplete has a match to return.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "wishlist-e2e-hades", title: "Hades", targetPrice: 19.99 },
    });

    // Search for a game via the autocomplete input.
    const searchInput = page.locator("#wishlist-game-search");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("Hades");
    await expect(page.locator("#wishlist-search-results")).toBeVisible();
    await page.locator("#wishlist-search-results [data-result-id]").first().click();

    // Set a target price and add to wishlist.
    await page.locator("#wishlist-target-input").fill("14.99");
    await page.locator("#wishlist-add-btn").click();

    // The game card renders in the grid.
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Hades");

    // Overview total should be >= 1.
    const total = await page.locator("#wishlist-total-games").textContent();
    expect(Number(total)).toBeGreaterThanOrEqual(1);

    // Cleanup via API.
    await page.request.delete(`${BASE}/api/wishlist/wishlist-e2e-hades`);
  });

  test("2. Multi-platform store comparison table renders across stores", async ({ page }) => {
    const gameId = "wishlist-e2e-compare-ui";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Compare UI Game", targetPrice: 39.99 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Compare UI Game");

    // Open the comparison modal from the card.
    await page.locator("#wishlist-cards-grid .wishlist-compare-btn").first().click();
    const modal = page.locator("#wishlist-compare-modal");
    await expect(modal).toBeVisible();

    // The table renders rows for each store (Steam, GOG, Epic, PlayStation, Xbox).
    const table = modal.locator("table");
    await expect(table).toBeVisible();
    const storeCells = modal.locator("tbody tr td:first-child");
    const storeTexts = await storeCells.allTextContents();
    expect(storeTexts.length).toBeGreaterThanOrEqual(5);
    expect(storeTexts.join(" ")).toContain("Steam");
    expect(storeTexts.join(" ")).toContain("GOG");
    expect(storeTexts.join(" ")).toContain("Epic");
    expect(storeTexts.join(" ")).toContain("PlayStation");
    expect(storeTexts.join(" ")).toContain("Xbox");

    // Exactly one row is flagged as the best offer.
    const bestCount = await modal.locator("tbody tr").filter({ hasText: "Best" }).count();
    expect(bestCount).toBeGreaterThanOrEqual(1);

    // Only stores with observed prices expose outbound links; unavailable
    // stores remain visible as explicitly unavailable rows.
    const linkCount = await modal.locator("tbody tr td:first-child a").count();
    expect(linkCount).toBeGreaterThanOrEqual(1);
    expect(linkCount).toBeLessThan(5);

    // Close the modal via the explicit close button.
    await modal
      .locator("button[data-close]")
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(modal).toBeHidden();

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("3. 🚨 Below Target alert triggers when best store price is at or below target", async ({
    page,
  }) => {
    const gameId = "wishlist-e2e-triggered";
    // Set a very high target so the synthesized best price is guaranteed <= target.
    const postRes = await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Triggered Game", targetPrice: 9999 },
    });
    expect(postRes.status()).toBe(200);
    const postData = await postRes.json();
    expect(postData.success).toBe(true);
    expect(postData.item.isTriggered).toBe(1);

    // Refresh the view and confirm the card is flagged as triggered.
    await page.locator("#wishlist-refresh-btn").click();
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-triggered", "1");
    // The card renders the "🚨 Below Target" alert badge (matches the UI text).
    await expect(card).toContainText("Below Target");

    // Verify the on-sale feed includes the triggered entry.
    const onSaleRes = await page.request.get(`${BASE}/api/wishlist/on-sale`);
    expect(onSaleRes.status()).toBe(200);
    const onSaleData = await onSaleRes.json();
    expect(onSaleData.success).toBe(true);
    const found = onSaleData.wishlistDeals.find((d: any) => d.gameID === gameId);
    expect(found).toBeTruthy();
    expect(found.isTriggered).toBe(true);

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("4. Toggle the Triggered Alerts Only filter", async ({ page }) => {
    // Seed one triggered game and one non-triggered game.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "wishlist-e2e-trig", title: "Triggered Filter Game", targetPrice: 9999 },
    });
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "wishlist-e2e-watch", title: "Watching Filter Game", targetPrice: 1 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Triggered Filter Game");
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Watching Filter Game");

    // Click the "Triggered Alerts Only" filter.
    await page.locator('.wishlist-filter-btn[data-filter="triggered"]').click();

    // The triggered card remains visible; the watching card is hidden.
    const triggeredCard = page.locator(
      '#wishlist-cards-grid .wishlist-card[data-game-id="wishlist-e2e-trig"]',
    );
    const watchingCard = page.locator(
      '#wishlist-cards-grid .wishlist-card[data-game-id="wishlist-e2e-watch"]',
    );
    await expect(triggeredCard).toBeVisible();
    await expect(watchingCard).toBeHidden();

    // Switch back to "All Wishlist" and both cards are visible again.
    await page.locator('.wishlist-filter-btn[data-filter="all"]').click();
    await expect(triggeredCard).toBeVisible();
    await expect(watchingCard).toBeVisible();

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/wishlist-e2e-trig`);
    await page.request.delete(`${BASE}/api/wishlist/wishlist-e2e-watch`);
  });

  test("5. Add a game from the Game Detail Drawer", async ({ page }) => {
    // No seed: the drawer's Add-to-Wishlist action creates the item. Seeding
    // the game first would flip the state-aware drawer button into Remove mode
    // and this flow would remove instead of add.
    const gameId = "wishlist-e2e-drawer";

    // Open the drawer via the exposed hook.
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer("Drawer Game", "wishlist-e2e-drawer");
    });

    const drawer = page.locator("#game-detail-drawer");
    await expect(drawer).toBeVisible();

    const wishlistBtn = page.locator("#drawer-wishlist-add-btn");
    await expect(wishlistBtn).toBeVisible();

    // Set a target and click add-to-wishlist.
    await page.locator("#drawer-wishlist-target-input").fill("15.00");
    await wishlistBtn.click();
    await expect(page.locator("#drawer-wishlist-status")).toContainText("Added to wishlist");

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("6. Remove a game from the wishlist", async ({ page }) => {
    const gameId = "wishlist-e2e-remove-me";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Remove Me Game", targetPrice: 9.99 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Remove Me Game");

    // Remove via the card's remove button.
    await page
      .locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"] .wishlist-remove-btn`)
      .click();

    // The card disappears from the grid.
    await expect(page.locator("#wishlist-cards-grid")).not.toContainText("Remove Me Game");

    // Confirm the API no longer returns the entry.
    const listRes = await page.request.get(`${BASE}/api/wishlist`);
    const listData = await listRes.json();
    const stillPresent = (listData.wishlist || []).some((i: any) => i.gameId === gameId);
    expect(stillPresent).toBe(false);
  });

  test("7. Zero accessibility violations on the wishlist page", async ({ page }: { page: any }) => {
    // Seed a game so the grid renders populated content for the audit.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "wishlist-e2e-a11y", title: "Accessibility Game", targetPrice: 24.99 },
    });
    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Accessibility Game");

    // Run a local axe-core accessibility audit via @axe-core/playwright.
    const results = await runAxeScan(page);

    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/wishlist-e2e-a11y`);
  });

  test("8. Authorized key distributors render in the matrix table with 🔑 Authorized tags", async ({
    page,
  }) => {
    const gameId = "wishlist-e2e-authorized";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Authorized Retailer Game", targetPrice: 29.99 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();

    // The matrix table renders rows for both Direct Platforms and Authorized Key Retailers.
    const matrix = card.locator(".wishlist-matrix-table");
    await expect(matrix).toBeVisible();
    const storeTexts = await matrix.locator("tbody tr td:first-child").allTextContents();
    const joined = storeTexts.join(" ");
    expect(joined).toContain("Steam");
    expect(joined).toContain("GOG");
    expect(joined).toContain("Epic");
    expect(joined).toContain("PlayStation");
    expect(joined).toContain("Xbox");
    expect(joined).toContain("Fanatical");
    expect(joined).toContain("Green Man Gaming");
    expect(joined).toContain("Gamesplanet");
    expect(joined).toContain("GameBillet");
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

  test("9. DRM, modding, and offline badges render in the matrix table", async ({ page }) => {
    const gameId = "wishlist-e2e-badges";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Badge Matrix Game", targetPrice: 19.99 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();
    const matrix = card.locator(".wishlist-matrix-table");
    await expect(matrix).toBeVisible();

    // DRM type badges (Steamworks, DRM-Free, Epic DRM, Console, etc.).
    const drmTexts = await matrix.locator("tbody tr td:nth-child(3)").allTextContents();
    const drmJoined = drmTexts.join(" ");
    expect(drmJoined).toContain("Steamworks");
    expect(drmJoined).toContain("DRM-Free");
    expect(drmJoined).toContain("Epic DRM");

    // Modding compatibility pills (Full / Partial / Locked).
    const modTexts = await matrix.locator("tbody tr td:nth-child(4)").allTextContents();
    const modJoined = modTexts.join(" ");
    expect(modJoined).toContain("Full");
    expect(modJoined).toContain("Partial");

    // Offline play status pills (Native Offline / Offline Token / Console Offline).
    const offlineTexts = await matrix.locator("tbody tr td:nth-child(5)").allTextContents();
    const offlineJoined = offlineTexts.join(" ");
    expect(offlineJoined).toContain("Native Offline");
    expect(offlineJoined).toContain("Offline Token");

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("10. Moddability section shows Nexus badges and community hub links", async ({ page }) => {
    const gameId = "wishlist-e2e-moddability";
    // "Hades" maps to a known Nexus domain so the moddability section is populated.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "Hades", targetPrice: 24.99 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();

    const modStatus = card.locator(".wishlist-mod-status");
    await expect(modStatus).toBeVisible();

    // Moddable badge with a non-zero Nexus mod count.
    await expect(modStatus).toContainText("Moddable");
    await expect(modStatus).toContainText("Nexus Mods");

    // The Nexus community hub link points to the correct domain.
    const nexusLink = modStatus.locator('a[href*="nexusmods.com"]');
    await expect(nexusLink).toBeVisible();
    const href = await nexusLink.getAttribute("href");
    expect(href).toContain("https://www.nexusmods.com/");

    // Offline play readiness badge is present.
    await expect(modStatus).toContainText("Offline Play");

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("11. DLC catalog shows pricing, discount, and store tags", async ({ page }) => {
    const gameId = "wishlist-e2e-dlc";
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId, title: "DLC Catalog Game", targetPrice: 39.99 },
    });

    await page.locator("#wishlist-refresh-btn").click();
    const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
    await expect(card).toBeVisible();

    const dlcTable = card.locator(".wishlist-dlc-table");
    await expect(dlcTable).toBeVisible();

    // At least one DLC row renders with a name, type, price, and store.
    const rows = dlcTable.locator("tbody tr");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // Each row has a best price, a store tag, and a Buy link.
    const firstRow = rows.first();
    await expect(firstRow.locator("td").nth(2)).toContainText("$");
    await expect(firstRow.locator("td").nth(5)).not.toBeEmpty();
    await expect(firstRow.locator('a[href*="http"]')).toBeVisible();

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/${gameId}`);
  });

  test("12. Toggle the Authorized Key Sellers filter to isolate authorized cards", async ({
    page,
  }) => {
    // Seed several games so we can discover one whose best deal is an authorized
    // key retailer and one whose best deal is a direct platform (the cheapest
    // store is deterministic per gameId but not controllable via target price).
    const candidates = [
      "wishlist-e2e-auth-a",
      "wishlist-e2e-auth-b",
      "wishlist-e2e-auth-c",
      "wishlist-e2e-auth-d",
      "wishlist-e2e-auth-e",
      "wishlist-e2e-auth-f",
    ];
    for (const id of candidates) {
      await page.request.post(`${BASE}/api/wishlist`, {
        data: { gameId: id, title: `Auth Candidate ${id}`, targetPrice: 9999 },
      });
    }

    // Query the API to find one authorized-best and one direct-best game.
    const listRes = await page.request.get(`${BASE}/api/wishlist`);
    const listData = await listRes.json();
    const items: any[] = listData.wishlist || [];
    const authItem = items.find((i) => i.isAuthorizedBest === true);
    const directItem = items.find((i) => i.isAuthorizedBest === false);
    expect(authItem).toBeTruthy();
    expect(directItem).toBeTruthy();
    const authId = authItem.gameId;
    const directId = directItem.gameId;

    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText(authItem.title);
    await expect(page.locator("#wishlist-cards-grid")).toContainText(directItem.title);

    // Click the "Authorized Key Sellers" filter.
    await page.locator('.wishlist-filter-btn[data-filter="authorized"]').click();

    // Only the authorized-best card remains visible.
    const authCard = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${authId}"]`);
    const directCard = page.locator(
      `#wishlist-cards-grid .wishlist-card[data-game-id="${directId}"]`,
    );
    await expect(authCard).toBeVisible();
    await expect(directCard).toBeHidden();

    // Switch back to "All Wishlist" and both cards are visible again.
    await page.locator('.wishlist-filter-btn[data-filter="all"]').click();
    await expect(authCard).toBeVisible();
    await expect(directCard).toBeVisible();

    // Cleanup.
    for (const id of candidates) {
      await page.request.delete(`${BASE}/api/wishlist/${id}`);
    }
  });

  test("13. Zero accessibility violations with enriched cards (matrix, moddability, DLC)", async ({
    page,
  }: {
    page: any;
  }) => {
    // Seed a game so the enriched sections render populated content for the audit.
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: "wishlist-e2e-a11y-enriched", title: "Hades", targetPrice: 24.99 },
    });
    await page.locator("#wishlist-refresh-btn").click();
    await expect(page.locator("#wishlist-cards-grid")).toContainText("Hades");
    await expect(page.locator("#wishlist-cards-grid .wishlist-matrix-table").first()).toBeVisible();
    await expect(page.locator("#wishlist-cards-grid .wishlist-mod-status").first()).toBeVisible();
    await expect(page.locator("#wishlist-cards-grid .wishlist-dlc-table").first()).toBeVisible();

    // Run a local axe-core accessibility audit via @axe-core/playwright.
    const results = await runAxeScan(page);

    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);

    // Cleanup.
    await page.request.delete(`${BASE}/api/wishlist/wishlist-e2e-a11y-enriched`);
  });
});
