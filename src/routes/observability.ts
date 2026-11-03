import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  getIntegrationHealth,
  renderIntegrationMetricsText,
  recordIntegrationEvent,
  INTEGRATION_KEYS,
  INTEGRATION_EVENTS,
} from '../services/integrationMonitor';
import { sendApiError } from '../middleware/errorSanitizer';
import { DATA_AS_OF_HEADER } from '../middleware/fallbackRenderer';

/**
 * Sprint 6 (PI-GTM-2026-002) — Unified Integration Health Dashboard API.
 *
 * GET /api/observability/health
 *   - Sanitized JSON snapshot of every external integration: static status
 *     names + integer counters only. No uptime, version, database internals,
 *     env metadata, request payloads, or stack traces.
 *   - Hard 5 req/sec rate limiter (windowMs 1000, limit 5), like /api/dpm/health.
 *
 * GET /api/observability/metrics
 *   - Prometheus text/plain exposition (dependency-free) rendered from the
 *     shared registry in src/services/integrationMonitor.ts. Only static
 *     metric names, static label values, and integer values are emitted.
 *
 * POST /api/observability/record
 *   - Operational event ingestion for modules/admins to report successes,
 *     failures, rate limits, domain rejections, and token expirations. Inputs
 *     are exact-match validated against the static registry and never echoed;
 *     only integer counters are mutated (privacy-minimized).
 */

const router = Router();

const healthLimiter = rateLimit({
  windowMs: 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many observability health requests. Try again shortly.' },
});

const metricsLimiter = rateLimit({
  windowMs: 5000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many observability metrics requests. Try again shortly.' },
});

const recordLimiter = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many observability record requests. Try again shortly.' },
});

router.get('/health', healthLimiter, (_req: Request, res: Response) => {
  res.set(DATA_AS_OF_HEADER, new Date().toISOString());
  res.status(200).json(getIntegrationHealth());
});

router.get('/metrics', metricsLimiter, (_req: Request, res: Response) => {
  res
    .status(200)
    .set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(renderIntegrationMetricsText());
});

router.post('/record', recordLimiter, (req: Request, res: Response) => {
  const body = req.body || {};
  const integration = typeof body.integration === 'string' ? body.integration.trim() : '';
  const event = typeof body.event === 'string' ? body.event.trim() : '';

  if (!(INTEGRATION_KEYS as readonly string[]).includes(integration)) {
    return sendApiError(res, 400, 'Unknown integration.');
  }
  if (!(INTEGRATION_EVENTS as readonly string[]).includes(event)) {
    return sendApiError(res, 400, 'Unknown event type.');
  }

  recordIntegrationEvent(integration, event);
  res.json({ success: true });
});

export default router;
