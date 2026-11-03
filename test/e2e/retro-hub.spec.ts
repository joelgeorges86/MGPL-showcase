import { test, expect, runAxeScan } from "../fixtures";


const BASE = "http://localhost:4000";

/**
 * Sprint 26 (FEAT-0159-RETRO-HUB) — Retro Gaming Hub with Legal Store
 * Re-releases & Sandboxed Local Runner.
 *
 * Test 1: Navigate to #/retro and verify the systems filter bar renders.
 * Test 2: Verify official storefront and legal remaster outbound links render.
 * Test 3: Verify the local ROM dropzone container and accessibility labels.
 * Test 4: Toggle system filter chips and assert the dynamic list updates.
 * Test 5: Zero accessibility violations across #page-retro.
 */

test.describe("Sprint 26 (FEAT-0159-RETRO-HUB) - Retro Gaming Hub", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/#/retro`);
    await page.waitForSelector("#page-retro");
    // Wait for the catalog to hydrate before running assertions.
    await expect(page.locator("#retro-catalog .retro-card").first()).toBeVisible();
  });

  test("1. Navigating to #/retro renders the systems filter bar", async ({ page }) => {
    const filterBar = page.locator("#retro-system-filters");
    await expect(filterBar).toBeVisible();

    const filterBtns = filterBar.locator(".retro-filter-btn");
    const count = await filterBtns.count();
    expect(count).toBeGreaterThanOrEqual(6);

    // The "All Systems" chip is present and active by default.
    const allBtn = filterBar.locator('.retro-filter-btn[data-system="all"]');
    await expect(allBtn).toBeVisible();

    // Confirm specific system chips render (NES, SNES, Genesis, PS1, GBA, Homebrew).
    const systemKeys = ["NES", "SNES", "Genesis", "PS1", "GBA", "Homebrew"];
    for (const key of systemKeys) {
      await expect(filterBar.locator(`.retro-filter-btn[data-system="${key}"]`)).toBeVisible();
    }
  });

  test("2. Official storefront and legal remaster outbound links render", async ({ page }) => {
    const catalog = page.locator("#retro-catalog");
    await expect(catalog).toBeVisible();

    // At least one official store link renders across the rendered cards.
    const storeLinks = catalog.locator(".retro-store-link");
    const storeLinkCount = await storeLinks.count();
    expect(storeLinkCount).toBeGreaterThan(0);

    // Store links must be legitimate outbound anchors with http(s) targets.
    const firstStoreLink = storeLinks.first();
    const href = await firstStoreLink.getAttribute("href");
    expect(href).toMatch(/^https?:\/\//);
    await expect(firstStoreLink).toHaveAttribute("target", "_blank");
    await expect(firstStoreLink).toHaveAttribute("rel", /noopener/);

    // Community enhancement patches also render as outbound links somewhere in the catalog.
    const patchLinks = catalog.locator(".retro-patch-link");
    const patchLinkCount = await patchLinks.count();
    expect(patchLinkCount).toBeGreaterThan(0);
    const patchHref = await patchLinks.first().getAttribute("href");
    expect(patchHref).toMatch(/^https?:\/\//);
  });

  test("3. Local ROM dropzone container renders with accessibility labels", async ({ page }) => {
    const dropzone = page.locator("#retro-rom-dropzone");
    await expect(dropzone).toBeVisible();
    await expect(dropzone).toHaveAttribute("aria-label", /.+/);

    await expect(dropzone).toContainText("Drag and drop your legally dumped ROM file to play locally");

    // A hidden file input backs the dropzone for manual file selection.
    const fileInput = page.locator("#retro-rom-input");
    await expect(fileInput).toHaveCount(1);
    await expect(fileInput).toHaveAttribute("type", "file");
  });

  test("4. Toggling system filter chips updates the rendered catalog list", async ({ page }) => {
    const catalog = page.locator("#retro-catalog");
    const allCardsInitial = await catalog.locator(".retro-card").count();
    expect(allCardsInitial).toBeGreaterThan(0);

    // Switch to the NES filter chip.
    await page.locator('.retro-filter-btn[data-system="NES"]').click();

    // All visible cards after filtering must be tagged with the NES system.
    await expect(async () => {
      const visibleCards = catalog.locator('.retro-card[data-system="NES"]');
      const visibleCount = await visibleCards.count();
      expect(visibleCount).toBeGreaterThan(0);

      const allCards = catalog.locator(".retro-card");
      const totalAfterFilter = await allCards.count();
      // Every rendered card must match the active NES filter.
      for (let i = 0; i < totalAfterFilter; i++) {
        await expect(allCards.nth(i)).toHaveAttribute("data-system", "NES");
      }
    }).toPass();

    // The active filter chip is visually distinguished.
    const nesBtn = page.locator('.retro-filter-btn[data-system="NES"]');
    const nesClass = await nesBtn.getAttribute("class");
    expect(nesClass).toContain("bg-purple-600");

    // Switching back to "All Systems" restores the full catalog list.
    await page.locator('.retro-filter-btn[data-system="all"]').click();
    await expect(async () => {
      const restoredCount = await catalog.locator(".retro-card").count();
      expect(restoredCount).toBeGreaterThanOrEqual(allCardsInitial);
    }).toPass();
  });

  test("5. Zero accessibility violations on the Retro Hub page", async ({ page }: { page: any }) => {
    // Run a local axe-core accessibility audit scoped to #page-retro. The
    // lazy-loaded Libretro setup-video iframe hosts third-party content whose
    // empty remote document trips document-level rules, so it is excluded from
    // the first-party audit (standard practice for embedded frames).
    const results = await runAxeScan(page, {
      selector: "#page-retro",
      exclude: ["#retro-setup-guide iframe"],
    });

    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);
  });

});
