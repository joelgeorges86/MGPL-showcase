/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Unified cross-platform profile sync types.
 *
 * privacy-minimized contract: every persisted or returned value is a public gaming
 * handle or numeric gameplay metric. Real names, emails, billing details, and
 * remote telemetry IDs are never accepted by any adapter.
 */

export type PlatformKey = 'steam' | 'psn' | 'xbox' | 'epic' | 'gog' | 'ubisoft';

export const PLATFORM_KEYS: readonly PlatformKey[] = [
  'steam',
  'psn',
  'xbox',
  'epic',
  'gog',
  'ubisoft',
] as const;

export const PLATFORM_LABELS: Record<PlatformKey, string> = {
  steam: 'Steam',
  psn: 'PlayStation Network',
  xbox: 'Xbox Live',
  epic: 'Epic Games',
  gog: 'GOG Galaxy',
  ubisoft: 'Ubisoft Connect',
};

/** Icon hint consumed by the client (Lucide names used elsewhere in the app). */
export const PLATFORM_ICONS: Record<PlatformKey, string> = {
  steam: 'steam',
  psn: 'gamepad-2',
  xbox: 'gamepad',
  epic: 'layers',
  gog: 'package',
  ubisoft: 'shield',
};

export interface PlatformGameEntry {
  gameId: string;
  title: string;
  playtimeMinutes: number;
  /** Achievements unlocked (Steam) or trophies earned (PSN) when known. */
  achievements?: number;
  lastPlayedAt?: string | null;
  platform: PlatformKey;
}

export interface PlatformProfile {
  platform: PlatformKey;
  /** Public identity handle — never an email or real name. */
  publicId: string;
  games: PlatformGameEntry[];
  syncedAt: string;
}

export interface ConnectPlatformInput {
  platform: PlatformKey;
  publicId: string;
  token: string;
}

export interface PlatformAdapter {
  key: PlatformKey;
  /** Validate a public ID format for this platform without any network I/O. */
  validatePublicId(publicId: string): boolean;
  /** Sync the unified profile from the upstream API using the stored token. */
  syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile>;
}

/**
 * Mask a public handle for display: first character + bullets + last character.
 * The masked form is what the UI and public profile views render — the raw
 * handle is only ever shown to the account owner in the settings drawer.
 */
export function maskHandle(handle: string): string {
  const s = String(handle || '').trim();
  if (!s) return '';
  if (s.length <= 2) return '••••';
  const bullets = Math.min(4, Math.max(2, s.length - 2));
  return `${s[0]}${'•'.repeat(bullets)}${s[s.length - 1]}`;
}
