import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Circuit-breaker state machine tests.
 *
 * The thresholds/backoffs are read from the environment at MODULE LOAD time, so
 * we set deterministic values BEFORE the first dynamic import and restore the
 * original env afterwards. Zero backoff + threshold 2 makes the CLOSED→OPEN
 * transition deterministic and instant.
 */
const ORIG_ENV: Record<string, string | undefined> = {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_BACKOFF_MS: process.env.CIRCUIT_BREAKER_BACKOFF_MS,
  CIRCUIT_BREAKER_MAX_BACKOFF_MS: process.env.CIRCUIT_BREAKER_MAX_BACKOFF_MS,
  CIRCUIT_BREAKER_RESET_MS: process.env.CIRCUIT_BREAKER_RESET_MS,
};

type BreakerModule = typeof import('../../src/utils/storefrontCircuitBreaker');
let breaker: BreakerModule;

beforeAll(async () => {
  process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '2';
  process.env.CIRCUIT_BREAKER_BACKOFF_MS = '0';
  process.env.CIRCUIT_BREAKER_MAX_BACKOFF_MS = '0';
  process.env.CIRCUIT_BREAKER_RESET_MS = '60000';
  breaker = await import('../../src/utils/storefrontCircuitBreaker');
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('storefrontCircuitBreaker', () => {
  it('starts CLOSED and resets cleanly', () => {
    breaker.resetAllCircuitBreakers();
    expect(breaker.getCircuitBreakerState('steam')).toBe('CLOSED');
  });

  it('transitions OPEN after the failure threshold', async () => {
    breaker.resetAllCircuitBreakers();
    const fail = async () => {
      throw new Error('upstream 500');
    };
    await breaker.fetchWithCircuitBreaker('steam', fail);
    expect(breaker.getCircuitBreakerState('steam')).toBe('CLOSED');
    await breaker.fetchWithCircuitBreaker('steam', fail);
    expect(breaker.getCircuitBreakerState('steam')).toBe('OPEN');
  });

  it('short-circuits while OPEN without calling the fetcher', async () => {
    breaker.resetAllCircuitBreakers();
    const fail = async () => {
      throw new Error('boom');
    };
    await breaker.fetchWithCircuitBreaker('steam', fail);
    await breaker.fetchWithCircuitBreaker('steam', fail);
    expect(breaker.getCircuitBreakerState('steam')).toBe('OPEN');

    let called = 0;
    const res = await breaker.fetchWithCircuitBreaker('steam', async () => {
      called += 1;
      return 'data';
    });
    expect(res.ok).toBe(false);
    expect(called).toBe(0);
    expect(res.circuit).toBe('OPEN');
  });

  it('serves the last-good stale snapshot when the circuit is OPEN', async () => {
    breaker.resetAllCircuitBreakers();
    // Prime a snapshot directly (as a prior successful call would have cached).
    breaker.circuitBreaker.primeSnapshot('steam', { stale: true });
    const fail = async () => {
      throw new Error('boom');
    };
    await breaker.fetchWithCircuitBreaker('steam', fail);
    await breaker.fetchWithCircuitBreaker('steam', fail);
    const res = await breaker.fetchWithCircuitBreaker('steam', fail);
    expect(res.ok).toBe(false);
    expect((res as any).stale).toEqual({ stale: true });
  });

  it('records success, caches payload, and stays CLOSED', async () => {
    breaker.resetAllCircuitBreakers();
    const res = await breaker.fetchWithCircuitBreaker('steam', async () => ({ ok: 1 }));
    expect(res.ok).toBe(true);
    expect(breaker.getCircuitBreakerState('steam')).toBe('CLOSED');
  });
});
