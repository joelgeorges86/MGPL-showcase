import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { renderDpmMetricsText, setDpmHealth } from '../services/devicePlayability';

/**
 * Sprint 6.1 (GAP-001) / Sprint 1B (EPICSEC06) — DPM (Device Playability
 * Matrix) Health & Telemetry Endpoints.
 *
 * GET /api/dpm/health
 *   - Sanitized payload: { status: "ok", timestamp } ONLY.
 *   - No uptime, version, database internals, env metadata, or stack traces.
 *   - Hard 5 req/sec rate limiter (windowMs 1000, limit 5).
 *
 * GET /api/dpm/metrics
 *   - Prometheus text/plain exposition format (dependency-free) rendered from
 *     the shared DPM telemetry registry in src/services/devicePlayability.ts.
 *   - Exposes active health status, cache hit/miss counts, retry counts, and
 *     degraded-state fallback counts. Safe by construction: only static metric
 *     names + integer values are emitted — never request data or raw errors.
 */

const router = Router();

const dpmHealthLimiter = rateLimit({
  windowMs: 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many DPM health requests. Try again shortly.' },
});

const dpmMetricsLimiter = rateLimit({
  windowMs: 5000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many DPM metrics requests. Try again shortly.' },
});

router.get('/health', dpmHealthLimiter, (_req: Request, res: Response) => {
  setDpmHealth(true);
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/metrics', dpmMetricsLimiter, (_req: Request, res: Response) => {
  res
    .status(200)
    .set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(renderDpmMetricsText());
});

export default router;
