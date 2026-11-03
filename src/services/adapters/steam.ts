/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Steam Web API profile adapter.
 *
 * Pulls owned-games metadata (title, playtime, achievements, last played) from
 * the Steam Web API using a server-side STEAM_API_KEY and the user's public
 * SteamID64. privacy-minimized: only the public ID and numeric gameplay metrics are
 * ever handled. Degrades to deterministic local synthesis when the key is not
 * configured or the upstream is unreachable.
 */

import type { PlatformAdapter, ConnectPlatformInput, PlatformProfile, PlatformGameEntry } from './types';
import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeArray, safeHydrate } from '../../utils/ingest';
import { synthesizeProfile, emptyProfile } from './synth';

const limiter = new RateLimiter(2);

const STEAM_ID64_RE = /^7656119\d{10}$/;
const STEAM_CUSTOM_RE = /^[a-zA-Z0-9_-]{2,32}$/;

function steamEndpoint(apiKey: string, steamId: string): string {
  return (
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(apiKey)}` +
    `&steamid=${encodeURIComponent(steamId)}&format=json&include_appinfo=1&include_achievements=1`
  );
}

function parseEntries(raw: unknown, steamId: string): PlatformGameEntry[] {
  const games = safeArray<any>(safeHydrate<any>(raw)?.response?.games);
  const entries: PlatformGameEntry[] = [];
  for (const g of games) {
    if (!g || typeof g !== 'object') continue;
    const appId = String(g.appid ?? '');
    const title = String(g.name ?? '').trim();
    if (!appId || !title) continue;
    const playtimeMinutes = Number(g.playtime_forever);
    // Steam returns achievements as an object `{ total, unlocked }` when
    // include_achievements=1; tolerate a raw numeric count as well.
    const achievementsRaw = g.achievements;
    let achievements: number | undefined;
    if (typeof achievementsRaw === 'number' && Number.isFinite(achievementsRaw)) {
      achievements = achievementsRaw;
    } else if (achievementsRaw && typeof achievementsRaw === 'object') {
      const unlocked = Number((achievementsRaw as any).unlocked);
      if (Number.isFinite(unlocked)) achievements = unlocked;
    }
    const lastPlayed = Number(g.rtime_last_played);
    entries.push({
      gameId: appId,
      title,
      playtimeMinutes: Number.isFinite(playtimeMinutes) && playtimeMinutes > 0 ? playtimeMinutes : 0,
      achievements,
      lastPlayedAt: Number.isFinite(lastPlayed) && lastPlayed > 0
        ? new Date(lastPlayed * 1000).toISOString()
        : null,
      platform: 'steam',
    });
  }
  return entries;
}

export const steamAdapter: PlatformAdapter = {
  key: 'steam',

  validatePublicId(publicId: string): boolean {
    const id = String(publicId || '').trim();
    return STEAM_ID64_RE.test(id) || STEAM_CUSTOM_RE.test(id);
  },

  async syncProfile(input: ConnectPlatformInput): Promise<PlatformProfile> {
    const apiKey = process.env.STEAM_API_KEY || '';
    const steamId = String(input.publicId || '').trim();
    if (!steamId) return emptyProfile('steam', input.publicId);
    if (!apiKey) return synthesizeProfile(input);

    await limiter.acquire();
    const data = await safeFetchJSONWithBackoff<any>(
      steamEndpoint(apiKey, steamId),
      { attempts: 3 },
      null,
    );
    const entries = parseEntries(data, steamId);
    if (entries.length === 0) return synthesizeProfile(input);

    return {
      platform: 'steam',
      publicId: steamId,
      games: entries.slice(0, 200),
      syncedAt: new Date().toISOString(),
    };
  },
};
