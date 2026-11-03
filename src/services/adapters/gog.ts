/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — GOG Galaxy profile adapter.
 *
 * Uses the GOG public API when GOG_OAUTH_TOKEN is configured. privacy-minimized: only
 * the GOG username (public handle) and numeric gameplay metrics are handled.
 * Degrades to deterministic local synthesis when no token is configured.
 */

import type { PlatformAdapter, ConnectPlatformInput, PlatformProfile, PlatformGameEntry } from './types';
import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeArray, safeHydrate } from '../../utils/ingest';
import { synthesizeProfile, emptyProfile } from './synth';

const limiter = new RateLimiter(1);

const GOG_USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function gogEndpoint(username: string): string {
  return `https://api.gog.com/users/${encodeURIComponent(username)}/games`;
}

function parseEntries(raw: unknown, username: string): PlatformGameEntry[] {
  const games = safeArray<any>(safeHydrate(raw)?.items || safeHydrate(raw)?.games);
  const entries: PlatformGameEntry[] = [];
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    const gameId = String(g.id ?? g.game?.id ?? '');
    const title = String(g.title ?? g.game?.title ?? '').trim();
    if (!gameId || !title) continue;
    const minutes = Number(g.playtime ?? g.playtimeMinutes ?? 0);
    entries.push({
      gameId,
      title,
      playtimeMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0,
      lastPlayedAt: null,
      platform: 'gog',
    });
  }
  return entries;
}

export const gogAdapter: PlatformAdapter = {
  key: 'gog',

  validatePublicId(publicId: string): boolean {
    return GOG_USERNAME_RE.test(String(publicId || '').trim());
  },

  async syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile> {
    const token = process.env.GOG_OAUTH_TOKEN || '';
    const username = String(input.publicId || '').trim();
    if (!username) return emptyProfile('gog', input.publicId);
    if (!token) return synthesizeProfile(input);

    await limiter.acquire();
    const data = await safeFetchJSONWithBackoff<any>(
      gogEndpoint(username),
      { attempts: 3 },
      null,
    );
    const entries = parseEntries(data, username);
    if (entries.length === 0) return synthesizeProfile(input);

    return {
      platform: 'gog',
      publicId: username,
      games: entries.slice(0, 200),
      syncedAt: new Date().toISOString(),
    };
  },
};
