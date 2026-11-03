import { test, expect, Page } from '@playwright/test';

/**
 * Sprint 2 (EPIC-DEV-001) — Custom PC Builder E2E Spec.
 *
 * 1. Selecting parts across categories updates real-time total price and
 *    estimated wattage.
 * 2. Incompatible parts (AM5 CPU + AM4 Motherboard) trigger a visible red
 *    compatibility warning banner.
 * 3. An authenticated user can save a named build and reload it.
 * 4. Accessing a shared build URL renders the read-only build snapshot.
 *
 * The builder component catalog + compatibility rules are seeded idempotently
 * by src/db.ts via src/seed/components.ts, so every spec can assert against
 * known stable component IDs (AM5 / AM4 CPUs, DDR4/DDR5 motherboards).
 */

const BASE = 'http://localhost:4000';
const USER = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

// Stable seed component IDs matching src/seed/components.ts.
const COMPATIBLE_CPU = 'cpu-r7-7800x3d';        // AM5, DDR5
const COMPATIBLE_MOTHERBOARD = 'mb-msi-b650-tomahawk'; // AM5, DDR5, ATX
const INCOMPATIBLE_MOTHERBOARD = 'mb-msi-b550-gaming'; // AM4, DDR4, ATX
const RAM = 'ram-32gb-ddr5';                    // DDR5
const GPU = 'gpu-rtx-4070-super';              // 220W
const PSU = 'psu-corsair-rm850x';              // 850W, ATX
const CASE = 'case-corsair-4000d';             // ATX
const STORAGE = 'storage-2tb-nvme';

async function selectPart(page: Page, category: string, componentId: string) {
  await page.click(`[data-builder-pick="${category}"]`);
  const option = page.locator(
    `#builder-picker-modal [data-component-id="${componentId}"]`,
  );
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
  await expect(page.locator('#builder-picker-modal')).toBeHidden({ timeout: 5000 });
}

test.describe('EPIC-DEV-001 — Custom PC Builder', () => {
  test('1. Selecting parts across categories updates real-time total price and estimated wattage', async ({ page }) => {
    await page.goto(`${BASE}/#/devices`);
    await page.waitForLoadState('networkidle');
    await page.click('[data-devices-tab="builder"]');

    const totalEl = page.locator('[data-testid="builder-total-price"]');
    const wattEl = page.locator('[data-testid="builder-estimated-wattage"]');
    await expect(totalEl).toHaveText('$0.00', { timeout: 10000 });

    // Pick a CPU, motherboard, RAM, GPU, PSU, case, storage into the builder.
    await selectPart(page, 'CPU', COMPATIBLE_CPU);
    await selectPart(page, 'Motherboard', COMPATIBLE_MOTHERBOARD);
    await selectPart(page, 'RAM', RAM);
    await selectPart(page, 'GPU', GPU);
    await selectPart(page, 'PSU', PSU);
    await selectPart(page, 'Case', CASE);
    await selectPart(page, 'Storage', STORAGE);

    // The total price must be a non-zero dollar amount.
    await expect(totalEl).not.toHaveText('$0.00', { timeout: 10000 });
    const priceText = await totalEl.textContent();
    expect(priceText).toMatch(/^\$\d/);

    // Est. wattage is Total TDP + 20% overhead, so it must be > 0.
    await expect(wattEl).not.toHaveText('0 W', { timeout: 10000 });
    const wattText = await wattEl.textContent();
    const watts = parseInt(wattText || '0', 10);
    expect(watts).toBeGreaterThan(0);

    // A green compatible banner must appear.
    await expect(page.locator('[data-testid="builder-compat-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="builder-compat-banner"]')).toContainText('Compatible');
  });

  test('2. Incompatible parts (AM5 CPU + AM4 Motherboard) trigger a visible red compatibility warning banner', async ({ page }) => {
    await page.goto(`${BASE}/#/devices`);
    await page.waitForLoadState('networkidle');
    await page.click('[data-devices-tab="builder"]');

    // AM5 CPU + AM4 motherboard triggers the socket-mismatch rule.
    await selectPart(page, 'CPU', COMPATIBLE_CPU);
    await selectPart(page, 'Motherboard', INCOMPATIBLE_MOTHERBOARD);
    await selectPart(page, 'RAM', RAM);
    await selectPart(page, 'GPU', GPU);
    await selectPart(page, 'PSU', PSU);
    await selectPart(page, 'Case', CASE);

    const banner = page.locator('[data-testid="builder-incompat-banner"]');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText('Issues');
  });

  test('3. Authenticated user can save a named build and reload it', async ({ page }) => {
    // Log in so POST /api/builder/builds is authorized.
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data: USER });
    expect(loginRes.status()).toBe(200);

    await page.goto(`${BASE}/#/devices`);
    await page.waitForLoadState('networkidle');
    await page.click('[data-devices-tab="builder"]');

    await selectPart(page, 'CPU', COMPATIBLE_CPU);
    await selectPart(page, 'Motherboard', COMPATIBLE_MOTHERBOARD);
    await selectPart(page, 'RAM', RAM);

    const buildName = `Test Build ${Date.now()}`;
    await page.click('#builder-save-btn');
    await expect(page.locator('#builder-save-modal')).toBeVisible({ timeout: 5000 });
    await page.fill('#builder-save-name', buildName);
    await page.click('#builder-save-confirm');

    // Saved build share slug indicator appears.
    await expect(page.locator('#builder-saved-slug')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#builder-saved-slug')).toContainText('#/devices/builder/share/');

    // Open "My Builds" and confirm the saved build is listed.
    await page.click('#builder-my-builds-btn');
    await expect(page.locator('#builder-my-builds')).toContainText(buildName, { timeout: 10000 });

    // Reload the page and verify the build persists in the list.
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('[data-devices-tab="builder"]');
    await page.click('#builder-my-builds-btn');
    await expect(page.locator('#builder-my-builds')).toContainText(buildName, { timeout: 10000 });
  });

  test('4. Accessing a shared build URL renders the read-only build snapshot', async ({ page }) => {
    // Create a shared build via the API as an authenticated user.
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data: USER });
    expect(loginRes.status()).toBe(200);

    const buildRes = await page.request.post(`${BASE}/api/builder/builds`, {
      data: {
        buildName: `Shared Build ${Date.now()}`,
        componentIds: [COMPATIBLE_CPU, COMPATIBLE_MOTHERBOARD, RAM, GPU, PSU, CASE],
      },
    });
    expect(buildRes.status()).toBe(201);
    const build = (await buildRes.json()).build;
    const slug = build.shareSlug;

    // Open the shared URL and verify the read-only snapshot renders.
    await page.goto(`${BASE}/#/devices/builder/share/${slug}`);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#page-devices')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#builder-component-rows')).toContainText('Ryzen 7 7800X3D');
    await expect(page.locator('#builder-component-rows')).toContainText('MAG B650 Tomahawk');

    // Read-only banner + a non-zero total price.
    await expect(page.locator('#builder-compat-banner')).toContainText('read-only');
    const totalEl = page.locator('[data-testid="builder-total-price"]');
    await expect(totalEl).not.toHaveText('$0.00');
  });
});