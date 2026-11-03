import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 24 (FEAT-0156) — Custom Tags & Dynamic Smart Collections.
 *
 * GET    /api/tags/summary      -> aggregated tag counts + color for smart binders.
 * GET    /api/tags/game/:gameId -> tag names for a single game.
 * POST   /api/tags              -> add a tag to a game (insert-or-ignore).
 * DELETE /api/tags              -> remove a tag from a game.
 *
 * Sprint 2 (FEAT-MULTITENANT): All tags are scoped to the authenticated user.
 * Every read/write filters by `userId` so no user can see or modify another
 * user's tags. Unauthenticated callers receive 401 from requireAuth.
 */

const router = Router();
router.use(requireAuth);

function sanitizeTagName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .slice(0, 64);
}

function sanitizeGameId(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 128);
}

function sanitizeColorHex(raw: unknown): string {
  const value = String(raw ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#38bdf8';
}

function getGameTags(userId: string, gameId: string): string[] {
  const rows = db
    .prepare('SELECT tagName FROM AppGameTags WHERE userId = ? AND gameId = ? ORDER BY tagName COLLATE NOCASE')
    .all(userId, gameId) as Array<{ tagName: string }>;
  return rows.map((r) => r.tagName);
}

/**
 * GET /api/tags/summary
 * Returns aggregated tag counts for the authenticated user's smart binder bar.
 */
router.get('/summary', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const rows = db
      .prepare(
        `SELECT tagName, COUNT(*) AS count, MAX(colorHex) AS colorHex
         FROM AppGameTags
         WHERE userId = ?
         GROUP BY tagName
         ORDER BY count DESC, tagName COLLATE NOCASE`
      )
      .all(userId) as Array<{ tagName: string; count: number; colorHex: string }>;

    const tags = rows.map((r) => ({
      tagName: r.tagName,
      count: Number(r.count) || 0,
      colorHex: r.colorHex || '#38bdf8',
    }));

    res.json({ success: true, tags });
  } catch (err: any) {
    console.error('Error in /api/tags/summary:', err?.message || err);
    sendApiError(res, 500, 'Failed to load tag summary');
  }
});

/**
 * GET /api/tags/game/:gameId
 * Returns the tag names applied to a single game by the authenticated user.
 */
router.get('/game/:gameId', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const gameId = sanitizeGameId(req.params.gameId);
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }
    res.json({ success: true, tags: getGameTags(userId, gameId) });
  } catch (err: any) {
    console.error('Error in /api/tags/game/:gameId:', err?.message || err);
    sendApiError(res, 500, 'Failed to load game tags');
  }
});

/**
 * POST /api/tags
 * Body: { gameId, tagName, colorHex? }
 * Inserts (or ignores duplicates) scoped to the authenticated user and returns
 * the updated tag list for the game.
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const body = req.body || {};
    const gameId = sanitizeGameId(body.gameId);
    const tagName = sanitizeTagName(body.tagName);
    const colorHex = sanitizeColorHex(body.colorHex);

    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }
    if (!tagName) {
      return res.status(400).json({ success: false, error: 'tagName is required' });
    }

    db.prepare(
      'INSERT OR IGNORE INTO AppGameTags (userId, gameId, tagName, colorHex) VALUES (?, ?, ?, ?)'
    ).run(userId, gameId, tagName, colorHex);

    res.json({ success: true, tags: getGameTags(userId, gameId) });
  } catch (err: any) {
    console.error('Error in POST /api/tags:', err?.message || err);
    sendApiError(res, 500, 'Failed to add tag');
  }
});

/**
 * DELETE /api/tags
 * Body: { gameId, tagName }
 * Removes the tag from the game, but only if it belongs to the authenticated
 * user (otherwise the delete is a harmless no-op and returns success=false).
 */
router.delete('/', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const body = req.body || {};
    const gameId = sanitizeGameId(body.gameId);
    const tagName = sanitizeTagName(body.tagName);

    if (!gameId || !tagName) {
      return res.status(400).json({ success: false, error: 'gameId and tagName are required' });
    }

    const result = db.prepare('DELETE FROM AppGameTags WHERE userId = ? AND gameId = ? AND tagName = ?').run(userId, gameId, tagName);

    res.json({ success: true, deleted: result.changes > 0 });
  } catch (err: any) {
    console.error('Error in DELETE /api/tags:', err?.message || err);
    sendApiError(res, 500, 'Failed to delete tag');
  }
});

export default router;