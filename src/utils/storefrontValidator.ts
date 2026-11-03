/**
 * Sprint 1 (EPIC-DEAL-001) — Storefront Domain Whitelist & Grey-Market Rejection.
 *
 * Authoritative hostname gating for every external deal and giveaway link that
 * the ingestion pipeline persists or serves to the frontend. The whitelist is
 * intentionally strict: only the direct platform stores plus a small set of
 * authorized key retailers are allowed, and known grey-market key resellers are
 * rejected by suffix match regardless of protocol or subdomain.
 *
 * All helpers are pure (no I/O) so they can be unit-tested and reused across
 * routes and the circuit breaker's snapshot cache.
 */

/**
 * Strict, exact hostnames allowed for outbound deal / giveaway links. Subdomains
 * of these hosts (e.g. `www.fanatical.com`) are handled by `hostnameOf` + the
 * explicit `www.` aliases below; any other subdomain is rejected.
 */
export const ALLOWED_STOREFRONT_HOSTS: ReadonlySet<string> = new Set([
  // Direct platform stores
  'store.steampowered.com',
  'gog.com',
  'www.gog.com',
  'store.epicgames.com',
  // Authorized key retailers
  'fanatical.com',
  'www.fanatical.com',
  'greenmangaming.com',
  'www.greenmangaming.com',
  'humblebundle.com',
  'www.humblebundle.com',
  'gamesplanet.com',
  'www.gamesplanet.com',
  'gamebillet.com',
  'www.gamebillet.com',
  // Giveaway feed (GamerPower)
  'gamerpower.com',
  'www.gamerpower.com',
]);

/**
 * Known grey-market / unauthorized key-reseller domains. These are matched by
 * suffix so subdomains (e.g. `www.g2a.com`) and locale variants are caught. The
 * list is intentionally broad; any URL whose hostname ends with one of these
 * suffixes is rejected before hostname whitelisting is even considered.
 */
export const GREY_MARKET_DOMAINS: readonly string[] = [
  'g2a.com',
  'kinguin.net',
  'eneba.com',
  'cdkeys.com',
  'gamivo.com',
];

/** Canonical store display names that map onto the whitelisted host set. */
export const ALLOWED_STORE_NAMES: ReadonlySet<string> = new Set([
  'Steam',
  'GOG',
  'Epic',
  'Epic Games',
  'Fanatical',
  'Green Man Gaming',
  'GreenManGaming',
  'Humble Store',
  'Humble Bundle',
  'Humble',
  'Gamesplanet',
  'GameBillet',
  'GamerPower',
]);

/**
 * Normalize a store name to a canonical MGPL display name. Handles the
 * aliases produced by CheapShark storeID mapping and ITAD shop names.
 */
export function canonicalStoreName(raw: string): string {
  const s = String(raw || '').trim();
  const lower = s.toLowerCase();
  if (lower === 'greenmangaming' || lower === 'green man gaming') return 'Green Man Gaming';
  if (lower === 'epic' || lower === 'epic games' || lower === 'epic games store') return 'Epic Games';
  if (lower === 'humble' || lower === 'humble store' || lower === 'humble bundle') return 'Humble Store';
  if (lower === 'gog' || lower === 'gog.com') return 'GOG';
  if (lower === 'steam') return 'Steam';
  if (lower === 'fanatical' || lower === 'fanatical.com') return 'Fanatical';
  if (lower === 'gamesplanet' || lower === 'gamesplanet.com') return 'Gamesplanet';
  if (lower === 'gamebillet' || lower === 'gamebillet.com') return 'GameBillet';
  if (lower === 'gamerpower' || lower === 'gamerpower.com') return 'GamerPower';
  return s;
}

/** True when the store display name is present in the authoritative list. */
export function isWhitelistedStoreName(name: string): boolean {
  const s = String(name || '').trim();
  if (!s) return false;
  if (ALLOWED_STORE_NAMES.has(s)) return true;
  return ALLOWED_STORE_NAMES.has(canonicalStoreName(s));
}

/**
 * Extract a normalized lowercase hostname from a URL string. Returns null for
 * malformed or empty input. Handles missing scheme by assuming a leading `//`.
 */
export function hostnameOf(url: string): string | null {
  const s = String(url || '').trim();
  if (!s) return null;
  try {
    const normalized = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const parsed = new URL(normalized);
    return (parsed.hostname || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** True when the URL uses the HTTPS protocol (case-insensitive scheme). */
export function isHttps(url: string): boolean {
  const s = String(url || '').trim();
  if (!s) return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when a URL's hostname (suffix) matches a known grey-market domain. */
export function isGreyMarketUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return GREY_MARKET_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Enforce HTTPS protocol and strict hostname matching against the whitelist.
 * Grey-market URLs are always rejected, even if they happen to share a hostname
 * suffix with an allowed domain (they never do, but the explicit check keeps the
 * rejection unambiguous and testable).
 */
export function isWhitelistedUrl(url: string): boolean {
  if (!url) return false;
  if (isGreyMarketUrl(url)) return false;
  if (!isHttps(url)) return false;
  const host = hostnameOf(url);
  if (!host) return false;
  return ALLOWED_STOREFRONT_HOSTS.has(host);
}

/** Canonical outbound domain for a whitelisted store display name. */
export function canonicalDomainForStore(name: string): string | null {
  const canonical = canonicalStoreName(name);
  switch (canonical) {
    case 'Steam':
      return 'store.steampowered.com';
    case 'GOG':
      return 'www.gog.com';
    case 'Epic Games':
      return 'store.epicgames.com';
    case 'Fanatical':
      return 'www.fanatical.com';
    case 'Green Man Gaming':
      return 'www.greenmangaming.com';
    case 'Humble Store':
      return 'www.humblebundle.com';
    case 'Gamesplanet':
      return 'www.gamesplanet.com';
    case 'GameBillet':
      return 'www.gamebillet.com';
    case 'GamerPower':
      return 'www.gamerpower.com';
    default:
      return null;
  }
}

/**
 * Build a canonical HTTPS search URL for a whitelisted store. This replaces the
 * old CheapShark/ITAD redirect URLs with direct, domain-whitelisted links so the
 * API response never exposes a non-whitelisted outbound host.
 */
export function storeUrlForWhitelistedStore(storeName: string, title: string): string {
  const canonical = canonicalStoreName(storeName);
  const domain = canonicalDomainForStore(canonical);
  if (!domain) return 'https://store.steampowered.com/search/';
  const term = encodeURIComponent(String(title || '').trim());
  switch (canonical) {
    case 'Steam':
      return `https://store.steampowered.com/search/?term=${term}`;
    case 'GOG':
      return `https://www.gog.com/en/games?query=${term}`;
    case 'Epic Games':
      return `https://store.epicgames.com/en-US/browse?q=${term}`;
    case 'Fanatical':
      return `https://www.fanatical.com/en/search?search=${term}`;
    case 'Green Man Gaming':
      return `https://www.greenmangaming.com/search/?text=${term}`;
    case 'Humble Store':
      return `https://www.humblebundle.com/store/search?search=${term}`;
    case 'Gamesplanet':
      return `https://www.gamesplanet.com/search?q=${term}`;
    case 'GameBillet':
      return `https://www.gamebillet.com/search?q=${term}`;
    case 'GamerPower':
      return 'https://www.gamerpower.com/';
    default:
      return `https://${domain}/`;
  }
}