import { canonicalJson, sha256Hex } from "./enrichmentPromotion";

export const MOBILE_COHORT_CONVERTER = "mgpl-mobile-cohort-converter/1" as const;
export const MOBILE_COHORT_MANIFEST = "mgpl-mobile-cohort-conversion-manifest/1" as const;
export const JOIN_VERIFICATION_SCHEMA = "mgpl-ai112-join-verification/1" as const;

export type CohortFileName =
  | "candidates.jsonl"
  | "mobile-reference-bundle.jsonl"
  | "observations.jsonl"
  | "sources.json"
  | "game-listing-observations.jsonl"
  | "CORRECTED-OBSERVATIONS.jsonl"
  | "QUARANTINE.jsonl"
  | "SOURCE-REGISTER.json";

export interface CohortInventory {
  candidates: number;
  references: number;
  observations: number;
  sources: number;
  listings: number;
  corrected: number;
  holds: number;
}

export interface CohortPolicy {
  pins: Readonly<Record<CohortFileName, string>>;
  inventory: Readonly<CohortInventory>;
}

function deepFreeze<T>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const key of Object.keys(obj as any)) {
    const val = (obj as any)[key];
    if (val && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export const COHORT_20261021_POLICY: Readonly<CohortPolicy> = deepFreeze({
  pins: {
    "candidates.jsonl": "e4d3bc18578e7bbc84abac178e451ff64a9d0edeadfac9bba2ef1ee2c7dc236e",
    "mobile-reference-bundle.jsonl":
      "ce2fda82822e70bc5ca69b56903a1282bfcd059d08bb53cf7897a2e59af5044f",
    "observations.jsonl": "97f589916d9b8446e69d0269299e5b826a3c12d63e118d65707f299874d56d25",
    "sources.json": "eed374ea1ed7e7d20f211e76179738da62b27c8f7181072e4df0e9d2cd3b6511",
    "game-listing-observations.jsonl":
      "30aca2a459cad8860c95882a648724ff571930da13db12eb08668c505a357fe2",
    "CORRECTED-OBSERVATIONS.jsonl":
      "316313374ee91bdf06b543b9ec84e5a3d96f890e2b9bbff3f51440364e0c9f8b",
    "QUARANTINE.jsonl": "c63e0785bfa9f79427a62f97dfa809b831c8ca4ac5cc83e728b399aaec7a8eaf",
    "SOURCE-REGISTER.json": "35c0022ea6feca7772ac29a64dd368981ae1371b6b3c0ecb897dc5d5422995c3",
  },
  inventory: {
    candidates: 70,
    references: 79,
    observations: 85,
    sources: 64,
    listings: 41,
    corrected: 94,
    holds: 25,
  },
});

export interface CohortInput {
  files: Readonly<Record<CohortFileName, Buffer>>;
  joinVerification: { bytes: Buffer; expectedSha256: string; runDate: string } | null;
}

export interface CohortRefusal {
  code: string;
  detail: string;
}

export class MobileCohortConversionError extends Error {
  readonly refusals: CohortRefusal[];
  constructor(refusals: CohortRefusal[]) {
    super(`Cohort conversion failed with ${refusals.length} refusal(s)`);
    this.name = "MobileCohortConversionError";
    this.refusals = refusals;
    Object.setPrototypeOf(this, MobileCohortConversionError.prototype);
  }
}

export interface CohortConversion {
  jsonl: Buffer;
  manifest: Buffer;
  jsonlSha256: string;
  manifestSha256: string;
  recordsByType: Record<string, number>;
  expectedQuarantinedLines: number[];
  stagedJoins: string[];
}

const KNOWN_SPEC_KEYS = new Set([
  "name",
  "chip",
  "gpu_cores",
  "screen_diagonal_inches",
  "display_resolution_pixels",
  "adaptive_refresh_max_hz",
  "display_refresh_max_hz",
  "source_url",
  "ram_gb",
  "ram_status",
  "observed_on",
  "region",
  "gaming_performance",
  "ram_options_gb",
  "ram_storage_binding_status",
  "identity_source_url",
  "ram_options_exhaustive",
  "reference_wifi_model_code",
  "exact_model_code",
  "ram_storage_options_gb",
  "ram_storage_options_exhaustive",
  "reference_variant_id",
  "variant_join_permitted",
  "reference_label",
  "chip_status",
  "source_reported_chip",
  "conflicting_source_url",
  "conflicting_source_reported_chip",
  "model_codes",
]);

const APPENDIX_B_TABLE: Record<string, { device: "iPhone" | "iPad"; code: string; page: string }> =
  {
    "MOB-001:REF-01": {
      device: "iPhone",
      code: "A2482",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-002:REF-01": {
      device: "iPhone",
      code: "A2481",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-003:REF-01": {
      device: "iPhone",
      code: "A2483",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-004:REF-01": {
      device: "iPhone",
      code: "A2484",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-005:REF-01": {
      device: "iPhone",
      code: "A2649",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-006:REF-01": {
      device: "iPhone",
      code: "A2632",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-007:REF-01": {
      device: "iPhone",
      code: "A2650",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-008:REF-01": {
      device: "iPhone",
      code: "A2651",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-009:REF-01": {
      device: "iPhone",
      code: "A2846",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-010:REF-01": {
      device: "iPhone",
      code: "A2847",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-011:REF-01": {
      device: "iPhone",
      code: "A2848",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-012:REF-01": {
      device: "iPhone",
      code: "A2849",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-013:REF-01": {
      device: "iPhone",
      code: "A3081",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-014:REF-01": {
      device: "iPhone",
      code: "A3082",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-015:REF-01": {
      device: "iPhone",
      code: "A3083",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-016:REF-01": {
      device: "iPhone",
      code: "A3084",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-017:REF-01": {
      device: "iPhone",
      code: "A3212",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-018:REF-01": {
      device: "iPhone",
      code: "A3258",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-019:REF-01": {
      device: "iPhone",
      code: "A3256",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-020:REF-01": {
      device: "iPhone",
      code: "A3257",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-021:REF-01": {
      device: "iPhone",
      code: "A3472",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-022:REF-01": {
      device: "iPhone",
      code: "A3473",
      page: "https://support.apple.com/en-us/108044",
    },
    "MOB-051:REF-01": {
      device: "iPad",
      code: "A3354",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-052:REF-01": {
      device: "iPad",
      code: "A2696",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-054:REF-01": {
      device: "iPad",
      code: "A2567",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-055:REF-01": {
      device: "iPad",
      code: "A2588",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-056:REF-01": {
      device: "iPad",
      code: "A2898",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-056:REF-02": {
      device: "iPad",
      code: "A2902",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-057:REF-01": {
      device: "iPad",
      code: "A3268",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-057:REF-02": {
      device: "iPad",
      code: "A3266",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-058:REF-01": {
      device: "iPad",
      code: "A3461",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-058:REF-02": {
      device: "iPad",
      code: "A3459",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-059:REF-01": {
      device: "iPad",
      code: "A2378",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-059:REF-02": {
      device: "iPad",
      code: "A2377",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-060:REF-01": {
      device: "iPad",
      code: "A2436",
      page: "https://support.apple.com/en-us/108043",
    },
    "MOB-060:REF-02": {
      device: "iPad",
      code: "A2759",
      page: "https://support.apple.com/en-us/108043",
    },
  };

function makeFamilySlug(name: string): string {
  let s = name.toLowerCase().replace(/\+/g, "-plus");
  s = s.replace(/[^a-z0-9]+/g, "-");
  return s.replace(/^-+|-+$/g, "");
}

function getSourceAlias(url: string): string {
  return "src-" + sha256Hex(url).slice(0, 16);
}

function mapPublisher(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "apple.com" || host.endsWith(".apple.com")) return "Apple";
    if (
      host === "samsung.com" ||
      host.endsWith(".samsung.com") ||
      host === "samsungmobile.com" ||
      host.endsWith(".samsungmobile.com") ||
      host === "samsungmobilepress.com" ||
      host.endsWith(".samsungmobilepress.com")
    )
      return "Samsung";
    if (host === "google.com" || host.endsWith(".google.com")) return "Google";
    return null;
  } catch {
    return null;
  }
}

function mapSourceMarket(url: string): { market: string; ruleId: string } | null {
  let m = url.match(/^https:\/\/news\.samsung\.com\/(global|[a-zA-Z]{2})\//);
  if (m) {
    const cc = m[1].toLowerCase();
    if (cc === "global") return { market: "GLOBAL", ruleId: "M1" };
    if (cc === "uk") return { market: "GB", ruleId: "M1" };
    return { market: cc.toUpperCase(), ruleId: "M1" };
  }
  if (/^https:\/\/(www\.)?samsungmobilepress\.com\//.test(url)) {
    return { market: "GLOBAL", ruleId: "M2" };
  }
  m = url.match(/^https:\/\/www\.samsung\.com\/([a-zA-Z]{2})\//);
  if (m) {
    return { market: m[1].toUpperCase(), ruleId: "M3" };
  }
  if (
    /^https:\/\/security\.samsungmobile\.com\//.test(url) ||
    /^https:\/\/support\.google\.com\//.test(url)
  ) {
    return { market: "UNSPECIFIED", ruleId: "M4" };
  }
  m = url.match(/^https:\/\/apps\.apple\.com\/([a-zA-Z]{2})\//);
  if (m) {
    return { market: m[1].toUpperCase(), ruleId: "M5" };
  }
  if (/^https:\/\/support\.apple\.com\/([a-zA-Z0-9_-]+\/)?guide\//.test(url)) {
    return { market: "UNSPECIFIED", ruleId: "M6" };
  }
  if (
    /^https:\/\/support\.apple\.com\/en-us\/[0-9]+/.test(url) ||
    /^https:\/\/support\.apple\.com\/[0-9]+/.test(url) ||
    /^https:\/\/support\.apple\.com\/kb\/SP[0-9]+/i.test(url)
  ) {
    return { market: "US", ruleId: "M7" };
  }
  return null;
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function convertMobileCohort(
  input: CohortInput,
  policy: Readonly<CohortPolicy> = COHORT_20261021_POLICY,
): CohortConversion {
  const refusals: CohortRefusal[] = [];
  const fileNames: CohortFileName[] = [
    "candidates.jsonl",
    "mobile-reference-bundle.jsonl",
    "observations.jsonl",
    "sources.json",
    "game-listing-observations.jsonl",
    "CORRECTED-OBSERVATIONS.jsonl",
    "QUARANTINE.jsonl",
    "SOURCE-REGISTER.json",
  ];

  for (const name of fileNames) {
    const buf = input.files[name];
    if (!buf) {
      refusals.push({ code: "input_hash_mismatch", detail: name });
      continue;
    }
    const hex = sha256Hex(buf);
    if (hex !== policy.pins[name]) {
      refusals.push({ code: "input_hash_mismatch", detail: name });
    }
  }

  const parseJsonLines = (
    filenameOrBuf: string | Buffer | undefined,
    bufOrFilename?: Buffer | string,
  ): any[] => {
    const filename =
      typeof filenameOrBuf === "string"
        ? filenameOrBuf
        : typeof bufOrFilename === "string"
          ? bufOrFilename
          : "unknown.jsonl";
    const buf =
      typeof filenameOrBuf !== "string"
        ? filenameOrBuf
        : typeof bufOrFilename !== "string"
          ? bufOrFilename
          : undefined;
    if (!buf) return [];
    const lines = buf.toString("utf8").split("\n");
    const records: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      const lineNum = i + 1;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          refusals.push({ code: "input_schema_drift", detail: `${filename}:${lineNum}` });
        } else {
          records.push(parsed);
        }
      } catch {
        refusals.push({ code: "input_schema_drift", detail: `${filename}:${lineNum}` });
      }
    }
    return records;
  };

  const rawCandidates = parseJsonLines("candidates.jsonl", input.files["candidates.jsonl"]);
  const rawReferences = parseJsonLines(
    "mobile-reference-bundle.jsonl",
    input.files["mobile-reference-bundle.jsonl"],
  );
  const rawObservations = parseJsonLines("observations.jsonl", input.files["observations.jsonl"]);
  const rawListings = parseJsonLines(
    "game-listing-observations.jsonl",
    input.files["game-listing-observations.jsonl"],
  );
  const rawCorrected = parseJsonLines(
    "CORRECTED-OBSERVATIONS.jsonl",
    input.files["CORRECTED-OBSERVATIONS.jsonl"],
  );
  const rawQuarantine = parseJsonLines("QUARANTINE.jsonl", input.files["QUARANTINE.jsonl"]);

  let rawSourcesJson: any = null;
  if (input.files["sources.json"]) {
    try {
      rawSourcesJson = JSON.parse(input.files["sources.json"].toString("utf8"));
      const isPlainObject =
        rawSourcesJson !== null &&
        typeof rawSourcesJson === "object" &&
        !Array.isArray(rawSourcesJson);
      let isValidSources = false;
      if (isPlainObject) {
        if ("sources" in rawSourcesJson) {
          if (Array.isArray(rawSourcesJson.sources)) {
            isValidSources = rawSourcesJson.sources.every(
              (item: any) => item !== null && typeof item === "object" && !Array.isArray(item),
            );
          } else if (
            rawSourcesJson.sources !== null &&
            typeof rawSourcesJson.sources === "object"
          ) {
            isValidSources = true;
          } else {
            isValidSources = false;
          }
        } else {
          isValidSources = true;
        }
      } else if (Array.isArray(rawSourcesJson)) {
        isValidSources = rawSourcesJson.every(
          (item: any) => item !== null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (!isValidSources) {
        refusals.push({ code: "input_schema_drift", detail: "sources.json" });
      }
    } catch {
      refusals.push({ code: "input_schema_drift", detail: "sources.json" });
    }
  }

  let rawSourceRegister: any = null;
  if (input.files["SOURCE-REGISTER.json"]) {
    try {
      rawSourceRegister = JSON.parse(input.files["SOURCE-REGISTER.json"].toString("utf8"));
      const isValidRegister =
        rawSourceRegister !== null &&
        typeof rawSourceRegister === "object" &&
        !Array.isArray(rawSourceRegister) &&
        rawSourceRegister.schema === "ai112-research-source-register/1" &&
        Array.isArray(rawSourceRegister.sources) &&
        rawSourceRegister.sources.every(
          (s: any) =>
            s !== null &&
            typeof s === "object" &&
            !Array.isArray(s) &&
            typeof (s.source_id || s.id) === "string" &&
            (s.source_id || s.id).length > 0 &&
            ((typeof (s.url || s.source_url) === "string" && (s.url || s.source_url).length > 0) ||
              (s.source_id === "RETAINED-RESEARCH" &&
                s.source_kind === "local_prior_research_not_primary" &&
                typeof s.path === "string" &&
                /^[a-f0-9]{64}$/.test(s.sha256))),
        );
      if (!isValidRegister) {
        refusals.push({ code: "input_schema_drift", detail: "SOURCE-REGISTER.json" });
      }
    } catch {
      refusals.push({ code: "input_schema_drift", detail: "SOURCE-REGISTER.json" });
    }
  }

  const sourcesCount = (() => {
    if (!rawSourcesJson) return 0;
    if (Array.isArray(rawSourcesJson)) return rawSourcesJson.length;
    if (typeof rawSourcesJson === "object") {
      if (Array.isArray(rawSourcesJson.sources)) return rawSourcesJson.sources.length;
      if (rawSourcesJson.sources && typeof rawSourcesJson.sources === "object") {
        return Object.keys(rawSourcesJson.sources).length;
      }
      return Object.keys(rawSourcesJson).length;
    }
    return 0;
  })();

  if (rawCandidates.length !== policy.inventory.candidates) {
    refusals.push({ code: "input_schema_drift", detail: "candidates.jsonl" });
  }
  if (rawReferences.length !== policy.inventory.references) {
    refusals.push({ code: "input_schema_drift", detail: "mobile-reference-bundle.jsonl" });
  }
  if (rawObservations.length !== policy.inventory.observations) {
    refusals.push({ code: "input_schema_drift", detail: "observations.jsonl" });
  }
  if (sourcesCount !== policy.inventory.sources) {
    refusals.push({ code: "input_schema_drift", detail: "sources.json" });
  }
  if (rawListings.length !== policy.inventory.listings) {
    refusals.push({ code: "input_schema_drift", detail: "game-listing-observations.jsonl" });
  }
  if (rawCorrected.length !== policy.inventory.corrected) {
    refusals.push({ code: "input_schema_drift", detail: "CORRECTED-OBSERVATIONS.jsonl" });
  }
  if (rawQuarantine.length !== policy.inventory.holds) {
    refusals.push({ code: "input_schema_drift", detail: "QUARANTINE.jsonl" });
  }

  const KNOWN_CORRECTION_KINDS = new Set([
    "model_code_identity",
    "additional_source_scoped_reference",
    "source_scope_correction",
    "connectivity_identity_check",
    "regional_soc_statement",
    "regional_alternatives",
    "unknown_field_preservation",
    "publisher_listing_attachment",
  ]);

  for (const row of rawCorrected) {
    const rowId = row?.correction_id || row?.row_id || row?.id || "CORRECTED-OBSERVATIONS.jsonl";
    if (
      !row ||
      typeof row !== "object" ||
      !row.record_kind ||
      !KNOWN_CORRECTION_KINDS.has(row.record_kind)
    ) {
      refusals.push({ code: "input_schema_drift", detail: `${rowId}` });
    }
  }

  const observationFields = new Set([
    "compatible_os",
    "display_refresh_hz",
    "os_and_security_update_policy_years",
    "os_family_mapping_requires_specs",
    "ram_storage_options_gb",
    "screen_diagonal_inches",
    "security_update_cadence",
    "us_reference_device_label",
    "usb_data_version",
    "qualification",
  ]);
  for (const row of rawObservations) {
    if (!observationFields.has(row.field))
      refusals.push({ code: "input_schema_drift", detail: row.observation_id });
  }
  const correctionFields: Record<string, string> = {
    model_code_identity: "hardware_model_code",
    source_scope_correction: "source_market",
    regional_alternatives: "source_reported_soc_alternatives",
    regional_soc_statement: "soc_name",
    connectivity_identity_check: "hardware_model_code",
    unknown_field_preservation: "ram_gb",
  };
  for (const row of [...rawCorrected, ...rawQuarantine]) {
    const id = row.observation_id || row.quarantine_id;
    if (row.schema !== undefined && row.schema !== "ai112-research-preconversion/1")
      refusals.push({ code: "input_schema_drift", detail: id });
    if (
      row.field !== undefined &&
      correctionFields[row.record_kind] &&
      correctionFields[row.record_kind] !== row.field
    )
      refusals.push({ code: "input_schema_drift", detail: id });
  }
  for (const [rows, key, filename] of [
    [rawCandidates, "candidate_id", "candidates.jsonl"],
    [rawReferences, "reference_id", "mobile-reference-bundle.jsonl"],
    [rawCorrected, "observation_id", "CORRECTED-OBSERVATIONS.jsonl"],
    [rawQuarantine, "quarantine_id", "QUARANTINE.jsonl"],
    [rawObservations, "observation_id", "observations.jsonl"],
  ] as const) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (typeof row[key] !== "string" || !row[key] || ids.has(row[key]))
        refusals.push({ code: "input_schema_drift", detail: filename });
      ids.add(row[key]);
    }
  }
  for (const row of rawCandidates) {
    if (
      !["Apple", "Samsung", "Google"].includes(row.manufacturer) ||
      !["phone", "tablet"].includes(row.device_kind) ||
      typeof row.candidate_name !== "string"
    )
      refusals.push({ code: "input_schema_drift", detail: row.candidate_id });
  }

  for (const ref of rawReferences) {
    if (ref.specification && typeof ref.specification === "object") {
      for (const k of Object.keys(ref.specification)) {
        if (!KNOWN_SPEC_KEYS.has(k)) {
          refusals.push({ code: "input_schema_drift", detail: `${ref.reference_id}: ${k}` });
        }
      }
    }
  }

  if (refusals.length > 0) {
    throw new MobileCohortConversionError(refusals);
  }

  const stagedJoinIds = new Set<string>();
  const stagedJoinConnectivity = new Map<string, string>();
  const contradictedJoinIds = new Set<string>();
  let joinCheckedOn: string | null = null;
  let joinManifestInfo: any = null;

  if (input.joinVerification) {
    const jv = input.joinVerification;
    const jvHash = sha256Hex(jv.bytes);
    if (jvHash !== jv.expectedSha256) {
      refusals.push({ code: "join_verification_invalid", detail: "JV-1: hash mismatch" });
    }
    let parsedJv: any = null;
    try {
      parsedJv = JSON.parse(jv.bytes.toString("utf8"));
    } catch {
      refusals.push({ code: "join_verification_invalid", detail: "JV-2: parse error" });
    }

    if (parsedJv === null || typeof parsedJv !== "object" || Array.isArray(parsedJv)) {
      refusals.push({ code: "join_verification_invalid", detail: "JV-2: object required" });
    } else {
      if (
        parsedJv.schema !== JOIN_VERIFICATION_SCHEMA ||
        typeof parsedJv.checked_on !== "string" ||
        typeof parsedJv.prepared_by_lane !== "string" ||
        !Array.isArray(parsedJv.entries) ||
        Object.keys(parsedJv).length !== 4
      ) {
        refusals.push({ code: "join_verification_invalid", detail: "JV-2: schema/members" });
      } else if (parsedJv.prepared_by_lane.length < 1 || parsedJv.prepared_by_lane.length > 80) {
        refusals.push({ code: "join_verification_invalid", detail: "JV-2: lane length" });
      } else if (parsedJv.entries.length === 0) {
        refusals.push({ code: "join_verification_invalid", detail: "JV-3: empty entries" });
      } else {
        joinCheckedOn = parsedJv.checked_on;
        if (
          !validCalendarDate(parsedJv.checked_on) ||
          !validCalendarDate(jv.runDate) ||
          parsedJv.checked_on < "2026-10-21" ||
          parsedJv.checked_on > jv.runDate
        ) {
          refusals.push({ code: "join_verification_invalid", detail: "JV-6: checked_on bounds" });
        }

        const seenRefs = new Set<string>();
        for (const entry of parsedJv.entries) {
          if (
            !entry ||
            typeof entry.reference_id !== "string" ||
            typeof entry.model_code !== "string" ||
            typeof entry.device_name_on_source !== "string" ||
            typeof entry.connectivity_on_source !== "string" ||
            typeof entry.source_url !== "string" ||
            typeof entry.result !== "string" ||
            Object.keys(entry).length !== 6
          ) {
            refusals.push({ code: "join_verification_invalid", detail: "JV-2: entry structure" });
            break;
          }
          if (entry.device_name_on_source.length < 1 || entry.device_name_on_source.length > 80) {
            refusals.push({
              code: "join_verification_invalid",
              detail: "JV-2: device name length",
            });
          }
          if (seenRefs.has(entry.reference_id)) {
            refusals.push({
              code: "join_verification_invalid",
              detail: `JV-3: duplicate ${entry.reference_id}`,
            });
          }
          seenRefs.add(entry.reference_id);

          const exp = APPENDIX_B_TABLE[entry.reference_id];
          if (!exp) {
            refusals.push({
              code: "join_verification_invalid",
              detail: `JV-4: reference not in Appendix B: ${entry.reference_id}`,
            });
            continue;
          }
          if (entry.model_code !== exp.code || entry.source_url !== exp.page) {
            refusals.push({
              code: "join_verification_invalid",
              detail: `JV-5: code/url mismatch for ${entry.reference_id}`,
            });
          }
          if (exp.device === "iPhone" && entry.connectivity_on_source !== "not_stated") {
            refusals.push({
              code: "join_verification_invalid",
              detail: `JV-7: iPhone connectivity must be not_stated: ${entry.reference_id}`,
            });
          }

          if (!["matches", "differs", "not_found"].includes(entry.result)) {
            refusals.push({
              code: "join_verification_invalid",
              detail: `JV-2: result enum: ${entry.result}`,
            });
          }
          if (!["wifi", "wifi_cellular", "not_stated"].includes(entry.connectivity_on_source)) {
            refusals.push({
              code: "join_verification_invalid",
              detail: `JV-2: connectivity enum: ${entry.connectivity_on_source}`,
            });
          }

          if (refusals.length === 0) {
            if (exp.device === "iPhone") {
              if (entry.result === "matches") stagedJoinIds.add(entry.reference_id);
              else contradictedJoinIds.add(entry.reference_id);
            } else {
              if (entry.result === "matches") {
                if (
                  entry.connectivity_on_source === "wifi" ||
                  entry.connectivity_on_source === "not_stated"
                ) {
                  stagedJoinIds.add(entry.reference_id);
                  stagedJoinConnectivity.set(
                    entry.reference_id,
                    entry.connectivity_on_source === "wifi" ? "wifi" : "unknown",
                  );
                } else {
                  contradictedJoinIds.add(entry.reference_id);
                }
              } else {
                contradictedJoinIds.add(entry.reference_id);
              }
            }
          }
        }
      }
    }

    if (refusals.length === 0 && parsedJv) {
      joinManifestInfo = {
        sha256: jvHash,
        bytes: jv.bytes.length,
        run_date: jv.runDate,
        checked_on: parsedJv.checked_on,
        staged: Array.from(stagedJoinIds).sort(),
        contradicted: Array.from(contradictedJoinIds).sort(),
      };
    }
  }

  const candidateMap = new Map<string, any>();
  const familyKeyMap = new Map<string, string>();
  for (const c of rawCandidates) {
    candidateMap.set(c.candidate_id, c);
    const fk = `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}`;
    if (familyKeyMap.has(fk) && familyKeyMap.get(fk) !== c.candidate_id) {
      refusals.push({ code: "family_key_collision", detail: fk });
    }
    familyKeyMap.set(fk, c.candidate_id);
  }

  const emittedRecords: any[] = [];
  const lineExtractions: { contributing: string[]; extraction: string }[] = [];
  const dispositions: any[] = [];
  const citedUrls = new Set<string>();

  const addRecord = (rec: any, contributing: string[], extraction: string) => {
    if (rec.record_type === "observation") {
      const url = Array.from(citedUrls).find((value) => getSourceAlias(value) === rec.source_ref);
      const scope = url ? mapSourceMarket(url) : null;
      if (scope) rec.market = scope.market;
      if (rec.value_state === "not_stated_by_source") rec.is_exhaustive = null;
    }
    const duplicate = emittedRecords.findIndex(
      (record) => canonicalJson(record) === canonicalJson(rec),
    );
    if (duplicate >= 0) {
      const meta = lineExtractions[duplicate];
      meta.contributing = Array.from(new Set([...meta.contributing, ...contributing])).sort();
      if (extraction === "fresh_primary_named_field") meta.extraction = extraction;
      return;
    }
    emittedRecords.push(rec);
    lineExtractions.push({ contributing, extraction });
    if (rec.url) citedUrls.add(rec.url);
    if (rec.basis_source_ref) {
      // alias will be resolved from cited URLs
    }
  };

  const candidateMinRefUrl = new Map<string, string>();
  for (const ref of [...rawReferences].sort((a, b) =>
    a.reference_id < b.reference_id ? -1 : a.reference_id > b.reference_id ? 1 : 0,
  )) {
    const cid = ref.candidate_id;
    if (!candidateMinRefUrl.has(cid)) {
      candidateMinRefUrl.set(cid, ref.specification_source_url);
    }
  }

  const correctedSourceUrl = (row: any): string | undefined => {
    const source = rawSourceRegister?.sources.find((entry: any) =>
      row.source_ids?.includes(entry.source_id),
    );
    if (source?.url) return source.url;
    const reference =
      rawReferences.find((entry) => row.original_reference_id === entry.reference_id) ||
      rawReferences.find(
        (entry) =>
          entry.candidate_id === row.candidate_id &&
          mapSourceMarket(entry.specification_source_url)?.market === row.market,
      ) ||
      rawReferences.find((entry) => entry.candidate_id === row.candidate_id);
    return reference?.specification_source_url;
  };
  for (const row of [...rawCorrected, ...rawQuarantine, ...rawObservations]) {
    if (row.candidate_id && !candidateMap.has(row.candidate_id))
      refusals.push({ code: "unknown_reference", detail: row.observation_id || row.quarantine_id });
    if (
      row.original_reference_id &&
      !rawReferences.some((ref) => ref.reference_id === row.original_reference_id)
    )
      refusals.push({ code: "unknown_reference", detail: row.observation_id || row.quarantine_id });
    if (row.record_kind === "source_scope_correction") {
      const url = correctedSourceUrl(row);
      if (!url || mapSourceMarket(url)?.market !== (row.value ?? row.market))
        refusals.push({ code: "scope_correction_disagrees", detail: row.observation_id });
    }
    if (row.record_kind === "regional_soc_statement") {
      const url = correctedSourceUrl(row);
      const inherited = rawReferences.find(
        (ref) => ref.candidate_id === row.candidate_id && ref.specification_source_url === url,
      );
      if (inherited?.specification?.chip != null && inherited.specification.chip !== row.value)
        refusals.push({ code: "inherited_correction_disagrees", detail: row.observation_id });
    }
  }

  for (const c of rawCandidates) {
    const fk = `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}`;
    const specUrl =
      candidateMinRefUrl.get(c.candidate_id) || "https://support.apple.com/en-us/108044";
    citedUrls.add(specUrl);
    const basisAlias = getSourceAlias(specUrl);
    let osFamily = "android";
    if (c.manufacturer.toLowerCase() === "apple") {
      osFamily = c.device_kind === "tablet" ? "ipados" : "ios";
    }
    addRecord(
      {
        record_type: "family",
        family_key: fk,
        manufacturer: c.manufacturer,
        device_class: c.device_kind === "tablet" ? "Tablet" : "Phone",
        os_family: osFamily,
        marketing_name: c.candidate_name,
        research_ref: c.candidate_id,
        basis_source_ref: basisAlias,
      },
      [c.candidate_id],
      "derived",
    );

    dispositions.push({
      id: c.candidate_id,
      disposition: "staged",
      output_lines: [],
      reason: "Family staged from candidate definition",
    });
  }

  const stagedRefKeys = new Map<string, string>();
  const refByOriginalId = new Map<string, any>();

  const emitReference = (
    refKey: string,
    familyKey: string,
    label: string,
    connectivity: string,
    modelCode: string | null,
    scopeMarket: string | null,
    modelCodeSourceRef: string | null,
    modelCodeObservedOn: string | null,
    basisSourceRef: string,
    contributing: string[],
    extraction: string,
  ) => {
    if (stagedRefKeys.has(refKey)) {
      refusals.push({ code: "reference_key_collision", detail: refKey });
    }
    stagedRefKeys.set(refKey, label);
    const researchRef =
      rawCorrected.find((row) => row.observation_id === contributing[0])?.research_identity_id ||
      contributing[0];
    addRecord(
      {
        record_type: "reference",
        reference_key: refKey,
        family_key: familyKey,
        reference_label: label,
        research_ref: researchRef,
        connectivity,
        model_code: modelCode,
        scope_market: scopeMarket,
        model_code_source_ref: modelCodeSourceRef,
        model_code_observed_on: modelCodeObservedOn,
        basis_source_ref: basisSourceRef,
      },
      Array.from(
        new Set([
          ...contributing,
          researchRef,
          ...rawCorrected
            .filter(
              (row) =>
                ["source_scope_correction", "connectivity_identity_check"].includes(
                  row.record_kind,
                ) && row.original_reference_id === contributing[0],
            )
            .map((row) => row.observation_id),
        ]),
      ),
      extraction,
    );
  };

  const verifiedRRefWifi = new Map<string, { code: string; conn: string }>([
    ["MOB-062:REF-01", { code: "A3357", conn: "wifi" }],
    ["MOB-062:REF-02", { code: "A3360", conn: "wifi" }],
    ["MOB-061:REF-01", { code: "A2925", conn: "wifi" }],
    ["MOB-061:REF-02", { code: "A2836", conn: "wifi" }],
    ["MOB-053:REF-01", { code: "A2993", conn: "unknown" }],
  ]);

  for (const ref of rawReferences) {
    refByOriginalId.set(ref.reference_id, ref);
    const c = candidateMap.get(ref.candidate_id);
    if (!c) {
      refusals.push({ code: "unknown_reference", detail: ref.reference_id });
      continue;
    }
    const fk = `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}`;
    citedUrls.add(ref.specification_source_url);
    const basisAlias = getSourceAlias(ref.specification_source_url);

    if (c.manufacturer.toLowerCase() === "google") {
      dispositions.push({
        id: ref.reference_id,
        disposition: "replaced_by_code_identities",
        output_lines: [],
        reason: "Pixel placeholder reference replaced by code identities R0001-R0023",
      });
      continue;
    }

    if (c.manufacturer.toLowerCase() === "samsung") {
      const specM = mapSourceMarket(ref.specification_source_url);
      const market = specM ? specM.market : "UNSPECIFIED";
      let conn = "unknown";
      if (c.device_kind === "phone") {
        const lbl = (ref.specification?.reference_label || ref.reference_label || "").toUpperCase();
        if (lbl.includes("5G")) conn = "cellular_5g";
        else if (lbl.includes("LTE")) conn = "cellular_4g";
      }
      const connSlug = conn.replace(/_/g, "-");
      const refKey = `${fk}:${market.toLowerCase()}-${connSlug}`;
      const label = ref.specification?.reference_label || ref.reference_label;
      emitReference(
        refKey,
        fk,
        label,
        conn,
        null,
        market,
        null,
        null,
        basisAlias,
        [ref.reference_id],
        "inherited_unverified",
      );

      dispositions.push({
        id: ref.reference_id,
        disposition: "staged",
        output_lines: [],
        reason: "Samsung reference staged with source scope",
      });

      if (Array.isArray(ref.specification?.ram_storage_options_gb)) {
        for (const pair of ref.specification.ram_storage_options_gb) {
          if (Array.isArray(pair) && pair.length >= 2) {
            addRecord(
              {
                record_type: "variant",
                reference_key: refKey,
                ram_gb: pair[0],
                storage_gb: pair[1],
                retail_sku_code: null,
                basis_source_ref: basisAlias,
                observed_on: "2026-10-21",
              },
              [ref.reference_id],
              "inherited_unverified",
            );
          }
        }
      }
      continue;
    }

    if (c.manufacturer.toLowerCase() === "apple") {
      const rVer = verifiedRRefWifi.get(ref.reference_id);
      const isOptionalStaged = stagedJoinIds.has(ref.reference_id);
      const isOptionalContradicted = contradictedJoinIds.has(ref.reference_id);

      if (rVer || isOptionalStaged) {
        const code = rVer
          ? rVer.code
          : APPENDIX_B_TABLE[ref.reference_id]?.code || ref.hardware_model_code;
        let conn = rVer ? rVer.conn : "unknown";
        if (isOptionalStaged && !rVer) {
          const info = APPENDIX_B_TABLE[ref.reference_id];
          if (info && info.device === "iPad") {
            conn = stagedJoinConnectivity.get(ref.reference_id) || "unknown";
          } else {
            conn = "unknown";
          }
        }
        const refKey = `${fk}:${code.toLowerCase()}`;
        const idUrl =
          c.device_kind === "tablet"
            ? "https://support.apple.com/en-us/108043"
            : "https://support.apple.com/en-us/108044";
        citedUrls.add(idUrl);
        const idAlias = getSourceAlias(idUrl);
        const obsOn = isOptionalStaged && !rVer && joinCheckedOn ? joinCheckedOn : "2026-10-21";
        const ext = rVer ? "spot_checked_identity" : "join_verification_record";

        emitReference(
          refKey,
          fk,
          ref.reference_label,
          conn,
          code,
          null,
          idAlias,
          obsOn,
          basisAlias,
          [ref.reference_id],
          ext,
        );

        dispositions.push({
          id: ref.reference_id,
          disposition: "staged",
          output_lines: [],
          reason: rVer
            ? "Verified by research R-row check"
            : "Verified by optional join verification record",
        });
      } else if (isOptionalContradicted) {
        dispositions.push({
          id: ref.reference_id,
          disposition: "held_join_contradicted",
          output_lines: [],
          reason: "Join verification record contradicted reference identity",
        });
      } else {
        dispositions.push({
          id: ref.reference_id,
          disposition: "held_join_unverified",
          output_lines: [],
          reason: "Apple model-code join unverified; held by default",
        });
      }
    }
  }

  const codeMarketSightings: any[] = [];
  for (const row of rawCorrected) {
    if (row.record_kind === "model_code_identity") {
      const c = candidateMap.get(row.candidate_id);
      if (!c) continue;
      const fk = `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}`;
      const code = row.value;
      const refKey = `${fk}:${code.toLowerCase()}`;
      const specUrl = "https://support.google.com/pixelphone/answer/7158570?hl=en";
      citedUrls.add(specUrl);
      const alias = getSourceAlias(specUrl);
      const lbl = `${c.candidate_name} (${code})`;

      emitReference(
        refKey,
        fk,
        lbl,
        "cellular_5g",
        code,
        null,
        alias,
        "2026-10-21",
        alias,
        [row.observation_id],
        "fresh_primary_named_field",
      );

      codeMarketSightings.push({
        family_key: fk,
        model_code: code,
        research_id: row.research_identity_id || `${row.candidate_id}:MODEL-${code}`,
        source_scope_label: row.source_scope_label ?? null,
        explicit_markets: row.explicit_markets ?? null,
        market_set_exhaustive: Boolean(row.market_set_exhaustive),
        radio_label: row.radio_scope || "5G Sub 6GHz",
        source_alias: alias,
      });

      dispositions.push({
        id: row.observation_id,
        disposition: "staged",
        output_lines: [],
        reason: "Pixel model code identity staged",
      });
    } else if (row.record_kind === "additional_source_scoped_reference") {
      const c = candidateMap.get(row.candidate_id);
      if (!c) continue;
      const fk = `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}`;
      const refKey = `${fk}:us-cellular-5g`;
      const specUrl = correctedSourceUrl(row);
      if (!specUrl) {
        refusals.push({ code: "unknown_reference", detail: row.observation_id });
        continue;
      }
      citedUrls.add(specUrl);
      const alias = getSourceAlias(specUrl);
      const originalObservationIds = (field: string) =>
        rawObservations
          .filter(
            (observation) =>
              row.input_observation_ids?.includes(observation.observation_id) &&
              observation.field === field,
          )
          .map((observation) => observation.observation_id);
      emitReference(
        refKey,
        fk,
        row.reference_label,
        "cellular_5g",
        null,
        "US",
        null,
        null,
        alias,
        [row.observation_id],
        "fresh_primary_named_field",
      );

      if (row.observed_fields?.screen_diagonal_in) {
        addRecord(
          {
            record_type: "observation",
            subject_level: "reference",
            subject_key: refKey,
            field: "screen_diagonal_in",
            value_state: "stated",
            value: row.observed_fields.screen_diagonal_in.value,
            unit: "in",
            market: "US",
            scope_qualifier: "none",
            source_ref: alias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [row.observation_id, ...originalObservationIds("screen_diagonal_inches")],
          "fresh_primary_named_field",
        );
      }
      if (row.observed_fields?.display_refresh_max_hz) {
        addRecord(
          {
            record_type: "observation",
            subject_level: "reference",
            subject_key: refKey,
            field: "display_refresh_max_hz",
            value_state: "stated",
            value: row.observed_fields.display_refresh_max_hz.value,
            unit: "Hz",
            market: "US",
            scope_qualifier: "none",
            source_ref: alias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [row.observation_id, ...originalObservationIds("display_refresh_hz")],
          "fresh_primary_named_field",
        );
      }
      if (Array.isArray(row.observed_fields?.ram_storage_configurations?.value)) {
        for (const cfg of row.observed_fields.ram_storage_configurations.value) {
          addRecord(
            {
              record_type: "variant",
              reference_key: refKey,
              ram_gb: cfg.physical_ram_gb,
              storage_gb: cfg.storage_gb,
              retail_sku_code: null,
              basis_source_ref: alias,
              observed_on: "2026-10-21",
            },
            [row.observation_id, ...originalObservationIds("ram_storage_options_gb")],
            "fresh_primary_named_field",
          );
        }
      }

      dispositions.push({
        id: row.observation_id,
        disposition: "staged",
        output_lines: [],
        reason: "US research reference staged",
      });
    }
  }

  for (const ref of rawReferences) {
    const c = candidateMap.get(ref.candidate_id);
    if (!c) continue;
    const fk = `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}`;
    citedUrls.add(ref.specification_source_url);
    const specAlias = getSourceAlias(ref.specification_source_url);
    const specM = mapSourceMarket(ref.specification_source_url);
    const mkt = specM ? specM.market : "UNSPECIFIED";

    if (c.manufacturer.toLowerCase() === "google") {
      if (ref.specification?.chip) {
        addRecord(
          {
            record_type: "observation",
            subject_level: "family",
            subject_key: fk,
            field: "soc_name",
            value_state: "stated",
            value: ref.specification.chip,
            unit: null,
            market: mkt,
            scope_qualifier: "none",
            source_ref: specAlias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [ref.reference_id],
          "inherited_unverified",
        );
      }
      if (ref.specification?.ram_gb) {
        addRecord(
          {
            record_type: "observation",
            subject_level: "family",
            subject_key: fk,
            field: "ram_gb",
            value_state: "stated",
            value: ref.specification.ram_gb,
            unit: "GB",
            market: mkt,
            scope_qualifier: "none",
            source_ref: specAlias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [ref.reference_id],
          "inherited_unverified",
        );
      }
      continue;
    }

    let targetRefKey: string | null = null;
    if (c.manufacturer.toLowerCase() === "samsung") {
      let conn = "unknown";
      if (c.device_kind === "phone") {
        const lbl = (ref.specification?.reference_label || ref.reference_label || "").toUpperCase();
        if (lbl.includes("5G")) conn = "cellular_5g";
        else if (lbl.includes("LTE")) conn = "cellular_4g";
      }
      targetRefKey = `${fk}:${mkt.toLowerCase()}-${conn.replace(/_/g, "-")}`;
    } else if (c.manufacturer.toLowerCase() === "apple") {
      const rVer = verifiedRRefWifi.get(ref.reference_id);
      const isOptionalStaged = stagedJoinIds.has(ref.reference_id);
      if (rVer || isOptionalStaged) {
        const code = rVer
          ? rVer.code
          : APPENDIX_B_TABLE[ref.reference_id]?.code || ref.hardware_model_code;
        targetRefKey = `${fk}:${code.toLowerCase()}`;
      }
    }

    if (!targetRefKey) continue;

    const spec = ref.specification || {};
    if (
      spec.chip &&
      !["MOB-032:REF-01", "MOB-033:REF-01", "MOB-042:REF-01"].includes(ref.reference_id)
    ) {
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "soc_name",
          value_state: "stated",
          value: spec.chip,
          unit: null,
          market: mkt,
          scope_qualifier: "none",
          source_ref: specAlias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [ref.reference_id],
        "inherited_unverified",
      );
    }
    if (spec.gpu_cores !== null && spec.gpu_cores !== undefined) {
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "gpu_core_count",
          value_state: "stated",
          value: spec.gpu_cores,
          unit: "cores",
          market: mkt,
          scope_qualifier: "none",
          source_ref: specAlias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [ref.reference_id],
        "inherited_unverified",
      );
    }
    if (spec.screen_diagonal_inches !== null && spec.screen_diagonal_inches !== undefined) {
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "screen_diagonal_in",
          value_state: "stated",
          value: spec.screen_diagonal_inches,
          unit: "in",
          market: mkt,
          scope_qualifier: "none",
          source_ref: specAlias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [ref.reference_id],
        "inherited_unverified",
      );
    }
    if (spec.display_resolution_pixels !== null && spec.display_resolution_pixels !== undefined) {
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "display_resolution_px",
          value_state: "stated",
          value: spec.display_resolution_pixels,
          unit: "px",
          is_exhaustive: 1,
          market: mkt,
          scope_qualifier: "none",
          source_ref: specAlias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [ref.reference_id],
        "inherited_unverified",
      );
    }
    const refMax = spec.display_refresh_max_hz ?? spec.adaptive_refresh_max_hz;
    if (refMax !== null && refMax !== undefined) {
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "display_refresh_max_hz",
          value_state: "stated",
          value: refMax,
          unit: "Hz",
          market: mkt,
          scope_qualifier: "none",
          source_ref: specAlias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [ref.reference_id],
        "inherited_unverified",
      );
    }
    if (Array.isArray(spec.ram_options_gb)) {
      if (spec.ram_options_gb.length > 0) {
        addRecord(
          {
            record_type: "observation",
            subject_level: "reference",
            subject_key: targetRefKey,
            field: "ram_options_gb",
            value_state: "stated",
            value: spec.ram_options_gb,
            unit: "GB",
            is_exhaustive: 0,
            market: mkt,
            scope_qualifier: "none",
            source_ref: specAlias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [ref.reference_id],
          "inherited_unverified",
        );
      } else {
        addRecord(
          {
            record_type: "observation",
            subject_level: "reference",
            subject_key: targetRefKey,
            field: "ram_options_gb",
            value_state: "not_stated_by_source",
            value: null,
            unit: "GB",
            is_exhaustive: null,
            market: mkt,
            scope_qualifier: "none",
            source_ref: specAlias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [ref.reference_id],
          "inherited_unverified",
        );
      }
    }
  }

  for (const row of rawCorrected) {
    const cid = row.candidate_id;
    const c = candidateMap.get(cid);
    const fk = c ? `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}` : "";

    if (row.record_kind === "source_scope_correction") {
      dispositions.push({
        id: row.observation_id,
        disposition: "applied_to_identity",
        output_lines: [],
        reason: "Scope correction verified against source URL",
      });
    } else if (row.record_kind === "connectivity_identity_check") {
      dispositions.push({
        id: row.observation_id,
        disposition: "applied_to_identity",
        output_lines: [],
        reason: "Connectivity checked against iPad identification source",
      });
    } else if (row.record_kind === "regional_soc_statement") {
      const mkt = row.market;
      const refKey = `${fk}:${mkt.toLowerCase()}-cellular-5g`;
      const specUrl = correctedSourceUrl(row);
      if (!specUrl) {
        refusals.push({ code: "unknown_reference", detail: row.observation_id });
        continue;
      }
      citedUrls.add(specUrl);
      const alias = getSourceAlias(specUrl);

      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: refKey,
          field: "soc_name",
          value_state: "stated",
          value: row.value,
          unit: null,
          market: mkt,
          scope_qualifier: "none",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [row.observation_id],
        "fresh_primary_named_field",
      );

      dispositions.push({
        id: row.observation_id,
        disposition: "staged",
        output_lines: [],
        reason: "Regional SoC statement staged",
      });
    } else if (row.record_kind === "regional_alternatives") {
      dispositions.push({
        id: row.observation_id,
        disposition: "not_imported_not_assignable",
        output_lines: [],
        reason: "Regional alternatives list has no contract representation (F-8)",
      });
    } else if (row.record_kind === "unknown_field_preservation") {
      const origRef = row.original_reference_id;
      const rVer = verifiedRRefWifi.get(origRef);
      const isOpt = stagedJoinIds.has(origRef);
      if (
        (rVer || isOpt) &&
        Object.prototype.hasOwnProperty.call(
          refByOriginalId.get(origRef)?.specification || {},
          "ram_gb",
        )
      ) {
        const code = rVer ? rVer.code : APPENDIX_B_TABLE[origRef]?.code || "";
        const targetRefKey = `${fk}:${code.toLowerCase()}`;
        const specUrl =
          refByOriginalId.get(origRef)?.specification_source_url ||
          "https://support.apple.com/en-us/108044";
        citedUrls.add(specUrl);
        const alias = getSourceAlias(specUrl);

        addRecord(
          {
            record_type: "observation",
            subject_level: "reference",
            subject_key: targetRefKey,
            field: "ram_gb",
            value_state: "not_stated_by_source",
            value: null,
            unit: "GB",
            market: "US",
            scope_qualifier: "none",
            source_ref: alias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [row.observation_id],
          "inherited_unverified",
        );

        dispositions.push({
          id: row.observation_id,
          disposition: "staged",
          output_lines: [],
          reason: "RAM unknown preserved as not_stated_by_source",
        });
      } else {
        dispositions.push({
          id: row.observation_id,
          disposition: rVer || isOpt ? "preserved_unknown_no_record" : "held_reference_not_staged",
          output_lines: [],
          reason:
            rVer || isOpt
              ? "Unknown retained without adding a second RAM representation"
              : "Unknown preserved but reference is held",
        });
      }
    } else if (row.record_kind === "publisher_listing_attachment") {
      const origRef = row.original_reference_id;
      const rVer = verifiedRRefWifi.get(origRef);
      const isOpt = stagedJoinIds.has(origRef);
      if (rVer || isOpt) {
        const code = rVer ? rVer.code : APPENDIX_B_TABLE[origRef]?.code || row.hardware_model_code;
        const targetRefKey = `${fk}:${code.toLowerCase()}`;
        const appUrl = "https://apps.apple.com/us/app/resident-evil-4/id6462360082";
        citedUrls.add(appUrl);
        const alias = getSourceAlias(appUrl);

        let reqOs = row.required_os;
        const osMatch = reqOs?.match(/^(iOS|iPadOS) [0-9]+(\.[0-9]+)?/);
        if (!osMatch) {
          refusals.push({
            code: "required_os_unparsed",
            detail: `${row.observation_id}: ${reqOs}`,
          });
        } else {
          reqOs = osMatch[0];
        }

        addRecord(
          {
            record_type: "listing",
            reference_key: targetRefKey,
            store: "apple_app_store",
            store_country: "US",
            store_app_id: row.store_app_id,
            game_title: row.game,
            evidence_kind: "publisher_listed",
            match_basis: "publisher_device_name",
            listed_name: row.publisher_device_label,
            required_os: reqOs,
            source_ref: alias,
            observed_on: "2026-10-21",
          },
          [row.observation_id],
          "fresh_primary_named_field",
        );

        dispositions.push({
          id: row.observation_id,
          disposition: "staged",
          output_lines: [],
          reason: "Publisher listing staged for verified reference",
        });
      } else {
        dispositions.push({
          id: row.observation_id,
          disposition: "held_reference_not_staged",
          output_lines: [],
          reason: "Listing reverified but reference is held",
        });
      }
    }
  }

  for (const q of rawQuarantine) {
    const cid = q.candidate_id;
    const c = candidateMap.get(cid);
    const fk = c ? `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}` : "";

    if (["AI112-Q0002", "AI112-Q0004"].includes(q.quarantine_id)) {
      const targetRefKey = `${fk}:us-unknown`;
      const specUrl = "https://www.samsung.com/us/smartphones/galaxy-s26/";
      citedUrls.add(specUrl);
      const alias = getSourceAlias(specUrl);
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "soc_name",
          value_state: "stated",
          value: q.value,
          unit: null,
          market: "US",
          scope_qualifier: "none",
          declared_quarantine: "regional_assignment_unresolved",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [q.quarantine_id],
        "inherited_unverified",
      );

      dispositions.push({
        id: q.quarantine_id,
        disposition: "staged_quarantined_declared",
        output_lines: [],
        reason: "Staged with declared quarantine regional_assignment_unresolved",
      });
    } else if (["AI112-Q0003", "AI112-Q0005"].includes(q.quarantine_id)) {
      const targetRefKey = `${fk}:us-unknown`;
      const specUrl = correctedSourceUrl(q);
      if (!specUrl) {
        refusals.push({ code: "unknown_reference", detail: q.quarantine_id });
        continue;
      }
      citedUrls.add(specUrl);
      const alias = getSourceAlias(specUrl);
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "soc_name",
          value_state: "stated",
          value: q.value,
          unit: null,
          market: "US",
          scope_qualifier: "none",
          declared_quarantine: "research_declared_unresolved",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [q.quarantine_id],
        "fresh_primary_named_field",
      );

      dispositions.push({
        id: q.quarantine_id,
        disposition: "staged_quarantined_declared",
        output_lines: [],
        reason: "Staged with declared quarantine research_declared_unresolved",
      });
    } else if (["AI112-Q0006", "AI112-Q0007"].includes(q.quarantine_id)) {
      const targetRefKey = `${fk}:global-cellular-5g`;
      const specUrl =
        q.quarantine_id === "AI112-Q0006"
          ? "https://samsungmobilepress.com/articles/samsung-marks-a-step-forward-with-ai-for-everyone-by-introducing-new-galaxy-a56-5g-galaxy-a36-5g-and-galaxy-a26-5g"
          : "https://news.samsung.com/za/experience-awesome-intelligence-with-the-galaxy-a36-and-a56";
      citedUrls.add(specUrl);
      const alias = getSourceAlias(specUrl);
      const mkt = q.quarantine_id === "AI112-Q0006" ? "GLOBAL" : "ZA";
      addRecord(
        {
          record_type: "observation",
          subject_level: "reference",
          subject_key: targetRefKey,
          field: "soc_name",
          value_state: "stated",
          value: q.value,
          unit: null,
          market: mkt,
          scope_qualifier: "none",
          declared_quarantine: "research_declared_unresolved",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [q.quarantine_id],
        "fresh_primary_named_field",
      );

      dispositions.push({
        id: q.quarantine_id,
        disposition: "staged_quarantined_declared",
        output_lines: [],
        reason: "Staged with declared quarantine research_declared_unresolved",
      });
    } else if (["AI112-Q0013", "AI112-Q0014", "AI112-Q0015"].includes(q.quarantine_id)) {
      const secUrl = "https://security.samsungmobile.com/workScope.smsb";
      citedUrls.add(secUrl);
      const alias = getSourceAlias(secUrl);
      addRecord(
        {
          record_type: "observation",
          subject_level: "family",
          subject_key: fk,
          field: "security_update_cadence",
          value_state: "stated",
          value: q.value || "monthly",
          unit: null,
          market: "UNSPECIFIED",
          scope_qualifier: "enterprise_edition_only",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [
          q.quarantine_id,
          ...rawObservations
            .filter(
              (observation) =>
                observation.candidate_id === cid &&
                observation.field === "security_update_cadence" &&
                (observation.assertion_scope ?? observation.scope_qualifier) ===
                  "enterprise_models_only",
            )
            .map((observation) => observation.observation_id),
        ],
        "inherited_unverified",
      );

      dispositions.push({
        id: q.quarantine_id,
        disposition: "staged_quarantined_enterprise",
        output_lines: [],
        reason: "Enterprise edition cadence quarantined by contract",
      });
    } else {
      dispositions.push({
        id: q.quarantine_id,
        disposition: "preserved_unknown_no_record",
        output_lines: [],
        reason: "Held as unresolved in research pass; preserved in manifest only",
      });
    }
  }

  for (const obs of rawObservations) {
    const cid = obs.candidate_id;
    const c = candidateMap.get(cid);
    const fk = c ? `${c.manufacturer.toLowerCase()}:${makeFamilySlug(c.candidate_name)}` : "";
    const specUrl = obs.source_url || "https://security.samsungmobile.com/workScope.smsb";
    citedUrls.add(specUrl);
    const alias = getSourceAlias(specUrl);

    if (obs.field === "compatible_os") {
      addRecord(
        {
          record_type: "observation",
          subject_level: "family",
          subject_key: fk,
          field: "latest_major_os_eligible",
          value_state: "stated",
          value: obs.value,
          unit: null,
          market: "UNSPECIFIED",
          scope_qualifier: "none",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [obs.observation_id],
        "inherited_unverified",
      );

      dispositions.push({
        id: obs.observation_id,
        disposition: "staged",
        output_lines: [],
        reason: "Compatible OS observation staged as latest_major_os_eligible",
      });
    } else if (obs.field === "security_update_cadence") {
      if ((obs.assertion_scope ?? obs.scope_qualifier) === "enterprise_models_only") {
        dispositions.push({
          id: obs.observation_id,
          disposition: "staged_quarantined_enterprise",
          output_lines: [],
          reason: "Covered by enterprise quarantine hold",
        });
      } else {
        addRecord(
          {
            record_type: "observation",
            subject_level: "family",
            subject_key: fk,
            field: "security_update_cadence",
            value_state: "stated",
            value: obs.value,
            unit: null,
            market: "UNSPECIFIED",
            scope_qualifier: "market_dependent",
            source_ref: alias,
            observed_on: "2026-10-21",
            source_updated_at: null,
          },
          [obs.observation_id],
          "inherited_unverified",
        );

        dispositions.push({
          id: obs.observation_id,
          disposition: "staged",
          output_lines: [],
          reason: "Security update cadence staged as market_dependent",
        });
      }
    } else if (obs.field === "os_and_security_update_policy_years") {
      const years =
        typeof obs.value === "string" && /^[1-9][0-9]*$/.test(obs.value)
          ? Number(obs.value)
          : obs.value;
      if (!Number.isSafeInteger(years) || years < 1 || years > 10) {
        refusals.push({ code: "output_grammar", detail: obs.observation_id });
        continue;
      }
      addRecord(
        {
          record_type: "observation",
          subject_level: "family",
          subject_key: fk,
          field: "update_policy_years",
          value_state: "stated",
          value: years,
          unit: "year",
          market: "UNSPECIFIED",
          scope_qualifier: "none",
          source_ref: alias,
          observed_on: "2026-10-21",
          source_updated_at: null,
        },
        [obs.observation_id],
        "inherited_unverified",
      );

      dispositions.push({
        id: obs.observation_id,
        disposition: "staged",
        output_lines: [],
        reason: "Update policy years staged",
      });
    } else if (
      [
        "OBS-0071",
        "OBS-0072",
        "OBS-0073",
        "OBS-0074",
        "OBS-0075",
        "OBS-0076",
        "OBS-0077",
        "OBS-0078",
        "OBS-0079",
        "OBS-0080",
        "OBS-0081",
        "OBS-0082",
        "OBS-0083",
        "OBS-0084",
        "OBS-0085",
      ].includes(obs.observation_id) &&
      ["screen_diagonal_inches", "display_refresh_hz", "ram_storage_options_gb"].includes(obs.field)
    ) {
      dispositions.push({
        id: obs.observation_id,
        disposition: "staged",
        output_lines: [],
        reason: "Staged via US research references R0033-R0035",
      });
    } else if (
      ["us_reference_device_label", "usb_data_version", "qualification"].includes(obs.field) ||
      obs.field?.startsWith("us_reference")
    ) {
      dispositions.push({
        id: obs.observation_id,
        disposition:
          obs.field === "us_reference_device_label" ? "label_only" : "not_imported_minimisation",
        output_lines: [],
        reason: "Field not admitted to staging contract",
      });
    } else {
      dispositions.push({
        id: obs.observation_id,
        disposition: "not_imported_minimisation",
        output_lines: [],
        reason: "Cohort observation omitted by minimisation",
      });
    }
  }

  for (const lst of rawListings) {
    const originalReferenceId = lst.reference_id || lst.original_reference_id;
    const listingId =
      lst.listing_id || lst.observation_id || `${originalReferenceId}|${lst.evidence_state}`;
    if (
      lst.evidence_state === "publisher_listed_device" ||
      rawCorrected.some(
        (row) =>
          row.record_kind === "publisher_listing_attachment" &&
          row.original_reference_id === originalReferenceId,
      )
    ) {
      dispositions.push({
        id: listingId,
        disposition: "superseded_by_reverified_row",
        output_lines: [],
        reason: "Listing superseded by reverified row R0041-R0068",
      });
    } else {
      dispositions.push({
        id: listingId,
        disposition: "not_imported_unknown",
        output_lines: [],
        reason: "Non-match or unverified reference listing omitted",
      });
    }
  }

  const emittedSourcesMap = new Map<string, any>();
  const usedSourceAliases = new Set<string>(
    emittedRecords.flatMap((record) =>
      [record.source_ref, record.basis_source_ref, record.model_code_source_ref].filter(Boolean),
    ),
  );
  for (const url of Array.from(citedUrls).sort()) {
    const alias = getSourceAlias(url);
    if (!usedSourceAliases.has(alias)) continue;
    const previous = emittedSourcesMap.get(alias);
    if (previous && previous.url !== url) {
      refusals.push({ code: "alias_collision", detail: alias });
      continue;
    }
    const pub = mapPublisher(url);
    if (!pub) {
      refusals.push({ code: "publisher_unmapped", detail: url });
    }
    const sm = mapSourceMarket(url);
    if (!sm) {
      refusals.push({ code: "source_market_unmapped", detail: url });
    }
    emittedSourcesMap.set(alias, {
      record_type: "source",
      ref: alias,
      url,
      publisher: pub || "Unknown",
      market: sm ? sm.market : "UNSPECIFIED",
      access_method: "manual_read",
      raw_page_stored: false,
      rule_id: sm ? sm.ruleId : "M4",
    });
  }

  const sourcesSourceAccounting: any[] = [];
  if (rawSourcesJson) {
    const entries = Array.isArray(rawSourcesJson)
      ? rawSourcesJson.map((e, idx) => ({
          id: e.key || e.id || String(idx),
          url: e.url || e.source_url,
        }))
      : Object.entries(rawSourcesJson).map(([k, v]: [string, any]) => ({
          id: k,
          url: v?.url || v?.source_url,
        }));
    for (const entry of entries) {
      const alias =
        entry.url && emittedSourcesMap.has(getSourceAlias(entry.url))
          ? getSourceAlias(entry.url)
          : null;
      sourcesSourceAccounting.push({
        input: "sources.json",
        id: entry.id,
        url: entry.url || null,
        emitted_alias: alias,
      });
    }
  }
  if (rawSourceRegister && Array.isArray(rawSourceRegister.sources)) {
    const seenSourceIds = new Set<string>();
    for (const item of rawSourceRegister.sources as any[]) {
      const sId = item.source_id || item.id;
      if (!sId || seenSourceIds.has(sId)) continue;
      seenSourceIds.add(sId);
      const sUrl = item.source_url || item.url;
      const alias =
        sUrl && emittedSourcesMap.has(getSourceAlias(sUrl)) ? getSourceAlias(sUrl) : null;
      sourcesSourceAccounting.push({
        input: "SOURCE-REGISTER.json",
        id: sId,
        url: sUrl || null,
        emitted_alias: alias,
      });
    }
  }

  if (refusals.length > 0) {
    throw new MobileCohortConversionError(refusals);
  }

  let maxDate = "2026-10-21";
  for (const rec of emittedRecords) {
    if (rec.observed_on && rec.observed_on > maxDate) maxDate = rec.observed_on;
    if (rec.model_code_observed_on && rec.model_code_observed_on > maxDate)
      maxDate = rec.model_code_observed_on;
  }

  const sortedPins = Object.keys(policy.pins)
    .sort()
    .map((k) => [k, policy.pins[k as CohortFileName]]);
  if (input.joinVerification) {
    sortedPins.push(["join-verification", sha256Hex(input.joinVerification.bytes)]);
  }
  const researchPackageSha = sha256Hex(canonicalJson(sortedPins));

  const headerRec = {
    contract: "mgpl-mobile-staging/1",
    prepared_by: MOBILE_COHORT_CONVERTER,
    prepared_on: maxDate,
    record_type: "header",
    research_package_sha256: researchPackageSha,
  };

  const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const sourcesToEmit = Array.from(emittedSourcesMap.values())
    .map((s) => ({
      record_type: s.record_type,
      ref: s.ref,
      url: s.url,
      publisher: s.publisher,
      market: s.market,
      access_method: s.access_method,
      raw_page_stored: s.raw_page_stored,
    }))
    .sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));

  const familiesToEmit: any[] = [];
  const referencesToEmit: any[] = [];
  const variantsToEmit: any[] = [];
  const observationsToEmit: any[] = [];
  const listingsToEmit: any[] = [];

  for (const r of emittedRecords) {
    if (r.record_type === "family") familiesToEmit.push(r);
    else if (r.record_type === "reference") referencesToEmit.push(r);
    else if (r.record_type === "variant") variantsToEmit.push(r);
    else if (r.record_type === "observation") observationsToEmit.push(r);
    else if (r.record_type === "listing") listingsToEmit.push(r);
  }

  familiesToEmit.sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));
  referencesToEmit.sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));
  variantsToEmit.sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));
  observationsToEmit.sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));
  listingsToEmit.sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));

  const finalLines: string[] = [
    canonicalJson(headerRec),
    ...sourcesToEmit.map(canonicalJson),
    ...familiesToEmit.map(canonicalJson),
    ...referencesToEmit.map(canonicalJson),
    ...variantsToEmit.map(canonicalJson),
    ...observationsToEmit.map(canonicalJson),
    ...listingsToEmit.map(canonicalJson),
  ];

  const expectedQuarantinedLines: number[] = [];
  for (let i = 0; i < finalLines.length; i++) {
    const lineStr = finalLines[i];
    if (Buffer.byteLength(lineStr, "utf8") > 4096) {
      refusals.push({ code: "line_too_long", detail: `Line ${i + 1} exceeds 4096 bytes` });
    }
    const parsed = JSON.parse(lineStr);
    if (parsed.record_type === "observation") {
      if (parsed.declared_quarantine || parsed.scope_qualifier === "enterprise_edition_only") {
        expectedQuarantinedLines.push(i + 1);
      }
    }
  }

  if (refusals.length > 0) {
    throw new MobileCohortConversionError(refusals);
  }

  const jsonlBuffer = Buffer.from(finalLines.join("\n") + "\n", "utf8");
  const jsonlSha256 = sha256Hex(jsonlBuffer);

  const recordsByType = {
    header: 1,
    source: sourcesToEmit.length,
    family: familiesToEmit.length,
    reference: referencesToEmit.length,
    variant: variantsToEmit.length,
    observation: observationsToEmit.length,
    listing: listingsToEmit.length,
  };

  const manifestInputs = fileNames
    .map((fn) => ({
      name: fn,
      bytes: input.files[fn]?.length || 0,
      sha256: sha256Hex(input.files[fn] || Buffer.alloc(0)),
    }))
    .sort((a, b) => cmpStr(a.name, b.name));

  const manifestSources = Array.from(emittedSourcesMap.values())
    .map((s) => ({
      alias: s.ref,
      url: s.url,
      publisher: s.publisher,
      market: s.market,
      rule_id: s.rule_id,
      extraction: "derived",
      rights: {
        bulk_collection: "not_assessed",
        automated_refresh: "not_assessed",
        redistribution: "not_assessed",
      },
    }))
    .sort((a, b) => cmpStr(a.alias, b.alias));

  const recordMetadataMap = new Map<string, { contributing: string[]; extraction: string }>();

  for (const s of emittedSourcesMap.values()) {
    const sRec = {
      record_type: s.record_type,
      ref: s.ref,
      url: s.url,
      publisher: s.publisher,
      market: s.market,
      access_method: s.access_method,
      raw_page_stored: s.raw_page_stored,
    };
    const sKey = canonicalJson(sRec);
    const sContrib = Array.from(
      new Set<string>(s.contributing_research_ids || s.contributing || []),
    ).sort(cmpStr);
    const sExtraction = s.extraction || "derived";
    const existing = recordMetadataMap.get(sKey);
    if (existing) {
      const merged = Array.from(new Set([...existing.contributing, ...sContrib])).sort(cmpStr);
      recordMetadataMap.set(sKey, {
        contributing: merged,
        extraction: existing.extraction || sExtraction,
      });
    } else {
      recordMetadataMap.set(sKey, {
        contributing: sContrib,
        extraction: sExtraction,
      });
    }
  }

  for (let i = 0; i < emittedRecords.length; i++) {
    const r = emittedRecords[i];
    const key = canonicalJson(r);
    const meta = lineExtractions[i];
    const contributions = Array.from(new Set<string>(meta?.contributing || [])).sort(cmpStr);
    const extraction = meta?.extraction || "derived";
    const existing = recordMetadataMap.get(key);
    if (existing) {
      const merged = Array.from(new Set([...existing.contributing, ...contributions])).sort(cmpStr);
      recordMetadataMap.set(key, {
        contributing: merged,
        extraction: existing.extraction || extraction,
      });
    } else {
      recordMetadataMap.set(key, {
        contributing: contributions,
        extraction,
      });
    }
  }

  const manifestLines = finalLines.map((line, idx) => {
    const parsed = JSON.parse(line);
    if (idx === 0) {
      return {
        line_number: 1,
        record_type: parsed.record_type,
        contributing_research_ids: [],
        extraction: "derived",
      };
    }
    const meta = recordMetadataMap.get(line);
    return {
      line_number: idx + 1,
      record_type: parsed.record_type,
      contributing_research_ids: meta ? meta.contributing : [],
      extraction: meta
        ? meta.extraction
        : parsed.record_type === "source"
          ? "fresh_primary_named_field"
          : "derived",
    };
  });

  const linesByResearchId = new Map();
  for (const lineEntry of manifestLines) {
    if (Array.isArray(lineEntry.contributing_research_ids)) {
      for (const rid of lineEntry.contributing_research_ids) {
        let nums = linesByResearchId.get(rid);
        if (!nums) {
          nums = [];
          linesByResearchId.set(rid, nums);
        }
        if (!nums.includes(lineEntry.line_number)) {
          nums.push(lineEntry.line_number);
        }
      }
    }
  }

  for (const row of rawCorrected) {
    if (row.research_identity_id) {
      dispositions.push({
        id: row.research_identity_id,
        disposition: "staged",
        output_lines: [],
        reason: "Source-qualified research identity staged",
      });
      linesByResearchId.set(
        row.research_identity_id,
        linesByResearchId.get(row.observation_id) || [],
      );
    }
  }
  dispositions.sort((a, b) => cmpStr(a.id, b.id));
  for (const disp of dispositions) {
    const lines = linesByResearchId.get(disp.id);
    disp.output_lines = lines ? [...lines].sort((a, b) => a - b) : [];
  }

  const manifestObj = {
    schema: MOBILE_COHORT_MANIFEST,
    converter: MOBILE_COHORT_CONVERTER,
    contract: "mgpl-mobile-staging/1",
    inputs: manifestInputs,
    join_verification: joinManifestInfo,
    research_package_sha256: researchPackageSha,
    output: {
      file: "mobile-staging.jsonl",
      bytes: jsonlBuffer.length,
      sha256: jsonlSha256,
      lines: finalLines.length,
      records_by_type: recordsByType,
    },
    expected_dry_run_on_empty_staging: {
      status: "applicable",
      inserted: finalLines.length - 1 - expectedQuarantinedLines.length,
      inserted_quarantined: expectedQuarantinedLines.length,
      rejected: 0,
      blocked: 0,
      quarantined_lines: expectedQuarantinedLines,
    },
    sources: manifestSources,
    source_accounting: sourcesSourceAccounting,
    code_market_sightings: codeMarketSightings.sort((a, b) => cmpStr(a.model_code, b.model_code)),
    lines: manifestLines,
    dispositions: dispositions.sort((a, b) => cmpStr(a.id, b.id)),
  };

  const manifestBuffer = Buffer.from(canonicalJson(manifestObj) + "\n", "utf8");
  const manifestSha256 = sha256Hex(manifestBuffer);

  return {
    jsonl: jsonlBuffer,
    manifest: manifestBuffer,
    jsonlSha256,
    manifestSha256,
    recordsByType,
    expectedQuarantinedLines,
    stagedJoins: Array.from(stagedJoinIds).sort(),
  };
}
