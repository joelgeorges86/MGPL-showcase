import { canonicalJson, sha256Hex } from "../../src/services/enrichmentPromotion";
import type {
  CohortFileName,
  CohortInput,
  CohortInventory,
  CohortPolicy,
} from "../../src/services/mobileCohortConversion";
import { JOIN_VERIFICATION_SCHEMA } from "../../src/services/mobileCohortConversion";

/**
 * AI-112 r6 synthetic miniature cohort fixture per WUD §9.1.
 *
 * Fictional input rows strictly respecting all research schemas, identities,
 * holds, corrections, and provenance rules without reading actual research
 * or staging files.
 */

export interface FixtureJoinEntry {
  reference_id: string;
  model_code: string;
  device_name_on_source: string;
  connectivity_on_source: "wifi" | "wifi_cellular" | "not_stated";
  source_url: string;
  result: "matches" | "differs" | "not_found";
}

export interface FixtureOracleCounts {
  recordsByType: {
    header: number;
    source: number;
    family: number;
    reference: number;
    variant: number;
    observation: number;
    listing: number;
  };
  lines: number;
  expectedQuarantinedLines: number[];
  stagedJoins: string[];
  dryRun: {
    status: "applicable";
    inserted: number;
    inserted_quarantined: number;
    rejected: 0;
    blocked: 0;
  };
  notStatedObservations: number;
}

// ----------------------------------------------------------------------------
// 1. Raw synthetic cohort entries
// ----------------------------------------------------------------------------

const RAW_CANDIDATES = [
  // Three Apple iPhones without R-row evidence
  {
    candidate_id: "MOB-022",
    manufacturer: "Apple",
    candidate_name: "iPhone 16 Pro Max",
    device_kind: "phone",
  },
  {
    candidate_id: "MOB-001",
    manufacturer: "Apple",
    candidate_name: "iPhone 13 Pro",
    device_kind: "phone",
  },
  {
    candidate_id: "MOB-002",
    manufacturer: "Apple",
    candidate_name: "iPhone 13",
    device_kind: "phone",
  },
  // Four Apple iPads (explicit Wi-Fi R-row, base model, held pair with new spec URL)
  {
    candidate_id: "MOB-062",
    manufacturer: "Apple",
    candidate_name: "iPad Pro 11-inch (M4)",
    device_kind: "tablet",
  },
  {
    candidate_id: "MOB-053",
    manufacturer: "Apple",
    candidate_name: "iPad (10th gen)",
    device_kind: "tablet",
  },
  {
    candidate_id: "MOB-056",
    manufacturer: "Apple",
    candidate_name: "iPad Air 11-inch (M2)",
    device_kind: "tablet",
  },
  // Samsung phone pair with US and ID markets
  {
    candidate_id: "MOB-031",
    manufacturer: "Samsung",
    candidate_name: "Galaxy A16 5G",
    device_kind: "phone",
  },
  // S26-shaped US conflict
  {
    candidate_id: "MOB-028",
    manufacturer: "Samsung",
    candidate_name: "Galaxy S26",
    device_kind: "phone",
  },
  // A56-shaped GLOBAL/ZA conflict
  {
    candidate_id: "MOB-036",
    manufacturer: "Samsung",
    candidate_name: "Galaxy A56 5G",
    device_kind: "phone",
  },
  // Samsung tablet with variants
  {
    candidate_id: "MOB-040",
    manufacturer: "Samsung",
    candidate_name: "Galaxy Tab S9",
    device_kind: "tablet",
  },
  // Pixel family with four code identities
  {
    candidate_id: "MOB-044",
    manufacturer: "Google",
    candidate_name: "Pixel 9 Pro",
    device_kind: "phone",
  },
  // Samsung US research reference target
  {
    candidate_id: "MOB-037",
    manufacturer: "Samsung",
    candidate_name: "Galaxy A37 5G",
    device_kind: "phone",
  },
];

const RAW_REFERENCES = [
  // MOB-022:REF-01 (iPhone single-match case in Appendix B: o=6, n=1, l=1, s=0)
  {
    reference_id: "MOB-022:REF-01",
    candidate_id: "MOB-022",
    specification_source_url: "https://support.apple.com/kb/SP901",
    reference_label: "iPhone 16 Pro Max",
    hardware_model_code: "A3473",
    specification: {
      name: "iPhone 16 Pro Max",
      ram_gb: null,
      chip: "A18 Pro",
      gpu_cores: 6,
      screen_diagonal_inches: 6.9,
      display_resolution_pixels: [2868, 1320],
      display_refresh_max_hz: 120,
    },
  },
  // MOB-001:REF-01 (iPhone differs case: o=5, n=1, l=0, s=0)
  {
    reference_id: "MOB-001:REF-01",
    candidate_id: "MOB-001",
    specification_source_url: "https://support.apple.com/kb/SP902",
    reference_label: "iPhone 13 Pro",
    hardware_model_code: "A2482",
    specification: {
      name: "iPhone 13 Pro",
      chip: "A15 Bionic",
      gpu_cores: 5,
      screen_diagonal_inches: 6.1,
      display_resolution_pixels: [2532, 1170],
      display_refresh_max_hz: 120,
    },
  },
  // MOB-002:REF-01 (iPhone unlisted case: o=5, n=1, l=0, s=0)
  {
    reference_id: "MOB-002:REF-01",
    candidate_id: "MOB-002",
    specification_source_url: "https://support.apple.com/kb/SP903",
    reference_label: "iPhone 13",
    hardware_model_code: "A2481",
    specification: {
      name: "iPhone 13",
      chip: "A15 Bionic",
      gpu_cores: 4,
      screen_diagonal_inches: 6.1,
      display_resolution_pixels: [2532, 1170],
      display_refresh_max_hz: 60,
    },
  },
  // MOB-062:REF-01 (iPad explicitly Wi-Fi R0036 J-05 verified)
  {
    reference_id: "MOB-062:REF-01",
    candidate_id: "MOB-062",
    specification_source_url: "https://support.apple.com/en-us/108043",
    reference_label: "iPad Pro 11-inch (M4) Wi-Fi",
    hardware_model_code: "A3357",
    specification: {
      name: "iPad Pro 11-inch (M4)",
      ram_gb: null,
      chip: "M4",
      ram_options_gb: [8, 16],
    },
  },
  // MOB-053:REF-01 (iPad base model R0040 J-06 verified unknown)
  {
    reference_id: "MOB-053:REF-01",
    candidate_id: "MOB-053",
    specification_source_url: "https://support.apple.com/en-us/108043",
    reference_label: "iPad (10th gen)",
    hardware_model_code: "A2993",
    specification: {
      name: "iPad (10th gen)",
      chip: "A14 Bionic",
      ram_options_gb: [],
    },
  },
  // MOB-056:REF-01 (held iPad family reference 1)
  {
    reference_id: "MOB-056:REF-01",
    candidate_id: "MOB-056",
    specification_source_url: "https://support.apple.com/en-us/108043",
    reference_label: "iPad Air 11-inch (M2) Wi-Fi",
    hardware_model_code: "A2898",
    specification: {
      name: "iPad Air 11-inch (M2)",
      chip: "M2",
      gpu_cores: 10,
      screen_diagonal_inches: 11.0,
      display_refresh_max_hz: 60,
    },
  },
  // MOB-056:REF-02 (held iPad family reference 2 with new spec URL: s=1)
  {
    reference_id: "MOB-056:REF-02",
    candidate_id: "MOB-056",
    specification_source_url: "https://support.apple.com/en-us/119999",
    reference_label: "iPad Air 11-inch (M2) Wi-Fi Alternative",
    hardware_model_code: "A2902",
    specification: {
      name: "iPad Air 11-inch (M2) Alternative",
      chip: "M2",
      gpu_cores: 10,
      screen_diagonal_inches: 11.0,
      display_refresh_max_hz: 60,
    },
  },
  // MOB-031:REF-01 (Samsung US phone)
  {
    reference_id: "MOB-031:REF-01",
    candidate_id: "MOB-031",
    specification_source_url: "https://news.samsung.com/us/samsung-galaxy-a16-5g-spec/",
    reference_label: "Galaxy A16 5G (US)",
    hardware_model_code: null,
    specification: {
      name: "Galaxy A16 5G",
      reference_label: "Galaxy A16 5G (US)",
      chip: "Exynos 1330",
    },
  },
  // MOB-031:REF-02 (Samsung ID phone)
  {
    reference_id: "MOB-031:REF-02",
    candidate_id: "MOB-031",
    specification_source_url: "https://news.samsung.com/id/samsung-galaxy-a16-5g-spesifikasi/",
    reference_label: "Galaxy A16 5G (ID)",
    hardware_model_code: null,
    specification: {
      name: "Galaxy A16 5G",
      reference_label: "Galaxy A16 5G (ID)",
      chip: "Dimensity 6100+",
    },
  },
  // MOB-028:REF-01 (Samsung S26 US conflict)
  {
    reference_id: "MOB-028:REF-01",
    candidate_id: "MOB-028",
    specification_source_url: "https://www.samsung.com/us/smartphones/galaxy-s26/specs/",
    reference_label: "Galaxy S26",
    hardware_model_code: null,
    specification: {
      name: "Galaxy S26",
      reference_label: "Galaxy S26",
    },
  },
  // MOB-036:REF-01 (Samsung A56 GLOBAL conflict)
  {
    reference_id: "MOB-036:REF-01",
    candidate_id: "MOB-036",
    specification_source_url: "https://samsungmobilepress.com/feature-stories/galaxy-a56-5g-specs/",
    reference_label: "Galaxy A56 5G",
    hardware_model_code: null,
    specification: {
      name: "Galaxy A56 5G",
      reference_label: "Galaxy A56 5G",
    },
  },
  // MOB-040:REF-01 (Samsung tablet with 2 variants)
  {
    reference_id: "MOB-040:REF-01",
    candidate_id: "MOB-040",
    specification_source_url: "https://www.samsung.com/us/tablets/galaxy-tab-s9/specs/",
    reference_label: "Galaxy Tab S9",
    hardware_model_code: null,
    specification: {
      name: "Galaxy Tab S9",
      chip: "Snapdragon 8 Gen 2",
      reference_label: "Galaxy Tab S9",
      ram_storage_options_gb: [
        [8, 128],
        [12, 256],
      ],
    },
  },
  // MOB-044:REF-01 (Google Pixel placeholder -> replaced by codes)
  {
    reference_id: "MOB-044:REF-01",
    candidate_id: "MOB-044",
    specification_source_url: "https://support.google.com/pixelphone/answer/7158570?hl=en",
    reference_label: "Pixel 9 Pro Placeholder",
    hardware_model_code: null,
    specification: {
      name: "Pixel 9 Pro",
      chip: "Google Tensor G4",
      ram_gb: 16,
    },
  },
  // MOB-037:REF-01 (Samsung A37 UK/GLOBAL)
  {
    reference_id: "MOB-037:REF-01",
    candidate_id: "MOB-037",
    specification_source_url: "https://news.samsung.com/global/galaxy-a37-5g-announcement/",
    reference_label: "Galaxy A37 5G",
    hardware_model_code: null,
    specification: {
      name: "Galaxy A37 5G",
      chip: "Exynos 1380",
      reference_label: "Galaxy A37 5G",
    },
  },
];

const RAW_OBSERVATIONS = [
  {
    observation_id: "OBS-0001",
    candidate_id: "MOB-031",
    source_url: "https://security.samsungmobile.com/workScope.smsb",
    field: "compatible_os",
    value: "Android 15",
    scope_qualifier: "none",
  },
  {
    observation_id: "OBS-0002",
    candidate_id: "MOB-031",
    source_url: "https://security.samsungmobile.com/workScope.smsb",
    field: "security_update_cadence",
    value: "quarterly",
    scope_qualifier: "none",
  },
  {
    observation_id: "OBS-0003",
    candidate_id: "MOB-031",
    source_url: "https://security.samsungmobile.com/workScope.smsb",
    field: "os_and_security_update_policy_years",
    value: "6",
    scope_qualifier: "none",
  },
  {
    observation_id: "OBS-0004",
    candidate_id: "MOB-037",
    source_url: "https://news.samsung.com/global/galaxy-a37-5g-announcement/",
    field: "qualification",
    value: "Research internal qualification note",
    scope_qualifier: "none",
  },
  {
    observation_id: "OBS-0005",
    candidate_id: "MOB-037",
    source_url: "https://news.samsung.com/global/galaxy-a37-5g-announcement/",
    field: "usb_data_version",
    value: "USB 2.0",
    scope_qualifier: "none",
  },
  {
    observation_id: "OBS-0006",
    candidate_id: "MOB-037",
    source_url: "https://news.samsung.com/global/galaxy-a37-5g-announcement/",
    field: "us_reference_device_label",
    value: "Galaxy A37 5G (US)",
    scope_qualifier: "none",
  },
];

const RAW_SOURCES_JSON: Record<string, { url: string }> = {
  "apple-spec-iphone16promax": { url: "https://support.apple.com/kb/SP901" },
  "apple-spec-iphone13pro": { url: "https://support.apple.com/kb/SP902" },
  "apple-spec-iphone13": { url: "https://support.apple.com/kb/SP903" },
  "apple-ipad-id-spec": { url: "https://support.apple.com/en-us/108043" },
  "apple-ipad-new-spec": { url: "https://support.apple.com/en-us/119999" },
  "apple-appstore-re4": { url: "https://apps.apple.com/us/app/resident-evil-4/id6462360082" },
  "samsung-a16-us": { url: "https://news.samsung.com/us/samsung-galaxy-a16-5g-spec/" },
  "samsung-a16-id": { url: "https://news.samsung.com/id/samsung-galaxy-a16-5g-spesifikasi/" },
  "samsung-s26-spec": { url: "https://www.samsung.com/us/smartphones/galaxy-s26/specs/" },
  "samsung-s26-product": { url: "https://www.samsung.com/us/smartphones/galaxy-s26/" },
  "samsung-s26-launch": {
    url: "https://news.samsung.com/us/samsung-galaxy-s26-ultra-s26-plus-s26-first-look/",
  },
  "samsung-a56-spec": {
    url: "https://samsungmobilepress.com/feature-stories/galaxy-a56-5g-specs/",
  },
  "samsung-a56-press": {
    url: "https://samsungmobilepress.com/articles/samsung-marks-a-step-forward-with-ai-for-everyone-by-introducing-new-galaxy-a56-5g-galaxy-a36-5g-and-galaxy-a26-5g",
  },
  "samsung-a56-za": {
    url: "https://news.samsung.com/za/experience-awesome-intelligence-with-the-galaxy-a36-and-a56",
  },
  "samsung-tabs9-spec": { url: "https://www.samsung.com/us/tablets/galaxy-tab-s9/specs/" },
  "google-pixel-spec": { url: "https://support.google.com/pixelphone/answer/7158570?hl=en" },
  "samsung-a37-global": { url: "https://news.samsung.com/global/galaxy-a37-5g-announcement/" },
  "samsung-a37-compare": { url: "https://www.samsung.com/us/smartphones/galaxy-a-series/compare/" },
  "samsung-security-workscope": { url: "https://security.samsungmobile.com/workScope.smsb" },
  // Two unused fixture sources for accounting and V-39 unmappable testing
  "unused-unmappable-source": { url: "https://example.invalid/unmapped/page" },
  "unused-valid-source": { url: "https://news.samsung.com/global/extra-unused-source/" },
};

const RAW_LISTINGS = [
  {
    listing_id: "LST-0001",
    original_reference_id: "MOB-062:REF-01",
    candidate_id: "MOB-062",
    store: "apple_app_store",
    store_country: "US",
    store_app_id: "6462360082",
    game: "Resident Evil 4",
    publisher_device_label: "iPad Pro 11-inch (M4)",
    required_os: "iPadOS 17.0",
  },
  {
    listing_id: "LST-0002",
    original_reference_id: null,
    candidate_id: null,
    store: "apple_app_store",
    store_country: "US",
    store_app_id: "6462360082",
    game: "Resident Evil 4",
    publisher_device_label: "Unknown Future Device (Wi-Fi + Cellular)",
    required_os: "iPadOS 18.0",
  },
];

const RAW_CORRECTED = [
  // Pixel codes (R0001-R0004)
  {
    observation_id: "R0001",
    candidate_id: "MOB-044",
    record_kind: "model_code_identity",
    value: "GZPFO", // Contains literal 'O', three markets
    research_identity_id: "MOB-044:MODEL-GZPFO",
    source_scope_label: "US/CA/JP",
    explicit_markets: ["US", "CA", "JP"],
    market_set_exhaustive: false,
    radio_scope: "5G Sub 6GHz",
  },
  {
    observation_id: "R0002",
    candidate_id: "MOB-044",
    record_kind: "model_code_identity",
    value: "G8HHN", // Code with no label (source_scope_label: null)
    research_identity_id: "MOB-044:MODEL-G8HHN",
    source_scope_label: null,
    explicit_markets: null,
    market_set_exhaustive: false,
    radio_scope: "5G Sub 6GHz",
  },
  {
    observation_id: "R0003",
    candidate_id: "MOB-044",
    record_kind: "model_code_identity",
    value: "GUR25", // NA code
    research_identity_id: "MOB-044:MODEL-GUR25",
    source_scope_label: "NA",
    explicit_markets: ["US", "CA"],
    market_set_exhaustive: true,
    radio_scope: "5G mmWave",
  },
  {
    observation_id: "R0004",
    candidate_id: "MOB-044",
    record_kind: "model_code_identity",
    value: "GE9DP", // ROW code
    research_identity_id: "MOB-044:MODEL-GE9DP",
    source_scope_label: "ROW",
    explicit_markets: ["GB", "DE", "FR"],
    market_set_exhaustive: false,
    radio_scope: "5G Sub 6GHz",
  },
  // US research reference (R0033)
  {
    observation_id: "R0033",
    research_identity_id: "MOB-037:US-5G-RESEARCH",
    source_ids: ["SR-0004"],
    candidate_id: "MOB-037",
    record_kind: "additional_source_scoped_reference",
    reference_label: "Galaxy A37 5G (US)",
    observed_fields: {
      screen_diagonal_in: { value: 6.6 },
      display_refresh_max_hz: { value: 120 },
      ram_storage_configurations: {
        value: [
          { physical_ram_gb: 6, storage_gb: 128 },
          { physical_ram_gb: 8, storage_gb: 256 },
        ],
      },
    },
  },
  // Regional SoC statements (R0031, R0032)
  {
    observation_id: "R0031",
    candidate_id: "MOB-031",
    record_kind: "regional_soc_statement",
    market: "US",
    value: "Exynos 1330",
  },
  {
    observation_id: "R0032",
    candidate_id: "MOB-031",
    record_kind: "regional_soc_statement",
    market: "ID",
    value: "Dimensity 6100+",
  },
  // Regional alternatives row (R0028)
  {
    observation_id: "R0028",
    candidate_id: "MOB-028",
    record_kind: "regional_alternatives",
    value: "SM-S926B, SM-S926U",
  },
  // Scope correction (R0024)
  {
    observation_id: "R0024",
    original_reference_id: "MOB-037:REF-01",
    candidate_id: "MOB-037",
    record_kind: "source_scope_correction",
    market: "GLOBAL",
  },
  // Connectivity identity checks (R0036, R0040)
  {
    observation_id: "R0036",
    candidate_id: "MOB-062",
    record_kind: "connectivity_identity_check",
    original_reference_id: "MOB-062:REF-01",
    model_code: "A3357",
    connectivity: "wifi",
  },
  {
    observation_id: "R0040",
    candidate_id: "MOB-053",
    record_kind: "connectivity_identity_check",
    original_reference_id: "MOB-053:REF-01",
    model_code: "A2993",
    connectivity: "not_stated",
  },
  // RAM unknown preservation (R0070, R0071, R0072)
  {
    observation_id: "R0070",
    candidate_id: "MOB-022",
    record_kind: "unknown_field_preservation",
    original_reference_id: "MOB-022:REF-01",
    field: "ram_gb",
    value: null,
  },
  {
    observation_id: "R0071",
    candidate_id: "MOB-062",
    record_kind: "unknown_field_preservation",
    original_reference_id: "MOB-062:REF-01",
    field: "ram_gb",
    value: null,
  },
  {
    observation_id: "R0072",
    candidate_id: "MOB-056",
    record_kind: "unknown_field_preservation",
    original_reference_id: "MOB-056:REF-01",
    field: "ram_gb",
    value: null,
  },
  // Reverified publisher listing attachments (R0041, R0042, R0043)
  {
    observation_id: "R0041",
    candidate_id: "MOB-062",
    record_kind: "publisher_listing_attachment",
    original_reference_id: "MOB-062:REF-01",
    hardware_model_code: "A3357",
    store_app_id: "6462360082",
    game: "Resident Evil 4",
    publisher_device_label: "iPad Pro 11-inch (M4)",
    required_os: "iPadOS 17.0 or later with M-series chip", // Exercises F-4 leading token parser
  },
  {
    observation_id: "R0042",
    candidate_id: "MOB-022",
    record_kind: "publisher_listing_attachment",
    original_reference_id: "MOB-022:REF-01",
    hardware_model_code: "A3473",
    store_app_id: "6462360082",
    game: "Resident Evil 4",
    publisher_device_label: "iPhone 16 Pro Max",
    required_os: "iOS 17.0 or later",
  },
  {
    observation_id: "R0043",
    candidate_id: "MOB-056",
    record_kind: "publisher_listing_attachment",
    original_reference_id: "MOB-056:REF-01",
    hardware_model_code: "A2898",
    store_app_id: "6462360082",
    game: "Resident Evil 4",
    publisher_device_label: "iPad Air 11-inch (M2)",
    required_os: "iPadOS 17.0 or later",
  },
];

const RAW_QUARANTINE = [
  {
    quarantine_id: "AI112-Q0002",
    candidate_id: "MOB-028",
    field: "soc_name",
    value: "Snapdragon 8 Elite for Galaxy",
    reason: "regional_assignment_unresolved",
  },
  {
    quarantine_id: "AI112-Q0003",
    source_ids: ["SR-0002"],
    candidate_id: "MOB-028",
    field: "soc_name",
    value: "Snapdragon 8 Elite",
    reason: "research_declared_unresolved",
  },
  {
    quarantine_id: "AI112-Q0006",
    candidate_id: "MOB-036",
    field: "soc_name",
    value: "Exynos 1580",
    reason: "research_declared_unresolved",
  },
  {
    quarantine_id: "AI112-Q0007",
    candidate_id: "MOB-036",
    field: "soc_name",
    value: "Exynos 1480",
    reason: "research_declared_unresolved",
  },
  {
    quarantine_id: "AI112-Q0013",
    candidate_id: "MOB-031",
    field: "security_update_cadence",
    value: "monthly",
    scope_qualifier: "enterprise_models_only",
    reason: "enterprise_scope_not_retail",
  },
  {
    quarantine_id: "AI112-Q0001",
    candidate_id: "MOB-044",
    field: "market",
    value: "G8HHN",
    reason: "no_market_claim",
  },
  {
    quarantine_id: "AI112-Q0016",
    candidate_id: "MOB-062",
    field: "reference",
    value: "wifi_cellular_not_staged",
    reason: "cellular_model_held",
  },
];

const RAW_SOURCE_REGISTER = {
  schema: "ai112-research-source-register/1",
  sources: [
    { source_id: "SR-0001", url: "https://apps.apple.com/us/app/resident-evil-4/id6462360082" },
    {
      source_id: "SR-0002",
      url: "https://news.samsung.com/us/samsung-galaxy-s26-ultra-s26-plus-s26-first-look/",
    },
    {
      source_id: "SR-0003",
      url: "https://news.samsung.com/za/experience-awesome-intelligence-with-the-galaxy-a36-and-a56",
    },
    {
      source_id: "SR-0004",
      url: "https://www.samsung.com/us/smartphones/galaxy-a-series/compare/",
    },
    { source_id: "SR-0005", url: "https://support.google.com/pixelphone/answer/7158570?hl=en" },
    { source_id: "SR-0006", url: "https://example.invalid/unmapped/page" },
  ],
};

// ----------------------------------------------------------------------------
// 2. Serialization helpers & exported raw files
// ----------------------------------------------------------------------------

function toJsonLines(records: readonly any[]): string {
  return records.map(canonicalJson).join("\n") + "\n";
}

export const RAW_FIXTURE_TEXTS: Readonly<Record<CohortFileName, string>> = Object.freeze({
  "candidates.jsonl": toJsonLines(RAW_CANDIDATES),
  "mobile-reference-bundle.jsonl": toJsonLines(RAW_REFERENCES),
  "observations.jsonl": toJsonLines(RAW_OBSERVATIONS),
  "sources.json": canonicalJson(RAW_SOURCES_JSON) + "\n",
  "game-listing-observations.jsonl": toJsonLines(RAW_LISTINGS),
  "CORRECTED-OBSERVATIONS.jsonl": toJsonLines(RAW_CORRECTED),
  "QUARANTINE.jsonl": toJsonLines(RAW_QUARANTINE),
  "SOURCE-REGISTER.json": canonicalJson(RAW_SOURCE_REGISTER) + "\n",
});

export const FIXTURE_BUFFERS: Readonly<Record<CohortFileName, Buffer>> = Object.freeze({
  "candidates.jsonl": Buffer.from(RAW_FIXTURE_TEXTS["candidates.jsonl"], "utf8"),
  "mobile-reference-bundle.jsonl": Buffer.from(
    RAW_FIXTURE_TEXTS["mobile-reference-bundle.jsonl"],
    "utf8",
  ),
  "observations.jsonl": Buffer.from(RAW_FIXTURE_TEXTS["observations.jsonl"], "utf8"),
  "sources.json": Buffer.from(RAW_FIXTURE_TEXTS["sources.json"], "utf8"),
  "game-listing-observations.jsonl": Buffer.from(
    RAW_FIXTURE_TEXTS["game-listing-observations.jsonl"],
    "utf8",
  ),
  "CORRECTED-OBSERVATIONS.jsonl": Buffer.from(
    RAW_FIXTURE_TEXTS["CORRECTED-OBSERVATIONS.jsonl"],
    "utf8",
  ),
  "QUARANTINE.jsonl": Buffer.from(RAW_FIXTURE_TEXTS["QUARANTINE.jsonl"], "utf8"),
  "SOURCE-REGISTER.json": Buffer.from(RAW_FIXTURE_TEXTS["SOURCE-REGISTER.json"], "utf8"),
});

export function computePins(
  files: Readonly<Record<CohortFileName, Buffer>>,
): Record<CohortFileName, string> {
  const result: any = {};
  for (const [k, buf] of Object.entries(files)) {
    result[k] = sha256Hex(buf);
  }
  return result;
}

export const FIXTURE_INVENTORY: Readonly<CohortInventory> = Object.freeze({
  candidates: RAW_CANDIDATES.length, // 12
  references: RAW_REFERENCES.length, // 14
  observations: RAW_OBSERVATIONS.length, // 6
  sources: Object.keys(RAW_SOURCES_JSON).length, // 21
  listings: RAW_LISTINGS.length, // 2
  corrected: RAW_CORRECTED.length, // 17
  holds: RAW_QUARANTINE.length, // 7
});

export const FIXTURE_POLICY: Readonly<CohortPolicy> = Object.freeze({
  pins: Object.freeze(computePins(FIXTURE_BUFFERS)),
  inventory: FIXTURE_INVENTORY,
});

export function withInventory(
  policy: Readonly<CohortPolicy>,
  patch: Partial<CohortInventory>,
): CohortPolicy {
  return {
    pins: { ...policy.pins },
    inventory: Object.freeze({
      ...policy.inventory,
      ...patch,
    }),
  };
}

export function createFixtureFiles(): Record<CohortFileName, Buffer> {
  return {
    "candidates.jsonl": Buffer.from(FIXTURE_BUFFERS["candidates.jsonl"]),
    "mobile-reference-bundle.jsonl": Buffer.from(FIXTURE_BUFFERS["mobile-reference-bundle.jsonl"]),
    "observations.jsonl": Buffer.from(FIXTURE_BUFFERS["observations.jsonl"]),
    "sources.json": Buffer.from(FIXTURE_BUFFERS["sources.json"]),
    "game-listing-observations.jsonl": Buffer.from(
      FIXTURE_BUFFERS["game-listing-observations.jsonl"],
    ),
    "CORRECTED-OBSERVATIONS.jsonl": Buffer.from(FIXTURE_BUFFERS["CORRECTED-OBSERVATIONS.jsonl"]),
    "QUARANTINE.jsonl": Buffer.from(FIXTURE_BUFFERS["QUARANTINE.jsonl"]),
    "SOURCE-REGISTER.json": Buffer.from(FIXTURE_BUFFERS["SOURCE-REGISTER.json"]),
  };
}

export function createFixtureInput(options?: {
  joinVerification?: {
    bytes: Buffer;
    expectedSha256: string;
    runDate: string;
  } | null;
  filesPatch?: Partial<Record<CohortFileName, Buffer>>;
}): CohortInput {
  return {
    files: {
      ...createFixtureFiles(),
      ...options?.filesPatch,
    },
    joinVerification: options?.joinVerification ?? null,
  };
}

// ----------------------------------------------------------------------------
// 3. Join verification records and templates
// ----------------------------------------------------------------------------

export function makeJoinVerificationRecord(
  entries: FixtureJoinEntry[],
  options?: { checkedOn?: string; runDate?: string; lane?: string },
): { bytes: Buffer; expectedSha256: string; runDate: string } {
  const checkedOn = options?.checkedOn ?? "2026-10-21";
  const runDate = options?.runDate ?? "2026-10-21";
  const lane = options?.lane ?? "role-11-research-lane";

  const record = {
    schema: JOIN_VERIFICATION_SCHEMA,
    checked_on: checkedOn,
    prepared_by_lane: lane,
    entries,
  };

  const bytes = Buffer.from(canonicalJson(record) + "\n", "utf8");
  const expectedSha256 = sha256Hex(bytes);
  return { bytes, expectedSha256, runDate };
}

export const FIXTURE_JOIN_RECORDS = {
  /**
   * Case 1: Single match on MOB-022:REF-01 (iPhone 16 Pro Max, A3473)
   */
  singleMatch: makeJoinVerificationRecord([
    {
      reference_id: "MOB-022:REF-01",
      model_code: "A3473",
      device_name_on_source: "iPhone 16 Pro Max",
      connectivity_on_source: "not_stated",
      source_url: "https://support.apple.com/en-us/108044",
      result: "matches",
    },
  ]),

  /**
   * Case 2: MOB-001:REF-01 differs
   */
  differs: makeJoinVerificationRecord([
    {
      reference_id: "MOB-001:REF-01",
      model_code: "A2482",
      device_name_on_source: "iPhone 13 Pro (US)",
      connectivity_on_source: "not_stated",
      source_url: "https://support.apple.com/en-us/108044",
      result: "differs",
    },
  ]),

  /**
   * Case 3: Mixed partial record:
   * - MOB-022:REF-01 matches
   * - MOB-001:REF-01 differs
   * - MOB-056:REF-02 matches (iPad with s=1, new spec URL)
   * - MOB-002:REF-01 absent
   */
  mixed: makeJoinVerificationRecord([
    {
      reference_id: "MOB-022:REF-01",
      model_code: "A3473",
      device_name_on_source: "iPhone 16 Pro Max",
      connectivity_on_source: "not_stated",
      source_url: "https://support.apple.com/en-us/108044",
      result: "matches",
    },
    {
      reference_id: "MOB-001:REF-01",
      model_code: "A2482",
      device_name_on_source: "iPhone 13 Pro (US)",
      connectivity_on_source: "not_stated",
      source_url: "https://support.apple.com/en-us/108044",
      result: "differs",
    },
    {
      reference_id: "MOB-056:REF-02",
      model_code: "A2902",
      device_name_on_source: "iPad Air 11-inch (M2)",
      connectivity_on_source: "wifi",
      source_url: "https://support.apple.com/en-us/108043",
      result: "matches",
    },
  ]),
};

// ----------------------------------------------------------------------------
// 4. Literal fixture oracle counts (computed by hand per WUD §5.12)
// ----------------------------------------------------------------------------

/**
 * Literal oracle constants derived by hand from the synthetic fixture rows
 * following §5.12 formulas. Never computed via converter execution.
 */
export const FIXTURE_ORACLE = {
  /**
   * Baseline (no join verification record, M = ∅):
   * - source: 18 (all cited fixture sources: 18 cited, 2 un-emitted)
   * - family: 12 (all candidates)
   * - reference: 13 (8 from bundle + 4 Pixel codes + 1 US research ref)
   * - variant: 4 (2 Samsung Tab S9 + 2 US research ref)
   * - observation: 21 (2 Pixel + 2 iPad M4 + 2 iPad 10th + 2 Samsung bundle + 4 corrected + 5 quarantine + 3 observations)
   * - listing: 1 (R0041 for iPad Pro M4)
   * - header: 1
   * Total lines: 1 + 18 + 12 + 13 + 4 + 21 + 1 = 70
   * Quarantined observations: 5 (Q0002, Q0003, Q0006, Q0007, Q0013)
   */
  baseline: Object.freeze<FixtureOracleCounts>({
    recordsByType: {
      header: 1,
      source: 18,
      family: 12,
      reference: 13,
      variant: 4,
      observation: 21,
      listing: 1,
    },
    lines: 70,
    // Four declared observations sort first; enterprise cadence sorts with its field.
    expectedQuarantinedLines: [49, 50, 51, 52, 60],
    stagedJoins: [],
    dryRun: {
      status: "applicable",
      inserted: 64, // 70 - 1 - 5
      inserted_quarantined: 5,
      rejected: 0,
      blocked: 0,
    },
    notStatedObservations: 2, // MOB-053 ram_options_gb (empty) + MOB-062 ram_gb
  }),

  /**
   * Single match (M = { MOB-022:REF-01 }):
   * - source: +1 (https://support.apple.com/en-us/108044 iPhone identification page)
   * - reference: +1 (MOB-022:REF-01 staged)
   * - observation: +6 (A18 Pro chip, 6 gpu cores, 6.9 in, 2868x1320 px, 120 Hz, ram_gb not stated)
   * - listing: +1 (R0042 listing attached)
   * Total lines: 70 + 9 = 79
   */
  singleMatch: Object.freeze<FixtureOracleCounts>({
    recordsByType: {
      header: 1,
      source: 19,
      family: 12,
      reference: 14,
      variant: 4,
      observation: 27,
      listing: 2,
    },
    lines: 79,
    expectedQuarantinedLines: [51, 52, 53, 54, 67],
    stagedJoins: ["MOB-022:REF-01"],
    dryRun: {
      status: "applicable",
      inserted: 73, // 79 - 1 - 5
      inserted_quarantined: 5,
      rejected: 0,
      blocked: 0,
    },
    notStatedObservations: 3, // Baseline 2 + MOB-022 ram_gb
  }),

  /**
   * Mixed partial verification:
   * M = { MOB-022:REF-01, MOB-056:REF-02 }
   * - MOB-022:REF-01 adds: 1 source (108044), 1 ref, 6 obs, 1 listing
   * - MOB-056:REF-02 adds: 1 source (new spec url 119999, s=1), 1 ref, 4 obs, 0 listings
   * Total sources: 18 + 2 = 20
   * Total references: 13 + 2 = 15
   * Total observations: 21 + 10 = 31
   * Total listings: 1 + 1 = 2
   * Total lines: 70 + 15 = 85
   */
  mixed: Object.freeze<FixtureOracleCounts>({
    recordsByType: {
      header: 1,
      source: 20,
      family: 12,
      reference: 15,
      variant: 4,
      observation: 31,
      listing: 2,
    },
    lines: 85,
    expectedQuarantinedLines: [53, 54, 55, 56, 72],
    stagedJoins: ["MOB-022:REF-01", "MOB-056:REF-02"],
    dryRun: {
      status: "applicable",
      inserted: 79, // 85 - 1 - 5
      inserted_quarantined: 5,
      rejected: 0,
      blocked: 0,
    },
    notStatedObservations: 3, // MOB-056:REF-02 has n=0, so same 3
  }),
};

// ----------------------------------------------------------------------------
// 5. Mutation builders for testing negative cases and policy drift
// ----------------------------------------------------------------------------

export function withMutatedFile(
  files: Readonly<Record<CohortFileName, Buffer>>,
  fileName: CohortFileName,
  mutator: (content: string) => string,
): Record<CohortFileName, Buffer> {
  const current = files[fileName].toString("utf8");
  const modified = mutator(current);
  return {
    ...files,
    [fileName]: Buffer.from(modified, "utf8"),
  };
}

export function withRecomputedPolicy(
  files: Readonly<Record<CohortFileName, Buffer>>,
  inventoryPatch?: Partial<CohortInventory>,
): CohortPolicy {
  return {
    pins: Object.freeze(computePins(files)),
    inventory: Object.freeze({
      ...FIXTURE_INVENTORY,
      ...inventoryPatch,
    }),
  };
}

export function withShuffledRows(
  files: Readonly<Record<CohortFileName, Buffer>>,
  fileName: CohortFileName,
): Record<CohortFileName, Buffer> {
  return withMutatedFile(files, fileName, (text) => {
    const lines = text.trim().split("\n");
    if (lines.length <= 1) return text;
    const reversed = [...lines].reverse();
    return reversed.join("\n") + "\n";
  });
}
