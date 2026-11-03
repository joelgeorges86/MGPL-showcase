import { Request, Response, NextFunction } from 'express';
import { SESSION_COOKIE, verifyToken, AuthTokenPayload } from '../lib/auth';
import { db } from '../db';

/**
 * Sprint 1 (FEAT-AUTH-0001): requireAuth middleware.
 *
 * Extracts the JWT from the httpOnly `mgpl_session` cookie first, with a
 * Bearer header fallback for programmatic clients. On success attaches the
 * decoded payload to `req.user`; otherwise responds 401 Unauthorized.
 */

export interface AuthedRequest extends Request {
  user?: AuthTokenPayload;
}

function extractToken(req: Request): string | undefined {
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : undefined;
  return cookieToken || bearerToken;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = verifyToken(token);
    (req as AuthedRequest).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * Sprint 2 (FEAT-MULTITENANT): Optional authentication for public routes that
 * need to narrow reads to the signed-in user (e.g. library smart binders).
 * A missing/invalid token no-ops (guest session) instead of returning 401; the
 * route must treat `req.user` as possibly undefined and return mock empty
 * state rather than global data.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = verifyToken(token);
      (req as AuthedRequest).user = payload;
    } catch {
      // Invalid token is treated as a guest session.
    }
  }
  next();
}

/**
 * Sprint 5 (EPIC-07): Roles authorized for the server-side Analytics gate.
 * Exactly these roles (plus the legacy `admin` superuser) may read
 * /api/analytics/*. Standard `user` / `staff` sessions receive 403.
 */
export const ANALYTICS_ROLES = ['admin', 'Product', 'Data', 'Leadership'] as const;

/** Append an immutable audit row for every denied analytics access attempt. */
function writeAnalyticsAccessAudit(
  req: Request,
  userId: string | null,
  role: string | null,
  reason: string,
): void {
  try {
    db.prepare(
      `INSERT INTO analytics_access_logs (userId, role, route, method, ip, outcome, reason)
       VALUES (?, ?, ?, ?, ?, 'denied', ?)`,
    ).run(
      userId,
      role,
      req.originalUrl || req.url || '',
      req.method || 'GET',
      req.ip || (req.socket && req.socket.remoteAddress) || null,
      reason,
    );
  } catch (e) {
    console.error('[auth] Failed to write analytics access audit log:', e);
  }
}

/**
 * Sprint 5 (EPIC-07): Strict server-side role gating.
 *
 * Chains on top of session auth (never client-side-only) and returns 401 when
 * the session is missing/invalid, or 403 when the authenticated role is not in
 * `allowedRoles`. Every denied attempt — missing session, invalid token, or
 * insufficient role — is appended to the immutable `analytics_access_logs`
 * table before responding.
 */
export function requireRole(...allowedRoles: string[]) {
  return function requireRoleMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const token = extractToken(req);

    if (!token) {
      writeAnalyticsAccessAudit(req, null, null, 'missing_token');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    let payload: AuthTokenPayload;
    try {
      payload = verifyToken(token);
    } catch {
      writeAnalyticsAccessAudit(req, null, null, 'invalid_token');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    (req as AuthedRequest).user = payload;
    const role = payload.role || 'user';

    if (!allowedRoles.includes(role)) {
      writeAnalyticsAccessAudit(req, payload.userId, role, `role_not_allowed:${role}`);
      res.status(403).json({ error: 'Forbidden: insufficient role for analytics access' });
      return;
    }

    next();
  };
}