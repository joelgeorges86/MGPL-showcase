import { Router } from 'express';
import axios from 'axios';
import { parseGiveawayRecord, parseDealFeed } from '../utils/dealSchema';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();

/**
 * GET /api/giveaways/active
 *
 * Live GamerPower giveaway feed. Sprint 1 (EPIC-DEAL-001): every record is
 * passed through strict schema validation so unwhitelisted/phishing/malformed
 * giveaway links are rejected before reaching the client.
 */
router.get('/active', async (_req, res) => {
  try {
    const response = await axios.get('https://www.gamerpower.com/api/giveaways?platform=pc');

    const giveaways = parseDealFeed(response.data, parseGiveawayRecord);

    res.json({
      success: true,
      count: giveaways.length,
      giveaways,
    });
  } catch (error) {
    console.error('GamerPower API error:', error);
    sendApiError(res, 500, 'Failed to fetch giveaways', undefined, { includeSuccess: false });
  }
});

export default router;