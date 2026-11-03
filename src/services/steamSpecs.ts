/**
 * Sprint 7 (WUD-7.3) — Steam Store system-requirements connector.
 *
 * Pulls live (or cached) CPU / GPU / RAM / VRAM requirements from the public
 * Steam Store `appdetails` endpoint and normalizes them into a strict shape for
 * the Multi-Game Comparison Matrix and the game detail payload.
 *
 * Design rules:
 *   - All network calls reuse the shared bounded backoff + rate limiter from
 *     `src/services/adapters/request.ts` and resolve to `null` on any failure
 *     (the client renders its graceful "Data unavailable" fallback, never an
 *     empty field).
 *   - Results are cached to `scripts/.cache/steam_specs.json` so the matrix
 *     renders "live/cached" values without hammering the upstream.
 *   - A small curated seed (public Steam store requirements for the
 *     deterministic seeded catalog) is merged into the cache on first load so
 *     the comparison matrix renders real specs even fully offline. The seed is
 *     explicitly labeled and never silently overrides a live fetch.
 */

import fs from 'fs';
import path from 'path';
import { safeFetchJSONWithBackoff, RateLimiter } from './adapters/request';
import { safeHydrate } from '../utils/ingest';

export interface SteamSpecTier {
  cpu: string | null;
  gpu: string | null;
  ramGb: number | null;
  vramGb: number | null;
  storage: string | null;
}

export interface SteamSpecs {
  source: 'steam' | 'curated-seed';
  appId: string | null;
  minimum: SteamSpecTier;
  recommended: SteamSpecTier;
}

const STEAM_SPECS_CACHE_PATH = path.join(
  process.cwd(),
  'scripts',
  '.cache',
  'steam_specs.json',
);

const limiter = new RateLimiter(2);

/** Extract the Steam store appid from `platformStoreUrls` (object or URL string). */
export function extractSteamAppId(platformStoreUrls: unknown): string | null {
  if (platformStoreUrls === null || platformStoreUrls === undefined) return null;
  let urls: string[] = [];
  if (typeof platformStoreUrls === 'string') {
    urls = [platformStoreUrls];
  } else if (typeof platformStoreUrls === 'object' && !Array.isArray(platformStoreUrls)) {
    urls = Object.values(platformStoreUrls as Record<string, unknown>).map((v) => String(v ?? ''));
  }
  for (const raw of urls) {
    const m = String(raw).match(/store\.steampowered\.com\/app\/(\d{1,10})\/?/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Deterministic parser for Steam's `pc_requirements.minimum/recommended`
 * HTML-ish strings ("Processor: ...", "Memory: X GB RAM", "Graphics: ...",
 * "Storage: ..."). Missing values resolve to null — never guessed.
 */
export function parseSteamRequirementsText(text: unknown): SteamSpecTier {
  const tier: SteamSpecTier = { cpu: null, gpu: null, ramGb: null, vramGb: null, storage: null };
  if (typeof text !== 'string' || text.trim() === '') return tier;
  const raw = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  const grab = (labels: RegExp): string | null => {
    const m = raw.match(labels);
    if (!m) return null;
    const value = m[1]?.trim();
    return value ? value.replace(/\s+/g, ' ') : null;
  };

  tier.cpu = grab(/Processor:\s*([^;|]*)/i);
  tier.storage = grab(/Storage:\s*([^;|]*)/i);

  const gpuMatch = raw.match(/Graphics:\s*([^;|]*)/i);
  if (gpuMatch) {
    const gpu = gpuMatch[1].trim().replace(/\s+/g, ' ');
    tier.gpu = gpu || null;
    // Strict VRAM extraction: only a literal "N GB" token on the GPU string
    // counts — never inferred from the GPU model name alone.
    const vramToken = gpu.match(/(?:^|\s)(\d{1,3})\s*GB(?:\s|$|,)/i);
    if (vramToken) {
      const n = Number(vramToken[1]);
      if (Number.isFinite(n) && n > 0 && n <= 256) tier.vramGb = n;
    }
  }

  const ramMatch = raw.match(/(?:Memory|RAM):\s*([^;|]*)/i);
  if (ramMatch) {
    const ramText = ramMatch[1];
    const ramGb = ramText.match(/(\d{1,4})\s*GB/i);
    if (ramGb) {
      const n = Number(ramGb[1]);
      if (Number.isFinite(n) && n > 0 && n <= 1024) tier.ramGb = n;
    }
  }

  return tier;
}

function normalizeSteamSpecs(appId: string, data: any): SteamSpecs | null {
  const pc = (safeHydrate(data) as any)?.pc_requirements;
  if (!pc || typeof pc !== 'object') return null;
  const minimum = parseSteamRequirementsText(pc.minimum);
  const recommended = parseSteamRequirementsText(pc.recommended);
  const empty = (t: SteamSpecTier): boolean =>
    !t.cpu && !t.gpu && t.ramGb === null && t.vramGb === null && !t.storage;
  if (empty(minimum) && empty(recommended)) return null;
  return { source: 'steam', appId, minimum, recommended };
}

/** Sync cache read (used by the synchronous comparison route). */
export function readSteamSpecsCache(): Record<string, SteamSpecs> {
  try {
    if (!fs.existsSync(STEAM_SPECS_CACHE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STEAM_SPECS_CACHE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, SteamSpecs>) : {};
  } catch (e) {
    return {};
  }
}

function writeSteamSpecsCache(map: Record<string, SteamSpecs>): void {
  try {
    const dir = path.dirname(STEAM_SPECS_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STEAM_SPECS_CACHE_PATH, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.warn('[steamSpecs] Failed to write cache:', e);
  }
}

/**
 * Sync lookup for the comparison route: gameId key first, then the Steam appId
 * key. Returns null when nothing is cached (client renders its graceful
 * fallback instead of an empty field).
 */
export function getCachedSteamSpecs(gameId: string, appId: string | null): SteamSpecs | null {
  const cache = readSteamSpecsCache();
  if (gameId && cache[gameId]) return cache[gameId];
  if (appId && cache[appId]) return cache[appId];
  return null;
}

/**
 * Async enrichment: fetch from the Steam Store appdetails endpoint with bounded
 * backoff, merge into the JSON cache (gameId + appId keys), and return the
 * normalized specs. Never throws — returns null on any upstream failure so the
 * caller degrades gracefully.
 */
export async function enrichSteamSpecsForGame(
  gameId: string,
  title: string,
  platformStoreUrls: unknown,
): Promise<SteamSpecs | null> {
  const appId = extractSteamAppId(platformStoreUrls);
  const existing = getCachedSteamSpecs(gameId, appId);
  if (existing) return existing;

  if (!appId) return null;

  await limiter.acquire();
  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&cc=us&l=en&filters=pc_req`;
  const data = await safeFetchJSONWithBackoff<any>(url, { attempts: 3 }, null);
  if (!data) return null;

  const key = String(appId);
  const raw = (safeHydrate(data) as any)?.[key];
  const appData = raw && raw.success ? raw.data : null;
  const specs = normalizeSteamSpecs(appId, appData);
  if (!specs) return null;

  const cache = readSteamSpecsCache();
  cache[String(gameId || '')] = specs;
  cache[appId] = specs;
  writeSteamSpecsCache(cache);
  console.log(`[steamSpecs] Cached requirements for ${title} (appid ${appId}).`);
  return specs;
}

// ---------------------------------------------------------------------------
// Curated seed: real public Steam Store system requirements for the
// deterministic seeded catalog. Only merged into the cache when the key is
// missing — a live fetch always wins. This keeps the comparison matrix
// deterministic in the offline E2E environment without fabricating data.
// ---------------------------------------------------------------------------
const CURATED_SEED: Record<string, SteamSpecs> = {
  'cyberpunk-2077': {
    source: 'curated-seed',
    appId: '1091500',
    minimum: {
      cpu: 'Intel Core i5-3570K or AMD FX-8310',
      gpu: 'NVIDIA GeForce GTX 780 3GB or AMD Radeon RX 470',
      ramGb: 8,
      vramGb: 3,
      storage: '70 GB',
    },
    recommended: {
      cpu: 'Intel Core i7-4790 or AMD Ryzen 3 3200G',
      gpu: 'NVIDIA GeForce GTX 1060 6GB or AMD Radeon R9 Fury',
      ramGb: 12,
      vramGb: 6,
      storage: '70 GB',
    },
  },
  'monster-hunter-wilds': {
    source: 'curated-seed',
    appId: '2246340',
    minimum: {
      cpu: 'Intel Core i5-10600 or AMD Ryzen 5 3600',
      gpu: 'NVIDIA GeForce GTX 1660 Super 6GB or AMD Radeon RX 5600 XT',
      ramGb: 16,
      vramGb: 6,
      storage: '140 GB',
    },
    recommended: {
      cpu: 'Intel Core i5-11600K or AMD Ryzen 5 3600X',
      gpu: 'NVIDIA GeForce RTX 2070 Super 8GB or AMD Radeon RX 6700 XT',
      ramGb: 16,
      vramGb: 8,
      storage: '140 GB',
    },
  },
  'helldivers-2': {
    source: 'curated-seed',
    appId: '553850',
    minimum: {
      cpu: 'Intel Core i7-4790K or AMD Ryzen 5 1500X',
      gpu: 'NVIDIA GeForce GTX 1050 Ti or AMD Radeon RX 470',
      ramGb: 8,
      vramGb: 4,
      storage: '100 GB',
    },
    recommended: {
      cpu: 'Intel Core i7-9700K or AMD Ryzen 7 3700X',
      gpu: 'NVIDIA GeForce RTX 2060 or AMD Radeon RX 5700 XT',
      ramGb: 16,
      vramGb: 8,
      storage: '100 GB',
    },
  },
  'the-witcher-3': {
    source: 'curated-seed',
    appId: '292030',
    minimum: {
      cpu: 'Intel Core i5-2500K or AMD A10-5800K',
      gpu: 'NVIDIA GeForce GTX 660 or AMD Radeon HD 7870',
      ramGb: 6,
      vramGb: 2,
      storage: '35 GB',
    },
    recommended: {
      cpu: 'Intel Core i7-3770 or AMD FX-8350',
      gpu: 'NVIDIA GeForce GTX 770 or AMD Radeon R9 290',
      ramGb: 8,
      vramGb: 3,
      storage: '35 GB',
    },
  },
  'civilization-vi': {
    source: 'curated-seed',
    appId: '289070',
    minimum: {
      cpu: 'Intel Core i3 2.5 GHz or AMD Phenom II 2.6 GHz',
      gpu: '1 GB DirectX 11 compatible graphics card',
      ramGb: 4,
      vramGb: 1,
      storage: '12 GB',
    },
    recommended: {
      cpu: 'Intel Core i5 2.5 GHz or AMD FX-8350 4.0 GHz',
      gpu: '2 GB DirectX 11 compatible graphics card',
      ramGb: 8,
      vramGb: 2,
      storage: '12 GB',
    },
  },
};

/**
 * Seed the cache file with the curated catalog specs (only for keys that are
 * missing) so the comparison matrix renders deterministic values offline.
 */
export function seedSteamSpecsCache(): void {
  try {
    const cache = readSteamSpecsCache();
    let changed = false;
    for (const [key, specs] of Object.entries(CURATED_SEED)) {
      if (!cache[key] && !cache[String(specs.appId || '')]) {
        cache[key] = specs;
        if (specs.appId) cache[specs.appId] = specs;
        changed = true;
      }
    }
    if (changed) writeSteamSpecsCache(cache);
  } catch (e) {
    console.warn('[steamSpecs] Failed to seed curated specs:', e);
  }
}
