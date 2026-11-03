import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { evaluateCompatibility, PowerProfile } from '../services/headroom';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();

// All device compatibility operations require authentication
router.use(requireAuth);

/**
 * POST /api/devices/:deviceId/compatibility/:gameId
 * Evaluates hardware compatibility and multi-axis headroom for a device and game.
 */
router.post('/:deviceId/compatibility/:gameId', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const { deviceId, gameId } = req.params;
    const { powerProfile } = req.body || {};

    // Retrieve device owned by authenticated user
    const device = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(deviceId, userId) as any;

    if (!device) {
      return res.status(404).json({ error: 'Device not found or access denied' });
    }

    // Retrieve game requirements (case and hyphen insensitive matching)
    const normalizedParam = gameId.toLowerCase().replace(/[^a-z0-9]/g, '');
    const game = db
      .prepare(`
        SELECT * FROM "AppGames"
        WHERE "GameID" = ?
           OR LOWER("GameID") = LOWER(?)
           OR LOWER(REPLACE("GameID", '-', '')) = ?
      `)
      .get(gameId, gameId, normalizedParam) as any;

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const evaluation = evaluateCompatibility(
      {
        ...device,
        isPortable: Boolean(device.isPortable),
      },
      game,
      powerProfile as PowerProfile
    );

    return res.json({
      deviceId: device.id,
      deviceName: device.deviceName,
      gameId: game.GameID,
      gameTitle: game['Game Title'] || game.GameID,
      evaluation,
    });
  } catch (err: any) {
    console.error('Error calculating device compatibility:', err?.message || err);
    return sendApiError(res, 500, 'Failed to calculate compatibility', undefined, { includeSuccess: false });
  }
});

export default router;
