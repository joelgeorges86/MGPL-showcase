-- Sprint 3 (EPIC-PROFILE-0001): Zero-PII social connections engine.
-- Additive-only DDL for AppFriendships. Applied automatically at server boot
-- by src/db.ts via the CREATE TABLE IF NOT EXISTS declaration in initDb() and
-- verified by verifySchemaIntegrity() — running `prisma db push` is explicitly
-- forbidden for this schema because it would diff the entire raw-SQL-managed
-- database and prompt to drop live data.
--
-- Each row is a directed connection:
--   userId   -> the requesting / owning side
--   friendId -> the target side
-- Accepted friendships are stored as ONE row and surfaced bidirectionally by
-- the social routes (GET /api/social/friends matches both directions).
--
-- status state machine:
--   "suggested" (ephemeral, not persisted this sprint) |
--   "pending"   (outgoing request from userId to friendId) |
--   "accepted"  (both sides confirmed) |
--   "blocked"   (reserved for future moderation)
--
-- source records the discovery path: steam | psn | xbox | gog | manual.
-- The composite UNIQUE(userId, friendId) guarantees at most one connection
-- per ordered pair; the row is never duplicated in the reverse direction.
CREATE TABLE IF NOT EXISTS AppFriendships (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  friendId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(userId, friendId),
  FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
  FOREIGN KEY (friendId) REFERENCES AuthUsers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_friendships_userId ON AppFriendships(userId);
CREATE INDEX IF NOT EXISTS idx_friendships_friendId ON AppFriendships(friendId);