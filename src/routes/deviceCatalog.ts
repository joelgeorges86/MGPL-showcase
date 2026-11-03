import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 1 (EPIC-DEV-001): Browsable hardware catalog API.
 *
 * GET  /api/catalog/devices            -> paginated, filterable catalog grid
 * GET  /api/catalog/devices/:id        -> single catalog device + specs
 * GET  /api/catalog/compare?ids=a,b    -> ordered two-device side-by-side comparison
 *
 * The catalog reads the seeded `catalog_devices` + `catalog_device_specs`
 * tables (created in src/db.ts initDb() and seeded by src/seed/devices.ts).
 * The names avoid a case-insensitive SQLite collision with the legacy scanned
 * `Devices` table. The API is public and read-only — the My Devices CRUD
 * surface stays on the auth-scoped /api/devices routes (fleetRouter).
 */

const router = Router();

const SORTABLE_COLUMNS = new Set(['msrp', 'name', 'releaseDate']);

const GPU_TIER_ORDER: Record<string, number> = {
  enthusiast: 5,
  high: 4,
  mid: 3,
  entry: 2,
  integrated: 1,
};

const CPU_TIER_ORDER: Record<string, number> = {
  flagship: 5,
  high: 4,
  mid: 3,
  entry: 2,
};

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/**
 * GET /api/catalog/devices
 * Paginated, filterable listing joined with device_specs.
 * Query params: type, brand, priceMin, priceMax, gpuTier, ramMin, storageMin,
 * sort (msrp|name|releaseDate, asc|desc), page, pageSize.
 */
router.get('/devices', (req: Request, res: Response) => {
  try {
    const { type, brand, gpuTier, sort } = req.query;
    const priceMin = num(req.query.priceMin);
    const priceMax = num(req.query.priceMax);
    const ramMin = num(req.query.ramMin);
    const storageMin = num(req.query.storageMin);
    const page = clamp(Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1), 1, 10000);
    const pageSize = clamp(Math.max(1, parseInt(String(req.query.pageSize || '12'), 10) || 12), 1, 100);

    const wheres: string[] = [];
    const params: unknown[] = [];

    if (typeof type === 'string' && type) {
      wheres.push('d.type = ?');
      params.push(type);
    }
    if (typeof brand === 'string' && brand) {
      wheres.push('d.brand = ?');
      params.push(brand);
    }
    if (priceMin !== null) {
      wheres.push('d.msrp >= ?');
      params.push(priceMin);
    }
    if (priceMax !== null) {
      wheres.push('d.msrp <= ?');
      params.push(priceMax);
    }
    if (typeof gpuTier === 'string' && gpuTier) {
      wheres.push('s.gpuTier = ?');
      params.push(gpuTier);
    }
    if (ramMin !== null) {
      wheres.push('s.ramGb >= ?');
      params.push(ramMin);
    }
    if (storageMin !== null) {
      wheres.push('s.storageGb >= ?');
      params.push(storageMin);
    }

    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const sortCol = typeof sort === 'string' && SORTABLE_COLUMNS.has(sort) ? sort : 'name';
    const sortDir = (req.query.dir === 'desc' ? 'DESC' : 'ASC') as 'ASC' | 'DESC';

    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS total FROM "catalog_devices" d LEFT JOIN "catalog_device_specs" s ON d.id = s.deviceId ${whereSql}`
      )
      .get(...params) as { total: number };

    const offset = (page - 1) * pageSize;

    const rows = db
      .prepare(
        `SELECT
           d.id, d.name, d.brand, d.type, d.releaseDate, d.msrp, d.imageUrl, d.isPrebuilt,
           s.cpuModel, s.gpuModel, s.gpuVramGb, s.ramGb, s.storageGb, s.tdpWatts, s.gpuTier, s.cpuTier
         FROM "catalog_devices" d
         LEFT JOIN "catalog_device_specs" s ON d.id = s.deviceId
         ${whereSql}
         ORDER BY d.${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset) as any[];

    // Distinct facets for filter dropdowns (honors any non-facet filters).
    const facetWheres = wheres.filter((w) => !/d\.type|d\.brand/.test(w));
    const facetWhereSql = facetWheres.length > 0 ? `WHERE ${facetWheres.join(' AND ')}` : '';
    const facetParams = params.slice(0, wheres.length - facetWheres.length);
    const facetParamsAll = [...params.slice(0, wheres.length)].filter((_, i) => {
      const w = wheres[i];
      return !/d\.type|d\.brand/.test(w);
    });

    const brandRows = db
      .prepare(
        `SELECT DISTINCT d.brand FROM "catalog_devices" d LEFT JOIN "catalog_device_specs" s ON d.id = s.deviceId ${facetWhereSql} ORDER BY d.brand ASC`
      )
      .all(...facetParamsAll) as Array<{ brand: string }>;
    const typeRows = db
      .prepare(
        `SELECT DISTINCT d.type FROM "catalog_devices" d LEFT JOIN "catalog_device_specs" s ON d.id = s.deviceId ${facetWhereSql} ORDER BY d.type ASC`
      )
      .all(...facetParamsAll) as Array<{ type: string }>;

    // GPU tiers present after applying the non-tier filters (so the tier
    // dropdown never shows empty options).
    const tierWhere = facetWheres.filter((w) => !/s\.gpuTier/.test(w));
    const tierWhereSql = tierWhere.length > 0 ? `WHERE ${tierWhere.join(' AND ')}` : '';
    const tierParams = facetParamsAll.filter((_, i) => {
      const w = facetWheres[i];
      return !/s\.gpuTier/.test(w);
    });
    const tierRows = db
      .prepare(
        `SELECT DISTINCT s.gpuTier FROM "catalog_device_specs" s LEFT JOIN "catalog_devices" d ON d.id = s.deviceId ${tierWhereSql} ORDER BY CASE s.gpuTier ${Object.entries(GPU_TIER_ORDER)
          .map(([k, v]) => `WHEN '${k}' THEN ${v}`)
          .join(' ')} ELSE 0 END DESC`
      )
      .all(...tierParams) as Array<{ gpuTier: string | null }>;

    const normalizeTier = (tier: string | null): string => tier || 'unclassified';

    res.json({
      success: true,
      total: countRow.total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(countRow.total / pageSize)),
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name,
        brand: r.brand,
        type: r.type,
        releaseDate: r.releaseDate,
        msrp: r.msrp,
        imageUrl: r.imageUrl,
        isPrebuilt: Boolean(r.isPrebuilt),
        specs: {
          cpuModel: r.cpuModel,
          gpuModel: r.gpuModel,
          gpuVramGb: r.gpuVramGb,
          ramGb: r.ramGb,
          storageGb: r.storageGb,
          tdpWatts: r.tdpWatts,
          gpuTier: normalizeTier(r.gpuTier),
          cpuTier: normalizeTier(r.cpuTier),
        },
      })),
      facets: {
        brands: brandRows.map((r) => r.brand),
        types: typeRows.map((r) => r.type),
        gpuTiers: tierRows.map((r) => normalizeTier(r.gpuTier)),
      },
    });
  } catch (err: any) {
    console.error('Error listing catalog devices:', err?.message || err);
    sendApiError(res, 500, 'Failed to list catalog devices');
  }
});

/**
 * GET /api/catalog/devices/:id
 * Single catalog device with its full spec row.
 */
router.get('/devices/:id', (req: Request, res: Response) => {
  try {
    const row = db
      .prepare(
        `SELECT
           d.id, d.name, d.brand, d.type, d.releaseDate, d.msrp, d.imageUrl, d.isPrebuilt, d.platformCanonical,
           s.cpuModel, s.gpuModel, s.gpuVramGb, s.ramGb, s.storageGb, s.tdpWatts, s.gpuTier, s.cpuTier
         FROM "catalog_devices" d
         LEFT JOIN "catalog_device_specs" s ON d.id = s.deviceId
         WHERE d.id = ?`
      )
      .get(req.params.id) as any;

    if (!row) {
      return res.status(404).json({ success: false, error: 'Device not found in catalog' });
    }

    res.json({
      success: true,
      device: {
        id: row.id,
        name: row.name,
        brand: row.brand,
        type: row.type,
        releaseDate: row.releaseDate,
        msrp: row.msrp,
        imageUrl: row.imageUrl,
        isPrebuilt: Boolean(row.isPrebuilt),
        platformCanonical: row.platformCanonical || null,
        specs: {
          cpuModel: row.cpuModel,
          gpuModel: row.gpuModel,
          gpuVramGb: row.gpuVramGb,
          ramGb: row.ramGb,
          storageGb: row.storageGb,
          tdpWatts: row.tdpWatts,
          gpuTier: row.gpuTier || 'unclassified',
          cpuTier: row.cpuTier || 'unclassified',
        },
      },
    });
  } catch (err: any) {
    console.error('Error fetching catalog device:', err?.message || err);
    sendApiError(res, 500, 'Failed to fetch catalog device');
  }
});

/**
 * GET /api/catalog/compare?ids=a,b
 * Returns exactly two catalog devices (ordered deterministically by id) with
 * their spec rows, so the comparison view can render matching rows and
 * highlight the superior value per spec.
 */
router.get('/compare', (req: Request, res: Response) => {
  try {
    const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = idsParam
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length !== 2) {
      return res.status(400).json({
        success: false,
        error: 'Comparison requires exactly two device ids (?ids=a,b)',
      });
    }

    const sortedIds = [...ids].sort();
    const placeholders = sortedIds.map(() => '?').join(', ');

    const rows = db
      .prepare(
        `SELECT
           d.id, d.name, d.brand, d.type, d.releaseDate, d.msrp, d.imageUrl, d.isPrebuilt, d.platformCanonical,
           s.cpuModel, s.gpuModel, s.gpuVramGb, s.ramGb, s.storageGb, s.tdpWatts, s.gpuTier, s.cpuTier
         FROM "catalog_devices" d
         LEFT JOIN "catalog_device_specs" s ON d.id = s.deviceId
         WHERE d.id IN (${placeholders})
         ORDER BY d.id ASC`
      )
      .all(...sortedIds) as any[];

    if (rows.length !== 2) {
      return res.status(404).json({
        success: false,
        error: 'One or both comparison devices were not found in the catalog',
      });
    }

    const mapDevice = (r: any) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      type: r.type,
      releaseDate: r.releaseDate,
      msrp: r.msrp,
      imageUrl: r.imageUrl,
      isPrebuilt: Boolean(r.isPrebuilt),
      platformCanonical: r.platformCanonical || null,
      specs: {
        cpuModel: r.cpuModel,
        gpuModel: r.gpuModel,
        gpuVramGb: r.gpuVramGb,
        ramGb: r.ramGb,
        storageGb: r.storageGb,
        tdpWatts: r.tdpWatts,
        gpuTier: r.gpuTier || 'unclassified',
        cpuTier: r.cpuTier || 'unclassified',
      },
    });

    res.json({
      success: true,
      left: mapDevice(rows[0]),
      right: mapDevice(rows[1]),
      gpuTierOrder: GPU_TIER_ORDER,
      cpuTierOrder: CPU_TIER_ORDER,
    });
  } catch (err: any) {
    console.error('Error comparing catalog devices:', err?.message || err);
    sendApiError(res, 500, 'Failed to compare catalog devices');
  }
});

export default router;