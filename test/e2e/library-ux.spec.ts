import { test, expect, BASE } from '../fixtures';
import { revealLibraryGameCard } from '../helpers/library-pagination';

/**
 * EPIC-UX-LIBRARY-0001 — Games Library High-Density Filtering, Wrapped
 * Platform Facets & Decision-Support Cards.
 *
 * Test 1: Platform filters render in a wrapped multi-select badge group with
 *         game-count pills and no horizontal scroll overflow (the legacy
 *         horizontal scroll bar is replaced by `flex flex-wrap gap-2`).
 * Test 2: Filtering by genre (toolbar dropdown) and by Smart Binder tag pills
 *         updates the rendered game grid dynamically.
 * Test 3: Sorting by "Top Reviewed" orders the rendered cards in descending
 *         review-score sequence (monotonic non-increasing `data-score`).
 * Test 4: Game cards render HLTB completion-time badges, review-score badges,
 *         and owned-platform indicators.
 *
 * Runs against the deterministic seeded baseline (test/global-setup.ts) and
 * only touches read-only surfaces. The genre/tag lists are derived client
 * side from the full owned library, so no server mutation is required.
 */

test.describe('EPIC-UX-LIBRARY-0001 — High-Density Library UX', () => {
  test('1. Platform filters render in a wrapped layout without horizontal scroll overflow', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();

    const facets = page.locator('#library-platform-facets');
    await expect(facets).toBeVisible();
    // Wait for the fetched owned-library to populate the facet group.
    await expect(facets.locator('.library-facet-pill').first()).toBeVisible({ timeout: 15000 });

    // Wrapped multi-select badge group: flex + wrap, never a horizontal scrollbar.
    const wrapState = await facets.evaluate((el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      return {
        display: style.display,
        flexWrap: style.flexWrap,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    expect(wrapState.display).toBe('flex');
    expect(wrapState.flexWrap).toBe('wrap');
    // No horizontal overflow inside the facet group.
    expect(wrapState.scrollWidth).toBeLessThanOrEqual(wrapState.clientWidth + 1);

    // The group exposes the "All Platforms" reset plus the primary storefront badges.
    const facetCount = await facets.locator('.library-facet-pill').count();
    expect(facetCount).toBeGreaterThanOrEqual(9); // All Platforms + 8 storefront facets
    await expect(facets.locator('.library-facet-pill[data-platform-facet="all"]')).toBeVisible();
    await expect(facets.locator('.library-facet-pill[data-platform-facet="steam"]')).toBeVisible();
    await expect(facets.locator('.library-facet-pill[data-platform-facet="playstation"]')).toBeVisible();

    // Every badge carries a game-count pill (the nested count <span>).
    const countPills = await facets.locator('.library-facet-pill .px-1\\.5').count();
    expect(countPills).toBeGreaterThanOrEqual(9);
  });

  test('2. Filtering by genre or tags updates the rendered game grid dynamically', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible({ timeout: 15000 });

    // --- Genre multi-select checkbox dropdown ---
    const genreDropdownBtn = page.locator('#library-genre-dropdown-btn');
    await expect(genreDropdownBtn).toBeVisible();
    await genreDropdownBtn.click();
    const genreDropdown = page.locator('#library-genre-dropdown');
    await expect(genreDropdown.locator('input[data-genre-facet="RPG"]')).toBeVisible();

    await genreDropdown.locator('input[data-genre-facet="RPG"]').check({ force: true });
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    // 112 Operator is Simulation-only, so it must disappear under the RPG filter.
    await expect(page.locator('#library-games-grid .game-card[data-game-title="112 Operator"]')).toHaveCount(0);

    // Reset to All Genres restores the catalog; 112 Operator sorts onto page 1.
    await genreDropdown.locator('input[data-genre-facet="RPG"]').uncheck({ force: true });
    await expect(page.locator('#library-games-grid .game-card[data-game-title="112 Operator"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();

    // --- Smart Binder tag filter (owned by the deterministic Alex user) ---
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' },
    });
    expect(login.ok()).toBeTruthy();

    // The library route was already visited as a guest above, so the SPA's
    // loadedRoutes guard would skip renderSmartBinders() on an in-page
    // re-navigation. A full reload re-boots the app with the auth cookie and
    // re-runs the library route (empty loadedRoutes) so the tag pills render.
    await page.reload();
    await page.locator('#page-library').waitFor();

    const binders = page.locator('#library-smart-binders');
    const moddablePill = binders.locator('.smart-binder-pill[data-tag-name="Moddable"]');
    await expect(moddablePill).toBeAttached();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible({ timeout: 15000 });

    // Filter to the Moddable tag: exactly Cyberpunk 2077 + The Witcher 3.
    await moddablePill.click({ force: true });
    await expect(page.locator('#library-games-grid .game-card')).toHaveCount(2);
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="The Witcher 3: Wild Hunt"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Elden Ring"]')).toHaveCount(0);

    // Toggle the pill off -> the catalog resets. Cyberpunk (rated) renders on
    // page 1; Elden Ring is unrated so it may live on a later page.
    await moddablePill.click({ force: true });
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    const eldenFound = await revealLibraryGameCard(page, 'Elden Ring');
    expect(eldenFound).toBe(true);
  });

  test('3. Sorting by Top Reviewed orders cards in descending rating sequence', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible({ timeout: 15000 });

    const sortSelect = page.locator('#library-sort-select');
    await expect(sortSelect).toBeVisible();

    // Switch away then to "Top Reviewed" so a change event fires deterministically.
    await sortSelect.selectOption('title-asc');
    await sortSelect.selectOption('score-desc');

    // Debounced re-render (120 ms) settles quickly; wait for the grid to reflect
    // the sort by checking the select value and the rendered score badges.
    await expect(sortSelect).toHaveValue('score-desc');
    await page.waitForTimeout(400);

    const scores = await page
      .locator('#library-games-grid .library-card-score[data-score]')
      .evaluateAll((els: HTMLElement[]) =>
        els.map((el) => Number(el.getAttribute('data-score') || 0)),
      );
    expect(scores.length).toBeGreaterThan(0);

    // Monotonic non-increasing review-score sequence across rendered cards.
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  test('4. Game cards render completion time, review badges, and platform ownership indicators', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible({ timeout: 15000 });

    // HLTB completion-time badge (seeded AppCompletionRoadmap rows feed
    // hltbMainHours), e.g. Cyberpunk 2077 "⏱️ 25h Main".
    const hltbBadge = page.locator('#library-games-grid .library-card-hltb').first();
    await expect(hltbBadge).toBeVisible();
    const hltbText = (await hltbBadge.textContent()) || '';
    expect(hltbText).toMatch(/\d+(\.\d+)?h Main/);

    // Review-score badge with a deterministic numeric data-score. The seeded
    // baseline orders Hades (composite 96) into the first rendered chunk, so the
    // first badge carries an 80+ score.
    const scoreBadge = page.locator('#library-games-grid .library-card-score[data-score]').first();
    await expect(scoreBadge).toBeVisible();
    const scoreVal = Number(await scoreBadge.getAttribute('data-score'));
    expect(scoreVal).toBeGreaterThanOrEqual(80);

    // Owned-platform indicator row. The auto-generated Steam ownership rows for
    // the full seeded catalog guarantee data-owned-platform icons on rendered cards.
    const platformIcon = page.locator('#library-games-grid [data-owned-platform]').first();
    await expect(platformIcon).toBeVisible();
    const platformLabel = await platformIcon.getAttribute('data-owned-platform');
    expect(platformLabel).toBeTruthy();

    // Clicking anywhere on a card opens the unified game detail drawer.
    await page.locator('#library-games-grid .game-card').first().click();
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
  });
});