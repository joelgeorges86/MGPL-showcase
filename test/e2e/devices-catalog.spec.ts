import { test, expect } from '@playwright/test';

/**
 * Sprint 1 (EPIC-DEV-001) — Navigation Promotion, Polished Fleet &
 * 50+ Hardware Catalog E2E Spec.
 *
 * 1. The top-level "Devices" nav link is visible and loads the Devices overview.
 * 2. The Prebuilt catalog filters correctly by brand and device type.
 * 3. Side-by-side comparison renders matching specs with the superior value
 *    highlighted via [data-testid="superior-cell"].
 * 4. My Devices displays owned hardware and supports setting an active/primary
 *    device (persists via PATCH /api/devices/:id/primary).
 *
 * The catalog is seeded idempotently by src/db.ts initDb() via
 * src/seed/devices.ts (54 profiles), so every spec can assert against known
 * brands (Sony, Nintendo, ASUS, Dell Alienware, CyberPowerPC) and device types
 * (Console, Handheld, PC) regardless of seed order.
 */

const BASE = 'http://localhost:4000';
const USER = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

test.describe('EPIC-DEV-001 — Devices Hub, Hardware Catalog & Comparison', () => {
  test('1. Devices tab is visible in top nav and loads the devices overview page', async ({ page }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForLoadState('networkidle');

    // The top-level nav link must be visible.
    const navLink = page.locator('nav a[data-route="devices"]');
    await expect(navLink).toBeVisible();
    await expect(navLink).toContainText('Devices');

    // Navigate via the link to the Devices route.
    await navLink.click();
    await page.waitForFunction(() => document.getElementById('page-devices') !== null);
    await expect(page.locator('#page-devices')).toBeVisible();

    // The Overview panel is the default sub-tab and shows catalog counts.
    const overviewPanel = page.locator('#devices-panel-overview');
    await expect(overviewPanel).toBeVisible();
    const totalEl = page.locator('#devices-overview-total');
    await expect(totalEl).toHaveText(/\d+/, { timeout: 10000 });
    const total = Number((await totalEl.textContent()) || '0');
    expect(total).toBeGreaterThanOrEqual(50);

    // The six sub-tab buttons exist.
    const tabs = ['overview', 'my-devices', 'prebuilts', 'builder', 'performance', 'reviews'];
    for (const tab of tabs) {
      await expect(page.locator(`[data-devices-tab="${tab}"]`)).toBeVisible();
    }
  });

  test('2. Prebuilt catalog filters correctly by brand and device type', async ({ page }) => {
    await page.goto(`${BASE}/#/devices`);
    await page.waitForLoadState('networkidle');

    // Switch to the Prebuilts & Consoles sub-tab.
    await page.click('[data-devices-tab="prebuilts"]');
    const grid = page.locator('#catalog-devices-grid');
    await expect(grid).toBeVisible();

    // Wait for the catalog grid to hydrate (device cards present).
    await expect(page.locator('[data-testid="catalog-card"]').first()).toBeVisible({ timeout: 15000 });

    // Filter by Brand = "Sony". Every visible card must be a Sony device.
    await page.selectOption('#catalog-filter-brand', 'Sony');
    await page.click('#catalog-filter-apply');
    await expect(page.locator('[data-testid="catalog-card"]').first()).toBeVisible({ timeout: 15000 });
    const sonyCards = page.locator('[data-testid="catalog-card"]');
    const sonyCount = await sonyCards.count();
    expect(sonyCount).toBeGreaterThan(0);
    for (let i = 0; i < sonyCount; i++) {
      await expect(sonyCards.nth(i)).toContainText('Sony');
    }

    // Add Device Type = "Console" alongside the brand filter.
    await page.selectOption('#catalog-filter-type', 'Console');
    await page.click('#catalog-filter-apply');
    await expect(page.locator('[data-testid="catalog-card"]').first()).toBeVisible({ timeout: 15000 });
    const consoleCards = page.locator('[data-testid="catalog-card"]');
    const consoleCount = await consoleCards.count();
    expect(consoleCount).toBeGreaterThan(0);
    for (let i = 0; i < consoleCount; i++) {
      await expect(consoleCards.nth(i)).toContainText('Sony');
      await expect(consoleCards.nth(i)).toContainText('Console');
    }

    // Reset returns to the full catalog.
    await page.click('#catalog-filter-reset');
    await expect(page.locator('[data-testid="catalog-card"]').first()).toBeVisible({ timeout: 15000 });
    const allCards = page.locator('[data-testid="catalog-card"]');
    const allCount = await allCards.count();
    expect(allCount).toBeGreaterThan(0);
  });

  test('3. Side-by-side device comparison renders matching specs with superior values highlighted', async ({ page }) => {
    await page.goto(`${BASE}/#/devices`);
    await page.waitForLoadState('networkidle');
    await page.click('[data-devices-tab="prebuilts"]');

    // Wait for cards to hydrate.
    const cards = page.locator('[data-testid="catalog-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });

    // Filter by Device Type = "Console". The console subset is exactly five
    // devices (PS5 / PS5 Slim / PS5 Pro / Xbox Series X / Xbox Series S), so it
    // fits on a single catalog page and the two comparison targets are always
    // co-visible regardless of alphabetical or price ordering.
    await page.selectOption('#catalog-filter-type', 'Console');
    await page.click('#catalog-filter-apply');
    await expect(page.locator('[data-testid="catalog-card"]').first()).toBeVisible({ timeout: 15000 });

    // Select PS5 Pro (RDNA 3, 16 GB VRAM, enthusiast tier) vs Xbox Series S
    // (RDNA 2, 8 GB VRAM, mid tier). The clear spec gap guarantees the
    // comparison highlights superior cells on the PS5 Pro side.
    const ps5ProCard = page.locator('[data-testid="catalog-card"][data-device-id="ps5-pro"]');
    const seriesSCard = page.locator('[data-testid="catalog-card"][data-device-id="xbox-series-s"]');
    await expect(ps5ProCard).toBeVisible({ timeout: 15000 });
    await expect(seriesSCard).toBeVisible({ timeout: 15000 });

    const ps5ProCb = ps5ProCard.locator('[data-testid="catalog-compare-checkbox"]');
    const seriesSCb = seriesSCard.locator('[data-testid="catalog-compare-checkbox"]');
    await ps5ProCb.click({ force: true });
    await seriesSCb.click({ force: true });
    expect(await ps5ProCb.isChecked()).toBe(true);
    expect(await seriesSCb.isChecked()).toBe(true);

    // Compare bar must enable the button once two devices are selected.
    const compareBtn = page.locator('#catalog-compare-btn');
    await expect(compareBtn).toBeEnabled({ timeout: 5000 });
    await compareBtn.click();

    // Comparison table renders with matching spec labels and highlighted cells.
    const table = page.locator('[data-testid="device-compare-table"]');
    await expect(table).toBeVisible({ timeout: 15000 });
    await expect(table).toContainText('PlayStation 5 Pro');
    await expect(table).toContainText('Xbox Series S');
    await expect(table).toContainText('GPU');
    await expect(table).toContainText('VRAM');
    await expect(table).toContainText('RAM');

    // Superior cells must exist (PS5 Pro beats Series S on VRAM/GPU tier).
    const superiorCells = table.locator('[data-testid="superior-cell"]');
    const superiorCount = await superiorCells.count();
    expect(superiorCount).toBeGreaterThan(0);

    // The superior VRAM cell must show the higher value (16 GB on the PS5 Pro).
    const vramTexts = await table.locator('tr', { hasText: 'VRAM' }).textContent();
    expect(vramTexts).toContain('16 GB');
  });

  test('4. My Devices displays owned hardware and allows setting an active/primary device', async ({ page }) => {
    // Log in so /api/devices returns the user fleet.
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data: USER });
    expect(loginRes.status()).toBe(200);

    // Create two device profiles via the API so the My Devices surface has rows.
    const createA = await page.request.post(`${BASE}/api/devices`, {
      data: {
        deviceName: `Primary Rig ${Date.now()}`,
        deviceType: 'desktop',
        cpuModel: 'AMD Ryzen 9 7950X3D',
        cpuCores: 16,
        ramGb: 64,
        gpuModel: 'NVIDIA GeForce RTX 4090',
        vramGb: 24,
        gpuType: 'dedicated',
        storageType: 'NVMe SSD',
        storageFreeGb: 2048,
        isPortable: false,
      },
    });
    expect(createA.status()).toBe(201);
    const deviceA = (await createA.json()).device;

    const createB = await page.request.post(`${BASE}/api/devices`, {
      data: {
        deviceName: `Secondary Deck ${Date.now()}`,
        deviceType: 'handheld',
        cpuModel: 'AMD Ryzen Z1 Extreme',
        ramGb: 16,
        isPortable: true,
      },
    });
    expect(createB.status()).toBe(201);
    const deviceB = (await createB.json()).device;

    try {
      await page.goto(`${BASE}/#/devices`);
      await page.waitForLoadState('networkidle');
      await page.click('[data-devices-tab="my-devices"]');

      // Both rows render with the owned hardware specs visible.
      const rowA = page.locator(`[data-testid="devices-my-row"][data-device-id="${deviceA.id}"]`);
      const rowB = page.locator(`[data-testid="devices-my-row"][data-device-id="${deviceB.id}"]`);
      await expect(rowA).toBeVisible({ timeout: 15000 });
      await expect(rowB).toBeVisible({ timeout: 15000 });
      await expect(rowA).toContainText('RTX 4090');
      await expect(rowB).toContainText('Z1 Extreme');

      // No primary badge yet on either row.
      await expect(rowA.locator('[data-testid="devices-primary-badge"]')).toHaveCount(0);

      // Set device A as the active/primary device.
      await rowA.locator('[data-testid="devices-set-primary"]').click();

      // After re-render, device A carries the primary badge and device B does not.
      const primaryBadges = page.locator('[data-testid="devices-primary-badge"]');
      await expect(primaryBadges).toHaveCount(1, { timeout: 15000 });
      await expect(rowA.locator('[data-testid="devices-primary-badge"]')).toBeVisible({ timeout: 15000 });
      await expect(rowB.locator('[data-testid="devices-primary-badge"]')).toHaveCount(0);

      // Persistence: fetch the fleet via API and confirm isPrimary is set.
      const listRes = await page.request.get(`${BASE}/api/devices`);
      expect(listRes.status()).toBe(200);
      const fleet = (await listRes.json()).devices;
      const primary = fleet.find((d: any) => d.isPrimary === true);
      expect(primary).toBeDefined();
      expect(primary.id).toBe(deviceA.id);
    } finally {
      // Clean up both test devices.
      await page.request.delete(`${BASE}/api/devices/${deviceA.id}`);
      await page.request.delete(`${BASE}/api/devices/${deviceB.id}`);
    }
  });
});