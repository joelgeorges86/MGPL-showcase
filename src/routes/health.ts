import { Router, Request, Response } from 'express';
import { db } from '../db';

/**
 * Sprint 35 (FEAT-0169-V1-RELEASE-GATE) - Container Health Probes.
 *
 * GET /healthz - Full readiness probe (verifies database connectivity and app uptime)
 * GET /livez   - Fast liveness probe (verifies server process is alive)
 */

const router = Router();

router.get('/healthz', (_req: Request, res: Response) => {
  try {
    // Lightweight DB check
    db.prepare('SELECT 1').get();

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      version: '1.0.0',
    });
  } catch (err: any) {
    // Sprint 6.1 (GAP-001): log the underlying cause server-side but never
    // echo raw error messages or stack traces back to probes/clients.
    console.error('Health probe database check failed:', err?.message || err);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
    });
  }
});

router.get('/livez', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive' });
});

export default router;
