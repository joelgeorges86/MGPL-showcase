/* Verify public/index.html encoding after mojibake repair. */
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'public', 'index.html');
const raw = fs.readFileSync(target);
const txt = raw.toString('utf8');

const checks = [
  ['valid UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(raw); return true; } catch (e) { return false; } })()],
  ['proper ellipsis U+2026', txt.includes('\u2026')],
  ['mojibake \u00e2\u20ac\u00a6 remaining', txt.includes('\u00e2\u20ac\u00a6')],
  ['proper arrow U+2192', txt.includes('\u2192')],
  ['mojibake \u00e2\u2020\u2122 remaining', txt.includes('\u00e2\u2020\u2122')],
  ['proper em-dash U+2014', txt.includes('\u2014')],
  ['mojibake \u00e2\u20ac\u201c remaining', txt.includes('\u00e2\u20ac\u201c')],
  ['proper middle dot U+00B7', txt.includes('\u00b7')],
  ['mojibake \u00c2\u00b7 remaining', txt.includes('\u00c2\u00b7')],
  ['proper rocket U+1F680', txt.includes('\uD83D\uDE80')],
  ['mojibake \u00f0\u0178 remaining', txt.includes('\u00f0\u0178')],
  ['proper green circle U+1F7E2', txt.includes('\uD83D\uDFE2')],
  ['proper laptop U+1F5A5', txt.includes('\uD83D\uDDA5')],
  ['proper gamepad U+1F3AE', txt.includes('\uD83C\uDFAE')],
];

let allGood = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) allGood = false;
}
console.log(allGood ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(allGood ? 0 : 1);
