import { test, expect } from '@playwright/test';

/**
 * EPIC-FLEET-0001 — Hardware Compatibility Engine & Multi-Axis Headroom E2E Spec.
 *
 * Verifies compatibility calculation under `/api/devices/:deviceId/compatibility/:gameId`.
 * Tests optimal ratings, battery saver performance penalties, missing specs, and user isolation.
 */

const BASE = 'http://localhost:4000';

const ALEX = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };
const JORDAN = { email: 'jordan.dev@mgpl.io', password: 'SecureDev2026!' };

test.describe('EPIC-FLEET-0001 — Hardware Compatibility & Multi-Axis Headroom Engine', () => {
  test('1. Unauthenticated compatibility requests return 401', async ({ playwright }) => {
    const unauthCtx = await playwright.request.newContext();
    try {
      const res = await unauthCtx.post(`${BASE}/api/devices/dev-123/compatibility/CYBERPUNK2077`, {
        data: {},
      });
      expect(res.status()).toBe(401);
    } finally {
      await unauthCtx.dispose();
    }
  });

  test('2. Alex evaluates high-end desktop against Cyberpunk 2077 (Optimal)', async ({ playwright }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      const login = await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });
      expect(login.status()).toBe(200);

      // Create high-end desktop device
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: 'Alex Titan Rig',
          deviceType: 'Desktop',
          cpuModel: 'AMD Ryzen 7 7800X3D',
          cpuCores: 8,
          ramGb: 32,
          gpuModel: 'NVIDIA GeForce RTX 4080',
          vramGb: 16,
          gpuType: 'Discrete',
          storageType: 'NVMe SSD',
          storageFreeGb: 500,
          isPortable: false,
        },
      });
      expect(createRes.status()).toBe(201);
      const deviceId = (await createRes.json()).device.id;

      // Evaluate compatibility against CYBERPUNK2077
      const evalRes = await alexCtx.post(`${BASE}/api/devices/${deviceId}/compatibility/CYBERPUNK2077`, {
        data: { powerProfile: 'Plugged-In' },
      });
      expect(evalRes.status()).toBe(200);
      const body = await evalRes.json();

      expect(body.deviceId).toBe(deviceId);
      expect(body.deviceName).toBe('Alex Titan Rig');
      expect(body.gameId).toBeDefined();
      expect(body.evaluation).toBeDefined();

      const { evaluation } = body;
      expect(evaluation.rating).toBe('Optimal');
      expect(evaluation.primaryBottleneck).toBeNull();
      expect(evaluation.powerProfile).toBe('Plugged-In');
      expect(evaluation.axes.ram.status).toBe('optimal');
      expect(evaluation.axes.vram.status).toBe('optimal');
      expect(evaluation.axes.storage.status).toBe('optimal');
      // DPM-01: the seeded catalog carries no per-game "Min CPU Cores" data, so
      // the CPU axis is honestly "not evaluated" (missing) instead of applying a
      // universal 4-core bar — it must never manufacture a CPU bottleneck.
      expect(evaluation.axes.cpu.status).toBe('missing');
      expect(evaluation.axes.cpu.requiredValue).toBeNull();

      // Cleanup
      await alexCtx.delete(`${BASE}/api/devices/${deviceId}`);
    } finally {
      await alexCtx.dispose();
    }
  });

  test('3. Alex evaluates portable handheld with Battery Saver penalty (TDP scaling)', async ({ playwright }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });

      // Create portable handheld with marginal RAM (e.g. 12GB)
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: 'Alex Steam Deck',
          deviceType: 'Handheld',
          cpuModel: 'Custom APU',
          cpuCores: 4,
          ramGb: 12,
          gpuModel: 'Custom RDNA2',
          vramGb: 4,
          gpuType: 'Integrated',
          storageType: 'eMMC',
          storageFreeGb: 100,
          isPortable: true,
        },
      });
      expect(createRes.status()).toBe(201);
      const deviceId = (await createRes.json()).device.id;

      // Evaluate compatibility with Battery Saver mode
      const evalRes = await alexCtx.post(`${BASE}/api/devices/${deviceId}/compatibility/CYBERPUNK2077`, {
        data: { powerProfile: 'Battery Saver' },
      });
      expect(evalRes.status()).toBe(200);
      const body = await evalRes.json();
      const { evaluation } = body;

      expect(evaluation.powerProfile).toBe('Battery Saver');
      expect(evaluation.notes.some((n: string) => n.includes('Battery Saver'))).toBe(true);

      // Cleanup
      await alexCtx.delete(`${BASE}/api/devices/${deviceId}`);
    } finally {
      await alexCtx.dispose();
    }
  });

  test('4. Incomplete device specs return "Incomplete Specs" status with re-scan note', async ({ playwright }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });

      // Create device missing VRAM and RAM specs
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: 'Incomplete PC',
          deviceType: 'Desktop',
          cpuModel: 'Intel Core i5',
          isPortable: false,
        },
      });
      expect(createRes.status()).toBe(201);
      const deviceId = (await createRes.json()).device.id;

      const evalRes = await alexCtx.post(`${BASE}/api/devices/${deviceId}/compatibility/CYBERPUNK2077`);
      expect(evalRes.status()).toBe(200);
      const body = await evalRes.json();
      const { evaluation } = body;

      expect(evaluation.rating).toBe('Incomplete Specs');
      expect(evaluation.notes.some((n: string) => n.includes('Missing device specification fields'))).toBe(true);

      // Cleanup
      await alexCtx.delete(`${BASE}/api/devices/${deviceId}`);
    } finally {
      await alexCtx.dispose();
    }
  });

  test('5. Jordan cannot calculate compatibility for Alex\'s device', async ({ playwright }) => {
    const alexCtx = await playwright.request.newContext();
    const jordanCtx = await playwright.request.newContext();
    try {
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });
      await jordanCtx.post(`${BASE}/api/auth/login`, { data: JORDAN });

      // Alex creates a device
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: 'Alex Isolated PC',
          deviceType: 'Desktop',
          ramGb: 16,
          isPortable: false,
        },
      });
      const alexDeviceId = (await createRes.json()).device.id;

      // Jordan attempts to run compatibility check on Alex's device -> 404
      const jordanEval = await jordanCtx.post(`${BASE}/api/devices/${alexDeviceId}/compatibility/CYBERPUNK2077`);
      expect(jordanEval.status()).toBe(404);

      // Cleanup
      await alexCtx.delete(`${BASE}/api/devices/${alexDeviceId}`);
    } finally {
      await alexCtx.dispose();
      await jordanCtx.dispose();
    }
  });
});
