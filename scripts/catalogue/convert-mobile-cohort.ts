import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  convertMobileCohort,
  COHORT_20261021_POLICY,
  MobileCohortConversionError,
  type CohortFileName,
  type CohortInput,
} from "../../src/services/mobileCohortConversion";

class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

let cachedRepoRoot: string | null = null;
function getRepoRoot(): string {
  if (!cachedRepoRoot) {
    cachedRepoRoot = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  }
  return cachedRepoRoot;
}

function landingPath(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

function assertOutsideRepo(targetPath: string, label: string): void {
  const lp = landingPath(targetPath);
  const rel = path.relative(getRepoRoot(), lp);
  if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
    refuse(`${label} must be outside the repository`);
  }
}

function parseCliOptions(args: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key)) {
      refuse(`unknown option: ${key}`);
    }
    const val = args[++i];
    if (!val || val.startsWith("--")) {
      refuse(`missing value for option: ${key}`);
    }
    if (options.has(key)) {
      refuse(`repeated option: ${key}`);
    }
    options.set(key, val);
  }
  return options;
}

export interface ConvertMobileCohortDeps {
  convertMobileCohort?: typeof convertMobileCohort;
  convert?: typeof convertMobileCohort;
  now?: Date;
}

export async function main(
  argv: string[],
  nowOrDeps: Date | ConvertMobileCohortDeps = new Date(),
  maybeDeps: ConvertMobileCohortDeps = {},
): Promise<number> {
  let now: Date;
  let deps: ConvertMobileCohortDeps;

  if (nowOrDeps instanceof Date) {
    now = nowOrDeps;
    deps = maybeDeps;
  } else if (nowOrDeps && typeof nowOrDeps === "object") {
    deps = nowOrDeps;
    now = deps.now ?? new Date();
  } else {
    now = new Date();
    deps = maybeDeps;
  }

  let partialDir: string | null = null;
  let partialCreated = false;

  try {
    if (process.env.NODE_ENV === "production") {
      refuse("production refused");
    }

    const allowed = [
      "--cohort-dir",
      "--research-dir",
      "--out-dir",
      "--join-verification",
      "--join-verification-sha256",
      "--run-date",
    ];

    const options = parseCliOptions(argv, allowed);

    for (const req of ["--cohort-dir", "--research-dir", "--out-dir"]) {
      if (!options.has(req)) {
        refuse(`missing required option: ${req}`);
      }
    }

    const cohortDir = options.get("--cohort-dir") as string;
    const researchDir = options.get("--research-dir") as string;
    const outDir = options.get("--out-dir") as string;

    assertOutsideRepo(outDir, "--out-dir");
    if (fs.existsSync(outDir)) {
      refuse(`--out-dir already exists: ${outDir}`);
    }

    const hasJv = options.has("--join-verification");
    const hasJvSha = options.has("--join-verification-sha256");
    const hasRunDate = options.has("--run-date");

    const jvCount = (hasJv ? 1 : 0) + (hasJvSha ? 1 : 0) + (hasRunDate ? 1 : 0);
    if (jvCount > 0 && jvCount < 3) {
      refuse(
        "all three or none of --join-verification, --join-verification-sha256 and --run-date must be provided",
      );
    }

    let joinVerification: CohortInput["joinVerification"] = null;
    if (hasJv) {
      const jvFile = options.get("--join-verification") as string;
      const jvSha = options.get("--join-verification-sha256") as string;
      const runDate = options.get("--run-date") as string;

      if (!/^[0-9a-f]{64}$/.test(jvSha)) {
        refuse("invalid --join-verification-sha256: must be 64 lowercase hex characters");
      }

      const [runY, runM, runD] = runDate.split("-").map(Number);
      const runDateUtc = new Date(Date.UTC(runY, runM - 1, runD));
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(runDate) ||
        isNaN(Date.parse(runDate)) ||
        runDateUtc.getUTCFullYear() !== runY ||
        runDateUtc.getUTCMonth() !== runM - 1 ||
        runDateUtc.getUTCDate() !== runD
      ) {
        refuse("invalid --run-date: must be a valid date in YYYY-MM-DD format");
      }

      if (runDate < "2026-10-21") {
        refuse("--run-date cannot be earlier than 2026-10-21");
      }

      const todayUtc = now.toISOString().slice(0, 10);
      if (runDate > todayUtc) {
        refuse("--run-date cannot be later than current UTC date");
      }

      if (!fs.existsSync(jvFile)) {
        refuse(`join verification file does not exist: ${jvFile}`);
      }

      joinVerification = {
        bytes: fs.readFileSync(jvFile),
        expectedSha256: jvSha,
        runDate,
      };
    }

    const cohortFiles: CohortFileName[] = [
      "candidates.jsonl",
      "mobile-reference-bundle.jsonl",
      "observations.jsonl",
      "sources.json",
      "game-listing-observations.jsonl",
    ];

    const researchFiles: CohortFileName[] = [
      "CORRECTED-OBSERVATIONS.jsonl",
      "QUARANTINE.jsonl",
      "SOURCE-REGISTER.json",
    ];

    const files: Partial<Record<CohortFileName, Buffer>> = {};

    for (const fn of cohortFiles) {
      const p = path.join(cohortDir, fn);
      if (!fs.existsSync(p)) {
        refuse(`cohort file missing: ${fn}`);
      }
      files[fn] = fs.readFileSync(p);
    }

    for (const fn of researchFiles) {
      const p = path.join(researchDir, fn);
      if (!fs.existsSync(p)) {
        refuse(`research file missing: ${fn}`);
      }
      files[fn] = fs.readFileSync(p);
    }

    const input: CohortInput = {
      files: files as Record<CohortFileName, Buffer>,
      joinVerification,
    };

    const convertFn = deps.convertMobileCohort ?? deps.convert ?? convertMobileCohort;
    const result = convertFn(input, COHORT_20261021_POLICY);

    partialDir = `${outDir}.partial-${process.pid}`;
    if (fs.existsSync(partialDir)) {
      refuse(`partial directory already exists: ${partialDir}`);
    }
    try {
      fs.mkdirSync(partialDir);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EEXIST") {
        refuse(`partial directory already exists: ${partialDir}`);
      }
      throw err;
    }
    partialCreated = true;

    const jsonlPath = path.join(partialDir, "mobile-staging.jsonl");
    const jsonlFd = fs.openSync(jsonlPath, "wx");
    try {
      fs.writeFileSync(jsonlFd, result.jsonl);
      fs.fsyncSync(jsonlFd);
    } finally {
      fs.closeSync(jsonlFd);
    }

    const manifestPath = path.join(partialDir, "CONVERSION-MANIFEST.json");
    const manifestFd = fs.openSync(manifestPath, "wx");
    try {
      fs.writeFileSync(manifestFd, result.manifest);
      fs.fsyncSync(manifestFd);
    } finally {
      fs.closeSync(manifestFd);
    }

    fs.renameSync(partialDir, outDir);
    partialCreated = false;

    const lines = result.jsonl
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0).length;

    const consoleLine = {
      status: "converted",
      jsonlSha256: result.jsonlSha256,
      manifestSha256: result.manifestSha256,
      lines,
      recordsByType: result.recordsByType,
      expectedQuarantinedLines: result.expectedQuarantinedLines,
      stagedJoins: result.stagedJoins,
    };

    console.log(JSON.stringify(consoleLine));
    return 0;
  } catch (error) {
    if (error instanceof MobileCohortConversionError) {
      for (const ref of error.refusals) {
        console.error(`${ref.code}: ${ref.detail}`);
      }
      return 2;
    }
    if (error instanceof Refusal) {
      console.error(error.message);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (partialCreated && partialDir && fs.existsSync(partialDir)) {
      try {
        fs.rmSync(partialDir, { recursive: true, force: true });
      } catch {
        // Preserve the conversion error if cleanup of the owned partial directory fails.
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    },
  );
}
