import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  EVIDENCE_CONTRACT,
  validateObservation,
  type EvidenceObservation,
  type FieldRegistry,
  type SubjectRef,
} from "../lib/evidenceContract";
import {
  classifyCitation,
  routePermitted,
  type Publish,
  type SourceRegisterView,
} from "../lib/sourceAccess";
import { canonicalJson, sha256Hex } from "./enrichmentPromotion";

export const DPX_IDENTITY_CONTRACT = "mgpl-dpx-identity/1" as const;
export const DPX_IDENTITY_TABLES = [
  "dpx_import_batches",
  "dpx_game_works",
  "dpx_work_links",
  "dpx_game_editions",
  "dpx_store_products",
  "dpx_hardware_families",
  "dpx_hardware_references",
  "dpx_evidence_observations",
] as const;
export const DPX_IMPORT_LIMITS = {
  maxBytes: 5_000_000,
  maxRecords: 20_000,
  maxLineBytes: 16_384,
} as const;
export const DPX_RECORD_TYPES = [
  "header",
  "work",
  "work_link",
  "edition",
  "store_product",
  "hardware_family",
  "hardware_reference",
  "observation",
] as const;
export type DpxRecordType = (typeof DPX_RECORD_TYPES)[number];
const gameSources = ["publisher-pages", "apple-app-store-page", "google-play-page"] as const;
export const DPX_BASIS_SOURCES: Readonly<
  Record<Exclude<DpxRecordType, "header" | "observation">, readonly string[]>
> = {
  work: ["wikidata", ...gameSources],
  work_link: ["wikidata"],
  edition: ["wikidata", ...gameSources],
  store_product: gameSources,
  hardware_family: ["manufacturer-pages"],
  hardware_reference: ["manufacturer-pages"],
};
export type DpxImportErrorCode =
  | "input_mismatch"
  | "plan_stale"
  | "plan_not_applicable"
  | "plan_digest_missing"
  | "tables_missing"
  | "input_too_large";
export class DpxImportError extends Error {
  constructor(readonly code: DpxImportErrorCode) {
    super(code);
    this.name = "DpxImportError";
  }
}
export type DpxLineStatus = "inserted" | "unchanged" | "rejected" | "blocked";
export interface DpxLineOutcome {
  line: number;
  recordType: DpxRecordType | null;
  status: DpxLineStatus;
  ref: string | null;
  reasons: string[];
}
export interface DpxCounts {
  inserted: number;
  unchanged: number;
  rejected: number;
  blocked: number;
}
export interface DpxCitation {
  source_id: string;
  host: string;
  classification: "origin_verified" | "attested_only";
  lines: number;
}
export type DpxReportStatus = "applicable" | "no_changes" | "not_applicable" | "already_applied";
export interface DpxImportReport {
  contract: typeof DPX_IDENTITY_CONTRACT;
  status: DpxReportStatus;
  inputSha256: string;
  planSha256: string | null;
  header: { line: 1 | null; status: "accepted" | "rejected"; reasons: string[] };
  records: number;
  outcomes: DpxLineOutcome[];
  counts: DpxCounts;
  citations: DpxCitation[];
  alreadyAppliedBatchId: string | null;
}
export interface DpxApplyResult {
  status: "applied" | "already_applied" | "no_changes";
  batchId: string | null;
  counts: DpxCounts;
  existingBatch: { batchId: string; appliedAt: string; counts: DpxCounts } | null;
}
type Raw = Record<string, unknown>;
type Table = (typeof DPX_IDENTITY_TABLES)[number];
type Row = Record<string, string | number | null>;
export type DpxObservationRow = Row & {
  observation_key: string;
  contract: typeof EVIDENCE_CONTRACT;
  subject_kind: SubjectRef["kind"];
  subject_json: string;
  field: EvidenceObservation["field"];
  value_state: EvidenceObservation["value_state"];
  value_json: string | null;
  unit: string | null;
  unknown_reason: EvidenceObservation["unknown_reason"];
  basis: EvidenceObservation["basis"];
  list_exhaustive: number | null;
  country: string;
  source_id: string;
  source_url: string;
  source_version: string | null;
  collection: EvidenceObservation["collection"];
  observed_at: string;
  source_updated_at: string | null;
  reviewed_on: string | null;
  classification: "origin_verified" | "attested_only";
  effective_publish: Publish;
  batch_id: string;
};
export type DpxParsedLine =
  | { line: number; ok: true; recordType: DpxRecordType | null; record: Raw }
  | { line: number; ok: false; reason: string };
type Write = { table: Table; action: "insert"; row: Row; key: Row };
type Citation = Omit<DpxCitation, "lines">;
type Entry = {
  raw: Raw;
  outcome: DpxLineOutcome;
  table?: Table;
  key?: string[];
  row?: Row;
  citation?: Citation;
};
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const sorted = (reasons: string[]) => [...new Set(reasons)].sort();
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const zero = (): DpxCounts => ({ inserted: 0, unchanged: 0, rejected: 0, blocked: 0 });
const mobileTables = [
  "mobile_device_families",
  "mobile_hardware_references",
  "mobile_device_variants",
] as const;
const primaryKeys: Record<Table, string[]> = {
  dpx_import_batches: ["batch_id"],
  dpx_game_works: ["work_key"],
  dpx_work_links: ["mgpl_work_key"],
  dpx_game_editions: ["edition_key"],
  dpx_store_products: ["store", "store_app_id"],
  dpx_hardware_families: ["family_key"],
  dpx_hardware_references: ["reference_key"],
  dpx_evidence_observations: ["observation_key"],
};
const attributes: Record<Table, string[]> = {
  dpx_import_batches: [],
  dpx_game_works: ["key_scheme"],
  dpx_work_links: ["wikidata_work_key"],
  dpx_game_editions: ["work_key"],
  dpx_store_products: ["edition_key"],
  dpx_hardware_families: ["manufacturer", "hardware_class", "marketing_name"],
  dpx_hardware_references: [
    "family_key",
    "hardware_class",
    "reference_label",
    "configuration",
    "scope_market",
    "model_code",
  ],
  dpx_evidence_observations: [],
};
const recordTables: Record<Exclude<DpxRecordType, "header">, Table> = {
  work: "dpx_game_works",
  work_link: "dpx_work_links",
  edition: "dpx_game_editions",
  store_product: "dpx_store_products",
  hardware_family: "dpx_hardware_families",
  hardware_reference: "dpx_hardware_references",
  observation: "dpx_evidence_observations",
};
const properties: Record<DpxRecordType, string[]> = {
  header: ["contract", "prepared_on", "prepared_by"],
  work: ["work_key", "basis"],
  work_link: ["mgpl_work_key", "wikidata_work_key", "basis"],
  edition: ["edition_key", "work_key", "basis"],
  store_product: ["store", "store_app_id", "edition_key", "basis"],
  hardware_family: ["family_key", "manufacturer", "hardware_class", "marketing_name", "basis"],
  hardware_reference: [
    "reference_key",
    "family_key",
    "hardware_class",
    "reference_label",
    "configuration",
    "scope_market",
    "model_code",
    "basis",
  ],
  observation: ["observation"],
};
export function dpxReportRef(table: Table, keyParts: readonly string[]): string {
  return sha256Hex(
    canonicalJson({ contract: DPX_IDENTITY_CONTRACT, purpose: "report_ref", table, key: keyParts }),
  );
}
export function parseDpxIdentityJsonl(bytes: Buffer): DpxParsedLine[] {
  if (bytes.length > DPX_IMPORT_LIMITS.maxBytes) throw new DpxImportError("input_too_large");
  if (!bytes.length) return [];
  const segments: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 10) {
      segments.push(bytes.subarray(start, i));
      start = i + 1;
    }
  if (start < bytes.length) segments.push(bytes.subarray(start));
  if (segments.length - 1 > DPX_IMPORT_LIMITS.maxRecords)
    throw new DpxImportError("input_too_large");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return segments.map((segment, i): DpxParsedLine => {
    if (segment.at(-1) === 13) segment = segment.subarray(0, -1);
    const bad = (reason: string): DpxParsedLine => ({ line: i + 1, ok: false, reason });
    if (!segment.length) return bad("blank_line");
    if (segment.length > DPX_IMPORT_LIMITS.maxLineBytes) return bad("line_too_long");
    if (segment[0] === 239 && segment[1] === 187 && segment[2] === 191)
      return bad("bom_not_allowed");
    let text: string;
    try {
      text = decoder.decode(segment);
    } catch {
      return bad("invalid_utf8");
    }
    try {
      const record: unknown = JSON.parse(text);
      if (!isObject(record)) return bad("malformed_json");
      return {
        line: i + 1,
        ok: true,
        recordType: DPX_RECORD_TYPES.includes(record.record_type as DpxRecordType)
          ? (record.record_type as DpxRecordType)
          : null,
        record,
      };
    } catch {
      return bad("malformed_json");
    }
  });
}
function probe(subject: unknown, now: Date): string[] {
  const day = now.toISOString().slice(0, 10);
  const result = validateObservation(
    {
      contract: EVIDENCE_CONTRACT,
      subject,
      field: "edition_title",
      value_state: "unknown",
      value: null,
      unit: null,
      unknown_reason: "not_published",
      basis: null,
      list_exhaustive: null,
      country: "GLOBAL",
      source: {
        source_id: "publisher-pages",
        url: "https://probe.invalid/x",
        source_version: null,
      },
      collection: "manual_read",
      observed_at: day,
      source_updated_at: null,
      reviewed_on: day,
    },
    { now },
  );
  return result.ok
    ? []
    : result.reasons.filter((r) =>
        ["invalid_subject", "invalid_key", "use_mobile_subject"].includes(r),
      );
}
function textValid(v: unknown, max: number): boolean {
  return (
    isString(v) &&
    v.length > 0 &&
    v.length <= max &&
    v.trim() === v &&
    v.normalize("NFC") === v &&
    !Array.from(v).some(
      (character) =>
        character.charCodeAt(0) <= 31 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)
  );
}
function dateReasons(v: unknown, now: Date): string[] {
  if (
    !isString(v) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    return ["invalid_date"];
  return v > now.toISOString().slice(0, 10) ? ["observed_in_future"] : [];
}
// Use the shipped validator for URL syntax too, including its IP-literal refusal.
function urlValid(url: unknown, now: Date): boolean {
  const day = now.toISOString().slice(0, 10);
  const r = validateObservation(
    {
      contract: EVIDENCE_CONTRACT,
      subject: { kind: "game_work", work_key: "mgpl:probe" },
      field: "edition_title",
      value_state: "unknown",
      value: null,
      unit: null,
      unknown_reason: "not_published",
      basis: null,
      list_exhaustive: null,
      country: "GLOBAL",
      source: { source_id: "publisher-pages", url, source_version: null },
      collection: "manual_read",
      observed_at: day,
      source_updated_at: null,
      reviewed_on: day,
    },
    { now },
  );
  return r.ok || !r.reasons.includes("invalid_url");
}
function propertyReasons(raw: Raw, keys: string[]): string[] {
  return [
    ...(keys.some((k) => !own(raw, k)) ? ["missing_property"] : []),
    ...(Object.keys(raw).some((k) => !keys.includes(k)) ? ["unexpected_property"] : []),
  ];
}
function allowedBasis(
  type: Exclude<DpxRecordType, "header" | "observation">,
  r: Raw,
): readonly string[] {
  if (type === "work")
    return isString(r.work_key) && r.work_key.startsWith("wd:") ? ["wikidata"] : gameSources;
  if (type === "edition" && !(isString(r.work_key) && r.work_key.startsWith("wd:")))
    return gameSources;
  if (type === "store_product")
    return [
      "publisher-pages",
      ...(r.store === "apple_app_store"
        ? ["apple-app-store-page"]
        : r.store === "google_play"
          ? ["google-play-page"]
          : []),
    ];
  return DPX_BASIS_SOURCES[type];
}
function localEntry(
  parsed: DpxParsedLine,
  opts: { now: Date; register?: SourceRegisterView; registry?: FieldRegistry },
): Entry {
  const outcome: DpxLineOutcome = {
    line: parsed.line,
    recordType: parsed.ok ? parsed.recordType : null,
    status: "inserted",
    ref: null,
    reasons: [],
  };
  const e: Entry = { raw: parsed.ok ? parsed.record : {}, outcome };
  const reject = (reasons: string[]) => {
    outcome.reasons = sorted(reasons);
    outcome.status = outcome.reasons.length ? "rejected" : "inserted";
    return e;
  };
  if (!parsed.ok) return reject([parsed.reason]);
  const type = parsed.recordType,
    r = parsed.record;
  if (!type) return reject(["unknown_record_type"]);
  if (type === "header" && parsed.line !== 1) return reject(["header_duplicate"]);
  const reasons = propertyReasons(r, ["record_type", ...properties[type]]);
  const has = (k: string) => own(r, k);
  if (type === "header") {
    if (r.contract !== DPX_IDENTITY_CONTRACT) reasons.push("contract_mismatch");
    if (has("prepared_by") && !textValid(r.prepared_by, 40)) reasons.push("text_invalid");
    if (has("prepared_on")) reasons.push(...dateReasons(r.prepared_on, opts.now));
    return reject(reasons);
  }
  e.table = recordTables[type];
  if (type === "observation") {
    const admitted = validateObservation(r.observation, {
      now: opts.now,
      register: opts.register,
      registry: opts.registry,
    });
    if (!admitted.ok) reasons.push(...admitted.reasons);
    else {
      e.row = dpxObservationRow(admitted, "@batch");
      e.key = [admitted.key];
      e.citation = {
        source_id: admitted.observation.source.source_id,
        host: admitted.host,
        classification: admitted.classification,
      };
    }
  } else {
    const grammar: string[] = [];
    const check = (s: unknown) => grammar.push(...probe(s, opts.now));
    if (type === "work") check({ kind: "game_work", work_key: r.work_key });
    if (type === "work_link") {
      check({ kind: "game_work", work_key: r.mgpl_work_key });
      check({ kind: "game_work", work_key: r.wikidata_work_key });
      if (
        !isString(r.mgpl_work_key) ||
        !r.mgpl_work_key.startsWith("mgpl:") ||
        !isString(r.wikidata_work_key) ||
        !r.wikidata_work_key.startsWith("wd:")
      )
        grammar.push("invalid_key");
    }
    if (type === "edition" || type === "store_product") {
      check({ kind: "game_edition", edition_key: r.edition_key });
      if (type === "edition") {
        check({ kind: "game_work", work_key: r.work_key });
        if (!isString(r.edition_key) || r.edition_key.split("/")[0] !== r.work_key)
          grammar.push("invalid_key");
      } else
        check({
          kind: "store_listing",
          store: r.store,
          store_app_id: r.store_app_id,
          country: "US",
        });
    }
    if (type === "hardware_family" || type === "hardware_reference") {
      check({ kind: "mobile_family", family_key: r.family_key });
      check({
        kind: "hardware_reference",
        hardware_class: r.hardware_class,
        reference_key:
          type === "hardware_family" ? String(r.family_key) + ":probe" : r.reference_key,
      });
      if (
        type === "hardware_reference" &&
        (!isString(r.reference_key) ||
          r.reference_key.split(":").slice(0, 2).join(":") !== r.family_key)
      )
        grammar.push("invalid_key");
    }
    reasons.push(...grammar);
    if (type === "hardware_family") {
      if (has("manufacturer") && !textValid(r.manufacturer, 40)) reasons.push("text_invalid");
      if (has("marketing_name") && !textValid(r.marketing_name, 80)) reasons.push("text_invalid");
    }
    if (type === "hardware_reference") {
      if (has("reference_label") && !textValid(r.reference_label, 80)) reasons.push("text_invalid");
      if (
        has("configuration") &&
        (!isString(r.configuration) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(r.configuration))
      )
        reasons.push("invalid_value");
      if (
        has("scope_market") &&
        r.scope_market !== null &&
        (!isString(r.scope_market) || !/^(GLOBAL|UNSPECIFIED|[A-Z]{2})$/.test(r.scope_market))
      )
        reasons.push("invalid_value");
      if (
        has("model_code") &&
        r.model_code !== null &&
        (!isString(r.model_code) || !/^[A-Za-z0-9-]{2,24}$/.test(r.model_code))
      )
        reasons.push("invalid_value");
      if (
        has("model_code") &&
        has("scope_market") &&
        (r.model_code === null) === (r.scope_market === null)
      )
        reasons.push("model_code_scope_invalid");
    }
    if (!grammar.length) {
      e.key = primaryKeys[e.table].map((k) => r[k] as string);
      // All persisted identifiers and columns come from these fixed builders.
      const identity: Row = {};
      for (const k of [...primaryKeys[e.table], ...attributes[e.table]])
        if (k !== "key_scheme") identity[k] = r[k] as string | null;
      if (type === "work") {
        identity.key_scheme = String(r.work_key).startsWith("wd:") ? "wikidata" : "mgpl";
        identity.wikidata_qid =
          identity.key_scheme === "wikidata" ? String(r.work_key).slice(3) : null;
      }
      if (type === "edition") identity.edition_slug = String(r.edition_key).split("/")[1];
      if (type === "hardware_reference") identity.maker = String(r.family_key).split(":")[0];
      e.row = identity;
    }
    if (isObject(r.basis)) {
      const b = r.basis;
      reasons.push(...propertyReasons(b, ["source_id", "url", "observed_on"]));
      const validUrl = urlValid(b.url, opts.now);
      if (own(b, "url") && !validUrl) reasons.push("invalid_url");
      if (own(b, "observed_on")) reasons.push(...dateReasons(b.observed_on, opts.now));
      const source = isString(b.source_id) ? b.source_id : "";
      if (
        !allowedBasis(type, r).includes(source) ||
        !routePermitted(source, "manual_read", opts.now, opts.register)
      )
        reasons.push("basis_source_not_permitted");
      if (validUrl && isString(b.url)) {
        const classification = classifyCitation(source, b.url, opts.register);
        if (classification === "origin_mismatch") reasons.push("source_origin_mismatch");
        else e.citation = { source_id: source, host: new URL(b.url).hostname, classification };
      }
      if (e.row)
        Object.assign(e.row, {
          basis_source_id: b.source_id,
          basis_url: b.url,
          basis_observed_on: b.observed_on,
          first_batch_id: "@batch",
        });
    } else if (has("basis")) reasons.push("missing_property");
  }
  if (e.key) outcome.ref = dpxReportRef(e.table, e.key);
  return reject(reasons);
}
function checkTables(db: Database): void {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  if ([...DPX_IDENTITY_TABLES, ...mobileTables].some((t) => !has.get(t)))
    throw new DpxImportError("tables_missing");
}
function keyRow(table: Table, key: string[]): Row {
  return Object.fromEntries(primaryKeys[table].map((k, i) => [k, key[i]]));
}
function sameAttributes(table: Table, a: Row, b: Row): boolean {
  return attributes[table].every((k) => a[k] === b[k]);
}
function groupKey(table: string, key: readonly string[]) {
  return canonicalJson([table, ...key]);
}
function planInternal(
  db: Database,
  inputBytes: Buffer,
  opts: { now: Date; register?: SourceRegisterView; registry?: FieldRegistry },
): { report: DpxImportReport; writePlan: Write[] | null } {
  const parsed = parseDpxIdentityJsonl(inputBytes);
  checkTables(db);
  const inputSha256 = sha256Hex(inputBytes);
  const first = parsed[0];
  const h =
    first && first.ok && first.recordType === "header"
      ? localEntry(first, opts).outcome.reasons
      : first && !first.ok
        ? [first.reason]
        : ["header_missing"];
  const entries = parsed.slice(1).map((p) => localEntry(p, opts));
  const report: DpxImportReport = {
    contract: DPX_IDENTITY_CONTRACT,
    status: "not_applicable",
    inputSha256,
    planSha256: null,
    header: { line: first ? 1 : null, status: h.length ? "rejected" : "accepted", reasons: h },
    records: entries.length,
    outcomes: entries.map((e) => e.outcome),
    counts: zero(),
    citations: [],
    alreadyAppliedBatchId: null,
  };
  const rows = new Map<Table | (typeof mobileTables)[number], Map<string, Row>>();
  for (const t of [...DPX_IDENTITY_TABLES, ...mobileTables]) {
    const keys = t.startsWith("mobile_")
      ? [
          t === "mobile_device_families"
            ? "family_key"
            : t === "mobile_hardware_references"
              ? "reference_key"
              : "variant_key",
        ]
      : primaryKeys[t as Table];
    rows.set(
      t,
      new Map(
        (db.prepare(`SELECT * FROM ${t}`).all() as Row[]).map((r) => [
          canonicalJson(keys.map((k) => r[k])),
          r,
        ]),
      ),
    );
  }
  const dbRow = (t: Table | (typeof mobileTables)[number], key: string[]) =>
    rows.get(t)!.get(canonicalJson(key));
  const groups = new Map<string, Entry[]>();
  // Keep rejected declarations too: a dependent must distinguish a rejected anchor from an absent one.
  const declared = new Map<string, Entry[]>();
  for (const e of entries)
    if (e.table && e.key) {
      const id = groupKey(e.table, e.key);
      declared.set(id, [...(declared.get(id) ?? []), e]);
      if (e.outcome.status !== "rejected") groups.set(id, [...(groups.get(id) ?? []), e]);
    }
  const block = (e: Entry, reason: string) => {
    e.outcome.status = "blocked";
    e.outcome.reasons = sorted([...e.outcome.reasons, reason]);
  };
  const candidates: Entry[] = [];
  for (const members of groups.values()) {
    const representative = [...members].sort(
      (a, b) =>
        compareText(canonicalJson(a.raw), canonicalJson(b.raw)) || a.outcome.line - b.outcome.line,
    )[0];
    if (members.some((e) => !sameAttributes(e.table!, representative.row!, e.row!)))
      for (const e of members) block(e, "attribute_differs");
    else {
      candidates.push(representative);
      for (const e of members)
        if (e !== representative) {
          e.outcome.status = "rejected";
          e.outcome.reasons = ["duplicate_record"];
        }
    }
  }
  for (const e of candidates) {
    const t = e.table!,
      r = e.row!,
      existing = dbRow(t, e.key!);
    if (existing && !sameAttributes(t, r, existing)) block(e, "attribute_differs");
    if (t === "dpx_hardware_families" && dbRow("mobile_device_families", e.key!))
      block(e, "key_space_collision");
    if (t === "dpx_hardware_references") {
      if (dbRow("mobile_hardware_references", e.key!)) block(e, "key_space_collision");
      const others = [
        ...rows.get(t)!.values(),
        ...candidates.filter((o) => o !== e && o.table === t).map((o) => o.row!),
      ];
      if (
        r.model_code !== null &&
        others.some(
          (o) =>
            o.reference_key !== r.reference_key &&
            o.maker === r.maker &&
            isString(o.model_code) &&
            o.model_code.toUpperCase() === String(r.model_code).toUpperCase(),
        )
      )
        block(e, "model_code_already_assigned");
      if (
        r.model_code === null &&
        others.some(
          (o) =>
            o.reference_key !== r.reference_key &&
            o.model_code === null &&
            o.family_key === r.family_key &&
            o.scope_market === r.scope_market &&
            o.configuration === r.configuration,
        )
      )
        block(e, "duplicate_scope");
    }
    if (e.outcome.status !== "blocked" && existing) e.outcome.status = "unchanged";
  }
  const anchorReasons = (e: Entry): string[] => {
    const reasons: string[] = [];
    const need = (
      t: Table | (typeof mobileTables)[number],
      key: string[],
      missing: string,
      hardwareClass?: string,
    ) => {
      const existing = dbRow(t, key);
      const declarations = declared.get(groupKey(t, key)) ?? [];
      const accepted = declarations.find((d) =>
        ["inserted", "unchanged"].includes(d.outcome.status),
      );
      const r = existing ?? accepted?.row;
      if (!r) reasons.push(declarations.length ? "dependency_rejected" : missing);
      else if (hardwareClass !== undefined && r.hardware_class !== hardwareClass)
        reasons.push("hardware_class_mismatch");
    };
    const subject = (s: SubjectRef) => {
      switch (s.kind) {
        case "game_work":
          need("dpx_game_works", [s.work_key], "unknown_work_key");
          break;
        case "game_edition":
        case "game_build":
          need("dpx_game_editions", [s.edition_key], "unknown_edition_key");
          break;
        case "store_listing":
          need("dpx_store_products", [s.store, s.store_app_id], "unknown_store_product");
          break;
        case "hardware_reference":
        case "hardware_port":
          need(
            "dpx_hardware_references",
            [s.reference_key],
            "unknown_hardware_reference",
            s.hardware_class,
          );
          break;
        case "mobile_family":
          need("mobile_device_families", [s.family_key], "unknown_mobile_family");
          break;
        case "mobile_reference":
          need("mobile_hardware_references", [s.reference_key], "unknown_mobile_reference");
          break;
        case "mobile_variant":
          need("mobile_device_variants", [s.variant_key], "unknown_mobile_variant");
          break;
        case "pairing":
          subject(s.game);
          subject(s.device);
          break;
        case "os_release":
          break;
      }
    };
    const r = e.row!;
    switch (e.table) {
      case "dpx_work_links":
        need("dpx_game_works", [String(r.mgpl_work_key)], "unknown_work_key");
        need("dpx_game_works", [String(r.wikidata_work_key)], "unknown_work_key");
        break;
      case "dpx_game_editions":
        need("dpx_game_works", [String(r.work_key)], "unknown_work_key");
        break;
      case "dpx_store_products":
        need("dpx_game_editions", [String(r.edition_key)], "unknown_edition_key");
        break;
      case "dpx_hardware_references":
        need(
          "dpx_hardware_families",
          [String(r.family_key)],
          "unknown_family_key",
          String(r.hardware_class),
        );
        break;
      case "dpx_evidence_observations":
        subject(JSON.parse(String(r.subject_json)) as SubjectRef);
        break;
    }
    return reasons;
  };
  // Determine the set of unavailable anchors first, then report against that fixed point.
  let changed: boolean;
  do {
    const newlyBlocked = candidates.filter(
      (e) => e.outcome.status !== "blocked" && anchorReasons(e).length,
    );
    changed = newlyBlocked.length > 0;
    for (const e of newlyBlocked) e.outcome.status = "blocked";
  } while (changed);
  for (const e of candidates) for (const reason of anchorReasons(e)) block(e, reason);
  const citations = new Map<string, DpxCitation>();
  for (const e of candidates)
    if (e.citation) {
      const id = canonicalJson([e.citation.source_id, e.citation.host]);
      const citation = citations.get(id) ?? { ...e.citation, lines: 0 };
      citation.lines++;
      citations.set(id, citation);
    }
  report.citations = [...citations.values()].sort(
    (a, b) => compareText(a.source_id, b.source_id) || compareText(a.host, b.host),
  );
  for (const e of entries) report.counts[e.outcome.status]++;
  const existingBatch = db
    .prepare("SELECT batch_id FROM dpx_import_batches WHERE input_sha256 = ?")
    .get(inputSha256) as { batch_id: string } | undefined;
  const invalid = h.length > 0 || report.counts.rejected > 0 || report.counts.blocked > 0;
  const writePlan: Write[] | null = invalid
    ? null
    : candidates
        .filter((e) => e.outcome.status === "inserted")
        .map((e) => ({
          table: e.table!,
          action: "insert" as const,
          row: e.row!,
          key: keyRow(e.table!, e.key!),
        }));
  writePlan?.sort(
    (a, b) =>
      DPX_IDENTITY_TABLES.indexOf(a.table) - DPX_IDENTITY_TABLES.indexOf(b.table) ||
      compareKeyParts(Object.values(a.key), Object.values(b.key)),
  );
  report.status = existingBatch
    ? "already_applied"
    : invalid
      ? "not_applicable"
      : writePlan!.length
        ? "applicable"
        : "no_changes";
  report.alreadyAppliedBatchId = existingBatch?.batch_id ?? null;
  if (!existingBatch && writePlan !== null)
    report.planSha256 = sha256Hex(
      canonicalJson({ contract: DPX_IDENTITY_CONTRACT, inputSha256, writePlan }),
    );
  return { report, writePlan };
}
function compareKeyParts(a: (string | number | null)[], b: (string | number | null)[]): number {
  for (let i = 0; i < a.length; i++) {
    const order = compareText(String(a[i]), String(b[i]));
    if (order) return order;
  }
  return 0;
}
export function planDpxIdentityImport(
  db: Database,
  inputBytes: Buffer,
  opts: { now: Date; register?: SourceRegisterView; registry?: FieldRegistry },
): DpxImportReport {
  return planInternal(db, inputBytes, opts).report;
}
export function applyDpxIdentityImport(
  db: Database,
  inputBytes: Buffer,
  expected: { inputSha256: string; planSha256: string | null },
  opts: { now: Date; batchId?: string; register?: SourceRegisterView; registry?: FieldRegistry },
): DpxApplyResult {
  if (sha256Hex(inputBytes) !== expected.inputSha256) throw new DpxImportError("input_mismatch");
  const batchId = opts.batchId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(batchId))
    throw new TypeError("invalid batch ID");
  checkTables(db);
  return db
    .transaction((): DpxApplyResult => {
      const existing = db
        .prepare("SELECT * FROM dpx_import_batches WHERE input_sha256 = ?")
        .get(expected.inputSha256) as Row | undefined;
      if (existing)
        return {
          status: "already_applied",
          batchId: String(existing.batch_id),
          counts: zero(),
          existingBatch: {
            batchId: String(existing.batch_id),
            appliedAt: String(existing.applied_at),
            counts: {
              inserted: Number(existing.inserted_count),
              unchanged: Number(existing.unchanged_count),
              rejected: 0,
              blocked: 0,
            },
          },
        };
      const { report, writePlan } = planInternal(db, inputBytes, opts);
      if (writePlan === null) throw new DpxImportError("plan_not_applicable");
      if (expected.planSha256 === null) throw new DpxImportError("plan_digest_missing");
      if (expected.planSha256 !== report.planSha256) throw new DpxImportError("plan_stale");
      if (!writePlan.length)
        return { status: "no_changes", batchId: null, counts: zero(), existingBatch: null };
      db.prepare(
        "INSERT INTO dpx_import_batches (batch_id,contract,input_sha256,plan_sha256,input_records,inserted_count,unchanged_count,applied_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        batchId,
        DPX_IDENTITY_CONTRACT,
        report.inputSha256,
        report.planSha256,
        report.records,
        report.counts.inserted,
        report.counts.unchanged,
        opts.now.toISOString(),
      );
      for (const w of writePlan) {
        const columns = Object.keys(w.row);
        db.prepare(
          `INSERT INTO ${w.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(
          ...columns.map((k) =>
            ["batch_id", "first_batch_id"].includes(k) && w.row[k] === "@batch"
              ? batchId
              : w.row[k],
          ),
        );
      }
      return { status: "applied", batchId, counts: report.counts, existingBatch: null };
    })
    .immediate();
}
export function dpxObservationRow(
  admitted: {
    observation: EvidenceObservation;
    key: string;
    classification: "origin_verified" | "attested_only";
    effective_publish: Publish;
  },
  batchId: string,
): DpxObservationRow {
  const o = admitted.observation,
    s = o.subject,
    g = s.kind === "pairing" ? s.game : s,
    d = s.kind === "pairing" ? s.device : s;
  return {
    observation_key: admitted.key,
    contract: o.contract,
    subject_kind: s.kind,
    subject_json: canonicalJson(s),
    work_key: s.kind === "game_work" ? s.work_key : null,
    edition_key: g.kind === "game_edition" || g.kind === "game_build" ? g.edition_key : null,
    build_platform: g.kind === "game_build" ? g.platform : null,
    build_version: g.kind === "game_build" ? g.version : null,
    store: g.kind === "store_listing" ? g.store : null,
    store_app_id: g.kind === "store_listing" ? g.store_app_id : null,
    listing_country: g.kind === "store_listing" ? g.country : null,
    hardware_class:
      d.kind === "hardware_reference" || d.kind === "hardware_port" ? d.hardware_class : null,
    hardware_reference_key:
      d.kind === "hardware_reference" || d.kind === "hardware_port" ? d.reference_key : null,
    port_id: s.kind === "hardware_port" ? s.port_id : null,
    os_product: s.kind === "os_release" ? s.os_product : null,
    release_name: s.kind === "os_release" ? s.release : null,
    mobile_family_key: s.kind === "mobile_family" ? s.family_key : null,
    mobile_reference_key: d.kind === "mobile_reference" ? d.reference_key : null,
    mobile_variant_key: d.kind === "mobile_variant" ? d.variant_key : null,
    field: o.field,
    value_state: o.value_state,
    value_json: o.value === null ? null : canonicalJson(o.value),
    unit: o.unit,
    unknown_reason: o.unknown_reason,
    basis: o.basis,
    list_exhaustive: o.list_exhaustive === null ? null : Number(o.list_exhaustive),
    country: o.country,
    source_id: o.source.source_id,
    source_url: o.source.url,
    source_version: o.source.source_version,
    collection: o.collection,
    observed_at: o.observed_at,
    source_updated_at: o.source_updated_at,
    reviewed_on: o.reviewed_on,
    classification: admitted.classification,
    effective_publish: admitted.effective_publish,
    batch_id: batchId,
  };
}
export function dpxReadingFromRow(row: DpxObservationRow): {
  observation: EvidenceObservation;
  key: string;
} {
  return {
    key: row.observation_key,
    observation: {
      contract: row.contract,
      subject: JSON.parse(row.subject_json),
      field: row.field,
      value_state: row.value_state,
      value: row.value_json === null ? null : JSON.parse(row.value_json),
      unit: row.unit,
      unknown_reason: row.unknown_reason,
      basis: row.basis,
      list_exhaustive: row.list_exhaustive === null ? null : Boolean(row.list_exhaustive),
      country: row.country,
      source: { source_id: row.source_id, url: row.source_url, source_version: row.source_version },
      collection: row.collection,
      observed_at: row.observed_at,
      source_updated_at: row.source_updated_at,
      reviewed_on: row.reviewed_on,
    },
  };
}
export function readDpxEvidence(
  db: Database,
  subject: SubjectRef,
  field: string,
): Array<{ observation: EvidenceObservation; key: string }> {
  return (
    db
      .prepare(
        "SELECT * FROM dpx_evidence_observations WHERE field = ? AND subject_json = ? ORDER BY observation_key",
      )
      .all(field, canonicalJson(subject)) as DpxObservationRow[]
  ).map(dpxReadingFromRow);
}
export function dpxLogicalReferenceReport(db: Database): {
  missing_mobile_family: string[];
  missing_mobile_reference: string[];
  missing_mobile_variant: string[];
} {
  const result = {
    missing_mobile_family: [] as string[],
    missing_mobile_reference: [] as string[],
    missing_mobile_variant: [] as string[],
  };
  for (const [table, column, field] of [
    ["mobile_device_families", "mobile_family_key", "missing_mobile_family"],
    ["mobile_hardware_references", "mobile_reference_key", "missing_mobile_reference"],
    ["mobile_device_variants", "mobile_variant_key", "missing_mobile_variant"],
  ] as const) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    const keys = exists
      ? new Set(
          (
            db.prepare(`SELECT ${column.replace("mobile_", "")} AS k FROM ${table}`).all() as {
              k: string;
            }[]
          ).map((r) => r.k),
        )
      : new Set<string>();
    result[field] = (
      db
        .prepare(
          `SELECT observation_key, ${column} AS k FROM dpx_evidence_observations WHERE ${column} IS NOT NULL ORDER BY observation_key`,
        )
        .all() as { observation_key: string; k: string }[]
    )
      .filter((r) => !keys.has(r.k))
      .map((r) => r.observation_key);
  }
  return result;
}
