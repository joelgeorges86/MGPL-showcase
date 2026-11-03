/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Unified cross-platform adapter registry.
 *
 * Exposes a single lookup so routes and sync jobs never import individual
 * adapters. Unknown platforms are rejected at the type level; callers can also
 * iterate `allAdapters` to run a full profile sync.
 */

import type { PlatformAdapter, PlatformKey } from './types';
import { steamAdapter } from './steam';
import { xboxAdapter } from './xbox';
import { psnAdapter } from './psn';
import { epicAdapter } from './epic';
import { gogAdapter } from './gog';
import { ubisoftAdapter } from './ubisoft';

export type { PlatformAdapter, PlatformKey } from './types';
export type { PlatformProfile, PlatformGameEntry, ConnectPlatformInput } from './types';
export {
  PLATFORM_KEYS,
  PLATFORM_LABELS,
  PLATFORM_ICONS,
  maskHandle,
} from './types';
export { safeFetchJSONWithBackoff, RateLimiter } from './request';
export { synthesizeProfile, emptyProfile } from './synth';

/** Ordered adapter list (registry of record). */
export const allAdapters: readonly PlatformAdapter[] = [
  steamAdapter,
  xboxAdapter,
  psnAdapter,
  epicAdapter,
  gogAdapter,
  ubisoftAdapter,
];

const ADAPTER_LOOKUP: Record<string, PlatformAdapter> = Object.fromEntries(
  allAdapters.map((a) => [a.key, a]),
);

/** Resolve an adapter by platform key, or null for unknown platforms. */
export function adapterForPlatform(key: string): PlatformAdapter | null {
  return ADAPTER_LOOKUP[key] || null;
}
