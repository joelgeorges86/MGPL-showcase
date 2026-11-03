import axios from "axios";
import path from "path";
import fs from "fs";

export interface NexusStats {
  modCount: number;
  collectionCount: number;
  hasCollections: boolean;
  topCollections: Array<any>;
}

function normNexusTitle(str: string): string {
  if (!str) return "";
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripNexusEditions(normStr: string): string {
  return normStr
    .replace(
      /(goty|gameoftheyearedition|gameoftheyear|definitiveedition|enhancededition|specialedition|remastered|anniversaryedition|deluxeedition|ultimateedition)/g,
      "",
    )
    .trim();
}

/**
 * Normalizes title to a valid Nexus Mods domain slug.
 */
export function getDomainSlugForTitle(title: string): string | null {
  if (!title) return null;
  const cacheDir = path.join(process.cwd(), "scripts", ".cache");
  const nexusGamesPath = path.join(cacheDir, "nexus_games.json");
  if (fs.existsSync(nexusGamesPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(nexusGamesPath, "utf8"));
      if (Array.isArray(list)) {
        const norm = normNexusTitle(title);
        const strippedNorm = stripNexusEditions(norm);

        for (const g of list) {
          if (!g || !g.name || !g.domain_name) continue;
          const gNorm = normNexusTitle(g.name);
          if (gNorm === norm) return g.domain_name;
        }

        for (const g of list) {
          if (!g || !g.name || !g.domain_name) continue;
          const gNorm = normNexusTitle(g.name);
          if (stripNexusEditions(gNorm) === strippedNorm && strippedNorm.length > 0)
            return g.domain_name;
        }
      }
    } catch (e) {
      // Ignore cache parse failure
    }
  }

  // Fallback slug cleanup
  const clean = title.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean || null;
}

export async function getNexusStats(gameId: string | number, title: string): Promise<NexusStats> {
  const cacheDir = path.join(process.cwd(), "scripts", ".cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const statsCachePath = path.join(cacheDir, "nexus_stats.json");

  let statsCache: Record<string, NexusStats> = {};
  if (fs.existsSync(statsCachePath)) {
    try {
      statsCache = JSON.parse(fs.readFileSync(statsCachePath, "utf8"));
    } catch (e) {
      statsCache = {};
    }
  }

  const cacheKey = String(gameId);
  if (statsCache[cacheKey]) {
    return statsCache[cacheKey];
  }

  const domainSlug = getDomainSlugForTitle(title);
  if (!domainSlug) {
    const result: NexusStats = {
      modCount: 0,
      collectionCount: 0,
      hasCollections: false,
      topCollections: [],
    };
    statsCache[cacheKey] = result;
    fs.writeFileSync(statsCachePath, JSON.stringify(statsCache, null, 2));
    return result;
  }

  const apiKey = process.env.NEXUSMODS_API_KEY;
  if (!apiKey) {
    // Check nexus_detail.json cache before failing
    const detailCachePath = path.join(cacheDir, "nexus_detail.json");
    if (fs.existsSync(detailCachePath)) {
      try {
        const detailCache = JSON.parse(fs.readFileSync(detailCachePath, "utf8"));
        if (detailCache[domainSlug]) {
          const d = detailCache[domainSlug];
          const modCount = d.mods || d.mods_count || 0;
          const result: NexusStats = {
            modCount,
            collectionCount: 0,
            hasCollections: false,
            topCollections: [],
          };
          statsCache[cacheKey] = result;
          fs.writeFileSync(statsCachePath, JSON.stringify(statsCache, null, 2));
          return result;
        }
      } catch (e) {
        /* continue */
      }
    }

    const defaultResult: NexusStats = {
      modCount: 0,
      collectionCount: 0,
      hasCollections: false,
      topCollections: [],
    };
    return defaultResult;
  }

  let modCount = 0;
  let collectionCount = 0;

  try {
    const gameRes = await axios.get<any>(`https://api.nexusmods.com/v1/games/${domainSlug}.json`, {
      headers: { apikey: apiKey, Accept: "application/json", "User-Agent": "MGPL/1.0" },
      timeout: 8000,
    });
    if (gameRes.data) {
      if (typeof gameRes.data.mods === "number") {
        modCount = gameRes.data.mods;
      }
      if (typeof gameRes.data.collections === "number") {
        collectionCount = gameRes.data.collections;
      }
    }
  } catch (err) {
    // Ignore API errors gracefully
  }

  const result: NexusStats = {
    modCount,
    collectionCount,
    hasCollections: collectionCount > 0,
    topCollections: [],
  };

  statsCache[cacheKey] = result;
  fs.writeFileSync(statsCachePath, JSON.stringify(statsCache, null, 2));

  return result;
}
