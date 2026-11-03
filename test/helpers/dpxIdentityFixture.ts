import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ddl } from "./mobileStagingFixture";
import { EVIDENCE_CONTRACT, type EvidenceObservation } from "../../src/lib/evidenceContract";

export const DPX_NOW = new Date("2026-10-22T12:00:00Z");
export const DPX_BATCH = "00000000-0000-4000-8000-000000000095";
export const dpxDdl = fs
  .readFileSync(path.resolve("src/db.ts"), "utf8")
  .match(/const DPX_IDENTITY_DDL = `\n([\s\S]*?)`;/)![1];
export function dpxDatabase(file = ":memory:") {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec(ddl);
  db.exec(dpxDdl);
  return db;
}
type Extra = Record<string, unknown>;
const publisherBasis = {
  source_id: "publisher-pages",
  url: "https://publisher.example/fixture-quest",
  observed_on: "2026-10-21",
};
const makerBasis = {
  source_id: "manufacturer-pages",
  url: "https://maker.example/console-one/models",
  observed_on: "2026-10-21",
};
export const header = (extra: Extra = {}) => ({
  record_type: "header",
  contract: "mgpl-dpx-identity/1",
  prepared_on: "2026-10-22",
  prepared_by: "fixture",
  ...extra,
});
export const work = (extra: Extra = {}) => ({
  record_type: "work",
  work_key: "mgpl:fixture-quest",
  basis: publisherBasis,
  ...extra,
});
export const workLink = (extra: Extra = {}) => ({
  record_type: "work_link",
  mgpl_work_key: "mgpl:fixture-quest",
  wikidata_work_key: "wd:Q999999999001",
  basis: {
    source_id: "wikidata",
    url: "https://wikidata.fixture.test/wiki/Q999999999001",
    observed_on: "2026-10-21",
  },
  ...extra,
});
export const edition = (extra: Extra = {}) => ({
  record_type: "edition",
  edition_key: "mgpl:fixture-quest/pc",
  work_key: "mgpl:fixture-quest",
  basis: publisherBasis,
  ...extra,
});
export const storeProduct = (extra: Extra = {}) => ({
  record_type: "store_product",
  store: "apple_app_store",
  store_app_id: "999999999001",
  edition_key: "mgpl:fixture-quest/pc",
  basis: publisherBasis,
  ...extra,
});
export const hardwareFamily = (extra: Extra = {}) => ({
  record_type: "hardware_family",
  family_key: "fixturecorp:console-one",
  manufacturer: "FixtureCorp",
  hardware_class: "console",
  marketing_name: "Console One",
  basis: makerBasis,
  ...extra,
});
export const hardwareReference = (extra: Extra = {}) => ({
  record_type: "hardware_reference",
  reference_key: "fixturecorp:console-one:cn-100-us",
  family_key: "fixturecorp:console-one",
  hardware_class: "console",
  reference_label: "Console One",
  configuration: "standard",
  scope_market: null,
  model_code: "CN-100",
  basis: makerBasis,
  ...extra,
});
export const observationRecord = (extra: Partial<EvidenceObservation> = {}) => ({
  record_type: "observation",
  observation: {
    contract: EVIDENCE_CONTRACT,
    subject: {
      kind: "hardware_reference",
      hardware_class: "console",
      reference_key: "fixturecorp:console-one:cn-100-us",
    },
    field: "soc_name",
    value_state: "stated",
    value: "Fixture SoC A",
    unit: null,
    unknown_reason: null,
    basis: "documented",
    list_exhaustive: null,
    country: "US",
    source: {
      source_id: "manufacturer-pages",
      url: "https://maker.example/console-one/cn-100",
      source_version: null,
    },
    collection: "manual_read",
    observed_at: "2026-10-21",
    source_updated_at: null,
    reviewed_on: "2026-10-22",
    ...extra,
  } as EvidenceObservation,
});
const publisher = {
  source_id: "publisher-pages",
  url: "https://publisher.example/fixture-quest/requirements",
  source_version: null,
};
export function dpxFixture({ mobile = true } = {}) {
  const pc = { kind: "game_edition", edition_key: "mgpl:fixture-quest/pc" } as const;
  const listing = {
    kind: "store_listing",
    store: "apple_app_store",
    store_app_id: "999999999001",
    country: "US",
  } as const;
  const records = [
    work({ work_key: "wd:Q999999999001", basis: workLink().basis }),
    work(),
    workLink(),
    edition(),
    edition({ edition_key: "mgpl:fixture-quest/console" }),
    edition({
      edition_key: "wd:Q999999999001/standard",
      work_key: "wd:Q999999999001",
      basis: workLink().basis,
    }),
    storeProduct(),
    storeProduct({ store: "google_play", store_app_id: "com.example.fixturequest" }),
    storeProduct({ store: "steam", store_app_id: "1000001" }),
    hardwareFamily(),
    hardwareReference(),
    hardwareReference({ reference_key: "fixturecorp:console-one:cn-100e", model_code: "CN-100E" }),
    hardwareReference({
      reference_key: "fixturecorp:console-one:us",
      model_code: null,
      scope_market: "US",
    }),
    hardwareReference({
      reference_key: "fixturecorp:console-one:jp",
      model_code: null,
      scope_market: "JP",
    }),
    observationRecord({
      subject: {
        kind: "game_build",
        edition_key: pc.edition_key,
        platform: "android",
        version: null,
      },
      field: "requires_ram_gb",
      value: 4,
      unit: "GB",
      source: publisher,
    }),
    observationRecord({
      subject: {
        kind: "pairing",
        game: { kind: "game_edition", edition_key: "mgpl:fixture-quest/console" },
        device: {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: hardwareReference().reference_key,
        },
      },
      field: "native_edition_support",
      value: true,
      source: publisher,
    }),
    ...(mobile
      ? [
          observationRecord({
            subject: {
              kind: "pairing",
              game: pc,
              device: { kind: "mobile_reference", reference_key: "apple:example:us-cellular-5g" },
            },
            field: "publisher_lists_device",
            value: true,
            list_exhaustive: false,
            source: publisher,
          }),
          observationRecord({
            subject: {
              kind: "pairing",
              game: pc,
              device: {
                kind: "mobile_variant",
                variant_key: "apple:example:us-cellular-5g#ram=8#st=128#sku=x",
              },
            },
            field: "native_edition_support",
            value: false,
            source: publisher,
          }),
        ]
      : []),
    observationRecord({
      subject: listing,
      field: "listing_available",
      value: true,
      source: {
        source_id: "apple-app-store-page",
        url: "https://apps.example/fixture-quest",
        source_version: null,
      },
    }),
    observationRecord({
      subject: { ...listing, country: "JP" },
      country: "JP",
      field: "listing_available",
      value_state: "unknown",
      value: null,
      unknown_reason: "not_published",
      basis: null,
      source: {
        source_id: "apple-app-store-page",
        url: "https://apps.example/fixture-quest",
        source_version: null,
      },
    }),
    observationRecord(),
    observationRecord({
      subject: { kind: "game_edition", edition_key: "wd:Q999999999001/standard" },
      field: "edition_title",
      value: "Fixture Quest",
      country: "GLOBAL",
      source: {
        source_id: "wikidata",
        url: "https://wikidata.fixture.test/wiki/Q999999999001",
        source_version: "2400000001",
      },
    }),
    observationRecord({
      subject: {
        kind: "game_build",
        edition_key: pc.edition_key,
        platform: "android",
        version: "1.2.3",
      },
      field: "supported_cpu_abis",
      value: ["arm64-v8a", "x86_64"],
      list_exhaustive: true,
      source: publisher,
    }),
    observationRecord({
      subject: {
        kind: "pairing",
        game: {
          kind: "store_listing",
          store: "google_play",
          store_app_id: "com.example.fixturequest",
          country: "US",
        },
        device: {
          kind: "hardware_reference",
          hardware_class: "console",
          reference_key: "fixturecorp:console-one:cn-100e",
        },
      },
      field: "publisher_lists_device",
      value: true,
      list_exhaustive: false,
      source: publisher,
    }),
  ];
  return records;
}
export const dpxBytes = (records: unknown[] = dpxFixture(), h: unknown = header()) =>
  Buffer.from([h, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n");
