/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Ubisoft Connect profile adapter.
 *
 * Uses the Ubisoft public-ubiservices API when UBISOFT_OAUTH_TOKEN is
 * configured (Bearer Authorization header). Privacy-minimized: only the public Ubisoft
 * username and numeric gameplay metrics are handled. Degrades to deterministic
 * local synthesis when no token is configured.
 */

import type { PlatformAdapter, ConnectPlatformInput, PlatformProfile, PlatformGameEntry } from './types';
import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeArray, safeHydrate } from '../../utils/ingest';
import { synthesizeProfile, emptyProfile } from './synth';

const limiter = new RateLimiter(1);

const UBISOFT_NAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function ubisoftEndpoint(): string {
  return 'https://public-ubiservices.ubi.com/v1/profiles/me/games';
}

function parseEntries(raw: unknown, username: string): PlatformGameEntry[] {
  const games = safeArray<any>(safeHydrate(raw)?.games || safeHydrate(raw)?.items);
  const entries: PlatformGameEntry[] = [];
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    const gameId = String(g.gameId ?? g.id ?? '');
    const title = String(g.title ?? g.name ?? '').trim();
    if (!gameId || !title) continue;
    const minutes = Number(g.playtimeMinutes ?? g.playtime ?? 0);
    entries.push({
      gameId,
      title,
      playtimeMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0,
      lastPlayedAt: null,
      platform: 'ubisoft',
    });
  }
  return entries;
}

export const ubisoftAdapter: PlatformAdapter = {
  key: 'ubisoft',

  validatePublicId(publicId: string): boolean {
    return UBISOFT_NAME_RE.test(String(publicId || '').trim());
  },

  async syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile> {
    const token = process.env.UBISOFT_OAUTH_TOKEN || '';
    const username = String(input.publicId || '').trim();
    if (!username) return emptyProfile('ubisoft', input.publicId);
    if (!token) return synthesizeProfile(input);

    await limiter.acquire();
    const data = await safeFetchJSONWithBackoff<any>(
      ubisoftEndpoint(),
      { attempts: 3 },
      null,
    );
    const entries = parseEntries(data, username);
    if (entries.length === 0) return synthesizeProfile(input);

    return {
      platform: 'ubisoft',
      publicId: username,
      games: entries.slice(0, 200),
      syncedAt: new Date().toISOString(),
    };
  },
};
