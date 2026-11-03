#!/usr/bin/env node
/**
 * check-agents-md-integrity.js
 *
 * Guards the canonical agent rulebook against silent destruction.
 *
 * Why this exists: PR #71 (merged 2026-09-22) removed 277 of ~280 lines of
 * AGENTS.md and replaced them with a single agent-authored spend-authorization
 * clause containing U+FFFD replacement characters. All four required checks
 * passed. The loss surfaced only because a fresh agent session read the file
 * and said something looked wrong.
 *
 * AGENTS.md is auto-loaded as instructions for every agent lane, so a
 * truncated file does not fail loudly — it silently removes every constraint
 * while leaving whatever survived in force. This check makes that failure
 * visible at gate time.
 *
 * Exit 0 = pass. Exit 1 = fail, with the reason on stderr.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Thresholds. Tune these when AGENTS.md legitimately changes shape; a floor
// that has to be lowered often is a floor set too close to the current value.
// ---------------------------------------------------------------------------

const AGENTS_PATH = path.resolve(__dirname, "..", "AGENTS.md");
const CLAUDE_PATH = path.resolve(__dirname, "..", "CLAUDE.md");

/** Hard floor on total lines. Actual as of 2026-09-23: 431. */
const MIN_LINES = 380;

/** Hard floor on `## ` top-level sections. */
const MIN_SECTIONS = 10;

/** Substrings that must appear. Keep this list short and structural. */
const REQUIRED_MARKERS = ["# AGENTS.md", "## 1. What MGPL Is"];

/** CLAUDE.md must still import AGENTS.md rather than fork it. */
const CLAUDE_IMPORT_MARKER = "@AGENTS.md";

// ---------------------------------------------------------------------------

const failures = [];

function fail(msg) {
  failures.push(msg);
}

function readUtf8(filePath) {
  let raw = fs.readFileSync(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  return raw;
}

// --- 1. Exists and is non-trivial ------------------------------------------

if (!fs.existsSync(AGENTS_PATH)) {
  console.error("FAIL: AGENTS.md does not exist at " + AGENTS_PATH);
  process.exit(1);
}

const text = readUtf8(AGENTS_PATH);
const lines = text.split(/\r?\n/);

if (lines.length < MIN_LINES) {
  fail(
    `AGENTS.md has ${lines.length} lines, below the floor of ${MIN_LINES}. ` +
      "The rulebook appears truncated. Restore it from history rather than " +
      "editing the remnant.",
  );
}

// --- 2. No decode damage ----------------------------------------------------
// U+FFFD means bytes were lost in a decode and written back. It is not
// recoverable by re-saving; the content is already gone.

const replacementMatches = [];
lines.forEach((line, i) => {
  if (line.includes("\uFFFD")) replacementMatches.push(i + 1);
});

if (replacementMatches.length > 0) {
  const shown = replacementMatches.slice(0, 10).join(", ");
  const more =
    replacementMatches.length > 10 ? ` (and ${replacementMatches.length - 10} more)` : "";
  fail(
    `AGENTS.md contains U+FFFD replacement characters on line(s) ${shown}${more}. ` +
      "This indicates the file was read with the wrong encoding and written " +
      "back with data lost. Restore from history; do not re-save.",
  );
}

// --- 3. Structure -----------------------------------------------------------

const sectionCount = lines.filter((l) => /^##\s/.test(l)).length;
if (sectionCount < MIN_SECTIONS) {
  fail(
    `AGENTS.md has ${sectionCount} top-level sections, below the floor of ` +
      `${MIN_SECTIONS}. Sections appear to have been dropped.`,
  );
}

for (const marker of REQUIRED_MARKERS) {
  if (!text.includes(marker)) {
    fail(`AGENTS.md is missing required marker: ${JSON.stringify(marker)}`);
  }
}

// --- 4. The import chain ----------------------------------------------------

if (!fs.existsSync(CLAUDE_PATH)) {
  fail("CLAUDE.md does not exist; the AGENTS.md import chain is broken.");
} else {
  const claudeText = readUtf8(CLAUDE_PATH);
  if (!claudeText.includes(CLAUDE_IMPORT_MARKER)) {
    fail(
      `CLAUDE.md no longer contains ${CLAUDE_IMPORT_MARKER}. Agents reading ` +
        "CLAUDE.md would not receive the rulebook.",
    );
  }
}

// --- Report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error("AGENTS.md integrity check FAILED:\n");
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error(
    "AGENTS.md is auto-loaded as instructions for every agent lane. A damaged\n" +
      "file does not disable agents — it removes their constraints while leaving\n" +
      "whatever survived in force. Do not merge until this passes.\n",
  );
  process.exit(1);
}

console.log(
  `AGENTS.md integrity OK — ${lines.length} lines, ${sectionCount} sections, ` +
    "no decode damage, import chain intact.",
);
process.exit(0);
