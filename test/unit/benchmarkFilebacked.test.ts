// #158 / WU-032c: Benchmark-contract tests for the file-backed similarity benchmark.
// Verifies authoritative DDL extraction, fixture population, measurement correctness,
// handle closure, and the retention contract (no automatic deletion).
// Verifies fixture_creation_path reporting and unverified location status under
// ordinary-child and parent-junction substitution for both success and failure paths.
// Reproduces reviewer substitution cases safely in disposable test-created directories.
// cspell:words filebacked reparse
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoSymlinkAncestry,
  cleanupScratchDir,
  createScratchDir,
  extractTableDdl,
  FIXTURE_DB_NAME,
  FIXTURE_SEED,
  populateFixture,
  printReport,
  runFullBenchmark,
  runMeasurement,
  SCRATCH_PARENT_NAME,
  UNRELATED_TABLE,
} from "../../scripts/catalogue/benchmark-similarity-filebacked";
import { VECTOR_BYTES } from "../../src/services/catalogueSimilarity";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "mgpl-bench-filebacked-"));
  tmpDirs.push(d);
  return d;
}

function tryCreateJunction(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, "junction");
    return true;
  } catch {
    try {
      symlinkSync(target, linkPath);
      return true;
    } catch {
      return false;
    }
  }
}

describe("benchmark-similarity-filebacked contract", () => {
  it("extracts the authoritative DDL from src/db.ts", () => {
    for (const table of ["CatalogueGames", "CatalogueDrafts", "CatalogueEmbeddings"]) {
      expect(extractTableDdl(table)).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(extractTableDdl("CatalogueEmbeddings")).toContain("CHECK (length(vector) = 3072)");
    expect(extractTableDdl("CatalogueDrafts")).toContain("PRIMARY KEY (qid, kind)");
  });

  it("populates a file-backed fixture with authoritative schema and searchable vectors", () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "fixture.db");
    populateFixture(dbPath, 50, FIXTURE_SEED);

    const db = new Database(dbPath);
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(count("SELECT COUNT(*) c FROM CatalogueGames")).toBe(50);
    expect(count("SELECT COUNT(*) c FROM CatalogueDrafts")).toBe(50);
    expect(count("SELECT COUNT(*) c FROM CatalogueEmbeddings")).toBe(50);
    const vector = db.prepare("SELECT vector FROM CatalogueEmbeddings WHERE qid = 'Q1'").get() as {
      vector: Buffer;
    };
    expect(vector.vector.length).toBe(VECTOR_BYTES);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = '${UNRELATED_TABLE}'`).get(),
    ).toBeTruthy();
    db.close();
  });

  it("runMeasurement reports correct results before and after unrelated writes", () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, "fixture.db");
    populateFixture(dbPath, 50, FIXTURE_SEED);

    const m = runMeasurement(dbPath, 50, 5, 2);
    expect(m.cold_result_count).toBe(10);
    expect(m.cold_first_use_includes_db_open).toBe(false);
    expect(m.warm_queries_count).toBe(5);
    expect(m.warm_times_ms.length).toBe(5);
    expect(m.reload_samples_count).toBe(2);
    expect(m.reload_times_ms.length).toBe(2);
    expect(m.rss_samples_bytes.length).toBe(3); // after-first-index + 2 reloads
    expect(m.max_rss_units_note).toMatch(/platform-dependent/);
  });

  it("createScratchDir yields unique owned directories and preserves sibling sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "sibling-sentinel.txt"), "keep");

    const a = createScratchDir(parent);
    const b = createScratchDir(parent);
    writeFileSync(path.join(a.path, "a.txt"), "a");
    writeFileSync(path.join(b.path, "b.txt"), "b");

    expect(a.path).not.toBe(b.path);
    expect(path.dirname(a.path)).toBe(path.resolve(parent));
    expect(path.dirname(b.path)).toBe(path.resolve(parent));

    // Compatibility non-deleting operation retains both paths
    cleanupScratchDir(a);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(path.join(a.path, "a.txt"))).toBe(true);

    cleanupScratchDir(b);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(path.join(b.path, "b.txt"))).toBe(true);

    // Unrelated sibling sentinel is preserved
    expect(existsSync(path.join(parent, "sibling-sentinel.txt"))).toBe(true);
    expect(existsSync(parent)).toBe(true);
  });

  it("normal benchmark run retains the uniquely created fixture, closes handles, and preserves sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "preexisting-sentinel.txt"), "keep");

    const m = runFullBenchmark(50, 5, 2, FIXTURE_SEED, parent);
    expect(m.total_vectors).toBe(50);
    expect(m.cold_result_count).toBe(10);
    expect(m.database_file_bytes).toBeGreaterThan(0);
    expect(m.fixture_creation_path).toBeDefined();
    expect(m.fixture_location_status).toBe("current_location_unverified");

    // Fixture is explicitly retained on disk at the original creation path
    expect(existsSync(m.fixture_creation_path)).toBe(true);
    expect(existsSync(path.join(m.fixture_creation_path, FIXTURE_DB_NAME))).toBe(true);

    // Preexisting sentinel is preserved
    expect(existsSync(path.join(parent, "preexisting-sentinel.txt"))).toBe(true);
    const entries = readdirSync(parent);
    expect(entries).toContain("preexisting-sentinel.txt");
    expect(entries).toContain(path.basename(m.fixture_creation_path));

    // Verify handles closed on Windows: test harness can cleanly remove the retained fixture
    expect(() => rmSync(m.fixture_creation_path, { recursive: true, force: true })).not.toThrow();
  });

  it("printReport outputs original creation path with unverified caveat and retention policy", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    const m = runFullBenchmark(50, 5, 2, FIXTURE_SEED, parent);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      printReport(m);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain(
      `Fixture creation path:   ${m.fixture_creation_path} (current location unverified; may differ if moved or replaced)`,
    );
    expect(output).toContain(
      "Retention policy:        Automatic deletion disabled. Fixture retained at creation path (~450 MB); operator removes manually when idle.",
    );
    expect(output).toContain('"fixture_creation_path":');
    expect(output).toContain('"fixture_location_status": "current_location_unverified"');
  });

  it("population failure retains the fixture and closes handles so the database file is removable", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    const owned = createScratchDir(parent);
    const dbPath = path.join(owned.path, FIXTURE_DB_NAME);
    populateFixture(dbPath, 20, FIXTURE_SEED);

    // A second populate on the same path fails with a primary-key conflict after the handle opens.
    expect(() => populateFixture(dbPath, 20, FIXTURE_SEED)).toThrow();

    // Fixture directory is retained
    expect(existsSync(owned.path)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);

    // The handle must be closed on the failure path, so the file is removable (Windows lock check).
    expect(() => rmSync(dbPath)).not.toThrow();
  });

  it("measurement child failure propagates, retains the fixture, closes handles, and preserves sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "sentinel.txt"), "keep");

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      // count below RESULT_LIMIT+1 makes the child's cold-query correctness check fail.
      expect(() => runFullBenchmark(5, 2, 1, FIXTURE_SEED, parent)).toThrow(
        /Measurement child process failed/,
      );
    } finally {
      console.error = origError;
    }

    // Diagnostic identifies creation path with unverified caveat
    expect(
      errors.some(
        (line) =>
          line.includes("[benchmark] fixture created at") &&
          line.includes(
            "(current location unverified; population completed, measurement incomplete)",
          ),
      ),
    ).toBe(true);

    // Sentinel preserved
    expect(existsSync(path.join(parent, "sentinel.txt"))).toBe(true);

    // Created fixture directory is retained
    const createdDirs = readdirSync(parent).filter((name) => name.startsWith("fixture-"));
    expect(createdDirs.length).toBe(1);
    const fixtureDir = path.join(parent, createdDirs[0]);
    expect(existsSync(path.join(fixtureDir, FIXTURE_DB_NAME))).toBe(true);

    // Handles closed: harness can remove
    expect(() => rmSync(fixtureDir, { recursive: true, force: true })).not.toThrow();
  });

  it("simulated child timeout error retains fixture, closes handles, and preserves sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "timeout-sentinel.txt"), "keep");

    const mockTimeoutSpawn = (() => ({
      error: new Error("ETIMEDOUT: child process execution timed out"),
      status: null,
      signal: "SIGTERM",
      output: ["", "", ""],
      pid: 12345,
      stdout: "",
      stderr: "timeout",
    })) as unknown as typeof import("node:child_process").spawnSync;

    expect(() => runFullBenchmark(50, 5, 2, FIXTURE_SEED, parent, mockTimeoutSpawn)).toThrow(
      /Measurement child process failed to terminate: ETIMEDOUT/,
    );

    expect(existsSync(path.join(parent, "timeout-sentinel.txt"))).toBe(true);
    const createdDirs = readdirSync(parent).filter((name) => name.startsWith("fixture-"));
    expect(createdDirs.length).toBe(1);
    const fixtureDir = path.join(parent, createdDirs[0]);
    expect(existsSync(path.join(fixtureDir, FIXTURE_DB_NAME))).toBe(true);
    expect(() => rmSync(fixtureDir, { recursive: true, force: true })).not.toThrow();
  });

  it("malformed child output error retains fixture, closes handles, and preserves sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "malformed-sentinel.txt"), "keep");

    const mockMalformedSpawn = (() => ({
      error: undefined,
      status: 0,
      signal: null,
      output: ["", "NOT_VALID_JSON", ""],
      pid: 12346,
      stdout: "NOT_VALID_JSON",
      stderr: "",
    })) as unknown as typeof import("node:child_process").spawnSync;

    expect(() => runFullBenchmark(50, 5, 2, FIXTURE_SEED, parent, mockMalformedSpawn)).toThrow(
      SyntaxError,
    );

    expect(existsSync(path.join(parent, "malformed-sentinel.txt"))).toBe(true);
    const createdDirs = readdirSync(parent).filter((name) => name.startsWith("fixture-"));
    expect(createdDirs.length).toBe(1);
    const fixtureDir = path.join(parent, createdDirs[0]);
    expect(existsSync(path.join(fixtureDir, FIXTURE_DB_NAME))).toBe(true);
    expect(() => rmSync(fixtureDir, { recursive: true, force: true })).not.toThrow();
  });

  it("refuses preexisting junction scratch parent before population (or reports skipped)", () => {
    const dir = createTempDir();
    const realTarget = path.join(dir, "real-scratch-target");
    mkdirSync(realTarget, { recursive: true });
    writeFileSync(path.join(realTarget, "target-sentinel.txt"), "keep");

    const junctionParent = path.join(dir, SCRATCH_PARENT_NAME);
    const linked = tryCreateJunction(realTarget, junctionParent);

    if (linked) {
      expect(() => createScratchDir(junctionParent)).toThrow(
        /Refusing scratch path containing symlink or junction/,
      );
      expect(() => runFullBenchmark(50, 5, 2, FIXTURE_SEED, junctionParent)).toThrow(
        /Refusing scratch path containing symlink or junction/,
      );

      // Verify no population occurred in the target directory
      expect(readdirSync(realTarget)).toEqual(["target-sentinel.txt"]);
      rmSync(junctionParent, { force: true });
      console.log("[test:junction] preexisting junction parent rejection: EXECUTED (passed)");
    } else {
      console.warn(
        "[test:junction] junction creation not supported or permitted; preexisting junction parent test: SKIPPED",
      );
    }
  });

  it("reviewer substitution case 1a: ordinary directory substitution success reports original creation path with unverified caveat and preserves all sentinels", () => {
    // Reviewer finding: move owned child aside and replace it with an ordinary directory.
    // The benchmark must report original creation path with unverified location caveat and preserve all sentinels.
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "parent-sentinel.txt"), "keep");

    let originalMovedPath = "";
    let createdOwnedPath = "";
    const customSpawn = ((exe: string, args: string[], opts: unknown) => {
      const child = spawnSync(exe, args, opts as Parameters<typeof spawnSync>[2]);
      if (child.status !== 0) throw new Error("real child failed in test");

      const dbPath = args[4];
      createdOwnedPath = path.dirname(dbPath);

      originalMovedPath = path.join(parent, "owned-aside-success");
      renameSync(createdOwnedPath, originalMovedPath);
      mkdirSync(createdOwnedPath, { recursive: true });

      writeFileSync(path.join(originalMovedPath, "original-sentinel.txt"), "original");
      writeFileSync(path.join(createdOwnedPath, "replacement-sentinel.txt"), "replacement");

      return child;
    }) as unknown as typeof spawnSync;

    const m = runFullBenchmark(50, 5, 2, 1, parent, customSpawn);

    // Reports original creation path, not replacement directory as proven location
    expect(m.fixture_creation_path).toBe(createdOwnedPath);
    expect(m.fixture_location_status).toBe("current_location_unverified");

    // All original, replacement, and parent sibling sentinels survive (zero deletions)
    expect(existsSync(path.join(originalMovedPath, "original-sentinel.txt"))).toBe(true);
    expect(existsSync(path.join(originalMovedPath, FIXTURE_DB_NAME))).toBe(true);
    expect(existsSync(path.join(createdOwnedPath, "replacement-sentinel.txt"))).toBe(true);
    expect(existsSync(path.join(parent, "parent-sentinel.txt"))).toBe(true);
  });

  it("reviewer substitution case 1b: ordinary directory substitution failure reports creation path with unverified caveat and preserves all sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "parent-sentinel.txt"), "keep");

    let originalMovedPath = "";
    let createdOwnedPath = "";
    const customSpawn = ((exe: string, args: string[], opts: unknown) => {
      const child = spawnSync(exe, args, opts as Parameters<typeof spawnSync>[2]);
      const dbPath = args[4];
      createdOwnedPath = path.dirname(dbPath);

      originalMovedPath = path.join(parent, "owned-aside-fail");
      renameSync(createdOwnedPath, originalMovedPath);
      mkdirSync(createdOwnedPath, { recursive: true });

      writeFileSync(path.join(originalMovedPath, "original-sentinel.txt"), "original");
      writeFileSync(path.join(createdOwnedPath, "replacement-sentinel.txt"), "replacement");

      return {
        ...child,
        status: 7,
        stderr: "injected child failure after ordinary substitution",
      };
    }) as unknown as typeof spawnSync;

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      expect(() => runFullBenchmark(50, 5, 2, 1, parent, customSpawn)).toThrow(
        /Measurement child process failed \(status 7\)/,
      );
    } finally {
      console.error = origError;
    }

    expect(
      errors.some(
        (line) =>
          line.includes(`[benchmark] fixture created at ${createdOwnedPath}`) &&
          line.includes(
            "(current location unverified; population completed, measurement incomplete)",
          ),
      ),
    ).toBe(true);

    expect(existsSync(path.join(originalMovedPath, "original-sentinel.txt"))).toBe(true);
    expect(existsSync(path.join(createdOwnedPath, "replacement-sentinel.txt"))).toBe(true);
    expect(existsSync(path.join(parent, "parent-sentinel.txt"))).toBe(true);
  });

  it("reviewer substitution case 2a: parent-junction substitution success reports creation path with unverified caveat and preserves all sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "parent-sentinel.txt"), "keep");

    let originalChildPath = "";
    let replacementChildPath = "";
    let parentMovedPath = "";
    let childBasename = "";
    let junctionCreated = false;

    const customSpawn = ((exe: string, args: string[], opts: unknown) => {
      const child = spawnSync(exe, args, opts as Parameters<typeof spawnSync>[2]);
      if (child.status !== 0) throw new Error("real child failed in test");

      const dbPath = args[4];
      const owned = path.dirname(dbPath);
      childBasename = path.basename(owned);

      parentMovedPath = path.join(dir, "parent-moved-success");
      renameSync(parent, parentMovedPath);
      originalChildPath = path.join(parentMovedPath, childBasename);

      const redirected = path.join(dir, "redirected-parent-success");
      replacementChildPath = path.join(redirected, childBasename);
      mkdirSync(replacementChildPath, { recursive: true });

      junctionCreated = tryCreateJunction(redirected, parent);
      if (!junctionCreated) {
        return child;
      }

      writeFileSync(path.join(originalChildPath, "original-sentinel.txt"), "original");
      writeFileSync(path.join(replacementChildPath, "replacement-sentinel.txt"), "replacement");

      return child;
    }) as unknown as typeof spawnSync;

    const m = runFullBenchmark(50, 5, 2, 1, parent, customSpawn);

    if (junctionCreated) {
      expect(m.fixture_creation_path).toContain(childBasename);
      expect(m.fixture_location_status).toBe("current_location_unverified");

      expect(existsSync(path.join(originalChildPath, "original-sentinel.txt"))).toBe(true);
      expect(existsSync(path.join(originalChildPath, FIXTURE_DB_NAME))).toBe(true);
      expect(existsSync(path.join(replacementChildPath, "replacement-sentinel.txt"))).toBe(true);
      expect(existsSync(path.join(parentMovedPath, "parent-sentinel.txt"))).toBe(true);

      rmSync(parent, { force: true });
      console.log(
        "[test:junction] parent-junction substitution success regression: EXECUTED (passed)",
      );
    } else {
      console.warn(
        "[test:junction] junction creation not supported or permitted; parent-junction substitution success test: SKIPPED",
      );
    }
  });

  it("reviewer substitution case 2b: parent-junction substitution failure reports creation path with unverified caveat and preserves all sentinels", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, "parent-sentinel.txt"), "keep");

    let originalChildPath = "";
    let replacementChildPath = "";
    let parentMovedPath = "";
    let createdOwnedPath = "";
    let junctionCreated = false;

    const customSpawn = ((_exe: string, args: string[]) => {
      // Inject measurement failure directly: a successful real child is unnecessary here
      // and can leave the parent rename exposed to unrelated Windows file activity.
      // Case 2a retains real-child coverage of successful parent-junction substitution.
      const child: SpawnSyncReturns<string> = {
        pid: 0,
        output: [null, "", "injected child failure after parent-junction substitution"],
        stdout: "",
        stderr: "injected child failure after parent-junction substitution",
        status: 7,
        signal: null,
      };
      const dbPath = args[4];
      createdOwnedPath = path.dirname(dbPath);
      const childBasename = path.basename(createdOwnedPath);

      parentMovedPath = path.join(dir, "parent-moved-fail");
      renameSync(parent, parentMovedPath);
      originalChildPath = path.join(parentMovedPath, childBasename);

      const redirected = path.join(dir, "redirected-parent-fail");
      replacementChildPath = path.join(redirected, childBasename);
      mkdirSync(replacementChildPath, { recursive: true });

      junctionCreated = tryCreateJunction(redirected, parent);
      expect(junctionCreated).toBe(true);

      writeFileSync(path.join(originalChildPath, "original-sentinel.txt"), "original");
      writeFileSync(path.join(replacementChildPath, "replacement-sentinel.txt"), "replacement");

      return child;
    }) as unknown as typeof spawnSync;

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      expect(() => runFullBenchmark(50, 5, 2, 1, parent, customSpawn)).toThrow(
        /Measurement child process failed \(status 7\)/,
      );
    } finally {
      console.error = origError;
    }

    expect(junctionCreated).toBe(true);
    if (junctionCreated) {
      expect(
        errors.some(
          (line) =>
            line.includes(`[benchmark] fixture created at ${createdOwnedPath}`) &&
            line.includes(
              "(current location unverified; population completed, measurement incomplete)",
            ),
        ),
      ).toBe(true);

      expect(existsSync(path.join(originalChildPath, "original-sentinel.txt"))).toBe(true);
      expect(existsSync(path.join(replacementChildPath, "replacement-sentinel.txt"))).toBe(true);
      expect(existsSync(path.join(parentMovedPath, "parent-sentinel.txt"))).toBe(true);

      rmSync(parent, { force: true });
      console.log(
        "[test:junction] parent-junction substitution failure regression: EXECUTED (passed)",
      );
    }
  });

  it("creation failure under an invalid parent file does not invent a created fixture path or emit retention diagnostic", () => {
    const dir = createTempDir();
    const invalidParent = path.join(dir, "invalid-parent-file");
    writeFileSync(invalidParent, "not-a-directory");

    const scratchUnderFile = path.join(invalidParent, SCRATCH_PARENT_NAME);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      expect(() => runFullBenchmark(50, 5, 2, 1, scratchUnderFile)).toThrow();
    } finally {
      console.error = origError;
    }

    expect(errors.some((line) => line.includes("[benchmark] fixture"))).toBe(false);
    expect(readFileSync(invalidParent, "utf8")).toBe("not-a-directory");
  });

  it("distinct invocations create unique directories and retain both without collision", () => {
    const dir = createTempDir();
    const parent = path.join(dir, SCRATCH_PARENT_NAME);

    const m1 = runFullBenchmark(50, 5, 2, 1, parent);
    const m2 = runFullBenchmark(50, 5, 2, 2, parent);

    expect(m1.fixture_creation_path).not.toBe(m2.fixture_creation_path);
    expect(existsSync(m1.fixture_creation_path)).toBe(true);
    expect(existsSync(m2.fixture_creation_path)).toBe(true);
    expect(existsSync(path.join(m1.fixture_creation_path, FIXTURE_DB_NAME))).toBe(true);
    expect(existsSync(path.join(m2.fixture_creation_path, FIXTURE_DB_NAME))).toBe(true);
  });

  it("assertNoSymlinkAncestry verifies link detection and refuses symlink or junction paths", () => {
    const dir = createTempDir();
    const targetDir = path.join(dir, "link-target");
    mkdirSync(targetDir, { recursive: true });
    const linkPath = path.join(dir, "link-path");

    const linked = tryCreateJunction(targetDir, linkPath);
    if (linked) {
      expect(() => assertNoSymlinkAncestry(linkPath)).toThrow(/symlink or junction/);
      const childOfLink = path.join(linkPath, "child");
      expect(() => assertNoSymlinkAncestry(childOfLink)).toThrow(/symlink or junction/);
      rmSync(linkPath, { force: true });
      console.log("[test:junction] assertNoSymlinkAncestry check: EXECUTED (passed)");
    } else {
      console.warn(
        "[test:junction] junction creation not supported; assertNoSymlinkAncestry test: SKIPPED",
      );
    }
  });
});
