#!/usr/bin/env node
/**
 * Client script syntax gate (DoD step 3).
 *
 * Replaces the hardcoded `node -c public/<file>.js && ...` chain in package.json
 * with a glob scan so newly added public modules are covered automatically and
 * the gate can never drift out of sync with the filesystem.
 *
 * Cross-platform: uses `node --check` via execFileSync (same check as `node -c`),
 * so it runs identically on Windows, macOS, and Linux CI.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .sort();

if (files.length === 0) {
  console.error('[test:client] No .js files found in public/ — refusing to pass vacuously.');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const filePath = path.join(dir, f);
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    console.log(`OK   ${f}`);
  } catch (e) {
    failed += 1;
    const detail = e && e.stderr ? e.stderr.toString().trim() : String((e && e.message) || e);
    console.error(`FAIL ${f}\n${detail}`);
  }
}

const passed = files.length - failed;
console.log(`\n${passed}/${files.length} client scripts passed syntax check.`);
process.exit(failed > 0 ? 1 : 0);
