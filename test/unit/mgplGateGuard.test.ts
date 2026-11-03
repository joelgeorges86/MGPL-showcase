import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type GuardModule = {
  CURRENT_SCHEMA_VERSION: number;
  RUNNERS: Record<string, string>;
  requiredGatesByScope: Record<string, string[]>;
  resolveDatabasePath: (env?: NodeJS.ProcessEnv, cwd?: string) => string;
  validateRecordInputs: (runnerId: unknown, scope: unknown) => void;
  datasetProvenance: () => {
    path: string;
    exists: boolean;
    integrityCheck: string | null;
    seedMarker: { present: boolean; identifier: string | null; seededAt: string | null };
    totalRows: number;
    rowCounts: Record<string, number>;
  };
  runnerHash: (runnerId: string) => string;
  validateEvidence: (options?: { requireClean?: boolean; requiredScope?: string }) => string[];
};

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");
const root = path.resolve(__dirname, "../..");
const evidencePath = path.join(root, ".mgpl", "gate-evidence.json");
const tempDbPath = path.join(root, "mgpl-gate-guard-test.db");
const dirtyMarkerPath = path.join(root, "mgpl-gate-guard-dirty-test.tmp");
const guard = require("../../scripts/mgpl-gate-guard.js") as GuardModule;

function currentCommit(): string {
  const { execFileSync } = require("child_process") as typeof import("child_process");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function writeDatabase(withMarker: boolean): void {
  const db = new Database(tempDbPath);
  db.exec("CREATE TABLE sample_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
  if (withMarker) {
    db.exec(
      "CREATE TABLE mgpl_seed_marker (seedIdentifier TEXT PRIMARY KEY, seededAt TEXT NOT NULL);",
    );
    db.prepare("INSERT INTO sample_rows (id, value) VALUES (1, 'seeded')").run();
    db.prepare("INSERT INTO mgpl_seed_marker (seedIdentifier, seededAt) VALUES (?, ?)").run(
      "mgpl-e2e-v1",
      "2026-09-21T00:00:00.000Z",
    );
  }
  db.close();
}

function writeEvidence(overrides: Record<string, unknown> = {}): void {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        schemaVersion: guard.CURRENT_SCHEMA_VERSION,
        status: "passed",
        commit: currentCommit(),
        runnerId: "bash",
        runnerSha256: guard.runnerHash("bash"),
        scope: "local",
        gates: guard.requiredGatesByScope.local,
        dataset: guard.datasetProvenance(),
        recordedAt: new Date().toISOString(),
        harness: "test",
        model: "test",
        ...overrides,
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  process.env.DB_PATH = tempDbPath;
  rmSync(tempDbPath, { force: true });
  rmSync(`${tempDbPath}-wal`, { force: true });
  rmSync(`${tempDbPath}-shm`, { force: true });
  writeDatabase(true);
});

afterEach(() => {
  delete process.env.DB_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.MGPL_GATE_RUNNER_ID;
  rmSync(path.dirname(evidencePath), { recursive: true, force: true });
  rmSync(tempDbPath, { force: true });
  rmSync(`${tempDbPath}-wal`, { force: true });
  rmSync(`${tempDbPath}-shm`, { force: true });
  rmSync(dirtyMarkerPath, { force: true });
  if (!existsSync(guard.RUNNERS.bash) || !existsSync(guard.RUNNERS.powershell)) {
    throw new Error("Canonical runner disappeared during test.");
  }
});

describe("MGPL gate evidence guard", () => {
  it("accepts current-schema Bash evidence for the local scope", () => {
    writeEvidence();
    expect(guard.validateEvidence({ requireClean: false, requiredScope: "local" })).toEqual([]);
  });

  it("accepts current-schema PowerShell evidence", () => {
    writeEvidence({
      runnerId: "powershell",
      runnerSha256: guard.runnerHash("powershell"),
    });
    expect(guard.validateEvidence({ requireClean: false })).toEqual([]);
  });

  it("accepts only the local scope contract", () => {
    writeEvidence();
    expect(guard.validateEvidence({ requireClean: false, requiredScope: "local" })).toEqual([]);
  });

  it("requires the exact ordered gate list for the recorded scope", () => {
    writeEvidence({ gates: ["Unit tests"] });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "gate list does not match the 'local' scope contract",
    );
  });

  it("distinguishes seeded marker provenance from an empty unmarked database", () => {
    const seeded = guard.datasetProvenance();
    expect(seeded.seedMarker).toEqual({
      present: true,
      identifier: "mgpl-e2e-v1",
      seededAt: "2026-09-21T00:00:00.000Z",
    });
    expect(seeded.totalRows).toBeGreaterThan(0);

    const db = new Database(tempDbPath);
    db.close();
    rmSync(tempDbPath, { force: true });
    rmSync(`${tempDbPath}-wal`, { force: true });
    rmSync(`${tempDbPath}-shm`, { force: true });
    writeDatabase(false);

    const empty = guard.datasetProvenance();
    expect(empty.seedMarker.present).toBe(false);
    expect(empty.totalRows).toBe(0);
  });

  it("rejects prior-schema evidence and names the schema version", () => {
    writeEvidence({ schemaVersion: 1 });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "evidence schema version 1 is not supported; a fresh gate run is required",
    );
  });

  it("rejects an unrecognised runner identity", () => {
    writeEvidence({ runnerId: "unknown" });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "unrecognised gate runner identity 'unknown'",
    );
  });

  it("rejects an inherited-property scope name", () => {
    writeEvidence({ scope: "toString", gates: [] });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "unrecognised gate scope 'toString'",
    );
  });

  it("rejects ci-scoped evidence because only local evidence is recordable", () => {
    writeEvidence({ scope: "ci", gates: [] });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "unrecognised gate scope 'ci'",
    );
  });

  it("rejects evidence with a missing database provenance", () => {
    writeEvidence({ dataset: { exists: false, integrityCheck: null } });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "dataset provenance reports a missing database",
    );
  });

  it("rejects evidence with a failed database integrity check", () => {
    writeEvidence({ dataset: { exists: true, integrityCheck: "error: corrupt" } });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "dataset provenance reports a failed integrity check",
    );
  });

  it("rejects evidence without an explicit runner identity", () => {
    delete process.env.MGPL_GATE_RUNNER_ID;
    writeEvidence({ runnerId: null });
    expect(guard.validateEvidence({ requireClean: false })).toContain("runnerId must be a string");
  });

  it.each([["local"], 7, { scope: "local" }])(
    "rejects non-string scope values during verification: %j",
    (scope) => {
      writeEvidence({ scope });
      expect(guard.validateEvidence({ requireClean: false })).toContain("scope must be a string");
    },
  );

  it.each([["bash"], 7, { runnerId: "bash" }])(
    "rejects non-string runnerId values during verification: %j",
    (runnerId) => {
      writeEvidence({ runnerId });
      expect(guard.validateEvidence({ requireClean: false })).toContain(
        "runnerId must be a string",
      );
    },
  );

  it("rejects non-string record inputs before scope or runner lookup", () => {
    for (const value of [["bash"], 7, { runnerId: "bash" }]) {
      expect(() => guard.validateRecordInputs(value, "local")).toThrow(
        "MGPL_GATE_RUNNER_ID must be a string",
      );
    }
    for (const value of [["local"], 7, { scope: "local" }]) {
      expect(() => guard.validateRecordInputs("bash", value)).toThrow(
        "MGPL_GATE_SCOPE must be a string",
      );
    }
  });

  it("resolves database paths exactly like src/db.ts", () => {
    const dbSource = readFileSync(path.join(root, "src", "db.ts"), "utf8");
    expect(dbSource).toContain('process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db")');
    const cwd = path.join(root, "resolver-test-cwd");
    expect(guard.resolveDatabasePath({}, cwd)).toBe(path.resolve(cwd, "mpgl_app.db"));
    expect(guard.resolveDatabasePath({ DB_PATH: "relative.db" }, cwd)).toBe(
      path.resolve(cwd, "relative.db"),
    );
    expect(guard.resolveDatabasePath({ DB_PATH: path.join(cwd, "absolute.db") }, cwd)).toBe(
      path.join(cwd, "absolute.db"),
    );
    expect(guard.resolveDatabasePath({ DB_PATH: ":memory:" }, cwd)).toBe(":memory:");
  });

  it("rejects incomplete dataset provenance shape", () => {
    writeEvidence({ dataset: { exists: true, integrityCheck: "ok" } });
    expect(guard.validateEvidence({ requireClean: false })).toEqual(
      expect.arrayContaining([
        "dataset provenance path is invalid",
        "dataset provenance seed marker state is invalid",
        "dataset provenance total row count is invalid",
        "dataset provenance row counts are invalid",
      ]),
    );
  });

  it("rejects dataset provenance with inconsistent total row count", () => {
    writeEvidence({
      dataset: {
        ...guard.datasetProvenance(),
        totalRows: 0,
        rowCounts: { games: 20 },
      },
    });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "dataset provenance total row count does not match row counts",
    );
  });

  it("rejects a present seed marker without identifier or timestamp", () => {
    writeEvidence({
      dataset: {
        ...guard.datasetProvenance(),
        seedMarker: { present: true, identifier: null, seededAt: null },
      },
    });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "dataset provenance present seed marker is incomplete",
    );
  });

  it("rejects an absent seed marker carrying metadata", () => {
    writeEvidence({
      dataset: {
        ...guard.datasetProvenance(),
        seedMarker: {
          present: false,
          identifier: "stale-marker",
          seededAt: "2026-09-21T00:00:00.000Z",
        },
      },
    });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "dataset provenance absent seed marker carries metadata",
    );
  });

  it("rejects mismatched runner identity and hash", () => {
    writeEvidence({
      runnerId: "powershell",
      runnerSha256: guard.runnerHash("bash"),
    });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "gate runner hash does not match evidence",
    );
  });

  it("rejects a modified Bash runner", () => {
    writeEvidence();
    const runnerPath = guard.RUNNERS.bash;
    const original = readFileSync(runnerPath);
    writeFileSync(runnerPath, Buffer.concat([original, Buffer.from("\n")]));
    try {
      expect(guard.validateEvidence({ requireClean: false })).toContain(
        "gate runner hash does not match evidence",
      );
    } finally {
      writeFileSync(runnerPath, original);
    }
  });

  it("rejects a modified PowerShell runner", () => {
    writeEvidence({
      runnerId: "powershell",
      runnerSha256: guard.runnerHash("powershell"),
    });
    const runnerPath = guard.RUNNERS.powershell;
    const original = readFileSync(runnerPath);
    writeFileSync(runnerPath, Buffer.concat([original, Buffer.from("\n")]));
    try {
      expect(guard.validateEvidence({ requireClean: false })).toContain(
        "gate runner hash does not match evidence",
      );
    } finally {
      writeFileSync(runnerPath, original);
    }
  });

  it("preserves stale commit rejection", () => {
    writeEvidence({ commit: "0".repeat(40) });
    expect(guard.validateEvidence({ requireClean: false })).toContain(
      "evidence commit does not match HEAD",
    );
  });

  it("preserves dirty worktree rejection", () => {
    writeEvidence();
    writeFileSync(dirtyMarkerPath, "deliberately untracked test marker\n");
    try {
      expect(guard.validateEvidence()).toContain("worktree is not clean");
    } finally {
      rmSync(dirtyMarkerPath, { force: true });
    }
  });

  it("uses real SHA-256 hashes for both canonical runners", () => {
    for (const runnerId of ["bash", "powershell"]) {
      const expected = createHash("sha256")
        .update(readFileSync(guard.RUNNERS[runnerId]))
        .digest("hex");
      expect(guard.runnerHash(runnerId)).toBe(expected);
    }
  });
});
