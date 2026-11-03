import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, sha256Hex } from "../../src/services/enrichmentPromotion";
import { computeMobileStateHash } from "../../scripts/catalogue/mobile-devcopy";
import { main } from "../../scripts/catalogue/import-mobile-references";

/**
 * Review artifact schema matching mgpl-mobile-dryrun-review/1 per WUD §6.4.
 */
export interface MobileDryRunReviewArtifact {
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

/**
 * Options for building synthetic apply review artifacts.
 */
export interface BuildMobileApplyReviewOptions {
  dbPath: string;
  inputPath: string;
  dir?: string;
  prefix?: string;
  now?: Date;
  reviewedBy?: string;
  reviewedAt?: string;
  decision?: "approve" | "reject";
  dryRunReportPath?: string;
  override?: Record<string, unknown>;
  mutate?: (review: Record<string, any>) => void;
  deps?: Parameters<typeof main>[2];
}

/**
 * Returned review bundle including file paths, SHA-256 digests, and CLI flags.
 */
export interface MobileApplyReviewResult {
  reviewPath: string;
  reviewSha256: string;
  review: MobileDryRunReviewArtifact;
  dryRunReportPath: string;
  dryRunReportSha256: string;
  copyReceiptPath: string;
  copyReceiptSha256: string;
  conversionManifestPath: string;
  conversionManifestSha256: string;
  preApplyHashPath: string;
  preApplyHashSha256: string;
  flags: [string, string, string, string];
}

/**
 * Builds the §6.4 artifacts for a target fixture database: a receipt, a dry-run report
 * produced by the real dry run, a minimal conversion manifest {schema, output:{sha256}},
 * a pre-apply hash file written by computeMobileStateHash, and a pinned review.
 *
 * Public API reusable by unit and verification (V-21 to V-25, V-31, V-36, V-37) tests.
 * Lets tests modify any one field via override or mutate function.
 */
export function buildMobileApplyReview(
  optionsOrDbPath: string | BuildMobileApplyReviewOptions,
  inputPathArg?: string,
  extraOptions?: Partial<BuildMobileApplyReviewOptions>,
): MobileApplyReviewResult {
  const options: BuildMobileApplyReviewOptions =
    typeof optionsOrDbPath === "string"
      ? { dbPath: optionsOrDbPath, inputPath: inputPathArg!, ...extraOptions }
      : optionsOrDbPath;

  const resolvedDbPath = path.resolve(options.dbPath);
  const resolvedInputPath = path.resolve(options.inputPath);
  const targetDir = options.dir ?? path.dirname(resolvedDbPath);
  const prefix = options.prefix ? `${options.prefix}-` : "";

  const copyReceiptPath = path.join(targetDir, `${prefix}copy-receipt.json`);
  const conversionManifestPath = path.join(targetDir, `${prefix}conversion-manifest.json`);
  const preApplyHashPath = path.join(targetDir, `${prefix}pre-apply-hash.json`);
  const dryRunReportPath =
    options.dryRunReportPath ?? path.join(targetDir, `${prefix}dryrun-report.json`);
  const reviewPath = path.join(targetDir, `${prefix}apply-review.json`);

  const inputBytes = fs.readFileSync(resolvedInputPath);
  const inputSha256 = sha256Hex(inputBytes);

  // 1. Dry-run report produced by the real dry run (unless supplied)
  if (!fs.existsSync(dryRunReportPath)) {
    const origLog = console.log;
    const origErr = console.error;
    let dryRunExit: number;
    try {
      console.log = () => {};
      console.error = () => {};
      dryRunExit = main(
        ["--db", resolvedDbPath, "--in", resolvedInputPath, "--report", dryRunReportPath],
        options.now,
        options.deps,
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    if (dryRunExit !== 0 || !fs.existsSync(dryRunReportPath)) {
      throw new Error(
        `Dry run failed with exit code ${dryRunExit} generating report at ${dryRunReportPath}`,
      );
    }
  }

  const dryRunReportRaw = fs.readFileSync(dryRunReportPath, "utf8");
  const dryRunReport = JSON.parse(dryRunReportRaw);
  const dryRunReportSha256 = sha256Hex(dryRunReportRaw);

  // 2. Disposable copy receipt (G7: mgpl-mobile-devcopy-receipt/1)
  const fictionalFrom = path.resolve(path.dirname(resolvedDbPath), "synthetic-devcopy-source.db");
  const copyReceipt = {
    schema: "mgpl-mobile-devcopy-receipt/1",
    from: fictionalFrom,
    to: fs.realpathSync(resolvedDbPath),
    from_unchanged: true,
    integrity: "ok",
  };
  fs.writeFileSync(copyReceiptPath, canonicalJson(copyReceipt));
  const copyReceiptSha256 = sha256Hex(fs.readFileSync(copyReceiptPath));

  // 3. Minimal conversion manifest (G8: mgpl-mobile-cohort-conversion-manifest/1)
  const conversionManifest = {
    schema: "mgpl-mobile-cohort-conversion-manifest/1",
    output: {
      sha256: inputSha256,
    },
  };
  fs.writeFileSync(conversionManifestPath, canonicalJson(conversionManifest));
  const conversionManifestSha256 = sha256Hex(fs.readFileSync(conversionManifestPath));

  // 4. Pre-apply state hash file (G8 & G9: mgpl-mobile-state-hash/1)
  const dbHandle = new Database(resolvedDbPath);
  let preState: unknown;
  try {
    if (options.deps?.stateHash) {
      preState = options.deps.stateHash(dbHandle);
    } else {
      preState = computeMobileStateHash(dbHandle);
    }
  } finally {
    dbHandle.close();
  }
  fs.writeFileSync(preApplyHashPath, canonicalJson(preState));
  const preApplyHashSha256 = sha256Hex(fs.readFileSync(preApplyHashPath));

  // 5. Review artifact (G1-G6: mgpl-mobile-dryrun-review/1)
  const reviewedAt = (options.now ?? new Date("2026-10-21T12:00:00Z"))
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  let review: Record<string, any> = {
    schema: "mgpl-mobile-dryrun-review/1",
    decision: options.decision ?? "approve",
    reviewed_by: options.reviewedBy ?? "synthetic-fixture-reviewer",
    reviewed_at: options.reviewedAt ?? reviewedAt,
    input_sha256: inputSha256,
    plan_sha256: dryRunReport.planSha256,
    dry_run_report: {
      path: dryRunReportPath,
      sha256: dryRunReportSha256,
    },
    copy_receipt: {
      path: copyReceiptPath,
      sha256: copyReceiptSha256,
    },
    conversion_manifest: {
      path: conversionManifestPath,
      sha256: conversionManifestSha256,
    },
    pre_apply_hash: {
      path: preApplyHashPath,
      sha256: preApplyHashSha256,
    },
    expected_counts: {
      records: dryRunReport.records,
      inserted: dryRunReport.counts.inserted,
      inserted_quarantined: dryRunReport.counts.inserted_quarantined,
      oracle: "WUD-AI-112-r5 5.12",
    },
    checks: {
      counts_match_oracle: true,
      quarantined_lines_match_manifest: true,
      hosts_reviewed: true,
    },
  };

  if (options.override) {
    review = { ...review, ...options.override };
  }
  if (options.mutate) {
    options.mutate(review);
  }

  fs.writeFileSync(reviewPath, canonicalJson(review));
  const reviewSha256 = sha256Hex(fs.readFileSync(reviewPath));

  return {
    reviewPath,
    reviewSha256,
    review: review as MobileDryRunReviewArtifact,
    dryRunReportPath,
    dryRunReportSha256,
    copyReceiptPath,
    copyReceiptSha256,
    conversionManifestPath,
    conversionManifestSha256,
    preApplyHashPath,
    preApplyHashSha256,
    flags: ["--review", reviewPath, "--expect-review-sha256", reviewSha256],
  };
}
