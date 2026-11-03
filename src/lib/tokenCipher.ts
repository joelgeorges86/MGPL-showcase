import crypto from 'crypto';

/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Local encrypted token vault.
 *
 * AES-256-GCM authenticated encryption for platform connection tokens. Tokens
 * must reside strictly in local SQLite WAL tables and never sync externally
 * (MGPL Master Handbook v5.1, privacy compliance). The encryption key is read
 * from `MGPL_TOKEN_ENC_KEY` (64 hex chars = 32 bytes, or 32-byte base64).
 *
 * Fail-closed contract: when the key is not configured, `encryptToken` throws
 * so a plaintext token can never be persisted by accident. The E2E suite sets
 * a deterministic test key so the profile-sync spec can prove the round-trip.
 */

const ENC_KEY_HEX_LENGTH = 64;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Resolve the 32-byte AES key from the environment, or null when unset/invalid. */
export function getTokenEncryptionKey(): Buffer | null {
  const raw = process.env.MGPL_TOKEN_ENC_KEY || '';
  if (!raw) return null;
  if (raw.length === ENC_KEY_HEX_LENGTH && /^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    // fall through to null
  }
  return null;
}

export interface EncryptedToken {
  /** base64-encoded ciphertext + 16-byte GCM auth tag. */
  tokenEnc: string;
  /** base64-encoded 12-byte random IV. */
  tokenIv: string;
}

/** True when an encryption key is configured (used for UI state hints). */
export function isTokenEncryptionConfigured(): boolean {
  return getTokenEncryptionKey() !== null;
}

/**
 * Encrypt a platform token at rest. Throws a descriptive error when
 * MGPL_TOKEN_ENC_KEY is missing so callers surface a graceful blocked state
 * instead of persisting a plaintext token.
 */
export function encryptToken(plaintext: string): EncryptedToken {
  const key = getTokenEncryptionKey();
  if (!key) {
    throw new Error(
      'MGPL_TOKEN_ENC_KEY is not configured; refusing to persist a plaintext token.',
    );
  }
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Cannot encrypt an empty token.');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    tokenEnc: Buffer.concat([enc, tag]).toString('base64'),
    tokenIv: iv.toString('base64'),
  };
}

/**
 * Decrypt a locally stored token. Throws on missing key, malformed ciphertext,
 * or authentication failure — callers must never surface the raw token.
 */
export function decryptToken(tokenEnc: string, tokenIv: string): string {
  const key = getTokenEncryptionKey();
  if (!key) {
    throw new Error('MGPL_TOKEN_ENC_KEY is not configured; cannot decrypt a stored token.');
  }
  const data = Buffer.from(tokenEnc, 'base64');
  const iv = Buffer.from(tokenIv, 'base64');
  if (data.length <= AUTH_TAG_BYTES || iv.length !== IV_BYTES) {
    throw new Error('Malformed encrypted token payload.');
  }
  const tag = data.subarray(data.length - AUTH_TAG_BYTES);
  const body = data.subarray(0, data.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
