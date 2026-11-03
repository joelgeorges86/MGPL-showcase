/**
 * Sprint 6.1 (GAP-003) — Mod Link Revalidation Sweep.
 *
 * Queries the persisted Mods catalog, re-validates every sourceUrl against the
 * v1.0 whitelist (nexusmods.com, moddb.com, curseforge.com, github.com Releases
 * paths only, modrinth.com), sets is_active = 0 for invalid records, and appends
 * every action to the immutable platform_audit_logs table.
 *
 * Usage:
 *   npx ts-node scripts/mod-link-sweep.ts             # applies changes
 *   npx ts-node scripts/mod-link-sweep.ts --dry-run   # reports without mutating
 *   DB_PATH=data/test_mgpl.db npx ts-node scripts/mod-link-sweep.ts
 */
import path from 'path';
import Database from 'better-sqlite3';
import { sanitizeModUrl } from '../src/middleware/modUrlSanitizer';

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'mpgl_app.db');
const DRY_RUN = process.argv.includes('--dry-run');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');
db.pragma('foreign_keys = ON');

function appendAudit(row: {
  tableName: string;
  rowId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
}): void {
  db.prepare(
    `INSERT INTO "platform_audit_logs" (tableName, rowId, field, oldValue, newValue, reason, operator)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.tableName, row.rowId, row.field, row.oldValue, row.newValue, row.reason, 'mod-link-sweep');
}

function run(): void {
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM Mods').get() as { c: number };
  console.log(
    `[mod-link-sweep] ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'} — ${countRow.c} mod records in ${dbPath}`,
  );

  const rows = db
    .prepare(
      'SELECT id, gameId, modName, sourceUrl, sourceDomain, is_active FROM Mods',
    )
    .all() as Array<{
    id: number;
    gameId: string;
    modName: string;
    sourceUrl: string | null;
    sourceDomain: string | null;
    is_active: number;
  }>;

  let invalid = 0;
  let reactivated = 0;

  for (const row of rows) {
    const result = sanitizeModUrl(row.sourceUrl);

    if (result.valid) {
      if (row.is_active === 0) {
        reactivated++;
        if (!DRY_RUN) {
          db.prepare('UPDATE Mods SET is_active = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
          appendAudit({
            tableName: 'Mods',
            rowId: String(row.id),
            field: 'is_active',
            oldValue: '0',
            newValue: '1',
            reason: 'mod-link-sweep: sourceUrl revalidated to active',
          });
        }
        console.log(`  [reactive] #${row.id} ${row.modName} -> ${row.sourceUrl}`);
      }
      continue;
    }

    invalid++;
    if (!DRY_RUN && row.is_active !== 0) {
      db.prepare('UPDATE Mods SET is_active = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    }
    if (!DRY_RUN) {
      appendAudit({
        tableName: 'Mods',
        rowId: String(row.id),
        field: 'is_active',
        oldValue: row.is_active === 0 ? '0' : '1',
        newValue: '0',
        reason: `mod-link-sweep: invalid sourceUrl — ${result.error}`,
      });
    }
    console.log(`  [deactivate] #${row.id} ${row.modName} -> ${result.error}`);
  }

  console.log(
    `[mod-link-sweep] ${DRY_RUN ? 'Dry-run summary' : 'Summary'}: ${invalid} invalid, ${reactivated} reactivated.`,
  );
  db.close();
}

run();
