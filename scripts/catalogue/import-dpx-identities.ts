// Offline admission requires a separate, operator-reviewed dry run.
import Database from "better-sqlite3";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { landingPath } from "./sample-check.mjs";
import { safeErrorMessage } from "../../src/utils/errorSanitizer";
import { sha256Hex } from "../../src/services/enrichmentPromotion";
import {
  DPX_IDENTITY_CONTRACT,
  DPX_IDENTITY_TABLES,
  DPX_IMPORT_LIMITS,
  DpxImportError,
  planDpxIdentityImport,
  applyDpxIdentityImport,
  type DpxImportReport,
  type DpxCounts,
  type DpxApplyResult,
  type DpxImportErrorCode,
} from "../../src/services/dpxIdentityImport";

export interface DpxCliDeps {
  plan: typeof planDpxIdentityImport;
  apply: typeof applyDpxIdentityImport;
}
class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message);
};
const zero = (): DpxCounts => ({ inserted: 0, unchanged: 0, rejected: 0, blocked: 0 });
export function main(argv: string[], now = new Date(), deps: Partial<DpxCliDeps> = {}): number {
  let db: Database.Database | undefined;
  let reportFd: number | undefined;
  try {
    if (process.env.NODE_ENV === "production") refuse("production refused");
    if (argv.length === 1 && argv[0] === "--help") {
      console.log(
        "Dry run: --db <file> --in <jsonl> --report <new file outside repository>. Review the report's citations and confirm each host belongs to its source class. Apply separately with --apply --expect-input-sha256 <reviewed inputSha256> --expect-plan-sha256 <reviewed planSha256> and another new --report. The reviewed bytes and planned rows must still match. No default database; production is refused.",
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
      if (
        !["--db", "--in", "--report", "--expect-input-sha256", "--expect-plan-sha256"].includes(key)
      )
        refuse("unknown option");
      if (options.has(key)) refuse("repeated option");
      const value = argv[++i];
      if (!value || value.startsWith("--")) refuse("missing option value");
      options.set(key, value);
    }
    if (!["--db", "--in", "--report"].every((k) => options.has(k)))
      refuse("--db, --in and --report are required");
    const expectInput = options.get("--expect-input-sha256"),
      expectPlan = options.get("--expect-plan-sha256");
    if (apply ? !expectInput || !expectPlan : expectInput !== undefined || expectPlan !== undefined)
      refuse("both --expect-input-sha256 and --expect-plan-sha256 are required only with --apply");
    if ([expectInput, expectPlan].some((v) => v !== undefined && !/^[0-9a-f]{64}$/.test(v)))
      refuse("expectation must be 64 lowercase hexadecimal characters");
    const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
    const reportPath = landingPath(options.get("--report")!);
    const rel = path.relative(root, reportPath);
    if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)))
      refuse("report must be outside the repository");
    if (existsSync(reportPath)) refuse("report already exists");
    const bytes = readFileSync(options.get("--in")!);
    if (bytes.length > DPX_IMPORT_LIMITS.maxBytes) refuse("input_too_large");
    const inputSha256 = sha256Hex(bytes);
    if (apply && inputSha256 !== expectInput) refuse("input_mismatch");
    db = new Database(options.get("--db")!, { readonly: !apply, fileMustExist: true });
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 10000");
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (
      [
        ...DPX_IDENTITY_TABLES,
        "mobile_device_families",
        "mobile_hardware_references",
        "mobile_device_variants",
      ].some((t) => !has.get(t))
    )
      refuse("tables_missing");
    try {
      reportFd = openSync(reportPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("report already exists");
      throw error;
    }
    const plan = deps.plan ?? planDpxIdentityImport,
      execute = deps.apply ?? applyDpxIdentityImport;
    if (!apply) {
      let report: DpxImportReport;
      try {
        report = plan(db, bytes, { now });
      } catch (error) {
        if (error instanceof DpxImportError) {
          // A typed planning refusal has no report schema; release our empty reservation.
          closeSync(reportFd);
          reportFd = undefined;
          unlinkSync(reportPath);
        }
        throw error;
      }
      writeFileSync(reportFd, JSON.stringify({ ...report, mode: "dry_run", apply: null }) + "\n");
      console.log(
        JSON.stringify({
          mode: "dry_run",
          status: report.status,
          inputSha256,
          planSha256: report.planSha256,
          counts: report.counts,
          batchId: report.alreadyAppliedBatchId,
        }),
      );
      return report.status === "not_applicable" ? 2 : 0;
    }
    const expected = { inputSha256: expectInput!, planSha256: expectPlan! };
    let result: DpxApplyResult | { error: DpxImportErrorCode };
    let currentPlan: DpxImportReport | null = null;
    let exitCode = 0;
    try {
      result = execute(db, bytes, expected, { now });
    } catch (error) {
      if (!(error instanceof DpxImportError)) throw error;
      result = { error: error.code };
      exitCode = 2;
      // The failed immediate transaction is already rolled back. This plan is diagnostic only.
      if (error.code === "plan_stale" || error.code === "plan_not_applicable")
        currentPlan = plan(db, bytes, { now });
    }
    writeFileSync(
      reportFd,
      JSON.stringify({
        contract: DPX_IDENTITY_CONTRACT,
        mode: "apply",
        inputSha256,
        expected,
        apply: result,
        currentPlan,
        currentPlanReviewed: false,
      }) + "\n",
    );
    console.log(
      JSON.stringify({
        mode: "apply",
        status: "error" in result ? result.error : result.status,
        inputSha256,
        planSha256: expectPlan,
        counts: "error" in result ? zero() : result.counts,
        batchId: "error" in result ? null : result.batchId,
      }),
    );
    return exitCode;
  } catch (error) {
    if (error instanceof Refusal || error instanceof DpxImportError) {
      console.error(error.message);
      return 2;
    }
    if (reportFd !== undefined)
      writeFileSync(reportFd, JSON.stringify({ error: "unexpected" }) + "\n");
    console.error(safeErrorMessage(error));
    return 1;
  } finally {
    if (reportFd !== undefined) closeSync(reportFd);
    db?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
