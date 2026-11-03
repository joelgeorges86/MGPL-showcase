import { test, expect } from '@playwright/test';

/**
 * Sprint 35 (FEAT-0169-V1-RELEASE-GATE) - Container & Production Release Gate Tests
 */

test.describe('Release Gate (v1.0.0) & Health Probes', () => {
  test('GET /healthz returns 200 OK and healthy status with database connectivity', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.database).toBe('connected');
    expect(body.version).toBe('1.0.0');
    expect(typeof body.uptime).toBe('number');
  });

  test('GET /livez returns 200 OK alive probe', async ({ request }) => {
    const res = await request.get('/livez');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('alive');
  });

  test('Security headers are active on responses', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);

    const headers = res.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });
});
