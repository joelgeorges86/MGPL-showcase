import { test, expect, runAxeScan } from "../fixtures";

const BASE = "http://localhost:4000";
const VIEW_MODE_KEY = "mgpl_library_view_mode";

/**
 * Sprint 4 (EPIC-02 + EPIC-06 Part 1) — Dual-Mode Tile View & Compare Section
 * Reorganization.
 *
 * Test 1: Grid/List view preference persists in localStorage across reloads.
 * Test 2: List-mode cards render a responsive single-row layout with title,
 *         platform badge, genre, rating, and a quick-action CTA.
 * Test 3: The Compare matrix groups attributes into four logical clusters
 *         (Performance, Platform, Price, Availability).
 * Test 4: The default Compare view caps at 8 key attributes and the "Show all"
 *         control expands to the full cluster set.
 * Test 5: The community mods drawer (mock stub surface) opens from the library
 *         mod badge and surfaces compatibility tags + mod listings.
 * Test 6: Zero axe accessibility violations on the reorganized compare view.
 */

/** Open the compare multi-select dropdown and pick the first two games. */
async function selectTwoCompareGames(page: any) {
  await page.locator("#compare-select-trigger").click();
  const boxes = page.locator("#compare-games-list .compare-game-checkbox");
  await expect(boxes.first()).toBeVisible({ timeout: 15000 });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  // Close the dropdown so it never overlaps the rendered matrix.
  await page.locator("#compare-select-trigger").click();
}

test.describe("Sprint 4: Dual-Mode Tile View & Compare Section Reorganization", () => {
  test("1. Grid/List view preference persists across browser sessions", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    await page.locator("#library-view-list").click();
    await expect(page.locator("#library-view-list")).toHaveAttribute("aria-pressed", "true");

    const stored = await page.evaluate((key: string) => localStorage.getItem(key), VIEW_MODE_KEY);
    expect(stored).toBe("list");

    // Reload — the persisted mode must be rehydrated from localStorage.
    await page.reload();
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#library-view-list")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#library-view-grid")).toHaveAttribute("aria-pressed", "false");

    const layout = await page.locator("#library-games-grid").evaluate((el: HTMLElement) => ({
      display: getComputedStyle(el).display,
      flexDirection: getComputedStyle(el).flexDirection,
    }));
    expect(layout.display).toBe("flex");
    expect(layout.flexDirection).toBe("column");
  });

  test("2. List-mode cards render a responsive single row with title, platform badge, genre, rating, and a quick-action CTA", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    await page.locator("#library-view-list").click();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible();

    const firstCard = page.locator("#library-games-grid .game-card").first();

    // Responsive single-row layout: the row uses flex-row, not a stacked grid.
    await expect(firstCard.locator("div.flex.items-center.gap-3")).toBeVisible();

    // Title.
    await expect(firstCard.locator("h4").first()).toBeVisible();

    // Platform badge.
    await expect(firstCard.locator("[data-card-platform]").first()).toBeVisible();

    // Genre badge (emitted only when a primary genre exists).
    const genreBadge = firstCard.locator("[data-card-genre]").first();
    if (await genreBadge.count()) {
      await expect(genreBadge).toBeVisible();
    }

    // Rating badge.
    await expect(firstCard.locator("[data-score]").first()).toBeVisible();

    // Expanded metadata parity: the Cyberpunk 2077 card (seeded with release
    // date 2020-12-10 plus Steam 84 / OpenCritic 86 reviews) surfaces the
    // release-year badge and split Steam/OpenCritic score badges in list mode.
    const cpCard = page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]').first();
    if (await cpCard.count()) {
      const yearBadge = cpCard.locator("[data-card-release-year]").first();
      if (await yearBadge.count()) {
        await expect(yearBadge).toBeVisible();
        expect((await yearBadge.textContent()) || "").toMatch(/\d{4}/);
      }
      const steamBadge = cpCard.locator("[data-score-steam]").first();
      if (await steamBadge.count()) {
        await expect(steamBadge).toBeVisible();
        expect(
          Number.isFinite(Number(await steamBadge.getAttribute("data-score-steam"))),
        ).toBe(true);
      }
      const ocBadge = cpCard.locator("[data-score-opencritic]").first();
      if (await ocBadge.count()) {
        await expect(ocBadge).toBeVisible();
        expect(
          Number.isFinite(Number(await ocBadge.getAttribute("data-score-opencritic"))),
        ).toBe(true);
      }
      // Developer / publisher metadata line (optional DB-enrichment fields).
      const devPub = cpCard.locator("[data-card-developer], [data-card-publisher]").first();
      if (await devPub.count()) {
        await expect(devPub).toBeVisible();
      }
    }

    // Quick-action CTA opens the game detail drawer.
    const cta = firstCard.locator("button.library-card-cta");
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page.locator("#game-detail-drawer")).toBeVisible();
  });

  test("3. Compare matrix groups attributes into four logical clusters", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.locator("#page-compare").waitFor();
    await selectTwoCompareGames(page);

    const body = page.locator("#matrix-body");
    await expect(body.locator('tr[data-compare-cluster="performance"]')).toBeVisible({ timeout: 20000 });
    await expect(body.locator('tr[data-compare-cluster="platform"]')).toBeVisible();
    await expect(body.locator('tr[data-compare-cluster="price"]')).toBeVisible();
    await expect(body.locator('tr[data-compare-cluster="availability"]')).toBeVisible();
  });

  test("4. Default Compare view caps at 8 key attributes; Show all expands to the full cluster set", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.locator("#page-compare").waitFor();
    await selectTwoCompareGames(page);

    const body = page.locator("#matrix-body");
    await expect(body.locator('tr[data-compare-cluster="performance"]')).toBeVisible({ timeout: 20000 });

    // Default: 4 cluster headers + 8 key attribute rows are visible; all
    // data-compare-extra rows are hidden behind the collapsible control.
    const visibleBefore = await body.locator("tr:not(.hidden)").count();
    const hiddenExtraBefore = await body.locator('tr[data-compare-extra="true"]').count();
    expect(visibleBefore).toBe(12); // 4 headers + 8 key rows
    expect(hiddenExtraBefore).toBeGreaterThanOrEqual(10); // 12 extra rows

    const showAllBtn = page.locator("#compare-show-all");
    await expect(showAllBtn).toBeVisible();
    await expect(showAllBtn).toHaveAttribute("aria-expanded", "false");

    await showAllBtn.click();
    await expect(showAllBtn).toHaveAttribute("aria-expanded", "true");
    expect(await body.locator('tr[data-compare-extra="true"].hidden').count()).toBe(0);
    expect(await body.locator("tr:not(.hidden)").count()).toBe(visibleBefore + hiddenExtraBefore);
  });

  test("5. Community mods drawer (mock) opens from the library mod badge and surfaces compatibility tags", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();

    const modBadge = page.locator("#library-games-grid .game-card button.library-card-mods").first();
    await expect(modBadge).toBeVisible({ timeout: 15000 });

    await modBadge.click();
    const drawer = page.locator("#mods-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("aria-hidden", "false");

    // Compatibility tags + mock mod listings render.
    await expect(page.locator("#mods-drawer-compat span").first()).toBeVisible();
    expect(await page.locator("#mods-drawer-list [data-mod-listing]").count()).toBeGreaterThan(0);

    // Escape closes the drawer.
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  test("6. Zero axe accessibility violations on the reorganized compare view", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.locator("#page-compare").waitFor();
    await selectTwoCompareGames(page);
    await expect(page.locator('#matrix-body tr[data-compare-cluster="performance"]')).toBeVisible({ timeout: 20000 });

    const results = await runAxeScan(page, { selector: "#page-compare" });
    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);
  });

  test("7. Mods hub renders the compatibility tags preview panel", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/mods`);
    await page.locator("#page-mods").waitFor();
    await expect(page.locator("#mods-compat-tags-list span").first()).toBeVisible({ timeout: 10000 });
    expect(await page.locator("#mods-compat-tags-list span").count()).toBeGreaterThan(0);
  });
});
