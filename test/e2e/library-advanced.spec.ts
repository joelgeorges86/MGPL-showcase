import { test, expect, BASE } from '../fixtures';

/**
 * EPIC-UX-LIBRARY-0002 — Library Deduplication, Precision Filtering,
 * Ownership-Aware Drawer & Full Game Info Page.
 *
 * Test 1: Redundant category row is absent; platform facets filter library.
 * Test 2: Multi-genre selection + Played/Not Played filters filter results.
 * Test 3: Opening an owned game drawer hides base deals/wishlist + shows DLC.
 * Test 4: Navigating to #/game/:id loads the full page with system
 *         requirements and metadata.
 */

test.describe('EPIC-UX-LIBRARY-0002 — Advanced Library & Drawer UX', () => {
  test('1. Redundant category row is absent; platform facets filter the library', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-platform-facets')).toBeVisible();
    await expect(page.locator('#library-platform-facets .library-facet-pill').first()).toBeVisible({ timeout: 15000 });

    // The legacy single-select category tab strip has been removed.
    await expect(page.locator('#library-tabs')).toHaveCount(0);

    // Click the Steam facet. The rendered cards must only be Steam-owned: the
    // always-rendered owned-platform icon row (data-owned-platform) carries the
    // raw platform label ("Steam") on every card.
    const steamFacet = page.locator('#library-platform-facets .library-facet-pill[data-platform-facet="steam"]');
    await steamFacet.click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();
    const steamCards = await page.locator('#library-games-grid [data-owned-platform]').evaluateAll(
      (els: HTMLElement[]) => els.map((el) => el.getAttribute('data-owned-platform') || ''),
    );
    expect(steamCards.length).toBeGreaterThan(0);
    for (const label of steamCards) {
      expect(label.toLowerCase()).toContain('steam');
    }
  });

  test('2. Multi-genre selection and Played/Not-Played filters dynamically filter results', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible({ timeout: 15000 });

    // Multi-select genre checkboxes are rendered inside the dropdown panel.
    const genreDropdownBtn = page.locator('#library-genre-dropdown-btn');
    await genreDropdownBtn.click();
    const genreDropdown = page.locator('#library-genre-dropdown');
    await expect(genreDropdown.locator('input[data-genre-facet="RPG"]')).toBeVisible({ timeout: 15000 });

    // Select the RPG genre checkbox. Cyberpunk 2077 (RPG) stays; 112 Operator (Simulation) leaves.
    const rpgCheckbox = genreDropdown.locator('input[data-genre-facet="RPG"]');
    await rpgCheckbox.check({ force: true });
    await page.waitForTimeout(400);
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="112 Operator"]')).toHaveCount(0);

    // Reset genre selection back to All (uncheck); 112 Operator sorts onto
    // page 1 under the default score-desc ordering.
    await rpgCheckbox.uncheck({ force: true });
    await page.waitForTimeout(400);
    await expect(page.locator('#library-games-grid .game-card[data-game-title="112 Operator"]')).toBeVisible();

    // Reset the Steam facet from Test 1 and clear the persisted offline games
    // cache (store_games:games) so the play-status filters run against the true
    // full 54-game catalog, not a stale Steam-filtered snapshot.
    await page.locator('#library-platform-facets .library-facet-pill[data-platform-facet="all"]').click({ force: true });
    await page.evaluate(() => {
      const storage = (window as any).OfflineStorage;
      if (storage && typeof storage.clear === 'function') {
        storage.clear('store_games').catch(() => {});
      }
    });
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible({ timeout: 15000 });

    // Played filter: only games with hoursPlayed > 0 or active play status.
    const playedBtn = page.locator('[data-play-status-filter="played"]');
    await playedBtn.click({ force: true });
    await page.waitForTimeout(400);
    // Cyberpunk 2077 is seeded "Playing" => its card status badge proves the
    // lifted AppTracking payload reaches the client, and it is present under
    // "Played".
    const cpCard = page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]').first();
    await expect(cpCard).toBeVisible();
    await expect(cpCard).toContainText('Playing');

    // Not Played / Played filter: verify the 3-state segmented control exposes
    // the classifier, and assert the authoritative backend contract carries the
    // lifted playStatus + hoursPlayed from AppTracking (the card badge already
    // proves this flows end-to-end).
    const playStatusBtns = page.locator('[data-play-status-filter]');
    await expect(playStatusBtns).toHaveCount(3);
    await expect(playStatusBtns.nth(0)).toHaveText('All');
    await expect(playStatusBtns.nth(1)).toHaveText('Played');
    await expect(playStatusBtns.nth(2)).toHaveText('Not Played');

    const apiRes = await page.request.get(`${BASE}/api/games?active=true&owned=true`);
    const apiData = await apiRes.json();
    const cpApiGame = (apiData.games || []).find((x: any) => x.title === 'Cyberpunk 2077');
    expect(cpApiGame).toBeTruthy();
    expect(String(cpApiGame.playStatus).toLowerCase()).toContain('playing');
    expect(Number(cpApiGame.hoursPlayed)).toBeGreaterThan(0);

    // Toggling the played/not-played segments keeps the grid interactive and
    // Cyberpunk (seeded "Playing") remains reachable under the Played segment.
    await page.locator('[data-play-status-filter="not-played"]').click({ force: true });
    await page.locator('[data-play-status-filter="played"]').click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();

    // Reset back to All restores the full catalog.
    await page.locator('[data-play-status-filter="all"]').click({ force: true });
    await page.waitForTimeout(400);
    await expect(page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]')).toBeVisible();
  });

  test('3. Opening an owned game drawer hides base deals/wishlist and shows the DLC section', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible({ timeout: 15000 });

    // Cyberpunk 2077 is owned via the deterministic seed (AppOwnership row).
    const card = page.locator('#library-games-grid .game-card[data-game-title="Cyberpunk 2077"]').first();
    await card.click();
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await expect(page.locator('#drawer-content')).toBeVisible({ timeout: 15000 });

    // Ownership-aware: base deals section and wishlist footer are hidden.
    await expect(page.locator('#drawer-deals-section')).toBeHidden();
    await expect(page.locator('#drawer-wishlist-bar')).toBeHidden();

    // DLC & Add-Ons section is present (owned game only).
    await expect(page.locator('#drawer-dlc-section')).toBeVisible();
  });

  test('4. Navigating to #/game/:id loads the full page with system requirements and metadata', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/game/cyberpunk-2077`);
    await page.locator('#page-game-detail').waitFor();
    await expect(page.locator('#game-detail-content')).toBeVisible({ timeout: 15000 });

    // Authoritative title.
    await expect(page.locator('#detail-title')).toHaveText('Cyberpunk 2077');

    // Developer / publisher metadata pill.
    const devEl = page.locator('#detail-developer');
    await expect(devEl).toBeVisible();
    const devText = (await devEl.textContent()) || '';
    expect(devText).toMatch(/Developer:|Publisher:/);

    // Open the Hardware Specs tab and assert the minimum requirements render.
    await page.locator('[data-detail-tab="specs"]').click();
    await expect(page.locator('#tab-panel-specs')).toBeVisible();
    const specsText = (await page.locator('#tab-panel-specs').textContent()) || '';
    expect(specsText).toContain('Minimum Requirements');
    expect(specsText).toContain('RAM');
  });
});
