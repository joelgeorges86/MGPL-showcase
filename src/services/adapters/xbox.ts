/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Xbox Live profile adapter.
 *
 * Community XBL wrapper (xbl.io) that resolves a gamertag to profile + title
 * history when XBOX_API_KEY is configured. Privacy-minimized by construction — only the
 * public gamertag and numeric gameplay metrics are handled. Degrades to
 * deterministic local synthesis when the key is absent or upstream is down.
 */

import type { PlatformAdapter, ConnectPlatformInput, PlatformProfile, PlatformGameEntry } from './types';
import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeArray, safeHydrate } from '../../utils/ingest';
import { synthesizeProfile, emptyProfile } from './synth';

const limiter = new RateLimiter(2);

const XBOX_GAMERTAG_RE = /^[a-zA-Z0-9\s]{1,15}$/;

function xblEndpoint(apiKey: string, gamertag: string): string {
  return `https://xbl.io/api/v2/player/${encodeURIComponent(gamertag)}/titles`;
}

function parseEntries(raw: unknown, gamertag: string): PlatformGameEntry[] {
  const titles = safeArray<any>(safeHydrate(raw)?.titles || safeHydrate(raw)?.data);
  const entries: PlatformGameEntry[] = [];
  for (const t of titles) {
    if (!t || typeof t !== 'object') continue;
    const gameId = String(t.titleId ?? t.name ?? '');
    const title = String(t.name ?? '').trim();
    if (!gameId || !title) continue;
    const minutes = Number(t.minutesPlayed ?? t.playTime ?? 0);
    entries.push({
      gameId,
      title,
      playtimeMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0,
      achievements: Number.isFinite(Number(t.achievementsUnlocked))
        ? Number(t.achievementsUnlocked)
        : undefined,
      lastPlayedAt: null,
      platform: 'xbox',
    });
  }
  return entries;
}

export const xboxAdapter: PlatformAdapter = {
  key: 'xbox',

  validatePublicId(publicId: string): boolean {
    return XBOX_GAMERTAG_RE.test(String(publicId || '').trim());
  },

  async syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile> {
    const apiKey = process.env.XBOX_API_KEY || '';
    const gamertag = String(input.publicId || '').trim();
    if (!gamertag) return emptyProfile('xbox', input.publicId);
    if (!apiKey) return synthesizeProfile(input);

    await limiter.acquire();
    const data = await safeFetchJSONWithBackoff<any>(
      xblEndpoint(apiKey, gamertag),
      { attempts: 3 },
      null,
    );
    const entries = parseEntries(data, gamertag);
    if (entries.length === 0) return synthesizeProfile(input);

    return {
      platform: 'xbox',
      publicId: gamertag,
      games: entries.slice(0, 200),
      syncedAt: new Date().toISOString(),
    };
  },
};
