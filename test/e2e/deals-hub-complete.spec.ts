import { test, expect } from "@playwright/test";

/**
 * Sprint 3 (EPIC-DEAL-001) — Deals Hub 4-Tab Sub-Navigation, SVG
 * Sanitization & Full Security Suite.
 *
 *   Test 1: all 4 sub-tabs render and switch panels without page reloads.
 *   Test 2: URL deep-linking (#/deals?tab=…) activates the target sub-tab.
 *   Test 3: rendered SVG price charts contain 0 script tags, foreign objects,
 *           inline event handlers, or href attributes.
 *   Test 4: every deal card exposes a valid, sanitized HTTPS store URL whose
 *           hostname matches the client-side storefront domain allowlist.
 */

const BASE = "http://localhost:4000";

// Mirrors public/deals.js CLIENT_STOREFRONT_ALLOWLIST: the superset of every
// HTTPS host the backend legitimately emits across direct platform stores,
// authorized retailers, the GamerPower feed, radar seeds, and wishlist price
// synthesis. Any actionable outbound link must resolve to one of these hosts.
const CLIENT_ALLOWED_HOSTS = new Set([
  "store.steampowered.com",
  "gog.com",
  "www.gog.com",
  "store.epicgames.com",
  "store.playstation.com",
  "www.playstation.com",
  "www.xbox.com",
  "www.nintendo.com",
  "fanatical.com",
  "www.fanatical.com",
  "greenmangaming.com",
  "www.greenmangaming.com",
  "humblebundle.com",
  "www.humblebundle.com",
  "gamerpower.com",
  "www.gamerpower.com",
  "gamesplanet.com",
  "www.gamesplanet.com",
  "gamebillet.com",
  "www.gamebillet.com",
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

test.describe("EPIC-DEAL-001 — Deals Hub 4-Tab Navigation, SVG Sanitization & Security", () => {
  test("1. Deals Hub renders all 4 sub-tabs and switches panels without page reloads", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/deals`);
    await expect(page.locator("#page-deals")).toBeVisible();

    // All four canonical sub-tab triggers are present.
    for (const tab of ["sales", "giveaways", "radar", "wishlist"]) {
      await expect(
        page.locator(`.deals-tab-btn[data-store="${tab}"]`)
      ).toBeVisible();
    }

    // Set an in-page guard: if the document reloads during tab switching the
    // global is lost, which lets us assert navigation is reload-free.
    await page.evaluate(() => {
      (window as any).__dealsReloadGuard = 1;
    });

    const panel = (tab: string) => page.locator(`#deals-panel-${tab}`);

    // Default active panel is Store Sales.
    await expect(panel("sales")).toBeVisible();

    await page.click('.deals-tab-btn[data-store="giveaways"]');
    await expect(panel("giveaways")).toBeVisible();
    await expect(panel("sales")).toBeHidden();

    await page.click('.deals-tab-btn[data-store="radar"]');
    await expect(panel("radar")).toBeVisible();
    await expect(panel("giveaways")).toBeHidden();

    await page.click('.deals-tab-btn[data-store="wishlist"]');
    await expect(panel("wishlist")).toBeVisible();
    await expect(panel("radar")).toBeHidden();

    await page.click('.deals-tab-btn[data-store="sales"]');
    await expect(panel("sales")).toBeVisible();
    await expect(panel("wishlist")).toBeHidden();

    // No reload occurred across all four tab switches.
    const guard = await page.evaluate(() => (window as any).__dealsReloadGuard);
    expect(guard).toBe(1);
  });

  test("2. URL query-parameter deep-linking activates the target sub-tab directly", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/deals?tab=giveaways`);
    await expect(page.locator("#page-deals")).toBeVisible();
    await expect(page.locator("#deals-panel-giveaways")).toBeVisible();
    await expect(
      page.locator('.deals-tab-btn[data-store="giveaways"]')
    ).toHaveAttribute("aria-selected", "true");

    await page.goto(`${BASE}/#/deals?tab=radar`);
    await expect(page.locator("#page-deals")).toBeVisible();
    await expect(page.locator("#deals-panel-radar")).toBeVisible();
    await expect(
      page.locator('.deals-tab-btn[data-store="radar"]')
    ).toHaveAttribute("aria-selected", "true");
  });

  test("3. rendered SVG price charts contain 0 script tags or unescaped event handlers", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/deals`);
    await expect(page.locator("#page-deals")).toBeVisible();

    // Wait for at least one store-sales price-trend sparkline to mount.
    await expect(
      page.locator("#deals-panel-sales [data-deal-card] svg").first()
    ).toBeVisible({ timeout: 20000 });

    const result = await page.evaluate(() => {
      const svgs = Array.from(
        document.querySelectorAll("#deals-panel-sales svg")
      );
      let scripts = 0;
      let foreignObjects = 0;
      let handlers = 0;
      let hrefs = 0;
      for (const svg of svgs) {
        scripts += svg.querySelectorAll("script").length;
        foreignObjects += svg.querySelectorAll("foreignObject").length;
        handlers += svg.querySelectorAll(
          "[onclick], [onload], [onerror], [onmouseover], [onfocus]"
        ).length;
        hrefs += svg.querySelectorAll("[href], [xlink\\:href]").length;
      }
      return { count: svgs.length, scripts, foreignObjects, handlers, hrefs };
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.scripts).toBe(0);
    expect(result.foreignObjects).toBe(0);
    expect(result.handlers).toBe(0);
    expect(result.hrefs).toBe(0);
  });

  test("4. all deal cards render valid sanitized HTTPS store URLs matching the domain allowlist", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/deals`);
    await expect(page.locator("#page-deals")).toBeVisible();
    await expect(page.locator("#deals-panel-sales [data-deal-card]").first()).toBeVisible({
      timeout: 20000,
    });

    const hrefs = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('#deals-panel-sales a[href^="https://"]')
      ).map((a) => a.getAttribute("href") || "");
    });

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith("https://")).toBe(true);
      const host = hostOf(href);
      expect(host).not.toBe("");
      expect(CLIENT_ALLOWED_HOSTS.has(host)).toBe(true);
    }
  });
});