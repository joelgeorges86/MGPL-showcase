import { test, expect, type APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import {
  planMobileImport,
  applyMobileImport,
  MOBILE_STAGING_TABLES,
} from "../../src/services/mobileCatalogueImport";
import { bytes, now, family } from "../helpers/mobileStagingFixture";

const file = path.resolve("data/test_mgpl.db");
const endpoints = [
  "/api/catalog/devices?pageSize=100",
  "/api/catalog/devices?type=Phone",
  "/api/catalog/devices?type=Tablet",
  "/api/performance/devices",
];
async function responses(request: APIRequestContext) {
  const bodies: any[] = [];
  for (const endpoint of endpoints) {
    const response = await request.get(endpoint);
    expect(response.status()).toBe(200);
    bodies.push(await response.json());
  }
  return bodies;
}
test.describe.serial("AI-092 mobile catalogue API isolation", () => {
  let baseline: any[];
  let batchId: string | null = null;
  test.afterAll(() => {
    if (!batchId) return;
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      db.transaction(() => {
        for (const table of [...MOBILE_STAGING_TABLES].reverse()) {
          const column =
            table === "mobile_import_batches"
              ? "batch_id"
              : [
                    "mobile_sources",
                    "mobile_device_families",
                    "mobile_hardware_references",
                    "mobile_device_variants",
                  ].includes(table)
                ? "first_batch_id"
                : "batch_id";
          db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(batchId);
        }
      }).immediate();
    } finally {
      db.close();
    }
  });
  test("E-01 capture existing catalogue and performance baseline", async ({ request }) => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM mobile_device_families").get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
    baseline = await responses(request);
    expect(baseline[1].total).toBe(0);
    expect(baseline[2].total).toBe(0);
  });
  test("E-02 server boot created tables and importer applies synthetic fixture", () => {
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 10000");
      for (const t of MOBILE_STAGING_TABLES)
        expect(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t),
        ).toBeTruthy();
      const input = bytes(),
        report = planMobileImport(db, input, { now });
      expect(report.status).toBe("applicable");
      const result = applyMobileImport(db, input, report, { now });
      expect(result.status).toBe("applied");
      batchId = result.batchId;
    } finally {
      db.close();
    }
  });
  test("E-03 responses and facets remain unchanged after mobile staging", async ({ request }) => {
    const after = await responses(request);
    expect(after).toEqual(baseline);
    expect(
      after[0].facets.types.every((t: string) => ["PC", "Console", "Handheld"].includes(t)),
    ).toBe(true);
    expect(JSON.stringify(after)).not.toContain(family().family_key);
  });
  test("E-04 mobile keys are unavailable through catalogue detail and compare", async ({
    request,
  }) => {
    const key = encodeURIComponent(family().family_key);
    expect((await request.get(`/api/catalog/devices/${key}`)).status()).toBe(404);
    expect((await request.get(`/api/catalog/compare?ids=${key},ps5`)).status()).toBe(404);
  });
  test("E-05 mobile staging foreign keys remain clean", () => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
