#!/usr/bin/env node
/**
 * Gate S3 — Secret Scanner.
 *
 * Scans every git-tracked text file for high-confidence secret patterns
 * (vendor-prefixed credentials, private keys, hardcoded key material, and
 * hardcoded secret/password literals in shipped code). Legitimate fixture
 * values (deterministic test keys, seeded password hashes) are allowlisted
 * with an explicit reason below.
 *
 * Usage: node scripts/gate-secret-scan.js
 * Exit: 0 = pass, 1 = at least one non-allowlisted finding.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|eot|pdf|db|sqlite|wasm|zip|gz|svgz|jar)$/i;

const tracked = execFileSync('git', ['ls-files'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).split('\n').map((s) => s.trim()).filter(Boolean);

const FILES = tracked.filter((f) => !BINARY_EXT.test(f));

const SECRET_PATTERNS = [
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub personal access token', re: /\b(?:ghp|gho)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{22,}\b/ },
  { name: 'Stripe secret / restricted key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'SendGrid API key', re: /\bSG\.[0-9A-Za-z_-]{20,}\b/ },
  { name: 'Twilio API key', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { name: 'npm access token', re: /\bnpm_[0-9A-Za-z]{36}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  {
    name: 'hardcoded key material (key/secret/token/iv/salt)',
    re: /\b(?:secret|token|api[_-]?key|enc(?:ryption)?[_-]?key|iv|salt)\b\s*[:=]\s*['"]?[0-9a-fA-F]{64}['"]?/i,
  },
  {
    name: 'hardcoded secret/password literal (src/public only)',
    re: /\b(?:secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]{20,}['"]/i,
    scope: 'src-or-public',
  },
];

// Documented exceptions. tokenCipher.test.ts / playwright.config.ts carry the
// same deterministic AES-256-GCM test key; global-setup.ts seeds Argon2
// password hashes for the E2E fixtures.
const ALLOW = [
  {
    file: /test\/unit\/tokenCipher\.test\.ts$/,
    re: /00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff/,
    reason: 'deterministic unit-test encryption key (non-production)',
  },
  {
    file: /playwright\.config\.ts$/,
    re: /00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff/,
    reason: 'deterministic E2E token-encryption key',
  },
  {
    file: /src\/lib\/auth\.ts$/,
    re: /dev-only-insecure-secret-do-not-use-in-prod/,
    reason: 'documented dev-only JWT fallback (production must supply JWT_SECRET)',
  },
  {
    file: /test\/global-setup\.ts$/,
    re: /\$argon2(id|i|d)\$/,
    reason: 'seeded Argon2 password hashes (test fixtures)',
  },
];

const SKIP_DIRS = ['node_modules/', 'dist/', 'data/'];

let fails = 0;

for (const f of FILES) {
  if (SKIP_DIRS.some((d) => f.startsWith(d))) continue;
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    for (const p of SECRET_PATTERNS) {
      if (p.scope === 'src-or-public' && !(f.startsWith('src/') || f.startsWith('public/'))) continue;
      const m = line.match(p.re);
      if (!m) continue;
      const allowed = ALLOW.some((a) => a.file.test(f) && a.re.test(line));
      if (allowed) {
        const reason = ALLOW.find((a) => a.file.test(f))?.reason || 'allowlisted';
        console.log(`INFO  ${f}:${idx + 1} allowlisted (${p.name}) — ${reason}`);
        continue;
      }
      fails += 1;
      console.log(`FAIL  ${f}:${idx + 1}  ${p.name}  ->  ${line.trim().slice(0, 120)}`);
    }
  });
}

console.log(`\nSecret scan complete: ${FILES.length} file(s), ${fails} finding(s).`);
process.exit(fails > 0 ? 1 : 0);
