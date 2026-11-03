/**
 * Sprint 1B (EPICSEC06) — Device Playability Matrix (DPM) Observability,
 * Telemetry & Resilience Service.
 *
 * Central home for the DPM's resilience layer:
 *   1. Dependency-free Prometheus-compatible telemetry — counters plus a health
 *      gauge — rendered in text/plain exposition format by GET /api/dpm/metrics.
 *   2. Bounded retry wrapper (`withDpmRetry`) so a transient playability scan
 *      failure (e.g. SQLITE_BUSY during the GameDeviceProfiles upserts) is
 *      retried before the degraded-state fallback is served.
 *   3. TTL fallback cache keyed by normalized device id (hit/miss counters and
 *      LRU eviction), migrated out of src/routes/devices.ts.
 *   4. Structured, sanitized degraded-state logging — every error message is
 *      passed through safeErrorMessage before it reaches a log line or a
 *      response body (Privacy Shield sanitization).
 *
 * No raw stack traces, filesystem paths, or unmasked user data ever leave this
 * module in a log line or a metrics payload.
 */
import { safeErrorMessage } from '../utils/errorSanitizer';

// ---------------------------------------------------------------------------
// Prometheus-compatible metric registry (dependency-free)
// ---------------------------------------------------------------------------

const COUNTER_DEFS: Readonly<Record<string, { help: string }>> = {
  dpm_requests_total: {
    help: 'Total DPM playability/health requests received.',
  },
  dpm_cache_hits_total: {
    help: 'DPM playability TTL cache hits.',
  },
  dpm_cache_misses_total: {
    help: 'DPM playability TTL cache misses.',
  },
  dpm_degraded_fallback_total: {
    help: 'DPM degraded-state fallback responses served (no 5xx).',
  },
  dpm_retries_total: {
    help: 'DPM playability compute retries triggered after a transient failure.',
  },
  dpm_errors_total: {
    help: 'DPM playability errors escalated past retry to the degraded fallback.',
  },
  dpm_rejected_total: {
    help: 'DPM requests rejected by validation or rate limiting.',
  },
};

const counters: Record<string, number> = {};
for (const name of Object.keys(COUNTER_DEFS)) {
  counters[name] = 0;
}

let healthStatusGauge = 1;

/** Mark the DPM healthy (1) or degraded (0) for the health gauge. */
export function setDpmHealth(healthy: boolean): void {
  healthStatusGauge = healthy ? 1 : 0;
}

/** Increment a registered DPM counter (no-op for unknown names). */
export function recordDpmCounter(name: string, _route: string): void {
  if (Object.prototype.hasOwnProperty.call(COUNTER_DEFS, name)) {
    counters[name] += 1;
  }
}

/** Snapshot of the current counter values (keys are stable metric names). */
export function getDpmCounters(): Readonly<Record<string, number>> {
  return { ...counters };
}

/** Current DPM health gauge value (1 = healthy, 0 = degraded). */
export function getDpmHealthGauge(): number {
  return healthStatusGauge;
}

/**
 * Render the DPM metrics in Prometheus text/plain exposition format (v0.0.4).
 * Safe by construction: only static metric names, integer values, and fixed
 * HELP strings are emitted — never request data or raw error text.
 */
export function renderDpmMetricsText(): string {
  const lines: string[] = [];
  const gaugeName = 'dpm_health_status';
  lines.push(
    '# HELP dpm_health_status 1 when the DPM last served a healthy playability result, 0 when degraded.',
  );
  lines.push(`# TYPE ${gaugeName} gauge`);
  lines.push(`${gaugeName} ${healthStatusGauge}`);
  for (const [name, def] of Object.entries(COUNTER_DEFS)) {
    lines.push(`# HELP ${name} ${def.help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${counters[name]}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// TTL fallback cache (migrated from src/routes/devices.ts, DPM-10)
// ---------------------------------------------------------------------------

const PLAYABILITY_CACHE_TTL_MS = 60_000;
const PLAYABILITY_CACHE_MAX_ENTRIES = 200;
const playabilityCache = new Map<string, { expiresAt: number; payload: unknown }>();

/** Normalize a caller-supplied device id into its canonical cache key. */
export function normalizeDeviceKey(id: string | undefined): string {
  if (!id || id === 'steam-deck') return id === 'steam-deck' ? 'deck_h' : 'local-host';
  if (id === 'custom') return 'custom-pc-5080';
  return id;
}

/** Read a warm payload from the TTL cache (expired entries are evicted). */
export function cacheGet(key: string): unknown | null {
  const hit = playabilityCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    playabilityCache.delete(key);
    return null;
  }
  return hit.payload;
}

/** Store a payload in the TTL cache, evicting the oldest entry when full. */
export function cacheSet(key: string, payload: unknown): void {
  playabilityCache.set(key, { expiresAt: Date.now() + PLAYABILITY_CACHE_TTL_MS, payload });
  if (playabilityCache.size > PLAYABILITY_CACHE_MAX_ENTRIES) {
    const oldest = playabilityCache.keys().next().value;
    if (oldest) playabilityCache.delete(oldest);
  }
}

/** Invalidate the playability cache entries for a device write (upsert/scan). */
export function cacheInvalidate(id: string): void {
  const key = normalizeDeviceKey(id);
  playabilityCache.delete(`playability:${key}`);
  playabilityCache.delete(`playable:${key}`);
}

// ---------------------------------------------------------------------------
// Bounded retry wrapper
// ---------------------------------------------------------------------------

export interface RetryResult<T> {
  ok: boolean;
  payload: T | null;
  error: unknown;
  attempts: number;
}

/**
 * Run `fn` with up to `attempts` executions. A throw is retried immediately
 * (transient SQLITE_BUSY / cold-cache failures) and the retry is counted in
 * DPM telemetry. When every attempt fails, `ok:false` is returned so the route
 * can serve the degraded-state fallback instead of throwing a 5xx.
 */
export function withDpmRetry<T>(
  fn: () => T,
  attempts = 2,
  route = 'playability',
): RetryResult<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, payload: fn(), error: null, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt > 1) recordDpmCounter('dpm_retries_total', route);
      if (attempt < attempts) {
        console.warn(
          `[dpm] ${route} attempt ${attempt}/${attempts} failed, retrying: ${safeErrorMessage(err)}`,
        );
      }
    }
  }
  recordDpmCounter('dpm_errors_total', route);
  return { ok: false, payload: null, error: lastError, attempts };
}

// ---------------------------------------------------------------------------
// Degraded-state fallback payload
// ---------------------------------------------------------------------------

/**
 * Build the well-formed "No Scanned Device" fallback payload. Specs stay null —
 * never fabricated — so the UI renders a blocked "Refresh device scan required"
 * state (Anti-Stale Input Rule, Ch. 22.6) instead of trusting guessed hardware.
 */
export function buildDpmFallbackPayload(
  deviceId: string | undefined,
): Record<string, unknown> {
  const normalized = deviceId || 'local-host';
  return {
    success: true,
    deviceId: normalized,
    deviceName: 'No Scanned Device',
    usingFallback: true,
    staleSpecs: false,
    blockedSpecs: true,
    deviceSpecs: {
      ramGb: null,
      vramGb: null,
      batteryWh: null,
      tdpWatts: null,
      formFactor: 'Desktop',
      gpuModel: null,
      cpuModel: null,
    },
    games: [],
  };
}

/**
 * Log a structured degraded-state warning (sanitized — no stacks/paths/PII),
 * count it in telemetry, and mark the DPM health gauge as degraded.
 */
export function logDpmDegraded(
  route: string,
  deviceId: string | undefined,
  error: unknown,
): void {
  recordDpmCounter('dpm_degraded_fallback_total', route);
  setDpmHealth(false);
  console.warn(
    `[dpm] ${route} degraded-state fallback served for device "${normalizeDeviceKey(
      deviceId,
    )}": ${safeErrorMessage(error, 'unavailable')}`,
  );
}
