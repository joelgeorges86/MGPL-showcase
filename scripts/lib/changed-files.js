"use strict";

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

const EXCLUDED_PREFIXES = [".tmp_pi003/"];

// Patterns are git pathspecs in glob mode. There, a "**/" segment also matches
// no directory, so "scripts/**/*.js" covers scripts/doctor.js. In git's default
// pathspec mode it does not, and {a,b} braces are never expanded in either.
function toGlob(pattern) {
  return `:(glob)${pattern}`;
}

// NUL-separated and unquoted, so names with spaces or non-ASCII characters
// reach ESLint and Prettier exactly as they are on disk.
function listFiles(root, range, pathspecs) {
  const output = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACMR",
      ...range,
      "--",
      ...pathspecs.map(toGlob),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

// "auto" picks the base the Environment doctor picks: origin/develop or
// origin/main, whichever this branch was cut from.
function resolveBase(root, requested) {
  if (requested !== "auto") return requested;
  const { pickBaseBranch } = require(path.join(root, "scripts", "doctor.js"));
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return { status: result.status, stdout: (result.stdout || "").trim() };
  };
  const best = pickBaseBranch(git);
  return best ? best.candidate : null;
}

/**
 * Selects the files a changed-files check (ESLint, Prettier) examines.
 *
 * With MGPL_LINT_BASE set, the selection is every file added, copied, modified
 * or renamed between that base and HEAD (`git diff <base>...HEAD`). CI sets
 * the base for each event, and gate Q1 (gates/q1-lint.sh) sets it to "auto".
 * Without it, the selection is the files staged for commit.
 *
 * The check must always be able to say what it examined (#97):
 * - a base that cannot be resolved is a failure;
 * - with no base and nothing staged, nothing can be selected, which is a
 *   failure rather than a silent pass;
 * - with a base, zero matching files is a pass that says so.
 *
 * Returns the selected files, or null after reporting a failure.
 */
function selectChangedFiles({ root, patterns, label }) {
  const requested = (process.env.MGPL_LINT_BASE || "").trim();
  if (requested.startsWith("-")) {
    console.error(`${label}: MGPL_LINT_BASE must name a commit, not an option: ${requested}`);
    return null;
  }

  let base = "";
  if (requested) {
    base = resolveBase(root, requested);
    if (!base) {
      console.error(`${label}: MGPL_LINT_BASE=auto found neither origin/develop nor origin/main.`);
      return null;
    }
  }

  const range = base ? [`${base}...HEAD`] : ["--cached", "HEAD"];
  const source = base ? `changed since ${base}` : "staged for commit";

  let selected;
  let total;
  try {
    selected = listFiles(root, range, patterns);
    total = listFiles(root, range, []).length;
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    console.error(`${label}: could not list the files ${source}. ${detail}`);
    return null;
  }

  if (!base && total === 0) {
    console.error(
      `${label}: nothing was checked. No files are staged and MGPL_LINT_BASE is not set. ` +
        "Set MGPL_LINT_BASE (for example auto or origin/develop) to check the files a branch changes.",
    );
    return null;
  }

  console.log(`${label}: checking ${selected.length} of ${total} file(s) ${source}.`);
  return selected;
}

module.exports = { selectChangedFiles };
