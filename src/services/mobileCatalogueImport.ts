import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { canonicalJson, sha256Hex } from "./enrichmentPromotion";
import { normalizePlatform } from "../lib/platformTaxonomy";

export const MOBILE_STAGING_CONTRACT = "mgpl-mobile-staging/1" as const;
export const MOBILE_STAGING_TABLES = [
  "mobile_import_batches",
  "mobile_sources",
  "mobile_device_families",
  "mobile_hardware_references",
  "mobile_device_variants",
  "mobile_variant_sightings",
  "mobile_observations",
  "mobile_listing_observations",
] as const;
export const MOBILE_MANUFACTURERS = ["Apple", "Samsung", "Google"] as const;
export const MOBILE_SOURCE_PUBLISHERS = ["Apple", "Samsung", "Google"] as const;
export const MOBILE_STORES = ["apple_app_store", "google_play"] as const;
export const MOBILE_IMPORT_LIMITS = {
  maxBytes: 5_000_000,
  maxRecords: 20_000,
  maxLineBytes: 4_096,
} as const;
type MobileField =
  | "soc_name"
  | "gpu_core_count"
  | "ram_gb"
  | "ram_options_gb"
  | "screen_diagonal_in"
  | "display_resolution_px"
  | "display_refresh_max_hz"
  | "latest_major_os_eligible"
  | "security_update_cadence"
  | "update_policy_years";
type FieldSpec = {
  kind: "hardware" | "support";
  value: "text" | "integer" | "number" | "list";
  unit: string | null;
  min?: number;
  max?: number;
  levels: readonly string[];
};
const levels = ["family", "reference"] as const;
export const MOBILE_OBSERVATION_FIELDS: Readonly<Record<MobileField, FieldSpec>> = {
  soc_name: { kind: "hardware", value: "text", unit: null, levels },
  gpu_core_count: { kind: "hardware", value: "integer", unit: "cores", min: 1, max: 256, levels },
  ram_gb: { kind: "hardware", value: "integer", unit: "GB", min: 1, max: 64, levels },
  ram_options_gb: { kind: "hardware", value: "list", unit: "GB", min: 1, max: 64, levels },
  screen_diagonal_in: { kind: "hardware", value: "number", unit: "in", min: 3, max: 20, levels },
  display_resolution_px: {
    kind: "hardware",
    value: "list",
    unit: "px",
    min: 240,
    max: 8192,
    levels,
  },
  display_refresh_max_hz: {
    kind: "hardware",
    value: "integer",
    unit: "Hz",
    min: 30,
    max: 240,
    levels,
  },
  latest_major_os_eligible: { kind: "support", value: "text", unit: null, levels },
  security_update_cadence: { kind: "support", value: "text", unit: null, levels },
  update_policy_years: { kind: "support", value: "integer", unit: "year", min: 1, max: 10, levels },
};
export type MobileImportErrorCode =
  | "input_mismatch"
  | "plan_stale"
  | "plan_not_applicable"
  | "plan_digest_missing"
  | "tables_missing"
  | "input_too_large";
export class MobileImportError extends Error {
  constructor(readonly code: MobileImportErrorCode) {
    super(code);
    this.name = "MobileImportError";
  }
}
export type MobileRecordType =
  "header" | "source" | "family" | "reference" | "variant" | "observation" | "listing";
export type LineStatus =
  | "inserted"
  | "inserted_quarantined"
  | "inserted_superseded"
  | "sighting_added"
  | "unchanged"
  | "model_code_resolved"
  | "rejected"
  | "blocked";
export interface HeaderOutcome {
  line: 1 | null;
  status: "accepted" | "rejected";
  reasons: string[];
}
export interface LineOutcome {
  line: number;
  recordType: MobileRecordType | null;
  status: LineStatus;
  ref: string | null;
  reasons: string[];
}
export interface ExistingRowEffect {
  table: "mobile_observations";
  ref: string;
  transition: "accepted_to_quarantined" | "accepted_to_superseded";
  reason: string | null;
  causedByLines: number[];
}
export interface IdentityConflict {
  line: number;
  ref: string;
  reason:
    | "attribute_differs"
    | "model_code_changed"
    | "model_code_removed"
    | "model_code_already_assigned"
    | "duplicate_source_scope";
  attribute: string | null;
}
export type ReportStatus = "applicable" | "no_changes" | "not_applicable" | "already_applied";
export interface MobileImportCounts {
  inserted: number;
  inserted_quarantined: number;
  inserted_superseded: number;
  sighting_added: number;
  unchanged: number;
  model_code_resolved: number;
  rejected: number;
  blocked: number;
  existing_quarantined: number;
  existing_superseded: number;
}
export interface MobileImportReport {
  contract: typeof MOBILE_STAGING_CONTRACT;
  status: ReportStatus;
  inputSha256: string;
  planSha256: string | null;
  header: HeaderOutcome;
  records: number;
  outcomes: LineOutcome[];
  existingRowEffects: ExistingRowEffect[];
  identityConflicts: IdentityConflict[];
  counts: MobileImportCounts;
  hosts: string[];
  alreadyAppliedBatchId: string | null;
}
export interface MobileApplyResult {
  status: "applied" | "already_applied" | "no_changes";
  batchId: string | null;
  counts: MobileImportCounts;
  existingBatch: { batchId: string; appliedAt: string; counts: MobileImportCounts } | null;
}
type InputRecord = Record<string, unknown>;
type ParsedLine =
  | { line: number; ok: true; recordType: MobileRecordType | null; record: InputRecord }
  | { line: number; ok: false; reason: string };
type Table = (typeof MOBILE_STAGING_TABLES)[number];
type Row = Record<string, string | number | null>;
type Entry = {
  parsed: ParsedLine;
  raw: InputRecord;
  outcome: LineOutcome;
  table?: Table;
  row?: Row;
  key?: string[];
  declaration?: string;
  sourceUrl?: string;
};
type Write = { table: Table; action: "insert" | "update"; row: Row; key: Row };
const types: MobileRecordType[] = [
  "header",
  "source",
  "family",
  "reference",
  "variant",
  "observation",
  "listing",
];
const own = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v: unknown): v is string => typeof v === "string";
const object = (v: unknown): v is InputRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sorted = (s: string[]) => [...new Set(s)].sort();
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function compareKeys(a: Row, b: Row): number {
  const left = Object.values(a),
    right = Object.values(b);
  for (let i = 0; i < left.length; i++) {
    const order = compareText(String(left[i]), String(right[i]));
    if (order) return order;
  }
  return 0;
}
const sourceKey = (url: string) => "src-" + sha256Hex(url).slice(0, 16);
const zero = (): MobileImportCounts => ({
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
});
const primaryKeys: Record<Table, string[]> = {
  mobile_import_batches: ["batch_id"],
  mobile_sources: ["source_key"],
  mobile_device_families: ["family_key"],
  mobile_hardware_references: ["reference_key"],
  mobile_device_variants: ["variant_key"],
  mobile_variant_sightings: ["variant_key", "source_key", "observed_on"],
  mobile_observations: ["observation_key"],
  mobile_listing_observations: ["listing_key"],
};
export function mobileReportRef(table: Table, keyParts: readonly string[]): string {
  return sha256Hex(
    canonicalJson({
      contract: MOBILE_STAGING_CONTRACT,
      purpose: "report_ref",
      table,
      key: keyParts,
    }),
  );
}
export function parseMobileStagingJsonl(bytes: Buffer): ParsedLine[] {
  if (bytes.length > MOBILE_IMPORT_LIMITS.maxBytes) throw new MobileImportError("input_too_large");
  if (!bytes.length) return [];
  const segments: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 10) {
      segments.push(bytes.subarray(start, i));
      start = i + 1;
    }
  if (start < bytes.length) segments.push(bytes.subarray(start));
  if (segments.length - 1 > MOBILE_IMPORT_LIMITS.maxRecords)
    throw new MobileImportError("input_too_large");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return segments.map((segment, i): ParsedLine => {
    if (segment.at(-1) === 13) segment = segment.subarray(0, -1);
    const bad = (reason: string): ParsedLine => ({ line: i + 1, ok: false, reason });
    if (!segment.length) return bad("blank_line");
    if (segment.length > MOBILE_IMPORT_LIMITS.maxLineBytes) return bad("line_too_long");
    if (segment[0] === 239 && segment[1] === 187 && segment[2] === 191)
      return bad("bom_not_allowed");
    let text: string;
    try {
      text = decoder.decode(segment);
    } catch {
      return bad("invalid_utf8");
    }
    if (text.startsWith("\uFEFF")) return bad("bom_not_allowed");
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      return bad("malformed_json");
    }
    if (!object(record)) return bad("malformed_json");
    return {
      line: i + 1,
      ok: true,
      recordType: types.includes(record.record_type as MobileRecordType)
        ? (record.record_type as MobileRecordType)
        : null,
      record,
    };
  });
}

const properties: Record<MobileRecordType, [string[], string[]]> = {
  header: [["contract", "prepared_on", "prepared_by"], ["research_package_sha256"]],
  source: [["ref", "url", "publisher", "market", "access_method", "raw_page_stored"], []],
  family: [
    [
      "family_key",
      "manufacturer",
      "device_class",
      "os_family",
      "marketing_name",
      "basis_source_ref",
    ],
    ["research_ref"],
  ],
  reference: [
    [
      "reference_key",
      "family_key",
      "reference_label",
      "connectivity",
      "model_code",
      "scope_market",
      "model_code_source_ref",
      "model_code_observed_on",
      "basis_source_ref",
    ],
    ["research_ref"],
  ],
  variant: [
    ["reference_key", "ram_gb", "storage_gb", "retail_sku_code", "basis_source_ref", "observed_on"],
    [],
  ],
  observation: [
    [
      "subject_level",
      "subject_key",
      "field",
      "value_state",
      "value",
      "unit",
      "market",
      "scope_qualifier",
      "source_ref",
      "observed_on",
      "source_updated_at",
    ],
    ["is_exhaustive", "declared_quarantine"],
  ],
  listing: [
    [
      "reference_key",
      "store",
      "store_country",
      "store_app_id",
      "game_title",
      "evidence_kind",
      "match_basis",
      "listed_name",
      "required_os",
      "source_ref",
      "observed_on",
    ],
    [],
  ],
};
function validUrl(v: unknown): v is string {
  if (!str(v) || v.length > 500 || !v.startsWith("https://")) return false;
  try {
    return new URL(v).protocol === "https:" && !!new URL(v).hostname;
  } catch {
    return false;
  }
}
const market = (v: unknown) => str(v) && /^(?:GLOBAL|UNSPECIFIED|[A-Z]{2})$/.test(v);
const familyKey = (v: unknown) =>
  str(v) && v.length <= 80 && /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(v);
const refKey = (v: unknown) => str(v) && v.length <= 120 && /^[a-z0-9:-]+$/.test(v);
const alias = (v: unknown) => str(v) && /^[A-Za-z0-9_-]{1,40}$/.test(v);
function validDate(v: unknown): v is string {
  if (!str(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0, 4)) < 2000) return false;
  const d = new Date(v + "T00:00:00.000Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function validate(raw: InputRecord, type: MobileRecordType, now: Date): string[] {
  const reasons: string[] = [];
  const check = (ok: boolean, code = "invalid_value") => {
    if (!ok) reasons.push(code);
  };
  const [required, optional] = properties[type];
  for (const p of required) check(own(raw, p), "missing_property");
  for (const p of Object.keys(raw))
    check(
      p === "record_type" || required.includes(p) || optional.includes(p),
      "unexpected_property",
    );
  const has = (p: string, fn: (v: unknown) => void) => {
    if (own(raw, p)) fn(raw[p]);
  };
  const text = (p: string, max: number, nullable = false) =>
    has(p, (v) => {
      if (nullable && v === null) return;
      check(str(v) && v.length > 0 && !/[\0\r\n]/.test(v));
      if (str(v) && v.length > max) reasons.push("text_too_long");
    });
  const date = (p: string, nullable = false) =>
    has(p, (v) => {
      if (nullable && v === null) return;
      check(validDate(v), "invalid_date");
      if (validDate(v)) check(v <= now.toISOString().slice(0, 10), "observed_in_future");
    });
  if (own(raw, "research_ref")) text("research_ref", 40, true);
  for (const p of ["basis_source_ref", "source_ref"]) has(p, (v) => check(alias(v)));
  if (type === "header") {
    has("contract", (v) => check(v === MOBILE_STAGING_CONTRACT, "contract_mismatch"));
    text("prepared_by", 60);
    date("prepared_on");
    has("research_package_sha256", (v) => check(str(v) && /^[0-9a-f]{64}$/.test(v)));
  }
  if (type === "source") {
    has("ref", (v) => check(alias(v)));
    has("url", (v) => check(validUrl(v)));
    has("publisher", (v) =>
      check(
        MOBILE_SOURCE_PUBLISHERS.includes(v as (typeof MOBILE_SOURCE_PUBLISHERS)[number]),
        "publisher_not_in_contract",
      ),
    );
    has("market", (v) => check(market(v)));
    has("access_method", (v) => check(v === "manual_read"));
    has("raw_page_stored", (v) => check(v === false, "raw_page_stored"));
  }
  if (type === "family") {
    has("family_key", (v) => check(familyKey(v), "invalid_key"));
    has("manufacturer", (v) =>
      check(
        MOBILE_MANUFACTURERS.includes(v as (typeof MOBILE_MANUFACTURERS)[number]),
        "manufacturer_not_in_contract",
      ),
    );
    has("device_class", (v) => check(v === "Phone" || v === "Tablet"));
    has("os_family", (v) => check(["ios", "ipados", "android"].includes(v as string)));
    text("marketing_name", 80);
    if (own(raw, "manufacturer") && own(raw, "os_family") && own(raw, "device_class")) {
      check(
        (raw.manufacturer === "Apple") === ["ios", "ipados"].includes(raw.os_family as string) &&
          (raw.os_family !== "ios" || raw.device_class === "Phone") &&
          (raw.os_family !== "ipados" || raw.device_class === "Tablet"),
        "os_family_mismatch",
      );
    }
  }
  if (type === "reference") {
    has("family_key", (v) => check(familyKey(v), "invalid_key"));
    has("reference_key", (v) => check(refKey(v), "invalid_key"));
    text("reference_label", 80);
    has("connectivity", (v) =>
      check(
        ["wifi", "wifi_cellular", "cellular_4g", "cellular_5g", "unknown"].includes(v as string),
      ),
    );
    has("model_code", (v) => check(v === null || (str(v) && /^[A-Za-z0-9-]{2,24}$/.test(v))));
    has("scope_market", (v) => check(v === null || market(v)));
    if (own(raw, "model_code") && own(raw, "scope_market"))
      check((raw.model_code === null) === (raw.scope_market !== null), "scope_market_mismatch");
    has("model_code_source_ref", (v) => check(raw.model_code === null ? v === null : alias(v)));
    if (raw.model_code === null) has("model_code_observed_on", (v) => check(v === null));
    else date("model_code_observed_on");
  }
  if (type === "variant") {
    has("reference_key", (v) => check(refKey(v), "invalid_key"));
    date("observed_on");
    for (const [p, max] of [
      ["ram_gb", 64],
      ["storage_gb", 8192],
    ] as const)
      has(p, (v) =>
        check(v === null || (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max)),
      );
    has("retail_sku_code", (v) => check(v === null || (str(v) && /^[A-Za-z0-9/-]{2,32}$/.test(v))));
    if (["ram_gb", "storage_gb", "retail_sku_code"].every((p) => own(raw, p)))
      check([raw.ram_gb, raw.storage_gb, raw.retail_sku_code].some((v) => v !== null));
  }
  if (type === "observation") {
    has("subject_level", (v) =>
      check(v === "family" || v === "reference", "subject_level_not_allowed"),
    );
    has("subject_key", (v) =>
      check(raw.subject_level === "family" ? familyKey(v) : refKey(v), "invalid_key"),
    );
    has("market", (v) => check(market(v)));
    date("observed_on");
    date("source_updated_at", true);
    if (validDate(raw.source_updated_at) && validDate(raw.observed_on))
      check(raw.source_updated_at <= raw.observed_on, "invalid_date");
    has("value_state", (v) => check(v === "stated" || v === "not_stated_by_source"));
    has("scope_qualifier", (v) =>
      check(["none", "market_dependent", "enterprise_edition_only"].includes(v as string)),
    );
    has("declared_quarantine", (v) =>
      check(
        ["regional_assignment_unresolved", "research_declared_unresolved"].includes(v as string),
      ),
    );
    const spec = own(MOBILE_OBSERVATION_FIELDS, raw.field as string)
      ? MOBILE_OBSERVATION_FIELDS[raw.field as MobileField]
      : null;
    has("field", () => check(!!spec, "field_not_in_contract"));
    if (spec) {
      has("unit", (v) => check(v === spec.unit, "unit_mismatch"));
      if (spec.value === "list") {
        check(own(raw, "is_exhaustive"), "missing_property");
        has("is_exhaustive", (v) =>
          check(raw.value_state === "not_stated_by_source" ? v === null : v === 0 || v === 1),
        );
      } else has("is_exhaustive", (v) => check(v === null));
      if (raw.value_state === "not_stated_by_source") has("value", (v) => check(v === null));
      else if (raw.value_state === "stated")
        has("value", (v) => {
          if (spec.value === "text") {
            const max = raw.field === "soc_name" ? 60 : 80;
            check(str(v) && v.trim().length > 0 && !/[\0\r\n]/.test(v));
            if (str(v) && v.length > max) reasons.push("text_too_long");
            if (raw.field === "latest_major_os_eligible")
              check(str(v) && /^(iOS|iPadOS|Android) [1-9][0-9]?$/.test(v));
            if (raw.field === "security_update_cadence")
              check(["monthly", "quarterly", "biannual"].includes(v as string));
          } else if (spec.value === "list") {
            if (Array.isArray(v) && v.length === 0) reasons.push("empty_list_use_not_stated");
            check(
              Array.isArray(v) &&
                (raw.field === "display_resolution_px"
                  ? v.length === 2
                  : v.length >= 1 && v.length <= 8) &&
                v.every(
                  (n) =>
                    typeof n === "number" &&
                    Number.isInteger(n) &&
                    n >= spec.min! &&
                    n <= spec.max!,
                ),
            );
          } else {
            check(
              typeof v === "number" &&
                Number.isFinite(v) &&
                v >= spec.min! &&
                v <= spec.max! &&
                (spec.value === "integer"
                  ? Number.isInteger(v)
                  : Math.abs(v * 100 - Math.round(v * 100)) < 1e-8),
            );
          }
        });
    }
  }
  if (type === "listing") {
    has("reference_key", (v) => check(refKey(v), "invalid_key"));
    has("store", (v) =>
      check(MOBILE_STORES.includes(v as (typeof MOBILE_STORES)[number]), "store_not_in_contract"),
    );
    has("store_country", (v) => check(str(v) && /^[A-Z]{2}$/.test(v)));
    has("store_app_id", (v) => check(str(v) && /^[A-Za-z0-9._]{1,160}$/.test(v)));
    text("game_title", 80);
    text("listed_name", 80, true);
    text("required_os", 24, true);
    has("evidence_kind", (v) => check(v === "publisher_listed", "evidence_kind_not_in_contract"));
    has("match_basis", (v) => check(v === "publisher_device_name"));
    date("observed_on");
  }
  return sorted(reasons);
}

function checkTables(db: Database) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  if (MOBILE_STAGING_TABLES.some((t) => !has.get(t))) throw new MobileImportError("tables_missing");
}
function rows(db: Database, table: Table): Row[] {
  // Identifiers come exclusively from the closed module table list.
  return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
}
function planInternal(
  db: Database,
  bytes: Buffer,
  now: Date,
): { report: MobileImportReport; writePlan: Write[] | null } {
  checkTables(db);
  const parsed = parseMobileStagingJsonl(bytes);
  const inputSha256 = sha256Hex(bytes);
  const first = parsed[0];
  const headerReasons = !first
    ? ["header_missing"]
    : !first.ok
      ? [first.reason]
      : first.recordType !== "header"
        ? ["header_missing"]
        : validate(first.record, "header", now);
  const report: MobileImportReport = {
    contract: MOBILE_STAGING_CONTRACT,
    status: "not_applicable",
    inputSha256,
    planSha256: null,
    header: {
      line: first ? 1 : null,
      status: headerReasons.length ? "rejected" : "accepted",
      reasons: headerReasons,
    },
    records: Math.max(0, parsed.length - 1),
    outcomes: [],
    existingRowEffects: [],
    identityConflicts: [],
    counts: zero(),
    hosts: [],
    alreadyAppliedBatchId: null,
  };
  const entries: Entry[] = parsed.slice(1).map((p) => {
    const type = p.ok ? p.recordType : null;
    const reasons = !p.ok
      ? [p.reason]
      : type === "header"
        ? ["header_duplicate"]
        : !type
          ? ["unknown_record_type"]
          : validate(p.record, type, now);
    const outcome: LineOutcome = {
      line: p.line,
      recordType: type,
      status: reasons.length ? "rejected" : "blocked",
      ref: null,
      reasons,
    };
    report.outcomes.push(outcome);
    return { parsed: p, raw: p.ok ? p.record : {}, outcome };
  });
  const reject = (e: Entry, code: string) => {
    e.outcome.reasons.push(code);
    e.outcome.status = "rejected";
  };
  const conflict = (
    e: Entry,
    reason: IdentityConflict["reason"],
    attribute: string | null = null,
  ) => {
    reject(e, reason);
    if (
      e.outcome.ref &&
      !report.identityConflicts.some(
        (c) => c.line === e.outcome.line && c.reason === reason && c.attribute === attribute,
      )
    )
      report.identityConflicts.push({
        line: e.outcome.line,
        ref: e.outcome.ref,
        reason,
        attribute,
      });
  };
  const aliases = new Map<string, unknown[]>();
  for (const e of entries)
    if (e.outcome.recordType === "source") {
      if (validUrl(e.raw.url)) report.hosts.push(new URL(e.raw.url).hostname.toLowerCase());
      if (alias(e.raw.ref))
        aliases.set(e.raw.ref as string, [...(aliases.get(e.raw.ref as string) ?? []), e.raw.url]);
    }
  const resolve = (e: Entry, name: string): string | undefined => {
    const v = e.raw[name];
    if (!alias(v)) return;
    const definitions = aliases.get(v as string);
    if (!definitions) {
      reject(e, "unknown_source_ref");
      return;
    }
    if (new Set(definitions).size > 1) {
      reject(e, "source_ref_ambiguous");
      return;
    }
    return validUrl(definitions[0]) ? definitions[0] : undefined;
  };
  const stored = Object.fromEntries(MOBILE_STAGING_TABLES.map((t) => [t, rows(db, t)])) as Record<
    Table,
    Row[]
  >;
  const storedBy = (table: Table, column: string, value: unknown) =>
    stored[table].find((r) => r[column] === value);
  const inputFamily = (key: unknown) =>
    entries.find(
      (e) =>
        e.outcome.recordType === "family" &&
        familyKey(e.raw.family_key) &&
        e.raw.family_key === key,
    )?.raw;
  const getFamily = (key: unknown) =>
    inputFamily(key) ?? storedBy("mobile_device_families", "family_key", key);
  const inputReference = (key: unknown) =>
    entries.find(
      (e) =>
        e.outcome.recordType === "reference" &&
        refKey(e.raw.reference_key) &&
        e.raw.reference_key === key,
    )?.raw;
  const getReference = (key: unknown) =>
    inputReference(key) ?? storedBy("mobile_hardware_references", "reference_key", key);
  for (const e of entries) {
    const r = e.raw,
      t = e.outcome.recordType;
    if (!t || t === "header") continue;
    const keyRecord = { ...r };
    if (t === "observation") delete keyRecord.declared_quarantine;
    const validDerivedKeyInputs = !validate(keyRecord, t, now).some(
      (code) => code !== "unexpected_property",
    );
    if (t === "source") {
      if (alias(r.ref) && new Set(aliases.get(r.ref as string)).size > 1)
        reject(e, "source_ref_ambiguous");
      if (validUrl(r.url)) {
        e.table = "mobile_sources";
        e.key = [sourceKey(r.url)];
        e.row = {
          source_key: e.key[0],
          url: r.url,
          publisher: r.publisher as string,
          market: r.market as string,
          access_method: r.access_method as string,
          raw_page_stored: r.raw_page_stored === false ? 0 : 1,
        };
      }
    } else {
      const sourceProperty = ["family", "reference", "variant"].includes(t)
        ? "basis_source_ref"
        : "source_ref";
      const url = resolve(e, sourceProperty);
      e.sourceUrl = url;
      const sk = url ? sourceKey(url) : undefined;
      if (t === "family" && familyKey(r.family_key)) {
        e.table = "mobile_device_families";
        e.key = [r.family_key as string];
        e.row = {
          family_key: r.family_key as string,
          manufacturer: r.manufacturer as string,
          device_class: r.device_class as string,
          os_family: r.os_family as string,
          marketing_name: r.marketing_name as string,
          basis_source_key: sk!,
          research_ref: (r.research_ref as string) ?? null,
        };
      }
      if (t === "reference") {
        const family = getFamily(r.family_key);
        if (familyKey(r.family_key) && !family) reject(e, "unknown_family_key");
        const modelUrl = r.model_code !== null ? resolve(e, "model_code_source_ref") : undefined;
        if (refKey(r.reference_key)) {
          e.table = "mobile_hardware_references";
          e.key = [r.reference_key as string];
          if (
            familyKey(r.family_key) &&
            (!(r.reference_key as string).startsWith(r.family_key + ":") ||
              (r.reference_key as string).length <= String(r.family_key).length + 1)
          )
            reject(e, "invalid_key");
          e.row = {
            reference_key: r.reference_key as string,
            family_key: r.family_key as string,
            manufacturer: family?.manufacturer as string,
            reference_label: r.reference_label as string,
            scope_market: r.scope_market as string | null,
            connectivity: r.connectivity as string,
            model_code: r.model_code as string | null,
            model_code_source_key: modelUrl ? sourceKey(modelUrl) : null,
            model_code_observed_on: r.model_code_observed_on as string | null,
            basis_source_key: sk!,
            research_ref: (r.research_ref as string) ?? null,
          };
        }
      }
      if (
        ["variant", "listing"].includes(t) &&
        refKey(r.reference_key) &&
        !getReference(r.reference_key)
      )
        reject(e, "unknown_reference_key");
      if (
        t === "variant" &&
        validDerivedKeyInputs &&
        sk &&
        refKey(r.reference_key) &&
        ["ram_gb", "storage_gb", "retail_sku_code", "observed_on"].every((p) => own(r, p))
      ) {
        const vk = `${r.reference_key}#ram=${r.ram_gb ?? "x"}#st=${r.storage_gb ?? "x"}#sku=${r.retail_sku_code ?? "x"}`;
        e.table = "mobile_variant_sightings";
        e.key = [vk, sk, r.observed_on as string];
        e.row = { variant_key: vk, source_key: sk, observed_on: r.observed_on as string };
      }
      if (t === "observation") {
        const subject =
          r.subject_level === "family" ? getFamily(r.subject_key) : getReference(r.subject_key);
        if (
          (r.subject_level === "family" ? familyKey(r.subject_key) : refKey(r.subject_key)) &&
          !subject
        )
          reject(e, r.subject_level === "family" ? "unknown_family_key" : "unknown_reference_key");
        let value = r.value;
        if (r.field === "soc_name" && str(value)) value = value.trim().replace(/\s+/g, " ");
        if (Array.isArray(value) && value.every((v) => typeof v === "number"))
          value =
            r.field === "display_resolution_px"
              ? [...value].sort((a, b) => b - a)
              : [...new Set(value)].sort((a, b) => a - b);
        if (r.field === "latest_major_os_eligible" && str(value) && subject) {
          const family = r.subject_level === "family" ? subject : getFamily(subject.family_key);
          const prefix =
            family?.os_family === "ios"
              ? "iOS"
              : family?.os_family === "ipados"
                ? "iPadOS"
                : "Android";
          if (!value.startsWith(prefix + " ")) reject(e, "os_family_mismatch");
          // Use the existing taxonomy rather than introduce another platform vocabulary.
          if (normalizePlatform(prefix === "iPadOS" ? "iPad" : prefix) === null)
            reject(e, "os_family_mismatch");
        }
        const keyProperties = [
          "subject_level",
          "subject_key",
          "field",
          "value_state",
          "value",
          "unit",
          "market",
          "scope_qualifier",
          "observed_on",
          "source_updated_at",
        ];
        if (
          url &&
          validDerivedKeyInputs &&
          keyProperties.every((p) => own(r, p)) &&
          !e.outcome.reasons.includes("os_family_mismatch")
        ) {
          const content = Object.fromEntries(
            keyProperties.map((p) => [p, p === "value" ? value : r[p]]),
          );
          const key = sha256Hex(
            canonicalJson({
              contract: MOBILE_STAGING_CONTRACT,
              ...content,
              is_exhaustive: r.is_exhaustive ?? null,
              source_url: url,
            }),
          );
          e.table = "mobile_observations";
          e.key = [key];
          e.declaration = r.declared_quarantine as string | undefined;
          e.row = {
            observation_key: key,
            subject_level: r.subject_level as string,
            family_key: r.subject_level === "family" ? (r.subject_key as string) : null,
            reference_key: r.subject_level === "reference" ? (r.subject_key as string) : null,
            field: r.field as string,
            value_state: r.value_state as string,
            value_text: str(value) ? value : null,
            value_number: typeof value === "number" ? value : null,
            value_json: Array.isArray(value) ? canonicalJson(value) : null,
            unit: r.unit as string | null,
            is_exhaustive: (r.is_exhaustive as number) ?? null,
            market: r.market as string,
            scope_qualifier: r.scope_qualifier as string,
            source_key: sk!,
            observed_on: r.observed_on as string,
            source_updated_at: r.source_updated_at as string | null,
            review_state: "accepted",
            quarantine_reason: null,
            quarantine_origin: null,
            quarantined_batch_id: null,
            superseded_by: null,
          };
        }
      }
      if (
        t === "listing" &&
        validDerivedKeyInputs &&
        url &&
        properties.listing[0].every((p) => own(r, p))
      ) {
        const content = Object.fromEntries(
          properties.listing[0].filter((p) => p !== "source_ref").map((p) => [p, r[p]]),
        );
        const key = sha256Hex(
          canonicalJson({ contract: MOBILE_STAGING_CONTRACT, ...content, source_url: url }),
        );
        e.table = "mobile_listing_observations";
        e.key = [key];
        e.row = { listing_key: key, ...content, source_key: sk! } as Row;
      }
    }
    if (e.outcome.reasons.includes("invalid_key")) e.key = undefined;
    if (e.table && e.key) e.outcome.ref = mobileReportRef(e.table, e.key);
  }
  const compared: Partial<Record<Table, string[]>> = {
    mobile_sources: ["url", "publisher", "market", "access_method", "raw_page_stored"],
    mobile_device_families: [
      "manufacturer",
      "device_class",
      "os_family",
      "marketing_name",
      "research_ref",
    ],
    mobile_hardware_references: [
      "family_key",
      "manufacturer",
      "reference_label",
      "connectivity",
      "research_ref",
    ],
  };
  const validComparedColumn = (column: string, value: unknown): boolean => {
    const text = (max: number) =>
      str(value) && value.length >= 1 && value.length <= max && !/[\0\r\n]/.test(value);
    switch (column) {
      case "url":
        return validUrl(value);
      case "publisher":
        return MOBILE_SOURCE_PUBLISHERS.includes(
          value as (typeof MOBILE_SOURCE_PUBLISHERS)[number],
        );
      case "manufacturer":
        return MOBILE_MANUFACTURERS.includes(value as (typeof MOBILE_MANUFACTURERS)[number]);
      case "market":
        return market(value);
      case "access_method":
        return value === "manual_read";
      case "raw_page_stored":
        return value === 0;
      case "device_class":
        return value === "Phone" || value === "Tablet";
      case "os_family":
        return value === "ios" || value === "ipados" || value === "android";
      case "marketing_name":
      case "reference_label":
        return text(80);
      case "research_ref":
        return value === null || text(40);
      case "family_key":
        return familyKey(value);
      case "connectivity":
        return ["wifi", "wifi_cellular", "cellular_4g", "cellular_5g", "unknown"].includes(
          value as string,
        );
      case "model_code":
        return value === null || (str(value) && /^[A-Za-z0-9-]{2,24}$/.test(value));
      case "scope_market":
        return value === null || market(value);
      default:
        return false;
    }
  };
  const compareIdentity = (e: Entry, other: Row, withinFile = false) => {
    const r = e.row!;
    for (const column of compared[e.table!] ?? [])
      if (
        validComparedColumn(column, r[column]) &&
        (!withinFile || validComparedColumn(column, other[column])) &&
        !(column === "research_ref" && (r[column] == null || other[column] == null)) &&
        !equal(r[column], other[column])
      )
        conflict(e, "attribute_differs", column);
    if (e.table === "mobile_hardware_references") {
      if (withinFile) {
        for (const column of ["model_code", "scope_market"])
          if (
            validComparedColumn(column, r[column]) &&
            validComparedColumn(column, other[column]) &&
            !equal(r[column], other[column])
          )
            conflict(e, "attribute_differs", column);
        return;
      }
      if (!validComparedColumn("model_code", r.model_code)) return;
      if (other.model_code !== null && r.model_code === null) conflict(e, "model_code_removed");
      else if (other.model_code !== null && r.model_code !== other.model_code)
        conflict(e, "model_code_changed");
      else if (
        other.model_code === null &&
        r.model_code === null &&
        r.scope_market !== other.scope_market
      )
        conflict(e, "attribute_differs", "scope_market");
    }
  };
  const keyed = entries.filter((e) => e.table && e.key && e.row);
  const groups = new Map<string, Entry[]>();
  for (const e of keyed) {
    const key = canonicalJson([e.table, e.key]);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const t = group[0].table!;
    if (t === "mobile_sources" && new Set(group.map((e) => e.raw.url)).size > 1) {
      group.forEach((e) => reject(e, "invalid_key"));
      continue;
    }
    if (compared[t]) {
      const before = report.identityConflicts.length;
      for (const e of group)
        for (const other of group) if (e !== other) compareIdentity(e, other.row!, true);
      if (report.identityConflicts.length === before) {
        const columns = [
          ...compared[t]!,
          ...(t === "mobile_hardware_references" ? ["model_code", "scope_market"] : []),
        ];
        const validContent = group.filter((e) =>
          columns.every((column) => validComparedColumn(column, e.row![column])),
        );
        if (validContent.length >= 2) validContent.forEach((e) => reject(e, "duplicate_record"));
      }
    } else group.forEach((e) => reject(e, "duplicate_record"));
  }
  const listingSlot = (r: Row) =>
    canonicalJson([
      r.reference_key,
      r.store,
      r.store_country,
      r.store_app_id,
      r.source_key,
      r.observed_on,
    ]);
  for (const e of keyed) {
    const r = e.row!,
      table = e.table!;
    const existing = stored[table].find((s) => primaryKeys[table].every((p) => s[p] === r[p]));
    if (existing && compared[table]) compareIdentity(e, existing);
    if (table === "mobile_hardware_references") {
      for (const other of [
        ...stored[table],
        ...keyed.filter((x) => x.table === table && x !== e).map((x) => x.row!),
      ]) {
        if (other.reference_key === r.reference_key) continue;
        if (
          r.model_code !== null &&
          r.model_code === other.model_code &&
          r.manufacturer === other.manufacturer
        )
          conflict(e, "model_code_already_assigned");
        if (
          r.model_code === null &&
          other.model_code === null &&
          r.family_key === other.family_key &&
          r.scope_market === other.scope_market &&
          r.connectivity === other.connectivity
        )
          conflict(e, "duplicate_source_scope");
      }
    }
    if (table === "mobile_listing_observations") {
      const same = keyed.filter((x) => x.table === table && listingSlot(x.row!) === listingSlot(r));
      if (new Set(same.map((x) => x.row!.listing_key)).size > 1)
        same.forEach((x) => reject(x, "listing_attribute_conflict"));
      if (
        same.length === 1 &&
        stored[table].some(
          (s) => listingSlot(s) === listingSlot(r) && s.listing_key !== r.listing_key,
        )
      )
        reject(e, "listing_attribute_conflict");
    }
    if (table === "mobile_observations" && !existing) {
      if (
        stored[table].some(
          (s) => lane(s) === lane(r) && String(s.observed_on) > String(r.observed_on),
        )
      )
        reject(e, "stale_same_source_observation");
    }
  }
  const batch = stored.mobile_import_batches.find((r) => r.input_sha256 === inputSha256);
  report.alreadyAppliedBatchId = (batch?.batch_id as string) ?? null;
  const finish = (writePlan: Write[] | null) => {
    for (const e of entries) {
      e.outcome.reasons = sorted(e.outcome.reasons);
      report.counts[e.outcome.status]++;
    }
    report.hosts = sorted(report.hosts);
    report.identityConflicts.sort(
      (a, b) =>
        a.line - b.line ||
        compareText(a.reason, b.reason) ||
        compareText(a.attribute ?? "", b.attribute ?? ""),
    );
    report.existingRowEffects.sort((a, b) => compareText(a.ref, b.ref));
    report.status = batch
      ? "already_applied"
      : writePlan === null
        ? "not_applicable"
        : writePlan.length
          ? "applicable"
          : "no_changes";
    if (writePlan !== null)
      report.planSha256 = sha256Hex(
        canonicalJson({ contract: MOBILE_STAGING_CONTRACT, inputSha256, writePlan }),
      );
    return { report, writePlan };
  };
  if (headerReasons.length || entries.some((e) => e.outcome.status === "rejected"))
    return finish(null);
  const writePlan: Write[] = [];
  const add = (table: Table, action: Write["action"], row: Row) =>
    writePlan.push({
      table,
      action,
      row,
      key: Object.fromEntries(primaryKeys[table].map((k) => [k, row[k]])),
    });
  for (const e of keyed) {
    const r = e.row!,
      table = e.table!;
    const existing = stored[table].find((s) => primaryKeys[table].every((k) => s[k] === r[k]));
    e.outcome.status = existing ? "unchanged" : "inserted";
    if (table === "mobile_observations" || table === "mobile_variant_sightings") continue;
    if (existing) {
      if (
        ["mobile_device_families", "mobile_hardware_references"].includes(table) &&
        existing.basis_source_key !== r.basis_source_key
      )
        e.outcome.reasons.push("basis_source_not_recorded");
      if (table === "mobile_hardware_references") {
        if (existing.model_code === null && r.model_code !== null) {
          e.outcome.status = "model_code_resolved";
          add(table, "update", {
            reference_key: r.reference_key,
            model_code: r.model_code,
            scope_market: null,
            model_code_source_key: r.model_code_source_key,
            model_code_observed_on: r.model_code_observed_on,
            model_code_batch_id: "@batch",
          });
        } else if (
          r.model_code !== null &&
          (existing.model_code_source_key !== r.model_code_source_key ||
            existing.model_code_observed_on !== r.model_code_observed_on)
        )
          e.outcome.reasons.push("model_code_provenance_not_recorded");
      }
    } else {
      add(table, "insert", {
        ...r,
        ...(table === "mobile_listing_observations"
          ? { batch_id: "@batch" }
          : { first_batch_id: "@batch" }),
        ...(table === "mobile_hardware_references"
          ? { model_code_batch_id: r.model_code === null ? null : "@batch" }
          : {}),
      });
    }
  }
  const variants = new Map<string, Entry[]>();
  for (const e of keyed.filter((e) => e.table === "mobile_variant_sightings"))
    variants.set(e.key![0], [...(variants.get(e.key![0]) ?? []), e]);
  for (const [vk, group] of variants) {
    group.sort(
      (a, b) =>
        compareText(String(a.row!.observed_on), String(b.row!.observed_on)) ||
        compareText(String(a.row!.source_key), String(b.row!.source_key)),
    );
    const exists = storedBy("mobile_device_variants", "variant_key", vk);
    for (const [index, e] of group.entries()) {
      const r = e.row!;
      const sighting = stored.mobile_variant_sightings.some((s) =>
        e.key!.every((v, i) => s[primaryKeys.mobile_variant_sightings[i]] === v),
      );
      e.outcome.status = sighting
        ? "unchanged"
        : !exists && index === 0
          ? "inserted"
          : "sighting_added";
      if (!exists && index === 0)
        add("mobile_device_variants", "insert", {
          variant_key: vk,
          reference_key: e.raw.reference_key as string,
          ram_gb: e.raw.ram_gb as number | null,
          storage_gb: e.raw.storage_gb as number | null,
          retail_sku_code: e.raw.retail_sku_code as string | null,
          sku_status:
            e.raw.retail_sku_code === null ? "configuration_observed" : "retail_sku_resolved",
          first_batch_id: "@batch",
        });
      if (!sighting) add("mobile_variant_sightings", "insert", { ...r, batch_id: "@batch" });
    }
  }
  planObservations(
    stored.mobile_observations,
    keyed.filter((e) => e.table === "mobile_observations"),
    getReference,
    report,
    add,
    keyed.filter((e) => e.outcome.status === "model_code_resolved"),
  );
  writePlan.sort((a, b) => {
    if (a.action !== b.action) return a.action === "insert" ? -1 : 1;
    const order = MOBILE_STAGING_TABLES.indexOf(a.table) - MOBILE_STAGING_TABLES.indexOf(b.table);
    if (order) return order;
    if (a.action === "insert" && a.table === "mobile_observations") {
      const dates = compareText(String(b.row.observed_on), String(a.row.observed_on));
      if (dates) return dates;
    }
    return compareKeys(a.key, b.key);
  });
  return finish(writePlan);
}

const observationGroup = (r: Row) =>
  canonicalJson([r.subject_level, r.family_key, r.reference_key, r.field, r.scope_qualifier]);
const lane = (r: Row) => canonicalJson([observationGroup(r), r.source_key, r.market]);
const observationValue = (r: Row) =>
  canonicalJson([r.value_state, r.value_text, r.value_number, r.value_json]);
function planObservations(
  existing: Row[],
  incoming: Entry[],
  getReference: (key: unknown) => InputRecord | Row | undefined,
  report: MobileImportReport,
  add: (t: Table, a: Write["action"], r: Row) => void,
  resolutions: Entry[],
) {
  const current = existing
    .filter((r) => r.review_state !== "superseded")
    .map((row) => ({ ...row }));
  const old = new Map(existing.map((r) => [r.observation_key, r]));
  const byKey = new Map(current.map((r) => [r.observation_key, r]));
  const causes = new Map<string, Set<number>>();
  const reasonSets = new Map<string, Set<string>>();
  for (const e of incoming)
    if (!old.has(e.row!.observation_key)) {
      const row: Row = { ...e.row!, batch_id: "@batch" };
      current.push(row);
      byKey.set(row.observation_key, row);
    }
  const quarantine = (r: Row, reason: string, origin: string, lines: number[]) => {
    const key = r.observation_key as string;
    if (!reasonSets.has(key)) reasonSets.set(key, new Set());
    reasonSets.get(key)!.add(reason);
    if (old.get(key)?.review_state === "quarantined") return;
    if (r.review_state === "superseded") return;
    const rank = (v: unknown) =>
      v === "enterprise_scope_not_retail" ? 0 : v === "source_conflict" || !v ? 2 : 1;
    if (r.review_state !== "quarantined" || rank(reason) < rank(r.quarantine_reason)) {
      r.review_state = "quarantined";
      r.quarantine_reason = reason;
      r.quarantine_origin = origin;
      r.quarantined_batch_id = "@batch";
    }
    const set = causes.get(key) ?? new Set<number>();
    lines.forEach((n) => set.add(n));
    causes.set(key, set);
  };
  for (const e of incoming) {
    const row = byKey.get(e.row!.observation_key);
    if (!row) continue;
    if (row.scope_qualifier === "enterprise_edition_only")
      quarantine(row, "enterprise_scope_not_retail", "importer_rule", [e.outcome.line]);
    if (e.declaration) quarantine(row, e.declaration, "input_declared", [e.outcome.line]);
  }
  const linesFor = (rows: Row[]) =>
    incoming
      .filter((e) => rows.some((r) => r.observation_key === e.row!.observation_key))
      .map((e) => e.outcome.line);
  const lanes = new Map<string, Row[]>();
  for (const r of current) lanes.set(lane(r), [...(lanes.get(lane(r)) ?? []), r]);
  for (const group of lanes.values()) {
    for (const r of group) {
      const sameDay = group.filter((s) => s.observed_on === r.observed_on);
      if (new Set(sameDay.map(observationValue)).size > 1)
        quarantine(r, "source_conflict", "importer_rule", linesFor(sameDay));
    }
    const dates = sorted(group.map((r) => r.observed_on as string));
    for (const r of group)
      if (r.review_state === "accepted" && r.observed_on !== dates.at(-1)) {
        const next = dates[dates.indexOf(r.observed_on as string) + 1];
        const target = group
          .filter((s) => s.observed_on === next)
          .sort((a, b) => compareText(String(a.observation_key), String(b.observation_key)))[0];
        r.review_state = "superseded";
        r.superseded_by = target.observation_key;
        causes.set(r.observation_key as string, new Set(linesFor([target])));
      }
  }
  for (const a of current)
    for (const b of current) {
      if (
        a === b ||
        lane(a) === lane(b) ||
        a.review_state === "superseded" ||
        b.review_state === "superseded" ||
        observationGroup(a) !== observationGroup(b) ||
        a.value_state !== "stated" ||
        b.value_state !== "stated" ||
        observationValue(a) === observationValue(b)
      )
        continue;
      const codeReference =
        a.subject_level === "reference" && getReference(a.reference_key)?.model_code != null;
      const overlaps =
        (MOBILE_OBSERVATION_FIELDS[a.field as MobileField].kind === "hardware" && codeReference) ||
        a.market === b.market ||
        [a.market, b.market].some((m) => m === "GLOBAL" || m === "UNSPECIFIED");
      if (overlaps) {
        const resolving = resolutions
          .filter((e) => e.row!.reference_key === a.reference_key)
          .map((e) => e.outcome.line);
        quarantine(a, "source_conflict", "importer_rule", [...linesFor([b]), ...resolving]);
        quarantine(b, "source_conflict", "importer_rule", [...linesFor([a]), ...resolving]);
      }
    }
  for (const e of incoming) {
    const row = byKey.get(e.row!.observation_key);
    if (old.has(e.row!.observation_key)) e.outcome.status = "unchanged";
    else if (row) {
      e.outcome.status =
        row.review_state === "quarantined"
          ? "inserted_quarantined"
          : row.review_state === "superseded"
            ? "inserted_superseded"
            : "inserted";
      add("mobile_observations", "insert", row);
    }
    if (row?.review_state === "quarantined")
      e.outcome.reasons.push(
        ...(reasonSets.get(row.observation_key as string) ?? [row.quarantine_reason as string]),
      );
  }
  for (const r of current) {
    const before = old.get(r.observation_key);
    if (!before || before.review_state !== "accepted" || r.review_state === "accepted") continue;
    const quarantined = r.review_state === "quarantined";
    report.counts[quarantined ? "existing_quarantined" : "existing_superseded"]++;
    report.existingRowEffects.push({
      table: "mobile_observations",
      ref: mobileReportRef("mobile_observations", [r.observation_key as string]),
      transition: quarantined ? "accepted_to_quarantined" : "accepted_to_superseded",
      reason: r.quarantine_reason as string | null,
      causedByLines: [...(causes.get(r.observation_key as string) ?? [])].sort((a, b) => a - b),
    });
    add("mobile_observations", "update", {
      observation_key: r.observation_key,
      review_state: r.review_state,
      quarantine_reason: r.quarantine_reason,
      quarantine_origin: r.quarantine_origin,
      quarantined_batch_id: r.quarantined_batch_id,
      superseded_by: r.superseded_by,
    });
  }
}

export function planMobileImport(
  db: Database,
  inputBytes: Buffer,
  opts: { now: Date },
): MobileImportReport {
  return planInternal(db, inputBytes, opts.now).report;
}
const batchCounts = (r: Row): MobileImportCounts => ({
  inserted: r.inserted_count as number,
  inserted_quarantined: r.inserted_quarantined_count as number,
  inserted_superseded: r.inserted_superseded_count as number,
  sighting_added: r.sighting_added_count as number,
  unchanged: r.unchanged_count as number,
  model_code_resolved: r.model_code_resolved_count as number,
  rejected: 0,
  blocked: 0,
  existing_quarantined: r.existing_quarantined_count as number,
  existing_superseded: r.existing_superseded_count as number,
});
export function applyMobileImport(
  db: Database,
  inputBytes: Buffer,
  expected: { inputSha256: string; planSha256: string | null },
  opts: { now: Date; batchId?: string },
): MobileApplyResult {
  if (sha256Hex(inputBytes) !== expected.inputSha256) throw new MobileImportError("input_mismatch");
  const batchId = opts.batchId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(batchId))
    throw new TypeError("invalid batch ID");
  checkTables(db);
  return db
    .transaction((): MobileApplyResult => {
      const existing = db
        .prepare("SELECT * FROM mobile_import_batches WHERE input_sha256 = ?")
        .get(expected.inputSha256) as Row | undefined;
      if (existing)
        return {
          status: "already_applied",
          batchId: existing.batch_id as string,
          counts: zero(),
          existingBatch: {
            batchId: existing.batch_id as string,
            appliedAt: existing.applied_at as string,
            counts: batchCounts(existing),
          },
        };
      const { report, writePlan } = planInternal(db, inputBytes, opts.now);
      if (writePlan === null) throw new MobileImportError("plan_not_applicable");
      if (expected.planSha256 === null) throw new MobileImportError("plan_digest_missing");
      if (report.planSha256 !== expected.planSha256) throw new MobileImportError("plan_stale");
      if (!writePlan.length)
        return { status: "no_changes", batchId: null, counts: zero(), existingBatch: null };
      const c = report.counts;
      db.prepare(
        "INSERT INTO mobile_import_batches (batch_id,contract,input_sha256,plan_sha256,input_records,inserted_count,inserted_quarantined_count,inserted_superseded_count,sighting_added_count,unchanged_count,model_code_resolved_count,existing_quarantined_count,existing_superseded_count,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        batchId,
        MOBILE_STAGING_CONTRACT,
        report.inputSha256,
        report.planSha256,
        report.records,
        c.inserted,
        c.inserted_quarantined,
        c.inserted_superseded,
        c.sighting_added,
        c.unchanged,
        c.model_code_resolved,
        c.existing_quarantined,
        c.existing_superseded,
        opts.now.toISOString(),
      );
      for (const w of writePlan) {
        const columns = Object.keys(w.row);
        const values = columns.map((k) =>
          ["batch_id", "first_batch_id", "model_code_batch_id", "quarantined_batch_id"].includes(
            k,
          ) && w.row[k] === "@batch"
            ? batchId
            : w.row[k],
        );
        // Both identifier sets originate in module-owned row builders, never input property names.
        if (w.action === "insert")
          db.prepare(
            `INSERT INTO ${w.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          ).run(...values);
        else
          db.prepare(
            `UPDATE ${w.table} SET ${columns.map((k) => k + " = ?").join(",")} WHERE ${Object.keys(
              w.key,
            )
              .map((k) => k + " = ?")
              .join(" AND ")}`,
          ).run(...values, ...Object.values(w.key));
      }
      return { status: "applied", batchId, counts: c, existingBatch: null };
    })
    .immediate();
}
