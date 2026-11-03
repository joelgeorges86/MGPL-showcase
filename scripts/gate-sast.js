#!/usr/bin/env node
/**
 * Gate S1 — Static Application Security Testing (SAST).
 *
 * Scans every tracked file under src/ and public/ for a curated set of
 * high-risk patterns:
 *   - script-injection sinks: eval(), new Function(), document.write()
 *   - shell-command execution: child_process.exec/execSync/execFile/spawn,
 *     plus bare exec()/execSync() that is NOT a method call (e.g. sqlite
 *     db.exec() is a legitimate method call and is ignored)
 *   - hardcoded secrets with known vendor prefixes (AWS, GitHub, Stripe,
 *     Slack, Google, npm, private keys)
 *
 * Non-failing warnings: innerHTML assignment (the vanilla-JS SPA renders DOM
 * via innerHTML by design) and console.* calls in src (operational logging).
 *
 * Usage: node scripts/gate-sast.js
 * Exit: 0 = pass, 1 = at least one FAIL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function gitTracked(patterns) {
  const out = execFileSync('git', ['ls-files', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const FILES = gitTracked(['src/**/*.ts', 'public/**/*.js']);

const RULES = [
  { name: 'eval() / new Function() / document.write()', re: /\beval\s*\(|\bnew\s+Function\s*\(|\bdocument\.write\s*\(/ },
  { name: 'child_process exec/execSync/execFile/spawn', re: /child_process\s*\.\s*(?:exec|execSync|execFile|spawn)\s*\(/ },
  { name: 'bare exec()/execSync() (not a method call)', re: /(?<![\w.])exec(?:Sync)?\s*\(/ },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub personal access token', re: /\b(?:ghp|gho)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{22,}\b/ },
  { name: 'Stripe secret key', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'npm access token', re: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
];

// Documented, justified exceptions. Each entry must name a specific file and
// the exact allowed token so the gate can never be silently disabled.
const ALLOW = [
  {
    file: /src\/lib\/auth\.ts$/,
    re: /dev-only-insecure-secret-do-not-use-in-prod/,
    reason: 'documented dev-only JWT fallback (production must supply JWT_SECRET)',
  },
];

let fails = 0;
let warnGroups = 0;

for (const f of FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');

  lines.forEach((line, idx) => {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      const allowed = ALLOW.some((a) => a.file.test(f) && a.re.test(line));
      if (allowed) {
        const reason = ALLOW.find((a) => a.file.test(f))?.reason || 'allowlisted';
        console.log(`INFO  ${f}:${idx + 1} allowlisted (${rule.name}) — ${reason}`);
        continue;
      }
      fails += 1;
      console.log(`FAIL  ${f}:${idx + 1}  ${rule.name}  ->  ${line.trim().slice(0, 140)}`);
    }
  });

  const innerHtml = lines.filter((l) => /innerHTML\s*=/.test(l)).length;
  if (innerHtml > 0) {
    warnGroups += 1;
    console.log(`WARN  ${f}: ${innerHtml} innerHTML assignment(s) (vanilla DOM rendering)`);
  }
  if (f.startsWith('src/')) {
    const logs = lines.filter((l) => /\bconsole\.(?:log|warn|error)\s*\(/.test(l)).length;
    if (logs > 0) {
      warnGroups += 1;
      console.log(`WARN  ${f}: ${logs} console.* call(s) (operational logging)`);
    }
  }
}

console.log(`\nSAST scan complete: ${FILES.length} file(s), ${fails} FAIL(s), ${warnGroups} warning group(s).`);
process.exit(fails > 0 ? 1 : 0);
