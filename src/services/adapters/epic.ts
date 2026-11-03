/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Epic Games profile adapter.
 *
 * Uses the Epic Games developer API when EPIC_OAUTH_TOKEN is configured.
 * privacy-minimized: the Epic display name is the only identity value handled; the token
 * stays in the local encrypted vault. Degrades to deterministic local synthesis
 * when no token is configured or the upstream is unreachable.
 */

import type { PlatformAdapter, ConnectPlatformInput, PlatformProfile, PlatformGameEntry } from './types';
import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeArray, safeHydrate } from '../../utils/ingest';
import { synthesizeProfile, emptyProfile } from './synth';

const limiter = new RateLimiter(1);

const EPIC_NAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function epicEndpoint(): string {
  return 'https://api.epicgames.dev/library/v1/me/titles?limit=50';
}

function parseEntries(raw: unknown, epicName: string): PlatformGameEntry[] {
  const titles = safeArray<any>(safeHydrate(raw)?.titles || safeHydrate(raw)?.libraryItems);
  const entries: PlatformGameEntry[] = [];
  for (const t of titles) {
    if (!t || typeof t !== 'object') continue;
    const gameId = String(t.titleId ?? t.catalogItemId ?? '');
    const title = String(t.title ?? t.name ?? '').trim();
    if (!gameId || !title) continue;
    const minutes = Number(t.playtimeMinutes ?? 0);
    entries.push({
      gameId,
      title,
      playtimeMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0,
      lastPlayedAt: null,
      platform: 'epic',
    });
  }
  return entries;
}

export const epicAdapter: PlatformAdapter = {
  key: 'epic',

  validatePublicId(publicId: string): boolean {
    return EPIC_NAME_RE.test(String(publicId || '').trim());
  },

  async syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile> {
    const token = process.env.EPIC_OAUTH_TOKEN || '';
    const epicName = String(input.publicId || '').trim();
    if (!epicName) return emptyProfile('epic', input.publicId);
    if (!token) return synthesizeProfile(input);

    await limiter.acquire();
    const data = await safeFetchJSONWithBackoff<any>(
      epicEndpoint(),
      { attempts: 3 },
      null,
    );
    const entries = parseEntries(data, epicName);
    if (entries.length === 0) return synthesizeProfile(input);

    return {
      platform: 'epic',
      publicId: epicName,
      games: entries.slice(0, 200),
      syncedAt: new Date().toISOString(),
    };
  },
};
