import { test, expect, runAxeScan } from "../fixtures";


const BASE = "http://localhost:4000";

/**
 * Sprint 33 (FEAT-0167-THEME-A11Y-PWA) â€” Custom Theme Engine, WCAG AA Keyboard
 * Navigation & PWA Install Engine.
 *
 * Test 1: Navigate to Settings, switch themes; verify data-theme updates on
 *         <html> and the CSS custom properties apply.
 * Test 2: Simulate beforeinstallprompt; verify the #pwa-install-banner displays
 *         and responds to the install trigger.
 * Test 3: Full keyboard nav â€” open/close the game detail drawer and command
 *         palette via keyboard without losing focus (focus trap + restore).
 * Test 4: Axe-core scan reports zero violations across all four themes.
 */

// Type augmentation for the client-side theme/PWA/focus helpers exposed by app.js.
declare global {
  interface Window {
    setTheme?: (name: string) => Promise<void>;
    getTheme?: () => string;
    __simulateBeforeInstallPrompt?: () => void;
    saveFocus?: () => void;
    restoreFocus?: () => void;
    trapFocus?: (container: HTMLElement, e: KeyboardEvent) => void;
    openGameDetailDrawer?: (title: string, gameId?: string) => void;
    closeGameDetailDrawer?: () => void;
    openCommandPalette?: () => void;
    closeCommandPalette?: () => void;
  }
}

test.describe("Sprint 33 (FEAT-0167-THEME-A11Y-PWA) - Theme Engine, A11y & PWA Install", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/#/settings`);
    await page.waitForSelector("#page-settings");
    // The settings hub wires the Theme & Appearance controls on route load.
    await expect(page.locator("#theme-switcher")).toBeVisible();
  });

  test("1. Theme switcher updates data-theme and applies CSS custom properties", async ({ page }) => {
    // The theme engine exposes setTheme/getTheme on window.
    await page.waitForFunction(() => typeof window.setTheme === "function");

    const themes = ["oled", "cyberpunk", "retro", "contrast"];

    for (const theme of themes) {
      // Select the theme via the radio group.
      await page.locator(`input[name="theme"][value="${theme}"]`).check({ force: true });

      // data-theme on <html> reflects the selection.
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      // getTheme() returns the persisted selection.
      const stored = await page.evaluate(() => {
        return typeof window.getTheme === "function" ? window.getTheme() : null;
      });
      expect(stored).toBe(theme);


      // The CSS custom property --bg-primary is defined and non-empty for the theme.
      const bg = await page.evaluate((t) => {
        const html = document.documentElement;
        html.setAttribute("data-theme", t);
        return getComputedStyle(html).getPropertyValue("--bg-primary").trim();
      }, theme);
      expect(bg.length).toBeGreaterThan(0);

      // The theme status element reflects the active theme.
      await expect(page.locator("#theme-status")).toContainText(theme, { ignoreCase: true });
    }

    // The "system" option resolves to a concrete theme (dark/light) and persists.
    await page.locator('input[name="theme"][value="system"]').check({ force: true });
    const resolved = await page.evaluate(() => {
      const html = document.documentElement;
      return html.getAttribute("data-theme");
    });
    expect(["oled", "cyberpunk", "retro", "contrast", "light"]).toContain(resolved);
  });

  test("2. PWA install engine handles beforeinstallprompt without a top banner", async ({ page }) => {
    // EPIC-UX-REFINE-0001: the top-of-page install banner and the Settings
    // install card were pruned from the home/settings surfaces. Simulating
    // the native beforeinstallprompt must remain non-destructive and must NOT
    // resurrect the removed #pwa-install-banner element.
    await page.evaluate(() => {
      if (typeof window.__simulateBeforeInstallPrompt === "function") {
        window.__simulateBeforeInstallPrompt();
      }
    });

    await page.waitForTimeout(300);

    // The removed banner/status elements never appear.
    await expect(page.locator("#pwa-install-banner")).toHaveCount(0);
    await expect(page.locator("#btn-pwa-install")).toHaveCount(0);

    // The theme engine still functions after the simulated prompt.
    await page.locator('input[name="theme"][value="contrast"]').check({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
  });

  test("3. Keyboard navigation traps focus in drawer and palette, then restores it", async ({ page }) => {
    // Focus a known element on the page (the theme switcher heading area).
    await page.locator("#theme-switcher").focus();

    // --- Command palette ---
    await page.keyboard.press("Control+k");
    await expect(page.locator("#command-palette")).toBeVisible();
    await expect(page.locator("#command-palette-input")).toBeFocused();

    // Escape closes the palette and restores focus to the previously focused element.
    await page.keyboard.press("Escape");
    await expect(page.locator("#command-palette")).toBeHidden();
    await expect(page.locator("#theme-switcher")).toBeFocused();

    // --- Game detail drawer ---
    // Open the drawer via the exposed hook (simulates a game-card click).
    await page.evaluate(() => {
      if (typeof window.openGameDetailDrawer === "function") {
        window.openGameDetailDrawer("Skyrim");
      }
    });
    await expect(page.locator("#game-detail-drawer")).toBeVisible();

    // Focus moves into the drawer (close button).
    await expect(page.locator("#game-detail-close")).toBeFocused();

    // Escape closes the drawer and restores focus to the previously focused element.
    await page.keyboard.press("Escape");
    await expect(page.locator("#game-detail-drawer")).toBeHidden();
    await expect(page.locator("#theme-switcher")).toBeFocused();
  });

  test("4. Zero accessibility violations across all four themes", async ({ page }) => {
    const themes = ["oled", "cyberpunk", "retro", "contrast"];

    for (const theme of themes) {
      await page.locator(`input[name="theme"][value="${theme}"]`).check({ force: true });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      // Run a local axe-core accessibility audit scoped to the settings page.
      const results = await runAxeScan(page, { selector: "#page-settings" });

      expect(results.error).toBeNull();
      expect(results.violations).toEqual([]);
    }
  });

});
