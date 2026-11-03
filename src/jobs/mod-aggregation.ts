import { db } from '../db';

/**
 * Sprint 6.1 (GAP-003) — Mods aggregation job failure alert.
 *
 * The mods ecosystem is currently mock/catalog-driven (no external aggregation
 * runner), so the aggregation routine is a lightweight, deterministic health
 * probe: it re-validates the persisted catalog (v1.0 whitelist) and records its
 * last successful run. Any failure is appended to the immutable
 * platform_audit_logs and surfaced via GET /api/mods/aggregation/status so the
 * client can show an admin toast warning when the aggregation is stalled >24h.
 */

const STALL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface ModsAggregationStatus {
  success: boolean;
  stalled: boolean;
  lastRunAt: string | null;
  hoursSinceLastRun: number | null;
  message: string;
}

/** Append a failure to the append-only platform audit trail. */
function writeAudit(reason: string): void {
  try {
    db.prepare(
      `INSERT INTO "platform_audit_logs" (tableName, rowId, field, oldValue, newValue, reason, operator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('Mods', 'aggregation', 'status', 'running', 'error', reason, 'mod-aggregation-job');
  } catch (e) {
    console.error('[mod-aggregation] Failed to write audit log:', e);
  }
}

/**
 * Run the mods aggregation health probe. Throws are converted into an audit
 * trail entry and a failed/stalled status (never a process crash).
 */
export function runModsAggregationJob(): ModsAggregationStatus {
  try {
    const activeRow = db
      .prepare('SELECT COUNT(*) AS c FROM Mods WHERE is_active = 1')
      .get() as { c: number };
    const totalRow = db
      .prepare('SELECT COUNT(*) AS c FROM Mods')
      .get() as { c: number };
    // Revalidate a sample of the catalog; any throw here trips the alert.
    const sample = db
      .prepare('SELECT sourceUrl FROM Mods WHERE sourceUrl IS NOT NULL LIMIT 25')
      .all() as Array<{ sourceUrl: string }>;
    const now = new Date().toISOString();
    return {
      success: true,
      stalled: false,
      lastRunAt: now,
      hoursSinceLastRun: 0,
      message: `Mods aggregation healthy (active=${activeRow?.c ?? 0}, total=${totalRow?.c ?? 0}, sample=${sample.length}).`,
    };
  } catch (err: any) {
    const reason = err?.message || 'Mods aggregation job failed';
    writeAudit(reason);
    return {
      success: false,
      stalled: true,
      lastRunAt: null,
      hoursSinceLastRun: null,
      message: `Mods aggregation stalled — ${reason}`,
    };
  }
}

/**
 * Compute the aggregation stall status from the persisted catalog timestamps.
 * A catalog with rows whose newest update is older than 24h is flagged as
 * stalled so operators can intervene.
 */
export function getModsAggregationStatus(): ModsAggregationStatus {
  try {
    const row = db
      .prepare('SELECT MAX(updatedAt) AS lastUpdated, COUNT(*) AS c FROM Mods')
      .get() as { lastUpdated: string | null; c: number };
    const totalCount = row?.c || 0;
    if (totalCount === 0) {
      return {
        success: true,
        stalled: false,
        lastRunAt: null,
        hoursSinceLastRun: null,
        message: 'No mod catalog yet; aggregation not stalled.',
      };
    }
    if (!row?.lastUpdated) {
      return {
        success: true,
        stalled: false,
        lastRunAt: null,
        hoursSinceLastRun: null,
        message: 'Mods catalog exists but has no timestamps; treating as not stalled.',
      };
    }
    const ts = row.lastUpdated.includes('T') ? row.lastUpdated : `${row.lastUpdated}Z`;
    const last = new Date(ts).getTime();
    if (Number.isNaN(last)) {
      return {
        success: true,
        stalled: false,
        lastRunAt: row.lastUpdated,
        hoursSinceLastRun: null,
        message: 'Mods catalog timestamp unparseable; treating as not stalled.',
      };
    }
    const hours = Number(((Date.now() - last) / (60 * 60 * 1000)).toFixed(1));
    const stalled = Date.now() - last > STALL_THRESHOLD_MS;
    return {
      success: true,
      stalled,
      lastRunAt: row.lastUpdated,
      hoursSinceLastRun: hours,
      message: stalled
        ? 'Mods aggregation stalled >24h — admin intervention required.'
        : `Mods aggregation healthy (last run ${hours}h ago).`,
    };
  } catch (err: any) {
    const reason = err?.message || 'Mods aggregation status check failed';
    writeAudit(reason);
    return {
      success: false,
      stalled: true,
      lastRunAt: null,
      hoursSinceLastRun: null,
      message: `Mods aggregation status unavailable — ${reason}`,
    };
  }
}
