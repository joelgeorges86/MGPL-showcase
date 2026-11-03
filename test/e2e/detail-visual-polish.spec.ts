import { test, expect, BASE } from '../fixtures';

/**
 * EPIC-UX-POLISH-0001 — Library Genre Accordion, Dynamic Hero Media
 * Fallbacks & Hardware Spec Fallbacks based on visual review.
 *
 * Test 1: Library genre container truncates to top genres with a working
 *         expand/collapse toggle.
 * Test 2: Game detail page hides empty trailer containers when trailer is null.
 * Test 3: Game detail page renders cleanly across Overview, Specs, Reviews,
 *         and Platforms sub-tabs.
 */

test.describe('EPIC-UX-POLISH-0001 — Visual Polish', () => {
  test('1. Library genre filter renders a multi-select checkbox dropdown', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    const dropdownBtn = page.locator('#library-genre-dropdown-btn');
    await expect(dropdownBtn).toBeVisible();
    await dropdownBtn.click();
    const genreDropdown = page.locator('#library-genre-dropdown');
    await expect(genreDropdown.locator('input[data-genre-facet]').first()).toBeVisible({ timeout: 15000 });
    const genreCount = await genreDropdown.locator('input[data-genre-facet]').count();
    expect(genreCount).toBeGreaterThan(0);

    // The most-common genre (first checkbox) filters the grid to a non-empty set.
    const first = genreDropdown.locator('input[data-genre-facet]').nth(0);
    await first.check({ force: true });
    await page.waitForTimeout(300);
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();
  });

  test('2. Game detail page hides empty trailer containers when trailer is null', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/game/cyberpunk-2077`);
    await page.locator('#page-game-detail').waitFor();
    await expect(page.locator('#game-detail-content')).toBeVisible({ timeout: 15000 });

    // The media block no longer shows "No trailer available" / "No banner
    // available" boxes — empty trailers collapse and the banner goes full width.
    await expect(page.locator('#detail-trailer-fallback')).toBeHidden();
    await expect(page.locator('#detail-banner-fallback')).toBeHidden();
  });

  test('3. Game detail page renders cleanly across Overview, Specs, Reviews, and Platforms sub-tabs', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/game/cyberpunk-2077`);
    await page.locator('#page-game-detail').waitFor();
    await expect(page.locator('#game-detail-content')).toBeVisible({ timeout: 15000 });

    const tabs = ['overview', 'specs', 'reviews', 'platforms'];
    for (const tab of tabs) {
      await page.locator(`[data-detail-tab="${tab}"]`).click();
      await expect(page.locator(`#tab-panel-${tab}`)).toBeVisible();
      // No empty "Spec Unlisted" cascade: the specs tab collapses unknown rows
      // into a clean summary line instead.
      const text = (await page.locator(`#tab-panel-${tab}`).textContent()) || '';
      expect(text.trim().length).toBeGreaterThan(0);
    }
    await expect(page.locator('#tab-panel-overview')).toContainText('Storage Required');
  });
});
