"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const repositoryRoot = path.resolve(__dirname, "..");
const evidencePath = path.join(repositoryRoot, ".mgpl", "gate-evidence.json");
const CURRENT_SCHEMA_VERSION = 2;

// Threat model: this guard protects against accidental, stale, and malformed
// evidence. It cannot authenticate execution against a party controlling the
// machine; server-side required checks remain the trust boundary. Caller-asserted
// execution is tracked in issue #54.
const RUNNERS = {
  powershell: path.join(
    repositoryRoot,
    ".agents",
    "skills",
    "mgpl-gate-runner",
    "scripts",
    "run-gates.ps1",
  ),
  bash: path.join(
    repositoryRoot,
    ".agents",
    "skills",
    "mgpl-gate-runner",
    "scripts",
    "run-gates.sh",
  ),
};
const requiredGatesByScope = Object.freeze({
  local: [
    "Environment doctor",
    "TypeScript",
    "Client syntax",
    "Spelling",
    "Unit tests",
    "Security and quality gates",
  ],
});
const requiredGates = requiredGatesByScope.local;

function requireString(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  return value;
}

function runnerPath(runnerId) {
  requireString(runnerId, "runnerId");
  if (!Object.prototype.hasOwnProperty.call(RUNNERS, runnerId)) {
    throw new Error(`unrecognised gate runner identity '${runnerId}'`);
  }
  return RUNNERS[runnerId];
}

function runnerHash(runnerId) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(runnerPath(runnerId)))
    .digest("hex");
}

function resolveDatabasePath(env = process.env, cwd = process.cwd()) {
  const configuredPath = env.DB_PATH;
  if (!configuredPath) return path.resolve(cwd, "mpgl_app.db");
  if (configuredPath === ":memory:") return configuredPath;
  return path.resolve(cwd, configuredPath);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function datasetShapeFailures(dataset) {
  const failures = [];
  if (!isPlainObject(dataset)) return ["dataset provenance is missing"];
  if (typeof dataset.path !== "string" || dataset.path.length === 0) {
    failures.push("dataset provenance path is invalid");
  }
  if (typeof dataset.exists !== "boolean") failures.push("dataset provenance existence is invalid");
  if (typeof dataset.integrityCheck !== "string" || dataset.integrityCheck.length === 0) {
    failures.push("dataset provenance integrity result is invalid");
  }
  if (!isPlainObject(dataset.seedMarker)) {
    failures.push("dataset provenance seed marker state is invalid");
  } else {
    if (typeof dataset.seedMarker.present !== "boolean") {
      failures.push("dataset provenance seed marker presence is invalid");
    }
    if (
      dataset.seedMarker.identifier !== null &&
      typeof dataset.seedMarker.identifier !== "string"
    ) {
      failures.push("dataset provenance seed marker identifier is invalid");
    }
    if (dataset.seedMarker.seededAt !== null && typeof dataset.seedMarker.seededAt !== "string") {
      failures.push("dataset provenance seed marker timestamp is invalid");
    }
  }
  if (!Number.isInteger(dataset.totalRows) || dataset.totalRows < 0) {
    failures.push("dataset provenance total row count is invalid");
  }
  if (!isPlainObject(dataset.rowCounts)) {
    failures.push("dataset provenance row counts are invalid");
  } else {
    let rowCountTotal = 0;
    for (const [tableName, count] of Object.entries(dataset.rowCounts)) {
      if (typeof tableName !== "string" || !Number.isInteger(count) || count < 0) {
        failures.push("dataset provenance row counts are invalid");
        break;
      }
      rowCountTotal += count;
    }
    if (
      Number.isInteger(dataset.totalRows) &&
      dataset.totalRows >= 0 &&
      rowCountTotal !== dataset.totalRows
    ) {
      failures.push("dataset provenance total row count does not match row counts");
    }
  }
  if (isPlainObject(dataset.seedMarker)) {
    const { present, identifier, seededAt } = dataset.seedMarker;
    if (
      present === true &&
      (typeof identifier !== "string" ||
        identifier.length === 0 ||
        typeof seededAt !== "string" ||
        seededAt.length === 0)
    ) {
      failures.push("dataset provenance present seed marker is incomplete");
    }
    if (present === false && (identifier !== null || seededAt !== null)) {
      failures.push("dataset provenance absent seed marker carries metadata");
    }
  }
  return failures;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function datasetProvenance() {
  const databasePath = resolveDatabasePath();
  const provenance = {
    path: databasePath,
    exists: fs.existsSync(databasePath),
    integrityCheck: null,
    seedMarker: { present: false, identifier: null, seededAt: null },
    totalRows: 0,
    rowCounts: {},
  };

  if (!provenance.exists) return provenance;

  let db;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    provenance.integrityCheck = db.pragma("integrity_check", { simple: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    for (const { name } of tables) {
      const count = db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
        .get().count;
      provenance.rowCounts[name] = count;
      provenance.totalRows += count;
    }
    if (provenance.rowCounts.mgpl_seed_marker > 0) {
      const marker = db
        .prepare(
          "SELECT seedIdentifier, seededAt FROM mgpl_seed_marker ORDER BY seededAt DESC LIMIT 1",
        )
        .get();
      if (marker) {
        provenance.seedMarker = {
          present: true,
          identifier: marker.seedIdentifier,
          seededAt: marker.seededAt,
        };
      }
    }
  } catch (error) {
    provenance.integrityCheck = `error: ${error.message}`;
  } finally {
    if (db) db.close();
  }
  return provenance;
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function currentCommit() {
  const result = git(["rev-parse", "HEAD"]);
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`Unable to resolve HEAD: ${result.stderr || "unknown git error"}`);
  }
  return result.stdout;
}

function isClean() {
  const result = git(["status", "--porcelain", "--untracked-files=all"]);
  if (result.status !== 0) {
    throw new Error(`Unable to inspect worktree: ${result.stderr || "unknown git error"}`);
  }
  return result.stdout === "";
}

function readEvidence() {
  try {
    return JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch (error) {
    const reason =
      error && error.code === "ENOENT" ? "evidence file is missing" : "evidence file is invalid";
    return { error: reason };
  }
}

function validateEvidence(options = {}) {
  const requireClean = options.requireClean !== false;
  const requiredScope = options.requiredScope || process.env.MGPL_REQUIRED_SCOPE;
  const evidence = readEvidence();
  const failures = [];

  if (evidence.error) failures.push(evidence.error);
  if (evidence.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    failures.push(
      `evidence schema version ${evidence.schemaVersion ?? "missing"} is not supported; a fresh gate run is required`,
    );
  }
  if (evidence.status !== "passed") failures.push("gate status is not passed");
  if (evidence.commit !== currentCommit()) failures.push("evidence commit does not match HEAD");
  if (typeof evidence.runnerId !== "string") {
    failures.push("runnerId must be a string");
  } else {
    try {
      const expectedRunnerHash = runnerHash(evidence.runnerId);
      if (evidence.runnerSha256 !== expectedRunnerHash) {
        failures.push("gate runner hash does not match evidence");
      }
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (typeof evidence.scope !== "string") failures.push("scope must be a string");
  if (requiredScope && evidence.scope !== requiredScope) {
    failures.push(
      `evidence scope '${evidence.scope ?? "missing"}' does not satisfy required scope '${requiredScope}'`,
    );
  }
  const hasScope =
    typeof evidence.scope === "string" &&
    Object.prototype.hasOwnProperty.call(requiredGatesByScope, evidence.scope);
  const requiredGatesForScope = hasScope ? requiredGatesByScope[evidence.scope] : undefined;
  if (typeof evidence.scope !== "string" || !hasScope) {
    failures.push(`unrecognised gate scope '${evidence.scope ?? "missing"}'`);
  } else if (JSON.stringify(evidence.gates) !== JSON.stringify(requiredGatesForScope)) {
    failures.push(`gate list does not match the '${evidence.scope}' scope contract`);
  }
  failures.push(...datasetShapeFailures(evidence.dataset));
  if (evidence.scope === "local" && isPlainObject(evidence.dataset)) {
    if (evidence.dataset.exists !== true)
      failures.push("dataset provenance reports a missing database");
    if (evidence.dataset.integrityCheck !== "ok") {
      failures.push("dataset provenance reports a failed integrity check");
    }
  }
  if (requireClean && !isClean()) failures.push("worktree is not clean");

  return failures;
}

function recordEvidence() {
  if (!isClean()) throw new Error("Cannot record gate evidence while the worktree is not clean.");
  const runnerId = process.env.MGPL_GATE_RUNNER_ID;
  const scope = process.env.MGPL_GATE_SCOPE;
  validateRecordInputs(runnerId, scope);
  if (!Object.prototype.hasOwnProperty.call(requiredGatesByScope, scope)) {
    throw new Error(
      `MGPL_GATE_SCOPE must be one of: ${Object.keys(requiredGatesByScope).join(", ")}.`,
    );
  }
  const dataset = datasetProvenance();
  if (!dataset.exists) throw new Error("Cannot record gate evidence: database is missing.");
  if (dataset.integrityCheck !== "ok") {
    throw new Error("Cannot record gate evidence: database integrity check failed.");
  }
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    status: "passed",
    commit: currentCommit(),
    runnerId,
    runnerSha256: runnerHash(runnerId),
    scope,
    gates: requiredGatesByScope[scope],
    dataset,
    recordedAt: new Date().toISOString(),
    harness: process.env.MGPL_GATE_HARNESS || "mgpl-gate-runner",
    model: process.env.MGPL_GATE_MODEL || "repository-canonical-runner",
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Recorded green MGPL gate evidence for ${evidence.commit}.`);
}

function validateRecordInputs(runnerId, scope) {
  if (typeof runnerId !== "string") throw new Error("MGPL_GATE_RUNNER_ID must be a string.");
  if (typeof scope !== "string") throw new Error("MGPL_GATE_SCOPE must be a string.");
  if (!Object.prototype.hasOwnProperty.call(requiredGatesByScope, scope)) {
    throw new Error(
      `MGPL_GATE_SCOPE must be one of: ${Object.keys(requiredGatesByScope).join(", ")}.`,
    );
  }
}

function verifyEvidence() {
  const failures = validateEvidence();
  if (failures.length > 0) {
    console.error(`MGPL push blocked: ${failures.join("; ")}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`MGPL gate evidence verified for ${currentCommit()}.`);
}

if (require.main === module) {
  const command = process.argv[2] || "verify";
  try {
    if (command === "record") recordEvidence();
    else if (command === "verify") verifyEvidence();
    else throw new Error(`Unknown command '${command}'. Use 'record' or 'verify'.`);
  } catch (error) {
    console.error(`MGPL gate guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  RUNNERS,
  requiredGates,
  requiredGatesByScope,
  datasetProvenance,
  resolveDatabasePath,
  validateRecordInputs,
  validateEvidence,
  runnerHash,
  recordEvidence,
};
