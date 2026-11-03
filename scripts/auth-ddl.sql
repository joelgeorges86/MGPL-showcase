-- Sprint 1 (FEAT-AUTH-0001): Native auth core.
-- Additive-only DDL for AuthUsers/AuthAccounts. Applied via `prisma db execute`
-- because a full `prisma db push` would diff the entire pre-existing schema
-- (raw-SQL-managed tables not represented in schema.prisma) and prompt to drop
-- live data. This file is idempotent.
CREATE TABLE IF NOT EXISTS "AuthUsers" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT UNIQUE,
  "passwordHash" TEXT,
  "role" TEXT NOT NULL DEFAULT 'user',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "AuthAccounts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthAccounts_provider_providerAccountId_key" UNIQUE ("provider", "providerAccountId"),
  CONSTRAINT "AuthAccounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUsers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_auth_accounts_userId" ON "AuthAccounts" ("userId");