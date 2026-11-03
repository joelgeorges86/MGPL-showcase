import { Router, Request, Response } from 'express';
import { db } from '../db';
import { hashPassword, verifyPassword, generateToken, setSessionCookie, clearSessionCookie } from '../lib/auth';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sendApiError } from '../middleware/errorSanitizer';

const router = Router();
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function isValidEmail(v: unknown): v is string {
  return typeof v === 'string' && EMAIL_RE.test(v);
}
function isValidPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 8;
}
function cuuid(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

interface PublicUser {
  id: string;
  email: string | null;
  role: string;
}
const toPublic = (u: { id: string; email: string | null; role: string }): PublicUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
});

// Session cookie helpers (SESSION_OPTS / CLEAR_SESSION_OPTS / setSessionCookie
// / clearSessionCookie) live in src/lib/auth.ts so the native auth router and
// the Sprint 3 OAuth/OpenID routers share ONE cookie contract: httpOnly,
// SameSite=Strict, Secure in production.

router.post('/register', async (req: Request, res: Response) => {
  const { email, password } = (req.body || {}) as { email?: unknown; password?: unknown };
  if (!isValidEmail(email) || !isValidPassword(password)) {
    return res.status(400).json({ error: 'Valid email and password (min 8 characters) are required' });
  }
  try {
    const existing = db.prepare('SELECT id FROM AuthUsers WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await hashPassword(password);
    const id = cuuid();
    db.prepare(
      "INSERT INTO AuthUsers (id, email, passwordHash, role, createdAt, updatedAt) VALUES (?, ?, ?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
    ).run(id, email, passwordHash);

    const user = db.prepare('SELECT id, email, role FROM AuthUsers WHERE id = ?').get(id) as PublicUser;
    setSessionCookie(res, generateToken({ userId: user.id, email: user.email ?? undefined, role: user.role }));
    return res.status(201).json({ user: toPublic(user) });
  } catch (error) {
    console.error('POST /api/auth/register error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = (req.body || {}) as { email?: unknown; password?: unknown };
  if (!isValidEmail(email) || typeof password !== 'string' || password.length === 0) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  try {
    const user = db
      .prepare('SELECT id, email, passwordHash, role FROM AuthUsers WHERE email = ?')
      .get(email) as { id: string; email: string | null; passwordHash: string | null; role: string } | undefined;
    if (!user?.passwordHash) return res.status(401).json({ error: 'Invalid email or password' });
    if (!(await verifyPassword(user.passwordHash, password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    setSessionCookie(res, generateToken({ userId: user.id, email: user.email ?? undefined, role: user.role }));
    return res.json({ user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error('POST /api/auth/login error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

router.post('/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  return res.json({ success: true });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const user = db.prepare('SELECT id, email, role FROM AuthUsers WHERE id = ?').get(authed.user!.userId) as PublicUser | undefined;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ user: toPublic(user) });
  } catch (error) {
    console.error('GET /api/auth/me error:', error);
    return sendApiError(res, 500, 'Internal Server Error', undefined, { includeSuccess: false });
  }
});

export default router;