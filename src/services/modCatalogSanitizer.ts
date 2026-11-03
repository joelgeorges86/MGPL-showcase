/**
 * Sprint 1B (EPICSEC02) — Automated Mod Catalog Re-Sanitization.
 *
 * Re-validates every persisted Mods.sourceUrl against the read-time domain
 * whitelist (nexusmods.com, moddb.com, curseforge.com, github.com releases-only,
 * modrinth.com) and soft-quarantines non-compliant records by flipping the
 * additive `is_active` flag — never a destructive delete. Every mutation is
 * appended to the immutable platform_audit_logs table so the change is
 * observable and reversible.
 *
 * This is the shared engine behind:
 *   - src/db.ts initDb() boot-time self-heal (automated stale-record check),
 *   - the hourly mods scheduler task in src/services/scheduler.ts,
 *   - the standalone CLI in scripts/mod-link-sweep.ts.
 *
 * Privacy-minimized: audit reasons and log lines pass through safeErrorMessage so raw
 * stack traces / internal paths can never be persisted or echoed.
 */
import { Database as DatabaseType } from 'better-sqlite3';
import { sanitizeModUrl } from '../middleware/modUrlSanitizer';
import { safeErrorMessage } from '../utils/errorSanitizer';

export interface ModSanitizationReport {
  total: number;
  invalid: number;
  quarantined: number;
  reactivated: number;
}

function appendAudit(
  db: DatabaseType,
  row: { rowId: string; oldValue: string; newValue: string; reason: string },
): void {
  try {
    db.prepare(
      `INSERT INTO "platform_audit_logs" (tableName, rowId, field, oldValue, newValue, reason, operator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('Mods', row.rowId, 'is_active', row.oldValue, row.newValue, row.reason, 'mod-catalog-sanitizer');
  } catch {
    // Audit is best-effort; a failure here must never abort the sweep.
  }
}

/**
 * Re-validate the persisted mod catalog and quarantine/reactivate records
 * against the exact-match whitelist. Non-destructive and idempotent — safe to
 * run on every boot and on an hourly cron cadence.
 */
export function reSanitizeModCatalog(db: DatabaseType): ModSanitizationReport {
  const report: ModSanitizationReport = {
    total: 0,
    invalid: 0,
    quarantined: 0,
    reactivated: 0,
  };

  let rows: Array<{ id: number; sourceUrl: string | null; is_active: number }>;
  try {
    rows = db
      .prepare('SELECT id, sourceUrl, is_active FROM Mods')
      .all() as Array<{ id: number; sourceUrl: string | null; is_active: number }>;
  } catch {
    // The Mods table may not exist yet on a fresh DB (initDb DDL runs later).
    return report;
  }
  report.total = rows.length;

  for (const row of rows) {
    const result = sanitizeModUrl(row.sourceUrl);

    if (result.valid) {
      if (row.is_active === 0) {
        report.reactivated += 1;
        db.prepare(
          'UPDATE Mods SET is_active = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        ).run(row.id);
        appendAudit(db, {
          rowId: String(row.id),
          oldValue: '0',
          newValue: '1',
          reason: 'mod-catalog-sanitizer: sourceUrl revalidated to active',
        });
      }
      continue;
    }

    report.invalid += 1;
    if (row.is_active !== 0) {
      report.quarantined += 1;
      db.prepare(
        'UPDATE Mods SET is_active = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      ).run(row.id);
    }
    appendAudit(db, {
      rowId: String(row.id),
      oldValue: row.is_active === 0 ? '0' : '1',
      newValue: '0',
      reason: `mod-catalog-sanitizer: invalid sourceUrl — ${safeErrorMessage(result.error)}`,
    });
  }

  if (report.invalid > 0 || report.reactivated > 0) {
    console.log(
      `[mod-catalog-sanitizer] ${report.quarantined} quarantined, ${report.reactivated} reactivated of ${report.total} records.`,
    );
  }
  return report;
}
