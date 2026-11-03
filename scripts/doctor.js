#!/usr/bin/env node
/*
 * MGPL cold-start doctor (PI-004).
 * Verifies the local development prerequisites without printing secrets:
 * Node 22, Git Bash resolution, Doppler project/config binding, feature branch
 * hygiene, base-branch freshness (origin/main vs origin/develop), and port 4000
 * availability.
 */
const { spawnSync } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");

let failed = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error,
  };
}

function writeCheck(name, passed, detail, opts = {}) {
  const status = passed ? "PASS" : opts.warning ? "WARN" : "FAIL";
  console.log(`[${status}] ${name} - ${detail}`);
  if (!passed && !opts.warning) failed = true;
}

function commandPath(command) {
  const lookup = run(process.platform === "win32" ? "where" : "which", [command]);
  return lookup.status === 0 ? lookup.stdout.split(/\r?\n/)[0] : null;
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolve({ available: false, detail: error && error.code ? error.code : String(error) });
    });
    server.once("listening", () => {
      server.close(() => resolve({ available: true, detail: "available" }));
    });
    server.listen({ port, host: "127.0.0.1" });
  });
}

// Git base-branch selection. The doctor must not assume every feature branch is
// cut from develop: a branch cut from main (e.g. an AGENTS.md sync) legitimately
// exists. We compare the current branch's merge-base against both origin/main and
// origin/develop and pick whichever base tip is closest to that merge-base (fewest
// commits ahead of it) ΓÇö that is the base this branch was actually cut from.
const BASE_CANDIDATES = ["origin/main", "origin/develop"];

// `git` is a function of shape (args: string[]) => { status, stdout }.
function resolveRev(git, ref) {
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function mergeBase(git, a, b) {
  const result = git(["merge-base", a, b]);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function commitDistance(git, from, to) {
  const result = git(["rev-list", "--count", `${from}..${to}`]);
  if (result.status !== 0) return null;
  const n = Number(result.stdout || 0);
  return Number.isFinite(n) ? n : null;
}

function pickBaseBranch(git, candidates = BASE_CANDIDATES) {
  let best = null;
  for (const candidate of candidates) {
    const tip = resolveRev(git, candidate);
    if (!tip) continue;
    const base = mergeBase(git, "HEAD", tip);
    if (!base) continue;
    const distance = commitDistance(git, base, tip);
    if (distance === null) continue;
    const isDevelop = candidate === "origin/develop";
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && isDevelop && !best.isDevelop)
    ) {
      best = { candidate, distance, isDevelop };
    }
  }
  return best;
}

function divergence(git, base) {
  const counts = git(["rev-list", "--left-right", "--count", `${base}...HEAD`]);
  if (counts.status !== 0) return null;
  const [behindRaw, aheadRaw] = (counts.stdout || "").trim().split(/\s+/);
  return {
    behind: Number(behindRaw || 0),
    ahead: Number(aheadRaw || 0),
  };
}

function makeGitRunner(runFn, cwd) {
  return (args) => runFn("git", args, { cwd });
}

async function main() {
  const root = path.resolve(__dirname, "..");
  process.chdir(root);
  writeCheck(
    "Repository",
    fs.existsSync(path.join(root, "AGENTS.md")) && fs.existsSync(path.join(root, "package.json")),
    root,
  );

  const nodeVersion = process.version;
  const nodeMajor = Number(/^v(\d+)/.exec(nodeVersion)?.[1] || 0);
  writeCheck(
    "Node.js",
    nodeMajor === 22,
    nodeMajor === 22
      ? `${nodeVersion} (${process.execPath})`
      : `${nodeVersion} (${process.execPath}); Node.js 22 is required. Run nvm use 22.23.2`,
  );

  const dopplerPath = commandPath("doppler");
  writeCheck("Doppler CLI", Boolean(dopplerPath), dopplerPath || "not found");
  if (dopplerPath) {
    const project = run(dopplerPath, ["configure", "get", "project", "--plain"]);
    const config = run(dopplerPath, ["configure", "get", "config", "--plain"]);
    const passed =
      project.status === 0 &&
      config.status === 0 &&
      project.stdout === "mgpl" &&
      /^dev/.test(config.stdout);
    writeCheck(
      "Doppler binding",
      passed,
      passed
        ? `project=${project.stdout} config=${config.stdout}`
        : "unable to verify local project/config binding. Run doppler setup --project mgpl --config dev in this directory",
    );
  }

  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const bashPath = fs.existsSync(gitBash) ? gitBash : commandPath("bash");
  const validBash = Boolean(bashPath) && !/\\System32\\bash\.exe$/i.test(bashPath || "");
  writeCheck("Git Bash", validBash, validBash ? bashPath : "not found");

  const branch = run("git", ["branch", "--show-current"]);
  const branchName = branch.stdout;
  writeCheck(
    "Feature branch",
    /^feature\//.test(branchName) || /^fix\//.test(branchName) || /^hotfix\//.test(branchName),
    branchName || "unknown",
  );

  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream.status === 0 && upstream.stdout) {
    const counts = run("git", ["rev-list", "--left-right", "--count", `${upstream.stdout}...HEAD`]);
    const [behindRaw, aheadRaw] = counts.stdout.split(/\s+/);
    const behind = Number(behindRaw || 0);
    const ahead = Number(aheadRaw || 0);
    writeCheck(
      "Upstream divergence",
      behind === 0,
      `upstream=${upstream.stdout} behind=${behind} ahead=${ahead}`,
    );
  } else {
    writeCheck(
      "Upstream divergence",
      true,
      "no upstream configured for this local feature branch",
      { warning: true },
    );
  }

  const git = makeGitRunner(run, root);

  const fetch = run("git", ["fetch", "--quiet", "origin", "main", "develop"]);
  const fetched = fetch.status === 0;
  if (!fetched) {
    writeCheck(
      "Base branch freshness",
      true,
      "unable to fetch origin base refs; continuing with local refs",
      { warning: true },
    );
  }

  const base = pickBaseBranch(git);
  if (!base) {
    writeCheck(
      "Base branch divergence",
      true,
      "no origin base ref (origin/main or origin/develop) available",
      { warning: true },
    );
  } else {
    const div = divergence(git, base.candidate);
    if (!div) {
      writeCheck("Base branch divergence", true, `${base.candidate} ref unavailable`, {
        warning: true,
      });
    } else if (!fetched) {
      writeCheck(
        "Base branch divergence",
        true,
        `base=${base.candidate} behind=${div.behind} ahead=${div.ahead} (fetch failed; not enforced)`,
        { warning: true },
      );
    } else {
      writeCheck(
        "Base branch divergence",
        div.behind === 0,
        `base=${base.candidate} behind=${div.behind} ahead=${div.ahead}`,
      );
    }
  }

  const port = await checkPortAvailable(4000);
  writeCheck("Development port 4000", port.available, port.detail);

  if (failed) {
    console.log("MGPL doctor found one or more blocking environment issues.");
    process.exit(1);
  }
  console.log("MGPL doctor passed.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  BASE_CANDIDATES,
  resolveRev,
  mergeBase,
  commitDistance,
  pickBaseBranch,
  divergence,
  makeGitRunner,
};
