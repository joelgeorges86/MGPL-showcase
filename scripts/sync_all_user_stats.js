#!/usr/bin/env node
/**
 * scripts/sync_all_user_stats.js
 * Multi-platform account sync pipeline to sync playtime, play status, trophy progress, 
 * and tracked mods from Steam, PSN, GOG, and Nexus Mods into mpgl_app.db.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const DB_PATH = path.join(ROOT, 'mpgl_app.db');

// Setup and open database connection
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');

// Ensure required schema columns exist
function ensureColumns() {
  // Add "Trophy Progress" to AppTracking (for PSN trophy progress)
  const trackingInfo = db.prepare('PRAGMA table_info("AppTracking")').all();
  const existingTracking = new Set(trackingInfo.map(c => c.name.toLowerCase()));
  if (!existingTracking.has('trophy progress') && !existingTracking.has('trophyprogress')) {
    db.prepare('ALTER TABLE "AppTracking" ADD COLUMN "Trophy Progress" INTEGER').run();
    console.log('Added "Trophy Progress" column to AppTracking table.');
  }

  // Add "trackedModCount" and "modNotifications" to AppGames (for Nexus Mods)
  const gamesInfo = db.prepare('PRAGMA table_info("AppGames")').all();
  const existingGames = new Set(gamesInfo.map(c => c.name.toLowerCase()));
  if (!existingGames.has('trackedmodcount')) {
    db.prepare('ALTER TABLE "AppGames" ADD COLUMN "trackedModCount" INTEGER').run();
    console.log('Added "trackedModCount" column to AppGames table.');
  }
  if (!existingGames.has('modnotifications')) {
    db.prepare('ALTER TABLE "AppGames" ADD COLUMN "modNotifications" TEXT').run();
    console.log('Added "modNotifications" column to AppGames table.');
  }
}

// Helper functions for title normalization & matching (matching the logic in enrich_game_data)
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
  const EDITION_NOISE = new RegExp(
    '\\b(game of the year|goty|ultimate|definitive|enhanced|complete|deluxe|premium|' +
    'remastered|remaster|redux|anniversary|collection|bundle|edition|directors cut|' +
    'director s cut|hd|the master chief collection|reloaded|rebrushed)\\b', 'g'
  );
  return n
    .replace(EDITION_NOISE, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  const coverage = shared / at.size;
  const bloat = shared / bt.size;
  return coverage * 0.7 + bloat * 0.3;
}

// Main execution stats
const summary = {
  steam: 0,
  psn: 0,
  gog: 0,
  nexus: 0
};

async function syncSteam() {
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID64;

  if (!apiKey || !steamId) {
    console.warn('Steam sync warning: STEAM_API_KEY or STEAM_ID64 is not configured in .env.');
    return;
  }

  console.log('Starting Steam Sync...');
  try {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&format=json&include_appinfo=1&include_played_free_games=1`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Steam API HTTP ${res.status}`);
    }
    const json = await res.json();
    const steamGames = json?.response?.games;
    if (!Array.isArray(steamGames)) {
      throw new Error('Invalid response from Steam API');
    }

    console.log(`Fetched ${steamGames.length} games from Steam.`);

    // Match Steam AppIDs with database entries
    const ownerships = db.prepare('SELECT "GameID", "Store URL" FROM "AppOwnership" WHERE "Store URL" IS NOT NULL').all();
    const games = db.prepare('SELECT "GameID", "platformStoreUrls" FROM "AppGames"').all();

    const appIdToGameId = new Map();
    for (const row of ownerships) {
      const m = /store\.steampowered\.com\/app\/(\d+)/.exec(row['Store URL']);
      if (m) appIdToGameId.set(parseInt(m[1]), row.GameID);
    }
    for (const row of games) {
      if (row.platformStoreUrls) {
        try {
          const urls = JSON.parse(row.platformStoreUrls);
          for (const url of Object.values(urls)) {
            if (typeof url === 'string') {
              const m = /store\.steampowered\.com\/app\/(\d+)/.exec(url);
              if (m) appIdToGameId.set(parseInt(m[1]), row.GameID);
            }
          }
        } catch (e) {}
      }
    }

    let updatedCount = 0;
    for (const steamGame of steamGames) {
      const gameId = appIdToGameId.get(steamGame.appid);
      if (!gameId) continue;

      const hoursPlayed = parseFloat((steamGame.playtime_forever / 60).toFixed(2));
      const lastPlayedDate = steamGame.rtime_last_played 
        ? new Date(steamGame.rtime_last_played * 1000).toISOString().split('T')[0] 
        : null;

      const tracking = db.prepare('SELECT "Play Status" FROM "AppTracking" WHERE "GameID" = ?').get(gameId);
      
      const currentStatus = tracking ? tracking['Play Status'] : 'Not Started';
      let playStatus = null;
      if (steamGame.playtime_forever > 60) {
        if (currentStatus === 'Not Started') {
          playStatus = 'In Progress';
        }
      }

      if (!tracking) {
        db.prepare(`
          INSERT INTO "AppTracking" ("GameID", "Play Status", "Hours Played", "Last Played Date")
          VALUES (?, ?, ?, ?)
        `).run(gameId, playStatus || 'Not Started', hoursPlayed, lastPlayedDate);
      } else {
        db.prepare(`
          UPDATE "AppTracking"
          SET "Hours Played" = ?,
              "Last Played Date" = COALESCE(?, "Last Played Date"),
              "Play Status" = COALESCE(?, "Play Status")
          WHERE "GameID" = ?
        `).run(hoursPlayed, lastPlayedDate, playStatus, gameId);
      }
      updatedCount++;
    }

    console.log(`Successfully synced ${updatedCount} Steam game play stats.`);
    summary.steam = updatedCount;
  } catch (err) {
    console.warn(`Steam sync failed: ${err.message}`);
  }
}

async function syncPsn() {
  const npsso = process.env.PSN_NPSSO_CODE;

  if (!npsso) {
    console.warn('PSN sync warning: PSN_NPSSO_CODE is not configured in .env.');
    return;
  }

  console.log('Starting PSN Sync...');
  try {
    const { exchangeNpssoForCode, exchangeCodeForAccessToken, getUserTitles } = require('psn-api');

    const accessCode = await exchangeNpssoForCode(npsso);
    const authorization = await exchangeCodeForAccessToken(accessCode);
    const titlesResponse = await getUserTitles(authorization, "me");

    const trophyTitles = titlesResponse?.trophyTitles;
    if (!Array.isArray(trophyTitles)) {
      throw new Error('Invalid response from PSN API');
    }

    console.log(`Fetched ${trophyTitles.length} trophy titles from PSN.`);

    const psnGames = db.prepare(`
      SELECT g."GameID" as gameId, g."Game Title" as title 
      FROM "AppGames" g
      JOIN "AppOwnership" o ON o."GameID" = g."GameID"
      WHERE o."Platform" IN ('PS5', 'PS4', 'PlayStation')
    `).all();

    let updatedCount = 0;
    for (const title of trophyTitles) {
      let bestGame = null;
      let bestScore = 0;

      for (const pg of psnGames) {
        const score = titleScore(title.trophyTitleName, pg.title);
        if (score > bestScore) {
          bestGame = pg;
          bestScore = score;
        }
      }

      if (bestGame && bestScore >= 0.82) {
        const gameId = bestGame.gameId;
        const progress = title.progress;

        const tracking = db.prepare('SELECT "Play Status" FROM "AppTracking" WHERE "GameID" = ?').get(gameId);
        
        let playStatus = null;
        if (progress === 100) {
          playStatus = 'Completed';
        } else if (progress > 0) {
          if (!tracking || tracking['Play Status'] !== 'Completed') {
            playStatus = 'In Progress';
          }
        }

        if (!tracking) {
          db.prepare(`
            INSERT INTO "AppTracking" ("GameID", "Play Status", "Trophy Progress")
            VALUES (?, ?, ?)
          `).run(gameId, playStatus || 'Not Started', progress);
        } else {
          db.prepare(`
            UPDATE "AppTracking"
            SET "Trophy Progress" = ?,
                "Play Status" = COALESCE(?, "Play Status")
            WHERE "GameID" = ?
          `).run(progress, playStatus, gameId);
        }
        updatedCount++;
      }
    }

    console.log(`Successfully synced ${updatedCount} PSN game trophy stats.`);
    summary.psn = updatedCount;
  } catch (err) {
    console.warn(`PSN sync failed: ${err.message}`);
  }
}

async function syncGog() {
  const username = process.env.GOG_USERNAME;

  if (!username) {
    console.warn('GOG sync warning: GOG_USERNAME is not configured in .env.');
    return;
  }

  console.log('Starting GOG Sync...');
  try {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
    let gogGames = null;

    // Retry loop for the GOG fetch
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`https://www.gog.com/u/${username}/games/stats`, {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json'
          }
        });
        if (res.status === 200) {
          gogGames = await res.json();
          break;
        } else if (res.status === 403) {
          // If stats endpoint returns 403 (needs authentication/cookies), attempt fallback to the main public games HTML page
          console.log('GOG stats endpoint returned 403. Attempting public profile games page fallback...');
          const mainRes = await fetch(`https://www.gog.com/u/${username}/games`, {
            headers: { 'User-Agent': UA }
          });
          if (mainRes.status === 200) {
            const html = await mainRes.text();
            
            // Extract from angular model window.profilesData or simple HTML scraping if possible
            const idx = html.indexOf('window.profilesData.profileUser =');
            if (idx !== -1) {
              const statsMatch = /"stats":\s*({[\s\S]*?})/.exec(html.slice(idx, idx + 1000));
              if (statsMatch) {
                const stats = JSON.parse(statsMatch[1]);
                console.log(`Found GOG profile. Games owned: ${stats.games_owned || 0}`);
              }
            }
            // For GOG HTML, game list is Angular dynamic so stats endpoint is necessary for granular list.
            // If the profile is private, list remains empty.
          }
        }
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!gogGames || !Array.isArray(gogGames)) {
      console.warn('GOG Sync: Profile is private, empty, or endpoint is unreachable. Continuing.');
      return;
    }

    console.log(`Fetched ${gogGames.length} games from GOG.`);

    const dbGogGames = db.prepare(`
      SELECT g."GameID" as gameId, g."Game Title" as title 
      FROM "AppGames" g
      JOIN "AppOwnership" o ON o."GameID" = g."GameID"
      WHERE o."Platform" = 'GOG'
    `).all();

    let updatedCount = 0;
    for (const gogItem of gogGames) {
      const gogTitle = gogItem?.game?.title;
      const playtime = gogItem?.stats?.playtime || 0; // minutes

      if (!gogTitle) continue;

      let bestGame = null;
      let bestScore = 0;

      for (const dgg of dbGogGames) {
        const score = titleScore(gogTitle, dgg.title);
        if (score > bestScore) {
          bestGame = dgg;
          bestScore = score;
        }
      }

      if (bestGame && bestScore >= 0.82) {
        const gameId = bestGame.gameId;
        const hoursPlayed = parseFloat((playtime / 60).toFixed(2));

        const tracking = db.prepare('SELECT "Play Status" FROM "AppTracking" WHERE "GameID" = ?').get(gameId);
        
        let playStatus = null;
        if (playtime > 60) {
          if (!tracking || tracking['Play Status'] !== 'Completed') {
            playStatus = 'In Progress';
          }
        }

        if (!tracking) {
          db.prepare(`
            INSERT INTO "AppTracking" ("GameID", "Play Status", "Hours Played")
            VALUES (?, ?, ?)
          `).run(gameId, playStatus || 'Not Started', hoursPlayed);
        } else {
          db.prepare(`
            UPDATE "AppTracking"
            SET "Hours Played" = ?,
                "Play Status" = COALESCE(?, "Play Status")
            WHERE "GameID" = ?
          `).run(hoursPlayed, playStatus, gameId);
        }
        updatedCount++;
      }
    }

    console.log(`Successfully synced ${updatedCount} GOG game stats.`);
    summary.gog = updatedCount;
  } catch (err) {
    console.warn(`GOG sync failed: ${err.message}`);
  }
}

async function syncNexus() {
  const apiKey = process.env.NEXUSMODS_API_KEY;

  if (!apiKey) {
    console.warn('Nexus Mods sync warning: NEXUSMODS_API_KEY is not configured in .env.');
    return;
  }

  console.log('Starting Nexus Mods Sync...');
  try {
    const res = await fetch('https://api.nexusmods.com/v1/user/tracked_mods.json', {
      headers: {
        'apikey': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'MGPL-catalog-enricher/1.0 (personal game library tool)'
      }
    });

    if (!res.ok) {
      throw new Error(`Nexus Mods API HTTP ${res.status}`);
    }

    const trackedMods = await res.json();
    if (!Array.isArray(trackedMods)) {
      throw new Error('Invalid response from Nexus Mods API');
    }

    console.log(`Fetched ${trackedMods.length} tracked mods from Nexus Mods.`);

    // Group tracked mods by game domain name
    const domainCounts = {};
    for (const mod of trackedMods) {
      if (mod.domain_name) {
        const dom = mod.domain_name.toLowerCase();
        domainCounts[dom] = (domainCounts[dom] || 0) + 1;
      }
    }

    // Map database games to their Nexus Mods domain names
    const nexusGames = db.prepare('SELECT "GameID", "nexusUrl", "Nexus Mods URL" FROM "AppGames"').all();

    function getDomain(url) {
      if (!url) return null;
      const m = /nexusmods\.com\/([a-zA-Z0-9_|-]+)/.exec(url);
      return m ? m[1].toLowerCase() : null;
    }

    let updatedCount = 0;
    for (const game of nexusGames) {
      const domain = getDomain(game.nexusUrl) || getDomain(game['Nexus Mods URL']);
      const count = domain ? (domainCounts[domain] || 0) : 0;

      // Update the trackedModCount and set notifications status
      // We will set modNotifications to 'Active Tracking' if there are tracked mods, otherwise null
      db.prepare(`
        UPDATE "AppGames"
        SET "trackedModCount" = ?,
            "modNotifications" = ?
        WHERE "GameID" = ?
      `).run(count, count > 0 ? 'Active Tracking' : null, game.GameID);

      if (count > 0) {
        updatedCount++;
      }
    }

    console.log(`Successfully synced mod tracking data for ${updatedCount} games.`);
    summary.nexus = trackedMods.length;
  } catch (err) {
    console.warn(`Nexus Mods sync failed: ${err.message}`);
  }
}

async function run() {
  console.log('--- Account Sync Pipeline Started ---');
  ensureColumns();

  await syncSteam();
  await syncPsn();
  await syncGog();
  await syncNexus();

  db.close();
  console.log('--- Account Sync Pipeline Finished ---');
  console.log('SUMMARY:', summary);
  
  // Output final json line for easy parsing by parent process
  console.log('JSON_SUMMARY: ' + JSON.stringify(summary));
}

run().catch(err => {
  console.error('Account sync pipeline failed:', err);
  process.exit(1);
});
