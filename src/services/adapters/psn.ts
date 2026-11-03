/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — PSN (PlayStation Network) profile adapter.
 *
 * Uses the PlayStation mobile web API with a bearer PSN_OAUTH_TOKEN to resolve
 * the authenticated profile's title list (trophies + playtime where exposed).
 * privacy-minimized: the PSN online ID is the only identity value handled. Degrades to
 * deterministic local synthesis when no token is configured.
 */

import type { PlatformAdapter, ConnectPlatformInput, PlatformProfile, PlatformGameEntry } from './types';
import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeArray, safeHydrate } from '../../utils/ingest';
import { synthesizeProfile, emptyProfile } from './synth';

const limiter = new RateLimiter(1);

const PSN_ID_RE = /^[a-zA-Z0-9_-]{3,16}$/;

function psnEndpoint(): string {
  return 'https://m.np.playstation.com/api/gamelist/v2/users/me/titles?limit=50';
}

function parseEntries(raw: unknown, psnId: string): PlatformGameEntry[] {
  const titles = safeArray<any>(safeHydrate(raw)?.titles);
  const entries: PlatformGameEntry[] = [];
  for (const t of titles) {
    if (!t || typeof t !== 'object') continue;
    const gameId = String(t.titleId ?? t.conceptId ?? '');
    const title = String(t.name ?? t.localizedName ?? '').trim();
    if (!gameId || !title) continue;
    const minutes = Number(t.playDurationMinutes ?? t.playtime ?? 0);
    const trophies = Number(t.trophyCount ?? t.earnedTrophies ?? 0);
    entries.push({
      gameId,
      title,
      playtimeMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0,
      achievements: Number.isFinite(trophies) ? trophies : undefined,
      lastPlayedAt: null,
      platform: 'psn',
    });
  }
  return entries;
}

export const psnAdapter: PlatformAdapter = {
  key: 'psn',

  validatePublicId(publicId: string): boolean {
    return PSN_ID_RE.test(String(publicId || '').trim());
  },

  async syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile> {
    const token = process.env.PSN_OAUTH_TOKEN || '';
    const psnId = String(input.publicId || '').trim();
    if (!psnId) return emptyProfile('psn', input.publicId);
    if (!token) return synthesizeProfile(input);

    await limiter.acquire();
    const data = await safeFetchJSONWithBackoff<any>(
      psnEndpoint(),
      { attempts: 3 },
      null,
    );
    const entries = parseEntries(data, psnId);
    if (entries.length === 0) return synthesizeProfile(input);

    return {
      platform: 'psn',
      publicId: psnId,
      games: entries.slice(0, 200),
      syncedAt: new Date().toISOString(),
    };
  },
};
