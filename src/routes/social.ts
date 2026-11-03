import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 3 (EPIC-PROFILE-0001): privacy-minimized friend suggestions & social connections.
 *
 * Mounted under /api/social by src/index.ts. Every route requires an
 * authenticated session (requireAuth).
 *
 * privacy-minimized contract: every social listing is strictly limited to
 *   { id, displayName, gamerTag, avatarUrl, platformHandles }.
 * Emails, real names beyond the public displayName, OAuth tokens and password
 * hashes are NEVER selected or returned.
 *
 * Privacy boundary: users with profileVisibility != 'public' NEVER appear in
 * suggestions. Friend requests are addressed to an exact public @gamerTag the
 * caller already knows; the handle lookup itself never leaks the target's
 * email or any other PII.
 *
 * Storage model: one canonical AppFriendships row per directed connection.
 * Accepted friendships are stored as a single row (userId -> friendId) and
 * surfaced bidirectionally by GET /friends. `status` values:
 *   suggested (ephemeral, not persisted) | pending | accepted | blocked.
 */

const router = Router();

const HANDLE_MAP: Array<{ key: string; column: string }> = [
  { key: 'steamUsername', column: 'steamUsername' },
  { key: 'psnId', column: 'psnId' },
  { key: 'xboxGamertag', column: 'xboxGamertag' },
  { key: 'gogUsername', column: 'gogUsername' },
];

interface ProfileRow {
  id: string;
  displayName: string | null;
  gamerTag: string | null;
  avatarUrl: string | null;
  profileVisibility: string | null;
}

interface FriendshipRow {
  id: string;
  userId: string;
  friendId: string;
  status: string;
  source: string;
  createdAt: string;
}

/** cuuid-like id generator matching the auth/user router convention. */
function cuidLike(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize a gamerTag for lookup: strip a single leading "@". */
function normalizeGamerTag(value: string): string {
  return value.replace(/^@/, '');
}

/** Load a AuthUsers row (privacy-minimized columns only) by id. */
function loadProfile(userId: string): ProfileRow | undefined {
  return db
    .prepare(
      'SELECT id, displayName, gamerTag, avatarUrl, profileVisibility FROM AuthUsers WHERE id = ?'
    )
    .get(userId) as ProfileRow | undefined;
}

/** Load public platform handles for a user (all nulls when no row exists). */
function loadPlatformHandles(userId: string): Record<string, string | null> {
  const row = db
    .prepare(
      'SELECT steamUsername, psnId, xboxGamertag, gogUsername FROM AppPlatformHandles WHERE userId = ?'
    )
    .get(userId) as
    | { steamUsername: string | null; psnId: string | null; xboxGamertag: string | null; gogUsername: string | null }
    | undefined;
  if (!row) {
    return { steamUsername: null, psnId: null, xboxGamertag: null, gogUsername: null };
  }
  return {
    steamUsername: row.steamUsername ?? null,
    psnId: row.psnId ?? null,
    xboxGamertag: row.xboxGamertag ?? null,
    gogUsername: row.gogUsername ?? null,
  };
}

/** privacy-minimized social card. `platformHandles` is a flat public handle map. */
function toSocialCard(profile: ProfileRow): {
  id: string;
  displayName: string | null;
  gamerTag: string | null;
  avatarUrl: string | null;
  platformHandles: Record<string, string | null>;
} {
  return {
    id: profile.id,
    displayName: profile.displayName ?? null,
    gamerTag: profile.gamerTag ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    platformHandles: loadPlatformHandles(profile.id),
  };
}

/**
 * GET /api/social/friends
 * Returns accepted friends (bidirectional) with the privacy-minimized public card.
 */
router.get('/friends', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const me = authed.user!.userId;
  try {
    const rows = db
      .prepare(
        `SELECT id, userId, friendId, status, source, createdAt
         FROM AppFriendships
         WHERE status = 'accepted' AND (userId = ? OR friendId = ?)
         ORDER BY createdAt ASC`
      )
      .all(me, me) as FriendshipRow[];

    const friends: Array<ReturnType<typeof toSocialCard>> = [];
    for (const row of rows) {
      const otherId = row.userId === me ? row.friendId : row.userId;
      const profile = loadProfile(otherId);
      if (!profile) continue;
      friends.push(toSocialCard(profile));
    }
    return res.json({ friends });
  } catch (error) {
    console.error('GET /api/social/friends error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * GET /api/social/suggestions
 * Public-profile users sharing a linked platform identity (AuthAccounts) or a
 * non-null public platform handle with the caller. Never includes the caller
 * or anyone already connected (any status). privacy-minimized cards only.
 */
router.get('/suggestions', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const me = authed.user!.userId;
  try {
    // Exclude self + every existing connection (any status) on either side.
    const connected: string[] = [];
    const rows = db
      .prepare(
        `SELECT userId, friendId FROM AppFriendships WHERE userId = ? OR friendId = ?`
      )
      .all(me, me) as Array<{ userId: string; friendId: string }>;
    for (const r of rows) {
      if (r.userId !== me) connected.push(r.userId);
      if (r.friendId !== me) connected.push(r.friendId);
    }
    const excluded = new Set<string>([me, ...connected]);

    // 1. Shared linked OAuth identities (provider + providerAccountId match).
    const accountMatches = db
      .prepare(
        `SELECT DISTINCT b.userId AS candidateId
         FROM AuthAccounts a
         JOIN AuthAccounts b
           ON b.provider = a.provider
          AND b.providerAccountId = a.providerAccountId
          AND b.userId != a.userId
         WHERE a.userId = ?`
      )
      .all(me) as Array<{ candidateId: string }>;

    // 2. Shared public platform handle (any of the four columns, non-null).
    const handleRows = db
      .prepare(
        `SELECT steamUsername, psnId, xboxGamertag, gogUsername FROM AppPlatformHandles WHERE userId = ?`
      )
      .get(me) as { steamUsername: string | null; psnId: string | null; xboxGamertag: string | null; gogUsername: string | null } | undefined;

    const handleMatches = new Set<string>();
    if (handleRows) {
      for (const { column } of HANDLE_MAP) {
        const value = (handleRows as any)[column];
        if (!value) continue;
        const matched = db
          .prepare(
            `SELECT userId FROM AppPlatformHandles WHERE ${column} = ? AND userId != ?`
          )
          .all(value, me) as Array<{ userId: string }>;
        for (const m of matched) handleMatches.add(m.userId);
      }
    }

    const candidateIds = new Set<string>([
      ...accountMatches.map((r) => r.candidateId),
      ...handleMatches,
    ]);

    const suggestions: Array<ReturnType<typeof toSocialCard>> = [];
    for (const candidateId of candidateIds) {
      if (excluded.has(candidateId)) continue;
      const profile = loadProfile(candidateId);
      // Privacy boundary: private profiles never appear in suggestions.
      if (!profile || profile.profileVisibility !== 'public') continue;
      suggestions.push(toSocialCard(profile));
    }

    return res.json({ suggestions });
  } catch (error) {
    console.error('GET /api/social/suggestions error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * POST /api/social/request
 * Body: { gamerTag: string } — sends a pending friend request to the target.
 *
 * Resolution is case-insensitive and "@"-insensitive (matches the profile
 * lookup contract in src/routes/user.ts). Idempotency:
 *   - Already friends (either direction)      -> 409
 *   - Same outgoing pending already exists    -> 200 { id } (no duplicate)
 *   - Reverse pending exists (B already asked A) -> auto-accept B's request
 */
router.post('/request', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const me = authed.user!.userId;
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    if (typeof body.gamerTag !== 'string' || body.gamerTag.trim().length === 0) {
      return res.status(400).json({ error: 'gamerTag is required' });
    }

    const target = db
      .prepare(
        `SELECT id FROM AuthUsers
         WHERE lower(replace(gamerTag, '@', '')) = lower(replace(?, '@', ''))
         LIMIT 1`
      )
      .get(normalizeGamerTag(body.gamerTag.trim())) as { id: string } | undefined;

    if (!target) {
      return res.status(404).json({ error: 'gamerTag not found' });
    }
    if (target.id === me) {
      return res.status(400).json({ error: 'You cannot friend yourself' });
    }

    // Existing connection — check both directions.
    const existing = db
      .prepare(
        `SELECT id, userId, friendId, status FROM AppFriendships
         WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)
         LIMIT 1`
      )
      .get(me, target.id, target.id, me) as
      | { id: string; userId: string; friendId: string; status: string }
      | undefined;

    if (existing) {
      if (existing.status === 'accepted' || existing.status === 'blocked') {
        return res.status(409).json({ error: 'Cannot request: connection already exists' });
      }
      // Same-direction pending: idempotent success.
      if (existing.userId === me && existing.status === 'pending') {
        return res.json({ id: existing.id, status: 'pending', source: 'manual' });
      }
      // Reverse pending (target already asked me): auto-accept their request.
      db.prepare(
        `UPDATE AppFriendships SET status = 'accepted', updatedAt = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(existing.id);
      return res.json({ id: existing.id, status: 'accepted', source: 'manual' });
    }

    const id = cuidLike();
    db.prepare(
      `INSERT INTO AppFriendships (id, userId, friendId, status, source, createdAt, updatedAt)
       VALUES (?, ?, ?, 'pending', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, me, target.id);
    return res.status(201).json({ id, status: 'pending', source: 'manual' });
  } catch (error) {
    console.error('POST /api/social/request error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * GET /api/social/requests
 * Lists incoming pending requests (friendId = me) with the sender's privacy-minimized
 * card plus the request id the recipient needs to accept/reject.
 */
router.get('/requests', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const me = authed.user!.userId;
  try {
    const rows = db
      .prepare(
        `SELECT id, userId, friendId, status, source, createdAt
         FROM AppFriendships
         WHERE friendId = ? AND status = 'pending'
         ORDER BY createdAt ASC`
      )
      .all(me) as FriendshipRow[];

    const requests = rows
      .map((row) => {
        const profile = loadProfile(row.userId);
        if (!profile) return null;
        return {
          id: row.id,
          status: row.status,
          source: row.source,
          createdAt: row.createdAt,
          from: toSocialCard(profile),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return res.json({ requests });
  } catch (error) {
    console.error('GET /api/social/requests error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * PATCH /api/social/request/:id
 * Body: { action: 'accept' | 'reject' }
 * Only the request recipient (friendId = me, status = pending) may act.
 * Accept -> status 'accepted'; Reject -> row deleted (no tombstone).
 */
router.patch('/request/:id', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const me = authed.user!.userId;
  const requestId = (req.params.id || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    if (!requestId) {
      return res.status(400).json({ error: 'Request id is required' });
    }
    if (body.action !== 'accept' && body.action !== 'reject') {
      return res.status(400).json({ error: "action must be 'accept' or 'reject'" });
    }

    const row = db
      .prepare(
        `SELECT id, userId, friendId, status FROM AppFriendships WHERE id = ?`
      )
      .get(requestId) as
      | { id: string; userId: string; friendId: string; status: string }
      | undefined;

    if (!row || row.friendId !== me || row.status !== 'pending') {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (body.action === 'accept') {
      db.prepare(
        `UPDATE AppFriendships SET status = 'accepted', updatedAt = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(requestId);
      return res.json({ success: true, status: 'accepted' });
    }

    db.prepare(`DELETE FROM AppFriendships WHERE id = ?`).run(requestId);
    return res.json({ success: true, status: 'rejected' });
  } catch (error) {
    console.error('PATCH /api/social/request/:id error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * DELETE /api/social/friends/:id
 * Removes an accepted friendship where :id is the OTHER user's profile id.
 * Deletes the single canonical row in either direction.
 */
router.delete('/friends/:id', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const me = authed.user!.userId;
  const friendId = (req.params.id || '').trim();
  try {
    const row = db
      .prepare(
        `SELECT id FROM AppFriendships
         WHERE status = 'accepted' AND ((userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?))
         LIMIT 1`
      )
      .get(me, friendId, friendId, me) as { id: string } | undefined;

    if (!row) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    db.prepare(`DELETE FROM AppFriendships WHERE id = ?`).run(row.id);
    return res.json({ success: true, removedFriendId: friendId });
  } catch (error) {
    console.error('DELETE /api/social/friends/:id error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

export default router;