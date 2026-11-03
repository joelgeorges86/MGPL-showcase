-- Sprint 1 (EPIC-PROFILE-0001): Profile identity, password & privacy fields.
-- Additive-only DDL for AuthUsers profile columns. Applied automatically at
-- server boot by src/db.ts via PRAGMA table_info guards (self-healing), so
-- this file is documentation/reference only — running `prisma db push` is
-- explicitly forbidden for this schema because it would diff the entire
-- raw-SQL-managed database and prompt to drop live data.
--
-- SQLite cannot ALTER TABLE ADD COLUMN with a NOT NULL DEFAULT clause when
-- the table is non-empty, so the profileVisibility NOT NULL DEFAULT 'private'
-- default is enforced in code: new rows get the default from the CREATE TABLE
-- IF NOT EXISTS declaration in src/db.ts, and the runtime maps any NULL value
-- to 'private' when reading the profile.
--
-- gamerTag uniqueness is enforced by a partial unique index (WHERE gamerTag
-- IS NOT NULL) for the same reason — SQLite cannot add a UNIQUE constraint
-- through ALTER TABLE ADD COLUMN.
ALTER TABLE "AuthUsers" ADD COLUMN "displayName" TEXT;
ALTER TABLE "AuthUsers" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "AuthUsers" ADD COLUMN "gamerTag" TEXT;
ALTER TABLE "AuthUsers" ADD COLUMN "profileVisibility" TEXT NOT NULL DEFAULT 'private';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_users_gamerTag" ON "AuthUsers" ("gamerTag") WHERE "gamerTag" IS NOT NULL;