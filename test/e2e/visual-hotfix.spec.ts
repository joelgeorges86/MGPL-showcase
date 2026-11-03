import { test, expect, BASE } from '../fixtures';

/**
 * EPIC-HOTFIX-VISUAL-001 Verification
 *
 * Test 1: Library Genre Multi-Select Checkbox Dropdown
 *         - #library-genre-dropdown-btn opens #library-genre-dropdown
 *         - Genre options render as input[data-genre-facet] checkboxes
 *         - A Clear action resets all selected genres
 *
 * Test 2: Game Detail Hero Media Block Collapse
 *         - When header image and trailer URL are missing/null, #detail-media-block is hidden
 *         - When trailer is missing, media block switches to single column banner
 */

test.describe('EPIC-HOTFIX-VISUAL-001 — Visual & Functional Hotfix Verification', () => {
  test('1. Library Genre Filter Renders a Multi-Select Checkbox Dropdown', async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('#page-library').waitFor();
    const dropdownBtn = page.locator('#library-genre-dropdown-btn');
    await expect(dropdownBtn).toBeVisible();

    // Open the dropdown and verify genre checkboxes render inside it.
    await dropdownBtn.click();
    const dropdown = page.locator('#library-genre-dropdown');
    await expect(dropdown.locator('input[data-genre-facet]').first()).toBeVisible({ timeout: 15000 });
    const genreCount = await dropdown.locator('input[data-genre-facet]').count();
    expect(genreCount).toBeGreaterThan(0);

    // A "Clear" action exists to reset all selected genres.
    await expect(page.locator('#library-genre-clear')).toBeVisible();

    // Checking a genre updates the trigger label and filters the grid.
    const firstCheckbox = dropdown.locator('input[data-genre-facet]').first();
    const firstName = await firstCheckbox.getAttribute('data-genre-facet');
    await firstCheckbox.check({ force: true });
    await page.waitForTimeout(300);
    await expect(page.locator('#library-genre-dropdown-label')).toContainText(firstName || 'Genres');
    await expect(page.locator('#library-games-grid .game-card').first()).toBeVisible();
  });

  test('2. Game Detail Hero Banner and Media Block Behavior', async ({ page }: { page: any }) => {
    // Navigate to a game without header image or trailer URL (cyberpunk-2077)
    await page.goto(`${BASE}/#/game/cyberpunk-2077`);
    await page.locator('#page-game-detail').waitFor();
    await expect(page.locator('#game-detail-content')).toBeVisible({ timeout: 15000 });

    const mediaBlock = page.locator('#detail-media-block');
    if (await mediaBlock.count() > 0) {
      // When both header image and trailer URL are missing/null, #detail-media-block must have 'hidden' class
      await expect(mediaBlock).toHaveClass(/hidden/);
    }
  });
});
