import { test, expect } from "../fixtures";
import Database from "better-sqlite3";
import path from "path";

/**
 * Sprint 2 (WUD-2.3 / EPIC-03 + EPICSEC05) — ProtonDB Compatibility Ingestion
 * & Mods Security Hardening.
 *
 *   Test 1 (API): GET /api/protondb/:appId returns the community compatibility
 *           tier (Gold via the hermetic fixture) with a normalized 0-100 score
 *           and NO contributor identity fields.
 *   Test 2 (API): POST /api/mods/ingest enforces the strict mod metadata schema
 *           — non-negative counts, strict version tag, MASKED author handle,
 *           and script-injection-sanitized description before persistence.
 *   Test 3 (API): GET /api/mods/listings surfaces sanitized descriptions +
 *           official compatibility tags and never exposes the raw handle.
 *   Test 4 (VBAC): The game detail drawer renders the ProtonDB badge alongside
 *           the hardware compatibility indicators.
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

function readRow<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

test.describe("ProtonDB Ingestion & Mods Security Hardening (WUD-2.3)", () => {
  test("1. GET /api/protondb/:appId returns tier + normalized score, no identity", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/protondb/1091500`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.summary).toBeTruthy();
    expect(["Platinum", "Gold", "Silver", "Bronze", "Borked", "Pending"]).toContain(
      body.summary.tier,
    );
    expect(body.summary.tier).toBe("Gold");
    expect(body.summary.normalized).toBeGreaterThanOrEqual(0);
    expect(body.summary.normalized).toBeLessThanOrEqual(100);
    expect(body.summary.totalReports).toBeGreaterThan(0);
    expect(body.summary.score).toBeGreaterThanOrEqual(0);
    expect(body.summary.score).toBeLessThanOrEqual(1);

    // Contributor identity must never be present in the payload.
    const keys = Object.keys(body.summary);
    for (const forbidden of ["author", "username", "contributor", "profileUrl"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  test("2. Mod ingest enforces strict schema + script-injection sanitization", async ({
    request,
  }) => {
    const modName = `Schema Guard ${Date.now()}`;
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "cyberpunk-2077",
        modName,
        author: "Schema Guard Team",
        downloads: 12000,
        version: "2.0",
        minVramGb: 6,
        minRamGb: 16,
        sourceUrl: "https://www.nexusmods.com/cyberpunk2077/mods/9999",
        download_count: -5,
        active_installs: 1200,
        rating_count: 4.7,
        version_tag: "v1.2.3_rc",
        author_handle: "rawAuthorHandle123",
        description: "<img src=x onerror=alert(1)>Great mod description",
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.mod.downloadCount).toBe(0); // negative clamped to 0
    expect(body.mod.ratingCount).toBe(4); // floored non-negative int
    expect(body.mod.activeInstalls).toBe(1200);
    expect(body.mod.versionTag).toBe("v1.2.3_rc");
    // The author handle is masked — the raw handle never surfaces.
    expect(body.mod.authorHandle).toContain("•");
    expect(body.mod.authorHandle).not.toContain("rawAuthorHandle123");
    // Script injection was stripped before persistence.
    expect(body.mod.description).toBe("Great mod description");
    expect(body.mod.description).not.toContain("<");

    // Verify at-rest persistence is equally sanitized (defense in depth).
    const stored = readRow<{ author_handle: string; description: string }>(
      "SELECT author_handle, description FROM Mods WHERE modName = ?",
      modName,
    );
    expect(stored).toBeTruthy();
    expect(stored!.author_handle).toContain("•");
    expect(stored!.description).not.toContain("<script");
    expect(stored!.description).not.toContain("<img");
  });

  test("3. Mod listings expose sanitized descriptions + compat tags, never raw handles", async ({
    request,
  }) => {
    const modName = `List Guard ${Date.now()}`;
    await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "cyberpunk-2077",
        modName,
        author: "List Guard",
        downloads: 500,
        version: "1.0",
        sourceUrl: "https://www.nexusmods.com/cyberpunk2077/mods/8888",
        author_handle: "profile/ExternalGuy",
        description: "<b>Safe</b> <script>alert(1)</script>listing text",
      },
    });

    const listRes = await request.get(`${BASE}/api/mods/listings?game=cyberpunk-2077`);
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const mod = (listBody.mods || []).find((m: any) => m.modName === modName);
    expect(mod).toBeTruthy();
    expect(mod.description).not.toContain("<script");
    expect(mod.description).not.toContain("<b>");
    expect(mod.authorHandle).toContain("•");
    expect(mod.authorHandle).not.toContain("ExternalGuy");
    // Official compatibility tags from the verified provider domain.
    expect(Array.isArray(mod.compatTags)).toBe(true);
    expect(mod.compatTags.some((t: string) => t.includes("Nexus Mods"))).toBe(true);
  });

  test("4. UI: game detail drawer renders the ProtonDB badge beside hardware indicators", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer("Cyberpunk 2077");
    });
    const drawer = page.locator("#game-detail-drawer");
    await expect(drawer).toBeVisible();

    // Hardware compatibility indicator is present...
    await expect(page.locator("#drawer-fleet-rating")).toBeVisible({ timeout: 15000 });

    // ...and the ProtonDB community badge renders its tier alongside it.
    const badge = page.locator("#drawer-protondb-badge [data-protondb-badge]");
    await expect(badge).toBeVisible({ timeout: 15000 });
    const tier = page.locator("#drawer-protondb-badge [data-protondb-tier]");
    await expect(tier).toContainText("Gold");
    await expect(page.locator("#drawer-protondb-badge")).toContainText("reports");
  });
});



