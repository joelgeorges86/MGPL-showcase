/**
 * Sprint 2 (WUD-2.3 / EPICSEC05) — Strict Mod Metadata Schema Validation.
 *
 * Enforces strict schema contracts for the Mods ecosystem ingestion:
 *   download_count / active_installs / rating_count  -> non-negative integers
 *   version_tag                                       -> safe slug string
 *   author_handle                                     -> masked (external
 *                                                        profile handles are
 *                                                        NEVER exposed)
 *   description                                       -> script-injection-proof
 *
 * Every helper is pure and non-throwing so routes, jobs, and scripts can
 * validate/sanitize foreign payloads without scattered defensive checks.
 */

import { safeCoerce } from './ingest';

export const MOD_DESCRIPTION_MAX = 2000;
export const MOD_VERSION_TAG_MAX = 64;
export const MOD_HANDLE_MAX = 64;

/** Valid version-tag charset: alphanumeric + dot + underscore + hyphen. */
const VERSION_TAG_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export interface SanitizedModMetadata {
  downloadCount: number;
  activeInstalls: number;
  ratingCount: number;
  versionTag: string | null;
  /** Masked author handle — never the raw external profile handle. */
  authorHandle: string | null;
  /** Script-injection-proof plain text description (or null). */
  description: string | null;
}

function toNonNegInt(value: unknown, fallback: number): number {
  const n = safeCoerce.num(value, fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Strip script-injection vectors, HTML tags, event-handler attributes,
 * dangerous URI schemes, and control characters from a mod description.
 * Returns null for empty/whitespace-only input.
 */
export function sanitizeModDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw);
  // Remove every HTML/XML tag (script, iframe, style, img onerror, ...).
  s = s.replace(/<[^>]*>/g, ' ');
  // Strip inline event-handler attributes (onclick, onerror, ...).
  s = s.replace(/\son[a-z0-9_-]+\s*=/gi, ' ');
  // Neutralize dangerous URI schemes.
  s = s.replace(/javascript\s*:/gi, ' ').replace(/vbscript\s*:/gi, ' ').replace(/data\s*:/gi, ' ');
  // Remove control chars except newline/tab.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/[ \t]+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, MOD_DESCRIPTION_MAX);
}

/**
 * Mask an external author handle so raw profile handles never surface in the
 * mod list. First char + bullets + last char (same convention as platform
 * handles).
 */
export function maskModAuthorHandle(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^@/, '');
  if (!s) return null;
  if (s.length <= 2) return '••••';
  const bullets = Math.min(4, Math.max(2, s.length - 2));
  return `${s[0]}${'•'.repeat(bullets)}${s[s.length - 1]}`;
}

/** Validate a version tag against the strict charset; null when invalid. */
export function sanitizeVersionTag(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().slice(0, MOD_VERSION_TAG_MAX);
  return VERSION_TAG_RE.test(s) ? s : null;
}

/**
 * Validate + sanitize a mod metadata payload. Unknown/extraneous fields are
 * dropped; every field is coerced to a safe fallback. Never throws.
 */
export function validateModMetadata(input: unknown): SanitizedModMetadata {
  const obj = safeCoerce.obj(input ?? {});
  const read = (k: string): unknown => obj[k] ?? obj[snakeToCamel(k)];
  return {
    downloadCount: toNonNegInt(read('download_count'), 0),
    activeInstalls: toNonNegInt(read('active_installs'), 0),
    ratingCount: toNonNegInt(read('rating_count'), 0),
    versionTag: sanitizeVersionTag(read('version_tag')),
    authorHandle: maskModAuthorHandle(read('author_handle')),
    description: sanitizeModDescription(read('description')),
  };
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}
