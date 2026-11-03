import { spawnSync } from "child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/doctor.js is a CommonJS entrypoint. Load it without triggering its
// `main()` runner (guarded by `require.main === module`) and exercise the
// exported, pure Git base-selection helpers against real temporary repositories.
type GitResult = { status: number; stdout: string; stderr: string };
type GitRunner = (args: string[]) => GitResult;

interface DoctorModule {
  BASE_CANDIDATES: string[];
  pickBaseBranch: (
    git: GitRunner,
    candidates?: string[],
  ) => { candidate: string; distance: number } | null;
  divergence: (git: GitRunner, base: string) => { behind: number; ahead: number } | null;
}

const require = createRequire(import.meta.url);
const doctor = require("../../scripts/doctor.js") as DoctorModule;

// Temp repositories live under <repo>/.tmp_doctor-base-branch (git-ignored by
// .tmp_*/) rather than the OS temp directory: endpoint protection on the
// development machine blocks .git/objects writes there (issue #146, Finding C).
const tempRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".tmp_doctor-base-branch",
);

const tempDirs: string[] = [];
const preservedTempDirs = new Set<string>();
const diagnosticPath = path.resolve("test-results", "doctor-base-branch-diagnostics.jsonl");

function preserveDiagnostics(cwd: string, args: string[], result: GitResult, reason: string): void {
  preservedTempDirs.add(cwd);
  mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  appendFileSync(
    diagnosticPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      reason,
      cwd,
      args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    })}\n`,
  );
  console.error(
    `[doctorBaseBranch] preserved ${cwd}; ${reason}; git ${args.join(" ")} status=${result.status}; stderr=${result.stderr || "<empty>"}`,
  );
}

function reportGitResult(
  cwd: string,
  args: string[],
  result: GitResult,
  reason: string,
): GitResult {
  console.info(
    `[doctorBaseBranch] ${reason}; git ${args.join(" ")} status=${result.status}; stderr=${result.stderr || "<empty>"}`,
  );
  if (result.status !== 0) {
    preserveDiagnostics(cwd, args, result, reason);
  }
  return result;
}

// Git's own list of repository-location variables (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY and the rest). An
// inherited value would redirect the temp repositories' writes, so every child
// git process gets an environment with all of them removed.
const repoLocationVariables = (() => {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const names = (result.stdout || "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (result.status !== 0 || names.length === 0) {
    throw new Error(
      `git rev-parse --local-env-vars failed: ${(result.stderr || "").trim() || "<empty>"}`,
    );
  }
  return new Set(names.map((name) => name.toUpperCase()));
})();

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!repoLocationVariables.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return env;
}

function makeGit(cwd: string): GitRunner {
  return (args) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      // Identity + GPG-disable via environment keeps the test independent of the
      // user's global git config and avoids three `git config` subprocess calls
      // per repository (the test spawns git many times, so fewer calls = faster).
      env: {
        ...isolatedEnv(),
        GIT_AUTHOR_NAME: "Doctor Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Doctor Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
      },
    });
    return {
      status: result.status === null ? 1 : result.status,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  };
}

// Endpoint protection on the development machine intermittently denies a write
// under .git/objects (issue #146, Finding C). Only that failure is retried, a
// bounded number of times, and every retry is logged and recorded; any other
// failure, or one that outlasts the retries, is returned unchanged.
const TRANSIENT_WRITE_FAILURE =
  /\.git[\\/]objects[^\n]*(Permission denied|unable to write)|(Permission denied|unable to write)[^\n]*\.git[\\/]objects|failed to insert into database/i;
const RETRY_DELAYS_MS = [100, 300, 600];

function isTransientWriteFailure(result: GitResult): boolean {
  return result.status !== 0 && TRANSIENT_WRITE_FAILURE.test(result.stderr);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runWithRetry(
  run: () => GitResult,
  onRetry: (attempt: number, result: GitResult) => void,
  delays: readonly number[] = RETRY_DELAYS_MS,
  wait: (ms: number) => void = pause,
): GitResult {
  let result = run();
  for (let attempt = 0; attempt < delays.length && isTransientWriteFailure(result); attempt += 1) {
    onRetry(attempt + 1, result);
    wait(delays[attempt]);
    result = run();
  }
  return result;
}

function gitWithRetry(g: GitRunner, cwd: string, args: string[]): GitResult {
  return runWithRetry(
    () => g(args),
    (attempt, failed) => {
      mkdirSync(path.dirname(diagnosticPath), { recursive: true });
      appendFileSync(
        diagnosticPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          reason: "transient write failure; retrying",
          attempt,
          cwd,
          args,
          status: failed.status,
          stderr: failed.stderr,
        })}\n`,
      );
      console.error(
        `[doctorBaseBranch] retry ${attempt} of ${RETRY_DELAYS_MS.length}: git ${args.join(" ")} status=${failed.status}; stderr=${failed.stderr || "<empty>"}`,
      );
    },
  );
}

function commit(g: GitRunner, cwd: string, message: string): string {
  writeFileSync(path.join(cwd, "file.txt"), `${message}\n`, { flag: "a" });
  const addResult = reportGitResult(
    cwd,
    ["add", "-A"],
    gitWithRetry(g, cwd, ["add", "-A"]),
    "git add instrumentation",
  );
  if (addResult.status !== 0) {
    console.error(
      `[doctorBaseBranch] git add -A failed; continuing without remediation so the downstream failure remains observable; status=${addResult.status}; stderr=${addResult.stderr || "<empty>"}`,
    );
  }
  const result = gitWithRetry(g, cwd, ["commit", "-m", message]);
  if (result.status !== 0) {
    preserveDiagnostics(cwd, ["commit", "-m", message], result, "git commit failure");
    throw new Error(`commit failed: ${result.stdout}; stderr: ${result.stderr}`);
  }
  return g(["rev-parse", "HEAD"]).stdout;
}

function checkout(g: GitRunner, cwd: string, args: string[]): GitResult {
  return reportGitResult(cwd, args, g(args), "git checkout instrumentation");
}

function setRemoteRef(g: GitRunner, name: string, sha: string): void {
  const result = g(["update-ref", `refs/remotes/origin/${name}`, sha]);
  if (result.status !== 0) {
    throw new Error(`update-ref ${name} failed: ${result.stdout}`);
  }
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function initRepo(): { cwd: string; g: GitRunner } {
  mkdirSync(tempRoot, { recursive: true });
  const cwd = mkdtempSync(path.join(tempRoot, "mgpl-doctor-"));
  tempDirs.push(cwd);
  const g = makeGit(cwd);
  const init = g(["init", "-b", "main"]);
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stdout}`);
  }
  const gitDir = g(["rev-parse", "--absolute-git-dir"]);
  const expected = path.join(cwd, ".git");
  if (gitDir.status !== 0 || !samePath(gitDir.stdout, expected)) {
    throw new Error(
      `temp repository is not isolated: expected ${expected}, git reported ${gitDir.stdout || gitDir.stderr}`,
    );
  }
  return { cwd, g };
}

afterEach((context) => {
  const caseFailed = context.task.result?.state === "fail";
  for (const dir of tempDirs.splice(0)) {
    if (caseFailed) {
      preservedTempDirs.add(dir);
      console.error(
        `[doctorBaseBranch] retained temporary repository for failed test case: ${dir}`,
      );
      continue;
    }
    if (preservedTempDirs.delete(dir)) {
      console.error(`[doctorBaseBranch] retained failing temporary repository: ${dir}`);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/doctor.js base-branch selection", { timeout: 30000 }, () => {
  it("selects origin/develop for a branch cut from develop", () => {
    const { cwd, g } = initRepo();

    // main: A -> M1
    commit(g, cwd, "A");
    const mainTip = commit(g, cwd, "M1");

    // develop diverges from A: D1 -> D2
    checkout(g, cwd, ["checkout", "-b", "develop", `${mainTip}~1`]);
    commit(g, cwd, "D1");
    const developTip = commit(g, cwd, "D2");

    // feature cut from the develop tip
    checkout(g, cwd, ["checkout", "-b", "feature/x", developTip]);
    commit(g, cwd, "F1");

    setRemoteRef(g, "main", mainTip);
    setRemoteRef(g, "develop", developTip);

    const base = doctor.pickBaseBranch(g, doctor.BASE_CANDIDATES);
    expect(base).not.toBeNull();
    expect(base!.candidate).toBe("origin/develop");

    const div = doctor.divergence(g, base!.candidate);
    expect(div).not.toBeNull();
    expect(div!.behind).toBe(0);
  });

  it("selects origin/main for a branch cut from main", () => {
    const { cwd, g } = initRepo();

    commit(g, cwd, "A");
    const mainTip = commit(g, cwd, "M1");

    checkout(g, cwd, ["checkout", "-b", "develop", `${mainTip}~1`]);
    commit(g, cwd, "D1");
    const developTip = commit(g, cwd, "D2");

    // feature cut from the main tip
    checkout(g, cwd, ["checkout", "-b", "feature/x", mainTip]);
    commit(g, cwd, "F1");

    setRemoteRef(g, "main", mainTip);
    setRemoteRef(g, "develop", developTip);

    const base = doctor.pickBaseBranch(g, doctor.BASE_CANDIDATES);
    expect(base).not.toBeNull();
    expect(base!.candidate).toBe("origin/main");

    const div = doctor.divergence(g, base!.candidate);
    expect(div).not.toBeNull();
    expect(div!.behind).toBe(0);
  });

  it("still reports a nonzero behind count for a stale develop-cut branch", () => {
    const { cwd, g } = initRepo();

    commit(g, cwd, "A");
    const mainTip = commit(g, cwd, "M1");

    checkout(g, cwd, ["checkout", "-b", "develop", `${mainTip}~1`]);
    commit(g, cwd, "D1");
    const developTip = commit(g, cwd, "D2");

    // feature cut from the develop tip
    checkout(g, cwd, ["checkout", "-b", "feature/x", developTip]);
    commit(g, cwd, "F1");

    // develop then advances past the branch point
    checkout(g, cwd, ["checkout", "develop"]);
    const advancedDevelopTip = commit(g, cwd, "D3");
    checkout(g, cwd, ["checkout", "feature/x"]);

    setRemoteRef(g, "main", mainTip);
    setRemoteRef(g, "develop", advancedDevelopTip);

    const base = doctor.pickBaseBranch(g, doctor.BASE_CANDIDATES);
    expect(base).not.toBeNull();
    expect(base!.candidate).toBe("origin/develop");

    const div = doctor.divergence(g, base!.candidate);
    expect(div).not.toBeNull();
    expect(div!.behind).toBeGreaterThan(0);
  });

  it("keeps temp repositories isolated from inherited Git location variables", () => {
    mkdirSync(tempRoot, { recursive: true });
    const decoy = mkdtempSync(path.join(tempRoot, "decoy-"));
    tempDirs.push(decoy);
    const planted: Record<string, string> = {
      GIT_DIR: path.join(decoy, "git-dir"),
      GIT_WORK_TREE: path.join(decoy, "work-tree"),
      GIT_INDEX_FILE: path.join(decoy, "index"),
      GIT_COMMON_DIR: path.join(decoy, "common-dir"),
      GIT_OBJECT_DIRECTORY: path.join(decoy, "objects"),
    };
    const saved = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(planted)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      const { cwd, g } = initRepo();
      commit(g, cwd, "A");
      expect(readdirSync(decoy)).toEqual([]);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

describe("the Finding C retry around git writes", () => {
  const denied: GitResult = {
    status: 128,
    stdout: "",
    stderr:
      "error: unable to write file .git/objects/9d/9bec86: Permission denied\nerror: file.txt: failed to insert into database",
  };
  const ok: GitResult = { status: 0, stdout: "", stderr: "" };
  const other: GitResult = { status: 1, stdout: "", stderr: "fatal: not a git repository" };

  it("retries a denied .git/objects write and returns the success that follows", () => {
    const results = [denied, denied, ok];
    const retries: number[] = [];
    const waits: number[] = [];
    const result = runWithRetry(
      () => results.shift()!,
      (attempt) => retries.push(attempt),
      [1, 2, 3],
      (ms) => waits.push(ms),
    );
    expect(result).toBe(ok);
    expect(retries).toEqual([1, 2]);
    expect(waits).toEqual([1, 2]);
  });

  it("does not retry any other failure", () => {
    let calls = 0;
    const result = runWithRetry(
      () => {
        calls += 1;
        return other;
      },
      () => {
        throw new Error("retried a non-transient failure");
      },
      [1, 2, 3],
      () => {},
    );
    expect(result).toBe(other);
    expect(calls).toBe(1);
  });

  it("gives up after the last delay and returns the last failure", () => {
    let calls = 0;
    const retries: number[] = [];
    const result = runWithRetry(
      () => {
        calls += 1;
        return denied;
      },
      (attempt) => retries.push(attempt),
      [1, 2, 3],
      () => {},
    );
    expect(result).toBe(denied);
    expect(calls).toBe(4);
    expect(retries).toEqual([1, 2, 3]);
  });

  it("treats a success as final, whatever its stderr says", () => {
    expect(isTransientWriteFailure({ status: 0, stdout: "", stderr: denied.stderr })).toBe(false);
    expect(isTransientWriteFailure(denied)).toBe(true);
    expect(isTransientWriteFailure(other)).toBe(false);
  });

  it.each([
    [
      "a denied write, forward slashes",
      "error: unable to write file .git/objects/9d/9bec86: Permission denied",
    ],
    [
      "a denied write, backslashes",
      "error: unable to write file .git\\objects\\9d\\9bec86: Permission denied",
    ],
    ["the database insert on its own", "error: file.txt: failed to insert into database"],
  ])("retries %s", (_label, stderr) => {
    expect(isTransientWriteFailure({ status: 128, stdout: "", stderr })).toBe(true);
  });

  it.each([
    ["an index write", "fatal: unable to write new index file"],
    [
      "a full disk elsewhere",
      "error: unable to write file unrelated/path: No space left on device",
    ],
    ["a held index lock", "fatal: Unable to create '.git/index.lock': File exists."],
    [
      "an objects path and a denial on different lines",
      'warning: .git/objects/info/alternates ignored\nerror: open("x"): Permission denied',
    ],
  ])("does not retry %s", (_label, stderr) => {
    expect(isTransientWriteFailure({ status: 128, stdout: "", stderr })).toBe(false);
  });
});
