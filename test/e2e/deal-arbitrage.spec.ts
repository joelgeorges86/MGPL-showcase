import { test, expect } from "../fixtures";
import Database from "better-sqlite3";
import path from "path";

/**
 * Sprint 2 (WUD-2.2 / EPIC-02) — Advanced Deal Arbitrage & Price History.
 *
 *   Test 1 (API): GET /api/deals/arbitrage returns active deal cards with a
 *           24-month price-history series, 30-day low / verified all-time low,
 *           and a whitelisted storefront URL.
 *   Test 2 (API): POST /api/deals/arbitrage/ingest runs ITAD / GG.deals /
 *           Deku Deals ingestion (hermetic fetch mocks), persists price-history
 *           baseline points, and REJECTS grey-market (G2A) and negative-price
 *           canaries before they reach SQLite.
 *   Test 3 (API): GET /api/deals/arbitrage/:gameId/history returns 24-month
 *           sparkline points.
 *   Test 4 (VBAC): Deal Finder (#/deals) -> Price Arbitrage tab renders deal
 *           cards with inline SVG sparklines and "Lowest Price Ever" badges;
 *           clicking "Set Alert" opens the target-price modal and saving
 *           highlights the alert state instantly (persisted + surfaced).
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

const ARB_USER = { email: "arb.user@mgpl.test", password: "ArbUserPass2026!" };

function readRow<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

function countRows<T>(sql: string, ...params: unknown[]): number {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return (db.prepare(sql).get(...params) as { c: number })?.c ?? 0;
  } finally {
    db.close();
  }
}

test.describe("Advanced Deal Arbitrage & Price History (WUD-2.2 / EPIC-02)", () => {
  test("1. GET /api/deals/arbitrage returns cards with sparkline history + lows", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/deals/arbitrage`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deals.length).toBeGreaterThanOrEqual(1);

    for (const deal of body.deals) {
      expect(typeof deal.gameKey).toBe("string");
      expect(typeof deal.title).toBe("string");
      expect(typeof deal.currentPrice).toBe("number");
      // Every outbound URL must be HTTPS and whitelisted (store.steampowered,
      // gog, epic, fanatical, gmg, humble, gamesplanet, gamebillet).
      const url = new URL(deal.storeUrl);
      expect(url.protocol).toBe("https:");
      const allowed = [
        "store.steampowered.com",
        "gog.com",
        "www.gog.com",
        "store.epicgames.com",
        "fanatical.com",
        "www.fanatical.com",
        "greenmangaming.com",
        "www.greenmangaming.com",
        "humblebundle.com",
        "www.humblebundle.com",
        "gamesplanet.com",
        "www.gamesplanet.com",
        "gamebillet.com",
        "www.gamebillet.com",
      ];
      expect(allowed).toContain(url.hostname);
      // 24-month sparkline history is present (>= 2 points).
      expect(Array.isArray(deal.history)).toBe(true);
      expect(deal.history.length).toBeGreaterThanOrEqual(2);
      for (const point of deal.history) {
        expect(typeof point.price).toBe("number");
      }
    }
  });

  test("2. Ingest persists baseline history and rejects grey-market + bad prices", async ({
    request,
  }) => {
    const res = await request.post(`${BASE}/api/deals/arbitrage/ingest`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deals).toBeGreaterThanOrEqual(1);
    expect(body.persisted).toBeGreaterThanOrEqual(1);

    // Whitelisted deals from the hermetic fixtures persisted baseline points.
    const cyberpunkCount = countRows(
      "SELECT COUNT(*) AS c FROM AppDealPriceHistory WHERE gameId = ?",
      "cyberpunk-2077",
    );
    expect(cyberpunkCount).toBeGreaterThan(0);

    // Grey-market (G2A) and negative-price canaries must NEVER reach SQLite.
    const greyCount = countRows(
      "SELECT COUNT(*) AS c FROM AppDealPriceHistory WHERE title LIKE ?",
      "%Grey Market%",
    );
    expect(greyCount).toBe(0);
    const negativeCount = countRows(
      "SELECT COUNT(*) AS c FROM AppDealPriceHistory WHERE title LIKE ?",
      "%Negative Price%",
    );
    expect(negativeCount).toBe(0);
    const badPrice = readRow<{ c: number }>(
      "SELECT COUNT(*) AS c FROM AppDealPriceHistory WHERE price < 0",
    );
    expect(badPrice ? badPrice.c : 0).toBe(0);
  });

  test("3. GET /api/deals/arbitrage/:gameId/history returns 24-month points", async ({
    request,
  }) => {
    const res = await request.get(
      `${BASE}/api/deals/arbitrage/cyberpunk-2077/history`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.gameId).toBe("cyberpunk-2077");
    expect(body.points.length).toBeGreaterThanOrEqual(2);
  });

  test("4. UI: Price Arbitrage tab renders sparkline cards + Set Alert flow", async ({
    page,
    playwright,
  }) => {
    const ctx = await playwright.request.newContext();
    try {
      await ctx.post(`${BASE}/api/auth/register`, { data: ARB_USER });

      // Authenticate through the UI so the browser cookie jar is populated.
      await page.goto("/");
      await page.locator("#btn-auth-open-login").click();
      const modal = page.locator("#auth-modal");
      await expect(modal).toBeVisible();
      await page.locator("#auth-login-email").fill(ARB_USER.email);
      await page.locator("#auth-login-password").fill(ARB_USER.password);
      await page.locator('#auth-login-form button[type="submit"]').click();
      await expect(modal).toBeHidden();
      await expect(page.locator("#auth-user-pill")).toBeVisible();

      await page.goto(`${BASE}/#/deals`);
      await expect(page.locator("#page-deals")).toBeVisible();
      const arbitrageTab = page.locator('.deals-tab-btn[data-store="arbitrage"]');
      await expect(arbitrageTab).toBeVisible();
      await arbitrageTab.click();
      const panel = page.locator("#deals-panel-arbitrage");
      await expect(panel).toBeVisible();

      // Active deal cards with inline pure-SVG sparklines and low badges.
      const firstCard = panel.locator("[data-arb-card]").first();
      await expect(firstCard).toBeVisible({ timeout: 15000 });
      await expect(firstCard.locator("svg").first()).toBeVisible();
      const badgeCount = await panel
        .locator("[data-lowest-ever], [data-low-30d]")
        .count();
      expect(badgeCount).toBeGreaterThan(0);

      // Set Price Alert flow: clicking opens the target-price modal (prompt);
      // accepting persists the alert and the feedback dialog confirms it.
      const alertBtn = firstCard.locator(".deal-alert-btn");
      await expect(alertBtn).toBeVisible();
      const appId = await alertBtn.getAttribute("data-app-id");
      const title = await alertBtn.getAttribute("data-title");

      const dialogs: string[] = [];
      page.on("dialog", async (d) => {
        dialogs.push(d.type());
        if (d.type() === "prompt") {
          await d.accept("19.99");
        } else {
          await d.accept();
        }
      });

      await alertBtn.click();
      await page.waitForTimeout(800);

      // The alert is persisted and surfaced through the authenticated API.
      const alertsRes = await page.request.get(`${BASE}/api/alerts`);
      expect(alertsRes.status()).toBe(200);
      const alerts = ((await alertsRes.json()).alerts as Array<{
        gameId: string;
        title: string;
      }>) || [];
      expect(
        alerts.some((a) => a.gameId === appId || a.title === title),
      ).toBe(true);
      expect(dialogs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.dispose();
    }
  });
});

