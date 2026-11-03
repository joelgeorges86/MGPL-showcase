import { Router } from 'express';
import { db } from '../db';

const router = Router();

// Canonical AppTracking column aliases (mirror the Prisma model field names the
// API contract exposed, so the client-facing response shape is unchanged).
const TRACKING_SELECT = `
  "GameID" AS gameID,
  "Play Status" AS playStatus,
  "Want to Play?" AS wantToPlay,
  "Personal Rating (1-10)" AS personalRating,
  "Hours Played" AS hoursPlayed,
  "Last Played Date" AS lastPlayedDate,
  "Played Platform" AS playedPlatform,
  "Played Hardware Device" AS playedHardwareDevice,
  "Completed Date" AS completedDate,
  "Replay Interest" AS replayInterest,
  "DLC Status" AS dlcStatus,
  "Personal Review" AS personalReview,
  "Notes" AS notes,
  "Trophy Progress" AS "Trophy_Progress"
`;

router.post('/session', async (req, res, next) => {
  try {
    const {
      gameId,
      hoursPlayed,
      playedPlatform,
      playedHardwareDevice,
      lastPlayedDate,
      completedDate,
      personalRating,
      personalReview,
      replayInterest,
    } = req.body as {
      gameId?: string;
      hoursPlayed?: number;
      playedPlatform?: string;
      playedHardwareDevice?: string;
      lastPlayedDate?: string;
      completedDate?: string;
      personalRating?: number;
      personalReview?: string;
      replayInterest?: string;
    };

    if (!gameId || typeof gameId !== 'string') {
      return res.status(400).json({ error: 'gameId is required' });
    }

    if (typeof hoursPlayed !== 'number' || Number.isNaN(hoursPlayed) || hoursPlayed <= 0) {
      return res.status(400).json({ error: 'hoursPlayed must be a positive number' });
    }

    const game = db.prepare('SELECT "GameID" AS gameID FROM AppGames WHERE "GameID" = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const parseDate = (value: string | undefined): string | null => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : value;
    };

    const existing = db
      .prepare(`SELECT ${TRACKING_SELECT} FROM AppTracking WHERE "GameID" = ?`)
      .get(gameId) as any;

    const lastPlayed = parseDate(lastPlayedDate);
    const completed = parseDate(completedDate);
    if (lastPlayedDate && !lastPlayed) {
      return res.status(400).json({ error: 'lastPlayedDate must be a valid ISO date string' });
    }
    if (completedDate && !completed) {
      return res.status(400).json({ error: 'completedDate must be a valid ISO date string' });
    }

    if (personalRating !== undefined && (typeof personalRating !== 'number' || personalRating < 1 || personalRating > 10)) {
      return res.status(400).json({ error: 'personalRating must be a number between 1 and 10' });
    }

    const sessionData: any = {
      hoursPlayed: existing ? (existing.hoursPlayed ?? 0) + hoursPlayed : hoursPlayed,
      playedPlatform: playedPlatform ?? existing?.playedPlatform ?? null,
      playedHardwareDevice: playedHardwareDevice ?? existing?.playedHardwareDevice ?? null,
      lastPlayedDate: lastPlayed ?? existing?.lastPlayedDate ?? null,
      completedDate: completed ?? existing?.completedDate ?? null,
      personalRating: personalRating ?? existing?.personalRating ?? null,
      personalReview: personalReview ?? existing?.personalReview ?? null,
      replayInterest: replayInterest ?? existing?.replayInterest ?? null,
    };

    if (existing) {
      db.prepare(
        `UPDATE AppTracking SET
           "Hours Played" = ?,
           "Played Platform" = ?,
           "Played Hardware Device" = ?,
           "Last Played Date" = ?,
           "Completed Date" = ?,
           "Personal Rating (1-10)" = ?,
           "Personal Review" = ?,
           "Replay Interest" = ?
         WHERE "GameID" = ?`,
      ).run(
        sessionData.hoursPlayed,
        sessionData.playedPlatform,
        sessionData.playedHardwareDevice,
        sessionData.lastPlayedDate,
        sessionData.completedDate,
        sessionData.personalRating,
        sessionData.personalReview,
        sessionData.replayInterest,
        gameId,
      );
    } else {
      db.prepare(
        `INSERT INTO AppTracking (
           "GameID", "Hours Played", "Played Platform", "Played Hardware Device",
           "Last Played Date", "Completed Date", "Personal Rating (1-10)",
           "Personal Review", "Replay Interest"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        gameId,
        sessionData.hoursPlayed,
        sessionData.playedPlatform,
        sessionData.playedHardwareDevice,
        sessionData.lastPlayedDate,
        sessionData.completedDate,
        sessionData.personalRating,
        sessionData.personalReview,
        sessionData.replayInterest,
      );
    }

    const tracking = db
      .prepare(`SELECT ${TRACKING_SELECT} FROM AppTracking WHERE "GameID" = ?`)
      .get(gameId);

    res.status(200).json({ tracking });
  } catch (error) {
    next(error);
  }
});

router.get('/last-played', async (_req, res, next) => {
  try {
    const record = db
      .prepare(`SELECT ${TRACKING_SELECT} FROM AppTracking WHERE "Last Played Date" IS NOT NULL ORDER BY "Last Played Date" DESC LIMIT 1`)
      .get() as any;

    if (record) {
      const game = loadGameWithOwnerships(record.gameID);
      if (game) {
        return res.json({
          success: true,
          game: {
            gameID: game.gameID,
            gameTitle: game.gameTitle,
            cover_url: game.cover_url,
            primaryGenre: game.primaryGenre,
            nexusModsUrl: game.nexusModsUrl,
            hoursPlayed: record.hoursPlayed ?? 0,
            lastPlayedDate: record.lastPlayedDate,
            playStatus: record.playStatus,
            playedPlatform: record.playedPlatform,
            ownerships: game.ownerships,
          },
        });
      }
    }

    // Fallback if no lastPlayedDate tracked yet: return first game found or null
    const firstGame = loadGameWithOwnerships(null);
    if (firstGame) {
      return res.json({
        success: true,
        game: {
          gameID: firstGame.gameID,
          gameTitle: firstGame.gameTitle,
          cover_url: firstGame.cover_url,
          primaryGenre: firstGame.primaryGenre,
          nexusModsUrl: firstGame.nexusModsUrl,
          hoursPlayed: 0,
          lastPlayedDate: null,
          playStatus: 'Not Started',
          playedPlatform: null,
          ownerships: firstGame.ownerships,
        },
      });
    }

    return res.json({ success: true, game: null });
  } catch (error) {
    next(error);
  }
});

/** Load a game row plus its ownership rows (with the Prisma camelCase shape). */
function loadGameWithOwnerships(gameID: string | null): any | null {
  const game = gameID
    ? db
        .prepare(
          `SELECT "GameID" AS gameID, "Game Title" AS gameTitle, "cover_url" AS cover_url,
                  "Primary Genre" AS primaryGenre, "Nexus Mods URL" AS nexusModsUrl
           FROM AppGames WHERE "GameID" = ?`,
        )
        .get(gameID)
    : db
        .prepare(
          `SELECT "GameID" AS gameID, "Game Title" AS gameTitle, "cover_url" AS cover_url,
                  "Primary Genre" AS primaryGenre, "Nexus Mods URL" AS nexusModsUrl
           FROM AppGames LIMIT 1`,
        )
        .get();

  if (!game) return null;

  const ownerships = db
    .prepare(
      `SELECT "OwnershipID" AS ownershipID, "GameID" AS gameID, "Platform" AS platform,
              "Store URL" AS storeUrl, "Edition" AS edition, "Format" AS format,
              "Ownership Access Type" AS accessType, "Purchase Date" AS purchaseDate,
              "Price Paid" AS pricePaid, "Currency" AS currency, "platformCanonical" AS platformCanonical
       FROM AppOwnership WHERE "GameID" = ?`,
    )
    .all((game as any).gameID);

  return { ...game, ownerships };
}

export default router;
