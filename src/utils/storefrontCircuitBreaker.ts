/**
 * Sprint 1 (EPIC-DEAL-001) — Per-Storefront Request Throttling & Circuit
 * Breaker.
 *
 * Prevents cascading timeouts when an upstream storefront API fails. Each keyed
 * storefront owns a small state machine:
 *
 *   CLOSED  -> requests flow normally until `FAILURE_THRESHOLD` consecutive
 *              failures occur, then transitions to OPEN.
 *   OPEN    -> requests are short-circuited for `RESET_MS`; callers are served
 *              the cached stale snapshot (stale-while-revalidate fallback).
 *   HALF_OPEN -> after the reset window, a single probe request is allowed. On
 *                success the breaker returns to CLOSED; on failure it re-opens.
 *
 * A singleton in-memory snapshot registry caches the last successful payload for
 * each storefront so the API can serve stale-but-valid data during an outage.
 * All thresholds are env-configurable so the E2E suite can exercise the OPEN
 * transition deterministically with zero backoff.
 */

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  // Rate limiting
  lastAttemptAt: number;
  backoffUntil: number;
}

interface SnapshotEntry {
  data: unknown;
  updatedAt: number;
}

export type CircuitResult<T> =
  | { ok: true; data: T; circuit: CircuitState }
  | {
      ok: false;
      stale: T | null;
      circuit: CircuitState;
      error: string;
    };

const FAILURE_THRESHOLD = readIntEnv('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 5);
const BACKOFF_BASE_MS = readIntEnv('CIRCUIT_BREAKER_BACKOFF_MS', 1000);
const MAX_BACKOFF_MS = readIntEnv('CIRCUIT_BREAKER_MAX_BACKOFF_MS', 30000);
const RESET_MS = readIntEnv('CIRCUIT_BREAKER_RESET_MS', 60000);

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

class StorefrontCircuitBreaker {
  private breakers = new Map<string, BreakerEntry>();
  private snapshots = new Map<string, SnapshotEntry>();

  private entry(key: string): BreakerEntry {
    let b = this.breakers.get(key);
    if (!b) {
      b = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: 0,
        lastAttemptAt: 0,
        backoffUntil: 0,
      };
      this.breakers.set(key, b);
    }
    return b;
  }

  private snapshot(key: string): SnapshotEntry | null {
    return this.snapshots.get(key) || null;
  }

  private setSnapshot(key: string, data: unknown): void {
    this.snapshots.set(key, { data, updatedAt: Date.now() });
  }

  /** Wait out any active per-storefront backoff before the next attempt. */
  private async throttle(key: string): Promise<void> {
    const b = this.entry(key);
    const now = Date.now();
    if (b.backoffUntil > now) {
      await sleep(b.backoffUntil - now);
    }
    b.lastAttemptAt = Date.now();
  }

  /** Record one failure and advance the throttle + breaker state. */
  private recordFailure(key: string): void {
    const b = this.entry(key);
    b.consecutiveFailures += 1;
    // Exponential backoff capped at MAX_BACKOFF_MS.
    const exp = Math.min(
      MAX_BACKOFF_MS,
      BACKOFF_BASE_MS * Math.pow(2, b.consecutiveFailures - 1),
    );
    b.backoffUntil = Date.now() + exp;

    if (b.state === 'HALF_OPEN') {
      // A failed probe re-opens the breaker.
      b.state = 'OPEN';
      b.openedAt = Date.now();
    } else if (b.state === 'CLOSED' && b.consecutiveFailures >= FAILURE_THRESHOLD) {
      b.state = 'OPEN';
      b.openedAt = Date.now();
    }
  }

  private recordSuccess(key: string): void {
    const b = this.entry(key);
    b.state = 'CLOSED';
    b.consecutiveFailures = 0;
    b.backoffUntil = 0;
  }

  /**
   * Execute a fetcher under the breaker. On success the payload is both returned
   * and cached; on failure the last good snapshot is returned as stale data (if
   * available) while the failure still counts toward opening the circuit.
   */
  async run<T>(key: string, fetcher: () => Promise<T>): Promise<CircuitResult<T>> {
    const b = this.entry(key);
    const now = Date.now();

    // OPEN -> after reset window, allow one probe (HALF_OPEN).
    if (b.state === 'OPEN' && now - b.openedAt >= RESET_MS) {
      b.state = 'HALF_OPEN';
    }

    // OPEN: short-circuit immediately, serve stale snapshot.
    if (b.state === 'OPEN') {
      const snap = this.snapshot(key);
      return {
        ok: false,
        stale: snap ? (snap.data as T) : null,
        circuit: 'OPEN',
        error: 'Circuit open: upstream storefront is unavailable.',
      };
    }

    // CLOSED or HALF_OPEN: attempt the request with throttling.
    await this.throttle(key);
    try {
      const data = await fetcher();
      this.recordSuccess(key);
      this.setSnapshot(key, data);
      return { ok: true, data, circuit: this.entry(key).state };
    } catch (err: any) {
      const message = err?.message || String(err);
      this.recordFailure(key);
      const snap = this.snapshot(key);
      return {
        ok: false,
        stale: snap ? (snap.data as T) : null,
        circuit: this.entry(key).state,
        error: message,
      };
    }
  }

  /** Force a snapshot into the cache (used to prime the E2E fallback). */
  primeSnapshot(key: string, data: unknown): void {
    this.setSnapshot(key, data);
  }

  state(key: string): CircuitState {
    return this.entry(key).state;
  }

  /** Reset a specific key to CLOSED and drop its snapshot. */
  reset(key: string): void {
    this.breakers.delete(key);
    this.snapshots.delete(key);
  }

  /** Reset every breaker and snapshot (deterministic E2E teardown). */
  resetAll(): void {
    this.breakers.clear();
    this.snapshots.clear();
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Process-wide singleton registry. */
export const circuitBreaker = new StorefrontCircuitBreaker();

/** Convenience wrapper for route handlers. */
export function fetchWithCircuitBreaker<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<CircuitResult<T>> {
  return circuitBreaker.run(key, fetcher);
}

/** E2E helper to read a breaker's state without importing internals. */
export function getCircuitBreakerState(key: string): CircuitState {
  return circuitBreaker.state(key);
}

/** E2E helper to reset all breaker state between tests. */
export function resetAllCircuitBreakers(): void {
  circuitBreaker.resetAll();
}

export type { CircuitState };