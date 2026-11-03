import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeDeviceKey,
  setDpmHealth,
  getDpmHealthGauge,
  recordDpmCounter,
  getDpmCounters,
  renderDpmMetricsText,
  withDpmRetry,
  buildDpmFallbackPayload,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  logDpmDegraded,
} from '../../src/services/devicePlayability';

describe('devicePlayability: telemetry registry', () => {
  beforeEach(() => {
    setDpmHealth(true);
  });

  it('setDpmHealth / getDpmHealthGauge round-trip', () => {
    setDpmHealth(true);
    expect(getDpmHealthGauge()).toBe(1);
    setDpmHealth(false);
    expect(getDpmHealthGauge()).toBe(0);
  });

  it('recordDpmCounter increments known counters and ignores unknown names', () => {
    const before = getDpmCounters();
    recordDpmCounter('dpm_requests_total', 'health');
    recordDpmCounter('dpm_requests_total', 'metrics');
    recordDpmCounter('does_not_exist', 'nope');
    const after = getDpmCounters();
    expect(after.dpm_requests_total).toBe(before.dpm_requests_total + 2);
    expect(after.does_not_exist).toBeUndefined();
  });

  it('getDpmCounters returns a defensive snapshot (not the internal ref)', () => {
    const snap = getDpmCounters();
    (snap as Record<string, number>).dpm_errors_total = 9999;
    expect(getDpmCounters().dpm_errors_total).not.toBe(9999);
  });

  it('renderDpmMetricsText emits valid Prometheus exposition with a trailing newline', () => {
    const text = renderDpmMetricsText();
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('# TYPE dpm_health_status gauge');
    expect(text).toContain('# TYPE dpm_requests_total counter');
    expect(text).toMatch(/^dpm_requests_total \d+$/m);
    expect(text).toMatch(/^dpm_health_status [01]$/m);
  });
});

describe('devicePlayability: TTL cache', () => {
  beforeEach(() => {
    cacheInvalidate('dev-test');
    cacheInvalidate('local-host');
  });

  it('cacheSet then cacheGet returns the payload; cacheInvalidate removes it', () => {
    expect(cacheGet('playability:dev-test')).toBeNull();
    cacheSet('playability:dev-test', { tier: 'Optimal' });
    expect(cacheGet('playability:dev-test')).toEqual({ tier: 'Optimal' });
    cacheInvalidate('dev-test');
    expect(cacheGet('playability:dev-test')).toBeNull();
  });

  it('expired entries are evicted on read (fake timers)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      cacheSet('playability:dev-test', 'warm');
      expect(cacheGet('playability:dev-test')).toBe('warm');
      vi.advanceTimersByTime(61_000); // past 60s TTL
      expect(cacheGet('playability:dev-test')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('devicePlayability: normalizeDeviceKey', () => {
  it('maps the special-case ids and passes through everything else', () => {
    expect(normalizeDeviceKey(undefined)).toBe('local-host');
    expect(normalizeDeviceKey('steam-deck')).toBe('deck_h');
    expect(normalizeDeviceKey('custom')).toBe('custom-pc-5080');
    expect(normalizeDeviceKey('rig-ultra-4080')).toBe('rig-ultra-4080');
  });
});

describe('devicePlayability: withDpmRetry', () => {
  afterEach(() => {
    setDpmHealth(true);
  });

  it('returns the payload on the first successful attempt', () => {
    const result = withDpmRetry(() => 'ok', 2, 'unit-test');
    expect(result.ok).toBe(true);
    expect(result.payload).toBe('ok');
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(1);
  });

  it('retries a transient failure and succeeds on the second attempt', () => {
    let calls = 0;
    const result = withDpmRetry(() => {
      calls += 1;
      if (calls < 2) throw new Error('SQLITE_BUSY: database is locked');
      return 'recovered';
    }, 2, 'unit-test');
    expect(result.ok).toBe(true);
    expect(result.payload).toBe('recovered');
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('returns ok:false after exhausting attempts and counts the error', () => {
    const before = getDpmCounters().dpm_errors_total;
    const result = withDpmRetry(() => {
      throw new Error('boom');
    }, 2, 'unit-test');
    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.error).toBeInstanceOf(Error);
    expect(getDpmCounters().dpm_errors_total).toBe(before + 1);
  });
});

describe('devicePlayability: degraded-state fallback', () => {
  it('buildDpmFallbackPayload never fabricates specs', () => {
    const payload = buildDpmFallbackPayload(undefined);
    expect(payload.success).toBe(true);
    expect(payload.usingFallback).toBe(true);
    expect(payload.blockedSpecs).toBe(true);
    expect(payload.staleSpecs).toBe(false);
    expect(payload.deviceName).toBe('No Scanned Device');
    expect(payload.deviceSpecs).toMatchObject({
      ramGb: null,
      vramGb: null,
      batteryWh: null,
      tdpWatts: null,
      gpuModel: null,
      cpuModel: null,
    });
    expect(payload.games).toEqual([]);
  });

  it('logDpmDegraded increments the fallback counter and marks the gauge degraded', () => {
    const before = getDpmCounters().dpm_degraded_fallback_total;
    setDpmHealth(true);
    logDpmDegraded('playability', 'rig-ultra-4080', new Error('scan unavailable'));
    expect(getDpmCounters().dpm_degraded_fallback_total).toBe(before + 1);
    expect(getDpmHealthGauge()).toBe(0);
  });
});
