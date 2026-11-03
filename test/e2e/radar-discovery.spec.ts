import { test, expect } from "../fixtures";

/**
 * Sprint 1 (EPIC-RADAR-0001) — Hidden Gems Engine & Live Freebies Hub.
 *
 *   Test 1: GET /api/games?filter=hidden-gems must return only titles whose
 *           compositeScore >= 80 (verified per returned game), include the
 *           seeded niche/indie fixtures (Hades, Hollow Knight, Celeste,
 *           Dead Cells, Slay the Spire, Factorio), and never include a
 *           high-rated AAA-only title (The Witcher 3) that lacks a niche tag.
 *   Test 2: Clicking the "Hidden Gems" quick-toggle in Library navigation
 *           renders the curated list into #library-games-grid.
 *   Test 3: The Active Freebies shelf renders giveaways with a title,
 *           platform badge(s), and a direct claim button linking out.
 */

const BASE = "http://localhost:4000";

test.describe("Hidden Gems Engine & Live Freebies Hub (EPIC-RADAR-0001)", () => {
  test("1. GET /api/games?filter=hidden-gems returns composite >= 80 niche/indie titles", async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/games?filter=hidden-gems`, {
      headers: { Accept: "application/json" },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);

    const games = Array.isArray(data.games) ? data.games : [];
    expect(games.length).toBeGreaterThan(0);

    // Every returned game must meet the 80+ composite threshold.
    for (const g of games as Array<Record<string, unknown>>) {
      expect(Number(g.compositeScore)).toBeGreaterThanOrEqual(80);
    }

    // Curated niche/indie fixtures must be present.
    const titles = (games as Array<Record<string, unknown>>).map(
      (g) => String(g.title || g.gameTitle || "").toLowerCase()
    );
    for (const expected of ["hades", "hollow knight", "celeste", "dead cells", "slay the spire", "factorio"]) {
      expect(titles.some((t: string) => t.includes(expected))).toBeTruthy();
    }

    // AAA-only Witcher 3 (no niche/indie keyword) must be excluded.
    expect(titles.some((t: string) => t.includes("witcher"))).toBeFalsy();
  });

  test("2. Clicking Hidden Gems quick-toggle renders curated list in Library", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await expect(page.locator("#page-library")).toBeVisible();

    const toggle = page.locator('#library-hidden-gems-toggle');
    await expect(toggle).toBeVisible();
    await toggle.check();

    const grid = page.locator("#library-games-grid");
    await expect(grid).toBeVisible();

    // Wait for the virtualized renderer to hydrate at least one card.
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    const titles = await page
      .locator("#library-games-grid .game-card[data-game-title]")
      .evaluateAll((cards) => cards.map((c) => (c as HTMLElement).getAttribute("data-game-title") || ""));

    // The curated list must include at least one seeded niche title.
    const joined = titles.join(" ").toLowerCase();
    expect(joined).toContain("hades");
  });

  test("3. Active Freebies shelf renders giveaways with title, platform badge and claim button", async ({ page }) => {
    await page.goto(`${BASE}/#/deals`);
    await expect(page.locator("#page-deals")).toBeVisible();

    const giveawaysTab = page.locator('#deals-store-tabs .deals-tab-btn[data-store="giveaways"]');
    await expect(giveawaysTab).toBeVisible();
    await giveawaysTab.click();

    const shelf = page.locator("#deals-panel-giveaways");
    await expect(shelf).toBeVisible();

    const freebieCard = page.locator(".freebie-card").first();
    await expect(freebieCard).toBeVisible({ timeout: 15000 });

    // Title present.
    await expect(freebieCard.locator("h4")).not.toBeEmpty();

    // Platform badge present.
    const platformBadge = freebieCard.locator(".freebie-platform").first();
    await expect(platformBadge).toBeVisible();

    // Claim button present and links out (not a bare '#').
    const claimBtn = freebieCard.locator(".freebie-claim-btn").first();
    await expect(claimBtn).toBeVisible();
    const href = await claimBtn.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href).not.toBe("#");
  });
});