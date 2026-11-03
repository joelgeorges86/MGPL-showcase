import { test, expect } from "@playwright/test";

/**
 * EPIC-FLEET-0001 — Hardware Specs Persistence & Device Profiles E2E Spec.
 *
 * Verifies full CRUD lifecycle, user isolation, and validation for user-scoped
 * hardware devices under `/api/devices`.
 */

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
const JORDAN = { email: "jordan.dev@mgpl.io", password: "SecureDev2026!" };

test.describe("EPIC-FLEET-0001 — Hardware Specs Persistence & Device Profiles", () => {
  test("1. Unauthenticated requests to /api/devices return 401", async ({ playwright }) => {
    const unauthCtx = await playwright.request.newContext();
    try {
      const res = await unauthCtx.get(`${BASE}/api/devices`);
      expect(res.status()).toBe(401);

      const postRes = await unauthCtx.post(`${BASE}/api/devices`, {
        data: { deviceName: "Unauthorized Rig", deviceType: "Desktop" },
      });
      expect(postRes.status()).toBe(401);
    } finally {
      await unauthCtx.dispose();
    }
  });

  test("2. Alex creates, retrieves, updates, and deletes a device profile", async ({
    playwright,
  }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      const login = await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });
      expect(login.status()).toBe(200);

      // Create new device profile
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: "Alex Main Station",
          deviceType: "Desktop",
          cpuModel: "AMD Ryzen 7 7800X3D",
          cpuCores: 8,
          ramGb: 32,
          gpuModel: "NVIDIA GeForce RTX 4080",
          vramGb: 16,
          gpuType: "Discrete",
          storageType: "NVMe SSD",
          storageFreeGb: 1024,
          isPortable: false,
        },
      });
      expect(createRes.status()).toBe(201);
      const createBody = await createRes.json();
      expect(createBody.device).toBeDefined();
      const deviceId = createBody.device.id;
      expect(deviceId).toBeDefined();
      expect(createBody.device.deviceName).toBe("Alex Main Station");
      expect(createBody.device.cpuCores).toBe(8);
      expect(createBody.device.ramGb).toBe(32);
      expect(createBody.device.vramGb).toBe(16);
      expect(createBody.device.isPortable).toBe(false);

      // Fetch single device
      const getRes = await alexCtx.get(`${BASE}/api/devices/${deviceId}`);
      expect(getRes.status()).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.device.id).toBe(deviceId);

      // Fetch list of devices
      const listRes = await alexCtx.get(`${BASE}/api/devices`);
      expect(listRes.status()).toBe(200);
      const listBody = await listRes.json();
      const found = listBody.devices.find((d: any) => d.id === deviceId);
      expect(found).toBeDefined();

      // Update device
      const patchRes = await alexCtx.patch(`${BASE}/api/devices/${deviceId}`, {
        data: {
          storageFreeGb: 512,
          isPortable: true,
        },
      });
      expect(patchRes.status()).toBe(200);
      const patchBody = await patchRes.json();
      expect(patchBody.device.storageFreeGb).toBe(512);
      expect(patchBody.device.isPortable).toBe(true);

      // Delete device
      const delRes = await alexCtx.delete(`${BASE}/api/devices/${deviceId}`);
      expect(delRes.status()).toBe(200);
      const delBody = await delRes.json();
      expect(delBody.success).toBe(true);

      // Verify device deleted
      const getDeleted = await alexCtx.get(`${BASE}/api/devices/${deviceId}`);
      expect(getDeleted.status()).toBe(404);
    } finally {
      await alexCtx.dispose();
    }
  });

  test("3. Jordan cannot access or mutate Alex's hardware device profiles", async ({
    playwright,
  }) => {
    const alexCtx = await playwright.request.newContext();
    const jordanCtx = await playwright.request.newContext();
    try {
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });
      await jordanCtx.post(`${BASE}/api/auth/login`, { data: JORDAN });

      // Alex creates a device
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: "Alex Private Handheld",
          deviceType: "Handheld",
          cpuModel: "Custom APU",
          ramGb: 16,
          isPortable: true,
        },
      });
      expect(createRes.status()).toBe(201);
      const alexDevice = (await createRes.json()).device;

      // Jordan lists devices - must not contain Alex's device
      const jordanListRes = await jordanCtx.get(`${BASE}/api/devices`);
      expect(jordanListRes.status()).toBe(200);
      const jordanList = (await jordanListRes.json()).devices;
      expect(jordanList.find((d: any) => d.id === alexDevice.id)).toBeUndefined();

      // Jordan attempts GET on Alex's device -> 404
      const jordanGetRes = await jordanCtx.get(`${BASE}/api/devices/${alexDevice.id}`);
      expect(jordanGetRes.status()).toBe(404);

      // Jordan attempts PATCH on Alex's device -> 404
      const jordanPatchRes = await jordanCtx.patch(`${BASE}/api/devices/${alexDevice.id}`, {
        data: { deviceName: "Hacked Device" },
      });
      expect(jordanPatchRes.status()).toBe(404);

      // Jordan attempts DELETE on Alex's device -> 404
      const jordanDeleteRes = await jordanCtx.delete(`${BASE}/api/devices/${alexDevice.id}`);
      expect(jordanDeleteRes.status()).toBe(404);
    } finally {
      await alexCtx.dispose();
      await jordanCtx.dispose();
    }
  });

  test("4. POST /api/devices rejects missing required fields (deviceName, deviceType)", async ({
    playwright,
  }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });

      const badRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: { cpuModel: "AMD Ryzen 9" },
      });
      expect(badRes.status()).toBe(400);
      const body = await badRes.json();
      expect(body.error).toContain("required");
    } finally {
      await alexCtx.dispose();
    }
  });

  test("5. Device profile persists across session rehydration and exports cleanly via /api/state/export", async ({
    playwright,
  }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });

      // Create a device profile for export verification
      const createRes = await alexCtx.post(`${BASE}/api/devices`, {
        data: {
          deviceName: "Alex Export Rig",
          deviceType: "Desktop",
          cpuModel: "Intel Core i9-14900K",
          ramGb: 64,
          gpuModel: "NVIDIA GeForce RTX 4090",
          vramGb: 24,
          isPortable: false,
        },
      });
      expect(createRes.status()).toBe(201);
      const device = (await createRes.json()).device;

      // Export state. AI-084 (#163): export is admin-only, so Alex gets 403 and
      // the seeded admin (test/global-setup.ts) exports Alex's row.
      const alexExport = await alexCtx.get(`${BASE}/api/state/export`);
      expect(alexExport.status()).toBe(403);
      const adminCtx = await playwright.request.newContext();
      let snapshot: any;
      try {
        const adminLogin = await adminCtx.post(`${BASE}/api/auth/login`, {
          data: { email: "admin.ops@mgpl.io", password: "AdminPass2026!" },
        });
        expect(adminLogin.status()).toBe(200);
        const exportRes = await adminCtx.get(`${BASE}/api/state/export`);
        expect(exportRes.status()).toBe(200);
        snapshot = await exportRes.json();
      } finally {
        await adminCtx.dispose();
      }

      expect(snapshot.version).toBe(1);
      expect(snapshot.data).toBeDefined();
      expect(Array.isArray(snapshot.data.appDevices)).toBe(true);

      const exportedDevice = snapshot.data.appDevices.find((d: any) => d.id === device.id);
      expect(exportedDevice).toBeDefined();
      expect(exportedDevice.deviceName).toBe("Alex Export Rig");
      expect(exportedDevice.vramGb).toBe(24);

      // Clean up created device
      await alexCtx.delete(`${BASE}/api/devices/${device.id}`);
    } finally {
      await alexCtx.dispose();
    }
  });
});
