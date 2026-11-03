-- Sprint 2 (FEAT-MULTITENANT): Multi-tenant data isolation for user state.
-- Adds userId FK + compound per-user uniques. See table sections below.
PRAGMA foreign_keys = OFF;
BEGIN;

-- 1. Legacy-guest auth user (owner of pre-migration rows).
INSERT OR IGNORE INTO "AuthUsers" (id, email, role, createdAt, updatedAt)
VALUES ('legacy-guest', 'legacy-guest@mgpl.local', 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 2. AppWishlist staging table.
CREATE TABLE IF NOT EXISTS "AppWishlist_user_scoped" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  gameId TEXT NOT NULL,
  title TEXT NOT NULL,
  coverImage TEXT,
  targetPrice REAL NOT NULL,
  currentBestPrice REAL,
  bestStore TEXT,
  bestStoreType TEXT,
  historicalLow REAL,
  isTriggered INTEGER DEFAULT 0,
  notes TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppWishlist_userId_fkey" FOREIGN KEY (userId) REFERENCES "AuthUsers" (id) ON DELETE CASCADE,
  CONSTRAINT "AppWishlist_userId_gameId_key" UNIQUE (userId, gameId)
);

INSERT OR IGNORE INTO "AppWishlist_user_scoped" (
  id, userId, gameId, title, coverImage, targetPrice, currentBestPrice,
  bestStore, bestStoreType, historicalLow, isTriggered, notes, createdAt, updatedAt
)
SELECT
  id, 'legacy-guest', gameId, title, coverImage, targetPrice, currentBestPrice,
  bestStore, bestStoreType, historicalLow, isTriggered, notes, createdAt, updatedAt
FROM "AppWishlist"
WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('AppWishlist') WHERE name = 'userId');

-- 3. AppPriceAlerts staging table.
CREATE TABLE IF NOT EXISTS "AppPriceAlerts_user_scoped" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  gameId TEXT NOT NULL,
  title TEXT NOT NULL,
  targetPrice REAL NOT NULL,
  currentPrice REAL,
  historicalLow REAL,
  isTriggered INTEGER DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppPriceAlerts_userId_fkey" FOREIGN KEY (userId) REFERENCES "AuthUsers" (id) ON DELETE CASCADE,
  CONSTRAINT "AppPriceAlerts_userId_gameId_key" UNIQUE (userId, gameId)
);

INSERT OR IGNORE INTO "AppPriceAlerts_user_scoped" (
  id, userId, gameId, title, targetPrice, currentPrice, historicalLow,
  isTriggered, createdAt, updatedAt
)
SELECT
  id, 'legacy-guest', gameId, title, targetPrice, currentPrice, historicalLow,
  isTriggered, createdAt, updatedAt
FROM "AppPriceAlerts"
WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('AppPriceAlerts') WHERE name = 'userId');

-- 4. AppGameTags staging table.
CREATE TABLE IF NOT EXISTS "AppGameTags_user_scoped" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  gameId TEXT NOT NULL,
  tagName TEXT NOT NULL,
  colorHex TEXT DEFAULT '#38bdf8',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppGameTags_userId_fkey" FOREIGN KEY (userId) REFERENCES "AuthUsers" (id) ON DELETE CASCADE,
  CONSTRAINT "AppGameTags_userId_gameId_tagName_key" UNIQUE (userId, gameId, tagName)
);

INSERT OR IGNORE INTO "AppGameTags_user_scoped" (
  id, userId, gameId, tagName, colorHex, createdAt
)
SELECT
  id, 'legacy-guest', gameId, tagName, colorHex, createdAt
FROM "AppGameTags"
WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('AppGameTags') WHERE name = 'userId');

-- 5. AppGameNotes staging table.
CREATE TABLE IF NOT EXISTS "AppGameNotes_user_scoped" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  gameId TEXT NOT NULL,
  noteMarkdown TEXT NOT NULL,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppGameNotes_userId_fkey" FOREIGN KEY (userId) REFERENCES "AuthUsers" (id) ON DELETE CASCADE,
  CONSTRAINT "AppGameNotes_userId_gameId_key" UNIQUE (userId, gameId)
);

INSERT OR IGNORE INTO "AppGameNotes_user_scoped" (
  id, userId, gameId, noteMarkdown, updatedAt
)
SELECT
  id, 'legacy-guest', gameId, noteMarkdown, updatedAt
FROM "AppGameNotes"
WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('AppGameNotes') WHERE name = 'userId');

COMMIT;
PRAGMA foreign_keys = ON;
