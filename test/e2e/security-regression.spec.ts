import { test, expect } from "@playwright/test";
import path from "path";
import Database from "better-sqlite3";

/**
 * Sprint 6 (PI-GTM-2026-002) — Platform-Wide Security Regression Suite.
 *
 * Consolidated release-gate invariants:
 *   1. Observability health/metrics are sanitized (no metadata/PII/stack leaks).
 *   2. "Data as of" freshness headers are stamped on module responses.
 *   3. Observability event recording is exact-match validated and never echoes input.
 *   4. URL sanitization — mod source URLs reject non-https / non-whitelisted schemes.
 *   5. Domain whitelist enforcement — every external deal link is HTTPS + whitelisted.
 *   6. Error sanitization — no stack traces, internal paths, or secrets in errors.
 *   7. Palette token safety — CSS custom-property values self-heal via the strict
 *      sanitizer (no url()/var() injection).
 *   8. Ingestion validation — malformed payloads hydrate to typed fallbacks.
 *   9. No env vars / internal paths leak across representative endpoints.
 *  10. State snapshot export covers the full persistence surface (25+ tables)
 *      without leaking the immutable append-only platform_audit_logs table.
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");
const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
// AI-084 (#163): export and import are admin-only (test/global-setup.ts seeds this account).
const ADMIN = { email: "admin.ops@mgpl.io", password: "AdminPass2026!" };

const EXPECTED_INTEGRATIONS = [
  "steam",
  "psn",
  "xbox",
  "epic",
  "gog",
  "ubisoft",
  "protondb",
  "cheapshark",
  "itad",
  "gamerpower",
  "nexusmods",
  "hltb",
  "dpm",
];

/** Authorized deal-attribution hosts (mirrors EPIC-DEAL-001). */
const ALLOWED_HOSTS = new Set([
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
  "gamerpower.com",
  "www.gamerpower.com",
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

test.describe("Sprint 6 — Platform-Wide Security Regression (PI-GTM-2026-002)", () => {
  test("1. /api/observability/health is a sanitized privacy-minimized payload", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/observability/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.generatedAt).toBe("string");
    expect(["healthy", "degraded"]).toContain(body.overall);
    expect(Array.isArray(body.integrations)).toBe(true);

    const keys = body.integrations.map((i: any) => i.key);
    for (const expected of EXPECTED_INTEGRATIONS) {
      expect(keys).toContain(expected);
    }
    for (const entry of body.integrations) {
      expect(typeof entry.label).toBe("string");
      expect(["healthy", "degraded", "stale", "unknown"]).toContain(entry.status);
      for (const numKey of [
        "requestsTotal",
        "failureRate",
        "rateLimitedTotal",
        "domainRejectedTotal",
        "tokenExpiredTotal",
        "staleTotal",
      ]) {
        expect(typeof entry[numKey]).toBe("number");
        expect(Number.isFinite(entry[numKey])).toBe(true);
      }
    }

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("C:\\");
    expect(serialized).not.toContain("file://");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain(" at ");
  });

  test("2. /api/observability/metrics emits only static metric names + integers", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/observability/metrics`);
    expect(res.status()).toBe(200);
    expect((res.headers()["content-type"] || "").toLowerCase()).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("integration_health_overall");
    expect(text).toContain('integration="steam"');
    expect(text).toContain("integration_domain_rejected_total");
    expect(text).toContain("integration_token_expired_total");
    // privacy-minimized: no paths, secrets, or stack traces in the exposition.
    expect(text).not.toContain("C:\\");
    expect(text).not.toContain("file://");
    expect(text).not.toContain("token=");
    expect(text).not.toContain(" at ");
  });

  test("3. Module responses carry the 'Data as of' freshness header", async ({ request }) => {
    for (const url of [
      `${BASE}/api/observability/health`,
      `${BASE}/api/dpm/health`,
      `${BASE}/api/deals/search`,
    ]) {
      const res = await request.get(url);
      expect(res.status()).toBe(200);
      const dataAsOf = res.headers()["x-data-as-of"];
      expect(dataAsOf).toBeTruthy();
      expect(new Date(dataAsOf as string).getTime()).not.toBeNaN();
    }
  });

  test("4. Observability record endpoint validates exact-match and never echoes input", async ({
    request,
  }) => {
    const ok = await request.post(`${BASE}/api/observability/record`, {
      data: { integration: "steam", event: "rate_limited" },
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).success).toBe(true);

    const badIntegration = await request.post(`${BASE}/api/observability/record`, {
      data: { integration: "C:\\Users\\evil\\secret.js token=abc123", event: "failure" },
    });
    expect(badIntegration.status()).toBe(400);
    const badSerialized = JSON.stringify(await badIntegration.json());
    expect(badSerialized).not.toContain("Users");
    expect(badSerialized).not.toContain("secret.js");
    expect(badSerialized).not.toContain("token=");

    const badEvent = await request.post(`${BASE}/api/observability/record`, {
      data: { integration: "steam", event: "DROP TABLE" },
    });
    expect(badEvent.status()).toBe(400);
    const badEventBody = await badEvent.json();
    expect(typeof badEventBody.error).toBe("string");
    expect(JSON.stringify(badEventBody)).not.toContain("DROP");
  });

  test("5. Mod URL sanitization rejects non-https and non-whitelisted schemes", async ({
    request,
  }) => {
    const hostileUrls = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://nexusmods.com/skyrimspecialedition/mods/1",
      "https://evil.example.com/mods/x",
      "https://files.nexusmods.com/mods/x",
    ];
    for (const sourceUrl of hostileUrls) {
      const res = await request.post(`${BASE}/api/mods/ingest`, {
        data: { gameId: "G00001", modName: `SecRegression_${Date.now()}`, sourceUrl },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(" at ");
      expect(serialized).not.toContain("C:\\");
      expect(serialized).not.toContain("file://");
    }
  });

  test("6. External deal links strictly adhere to the HTTPS domain whitelist", async ({
    request,
  }) => {
    for (const url of [`${BASE}/api/deals/search`, `${BASE}/api/deals/by-store?store=all`]) {
      const res = await request.get(url);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      const deals: any[] = body.deals || [];
      for (const d of deals) {
        const storeUrl = String(d.storeUrl || "");
        if (!storeUrl) continue;
        expect(storeUrl.startsWith("https://")).toBe(true);
        const host = hostOf(storeUrl);
        expect(host).not.toBe("");
        expect(ALLOWED_HOSTS.has(host)).toBe(true);
      }
    }
  });

  test("7. Error responses are sanitized (no stack traces, paths, or secrets)", async ({
    request,
  }) => {
    const malformed = await request.post(`${BASE}/api/retro/tracking`, {
      headers: { "Content-Type": "application/json" },
      data: "{ not-json",
    });
    expect(malformed.status()).toBe(400);
    const serialized = JSON.stringify(await malformed.json());
    expect(serialized).not.toContain(" at ");
    expect(serialized).not.toContain("C:\\");
    expect(serialized).not.toContain("file://");
    expect(serialized.length).toBeLessThan(500);

    const hostileMod = await request.post(`${BASE}/api/mods/ingest`, {
      data: {
        gameId: "G00001",
        modName: `SecRegressionSpoof_${Date.now()}`,
        sourceUrl: "https://www.nexusmods.com/skyrimspecialedition/mods/1234",
        sourceDomain: "C:\\Users\\evil\\app\\config.ts:42 token=abc123",
      },
    });
    expect(hostileMod.status()).toBe(400);
    const spoofSerialized = JSON.stringify(await hostileMod.json());
    expect(spoofSerialized).not.toContain("Users");
    expect(spoofSerialized).not.toContain("config.ts");
    expect(spoofSerialized).not.toContain("token=");
  });

  test("8. Palette CSS custom-property values self-heal through the strict sanitizer", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    const result = await page.evaluate(() => {
      const bg = window.safeCSSVar("--bg-primary", "");
      const badUrl = window.sanitizeCSSVarValue("url(https://evil.example.com/x.png)", "fallback");
      const badChain = window.sanitizeCSSVarValue("var(--other)", "fallback");
      const badType = window.sanitizeCSSVarValue(42, "fallback");
      return { bg, badUrl, badChain, badType };
    });
    expect(result.bg.length).toBeGreaterThan(0);
    expect(result.badUrl).toBe("fallback");
    expect(result.badChain).toBe("fallback");
    expect(result.badType).toBe("fallback");
  });

  test("9. Ingestion validation hydrates malformed payloads to typed fallbacks", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    const result = await page.evaluate(() => ({
      arrNull: window.safeArray(null),
      arrObj: window.safeArray({}),
      hydrateString: window.safeHydrate("nope"),
      hydrateNull: window.safeHydrate(null, { x: 1 }),
    }));
    expect(result.arrNull).toEqual([]);
    expect(result.arrObj).toEqual([]);
    expect(result.hydrateString).toEqual({});
    expect(result.hydrateNull).toEqual({ x: 1 });
  });

  test("10. No env vars or internal paths leak across representative endpoints", async ({
    request,
  }) => {
    const endpoints = [
      "/api/observability/health",
      "/api/dpm/health",
      "/api/deals/search",
      "/api/mods/trending?game=skyrimspecialedition",
      "/api/mods/aggregation/status",
      // healthz is mounted at root (src/routes/health.ts) and is public.
      "/healthz",
    ];
    for (const endpoint of endpoints) {
      const res = await request.get(`${BASE}${endpoint}`);
      expect(res.ok(), endpoint).toBeTruthy();
      const body = await res.json();
      const serialized = JSON.stringify(body);
      expect(serialized, endpoint).not.toContain("C:\\");
      expect(serialized, endpoint).not.toContain("file://");
      expect(serialized, endpoint).not.toContain("process.env");
      expect(serialized, endpoint).not.toContain("token=");
      expect(serialized, endpoint).not.toContain(" at ");
    }
  });

  test("11. State snapshot export covers the full persistence surface (25+ tables)", async ({
    page,
  }) => {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ADMIN });
    expect(login.status()).toBe(200);

    const res = await page.request.get(`${BASE}/api/state/export`);
    expect(res.ok()).toBeTruthy();
    const snapshot = await res.json();
    expect(snapshot.version).toBe(1);

    const data = snapshot.data || {};
    const dataKeys = Object.keys(data);
    expect(dataKeys.length).toBeGreaterThanOrEqual(25);
    for (const key of dataKeys) {
      expect(Array.isArray(data[key]), `${key} must be an array for round-trip`).toBe(true);
    }

    // The immutable append-only audit log must never appear in the snapshot.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("platform_audit_logs");

    // Direct DB verification: the test database holds 25+ persistence tables.
    const db = new Database(TEST_DB_PATH);
    db.pragma("journal_mode = WAL");
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    db.close();
    const tableCount = rows.filter((r) => !r.name.startsWith("sqlite_")).length;
    expect(tableCount).toBeGreaterThanOrEqual(25);
  });
});
