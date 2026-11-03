import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const now = new Date("2026-10-21T12:00:00.000Z");
export const header = {
  record_type: "header",
  contract: "mgpl-mobile-staging/1",
  prepared_on: "2026-10-21",
  prepared_by: "fixture",
};
export const source = (extra: Record<string, unknown> = {}) => ({
  record_type: "source",
  ref: "s",
  url: "https://example.invalid/s1",
  publisher: "Apple",
  market: "US",
  access_method: "manual_read",
  raw_page_stored: false,
  ...extra,
});
export const family = (extra: Record<string, unknown> = {}) => ({
  record_type: "family",
  family_key: "apple:example",
  manufacturer: "Apple",
  device_class: "Phone",
  os_family: "ios",
  marketing_name: "Example Mobile",
  basis_source_ref: "s",
  ...extra,
});
export const reference = (extra: Record<string, unknown> = {}) => ({
  record_type: "reference",
  reference_key: "apple:example:us-cellular-5g",
  family_key: "apple:example",
  reference_label: "Example Reference",
  connectivity: "cellular_5g",
  model_code: null,
  scope_market: "US",
  model_code_source_ref: null,
  model_code_observed_on: null,
  basis_source_ref: "s",
  ...extra,
});
export const variant = (extra: Record<string, unknown> = {}) => ({
  record_type: "variant",
  reference_key: "apple:example:us-cellular-5g",
  ram_gb: 8,
  storage_gb: 128,
  retail_sku_code: null,
  basis_source_ref: "s",
  observed_on: "2026-10-21",
  ...extra,
});
export const observation = (extra: Record<string, unknown> = {}) => ({
  record_type: "observation",
  subject_level: "reference",
  subject_key: "apple:example:us-cellular-5g",
  field: "soc_name",
  value_state: "stated",
  value: "Example Chip",
  unit: null,
  market: "US",
  scope_qualifier: "none",
  source_ref: "s",
  observed_on: "2026-10-21",
  source_updated_at: null,
  ...extra,
});
export const listing = (extra: Record<string, unknown> = {}) => ({
  record_type: "listing",
  reference_key: "apple:example:us-cellular-5g",
  store: "apple_app_store",
  store_country: "US",
  store_app_id: "example.app",
  game_title: "Example Game",
  evidence_kind: "publisher_listed",
  match_basis: "publisher_device_name",
  listed_name: "Example Mobile",
  required_os: null,
  source_ref: "s",
  observed_on: "2026-10-21",
  ...extra,
});
export const fixture = () => [source(), family(), reference(), variant(), observation(), listing()];
export const bytes = (records: unknown[] = fixture(), h: unknown = header) =>
  Buffer.from([h, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n");
export const dbSource = fs.readFileSync(path.resolve("src/db.ts"), "utf8");
export const ddl = dbSource.match(/const MOBILE_STAGING_DDL = `\n([\s\S]*?)`;/)![1];
export function database(file = ":memory:") {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec(ddl);
  return db;
}
