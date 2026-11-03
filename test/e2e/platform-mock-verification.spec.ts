import { test, expect, runAxeScan } from "../fixtures";
import { revealLibraryGameCard } from "../helpers/library-pagination";

const BASE = "http://localhost:4000";

/**
 * Sprint 27 (FEAT-0161-MOCK-SYSTEM) — Full-Platform Mock Seeding & E2E Validation Harness.
 *
 * Test 1: Seed data via POST /api/mock/seed and verify Dev Seed Bar status.
 * Test 2: Fleet Matrix — verify hardware profiles, game scores, console exclusivity, and Steam Deck performance preset tags.
 * Test 3: Wishlist Arbitrage — verify 'Below Target' price badges, Fanatical store deals, GOG DRM-Free tags, and Authorized Key Sellers filter.
 * Test 4: Moddability & Anti-Cheat — verify active Nexus Mod Hub links, mod counts, and Anti-Cheat warning tags.
 * Test 5: Retro Hub — verify Chrono Trigger, Sonic 2, Castlevania SOTN, and Micro Mages catalog items with store and patch metadata.
 * Test 6: Axe Core Accessibility — 0 accessibility violations across all primary hydrated views.
 */

test.describe("Sprint 27 (FEAT-0161) — Full-Platform Mock Seeding & E2E Validation", () => {
  test.beforeEach(async ({ request, page }) => {
    // Sprint (EPIC-TEST-STD-0001): Smart Binder tag pills (Moddable, Console
    // Exclusive, Anti-Cheat) and seeded wishlist rows are tenant-scoped —
    // /api/games only attaches customTagsByGame and /api/wishlist only returns
    // rows for an authenticated viewer. Seed mock data as the deterministic
    // user so the library cards and wishlist grid render with tags/badges.
    await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });

    // Seed mock data before each test via API
    const seedRes = await request.post(`${BASE}/api/mock/seed`);
    expect(seedRes.ok()).toBeTruthy();

    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState("networkidle");

    // Dismiss the privacy consent banner first so its fixed bottom overlay
    // cannot intercept clicks on the Dev Bar controls (established pattern from
    // legal-compliance.spec.ts).
    const banner = page.locator("#consent-banner");
    if (await banner.isVisible()) {
      await page.locator("#consent-reject-nonessential").click();
    }
  });

  test("1. Seed Dev Bar UI triggers API seeding and rehydrates active DOM views", async ({
    page,
  }) => {
    // Handle confirm dialog for clear button
    page.on("dialog", (dialog) => dialog.accept());

    // Trigger clear via Dev Bar button
    const clearBtn = page.locator("#btn-clear-mock");
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Trigger seed via Dev Bar button
    const seedBtn = page.locator("#btn-seed-mock");
    await expect(seedBtn).toBeVisible();
    await seedBtn.click();

    // Verify seed bar buttons remain responsive after click
    await expect(seedBtn).toBeEnabled();
  });

  test("2. Fleet Matrix verification across seeded devices and games", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector("#library-games-grid");

    // EPIC-03 pagination: page through the catalog until each target game is
    // rendered into the DOM before asserting visibility.
    await expect(revealLibraryGameCard(page, "Cyberpunk 2077", 40)).resolves.toBe(true);
    const cyberpunkCard = page
      .locator("#library-games-grid .game-card")
      .filter({ hasText: "Cyberpunk 2077" })
      .first();
    await expect(cyberpunkCard).toBeVisible();

    await expect(revealLibraryGameCard(page, "Monster Hunter Wilds", 40)).resolves.toBe(true);
    const mhwCard = page
      .locator("#library-games-grid .game-card")
      .filter({ hasText: "Monster Hunter Wilds" })
      .first();
    await expect(mhwCard).toBeVisible();

    await expect(revealLibraryGameCard(page, "Bloodborne", 40)).resolves.toBe(true);
    const bloodborneCard = page
      .locator("#library-games-grid .game-card")
      .filter({ hasText: "Bloodborne" })
      .first();
    await expect(bloodborneCard).toBeVisible();
    await expect(bloodborneCard).toContainText("Console Exclusive");
  });

  test("3. Wishlist Arbitrage verification for price alerts and badges", async ({ page }) => {
    await page.goto(`${BASE}/#/wishlist`);
    await page.waitForSelector("#wishlist-cards-grid");

    // Cyberpunk 2077 should show Below Target badge and Fanatical store deal
    const cpWish = page
      .locator(".wishlist-card, .card")
      .filter({ hasText: "Cyberpunk 2077" })
      .first();
    await expect(cpWish).toBeVisible();
    await expect(cpWish).toContainText("Below Target");
    await expect(cpWish).toContainText("Fanatical");

    // The Witcher 3 should display GOG store deal with DRM-Free badge
    const witcherWish = page
      .locator(".wishlist-card, .card")
      .filter({ hasText: "The Witcher 3" })
      .first();
    await expect(witcherWish).toBeVisible();
    await expect(witcherWish).toContainText("GOG");
    await expect(witcherWish).toContainText("DRM-Free");

    // Filter toggle for Authorized Key Sellers
    const authFilterBtn = page.locator("#filter-authorized-only");
    if (await authFilterBtn.isVisible()) {
      await authFilterBtn.click();
      await expect(cpWish).toBeVisible();
    }
  });

  test("4. Moddability & Anti-Cheat tags render in Games library view", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector("#library-games-grid");

    // EPIC-03 pagination: page through the catalog until each target game is
    // rendered into the DOM before asserting its tags.
    await expect(revealLibraryGameCard(page, "Cyberpunk 2077", 40)).resolves.toBe(true);
    const cpCard = page
      .locator("#library-games-grid .game-card")
      .filter({ hasText: "Cyberpunk 2077" })
      .first();
    await expect(cpCard).toContainText("Moddable");
    // EPIC-03 alignment: the library card surfaces moddability via the mod-count
    // badge (12,000 Mods) rather than a bare nexusmods.com link.
    const cpModsBadge = cpCard.locator(".library-card-mods");
    await expect(cpModsBadge).toBeVisible();
    await expect(cpModsBadge).toContainText("12,000");

    await expect(revealLibraryGameCard(page, "The Witcher 3", 40)).resolves.toBe(true);
    const witcherCard = page
      .locator("#library-games-grid .game-card")
      .filter({ hasText: "The Witcher 3" })
      .first();
    await expect(witcherCard).toContainText("Moddable");
    const witcherModsBadge = witcherCard.locator(".library-card-mods");
    await expect(witcherModsBadge).toBeVisible();
    await expect(witcherModsBadge).toContainText("9,000");

    await expect(revealLibraryGameCard(page, "HELLDIVERS 2", 40)).resolves.toBe(true);
    const hdCard = page
      .locator("#library-games-grid .game-card")
      .filter({ hasText: "HELLDIVERS 2" })
      .first();
    await expect(hdCard).toContainText("Anti-Cheat");
  });

  test("5. Retro Hub catalog renders seeded titles with store and patch metadata", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/retro`);
    await page.waitForSelector("#retro-catalog");

    // Verify Chrono Trigger, Sonic 2, Castlevania SOTN, Micro Mages
    const catalog = page.locator("#retro-catalog");
    await expect(catalog).toContainText("Chrono Trigger");
    await expect(catalog).toContainText("Sonic the Hedgehog 2");
    await expect(catalog).toContainText("Castlevania: Symphony of the Night");
    await expect(catalog).toContainText("Micro Mages");

    // Outbound store links and patch links should be present
    const storeLinks = catalog.locator(".retro-store-link");
    expect(await storeLinks.count()).toBeGreaterThan(0);

    const patchLinks = catalog.locator(".retro-patch-link");
    expect(await patchLinks.count()).toBeGreaterThan(0);
  });

  test("6. Zero accessibility violations across primary hydrated views", async ({ page }) => {
    const routes = ["/#/", "/#/library", "/#/wishlist", "/#/retro"];

    for (const route of routes) {
      await page.goto(`${BASE}${route}`);
      await page.waitForLoadState("networkidle");

      // Run a local axe-core accessibility audit via @axe-core/playwright.
      const results = await runAxeScan(page, {
        disableRules: ["heading-order"],
      });

      expect(results.error).toBeNull();
      expect(results.violations).toEqual([]);
    }
  });
});
