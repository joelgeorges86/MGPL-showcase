/**
 * Sprint 2 (WUD-2.3 / EPIC-03) — ProtonDB Compatibility Ingestion Adapter.
 *
 * Fetches ProtonDB community compatibility tiers (Platinum / Gold / Silver /
 * Bronze / Borked) by Steam AppID via safeFetchJSONWithBackoff with a local
 * TTL cache. `safeDeviceProfile` scoring normalization blends the community
 * tier with the user's persisted hardware profile into a 0-100 compatibility
 * score.
 *
 * privacy-minimized / contributor-identity exclusion: only numeric aggregates (tier,
 * confidence-weighted score, total reports) are read — author names, profile
 * URLs and other contributor identity fields are never parsed or stored.
 */

import { safeFetchJSONWithBackoff, RateLimiter } from './request';
import { safeDeviceProfile } from '../../utils/safes';
import { safeHydrate } from '../../utils/ingest';

const TIER_ORDER = ['Platinum', 'Gold', 'Silver', 'Bronze', 'Borked', 'Pending'] as const;
export type ProtonTier = (typeof TIER_ORDER)[number];

const limiter = new RateLimiter(2);

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const CACHE_TTL_MS = readIntEnv('PROTONDB_CACHE_TTL_MS', 60 * 60 * 1000);

interface CacheEntry {
  data: ProtonDbSummary | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface ProtonDbSummary {
  appId: string;
  tier: ProtonTier;
  /** Confidence-weighted community score in [0, 1]. */
  score: number;
  totalReports: number;
  confidence: string;
  cachedAt: string;
  /** Normalized 0-100 compatibility score (tier + device profile). */
  normalized: number;
}

function normalizeTier(raw: string): ProtonTier {
  const t = String(raw || '').trim().toLowerCase();
  const match = TIER_ORDER.find((x) => x.toLowerCase() === t);
  return match ?? 'Pending';
}

/** Map a ProtonDB tier to a normalized 0-100 score. */
export function tierNormalizedScore(tier: ProtonTier): number {
  switch (tier) {
    case 'Platinum':
      return 100;
    case 'Gold':
      return 85;
    case 'Silver':
      return 70;
    case 'Bronze':
      return 50;
    case 'Borked':
      return 20;
    default:
      return 0;
  }
}

/**
 * safeDeviceProfile scoring normalization: blend the ProtonDB community tier
 * score with the persisted hardware profile's tier label (when the device
 * reports one) into a single 0-100 number. Missing device data degrades to the
 * community tier alone — never a guess.
 */
export function normalizeDeviceCompatibility(tier: ProtonTier, device: unknown): number {
  const prof = safeDeviceProfile(device);
  const tierScore = tierNormalizedScore(tier);
  const knownDevice = prof.tier && prof.tier !== 'Unknown' && prof.tier !== '';
  const deviceScore = knownDevice ? tierNormalizedScore(prof.tier as ProtonTier) : tierScore;
  return Math.round((tierScore + deviceScore) / 2);
}

function buildSummary(appId: string, raw: unknown): ProtonDbSummary | null {
  const body = safeHydrate<any>(raw);
  const tier = normalizeTier(body.tier ?? body.best);
  const score = Number(body.score);
  const total = Number(body.total);
  if (!Number.isFinite(score) || !Number.isFinite(total)) return null;
  return {
    appId,
    tier,
    score: Math.max(0, Math.min(1, score)),
    totalReports: Math.max(0, Math.floor(total)),
    confidence: String(body.confidence || 'unknown'),
    cachedAt: new Date().toISOString(),
    normalized: normalizeDeviceCompatibility(tier, null),
  };
}

/** Read a cached summary without network I/O (null when absent or stale). */
export function getCachedProtonDb(appId: string): ProtonDbSummary | null {
  const cached = cache.get(String(appId || '').trim());
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  return null;
}

/**
 * Fetch + cache the ProtonDB summary for a Steam AppID. Respects the TTL cache
 * first, then the shared backoff/rate-limited fetch. Returns null when the
 * upstream is unreachable or the AppID has no reports.
 */
export async function fetchProtonDbSummary(appId: string): Promise<ProtonDbSummary | null> {
  const id = String(appId || '').trim();
  if (!id) return null;
  const cached = getCachedProtonDb(id);
  if (cached) return cached;

  await limiter.acquire();
  const data = await safeFetchJSONWithBackoff<any>(
    `https://www.protondb.com/api/v1/reports/summaries/${encodeURIComponent(id)}.json`,
    { attempts: 2 },
    null,
  );
  const summary = data !== null ? buildSummary(id, data) : null;
  cache.set(id, { data: summary, fetchedAt: Date.now() });
  return summary;
}

/** Clear the TTL cache (test determinism / admin reset). */
export function clearProtonDbCache(): void {
  cache.clear();
}
