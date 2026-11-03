/**
 * Sprint 4 (EPICUX04) — Mods Hub 2.0 Mod Manager Service.
 *
 * Deterministic domain + conflict-detection + load-order engine for the Mods
 * Hub. Every known mod domain carries a rich, static manifest (long
 * description, masked author profile, stats, version history, dependency
 * edges and file-level manifests) so detail pages, dependency trees and
 * conflict warnings render instantly without a live external API.
 *
 * Security contract (EPICSEC01/02/05):
 *   - Every outbound `sourceUrl` is re-run through `sanitizeModUrl()` so only
 *     the exact-match HTTPS whitelist domains are ever served to the client.
 *   - Author handles are masked via `maskModAuthorHandle()` (privacy-minimized).
 *   - Descriptions / changelogs are script-injection-stripped via
 *     `sanitizeModDescription()`.
 *   - Error text passes through `safeErrorMessage()` — never raw internals.
 *
 * Persistence: `ModVersions`, `ModDependencies` and `ModLoadOrder` are seeded
 * idempotently (INSERT OR IGNORE) from this manifest on every boot via
 * `ensureModHubSeed()`, and the load order is user-editable (SQLite-backed,
 * registered in src/routes/state.ts for snapshot round-trip).
 */
import { Database as DatabaseType } from 'better-sqlite3';
import { sanitizeModUrl } from '../middleware/modUrlSanitizer';
import { safeErrorMessage } from '../utils/errorSanitizer';
import {
  maskModAuthorHandle,
  sanitizeModDescription,
} from '../utils/modSchema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModVersionEntry {
  version: string;
  changelog: string | null;
  releasedAt: string | null;
}

export interface ModDependencyEdge {
  dependsOn: string;
  modName: string | null;
  isHard: boolean;
  filePaths: string[];
}

export interface ModAuthorProfile {
  /** Masked handle — never the raw external profile handle. */
  handle: string | null;
  memberSince: string | null;
  totalMods: number;
  totalDownloads: number;
}

export interface DependencyNode {
  modId: string;
  modName: string;
  isHard: boolean;
  depth: number;
  children: DependencyNode[];
}

export interface ModDetail {
  gameDomain: string;
  modId: string;
  modName: string;
  author: ModAuthorProfile;
  category: string;
  provider: string;
  sourceUrl: string | null;
  sourceDomain: string | null;
  linkValid: boolean;
  downloads: number;
  activeInstalls: number;
  ratingCount: number;
  version: string;
  minVramGb: number | null;
  minRamGb: number | null;
  description: string | null;
  longDescription: string | null;
  screenshots: string[];
  files: string[];
  stats: {
    downloads: number;
    activeInstalls: number;
    rating: number;
    downloadsLabel: string;
    installsLabel: string;
  };
  versionHistory: ModVersionEntry[];
  dependencies: ModDependencyEdge[];
  dependencyTree: DependencyNode[];
  installed: boolean;
  isActive: boolean;
}

export interface ModConflict {
  type: 'file' | 'missing-dependency';
  modA: string;
  modAName: string;
  modB: string | null;
  modBName: string | null;
  filePaths: string[];
  message: string;
}

export interface ModConflictReport {
  gameDomain: string;
  checkedModIds: string[];
  conflictCount: number;
  conflicts: ModConflict[];
}

export interface LoadOrderEntry {
  modId: string;
  modName: string;
  position: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Static manifest types & constants
// ---------------------------------------------------------------------------

interface ManifestDependency {
  dependsOn: string;
  isHard: boolean;
  filePaths?: string[];
}

interface ManifestVersion {
  version: string;
  changelog: string;
  releasedAt: string;
}

interface ManifestMod {
  modId: string;
  modName: string;
  author: string;
  category: string;
  provider: string;
  sourceUrl: string;
  downloads: number;
  activeInstalls: number;
  ratingCount: number;
  version: string;
  minVramGb: number;
  minRamGb: number;
  summary: string;
  longDescription: string;
  authorMemberSince: string;
  authorTotalMods: number;
  files: string[];
  dependencies: ManifestDependency[];
  versionHistory: ManifestVersion[];
  screenshots: string[];
}

const MAX_DEPENDENCY_DEPTH = 5;
const MAX_DEPENDENCY_BRANCH = 8;

function normalizeDomain(domain: string): string {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
}

function normalizeFilePath(p: string): string {
  return String(p || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\/+/, '');
}

function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000000000) return (n / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ---------------------------------------------------------------------------
// Deterministic per-domain manifests. modIds mirror the existing MOCK_MODS so
// trending/search cards and detail pages share one identity space.
// ---------------------------------------------------------------------------
const DOMAIN_MANIFESTS: Record<string, ManifestMod[]> = {
  cyberpunk2077: [
    {
      modId: '201',
      modName: 'Cyber Engine Tweaks (CET)',
      author: 'yamashi',
      category: 'Framework',
      provider: 'GitHub',
      sourceUrl: 'https://github.com/yamashi/CyberEngineTweaks/releases',
      downloads: 12500000,
      activeInstalls: 310000,
      ratingCount: 6400,
      version: '1.30.1',
      minVramGb: 6,
      minRamGb: 16,
      summary: 'Performance fixes, lua scripting engine, and dev console overlay.',
      longDescription:
        'Cyber Engine Tweaks is the backbone framework for Cyberpunk 2077 modding. It ships a scriptable Lua console, a powerful in-game dev overlay, and a suite of performance and stability fixes. Many gameplay and UI mods require CET to load their plugin hooks.',
      authorMemberSince: '2020-12-10',
      authorTotalMods: 3,
      files: ['bin/x64/version.dll', 'bin/x64/global.ini'],
      dependencies: [],
      versionHistory: [
        { version: '1.30.1', changelog: 'Stability fixes for Patch 2.2; updated Lua bindings.', releasedAt: '2025-11-18' },
        { version: '1.29.0', changelog: 'Added input hook API and faster overlay rendering.', releasedAt: '2025-06-02' },
      ],
      screenshots: ['Dev console overlay in-game', 'Lua script editor view'],
    },
    {
      modId: '202',
      modName: 'REDscript Framework',
      author: 'jacobsen',
      category: 'Framework',
      provider: 'Nexus Mods',
      sourceUrl: 'https://www.nexusmods.com/cyberpunk2077/mods/1511',
      downloads: 9800000,
      activeInstalls: 250000,
      ratingCount: 4100,
      version: '0.5.18',
      minVramGb: 6,
      minRamGb: 16,
      summary: 'Compiler/decompiler framework powering custom redscript mods.',
      longDescription:
        'REDscript is the compiler and runtime for custom .reds scripts in Cyberpunk 2077. It is the hard dependency for a large portion of the gameplay mod ecosystem and coexists with Cyber Engine Tweaks as the two core frameworks.',
      authorMemberSince: '2021-02-22',
      authorTotalMods: 5,
      files: ['bin/x64/r6scripts.dll', 'r6/scripts/redscript.rgs'],
      dependencies: [{ dependsOn: '201', isHard: true, filePaths: [] }],
      versionHistory: [
        { version: '0.5.18', changelog: 'Fixed script hot-reload crash on game load.', releasedAt: '2025-12-01' },
        { version: '0.5.17', changelog: 'Added support for archive XL virtual files.', releasedAt: '2025-08-19' },
      ],
      screenshots: ['Compiler console output', 'Modded script running in-game'],
    },
    {
      modId: '203',
      modName: 'HD Reworked Project 2077',
      author: 'HalkHogan',
      category: 'Visuals',
      provider: 'Nexus Mods',
      sourceUrl: 'https://www.nexusmods.com/cyberpunk2077/mods/765',
      downloads: 4100000,
      activeInstalls: 190000,
      ratingCount: 3300,
      version: '2.1',
      minVramGb: 10,
      minRamGb: 32,
      summary: 'High-detail 4K mesh & texture overhaul across Night City.',
      longDescription:
        'Replaces low-resolution meshes and textures across Night City with high-detail 4K assets while preserving the original art direction. Best paired with a 10 GB+ GPU and 32 GB of system RAM.',
      authorMemberSince: '2021-05-30',
      authorTotalMods: 2,
      files: [
        'archive/pc/content/basegame_4k_hlm.archive',
        'archive/pc/content/basegame_4k_environment.archive',
        'archive/pc/patch/hd_reworked_water.archive',
      ],
      dependencies: [],
      versionHistory: [
        { version: '2.1', changelog: 'Adds 4K vegetation and weather-facing textures.', releasedAt: '2025-09-11' },
        { version: '2.0', changelog: 'Rebuilt meshes for Phantom Liberty districts.', releasedAt: '2024-12-05' },
      ],
      screenshots: ['Night City street comparison', 'Interior mesh detail'],
    },
    {
      modId: '204',
      modName: 'Nova City Lighting & Weather Overhaul',
      author: 'Cyanide',
      category: 'Visuals',
      provider: 'Modrinth',
      sourceUrl: 'https://modrinth.com/mod/nova-city-lighting',
      downloads: 2100000,
      activeInstalls: 98000,
      ratingCount: 1700,
      version: '1.4',
      minVramGb: 8,
      minRamGb: 16,
      summary: 'Enhanced ray-tracing lighting tones, volumetric fog, and storm effects.',
      longDescription:
        'A cinematic lighting and weather overhaul that pushes ray-traced reflections, volumetric fog and dynamic storm lighting to their limits. Its core archive overlaps the HD Reworked content archive, so the two cannot run together cleanly.',
      authorMemberSince: '2022-04-17',
      authorTotalMods: 4,
      files: [
        'archive/pc/content/basegame_4k_hlm.archive',
        'archive/pc/patch/nova_lighting.archive',
        'archive/pc/patch/nova_fog.archive',
      ],
      dependencies: [],
      versionHistory: [
        { version: '1.4', changelog: 'Tuned storm frequency and fog density.', releasedAt: '2025-10-27' },
        { version: '1.3', changelog: 'Added RTX HDR bloom presets.', releasedAt: '2025-03-08' },
      ],
      screenshots: ['Night storm over Kabuki', 'Ray-traced reflections'],
    },
    {
      modId: '205',
      modName: 'Night City Traffic & Pedestrian Density',
      author: 'city_lab',
      category: 'Gameplay',
      provider: 'ModDB',
      sourceUrl: 'https://www.moddb.com/mods/night-city-traffic',
      downloads: 1300000,
      activeInstalls: 61000,
      ratingCount: 980,
      version: '1.2',
      minVramGb: 6,
      minRamGb: 16,
      summary: 'Raises street traffic and pedestrian counts for a living metropolis.',
      longDescription:
        'Scales up the ambient traffic and pedestrian simulation so Night City feels dense and alive. Delivered as a CET plugin, so Cyber Engine Tweaks is a hard prerequisite.',
      authorMemberSince: '2023-01-12',
      authorTotalMods: 6,
      files: ['archive/pc/patch/traffic_density.archive', 'bin/x64/plugins/cyber_engine_tweaks/traffic.ini'],
      dependencies: [{ dependsOn: '201', isHard: true, filePaths: [] }],
      versionHistory: [
        { version: '1.2', changelog: 'Fixed taxi spawns at high density settings.', releasedAt: '2025-07-22' },
        { version: '1.1', changelog: 'Added district-specific density presets.', releasedAt: '2024-11-03' },
      ],
      screenshots: ['Dense highway traffic', 'Crowded market district'],
    },
    {
      modId: '206',
      modName: 'Immersion Reborn: Life Path Dialogue',
      author: 'narrative_team',
      category: 'Gameplay',
      provider: 'CurseForge',
      sourceUrl: 'https://www.curseforge.com/cyberpunk2077/immersion-reborn',
      downloads: 860000,
      activeInstalls: 42000,
      ratingCount: 760,
      version: '0.9',
      minVramGb: 4,
      minRamGb: 12,
      summary: 'Adds branching life-path flavored dialogue trees.',
      longDescription:
        'A pure-script mod that injects life-path flavored dialogue branches throughout the main quest. Because it ships as .reds scripts, it requires the REDscript Framework runtime.',
      authorMemberSince: '2023-09-05',
      authorTotalMods: 2,
      files: ['r6/scripts/immersion/dialogue.reds', 'archive/pc/patch/immersion_audio.archive'],
      dependencies: [{ dependsOn: '202', isHard: true, filePaths: [] }],
      versionHistory: [
        { version: '0.9', changelog: 'Initial public release with 120 new dialogue nodes.', releasedAt: '2025-05-30' },
      ],
      screenshots: ['Life path dialogue choices', 'Character sheet flavor'],
    },
  ],
  skyrimspecialedition: [
    {
      modId: '101',
      modName: 'SkyUI 5.2',
      author: 'skyui_team',
      category: 'UI',
      provider: 'Nexus Mods',
      sourceUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/3863',
      downloads: 14200000,
      activeInstalls: 890000,
      ratingCount: 7200,
      version: '5.2SE',
      minVramGb: 2,
      minRamGb: 8,
      summary: 'Elegant, PC-friendly interface with advanced filtering and search.',
      longDescription:
        'SkyUI replaces the console-centric inventory with a fluid PC interface featuring advanced filtering, sorting, favorites and search. It depends on the Skyrim Script Extender to load its MCM pages.',
      authorMemberSince: '2016-10-28',
      authorTotalMods: 8,
      files: ['Data/SkyUI.esp', 'Data/Interface/BookParchment.dds', 'Data/Interface/Inventory.swf'],
      dependencies: [{ dependsOn: '102', isHard: true, filePaths: [] }],
      versionHistory: [
        { version: '5.2SE', changelog: 'Compatibility fixes for the Anniversary Edition runtime.', releasedAt: '2021-11-11' },
        { version: '5.1', changelog: 'Improved favorites menu and search performance.', releasedAt: '2018-04-20' },
      ],
      screenshots: ['Inventory grid with filters', 'Mod Configuration Menu'],
    },
    {
      modId: '102',
      modName: 'Skyrim Script Extender (SKSE64)',
      author: 'ianpatt',
      category: 'Framework',
      provider: 'GitHub',
      sourceUrl: 'https://github.com/ianpatt/skse64/releases',
      downloads: 19800000,
      activeInstalls: 1200000,
      ratingCount: 8600,
      version: '2.2.3',
      minVramGb: 2,
      minRamGb: 8,
      summary: 'Core script extension utility required for advanced Skyrim modding.',
      longDescription:
        'SKSE64 is the essential script extender for Skyrim Special Edition. Hundreds of frameworks and gameplay mods declare it as a hard dependency; it must be installed before any of them will load.',
      authorMemberSince: '2016-10-28',
      authorTotalMods: 4,
      files: ['Data/SKSE/Plugins/SKSE64.dll', 'Data/SKSE/Plugins/versionlib.bin'],
      dependencies: [],
      versionHistory: [
        { version: '2.2.3', changelog: 'Updated for the latest SE runtime build.', releasedAt: '2025-02-14' },
        { version: '2.2.2', changelog: 'Fixed rare crash on cell transition.', releasedAt: '2024-07-30' },
      ],
      screenshots: ['SKSE console output', 'Plugin compatibility check'],
    },
    {
      modId: '103',
      modName: '2K/4K Texture Overhaul Ultra',
      author: 'Pfuscher',
      category: 'Visuals',
      provider: 'Nexus Mods',
      sourceUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/5754',
      downloads: 8500000,
      activeInstalls: 410000,
      ratingCount: 5200,
      version: '1.8',
      minVramGb: 8,
      minRamGb: 16,
      summary: 'Photorealistic textures for architecture, landscapes, and weather.',
      longDescription:
        'A sweeping texture overhaul that upgrades architecture, landscapes and weather surfaces to crisp 2K/4K resolution. Its terrain texture package writes to the same files as the Community Shaders parallax set, making the two mutually exclusive.',
      authorMemberSince: '2017-06-01',
      authorTotalMods: 3,
      files: ['Data/textures/terrain/tamriel/mountains01.dds', 'Data/textures/effects/watercaustics.dds'],
      dependencies: [],
      versionHistory: [
        { version: '1.8', changelog: 'Added 4K weather texture variants.', releasedAt: '2025-08-01' },
        { version: '1.7', changelog: 'Rebuilt mountain parallax maps.', releasedAt: '2023-12-10' },
      ],
      screenshots: ['Mountain pass comparison', 'Storm weather textures'],
    },
    {
      modId: '104',
      modName: 'Community Shaders & Parallax',
      author: 'doodlez',
      category: 'Visuals',
      provider: 'Modrinth',
      sourceUrl: 'https://modrinth.com/mod/community-shaders',
      downloads: 3400000,
      activeInstalls: 230000,
      ratingCount: 2900,
      version: '0.8.1',
      minVramGb: 6,
      minRamGb: 16,
      summary: 'Modern rendering engine featuring real-time parallax mapping and SSR.',
      longDescription:
        'A modern render pipeline for Skyrim SE featuring real-time parallax, screen-space reflections and volumetric lighting. Its terrain textures overlap the 2K/4K Texture Overhaul package, so combining them produces file-level conflicts.',
      authorMemberSince: '2022-08-11',
      authorTotalMods: 7,
      files: [
        'Data/textures/terrain/tamriel/mountains01.dds',
        'Data/textures/effects/watercaustics.dds',
        'Data/Shaders/community.bsl',
      ],
      dependencies: [],
      versionHistory: [
        { version: '0.8.1', changelog: 'Fixed SSR artifacts on water at dawn.', releasedAt: '2025-11-05' },
        { version: '0.8.0', changelog: 'Introduced parallax occlusion mapping.', releasedAt: '2025-04-25' },
      ],
      screenshots: ['Parallax terrain test', 'Reflective water at sunset'],
    },
    {
      modId: '105',
      modName: 'Skyrim Soundtrack Overhaul',
      author: 'audio_works',
      category: 'Audio',
      provider: 'ModDB',
      sourceUrl: 'https://www.moddb.com/mods/skyrim-soundtrack-overhaul',
      downloads: 2100000,
      activeInstalls: 150000,
      ratingCount: 1300,
      version: '2.0',
      minVramGb: 2,
      minRamGb: 8,
      summary: 'Dramatic re-scoring of the soundtrack for ambient depth.',
      longDescription:
        'Replaces the ambient soundtrack with a cinematic, layered re-scoring that deepens the exploration mood. Fully additive and conflict-free with most visual overhauls.',
      authorMemberSince: '2018-03-15',
      authorTotalMods: 1,
      files: ['Data/Soundtrack/ambient_cave.wav', 'Data/Soundtrack/battle.wav'],
      dependencies: [],
      versionHistory: [
        { version: '2.0', changelog: 'Added 40 new ambient stems.', releasedAt: '2025-01-20' },
        { version: '1.5', changelog: 'Balanced combat stingers.', releasedAt: '2022-09-30' },
      ],
      screenshots: ['Audio settings preview'],
    },
    {
      modId: '106',
      modName: 'Cooking & Alchemy Overhaul',
      author: 'forge_master',
      category: 'Gameplay',
      provider: 'CurseForge',
      sourceUrl: 'https://www.curseforge.com/skyrim/special-edition/cooking-alchemy-overhaul',
      downloads: 1500000,
      activeInstalls: 88000,
      ratingCount: 1100,
      version: '1.4',
      minVramGb: 4,
      minRamGb: 8,
      summary: 'Deepens survival crafting and reagent economy.',
      longDescription:
        'Expands cooking recipes, reagent harvesting and alchemy tiers into a full survival crafting loop. Ships Papyrus scripts compiled with SKSE, making SKSE64 a hard prerequisite.',
      authorMemberSince: '2019-07-22',
      authorTotalMods: 5,
      files: ['Data/CookingAlchemy.esp', 'Data/scripts/survival_harvest.pex'],
      dependencies: [{ dependsOn: '102', isHard: true, filePaths: [] }],
      versionHistory: [
        { version: '1.4', changelog: 'Added rare reagent tiers and vendor stock.', releasedAt: '2025-06-14' },
        { version: '1.3', changelog: 'Rebalanced cooking xp curve.', releasedAt: '2023-10-01' },
      ],
      screenshots: ['Cooking menu', 'Alchemy reagent journal'],
    },
  ],
  witcher3: [
    {
      modId: '301',
      modName: 'The Witcher 3 HD Reworked Project Next-Gen',
      author: 'HalkHogan',
      category: 'Visuals',
      provider: 'Nexus Mods',
      sourceUrl: 'https://www.nexusmods.com/witcher3/mods/1021',
      downloads: 11200000,
      activeInstalls: 540000,
      ratingCount: 6100,
      version: '12.0',
      minVramGb: 6,
      minRamGb: 16,
      summary: 'Top-tier texture & model quality improvements preserving original art style.',
      longDescription:
        'The definitive texture and model overhaul for The Witcher 3 Next-Gen, replacing low-res assets while faithfully preserving the original art style across Novigrad, Velen and Toussaint.',
      authorMemberSince: '2015-06-20',
      authorTotalMods: 2,
      files: ['mods/hdrp_nextgen/content/hdrp_meshes.bundle', 'mods/hdrp_nextgen/content/hdrp_textures.bundle'],
      dependencies: [],
      versionHistory: [
        { version: '12.0', changelog: 'Next-Gen edition parity pass.', releasedAt: '2024-01-15' },
        { version: '11.5', changelog: 'Rebuilt Toussaint architecture textures.', releasedAt: '2022-05-30' },
      ],
      screenshots: ['Novigrad marketplace comparison', 'Toussaint villa detail'],
    },
    {
      modId: '302',
      modName: 'Script GUI Fixer & Mod Limit Adjuster',
      author: 'Aserius',
      category: 'Framework',
      provider: 'GitHub',
      sourceUrl: 'https://github.com/witcher3-mods/script-gui-fixer/releases',
      downloads: 6700000,
      activeInstalls: 300000,
      ratingCount: 3400,
      version: '1.2',
      minVramGb: 4,
      minRamGb: 8,
      summary: 'Removes structural mod count limits and resolves UI script conflicts.',
      longDescription:
        'Lifts the classic mod count ceiling and auto-merges conflicting UI scripts so large mod lists load reliably. A staple framework mod for heavy The Witcher 3 mod sets.',
      authorMemberSince: '2016-09-14',
      authorTotalMods: 3,
      files: ['bin/x64_common/scripts_gui_fixer.bundle', 'content/content0/scripts/gui_fixer.ws'],
      dependencies: [],
      versionHistory: [
        { version: '1.2', changelog: 'Next-Gen compatibility and merge fixes.', releasedAt: '2024-02-01' },
        { version: '1.1', changelog: 'Fixed inventory script merge crash.', releasedAt: '2021-04-12' },
      ],
      screenshots: ['Script merge report', 'Mod limit bypass log'],
    },
    {
      modId: '303',
      modName: 'Ghost Mode & Combat Overhaul',
      author: 'WastelandGhost',
      category: 'Gameplay',
      provider: 'Nexus Mods',
      sourceUrl: 'https://www.nexusmods.com/witcher3/mods/1179',
      downloads: 1900000,
      activeInstalls: 96000,
      ratingCount: 2100,
      version: '4.4',
      minVramGb: 4,
      minRamGb: 8,
      summary: 'Complete rebalance of stamina, alchemy, leveling, and enemy AI.',
      longDescription:
        'A comprehensive gameplay rebalance overhauling stamina, alchemy, leveling and enemy AI. Conflict-free at the file level with the framework and visual packs in this hub.',
      authorMemberSince: '2015-11-02',
      authorTotalMods: 1,
      files: ['mods/ghostmode/content/ghost_combat.ws', 'mods/ghostmode/content/ghost_alchemy.ws'],
      dependencies: [],
      versionHistory: [
        { version: '4.4', changelog: 'Tuned enemy AI aggression and alchemy toxicity.', releasedAt: '2024-03-22' },
        { version: '4.3', changelog: 'Rebalanced stamina consumption curve.', releasedAt: '2022-08-09' },
      ],
      screenshots: ['Combat HUD with new stamina bar', 'Alchemy skill tree'],
    },
    {
      modId: '304',
      modName: 'Geralt Appearance & Armor Retextures',
      author: 'wardrobe_team',
      category: 'Visuals',
      provider: 'CurseForge',
      sourceUrl: 'https://www.curseforge.com/witcher3/geralt-wardrobe',
      downloads: 1500000,
      activeInstalls: 72000,
      ratingCount: 1300,
      version: '3.0',
      minVramGb: 4,
      minRamGb: 8,
      summary: 'Expanded wardrobe retextures for armors and casual outfits.',
      longDescription:
        'Adds a curated wardrobe of retextured armors and casual outfits for Geralt while keeping silhouette and rigging intact.',
      authorMemberSince: '2017-03-25',
      authorTotalMods: 6,
      files: ['mods/geralt_wardrobe/content/wardrobe_armor.ws', 'mods/geralt_wardrobe/content/wardrobe_casual.ws'],
      dependencies: [],
      versionHistory: [
        { version: '3.0', changelog: 'Added cat school retexture set.', releasedAt: '2024-06-18' },
        { version: '2.5', changelog: 'Fixed clipping on wolf armor hood.', releasedAt: '2021-01-10' },
      ],
      screenshots: ['Armor set preview', 'Casual outfit gallery'],
    },
    {
      modId: '305',
      modName: 'Toussaint Ambient Weather Reborn',
      author: 'weather_lab',
      category: 'Visuals',
      provider: 'Modrinth',
      sourceUrl: 'https://modrinth.com/mod/toussaint-weather',
      downloads: 990000,
      activeInstalls: 48000,
      ratingCount: 1100,
      version: '1.1',
      minVramGb: 4,
      minRamGb: 8,
      summary: 'Cinematic weather variety across Toussaint and Velen.',
      longDescription:
        'Adds cinematic weather variety and golden-hour lighting to Toussaint and Velen without touching combat or UI scripts.',
      authorMemberSince: '2018-05-16',
      authorTotalMods: 4,
      files: ['mods/toussaint_weather/content/weather_toussaint.ws', 'mods/toussaint_weather/content/weather_velen.ws'],
      dependencies: [],
      versionHistory: [
        { version: '1.1', changelog: 'Added misty morning presets.', releasedAt: '2024-08-30' },
        { version: '1.0', changelog: 'Initial cinematic weather release.', releasedAt: '2023-11-11' },
      ],
      screenshots: ['Golden hour in Toussaint', 'Velen storm front'],
    },
    {
      modId: '306',
      modName: 'Enhanced Horse & Mount Mechanics',
      author: 'stable_hand',
      category: 'Gameplay',
      provider: 'ModDB',
      sourceUrl: 'https://www.moddb.com/mods/enhanced-horse-mechanics',
      downloads: 720000,
      activeInstalls: 35000,
      ratingCount: 900,
      version: '2.2',
      minVramGb: 2,
      minRamGb: 8,
      summary: 'Responsive horse control, stamina tuning, and gallop overhaul.',
      longDescription:
        'Makes Roach control crisper with tuned stamina, responsive gallop and less obstacle collision jank.',
      authorMemberSince: '2019-02-08',
      authorTotalMods: 2,
      files: ['mods/horse_mechanics/content/horse_stamina.ws', 'mods/horse_mechanics/content/horse_control.ws'],
      dependencies: [],
      versionHistory: [
        { version: '2.2', changelog: 'Smoothed gallop transitions.', releasedAt: '2024-10-04' },
        { version: '2.1', changelog: 'Fixed stamina drain in rain.', releasedAt: '2023-07-21' },
      ],
      screenshots: ['Roach gallop preview', 'Stamina UI comparison'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Manifest lookup helpers
// ---------------------------------------------------------------------------

function findManifest(domain: string, modId: string): ManifestMod | null {
  const list = DOMAIN_MANIFESTS[domain] || [];
  return list.find((m) => m.modId === modId) || null;
}

function manifestName(domain: string, modId: string): string | null {
  const mod = findManifest(domain, modId);
  return mod ? mod.modName : null;
}

// ---------------------------------------------------------------------------
// Seed — idempotent INSERT OR IGNORE into the persistence tables.
// ---------------------------------------------------------------------------

/** Seed version history, dependency edges and default load order from the
 *  static manifest. Safe to re-run on every boot (INSERT OR IGNORE). */
export function ensureModHubSeed(db: DatabaseType): void {
  const insertVersion = db.prepare(
    `INSERT OR IGNORE INTO ModVersions (gameDomain, modId, version, changelog, releasedAt)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertDep = db.prepare(
    `INSERT OR IGNORE INTO ModDependencies (gameDomain, modId, dependsOn, isHard, filePaths)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertOrder = db.prepare(
    `INSERT OR IGNORE INTO ModLoadOrder (gameDomain, modId, position, isActive, updatedAt)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
  );
  const seedAll = db.transaction(() => {
    for (const domain of Object.keys(DOMAIN_MANIFESTS)) {
      const list = DOMAIN_MANIFESTS[domain];
      list.forEach((mod, index) => {
        for (const v of mod.versionHistory || []) {
          insertVersion.run(domain, mod.modId, v.version, v.changelog, v.releasedAt);
        }
        for (const d of mod.dependencies || []) {
          insertDep.run(
            domain,
            mod.modId,
            d.dependsOn,
            d.isHard ? 1 : 0,
            Array.isArray(d.filePaths) && d.filePaths.length > 0
              ? JSON.stringify(d.filePaths)
              : null,
          );
        }
        insertOrder.run(domain, mod.modId, index);
      });
    }
  });
  seedAll();
}

// ---------------------------------------------------------------------------
// Installed / active status
// ---------------------------------------------------------------------------

function isModInstalled(db: DatabaseType, domain: string, modId: string): boolean {
  try {
    return !!db
      .prepare('SELECT 1 AS x FROM InstalledMods WHERE gameDomain = ? AND modId = ?')
      .get(domain, modId);
  } catch {
    return false;
  }
}

function isModActiveInLoadOrder(db: DatabaseType, domain: string, modId: string): boolean {
  try {
    const row = db
      .prepare('SELECT isActive FROM ModLoadOrder WHERE gameDomain = ? AND modId = ?')
      .get(domain, modId) as { isActive: number } | undefined;
    return !!row && Number(row.isActive) !== 0;
  } catch {
    return true;
  }
}


// ---------------------------------------------------------------------------
// Dependency tree
// ---------------------------------------------------------------------------

function buildDependencyTree(
  domain: string,
  modId: string,
  depth: number,
  visited: Set<string>,
  isHard: boolean,
): DependencyNode | null {
  const mod = findManifest(domain, modId);
  if (!mod) return null;
  const node: DependencyNode = { modId, modName: mod.modName, isHard, depth, children: [] };
  if (visited.has(modId) || depth >= MAX_DEPENDENCY_DEPTH) return node;
  visited.add(modId);
  const edges = (mod.dependencies || []).slice(0, MAX_DEPENDENCY_BRANCH);
  node.children = edges
    .map((edge) =>
      buildDependencyTree(domain, edge.dependsOn, depth + 1, visited, !!edge.isHard),
    )
    .filter((child): child is DependencyNode => child !== null);
  return node;
}

/** Structured dependency tree for a mod (manifest-first, DB fallback). */
export function getDependencyTree(
  db: DatabaseType,
  gameDomain: string,
  modId: string,
): DependencyNode[] {
  const domain = normalizeDomain(gameDomain);
  const id = String(modId || '').trim();
  if (!domain || !id) return [];

  const root = buildDependencyTree(domain, id, 0, new Set<string>(), true);
  if (root) return [root];

  try {
    const rows = db
      .prepare('SELECT * FROM ModDependencies WHERE gameDomain = ? AND modId = ? ORDER BY id ASC')
      .all(domain, id) as Array<{
      dependsOn: string;
      isHard: number;
    }>;
    if (rows.length === 0) return [];
    return [
      {
        modId: id,
        modName: id,
        isHard: true,
        depth: 0,
        children: rows.map((r) => ({
          modId: r.dependsOn,
          modName: r.dependsOn,
          isHard: Number(r.isHard) !== 0,
          depth: 1,
          children: [],
        })),
      },
    ];
  } catch {
    return [];
  }
}


// ---------------------------------------------------------------------------
// Mod detail
// ---------------------------------------------------------------------------

/** Resolve the comprehensive detail payload for a mod. Manifest-first with a
 *  persisted-catalog fallback for mods ingested via /api/mods/ingest. */
export function getModDetail(
  db: DatabaseType,
  gameDomain: string,
  modId: string,
): ModDetail | null {
  const domain = normalizeDomain(gameDomain);
  const id = String(modId || '').trim();
  if (!domain || !id) return null;

  const manifest = findManifest(domain, id);
  if (manifest) {
    const revalidated = sanitizeModUrl(manifest.sourceUrl);
    const installed = isModInstalled(db, domain, id);
    const deps: ModDependencyEdge[] = (manifest.dependencies || []).map((d) => ({
      dependsOn: d.dependsOn,
      modName: manifestName(domain, d.dependsOn),
      isHard: !!d.isHard,
      filePaths: Array.isArray(d.filePaths) ? d.filePaths.slice() : [],
    }));
    const description = sanitizeModDescription(manifest.longDescription);
    return {
      gameDomain: domain,
      modId: id,
      modName: manifest.modName,
      author: {
        handle: maskModAuthorHandle(manifest.author),
        memberSince: manifest.authorMemberSince,
        totalMods: manifest.authorTotalMods,
        totalDownloads: manifest.downloads,
      },
      category: manifest.category,
      provider: manifest.provider,
      sourceUrl: revalidated.valid ? revalidated.url : null,
      sourceDomain: revalidated.valid ? revalidated.domain : null,
      linkValid: revalidated.valid,
      downloads: manifest.downloads,
      activeInstalls: manifest.activeInstalls,
      ratingCount: manifest.ratingCount,
      version: manifest.version,
      minVramGb: manifest.minVramGb,
      minRamGb: manifest.minRamGb,
      description,
      longDescription: description,
      screenshots: (manifest.screenshots || []).slice(),
      files: (manifest.files || []).slice(),
      stats: {
        downloads: manifest.downloads,
        activeInstalls: manifest.activeInstalls,
        rating: manifest.ratingCount,
        downloadsLabel: compact(manifest.downloads),
        installsLabel: compact(manifest.activeInstalls),
      },
      versionHistory: (manifest.versionHistory || []).map((v) => ({
        version: v.version,
        changelog: sanitizeModDescription(v.changelog),
        releasedAt: v.releasedAt,
      })),
      dependencies: deps,
      dependencyTree: getDependencyTree(db, domain, id),
      installed,
      isActive: installed && isModActiveInLoadOrder(db, domain, id),
    };
  }

  // Persisted-catalog fallback (ingested mods without a static manifest).
  try {
    const row = db
      .prepare(
        `SELECT * FROM Mods
         WHERE is_active = 1 AND LOWER(gameId) = ? AND (CAST(id AS TEXT) = ? OR modName = ?)
         LIMIT 1`,
      )
      .get(domain, id, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const rawUrl = typeof row.sourceUrl === 'string' ? row.sourceUrl : null;
    const revalidated = sanitizeModUrl(rawUrl);
    const installed = isModInstalled(db, domain, id);
    const description = sanitizeModDescription(row.description);
    const downloads = Number(row.downloads);
    const authorRaw = row.author_handle != null ? String(row.author_handle) : row.author;
    return {
      gameDomain: domain,
      modId: id,
      modName: String(row.modName || id),
      author: {
        handle: maskModAuthorHandle(authorRaw),
        memberSince: null,
        totalMods: 0,
        totalDownloads: Number.isFinite(downloads) ? downloads : 0,
      },
      category: String(row.category || 'General'),
      provider: String(row.sourceDomain || 'Community'),
      sourceUrl: revalidated.valid ? revalidated.url : null,
      sourceDomain: revalidated.valid ? revalidated.domain : null,
      linkValid: revalidated.valid,
      downloads: Number.isFinite(downloads) && downloads >= 0 ? downloads : 0,
      activeInstalls: Number(row.active_installs) || 0,
      ratingCount: Number(row.rating_count) || 0,
      version: String(row.version || '1.0.0'),
      minVramGb: Number.isFinite(Number(row.minVramGb)) ? Number(row.minVramGb) : null,
      minRamGb: Number.isFinite(Number(row.minRamGb)) ? Number(row.minRamGb) : null,
      description,
      longDescription: description,
      screenshots: [],
      files: [],
      stats: {
        downloads: Number.isFinite(downloads) && downloads >= 0 ? downloads : 0,
        activeInstalls: Number(row.active_installs) || 0,
        rating: Number(row.rating_count) || 0,
        downloadsLabel: compact(Number.isFinite(downloads) && downloads >= 0 ? downloads : 0),
        installsLabel: compact(Number(row.active_installs) || 0),
      },
      versionHistory: [],
      dependencies: [],
      dependencyTree: getDependencyTree(db, domain, id),
      installed,
      isActive: installed && isModActiveInLoadOrder(db, domain, id),
    };
  } catch (err) {
    console.warn('[modManager] Catalog detail lookup failed:', safeErrorMessage(err));
    return null;
  }
}


// ---------------------------------------------------------------------------
// File-level conflict detection
// ---------------------------------------------------------------------------

function readManifestFiles(domain: string, modId: string): string[] {
  const mod = findManifest(domain, modId);
  if (!mod) return [];
  return (mod.files || []).map(normalizeFilePath);
}

function readManifestDeps(domain: string, modId: string): ManifestDependency[] {
  const mod = findManifest(domain, modId);
  return mod ? mod.dependencies || [] : [];
}

/**
 * Detect file-level conflicts and missing hard dependencies among a set of
 * mods. When `selectedModIds` is empty, the active installed set for the
 * domain (InstalledMods rows) is analyzed instead. Comparisons are
 * deterministic: normalized relative paths are intersected pairwise, and every
 * hard dependency edge is checked against the analyzed set.
 */
export function detectFileConflicts(
  db: DatabaseType,
  gameDomain: string,
  selectedModIds: string[],
): ModConflictReport {
  const domain = normalizeDomain(gameDomain);
  const report: ModConflictReport = {
    gameDomain: domain,
    checkedModIds: [],
    conflictCount: 0,
    conflicts: [],
  };

  let ids = (selectedModIds || [])
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    try {
      const rows = db
        .prepare('SELECT modId FROM InstalledMods WHERE gameDomain = ?')
        .all(domain) as Array<{ modId: string }>;
      ids = rows.map((r) => String(r.modId));
    } catch {
      ids = [];
    }
  }
  ids = Array.from(new Set(ids));
  report.checkedModIds = ids.slice();
  if (ids.length === 0) return report;

  const names: Record<string, string> = {};
  const fileMap: Record<string, string[]> = {};
  for (const id of ids) {
    const manifest = findManifest(domain, id);
    names[id] = manifest ? manifest.modName : id;
    fileMap[id] = readManifestFiles(domain, id);
  }

  // Pairwise file-path intersections -> hard file conflicts.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = fileMap[ids[i]] || [];
      const b = fileMap[ids[j]] || [];
      const overlap = a.filter((p) => b.includes(p));
      if (overlap.length > 0) {
        report.conflicts.push({
          type: 'file',
          modA: ids[i],
          modAName: names[ids[i]],
          modB: ids[j],
          modBName: names[ids[j]],
          filePaths: overlap,
          message: `${names[ids[i]]} and ${names[ids[j]]} write the same file(s).`,
        });
      }
    }
  }

  // Missing hard-dependency warnings.
  for (const id of ids) {
    const manifest = findManifest(domain, id);
    if (!manifest) continue;
    for (const dep of readManifestDeps(domain, id)) {
      if (!dep.isHard) continue;
      if (!ids.includes(dep.dependsOn)) {
        report.conflicts.push({
          type: 'missing-dependency',
          modA: id,
          modAName: manifest.modName,
          modB: dep.dependsOn,
          modBName: manifestName(domain, dep.dependsOn) || dep.dependsOn,
          filePaths: [],
          message: `${manifest.modName} requires ${manifestName(domain, dep.dependsOn) || dep.dependsOn}, which is not in the active set.`,
        });
      }
    }
  }

  report.conflictCount = report.conflicts.length;
  return report;
}

// ---------------------------------------------------------------------------
// Load order
// ---------------------------------------------------------------------------

/** Read the persisted load order for a domain (active rows, position order).
 *  Falls back to the seeded default order when no active rows exist yet. */
export function getLoadOrder(db: DatabaseType, gameDomain: string): LoadOrderEntry[] {
  const domain = normalizeDomain(gameDomain);
  if (!domain) return [];
  try {
    let rows = db
      .prepare(
        'SELECT * FROM ModLoadOrder WHERE gameDomain = ? AND isActive = 1 ORDER BY position ASC, id ASC',
      )
      .all(domain) as Array<{
      modId: string;
      modName: string | null;
      position: number;
      isActive: number;
    }>;
    if (rows.length === 0) {
      ensureModHubSeed(db);
      rows = db
        .prepare(
          'SELECT * FROM ModLoadOrder WHERE gameDomain = ? AND isActive = 1 ORDER BY position ASC, id ASC',
        )
        .all(domain) as Array<{
        modId: string;
        modName: string | null;
        position: number;
        isActive: number;
      }>;
    }
    return rows.map((r, i) => ({
      modId: String(r.modId),
      modName: manifestName(domain, String(r.modId)) || String(r.modName || r.modId),
      position: Number(r.position) || i,
      isActive: Number(r.isActive) !== 0,
    }));
  } catch (err) {
    console.warn('[modManager] Load order read failed:', safeErrorMessage(err));
    return [];
  }
}

/** Persist a custom load order. Atomically deactivates every row for the
 *  domain, then upserts the supplied ordered modIds with positions 0..n. */
export function saveLoadOrder(
  db: DatabaseType,
  gameDomain: string,
  orderedModIds: string[],
): LoadOrderEntry[] {
  const domain = normalizeDomain(gameDomain);
  const ids = (orderedModIds || [])
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);
  const save = db.transaction(() => {
    db.prepare(
      'UPDATE ModLoadOrder SET isActive = 0, updatedAt = CURRENT_TIMESTAMP WHERE gameDomain = ?',
    ).run(domain);
    const upsert = db.prepare(
      `INSERT INTO ModLoadOrder (gameDomain, modId, position, isActive, updatedAt)
       VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(gameDomain, modId) DO UPDATE SET
         position = excluded.position,
         isActive = 1,
         updatedAt = CURRENT_TIMESTAMP`,
    );
    ids.forEach((id, index) => {
      upsert.run(domain, id, index);
    });
  });
  save();
  return getLoadOrder(db, domain);
}

