import { Router, Request, Response } from 'express';
import { db } from '../db';
import { optionalAuth } from '../middleware/auth';
import {
  PERFORMANCE_TIERS,
  PerformanceTier,
  classifyBuildTiers,
  classifyCpuModel,
  classifyGpuModel,
  normalizeCpuTier,
  normalizeGpuTier,
} from '../seed/performance';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 3 (EPIC-DEV-001): Cross-Library Performance Matrix, Two-Device Compare
 * & Upgrade Advisor API.
 *
 *  GET /api/performance/devices         -> unified device selector options
 *  GET /api/performance/matrix          -> per-game FPS grid for a device
 *  GET /api/performance/compare         -> side-by-side device performance
 *  GET /api/performance/recommendations -> ranked upgrade suggestions
 *
 * The catalog is public; My Devices and saved builds populate only when the
 * caller is authenticated (optionalAuth attaches req.user). All projections are
 * read from the deterministic `game_performance_profiles` seed, never from live
 * UI state (the DB is authoritative per VCM Chapter 22).
 */

const router = Router();

const TIER_SET = new Set<string>(PERFORMANCE_TIERS);

interface DeviceOption {
  source: 'catalog' | 'active' | 'my-device' | 'build';
  id: string;
  name: string;
  gpuTier: PerformanceTier;
  cpuTier: PerformanceTier;
}

interface GameMatrixRow {
  gameId: string;
  title: string;
  fps4kUltra: number;
  fps1440pHigh: number;
  fps1080pMed: number;
  fps720pLow: number;
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const safeTier = (v: unknown): PerformanceTier | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  const match = TIER_SET.has(t) ? (t as PerformanceTier) : null;
  return match;
};

function requireTierPair(req: Request, res: Response): {
  gpuTier: PerformanceTier;
  cpuTier: PerformanceTier;
} | null {
  const gpuTier = safeTier(req.query.gpuTier) || normalizeGpuTier(asStr(req.query.gpuTier));
  const cpuTier = safeTier(req.query.cpuTier) || normalizeCpuTier(asStr(req.query.cpuTier));
  if (TIER_SET.has(gpuTier) && TIER_SET.has(cpuTier)) {
    return { gpuTier, cpuTier };
  }
  res.status(400).json({
    success: false,
    error: 'gpuTier and cpuTier must be one of Entry, Mid, High, Flagship',
  });
  return null;
}

/** All game performance rows for a (gpu, cpu) pair over the owned library. */
function fetchMatrix(gpuTier: PerformanceTier, cpuTier: PerformanceTier): GameMatrixRow[] {
  const rows = db
    .prepare(
      `SELECT p.gameId, g."Game Title" AS title,
              p.fps4kUltra, p.fps1440pHigh, p.fps1080pMed, p.fps720pLow
       FROM "game_performance_profiles" p
       JOIN "AppGames" g ON g."GameID" = p.gameId
       JOIN "AppOwnership" o ON o."GameID" = p.gameId
       WHERE p.gpuTier = ? AND p.cpuTier = ?
       GROUP BY p.gameId
       ORDER BY g."Game Title" ASC`,
    )
    .all(gpuTier, cpuTier) as any[];

  return rows.map((r) => ({
    gameId: r.gameId,
    title: r.title || r.gameId,
    fps4kUltra: Number(r.fps4kUltra) || 0,
    fps1440pHigh: Number(r.fps1440pHigh) || 0,
    fps1080pMed: Number(r.fps1080pMed) || 0,
    fps720pLow: Number(r.fps720pLow) || 0,
  }));
}

/** Percent of the owned library that reaches 60 FPS @ 1080p for a tier pair. */
function computeSummary(gpuTier: PerformanceTier, cpuTier: PerformanceTier) {
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN p.fps1080pMed >= 60 THEN 1 ELSE 0 END) AS at60
       FROM "game_performance_profiles" p
       JOIN "AppOwnership" o ON o."GameID" = p.gameId
       WHERE p.gpuTier = ? AND p.cpuTier = ?`,
    )
    .get(gpuTier, cpuTier) as { c: number; at60: number | null };

  const total = Number(rows.c) || 0;
  const at60 = Number(rows.at60) || 0;
  const pctAt60 = total > 0 ? Math.round((at60 / total) * 100) : 0;
  return { total, at60Fps1080p: at60, pctAt60 };
}

function deviceMatrixPayload(gpuTier: PerformanceTier, cpuTier: PerformanceTier, name?: string) {
  return {
    device: { name: name || `${gpuTier} / ${cpuTier}`, gpuTier, cpuTier },
    summary: computeSummary(gpuTier, cpuTier),
    games: fetchMatrix(gpuTier, cpuTier),
  };
}

/** Compute the percentage of owned games that hit 60 FPS @ 1080p. */
function pct60For(gpuTier: PerformanceTier, cpuTier: PerformanceTier): number {
  return computeSummary(gpuTier, cpuTier).pctAt60;
}

/**
 * GET /api/performance/devices
 * Unified selector grouped by source. Catalog always present; active device,
 * my devices, and saved builds require auth.
 */
router.get('/devices', optionalAuth, (req: Request, res: Response) => {
  try {
    const options: DeviceOption[] = [];

    // Catalog devices (public).
    const catalog = db
      .prepare(
        `SELECT d.id, d.name, s.gpuTier, s.cpuTier
         FROM "catalog_devices" d
         LEFT JOIN "catalog_device_specs" s ON s.deviceId = d.id
         ORDER BY d.name ASC`,
      )
      .all() as Array<{ id: string; name: string; gpuTier: string | null; cpuTier: string | null }>;
    for (const c of catalog) {
      options.push({
        source: 'catalog',
        id: c.id,
        name: c.name,
        gpuTier: normalizeGpuTier(c.gpuTier),
        cpuTier: normalizeCpuTier(c.cpuTier),
      });
    }

    const userId = (req as any).user?.userId;
    if (userId) {
      const devices = db
        .prepare(
          `SELECT id, deviceName, gpuModel, vramGb, gpuType, cpuModel, cpuCores, isPrimary
           FROM "AppDevices" WHERE userId = ? ORDER BY isPrimary DESC, createdAt DESC`,
        )
        .all(userId) as Array<{
        id: string;
        deviceName: string;
        gpuModel: string | null;
        vramGb: number | null;
        gpuType: string | null;
        cpuModel: string | null;
        cpuCores: number | null;
        isPrimary: number;
      }>;

      for (const d of devices) {
        const isPrimary = Boolean(d.isPrimary);
        options.push({
          source: isPrimary ? 'active' : 'my-device',
          id: d.id,
          name: d.deviceName,
          gpuTier: classifyGpuModel(d.gpuModel, d.vramGb, d.gpuType),
          cpuTier: classifyCpuModel(d.cpuModel, d.cpuCores),
        });
      }

      const builds = db
        .prepare(
          `SELECT buildId, buildName, componentsJson FROM "device_builds" WHERE userId = ? ORDER BY createdAt DESC`,
        )
        .all(userId) as Array<{ buildId: string; buildName: string; componentsJson: string }>;
      for (const b of builds) {
        const tiers = classifyBuildTiers(b.componentsJson);
        options.push({
          source: 'build',
          id: b.buildId,
          name: b.buildName,
          gpuTier: tiers.gpuTier,
          cpuTier: tiers.cpuTier,
        });
      }
    }

    res.json({ success: true, devices: options });
  } catch (err: any) {
    console.error('Error listing performance devices:', err?.message || err);
    sendApiError(res, 500, 'Failed to list performance devices');
  }
});

/**
 * GET /api/performance/matrix?gpuTier=&cpuTier=&name=
 * Library-wide FPS grid for a single target device profile.
 */
router.get('/matrix', (req: Request, res: Response) => {
  try {
    const pair = requireTierPair(req, res);
    if (!pair) return;
    const name = typeof req.query.name === 'string' ? req.query.name : undefined;
    res.json({ success: true, ...deviceMatrixPayload(pair.gpuTier, pair.cpuTier, name) });
  } catch (err: any) {
    console.error('Error calculating performance matrix:', err?.message || err);
    sendApiError(res, 500, 'Failed to calculate performance matrix');
  }
});

/**
 * GET /api/performance/compare?aGpu=&aCpu=&bGpu=&bCpu=...
 * Side-by-side performance projections for Device A vs Device B over the library.
 */
router.get('/compare', (req: Request, res: Response) => {
  try {
    const aGpu = safeTier(req.query.aGpu) || normalizeGpuTier(asStr(req.query.aGpu));
    const aCpu = safeTier(req.query.aCpu) || normalizeCpuTier(asStr(req.query.aCpu));
    const bGpu = safeTier(req.query.bGpu) || normalizeGpuTier(asStr(req.query.bGpu));
    const bCpu = safeTier(req.query.bCpu) || normalizeCpuTier(asStr(req.query.bCpu));

    if (![aGpu, aCpu, bGpu, bCpu].every((t) => TIER_SET.has(t))) {
      return res.status(400).json({
        success: false,
        error: 'aGpu, aCpu, bGpu, bCpu must each be one of Entry, Mid, High, Flagship',
      });
    }

    const a = deviceMatrixPayload(aGpu, aCpu, typeof req.query.aName === 'string' ? req.query.aName : 'Device A');
    const b = deviceMatrixPayload(bGpu, bCpu, typeof req.query.bName === 'string' ? req.query.bName : 'Device B');

    const aById = new Map(a.games.map((g) => [g.gameId, g]));
    const rows = b.games.map((bg) => {
      const ag = aById.get(bg.gameId);
      return {
        gameId: bg.gameId,
        title: bg.title,
        aFps1080pMed: ag ? ag.fps1080pMed : null,
        bFps1080pMed: bg.fps1080pMed,
        delta1080p: ag ? bg.fps1080pMed - ag.fps1080pMed : null,
        aFps4kUltra: ag ? ag.fps4kUltra : null,
        bFps4kUltra: bg.fps4kUltra,
        delta4k: ag ? bg.fps4kUltra - ag.fps4kUltra : null,
        aFps1440pHigh: ag ? ag.fps1440pHigh : null,
        bFps1440pHigh: bg.fps1440pHigh,
        delta1440p: ag ? bg.fps1440pHigh - ag.fps1440pHigh : null,
        aFps720pLow: ag ? ag.fps720pLow : null,
        bFps720pLow: bg.fps720pLow,
        delta720p: ag ? bg.fps720pLow - ag.fps720pLow : null,
      };
    });

    const compareGames = rows.filter((r) => r.aFps1080pMed !== null);
    const avgDelta1080p = compareGames.length
      ? Math.round(compareGames.reduce((s, r) => s + (r.delta1080p || 0), 0) / compareGames.length)
      : 0;
    const bWins = compareGames.filter((r) => (r.delta1080p || 0) > 0).length;
    const bLosses = compareGames.filter((r) => (r.delta1080p || 0) < 0).length;

    res.json({
      success: true,
      deviceA: a.device,
      deviceB: b.device,
      summaryA: a.summary,
      summaryB: b.summary,
      compare: {
        avgDelta1080p,
        bWins,
        bLosses,
      },
      games: rows,
    });
  } catch (err: any) {
    console.error('Error comparing performance:', err?.message || err);
    sendApiError(res, 500, 'Failed to compare performance');
  }
});

interface Candidate {
  source: 'component' | 'catalog';
  id: string;
  name: string;
  gpuTier: PerformanceTier;
  cpuTier: PerformanceTier;
  cost: number;
  pctAt60: number;
  gain: number;
}

/**
 * Rank candidate upgrades. Components (GPUs) change only the GPU tier; catalog
 * devices change both GPU and CPU tiers. Each candidate is scored by its
 * resulting `pctAt60` against the current baseline.
 */
function buildCandidates(
  currentGpuTier: PerformanceTier,
  currentCpuTier: PerformanceTier,
  currentPct: number,
): Candidate[] {
  const candidates: Candidate[] = [];

  const gpus = db
    .prepare('SELECT componentId, model, priceUsd FROM "device_components" WHERE category = ? ORDER BY priceUsd ASC')
    .all('GPU') as Array<{ componentId: string; model: string; priceUsd: number }>;
  for (const g of gpus) {
    const gpuTier = classifyGpuModel(g.model, null, null);
    if (gpuTier === currentGpuTier) continue;
    const pct = pct60For(gpuTier, currentCpuTier);
    if (pct <= currentPct) continue;
    candidates.push({
      source: 'component',
      id: g.componentId,
      name: `Upgrade to ${g.model}`,
      gpuTier,
      cpuTier: currentCpuTier,
      cost: Number(g.priceUsd) || 0,
      pctAt60: pct,
      gain: pct - currentPct,
    });
  }

  const catalog = db
    .prepare(
      `SELECT d.id, d.name, d.msrp, s.gpuTier, s.cpuTier
       FROM "catalog_devices" d
       LEFT JOIN "catalog_device_specs" s ON s.deviceId = d.id
       ORDER BY d.msrp ASC`,
    )
    .all() as Array<{ id: string; name: string; msrp: number | null; gpuTier: string | null; cpuTier: string | null }>;
  for (const c of catalog) {
    const gpuTier = normalizeGpuTier(c.gpuTier);
    const cpuTier = normalizeCpuTier(c.cpuTier);
    if (gpuTier === currentGpuTier && cpuTier === currentCpuTier) continue;
    const pct = pct60For(gpuTier, cpuTier);
    if (pct <= currentPct) continue;
    candidates.push({
      source: 'catalog',
      id: c.id,
      name: c.name,
      gpuTier,
      cpuTier,
      cost: Number(c.msrp) || 0,
      pctAt60: pct,
      gain: pct - currentPct,
    });
  }

  return candidates;
}

function rank(candidates: Candidate[]) {
  const byCost = [...candidates].filter((c) => c.cost > 0).sort((a, b) => a.cost - b.cost || b.gain - a.gain);
  const byValue = [...candidates].filter((c) => c.cost > 0).sort((a, b) => (b.gain / b.cost) - (a.gain / a.cost));
  const byPct = [...candidates].sort((a, b) => b.pctAt60 - a.pctAt60 || a.cost - b.cost);
  return {
    cheapest: byCost[0] || null,
    bestValue: byValue[0] || null,
    bestPerformance: byPct[0] || null,
  };
}

/**
 * GET /api/performance/recommendations?gpuTier=&cpuTier=
 * When <70% of the library reaches 60 FPS @ 1080p, surface three ranked
 * upgrade options with estimated cost and projected gain.
 */
router.get('/recommendations', (req: Request, res: Response) => {
  try {
    const pair = requireTierPair(req, res);
    if (!pair) return;
    const current = computeSummary(pair.gpuTier, pair.cpuTier);
    const threshold = 70;

    const ranked = rank(
      buildCandidates(pair.gpuTier, pair.cpuTier, current.pctAt60),
    );

    res.json({
      success: true,
      belowThreshold: current.pctAt60 < threshold,
      summary: current,
      recommendations: ranked,
    });
  } catch (err: any) {
    console.error('Error building upgrade recommendations:', err?.message || err);
    sendApiError(res, 500, 'Failed to build upgrade recommendations');
  }
});

export default router;