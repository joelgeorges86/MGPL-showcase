#!/usr/bin/env node
/**
 * Gate S4 — Transport Security.
 *
 * Verifies the production transport surface end-to-end:
 *   - Express app: helmet mounted with HSTS (>= 1yr + includeSubDomains),
 *     frameguard deny, noSniff, and CSP enabled in production.
 *   - Session cookies: httpOnly + SameSite=Strict + Secure in production.
 *   - Caddy edge: Strict-Transport-Security and X-Frame-Options SAMEORIGIN.
 *
 * Usage: node scripts/gate-transport.js
 * Exit: 0 = all checks pass, 1 = any check failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CHECKS = [
  { id: 'HELMET', desc: 'helmet middleware mounted', file: 'src/index.ts', re: /helmet\(\s*\{/ },
  { id: 'HSTS', desc: 'HSTS maxAge 1yr + includeSubDomains', file: 'src/index.ts', re: /maxAge:\s*31536000[\s\S]*?includeSubDomains:\s*true/ },
  { id: 'FRAMEGUARD', desc: 'frameguard action deny', file: 'src/index.ts', re: /frameguard:\s*\{\s*action:\s*['"]deny['"]/ },
  { id: 'NOSNIFF', desc: 'noSniff enabled', file: 'src/index.ts', re: /noSniff:\s*true/ },
  { id: 'CSP_PROD', desc: 'CSP enabled in production', file: 'src/index.ts', re: /contentSecurityPolicy:\s*process\.env\.NODE_ENV\s*===\s*['"]production['"]/ },
  { id: 'COOKIE_HTTPONLY', desc: 'session cookie httpOnly', file: 'src/lib/auth.ts', re: /httpOnly:\s*true/ },
  { id: 'COOKIE_SECURE', desc: 'session cookie Secure in production', file: 'src/lib/auth.ts', re: /secure:\s*process\.env\.NODE_ENV\s*===\s*['"]production['"]/ },
  { id: 'COOKIE_SAMESITE', desc: 'session cookie SameSite=Strict', file: 'src/lib/auth.ts', re: /sameSite:\s*['"]strict['"]/ },
  { id: 'CADDY_HSTS', desc: 'Caddy Strict-Transport-Security', file: 'Caddyfile', re: /Strict-Transport-Security/ },
  { id: 'CADDY_FRAME', desc: 'Caddy X-Frame-Options SAMEORIGIN', file: 'Caddyfile', re: /X-Frame-Options\s+"SAMEORIGIN"/ },
];

let fails = 0;

for (const c of CHECKS) {
  const abs = path.join(ROOT, c.file);
  if (!fs.existsSync(abs)) {
    console.log(`FAIL  ${c.id} ${c.desc} — missing file ${c.file}`);
    fails += 1;
    continue;
  }
  const ok = c.re.test(fs.readFileSync(abs, 'utf8'));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id} ${c.desc}  (${c.file})`);
  if (!ok) fails += 1;
}

console.log(`\nTransport security: ${CHECKS.length} check(s), ${fails} failed.`);
process.exit(fails > 0 ? 1 : 0);
