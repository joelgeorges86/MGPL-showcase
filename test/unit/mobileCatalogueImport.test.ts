import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mobile from "../../src/services/mobileCatalogueImport";
import { canonicalJson, sha256Hex } from "../../src/services/enrichmentPromotion";
import { normalizePlatform, CANONICAL_PLATFORMS } from "../../src/lib/platformTaxonomy";
import { main } from "../../scripts/catalogue/import-mobile-references";
import {
  database,
  ddl,
  dbSource,
  bytes,
  fixture,
  header,
  now,
  source,
  family,
  reference,
  variant,
  observation,
  listing,
} from "../helpers/mobileStagingFixture";
import { buildMobileApplyReview } from "../helpers/mobileApplyReview";

const { planMobileImport: plan, applyMobileImport: apply, MOBILE_STAGING_TABLES: tables } = mobile;
const handles: Database.Database[] = [];
const temporary: string[] = [];
const db = (file?: string) => {
  const d = database(file);
  handles.push(d);
  return d;
};
const temp = () => {
  const p = mkdtempSync(path.join(os.tmpdir(), "mgpl-mobile-"));
  temporary.push(p);
  return p;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of handles.splice(0)) if (d.open) d.close();
  for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true });
});
const all = (d: Database.Database, t: string): any[] =>
  d
    .prepare(
      `SELECT * FROM ${t} ORDER BY ${t === "mobile_variant_sightings" ? "variant_key,source_key,observed_on" : "1"}`,
    )
    .all();
const changes = (d: Database.Database) =>
  d.prepare("SELECT total_changes() AS n").get() as { n: number };
const snapshot = (d: Database.Database) => ({
  hashes: tables.map((t) => sha256Hex(canonicalJson(all(d, t)))),
  changes: changes(d),
});
const run = (d: Database.Database, records: unknown[] = fixture(), extra = "") => {
  const input = Buffer.concat([bytes(records), Buffer.from(extra)]);
  const report = plan(d, input, { now });
  const result = apply(d, input, report, { now });
  return { report, result, input };
};
const reject = (d: Database.Database, records: unknown[], reason: string) => {
  const input = bytes(records);
  const before = snapshot(d);
  const report = plan(d, input, { now });
  expect(report.status).toBe("not_applicable");
  expect(report.outcomes.some((o) => o.reasons.includes(reason))).toBe(true);
  expect(() => apply(d, input, report, { now })).toThrow("plan_not_applicable");
  expect(snapshot(d)).toEqual(before);
  equations(report);
  return report;
};
function equations(r: mobile.MobileImportReport) {
  expect(r.outcomes).toHaveLength(r.records);
  const c = r.counts;
  expect(
    c.inserted +
      c.inserted_quarantined +
      c.inserted_superseded +
      c.sighting_added +
      c.unchanged +
      c.model_code_resolved +
      c.rejected +
      c.blocked,
  ).toBe(r.records);
  expect(c.existing_quarantined).toBe(
    r.existingRowEffects.filter((e) => e.transition === "accepted_to_quarantined").length,
  );
  expect(c.existing_superseded).toBe(
    r.existingRowEffects.filter((e) => e.transition === "accepted_to_superseded").length,
  );
  if (r.header.status === "rejected" || c.rejected) {
    expect(r.planSha256).toBeNull();
    expect(r.existingRowEffects).toEqual([]);
    expect(c.blocked).toBe(r.records - c.rejected);
    expect(
      r.outcomes.filter((o) => o.status === "blocked").every((o) => o.reasons.length === 0),
    ).toBe(true);
  } else {
    expect(c.rejected + c.blocked).toBe(0);
    expect(r.planSha256).toMatch(/^[0-9a-f]{64}$/);
  }
}
function domain(d: Database.Database) {
  return tables
    .slice(1)
    .map((t) =>
      all(d, t).map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            ["batch_id", "first_batch_id", "model_code_batch_id", "quarantined_batch_id"].includes(
              k,
            ) && v !== null
              ? "batch"
              : v,
          ]),
        ),
      ),
    );
}
const base = () => [source(), family(), reference()];
const codeReference = (extra: Record<string, unknown> = {}) =>
  reference({
    reference_key: "apple:example:xx01",
    model_code: "XX01",
    scope_market: null,
    model_code_source_ref: "s",
    model_code_observed_on: "2026-10-21",
    ...extra,
  });
const fieldRows = (d: Database.Database) => all(d, "mobile_observations");
function preservationDb() {
  const d = new Database(":memory:");
  handles.push(d);
  d.pragma("foreign_keys = ON");
  for (const t of [
    "AuthUsers",
    "Devices",
    "catalog_devices",
    "catalog_device_specs",
    "device_reviews",
  ]) {
    const pattern = new RegExp(
      'CREATE TABLE IF NOT EXISTS ["`]?' + t + '["`]? \\([\\s\\S]*?\\n    \\);',
    );
    d.exec(dbSource.match(pattern)![0]);
  }
  d.prepare("INSERT INTO AuthUsers (id,displayName) VALUES (?,?)").run(
    "example-user",
    "Example User",
  );
  d.prepare("INSERT INTO catalog_devices (id,type,brand,name) VALUES (?,?,?,?)").run(
    "old-device",
    "Console",
    "Example",
    "Example Console",
  );
  d.prepare("INSERT INTO catalog_device_specs (deviceId) VALUES (?)").run("old-device");
  d.prepare("INSERT INTO Devices (deviceId,deviceName) VALUES (?,?)").run(
    "old-scanned",
    "Example Scanned",
  );
  d.prepare("INSERT INTO device_reviews (deviceId,userId,rating) VALUES (?,?,?)").run(
    "old-device",
    "example-user",
    4,
  );
  return d;
}
const preserved = (d: Database.Database) =>
  ["AuthUsers", "Devices", "catalog_devices", "catalog_device_specs", "device_reviews"].map(
    (t) => ({
      sql: d.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t),
      rows: sha256Hex(canonicalJson(all(d, t))),
    }),
  );

function assertBatch(d: Database.Database, execution: ReturnType<typeof run>) {
  equations(execution.report);
  const batch = all(d, "mobile_import_batches").find(
    (r) => r.batch_id === execution.result.batchId,
  );
  if (execution.result.status !== "applied") return;
  expect(batch.input_sha256).toBe(sha256Hex(execution.input));
  expect(batch.plan_sha256).toBe(execution.report.planSha256);
  expect(batch.input_records).toBe(execution.report.records);
  for (const key of [
    "inserted",
    "inserted_quarantined",
    "inserted_superseded",
    "sighting_added",
    "unchanged",
    "model_code_resolved",
    "existing_quarantined",
    "existing_superseded",
  ] as const)
    expect(batch[key + "_count"]).toBe(execution.report.counts[key]);
}
function shuffled<T>(records: T[], seed: number): T[] {
  const output = [...records];
  for (let i = output.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}
const reportMembers = [
  "contract",
  "status",
  "inputSha256",
  "planSha256",
  "header",
  "records",
  "outcomes",
  "existingRowEffects",
  "identityConflicts",
  "counts",
  "hosts",
  "alreadyAppliedBatchId",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const countMembers = [
  "inserted",
  "inserted_quarantined",
  "inserted_superseded",
  "sighting_added",
  "unchanged",
  "model_code_resolved",
  "rejected",
  "blocked",
  "existing_quarantined",
  "existing_superseded",
];
const reasonCodes = new Set(
  "blank_line line_too_long bom_not_allowed invalid_utf8 malformed_json header_missing contract_mismatch missing_property unexpected_property invalid_value invalid_date observed_in_future header_duplicate unknown_record_type duplicate_record invalid_key text_too_long empty_list_use_not_stated unit_mismatch os_family_mismatch scope_market_mismatch unknown_source_ref source_ref_ambiguous unknown_family_key unknown_reference_key manufacturer_not_in_contract publisher_not_in_contract store_not_in_contract field_not_in_contract subject_level_not_allowed raw_page_stored evidence_kind_not_in_contract stale_same_source_observation listing_attribute_conflict attribute_differs model_code_changed model_code_removed model_code_already_assigned duplicate_source_scope source_conflict regional_assignment_unresolved enterprise_scope_not_retail research_declared_unresolved basis_source_not_recorded model_code_provenance_not_recorded".split(
    " ",
  ),
);
const exactMembers = (v: object, keys: string[]) =>
  expect(Object.keys(v).sort()).toEqual([...keys].sort());
function countsEnvelope(c: mobile.MobileImportCounts) {
  exactMembers(c, countMembers);
  for (const n of Object.values(c)) {
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  }
}
function applyEnvelope(r: mobile.MobileApplyResult) {
  exactMembers(r, ["status", "batchId", "counts", "existingBatch"]);
  expect(["applied", "already_applied", "no_changes"]).toContain(r.status);
  countsEnvelope(r.counts);
  if (r.batchId !== null) expect(r.batchId).toMatch(uuid);
  if (r.status === "already_applied") {
    expect(r.existingBatch).not.toBeNull();
    exactMembers(r.existingBatch!, ["batchId", "appliedAt", "counts"]);
    expect(r.existingBatch!.batchId).toMatch(uuid);
    expect(r.existingBatch!.appliedAt).toMatch(utc);
    countsEnvelope(r.existingBatch!.counts);
  } else expect(r.existingBatch).toBeNull();
}
function reportEnvelope(r: mobile.MobileImportReport) {
  exactMembers(r, reportMembers);
  expect(r.contract).toBe(mobile.MOBILE_STAGING_CONTRACT);
  expect(["applicable", "not_applicable", "no_changes", "already_applied"]).toContain(r.status);
  expect(r.inputSha256).toMatch(hex);
  if (r.planSha256 !== null) expect(r.planSha256).toMatch(hex);
  if (r.alreadyAppliedBatchId !== null) expect(r.alreadyAppliedBatchId).toMatch(uuid);
  exactMembers(r.header, ["line", "status", "reasons"]);
  expect([1, null]).toContain(r.header.line);
  expect(["accepted", "rejected"]).toContain(r.header.status);
  for (const reason of r.header.reasons) expect(reasonCodes.has(reason)).toBe(true);
  for (const o of r.outcomes) {
    exactMembers(o, ["line", "recordType", "status", "ref", "reasons"]);
    expect(Number.isInteger(o.line) && o.line >= 2).toBe(true);
    expect([
      "header",
      "source",
      "family",
      "reference",
      "variant",
      "observation",
      "listing",
      null,
    ]).toContain(o.recordType);
    expect(countMembers.slice(0, 8)).toContain(o.status);
    if (o.ref !== null) expect(o.ref).toMatch(hex);
    for (const reason of o.reasons) expect(reasonCodes.has(reason)).toBe(true);
  }
  for (const e of r.existingRowEffects) {
    exactMembers(e, ["table", "ref", "transition", "reason", "causedByLines"]);
    expect(e.table).toBe("mobile_observations");
    expect(e.ref).toMatch(hex);
    expect(["accepted_to_quarantined", "accepted_to_superseded"]).toContain(e.transition);
    if (e.reason !== null) expect(reasonCodes.has(e.reason)).toBe(true);
    expect(e.causedByLines.every((n) => Number.isInteger(n) && n >= 2)).toBe(true);
  }
  for (const c of r.identityConflicts) {
    exactMembers(c, ["line", "ref", "reason", "attribute"]);
    expect(c.ref).toMatch(hex);
    expect(reasonCodes.has(c.reason)).toBe(true);
    if (c.attribute !== null)
      expect(ddl).toMatch(new RegExp("\\b" + c.attribute + "\\s+(TEXT|REAL|INTEGER)"));
  }
  expect(r.hosts).toEqual(r.hosts.length ? ["example.invalid"] : []);
  countsEnvelope(r.counts);
  equations(r);
}
function fileEnvelope(file: any) {
  exactMembers(file, [...reportMembers, "mode", "apply"]);
  expect(["dry_run", "apply"]).toContain(file.mode);
  const { mode: _mode, apply: result, ...report } = file;
  reportEnvelope(report);
  if (result !== null) {
    if ("error" in result) {
      exactMembers(result, ["error"]);
      expect([
        "input_mismatch",
        "plan_stale",
        "plan_not_applicable",
        "plan_digest_missing",
        "tables_missing",
        "input_too_large",
      ]).toContain(result.error);
    } else applyEnvelope(result);
  }
}
function consoleEnvelope(line: any) {
  exactMembers(line, ["mode", "status", "inputSha256", "counts", "batchId"]);
  expect(["dry_run", "apply"]).toContain(line.mode);
  expect([
    "applicable",
    "not_applicable",
    "already_applied",
    "no_changes",
    "applied",
    "input_mismatch",
    "plan_stale",
    "plan_not_applicable",
    "plan_digest_missing",
  ]).toContain(line.status);
  expect(line.inputSha256).toMatch(hex);
  countsEnvelope(line.counts);
  if (line.batchId !== null) expect(line.batchId).toMatch(uuid);
}

describe("AI-092 offline mobile staging", () => {
  it("U-01 DDL and authoritative columns agree", () => {
    const d = db();
    const inventory = dbSource.slice(dbSource.indexOf("const AUTHORITATIVE_TABLES"));
    for (const t of tables) {
      const columns = d.prepare(`PRAGMA table_info(${t})`).all() as {
        name: string;
        type: string;
      }[];
      const entry = inventory.match(new RegExp(t + ": \\{([\\s\\S]*?)\\n  \\}"))![1];
      expect(
        [...entry.matchAll(/(\w+): "(\w+)"/g)].map((m) => ({ name: m[1], type: m[2] })),
      ).toEqual(columns.map((c) => ({ name: c.name, type: c.type })));
    }
  });
  it("U-02 no case-insensitive table collision", () => {
    const names = [...dbSource.matchAll(/CREATE TABLE IF NOT EXISTS ["`]?([\w]+)/g)].map((m) =>
      m[1].toLowerCase(),
    );
    for (const t of tables) expect(names.filter((n) => n === t)).toHaveLength(1);
  });
  it("U-03 additive idempotent migration preserves catalogue constraints and rows", () => {
    const d = preservationDb(),
      before = preserved(d);
    d.exec(ddl);
    d.exec(ddl);
    expect(preserved(d)).toEqual(before);
    for (const type of ["Phone", "Tablet"])
      expect(() =>
        d
          .prepare("INSERT INTO catalog_devices (id,type,brand,name) VALUES (?,?,?,?)")
          .run(type, type, "Example", "Example"),
      ).toThrow();
  });
  it("U-04 rollback removes mobile schema only and can be reapplied", () => {
    const d = preservationDb(),
      before = preserved(d);
    d.exec(ddl);
    run(d);
    d.exec(readFileSync("scripts/rollback-mobile-catalogue-tables.sql", "utf8"));
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%mobile%'").all()).toEqual(
      [],
    );
    expect(preserved(d)).toEqual(before);
    expect(d.pragma("foreign_key_check")).toEqual([]);
    d.exec(ddl);
    expect(d.pragma("foreign_key_check")).toEqual([]);
  });
  it("U-05 structural CHECKs and uniqueness reject forbidden data", () => {
    const d = db();
    run(d);
    const mutate = (t: string, column: string, value: unknown) =>
      expect(() => d.prepare(`UPDATE ${t} SET ${column} = ?`).run(value)).toThrow();
    for (const [t, column, value] of [
      ["mobile_import_batches", "input_records", 99],
      ["mobile_import_batches", "batch_id", "bad"],
      ["mobile_import_batches", "contract", "bad"],
      ["mobile_sources", "raw_page_stored", 1],
      ["mobile_sources", "url", "http://example.invalid"],
      ["mobile_sources", "market", "us"],
      ["mobile_sources", "access_method", "crawler"],
      ["mobile_sources", "publisher", ""],
      ["mobile_import_batches", "applied_at", "not-a-timestamp"],
      ["mobile_import_batches", "input_sha256", "x".repeat(64)],
      ["mobile_import_batches", "inserted_count", -1],
      ["mobile_device_families", "device_class", "PC"],
      ["mobile_device_families", "os_family", "android"],
      ["mobile_device_families", "family_key", "bad:key:extra"],
      ["mobile_device_families", "marketing_name", "bad\nname"],
      ["mobile_hardware_references", "scope_market", null],
      ["mobile_hardware_references", "model_code", "XX"],
      ["mobile_hardware_references", "reference_key", "other:family:ref"],
      ["mobile_device_variants", "ram_gb", 0],
      ["mobile_device_variants", "storage_gb", 1.5],
      ["mobile_device_variants", "sku_status", "retail_sku_resolved"],
      ["mobile_device_variants", "variant_key", "bad"],
      ["mobile_variant_sightings", "observed_on", "bad"],
      ["mobile_observations", "value_state", "not_stated_by_source"],
      ["mobile_observations", "value_number", 8],
      ["mobile_observations", "is_exhaustive", 2],
      ["mobile_observations", "subject_level", "variant"],
      ["mobile_observations", "family_key", "apple:example"],
      ["mobile_observations", "observed_on", "bad"],
      ["mobile_observations", "unit", "x".repeat(9)],
      ["mobile_observations", "review_state", "quarantined"],
      ["mobile_observations", "review_state", "superseded"],
      ["mobile_observations", "scope_qualifier", "enterprise_edition_only"],
      ["mobile_observations", "value_json", "{}"],
      ["mobile_listing_observations", "match_basis", "installation"],
      ["mobile_listing_observations", "store", "other"],
      ["mobile_listing_observations", "store_country", "us"],
      ["mobile_listing_observations", "store_app_id", "bad/path"],
    ])
      mutate(t as string, column as string, value);
    for (const field of [
      "gpu_tier",
      "cpu_tier",
      "gpu_vram_gb",
      "vram_gb",
      "dedicated_vram_gb",
      "tdp_watts",
      "fps",
      "measured_fps",
      "avg_fps",
      "benchmark_score",
      "performance_tier",
      "virtual_ram_gb",
    ])
      mutate("mobile_observations", "field", field);
    for (const kind of ["installation_tested", "measured_performance", "not_listed"])
      mutate("mobile_listing_observations", "evidence_kind", kind);
    for (const t of [
      "mobile_variant_sightings",
      "mobile_listing_observations",
      "mobile_hardware_references",
    ])
      expect(() => d.exec(`INSERT INTO ${t} SELECT * FROM ${t}`)).toThrow();
    const batch = all(d, "mobile_import_batches")[0];
    const cols = Object.keys(batch);
    const zeroBatch = {
      ...batch,
      batch_id: "11111111-1111-1111-1111-111111111111",
      input_sha256: "a".repeat(64),
      inserted_count: 0,
      unchanged_count: 6,
    };
    expect(() =>
      d
        .prepare(
          `INSERT INTO mobile_import_batches (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        )
        .run(...cols.map((k) => zeroBatch[k as keyof typeof zeroBatch])),
    ).toThrow();
    const cloneReference = (patch: Record<string, unknown>) => {
      const row = { ...all(d, "mobile_hardware_references")[0], ...patch };
      const columns = Object.keys(row);
      return () =>
        d
          .prepare(
            `INSERT INTO mobile_hardware_references (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...columns.map((k) => row[k]));
    };
    expect(cloneReference({ reference_key: "apple:example:other" })).toThrow(/UNIQUE/);
    const batchId = all(d, "mobile_import_batches")[0].batch_id;
    d.prepare(
      "UPDATE mobile_hardware_references SET model_code = ?, scope_market = NULL, model_code_source_key = basis_source_key, model_code_observed_on = ?, model_code_batch_id = ?",
    ).run("XX01", "2026-10-21", batchId);
    expect(cloneReference({ reference_key: "apple:example:other" })).toThrow(/UNIQUE/);
  });
  it("U-06 existing platform taxonomy covers all mobile OS families", () => {
    for (const [osName, label] of [
      ["ios", "Mobile – iOS"],
      ["iPad", "Mobile – iOS"],
      ["android", "Mobile – Android"],
    ]) {
      expect(normalizePlatform(osName)).toBe(label);
      expect(CANONICAL_PLATFORMS).toContain(label);
    }
  });
  it("U-07 planning writes nothing and supports a read-only database", () => {
    const file = path.join(temp(), "fixture.db");
    const d = db(file),
      before = snapshot(d);
    plan(d, bytes(), { now });
    expect(snapshot(d)).toEqual(before);
    const readOnly = new Database(file, { readonly: true });
    try {
      expect(plan(readOnly, bytes(), { now }).status).toBe("applicable");
    } finally {
      readOnly.close();
    }
  });
  it("U-08 apply stores exact input and plan digests and counters", () => {
    const d = db();
    const { report, result, input } = run(d);
    expect(result.status).toBe("applied");
    expect(result.counts).toEqual(report.counts);
    const batches = all(d, "mobile_import_batches");
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      input_sha256: sha256Hex(input),
      plan_sha256: report.planSha256,
      input_records: 6,
      inserted_count: 6,
    });
    equations(report);
  });
  it("U-09 repeat precedence, resolution replay and null digest refusals", () => {
    const d = db(),
      a = run(d, base());
    for (const digest of [null, "wrong", a.report.planSha256]) {
      const before = snapshot(d);
      const result = apply(
        d,
        a.input,
        { inputSha256: a.report.inputSha256, planSha256: digest },
        { now },
      );
      expect(result.status).toBe("already_applied");
      expect(result.batchId).toBe(a.result.batchId);
      expect(Object.values(result.counts).every((v) => v === 0)).toBe(true);
      expect(snapshot(d)).toEqual(before);
    }
    run(d, [
      source(),
      family(),
      reference({
        model_code: "XX01",
        scope_market: null,
        model_code_source_ref: "s",
        model_code_observed_on: "2026-10-21",
      }),
    ]);
    const report = plan(d, a.input, { now });
    expect(report.status).toBe("already_applied");
    expect(report.planSha256).toBeNull();
    expect(report.identityConflicts).toHaveLength(1);
    expect(report.identityConflicts[0]).toMatchObject({
      reason: "model_code_removed",
      attribute: null,
    });
    equations(report);
    const before = snapshot(d);
    expect(apply(d, a.input, report, { now }).existingBatch?.counts).toEqual(a.result.counts);
    expect(snapshot(d)).toEqual(before);
    const other = bytes([source({ ref: "t", url: "https://example.invalid/other" })]);
    const p = plan(d, other, { now });
    expect(() => apply(d, other, { ...p, planSha256: null }, { now })).toThrow(
      "plan_digest_missing",
    );
    const invalid = bytes([source({ raw_page_stored: true })]);
    expect(() =>
      apply(d, invalid, { inputSha256: sha256Hex(invalid), planSha256: null }, { now }),
    ).toThrow("plan_not_applicable");
  });
  it("U-10 byte-different overlaps and empty plans create no redundant batches", () => {
    const d = db();
    run(d, base());
    const input = Buffer.from(bytes(base()).toString().replace(/\n/g, "\r\n"));
    const before = snapshot(d),
      p = plan(d, input, { now });
    expect(p.status).toBe("no_changes");
    expect(apply(d, input, p, { now }).status).toBe("no_changes");
    expect(snapshot(d)).toEqual(before);
    expect(run(d, [...base(), variant()]).report.counts).toMatchObject({
      unchanged: 3,
      inserted: 1,
    });
  });
  it("U-11 overlapping markets quarantine conflicting facts only", () => {
    const d = db();
    run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2", market: "ZA" }),
      observation({ market: "GLOBAL" }),
      observation({ source_ref: "t", market: "ZA", value: "Other Chip" }),
      observation({ field: "ram_gb", value: 8, unit: "GB" }),
    ]);
    expect(
      fieldRows(d)
        .filter((r) => r.field === "soc_name")
        .every((r) => r.quarantine_reason === "source_conflict"),
    ).toBe(true);
    expect(fieldRows(d).find((r) => r.field === "ram_gb").review_state).toBe("accepted");
  });
  it("U-12 non-overlapping family hardware markets remain accepted", () => {
    const d = db();
    run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      observation({ subject_level: "family", subject_key: "apple:example" }),
      observation({
        subject_level: "family",
        subject_key: "apple:example",
        source_ref: "t",
        market: "ID",
        value: "Other Chip",
      }),
    ]);
    expect(fieldRows(d).map((r) => r.review_state)).toEqual(["accepted", "accepted"]);
  });
  it("U-13 later conflicts report exactly one existing-row transition", () => {
    const d = db();
    run(d, [...base(), observation()]);
    const { report, result } = run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      observation({ source_ref: "t", value: "Other Chip" }),
    ]);
    expect(report.counts.existing_quarantined).toBe(1);
    expect(report.existingRowEffects[0]).toMatchObject({
      transition: "accepted_to_quarantined",
      reason: "source_conflict",
      causedByLines: [6],
    });
    expect(fieldRows(d).every((r) => r.quarantined_batch_id === result.batchId)).toBe(true);
  });
  it("U-14 shuffled file keeps domain state and line semantics", () => {
    const records = [
      ...fixture(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      variant({ basis_source_ref: "t" }),
      observation({ observed_on: "2026-10-19", value: "Old Chip" }),
      observation({ source_ref: "t", value: "Conflict Chip" }),
      observation({
        field: "ram_gb",
        value: 8,
        unit: "GB",
        declared_quarantine: "research_declared_unresolved",
      }),
    ];
    const a = db(),
      b = db();
    const ar = run(a, records),
      br = run(b, [...records].reverse());
    expect(domain(a)).toEqual(domain(b));
    expect(ar.report.inputSha256).not.toBe(br.report.inputSha256);
    const semantics = (r: mobile.MobileImportReport) =>
      r.outcomes
        .map((o) => [o.ref, o.status, o.reasons])
        .sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y)));
    expect(semantics(ar.report)).toEqual(semantics(br.report));
    expect(ar.report.counts).toEqual(br.report.counts);
  });
  it("U-15 marketing names never join identities", () => {
    const d = db();
    run(d, [source(), family(), family({ family_key: "apple:other" })]);
    expect(all(d, "mobile_device_families")).toHaveLength(2);
    reject(
      d,
      [
        source(),
        reference({ family_key: "apple:missing", reference_key: "apple:missing:us-cellular-5g" }),
      ],
      "unknown_family_key",
    );
  });
  it("U-16 identity conflicts block all writes", () => {
    for (const [patch, reason] of [
      [{ reference_label: "Changed" }, "attribute_differs"],
      [{ connectivity: "unknown" }, "attribute_differs"],
      [{ model_code: "YY02" }, "model_code_changed"],
      [
        {
          model_code: null,
          scope_market: "US",
          model_code_source_ref: null,
          model_code_observed_on: null,
        },
        "model_code_removed",
      ],
    ] as const) {
      const d = db();
      run(d, [source(), family(), codeReference()]);
      const r = reject(d, [source(), family(), codeReference(patch)], reason);
      expect(r.identityConflicts.some((c) => c.reason === reason)).toBe(true);
    }
    const d = db();
    run(d, [source(), family(), codeReference()]);
    reject(
      d,
      [source(), family(), codeReference({ reference_key: "apple:example:other" })],
      "model_code_already_assigned",
    );
    reject(
      d,
      [...base(), reference({ reference_key: "apple:example:other" })],
      "duplicate_source_scope",
    );
  });
  it("U-17 resolution preserves key and markets while recording code provenance", () => {
    const d = db();
    run(d, [...base(), observation()]);
    const { report, result } = run(d, [
      source(),
      family(),
      reference({
        model_code: "XX01",
        scope_market: null,
        model_code_source_ref: "s",
        model_code_observed_on: "2026-10-21",
      }),
    ]);
    expect(report.counts.model_code_resolved).toBe(1);
    expect(all(d, "mobile_hardware_references")[0]).toMatchObject({
      reference_key: reference().reference_key,
      scope_market: null,
      model_code: "XX01",
      model_code_batch_id: result.batchId,
    });
    expect(fieldRows(d)[0].market).toBe("US");
  });
  it("U-18 same-source chains, stale rejection and same-day disagreement", () => {
    const d = db();
    run(d, [
      ...base(),
      observation({ observed_on: "2026-10-19" }),
      observation({ observed_on: "2026-10-20", value: "Middle Chip" }),
      observation({ value: "New Chip" }),
    ]);
    const ordered = fieldRows(d).sort((a, b) => a.observed_on.localeCompare(b.observed_on));
    expect(ordered.map((r) => r.review_state)).toEqual(["superseded", "superseded", "accepted"]);
    expect(ordered[0].superseded_by).toBe(ordered[1].observation_key);
    expect(ordered[1].superseded_by).toBe(ordered[2].observation_key);
    reject(
      d,
      [...base(), observation({ observed_on: "2026-10-18" })],
      "stale_same_source_observation",
    );
    run(d, [...base(), observation({ value: "Disagree Chip" })]);
    expect(
      fieldRows(d)
        .filter((r) => r.observed_on === "2026-10-21")
        .every((r) => r.review_state === "quarantined"),
    ).toBe(true);
  });
  it("U-19 quarantine never clears through replay, corroboration or newer statements", () => {
    const d = db();
    const row = observation({
      observed_on: "2026-10-19",
      declared_quarantine: "research_declared_unresolved",
    });
    run(d, [...base(), row]);
    const key = fieldRows(d)[0].observation_key;
    for (const records of [
      [...base(), observation({ observed_on: "2026-10-19" })],
      [...base(), observation({ observed_on: "2026-10-20" })],
      [
        ...base(),
        source({ ref: "t", url: "https://example.invalid/s2" }),
        observation({ source_ref: "t" }),
      ],
      [...base(), observation({ value: "Later Chip" })],
    ]) {
      run(d, records);
      expect(fieldRows(d).find((r) => r.observation_key === key).review_state).toBe("quarantined");
    }
    const code = readFileSync("src/services/mobileCatalogueImport.ts", "utf8");
    expect(code).not.toMatch(/UPDATE[^;]+SET review_state = 'accepted'/);
    expect(code).not.toMatch(/\bDELETE\b/);
  });
  it("U-20 enterprise observations stay at asserted level and always quarantine", () => {
    const d = db();
    run(d, [
      ...base(),
      observation({
        subject_level: "family",
        subject_key: "apple:example",
        field: "security_update_cadence",
        value: "monthly",
        scope_qualifier: "enterprise_edition_only",
      }),
    ]);
    expect(fieldRows(d)).toHaveLength(1);
    expect(fieldRows(d)[0]).toMatchObject({
      family_key: "apple:example",
      reference_key: null,
      quarantine_reason: "enterprise_scope_not_retail",
    });
  });
  it("U-21 declarations quarantine existing accepted rows with input origin", () => {
    const d = db();
    run(d, [...base(), observation()]);
    const { report } = run(d, [
      ...base(),
      observation({ declared_quarantine: "regional_assignment_unresolved" }),
    ]);
    expect(report.counts.existing_quarantined).toBe(1);
    expect(fieldRows(d)[0]).toMatchObject({
      quarantine_reason: "regional_assignment_unresolved",
      quarantine_origin: "input_declared",
    });
  });
  it("U-22 unknown is NULL and empty arrays never become invented values", () => {
    const d = db();
    run(d, [
      ...base(),
      observation({
        field: "ram_options_gb",
        value_state: "not_stated_by_source",
        value: null,
        unit: "GB",
        is_exhaustive: null,
      }),
    ]);
    expect(fieldRows(d)[0]).toMatchObject({
      value_text: null,
      value_number: null,
      value_json: null,
      is_exhaustive: null,
    });
    reject(
      d,
      [
        ...base(),
        observation({ field: "ram_options_gb", value: [], unit: "GB", is_exhaustive: 0 }),
      ],
      "empty_list_use_not_stated",
    );
  });
  it("U-23 variants keep every independent sighting and never expand RAM lists", () => {
    const d = db();
    run(d, [
      ...base(),
      variant(),
      observation({ field: "ram_options_gb", value: [8, 16], unit: "GB", is_exhaustive: 1 }),
    ]);
    const result = run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      variant({ basis_source_ref: "t" }),
    ]);
    expect(result.report.counts.sighting_added).toBe(1);
    expect(all(d, "mobile_device_variants")).toHaveLength(1);
    expect(all(d, "mobile_variant_sightings")).toHaveLength(2);
    expect(run(d, [...base(), variant()]).report.counts.unchanged).toBe(4);
  });
  it("U-24 only conditional publisher listings are representable", () => {
    const d = db();
    for (const kind of ["installation_tested", "measured_performance", "not_listed"])
      reject(d, [...base(), listing({ evidence_kind: kind })], "evidence_kind_not_in_contract");
    run(d, [...base(), listing()]);
    expect(all(d, "mobile_listing_observations")[0].evidence_kind).toBe("publisher_listed");
    expect(fieldRows(d)).toEqual([]);
  });
  it("U-25 minimisation rejects prose, extra properties and performance values", () => {
    const d = db();
    for (const [record, reason] of [
      [family({ extra: "prose" }), "unexpected_property"],
      [family({ marketing_name: "X".repeat(81) }), "text_too_long"],
      [family({ marketing_name: "bad\nname" }), "invalid_value"],
      [source({ raw_page_stored: true }), "raw_page_stored"],
      [observation({ value: { chip: "bad" } }), "invalid_value"],
    ] as const)
      reject(d, [...base().filter((r) => r.record_type !== record.record_type), record], reason);
    for (const field of ["usb_data_version", "gpu_tier", "vram_gb", "tdp_watts", "measured_fps"])
      reject(d, [...base(), observation({ field })], "field_not_in_contract");
  });
  it("U-26 UTC date validation rejects impossible, future and overprecise dates", () => {
    const d = db();
    for (const date of ["2026-02-29", "2026-02-30", "1999-01-01", "2026-10-21T00:00:00Z"])
      reject(d, [...base(), observation({ observed_on: date })], "invalid_date");
    reject(d, [...base(), observation({ observed_on: "2026-10-22" })], "observed_in_future");
    reject(
      d,
      [...base(), observation({ source_updated_at: "2026-10-21", observed_on: "2026-10-20" })],
      "invalid_date",
    );
  });
  it("U-27 schema carries no user or physical device identifiers", () => {
    const d = db();
    for (const t of tables)
      expect(
        (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) =>
          /user|email|imei|serial|account/i.test(c.name),
        ),
      ).toBe(false);
  });
  it("U-28 command refuses unsafe targets and applies/replays with bounded outputs", () => {
    const dir = temp(),
      file = path.join(dir, "fixture.db"),
      input = path.join(dir, "input.jsonl");
    const d = db(file);
    writeFileSync(input, bytes());
    const log = vi.spyOn(console, "log").mockImplementation(() => {}),
      err = vi.spyOn(console, "error").mockImplementation(() => {});
    const args = (r: string) => ["--db", file, "--in", input, "--report", r];
    for (const argv of [
      [],
      ["--in", input],
      args(path.resolve("refused-mobile.json")),
      [...args(path.join(dir, "x.json")), "--unknown"],
    ]) {
      log.mockClear();
      expect(main(argv, now)).toBe(2);
      expect(log).not.toHaveBeenCalled();
    }
    vi.stubEnv("NODE_ENV", "production");
    expect(main(args(path.join(dir, "prod.json")), now)).toBe(2);
    expect(existsSync(path.join(dir, "prod.json"))).toBe(false);
    vi.unstubAllEnvs();
    const empty = path.join(dir, "empty.db");
    const e = new Database(empty);
    e.close();
    expect(
      main(["--db", empty, "--in", input, "--report", path.join(dir, "missing.json")], now),
    ).toBe(2);
    const first = path.join(dir, "first.json"),
      second = path.join(dir, "second.json");
    const review1 = buildMobileApplyReview({
      dbPath: file,
      inputPath: input,
      dir,
      prefix: "rev-first",
      now,
    });
    expect(main([...args(first), "--apply", ...review1.flags], now)).toBe(0);
    const before = snapshot(d);
    expect(main([...args(second), "--apply", ...review1.flags], now)).toBe(0);
    expect(snapshot(d)).toEqual(before);
    expect(JSON.parse(readFileSync(second, "utf8")).apply.status).toBe("already_applied");
    log.mockClear();
    expect(main(args(first), now)).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    // Exact-byte replay after another file resolves the source-scoped identity.
    const original = bytes();
    writeFileSync(input, original);
    const fileA = path.join(dir, "a.json");
    expect(main([...args(fileA), "--apply", ...review1.flags], now)).toBe(0);
    const batchA = JSON.parse(readFileSync(fileA, "utf8")).apply.batchId;
    writeFileSync(
      input,
      bytes([
        source(),
        family(),
        reference({
          model_code: "XX01",
          scope_market: null,
          model_code_source_ref: "s",
          model_code_observed_on: "2026-10-21",
        }),
      ]),
    );
    const reviewB = buildMobileApplyReview({
      dbPath: file,
      inputPath: input,
      dir,
      prefix: "rev-b",
      now,
    });
    expect(main([...args(path.join(dir, "b.json")), "--apply", ...reviewB.flags], now)).toBe(0);
    writeFileSync(input, original);
    for (const flag of [[], ["--apply"]]) {
      const target = path.join(dir, `replay-${flag.length}.json`),
        beforeReplay = snapshot(d);
      log.mockClear();
      const reviewFlags = flag.length ? review1.flags : [];
      expect(main([...args(target), ...flag, ...reviewFlags], now)).toBe(0);
      const report = JSON.parse(readFileSync(target, "utf8"));
      expect(report.status).toBe("already_applied");
      expect(report.planSha256).toBeNull();
      expect(report.apply).toEqual(
        flag.length
          ? expect.objectContaining({ status: "already_applied", batchId: batchA })
          : null,
      );
      expect(snapshot(d)).toEqual(beforeReplay);
      const consoleLine = JSON.parse(log.mock.calls[0][0]);
      expect(Object.keys(consoleLine).sort()).toEqual(
        ["mode", "status", "inputSha256", "counts", "batchId"].sort(),
      );
      expect(consoleLine.batchId).toBe(batchA);
    }
    writeFileSync(input, bytes([source({ raw_page_stored: true })]));
    for (const flag of [[], ["--apply"]]) {
      const report = path.join(dir, `invalid-${flag.length}.json`);
      expect(main([...args(report), ...flag], now)).toBe(2);
      if (flag.length) {
        expect(existsSync(report)).toBe(false);
      } else {
        expect(JSON.parse(readFileSync(report, "utf8")).apply).toBeNull();
      }
    }
  });
  it("U-29 importer never imports the application database", () => {
    expect(readFileSync("src/services/mobileCatalogueImport.ts", "utf8")).not.toMatch(
      /from ["']\.\.\/db/,
    );
  });
  it("U-30 JSON state export remains independent of staging", () => {
    expect(readFileSync("src/routes/state.ts", "utf8")).not.toContain("mobile_");
  });
  it("U-31 altered input refuses before any transaction", () => {
    const d = db(),
      input = bytes(),
      p = plan(d, input, { now }),
      before = snapshot(d);
    expect(() => apply(d, Buffer.concat([input, Buffer.from(" ")]), p, { now })).toThrow(
      "input_mismatch",
    );
    expect(snapshot(d)).toEqual(before);
  });
  it("U-32 changed database invalidates the old plan", () => {
    const d = db();
    run(d, base());
    const input = bytes([...base(), observation()]),
      p = plan(d, input, { now });
    run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      observation({ source_ref: "t", value: "Other Chip" }),
    ]);
    const before = snapshot(d);
    expect(() => apply(d, input, p, { now })).toThrow("plan_stale");
    expect(snapshot(d)).toEqual(before);
  });
  it("U-33 digests cannot authorize another input", () => {
    const d = db(),
      a = bytes(),
      b = bytes(base()),
      pa = plan(d, a, { now }),
      pb = plan(d, b, { now }),
      before = snapshot(d);
    expect(() =>
      apply(d, a, { inputSha256: pa.inputSha256, planSha256: pb.planSha256 }, { now }),
    ).toThrow("plan_stale");
    expect(() => apply(d, b, pa, { now })).toThrow("input_mismatch");
    expect(snapshot(d)).toEqual(before);
  });
  it("U-34 exact runtime exports expose no write plan", () => {
    expect(Object.keys(mobile).sort()).toEqual(
      [
        "MOBILE_STAGING_CONTRACT",
        "MOBILE_STAGING_TABLES",
        "MOBILE_MANUFACTURERS",
        "MOBILE_SOURCE_PUBLISHERS",
        "MOBILE_STORES",
        "MOBILE_OBSERVATION_FIELDS",
        "MOBILE_IMPORT_LIMITS",
        "MobileImportError",
        "mobileReportRef",
        "parseMobileStagingJsonl",
        "planMobileImport",
        "applyMobileImport",
      ].sort(),
    );
    expect(plan(db(), bytes(), { now })).not.toHaveProperty("writePlan");
  });
  it("U-35 plan digest is deterministic and binds database effects", () => {
    const d = db(),
      input = bytes();
    const a = plan(d, input, { now });
    expect(plan(d, input, { now }).planSha256).toBe(a.planSha256);
    run(d, base());
    expect(plan(d, input, { now }).planSha256).not.toBe(a.planSha256);
  });
  it("U-36 code hardware overlaps markets; support stays market specific", () => {
    for (const different of [false, true]) {
      const d = db();
      run(d, [
        source(),
        source({ ref: "t", url: "https://example.invalid/s2", market: "CA" }),
        family(),
        codeReference(),
        observation({ subject_key: "apple:example:xx01" }),
        observation({
          subject_key: "apple:example:xx01",
          source_ref: "t",
          market: "CA",
          value: different ? "Other Chip" : "Example Chip",
        }),
        observation({
          subject_key: "apple:example:xx01",
          field: "update_policy_years",
          value: 5,
          unit: "year",
        }),
        observation({
          subject_key: "apple:example:xx01",
          field: "update_policy_years",
          value: 6,
          unit: "year",
          source_ref: "t",
          market: "CA",
        }),
      ]);
      expect(
        fieldRows(d)
          .filter((r) => r.field === "soc_name")
          .every((r) => r.review_state === (different ? "quarantined" : "accepted")),
      ).toBe(true);
      expect(
        fieldRows(d)
          .filter((r) => r.field === "update_policy_years")
          .every((r) => r.review_state === "accepted"),
      ).toBe(true);
    }
  });
  it("U-37 listing slot checked before content, all collisions reported", () => {
    const d = db();
    for (const patch of [
      { game_title: "Another Game" },
      { listed_name: "Other Name" },
      { required_os: "iOS 20" },
    ]) {
      const r = reject(d, [...base(), listing(), listing(patch)], "listing_attribute_conflict");
      expect(
        r.outcomes
          .filter((o) => o.recordType === "listing")
          .every((o) => o.reasons.includes("listing_attribute_conflict")),
      ).toBe(true);
    }
    const r = reject(
      d,
      [...base(), listing(), listing(), listing({ game_title: "Other" })],
      "listing_attribute_conflict",
    );
    expect(r.outcomes.filter((o) => o.reasons.includes("duplicate_record"))).toHaveLength(2);
    run(d, [...base(), listing()]);
    reject(d, [...base(), listing({ game_title: "Other Game" })], "listing_attribute_conflict");
    run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      listing({ source_ref: "t" }),
      listing({ observed_on: "2026-10-20" }),
    ]);
    expect(all(d, "mobile_listing_observations")).toHaveLength(3);
    expect(fieldRows(d)).toEqual([]);
  });
  it("U-38 identity equality excludes later basis and equal-code provenance", () => {
    const d = db();
    run(d, [source(), family(), codeReference()]);
    const { report } = run(d, [
      source({ ref: "t", url: "https://example.invalid/s2" }),
      family({ basis_source_ref: "t" }),
      codeReference({
        basis_source_ref: "t",
        model_code_source_ref: "t",
        model_code_observed_on: "2026-10-20",
      }),
    ]);
    expect(report.outcomes[1]).toMatchObject({
      status: "unchanged",
      reasons: ["basis_source_not_recorded"],
    });
    expect(report.outcomes[2].reasons).toEqual([
      "basis_source_not_recorded",
      "model_code_provenance_not_recorded",
    ]);
  });
  it("U-39 counter equations hold for success, blocked and repeat evaluations", () => {
    const d = db();
    const a = run(d);
    equations(a.report);
    equations(plan(d, a.input, { now }));
    const r = reject(d, [...base(), observation({ field: "fps" })], "field_not_in_contract");
    expect(r.counts.blocked).toBe(3);
  });
  it("U-40 fatal decoder, BOM, line bounds, CRLF and trailing LF", () => {
    const d = db(),
      h = bytes([]),
      s = Buffer.from(JSON.stringify(source()) + "\n");
    for (const [input, reason] of [
      [Buffer.concat([h, Buffer.from([255]), Buffer.from("\n")]), "invalid_utf8"],
      [Buffer.concat([h, Buffer.from([239, 187, 191]), s]), "bom_not_allowed"],
      [Buffer.concat([h, Buffer.from("x".repeat(4097) + "\n")]), "line_too_long"],
    ] as const)
      expect(plan(d, input, { now }).outcomes[0].reasons).toEqual([reason]);
    expect(
      plan(d, Buffer.concat([Buffer.from([239, 187, 191]), h]), { now }).header.reasons,
    ).toEqual(["bom_not_allowed"]);
    const lf = plan(d, bytes(), { now }),
      crlf = plan(d, Buffer.from(bytes().toString().replace(/\n/g, "\r\n")), { now });
    expect(crlf.outcomes).toEqual(lf.outcomes);
    expect(crlf.inputSha256).not.toBe(lf.inputSha256);
    expect(plan(d, Buffer.concat([h, Buffer.from("\n")]), { now }).outcomes[0].reasons).toEqual([
      "blank_line",
    ]);
    expect(
      plan(d, bytes([source(), family({ marketing_name: "Inside\uFEFFName" })]), { now }).status,
    ).toBe("applicable");
    expect(readFileSync("src/services/mobileCatalogueImport.ts", "utf8")).toContain(
      "ignoreBOM: true",
    );
  });
  it("U-41 planner handles uniqueness before SQLite backstops", () => {
    const d = db();
    const first = run(d);
    expect(() => apply(d, first.input, first.report, { now })).not.toThrow();
    reject(d, [...base(), variant(), variant()], "duplicate_record");
    reject(d, [...base(), listing(), listing()], "duplicate_record");
    expect(d.pragma("foreign_key_check")).toEqual([]);
  });
  it("U-42 newest-first writes satisfy immediate self foreign keys for opposite key orders", () => {
    for (const ascending of [true, false]) {
      let observations: ReturnType<typeof observation>[] = [];
      for (let n = 0; n < 1000; n++) {
        const candidates = [19, 20, 21].map((date, i) =>
          observation({ observed_on: `2026-10-${date}`, value: `Example Chip ${n + i}` }),
        );
        const probe = db();
        run(probe, [...base(), ...candidates]);
        const ordered = fieldRows(probe).sort((a, b) => a.observed_on.localeCompare(b.observed_on));
        const keys = ordered.map((r) => r.observation_key);
        if (
          ascending
            ? keys[0] < keys[1] && keys[1] < keys[2]
            : keys[0] > keys[1] && keys[1] > keys[2]
        ) {
          observations = candidates;
          break;
        }
      }
      expect(observations).toHaveLength(3);
      const d = db();
      run(d, [...base(), ...observations]);
      expect(d.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(d.pragma("foreign_key_check")).toEqual([]);
    }
    expect(readFileSync("src/services/mobileCatalogueImport.ts", "utf8")).not.toContain(
      "defer_foreign_keys",
    );
  });
  it("U-43 mandatory quarantine is assigned before supersession", () => {
    for (const enterprise of [false, true]) {
      const d = db();
      run(d, [
        ...base(),
        observation({
          observed_on: "2026-10-19",
          declared_quarantine: "research_declared_unresolved",
          ...(enterprise ? { scope_qualifier: "enterprise_edition_only" } : {}),
        }),
        observation(enterprise ? { scope_qualifier: "enterprise_edition_only" } : {}),
      ]);
      const first = fieldRows(d).find((r) => r.observed_on === "2026-10-19");
      expect(first.review_state).toBe("quarantined");
      expect(first.superseded_by).toBeNull();
      if (enterprise)
        expect(fieldRows(d).every((r) => r.review_state === "quarantined")).toBe(true);
    }
    const d = db();
    run(d, [...base(), observation({ observed_on: "2026-10-19" })]);
    const { report } = run(d, [
      ...base(),
      observation({
        observed_on: "2026-10-19",
        declared_quarantine: "regional_assignment_unresolved",
      }),
      observation(),
    ]);
    expect(report.counts.existing_quarantined).toBe(1);
    expect(report.counts.existing_superseded).toBe(0);
  });
  it("U-44 domain partition boundary and separate accounting are explicit", () => {
    const compare = (records: ReturnType<typeof observation>[], agree: boolean) => {
      const a = db(),
        b = db(),
        undated = [...base(), source({ ref: "t", url: "https://example.invalid/s2" })];
      run(a, undated);
      run(b, undated);
      const together = run(a, [...undated, ...records]);
      equations(together.report);
      for (const day of [...new Set(records.map((r) => r.observed_on))].sort())
        equations(run(b, [...undated, ...records.filter((r) => r.observed_on === day)]).report);
      if (agree) expect(domain(a)).toEqual(domain(b));
      else {
        expect(fieldRows(a).filter((r) => r.review_state === "quarantined")).toHaveLength(0);
        expect(fieldRows(b).filter((r) => r.review_state === "quarantined")).toHaveLength(2);
      }
      return [a, b];
    };
    const [a, b] = compare(
      [
        observation({ observed_on: "2026-10-19", value: "Old Chip" }),
        observation({ value: "New Chip" }),
      ],
      true,
    );
    expect(all(a, "mobile_import_batches")).toHaveLength(2);
    expect(all(b, "mobile_import_batches")).toHaveLength(3);
    compare(
      [
        observation({ observed_on: "2026-10-19", value: "Old Chip" }),
        observation({ observed_on: "2026-10-19", value: "New Chip", source_ref: "t" }),
        observation({ value: "New Chip" }),
      ],
      false,
    );
  });
  it("U-45 sighting creator is fixed by date then source, independent of line order", () => {
    const records = [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      variant(),
      variant({ basis_source_ref: "t" }),
      variant({ basis_source_ref: "t", observed_on: "2026-10-20" }),
    ];
    const a = db(),
      b = db();
    const ar = run(a, records),
      br = run(b, [...records].reverse());
    expect(ar.report.counts).toMatchObject({ inserted: 5, sighting_added: 2 });
    expect(domain(a)).toEqual(domain(b));
    expect(all(a, "mobile_device_variants")).toHaveLength(1);
    expect(all(a, "mobile_variant_sightings")).toHaveLength(3);
    expect(ar.report.counts).toEqual(br.report.counts);
  });
  it("U-46 complete edge-file reports and accounting", () => {
    const h = JSON.stringify(header),
      s = JSON.stringify(source()),
      s2 = JSON.stringify(source({ ref: "t", url: "https://example.invalid/s2" }));
    const cases: [string | Buffer, number, string[], string[], string][] = [
      ["", 0, ["header_missing"], [], "not_applicable"],
      [h, 0, [], [], "no_changes"],
      [h + "\n", 0, [], [], "no_changes"],
      [h + "\n" + s + "\n", 1, [], ["inserted"], "applicable"],
      [
        '{"record_type":"header"\n' + s + "\n",
        1,
        ["malformed_json"],
        ["blocked"],
        "not_applicable",
      ],
      [s + "\n" + s2 + "\n", 1, ["header_missing"], ["blocked"], "not_applicable"],
      [
        h + "\n" + s + "\n\n" + s2 + "\n",
        3,
        [],
        ["blocked", "rejected", "blocked"],
        "not_applicable",
      ],
      [h + "\n" + s + "\n\n", 2, [], ["blocked", "rejected"], "not_applicable"],
      [h + "\n" + s + "\n" + h + "\n", 2, [], ["blocked", "rejected"], "not_applicable"],
      [
        Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(h + "\n" + s + "\n")]),
        1,
        ["bom_not_allowed"],
        ["blocked"],
        "not_applicable",
      ],
      [h + "\n\n", 1, [], ["rejected"], "not_applicable"],
      ["\n", 0, ["blank_line"], [], "not_applicable"],
    ];
    for (const [input, n, reasons, statuses, status] of cases) {
      const d = db(),
        b = Buffer.isBuffer(input) ? input : Buffer.from(input),
        r = plan(d, b, { now });
      equations(r);
      expect(r.records).toBe(n);
      expect(r.header).toEqual({
        line: b.length ? 1 : null,
        status: reasons.length ? "rejected" : "accepted",
        reasons,
      });
      expect(r.outcomes.map((o) => o.status)).toEqual(statuses);
      expect(r.status).toBe(status);
      expect(r.inputSha256).toBe(sha256Hex(b));
      expect(r.existingRowEffects).toEqual([]);
      expect(r.identityConflicts).toEqual([]);
      expect(r.alreadyAppliedBatchId).toBeNull();
      const expectedCounts = {
        inserted: 0,
        inserted_quarantined: 0,
        inserted_superseded: 0,
        sighting_added: 0,
        unchanged: 0,
        model_code_resolved: 0,
        rejected: 0,
        blocked: 0,
        existing_quarantined: 0,
        existing_superseded: 0,
      };
      for (const status of statuses) expectedCounts[status as keyof typeof expectedCounts]++;
      const rawSegments = b.length ? b.toString().split("\n") : [];
      if (b.at(-1) === 10) rawSegments.pop();
      const expectedOutcomes = statuses.map((status, index) => {
        const segment = rawSegments[index + 1];
        const isHeader = segment === h;
        const recordType = segment === "" ? null : isHeader ? "header" : "source";
        const url = segment === s2 ? "https://example.invalid/s2" : "https://example.invalid/s1";
        return {
          line: index + 2,
          recordType,
          status,
          ref:
            recordType === "source"
              ? mobile.mobileReportRef("mobile_sources", ["src-" + sha256Hex(url).slice(0, 16)])
              : null,
          reasons: status === "rejected" ? [isHeader ? "header_duplicate" : "blank_line"] : [],
        };
      });
      expect(r).toEqual({
        contract: mobile.MOBILE_STAGING_CONTRACT,
        status,
        inputSha256: sha256Hex(b),
        planSha256: status === "not_applicable" ? null : expect.stringMatching(/^[0-9a-f]{64}$/),
        header: {
          line: b.length ? 1 : null,
          status: reasons.length ? "rejected" : "accepted",
          reasons,
        },
        records: n,
        outcomes: expectedOutcomes,
        counts: expectedCounts,
        hosts: expectedOutcomes.some((o) => o.recordType === "source") ? ["example.invalid"] : [],
        existingRowEffects: [],
        identityConflicts: [],
        alreadyAppliedBatchId: null,
      });
      if (status === "not_applicable") {
        const before = snapshot(d);
        expect(() => apply(d, b, r, { now })).toThrow("plan_not_applicable");
        expect(snapshot(d)).toEqual(before);
      } else apply(d, b, r, { now });
    }
  });
  it("U-47 report envelopes exclude all record content; repeat metadata is bounded", () => {
    const d = db(),
      records = [
        source(),
        family(),
        codeReference(),
        variant({ reference_key: "apple:example:xx01", retail_sku_code: "SKU-EXAMPLE1" }),
        variant({ reference_key: "apple:example:xx01" }),
        observation({ subject_key: "apple:example:xx01" }),
        listing({ reference_key: "apple:example:xx01" }),
      ];
    const a = run(d, records),
      repeat = apply(d, a.input, a.report, { now });
    for (const envelope of [a.report, a.result, repeat, plan(d, a.input, { now })]) {
      const text = JSON.stringify(envelope).toLowerCase();
      for (const forbidden of [
        "apple:example",
        "#ram=",
        "#st=",
        "#sku=",
        "SKU-EXAMPLE1",
        "XX01",
        "Example Mobile",
        "Example Reference",
        "Example Game",
        "Example Chip",
        "example.app",
        "https://",
      ])
        expect(text).not.toContain(forbidden.toLowerCase());
    }
    expect(Object.keys(a.report).sort()).toEqual(
      [
        "contract",
        "status",
        "inputSha256",
        "planSha256",
        "header",
        "records",
        "outcomes",
        "existingRowEffects",
        "identityConflicts",
        "counts",
        "hosts",
        "alreadyAppliedBatchId",
      ].sort(),
    );
    for (const o of a.report.outcomes) expect(o.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(a.report.hosts).toEqual(["example.invalid"]);
    expect(repeat.existingBatch?.appliedAt).toBe(now.toISOString());
    expect(repeat.existingBatch?.appliedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(a.result.batchId).toMatch(/^[0-9a-f-]{36}$/);
    const unknown = plan(d, bytes([{ record_type: "PRIVATE-UNKNOWN" }]), { now });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE-UNKNOWN");
  });
  it("U-48 aliases never select provenance by order, including rejected definitions", () => {
    const users = [family(), reference(), variant(), observation(), listing()];
    const cases = [
      {
        sources: [source(), source({ url: "https://example.invalid/other" })],
        reason: "source_ref_ambiguous",
      },
      { sources: [source(), source()], reason: "duplicate_record" },
      { sources: [source(), source({ publisher: "Google" })], reason: "attribute_differs" },
      { sources: [source(), source({ ref: "t" })], reason: "duplicate_record" },
    ];
    let seed = 218;
    for (const c of cases) {
      const records = [...c.sources, ...users];
      const d = db();
      let expected: string | undefined;
      for (let n = 0; n < 202; n++) {
        const shuffled =
          n === 0
            ? records
            : n === 1
              ? [...records].reverse()
              : [...records]
                  .map((r) => {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    return { r, k: seed };
                  })
                  .sort((a, b) => a.k - b.k)
                  .map((x) => x.r);
        const r = plan(d, bytes(shuffled), { now });
        equations(r);
        expect(r.status).toBe("not_applicable");
        expect(
          r.outcomes
            .filter((o) => o.recordType === "source")
            .every((o) => o.reasons.includes(c.reason)),
        ).toBe(true);
        const semantics = canonicalJson(
          r.outcomes
            .map((o) => [o.recordType, o.status, o.ref, o.reasons])
            .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        );
        expected ??= semantics;
        expect(semantics).toBe(expected);
        if (c.reason === "source_ref_ambiguous") {
          expect(r.outcomes.every((o) => o.reasons.includes(c.reason))).toBe(true);
          expect(
            r.outcomes
              .filter((o) => ["variant", "observation", "listing"].includes(o.recordType!))
              .every((o) => o.ref === null),
          ).toBe(true);
        } else
          expect(
            r.outcomes
              .filter((o) => o.recordType !== "source")
              .every((o) => o.status === "blocked"),
          ).toBe(true);
      }
      const input = bytes(records),
        before = snapshot(d);
      expect(() => apply(d, input, plan(d, input, { now }), { now })).toThrow(
        "plan_not_applicable",
      );
      expect(snapshot(d)).toEqual(before);
    }
    const d = db();
    reject(d, [...base(), observation({ source_ref: "u" })], "unknown_source_ref");
    run(d);
    const sk = all(d, "mobile_sources")[0].source_key;
    expect(all(d, "mobile_device_families")[0].basis_source_key).toBe(sk);
    expect(fieldRows(d)[0].source_key).toBe(sk);
  });
});

describe("AI-092 independent-review regressions", () => {
  it("U-48 cross-line equality reads only valid identity attributes", () => {
    const records = [source(), source({ ref: "t", publisher: "NotInContract" }), family()];
    const r = plan(db(), bytes(records), { now });
    expect(r.outcomes[0]).toMatchObject({ status: "blocked", reasons: [] });
    expect(r.outcomes[1].reasons).toEqual(["publisher_not_in_contract"]);
    expect(r.outcomes[2].status).toBe("blocked");
    expect(r.identityConflicts).toEqual([]);
    const f = plan(db(), bytes([source(), family(), family({ marketing_name: "\0bad" })]), { now });
    expect(f.outcomes[1].status).toBe("blocked");
    expect(f.outcomes[2].reasons).toEqual(["invalid_value"]);
  });
  it("U-47 invalid key-bearing values have null refs, unrelated properties do not", () => {
    for (const record of [
      variant({ ram_gb: 0 }),
      observation({ market: "bad" }),
      listing({ game_title: "" }),
      reference({ reference_key: "apple:example:" }),
    ]) {
      const d = db(),
        records = base().filter((r) => r.record_type !== record.record_type);
      records.push(record as any);
      const report = plan(d, bytes(records), { now });
      expect(report.status).toBe("not_applicable");
      expect(report.outcomes.at(-1)!.ref).toBeNull();
    }
    const report = plan(db(), bytes([...base(), observation({ extra: "rejected property" })]), {
      now,
    });
    expect(report.outcomes.at(-1)!.ref).toMatch(hex);
  });
  it("U-05/U-41 rejects NUL text before any SQLite constraint can fire", () => {
    const d = db();
    for (const record of [
      family({ marketing_name: "\0Example" }),
      family({ research_ref: "\0Example" }),
      reference({ reference_label: "\0Example" }),
      observation({ value: "\0Example" }),
      listing({ game_title: "\0Example" }),
      listing({ listed_name: "\0Example" }),
      listing({ required_os: "\0Example" }),
    ]) {
      const records = fixture().filter((r) => r.record_type !== record.record_type);
      records.push(record as any);
      const report = reject(d, records, "invalid_value");
      expect(report.planSha256).toBeNull();
    }
  });
  it("U-08 preserves literal text equal to the private provenance marker", () => {
    const d = db();
    run(d, [
      source(),
      family({ marketing_name: "@batch" }),
      reference({ reference_label: "@batch", research_ref: "@batch" }),
      observation({ value: "@batch" }),
      listing({ game_title: "@batch", listed_name: "@batch", required_os: "@batch" }),
    ]);
    expect(all(d, "mobile_device_families")[0].marketing_name).toBe("@batch");
    expect(all(d, "mobile_hardware_references")[0]).toMatchObject({
      reference_label: "@batch",
      research_ref: "@batch",
    });
    expect(fieldRows(d)[0].value_text).toBe("@batch");
    expect(all(d, "mobile_listing_observations")[0]).toMatchObject({
      game_title: "@batch",
      listed_name: "@batch",
      required_os: "@batch",
    });
  });
  it("U-16 operator-selected input suffix grammar and isolated identity conflicts", () => {
    const d = db();
    run(d, [source(), family(), reference({ reference_key: "apple:example:other" })]);
    expect(all(d, "mobile_hardware_references")[0].reference_key).toBe("apple:example:other");
    const scope = reject(d, [source(), family(), reference()], "duplicate_source_scope");
    expect(scope.outcomes[2].reasons).toEqual(["duplicate_source_scope"]);
    expect(scope.outcomes.slice(0, 2).every((o) => o.status === "blocked")).toBe(true);
    reject(
      db(),
      [source(), family(), reference({ reference_key: "apple:example:" })],
      "invalid_key",
    );
    const c = db();
    run(c, [source(), family(), codeReference()]);
    const cross = reject(
      c,
      [
        source(),
        family({ family_key: "apple:second" }),
        codeReference({ reference_key: "apple:second:chosen", family_key: "apple:second" }),
      ],
      "model_code_already_assigned",
    );
    expect(cross.outcomes[2].reasons).toEqual(["model_code_already_assigned"]);
    run(c, [...base()]);
    const resolution = reject(
      c,
      [
        source(),
        family(),
        reference({
          model_code: "XX01",
          scope_market: null,
          model_code_source_ref: "s",
          model_code_observed_on: "2026-10-21",
        }),
      ],
      "model_code_already_assigned",
    );
    expect(resolution.outcomes[2].reasons).toEqual(["model_code_already_assigned"]);
    const g = db();
    run(g, [
      source(),
      family({ family_key: "google:example", manufacturer: "Google", os_family: "android" }),
    ]);
    const changed = reject(
      g,
      [
        source(),
        family({
          family_key: "google:example",
          manufacturer: "Google",
          os_family: "android",
          device_class: "Tablet",
        }),
      ],
      "attribute_differs",
    );
    expect(changed.identityConflicts).toHaveLength(1);
    expect(changed.identityConflicts[0].attribute).toBe("device_class");
    const sameFile = reject(
      db(),
      [
        source(),
        family(),
        reference(),
        reference({
          model_code: "XX01",
          scope_market: null,
          model_code_source_ref: "s",
          model_code_observed_on: "2026-10-21",
        }),
      ],
      "attribute_differs",
    );
    expect(
      sameFile.outcomes
        .filter((o) => o.recordType === "reference")
        .every((o) => o.status === "rejected"),
    ).toBe(true);
  });
  it("U-09 replay remains a no-op after unrelated database changes", () => {
    const d = db(),
      a = run(d);
    run(d, [source({ ref: "t", url: "https://example.invalid/new" })]);
    const before = snapshot(d);
    const result = apply(
      d,
      a.input,
      { inputSha256: a.report.inputSha256, planSha256: "incorrect" },
      { now },
    );
    expect(result.status).toBe("already_applied");
    expect(snapshot(d)).toEqual(before);
  });
  it("U-17 resolving a code makes differing hardware markets conflict", () => {
    const d = db();
    run(d, [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2", market: "CA" }),
      observation(),
      observation({ source_ref: "t", market: "CA", value: "Other Chip" }),
    ]);
    expect(fieldRows(d).every((r) => r.review_state === "accepted")).toBe(true);
    const execution = run(d, [
      source(),
      family(),
      reference({
        model_code: "XX01",
        scope_market: null,
        model_code_source_ref: "s",
        model_code_observed_on: "2026-10-21",
      }),
    ]);
    expect(execution.report.counts.existing_quarantined).toBe(2);
    expect(execution.report.existingRowEffects.every((e) => e.causedByLines.includes(4))).toBe(
      true,
    );
    expect(fieldRows(d).every((r) => r.review_state === "quarantined")).toBe(true);
    assertBatch(d, execution);
  });
  it("U-36 same code under another manufacturer remains a distinct identity", () => {
    const d = db();
    run(d, [
      source(),
      family(),
      codeReference(),
      family({ family_key: "google:example", manufacturer: "Google", os_family: "android" }),
      codeReference({ family_key: "google:example", reference_key: "google:example:chosen" }),
    ]);
    expect(all(d, "mobile_hardware_references")).toHaveLength(2);
  });
  it("U-39 exercises every successful line status and both existing transitions", () => {
    const d = db();
    run(d, [
      ...base(),
      observation({ observed_on: "2026-10-19" }),
      observation({ field: "ram_gb", value: 8, unit: "GB", observed_on: "2026-10-19" }),
    ]);
    const execution = run(d, [
      source(),
      family(),
      reference({
        model_code: "XX01",
        scope_market: null,
        model_code_source_ref: "s",
        model_code_observed_on: "2026-10-21",
      }),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      variant(),
      variant({ basis_source_ref: "t" }),
      observation({ observed_on: "2026-10-20", value: "Middle Chip" }),
      observation({ value: "New Chip" }),
      observation({ field: "ram_gb", value: 16, unit: "GB", source_ref: "t" }),
      observation({
        field: "update_policy_years",
        value: 5,
        unit: "year",
        declared_quarantine: "research_declared_unresolved",
      }),
    ]);
    for (const status of [
      "inserted",
      "inserted_quarantined",
      "inserted_superseded",
      "sighting_added",
      "unchanged",
      "model_code_resolved",
    ] as const)
      expect(execution.report.counts[status]).toBeGreaterThan(0);
    expect(execution.report.counts.existing_quarantined).toBe(1);
    expect(execution.report.counts.existing_superseded).toBe(1);
    expect(new Set(execution.report.existingRowEffects.map((e) => e.ref)).size).toBe(2);
    assertBatch(d, execution);
    expect(d.pragma("foreign_key_check")).toEqual([]);
  });
  it("U-42/U-43 existing predecessor and declared successor obey immediate FKs", () => {
    const d = db();
    run(d, [...base(), observation({ observed_on: "2026-10-18" })]);
    const execution = run(d, [
      ...base(),
      observation({ observed_on: "2026-10-19", value: "Middle Chip" }),
      observation({
        observed_on: "2026-10-20",
        value: "New Chip",
        declared_quarantine: "research_declared_unresolved",
      }),
    ]);
    const ordered = fieldRows(d).sort((a, b) => a.observed_on.localeCompare(b.observed_on));
    expect(ordered.map((r) => r.review_state)).toEqual(["superseded", "superseded", "quarantined"]);
    expect(ordered[0].superseded_by).toBe(ordered[1].observation_key);
    expect(ordered[1].superseded_by).toBe(ordered[2].observation_key);
    expect(ordered[2].superseded_by).toBeNull();
    expect(execution.report.counts.existing_superseded).toBe(1);
    assertBatch(d, execution);
    expect(d.pragma("foreign_key_check")).toEqual([]);
  });
  it("U-14 fixed-seed shuffles preserve domain, batch counters and ref outcomes", () => {
    const records = [
      ...fixture(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      variant({ basis_source_ref: "t" }),
      observation({ observed_on: "2026-10-19", value: "Old Chip" }),
      observation({ source_ref: "t", value: "Conflict Chip" }),
      observation({
        field: "ram_gb",
        value: 8,
        unit: "GB",
        declared_quarantine: "research_declared_unresolved",
      }),
    ];
    const a = db(),
      original = run(a, records);
    assertBatch(a, original);
    const semantics = (r: mobile.MobileImportReport) =>
      r.outcomes.map((o) => canonicalJson([o.ref, o.status, o.reasons])).sort();
    const batchDomain = (d: Database.Database) =>
      all(d, "mobile_import_batches").map(
        ({ batch_id: _id, input_sha256: _input, plan_sha256: _plan, applied_at: _at, ...rest }) =>
          rest,
      );
    for (let seed = 1; seed <= 12; seed++) {
      const b = db(),
        execution = run(b, shuffled(records, seed));
      assertBatch(b, execution);
      expect(execution.report.header).toEqual(original.report.header);
      expect(domain(b)).toEqual(domain(a));
      expect(batchDomain(b)).toEqual(batchDomain(a));
      expect(semantics(execution.report)).toEqual(semantics(original.report));
      expect(execution.report.inputSha256).not.toBe(original.report.inputSha256);
    }
  });
  it("U-44 exact domain boundary covers complex fixtures and per-execution accounting", () => {
    const undated = [...base(), source({ ref: "t", url: "https://example.invalid/s2" })];
    const single = [
      observation({
        observed_on: "2026-10-18",
        declared_quarantine: "research_declared_unresolved",
      }),
      observation({ observed_on: "2026-10-19", value: "Chip A" }),
      observation({ observed_on: "2026-10-19", value: "Chip B" }),
      observation({ observed_on: "2026-10-20", value_state: "not_stated_by_source", value: null }),
      observation({ value: "Current Chip" }),
    ];
    const agreeing = [
      observation({ observed_on: "2026-10-19" }),
      observation({ observed_on: "2026-10-20" }),
      observation({ source_ref: "t" }),
    ];
    const datedExtras = [
      variant({ observed_on: "2026-10-19" }),
      variant({ observed_on: "2026-10-21" }),
      listing({ observed_on: "2026-10-19" }),
      listing({ observed_on: "2026-10-21" }),
    ];
    for (const earlier of [false, true])
      for (const observations of [single, agreeing]) {
        const a = db(),
          b = db();
        if (earlier)
          for (const d of [a, b])
            run(d, [
              ...undated,
              observation({ observed_on: "2026-10-17", field: "ram_gb", value: 8, unit: "GB" }),
            ]);
        const dated = [...observations, ...datedExtras];
        assertBatch(a, run(a, [...undated, ...dated]));
        for (const date of [...new Set(dated.map((r) => r.observed_on))].sort()) {
          const execution = run(b, [...undated, ...dated.filter((r) => r.observed_on === date)]);
          expect(execution.report.status).not.toBe("not_applicable");
          assertBatch(b, execution);
        }
        expect(domain(a)).toEqual(domain(b));
      }
    const a = db(),
      b = db();
    const dated = [
      observation({ observed_on: "2026-10-19", value: "Chip X" }),
      observation({ observed_on: "2026-10-19", source_ref: "t", value: "Chip Y" }),
      observation({ value: "Chip Y" }),
    ];
    run(a, [...undated, ...dated]);
    for (const date of ["2026-10-19", "2026-10-21"])
      run(b, [...undated, ...dated.filter((r) => r.observed_on === date)]);
    const exact = (d: Database.Database) =>
      fieldRows(d)
        .sort(
          (x, y) =>
            x.source_key.localeCompare(y.source_key) || x.observed_on.localeCompare(y.observed_on),
        )
        .map((r) => [r.source_key, r.observed_on, r.review_state]);
    const sk = "src-" + sha256Hex(source().url).slice(0, 16),
      tk =
        "src-" +
        sha256Hex(source({ ref: "t", url: "https://example.invalid/s2" }).url).slice(0, 16);
    const ordered = (v: unknown[][]) =>
      v.sort(
        (x, y) =>
          String(x[0]).localeCompare(String(y[0])) || String(x[1]).localeCompare(String(y[1])),
      );
    expect(exact(a)).toEqual(
      ordered([
        [sk, "2026-10-19", "superseded"],
        [tk, "2026-10-19", "accepted"],
        [sk, "2026-10-21", "accepted"],
      ]),
    );
    expect(exact(b)).toEqual(
      ordered([
        [sk, "2026-10-19", "quarantined"],
        [tk, "2026-10-19", "quarantined"],
        [sk, "2026-10-21", "accepted"],
      ]),
    );
  });
  it("U-44(c) one-file versus date-file batches match their own specified counters", () => {
    const a = db(),
      b = db();
    for (const d of [a, b]) run(d, [source(), family()]);
    const old = observation({
        subject_level: "family",
        subject_key: "apple:example",
        observed_on: "2026-10-19",
        value: "Chip X",
      }),
      current = observation({
        subject_level: "family",
        subject_key: "apple:example",
        value: "Chip Y",
      });
    const together = run(a, [source(), family(), old, current]);
    const first = run(b, [source(), family(), old]),
      second = run(b, [source(), family(), current]);
    expect(together.report.counts).toMatchObject({
      inserted: 1,
      inserted_superseded: 1,
      unchanged: 2,
      existing_superseded: 0,
    });
    expect(first.report.counts).toMatchObject({
      inserted: 1,
      unchanged: 2,
      existing_superseded: 0,
    });
    expect(second.report.counts).toMatchObject({
      inserted: 1,
      unchanged: 2,
      existing_superseded: 1,
    });
    assertBatch(a, together);
    assertBatch(b, first);
    assertBatch(b, second);
    expect(domain(a)).toEqual(domain(b));
    expect(together.report.records).toBe(4);
    expect(first.report.records).toBe(3);
    expect(second.report.records).toBe(3);
    expect(all(a, "mobile_import_batches")).toHaveLength(2);
    expect(all(b, "mobile_import_batches")).toHaveLength(3);
  });
  it("U-45 creator uses earliest date then source key; known sightings are unchanged", () => {
    const d = db(),
      records = [
        ...base(),
        source({ ref: "t", url: "https://example.invalid/s2" }),
        variant(),
        variant({ basis_source_ref: "t" }),
        variant({ basis_source_ref: "t", observed_on: "2026-10-20" }),
      ];
    const execution = run(d, records);
    expect(execution.report.outcomes[6].status).toBe("inserted");
    expect(execution.report.outcomes[4].status).toBe("sighting_added");
    expect(execution.report.outcomes[5].status).toBe("sighting_added");
    const next = run(d, [...base(), variant(), variant({ observed_on: "2026-10-19" })]);
    expect(next.report.outcomes[3].status).toBe("unchanged");
    expect(next.report.outcomes[4].status).toBe("sighting_added");
    reject(d, [...base(), variant(), variant()], "duplicate_record");
    const tie = db(),
      tieRun = run(tie, [
        ...base(),
        source({ ref: "t", url: "https://example.invalid/s2" }),
        variant(),
        variant({ basis_source_ref: "t" }),
      ]);
    const sk = "src-" + sha256Hex(source().url).slice(0, 16),
      tk = "src-" + sha256Hex("https://example.invalid/s2").slice(0, 16);
    expect(tieRun.report.outcomes[sk < tk ? 4 : 5].status).toBe("inserted");
  });
  it("U-37 keys change with each listing attribute and later identical rows are unchanged", () => {
    const original = plan(db(), bytes([...base(), listing()]), { now }).outcomes[3].ref;
    for (const patch of [
      { game_title: "Other Game" },
      { listed_name: "Other Mobile" },
      { required_os: "iOS 20" },
    ])
      expect(plan(db(), bytes([...base(), listing(patch)]), { now }).outcomes[3].ref).not.toBe(
        original,
      );
    const d = db();
    run(d, [...base(), listing()]);
    const input = Buffer.from(
      bytes([...base(), listing()])
        .toString()
        .replace(/\n/g, "\r\n"),
    );
    const report = plan(d, input, { now }),
      before = snapshot(d);
    expect(report.outcomes[3].status).toBe("unchanged");
    expect(apply(d, input, report, { now }).status).toBe("no_changes");
    expect(snapshot(d)).toEqual(before);
  });
  it("U-40 bytes without a BOM are accepted and source-key collisions are reported", () => {
    const d = db(),
      input = bytes([source()]);
    expect(plan(d, input, { now }).status).toBe("applicable");
    const withBom = Buffer.concat([Buffer.from([239, 187, 191]), input]);
    expect(plan(d, withBom, { now }).header.reasons).toEqual(["bom_not_allowed"]);
  });
  it("U-48(f) stored source collision compares URL through the key", () => {
    const d = db();
    run(d, [source()]);
    d.prepare("UPDATE mobile_sources SET url = ?").run("https://example.invalid/other");
    const r = reject(d, fixture(), "attribute_differs");
    expect(r.identityConflicts).toEqual([
      {
        line: 2,
        ref: mobile.mobileReportRef("mobile_sources", [
          "src-" + sha256Hex(source().url).slice(0, 16),
        ]),
        reason: "attribute_differs",
        attribute: "url",
      },
    ]);
  });
  it("U-48 refs and complete provenance are stable for every alias user", () => {
    const d = db(),
      input = fixture(),
      execution = run(d, input),
      sk = "src-" + sha256Hex(source().url).slice(0, 16);
    for (const [table, column] of [
      ["mobile_device_families", "basis_source_key"],
      ["mobile_hardware_references", "basis_source_key"],
      ["mobile_variant_sightings", "source_key"],
      ["mobile_observations", "source_key"],
      ["mobile_listing_observations", "source_key"],
    ])
      expect(all(d, table)[0][column]).toBe(sk);
    const ambiguous = plan(
      db(),
      bytes([...input, source({ url: "https://example.invalid/other" })]),
      { now },
    );
    expect(
      ambiguous.outcomes
        .filter((o) => ["family", "reference"].includes(o.recordType!))
        .every((o) => hex.test(o.ref!)),
    ).toBe(true);
    const duplicate = plan(db(), bytes([...input, source()]), { now });
    for (let i = 1; i < input.length; i++)
      expect(duplicate.outcomes[i].ref).toBe(execution.report.outcomes[i].ref);
    const different = plan(db(), bytes([...input, source({ publisher: "Google", market: "CA" })]), {
      now,
    });
    expect(different.identityConflicts.map((c) => [c.line, c.attribute])).toEqual([
      [2, "market"],
      [2, "publisher"],
      [8, "market"],
      [8, "publisher"],
    ]);
  });
  it("U-47 validates each output envelope independently, including effects and refusals", () => {
    const d = db(),
      records = [
        source(),
        family(),
        codeReference(),
        variant({ reference_key: "apple:example:xx01", retail_sku_code: "SKU-EXAMPLE1" }),
        variant({ reference_key: "apple:example:xx01" }),
        observation({ subject_key: "apple:example:xx01" }),
        listing({ reference_key: "apple:example:xx01" }),
      ];
    const a = run(d, records),
      repeat = apply(d, a.input, a.report, { now });
    const effectInput = bytes([
      ...records.slice(0, 3),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      observation({
        subject_key: "apple:example:xx01",
        source_ref: "t",
        value: "Conflicting Chip",
      }),
    ]);
    const effect = plan(d, effectInput, { now });
    expect(effect.existingRowEffects).toHaveLength(1);
    const conflictInput = bytes([
      source(),
      family({ marketing_name: "Changed Name" }),
      { record_type: "PRIVATE-UNKNOWN" },
    ]);
    const conflict = plan(d, conflictInput, { now });
    expect(conflict.identityConflicts).toHaveLength(1);
    const envelopes: any[] = [
      a.report,
      a.result,
      repeat,
      effect,
      conflict,
      plan(d, a.input, { now }),
    ];
    for (const r of [a.report, effect, conflict, plan(d, a.input, { now })]) {
      reportEnvelope(r);
      const file = { ...r, mode: "dry_run", apply: null };
      fileEnvelope(file);
      envelopes.push(file);
    }
    for (const result of [a.result, repeat]) {
      applyEnvelope(result);
      const file = { ...a.report, mode: "apply", apply: result };
      fileEnvelope(file);
      envelopes.push(file);
      const line = {
        mode: "apply",
        status: result.status,
        inputSha256: a.report.inputSha256,
        counts: result.counts,
        batchId: result.batchId,
      };
      consoleEnvelope(line);
      envelopes.push(line);
    }
    const expectedRefs = new Set<string>();
    const keys: Record<string, string[]> = {
      mobile_sources: ["source_key"],
      mobile_device_families: ["family_key"],
      mobile_hardware_references: ["reference_key"],
      mobile_variant_sightings: ["variant_key", "source_key", "observed_on"],
      mobile_observations: ["observation_key"],
      mobile_listing_observations: ["listing_key"],
    };
    for (const [table, columns] of Object.entries(keys))
      for (const row of all(d, table))
        expectedRefs.add(
          mobile.mobileReportRef(
            table as (typeof tables)[number],
            columns.map((k) => row[k]),
          ),
        );
    expect(a.report.outcomes.every((o) => expectedRefs.has(o.ref!))).toBe(true);
    expect(a.report.outcomes[3].ref).not.toBe(a.report.outcomes[4].ref);
    expect(effect.existingRowEffects.every((e) => expectedRefs.has(e.ref))).toBe(true);
    const errorCases: [Buffer, { inputSha256: string; planSha256: string | null }, string][] = [
      [Buffer.concat([effectInput, Buffer.from(" ")]), effect, "input_mismatch"],
      [effectInput, { ...effect, planSha256: "wrong" }, "plan_stale"],
      [effectInput, { ...effect, planSha256: null }, "plan_digest_missing"],
      [conflictInput, conflict, "plan_not_applicable"],
    ];
    for (const [input, expected, code] of errorCases) {
      const before = snapshot(d);
      try {
        apply(d, input, expected, { now });
        throw new Error("expected refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(mobile.MobileImportError);
        expect((error as Error).message).toBe(code);
        const file = { ...plan(d, input, { now }), mode: "apply", apply: { error: code } };
        fileEnvelope(file);
        envelopes.push(file);
      }
      expect(snapshot(d)).toEqual(before);
    }
    for (const value of envelopes) {
      const text = JSON.stringify(value).toLowerCase();
      for (const forbidden of [
        "apple:example",
        "#ram=",
        "#st=",
        "#sku=",
        "SKU-EXAMPLE1",
        "XX01",
        "Example Mobile",
        "Example Reference",
        "Example Game",
        "Example Chip",
        "Conflicting Chip",
        "Changed Name",
        "PRIVATE-UNKNOWN",
        "example.app",
        "https://",
      ])
        expect(text).not.toContain(forbidden.toLowerCase());
    }
    expect(repeat.existingBatch!.appliedAt).toBe(all(d, "mobile_import_batches")[0].applied_at);
  });
  it("U-28 real CLI reports and console lines satisfy their own whitelists", () => {
    const dir = temp(),
      file = path.join(dir, "cli.db"),
      input = path.join(dir, "input.jsonl");
    db(file);
    writeFileSync(input, bytes());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const review = buildMobileApplyReview({
      dbPath: file,
      inputPath: input,
      dir,
      prefix: "cli-rev",
      now,
    });
    for (const [index, flag] of [[], ["--apply"], ["--apply"]].entries()) {
      const report = path.join(dir, `report-${index}.json`);
      const reviewFlags = flag.length ? review.flags : [];
      log.mockClear();
      expect(
        main(["--db", file, "--in", input, "--report", report, ...flag, ...reviewFlags], now),
      ).toBe(0);
      fileEnvelope(JSON.parse(readFileSync(report, "utf8")));
      consoleEnvelope(JSON.parse(log.mock.calls[0][0]));
    }
    const inRepo = path.resolve("refused-mobile-report.json");
    expect(existsSync(inRepo)).toBe(false);
    log.mockClear();
    expect(main(["--db", file, "--in", input, "--report", inRepo], now)).toBe(2);
    expect(existsSync(inRepo)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
  it("U-43/U-45/U-48 final state and ref matching hold across seeded sighting orders", () => {
    const records = [
      ...base(),
      source({ ref: "t", url: "https://example.invalid/s2" }),
      variant(),
      variant({ basis_source_ref: "t" }),
      variant({ basis_source_ref: "t", observed_on: "2026-10-20" }),
    ];
    const original = run(db(), records).report;
    const outcomes = (r: mobile.MobileImportReport) =>
      r.outcomes.map((o) => canonicalJson([o.ref, o.status, o.reasons])).sort();
    for (let seed = 1; seed <= 20; seed++)
      expect(outcomes(run(db(), shuffled(records, seed)).report)).toEqual(outcomes(original));
    const d = db();
    run(d, [
      ...base(),
      observation({
        observed_on: "2026-10-19",
        declared_quarantine: "research_declared_unresolved",
      }),
      observation(),
    ]);
    expect(fieldRows(d).find((r) => r.observed_on === "2026-10-21").review_state).toBe("accepted");
    const mixed = [
      source(),
      source({ ref: "t" }),
      family({ basis_source_ref: "t" }),
      reference(),
      variant({ basis_source_ref: "t" }),
      observation({ source_ref: "t" }),
      listing(),
    ];
    const report = plan(db(), bytes(mixed), { now });
    expect(report.outcomes.slice(2).every((o) => o.status === "blocked" && hex.test(o.ref!))).toBe(
      true,
    );
    expect(report.outcomes.slice(0, 2).every((o) => o.reasons.includes("duplicate_record"))).toBe(
      true,
    );
  });
});
