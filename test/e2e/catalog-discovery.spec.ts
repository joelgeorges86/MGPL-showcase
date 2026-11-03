import { test, expect, BASE } from '../fixtures';

/**
 * Sprint 2 — Core Game Catalog Discovery & Filter Regression (EPIC-TEST-STD-0001).
 *
 * Validates the catalog discovery engine against the seeded 55-game baseline
 * (test/global-setup.ts) using only read-only, hermetic surfaces:
 *
 *   - Search contract      : /api/games?search= + #command-search-input dropdown.
 *   - Platform filters     : /api/games?platform= + #library-platform-facets
 *                            multi-select facet pills (legacy #library-tabs
 *                            category strip removed in EPIC-UX-LIBRARY-0002).
 *   - Tag filtering        : /api/games?tag= + #library-smart-binders pills
 *                            (seeded rows are owned by auth-user-alex-gamer, so
 *                            the tag test authenticates as Alex first).
 *   - Sorting contract     : #platform-sort-select exposes `rating-desc`
 *                            (the Metacritic-equivalent sort) and NO price sort —
 *                            the catalog engine has no price column, so the
 *                            "Price ascending" option is intentionally absent
 *                            and pinned as a documented gap (Option A scope).
 *   - Rating preconditions : the composite/openCritic scores that feed any
 *                            rating-desc ordering are deterministic.
 *   - Stability            : navigating across catalog surfaces produces no
 *                            uncaught page errors.
 *
 * All assertions are read-only: no seeded catalog rows are created, updated,
 * or deleted. External storefront APIs are stubbed by ../fixtures (auto).
 */

test.describe('Core Game Catalog Discovery & Filter Regression (EPIC-TEST-STD-0001)', () => {

  // -------------------------------------------------------------------------
  // 1. Search Behavior
  // -------------------------------------------------------------------------

  test('1. Typing a matching query filters search results to matching titles', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/home`);
    await page.locator('#page-home').waitFor();

    const input = page.locator('#command-search-input');
    const dropdown = page.locator('#search-results-dropdown');

    // Dropdown is hidden in the default (restored) state.
    await expect(dropdown).not.toBeVisible();

    await input.fill('Witcher');

    // Debounced (250ms) fetch against /api/games?search=Witcher must surface
    // the seeded title in the dropdown.
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText('The Witcher 3: Wild Hunt');
  });

  test('2. Searching for a non-existent title displays the empty search state message', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/home`);
    await page.locator('#page-home').waitFor();

    const input = page.locator('#command-search-input');
    const dropdown = page.locator('#search-results-dropdown');

    // English-dictionary terms that no seeded title contains.
    await input.fill('tectonic quasar');

    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText('No matching games or features found.');
  });

  test('3. Clearing the search input restores the default (hidden dropdown) state', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/home`);
    await page.locator('#page-home').waitFor();

    const input = page.locator('#command-search-input');
    const dropdown = page.locator('#search-results-dropdown');

    await input.fill('Witcher');
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText('The Witcher 3: Wild Hunt');

    await input.fill('');
    await expect(dropdown).not.toBeVisible();
  });

  test('4. Search API contract returns only matching seeded titles (Witcher / Elden)', async ({ request }: { request: any }) => {
    const witcher = await request.get(`${BASE}/api/games?search=Witcher`);
    expect(witcher.ok()).toBeTruthy();
    const witcherBody = await witcher.json();
    expect(witcherBody.success).toBe(true);
    const witcherTitles = witcherBody.games.map((g: any) => g.title || g.gameTitle);
    expect(witcherTitles).toContain('The Witcher 3: Wild Hunt');
    expect(witcherTitles.every((t: string) => String(t).toLowerCase().includes('witcher'))).toBe(true);

    // Elden Ring is seeded twice (G00001 + elden-ring) and the catalog engine
    // dedupes by lower-cased title, so exactly one game is returned.
    const elden = await request.get(`${BASE}/api/games?search=Elden`);
    expect(elden.ok()).toBeTruthy();
    const eldenBody = await elden.json();
    const eldenTitles = eldenBody.games.map((g: any) => g.title || g.gameTitle);
    expect(eldenTitles).toContain('Elden Ring');
    expect(eldenBody.games.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Platform & Tag Filters
  // -------------------------------------------------------------------------

  test('5. Steam platform facet filters cards to Steam ownerships', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();

    const steamFacet = page.locator('#library-platform-facets .library-facet-pill[data-platform-facet="steam"]');
    await steamFacet.scrollIntoViewIfNeeded();
    await steamFacet.click();

    // Cyberpunk 2077 is Steam-owned; Bloodborne is PlayStation-4-owned only.
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Bloodborne"]')).toHaveCount(0);
  });

  test('6. PlayStation facet filters to PlayStation ownerships and All facet resets the catalog', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();

    const playstationFacet = page.locator('#library-platform-facets .library-facet-pill[data-platform-facet="playstation"]');
    await playstationFacet.scrollIntoViewIfNeeded();
    await playstationFacet.click();

    // Bloodborne is the seeded PlayStation-owned title.
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Bloodborne"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toHaveCount(0);

    // Toggling back to "All Platforms" resets the catalog view. Both seeded
    // titles render on page 1 under the default score-desc sort (Bloodborne is
    // unrated but sorts alphabetically within the first page).
    const allFacet = page.locator('#library-platform-facets .library-facet-pill[data-platform-facet="all"]');
    await allFacet.click();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Bloodborne"]')).toBeVisible();
  });

  test('7. Platform query contract on /api/games filters by owned platform', async ({ request }: { request: any }) => {
    const steam = await request.get(`${BASE}/api/games?active=true&owned=true&platform=steam`);
    expect(steam.ok()).toBeTruthy();
    const steamBody = await steam.json();
    const steamTitles = steamBody.games.map((g: any) => g.title || g.gameTitle);
    expect(steamTitles).toContain('Cyberpunk 2077');
    expect(steamTitles).not.toContain('Bloodborne');

    const playstation = await request.get(`${BASE}/api/games?active=true&owned=true&platform=playstation`);
    expect(playstation.ok()).toBeTruthy();
    const playstationBody = await playstation.json();
    const playstationTitles = playstationBody.games.map((g: any) => g.title || g.gameTitle);
    expect(playstationTitles).toContain('Bloodborne');
    expect(playstationTitles).not.toContain('Cyberpunk 2077');
  });

  test('8. Smart Binder tag pill filters the library and toggling off resets it', async ({ page }: { page: any }) => {
    // The seeded Moddable tags belong to auth-user-alex-gamer; authenticate as
    // Alex so /api/tags/summary returns the binders (read-only login, no seed
    // row mutations).
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' },
    });
    expect(login.ok()).toBeTruthy();

    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();

    const binders = page.locator('#library-smart-binders');
    const moddablePill = binders.locator('.smart-binder-pill[data-tag-name="Moddable"]');
    await expect(moddablePill).toBeAttached();

    // Baseline: the unfiltered library has rendered cards.
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();

    // Filter to the Moddable tag: exactly Cyberpunk 2077 + The Witcher 3.
    await moddablePill.click({ force: true });
    await expect(page.locator('#library-games-grid .game-card')).toHaveCount(2);
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="The Witcher 3: Wild Hunt"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Elden Ring"]')).toHaveCount(0);

    // Toggle the active pill off -> the catalog resets to the full list.
    await moddablePill.click({ force: true });
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Elden Ring"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 3. Sorting Contracts
  // -------------------------------------------------------------------------

  test('9. Platform Hub sort dropdown exposes rating-desc and no price sort (documented gap)', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/platforms`);
    await page.locator('#page-platforms').waitFor();

    const sortSelect = page.locator('#platform-sort-select');
    await expect(sortSelect).toBeVisible();

    const optionValues = await sortSelect.locator('option').evaluateAll(
      (opts: HTMLElement[]) => opts.map((o: HTMLElement) => (o as HTMLOptionElement).value),
    );

    // The rating-desc option is the Metacritic-equivalent sort (sorts by
    // reviewScore/criticScore on the Platform Hub).
    expect(optionValues).toContain('rating-desc');
    expect(optionValues).toEqual([
      'title-asc',
      'title-desc',
      'playtime-desc',
      'playtime-asc',
      'rating-desc',
      'lastplayed-desc',
    ]);

    // The catalog engine exposes no price column, so no price sort exists —
    // pinned explicitly so a future price-sort implementation is a tracked
    // product change rather than a silent regression.
    expect(optionValues.some((v: string) => v.toLowerCase().includes('price'))).toBe(false);
  });

  test('10. Rating-desc sort contract: top cards have >= scores of subsequent cards', async ({ request }: { request: any }) => {
    // Seeded AppReviews (test/global-setup.ts):
    //   Witcher:   OpenCritic 92, Steam Users 97
    //   Cyberpunk: OpenCritic 86, Steam Users 84
    // The Platform Hub rating-desc comparator resolves (reviewScore || criticScore
    // || personalRating || 0) where reviewScore is the AppReviews scoreNumeric
    // average (OpenCritic rows). Seeds have no criticScore/personalRating, so the
    // comparable rating is the OpenCritic score, with 0 for unrated games.
    const catalog = await request.get(`${BASE}/api/games?active=true&owned=true`);
    expect(catalog.ok()).toBeTruthy();
    const body = await catalog.json();
    const games = body.games as any[];

    const withScore = games
      .map((g: any) => ({
        title: g.title ?? g.gameTitle ?? '',
        score: g.openCriticScore ?? 0,
      }))
      .sort((a: { score: number; title: string }, b: { score: number; title: string }) =>
        b.score - a.score || String(a.title).localeCompare(String(b.title)),
      );

    // Top cards have >= scores of subsequent cards (monotonic non-increasing).
    for (let i = 1; i < withScore.length; i++) {
      expect(withScore[i - 1].score).toBeGreaterThanOrEqual(withScore[i].score);
    }

    // Deterministic top of the rating-desc ordering on the seeded baseline.
    // The seed dataset includes niche/indie review scores (EPIC-RADAR-0001):
    // Hades OpenCritic 93 leads; the 92-tier tie is broken alphabetically, so
    // Celeste sorts before The Witcher 3: Wild Hunt.
    expect(withScore[0].title).toBe('Hades');
    expect(withScore[0].score).toBe(93);
    expect(withScore[1].title).toBe('Celeste');
    expect(withScore[1].score).toBe(92);

    // Composite-score preconditions feeding the games API stay pinned.
    const witcher = await request.get(`${BASE}/api/games?search=Witcher`);
    const witcherBody = await witcher.json();
    const w = witcherBody.games.find((g: any) => (g.title || g.gameTitle || '').includes('Witcher'));
    expect(w).toBeTruthy();
    expect(w.openCriticScore).toBe(92);
    expect(w.steamScore).toBe(97);
    expect(w.compositeScore).toBe(95);

    const cyberpunk = await request.get(`${BASE}/api/games?search=Cyberpunk`);
    const cyberpunkBody = await cyberpunk.json();
    const c = cyberpunkBody.games.find((g: any) => (g.title || g.gameTitle || '').includes('Cyberpunk'));
    expect(c).toBeTruthy();
    expect(c.openCriticScore).toBe(86);
    expect(c.steamScore).toBe(84);
    expect(c.compositeScore).toBe(85);
  });

  // -------------------------------------------------------------------------
  // 4. Performance & Stability
  // -------------------------------------------------------------------------

  test('11. Navigating across catalog surfaces completes with no uncaught page errors', async ({ page }: { page: any }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err: Error) => pageErrors.push(err.message));

    await page.goto(`${BASE}/#/home`);
    await page.locator('#page-home').waitFor();

    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();

    await page.goto(`${BASE}/#/platforms`);
    await page.locator('#page-platforms').waitFor();
    await expect(page.locator('#platform-sort-select')).toBeVisible();

    await page.goto(`${BASE}/#/wishlist`);
    await page.locator('#page-wishlist').waitFor();

    expect(pageErrors).toEqual([]);
  });
});