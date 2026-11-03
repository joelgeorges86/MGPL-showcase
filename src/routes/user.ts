import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { hashPassword, verifyPassword } from '../lib/auth';
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 1 (EPIC-PROFILE-0001): Profile identity, password & privacy endpoints.
 *
 * Mounted under /api/user by src/index.ts. Every route requires an
 * authenticated session (requireAuth) and NEVER exposes the email address or
 * any other PII — the profile payload is strictly
 *   { id, displayName, gamerTag, avatarUrl, profileVisibility, hasPassword }.
 *
 * gamerTag accepts a single optional leading "@" followed by 3–20 alphanumeric
 * characters, underscores or hyphens (handle portion only). Uniqueness is
 * enforced case-insensitively and "@"-insensitively so "AlexCyber",
 * "alexcyber" and "@AlexCyber" all collide. The reserved handle "JordanDev"
 * is owned by the seeded jordan.dev user (test/global-setup.ts) and exercises
 * the 409 conflict path.
 */

const router = Router();

const GAMERTAG_RE = /^@?([a-zA-Z0-9_-]{3,20})$/;
const VALID_VISIBILITY = new Set(['public', 'private']);
const VALID_LIBRARY_VISIBILITY = new Set(['private', 'friends']);

export interface ProfileRow {
  id: string;
  email: string | null;
  passwordHash: string | null;
  displayName: string | null;
  gamerTag: string | null;
  avatarUrl: string | null;
  profileVisibility: string | null;
  libraryVisibility: string | null;
}

export interface PublicProfile {
  id: string;
  displayName: string | null;
  gamerTag: string | null;
  avatarUrl: string | null;
  profileVisibility: string;
  libraryVisibility: string;
  hasPassword: boolean;
}

const PROFILE_SELECT = `
  SELECT id, email, passwordHash, displayName, gamerTag, avatarUrl, profileVisibility, libraryVisibility
  FROM AuthUsers
  WHERE id = ?
`;

export function toPublicProfile(row: ProfileRow): PublicProfile {
  // Legacy rows (pre EPIC-PROFILE-0001) may carry a NULL profileVisibility;
  // converge to the privacy default instead of surfacing null.
  return {
    id: row.id,
    displayName: row.displayName ?? null,
    gamerTag: row.gamerTag ?? null,
    avatarUrl: row.avatarUrl ?? null,
    profileVisibility: row.profileVisibility === 'public' ? 'public' : 'private',
    libraryVisibility: row.libraryVisibility === 'friends' ? 'friends' : 'private',
    hasPassword: typeof row.passwordHash === 'string' && row.passwordHash.length > 0,
  };
}

function loadProfile(userId: string): ProfileRow | undefined {
  return db.prepare(PROFILE_SELECT).get(userId) as ProfileRow | undefined;
}

/**
 * Normalize a gamerTag for canonical storage and uniqueness comparison:
 * strips the single leading "@" (retaining the input's own casing). The test
 * contract returns the input value verbatim ("@AlexCyber" is stored as
 * "@AlexCyber"), while the uniqueness index + pre-check compare the
 * lowercased, "@"-stripped handle so "AlexCyber" / "@alexcyber" collide.
 */
function normalizeGamerTag(value: string): string {
  return value.replace(/^@/, '');
}

function isGamerTagValid(value: string): boolean {
  return GAMERTAG_RE.test(value);
}

function isDisplayNameValid(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60;
}

function isAvatarUrlValid(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 2048;
}

router.get('/profile', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.json({ profile: toPublicProfile(profile) });
  } catch (error) {
    console.error('GET /api/user/profile error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

router.patch('/profile', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const presentKeys = Object.keys(body);
    if (presentKeys.length === 0) {
      return res.status(400).json({ error: 'No profile fields provided' });
    }

    // 1. gamerTag: optional leading "@" + 3–20 [A-Za-z0-9_-], nullable.
    const gamerTagValue = body.gamerTag;
    let normalizedGamerTag: string | null = null;
    if (gamerTagValue !== undefined && gamerTagValue !== null) {
      if (typeof gamerTagValue !== 'string' || !isGamerTagValid(gamerTagValue)) {
        return res.status(400).json({
          error: 'gamerTag must be 3-20 alphanumeric characters, underscores or hyphens (optional leading @)',
        });
      }
      normalizedGamerTag = gamerTagValue; // stored verbatim (e.g. "@AlexCyber")
      const handle = normalizeGamerTag(gamerTagValue);

      // Allow re-submitting the current handle (no-op) but reject anyone
      // else's handle — case-insensitive + @-insensitive uniqueness.
      if (handle.toLowerCase() !== normalizeGamerTag(profile.gamerTag ?? '').toLowerCase()) {
        const taken = db
          .prepare(
            "SELECT id FROM AuthUsers WHERE lower(replace(gamerTag, '@', '')) = lower(replace(?, '@', '')) LIMIT 1"
          )
          .get(handle) as { id: string } | undefined;
        if (taken) {
          return res.status(409).json({ error: 'gamerTag is already taken' });
        }
      }
    }

    // 2. profileVisibility: strictly "public" | "private".
    if (body.profileVisibility !== undefined) {
      if (
        typeof body.profileVisibility !== 'string' ||
        !VALID_VISIBILITY.has(body.profileVisibility)
      ) {
        return res.status(400).json({ error: "profileVisibility must be 'public' or 'private'" });
      }
    }

    // 3. libraryVisibility: strictly "private" | "friends".
    if (body.libraryVisibility !== undefined) {
      if (
        typeof body.libraryVisibility !== 'string' ||
        !VALID_LIBRARY_VISIBILITY.has(body.libraryVisibility)
      ) {
        return res.status(400).json({ error: "libraryVisibility must be 'private' or 'friends'" });
      }
    }

    // 4. displayName: optional non-empty string, trimmed, max 60 chars.
    if (body.displayName !== undefined && body.displayName !== null) {
      if (!isDisplayNameValid(body.displayName)) {
        return res.status(400).json({ error: 'displayName must be a non-empty string (max 60 characters)' });
      }
    }

    // 5. avatarUrl: optional non-empty URL-ish string (max 2048 chars).
    if (body.avatarUrl !== undefined && body.avatarUrl !== null) {
      if (!isAvatarUrlValid(body.avatarUrl)) {
        return res.status(400).json({ error: 'avatarUrl must be a non-empty string (max 2048 characters)' });
      }
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];
    if (gamerTagValue !== undefined) {
      setClauses.push('gamerTag = ?');
      params.push(normalizedGamerTag);
    }
    if (body.profileVisibility !== undefined) {
      setClauses.push('profileVisibility = ?');
      params.push(body.profileVisibility);
    }
    if (body.libraryVisibility !== undefined) {
      setClauses.push('libraryVisibility = ?');
      params.push(body.libraryVisibility);
    }
    if (body.displayName !== undefined) {
      setClauses.push('displayName = ?');
      params.push(body.displayName === null ? null : (body.displayName as string).trim());
    }
    if (body.avatarUrl !== undefined) {
      setClauses.push('avatarUrl = ?');
      params.push(body.avatarUrl === null ? null : (body.avatarUrl as string).trim());
    }

    // Uniqueness pre-check passed, but a concurrent PATCH could still race the
    // partial unique index. Map the constraint violation to 409 (never 500).
    try {
      params.push(authed.user!.userId);
      db.prepare(`UPDATE AuthUsers SET ${setClauses.join(', ')}, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
    } catch (error: any) {
      if (String(error?.code || error?.message || '').includes('UNIQUE')) {
        return res.status(409).json({ error: 'gamerTag is already taken' });
      }
      throw error;
    }

    const updated = loadProfile(authed.user!.userId);
    return res.json({ profile: toPublicProfile(updated!) });
  } catch (error) {
    console.error('PATCH /api/user/profile error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * Sprint 2 (EPIC-PROFILE-0001): Connected account & platform handle storage.
 *
 * privacy-minimized contract:
 *   - GET  /api/user/accounts             -> { accounts: [{ provider, providerAccountId, linkedAt }] }
 *   - DELETE /api/user/accounts/:provider -> lockout-safe unlink (400 when the
 *     user has no local password AND no other linked provider remains).
 *   - PATCH /api/user/platform-handles    -> upsert optional storefront handles.
 *   - GET  /api/user/u/:gamerTag          -> privacy-minimized lookup (404 for
 *     unknown users or profiles that are not visible).
 *
 * Emails, real names, OAuth tokens and password hashes are NEVER selectable or
 * returned by any of these endpoints.
 */

const HANDLE_COLUMNS: Array<{ key: string; column: string }> = [
  { key: 'steamUsername', column: 'steamUsername' },
  { key: 'psnId', column: 'psnId' },
  { key: 'xboxGamertag', column: 'xboxGamertag' },
  { key: 'gogUsername', column: 'gogUsername' },
  { key: 'epicUsername', column: 'epicUsername' },
  { key: 'ubisoftUsername', column: 'ubisoftUsername' },
];

const HANDLE_KEYS = new Set(HANDLE_COLUMNS.map((h) => h.key));

/** Mask a public handle for display (keeps first + last char, bullets between). */
function maskPublicHandle(handle: string): string {
  const s = String(handle || '').trim();
  if (!s) return s;
  if (s.length <= 2) return '••••';
  const bullets = Math.min(4, Math.max(2, s.length - 2));
  return `${s[0]}${'•'.repeat(bullets)}${s[s.length - 1]}`;
}

function loadPlatformHandles(
  userId: string,
  opts?: { maskWhenHidden?: boolean },
): Record<string, string | null> {
  const row = db
    .prepare(
      `SELECT steamUsername, psnId, xboxGamertag, gogUsername, epicUsername, ubisoftUsername, hidePlatformIds
       FROM AppPlatformHandles WHERE userId = ?`
    )
    .get(userId) as
    | {
        steamUsername: string | null;
        psnId: string | null;
        xboxGamertag: string | null;
        gogUsername: string | null;
        epicUsername: string | null;
        ubisoftUsername: string | null;
        hidePlatformIds: number | null;
      }
    | undefined;
  const maskHidden = opts?.maskWhenHidden === true && row?.hidePlatformIds === 1;
  const apply = (v: string | null): string | null =>
    v && maskHidden ? maskPublicHandle(v) : v;
  if (!row) {
    return {
      steamUsername: null,
      psnId: null,
      xboxGamertag: null,
      gogUsername: null,
      epicUsername: null,
      ubisoftUsername: null,
    };
  }
  return {
    steamUsername: apply(row.steamUsername),
    psnId: apply(row.psnId),
    xboxGamertag: apply(row.xboxGamertag),
    gogUsername: apply(row.gogUsername),
    epicUsername: apply(row.epicUsername),
    ubisoftUsername: apply(row.ubisoftUsername),
  };
}

function countProviderLinks(userId: string, excludeProvider?: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM AuthAccounts WHERE userId = ? ${
        excludeProvider ? 'AND provider != ?' : ''
      }`
    )
    .get(userId, ...(excludeProvider ? [excludeProvider] : [])) as { c: number };
  return row.c;
}

function isValidHandleValue(value: unknown): boolean {
  // null clears a handle; a string must be a non-empty trimmed value (max 80).
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80;
}

router.get('/accounts', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rows = db
      .prepare('SELECT provider, providerAccountId, createdAt FROM AuthAccounts WHERE userId = ? ORDER BY createdAt ASC')
      .all(authed.user!.userId) as Array<{ provider: string; providerAccountId: string; createdAt: string }>;

    // Privacy-minimized: only provider identity metadata is exposed — never emails,
    // tokens, or anything from the AuthUsers row.
    const accounts = rows.map((r) => ({
      provider: r.provider,
      providerAccountId: r.providerAccountId,
      linkedAt: r.createdAt,
    }));
    return res.json({ accounts });
  } catch (error) {
    console.error('GET /api/user/accounts error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

router.delete('/accounts/:provider', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const provider = (req.params.provider || '').toLowerCase().trim();
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!provider || !/^[a-z0-9_-]{1,40}$/.test(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    const linked = db
      .prepare('SELECT id FROM AuthAccounts WHERE userId = ? AND provider = ?')
      .get(authed.user!.userId, provider) as { id: string } | undefined;
    if (!linked) {
      return res.status(404).json({ error: 'Provider account not linked' });
    }

    // Lockout prevention: an account with no local password may only unlink its
    // last provider if another sign-in path remains. If the ONLY linked provider
    // is being removed and there is no password hash, the user would be locked
    // out forever -> hard 400.
    const hasPassword = typeof profile.passwordHash === 'string' && profile.passwordHash.length > 0;
    const otherLinks = countProviderLinks(authed.user!.userId, provider);
    if (!hasPassword && otherLinks === 0) {
      return res.status(400).json({
        error: 'Cannot unlink the only sign-in provider. Add a password or link another provider first.',
      });
    }

    db.prepare('DELETE FROM AuthAccounts WHERE userId = ? AND provider = ?').run(
      authed.user!.userId,
      provider
    );
    return res.json({ success: true, unlinked: provider });
  } catch (error) {
    console.error('DELETE /api/user/accounts/:provider error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

router.patch('/platform-handles', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const presentKeys = Object.keys(body).filter((k) => HANDLE_KEYS.has(k));
    if (presentKeys.length === 0) {
      return res.status(400).json({
        error: 'No platform handles provided. Valid keys: steamUsername, psnId, xboxGamertag, gogUsername, epicUsername, ubisoftUsername',
      });
    }

    for (const key of presentKeys) {
      if (!isValidHandleValue(body[key])) {
        return res.status(400).json({
          error: `${key} must be a non-empty string (max 80 characters) or null`,
        });
      }
    }

    // Upsert: INSERT OR IGNORE creates the one-per-user row on first save, then
    // the UPDATE applies the requested subset of columns (never wiping handles
    // the client did not send).
    let handle: Record<string, string | null> | undefined;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO AppPlatformHandles (id, userId, steamUsername, psnId, xboxGamertag, gogUsername, epicUsername, ubisoftUsername, hidePlatformIds, createdAt, updatedAt)
         VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(cuidLike(), authed.user!.userId);

      const setClauses: string[] = [];
      const params: unknown[] = [];
      for (const col of HANDLE_COLUMNS) {
        if (body[col.key] !== undefined) {
          setClauses.push(`${col.column} = ?`);
          params.push(body[col.key] === null ? null : (body[col.key] as string).trim());
        }
      }
      setClauses.push('updatedAt = CURRENT_TIMESTAMP');
      params.push(authed.user!.userId);
      db.prepare(`UPDATE AppPlatformHandles SET ${setClauses.join(', ')} WHERE userId = ?`).run(...params);
      handle = loadPlatformHandles(authed.user!.userId);
    } catch (error) {
      console.error('PATCH /api/user/platform-handles upsert error:', error);
      throw error;
    }

    return res.json({ platformHandles: handle });
  } catch (error) {
    console.error('PATCH /api/user/platform-handles error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * GET /api/user/platform-handles
 * Returns the authenticated user's persisted storefront handles so the
 * Settings UI can rehydrate from the database (never from stale UI state).
 * Response shape: { platformHandles: { steamUsername, psnId, xboxGamertag, gogUsername } }
 * — all values are NULL when no row exists yet.
 */
router.get('/platform-handles', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.json({ platformHandles: loadPlatformHandles(authed.user!.userId) });
  } catch (error) {
    console.error('GET /api/user/platform-handles error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/**
 * Public privacy-minimized profile lookup. No auth required — this endpoint exists
 * precisely so anyone (including guests) can resolve a user's public gaming
 * identity.
 *
 * Responses are strictly limited to { displayName, gamerTag, avatarUrl,
 * platformHandles }. The endpoint returns 404 for unknown handles AND for
 * profiles whose profileVisibility is not "public" — the same status for both
 * prevents user enumeration.
 *
 * gamerTag lookup mirrors the profile upsert normalization: case-insensitive
 * and "@"-insensitive ("AlexCyber", "@alexcyber" all resolve).
 */
router.get('/u/:gamerTag', (req: Request, res: Response) => {
  const rawTag = (req.params.gamerTag || '').trim();
  try {
    if (!rawTag) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const profile = db
      .prepare(
        `SELECT u.id, u.displayName, u.gamerTag, u.avatarUrl, u.profileVisibility
         FROM AuthUsers u
         WHERE lower(replace(u.gamerTag, '@', '')) = lower(replace(?, '@', ''))
         LIMIT 1`
      )
      .get(normalizeGamerTag(rawTag)) as
      | {
          id: string;
          displayName: string | null;
          gamerTag: string | null;
          avatarUrl: string | null;
          profileVisibility: string | null;
        }
      | undefined;

    if (!profile || profile.profileVisibility !== 'public') {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.json({
      displayName: profile.displayName ?? null,
      gamerTag: profile.gamerTag ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      platformHandles: loadPlatformHandles(profile.id, { maskWhenHidden: true }),
    });
  } catch (error) {
    console.error('GET /api/user/u/:gamerTag error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

/** cuid-like id generator matching the OAuth/auth router convention. */
function cuidLike(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

router.post('/password', requireAuth, async (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const body = (req.body || {}) as { currentPassword?: unknown; newPassword?: unknown };
  try {
    const profile = loadProfile(authed.user!.userId);
    if (!profile) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // OAuth-only accounts have no local password hash — 400, never exposes why.
    if (!profile.passwordHash) {
      return res.status(400).json({ error: 'Password change is not available for this account' });
    }

    if (typeof body.currentPassword !== 'string' || body.currentPassword.length === 0) {
      return res.status(400).json({ error: 'currentPassword is required' });
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }

    // Verify the current password via Argon2id BEFORE hashing/saving the new
    // one. Verification failures use the generic 400 contract (no enumeration).
    const valid = await verifyPassword(profile.passwordHash, body.currentPassword);
    if (!valid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const newHash = await hashPassword(body.newPassword);
    db.prepare('UPDATE AuthUsers SET passwordHash = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run(
      newHash,
      authed.user!.userId
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('POST /api/user/password error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

export default router;