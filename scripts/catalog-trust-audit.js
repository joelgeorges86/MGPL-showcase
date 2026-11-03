#!/usr/bin/env node
/* global URL */
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || path.resolve(process.cwd(), 'mpgl_app.db'), {
  readonly: true,
  fileMustExist: true,
});

function columnNames(table) {
  return db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all().map((c) => c.name);
}

function inspectUrl(raw) {
  if (!raw) return { missing: true, broken: false };
  const values = [];
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        values.push(...Object.values(parsed));
      } else {
        values.push(raw);
      }
    } catch {
      values.push(raw);
    }
  } else {
    values.push(raw);
  }
  const present = values.filter(Boolean);
  const broken = present.some((value) => {
    try {
      const url = new URL(String(value));
      return url.protocol !== 'https:' || /google\.com\/search|\/search\?|[?&](q|query|term)=/i.test(url.href);
    } catch {
      return true;
    }
  });
  return { missing: present.length === 0, broken };
}

try {
  const cols = columnNames('AppGames');
  const wanted = ['GameID', 'Game Title', 'storeUrl', 'reviewUrl', 'criticScore', 'reviewSource', 'platformStoreUrls', 'headerImage'];
  const aliases = { GameID: 'gameId', 'Game Title': 'title' };
  const select = wanted
    .filter((column) => cols.includes(column))
    .map((column) => `"${column.replace(/"/g, '""')}" AS "${aliases[column] || column}"`)
    .join(', ');
  const rows = select ? db.prepare(`SELECT ${select} FROM "AppGames" LIMIT 100`).all() : [];
  const store = rows.map((row) => inspectUrl(row.storeUrl || row.platformStoreUrls));
  const review = rows.map((row) => inspectUrl(row.reviewUrl));
  console.log(
    JSON.stringify(
      {
        sampleSize: rows.length,
        columns: cols.filter((column) => wanted.includes(column)),
        missingStore: store.filter((row) => row.missing).length,
        brokenStore: store.filter((row) => row.broken).length,
        missingReview: review.filter((row) => row.missing).length,
        brokenReview: review.filter((row) => row.broken).length,
        measuredAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
