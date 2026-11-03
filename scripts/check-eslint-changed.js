#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const { selectChangedFiles } = require("./lib/changed-files");

const root = path.resolve(__dirname, "..");
const patterns = ["src/**/*.ts", "test/**/*.ts", "public/**/*.js", "scripts/**/*.js"];

const files = selectChangedFiles({ root, patterns, label: "ESLint" });
if (files === null) process.exit(1);
if (files.length === 0) process.exit(0);

const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");
try {
  // "--" ends the options, so a file named like an option is still linted.
  execFileSync(process.execPath, [eslintBin, "--max-warnings=0", "--", ...files], {
    cwd: root,
    stdio: "inherit",
  });
} catch (error) {
  process.exit(error.status || 1);
}
