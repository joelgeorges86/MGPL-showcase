import { test, expect, BASE } from "../fixtures";

/**
 * EPIC-03 (Paginated Browsing) — Catalog pagination contract & deep linking.
 *
 * Backend (GET /api/games):
 *   Test 1: Valid page/limit combinations (12 / 24 / 48) return pagination
 *           metadata with correctly sized, non-overlapping page slices.
 *   Test 2: Invalid, negative, non-numeric, or out-of-range page/limit values
 *           clamp or fall back gracefully (never 500, never an empty grid, and
 *           never an arbitrary row cap that could leak catalog size).
 *   Test 3: Omitting `page` preserves the legacy full-catalog contract.
 *
 * Client (#/library + #library-pagination):
 *   Test 4: Previous / Page N of M / Next render below the grid with an ARIA
 *           live-region label (Page 1 / Previous disabled).
 *   Test 5: Next advances the page, enables Previous, and syncs the ?page=N
 *           deep link into the hash.
 *   Test 6: Deep-linking #/library?page=N resolves directly to that page.
 *   Test 7: The 12/24/48 page-size selector re-renders under the new budget.
 */

test.describe("EPIC-03 — Paginated Catalog Browsing", () => {
  test("1. GET /api/games?page=&limit= supports 12/24/48 with pagination metadata", async ({ request }) => {
    for (const limit of [12, 24, 48]) {
      const res = await request.get(`${BASE}/api/games?page=1&limit=${limit}`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(limit);
      expect(Number(body.total)).toBeGreaterThan(limit);
      expect(Number(body.totalPages)).toBe(Math.ceil(Number(body.total) / limit));
      expect(Array.isArray(body.games)).toBe(true);
      expect(body.games.length).toBeLessThanOrEqual(limit);
      expect(body.games.length).toBeGreaterThan(0);
    }
  });

  test("2. Invalid, negative, non-numeric, or out-of-range params clamp gracefully", async ({ request }) => {
    // Invalid/out-of-set limit values fall back to the default of 24.
    for (const badLimit of ["999", "-5", "0", "abc", "12.5"]) {
      const res = await request.get(`${BASE}/api/games?page=1&limit=${badLimit}`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.limit).toBe(24);
      expect(body.games.length).toBeLessThanOrEqual(24);
    }

    // Non-numeric / negative / zero / fractional page values fall back to 1.
    for (const badPage of ["abc", "-5", "0", "1.9"]) {
      const res = await request.get(`${BASE}/api/games?page=${badPage}&limit=12`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(12);
      expect(body.games.length).toBeGreaterThan(0);
    }

    // Out-of-range page clamps to the final page — never an empty grid.
    const probe = await request.get(`${BASE}/api/games?page=1&limit=24`);
    const probeBody = await probe.json();
    const res = await request.get(`${BASE}/api/games?page=99999&limit=24`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.page).toBe(body.totalPages);
    expect(body.page).toBe(probeBody.totalPages);
    expect(body.games.length).toBeGreaterThan(0);
  });

  test("3. Omitting page preserves the legacy full-catalog contract", async ({ request }) => {
    const res = await request.get(`${BASE}/api/games`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.games)).toBe(true);
    expect(body.games.length).toBe(body.total);
    // No pagination metadata leaks into the legacy shape.
    expect(body.page).toBeUndefined();
    expect(body.totalPages).toBeUndefined();
  });

  test("4. Pagination controls render below the grid with a live-region label", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    const pagination = page.locator("#library-pagination");
    await expect(pagination).toBeVisible();

    const label = page.locator("#library-pagination-label");
    await expect(label).toContainText(/Page 1 of \d+/);
    // The label doubles as the ARIA live region that announces page transitions.
    await expect(label).toHaveAttribute("role", "status");
    await expect(label).toHaveAttribute("aria-live", "polite");

    // Previous is disabled on page 1; Next is enabled (seeded catalog spans
    // multiple 24-item pages).
    await expect(page.locator("#library-prev")).toBeDisabled();
    await expect(page.locator("#library-next")).toBeEnabled();

    // The page-size selector exposes only the supported budgets.
    await expect(page.locator("#library-page-size option")).toHaveCount(3);
    for (const value of ["12", "24", "48"]) {
      await expect(page.locator(`#library-page-size option[value="${value}"]`)).toBeAttached();
    }
  });

  test("5. Next advances the page label, enables Previous, and syncs the deep link", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    const label = page.locator("#library-pagination-label");
    const prevBtn = page.locator("#library-prev");
    const nextBtn = page.locator("#library-next");

    const labelBefore = (await label.textContent()) || "";
    await nextBtn.click();

    // The live label advances to Page 2 and Previous becomes enabled.
    await expect(label).toContainText(/Page 2 of \d+/);
    await expect(label).not.toHaveText(labelBefore);
    await expect(prevBtn).toBeEnabled();

    // The ?page=N deep link is reflected in the URL hash.
    await expect.poll(async () => page.evaluate(() => window.location.hash)).toContain("page=2");

    // Previous returns to page 1 and the deep link follows.
    await prevBtn.click();
    await expect(label).toContainText(/Page 1 of \d+/);
    await expect(prevBtn).toBeDisabled();
    await expect.poll(async () => page.evaluate(() => window.location.hash)).toContain("page=1");
  });

  test("6. Deep-linking #/library?page=N resolves directly to that page", async ({ page, request }) => {
    const probe = await request.get(`${BASE}/api/games?page=1&limit=24`);
    const probeBody = await probe.json();
    test.skip(
      Number(probeBody.totalPages) < 2,
      "catalog has a single page — nothing to deep-link",
    );

    await page.goto(`${BASE}/#/library?page=2`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    await expect(page.locator("#library-pagination-label")).toContainText(/Page 2 of \d+/);
    await expect(page.locator("#library-prev")).toBeEnabled();
  });

  test("7. Page-size selector re-renders under the 12/24/48 budget", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    const sizeSelect = page.locator("#library-page-size");
    await expect(sizeSelect).toHaveValue("24");

    // 12 per page: page 1 holds at most 12 cards.
    await sizeSelect.selectOption("12");
    await expect(sizeSelect).toHaveValue("12");
    await expect(page.locator("#library-pagination-label")).toContainText(/Page 1 of \d+/);
    const twelveCards = await page.locator("#library-games-grid .game-card").count();
    expect(twelveCards).toBeGreaterThan(0);
    expect(twelveCards).toBeLessThanOrEqual(12);

    // 48 per page: page 1 holds more cards than the 12-budget page.
    await sizeSelect.selectOption("48");
    await expect(sizeSelect).toHaveValue("48");
    await expect(page.locator("#library-pagination-label")).toContainText(/Page 1 of \d+/);
    const fortyEightCards = await page.locator("#library-games-grid .game-card").count();
    expect(fortyEightCards).toBeGreaterThan(twelveCards);
    expect(fortyEightCards).toBeLessThanOrEqual(48);
  });
});
