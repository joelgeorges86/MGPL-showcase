import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";
import {
  overrideUpstream,
  clearUpstreamOverride,
  clearAllUpstreamOverrides,
} from "../services/externalMocks";
import { resetAllCircuitBreakers } from "../utils/storefrontCircuitBreaker";
import { normalizePlatform } from "../lib/platformTaxonomy";
import { sendApiError } from "../middleware/errorSanitizer";

/**
 * Sprint 27 (FEAT-0161) — Full-Platform Mock Seeding & E2E Validation Harness.
 *
 * POST   /api/mock/seed  -> upsert a deterministic full-platform test dataset
 *                           (fleet devices, games, wishlist, tags, notes).
 * DELETE /api/mock/clear -> remove only the seeded records, returning the DB
 *                           to its pre-seed clean state.
 *
 * The dataset is intentionally deterministic so the Playwright E2E suite can
 * assert exact labels, badges, scores and store comparisons. All writes are
 * upserts keyed on native unique constraints (deviceId / GameID / gameId) so
 * re-seeding is idempotent.
 */

const router = Router();

// ---------------------------------------------------------------------------
// AI-081 (#160): every route in this file is test-only. The seed and clear
// routes had no guard, so production builds served them to any caller. One
// router-level check now covers every route here, including any added later.
// The per-route checks below are kept; they are redundant but harmless.
// ---------------------------------------------------------------------------

export function mockRoutesEnabled(): boolean {
  return process.env.NODE_ENV === "test";
}

router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!mockRoutesEnabled()) {
    return res.status(404).json({ success: false, error: "Not available outside test mode" });
  }
  return next();
});

// GET /api/mock/status -> lets the browser decide whether to render the Dev
// Seed Bar. Outside test mode the guard above answers 404 instead.
router.get("/status", (_req: Request, res: Response) => {
  res.json({ success: true, enabled: true });
});

// ---------------------------------------------------------------------------
// Sprint 1 (EPIC-DEAL-001): test-only upstream failure & breaker controls.
// Wired only when NODE_ENV === 'test' so the deals-security spec can simulate
// a storefront outage and tripped circuit breaker deterministically.
// ---------------------------------------------------------------------------

router.post("/upstream", (req: Request, res: Response) => {
  if (process.env.NODE_ENV !== "test") {
    return res.status(404).json({ success: false, error: "Not available outside test mode" });
  }
  const { host, status } = req.body || {};
  if (typeof host !== "string" || !host.trim()) {
    return res.status(400).json({ success: false, error: "host is required" });
  }
  const statusCode = Number(status);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return res.status(400).json({ success: false, error: "status must be an integer 100-599" });
  }
  overrideUpstream(host.trim(), statusCode);
  return res.json({ success: true, host, status: statusCode });
});

router.delete("/upstream", (req: Request, res: Response) => {
  if (process.env.NODE_ENV !== "test") {
    return res.status(404).json({ success: false, error: "Not available outside test mode" });
  }
  const { host } = req.body || {};
  if (typeof host === "string" && host.trim()) {
    clearUpstreamOverride(host.trim());
  } else {
    clearAllUpstreamOverrides();
  }
  return res.json({ success: true, cleared: true });
});

router.post("/breaker/reset", (_req: Request, res: Response) => {
  if (process.env.NODE_ENV !== "test") {
    return res.status(404).json({ success: false, error: "Not available outside test mode" });
  }
  resetAllCircuitBreakers();
  return res.json({ success: true, reset: true });
});

// ---------------------------------------------------------------------------
// Seeded identifiers (used by both seed and clear so we never delete user data)
// ---------------------------------------------------------------------------
const SEEDED_DEVICE_IDS = [
  "rig-ultra-4080",
  "stealth-laptop-4060",
  "steam-deck-oled",
  "ps5-digital",
];

const SEEDED_GAME_IDS = [
  "cyberpunk-2077",
  "monster-hunter-wilds",
  "helldivers-2",
  "the-witcher-3",
  "civilization-vi",
  "bloodborne",
];

const SEEDED_WISHLIST_IDS = [
  "cyberpunk-2077",
  "monster-hunter-wilds",
  "the-witcher-3",
  "civilization-vi",
  "bloodborne",
];

const SEEDED_OWNERSHIP_IDS = [
  "own-cyberpunk-2077",
  "own-monster-hunter-wilds",
  "own-helldivers-2",
  "own-the-witcher-3",
  "own-civilization-vi",
  "own-bloodborne",
];

// Sprint 2 (FEAT-MULTITENANT): Seeded user-state rows (wishlist/tags/notes)
// belong to the deterministic mock auth user from test/global-setup.ts so the
// mock seed/clear never touches (or leaks) another tenant's rows.
const SEED_USER_ID = "auth-user-alex-gamer";

// ---------------------------------------------------------------------------
// Seed data
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
  { gameId: "helldivers-2", tagName: "Restricted / Anti-Cheat", colorHex: "#ef4444" },
  { gameId: "cyberpunk-2077", tagName: "Moddable", colorHex: "#38bdf8" },
  { gameId: "the-witcher-3", tagName: "Moddable", colorHex: "#38bdf8" },
];

const NOTES: Array<{ gameId: string; noteMarkdown: string }> = [
  { gameId: "cyberpunk-2077", noteMarkdown: "Seeded composite score reference title." },
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
    // literal "PS4" platform string). Kept in sync with the global-setup seed
    // so POST /api/mock/seed cannot overwrite the deterministic fixture with a
    // platform string ("PlayStation 4") that the platform hub HUB-01 test's
    // /ps4/i assertion cannot match.
    Platform: "PS4",
    "Store URL": "https://store.playstation.com/",
    Format: "Digital",
  },
];

// ---------------------------------------------------------------------------
// POST /api/mock/seed
// ---------------------------------------------------------------------------
router.post("/seed", (_req: Request, res: Response) => {
  try {
    const seed = db.transaction(() => {
      // --- Fleet devices (Devices table, deviceId PK) ---
      const upsertDevice = db.prepare(`
        INSERT INTO "Devices" (
          deviceId, deviceName, formFactor, gpuModel, vramGb, cpuModel, cpuCores, ramGb,
          motherboard, caseModel, psu, storageCapacityGb, os, batteryWh,
          isArchived, tdpWatts, updatedAt
        ) VALUES (
          @deviceId, @deviceName, @formFactor, @gpuModel, @vramGb, @cpuModel, @cpuCores, @ramGb,
          @motherboard, @caseModel, @psu, @storageCapacityGb, @os, @batteryWh,
          @isArchived, @tdpWatts, CURRENT_TIMESTAMP
        )
        ON CONFLICT(deviceId) DO UPDATE SET
          deviceName = excluded.deviceName,
          formFactor = excluded.formFactor,
          gpuModel = excluded.gpuModel,
          vramGb = excluded.vramGb,
          cpuModel = excluded.cpuModel,
          cpuCores = excluded.cpuCores,
          ramGb = excluded.ramGb,
          motherboard = excluded.motherboard,
          caseModel = excluded.caseModel,
          psu = excluded.psu,
          storageCapacityGb = excluded.storageCapacityGb,
          os = excluded.os,
          batteryWh = excluded.batteryWh,
          isArchived = excluded.isArchived,
          tdpWatts = excluded.tdpWatts,
          updatedAt = CURRENT_TIMESTAMP
      `);
      for (const d of DEVICES) upsertDevice.run(d);

      // --- Games (AppGames table, GameID PK) ---
      const upsertGame = db.prepare(`
        INSERT INTO "AppGames" (
          "GameID", "Game Title", "Primary Genre", "Storage Size", "Min RAM GB",
          "Min VRAM GB", "SSD Required?", "Active", "Nexus Mods URL", "cover_url",
          "nexusUrl", "nexusModCount", "trackedModCount", "platformStoreUrls"
        ) VALUES (
          @GameID, @GameTitle, @PrimaryGenre, @StorageSize, @MinRAMGB,
          @MinVRAMGB, @SSDRequired, @Active, @NexusModsURL, @cover_url,
          @nexusUrl, @nexusModCount, @trackedModCount, @platformStoreUrls
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
          "platformStoreUrls" = excluded."platformStoreUrls"
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
        });
      }

      // --- Wishlist (AppWishlist, UNIQUE(userId, gameId)) ---
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
      for (const w of WISHLIST) upsertWishlist.run({ userId: SEED_USER_ID, ...w });

      // --- Tags (AppGameTags, UNIQUE(userId, gameId, tagName)) ---
      const upsertTag = db.prepare(`
        INSERT INTO "AppGameTags" (userId, gameId, tagName, colorHex)
        VALUES (@userId, @gameId, @tagName, @colorHex)
        ON CONFLICT(userId, gameId, tagName) DO UPDATE SET colorHex = excluded.colorHex
      `);
      for (const t of TAGS) upsertTag.run({ userId: SEED_USER_ID, ...t });

      // --- Notes (AppGameNotes, UNIQUE(userId, gameId)) ---
      const upsertNote = db.prepare(`
        INSERT INTO "AppGameNotes" (userId, gameId, noteMarkdown, updatedAt)
        VALUES (@userId, @gameId, @noteMarkdown, CURRENT_TIMESTAMP)
        ON CONFLICT(userId, gameId) DO UPDATE SET
          noteMarkdown = excluded.noteMarkdown,
          updatedAt = CURRENT_TIMESTAMP
      `);
      for (const n of NOTES) upsertNote.run({ userId: SEED_USER_ID, ...n });

      // --- Ownership (AppOwnership table, OwnershipID PK) ---
      const upsertOwnership = db.prepare(`
        INSERT INTO "AppOwnership" (
          "OwnershipID", "GameID", "Platform", "platformCanonical", "Store URL", "Format"
        ) VALUES (
          @OwnershipID, @GameID, @Platform, @platformCanonical, @StoreURL, @Format
        )
        ON CONFLICT("OwnershipID") DO UPDATE SET
          "GameID" = excluded."GameID",
          "Platform" = excluded."Platform",
          "platformCanonical" = excluded."platformCanonical",
          "Store URL" = excluded."Store URL",
          "Format" = excluded."Format"
      `);
      for (const o of OWNERSHIP) {
        upsertOwnership.run({
          OwnershipID: o.OwnershipID,
          GameID: o.GameID,
          Platform: o.Platform,
          platformCanonical: normalizePlatform(o.Platform) ?? null,
          StoreURL: o["Store URL"],
          Format: o.Format,
        });
      }
    });

    seed();

    res.json({
      success: true,
      seeded: {
        devices: DEVICES.length,
        games: GAMES.length,
        wishlist: WISHLIST.length,
        tags: TAGS.length,
        notes: NOTES.length,
      },
    });
  } catch (err: any) {
    console.error("Error in POST /api/mock/seed:", err?.message || err);
    sendApiError(res, 500, "Failed to seed mock data");
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/mock/clear
// ---------------------------------------------------------------------------
router.delete("/clear", (_req: Request, res: Response) => {
  try {
    const clear = db.transaction(() => {
      const deviceIds = SEEDED_DEVICE_IDS.map(() => "?").join(", ");
      db.prepare(`DELETE FROM "Devices" WHERE deviceId IN (${deviceIds})`).run(
        ...SEEDED_DEVICE_IDS,
      );

      const gameIds = SEEDED_GAME_IDS.map(() => "?").join(", ");
      db.prepare(`DELETE FROM "AppGames" WHERE "GameID" IN (${gameIds})`).run(...SEEDED_GAME_IDS);

      const wishIds = SEEDED_WISHLIST_IDS.map(() => "?").join(", ");
      db.prepare(`DELETE FROM "AppWishlist" WHERE userId = ? AND gameId IN (${wishIds})`).run(
        SEED_USER_ID,
        ...SEEDED_WISHLIST_IDS,
      );

      const tagIds = SEEDED_GAME_IDS.map(() => "?").join(", ");
      db.prepare(`DELETE FROM "AppGameTags" WHERE userId = ? AND gameId IN (${tagIds})`).run(
        SEED_USER_ID,
        ...SEEDED_GAME_IDS,
      );

      db.prepare(`DELETE FROM "AppGameNotes" WHERE userId = ? AND gameId IN (${tagIds})`).run(
        SEED_USER_ID,
        ...SEEDED_GAME_IDS,
      );

      const ownIds = SEEDED_OWNERSHIP_IDS.map(() => "?").join(", ");
      db.prepare(`DELETE FROM "AppOwnership" WHERE "OwnershipID" IN (${ownIds})`).run(
        ...SEEDED_OWNERSHIP_IDS,
      );
    });

    clear();

    res.json({ success: true, cleared: true });
  } catch (err: any) {
    console.error("Error in DELETE /api/mock/clear:", err?.message || err);
    sendApiError(res, 500, "Failed to clear mock data");
  }
});

export default router;
