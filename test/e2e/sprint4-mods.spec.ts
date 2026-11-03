import { test, expect } from "@playwright/test";

/**
 * Sprint 4 (EPICUX04) — Mods Hub 2.0 E2E coverage.
 *
 * Acceptance criteria under test:
 *   1. Mod Detail Pages — selecting any mod renders its comprehensive
 *      description, author details, stats bar and structured dependency tree
 *      without layout shifts.
 *   2. Automated Conflict Detection — file-level conflicts are flagged between
 *      selected mods and presented as inline warnings (API + UI badges).
 *   3. Load Order Manager — active mods reorder via accessible keyboard
 *      controls (and drag handles) with persistence saved instantly to SQLite
 *      plus one-step undo.
 *   4. State round-trip — mod version history, dependency edges and custom
 *      load orders survive the JSON snapshot export/import lifecycle.
 *
 * Security guardrails asserted: every detail sourceUrl is HTTPS + whitelist
 * verified and author handles are masked (privacy-minimized).
 */

const BASE = "http://localhost:4000";

const ALLOWED_SOURCE_HOSTS = [
  "nexusmods.com",
  "moddb.com",
  "curseforge.com",
  "github.com",
  "modrinth.com",
];

test.describe("Sprint 4 — Mods Hub 2.0 API", () => {
  test("1. Detail payload includes description, masked author, stats, version history and dependency tree", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/mods/detail?game=cyberpunk2077&modId=202`);
    expect(res.status()).toBe(200);
    const detail = await res.json();

    expect(detail.modName).toBe("REDscript Framework");
    // privacy-minimized: the raw external handle never surfaces.
    expect(detail.author.handle).toContain("•");
    expect(detail.author.handle).not.toBe("jacobsen");
    // Description is served (sanitized plain text).
    expect(detail.description).toContain("compiler");
    // Stats bar values are present.
    expect(detail.stats.downloadsLabel).toBeTruthy();
    expect(detail.stats.installsLabel).toBeTruthy();
    expect(detail.version).toBeTruthy();
    // Version history (changelog) is served.
    expect(Array.isArray(detail.versionHistory)).toBe(true);
    expect(detail.versionHistory.length).toBeGreaterThan(0);
    // Dependency edges + structured tree.
    expect(detail.dependencies.length).toBe(1);
    expect(detail.dependencies[0].dependsOn).toBe("201");
    expect(detail.dependencies[0].isHard).toBe(true);
    expect(detail.dependencyTree.length).toBe(1);
    expect(detail.dependencyTree[0].modId).toBe("202");
    expect(detail.dependencyTree[0].children[0].modId).toBe("201");
    // File-level manifest present for conflict detection.
    expect(detail.files.length).toBeGreaterThan(0);
    // Whitelist + HTTPS guardrail on every outbound link.
    expect(detail.linkValid).toBe(true);
    expect(detail.sourceUrl).toMatch(/^https:\/\//);
    const host = new URL(detail.sourceUrl).hostname.replace(/^www\./, "");
    expect(ALLOWED_SOURCE_HOSTS).toContain(host);
  });

  test("2. File-level conflicts are detected between selected mods", async ({ request }) => {
    const res = await request.get(`${BASE}/api/mods/conflicts?game=cyberpunk2077&modIds=203,204`);
    expect(res.status()).toBe(200);
    const report = await res.json();

    expect(report.checkedModIds).toEqual(["203", "204"]);
    const fileConflicts = report.conflicts.filter((c) => c.type === "file");
    expect(fileConflicts.length).toBe(1);
    expect(fileConflicts[0].modA).toBe("203");
    expect(fileConflicts[0].modB).toBe("204");
    expect(fileConflicts[0].message).toContain("write the same file");
    expect(fileConflicts[0].filePaths).toContain("archive/pc/content/basegame_4k_hlm.archive");
  });

  test("3. Missing hard dependencies are flagged before activation", async ({ request }) => {
    const res = await request.get(`${BASE}/api/mods/conflicts?game=cyberpunk2077&modIds=206`);
    expect(res.status()).toBe(200);
    const report = await res.json();

    const missing = report.conflicts.filter((c) => c.type === "missing-dependency");
    expect(missing.length).toBe(1);
    expect(missing[0].modA).toBe("206");
    expect(missing[0].modB).toBe("202");
    expect(missing[0].message).toContain("requires");
  });

  test("4. Load order reorders persist to SQLite and read back", async ({ request }) => {
    const initial = await (
      await request.get(`${BASE}/api/mods/load-order?game=cyberpunk2077`)
    ).json();
    expect(initial.count).toBe(6);
    expect(initial.loadOrder[0].modId).toBe("201");
    expect(initial.loadOrder.map((r: any) => r.modId)).toEqual([
      "201",
      "202",
      "203",
      "204",
      "205",
      "206",
    ]);

    const reversed = ["206", "205", "204", "203", "202", "201"];
    const save = await request.put(`${BASE}/api/mods/load-order`, {
      data: { gameDomain: "cyberpunk2077", orderedModIds: reversed },
    });
    expect(save.status()).toBe(200);
    const saved = await save.json();
    expect(saved.loadOrder.map((r: any) => r.modId)).toEqual(reversed);

    const after = await (
      await request.get(`${BASE}/api/mods/load-order?game=cyberpunk2077`)
    ).json();
    expect(after.loadOrder.map((r: any) => r.modId)).toEqual(reversed);

    // Restore the default order so later tests see a clean slate.
    const restore = await request.put(`${BASE}/api/mods/load-order`, {
      data: {
        gameDomain: "cyberpunk2077",
        orderedModIds: ["201", "202", "203", "204", "205", "206"],
      },
    });
    expect(restore.ok()).toBeTruthy();
  });

  test("5. Mod hub tables round-trip through the state snapshot export/import", async ({
    request,
  }) => {
    // AI-084 (#163): export and import are admin-only (test/global-setup.ts seeds this account).
    const adminLogin = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "admin.ops@mgpl.io", password: "AdminPass2026!" },
    });
    expect(adminLogin.status()).toBe(200);
    const exportRes = await request.get(`${BASE}/api/state/export`);
    expect(exportRes.ok()).toBeTruthy();
    const snapshot = await exportRes.json();

    expect(Array.isArray(snapshot.data.modVersions)).toBe(true);
    expect(Array.isArray(snapshot.data.modDependencies)).toBe(true);
    expect(Array.isArray(snapshot.data.modLoadOrder)).toBe(true);
    expect(snapshot.data.modLoadOrder.length).toBeGreaterThan(0);
    expect(snapshot.data.modDependencies.some((d: any) => d.dependsOn === "201")).toBe(true);
    expect(snapshot.data.modVersions.length).toBeGreaterThan(0);

    // Import the same snapshot back (upsert-only, idempotent).
    const importRes = await request.post(`${BASE}/api/state/import`, { data: snapshot });
    expect(importRes.status()).toBe(200);
    const restored = await importRes.json();
    expect(restored.success).toBe(true);
    expect(restored.restored.modVersionsCount).toBeGreaterThan(0);
    expect(restored.restored.modDependenciesCount).toBeGreaterThan(0);
    expect(restored.restored.modLoadOrderCount).toBeGreaterThan(0);
  });
});

test.describe("Sprint 4 — Mods Hub 2.0 UI", () => {
  test("6. Mod detail view renders description, author, stats and dependency tree without layout shifts", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/mods`);
    await page.waitForSelector("#page-mods");
    // Search drives the deterministic mock catalog so the test is independent
    // of any Mods rows ingested by earlier specs in a serial batch run.
    await page.fill("#mods-search-input", "REDscript");
    await page.click("#btn-mods-search");
    await expect(page.locator('[data-mod-details="202"]')).toBeVisible({ timeout: 10000 });

    const listBoxBefore = await page.evaluate(() => {
      const r = document.getElementById("mods-list-container").getBoundingClientRect();
      return { x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height };
    });

    // Open the detail drawer for REDscript Framework (mod 202).
    await page.click('[data-mod-details="202"]');
    await expect(page.locator("#mod-detail-drawer")).toBeVisible();
    await expect(page.locator("#mod-detail-title")).toContainText("REDscript Framework");
    // Author handle is masked (privacy-minimized) and the raw handle is absent.
    await expect(page.locator("#mod-detail-author")).toContainText("•");
    await expect(page.locator("#mod-detail-author")).not.toContainText("jacobsen");

    // Stats bar renders three metric tiles.
    await expect(page.locator("#mod-detail-stats .text-sm")).toHaveCount(3);

    // Description tab shows the long description.
    await expect(page.locator("#mod-detail-description")).toContainText("compiler and runtime");

    // Changelog tab lists version history.
    await page.click("#mod-detail-tab-changelog");
    await expect(page.locator("#mod-detail-changelog")).toBeVisible();
    await expect(page.locator("#mod-detail-changelog")).toContainText("v0.5.18");

    // Dependency Tree tab shows the hard CET dependency.
    await page.click("#mod-detail-tab-deps");
    await expect(page.locator("#mod-detail-deps")).toBeVisible();
    await expect(page.locator("#mod-detail-deps")).toContainText("Cyber Engine Tweaks (CET)");
    await expect(page.locator("#mod-detail-deps")).toContainText("Hard");

    // Opening the fixed drawer must not shift the underlying list layout.
    // Document coordinates (getBoundingClientRect + scrollY) make the check
    // independent of viewport scroll position; width/height may fluctuate only
    // by the body scrollbar toggling (overflow lock).
    const listBoxAfter = await page.evaluate(() => {
      const r = document.getElementById("mods-list-container").getBoundingClientRect();
      return { x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height };
    });
    expect(listBoxAfter).toBeTruthy();
    expect(Math.abs(listBoxAfter.x - listBoxBefore.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(listBoxAfter.y - listBoxBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(listBoxAfter.w - listBoxBefore.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(listBoxAfter.h - listBoxBefore.h)).toBeLessThanOrEqual(2);

    // Close via Escape.
    await page.keyboard.press("Escape");
    await expect(page.locator("#mod-detail-drawer")).toBeHidden();
  });

  test("7. Load Order Manager reorders via keyboard, persists to SQLite, and supports undo", async ({
    page,
    request,
  }) => {
    await page.goto(`${BASE}/#/mods`);
    await page.waitForSelector("#page-mods");
    await page.click("#tab-mods-installed");

    await expect(page.locator("#mods-load-order-panel")).toBeVisible();
    const rows = page.locator("#mods-load-order-list .load-order-row");
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toHaveAttribute("data-mod-id", "201");

    // Keyboard reorder: focus the first row and press ArrowDown.
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#mods-load-order-list .load-order-row").first()).toHaveAttribute(
      "data-mod-id",
      "202",
    );

    // Undo restores the previous order.
    const undoBtn = page.locator("#mods-load-order-undo");
    await expect(undoBtn).toBeEnabled();
    await undoBtn.click();
    await expect(page.locator("#mods-load-order-list .load-order-row").first()).toHaveAttribute(
      "data-mod-id",
      "201",
    );

    // Reorder again, then reload — order must be served back from SQLite.
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#mods-load-order-list .load-order-row").first()).toHaveAttribute(
      "data-mod-id",
      "202",
    );
    // Wait for the persisted PUT to acknowledge before reloading.
    await expect(page.locator("#toast-container")).toContainText("Load order saved.", {
      timeout: 10000,
    });

    await page.reload();
    await page.waitForSelector("#page-mods");
    await page.click("#tab-mods-installed");
    await expect(page.locator("#mods-load-order-list .load-order-row").first()).toHaveAttribute(
      "data-mod-id",
      "202",
      { timeout: 10000 },
    );

    // Restore the default order via API for later tests.
    const restore = await request.put(`${BASE}/api/mods/load-order`, {
      data: {
        gameDomain: "cyberpunk2077",
        orderedModIds: ["201", "202", "203", "204", "205", "206"],
      },
    });
    expect(restore.ok()).toBeTruthy();
  });

  test("8. File-level conflict warnings appear as inline badges on mod cards", async ({ page }) => {
    await page.goto(`${BASE}/#/mods`);
    await page.waitForSelector("#page-mods");
    // Search "City" returns the deterministic mock cards for 203, 204 and 205
    // regardless of catalog rows ingested by earlier specs in a batch run.
    await page.fill("#mods-search-input", "City");
    await page.click("#btn-mods-search");
    await expect(page.locator('.mod-card[data-mod-id="203"]')).toBeVisible({ timeout: 10000 });

    // HD Reworked (203) and Nova City Lighting (204) share a content archive.
    await expect(page.locator('.mod-card[data-mod-id="203"] .mod-conflict-badge')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('.mod-card[data-mod-id="204"] .mod-conflict-badge')).toBeVisible();
    // A non-conflicting mod (201) must not carry the badge.
    await expect(page.locator('.mod-card[data-mod-id="201"] .mod-conflict-badge')).toHaveCount(0);
  });
});
