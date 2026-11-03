#!/usr/bin/env node
/**
 * Gate Q4 — Bundle Size.
 *
 * Enforces size budgets on the client bundle (public/*.js) and the compiled
 * server output (dist/**). The vanilla-JS SPA is deliberately unbundled, so
 * "bundle" here means the aggregate footprint shipped to the browser and the
 * compiled server artifact.
 *
 * Budgets (configurable via env GATE_BUNDLE_PUBLIC_BYTES / GATE_BUNDLE_DIST_BYTES):
 *   public/*.js total  <  1,500,000 bytes (1.5 MB)
 *   dist/** total      <  5,000,000 bytes (5 MB)
 *
 * Usage: node scripts/gate-bundle.js
 * Exit: 0 = pass, 1 = budget exceeded.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PUBLIC_BUDGET = Number(process.env.GATE_BUNDLE_PUBLIC_BYTES) || 1_500_000;
const DIST_BUDGET = Number(process.env.GATE_BUNDLE_DIST_BYTES) || 5_000_000;

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(abs);
    else if (entry.isFile()) total += fs.statSync(abs).size;
  }
  return total;
}

const publicDir = path.join(ROOT, 'public');
const publicFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith('.js')).sort();
let publicTotal = 0;
let largest = { name: '', size: 0 };
for (const f of publicFiles) {
  const size = fs.statSync(path.join(publicDir, f)).size;
  publicTotal += size;
  if (size > largest.size) largest = { name: f, size };
}

const distDir = path.join(ROOT, 'dist');
const distTotal = fs.existsSync(distDir) ? dirSize(distDir) : null;

console.log(
  `public/*.js: ${publicFiles.length} file(s), ${(publicTotal / 1024).toFixed(1)} KiB total, ` +
  `largest ${largest.name} (${(largest.size / 1024).toFixed(1)} KiB)`
);
console.log(
  `dist/**: ${distTotal === null ? 'absent (skipped)' : `${(distTotal / 1024).toFixed(1)} KiB total`}`
);

let fails = 0;
if (publicTotal > PUBLIC_BUDGET) {
  console.log(`FAIL  public/*.js total ${publicTotal} exceeds budget ${PUBLIC_BUDGET}`);
  fails += 1;
} else {
  console.log(`PASS  public/*.js under ${(PUBLIC_BUDGET / 1024).toFixed(0)} KiB budget`);
}
if (distTotal !== null && distTotal > DIST_BUDGET) {
  console.log(`FAIL  dist/** total ${distTotal} exceeds budget ${DIST_BUDGET}`);
  fails += 1;
} else if (distTotal !== null) {
  console.log(`PASS  dist/** under ${(DIST_BUDGET / 1024).toFixed(0)} KiB budget`);
}

process.exit(fails > 0 ? 1 : 0);
