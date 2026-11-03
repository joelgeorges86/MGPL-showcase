import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { seedPerformanceProfiles } from "../src/seed/performance";
import { seedRadar } from "../src/seed/radar";
import { seedCommunityBenchmarks } from "../src/seed/benchmarks";
import { normalizePlatform } from "../src/lib/platformTaxonomy";

// Sprint 3 (FEAT-OAUTH-0001): Deterministic OAuth/OpenID fixtures shared with
// the E2E oauth spec. Importing the constants module has zero side effects
// (no express/axios/db imports), so re-exporting here is safe.
export { OAUTH_FIXTURES } from "../src/lib/oauthFixtures";

/**
 * Sprint 1 (EPIC-PROFILE-0001): Deterministic profile identity fixtures.
 * Seeded with Argon2id hashes so the auth-core spec can log in against a known
 * credential pair without hashing at request time in the test.
 * Alex seeds with the private-visibility default + a reserved gamerTag handle
 * owned by Jordan (`JordanDev`) so the profile-security spec can exercise the
 * 409 conflict path deterministically.
 */
const AUTH_USERS = [
  {
    id: "auth-user-alex-gamer",
    email: "alex.gamer@mgpl.io",
    password: "GamerPass2026!",
    role: "user",
    displayName: "Alex Gamer",
    gamerTag: null,
    avatarUrl: null,
    profileVisibility: "private",
    libraryVisibility: "private",
  },
  {
    id: "auth-user-jordan-dev",
    email: "jordan.dev@mgpl.io",
    password: "SecureDev2026!",
    role: "user",
    displayName: "Jordan Dev",
    gamerTag: "JordanDev",
    avatarUrl: null,
    profileVisibility: "private",
    libraryVisibility: "private",
  },
  {
    // Sprint 5 (EPIC-07): role-gated Analytics account. Leadership is one of
    // the authorized ANALYTICS_ROLES (admin | Product | Data | Leadership), so
    // the analytics-visualizer / session-analytics specs and the sprint5 spec
    // authenticate with this account to prove the server-side gate grants
    // access to authorized roles while alex (role "user") proves the 403 path.
    id: "auth-user-leadership",
    email: "leadership@mgpl.io",
    password: "LeaderPass2026!",
    role: "Leadership",
    displayName: "Morgan Leadership",
    gamerTag: "MorganOps",
    avatarUrl: null,
    profileVisibility: "private",
    libraryVisibility: "private",
  },
  {
    // AI-084 (#163): admin account. Whole-database export and import
    // (/api/state/export, /api/state/import) are admin-only, so the backup and
    // restore specs authenticate with this account. Alex (role "user") proves
    // the 403 path.
    id: "auth-user-admin-ops",
    email: "admin.ops@mgpl.io",
    password: "AdminPass2026!",
    role: "admin",
    displayName: "Avery Admin",
    gamerTag: null,
    avatarUrl: null,
    profileVisibility: "private",
    libraryVisibility: "private",
  },
];

/**
 * Deterministic Test Seeding (v5.0.4 Chapter 17.3 / DoD).
 *
 * Runs once before the Playwright suite. Initializes a fresh
 * ./data/test_mgpl.db, applies WAL + busy_timeout PRAGMAs, creates the 13
 * authoritative application tables, and seeds deterministic records so every
 * spec asserts against a known, stable dataset.
 *
 * The webServer boots the API with DB_PATH=./data/test_mgpl.db, so the server
 * process opens the exact same file this setup seeds. Because the server's
 * src/db.ts runs initDb() on load (CREATE TABLE IF NOT EXISTS + guarded ALTERs),
 * we only need to create the tables here if they do not already exist; the
 * server will self-heal any additive drift on boot.
 */

const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");
const SEED_IDENTIFIER = "mgpl-e2e-v1";

// ---------------------------------------------------------------------------
// Deterministic seed data (mirrors src/routes/mock.ts so the /api/mock/seed
// endpoint and the global setup converge on the same authoritative dataset).
// ---------------------------------------------------------------------------
const DEVICES = [
  {
    deviceId: "rig-ultra-4080",
    deviceName: "Rig Ultra 4080",
    formFactor: "Desktop",
    gpuModel: "NVIDIA GeForce RTX 4080",
    vramGb: 16,
    cpuModel: "AMD Ryzen 7 7800X3D",
    cpuCores: 8,
    ramGb: 32,
    motherboard: "X670E",
    caseModel: "ATX Mid Tower",
    psu: "850W",
    storageCapacityGb: 2048,
    os: "Windows 11",
    batteryWh: null,
    isArchived: 0,
    tdpWatts: 320,
  },
  {
    deviceId: "stealth-laptop-4060",
    deviceName: "Stealth Laptop 4060",
    formFactor: "Laptop",
    gpuModel: "NVIDIA GeForce RTX 4060 Mobile",
    vramGb: 8,
    cpuModel: "Intel Core i7-13700H",
    cpuCores: 14,
    ramGb: 16,
    motherboard: null,
    caseModel: null,
    psu: null,
    storageCapacityGb: 1024,
    os: "Windows 11",
    batteryWh: 99,
    isArchived: 0,
    tdpWatts: 115,
  },
  {
    deviceId: "steam-deck-oled",
    deviceName: "Steam Deck OLED",
    formFactor: "Handheld",
    gpuModel: "AMD RDNA 2 (custom APU)",
    vramGb: 16,
    cpuModel: "AMD Zen 2 4C/8T (custom APU)",
    cpuCores: 4,
    ramGb: 16,
    motherboard: null,
    caseModel: null,
    psu: null,
    storageCapacityGb: 512,
    os: "SteamOS",
    batteryWh: 50,
    isArchived: 0,
    tdpWatts: 15,
  },
  {
    deviceId: "ps5-digital",
    deviceName: "PlayStation 5 Digital",
    formFactor: "Console",
    gpuModel: "AMD RDNA 2 (custom)",
    vramGb: 16,
    cpuModel: "AMD Zen 2 8C/16T (custom)",
    cpuCores: 8,
    ramGb: 16,
    motherboard: null,
    caseModel: null,
    psu: null,
    storageCapacityGb: 825,
    os: "PS OS",
    batteryWh: null,
    isArchived: 0,
    tdpWatts: 200,
  },
];

const GAMES = [
  {
    GameID: "cyberpunk-2077",
    "Game Title": "Cyberpunk 2077",
    "Primary Genre": "RPG",
    "Original Game Release Date": "2020-12-10",
    "Storage Size": "70 GB",
    "Min RAM GB": 12,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/cyberpunk2077",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/cyberpunk2077",
    nexusModCount: 12000,
    trackedModCount: 340,
    platformStoreUrls: "https://store.steampowered.com/app/1091500/",
  },
  {
    GameID: "monster-hunter-wilds",
    "Game Title": "Monster Hunter Wilds",
    "Primary Genre": "Action RPG",
    "Storage Size": "140 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/monsterhunterwilds",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/monsterhunterwilds",
    nexusModCount: 2400,
    trackedModCount: 120,
    platformStoreUrls: "https://store.steampowered.com/app/2246340/",
  },
  {
    GameID: "helldivers-2",
    "Game Title": "HELLDIVERS 2",
    "Primary Genre": "Shooter",
    "Storage Size": "100 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/helldivers2",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/helldivers2",
    nexusModCount: 900,
    trackedModCount: 45,
    platformStoreUrls: "https://store.steampowered.com/app/553850/",
  },
  {
    GameID: "the-witcher-3",
    "Game Title": "The Witcher 3: Wild Hunt",
    "Primary Genre": "RPG",
    "Original Game Release Date": "2015-05-19",
    "Storage Size": "50 GB",
    "Min RAM GB": 6,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/witcher3",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/witcher3",
    nexusModCount: 9000,
    trackedModCount: 210,
    platformStoreUrls: "https://store.steampowered.com/app/292030/",
  },
  {
    GameID: "civilization-vi",
    "Game Title": "Civilization VI",
    "Primary Genre": "Strategy",
    "Storage Size": "20 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/civilizationvi",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/civilizationvi",
    nexusModCount: 1500,
    trackedModCount: 60,
    platformStoreUrls: "https://store.steampowered.com/app/289070/",
  },
  {
    GameID: "bloodborne",
    "Game Title": "Bloodborne",
    "Primary Genre": "Action RPG",
    "Original Game Release Date": "2015-03-24",
    "Storage Size": "40 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.playstation.com/",
  },
  {
    GameID: "G00001",
    "Game Title": "Elden Ring",
    "Primary Genre": "Action RPG",
    "Storage Size": "60 GB",
    "Min RAM GB": 12,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/eldenring",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/eldenring",
    nexusModCount: 5000,
    trackedModCount: 180,
    platformStoreUrls: "https://store.steampowered.com/app/1245620/",
  },
  {
    GameID: "skyrim",
    "Game Title": "The Elder Scrolls V: Skyrim",
    "Primary Genre": "RPG",
    "Storage Size": "12 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/skyrimspecialedition",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/skyrimspecialedition",
    nexusModCount: 68000,
    trackedModCount: 1200,
    platformStoreUrls: "https://store.steampowered.com/app/489830/",
  },
  {
    GameID: "a-plague-tale-innocence",
    "Game Title": "A Plague Tale: Innocence",
    "Primary Genre": "Adventure",
    "Storage Size": "50 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/752590/",
  },
  {
    GameID: "112-operator",
    "Game Title": "112 Operator",
    "Primary Genre": "Simulation",
    "Original Game Release Date": "2020-05-22",
    "Storage Size": "4 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/1144200/",
  },
  {
    GameID: "baldurs-gate-3",
    "Game Title": "Baldur's Gate 3",
    "Primary Genre": "RPG",
    "Storage Size": "150 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/baldursgate3",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/baldursgate3",
    nexusModCount: 15000,
    trackedModCount: 420,
    platformStoreUrls: "https://store.steampowered.com/app/1086940/",
  },
  {
    GameID: "stardew-valley",
    "Game Title": "Stardew Valley",
    "Primary Genre": "Simulation",
    "Storage Size": "1 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/stardewvalley",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/stardewvalley",
    nexusModCount: 8000,
    trackedModCount: 260,
    platformStoreUrls: "https://store.steampowered.com/app/413150/",
  },
  {
    GameID: "fallout-4",
    "Game Title": "Fallout 4",
    "Primary Genre": "RPG",
    "Storage Size": "30 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/fallout4",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/fallout4",
    nexusModCount: 45000,
    trackedModCount: 900,
    platformStoreUrls: "https://store.steampowered.com/app/377160/",
  },
  {
    GameID: "elden-ring",
    "Game Title": "Elden Ring",
    "Primary Genre": "Action RPG",
    "Storage Size": "60 GB",
    "Min RAM GB": 12,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/eldenring",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/eldenring",
    nexusModCount: 5000,
    trackedModCount: 180,
    platformStoreUrls: "https://store.steampowered.com/app/1245620/",
  },
  {
    GameID: "red-dead-redemption-2",
    "Game Title": "Red Dead Redemption 2",
    "Primary Genre": "Action",
    "Storage Size": "150 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/reddeadredemption2",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/reddeadredemption2",
    nexusModCount: 3000,
    trackedModCount: 90,
    platformStoreUrls: "https://store.steampowered.com/app/1174180/",
  },
  {
    GameID: "hades",
    "Game Title": "Hades",
    "Primary Genre": "Roguelike",
    "Storage Size": "15 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/hades",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/hades",
    nexusModCount: 1200,
    trackedModCount: 40,
    platformStoreUrls: "https://store.steampowered.com/app/1145360/",
  },
  {
    GameID: "disco-elysium",
    "Game Title": "Disco Elysium",
    "Primary Genre": "RPG",
    "Storage Size": "20 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/discoelysium",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/discoelysium",
    nexusModCount: 300,
    trackedModCount: 15,
    platformStoreUrls: "https://store.steampowered.com/app/632470/",
  },
  {
    GameID: "hollow-knight",
    "Game Title": "Hollow Knight",
    "Primary Genre": "Metroidvania",
    "Storage Size": "9 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/367520/",
  },
  {
    GameID: "celeste",
    "Game Title": "Celeste",
    "Primary Genre": "Platformer",
    "Storage Size": "2 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/504230/",
  },
  {
    GameID: "portal-2",
    "Game Title": "Portal 2",
    "Primary Genre": "Puzzle",
    "Storage Size": "12 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/620/",
  },
  {
    GameID: "forza-horizon-5",
    "Game Title": "Forza Horizon 5",
    "Primary Genre": "Racing",
    "Storage Size": "110 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/1551360/",
  },
  {
    GameID: "street-fighter-6",
    "Game Title": "Street Fighter 6",
    "Primary Genre": "Fighting",
    "Storage Size": "60 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/1364780/",
  },
  {
    GameID: "ea-sports-fc-24",
    "Game Title": "EA SPORTS FC 24",
    "Primary Genre": "Sports",
    "Storage Size": "100 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/2195250/",
  },
  {
    GameID: "xcom-2",
    "Game Title": "XCOM 2",
    "Primary Genre": "Tactics",
    "Storage Size": "45 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/268500/",
  },
  {
    GameID: "dead-cells",
    "Game Title": "Dead Cells",
    "Primary Genre": "Roguelike",
    "Storage Size": "4 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/588650/",
  },
  {
    GameID: "slay-the-spire",
    "Game Title": "Slay the Spire",
    "Primary Genre": "Roguelike",
    "Storage Size": "1 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/646570/",
  },
  {
    GameID: "terraria",
    "Game Title": "Terraria",
    "Primary Genre": "Sandbox",
    "Storage Size": "1 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/terraria",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/terraria",
    nexusModCount: 2000,
    trackedModCount: 70,
    platformStoreUrls: "https://store.steampowered.com/app/105600/",
  },
  {
    GameID: "factorio",
    "Game Title": "Factorio",
    "Primary Genre": "Simulation",
    "Storage Size": "3 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/factorio",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/factorio",
    nexusModCount: 500,
    trackedModCount: 25,
    platformStoreUrls: "https://store.steampowered.com/app/427520/",
  },
  {
    GameID: "satisfactory",
    "Game Title": "Satisfactory",
    "Primary Genre": "Simulation",
    "Storage Size": "20 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/satisfactory",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/satisfactory",
    nexusModCount: 800,
    trackedModCount: 30,
    platformStoreUrls: "https://store.steampowered.com/app/526870/",
  },
  {
    GameID: "valheim",
    "Game Title": "Valheim",
    "Primary Genre": "Survival",
    "Storage Size": "1 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/valheim",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/valheim",
    nexusModCount: 4000,
    trackedModCount: 120,
    platformStoreUrls: "https://store.steampowered.com/app/892970/",
  },
  {
    GameID: "subnautica",
    "Game Title": "Subnautica",
    "Primary Genre": "Survival",
    "Storage Size": "10 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/subnautica",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/subnautica",
    nexusModCount: 1500,
    trackedModCount: 50,
    platformStoreUrls: "https://store.steampowered.com/app/264710/",
  },
  {
    GameID: "no-mans-sky",
    "Game Title": "No Man's Sky",
    "Primary Genre": "Survival",
    "Storage Size": "15 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/nomanssky",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/nomanssky",
    nexusModCount: 2500,
    trackedModCount: 80,
    platformStoreUrls: "https://store.steampowered.com/app/275850/",
  },
  {
    GameID: "outer-wilds",
    "Game Title": "Outer Wilds",
    "Primary Genre": "Adventure",
    "Storage Size": "8 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/753640/",
  },
  {
    GameID: "control",
    "Game Title": "Control",
    "Primary Genre": "Action",
    "Storage Size": "42 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/control",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/control",
    nexusModCount: 200,
    trackedModCount: 10,
    platformStoreUrls: "https://store.steampowered.com/app/870780/",
  },
  {
    GameID: "death-stranding",
    "Game Title": "Death Stranding",
    "Primary Genre": "Action",
    "Storage Size": "60 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/deathstranding",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/deathstranding",
    nexusModCount: 400,
    trackedModCount: 20,
    platformStoreUrls: "https://store.steampowered.com/app/1190460/",
  },
  {
    GameID: "ghost-of-tsushima",
    "Game Title": "Ghost of Tsushima",
    "Primary Genre": "Action",
    "Storage Size": "75 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/ghostoftsushima",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/ghostoftsushima",
    nexusModCount: 600,
    trackedModCount: 25,
    platformStoreUrls: "https://store.steampowered.com/app/2215430/",
  },
  {
    GameID: "returnal",
    "Game Title": "Returnal",
    "Primary Genre": "Roguelike",
    "Storage Size": "60 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/1649240/",
  },
  {
    GameID: "days-gone",
    "Game Title": "Days Gone",
    "Primary Genre": "Action",
    "Storage Size": "70 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/daysgone",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/daysgone",
    nexusModCount: 300,
    trackedModCount: 15,
    platformStoreUrls: "https://store.steampowered.com/app/1259420/",
  },
  {
    GameID: "resident-evil-4",
    "Game Title": "Resident Evil 4",
    "Primary Genre": "Horror",
    "Storage Size": "60 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/residentevil4",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/residentevil4",
    nexusModCount: 2000,
    trackedModCount: 60,
    platformStoreUrls: "https://store.steampowered.com/app/2050650/",
  },
  {
    GameID: "dead-space",
    "Game Title": "Dead Space",
    "Primary Genre": "Horror",
    "Storage Size": "50 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/deadspace",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/deadspace",
    nexusModCount: 500,
    trackedModCount: 20,
    platformStoreUrls: "https://store.steampowered.com/app/17470/",
  },
  {
    GameID: "alan-wake-2",
    "Game Title": "Alan Wake 2",
    "Primary Genre": "Horror",
    "Storage Size": "80 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/alanwake2",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/alanwake2",
    nexusModCount: 400,
    trackedModCount: 15,
    platformStoreUrls: "https://store.epicgames.com/",
  },
  {
    GameID: "gta-v",
    "Game Title": "Grand Theft Auto V",
    "Primary Genre": "Action",
    "Storage Size": "110 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/grandtheftautov",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/grandtheftautov",
    nexusModCount: 12000,
    trackedModCount: 350,
    platformStoreUrls: "https://store.steampowered.com/app/271590/",
  },
  {
    GameID: "starfield",
    "Game Title": "Starfield",
    "Primary Genre": "RPG",
    "Storage Size": "125 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/starfield",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/starfield",
    nexusModCount: 9000,
    trackedModCount: 280,
    platformStoreUrls: "https://store.steampowered.com/app/1716740/",
  },
  {
    GameID: "hogwarts-legacy",
    "Game Title": "Hogwarts Legacy",
    "Primary Genre": "RPG",
    "Storage Size": "85 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/hogwartslegacy",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/hogwartslegacy",
    nexusModCount: 3000,
    trackedModCount: 100,
    platformStoreUrls: "https://store.steampowered.com/app/990080/",
  },
  {
    GameID: "god-of-war",
    "Game Title": "God of War",
    "Primary Genre": "Action",
    "Storage Size": "70 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/godofwar",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/godofwar",
    nexusModCount: 800,
    trackedModCount: 30,
    platformStoreUrls: "https://store.steampowered.com/app/1593500/",
  },
  {
    GameID: "horizon-zero-dawn",
    "Game Title": "Horizon Zero Dawn",
    "Primary Genre": "Action RPG",
    "Storage Size": "70 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/horizonzerodawn",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/horizonzerodawn",
    nexusModCount: 700,
    trackedModCount: 25,
    platformStoreUrls: "https://store.steampowered.com/app/1151640/",
  },
  {
    GameID: "spider-man-remastered",
    "Game Title": "Marvel's Spider-Man Remastered",
    "Primary Genre": "Action",
    "Storage Size": "75 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/spidermanremastered",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/spidermanremastered",
    nexusModCount: 900,
    trackedModCount: 35,
    platformStoreUrls: "https://store.steampowered.com/app/1817070/",
  },
  {
    GameID: "the-last-of-us-part-i",
    "Game Title": "The Last of Us Part I",
    "Primary Genre": "Action",
    "Storage Size": "100 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/thelastofusparti",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/thelastofusparti",
    nexusModCount: 500,
    trackedModCount: 20,
    platformStoreUrls: "https://store.steampowered.com/app/1888930/",
  },
  {
    GameID: "mass-effect",
    "Game Title": "Mass Effect Legendary Edition",
    "Primary Genre": "RPG",
    "Storage Size": "120 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/masseffect",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/masseffect",
    nexusModCount: 1500,
    trackedModCount: 55,
    platformStoreUrls: "https://store.steampowered.com/app/1328670/",
  },
  {
    GameID: "cities-skylines",
    "Game Title": "Cities: Skylines",
    "Primary Genre": "Simulation",
    "Storage Size": "4 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/citiesskylines",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/citiesskylines",
    nexusModCount: 10000,
    trackedModCount: 300,
    platformStoreUrls: "https://store.steampowered.com/app/255710/",
  },
  {
    GameID: "the-sims-4",
    "Game Title": "The Sims 4",
    "Primary Genre": "Simulation",
    "Storage Size": "50 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 1,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/thesims4",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/thesims4",
    nexusModCount: 30000,
    trackedModCount: 800,
    platformStoreUrls: "https://store.steampowered.com/app/1222670/",
  },
  {
    GameID: "minecraft",
    "Game Title": "Minecraft",
    "Primary Genre": "Sandbox",
    "Storage Size": "1 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/minecraft",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/minecraft",
    nexusModCount: 5000,
    trackedModCount: 150,
    platformStoreUrls: "https://www.minecraft.net/",
  },
  {
    GameID: "hades-ii",
    "Game Title": "Hades II",
    "Primary Genre": "Roguelike",
    "Storage Size": "15 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/hades2",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/hades2",
    nexusModCount: 300,
    trackedModCount: 12,
    platformStoreUrls: "https://store.steampowered.com/app/1145350/",
  },
  {
    GameID: "outer-worlds",
    "Game Title": "The Outer Worlds",
    "Primary Genre": "RPG",
    "Storage Size": "40 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/theouterworlds",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/theouterworlds",
    nexusModCount: 400,
    trackedModCount: 18,
    platformStoreUrls: "https://store.steampowered.com/app/578650/",
  },
  {
    GameID: "death-stranding-directors-cut",
    "Game Title": "Death Stranding Director's Cut",
    "Primary Genre": "Action",
    "Storage Size": "60 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/deathstranding",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/deathstranding",
    nexusModCount: 400,
    trackedModCount: 20,
    platformStoreUrls: "https://store.steampowered.com/app/1850570/",
  },
  {
    GameID: "ratchet-clank-rift-apart",
    "Game Title": "Ratchet & Clank: Rift Apart",
    "Primary Genre": "Platformer",
    "Storage Size": "45 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/ratchetandclankriftapart",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/ratchetandclankriftapart",
    nexusModCount: 200,
    trackedModCount: 8,
    platformStoreUrls: "https://store.steampowered.com/app/1895880/",
  },
  {
    GameID: "uncharted-legacy-of-thieves",
    "Game Title": "Uncharted: Legacy of Thieves",
    "Primary Genre": "Action",
    "Storage Size": "100 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/unchartedlegacyofthieves",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/unchartedlegacyofthieves",
    nexusModCount: 150,
    trackedModCount: 6,
    platformStoreUrls: "https://store.steampowered.com/app/1659420/",
  },
  {
    GameID: "detroit-become-human",
    "Game Title": "Detroit: Become Human",
    "Primary Genre": "Adventure",
    "Storage Size": "55 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 4,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/detroitbecomehuman",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/detroitbecomehuman",
    nexusModCount: 100,
    trackedModCount: 4,
    platformStoreUrls: "https://store.steampowered.com/app/1222140/",
  },
  {
    GameID: "heavy-rain",
    "Game Title": "Heavy Rain",
    "Primary Genre": "Adventure",
    "Storage Size": "35 GB",
    "Min RAM GB": 4,
    "Min VRAM GB": 2,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "https://www.nexusmods.com/heavyrain",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/heavyrain",
    nexusModCount: 50,
    trackedModCount: 2,
    platformStoreUrls: "https://store.steampowered.com/app/7360/",
  },
  {
    GameID: "space-marine-2",
    "Game Title": "Warhammer 40,000: Space Marine 2",
    "Primary Genre": "Action",
    "Storage Size": "75 GB",
    "Min RAM GB": 8,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "https://store.steampowered.com/app/2183900/",
  },
  {
    GameID: "G00002",
    "Game Title": "Session Test Fixture",
    "Primary Genre": "Simulation",
    "Storage Size": "1 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    "Nexus Mods URL": "",
    cover_url: "",
    nexusUrl: "",
    nexusModCount: 0,
    trackedModCount: 0,
    platformStoreUrls: "",
  },
];

const WISHLIST = [
  {
    gameId: "cyberpunk-2077",
    title: "Cyberpunk 2077",
    coverImage: "",
    targetPrice: 9999,
    currentBestPrice: 16.49,
    bestStore: "Fanatical",
    bestStoreType: "Authorized Retailer",
    historicalLow: 16.49,
    isTriggered: 1,
    notes: "Seeded: Fanatical best deal + Phantom Liberty DLC.",
  },
  {
    gameId: "monster-hunter-wilds",
    title: "Monster Hunter Wilds",
    coverImage: "",
    targetPrice: 54.99,
    currentBestPrice: 54.99,
    bestStore: "Green Man Gaming",
    bestStoreType: "Authorized Retailer",
    historicalLow: 54.99,
    isTriggered: 0,
    notes: "Seeded: GMG untriggered.",
  },
  {
    gameId: "the-witcher-3",
    title: "The Witcher 3: Wild Hunt",
    coverImage: "",
    targetPrice: 9999,
    currentBestPrice: 9.99,
    bestStore: "GOG",
    bestStoreType: "Direct Platform",
    historicalLow: 9.99,
    isTriggered: 1,
    notes: "Seeded: GOG DRM-Free.",
  },
  {
    gameId: "civilization-vi",
    title: "Civilization VI",
    coverImage: "",
    targetPrice: 5.99,
    currentBestPrice: 5.99,
    bestStore: "Fanatical",
    bestStoreType: "Authorized Retailer",
    historicalLow: 5.99,
    isTriggered: 0,
    notes: "Seeded: Fanatical.",
  },
  {
    gameId: "bloodborne",
    title: "Bloodborne",
    coverImage: "",
    targetPrice: 19.99,
    currentBestPrice: 19.99,
    bestStore: "PlayStation",
    bestStoreType: "Direct Platform",
    historicalLow: 19.99,
    isTriggered: 0,
    notes: "Seeded: PSN console exclusive.",
  },
];

const TAGS: Array<{ gameId: string; tagName: string; colorHex: string }> = [
  { gameId: "bloodborne", tagName: "Console Exclusive", colorHex: "#f43f5e" },
  {
    gameId: "helldivers-2",
    tagName: "Restricted / Anti-Cheat",
    colorHex: "#ef4444",
  },
  { gameId: "cyberpunk-2077", tagName: "Moddable", colorHex: "#38bdf8" },
  { gameId: "the-witcher-3", tagName: "Moddable", colorHex: "#38bdf8" },
];

const NOTES: Array<{ gameId: string; noteMarkdown: string }> = [
  {
    gameId: "cyberpunk-2077",
    noteMarkdown: "Seeded composite score reference title.",
  },
  { gameId: "bloodborne", noteMarkdown: "Console exclusive — no PC port." },
];

const OWNERSHIP = [
  {
    OwnershipID: "own-cyberpunk-2077",
    GameID: "cyberpunk-2077",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/1091500/",
    Format: "Digital",
  },
  {
    OwnershipID: "own-monster-hunter-wilds",
    GameID: "monster-hunter-wilds",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/2246340/",
    Format: "Digital",
  },
  {
    OwnershipID: "own-helldivers-2",
    GameID: "helldivers-2",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/553850/",
    Format: "Digital",
  },
  {
    OwnershipID: "own-the-witcher-3",
    GameID: "the-witcher-3",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/292030/",
    Format: "Digital",
  },
  {
    OwnershipID: "own-civilization-vi",
    GameID: "civilization-vi",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/289070/",
    Format: "Digital",
  },
  {
    OwnershipID: "own-bloodborne",
    GameID: "bloodborne",
    // Explicit PS4-era label (mirrors production, where PS4 rows carry the
    // literal "PS4" platform string). The platform hub summary's HUB-01 test
    // asserts an explicit PS4-row surfaces with /ps4/i; "PlayStation 4" does
    // not contain the contiguous substring, so keep the storefront-native key.
    Platform: "PS4",
    "Store URL": "https://store.playstation.com/",
    Format: "Digital",
  },
  {
    OwnershipID: "own-112-operator",
    GameID: "112-operator",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/1144200/",
    Format: "Digital",
  },
];

const TRACKING: Array<{
  gameId: string;
  playStatus: string;
  hoursPlayed: number;
  lastPlayedDate: string | null;
  playedPlatform: string | null;
  completedDate: string | null;
}> = [
  {
    gameId: "112-operator",
    playStatus: "Playing",
    hoursPlayed: 12.5,
    lastPlayedDate: "2026-08-10T10:00:00.000Z",
    playedPlatform: "Steam",
    completedDate: null,
  },
  {
    gameId: "cyberpunk-2077",
    playStatus: "Playing",
    hoursPlayed: 40,
    lastPlayedDate: "2026-08-15T18:30:00.000Z",
    playedPlatform: "Steam",
    completedDate: null,
  },
  {
    gameId: "the-witcher-3",
    playStatus: "Completed",
    hoursPlayed: 120,
    lastPlayedDate: "2026-07-01T09:00:00.000Z",
    playedPlatform: "Steam",
    completedDate: "2026-07-01",
  },
  {
    gameId: "G00001",
    playStatus: "Playing",
    hoursPlayed: 80,
    lastPlayedDate: "2026-08-05T20:00:00.000Z",
    playedPlatform: "Steam",
    completedDate: null,
  },
  {
    gameId: "bloodborne",
    playStatus: "Completed",
    hoursPlayed: 45,
    lastPlayedDate: "2026-05-01T12:00:00.000Z",
    playedPlatform: "PlayStation 4",
    completedDate: "2026-05-01",
  },
];

const REVIEWS: Array<{
  gameId: string;
  source: string;
  scoreNumeric: number | null;
  recPercent: number | null;
}> = [
  {
    gameId: "cyberpunk-2077",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 84,
  },
  {
    gameId: "cyberpunk-2077",
    source: "OpenCritic",
    scoreNumeric: 86,
    recPercent: null,
  },
  {
    gameId: "the-witcher-3",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 97,
  },
  {
    gameId: "the-witcher-3",
    source: "OpenCritic",
    scoreNumeric: 92,
    recPercent: null,
  },
  // Sprint 1 (EPIC-RADAR-0001): deterministic niche/indie review scores so the
  // Hidden Gems discovery filter (composite >= 80) returns curated titles.
  {
    gameId: "hades",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 98,
  },
  { gameId: "hades", source: "OpenCritic", scoreNumeric: 93, recPercent: null },
  {
    gameId: "hollow-knight",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 97,
  },
  {
    gameId: "hollow-knight",
    source: "OpenCritic",
    scoreNumeric: 90,
    recPercent: null,
  },
  {
    gameId: "celeste",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 98,
  },
  {
    gameId: "celeste",
    source: "OpenCritic",
    scoreNumeric: 92,
    recPercent: null,
  },
  {
    gameId: "dead-cells",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 96,
  },
  {
    gameId: "dead-cells",
    source: "OpenCritic",
    scoreNumeric: 89,
    recPercent: null,
  },
  {
    gameId: "slay-the-spire",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 97,
  },
  {
    gameId: "slay-the-spire",
    source: "OpenCritic",
    scoreNumeric: 91,
    recPercent: null,
  },
  {
    gameId: "factorio",
    source: "Steam Users",
    scoreNumeric: null,
    recPercent: 96,
  },
  {
    gameId: "factorio",
    source: "OpenCritic",
    scoreNumeric: 90,
    recPercent: null,
  },
];

// AppCompletionRoadmap (production HLTB roadmap table, queried directly by
// src/routes/hltb.ts, backlog.ts, compare.ts, recommend.ts, recommender.ts).
// Deterministic seed rows avoid falling through to a live HLTB network fetch
// during resolveHltbMetrics() in test mode.
const ROADMAP: Array<{
  gameId: string;
  title: string;
  mainStoryHours: number;
  completionistHours: number;
}> = [
  {
    gameId: "G00001",
    title: "Elden Ring",
    mainStoryHours: 55,
    completionistHours: 133,
  },
  {
    gameId: "cyberpunk-2077",
    title: "Cyberpunk 2077",
    mainStoryHours: 25,
    completionistHours: 103,
  },
  {
    gameId: "the-witcher-3",
    title: "The Witcher 3: Wild Hunt",
    mainStoryHours: 51,
    completionistHours: 172,
  },
  {
    gameId: "112-operator",
    title: "112 Operator",
    mainStoryHours: 6,
    completionistHours: 10,
  },
  {
    gameId: "bloodborne",
    title: "Bloodborne",
    mainStoryHours: 32,
    completionistHours: 65,
  },
];

// ---------------------------------------------------------------------------
// DDL for the 13 authoritative tables (mirrors src/db.ts initDb()).
// ---------------------------------------------------------------------------
const DDL = `
  CREATE TABLE IF NOT EXISTS mgpl_seed_marker (
    seedIdentifier TEXT PRIMARY KEY,
    seededAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS AuthUsers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    passwordHash TEXT,
    displayName TEXT,
    avatarUrl TEXT,
    gamerTag TEXT,
    profileVisibility TEXT NOT NULL DEFAULT 'private',
    libraryVisibility TEXT NOT NULL DEFAULT 'private',
    role TEXT NOT NULL DEFAULT 'user',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AuthAccounts (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    provider TEXT NOT NULL,
    providerAccountId TEXT NOT NULL,
    tokenEnc TEXT,
    tokenIv TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, providerAccountId),
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_auth_accounts_userId ON AuthAccounts(userId);

  CREATE TABLE IF NOT EXISTS AppPlatformHandles (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL UNIQUE,
    steamUsername TEXT,
    psnId TEXT,
    xboxGamertag TEXT,
    gogUsername TEXT,
    epicUsername TEXT,
    ubisoftUsername TEXT,
    hidePlatformIds INTEGER NOT NULL DEFAULT 0,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_platform_handles_userId ON AppPlatformHandles(userId);

  -- Sprint 2 (WUD-2.1 / EPIC-01): Local encrypted platform-link vault.
  -- Mirrors src/db.ts DDL. Tokens are AES-256-GCM encrypted at rest.
  CREATE TABLE IF NOT EXISTS AuthPlatformLinks (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    platform TEXT NOT NULL,
    publicId TEXT NOT NULL,
    displayHandle TEXT,
    tokenEnc TEXT,
    tokenIv TEXT,
    connectedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastSyncedAt DATETIME,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
    UNIQUE(userId, platform)
  );

  CREATE INDEX IF NOT EXISTS idx_auth_platform_links_userId ON AuthPlatformLinks(userId);

  CREATE TABLE IF NOT EXISTS AppFriendships (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    friendId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'manual',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userId, friendId),
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
    FOREIGN KEY (friendId) REFERENCES AuthUsers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_friendships_userId ON AppFriendships(userId);
  CREATE INDEX IF NOT EXISTS idx_friendships_friendId ON AppFriendships(friendId);

  CREATE TABLE IF NOT EXISTS AppDealsWishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    steamAppId TEXT,
    gameTitle TEXT UNIQUE,
    targetPrice REAL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AppPriceAlerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    gameId TEXT NOT NULL,
    title TEXT NOT NULL,
    targetPrice REAL NOT NULL,
    currentPrice REAL,
    historicalLow REAL,
    isTriggered INTEGER DEFAULT 0,
    acknowledged INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
    UNIQUE(userId, gameId)
  );

  CREATE TABLE IF NOT EXISTS InstalledMods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId TEXT,
    modId TEXT NOT NULL,
    gameDomain TEXT NOT NULL,
    modName TEXT NOT NULL,
    version TEXT,
    isActive INTEGER DEFAULT 1,
    installedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(modId, gameDomain)
  );

  -- Sprint 5 (EPIC-06): Non-PII mod catalog (mirrors src/db.ts DDL).
  -- Sprint 6.1 (GAP-003): is_active column supports the mod-link revalidation
  -- sweep (scripts/mod-link-sweep.ts) suppressing non-whitelisted sourceUrls.
  CREATE TABLE IF NOT EXISTS Mods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId TEXT NOT NULL,
    modName TEXT NOT NULL,
    author TEXT,
    sourceDomain TEXT NOT NULL,
    sourceUrl TEXT,
    downloads INTEGER DEFAULT 0,
    version TEXT,
    minVramGb INTEGER,
    minRamGb INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    -- Sprint 2 (WUD-2.3 / EPICSEC05): strict mod metadata schema columns.
    download_count INTEGER DEFAULT 0,
    active_installs INTEGER DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    version_tag TEXT,
    author_handle TEXT,
    description TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (gameId) REFERENCES AppGames(GameID),
    UNIQUE(gameId, modName, sourceDomain)
  );
  CREATE INDEX IF NOT EXISTS idx_mods_gameId ON Mods(gameId);

  -- Sprint 4 (EPICUX04): Mods Hub 2.0 persistence tables (mirrors src/db.ts).
  CREATE TABLE IF NOT EXISTS ModVersions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameDomain TEXT NOT NULL,
    modId TEXT NOT NULL,
    version TEXT NOT NULL,
    changelog TEXT,
    releasedAt TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gameDomain, modId, version)
  );
  CREATE INDEX IF NOT EXISTS idx_mod_versions_domain_mod ON ModVersions(gameDomain, modId);

  CREATE TABLE IF NOT EXISTS ModDependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameDomain TEXT NOT NULL,
    modId TEXT NOT NULL,
    dependsOn TEXT NOT NULL,
    isHard INTEGER NOT NULL DEFAULT 1,
    filePaths TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gameDomain, modId, dependsOn)
  );
  CREATE INDEX IF NOT EXISTS idx_mod_dependencies_domain_mod ON ModDependencies(gameDomain, modId);

  CREATE TABLE IF NOT EXISTS ModLoadOrder (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameDomain TEXT NOT NULL,
    modId TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    isActive INTEGER NOT NULL DEFAULT 1,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gameDomain, modId)
  );
  CREATE INDEX IF NOT EXISTS idx_mod_load_order_domain ON ModLoadOrder(gameDomain, position);

  -- Sprint 2 (WUD-2.2 / EPIC-02): Deal price-history baseline (mirrors src/db.ts).
  CREATE TABLE IF NOT EXISTS AppDealPriceHistory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId TEXT NOT NULL,
    title TEXT,
    store TEXT NOT NULL,
    price REAL NOT NULL,
    recordedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(gameId, store, recordedAt)
  );
  CREATE INDEX IF NOT EXISTS idx_deal_price_history_gameId ON AppDealPriceHistory(gameId);

  CREATE TABLE IF NOT EXISTS AppCompletionRoadmapCache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameTitle TEXT UNIQUE,
    mainStory REAL,
    mainExtra REAL,
    completionist REAL,
    hltbScore REAL,
    cachedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AppGameTags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    gameId TEXT NOT NULL,
    tagName TEXT NOT NULL,
    colorHex TEXT DEFAULT '#38bdf8',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
    UNIQUE(userId, gameId, tagName)
  );

  CREATE TABLE IF NOT EXISTS AppGameNotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    gameId TEXT NOT NULL,
    noteMarkdown TEXT NOT NULL,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
    UNIQUE(userId, gameId)
  );

  CREATE TABLE IF NOT EXISTS AppWishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    gameId TEXT NOT NULL,
    title TEXT NOT NULL,
    coverImage TEXT,
    targetPrice REAL NOT NULL,
    currentBestPrice REAL,
    bestStore TEXT,
    bestStoreType TEXT,
    historicalLow REAL,
    isTriggered INTEGER DEFAULT 0,
    notes TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE,
    UNIQUE(userId, gameId)
  );

  CREATE TABLE IF NOT EXISTS AppRetroTracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameTitle TEXT UNIQUE NOT NULL,
    system TEXT,
    status TEXT,
    playtimeHours REAL,
    personalRating INTEGER,
    isFavorite INTEGER DEFAULT 0,
    notes TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AppBacklog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gameId TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'backlog',
    priorityScore INTEGER DEFAULT 50,
    hltbMainHours REAL,
    hltbMainExtraHours REAL,
    hltbCompletionistHours REAL,
    etaDays REAL,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AppPlaySessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionUuid TEXT UNIQUE NOT NULL,
    gameId TEXT NOT NULL,
    startedAt DATETIME,
    endedAt DATETIME,
    durationSeconds INTEGER NOT NULL DEFAULT 0,
    deviceId TEXT,
    synced INTEGER DEFAULT 1,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AppTracking (
    "GameID" TEXT PRIMARY KEY,
    "Play Status" TEXT DEFAULT 'Not Started',
    "Want to Play?" TEXT,
    "Personal Rating (1-10)" INTEGER,
    "Hours Played" REAL DEFAULT 0,
    "Last Played Date" TEXT,
    "Played Platform" TEXT,
    "Played Hardware Device" TEXT,
    "Completed Date" TEXT,
    "Replay Interest" TEXT,
    "DLC Status" TEXT,
    "Personal Review" TEXT,
    "Notes" TEXT,
    "targetTdp" TEXT,
    "targetFps" TEXT,
    "resolution" TEXT,
    "cpuBoost" TEXT,
    "tuningNotes" TEXT,
    "playNotes" TEXT,
    "achievementNotes" TEXT,
    "tags" TEXT,
    "Trophy Progress" INTEGER,
    "targetStyle" TEXT
  );


  CREATE TABLE IF NOT EXISTS AppGames (
    "GameID" TEXT PRIMARY KEY,
    "Game Title" TEXT,
    "Primary Genre" TEXT,
    "Storage Size" TEXT,
    "Min RAM GB" REAL,
    "Min VRAM GB" REAL,
    "SSD Required?" TEXT,
    "Active" TEXT,
    "Nexus Mods URL" TEXT,
    "cover_url" TEXT,
    "nexusUrl" TEXT,
    "nexusModCount" INTEGER,
    "trackedModCount" INTEGER,
    "platformStoreUrls" TEXT,
    "storeUrl" TEXT,
    "storefront" TEXT,
    "criticScore" REAL,
    "reviewSource" TEXT,
    "enrichmentStatus" TEXT,
    "enrichmentConfidence" REAL,
    "originalGameReleaseDate" TEXT,
    "publisher" TEXT,
    "headerImage" TEXT,
    "Date Added" TEXT,
    "Last Modified" TEXT,
    -- Sprint 7 (WUD-7.1) / Prisma parity: additive columns mirrored from
    -- schema.prisma so Prisma-backed routes (platform hub summary, game
    -- relations) never hit P2022 ColumnNotFound against the test DB.
    "Original Game Release Date" TEXT,
    "Estimated Game Time" TEXT,
    "ROG Ally Playability" TEXT,
    "Laptop Playability" TEXT,
    "Is RPG" TEXT,
    "Is Turn-Based" TEXT,
    "Is Action" TEXT,
    "Is Strategy / Tactics" TEXT,
    "Is Sim / Management" TEXT,
    "Is Roguelike / Deckbuilder" TEXT,
    "Is Shooter / FPS" TEXT,
    "Is Platformer / Metroidvania" TEXT,
    "Is Story / Narrative" TEXT,
    "Is Sports / Racing" TEXT,
    "Is Horror / Survival" TEXT,
    "Official Website URL" TEXT,
    "Nexus Availability" TEXT,
    reviewUrl TEXT,
    developer TEXT,
    youtubeUrl TEXT,
    ignUrl TEXT,
    gamefaqsUrl TEXT,
    modNotifications TEXT,
    synopsis TEXT
  );

  CREATE TABLE IF NOT EXISTS Devices (
    deviceId TEXT PRIMARY KEY,
    deviceName TEXT,
    formFactor TEXT,
    gpuModel TEXT,
    vramGb REAL,
    cpuModel TEXT,
    ramGb REAL,
    motherboard TEXT,
    caseModel TEXT,
    psu TEXT,
    storageCapacityGb REAL,
    os TEXT,
    batteryWh REAL,
    isArchived INTEGER DEFAULT 0,
    tdpWatts REAL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastScanAt TEXT,
    cpuCores INTEGER,
    storageType TEXT,
    storageFreeGb REAL,
    scanConfidence TEXT,
    deviceClass TEXT,
    thermalCapabilities TEXT
  );

  CREATE TABLE IF NOT EXISTS AppDevices (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    deviceName TEXT NOT NULL,
    deviceType TEXT NOT NULL,
    cpuModel TEXT,
    cpuCores INTEGER,
    ramGb REAL,
    gpuModel TEXT,
    vramGb REAL,
    gpuType TEXT,
    storageType TEXT,
    storageFreeGb REAL,
    isPortable INTEGER DEFAULT 0,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES AuthUsers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_app_devices_userId ON AppDevices(userId);

  CREATE TABLE IF NOT EXISTS AppOwnership (
    "OwnershipID" TEXT PRIMARY KEY,
    "userId" TEXT,
    "GameID" TEXT,
    "Platform" TEXT,
    "platformCanonical" TEXT,
    "Store URL" TEXT,
    "Platform Specific Release Date" TEXT,
    "Platform DLC Search URL" TEXT,
    "Edition" TEXT,
    "Format" TEXT,
    "Ownership Access Type" TEXT,
    "Purchase Date" TEXT,
    "Price Paid" REAL,
    "Currency" TEXT,
    "Preferred Platform?" TEXT
  );

  CREATE TABLE IF NOT EXISTS "AppGameSettings" (
    "SettingID" TEXT PRIMARY KEY,
    "GameID" TEXT NOT NULL,
    "Game Title" TEXT,
    "Hardware Profile" TEXT,
    "Target Resolution" TEXT,
    "Target Framerate" TEXT,
    "Preset Level" TEXT,
    "Upscaling / Frame Gen Setting" TEXT,
    "VRAM Allocation" TEXT,
    "Thermal / Power Mode" TEXT,
    "Recommended Game Settings & Tuning Notes" TEXT,
    FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "idx_AppGameSettings_GameID" ON "AppGameSettings"("GameID");

  CREATE TABLE IF NOT EXISTS "AppGameFriction" (
    "FrictionID" TEXT PRIMARY KEY,
    "GameID" TEXT NOT NULL,
    "Game Title" TEXT,
    "Save System Type" TEXT,
    "Avg Time Between Saves" TEXT,
    "Suspend / Pause Friendly?" BOOLEAN,
    "Core Session Loop Length" TEXT,
    "Cognitive / Mental Energy Required" TEXT,
    "Third-Party Launcher Required?" TEXT,
    "Always-Online Required?" BOOLEAN,
    "Handheld Font & UI Legibility" TEXT,
    FOREIGN KEY ("GameID") REFERENCES "AppGames"("GameID") ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "idx_AppGameFriction_GameID" ON "AppGameFriction"("GameID");

  CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tableName TEXT NOT NULL,
    rowId TEXT NOT NULL,
    field TEXT NOT NULL,
    oldValue TEXT,
    newValue TEXT,
    reason TEXT,
    operator TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_table_row ON "platform_audit_logs"("tableName", "rowId");
  CREATE TRIGGER IF NOT EXISTS trg_platform_audit_logs_no_update
  BEFORE UPDATE ON "platform_audit_logs"
  BEGIN SELECT RAISE(ABORT, 'platform_audit_logs is append-only (EPIC-04)'); END;
  CREATE TRIGGER IF NOT EXISTS trg_platform_audit_logs_no_delete
  BEFORE DELETE ON "platform_audit_logs"
  BEGIN SELECT RAISE(ABORT, 'platform_audit_logs is append-only (EPIC-04)'); END;

  -- Sprint 5 (EPIC-07): Immutable analytics access audit trail (mirrors
  -- src/db.ts DDL). Append-only; every denied /api/analytics/* attempt is
  -- written by the requireRole middleware.
  CREATE TABLE IF NOT EXISTS "analytics_access_logs" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    role TEXT,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    ip TEXT,
    outcome TEXT NOT NULL DEFAULT 'denied',
    reason TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_analytics_access_logs_created ON "analytics_access_logs"(createdAt);
  CREATE TRIGGER IF NOT EXISTS trg_analytics_access_logs_no_update
  BEFORE UPDATE ON "analytics_access_logs"
  BEGIN SELECT RAISE(ABORT, 'analytics_access_logs is append-only (EPIC-07)'); END;
  CREATE TRIGGER IF NOT EXISTS trg_analytics_access_logs_no_delete
  BEFORE DELETE ON "analytics_access_logs"
  BEGIN SELECT RAISE(ABORT, 'analytics_access_logs is append-only (EPIC-07)'); END;

  CREATE TABLE IF NOT EXISTS AppReviews (
    "ReviewID" TEXT PRIMARY KEY,
    "GameID" TEXT NOT NULL,
    "Review Source" TEXT,
    -- Prisma parity: additive review columns mirrored from schema.prisma so
    -- Prisma relation includes (platform hub summary) never hit P2022.
    "Review Summary / Score" TEXT,
    "Score Numeric" REAL,
    "Recommendation Percent" REAL,
    "Worth Playing Grade" TEXT,
    "Review URL" TEXT,
    "Verification Status" TEXT,
    "Last Checked Date" TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS AppCompletionRoadmap (
    "RoadmapID" TEXT PRIMARY KEY,
    "GameID" TEXT,
    "Game Title" TEXT,
    "main_story_hours" REAL,
    "completionist_hours" REAL,
    "Main Story Time" TEXT,
    -- Prisma parity: additive roadmap columns mirrored from schema.prisma.
    "Missable Content / Trophies?" TEXT,
    "Min Playthroughs for 100%" TEXT,
    "Estimated 100% Completion Time" TEXT,
    "Trophy / Platinum Difficulty" TEXT,
    "Trophy Roadmap & Guide URL" TEXT
  );

  CREATE TABLE IF NOT EXISTS game_performance_profiles (
    profileId TEXT PRIMARY KEY,
    gameId TEXT NOT NULL,
    gpuTier TEXT NOT NULL,
    cpuTier TEXT NOT NULL,
    fps4kUltra REAL NOT NULL,
    fps1440pHigh REAL NOT NULL,
    fps1080pMed REAL NOT NULL,
    fps720pLow REAL NOT NULL,
    dataSource TEXT NOT NULL DEFAULT 'baseline',
    FOREIGN KEY (gameId) REFERENCES "AppGames"("GameID") ON DELETE CASCADE,
    UNIQUE(gameId, gpuTier, cpuTier)
  );

  CREATE TABLE IF NOT EXISTS release_radar (
    releaseId TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    releaseDate TEXT NOT NULL,
    platform TEXT NOT NULL,
    publisher TEXT,
    priceUsd REAL,
    preorderUrl TEXT,
    bannerUrl TEXT,
    isVerified INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_release_radar_date ON release_radar(releaseDate);

`;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
/**
 * Clear every seeded table so a re-run starts from a clean slate. This is the
 * deterministic alternative to deleting the DB file (which OneDrive locks on
 * Windows). Runs inside the same transaction as seed() so the wipe + reseed is
 * atomic. Order matters for FK integrity: child tables first, parents last.
 */
function clearTables(db: Database.Database): void {
  const tables = [
    "AuthAccounts",
    "AppFriendships",
    "AppDevices",
    "AuthUsers",
    "AppPlaySessions",
    "AppBacklog",
    "AppGameTags",
    "AppGameNotes",
    "AppPlatformHandles",
    "AuthPlatformLinks",
    "AppWishlist",
    "AppRetroTracking",
    "AppPriceAlerts",
    "AppDealsWishlist",
    "AppDealPriceHistory",
    "InstalledMods",
    "Mods",
    "ModVersions",
    "ModDependencies",
    "ModLoadOrder",
    "AppCompletionRoadmapCache",
    "AppOwnership",
    "AppTracking",
    "AppReviews",
    "AppCompletionRoadmap",
    "game_performance_profiles",
    "release_radar",
    "community_benchmarks",
    "AppGames",
    "Devices",
  ];
  for (const t of tables) {
    db.prepare(`DELETE FROM "${t}"`).run();
  }
}

function seed(db: Database.Database, authHashes: Record<string, string>): void {
  const upsertAuthUser = db.prepare(`
    INSERT INTO "AuthUsers" (
      id, email, passwordHash, displayName, gamerTag, avatarUrl, profileVisibility, libraryVisibility,
      role, createdAt, updatedAt
    ) VALUES (
      @id, @email, @passwordHash, @displayName, @gamerTag, @avatarUrl, @profileVisibility, @libraryVisibility,
      @role, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      passwordHash = excluded.passwordHash,
      displayName = excluded.displayName,
      gamerTag = excluded.gamerTag,
      avatarUrl = excluded.avatarUrl,
      profileVisibility = excluded.profileVisibility,
      libraryVisibility = excluded.libraryVisibility,
      role = excluded.role,
      updatedAt = CURRENT_TIMESTAMP
  `);
  for (const u of AUTH_USERS) {
    upsertAuthUser.run({
      id: u.id,
      email: u.email,
      passwordHash: authHashes[u.id],
      displayName: u.displayName,
      gamerTag: u.gamerTag,
      avatarUrl: u.avatarUrl,
      profileVisibility: u.profileVisibility,
      libraryVisibility: u.libraryVisibility ?? "private",
      role: u.role,
    });
  }

  const upsertDevice = db.prepare(`
    INSERT INTO "Devices" (
      deviceId, deviceName, formFactor, gpuModel, vramGb, cpuModel, ramGb,
      motherboard, caseModel, psu, storageCapacityGb, os, batteryWh,
      isArchived, tdpWatts, cpuCores, updatedAt
    ) VALUES (
      @deviceId, @deviceName, @formFactor, @gpuModel, @vramGb, @cpuModel, @ramGb,
      @motherboard, @caseModel, @psu, @storageCapacityGb, @os, @batteryWh,
      @isArchived, @tdpWatts, @cpuCores, CURRENT_TIMESTAMP
    )
    ON CONFLICT(deviceId) DO UPDATE SET
      deviceName = excluded.deviceName,
      formFactor = excluded.formFactor,
      gpuModel = excluded.gpuModel,
      vramGb = excluded.vramGb,
      cpuModel = excluded.cpuModel,
      ramGb = excluded.ramGb,
      motherboard = excluded.motherboard,
      caseModel = excluded.caseModel,
      psu = excluded.psu,
      storageCapacityGb = excluded.storageCapacityGb,
      os = excluded.os,
      batteryWh = excluded.batteryWh,
      isArchived = excluded.isArchived,
      tdpWatts = excluded.tdpWatts,
      cpuCores = excluded.cpuCores,
      updatedAt = CURRENT_TIMESTAMP
  `);
  for (const d of DEVICES) upsertDevice.run(d);

  const upsertGame = db.prepare(`
    INSERT INTO "AppGames" (
      "GameID", "Game Title", "Primary Genre", "Storage Size", "Min RAM GB",
      "Min VRAM GB", "SSD Required?", "Active", "Nexus Mods URL", "cover_url",
      "nexusUrl", "nexusModCount", "trackedModCount", "platformStoreUrls",
      "originalGameReleaseDate"
    ) VALUES (
      @GameID, @GameTitle, @PrimaryGenre, @StorageSize, @MinRAMGB,
      @MinVRAMGB, @SSDRequired, @Active, @NexusModsURL, @cover_url,
      @nexusUrl, @nexusModCount, @trackedModCount, @platformStoreUrls,
      @originalGameReleaseDate
    )
    ON CONFLICT("GameID") DO UPDATE SET
      "Game Title" = excluded."Game Title",
      "Primary Genre" = excluded."Primary Genre",
      "Storage Size" = excluded."Storage Size",
      "Min RAM GB" = excluded."Min RAM GB",
      "Min VRAM GB" = excluded."Min VRAM GB",
      "SSD Required?" = excluded."SSD Required?",
      "Active" = excluded."Active",
      "Nexus Mods URL" = excluded."Nexus Mods URL",
      "cover_url" = excluded."cover_url",
      "nexusUrl" = excluded."nexusUrl",
      "nexusModCount" = excluded."nexusModCount",
      "trackedModCount" = excluded."trackedModCount",
      "platformStoreUrls" = excluded."platformStoreUrls",
      "originalGameReleaseDate" = excluded."originalGameReleaseDate"
  `);
  for (const g of GAMES) {
    upsertGame.run({
      GameID: g.GameID,
      GameTitle: g["Game Title"],
      PrimaryGenre: g["Primary Genre"],
      StorageSize: g["Storage Size"],
      MinRAMGB: g["Min RAM GB"],
      MinVRAMGB: g["Min VRAM GB"],
      SSDRequired: g["SSD Required?"],
      Active: g.Active,
      NexusModsURL: g["Nexus Mods URL"],
      cover_url: g.cover_url,
      nexusUrl: g.nexusUrl,
      nexusModCount: g.nexusModCount,
      trackedModCount: g.trackedModCount,
      platformStoreUrls: g.platformStoreUrls,
      originalGameReleaseDate: g["Original Game Release Date"] ?? null,
    });
  }

  // Sprint 3 (EPIC-DEV-001): Seed deterministic performance profiles for every
  // owned game. globalSetup runs AFTER the webServer boots (webServer -> then
  // globalSetup), whose clearTables() wipes the boot-time seed, so these rows
  // must be re-seeded here to keep the matrix deterministic regardless of the
  // Playwright startup ordering.
  seedPerformanceProfiles(db);

  // Sprint 2 (EPIC-DEAL-001): Re-seed the verified upcoming-release radar.
  // Mirrors the performance-profile re-seed above: the webServer boot seeds it,
  // then globalSetup's clearTables() wipes it, so it must be re-inserted here.
  seedRadar(db);

  // Sprint 5 (EPICUX05): Re-seed the community benchmark fixtures after the
  // deterministic wipe so the Hardware Explorer E2E spec sees stable data.
  seedCommunityBenchmarks(db);

  // Sprint 4 (EPICUX04): Re-seed the Mods Hub 2.0 persistence tables. The
  // webServer boot seeds them via ensureModHubSeed(), then clearTables() wipes
  // them, so they are deterministically re-inserted here for the E2E suite.
  const seedModVersion = db.prepare(`
    INSERT OR IGNORE INTO "ModVersions" (gameDomain, modId, version, changelog, releasedAt)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seedModDep = db.prepare(`
    INSERT OR IGNORE INTO "ModDependencies" (gameDomain, modId, dependsOn, isHard, filePaths)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seedModOrder = db.prepare(`
    INSERT OR IGNORE INTO "ModLoadOrder" (gameDomain, modId, position, isActive, updatedAt)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
  `);
  const seedModHub = db.transaction(() => {
    const domains: Record<string, string[]> = {
      cyberpunk2077: ["201", "202", "203", "204", "205", "206"],
      skyrimspecialedition: ["101", "102", "103", "104", "105", "106"],
      witcher3: ["301", "302", "303", "304", "305", "306"],
    };
    for (const domain of Object.keys(domains)) {
      domains[domain].forEach((modId, index) => {
        seedModOrder.run(domain, modId, index);
      });
    }
    // Dependency edges (cyberpunk: REDscript+Traffic -> CET, Immersion -> REDscript).
    seedModDep.run("cyberpunk2077", "202", "201", 1, null);
    seedModDep.run("cyberpunk2077", "205", "201", 1, null);
    seedModDep.run("cyberpunk2077", "206", "202", 1, null);
    // Dependency edges (skyrim: SkyUI + Cooking&Alchemy -> SKSE64).
    seedModDep.run("skyrimspecialedition", "101", "102", 1, null);
    seedModDep.run("skyrimspecialedition", "106", "102", 1, null);
    // Version history (deterministic changelog rows).
    seedModVersion.run(
      "cyberpunk2077",
      "201",
      "1.30.1",
      "Stability fixes for Patch 2.2; updated Lua bindings.",
      "2025-11-18",
    );
    seedModVersion.run(
      "cyberpunk2077",
      "201",
      "1.29.0",
      "Added input hook API and faster overlay rendering.",
      "2025-06-02",
    );
    seedModVersion.run(
      "cyberpunk2077",
      "202",
      "0.5.18",
      "Fixed script hot-reload crash on game load.",
      "2025-12-01",
    );
    seedModVersion.run(
      "skyrimspecialedition",
      "102",
      "2.2.3",
      "Updated for the latest SE runtime build.",
      "2025-02-14",
    );
    seedModVersion.run(
      "skyrimspecialedition",
      "101",
      "5.2SE",
      "Compatibility fixes for the Anniversary Edition runtime.",
      "2021-11-11",
    );
  });
  seedModHub();

  // Sprint 2 (FEAT-MULTITENANT): Seeded wishlist/tags/notes rows are owned by
  // the deterministic "alex.gamer" auth user so the data-isolation spec has a
  // known baseline to assert Jordan cannot see.
  const upsertWishlist = db.prepare(`
    INSERT INTO "AppWishlist" (
      userId, gameId, title, coverImage, targetPrice, currentBestPrice, bestStore,
      bestStoreType, historicalLow, isTriggered, notes, updatedAt
    ) VALUES (
      @userId, @gameId, @title, @coverImage, @targetPrice, @currentBestPrice, @bestStore,
      @bestStoreType, @historicalLow, @isTriggered, @notes, CURRENT_TIMESTAMP
    )
    ON CONFLICT(userId, gameId) DO UPDATE SET
      title = excluded.title,
      coverImage = excluded.coverImage,
      targetPrice = excluded.targetPrice,
      currentBestPrice = excluded.currentBestPrice,
      bestStore = excluded.bestStore,
      bestStoreType = excluded.bestStoreType,
      historicalLow = excluded.historicalLow,
      isTriggered = excluded.isTriggered,
      notes = excluded.notes,
      updatedAt = CURRENT_TIMESTAMP
  `);
  for (const w of WISHLIST) upsertWishlist.run({ userId: AUTH_USERS[0].id, ...w });

  const upsertTag = db.prepare(`
    INSERT INTO "AppGameTags" (userId, gameId, tagName, colorHex)
    VALUES (@userId, @gameId, @tagName, @colorHex)
    ON CONFLICT(userId, gameId, tagName) DO UPDATE SET colorHex = excluded.colorHex
  `);
  for (const t of TAGS) upsertTag.run({ userId: AUTH_USERS[0].id, ...t });

  const upsertNote = db.prepare(`
    INSERT INTO "AppGameNotes" (userId, gameId, noteMarkdown, updatedAt)
    VALUES (@userId, @gameId, @noteMarkdown, CURRENT_TIMESTAMP)
    ON CONFLICT(userId, gameId) DO UPDATE SET
      noteMarkdown = excluded.noteMarkdown,
      updatedAt = CURRENT_TIMESTAMP
  `);
  for (const n of NOTES) upsertNote.run({ userId: AUTH_USERS[0].id, ...n });

  const upsertOwnership = db.prepare(`
    INSERT INTO "AppOwnership" (
      "OwnershipID", "userId", "GameID", "Platform", "platformCanonical", "Store URL", "Format"
    ) VALUES (
      @OwnershipID, @userId, @GameID, @Platform, @platformCanonical, @StoreURL, @Format
    )
    ON CONFLICT("OwnershipID") DO UPDATE SET
      "userId" = excluded."userId",
      "GameID" = excluded."GameID",
      "Platform" = excluded."Platform",
      "platformCanonical" = excluded."platformCanonical",
      "Store URL" = excluded."Store URL",
      "Format" = excluded."Format"
  `);
  for (const o of OWNERSHIP) {
    upsertOwnership.run({
      OwnershipID: o.OwnershipID,
      userId: AUTH_USERS[0].id,
      GameID: o.GameID,
      Platform: o.Platform,
      platformCanonical: normalizePlatform(o.Platform) ?? null,
      StoreURL: o["Store URL"],
      Format: o.Format,
    });
  }

  const upsertTracking = db.prepare(`
    INSERT INTO "AppTracking" (
      "GameID", "Play Status", "Hours Played", "Last Played Date", "Played Platform", "Completed Date"
    ) VALUES (
      @gameId, @playStatus, @hoursPlayed, @lastPlayedDate, @playedPlatform, @completedDate
    )
    ON CONFLICT("GameID") DO UPDATE SET
      "Play Status" = excluded."Play Status",
      "Hours Played" = excluded."Hours Played",
      "Last Played Date" = excluded."Last Played Date",
      "Played Platform" = excluded."Played Platform",
      "Completed Date" = excluded."Completed Date"
  `);
  for (const t of TRACKING) upsertTracking.run(t);

  const insertReview = db.prepare(`
    INSERT INTO "AppReviews" ("GameID", "Review Source", "Score Numeric", "Recommendation Percent")
    VALUES (@gameId, @source, @scoreNumeric, @recPercent)
  `);
  for (const r of REVIEWS) insertReview.run(r);

  const insertRoadmap = db.prepare(`
    INSERT INTO "AppCompletionRoadmap" ("GameID", "Game Title", "main_story_hours", "completionist_hours")
    VALUES (@gameId, @title, @mainStoryHours, @completionistHours)
  `);
  for (const r of ROADMAP) insertRoadmap.run(r);

  // Auto-generate a Steam ownership row for every seeded game that isn't
  // already covered by the hand-authored OWNERSHIP array above. This keeps
  // the library "owned=true" filter populated with the full 56-game catalog
  // (required for the virtualization sentinel to hydrate a second 24-card
  // chunk) without having to hand-maintain a duplicate platform mapping.
  const ownedIds = new Set(OWNERSHIP.map((o) => o.GameID));
  // Sprint 4 (EPIC-DEAL-001): keep the Space Marine 2 fixture unowned so the
  // quick-view drawer's "Add to Wishlist" action stays visible for the
  // deterministic wishlist quick-action E2E flow.
  const UNOWNED_IDS = new Set(["space-marine-2"]);
  const upsertAutoOwnership = db.prepare(`
    INSERT INTO "AppOwnership" (
      "OwnershipID", "userId", "GameID", "Platform", "platformCanonical", "Store URL", "Format"
    ) VALUES (
      @OwnershipID, @userId, @GameID, @Platform, @platformCanonical, @StoreURL, @Format
    )
    ON CONFLICT("OwnershipID") DO UPDATE SET
      "userId" = excluded."userId",
      "GameID" = excluded."GameID",
      "Platform" = excluded."Platform",
      "platformCanonical" = excluded."platformCanonical",
      "Store URL" = excluded."Store URL",
      "Format" = excluded."Format"
  `);
  for (const g of GAMES) {
    if (ownedIds.has(g.GameID) || UNOWNED_IDS.has(g.GameID)) continue;
    const url = g.platformStoreUrls || "";
    const platform = /epicgames\.com/.test(url)
      ? "Epic Games"
      : /minecraft\.net/.test(url)
        ? "Xbox"
        : "Steam";
    upsertAutoOwnership.run({
      OwnershipID: `own-auto-${g.GameID}`,
      userId: AUTH_USERS[0].id,
      GameID: g.GameID,
      Platform: platform,
      platformCanonical: normalizePlatform(platform) ?? null,
      StoreURL: url,
      Format: "Digital",
    });
  }
}

// ---------------------------------------------------------------------------
// Global setup entrypoint
// ---------------------------------------------------------------------------
export default async function globalSetup(): Promise<void> {
  // Ensure the data directory exists.
  const dataDir = path.dirname(TEST_DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // NOTE: We intentionally do NOT delete the test DB file here. The workspace
  // lives under OneDrive, whose sync engine holds transient locks on SQLite
  // files, so fs.rmSync() throws EPERM even when no process has the file open.
  // Instead we open the DB in place, create tables if needed, clear every
  // seeded table, and re-seed deterministically. This yields the same clean
  // state as a fresh file while being immune to OneDrive file-lock races.
  const db = new Database(TEST_DB_PATH);
  try {
    // Deterministic concurrency PRAGMAs (v5.0.4 Chapter 22 / Appendix D).
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");
    db.pragma("foreign_keys = ON");

    // Create the authoritative tables (no-op if they already exist).
    db.exec(DDL);

    // Sprint 1 (EPIC-PROFILE-0001): Self-heal a stale test DB from a previous
    // sprint run. An existing data/test_mgpl.db created before this sprint has
    // no displayName/avatarUrl/gamerTag/profileVisibility columns, and the seed
    // statements below reference them — the server's initDb() self-heal runs
    // only AFTER global setup completes, so this exact same guarded ALTER
    // pattern must run here first. Mirrors src/db.ts ensureAuthUserProfileColumns().
    try {
      const authInfo = db.prepare('PRAGMA table_info("AuthUsers")').all() as any[];
      if (authInfo.length > 0) {
        const existingCols = new Set(authInfo.map((c) => c.name));
        const profileCols: Array<[string, string]> = [
          ["displayName", "TEXT"],
          ["avatarUrl", "TEXT"],
          ["gamerTag", "TEXT"],
          ["profileVisibility", "TEXT"],
          ["libraryVisibility", "TEXT"],
        ];
        for (const [col, type] of profileCols) {
          if (!existingCols.has(col)) {
            db.prepare(`ALTER TABLE "AuthUsers" ADD COLUMN "${col}" ${type}`).run();
          }
        }
      }
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_users_gamerTag" ON "AuthUsers" ("gamerTag") WHERE "gamerTag" IS NOT NULL',
      );
    } catch (e) {
      console.error("[global-setup] Failed to self-heal AuthUsers profile columns:", e);
    }

    // Sprint 4 (EPIC-06): self-heal the InstalledMods table so the compare
    // matrix engine (src/routes/compare.ts) can join on gameId / isActive.
    // An existing data/test_mgpl.db created before this sprint predates these
    // columns, and CREATE TABLE IF NOT EXISTS never alters an existing table —
    // so the same guarded-ALTER pattern used above for AuthUsers must run here.
    try {
      const modsInfo = db.prepare('PRAGMA table_info("InstalledMods")').all() as any[];
      if (modsInfo.length > 0) {
        const modCols = new Set(modsInfo.map((c) => c.name));
        if (!modCols.has("gameId")) {
          db.prepare('ALTER TABLE "InstalledMods" ADD COLUMN "gameId" TEXT').run();
        }
        if (!modCols.has("isActive")) {
          db.prepare('ALTER TABLE "InstalledMods" ADD COLUMN "isActive" INTEGER DEFAULT 1').run();
        }
      }
    } catch (e) {
      console.error("[global-setup] Failed to self-heal InstalledMods compare columns:", e);
    }

    // Sprint 6.1 (GAP-003): self-heal the Mods catalog is_active column so the
    // mod-link revalidation sweep + read-time suppression work on test DBs that
    // predate the column (CREATE TABLE IF NOT EXISTS never alters existing rows).
    try {
      const modCatalogInfo = db.prepare('PRAGMA table_info("Mods")').all() as any[];
      if (modCatalogInfo.length > 0 && !modCatalogInfo.some((c) => c.name === "is_active")) {
        db.prepare('ALTER TABLE "Mods" ADD COLUMN "is_active" INTEGER NOT NULL DEFAULT 1').run();
      }
    } catch (e) {
      console.error("[global-setup] Failed to self-heal Mods is_active column:", e);
    }

    // Sprint 2 (WUD-2.3 / EPICSEC05): self-heal the strict mod metadata schema
    // columns on pre-existing test DBs (CREATE TABLE IF NOT EXISTS never alters
    // existing tables). Mirrors src/db.ts AUTHORITATIVE_TABLES repair.
    try {
      const modCatalogInfo2 = db.prepare('PRAGMA table_info("Mods")').all() as any[];
      if (modCatalogInfo2.length > 0) {
        const existing = new Set(modCatalogInfo2.map((c) => c.name));
        const modMetaCols: Array<[string, string]> = [
          ["download_count", "INTEGER DEFAULT 0"],
          ["active_installs", "INTEGER DEFAULT 0"],
          ["rating_count", "INTEGER DEFAULT 0"],
          ["version_tag", "TEXT"],
          ["author_handle", "TEXT"],
          ["description", "TEXT"],
        ];
        for (const [col, type] of modMetaCols) {
          if (!existing.has(col)) {
            db.prepare(`ALTER TABLE "Mods" ADD COLUMN "${col}" ${type}`).run();
          }
        }
      }
    } catch (e) {
      console.error("[global-setup] Failed to self-heal Mods metadata columns:", e);
    }

    // Sprint 5 (EPICUX05): self-heal the extended rig-telemetry columns on the
    // scanned Devices table for stale test DBs (CREATE TABLE IF NOT EXISTS never
    // alters an existing table). Mirrors src/routes/devices.ts + the Hardware
    // Explorer route so the device seed upsert can write cpuCores etc.
    try {
      const devicesInfo = db.prepare('PRAGMA table_info("Devices")').all() as any[];
      if (devicesInfo.length > 0) {
        const existing = new Set(devicesInfo.map((c) => c.name));
        const deviceCols: Array<[string, string]> = [
          ["lastScanAt", "TEXT"],
          ["cpuCores", "INTEGER"],
          ["storageType", "TEXT"],
          ["storageFreeGb", "REAL"],
          ["scanConfidence", "TEXT"],
          ["deviceClass", "TEXT"],
          ["thermalCapabilities", "TEXT"],
        ];
        for (const [col, type] of deviceCols) {
          if (!existing.has(col)) {
            db.prepare(`ALTER TABLE "Devices" ADD COLUMN "${col}" ${type}`).run();
          }
        }
      }
    } catch (e) {
      console.error("[global-setup] Failed to self-heal Devices rig-telemetry columns:", e);
    }

    // Sprint 2 (WUD-2.1 / EPIC-01): self-heal the encrypted platform-link vault
    // columns on pre-existing test DBs. CREATE TABLE IF NOT EXISTS never alters
    // an existing table, so guarded ALTERs converge old test DBs to the
    // authoritative shape (mirrors src/db.ts verifySchemaIntegrity()).
    try {
      const authAccountsInfo = db.prepare('PRAGMA table_info("AuthAccounts")').all() as any[];
      if (authAccountsInfo.length > 0) {
        const existing = new Set(authAccountsInfo.map((c) => c.name));
        for (const col of ["tokenEnc", "tokenIv"]) {
          if (!existing.has(col)) {
            db.prepare(`ALTER TABLE "AuthAccounts" ADD COLUMN "${col}" TEXT`).run();
          }
        }
      }
    } catch (e) {
      console.error("[global-setup] Failed to self-heal AuthAccounts token columns:", e);
    }

    try {
      const handlesInfo = db.prepare('PRAGMA table_info("AppPlatformHandles")').all() as any[];
      if (handlesInfo.length > 0) {
        const existing = new Set(handlesInfo.map((c) => c.name));
        for (const col of ["epicUsername", "ubisoftUsername"]) {
          if (!existing.has(col)) {
            db.prepare(`ALTER TABLE "AppPlatformHandles" ADD COLUMN "${col}" TEXT`).run();
          }
        }
        if (!existing.has("hidePlatformIds")) {
          db.prepare(
            'ALTER TABLE "AppPlatformHandles" ADD COLUMN "hidePlatformIds" INTEGER NOT NULL DEFAULT 0',
          ).run();
        }
      }
    } catch (e) {
      console.error("[global-setup] Failed to self-heal AppPlatformHandles columns:", e);
    }

    // Sprint 7 (WUD-7.1) / Prisma parity: self-heal the platform-intel relation
    // chain (AppGames / AppReviews / AppCompletionRoadmap) so Prisma-backed
    // routes such as GET /api/platforms/:platform/summary never hit P2022
    // ColumnNotFound against a stale test DB. The regenerated Prisma client
    // SELECTs the full canonical column set from schema.prisma, while an
    // existing data/test_mgpl.db predating those additive columns only exposes
    // the legacy subset — CREATE TABLE IF NOT EXISTS never alters an existing
    // table, so guarded ALTERs converge old test DBs to the authoritative shape
    // (mirrors src/db.ts verifySchemaIntegrity()).
    const ensureTestColumns = (table: string, cols: Array<[string, string]>): void => {
      const info = db.prepare(`PRAGMA table_info("${table}")`).all() as any[];
      if (info.length === 0) return;
      const existing = new Set(info.map((c: any) => c.name));
      for (const [col, type] of cols) {
        if (!existing.has(col)) {
          db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${type}`).run();
        }
      }
    };
    try {
      ensureTestColumns("AppGames", [
        ["Original Game Release Date", "TEXT"],
        ["Estimated Game Time", "TEXT"],
        ["ROG Ally Playability", "TEXT"],
        ["Laptop Playability", "TEXT"],
        ["Is RPG", "TEXT"],
        ["Is Turn-Based", "TEXT"],
        ["Is Action", "TEXT"],
        ["Is Strategy / Tactics", "TEXT"],
        ["Is Sim / Management", "TEXT"],
        ["Is Roguelike / Deckbuilder", "TEXT"],
        ["Is Shooter / FPS", "TEXT"],
        ["Is Platformer / Metroidvania", "TEXT"],
        ["Is Story / Narrative", "TEXT"],
        ["Is Sports / Racing", "TEXT"],
        ["Is Horror / Survival", "TEXT"],
        ["Official Website URL", "TEXT"],
        ["Nexus Availability", "TEXT"],
        ["reviewUrl", "TEXT"],
        ["developer", "TEXT"],
        ["youtubeUrl", "TEXT"],
        ["ignUrl", "TEXT"],
        ["gamefaqsUrl", "TEXT"],
        ["modNotifications", "TEXT"],
        ["synopsis", "TEXT"],
      ]);
      ensureTestColumns("AppReviews", [
        ["ReviewID", "TEXT"],
        ["Review Summary / Score", "TEXT"],
        ["Worth Playing Grade", "TEXT"],
        ["Review URL", "TEXT"],
        ["Verification Status", "TEXT"],
        ["Last Checked Date", "TEXT"],
      ]);
      ensureTestColumns("AppCompletionRoadmap", [
        ["RoadmapID", "TEXT"],
        ["Missable Content / Trophies?", "TEXT"],
        ["Min Playthroughs for 100%", "TEXT"],
        ["Trophy / Platinum Difficulty", "TEXT"],
        ["Trophy Roadmap & Guide URL", "TEXT"],
      ]);
    } catch (e) {
      console.error(
        "[global-setup] Failed to self-heal AppGames/AppReviews/AppCompletionRoadmap columns:",
        e,
      );
    }

    // Sprint 1 (FEAT-AUTH-0001): Precompute Argon2id hashes for the
    // deterministic mock users before the sync transaction starts. This keeps
    // better-sqlite3's synchronous seed() simple while still exercising the
    // memory-hard hash path used by the auth routes.
    const authHashes: Record<string, string> = {};
    for (const u of AUTH_USERS) {
      authHashes[u.id] = await argon2.hash(u.password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
    }

    // Clear any rows left behind by a previous run, then seed deterministic
    // records. Clearing inside the same transaction guarantees a clean slate
    // without relying on deleting the file (which OneDrive locks).
    const tx = db.transaction(() => {
      clearTables(db);
      seed(db, authHashes);
    });
    tx();
    db.prepare(
      "INSERT OR REPLACE INTO mgpl_seed_marker (seedIdentifier, seededAt) VALUES (?, ?)",
    ).run(SEED_IDENTIFIER, new Date().toISOString());

    // Verify the authoritative tables exist and foreign keys are clean.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    const tableNames = new Set(tables.map((t) => t.name));
    const required = [
      "AuthUsers",
      "AuthAccounts",
      "AppGames",
      "Devices",
      "AppDevices",
      "AppWishlist",
      "AppRetroTracking",
      "AppGameTags",
      "AppGameNotes",
      "AppBacklog",
      "AppPlaySessions",
      "AppPriceAlerts",
      "AppDealsWishlist",
      "AppDealPriceHistory",
      "InstalledMods",
      "ModVersions",
      "ModDependencies",
      "ModLoadOrder",
      "AppCompletionRoadmapCache",
      "AppTracking",
      "AppOwnership",
      "AppFriendships",
      "AppPlatformHandles",
      "AuthPlatformLinks",
      "release_radar",
    ];
    const missing = required.filter((t) => !tableNames.has(t));
    if (missing.length > 0) {
      throw new Error(`[global-setup] Missing authoritative tables: ${missing.join(", ")}`);
    }

    const fkViolations = db.prepare("PRAGMA foreign_key_check").all() as any[];
    if (fkViolations.length > 0) {
      console.warn(
        `[global-setup] foreign_key_check found ${fkViolations.length} orphaned reference(s).`,
      );
    }

    console.log(
      `[global-setup] Seeded ${TEST_DB_PATH}: ${DEVICES.length} devices, ${GAMES.length} games, ` +
        `${WISHLIST.length} wishlist, ${TAGS.length} tags, ${NOTES.length} notes, ` +
        `${OWNERSHIP.length}+auto ownerships, ${TRACKING.length} tracking rows, ${REVIEWS.length} reviews, ` +
        `${ROADMAP.length} roadmap rows. FK violations: ${fkViolations.length}.`,
    );

    // EPIC-UX-REFINE-0002: write a deterministic giveaway cache with a relative
    // future end_date so the home surface's "Ends in …" urgency badge always
    // renders regardless of the wall-clock date. The real cache is written by the
    // GamerPower cron (disabled under DISABLE_CRON in test mode), so the git-ignored
    // cache file can otherwise go stale (past end_date) and break the freebie badge.
    try {
      const cacheDir = path.join(process.cwd(), "scripts", ".cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 3);
      const endDateStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")} 23:59:00`;
      fs.writeFileSync(
        path.join(cacheDir, "gamerpower_giveaways.json"),
        JSON.stringify(
          [
            {
              id: 1,
              title: "Free Indie Bundle Giveaway",
              worth: "$19.99",
              platforms: "PC",
              open_giveaway_url: "https://www.gamerpower.com/",
              gamerpower_url: "https://www.gamerpower.com/",
              image: "",
              thumbnail: "",
              description: "Deterministic hermetic giveaway for E2E tests.",
              type: "Game",
              status: "Active",
              end_date: endDateStr,
            },
          ],
          null,
          2,
        ),
        "utf8",
      );
    } catch (e) {
      console.error("[global-setup] Failed to write giveaway cache:", e);
    }

    // EPIC-UX-REFINE-0002: write a deterministic ITAD deal cache as well. The
    // dashboard reads this git-ignored file directly rather than making an axios
    // request, so the server-side external API mock cannot provide clean-checkout
    // data for the home top-deal cards on its own.
    try {
      const cacheDir = path.join(process.cwd(), "scripts", ".cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(cacheDir, "itad_deals.json"),
        JSON.stringify(
          {
            list: [
              {
                id: "mock-itad-cp2077",
                slug: "cyberpunk-2077",
                title: "Cyberpunk 2077",
                type: "game",
                deal: {
                  shop: { name: "Fanatical" },
                  price: { amount: 16.49 },
                  regular: { amount: 59.99 },
                  cut: 72,
                  historyLow: { amount: 16.49 },
                  url: "https://isthereanydeal.com/game/cyberpunk-2077/",
                },
                assets: { boxart: "", banner300: "" },
              },
              {
                id: "mock-itad-tw3",
                slug: "the-witcher-3-wild-hunt",
                title: "The Witcher 3: Wild Hunt",
                type: "game",
                deal: {
                  shop: { name: "GOG" },
                  price: { amount: 9.99 },
                  regular: { amount: 39.99 },
                  cut: 75,
                  historyLow: { amount: 9.99 },
                  url: "https://isthereanydeal.com/game/the-witcher-3-wild-hunt/",
                },
                assets: { boxart: "", banner300: "" },
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (e) {
      console.error("[global-setup] Failed to write ITAD deals cache:", e);
    }
  } finally {
    db.close();
  }
}
