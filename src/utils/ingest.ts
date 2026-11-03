/**
 * Sprint 1A (EPICSEC01) — Unified Ingestion Validation & Fallback Helpers.
 *
 * Central non-throwing ingestion toolkit shared by every module adapter
 * (Mods, DPM, Compare, Retro Hub, Deals, Analytics). Re-exports the core
 * safeHydrate / safeArray / safeFetchJSON stack from utils/safes.ts and adds
 * field-level coercions (`safeCoerce`) plus a `validateIngest` record gate so
 * foreign/malformed payloads hydrate into well-typed fallbacks instead of
 * throwing or leaking nulls downstream.
 */

import { safeHydrate, safeArray, safeFetchJSON } from './safes';

export { safeHydrate, safeArray, safeFetchJSON };

export interface SafeCoercions {
  /** Non-empty-safe string; non-strings resolve to `fallback`. */
  str(value: unknown, fallback?: string): string;
  /** Finite number coercion; NaN/Infinity/empty resolve to `fallback`. */
  num(value: unknown, fallback?: number): number;
  /** Integer coercion; non-integers resolve to `fallback`. */
  int(value: unknown, fallback?: number): number;
  bool(value: unknown, fallback?: boolean): boolean;
  /** Array-only passthrough; anything else resolves to []. */
  arr<T = unknown>(value: unknown): T[];
  /** Non-null, non-array object passthrough; anything else resolves to {}. */
  obj(value: unknown): Record<string, unknown>;
  /** Optional string; empty/missing resolves to null. */
  nullableStr(value: unknown): string | null;
}

/** Non-throwing field-level coercion helpers for ingestion payloads. */
export const safeCoerce: SafeCoercions = {
  str(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  },
  num(value, fallback = 0) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  },
  int(value, fallback = 0) {
    const n = safeCoerce.num(value, fallback);
    return Number.isInteger(n) ? n : fallback;
  },
  bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  },
  arr<T = unknown>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  },
  obj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  },
  nullableStr(value) {
    const s = safeCoerce.str(value);
    return s === '' ? null : s;
  },
};

/** Hydrate a raw payload into a guaranteed object fallback. */
export function safeIngest<T extends Record<string, unknown>>(
  raw: unknown,
  fallback: T = {} as T,
): T {
  return safeHydrate<T>(raw, fallback);
}

export interface IngestValidationResult<T> {
  ok: boolean;
  value: T | null;
  error: string | null;
}

/**
 * Validate an ingestion record against a predicate. Malformed (non-object)
 * payloads fail closed with a structured result so adapters can reject without
 * throwing or guessing.
 */
export function validateIngest<T>(
  raw: unknown,
  validate: (body: Record<string, unknown>) => T | null,
): IngestValidationResult<T> {
  const body = safeCoerce.obj(raw);
  const value = validate(body);
  if (value === null) {
    return {
      ok: false,
      value: null,
      error: 'Malformed ingestion payload rejected.',
    };
  }
  return { ok: true, value, error: null };
}
