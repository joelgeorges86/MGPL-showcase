import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import { sendApiError } from '../middleware/errorSanitizer';
import { safeErrorMessage } from '../utils/errorSanitizer';
import {
  scanLocalHardware,
  ScanTelemetry,
  verifiedRetailerLinks,
  vramFromModel,
  coresForComponent,
} from '../services/hardwareExplorer';
import { evaluateTieredCompatibility } from '../services/headroom';

/**
 * Sprint 5 (EPICUX05): Hardware Explorer 2.0 API.
 *
 *  POST /api/scan                        -> PII-free local hardware scan + persist
 *  GET  /api/hardware/explorer           -> persisted scanned-rig telemetry
 *  POST /api/hardware/compatibility      -> explicit-trigger tiered headroom check
 *  GET  /api/hardware/benchmarks         -> filterable community benchmark table
 *  GET  /api/hardware/components         -> GPU/CPU component list for pickers
 *  GET  /api/hardware/components/compare -> side-by-side component comparison (≤4)
 *  GET  /api/hardware/upgrade            -> real-spec upgrade advisor
 *
 * Matrix guardrails (VCM Ch. 22.6 / 23): VRAM is never inferred from the GPU
 * name; missing persisted specs produce explicit blocked states ("Missing VRAM",
 * "Refresh device scan required") rather than guesses; multi-variable
 * recommendations are only computed on explicit user action.
 */

const router = Router();

const DEVICE_SPECS_STALE_DAYS = 30;

function deviceSpecsStale(lastScanAt: string | null | undefined): boolean {
  if (!lastScanAt) return true;
  const ts = new Date(lastScanAt).getTime();
  if (Number.isNaN(ts)) return true;
  return (Date.now() - ts) / 86400000 > DEVICE_SPECS_STALE_DAYS;
}

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.HW_SCAN_LIMIT) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many hardware scans. Try again shortly.' },
});

/**
 * Additive, non-destructive table bootstrap. Creates the legacy "Devices" table
 * when missing and guards every new Sprint-5 column with a conditional ALTER so
 * pre-existing databases self-heal without any destructive migration. Also
 * ensures the community_benchmarks table exists (indexes are idempotent).
 */
function ensureHardwareExplorerTables(): void {
  try {
    db.prepare(`
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
        "lastScanAt" TEXT,
        "cpuCores" INTEGER,
        "storageType" TEXT,
        "storageFreeGb" REAL,
        "scanConfidence" TEXT,
        "deviceClass" TEXT,
        "thermalCapabilities" TEXT,
        "tdpWatts" REAL
      )
    `).run();

    const pragma = db.prepare('PRAGMA table_info("Devices")').all() as Array<{ name: string }>;
    const columnNames = pragma.map((c) => c.name);
    const missingCols: Record<string, string> = {
      ramGb: 'REAL',
      motherboard: 'TEXT',
      caseModel: 'TEXT',
      psu: 'TEXT',
      storageCapacityGb: 'REAL',
      os: 'TEXT',
      tdpWatts: 'REAL',
      isArchived: 'INTEGER DEFAULT 0',
      archivedAt: 'TEXT',
      lastScanAt: 'TEXT',
      cpuCores: 'INTEGER',
      storageType: 'TEXT',
      storageFreeGb: 'REAL',
      scanConfidence: 'TEXT',
      deviceClass: 'TEXT',
      thermalCapabilities: 'TEXT',
    };
    for (const [col, type] of Object.entries(missingCols)) {
      if (!columnNames.includes(col)) {
        db.prepare(`ALTER TABLE "Devices" ADD COLUMN "${col}" ${type}`).run();
      }
    }

    db.prepare(`
      CREATE TABLE IF NOT EXISTS community_benchmarks (
        benchmarkId TEXT PRIMARY KEY,
        componentId TEXT NOT NULL,
        componentType TEXT NOT NULL CHECK (componentType IN ('gpu', 'cpu')),
        componentName TEXT NOT NULL,
        resolution TEXT NOT NULL CHECK (resolution IN ('1080p', '1440p', '4K')),
        settingsPreset TEXT NOT NULL CHECK (settingsPreset IN ('Low', 'Medium', 'High', 'Ultra')),
        avgFps REAL NOT NULL,
        onePercentLowFps REAL NOT NULL,
        sampleCount INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'community',
        recordedAt TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error('Failed to ensure hardware explorer tables:', safeErrorMessage(e));
  }
}

function persistScanTelemetry(telemetry: ScanTelemetry): void {
  db.prepare(`
    INSERT INTO "Devices" (
      deviceId, deviceName, formFactor, cpuModel, cpuCores, ramGb, gpuModel, vramGb,
      storageType, storageCapacityGb, storageFreeGb, batteryWh,
      scanConfidence, deviceClass, thermalCapabilities, updatedAt, lastScanAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(deviceId) DO UPDATE SET
      deviceName = excluded.deviceName,
      formFactor = excluded.formFactor,
      cpuModel = excluded.cpuModel,
      cpuCores = excluded.cpuCores,
      ramGb = excluded.ramGb,
      gpuModel = excluded.gpuModel,
      vramGb = excluded.vramGb,
      storageType = excluded.storageType,
      storageCapacityGb = excluded.storageCapacityGb,
      storageFreeGb = excluded.storageFreeGb,
      batteryWh = excluded.batteryWh,
      scanConfidence = excluded.scanConfidence,
      deviceClass = excluded.deviceClass,
      thermalCapabilities = excluded.thermalCapabilities,
      updatedAt = CURRENT_TIMESTAMP,
      lastScanAt = CURRENT_TIMESTAMP
  `).run(
    telemetry.deviceId,
    telemetry.deviceName,
    telemetry.formFactor,
    telemetry.cpuModel,
    telemetry.cpuCores,
    telemetry.ramGb,
    telemetry.gpuModel,
    telemetry.vramGb,
    telemetry.storageType,
    telemetry.storageCapacityGb,
    telemetry.storageFreeGb,
    telemetry.batteryWh,
    telemetry.scanConfidence,
    telemetry.deviceClass,
    telemetry.thermalCapabilities,
  );
}

/**
 * POST /api/scan
 * Runs the PII-free local hardware scan and persists normalized telemetry to the
 * Devices table (deviceId 'local-host'). The response is the full normalized
 * telemetry payload; no serials/usernames/hostnames are ever extracted or stored.
 */
router.post('/scan', scanLimiter, async (_req: Request, res: Response) => {
  try {
    ensureHardwareExplorerTables();
    const telemetry = await scanLocalHardware();
    persistScanTelemetry(telemetry);
    res.json({ success: true, telemetry });
  } catch (e) {
    console.error('Hardware scan error:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to scan local hardware');
  }
});

/**
 * GET /api/hardware/explorer
 * Returns the persisted scanned-rig telemetry (never UI state) with the stale
 * flag and scan confidence so the explorer can rehydrate from the DB.
 */
router.get('/hardware/explorer', (_req: Request, res: Response) => {
  try {
    ensureHardwareExplorerTables();
    const row = db.prepare('SELECT * FROM "Devices" WHERE "deviceId" = ?').get('local-host') as any;
    if (!row) {
      return res.json({ success: true, device: null });
    }
    res.json({
      success: true,
      device: {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        formFactor: row.formFactor,
        deviceClass: row.deviceClass || null,
        cpuModel: row.cpuModel,
        cpuCores: row.cpuCores,
        ramGb: row.ramGb,
        gpuModel: row.gpuModel,
        vramGb: row.vramGb,
        gpuType: row.gpuType ?? null,
        storageType: row.storageType,
        storageCapacityGb: row.storageCapacityGb,
        storageFreeGb: row.storageFreeGb,
        batteryWh: row.batteryWh,
        thermalCapabilities: row.thermalCapabilities,
        scanConfidence: row.scanConfidence || null,
        blockedSpecs: row.ramGb === null || row.vramGb === null,
        staleSpecs: deviceSpecsStale(row.lastScanAt),
        lastScanAt: row.lastScanAt || null,
      },
    });
  } catch (e) {
    console.error('Failed to read hardware explorer state:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to read hardware explorer state');
  }
});

/**
 * POST /api/hardware/compatibility
 * Explicit-trigger multi-tier headroom evaluation (Minimum / Recommended / Ultra).
 * Specs are rehydrated from the persisted Devices row (Anti-Stale Input Rule —
 * UI state is never authoritative). Missing RAM/VRAM yields an explicit blocked
 * state instead of a guess.
 */
router.post('/hardware/compatibility', (req: Request, res: Response) => {
  try {
    ensureHardwareExplorerTables();
    const body = req.body || {};
    const deviceId =
      typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim() : 'local-host';
    const gameId = typeof body.gameId === 'string' ? body.gameId.trim() : '';
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const game = db.prepare('SELECT * FROM "AppGames" WHERE "GameID" = ?').get(gameId) as any;
    if (!game) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    const row = db.prepare('SELECT * FROM "Devices" WHERE "deviceId" = ?').get(deviceId) as any;
    if (!row || row.ramGb === null || row.vramGb === null) {
      return res.json({
        success: true,
        deviceId,
        deviceName: row?.deviceName || 'No Scanned Device',
        gameId: game.GameID,
        gameTitle: game['Game Title'] || game.GameID,
        blocked: true,
        blockedReason: 'Missing VRAM',
        message: 'Refresh device scan required — hardware specs incomplete.',
      });
    }

    const evaluation = evaluateTieredCompatibility(
      {
        id: row.deviceId,
        deviceName: row.deviceName,
        deviceType: row.formFactor,
        cpuModel: row.cpuModel,
        cpuCores: row.cpuCores,
        ramGb: row.ramGb,
        gpuModel: row.gpuModel,
        vramGb: row.vramGb,
        gpuType: row.gpuType ?? null,
        storageType: row.storageType,
        storageFreeGb: row.storageFreeGb,
        isPortable: /handheld|laptop/i.test(String(row.deviceClass || row.formFactor || '')),
      },
      game,
      (body.powerProfile as 'Plugged-In' | 'Battery Saver') || undefined,
    );

    res.json({
      success: true,
      deviceId,
      deviceName: row.deviceName,
      gameId: game.GameID,
      gameTitle: game['Game Title'] || game.GameID,
      blocked: false,
      evaluation,
    });
  } catch (e) {
    console.error('Hardware compatibility error:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to evaluate hardware compatibility');
  }
});

/**
 * GET /api/hardware/benchmarks
 * Filterable community benchmark table. Query params (all optional):
 *   type=gpu|cpu, resolution=1080p|1440p|4K, preset=Low|Medium|High|Ultra,
 *   componentId=<id>
 */
router.get('/hardware/benchmarks', (req: Request, res: Response) => {
  try {
    ensureHardwareExplorerTables();
    const type = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : '';
    const resolution = typeof req.query.resolution === 'string' ? req.query.resolution : '';
    const preset = typeof req.query.preset === 'string' ? req.query.preset : '';
    const componentId = typeof req.query.componentId === 'string' ? req.query.componentId.trim() : '';

    const wheres: string[] = [];
    const params: unknown[] = [];
    if (type === 'gpu' || type === 'cpu') {
      wheres.push('componentType = ?');
      params.push(type);
    }
    if (['1080p', '1440p', '4K'].includes(resolution)) {
      wheres.push('resolution = ?');
      params.push(resolution);
    }
    if (['Low', 'Medium', 'High', 'Ultra'].includes(preset)) {
      wheres.push('settingsPreset = ?');
      params.push(preset);
    }
    if (componentId) {
      wheres.push('componentId = ?');
      params.push(componentId);
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM community_benchmarks ${whereSql}
         ORDER BY componentType ASC, componentName ASC, resolution ASC, settingsPreset ASC`,
      )
      .all(...params) as any[];

    res.json({
      success: true,
      benchmarks: rows.map((r) => ({
        benchmarkId: r.benchmarkId,
        componentId: r.componentId,
        componentType: r.componentType,
        componentName: r.componentName,
        resolution: r.resolution,
        settingsPreset: r.settingsPreset,
        avgFps: Number(r.avgFps),
        onePercentLowFps: Number(r.onePercentLowFps),
        sampleCount: Number(r.sampleCount),
        source: r.source,
      })),
      filters: { type, resolution, preset, componentId },
    });
  } catch (e) {
    console.error('Benchmark query error:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to query community benchmarks');
  }
});

/**
 * GET /api/hardware/components/search
 * GPU/CPU component listing for the side-by-side Comparison Tool pickers.
 * (Named distinctly from the pre-existing GET /api/hardware/components catalog
 * so both endpoints coexist without a route-shadowing conflict.)
 */
router.get('/hardware/components/search', (_req: Request, res: Response) => {
  try {
    const rows = db
      .prepare(
        `SELECT componentId, category, brand, model, socketType, ddrGen, formFactor, tdpWatts, priceUsd
         FROM device_components WHERE category IN ('GPU', 'CPU')
         ORDER BY category ASC, priceUsd ASC`,
      )
      .all() as any[];
    res.json({
      success: true,
      components: rows.map((r) => ({
        componentId: r.componentId,
        category: r.category,
        brand: r.brand,
        model: r.model,
        name: `${r.brand} ${r.model}`,
        socketType: r.socketType,
        ddrGen: r.ddrGen,
        formFactor: r.formFactor,
        tdpWatts: r.tdpWatts,
        priceUsd: Number(r.priceUsd) || 0,
      })),
    });
  } catch (e) {
    console.error('Component listing error:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to list hardware components');
  }
});

/**
 * Deterministic price trend for a component from the seeded
 * hardware_price_history rows (grouped by month). Returns the 12-month point
 * series plus an up/down/stable trend badge derived from the real persisted
 * history — never fabricated.
 */
function priceHistoryForComponent(componentId: string, msrp: number): {
  points: Array<{ month: string; priceUsd: number }>;
  trend: 'stable' | 'down' | 'up';
} {
  const rows = db
    .prepare(
      `SELECT recordedAt, MIN(priceUsd) AS priceUsd
       FROM hardware_price_history
       WHERE componentId = ?
       GROUP BY recordedAt
       ORDER BY recordedAt ASC
       LIMIT 12`,
    )
    .all(componentId) as any[];
  const points = rows.map((r) => ({
    month: r.recordedAt,
    priceUsd: Number(r.priceUsd),
  }));
  if (points.length === 0) {
    return { points: [{ month: 'current', priceUsd: msrp }], trend: 'stable' };
  }
  let trend: 'stable' | 'down' | 'up' = 'stable';
  if (points.length >= 2) {
    const first = points[0].priceUsd;
    const last = points[points.length - 1].priceUsd;
    if (first > 0) {
      const pct = (last - first) / first;
      trend = pct <= -0.005 ? 'down' : pct >= 0.005 ? 'up' : 'stable';
    }
  }
  return { points, trend };
}

/**
 * GET /api/hardware/components/compare?ids=a,b,c,d
 * Side-by-side comparison of 2-4 GPUs/CPUs. Each slot carries real catalog
 * specs, its community benchmark rows (Specs / Benchmarks / Price History tabs
 * are rendered client-side), and verified retailer buy links constrained to the
 * hardware-retailer hostname whitelist.
 */
router.get('/hardware/components/compare', (req: Request, res: Response) => {
  try {
    ensureHardwareExplorerTables();
    const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = idsParam
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (ids.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Provide between 2 and 4 component ids (?ids=a,b,c,d)',
      });
    }

    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT componentId, category, brand, model, socketType, ddrGen, formFactor, tdpWatts, priceUsd
         FROM device_components WHERE componentId IN (${placeholders})`,
      )
      .all(...ids) as any[];
    const byId = new Map(rows.map((r) => [r.componentId, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return res.status(404).json({
        success: false,
        error: `Components not found: ${missing.join(', ')}`,
      });
    }

    const benchRows = db
      .prepare(
        `SELECT * FROM community_benchmarks WHERE componentId IN (${placeholders})
         ORDER BY resolution ASC, settingsPreset ASC`,
      )
      .all(...ids) as any[];
    const benchByComponent: Record<string, any[]> = {};
    for (const b of benchRows) {
      (benchByComponent[b.componentId] = benchByComponent[b.componentId] || []).push({
        benchmarkId: b.benchmarkId,
        resolution: b.resolution,
        settingsPreset: b.settingsPreset,
        avgFps: Number(b.avgFps),
        onePercentLowFps: Number(b.onePercentLowFps),
        sampleCount: Number(b.sampleCount),
      });
    }

    const components = ids.map((id) => {
      const r = byId.get(id);
      const query = `${r.brand} ${r.model}`;
      return {
        componentId: r.componentId,
        category: r.category,
        brand: r.brand,
        model: r.model,
        name: query,
        socketType: r.socketType,
        ddrGen: r.ddrGen,
        formFactor: r.formFactor,
        tdpWatts: r.tdpWatts,
        priceUsd: Number(r.priceUsd) || 0,
        benchmarks: benchByComponent[id] || [],
        priceHistory: priceHistoryForComponent(r.componentId, Number(r.priceUsd) || 0),
        retailers: verifiedRetailerLinks(query),
      };
    });

    res.json({ success: true, components });
  } catch (e) {
    console.error('Component comparison error:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to compare hardware components');
  }
});

/**
 * GET /api/hardware/upgrade?deviceId=local-host
 * Real-spec upgrade advisor (explicit trigger, no synthetic tiers). Compares the
 * persisted rig's VRAM/core counts against the catalog components' real specs
 * (parsed from their model strings / seeded core map) and returns ranked,
 * factual suggestions with price + spec delta + verified retailer links. Missing
 * persisted specs produce a blocked state instead of a guess.
 */
router.get('/hardware/upgrade', (req: Request, res: Response) => {
  try {
    ensureHardwareExplorerTables();
    const deviceId =
      typeof req.query.deviceId === 'string' && req.query.deviceId.trim()
        ? req.query.deviceId.trim()
        : 'local-host';
    const row = db.prepare('SELECT * FROM "Devices" WHERE "deviceId" = ?').get(deviceId) as any;
    if (!row || row.vramGb === null || row.cpuCores === null) {
      return res.json({
        success: true,
        blocked: true,
        blockedReason: 'Missing VRAM',
        message: 'Refresh device scan required — hardware specs incomplete.',
      });
    }

    const currentVram = Number(row.vramGb);
    const currentCores = Number(row.cpuCores);
    const comps = db
      .prepare(
        `SELECT componentId, category, brand, model, priceUsd
         FROM device_components WHERE category IN ('GPU', 'CPU')`,
      )
      .all() as any[];

    const suggestions: any[] = [];
    for (const c of comps) {
      let delta: number | null = null;
      let target: number | null = null;
      let metric: string;
      if (c.category === 'GPU') {
        target = vramFromModel(c.model);
        if (target === null || target <= currentVram) continue;
        delta = Math.round((target - currentVram) * 10) / 10;
        metric = 'VRAM';
      } else {
        target = coresForComponent(c.componentId, c.model);
        if (target === null || target <= currentCores) continue;
        delta = target - currentCores;
        metric = 'Cores';
      }
      suggestions.push({
        componentId: c.componentId,
        category: c.category,
        name: `${c.brand} ${c.model}`,
        priceUsd: Number(c.priceUsd) || 0,
        metric,
        delta,
        target,
        retailers: verifiedRetailerLinks(`${c.brand} ${c.model}`),
      });
    }

    const ranked = suggestions.sort(
      (a, b) => a.priceUsd - b.priceUsd || (b.delta as number) - (a.delta as number),
    );

    res.json({
      success: true,
      blocked: false,
      current: { deviceId, vramGb: currentVram, cpuCores: currentCores },
      suggestions: ranked,
    });
  } catch (e) {
    console.error('Upgrade advisor error:', safeErrorMessage(e));
    sendApiError(res, 500, 'Failed to build upgrade suggestions');
  }
});

export default router;





