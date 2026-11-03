#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const { selectChangedFiles } = require("./lib/changed-files");

const root = path.resolve(__dirname, "..");
// Glob pathspecs (see lib/changed-files.js): one pattern per extension,
// because git never expands {json,md,yml} (#124).
const patterns = [
  "**/*.json",
  "**/*.md",
  "**/*.yml",
  "src/**/*.ts",
  "test/**/*.ts",
  "public/**/*.js",
  "scripts/**/*.js",
];

const files = selectChangedFiles({ root, patterns, label: "Prettier" });
if (files === null) process.exit(1);
if (files.length === 0) process.exit(0);

const prettierBin = path.join(root, "node_modules", "prettier", "bin", "prettier.cjs");
try {
  // "--" ends the options, so a file named like an option (a leading "-") is
  // still checked as a file instead of being read as a flag.
  execFileSync(process.execPath, [prettierBin, "--check", "--", ...files], {
    cwd: root,
    stdio: "inherit",
  });
} catch (error) {
  process.exit(error.status || 1);
}
