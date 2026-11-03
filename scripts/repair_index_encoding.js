/* MGPL encoding repair (dev-env restore) — v3
 *
 * public/index.html contains CP1252-mojibake: UTF-8 bytes were decoded as
 * Windows-1252 then re-encoded as UTF-8. The corrupted characters are exactly
 * the ones CP1252 maps to bytes 0x80..0xFF:
 *   - 0x80..0x9F: the CP1252 "smart" punctuation (U+20AC, U+2018/2019,
 *     U+201C/201D, U+2020/2021, U+2026, U+2030, U+2039/203A, U+2122, etc.)
 *   - 0xA0..0xFF: U+00A0..U+00FF (Â, â, €, ¦, etc.)
 *
 * Recovery: for each maximal run of mojibake chars, encode back to CP1252
 * bytes using a proper CP1252 encoder (NOT latin1, which maps the smart chars
 * to the wrong bytes), then decode those bytes as UTF-8.
 */
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'public', 'index.html');
const raw = fs.readFileSync(target);
const text = raw.toString('utf8');

// CP1252 byte -> char for the 0x80..0x9F range (the "smart" punctuation).
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

// Reverse map: char code -> CP1252 byte (for the smart chars).
const CHAR_TO_BYTE = {};
for (const [byte, code] of Object.entries(CP1252_HIGH)) {
  CHAR_TO_BYTE[code] = Number(byte);
}

// Set of all chars that are mojibake (i.e. that CP1252 maps to a byte).
const MOJIBAKE_CODES = new Set();
for (let b = 0x80; b <= 0xff; b++) {
  const code = CP1252_HIGH[b] !== undefined ? CP1252_HIGH[b] : b;
  MOJIBAKE_CODES.add(code);
}

function isMojibakeChar(ch) {
  return MOJIBAKE_CODES.has(ch.codePointAt(0));
}

// Encode a run of mojibake chars back to CP1252 bytes.
function encodeCp1252(run) {
  const bytes = [];
  for (const ch of run) {
    const code = ch.codePointAt(0);
    if (code >= 0x80 && code <= 0xff && CP1252_HIGH[code] === undefined) {
      bytes.push(code); // plain 0xA0..0xFF byte
    } else if (CHAR_TO_BYTE[code] !== undefined) {
      bytes.push(CHAR_TO_BYTE[code]); // smart punctuation byte
    } else {
      bytes.push(0x3f); // '?' fallback (should not happen)
    }
  }
  return Buffer.from(bytes);
}

let out = '';
let i = 0;
let repairedRuns = 0;
let repairedChars = 0;

while (i < text.length) {
  const ch = text[i];
  if (isMojibakeChar(ch)) {
    let j = i;
    while (j < text.length && isMojibakeChar(text[j])) j++;
    const run = text.slice(i, j);
    const bytes = encodeCp1252(run);
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      // Not a valid UTF-8 sequence — leave the run as-is (defensive).
      decoded = run;
    }
    out += decoded;
    repairedRuns++;
    repairedChars += run.length;
    i = j;
  } else {
    out += ch;
    i++;
  }
}

fs.writeFileSync(target, out, 'utf8');
console.log(`Repaired ${repairedRuns} mojibake run(s), ${repairedChars} char(s).`);
console.log('Done.');
