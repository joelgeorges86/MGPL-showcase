#!/usr/bin/env node
/**
 * Gate Q1 — Structural Lint.
 *
 * FAIL on:
 *   - debugger statements (src / public / test)
 *   - TODO/FIXME markers in shipped code (src / public)
 *   - tab indentation in tracked TS/JS source (src / public / test)
 *
 * Non-failing warnings (aggregated per file):
 *   - console.* calls in src (operational logging)
 *   - trailing whitespace
 *   - missing final newline at EOF
 *
 * NOTE: A full ESLint pipeline is intentionally not required; this gate runs
 * deterministic structural checks with zero external dependencies so it can
 * never silently skip. Substitute ESLint here if a richer rule set is wanted.
 *
 * Usage: node scripts/gate-lint.js
 * Exit: 0 = pass, 1 = at least one FAIL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const tracked = execFileSync(
  'git',
  ['ls-files', 'src/**/*.ts', 'public/**/*.js', 'test/**/*.ts', 'test/**/*.js'],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
).split('\n').map((s) => s.trim()).filter(Boolean);

const FILES = tracked.filter((f) => !/\.d\.ts$/.test(f));

let fails = 0;
let warns = 0;

for (const f of FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n');

  lines.forEach((line, idx) => {
    if (/\bdebugger\b\s*;?/.test(line)) {
      fails += 1;
      console.log(`FAIL  ${f}:${idx + 1} debugger statement`);
    }
    if (f.startsWith('src/') || f.startsWith('public/')) {
      if (/\b(?:TODO|FIXME)\b/.test(line)) {
        fails += 1;
        console.log(`FAIL  ${f}:${idx + 1} TODO/FIXME marker`);
      }
    }
    if (/^\t/.test(line)) {
      fails += 1;
      console.log(`FAIL  ${f}:${idx + 1} tab indentation`);
    }
  });

  const trailing = lines.filter((l) => /[ \t]+$/.test(l)).length;
  if (trailing > 0) {
    warns += 1;
    console.log(`WARN  ${f}: ${trailing} trailing-whitespace line(s)`);
  }
  if (f.startsWith('src/') && /\bconsole\.(?:log|warn|error)\s*\(/.test(raw)) {
    warns += 1;
    console.log(`WARN  ${f}: console.* logging present`);
  }
  if (!raw.endsWith('\n')) {
    warns += 1;
    console.log(`WARN  ${f}: missing final newline`);
  }
}

console.log(`\nLint complete: ${FILES.length} file(s), ${fails} FAIL(s), ${warns} warning(s).`);
process.exit(fails > 0 ? 1 : 0);
