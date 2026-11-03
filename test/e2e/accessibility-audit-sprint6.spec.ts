import { test, expect, runAxeScan } from "../fixtures";

const BASE = "http://localhost:4000";

/**
 * Sprint 6 (PI-GTM-2026-001) — Final WCAG 2.1 AA Program Closeout Audit.
 *
 * Closes the two remaining audit gaps from the Sprint 3 sweep:
 *   1. The Mods drawer (#mods-drawer) was never axe-scanned and lacked
 *      keyboard focus trapping / focus restoration (WCAG 2.1.2 / 2.4.3).
 *   2. The Compare matrix was only scanned pre-benchmark — the rendered
 *      matrix table itself is audited here.
 *
 * WUD surfaces: Game Tab (library), Compare matrix, Mods drawer, Retro Hub,
 * Analytics tab. Game Tab / Retro Hub / Analytics tab are already scanned in
 * accessibility-audit.spec.ts / retro-hub.spec.ts / analytics-visualizer.spec.ts;
 * this spec adds the two missing surfaces plus an ARIA contract sweep.
 *
 * color-contrast / region / landmark-unique / page-has-heading-one stay
 * disabled to match the suite-wide convention (documented in fixtures.ts).
 */
test.describe("Sprint 6 (PI-GTM-2026-001) - WCAG 2.1 AA Final Audit", () => {
  const DISABLED_RULES = [
    "color-contrast",
    "region",
    "landmark-unique",
    "page-has-heading-one",
  ];

  async function assertNoSeriousOrCritical(result: {
    error: string | null;
    violations: Array<{ impact?: string | null }>;
  }) {
    expect(result.error).toBeNull();
    const seriousOrCritical = (result.violations || []).filter((v) =>
      ["serious", "critical"].includes(v.impact || "")
    );
    expect(seriousOrCritical).toEqual([]);
  }

  test("1. Mods drawer opens with dialog semantics, moves focus inside, and has zero serious/critical axe violations", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector("#page-library");

    // Focus a known element so we can assert focus moves into the dialog.
    await page.locator("#command-search-input").focus();
    await page.evaluate(() => {
      (window as any).openModsDrawer("Elden Ring", "elden-ring");
    });

    const drawer = page.locator("#mods-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await expect(drawer).toHaveAttribute("aria-label", "Community Mods");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
    // Focus moves into the dialog on open (WCAG 2.4.3 Focus Order).
    await expect(page.locator("#mods-drawer-close")).toBeFocused();

    const result = await runAxeScan(page, {
      selector: "#mods-drawer",
      disableRules: DISABLED_RULES,
    });
    await assertNoSeriousOrCritical(result);
  });

  test("2. Mods drawer traps Tab navigation and restores focus on Escape", async ({ page }: { page: any }) => {
    const trigger = page.locator("#command-search-input");
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector("#page-library");
    await trigger.focus();

    await page.evaluate(() => {
      (window as any).openModsDrawer("Elden Ring", "elden-ring");
    });
    const drawer = page.locator("#mods-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.locator("#mods-drawer-close")).toBeFocused();

    // Move focus to the last visible focusable inside the dialog, then Tab:
    // the trap must cycle back to the first focusable instead of escaping the
    // overlay. Hidden (display:none) controls are skipped, matching the
    // browser's default Tab order and the trap helper's visible-filter.
    const lastFocusable = await drawer.evaluate((el: HTMLElement) => {
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((f) => f.getClientRects().length > 0);
      if (focusables.length === 0) return null;
      focusables[focusables.length - 1].focus();
      return focusables[focusables.length - 1].id || focusables[focusables.length - 1].tagName;
    });
    expect(lastFocusable).toBeTruthy();

    await page.keyboard.press("Tab");
    await expect(page.locator("#mods-drawer-close")).toBeFocused();

    // Shift+Tab from the first focusable must wrap to the last focusable.
    await page.keyboard.press("Shift+Tab");
    const backToLast = await drawer.evaluate((el: HTMLElement) => {
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((f) => f.getClientRects().length > 0);
      return document.activeElement === focusables[focusables.length - 1];
    });
    expect(backToLast).toBeTruthy();

    // Escape closes the drawer and returns focus to the triggering element.
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("3. Rendered compare matrix has zero serious/critical axe violations and semantic table structure", async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/compare`);
    await page.waitForSelector("#page-compare");
    // Wait for the device select to populate.
    await page.waitForFunction(() => {
      const select = document.getElementById("compare-device-select") as HTMLSelectElement | null;
      return !!select && select.options.length > 1;
    }, { timeout: 15000 });

    // Select two games and render the comparison matrix.
    await page.locator("#compare-select-trigger").click();
    const boxes = page.locator("#compare-games-list .compare-game-checkbox");
    await expect(boxes.first()).toBeVisible({ timeout: 15000 });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.locator("#compare-select-trigger").click();
    await expect(page.locator("#matrix-body")).toBeVisible({ timeout: 20000 });

    // Semantic table structure: a real header row exists for screen readers.
    const headerCells = page.locator("#matrix-header-row th");
    const headerCount = await headerCells.count();
    expect(headerCount).toBeGreaterThanOrEqual(2);

    const result = await runAxeScan(page, {
      selector: "#page-compare",
      disableRules: DISABLED_RULES,
    });
    await assertNoSeriousOrCritical(result);
  });

  test("4. ARIA contract sweep across the WUD surfaces (aria-live / aria-expanded / aria-pressed)", async ({ page }: { page: any }) => {
    // Game Tab: the global live region announces state changes; the genre
    // dropdown exposes aria-expanded toggle state.
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector("#page-library");
    await expect(page.locator("#a11y-live-region")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#library-genre-dropdown-btn")).toHaveAttribute(
      "aria-expanded",
      /true|false/
    );

    // Compare: target device specs region carries an accessible label; the
    // "show all" toggle exposes aria-expanded.
    await page.goto(`${BASE}/#/compare`);
    await page.waitForSelector("#page-compare");
    await expect(page.locator("#compare-target-device-specs")).toHaveAttribute(
      "aria-label",
      /.+/
    );
    await expect(page.locator("#compare-show-all")).toHaveAttribute("aria-expanded", /true|false/);

    // Retro Hub: patch + runner status regions announce progress; the ROM
    // dropzone carries a descriptive accessible label.
    await page.goto(`${BASE}/#/retro`);
    await page.waitForSelector("#page-retro");
    await expect(page.locator("#retro-patch-status")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#retro-runner-status")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#retro-rom-dropzone")).toHaveAttribute("aria-label", /.+/);
  });
});
