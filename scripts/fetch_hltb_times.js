#!/usr/bin/env node
/**
 * Fetch HowLongToBeat (HLTB) estimates for catalog games and store in SQLite.
 * Targets unplayed/unstarted games, caches results in scripts/.cache/hltb_estimates.json.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'mpgl_app.db');
const CACHE_DIR = path.join(__dirname, '.cache');
const ESTIMATES_CACHE = path.join(CACHE_DIR, 'hltb_estimates.json');
const ERROR_LOG_PATH = path.join(ROOT, 'scripts', 'dlc_hltb_errors.log');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logError(msg) {
  try {
    const timestamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
    fs.appendFileSync(ERROR_LOG_PATH, `[${timestamp}] [HLTB] ${msg}\n`, 'utf8');
  } catch (e) {
    console.error('Failed to write to error log:', e.message);
  }
}

function readCache(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    logError(`Cache read error: ${e.message}`);
  }
  return {};
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`! Could not write cache: ${e.message}`);
  }
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

/**
 * Initialize search security by hitting the /api/bleed/init endpoint.
 */
async function initHltbSecurity() {
  const fetch = (await import('node-fetch')).default;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://howlongtobeat.com/api/bleed/init?t=' + Date.now(), {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': 'https://howlongtobeat.com/'
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.token && data.hpKey && data.hpVal) {
          return data;
        }
      }
      console.warn(`! HLTB init failed with status ${res.status}, attempt ${attempt}/3`);
      await sleep(1500 * attempt);
    } catch (e) {
      console.warn(`! HLTB init error: ${e.message}, attempt ${attempt}/3`);
      await sleep(1500 * attempt);
    }
  }
  return null;
}

/**
 * Search game on HLTB
 */
async function searchHltb(title, security) {
  const fetch = (await import('node-fetch')).default;
  const body = {
    searchType: 'games',
    searchTerms: [title],
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: '',
        sortCategory: 'popular',
        rangeCategory: 'main',
        rangeTime: { min: null, max: null },
        gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
        rangeYear: { min: '', max: '' },
        modifier: ''
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sortCategory: 'popular',
      randomizer: 0
    },
    useCache: true
  };

  if (security.hpKey && security.hpVal) {
    body[security.hpKey] = security.hpVal;
  }

  const res = await fetch('https://howlongtobeat.com/api/bleed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Referer': 'https://howlongtobeat.com/',
      'x-auth-token': security.token,
      'x-hp-key': security.hpKey,
      'x-hp-val': security.hpVal
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('403_EXPIRED');
    }
    throw new Error(`HTTP_${res.status}`);
  }

  return await res.json();
}

async function run() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');

  // Load estimates cache
  const cache = readCache(ESTIMATES_CACHE);

  // Load unplayed/unstarted games (Hours Played = null or 0, or Play Status = "Not Started")
  const query = `
    SELECT g.GameID AS id, g."Game Title" AS title 
    FROM AppGames g
    LEFT JOIN AppTracking t ON g.GameID = t.GameID
    WHERE t."Play Status" = 'Not Started' OR t."Hours Played" IS NULL OR t."Hours Played" <= 0
    LIMIT 5
  `;
  const games = db.prepare(query).all();
  console.log(`[HLTB] Found ${games.length} unplayed games in catalog.`);

  let security = await initHltbSecurity();
  if (!security) {
    console.error('[HLTB] FAILED to initialize HLTB security. Exiting.');
    logError('Failed to initialize search security at startup.');
    return;
  }
  console.log('[HLTB] HLTB security initialized successfully.');

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  for (const game of games) {
    processed++;
    const title = game.title;
    const norm = normTitle(title);

    // Check cache first
    if (cache[norm]) {
      skipped++;
      // Sync from cache to DB to be absolutely sure the DB is updated
      const est = cache[norm];
      if (est && est.main_story_hours !== undefined) {
        db.prepare(`
          UPDATE AppCompletionRoadmap 
          SET main_story_hours = ?, completionist_hours = ?, "Main Story Time" = ?, "Estimated 100% Completion Time" = ?
          WHERE GameID = ?
        `).run(est.main_story_hours, est.completionist_hours, est.main_story_hours ? `${est.main_story_hours} hrs` : null, est.completionist_hours ? `${est.completionist_hours} hrs` : null, game.id);
      }
      continue;
    }

    console.log(`[HLTB] [${processed}/${games.length}] Fetching: "${title}"`);
    
    // Strict rate limiting delay between 400ms and 600ms
    const delay = Math.floor(Math.random() * 200) + 400;
    await sleep(delay);

    try {
      let results;
      try {
        results = await searchHltb(title, security);
      } catch (err) {
        if (err.message === '403_EXPIRED') {
          console.log('[HLTB] Security token expired. Re-initializing...');
          security = await initHltbSecurity();
          if (!security) {
            throw new Error('Failed to re-initialize HLTB security.');
          }
          results = await searchHltb(title, security);
        } else {
          throw err;
        }
      }

      const list = results && Array.isArray(results.data) ? results.data : [];
      if (list.length === 0) {
        logError(`No HLTB results found for game: "${title}"`);
        cache[norm] = { main_story_hours: null, completionist_hours: null, notFound: true };
        writeCache(ESTIMATES_CACHE, cache);
        continue;
      }

      // Find best match by title
      const wantNorm = norm;
      const best = list.find(item => normTitle(item.game_name) === wantNorm) || list[0];

      if (best) {
        // times are in seconds, convert to hours (rounded to 1 decimal place)
        const mainHours = best.comp_main ? Math.round((best.comp_main / 3600) * 10) / 10 : null;
        const compHours = best.comp_100 ? Math.round((best.comp_100 / 3600) * 10) / 10 : null;

        cache[norm] = {
          main_story_hours: mainHours,
          completionist_hours: compHours,
          hltb_id: best.game_id,
          game_name: best.game_name
        };
        writeCache(ESTIMATES_CACHE, cache);

        // Update database
        db.prepare(`
          UPDATE AppCompletionRoadmap 
          SET main_story_hours = ?, completionist_hours = ?, "Main Story Time" = ?, "Estimated 100% Completion Time" = ?
          WHERE GameID = ?
        `).run(mainHours, compHours, mainHours ? `${mainHours} hrs` : null, compHours ? `${compHours} hrs` : null, game.id);

        console.log(`  -> Match: "${best.game_name}" | Main: ${mainHours}h, Comp: ${compHours}h`);
        updated++;
      } else {
        logError(`No matching HLTB entry found for: "${title}"`);
        cache[norm] = { main_story_hours: null, completionist_hours: null, notFound: true };
        writeCache(ESTIMATES_CACHE, cache);
      }
    } catch (e) {
      console.error(`! Failed fetching HLTB for "${title}": ${e.message}`);
      logError(`Network/parsing timeout or error for game "${title}": ${e.message}`);
    }
  }

  console.log(`[HLTB] Completed run. Updated: ${updated}, Skipped (Cached): ${skipped}, Total games: ${games.length}`);
}

run().catch(console.error);
