/* Diagnostic: find remaining mojibake patterns in public/index.html with context. */
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'public', 'index.html');
const txt = fs.readFileSync(target, 'utf8');

const patterns = [
  ['\u00e2\u20ac\u00a6', 'â€¦ (ellipsis mojibake)'],
  ['\u00e2\u2020\u2122', 'â†’ (arrow mojibake)'],
  ['\u00e2\u20ac\u201c', 'â€" (em-dash mojibake)'],
  ['\u00c2\u00b7', 'Â· (middle-dot mojibake)'],
  ['\u00f0\u0178', 'ðŸ (emoji mojibake)'],
  ['\u00e2\u20ac\u2122', 'â€™ (apostrophe mojibake)'],
  ['\u00e2\u20ac\u2019', 'â€™ (right-quote mojibake)'],
  ['\u00e2\u20ac\u0153', 'â€œ (left-quote mojibake)'],
  ['\u00e2\u20ac\u009d', 'â€ (right-double mojibake)'],
];

for (const [pat, label] of patterns) {
  let idx = txt.indexOf(pat);
  let count = 0;
  const samples = [];
  while (idx !== -1 && count < 3) {
    const start = Math.max(0, idx - 20);
    const end = Math.min(txt.length, idx + pat.length + 20);
    samples.push(txt.slice(start, end).replace(/\n/g, '\\n'));
    count++;
    idx = txt.indexOf(pat, idx + 1);
  }
  // count all
  let total = 0;
  let i = txt.indexOf(pat);
  while (i !== -1) { total++; i = txt.indexOf(pat, i + 1); }
  console.log(`\n[${label}] total=${total}`);
  samples.forEach((s) => console.log('  ...' + s + '...'));
}
