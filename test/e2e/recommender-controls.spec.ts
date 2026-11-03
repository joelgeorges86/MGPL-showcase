import { test, expect, Page } from '@playwright/test';

/**
 * Recommender Controls Contract (FEAT — recommender markup repair).
 *
 * The recommender controls in public/index.html must match the app.js binding
 * contract exactly:
 *   - Time container  -> #recommender-time-btns  (buttons .rec-time-btn, data-val)
 *   - Energy container-> #recommender-energy-btns (buttons .rec-energy-btn, data-val)
 *   - Installed-only  -> #rec-installed-only (checkbox)
 *   - Trigger         -> #btn-find-recommendation
 *   - Results         -> #recommendations-container
 *
 * The "<30m" value must be HTML-entity-escaped (<30m) in the attribute and
 * text so the browser parses valid HTML while decoding back to "<30m" for the
 * backend recommender route.
 */

const BASE_URL = 'http://localhost:4000';

/**
 * Navigate to the recommender route reliably. Loading the URL with a hash
 * directly can race the initial router dispatch, so we load the base URL and
 * then set the hash to trigger the hashchange -> handleRoute() path, which is
 * deterministic.
 */
async function gotoRecommender(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    window.location.hash = '#/recommender';
  });
  await page.waitForSelector('#page-recommender');
  await expect(page.locator('#page-recommender')).toBeVisible();
}

test.describe('Recommender Controls Contract', () => {

  test('1. Time and energy buttons render with the app.js binding contract', async ({ page }) => {
    await gotoRecommender(page);

    // Time buttons container + buttons with data-val attributes.
    const timeBtns = page.locator('#recommender-time-btns');
    await expect(timeBtns).toBeVisible();
    await expect(timeBtns.locator('.rec-time-btn')).toHaveCount(3);

    // The "<30m" button must render decoded text "<30m" (entity was escaped in source).
    const lt30 = timeBtns.locator('.rec-time-btn[data-val="<30m"]');
    await expect(lt30).toHaveCount(1);
    await expect(lt30).toHaveText('<30m');

    // Energy buttons container + buttons with data-val attributes.
    const energyBtns = page.locator('#recommender-energy-btns');
    await expect(energyBtns).toBeVisible();
    await expect(energyBtns.locator('.rec-energy-btn')).toHaveCount(3);
    await expect(energyBtns.locator('.rec-energy-btn[data-val="low"]')).toHaveCount(1);
    await expect(energyBtns.locator('.rec-energy-btn[data-val="medium"]')).toHaveCount(1);
    await expect(energyBtns.locator('.rec-energy-btn[data-val="high"]')).toHaveCount(1);
  });

  test('2. Selecting a time button toggles its active state', async ({ page }) => {
    await gotoRecommender(page);

    const timeBtns = page.locator('#recommender-time-btns');
    const btn = timeBtns.locator('.rec-time-btn[data-val="30-90m"]');
    await btn.click();

    // The selected button receives the active brand styling (bg-brand-600).
    await expect(btn).toHaveClass(/bg-brand-600/);
    // The previously-default "<30m" button loses its active styling.
    const lt30 = timeBtns.locator('.rec-time-btn[data-val="<30m"]');
    await expect(lt30).not.toHaveClass(/bg-brand-600/);
  });

  test('3. Selecting an energy button toggles its active state', async ({ page }) => {
    await gotoRecommender(page);

    const energyBtns = page.locator('#recommender-energy-btns');
    const btn = energyBtns.locator('.rec-energy-btn[data-val="high"]');
    await btn.click();

    await expect(btn).toHaveClass(/bg-brand-600/);
    const medium = energyBtns.locator('.rec-energy-btn[data-val="medium"]');
    await expect(medium).not.toHaveClass(/bg-brand-600/);
  });

  test('4. "Find Recommendation" fires a POST to /api/recommender/suggest', async ({ page }) => {
    await gotoRecommender(page);

    // Intercept the recommender POST and capture the payload.
    let capturedPayload: any = null;
    await page.route('**/api/recommender/suggest', async (route) => {
      capturedPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, recommendations: [] }),
      });
    });

    // Select a time and energy value, then trigger the recommendation.
    await page.locator('#recommender-time-btns .rec-time-btn[data-val="30-90m"]').click();
    await page.locator('#recommender-energy-btns .rec-energy-btn[data-val="high"]').click();
    await page.locator('#btn-find-recommendation').click();

    // The POST payload must carry the selected values.
    await expect.poll(() => capturedPayload).toBeTruthy();
    expect(capturedPayload.timeAvailable).toBe('30-90m');
    expect(capturedPayload.energyLevel).toBe('high');
    expect(typeof capturedPayload.installedOnly).toBe('boolean');
    expect(capturedPayload.deviceId).toBeTruthy();

    // The results container shows the empty-state message for no matches.
    const recs = page.locator('#recommendations-container');
    await expect(recs).toContainText('No games match these exact session constraints.');
  });
});
