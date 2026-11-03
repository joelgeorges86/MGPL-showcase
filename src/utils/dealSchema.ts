/**
 * Sprint 1 (EPIC-DEAL-001) — Ingestion Response Schema & Anti-Tampering
 * Validation.
 *
 * Strict, pure-JSON validation for every external deal and giveaway record.
 * Any record that fails validation is rejected (returned as null) so malformed
 * payloads, unwhitelisted store identifiers, out-of-bounds prices, and
 * grey-market URLs never reach SQLite or the frontend. Unknown / extraneous
 * payload properties are stripped by only copying an explicit allowlist.
 */

import {
  isWhitelistedStoreName,
  isWhitelistedUrl,
  isGreyMarketUrl,
} from './storefrontValidator';

export const MIN_PRICE = 0;
export const MAX_PRICE = 999.99;

export interface SanitizedDeal {
  id: string;
  title: string;
  store: string;
  currentPrice: number;
  regularPrice: number;
  discountCut: number;
  storeUrl: string;
  boxart?: string;
  type: string;
  gameID?: string;
  dealID?: string;
  steamAppID?: string;
}

export interface SanitizedGiveaway {
  id: string;
  title: string;
  store: string;
  currentPrice: number;
  regularPrice: number;
  discountCut: number;
  storeUrl: string;
  boxart?: string;
  type: string;
  worth?: string | null;
  giveawayType?: string | null;
  status?: string | null;
  endDate?: string | null;
  description?: string | null;
  storeBadge?: string | null;
}

/** Coerce a numeric value into a finite number or null when not usable. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Price must be finite and within [MIN_PRICE, MAX_PRICE]. */
export function sanitizePrice(value: unknown): number | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  if (n < MIN_PRICE || n > MAX_PRICE) return null;
  // Round to cents to avoid float noise and enforce a stable DB value.
  return Math.round(n * 100) / 100;
}

/** Discount percentage must be finite and within [0, 100]. */
export function sanitizeDiscount(value: unknown): number | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n);
}

/** A required non-empty string. */
function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 ? s : null;
}

/** An optional string; returns null for empty/missing values. */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 ? s : null;
}

/**
 * Validate a single deal record. Returns a stripped, sanitized deal or null when
 * the record must be rejected (missing required fields, bad price/discount,
 * unwhitelisted store, or a non-whitelisted/grey-market URL).
 */
export function parseDealRecord(input: any): SanitizedDeal | null {
  if (!input || typeof input !== 'object') return null;

  const title = requiredString(input.title);
  if (!title) return null;

  const store = requiredString(input.store);
  if (!store) return null;
  if (!isWhitelistedStoreName(store)) return null;

  const currentPrice = sanitizePrice(input.currentPrice);
  if (currentPrice === null) return null;

  const reportUrl = requiredString(input.storeUrl);
  if (!reportUrl) return null;
  if (isGreyMarketUrl(reportUrl)) return null;
  if (!isWhitelistedUrl(reportUrl)) return null;

  // discountCut is optional for deals that do not publish a discount figure;
  // when present it must be in range. A missing/invalid value is treated as 0.
  const rawDiscount = input.discountCut;
  let discountCut = 0;
  if (rawDiscount !== undefined && rawDiscount !== null && rawDiscount !== '') {
    const d = sanitizeDiscount(rawDiscount);
    if (d === null) return null;
    discountCut = d;
  }

  const regularPriceRaw = sanitizePrice(input.regularPrice);
  const regularPrice = regularPriceRaw === null ? currentPrice : regularPriceRaw;

  const id =
    optionalString(input.id) ||
    optionalString(input.dealID) ||
    optionalString(input.gameID) ||
    `deal-${sanitizeTitleKey(title)}`;

  return {
    id,
    title,
    store,
    currentPrice,
    regularPrice,
    discountCut,
    storeUrl: reportUrl,
    // Extraneous properties are intentionally dropped: only the allowlist below
    // is copied. Optional upstream enrichment identifiers are preserved when
    // present so the client can continue to build historical-low links.
    type: 'game',
    ...(input.boxart ? { boxart: optionalString(input.boxart) || undefined } : {}),
    ...(input.gameID ? { gameID: optionalString(input.gameID) || undefined } : {}),
    ...(input.dealID ? { dealID: optionalString(input.dealID) || undefined } : {}),
    ...(input.steamAppID
      ? { steamAppID: optionalString(input.steamAppID) || undefined }
      : {}),
  };
}

/** Deterministic key used only as a fallback stable identifier. */
function sanitizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Validate a single giveaway record. Giveaways are always free (price 0,
 * discount 100) and the outgoing link must be a whitelisted HTTPS URL with no
 * grey-market / phishing host.
 *
 * NOTE: the `store`/`platforms` value is freeform display metadata (e.g.
 * "PC, Epic Games Store", "PC, Itch.io, DRM-Free") and is intentionally NOT
 * whitelist-gated — only the clickable claim URL must pass the whitelist.
 */
export function parseGiveawayRecord(input: any): SanitizedGiveaway | null {
  if (!input || typeof input !== 'object') return null;

  const title = requiredString(input.title);
  if (!title) return null;

  const store = optionalString(input.store) || optionalString(input.platforms) || 'GamerPower';

  const url = optionalString(input.storeUrl) || optionalString(input.open_giveaway_url) ||
    optionalString(input.gamerpower_url);
  if (!url) return null;
  if (isGreyMarketUrl(url)) return null;
  if (!isWhitelistedUrl(url)) return null;

  return {
    id: optionalString(input.id) || `giveaway-${sanitizeTitleKey(title)}`,
    title,
    store,
    currentPrice: 0,
    regularPrice: 0,
    discountCut: 100,
    storeUrl: url,
    type: 'giveaway',
    ...(input.boxart || input.image || input.thumbnail
      ? { boxart: optionalString(input.boxart) || optionalString(input.image) || optionalString(input.thumbnail) || undefined }
      : {}),
    worth: optionalString(input.worth),
    giveawayType: optionalString(input.type) || optionalString(input.giveawayType),
    status: optionalString(input.status),
    endDate: optionalString(input.endDate),
    description: optionalString(input.description),
    storeBadge: optionalString(input.storeBadge),
  };
}

/** Apply a parser over an array, dropping rejections. */
export function parseDealFeed<T>(
  raw: unknown,
  parser: (item: any) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const parsed = parser(item);
    if (parsed) out.push(parsed);
  }
  return out;
}