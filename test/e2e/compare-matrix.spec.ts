import { test, expect, runAxeScan, BASE } from '../fixtures';

/**
 * Multi-Game Comparison Matrix & Target Device Specs.
 *
 * Test 1: The multi-game comparison surface renders the target-device selector,
 *         the game multi-select dropdown, and the run-compare action.
 * Test 2: Selecting a target device maps GPU/CPU/RAM/VRAM/Target FPS specs into
 *         the comparison header specs strip (#compare-target-device-specs).
 * Test 3: Selecting 2 games renders the side-by-side comparison matrix.
 * Test 4: Zero accessibility violations across the page.
 */

test.describe('Multi-Game Comparison Matrix & Target Device Specs', () => {
  test.beforeEach(async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.waitForSelector('#page-compare');
    // Wait for the catalog + device select to populate.
    await page.waitForFunction(() => {
      const deviceSelect = document.getElementById('compare-device-select') as HTMLSelectElement | null;
      return !!deviceSelect && deviceSelect.options.length > 1;
    }, { timeout: 15000 });
  });

  async function selectTwoCompareGames(page: any) {
    await page.locator('#compare-select-trigger').click();
    const boxes = page.locator('#compare-games-list .compare-game-checkbox');
    await expect(boxes.first()).toBeVisible({ timeout: 15000 });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    // Close the dropdown so it never overlaps the rendered matrix.
    await page.locator('#compare-select-trigger').click();
  }

  test('1. Compare page renders target device selector and game multi-select', async ({ page }: { page: any }) => {
    await expect(page.locator('#compare-device-select')).toBeVisible();
    await expect(page.locator('#compare-select-trigger')).toBeVisible();
    await expect(page.locator('#btn-run-compare')).toBeVisible();
    // The removed Hardware Fleet Benchmark section is gone.
    await expect(page.locator('#compare-matrix-table')).toHaveCount(0);
  });

  test('2. Selecting a target device renders GPU/CPU/RAM/VRAM/Target FPS specs', async ({ page }: { page: any }) => {
    const deviceSelect = page.locator('#compare-device-select');
    const firstValue = await deviceSelect.locator('option').nth(1).getAttribute('value');
    expect(firstValue).toBeTruthy();
    await deviceSelect.selectOption(firstValue as string);

    const specsStrip = page.locator('#compare-target-device-specs');
    await expect(specsStrip).toBeVisible({ timeout: 15000 });
    const text = await specsStrip.textContent() || '';
    expect(text).toMatch(/GPU/i);
    expect(text).toMatch(/CPU/i);
    expect(text).toMatch(/RAM/i);
    expect(text).toMatch(/VRAM/i);
    expect(text).toMatch(/Target FPS/i);
  });

  test('3. Selecting two games renders the side-by-side comparison matrix', async ({ page }: { page: any }) => {
    await selectTwoCompareGames(page);
    const body = page.locator('#matrix-body');
    await expect(body).toBeVisible({ timeout: 20000 });
    const headerThCount = await page.locator('#matrix-header-row th').count();
    expect(headerThCount).toBeGreaterThan(1);
    await expect(page.locator('#matrix-body tr[data-compare-cluster="performance"]').first()).toBeVisible({ timeout: 20000 });
  });

  test('4. Zero accessibility violations across the compare page', async ({ page }: { page: any }) => {
    const results = await runAxeScan(page);
    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);
  });
});
