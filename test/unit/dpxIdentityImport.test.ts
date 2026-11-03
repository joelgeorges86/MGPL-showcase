import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dpx from "../../src/services/dpxIdentityImport";
import { canonicalJson, sha256Hex } from "../../src/services/enrichmentPromotion";
import {
  validateObservation,
  assessField,
  FIELD_REGISTRY,
  type FieldRegistry,
  type EvidenceObservation,
  type SubjectRef,
} from "../../src/lib/evidenceContract";
import { SOURCE_REGISTER, type SourceRegisterView } from "../../src/lib/sourceAccess";
import { CANONICAL_PLATFORMS, normalizePlatform } from "../../src/lib/platformTaxonomy";
import {
  planMobileImport,
  applyMobileImport,
  MOBILE_STAGING_TABLES,
} from "../../src/services/mobileCatalogueImport";
import * as mobile from "../helpers/mobileStagingFixture";
import { main } from "../../scripts/catalogue/import-dpx-identities";
import {
  DPX_NOW as now,
  DPX_BATCH as batchId,
  dpxDatabase,
  dpxDdl,
  dpxFixture,
  dpxBytes as bytes,
  header,
  work,
  workLink,
  edition,
  storeProduct,
  hardwareFamily as family,
  hardwareReference as reference,
  observationRecord as observation,
} from "../helpers/dpxIdentityFixture";

const {
  planDpxIdentityImport: plan,
  applyDpxIdentityImport: apply,
  DPX_IDENTITY_TABLES: tables,
} = dpx;
const handles: Database.Database[] = [],
  temporary: string[] = [];
const temp = () => {
  const p = mkdtempSync(path.join(os.tmpdir(), "mgpl-dpx-"));
  temporary.push(p);
  return p;
};
const db = (file?: string) => {
  const d = dpxDatabase(file);
  handles.push(d);
  return d;
};
const track = (d: Database.Database) => {
  handles.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of handles.splice(0)) if (d.open) d.close();
  for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true });
});
const all = (d: Database.Database, t: string): any[] =>
  d.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
const hash = (d: Database.Database, t: string) => sha256Hex(canonicalJson(all(d, t)));
const names = (d: Database.Database): string[] =>
  (
    d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
const hashes = (d: Database.Database, selected = names(d)) =>
  Object.fromEntries(selected.map((t) => [t, hash(d, t)]));
const changes = (d: Database.Database) =>
  (d.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
const nonDpx = (d: Database.Database) =>
  hashes(
    d,
    names(d).filter((t) => !t.startsWith("dpx_")),
  );
const mobileBatch = "00000000-0000-4000-8000-000000000092";
function seedMobile(d: Database.Database) {
  const input = mobile.bytes(),
    r = planMobileImport(d, input, { now: mobile.now });
  applyMobileImport(d, input, r, { now: mobile.now, batchId: mobileBatch });
  return r;
}
function populated(file?: string) {
  const d = db(file);
  for (const t of [
    "AuthUsers",
    "AppGames",
    "CatalogueGames",
    "catalog_devices",
    "catalog_device_specs",
    "AppDevices",
    "AppOwnership",
  ]) {
    const ddl = mobile.dbSource.match(
      new RegExp('CREATE TABLE IF NOT EXISTS "?' + t + '"? \\([\\s\\S]*?\\n    \\);'),
    )![0];
    d.exec(ddl);
  }
  d.prepare("INSERT INTO AuthUsers (id,email,passwordHash,displayName) VALUES (?,?,?,?)").run(
    "fixture-user",
    "fixture@example.invalid",
    "fixture-hash",
    "Fixture",
  );
  d.prepare('INSERT INTO AppGames ("GameID","Game Title") VALUES (?,?)').run(
    "fixture-game",
    "Fixture legacy game",
  );
  d.prepare(
    "INSERT INTO CatalogueGames (qid,title,steam_appid,wikidata_url,loaded_at) VALUES (?,?,?,?,?)",
  ).run(
    "Q999999999001",
    "Fixture legacy",
    "1000001",
    "https://wikidata.fixture.test/wiki/Q999999999001",
    "2026-10-01T00:00:00Z",
  );
  d.prepare(
    "INSERT INTO catalog_devices (id,name,brand,type,platformCanonical) VALUES (?,?,?,?,?)",
  ).run("fixture-console", "Fixture console", "FixtureCorp", "Console", "Console – PlayStation");
  d.prepare("INSERT INTO catalog_device_specs (deviceId,ramGb,gpuTier) VALUES (?,?,?)").run(
    "fixture-console",
    16,
    "high",
  );
  d.prepare("INSERT INTO AppDevices (id,userId,deviceName,deviceType) VALUES (?,?,?,?)").run(
    "fixture-device",
    "fixture-user",
    "Fixture handheld",
    "Handheld",
  );
  d.prepare(
    'INSERT INTO AppOwnership ("OwnershipID","userId","GameID","Platform","platformCanonical") VALUES (?,?,?,?,?)',
  ).run("fixture-ownership", "fixture-user", "fixture-game", "PS5", "Console – PlayStation");
  seedMobile(d);
  return d;
}
function run(
  d: Database.Database,
  records: unknown[] = dpxFixture(),
  opts: { register?: SourceRegisterView; registry?: FieldRegistry; batchId?: string } = {},
) {
  const input = bytes(records),
    report = plan(d, input, { now, ...opts });
  const result = apply(d, input, report, { now, batchId, ...opts });
  return { input, report, result };
}
function reject(
  d: Database.Database,
  records: unknown[],
  reason: string,
  opts: { register?: SourceRegisterView; registry?: FieldRegistry } = {},
) {
  const input = bytes(records),
    before = hashes(d),
    changeCount = changes(d),
    report = plan(d, input, { now, ...opts });
  expect(report.status).toBe("not_applicable");
  expect(report.outcomes.some((o) => o.reasons.includes(reason))).toBe(true);
  expect(() => apply(d, input, report, { now, ...opts })).toThrow("plan_not_applicable");
  expect(hashes(d)).toEqual(before);
  expect(changes(d)).toBe(changeCount);
  equations(report);
  return report;
}
function equations(r: dpx.DpxImportReport) {
  expect(r.outcomes).toHaveLength(r.records);
  expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(r.records);
  for (const o of r.outcomes) expect(o.reasons).toEqual([...new Set(o.reasons)].sort());
}
const noMobile = () => dpxFixture({ mobile: false });
const readSource = (p: string) => readFileSync(p, "utf8");
const rollback = () => readSource("scripts/rollback-dpx-identity-tables.sql");
const obsRows = (d: Database.Database) =>
  all(d, "dpx_evidence_observations") as dpx.DpxObservationRow[];
const assess = (
  d: Database.Database,
  subject: SubjectRef,
  field: EvidenceObservation["field"],
  country = "US",
  register?: SourceRegisterView,
) =>
  assessField({ subject, field, country }, dpx.readDpxEvidence(d, subject, field), {
    now,
    register,
  });
describe("AI-095 identity and admitted evidence", () => {
  it("U-01 authority entries exactly match column order and types", () => {
    const d = db(),
      source = readSource("src/db.ts");
    for (const t of tables) {
      const body = source.match(new RegExp("  " + t + ": \\{([\\s\\S]*?)\\}"))!;
      const columns = [...body[1].matchAll(/([a-z_][a-z_0-9]*): "(TEXT|INTEGER)"/g)].map((m) => ({
        name: m[1],
        type: m[2],
      }));
      expect(
        (d.pragma(`table_info(${t})`) as any[]).map((r) => ({ name: r.name, type: r.type })),
      ).toEqual(columns);
    }
  });
  it("U-02 table and index names have no case-insensitive collision", () => {
    const rawNames = [
      ...readSource("src/db.ts").matchAll(
        /CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS\s+"?(\w+)/g,
      ),
    ].map((m) => m[1]);
    const objects = rawNames.map((n) => n.toLowerCase());
    expect(new Set(objects).size).toBe(new Set(rawNames).size);
    for (const t of tables) expect(objects.filter((x) => x === t)).toHaveLength(1);
  });
  it("U-03 repeated migration preserves legacy/mobile rows, schema and populated DPX", () => {
    const d = populated(),
      before = nonDpx(d),
      schema = d
        .prepare("SELECT * FROM sqlite_master WHERE name LIKE 'mobile_%' ORDER BY name")
        .all();
    d.exec(dpxDdl);
    d.exec(dpxDdl);
    expect(nonDpx(d)).toEqual(before);
    expect(
      d.prepare("SELECT * FROM sqlite_master WHERE name LIKE 'mobile_%' ORDER BY name").all(),
    ).toEqual(schema);
    for (const type of ["Phone", "Tablet"])
      expect(() =>
        d
          .prepare("INSERT INTO catalog_devices (id,name,brand,type) VALUES (?,?,?,?)")
          .run(type, "Fixture", "Fixture", type),
      ).toThrow("CHECK constraint failed");
    run(d);
    const after = hashes(d);
    d.exec(dpxDdl);
    expect(hashes(d)).toEqual(after);
  });
  it("U-04 populated backup rollback, exact reapply and independent mobile rollback", async () => {
    const dir = temp(),
      original = path.join(dir, "populated.db"),
      copy = path.join(dir, "rollback.db");
    const d = populated(original),
      input = bytes(),
      mobileInput = mobile.bytes();
    run(d);
    const before = hashes(d),
      legacyBefore = nonDpx(d),
      dpxBefore = hashes(d, [...tables]);
    await d.backup(copy);
    const c = track(new Database(copy));
    c.pragma("foreign_keys = ON");
    c.exec(rollback());
    expect(c.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%dpx%'").all()).toEqual([]);
    const afterRollback = nonDpx(c);
    expect(afterRollback).toEqual(legacyBefore);
    expect(c.pragma("foreign_key_check")).toEqual([]);
    c.exec(dpxDdl);
    run(c);
    const afterReapply = hashes(c, [...tables]);
    expect(afterReapply).toEqual(dpxBefore);
    expect(hashes(d)).toEqual(before);
    c.exec(readSource("scripts/rollback-mobile-catalogue-tables.sql"));
    const missing = dpx.dpxLogicalReferenceReport(c);
    const rows = obsRows(c);
    expect(missing).toEqual({
      missing_mobile_family: [],
      missing_mobile_reference: rows
        .filter((r) => r.mobile_reference_key !== null)
        .map((r) => r.observation_key)
        .sort(),
      missing_mobile_variant: rows
        .filter((r) => r.mobile_variant_key !== null)
        .map((r) => r.observation_key)
        .sort(),
    });
    expect(missing.missing_mobile_reference).toHaveLength(1);
    expect(missing.missing_mobile_variant).toHaveLength(1);
    console.log(
      JSON.stringify({
        evidence: "AI-095-U-04-populated-rollback",
        manifest: {
          dpxInputSha256: sha256Hex(input),
          mobileInputSha256: sha256Hex(mobileInput),
          dpxBatchId: batchId,
          mobileBatchId: mobileBatch,
          now: now.toISOString(),
        },
        before,
        afterRollback,
        afterReapply,
        originalUnchanged: hashes(d),
        foreignKeyCheck: [],
        logicalMissingAfterMobileRollback: missing,
      }),
    );
  });
  it("U-05 pins mobile golden keys, report refs, plan digest and hashes across DDL/import", () => {
    const results = [0, 1, 2].map((mode) => {
      const d = track(new Database(":memory:"));
      d.pragma("foreign_keys = ON");
      if (mode === 1) d.exec(dpxDdl);
      d.exec(mobile.ddl);
      if (mode === 2) d.exec(dpxDdl);
      const r = seedMobile(d),
        before = hashes(d, [...MOBILE_STAGING_TABLES]);
      if (mode) run(d);
      expect(hashes(d, [...MOBILE_STAGING_TABLES])).toEqual(before);
      expect(r.planSha256).toBe("2b32af126415a5cc0f8547268bd74f60a16cdc11813dc5066fa15aa2e23bd102");
      expect(all(d, "mobile_sources")[0].source_key).toBe("src-f68bc7d962f38e97");
      expect(all(d, "mobile_observations")[0].observation_key).toBe(
        "9022abc4abb5d58b49d6e5e213255400c045c7dcc0f1df73221ee1b79bf16c52",
      );
      expect(all(d, "mobile_listing_observations")[0].listing_key).toBe(
        "59159a39e7e21374bc872bc6c71f55f28265bdb1c3d4e1190db5fbf9fd3594dc",
      );
      return { before, refs: r.outcomes.map((o) => o.ref), plan: r.planSha256 };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
  it("U-06 all 53 direct constraint refusals, 7 controls and 4 key boundaries", () => {
    const d = populated();
    run(d);
    const row = (table: string, key: string, value: string) =>
      d.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(value) as any;
    const W1 = row("dpx_game_works", "work_key", "wd:Q999999999001"),
      W2 = row("dpx_game_works", "work_key", "mgpl:fixture-quest");
    const E1 = row("dpx_game_editions", "edition_key", "mgpl:fixture-quest/pc"),
      E2 = row("dpx_game_editions", "edition_key", "mgpl:fixture-quest/console");
    const L1 = all(d, "dpx_work_links")[0],
      P1 = row("dpx_store_products", "store", "apple_app_store"),
      P2 = row("dpx_store_products", "store", "google_play"),
      P3 = row("dpx_store_products", "store", "steam");
    const F1 = all(d, "dpx_hardware_families")[0],
      RA = row("dpx_hardware_references", "reference_key", reference().reference_key);
    const ref = (reference_key: string, x: Record<string, unknown>) => ({
      ...RA,
      reference_key,
      model_code: null,
      scope_market: null,
      ...x,
    });
    const OBS = [
      dpxFixture().find((r) => r.record_type === "observation") as ReturnType<typeof observation>,
    ].map((r) => r.observation);
    const ins = (d: Database.Database, table: string, row: Record<string, any>) =>
      d
        .prepare(
          `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
            .map(() => "?")
            .join(",")})`,
        )
        .run(...Object.values(row));
    const neg: Array<[string, () => unknown]> = [
      [
        "work wd key with publisher basis",
        () =>
          ins(d, "dpx_game_works", {
            ...W1,
            work_key: "wd:Q1000002",
            wikidata_qid: "Q1000002",
            basis_source_id: "publisher-pages",
          }),
      ],
      [
        "work mgpl key with wikidata basis",
        () =>
          ins(d, "dpx_game_works", { ...W2, work_key: "mgpl:other", basis_source_id: "wikidata" }),
      ],
      [
        "work qid mismatch",
        () =>
          ins(d, "dpx_game_works", { ...W1, work_key: "wd:Q1000003", wikidata_qid: "Q1000004" }),
      ],
      [
        "work key Q0",
        () => ins(d, "dpx_game_works", { ...W1, work_key: "wd:Q0123", wikidata_qid: "Q0123" }),
      ],
      [
        "work key wd 13 digits",
        () =>
          ins(d, "dpx_game_works", {
            ...W1,
            work_key: "wd:Q1234567890123",
            wikidata_qid: "Q1234567890123",
          }),
      ],
      [
        "work key mgpl 65-char slug",
        () => ins(d, "dpx_game_works", { ...W2, work_key: "mgpl:" + "a".repeat(65) }),
      ],
      [
        "work key uppercase mgpl",
        () => ins(d, "dpx_game_works", { ...W2, work_key: "mgpl:Fixture" }),
      ],
      [
        "link from a wd key",
        () => ins(d, "dpx_work_links", { ...L1, mgpl_work_key: "wd:Q999999999001" }),
      ],
      [
        "link to an mgpl key",
        () =>
          ins(d, "dpx_work_links", {
            ...L1,
            mgpl_work_key: "mgpl:other-x",
            wikidata_work_key: "mgpl:fixture-quest",
          }),
      ],
      [
        "second link for one mgpl key",
        () => ins(d, "dpx_work_links", { ...L1, wikidata_work_key: "wd:Q999999999001" }),
      ],
      [
        "link to unknown work (FK)",
        () => ins(d, "dpx_work_links", { ...L1, mgpl_work_key: "mgpl:unknown" }),
      ],
      ["duplicate edition id", () => ins(d, "dpx_game_editions", E1)],
      [
        "edition key not work/slug",
        () =>
          ins(d, "dpx_game_editions", {
            ...E1,
            edition_key: "mgpl:fixture-quest/mobile",
            edition_slug: "pc",
          }),
      ],
      [
        "edition for unknown work",
        () =>
          ins(d, "dpx_game_editions", {
            ...E1,
            edition_key: "mgpl:nope/pc",
            work_key: "mgpl:nope",
          }),
      ],
      [
        "apple id non-numeric",
        () => ins(d, "dpx_store_products", { ...P1, store_app_id: "com.example.x" }),
      ],
      [
        "apple id too long",
        () => ins(d, "dpx_store_products", { ...P1, store_app_id: "1234567890123" }),
      ],
      [
        "google id without dot",
        () => ins(d, "dpx_store_products", { ...P2, store_app_id: "fixturequest" }),
      ],
      [
        "steam id leading zero",
        () => ins(d, "dpx_store_products", { ...P3, store_app_id: "0100" }),
      ],
      [
        "store product duplicate (second edition)",
        () => ins(d, "dpx_store_products", { ...P1, edition_key: E2.edition_key }),
      ],
      [
        "store product unknown edition",
        () =>
          ins(d, "dpx_store_products", {
            ...P1,
            store_app_id: "999999999002",
            edition_key: "mgpl:fixture-quest/none",
          }),
      ],
      [
        "family class phone",
        () =>
          ins(d, "dpx_hardware_families", {
            ...F1,
            family_key: "fixturecorp:phone",
            hardware_class: "phone",
          }),
      ],
      [
        "family key three segments",
        () => ins(d, "dpx_hardware_families", { ...F1, family_key: "fixturecorp:a:b" }),
      ],
      [
        "reference class differs from family",
        () =>
          ins(
            d,
            "dpx_hardware_references",
            ref("fixturecorp:console-one:x1", { model_code: "X1", hardware_class: "handheld" }),
          ),
      ],
      [
        "reference maker not family prefix",
        () =>
          ins(
            d,
            "dpx_hardware_references",
            ref("fixturecorp:console-one:x2", { model_code: "X2", maker: "other" }),
          ),
      ],
      [
        "reference key not under family",
        () =>
          ins(d, "dpx_hardware_references", ref("othercorp:console-one:x3", { model_code: "X3" })),
      ],
      [
        "model code reused, different case",
        () =>
          ins(
            d,
            "dpx_hardware_references",
            ref("fixturecorp:console-one:cn-100-eu", { model_code: "cn-100" }),
          ),
      ],
      [
        "model code with scope market",
        () =>
          ins(
            d,
            "dpx_hardware_references",
            ref("fixturecorp:console-one:x4", { model_code: "X4", scope_market: "US" }),
          ),
      ],
      [
        "no code and no market",
        () => ins(d, "dpx_hardware_references", ref("fixturecorp:console-one:x5", {})),
      ],
      [
        "duplicate market scope without code",
        () =>
          ins(
            d,
            "dpx_hardware_references",
            ref("fixturecorp:console-one:us-2", { scope_market: "US" }),
          ),
      ],
    ];
    const v0 = validateObservation(OBS[0], { now });
    const base = dpx.dpxObservationRow({ ...(v0 as any), key: "f".repeat(64) }, batchId);
    const ev = (x: Record<string, unknown>) => () =>
      ins(d, "dpx_evidence_observations", { ...base, ...x });
    const pair = (game: object, device: object) => canonicalJson({ kind: "pairing", game, device });
    neg.push(
      ["evidence subject column mismatch", ev({ edition_key: E2.edition_key })],
      ["evidence kind/json mismatch", ev({ subject_kind: "game_edition" })],
      [
        "evidence unknown subject kind",
        ev({
          subject_kind: "service_path",
          subject_json: canonicalJson({ kind: "service_path" }),
          edition_key: null,
          build_platform: null,
          build_version: null,
        }),
      ],
      [
        "evidence mobile_reference column for hardware subject",
        ev({ mobile_reference_key: "apple:example:us-cellular-5g" }),
      ],
      [
        "evidence unknown edition (FK)",
        ev({
          subject_json: canonicalJson({
            kind: "game_build",
            edition_key: "mgpl:fixture-quest/none",
            platform: "android",
            version: null,
          }),
          edition_key: "mgpl:fixture-quest/none",
        }),
      ],
      ["evidence stated without value", ev({ value_json: null })],
      [
        "evidence unknown without reason",
        ev({ value_state: "unknown", value_json: null, basis: null }),
      ],
      [
        "evidence not_listed with exhaustive list",
        ev({
          value_state: "unknown",
          value_json: null,
          basis: null,
          unknown_reason: "not_listed",
          list_exhaustive: 1,
        }),
      ],
      ["evidence manual_read without reviewed_on", ev({ reviewed_on: null })],
      ["evidence bounded_get with reviewed_on", ev({ collection: "bounded_get" })],
      ["evidence reviewed before observed", ev({ reviewed_on: "2026-10-20" })],
      ["evidence source updated after observed", ev({ source_updated_at: "2026-10-22" })],
      ["evidence observed_at with milliseconds", ev({ observed_at: "2026-10-21T12:00:00.000Z" })],
      ["evidence observed_at impossible date", ev({ observed_at: "2026-02-30" })],
      ["evidence country lowercase", ev({ country: "us" })],
      ["evidence wrong contract", ev({ contract: "mgpl-dpx-evidence/2" })],
      [
        "evidence store product missing (FK)",
        ev({
          subject_kind: "store_listing",
          subject_json: canonicalJson({
            kind: "store_listing",
            store: "google_play",
            store_app_id: "com.example.none",
            country: "US",
          }),
          edition_key: null,
          build_platform: null,
          build_version: null,
          store: "google_play",
          store_app_id: "com.example.none",
          listing_country: "US",
        }),
      ],
      [
        "evidence hardware class mismatch (FK)",
        ev({
          subject_kind: "pairing",
          subject_json: pair(
            { kind: "game_edition", edition_key: E2.edition_key },
            {
              kind: "hardware_reference",
              hardware_class: "handheld",
              reference_key: RA.reference_key,
            },
          ),
          edition_key: E2.edition_key,
          build_platform: null,
          build_version: null,
          hardware_class: "handheld",
          hardware_reference_key: RA.reference_key,
        }),
      ],
      [
        "evidence pairing without device column",
        ev({
          subject_kind: "pairing",
          subject_json: pair(
            { kind: "game_edition", edition_key: E2.edition_key },
            { kind: "mobile_family", family_key: "apple:example" },
          ),
          edition_key: E2.edition_key,
          build_platform: null,
          build_version: null,
        }),
      ],
      ["evidence invalid value json", ev({ value_json: "{oops" })],
      [
        "evidence attested_only but publishable",
        ev({ effective_publish: "fact_with_attribution" }),
      ],
      ["evidence unknown classification", ev({ classification: "origin_mismatch" })],
      [
        "evidence hardware_port without port column",
        ev({
          subject_kind: "hardware_port",
          subject_json: canonicalJson({
            kind: "hardware_port",
            hardware_class: "console",
            reference_key: RA.reference_key,
            port_id: "hdmi-1",
          }),
          edition_key: null,
          build_platform: null,
          build_version: null,
          hardware_class: "console",
          hardware_reference_key: RA.reference_key,
        }),
      ],
      [
        "evidence os_release missing release column",
        ev({
          subject_kind: "os_release",
          subject_json: canonicalJson({ kind: "os_release", os_product: "android", release: "14" }),
          edition_key: null,
          build_platform: null,
          build_version: null,
          os_product: "android",
        }),
      ],
    );
    const expectedConstraints: Record<string, string> = {
      "work wd key with publisher basis":
        "CHECK constraint failed: (key_scheme = 'wikidata') = (basis_source_id = 'wikidata')",
      "work mgpl key with wikidata basis":
        "CHECK constraint failed: (key_scheme = 'wikidata') = (basis_source_id = 'wikidata')",
      "work qid mismatch":
        "CHECK constraint failed: wikidata_qid IS NULL OR wikidata_qid = substr(work_key, 4)",
      "work key Q0":
        "CHECK constraint failed: (work_key GLOB 'wd:Q[1-9]*' AND length(work_key) BETWEEN 5 AND 16 AND substr(work_key, 5) NOT GLOB '*[^0-9]*')\n        OR (work_key GLOB 'mgpl:[a-z0-9]*'",
      "work key wd 13 digits":
        "CHECK constraint failed: (work_key GLOB 'wd:Q[1-9]*' AND length(work_key) BETWEEN 5 AND 16 AND substr(work_key, 5) NOT GLOB '*[^0-9]*')\n        OR (work_key GLOB 'mgpl:[a-z0-9]*'",
      "work key mgpl 65-char slug":
        "CHECK constraint failed: (work_key GLOB 'wd:Q[1-9]*' AND length(work_key) BETWEEN 5 AND 16 AND substr(work_key, 5) NOT GLOB '*[^0-9]*')\n        OR (work_key GLOB 'mgpl:[a-z0-9]*'",
      "work key uppercase mgpl":
        "CHECK constraint failed: (work_key GLOB 'wd:Q[1-9]*' AND length(work_key) BETWEEN 5 AND 16 AND substr(work_key, 5) NOT GLOB '*[^0-9]*')\n        OR (work_key GLOB 'mgpl:[a-z0-9]*'",
      "link from a wd key": "CHECK constraint failed: mgpl_work_key GLOB 'mgpl:*'",
      "link to an mgpl key": "CHECK constraint failed: wikidata_work_key GLOB 'wd:Q*'",
      "second link for one mgpl key": "UNIQUE constraint failed: dpx_work_links.mgpl_work_key",
      "link to unknown work (FK)": "FOREIGN KEY constraint failed",
      "duplicate edition id": "UNIQUE constraint failed: dpx_game_editions.edition_key",
      "edition key not work/slug":
        "CHECK constraint failed: edition_key = work_key || '/' || edition_slug",
      "edition for unknown work": "FOREIGN KEY constraint failed",
      "apple id non-numeric":
        "CHECK constraint failed: store NOT IN ('apple_app_store', 'steam') OR (store_app_id GLOB '[1-9]*' AND store_app_id NOT GLOB '*[^0-9]*' AND length(store_app_id) <= (CASE store WHE",
      "apple id too long":
        "CHECK constraint failed: store NOT IN ('apple_app_store', 'steam') OR (store_app_id GLOB '[1-9]*' AND store_app_id NOT GLOB '*[^0-9]*' AND length(store_app_id) <= (CASE store WHE",
      "google id without dot":
        "CHECK constraint failed: store <> 'google_play' OR (store_app_id GLOB '[A-Za-z]*.[A-Za-z]*' AND store_app_id NOT GLOB '*[^A-Za-z0-9._]*')",
      "steam id leading zero":
        "CHECK constraint failed: store NOT IN ('apple_app_store', 'steam') OR (store_app_id GLOB '[1-9]*' AND store_app_id NOT GLOB '*[^0-9]*' AND length(store_app_id) <= (CASE store WHE",
      "store product duplicate (second edition)":
        "UNIQUE constraint failed: dpx_store_products.store, dpx_store_products.store_app_id",
      "store product unknown edition": "FOREIGN KEY constraint failed",
      "family class phone":
        "CHECK constraint failed: hardware_class IN ('console', 'handheld', 'pc', 'pc_component', 'display', 'peripheral', 'xr_headset', 'cable_adapter')",
      "family key three segments":
        "CHECK constraint failed: length(family_key) <= 80 AND family_key GLOB '[a-z]*:[a-z0-9]*' AND family_key NOT GLOB '*:*:*' AND family_key NOT GLOB '*[^a-z0-9:-]*'",
      "reference class differs from family": "FOREIGN KEY constraint failed",
      "reference maker not family prefix":
        "CHECK constraint failed: maker = substr(family_key, 1, instr(family_key, ':') - 1)",
      "reference key not under family":
        "CHECK constraint failed: substr(reference_key, 1, length(family_key) + 1) = family_key || ':' AND length(reference_key) > length(family_key) + 1",
      "model code reused, different case":
        "UNIQUE constraint failed: dpx_hardware_references.maker, dpx_hardware_references.model_code",
      "model code with scope market":
        "CHECK constraint failed: (model_code IS NULL) = (scope_market IS NOT NULL)",
      "no code and no market":
        "CHECK constraint failed: (model_code IS NULL) = (scope_market IS NOT NULL)",
      "duplicate market scope without code":
        "UNIQUE constraint failed: dpx_hardware_references.family_key, dpx_hardware_references.scope_market, dpx_hardware_references.configuration",
      "evidence subject column mismatch":
        "CHECK constraint failed: edition_key IS coalesce(json_extract(subject_json, '$.edition_key'), json_extract(subject_json, '$.game.edition_key'))",
      "evidence kind/json mismatch":
        "CHECK constraint failed: length(subject_json) <= 1000 AND json_valid(subject_json) AND json_type(subject_json) = 'object' AND json_extract(subject_json, '$.kind') = subject_kind",
      "evidence unknown subject kind":
        "CHECK constraint failed: subject_kind IN ('mobile_family', 'mobile_reference', 'mobile_variant', 'hardware_reference', 'hardware_port', 'game_work', 'game_edition', 'game_build',",
      "evidence mobile_reference column for hardware subject":
        "CHECK constraint failed: mobile_reference_key IS (CASE\n        WHEN subject_kind = 'mobile_reference' THEN json_extract(subject_json, '$.reference_key')\n        WHEN json_extract",
      "evidence unknown edition (FK)": "FOREIGN KEY constraint failed",
      "evidence stated without value":
        "CHECK constraint failed: (value_state = 'stated') = (value_json IS NOT NULL)",
      "evidence unknown without reason":
        "CHECK constraint failed: (value_state = 'unknown') = (unknown_reason IS NOT NULL)",
      "evidence not_listed with exhaustive list":
        "CHECK constraint failed: unknown_reason IS NOT 'not_listed' OR list_exhaustive = 0",
      "evidence manual_read without reviewed_on":
        "CHECK constraint failed: (collection = 'manual_read') = (reviewed_on IS NOT NULL)",
      "evidence bounded_get with reviewed_on":
        "CHECK constraint failed: (collection = 'manual_read') = (reviewed_on IS NOT NULL)",
      "evidence reviewed before observed":
        "CHECK constraint failed: reviewed_on IS NULL OR reviewed_on >= substr(observed_at, 1, 10)",
      "evidence source updated after observed":
        "CHECK constraint failed: source_updated_at IS NULL OR source_updated_at <= substr(observed_at, 1, 10)",
      "evidence observed_at with milliseconds":
        "CHECK constraint failed: (length(observed_at) = 10 AND date(observed_at) IS observed_at)\n        OR (length(observed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', observed_at) IS o",
      "evidence observed_at impossible date":
        "CHECK constraint failed: (length(observed_at) = 10 AND date(observed_at) IS observed_at)\n        OR (length(observed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', observed_at) IS o",
      "evidence country lowercase":
        "CHECK constraint failed: country IN ('GLOBAL', 'UNSPECIFIED') OR (length(country) = 2 AND country NOT GLOB '*[^A-Z]*')",
      "evidence wrong contract": "CHECK constraint failed: contract = 'mgpl-dpx-evidence/1'",
      "evidence store product missing (FK)": "FOREIGN KEY constraint failed",
      "evidence hardware class mismatch (FK)": "FOREIGN KEY constraint failed",
      "evidence pairing without device column":
        "CHECK constraint failed: subject_kind <> 'pairing' OR (\n        (edition_key IS NOT NULL OR store_app_id IS NOT NULL)\n        AND (hardware_reference_key IS NOT NULL OR mobile_re",
      "evidence invalid value json":
        "CHECK constraint failed: value_json IS NULL OR (length(value_json) <= 16000 AND json_valid(value_json))",
      "evidence attested_only but publishable":
        "CHECK constraint failed: classification = 'origin_verified' OR effective_publish = 'withheld'",
      "evidence unknown classification":
        "CHECK constraint failed: classification IN ('origin_verified', 'attested_only')",
      "evidence hardware_port without port column":
        "CHECK constraint failed: port_id IS json_extract(subject_json, '$.port_id')",
      "evidence os_release missing release column":
        "CHECK constraint failed: release_name IS json_extract(subject_json, '$.release')",
    };
    expect(neg).toHaveLength(53);
    for (const [name, fn] of neg) expect(fn, name).toThrow(expectedConstraints[name]);
    const boundaryWorks: Array<[string, Record<string, unknown>]> = [
      [
        "wd 12-digit QID (longest AI-094 key)",
        { ...W1, work_key: "wd:Q123456789012", wikidata_qid: "Q123456789012" },
      ],
      ["wd 1-digit QID (shortest)", { ...W1, work_key: "wd:Q7", wikidata_qid: "Q7" }],
      ["mgpl 64-char slug (longest)", { ...W2, work_key: "mgpl:" + "a".repeat(64) }],
      ["mgpl 1-char slug (shortest)", { ...W2, work_key: "mgpl:a" }],
    ];
    for (const [, row] of boundaryWorks) expect(() => ins(d, "dpx_game_works", row)).not.toThrow();
    const nul = { edition_key: null, build_platform: null, build_version: null };
    const positives: Array<[string, Record<string, unknown>]> = [
      ["full-instant observed_at", { observed_at: "2026-10-21T12:00:00Z" }],
      [
        "os_release subject",
        {
          ...nul,
          subject_kind: "os_release",
          subject_json: canonicalJson({ kind: "os_release", os_product: "android", release: "14" }),
          os_product: "android",
          release_name: "14",
        },
      ],
      [
        "hardware_port subject",
        {
          ...nul,
          subject_kind: "hardware_port",
          subject_json: canonicalJson({
            kind: "hardware_port",
            hardware_class: "console",
            reference_key: RA.reference_key,
            port_id: "hdmi-1",
          }),
          hardware_class: "console",
          hardware_reference_key: RA.reference_key,
          port_id: "hdmi-1",
        },
      ],
      [
        "mobile_family subject",
        {
          ...nul,
          subject_kind: "mobile_family",
          subject_json: canonicalJson({ kind: "mobile_family", family_key: "apple:example" }),
          mobile_family_key: "apple:example",
        },
      ],
      [
        "mobile_reference subject",
        {
          ...nul,
          subject_kind: "mobile_reference",
          subject_json: canonicalJson({
            kind: "mobile_reference",
            reference_key: "apple:example:us-cellular-5g",
          }),
          mobile_reference_key: "apple:example:us-cellular-5g",
        },
      ],
      [
        "mobile_variant subject",
        {
          ...nul,
          subject_kind: "mobile_variant",
          subject_json: canonicalJson({
            kind: "mobile_variant",
            variant_key: "apple:example:us-cellular-5g#ram=8#st=128#sku=x",
          }),
          mobile_variant_key: "apple:example:us-cellular-5g#ram=8#st=128#sku=x",
        },
      ],
      [
        "origin_verified publishable",
        { classification: "origin_verified", effective_publish: "fact_with_attribution" },
      ],
    ];
    for (const [, x] of positives) {
      const point = () => ins(d, "dpx_evidence_observations", { ...base, ...x });
      // Positive controls use distinct observation keys, independent of contract-level validation.
      expect(() => point()).not.toThrow();
      d.prepare("DELETE FROM dpx_evidence_observations WHERE observation_key = ?").run(
        base.observation_key,
      );
    }
  });
  it("U-07 planning is read-only, including a readonly database handle", () => {
    const file = path.join(temp(), "readonly.db"),
      d = db(file),
      before = changes(d),
      input = bytes(noMobile());
    expect(plan(d, input, { now }).status).toBe("applicable");
    expect(changes(d)).toBe(before);
    const ro = track(new Database(file, { readonly: true }));
    expect(plan(ro, input, { now })).toEqual(plan(d, input, { now }));
  });
  it("U-08 exact replay stores one batch and changes no rows", () => {
    const d = populated(),
      { input, report } = run(d),
      before = hashes(d),
      changeCount = changes(d),
      p = plan(d, input, { now });
    expect(p.status).toBe("already_applied");
    expect(p.planSha256).toBeNull();
    expect(p.alreadyAppliedBatchId).toBe(batchId);
    const result = apply(d, input, report, { now });
    expect(result.status).toBe("already_applied");
    expect(result.existingBatch?.counts).toEqual(report.counts);
    expect(all(d, tables[0])).toHaveLength(1);
    expect(hashes(d)).toEqual(before);
    expect(changes(d)).toBe(changeCount);
  });
  it("U-09 reordered overlap is no_changes and a superset inserts only new rows", () => {
    const d = populated();
    run(d);
    const before = hashes(d);
    const input = bytes([...dpxFixture()].reverse(), header({ prepared_by: "second-fixture" })),
      p = plan(d, input, { now });
    expect(p.status).toBe("no_changes");
    expect(p.counts.unchanged).toBe(24);
    expect(apply(d, input, p, { now }).status).toBe("no_changes");
    expect(hashes(d)).toEqual(before);
    const superset = run(d, [...dpxFixture(), work({ work_key: "mgpl:second-fixture" })], {
      batchId: "00000000-0000-4000-8000-000000000096",
    });
    expect(superset.report.counts).toEqual({ inserted: 1, unchanged: 24, rejected: 0, blocked: 0 });
  });
  it("U-10 reference and listing-country assessments remain isolated", () => {
    const d = populated();
    run(d);
    expect(all(d, "dpx_hardware_references")).toHaveLength(4);
    for (const suffix of ["cn-100-us", "cn-100e", "us", "jp"]) {
      const a = assess(
        d,
        {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: "fixturecorp:console-one:" + suffix,
        },
        "soc_name",
      );
      expect(a.status).toBe(suffix === "cn-100-us" ? "current" : "unknown");
      if (suffix !== "cn-100-us") expect(a).toMatchObject({ reason: "no_observation" });
    }
    for (const country of ["US", "JP"])
      expect(
        assess(
          d,
          {
            kind: "store_listing",
            store: "apple_app_store",
            store_app_id: "999999999001",
            country,
          },
          "listing_available",
          country,
        ),
      ).toMatchObject(
        country === "US"
          ? { status: "current", value: true }
          : { status: "unknown", reason: "not_published" },
      );
  });
  it("U-11 model codes compare case-insensitively within one maker", () => {
    const d = db();
    run(d, noMobile());
    reject(
      d,
      [reference({ reference_key: "fixturecorp:console-one:other", model_code: "cn-100" })],
      "model_code_already_assigned",
    );
    const fresh = db();
    const r = reject(
      fresh,
      [
        family(),
        reference(),
        reference({ reference_key: "fixturecorp:console-one:other", model_code: "cn-100" }),
      ],
      "model_code_already_assigned",
    );
    expect(r.counts.blocked).toBe(2);
    expect(
      run(
        d,
        [
          family({ family_key: "othercorp:console-one" }),
          reference({
            family_key: "othercorp:console-one",
            reference_key: "othercorp:console-one:other",
          }),
        ],
        { batchId: "00000000-0000-4000-8000-000000000096" },
      ).result.status,
    ).toBe("applied");
  });
  it("U-12 no-code scopes and conflicting known attributes are never merged", () => {
    const d = db();
    run(d, noMobile());
    reject(
      d,
      [
        reference({
          reference_key: "fixturecorp:console-one:us-2",
          model_code: null,
          scope_market: "US",
        }),
      ],
      "duplicate_scope",
    );
    expect(
      plan(
        d,
        bytes([
          reference({
            reference_key: "fixturecorp:console-one:us-2",
            model_code: null,
            scope_market: "US",
            configuration: "digital",
          }),
        ]),
        { now },
      ).status,
    ).toBe("applicable");
    for (const extra of [
      { model_code: "CN-200" },
      { model_code: null, scope_market: "JP" },
      { configuration: "digital" },
      { reference_label: "Other label" },
      { hardware_class: "handheld" },
    ])
      reject(d, [reference(extra)], "attribute_differs");
  });
  it("U-13 equal marketing names keep two families and links do not widen evidence", () => {
    const d = db();
    run(d, noMobile());
    run(d, [family({ family_key: "fixturecorp:console-two" })], {
      batchId: "00000000-0000-4000-8000-000000000096",
    });
    expect(all(d, "dpx_hardware_families")).toHaveLength(2);
    expect(
      assess(d, { kind: "game_edition", edition_key: "mgpl:fixture-quest/pc" }, "edition_title"),
    ).toMatchObject({ status: "unknown", reason: "no_observation" });
    expect(
      assess(
        d,
        { kind: "game_edition", edition_key: "wd:Q999999999001/standard" },
        "edition_title",
      ),
    ).toMatchObject({ status: "current", value: "Fixture Quest" });
  });
  it("U-14 reviewed work links never re-key observations", () => {
    const d = db();
    const records = noMobile().filter((r) => r.record_type !== "work_link");
    run(d, records);
    const keys = obsRows(d).map((r) => r.observation_key);
    run(d, [workLink()], { batchId: "00000000-0000-4000-8000-000000000096" });
    expect(obsRows(d).map((r) => r.observation_key)).toEqual(keys);
    reject(
      d,
      [
        work({ work_key: "wd:Q999999999002", basis: workLink().basis }),
        workLink({ wikidata_work_key: "wd:Q999999999002" }),
      ],
      "attribute_differs",
    );
    reject(d, [workLink({ mgpl_work_key: "wd:Q999999999001" })], "invalid_key");
    reject(db(), [workLink()], "unknown_work_key");
  });
  it("U-15 editions distinguish duplicate, invalid, absent and rejected anchors", () => {
    reject(db(), [work(), edition(), edition()], "duplicate_record");
    reject(db(), [edition({ work_key: "mgpl:different" })], "invalid_key");
    reject(db(), [edition()], "unknown_work_key");
    const r = reject(
      db(),
      [work({ basis: { ...work().basis, source_id: "nope" } }), edition(), storeProduct()],
      "dependency_rejected",
    );
    expect(r.outcomes[1].reasons).toEqual(["dependency_rejected"]);
    expect(r.outcomes[2].reasons).toEqual(["dependency_rejected"]);
  });
  it("U-16 product identity and allowed per-store basis classes", () => {
    const d = db();
    run(d, noMobile());
    reject(d, [storeProduct({ edition_key: "mgpl:fixture-quest/console" })], "attribute_differs");
    for (const [store, store_app_id, source_id] of [
      ["apple_app_store", "999999999002", "apple-app-store-page"],
      ["google_play", "com.example.other", "google-play-page"],
      ["steam", "1000002", "publisher-pages"],
      ["playstation_store", "FIXTURE-1", "publisher-pages"],
      ["microsoft_store", "FIXTURE-1", "publisher-pages"],
      ["nintendo_eshop", "FIXTURE-1", "publisher-pages"],
    ]) {
      const item = storeProduct({ store, store_app_id, basis: { ...work().basis, source_id } });
      expect(plan(d, bytes([item]), { now }).status).toBe("applicable");
      reject(
        d,
        [{ ...item, basis: { ...work().basis, source_id: "manufacturer-pages" } }],
        "basis_source_not_permitted",
      );
    }
  });
  it.each([
    [
      { subject: { kind: "mobile_reference", reference_key: "apple:example:us-cellular-5g" } },
      "field_owned_by_mobile_staging",
    ],
    [{ field: "avg_fps" }, "field_forbidden"],
    [
      { source: { source_id: "nope", url: "https://source.example/x", source_version: null } },
      "source_not_registered",
    ],
    [{ collection: "bounded_get", reviewed_on: null }, "collection_not_permitted"],
    [{ basis: "estimated" }, "basis_not_in_contract"],
  ])("U-17 passes through AI-094 refusal %s", (extra, reason) => {
    const r = reject(db(), [observation(extra as Partial<EvidenceObservation>)], reason as string);
    const admitted = validateObservation(
      observation(extra as Partial<EvidenceObservation>).observation,
      { now },
    );
    expect(r.outcomes[0].reasons).toEqual(admitted.ok ? [] : admitted.reasons);
  });
  it("U-18 reachable anchors have specific refusals and hardware classes must match", () => {
    const examples: [SubjectRef, EvidenceObservation["field"], string][] = [
      [
        { kind: "game_edition", edition_key: "mgpl:nope/pc" },
        "edition_title",
        "unknown_edition_key",
      ],
      [
        {
          kind: "store_listing",
          store: "apple_app_store",
          store_app_id: "999999999002",
          country: "US",
        },
        "listing_available",
        "unknown_store_product",
      ],
      [
        {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: "fixturecorp:missing:x",
        },
        "soc_name",
        "unknown_hardware_reference",
      ],
    ];
    for (const [subject, field, reason] of examples) {
      const source =
        field === "soc_name"
          ? observation().observation.source
          : {
              source_id: field === "listing_available" ? "apple-app-store-page" : "publisher-pages",
              url: "https://source.example/x",
              source_version: null,
            };
      reject(
        db(),
        [
          observation({
            subject,
            field,
            value: field === "listing_available" ? true : "Fixture label",
            source,
          }),
        ],
        reason,
      );
    }
    reject(db(), [reference()], "unknown_family_key");
    const d = db();
    run(d, noMobile());
    const pair = observation({
      subject: {
        kind: "pairing",
        game: { kind: "game_edition", edition_key: "mgpl:fixture-quest/pc" },
        device: {
          kind: "hardware_reference",
          hardware_class: "handheld",
          reference_key: reference().reference_key,
        },
      },
      field: "native_edition_support",
      value: true,
      source: {
        source_id: "publisher-pages",
        url: "https://publisher.example/x",
        source_version: null,
      },
    });
    reject(d, [pair], "hardware_class_mismatch");
    for (const [kind, keyName, key, reason] of [
      ["mobile_reference", "reference_key", "apple:missing:x", "unknown_mobile_reference"],
      [
        "mobile_variant",
        "variant_key",
        "apple:missing:x#ram=8#st=128#sku=x",
        "unknown_mobile_variant",
      ],
    ]) {
      reject(
        d,
        [
          observation({
            ...pair.observation,
            subject: { ...(pair.observation.subject as any), device: { kind, [keyName]: key } },
          }),
        ],
        reason,
      );
    }
  });
  it("U-18 r4 test vocabulary reaches port, mobile-family and OS admission without widening production", () => {
    const fieldsBefore = Object.keys(FIELD_REGISTRY),
      registerBefore = canonicalJson(SOURCE_REGISTER);
    const registry: FieldRegistry = {
      ...FIELD_REGISTRY,
      test_port_label: {
        class: "hardware_spec",
        subjects: ["hardware_port"],
        value: "text",
        unit: null,
        bases: ["documented"],
        maxLength: 40,
      },
      test_family_note: {
        class: "label",
        subjects: ["mobile_family"],
        value: "text",
        unit: null,
        bases: ["documented"],
        maxLength: 40,
      },
    };
    const grant = {
      store: "normalized_fact",
      publish_if_origin_verified: "withheld",
      publish_decision: "U-3",
    } as const;
    const register: SourceRegisterView = {
      entries: SOURCE_REGISTER.map((s) =>
        s.id === "manufacturer-pages"
          ? {
              ...s,
              fields: {
                ...s.fields,
                test_port_label: grant,
                test_family_note: grant,
                os_lifecycle_status: grant,
              },
            }
          : s,
      ),
      originRules: [],
    };
    const context = { registry, register };
    const port = observation({
      subject: {
        kind: "hardware_port",
        hardware_class: "console",
        reference_key: reference().reference_key,
        port_id: "hdmi-1",
      },
      field: "test_port_label" as EvidenceObservation["field"],
      value: "Fixture port",
      country: "GLOBAL",
    });
    const mobileFamily = observation({
      subject: { kind: "mobile_family", family_key: "apple:example" },
      field: "test_family_note" as EvidenceObservation["field"],
      value: "Fixture family",
      country: "GLOBAL",
    });
    const os = observation({
      subject: { kind: "os_release", os_product: "android", release: "14" },
      field: "os_lifecycle_status",
      value: "supported",
      country: "GLOBAL",
    });
    const d = db();
    seedMobile(d);
    const records = [family(), reference(), port, mobileFamily, os],
      input = bytes(records),
      report = plan(d, input, { now, ...context });
    expect(report.status).toBe("applicable");
    expect(() => apply(d, input, report, { now, register })).toThrow("plan_not_applicable");
    expect(all(d, "dpx_import_batches")).toEqual([]);
    expect(apply(d, input, report, { now, batchId, ...context }).status).toBe("applied");
    expect(obsRows(d)).toHaveLength(3);
    for (const row of obsRows(d)) {
      expect(row).toMatchObject({ classification: "attested_only", effective_publish: "withheld" });
      const reading = dpx.dpxReadingFromRow(row),
        admitted = validateObservation(reading.observation, { now, ...context });
      expect(admitted.ok && admitted.key).toBe(reading.key);
    }
    for (const [record, expected] of [
      [port, ["field_not_in_contract", "field_not_permitted_for_source"]],
      [mobileFamily, ["field_not_in_contract", "field_not_permitted_for_source"]],
      [os, ["field_not_permitted_for_source"]],
    ] as const) {
      const ordinary = plan(d, bytes([record]), { now });
      expect(ordinary.outcomes[0]).toMatchObject({ status: "rejected", reasons: expected });
    }
    const mutants: [ReturnType<typeof observation>, string][] = [
      [
        observation({
          ...port.observation,
          subject: { ...(port.observation.subject as any), reference_key: "fixturecorp:missing:x" },
        }),
        "unknown_hardware_reference",
      ],
      [
        observation({
          ...port.observation,
          subject: { ...(port.observation.subject as any), port_id: "HDMI" },
        }),
        "invalid_key",
      ],
      [
        observation({
          ...mobileFamily.observation,
          subject: { kind: "mobile_family", family_key: "apple:missing" },
        }),
        "unknown_mobile_family",
      ],
      [
        observation({
          ...os.observation,
          subject: { kind: "os_release", os_product: "android", release: "Ubuntu" },
        }),
        "invalid_key",
      ],
    ];
    for (const [record, reason] of mutants)
      expect(reject(d, [record], reason, context).outcomes[0].reasons).toEqual([reason]);
    reject(
      d,
      [observation({ subject: port.observation.subject })],
      "subject_kind_not_allowed_for_field",
    );
    expect(Object.isFrozen(FIELD_REGISTRY)).toBe(true);
    expect(Object.keys(FIELD_REGISTRY)).toEqual(fieldsBefore);
    expect(fieldsBefore).toHaveLength(15);
    expect(canonicalJson(SOURCE_REGISTER)).toBe(registerBefore);
  });
  it("U-19 every persisted row reconstructs and re-validates with identical admission", () => {
    const d = populated();
    run(d);
    expect(dpx.dpxLogicalReferenceReport(d)).toEqual({
      missing_mobile_family: [],
      missing_mobile_reference: [],
      missing_mobile_variant: [],
    });
    for (const row of obsRows(d)) {
      const reading = dpx.dpxReadingFromRow(row),
        { reviewed_on: _review, ...content } = reading.observation;
      expect(sha256Hex(canonicalJson(content))).toBe(row.observation_key);
      const admitted = validateObservation(reading.observation, { now });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error("invalid reconstructed fixture");
      expect(admitted.key).toBe(reading.key);
      expect(row.classification).toBe(admitted.classification);
      expect(row.effective_publish).toBe(admitted.effective_publish);
    }
    const register: SourceRegisterView = {
      entries: SOURCE_REGISTER,
      originRules: [{ source_id: "manufacturer-pages", hosts: ["maker.example"], path: /^\// }],
    };
    const d2 = db();
    run(d2, [family(), reference(), observation()], { register });
    expect(obsRows(d2)[0]).toMatchObject({
      classification: "origin_verified",
      effective_publish: "withheld",
    });
  });
  it("U-20 later review is unchanged and retains the first review date", () => {
    const d = db();
    run(d, [family(), reference(), observation({ reviewed_on: "2026-10-21" })]);
    const before = obsRows(d);
    const r = plan(d, bytes([observation()]), { now });
    expect(r.counts.unchanged).toBe(1);
    expect(apply(d, bytes([observation()]), r, { now }).status).toBe("no_changes");
    expect(obsRows(d)).toEqual(before);
  });
  it("U-21 unknown and not_listed keep SQL NULL and non-exhaustive state", () => {
    const d = db();
    run(d, [
      ...noMobile(),
      observation({
        subject: {
          kind: "pairing",
          game: { kind: "game_edition", edition_key: "mgpl:fixture-quest/pc" },
          device: {
            kind: "hardware_reference",
            hardware_class: "console",
            reference_key: reference().reference_key,
          },
        },
        field: "publisher_lists_device",
        value_state: "unknown",
        value: null,
        basis: null,
        unknown_reason: "not_listed",
        list_exhaustive: false,
        source: {
          source_id: "publisher-pages",
          url: "https://publisher.example/not-listed",
          source_version: null,
        },
      }),
    ]);
    const unknown = obsRows(d).filter((r) => r.value_state === "unknown");
    expect(unknown).toHaveLength(2);
    expect(unknown.every((r) => r.value_json === null)).toBe(true);
    expect(unknown.find((r) => r.unknown_reason === "not_listed")?.list_exhaustive).toBe(0);
  });
  it("U-22 parser/header/local validation rules have exact reasons", () => {
    const d = db();
    for (const [input, reason] of [
      [Buffer.from("\n"), "blank_line"],
      [Buffer.from("[]"), "malformed_json"],
      [Buffer.from("{"), "malformed_json"],
      [Buffer.from([0xff]), "invalid_utf8"],
      [Buffer.from("\ufeff{}"), "bom_not_allowed"],
    ] as const)
      expect(plan(d, input, { now }).header.reasons).toEqual([reason]);
    expect(plan(d, Buffer.alloc(0), { now }).header.reasons).toEqual(["header_missing"]);
    for (const [h, reason] of [
      [header({ contract: "wrong" }), "contract_mismatch"],
      [header({ prepared_by: " leading" }), "text_invalid"],
      [header({ prepared_on: "2026-02-30" }), "invalid_date"],
      [header({ prepared_on: "2026-10-23" }), "observed_in_future"],
    ])
      expect(plan(d, bytes([], h), { now }).header.reasons).toEqual([reason]);
    const missing = family() as any;
    delete missing.marketing_name;
    const mutants: [unknown, string][] = [
      [header(), "header_duplicate"],
      [{ record_type: "other" }, "unknown_record_type"],
      [missing, "missing_property"],
      [{ ...family(), extra: true }, "unexpected_property"],
      [family({ family_key: "a:b:c" }), "invalid_key"],
      [family({ hardware_class: "phone" }), "use_mobile_subject"],
      [family({ marketing_name: "bad\ntext" }), "text_invalid"],
      [family({ basis: { ...family().basis, url: "http://maker.example/x" } }), "invalid_url"],
      [family({ basis: { ...family().basis, observed_on: "2026-02-30" } }), "invalid_date"],
      [family({ basis: { ...family().basis, observed_on: "2026-10-23" } }), "observed_in_future"],
      [
        family({ basis: { ...family().basis, source_id: "wikidata" } }),
        "basis_source_not_permitted",
      ],
    ];
    for (const [record, reason] of mutants)
      expect(plan(d, bytes([record]), { now }).outcomes[0].reasons).toEqual([reason]);
    for (const extra of [
      { configuration: "Upper" },
      { model_code: "!" },
      { model_code: null, scope_market: "us" },
    ])
      expect(plan(d, bytes([reference(extra)]), { now }).outcomes[0].reasons).toEqual([
        "invalid_value",
      ]);
    expect(
      plan(d, bytes([reference({ scope_market: "US" })]), { now }).outcomes[0].reasons,
    ).toEqual(["model_code_scope_invalid"]);
    const register: SourceRegisterView = {
      entries: SOURCE_REGISTER,
      originRules: [{ source_id: "manufacturer-pages", hosts: ["approved.example"], path: /^\// }],
    };
    expect(plan(d, bytes([family()]), { now, register }).outcomes[0].reasons).toEqual([
      "source_origin_mismatch",
    ]);
    for (const url of [
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://user:pass@maker.example/x",
      "https://maker.example:444/x",
      "https://maker.example/x#fragment",
    ])
      expect(
        plan(d, bytes([family({ basis: { ...family().basis, url } })]), { now }).outcomes[0]
          .reasons,
      ).toEqual(["invalid_url"]);
    const crlf = Buffer.from(bytes([family()]).toString().replace(/\n/g, "\r\n"));
    expect(plan(d, crlf, { now }).status).toBe("applicable");
  });
  it("U-23 all 162 bounded orders preserve content outcomes, rows and citations", () => {
    function mulberry32(seed: number) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function orders(n: number, seed: number) {
      const identity = Array.from({ length: n }, (_, i) => i),
        out = [identity, [...identity].reverse()],
        rand = mulberry32(seed);
      for (let k = 0; k < 64; k++) {
        const p = [...identity];
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [p[i], p[j]] = [p[j], p[i]];
        }
        out.push(p);
      }
      return out;
    }
    function permutations(p: number[]): number[][] {
      return p.length <= 1
        ? [p]
        : p.flatMap((x, i) =>
            permutations(p.filter((_, j) => i !== j)).map((rest) => [x, ...rest]),
          );
    }
    expect(mulberry32(95001)()).toBe(0.6490030733402818);
    expect(orders(24, 95001)[2].slice(0, 6)).toEqual([0, 11, 22, 7, 21, 1]);
    expect(sha256Hex(JSON.stringify(orders(24, 95001)))).toBe(
      "425ed8ffa7812eb28a81d9132eef2ad5a867288701c82d12dd5961be000e01f1",
    );
    expect(sha256Hex(JSON.stringify(orders(28, 95004)))).toBe(
      "73c3db6039b43fa31c2cf3311c3d0914a16199761dc914a5b22abb8699d26dbb",
    );
    const aFamily = family({ basis: { ...family().basis, url: "https://maker.example/a" } }),
      bFamily = family({ basis: { ...family().basis, url: "https://maker.example/b" } });
    const c = [aFamily, bFamily, observation({ reviewed_on: "2026-10-21" }), observation()];
    const cases = [
      dpxFixture(),
      [aFamily, bFamily, family({ marketing_name: "Different Label" })],
      c,
      [...dpxFixture(), ...c],
    ];
    let count = 0;
    for (const [caseIndex, records] of cases.entries()) {
      const selected =
        records.length <= 7
          ? permutations(records.map((_, i) => i))
          : orders(records.length, caseIndex === 0 ? 95001 : 95004);
      expect(new Set(selected.map((p) => JSON.stringify(p))).size).toBe(selected.length);
      let baseline: unknown;
      for (const order of selected) {
        const d = db();
        seedMobile(d);
        const arranged = order.map((i) => records[i]),
          input = bytes(arranged),
          report = plan(d, input, { now });
        equations(report);
        const contentOutcomes = report.outcomes
          .map((o, i) => ({
            content: canonicalJson(arranged[i]),
            status: o.status,
            reasons: o.reasons,
            ref: o.ref,
          }))
          .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
        let written: unknown = null;
        if (report.status === "applicable") {
          apply(d, input, report, { now, batchId });
          written = hashes(d, [...tables].slice(1));
        } else {
          expect(report.planSha256).toBeNull();
          expect(all(d, "dpx_import_batches")).toEqual([]);
        }
        const effect = {
          contentOutcomes,
          citations: report.citations,
          counts: report.counts,
          written,
        };
        if (baseline === undefined) baseline = effect;
        else expect(effect).toEqual(baseline);
        if (caseIndex === 1)
          expect(
            report.outcomes.every(
              (o) => o.status === "blocked" && canonicalJson(o.reasons) === '["attribute_differs"]',
            ),
          ).toBe(true);
        if (caseIndex === 2 || caseIndex === 3) {
          const byKey = new Map<string, number[]>();
          arranged.forEach((r: any, i) => {
            const key =
              r.record_type === "hardware_family"
                ? r.family_key
                : r.record_type === "observation"
                  ? (() => {
                      const { reviewed_on: _date, ...rest } = r.observation;
                      return sha256Hex(canonicalJson(rest));
                    })()
                  : canonicalJson(r);
            byKey.set(key, [...(byKey.get(key) ?? []), i]);
          });
          for (const members of byKey.values())
            if (members.length > 1) {
              const smallest = [...members].sort((a, b) => {
                const x = canonicalJson(arranged[a]),
                  y = canonicalJson(arranged[b]);
                return x < y ? -1 : x > y ? 1 : a - b;
              })[0];
              expect(report.outcomes[smallest].reasons).not.toContain("duplicate_record");
              for (const member of members.filter((x) => x !== smallest))
                expect(report.outcomes[member]).toMatchObject({
                  status: "rejected",
                  reasons: ["duplicate_record"],
                });
            }
        }
        d.close();
        count++;
      }
    }
    expect(count).toBe(162);
    const d = db();
    run(d, [aFamily, reference(), observation({ reviewed_on: "2026-10-21" })]);
    expect(all(d, "dpx_hardware_families")[0].basis_url).toBe("https://maker.example/a");
    expect(obsRows(d)[0].reviewed_on).toBe("2026-10-21");
  });
  it("U-24 S1–S6 service binding and error precedence", () => {
    const a = bytes(),
      d = populated(),
      p = plan(d, a, { now }),
      before = hashes(d),
      n = changes(d);
    const b = bytes(
      dpxFixture().map((r) =>
        r.record_type === "hardware_family"
          ? family({
              marketing_name: "Unreviewed label",
              basis: { ...family().basis, url: "https://unreviewed.example/b" },
            })
          : r,
      ),
    );
    expect(() => apply(d, b, p, { now, batchId: "invalid" })).toThrow("input_mismatch");
    expect(hashes(d)).toEqual(before);
    expect(changes(d)).toBe(n);
    expect(() => apply(d, a, p, { now, batchId: "invalid" })).toThrow("invalid batch ID");
    expect(() => apply(d, a, { ...p, planSha256: null }, { now })).toThrow("plan_digest_missing");
    const missing = track(new Database(":memory:"));
    expect(() => apply(missing, a, p, { now })).toThrow("tables_missing");
    expect(apply(d, a, p, { now, batchId }).status).toBe("applied");
    const applied = hashes(d),
      appliedChanges = changes(d);
    for (const planSha256 of [p.planSha256, "f".repeat(64), null])
      expect(apply(d, a, { inputSha256: p.inputSha256, planSha256 }, { now }).status).toBe(
        "already_applied",
      );
    expect(hashes(d)).toEqual(applied);
    expect(changes(d)).toBe(appliedChanges);
    const stale = populated(),
      stalePlan = plan(stale, a, { now });
    run(stale, noMobile().slice(0, 2));
    const staleBefore = hashes(stale),
      staleChanges = changes(stale);
    expect(() => apply(stale, a, stalePlan, { now })).toThrow("plan_stale");
    expect(hashes(stale)).toEqual(staleBefore);
    expect(changes(stale)).toBe(staleChanges);
    const conflict = populated(),
      cp = plan(conflict, a, { now });
    run(conflict, [family({ marketing_name: "Different label" })]);
    expect(() => apply(conflict, a, cp, { now })).toThrow("plan_not_applicable");
    const unrelated = populated(),
      up = plan(unrelated, a, { now });
    const extraMobile = mobile.bytes([
      mobile.source({ url: "https://example.invalid/unrelated" }),
      mobile.family({ family_key: "apple:unrelated" }),
    ]);
    const extraMobilePlan = planMobileImport(unrelated, extraMobile, { now: mobile.now });
    applyMobileImport(unrelated, extraMobile, extraMobilePlan, {
      now: mobile.now,
      batchId: "00000000-0000-4000-8000-000000000093",
    });
    expect(apply(unrelated, a, up, { now }).status).toBe("applied");
  });
  it("U-25 report omits private URLs, labels, manufacturers and values", () => {
    const d = populated(),
      report = plan(d, bytes(), { now }),
      serialized = JSON.stringify(report);
    for (const text of [
      family().marketing_name,
      family().manufacturer,
      family().basis.url,
      observation().observation.source.url,
      "Fixture SoC A",
      "Fixture Quest",
      "https://",
    ])
      expect(serialized).not.toContain(text);
    expect(report.citations.length).toBeGreaterThan(0);
    expect(report.citations.reduce((a, c) => a + c.lines, 0)).toBe(24);
    expect(
      report.citations.every(
        (c) => Object.keys(c).sort().join() === "classification,host,lines,source_id",
      ),
    ).toBe(true);
  });
  it("U-26 no user ownership or backup scope changes", () => {
    const d = db();
    for (const table of tables) {
      const columns = d.pragma(`table_info(${table})`) as { name: string }[];
      expect(columns.every((c) => !/user|owner|serial|imei|email/i.test(c.name))).toBe(true);
      expect(
        (d.pragma(`foreign_key_list(${table})`) as { table: string }[]).every((f) =>
          f.table.startsWith("dpx_"),
        ),
      ).toBe(true);
    }
    expect(readSource("src/routes/state.ts")).not.toContain("dpx_");
    expect(readSource("src/scripts/verify-restored-db.ts")).not.toContain("dpx_");
  });
  it("U-27 platform canonical labels and every alias stay unchanged", () => {
    const source = readSource("src/lib/platformTaxonomy.ts"),
      aliasBody = source.match(/const PLATFORM_ALIASES[^=]*= \{([\s\S]*?)\n\};/)![1];
    const aliases = [...aliasBody.matchAll(/^\s*(?:"([^"]+)"|([a-z0-9]+)): /gm)].map(
      (m) => m[1] ?? m[2],
    );
    const inputs = [...CANONICAL_PLATFORMS, ...aliases];
    const before = inputs.map((x) => normalizePlatform(x));
    const d = populated(),
      ownership = all(d, "AppOwnership");
    run(d);
    expect(all(d, "AppOwnership")).toEqual(ownership);
    expect(inputs.map((x) => normalizePlatform(x))).toEqual(before);
    expect(before.every((x) => x !== null)).toBe(true);
    expect(readSource("src/services/dpxIdentityImport.ts")).not.toContain("platformTaxonomy");
  });
  it("U-28 withdrawing a class refuses new admissions and keeps history", () => {
    const d = db();
    run(d, noMobile());
    const before = hashes(d);
    const register: SourceRegisterView = {
      entries: SOURCE_REGISTER.map((s) =>
        s.id === "publisher-pages" ? { ...s, withdrawn_at: "2026-10-22T00:00:00Z" } : s,
      ),
      originRules: [],
    };
    reject(d, [work({ work_key: "mgpl:withdrawn-fixture" })], "basis_source_not_permitted", {
      register,
    });
    const row = dpxFixture().find((r) => r.record_type === "observation") as ReturnType<
      typeof observation
    >;
    reject(d, [row], "collection_not_permitted", { register });
    expect(hashes(d)).toEqual(before);
    expect(assess(d, row.observation.subject, row.observation.field, "US", register).status).toBe(
      "withdrawn",
    );
  });
  it("U-29 K1–K5 and K8–K9 CLI reviewed binding, immutable reports and call order", () => {
    const dir = temp(),
      file = path.join(dir, "cli.db"),
      inputFile = path.join(dir, "input.jsonl"),
      dryFile = path.join(dir, "dry.json"),
      applyFile = path.join(dir, "apply.json");
    const d = populated(file),
      a = bytes();
    writeFileSync(inputFile, a);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const planSpy = vi.fn((...args: Parameters<typeof plan>) => {
      calls.push("plan");
      expect(Object.keys(args[2])).toEqual(["now"]);
      expect(args[0].readonly).toBe(true);
      return plan(...args);
    });
    const applySpy = vi.fn((...args: Parameters<typeof apply>) => {
      calls.push("apply");
      expect(Object.keys(args[3])).toEqual(["now"]);
      expect(args[0].readonly).toBe(false);
      return apply(...args);
    });
    const base = ["--db", file, "--in", inputFile, "--report"],
      before = hashes(d);
    expect(main([...base, dryFile], now, { plan: planSpy, apply: applySpy })).toBe(0);
    expect(calls).toEqual(["plan"]);
    expect(hashes(d)).toEqual(before);
    const dryBytes = readFileSync(dryFile),
      dry = JSON.parse(dryBytes.toString());
    expect(dry).toMatchObject({
      mode: "dry_run",
      apply: null,
      inputSha256: sha256Hex(a),
      citations: expect.any(Array),
    });
    expect(dry.planSha256).toMatch(/^[0-9a-f]{64}$/);
    const args = (report: string, expectation = dry) => [
      ...base,
      report,
      "--apply",
      "--expect-input-sha256",
      expectation.inputSha256,
      "--expect-plan-sha256",
      expectation.planSha256,
    ];
    // K3: changed bytes stop before database open, report reservation or either service call.
    writeFileSync(
      inputFile,
      bytes(
        dpxFixture().map((r) =>
          r.record_type === "hardware_family"
            ? family({
                marketing_name: "Unreviewed label",
                basis: { ...family().basis, url: "https://unreviewed.example/b" },
              })
            : r,
        ),
      ),
    );
    calls.length = 0;
    const fileBefore = readFileSync(file);
    expect(main(args(applyFile), now, { plan: planSpy, apply: applySpy })).toBe(2);
    expect(calls).toEqual([]);
    expect(readFileSync(file)).toEqual(fileBefore);
    expect(existsSync(applyFile)).toBe(false);
    // K8: report immutability wins before the input mismatch.
    expect(main(args(dryFile), now, { plan: planSpy, apply: applySpy })).toBe(2);
    expect(readFileSync(dryFile)).toEqual(dryBytes);
    writeFileSync(inputFile, a);
    calls.length = 0;
    expect(main(args(applyFile), now, { plan: planSpy, apply: applySpy })).toBe(0);
    expect(calls).toEqual(["apply"]);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0][1]).toEqual(a);
    expect(applySpy.mock.calls[0][2]).toEqual({
      inputSha256: dry.inputSha256,
      planSha256: dry.planSha256,
    });
    expect(JSON.parse(readFileSync(applyFile, "utf8"))).toMatchObject({
      apply: { status: "applied" },
      currentPlan: null,
      currentPlanReviewed: false,
    });
    const afterApply = hashes(d);
    calls.length = 0;
    expect(main(args(path.join(dir, "replay.json")), now, { plan: planSpy, apply: applySpy })).toBe(
      0,
    );
    expect(calls).toEqual(["apply"]);
    expect(hashes(d)).toEqual(afterApply);
    expect(JSON.parse(readFileSync(path.join(dir, "replay.json"), "utf8")).apply.status).toBe(
      "already_applied",
    );
    // K4: a different input changes DB effects after review; diagnostic plan runs after failed apply.
    const staleFile = path.join(dir, "stale.db"),
      stale = populated(staleFile),
      staleDry = path.join(dir, "stale-dry.json");
    const staleBase = ["--db", staleFile, "--in", inputFile, "--report"];
    expect(main([...staleBase, staleDry], now)).toBe(0);
    const sp = JSON.parse(readFileSync(staleDry, "utf8"));
    run(stale, noMobile().slice(0, 2));
    const staleBefore = hashes(stale);
    const staleCalls: string[] = [];
    const staleOut = path.join(dir, "stale-apply.json");
    expect(
      main(
        [
          ...staleBase,
          staleOut,
          "--apply",
          "--expect-input-sha256",
          sp.inputSha256,
          "--expect-plan-sha256",
          sp.planSha256,
        ],
        now,
        {
          apply: (...args) => {
            staleCalls.push("apply");
            expect(Object.keys(args[3])).toEqual(["now"]);
            return apply(...args);
          },
          plan: (...args) => {
            expect(args[0].inTransaction).toBe(false);
            staleCalls.push("plan");
            expect(Object.keys(args[2])).toEqual(["now"]);
            return plan(...args);
          },
        },
      ),
    ).toBe(2);
    expect(staleCalls).toEqual(["apply", "plan"]);
    expect(hashes(stale)).toEqual(staleBefore);
    expect(JSON.parse(readFileSync(staleOut, "utf8"))).toMatchObject({
      apply: { error: "plan_stale" },
      currentPlanReviewed: false,
      currentPlan: { status: "applicable" },
    });
    const lines = logs.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        ["mode", "status", "inputSha256", "planSha256", "counts", "batchId"].sort(),
      );
      expect(JSON.stringify(line)).not.toMatch(/https:|Console One|Fixture/);
    }
  });
  it("U-29 K6–K7 and K10 options, production and help touch no files", () => {
    const dir = temp(),
      reportFile = path.join(dir, "out.json");
    const base = [
      "--db",
      path.join(dir, "missing.db"),
      "--in",
      path.join(dir, "missing.jsonl"),
      "--report",
      reportFile,
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const extra of [
      ["--apply"],
      ["--expect-input-sha256", "a".repeat(64)],
      ["--apply", "--expect-input-sha256", "A".repeat(64), "--expect-plan-sha256", "a".repeat(64)],
      ["--apply", "--expect-input-sha256", "a".repeat(63), "--expect-plan-sha256", "a".repeat(64)],
      ["--unknown"],
      ["--db", "duplicate"],
      ["--apply", "--apply"],
      ["--expect-plan-sha256"],
    ]) {
      expect(main([...base, ...extra], now)).toBe(2);
      expect(errors.mock.lastCall?.[0]).not.toMatch(/ENOENT/);
      expect(existsSync(reportFile)).toBe(false);
    }
    expect(main(["--help"], now)).toBe(0);
    expect(main(["--help", "--apply"], now)).toBe(2);
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(main([], now)).toBe(2);
      expect(errors.mock.lastCall?.[0]).toBe("production refused");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    expect(existsSync(reportFile)).toBe(false);
  });
  it("U-29/U-31 record overflow releases only the dry-run reservation and preserves precedence", () => {
    const dir = temp(),
      file = path.join(dir, "limits.db"),
      d = db(file),
      inputFile = path.join(dir, "limits.jsonl"),
      reportFile = path.join(dir, "limits.json"),
      input = Buffer.from(JSON.stringify(header) + "\n" + "{}\n".repeat(20_001));
    writeFileSync(inputFile, input);
    const before = hashes(d),
      fileBefore = readFileSync(file),
      args = ["--db", file, "--in", inputFile, "--report", reportFile],
      planSpy = vi.fn(plan),
      applySpy = vi.fn(apply),
      deps = { plan: planSpy, apply: applySpy },
      errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(args, now, deps)).toBe(2);
    expect(errors.mock.lastCall?.[0]).toBe("input_too_large");
    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(applySpy).not.toHaveBeenCalled();
    expect(existsSync(reportFile)).toBe(false);
    expect(hashes(d)).toEqual(before);
    expect(readFileSync(file)).toEqual(fileBefore);
    // Existing reports still win before input parsing and must never be removed.
    writeFileSync(reportFile, "reviewed report\n");
    expect(main(args, now, deps)).toBe(2);
    expect(errors.mock.lastCall?.[0]).toBe("report already exists");
    expect(readFileSync(reportFile, "utf8")).toBe("reviewed report\n");
    const applyFile = path.join(dir, "apply.json"),
      applyArgs = [
        ...args.slice(0, -1),
        applyFile,
        "--apply",
        "--expect-input-sha256",
        "0".repeat(64),
        "--expect-plan-sha256",
        "1".repeat(64),
      ];
    expect(main(applyArgs, now, deps)).toBe(2);
    expect(errors.mock.lastCall?.[0]).toBe("input_mismatch");
    expect(existsSync(applyFile)).toBe(false);
    // Matching apply input still reaches the service and keeps its declared error report.
    applyArgs[applyArgs.indexOf("--expect-input-sha256") + 1] = sha256Hex(input);
    expect(main(applyArgs, now, deps)).toBe(2);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(applyFile, "utf8"))).toMatchObject({
      mode: "apply",
      apply: { error: "input_too_large" },
      currentPlan: null,
    });
    expect(hashes(d)).toEqual(before);
    d.exec("DROP TABLE dpx_evidence_observations");
    const missingReport = path.join(dir, "missing-tables.json");
    expect(main([...args.slice(0, -1), missingReport], now, deps)).toBe(2);
    expect(errors.mock.lastCall?.[0]).toBe("tables_missing");
    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(missingReport)).toBe(false);
  });
  it("U-30 importer is offline, insert-only and isolated from app DB", () => {
    const source = readSource("src/services/dpxIdentityImport.ts");
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE|DROP|ALTER)\s/);
    expect(source).not.toMatch(/(?:\.\.\/db|node:https?|node:net|guardedFetch|axios)/);
    expect(readSource("scripts/catalogue/import-dpx-identities.ts")).not.toMatch(
      /\b(?:register|registry)\b/,
    );
  });
  it("U-31 byte, record and line bounds", () => {
    expect(() => dpx.parseDpxIdentityJsonl(Buffer.alloc(5_000_001))).toThrow("input_too_large");
    expect(() => dpx.parseDpxIdentityJsonl(Buffer.from("{}\n".repeat(20_002)))).toThrow(
      "input_too_large",
    );
    expect(dpx.parseDpxIdentityJsonl(Buffer.from(" ".repeat(16_385)))).toEqual([
      { line: 1, ok: false, reason: "line_too_long" },
    ]);
    const prefix = '{"record_type":"work","x":"',
      suffix = '"}';
    const line = prefix + "a".repeat(16_384 - Buffer.byteLength(prefix + suffix)) + suffix;
    expect(Buffer.byteLength(line)).toBe(16_384);
    expect(dpx.parseDpxIdentityJsonl(Buffer.from(line))[0].ok).toBe(true);
  });
  it("U-32 maps 23 identity, one record-shape and two observation grammar cases", () => {
    const cases: Array<[string, unknown, string[]]> = [
      ["work wd ok", { kind: "game_work", work_key: "wd:Q42" }, []],
      ["work wd Q0", { kind: "game_work", work_key: "wd:Q0" }, ["invalid_key"]],
      ["work wd 13 digits", { kind: "game_work", work_key: "wd:Q1234567890123" }, ["invalid_key"]],
      ["work mgpl ok", { kind: "game_work", work_key: "mgpl:fixture-quest" }, []],
      ["work mgpl upper", { kind: "game_work", work_key: "mgpl:Fixture" }, ["invalid_key"]],
      ["work mgpl leading dash", { kind: "game_work", work_key: "mgpl:-x" }, ["invalid_key"]],
      ["edition ok", { kind: "game_edition", edition_key: "wd:Q42/standard" }, []],
      ["edition no slug", { kind: "game_edition", edition_key: "wd:Q42/" }, ["invalid_key"]],
      [
        "edition slug 49",
        { kind: "game_edition", edition_key: "wd:Q42/" + "a".repeat(49) },
        ["invalid_key"],
      ],
      [
        "listing apple ok",
        {
          kind: "store_listing",
          store: "apple_app_store",
          store_app_id: "999999999001",
          country: "US",
        },
        [],
      ],
      [
        "listing apple alpha",
        { kind: "store_listing", store: "apple_app_store", store_app_id: "com.x.y", country: "US" },
        ["invalid_key"],
      ],
      [
        "listing google ok",
        {
          kind: "store_listing",
          store: "google_play",
          store_app_id: "com.example.app",
          country: "US",
        },
        [],
      ],
      [
        "listing google no dot",
        { kind: "store_listing", store: "google_play", store_app_id: "example", country: "US" },
        ["invalid_key"],
      ],
      [
        "listing steam ok",
        { kind: "store_listing", store: "steam", store_app_id: "1000001", country: "US" },
        [],
      ],
      [
        "listing unknown store",
        { kind: "store_listing", store: "itch", store_app_id: "x", country: "US" },
        ["invalid_subject"],
      ],
      [
        "family grammar ok (mobile_family probe)",
        { kind: "mobile_family", family_key: "fixturecorp:console-one" },
        [],
      ],
      ["family three segments", { kind: "mobile_family", family_key: "a:b:c" }, ["invalid_key"]],
      [
        "hardware ref ok",
        {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: "fixturecorp:console-one:cn-100-us",
        },
        [],
      ],
      [
        "hardware ref phone",
        {
          kind: "hardware_reference",
          hardware_class: "phone",
          reference_key: "fixturecorp:console-one:x",
        },
        ["use_mobile_subject"],
      ],
      [
        "hardware ref tablet",
        {
          kind: "hardware_reference",
          hardware_class: "tablet",
          reference_key: "fixturecorp:console-one:x",
        },
        ["use_mobile_subject"],
      ],
      [
        "hardware ref unknown class",
        {
          kind: "hardware_reference",
          hardware_class: "toaster",
          reference_key: "fixturecorp:console-one:x",
        },
        ["invalid_subject"],
      ],
      [
        "hardware ref uppercase",
        {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: "FixtureCorp:console-one:x",
        },
        ["invalid_key"],
      ],
      [
        "hardware ref two segments",
        {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: "fixturecorp:console-one",
        },
        ["invalid_key"],
      ],
      ["os release ok", { kind: "os_release", os_product: "android", release: "14" }, []],
      [
        "port ok",
        {
          kind: "hardware_port",
          hardware_class: "display",
          reference_key: "fixturecorp:panel-a:p1",
          port_id: "hdmi-1",
        },
        [],
      ],
      [
        "extra subject property",
        { kind: "game_work", work_key: "wd:Q42", title: "x" },
        ["invalid_subject"],
      ],
    ];
    expect(cases).toHaveLength(26);
    let identities = 0,
      shapes = 0,
      observationKinds = 0;
    for (const [name, subject, expected] of cases) {
      const d = db(),
        s = subject as any;
      let record: unknown,
        anchors: unknown[] = [],
        opts: Parameters<typeof plan>[2] = { now };
      const wikidataBasis = workLink().basis;
      switch (s.kind) {
        case "game_work":
          record = work({
            work_key: s.work_key,
            basis: s.work_key.startsWith("wd:") ? wikidataBasis : work().basis,
            ...(s.title === undefined ? {} : { title: s.title }),
          });
          break;
        case "game_edition":
          anchors = [work({ work_key: s.edition_key.split("/")[0], basis: wikidataBasis })];
          record = edition({
            edition_key: s.edition_key,
            work_key: s.edition_key.split("/")[0],
            basis: wikidataBasis,
          });
          break;
        case "store_listing":
          anchors = [work(), edition()];
          record = storeProduct({ store: s.store, store_app_id: s.store_app_id });
          break;
        case "mobile_family":
          record = family({ family_key: s.family_key });
          break;
        case "hardware_reference":
          anchors = [family()];
          record = reference({
            reference_key: s.reference_key,
            family_key: "fixturecorp:console-one",
            hardware_class: s.hardware_class,
          });
          break;
        default: {
          const registry: FieldRegistry = {
            ...FIELD_REGISTRY,
            test_port_label: {
              class: "hardware_spec",
              subjects: ["hardware_port"],
              value: "text",
              unit: null,
              bases: ["documented"],
              maxLength: 40,
            },
          };
          const grant = {
            store: "normalized_fact",
            publish_if_origin_verified: "withheld",
            publish_decision: "U-3",
          } as const;
          const register: SourceRegisterView = {
            entries: SOURCE_REGISTER.map((entry) =>
              entry.id === "manufacturer-pages"
                ? {
                    ...entry,
                    fields: { ...entry.fields, test_port_label: grant, os_lifecycle_status: grant },
                  }
                : entry,
            ),
            originRules: [],
          };
          opts = { now, registry, register };
          if (s.kind === "hardware_port")
            anchors = [
              family({ family_key: "fixturecorp:panel-a", hardware_class: "display" }),
              reference({
                reference_key: "fixturecorp:panel-a:p1",
                family_key: "fixturecorp:panel-a",
                hardware_class: "display",
                model_code: "PA-1",
              }),
            ];
          record = observation({
            subject: s,
            field: (s.kind === "os_release"
              ? "os_lifecycle_status"
              : "test_port_label") as EvidenceObservation["field"],
            value: s.kind === "os_release" ? "supported" : "Fixture port",
            country: "GLOBAL",
          });
        }
      }
      const report = plan(d, bytes([...anchors, record]), opts),
        outcome = report.outcomes.at(-1)!;
      if (s.title !== undefined) {
        expect(outcome.reasons, name).toEqual(["unexpected_property"]);
        shapes++;
      } else {
        const got = outcome.reasons.filter((r) =>
          ["invalid_subject", "invalid_key", "use_mobile_subject"].includes(r),
        );
        expect(got, name).toEqual(expected);
        if (expected.length === 0) expect(outcome.status, name).toBe("inserted");
        if (["os_release", "hardware_port"].includes(s.kind)) observationKinds++;
        else identities++;
      }
    }
    expect({ identities, shapes, observationKinds }).toEqual({
      identities: 23,
      shapes: 1,
      observationKinds: 2,
    });
  });
});
