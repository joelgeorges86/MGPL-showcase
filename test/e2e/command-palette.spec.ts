import { test, expect } from '@playwright/test';

test.describe('Global Keyboard Command Palette & Quick Action Engine (FEAT-0150)', () => {

  test.beforeEach(async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/home');
    await page.waitForSelector('#page-home');
  });

  test('1. Opens via Ctrl+K / Meta+K and focuses the search input', async ({ page }: { page: any }) => {
    const palette = page.locator('#command-palette');
    await expect(palette).toBeHidden();

    // Toggle open with Control+K.
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await expect(page.locator('#command-palette-input')).toBeFocused();

    // Toggle closed with the same shortcut.
    await page.keyboard.press('Control+k');
    await expect(palette).toBeHidden();

    // Reopen with Meta+K (Cmd+K on macOS).
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await expect(page.locator('#command-palette-input')).toBeFocused();
  });

  test('2. Navigation command routes to the target page', async ({ page }: { page: any }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#command-palette')).toBeVisible();

    // Type a navigation command and select it with Enter.
    await page.locator('#command-palette-input').fill('deals hub');
    await page.keyboard.press('Enter');

    // Palette closes and the Deals Hub route becomes active.
    await expect(page.locator('#command-palette')).toBeHidden();
    await expect(page).toHaveURL(/#\/deals/);
    await expect(page.locator('#page-deals')).toBeVisible();
  });

  test('3. Live game search opens the game detail drawer on Enter', async ({ page }: { page: any }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#command-palette')).toBeVisible();

    // Type a game title; the debounced fuzzy search hits /api/games?search=.
    await page.locator('#command-palette-input').fill('Skyrim');

    // Wait for a game result option to appear in the listbox.
    const gameOption = page.locator('#command-palette-results [role="option"]', { hasText: 'Skyrim' });
    await expect(gameOption.first()).toBeVisible({ timeout: 10000 });

    // Select the highlighted game with Enter.
    await page.keyboard.press('Enter');

    // The game detail drawer opens with the matching title.
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await expect(page.locator('#game-detail-title')).toContainText('Skyrim');
  });

  test('4. Closes via Escape key and backdrop click', async ({ page }: { page: any }) => {
    // Close via Escape.
    await page.keyboard.press('Control+k');
    await expect(page.locator('#command-palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#command-palette')).toBeHidden();

    // Close via backdrop click.
    await page.keyboard.press('Control+k');
    await expect(page.locator('#command-palette')).toBeVisible();
    await page.locator('#command-palette-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#command-palette')).toBeHidden();
  });

  test('5. No accessibility violations on palette dialog elements', async ({ page }: { page: any }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#command-palette')).toBeVisible();

    // Dialog semantics.
    const dialog = page.locator('#command-palette');
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-label', 'Command Palette');
    await expect(dialog).toHaveAttribute('aria-hidden', 'false');

    // Combobox semantics on the search input.
    const input = page.locator('#command-palette-input');
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-controls', 'command-palette-results');

    // Listbox semantics on the results container.
    const results = page.locator('#command-palette-results');
    await expect(results).toHaveAttribute('role', 'listbox');
    await expect(results).toHaveAttribute('aria-label', 'Command palette results');

    // Default command options are exposed as listbox options.
    const options = page.locator('#command-palette-results [role="option"]');
    await expect(options.first()).toBeVisible();
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    // The active descendant points at the first option.
    const activeId = await input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    await expect(page.locator('#' + activeId)).toHaveAttribute('role', 'option');
  });
});
