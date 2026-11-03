/**
 * Pure analytics aggregation helpers (FEAT-0152).
 *
 * Extracted from src/routes/analytics.ts so the aggregation math is
 * unit-testable without importing the Express route (which opens the SQLite
 * connection at module load). No DB or network access — pure functions only,
 * which satisfies the Vitest pure-logic contract (vitest.config.ts) and feeds
 * the Q3 coverage scope (src/utils/**).
 */

/** Normalize a raw genre string into a display label. */
export function normalizeGenre(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Uncategorized';
  return raw;
}

/** Classify a play status string into a velocity bucket. */
export function statusBucket(status: unknown): 'completed' | 'inProgress' | 'unplayed' {
  const s = String(status ?? '').toLowerCase();
  if (/completed|finished|100%|beaten|cleared/i.test(s)) return 'completed';
  if (/in progress|playing|started|replaying/i.test(s)) return 'inProgress';
  return 'unplayed';
}

/** Compute a value rating from a cost-per-hour figure. */
export function valueRating(cph: number | null): string {
  if (cph === null) return 'Free/Unpriced';
  if (cph < 0.5) return 'Excellent';
  if (cph < 1.0) return 'Good';
  if (cph < 2.5) return 'Fair';
  return 'Poor';
}

/** Round a number to a fixed number of decimals, guarding against NaN. */
export function round(value: number, decimals = 2): number {
  if (value === null || value === undefined || isNaN(Number(value))) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(Number(value) * factor) / factor;
}
