/**
 * scripts/sanitize-catalog-search-urls.ts
 *
 * Catalog search-URL sanitizer (AGENTS.md §6.1.3 — no generic search fallbacks).
 *
 * Non-destructive by construction:
 *   - Scans every URL-shaped column of AppGames in a SQLite WAL database.
 *   - Sets ONLY values that are generic Google/Bing search URLs to NULL,
 *     matching the exact pattern the integration probe treats as a violation
 *     (scripts/verify-integration-fallbacks.ts isGenericSearchUrl()).
 *   - Runs inside a single transaction; commits only after every statement
 *     succeeds.
 *   - Never touches valid direct publisher/storefront URLs.
 *
 * Usage:
 *   npx ts-node scripts/sanitize-catalog-search-urls.ts             # data/mpgl_app.db
 *   npx ts-node scripts/sanitize-catalog-search-urls.ts --db <path> # explicit target
 *   npx ts-node scripts/sanitize-catalog-search-urls.ts --dry-run   # preview only
 */

import fs from "fs";
import path from "path";
import Database, { Database as DatabaseType } from "better-sqlite3";

/** Mirrors scripts/verify-integration-fallbacks.ts isGenericSearchUrl(). */
function isGenericSearchUrl(url: string): boolean {
  return (
    /(?:google|bing)(?:\.com|\.co\.[a-z]{2}|\.net|\.org)\/[^?#]*\?[^#]*q=/i.test(url) ||
    /(?:google|bing)\.com\/search/i.test(url)
  );
}

function resolveDbPath(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--db") {
      const next = args[i + 1];
      if (next) return path.resolve(next);
    } else if (arg.startsWith("--db=")) {
      return path.resolve(arg.slice("--db=".length));
    }
  }
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const databaseUrl = process.env.DATABASE_URL || "";
  if (databaseUrl.startsWith("file:")) {
    return path.resolve(process.cwd(), databaseUrl.slice("file:".length));
  }
  return path.resolve(process.cwd(), "data", "mpgl_app.db");
}

interface ViolationRow {
  id: string;
  value: string;
}

function urlColumns(db: DatabaseType): string[] {
  const tableInfo = db.prepare('PRAGMA table_info("AppGames")').all() as Array<{ name?: string }>;
  return tableInfo.map((c) => String(c.name || "")).filter((name) => /url/i.test(name));
}

function collectViolations(db: DatabaseType, columns: string[]): Map<string, ViolationRow[]> {
  const violations = new Map<string, ViolationRow[]>();
  for (const column of columns) {
    const rows = db
      .prepare(
        `SELECT "GameID" AS id, "${column}" AS value FROM "AppGames" WHERE "${column}" IS NOT NULL`,
      )
      .all() as ViolationRow[];
    const matched = rows.filter((r) => isGenericSearchUrl(r.value));
    if (matched.length > 0) violations.set(column, matched);
  }
  return violations;
}

function countViolations(violations: Map<string, ViolationRow[]>): number {
  let total = 0;
  for (const rows of violations.values()) total += rows.length;
  return total;
}

function main(): void {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const dbFile = resolveDbPath();
  if (!fs.existsSync(dbFile)) {
    console.error(`[sanitize] database not found: ${dbFile}`);
    process.exit(1);
  }

  const db: DatabaseType = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000");

  const columns = urlColumns(db);
  const before = collectViolations(db, columns);
  const beforeCount = countViolations(before);
  const beforeNonNull = db
    .prepare('SELECT COUNT(*) AS n FROM "AppGames" WHERE "Official Website URL" IS NOT NULL')
    .get() as { n: number };

  if (dryRun) {
    console.log(`[sanitize] DRY-RUN against ${dbFile}`);
    console.log(`[sanitize] url columns scanned: ${columns.join(", ")}`);
    console.log(`[sanitize] generic-search violations that WOULD be cleared: ${beforeCount}`);
    for (const [column, rows] of before) {
      console.log(`  - ${column}: ${rows.length}`);
    }
    console.log(
      `[sanitize] non-null "Official Website URL" rows that WOULD remain untouched: ${beforeNonNull.n}`,
    );
    db.close();
    return;
  }

  if (beforeCount === 0) {
    console.log(`[sanitize] ${dbFile}`);
    console.log(`[sanitize] no generic-search URL violations found; nothing to clear.`);
    db.close();
    return;
  }

  const clear = db.transaction(() => {
    for (const [column, rows] of before) {
      const stmt = db.prepare(`UPDATE "AppGames" SET "${column}" = NULL WHERE "GameID" = ?`);
      for (const row of rows) stmt.run(row.id);
    }
  });
  clear();

  const after = collectViolations(db, columns);
  const afterCount = countViolations(after);
  const afterNonNull = db
    .prepare('SELECT COUNT(*) AS n FROM "AppGames" WHERE "Official Website URL" IS NOT NULL')
    .get() as { n: number };

  console.log(`[sanitize] committed against ${dbFile}`);
  console.log(`[sanitize] url columns scanned: ${columns.join(", ")}`);
  for (const [column, rows] of before) {
    console.log(`  - ${column}: cleared ${rows.length}`);
  }
  console.log(`[sanitize] total cleared: ${beforeCount}; remaining violations: ${afterCount}`);
  console.log(
    `[sanitize] non-null "Official Website URL" rows before=${beforeNonNull.n} after=${afterNonNull.n} (valid publisher URLs untouched)`,
  );

  db.close();
  process.exitCode = afterCount === 0 ? 0 : 1;
}

main();
