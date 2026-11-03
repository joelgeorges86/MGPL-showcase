import { test, expect } from "@playwright/test";
import path from "path";
import Database from "better-sqlite3";
import { ALEX, LEADERSHIP } from "../helpers/api-client";

/**
 * Sprint 5 (PI-GTM-2026-001) — EPIC-06 Mods Ecosystem Backend & EPIC-07
 * Analytics Relocation / Retro Onboarding.
 *
 * Coverage:
 *   - Mods ingestion: HTTPS-only + exact-match domain whitelist sanitization
 *     (nexusmods.com, moddb.com, curseforge.com, github.com releases,
 *     modrinth.com), sourceDomain consistency, persistence & listings read.
 *   - State snapshot portability: the Mods table round-trips through
 *     /api/state/export + /api/state/import.
 *   - Analytics role-gating: 401 unauthenticated, 403 for the standard
 *     "user" role WITH an immutable analytics_access_logs audit row, 200 for
 *     the seeded Leadership role, and append-only trigger enforcement.
 *   - UI: Analytics promoted to a top-level nav tab; Retro Hub renders the
 *     collapsible "Getting Started" onboarding panel with dismissible
 *     tooltips and versioned documentation links.
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

test.describe("Sprint 5 — Mods Ecosystem Ingestion & Analytics Role-Gating (EPIC-06 / EPIC-07)", () => {
  // -------------------------------------------------------------------------
  // Mods URL sanitization (EPIC-06)
  // -------------------------------------------------------------------------

  test("1. Mods ingest rejects http:// sourceUrl (HTTPS-only gate)", async ({ request }) => {
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: "Bad HTTP Mod",
        sourceUrl: "http://www.nexusmods.com/skyrimspecialedition/mods/101",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("https");
  });

  test("2. Mods ingest rejects a non-whitelisted domain", async ({ request }) => {
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: "Evil Mod",
        sourceUrl: "https://evil.example.com/mods/1",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("whitelist");
  });

  test("3. Mods ingest restricts github.com to release asset paths", async ({ request }) => {
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: "Repo Link",
        sourceUrl: "https://github.com/joelgeorges86/MGPL",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("releases");
  });

  test("4. Mods ingest rejects a mismatched sourceDomain label", async ({ request }) => {
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: "Mismatch",
        sourceDomain: "curseforge.com",
        sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/101",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not match");
  });

  test("5. Mods ingest persists a whitelisted HTTPS URL and listings read it back", async ({
    request,
  }) => {
    const ingest = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: "SkyUI Sprint5",
        author: "skyui_team",
        sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/3863",
        downloads: 14200000,
        version: "5.2SE",
        minVramGb: 2,
        minRamGb: 8,
      },
    });
    expect(ingest.status()).toBe(200);
    const ingestBody = await ingest.json();
    expect(ingestBody.success).toBe(true);
    expect(ingestBody.mod.sourceDomain).toBe("nexusmods.com");

    const listings = await request.get(`${BASE}/api/mods/listings?game=G00001`);
    expect(listings.status()).toBe(200);
    const listBody = await listings.json();
    expect(listBody.count).toBeGreaterThan(0);
    const found = listBody.mods.find((m: any) => m.modName === "SkyUI Sprint5");
    expect(found).toBeTruthy();
    expect(found.sourceUrl).toBe("https://www.nexusmods.com/skyrimspecialedition/mods/3863");
    expect(found.sourceDomain).toBe("nexusmods.com");
    expect(found.downloads).toBe(14200000);
  });

  test("6. Mods table round-trips through the state snapshot export/import", async ({
    request,
  }) => {
    const ingest = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00002",
        modName: "RoundTripMod",
        sourceUrl: "https://modrinth.com/mod/sodium",
      },
    });
    expect(ingest.status()).toBe(200);

    // AI-084 (#163): export and import are admin-only (test/global-setup.ts seeds this account).
    const adminLogin = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "admin.ops@mgpl.io", password: "AdminPass2026!" },
    });
    expect(adminLogin.status()).toBe(200);
    const exp = await request.get(`${BASE}/api/state/export`);
    expect(exp.status()).toBe(200);
    const snapshot = await exp.json();
    expect(Array.isArray(snapshot.data.modCatalog)).toBe(true);
    const found = snapshot.data.modCatalog.find((m: any) => m.modName === "RoundTripMod");
    expect(found).toBeTruthy();
    expect(found.sourceDomain).toBe("modrinth.com");

    // Re-import the same snapshot (idempotent upsert) and verify no data loss.
    const imp = await request.post(`${BASE}/api/state/import`, { data: snapshot });
    expect(imp.status()).toBe(200);
    const impBody = await imp.json();
    expect(impBody.success).toBe(true);
    expect(impBody.restored.modsCatalogCount).toBeGreaterThan(0);

    const listings = await request.get(`${BASE}/api/mods/listings?game=G00002`);
    const listBody = await listings.json();
    expect(listBody.mods.some((m: any) => m.modName === "RoundTripMod")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Analytics role-gating + audit logging (EPIC-07)
  // -------------------------------------------------------------------------

  test("7. Analytics API returns 401 for unauthenticated requests", async ({ request }) => {
    const res = await request.get(`${BASE}/api/analytics/summary`);
    expect(res.status()).toBe(401);
  });

  test("8. Analytics denies the standard user role with 403 and writes an audit log", async ({
    request,
  }) => {
    const login = await request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);

    const res = await request.get(`${BASE}/api/analytics/summary`);
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Forbidden");

    // The denied attempt must be appended to the immutable audit table.
    const db = new Database(TEST_DB_PATH);
    db.pragma("journal_mode = WAL");
    try {
      const row = db
        .prepare(
          `SELECT * FROM "analytics_access_logs"
           WHERE userId = ? AND outcome = 'denied' AND route LIKE '%/api/analytics/summary%'
           ORDER BY id DESC LIMIT 1`,
        )
        .get("auth-user-alex-gamer") as any;
      expect(row).toBeTruthy();
      expect(row.role).toBe("user");
      expect(String(row.reason)).toContain("role_not_allowed");
    } finally {
      db.close();
    }
  });

  test("9. Analytics grants the authorized Leadership role", async ({ request }) => {
    const login = await request.post(`${BASE}/api/auth/login`, { data: LEADERSHIP });
    expect(login.status()).toBe(200);

    const res = await request.get(`${BASE}/api/analytics/summary`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.genres)).toBe(true);
    expect(Array.isArray(body.platforms)).toBe(true);
    expect(body.velocity).toBeTruthy();
  });

  test("10. analytics_access_logs is immutable (append-only triggers)", () => {
    const db = new Database(TEST_DB_PATH);
    db.pragma("journal_mode = WAL");
    const probe = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO "analytics_access_logs" (userId, role, route, method, outcome, reason)
           VALUES ('probe-user', 'user', '/api/analytics/summary', 'GET', 'denied', 'probe')`,
        )
        .run();
      const id = Number(info.lastInsertRowid);
      expect(() =>
        db.prepare(`UPDATE "analytics_access_logs" SET outcome = 'granted' WHERE id = ?`).run(id),
      ).toThrow(/append-only/);
      expect(() => db.prepare(`DELETE FROM "analytics_access_logs" WHERE id = ?`).run(id)).toThrow(
        /append-only/,
      );
      throw new Error("__epic07_rollback__");
    });
    expect(() => probe()).toThrow("__epic07_rollback__");
    db.close();
  });

  // -------------------------------------------------------------------------
  // Analytics top-level nav + Retro Hub onboarding (EPIC-07)
  // -------------------------------------------------------------------------

  test("11. Analytics is a top-level nav tab and Retro Hub renders the onboarding panel", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");

    // Analytics is a nav dropdown trigger; opening it reveals the Analytics
    // link and the relocated Backlog tracking view.
    const analyticsTrigger = page
      .locator("nav button.nav-dropdown-trigger", { hasText: "Analytics" })
      .first();
    await expect(analyticsTrigger).toBeVisible();
    await analyticsTrigger.click();
    const analyticsLink = page.locator('nav a[data-route="analytics"]').first();
    await expect(analyticsLink).toBeVisible();
    await expect(analyticsLink).toContainText("Analytics");

    // Backlog now routes as an analytics/tracking view under the same dropdown.
    const backlogLink = page.locator('nav a[data-route="backlog"]').first();
    await expect(backlogLink).toBeVisible();
    await expect(backlogLink).toContainText("Backlog");

    // Navigate to Retro Hub and verify the collapsible onboarding panel.
    await page.goto(`${BASE}/#/retro`);
    await page.waitForSelector("#page-retro");
    const panel = page.locator("#retro-onboarding");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Getting Started");

    // Versioned documentation links render.
    await expect(page.locator('[data-retro-doc="v1"]').first()).toBeVisible();

    // Dismissible contextual tooltip hides and stays hidden for the session.
    const tip = page.locator('[data-retro-tip="dropzone"]');
    await expect(tip).toBeVisible();
    await tip.locator(".retro-tip-dismiss").click();
    await expect(tip).toBeHidden();

    // Collapse toggle hides the body; re-toggle restores it.
    const body = page.locator("#retro-onboarding-body");
    await expect(body).toBeVisible();
    await page.click("#retro-onboarding-toggle");
    await expect(body).toBeHidden();
    await page.click("#retro-onboarding-toggle");
    await expect(body).toBeVisible();

    // Dismiss-for-good hides the whole panel.
    await page.click("#retro-onboarding-dismiss");
    await expect(panel).toBeHidden();
  });
});
