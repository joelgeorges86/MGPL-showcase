/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Shared adapter request layer.
 *
 * Wraps the codebase's `safeFetchJSON` (2.5s timeout + its own single retry)
 * with an explicit exponential-backoff budget and a per-adapter sliding-window
 * rate limiter. Every call is non-throwing and resolves to `fallback` on the
 * final failed attempt, so adapters can always degrade to deterministic
 * synthesis instead of 500ing.
 */

export interface BackoffOptions {
  /** Initial backoff between attempts in ms (doubles each retry). */
  baseDelayMs?: number;
  /** Hard cap for a single backoff sleep in ms. */
  maxDelayMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseDelayMs: 250,
  maxDelayMs: 8000,
  attempts: 3,
};

const FETCH_TIMEOUT_MS = 2500;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch + parse JSON with a 2.5s timeout; resolves to null on any failure. */
async function fetchOnce<T>(url: string, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...(init || {}), signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetch + parse JSON with a bounded exponential-backoff retry budget built on
 * the shared `safeFetchJSON` primitive. Resolves to `fallback` (never throws).
 * An optional `init` supports headers (e.g. API keys) while keeping the same
 * timeout/backoff guarantees.
 */
export async function safeFetchJSONWithBackoff<T = unknown>(
  url: string,
  opts: BackoffOptions = {},
  fallback: T | null = null,
  init?: RequestInit,
): Promise<T | null> {
  const cfg: Required<BackoffOptions> = { ...DEFAULT_BACKOFF, ...opts };
  let delay = cfg.baseDelayMs;
  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    const result = await fetchOnce<T>(url, init);
    if (result !== null) return result;
    if (attempt < cfg.attempts) {
      await sleep(Math.min(delay, cfg.maxDelayMs));
      delay *= 2;
    }
  }
  return fallback;
}

/**
 * Sliding-window rate limiter: at most `maxPerSecond` acquires per 1s window.
 * Callers `await limiter.acquire()` before each upstream request so bursts are
 * queued instead of hammering the provider.
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerSecond: number) {
    this.maxPerSecond = Math.max(1, Math.floor(maxPerSecond));
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);
    if (this.timestamps.length >= this.maxPerSecond) {
      const oldest = this.timestamps[0];
      const wait = 1000 - (now - oldest);
      if (wait > 0) await sleep(wait);
    }
    this.timestamps.push(Date.now());
  }
}
