import { db } from '../db';

// Use raw SQLite queries for reads and writes to avoid Prisma Client type coercion

function normalizeBoolRaw(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v === 1 ? 'true' : v === 0 ? 'false' : null;
  const s = String(v).trim().toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return 'true';
  if (s === 'no' || s === 'n' || s === 'false' || s === '0') return 'false';
  return null;
}

function extractDigits(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = s.replace(/[^0-9-]/g, '');
  if (m === '') return null;
  const n = parseInt(m, 10);
  if (Number.isNaN(n)) return null;
  return String(n);
}

function findKey(row: any, candidates: string[]) {
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, c)) return c;
    // try case-insensitive
    const found = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
    if (found) return found;
  }
  return null;
}

async function normalizeAppGames() {
  console.log('Normalizing AppGame records (raw SQL)...');
  const rows: any[] = db.prepare(`SELECT * FROM AppGames`).all();
  let changed = 0;
  for (const r of rows) {
    try {
      const idKey = findKey(r, ['gameID', 'GameID', 'gameId']);
      if (!idKey) continue;
      const idVal = r[idKey];
      const updates: Array<{ col: string; val: string }> = [];

      const boolFieldCandidates: Record<string, string[]> = {
        ssdRequired: ['ssdRequired', 'SSD Required?', 'SSD Required', 'ssd_required'],
        isRpg: ['isRpg', 'Is RPG', 'is_rpg'],
        isTurnBased: ['isTurnBased', 'Is Turn-Based'],
        isAction: ['isAction', 'Is Action'],
        isStrategyTactics: ['isStrategyTactics', 'Is Strategy / Tactics'],
        isSimManagement: ['isSimManagement', 'Is Sim / Management'],
        isRoguelikeDeckbuilder: ['isRoguelikeDeckbuilder', 'Is Roguelike / Deckbuilder'],
        isShooterFps: ['isShooterFps', 'Is Shooter / FPS'],
        isPlatformerMetroidvania: ['isPlatformerMetroidvania', 'Is Platformer / Metroidvania'],
        isStoryNarrative: ['isStoryNarrative', 'Is Story / Narrative'],
        isSportsRacing: ['isSportsRacing', 'Is Sports / Racing'],
        isHorrorSurvival: ['isHorrorSurvival', 'Is Horror / Survival'],
        active: ['active', 'Active']
      };

      for (const [logical, candidates] of Object.entries(boolFieldCandidates)) {
        const key = findKey(r, candidates);
        if (!key) continue;
        const val = r[key];
        const norm = normalizeBoolRaw(val);
        if (norm !== null && String(val) !== norm) updates.push({ col: key, val: norm });
      }

      const intFieldCandidates: Record<string, string[]> = {
        minRamGb: ['minRamGb', 'Min RAM GB', 'Min RAM', 'min_ram_gb'],
        minVramGb: ['minVramGb', 'Min VRAM GB', 'Min VRAM', 'min_vram_gb'],
        estimatedGameTime: ['estimatedGameTime', 'Estimated Game Time']
      };

      for (const [logical, candidates] of Object.entries(intFieldCandidates)) {
        const key = findKey(r, candidates);
        if (!key) continue;
        const val = r[key];
        const norm = extractDigits(val);
        if (norm !== null && String(val) !== norm) updates.push({ col: key, val: norm });
      }

      if (updates.length > 0) {
        // build parameterized UPDATE
        const setClauses = updates.map(u => `"${u.col}" = ?`).join(', ');
        const sql = `UPDATE AppGames SET ${setClauses} WHERE "${idKey}" = ?`;
        const params = updates.map(u => u.val);
        params.push(String(idVal));
        try {
          db.prepare(sql).run(...params);
          changed++;
        } catch (e) {
          console.error(`Failed updating AppGame ${idVal}:`, e);
        }
      }
    } catch (e) {
      console.error('Error processing AppGame row, skipping', e);
      continue;
    }
  }
  console.log(`AppGame: updated ${changed} records`);
}

async function normalizeAppOwnerships() {
  console.log('Normalizing AppOwnership records (raw SQL)...');
  const rows: any[] = db.prepare(`SELECT * FROM AppOwnership`).all();
  let changed = 0;
  for (const r of rows) {
    try {
      const idKey = findKey(r, ['ownershipID', 'OwnershipID', 'ownershipId']);
      if (!idKey) continue;
      const idVal = r[idKey];
      const updates: Array<{ col: string; val: string }> = [];

      const prefKey = findKey(r, ['Preferred Platform?', 'Preferred Platform', 'preferredPlatform']);
      if (prefKey) {
        const norm = normalizeBoolRaw(r[prefKey]);
        if (norm !== null && String(r[prefKey]) !== norm) updates.push({ col: prefKey, val: norm });
      }

      if (updates.length > 0) {
        const setClauses = updates.map(u => `"${u.col}" = ?`).join(', ');
        const sql = `UPDATE AppOwnership SET ${setClauses} WHERE "${idKey}" = ?`;
        const params = updates.map(u => u.val);
        params.push(String(idVal));
        try {
          db.prepare(sql).run(...params);
          changed++;
        } catch (e) {
          console.error(`Failed updating AppOwnership ${idVal}:`, e);
        }
      }
    } catch (e) {
      console.error('Error processing AppOwnership row, skipping', e);
      continue;
    }
  }
  console.log(`AppOwnership: updated ${changed} records`);
}

async function normalizeAppTracking() {
  console.log('Normalizing AppTracking records (raw SQL)...');
  const rows: any[] = db.prepare(`SELECT * FROM AppTracking`).all();
  let changed = 0;
  for (const r of rows) {
    try {
      const idKey = findKey(r, ['gameID', 'GameID', 'gameId']);
      if (!idKey) continue;
      const idVal = r[idKey];
      const updates: Array<{ col: string; val: string }> = [];

      const wantKey = findKey(r, ['Want to Play?', 'wantToPlay', 'WantToPlay']);
      if (wantKey) {
        const norm = normalizeBoolRaw(r[wantKey]);
        if (norm !== null && String(r[wantKey]) !== norm) updates.push({ col: wantKey, val: norm });
      }

      const prKey = findKey(r, ['Personal Rating (1-10)', 'personalRating', 'personal_rating']);
      if (prKey) {
        const norm = extractDigits(r[prKey]);
        if (norm !== null && String(r[prKey]) !== norm) updates.push({ col: prKey, val: norm });
      }

      if (updates.length > 0) {
        const setClauses = updates.map(u => `"${u.col}" = ?`).join(', ');
        const sql = `UPDATE AppTracking SET ${setClauses} WHERE "${idKey}" = ?`;
        const params = updates.map(u => u.val);
        params.push(String(idVal));
        try {
          db.prepare(sql).run(...params);
          changed++;
        } catch (e) {
          console.error(`Failed updating AppTracking ${idVal}:`, e);
        }
      }
    } catch (e) {
      console.error('Error processing AppTracking row, skipping', e);
      continue;
    }
  }
  console.log(`AppTracking: updated ${changed} records`);
}

async function normalizeAppReviews() {
  console.log('Normalizing AppReview records (raw SQL)...');
  const rows: any[] = db.prepare(`SELECT * FROM AppReviews`).all();
  let changed = 0;
  for (const r of rows) {
    try {
      const idKey = findKey(r, ['reviewID', 'ReviewID', 'reviewId']);
      if (!idKey) continue;
      const idVal = r[idKey];
      const updates: Array<{ col: string; val: string }> = [];

      const scKey = findKey(r, ['Score Numeric', 'scoreNumeric', 'ScoreNumeric']);
      if (scKey) {
        const norm = extractDigits(r[scKey]);
        if (norm !== null && String(r[scKey]) !== norm) updates.push({ col: scKey, val: norm });
      }

      const rpKey = findKey(r, ['Recommendation Percent', 'recommendationPercent', 'RecommendationPercent']);
      if (rpKey) {
        const norm = extractDigits(r[rpKey]);
        if (norm !== null && String(r[rpKey]) !== norm) updates.push({ col: rpKey, val: norm });
      }

      if (updates.length > 0) {
        const setClauses = updates.map(u => `"${u.col}" = ?`).join(', ');
        const sql = `UPDATE AppReviews SET ${setClauses} WHERE "${idKey}" = ?`;
        const params = updates.map(u => u.val);
        params.push(String(idVal));
        try {
          db.prepare(sql).run(...params);
          changed++;
        } catch (e) {
          console.error(`Failed updating AppReview ${idVal}:`, e);
        }
      }
    } catch (e) {
      console.error('Error processing AppReview row, skipping', e);
      continue;
    }
  }
  console.log(`AppReview: updated ${changed} records`);
}

async function normalizeFriction() {
  console.log('Normalizing AppGameFriction records (raw SQL)...');
  const rows: any[] = db.prepare(`SELECT * FROM AppGameFriction`).all();
  let changed = 0;
  for (const r of rows) {
    try {
      const idKey = findKey(r, ['frictionID', 'FrictionID', 'frictionId']);
      if (!idKey) continue;
      const idVal = r[idKey];
      const updates: Array<{ col: string; val: string }> = [];

      const spKey = findKey(r, ['Suspend / Pause Friendly?', 'suspendPauseFriendly', 'SuspendPauseFriendly']);
      if (spKey) {
        const norm = normalizeBoolRaw(r[spKey]);
        if (norm !== null && String(r[spKey]) !== norm) updates.push({ col: spKey, val: norm });
      }

      const aoKey = findKey(r, ['Always-Online Required?', 'alwaysOnlineRequired', 'AlwaysOnlineRequired']);
      if (aoKey) {
        const norm = normalizeBoolRaw(r[aoKey]);
        if (norm !== null && String(r[aoKey]) !== norm) updates.push({ col: aoKey, val: norm });
      }

      const minutesKey = findKey(r, ['Core Session Loop Length', 'coreSessionLoopLength', 'CoreSessionLoopLength']);
      if (minutesKey) {
        const norm = extractDigits(r[minutesKey]);
        if (norm !== null && String(r[minutesKey]) !== norm) updates.push({ col: minutesKey, val: norm });
      }

      if (updates.length > 0) {
        const setClauses = updates.map(u => `"${u.col}" = ?`).join(', ');
        const sql = `UPDATE AppGameFriction SET ${setClauses} WHERE "${idKey}" = ?`;
        const params = updates.map(u => u.val);
        params.push(String(idVal));
        try {
          db.prepare(sql).run(...params);
          changed++;
        } catch (e) {
          console.error(`Failed updating AppGameFriction ${idVal}:`, e);
        }
      }
    } catch (e) {
      console.error('Error processing AppGameFriction row, skipping', e);
      continue;
    }
  }
  console.log(`AppGameFriction: updated ${changed} records`);
}

async function main() {
  try {
    await normalizeAppGames();
    await normalizeAppOwnerships();
    await normalizeAppTracking();
    await normalizeAppReviews();
    await normalizeFriction();
    console.log('Normalization complete');
  } catch (e) {
    console.error('Normalization failed', e);
    process.exitCode = 1;
  } finally {
    // better-sqlite3 is synchronous — no disconnect call needed.
  }
}

main();
