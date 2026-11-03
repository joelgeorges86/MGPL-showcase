import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import type { AddressInfo } from "net";
import express from "express";

// AI-082 (#161): the routes that scan the server's own hardware run only in
// local development and tests. On a hosted site (NODE_ENV production, staging
// or anything else) they answer 404 before the devices or Hardware Explorer
// routers are reached, and GET /api/host-scan/status reports enabled: false.

type Captured = { status: number; body: unknown; nextCalled: boolean };

async function call(method: string, url: string): Promise<Captured> {
  const { default: router } = await import("../../src/middleware/hostScan");
  return new Promise((resolve) => {
    const captured: Captured = { status: 200, body: undefined, nextCalled: false };
    const req = { method, url, originalUrl: url, path: url, headers: {}, body: {} };
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: unknown) {
        captured.body = body;
        resolve(captured);
        return res;
      },
    };
    (router as unknown as (rq: unknown, rs: unknown, nx: () => void) => void)(req, res, () => {
      captured.nextCalled = true;
      resolve(captured);
    });
  });
}

const SCAN_ROUTES = ["/api/devices/scan", "/api/devices/scan-local", "/api/scan"];

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
}

describe("host scan guard (AI-082)", () => {
  // Load the module once, with a generous limit, before the timed tests: a cold
  // import can take several seconds on a loaded machine (WU-011, 2026-10-06).
  beforeAll(async () => {
    await import("../../src/middleware/hostScan");
  }, 60_000);

  const original = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setNodeEnv(original);
  });

  it("enables the scan only for local development and tests", async () => {
    const { hostScanEnabled } = await import("../../src/middleware/hostScan");
    for (const env of [undefined, "", "development", "test"]) {
      expect(hostScanEnabled(env), String(env)).toBe(true);
    }
    for (const env of ["production", "staging", "Production", "test ", "prod", "release"]) {
      expect(hostScanEnabled(env), env).toBe(false);
    }
  });

  for (const env of ["production", "staging"]) {
    it(`answers 404 on every scan route, before any router, when NODE_ENV=${env}`, async () => {
      setNodeEnv(env);
      for (const url of SCAN_ROUTES) {
        const r = await call("POST", url);
        expect(r.nextCalled, url).toBe(false);
        expect(r.status, url).toBe(404);
        expect(r.body, url).toMatchObject({ success: false, code: "HOST_SCAN_DISABLED" });
      }
      const status = await call("GET", "/api/host-scan/status");
      expect(status.body).toEqual({ success: true, enabled: false });
    });
  }

  for (const env of [undefined, "development", "test"]) {
    it(`passes the scan routes on when NODE_ENV=${String(env)}`, async () => {
      setNodeEnv(env);
      for (const url of SCAN_ROUTES) {
        expect((await call("POST", url)).nextCalled, url).toBe(true);
      }
      const status = await call("GET", "/api/host-scan/status");
      expect(status.body).toEqual({ success: true, enabled: true });
    });
  }

  it("leaves every other route alone, on a hosted site too", async () => {
    setNodeEnv("production");
    for (const [method, url] of [
      ["POST", "/api/devices/upsert"],
      ["POST", "/api/devices"],
      ["GET", "/api/devices/scan"],
      ["GET", "/api/hardware/explorer"],
      ["POST", "/api/hardware/compatibility"],
    ]) {
      expect((await call(method, url)).nextCalled, `${method} ${url}`).toBe(true);
    }
  });

  // Express's "/api/devices" and "/api" mounts also accept a doubled slash, a
  // trailing slash and any case before handing "/scan" to the router below, so
  // the guard must block those spellings too. This mounts the guard and two
  // stand-in routers the way src/index.ts mounts the real ones, and sends real
  // requests (Codex pre-dispatch audit of WU-015, 2026-10-07, finding 1).
  it("blocks every spelling that Express routes to a scan handler, on a hosted site", async () => {
    setNodeEnv("production");
    const { default: guard } = await import("../../src/middleware/hostScan");
    const reached: string[] = [];
    const devices = express.Router();
    devices.post("/scan", (_q, r) => {
      reached.push("devices/scan");
      r.json({ success: true });
    });
    devices.post("/scan-local", (_q, r) => {
      reached.push("devices/scan-local");
      r.json({ success: true });
    });
    const explorer = express.Router();
    explorer.post("/scan", (_q, r) => {
      reached.push("scan");
      r.json({ success: true });
    });
    const app = express();
    app.use(guard);
    app.use("/api/devices", devices);
    app.use("/api", explorer);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const url of [
        "/api/devices/scan",
        "/api/devices//scan",
        "/api/devices/scan/",
        "/api/DEVICES/Scan",
        "/api/devices//scan-local",
        "/api/devices/scan-local/",
        "/api/scan",
        "/api//scan",
        "/api/scan/",
        "/API/SCAN",
        "/api/devices/%73can",
      ]) {
        const res = await fetch(base + url, { method: "POST" });
        expect(res.status, url).toBe(404);
        expect(await res.json(), url).toMatchObject({ code: "HOST_SCAN_DISABLED" });
      }
      expect(reached).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("is mounted in src/index.ts before the devices and Hardware Explorer routers", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/index.ts"), "utf8");
    const guard = source.indexOf("app.use(hostScanRouter);");
    expect(guard, "app.use(hostScanRouter); in src/index.ts").toBeGreaterThan(-1);
    for (const mount of [
      'app.use("/api/devices", devicePricingRouter);',
      'app.use("/api/devices", devicesRouter);',
      'app.use("/api", hardwareExplorerRouter);',
    ]) {
      const at = source.indexOf(mount);
      expect(at, mount).toBeGreaterThan(-1);
      expect(guard, mount).toBeLessThan(at);
    }
  });
});
