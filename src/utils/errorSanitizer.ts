/**
 * Sprint 1A (EPICSEC04) — Backend Error Sanitization & Privacy Shield.
 *
 * Single source of truth for converting an unknown thrown value into a safe,
 * user-facing error message. The redaction rules mirror the client contract in
 * public/safes.js (safeToastError) so the server and UI stay in sync:
 *
 *   1. Stack frames ("  at fn (file:line)") are stripped before any other work.
 *   2. Sensitive key=value pairs (password, token, secret, apiKey, bearer,
 *      client_secret, ...) are replaced with [redacted].
 *   3. Internal filesystem / module paths (C:\..., file://...) are replaced
 *      with [path].
 *   4. Output is length-capped so pathological payloads can never blow up
 *      response bodies or toast containers.
 *
 * All helpers are pure (no I/O) and never throw.
 */

const SENSITIVE_KEY_PATTERN =
  /\b(password|passwd|secret|token|apikey|api_key|access_token|refresh_token|authorization|bearer|client_secret)\b\s*[:=]\s*["']?[^\s"',;]+/gi;
const PATH_PATTERN =
  /(?:[A-Za-z]:)?[\\/][\w\-. ()]+(?:[\\/][\w\-. ()]+)+\.(?:ts|js|tsx|jsx|html|json|db|log)(?::\d+)?\b/gi;
const FILE_URL_PATTERN = /file:\/\/[^\s]+/gi;
const MAX_ERROR_LENGTH = 240;

/**
 * Convert an unknown error into a sanitized, user-facing message. Never leaks
 * stack traces, internal filesystem paths, file:// URLs, or secret values.
 */
export function sanitizeErrorMessage(
  err: unknown,
  fallback = 'Something went wrong.',
): string {
  if (err === null || err === undefined) return fallback;

  let raw: string;
  if (typeof err === 'string') {
    raw = err;
  } else if (err instanceof Error) {
    raw = err.message || fallback;
  } else if (
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    raw = (err as { message: string }).message;
  } else {
    raw = String(err);
  }

  // Strip stack frames ("  at functionName (path:line:col)") before any other
  // normalization so internal call paths can never survive into the message.
  const lines = raw.split(/\r?\n/);
  const stackIdx = lines.findIndex((line) => /^\s*at\s/.test(line));
  if (stackIdx > 0) raw = lines.slice(0, stackIdx).join(' ');

  raw = raw.replace(/\s+/g, ' ').trim();
  raw = raw.replace(SENSITIVE_KEY_PATTERN, '[redacted]');
  raw = raw.replace(PATH_PATTERN, '[path]');
  raw = raw.replace(FILE_URL_PATTERN, '[path]');
  return raw.slice(0, MAX_ERROR_LENGTH).trim() || fallback;
}

/** Alias with a friendlier name for server middleware / route call sites. */
export function safeErrorMessage(
  err: unknown,
  fallback = 'Something went wrong.',
): string {
  return sanitizeErrorMessage(err, fallback);
}
