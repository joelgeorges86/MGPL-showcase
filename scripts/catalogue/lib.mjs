// WU-009a (#158): shared helpers for the catalogue ingest. No billed call is made anywhere in
// scripts/catalogue/: the sources are Wikidata (CC0) and the Steam Web API (facts only), both free.
// See DOCS/catalogue/SOURCES.md for each source's licence, attribution and link format.
//
// Every stored fact keeps the link it came from (task proposal 017, Addendum 1, decision 2).
// WU-009a3 (task proposal 022): the Steam Web API client (steamWebApi) never puts its key or a
// request URL into a message, and safeMessage masks a key that reaches one anyway.
// cspell:words wikidata appdetails oldid sitelink NFKC jsonl gmbh steampowered

import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** True when the module at metaUrl is the script node was started with. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DATA_DIR = path.join(ROOT, "data", "catalogue");

// Wikidata asks every client to identify itself with a contact (User-Agent policy).
// CATALOGUE_CONTACT overrides the default, for example with a contact address.
export function userAgent(env = process.env) {
  const contact = env.CATALOGUE_CONTACT || "https://github.com/joelgeorges86/MGPL";
  return `MGPL-catalogue-ingest/1.0 (${contact})`;
}

// ---------------------------------------------------------------------------
// Source links. Each one points at the exact version a fact was read from.

const QID = /^Q[1-9]\d*$/;

export function wikidataItemUrl(qid) {
  if (!QID.test(qid)) throw new Error(`not a Wikidata item ID: ${qid}`);
  return `https://www.wikidata.org/wiki/${qid}`;
}

/** The permanent link to the revision the fact was read from. */
export function wikidataRevisionUrl(qid, revid) {
  if (!QID.test(qid)) throw new Error(`not a Wikidata item ID: ${qid}`);
  if (!/^\d+$/.test(String(revid))) throw new Error(`not a revision ID: ${revid}`);
  return `https://www.wikidata.org/w/index.php?title=${qid}&oldid=${revid}`;
}

export function steamAppUrl(appid) {
  if (!/^\d+$/.test(String(appid))) throw new Error(`not a Steam app ID: ${appid}`);
  return `https://store.steampowered.com/app/${appid}/`;
}

/** Wikipedia is model context only: the link is stored, the text never is. */
export function wikipediaRevisionUrl(title, oldid) {
  if (!title) throw new Error("no Wikipedia title");
  if (!/^\d+$/.test(String(oldid))) throw new Error(`not a revision ID: ${oldid}`);
  const t = encodeURIComponent(String(title).replace(/ /g, "_"));
  return `https://en.wikipedia.org/w/index.php?title=${t}&oldid=${oldid}`;
}

// ---------------------------------------------------------------------------
// Normalisation, for comparison only. Stored values keep their original spelling.

/**
 * Characters that comparison ignores, and only these (WU-009a2): whitespace, and Unicode
 * punctuation (category P) except "#". Everything else is kept, including letters, combining
 * marks, numbers, "+", currency and other symbols ("$", "\u221e", "\u2665").
 */
export const IGNORED_CHARS = /(?:[^\P{P}#]|[\p{Z}\s])+/gu;

/**
 * A title or name for comparison. It removes only what is listed here, and keeps every other
 * character (WU-009a2):
 *   - the trademark, registered and copyright signs;
 *   - letter case (toLowerCase, after NFC);
 *   - "&", read as "and";
 *   - IGNORED_CHARS: whitespace and punctuation except "#".
 * NFC only, never NFKC: "Game \u00b2" and "Game 2", or a full-width title and its ASCII form,
 * stay different and go to review. A name with nothing left is null.
 */
export function normTitle(s) {
  if (typeof s !== "string") return null;
  const t = s
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(IGNORED_CHARS, " ")
    .trim()
    .replace(/\s+/g, " ");
  return t || null;
}

const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "llc",
  "llp",
  "corp",
  "corporation",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "srl",
  "bv",
  "kk",
  "plc",
  "pty",
  "oy",
  "ab",
]);

/** A company name for comparison: normalised, without a trailing legal suffix. */
/**
 * A company name for comparison: normalised, and without trailing legal suffixes ("Pty Ltd",
 * ", Inc."). A name with any bracket keeps every word (WU-009a2): in "Studio (AG)" the "AG" may
 * be part of the identity, so it is never stripped.
 */
export function normCompany(s) {
  const t = normTitle(s);
  if (!t) return null;
  const words = t.split(" ");
  if (/[()[\]{}]/.test(s)) return words.join(" ");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * Steam's company name without a platform note, for comparison only (WU-009a2): "Aspyr (Mac)" and
 * "Aspyr (Linux)" compare as "Aspyr". Only (Mac), (macOS) and (Linux) are removed; any other
 * bracket ("Studio (UK)") can be part of a company's identity and is kept.
 */
export function stripPlatformNote(name) {
  if (typeof name !== "string") return name;
  const t = name.replace(/\s*\((?:mac|macos|linux)\)\s*$/i, "");
  return t.trim() ? t : name;
}

/**
 * Steam's store name without its edition labels, for comparison only (WU-009a2). Removes, from
 * the end and repeatedly, only these exact forms: "(2007)", "(Classic)", "(Classic, 2005)",
 * "Game of the Year Edition" and "GOTY Edition". Nothing else is removed: "(Remastered 2020)",
 * "Definitive Edition", a bare "GOTY" and the like can be different products. A removal that
 * would leave no title is not made. Returns { title, removed }.
 */
export function stripSteamEdition(name) {
  if (typeof name !== "string") return { title: name, removed: [] };
  const removed = [];
  let t = name;
  for (;;) {
    const m =
      t.match(/\s*\((?:(?:19|20)\d{2}|classic(?:,\s*(?:19|20)\d{2})?)\)\s*$/i) ??
      t.match(/[\s:\u2013\u2014-]*\b(?:game of the year|goty)\s+edition\s*$/i);
    if (!m || !normTitle(t.slice(0, m.index))) break;
    removed.unshift(m[0].trim());
    t = t.slice(0, m.index);
  }
  return { title: t.trim(), removed };
}

/** A pattern matching a folder path in any letter case and with either slash. */
function pathPattern(dir) {
  const parts = dir
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const lead = /^[\\/]/.test(dir) ? "[\\\\/]+" : "";
  return new RegExp(lead + parts.join("[\\\\/]+"), "gi");
}

/**
 * An error message safe to print (WU-009a2). The temporary and home folders, whose paths hold
 * the user name, become "%TEMP%" and "~", matched in any letter case and with either slash.
 * Any other user-profile path (C:\Users\<name>, /Users/<name>, /home/<name>) also becomes "~".
 * WU-009a3: the Steam Web API key never appears either. Its value (as given, and URL-encoded)
 * becomes "***", and so does the value of any "key=" query parameter.
 */
export function safeMessage(
  e,
  { home = os.homedir(), tmp = os.tmpdir(), secrets = [process.env.STEAM_API_KEY] } = {},
) {
  let m = String(e?.message ?? e);
  for (const sec of secrets) {
    if (typeof sec !== "string" || sec.length < 4) continue;
    for (const form of new Set([sec, encodeURIComponent(sec)])) m = m.split(form).join("***");
  }
  m = m.replace(/([?&;]key=)[^&\s'"`]+/gi, "$1***");
  for (const [dir, label] of [
    [tmp, "%TEMP%"],
    [home, "~"],
  ]) {
    if (dir && dir.length > 3) m = m.replace(pathPattern(dir), label);
  }
  return m.replace(/(?:[a-z]:)?[\\/]+(?:users|home)[\\/]+[^\\/\s'"`]+/gi, "~");
}

// ---------------------------------------------------------------------------
// Dates. A date is { iso, precision } with precision "day", "month" or "year".

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const pad = (n) => String(n).padStart(2, "0");

function validDay(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Steam's `release_date.date` comes in several shapes; anything else is null. */
export function parseSteamDate(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  let m = /^(\d{1,2}) ([A-Za-z]{3,4})\.?,? (\d{4})$/.exec(s); // 24 Feb, 2017
  if (m) return day(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([A-Za-z]{3,4})\.? (\d{1,2}),? (\d{4})$/.exec(s); // Feb 24, 2017
  if (m) return day(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /^([A-Za-z]{3,9}) (\d{4})$/.exec(s); // February 2017
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? { iso: `${m[2]}-${pad(mon)}`, precision: "month" } : null;
  }
  m = /^(\d{4})$/.exec(s);
  if (m) return { iso: m[1], precision: "year" };
  return null;
  function day(y, mon, d) {
    if (!mon || !validDay(y, mon, d)) return null;
    return { iso: `${y}-${pad(mon)}-${pad(d)}`, precision: "day" };
  }
}

/** Wikidata time values: "+2017-02-24T00:00:00Z" with precision 11 (day), 10 (month), 9 (year). */
export function parseWikidataDate(time, precision) {
  const m = /^\+?(\d{4})-(\d{2})-(\d{2})T/.exec(String(time ?? ""));
  const p = Number(precision);
  if (!m) return null;
  if (p >= 11)
    return validDay(+m[1], +m[2], +m[3])
      ? { iso: `${m[1]}-${m[2]}-${m[3]}`, precision: "day" }
      : null;
  if (p === 10) return { iso: `${m[1]}-${m[2]}`, precision: "month" };
  if (p === 9) return { iso: m[1], precision: "year" };
  return null;
}

/**
 * A Steam Web API release time (Unix seconds) as a day (WU-009a3). Steam stores a release at
 * midnight Pacific time, which is the same calendar day in UTC. 0, a missing value or anything
 * that is not a positive whole number is null: Steam uses 0 for "not recorded".
 */
export function unixDay(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    precision: "day",
  };
}

/** Two dates agree when they are equal at the coarser of their two precisions. */
export function datesAgree(a, b) {
  if (!a || !b) return false;
  const len = Math.min(a.iso.length, b.iso.length);
  return a.iso.slice(0, len) === b.iso.slice(0, len);
}

/** Of two dates, the one with the coarser precision (fewer ISO characters). */
export function coarserDate(a, b) {
  return a.iso.length <= b.iso.length ? a : b;
}

/**
 * A Retry-After header as milliseconds to wait, measured from nowMs. Both forms are read:
 * delay-seconds ("120") and an HTTP date ("Thu, 08 Oct 2026 12:02:00 GMT"). A date already
 * past means 0. Absent or unreadable means null, and the caller backs off instead.
 */
export function retryAfterMs(header, nowMs) {
  if (header == null) return null;
  const h = String(header).trim();
  if (!h) return null;
  if (/^\d+$/.test(h)) return Number(h) * 1000;
  if (!/[a-z]/i.test(h)) return null;
  const t = Date.parse(h);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t - nowMs);
}

// ---------------------------------------------------------------------------
// One polite request at a time, with retries on 429 and 5xx.

export const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function politeFetcher({
  fetchImpl = globalThis.fetch,
  minIntervalMs,
  maxRetries = 5,
  baseBackoffMs = 30_000,
  sleep = sleepMs,
  now = Date.now,
  env = process.env,
}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0)
    throw new Error("minIntervalMs is required");
  let last = -Infinity;
  let busy = false;
  return async function fetchJson(url, init = {}) {
    if (busy) throw new Error("politeFetcher: one request at a time");
    busy = true;
    try {
      for (let attempt = 0; ; attempt++) {
        const wait = last + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
        last = now();
        const headers = {
          "User-Agent": userAgent(env),
          Accept: "application/json",
          ...(init.headers ?? {}),
        };
        let res;
        try {
          res = await fetchImpl(url, { ...init, headers });
        } catch (e) {
          if (attempt >= maxRetries) throw e;
          await sleep(baseBackoffMs * 2 ** attempt);
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= maxRetries)
            throw new Error(`HTTP ${res.status} after ${attempt + 1} attempts: ${url}`);
          const ra = retryAfterMs(res.headers?.get?.("retry-after"), now());
          await sleep(ra != null && ra > 0 ? ra : baseBackoffMs * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
        return await res.json();
      }
    } finally {
      busy = false;
    }
  };
}

// ---------------------------------------------------------------------------
// The Steam Web API (WU-009a3, task proposal 022). Stricter than politeFetcher:
//   - the key comes from the caller (STEAM_API_KEY, supplied by `doppler run`) and is sent only
//     as the request's key parameter; no message, error or record ever holds it or the URL;
//   - one request at a time, at least minIntervalMs apart (1000 ms or more);
//   - the first network error, non-200 status or non-JSON body stops the run: no retry. The
//     ingest is resumable, so the operator starts it again later.

export const STEAM_WEB_API = "https://api.steampowered.com";
/**
 * Network error codes a stop message may name. Anything else is reported as "unknown": an
 * exception's own fields are never copied into a message, since they could hold anything,
 * including the request URL with its key (Codex pre-dispatch review r1, finding 1).
 */
export const NETWORK_ERROR_CODES = Object.freeze([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "AbortError",
  "TimeoutError",
]);

/** The first known code on an exception or its cause, or "unknown". */
export function networkErrorCode(e) {
  for (const v of [e?.cause?.code, e?.code, e?.cause?.name, e?.name])
    if (typeof v === "string" && NETWORK_ERROR_CODES.includes(v)) return v;
  return "unknown";
}
const STEAM_METHOD = /^I[A-Za-z]+\/[A-Za-z]+\/v\d+$/;

export function steamWebApi({
  key,
  fetchImpl = globalThis.fetch,
  minIntervalMs,
  sleep = sleepMs,
  now = Date.now,
  env = process.env,
}) {
  if (typeof key !== "string" || !key.trim())
    throw new Error(
      "STEAM_API_KEY is not set: run the Steam steps under `doppler run --`; the key is never typed or printed",
    );
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 1000)
    throw new Error("the Steam Web API interval must be 1000 ms or more");
  let last = -Infinity;
  let busy = false;
  let calls = 0;
  async function call(method, params = {}) {
    if (!STEAM_METHOD.test(method)) throw new Error(`not a Steam Web API method: ${method}`);
    if (busy) throw new Error("steamWebApi: one request at a time");
    busy = true;
    try {
      const gap = last + minIntervalMs - now();
      if (gap > 0) await sleep(gap);
      last = now();
      calls++;
      const qs = new URLSearchParams({ ...params, key }).toString();
      let res;
      try {
        res = await fetchImpl(`${STEAM_WEB_API}/${method}/?${qs}`, {
          headers: { "User-Agent": userAgent(env), Accept: "application/json" },
        });
      } catch (e) {
        throw new Error(
          `Steam Web API ${method}: network error (${networkErrorCode(e)}); stopped, no retry`,
        );
      }
      if (res.status !== 200)
        throw new Error(`Steam Web API ${method}: HTTP ${res.status}; stopped, no retry`);
      try {
        return await res.json();
      } catch {
        throw new Error(`Steam Web API ${method}: the response is not JSON; stopped, no retry`);
      }
    } finally {
      busy = false;
    }
  }
  call.count = () => calls;
  return call;
}

// ---------------------------------------------------------------------------
// JSON Lines files: append-only, and resumable by key.

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${path.basename(file)}: line ${i + 1} is not JSON`);
      }
    });
}

/**
 * The resume reader for an append-only JSON Lines file. An interrupted append can leave one
 * incomplete record at the very end, with no closing newline. That fragment, and only that, is
 * cut off the file so the run can continue; every complete record is kept. A final record that
 * is complete but lacks its newline gets the newline. Any bad line before the last one is still
 * an error, as in readJsonl. Returns { records, dropped } where dropped is the fragment or null.
 */
export function resumeJsonl(file) {
  if (!existsSync(file)) return { records: [], dropped: null };
  const text = readFileSync(file, "utf8");
  if (text === "" || text.endsWith("\n")) return { records: readJsonl(file), dropped: null };
  const cut = text.lastIndexOf("\n") + 1;
  const tail = text.slice(cut);
  let complete = true;
  try {
    JSON.parse(tail);
  } catch {
    complete = false;
  }
  if (complete) {
    // Check every record first, so earlier corruption is reported with the file unchanged.
    const records = readJsonl(file);
    appendFileSync(file, "\n", "utf8");
    return { records, dropped: null };
  }
  // Check the complete part first, so earlier corruption is reported and nothing is cut.
  const records = text
    .slice(0, cut)
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${path.basename(file)}: line ${i + 1} is not JSON`);
      }
    });
  truncateSync(file, Buffer.byteLength(text.slice(0, cut), "utf8"));
  return { records, dropped: tail };
}

export function appendJsonl(file, obj) {
  appendFileSync(file, `${JSON.stringify(obj)}\n`, "utf8");
}

export function parseCliArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!(name in spec)) throw new Error(`unknown option --${name}`);
    if (spec[name] === "flag") {
      out[name] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (spec[name] === "int") {
      if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a whole number`);
      out[name] = Number(v);
    } else out[name] = v;
  }
  return out;
}
