import { isIP } from "node:net";
import { canonicalJson, sha256Hex } from "../services/enrichmentPromotion";
import {
  classifyCitation,
  effectivePublish,
  fieldAccess,
  routePermitted,
  sourceEntry,
} from "./sourceAccess";
import type { Publish, SourceRegisterView } from "./sourceAccess";

export const EVIDENCE_CONTRACT = "mgpl-dpx-evidence/1" as const;
export const INITIAL_REGIONS = ["US"] as const;
export const MAINTAINED_OS_PRODUCTS = [
  "windows",
  "macos",
  "ios",
  "ipados",
  "android",
  "steamos",
] as const;
export const OS_PRODUCTS = [
  ...MAINTAINED_OS_PRODUCTS,
  "linux",
  "playstation_system",
  "xbox_system",
  "nintendo_system",
] as const;
export const STORES = [
  "apple_app_store",
  "google_play",
  "steam",
  "playstation_store",
  "microsoft_store",
  "nintendo_eshop",
] as const;
export const HARDWARE_CLASSES = [
  "console",
  "handheld",
  "pc",
  "pc_component",
  "display",
  "peripheral",
  "xr_headset",
  "cable_adapter",
] as const;
export const VALUE_STATES = ["stated", "unknown"] as const;
export const BASES = ["documented", "measured", "derived"] as const;
export const INPUT_UNKNOWN_REASONS = [
  "not_published",
  "not_listed",
  "source_unavailable",
  "subject_ambiguous",
] as const;
export const ASSESSMENT_UNKNOWN_REASONS = [
  ...INPUT_UNKNOWN_REASONS,
  "no_observation",
  "no_permitted_source",
] as const;
export const ASSESSMENT_STATUSES = [
  "current",
  "unknown",
  "conflicting",
  "stale",
  "withdrawn",
] as const;
export const COLLECTIONS = ["manual_read", "bounded_get"] as const;
export const DERIVATION_RULES: Readonly<Record<string, never>> = Object.freeze({});
export const FIELD_CLASSES = {
  label: { ttlDays: 90, country: "any" },
  listing: { ttlDays: 7, country: "listing" },
  requirement: { ttlDays: 30, country: "exact_or_global" },
  compatibility: { ttlDays: 30, country: "exact_or_global" },
  support_policy: { ttlDays: 90, country: "exact_or_global" },
  hardware_spec: { ttlDays: 90, country: "any" },
  measurement: { ttlDays: null, country: "exact_or_global" },
} as const;
export type HardwareClass = (typeof HARDWARE_CLASSES)[number];
export type OsProduct = (typeof OS_PRODUCTS)[number];
export type StoreId = (typeof STORES)[number];
export type Basis = (typeof BASES)[number];
export type Collection = (typeof COLLECTIONS)[number];
export type InputUnknownReason = (typeof INPUT_UNKNOWN_REASONS)[number];
export type AssessmentUnknownReason = (typeof ASSESSMENT_UNKNOWN_REASONS)[number];
export type GameSide =
  | { kind: "game_edition"; edition_key: string }
  | { kind: "game_build"; edition_key: string; platform: OsProduct; version: string | null }
  | { kind: "store_listing"; store: StoreId; store_app_id: string; country: string };
export type DeviceSide =
  | { kind: "mobile_reference"; reference_key: string }
  | { kind: "mobile_variant"; variant_key: string }
  | { kind: "hardware_reference"; hardware_class: HardwareClass; reference_key: string };
export type SubjectRef =
  | GameSide
  | DeviceSide
  | { kind: "mobile_family"; family_key: string }
  | { kind: "hardware_port"; hardware_class: HardwareClass; reference_key: string; port_id: string }
  | { kind: "game_work"; work_key: string }
  | { kind: "os_release"; os_product: OsProduct; release: string }
  | { kind: "pairing"; game: GameSide; device: DeviceSide };
export function subjectKey(subject: SubjectRef): string {
  return canonicalJson(subject);
}
export interface FieldSpec {
  class: keyof typeof FIELD_CLASSES;
  subjects: readonly SubjectRef["kind"][];
  stores?: readonly StoreId[];
  value: "text" | "integer" | "boolean" | "list";
  unit: string | null;
  bases: readonly Basis[];
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  vocabulary?: readonly string[];
  exhaustive?: boolean;
  url?: boolean;
}
const documented = ["documented"] as const;
function spec(
  fieldClass: FieldSpec["class"],
  subject: SubjectRef["kind"],
  value: FieldSpec["value"],
  extra: Partial<FieldSpec> = {},
): FieldSpec {
  return Object.freeze({
    class: fieldClass,
    subjects: [subject],
    value,
    unit: null,
    bases: documented,
    ...extra,
  });
}
const version = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const numericRelease = /^[0-9]+(\.[0-9]+){0,3}$/;
export const FIELD_REGISTRY = Object.freeze({
  edition_title: spec("label", "game_edition", "text", { maxLength: 120 }),
  listing_available: spec("listing", "store_listing", "boolean"),
  listing_version: spec("listing", "store_listing", "text", { pattern: version }),
  listing_minimum_os_version: spec("listing", "store_listing", "text", { pattern: numericRelease }),
  listing_bundle_id: spec("listing", "store_listing", "text", {
    stores: ["apple_app_store"],
    pattern: /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/,
  }),
  listing_supported_device_tokens: spec("listing", "store_listing", "list", {
    stores: ["apple_app_store"],
    max: 200,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    exhaustive: true,
  }),
  listing_store_url: spec("listing", "store_listing", "text", { url: true }),
  requires_os_min_release: spec("requirement", "game_build", "text", { pattern: numericRelease }),
  requires_ram_gb: spec("requirement", "game_build", "integer", { unit: "GB", min: 1, max: 64 }),
  supported_cpu_abis: spec("requirement", "game_build", "list", {
    vocabulary: ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"],
    exhaustive: true,
  }),
  publisher_lists_device: spec("compatibility", "pairing", "boolean", { exhaustive: true }),
  native_edition_support: spec("compatibility", "pairing", "boolean"),
  os_lifecycle_status: spec("support_policy", "os_release", "text", {
    vocabulary: ["supported", "security_updates_only", "end_of_support"],
  }),
  soc_name: spec("hardware_spec", "hardware_reference", "text", { maxLength: 80 }),
  ram_gb: spec("hardware_spec", "hardware_reference", "integer", { unit: "GB", min: 1, max: 64 }),
});
export type EvidenceField = keyof typeof FIELD_REGISTRY;
export type FieldRegistry = Readonly<Record<string, FieldSpec>>;
export const MOBILE_OWNED_FIELDS = [
  "soc_name",
  "gpu_core_count",
  "ram_gb",
  "ram_options_gb",
  "screen_diagonal_in",
  "display_resolution_px",
  "display_refresh_max_hz",
  "latest_major_os_eligible",
  "security_update_cadence",
  "update_policy_years",
] as const;
const forbidden = [
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
];
export type Value = boolean | number | string | string[];
export interface EvidenceObservation {
  contract: typeof EVIDENCE_CONTRACT;
  subject: SubjectRef;
  field: EvidenceField;
  value_state: "stated" | "unknown";
  value: Value | null;
  unit: string | null;
  unknown_reason: InputUnknownReason | null;
  basis: Basis | null;
  list_exhaustive: boolean | null;
  country: string;
  source: { source_id: string; url: string; source_version: string | null };
  collection: Collection;
  observed_at: string;
  source_updated_at: string | null;
  reviewed_on: string | null;
}
export type EvidenceRejectReason =
  | "not_an_object"
  | "contract_mismatch"
  | "missing_property"
  | "unexpected_property"
  | "invalid_subject"
  | "invalid_key"
  | "use_mobile_subject"
  | "field_owned_by_mobile_staging"
  | "field_forbidden"
  | "field_not_in_contract"
  | "subject_kind_not_allowed_for_field"
  | "store_not_allowed_for_field"
  | "value_state_invalid"
  | "unit_mismatch"
  | "value_type_mismatch"
  | "value_out_of_range"
  | "value_not_in_vocabulary"
  | "empty_list_use_unknown"
  | "duplicate_list_item"
  | "text_invalid"
  | "unknown_reason_invalid"
  | "basis_not_in_contract"
  | "basis_not_allowed_for_field"
  | "derivation_rule_unknown"
  | "list_exhaustive_invalid"
  | "negative_requires_exhaustive_list"
  | "invalid_url"
  | "source_version_invalid"
  | "invalid_country"
  | "country_scope_mismatch"
  | "invalid_date"
  | "observed_in_future"
  | "source_updated_after_observed"
  | "review_date_invalid"
  | "source_not_registered"
  | "collection_not_permitted"
  | "field_not_permitted_for_source"
  | "source_origin_mismatch";
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const includes = (values: readonly unknown[], value: unknown): boolean => values.includes(value);
const family = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const reference = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*:[a-z0-9:-]+$/;
const work = /^(wd:Q[1-9][0-9]{0,11}|mgpl:[a-z0-9][a-z0-9-]{0,63})$/;
const edition = /^(wd:Q[1-9][0-9]{0,11}|mgpl:[a-z0-9][a-z0-9-]{0,63})\/[a-z0-9][a-z0-9-]{0,47}$/;
const matches = (value: unknown, pattern: RegExp, max = Infinity): boolean =>
  typeof value === "string" && value.length <= max && pattern.test(value);
function subjectReasons(raw: unknown): EvidenceRejectReason[] {
  if (!object(raw)) return ["invalid_subject"];
  const errors: EvidenceRejectReason[] = [];
  const key = (valid: boolean) => {
    if (!valid) errors.push("invalid_key");
  };
  const shapes: Record<string, string[]> = {
    mobile_family: ["family_key"],
    mobile_reference: ["reference_key"],
    mobile_variant: ["variant_key"],
    hardware_reference: ["hardware_class", "reference_key"],
    hardware_port: ["hardware_class", "reference_key", "port_id"],
    game_work: ["work_key"],
    game_edition: ["edition_key"],
    game_build: ["edition_key", "platform", "version"],
    store_listing: ["store", "store_app_id", "country"],
    os_release: ["os_product", "release"],
    pairing: ["game", "device"],
  };
  const shape =
    typeof raw.kind === "string" && own(shapes, raw.kind) ? shapes[raw.kind] : undefined;
  if (!shape) return ["invalid_subject"];
  if (Object.keys(raw).length !== shape.length + 1 || shape.some((k) => !own(raw, k)))
    errors.push("invalid_subject");
  if (raw.kind === "mobile_family") key(matches(raw.family_key, family, 80));
  if (["mobile_reference", "hardware_reference", "hardware_port"].includes(raw.kind))
    key(matches(raw.reference_key, reference, 120));
  if (raw.kind === "mobile_variant") {
    const match =
      typeof raw.variant_key === "string"
        ? /^(.*)#ram=(x|[1-9][0-9]*)#st=(x|[1-9][0-9]*)#sku=(x|[A-Za-z0-9/-]{2,32})$/.exec(
            raw.variant_key,
          )
        : null;
    key(
      !!match &&
        matches(match[1], reference, 120) &&
        !(match[2] === "x" && match[3] === "x" && match[4] === "x") &&
        (match[2] === "x" || +match[2] <= 64) &&
        (match[3] === "x" || +match[3] <= 8192),
    );
  }
  if (raw.kind.startsWith("hardware_")) {
    if (["phone", "tablet"].includes(raw.hardware_class)) errors.push("use_mobile_subject");
    else if (!includes(HARDWARE_CLASSES, raw.hardware_class)) errors.push("invalid_subject");
    if (raw.kind === "hardware_port") key(matches(raw.port_id, /^[a-z0-9][a-z0-9-]{0,31}$/));
  }
  if (raw.kind === "game_work") key(matches(raw.work_key, work));
  if (["game_edition", "game_build"].includes(raw.kind)) key(matches(raw.edition_key, edition));
  if (raw.kind === "game_build") {
    if (!includes(OS_PRODUCTS, raw.platform)) errors.push("invalid_subject");
    key(raw.version === null || matches(raw.version, version));
  }
  if (raw.kind === "os_release") {
    if (!includes(OS_PRODUCTS, raw.os_product)) errors.push("invalid_subject");
    key(matches(raw.release, /^[a-z0-9][a-z0-9.+-]{0,31}$/));
  }
  if (raw.kind === "store_listing") {
    if (!includes(STORES, raw.store)) errors.push("invalid_subject");
    const pattern =
      raw.store === "apple_app_store"
        ? /^[1-9][0-9]{0,11}$/
        : raw.store === "google_play"
          ? /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
          : raw.store === "steam"
            ? /^[1-9][0-9]{0,9}$/
            : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    key(matches(raw.store_app_id, pattern, raw.store === "google_play" ? 150 : Infinity));
    if (!matches(raw.country, /^[A-Z]{2}$/)) errors.push("invalid_subject");
  }
  if (raw.kind === "pairing") {
    if (
      !object(raw.game) ||
      !["game_edition", "game_build", "store_listing"].includes(raw.game.kind) ||
      !object(raw.device) ||
      !["mobile_reference", "mobile_variant", "hardware_reference"].includes(raw.device.kind)
    )
      errors.push("invalid_subject");
    else errors.push(...subjectReasons(raw.game), ...subjectReasons(raw.device));
  }
  return errors;
}
function validDate(value: unknown, instant = false): value is string {
  if (
    typeof value !== "string" ||
    !(instant ? /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)
  )
    return false;
  const parsed = new Date(value.length === 10 ? value + "T00:00:00Z" : value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().replace(".000Z", "Z").slice(0, value.length) === value
  );
}
function validUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      !isIP(u.hostname.replace(/^\[|\]$/g, ""))
    );
  } catch {
    return false;
  }
}
function textValid(value: string): boolean {
  return (
    !!value.length &&
    value.trim() === value &&
    value.normalize("NFC") === value &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) <= 31 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}
const properties = [
  "contract",
  "subject",
  "field",
  "value_state",
  "value",
  "unit",
  "unknown_reason",
  "basis",
  "list_exhaustive",
  "country",
  "source",
  "collection",
  "observed_at",
  "source_updated_at",
  "reviewed_on",
];
export function validateObservation(
  input: unknown,
  ctx: { now: Date; register?: SourceRegisterView; registry?: FieldRegistry },
):
  | {
      ok: true;
      observation: EvidenceObservation;
      key: string;
      host: string;
      classification: "origin_verified" | "attested_only";
      effective_publish: Publish;
    }
  | { ok: false; reasons: EvidenceRejectReason[] } {
  const reasons = new Set<EvidenceRejectReason>();
  const add = (reason: EvidenceRejectReason) => reasons.add(reason);
  if (!object(input)) return { ok: false, reasons: ["not_an_object"] };
  const r = input;
  if (r.contract !== EVIDENCE_CONTRACT) add("contract_mismatch");
  function shape(value: Record<string, any>, keys: string[]) {
    if (keys.some((k) => !own(value, k))) add("missing_property");
    if (Object.keys(value).some((k) => !keys.includes(k))) add("unexpected_property");
  }
  shape(r, properties);
  subjectReasons(r.subject).forEach(add);
  const registry: FieldRegistry = ctx.registry ?? FIELD_REGISTRY;
  const field =
    typeof r.field === "string" && own(registry, r.field) ? registry[r.field] : undefined;
  if (
    object(r.subject) &&
    typeof r.subject.kind === "string" &&
    r.subject.kind.startsWith("mobile_") &&
    includes(MOBILE_OWNED_FIELDS, r.field)
  )
    add("field_owned_by_mobile_staging");
  else if (
    typeof r.field === "string" &&
    (forbidden.includes(r.field) || /(^|_)(fps|benchmark|price|msrp|cost|tier)(_|$)/.test(r.field))
  )
    add("field_forbidden");
  else if (!field) add("field_not_in_contract");
  if (field) {
    if (!field.subjects.includes(r.subject?.kind)) add("subject_kind_not_allowed_for_field");
    if (field.stores && !field.stores.includes(r.subject?.store))
      add("store_not_allowed_for_field");
    if (r.unit !== field.unit) add("unit_mismatch");
  }
  const stated = r.value_state === "stated";
  const unknown = r.value_state === "unknown";
  if (
    (!stated && !unknown) ||
    (stated && (r.value == null || r.basis == null || r.unknown_reason !== null)) ||
    (unknown && (r.value !== null || r.basis !== null || r.unknown_reason == null))
  )
    add("value_state_invalid");
  if (unknown && !includes(INPUT_UNKNOWN_REASONS, r.unknown_reason)) add("unknown_reason_invalid");
  if (stated) {
    if (!includes(BASES, r.basis)) add("basis_not_in_contract");
    else if (field && !field.bases.includes(r.basis)) add("basis_not_allowed_for_field");
    if (r.basis === "derived") add("derivation_rule_unknown");
    if (field) {
      if (field.value === "integer") {
        if (typeof r.value !== "number" || !Number.isSafeInteger(r.value))
          add("value_type_mismatch");
        else if (r.value < field.min! || r.value > field.max!) add("value_out_of_range");
      } else if (field.value === "boolean") {
        if (typeof r.value !== "boolean") add("value_type_mismatch");
      } else {
        const values = field.value === "list" ? r.value : [r.value];
        if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
          add("value_type_mismatch");
        else {
          if (!values.length) add("empty_list_use_unknown");
          if (new Set(values).size !== values.length) add("duplicate_list_item");
          if (field.value === "list" && field.max !== undefined && values.length > field.max)
            add("value_out_of_range");
          for (const value of values) {
            if (!textValid(value)) add("text_invalid");
            if (
              (field.maxLength && value.length > field.maxLength) ||
              (field.pattern && !field.pattern.test(value))
            )
              add("value_out_of_range");
            if (field.vocabulary && !field.vocabulary.includes(value))
              add("value_not_in_vocabulary");
            if (field.url && !validUrl(value)) add("invalid_url");
          }
        }
      }
    }
  }
  const exhaustive =
    unknown && r.unknown_reason === "not_listed"
      ? r.list_exhaustive === false
      : stated && field?.exhaustive
        ? typeof r.list_exhaustive === "boolean"
        : r.list_exhaustive === null;
  if (!exhaustive) add("list_exhaustive_invalid");
  if (
    stated &&
    r.field === "publisher_lists_device" &&
    r.value === false &&
    r.list_exhaustive !== true
  )
    add("negative_requires_exhaustive_list");
  if (!matches(r.country, /^([A-Z]{2}|GLOBAL|UNSPECIFIED)$/)) add("invalid_country");
  if (field?.class === "listing" && r.country !== r.subject?.country) add("country_scope_mismatch");
  const nowDate = ctx.now.toISOString().slice(0, 10);
  if (
    !validDate(r.observed_at, true) ||
    (r.source_updated_at !== null && !validDate(r.source_updated_at))
  )
    add("invalid_date");
  if (validDate(r.observed_at, true)) {
    if (
      r.observed_at.length === 10
        ? r.observed_at > nowDate
        : Date.parse(r.observed_at) > ctx.now.getTime()
    )
      add("observed_in_future");
    if (validDate(r.source_updated_at) && r.source_updated_at > r.observed_at.slice(0, 10))
      add("source_updated_after_observed");
  }
  if (r.collection === "manual_read") {
    if (
      !validDate(r.reviewed_on) ||
      !validDate(r.observed_at, true) ||
      r.reviewed_on < r.observed_at.slice(0, 10) ||
      r.reviewed_on > nowDate
    )
      add("review_date_invalid");
  } else if (r.collection !== "bounded_get" || r.reviewed_on !== null) add("review_date_invalid");
  let classification: ReturnType<typeof classifyCitation> = "attested_only";
  if (!object(r.source)) add("missing_property");
  else {
    shape(r.source, ["source_id", "url", "source_version"]);
    if (!validUrl(r.source.url)) add("invalid_url");
    if (
      r.source.source_version !== null &&
      !matches(r.source.source_version, /^[\x20-\x7e]{1,64}$/)
    )
      add("source_version_invalid");
    if (!sourceEntry(r.source.source_id, ctx.register)) add("source_not_registered");
    else {
      if (
        !includes(COLLECTIONS, r.collection) ||
        !routePermitted(r.source.source_id, r.collection, ctx.now, ctx.register)
      )
        add("collection_not_permitted");
      if (!fieldAccess(r.source.source_id, r.field, ctx.register))
        add("field_not_permitted_for_source");
      classification = classifyCitation(r.source.source_id, r.source.url, ctx.register);
      if (classification === "origin_mismatch") add("source_origin_mismatch");
    }
  }
  if (reasons.size) return { ok: false, reasons: [...reasons].sort() };
  const observation = {
    ...r,
    subject: JSON.parse(canonicalJson(r.subject)),
    source: { ...r.source },
    value: Array.isArray(r.value) ? [...r.value].sort() : Object.is(r.value, -0) ? 0 : r.value,
  } as EvidenceObservation;
  const { reviewed_on: _reviewed, ...content } = observation;
  return {
    ok: true,
    observation,
    key: sha256Hex(canonicalJson(content)),
    host: new URL(observation.source.url).hostname,
    classification: classification as "origin_verified" | "attested_only",
    effective_publish: effectivePublish(
      observation.source.source_id,
      observation.field,
      observation.source.url,
      ctx.register,
    ),
  };
}
export class EvidenceContractError extends Error {
  constructor(readonly code: "invalid_query") {
    super(code);
    this.name = "EvidenceContractError";
  }
}
export interface ValueGroup {
  value: Value;
  keys: string[];
  as_of: string;
}
export type FieldAssessment =
  | {
      status: "current";
      value: Value;
      unit: string | null;
      bases: Basis[];
      as_of: string;
      contributors: string[];
      publish: Publish;
      supporting: string[];
    }
  | {
      status: "conflicting";
      values: ValueGroup[];
      unit: string | null;
      publish: Publish;
      supporting: string[];
    }
  | {
      status: "stale";
      values: ValueGroup[];
      unit: string | null;
      as_of: string;
      publish: Publish;
      supporting: string[];
    }
  | { status: "unknown"; reason: AssessmentUnknownReason; supporting: string[] }
  | { status: "withdrawn"; supporting: string[] };
type Reading = { observation: EvidenceObservation; key: string };
const sortedKeys = (rows: readonly Reading[]) => [...new Set(rows.map((r) => r.key))].sort();
const instant = (r: Reading) => Date.parse(r.observation.observed_at);
const fullInstant = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
function latest(rows: Reading[]): Reading[] {
  const pages = new Map<string, Reading[]>();
  for (const r of rows)
    pages.set(r.observation.source.url, [...(pages.get(r.observation.source.url) ?? []), r]);
  return [...pages.values()].flatMap((page) => {
    const successes = page.filter(
      (r) =>
        !(
          r.observation.value_state === "unknown" &&
          r.observation.unknown_reason === "source_unavailable"
        ),
    );
    const eligible = successes.length ? successes : page;
    const newest = Math.max(...eligible.map(instant));
    return eligible.filter((r) => instant(r) === newest);
  });
}
function groups(rows: Reading[]): ValueGroup[] {
  const values = new Map<string, Reading[]>();
  for (const r of rows) {
    const key = canonicalJson(r.observation.value);
    values.set(key, [...(values.get(key) ?? []), r]);
  }
  return [...values.keys()].sort().map((key) => ({
    value: JSON.parse(key),
    keys: sortedKeys(values.get(key)!),
    as_of: fullInstant(Math.max(...values.get(key)!.map(instant))),
  }));
}
export function assessField(
  query: { subject: SubjectRef; field: EvidenceField; country: string },
  observations: ReadonlyArray<Reading>,
  ctx: { now: Date; register?: SourceRegisterView },
): FieldAssessment {
  if (
    !object(query) ||
    subjectReasons(query.subject).length ||
    !own(FIELD_REGISTRY, query.field) ||
    !matches(query.country, /^[A-Z]{2}$/) ||
    !FIELD_REGISTRY[query.field].subjects.includes(query.subject.kind) ||
    (FIELD_REGISTRY[query.field].stores &&
      !FIELD_REGISTRY[query.field].stores!.includes(
        (query.subject as GameSide & { store: StoreId }).store,
      ))
  )
    throw new EvidenceContractError("invalid_query");
  const field = FIELD_REGISTRY[query.field];
  const rules = FIELD_CLASSES[field.class];
  const all = [...new Map(observations.map((r) => [r.key, r])).values()].filter(
    (r) =>
      r.observation.field === query.field &&
      subjectKey(r.observation.subject) === subjectKey(query.subject),
  );
  const C = all.filter(
    (r) =>
      rules.country === "any" ||
      r.observation.country === query.country ||
      (rules.country === "exact_or_global" && r.observation.country === "GLOBAL"),
  );
  const X =
    rules.country === "exact_or_global"
      ? all.filter(
          (r) =>
            /^[A-Z]{2}$/.test(r.observation.country) && r.observation.country !== query.country,
        )
      : [];
  const supporting = sortedKeys(C);
  if (!C.length) return { status: "unknown", reason: "no_observation", supporting };
  const withdrawn = (r: Reading) => {
    const s = sourceEntry(r.observation.source.source_id, ctx.register);
    return (
      !!s &&
      (s.routes[r.observation.collection] === "withdrawn" ||
        (s.withdrawn_at !== null && Date.parse(s.withdrawn_at) <= ctx.now.getTime()))
    );
  };
  const permitted = (r: Reading) =>
    routePermitted(
      r.observation.source.source_id,
      r.observation.collection,
      ctx.now,
      ctx.register,
    ) && !!fieldAccess(r.observation.source.source_id, r.observation.field, ctx.register);
  const U = C.filter(permitted);
  if (!U.length)
    return C.some(withdrawn)
      ? { status: "withdrawn", supporting }
      : { status: "unknown", reason: "no_permitted_source", supporting };
  const L = latest(U);
  const T = L.filter((r) => r.observation.value_state === "stated");
  const fresh = (r: Reading) =>
    rules.ttlDays === null || ctx.now.getTime() - instant(r) <= rules.ttlDays * 86400000;
  const S = T.filter(fresh);
  const SX = latest(X.filter(permitted)).filter(
    (r) => r.observation.value_state === "stated" && fresh(r),
  );
  const publication = (rows: Reading[]): Publish => {
    const ranks: Publish[] = ["withheld", "link_only", "fact_with_attribution"];
    return ranks[
      Math.min(
        ...rows.map((r) =>
          ranks.indexOf(
            effectivePublish(
              r.observation.source.source_id,
              r.observation.field,
              r.observation.source.url,
              ctx.register,
            ),
          ),
        ),
      )
    ];
  };
  if (S.length) {
    let used = S;
    if (
      groups(S).length === 1 &&
      rules.country === "exact_or_global" &&
      !S.some((r) => r.observation.country === query.country)
    ) {
      used = [
        ...S,
        ...SX.filter(
          (r) => canonicalJson(r.observation.value) !== canonicalJson(S[0].observation.value),
        ),
      ];
    }
    const values = groups(used);
    const support = sortedKeys([...C, ...used]);
    if (values.length > 1)
      return {
        status: "conflicting",
        values,
        unit: field.unit,
        publish: publication(used),
        supporting: support,
      };
    return {
      status: "current",
      value: values[0].value,
      unit: field.unit,
      bases: [...new Set(S.map((r) => r.observation.basis!))].sort(),
      as_of: values[0].as_of,
      contributors: sortedKeys(S),
      publish: publication(S),
      supporting: support,
    };
  }
  if (T.length) {
    const values = groups(T).sort(
      (a, b) =>
        b.as_of.localeCompare(a.as_of) ||
        (canonicalJson(a.value) < canonicalJson(b.value) ? -1 : 1),
    );
    return {
      status: "stale",
      values,
      unit: field.unit,
      as_of: values[0].as_of,
      publish: publication(T),
      supporting,
    };
  }
  const priority: InputUnknownReason[] = [
    "subject_ambiguous",
    "source_unavailable",
    "not_listed",
    "not_published",
  ];
  return {
    status: "unknown",
    reason: priority.find((reason) => L.some((r) => r.observation.unknown_reason === reason))!,
    supporting,
  };
}
