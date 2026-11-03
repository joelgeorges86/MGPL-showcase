"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "../..");
const seedScriptPath = path.join(repositoryRoot, "src/scripts/seed-db.ts");

function resolveTsNodeEntryPoint() {
  return require.resolve("ts-node/dist/bin.js");
}

function sidecarPaths(databasePath) {
  return [`${databasePath}-wal`, `${databasePath}-shm`];
}

function removeTemporaryFiles(databasePath, fileSystem) {
  fileSystem.rmSync(databasePath, { force: true });
  for (const sidecar of sidecarPaths(databasePath)) {
    fileSystem.rmSync(sidecar, { force: true });
  }
}

function hasTargetSidecars(targetPath, fileSystem) {
  return sidecarPaths(targetPath).some((sidecar) => fileSystem.existsSync(sidecar));
}

function allocateTemporaryPath(targetPath, fileSystem) {
  const directory = path.dirname(targetPath);
  fileSystem.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const temporaryPath = path.join(
      directory,
      `.mgpl-setup-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.db`,
    );
    try {
      const descriptor = fileSystem.openSync(temporaryPath, "wx");
      fileSystem.closeSync(descriptor);
      fileSystem.rmSync(temporaryPath, { force: true });
      return temporaryPath;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to allocate a unique temporary database path");
}

function placeDatabase({ targetPath, seedDatabase, beforeLink, fileSystem = fs }) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new TypeError("targetPath is required");
  }
  if (typeof seedDatabase !== "function") {
    throw new TypeError("seedDatabase must be a function");
  }

  const temporaryPath = allocateTemporaryPath(targetPath, fileSystem);
  try {
    seedDatabase(temporaryPath);
    if (!fileSystem.existsSync(temporaryPath)) {
      throw new Error("seed completed but the temporary database file is missing");
    }
    if (hasTargetSidecars(temporaryPath, fileSystem)) {
      throw new Error("temporary database still has SQLite sidecars after seeding");
    }

    if (fileSystem.existsSync(targetPath)) {
      return { placed: false, existingTarget: true };
    }
    if (hasTargetSidecars(targetPath, fileSystem)) {
      throw new Error("target WAL/SHM sidecar appeared before placement");
    }

    if (beforeLink) beforeLink({ temporaryPath, targetPath });
    if (hasTargetSidecars(targetPath, fileSystem)) {
      throw new Error("target WAL/SHM sidecar appeared before placement");
    }

    try {
      fileSystem.linkSync(temporaryPath, targetPath);
    } catch (error) {
      if (
        error &&
        (error.code === "EEXIST" || error.code === "EPERM") &&
        fileSystem.existsSync(targetPath)
      ) {
        return { placed: false, existingTarget: true };
      }
      throw error;
    }

    if (hasTargetSidecars(targetPath, fileSystem)) {
      throw new Error("target WAL/SHM sidecar appeared after placement");
    }
    return { placed: true, existingTarget: false };
  } finally {
    removeTemporaryFiles(temporaryPath, fileSystem);
  }
}

function runSeedCommand(temporaryPath, options = {}) {
  const runnerEntryPoint = options.runnerEntryPoint || resolveTsNodeEntryPoint();
  const seedEntryPoint = options.seedEntryPoint || seedScriptPath;
  const result = spawnSync(process.execPath, [runnerEntryPoint, seedEntryPoint, temporaryPath], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`db:seed failed with status ${result.status}`);
    error.status = result.status;
    throw error;
  }
}

if (require.main === module) {
  const targetPath = process.argv[2];
  try {
    const result = placeDatabase({ targetPath, seedDatabase: runSeedCommand });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`[FAIL] database placement: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  placeDatabase,
  resolveTsNodeEntryPoint,
  runSeedCommand,
  seedScriptPath,
  sidecarPaths,
};
