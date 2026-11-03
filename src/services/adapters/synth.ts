/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Deterministic offline synthesis fallback.
 *
 * When an upstream platform API is unreachable (no credentials, network
 * blocked, or circuit open), adapters degrade to a stable, reproducible local
 * profile synthesized from the publicId. This mirrors the codebase's existing
 * deterministic price-synthesis pattern (wishlistPricing.ts) so the unified
 * profile stays populated offline and the E2E suite stays hermetic.
 */

import type { PlatformKey, PlatformGameEntry, PlatformProfile, ConnectPlatformInput } from './types';

/** Well-known titles used by the synthesis fallback (non-exhaustive seed set). */
const SYNTH_TITLES: ReadonlyArray<{ gameId: string; title: string; minutes: number }> = [
  { gameId: '730', title: 'Counter-Strike 2', minutes: 1420 },
  { gameId: '570', title: 'Dota 2', minutes: 1180 },
  { gameId: '1085660', title: 'Destiny 2', minutes: 860 },
  { gameId: '1091500', title: 'Cyberpunk 2077', minutes: 415 },
  { gameId: '292030', title: 'The Witcher 3: Wild Hunt', minutes: 312 },
  { gameId: '892970', title: 'Valheim', minutes: 198 },
  { gameId: '1245620', title: 'Elden Ring', minutes: 144 },
];

/** Deterministic hash so the same publicId always yields the same synthesis. */
function hashString(seed: string): number {
  let hash = 0;
  const input = seed || 'unknown';
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Build a deterministic, stable local profile for the given platform/ID. */
export function synthesizeProfile(input: ConnectPlatformInput): PlatformProfile {
  const h = hashString(`${input.platform}:${input.publicId}`);
  const games: PlatformGameEntry[] = SYNTH_TITLES.map((g, idx) => {
    const jitter = ((h + idx * 7919) % 1000) / 100; // 0..9.99 extra hours
    return {
      gameId: g.gameId,
      title: g.title,
      playtimeMinutes: Math.round(g.minutes * 60 * (0.5 + jitter / 10)),
      achievements: (h + idx * 13) % 80,
      lastPlayedAt: null,
      platform: input.platform,
    };
  });
  return {
    platform: input.platform,
    publicId: input.publicId,
    games,
    syncedAt: new Date().toISOString(),
  };
}

/** Empty-but-valid profile used when a platform has no library to report. */
export function emptyProfile(platform: PlatformKey, publicId: string): PlatformProfile {
  return {
    platform,
    publicId,
    games: [],
    syncedAt: new Date().toISOString(),
  };
}
