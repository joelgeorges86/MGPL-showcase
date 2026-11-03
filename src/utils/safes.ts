/**
 * Sprint 6.1 (PI-GTM-2026-001) — Shared Safety Utility Stack (server mirror).
 *
 * Total-function guard utilities used by routes, jobs, and scripts to hydrate
 * foreign/malformed payloads safely. Every function is non-throwing and always
 * returns a well-typed fallback so downstream code never needs scattered
 * defensive null-checks. The client mirror lives in public/safes.js — keep the
 * contracts in sync.
 *
 * Stack (MGPL Master Handbook v5.1): safeHydrate, safeArray, safeFetchJSON,
 * safeCSSVar, safeToastError, safeDeviceProfile.
 */

const FETCH_TIMEOUT_MS = 2500;
const FETCH_RETRIES = 1;

/** Return `obj` when it is a non-null, non-array object; otherwise `fallback`. */
export function safeHydrate<T extends Record<string, unknown>>(
  obj: unknown,
  fallback: T = {} as T,
): T {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    return obj as T;
  }
  return fallback;
}

/** Return `arr` when it is an array; otherwise an empty array. */
export function safeArray<T = unknown>(arr: unknown): T[] {
  return Array.isArray(arr) ? (arr as T[]) : [];
}

/**
 * Fetch + parse JSON with a 2.5s timeout and 1 retry. Any failure (timeout,
 * network, non-OK status, malformed JSON) resolves to `fallback` — never throws.
 */
export async function safeFetchJSON<T = unknown>(
  url: string,
  fallback: T | null = null,
): Promise<T | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      return (await res.json()) as T;
    } catch {
      clearTimeout(timer);
      // Timeout / network / JSON parse — retry once, then fall back.
    }
  }
  return fallback;
}

/**
 * Validate a raw CSS custom-property value. Strictly rejects `url(...)`
 * expressions, chained `var(--other)` values, and non-string types.
 */
export function sanitizeCSSVarValue(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const v = raw.trim();
  if (/url\s*\(/i.test(v)) return fallback;
  if (/var\s*\(--[^)]*\)/.test(v)) return fallback;
  return v;
}

/** Read a CSS custom property from <html> through the strict sanitizer. */
export function safeCSSVar(name: string, fallback = ''): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  let raw = '';
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  } catch {
    return fallback;
  }
  return sanitizeCSSVarValue(raw, fallback);
}

import { sanitizeErrorMessage } from './errorSanitizer';

/**
 * Convert an unknown error into a safe user-facing message. Strips stack
 * traces, internal filesystem paths, file:// URLs, and secret values.
 *
 * Sprint 1A (EPICSEC04): delegates to the shared server-side sanitizer
 * (src/utils/errorSanitizer.ts) so the safety stack, Express middleware, and
 * route error responses can never drift apart. The client mirror
 * (public/safes.js) implements the same contract for UI toasts.
 */
export function safeToastError(err: unknown, fallback = 'Something went wrong.'): string {
  return sanitizeErrorMessage(err, fallback);
}

export interface SafeDeviceProfile {
  gpu: string;
  cpu: string;
  vramGb: number;
  ramGb: number;
  batteryWh: number | null;
  tier: string;
}

/**
 * Normalize a device profile object into guaranteed fallback strings/numbers
 * for gpu, cpu, vram, ram, battery, and tier.
 */
export function safeDeviceProfile(device: unknown): SafeDeviceProfile {
  const d =
    device !== null && typeof device === 'object' ? (device as Record<string, any>) : {};
  const toStr = (v: unknown, fb: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : fb;
  const toNum = (v: unknown, fb: number): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v === null || v === undefined || v === '') return fb;
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    gpu: toStr(d.gpu ?? d.gpuModel, 'Unknown GPU'),
    cpu: toStr(d.cpu ?? d.cpuModel, 'Unknown CPU'),
    vramGb: toNum(d.vramGb ?? d.vram, 0),
    ramGb: toNum(d.ramGb ?? d.ram, 0),
    batteryWh: d.batteryWh === null || d.batteryWh === undefined ? null : toNum(d.batteryWh, 0),
    tier: toStr(d.tier ?? d.playabilityTier ?? d.fpsTier ?? d.targetFpsTier, 'Unknown'),
  };
}
