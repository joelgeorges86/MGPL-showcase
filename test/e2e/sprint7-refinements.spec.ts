import { test, expect, BASE } from "../fixtures";

/**
 * Sprint 7 — Polish, Break-Fixes & Feature Refinements (WUD-7.x).
 *
 * 7.1 Game Library: list-view cards show a single primary platform badge
 *     (no double platform tag injection) plus the synopsis/overview line.
 * 7.2 Device Playability Matrix: game-count label syncs with the Library tab
 *     page size; the "Display only current system hardware" toggle filters
 *     fallback hardware profiles into a graceful blocked state.
 * 7.3 Multi-Game Comparison Matrix: Steam-enriched CPU/GPU/RAM/VRAM specs
 *     render instead of empty/N-A fields.
 * 7.4 Mods Hub: approved provider home links + the legal modding disclaimer.
 * 7.5 Retro Hub: trusted emulator resource links + embedded setup video guide.
 *
 * Runs against the deterministic seeded baseline (test/global-setup.ts) under
 * the Playwright single-worker rule (workers: 1, fullyParallel: false).
 */

test.describe("Sprint 7 — Polish, Break-Fixes & Feature Refinements", () => {
  test("7.1 Library list view shows synopsis and a single primary platform badge", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    await expect(page.locator("#library-games-grid .game-card").first()).toBeVisible({ timeout: 15000 });

    // Switch to list view.
    await page.locator("#library-view-list").click();
    await expect(page.locator("#library-view-list")).toHaveAttribute("aria-pressed", "true");

    const cards = page.locator("#library-games-grid .game-card");
    await expect(cards.first()).toBeVisible();

    // Synopsis/overview line renders on at least one card.
    const synopses = page.locator("#library-games-grid .game-card .library-card-synopsis");
    await expect(synopses.first()).toBeVisible({ timeout: 10000 });

    // No double platform tag injection: the lower strip's owned-platform badges
    // must never repeat the primary `data-card-platform` badge on the same card.
    const platformPairs = await cards.evaluateAll((els: HTMLElement[]) =>
      els.map((el) => {
        const primary =
          el.querySelector("[data-card-platform]")?.getAttribute("data-card-platform") || "";
        const owned = Array.from(el.querySelectorAll("[data-owned-platform]")).map(
          (o) => o.getAttribute("data-owned-platform") || "",
        );
        return { primary, owned };
      }),
    );
    expect(platformPairs.length).toBeGreaterThan(0);
    const anyPrimary = platformPairs.some((c) => c.primary);
    expect(anyPrimary).toBe(true);
    for (const card of platformPairs) {
      if (card.primary) {
        expect(card.owned).not.toContain(card.primary);
      }
    }
  });

  test("7.1 synopsis is surfaced on the games API payload", async ({ request }) => {
    const res = await request.get(`${BASE}/api/games?active=true&owned=true`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const games: any[] = body.games || [];
    expect(games.length).toBeGreaterThan(0);
    const withSynopsis = games.filter((g) => g && typeof g.synopsis === "string" && g.synopsis.trim());
    expect(withSynopsis.length).toBeGreaterThan(0);
  });

  test("7.2 DPM count label syncs with the Library tab page size", async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator("#page-library").waitFor();
    // Default global Library page size is 24.
    const size = await page.evaluate(() => (window as any).__library?.getState()?.pageSize);
    expect(size).toBe(24);

    await page.goto(`${BASE}/#/playability`);
    await page.locator("#page-playability").waitFor();
    await expect(page.locator("#playable-games-container")).toBeVisible();
    const countLabel = page.locator("#dpm-count-label");
    await expect(countLabel).toContainText("Library page size (24)", { timeout: 15000 });
  });

  test("7.2 DPM blocked state still renders the stable library page-size label", async ({ page }) => {
    await page.route("**/api/devices/playability**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          blockedSpecs: true,
          games: [{ gameId: "cyberpunk-2077", playabilityTier: "Playable" }],
          deviceSpecs: { ramGb: null, vramGb: null },
        }),
      });
    });

    await page.goto(`${BASE}/#/playability`);
    await page.locator("#page-playability").waitFor();
    await expect(page.locator("#playable-games-container")).toContainText(
      "Refresh device scan required",
      { timeout: 15000 },
    );
    await expect(page.locator("#dpm-count-label")).toContainText("Library page size (24)");
  });

  test("7.2 'Display only current system hardware' toggle filters fallback profiles", async ({ page }) => {
    // deck_h is a hardcoded fallback preset → per-game deviceMatched=false.
    // Set the active device BEFORE the app boots so the playability route
    // handler fetches the deck_h matrix on navigation.
    await page.addInitScript(() => {
      localStorage.setItem("activeDeviceId", "deck_h");
    });
    await page.goto(`${BASE}/#/playability`);
    await page.locator("#page-playability").waitFor();
    await expect(page.locator("#playable-games-container .game-card").first()).toBeVisible({ timeout: 20000 });

    const toggle = page.locator("#dpm-current-system-toggle");
    await expect(toggle).toBeVisible();
    await toggle.check();

    // Fallback profile → no games verified for the current system → graceful
    // blocked state (never a silent empty grid or fabricated specs).
    await expect(page.locator("#playable-games-container")).toContainText(
      "No games verified for the current system hardware",
      { timeout: 15000 },
    );

    // Un-checking restores the full rated matrix.
    await toggle.uncheck();
    await expect(page.locator("#playable-games-container .game-card").first()).toBeVisible({ timeout: 15000 });
  });

  test("7.3 Comparison API enriches CPU/GPU/RAM/VRAM from Steam requirements", async ({ request }) => {
    const res = await request.post(`${BASE}/api/games/compare`, {
      data: { ids: ["cyberpunk-2077", "the-witcher-3"], deviceId: "rig-ultra-4080" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const comparison: any[] = body.comparison || [];
    expect(comparison.length).toBeGreaterThanOrEqual(2);
    for (const game of comparison) {
      expect(game.specs?.minimum?.cpu).toBeTruthy();
      expect(game.specs?.minimum?.gpu).toBeTruthy();
      expect(game.specs?.minimum?.ramGb).toBeTruthy();
      expect(game.specs?.minimum?.vramGb).toBeTruthy();
    }
  });

  test("7.3 Comparison matrix renders non-empty CPU/GPU rows in the UI", async ({ page }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.locator("#page-compare").waitFor();
    await page.waitForFunction(() => {
      const el = document.getElementById("compare-games-list");
      return !!el && el.querySelectorAll(".compare-game-checkbox").length > 0;
    }, { timeout: 15000 });

    await page.locator("#compare-select-trigger").click();
    const cyberpunk = page
      .locator("#compare-games-list label", { hasText: "Cyberpunk 2077" })
      .locator("input.compare-game-checkbox")
      .first();
    const witcher = page
      .locator("#compare-games-list label", { hasText: "The Witcher 3" })
      .locator("input.compare-game-checkbox")
      .first();
    const boxes = page.locator("#compare-games-list .compare-game-checkbox");
    if ((await cyberpunk.count()) > 0 && (await witcher.count()) > 0) {
      await cyberpunk.check();
      await witcher.check();
    } else {
      await boxes.nth(0).check();
      await boxes.nth(1).check();
    }
    await page.locator("#compare-select-trigger").click();

    const body = page.locator("#matrix-body");
    await expect(body.locator('tr[data-compare-cluster="performance"]').first()).toBeVisible({ timeout: 20000 });

    // CPU (Min / Rec) and GPU (Min / Rec) rows render real values, not N/A.
    const cpuRow = body.locator("tr", { hasText: "CPU (Min / Rec)" }).first();
    await expect(cpuRow).toBeVisible({ timeout: 20000 });
    const cpuText = (await cpuRow.textContent()) || "";
    expect(cpuText).not.toContain("N/A");
    expect(cpuText).toMatch(/Intel|AMD|Processor/i);

    const gpuRow = body.locator("tr", { hasText: "GPU (Min / Rec)" }).first();
    await expect(gpuRow).toBeVisible({ timeout: 20000 });
    const gpuText = (await gpuRow.textContent()) || "";
    expect(gpuText).not.toContain("N/A");
  });

  test("7.4 Mods Hub renders approved provider links and the legal disclaimer", async ({ page }) => {
    await page.goto(`${BASE}/#/mods`);
    await page.locator("#page-mods").waitFor();

    const providerLinks = page.locator("#mods-provider-links a[data-mod-provider-home]");
    await expect(providerLinks.first()).toBeVisible({ timeout: 15000 });
    expect(await providerLinks.count()).toBe(5);

    // Every link is absolute HTTPS and on the approved provider whitelist.
    const hrefs = await providerLinks.evaluateAll((els) => els.map((a) => a.getAttribute("href") || ""));
    for (const href of hrefs) {
      expect(href.startsWith("https://")).toBe(true);
      expect(href).toMatch(/nexusmods\.com|moddb\.com|curseforge\.com|github\.com|modrinth\.com/);
    }

    // Legal modding disclaimer renders.
    const disclaimer = page.locator("#mods-legal-disclaimer");
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText("Legal disclaimer");
    await expect(disclaimer).toContainText("at your own risk");
  });

  test("7.4 /api/mods/providers returns the vetted whitelist + disclaimer", async ({ request }) => {
    const res = await request.get(`${BASE}/api/mods/providers`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBe(5);
    expect(body.disclaimer).toBeTruthy();
  });

  test("7.5 Retro Hub renders emulator resource links and an embedded setup video", async ({ page }) => {
    await page.goto(`${BASE}/#/retro`);
    await page.locator("#page-retro").waitFor();

    const links = page.locator("#retro-resources-list a.retro-emulator-link");
    await expect(links.first()).toBeVisible({ timeout: 15000 });
    expect(await links.count()).toBeGreaterThanOrEqual(4);

    // RetroArch official homepage is present with an absolute HTTPS whitelisted URL.
    const retroarch = page
      .locator("#retro-resources-list a.retro-emulator-link", { hasText: "RetroArch" })
      .first();
    await expect(retroarch).toBeVisible();
    const href = (await retroarch.getAttribute("href")) || "";
    expect(href.startsWith("https://")).toBe(true);
    expect(href).toContain("retroarch.com");

    // Embedded setup video guide renders.
    const guide = page.locator("#retro-setup-guide iframe");
    await expect(guide).toBeVisible({ timeout: 15000 });
    const src = (await guide.getAttribute("src")) || "";
    expect(src).toMatch(/^https:\/\/www\.youtube\.com\/embed/);
  });

  test("7.5 /api/retro/resources returns whitelist-validated emulators + setup guide", async ({ request }) => {
    const res = await request.get(`${BASE}/api/retro/resources`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.emulators)).toBe(true);
    expect(body.emulators.length).toBeGreaterThanOrEqual(4);
    for (const emu of body.emulators) {
      expect(emu.url.startsWith("https://")).toBe(true);
      expect(emu.url).toMatch(
        /retroarch\.com|dolphin-emu\.org|pcsx2\.net|duckstation\.org|mgba\.io|mesen\.ca|sameboy\.github\.io|ares-emu\.net/,
      );
    }
    expect(body.setupGuide.embedUrl).toMatch(/^https:\/\/www\.youtube\.com\/embed/);
  });
});
