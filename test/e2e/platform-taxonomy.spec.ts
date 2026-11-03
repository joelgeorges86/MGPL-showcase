import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "path";
import { normalizePlatform, CANONICAL_PLATFORMS } from "../../src/lib/platformTaxonomy";

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

/**
 * PI-GTM-2026-001 (Sprint 1) — EPIC-04 Platform Taxonomy & EPIC-05 Platform
 * Hub Triage verification.
 *
 * Test 1: normalizePlatform() maps legacy storefront labels to the canonical taxonomy.
 * Test 2: GET /api/platforms/taxonomy returns the 7 canonical values + coherent counts.
 * Test 3: PlayStation hub summary includes PS4-era rows (hub OR-match defect fix, HUB-01).
 * Test 4: AppOwnership.platformCanonical is persisted deterministically in SQLite.
 * Test 5: platform_audit_logs is append-only (UPDATE/DELETE triggers abort).
 * Test 6: Ingest validation rejects unclassified platforms with a structured audit entry.
 */
test.describe("PI-GTM-2026-001 EPIC-04/EPIC-05 — Platform Taxonomy & Hub Triage", () => {
  test("1. normalizePlatform resolves legacy storefront labels to the canonical taxonomy", () => {
    expect(normalizePlatform("Steam")).toBe("PC");
    expect(normalizePlatform("GOG")).toBe("PC");
    expect(normalizePlatform("Epic Games")).toBe("PC");
    expect(normalizePlatform("Legacy Games")).toBe("PC");
    expect(normalizePlatform("PS4")).toBe("Console – PlayStation");
    expect(normalizePlatform("PS5")).toBe("Console – PlayStation");
    expect(normalizePlatform("PlayStation 4")).toBe("Console – PlayStation");
    expect(normalizePlatform("Xbox Series X")).toBe("Console – Xbox");
    expect(normalizePlatform("Switch")).toBe("Console – Nintendo");
    expect(normalizePlatform("iOS")).toBe("Mobile – iOS");
    expect(normalizePlatform("Android")).toBe("Mobile – Android");
    expect(normalizePlatform("Xbox Cloud Gaming")).toBe("Cloud");
    expect(normalizePlatform("Floppy Disk")).toBeNull();
    expect(normalizePlatform(null)).toBeNull();
    expect(normalizePlatform(undefined)).toBeNull();
  });

  test("2. GET /api/platforms/taxonomy returns the 7 canonical values and coherent counts", async ({
    request,
  }: {
    request: any;
  }) => {
    const res = await request.get(`${BASE}/api/platforms/taxonomy`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.taxonomy).toEqual([...CANONICAL_PLATFORMS]);
    expect(Array.isArray(data.counts)).toBe(true);
    const sum = data.counts.reduce((acc: number, c: any) => acc + (c.cnt || 0), 0);
    expect(data.total).toBe(sum);
    expect(data.total).toBeGreaterThan(0);
    // The seeded catalog must land in at least PC and Console – PlayStation.
    const labels = (data.counts as Array<{ canonical: string }>).map((c) => c.canonical);
    expect(labels).toContain("PC");
    expect(labels).toContain("Console – PlayStation");
  });

  test("3. PlayStation hub summary includes PS4-era rows (hub OR-match fix, HUB-01)", async ({
    request,
  }: {
    request: any;
  }) => {
    const res = await request.get(`${BASE}/api/platforms/playstation/summary`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.platform).toBe("playstation");
    expect(Array.isArray(data.ownedGames)).toBe(true);
    // HUB-01: before the fix the query matched only ownershipMatches[0] ('ps5'),
    // so explicit PS4 rows were silently dropped. At least one owned game must
    // now surface from an explicit PS4 platform.
    const ps4Game = (data.ownedGames || []).find((g: any) => /ps4/i.test(String(g.platform || "")));
    expect(ps4Game).toBeTruthy();
    expect(ps4Game.platformCanonical).toBe("Console – PlayStation");
  });

  test("4. AppOwnership.platformCanonical is persisted deterministically in SQLite", () => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const columns = db.prepare('PRAGMA table_info("AppOwnership")').all() as any[];
      expect(columns.some((c) => c.name === "platformCanonical")).toBe(true);

      const cyberpunk = db
        .prepare(
          `SELECT "platformCanonical" AS c FROM "AppOwnership" WHERE "OwnershipID" = 'own-cyberpunk-2077'`,
        )
        .get() as any;
      expect(cyberpunk?.c).toBe("PC");

      const bloodborne = db
        .prepare(
          `SELECT "platformCanonical" AS c FROM "AppOwnership" WHERE "OwnershipID" = 'own-bloodborne'`,
        )
        .get() as any;
      expect(bloodborne?.c).toBe("Console – PlayStation");
    } finally {
      db.close();
    }
  });

  test("5. platform_audit_logs is append-only (UPDATE/DELETE triggers abort)", () => {
    const db = new Database(TEST_DB_PATH);
    db.pragma("busy_timeout = 5000");
    try {
      const probe = db.transaction(() => {
        db.prepare(
          `INSERT INTO "platform_audit_logs" ("tableName", "rowId", "field", "oldValue", "newValue", "reason", "operator")
           VALUES ('e2e-probe', 'probe-row', 'platformCanonical', 'probe', 'probe', 'immutability-check', 'e2e-spec')`,
        ).run();
        expect(() =>
          db
            .prepare(
              `UPDATE "platform_audit_logs" SET "newValue" = 'tampered' WHERE "rowId" = 'probe-row'`,
            )
            .run(),
        ).toThrow(/append-only/);
        expect(() =>
          db.prepare(`DELETE FROM "platform_audit_logs" WHERE "rowId" = 'probe-row'`).run(),
        ).toThrow(/append-only/);
        // Force rollback so the probe row never pollutes the shared test DB.
        throw new Error("__epic04_rollback__");
      });
      expect(() => probe()).toThrow("__epic04_rollback__");
      const leaked = (
        db
          .prepare(`SELECT COUNT(*) AS c FROM "platform_audit_logs" WHERE "rowId" = 'probe-row'`)
          .get() as any
      ).c;
      expect(leaked).toBe(0);
    } finally {
      db.close();
    }
  });

  test("6. Ingest validation rejects unclassified platforms with a structured audit entry", async ({
    request,
  }: {
    request: any;
  }) => {
    const login = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" },
    });
    expect(login.status()).toBe(200);

    const importRes = await request.post(`${BASE}/api/library/import`, {
      data: {
        games: [{ title: "E2E Invalid Platform Probe", platform: "Floppy Disk" }],
      },
    });
    expect(importRes.status()).toBe(200);
    const importData = await importRes.json();
    expect(importData.success).toBe(true);
    expect(importData.rejected).toBeGreaterThanOrEqual(1);
    expect(importData.rejections[0].platform).toBe("Floppy Disk");
    expect(importData.rejections[0].error).toContain("Unclassified");

    const auditRes = await request.get(`${BASE}/api/platforms/audit-log?limit=50`);
    expect(auditRes.status()).toBe(200);
    const auditData = await auditRes.json();
    expect(auditData.success).toBe(true);
    const entry = (auditData.entries || []).find(
      (e: any) => e.tableName === "library-import" && e.rowId === "E2E Invalid Platform Probe",
    );
    expect(entry).toBeTruthy();
    expect(entry.oldValue).toBe("Floppy Disk");
    expect(entry.newValue).toBeNull();
    expect(entry.reason).toContain("EPIC-04 ingest validation rejection");
  });
});
