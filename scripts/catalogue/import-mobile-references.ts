// Explicit offline staging import. This command never opens the application default database.
import Database from "better-sqlite3";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { landingPath } from "./sample-check.mjs";
import { safeErrorMessage } from "../../src/utils/errorSanitizer";
import {
  computeMobileStateHash,
  canonicalJson,
  type MobileStateHash,
  type MobileDevCopyReceipt,
} from "./mobile-devcopy";
import {
  MOBILE_IMPORT_LIMITS,
  MOBILE_STAGING_TABLES,
  MobileImportError,
  planMobileImport,
  applyMobileImport,
  type MobileApplyResult,
  type MobileImportReport,
  type MobileImportErrorCode,
  type MobileImportCounts,
  type ReportStatus,
} from "../../src/services/mobileCatalogueImport";

export type MobileCliErrorCode =
  | MobileImportErrorCode
  | "prestate_mismatch"
  | "unsupported_state_value"
  | "unsupported_table_schema";

export type MobileReportFile = MobileImportReport & {
  mode: "dry_run" | "apply";
  apply: MobileApplyResult | { error: MobileCliErrorCode } | null;
};

export type MobileConsoleLine = {
  mode: "dry_run" | "apply";
  status: ReportStatus | MobileApplyResult["status"] | MobileCliErrorCode;
  inputSha256: string;
  counts: MobileImportCounts;
  batchId: string | null;
};

export interface ReviewArtifact {
  schema: "mgpl-mobile-dryrun-review/1";
  decision: "approve" | "reject";
  reviewed_by: string;
  reviewed_at: string;
  input_sha256: string;
  plan_sha256: string;
  dry_run_report: { path: string; sha256: string };
  copy_receipt: { path: string; sha256: string };
  conversion_manifest: { path: string; sha256: string };
  pre_apply_hash: { path: string; sha256: string };
  expected_counts: {
    records: number;
    inserted: number;
    inserted_quarantined: number;
    oracle: string;
  };
  checks: {
    counts_match_oracle: boolean;
    quarantined_lines_match_manifest: boolean;
    hosts_reviewed: boolean;
  };
}

export class Refusal extends Error {}
// Keep the exact parsed bytes checked at G5/G8. Re-reading a path at G9 would
// allow replacement of the operator-pinned state between validation and apply.
const validatedStates = new WeakMap<ReviewArtifact, MobileStateHash>();
export function refuse(message: string): never {
  throw new Refusal(message);
}

export function validateApplyReview(
  reviewArg:
    | string
    | {
        reviewPath?: string;
        review?: string;
        "--review"?: string;
        expectReviewSha256?: string;
        expect_review_sha256?: string;
        "--expect-review-sha256"?: string;
        inPath?: string;
        in?: string;
        "--in"?: string;
        dbPath?: string;
        db?: string;
        "--db"?: string;
      },
  expectReviewSha256Arg?: string,
  inPathArg?: string,
  dbPathArg?: string,
): ReviewArtifact {
  let reviewPath: string;
  let expectReviewSha256: string;
  let inPath: string;
  let dbPath: string;

  if (typeof reviewArg === "string") {
    reviewPath = reviewArg;
    expectReviewSha256 = expectReviewSha256Arg ?? "";
    inPath = inPathArg ?? "";
    dbPath = dbPathArg ?? "";
  } else {
    reviewPath = reviewArg.reviewPath ?? reviewArg.review ?? reviewArg["--review"] ?? "";
    expectReviewSha256 =
      reviewArg.expectReviewSha256 ??
      reviewArg.expect_review_sha256 ??
      reviewArg["--expect-review-sha256"] ??
      expectReviewSha256Arg ??
      "";
    inPath = reviewArg.inPath ?? reviewArg.in ?? reviewArg["--in"] ?? inPathArg ?? "";
    dbPath = reviewArg.dbPath ?? reviewArg.db ?? reviewArg["--db"] ?? dbPathArg ?? "";
  }

  // G1: SHA-256 of review file's bytes equals --expect-review-sha256
  if (!expectReviewSha256 || !/^[0-9a-f]{64}$/.test(expectReviewSha256)) {
    refuse("review_digest_mismatch");
  }
  let reviewBytes: Buffer;
  try {
    if (!existsSync(reviewPath)) refuse("review_digest_mismatch");
    reviewBytes = readFileSync(reviewPath);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    refuse("review_digest_mismatch");
  }
  const reviewSha = createHash("sha256").update(reviewBytes).digest("hex");
  if (reviewSha !== expectReviewSha256) {
    refuse("review_digest_mismatch");
  }

  // G2: The review parses and has exactly the members, types, formats and enumerations
  let review: ReviewArtifact;
  try {
    review = JSON.parse(reviewBytes.toString("utf8"));
  } catch {
    refuse("review_invalid");
  }
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    refuse("review_invalid");
  }

  const expectedTopKeys = [
    "checks",
    "conversion_manifest",
    "copy_receipt",
    "decision",
    "dry_run_report",
    "expected_counts",
    "input_sha256",
    "plan_sha256",
    "pre_apply_hash",
    "reviewed_at",
    "reviewed_by",
    "schema",
  ];
  const topKeys = Object.keys(review).sort();
  if (
    topKeys.length !== expectedTopKeys.length ||
    !topKeys.every((k, i) => k === expectedTopKeys[i])
  ) {
    refuse("review_invalid");
  }

  if (review.schema !== "mgpl-mobile-dryrun-review/1") refuse("review_invalid");
  if (review.decision !== "approve" && review.decision !== "reject") refuse("review_invalid");
  if (
    typeof review.reviewed_by !== "string" ||
    review.reviewed_by.length < 1 ||
    review.reviewed_by.length > 80
  ) {
    refuse("review_invalid");
  }
  if (
    typeof review.reviewed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(review.reviewed_at) ||
    isNaN(Date.parse(review.reviewed_at)) ||
    new Date(review.reviewed_at).toISOString().replace(".000Z", "Z") !== review.reviewed_at
  ) {
    refuse("review_invalid");
  }
  if (typeof review.input_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(review.input_sha256)) {
    refuse("review_invalid");
  }
  if (typeof review.plan_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(review.plan_sha256)) {
    refuse("review_invalid");
  }

  const validateFileRef = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const keys = Object.keys(obj).sort();
    if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "sha256") return false;
    if (typeof obj.path !== "string" || !path.isAbsolute(obj.path)) return false;
    if (typeof obj.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(obj.sha256)) return false;
    return true;
  };

  if (
    !validateFileRef(review.dry_run_report) ||
    !validateFileRef(review.copy_receipt) ||
    !validateFileRef(review.conversion_manifest) ||
    !validateFileRef(review.pre_apply_hash)
  ) {
    refuse("review_invalid");
  }

  if (
    !review.expected_counts ||
    typeof review.expected_counts !== "object" ||
    Array.isArray(review.expected_counts)
  ) {
    refuse("review_invalid");
  }
  const ecKeys = Object.keys(review.expected_counts).sort();
  if (
    ecKeys.length !== 4 ||
    ecKeys[0] !== "inserted" ||
    ecKeys[1] !== "inserted_quarantined" ||
    ecKeys[2] !== "oracle" ||
    ecKeys[3] !== "records"
  ) {
    refuse("review_invalid");
  }
  if (
    !Number.isSafeInteger(review.expected_counts.records) ||
    review.expected_counts.records < 0 ||
    !Number.isSafeInteger(review.expected_counts.inserted) ||
    review.expected_counts.inserted < 0 ||
    !Number.isSafeInteger(review.expected_counts.inserted_quarantined) ||
    review.expected_counts.inserted_quarantined < 0 ||
    review.expected_counts.oracle !== "WUD-AI-112-r5 5.12"
  ) {
    refuse("review_invalid");
  }

  if (!review.checks || typeof review.checks !== "object" || Array.isArray(review.checks)) {
    refuse("review_invalid");
  }
  const chKeys = Object.keys(review.checks).sort();
  if (
    chKeys.length !== 3 ||
    chKeys[0] !== "counts_match_oracle" ||
    chKeys[1] !== "hosts_reviewed" ||
    chKeys[2] !== "quarantined_lines_match_manifest"
  ) {
    refuse("review_invalid");
  }
  if (
    typeof review.checks.counts_match_oracle !== "boolean" ||
    typeof review.checks.quarantined_lines_match_manifest !== "boolean" ||
    typeof review.checks.hosts_reviewed !== "boolean"
  ) {
    refuse("review_invalid");
  }

  // G3: decision is approve and every checks value is true
  if (
    review.decision !== "approve" ||
    review.checks.counts_match_oracle !== true ||
    review.checks.quarantined_lines_match_manifest !== true ||
    review.checks.hosts_reviewed !== true
  ) {
    refuse("review_not_approved");
  }

  // G4: SHA-256 of --in equals input_sha256
  let inBytes: Buffer;
  try {
    if (!existsSync(inPath)) refuse("input_mismatch");
    inBytes = readFileSync(inPath);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    refuse("input_mismatch");
  }
  const inSha = createHash("sha256").update(inBytes).digest("hex");
  if (inSha !== review.input_sha256) {
    refuse("input_mismatch");
  }

  // G5: Each of the four referenced files exists and its SHA-256 equals recorded
  const refFiles = [
    review.dry_run_report,
    review.copy_receipt,
    review.conversion_manifest,
    review.pre_apply_hash,
  ];
  const fileBuffers = new Map<string, Buffer>();
  for (const rf of refFiles) {
    let b: Buffer;
    try {
      if (!existsSync(rf.path)) refuse("review_binding_mismatch");
      b = readFileSync(rf.path);
    } catch (err) {
      if (err instanceof Refusal) throw err;
      refuse("review_binding_mismatch");
    }
    const h = createHash("sha256").update(b).digest("hex");
    if (h !== rf.sha256) refuse("review_binding_mismatch");
    fileBuffers.set(rf.path, b);
  }

  // G6: Dry-run report verification
  let dryRunReport: MobileReportFile;
  try {
    dryRunReport = JSON.parse(fileBuffers.get(review.dry_run_report.path)!.toString("utf8"));
  } catch {
    refuse("review_binding_mismatch");
  }
  if (!dryRunReport || typeof dryRunReport !== "object") refuse("review_binding_mismatch");
  if (
    dryRunReport.mode !== "dry_run" ||
    dryRunReport.status !== "applicable" ||
    dryRunReport.contract !== "mgpl-mobile-staging/1" ||
    dryRunReport.inputSha256 !== review.input_sha256 ||
    dryRunReport.planSha256 !== review.plan_sha256 ||
    !dryRunReport.counts ||
    dryRunReport.counts.rejected !== 0 ||
    dryRunReport.counts.blocked !== 0 ||
    dryRunReport.records !== review.expected_counts.records ||
    dryRunReport.counts.inserted !== review.expected_counts.inserted ||
    dryRunReport.counts.inserted_quarantined !== review.expected_counts.inserted_quarantined
  ) {
    refuse("review_binding_mismatch");
  }

  // G7: Copy receipt verification
  let copyReceipt: MobileDevCopyReceipt;
  try {
    copyReceipt = JSON.parse(fileBuffers.get(review.copy_receipt.path)!.toString("utf8"));
  } catch {
    refuse("review_binding_mismatch");
  }
  if (!copyReceipt || typeof copyReceipt !== "object") refuse("review_binding_mismatch");
  if (
    copyReceipt.schema !== "mgpl-mobile-devcopy-receipt/1" ||
    copyReceipt.from_unchanged !== true ||
    copyReceipt.integrity !== "ok" ||
    typeof copyReceipt.to !== "string" ||
    typeof copyReceipt.from !== "string"
  ) {
    refuse("review_binding_mismatch");
  }

  let dbReal: string;
  let receiptToReal: string;
  try {
    if (!existsSync(dbPath)) refuse("review_binding_mismatch");
    dbReal = realpathSync(dbPath);
    if (!existsSync(copyReceipt.to)) refuse("review_binding_mismatch");
    receiptToReal = realpathSync(copyReceipt.to);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    refuse("review_binding_mismatch");
  }
  if (receiptToReal !== dbReal) refuse("review_binding_mismatch");

  let receiptFromReal: string;
  try {
    receiptFromReal = existsSync(copyReceipt.from)
      ? realpathSync(copyReceipt.from)
      : path.resolve(copyReceipt.from);
  } catch {
    receiptFromReal = path.resolve(copyReceipt.from);
  }
  if (dbReal === receiptFromReal || dbReal === path.resolve(copyReceipt.from)) {
    refuse("review_binding_mismatch");
  }

  // G8: Conversion manifest and pre-apply hash schema verification
  let conversionManifest: { schema: string; output: { sha256: string } };
  let preApplyHash: MobileStateHash;
  try {
    conversionManifest = JSON.parse(
      fileBuffers.get(review.conversion_manifest.path)!.toString("utf8"),
    );
    preApplyHash = JSON.parse(fileBuffers.get(review.pre_apply_hash.path)!.toString("utf8"));
  } catch {
    refuse("review_binding_mismatch");
  }
  if (
    !conversionManifest ||
    typeof conversionManifest !== "object" ||
    conversionManifest.schema !== "mgpl-mobile-cohort-conversion-manifest/1" ||
    !conversionManifest.output ||
    typeof conversionManifest.output !== "object" ||
    conversionManifest.output.sha256 !== review.input_sha256
  ) {
    refuse("review_binding_mismatch");
  }
  if (
    !preApplyHash ||
    typeof preApplyHash !== "object" ||
    preApplyHash.schema !== "mgpl-mobile-state-hash/1"
  ) {
    refuse("review_binding_mismatch");
  }

  validatedStates.set(review as ReviewArtifact, preApplyHash as MobileStateHash);
  return review as ReviewArtifact;
}

export function main(
  argv: string[],
  now = new Date(),
  deps: Partial<{
    plan: typeof planMobileImport;
    apply: typeof applyMobileImport;
    stateHash: (db: Database.Database) => MobileStateHash;
  }> = {},
): number {
  let db: Database.Database | undefined;
  let reportFd: number | undefined;
  let outerTxOpen = false;
  try {
    if (process.env.NODE_ENV === "production") refuse("production refused");

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(
        "Usage: import-mobile-references --db <file> --in <file> --report <file> [--apply --review <file> --expect-review-sha256 <sha256>]",
      );
      return 0;
    }

    const options = new Map<string, string>();
    let apply = false;
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (key === "--apply") {
        if (apply) refuse("repeated option");
        apply = true;
        continue;
      }
      if (!["--db", "--in", "--report", "--review", "--expect-review-sha256"].includes(key)) {
        refuse("unknown option");
      }
      if (options.has(key)) refuse("repeated option");
      const value = argv[++i];
      if (!value || value.startsWith("--")) refuse("missing option value");
      options.set(key, value);
    }

    if (!["--db", "--in", "--report"].every((k) => options.has(k))) {
      refuse("--db, --in and --report are required");
    }

    if (!apply) {
      if (options.has("--review") || options.has("--expect-review-sha256")) {
        refuse("--review and --expect-review-sha256 require --apply");
      }
    } else {
      if (!options.has("--review") || !options.has("--expect-review-sha256")) {
        refuse("--review and --expect-review-sha256 are required with --apply");
      }
    }

    // Gate Part 1: G1-G8 before database is opened
    let review: ReviewArtifact | undefined;
    if (apply) {
      review = validateApplyReview(
        options.get("--review")!,
        options.get("--expect-review-sha256")!,
        options.get("--in")!,
        options.get("--db")!,
      );
    }

    const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
    const reportPath = landingPath(options.get("--report")!);
    const rel = path.relative(root, reportPath);
    if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
      refuse("report must be outside the repository");
    }
    if (existsSync(reportPath)) refuse("report already exists");

    const bytes = readFileSync(options.get("--in")!);
    if (bytes.length > MOBILE_IMPORT_LIMITS.maxBytes) refuse("input_too_large");

    db = new Database(options.get("--db")!, { readonly: !apply, fileMustExist: true });
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 10000");

    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (MOBILE_STAGING_TABLES.some((t) => !has.get(t))) {
      refuse("tables missing; start the app once against this database so src/db.ts creates them");
    }

    const planFn = deps.plan ?? planMobileImport;
    const applyFn = deps.apply ?? applyMobileImport;
    const stateHashFn = deps.stateHash ?? computeMobileStateHash;

    const report = planFn(db, bytes, { now });

    // Reserve exclusively before any apply, so an existing report can never be overwritten.
    reportFd = openSync(reportPath, "wx");
    const output: MobileReportFile = {
      ...report,
      mode: apply ? "apply" : "dry_run",
      apply: null,
    };
    let status: MobileConsoleLine["status"] = report.status;
    let counts = report.counts;
    let batchId = report.alreadyAppliedBatchId;
    let exitCode = report.status === "not_applicable" ? 2 : 0;

    if (apply) {
      // Step 2: Begin one outer BEGIN IMMEDIATE transaction
      db.exec("BEGIN IMMEDIATE");
      outerTxOpen = true;

      // Step 3: Replay exception check
      const existingBatch = db
        .prepare("SELECT 1 FROM mobile_import_batches WHERE input_sha256 = ? AND plan_sha256 = ?")
        .get(review!.input_sha256, review!.plan_sha256);
      const isReplay = Boolean(existingBatch);

      // Step 4: First-apply state hash comparison
      if (!isReplay) {
        const preApplyHash = validatedStates.get(review!);

        let currentStateHash: MobileStateHash;
        try {
          currentStateHash = stateHashFn(db);
        } catch (err: unknown) {
          if (outerTxOpen) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the original failure while releasing the transaction or file handle.
            }
            outerTxOpen = false;
          }
          const msg = err instanceof Error ? err.message : String(err);
          let refusalCode: "unsupported_state_value" | "unsupported_table_schema" | null = null;
          if (msg.startsWith("unsupported_state_value")) {
            refusalCode = "unsupported_state_value";
          } else if (msg.startsWith("unsupported_table_schema")) {
            refusalCode = "unsupported_table_schema";
          }
          if (refusalCode) {
            output.apply = { error: refusalCode };
            writeFileSync(reportFd, JSON.stringify(output) + "\n");
            console.error(refusalCode);
            return 2;
          }
          throw err;
        }

        let currentCanonical: string;
        let reviewedCanonical: string;
        try {
          currentCanonical = canonicalJson(currentStateHash);
          reviewedCanonical = canonicalJson(preApplyHash);
        } catch (err: unknown) {
          if (outerTxOpen) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the original failure while releasing the transaction or file handle.
            }
            outerTxOpen = false;
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("unsupported_state_value")) {
            output.apply = { error: "unsupported_state_value" };
            writeFileSync(reportFd, JSON.stringify(output) + "\n");
            console.error("unsupported_state_value");
            return 2;
          }
          throw err;
        }

        if (currentCanonical !== reviewedCanonical) {
          if (outerTxOpen) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the original failure while releasing the transaction or file handle.
            }
            outerTxOpen = false;
          }
          output.apply = { error: "prestate_mismatch" };
          writeFileSync(reportFd, JSON.stringify(output) + "\n");
          console.error("prestate_mismatch");
          return 2;
        }
      }

      // Step 5: Call applyMobileImport with review digests
      try {
        const result = applyFn(
          db,
          bytes,
          {
            inputSha256: review!.input_sha256,
            planSha256: review!.plan_sha256,
          },
          { now },
        );
        db.exec("COMMIT");
        outerTxOpen = false;
        output.apply = result;
        status = result.status;
        counts = result.counts;
        batchId = result.batchId;
      } catch (error) {
        if (outerTxOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original failure while releasing the transaction or file handle.
          }
          outerTxOpen = false;
        }
        if (!(error instanceof MobileImportError)) throw error;
        output.apply = { error: error.code };
        status = error.code;
        exitCode = 2;
      }
    }

    writeFileSync(reportFd, JSON.stringify(output) + "\n");
    const consoleLine: MobileConsoleLine = {
      mode: output.mode,
      status,
      inputSha256: report.inputSha256,
      counts,
      batchId,
    };
    console.log(JSON.stringify(consoleLine));
    return exitCode;
  } catch (error) {
    if (error instanceof Refusal || error instanceof MobileImportError) {
      console.error(error.message);
      return 2;
    }
    console.error(safeErrorMessage(error));
    return 1;
  } finally {
    if (outerTxOpen && db) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure while releasing the transaction or file handle.
      }
    }
    if (reportFd !== undefined) {
      try {
        closeSync(reportFd);
      } catch {
        // Preserve the original failure while releasing the transaction or file handle.
      }
    }
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
