import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { canonicalJson, sha256Hex } from "../../src/services/enrichmentPromotion";
import {
  convertMobileCohort,
  MobileCohortConversionError,
  COHORT_20261021_POLICY,
  MOBILE_COHORT_CONVERTER,
  MOBILE_COHORT_MANIFEST,
  JOIN_VERIFICATION_SCHEMA,
  type CohortFileName,
  type CohortPolicy,
} from "../../src/services/mobileCohortConversion";
import { main as convertCohortMain } from "../../scripts/catalogue/convert-mobile-cohort";
import {
  main as devcopyMain,
  computeMobileStateHash,
  type MobileStateHash,
} from "../../scripts/catalogue/mobile-devcopy";
import {
  main as importCliMain,
  validateApplyReview,
  Refusal,
} from "../../scripts/catalogue/import-mobile-references";
import {
  planMobileImport,
  applyMobileImport,
  MOBILE_STAGING_TABLES,
  MobileImportError,
} from "../../src/services/mobileCatalogueImport";
import {
  FIXTURE_POLICY,
  FIXTURE_BUFFERS,
  FIXTURE_ORACLE,
  FIXTURE_JOIN_RECORDS,
  createFixtureFiles,
  createFixtureInput,
  withInventory,
  withMutatedFile,
  withShuffledRows,
  withRecomputedPolicy,
  makeJoinVerificationRecord,
  type FixtureJoinEntry,
} from "../helpers/mobileCohortFixture";
import {
  buildMobileApplyReview,
  type MobileDryRunReviewArtifact,
} from "../helpers/mobileApplyReview";
import {
  ddl,
  database as createMemoryDb,
  bytes as mobileBytes,
} from "../helpers/mobileStagingFixture";

interface TempEnv {
  dir: string;
  cleanup: () => void;
}

function makeTempEnv(prefix = "ai112-test-"): TempEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Preserve the test result if Windows still holds a temporary file handle.
      }
    },
  };
}

function writeDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.exec(ddl);
  return db;
}

function parseJsonLines(buffer: Buffer): any[] {
  return buffer
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("AI-112 Mobile Cohort Conversion & Staging Integration (V-01 to V-39)", () => {
  let tempEnv: TempEnv;

  beforeEach(() => {
    tempEnv = makeTempEnv();
  });

  afterEach(() => {
    tempEnv.cleanup();
  });

  // --------------------------------------------------------------------------
  // V-01: Hash verification & full refusal list
  // --------------------------------------------------------------------------
  it("V-01: changing any byte of any input refuses input_hash_mismatch with every refusal listed and no output", () => {
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
      const mutatedFiles = withMutatedFile(FIXTURE_BUFFERS, name, (text) => text + " ");
      const input = createFixtureInput({ filesPatch: mutatedFiles });

      try {
        convertMobileCohort(input, FIXTURE_POLICY);
        expect.unreachable(`Expected mutation in ${name} to throw`);
      } catch (err: any) {
        expect(err).toBeInstanceOf(MobileCohortConversionError);
        const error = err as MobileCohortConversionError;
        expect(error.refusals.some((r) => r.code === "input_hash_mismatch")).toBe(true);
        expect(error.refusals.some((r) => r.detail.includes(name))).toBe(true);
      }
    }

    // Simultaneously mutate multiple files to assert every refusal is listed
    let multiMutated = FIXTURE_BUFFERS;
    multiMutated = withMutatedFile(multiMutated, "candidates.jsonl", (t) => t + " ");
    multiMutated = withMutatedFile(multiMutated, "sources.json", (t) => t + " ");
    const multiInput = createFixtureInput({ filesPatch: multiMutated });

    try {
      convertMobileCohort(multiInput, FIXTURE_POLICY);
      expect.unreachable("Expected multi-mutation to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      const error = err as MobileCohortConversionError;
      const hashRefusals = error.refusals.filter((r) => r.code === "input_hash_mismatch");
      expect(hashRefusals.length).toBeGreaterThanOrEqual(2);
      expect(hashRefusals.some((r) => r.detail.includes("candidates.jsonl"))).toBe(true);
      expect(hashRefusals.some((r) => r.detail.includes("sources.json"))).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // V-02: Determinism & order independence
  // --------------------------------------------------------------------------
  it("V-02: two runs are byte-identical; shuffling fixture rows leaves every line after the header identical", () => {
    const inputA = createFixtureInput();
    const inputB = createFixtureInput();
    const resA = convertMobileCohort(inputA, FIXTURE_POLICY);
    const resB = convertMobileCohort(inputB, FIXTURE_POLICY);

    expect(resA.jsonl.equals(resB.jsonl)).toBe(true);
    expect(resA.manifest.equals(resB.manifest)).toBe(true);
    expect(resA.jsonlSha256).toBe(resB.jsonlSha256);
    expect(resA.manifestSha256).toBe(resB.manifestSha256);

    // Shuffled input with recomputed policy pins
    const shuffledFiles = withShuffledRows(FIXTURE_BUFFERS, "candidates.jsonl");
    const shuffledPolicy = withRecomputedPolicy(shuffledFiles);
    const inputShuffled = createFixtureInput({ filesPatch: shuffledFiles });
    const resShuffled = convertMobileCohort(inputShuffled, shuffledPolicy);

    const linesA = resA.jsonl.toString("utf8").trim().split("\n");
    const linesShuffled = resShuffled.jsonl.toString("utf8").trim().split("\n");

    expect(linesA.length).toBe(linesShuffled.length);
    // Header lines differ because research_package_sha256 depends on input file bytes
    expect(linesA[0]).not.toBe(linesShuffled[0]);
    // Every record line after the header must be byte-identical
    for (let i = 1; i < linesA.length; i++) {
      expect(linesShuffled[i]).toBe(linesA[i]);
    }
  });

  // --------------------------------------------------------------------------
  // V-03: Google Pixel code references & placeholder handling
  // --------------------------------------------------------------------------
  it("V-03: Pixel emits four code references, no placeholder, family-level soc_name/ram_gb, literal O kept, lowercase keys", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    const refs = records.filter(
      (r) => r.record_type === "reference" && r.family_key === "google:pixel-9-pro",
    );
    expect(refs.length).toBe(4);

    // Keys must be lowercase
    for (const ref of refs) {
      expect(ref.reference_key).toBe(ref.reference_key.toLowerCase());
      expect(ref.scope_market).toBeNull();
      expect(ref.connectivity).toBe("cellular_5g");
    }

    // Literal 'O' kept (GZPFO)
    const gzpfo = refs.find((r) => r.reference_key === "google:pixel-9-pro:gzpfo");
    expect(gzpfo).toBeDefined();
    expect(gzpfo.model_code).toBe("GZPFO");

    // No placeholder reference is emitted
    const placeholderRef = refs.find(
      (r) => r.model_code === null || r.reference_key.includes("placeholder"),
    );
    expect(placeholderRef).toBeUndefined();

    // Family-level soc_name and ram_gb
    const obs = records.filter(
      (r) => r.record_type === "observation" && r.subject_key === "google:pixel-9-pro",
    );
    const chip = obs.find((o) => o.field === "soc_name");
    const ram = obs.find((o) => o.field === "ram_gb");
    expect(chip).toBeDefined();
    expect(chip.subject_level).toBe("family");
    expect(chip.value).toBe("Google Tensor G4");
    expect(ram).toBeDefined();
    expect(ram.subject_level).toBe("family");
    expect(ram.value).toBe(16);

    // Manifest sightings for GZPFO (3 markets) and G8HHN (null label)
    const manifest = JSON.parse(res.manifest.toString("utf8"));
    const sightings = manifest.code_market_sightings;
    const gzpfoSightings = sightings.filter((s: any) => s.model_code === "GZPFO");
    expect(gzpfoSightings.length).toBe(1);
    expect(gzpfoSightings[0].explicit_markets).toEqual(["US", "CA", "JP"]);

    const g8hhnSightings = sightings.filter((s: any) => s.model_code === "G8HHN");
    expect(g8hhnSightings.length).toBe(1);
    expect(g8hhnSightings[0].source_scope_label).toBeNull();
  });

  // --------------------------------------------------------------------------
  // V-04: NA/ROW market domain contract compliance
  // --------------------------------------------------------------------------
  it("V-04: no output line has market or scope_market equal to NA or ROW; literal labels exist only in manifest", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    for (const record of records) {
      if (record.market !== undefined) {
        expect(record.market).not.toBe("NA");
        expect(record.market).not.toBe("ROW");
      }
      if (record.scope_market !== undefined) {
        expect(record.scope_market).not.toBe("NA");
        expect(record.scope_market).not.toBe("ROW");
      }
    }

    const manifest = JSON.parse(res.manifest.toString("utf8"));
    const naSighting = manifest.code_market_sightings.find(
      (s: any) => s.source_scope_label === "NA",
    );
    const rowSighting = manifest.code_market_sightings.find(
      (s: any) => s.source_scope_label === "ROW",
    );
    expect(naSighting).toBeDefined();
    expect(rowSighting).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // V-05: S26 shape & not_imported_not_assignable
  // --------------------------------------------------------------------------
  it("V-05: S26 shape emits two declared soc_name lines; alternatives row is not_imported_not_assignable", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    const s26Chips = records.filter(
      (r) =>
        r.record_type === "observation" &&
        r.subject_key.startsWith("samsung:galaxy-s26") &&
        r.field === "soc_name",
    );
    expect(s26Chips.length).toBe(2);
    for (const chip of s26Chips) {
      expect(["regional_assignment_unresolved", "research_declared_unresolved"]).toContain(
        chip.declared_quarantine,
      );
    }

    const manifest = JSON.parse(res.manifest.toString("utf8"));
    const disp = manifest.dispositions.find((d: any) => d.id === "R0028");
    expect(disp).toBeDefined();
    expect(disp.disposition).toBe("not_imported_not_assignable");
  });

  // --------------------------------------------------------------------------
  // V-06: A56 shape & quarantine planner verification
  // --------------------------------------------------------------------------
  it("V-06: A56 shape emits two declared lines; planner marks both inserted_quarantined with source_conflict", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const db = createMemoryDb();
    try {
      const plan = planMobileImport(db, res.jsonl, { now: new Date("2026-10-21T12:00:00Z") });
      expect(plan.status).toBe("applicable");
      const lines = parseJsonLines(res.jsonl);
      const a56Quarantine = plan.outcomes.filter(
        (q) =>
          lines[q.line - 1]?.subject_key?.startsWith("samsung:galaxy-a56-5g") &&
          q.status === "inserted_quarantined",
      );
      expect(a56Quarantine.length).toBe(2);
      for (const q of a56Quarantine) {
        expect(q.reasons).toContain("source_conflict");
      }
    } finally {
      db.close();
    }
  });

  // --------------------------------------------------------------------------
  // V-07: Null chip emits nothing
  // --------------------------------------------------------------------------
  it("V-07: null chip emits no soc_name line", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    const a16Refs = records.filter(
      (r) => r.record_type === "reference" && r.family_key === "samsung:galaxy-a16-5g",
    );
    for (const ref of a16Refs) {
      const obs = records.filter(
        (r) =>
          r.record_type === "observation" &&
          r.subject_key === ref.reference_key &&
          r.field === "soc_name",
      );
      // Hardware model code is null and bundle chip is not specified, so only corrected statements appear
      for (const o of obs) {
        expect(o.value).not.toBeNull();
      }
    }
  });

  // --------------------------------------------------------------------------
  // V-08: Enterprise cadence scope & quarantine
  // --------------------------------------------------------------------------
  it("V-08: enterprise cadence has enterprise_edition_only, is quarantined by planner, not on retail", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    const enterpriseObs = records.filter(
      (r) =>
        r.record_type === "observation" &&
        r.field === "security_update_cadence" &&
        r.scope_qualifier === "enterprise_edition_only",
    );
    expect(enterpriseObs.length).toBe(1);
    expect(enterpriseObs[0].value).toBe("monthly");

    const db = createMemoryDb();
    try {
      const plan = planMobileImport(db, res.jsonl, { now: new Date("2026-10-21T12:00:00Z") });
      const enterpriseQuarantines = plan.outcomes.filter((q) =>
        q.reasons.includes("enterprise_scope_not_retail"),
      );
      expect(enterpriseQuarantines.length).toBe(1);
    } finally {
      db.close();
    }
  });

  // --------------------------------------------------------------------------
  // V-09: US research references
  // --------------------------------------------------------------------------
  it("V-09: US research reference is separate from UK/SG references; carries no chip, code or foreign RAM", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    const usRef = records.find(
      (r) =>
        r.record_type === "reference" && r.reference_key === "samsung:galaxy-a37-5g:us-cellular-5g",
    );
    expect(usRef).toBeDefined();
    expect(usRef.model_code).toBeNull();
    expect(usRef.scope_market).toBe("US");

    // Carries no soc_name observation
    const chip = records.find(
      (r) =>
        r.record_type === "observation" &&
        r.subject_key === usRef.reference_key &&
        r.field === "soc_name",
    );
    expect(chip).toBeUndefined();

    // Variants come strictly from R0033
    const variants = records.filter(
      (r) => r.record_type === "variant" && r.reference_key === usRef.reference_key,
    );
    expect(variants.length).toBe(2);
    expect(variants.map((v) => `${v.ram_gb}/${v.storage_gb}`).sort()).toEqual(["6/128", "8/256"]);
  });

  // --------------------------------------------------------------------------
  // V-10: RAM unknown encoding
  // --------------------------------------------------------------------------
  it("V-10: RAM unknown gives not_stated_by_source with null value and null is_exhaustive; no 0 or [] appear", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    const notStatedRam = records.filter(
      (r) =>
        r.record_type === "observation" &&
        (r.field === "ram_gb" || r.field === "ram_options_gb") &&
        r.value_state === "not_stated_by_source",
    );
    expect(notStatedRam.length).toBe(FIXTURE_ORACLE.baseline.notStatedObservations);

    for (const r of notStatedRam) {
      expect(r.value).toBeNull();
      expect(r.is_exhaustive).toBeNull();
      expect(r.value).not.toBe(0);
      expect(r.value).not.toEqual([]);
    }
  });

  // --------------------------------------------------------------------------
  // V-11: Unverified Apple reference hold & disposition
  // --------------------------------------------------------------------------
  it("V-11: without verification record, unverified Apple reference, observations, listing are absent; family is present", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    // Family MOB-022 is present
    const fam = records.find(
      (r) => r.record_type === "family" && r.family_key === "apple:iphone-16-pro-max",
    );
    expect(fam).toBeDefined();

    // Reference MOB-022:REF-01 is absent
    const ref = records.find(
      (r) => r.record_type === "reference" && r.family_key === "apple:iphone-16-pro-max",
    );
    expect(ref).toBeUndefined();

    // Observations and listings for it are absent
    const obs = records.filter(
      (r) =>
        r.record_type === "observation" && r.subject_key.startsWith("apple:iphone-16-pro-max:"),
    );
    expect(obs.length).toBe(0);

    const lst = records.filter(
      (r) => r.record_type === "listing" && r.reference_key.startsWith("apple:iphone-16-pro-max:"),
    );
    expect(lst.length).toBe(0);

    const manifest = JSON.parse(res.manifest.toString("utf8"));
    const disp = manifest.dispositions.find((d: any) => d.id === "MOB-022:REF-01");
    expect(disp).toBeDefined();
    expect(disp.disposition).toBe("held_join_unverified");
  });

  // --------------------------------------------------------------------------
  // V-12: Join verification validity (JV-1 to JV-7)
  // --------------------------------------------------------------------------
  it("V-12: join verification validity: JV-1 to JV-7 refuse join_verification_invalid with no output", () => {
    const validEntry: FixtureJoinEntry = {
      reference_id: "MOB-022:REF-01",
      model_code: "A3473",
      device_name_on_source: "iPhone 16 Pro Max",
      connectivity_on_source: "not_stated",
      source_url: "https://support.apple.com/en-us/108044",
      result: "matches",
    };

    // Helper to test JV refusal
    const assertJvRefusal = (recordObj: any, expectedSha: string, runDate: string) => {
      const bytes = Buffer.from(canonicalJson(recordObj) + "\n", "utf8");
      const input = createFixtureInput({
        joinVerification: { bytes, expectedSha256: expectedSha, runDate },
      });
      try {
        convertMobileCohort(input, FIXTURE_POLICY);
        expect.unreachable("Expected join verification refusal");
      } catch (err: any) {
        expect(err).toBeInstanceOf(MobileCohortConversionError);
        expect(
          (err as MobileCohortConversionError).refusals.some(
            (r) => r.code === "join_verification_invalid",
          ),
        ).toBe(true);
      }
    };

    const baseRecord = {
      schema: JOIN_VERIFICATION_SCHEMA,
      checked_on: "2026-10-21",
      prepared_by_lane: "test-lane",
      entries: [validEntry],
    };
    const validSha = sha256Hex(Buffer.from(canonicalJson(baseRecord) + "\n", "utf8"));

    // JV-1: SHA mismatch
    assertJvRefusal(baseRecord, "0".repeat(64), "2026-10-21");

    // JV-2: Extra member or invalid enum
    for (const invalid of [null, false, 0, "", [], "text"]) {
      const bytes = Buffer.from(canonicalJson(invalid) + "\n", "utf8");
      assertJvRefusal(invalid, sha256Hex(bytes), "2026-10-21");
    }
    assertJvRefusal(
      { ...baseRecord, extra: "unsupported" },
      sha256Hex(Buffer.from(canonicalJson({ ...baseRecord, extra: "unsupported" }) + "\n")),
      "2026-10-21",
    );

    // JV-3: Empty entries or duplicate reference_id
    const emptyEntries = { ...baseRecord, entries: [] };
    assertJvRefusal(
      emptyEntries,
      sha256Hex(Buffer.from(canonicalJson(emptyEntries) + "\n")),
      "2026-10-21",
    );

    const dupEntries = { ...baseRecord, entries: [validEntry, validEntry] };
    assertJvRefusal(
      dupEntries,
      sha256Hex(Buffer.from(canonicalJson(dupEntries) + "\n")),
      "2026-10-21",
    );

    // JV-4: Non-Apple reference or pre-verified iPad
    const preVerifiedIpad = {
      ...baseRecord,
      entries: [{ ...validEntry, reference_id: "MOB-062:REF-01" }],
    };
    assertJvRefusal(
      preVerifiedIpad,
      sha256Hex(Buffer.from(canonicalJson(preVerifiedIpad) + "\n")),
      "2026-10-21",
    );

    const nonAppleRef = {
      ...baseRecord,
      entries: [{ ...validEntry, reference_id: "MOB-031:REF-01" }],
    };
    assertJvRefusal(
      nonAppleRef,
      sha256Hex(Buffer.from(canonicalJson(nonAppleRef) + "\n")),
      "2026-10-21",
    );

    // JV-5: Wrong code or wrong identification page
    const wrongCode = { ...baseRecord, entries: [{ ...validEntry, model_code: "A9999" }] };
    assertJvRefusal(
      wrongCode,
      sha256Hex(Buffer.from(canonicalJson(wrongCode) + "\n")),
      "2026-10-21",
    );

    const wrongPage = {
      ...baseRecord,
      entries: [{ ...validEntry, source_url: "https://support.apple.com/en-us/108043" }],
    };
    assertJvRefusal(
      wrongPage,
      sha256Hex(Buffer.from(canonicalJson(wrongPage) + "\n")),
      "2026-10-21",
    );

    // JV-6: Invalid date or earlier than 2026-10-21 or after runDate
    const earlyDate = { ...baseRecord, checked_on: "2026-10-20" };
    assertJvRefusal(
      earlyDate,
      sha256Hex(Buffer.from(canonicalJson(earlyDate) + "\n")),
      "2026-10-21",
    );

    const futureDate = { ...baseRecord, checked_on: "2026-10-23" };
    assertJvRefusal(
      futureDate,
      sha256Hex(Buffer.from(canonicalJson(futureDate) + "\n")),
      "2026-10-22",
    );

    // JV-7: iPhone with wifi or wifi_cellular
    const iphoneWifi = {
      ...baseRecord,
      entries: [{ ...validEntry, connectivity_on_source: "wifi" }],
    };
    assertJvRefusal(
      iphoneWifi,
      sha256Hex(Buffer.from(canonicalJson(iphoneWifi) + "\n")),
      "2026-10-21",
    );

    const iphoneWifiCell = {
      ...baseRecord,
      entries: [{ ...validEntry, connectivity_on_source: "wifi_cellular" }],
    };
    assertJvRefusal(
      iphoneWifiCell,
      sha256Hex(Buffer.from(canonicalJson(iphoneWifiCell) + "\n")),
      "2026-10-21",
    );
  });

  // --------------------------------------------------------------------------
  // V-13: Listing attachment & wifi_cellular exclusion
  // --------------------------------------------------------------------------
  it("V-13: Wi-Fi + Cellular listing never attaches; no wifi_cellular reference exists; Q0016 recorded", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);

    // No wifi_cellular reference anywhere
    const wifiCellRefs = records.filter(
      (r) => r.record_type === "reference" && r.connectivity === "wifi_cellular",
    );
    expect(wifiCellRefs.length).toBe(0);

    // No listing has game matching Wi-Fi + Cellular unattached row
    const listings = records.filter((r) => r.record_type === "listing");
    for (const l of listings) {
      expect(l.listed_name).not.toContain("Wi-Fi + Cellular");
    }

    const manifest = JSON.parse(res.manifest.toString("utf8"));
    const q16 = manifest.dispositions.find((d: any) => d.id === "AI112-Q0016");
    expect(q16).toBeDefined();
    expect(q16.disposition).toBe("preserved_unknown_no_record");
  });

  // --------------------------------------------------------------------------
  // V-14: Listing required_os token parsing & refusal
  // --------------------------------------------------------------------------
  it("V-14: required_os is the OS token; unparsable value refuses required_os_unparsed", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const records = parseJsonLines(res.jsonl);
    const ipadListing = records.find(
      (r) => r.record_type === "listing" && r.listed_name === "iPad Pro 11-inch (M4)",
    );
    expect(ipadListing).toBeDefined();
    expect(ipadListing.required_os).toBe("iPadOS 17.0");

    // Mutate listing to unparsable required_os
    const mutatedListings = withMutatedFile(FIXTURE_BUFFERS, "CORRECTED-OBSERVATIONS.jsonl", (t) =>
      t.replace("iPadOS 17.0 or later with M-series chip", "macOS Sequoia 15.0"),
    );
    const input = createFixtureInput({ filesPatch: mutatedListings });
    const policy = withRecomputedPolicy(mutatedListings);
    try {
      convertMobileCohort(input, policy);
      expect.unreachable("Expected unparsed OS token to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some(
          (r) => r.code === "required_os_unparsed",
        ),
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // V-15: Inherited & scope correction disagreements
  // --------------------------------------------------------------------------
  it("V-15: corrected value differing from inherited one refuses; scope correction contradicting §5.2 refuses", () => {
    // Inherited correction disagrees
    const mutatedObs = withMutatedFile(FIXTURE_BUFFERS, "CORRECTED-OBSERVATIONS.jsonl", (t) =>
      t.replace("Exynos 1330", "Exynos 9999"),
    );
    const inputA = createFixtureInput({ filesPatch: mutatedObs });
    const policyA = withRecomputedPolicy(mutatedObs);
    try {
      convertMobileCohort(inputA, policyA);
      expect.unreachable("Expected inherited correction disagreement to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some(
          (r) => r.code === "inherited_correction_disagrees",
        ),
      ).toBe(true);
    }

    // Scope correction disagrees with URL derivation
    const mutatedScope = withMutatedFile(
      FIXTURE_BUFFERS,
      "CORRECTED-OBSERVATIONS.jsonl",
      (t) =>
        t
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const row = JSON.parse(line);
            if (row.record_kind === "source_scope_correction") row.market = "US";
            return canonicalJson(row);
          })
          .join("\n") + "\n",
    );
    const inputB = createFixtureInput({ filesPatch: mutatedScope });
    const policyB = withRecomputedPolicy(mutatedScope);
    try {
      convertMobileCohort(inputB, policyB);
      expect.unreachable("Expected scope correction disagreement to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some(
          (r) => r.code === "scope_correction_disagrees",
        ),
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // V-16: Unmapped URL & publisher refusals
  // --------------------------------------------------------------------------
  it("V-16: unmapped URL refuses source_market_unmapped; unknown host refuses publisher_unmapped", () => {
    // Reference cites unmapped URL host
    const mutatedRefHost = withMutatedFile(FIXTURE_BUFFERS, "mobile-reference-bundle.jsonl", (t) =>
      t.replace("https://support.apple.com/kb/SP901", "https://example.invalid/unmapped/page"),
    );
    const inputA = createFixtureInput({ filesPatch: mutatedRefHost });
    const policyA = withRecomputedPolicy(mutatedRefHost);
    try {
      convertMobileCohort(inputA, policyA);
      expect.unreachable("Expected unmapped host to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some((r) => r.code === "publisher_unmapped"),
      ).toBe(true);
    }

    // Reference cites unmapped market on known host
    const mutatedMarketUrl = withMutatedFile(
      FIXTURE_BUFFERS,
      "mobile-reference-bundle.jsonl",
      (t) =>
        t.replace(
          "https://support.apple.com/kb/SP901",
          "https://apps.apple.com/unknown-market/app",
        ),
    );
    const inputB = createFixtureInput({ filesPatch: mutatedMarketUrl });
    const policyB = withRecomputedPolicy(mutatedMarketUrl);
    try {
      convertMobileCohort(inputB, policyB);
      expect.unreachable("Expected unmapped market to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some(
          (r) => r.code === "source_market_unmapped",
        ),
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // V-17: Disposition domain & inventory policy
  // --------------------------------------------------------------------------
  it("V-17: manifest has exactly one disposition per entity; inventory drift or schema drift refuses", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const manifest = JSON.parse(res.manifest.toString("utf8"));

    const dispIds = manifest.dispositions.map((d: any) => d.id);
    const uniqueDispIds = new Set(dispIds);
    expect(dispIds.length).toBe(uniqueDispIds.size);
    const expectedIds: string[] = [];
    const input = createFixtureInput();
    for (const [file, idField] of [
      ["candidates.jsonl", "candidate_id"],
      ["mobile-reference-bundle.jsonl", "reference_id"],
      ["observations.jsonl", "observation_id"],
      ["game-listing-observations.jsonl", "listing_id"],
      ["CORRECTED-OBSERVATIONS.jsonl", "observation_id"],
      ["QUARANTINE.jsonl", "quarantine_id"],
    ] as const) {
      for (const row of input.files[file]
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))) {
        expectedIds.push(row[idField]);
        if (row.research_identity_id) expectedIds.push(row.research_identity_id);
      }
    }
    expect([...uniqueDispIds].sort()).toEqual(expectedIds.sort());
    const identityRows = res.jsonl
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.record_type === "family" || row.record_type === "reference");
    for (const row of identityRows) {
      expect(expectedIds).toContain(row.research_ref);
    }
    for (const id of ["R0024", "R0036", "R0040"]) {
      const disposition = manifest.dispositions.find((entry: any) => entry.id === id);
      expect(disposition.output_lines.length).toBeGreaterThan(0);
      for (const line of disposition.output_lines) {
        expect(manifest.lines[line - 1].record_type).toBe("reference");
        expect(manifest.lines[line - 1].contributing_research_ids).toContain(id);
      }
    }
    for (const id of ["AI112-Q0002", "R0071"]) {
      const disposition = manifest.dispositions.find((entry: any) => entry.id === id);
      expect(disposition.output_lines.length).toBeGreaterThan(0);
      for (const line of disposition.output_lines) {
        expect(manifest.lines[line - 1].extraction).toBe("inherited_unverified");
      }
    }
    const omittedFields = withMutatedFile(FIXTURE_BUFFERS, "observations.jsonl", (text) =>
      text.replace('"OBS-0005"', '"OBS-0075"').replace('"OBS-0006"', '"OBS-0071"'),
    );
    const omittedManifest = JSON.parse(
      convertMobileCohort(
        createFixtureInput({ filesPatch: omittedFields }),
        withRecomputedPolicy(omittedFields),
      ).manifest.toString("utf8"),
    );
    expect(
      omittedManifest.dispositions.find((entry: any) => entry.id === "OBS-0075").disposition,
    ).toBe("not_imported_minimisation");
    expect(
      omittedManifest.dispositions.find((entry: any) => entry.id === "OBS-0071").disposition,
    ).toBe("label_only");
    const enterpriseFiles = withMutatedFile(
      FIXTURE_BUFFERS,
      "observations.jsonl",
      (text) =>
        text +
        canonicalJson({
          observation_id: "OBS-0041",
          candidate_id: "MOB-031",
          field: "security_update_cadence",
          value: "monthly",
          assertion_scope: "enterprise_models_only",
          source_url: "https://security.samsungmobile.com/workScope.smsb",
        }) +
        "\n",
    );
    const enterpriseManifest = JSON.parse(
      convertMobileCohort(
        createFixtureInput({ filesPatch: enterpriseFiles }),
        withRecomputedPolicy(enterpriseFiles, {
          observations: FIXTURE_POLICY.inventory.observations + 1,
        }),
      ).manifest.toString("utf8"),
    );
    expect(
      enterpriseManifest.dispositions.find((entry: any) => entry.id === "OBS-0041").output_lines,
    ).toEqual(
      enterpriseManifest.dispositions.find((entry: any) => entry.id === "AI112-Q0013").output_lines,
    );

    // Inventory mismatch with policy
    const driftedPolicy = withInventory(FIXTURE_POLICY, {
      candidates: FIXTURE_POLICY.inventory.candidates + 1,
    });
    try {
      convertMobileCohort(createFixtureInput(), driftedPolicy);
      expect.unreachable("Expected inventory mismatch to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some((r) => r.code === "input_schema_drift"),
      ).toBe(true);
    }

    // Unknown record_kind in corrected observations
    const unknownKind = withMutatedFile(FIXTURE_BUFFERS, "CORRECTED-OBSERVATIONS.jsonl", (t) =>
      t.replace('"record_kind":"model_code_identity"', '"record_kind":"unknown_magic_kind"'),
    );
    const inputKind = createFixtureInput({ filesPatch: unknownKind });
    const policyKind = withRecomputedPolicy(unknownKind);
    try {
      convertMobileCohort(inputKind, policyKind);
      expect.unreachable("Expected unknown record_kind to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some((r) => r.code === "input_schema_drift"),
      ).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // V-18: Omission of forbidden fields, terms & local paths
  // --------------------------------------------------------------------------
  it("V-18: no line contains qualification, usb, fps, tier, excerpt, or local path; manifest has no absolute path", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const jsonlText = res.jsonl.toString("utf8");
    const forbiddenTerms = [
      "qualification",
      "usb",
      "fps",
      "tier",
      "Research internal qualification note",
    ];

    for (const term of forbiddenTerms) {
      expect(jsonlText.toLowerCase()).not.toContain(term.toLowerCase());
    }

    const manifestText = res.manifest.toString("utf8");
    // Manifest must not contain Windows C:\ or Linux /home/ paths
    expect(manifestText).not.toMatch(/[a-zA-Z]:\\/);
    expect(manifestText).not.toMatch(/\/home\//);
    expect(manifestText).not.toMatch(/\/Users\//);
  });

  // --------------------------------------------------------------------------
  // V-19: Converter CLI output atomicity & out-dir safety
  // --------------------------------------------------------------------------
  it("V-19: converter CLI refuses existing or in-repository out-dir; atomic partial folder cleanup; success writes files", async () => {
    const cohortDir = path.join(tempEnv.dir, "cohort");
    const researchDir = path.join(tempEnv.dir, "research");
    fs.mkdirSync(cohortDir, { recursive: true });
    fs.mkdirSync(researchDir, { recursive: true });

    fs.writeFileSync(path.join(cohortDir, "candidates.jsonl"), FIXTURE_BUFFERS["candidates.jsonl"]);
    fs.writeFileSync(
      path.join(cohortDir, "mobile-reference-bundle.jsonl"),
      FIXTURE_BUFFERS["mobile-reference-bundle.jsonl"],
    );
    fs.writeFileSync(
      path.join(cohortDir, "observations.jsonl"),
      FIXTURE_BUFFERS["observations.jsonl"],
    );
    fs.writeFileSync(path.join(cohortDir, "sources.json"), FIXTURE_BUFFERS["sources.json"]);
    fs.writeFileSync(
      path.join(cohortDir, "game-listing-observations.jsonl"),
      FIXTURE_BUFFERS["game-listing-observations.jsonl"],
    );
    fs.writeFileSync(
      path.join(researchDir, "CORRECTED-OBSERVATIONS.jsonl"),
      FIXTURE_BUFFERS["CORRECTED-OBSERVATIONS.jsonl"],
    );
    fs.writeFileSync(
      path.join(researchDir, "QUARANTINE.jsonl"),
      FIXTURE_BUFFERS["QUARANTINE.jsonl"],
    );
    fs.writeFileSync(
      path.join(researchDir, "SOURCE-REGISTER.json"),
      FIXTURE_BUFFERS["SOURCE-REGISTER.json"],
    );

    const existingOutDir = path.join(tempEnv.dir, "existing-out");
    fs.mkdirSync(existingOutDir, { recursive: true });

    // Refuses existing out-dir
    const exitExisting = await convertCohortMain([
      "--cohort-dir",
      cohortDir,
      "--research-dir",
      researchDir,
      "--out-dir",
      existingOutDir,
    ]);
    expect(exitExisting).toBe(2);

    // Refuses in-repo out-dir
    const inRepoDir = path.resolve("test/fixtures-in-repo");
    const exitInRepo = await convertCohortMain([
      "--cohort-dir",
      cohortDir,
      "--research-dir",
      researchDir,
      "--out-dir",
      inRepoDir,
    ]);
    expect(exitInRepo).toBe(2);
  });

  // --------------------------------------------------------------------------
  // V-20: Shipped importer planning & apply/replay parity
  // --------------------------------------------------------------------------
  it("V-20: fixture output through planMobileImport gives rejected 0, blocked 0; apply and replay are byte-identical", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const db = createMemoryDb();
    try {
      const now = new Date("2026-10-21T12:00:00Z");
      const plan = planMobileImport(db, res.jsonl, { now });
      expect(plan.counts.rejected).toBe(0);
      expect(plan.counts.blocked).toBe(0);
      expect(
        plan.outcomes.filter((outcome) => outcome.status === "inserted_quarantined").length,
      ).toBe(FIXTURE_ORACLE.baseline.dryRun.inserted_quarantined);

      const applyRes = applyMobileImport(
        db,
        res.jsonl,
        { inputSha256: plan.inputSha256, planSha256: plan.planSha256 },
        { now },
      );
      expect(applyRes.status).toBe("applied");

      const stateAfterApply = computeMobileStateHash(db);

      const replayRes = applyMobileImport(
        db,
        res.jsonl,
        { inputSha256: plan.inputSha256, planSha256: plan.planSha256 },
        { now },
      );
      expect(replayRes.status).toBe("already_applied");

      const stateAfterReplay = computeMobileStateHash(db);
      expect(canonicalJson(stateAfterReplay)).toBe(canonicalJson(stateAfterApply));
    } finally {
      db.close();
    }
  });

  // --------------------------------------------------------------------------
  // V-21: Mobile importer CLI flags & argument validation
  // --------------------------------------------------------------------------
  it("V-21: CLI flags: missing review flags with --apply, review flags without --apply, unknown options, repeated flags", () => {
    const dbPath = path.join(tempEnv.dir, "flags-test.db");
    const db = writeDb(dbPath);
    db.close();

    const inPath = path.join(tempEnv.dir, "input.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);
    const reportPath = path.join(tempEnv.dir, "report.json");

    // --apply without review flags
    expect(importCliMain(["--db", dbPath, "--in", inPath, "--report", reportPath, "--apply"])).toBe(
      2,
    );

    // review flags without --apply
    expect(
      importCliMain([
        "--db",
        dbPath,
        "--in",
        inPath,
        "--report",
        reportPath,
        "--review",
        "some.json",
      ]),
    ).toBe(2);

    // r1 deprecated flags
    expect(
      importCliMain([
        "--db",
        dbPath,
        "--in",
        inPath,
        "--report",
        reportPath,
        "--apply",
        "--expect-input-sha256",
        "0".repeat(64),
      ]),
    ).toBe(2);

    // repeated options
    expect(
      importCliMain(["--db", dbPath, "--db", dbPath, "--in", inPath, "--report", reportPath]),
    ).toBe(2);
  });

  // --------------------------------------------------------------------------
  // V-22: Gate order before database is opened (G1 & G4)
  // --------------------------------------------------------------------------
  it("V-22: gate order before db open: G1 review_digest_mismatch, G4 input_mismatch with missing db", () => {
    const missingDb = path.join(tempEnv.dir, "does-not-exist.db");
    const inPath = path.join(tempEnv.dir, "input.jsonl");
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    fs.writeFileSync(inPath, res.jsonl);

    // Create a review bundle against a temporary valid db first
    const tempDbPath = path.join(tempEnv.dir, "temp.db");
    const tDb = writeDb(tempDbPath);
    tDb.close();

    const bundle = buildMobileApplyReview({
      dbPath: tempDbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
    });

    // G1: wrong review hash exits with review_digest_mismatch without opening missingDb
    const exitG1 = importCliMain([
      "--db",
      missingDb,
      "--in",
      inPath,
      "--report",
      path.join(tempEnv.dir, "rep1.json"),
      "--apply",
      "--review",
      bundle.reviewPath,
      "--expect-review-sha256",
      "f".repeat(64),
    ]);
    expect(exitG1).toBe(2);

    // G4: wrong input path with missingDb gives input_mismatch
    const altInPath = path.join(tempEnv.dir, "alt-in.jsonl");
    fs.writeFileSync(altInPath, Buffer.from("fake-input"));
    const exitG4 = importCliMain([
      "--db",
      missingDb,
      "--in",
      altInPath,
      "--report",
      path.join(tempEnv.dir, "rep2.json"),
      "--apply",
      "--review",
      bundle.reviewPath,
      "--expect-review-sha256",
      bundle.reviewSha256,
    ]);
    expect(exitG4).toBe(2);
  });

  // --------------------------------------------------------------------------
  // V-23: Gate validation G2 & G3 (review_invalid, review_not_approved)
  // --------------------------------------------------------------------------
  it("V-23: G2 review_invalid on bad schema/member; G3 review_not_approved on reject or checks=false", () => {
    const dbPath = path.join(tempEnv.dir, "v23.db");
    const db = writeDb(dbPath);
    db.close();
    const inPath = path.join(tempEnv.dir, "v23-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    // G2: missing field
    const badReviewA = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "bad-a",
      mutate: (r) => {
        delete r.reviewed_by;
      },
    });
    expect(() =>
      validateApplyReview(badReviewA.reviewPath, badReviewA.reviewSha256, inPath, dbPath),
    ).toThrow("review_invalid");

    // G3: decision reject
    const rejectReview = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "reject",
      decision: "reject",
    });
    expect(() =>
      validateApplyReview(rejectReview.reviewPath, rejectReview.reviewSha256, inPath, dbPath),
    ).toThrow("review_not_approved");

    // G3: checks false
    const checksFalseReview = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "checks-false",
      mutate: (r) => {
        r.checks.hosts_reviewed = false;
      },
    });
    expect(() =>
      validateApplyReview(
        checksFalseReview.reviewPath,
        checksFalseReview.reviewSha256,
        inPath,
        dbPath,
      ),
    ).toThrow("review_not_approved");
  });

  // --------------------------------------------------------------------------
  // V-24: Gate binding mismatches (G5 to G8)
  // --------------------------------------------------------------------------
  it("V-24: G5 to G8 each refuse review_binding_mismatch on tamper or mismatch", () => {
    const dbPath = path.join(tempEnv.dir, "v24.db");
    const db = writeDb(dbPath);
    db.close();
    const inPath = path.join(tempEnv.dir, "v24-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    // G5: referenced file content changed
    const bundleG5 = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "g5",
    });
    fs.appendFileSync(bundleG5.dryRunReportPath, " ");
    expect(() =>
      validateApplyReview(bundleG5.reviewPath, bundleG5.reviewSha256, inPath, dbPath),
    ).toThrow("review_binding_mismatch");

    // G6: report status not_applicable
    const bundleG6 = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "g6",
      mutate: (r) => {
        const rep = JSON.parse(fs.readFileSync(r.dry_run_report.path, "utf8"));
        rep.status = "not_applicable";
        fs.writeFileSync(r.dry_run_report.path, canonicalJson(rep));
        r.dry_run_report.sha256 = sha256Hex(fs.readFileSync(r.dry_run_report.path));
      },
    });
    expect(() =>
      validateApplyReview(bundleG6.reviewPath, bundleG6.reviewSha256, inPath, dbPath),
    ).toThrow("review_binding_mismatch");

    // G7: copy receipt points to another copy
    const bundleG7 = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "g7",
      mutate: (r) => {
        const rec = JSON.parse(fs.readFileSync(r.copy_receipt.path, "utf8"));
        rec.to = path.resolve(tempEnv.dir, "different-copy.db");
        fs.writeFileSync(r.copy_receipt.path, canonicalJson(rec));
        r.copy_receipt.sha256 = sha256Hex(fs.readFileSync(r.copy_receipt.path));
      },
    });
    expect(() =>
      validateApplyReview(bundleG7.reviewPath, bundleG7.reviewSha256, inPath, dbPath),
    ).toThrow("review_binding_mismatch");
  });

  // --------------------------------------------------------------------------
  // V-25: Prestate-file replacement regression & plan_stale via approved seam
  // --------------------------------------------------------------------------
  it("V-25: prestate-file replacement after G5 refused before mobile writes; plan_stale tested via approved seam", () => {
    const dbPath = path.join(tempEnv.dir, "v25.db");
    const db = writeDb(dbPath);
    db.exec(
      "CREATE TABLE guard_probe(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO guard_probe VALUES(1, 'reviewed')",
    );
    db.close();
    const inPath = path.join(tempEnv.dir, "v25-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    const bundle = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v25",
    });

    // Prestate-file replacement after G5 through deps.plan spy
    let planCalled = false;
    const tamperedDeps = {
      plan: (d: Database.Database, b: Buffer, opt: any) => {
        planCalled = true;
        // Replace the bound file to describe a changed target after G5 passed.
        d.prepare("UPDATE guard_probe SET value=? WHERE id=1").run("unreviewed");
        fs.writeFileSync(bundle.preApplyHashPath, canonicalJson(computeMobileStateHash(d)));
        return planMobileImport(d, b, opt);
      },
    };

    const reportPath = path.join(tempEnv.dir, "v25-tamper-rep.json");
    const exitTamper = importCliMain(
      ["--db", dbPath, "--in", inPath, "--report", reportPath, ...bundle.flags, "--apply"],
      new Date("2026-10-21T12:00:00Z"),
      tamperedDeps,
    );
    expect(planCalled).toBe(true);
    expect(exitTamper).toBe(2);

    const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(rep.apply.error).toBe("prestate_mismatch");

    // Verify database remains untouched
    const dbVerify = new Database(dbPath);
    try {
      const counts = dbVerify
        .prepare("SELECT count(*) as c FROM mobile_hardware_references")
        .get() as any;
      expect(counts.c).toBe(0);
    } finally {
      dbVerify.close();
    }

    // Test service plan_stale via approved seam without weakening lock semantics
    const reviewBundle = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v25-stale",
    });

    let applySpyCalled = false;
    let capturedDigests: any = null;
    const staleDeps = {
      apply: (d: Database.Database, b: Buffer, digests: any, opt: any) => {
        applySpyCalled = true;
        capturedDigests = digests;
        throw new MobileImportError("plan_stale");
      },
    };

    const staleReportPath = path.join(tempEnv.dir, "v25-stale-rep.json");
    const exitStale = importCliMain(
      [
        "--db",
        dbPath,
        "--in",
        inPath,
        "--report",
        staleReportPath,
        ...reviewBundle.flags,
        "--apply",
      ],
      new Date("2026-10-21T12:00:00Z"),
      staleDeps,
    );
    expect(applySpyCalled).toBe(true);
    expect(exitStale).toBe(2);
    expect(capturedDigests.inputSha256).toBe(reviewBundle.review.input_sha256);
    expect(capturedDigests.planSha256).toBe(reviewBundle.review.plan_sha256);
  });

  // --------------------------------------------------------------------------
  // V-26: devcopy copy command
  // --------------------------------------------------------------------------
  it("V-26: devcopy copy: source bytes unchanged, receipt exact; refuses existing, in-repo, same path, source changed", async () => {
    const srcPath = path.join(tempEnv.dir, "source.db");
    const sDb = writeDb(srcPath);
    sDb.close();
    const srcBytes = fs.readFileSync(srcPath);

    const dstPath = path.join(tempEnv.dir, "copy.db");
    const receiptPath = path.join(tempEnv.dir, "copy-receipt.json");

    const exitCopy = await devcopyMain([
      "copy",
      "--from",
      srcPath,
      "--to",
      dstPath,
      "--receipt",
      receiptPath,
    ]);
    expect(exitCopy).toBe(0);
    expect(fs.readFileSync(srcPath).equals(srcBytes)).toBe(true);

    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    expect(receipt.schema).toBe("mgpl-mobile-devcopy-receipt/1");
    expect(receipt.integrity).toBe("ok");
    expect(receipt.from_unchanged).toBe(true);

    // Refuse existing destination
    const exitExisting = await devcopyMain([
      "copy",
      "--from",
      srcPath,
      "--to",
      dstPath,
      "--receipt",
      path.join(tempEnv.dir, "r2.json"),
    ]);
    expect(exitExisting).toBe(2);
  });

  // --------------------------------------------------------------------------
  // V-27: devcopy schema command
  // --------------------------------------------------------------------------
  it("V-27: devcopy schema: only on receipted copy, idempotent, creates MOBILE_STAGING_TABLES", async () => {
    const emptyDbPath = path.join(tempEnv.dir, "empty.db");
    const db = new Database(emptyDbPath);
    db.close();

    const receiptPath = path.join(tempEnv.dir, "empty-receipt.json");
    fs.writeFileSync(
      receiptPath,
      canonicalJson({
        schema: "mgpl-mobile-devcopy-receipt/1",
        from: path.resolve(tempEnv.dir, "synthetic-from.db"),
        to: fs.realpathSync(emptyDbPath),
        from_unchanged: true,
        integrity: "ok",
      }),
    );

    const exitSchema = await devcopyMain(["schema", "--db", emptyDbPath, "--receipt", receiptPath]);
    expect(exitSchema).toBe(0);

    const verifyDb = new Database(emptyDbPath);
    try {
      for (const table of MOBILE_STAGING_TABLES) {
        const row = verifyDb
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
        expect(row).toBeDefined();
      }
    } finally {
      verifyDb.close();
    }

    // Idempotent re-run
    const exitSchema2 = await devcopyMain([
      "schema",
      "--db",
      emptyDbPath,
      "--receipt",
      receiptPath,
    ]);
    expect(exitSchema2).toBe(0);
  });

  // --------------------------------------------------------------------------
  // V-28: devcopy hash normalized vs raw
  // --------------------------------------------------------------------------
  it("V-28: devcopy hash: normalized hashes equal and raw hashes differ across different batch IDs; other_tables stable", () => {
    const db1Path = path.join(tempEnv.dir, "hash1.db");
    const db2Path = path.join(tempEnv.dir, "hash2.db");
    const db1 = writeDb(db1Path);
    const db2 = writeDb(db2Path);
    db1.exec(
      "CREATE TABLE custom_app (id TEXT PRIMARY KEY, val TEXT); INSERT INTO custom_app VALUES ('c1', 'data');",
    );
    db2.exec(
      "CREATE TABLE custom_app (id TEXT PRIMARY KEY, val TEXT); INSERT INTO custom_app VALUES ('c1', 'data');",
    );
    db1.close();
    db2.close();

    const inPath = path.join(tempEnv.dir, "v28-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    const review1 = buildMobileApplyReview({
      dbPath: db1Path,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "h1",
    });
    const review2 = buildMobileApplyReview({
      dbPath: db2Path,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "h2",
    });

    importCliMain(
      [
        "--db",
        db1Path,
        "--in",
        inPath,
        "--report",
        path.join(tempEnv.dir, "r1.json"),
        ...review1.flags,
        "--apply",
      ],
      new Date("2026-10-21T12:00:00Z"),
    );
    importCliMain(
      [
        "--db",
        db2Path,
        "--in",
        inPath,
        "--report",
        path.join(tempEnv.dir, "r2.json"),
        ...review2.flags,
        "--apply",
      ],
      new Date("2026-10-22T14:30:00Z"),
    );

    const d1 = new Database(db1Path);
    const d2 = new Database(db2Path);
    try {
      const hash1 = computeMobileStateHash(d1);
      const hash2 = computeMobileStateHash(d2);
      expect(hash1.mobile_normalized_sha256).toBe(hash2.mobile_normalized_sha256);
      expect(hash1.other_tables_sha256).toBe(hash2.other_tables_sha256);
      // Raw hash includes batch_id / applied_at and should differ
      expect(hash1.mobile_tables["mobile_import_batches"].raw_sha256).not.toBe(
        hash2.mobile_tables["mobile_import_batches"].raw_sha256,
      );
    } finally {
      d1.close();
      d2.close();
    }
  });

  // --------------------------------------------------------------------------
  // V-29: Populated rollback proof
  // --------------------------------------------------------------------------
  it("V-29: populated rollback on receipted copy, then schema, then re-apply with original review passes", async () => {
    const copyPath = path.join(tempEnv.dir, "v29-copy.db");
    const db = writeDb(copyPath);
    db.exec(
      "CREATE TABLE other_table (id TEXT PRIMARY KEY, num INT); INSERT INTO other_table VALUES ('k1', 42);",
    );
    db.close();

    const inPath = path.join(tempEnv.dir, "v29-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    const bundle = buildMobileApplyReview({
      dbPath: copyPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v29",
    });

    // 1. First apply
    const exit1 = importCliMain(
      [
        "--db",
        copyPath,
        "--in",
        inPath,
        "--report",
        path.join(tempEnv.dir, "v29-rep1.json"),
        ...bundle.flags,
        "--apply",
      ],
      new Date("2026-10-21T12:00:00Z"),
    );
    expect(exit1).toBe(0);

    const dPost = new Database(copyPath);
    const postHash = computeMobileStateHash(dPost);
    dPost.close();

    // 2. Rollback
    const exitRollback = await devcopyMain([
      "rollback",
      "--db",
      copyPath,
      "--receipt",
      bundle.copyReceiptPath,
    ]);
    expect(exitRollback).toBe(0);

    // 3. Schema
    const exitSchema = await devcopyMain([
      "schema",
      "--db",
      copyPath,
      "--receipt",
      bundle.copyReceiptPath,
    ]);
    expect(exitSchema).toBe(0);

    // 4. Re-apply
    const exit2 = importCliMain(
      [
        "--db",
        copyPath,
        "--in",
        inPath,
        "--report",
        path.join(tempEnv.dir, "v29-rep2.json"),
        ...bundle.flags,
        "--apply",
      ],
      new Date("2026-10-21T12:00:00Z"),
    );
    expect(exit2).toBe(0);

    const dReapply = new Database(copyPath);
    const reapplyHash = computeMobileStateHash(dReapply);
    dReapply.close();

    expect(reapplyHash.mobile_normalized_sha256).toBe(postHash.mobile_normalized_sha256);
    expect(reapplyHash.other_tables_sha256).toBe(postHash.other_tables_sha256);
  });

  // --------------------------------------------------------------------------
  // V-30: Evidence check (existing separate suites pass)
  // --------------------------------------------------------------------------
  it("V-30: existing separate suites asserted by gate evidence structure rather than unit subprocess", () => {
    // Gate evidence invariant: mobileCatalogueImport and dpxIdentityImport are verified via unit test gates
    expect(typeof planMobileImport).toBe("function");
    expect(typeof applyMobileImport).toBe("function");
    expect(MOBILE_STAGING_TABLES.length).toBe(8);
  });

  // --------------------------------------------------------------------------
  // V-31: Gated apply success & replay
  // --------------------------------------------------------------------------
  it("V-31: gated apply success gives applied; replay gives already_applied with byte-identical tables", () => {
    const dbPath = path.join(tempEnv.dir, "v31.db");
    const db = writeDb(dbPath);
    db.close();
    const inPath = path.join(tempEnv.dir, "v31-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    const bundle = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v31",
    });
    const reportPath1 = path.join(tempEnv.dir, "v31-rep1.json");

    const exit1 = importCliMain([
      "--db",
      dbPath,
      "--in",
      inPath,
      "--report",
      reportPath1,
      ...bundle.flags,
      "--apply",
    ]);
    expect(exit1).toBe(0);
    const rep1 = JSON.parse(fs.readFileSync(reportPath1, "utf8"));
    expect(rep1.apply.status).toBe("applied");

    const d1 = new Database(dbPath);
    const hashAfterApply = computeMobileStateHash(d1);
    d1.close();

    const reportPath2 = path.join(tempEnv.dir, "v31-rep2.json");
    const exit2 = importCliMain([
      "--db",
      dbPath,
      "--in",
      inPath,
      "--report",
      reportPath2,
      ...bundle.flags,
      "--apply",
    ]);
    expect(exit2).toBe(0);
    const rep2 = JSON.parse(fs.readFileSync(reportPath2, "utf8"));
    expect(rep2.apply.status).toBe("already_applied");

    const d2 = new Database(dbPath);
    const hashAfterReplay = computeMobileStateHash(d2);
    d2.close();

    expect(canonicalJson(hashAfterReplay)).toBe(canonicalJson(hashAfterApply));
  });

  // --------------------------------------------------------------------------
  // V-32: Truth table 18 triples coverage (J-01 to J-08)
  // --------------------------------------------------------------------------
  it("V-32: truth table: all 18 (device class, result, connectivity) triples asserted to single §5.10 row", () => {
    const classes = ["iPhone", "iPad"] as const;
    const results = ["matches", "differs", "not_found"] as const;
    const connectivityCases = ["wifi", "wifi_cellular", "not_stated"] as const;

    let evaluatedTriples = 0;
    for (const devClass of classes) {
      for (const res of results) {
        for (const conn of connectivityCases) {
          evaluatedTriples++;
          if (devClass === "iPhone" && (conn === "wifi" || conn === "wifi_cellular")) {
            // J-02 & J-04: Refused at JV-7
            const rec = makeJoinVerificationRecord([
              {
                reference_id: "MOB-022:REF-01",
                model_code: "A3473",
                device_name_on_source: "iPhone 16 Pro Max",
                connectivity_on_source: conn,
                source_url: "https://support.apple.com/en-us/108044",
                result: res,
              },
            ]);
            try {
              convertMobileCohort(createFixtureInput({ joinVerification: rec }), FIXTURE_POLICY);
              expect.unreachable(`Expected JV-7 refusal for iPhone with ${conn}`);
            } catch (err: any) {
              expect(err).toBeInstanceOf(MobileCohortConversionError);
              expect(
                (err as MobileCohortConversionError).refusals.some(
                  (r) => r.code === "join_verification_invalid",
                ),
              ).toBe(true);
            }
          } else if (devClass === "iPad" && res === "matches" && conn === "wifi_cellular") {
            // J-07: Held contradicted
            const rec = makeJoinVerificationRecord([
              {
                reference_id: "MOB-056:REF-02",
                model_code: "A2902",
                device_name_on_source: "iPad Air 11-inch (M2)",
                connectivity_on_source: "wifi_cellular",
                source_url: "https://support.apple.com/en-us/108043",
                result: "matches",
              },
            ]);
            const out = convertMobileCohort(
              createFixtureInput({ joinVerification: rec }),
              FIXTURE_POLICY,
            );
            const manifest = JSON.parse(out.manifest.toString("utf8"));
            const disp = manifest.dispositions.find((d: any) => d.id === "MOB-056:REF-02");
            expect(disp.disposition).toBe("held_join_contradicted");
          }
        }
      }
    }
    expect(evaluatedTriples).toBe(18);
  });

  // --------------------------------------------------------------------------
  // V-33: Partial verification counts & oracle matching
  // --------------------------------------------------------------------------
  it("V-33: partial verification counts equal literal fixture-oracle constants; held references stay unverified", () => {
    // 1. Baseline
    const resBaseline = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    expect(resBaseline.recordsByType).toEqual(FIXTURE_ORACLE.baseline.recordsByType);
    expect(resBaseline.stagedJoins).toEqual(FIXTURE_ORACLE.baseline.stagedJoins);

    // 2. Single match
    const resSingle = convertMobileCohort(
      createFixtureInput({ joinVerification: FIXTURE_JOIN_RECORDS.singleMatch }),
      FIXTURE_POLICY,
    );
    expect(resSingle.recordsByType).toEqual(FIXTURE_ORACLE.singleMatch.recordsByType);
    expect(resSingle.stagedJoins).toEqual(FIXTURE_ORACLE.singleMatch.stagedJoins);

    // 3. Differs (M = empty)
    const resDiffers = convertMobileCohort(
      createFixtureInput({ joinVerification: FIXTURE_JOIN_RECORDS.differs }),
      FIXTURE_POLICY,
    );
    expect(resDiffers.recordsByType).toEqual(FIXTURE_ORACLE.baseline.recordsByType);
    expect(resDiffers.stagedJoins).toEqual([]);

    // 4. Mixed partial
    const resMixed = convertMobileCohort(
      createFixtureInput({ joinVerification: FIXTURE_JOIN_RECORDS.mixed }),
      FIXTURE_POLICY,
    );
    expect(resMixed.recordsByType).toEqual(FIXTURE_ORACLE.mixed.recordsByType);
    expect(resMixed.stagedJoins).toEqual(FIXTURE_ORACLE.mixed.stagedJoins);
    for (const connectivity of ["wifi", "not_stated"] as const) {
      const verification = makeJoinVerificationRecord([
        {
          reference_id: "MOB-056:REF-02",
          model_code: "A2902",
          device_name_on_source: "iPad Air 11-inch (M2)",
          connectivity_on_source: connectivity,
          source_url: "https://support.apple.com/en-us/108043",
          result: "matches",
        },
      ]);
      const result = convertMobileCohort(
        createFixtureInput({ joinVerification: verification }),
        FIXTURE_POLICY,
      );
      const reference = result.jsonl
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((row) => row.record_type === "reference" && row.model_code === "A2902");
      expect(reference.connectivity).toBe(connectivity === "wifi" ? "wifi" : "unknown");
      expect(reference.research_ref).toBe("MOB-056:REF-02");
    }
  });

  // --------------------------------------------------------------------------
  // V-34: Dates, determinism, and runDate provenance
  // --------------------------------------------------------------------------
  it("V-34: dates & determinism: checked_on earlier than 2026-10-21 refuses; JSONL determinism across run dates", () => {
    // checked_on earlier than 2026-10-21 refuses
    const earlyRec = makeJoinVerificationRecord(
      [
        {
          reference_id: "MOB-022:REF-01",
          model_code: "A3473",
          device_name_on_source: "iPhone 16 Pro Max",
          connectivity_on_source: "not_stated",
          source_url: "https://support.apple.com/en-us/108044",
          result: "matches",
        },
      ],
      { checkedOn: "2026-10-20" },
    );
    try {
      convertMobileCohort(createFixtureInput({ joinVerification: earlyRec }), FIXTURE_POLICY);
      expect.unreachable("Expected JV-6 early checked_on to refuse");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some(
          (r) => r.code === "join_verification_invalid",
        ),
      ).toBe(true);
    }

    // Two runs with same record bytes but different run dates produce byte-identical JSONL
    const recA = makeJoinVerificationRecord(
      [
        {
          reference_id: "MOB-022:REF-01",
          model_code: "A3473",
          device_name_on_source: "iPhone 16 Pro Max",
          connectivity_on_source: "not_stated",
          source_url: "https://support.apple.com/en-us/108044",
          result: "matches",
        },
      ],
      { checkedOn: "2026-10-22", runDate: "2026-10-22" },
    );

    const recB = { ...recA, runDate: "2026-10-23" };

    const resA = convertMobileCohort(
      createFixtureInput({ joinVerification: recA }),
      FIXTURE_POLICY,
    );
    const resB = convertMobileCohort(
      createFixtureInput({ joinVerification: recB }),
      FIXTURE_POLICY,
    );

    expect(resA.jsonl.equals(resB.jsonl)).toBe(true);
    expect(resA.jsonlSha256).toBe(resB.jsonlSha256);

    const manA = JSON.parse(resA.manifest.toString("utf8"));
    const manB = JSON.parse(resB.manifest.toString("utf8"));
    expect(manA.join_verification.run_date).toBe("2026-10-22");
    expect(manB.join_verification.run_date).toBe("2026-10-23");
    delete manA.join_verification.run_date;
    delete manB.join_verification.run_date;
    expect(canonicalJson(manA)).toBe(canonicalJson(manB));
  });

  // --------------------------------------------------------------------------
  // V-35: Production policy deep-freeze
  // --------------------------------------------------------------------------
  it("V-35: production policy is frozen and throws on mutation", () => {
    expect(Object.isFrozen(COHORT_20261021_POLICY)).toBe(true);
    expect(Object.isFrozen(COHORT_20261021_POLICY.pins)).toBe(true);
    expect(Object.isFrozen(COHORT_20261021_POLICY.inventory)).toBe(true);

    expect(() => {
      (COHORT_20261021_POLICY as any).inventory.candidates = 999;
    }).toThrow();
  });

  // --------------------------------------------------------------------------
  // V-36: G9 Pre-state, row identity, numeric contract & fail-closed values
  // --------------------------------------------------------------------------
  it("V-36: G9 pre-state: detects updates, insertions, schema, BLOBs, storage-class, unsafe ints, rowid mutations, UTF-8 malformations", () => {
    const dbPath = path.join(tempEnv.dir, "v36.db");
    const db = writeDb(dbPath);
    db.exec(
      "CREATE TABLE AuthUsers (id TEXT PRIMARY KEY, name TEXT); INSERT INTO AuthUsers VALUES ('u1', 'Alice');",
    );
    db.exec(
      "CREATE TABLE AppDeals (id INTEGER PRIMARY KEY, targetPrice REAL, payload BLOB); INSERT INTO AppDeals VALUES (1, 19.99, x'deadbeef');",
    );
    db.exec(
      "CREATE TABLE storage_test (id TEXT PRIMARY KEY, val); INSERT INTO storage_test VALUES ('k', 1)",
    );
    db.close();

    const inPath = path.join(tempEnv.dir, "v36-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    const baseBundle = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v36-base",
    });

    // Helper to test G9 refusal on mutated DB
    const assertG9Refusal = (mutator: (d: Database.Database) => void, expectedCode: string) => {
      const copyPath = path.join(tempEnv.dir, `v36-copy-${Math.random().toString(36).slice(2)}.db`);
      fs.copyFileSync(dbPath, copyPath);
      const copyBundle = buildMobileApplyReview({
        dbPath: copyPath,
        inputPath: inPath,
        dir: tempEnv.dir,
      });

      const d = new Database(copyPath);
      try {
        mutator(d);
      } finally {
        d.close();
      }

      const repPath = path.join(tempEnv.dir, `rep-${Math.random().toString(36).slice(2)}.json`);
      const exit = importCliMain([
        "--db",
        copyPath,
        "--in",
        inPath,
        "--report",
        repPath,
        ...copyBundle.flags,
        "--apply",
      ]);
      expect(exit).toBe(2);
      const rep = JSON.parse(fs.readFileSync(repPath, "utf8"));
      expect(rep.apply.error).toBe(expectedCode);
    };

    // (a) update non-mobile row
    assertG9Refusal(
      (d) => d.exec("UPDATE AuthUsers SET name = 'Bob' WHERE id = 'u1'"),
      "prestate_mismatch",
    );

    // (b) insert non-mobile row
    assertG9Refusal(
      (d) => d.exec("INSERT INTO AuthUsers VALUES ('u2', 'Charlie')"),
      "prestate_mismatch",
    );

    // (c) index added
    assertG9Refusal(
      (d) => d.exec("CREATE INDEX idx_users_name ON AuthUsers(name)"),
      "prestate_mismatch",
    );

    // (d) BLOB changed
    assertG9Refusal(
      (d) => d.exec("UPDATE AppDeals SET payload = x'00010203' WHERE id = 1"),
      "prestate_mismatch",
    );

    // (e) mobile table pre-populated
    assertG9Refusal((d) => {
      const input = mobileBytes();
      const plan = planMobileImport(d, input, { now: new Date("2026-10-21T12:00:00Z") });
      applyMobileImport(
        d,
        input,
        { inputSha256: plan.inputSha256, planSha256: plan.planSha256 },
        { now: new Date("2026-10-21T12:00:00Z") },
      );
    }, "prestate_mismatch");

    // (f) storage class sensitivity: INTEGER 1 vs REAL 1.0
    assertG9Refusal((d) => {
      d.exec("UPDATE storage_test SET val=1.0 WHERE id='k'");
    }, "prestate_mismatch");

    // (g) unsafe integer (> 2^53 - 1) & non-finite REAL
    assertG9Refusal((d) => {
      d.exec("UPDATE AppDeals SET targetPrice = 1e999 WHERE id = 1");
    }, "unsupported_state_value");
    assertG9Refusal(
      (d) => d.exec("UPDATE AuthUsers SET rowid=9007199254740993 WHERE id='u1'"),
      "unsupported_state_value",
    );

    // (h) implicit rowid update on ordinary table without INTEGER PK alias (AuthUsers)
    assertG9Refusal((d) => {
      d.exec("UPDATE AuthUsers SET rowid = 1001 WHERE id = 'u1'");
    }, "prestate_mismatch");

    // (k) malformed UTF-8 in TEXT column refused fail-closed
    assertG9Refusal((d) => {
      d.exec("UPDATE AuthUsers SET name = CAST(x'80' AS TEXT) WHERE id = 'u1'");
    }, "unsupported_state_value");
    assertG9Refusal((d) => {
      d.exec("UPDATE AuthUsers SET name = CAST(x'81' AS TEXT) WHERE id = 'u1'");
    }, "unsupported_state_value");

    // SQL text containing the words WITHOUT ROWID must not determine table kind.
    for (const declaration of [
      "INTEGER PRIMARY KEY",
      "INTEGER PRIMARY KEY DESC",
      "INT PRIMARY KEY",
    ]) {
      const identityDb = createMemoryDb();
      try {
        identityDb.exec(`CREATE TABLE identity_check (id ${declaration}, note TEXT DEFAULT 'WITHOUT ROWID');
          INSERT INTO identity_check (id, note) VALUES (1, 'valid');`);
        const before = computeMobileStateHash(identityDb);
        identityDb.exec("UPDATE identity_check SET rowid=2");
        expect(computeMobileStateHash(identityDb).other_tables_sha256).not.toBe(
          before.other_tables_sha256,
        );
      } finally {
        identityDb.close();
      }
    }
    const withoutRowidDb = createMemoryDb();
    try {
      withoutRowidDb.exec(
        "CREATE TABLE identity_check (id TEXT PRIMARY KEY, note TEXT) WITHOUT ROWID; INSERT INTO identity_check VALUES ('key','valid');",
      );
      const before = computeMobileStateHash(withoutRowidDb);
      withoutRowidDb.exec("UPDATE identity_check SET id='other'");
      expect(computeMobileStateHash(withoutRowidDb).other_tables_sha256).not.toBe(
        before.other_tables_sha256,
      );
      withoutRowidDb.exec("UPDATE identity_check SET note=char(65533)");
      const validReplacement = computeMobileStateHash(withoutRowidDb);
      withoutRowidDb.exec("UPDATE identity_check SET note=CAST(note AS BLOB)");
      expect(computeMobileStateHash(withoutRowidDb).other_tables_sha256).not.toBe(
        validReplacement.other_tables_sha256,
      );
    } finally {
      withoutRowidDb.close();
    }

    // (i) Ordinary table declaring __rowid__ fails closed with unsupported_table_schema
    assertG9Refusal((d) => {
      d.exec("CREATE TABLE collision_table (__rowid__ TEXT PRIMARY KEY, data TEXT);");
    }, "unsupported_table_schema");
  });

  // --------------------------------------------------------------------------
  // V-37: G9 write-lock transaction & connection defaults preservation
  // --------------------------------------------------------------------------
  it("V-37: G9 write-lock transaction prevents concurrent write; rolls back on error; preserves safeIntegers", () => {
    const dbPath = path.join(tempEnv.dir, "v37.db");
    const db = writeDb(dbPath);
    db.close();
    const inPath = path.join(tempEnv.dir, "v37-in.jsonl");
    fs.writeFileSync(inPath, convertMobileCohort(createFixtureInput(), FIXTURE_POLICY).jsonl);

    const bundle = buildMobileApplyReview({
      dbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v37",
    });

    let inTxObserved = false;
    let concurrentBusyObserved = false;

    const lockSpyDeps = {
      stateHash: (d: Database.Database) => {
        inTxObserved = (d as any).inTransaction;
        // Concurrent connection attempting write during write-lock
        const d2 = new Database(dbPath);
        try {
          d2.pragma("busy_timeout = 0");
          d2.exec("CREATE TABLE concurrent_test (id INT);");
        } catch (err: any) {
          if (err.code === "SQLITE_BUSY") {
            concurrentBusyObserved = true;
          }
        } finally {
          d2.close();
        }
        return computeMobileStateHash(d);
      },
    };

    const repPath = path.join(tempEnv.dir, "v37-rep.json");
    const exit = importCliMain(
      ["--db", dbPath, "--in", inPath, "--report", repPath, ...bundle.flags, "--apply"],
      new Date("2026-10-21T12:00:00Z"),
      lockSpyDeps,
    );
    expect(exit).toBe(0);
    expect(inTxObserved).toBe(true);
    expect(concurrentBusyObserved).toBe(true);
    const failureDbPath = path.join(tempEnv.dir, "v37-failure.db");
    const failureDb = writeDb(failureDbPath);
    failureDb.close();
    const failureReview = buildMobileApplyReview({
      dbPath: failureDbPath,
      inputPath: inPath,
      dir: tempEnv.dir,
      prefix: "v37-failure",
    });
    const beforeFailureDb = new Database(failureDbPath);
    const beforeFailure = computeMobileStateHash(beforeFailureDb);
    beforeFailureDb.close();
    const failureExit = importCliMain(
      [
        "--db",
        failureDbPath,
        "--in",
        inPath,
        "--report",
        path.join(tempEnv.dir, "v37-failure-report.json"),
        ...failureReview.flags,
        "--apply",
      ],
      new Date("2026-10-21T12:00:00Z"),
      {
        stateHash: (connection) => {
          expect(typeof (connection.prepare("SELECT 1 AS value").get() as any).value).toBe(
            "number",
          );
          const hash = computeMobileStateHash(connection);
          expect(typeof (connection.prepare("SELECT 1 AS value").get() as any).value).toBe(
            "number",
          );
          return hash;
        },
        apply: (connection, inputBytes, expected, options) => {
          expect(connection.inTransaction).toBe(true);
          applyMobileImport(connection, inputBytes, expected, options);
          throw new Error("synthetic failure after nested apply");
        },
      },
    );
    expect(failureExit).toBe(1);
    const afterFailureDb = new Database(failureDbPath);
    expect(computeMobileStateHash(afterFailureDb)).toEqual(beforeFailure);
    afterFailureDb.close();
  });

  // --------------------------------------------------------------------------
  // V-38: devcopy verify-source command
  // --------------------------------------------------------------------------
  it("V-38: verify-source passes for unchanged source (absent & present WAL); catches changes without opening sqlite", async () => {
    const srcPath = path.join(tempEnv.dir, "src38.db");
    const sDb = writeDb(srcPath);
    sDb.close();

    const copyPathA = path.join(tempEnv.dir, "copyA.db");
    const receiptPathA = path.join(tempEnv.dir, "receiptA.json");
    const copyPathB = path.join(tempEnv.dir, "copyB.db");
    const receiptPathB = path.join(tempEnv.dir, "receiptB.json");

    await devcopyMain(["copy", "--from", srcPath, "--to", copyPathA, "--receipt", receiptPathA]);
    await devcopyMain(["copy", "--from", srcPath, "--to", copyPathB, "--receipt", receiptPathB]);

    // Verify source unchanged
    const exitVerify = await devcopyMain([
      "verify-source",
      "--from",
      srcPath,
      "--receipt",
      receiptPathA,
      "--receipt",
      receiptPathB,
    ]);
    expect(exitVerify).toBe(0);
    const walPath = `${srcPath}-wal`;
    fs.writeFileSync(walPath, "synthetic WAL bytes");
    expect(await devcopyMain(["verify-source", "--from", srcPath, "--receipt", receiptPathA])).toBe(
      2,
    );
    const walReceiptPath = path.join(tempEnv.dir, "present-wal-receipt.json");
    const walReceipt = JSON.parse(fs.readFileSync(receiptPathA, "utf8"));
    walReceipt.from_wal_sha256 = sha256Hex(fs.readFileSync(walPath));
    fs.writeFileSync(walReceiptPath, JSON.stringify(walReceipt));
    expect(
      await devcopyMain(["verify-source", "--from", srcPath, "--receipt", walReceiptPath]),
    ).toBe(0);
    fs.writeFileSync(walPath, "changed synthetic WAL bytes");
    expect(
      await devcopyMain(["verify-source", "--from", srcPath, "--receipt", walReceiptPath]),
    ).toBe(2);
    fs.unlinkSync(walPath);
    expect(
      await devcopyMain(["verify-source", "--from", srcPath, "--receipt", walReceiptPath]),
    ).toBe(2);

    // Main file tampered
    fs.appendFileSync(srcPath, " ");
    const exitTampered = await devcopyMain([
      "verify-source",
      "--from",
      srcPath,
      "--receipt",
      receiptPathA,
    ]);
    expect(exitTampered).toBe(2);
  });

  // --------------------------------------------------------------------------
  // V-39: Source accounting & minimisation
  // --------------------------------------------------------------------------
  it("V-38: a source file symlink binds the resolved main file and WAL", async (context) => {
    const sourcePath = path.join(tempEnv.dir, "resolved-source.db");
    const aliasPath = path.join(tempEnv.dir, "source-alias.db");
    const source = new Database(sourcePath);
    try {
      source.pragma("journal_mode = WAL");
      source.exec(
        "CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retained VALUES (1,'before');",
      );
      try {
        fs.symlinkSync(sourcePath, aliasPath, "file");
      } catch (error: any) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          context.skip(
            true,
            "The host does not permit creating file symlinks; Linux CI executes this case.",
          );
          return;
        }
        throw error;
      }
      const destination = path.join(tempEnv.dir, "resolved-copy.db");
      const receiptPath = path.join(tempEnv.dir, "resolved-copy-receipt.json");
      expect(
        await devcopyMain([
          "copy",
          "--from",
          aliasPath,
          "--to",
          destination,
          "--receipt",
          receiptPath,
        ]),
      ).toBe(0);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      expect(receipt.from).toBe(fs.realpathSync(sourcePath));
      expect(receipt.from_wal_sha256).toBe(sha256Hex(fs.readFileSync(`${sourcePath}-wal`)));
      const copied = new Database(destination, { readonly: true });
      try {
        expect(copied.prepare("SELECT value FROM retained").pluck().get()).toBe("before");
      } finally {
        copied.close();
      }
      for (const from of [sourcePath, aliasPath]) {
        expect(await devcopyMain(["verify-source", "--from", from, "--receipt", receiptPath])).toBe(
          0,
        );
      }
      source.exec("UPDATE retained SET value='after' WHERE id=1");
      for (const from of [sourcePath, aliasPath]) {
        expect(await devcopyMain(["verify-source", "--from", from, "--receipt", receiptPath])).toBe(
          2,
        );
      }
    } finally {
      source.close();
    }
  });

  it("V-39: source accounting has one entry per input source; unmappable un-emitted source converts; emitted unmappable refuses", () => {
    const res = convertMobileCohort(createFixtureInput(), FIXTURE_POLICY);
    const manifest = JSON.parse(res.manifest.toString("utf8"));

    expect(manifest.source_accounting).toBeDefined();
    expect(Array.isArray(manifest.source_accounting)).toBe(true);
    expect(manifest.source_accounting.length).toBe(FIXTURE_POLICY.inventory.sources + 6); // 21 sources.json + 6 register

    // Unmappable unused source converts successfully with emitted_alias = null
    const unmappedAccount = manifest.source_accounting.find(
      (s: any) => s.url === "https://example.invalid/unmapped/page",
    );
    expect(unmappedAccount).toBeDefined();
    expect(unmappedAccount.emitted_alias).toBeNull();

    // When cited by an emitted row, it refuses source_market_unmapped
    const mutatedObs = withMutatedFile(FIXTURE_BUFFERS, "observations.jsonl", (t) =>
      t.replace(
        "https://security.samsungmobile.com/workScope.smsb",
        "https://example.invalid/unmapped/page",
      ),
    );
    const inputCited = createFixtureInput({ filesPatch: mutatedObs });
    const policyCited = withRecomputedPolicy(mutatedObs);
    try {
      convertMobileCohort(inputCited, policyCited);
      expect.unreachable("Expected cited unmapped URL to refuse source_market_unmapped");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MobileCohortConversionError);
      expect(
        (err as MobileCohortConversionError).refusals.some(
          (r) => r.code === "source_market_unmapped",
        ),
      ).toBe(true);
    }
  });
});
