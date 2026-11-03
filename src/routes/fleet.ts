import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();

// All fleet device operations require authentication and operate on the current user's fleet
router.use(requireAuth);

/**
 * GET /api/devices
 * Retrieves all registered hardware devices for the authenticated user.
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const devices = db
      .prepare('SELECT * FROM "AppDevices" WHERE userId = ? ORDER BY createdAt DESC')
      .all(userId) as any[];

    // Map boolean flag isPortable
    const result = devices.map((d) => ({
      ...d,
      isPortable: Boolean(d.isPortable),
      isPrimary: Boolean(d.isPrimary),
    }));

    return res.json({ devices: result });
  } catch (err: any) {
    console.error('Error fetching fleet devices:', err?.message || err);
    return sendApiError(res, 500, 'Failed to fetch devices', undefined, { includeSuccess: false });
  }
});

/**
 * GET /api/devices/:id
 * Retrieves a single device by ID for the authenticated user.
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const { id } = req.params;

    const device = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(id, userId) as any;

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    return res.json({
      device: {
        ...device,
        isPortable: Boolean(device.isPortable),
        isPrimary: Boolean(device.isPrimary),
      },
    });
  } catch (err: any) {
    console.error('Error fetching device:', err?.message || err);
    return sendApiError(res, 500, 'Failed to fetch device', undefined, { includeSuccess: false });
  }
});

/**
 * POST /api/devices
 * Creates a new hardware device profile for the authenticated user.
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const {
      id,
      deviceName,
      deviceType,
      cpuModel,
      cpuCores,
      ramGb,
      gpuModel,
      vramGb,
      gpuType,
      storageType,
      storageFreeGb,
      isPortable,
    } = req.body;

    if (!deviceName || !deviceType) {
      return res.status(400).json({ error: 'deviceName and deviceType are required' });
    }

    const deviceId = id || randomUUID();
    const portableFlag = isPortable ? 1 : 0;
    const primaryFlag = req.body.isPrimary ? 1 : 0;

    db.prepare(`
      INSERT INTO "AppDevices" (
        id, userId, deviceName, deviceType, cpuModel, cpuCores, ramGb,
        gpuModel, vramGb, gpuType, storageType, storageFreeGb, isPortable, isPrimary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deviceId,
      userId,
      deviceName,
      deviceType,
      cpuModel ?? null,
      cpuCores ?? null,
      ramGb ?? null,
      gpuModel ?? null,
      vramGb ?? null,
      gpuType ?? null,
      storageType ?? null,
      storageFreeGb ?? null,
      portableFlag,
      primaryFlag
    );

    // At most one primary active device per user: promoting a new device to
    // primary clears any other primary flag for the same user. This mirrors the
    // "explicit primary device" contract on the My Devices surface.
    if (primaryFlag === 1) {
      db.prepare(
        'UPDATE "AppDevices" SET isPrimary = 0 WHERE userId = ? AND id <> ? AND isPrimary = 1'
      ).run(userId, deviceId);
    }

    const created = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(deviceId, userId) as any;

    return res.status(201).json({
      device: {
        ...created,
        isPortable: Boolean(created.isPortable),
        isPrimary: Boolean(created.isPrimary),
      },
    });
  } catch (err: any) {
    console.error('Error creating device:', err?.message || err);
    return sendApiError(res, 500, 'Failed to create device', undefined, { includeSuccess: false });
  }
});

/**
 * PATCH /api/devices/:id
 * Updates an existing hardware device profile for the authenticated user.
 */
router.patch('/:id', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(id, userId) as any;

    if (!existing) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const fields = [
      'deviceName',
      'deviceType',
      'cpuModel',
      'cpuCores',
      'ramGb',
      'gpuModel',
      'vramGb',
      'gpuType',
      'storageType',
      'storageFreeGb',
      'isPortable',
      'isPrimary',
    ];

    const updates: string[] = [];
    const params: any[] = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`"${field}" = ?`);
        if (field === 'isPortable' || field === 'isPrimary') {
          params.push(req.body[field] ? 1 : 0);
        } else {
          params.push(req.body[field]);
        }
      }
    }

    if (updates.length > 0) {
      updates.push('"updatedAt" = CURRENT_TIMESTAMP');
      params.push(id, userId);

      db.prepare(`
        UPDATE "AppDevices"
        SET ${updates.join(', ')}
        WHERE id = ? AND userId = ?
      `).run(...params);

      // Enforce the single-primary invariant on PATCH too.
      if (req.body.isPrimary === true) {
        db.prepare(
          'UPDATE "AppDevices" SET isPrimary = 0 WHERE userId = ? AND id <> ? AND isPrimary = 1'
        ).run(userId, id);
      }
    }

    const updated = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(id, userId) as any;

    return res.json({
      device: {
        ...updated,
        isPortable: Boolean(updated.isPortable),
        isPrimary: Boolean(updated.isPrimary),
      },
    });
  } catch (err: any) {
    console.error('Error updating device:', err?.message || err);
    return sendApiError(res, 500, 'Failed to update device', undefined, { includeSuccess: false });
  }
});

/**
 * PATCH /api/devices/:id/primary
 * Promotes a device to the single active/primary device for the user. Any other
 * primary device for the same user is cleared atomically in the same call.
 */
router.patch('/:id/primary', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(id, userId) as any;

    if (!existing) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const promote = db.transaction(() => {
      db.prepare(
        'UPDATE "AppDevices" SET isPrimary = 0 WHERE userId = ? AND isPrimary = 1'
      ).run(userId);
      db.prepare(
        'UPDATE "AppDevices" SET isPrimary = 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?'
      ).run(id, userId);
    });

    promote();

    const promoted = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(id, userId) as any;

    return res.json({
      success: true,
      device: {
        ...promoted,
        isPortable: Boolean(promoted.isPortable),
        isPrimary: Boolean(promoted.isPrimary),
      },
    });
  } catch (err: any) {
    console.error('Error promoting primary device:', err?.message || err);
    return sendApiError(res, 500, 'Failed to set primary device', undefined, { includeSuccess: false });
  }
});

/**
 * DELETE /api/devices/:id
 * Deletes a device profile for the authenticated user.
 */
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId || (req as any).user.id;
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM "AppDevices" WHERE id = ? AND userId = ?')
      .get(id, userId) as any;

    if (!existing) {
      return res.status(404).json({ error: 'Device not found' });
    }

    db.prepare('DELETE FROM "AppDevices" WHERE id = ? AND userId = ?').run(id, userId);

    return res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting device:', err?.message || err);
    return sendApiError(res, 500, 'Failed to delete device', undefined, { includeSuccess: false });
  }
});

export default router;
