import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sendApiError } from '../middleware/errorSanitizer';
import { safeCoerce } from '../utils/ingest';

const router = Router();

/**
 * Sprint 26 (FEAT-0159) — Retro Gaming Hub: Legal Store Re-releases &
 * Sandboxed Local Runner.
 *
 * GET  /api/retro/catalog  -> indexed classic titles with metadata.
 * GET  /api/retro/systems  -> supported systems + cartridge dump hardware guides.
 * GET  /api/retro/tracking -> user's custom retro tracking entries.
 * POST /api/retro/tracking -> upsert a custom retro tracking entry.
 * DELETE /api/retro/tracking/:id -> remove a custom retro tracking entry.
 *
 * All catalog data is static, curated metadata (no inference). The local runner
 * executes user-provided ROM files entirely client-side in a sandboxed WebAssembly
 * canvas; this server never receives or stores ROM binaries.
 */

interface OfficialSource {
  platform: 'Steam' | 'GOG' | 'PSN' | 'Antstream';
  title: string;
  price?: number;
  url: string;
}

interface EnhancementPatch {
  name: string;
  patchUrl: string;
  description: string;
}

interface CatalogEntry {
  id: string;
  title: string;
  system: 'NES' | 'SNES' | 'Genesis' | 'PS1' | 'GBA' | 'Arcade' | 'Homebrew';
  year: number;
  genre: string;
  officialSources: OfficialSource[];
  enhancementPatches: EnhancementPatch[];
  homebrewUrl?: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Sprint 7 (WUD-7.5): trusted open-source emulator resource links + setup
// video guide. Static HTTPS constants validated against an exact-match host
// whitelist at module load; any invalid entry is dropped (fail-closed).
// ---------------------------------------------------------------------------
const RETRO_RESOURCE_DOMAINS: readonly string[] = [
  'retroarch.com',
  'libretro.com',
  'dolphin-emu.org',
  'pcsx2.net',
  'duckstation.org',
  'mgba.io',
  'mesen.ca',
  'sameboy.github.io',
  'ares-emu.net',
  'youtube.com',
] as const;

function normalizeRetroHost(host: string): string {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/** Fail-closed validator for the static resource constants (defense in depth). */
function isValidRetroResourceUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (!parsed.hostname || parsed.hostname.endsWith('.')) return false;
  return RETRO_RESOURCE_DOMAINS.includes(normalizeRetroHost(parsed.hostname));
}

interface EmulatorResource {
  name: string;
  systems: string;
  url: string;
}

interface SetupGuide {
  title: string;
  description: string;
  embedUrl: string;
  watchUrl: string;
}

const EMULATOR_RESOURCES: EmulatorResource[] = [
  { name: 'RetroArch', systems: 'All-in-one multi-system frontend', url: 'https://www.retroarch.com/' },
  { name: 'Dolphin', systems: 'GameCube / Wii', url: 'https://dolphin-emu.org/' },
  { name: 'PCSX2', systems: 'PlayStation 2', url: 'https://pcsx2.net/' },
  { name: 'DuckStation', systems: 'PlayStation 1', url: 'https://www.duckstation.org/' },
  { name: 'mGBA', systems: 'Game Boy / GBA', url: 'https://mgba.io/' },
  { name: 'Mesen', systems: 'NES / SNES', url: 'https://www.mesen.ca/' },
  { name: 'SameBoy', systems: 'Game Boy / Color', url: 'https://sameboy.github.io/' },
  { name: 'Ares', systems: 'Multi-system (incl. Genesis / Arcade)', url: 'https://ares-emu.net/' },
].filter((r) => isValidRetroResourceUrl(r.url));

// Embedded/linked setup video reference — the official Libretro channel's
// RetroArch uploads playlist embed (sourced from retroarch.com), which always
// resolves to the latest first-party setup/configuration videos.
const SETUP_GUIDE: SetupGuide = {
  title: 'RetroArch setup & configuration videos (official Libretro channel)',
  description: 'First-party RetroArch walkthroughs covering installation, core download and controller configuration.',
  embedUrl: 'https://www.youtube.com/embed?listType=user_uploads&list=Libretro&modestbranding=1&showinfo=0',
  watchUrl: 'https://www.youtube.com/embed?listType=user_uploads&list=Libretro',
};

// Curated catalog of classic titles with legal re-release sources and community
// enhancement patches. URLs point to official storefronts and well-known
// community patch hubs (Romhacking.net, GitHub releases).
const CATALOG: CatalogEntry[] = [
  {
    id: 'sonic-the-hedgehog',
    title: 'Sonic the Hedgehog',
    system: 'Genesis',
    year: 1991,
    genre: 'Platformer',
    description: 'The blue blur\'s iconic 16-bit debut, re-released across modern storefronts.',
    officialSources: [
      { platform: 'Steam', title: 'Sega Genesis Classics', price: 29.99, url: 'https://store.steampowered.com/app/34270/' },
      { platform: 'GOG', title: 'Sega Genesis Classics', price: 29.99, url: 'https://www.gog.com/game/sega_genesis_classics' },
    ],
    enhancementPatches: [
      { name: 'Sonic 1 Forever', patchUrl: 'https://github.com/Eukaryot/sonic1forever', description: 'Community remaster with widescreen, 60fps and restored content.' },
    ],
  },
  {
    id: 'super-mario-bros',
    title: 'Super Mario Bros.',
    system: 'NES',
    year: 1985,
    genre: 'Platformer',
    description: 'The game that defined the platformer genre, available via Nintendo\'s official re-releases.',
    officialSources: [
      { platform: 'PSN', title: 'Super Mario Bros. (NES via Switch Online)', url: 'https://www.nintendo.com/switch/online-service/' },
    ],
    enhancementPatches: [
      { name: 'Super Mario Bros. 35th Anniversary Hack', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community quality-of-life and graphical enhancement hacks.' },
    ],
  },
  {
    id: 'final-fantasy-vii',
    title: 'Final Fantasy VII',
    system: 'PS1',
    year: 1997,
    genre: 'JRPG',
    description: 'The genre-defining JRPG, legally available on modern platforms.',
    officialSources: [
      { platform: 'Steam', title: 'FINAL FANTASY VII', price: 11.99, url: 'https://store.steampowered.com/app/39140/' },
      { platform: 'PSN', title: 'FINAL FANTASY VII', price: 15.99, url: 'https://store.playstation.com/' },
    ],
    enhancementPatches: [
      { name: '7th Heaven Mod Manager', patchUrl: 'https://github.com/tsunamods-codes/7th-Heaven', description: 'Community mod manager enabling HD textures, voice acting and gameplay overhauls.' },
    ],
  },
  {
    id: 'the-legend-of-zelda',
    title: 'The Legend of Zelda',
    system: 'NES',
    year: 1986,
    genre: 'Action-Adventure',
    description: 'The original adventure that launched a legendary franchise.',
    officialSources: [
      { platform: 'PSN', title: 'The Legend of Zelda (NES via Switch Online)', url: 'https://www.nintendo.com/switch/online-service/' },
    ],
    enhancementPatches: [
      { name: 'Zelda 1 Redux', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community bugfix and balance enhancement hack.' },
    ],
  },
  {
    id: 'pokemon-emerald',
    title: 'Pokémon Emerald',
    system: 'GBA',
    year: 2004,
    genre: 'JRPG',
    description: 'The definitive third-generation Pokémon adventure.',
    officialSources: [
      { platform: 'PSN', title: 'Pokémon Emerald (via Switch Online GBA)', url: 'https://www.nintendo.com/switch/online-service/' },
    ],
    enhancementPatches: [
      { name: 'Pokémon Emerald Rogue', patchUrl: 'https://github.com/pret/pokeemerald', description: 'Open-source decompilation enabling community romhacks and quality-of-life patches.' },
    ],
  },
  {
    id: 'pac-man',
    title: 'Pac-Man',
    system: 'Arcade',
    year: 1980,
    genre: 'Arcade',
    description: 'The timeless arcade classic, available on every major storefront.',
    officialSources: [
      { platform: 'Steam', title: 'PAC-MAN', price: 4.99, url: 'https://store.steampowered.com/app/394310/' },
      { platform: 'GOG', title: 'PAC-MAN', price: 4.99, url: 'https://www.gog.com/game/pacman' },
      { platform: 'PSN', title: 'PAC-MAN', price: 4.99, url: 'https://store.playstation.com/' },
    ],
    enhancementPatches: [],
  },
  {
    id: 'celeste-classic',
    title: 'Celeste Classic',
    system: 'Homebrew',
    year: 2018,
    genre: 'Platformer',
    description: 'The free PICO-8 original that spawned the acclaimed full release.',
    officialSources: [
      { platform: 'Steam', title: 'Celeste', price: 19.99, url: 'https://store.steampowered.com/app/504230/' },
    ],
    enhancementPatches: [],
    homebrewUrl: 'https://mattmakesgames.itch.io/celesteclassic',
  },
  {
    id: 'streets-of-rage-2',
    title: 'Streets of Rage 2',
    system: 'Genesis',
    year: 1992,
    genre: 'Beat-em-up',
    description: 'The pinnacle of 16-bit beat-em-ups, legally re-released.',
    officialSources: [
      { platform: 'Steam', title: 'Sega Genesis Classics', price: 29.99, url: 'https://store.steampowered.com/app/34270/' },
      { platform: 'GOG', title: 'Sega Genesis Classics', price: 29.99, url: 'https://www.gog.com/game/sega_genesis_classics' },
    ],
    enhancementPatches: [
      { name: 'Streets of Rage 2 Remake', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community remake with expanded content and modern controls.' },
    ],
  },
  {
    id: 'super-metroid',
    title: 'Super Metroid',
    system: 'SNES',
    year: 1994,
    genre: 'Metroidvania',
    description: 'The genre-defining exploration masterpiece.',
    officialSources: [
      { platform: 'PSN', title: 'Super Metroid (SNES via Switch Online)', url: 'https://www.nintendo.com/switch/online-service/' },
    ],
    enhancementPatches: [
      { name: 'Super Metroid Redux', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community enhancement patch with improved controls and graphics.' },
    ],
  },
  {
    id: 'doom',
    title: 'DOOM',
    system: 'Homebrew',
    year: 1993,
    genre: 'FPS',
    description: 'The legendary FPS, legally available and endlessly moddable.',
    officialSources: [
      { platform: 'Steam', title: 'DOOM', price: 4.99, url: 'https://store.steampowered.com/app/2280/' },
      { platform: 'GOG', title: 'DOOM', price: 4.99, url: 'https://www.gog.com/game/doom' },
    ],
    enhancementPatches: [
      { name: 'GZDoom', patchUrl: 'https://github.com/ZDoom/gzdoom', description: 'Modern source port with enhanced rendering and mod support.' },
    ],
  },
  {
    id: 'chrono-trigger',
    title: 'Chrono Trigger',
    system: 'SNES',
    year: 1995,
    genre: 'JRPG',
    description: 'The timeless time-travel JRPG, legally re-released on modern platforms.',
    officialSources: [
      { platform: 'Steam', title: 'CHRONO TRIGGER', price: 14.99, url: 'https://store.steampowered.com/app/613830/' },
      { platform: 'PSN', title: 'Chrono Trigger (via Switch Online SNES)', url: 'https://www.nintendo.com/switch/online-service/' },
    ],
    enhancementPatches: [
      { name: 'Chrono Trigger + (Restored Content)', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community restoration hack restoring cut content and quality-of-life fixes.' },
    ],
  },
  {
    id: 'sonic-the-hedgehog-2',
    title: 'Sonic the Hedgehog 2',
    system: 'Genesis',
    year: 1992,
    genre: 'Platformer',
    description: 'The blue blur\'s faster, spin-dashing sequel, legally re-released.',
    officialSources: [
      { platform: 'Steam', title: 'Sega Genesis Classics', price: 29.99, url: 'https://store.steampowered.com/app/34270/' },
      { platform: 'GOG', title: 'Sega Genesis Classics', price: 29.99, url: 'https://www.gog.com/game/sega_genesis_classics' },
    ],
    enhancementPatches: [
      { name: 'Sonic 2 Absolute', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community enhancement hack with widescreen and restored content.' },
    ],
  },
  {
    id: 'castlevania-symphony-of-the-night',
    title: 'Castlevania: Symphony of the Night',
    system: 'PS1',
    year: 1997,
    genre: 'Metroidvania',
    description: 'The genre-defining gothic masterpiece, legally available on modern platforms.',
    officialSources: [
      { platform: 'PSN', title: 'Castlevania: Symphony of the Night', price: 9.99, url: 'https://store.playstation.com/' },
    ],
    enhancementPatches: [
      { name: 'Symphony of the Night Restoration', patchUrl: 'https://www.romhacking.net/hacks/1/', description: 'Community restoration patch fixing audio and localization issues.' },
    ],
  },
  {
    id: 'micro-mages',
    title: 'Micro Mages',
    system: 'Homebrew',
    year: 2019,
    genre: 'Platformer',
    description: 'A modern NES homebrew platformer squeezed into a single 40KB cartridge.',
    officialSources: [
      { platform: 'Steam', title: 'Micro Mages', price: 9.99, url: 'https://store.steampowered.com/app/1065620/' },
    ],
    enhancementPatches: [],
    homebrewUrl: 'https://morphcatgames.itch.io/micromages',
  },
];


// Supported systems and their cartridge dump hardware guides. These are
// informational only — users must own the physical media they dump.
const SYSTEMS = [
  {
    system: 'NES',
    label: 'Nintendo Entertainment System',
    dumpHardware: 'Retrode 2',
    dumpGuide: 'https://www.retrode.org/',
    notes: 'The Retrode 2 reads original NES cartridges and dumps them over USB.',
  },
  {
    system: 'SNES',
    label: 'Super Nintendo',
    dumpHardware: 'Retrode 2',
    dumpGuide: 'https://www.retrode.org/',
    notes: 'The Retrode 2 supports SNES cartridges with the appropriate adapter.',
  },
  {
    system: 'Genesis',
    label: 'Sega Genesis / Mega Drive',
    dumpHardware: 'Retrode 2',
    dumpGuide: 'https://www.retrode.org/',
    notes: 'The Retrode 2 reads Genesis cartridges directly.',
  },
  {
    system: 'GBA',
    label: 'Game Boy Advance',
    dumpHardware: 'GBxCart RW',
    dumpGuide: 'https://www.gbxcart.com/',
    notes: 'The GBxCart RW dumps GBA and Game Boy cartridges over USB.',
  },
  {
    system: 'PS1',
    label: 'PlayStation 1',
    dumpHardware: 'xStation / PSIO',
    dumpGuide: 'https://github.com/ramapcsx2/gxstation',
    notes: 'Optical drive emulators like xStation or PSIO load legally dumped disc images.',
  },
  {
    system: 'Arcade',
    label: 'Arcade',
    dumpHardware: 'MAME ROMs',
    dumpGuide: 'https://www.mamedev.org/',
    notes: 'MAME requires legally obtained ROM sets from owned arcade boards.',
  },
  {
    system: 'Homebrew',
    label: 'Homebrew / Indie',
    dumpHardware: 'None required',
    dumpGuide: 'https://itch.io/',
    notes: 'Homebrew and indie titles are distributed digitally and need no dumping.',
  },
];

/**
 * GET /api/retro/catalog
 * Returns the indexed classic titles with legal store sources and patches.
 */
router.get('/catalog', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, catalog: CATALOG });
  } catch (err: any) {
    console.error('Error in /api/retro/catalog:', err?.message || err);
    sendApiError(res, 500, 'Failed to load retro catalog');
  }
});

/**
 * GET /api/retro/systems
 * Returns supported systems and cartridge dump hardware guides.
 */
router.get('/systems', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, systems: SYSTEMS });
  } catch (err: any) {
    console.error('Error in /api/retro/systems:', err?.message || err);
    sendApiError(res, 500, 'Failed to load retro systems');
  }
});

/**
 * GET /api/retro/resources
 * Sprint 7 (WUD-7.5): trusted open-source emulator homepages + an embedded
 * setup video guide reference. Static, whitelist-validated HTTPS constants.
 */
router.get('/resources', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, emulators: EMULATOR_RESOURCES, setupGuide: SETUP_GUIDE });
  } catch (err: any) {
    console.error('Error in /api/retro/resources:', err?.message || err);
    sendApiError(res, 500, 'Failed to load retro resources');
  }
});

/**
 * GET /api/retro/tracking
 * Returns the user's custom retro tracking entries.
 */
router.get('/tracking', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare('SELECT * FROM "AppRetroTracking" ORDER BY updatedAt DESC').all();
    res.json({ success: true, tracking: rows });
  } catch (err: any) {
    console.error('Error in /api/retro/tracking:', err?.message || err);
    sendApiError(res, 500, 'Failed to load retro tracking');
  }
});

/**
 * POST /api/retro/tracking
 * Upserts a custom retro tracking entry keyed on gameTitle.
 */
router.post('/tracking', (req: Request, res: Response) => {
  try {
    // Sprint 1A (EPICSEC01): hydrate the raw body through the unified coercion
    // helpers so malformed payloads resolve to safe fallbacks instead of nulls.
    const body = safeCoerce.obj(req.body);
    const gameTitle = safeCoerce.str(body.gameTitle).trim();
    if (!gameTitle) {
      return res.status(400).json({ success: false, error: 'gameTitle is required.' });
    }

    const system = safeCoerce.nullableStr(body.system);
    const status = safeCoerce.str(body.status) || 'planned';
    const playtimeHours = safeCoerce.num(body.playtimeHours);
    const personalRating =
      body.personalRating === null || body.personalRating === undefined
        ? null
        : safeCoerce.num(body.personalRating);
    const isFavorite = body.isFavorite ? 1 : 0;
    const notes = safeCoerce.nullableStr(body.notes);

    db.prepare(`
      INSERT INTO "AppRetroTracking" (gameTitle, system, status, playtimeHours, personalRating, isFavorite, notes, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(gameTitle) DO UPDATE SET
        system = excluded.system,
        status = excluded.status,
        playtimeHours = excluded.playtimeHours,
        personalRating = excluded.personalRating,
        isFavorite = excluded.isFavorite,
        notes = excluded.notes,
        updatedAt = CURRENT_TIMESTAMP
    `).run(gameTitle, system, status, playtimeHours, personalRating, isFavorite, notes);

    const row = db.prepare('SELECT * FROM "AppRetroTracking" WHERE gameTitle = ?').get(gameTitle);
    res.json({ success: true, tracking: row });
  } catch (err: any) {
    console.error('Error in POST /api/retro/tracking:', err?.message || err);
    sendApiError(res, 500, 'Failed to save retro tracking entry');
  }
});

/**
 * DELETE /api/retro/tracking/:id
 * Removes a custom retro tracking entry by id.
 */
router.delete('/tracking/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid tracking id.' });
    }
    const result = db.prepare('DELETE FROM "AppRetroTracking" WHERE id = ?').run(id);
    res.json({ success: true, deleted: result.changes > 0 });
  } catch (err: any) {
    console.error('Error in DELETE /api/retro/tracking/:id:', err?.message || err);
    sendApiError(res, 500, 'Failed to delete retro tracking entry');
  }
});

export default router;
