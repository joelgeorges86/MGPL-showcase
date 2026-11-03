import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sanitizeModSourceUrl, sanitizeModUrl } from '../middleware/modUrlSanitizer';
import { getModsAggregationStatus } from '../jobs/mod-aggregation';
import { sendApiError } from '../middleware/errorSanitizer';
import { safeCoerce } from '../utils/ingest';
import {
  validateModMetadata,
  maskModAuthorHandle,
  sanitizeModDescription,
} from '../utils/modSchema';
import {
  detectFileConflicts,
  getDependencyTree,
  getLoadOrder,
  getModDetail,
  saveLoadOrder,
} from '../services/modManager';

const router = Router();

interface MockMod {
  modId: string;
  modName: string;
  author: string;
  downloads: number;
  version: string;
  minVramGb: number;
  minRamGb: number;
  description: string;
  category: string;
  provider: string;   // Nexus Mods | ModDB | CurseForge | GitHub | Modrinth
  sourceUrl: string;  // approved whitelisted https URL (see modUrlSanitizer)
}

// Mock mod database per game domain for fast, deterministic & fallback
// execution. Every entry carries an approved multi-site provider (Nexus Mods,
// ModDB, CurseForge, GitHub Releases, Modrinth) plus a whitelisted sourceUrl
// so the client can always render safe outbound links.
const MOCK_MODS: Record<string, MockMod[]> = {
  skyrimspecialedition: [
    { modId: '101', modName: 'SkyUI 5.2', author: 'skyui_team', downloads: 14200000, version: '5.2SE', minVramGb: 2, minRamGb: 8, description: 'Elegant, PC-friendly interface with advanced filtering and search.', category: 'UI', provider: 'Nexus Mods', sourceUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/3863' },
    { modId: '102', modName: 'Skyrim Script Extender (SKSE64)', author: 'ianpatt', downloads: 19800000, version: '2.2.3', minVramGb: 2, minRamGb: 8, description: 'Core script extension utility required for advanced Skyrim modding.', category: 'Framework', provider: 'GitHub', sourceUrl: 'https://github.com/ianpatt/skse64/releases' },
    { modId: '103', modName: '2K/4K Texture Overhaul Ultra', author: 'Pfuscher', downloads: 8500000, version: '1.8', minVramGb: 8, minRamGb: 16, description: 'Photorealistic textures for architecture, landscapes, and weather.', category: 'Visuals', provider: 'Nexus Mods', sourceUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/5754' },
    { modId: '104', modName: 'Community Shaders & Parallax', author: 'doodlez', downloads: 3400000, version: '0.8.1', minVramGb: 6, minRamGb: 16, description: 'Modern rendering engine featuring real-time parallax mapping and SSR.', category: 'Visuals', provider: 'Modrinth', sourceUrl: 'https://modrinth.com/mod/community-shaders' },
    { modId: '105', modName: 'Skyrim Soundtrack Overhaul', author: 'audio_works', downloads: 2100000, version: '2.0', minVramGb: 2, minRamGb: 8, description: 'Dramatic re-scoring of the soundtrack for ambient depth.', category: 'Audio', provider: 'ModDB', sourceUrl: 'https://www.moddb.com/mods/skyrim-soundtrack-overhaul' },
    { modId: '106', modName: 'Cooking & Alchemy Overhaul', author: 'forge_master', downloads: 1500000, version: '1.4', minVramGb: 4, minRamGb: 8, description: 'Deepens survival crafting and reagent economy.', category: 'Gameplay', provider: 'CurseForge', sourceUrl: 'https://www.curseforge.com/skyrim/special-edition/cooking-alchemy-overhaul' }
  ],
  cyberpunk2077: [
    { modId: '201', modName: 'Cyber Engine Tweaks (CET)', author: 'yamashi', downloads: 12500000, version: '1.30.1', minVramGb: 6, minRamGb: 16, description: 'Performance fixes, lua scripting engine, and dev console overlay.', category: 'Framework', provider: 'GitHub', sourceUrl: 'https://github.com/yamashi/CyberEngineTweaks/releases' },
    { modId: '202', modName: 'REDscript Framework', author: 'jacobsen', downloads: 9800000, version: '0.5.18', minVramGb: 6, minRamGb: 16, description: 'Compiler/decompiler framework powering custom redscript mods.', category: 'Framework', provider: 'Nexus Mods', sourceUrl: 'https://www.nexusmods.com/cyberpunk2077/mods/1511' },
    { modId: '203', modName: 'HD Reworked Project 2077', author: 'HalkHogan', downloads: 4100000, version: '2.1', minVramGb: 10, minRamGb: 32, description: 'High-detail 4K mesh & texture overhaul across Night City.', category: 'Visuals', provider: 'Nexus Mods', sourceUrl: 'https://www.nexusmods.com/cyberpunk2077/mods/765' },
    { modId: '204', modName: 'Nova City Lighting & Weather Overhaul', author: 'Cyanide', downloads: 2100000, version: '1.4', minVramGb: 8, minRamGb: 16, description: 'Enhanced ray-tracing lighting tones, volumetric fog, and storm effects.', category: 'Visuals', provider: 'Modrinth', sourceUrl: 'https://modrinth.com/mod/nova-city-lighting' },
    { modId: '205', modName: 'Night City Traffic & Pedestrian Density', author: 'city_lab', downloads: 1300000, version: '1.2', minVramGb: 6, minRamGb: 16, description: 'Raises street traffic and pedestrian counts for a living metropolis.', category: 'Gameplay', provider: 'ModDB', sourceUrl: 'https://www.moddb.com/mods/night-city-traffic' },
    { modId: '206', modName: 'Immersion Reborn: Life Path Dialogue', author: 'narrative_team', downloads: 860000, version: '0.9', minVramGb: 4, minRamGb: 12, description: 'Adds branching life-path flavored dialogue trees.', category: 'Gameplay', provider: 'CurseForge', sourceUrl: 'https://www.curseforge.com/cyberpunk2077/immersion-reborn' }
  ],
  witcher3: [
    { modId: '301', modName: 'The Witcher 3 HD Reworked Project Next-Gen', author: 'HalkHogan', downloads: 11200000, version: '12.0', minVramGb: 6, minRamGb: 16, description: 'Top-tier texture & model quality improvements preserving original art style.', category: 'Visuals', provider: 'Nexus Mods', sourceUrl: 'https://www.nexusmods.com/witcher3/mods/1021' },
    { modId: '302', modName: 'Script GUI Fixer & Mod Limit Adjuster', author: 'Aserius', downloads: 6700000, version: '1.2', minVramGb: 4, minRamGb: 8, description: 'Removes structural mod count limits and resolves UI script conflicts.', category: 'Framework', provider: 'GitHub', sourceUrl: 'https://github.com/witcher3-mods/script-gui-fixer/releases' },
    { modId: '303', modName: 'Ghost Mode & Combat Overhaul', author: 'WastelandGhost', downloads: 1900000, version: '4.4', minVramGb: 4, minRamGb: 8, description: 'Complete rebalance of stamina, alchemy, leveling, and enemy AI.', category: 'Gameplay', provider: 'Nexus Mods', sourceUrl: 'https://www.nexusmods.com/witcher3/mods/1179' },
    { modId: '304', modName: 'Geralt Appearance & Armor Retextures', author: 'wardrobe_team', downloads: 1500000, version: '3.0', minVramGb: 4, minRamGb: 8, description: 'Expanded wardrobe retextures for armors and casual outfits.', category: 'Visuals', provider: 'CurseForge', sourceUrl: 'https://www.curseforge.com/witcher3/geralt-wardrobe' },
    { modId: '305', modName: 'Toussaint Ambient Weather Reborn', author: 'weather_lab', downloads: 990000, version: '1.1', minVramGb: 4, minRamGb: 8, description: 'Cinematic weather variety across Toussaint and Velen.', category: 'Visuals', provider: 'Modrinth', sourceUrl: 'https://modrinth.com/mod/toussaint-weather' },
    { modId: '306', modName: 'Enhanced Horse & Mount Mechanics', author: 'stable_hand', downloads: 720000, version: '2.2', minVramGb: 2, minRamGb: 8, description: 'Responsive horse control, stamina tuning, and gallop overhaul.', category: 'Gameplay', provider: 'ModDB', sourceUrl: 'https://www.moddb.com/mods/enhanced-horse-mechanics' }
  ]
};

/**
 * Sprint 6.1 (GAP-003): read-time revalidation of a persisted mod sourceUrl.
 * Re-runs the v1.0 whitelist sanitizer so stale/non-compliant links are never
 * served to the client. Invalid links resolve to null (the client hides them).
 */
function revalidateModSourceUrl(url: unknown): { valid: boolean; url: string | null; domain: string | null } {
  const result = sanitizeModUrl(url);
  if (result.valid) {
    return { valid: true, url: result.url, domain: result.domain };
  }
  return { valid: false, url: null, domain: null };
}

// GET /api/mods/trending?game=skyrimspecialedition
// Sprint 6.1 (GAP-003/004): primary source is the active persisted catalog
// ranked by downloads. When no rows match the requested game domain, fall back
// to the "Most Recently Added" active rows, then finally to the deterministic
// mock set. Downloads/metadata counts are normalized to non-null values.
router.get('/trending', (req: Request, res: Response) => {
  const gameDomain = ((req.query.game as string) || 'skyrimspecialedition').toLowerCase().trim();

  let mods: any[] = [];
  let source = 'mock';
  let fallbackReason: string | null = null;

  try {
    const activeRows = db
      .prepare('SELECT * FROM Mods WHERE is_active = 1 ORDER BY downloads DESC, id ASC LIMIT 20')
      .all() as any[];

    const domainRows = activeRows.filter(
      (r) => String(r.gameId || '').toLowerCase() === gameDomain,
    );

    if (domainRows.length > 0) {
      mods = domainRows.slice(0, 10);
      source = 'catalog';
    } else if (activeRows.length > 0) {
      const recent = db
        .prepare('SELECT * FROM Mods WHERE is_active = 1 ORDER BY createdAt DESC, id DESC LIMIT 10')
        .all() as any[];
      if (recent.length > 0) {
        mods = recent;
        source = 'most-recently-added';
        fallbackReason = 'most-recently-added';
      }
    }
  } catch (e) {
    console.warn('[mods] Trending catalog read failed, using mock fallback:', e);
  }

  if (mods.length === 0) {
    mods = (MOCK_MODS[gameDomain] || MOCK_MODS['skyrimspecialedition']).slice();
    source = 'mock';
    fallbackReason = 'mock-fallback';
  }

  const normalized = mods.map((m) => {
    const revalidated = revalidateModSourceUrl(m.sourceUrl);
    const downloads = Number(m.downloads);
    return {
      modId: m.modId != null ? String(m.modId) : String(m.id != null ? m.id : ''),
      modName: m.modName != null ? String(m.modName) : String(m.name || 'Unknown Mod'),
      author: m.author != null ? String(m.author) : 'Unknown',
      downloads: Number.isFinite(downloads) && downloads >= 0 ? downloads : 0,
      version: m.version != null ? String(m.version) : '1.0.0',
      minVramGb: m.minVramGb != null ? Number(m.minVramGb) : 0,
      minRamGb: m.minRamGb != null ? Number(m.minRamGb) : 0,
      description:
        m.description != null
          ? String(m.description)
          : m.summary != null
            ? String(m.summary)
            : 'No description provided.',
      summary:
        m.summary != null
          ? String(m.summary)
          : m.description != null
            ? String(m.description)
            : 'No description provided.',
      provider: m.provider != null ? String(m.provider) : null,
      category: m.category != null ? String(m.category) : 'General',
      sourceUrl: revalidated.valid ? revalidated.url : null,
      sourceDomain: revalidated.valid ? revalidated.domain : null,
      linkValid: revalidated.valid,
    };
  });

  res.json({ gameDomain, count: normalized.length, source, fallbackReason, mods: normalized });
});

// GET /api/mods/search?q=skyui&game=skyrimspecialedition
router.get('/search', (req: Request, res: Response) => {
  const query = ((req.query.q as string) || '').toLowerCase().trim();
  const gameDomain = ((req.query.game as string) || '').toLowerCase().trim();

  let pool: Array<{ modId: string; modName: string; author: string; downloads: number; version: string; minVramGb: number; minRamGb: number; description: string }> = [];
  if (gameDomain && MOCK_MODS[gameDomain]) {
    pool = MOCK_MODS[gameDomain];
  } else {
    Object.values(MOCK_MODS).forEach(list => {
      pool = pool.concat(list);
    });
  }

  if (query) {
    pool = pool.filter(m => m.modName.toLowerCase().includes(query) || m.author.toLowerCase().includes(query) || m.description.toLowerCase().includes(query));
  }

  res.json({ query, count: pool.length, mods: pool });
});

// GET /api/mods/installed
router.get('/installed', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare('SELECT * FROM InstalledMods ORDER BY installedAt DESC').all();
    res.json({ count: rows.length, installedMods: rows });
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to fetch installed mods', undefined, {
      includeSuccess: false,
    });
  }
});

// POST /api/mods/installed
router.post('/installed', (req: Request, res: Response) => {
  const { modId, gameDomain, modName, version } = req.body;
  if (!modId || !gameDomain || !modName) {
    return res.status(400).json({ error: 'modId, gameDomain, and modName are required fields.' });
  }

  try {
    const existing = db.prepare('SELECT * FROM InstalledMods WHERE modId = ? AND gameDomain = ?').get(String(modId), String(gameDomain));

    if (existing) {
      db.prepare('DELETE FROM InstalledMods WHERE modId = ? AND gameDomain = ?').run(String(modId), String(gameDomain));
      // Sprint 4 (EPICUX04): deactivate the load-order slot when a mod is
      // untracked (row is preserved for history; re-install reactivates it).
      try {
        db.prepare(
          'UPDATE ModLoadOrder SET isActive = 0, updatedAt = CURRENT_TIMESTAMP WHERE gameDomain = ? AND modId = ?',
        ).run(String(gameDomain), String(modId));
      } catch (e) {
        console.warn('[mods] Load-order deactivate skipped:', e);
      }
      return res.json({ success: true, installed: false, status: 'removed', modId, gameDomain });
    } else {
      const stmt = db.prepare(`
        INSERT INTO InstalledMods (modId, gameDomain, modName, version)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(String(modId), String(gameDomain), String(modName), version || '1.0');
      // Sprint 4 (EPICUX04): reactivate/append the load-order slot so the Load
      // Order Manager always reflects the tracked/installed set.
      try {
        db.prepare(`
          INSERT INTO ModLoadOrder (gameDomain, modId, position, isActive, updatedAt)
          VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM ModLoadOrder WHERE gameDomain = ?), 1, CURRENT_TIMESTAMP)
          ON CONFLICT(gameDomain, modId) DO UPDATE SET isActive = 1, updatedAt = CURRENT_TIMESTAMP
        `).run(String(gameDomain), String(modId), String(gameDomain));
      } catch (e) {
        console.warn('[mods] Load-order activate skipped:', e);
      }
      return res.json({ success: true, installed: true, status: 'installed', modId, gameDomain, modName, version: version || '1.0' });
    }
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Database error handling mod installation', undefined, {
      includeSuccess: false,
    });
  }
});

// GET /api/mods/compatibility?vramGb=8&ramGb=16
router.get('/compatibility', (req: Request, res: Response) => {
  const vramGb = Number(req.query.vramGb) || 8;
  const ramGb = Number(req.query.ramGb) || 16;

  res.json({
    activeTargetHardware: { vramGb, ramGb },
    evaluation: {
      lightMods: { status: 'OPTIMAL', recommendedVramGb: 4, recommendedRamGb: 8 },
      texture4kMods: {
        status: vramGb >= 8 && ramGb >= 16 ? 'COMPATIBLE' : 'HIGH_VRAM_USAGE',
        recommendedVramGb: 8,
        recommendedRamGb: 16
      },
      rayTracingShaders: {
        status: vramGb >= 10 && ramGb >= 32 ? 'COMPATIBLE' : 'VRAM_BOTTLENECK',
        recommendedVramGb: 10,
        recommendedRamGb: 32
      }
    }
  });
});

// GET /api/mods/aggregation/status
// Sprint 6.1 (GAP-003): mods aggregation health — the client polls this to warn
// operators (admin toast) when the aggregation job has stalled >24h.
router.get('/aggregation/status', (_req: Request, res: Response) => {
  res.json(getModsAggregationStatus());
});

// ---------------------------------------------------------------------------
// Sprint 7 (WUD-7.4): Approved mod provider home links + legal disclaimer.
// The client renders these through the exact-match HTTPS host whitelist
// (safeModUrl / safeProviderHomeUrl) — these constants are the server-side
// source of truth so outbound links are always vetted.
// ---------------------------------------------------------------------------
const MOD_PROVIDER_LINKS: ReadonlyArray<{ name: string; domain: string; url: string }> = [
  { name: 'Nexus Mods', domain: 'nexusmods.com', url: 'https://www.nexusmods.com/' },
  { name: 'ModDB', domain: 'moddb.com', url: 'https://www.moddb.com/' },
  { name: 'CurseForge', domain: 'curseforge.com', url: 'https://www.curseforge.com/' },
  { name: 'GitHub', domain: 'github.com', url: 'https://github.com/' },
  { name: 'Modrinth', domain: 'modrinth.com', url: 'https://modrinth.com/' },
];

const MODDING_DISCLAIMER =
  'Modding is done entirely at your own risk. Third-party mods are not endorsed by game ' +
  'developers or publishers, may conflict with game updates, anti-cheat systems, or the ' +
  'terms of service of the game and the modding platform, and could affect game stability, ' +
  'saved games, or online play. Always read each mod\'s requirements and back up your saves ' +
  'before installing. MGPL links only to the approved provider platforms above.';

// GET /api/mods/providers
// Server-authoritative provider whitelist + legal disclaimer for the Mods Hub.
router.get('/providers', (_req: Request, res: Response) => {
  res.json({
    success: true,
    providers: MOD_PROVIDER_LINKS.map((p) => ({ name: p.name, domain: p.domain, url: p.url })),
    disclaimer: MODDING_DISCLAIMER,
  });
});

// GET /api/mods/detail?game=cyberpunk2077&modId=201
// Sprint 4 (EPICUX04): comprehensive mod detail payload — description, masked
// author profile, stats bar, version history, dependencies and the structured
// dependency tree. All outbound URLs re-run the exact-match whitelist and all
// text passes the shared sanitizers before it reaches the client.
router.get('/detail', (req: Request, res: Response) => {
  const gameDomain = ((req.query.game as string) || '').toLowerCase().trim();
  const modId = (req.query.modId as string || '').trim();
  if (!gameDomain || !modId) {
    return res.status(400).json({ error: 'game and modId query parameters are required.' });
  }
  try {
    const detail = getModDetail(db, gameDomain, modId);
    if (!detail) {
      return res.status(404).json({ error: 'Mod not found.' });
    }
    res.json(detail);
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to load mod details', undefined, { includeSuccess: false });
  }
});

// GET /api/mods/dependencies?game=cyberpunk2077&modId=202
// Sprint 4 (EPICUX04): structured dependency tree for a mod.
router.get('/dependencies', (req: Request, res: Response) => {
  const gameDomain = ((req.query.game as string) || '').toLowerCase().trim();
  const modId = (req.query.modId as string || '').trim();
  if (!gameDomain || !modId) {
    return res.status(400).json({ error: 'game and modId query parameters are required.' });
  }
  try {
    const tree = getDependencyTree(db, gameDomain, modId);
    if (!tree || tree.length === 0) {
      return res.status(404).json({ error: 'Mod not found.' });
    }
    res.json({ gameDomain, modId, dependencyTree: tree });
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to load mod dependencies', undefined, { includeSuccess: false });
  }
});

// GET /api/mods/conflicts?game=cyberpunk2077&modIds=203,204
// Sprint 4 (EPICUX04): automated file-level conflict detection. With no
// modIds parameter the active installed set for the domain is analyzed.
router.get('/conflicts', (req: Request, res: Response) => {
  const gameDomain = ((req.query.game as string) || '').toLowerCase().trim();
  if (!gameDomain) {
    return res.status(400).json({ error: 'game query parameter is required.' });
  }
  const modIds = String(req.query.modIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  try {
    const report = detectFileConflicts(db, gameDomain, modIds);
    res.json(report);
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to detect mod conflicts', undefined, { includeSuccess: false });
  }
});

// GET /api/mods/load-order?game=cyberpunk2077
// Sprint 4 (EPICUX04): read the persisted load order for a game domain.
router.get('/load-order', (req: Request, res: Response) => {
  const gameDomain = ((req.query.game as string) || '').toLowerCase().trim();
  if (!gameDomain) {
    return res.status(400).json({ error: 'game query parameter is required.' });
  }
  try {
    const order = getLoadOrder(db, gameDomain);
    res.json({ gameDomain, count: order.length, loadOrder: order });
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to load load order', undefined, { includeSuccess: false });
  }
});

// PUT /api/mods/load-order  { gameDomain, orderedModIds: string[] }
// Sprint 4 (EPICUX04): persist a reordered load order instantly to SQLite.
// Accepts only a non-empty ordered array of modIds for the domain.
router.put('/load-order', (req: Request, res: Response) => {
  const body = safeCoerce.obj(req.body);
  const gameDomain = safeCoerce.str(body.gameDomain).toLowerCase().trim();
  const orderedModIds = Array.isArray(body.orderedModIds)
    ? (body.orderedModIds as unknown[])
        .map((id) => safeCoerce.str(id).trim())
        .filter((id) => id.length > 0)
    : [];
  if (!gameDomain || orderedModIds.length === 0) {
    return res.status(400).json({
      error: 'gameDomain and a non-empty orderedModIds array are required.',
    });
  }
  try {
    const order = saveLoadOrder(db, gameDomain, orderedModIds);
    res.json({ success: true, gameDomain, count: order.length, loadOrder: order });
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to save load order', undefined, { includeSuccess: false });
  }
});


/** Official compatibility tags for a verified mod source domain (read-time). */
function compatTagsFor(sourceDomain: string | null): string[] {
  const map: Record<string, string> = {
    'nexusmods.com': 'Nexus Mods',
    'moddb.com': 'ModDB',
    'curseforge.com': 'CurseForge',
    'github.com': 'GitHub Releases',
    'modrinth.com': 'Modrinth',
  };
  const provider = sourceDomain ? map[String(sourceDomain).toLowerCase()] : null;
  return provider ? [`${provider} verified`] : [];
}

// GET /api/mods/listings?game=G00001
// Sprint 5 (EPIC-06): reads the sanitized, persisted mod catalog.
// Sprint 6.1 (GAP-001/GAP-003): read-time domain whitelist enforcement + URL
// re-sanitization; inactive (swept) records are suppressed from listings.
// Sprint 2 (WUD-2.3 / EPICSEC05): every listing returns a script-injection-
// sanitized description and a MASKED author handle so external profile handles
// are never exposed, plus official compatibility tags.
router.get('/listings', (req: Request, res: Response) => {
  try {
    const game = String(req.query.game || '').trim();
    const rows = game
      ? db.prepare('SELECT * FROM Mods WHERE gameId = ? AND is_active = 1 ORDER BY downloads DESC LIMIT 200').all(game)
      : db.prepare('SELECT * FROM Mods WHERE is_active = 1 ORDER BY downloads DESC LIMIT 500').all();

    const mods = (rows as any[]).map((r) => {
      const revalidated = revalidateModSourceUrl(r.sourceUrl);
      const downloads = Number(r.downloads);
      return {
        ...r,
        sourceUrl: revalidated.valid ? revalidated.url : null,
        sourceDomain: revalidated.valid ? revalidated.domain : r.sourceDomain != null ? String(r.sourceDomain) : null,
        linkValid: revalidated.valid,
        downloads: Number.isFinite(downloads) && downloads >= 0 ? downloads : 0,
        // WUD-2.3 security surface: sanitized description + masked handle.
        description: sanitizeModDescription(r.description),
        authorHandle: maskModAuthorHandle(r.author_handle ?? r.author),
        compatTags: compatTagsFor(r.sourceDomain),
      };
    });

    res.json({ count: mods.length, mods });
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to list mods', undefined, { includeSuccess: false });
  }
});

// POST /api/mods/ingest
// Sprint 5 (EPIC-06): persists a mod listing ONLY after the exact-match domain
// whitelist + HTTPS sanitization middleware approves the sourceUrl. The
// ingest is idempotent via UNIQUE(gameId, modName, sourceDomain) upsert.
// Sprint 2 (WUD-2.3 / EPICSEC05): strict metadata schema validation —
// download_count/active_installs/rating_count are non-negative integers,
// version_tag is a strict slug, author_handle is stored MASKED, and the
// description is script-injection-sanitized before persistence.
router.post('/ingest', sanitizeModSourceUrl, (req: Request, res: Response) => {
  // Sprint 1A (EPICSEC01): hydrate the raw body through the unified coercion
  // helpers so malformed payloads resolve to safe fallbacks instead of nulls
  // or partial submissions.
  const body = safeCoerce.obj(req.body);
  const gameId = safeCoerce.str(body.gameId);
  const modName = safeCoerce.str(body.modName);
  const author = safeCoerce.nullableStr(body.author);
  const downloads = safeCoerce.num(body.downloads);
  const version = safeCoerce.nullableStr(body.version);
  const minVramGb = body.minVramGb === null || body.minVramGb === undefined ? null : safeCoerce.num(body.minVramGb);
  const minRamGb = body.minRamGb === null || body.minRamGb === undefined ? null : safeCoerce.num(body.minRamGb);

  if (!gameId || !modName) {
    return res.status(400).json({ error: 'gameId and modName are required fields.' });
  }

  // Strict metadata contract (WUD-2.3): unknown/negative/oversized fields
  // resolve to safe fallbacks; the author_handle is masked before storage.
  const meta = validateModMetadata(req.body);

  const sourceUrl = res.locals.sanitizedModUrl as string;
  const sourceDomain = res.locals.sanitizedModDomain as string;

  try {
    db.prepare(
      `INSERT INTO Mods (gameId, modName, author, sourceDomain, sourceUrl, downloads, version, minVramGb, minRamGb,
         download_count, active_installs, rating_count, version_tag, author_handle, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(gameId, modName, sourceDomain)
       DO UPDATE SET
         author = excluded.author,
         sourceUrl = excluded.sourceUrl,
         downloads = excluded.downloads,
         version = excluded.version,
         minVramGb = excluded.minVramGb,
         minRamGb = excluded.minRamGb,
         download_count = excluded.download_count,
         active_installs = excluded.active_installs,
         rating_count = excluded.rating_count,
         version_tag = excluded.version_tag,
         author_handle = excluded.author_handle,
         description = excluded.description,
         is_active = 1,
         updatedAt = CURRENT_TIMESTAMP`
    ).run(
      gameId,
      modName,
      author,
      sourceDomain,
      sourceUrl,
      downloads,
      version,
      minVramGb,
      minRamGb,
      meta.downloadCount,
      meta.activeInstalls,
      meta.ratingCount,
      meta.versionTag,
      meta.authorHandle,
      meta.description,
    );
    res.json({
      success: true,
      mod: {
        gameId,
        modName,
        author,
        sourceDomain,
        sourceUrl,
        downloads,
        version,
        authorHandle: meta.authorHandle,
        description: meta.description,
        downloadCount: meta.downloadCount,
        activeInstalls: meta.activeInstalls,
        ratingCount: meta.ratingCount,
        versionTag: meta.versionTag,
      },
    });
  } catch (err: any) {
    // Sprint 1A (EPICSEC04): sanitized error — never leak the raw message.
    sendApiError(res, 500, 'Failed to ingest mod', undefined, { includeSuccess: false });
  }
});

export default router;
