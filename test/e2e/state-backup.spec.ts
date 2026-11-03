import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
// AI-084 (#163): export and import are admin-only (test/global-setup.ts seeds this account).
const ADMIN = { email: "admin.ops@mgpl.io", password: "AdminPass2026!" };

/**
 * Sprint 17 (FEAT-0149) — State Export/Import, Database Snapshot Engine & Cloud-Ready Backup.
 *
 * Test 1: Trigger JSON export, verify snapshot structure and table keys.
 * Test 2: Import a mock JSON state payload, validate data upsert into SQLite.
 * Test 3: Handle malformed import payloads gracefully with descriptive validation errors.
 * Test 4: Verify persistence of restored data across navigation tabs.
 *
 * Sprint (EPIC-TEST-STD-0001): The fleet UI (/api/devices, src/routes/fleet.ts) is
 * tenant-scoped behind requireAuth and reads from AppDevices. The export "fleet"
 * key round-trips the legacy Devices table, so the persistence assertions
 * authenticate as the seeded user and also import "appDevices" (AppDevices,
 * user-scoped) which the /api/devices read path actually serves.
 *
 * AI-084 (#163): export and import are admin-only, so each test signs in as
 * the seeded admin to call them, then signs in as Alex to read Alex's fleet.
 * Test 5 proves the 401 and 403 paths.
 */
test.describe("State Export/Import & Database Snapshot Engine (FEAT-0149)", () => {
  test.beforeEach(async ({ page }) => {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ADMIN });
    expect(login.status()).toBe(200);
  });

  test("1. Export produces a versioned snapshot with all table keys", async ({
    page,
  }: {
    page: any;
  }) => {
    const res = await page.request.get("http://localhost:4000/api/state/export");
    expect(res.ok()).toBeTruthy();

    // Attachment download header should be present for browser download
    const disposition = res.headers()["content-disposition"] || "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("mgpl-backup-");

    const snapshot = await res.json();
    expect(snapshot.version).toBe(1);
    expect(typeof snapshot.exportedAt).toBe("string");
    expect(new Date(snapshot.exportedAt).getTime()).not.toBeNaN();

    // All six data keys must be present (tracking included)
    const data = snapshot.data;
    expect(data).toBeTruthy();
    for (const key of ["fleet", "deals", "alerts", "mods", "hltb", "tracking"]) {
      expect(Array.isArray(data[key])).toBe(true);
    }
  });

  test("2. Import upserts a mock payload into SQLite", async ({ page }: { page: any }) => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        fleet: [
          {
            deviceId: "e2e-import-device",
            deviceName: "E2E Import Device",
            formFactor: "Desktop",
            gpuModel: "RTX 4090",
            vramGb: 24,
            cpuModel: "Ryzen 9 7950X",
            ramGb: 64,
            isArchived: 0,
          },
        ],
        // AppDevices row (user-scoped) so the fleet UI (/api/devices) surfaces it.
        appDevices: [
          {
            id: "e2e-import-device",
            userId: "auth-user-alex-gamer",
            deviceName: "E2E Import Device",
            deviceType: "desktop",
            cpuModel: "Ryzen 9 7950X",
            ramGb: 64,
            gpuModel: "RTX 4090",
            vramGb: 24,
            gpuType: "dedicated",
            storageType: "SSD",
            storageFreeGb: 1000,
            isPortable: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        deals: [{ steamAppId: "123456", gameTitle: "E2E Import Deal", targetPrice: 19.99 }],
        alerts: [
          {
            userId: "auth-user-alex-gamer",
            gameId: "G00001",
            title: "E2E Import Deal",
            targetPrice: 24.99,
          },
        ],
        mods: [
          {
            gameId: "G00001",
            gameDomain: "nexusmods.com",
            modId: "999999",
            modName: "E2E Import Mod",
            isActive: 1,
          },
        ],
        hltb: [
          {
            gameTitle: "E2E Import Deal",
            mainStory: 10,
            mainExtra: 15,
            completionist: 25,
            hltbScore: 8,
          },
        ],
        tracking: [{ GameID: "G00001", "Play Status": "Playing", "Hours Played": 5 }],
        tags: [
          {
            userId: "auth-user-alex-gamer",
            gameId: "G00001",
            tagName: "ImportedTag",
            colorHex: "#3b82f6",
          },
        ],
        notes: [
          {
            userId: "auth-user-alex-gamer",
            gameId: "G00001",
            noteMarkdown: "Imported note content",
          },
        ],
      },
    };

    const res = await page.request.post("http://localhost:4000/api/state/import", {
      data: payload,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);

    const restored = body.restored;
    expect(restored.fleetCount).toBeGreaterThanOrEqual(1);
    expect(restored.dealsCount).toBeGreaterThanOrEqual(1);
    expect(restored.alertsCount).toBeGreaterThanOrEqual(1);
    expect(restored.modsCount).toBeGreaterThanOrEqual(1);
    expect(restored.hltbCount).toBeGreaterThanOrEqual(1);

    // Verify the imported device actually persisted via the devices API
    // The fleet read path is per user: sign in as Alex, who owns the restored row.
    const alexLogin = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(alexLogin.status()).toBe(200);
    const devicesRes = await page.request.get("http://localhost:4000/api/devices");
    const devicesBody = await devicesRes.json();
    const imported = (devicesBody.devices || []).find(
      (d: any) => (d.id || d.deviceId) === "e2e-import-device",
    );
    expect(imported).toBeTruthy();
    expect(imported.gpuModel).toBe("RTX 4090");
  });

  test("3. Malformed import payloads return descriptive validation errors", async ({
    page,
  }: {
    page: any;
  }) => {
    // Case A: not an object
    const notObject = await page.request.post("http://localhost:4000/api/state/import", {
      data: [1, 2, 3],
    });
    expect(notObject.status()).toBe(400);
    const notObjectBody = await notObject.json();
    expect(notObjectBody.success).toBe(false);
    expect(notObjectBody.error).toContain("JSON object");

    // Case B: wrong version
    const wrongVersion = await page.request.post("http://localhost:4000/api/state/import", {
      data: { version: 99, data: {} },
    });
    expect(wrongVersion.status()).toBe(400);
    const wrongVersionBody = await wrongVersion.json();
    expect(wrongVersionBody.success).toBe(false);
    expect(wrongVersionBody.error).toContain("Unsupported snapshot version");

    // Case C: missing data object
    const missingData = await page.request.post("http://localhost:4000/api/state/import", {
      data: { version: 1 },
    });
    expect(missingData.status()).toBe(400);
    const missingDataBody = await missingData.json();
    expect(missingDataBody.success).toBe(false);
    expect(missingDataBody.error).toContain("data");

    // Case D: missing required array keys
    const missingKeys = await page.request.post("http://localhost:4000/api/state/import", {
      data: { version: 1, data: { fleet: [] } },
    });
    expect(missingKeys.status()).toBe(400);
    const missingKeysBody = await missingKeys.json();
    expect(missingKeysBody.success).toBe(false);
    expect(missingKeysBody.error).toContain("missing required array keys");
  });

  test("4. Restored data persists across navigation tabs", async ({ page }: { page: any }) => {
    // Import a known device, then navigate to the fleet page and confirm it renders.
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        fleet: [
          {
            deviceId: "e2e-persist-device",
            deviceName: "E2E Persist Device",
            formFactor: "Laptop",
            gpuModel: "RTX 3080",
            vramGb: 16,
            cpuModel: "i9-13900H",
            ramGb: 32,
            isArchived: 0,
          },
        ],
        // AppDevices row (user-scoped) so the fleet UI (/api/devices) surfaces it.
        appDevices: [
          {
            id: "e2e-persist-device",
            userId: "auth-user-alex-gamer",
            deviceName: "E2E Persist Device",
            deviceType: "laptop",
            cpuModel: "i9-13900H",
            ramGb: 32,
            gpuModel: "RTX 3080",
            vramGb: 16,
            gpuType: "dedicated",
            storageType: "SSD",
            storageFreeGb: 500,
            isPortable: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        deals: [],
        alerts: [],
        mods: [],
        hltb: [],
        tracking: [],
        tags: [],
        notes: [],
      },
    };

    const importRes = await page.request.post("http://localhost:4000/api/state/import", {
      data: payload,
    });
    expect(importRes.ok()).toBeTruthy();
    const importBody = await importRes.json();
    expect(importBody.success).toBe(true);

    // Verify the restored device is persisted in SQLite via the devices API
    // (authoritative persistence check independent of UI rendering).
    // The fleet read path is per user: sign in as Alex, who owns the restored row.
    const alexLogin = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(alexLogin.status()).toBe(200);
    const devicesRes = await page.request.get("http://localhost:4000/api/devices?status=active");
    const devicesBody = await devicesRes.json();
    const persisted = (devicesBody.devices || []).find(
      (d: any) => (d.id || d.deviceId) === "e2e-persist-device",
    );
    expect(persisted).toBeTruthy();
    expect(persisted.gpuModel).toBe("RTX 3080");

    // Navigate to the fleet route and confirm the restored device is visible.
    // The fleet page lazy-loads devices once per route visit; if the initial fetch
    // transiently fails, re-trigger it via the "Active Fleet" tab before asserting.
    const waitForDevice = async () => {
      await page.waitForFunction(
        () => {
          const container = document.getElementById("fleet-devices-container");
          return (
            container &&
            container.textContent &&
            container.textContent.includes("E2E Persist Device")
          );
        },
        { timeout: 15000 },
      );
    };

    await page.goto("http://localhost:4000/#/fleet");
    await page.waitForSelector("#page-fleet");

    try {
      await waitForDevice();
    } catch {
      // Initial lazy load may have failed transiently; re-trigger via the Active Fleet tab.
      await page.click("#tab-fleet-active");
      await waitForDevice();
    }

    await expect(page.locator("#fleet-devices-container")).toContainText("E2E Persist Device");

    // Navigate away and back — the data should still be present (persisted in SQLite)
    await page.goto("http://localhost:4000/#/home");
    await page.waitForSelector("#page-home");
    await page.goto("http://localhost:4000/#/fleet");
    await page.waitForSelector("#page-fleet");

    try {
      await waitForDevice();
    } catch {
      await page.click("#tab-fleet-active");
      await waitForDevice();
    }

    await expect(page.locator("#fleet-devices-container")).toContainText("E2E Persist Device");
  });

  test("5. Export and import refuse a non-admin (403) and a guest (401)", async ({ page }) => {
    const alexLogin = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(alexLogin.status()).toBe(200);
    const exportAsUser = await page.request.get(`${BASE}/api/state/export`);
    expect(exportAsUser.status()).toBe(403);
    const importAsUser = await page.request.post(`${BASE}/api/state/import`, {
      data: { version: 1, data: {} },
    });
    expect(importAsUser.status()).toBe(403);

    await page.context().clearCookies();
    const exportAsGuest = await page.request.get(`${BASE}/api/state/export`);
    expect(exportAsGuest.status()).toBe(401);
    const importAsGuest = await page.request.post(`${BASE}/api/state/import`, {
      data: { version: 1, data: {} },
    });
    expect(importAsGuest.status()).toBe(401);
  });
});
