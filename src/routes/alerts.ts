import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();

// Sprint 2 (FEAT-MULTITENANT): Price alerts are user-scoped. Every read and
// write filters by req.user.userId so cross-tenant alert visibility/mutation is
// impossible. Unauthenticated callers receive 401 from requireAuth.
router.use(requireAuth);

/**
 * FEAT-0158 (S25) / FEAT-MULTITENANT — Price Alert API.
 *
 * GET    /api/alerts       -> list the authenticated user's price alerts.
 * POST   /api/alerts       -> upsert a price alert threshold (user-scoped).
 * DELETE /api/alerts/:gameId -> delete a price alert owned by the user (404 otherwise).
 *
 * The legacy /api/deals/alerts paths in deals.ts are delegated to this router
 * so the existing client-visible URL keeps working while state is scoped.
 */

/**
 * GET /api/alerts
 * Returns all price alerts for the authenticated user with updated/calculated
 * triggered states.
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const alerts = db.prepare('SELECT * FROM AppPriceAlerts WHERE userId = ? ORDER BY createdAt DESC').all(userId);
    res.json({
      success: true,
      count: (alerts as any[]).length,
      alerts,
    });
  } catch (err: any) {
    console.error('Error in GET /api/alerts:', err?.message || err);
    sendApiError(res, 500, 'Failed to fetch price alerts');
  }
});

/**
 * GET /api/alerts/triggered
 * Returns active triggered alerts for the authenticated user that have not been acknowledged.
 */
router.get('/triggered', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const alerts = db.prepare(`
      SELECT * FROM AppPriceAlerts
      WHERE userId = ? AND isTriggered = 1 AND (acknowledged IS NULL OR acknowledged = 0)
      ORDER BY updatedAt DESC
    `).all(userId);

    res.json({
      success: true,
      count: (alerts as any[]).length,
      alerts,
    });
  } catch (err: any) {
    console.error('Error in GET /api/alerts/triggered:', err?.message || err);
    sendApiError(res, 500, 'Failed to fetch triggered price alerts');
  }
});

/**
 * POST /api/alerts/triggered/:id/acknowledge
 * Dismisses/acknowledges a triggered price alert for the authenticated user.
 */
router.post('/triggered/:id/acknowledge', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const { id } = req.params;

    const alert = db.prepare(`
      SELECT * FROM AppPriceAlerts
      WHERE userId = ? AND (id = ? OR gameId = ?)
    `).get(userId, id, id) as any;

    if (!alert) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    db.prepare(`
      UPDATE AppPriceAlerts
      SET acknowledged = 1, updatedAt = CURRENT_TIMESTAMP
      WHERE userId = ? AND id = ?
    `).run(userId, alert.id);

    res.json({
      success: true,
      message: `Alert acknowledged for ${alert.title}`,
      alertId: alert.id,
      gameId: alert.gameId,
    });
  } catch (err: any) {
    console.error('Error in POST /api/alerts/triggered/:id/acknowledge:', err?.message || err);
    sendApiError(res, 500, 'Failed to acknowledge price alert');
  }
});

/**
 * POST /api/alerts
 * Upserts a price alert threshold scoped to the authenticated user and checks
 * whether currentPrice <= targetPrice. Resets acknowledged state to 0 on edit.
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const { gameId, title, gameTitle, targetPrice, currentPrice, price, historicalLow } = req.body || {};

    const resolvedTitle = title || gameTitle;
    if (!resolvedTitle) {
      return res.status(400).json({ success: false, error: 'gameTitle or title is required' });
    }

    const id = gameId || `game-${resolvedTitle.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const curPrice = parseFloat(currentPrice ?? price ?? 0) || 0;
    const tgtPrice = parseFloat(targetPrice ?? curPrice) || 0;
    const histLow = parseFloat(historicalLow ?? curPrice) || 0;
    const isTrig = curPrice > 0 && curPrice <= tgtPrice ? 1 : 0;

    const stmt = db.prepare(`
      INSERT INTO AppPriceAlerts (userId, gameId, title, targetPrice, currentPrice, historicalLow, isTriggered, acknowledged, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(userId, gameId) DO UPDATE SET
        title = excluded.title,
        targetPrice = excluded.targetPrice,
        currentPrice = COALESCE(excluded.currentPrice, AppPriceAlerts.currentPrice),
        historicalLow = COALESCE(excluded.historicalLow, AppPriceAlerts.historicalLow),
        isTriggered = excluded.isTriggered,
        acknowledged = 0,
        updatedAt = CURRENT_TIMESTAMP
    `);

    stmt.run(userId, id, resolvedTitle, tgtPrice, curPrice, histLow, isTrig);

    const alert = db.prepare('SELECT * FROM AppPriceAlerts WHERE userId = ? AND gameId = ?').get(userId, id) as any;

    res.json({
      success: true,
      alert,
      // Legacy backward compatibility fields
      alertId: alert?.id,
      gameTitle: resolvedTitle,
      price: curPrice,
      targetPrice: tgtPrice,
      historicalLow: histLow,
      triggered: Boolean(isTrig),
      message: isTrig ? `Price alert triggered for ${resolvedTitle}!` : `Price alert saved for ${resolvedTitle}.`,
    });
  } catch (err: any) {
    console.error('Error in POST /api/alerts:', err?.message || err);
    sendApiError(res, 500, 'Failed to save price alert');
  }
});

/**
 * DELETE /api/alerts/:gameId
 * Removes a price alert record owned by the authenticated user. Returns 404
 * when the alert does not belong to them (no cross-tenant deletion).
 */
router.delete('/:gameId', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const { gameId } = req.params;
    const result = db.prepare('SELECT * FROM AppPriceAlerts WHERE userId = ? AND (gameId = ? OR id = ?)').get(userId, gameId, gameId) as any;

    if (!result) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    db.prepare('DELETE FROM AppPriceAlerts WHERE id = ?').run(result.id);

    res.json({
      success: true,
      message: `Alert removed for ${result.title}`,
      gameId: result.gameId,
    });
  } catch (err: any) {
    console.error('Error in DELETE /api/alerts/:gameId:', err?.message || err);
    sendApiError(res, 500, 'Failed to delete price alert');
  }
});

export default router;