import { test, expect } from '@playwright/test';

/**
 * EPIC-FLEET-0001 — Hardware Fleet Dashboard & Interactive Compatibility UI E2E Spec.
 *
 * Verifies interactive browser UI flows (VCM v5.0.6 Chapters 10, 22, 23):
 * 1. Add Device modal creates a device profile and renders a horizontal
 *    fleet row on the Fleet Dashboard.
 * 2. Explicit-action "Analyze Compatibility" trigger inside the game detail
 *    drawer renders an "Optimal" multi-axis breakdown for a well-specced
 *    desktop device against the seeded "Elden Ring" (G00001) requirements
 *    (Min RAM 12GB, Min VRAM 6GB, Storage 60GB).
 * 3. Explicit-action analysis against a device with missing hardware specs
 *    renders the graceful "Incomplete Specs" warning banner instead of a
 *    guessed rating.
 * 4. Deleting a device removes its fleet row and its option from the
 *    drawer's compatibility device selector dropdown.
 */

const BASE = 'http://localhost:4000';

const USER = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

const SEEDED_GAME_ID = 'G00001';
const SEEDED_GAME_TITLE = 'Elden Ring';

test.describe('EPIC-FLEET-0001 — Fleet Dashboard & Interactive Compatibility UI', () => {
  test.beforeEach(async ({ page }) => {
    // Log in via API to set the auth cookie for the browser context.
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data: USER });
    expect(loginRes.status()).toBe(200);
  });

  test('1. Opens Add Device Modal, fills form, submits, and renders a horizontal fleet row', async ({ page }) => {
    await page.goto(`${BASE}/#/fleet`);
    await page.waitForLoadState('networkidle');

    // Click Add Device button.
    const addBtn = page.locator('#btn-add-device');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Verify modal visible.
    const modal = page.locator('#fleet-add-modal');
    await expect(modal).toBeVisible();

    // Fill device form fields using confirmed-correct option values.
    const timestamp = Date.now();
    const deviceName = `E2E Test Rig ${timestamp}`;

    await page.fill('#fleet-device-name', deviceName);
    await page.selectOption('#fleet-device-type', 'desktop');
    await page.fill('#fleet-device-cpu', 'AMD Ryzen 7 7800X3D');
    await page.fill('#fleet-device-cores', '8');
    await page.fill('#fleet-device-ram', '32');
    await page.fill('#fleet-device-gpu', 'NVIDIA GeForce RTX 4080');
    await page.fill('#fleet-device-vram', '16');
    await page.selectOption('#fleet-device-gputype', 'dedicated');
    await page.selectOption('#fleet-device-storagetype', 'NVMe SSD');
    await page.fill('#fleet-device-storagefree', '1024');

    // Submit form via the explicit Save button.
    await page.click('#btn-fleet-modal-save');

    // Verify modal hidden after successful save.
    await expect(modal).toBeHidden();

    // Verify a horizontal fleet data row renders with the new device's name.
    const deviceRow = page.locator('#fleet-devices-container [data-testid="fleet-device-row"]', {
      hasText: deviceName,
    });
    await expect(deviceRow).toBeVisible({ timeout: 5000 });
  });

  test('2. Analyze Compatibility on a fully-specced desktop yields an Optimal multi-axis rating', async ({ page }) => {
    // Create a generously-specced desktop device via the API — comfortably
    // exceeds Elden Ring's seeded requirements (RAM 12GB, VRAM 6GB, Storage
    // 60GB) so evaluateCompatibility() deterministically returns "Optimal"
    // (RAM margin >= 4GB, VRAM margin >= 2GB, Storage margin >= 20GB, CPU >= 8 cores).
    const createRes = await page.request.post(`${BASE}/api/devices`, {
      data: {
        deviceName: `Optimal Rig ${Date.now()}`,
        deviceType: 'desktop',
        cpuModel: 'AMD Ryzen 9 7950X3D',
        cpuCores: 16,
        ramGb: 32,
        gpuModel: 'NVIDIA GeForce RTX 4090',
        vramGb: 24,
        gpuType: 'dedicated',
        storageType: 'NVMe SSD',
        storageFreeGb: 1000,
        isPortable: false,
      },
    });
    expect(createRes.status()).toBe(201);
    const device = (await createRes.json()).device;
    expect(device.id).toBeDefined();

    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');

    // Open the game detail drawer for the seeded game via the exposed hook.
    await page.evaluate(
      ([title, id]) => (window as any).openGameDetailDrawer(title, id),
      [SEEDED_GAME_TITLE, SEEDED_GAME_ID]
    );

    const drawer = page.locator('#game-detail-drawer');
    await expect(drawer).toBeVisible();

    // Explicit-action controls must be present (Chapter 23.1).
    const deviceSelect = page.locator('#drawer-compat-device');
    const analyzeBtn = page.locator('#drawer-compat-analyze');
    await expect(deviceSelect).toBeVisible();
    await expect(analyzeBtn).toBeVisible();

    // Wait for the async device list fetch to populate our new device's option.
    await page.waitForFunction(
      (deviceId) => {
        const sel = document.getElementById('drawer-compat-device') as HTMLSelectElement | null;
        if (!sel) return false;
        return Array.from(sel.options).some((o) => o.value === deviceId);
      },
      device.id,
      { timeout: 15000 }
    );

    await page.selectOption('#drawer-compat-device', device.id);

    // Trigger the explicit-action compatibility analysis.
    await analyzeBtn.click();

    // Verify the "Optimal" rating and multi-axis breakdown render.
    const resultRoot = page.locator('#drawer-compat-result');
    await expect(resultRoot.locator('[data-testid="compat-result"]')).toBeVisible({ timeout: 15000 });
    await expect(resultRoot.locator('[data-testid="compat-rating"]')).toHaveText('Optimal');
    const axes = resultRoot.locator('[data-testid="compat-axes"]');
    await expect(axes).toBeVisible();
    await expect(axes).toContainText('CPU');
    await expect(axes).toContainText('RAM');
    await expect(axes).toContainText('VRAM');
    await expect(axes).toContainText('Storage');

    // Cleanup.
    await page.request.delete(`${BASE}/api/devices/${device.id}`);
  });

  test('3. Analyze Compatibility on a device with missing specs shows the Incomplete Specs warning banner', async ({ page }) => {
    // Create a device with only the required minimum fields — no cpuModel,
    // ramGb, gpuModel, vramGb, or storageFreeGb — so evaluateCompatibility()
    // deterministically returns the "Incomplete Specs" graceful-failure path.
    const createRes = await page.request.post(`${BASE}/api/devices`, {
      data: {
        deviceName: `Bare Profile ${Date.now()}`,
        deviceType: 'desktop',
      },
    });
    expect(createRes.status()).toBe(201);
    const device = (await createRes.json()).device;
    expect(device.id).toBeDefined();

    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');

    await page.evaluate(
      ([title, id]) => (window as any).openGameDetailDrawer(title, id),
      [SEEDED_GAME_TITLE, SEEDED_GAME_ID]
    );

    const drawer = page.locator('#game-detail-drawer');
    await expect(drawer).toBeVisible();

    await page.waitForFunction(
      (deviceId) => {
        const sel = document.getElementById('drawer-compat-device') as HTMLSelectElement | null;
        if (!sel) return false;
        return Array.from(sel.options).some((o) => o.value === deviceId);
      },
      device.id,
      { timeout: 15000 }
    );

    await page.selectOption('#drawer-compat-device', device.id);
    await page.click('#drawer-compat-analyze');

    const banner = page.locator('#drawer-compat-result [data-testid="incomplete-specs-banner"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText('Incomplete Specs');

    // Cleanup.
    await page.request.delete(`${BASE}/api/devices/${device.id}`);
  });

  test('4. Deleting a device removes its fleet row and its option from the drawer device selector', async ({ page }) => {
    const createRes = await page.request.post(`${BASE}/api/devices`, {
      data: {
        deviceName: `Deletable Rig ${Date.now()}`,
        deviceType: 'laptop',
        cpuModel: 'Intel Core i7-13700H',
        cpuCores: 14,
        ramGb: 16,
        gpuModel: 'NVIDIA GeForce RTX 4060 Laptop',
        vramGb: 8,
        gpuType: 'dedicated',
        storageType: 'NVMe SSD',
        storageFreeGb: 200,
        isPortable: true,
      },
    });
    expect(createRes.status()).toBe(201);
    const device = (await createRes.json()).device;
    expect(device.id).toBeDefined();

    await page.goto(`${BASE}/#/fleet`);
    await page.waitForLoadState('networkidle');

    const deviceRow = page.locator(`[data-testid="fleet-device-row"][data-device-id="${device.id}"]`);
    await expect(deviceRow).toBeVisible({ timeout: 10000 });

    // Deleting a device triggers a native confirm() dialog — accept it.
    page.once('dialog', (dialog) => dialog.accept());
    await deviceRow.locator('[data-testid="btn-delete-device"]').click();

    // The row must disappear from the Fleet Dashboard.
    await expect(deviceRow).toHaveCount(0, { timeout: 10000 });

    // Open a game drawer and verify the deleted device's option no longer
    // exists in the compatibility device selector dropdown.
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');
    await page.evaluate(
      ([title, id]) => (window as any).openGameDetailDrawer(title, id),
      [SEEDED_GAME_TITLE, SEEDED_GAME_ID]
    );

    const drawer = page.locator('#game-detail-drawer');
    await expect(drawer).toBeVisible();

    // Wait for the (re-fetched) device select to finish loading, then assert
    // the deleted device's id is absent from the option list.
    await page.waitForFunction(() => {
      const sel = document.getElementById('drawer-compat-device') as HTMLSelectElement | null;
      if (!sel) return false;
      return sel.options.length > 0 && sel.options[0].textContent !== 'Loading devices...';
    }, { timeout: 15000 });

    const deletedOption = page.locator(`#drawer-compat-device option[value="${device.id}"]`);
    await expect(deletedOption).toHaveCount(0);
  });
});
