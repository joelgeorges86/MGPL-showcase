#!/usr/bin/env node
/**
 * Populate AppGenres / AppGameGenreMap with official Steam user tags.
 *
 * The catalog's AppOwnership."Store URL" holds Steam *search* URLs
 * (store.steampowered.com/search/?term=...), not /app/<id>/ pages, so there is
 * no AppID to scrape. AppIDs are instead resolved by name against Steam's
 * official app list, with the store search endpoint as a per-title fallback.
 *
 * Pipeline:
 *   1. read games + ownership from mpgl_app.db
 *   2. resolve a Steam AppID per game (applist index -> storesearch fallback)
 *   3. pull popular tags from SteamSpy appdetails
 *   4. rebuild AppGenres / AppGameGenreMap, keeping the existing heuristic tags
 *      for anything that could not be resolved (non-Steam / delisted titles)
 *
 * Usage:
 *   node scripts/fetch_steam_tags.js [options]
 *     --delay <ms>     delay between API calls          (default 300)
 *     --limit <n>      only process the first n games   (default all)
 *     --max-tags <n>   tags kept per game               (default 12)
 *     --refresh        ignore caches and refetch
 *     --no-search      skip the storesearch fallback
 *     --dry-run        fetch + report, do not write to the DB
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'mpgl_app.db');
const CACHE_DIR = path.join(__dirname, '.cache');
const TAG_CACHE = path.join(CACHE_DIR, 'steam_tags.json');
const APPLIST_CACHE = path.join(CACHE_DIR, 'steam_applist.json');
const RESOLVE_CACHE = path.join(CACHE_DIR, 'steam_appids.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const optNum = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};

const DELAY_MS = optNum('delay', 300);
const LIMIT = optNum('limit', 0);
const MAX_TAGS = optNum('max-tags', 12);
const REFRESH = flag('refresh');
const USE_SEARCH = !flag('no-search');
const DRY_RUN = flag('dry-run');

const USER_AGENT = 'MGPL-catalog-tagger/1.0 (personal game library tool)';

// Steam tags that describe how you buy/play rather than what the game is.
const TAG_DENYLIST = new Set([
  'singleplayer', 'single-player', 'multiplayer', 'online co-op', 'local co-op',
  'co-op', 'pvp', 'local multiplayer', 'split screen', 'mmo', 'massively multiplayer',
  'great soundtrack', 'steam workshop', 'workshop', 'early access', 'free to play',
  'vr', 'controller', 'full controller support', 'steam achievements',
  'steam trading cards', 'steam cloud', 'remote play together', 'moddable',
  'sexual content', 'nudity', 'gore', 'violent', 'mature', 'nsfw',
  'classic', 'cult classic', 'masterpiece', 'addictive', 'replay value',
  'games workshop', 'benchmark', 'demo', 'soundtrack', 'utilities',
]);

// Genre-defining tags are kept even when they rank below the top-N cutoff.
// Without this, Dragon Age: Inquisition loses "Action RPG" (its 14th tag).
const PRIORITY_TAGS = new Set([
  'rpg', 'action rpg', 'jrpg', 'crpg', 'wrpg', 'turn-based rpg', 'party-based rpg',
  'tactical rpg', 'action', 'adventure', 'action-adventure', 'open world',
  'story rich', 'atmospheric', 'strategy', 'turn-based strategy', 'real time strategy',
  'rts', 'grand strategy', '4x', 'tactical', 'turn-based tactics', 'turn-based',
  'city builder', 'base building', 'building', 'colony sim', 'management',
  'simulation', 'life sim', 'farming sim', 'automation',
  'roguelike', 'roguelite', 'deckbuilding', 'card game', 'puzzle', 'platformer',
  '2d platformer', '3d platformer', 'precision platformer', 'metroidvania',
  'fps', 'first-person shooter', 'third-person shooter', 'shooter', 'looter shooter',
  'horror', 'survival horror', 'psychological horror', 'survival', 'souls-like',
  'hack and slash', 'beat em up', "beat 'em up", 'fighting', 'racing', 'sports',
  'visual novel', 'interactive fiction', 'point & click', 'walking simulator',
  'stealth', 'immersive sim', 'sandbox', 'exploration', 'dungeon crawler',
  'bullet hell', 'shoot em up', "shoot 'em up", 'rhythm', 'party game', 'casual',
  'cozy', 'wholesome', 'narrative', 'choices matter', 'detective', 'mystery',
]);

// SteamSpy returns a few tags under more than one spelling; fold them together
// so the filter dropdown does not show "Rogue-like" and "Roguelike" separately.
const TAG_ALIASES = new Map([
  ['rogue-like', 'Roguelike'],
  ['rogue like', 'Roguelike'],
  ['rogue-lite', 'Roguelite'],
  ['rogue lite', 'Roguelite'],
  ['beat em up', "Beat 'em up"],
  ["beat 'em up", "Beat 'em up"],
  ['shoot em up', "Shoot 'em up"],
  ["shoot 'em up", "Shoot 'em up"],
  ['first-person shooter', 'FPS'],
  ['real-time strategy', 'RTS'],
  ['real time strategy', 'RTS'],
  ['turn based strategy', 'Turn-Based Strategy'],
  ['turn based tactics', 'Turn-Based Tactics'],
  ['action rpg', 'Action RPG'],
  ['action roguelike', 'Action Roguelike'],
  ['story rich', 'Story Rich'],
  ['open world', 'Open World'],
]);

function canonicalTag(name) {
  const key = String(name || '').trim().toLowerCase();
  return TAG_ALIASES.get(key) || String(name || '').trim();
}

const EDITION_NOISE = new RegExp(
  '\\b(game of the year|goty|ultimate|definitive|enhanced|complete|deluxe|premium|' +
  'remastered|remaster|redux|anniversary|collection|bundle|edition|directors cut|' +
  'director s cut|hd|the master chief collection|reloaded|rebrushed)\\b', 'g'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCache(file) {
  if (REFRESH) return null;
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
        const backoff = Math.min(30000, 1000 * 2 ** attempt);
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

/** Pick the tags to keep: top-N by votes, plus any genre-defining tag at any rank. */
function selectTags(tagsObj) {
  const entries = Object.entries(tagsObj || {})
    .filter(([name, votes]) => name && Number(votes) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) return [];

  const allowed = entries
    .map(([name, votes]) => [canonicalTag(name), votes])
    .filter(([name]) => name && !TAG_DENYLIST.has(name.toLowerCase()));

  const kept = [];
  const seen = new Set();
  const push = (name) => {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    kept.push(name);
  };

  for (const [name] of allowed.slice(0, MAX_TAGS)) push(name);
  for (const [name] of allowed) {
    if (PRIORITY_TAGS.has(name.toLowerCase())) push(name);
  }
  return kept;
}

async function loadAppListIndex() {
  let list = readCache(APPLIST_CACHE);
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
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&cc=us&l=en`;
  const json = await fetchJson(url);
  const items = json && Array.isArray(json.items) ? json.items : [];
  if (!items.length) return null;
  const want = stripEditions(normTitle(title));
  const exact = items.find((it) => stripEditions(normTitle(it.name)) === want);
  return (exact || items[0]).id || null;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const games = db.prepare('SELECT "GameID" AS id, "Game Title" AS title, "Primary Genre" AS bucket FROM "AppGames"').all();
  const ownership = db.prepare('SELECT "GameID" AS id, "Platform" AS platform, "Store URL" AS url FROM "AppOwnership"').all();

  const steamOwned = new Set();
  const directAppIds = new Map();
  for (const row of ownership) {
    const id = String(row.id ?? '');
    if (!id) continue;
    if (String(row.platform || '').toLowerCase().includes('steam')) steamOwned.add(id);
    // Honour a real /app/<id>/ URL if the workbook ever gains one.
    const m = /store\.steampowered\.com\/app\/(\d+)/.exec(String(row.url || ''));
    if (m) directAppIds.set(id, Number(m[1]));
  }

  // Existing heuristic tags, kept as the fallback for anything unresolved.
  let existing = new Map();
  try {
    const rows = db.prepare(
      'SELECT m."GameID" AS id, n."GenreName" AS name FROM "AppGameGenreMap" m ' +
      'JOIN "AppGenres" n ON n."GenreID" = m."GenreID"'
    ).all();
    for (const r of rows) {
      const k = String(r.id);
      if (!existing.has(k)) existing.set(k, []);
      existing.get(k).push(r.name);
    }
  } catch (e) {
    console.log('  (no existing genre tables to preserve)');
  }

  return { db, games, steamOwned, directAppIds, existing };
}

async function run() {
  const { db, games, steamOwned, directAppIds, existing } = main();
  const targets = LIMIT > 0 ? games.slice(0, LIMIT) : games;

  console.log(`Catalog: ${games.length} games (${steamOwned.size} owned on Steam), processing ${targets.length}`);
  console.log(`Delay ${DELAY_MS}ms | max ${MAX_TAGS} tags | search fallback ${USE_SEARCH ? 'on' : 'off'}${DRY_RUN ? ' | DRY RUN' : ''}`);

  const index = await loadAppListIndex();
  const resolveCache = readCache(RESOLVE_CACHE) || {};
  const tagCache = readCache(TAG_CACHE) || {};

  const stats = { direct: 0, exact: 0, stripped: 0, searched: 0, unresolved: 0, cachedTags: 0, fetched: 0, noTags: 0 };
  const resolved = new Map();

  // ---- pass 1: resolve AppIDs offline, collect the leftovers for search ----
  const needSearch = [];
  for (const g of targets) {
    const id = String(g.id);
    if (directAppIds.has(id)) { resolved.set(id, directAppIds.get(id)); stats.direct++; continue; }
    if (Object.prototype.hasOwnProperty.call(resolveCache, id)) {
      if (resolveCache[id]) { resolved.set(id, resolveCache[id]); stats.exact++; }
      else stats.unresolved++;
      continue;
    }
    const n = normTitle(g.title);
    if (index.exact.has(n)) { resolved.set(id, index.exact.get(n)); resolveCache[id] = index.exact.get(n); stats.exact++; continue; }
    const s = stripEditions(n);
    if (index.stripped.has(s)) { resolved.set(id, index.stripped.get(s)); resolveCache[id] = index.stripped.get(s); stats.stripped++; continue; }
    needSearch.push(g);
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

  // ---- pass 3: SteamSpy tags ----
  const tagsByGame = new Map();
  let n = 0;
  for (const g of targets) {
    const id = String(g.id);
    const appid = resolved.get(id);
    if (!appid) continue;
    n++;

    let tags = tagCache[String(appid)];
    if (tags) {
      stats.cachedTags++;
    } else {
      const json = await fetchJson(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`);
      tags = json && json.tags && !Array.isArray(json.tags) ? json.tags : {};
      tagCache[String(appid)] = tags;
      stats.fetched++;
      if (stats.fetched % 25 === 0) {
        console.log(`  tags ${n}/${resolved.size} (fetched ${stats.fetched}, cached ${stats.cachedTags})`);
        writeCache(TAG_CACHE, tagCache);
      }
      await sleep(DELAY_MS);
    }

    const selected = selectTags(tags);
    if (selected.length) tagsByGame.set(id, selected);
    else stats.noTags++;
  }
  writeCache(TAG_CACHE, tagCache);

  console.log('');
  console.log('Resolution: ' + JSON.stringify(stats));
  console.log(`Games with Steam tags: ${tagsByGame.size} / ${targets.length}`);

  if (DRY_RUN) {
    console.log('\nDry run - database untouched. Sample:');
    for (const [id, tags] of [...tagsByGame].slice(0, 10)) {
      const g = games.find((x) => String(x.id) === id);
      console.log(`  ${(g ? g.title : id).slice(0, 40).padEnd(40)} ${tags.join(', ')}`);
    }
    db.close();
    return;
  }

  // ---- write: Steam tags where we have them, prior heuristic tags otherwise ----
  const finalTags = new Map();
  let fellBack = 0;
  for (const g of games) {
    const id = String(g.id);
    if (tagsByGame.has(id)) finalTags.set(id, tagsByGame.get(id));
    else if (existing.has(id)) { finalTags.set(id, existing.get(id)); fellBack++; }
  }

  const write = db.transaction(() => {
    // Rebuild so the stricter AUTOINCREMENT / NOT NULL DDL is actually applied
    // to databases created by the older seeder.
    db.exec('DROP TABLE IF EXISTS "AppGameGenreMap"');
    db.exec('DROP TABLE IF EXISTS "AppGenres"');
    db.exec(`CREATE TABLE "AppGenres" (
      "GenreID" INTEGER PRIMARY KEY AUTOINCREMENT,
      "GenreName" TEXT UNIQUE NOT NULL
    )`);
    db.exec(`CREATE TABLE "AppGameGenreMap" (
      "GameID" TEXT NOT NULL,
      "GenreID" INTEGER NOT NULL,
      PRIMARY KEY ("GameID", "GenreID")
    )`);

    const insGenre = db.prepare('INSERT OR IGNORE INTO "AppGenres" ("GenreName") VALUES (?)');
    const allTags = [...new Set([...finalTags.values()].flat())].sort((a, b) => a.localeCompare(b));
    for (const t of allTags) insGenre.run(t);

    const ids = new Map(
      db.prepare('SELECT "GenreID" AS gid, "GenreName" AS name FROM "AppGenres"').all().map((r) => [r.name, r.gid])
    );
    const insMap = db.prepare('INSERT OR IGNORE INTO "AppGameGenreMap" ("GameID", "GenreID") VALUES (?, ?)');
    let pairs = 0;
    for (const [gameId, tags] of finalTags) {
      for (const t of tags) {
        const gid = ids.get(t);
        if (gid) { insMap.run(gameId, gid); pairs++; }
      }
    }
    return { genres: allTags.length, pairs };
  });

  const { genres, pairs } = write();
  db.close();

  console.log('');
  console.log(`Wrote ${genres} genres to AppGenres`);
  console.log(`Wrote ${pairs} rows to AppGameGenreMap`);
  console.log(`  ${tagsByGame.size} games tagged from Steam, ${fellBack} kept prior heuristic tags`);
  console.log(`  ${games.length - finalTags.size} games with no tags at all`);
}

run().catch((e) => {
  console.error('fetch_steam_tags failed:', e);
  process.exit(1);
});
