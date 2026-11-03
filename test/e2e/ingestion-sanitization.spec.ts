import { test, expect } from "@playwright/test";

/**
 * Sprint 1A (EPICSEC01 / EPICSEC04) — Unified Ingestion Validation &
 * Error Sanitization.
 *
 * Covers:
 *   1. Client privacy shield: safeToastError strips stacks/paths/secrets.
 *   2. Client ingestion fallbacks: safeArray/safeHydrate hydrate malformed
 *      payloads to well-typed fallbacks.
 *   3. Mods ingest rejects non-whitelisted schemes with a sanitized 400.
 *   4. Mods ingest echoes caller-supplied domains through the sanitizer
 *      (paths/secrets redacted, never leaked).
 *   5. Terminal Express error handler sanitizes body-parser failures (no
 *      stack traces in error responses).
 *   6. Retro tracking ingestion hydrates malformed payloads through
 *      safeCoerce and rejects missing required fields with generic messages.
 *   7. Deals feed always returns an array (unified fallback).
 *   8. Compare benchmark ingestion still accepts valid payloads after the
 *      safeCoerce migration.
 */

const BASE = "http://localhost:4000";

test.describe("Sprint 1A — Unified Ingestion Validation & Error Sanitization", () => {
  test("1. safeToastError redacts stack traces, internal paths and secrets", async ({ page }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    const result = await page.evaluate(() => {
      const raw =
        "boom at C:\\Users\\joelg\\OneDrive\\PC Build\\MGPL\\src\\routes\\mods.ts:25:9\n" +
        "    at fn (file:///app/src/routes/mods.ts:25:9) token=super-secret-abc123\n" +
        "    at processTicksAndRejections (node:internal/process/task_queues:96:5)";
      const clean = window.safeToastError(raw, "Something went wrong.");
      return { clean, raw };
    });
    expect(result.clean).not.toContain("joelg");
    expect(result.clean).not.toContain("mods.ts");
    expect(result.clean).not.toContain("file://");
    expect(result.clean).not.toContain("super-secret");
    expect(result.clean).not.toContain("processTicksAndRejections");
    expect(result.clean.length).toBeLessThanOrEqual(240);
  });

  test("2. safeArray / safeHydrate resolve malformed ingestion payloads to fallbacks", async ({ page }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    const result = await page.evaluate(() => ({
      arrNull: window.safeArray(null),
      arrObj: window.safeArray({}),
      hydrateString: window.safeHydrate("nope"),
      hydrateNull: window.safeHydrate(null, { x: 1 }),
      hydrateArray: window.safeHydrate([1, 2], { x: 1 }),
    }));
    expect(result.arrNull).toEqual([]);
    expect(result.arrObj).toEqual([]);
    expect(result.hydrateString).toEqual({});
    expect(result.hydrateNull).toEqual({ x: 1 });
    expect(result.hydrateArray).toEqual({ x: 1 });
  });

  test("3. Mods ingest rejects non-whitelisted schemes with a sanitized 400", async ({ request }) => {
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: { gameId: "G00001", modName: "E2E Sanitized Reject", sourceUrl: "javascript:alert(1)" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/javascript:/i);
    expect(serialized).not.toContain(" at ");
    expect(serialized).not.toContain("C:\\");
  });

  test("4. Mods ingest redacts caller-supplied paths and secrets in error echoes", async ({ request }) => {
    const res = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: "E2E Sanitized Spoof",
        sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/1234",
        sourceDomain: "C:\\Users\\evil\\app\\config.ts:42 token=abc123",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("[path]");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("Users");
    expect(serialized).not.toContain("config.ts");
    expect(serialized).not.toContain("token=");
  });

  test("5. Terminal error handler sanitizes body-parser failures (no stack traces)", async ({ request }) => {
    const res = await request.post(`${BASE}/api/retro/tracking`, {
      headers: { "Content-Type": "application/json" },
      data: "{ not-json",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(" at ");
    expect(serialized).not.toContain("C:\\");
    expect(serialized.length).toBeLessThan(500);
  });

  test("6. Retro tracking ingestion hydrates malformed payloads and rejects missing fields", async ({ request }) => {
    // Missing required field → generic 400.
    const missing = await request.post(`${BASE}/api/retro/tracking`, {
      data: { gameTitle: "   " },
    });
    expect(missing.status()).toBe(400);
    const missingBody = await missing.json();
    expect(missingBody.error).toBe("gameTitle is required.");

    // Malformed numeric fields coerce through safeCoerce (string "12" → 12).
    const title = `E2E Sanitized Retro ${Date.now()}`;
    const ok = await request.post(`${BASE}/api/retro/tracking`, {
      data: { gameTitle: title, playtimeHours: "12", personalRating: "8", system: "NES", status: "playing", isFavorite: true },
    });
    expect(ok.status()).toBe(200);
    const okBody = await ok.json();
    expect(okBody.success).toBe(true);
    expect(okBody.tracking.playtimeHours).toBe(12);
    expect(okBody.tracking.personalRating).toBe(8);

    // Cleanup: remove the created tracking row.
    const id = okBody.tracking.id;
    if (id !== undefined && id !== null) {
      await request.delete(`${BASE}/api/retro/tracking/${id}`);
    }
  });

  test("7. Deals feed always returns an array (unified fallback)", async ({ request }) => {
    const res = await request.get(`${BASE}/api/deals/search`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.deals)).toBe(true);
    expect(["cheapshark", "stale-snapshot", "itad-cache"]).toContain(body.source);
  });

  test("8. Compare benchmark ingestion still accepts valid payloads after safeCoerce migration", async ({ request }) => {
    const res = await request.post(`${BASE}/api/compare/benchmark`, {
      data: { gameId: "G00001", deviceIds: ["rig-ultra-4080"] },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.game.id).toBe("G00001");
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.devices.length).toBe(1);
  });
});
