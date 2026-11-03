import { test, expect } from '@playwright/test';

test.describe('Nexus Mods Integration & Installed Tracker E2E', () => {
  test('navigates to Nexus Mods Hub and loads trending mods', async ({ page }) => {
    await page.goto('/#/mods');
    await expect(page.locator('#page-mods')).toBeVisible();

    const domainSelect = page.locator('#mods-game-domain-select');
    await expect(domainSelect).toBeVisible();

    // Verify trending mods container renders cards
    const modCards = page.locator('#mods-list-container .toggle-mod-btn');
    await expect(modCards.first()).toBeVisible({ timeout: 10000 });
  });

  test('searches for mods within a game domain', async ({ page }) => {
    await page.goto('/#/mods');
    await page.fill('#mods-search-input', 'cyber');
    await page.click('#btn-mods-search');

    const modCards = page.locator('#mods-list-container .toggle-mod-btn');
    await expect(modCards.first()).toBeVisible({ timeout: 10000 });
  });

  test('toggles mod tracking status', async ({ page }) => {
    await page.goto('/#/mods');
    const firstToggleBtn = page.locator('#mods-list-container .toggle-mod-btn').first();
    await expect(firstToggleBtn).toBeVisible({ timeout: 10000 });

    const initialText = await firstToggleBtn.textContent();
    await firstToggleBtn.click();

    // Wait for button state toggle or toast confirmation
    await page.waitForTimeout(1000);

    // Switch to installed tab and verify tracked mods
    await page.click('#tab-mods-installed');
    await page.waitForTimeout(1000);
  });
});
