import { test, expect } from "@playwright/test";
import path from "path";
import Database from "better-sqlite3";

/**
 * Sprint 6.1 (PI-GTM-2026-001) — Hardened Remediation & Stability Patch.
 *
 * Targeted regression suite for GAP-001..GAP-006:
 *   1. GAP-001: DPM health endpoint sanitized payload (no metadata leak).
 *   2. GAP-001: DPM health 5 req/sec rate limiter.
 *   3. GAP-003/004: Trending mods fallback + non-null metadata counts.
 *   4. GAP-003: Read-time whitelist suppresses inactive/non-compliant listings.
 *   5. GAP-006: Compare matrix safeValue enforcement (no HTML injection leak).
 *   6. GAP-002: Palette CSS custom-property self-healing through strict sanitizer.
 *   7. GAP-003: Mods aggregation status endpoint contract.
 *   8. Shared safety stack: safeToastError strips stack traces/paths/secrets.
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

test.describe("Sprint 6.1 — Hardened Remediation & Stability (GAP-001..006)", () => {
  test("1. GAP-001: /api/dpm/health returns a sanitized payload", async ({ request }) => {
    const res = await request.get(`${BASE}/api/dpm/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(body.uptime).toBeUndefined();
    expect(body.version).toBeUndefined();
    expect(body.database).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("C:\\");
  });

  test("2. GAP-001: DPM health enforces a 5 req/sec rate limiter", async ({ request }) => {
    let saw429 = false;
    for (let i = 0; i < 6; i += 1) {
      const res = await request.get(`${BASE}/api/dpm/health`);
      if (res.status() === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  test("3. GAP-003/004: trending mods return non-null metadata with a fallback source", async ({ request }) => {
    const res = await request.get(`${BASE}/api/mods/trending?game=skyrimspecialedition`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.mods)).toBe(true);
    expect(["catalog", "most-recently-added", "mock"]).toContain(body.source);
    for (const m of body.mods) {
      expect(typeof m.downloads).toBe("number");
      expect(m.downloads).toBeGreaterThanOrEqual(0);
      expect(typeof m.modName).toBe("string");
      expect(typeof m.version).toBe("string");
    }
  });

  test("4. GAP-003: read-time whitelist suppresses inactive/non-compliant listings", async ({ request }) => {
    const modName = `RemediationSweepMod_${Date.now()}`;
    const ingest = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName,
        sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/999",
      },
    });
    expect(ingest.status()).toBe(200);

    // Mirror the mod-link-sweep outcome: flip the row inactive + corrupt the URL.
    const db = new Database(TEST_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.prepare(
      'UPDATE "Mods" SET is_active = 0, sourceUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE gameId = ? AND modName = ?',
    ).run("https://evil.example.com/mods/x", "G00001", modName);
    db.close();

    const listings = await request.get(`${BASE}/api/mods/listings?game=G00001`);
    expect(listings.status()).toBe(200);
    const body = await listings.json();
    expect(body.mods.some((m: any) => m.modName === modName)).toBe(false);
  });

  test("5. GAP-006: compare matrix enforces safeValue on string cells", async ({ request }) => {
    const res = await request.get(`${BASE}/api/compare?ids=G00001,G00002`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.comparison)).toBe(true);
    for (const g of body.comparison) {
      expect(typeof g.gameId).toBe("string");
      if (g.title) expect(g.title).not.toMatch(/<script/i);
      if (g.developer) expect(g.developer).not.toMatch(/javascript:/i);
      expect(Array.isArray(g.genres)).toBe(true);
      expect(typeof g.activeModCount).toBe("number");
      expect(g.activeModCount).toBeGreaterThanOrEqual(0);
    }
  });

  test("6. GAP-002: palette CSS custom properties self-heal through the strict sanitizer", async ({ page }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    const result = await page.evaluate(() => {
      const bg = window.safeCSSVar("--bg-primary", "");
      const badUrl = window.sanitizeCSSVarValue("url(https://evil.example.com/x.png)", "fallback");
      const badChain = window.sanitizeCSSVarValue("var(--other)", "fallback");
      const badType = window.sanitizeCSSVarValue(42, "fallback");
      const html = document.documentElement.getAttribute("data-theme");
      return { bg, badUrl, badChain, badType, html };
    });
    expect(result.bg.length).toBeGreaterThan(0);
    expect(result.badUrl).toBe("fallback");
    expect(result.badChain).toBe("fallback");
    expect(result.badType).toBe("fallback");
  });

  test("7. GAP-003: mods aggregation status endpoint contract", async ({ request }) => {
    const res = await request.get(`${BASE}/api/mods/aggregation/status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.stalled).toBe("boolean");
    expect(body.message).toBeTruthy();
  });

  test("8. safeToastError strips stack traces, internal paths and secrets", async ({ page }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    const result = await page.evaluate(() => {
      const raw =
        "boom at C:\\Users\\joelg\\OneDrive\\PC Build\\MGPL\\src\\routes\\mods.ts:25:9\n" +
        "    at fn (file:///app/src/routes/mods.ts:25:9) token=super-secret-abc123";
      const clean = window.safeToastError(raw);
      return { clean, raw };
    });
    expect(result.clean).not.toContain("joelg");
    expect(result.clean).not.toContain("mods.ts");
    expect(result.clean).not.toContain("file://");
    expect(result.clean).not.toContain("super-secret");
    expect(result.clean.length).toBeLessThanOrEqual(240);
  });
});
