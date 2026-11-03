import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";

/**
 * Sprint 5 (EPICUX05) — Hardware Explorer 2.0 E2E spec.
 *
 *  1. POST /api/scan returns normalized, PII-free telemetry and persists it.
 *  2. Explicit-trigger compatibility returns Minimum/Recommended/Ultra tiers.
 *  3. Missing persisted VRAM/specs produce the documented blocked state.
 *  4. Upgrade advisor returns real-spec suggestions + whitelisted retailer links.
 *  5. Side-by-side component comparison (≤4 slots) with benchmarks + trends.
 *  6. Filterable community benchmark tables (resolution/preset/avg/1% low).
 *  7. UI: #/hardware renders, explicit Analyze trigger, benchmark table loads.
 *  8. State export includes community_benchmarks + extended Devices columns.
 *
 * All specs run single-worker via playwright.config.ts (workers:1).
 */
test.describe("EPICUX05 — Hardware Explorer 2.0", () => {
  test("1. POST /api/scan returns PII-free normalized telemetry and persists it", async ({
    page,
  }) => {
    const res = await page.request.post(`${BASE}/api/scan`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.telemetry).toBeTruthy();

    const t = body.telemetry;
    // Structural invariants that hold regardless of the host machine.
    expect(typeof t.cpuModel).toBe("string");
    expect(typeof t.ramGb).toBe("number");
    expect(t.gpuModel === null || typeof t.gpuModel === "string").toBe(true);
    expect(["complete", "partial"]).toContain(t.scanConfidence);
    expect(Array.isArray(t.missingFields)).toBe(true);
    expect(typeof t.deviceClass).toBe("string");
    expect(typeof t.storageFreeGb).toBe("number");

    if (t.gpuModel === null) {
      expect(t.scanConfidence).toBe("partial");
      expect(t.missingFields).toContain("gpu");
    }

    // No PII is ever extracted, persisted or served.
    const serialized = JSON.stringify(t).toLowerCase();
    for (const needle of [
      "username",
      "password",
      "hostname",
      "serial",
      "macaddress",
      "email",
      "token",
      "uuid",
    ]) {
      expect(serialized.includes(needle)).toBe(false);
    }

    // The scan persisted to the authoritative Devices table (local-host).
    const readRes = await page.request.get(`${BASE}/api/hardware/explorer`);
    const readBody = await readRes.json();
    expect(readBody.success).toBe(true);
    expect(readBody.device).toBeTruthy();
    expect(readBody.device.deviceId).toBe("local-host");
    expect(["complete", "partial"]).toContain(readBody.device.scanConfidence);
    expect(typeof readBody.device.lastScanAt).toBe("string");
  });

  test("2. Explicit-trigger compatibility returns Minimum/Recommended/Ultra tiers", async ({
    page,
  }) => {
    const res = await page.request.post(`${BASE}/api/hardware/compatibility`, {
      data: { deviceId: "rig-ultra-4080", gameId: "cyberpunk-2077", powerProfile: "Plugged-In" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.blocked).toBe(false);

    const tiers = body.evaluation.tiers;
    for (const tierName of ["minimum", "recommended", "ultra"]) {
      const tier = tiers[tierName];
      expect(tier).toBeTruthy();
      expect(typeof tier.rating).toBe("string");
      expect(tier.axes).toBeTruthy();
      for (const axis of ["cpu", "ram", "vram", "storage"]) {
        expect(tier.axes[axis]).toBeTruthy();
        expect(["optimal", "playable", "bottleneck", "unsupported", "missing"]).toContain(
          tier.axes[axis].status,
        );
      }
    }
    // Derived tiers are explicitly labeled so they are never presented as
    // source-verified requirements (no synthetic tiers doctrine).
    expect(body.evaluation.derived).toBe(true);
  });

  test("3. Missing persisted VRAM produces an explicit blocked state (no guessing)", async ({
    page,
  }) => {
    const res = await page.request.post(`${BASE}/api/hardware/compatibility`, {
      data: { deviceId: "ghost-rig", gameId: "cyberpunk-2077" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.blocked).toBe(true);
    expect(body.blockedReason).toBe("Missing VRAM");
    expect(body.message).toContain("Refresh device scan required");
  });

  test("4. Upgrade advisor returns real-spec suggestions with whitelisted retailers", async ({
    page,
  }) => {
    const res = await page.request.get(`${BASE}/api/hardware/upgrade?deviceId=rig-ultra-4080`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.blocked).toBe(false);
    expect(body.current.vramGb).toBe(16);
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBeGreaterThan(0);

    const gpuUpgrades = body.suggestions.filter((s: any) => s.category === "GPU");
    expect(gpuUpgrades.length).toBeGreaterThan(0);
    const best = gpuUpgrades[0];
    expect(best.metric).toBe("VRAM");
    expect(best.delta).toBeGreaterThan(0);
    expect(typeof best.priceUsd).toBe("number");

    // Every retailer link is domain-whitelisted (Amazon / Best Buy / Newegg).
    const allowed = new Set([
      "amazon.com",
      "www.amazon.com",
      "bestbuy.com",
      "www.bestbuy.com",
      "newegg.com",
      "www.newegg.com",
    ]);
    for (const s of body.suggestions) {
      for (const r of s.retailers) {
        expect(r.whitelisted).toBe(true);
        const host = new URL(r.url).hostname.toLowerCase();
        expect(allowed.has(host)).toBe(true);
      }
    }
  });

  test("5. Upgrade advisor blocks gracefully when the rig has no persisted specs", async ({
    page,
  }) => {
    const res = await page.request.get(`${BASE}/api/hardware/upgrade?deviceId=ghost-rig`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.blocked).toBe(true);
    expect(body.message).toContain("Refresh device scan required");
  });

  test("6. Side-by-side component comparison returns specs, benchmarks and trends", async ({
    page,
  }) => {
    const res = await page.request.get(
      `${BASE}/api/hardware/components/compare?ids=gpu-rtx-4060,gpu-rtx-4070-super,gpu-rtx-4080-super`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.components.length).toBe(3);

    for (const c of body.components) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.priceUsd).toBe("number");
      // Community benchmark rows carry avg FPS + 1% low FPS.
      expect(Array.isArray(c.benchmarks)).toBe(true);
      expect(c.benchmarks.length).toBeGreaterThan(0);
      const bench = c.benchmarks[0];
      expect(typeof bench.avgFps).toBe("number");
      expect(typeof bench.onePercentLowFps).toBe("number");
      expect(["1080p", "1440p", "4K"]).toContain(bench.resolution);
      // Price history includes a trend indicator and a point series.
      expect(c.priceHistory).toBeTruthy();
      expect(["stable", "down", "up"]).toContain(c.priceHistory.trend);
      expect(Array.isArray(c.priceHistory.points)).toBe(true);
      // Verified retailer buy links.
      expect(c.retailers.length).toBeGreaterThan(0);
      expect(c.retailers.every((r: any) => r.whitelisted === true)).toBe(true);
    }

    // A 4-slot comparison works too.
    const res4 = await page.request.get(
      `${BASE}/api/hardware/components/compare?ids=gpu-rtx-4060,gpu-rtx-4070-super,gpu-rtx-4080-super,gpu-rtx-4090`,
    );
    expect(res4.status()).toBe(200);
    expect((await res4.json()).components.length).toBe(4);

    // Fewer than 2 ids is rejected with a clear 400.
    const bad = await page.request.get(`${BASE}/api/hardware/components/compare?ids=gpu-rtx-4060`);
    expect(bad.status()).toBe(400);
  });

  test("7. Community benchmark tables are filterable by resolution and preset", async ({
    page,
  }) => {
    const res = await page.request.get(`${BASE}/api/hardware/benchmarks?type=gpu&resolution=1080p`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.benchmarks.length).toBeGreaterThan(0);
    for (const b of body.benchmarks) {
      expect(b.componentType).toBe("gpu");
      expect(b.resolution).toBe("1080p");
      expect(b.avgFps).toBeGreaterThan(0);
      expect(b.onePercentLowFps).toBeGreaterThan(0);
      expect(b.sampleCount).toBeGreaterThan(0);
      expect(b.componentName.length).toBeGreaterThan(0);
    }

    // Preset filtering narrows the result set deterministically.
    const ultraRes = await page.request.get(
      `${BASE}/api/hardware/benchmarks?type=gpu&preset=Ultra`,
    );
    const ultraBody = await ultraRes.json();
    expect(ultraBody.success).toBe(true);
    expect(ultraBody.benchmarks.every((b: any) => b.settingsPreset === "Ultra")).toBe(true);

    // No matches => an empty array, never a 500.
    const noneRes = await page.request.get(
      `${BASE}/api/hardware/benchmarks?type=cpu&resolution=4K&preset=Ultra`,
    );
    expect(noneRes.status()).toBe(200);
  });

  test("8. State snapshot export registers community_benchmarks and extended Devices columns", async ({
    page,
  }) => {
    // AI-084 (#163): export is admin-only (test/global-setup.ts seeds this account).
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: "admin.ops@mgpl.io", password: "AdminPass2026!" },
    });
    expect(login.status()).toBe(200);
    const res = await page.request.get(`${BASE}/api/state/export`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.data.communityBenchmarks)).toBe(true);
    expect(body.data.communityBenchmarks.length).toBeGreaterThan(0);

    // The extended rig-telemetry columns round-trip through the snapshot.
    const deviceRow = (body.data.fleet || body.data.Devices || []).find(
      (d: any) => d.deviceId === "rig-ultra-4080",
    );
    expect(deviceRow).toBeTruthy();
    expect(deviceRow.cpuCores).toBe(8);
    expect(deviceRow.deviceClass !== undefined).toBe(true);
    expect(deviceRow.scanConfidence !== undefined).toBe(true);
    expect(deviceRow.thermalCapabilities !== undefined).toBe(true);
  });

  test("9. UI #/hardware renders and compatibility only runs on explicit trigger", async ({
    page,
  }) => {
    await page.goto(BASE);
    await page.evaluate(() => {
      window.location.hash = "#/hardware";
    });
    await page.waitForSelector("#page-hardware");
    await expect(page.locator("#page-hardware")).toBeVisible({ timeout: 15000 });

    // The community benchmark table loads on first render.
    await expect(page.locator("#hw-bench-table table tbody tr").first()).toBeVisible({
      timeout: 15000,
    });

    // Explicit-trigger rule: nothing computes until "Analyze Compatibility".
    await expect(page.locator("#hw-comp-results")).toBeEmpty();

    // Clicking without a game yields a guidance message, not a guess.
    await page.click("#hw-analyze-btn");
    await expect(page.locator("#hw-comp-results")).toContainText("Select a game first.");

    // Select a known seeded game and trigger the analysis.
    await page.waitForSelector('#hw-comp-game option[value="cyberpunk-2077"]', {
      state: "attached",
      timeout: 15000,
    });
    await page.selectOption("#hw-comp-game", "cyberpunk-2077");
    await page.click("#hw-analyze-btn");

    // The result is either the full tier matrix (scanned rig) or the explicit
    // blocked state (never a silent failure / guess).
    await expect(page.locator("#hw-comp-results")).toContainText(
      /Minimum|Refresh device scan required|Missing VRAM/,
      { timeout: 15000 },
    );
  });

  test("10. UI comparison tool renders sticky tabbed comparison after explicit Compare", async ({
    page,
  }) => {
    await page.goto(BASE);
    await page.evaluate(() => {
      window.location.hash = "#/hardware";
    });
    await page.waitForSelector("#page-hardware");

    // Slot pickers populate from the component catalog.
    await expect(page.locator("#hw-cmp-slots .hw-cmp-slot")).toHaveCount(4, {
      timeout: 15000,
    });

    // Fill slots 1 & 2 and run the explicit Compare action.
    const slots = page.locator("#hw-cmp-slots .hw-cmp-slot");
    await slots.nth(0).selectOption("gpu-rtx-4060");
    await slots.nth(1).selectOption("gpu-rtx-4070-super");
    await page.click("#hw-cmp-run");

    // The comparison table renders with sticky headers + tabbed views.
    await expect(page.locator("#hw-cmp-table table.hw-cmp-sticky")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator("#hw-cmp-table")).toContainText("NVIDIA GeForce RTX 4060");

    // Specs tab is active by default; switch to Benchmarks (avg + 1% low FPS).
    await page.click('[data-cmp-tab="benchmarks"]');
    await expect(page.locator("#hw-cmp-table")).toContainText("Avg FPS");
    await expect(page.locator("#hw-cmp-table")).toContainText("1% Low");

    // Price History tab shows trend badges and a pure-SVG sparkline.
    await page.click('[data-cmp-tab="price-history"]');
    await expect(page.locator("#hw-cmp-table")).toContainText("Trend");
    await expect(page.locator("#hw-cmp-table svg polyline").first()).toBeVisible({
      timeout: 15000,
    });
  });

  test("11. Hardware Explorer is reachable via nav, rail and the Devices cross-link", async ({
    page,
  }) => {
    await page.goto(BASE);

    // Rail link navigates to #/hardware.
    await page.click('#desktop-rail a[href="#/hardware"]');
    await expect(page.locator("#page-hardware")).toBeVisible({ timeout: 15000 });

    // Deep link with ?tool= preselection still renders the page.
    await page.evaluate(() => {
      window.location.hash = "#/hardware?tool=compatibility";
    });
    await expect(page.locator("#page-hardware")).toBeVisible({ timeout: 15000 });

    // Cross-link from the Devices Overview hub carries preselected state.
    await page.evaluate(() => {
      window.location.hash = "#/devices";
    });
    await expect(page.locator("#page-devices")).toBeVisible({ timeout: 15000 });
    const crossLink = page.locator('#page-devices a[href="#/hardware?tool=compatibility"]');
    await expect(crossLink).toBeVisible({ timeout: 15000 });
    await expect(crossLink).toContainText("Hardware Explorer");
  });
});
