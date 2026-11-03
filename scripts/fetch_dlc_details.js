#!/usr/bin/env node
/**
 * Fetch DLC details for catalog games from Steam and cache in scripts/.cache/dlc_details.json.
 * Calculates Completion Friction Scores and stores results in mpgl_app.db.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'mpgl_app.db');
const CACHE_DIR = path.join(__dirname, '.cache');
const APPIDS_CACHE = path.join(CACHE_DIR, 'steam_appids.json');
const DLC_CACHE = path.join(CACHE_DIR, 'dlc_details.json');
const ERROR_LOG_PATH = path.join(ROOT, 'scripts', 'dlc_hltb_errors.log');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logError(msg) {
  try {
    const timestamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
    fs.appendFileSync(ERROR_LOG_PATH, `[${timestamp}] [DLC] ${msg}\n`, 'utf8');
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

function classifyDlc(name, description) {
  const text = `${name} ${description || ''}`.toLowerCase();
  // story/expansion keywords
  const storyKeywords = ['story', 'campaign', 'expansion', 'mission', 'quest', 'narrative', 'episode', 'expansion pack', 'adventure', 'addon', 'add-on', 'pack of missions', 'new zone', 'new region'];
  // cosmetic keywords
  const cosmeticKeywords = ['skin', 'pack', 'soundtrack', 'music', 'artbook', 'weapon', 'outfit', 'cosmetic', 'color', 'theme', 'digital art', 'poster', 'dlc pack', 'bundle', 'pass', 'customize', 'customisation', 'voice', 'announcer', 'sticker'];
  
  let storyScore = 0;
  let cosmeticScore = 0;
  
  for (const kw of storyKeywords) {
    if (text.includes(kw)) storyScore += 2;
  }
  for (const kw of cosmeticKeywords) {
    if (text.includes(kw)) cosmeticScore += 2;
  }
  
  // default fallback
  if (storyScore === 0 && cosmeticScore === 0) {
    return 'cosmetic';
  }
  
  return storyScore >= cosmeticScore ? 'story' : 'cosmetic';
}

async function fetchJson(url) {
  const fetch = (await import('node-fetch')).default;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        }
      });
      if (res.status === 429) {
        const backoff = Math.min(60000, 3000 * 2 ** attempt);
        console.warn(`  ! Steam rate limit (429). Backing off for ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1500 * attempt);
    }
  }
  return null;
}

async function run() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');

  const appids = readCache(APPIDS_CACHE);
  const dlcCache = readCache(DLC_CACHE);

  // Get games list from database
  const query = `
    SELECT "GameID" AS id, "Game Title" AS title 
    FROM AppGames
    LIMIT 5
  `;
  const games = db.prepare(query).all();
  console.log(`[DLC] Processing ${games.length} games for DLC enrichment.`);

  let updated = 0;

  for (const game of games) {
    const appid = appids[game.id];
    if (!appid) {
      console.log(`[DLC] No Steam AppID for "${game.title}". Skipping.`);
      continue;
    }

    console.log(`[DLC] Fetching DLCs for: "${game.title}" (AppID: ${appid})`);
    
    // Throttling delay
    await sleep(Math.floor(Math.random() * 200) + 400);

    try {
      // 1. Fetch game basic info to get "dlc" array
      const gameDetailsUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic&cc=us&l=en`;
      const basicInfo = await fetchJson(gameDetailsUrl);
      
      const data = basicInfo && basicInfo[appid] && basicInfo[appid].success ? basicInfo[appid].data : null;
      if (!data) {
        logError(`Failed to fetch game details for AppID ${appid} ("${game.title}")`);
        continue;
      }

      const dlcAppids = data.dlc || [];
      console.log(`  -> Found ${dlcAppids.length} DLC AppIDs.`);

      if (dlcAppids.length === 0) {
        // No DLCs available
        dlcCache[game.id] = {
          gameTitle: game.title,
          dlc: [],
          frictionScore: 0,
          frictionLevel: 'Low',
          totalMissingCost: 0
        };
        writeCache(DLC_CACHE, dlcCache);

        db.prepare(`
          UPDATE AppDLCs
          SET "DLC Availability Status" = 'No Major DLC / Base Game Only',
              "DLC Type" = NULL,
              "Owned Status" = 'All Owned / No DLC',
              "Expansion & DLC Notes" = 'No DLCs found on Steam Store for this base game.'
          WHERE GameID = ?
        `).run(game.id);
        continue;
      }

      // 2. Fetch details for each DLC
      const dlcList = [];
      let totalMissingCost = 0;
      let missingStoryCount = 0;
      let missingCosmeticCount = 0;

      for (const dlcAppid of dlcAppids) {
        const dlcKey = String(dlcAppid);
        let dlcInfo = null;

        // Check if details are already in the dlc cache
        const cachedDlc = Object.values(dlcCache).flatMap(g => g.dlc || []).find(d => String(d.id) === dlcKey);
        if (cachedDlc) {
          dlcInfo = cachedDlc;
        } else {
          // Fetch from Steam
          await sleep(Math.floor(Math.random() * 200) + 400);
          const dlcUrl = `https://store.steampowered.com/api/appdetails?appids=${dlcAppid}&cc=us&l=en`;
          const dlcRes = await fetchJson(dlcUrl);
          const dlcData = dlcRes && dlcRes[dlcKey] && dlcRes[dlcKey].success ? dlcRes[dlcKey].data : null;
          
          if (dlcData) {
            const priceOverview = dlcData.price_overview;
            const price = priceOverview ? priceOverview.final / 100 : 0;
            const type = classifyDlc(dlcData.name, dlcData.short_description || dlcData.detailed_description);
            
            dlcInfo = {
              id: dlcAppid,
              name: dlcData.name,
              price: price,
              type: type,
              priceFormatted: priceOverview ? priceOverview.final_formatted : '$0.00'
            };
          } else {
            logError(`Failed to fetch DLC details for AppID ${dlcAppid} (parent: "${game.title}")`);
          }
        }

        if (dlcInfo) {
          dlcList.push(dlcInfo);
          totalMissingCost += dlcInfo.price;
          if (dlcInfo.type === 'story') {
            missingStoryCount++;
          } else {
            missingCosmeticCount++;
          }
        }
      }

      // Calculate Completion Friction Score
      // Formula: Story DLC missing counts as 3.0 friction each, Cosmetic counts as 0.5 friction each
      const frictionScore = Math.round((missingStoryCount * 3.0 + missingCosmeticCount * 0.5) * 10) / 10;
      let frictionLevel = 'Low';
      if (frictionScore > 5.0) {
        frictionLevel = 'High';
      } else if (frictionScore > 0) {
        frictionLevel = 'Medium';
      }

      dlcCache[game.id] = {
        gameTitle: game.title,
        dlc: dlcList,
        frictionScore: frictionScore,
        frictionLevel: frictionLevel,
        totalMissingCost: Math.round(totalMissingCost * 100) / 100
      };
      writeCache(DLC_CACHE, dlcCache);

      // 3. Update Database
      const dlcTypeStr = missingStoryCount > 0 && missingCosmeticCount > 0 ? 'Story & Cosmetics' 
                       : missingStoryCount > 0 ? 'Story Expansions'
                       : 'Cosmetic Packs';
      const notes = `${missingStoryCount} missing story DLCs, ${missingCosmeticCount} missing cosmetics. Total unowned cost: $${totalMissingCost.toFixed(2)}. Friction Score: ${frictionScore} (${frictionLevel}).`;

      db.prepare(`
        UPDATE AppDLCs
        SET "DLC Availability Status" = ?,
            "DLC Type" = ?,
            "Owned Status" = ?,
            "Expansion & DLC Notes" = ?
        WHERE GameID = ?
      `).run(
        frictionScore > 0 ? 'DLC Available (Needs Review / Manual Verification)' : 'All DLCs Owned',
        dlcTypeStr,
        frictionScore > 0 ? 'Wanted / Needs Check' : 'Included in Edition',
        notes,
        game.id
      );

      console.log(`  -> Completed: ${game.title} | Friction: ${frictionScore} (${frictionLevel}) | Cost: $${totalMissingCost.toFixed(2)}`);
      updated++;
    } catch (e) {
      console.error(`! Failed processing DLCs for "${game.title}": ${e.message}`);
      logError(`Network/parsing error for game "${game.title}": ${e.message}`);
    }
  }

  console.log(`[DLC] Enrichment complete. Updated ${updated} games.`);
}

run().catch(console.error);
