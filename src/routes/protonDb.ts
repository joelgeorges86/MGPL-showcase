import { Router, Request, Response } from 'express';
import {
  fetchProtonDbSummary,
  getCachedProtonDb,
} from '../services/adapters/protonDb';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();

/**
 * Sprint 2 (WUD-2.3 / EPIC-03) — ProtonDB Compatibility.
 *
 *   GET /api/protondb/:appId
 * Returns the cached-or-fresh ProtonDB community compatibility tier
 * (Platinum / Gold / Silver / Bronze / Borked) with a confidence-weighted
 * score, total reports, and a normalized 0-100 compatibility score. No
 * contributor identity is ever read or returned.
 */
router.get('/:appId', async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId || '').trim();
    if (!appId) {
      return res.status(400).json({ success: false, error: 'appId is required.' });
    }

    const cached = getCachedProtonDb(appId);
    if (cached) {
      return res.json({ success: true, summary: cached });
    }

    const summary = await fetchProtonDbSummary(appId);
    if (!summary) {
      return res.json({
        success: true,
        summary: null,
        message: 'No ProtonDB community reports are available for this AppID.',
      });
    }
    res.json({ success: true, summary });
  } catch (err: any) {
    console.error('Error in GET /api/protondb/:appId:', err?.message || err);
    sendApiError(res, 500, 'Failed to load ProtonDB compatibility');
  }
});

export default router;
