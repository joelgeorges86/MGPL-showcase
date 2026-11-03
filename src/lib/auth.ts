import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { Response } from "express";

/**
 * Sprint 1 (FEAT-AUTH-0001): Native auth core.
 *
 * Memory-hard password hashing via Argon2id and stateless HS256 JWTs for the
 * httpOnly session cookie. Secret falls back to a development-only test string
 * when JWT_SECRET is undefined (local dev); production MUST supply JWT_SECRET.
 */

export const SESSION_COOKIE = "mgpl_session";

export interface AuthTokenPayload {
  userId: string;
  email?: string;
  role: string;
}

/**
 * Sprint 1 (FEAT-AUTH-0001) / Sprint 3 (FEAT-OAUTH-0001): shared session
 * cookie contract. Both the native auth router and the OAuth/OpenID routers
 * must issue the identical `mgpl_session` cookie so every login path (email,
 * Google, Steam) is interchangeable: httpOnly, SameSite=Strict, Secure in
 * production, 7-day lifetime.
 */
export const SESSION_OPTS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// res.clearCookie must NOT receive maxAge — Express 5 deprecates it and will
// ignore it in favor of immediate expiration.
export const CLEAR_SESSION_OPTS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, SESSION_OPTS);
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, CLEAR_SESSION_OPTS);
}

type JwtEnvironment = {
  JWT_SECRET?: string;
  NODE_ENV?: string;
};

/**
 * Resolve the session-signing secret without allowing production to start
 * with the repository's deterministic development fallback.
 */
export function resolveJwtSecret(env: JwtEnvironment = process.env): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required when NODE_ENV=production.");
  }
  return "dev-only-insecure-secret-do-not-use-in-prod";
}

const JWT_SECRET: string = resolveJwtSecret();

const JWT_EXPIRES_IN = "7d";

/**
 * One-way memory-hard hash. Plaintext password storage is strictly forbidden.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verify a plaintext password against an Argon2id hash. Returns false (never
 * throws) on malformed hashes so callers can degrade to the generic
 * "Invalid email or password" error without leaking verification details.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Sign a stateless JWT session token containing the user identity.
 */
export function generateToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * Verify a JWT and return the decoded payload. Throws on invalid/expired
 * tokens; middleware catches and responds 401.
 */
export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as AuthTokenPayload;
}
