#!/usr/bin/env node
/**
 * Enrich AppGames with direct store/review links and publisher metadata.
 *
 * Game cards previously had no external landing page, so the UI had nothing to
 * link to. This fills six columns on AppGames:
 *
 *   storeUrl     https://store.steampowered.com/app/<appid>
 *   reviewUrl    direct critic review page for the title
 *   criticScore  0-100 critic score
 *   publisher    comma-joined publishers
 *   developer    comma-joined developers
 *   headerImage  Steam capsule art
 *
 * Review source is hybrid, in priority order:
 *
 *   1. OpenCritic via RapidAPI, when OPENCRITIC_API_KEY is set in .env.
 *      Gives topCriticScore and a real opencritic.com/game/<id>/<slug> link.
 *   2. Steam's `metacritic` block, which appdetails already returns in the same
 *      request we make for developer/publisher. No extra call, no key.
 *
 * The script falls back to Steam whenever OpenCritic has no match, answers 429
 * (rate limited), answers 401/403 (missing or unsubscribed key), or the key is
 * unset. After repeated auth or rate-limit failures OpenCritic is switched off
 * for the remainder of the run so a dead key cannot cost 763 pointless
 * requests - every remaining game silently takes the Steam path.
 *
 * AppIDs are resolved exactly the way scripts/fetch_steam_tags.js does it, and
 * share its .cache/steam_appids.json, so a catalog already tagged by that
 * script resolves offline with zero extra requests.
 *
 * Usage:
 *   node scripts/enrich_game_data.js [options]
 *     --delay <ms>     delay between Steam calls        (default 1500)
 *     --oc-delay <ms>  delay between OpenCritic calls   (default 1200)
 *     --limit <n>      only process the first n games   (default all)
 *     --only-missing   skip games that already have a storeUrl
 *     --refresh        ignore caches and refetch
 *     --no-search      skip the storesearch fallback
 *     --no-opencritic  force the Steam/Metacritic path
 *     --dry-run        fetch + report, do not write to the DB
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const DB_PATH = path.join(ROOT, 'mpgl_app.db');
const CACHE_DIR = path.join(__dirname, '.cache');
const APPLIST_CACHE = path.join(CACHE_DIR, 'steam_applist.json');
const RESOLVE_CACHE = path.join(CACHE_DIR, 'steam_appids.json');
const DETAILS_CACHE = path.join(CACHE_DIR, 'steam_appdetails.json');
const OPENCRITIC_CACHE = path.join(CACHE_DIR, 'opencritic.json');
// Title -> OpenCritic game id. Kept separate from the score cache and never
// invalidated by --refresh: /game/search is capped per DAY on the BASIC plan,
// so a resolved id is the expensive part and must survive every re-run.
const OPENCRITIC_ID_CACHE = path.join(CACHE_DIR, 'opencritic_ids.json');
// Per-storefront product-URL caches, keyed by normalised title.
const STOREFRONT_CACHE = path.join(CACHE_DIR, 'storefront_urls.json');
// Nexus Mods: the full game list (one request) plus per-domain detail.
const NEXUS_LIST_CACHE = path.join(CACHE_DIR, 'nexus_games.json');
const NEXUS_DETAIL_CACHE = path.join(CACHE_DIR, 'nexus_detail.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const optNum = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};

// Steam's appdetails endpoint throttles at roughly 200 requests per 5 minutes;
// 350ms keeps us under the throttling threshold.
const DELAY_MS = optNum('delay', 350);
const OC_DELAY_MS = optNum('oc-delay', 300);
const LIMIT = optNum('limit', 0);
const REFRESH = flag('refresh');
const USE_SEARCH = !flag('no-search');
const DRY_RUN = flag('dry-run');
const ONLY_MISSING = flag('only-missing');
// Re-attempt Steam AppIDs previously cached as unresolvable (null).
const RETRY_UNRESOLVED = flag('retry-unresolved');

const USER_AGENT = 'MGPL-catalog-enricher/1.0 (personal game library tool)';

// Storefront resolution (pass 4). Comma-separated list, or --no-storefronts.
const STOREFRONT_DELAY_MS = optNum('storefront-delay', 700);
const USE_STOREFRONTS = !flag('no-storefronts');
const STOREFRONT_ONLY = (() => {
  const i = argv.indexOf('--storefronts');
  if (i < 0 || i + 1 >= argv.length) return null;
  return new Set(argv[i + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
})();

// Nexus Mods (pass 5).
const NEXUS_KEY = String(process.env.NEXUSMODS_API_KEY || '').trim();
const NEXUS_DELAY_MS = optNum('nexus-delay', 120);
const USE_NEXUS = !flag('no-nexus') && Boolean(NEXUS_KEY);

const OPENCRITIC_KEY = String(process.env.OPENCRITIC_API_KEY || '').trim();
const OPENCRITIC_HOST = 'opencritic-api.p.rapidapi.com';
const USE_OPENCRITIC = !flag('no-opencritic') && Boolean(OPENCRITIC_KEY);

// Consecutive-failure budget before we stop asking OpenCritic entirely. Auth
// errors are fatal on the first hit because they never recover mid-run.
const OC_MAX_RATE_LIMIT_STRIKES = 5;

// Scoring one game costs two calls: /game/search then /game/<id>.
const OC_CALLS_PER_GAME = 2;

// The plan's quota is small (200 requests), so spending it needs to be
// deliberate. --oc-budget caps requests for this run; the real remaining count
// from the response headers overrides it downwards when it is lower.
const OC_BUDGET = optNum('oc-budget', 0);

const oc = {
  enabled: USE_OPENCRITIC,
  offReason: flag('no-opencritic') ? '--no-opencritic'
    : (OPENCRITIC_KEY ? '' : 'OPENCRITIC_API_KEY not set'),
  strikes: 0,
  hits: 0,
  misses: 0,
  errors: 0,
  used: 0,                                   // requests spent this run
  budget: OC_BUDGET > 0 ? OC_BUDGET : Infinity,
  quotaLimit: null,                          // from x-ratelimit-requests-limit
  quotaRemaining: null,                      // from x-ratelimit-requests-remaining
  searchEnabled: true,                       // /game/search has its own DAILY cap
  searchOffReason: '',
  searches: 0,
};

/** True when there is room for one more request at all. */
function ocHasBudget(cost = OC_CALLS_PER_GAME) {
  return oc.enabled && (oc.used + cost) <= oc.budget;
}

function disableOpenCritic(reason) {
  if (!oc.enabled) return;
  oc.enabled = false;
  oc.offReason = reason;
  console.warn(`  ! OpenCritic disabled for this run: ${reason} - falling back to Steam/Metacritic`);
}

/**
 * The BASIC plan caps /game/search per day separately from the overall request
 * quota, and /game/<id> keeps working once search is exhausted. So stop
 * searching but keep scoring titles whose id we already resolved.
 */
function disableOpenCriticSearch(reason) {
  if (!oc.searchEnabled) return;
  oc.searchEnabled = false;
  oc.searchOffReason = reason;
  console.warn(`  ! OpenCritic search exhausted: ${reason}`);
  console.warn(`    still scoring titles with a cached id; re-run after the daily reset for the rest`);
}

// Columns this script owns. Added on demand so the script doubles as its own
// migration and stays safe to re-run.
const COLUMNS = [
  { name: 'storeUrl', type: 'TEXT' },
  { name: 'reviewUrl', type: 'TEXT' },
  { name: 'criticScore', type: 'INTEGER' },
  { name: 'publisher', type: 'TEXT' },
  { name: 'developer', type: 'TEXT' },
  { name: 'headerImage', type: 'TEXT' },
  { name: 'cover_url', type: 'TEXT' },
  // JSON object: { Steam: url, GOG: url, "Epic Games": url, PS5: url, ... }
  { name: 'platformStoreUrls', type: 'TEXT' },
  // Nexus Mods hub for the title, and how many mods it hosts.
  { name: 'nexusUrl', type: 'TEXT' },
  { name: 'nexusModCount', type: 'INTEGER' },
  { name: 'youtubeUrl', type: 'TEXT' },
  { name: 'ignUrl', type: 'TEXT' },
  { name: 'gamefaqsUrl', type: 'TEXT' },
];

const EDITION_NOISE = new RegExp(
  '\\b(game of the year|goty|ultimate|definitive|enhanced|complete|deluxe|premium|' +
  'remastered|remaster|redux|anniversary|collection|bundle|edition|directors cut|' +
  'director s cut|hd|the master chief collection|reloaded|rebrushed)\\b', 'g'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERROR_LOG_PATH = path.join(__dirname, 'enrichment_errors.log');

function logError(msg) {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(ERROR_LOG_PATH, `[${timestamp}] ${msg}\n`, 'utf8');
  } catch (e) {
    console.error('Failed to write to error log:', e.message);
  }
}

function readCache(file, { ignoreRefresh = false } = {}) {
  if (REFRESH && !ignoreRefresh) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.warn(`  ! could not write cache ${path.basename(file)}: ${e.message}`);
  }
}

/** GET JSON with a timeout, retries and 429 backoff. Returns null on failure. */
async function fetchJson(url, { attempts = 3, timeoutMs = 25000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.min(60000, 2000 * 2 ** attempt);
        if (attempt < attempts) {
          console.warn(`  ! HTTP ${res.status}, backing off ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || text.trim().startsWith('<')) return null; // HTML error page
      return JSON.parse(text);
    } catch (e) {
      clearTimeout(timer);
      if (attempt >= attempts) return null;
      await sleep(Math.min(15000, 800 * 2 ** attempt));
    }
  }
  return null;
}

function normTitle(s) {
  return String(s || '')
    .replace(/[‘’“”']/g, '')
    .replace(/[™®©]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripEditions(n) {
  return n
    .replace(EDITION_NOISE, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Metacritic URLs carry an affiliate querystring; store the clean page. */
function cleanReviewUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const q = s.indexOf('?');
  return q > -1 ? s.slice(0, q) : s;
}

async function loadAppListIndex() {
  let list = readCache(APPLIST_CACHE, { ignoreRefresh: true });
  if (!list) {
    console.log('Downloading Steam app list (one request, ~10MB)...');
    const json = await fetchJson('https://api.steampowered.com/ISteamApps/GetAppList/v2/', { timeoutMs: 120000 });
    list = json && json.applist && Array.isArray(json.applist.apps) ? json.applist.apps : null;
    if (!list) {
      console.warn('  ! app list unavailable; falling back to store search only');
      return { exact: new Map(), stripped: new Map(), size: 0 };
    }
    writeCache(APPLIST_CACHE, list);
  }
  const exact = new Map();
  const stripped = new Map();
  for (const app of list) {
    if (!app || !app.name || !app.appid) continue;
    const n = normTitle(app.name);
    if (!n) continue;
    // Prefer the lowest appid for a name: base games predate their packs/demos.
    if (!exact.has(n) || app.appid < exact.get(n)) exact.set(n, app.appid);
    const s = stripEditions(n);
    if (s && (!stripped.has(s) || app.appid < stripped.get(s))) stripped.set(s, app.appid);
  }
  console.log(`  indexed ${list.length} Steam apps (${exact.size} distinct names)`);
  return { exact, stripped, size: list.length };
}

async function searchAppId(title) {
  // Punctuation in the workbook titles defeats Steam's search:
  // "Brothers - A Tale of Two Sons" returns nothing while
  // "Brothers A Tale of Two Sons" returns the game. Same for "... GOTY".
  // So try the raw term first, then progressively cleaner ones.
  const want = stripEditions(normTitle(title));
  const terms = [title, normTitle(title), want]
    .map((t) => String(t || '').trim())
    .filter((t, i, a) => t && a.indexOf(t) === i);

  for (const term of terms) {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=en`;
    const json = await fetchJson(url);
    const items = json && Array.isArray(json.items) ? json.items : [];
    if (!items.length) {
      if (term !== terms[terms.length - 1]) await sleep(DELAY_MS);
      continue;
    }
    const exact = items.find((it) => stripEditions(normTitle(it.name)) === want);
    if (exact) return exact.id || null;
    // Without an exact match, only accept a close one - a bare first result
    // turns "Borderlands GOTY" into whatever Steam felt like ranking first.
    const close = bestMatch(title, items, (it) => it.name, 0.82);
    if (close) return close.id || null;
    if (term !== terms[terms.length - 1]) await sleep(DELAY_MS);
  }
  logError(`Steam storesearch: failed to resolve AppID for game "${title}"`);
  return null;
}

/** Pull the handful of fields we persist out of a full appdetails payload. */
function extractDetails(data) {
  if (!data) return null;
  const mc = data.metacritic || {};
  return {
    name: data.name || null,
    developer: Array.isArray(data.developers) && data.developers.length ? data.developers.join(', ') : null,
    publisher: Array.isArray(data.publishers) && data.publishers.length ? data.publishers.join(', ') : null,
    headerImage: data.header_image || null,
    criticScore: Number.isFinite(Number(mc.score)) ? Number(mc.score) : null,
    reviewUrl: cleanReviewUrl(mc.url),
  };
}

async function fetchAppDetails(appid, title) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;
  const json = await fetchJson(url);
  const entry = json && json[String(appid)];
  if (!entry || !entry.success || !entry.data) {
    logError(`Steam appdetails: failed to fetch details for appid ${appid} (game: "${title}")`);
    return null;
  }
  return extractDetails(entry.data);
}

/**
 * OpenCritic via RapidAPI. Status-aware, unlike fetchJson, because 401/403/429
 * each mean something different for whether we keep trying.
 * Returns { ok, status, body }.
 */
async function ocRequest(pathAndQuery, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${OPENCRITIC_HOST}${pathAndQuery}`, {
      signal: controller.signal,
      headers: {
        'X-RapidAPI-Host': OPENCRITIC_HOST,
        'X-RapidAPI-Key': OPENCRITIC_KEY,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    oc.used++;

    // RapidAPI reports the plan quota on every response; trust it over our own
    // counter and shrink the run budget so we stop before hitting a hard 429.
    const limit = Number(res.headers.get('x-ratelimit-requests-limit'));
    const remaining = Number(res.headers.get('x-ratelimit-requests-remaining'));
    if (Number.isFinite(limit) && limit > 0) oc.quotaLimit = limit;
    if (Number.isFinite(remaining) && remaining >= 0) {
      oc.quotaRemaining = remaining;
      oc.budget = Math.min(oc.budget, oc.used + remaining);
    }

    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    return { ok: res.ok, status: res.status, body, raw: text };
  } catch (e) {
    clearTimeout(timer);
    oc.used++;
    return { ok: false, status: 0, body: null, raw: String(e && e.message) };
  }
}

/**
 * Decide whether an OpenCritic response should end the run's use of the API.
 * Returns true when the caller should give up on this game and fall back.
 */
function ocHandleFailure(res, label) {
  const msg = String((res.body && res.body.message) || `HTTP ${res.status}`);

  if (res.status === 401 || res.status === 403) {
    // Bad key, or a key that is not subscribed to this API on RapidAPI.
    disableOpenCritic(`${msg} (${label})`);
    return true;
  }

  if (res.status === 429) {
    // RapidAPI reports an exhausted per-endpoint daily allowance as a 429 too.
    // Retrying cannot help until it resets, so stop immediately rather than
    // burning the strike budget on calls that are guaranteed to fail.
    if (/quota/i.test(msg)) {
      if (/search/i.test(msg)) disableOpenCriticSearch(msg);
      else disableOpenCritic(msg);
      return true;
    }
    oc.strikes++;
    if (oc.strikes >= OC_MAX_RATE_LIMIT_STRIKES) {
      disableOpenCritic(`rate limited ${oc.strikes}x (429)`);
    }
    return true;
  }

  oc.errors++;
  return true;
}

/** opencritic.com slugs are lowercase, hyphenated, alphanumeric. */
function ocSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Look a title up on OpenCritic: search for the best-matching game, then read
 * its score. Returns { criticScore, reviewUrl, source } or null to fall back.
 */
/**
 * Resolve a title to an OpenCritic game id, spending a search only when the id
 * is not already cached. Returns { id, name } , null for "searched, no match",
 * or undefined when we could not look it up at all (budget/quota).
 */
async function resolveOpenCriticId(title, idCache) {
  const key = stripEditions(normTitle(title));
  if (key && Object.prototype.hasOwnProperty.call(idCache, key)) {
    const hit = idCache[key];
    return hit ? hit : null;
  }
  if (!oc.searchEnabled || !ocHasBudget(1)) return undefined;

  const search = await ocRequest(`/game/search?criteria=${encodeURIComponent(title)}`);
  oc.searches++;
  if (!search.ok) { ocHandleFailure(search, 'search'); return undefined; }
  oc.strikes = 0;

  const items = Array.isArray(search.body) ? search.body : [];
  // The search endpoint ranks by `dist` (edit distance, 0 = exact). Prefer an
  // exact normalized match and otherwise only trust a close one, so "Hades"
  // cannot silently match "Hades II".
  const want = key;
  const exact = items.find((it) => stripEditions(normTitle(it.name)) === want);
  const best = exact || items.find((it) => Number(it.dist) <= 0.2) || null;

  const resolvedId = best && best.id ? { id: best.id, name: best.name } : null;
  if (key) idCache[key] = resolvedId;
  return resolvedId;
}

/**
 * Look a title up on OpenCritic.
 *   object    -> scored
 *   null      -> asked, and OpenCritic has no score for it (cache this)
 *   undefined -> could not ask (quota/budget/error) - do NOT cache, retry later
 */
async function fetchOpenCritic(title, idCache) {
  if (!oc.enabled) return undefined;

  const match = await resolveOpenCriticId(title, idCache);
  if (match === undefined) return undefined;        // could not search
  if (match === null) { oc.misses++; return null; } // searched, genuinely no match

  if (!ocHasBudget(1)) return undefined;
  await sleep(OC_DELAY_MS);

  const detail = await ocRequest(`/game/${encodeURIComponent(match.id)}`);
  if (!detail.ok) { ocHandleFailure(detail, 'game'); return undefined; }
  oc.strikes = 0;

  const g = detail.body || {};
  // OpenCritic uses -1 for "not enough reviews to score".
  const rawScore = Number(g.topCriticScore);
  const criticScore = Number.isFinite(rawScore) && rawScore >= 0 ? Math.round(rawScore) : null;
  if (criticScore === null) { oc.misses++; return null; }

  const slug = ocSlug(g.name || match.name || title);
  const apiUrl = typeof g.url === 'string' && /^https?:\/\//.test(g.url) ? g.url : null;
  const reviewUrl = apiUrl || `https://opencritic.com/game/${match.id}/${slug}`;

  oc.hits++;
  return { criticScore, reviewUrl, source: 'opencritic' };
}

// ---------------------------------------------------------------------------
// Storefront product-URL resolution
//
// The workbook ships a *search* URL for every ownership row (and a Google
// search for Legacy Games), so none of them land on a product page. Each
// resolver below turns a title into a direct product URL for one storefront.
//
// Endpoint choices differ from the obvious ones, for measured reasons:
//   GOG  embed.gog.com/games/ajax/filtered answers 200 with an empty product
//        list (deprecated); catalog.gog.com/v1/catalog works and even returns
//        a ready-made storeLink.
//   PSN  the GraphQL op rejects non-whitelisted queries ("Query not
//        whitelisted"), so we read the public search page and pair each result
//        anchor with its visible title.
//   RAWG api.rawg.io answers 522 (Cloudflare, service down) and needs a key,
//        so Legacy titles fall back to Steam then GOG.
// ---------------------------------------------------------------------------

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** GET a page as text, with the same retry/backoff shape as fetchJson. */
async function fetchText(url, { attempts = 2, timeoutMs = 25000, headers = {} } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': BROWSER_UA, ...headers },
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < attempts) { await sleep(Math.min(20000, 1500 * 2 ** attempt)); continue; }
        return { ok: false, status: res.status, text: '' };
      }
      if (!res.ok) return { ok: false, status: res.status, text: '' };
      return { ok: true, status: res.status, text: await res.text() };
    } catch (e) {
      clearTimeout(timer);
      if (attempt >= attempts) return { ok: false, status: 0, text: '' };
      await sleep(1000 * attempt);
    }
  }
  return { ok: false, status: 0, text: '' };
}

/**
 * How well a candidate title matches the one we asked for, 0..1.
 * Storefront search is fuzzy - "Cyberpunk 2077" returns the Phantom Liberty
 * expansion first - so every resolver scores candidates before accepting one.
 */
function titleScore(wanted, candidate) {
  const a = stripEditions(normTitle(wanted));
  const b = stripEditions(normTitle(candidate));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  if (!at.size || !bt.size) return 0;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  // Penalise candidates that add a lot of extra words (DLC / bundles / sequels).
  const coverage = shared / at.size;
  const bloat = shared / bt.size;
  return coverage * 0.7 + bloat * 0.3;
}

/** Pick the best-scoring candidate above a threshold. */
function bestMatch(wanted, candidates, getName, threshold = 0.82) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = titleScore(wanted, getName(c));
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= threshold ? best : null;
}

/** GOG -> https://www.gog.com/en/game/<slug> */
async function resolveGog(title) {
  const url = 'https://catalog.gog.com/v1/catalog'
    + `?query=like%3A${encodeURIComponent(title)}`
    + '&limit=10&locale=en-US&countryCode=US&currencyCode=USD';
  const json = await fetchJson(url);
  const products = json && Array.isArray(json.products) ? json.products : [];
  if (!products.length) return null;
  const hit = bestMatch(title, products, (p) => p.title);
  if (!hit) return null;
  if (typeof hit.storeLink === 'string' && /^https?:\/\//.test(hit.storeLink)) return hit.storeLink;
  return hit.slug ? `https://www.gog.com/en/game/${hit.slug}` : null;
}

/** Epic -> https://store.epicgames.com/p/<slug> */
async function resolveEpic(title) {
  const query = `query searchStoreQuery($keywords: String!, $country: String!, $locale: String!) {
    Catalog { searchStore(keywords: $keywords, country: $country, locale: $locale, count: 10) {
      elements { title productSlug urlSlug offerType
        catalogNs { mappings(pageType: "productHome") { pageSlug } } } } } }`;
  // This endpoint is POST-only, so it does not go through fetchText.
  let body = null;
  try {
    const r = await fetch('https://store.epicgames.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': BROWSER_UA },
      body: JSON.stringify({ query, variables: { keywords: title, country: 'US', locale: 'en-US' } }),
    });
    if (!r.ok) return null;
    body = await r.json();
  } catch (e) {
    return null;
  }

  const els = body && body.data && body.data.Catalog && body.data.Catalog.searchStore
    ? (body.data.Catalog.searchStore.elements || []) : [];
  if (!els.length) return null;

  // Prefer a base game over an edition/DLC entry for the same title.
  const base = els.filter((e) => e.offerType === 'BASE_GAME');
  const hit = bestMatch(title, base.length ? base : els, (e) => e.title);
  if (!hit) return null;

  const mapped = hit.catalogNs && Array.isArray(hit.catalogNs.mappings) && hit.catalogNs.mappings[0]
    ? hit.catalogNs.mappings[0].pageSlug : null;
  const slug = mapped || hit.productSlug || hit.urlSlug;
  if (!slug) return null;
  return `https://store.epicgames.com/p/${String(slug).replace(/^\/+/, '').split('/')[0]}`;
}

/** PlayStation -> https://store.playstation.com/en-us/{concept|product}/<id> */
async function resolvePlaystation(title) {
  const res = await fetchText(
    `https://store.playstation.com/en-us/search/${encodeURIComponent(title)}`);
  if (!res.ok) return null;

  // Each result tile is an <a href="/en-us/concept|product/..."> wrapping the
  // visible product name, so pair href with title and score the pairs.
  const candidates = [];
  const re = /<a[^>]+href="(\/en-us\/(?:concept|product)\/[^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/g;
  let m;
  while ((m = re.exec(res.text))) {
    const href = m[1];
    const inner = m[2];
    const named = /data-qa="[^"]*#product-name"[^>]*>([^<]+)</.exec(inner)
      || />([A-Za-z0-9][^<>{}]{2,80})</.exec(inner);
    if (!named) continue;
    const name = named[1]
      .replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    if (name) candidates.push({ href, name });
  }
  if (!candidates.length) return null;

  // A concept page is the canonical game hub; prefer it when one matches.
  const concepts = candidates.filter((c) => c.href.includes('/concept/'));
  const hit = bestMatch(title, concepts, (c) => c.name)
    || bestMatch(title, candidates, (c) => c.name);
  if (!hit) return null;
  return `https://store.playstation.com${hit.href}`;
}

/**
 * Legacy / retro titles. RAWG is unreachable (522) and key-gated, so try the
 * Steam AppID we already resolved, then GOG, and give up rather than emit
 * another search URL.
 */
async function resolveLegacy(title, steamUrl) {
  if (steamUrl) return steamUrl;
  const gog = await resolveGog(title);
  if (gog) return gog;
  // "CE" / "Collector's Edition" suffixes block storefront matching; retry bare.
  const bare = title.replace(/\b(ce|collector'?s edition)\b/gi, '').trim();
  if (bare && bare !== title) return await resolveGog(bare);
  return null;
}

// ---------------------------------------------------------------------------
// Nexus Mods
//
// Domain slugs are not derivable from titles - "The Witcher 3" is `witcher3`,
// "Saints Row" is `saintsrow2022`, "Strider" is `strider2014`. Guessing them
// would silently mislabel games, so the slug comes from /v1/games.json, the
// authoritative list of every game Nexus hosts (one request, ~5000 entries).
// Each matched slug is then confirmed against /v1/games/<domain>.json, which is
// also where the live mod count comes from.
// ---------------------------------------------------------------------------

const nexus = {
  enabled: USE_NEXUS,
  offReason: flag('no-nexus') ? '--no-nexus' : (NEXUS_KEY ? '' : 'NEXUSMODS_API_KEY not set'),
  requests: 0,
  hourlyRemaining: null,
  dailyRemaining: null,
};

async function nexusRequest(pathname) {
  if (!nexus.enabled) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`https://api.nexusmods.com${pathname}`, {
      signal: controller.signal,
      headers: { apikey: NEXUS_KEY, Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    clearTimeout(timer);
    nexus.requests++;

    const hourly = Number(res.headers.get('x-rl-hourly-remaining'));
    const daily = Number(res.headers.get('x-rl-daily-remaining'));
    if (Number.isFinite(hourly)) nexus.hourlyRemaining = hourly;
    if (Number.isFinite(daily)) nexus.dailyRemaining = daily;

    if (res.status === 401 || res.status === 403) {
      nexus.enabled = false;
      nexus.offReason = `HTTP ${res.status} - key rejected`;
      console.warn(`  ! Nexus disabled: ${nexus.offReason}`);
      return null;
    }
    if (res.status === 429) {
      nexus.enabled = false;
      nexus.offReason = 'rate limited (429)';
      console.warn(`  ! Nexus disabled: ${nexus.offReason}`);
      return null;
    }
    if (!res.ok) return null;                    // 404 = no such game domain
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

/** Index every Nexus game by normalised name, for exact slug resolution. */
async function loadNexusIndex() {
  let list = readCache(NEXUS_LIST_CACHE);
  if (!list) {
    console.log('  fetching Nexus game list (one request)...');
    list = await nexusRequest('/v1/games.json');
    if (!Array.isArray(list) || !list.length) {
      console.warn('  ! Nexus game list unavailable');
      return null;
    }
    writeCache(NEXUS_LIST_CACHE, list);
  }
  const exact = new Map();
  const stripped = new Map();
  for (const g of list) {
    if (!g || !g.name || !g.domain_name) continue;
    const n = normTitle(g.name);
    if (!n) continue;
    if (!exact.has(n)) exact.set(n, g);
    const s = stripEditions(n);
    if (s && !stripped.has(s)) stripped.set(s, g);
  }
  console.log(`  indexed ${list.length} Nexus games (${exact.size} distinct names)`);
  return { exact, stripped, size: list.length };
}

/**
 * Resolve one catalog title to a Nexus game. Exact-name only (after edition
 * stripping) - a fuzzy match here would claim mod support for the wrong game,
 * which is worse than reporting none.
 */
function matchNexusGame(title, index) {
  if (!index) return null;
  const n = normTitle(title);
  if (!n) return null;
  return index.exact.get(n) || index.stripped.get(stripEditions(n)) || null;
}

/** Add any missing enrichment columns to AppGames. Idempotent. */
function ensureColumns(db) {
  const info = db.prepare('PRAGMA table_info("AppGames")').all();
  const existing = new Set(info.map((c) => String(c.name).toLowerCase()));
  const added = [];
  for (const col of COLUMNS) {
    if (!existing.has(col.name.toLowerCase())) {
      db.prepare(`ALTER TABLE "AppGames" ADD COLUMN "${col.name}" ${col.type}`).run();
      added.push(col.name);
    }
  }
  if (added.length) console.log(`Schema: added ${added.length} column(s) to AppGames -> ${added.join(', ')}`);
  else console.log('Schema: AppGames already has all 6 enrichment columns');
  return added;
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // The dev API server holds its own write handle; wait it out instead of
  // failing with SQLITE_BUSY.
  db.pragma('busy_timeout = 15000');
  return db;
}

function determineLaptopPlayability(g) {
  const ally = String(g.allyPlayability || '').trim();
  if (ally.toLowerCase().includes('console exclusive')) {
    return 'Console Exclusive (PS4/PS5 Only)';
  }
  
  // High specs
  const ram = Number(g.minRam);
  const vram = Number(g.minVram);
  if (ram >= 16 || vram >= 6) {
    return 'High Spec Required';
  }
  
  // Genre-based estimation
  const genre = String(g.primaryGenre || '').toLowerCase();
  if (genre.includes('cozy') || genre.includes('puzzle') || genre.includes('visual novel') || genre.includes('turn-based')) {
    return 'Ideal';
  }
  
  return 'Playable';
}

function loadCatalog(db) {
  const games = db.prepare('SELECT "GameID" AS id, "Game Title" AS title, "storeUrl" AS storeUrl, "ROG Ally Playability" AS allyPlayability, "Primary Genre" AS primaryGenre, "Min RAM GB" AS minRam, "Min VRAM GB" AS minVram FROM "AppGames"').all();
  const ownership = db.prepare('SELECT "GameID" AS id, "Platform" AS platform, "Store URL" AS url FROM "AppOwnership"').all();
  // Same rows, but carrying the primary key so pass 4 can update them in place.
  const ownershipRows = db.prepare(
    'SELECT "OwnershipID" AS ownershipId, "GameID" AS gameId, "Platform" AS platform, "Store URL" AS url FROM "AppOwnership"'
  ).all();

  const steamOwned = new Set();
  const directAppIds = new Map();
  for (const row of ownership) {
    const id = String(row.id ?? '');
    if (!id) continue;
    if (String(row.platform || '').toLowerCase().includes('steam')) steamOwned.add(id);
    const m = /store\.steampowered\.com\/app\/(\d+)/.exec(String(row.url || ''));
    if (m) directAppIds.set(id, Number(m[1]));
  }
  return { games, steamOwned, directAppIds, ownershipRows };
}

async function run() {
  const db = openDb();
  ensureColumns(db);

  const { games, steamOwned, directAppIds, ownershipRows } = loadCatalog(db);
  let targets = games;
  if (ONLY_MISSING) targets = targets.filter((g) => !g.storeUrl);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  console.log(`Catalog: ${games.length} games (${steamOwned.size} owned on Steam), processing ${targets.length}`);
  console.log(`Delay ${DELAY_MS}ms | search fallback ${USE_SEARCH ? 'on' : 'off'}${ONLY_MISSING ? ' | only-missing' : ''}${DRY_RUN ? ' | DRY RUN' : ''}`);

  const resolveCache = readCache(RESOLVE_CACHE) || {};
  const detailsCache = readCache(DETAILS_CACHE) || {};
  const ocCache = readCache(OPENCRITIC_CACHE) || {};
  // Resolved ids are the scarce resource (daily search cap), so they survive
  // --refresh: re-scoring is cheap, re-searching may be impossible today.
  const ocIdCache = readCache(OPENCRITIC_ID_CACHE, { ignoreRefresh: true }) || {};

  // Backfill ids from any score we already stored: the review URL embeds
  // /game/<id>/<slug>, so a title scored by an earlier run never needs a
  // second search even though that run predates this cache.
  let backfilled = 0;
  for (const [key, val] of Object.entries(ocCache)) {
    if (!val || Object.prototype.hasOwnProperty.call(ocIdCache, key)) continue;
    const m = /opencritic\.com\/game\/(\d+)\/([^/?#]*)/.exec(String(val.reviewUrl || ''));
    if (!m) continue;
    ocIdCache[key] = { id: Number(m[1]), name: m[2].replace(/-/g, ' ') };
    backfilled++;
  }
  if (backfilled) console.log(`Recovered ${backfilled} OpenCritic id(s) from previously stored review URLs`);

  const stats = {
    direct: 0, exact: 0, stripped: 0, searched: 0, unresolved: 0,
    cachedDetails: 0, fetched: 0, noDetails: 0, withScore: 0,
    ocCached: 0, fromOpenCritic: 0, fromMetacritic: 0,
  };
  const resolved = new Map();

  // ---- pass 1: resolve AppIDs offline, collect the leftovers for search ----
  const needSearch = [];
  for (const g of targets) {
    const id = String(g.id);
    if (directAppIds.has(id)) { resolved.set(id, directAppIds.get(id)); stats.direct++; continue; }
    if (Object.prototype.hasOwnProperty.call(resolveCache, id)) {
      if (resolveCache[id]) { resolved.set(id, resolveCache[id]); stats.exact++; continue; }
      // A cached null is only final unless we were asked to re-attempt them.
      if (!RETRY_UNRESOLVED) { stats.unresolved++; continue; }
    }
    needSearch.push(g);
  }

  if (needSearch.length) {
    const index = await loadAppListIndex();
    const stillNeed = [];
    for (const g of needSearch) {
      const id = String(g.id);
      const n = normTitle(g.title);
      if (index.exact.has(n)) { resolved.set(id, index.exact.get(n)); resolveCache[id] = index.exact.get(n); stats.exact++; continue; }
      const s = stripEditions(n);
      if (index.stripped.has(s)) { resolved.set(id, index.stripped.get(s)); resolveCache[id] = index.stripped.get(s); stats.stripped++; continue; }
      stillNeed.push(g);
    }
    needSearch.length = 0;
    needSearch.push(...stillNeed);
  }
  console.log(`Resolved offline: ${stats.direct + stats.exact + stats.stripped} | need search: ${needSearch.length}`);

  // ---- pass 2: store search for the rest (Steam-owned titles first) ----
  if (USE_SEARCH && needSearch.length) {
    const ordered = [...needSearch].sort((a, b) => Number(steamOwned.has(String(b.id))) - Number(steamOwned.has(String(a.id))));
    let i = 0;
    for (const g of ordered) {
      i++;
      const id = String(g.id);
      const appid = await searchAppId(g.title);
      if (appid) { resolved.set(id, appid); resolveCache[id] = appid; stats.searched++; }
      else { resolveCache[id] = null; stats.unresolved++; }
      if (i % 25 === 0) {
        console.log(`  search ${i}/${ordered.length} (found ${stats.searched})`);
        writeCache(RESOLVE_CACHE, resolveCache);
      }
      await sleep(DELAY_MS);
    }
  } else {
    stats.unresolved += needSearch.length;
    for (const g of needSearch) resolveCache[String(g.id)] = null;
  }
  writeCache(RESOLVE_CACHE, resolveCache);

  // ---- pass 3: appdetails -> store link, studio, art; then reviews ----
  // OpenCritic is the primary review source and Steam/Metacritic the fallback,
  // so a title with no Steam AppID can still pick up a score from OpenCritic.
  console.log(oc.enabled
    ? `Reviews: OpenCritic primary (key loaded), Steam/Metacritic fallback`
    : `Reviews: Steam/Metacritic only (${oc.offReason})`);

  // The OpenCritic quota is far smaller than the catalog, so spend it where it
  // adds a score rather than where it merely replaces an equivalent Metacritic
  // one: titles Steam could not score go first, already-scored titles last.
  const ocQueue = new Set();
  if (oc.enabled) {
    const steamScore = (g) => {
      const appid = resolved.get(String(g.id));
      const d = appid ? detailsCache[String(appid)] : null;
      return d && d.criticScore != null ? d.criticScore : null;
    };
    const alreadyCached = (g) => {
      const k = stripEditions(normTitle(g.title));
      return k && Object.prototype.hasOwnProperty.call(ocCache, k);
    };
    // A title whose id is already cached costs 1 request instead of 2, and
    // works even after the daily search cap is hit - so queue those first.
    const idKnown = (g) => {
      const k = stripEditions(normTitle(g.title));
      return Boolean(k && ocIdCache[k]);
    };
    const pending = targets.filter((g) => !alreadyCached(g));
    const ranked = [
      ...pending.filter((g) => idKnown(g) && steamScore(g) === null),
      ...pending.filter((g) => idKnown(g) && steamScore(g) !== null),
      ...pending.filter((g) => !idKnown(g) && steamScore(g) === null),
      ...pending.filter((g) => !idKnown(g) && steamScore(g) !== null),
    ];

    // Fill the queue by actual cost rather than assuming 2 calls each.
    let cost = 0;
    for (const g of ranked) {
      const c = idKnown(g) ? 1 : OC_CALLS_PER_GAME;
      if (cost + c > oc.budget) break;
      cost += c;
      ocQueue.add(String(g.id));
    }
    console.log(`  OpenCritic queue: ${ocQueue.size} of ${pending.length} un-scored titles`
      + ` (${ranked.filter(idKnown).length} with a cached id)`
      + `${Number.isFinite(oc.budget) ? `, budget ${oc.budget} requests` : ''}`);
  }

  const enriched = new Map();
  let n = 0;
  for (const g of targets) {
    const id = String(g.id);
    const appid = resolved.get(id);
    n++;

    // --- Steam: store link, developer/publisher, art, Metacritic fallback ---
    let details = null;
    if (appid) {
      const cached = detailsCache[String(appid)];
      if (cached) {
        details = cached;
        stats.cachedDetails++;
      } else if (cached === null && !REFRESH) {
        // Cached miss (delisted/region-locked app): don't refetch every run.
        stats.noDetails++;
      } else {
        details = await fetchAppDetails(appid, g.title);
        detailsCache[String(appid)] = details;
        stats.fetched++;
        if (stats.fetched % 20 === 0) {
          writeCache(DETAILS_CACHE, detailsCache);
        }
        await sleep(DELAY_MS);
      }
      if (!details) stats.noDetails++;
    }

    // --- OpenCritic: preferred score + review link, cached by title ---
    let review = null;
    const ocKey = stripEditions(normTitle(g.title));
    if (ocKey && Object.prototype.hasOwnProperty.call(ocCache, ocKey)) {
      // A prior run already asked about this title; never spend quota twice.
      review = ocCache[ocKey];
      if (review) stats.ocCached++;
    } else if (ocKey && ocQueue.has(id) && ocHasBudget(1)) {
      const before = oc.used;
      const answer = await fetchOpenCritic(g.title, ocIdCache);
      // undefined means "could not ask" - leave it un-cached so the next run,
      // after the daily reset, tries this title again.
      if (answer !== undefined) ocCache[ocKey] = answer;
      review = answer ?? null;

      // Only pay the pacing delay when a request actually went out. Once the
      // daily search cap trips, the remaining titles short-circuit and must not
      // each cost OC_DELAY_MS of nothing.
      if (oc.used > before) {
        if ((oc.hits + oc.misses) % 10 === 0) {
          console.log(`  opencritic ${n}/${targets.length} (hits ${oc.hits}, misses ${oc.misses},`
            + ` ${oc.used} req used, ${oc.quotaRemaining ?? '?'} left on plan)`);
          writeCache(OPENCRITIC_CACHE, ocCache);
          writeCache(OPENCRITIC_ID_CACHE, ocIdCache);
        }
        await sleep(OC_DELAY_MS);
      }
    }

    // Fall back to whatever Steam gave us for this title.
    if (!review && details && details.criticScore != null) {
      review = { criticScore: details.criticScore, reviewUrl: details.reviewUrl, source: 'metacritic' };
    }

    if (review) {
      stats.withScore++;
      if (review.source === 'opencritic') stats.fromOpenCritic++;
      else stats.fromMetacritic++;
    }

    const laptopPlay = determineLaptopPlayability({
      allyPlayability: g.allyPlayability,
      primaryGenre: g.primaryGenre,
      minRam: g.minRam,
      minVram: g.minVram,
    });

    enriched.set(id, {
      storeUrl: appid ? `https://store.steampowered.com/app/${appid}` : null,
      reviewUrl: review ? review.reviewUrl : null,
      criticScore: review ? review.criticScore : null,
      publisher: details ? details.publisher : null,
      developer: details ? details.developer : null,
      headerImage: details ? details.headerImage : null,
      cover_url: appid ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900_2x.jpg` : null,
      laptopPlayability: laptopPlay,
    });

    console.log(`[${n}/${targets.length}] Processed: ${g.title}...`);
  }
  writeCache(DETAILS_CACHE, detailsCache);
  writeCache(OPENCRITIC_CACHE, ocCache);
  writeCache(OPENCRITIC_ID_CACHE, ocIdCache);

  // ---- pass 4: direct product URL per owned storefront ----
  const sfCache = readCache(STOREFRONT_CACHE) || {};
  const platformUrls = new Map();   // gameId -> { platform: url }
  const ownershipUrls = new Map();  // ownershipId -> url
  const sfStats = {};

  if (USE_STOREFRONTS) {
    // Which resolver handles which workbook platform label.
    const RESOLVERS = {
      steam: { match: (p) => p.includes('steam'), fn: null },              // already have an AppID
      gog: { match: (p) => p.includes('gog'), fn: (t) => resolveGog(t) },
      epic: { match: (p) => p.includes('epic'), fn: (t) => resolveEpic(t) },
      psn: { match: (p) => /^ps\d|playstation/.test(p), fn: (t) => resolvePlaystation(t) },
      legacy: { match: (p) => p.includes('legacy'), fn: null },            // needs the Steam URL too
    };
    const kindOf = (platform) => {
      const p = String(platform || '').toLowerCase();
      for (const [kind, r] of Object.entries(RESOLVERS)) if (r.match(p)) return kind;
      return null;
    };

    const targetIds = new Set(targets.map((g) => String(g.id)));
    const rows = ownershipRows.filter((r) => targetIds.has(String(r.gameId)));
    const titleById = new Map(games.map((g) => [String(g.id), g.title]));
    const steamUrlFor = (gameId) => {
      const e = enriched.get(String(gameId));
      if (e && e.storeUrl) return e.storeUrl;
      const appid = resolved.get(String(gameId));
      return appid ? `https://store.steampowered.com/app/${appid}` : null;
    };

    const wanted = rows.filter((r) => {
      const k = kindOf(r.platform);
      return k && (!STOREFRONT_ONLY || STOREFRONT_ONLY.has(k));
    });
    console.log('');
    console.log(`Storefronts: resolving direct product URLs for ${wanted.length} ownership rows`);

    let done = 0;
    for (const row of wanted) {
      const kind = kindOf(row.platform);
      const gameId = String(row.gameId);
      const title = titleById.get(gameId) || '';
      sfStats[kind] = sfStats[kind] || { total: 0, resolved: 0, cached: 0, failed: 0 };
      sfStats[kind].total++;
      done++;

      let url = null;
      if (kind === 'steam') {
        url = steamUrlFor(gameId);                       // free, no request
        if (url) sfStats[kind].resolved++; else sfStats[kind].failed++;
      } else {
        const key = `${kind}|${stripEditions(normTitle(title))}`;
        if (Object.prototype.hasOwnProperty.call(sfCache, key)) {
          url = sfCache[key];
          sfStats[kind].cached++;
          if (url) sfStats[kind].resolved++; else sfStats[kind].failed++;
        } else if (title) {
          try {
            url = kind === 'legacy'
              ? await resolveLegacy(title, steamUrlFor(gameId))
              : await RESOLVERS[kind].fn(title);
          } catch (e) {
            url = null;
          }
          sfCache[key] = url;
          if (url) sfStats[kind].resolved++; else sfStats[kind].failed++;
          if (done % 25 === 0) {
            const line = Object.entries(sfStats)
              .map(([k, v]) => `${k} ${v.resolved}/${v.total}`).join(', ');
            console.log(`  storefronts ${done}/${wanted.length} - ${line}`);
            writeCache(STOREFRONT_CACHE, sfCache);
          }
          await sleep(STOREFRONT_DELAY_MS);
        } else {
          sfStats[kind].failed++;
        }
      }

      if (!url) continue;
      if (row.ownershipId) ownershipUrls.set(String(row.ownershipId), url);
      if (!platformUrls.has(gameId)) platformUrls.set(gameId, {});
      platformUrls.get(gameId)[row.platform] = url;
    }
    writeCache(STOREFRONT_CACHE, sfCache);

    console.log('');
    for (const [k, v] of Object.entries(sfStats)) {
      console.log(`  ${k.padEnd(7)} ${String(v.resolved).padStart(4)}/${String(v.total).padEnd(4)} resolved`
        + ` (${v.cached} cached, ${v.failed} unresolved)`);
    }
  }

  // ---- pass 5: Nexus Mods hub + mod count ----
  const nexusByGame = new Map();
  if (USE_NEXUS) {
    console.log('');
    console.log('Nexus Mods: resolving mod hubs');
    const index = await loadNexusIndex();
    const detailCache = readCache(NEXUS_DETAIL_CACHE) || {};
    let matched = 0, confirmed = 0, cached = 0, unmatched = 0;

    for (const g of targets) {
      if (!nexus.enabled) break;
      const hit = matchNexusGame(g.title, index);
      if (!hit) { unmatched++; continue; }
      matched++;

      const domain = hit.domain_name;
      let detail = detailCache[domain];
      if (detail !== undefined) {
        cached++;
      } else {
        // Confirm the slug really resolves, and take the live mod count.
        detail = await nexusRequest(`/v1/games/${encodeURIComponent(domain)}.json`);
        detailCache[domain] = detail || null;
        if (matched % 50 === 0) {
          console.log(`  nexus ${matched} matched, ${nexus.requests} requests`
            + `, ${nexus.hourlyRemaining ?? '?'} left this hour`);
          writeCache(NEXUS_DETAIL_CACHE, detailCache);
        }
        await sleep(NEXUS_DELAY_MS);
      }
      if (!detail) continue;                     // slug did not resolve
      confirmed++;

      const modCount = Number(detail.mods);
      nexusByGame.set(String(g.id), {
        nexusUrl: detail.nexusmods_url || `https://www.nexusmods.com/${domain}`,
        nexusModCount: Number.isFinite(modCount) ? modCount : null,
      });
    }
    writeCache(NEXUS_DETAIL_CACHE, detailCache);

    console.log(`  matched ${matched}/${targets.length} titles to a Nexus game`
      + ` (${confirmed} confirmed, ${cached} from cache, ${unmatched} not on Nexus)`);
    console.log(`  ${nexus.requests} Nexus requests`
      + `${nexus.hourlyRemaining != null ? `, ${nexus.hourlyRemaining} left this hour / ${nexus.dailyRemaining} today` : ''}`
      + `${nexus.enabled ? '' : ` (off: ${nexus.offReason})`}`);
  } else {
    console.log('');
    console.log(`Nexus Mods: skipped (${nexus.offReason})`);
  }

  console.log('');
  console.log('Resolution: ' + JSON.stringify(stats));
  console.log(`OpenCritic: ${oc.hits} scored, ${oc.misses} no-match, ${oc.errors} errors,`
    + ` ${stats.ocCached} from cache | ${oc.used} requests used (${oc.searches} searches)`
    + `${oc.quotaRemaining != null ? `, ${oc.quotaRemaining}/${oc.quotaLimit ?? '?'} left on plan` : ''}`
    + `${oc.enabled ? '' : ` (off: ${oc.offReason})`}`
    + `${oc.enabled && !oc.searchEnabled ? ` (search capped: ${oc.searchOffReason})` : ''}`);
  console.log(`  ${Object.keys(ocIdCache).length} OpenCritic ids cached for future runs`);
  console.log(`Games enriched: ${enriched.size} / ${targets.length} (${stats.withScore} with a critic score)`);

  if (DRY_RUN) {
    console.log('\nDry run - database untouched. Sample:');
    for (const [id, v] of [...enriched].slice(0, 10)) {
      const g = games.find((x) => String(x.id) === id);
      console.log(`  ${(g ? g.title : id).slice(0, 34).padEnd(34)} ${String(v.criticScore ?? '--').padStart(3)}  ${v.storeUrl}`);
    }
    db.close();
    return;
  }

  // COALESCE so a partial run (e.g. OpenCritic up but Steam call failed) tops
  // up columns instead of blanking ones an earlier run already filled.
  const update = db.prepare(`
    UPDATE "AppGames"
       SET "storeUrl"    = COALESCE(@storeUrl,    "storeUrl"),
           "reviewUrl"   = COALESCE(@reviewUrl,   "reviewUrl"),
           "criticScore" = COALESCE(@criticScore, "criticScore"),
           "publisher"   = COALESCE(@publisher,   "publisher"),
           "developer"   = COALESCE(@developer,   "developer"),
           "headerImage" = COALESCE(@headerImage, "headerImage"),
           "cover_url"   = COALESCE(@cover_url,   "cover_url"),
           "Laptop Playability" = COALESCE("Laptop Playability", @laptopPlayability)
      WHERE "GameID" = @id
  `);

  const updatePlatformUrls = db.prepare(
    'UPDATE "AppGames" SET "platformStoreUrls" = @json WHERE "GameID" = @id');
  const updateNexus = db.prepare(
    'UPDATE "AppGames" SET "nexusUrl" = @nexusUrl, "nexusModCount" = @nexusModCount WHERE "GameID" = @id');
  const updateOwnership = db.prepare(
    'UPDATE "AppOwnership" SET "Store URL" = @url WHERE "OwnershipID" = @ownershipId');
  const updateGuides = db.prepare(
    'UPDATE "AppGames" SET "youtubeUrl" = @youtubeUrl, "ignUrl" = @ignUrl, "gamefaqsUrl" = @gamefaqsUrl WHERE "GameID" = @id');

  const write = db.transaction(() => {
    let rows = 0;
    for (const [id, v] of enriched) {
      rows += update.run({ id, ...v }).changes;
    }
    // Merge with whatever is already stored so a --storefronts=gog run does not
    // drop the Epic/PSN links a previous run resolved.
    const existingJson = new Map(db.prepare(
      'SELECT "GameID" AS id, "platformStoreUrls" AS json FROM "AppGames" WHERE "platformStoreUrls" IS NOT NULL'
    ).all().map((r) => [String(r.id), r.json]));

    let platformRows = 0;
    for (const [id, map] of platformUrls) {
      let merged = map;
      const prev = existingJson.get(String(id));
      if (prev) {
        try { merged = { ...JSON.parse(prev), ...map }; } catch (e) { merged = map; }
      }
      platformRows += updatePlatformUrls.run({ id, json: JSON.stringify(merged) }).changes;
    }

    let ownershipRowsWritten = 0;
    for (const [ownershipId, url] of ownershipUrls) {
      ownershipRowsWritten += updateOwnership.run({ ownershipId, url }).changes;
    }

    let nexusRows = 0;
    for (const [id, v] of nexusByGame) {
      nexusRows += updateNexus.run({ id, ...v }).changes;
    }

    let guideRows = 0;
    for (const g of games) {
      const id = String(g.id);
      const title = g.title || '';
      guideRows += updateGuides.run({
        id,
        youtubeUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(title + " walkthrough")}`,
        ignUrl: `https://www.ign.com/search?q=${encodeURIComponent(title + " walkthrough")}`,
        gamefaqsUrl: `https://gamefaqs.gamespot.com/search?game=${encodeURIComponent(title)}`,
      }).changes;
    }

    return { rows, platformRows, ownershipRowsWritten, nexusRows, guideRows };
  });

  const { rows, platformRows, ownershipRowsWritten, nexusRows, guideRows } = write();

  const summary = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN "storeUrl"    IS NOT NULL THEN 1 ELSE 0 END) AS withStore,
           SUM(CASE WHEN "reviewUrl"   IS NOT NULL THEN 1 ELSE 0 END) AS withReview,
           SUM(CASE WHEN "criticScore" IS NOT NULL THEN 1 ELSE 0 END) AS withScore,
           SUM(CASE WHEN "developer"   IS NOT NULL THEN 1 ELSE 0 END) AS withDev,
           SUM(CASE WHEN "reviewUrl" LIKE '%opencritic.com%' THEN 1 ELSE 0 END) AS viaOpenCritic,
           SUM(CASE WHEN "reviewUrl" LIKE '%metacritic.com%' THEN 1 ELSE 0 END) AS viaMetacritic,
           SUM(CASE WHEN "nexusUrl" IS NOT NULL THEN 1 ELSE 0 END) AS withNexus,
           SUM(CASE WHEN "nexusModCount" > 0 THEN 1 ELSE 0 END) AS withMods
      FROM "AppGames"
  `).get();

  // A "direct" URL points at one product; anything with a search path or query
  // is still a lookup page and has not really been enriched.
  const quality = db.prepare(`
    SELECT "Platform" AS platform,
           COUNT(*) AS total,
           SUM(CASE WHEN "Store URL" LIKE '%/search%' OR "Store URL" LIKE '%?q=%'
                     OR "Store URL" LIKE '%query=%'  OR "Store URL" LIKE '%term=%'
                     OR "Store URL" LIKE '%google.com%'
                    THEN 0 ELSE 1 END) AS direct
      FROM "AppOwnership" GROUP BY "Platform" ORDER BY total DESC
  `).all();

  db.close();

  console.log('');
  console.log(`Updated ${rows} rows in AppGames`);
  console.log(`  storeUrl    ${summary.withStore}/${summary.total}`);
  console.log(`  reviewUrl   ${summary.withReview}/${summary.total}`);
  console.log(`  criticScore ${summary.withScore}/${summary.total}`);
  console.log(`  developer   ${summary.withDev}/${summary.total}`);
  console.log(`  review source: ${summary.viaOpenCritic} OpenCritic / ${summary.viaMetacritic} Metacritic`);
  console.log(`  platformStoreUrls written for ${platformRows} games`);
  console.log(`  AppOwnership "Store URL" updated on ${ownershipRowsWritten} rows`);
  console.log(`  nexusUrl written for ${nexusRows} games`
    + ` (${summary.withNexus}/${summary.total} total, ${summary.withMods} with at least one mod)`);
  console.log(`  guide URLs (YouTube, IGN, GameFAQs) written for ${guideRows} games`);

  console.log('');
  console.log('  Direct product URLs per platform:');
  for (const q of quality) {
    console.log(`    ${String(q.platform).padEnd(14)} ${String(q.direct).padStart(4)}/${String(q.total).padEnd(4)}`);
  }
}

run().catch((e) => {
  console.error('enrich_game_data failed:', e);
  process.exit(1);
});
