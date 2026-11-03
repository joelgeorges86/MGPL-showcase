import { test, expect, runAxeScan } from "../fixtures";

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
// AI-084 (#163): export and import are admin-only (test/global-setup.ts seeds this account).
const ADMIN = { email: "admin.ops@mgpl.io", password: "AdminPass2026!" };

/**
 * Sprint 30 (FEAT-0164-STATE-UI-BACKUP) — State Snapshot & Backup Management UI.
 *
 * Sprint (EPIC-TEST-STD-0001): The fleet UI (/api/devices, src/routes/fleet.ts) is
 * tenant-scoped behind requireAuth and reads from AppDevices, so restore tests
 * authenticate as the seeded user and import "appDevices" rows (user-scoped)
 * which that read path actually serves.
 *
 * Test 1: Navigate to #/settings and export a snapshot via the Data & Backup
 *         Management section; verify the download filename and 27 table keys.
 * Test 2: Drag/upload a valid snapshot file and verify the pre-restore summary
 *         table renders the itemized per-table record counts.
 * Test 3: Confirm restore, verify atomic persistence in SQLite, and verify the
 *         UI hot-rehydrates across views.
 * Test 4: Upload an invalid JSON file and verify descriptive error alerts.
 * Test 5: Zero accessibility violations across the Data & Backup Management UI.
 *
 * AI-084 (#163): export and import are admin-only, so the UI runs as the seeded
 * admin; the restore test then signs in as Alex to read Alex's fleet.
 */
test.describe("Sprint 30 (FEAT-0164-STATE-UI-BACKUP) - State Snapshot & Backup Management UI", () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate as the admin: export and import are admin-only (AI-084, #163).
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data: ADMIN });
    expect(loginRes.status()).toBe(200);

    // Under full-suite sequential load, the network stack can occasionally
    // surface a transient net::ERR_NETWORK_CHANGED on the very first
    // navigation of a new test. Retry once rather than failing the whole
    // suite on a non-deterministic OS-level network blip.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(`${BASE}/#/settings`);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(500);
      }
    }
    if (lastError) throw lastError;
    await page.waitForSelector("#page-settings");
    // The settings hub wires the Data & Backup Management controls on route load.
    await expect(page.locator("#btn-export-state")).toBeVisible();
  });

  test("1. Export produces a downloadable snapshot with all 32 table keys", async ({ page }) => {
    // Trigger the export via the UI button.
    await page.locator("#btn-export-state").click();

    // The status pill reports a successful export with a record count.
    await expect(page.locator("#snapshot-status")).toContainText("Snapshot exported successfully");

    // The export endpoint returns a versioned snapshot with all 33 table keys.
    const res = await page.request.get(`${BASE}/api/state/export`);
    expect(res.ok()).toBeTruthy();
    const disposition = res.headers()["content-disposition"] || "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("mgpl-backup-");

    const snapshot = await res.json();
    expect(snapshot.version).toBe(1);
    expect(typeof snapshot.exportedAt).toBe("string");

    const data = snapshot.data;
    expect(data).toBeTruthy();
    const keys = Object.keys(data);
    expect(keys.length).toBe(33);
    for (const key of [
      "appDevices",
      "fleet",
      "deals",
      "dealPriceHistory",
      "alerts",
      "mods",
      "modCatalog",
      "modVersions",
      "modDependencies",
      "modLoadOrder",
      "hltb",
      "tracking",
      "tags",
      "notes",
      "platformHandles",
      "platformLinks",
      "wishlist",
      "retro",
      "games",
      "backlog",
      "playSessions",
      "devices",
      "deviceSpecs",
      "friendships",
      "builderComponents",
      "builderBuilds",
      "builderRules",
      "performanceProfiles",
      "deviceReviews",
      "reviewVotes",
      "hardwarePriceAlerts",
      "radar",
      "communityBenchmarks",
    ]) {
      expect(Array.isArray(data[key])).toBe(true);
    }
  });

  test("2. Uploading a valid snapshot renders the pre-restore summary table", async ({ page }) => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        fleet: [
          {
            deviceId: "e2e-ui-device",
            deviceName: "E2E UI Device",
            formFactor: "Desktop",
            gpuModel: "RTX 4070",
            vramGb: 12,
            cpuModel: "Ryzen 7 7800X3D",
            ramGb: 32,
            isArchived: 0,
          },
        ],
        appDevices: [
          {
            id: "e2e-ui-device",
            userId: "auth-user-alex-gamer",
            deviceName: "E2E UI Device",
            deviceType: "desktop",
            cpuModel: "Ryzen 7 7800X3D",
            ramGb: 32,
            gpuModel: "RTX 4070",
            vramGb: 12,
            gpuType: "dedicated",
            storageType: "SSD",
            storageFreeGb: 900,
            isPortable: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        deals: [{ steamAppId: "111111", gameTitle: "E2E UI Deal", targetPrice: 9.99 }],
        alerts: [
          {
            userId: "auth-user-alex-gamer",
            gameId: "G00001",
            title: "E2E UI Deal",
            targetPrice: 14.99,
          },
        ],
        mods: [
          {
            gameId: "G00001",
            gameDomain: "nexusmods.com",
            modId: "888888",
            modName: "E2E UI Mod",
            isActive: 1,
          },
        ],
        hltb: [
          {
            gameTitle: "E2E UI Deal",
            mainStory: 8,
            mainExtra: 12,
            completionist: 20,
            hltbScore: 7,
          },
        ],
        tracking: [{ GameID: "G00001", "Play Status": "Playing", "Hours Played": 3 }],
        tags: [
          {
            userId: "auth-user-alex-gamer",
            gameId: "G00001",
            tagName: "UITag",
            colorHex: "#3b82f6",
          },
        ],
        notes: [
          { userId: "auth-user-alex-gamer", gameId: "G00001", noteMarkdown: "UI note content" },
        ],
        platformHandles: [{ userId: "auth-user-alex-gamer", steamUsername: "pubSteam" }],
        wishlist: [
          {
            userId: "auth-user-alex-gamer",
            gameId: "G00001",
            title: "E2E UI Wishlist",
            targetPrice: 19.99,
          },
        ],
        retro: [{ gameTitle: "E2E Retro", system: "SNES", status: "Playing", playtimeHours: 2 }],
        games: [{ GameID: "G00001", "Game Title": "E2E UI Game", "Primary Genre": "Action" }],
        backlog: [{ gameId: "G00001", title: "E2E UI Backlog", status: "Backlog" }],
        playSessions: [
          {
            sessionUuid: "e2e-ui-session",
            gameId: "G00001",
            startedAt: new Date().toISOString(),
            durationSeconds: 120,
          },
        ],
        friendships: [
          {
            userId: "auth-user-alex-gamer",
            friendId: "auth-user-jordan-dev",
            status: "accepted",
            source: "manual",
          },
        ],
      },
    };

    // Upload the snapshot through the hidden file input (simulates the dropzone).
    const buffer = Buffer.from(JSON.stringify(payload));
    await page.locator("#snapshot-file-input").setInputFiles({
      name: "mgpl-snapshot.json",
      mimeType: "application/json",
      buffer,
    });

    // The pre-restore confirmation card becomes visible.
    await expect(page.locator("#snapshot-restore-preview")).toBeVisible();

    // The summary table renders itemized per-table record counts.
    const body = page.locator("#snapshot-summary-body");

    // The summary table renders every registered snapshot key in registry order.
    // Keys supplied in the payload show their record counts; omitted optional
    // keys resolve to 0 (the /api/state/validate summary iterates the full
    // 33-key DATA_KEY_TO_TABLE registry and preserves insertion order).
    const expectedSummary: Array<[string, string]> = [
      ["appDevices", "1"],
      ["fleet", "1"],
      ["deals", "1"],
      ["dealPriceHistory", "0"],
      ["alerts", "1"],
      ["mods", "1"],
      ["modCatalog", "0"],
      ["modVersions", "0"],
      ["modDependencies", "0"],
      ["modLoadOrder", "0"],
      ["hltb", "1"],
      ["tracking", "1"],
      ["tags", "1"],
      ["notes", "1"],
      ["platformHandles", "1"],
      ["platformLinks", "0"],
      ["wishlist", "1"],
      ["retro", "1"],
      ["games", "1"],
      ["backlog", "1"],
      ["playSessions", "1"],
      ["devices", "0"],
      ["deviceSpecs", "0"],
      ["friendships", "1"],
      ["builderComponents", "0"],
      ["builderBuilds", "0"],
      ["builderRules", "0"],
      ["performanceProfiles", "0"],
      ["deviceReviews", "0"],
      ["reviewVotes", "0"],
      ["hardwarePriceAlerts", "0"],
      ["radar", "0"],
      ["communityBenchmarks", "0"],
    ];

    const rows = body.locator("tr");
    expect(await rows.count()).toBe(expectedSummary.length);
    for (let i = 0; i < expectedSummary.length; i++) {
      await expect(rows.nth(i)).toContainText(expectedSummary[i][0]);
      await expect(rows.nth(i)).toContainText(expectedSummary[i][1]);
    }

    // The status pill confirms validation succeeded.
    await expect(page.locator("#snapshot-status")).toContainText("Snapshot validated (version 1)");
  });

  test("3. Confirm restore persists atomically and hot-rehydrates the UI", async ({ page }) => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        fleet: [
          {
            deviceId: "e2e-ui-restore-device",
            deviceName: "E2E UI Restore Device",
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
            id: "e2e-ui-restore-device",
            userId: "auth-user-alex-gamer",
            deviceName: "E2E UI Restore Device",
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

    const buffer = Buffer.from(JSON.stringify(payload));
    await page.locator("#snapshot-file-input").setInputFiles({
      name: "mgpl-snapshot.json",
      mimeType: "application/json",
      buffer,
    });

    await expect(page.locator("#snapshot-restore-preview")).toBeVisible();

    // Confirm the restore.
    await page.locator("#btn-confirm-restore").click();

    // The status pill reports a successful restore.
    await expect(page.locator("#snapshot-status")).toContainText("Snapshot restored successfully");

    // The preview card is hidden again after a successful restore.
    await expect(page.locator("#snapshot-restore-preview")).toBeHidden();

    // Atomic persistence: the restored device is present in SQLite via the API.
    // The fleet read path is per user: sign in as Alex, who owns the restored row.
    const alexLogin = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(alexLogin.status()).toBe(200);
    const devicesRes = await page.request.get(`${BASE}/api/devices?status=active`);
    const devicesBody = await devicesRes.json();
    const persisted = (devicesBody.devices || []).find(
      (d: any) => (d.id || d.deviceId) === "e2e-ui-restore-device",
    );
    expect(persisted).toBeTruthy();
    expect(persisted.gpuModel).toBe("RTX 3080");

    // Hot rehydration: navigate to the fleet route and confirm the restored
    // device renders without a manual refresh.
    await page.goto(`${BASE}/#/fleet`);
    await page.waitForSelector("#page-fleet");

    const waitForDevice = async () => {
      await page.waitForFunction(
        () => {
          const container = document.getElementById("fleet-devices-container");
          return (
            container &&
            container.textContent &&
            container.textContent.includes("E2E UI Restore Device")
          );
        },
        { timeout: 15000 },
      );
    };

    try {
      await waitForDevice();
    } catch {
      await page.click("#tab-fleet-active");
      await waitForDevice();
    }

    await expect(page.locator("#fleet-devices-container")).toContainText("E2E UI Restore Device");
  });

  test("4. Invalid JSON uploads surface descriptive error alerts", async ({ page }) => {
    // Case A: malformed JSON text.
    const badBuffer = Buffer.from("{ not valid json !!!");
    await page.locator("#snapshot-file-input").setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: badBuffer,
    });

    await expect(page.locator("#snapshot-error")).toContainText(
      "Invalid JSON file. Please select a valid snapshot.",
    );
    await expect(page.locator("#snapshot-status")).toContainText(
      "Invalid JSON file. Please select a valid snapshot.",
    );
    // No preview should appear for an invalid file.
    await expect(page.locator("#snapshot-restore-preview")).toBeHidden();

    // Case B: valid JSON but an unsupported snapshot version.
    const wrongVersion = Buffer.from(JSON.stringify({ version: 99, data: { fleet: [] } }));
    await page.locator("#snapshot-file-input").setInputFiles({
      name: "wrong-version.json",
      mimeType: "application/json",
      buffer: wrongVersion,
    });

    await expect(page.locator("#snapshot-error")).toContainText("Unsupported snapshot version");
    await expect(page.locator("#snapshot-restore-preview")).toBeHidden();

    // Case C: valid JSON but missing required array keys.
    const missingKeys = Buffer.from(JSON.stringify({ version: 1, data: { fleet: [] } }));
    await page.locator("#snapshot-file-input").setInputFiles({
      name: "missing-keys.json",
      mimeType: "application/json",
      buffer: missingKeys,
    });

    await expect(page.locator("#snapshot-error")).toContainText("missing required array keys");
    await expect(page.locator("#snapshot-restore-preview")).toBeHidden();
  });

  test("5. Zero accessibility violations on the Data & Backup Management UI", async ({ page }) => {
    const results = await runAxeScan(page, { selector: "#page-settings" });

    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);
  });
});
