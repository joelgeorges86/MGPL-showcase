import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 24 (FEAT-0156) — Player Notes.
 *
 * GET /api/notes/:gameId -> fetch the markdown note for a game (empty string when absent).
 * PUT /api/notes/:gameId -> upsert the markdown note for a game.
 *
 * Sprint 2 (FEAT-MULTITENANT): Notes are scoped to the authenticated user.
 * AppGameNotes has UNIQUE(userId, gameId), so every user keeps their own note
 * per game. Unauthenticated callers receive 401 from requireAuth.
 */

const router = Router();
router.use(requireAuth);

function sanitizeGameId(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 128);
}

function sanitizeNote(raw: unknown): string {
  return String(raw ?? '').slice(0, 20000);
}

/**
 * GET /api/notes/:gameId
 * Returns the authenticated user's note for the game (empty string when absent).
 */
router.get('/:gameId', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const gameId = sanitizeGameId(req.params.gameId);
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const row = db
      .prepare('SELECT noteMarkdown FROM AppGameNotes WHERE userId = ? AND gameId = ?')
      .get(userId, gameId) as { noteMarkdown?: string } | undefined;

    res.json({ success: true, noteMarkdown: row?.noteMarkdown || '' });
  } catch (err: any) {
    console.error('Error in GET /api/notes/:gameId:', err?.message || err);
    sendApiError(res, 500, 'Failed to load note');
  }
});

/**
 * PUT /api/notes/:gameId
 * Body: { noteMarkdown }
 * Upserts the authenticated user's markdown note for the game.
 */
router.put('/:gameId', (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const gameId = sanitizeGameId(req.params.gameId);
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const body = req.body || {};
    const noteMarkdown = sanitizeNote(body.noteMarkdown);
    const updatedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO AppGameNotes (userId, gameId, noteMarkdown, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(userId, gameId) DO UPDATE SET
         noteMarkdown = excluded.noteMarkdown,
         updatedAt = excluded.updatedAt`
    ).run(userId, gameId, noteMarkdown, updatedAt);

    res.json({ success: true, updatedAt });
  } catch (err: any) {
    console.error('Error in PUT /api/notes/:gameId:', err?.message || err);
    sendApiError(res, 500, 'Failed to save note');
  }
});

export default router;