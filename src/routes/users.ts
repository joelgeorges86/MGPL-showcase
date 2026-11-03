import express, { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { clearSessionCookie, hashPassword } from "../lib/auth";
import { sendApiError } from "../middleware/errorSanitizer";

const router = express.Router();

/**
 * AI-084 (#163): account administration is admin-only. Without a valid
 * session the caller gets 401; signed in without the `admin` role, 403. The
 * check runs before any validator and before any database access. Only
 * DELETE /api/users/me (self-service erasure) stays open to every signed-in
 * user.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if ((req as AuthedRequest).user?.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });
}

// Simple validators (no external deps)
const isValidEmail = (email: unknown): email is string => {
  return typeof email === "string" && /\S+@\S+\.\S+/.test(email);
};

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// Middlewares for validation
async function validateCreate(req: Request, res: Response, next: NextFunction) {
  const { email, password, name } = req.body as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };

  if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid or missing email" });
  if (!isNonEmptyString(password) || (password as string).length < 8)
    return res
      .status(400)
      .json({ error: "Password is required and must be at least 8 characters" });
  if (name !== undefined && typeof name !== "string")
    return res.status(400).json({ error: "Invalid name" });

  next();
}

async function validateUpdate(req: Request, res: Response, next: NextFunction) {
  const { email, password, name } = req.body as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };

  if (email !== undefined && !isValidEmail(email))
    return res.status(400).json({ error: "Invalid email" });
  if (password !== undefined && (!isNonEmptyString(password) || (password as string).length < 8))
    return res.status(400).json({ error: "Password must be at least 8 characters when provided" });
  if (name !== undefined && typeof name !== "string")
    return res.status(400).json({ error: "Invalid name" });

  next();
}

/**
 * Cuid-style id generator for the AuthUsers TEXT primary key.
 * Mirrors the same convention used by src/routes/auth.ts register.
 */
function cuuid(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Canonical column list for public reads (never selects passwordHash).
const USER_SELECT = "id, email, displayName, createdAt, updatedAt";
// Full row select used only to hydrate a freshly created/updated user before
// stripSensitive() removes the password hash from the wire.
const USER_SELECT_FULL = "id, email, passwordHash, displayName, createdAt, updatedAt";

// Helper to remove sensitive fields before sending (legacy route kept functional
// after the `User`/`AccountLink` model removal — these CRUD routes now operate on
// the canonical AuthUsers table and never leak the password hash).
const stripSensitive = (user: any) => {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
};

// GET /api/users - list users (AuthUsers-backed; legacy `name` maps to displayName)
router.get("/", requireAdmin, async (req, res) => {
  try {
    const users = db.prepare(`SELECT ${USER_SELECT} FROM AuthUsers`).all();
    res.json(users);
  } catch (error) {
    console.error("GET /api/users error:", error);
    sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

// GET /api/users/:id - get single user
router.get("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const user = db.prepare(`SELECT ${USER_SELECT} FROM AuthUsers WHERE id = ?`).get(id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    console.error(`GET /api/users/${id} error:`, error);
    sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

// POST /api/users - create user (argon2id password hash, no plaintext storage)
router.post("/", requireAdmin, validateCreate, async (req, res) => {
  const { email, password, name } = req.body as { email: string; password: string; name?: string };
  try {
    const existing = db.prepare("SELECT id FROM AuthUsers WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: "Email already in use" });

    const passwordHash = await hashPassword(password);
    const id = cuuid();
    db.prepare(
      `INSERT INTO AuthUsers (id, email, passwordHash, displayName, role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(id, email, passwordHash, name || null);

    const created = db.prepare(`SELECT ${USER_SELECT_FULL} FROM AuthUsers WHERE id = ?`).get(id);
    res.status(201).json(stripSensitive(created));
  } catch (error) {
    console.error("POST /api/users error:", error);
    sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

// PUT /api/users/:id - update user
router.put("/:id", requireAdmin, validateUpdate, async (req, res) => {
  const { id } = req.params;
  const { email, password, name } = req.body as {
    email?: string;
    password?: string;
    name?: string;
  };
  try {
    // Check existence
    const existing = db
      .prepare(`SELECT ${USER_SELECT_FULL} FROM AuthUsers WHERE id = ?`)
      .get(id) as any;
    if (!existing) return res.status(404).json({ error: "User not found" });

    // If updating email, ensure uniqueness
    if (email && email !== existing.email) {
      const byEmail = db.prepare("SELECT id FROM AuthUsers WHERE email = ?").get(email);
      if (byEmail) return res.status(409).json({ error: "Email already in use" });
    }

    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (email) {
      sets.push("email = ?");
      params.push(email);
    }
    if (password) {
      sets.push("passwordHash = ?");
      params.push(await hashPassword(password));
    }
    if (name) {
      sets.push("displayName = ?");
      params.push(name);
    }
    if (sets.length > 0) {
      sets.push("updatedAt = CURRENT_TIMESTAMP");
      db.prepare(`UPDATE AuthUsers SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    }

    const updated = db.prepare(`SELECT ${USER_SELECT_FULL} FROM AuthUsers WHERE id = ?`).get(id);
    res.json(stripSensitive(updated));
  } catch (error) {
    console.error(`PUT /api/users/${id} error:`, error);
    sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

/**
 * Sprint 2 (EPIC-COMPLIANCE-0001): Self-service account erasure (GDPR right to
 * be forgotten / CCPA deletion request).
 *
 * DELETE /api/users/me
 * Requires an authenticated session. Permanently deletes the authenticated
 * user's AuthUsers row; foreign-key CASCADE removes all user-scoped data
 * (AuthAccounts, AppPlatformHandles, AppFriendships, AppDevices, AppWishlist,
 * AppPriceAlerts, AppGameTags, AppGameNotes). Clears the session cookie so the
 * client immediately returns to an unauthenticated state.
 *
 * Route ordering matters: `/me` MUST be declared before `/:id` so Express does
 * not match "me" as a user id.
 */
router.delete("/me", requireAuth, (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const userId = authed.user!.userId;
    const row = db.prepare('SELECT id FROM "AuthUsers" WHERE id = ?').get(userId) as
      { id: string } | undefined;
    if (!row) {
      return res.status(404).json({ error: "User not found" });
    }
    // Raw SQL delete on the db connection (which boots with `foreign_keys = ON`
    // pragma in src/db.ts) guarantees SQLite FK CASCADE semantics remove every
    // user-scoped row: AuthAccounts, AppPlatformHandles, AppFriendships,
    // AppDevices, AppWishlist, AppPriceAlerts, AppGameTags, AppGameNotes.
    db.prepare('DELETE FROM "AuthUsers" WHERE id = ?').run(userId);
    clearSessionCookie(res);
    return res.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/users/me error:", error);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

// DELETE /api/users/:id
router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = db.prepare("SELECT id FROM AuthUsers WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "User not found" });

    db.prepare("DELETE FROM AuthUsers WHERE id = ?").run(id);
    res.status(204).send();
  } catch (error) {
    console.error(`DELETE /api/users/${id} error:`, error);
    sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

export default router;
