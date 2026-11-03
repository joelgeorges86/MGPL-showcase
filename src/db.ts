import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "./lib/dbHandles";
import { mkdirSync } from "fs";
import path from "path";
import { seedDeviceCatalog } from "./seed/devices";
import { seedBuilderComponents } from "./seed/components";
import { seedPerformanceProfiles } from "./seed/performance";
import { seedReviews, seedHardwarePriceHistory } from "./seed/reviews";
import { seedRadar } from "./seed/radar";
import { seedCommunityBenchmarks } from "./seed/benchmarks";
import { normalizePlatform } from "./lib/platformTaxonomy";
import { reSanitizeModCatalog } from "./services/modCatalogSanitizer";
import { ensureModHubSeed } from "./services/modManager";
import { safeErrorMessage } from "./utils/errorSanitizer";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
mkdirSync(path.dirname(dbPath), { recursive: true });
export const db: DatabaseType = openDatabase(dbPath);

// MGPL v1.1 (Litestream integration): apply connection-boot PRAGMAs so the
// database runs in WAL mode (required for Litestream continuous replication),
// tolerates concurrent writers via a 10s busy timeout, and enforces foreign key
// integrity. These are set on every connection boot, before any DDL runs.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");
db.pragma("foreign_keys = ON");

const MOBILE_STAGING_DDL = `
    CREATE TABLE IF NOT EXISTS mobile_import_batches (
      batch_id TEXT PRIMARY KEY NOT NULL CHECK (length(batch_id) = 36),
      contract TEXT NOT NULL CHECK (contract = 'mgpl-mobile-staging/1'),
      input_sha256 TEXT NOT NULL UNIQUE CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
      plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_records INTEGER NOT NULL CHECK (input_records >= 1),
      inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
      inserted_quarantined_count INTEGER NOT NULL CHECK (inserted_quarantined_count >= 0),
      inserted_superseded_count INTEGER NOT NULL CHECK (inserted_superseded_count >= 0),
      sighting_added_count INTEGER NOT NULL CHECK (sighting_added_count >= 0),
      unchanged_count INTEGER NOT NULL CHECK (unchanged_count >= 0),
      model_code_resolved_count INTEGER NOT NULL CHECK (model_code_resolved_count >= 0),
      existing_quarantined_count INTEGER NOT NULL CHECK (existing_quarantined_count >= 0),
      existing_superseded_count INTEGER NOT NULL CHECK (existing_superseded_count >= 0),
      applied_at TEXT NOT NULL CHECK (applied_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
      CHECK (inserted_count + inserted_quarantined_count + inserted_superseded_count + sighting_added_count + unchanged_count + model_code_resolved_count = input_records),
      CHECK (inserted_count + inserted_quarantined_count + inserted_superseded_count + sighting_added_count + model_code_resolved_count + existing_quarantined_count + existing_superseded_count >= 1)
    );

    CREATE TABLE IF NOT EXISTS mobile_sources (
      source_key TEXT PRIMARY KEY NOT NULL CHECK (length(source_key) = 20 AND source_key GLOB 'src-*' AND substr(source_key, 5) NOT GLOB '*[^0-9a-f]*'),
      url TEXT NOT NULL UNIQUE CHECK (url GLOB 'https://?*' AND length(url) <= 500),
      publisher TEXT NOT NULL CHECK (length(publisher) BETWEEN 1 AND 40),
      market TEXT NOT NULL CHECK (market IN ('GLOBAL', 'UNSPECIFIED') OR (length(market) = 2 AND market NOT GLOB '*[^A-Z]*')),
      access_method TEXT NOT NULL CHECK (access_method = 'manual_read'),
      raw_page_stored INTEGER NOT NULL DEFAULT 0 CHECK (raw_page_stored = 0),
      first_batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id)
    );

    CREATE TABLE IF NOT EXISTS mobile_device_families (
      family_key TEXT PRIMARY KEY NOT NULL CHECK (length(family_key) <= 80 AND family_key GLOB '[a-z]*:[a-z0-9]*' AND family_key NOT GLOB '*:*:*' AND family_key NOT GLOB '*[^a-z0-9:-]*'),
      manufacturer TEXT NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 40),
      device_class TEXT NOT NULL CHECK (device_class IN ('Phone', 'Tablet')),
      os_family TEXT NOT NULL CHECK (os_family IN ('ios', 'ipados', 'android')),
      marketing_name TEXT NOT NULL CHECK (length(marketing_name) BETWEEN 1 AND 80 AND instr(marketing_name, char(10)) = 0),
      basis_source_key TEXT NOT NULL REFERENCES mobile_sources(source_key),
      research_ref TEXT CHECK (research_ref IS NULL OR length(research_ref) BETWEEN 1 AND 40),
      first_batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id),
      UNIQUE (family_key, manufacturer),
      CHECK ((os_family = 'ipados') = (device_class = 'Tablet' AND os_family <> 'android')),
      CHECK (os_family <> 'ios' OR device_class = 'Phone'),
      CHECK ((manufacturer = 'Apple') = (os_family IN ('ios', 'ipados')))
    );

    CREATE TABLE IF NOT EXISTS mobile_hardware_references (
      reference_key TEXT PRIMARY KEY NOT NULL CHECK (length(reference_key) <= 120 AND reference_key NOT GLOB '*[^a-z0-9:-]*'),
      family_key TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      reference_label TEXT NOT NULL CHECK (length(reference_label) BETWEEN 1 AND 80 AND instr(reference_label, char(10)) = 0),
      scope_market TEXT CHECK (scope_market IS NULL OR scope_market IN ('GLOBAL', 'UNSPECIFIED') OR (length(scope_market) = 2 AND scope_market NOT GLOB '*[^A-Z]*')),
      connectivity TEXT NOT NULL CHECK (connectivity IN ('wifi', 'wifi_cellular', 'cellular_4g', 'cellular_5g', 'unknown')),
      model_code TEXT CHECK (model_code IS NULL OR (length(model_code) BETWEEN 2 AND 24 AND model_code NOT GLOB '*[^A-Za-z0-9-]*')),
      model_code_source_key TEXT REFERENCES mobile_sources(source_key),
      model_code_observed_on TEXT CHECK (model_code_observed_on IS NULL OR date(model_code_observed_on) IS model_code_observed_on),
      model_code_batch_id TEXT REFERENCES mobile_import_batches(batch_id),
      basis_source_key TEXT NOT NULL REFERENCES mobile_sources(source_key),
      research_ref TEXT CHECK (research_ref IS NULL OR length(research_ref) BETWEEN 1 AND 40),
      first_batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id),
      FOREIGN KEY (family_key, manufacturer) REFERENCES mobile_device_families(family_key, manufacturer),
      CHECK (substr(reference_key, 1, length(family_key) + 1) = family_key || ':' AND length(reference_key) > length(family_key) + 1),
      CHECK ((model_code IS NULL) = (scope_market IS NOT NULL)),
      CHECK ((model_code IS NULL) = (model_code_source_key IS NULL)),
      CHECK ((model_code IS NULL) = (model_code_observed_on IS NULL)),
      CHECK ((model_code IS NULL) = (model_code_batch_id IS NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_references_model_code
      ON mobile_hardware_references(manufacturer, model_code) WHERE model_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_references_source_scope
      ON mobile_hardware_references(family_key, scope_market, connectivity) WHERE model_code IS NULL;
    CREATE INDEX IF NOT EXISTS idx_mobile_references_family ON mobile_hardware_references(family_key);

    CREATE TABLE IF NOT EXISTS mobile_device_variants (
      variant_key TEXT PRIMARY KEY NOT NULL,
      reference_key TEXT NOT NULL REFERENCES mobile_hardware_references(reference_key),
      ram_gb INTEGER CHECK (ram_gb IS NULL OR (typeof(ram_gb) = 'integer' AND ram_gb BETWEEN 1 AND 64)),
      storage_gb INTEGER CHECK (storage_gb IS NULL OR (typeof(storage_gb) = 'integer' AND storage_gb BETWEEN 1 AND 8192)),
      retail_sku_code TEXT CHECK (retail_sku_code IS NULL OR (length(retail_sku_code) BETWEEN 2 AND 32 AND retail_sku_code NOT GLOB '*[^A-Za-z0-9/-]*')),
      sku_status TEXT NOT NULL CHECK (sku_status IN ('configuration_observed', 'retail_sku_resolved')),
      first_batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id),
      CHECK (ram_gb IS NOT NULL OR storage_gb IS NOT NULL OR retail_sku_code IS NOT NULL),
      CHECK ((sku_status = 'retail_sku_resolved') = (retail_sku_code IS NOT NULL)),
      CHECK (variant_key = reference_key || '#ram=' || coalesce(ram_gb, 'x') || '#st=' || coalesce(storage_gb, 'x') || '#sku=' || coalesce(retail_sku_code, 'x'))
    );

    CREATE TABLE IF NOT EXISTS mobile_variant_sightings (
      variant_key TEXT NOT NULL REFERENCES mobile_device_variants(variant_key),
      source_key TEXT NOT NULL REFERENCES mobile_sources(source_key),
      observed_on TEXT NOT NULL CHECK (date(observed_on) IS observed_on),
      batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id),
      PRIMARY KEY (variant_key, source_key, observed_on)
    );

    CREATE TABLE IF NOT EXISTS mobile_observations (
      observation_key TEXT PRIMARY KEY NOT NULL CHECK (length(observation_key) = 64 AND observation_key NOT GLOB '*[^0-9a-f]*'),
      subject_level TEXT NOT NULL CHECK (subject_level IN ('family', 'reference')),
      family_key TEXT REFERENCES mobile_device_families(family_key),
      reference_key TEXT REFERENCES mobile_hardware_references(reference_key),
      field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 40 AND field NOT GLOB '*[^a-z0-9_]*' AND field NOT IN ('gpu_tier', 'cpu_tier', 'gpu_vram_gb', 'vram_gb', 'dedicated_vram_gb', 'tdp_watts', 'fps', 'measured_fps', 'avg_fps', 'benchmark_score', 'performance_tier', 'virtual_ram_gb')),
      value_state TEXT NOT NULL CHECK (value_state IN ('stated', 'not_stated_by_source')),
      value_text TEXT CHECK (value_text IS NULL OR (length(value_text) BETWEEN 1 AND 80 AND instr(value_text, char(10)) = 0)),
      value_number REAL,
      value_json TEXT CHECK (value_json IS NULL OR (json_valid(value_json) AND json_type(value_json) = 'array' AND length(value_json) <= 200)),
      unit TEXT CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 8),
      is_exhaustive INTEGER CHECK (is_exhaustive IS NULL OR is_exhaustive IN (0, 1)),
      market TEXT NOT NULL CHECK (market IN ('GLOBAL', 'UNSPECIFIED') OR (length(market) = 2 AND market NOT GLOB '*[^A-Z]*')),
      scope_qualifier TEXT NOT NULL CHECK (scope_qualifier IN ('none', 'market_dependent', 'enterprise_edition_only')),
      source_key TEXT NOT NULL REFERENCES mobile_sources(source_key),
      observed_on TEXT NOT NULL CHECK (date(observed_on) IS observed_on),
      source_updated_at TEXT CHECK (source_updated_at IS NULL OR date(source_updated_at) IS source_updated_at),
      review_state TEXT NOT NULL CHECK (review_state IN ('accepted', 'quarantined', 'superseded')),
      quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR quarantine_reason IN ('source_conflict', 'regional_assignment_unresolved', 'enterprise_scope_not_retail', 'research_declared_unresolved')),
      quarantine_origin TEXT CHECK (quarantine_origin IS NULL OR quarantine_origin IN ('input_declared', 'importer_rule')),
      quarantined_batch_id TEXT REFERENCES mobile_import_batches(batch_id),
      superseded_by TEXT REFERENCES mobile_observations(observation_key),
      batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id),
      CHECK ((subject_level = 'family') = (family_key IS NOT NULL AND reference_key IS NULL)),
      CHECK ((subject_level = 'reference') = (reference_key IS NOT NULL AND family_key IS NULL)),
      CHECK ((value_state = 'not_stated_by_source') = (value_text IS NULL AND value_number IS NULL AND value_json IS NULL)),
      CHECK ((value_text IS NOT NULL) + (value_number IS NOT NULL) + (value_json IS NOT NULL) <= 1),
      CHECK ((review_state = 'quarantined') = (quarantine_reason IS NOT NULL)),
      CHECK ((quarantine_reason IS NULL) = (quarantine_origin IS NULL)),
      CHECK ((quarantine_reason IS NULL) = (quarantined_batch_id IS NULL)),
      CHECK ((review_state = 'superseded') = (superseded_by IS NOT NULL)),
      CHECK (scope_qualifier <> 'enterprise_edition_only' OR review_state = 'quarantined'),
      CHECK (superseded_by IS NULL OR superseded_by <> observation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_observations_family ON mobile_observations(family_key, field);
    CREATE INDEX IF NOT EXISTS idx_mobile_observations_reference ON mobile_observations(reference_key, field);

    CREATE TABLE IF NOT EXISTS mobile_listing_observations (
      listing_key TEXT PRIMARY KEY NOT NULL CHECK (length(listing_key) = 64 AND listing_key NOT GLOB '*[^0-9a-f]*'),
      reference_key TEXT NOT NULL REFERENCES mobile_hardware_references(reference_key),
      store TEXT NOT NULL CHECK (store IN ('apple_app_store', 'google_play')),
      store_country TEXT NOT NULL CHECK (length(store_country) = 2 AND store_country NOT GLOB '*[^A-Z]*'),
      store_app_id TEXT NOT NULL CHECK (length(store_app_id) BETWEEN 1 AND 160 AND store_app_id NOT GLOB '*[^A-Za-z0-9._]*'),
      game_title TEXT NOT NULL CHECK (length(game_title) BETWEEN 1 AND 80 AND instr(game_title, char(10)) = 0),
      evidence_kind TEXT NOT NULL CHECK (evidence_kind = 'publisher_listed'),
      match_basis TEXT NOT NULL CHECK (match_basis = 'publisher_device_name'),
      listed_name TEXT CHECK (listed_name IS NULL OR (length(listed_name) BETWEEN 1 AND 80 AND instr(listed_name, char(10)) = 0)),
      required_os TEXT CHECK (required_os IS NULL OR (length(required_os) BETWEEN 1 AND 24 AND instr(required_os, char(10)) = 0)),
      source_key TEXT NOT NULL REFERENCES mobile_sources(source_key),
      observed_on TEXT NOT NULL CHECK (date(observed_on) IS observed_on),
      batch_id TEXT NOT NULL REFERENCES mobile_import_batches(batch_id),
      UNIQUE (reference_key, store, store_country, store_app_id, source_key, observed_on)
    );
`;

// AI-095 shared identities and admitted evidence; see DOCS/catalogue/SOURCES.md.
const DPX_IDENTITY_DDL = `
    CREATE TABLE IF NOT EXISTS dpx_import_batches (
      batch_id TEXT PRIMARY KEY NOT NULL CHECK (length(batch_id) = 36),
      contract TEXT NOT NULL CHECK (contract = 'mgpl-dpx-identity/1'),
      input_sha256 TEXT NOT NULL UNIQUE CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
      plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_records INTEGER NOT NULL CHECK (input_records >= 1),
      inserted_count INTEGER NOT NULL CHECK (inserted_count >= 1),
      unchanged_count INTEGER NOT NULL CHECK (unchanged_count >= 0),
      applied_at TEXT NOT NULL CHECK (applied_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
      CHECK (inserted_count + unchanged_count = input_records)
    );

    CREATE TABLE IF NOT EXISTS dpx_game_works (
      work_key TEXT PRIMARY KEY NOT NULL CHECK (
        (work_key GLOB 'wd:Q[1-9]*' AND length(work_key) BETWEEN 5 AND 16 AND substr(work_key, 5) NOT GLOB '*[^0-9]*')
        OR (work_key GLOB 'mgpl:[a-z0-9]*' AND length(work_key) BETWEEN 6 AND 69 AND substr(work_key, 6) NOT GLOB '*[^a-z0-9-]*')),
      key_scheme TEXT NOT NULL CHECK (key_scheme IN ('wikidata', 'mgpl')),
      wikidata_qid TEXT CHECK (wikidata_qid IS NULL OR wikidata_qid = substr(work_key, 4)),
      basis_source_id TEXT NOT NULL CHECK (length(basis_source_id) BETWEEN 1 AND 40 AND basis_source_id NOT GLOB '*[^a-z0-9-]*'),
      basis_url TEXT NOT NULL CHECK (basis_url GLOB 'https://?*' AND length(basis_url) <= 500),
      basis_observed_on TEXT NOT NULL CHECK (date(basis_observed_on) IS basis_observed_on),
      first_batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id),
      CHECK ((key_scheme = 'wikidata') = (work_key GLOB 'wd:*')),
      CHECK ((key_scheme = 'wikidata') = (wikidata_qid IS NOT NULL)),
      CHECK ((key_scheme = 'wikidata') = (basis_source_id = 'wikidata'))
    );

    CREATE TABLE IF NOT EXISTS dpx_work_links (
      mgpl_work_key TEXT PRIMARY KEY NOT NULL CHECK (mgpl_work_key GLOB 'mgpl:*') REFERENCES dpx_game_works(work_key),
      wikidata_work_key TEXT NOT NULL CHECK (wikidata_work_key GLOB 'wd:Q*') REFERENCES dpx_game_works(work_key),
      basis_source_id TEXT NOT NULL CHECK (length(basis_source_id) BETWEEN 1 AND 40 AND basis_source_id NOT GLOB '*[^a-z0-9-]*'),
      basis_url TEXT NOT NULL CHECK (basis_url GLOB 'https://?*' AND length(basis_url) <= 500),
      basis_observed_on TEXT NOT NULL CHECK (date(basis_observed_on) IS basis_observed_on),
      first_batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dpx_work_links_wikidata ON dpx_work_links(wikidata_work_key);

    CREATE TABLE IF NOT EXISTS dpx_game_editions (
      edition_key TEXT PRIMARY KEY NOT NULL CHECK (length(edition_key) <= 118 AND edition_key NOT GLOB '*[^A-Za-z0-9:/-]*'),
      work_key TEXT NOT NULL REFERENCES dpx_game_works(work_key),
      edition_slug TEXT NOT NULL CHECK (length(edition_slug) BETWEEN 1 AND 48 AND edition_slug GLOB '[a-z0-9]*' AND edition_slug NOT GLOB '*[^a-z0-9-]*'),
      basis_source_id TEXT NOT NULL CHECK (length(basis_source_id) BETWEEN 1 AND 40 AND basis_source_id NOT GLOB '*[^a-z0-9-]*'),
      basis_url TEXT NOT NULL CHECK (basis_url GLOB 'https://?*' AND length(basis_url) <= 500),
      basis_observed_on TEXT NOT NULL CHECK (date(basis_observed_on) IS basis_observed_on),
      first_batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id),
      CHECK (edition_key = work_key || '/' || edition_slug)
    );

    CREATE INDEX IF NOT EXISTS idx_dpx_editions_work ON dpx_game_editions(work_key);

    CREATE TABLE IF NOT EXISTS dpx_store_products (
      store TEXT NOT NULL CHECK (store IN ('apple_app_store', 'google_play', 'steam', 'playstation_store', 'microsoft_store', 'nintendo_eshop')),
      store_app_id TEXT NOT NULL CHECK (length(store_app_id) BETWEEN 1 AND 150 AND store_app_id NOT GLOB '*[^A-Za-z0-9._-]*'),
      edition_key TEXT NOT NULL REFERENCES dpx_game_editions(edition_key),
      basis_source_id TEXT NOT NULL CHECK (length(basis_source_id) BETWEEN 1 AND 40 AND basis_source_id NOT GLOB '*[^a-z0-9-]*'),
      basis_url TEXT NOT NULL CHECK (basis_url GLOB 'https://?*' AND length(basis_url) <= 500),
      basis_observed_on TEXT NOT NULL CHECK (date(basis_observed_on) IS basis_observed_on),
      first_batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id),
      PRIMARY KEY (store, store_app_id),
      CHECK (store NOT IN ('apple_app_store', 'steam') OR (store_app_id GLOB '[1-9]*' AND store_app_id NOT GLOB '*[^0-9]*' AND length(store_app_id) <= (CASE store WHEN 'steam' THEN 10 ELSE 12 END))),
      CHECK (store <> 'google_play' OR (store_app_id GLOB '[A-Za-z]*.[A-Za-z]*' AND store_app_id NOT GLOB '*[^A-Za-z0-9._]*')),
      CHECK (store IN ('apple_app_store', 'steam', 'google_play') OR (length(store_app_id) <= 64 AND store_app_id GLOB '[A-Za-z0-9]*'))
    );

    CREATE INDEX IF NOT EXISTS idx_dpx_store_products_edition ON dpx_store_products(edition_key);

    CREATE TABLE IF NOT EXISTS dpx_hardware_families (
      family_key TEXT PRIMARY KEY NOT NULL CHECK (length(family_key) <= 80 AND family_key GLOB '[a-z]*:[a-z0-9]*' AND family_key NOT GLOB '*:*:*' AND family_key NOT GLOB '*[^a-z0-9:-]*'),
      manufacturer TEXT NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 40 AND instr(manufacturer, char(10)) = 0),
      hardware_class TEXT NOT NULL CHECK (hardware_class IN ('console', 'handheld', 'pc', 'pc_component', 'display', 'peripheral', 'xr_headset', 'cable_adapter')),
      marketing_name TEXT NOT NULL CHECK (length(marketing_name) BETWEEN 1 AND 80 AND instr(marketing_name, char(10)) = 0),
      basis_source_id TEXT NOT NULL CHECK (length(basis_source_id) BETWEEN 1 AND 40 AND basis_source_id NOT GLOB '*[^a-z0-9-]*'),
      basis_url TEXT NOT NULL CHECK (basis_url GLOB 'https://?*' AND length(basis_url) <= 500),
      basis_observed_on TEXT NOT NULL CHECK (date(basis_observed_on) IS basis_observed_on),
      first_batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id),
      UNIQUE (family_key, hardware_class)
    );

    CREATE TABLE IF NOT EXISTS dpx_hardware_references (
      reference_key TEXT PRIMARY KEY NOT NULL CHECK (length(reference_key) <= 120 AND reference_key NOT GLOB '*[^a-z0-9:-]*'),
      family_key TEXT NOT NULL,
      hardware_class TEXT NOT NULL,
      maker TEXT NOT NULL,
      reference_label TEXT NOT NULL CHECK (length(reference_label) BETWEEN 1 AND 80 AND instr(reference_label, char(10)) = 0),
      configuration TEXT NOT NULL CHECK (length(configuration) BETWEEN 1 AND 32 AND configuration GLOB '[a-z0-9]*' AND configuration NOT GLOB '*[^a-z0-9-]*'),
      scope_market TEXT CHECK (scope_market IS NULL OR scope_market IN ('GLOBAL', 'UNSPECIFIED') OR (length(scope_market) = 2 AND scope_market NOT GLOB '*[^A-Z]*')),
      model_code TEXT CHECK (model_code IS NULL OR (length(model_code) BETWEEN 2 AND 24 AND model_code NOT GLOB '*[^A-Za-z0-9-]*')),
      basis_source_id TEXT NOT NULL CHECK (length(basis_source_id) BETWEEN 1 AND 40 AND basis_source_id NOT GLOB '*[^a-z0-9-]*'),
      basis_url TEXT NOT NULL CHECK (basis_url GLOB 'https://?*' AND length(basis_url) <= 500),
      basis_observed_on TEXT NOT NULL CHECK (date(basis_observed_on) IS basis_observed_on),
      first_batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id),
      FOREIGN KEY (family_key, hardware_class) REFERENCES dpx_hardware_families(family_key, hardware_class),
      UNIQUE (reference_key, hardware_class),
      CHECK (maker = substr(family_key, 1, instr(family_key, ':') - 1)),
      CHECK (substr(reference_key, 1, length(family_key) + 1) = family_key || ':' AND length(reference_key) > length(family_key) + 1),
      CHECK ((model_code IS NULL) = (scope_market IS NOT NULL))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dpx_references_model_code
      ON dpx_hardware_references(maker, model_code COLLATE NOCASE) WHERE model_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dpx_references_scope
      ON dpx_hardware_references(family_key, scope_market, configuration) WHERE model_code IS NULL;
    CREATE INDEX IF NOT EXISTS idx_dpx_references_family ON dpx_hardware_references(family_key);

    CREATE TABLE IF NOT EXISTS dpx_evidence_observations (
      observation_key TEXT PRIMARY KEY NOT NULL CHECK (length(observation_key) = 64 AND observation_key NOT GLOB '*[^0-9a-f]*'),
      contract TEXT NOT NULL CHECK (contract = 'mgpl-dpx-evidence/1'),
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('mobile_family', 'mobile_reference', 'mobile_variant', 'hardware_reference', 'hardware_port', 'game_work', 'game_edition', 'game_build', 'store_listing', 'os_release', 'pairing')),
      subject_json TEXT NOT NULL CHECK (length(subject_json) <= 1000 AND json_valid(subject_json) AND json_type(subject_json) = 'object' AND json_extract(subject_json, '$.kind') = subject_kind),
      work_key TEXT REFERENCES dpx_game_works(work_key),
      edition_key TEXT REFERENCES dpx_game_editions(edition_key),
      build_platform TEXT,
      build_version TEXT,
      store TEXT,
      store_app_id TEXT,
      listing_country TEXT,
      hardware_class TEXT,
      hardware_reference_key TEXT,
      port_id TEXT,
      os_product TEXT,
      release_name TEXT,
      mobile_family_key TEXT,
      mobile_reference_key TEXT,
      mobile_variant_key TEXT,
      field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 40 AND field NOT GLOB '*[^a-z0-9_]*'),
      value_state TEXT NOT NULL CHECK (value_state IN ('stated', 'unknown')),
      value_json TEXT CHECK (value_json IS NULL OR (length(value_json) <= 16000 AND json_valid(value_json))),
      unit TEXT CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 8),
      unknown_reason TEXT CHECK (unknown_reason IS NULL OR unknown_reason IN ('not_published', 'not_listed', 'source_unavailable', 'subject_ambiguous')),
      basis TEXT CHECK (basis IS NULL OR basis IN ('documented', 'measured', 'derived')),
      list_exhaustive INTEGER CHECK (list_exhaustive IS NULL OR list_exhaustive IN (0, 1)),
      country TEXT NOT NULL CHECK (country IN ('GLOBAL', 'UNSPECIFIED') OR (length(country) = 2 AND country NOT GLOB '*[^A-Z]*')),
      source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 40 AND source_id NOT GLOB '*[^a-z0-9-]*'),
      source_url TEXT NOT NULL CHECK (source_url GLOB 'https://?*' AND length(source_url) <= 500),
      source_version TEXT CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 64),
      collection TEXT NOT NULL CHECK (collection IN ('manual_read', 'bounded_get')),
      observed_at TEXT NOT NULL CHECK (
        (length(observed_at) = 10 AND date(observed_at) IS observed_at)
        OR (length(observed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', observed_at) IS observed_at)),
      source_updated_at TEXT CHECK (source_updated_at IS NULL OR date(source_updated_at) IS source_updated_at),
      reviewed_on TEXT CHECK (reviewed_on IS NULL OR date(reviewed_on) IS reviewed_on),
      classification TEXT NOT NULL CHECK (classification IN ('origin_verified', 'attested_only')),
      effective_publish TEXT NOT NULL CHECK (effective_publish IN ('fact_with_attribution', 'link_only', 'withheld')),
      batch_id TEXT NOT NULL REFERENCES dpx_import_batches(batch_id),
      FOREIGN KEY (store, store_app_id) REFERENCES dpx_store_products(store, store_app_id),
      FOREIGN KEY (hardware_reference_key, hardware_class) REFERENCES dpx_hardware_references(reference_key, hardware_class),
      CHECK (classification = 'origin_verified' OR effective_publish = 'withheld'),
      CHECK ((value_state = 'stated') = (value_json IS NOT NULL)),
      CHECK ((value_state = 'stated') = (basis IS NOT NULL)),
      CHECK ((value_state = 'unknown') = (unknown_reason IS NOT NULL)),
      CHECK (unknown_reason IS NOT 'not_listed' OR list_exhaustive = 0),
      CHECK ((collection = 'manual_read') = (reviewed_on IS NOT NULL)),
      CHECK (reviewed_on IS NULL OR reviewed_on >= substr(observed_at, 1, 10)),
      CHECK (source_updated_at IS NULL OR source_updated_at <= substr(observed_at, 1, 10)),
      CHECK (work_key IS json_extract(subject_json, '$.work_key')),
      CHECK (edition_key IS coalesce(json_extract(subject_json, '$.edition_key'), json_extract(subject_json, '$.game.edition_key'))),
      CHECK (build_platform IS coalesce(json_extract(subject_json, '$.platform'), json_extract(subject_json, '$.game.platform'))),
      CHECK (build_version IS coalesce(json_extract(subject_json, '$.version'), json_extract(subject_json, '$.game.version'))),
      CHECK (store IS coalesce(json_extract(subject_json, '$.store'), json_extract(subject_json, '$.game.store'))),
      CHECK (store_app_id IS coalesce(json_extract(subject_json, '$.store_app_id'), json_extract(subject_json, '$.game.store_app_id'))),
      CHECK (listing_country IS coalesce(json_extract(subject_json, '$.country'), json_extract(subject_json, '$.game.country'))),
      CHECK (hardware_class IS coalesce(json_extract(subject_json, '$.hardware_class'), json_extract(subject_json, '$.device.hardware_class'))),
      CHECK (hardware_reference_key IS (CASE
        WHEN subject_kind IN ('hardware_reference', 'hardware_port') THEN json_extract(subject_json, '$.reference_key')
        WHEN json_extract(subject_json, '$.device.kind') = 'hardware_reference' THEN json_extract(subject_json, '$.device.reference_key')
        END)),
      CHECK (port_id IS json_extract(subject_json, '$.port_id')),
      CHECK (os_product IS json_extract(subject_json, '$.os_product')),
      CHECK (release_name IS json_extract(subject_json, '$.release')),
      CHECK (mobile_family_key IS json_extract(subject_json, '$.family_key')),
      CHECK (mobile_reference_key IS (CASE
        WHEN subject_kind = 'mobile_reference' THEN json_extract(subject_json, '$.reference_key')
        WHEN json_extract(subject_json, '$.device.kind') = 'mobile_reference' THEN json_extract(subject_json, '$.device.reference_key')
        END)),
      CHECK (mobile_variant_key IS coalesce(json_extract(subject_json, '$.variant_key'), json_extract(subject_json, '$.device.variant_key'))),
      CHECK (subject_kind <> 'game_work' OR work_key IS NOT NULL),
      CHECK (subject_kind NOT IN ('game_edition', 'game_build') OR edition_key IS NOT NULL),
      CHECK (subject_kind <> 'store_listing' OR (store IS NOT NULL AND store_app_id IS NOT NULL AND listing_country IS NOT NULL)),
      CHECK (subject_kind NOT IN ('hardware_reference', 'hardware_port') OR hardware_reference_key IS NOT NULL),
      CHECK (subject_kind <> 'hardware_port' OR port_id IS NOT NULL),
      CHECK (subject_kind <> 'os_release' OR (os_product IS NOT NULL AND release_name IS NOT NULL)),
      CHECK (subject_kind <> 'mobile_family' OR mobile_family_key IS NOT NULL),
      CHECK (subject_kind <> 'mobile_reference' OR mobile_reference_key IS NOT NULL),
      CHECK (subject_kind <> 'mobile_variant' OR mobile_variant_key IS NOT NULL),
      CHECK (subject_kind <> 'pairing' OR (
        (edition_key IS NOT NULL OR store_app_id IS NOT NULL)
        AND (hardware_reference_key IS NOT NULL OR mobile_reference_key IS NOT NULL OR mobile_variant_key IS NOT NULL)))
    );

    CREATE INDEX IF NOT EXISTS idx_dpx_evidence_subject ON dpx_evidence_observations(field, subject_json);
    CREATE INDEX IF NOT EXISTS idx_dpx_evidence_edition ON dpx_evidence_observations(edition_key);
    CREATE INDEX IF NOT EXISTS idx_dpx_evidence_store ON dpx_evidence_observations(store, store_app_id);
    CREATE INDEX IF NOT EXISTS idx_dpx_evidence_hardware ON dpx_evidence_observations(hardware_reference_key);
    CREATE INDEX IF NOT EXISTS idx_dpx_evidence_mobile ON dpx_evidence_observations(mobile_reference_key, mobile_variant_key);
`;

export function initDb(): void {
  // Guarded migration for AppPriceAlerts schema
  try {
    const alertsInfo = db.prepare('PRAGMA table_info("AppPriceAlerts")').all() as any[];
    const hasGameId = alertsInfo.some((c) => c.name === "gameId");
    if (alertsInfo.length > 0 && !hasGameId) {
      db.prepare('DROP TABLE "AppPriceAlerts"').run();
    }
  } catch (e) {
    console.error("Failed to inspect/drop legacy AppPriceAlerts:", e);
  }

  // Sprint 1 (EPIC-DEV-001): Guarded catalog migration for pre-existing
  // databases. A leftover `catalog_devices` table from a partial earlier run
  // may lack the sprint-1 catalog columns; `CREATE TABLE IF NOT EXISTS` would
  // be a no-op against it and the index DDL below would then fail with
  // "no such column: type". The catalog is purely deterministic seed data
  // (INSERT OR IGNORE, no user data), so dropping the stale shapes and letting
  // the authoritative DDL rebuild them is safe and matches the AppPriceAlerts
  // legacy-drop pattern. NOTE: the catalog intentionally uses the
  // `catalog_devices` / `catalog_device_specs` names because SQLite table names
  // are case-insensitive and a lowercase `devices` table would permanently
  // collide with the pre-existing legacy scanned `Devices` table.
  try {
    const catalogInfo = db.prepare('PRAGMA table_info("catalog_devices")').all() as any[];
    if (catalogInfo.length > 0 && !catalogInfo.some((c) => c.name === "type")) {
      db.pragma("foreign_keys = OFF");
      db.prepare('DROP TABLE IF EXISTS "catalog_devices"').run();
      db.prepare('DROP TABLE IF EXISTS "catalog_device_specs"').run();
      db.pragma("foreign_keys = ON");
      console.log(
        "[db] Dropped legacy catalog_devices/catalog_device_specs tables (missing type column) for authoritative rebuild.",
      );
    }
  } catch (e) {
    console.error("Failed to migrate legacy catalog tables:", e);
  }

  db.exec(`
    -- Sprint 2 (FEAT-MULTITENANT): AuthUsers must be declared before the
    -- user-state tables below reference it via FOREIGN KEY. The full
    -- declaration later in this block is a no-op via IF NOT EXISTS.
    CREATE TABLE IF NOT EXISTS AuthUsers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      passwordHash TEXT,
      displayName TEXT,
      avatarUrl TEXT,
      gamerTag TEXT,
      profileVisibility TEXT NOT NULL DEFAULT 'private',
      libraryVisibility TEXT NOT NULL DEFAULT 'private',
      role TEXT NOT NULL DEFAULT 'user',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS AppDealsWishlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      steamAppId TEXT,
      gameTitle TEXT UNIQUE,
      targetPrice REAL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS AppPriceAlerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      gameId TEXT NOT NULL,
      title TEXT NOT NULL,
      targetPrice REAL NOT NULL,
      currentPrice REAL,
      historicalLow REAL,
      isTriggered INTEGER DEFAULT 0,
      acknowledged INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
      UNIQUE(userId, gameId)
    );

    CREATE INDEX IF NOT EXISTS idx_wishlist_appId ON AppDealsWishlist(steamAppId);

    CREATE TABLE IF NOT EXISTS InstalledMods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modId TEXT NOT NULL,
      gameDomain TEXT NOT NULL,
      modName TEXT NOT NULL,
      version TEXT,
      installedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(modId, gameDomain)
    );

    -- Sprint 5 (EPIC-06): Mods Ecosystem backend ingestion. Non-PII global mod
    -- catalog linked to the game it modifies (FK -> AppGames.GameID).
    -- sourceUrl MUST pass the HTTPS + exact-match domain whitelist enforced by
    -- src/middleware/modUrlSanitizer.ts before it is persisted. Registered in
    -- src/routes/state.ts so the snapshot export/import lifecycle includes it.
    CREATE TABLE IF NOT EXISTS Mods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT NOT NULL,
      modName TEXT NOT NULL,
      author TEXT,
      sourceDomain TEXT NOT NULL,
      sourceUrl TEXT,
      downloads INTEGER DEFAULT 0,
      version TEXT,
      minVramGb INTEGER,
      minRamGb INTEGER,
      -- Sprint 2 (WUD-2.3 / EPICSEC05): strict mod metadata schema columns.
      -- Values are validated by src/utils/modSchema.ts before persistence.
      download_count INTEGER DEFAULT 0,
      active_installs INTEGER DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      version_tag TEXT,
      author_handle TEXT,
      description TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (gameId) REFERENCES AppGames(GameID),
      UNIQUE(gameId, modName, sourceDomain)
    );
    CREATE INDEX IF NOT EXISTS idx_mods_gameId ON Mods(gameId);

    -- Sprint 4 (EPICUX04): Mods Hub 2.0 persistence tables. Keyed by the Nexus
    -- gameDomain slug + stable modId string (consistent with InstalledMods),
    -- so these tables are FK-free and never collide with AppGames.GameID
    -- slugs. Registered in src/routes/state.ts for snapshot round-trip.
    CREATE TABLE IF NOT EXISTS ModVersions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameDomain TEXT NOT NULL,
      modId TEXT NOT NULL,
      version TEXT NOT NULL,
      changelog TEXT,
      releasedAt TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(gameDomain, modId, version)
    );
    CREATE INDEX IF NOT EXISTS idx_mod_versions_domain_mod ON ModVersions(gameDomain, modId);

    CREATE TABLE IF NOT EXISTS ModDependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameDomain TEXT NOT NULL,
      modId TEXT NOT NULL,
      dependsOn TEXT NOT NULL,
      isHard INTEGER NOT NULL DEFAULT 1,
      filePaths TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(gameDomain, modId, dependsOn)
    );
    CREATE INDEX IF NOT EXISTS idx_mod_dependencies_domain_mod ON ModDependencies(gameDomain, modId);

    CREATE TABLE IF NOT EXISTS ModLoadOrder (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameDomain TEXT NOT NULL,
      modId TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      isActive INTEGER NOT NULL DEFAULT 1,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(gameDomain, modId)
    );
    CREATE INDEX IF NOT EXISTS idx_mod_load_order_domain ON ModLoadOrder(gameDomain, position);

    -- Sprint 2 (WUD-2.2 / EPIC-02): Deal price-history baseline.
    -- One row per (gameId, store, day) so 24-month pure-SVG sparklines and
    -- 30-day-low / verified all-time-low detection stay local and
    -- deterministic. Registered in src/routes/state.ts for backup round-trip.
    CREATE TABLE IF NOT EXISTS AppDealPriceHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT NOT NULL,
      title TEXT,
      store TEXT NOT NULL,
      price REAL NOT NULL,
      recordedAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(gameId, store, recordedAt)
    );
    CREATE INDEX IF NOT EXISTS idx_deal_price_history_gameId ON AppDealPriceHistory(gameId);

    CREATE TABLE IF NOT EXISTS AppCompletionRoadmapCache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameTitle TEXT UNIQUE,
      mainStory REAL,
      mainExtra REAL,
      completionist REAL,
      hltbScore REAL,
      cachedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS AppGameTags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      gameId TEXT NOT NULL,
      tagName TEXT NOT NULL,
      colorHex TEXT DEFAULT '#38bdf8',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
      UNIQUE(userId, gameId, tagName)
    );

    CREATE TABLE IF NOT EXISTS AppGameNotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      gameId TEXT NOT NULL,
      noteMarkdown TEXT NOT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
      UNIQUE(userId, gameId)
    );

    CREATE TABLE IF NOT EXISTS AppWishlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      gameId TEXT NOT NULL,
      title TEXT NOT NULL,
      coverImage TEXT,
      targetPrice REAL NOT NULL,
      currentBestPrice REAL,
      bestStore TEXT,
      bestStoreType TEXT,
      historicalLow REAL,
      isTriggered INTEGER DEFAULT 0,
      notes TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
      UNIQUE(userId, gameId)
    );


    CREATE TABLE IF NOT EXISTS AppRetroTracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameTitle TEXT UNIQUE NOT NULL,
      system TEXT,
      status TEXT,
      playtimeHours REAL,
      personalRating INTEGER,
      isFavorite INTEGER DEFAULT 0,
      notes TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sprint 28 (FEAT-0153): Backlog planning & priority scoring.
    -- Persists per-game backlog state with HLTB time-to-beat and a computed
    -- priority score so the backlog hub and smart recommender share one source
    -- of truth instead of recomputing live from AppTracking each time.
    CREATE TABLE IF NOT EXISTS AppBacklog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'backlog',
      priorityScore INTEGER DEFAULT 50,
      hltbMainHours REAL,
      hltbMainExtraHours REAL,
      hltbCompletionistHours REAL,
      etaDays REAL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sprint 28 (FEAT-0153): Play session tracking & stopwatch timing.
    -- One row per completed play session. sessionUuid is client-generated so
    -- offline queue flushes are idempotent (replay is a no-op on the server).
    CREATE TABLE IF NOT EXISTS AppPlaySessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionUuid TEXT UNIQUE NOT NULL,
      gameId TEXT NOT NULL,
      startedAt DATETIME,
      endedAt DATETIME,
      durationSeconds INTEGER NOT NULL DEFAULT 0,
      deviceId TEXT,
      synced INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sprint 1 (FEAT-AUTH-0001): Native auth core.
    -- AuthUsers/AuthAccounts mirror the Prisma models (schema.prisma) so the
    -- raw-SQL self-healing layer and the Prisma client stay consistent even
    -- before prisma db push is run on a fresh checkout.
    --
    -- Sprint 1 (EPIC-PROFILE-0001): Profile identity, password & privacy
    -- fields. profileVisibility defaults to 'private' so every new profile
    -- starts private; gamerTag uniqueness is enforced by the partial unique
    -- index created in ensureAuthUserProfileColumns() below.
    CREATE TABLE IF NOT EXISTS AuthUsers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      passwordHash TEXT,
      displayName TEXT,
      avatarUrl TEXT,
      gamerTag TEXT,
      profileVisibility TEXT NOT NULL DEFAULT 'private',
      libraryVisibility TEXT NOT NULL DEFAULT 'private',
      role TEXT NOT NULL DEFAULT 'user',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS AuthAccounts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      provider TEXT NOT NULL,
      providerAccountId TEXT NOT NULL,
      tokenEnc TEXT,
      tokenIv TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, providerAccountId),
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_auth_accounts_userId ON AuthAccounts(userId);

    -- Sprint 2 (EPIC-PROFILE-0001): Connected storefront identity hub.
    -- Optional public gaming handles (Steam / PSN / Xbox / GOG / Epic / Ubisoft)
    -- stored in a dedicated one-per-user row. userId is UNIQUE so each AuthUser
    -- owns at most one handle row; cascading delete keeps the identity storage
    -- clean when an AuthUser is removed. hidePlatformIds defaults to 0 so
    -- handles are visible by default and masked only when the user opts in.
    CREATE TABLE IF NOT EXISTS AppPlatformHandles (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL UNIQUE,
      steamUsername TEXT,
      psnId TEXT,
      xboxGamertag TEXT,
      gogUsername TEXT,
      epicUsername TEXT,
      ubisoftUsername TEXT,
      hidePlatformIds INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_platform_handles_userId ON AppPlatformHandles(userId);

    -- Sprint 2 (WUD-2.1 / EPIC-01): Local encrypted platform-link vault.
    -- One row per connected storefront profile. Tokens are AES-256-GCM encrypted
    -- at rest (tokenEnc/tokenIv) and NEVER sync externally or leave the local
    -- SQLite WAL. displayHandle is the masked public handle rendered on profile
    -- views. UNIQUE(userId, platform) guarantees one connection per platform.
    CREATE TABLE IF NOT EXISTS AuthPlatformLinks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      platform TEXT NOT NULL,
      publicId TEXT NOT NULL,
      displayHandle TEXT,
      tokenEnc TEXT,
      tokenIv TEXT,
      connectedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lastSyncedAt DATETIME,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
      UNIQUE(userId, platform)
    );

    CREATE INDEX IF NOT EXISTS idx_auth_platform_links_userId ON AuthPlatformLinks(userId);

    -- Sprint 3 (EPIC-PROFILE-0001): privacy-minimized social connections engine.
    -- One directed row per connection; accepted friendships are surfaced
    -- bidirectionally by the social routes. The composite UNIQUE(userId,
    -- friendId) prevents duplicate pairs; cascade deletes keep the graph clean
    -- when an AuthUser is removed.
    CREATE TABLE IF NOT EXISTS AppFriendships (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      friendId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'manual',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(userId, friendId),
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
      FOREIGN KEY (friendId) REFERENCES AuthUsers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_friendships_userId ON AppFriendships(userId);
    CREATE INDEX IF NOT EXISTS idx_friendships_friendId ON AppFriendships(friendId);

    CREATE INDEX IF NOT EXISTS idx_backlog_gameId ON AppBacklog(gameId);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_gameId ON AppPlaySessions(gameId);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_synced ON AppPlaySessions(synced);

    -- Core library tables (AppGames, AppTracking, Devices, AppOwnership) are
    -- created here so the server's initDb() DDL block is self-sufficient. The
    -- indexes below reference these tables, so they MUST exist before the index
    -- creation statements run. In the test harness these tables are also seeded
    -- by test/global-setup.ts; CREATE TABLE IF NOT EXISTS keeps both paths safe.
    CREATE TABLE IF NOT EXISTS AppTracking (
      "GameID" TEXT PRIMARY KEY,
      "Play Status" TEXT DEFAULT 'Not Started',
      "Want to Play?" TEXT,
      "Personal Rating (1-10)" INTEGER,
      "Hours Played" REAL DEFAULT 0,
      "Last Played Date" TEXT,
      "Played Platform" TEXT,
      "Played Hardware Device" TEXT,
      "Completed Date" TEXT,
      "Replay Interest" TEXT,
      "DLC Status" TEXT,
      "Personal Review" TEXT,
      "Notes" TEXT,
      "targetTdp" TEXT,
      "targetFps" TEXT,
      "resolution" TEXT,
      "cpuBoost" TEXT,
      "tuningNotes" TEXT,
      "playNotes" TEXT,
      "achievementNotes" TEXT,
      "tags" TEXT,
      "Trophy Progress" INTEGER,
      "targetStyle" TEXT
    );


    CREATE TABLE IF NOT EXISTS AppGames (
      "GameID" TEXT PRIMARY KEY,
      "Game Title" TEXT,
      "Primary Genre" TEXT,
      "Storage Size" TEXT,
      "Min RAM GB" REAL,
      "Min VRAM GB" REAL,
      "SSD Required?" TEXT,
      "Active" TEXT,
      "Nexus Mods URL" TEXT,
      "cover_url" TEXT,
      "nexusUrl" TEXT,
      "nexusModCount" INTEGER,
      "trackedModCount" INTEGER,
      "platformStoreUrls" TEXT,
      "storeUrl" TEXT,
      "storefront" TEXT,
      "criticScore" REAL,
      "reviewSource" TEXT,
      "enrichmentStatus" TEXT,
      "enrichmentConfidence" REAL,
      "originalGameReleaseDate" TEXT,
      "publisher" TEXT,
      "headerImage" TEXT,
      "Date Added" TEXT,
      "Last Modified" TEXT
    );

    -- AI-0NN / G-2: append-only enrichment staging. This table is deliberately
    -- standalone: it has no foreign key into AppGames and is not user state.
    CREATE TABLE IF NOT EXISTS AppGames_Staging (
      staging_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source TEXT NOT NULL,
      fetched_at DATETIME NOT NULL,
      game_id TEXT NOT NULL,
      title TEXT NOT NULL,
      publisher TEXT,
      original_game_release_date TEXT,
      confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
      steam_app_id TEXT,
      studio TEXT,
      tags TEXT,
      source_citation TEXT,
      UNIQUE(run_id, game_id)
    );

    CREATE INDEX IF NOT EXISTS idx_appgames_staging_run_id ON AppGames_Staging(run_id);

    -- #158 / WU-033b: the reference game catalogue (DOCS/catalogue/SOURCES.md), kept apart from
    -- the app's own AppGames rows and from user state. Written only by the reviewed promotion
    -- functions in src/services/enrichmentPromotion.ts. CatalogueFacts holds values two sources
    -- agree on; CatalogueDrafts holds model drafts, always labelled generated, each with the
    -- accepted sample check it was promoted under.
    CREATE TABLE IF NOT EXISTS CatalogueGames (
      qid TEXT PRIMARY KEY NOT NULL CHECK (qid GLOB 'Q[1-9]*' AND qid NOT GLOB 'Q*[^0-9]*'),
      title TEXT,
      steam_appid TEXT,
      wikidata_url TEXT NOT NULL,
      loaded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_catalogue_games_steam_appid ON CatalogueGames(steam_appid);

    CREATE TABLE IF NOT EXISTS CatalogueFacts (
      qid TEXT NOT NULL REFERENCES CatalogueGames(qid),
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      basis TEXT,
      sources TEXT NOT NULL,
      loaded_at TEXT NOT NULL,
      PRIMARY KEY (qid, field)
    );

    CREATE TABLE IF NOT EXISTS CatalogueDrafts (
      qid TEXT NOT NULL REFERENCES CatalogueGames(qid),
      kind TEXT NOT NULL CHECK (kind IN ('description', 'friction', 'genre')),
      value TEXT NOT NULL,
      label TEXT NOT NULL CHECK (label = 'generated'),
      sourced TEXT,
      overrides TEXT,
      text_sha256 TEXT NOT NULL,
      links TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      run_id TEXT,
      attempt_id TEXT,
      drafted_at TEXT NOT NULL,
      sample_summary_sha256 TEXT NOT NULL,
      sample_seed TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      promoted_at TEXT NOT NULL,
      PRIMARY KEY (qid, kind)
    );

    -- #158 / WU-032b: catalogue embeddings for semantic similarity.
    -- Holds 768-dimensional float32 little-endian vectors for games with promoted descriptions.
    CREATE TABLE IF NOT EXISTS CatalogueEmbeddings (
      qid TEXT PRIMARY KEY NOT NULL CHECK (qid GLOB 'Q[1-9]*' AND qid NOT GLOB 'Q*[^0-9]*') REFERENCES CatalogueGames(qid),
      model TEXT NOT NULL,
      task_type TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions = 768),
      vector BLOB NOT NULL CHECK (length(vector) = 3072),
      text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
      description_sha256 TEXT NOT NULL CHECK (length(description_sha256) = 64),
      description_run_id TEXT,
      description_attempt_id TEXT,
      embedding_run_id TEXT NOT NULL,
      embedding_attempt_id TEXT,
      embedded_at TEXT NOT NULL,
      loaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Devices (
      deviceId TEXT PRIMARY KEY,
      deviceName TEXT,
      formFactor TEXT,
      gpuModel TEXT,
      vramGb REAL,
      cpuModel TEXT,
      ramGb REAL,
      motherboard TEXT,
      caseModel TEXT,
      psu TEXT,
      storageCapacityGb REAL,
      os TEXT,
      batteryWh REAL,
      isArchived INTEGER DEFAULT 0,
      tdpWatts REAL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS AppDevices (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      deviceName TEXT NOT NULL,
      deviceType TEXT NOT NULL,
      cpuModel TEXT,
      cpuCores INTEGER,
      ramGb REAL,
      gpuModel TEXT,
      vramGb REAL,
      gpuType TEXT,
      storageType TEXT,
      storageFreeGb REAL,
      isPortable INTEGER DEFAULT 0,
      isPrimary INTEGER DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_app_devices_userId ON AppDevices(userId);

    -- Sprint 1 (EPIC-DEV-001): Browsable hardware catalog. The
    -- catalog_devices table holds retail-facing device rows (consoles,
    -- handhelds, prebuilt PCs and laptops) and catalog_device_specs holds one
    -- detailed spec row per device (UNIQUE deviceId). The names avoid a
    -- case-insensitive SQLite collision with the pre-existing legacy scanned
    -- Devices table, and the catalog is intentionally separate from the
    -- user-scoped AppDevices profiles.
    CREATE TABLE IF NOT EXISTS "catalog_devices" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('PC', 'Console', 'Handheld')),
      releaseDate TEXT,
      msrp REAL,
      imageUrl TEXT,
      isPrebuilt INTEGER DEFAULT 0,
      platformCanonical TEXT
    );

    CREATE TABLE IF NOT EXISTS "catalog_device_specs" (
      specId INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceId TEXT NOT NULL UNIQUE,
      cpuModel TEXT,
      gpuModel TEXT,
      gpuVramGb REAL,
      ramGb REAL,
      storageGb REAL,
      tdpWatts REAL,
      gpuTier TEXT,
      cpuTier TEXT,
      FOREIGN KEY (deviceId) REFERENCES "catalog_devices"(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_devices_type ON "catalog_devices"(type);
    CREATE INDEX IF NOT EXISTS idx_catalog_devices_brand ON "catalog_devices"(brand);
    CREATE INDEX IF NOT EXISTS idx_catalog_device_specs_gpuTier ON "catalog_device_specs"(gpuTier);

    CREATE TABLE IF NOT EXISTS AppOwnership (
      "OwnershipID" TEXT PRIMARY KEY,
      "userId" TEXT,
      "GameID" TEXT,
      "Platform" TEXT,
      "Store URL" TEXT,
      "Platform Specific Release Date" TEXT,
      "Platform DLC Search URL" TEXT,
      "Edition" TEXT,
      "Format" TEXT,
      "Ownership Access Type" TEXT,
      "Purchase Date" TEXT,
      "Price Paid" REAL,
      "Currency" TEXT,
      "Preferred Platform?" TEXT,
      -- PI-GTM-2026-001 (EPIC-04): canonical taxonomy label (PC, Console ΓÇô
      -- PlayStation, Console ΓÇô Xbox, Console ΓÇô Nintendo, Mobile ΓÇô iOS,
      -- Mobile ΓÇô Android, Cloud). Resolved by src/lib/platformTaxonomy.ts.
      "platformCanonical" TEXT
    );

    -- PI-GTM-2026-001 (EPIC-04): Immutable audit trail for catalog platform
    -- label corrections and mismatches. UPDATE/DELETE triggers make the table
    -- append-only. Deliberately NOT registered in src/routes/state.ts so the
    -- snapshot export/import lifecycle never rewrites or truncates it.
    CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tableName TEXT NOT NULL,
      rowId TEXT NOT NULL,
      field TEXT NOT NULL,
      oldValue TEXT,
      newValue TEXT,
      reason TEXT,
      operator TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_table_row ON "platform_audit_logs"("tableName", "rowId");
    CREATE TRIGGER IF NOT EXISTS trg_platform_audit_logs_no_update
    BEFORE UPDATE ON "platform_audit_logs"
    BEGIN SELECT RAISE(ABORT, 'platform_audit_logs is append-only (EPIC-04)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_platform_audit_logs_no_delete
    BEFORE DELETE ON "platform_audit_logs"
    BEGIN SELECT RAISE(ABORT, 'platform_audit_logs is append-only (EPIC-04)'); END;

    -- Sprint 5 (EPIC-07): Immutable audit trail for Analytics access control.
    -- Every DENIED attempt against the role-gated /api/analytics/* routes is
    -- appended here by src/middleware/auth.ts requireRole(). UPDATE/DELETE
    -- triggers make the table append-only. Deliberately NOT registered in
    -- src/routes/state.ts so the snapshot export/import lifecycle never
    -- rewrites or truncates this security log.
    CREATE TABLE IF NOT EXISTS "analytics_access_logs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT,
      role TEXT,
      route TEXT NOT NULL,
      method TEXT NOT NULL,
      ip TEXT,
      outcome TEXT NOT NULL DEFAULT 'denied',
      reason TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_access_logs_created ON "analytics_access_logs"(createdAt);
    CREATE TRIGGER IF NOT EXISTS trg_analytics_access_logs_no_update
    BEFORE UPDATE ON "analytics_access_logs"
    BEGIN SELECT RAISE(ABORT, 'analytics_access_logs is append-only (EPIC-07)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_analytics_access_logs_no_delete
    BEFORE DELETE ON "analytics_access_logs"
    BEGIN SELECT RAISE(ABORT, 'analytics_access_logs is append-only (EPIC-07)'); END;

    -- Sprint 2 (EPIC-DEV-001): Custom PC Builder persistence block.
    -- Physical component catalog (device_components) and the declarative
    -- compatibility rule set (compatibility_rules) are seeded idempotently by
    -- src/seed/components.ts. device_builds stores authenticated user builds;
    -- componentsJson carries the full component snapshot so shared/read-only
    -- builds always render faithfully regardless of later catalog edits.
    CREATE TABLE IF NOT EXISTS device_components (
      componentId TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      socketType TEXT,
      ddrGen TEXT,
      formFactor TEXT,
      tdpWatts REAL,
      priceUsd REAL NOT NULL,
      imageUrl TEXT
    );

    CREATE TABLE IF NOT EXISTS device_builds (
      buildId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      buildName TEXT NOT NULL,
      shareSlug TEXT NOT NULL UNIQUE,
      componentsJson TEXT NOT NULL,
      totalPriceSnapshot REAL NOT NULL,
      estimatedWattage INTEGER NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES "AuthUsers"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS compatibility_rules (
      ruleId TEXT PRIMARY KEY,
      categoryA TEXT NOT NULL,
      fieldA TEXT NOT NULL,
      operator TEXT NOT NULL,
      categoryB TEXT,
      fieldB TEXT,
      severity TEXT NOT NULL,
      messageTemplate TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_device_components_category ON device_components(category);
    CREATE INDEX IF NOT EXISTS idx_device_builds_userId ON device_builds(userId);
    CREATE INDEX IF NOT EXISTS idx_device_builds_shareSlug ON device_builds(shareSlug);

    -- Sprint 3 (EPIC-DEV-001): Cross-library performance matrix profiles.
    -- One row per (game x GPU tier x CPU tier) with deterministic FPS values
    -- across the four resolution tiers. Seeded idempotently by
    -- src/seed/performance.ts and read by src/routes/performance.ts.
    CREATE TABLE IF NOT EXISTS "game_performance_profiles" (
      profileId TEXT PRIMARY KEY,
      gameId TEXT NOT NULL,
      gpuTier TEXT NOT NULL,
      cpuTier TEXT NOT NULL,
      fps4kUltra REAL NOT NULL,
      fps1440pHigh REAL NOT NULL,
      fps1080pMed REAL NOT NULL,
      fps720pLow REAL NOT NULL,
      dataSource TEXT NOT NULL DEFAULT 'baseline',
      FOREIGN KEY (gameId) REFERENCES "AppGames"("GameID") ON DELETE CASCADE,
      UNIQUE(gameId, gpuTier, cpuTier)
    );

    CREATE INDEX IF NOT EXISTS idx_perf_profiles_gameId ON "game_performance_profiles"(gameId);
    CREATE INDEX IF NOT EXISTS idx_perf_profiles_tiers ON "game_performance_profiles"(gpuTier, cpuTier);

    -- Sprint 4 (EPIC-DEV-001): Community hardware reviews. One row per
    -- user-scoped review of a catalog device. prosJson/consJson are JSON
    -- string arrays. isEditorsPick flags staff-curated highlights and
    -- isVerifiedOwner is persisted at submit time so public reads never
    -- re-derive ownership.
    CREATE TABLE IF NOT EXISTS device_reviews (
      reviewId INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceId TEXT NOT NULL,
      userId TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      title TEXT,
      body TEXT,
      prosJson TEXT,
      consJson TEXT,
      isEditorsPick INTEGER DEFAULT 0,
      helpfulScore INTEGER DEFAULT 0,
      isVerifiedOwner INTEGER DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (deviceId) REFERENCES "catalog_devices"(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES "AuthUsers"(id) ON DELETE CASCADE,
      UNIQUE(deviceId, userId)
    );

    CREATE INDEX IF NOT EXISTS idx_device_reviews_deviceId ON device_reviews(deviceId);

    -- Sprint 4 (EPIC-DEV-001): Helpfulness votes on community reviews.
    -- One vote per user per review; voteType is 'up' or 'down'. The review's
    -- helpfulScore is the net up minus down count, maintained on vote toggle.
    CREATE TABLE IF NOT EXISTS review_votes (
      voteId INTEGER PRIMARY KEY AUTOINCREMENT,
      reviewId INTEGER NOT NULL,
      userId TEXT NOT NULL,
      voteType TEXT NOT NULL CHECK (voteType IN ('up', 'down')),
      FOREIGN KEY (reviewId) REFERENCES device_reviews(reviewId) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES "AuthUsers"(id) ON DELETE CASCADE,
      UNIQUE(reviewId, userId)
    );

    CREATE INDEX IF NOT EXISTS idx_review_votes_reviewId ON review_votes(reviewId);

    -- Sprint 4 (EPIC-DEV-001): Hardware price history for catalog devices and
    -- builder components. deviceId/componentId are nullable to allow either
    -- target; exactly one is populated per row by the seeders.
    CREATE TABLE IF NOT EXISTS hardware_price_history (
      priceId INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceId TEXT,
      componentId TEXT,
      retailer TEXT,
      priceUsd REAL NOT NULL,
      condition TEXT CHECK (condition IN ('new', 'refurbished')),
      recordedAt TEXT,
      UNIQUE(deviceId, retailer, recordedAt)
    );

    CREATE INDEX IF NOT EXISTS idx_hw_price_history_deviceId ON hardware_price_history(deviceId);
    CREATE INDEX IF NOT EXISTS idx_hw_price_history_componentId ON hardware_price_history(componentId);

    -- Game friction metadata (save system, session loop, offline/launcher
    -- friction, handheld UI legibility). Restores the table that existed in the
    -- legacy app_engine_schema.sql but was never carried into the authoritative
    -- src/db.ts DDL; recommender.ts / recommend.ts / games.ts / quickMatch.ts
    -- LEFT JOIN it unguarded (compare.ts guards it with tableExists).
    CREATE TABLE IF NOT EXISTS "AppGameFriction" (
      "FrictionID" TEXT PRIMARY KEY,
      "GameID" TEXT NOT NULL,
      "Game Title" TEXT,
      "Save System Type" TEXT,
      "Avg Time Between Saves" TEXT,
      "Suspend / Pause Friendly?" BOOLEAN,
      "Core Session Loop Length" TEXT,
      "Cognitive / Mental Energy Required" TEXT,
      "Third-Party Launcher Required?" TEXT,
      "Always-Online Required?" BOOLEAN,
      "Handheld Font & UI Legibility" TEXT,
      FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS "idx_AppGameFriction_GameID" ON "AppGameFriction"("GameID");

    -- Sprint 34 (FEAT-0168): SQLite query optimization indexes.
    -- Cover the hot query paths surfaced by the library, tracking, wishlist and
    -- play-session reads. Column names use the physical (quoted) schema names.
    CREATE INDEX IF NOT EXISTS idx_games_genre_score ON "AppGames"("Primary Genre", criticScore);
    CREATE INDEX IF NOT EXISTS idx_games_title ON "AppGames"("Game Title");
    CREATE INDEX IF NOT EXISTS idx_sessions_game_device ON "AppPlaySessions"(gameId, deviceId);
    CREATE INDEX IF NOT EXISTS idx_tracking_status ON "AppTracking"("Play Status");
    CREATE INDEX IF NOT EXISTS idx_wishlist_triggered ON "AppWishlist"(isTriggered, currentBestPrice);

    -- Sprint 2 (EPIC-DEAL-001): Release Radar upcoming-release catalog.
    -- Verified upcoming releases with strict domain-validated pre-order URLs.
    -- Seeded idempotently by src/seed/radar.ts. releaseDate is an ISO string;
    -- isVerified=1 marks source-verified entries surfaced with the verified
    -- badge on the radar grid.
    CREATE TABLE IF NOT EXISTS release_radar (
      releaseId TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      releaseDate TEXT NOT NULL,
      platform TEXT NOT NULL,
      publisher TEXT,
      priceUsd REAL,
      preorderUrl TEXT,
      bannerUrl TEXT,
      isVerified INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_release_radar_date ON release_radar(releaseDate);

    -- Sprint 5 (EPICUX05): Hardware Explorer 2.0 community benchmark tables.
    -- Filterable crowdsourced-style average-FPS / 1% low-FPS rows keyed on the
    -- seeded device_components catalog. Seeded idempotently by
    -- src/seed/benchmarks.ts and registered in src/routes/state.ts for JSON
    -- snapshot export/import round-trip.
    CREATE TABLE IF NOT EXISTS community_benchmarks (
      benchmarkId TEXT PRIMARY KEY,
      componentId TEXT NOT NULL,
      componentType TEXT NOT NULL CHECK (componentType IN ('gpu', 'cpu')),
      componentName TEXT NOT NULL,
      resolution TEXT NOT NULL CHECK (resolution IN ('1080p', '1440p', '4K')),
      settingsPreset TEXT NOT NULL CHECK (settingsPreset IN ('Low', 'Medium', 'High', 'Ultra')),
      avgFps REAL NOT NULL,
      onePercentLowFps REAL NOT NULL,
      sampleCount INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'community',
      recordedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_community_benchmarks_component ON community_benchmarks(componentId);
    CREATE INDEX IF NOT EXISTS idx_community_benchmarks_filter ON community_benchmarks(componentType, resolution, settingsPreset);
  `);

  try {
    db.exec(MOBILE_STAGING_DDL);
  } catch (error) {
    console.error("Mobile staging schema unavailable:", safeErrorMessage(error));
  }

  try {
    db.exec(DPX_IDENTITY_DDL);
  } catch (error) {
    console.error("Shared identity schema unavailable:", safeErrorMessage(error));
  }

  // Sprint 34 (FEAT-0168): Log index coverage + EXPLAIN QUERY PLAN for the hot
  // query paths so startup surfaces whether the new indexes are actually used.
  logIndexCoverage();

  // Guarded ALTER: add targetStyle to AppTracking if missing (raw SQL only; Prisma unaware)
  try {
    const trackingInfo = db.prepare('PRAGMA table_info("AppTracking")').all() as any[];
    const hasTargetStyle = trackingInfo.some((c) => c.name === "targetStyle");
    if (!hasTargetStyle) {
      db.prepare('ALTER TABLE "AppTracking" ADD COLUMN "targetStyle" TEXT').run();
    }
  } catch (e) {
    console.error("Failed to ensure targetStyle column on AppTracking:", e);
  }

  // Guarded ALTER: add bestStoreType to AppWishlist if missing (v5.0.4 retailer taxonomy).
  // Classifies the best-price store as a Direct Platform or Authorized Key Retailer.
  try {
    const wishlistInfo = db.prepare('PRAGMA table_info("AppWishlist")').all() as any[];
    const hasBestStoreType = wishlistInfo.some((c) => c.name === "bestStoreType");
    if (!hasBestStoreType) {
      db.prepare('ALTER TABLE "AppWishlist" ADD COLUMN "bestStoreType" TEXT').run();
    }
  } catch (e) {
    console.error("Failed to ensure bestStoreType column on AppWishlist:", e);
  }

  // Sprint 6.1 (GAP-001/GAP-003): add is_active to Mods if missing (raw SQL only;
  // Prisma unaware). The mod-link revalidation sweep (scripts/mod-link-sweep.ts)
  // sets is_active = 0 for records whose sourceUrl fails the v1.0 whitelist, and
  // read-time routes suppress inactive listings.
  try {
    const modsInfo = db.prepare('PRAGMA table_info("Mods")').all() as any[];
    const hasIsActive = modsInfo.some((c) => c.name === "is_active");
    if (!hasIsActive) {
      db.prepare('ALTER TABLE "Mods" ADD COLUMN "is_active" INTEGER NOT NULL DEFAULT 1').run();
      console.log("[db] Added is_active column to Mods (Sprint 6.1).");
    }
  } catch (e) {
    console.error("Failed to ensure is_active column on Mods:", e);
  }

  // Sprint 2 (FEAT-MULTITENANT): Non-destructive user-scoping migration.
  // Rebuilds any of the four user-state tables that still lack a userId column.
  rebuildTableUserScoped();

  // PI-004: ownership was historically catalog-global. Preserve those rows,
  // while allowing new imports and platform syncs to identify their owner.
  try {
    const ownershipColumns = db.prepare('PRAGMA table_info("AppOwnership")').all() as any[];
    if (!ownershipColumns.some((column) => column.name === "userId")) {
      db.prepare('ALTER TABLE "AppOwnership" ADD COLUMN "userId" TEXT').run();
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_appownership_user_game ON "AppOwnership"("userId", "GameID");',
    );
  } catch (e) {
    console.error("Failed to ensure userId column on AppOwnership:", e);
  }

  // Sprint 1 (EPIC-PROFILE-0001): Self-heal AuthUsers profile columns and the
  // gamerTag partial unique index on pre-existing databases.
  ensureAuthUserProfileColumns();

  // Sprint 1 (EPIC-DEV-001): Seed the browsable hardware catalog (54 profiles).
  // Idempotent INSERT OR IGNORE so repeated server boots never duplicate rows.
  try {
    seedDeviceCatalog(db);
  } catch (e) {
    console.error("Failed to seed device catalog:", e);
  }

  // Sprint 2 (EPIC-DEV-001): Seed the custom PC builder component catalog and
  // compatibility rules. Idempotent INSERT OR IGNORE, safe on every boot.
  try {
    seedBuilderComponents(db);
  } catch (e) {
    console.error("Failed to seed builder components:", e);
  }

  // Sprint 3 (EPIC-DEV-001): Seed deterministic game performance profiles.
  // Idempotent INSERT OR IGNORE, safe on every boot.
  try {
    seedPerformanceProfiles(db);
  } catch (e) {
    console.error("Failed to seed performance profiles:", e);
  }

  // Sprint 4 (EPIC-DEV-001): Seed baseline community reviews and 12-month
  // hardware price history. Idempotent, safe to re-run on every boot.
  try {
    seedReviews(db);
  } catch (e) {
    console.error("Failed to seed reviews:", e);
  }
  try {
    seedHardwarePriceHistory(db);
  } catch (e) {
    console.error("Failed to seed hardware price history:", e);
  }

  // Sprint 2 (EPIC-DEAL-001): Seed the verified upcoming-release radar.
  // Idempotent INSERT OR IGNORE, safe on every boot.
  try {
    seedRadar(db);
  } catch (e) {
    console.error("Failed to seed release radar:", e);
  }

  // Sprint 5 (EPICUX05): Hardware Explorer 2.0 community benchmark fixtures.
  // Idempotent INSERT OR IGNORE, safe on every boot.
  try {
    seedCommunityBenchmarks(db);
  } catch (e) {
    console.error("Failed to seed community benchmarks:", e);
  }

  // Sprint 4 (EPICUX04): seed the Mods Hub 2.0 persistence tables (version
  // history, dependency edges, default load order) from the deterministic
  // manifest. Idempotent INSERT OR IGNORE, safe on every boot.
  try {
    ensureModHubSeed(db);
  } catch (e) {
    console.error("Failed to seed Mods Hub 2.0 persistence tables:", e);
  }

  // Self-healing schema inspection (FEAT-0163 hardening pass).
  // Verifies all authoritative application tables exist and match expected DDL,
  // then runs PRAGMA foreign_key_check to surface orphaned references on startup.
  verifySchemaIntegrity();

  // PI-GTM-2026-001 (EPIC-04): canonical platform taxonomy audit + migration.
  // Scans every AppOwnership row, resolves the legacy storefront Platform label
  // to the canonical taxonomy, and appends immutable audit-log entries for each
  // correction and unclassified mismatch. Idempotent across server boots.
  try {
    normalizePlatformLabels();
  } catch (e) {
    console.error("Failed to run EPIC-04 platform label normalization:", e);
  }

  // PI-GTM-2026-001 (EPIC-05): data-freshness baseline for the Device
  // Playability Matrix, wired into backend startup routines. Logs a structured
  // baseline so stale playability data is surfaced to the operator. (The weekly
  // automated freshness check with on-call alerting is a later EPIC-05 sprint.)
  try {
    runDataFreshnessBaseline();
  } catch (e) {
    console.error("Failed to run EPIC-05 data-freshness baseline:", e);
  }

  // Sprint 1B (EPICSEC02): automated stale-record re-sanitization. Re-validates
  // every persisted Mods.sourceUrl against the read-time exact-match whitelist
  // on boot and soft-quarantines (is_active = 0) any non-compliant records so
  // legacy or stale non-whitelisted links can never be served. Never destructive
  // and idempotent; a failure here logs and can never block startup.
  try {
    const report = reSanitizeModCatalog(db);
    if (report.invalid > 0) {
      console.log(
        `[db] Mod catalog re-sanitization on boot: ${report.quarantined} quarantined, ${report.reactivated} reactivated of ${report.total}.`,
      );
    }
  } catch (e) {
    console.error("Failed to re-sanitize Mods catalog:", safeErrorMessage(e));
  }
}

/**
 * PI-GTM-2026-001 (EPIC-04): idempotent canonical platform label audit.
 *
 * Scans every AppOwnership row and resolves the legacy storefront "Platform"
 * label to the canonical taxonomy (src/lib/platformTaxonomy.ts). The canonical
 * value is persisted to AppOwnership.platformCanonical and every correction or
 * unclassified mismatch is appended to the immutable platform_audit_logs table
 * (UPDATE/DELETE triggers make the table append-only). Rows that already carry
 * their resolved canonical value are skipped so repeated boots never duplicate
 * audit entries.
 */
function normalizePlatformLabels(): void {
  const rows = db
    .prepare(
      'SELECT "OwnershipID" AS id, "Platform" AS platform, "platformCanonical" AS canonical FROM "AppOwnership"',
    )
    .all() as Array<{ id: string; platform: string | null; canonical: string | null }>;

  const updateStmt = db.prepare(
    'UPDATE "AppOwnership" SET "platformCanonical" = ? WHERE "OwnershipID" = ?',
  );
  const auditExists = db.prepare(`
    SELECT id FROM "platform_audit_logs"
    WHERE "tableName" = 'AppOwnership' AND "rowId" = @rowId AND "field" = 'platformCanonical'
      AND COALESCE("oldValue", '') = COALESCE(@oldValue, '')
      AND COALESCE("newValue", '') = COALESCE(@newValue, '')
    LIMIT 1
  `);
  const insertAudit = db.prepare(`
    INSERT INTO "platform_audit_logs"
      ("tableName", "rowId", "field", "oldValue", "newValue", "reason", "operator")
    VALUES ('AppOwnership', @rowId, 'platformCanonical', @oldValue, @newValue, @reason, 'system-boot')
  `);

  let scanned = 0;
  let canonicalCount = 0;
  let corrected = 0;
  let unclassified = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      scanned++;
      const oldValue = row.platform;
      const canonical = normalizePlatform(oldValue);

      if (canonical) {
        canonicalCount++;
        if (row.canonical !== canonical) {
          updateStmt.run(canonical, row.id);
          corrected++;
          if (!auditExists.get({ rowId: row.id, oldValue, newValue: canonical })) {
            insertAudit.run({
              rowId: row.id,
              oldValue,
              newValue: canonical,
              reason: "EPIC-04 canonical taxonomy normalization",
            });
          }
        }
      } else {
        unclassified++;
        if (row.canonical !== null) {
          updateStmt.run(null, row.id);
        }
        if (!auditExists.get({ rowId: row.id, oldValue, newValue: null })) {
          insertAudit.run({
            rowId: row.id,
            oldValue,
            newValue: null,
            reason: "EPIC-04 audit - unclassified platform string",
          });
        }
      }
    }
  });

  run();

  const auditCountRow = db.prepare('SELECT COUNT(*) AS c FROM "platform_audit_logs"').get() as
    { c?: number } | undefined;
  const auditCount = auditCountRow?.c ?? 0;
  console.log(
    `[db] EPIC-04 platform label audit: scanned=${scanned}, canonical=${canonicalCount}, corrected=${corrected}, unclassified=${unclassified}, auditRows=${auditCount}.`,
  );
}

/**
 * PI-GTM-2026-001 (EPIC-05): backend-startup data-freshness baseline for the
 * Device Playability Matrix (DPM).
 *
 * Establishes the Sprint-1 baseline: counts catalog ownership coverage by
 * canonical platform, surfaces unclassified platform labels, and reports the
 * last audit timestamp. Logged in a single structured line on every backend
 * startup so stale DPM data is visible to operators. DPM-08 wires this into a
 * weekly automated cron check (scheduler.ts) in addition to the boot baseline.
 */
export function runDataFreshnessBaseline(): void {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM "AppOwnership"').get() as any)?.c ?? 0;
  const withCanonical =
    (
      db
        .prepare('SELECT COUNT(*) AS c FROM "AppOwnership" WHERE "platformCanonical" IS NOT NULL')
        .get() as any
    )?.c ?? 0;
  const unclassified =
    (
      db
        .prepare('SELECT COUNT(*) AS c FROM "AppOwnership" WHERE "platformCanonical" IS NULL')
        .get() as any
    )?.c ?? 0;
  const lastAudit = (
    db.prepare('SELECT MAX("createdAt") AS ts FROM "platform_audit_logs"').get() as any
  )?.ts;
  // DPM-06: stale scanned device rows (never scanned or older than 30 days).
  let staleDevices: number = -1;
  try {
    staleDevices =
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM "Devices"
           WHERE "lastScanAt" IS NULL
              OR datetime("lastScanAt") < datetime('now', '-30 days')`,
          )
          .get() as any
      )?.c ?? 0;
  } catch (e) {
    // Keep the -1 sentinel: lastScanAt not yet migrated on this DB.
  }
  const coveragePct = total > 0 ? Math.round((withCanonical / total) * 1000) / 10 : 0;
  console.log(
    `[freshness] DPM baseline: ownershipRows=${total}, canonicalCoverage=${coveragePct}% (${withCanonical}/${total}), unclassified=${unclassified}, lastAudit=${lastAudit ?? "none"}, staleDeviceRows=${staleDevices}.`,
  );
}

/**
 * Authoritative application tables that must exist after initDb().
 * Each entry lists the required columns (name -> type) that the table must
 * expose via PRAGMA table_info. Missing tables are recreated by the DDL above;
 * missing additive columns are repaired via guarded ALTER TABLE.
 */
const AUTHORITATIVE_TABLES: Record<string, Record<string, string>> = {
  AppGames: {
    // Canonical column set mirrored from schema.prisma `model AppGame`.
    // Prisma-backed routes SELECT every mapped scalar field, so any additive
    // drift here surfaces as P2022 ColumnNotFound (see the platform hub
    // summary). verifySchemaIntegrity() repairs each missing column at boot.
    GameID: "TEXT",
    "Game Title": "TEXT",
    "Primary Genre": "TEXT",
    "Original Game Release Date": "TEXT",
    "Storage Size": "TEXT",
    "Estimated Game Time": "TEXT",
    "ROG Ally Playability": "TEXT",
    "Laptop Playability": "TEXT",
    "Min RAM GB": "INTEGER",
    "Min VRAM GB": "INTEGER",
    "SSD Required?": "TEXT",
    "Is RPG": "TEXT",
    "Is Turn-Based": "TEXT",
    "Is Action": "TEXT",
    "Is Strategy / Tactics": "TEXT",
    "Is Sim / Management": "TEXT",
    "Is Roguelike / Deckbuilder": "TEXT",
    "Is Shooter / FPS": "TEXT",
    "Is Platformer / Metroidvania": "TEXT",
    "Is Story / Narrative": "TEXT",
    "Is Sports / Racing": "TEXT",
    "Is Horror / Survival": "TEXT",
    "Official Website URL": "TEXT",
    "Nexus Availability": "TEXT",
    "Nexus Mods URL": "TEXT",
    Active: "TEXT",
    "Date Added": "TEXT",
    "Last Modified": "TEXT",
    storeUrl: "TEXT",
    reviewUrl: "TEXT",
    criticScore: "INTEGER",
    publisher: "TEXT",
    developer: "TEXT",
    headerImage: "TEXT",
    platformStoreUrls: "TEXT",
    nexusUrl: "TEXT",
    nexusModCount: "INTEGER",
    youtubeUrl: "TEXT",
    ignUrl: "TEXT",
    gamefaqsUrl: "TEXT",
    trackedModCount: "INTEGER",
    modNotifications: "TEXT",
    cover_url: "TEXT",
    // Sprint 7 (WUD-7.1): additive synopsis/overview column for library cards.
    synopsis: "TEXT",
  },
  // Prisma relation chain used by GET /api/platforms/:platform/summary.
  // Mirrors schema.prisma `model AppReview` (table AppReviews) so Prisma
  // relation includes never fail with P2022 on older databases.
  AppGames_Staging: {
    staging_id: "TEXT",
    run_id: "TEXT",
    model_id: "TEXT",
    source: "TEXT",
    fetched_at: "DATETIME",
    game_id: "TEXT",
    title: "TEXT",
    publisher: "TEXT",
    original_game_release_date: "TEXT",
    confidence_score: "REAL",
    steam_app_id: "TEXT",
    studio: "TEXT",
    tags: "TEXT",
    source_citation: "TEXT",
  },
  // #158 / WU-033b: the reference game catalogue.
  CatalogueGames: {
    qid: "TEXT",
    title: "TEXT",
    steam_appid: "TEXT",
    wikidata_url: "TEXT",
    loaded_at: "TEXT",
  },
  CatalogueFacts: {
    qid: "TEXT",
    field: "TEXT",
    value: "TEXT",
    basis: "TEXT",
    sources: "TEXT",
    loaded_at: "TEXT",
  },
  CatalogueDrafts: {
    qid: "TEXT",
    kind: "TEXT",
    value: "TEXT",
    label: "TEXT",
    sourced: "TEXT",
    overrides: "TEXT",
    text_sha256: "TEXT",
    links: "TEXT",
    model: "TEXT",
    prompt_version: "TEXT",
    run_id: "TEXT",
    attempt_id: "TEXT",
    drafted_at: "TEXT",
    sample_summary_sha256: "TEXT",
    sample_seed: "TEXT",
    accepted_by: "TEXT",
    promoted_at: "TEXT",
  },
  CatalogueEmbeddings: {
    qid: "TEXT",
    model: "TEXT",
    task_type: "TEXT",
    dimensions: "INTEGER",
    vector: "BLOB",
    text_sha256: "TEXT",
    description_sha256: "TEXT",
    description_run_id: "TEXT",
    description_attempt_id: "TEXT",
    embedding_run_id: "TEXT",
    embedding_attempt_id: "TEXT",
    embedded_at: "TEXT",
    loaded_at: "TEXT",
  },
  AppReviews: {
    ReviewID: "TEXT",
    GameID: "TEXT",
    "Review Source": "TEXT",
    "Review Summary / Score": "TEXT",
    "Score Numeric": "INTEGER",
    "Recommendation Percent": "INTEGER",
    "Worth Playing Grade": "TEXT",
    "Review URL": "TEXT",
    "Verification Status": "TEXT",
    "Last Checked Date": "TEXT",
  },
  // Mirrors schema.prisma `model AppCompletionRoadmap`.
  AppCompletionRoadmap: {
    RoadmapID: "TEXT",
    GameID: "TEXT",
    "Game Title": "TEXT",
    "Main Story Time": "TEXT",
    "Missable Content / Trophies?": "TEXT",
    "Min Playthroughs for 100%": "TEXT",
    "Estimated 100% Completion Time": "TEXT",
    "Trophy / Platinum Difficulty": "TEXT",
    "Trophy Roadmap & Guide URL": "TEXT",
    main_story_hours: "REAL",
    completionist_hours: "REAL",
  },
  // Game friction metadata (save system, session loop, offline/launcher friction,
  // handheld UI legibility). Restores the legacy app_engine_schema.sql table.
  AppGameFriction: {
    FrictionID: "TEXT",
    GameID: "TEXT",
    "Game Title": "TEXT",
    "Save System Type": "TEXT",
    "Avg Time Between Saves": "TEXT",
    "Suspend / Pause Friendly?": "BOOLEAN",
    "Core Session Loop Length": "TEXT",
    "Cognitive / Mental Energy Required": "TEXT",
    "Third-Party Launcher Required?": "TEXT",
    "Always-Online Required?": "BOOLEAN",
    "Handheld Font & UI Legibility": "TEXT",
  },
  Devices: {},
  AppDevices: {
    userId: "TEXT",
    deviceName: "TEXT",
    deviceType: "TEXT",
    cpuModel: "TEXT",
    ramGb: "REAL",
    gpuModel: "TEXT",
    vramGb: "REAL",
    gpuType: "TEXT",
    storageType: "TEXT",
    storageFreeGb: "REAL",
    isPortable: "INTEGER",
    isPrimary: "INTEGER",
  },
  catalog_devices: {
    id: "TEXT",
    name: "TEXT",
    brand: "TEXT",
    type: "TEXT",
    releaseDate: "TEXT",
    msrp: "REAL",
    imageUrl: "TEXT",
    isPrebuilt: "INTEGER",
    platformCanonical: "TEXT",
  },
  catalog_device_specs: {
    deviceId: "TEXT",
    cpuModel: "TEXT",
    gpuModel: "TEXT",
    gpuVramGb: "REAL",
    ramGb: "REAL",
    storageGb: "REAL",
    tdpWatts: "REAL",
    gpuTier: "TEXT",
    cpuTier: "TEXT",
  },
  mobile_import_batches: {
    batch_id: "TEXT",
    contract: "TEXT",
    input_sha256: "TEXT",
    plan_sha256: "TEXT",
    input_records: "INTEGER",
    inserted_count: "INTEGER",
    inserted_quarantined_count: "INTEGER",
    inserted_superseded_count: "INTEGER",
    sighting_added_count: "INTEGER",
    unchanged_count: "INTEGER",
    model_code_resolved_count: "INTEGER",
    existing_quarantined_count: "INTEGER",
    existing_superseded_count: "INTEGER",
    applied_at: "TEXT",
  },
  mobile_sources: {
    source_key: "TEXT",
    url: "TEXT",
    publisher: "TEXT",
    market: "TEXT",
    access_method: "TEXT",
    raw_page_stored: "INTEGER",
    first_batch_id: "TEXT",
  },
  mobile_device_families: {
    family_key: "TEXT",
    manufacturer: "TEXT",
    device_class: "TEXT",
    os_family: "TEXT",
    marketing_name: "TEXT",
    basis_source_key: "TEXT",
    research_ref: "TEXT",
    first_batch_id: "TEXT",
  },
  mobile_hardware_references: {
    reference_key: "TEXT",
    family_key: "TEXT",
    manufacturer: "TEXT",
    reference_label: "TEXT",
    scope_market: "TEXT",
    connectivity: "TEXT",
    model_code: "TEXT",
    model_code_source_key: "TEXT",
    model_code_observed_on: "TEXT",
    model_code_batch_id: "TEXT",
    basis_source_key: "TEXT",
    research_ref: "TEXT",
    first_batch_id: "TEXT",
  },
  mobile_device_variants: {
    variant_key: "TEXT",
    reference_key: "TEXT",
    ram_gb: "INTEGER",
    storage_gb: "INTEGER",
    retail_sku_code: "TEXT",
    sku_status: "TEXT",
    first_batch_id: "TEXT",
  },
  mobile_variant_sightings: {
    variant_key: "TEXT",
    source_key: "TEXT",
    observed_on: "TEXT",
    batch_id: "TEXT",
  },
  mobile_observations: {
    observation_key: "TEXT",
    subject_level: "TEXT",
    family_key: "TEXT",
    reference_key: "TEXT",
    field: "TEXT",
    value_state: "TEXT",
    value_text: "TEXT",
    value_number: "REAL",
    value_json: "TEXT",
    unit: "TEXT",
    is_exhaustive: "INTEGER",
    market: "TEXT",
    scope_qualifier: "TEXT",
    source_key: "TEXT",
    observed_on: "TEXT",
    source_updated_at: "TEXT",
    review_state: "TEXT",
    quarantine_reason: "TEXT",
    quarantine_origin: "TEXT",
    quarantined_batch_id: "TEXT",
    superseded_by: "TEXT",
    batch_id: "TEXT",
  },
  mobile_listing_observations: {
    listing_key: "TEXT",
    reference_key: "TEXT",
    store: "TEXT",
    store_country: "TEXT",
    store_app_id: "TEXT",
    game_title: "TEXT",
    evidence_kind: "TEXT",
    match_basis: "TEXT",
    listed_name: "TEXT",
    required_os: "TEXT",
    source_key: "TEXT",
    observed_on: "TEXT",
    batch_id: "TEXT",
  },
  dpx_import_batches: {
    batch_id: "TEXT",
    contract: "TEXT",
    input_sha256: "TEXT",
    plan_sha256: "TEXT",
    input_records: "INTEGER",
    inserted_count: "INTEGER",
    unchanged_count: "INTEGER",
    applied_at: "TEXT",
  },
  dpx_game_works: {
    work_key: "TEXT",
    key_scheme: "TEXT",
    wikidata_qid: "TEXT",
    basis_source_id: "TEXT",
    basis_url: "TEXT",
    basis_observed_on: "TEXT",
    first_batch_id: "TEXT",
  },
  dpx_work_links: {
    mgpl_work_key: "TEXT",
    wikidata_work_key: "TEXT",
    basis_source_id: "TEXT",
    basis_url: "TEXT",
    basis_observed_on: "TEXT",
    first_batch_id: "TEXT",
  },
  dpx_game_editions: {
    edition_key: "TEXT",
    work_key: "TEXT",
    edition_slug: "TEXT",
    basis_source_id: "TEXT",
    basis_url: "TEXT",
    basis_observed_on: "TEXT",
    first_batch_id: "TEXT",
  },
  dpx_store_products: {
    store: "TEXT",
    store_app_id: "TEXT",
    edition_key: "TEXT",
    basis_source_id: "TEXT",
    basis_url: "TEXT",
    basis_observed_on: "TEXT",
    first_batch_id: "TEXT",
  },
  dpx_hardware_families: {
    family_key: "TEXT",
    manufacturer: "TEXT",
    hardware_class: "TEXT",
    marketing_name: "TEXT",
    basis_source_id: "TEXT",
    basis_url: "TEXT",
    basis_observed_on: "TEXT",
    first_batch_id: "TEXT",
  },
  dpx_hardware_references: {
    reference_key: "TEXT",
    family_key: "TEXT",
    hardware_class: "TEXT",
    maker: "TEXT",
    reference_label: "TEXT",
    configuration: "TEXT",
    scope_market: "TEXT",
    model_code: "TEXT",
    basis_source_id: "TEXT",
    basis_url: "TEXT",
    basis_observed_on: "TEXT",
    first_batch_id: "TEXT",
  },
  dpx_evidence_observations: {
    observation_key: "TEXT",
    contract: "TEXT",
    subject_kind: "TEXT",
    subject_json: "TEXT",
    work_key: "TEXT",
    edition_key: "TEXT",
    build_platform: "TEXT",
    build_version: "TEXT",
    store: "TEXT",
    store_app_id: "TEXT",
    listing_country: "TEXT",
    hardware_class: "TEXT",
    hardware_reference_key: "TEXT",
    port_id: "TEXT",
    os_product: "TEXT",
    release_name: "TEXT",
    mobile_family_key: "TEXT",
    mobile_reference_key: "TEXT",
    mobile_variant_key: "TEXT",
    field: "TEXT",
    value_state: "TEXT",
    value_json: "TEXT",
    unit: "TEXT",
    unknown_reason: "TEXT",
    basis: "TEXT",
    list_exhaustive: "INTEGER",
    country: "TEXT",
    source_id: "TEXT",
    source_url: "TEXT",
    source_version: "TEXT",
    collection: "TEXT",
    observed_at: "TEXT",
    source_updated_at: "TEXT",
    reviewed_on: "TEXT",
    classification: "TEXT",
    effective_publish: "TEXT",
    batch_id: "TEXT",
  },
  AppWishlist: {
    userId: "TEXT",
    gameId: "TEXT",
    title: "TEXT",
    targetPrice: "REAL",
    bestStoreType: "TEXT",
  },
  AppRetroTracking: {
    gameTitle: "TEXT",
    system: "TEXT",
    status: "TEXT",
  },
  AppGameTags: {
    userId: "TEXT",
    gameId: "TEXT",
    tagName: "TEXT",
    colorHex: "TEXT",
  },
  AppGameNotes: {
    userId: "TEXT",
    gameId: "TEXT",
    noteMarkdown: "TEXT",
  },
  AppBacklog: {
    gameId: "TEXT",
    title: "TEXT",
    status: "TEXT",
    priorityScore: "INTEGER",
    hltbMainHours: "REAL",
    etaDays: "REAL",
  },
  AppPlaySessions: {
    sessionUuid: "TEXT",
    gameId: "TEXT",
    durationSeconds: "INTEGER",
    deviceId: "TEXT",
  },
  AppPriceAlerts: {
    userId: "TEXT",
    gameId: "TEXT",
    title: "TEXT",
    targetPrice: "REAL",
    isTriggered: "INTEGER",
    acknowledged: "INTEGER",
  },
  AppDealsWishlist: {
    steamAppId: "TEXT",
    gameTitle: "TEXT",
    targetPrice: "REAL",
  },
  AppDealPriceHistory: {
    gameId: "TEXT",
    title: "TEXT",
    store: "TEXT",
    price: "REAL",
    recordedAt: "TEXT",
  },
  InstalledMods: {
    modId: "TEXT",
    gameDomain: "TEXT",
    modName: "TEXT",
  },
  Mods: {
    gameId: "TEXT",
    modName: "TEXT",
    sourceDomain: "TEXT",
    downloads: "INTEGER",
    download_count: "INTEGER",
    active_installs: "INTEGER",
    rating_count: "INTEGER",
    version_tag: "TEXT",
    author_handle: "TEXT",
    description: "TEXT",
  },
  ModVersions: {
    gameDomain: "TEXT",
    modId: "TEXT",
    version: "TEXT",
    changelog: "TEXT",
  },
  ModDependencies: {
    gameDomain: "TEXT",
    modId: "TEXT",
    dependsOn: "TEXT",
    isHard: "INTEGER",
  },
  ModLoadOrder: {
    gameDomain: "TEXT",
    modId: "TEXT",
    position: "INTEGER",
    isActive: "INTEGER",
  },
  AppCompletionRoadmapCache: {
    gameTitle: "TEXT",
    mainStory: "REAL",
    mainExtra: "REAL",
    completionist: "REAL",
  },
  AppTracking: {
    GameID: "TEXT",
    "Play Status": "TEXT",
    "Want to Play?": "TEXT",
    "Personal Rating (1-10)": "INTEGER",
    "Hours Played": "REAL",
    "Last Played Date": "TEXT",
    "Played Platform": "TEXT",
    "Played Hardware Device": "TEXT",
    "Completed Date": "TEXT",
    "Replay Interest": "TEXT",
    "DLC Status": "TEXT",
    "Personal Review": "TEXT",
    Notes: "TEXT",
    targetTdp: "TEXT",
    targetFps: "TEXT",
    resolution: "TEXT",
    cpuBoost: "TEXT",
    tuningNotes: "TEXT",
    playNotes: "TEXT",
    achievementNotes: "TEXT",
    tags: "TEXT",
    "Trophy Progress": "INTEGER",
    targetStyle: "TEXT",
  },
  AuthUsers: {
    email: "TEXT",
    passwordHash: "TEXT",
    role: "TEXT",
    libraryVisibility: "TEXT",
  },
  AuthAccounts: {
    userId: "TEXT",
    provider: "TEXT",
    providerAccountId: "TEXT",
    tokenEnc: "TEXT",
    tokenIv: "TEXT",
  },
  AppPlatformHandles: {
    userId: "TEXT",
    steamUsername: "TEXT",
    psnId: "TEXT",
    xboxGamertag: "TEXT",
    gogUsername: "TEXT",
    epicUsername: "TEXT",
    ubisoftUsername: "TEXT",
    hidePlatformIds: "INTEGER",
  },
  AuthPlatformLinks: {
    userId: "TEXT",
    platform: "TEXT",
    publicId: "TEXT",
    displayHandle: "TEXT",
    tokenEnc: "TEXT",
    tokenIv: "TEXT",
    connectedAt: "TEXT",
    lastSyncedAt: "TEXT",
  },
  AppFriendships: {
    userId: "TEXT",
    friendId: "TEXT",
    status: "TEXT",
    source: "TEXT",
  },
  AppOwnership: {
    OwnershipID: "TEXT",
    GameID: "TEXT",
    Platform: "TEXT",
    platformCanonical: "TEXT",
    "Store URL": "TEXT",
    "Platform Specific Release Date": "TEXT",
    "Platform DLC Search URL": "TEXT",
    Edition: "TEXT",
    Format: "TEXT",
    "Ownership Access Type": "TEXT",
    "Purchase Date": "TEXT",
    "Price Paid": "REAL",
    Currency: "TEXT",
    "Preferred Platform?": "TEXT",
  },
  platform_audit_logs: {
    tableName: "TEXT",
    rowId: "TEXT",
    field: "TEXT",
    oldValue: "TEXT",
    newValue: "TEXT",
    reason: "TEXT",
    operator: "TEXT",
    createdAt: "DATETIME",
  },
  device_components: {
    componentId: "TEXT",
    category: "TEXT",
    brand: "TEXT",
    model: "TEXT",
    socketType: "TEXT",
    ddrGen: "TEXT",
    formFactor: "TEXT",
    tdpWatts: "REAL",
    priceUsd: "REAL",
    imageUrl: "TEXT",
  },
  device_builds: {
    buildId: "TEXT",
    userId: "TEXT",
    buildName: "TEXT",
    shareSlug: "TEXT",
    componentsJson: "TEXT",
    totalPriceSnapshot: "REAL",
    estimatedWattage: "INTEGER",
  },
  compatibility_rules: {
    ruleId: "TEXT",
    categoryA: "TEXT",
    fieldA: "TEXT",
    operator: "TEXT",
    categoryB: "TEXT",
    fieldB: "TEXT",
    severity: "TEXT",
    messageTemplate: "TEXT",
  },
  game_performance_profiles: {
    profileId: "TEXT",
    gameId: "TEXT",
    gpuTier: "TEXT",
    cpuTier: "TEXT",
    fps4kUltra: "REAL",
    fps1440pHigh: "REAL",
    fps1080pMed: "REAL",
    fps720pLow: "REAL",
    dataSource: "TEXT",
  },
  device_reviews: {
    reviewId: "INTEGER",
    deviceId: "TEXT",
    userId: "TEXT",
    rating: "INTEGER",
    title: "TEXT",
    body: "TEXT",
    prosJson: "TEXT",
    consJson: "TEXT",
    isEditorsPick: "INTEGER",
    helpfulScore: "INTEGER",
    isVerifiedOwner: "INTEGER",
    createdAt: "DATETIME",
  },
  review_votes: {
    voteId: "INTEGER",
    reviewId: "INTEGER",
    userId: "TEXT",
    voteType: "TEXT",
  },
  hardware_price_history: {
    priceId: "INTEGER",
    deviceId: "TEXT",
    componentId: "TEXT",
    retailer: "TEXT",
    priceUsd: "REAL",
    condition: "TEXT",
    recordedAt: "TEXT",
  },
  release_radar: {
    releaseId: "TEXT",
    title: "TEXT",
    releaseDate: "TEXT",
    platform: "TEXT",
    publisher: "TEXT",
    priceUsd: "REAL",
    preorderUrl: "TEXT",
    bannerUrl: "TEXT",
    isVerified: "INTEGER",
  },
};

/**
 * Sprint 2 (FEAT-MULTITENANT): Non-destructive user-scoping migration.
 *
 * SQLite cannot ALTER TABLE ADD COLUMN with a UNIQUE or FOREIGN KEY clause, so
 * when any of the four user-state tables (AppWishlist, AppPriceAlerts,
 * AppGameTags, AppGameNotes) lacks the `userId` column this helper rebuilds it
 * via the standard table-rebuild pattern:
 *   1. Ensure the `legacy-guest` AuthUser exists (owner of pre-migration rows).
 *   2. Create `*_user_scoped` staging table with userId FK + compound UNIQUE.
 *   3. Copy all existing rows into the staging table under `legacy-guest`.
 *   4. DROP the legacy table and RENAME the staging table into place.
 *
 * The swap runs inside a single transaction with foreign_keys temporarily
 * disabled (SQLite forbids toggling the pragma inside a transaction, so the
 * pragma flip happens around the transaction boundary, never inside it).
 * Recreates the wishlist performance index lost by the table swap.
 */
function rebuildTableUserScoped(): void {
  const userScopedUnique: Record<string, string[]> = {
    AppWishlist: ["userId", "gameId"],
    AppPriceAlerts: ["userId", "gameId"],
    AppGameTags: ["userId", "gameId", "tagName"],
    AppGameNotes: ["userId", "gameId"],
  };

  for (const [table, uniqueCols] of Object.entries(userScopedUnique)) {
    let info: any[];
    try {
      info = db.prepare(`PRAGMA table_info("${table}")`).all() as any[];
    } catch (e) {
      continue;
    }
    if (info.length === 0) continue;
    if (info.some((c) => c.name === "userId")) continue;

    const staging = `${table}_user_scoped`;
    const columns = info.filter((c) => c.name !== "id" && c.name !== "userId");
    const colDefs = columns
      .map(
        (c) => `"${c.name.replace(/"/g, '""')}" ${c.type || "TEXT"}${c.notnull ? " NOT NULL" : ""}`,
      )
      .join(",\n      ");
    const insertCols = columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
    const uniqueSql = uniqueCols.map((c) => `"${c}"`).join(", ");

    // 1. Legacy-guest owner for pre-migration global rows (no data loss).
    db.prepare(
      `INSERT OR IGNORE INTO "AuthUsers" (id, email, role, createdAt, updatedAt)
       VALUES ('legacy-guest', 'legacy-guest@mgpl.local', 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();

    const swap = db.transaction(() => {
      db.prepare(`DROP TABLE IF EXISTS "${staging}"`).run();
      db.exec(`
        CREATE TABLE "${staging}" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ${colDefs},
          userId TEXT NOT NULL,
          CONSTRAINT "${table}_userScoped_userId_fkey" FOREIGN KEY (userId) REFERENCES "AuthUsers"(id) ON DELETE CASCADE,
          CONSTRAINT "${table}_userScoped_unique" UNIQUE (${uniqueSql})
        );
      `);
      db.prepare(
        `INSERT INTO "${staging}" (${insertCols}, "userId") SELECT ${insertCols}, 'legacy-guest' FROM "${table}"`,
      ).run();
      db.prepare(`DROP TABLE "${table}"`).run();
      db.prepare(`ALTER TABLE "${staging}" RENAME TO "${table}"`).run();
      if (table === "AppWishlist") {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_wishlist_triggered ON "AppWishlist"(isTriggered, currentBestPrice);',
        );
      }
    });

    try {
      db.pragma("foreign_keys = OFF");
      swap();
    } catch (e) {
      console.error(`Failed to rebuild ${table} with user scoping:`, e);
    } finally {
      db.pragma("foreign_keys = ON");
    }

    console.log(`[db] Rebuilt ${table} with userId foreign key + compound unique.`);
  }
}

/**
 * Sprint 1 (EPIC-PROFILE-0001): Self-heal AuthUsers profile columns and the
 * gamerTag partial unique index.
 *
 * Runs on every server boot so pre-existing databases (created before this
 * sprint) converge to the authoritative physical schema without a destructive
 * `prisma db push`. Each column is added via a guarded `ALTER TABLE` after a
 * `PRAGMA table_info` presence check ΓÇö the same additive, non-destructive
 * pattern used by the targetStyle / bestStoreType repairs above.
 *
 * `profileVisibility` uses a plain TEXT column here (NOT NULL DEFAULT 'private'
 * cannot be added to a non-empty table via ALTER TABLE). Fresh databases get
 * the correct NOT NULL DEFAULT from the CREATE TABLE IF NOT EXISTS declaration;
 * pre-existing rows without the column converge to 'private' in the profile
 * read path (see src/routes/user.ts) and the login/register flows seed new
 * registrations explicitly.
 *
 * gamerTag uniqueness is enforced by a partial unique index (WHERE gamerTag
 * IS NOT NULL) because SQLite cannot add a UNIQUE constraint via ALTER TABLE
 * ADD COLUMN. The index name matches the reference DDL in
 * scripts/profile-ddl.sql.
 */
function ensureAuthUserProfileColumns(): void {
  const profileColumns: Array<[string, string]> = [
    ["displayName", "TEXT"],
    ["avatarUrl", "TEXT"],
    ["gamerTag", "TEXT"],
    ["profileVisibility", "TEXT"],
    ["libraryVisibility", "TEXT"],
  ];

  try {
    const info = db.prepare('PRAGMA table_info("AuthUsers")').all() as any[];
    if (info.length === 0) {
      // Table missing entirely ΓÇö the CREATE TABLE IF NOT EXISTS block above
      // already defines the full sprint-1 shape, so nothing to heal here.
      return;
    }
    const existing = new Set(info.map((c) => c.name));
    for (const [col, type] of profileColumns) {
      if (!existing.has(col)) {
        db.prepare(`ALTER TABLE "AuthUsers" ADD COLUMN "${col}" ${type}`).run();
        console.log(`[db] Added AuthUsers.${col}`);
      }
    }
  } catch (e) {
    console.error("Failed to ensure AuthUsers profile columns:", e);
  }

  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_users_gamerTag" ON "AuthUsers" ("gamerTag") WHERE "gamerTag" IS NOT NULL',
    );
  } catch (e) {
    console.error("Failed to ensure partial unique index idx_auth_users_gamerTag:", e);
  }
}

/**
 * Verify the 13 authoritative tables exist and match expected DDL, then run
 * PRAGMA foreign_key_check. Self-heals additive column drift and logs a clean
 * bill of health on startup. Never throws on non-authoritative legacy rows.
 */
function verifySchemaIntegrity(): void {
  const missingTables: string[] = [];
  const repairedColumns: string[] = [];

  for (const [table, requiredColumns] of Object.entries(AUTHORITATIVE_TABLES)) {
    let info: any[] = [];
    try {
      info = db.prepare(`PRAGMA table_info("${table}")`).all() as any[];
    } catch (e) {
      // Table does not exist yet; the DDL above should have created it.
    }

    if (info.length === 0) {
      missingTables.push(table);
      continue;
    }

    const existing = new Set(info.map((c) => c.name));
    for (const [col, type] of Object.entries(requiredColumns)) {
      if (!existing.has(col)) {
        try {
          db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${type}`).run();
          repairedColumns.push(`${table}.${col}`);
        } catch (e) {
          console.error(`Failed to repair column ${table}.${col}:`, e);
        }
      }
    }
  }

  // Foreign key integrity check.
  let fkViolations = 0;
  try {
    const fkRows = db.prepare("PRAGMA foreign_key_check").all() as any[];
    fkViolations = fkRows.length;
    if (fkViolations > 0) {
      console.warn(`[db] foreign_key_check found ${fkViolations} orphaned reference(s).`);
    }
  } catch (e) {
    console.error("Failed to run PRAGMA foreign_key_check:", e);
  }

  if (missingTables.length > 0) {
    console.warn(
      `[db] Missing tables detected (will be created by DDL): ${missingTables.join(", ")}`,
    );
  }
  if (repairedColumns.length > 0) {
    console.warn(`[db] Repaired additive columns: ${repairedColumns.join(", ")}`);
  }
  console.log(
    `[db] Schema integrity verified: ${Object.keys(AUTHORITATIVE_TABLES).length} tables, ` +
      `${fkViolations === 0 ? "foreign keys clean" : `${fkViolations} FK violation(s)`}.`,
  );
}

/**
 * Sprint 34 (FEAT-0168): Log index coverage and EXPLAIN QUERY PLAN for the hot
 * query paths. Confirms the new performance indexes exist and are actually
 * selected by the SQLite planner, surfacing any coverage gaps at startup.
 */
function logIndexCoverage(): void {
  const expectedIndexes = [
    "idx_games_genre_score",
    "idx_games_title",
    "idx_sessions_game_device",
    "idx_tracking_status",
    "idx_wishlist_triggered",
  ];

  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN (?,?,?,?,?)")
      .all(...expectedIndexes) as any[];
    const present = new Set(rows.map((r) => r.name));
    const missing = expectedIndexes.filter((n) => !present.has(n));
    if (missing.length > 0) {
      console.warn(`[db] Missing performance indexes: ${missing.join(", ")}`);
    } else {
      console.log(`[db] Performance indexes verified: ${expectedIndexes.join(", ")}`);
    }
  } catch (e) {
    console.error("[db] Failed to verify performance indexes:", e);
  }

  // EXPLAIN QUERY PLAN for representative hot queries.
  // Each entry carries the dummy parameter values required by the `?`
  // placeholders so the prepared statements execute cleanly (previously they
  // threw `RangeError: Too few parameter values were provided`).
  const plans: Array<[string, string, unknown[]]> = [
    [
      "genre+score library scan",
      'SELECT "GameID" FROM "AppGames" WHERE "Primary Genre" = ? ORDER BY criticScore DESC LIMIT 100',
      [""],
    ],
    ["title lookup", 'SELECT "GameID" FROM "AppGames" WHERE "Game Title" = ?', [""]],
    [
      "play sessions by game+device",
      'SELECT id FROM "AppPlaySessions" WHERE gameId = ? AND deviceId = ?',
      ["", ""],
    ],
    ["tracking by play status", 'SELECT "GameID" FROM "AppTracking" WHERE "Play Status" = ?', [""]],
    [
      "wishlist triggered",
      'SELECT id FROM "AppWishlist" WHERE isTriggered = ? ORDER BY currentBestPrice ASC',
      [1],
    ],
  ];
  for (const [label, sql, params] of plans) {
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[];
      const detail = plan.map((p) => p.detail).join(" | ");
      console.log(`[db] EXPLAIN QUERY PLAN [${label}]: ${detail}`);
    } catch (e) {
      console.error(`[db] EXPLAIN QUERY PLAN failed for [${label}]:`, e);
    }
  }
}

// Run DB initialization immediately on module load
initDb();
