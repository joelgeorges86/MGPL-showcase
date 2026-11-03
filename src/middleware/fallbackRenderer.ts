import { Request, Response, NextFunction } from 'express';

/**
 * Sprint 6 (PI-GTM-2026-002) — Data Freshness & Cross-Module Fallback Rendering.
 *
 * 1. `dataAsOfHeader` is a global middleware that stamps every API response
 *    with `X-Data-As-Of` (the exact "Data as of [timestamp]" contract) and an
 *    `X-Data-Fresh` flag. The client surfaces this timestamp on dashboards
 *    (see public/admin.js) so operators always know how current module data is.
 *
 * 2. `renderModuleFallback` is the cross-module fallback rendering handler.
 *    When an external integration is rate-limited, stale, or partially
 *    hydrated, modules call it to serve a graceful, predictable `200` payload
 *    instead of a blank screen or a 5xx. Safe by construction: the body only
 *    carries static status values, the `dataAsOf` timestamp, and the module's
 *    own fallback payload — never raw error text, stack traces, or PII.
 *
 * Staleness semantics are inherited from src/services/integrationMonitor.ts
 * (deterministic, read-time derivation — no live cron dependency).
 */

export const DATA_AS_OF_HEADER = 'X-Data-As-Of';
export const DATA_FRESH_HEADER = 'X-Data-Fresh';

/** Default module completeness threshold before data is flagged stale (24h). */
export const DEFAULT_MODULE_STALE_MS = 24 * 60 * 60 * 1000;

/** Stamp every response with the "Data as of" header. Additive and non-blocking. */
export function dataAsOfHeader(_req: Request, res: Response, next: NextFunction): void {
  res.set(DATA_AS_OF_HEADER, new Date().toISOString());
  res.set(DATA_FRESH_HEADER, 'true');
  next();
}

export interface ModuleFallbackOptions {
  /** Stable module name (e.g. 'deals', 'mods', 'hltb'). Static only. */
  module: string;
  /** HTTP status for the fallback payload. Defaults to 200 (graceful fallback). */
  status?: number;
  /** Mark the payload as stale so the UI can raise a "refresh required" state. */
  stale?: boolean;
  /** The module's own predictable fallback payload. Never raw error text. */
  payload?: Record<string, unknown>;
}

/**
 * Serve a graceful cross-module fallback payload. Guarantees the standard
 * `{ success, module, usingFallback, stale, dataAsOf }` envelope so client
 * hydration code can render predictable UI states (Anti-Blank-Screen Rule).
 */
export function renderModuleFallback(
  res: Response,
  opts: ModuleFallbackOptions,
): Response {
  const { module, status = 200, stale = false, payload = {} } = opts;
  const dataAsOf = new Date().toISOString();
  const body = {
    success: true,
    module,
    usingFallback: true,
    stale,
    dataAsOf,
    ...payload,
  };
  res.set(DATA_AS_OF_HEADER, dataAsOf);
  res.set(DATA_FRESH_HEADER, stale ? 'false' : 'true');
  return res.status(status).json(body);
}
