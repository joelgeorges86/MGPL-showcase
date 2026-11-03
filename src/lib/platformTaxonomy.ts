/**
 * PI-GTM-2026-001 (EPIC-04): Canonical Platform Taxonomy v1.0.
 *
 * The canonical platform taxonomy enforced at the data layer. Every catalog
 * platform label MUST resolve to one of these seven values via
 * `normalizePlatform()`. Values use an en-dash (U+2013) per the approved
 * PGC Charter v1.1 taxonomy — do NOT "normalize" them to hyphens; exact-match
 * consumers depend on this spelling.
 */
export const CANONICAL_PLATFORMS = [
  "PC",
  "Console – PlayStation",
  "Console – Xbox",
  "Console – Nintendo",
  "Mobile – iOS",
  "Mobile – Android",
  "Cloud",
] as const;

export type CanonicalPlatform = (typeof CANONICAL_PLATFORMS)[number];

/**
 * Deterministic alias map from the storefront / console label values that have
 * historically been written to AppOwnership.Platform (and the ones produced by
 * the ingestion pipeline) to their canonical taxonomy label. Keys are
 * lower-cased and trimmed.
 */
const PLATFORM_ALIASES: Record<string, string> = {
  // PC storefronts / launchers / key retailers
  pc: "PC",
  "pc / storefront": "PC",
  steam: "PC",
  gog: "PC",
  epic: "PC",
  "epic games": "PC",
  "legacy games": "PC",
  battlenet: "PC",
  "battle.net": "PC",
  blizzard: "PC",
  origin: "PC",
  ea: "PC",
  "ea app": "PC",
  uplay: "PC",
  ubisoft: "PC",
  amazon: "PC",
  "amazon games": "PC",
  twitch: "PC",
  itch: "PC",
  "itch.io": "PC",
  itchio: "PC",
  "humble bundle": "PC",
  humble: "PC",
  fanatical: "PC",
  "green man gaming": "PC",
  gmg: "PC",
  gamesplanet: "PC",
  gamebillet: "PC",
  windows: "PC",
  "microsoft store": "PC",
  microsoftstore: "PC",
  // PlayStation consoles
  playstation: "Console – PlayStation",
  "playstation 4": "Console – PlayStation",
  "playstation 5": "Console – PlayStation",
  ps3: "Console – PlayStation",
  ps4: "Console – PlayStation",
  ps5: "Console – PlayStation",
  psn: "Console – PlayStation",
  "ps vita": "Console – PlayStation",
  psp: "Console – PlayStation",
  // Xbox consoles
  xbox: "Console – Xbox",
  "xbox 360": "Console – Xbox",
  "xbox one": "Console – Xbox",
  "xbox series x": "Console – Xbox",
  "xbox series s": "Console – Xbox",
  "xbox series": "Console – Xbox",
  // Nintendo consoles
  nintendo: "Console – Nintendo",
  switch: "Console – Nintendo",
  "nintendo switch": "Console – Nintendo",
  "switch lite": "Console – Nintendo",
  "switch oled": "Console – Nintendo",
  "wii u": "Console – Nintendo",
  "3ds": "Console – Nintendo",
  eshop: "Console – Nintendo",
  // Mobile
  ios: "Mobile – iOS",
  iphone: "Mobile – iOS",
  ipad: "Mobile – iOS",
  "mobile – ios": "Mobile – iOS",
  android: "Mobile – Android",
  "mobile – android": "Mobile – Android",
  // Cloud
  cloud: "Cloud",
  "cloud gaming": "Cloud",
  "xbox cloud gaming": "Cloud",
  "geforce now": "Cloud",
  geforcenow: "Cloud",
  stadia: "Cloud",
  luna: "Cloud",
};

const ALIAS_KEYS = Object.keys(PLATFORM_ALIASES);

/**
 * Resolves a legacy / storefront platform string to the canonical taxonomy.
 * Returns the canonical label (always canonical casing) or `null` when the
 * input cannot be classified. Never throws.
 */
export function normalizePlatform(
  raw: string | null | undefined,
): CanonicalPlatform | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;

  // 1. Exact canonical match (case-insensitive; return canonical casing).
  for (const p of CANONICAL_PLATFORMS) {
    if (p.toLowerCase() === key) return p;
  }

  // 2. Exact alias match.
  if (ALIAS_KEYS.includes(key)) {
    return PLATFORM_ALIASES[key] as CanonicalPlatform;
  }

  // 3. Deterministic substring fallback for console/mobile/cloud families so
  //    e.g. "PlayStation 4", "Xbox One X", "Switch Lite" resolve correctly.
  if (/(ps3|ps4|ps5|psn|playstation|ps vita|psp)/.test(key)) {
    return "Console – PlayStation";
  }
  if (/xbox/.test(key)) return "Console – Xbox";
  if (/(nintendo|switch|eshop|wii|3ds)/.test(key)) {
    return "Console – Nintendo";
  }
  if (/(iphone|ipad|^ios$|ios )/.test(key)) return "Mobile – iOS";
  if (/android/.test(key)) return "Mobile – Android";
  if (/(cloud|geforce now|geforcenow|stadia|luna)/.test(key)) return "Cloud";

  return null;
}

/** True when `value` is one of the canonical taxonomy labels (exact casing). */
export function isCanonicalPlatform(value: unknown): value is CanonicalPlatform {
  if (typeof value !== "string") return false;
  return CANONICAL_PLATFORMS.includes(value as CanonicalPlatform);
}
