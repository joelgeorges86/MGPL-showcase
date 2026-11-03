import { Request, Response, NextFunction } from "express";
import { sanitizeErrorMessage } from "../utils/errorSanitizer";
import { captureSentryException } from "../observability/sentry";

/**
 * Sprint 1A (EPICSEC04) ΓÇö Standardized API Error Responses & Privacy Shield
 * Middleware.
 *
 * `sendApiError` is the single helper every route uses to emit an error. It
 * guarantees:
 *   - A stable, sanitized message (no stack traces / internal paths / secrets).
 *   - A standardized body shape: `{ success: false, error: string }` by
 *     default; pass `{ includeSuccess: false }` to preserve the legacy
 *     `{ error: string }` shape.
 *
 * `apiErrorHandler` is the terminal Express error middleware mounted last in
 * src/index.ts. It logs full diagnostic detail server-side only and responds
 * with a generic sanitized payload. 4xx errors (e.g. body-parser JSON syntax
 * errors) may surface a sanitized hint; 5xx always return the generic message.
 */

export interface SendApiErrorOptions {
  /** When false the response omits `success` (legacy `{ error }` shape). */
  includeSuccess?: boolean;
}

/** Emit a standardized, sanitized API error response. */
export function sendApiError(
  res: Response,
  status: number,
  fallbackMessage: string,
  err?: unknown,
  options: SendApiErrorOptions = {},
): Response {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const body: Record<string, unknown> = {
    error: sanitizeErrorMessage(err, fallbackMessage),
  };
  if (options.includeSuccess !== false) body.success = false;
  return res.status(code).json(body);
}

/** Derive a client-safe HTTP status from a thrown value (4xx/5xx only). */
function httpStatusOf(err: unknown): number {
  if (
    err !== null &&
    typeof err === "object" &&
    typeof (err as { status?: unknown }).status === "number" &&
    (err as { status: number }).status >= 400 &&
    (err as { status: number }).status < 600
  ) {
    return (err as { status: number }).status;
  }
  return 500;
}

/**
 * Terminal Express error handler. Full detail is logged server-side only;
 * clients receive a sanitized, standardized payload.
 */
export function apiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = httpStatusOf(err);

  // Full diagnostic detail is logged server-side only. Clients never see
  // stack traces, internal paths, environment variables, or pod names.
  console.error(`[api-error] status=${status}`, err);

  if (status >= 500) {
    // WUD-PI003-4: capture unexpected terminal 5xx exceptions exactly once,
    // through the isolated, privacy-minimized adapter. Expected 4xx errors
    // (validation, body-parser syntax errors, etc.) are never captured.
    // No-op when SENTRY_DSN is unset; never throws; never delays or alters
    // the sanitized client response below.
    captureSentryException(err);

    // Preserve the legacy `{ error }` shape used by the pre-Sprint-1A final
    // handler so existing client code and E2E assertions stay stable.
    sendApiError(res, status, "Internal Server Error", undefined, {
      includeSuccess: false,
    });
  } else {
    // 4xx (e.g. body-parser JSON syntax errors) can surface a sanitized hint
    // of what went wrong, but never raw stack/path/secret material.
    sendApiError(res, status, "Request could not be processed", err);
  }
}
