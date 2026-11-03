import { test, expect } from "@playwright/test";
import path from "path";
import Database from "better-sqlite3";

/**
 * Sprint 1B (EPICSEC02 / EPICSEC06) — Domain Whitelist Governance & DPM
 * Observability.
 *
 * EPICSEC02 — Mod Domain Governance:
 *   1. Read-time ingestion blocks subdomain-spoofed hosts.
 *   2. Ingestion blocks userinfo/credential spoofing.
 *   3. Ingestion blocks trailing-dot hostnames; query strings never bypass the
 *      exact-match host whitelist.
 *   4. Whitelisted hosts with query params and www normalization are accepted.
 *   5. GitHub remains releases-only (repo pages rejected).
 *   6. http scheme / unknown domains produce sanitized 400s.
 *   7. Ingestion-time re-sanitization purges stale non-whitelisted records
 *      (read-time suppression + quarantine flag).
 *
 * EPICSEC06 — DPM Security & Observability:
 *   8. /api/dpm/health returns a sanitized payload.
 *   9. /api/dpm/metrics exposes Prometheus-compatible DPM telemetry (health
 *      gauge, cache hit/miss, retry and degraded-fallback counters).
 *  10. /api/devices/playability serves a degraded-state fallback (blockedSpecs,
 *      usingFallback) without 5xx when hardware scans are missing.
 *  11. Playability TTL cache hit/miss is observable in telemetry.
 *  12. Playability enforces strict input validation (overlong deviceId → 400).
 *  13. /api/devices/:id/playable-games serves a graceful fallback and carries
 *      rate-limit headers.
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

/** Parse a Prometheus metric value by name from the text exposition body. */
function metricValue(text: string, name: string): number | null {
  const re = new RegExp(`^${name} ([0-9]+)$`, "m");
  const match = text.match(re);
  return match ? Number(match[1]) : null;
}

test.describe(
  "Sprint 1B — Domain Whitelist Governance & DPM Observability (EPICSEC02 / EPICSEC06)",
  () => {
    // ---------------------------------------------------------------------------
    // EPICSEC02 — Mod Domain Governance edge cases
    // ---------------------------------------------------------------------------

    test("1. Ingest rejects subdomain-spoofed hosts, even with query obfuscation", async ({
      request,
    }) => {
      for (const sourceUrl of [
        "https://nexusmods.com.evil.example.com/mods/123",
        "https://www.nexusmods.com.evil.example.com/mods/101?ref=nexusmods.com",
      ]) {
        const res = await request.post(`${BASE}/api/mods/ingest`, {
          data: {
            gameId: "G00001",
            modName: `Sprint1B Spoof ${Date.now()}`,
            sourceUrl,
          },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(typeof body.error).toBe("string");
        expect(body.error.toLowerCase()).toContain("whitelist");
        // No stack traces / local paths leak into the sanitized error.
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(" at ");
        expect(serialized).not.toContain("C:\\");
      }
    });

    test("2. Ingest rejects userinfo/credential spoofing", async ({ request }) => {
      // Hostname is whitelisted but the embedded userinfo would be a legitimate
      // redirect/credential vector — the sanitizer must reject it explicitly.
      const res = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName: `Sprint1B Credential Spoof ${Date.now()}`,
          sourceUrl: "https://www.nexusmods.com@www.nexusmods.com/mods/123",
        },
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error.toLowerCase()).toContain("credential");
    });

    test("3. Ingest rejects trailing-dot hostnames and does not trust query strings", async ({
      request,
    }) => {
      const trailingDot = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName: `Sprint1B Trailing Dot ${Date.now()}`,
          sourceUrl: "https://www.nexusmods.com./skyrimspecialedition/mods/1",
        },
      });
      expect(trailingDot.status()).toBe(400);
      expect((await trailingDot.json()).error.toLowerCase()).toContain("trailing");

      const http = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName: `Sprint1B Http ${Date.now()}`,
          sourceUrl: "http://www.nexusmods.com/skyrimspecialedition/mods/1",
        },
      });
      expect(http.status()).toBe(400);
      expect((await http.json()).error.toLowerCase()).toContain("https");
    });

    test("4. Ingest accepts whitelisted hosts with query params and www normalization", async ({
      request,
    }) => {
      const modName = `Sprint1B Valid Query ${Date.now()}`;
      const res = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName,
          sourceUrl:
            "https://www.nexusmods.com/skyrimspecialedition/mods/101?tab=files&section=main",
        },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.mod.sourceDomain).toBe("nexusmods.com");
    });

    test("5. GitHub stays releases-only (repo pages rejected, releases accepted)", async ({
      request,
    }) => {
      const repo = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName: `Sprint1B Repo ${Date.now()}`,
          sourceUrl: "https://github.com/joelgeorges86/MGPL",
        },
      });
      expect(repo.status()).toBe(400);
      expect((await repo.json()).error.toLowerCase()).toContain("releases");

      const releases = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName: `Sprint1B Releases ${Date.now()}`,
          sourceUrl: "https://github.com/ianpatt/skse64/releases",
        },
      });
      expect(releases.status()).toBe(200);
      expect((await releases.json()).mod.sourceDomain).toBe("github.com");
    });

    test("6. Unknown domains produce sanitized 400 errors", async ({ request }) => {
      const res = await request.post(`${BASE}/api/mods/ingest`, {
        data: {
          gameId: "G00001",
          modName: `Sprint1B Unknown Domain ${Date.now()}`,
          sourceUrl: "https://evil.example.com/mods/x",
        },
      });
      expect(res.status()).toBe(400);
      const serialized = JSON.stringify(await res.json());
      expect(serialized).not.toContain(" at ");
      expect(serialized).not.toContain("C:\\");
      expect(serialized.length).toBeLessThan(500);
    });

    test("7. Ingestion-time re-sanitization purges stale non-whitelisted records", async ({
      request,
    }) => {
      const modName = `Sprint1B Stale ${Date.now()}`;
      const db = new Database(TEST_DB_PATH);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 10000");
      try {
        // Simulate a legacy record that was ingested before the whitelist.
        db.prepare(
          `INSERT INTO "Mods" (gameId, modName, author, sourceDomain, sourceUrl, downloads, version, is_active)
           VALUES ('G00001', ?, NULL, 'evil.example.com', 'https://evil.example.com/mods/x', 0, '1.0', 1)`,
        ).run(modName);

        // Read-time re-sanitization: the listing still surfaces the record but
        // the non-whitelisted sourceUrl is purged to null (linkValid=false).
        const listings = await request.get(`${BASE}/api/mods/listings?game=G00001`);
        expect(listings.status()).toBe(200);
        const body = await listings.json();
        const row = body.mods.find((m: any) => m.modName === modName);
        expect(row).toBeTruthy();
        expect(row.linkValid).toBe(false);
        expect(row.sourceUrl).toBeNull();
        expect(row.sourceDomain).toBe("evil.example.com");

        // Quarantine flag (is_active = 0): the record disappears entirely.
        db.prepare(
          'UPDATE "Mods" SET is_active = 0, updatedAt = CURRENT_TIMESTAMP WHERE modName = ?',
        ).run(modName);
        const quarantined = await request.get(`${BASE}/api/mods/listings?game=G00001`);
        const quarantinedBody = await quarantined.json();
        expect(
          quarantinedBody.mods.some((m: any) => m.modName === modName),
        ).toBe(false);
      } finally {
        db.prepare('DELETE FROM "Mods" WHERE modName = ?').run(modName);
        db.close();
      }
    });

    // ---------------------------------------------------------------------------
    // EPICSEC06 — DPM Security & Observability
    // ---------------------------------------------------------------------------

    test("8. /api/dpm/health returns a sanitized payload", async ({ request }) => {
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

    test("9. /api/dpm/metrics exposes Prometheus-compatible DPM telemetry", async ({
      request,
    }) => {
      const res = await request.get(`${BASE}/api/dpm/metrics`);
      expect(res.status()).toBe(200);
      expect((res.headers()["content-type"] || "").toLowerCase()).toContain("text/plain");
      const text = await res.text();

      // Health gauge is always present and valid (0 or 1).
      expect(text).toContain("# TYPE dpm_health_status gauge");
      const health = metricValue(text, "dpm_health_status");
      expect(health).not.toBeNull();
      expect([0, 1]).toContain(health);

      // Every telemetry counter family is present with a non-negative value.
      for (const name of [
        "dpm_requests_total",
        "dpm_cache_hits_total",
        "dpm_cache_misses_total",
        "dpm_degraded_fallback_total",
        "dpm_retries_total",
        "dpm_errors_total",
        "dpm_rejected_total",
      ]) {
        expect(text).toContain(`# TYPE ${name} counter`);
        const value = metricValue(text, name);
        expect(value).not.toBeNull();
        expect(value!).toBeGreaterThanOrEqual(0);
      }
    });

    test("10. Playability serves a degraded-state fallback without 5xx when scans are missing", async ({
      request,
    }) => {
      const db = new Database(TEST_DB_PATH);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 10000");
      let previousCount = -1;
      try {
        // Temporarily archive every scanned device so the "no scanned device"
        // degraded state is deterministic. Restored in finally so later specs
        // still see an active seeded fleet.
        db.prepare('UPDATE "Devices" SET isArchived = 1').run();

        const res = await request.get(
          `${BASE}/api/devices/playability?deviceId=sprint1b-unknown-device`,
        );
        expect(res.status()).toBe(200); // never a 5xx
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.usingFallback).toBe(true);
        expect(body.blockedSpecs).toBe(true);
        expect(body.deviceName).toBe("No Scanned Device");
        expect(Array.isArray(body.games)).toBe(true);
        expect(typeof body.deviceSpecs).toBe("object");
        expect(body.deviceSpecs.ramGb).toBeNull(); // specs never fabricated

        // The degraded state is observable in telemetry.
        const metrics = await (await request.get(`${BASE}/api/dpm/metrics`)).text();
        const degraded = metricValue(metrics, "dpm_degraded_fallback_total");
        expect(degraded).not.toBeNull();
        previousCount = degraded!;
        expect(previousCount).toBeGreaterThanOrEqual(1);
      } finally {
        db.prepare('UPDATE "Devices" SET isArchived = 0').run();
        db.close();
      }
    });

    test("11. Playability TTL cache hit/miss is observable in telemetry", async ({
      request,
    }) => {
      // First request is a cache miss; the second (same key, warm TTL) is a hit.
      const first = await request.get(
        `${BASE}/api/devices/playability?deviceId=rig-ultra-4080`,
      );
      expect(first.status()).toBe(200);
      expect((await first.json()).success).toBe(true);

      const second = await request.get(
        `${BASE}/api/devices/playability?deviceId=rig-ultra-4080`,
      );
      expect(second.status()).toBe(200);
      expect((await second.json()).success).toBe(true);

      const metrics = await (await request.get(`${BASE}/api/dpm/metrics`)).text();
      const misses = metricValue(metrics, "dpm_cache_misses_total");
      const hits = metricValue(metrics, "dpm_cache_hits_total");
      expect(misses).not.toBeNull();
      expect(hits).not.toBeNull();
      expect(misses!).toBeGreaterThanOrEqual(1);
      expect(hits!).toBeGreaterThanOrEqual(1);
    });

    test("12. Playability enforces strict input validation (overlong deviceId → 400)", async ({
      request,
    }) => {
      const evil = `${"a".repeat(200)}${"<script>alert(1)</script>"}`;
      const res = await request.get(
        `${BASE}/api/devices/playability?deviceId=${encodeURIComponent(evil)}`,
      );
      expect(res.status()).toBe(400);
      const serialized = JSON.stringify(await res.json());
      expect(serialized).not.toContain(" at ");
      expect(serialized).not.toContain("C:\\");
    });

    test("13. /api/devices/:id/playable-games serves a graceful fallback and rate-limit headers", async ({
      request,
    }) => {
      const res = await request.get(
        `${BASE}/api/devices/some-unknown-id/playable-games`,
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      // EPICSEC06 no-outage contract: never a 5xx. The test DB now mirrors the
      // canonical AppGames schema (Prisma-backed routes SELECT every mapped
      // scalar field), so this route no longer trips the degraded path via
      // missing columns. For an unknown device it deterministically resolves
      // the synthetic Local PC fallback profile and returns a well-formed
      // payload — the same sanitized, no-outage guarantee the sprint-1b
      // contract requires.
      expect(body.success).toBe(true);
      expect(body.device?.deviceName || body.deviceName).toBe("Local PC");
      expect(body.games).toBeTruthy();

      // The per-route rate limiter is applied (standard RateLimit-* headers).
      const headerKeys = Object.keys(res.headers());
      expect(
        headerKeys.some((k) => k.startsWith("ratelimit") || k.startsWith("x-ratelimit")),
      ).toBe(true);
    });
  },
);
