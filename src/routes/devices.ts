import { Router, Request, Response } from "express";
import si from "systeminformation";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import { shutdownCheckpoint } from "../lib/shutdown";
import path from "path";
import rateLimit from "express-rate-limit";
import { sendApiError } from "../middleware/errorSanitizer";
import { safeCoerce } from "../utils/ingest";
import { safeErrorMessage } from "../utils/errorSanitizer";
import {
  cacheGet,
  cacheSet,
  cacheInvalidate,
  normalizeDeviceKey,
  recordDpmCounter,
  setDpmHealth,
  withDpmRetry,
  buildDpmFallbackPayload,
  logDpmDegraded,
} from "../services/devicePlayability";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const dbWrite: DatabaseType = openDatabase(dbPath);

const router = Router();

// DPM-06: hardware-spec freshness contract. A scanned/upserted device row
// records its last scan timestamp; a row that was never scanned, or whose scan
// is older than this window, is surfaced as stale so stale specs can never
// silently drive DPM ratings (Anti-Stale Input Rule, Ch. 22.6).
const DEVICE_SPECS_STALE_DAYS = 30;

function deviceSpecsStale(lastScanAt: string | null | undefined): boolean {
  if (!lastScanAt) return true;
  const ts = new Date(lastScanAt).getTime();
  if (Number.isNaN(ts)) return true;
  return (Date.now() - ts) / 86400000 > DEVICE_SPECS_STALE_DAYS;
}

// Sprint 1B (EPICSEC06): the DPM-10 TTL fallback cache, device-key
// normalization, bounded retry, telemetry counters, and the degraded-state
// fallback payload now live in src/services/devicePlayability.ts so every DPM
// route shares one observable, sanitized implementation.

// DPM-12 (No Scanned Device state): the well-formed fallback profile returned
// whenever a playability request targets a device id that has never been
// scanned (empty fleet, unknown id, or a failed system scan). Specs are kept
// as `null` — never fabricated — so the UI surfaces a blocked/"Refresh device
// scan required" state (Anti-Stale Input Rule, Ch. 22.6) instead of trusting
// guessed hardware or throwing a 5xx.
interface DefaultFallbackProfile {
  synthetic: boolean;
  deviceId: string;
  deviceName: string;
  formFactor: string;
  gpuModel: string | null;
  ramGb: number | null;
  vramGb: number | null;
  cpuModel: string | null;
  batteryWh: number | null;
  tdpWatts: number | null;
}

const DEFAULT_FALLBACK_PROFILE: DefaultFallbackProfile = {
  synthetic: true,
  deviceId: "local-host",
  deviceName: "No Scanned Device",
  formFactor: "Desktop",
  gpuModel: null,
  ramGb: null,
  vramGb: null,
  cpuModel: null,
  batteryWh: null,
  tdpWatts: null,
};

// Sprint 1B (EPICSEC06): strict per-route rate limiting for the public DPM
// playability endpoints. This is a cheap in-memory guard layered on top of the
// global /api limiter and is independently observable via the standard
// RateLimit-* response headers. DPM_PLAYABILITY_LIMIT overrides the default so
// the E2E harness can keep the suite hermetic without weakening the shipped
// default.
const DPM_PLAYABILITY_LIMIT = 120;
const dpmPlayabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.DPM_PLAYABILITY_LIMIT) || DPM_PLAYABILITY_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many playability requests. Try again shortly." },
});

/**
 * Interface for device upsert data
 */
interface DeviceUpsertData {
  deviceId: string;
  deviceName: string;
  formFactor: string;
  gpuModel: string;
  vramGb: number;
  cpuModel: string;
  ramGb?: number;
  motherboard?: string;
  caseModel?: string;
  psu?: string;
  storageCapacityGb?: number;
  os?: string;
  batteryWh: number;
  isArchived?: boolean;
  archivedAt?: string | null;
}

/**
 * Interface for device response
 */
interface DeviceResponse {
  success: boolean;
  device: {
    deviceId: string;
    deviceName: string | null;
    formFactor: string | null;
    gpuModel: string | null;
    vramGb: number | null;
    cpuModel: string | null;
    ramGb?: number | null;
    motherboard?: string | null;
    caseModel?: string | null;
    psu?: string | null;
    storageCapacityGb?: number | null;
    os?: string | null;
    batteryWh: number | null;
    isArchived?: boolean;
    archivedAt?: string | null;
  };
}

/**
 * Ensure Devices table exists with proper schema
 */
function ensureDevicesTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS "Devices" (
        "deviceId" TEXT PRIMARY KEY,
        "deviceName" TEXT,
        "formFactor" TEXT,
        "gpuModel" TEXT,
        "vramGb" REAL,
        "cpuModel" TEXT,
        "ramGb" REAL,
        "motherboard" TEXT,
        "caseModel" TEXT,
        "psu" TEXT,
        "storageCapacityGb" REAL,
        "os" TEXT,
        "batteryWh" REAL,
        "isArchived" INTEGER DEFAULT 0,
        "archivedAt" TEXT,
        "createdAt" TEXT DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TEXT DEFAULT CURRENT_TIMESTAMP,
        "lastScanAt" TEXT
      )
    `,
      )
      .run();

    // Migration check: check if missing columns exist, add if missing
    const pragma = dbWrite.prepare('PRAGMA table_info("Devices")').all() as Array<{ name: string }>;
    const columnNames = pragma.map((col) => col.name);

    const missingCols: Record<string, string> = {
      ramGb: "REAL",
      motherboard: "TEXT",
      caseModel: "TEXT",
      psu: "TEXT",
      storageCapacityGb: "REAL",
      os: "TEXT",
      tdpWatts: "REAL",
      isArchived: "INTEGER DEFAULT 0",
      archivedAt: "TEXT",
      lastScanAt: "TEXT",
      // Sprint 5 (EPICUX05): Hardware Explorer 2.0 rig-telemetry persistence.
      cpuCores: "INTEGER",
      storageType: "TEXT",
      storageFreeGb: "REAL",
      scanConfidence: "TEXT",
      deviceClass: "TEXT",
      thermalCapabilities: "TEXT",
    };

    for (const [col, type] of Object.entries(missingCols)) {
      if (!columnNames.includes(col)) {
        dbWrite.prepare(`ALTER TABLE "Devices" ADD COLUMN "${col}" ${type}`).run();
      }
    }

    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS "GameDeviceProfiles" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "gameId" TEXT NOT NULL,
        "deviceId" TEXT NOT NULL,
        "estimatedBatteryRuntime" REAL,
        "isPluggedOnly" INTEGER DEFAULT 0,
        "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("gameId", "deviceId")
      )
    `,
      )
      .run();

    dbWrite
      .prepare(`CREATE INDEX IF NOT EXISTS "idx_devices_isArchived" ON "Devices"("isArchived")`)
      .run();
    dbWrite
      .prepare(`CREATE INDEX IF NOT EXISTS "idx_devices_updatedAt" ON "Devices"("updatedAt")`)
      .run();
    dbWrite
      .prepare(`CREATE INDEX IF NOT EXISTS "idx_appgames_active" ON "AppGames"("Active")`)
      .run();
  } catch (e) {
    console.error("Failed to ensure Devices table:", safeErrorMessage(e));
  }
}

/**
 * POST /api/devices/upsert
 * Upserts a device into the Devices table.
 */
router.post("/upsert", (req: Request, res: Response) => {
  try {
    const {
      deviceId,
      deviceName,
      formFactor,
      gpuModel,
      vramGb,
      cpuModel,
      ramGb,
      motherboard,
      caseModel,
      psu,
      storageCapacityGb,
      os,
      batteryWh,
    } = req.body as Partial<DeviceUpsertData>;

    // Validate required fields
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: "deviceId is required",
      });
    }

    // Ensure table exists
    ensureDevicesTable();

    // Upsert the device using prepared statement. lastScanAt records the
    // freshness of these specs (DPM-06) and is refreshed on every write.
    const stmt = dbWrite.prepare(`
      INSERT INTO "Devices" (deviceId, deviceName, formFactor, gpuModel, vramGb, cpuModel, ramGb, motherboard, caseModel, psu, storageCapacityGb, os, batteryWh, updatedAt, lastScanAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(deviceId) DO UPDATE SET
        deviceName = excluded.deviceName,
        formFactor = excluded.formFactor,
        gpuModel = excluded.gpuModel,
        vramGb = excluded.vramGb,
        cpuModel = excluded.cpuModel,
        ramGb = excluded.ramGb,
        motherboard = excluded.motherboard,
        caseModel = excluded.caseModel,
        psu = excluded.psu,
        storageCapacityGb = excluded.storageCapacityGb,
        os = excluded.os,
        batteryWh = excluded.batteryWh,
        updatedAt = CURRENT_TIMESTAMP,
        lastScanAt = CURRENT_TIMESTAMP
    `);

    const parseNum = (val: any): number | null => {
      if (val === undefined || val === null || val === "") return null;
      const num = typeof val === "string" ? parseFloat(val) : Number(val);
      return isNaN(num) ? null : num;
    };

    const parsedVram = parseNum(vramGb);
    const parsedRam = parseNum(ramGb);
    const parsedStorage = parseNum(storageCapacityGb);
    const parsedBattery = parseNum(batteryWh);

    stmt.run(
      deviceId,
      deviceName || null,
      formFactor || null,
      gpuModel || null,
      parsedVram,
      cpuModel || null,
      parsedRam,
      motherboard || null,
      caseModel || null,
      psu || null,
      parsedStorage,
      os || null,
      parsedBattery,
    );

    // DPM-10: any write invalidates this device's cached playability scans.
    cacheInvalidate(deviceId);

    const response: DeviceResponse = {
      success: true,
      device: {
        deviceId,
        deviceName: deviceName || null,
        formFactor: formFactor || null,
        gpuModel: gpuModel || null,
        vramGb: parsedVram,
        cpuModel: cpuModel || null,
        ramGb: parsedRam,
        motherboard: motherboard || null,
        caseModel: caseModel || null,
        psu: psu || null,
        storageCapacityGb: parsedStorage,
        os: os || null,
        batteryWh: parsedBattery,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Device upsert error:", safeErrorMessage(error));
    sendApiError(res, 500, "Failed to upsert device");
  }
});

const handleSystemScan = async (_req: Request, res: Response) => {
  try {
    ensureDevicesTable();

    const [cpu, mem, graphics] = await Promise.all([
      si.cpu().catch(() => ({ manufacturer: "Generic", brand: "x86 Processor" })),
      si.mem().catch(() => ({ total: 16 * 1024 ** 3 })),
      si.graphics().catch(() => ({ controllers: [] })),
    ]);

    const gpuInfo = graphics?.controllers?.[0]; // Take the first GPU

    const ramGbNum = mem?.total ? Math.round((mem.total / 1024 ** 3) * 10) / 10 : 16;
    const cpuName = [cpu?.manufacturer, cpu?.brand].filter(Boolean).join(" ") || "Local CPU";
    const gpuName = gpuInfo?.model || gpuInfo?.vendor || "Local GPU";
    const vramNum = gpuInfo?.vram ? Math.round((gpuInfo.vram / 1024) * 10) / 10 : 0;

    const deviceData = {
      deviceId: "local-host",
      deviceName: "Local PC",
      formFactor: "Desktop",
      cpuModel: cpuName,
      ramGb: ramGbNum,
      gpuModel: gpuName,
      vramGb: vramNum,
      batteryWh: 0,
      updatedAt: new Date().toISOString(),
    };

    // Update or insert — lastScanAt (DPM-06) stamps the freshness of the
    // live-scanned specs so DPM never consumes stale hardware data silently.
    dbWrite
      .prepare(
        `
      INSERT INTO "Devices" (deviceId, deviceName, formFactor, cpuModel, gpuModel, vramGb, ramGb, batteryWh, updatedAt, lastScanAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(deviceId) DO UPDATE SET
        deviceName = COALESCE(excluded.deviceName, "Devices".deviceName),
        formFactor = COALESCE(excluded.formFactor, "Devices".formFactor),
        cpuModel = excluded.cpuModel,
        gpuModel = excluded.gpuModel,
        vramGb = excluded.vramGb,
        ramGb = excluded.ramGb,
        updatedAt = CURRENT_TIMESTAMP,
        lastScanAt = CURRENT_TIMESTAMP
    `,
      )
      .run(
        deviceData.deviceId,
        deviceData.deviceName,
        deviceData.formFactor,
        deviceData.cpuModel,
        deviceData.gpuModel,
        deviceData.vramGb,
        deviceData.ramGb,
        deviceData.batteryWh,
      );

    const updatedDevice = dbWrite
      .prepare('SELECT * FROM "Devices" WHERE deviceId = ?')
      .get("local-host");

    // DPM-10: a fresh scan invalidates the cached playability matrix.
    cacheInvalidate("local-host");

    res.json({
      success: true,
      device: updatedDevice || deviceData,
    });
  } catch (error) {
    console.error("System scan error:", safeErrorMessage(error));
    sendApiError(res, 500, "Failed to scan local device");
  }
};

router.post("/scan", handleSystemScan);
router.post("/scan-local", handleSystemScan);

interface PlayabilityProfileUpsert {
  gameId: string;
  deviceId: string;
  runtime: number | null;
  plugged: number;
}

const PROFILE_UPSERT_CHUNK = 200;

// AI-056: the playability matrix covers the whole catalog, and each game's
// profile row used to be upserted inside the synchronous compute, catching its
// own error. Under a held lock that was one full busy-timeout wait per game, with
// the event loop (and a SIGTERM handler) blocked throughout. Rows are now written
// a chunk per transaction: BEGIN IMMEDIATE is the chunk's only lock wait, and the
// checkpoint between chunks lets shutdown skip the rest. Persistence stays
// best-effort, as before: a skipped or failed chunk still serves the computed matrix.
async function persistPlayabilityProfiles(items: PlayabilityProfileUpsert[]): Promise<void> {
  if (items.length === 0) return;
  const upsertProfileStmt = dbWrite.prepare(`
    INSERT INTO "GameDeviceProfiles" ("gameId", "deviceId", "estimatedBatteryRuntime", "isPluggedOnly")
    VALUES (?, ?, ?, ?)
    ON CONFLICT("gameId", "deviceId") DO UPDATE SET
      "estimatedBatteryRuntime" = excluded."estimatedBatteryRuntime",
      "isPluggedOnly" = excluded."isPluggedOnly"
  `);
  const upsertChunk = dbWrite.transaction((chunk: PlayabilityProfileUpsert[]) => {
    for (const item of chunk) {
      try {
        upsertProfileStmt.run(item.gameId, item.deviceId, item.runtime, item.plugged);
      } catch {
        // Ignore individual upsert errors
      }
    }
  });
  for (let i = 0; i < items.length; i += PROFILE_UPSERT_CHUNK) {
    try {
      await shutdownCheckpoint();
    } catch {
      return;
    }
    try {
      upsertChunk.immediate(items.slice(i, i + PROFILE_UPSERT_CHUNK));
    } catch (e) {
      console.error("Batch profile upsert error:", safeErrorMessage(e));
    }
  }
}

/**
 * GET /api/devices/playability?deviceId=:id
 * Calculates playability tiers, RAM/VRAM headroom, and battery runtime estimates for games on a device
 */
router.get("/playability", dpmPlayabilityLimiter, async (req: Request, res: Response) => {
  let requestedDeviceId: string | undefined;
  try {
    ensureDevicesTable();

    // Sprint 1B (EPICSEC06): hydrate the caller-supplied device id through the
    // unified safeCoerce gate and reject pathological inputs before they reach
    // SQL or the cache key (strict input validation).
    requestedDeviceId =
      safeCoerce.nullableStr((req.query.deviceId as string) || (req.query.id as string)) ??
      undefined;
    if (requestedDeviceId !== undefined && requestedDeviceId.length > 128) {
      recordDpmCounter("dpm_rejected_total", "playability");
      return sendApiError(res, 400, "deviceId query parameter is invalid.");
    }

    recordDpmCounter("dpm_requests_total", "playability");

    // DPM-10: serve from the TTL cache when warm (keyed by normalized device id).
    const cacheKey = `playability:${normalizeDeviceKey(requestedDeviceId)}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      recordDpmCounter("dpm_cache_hits_total", "playability");
      return res.json(cached);
    }
    recordDpmCounter("dpm_cache_misses_total", "playability");
    const startedAt = Date.now();

    // Sprint 1B (EPICSEC06): wrap the full scan compute in a bounded retry so a
    // transient SQLITE_BUSY / cold-cache failure is retried before the degraded
    // fallback is served. Retry counts surface in /api/dpm/metrics.
    const profileUpserts: PlayabilityProfileUpsert[] = [];
    const compute = (): any => {
      profileUpserts.length = 0;
      // Fetch device specs
      let device: any = null;
      let deviceId = requestedDeviceId;

      if (requestedDeviceId === "local-host") {
        device = dbWrite
          .prepare('SELECT * FROM "Devices" WHERE deviceId = ?')
          .get("local-host") as any;
      } else if (requestedDeviceId) {
        device = dbWrite
          .prepare('SELECT * FROM "Devices" WHERE deviceId = ?')
          .get(requestedDeviceId) as any;
      }

      if (!device) {
        if (requestedDeviceId === "deck_h" || requestedDeviceId === "steam-deck") {
          deviceId = "deck_h";
          device = {
            deviceId: "deck_h",
            deviceName: "Steam Deck Handheld",
            formFactor: "handheld",
            gpuModel: "AMD Custom GPU",
            ramGb: 16,
            vramGb: 16,
            cpuModel: "Zen 2",
            batteryWh: 40,
            tdpWatts: 15,
          };
        } else if (requestedDeviceId === "custom-pc-5080" || requestedDeviceId === "custom") {
          deviceId = "custom-pc-5080";
          device = {
            deviceId: "custom-pc-5080",
            deviceName: "Living Room 4K Rig",
            formFactor: "Desktop",
            gpuModel: "NVIDIA GeForce RTX 5080",
            ramGb: 32,
            vramGb: 16,
            cpuModel: "AMD Ryzen 7 7800X3D",
            batteryWh: 0,
            tdpWatts: 350,
          };
        } else {
          // Fall back to primary active device in SQLite database if available
          const primaryDevice = dbWrite
            .prepare(
              'SELECT * FROM "Devices" WHERE isArchived = 0 OR isArchived IS NULL ORDER BY updatedAt DESC, createdAt DESC LIMIT 1',
            )
            .get() as any;

          if (primaryDevice) {
            device = primaryDevice;
            deviceId = primaryDevice.deviceId;
          } else {
            deviceId = requestedDeviceId || "local-host";
            device = {
              ...DEFAULT_FALLBACK_PROFILE,
              deviceId,
            };
            // Sprint 1B (EPICSEC06): hardware scans are missing — log the
            // structured degraded-state warning + telemetry counter so operators
            // can observe the no-scanned-device state without any 5xx.
            logDpmDegraded(
              "playability",
              deviceId,
              "No scanned device found; serving the default fallback profile.",
            );
          }
        }
      }

      const deviceRamGb = device.ramGb != null ? Number(device.ramGb) : null;
      const deviceVramGb = device.vramGb != null ? Number(device.vramGb) : null;
      const deviceBatteryWh = device.batteryWh != null ? Number(device.batteryWh) : null;
      const deviceTdp = device.tdpWatts != null ? Number(device.tdpWatts) : null;

      // Determine hardware profile for AppGameSettings join
      const formFactorLower = (device.formFactor || "").toLowerCase();
      const gpuLower = (device.gpuModel || "").toLowerCase();
      const deviceNameLower = (device.deviceName || "").toLowerCase();
      const isHandheld =
        formFactorLower === "handheld" ||
        deviceNameLower.includes("deck") ||
        deviceNameLower.includes("ally") ||
        gpuLower.includes("amd custom") ||
        deviceId === "deck_h" ||
        deviceId === "steam-deck";
      const isLaptop =
        formFactorLower === "laptop" ||
        deviceNameLower.includes("laptop") ||
        gpuLower.includes("laptop") ||
        deviceNameLower.includes("nitro");

      let targetProfile = "Custom PC (Desktop)";
      if (isHandheld) {
        targetProfile = "ROG Ally (Handheld)";
      } else if (isLaptop) {
        targetProfile = "Acer Nitro 17 (Laptop)";
      }

      // Fetch all games
      const gamesQuery = `
      SELECT 
        g."GameID" as gameID,
        g."Game Title" as gameTitle,
        g."cover_url" as coverUrl,
        g."Storage Size" as storageSize,
        g."Primary Genre" as primaryGenre,
        g."Min RAM GB" as minRamGb,
        g."Min VRAM GB" as minVramGb,
        s."Target Resolution" as targetResolution,
        s."Target Framerate" as targetFramerate,
        s."Preset Level" as presetLevel,
        s."Thermal / Power Mode" as thermalPowerMode,
        s."Recommended Game Settings & Tuning Notes" as recommendedNotes
      FROM "AppGames" g
      LEFT JOIN "AppGameSettings" s ON g."GameID" = s."GameID" AND s."Hardware Profile" = ?
    `;

      const rows = dbWrite.prepare(gamesQuery).all(targetProfile) as Array<{
        gameID: string;
        gameTitle: string | null;
        coverUrl: string | null;
        storageSize: string | null;
        primaryGenre: string | null;
        minRamGb: number | null;
        minVramGb: number | null;
        targetResolution: string | null;
        targetFramerate: string | null;
        presetLevel: string | null;
        thermalPowerMode: string | null;
        recommendedNotes: string | null;
      }>;

      // Sprint 7 (WUD-7.2): "Display only current system hardware" filter flag.
      // A game is only ever `deviceMatched` when the matrix was computed against
      // the real persisted active system — never a fallback preset device or a
      // blocked (incomplete/stale) hardware profile. Surfaces per-game so the UI
      // filter is driven by API/DB truth, not client-side inference.
      const deviceMatched =
        deviceId !== "deck_h" &&
        deviceId !== "custom-pc-5080" &&
        device.synthetic !== true &&
        deviceRamGb !== null &&
        deviceVramGb !== null;

      const gamesResult = rows.map((row) => {
        const recRamGb = row.minRamGb != null ? Number(row.minRamGb) : null;
        const recVramGb = row.minVramGb != null ? Number(row.minVramGb) : null;

        // RAM headroom: device - rec
        let ramHeadroomGb: number | null = null;
        if (deviceRamGb !== null && recRamGb !== null) {
          ramHeadroomGb = Math.round((deviceRamGb - recRamGb) * 10) / 10;
        }

        // VRAM headroom: device - rec
        let vramHeadroomGb: number | null = null;
        if (deviceVramGb !== null && recVramGb !== null) {
          vramHeadroomGb = Math.round((deviceVramGb - recVramGb) * 10) / 10;
        }

        // Determine Playability Tier
        let playabilityTier: string;
        if (recRamGb !== null && deviceRamGb !== null && deviceRamGb < recRamGb) {
          playabilityTier = "Low FPS / Tweaks Needed";
        } else if (recVramGb !== null && deviceVramGb !== null && deviceVramGb < recVramGb) {
          playabilityTier = "Low FPS / Tweaks Needed";
        } else {
          const targetFpsStr = (row.targetFramerate || "").toLowerCase();
          if (
            targetFpsStr.includes("60") ||
            targetFpsStr.includes("144") ||
            targetFpsStr.includes("great")
          ) {
            playabilityTier = "60 FPS Great";
          } else if (targetFpsStr.includes("30") || targetFpsStr.includes("playable")) {
            playabilityTier = "30-60 FPS Playable";
          } else if (
            ramHeadroomGb !== null &&
            ramHeadroomGb >= 8 &&
            (vramHeadroomGb === null || vramHeadroomGb >= 4)
          ) {
            playabilityTier = "60 FPS Great";
          } else if (
            (ramHeadroomGb !== null && ramHeadroomGb >= 0) ||
            (vramHeadroomGb !== null && vramHeadroomGb >= 0)
          ) {
            playabilityTier = "30-60 FPS Playable";
          } else {
            playabilityTier = "Low FPS / Tweaks Needed";
          }
        }

        // Estimate battery runtime & plugged status
        let estimatedBatteryRuntime: number | null = null;
        let isPluggedOnly = 0;
        let estimatedBatteryRuntimeText = "N/A";

        if (
          deviceBatteryWh === null ||
          deviceBatteryWh <= 0 ||
          (device.formFactor && device.formFactor.toLowerCase() === "desktop")
        ) {
          isPluggedOnly = 1;
          estimatedBatteryRuntimeText = "N/A (Plugged Only)";
        } else {
          let tdp = deviceTdp || 15;
          const modeStr = (row.thermalPowerMode || "").toLowerCase();
          if (modeStr.includes("15w")) tdp = 15;
          else if (modeStr.includes("25w")) tdp = 25;
          else if (modeStr.includes("30w")) tdp = 30;
          else if (modeStr.includes("9w") || modeStr.includes("10w") || modeStr.includes("silent"))
            tdp = 10;
          else if (modeStr.includes("balanced") || modeStr.includes("65w")) tdp = 35;
          else if (
            modeStr.includes("full power") ||
            modeStr.includes("290w") ||
            modeStr.includes("tgp")
          ) {
            isPluggedOnly = 1;
            estimatedBatteryRuntimeText = "N/A (Plugged Only)";
          }

          if (isPluggedOnly === 0) {
            const powerDraw = tdp + 6; // system overhead
            estimatedBatteryRuntime = Math.round((deviceBatteryWh / powerDraw) * 10) / 10;
            estimatedBatteryRuntimeText = `${estimatedBatteryRuntime} hrs`;
          }
        }

        // Upserted into GameDeviceProfiles after compute (AI-056). Without a
        // device id the upsert could not bind, and its error was ignored.
        if (deviceId) {
          profileUpserts.push({
            gameId: row.gameID,
            deviceId,
            runtime: estimatedBatteryRuntime,
            plugged: isPluggedOnly,
          });
        }

        return {
          gameID: row.gameID,
          gameTitle: row.gameTitle || "Unknown Game",
          coverUrl: row.coverUrl || "",
          primaryGenre: row.primaryGenre || "",
          recRamGb,
          recVramGb,
          deviceRamGb,
          deviceVramGb,
          ramHeadroomGb,
          vramHeadroomGb,
          playabilityTier,
          estimatedBatteryRuntime,
          isPluggedOnly: Boolean(isPluggedOnly),
          estimatedBatteryRuntimeText,
          targetResolution: row.targetResolution || "1080p",
          targetFramerate: row.targetFramerate || "60 FPS",
          presetLevel: row.presetLevel || "Medium",
          thermalPowerMode: row.thermalPowerMode || "15W Performance",
          recommendedNotes: row.recommendedNotes || "",
          // Sprint 7 (WUD-7.2): per-game current-system match flag.
          deviceMatched,
        };
      });

      const payload = {
        success: true,
        deviceId,
        deviceName: device.deviceName || deviceId,
        // DPM-07 / DPM-11: surface the resolution truth so the UI can render a
        // graceful blocked state instead of silently treating a fallback or an
        // incomplete/stale device as authoritative.
        usingFallback:
          deviceId === "deck_h" || deviceId === "custom-pc-5080" || device.synthetic === true,
        staleSpecs: "lastScanAt" in device ? deviceSpecsStale(device.lastScanAt) : false,
        blockedSpecs: deviceRamGb === null || deviceVramGb === null,
        deviceSpecs: {
          ramGb: deviceRamGb,
          vramGb: deviceVramGb,
          batteryWh: deviceBatteryWh,
          tdpWatts: deviceTdp,
          formFactor: device.formFactor,
          gpuModel: device.gpuModel,
          cpuModel: device.cpuModel,
        },
        games: gamesResult,
      };

      // DPM-10: log the scan duration for the P90 ≤ 2s measurement harness and
      // hand the computed payload back to the retry wrapper.
      console.log(
        `[perf] playability deviceId=${deviceId} computed in ${Date.now() - startedAt}ms`,
      );
      return payload;
    };

    // Sprint 1B (EPICSEC06): bounded retry (max 2 attempts). A success is
    // cached for DPM-10 TTL reuse; a failure escalates to the degraded-state
    // fallback below — never a 5xx.
    const computed = withDpmRetry(compute, 2, "playability");
    if (!computed.ok) throw computed.error;
    await persistPlayabilityProfiles(profileUpserts);
    setDpmHealth(true);
    cacheSet(cacheKey, computed.payload);
    res.json(computed.payload);
  } catch (error) {
    // Sprint 1B (EPICSEC06): structured degraded-state warning + telemetry.
    // The client receives the well-formed "No Scanned Device" fallback profile
    // (blockedSpecs) so it renders a graceful blocked state — never a 5xx and
    // never guessed hardware.
    logDpmDegraded("playability", requestedDeviceId, error);
    res.json(buildDpmFallbackPayload(requestedDeviceId));
  }
});

/**
 * GET /api/devices/:id/playable-games
 * Categorizes owned games for the given device into 3 performance tiers based on specs
 */
router.get("/:id/playable-games", dpmPlayabilityLimiter, (req: Request, res: Response) => {
  // Sprint 1B (EPICSEC06): strict input validation via safeCoerce — never trust
  // a raw URL path segment past the length guard. Hoisted so the degraded-state
  // catch block can reference it.
  const id = safeCoerce.str(req.params.id).slice(0, 128);
  try {
    ensureDevicesTable();

    recordDpmCounter("dpm_requests_total", "playable-games");

    // DPM-10: serve from the TTL cache when warm (keyed by normalized device id).
    const cacheKey = `playable:${normalizeDeviceKey(id)}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      recordDpmCounter("dpm_cache_hits_total", "playable-games");
      return res.json(cached);
    }
    recordDpmCounter("dpm_cache_misses_total", "playable-games");
    const startedAt = Date.now();

    // Fetch the device
    let device = dbWrite.prepare('SELECT * FROM "Devices" WHERE deviceId = ?').get(id) as any;
    if (!device) {
      if (id === "deck_h" || id === "steam-deck") {
        device = {
          deviceId: "deck_h",
          deviceName: "Steam Deck Handheld",
          formFactor: "handheld",
          gpuModel: "AMD Custom GPU",
          vramGb: 16,
          cpuModel: "Zen 2",
          batteryWh: 40,
        };
      } else if (id === "custom-pc-5080" || id === "custom") {
        device = {
          deviceId: "custom-pc-5080",
          deviceName: "Living Room 4K Rig",
          formFactor: "Desktop",
          gpuModel: "NVIDIA GeForce RTX 5080",
          vramGb: 16,
          cpuModel: "AMD Ryzen 7 7800X3D",
          batteryWh: 0,
        };
      } else {
        device = {
          deviceId: "local-host",
          deviceName: "Local PC",
          formFactor: "Laptop",
          gpuModel: "Intel(R) Iris(R) Xe Graphics",
          vramGb: 1,
          cpuModel: "Intel Core i7",
          batteryWh: 60,
        };
      }
    }

    // Determine target hardware profile
    let targetProfile = "Custom PC (Desktop)";
    const formFactorLower = (device.formFactor || "").toLowerCase();
    const gpuLower = (device.gpuModel || "").toLowerCase();
    const deviceNameLower = (device.deviceName || "").toLowerCase();
    const isHandheld =
      formFactorLower === "handheld" ||
      deviceNameLower.includes("deck") ||
      deviceNameLower.includes("ally") ||
      gpuLower.includes("amd custom") ||
      id === "deck_h" ||
      id === "steam-deck";
    const isLaptop =
      formFactorLower === "laptop" ||
      deviceNameLower.includes("laptop") ||
      gpuLower.includes("laptop") ||
      deviceNameLower.includes("nitro");

    if (isHandheld) {
      targetProfile = "ROG Ally (Handheld)";
    } else if (isLaptop) {
      targetProfile = "Acer Nitro 17 (Laptop)";
    } else {
      targetProfile = "Custom PC (Desktop)";
    }

    // DPM-04: gate owned games by the device's canonical platform family using
    // EPIC-04's persisted AppOwnership.platformCanonical. A PC-family device
    // (desktop/laptop/handheld — including the deck_h / custom-pc-5080 /
    // local-host fallbacks) must never render a console-exclusive title (e.g.
    // a PS4-exclusive with only a "Console – PlayStation" ownership row) as
    // playable even when raw specs would pass. Console-named devices resolve to
    // their console canonical and match that family exactly. Unclassified
    // (NULL) rows stay permissive on PC so pre-canonical libraries are not
    // silently dropped; console rows are never guessed.
    const consoleCanonical = /playstation|ps[345]|ps vita|psp/.test(deviceNameLower)
      ? "Console – PlayStation"
      : /xbox/.test(deviceNameLower)
        ? "Console – Xbox"
        : /nintendo|switch|wii|3ds/.test(deviceNameLower)
          ? "Console – Nintendo"
          : null;
    const ownershipGateWhere = consoleCanonical
      ? `o."platformCanonical" = ?`
      : `(o."platformCanonical" = 'PC' OR o."platformCanonical" IS NULL)`;
    const ownershipGateParams = consoleCanonical ? [consoleCanonical] : [];

    // Fetch owned games joined with settings
    const gamesQuery = `
      SELECT 
        g."GameID" as gameID,
        g."Game Title" as gameTitle,
        g."cover_url" as coverUrl,
        g."Storage Size" as storageSize,
        g."Primary Genre" as primaryGenre,
        g."ROG Ally Playability" as rogAllyPlayability,
        g."Laptop Playability" as laptopPlayability,
        s."Target Resolution" as targetResolution,
        s."Target Framerate" as targetFramerate,
        s."Preset Level" as presetLevel,
        s."Thermal / Power Mode" as thermalPowerMode,
        s."Recommended Game Settings & Tuning Notes" as recommendedNotes
      FROM "AppGames" g
      JOIN "AppOwnership" o ON g."GameID" = o."GameID" AND ${ownershipGateWhere}
      LEFT JOIN "AppGameSettings" s ON g."GameID" = s."GameID" AND s."Hardware Profile" = ?
    `;

    const rows = dbWrite.prepare(gamesQuery).all(...ownershipGateParams, targetProfile) as Array<{
      gameID: string;
      gameTitle: string | null;
      coverUrl: string | null;
      storageSize: string | null;
      primaryGenre: string | null;
      rogAllyPlayability: string | null;
      laptopPlayability: string | null;
      targetResolution: string | null;
      targetFramerate: string | null;
      presetLevel: string | null;
      thermalPowerMode: string | null;
      recommendedNotes: string | null;
    }>;

    // Categorization logic helpers
    const parseStorageSize = (sizeStr: string | null): number => {
      if (!sizeStr) return 0;
      const match = sizeStr.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
      if (!match) return 0;
      const num = parseFloat(match[1]);
      const unit = match[2].toUpperCase();
      if (unit === "MB") return num / 1024;
      return num;
    };

    const parseTargetFramerate = (fpsStr: string | null): number => {
      if (!fpsStr) return 30;
      const match = fpsStr.match(/(\d+)/);
      if (!match) return 30;
      return parseInt(match[1]);
    };

    const estimateBattery = (thermalPowerMode: string | null, batteryWh: number | null): string => {
      if (batteryWh === null || batteryWh === undefined) {
        batteryWh = 50; // default Laptop/Handheld battery fallback if null
      }
      if (batteryWh <= 0) {
        return "N/A (Plugged Only)";
      }
      const modeStr = (thermalPowerMode || "").toLowerCase();
      let tdp = 15; // default estimate
      if (modeStr.includes("15w")) tdp = 15;
      else if (modeStr.includes("25w")) tdp = 25;
      else if (modeStr.includes("30w")) tdp = 30;
      else if (modeStr.includes("9w") || modeStr.includes("10w") || modeStr.includes("silent"))
        tdp = 10;
      else if (modeStr.includes("balanced") || modeStr.includes("65w")) tdp = 35;
      else if (
        modeStr.includes("full power") ||
        modeStr.includes("290w") ||
        modeStr.includes("tgp")
      ) {
        return "N/A (Plugged Only)";
      }

      const systemDraw = tdp + 6; // base system overhead
      const hours = batteryWh / systemDraw;
      const mins = Math.round(hours * 60);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const greatGames: any[] = [];
    const playableGames: any[] = [];
    const unplayableGames: any[] = [];

    // Hardware Specs Category (DPM-03): classify from explicit gpuType /
    // integrated flags first, then deterministic iGPU model patterns (Intel
    // UHD/HD/Iris, AMD Radeon Vega/Graphics/APU, Apple M-series), then VRAM
    // thresholds. An iGPU is always 'low' regardless of shared-memory VRAM
    // reporting, so iGPU devices can never be misclassified as 'high' by a
    // large shared pool. The category is also surfaced in the response so the
    // classification is observable (and regression-testable).
    const gpuNameLower = (device.gpuModel || "").toLowerCase();
    const gpuTypeLower = String(device.gpuType || "").toLowerCase();
    const isIntegratedGpu =
      gpuTypeLower === "integrated" ||
      gpuTypeLower.includes("integrated") ||
      Boolean((device as any).isIntegrated) ||
      /intel.*(uhd|hd graphics|iris)/.test(gpuNameLower) ||
      /amd.*(radeon.*(graphics|vega)|apu)/.test(gpuNameLower) ||
      /apple m[1-4]/.test(gpuNameLower) ||
      /integrated/.test(gpuNameLower);
    const vram = device.vramGb !== null && device.vramGb !== undefined ? Number(device.vramGb) : 4;

    let hwCategory: "high" | "mid" | "low" = "mid";
    if (isIntegratedGpu) {
      hwCategory = "low";
    } else if (
      vram >= 8 &&
      (gpuNameLower.includes("rtx") ||
        gpuNameLower.includes("rx 7") ||
        gpuNameLower.includes("rx 6"))
    ) {
      hwCategory = "high";
    } else if (
      vram <= 2 ||
      gpuNameLower.includes("g1") ||
      gpuNameLower.includes("g4") ||
      gpuNameLower.includes("g7")
    ) {
      hwCategory = "low";
    }

    for (const row of rows) {
      const targetFps = parseTargetFramerate(row.targetFramerate);
      const fpsLabel = (row.targetFramerate || "").toLowerCase();

      let tier: "great" | "playable" | "unplayable" = "playable";

      if (targetFps >= 60 || fpsLabel.includes("144+") || fpsLabel.includes("60+")) {
        tier = "great";
      } else if (targetFps >= 30 || fpsLabel.includes("30-60")) {
        tier = "playable";
      } else {
        tier = "unplayable";
      }

      const gameItem = {
        gameID: row.gameID,
        gameTitle: row.gameTitle || "Unknown Game",
        title: row.gameTitle || "Unknown Game",
        coverUrl:
          row.coverUrl || "https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=150",
        fps:
          row.targetFramerate ||
          (tier === "great" ? "60+ FPS" : tier === "playable" ? "30-60 FPS" : "< 30 FPS"),
        resolution: row.targetResolution || (isHandheld ? "900p" : isLaptop ? "1080p" : "1440p"),
        tdp: row.thermalPowerMode || (isHandheld ? "15W Performance" : "Balanced Mode"),
        preset: row.presetLevel || "Medium Presets",
        batteryEst: estimateBattery(row.thermalPowerMode, device.batteryWh),
        notes: row.recommendedNotes || "No specific recommendations available.",
      };

      if (tier === "great") {
        greatGames.push(gameItem);
      } else if (tier === "playable") {
        playableGames.push(gameItem);
      } else {
        unplayableGames.push(gameItem);
      }
    }

    const dedup = (items: any[]) =>
      Array.from(
        new Map(
          items.map((g) => [(g.title || g.gameTitle || "").toLowerCase().trim(), g]),
        ).values(),
      );

    const payload = {
      success: true,
      device: {
        deviceId: device.deviceId,
        deviceName:
          device.deviceName || (device.deviceId === "local-host" ? "Local PC" : device.deviceId),
        formFactor: device.formFactor,
        gpuModel: device.gpuModel,
        vramGb: device.vramGb,
        cpuModel: device.cpuModel,
        batteryWh: device.batteryWh,
        hwCategory,
        staleSpecs: deviceSpecsStale(device.lastScanAt),
      },
      games: {
        great: dedup(greatGames),
        playable: dedup(playableGames),
        unplayable: dedup(unplayableGames),
        low: dedup(unplayableGames),
      },
    };

    // DPM-10: cache the computed payload and log the scan duration for the
    // P90 ≤ 2s measurement harness.
    setDpmHealth(true);
    cacheSet(cacheKey, payload);
    console.log(
      `[perf] playable-games deviceId=${device.deviceId} computed in ${Date.now() - startedAt}ms`,
    );
    res.json(payload);
  } catch (error) {
    // Sprint 1B (EPICSEC06): never 5xx — serve the sanitized degraded-state
    // fallback and record telemetry + a structured warning.
    logDpmDegraded("playable-games", id, error);
    res.json(buildDpmFallbackPayload(id));
  }
});

/**
 * PATCH /api/devices/:id/archive
 * Soft-deletes a device by setting isArchived to true and updating archivedAt timestamp.
 */
router.patch("/:id/archive", (req: Request, res: Response) => {
  try {
    ensureDevicesTable();
    const { id } = req.params;

    const device = dbWrite.prepare('SELECT * FROM "Devices" WHERE deviceId = ?').get(id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found" });
    }

    const now = new Date().toISOString();
    dbWrite
      .prepare(
        `
      UPDATE "Devices"
      SET isArchived = 1, archivedAt = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE deviceId = ?
    `,
      )
      .run(now, id);

    const updatedDevice = dbWrite.prepare('SELECT * FROM "Devices" WHERE deviceId = ?').get(id);

    res.json({
      success: true,
      message: "Device archived successfully",
      device: updatedDevice,
    });
  } catch (error) {
    console.error("Failed to archive device:", safeErrorMessage(error));
    sendApiError(res, 500, "Failed to archive device");
  }
});

/**
 * PATCH /api/devices/:id/restore
 * Un-archives a device by setting isArchived to false and clearing archivedAt.
 */
router.patch("/:id/restore", (req: Request, res: Response) => {
  try {
    ensureDevicesTable();
    const { id } = req.params;

    const device = dbWrite.prepare('SELECT * FROM "Devices" WHERE deviceId = ?').get(id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found" });
    }

    dbWrite
      .prepare(
        `
      UPDATE "Devices"
      SET isArchived = 0, archivedAt = NULL, updatedAt = CURRENT_TIMESTAMP
      WHERE deviceId = ?
    `,
      )
      .run(id);

    const updatedDevice = dbWrite.prepare('SELECT * FROM "Devices" WHERE deviceId = ?').get(id);

    res.json({
      success: true,
      message: "Device restored successfully",
      device: updatedDevice,
    });
  } catch (error) {
    console.error("Failed to restore device:", safeErrorMessage(error));
    sendApiError(res, 500, "Failed to restore device");
  }
});

/**
 * Sprint 1B (EPICSEC06): the legacy public `GET /api/devices` listing is NOT
 * mounted — the authenticated fleet router owns that path (AppDevices). The
 * public DPM playability / scan / upsert routes above remain non-colliding
 * with the fleet CRUD router.
 */

export default router;
