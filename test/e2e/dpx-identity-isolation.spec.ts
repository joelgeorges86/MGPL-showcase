import { test, expect, type APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import {
  planDpxIdentityImport,
  applyDpxIdentityImport,
  DPX_IDENTITY_TABLES,
} from "../../src/services/dpxIdentityImport";
import { dpxBytes, dpxFixture, DPX_NOW } from "../helpers/dpxIdentityFixture";
import { sha256Hex } from "../../src/services/enrichmentPromotion";

const file = path.resolve("data/test_mgpl.db"),
  input = dpxBytes(dpxFixture({ mobile: false }));
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
test.describe.serial("AI-095 shared identity API isolation", () => {
  let baseline: any[],
    batchId: string | null = null;
  test.afterAll(() => {
    if (!batchId) return;
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 10000");
      db.transaction(() => {
        for (const table of [...DPX_IDENTITY_TABLES].reverse()) {
          const column =
            table === "dpx_import_batches" || table === "dpx_evidence_observations"
              ? "batch_id"
              : "first_batch_id";
          db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(batchId);
        }
      }).immediate();
    } finally {
      db.close();
    }
  });
  test("E-01 server boot created tables and capture legacy responses", async ({ request }) => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      for (const table of DPX_IDENTITY_TABLES)
        expect(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table),
        ).toBeTruthy();
      expect(
        db
          .prepare("SELECT batch_id FROM dpx_import_batches WHERE input_sha256 = ?")
          .get(sha256Hex(input)),
      ).toBeUndefined();
    } finally {
      db.close();
    }
    baseline = await responses(request);
    expect(baseline[1].total).toBe(0);
    expect(baseline[2].total).toBe(0);
  });
  test("E-02 synthetic non-mobile identity import applies", () => {
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 10000");
      const report = planDpxIdentityImport(db, input, { now: DPX_NOW });
      expect(report.status).toBe("applicable");
      const result = applyDpxIdentityImport(db, input, report, { now: DPX_NOW });
      expect(result.status).toBe("applied");
      batchId = result.batchId;
    } finally {
      db.close();
    }
  });
  test("E-03 legacy catalogue and performance responses are unchanged", async ({ request }) => {
    const after = await responses(request);
    expect(after).toEqual(baseline);
    expect(after[1].total).toBe(0);
    expect(after[2].total).toBe(0);
  });
  test("E-04 exact re-plan is already_applied", () => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(planDpxIdentityImport(db, input, { now: DPX_NOW })).toMatchObject({
        status: "already_applied",
        alreadyAppliedBatchId: batchId,
      });
    } finally {
      db.close();
    }
  });
});
