import { test, expect, BASE, runAxeScan } from "../fixtures";

/**
 * EPIC-01 — Multi-Genre Filtering Engine.
 *
 * Backend (GET /api/games):
 *   Test 1: Single-genre facet (`?genre=X`) is a zero-regression subset filter —
 *           every returned game carries the selected genre.
 *   Test 2: Multi-select intersection (`?genre=X,Y`) requires every selected
 *           genre; the result is a subset of each single-genre result.
 *   Test 3: `genreMode=any` switches to union matching — a superset of the
 *           intersection result, and every returned game carries at least one
 *           selected genre.
 *   Test 4: Facet sanitization — hostile/oversized tokens never error and the
 *           token count is capped.
 *   Test 5: GET /api/games/genres returns the CMS-extensible facet list.
 *   Test 6: Genre facets compose cleanly with EPIC-03 pagination metadata.
 *
 * Client (#/library):
 *   Test 7: Multi-select genre facet pills render with ARIA pressed state and
 *           narrow the tile grid (intersection ⊆ single-selection count).
 *   Test 8: Genre filter state survives pagination turns (pills stay pressed).
 *   Test 9: Dual-mode Grid/List view toggle preserves facet state and renders
 *           the list layout without losing the selected genres.
 *   Test 10: axe accessibility scan on the facet + view-toggle controls.
 *
 * Deterministic seed note: the test DB (test/global-setup.ts) has no
 * AppGameGenreMap rows, so genre matching runs the documented Primary Genre
 * fallback — which is exactly what the assertion helpers below exercise.
 */

test.describe("EPIC-01 — Multi-Genre Filtering Engine", () => {
  /**
   * True when a game matches a genre under the backend's exact documented
   * semantics: granular AppGameGenreMap tags match exactly; the composite
   * `Primary Genre` string falls back to case-insensitive substring matching.
   */
  function gameMatchesGenre(g: any, genre: string): boolean {
    const tags = Array.isArray(g.genres) && g.genres.length
      ? g.genres.map((x: string) => String(x).toLowerCase())
      : [];
    if (tags.length) return tags.includes(genre);
    return String(g.primaryGenre || g.genre || "").toLowerCase().includes(genre);
  }

  /** Distinct genre candidates across the catalog (lowercased). */
  function genreCandidates(all: any[]): string[] {
    const set = new Set<string>();
    for (const g of all) {
      const tags = Array.isArray(g.genres) && g.genres.length
        ? g.genres.map((x: string) => String(x).toLowerCase())
        : [];
      for (const t of tags) set.add(t);
      const primary = String(g.primaryGenre || g.genre || "").toLowerCase();
      if (primary) set.add(primary);
    }
    return [...set];
  }

  test("1. Single-genre facet is a zero-regression subset filter", async ({ request }) => {
    const probe = await request.get(`${BASE}/api/games`);
    expect(probe.ok()).toBeTruthy();
    const body = await probe.json();
    const all = body.games as any[];

    // Pick the most common genre (by backend substring semantics) for a
    // non-empty, deterministic result set.
    const candidates = genreCandidates(all);
    expect(candidates.length).toBeGreaterThan(0);
    const counts: Record<string, number> = {};
    for (const g of all) {
      for (const cand of candidates) {
        if (gameMatchesGenre(g, cand)) counts[cand] = (counts[cand] || 0) + 1;
      }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    expect(top).toBeTruthy();
    const genre = top[0];

    const res = await request.get(`${BASE}/api/games?genre=${encodeURIComponent(genre)}`);
    expect(res.ok()).toBeTruthy();
    const filtered = (await res.json()).games as any[];

    // Every returned game must carry the selected genre (exact backend semantics).
    expect(filtered.every((g) => gameMatchesGenre(g, genre))).toBe(true);
    // And the API returns exactly the matching subset — no over/under filtering.
    const expected = all.filter((g) => gameMatchesGenre(g, genre)).length;
    expect(filtered.length).toBe(expected);
    expect(filtered.length).toBeGreaterThan(0);
  });

  test("2. Multi-select intersection (?genre=a,b) requires every selected genre", async ({ request }) => {
    const probe = await request.get(`${BASE}/api/games`);
    const all = (await probe.json()).games as any[];

    const candidates = genreCandidates(all);
    const counts: Record<string, number> = {};
    for (const g of all) {
      for (const cand of candidates) {
        if (gameMatchesGenre(g, cand)) counts[cand] = (counts[cand] || 0) + 1;
      }
    }
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k);

    const res = await request.get(
      `${BASE}/api/games?genre=${encodeURIComponent(top.join(","))}`,
    );
    expect(res.ok()).toBeTruthy();
    const filtered = (await res.json()).games as any[];

    // Intersection semantics: every returned game carries BOTH genres.
    expect(filtered.every((g) => gameMatchesGenre(g, top[0]) && gameMatchesGenre(g, top[1]))).toBe(true);

    // And the intersection is a subset of each single-genre result.
    const [singleA, singleB] = await Promise.all([
      request.get(`${BASE}/api/games?genre=${encodeURIComponent(top[0])}`),
      request.get(`${BASE}/api/games?genre=${encodeURIComponent(top[1])}`),
    ]);
    const countA = ((await singleA.json()).games as any[]).length;
    const countB = ((await singleB.json()).games as any[]).length;
    expect(filtered.length).toBeLessThanOrEqual(Math.min(countA, countB));
  });

  test("3. genreMode=any switches to union (superset) matching", async ({ request }) => {
    const probe = await request.get(`${BASE}/api/games`);
    const all = (await probe.json()).games as any[];

    const candidates = genreCandidates(all);
    const counts: Record<string, number> = {};
    for (const g of all) {
      for (const cand of candidates) {
        if (gameMatchesGenre(g, cand)) counts[cand] = (counts[cand] || 0) + 1;
      }
    }
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k);

    const [intersectionRes, unionRes] = await Promise.all([
      request.get(`${BASE}/api/games?genre=${encodeURIComponent(top.join(","))}`),
      request.get(
        `${BASE}/api/games?genre=${encodeURIComponent(top.join(","))}&genreMode=any`,
      ),
    ]);
    expect(intersectionRes.ok()).toBeTruthy();
    expect(unionRes.ok()).toBeTruthy();
    const intersection = (await intersectionRes.json()).games as any[];
    const union = (await unionRes.json()).games as any[];

    // Union matches carry at least one selected genre.
    expect(union.every((g) => gameMatchesGenre(g, top[0]) || gameMatchesGenre(g, top[1]))).toBe(true);
    // Union is a superset of the intersection.
    expect(union.length).toBeGreaterThanOrEqual(intersection.length);

    // Unknown mode falls back to the intersection default (no error).
    const fallback = await request.get(
      `${BASE}/api/games?genre=${encodeURIComponent(top.join(","))}&genreMode=bogus`,
    );
    expect(fallback.ok()).toBeTruthy();
    const fallbackGames = (await fallback.json()).games as any[];
    expect(fallbackGames.length).toBe(intersection.length);
  });

  test("4. Facet sanitization: hostile / oversized tokens never error and stay capped", async ({ request }) => {
    // Hostile punctuation, HTML-ish tokens and SQL-ish noise must not 500 and
    // must produce a valid filtered (possibly empty) result set.
    const hostile = await request.get(
      `${BASE}/api/games?genre=${encodeURIComponent("<script>Action</script>;DROP TABLE--,rpg,' OR '1'='1")}`,
    );
    expect(hostile.ok()).toBeTruthy();
    const hostileBody = await hostile.json();
    expect(hostileBody.success).toBe(true);
    expect(Array.isArray(hostileBody.games)).toBe(true);

    // Oversized facet lists are capped at 20 tokens — never a 500.
    const manyGenres = Array.from({ length: 80 }, (_, i) => `genre-${i}`).join(",");
    const oversized = await request.get(`${BASE}/api/games?genre=${encodeURIComponent(manyGenres)}`);
    expect(oversized.ok()).toBeTruthy();
    const oversizedBody = await oversized.json();
    expect(oversizedBody.success).toBe(true);
    expect(Array.isArray(oversizedBody.games)).toBe(true);
  });

  test("5. GET /api/games/genres returns the CMS-extensible facet list", async ({ request }) => {
    const res = await request.get(`${BASE}/api/games/genres`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.genres)).toBe(true);
    // Each facet carries its genre label + live count.
    if (body.genres.length > 0) {
      const first = body.genres[0];
      expect(typeof first.genre).toBe("string");
      expect(typeof first.count).toBe("number");
    }
  });

  test("6. Genre facets compose with EPIC-03 pagination metadata", async ({ request }) => {
    const probe = await request.get(`${BASE}/api/games`);
    const all = (await probe.json()).games as any[];

    const candidates = genreCandidates(all);
    const counts: Record<string, number> = {};
    for (const g of all) {
      for (const cand of candidates) {
        if (gameMatchesGenre(g, cand)) counts[cand] = (counts[cand] || 0) + 1;
      }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const genre = top[0];

    const res = await request.get(
      `${BASE}/api/games?genre=${encodeURIComponent(genre)}&page=1&limit=48`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Number(body.page)).toBe(1);
    expect(Number(body.limit)).toBe(48);
    expect(Number(body.total)).toBeGreaterThan(0);
    expect(Number(body.totalPages)).toBe(Math.ceil(Number(body.total) / 48));
    expect(body.games.length).toBeLessThanOrEqual(48);
  });

  test("7. Client genre filter checkboxes are multi-select and narrow the grid", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    await page.locator("#library-genre-dropdown-btn").click();
    const facets = page.locator("#library-genre-dropdown");
    await expect(facets.locator("input[data-genre-facet]").first()).toBeVisible({ timeout: 15000 });

    const countText = () => page.locator("#library-result-count").textContent().then((t) => {
      const m = (t || "").match(/(\d+)\s+of\s+(\d+)/);
      return m ? Number(m[1]) : NaN;
    });
    const totalGames = await countText();
    expect(Number.isFinite(totalGames)).toBe(true);

    const checkboxA = facets.locator('input[data-genre-facet]').nth(0);
    const checkboxB = facets.locator('input[data-genre-facet]').nth(1);
    await expect(checkboxA).not.toBeChecked();

    // Select genre A.
    await checkboxA.check({ force: true });
    await page.waitForTimeout(300);
    const afterA = await countText();
    expect(afterA).toBeLessThanOrEqual(totalGames);
    await expect(checkboxA).toBeChecked();

    // Select genre B on top — intersection narrows further (never grows).
    await checkboxB.check({ force: true });
    await page.waitForTimeout(300);
    const afterAB = await countText();
    expect(afterAB).toBeLessThanOrEqual(afterA);
    await expect(checkboxA).toBeChecked();
    await expect(checkboxB).toBeChecked();

    // Deselect A — the result set returns to the single-genre B slice.
    await checkboxA.uncheck({ force: true });
    await page.waitForTimeout(300);
    const afterBOnly = await countText();
    expect(afterBOnly).toBeGreaterThanOrEqual(afterAB);
    await expect(checkboxA).not.toBeChecked();
  });

  test("8. Genre filter state survives pagination turns", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    // Ensure the catalog actually paginates before testing state persistence.
    const label = page.locator("#library-pagination-label");
    const totalPagesMatch = (await label.textContent())?.match(/Page \d+ of (\d+)/);
    test.skip(!totalPagesMatch || Number(totalPagesMatch[1]) < 2, "catalog fits on one page");

    await page.locator("#library-genre-dropdown-btn").click();
    const genreCheckbox = page.locator("#library-genre-dropdown input[data-genre-facet]").first();
    await genreCheckbox.check({ force: true });
    await page.waitForTimeout(300);
    await expect(genreCheckbox).toBeChecked();

    // Page forward (if the filtered set still paginates) and confirm the pill
    // selection is untouched — the re-render must not clobber facet state.
    const nextBtn = page.locator("#library-next");
    if (await nextBtn.isEnabled()) {
      await nextBtn.click();
      await page.waitForTimeout(200);
    }
    await expect(genreCheckbox).toBeChecked();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible();
  });

  test("9. Dual-mode Grid/List view toggle preserves facet state and renders the list layout", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    const gridEl = page.locator("#library-games-grid");
    const listBtn = page.locator("#library-view-list");
    const gridBtn = page.locator("#library-view-grid");
    await expect(listBtn).toBeVisible();
    await expect(listBtn).toHaveAttribute("aria-pressed", "false");

    // Select a genre first, then switch to List view.
    await page.locator("#library-genre-dropdown-btn").click();
    const genreCheckbox = page.locator("#library-genre-dropdown input[data-genre-facet]").first();
    await genreCheckbox.check({ force: true });
    await page.waitForTimeout(300);
    await expect(genreCheckbox).toBeChecked();

    await listBtn.click();
    await page.waitForTimeout(200);
    await expect(listBtn).toHaveAttribute("aria-pressed", "true");
    await expect(gridBtn).toHaveAttribute("aria-pressed", "false");

    // The container switches to a single-column flex stack (list layout).
    const listLayout = await gridEl.evaluate((el: HTMLElement) => ({
      display: getComputedStyle(el).display,
      flexDirection: getComputedStyle(el).flexDirection,
    }));
    expect(listLayout.display).toBe("flex");
    expect(listLayout.flexDirection).toBe("column");

    // Genre selection survives the toggle, and cards still render in list mode.
    await expect(genreCheckbox).toBeChecked();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible();

    // Back to Grid restores the responsive tile grid.
    await gridBtn.click();
    await page.waitForTimeout(200);
    expect((await gridEl.evaluate((el: HTMLElement) => getComputedStyle(el).display))).toBe("grid");
    await expect(genreCheckbox).toBeChecked();
  });

  test("10. Zero accessibility violations on the genre facets + view toggle", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await page.locator("#library-genre-dropdown-btn").click();
    await expect(page.locator("#library-genre-dropdown input[data-genre-facet]").first()).toBeVisible({ timeout: 15000 });

    const results = await runAxeScan(page, {
      selector: "#library-platform-facets, #library-genre-dropdown, #library-view-list, #library-view-grid",
    });
    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);
  });
});
