import { test, expect } from "../fixtures";
import {
  login,
  ALEX,
  JORDAN,
  createTestWishlistItem,
  createTestAlert,
  createTestTag,
  createTestNote,
  deleteTestItem,
  getWishlist,
  getAlerts,
  getTagsForGame,
  getNote,
} from "../helpers/api-client";

/**
 * Sprint 3 (EPIC-TEST-STD-0001) — Wildcard test entity generation & user
 * interaction workflows.
 *
 * Every record in this suite is created dynamically through the authenticated
 * API helper (test/helpers/api-client.ts) and removed in cleanup — no static
 * seed bloat. The suite validates end-to-end user workflows for Wishlists,
 * Custom Tags, Notes, and Price Alerts, plus strict multi-tenant purity:
 * records created for Alex must never bleed into Jordan's views.
 *
 * Users (seeded by test/global-setup.ts):
 *   - alex.gamer@mgpl.io / GamerPass2026!
 *   - jordan.dev@mgpl.io / SecureDev2026!
 *
 * Selector map:
 *   - Wishlist: #page-wishlist, #wishlist-cards-grid, .wishlist-card, .wishlist-remove-btn,
 *     #wishlist-total-games, #wishlist-refresh-btn
 *   - Drawer:   window.openGameDetailDrawer(title, id), #drawer-tag-form, #drawer-tag-input,
 *     #drawer-tags-list, #drawer-game-notes, #drawer-notes-status, #drawer-alert-price-input,
 *     #drawer-alert-status
 */

const n = Date.now().toString(36);
const SEEDED_GAME_ID = "G00001";
const SEEDED_GAME_TITLE = "Elden Ring";

test.describe("Sprint 3 (EPIC-TEST-STD-0001) — Dynamic Fixtures & User Interaction Workflows", () => {
  test("1. Wishlist: API-created item renders on the page and UI toggle updates server + counter", async ({
    page,
  }) => {
    // Authenticate the browser session via the shared cookie jar.
    await login(page.request, ALEX);

    const gameId = `wl-${n}`;
    const title = `Wishlist E2E ${n}`;
    try {
      // Dynamic fixture via API helper.
      await createTestWishlistItem(page.request, { gameId, title, targetPrice: 19.99 });

      // Load the wishlist view and rehydrate the grid.
      await page.goto("/#/wishlist");
      await page.waitForSelector("#page-wishlist");
      await page.locator("#wishlist-refresh-btn").click();
      await page.waitForSelector(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`, {
        timeout: 15000,
      });

      const card = page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(title);

      // Server-side state is authoritative: the API reflects the item.
      const items = await getWishlist(page.request);
      const created = items.find((i) => i.gameId === gameId);
      expect(created).toBeTruthy();
      expect(created!.targetPrice).toBe(19.99);

      // Header/overview counter reflects the tracked total.
      const before = Number((await page.locator("#wishlist-total-games").textContent()) || 0);

      // Toggle OFF directly via the UI remove action.
      await card.locator(".wishlist-remove-btn").click();
      await expect(page.locator(`#wishlist-cards-grid .wishlist-card[data-game-id="${gameId}"]`)).toHaveCount(0);

      // Server-side state updated after the UI action.
      const after = await getWishlist(page.request);
      expect(after.find((i) => i.gameId === gameId)).toBeUndefined();

      // Counter updated after removal.
      await page.locator("#wishlist-refresh-btn").click();
      await expect
        .poll(async () => Number((await page.locator("#wishlist-total-games").textContent()) || 0))
        .toBeLessThan(before);
    } finally {
      // Cleanup via API helper (missing-record tolerant).
      await deleteTestItem(page.request, "wishlist", gameId);
    }
  });

  test("2. Tags & Notes: drawer-created tag and markdown note persist after reload", async ({
    page,
  }) => {
    await login(page.request, ALEX);

    const tagName = `E2E-Tag-${n}`;
    const noteMarkdown = `## E2E Note ${n}\nPersisted marker: **${n}**`;

    try {
      // Pre-clean any stale tag note for the seeded game.
      const existingTags = await getTagsForGame(page.request, SEEDED_GAME_ID);
      if (existingTags.includes(tagName)) {
        await deleteTestItem(page.request, "tag", tagName, { gameId: SEEDED_GAME_ID });
      }
      await createTestNote(page.request, SEEDED_GAME_ID, ""); // Clear prior note content.

      // Open the unified game detail drawer for the seeded game.
      await page.goto("/#/library");
      await page.waitForSelector("#page-library");
      await page.evaluate(
        ([title, id]) => (window as any).openGameDetailDrawer(title, id),
        [SEEDED_GAME_TITLE, SEEDED_GAME_ID]
      );

      const drawer = page.locator("#game-detail-drawer");
      await expect(drawer).toBeVisible();
      await expect(page.locator("#drawer-tags-list")).toBeVisible();
      await expect(page.locator("#drawer-game-notes")).toBeVisible();

      // Add a custom tag from the drawer UI.
      await page.locator("#drawer-tag-input").fill(tagName);
      await page.locator("#drawer-tag-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(page.locator("#drawer-tags-list")).toContainText(tagName, { timeout: 10000 });

      // Write a markdown note and wait for the 1000ms debounced auto-save.
      await page.locator("#drawer-game-notes").fill(noteMarkdown);
      const statusLabel = page.locator("#drawer-notes-status");
      await expect(statusLabel).toContainText(/Saving\.\.\.|Saved/, { timeout: 3000 });
      await expect(statusLabel).toContainText("Saved", { timeout: 10000 });

      // Reload the page and re-open the drawer — tag and note must persist.
      await page.reload();
      await page.waitForSelector("#page-library");
      await page.evaluate(
        ([title, id]) => (window as any).openGameDetailDrawer(title, id),
        [SEEDED_GAME_TITLE, SEEDED_GAME_ID]
      );
      await expect(page.locator("#drawer-tags-list")).toContainText(tagName, { timeout: 10000 });
      await expect(page.locator("#drawer-game-notes")).toHaveValue(noteMarkdown, { timeout: 10000 });

      // Server-side truth matches what the UI rehydrated.
      const persistedTags = await getTagsForGame(page.request, SEEDED_GAME_ID);
      expect(persistedTags).toContain(tagName);
      const persistedNote = await getNote(page.request, SEEDED_GAME_ID);
      expect(persistedNote).toContain(`## E2E Note ${n}`);
    } finally {
      // Cleanup via API helpers.
      await deleteTestItem(page.request, "tag", tagName, { gameId: SEEDED_GAME_ID });
      await createTestNote(page.request, SEEDED_GAME_ID, "");
    }
  });

  test("3. Price alerts: target price displays accurately in the Deals/Alerts drawer surface", async ({
    page,
  }) => {
    await login(page.request, ALEX);

    const gameId = `alert-${n}`;
    const title = `Alert Game ${n}`;
    try {
      // Dynamic fixture via API helper.
      await createTestAlert(page.request, { gameId, title, targetPrice: 24.5 });

      // Server-side truth: alert exists with the exact target.
      const alerts = await getAlerts(page.request);
      const created = alerts.find((a) => a.gameId === gameId);
      expect(created).toBeTruthy();
      expect(created!.targetPrice).toBe(24.5);

      // Open the drawer — loadDrawerAlertAndHistory pre-fills the target input
      // and renders "Active target: $24.50" in the alert status line.
      await page.goto("/#/library");
      await page.waitForSelector("#page-library");
      await page.evaluate(
        ([id, t]) => (window as any).openGameDetailDrawer(t, id),
        [gameId, title]
      );

      const priceInput = page.locator("#drawer-alert-price-input");
      await expect(priceInput).toHaveValue("24.5", { timeout: 10000 });
      await expect(page.locator("#drawer-alert-status")).toContainText(
        /Active target: \$24\.5|Active target: \$24\.50/,
        { timeout: 10000 }
      );
    } finally {
      await deleteTestItem(page.request, "alert", gameId);
    }
  });

  test("4. Multi-tenant purity: Alex's dynamic records never bleed into Jordan's views", async ({
    playwright,
  }) => {
    const alexCtx = await playwright.request.newContext();
    const jordanCtx = await playwright.request.newContext();
    try {
      await login(alexCtx, ALEX);
      await login(jordanCtx, JORDAN);

      const gameId = `tenant-${n}`;
      const title = `Tenant Fixture ${n}`;
      const tagName = `TenantTag-${n}`;
      const noteMarkdown = `Tenant note ${n}`;

      // Alex creates one record of every kind.
      await createTestWishlistItem(alexCtx, { gameId, title, targetPrice: 29.99 });
      await createTestAlert(alexCtx, { gameId, title, targetPrice: 14.99 });
      await createTestTag(alexCtx, { gameId, tagName });
      await createTestNote(alexCtx, gameId, noteMarkdown);

      // Jordan sees none of Alex's records.
      expect((await getWishlist(jordanCtx)).find((i) => i.gameId === gameId)).toBeUndefined();
      expect((await getAlerts(jordanCtx)).find((a) => a.gameId === gameId)).toBeUndefined();
      expect(await getTagsForGame(jordanCtx, gameId)).not.toContain(tagName);
      expect(await getNote(jordanCtx, gameId)).toBe("");

      // Alex still sees her own records.
      expect((await getWishlist(alexCtx)).find((i) => i.gameId === gameId)).toBeTruthy();
      expect((await getAlerts(alexCtx)).find((a) => a.gameId === gameId)).toBeTruthy();
      expect(await getTagsForGame(alexCtx, gameId)).toContain(tagName);
      expect(await getNote(alexCtx, gameId)).toContain(noteMarkdown);
    } finally {
      // Alex cleans up her dynamically-created records.
      await deleteTestItem(alexCtx, "wishlist", `tenant-${n}`);
      await deleteTestItem(alexCtx, "alert", `tenant-${n}`);
      await deleteTestItem(alexCtx, "tag", `TenantTag-${n}`, { gameId: `tenant-${n}` });
      await createTestNote(alexCtx, `tenant-${n}`, "");
      await alexCtx.dispose();
      await jordanCtx.dispose();
    }
  });
});