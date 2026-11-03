import { Router } from 'express';
import { db } from '../db';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    // Raw SQL equivalent of the previous Prisma appDLC.findMany:
    //   ownedStatus NOT contains 'owned'  →  "Owned Status" NOT LIKE '%owned%'
    // LEFT JOIN AppGames for the appGame.{gameID, gameTitle, primaryGenre} shape.
    const dlcAudit = db
      .prepare(
        `SELECT d."DLC_ID" AS dlcID, d."GameID" AS gameID, d."Game Title" AS gameTitle,
                d."DLC Availability Status" AS dlcAvailabilityStatus, d."DLC Type" AS dlcType,
                d."Owned Status" AS ownedStatus, d."Store DLC Search URL" AS storeDlcSearchUrl,
                g."GameID" AS appGame_gameID, g."Game Title" AS appGame_gameTitle,
                g."Primary Genre" AS appGame_primaryGenre
         FROM AppDLCs d
         LEFT JOIN AppGames g ON g."GameID" = d."GameID"
         WHERE d."Owned Status" NOT LIKE '%owned%'
         ORDER BY d."Game Title" COLLATE NOCASE ASC
         LIMIT 250`,
      )
      .all() as any[];

    // Rebuild the Prisma include shape: each record carries an `appGame` object
    // (or null) with the joined AppGames fields.
    const shaped = dlcAudit.map((record) => ({
      dlcID: record.dlcID,
      gameID: record.gameID,
      gameTitle: record.gameTitle,
      ownedStatus: record.ownedStatus,
      dlcAvailabilityStatus: record.dlcAvailabilityStatus,
      storeDlcSearchUrl: record.storeDlcSearchUrl,
      appGame: record.appGame_gameID
        ? {
            gameID: record.appGame_gameID,
            gameTitle: record.appGame_gameTitle,
            primaryGenre: record.appGame_primaryGenre,
          }
        : null,
    }));

    // Read the local dlc_details.json cache to merge missing DLC list, prices, and friction scores
    const cachePath = path.resolve(__dirname, '../../scripts/.cache/dlc_details.json');
    let dlcCache: Record<string, any> = {};
    try {
      if (fs.existsSync(cachePath)) {
        dlcCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    } catch (e) {
      console.error('Failed to read dlc_details.json cache inside dlcAudit route:', e);
    }

    const results = shaped.map((record: any) => {
      const gameID = record.gameID;
      const cached = (gameID ? dlcCache[gameID] : null) || {};
      return {
        gameId: record.gameID,
        title: record.appGame?.gameTitle ?? record.gameTitle,
        ownedStatus: record.ownedStatus,
        dlcAvailabilityStatus: record.dlcAvailabilityStatus,
        storeDlcSearchUrl: record.storeDlcSearchUrl,
        gameTitleFromRecord: record.gameTitle,
        missingDLCs: cached.dlc || [],
        totalMissingCost: cached.totalMissingCost ?? 0,
        frictionScore: cached.frictionScore ?? 0,
        frictionLevel: cached.frictionLevel ?? 'Low',
      };
    });

    res.json(results);
  } catch (error) {
    next(error);
  }
});

export default router;
