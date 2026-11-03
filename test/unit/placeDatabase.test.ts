import { createRequire } from "module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { placeDatabase, runSeedCommand } = require("../../scripts/lib/place-database.js") as {
  placeDatabase: (options: {
    targetPath: string;
    seedDatabase: (temporaryPath: string) => void;
    beforeLink?: (paths: { temporaryPath: string; targetPath: string }) => void;
    fileSystem?: typeof import("fs");
  }) => { placed: boolean; existingTarget: boolean };
  runSeedCommand: (
    temporaryPath: string,
    options: { runnerEntryPoint: string; seedEntryPoint: string },
  ) => void;
};

const directories: string[] = [];
const fixtureScriptPath = path.resolve("test-results", "place-database-seed-arg-fixture.js");
const runnerFixturePath = path.resolve("test-results", "place-database-runner-fixture.js");

function fixture(): { directory: string; targetPath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "mgpl-place-database-"));
  directories.push(directory);
  return { directory, targetPath: path.join(directory, "mpgl_app.db") };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  rmSync(fixtureScriptPath, { force: true });
  rmSync(runnerFixturePath, { force: true });
});

describe("placeDatabase", () => {
  it.each(["spaces", "&", "^", "%PATH%"])(
    "passes a path containing %s through a real child process without shell interpretation",
    (fragment) => {
      const { directory } = fixture();
      const receivedPath = path.join(directory, "received-path.txt");
      const targetPath = path.join(directory, `database-${fragment}`, "target.db");
      const temporaryPath = path.join(path.dirname(targetPath), "temporary database.db");
      mkdirForTest(temporaryPath);
      mkdirSync(path.dirname(fixtureScriptPath), { recursive: true });
      writeFileSync(
        fixtureScriptPath,
        [
          'const fs = require("fs");',
          `fs.writeFileSync(${JSON.stringify(receivedPath)}, process.argv[2]);`,
          'fs.writeFileSync(process.argv[2], "seeded");',
        ].join("\n"),
      );
      writeFileSync(
        runnerFixturePath,
        [
          'const { spawnSync } = require("child_process");',
          'const result = spawnSync(process.execPath, [process.argv[2], process.argv[3]], { stdio: "inherit", shell: false });',
          "if (result.error) throw result.error;",
          "process.exit(result.status ?? 1);",
        ].join("\n"),
      );
      runSeedCommand(temporaryPath, {
        runnerEntryPoint: runnerFixturePath,
        seedEntryPoint: fixtureScriptPath,
      });
      expect(readFileSync(receivedPath, "utf8")).toBe(temporaryPath);
      expect(readFileSync(temporaryPath, "utf8")).toBe("seeded");
    },
  );

  it("passes the temporary path to seeding and never the target path", () => {
    const { targetPath } = fixture();
    let seededPath = "";
    const result = placeDatabase({
      targetPath,
      seedDatabase: (temporaryPath) => {
        seededPath = temporaryPath;
        writeFileSync(temporaryPath, "seeded");
      },
    });
    expect(seededPath).not.toBe(targetPath);
    expect(result).toEqual({ placed: true, existingTarget: false });
    expect(readFileSync(targetPath, "utf8")).toBe("seeded");
  });

  it("preserves a target created between the check and placement without reseeding", () => {
    const { targetPath } = fixture();
    const existingBytes = Buffer.from("created by the competing writer");
    let seedCount = 0;
    const result = placeDatabase({
      targetPath,
      seedDatabase: (temporaryPath) => {
        seedCount += 1;
        writeFileSync(temporaryPath, "seeded temporary database");
      },
      beforeLink: () => writeFileSync(targetPath, existingBytes),
    });
    expect(result).toEqual({ placed: false, existingTarget: true });
    expect(seedCount).toBe(1);
    expect(readFileSync(targetPath)).toEqual(existingBytes);
  });

  it.each(["-wal", "-shm"])("aborts when target %s appears before placement", (suffix) => {
    const { targetPath } = fixture();
    expect(() =>
      placeDatabase({
        targetPath,
        seedDatabase: (temporaryPath) => writeFileSync(temporaryPath, "seeded"),
        beforeLink: () => writeFileSync(`${targetPath}${suffix}`, "sidecar"),
      }),
    ).toThrow(/sidecar/);
    expect(existsSync(targetPath)).toBe(false);
    expect(existsSync(`${targetPath}${suffix}`)).toBe(true);
  });

  it.each(["success", "seed failure", "link failure"])(
    "removes temporary files and sidecars on %s",
    (scenario) => {
      const { targetPath } = fixture();
      let temporaryPath = "";
      const options = {
        targetPath,
        seedDatabase: (candidate: string) => {
          temporaryPath = candidate;
          if (scenario === "seed failure") {
            writeFileSync(`${candidate}-wal`, "seed sidecar");
            throw new Error("seed failed");
          }
          writeFileSync(candidate, "seeded");
        },
        beforeLink: ({ temporaryPath: candidate }) => {
          if (scenario !== "seed failure") writeFileSync(`${candidate}-shm`, "temporary sidecar");
        },
        fileSystem:
          scenario === "link failure"
            ? {
                ...require("fs"),
                linkSync: () => {
                  const error = new Error("link failed") as NodeJS.ErrnoException;
                  error.code = "EIO";
                  throw error;
                },
              }
            : require("fs"),
      };
      if (scenario === "seed failure") expect(() => placeDatabase(options)).toThrow("seed failed");
      else if (scenario === "link failure")
        expect(() => placeDatabase(options)).toThrow("link failed");
      else expect(placeDatabase(options)).toEqual({ placed: true, existingTarget: false });
      expect(existsSync(temporaryPath)).toBe(false);
      expect(existsSync(`${temporaryPath}-wal`)).toBe(false);
      expect(existsSync(`${temporaryPath}-shm`)).toBe(false);
    },
  );

  it("leaves no target file when seeding fails", () => {
    const { targetPath } = fixture();
    expect(() =>
      placeDatabase({
        targetPath,
        seedDatabase: () => {
          throw new Error("seed failed");
        },
      }),
    ).toThrow("seed failed");
    expect(existsSync(targetPath)).toBe(false);
  });
});

it("keeps setup-worktree database seeding behind the placement module", () => {
  const setupScript = readFileSync(path.resolve("scripts/setup-worktree.sh"), "utf8");
  expect(setupScript).toContain("scripts/lib/place-database.js");
  expect(setupScript).not.toContain("npm run db:seed");
});

function mkdirForTest(filePath: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
}
