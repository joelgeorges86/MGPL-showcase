import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { FORM_FACTOR_RANK } from '../seed/components';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 2 (EPIC-DEV-001): Custom PC Builder API.
 *
 *  GET /api/builder/components       -> filtered component catalog listing
 *  POST /api/builder/validate        -> compatibility evaluation for selected ids
 *  POST /api/builder/builds          -> persist a user build (auth required, max 20)
 *  GET  /api/builder/builds          -> list the authenticated user's builds
 *  GET  /api/builder/share/:slug     -> public read-only shared build snapshot
 *
 * The compatibility engine drives the builder's live banner and the "Incompatible"
 * badges in the part picker. Wattage estimation is `ceil(totalTdp * 1.20)` per the
 * "Total TDP + 20% overhead" estimator contract.
 */

const router = Router();

const MAX_BUILDS_PER_USER = 20;

interface ComponentView {
  componentId: string;
  category: string;
  brand: string;
  model: string;
  name: string;
  socketType: string | null;
  ddrGen: string | null;
  formFactor: string | null;
  tdpWatts: number | null;
  priceUsd: number;
  imageUrl: string | null;
}

interface CompatibilityIssue {
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
}

function rowToComponent(row: any): ComponentView {
  return {
    componentId: row.componentId,
    category: row.category,
    brand: row.brand,
    model: row.model,
    name: `${row.brand} ${row.model}`,
    socketType: row.socketType ?? null,
    ddrGen: row.ddrGen ?? null,
    formFactor: row.formFactor ?? null,
    tdpWatts: row.tdpWatts != null ? Number(row.tdpWatts) : null,
    priceUsd: Number(row.priceUsd) || 0,
    imageUrl: row.imageUrl ?? null,
  };
}

/** Sum of power draw (TDP) across non-PSU components only. */
function loadTdp(components: ComponentView[]): number {
  return components
    .filter((c) => c.category !== 'PSU')
    .reduce((sum, c) => sum + (c.tdpWatts || 0), 0);
}

/** Total 20%-overhead power estimate. */
export function estimateWattage(components: ComponentView[]): number {
  const totalTdp = loadTdp(components);
  return totalTdp > 0 ? Math.ceil(totalTdp * 1.2) : 0;
}

function totalPrice(components: ComponentView[]): number {
  return Math.round(components.reduce((sum, c) => sum + (c.priceUsd || 0), 0) * 100) / 100;
}

/**
 * Evaluate selected components against the declarative compatibility rules.
 * Returns the structured issue list plus the price/wattage rollups so the UI
 * can render the summary bar and banner in one round trip.
 */
export function evaluateBuild(ids: string[]): {
  compatible: boolean;
  issues: CompatibilityIssue[];
  totalPrice: number;
  totalTdp: number;
  estimatedWattage: number;
  components: ComponentView[];
} {
  const issues: CompatibilityIssue[] = [];

  if (!Array.isArray(ids) || ids.length === 0) {
    return { compatible: true, issues: [], totalPrice: 0, totalTdp: 0, estimatedWattage: 0, components: [] };
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM "device_components" WHERE "componentId" IN (${placeholders})`)
    .all(...ids) as any[];
  const byId = new Map(rows.map((r) => [r.componentId, r]));
  const components: ComponentView[] = ids.map((id) => byId.get(id)).filter((r): r is any => Boolean(r)).map(rowToComponent);

  // Category presence guards: only evaluate rules whose categories are filled.
  const byCategory = new Map<string, ComponentView>();
  for (const c of components) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, c);
  }

  const rules = db
    .prepare('SELECT * FROM "compatibility_rules" ORDER BY "ruleId"')
    .all() as any[];

  for (const rule of rules) {
    if (rule.ruleId === 'rule-psu-headroom') {
      const psu = byCategory.get('PSU');
      const load = estimateWattage(components);
      if (psu && load > 0 && (psu.tdpWatts || 0) < load) {
        issues.push({
          ruleId: rule.ruleId,
          severity: rule.severity || 'error',
          message: rule.messageTemplate.replace('{load}', String(load)).replace('{supply}', String(psu.tdpWatts)),
        });
      }
      continue;
    }

    const a = rule.categoryA ? byCategory.get(rule.categoryA) : undefined;
    const b = rule.categoryB ? byCategory.get(rule.categoryB) : undefined;
    if (!a || !b) continue; // both sides must be selected to evaluate

    const valA = a[rule.fieldA as keyof ComponentView] as string | null;
    const valB = b[rule.fieldB as keyof ComponentView] as string | null;

    let violated = false;
    if (rule.operator === 'eq') {
      violated = !!valA && !!valB && valA !== valB;
    } else if (rule.operator === 'fits') {
      const rankA = FORM_FACTOR_RANK[String(valA || '')];
      const rankB = FORM_FACTOR_RANK[String(valB || '')];
      if (rankA !== undefined && rankB !== undefined) {
        violated = rankA > rankB;
      }
    }

    if (violated) {
      issues.push({
        ruleId: rule.ruleId,
        severity: rule.severity || 'error',
        message: rule.messageTemplate
          .replace('{CPU}', a.model)
          .replace('{socketA}', String(valA || 'N/A'))
          .replace('{socketB}', String(valB || 'N/A'))
          .replace('{ddrA}', String(valA || 'N/A'))
          .replace('{ddrB}', String(valB || 'N/A'))
          .replace('{boardA}', a.model)
          .replace('{caseB}', b.model),
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    compatible: errors === 0,
    issues,
    totalPrice: totalPrice(components),
    totalTdp: Math.round(loadTdp(components)),
    estimatedWattage: estimateWattage(components),
    components,
  };
}

/**
 * GET /api/builder/components
 * Optional filters: ?category=CPU|GPU|... and ?search=ryzen (fuzzy brand/model).
 */
router.get('/components', (req: Request, res: Response) => {
  try {
    const wheres: string[] = [];
    const params: unknown[] = [];

    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (category) {
      wheres.push('"category" = ?');
      params.push(category);
    }
    if (search) {
      wheres.push('("brand" LIKE ? OR "model" LIKE ? OR ("brand" || " " || "model") LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM "device_components" ${whereSql} ORDER BY "category", "priceUsd" ASC`)
      .all(...params) as any[];

    const categories = (db
      .prepare('SELECT DISTINCT "category" FROM "device_components" ORDER BY "category"')
      .all() as Array<{ category: string }>).map((r) => r.category);

    res.json({ success: true, categories, components: rows.map(rowToComponent) });
  } catch (err: any) {
    console.error('Error listing builder components:', err?.message || err);
    sendApiError(res, 500, 'Failed to list builder components');
  }
});

/**
 * POST /api/builder/validate
 * Body: { componentIds: string[] }
 */
router.post('/validate', (req: Request, res: Response) => {
  try {
    const ids = Array.isArray(req.body?.componentIds)
      ? (req.body.componentIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const result = evaluateBuild(ids);
    res.json({
      success: true,
      compatible: result.compatible,
      issues: result.issues,
      totalPrice: result.totalPrice,
      totalTdp: result.totalTdp,
      estimatedWattage: result.estimatedWattage,
      componentCount: result.components.length,
    });
  } catch (err: any) {
    console.error('Error validating build:', err?.message || err);
    sendApiError(res, 500, 'Failed to validate build');
  }
});

function serializeBuild(row: any) {
  let components: ComponentView[] = [];
  let compatible = true;
  let issues: CompatibilityIssue[] = [];
  try {
    const parsed = JSON.parse(row.componentsJson || '{}');
    components = Array.isArray(parsed.components) ? parsed.components : [];
    compatible = parsed.compatible !== false;
    issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  } catch (e) {
    // Malformed snapshot degrades to an empty read-only build.
  }
  return {
    buildId: row.buildId,
    buildName: row.buildName,
    shareSlug: row.shareSlug,
    createdAt: row.createdAt,
    totalPrice: Number(row.totalPriceSnapshot) || 0,
    estimatedWattage: Number(row.estimatedWattage) || 0,
    compatible,
    issues,
    components,
  };
}

/**
 * POST /api/builder/builds
 * Body: { buildName: string, componentIds: string[] }
 * Persists the full component snapshot (componentsJson) with a unique shareSlug
 * and server-computed price/wattage. Caps each user at MAX_BUILDS_PER_USER.
 */
router.post('/builds', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const buildName = typeof req.body?.buildName === 'string' ? req.body.buildName.trim() : '';
    const ids = Array.isArray(req.body?.componentIds)
      ? (req.body.componentIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    if (!buildName) {
      return res.status(400).json({ success: false, error: 'buildName is required' });
    }

    const countRow = db
      .prepare('SELECT COUNT(*) AS c FROM "device_builds" WHERE "userId" = ?')
      .get(userId) as { c: number };
    if (countRow.c >= MAX_BUILDS_PER_USER) {
      return res.status(409).json({
        success: false,
        error: `Build limit reached: maximum ${MAX_BUILDS_PER_USER} saved builds per user.`,
      });
    }

    const result = evaluateBuild(ids);
    const buildId = randomUUID();
    const shareSlug = randomUUID().replace(/-/g, '').slice(0, 12);
    const componentsJson = JSON.stringify({
      components: result.components,
      issues: result.issues,
      compatible: result.compatible,
    });

    db.prepare(
      `INSERT INTO "device_builds" (
        "buildId", "userId", "buildName", "shareSlug", "componentsJson",
        "totalPriceSnapshot", "estimatedWattage"
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(buildId, userId, buildName, shareSlug, componentsJson, result.totalPrice, result.estimatedWattage);

    const created = db.prepare('SELECT * FROM "device_builds" WHERE "buildId" = ?').get(buildId) as any;
    res.status(201).json({ success: true, build: serializeBuild(created) });
  } catch (err: any) {
    console.error('Error saving build:', err?.message || err);
    sendApiError(res, 500, 'Failed to save build');
  }
});

/**
 * GET /api/builder/builds
 * Lists the authenticated user's saved builds (most recent first).
 */
router.get('/builds', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const rows = db
      .prepare('SELECT * FROM "device_builds" WHERE "userId" = ? ORDER BY "createdAt" DESC')
      .all(userId) as any[];
    res.json({ success: true, builds: rows.map(serializeBuild) });
  } catch (err: any) {
    console.error('Error listing builds:', err?.message || err);
    sendApiError(res, 500, 'Failed to list builds');
  }
});

/**
 * GET /api/builder/share/:slug
 * Public read-only fetch for a shared build snapshot.
 */
router.get('/share/:slug', (req: Request, res: Response) => {
  try {
    const row = db
      .prepare('SELECT * FROM "device_builds" WHERE "shareSlug" = ?')
      .get(req.params.slug) as any;

    if (!row) {
      return res.status(404).json({ success: false, error: 'Shared build not found' });
    }

    res.json({ success: true, build: serializeBuild(row) });
  } catch (err: any) {
    console.error('Error fetching shared build:', err?.message || err);
    sendApiError(res, 500, 'Failed to fetch shared build');
  }
});

export default router;