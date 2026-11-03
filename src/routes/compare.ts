import { Router, Request, Response } from "express";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import path from "path";
import fs from "fs";
import { sendApiError } from "../middleware/errorSanitizer";
import { safeCoerce } from "../utils/ingest";
import {
  getCachedSteamSpecs,
  extractSteamAppId,
  seedSteamSpecsCache,
  enrichSteamSpecsForGame,
} from "../services/steamSpecs";

// Sprint 7 (WUD-7.3): merge the curated public Steam Store requirements into
// the on-disk cache once at module load so the comparison matrix renders real
// CPU/GPU/RAM/VRAM values deterministically (live fetches refresh the cache).
seedSteamSpecsCache();

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });
const dbWrite: DatabaseType = openDatabase(dbPath);

const router = Router();

/**
 * Interface for game comparison result
 */
interface GameComparisonResult {
  gameId: string;
  title: string | null;
  mainStoryHours: number | null;
  estimatedBatteryRuntime: number | null;
  activeModCount: number;
  genres: string[];
  storageSize: string | null;
  coverUrl: string | null;
  minRamGb: number | null;
  minVramGb: number | null;
  criticScore: number | null;
  recommendationPercent: number | null;
  platforms: string[];
  // Device-specific metrics
  targetFps?: number | string | null;
  playabilityBadge?: string | null;
  deviceBatteryRuntimeText?: string | null;
  ramHeadroomGb?: number | null;
  vramHeadroomGb?: number | null;
  // WUD-SPRINT9.1-COMPARE-MATRIX-ENGINE additions
  developer: string | null;
  coverImage: string | null;
  specs: {
    minimum: {
      ramGb: string | null;
      vramGb: string | null;
      cpu: string | null;
      gpu: string | null;
      storage: string | null;
      ssdRequired: string | null;
    };
    recommended: {
      ramGb: string | null;
      vramGb: string | null;
      cpu: string | null;
      gpu: string | null;
      storage: string | null;
      ssdRequired: string | null;
    };
  };
  ownedPlatforms: string[];
  platformMatrix: any[];
  hltb: { mainStory: number | null; completionist: number | null };
  frictions: any[];
  frictionScore: { score: number; level: string; factors: string[] };
}

/**
 * Interface for Device info
 */
interface DeviceInfo {
  deviceId: string;
  deviceName: string | null;
  ramGb: number | null;
  vramGb: number | null;
  batteryWh: number | null;
  gpuModel: string | null;
  formFactor?: string | null;
}

/**
 * Sprint 6.1 (GAP-006): Compare Matrix safeValue enforcement. Rejects null,
 * undefined, empty, HTML-injection and javascript: payloads — malformed values
 * resolve to null so the client renders its "Data unavailable" fallback.
 */
function safeValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (/<[a-z][^>]*>/i.test(s) || /javascript:/i.test(s)) return null;
  return s;
}

function safeNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeStringArray(list: string[]): string[] {
  return list.map((item) => safeValue(item)).filter((item): item is string => item !== null);
}

/**
 * Ensure GameDeviceProfiles table exists
 */
function ensureGameDeviceProfilesTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS "GameDeviceProfiles" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "gameId" TEXT NOT NULL,
        "deviceId" TEXT NOT NULL,
        "estimatedBatteryRuntime" REAL,
        "isPluggedOnly" INTEGER DEFAULT 0,
        "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("gameId", "deviceId")
      )
    `,
      )
      .run();
  } catch (e) {
    console.error("Failed to ensure GameDeviceProfiles table:", e);
  }
}

/**
 * Ensure InstalledMods table exists
 */
function ensureInstalledModsTable() {
  try {
    dbWrite
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS "InstalledMods" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "gameId" TEXT NOT NULL,
        "modId" TEXT NOT NULL,
        "modName" TEXT,
        "isActive" INTEGER DEFAULT 1,
        "installed_at" TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("gameId", "modId")
      )
    `,
      )
      .run();

    // Self-heal schema drift: the db.ts DDL (src/db.ts initDb) may have created
    // InstalledMods with the gameDomain-based shape (modId/gameDomain/modName/
    // version/installedAt) that lacks the gameId/isActive columns this compare
    // matrix engine joins on. CREATE TABLE IF NOT EXISTS never alters an existing
    // table, so backfill the missing columns here (mirrors test/global-setup.ts).
    const modsInfo = dbWrite.prepare('PRAGMA table_info("InstalledMods")').all() as Array<{
      name: string;
    }>;
    const modCols = new Set(modsInfo.map((c) => c.name));
    if (!modCols.has("gameId")) {
      dbWrite.prepare('ALTER TABLE "InstalledMods" ADD COLUMN "gameId" TEXT').run();
    }
    if (!modCols.has("isActive")) {
      dbWrite.prepare('ALTER TABLE "InstalledMods" ADD COLUMN "isActive" INTEGER DEFAULT 1').run();
    }
  } catch (e) {
    console.error("Failed to ensure InstalledMods table:", e);
  }
}

/**
 * Helper to get all genres for a game, falling back to primary genre
 */
function getGenresForGame(
  database: DatabaseType,
  gameId: string,
  primaryGenre: string | null,
): string[] {
  try {
    // AppGenres / AppGameGenreMap may be absent on pre-migration or minimal
    // test databases — fall back to the primary genre instead of SQLITE_ERROR.
    if (!tableExists(database, "AppGenres") || !tableExists(database, "AppGameGenreMap")) {
      return primaryGenre ? [primaryGenre] : [];
    }
    const rows = database
      .prepare(
        `
      SELECT g."GenreName" as name
      FROM "AppGenres" g
      JOIN "AppGameGenreMap" m ON m."GenreID" = g."GenreID"
      WHERE m."GameID" = ?
    `,
      )
      .all(gameId) as { name: string }[];

    if (rows.length > 0) {
      return rows.map((r) => r.name);
    }
  } catch (e) {
    console.warn(`Failed to fetch genres for game ${gameId}:`, e);
  }
  return primaryGenre ? [primaryGenre] : [];
}

/**
 * Helper to get platforms owned for a game
 */
function getPlatformsForGame(database: DatabaseType, gameId: string): string[] {
  try {
    const rows = database
      .prepare(
        `
      SELECT DISTINCT "Platform" as platform
      FROM "AppOwnership"
      WHERE "GameID" = ? AND "Platform" IS NOT NULL AND "Platform" != ''
    `,
      )
      .all(gameId) as { platform: string }[];

    if (rows.length > 0) {
      return rows.map((r) => r.platform);
    }
  } catch (e) {
    console.warn(`Failed to fetch platforms for game ${gameId}:`, e);
  }
  return [];
}

/**
 * Read the ITAD deals cache (mirrors games.ts so /api/games/compare stays self-contained).
 */
function getCachedItadDeals(): any[] {
  try {
    const dealsPath = path.join(process.cwd(), "scripts", ".cache", "itad_deals.json");
    if (fs.existsSync(dealsPath)) {
      const raw = fs.readFileSync(dealsPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : parsed.list || [];
    }
  } catch (err) {
    console.warn("Failed to load ITAD deals cache:", err);
  }
  return [];
}

/**
 * Normalize a title for fuzzy deal matching (mirrors games.ts).
 */
function sanitizeTitle(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a platform matrix for a game: owned storefronts with purchase price
 * plus unowned ITAD storefront deals with current price / discount / link.
 */
function buildPlatformMatrix(gameTitle: string, ownerships: any[]): any[] {
  const deals = getCachedItadDeals();
  const cleanGameTitle = sanitizeTitle(gameTitle);

  const matchingDeals = deals.filter((d: any) => {
    const dealTitle = sanitizeTitle(d.title || d.slug || "");
    if (!dealTitle || !cleanGameTitle) return false;
    return (
      dealTitle === cleanGameTitle ||
      dealTitle.includes(cleanGameTitle) ||
      cleanGameTitle.includes(dealTitle)
    );
  });

  const matrix: any[] = [];
  const ownedPlatformNames = new Set<string>();

  for (const o of ownerships) {
    const pName = o.Platform || o.platform || "PC";
    ownedPlatformNames.add(pName.toLowerCase());

    const dealMatch = matchingDeals.find((d: any) => {
      const shopName = (d.deal?.shop?.name || "").toLowerCase();
      const drmNames = (d.deal?.drm || []).map((drm: any) => (drm.name || "").toLowerCase());
      const pLow = pName.toLowerCase();
      return (
        shopName.includes(pLow) ||
        pLow.includes(shopName) ||
        drmNames.some((n: string) => n.includes(pLow) || pLow.includes(n))
      );
    });

    const pricePaid = o["Price Paid"] ?? o.pricePaid ?? o.purchasePrice ?? null;

    matrix.push({
      platform: pName,
      isOwned: true,
      purchasePrice:
        pricePaid !== null && pricePaid !== undefined
          ? typeof pricePaid === "number"
            ? `$${pricePaid.toFixed(2)}`
            : String(pricePaid)
          : null,
      currentPrice: dealMatch?.deal?.price?.amount
        ? `$${dealMatch.deal.price.amount.toFixed(2)}`
        : null,
      discountPercent: dealMatch?.deal?.cut ? `${dealMatch.deal.cut}%` : null,
      regularPrice: dealMatch?.deal?.regular?.amount
        ? `$${dealMatch.deal.regular.amount.toFixed(2)}`
        : null,
      storeUrl: o["Store URL"] || o.storeUrl || o.storeURL || dealMatch?.deal?.url || null,
      ownershipType: o["Ownership Access Type"] || o.ownershipType || "Owned License",
      edition: o.Edition || o.edition || "Standard Edition",
    });
  }

  for (const d of matchingDeals) {
    const shopName = d.deal?.shop?.name || "Store";
    if (!ownedPlatformNames.has(shopName.toLowerCase())) {
      ownedPlatformNames.add(shopName.toLowerCase());
      matrix.push({
        platform: shopName,
        isOwned: false,
        purchasePrice: null,
        currentPrice: d.deal?.price?.amount ? `$${d.deal.price.amount.toFixed(2)}` : null,
        discountPercent: d.deal?.cut ? `${d.deal.cut}%` : null,
        regularPrice: d.deal?.regular?.amount ? `$${d.deal.regular.amount.toFixed(2)}` : null,
        storeUrl: d.deal?.url || null,
        ownershipType: "Storefront Deal",
        edition: "Standard Edition",
      });
    }
  }

  if (matrix.length === 0) {
    matrix.push({
      platform: "PC / Storefront",
      isOwned: false,
      purchasePrice: null,
      currentPrice: null,
      discountPercent: null,
      regularPrice: null,
      storeUrl: null,
      ownershipType: "Not Owned / Store Unlisted",
      edition: "N/A",
    });
  }

  return matrix;
}

/**
 * Cache of column names per table so optional-column guards only hit PRAGMA once.
 */
const _tableColCache = new Map<string, Set<string>>();
function getTableColumns(database: DatabaseType, table: string): Set<string> {
  const cached = _tableColCache.get(table);
  if (cached) return cached;
  try {
    const cols = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const set = new Set(cols.map((c) => c.name));
    _tableColCache.set(table, set);
    return set;
  } catch (e) {
    const empty = new Set<string>();
    _tableColCache.set(table, empty);
    return empty;
  }
}

/**
 * Check whether a table exists in the live schema. Guards taxonomy/supplemental
 * queries against pre-migration or minimal (test) databases so the compare route
 * never surfaces a SQLITE_ERROR for absent tables — it falls back instead.
 */
const _tableExistsCache = new Map<string, boolean>();
function tableExists(database: DatabaseType, table: string): boolean {
  const cached = _tableExistsCache.get(table);
  if (cached !== undefined) return cached;
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) as { c: number };
    const exists = !!row && row.c > 0;
    _tableExistsCache.set(table, exists);
    return exists;
  } catch (e) {
    _tableExistsCache.set(table, false);
    return false;
  }
}

/**
 * Fetch raw AppOwnership rows for a game.
 */
function getOwnershipsForGame(database: DatabaseType, gameId: string): any[] {
  try {
    return database
      .prepare(
        `
      SELECT * FROM "AppOwnership" WHERE "GameID" = ?
    `,
      )
      .all(gameId) as any[];
  } catch (e) {
    console.warn(`Failed to fetch ownerships for game ${gameId}:`, e);
  }
  return [];
}

/**
 * Fetch raw AppGameFriction rows for a game.
 */
function getFrictionsForGame(database: DatabaseType, gameId: string): any[] {
  try {
    // AppGameFriction may be absent on pre-migration or minimal test databases —
    // return an empty list instead of surfacing SQLITE_ERROR.
    if (!tableExists(database, "AppGameFriction")) {
      return [];
    }
    return database
      .prepare(
        `
      SELECT * FROM "AppGameFriction" WHERE "GameID" = ?
    `,
      )
      .all(gameId) as any[];
  } catch (e) {
    console.warn(`Failed to fetch frictions for game ${gameId}:`, e);
  }
  return [];
}

/**
 * Fetch optional AppGames columns (developer, header image, CPU/GPU, recommended
 * rows) with PRAGMA-guarded column existence so pre-migration DBs never throw.
 */
function getGameSupplemental(database: DatabaseType, gameId: string): any {
  try {
    const cols = getTableColumns(database, "AppGames");
    const row = database.prepare(`SELECT * FROM "AppGames" WHERE "GameID" = ?`).get(gameId) as any;
    if (!row) return {};
    const pick = (names: string[]) => {
      for (const n of names) {
        if (cols.has(n) && row[n] !== null && row[n] !== undefined && row[n] !== "") return row[n];
      }
      return null;
    };
    return {
      developer: pick(["developer", "Developer"]),
      headerImage: pick(["headerImage", "Header Image"]),
      minCpu: pick(["Min CPU", "Minimum CPU"]),
      minGpu: pick(["Min GPU", "Minimum GPU"]),
      ssdRequired: pick(["SSD Required?", "SSDRequired", "ssdRequired"]),
      recRamGb: pick(["Rec RAM GB", "Recommended RAM GB"]),
      recVramGb: pick(["Rec VRAM GB", "Recommended VRAM GB"]),
      recCpu: pick(["Rec CPU", "Recommended CPU"]),
      recGpu: pick(["Rec GPU", "Recommended GPU"]),
    };
  } catch (e) {
    console.warn(`Failed to fetch supplemental spec fields for game ${gameId}:`, e);
  }
  return {};
}

/**
 * Fetch recommended/minimum spec rows from optional SystemSpecs-style tables
 * (mirrors games.ts fallback). Returns {} when the tables are absent.
 */
function getSystemSpecsForGame(database: DatabaseType, gameId: string): any {
  const tables = ["SystemSpecs", "SystemSpec", "AppSystemSpecs"];
  for (const tbl of tables) {
    try {
      const cols = getTableColumns(database, tbl);
      const idCol = [...cols].find((c) => /^gameid$/i.test(c));
      if (!idCol) continue;
      const row = database
        .prepare(`SELECT * FROM "${tbl}" WHERE "${idCol}" = ?`)
        .get(gameId) as any;
      if (!row) continue;
      const pick = (names: string[]) => {
        for (const n of names) {
          if (cols.has(n) && row[n] !== null && row[n] !== undefined && row[n] !== "")
            return row[n];
        }
        return null;
      };
      return {
        minCpu: pick(["Min CPU", "Minimum CPU"]),
        minGpu: pick(["Min GPU", "Minimum GPU"]),
        minRamGb: pick(["Min RAM GB", "ramGb"]),
        minVramGb: pick(["Min VRAM GB", "vramGb"]),
        ssdRequired: pick(["SSD Required?", "SSDRequired"]),
        recRamGb: pick(["Rec RAM GB", "Recommended RAM GB"]),
        recVramGb: pick(["Rec VRAM GB", "Recommended VRAM GB"]),
        recCpu: pick(["Rec CPU", "Recommended CPU"]),
        recGpu: pick(["Rec GPU", "Recommended GPU"]),
      };
    } catch (e) {
      // try next candidate table
    }
  }
  return {};
}

/**
 * Normalize a friction row into camelCase client aliases (mirrors games.ts).
 */
function normalizeFriction(f: any) {
  if (!f) return null;
  return {
    saveSystemType: f["Save System Type"] ?? f.saveSystemType ?? null,
    avgTimeBetweenSaves: f["Avg Time Between Saves"] ?? f.avgTimeBetweenSaves ?? null,
    suspendPauseFriendly: f["Suspend / Pause Friendly?"] ?? f.suspendPauseFriendly ?? null,
    sessionLength: f["Core Session Loop Length"] ?? f.sessionLength ?? null,
    mentalEnergy: f["Cognitive / Mental Energy Required"] ?? f.mentalEnergy ?? null,
    thirdPartyLauncher: f["Third-Party Launcher Required?"] ?? f.thirdPartyLauncherRequired ?? null,
    alwaysOnline: f["Always-Online Required?"] ?? f.alwaysOnlineRequired ?? null,
    handheldFontUiLegibility:
      f["Handheld Font & UI Legibility"] ?? f.handheldFontUiLegibility ?? null,
  };
}

/**
 * Deterministic friction score (0-100) derived from AppGameFriction columns.
 * Higher = more session friction on handheld. Every active penalty is surfaced
 * in `factors` so the score stays auditable (never a black box).
 */
function computeFrictionScore(f: any): { score: number; level: string; factors: string[] } {
  const factors: string[] = [];
  let score = 0;

  const yesish = (v: any) => {
    if (!v) return false;
    const s = String(v).toLowerCase();
    return ["yes", "true", "1", "required", "always", "y"].some((t) => s.includes(t));
  };

  const alwaysOnline = f["Always-Online Required?"] ?? f.alwaysOnlineRequired;
  if (yesish(alwaysOnline)) {
    score += 15;
    factors.push("Always-online required");
  }

  const thirdPartyLauncher = f["Third-Party Launcher Required?"] ?? f.thirdPartyLauncherRequired;
  if (yesish(thirdPartyLauncher)) {
    score += 20;
    factors.push("3rd-party launcher required");
  }

  const mentalEnergy = String(
    f["Cognitive / Mental Energy Required"] ?? f.mentalEnergy ?? "",
  ).toLowerCase();
  if (
    mentalEnergy.includes("high") ||
    mentalEnergy.includes("intense") ||
    mentalEnergy.includes("heavy")
  ) {
    score += 20;
    factors.push("High mental energy");
  } else if (mentalEnergy.includes("moderate") || mentalEnergy.includes("medium")) {
    score += 10;
    factors.push("Moderate mental energy");
  }

  const sessionRaw = String(f["Core Session Loop Length"] ?? f.sessionLength ?? "");
  const sessionMatch = sessionRaw.match(/([\d.]+)\s*(min|hour|hr)?/i);
  if (sessionMatch) {
    const num = parseFloat(sessionMatch[1]);
    const unit = (sessionMatch[2] || "").toLowerCase();
    const mins = unit.startsWith("h") ? num * 60 : num;
    if (mins >= 60) {
      score += 15;
      factors.push(`Long session loop (~${Math.round(mins)} min)`);
    } else if (mins >= 30) {
      score += 8;
      factors.push(`Medium session loop (~${Math.round(mins)} min)`);
    }
  }

  const suspendFriendly = f["Suspend / Pause Friendly?"] ?? f.suspendPauseFriendly;
  const suspendRaw = String(suspendFriendly ?? "").toLowerCase();
  if (
    suspendFriendly !== null &&
    suspendFriendly !== undefined &&
    suspendRaw !== "" &&
    suspendRaw !== "unknown" &&
    !yesish(suspendFriendly)
  ) {
    score += 10;
    factors.push("Not suspend-friendly");
  }

  const saveSystem = String(f["Save System Type"] ?? f.saveSystemType ?? "").toLowerCase();
  if (
    saveSystem.includes("manual") ||
    saveSystem.includes("checkpoint") ||
    saveSystem.includes("limited")
  ) {
    score += 10;
    factors.push("Limited save points");
  }

  const uiLegibility = String(
    f["Handheld Font & UI Legibility"] ?? f.handheldFontUiLegibility ?? "",
  ).toLowerCase();
  if (
    uiLegibility.includes("poor") ||
    uiLegibility.includes("hard") ||
    uiLegibility.includes("difficult") ||
    uiLegibility.includes("small")
  ) {
    score += 10;
    factors.push("Poor handheld UI legibility");
  }

  score = Math.min(100, score);
  const level = score >= 45 ? "High" : score >= 20 ? "Moderate" : "Low";
  if (factors.length === 0) factors.push("No major friction flags");
  return { score, level, factors };
}

/**
 * Build the specs persistence contract from raw DB values only — never inferred.
 * Unknown values are null (client renders "N/A"), per the Anti-Stale Input Rule.
 */
function buildSpecs(row: any, storageSize: string | null): GameComparisonResult["specs"] {
  const gb = (v: any) => {
    if (v === null || v === undefined || v === "") return null;
    return String(v).toLowerCase().includes("gb") ? String(v) : `${v} GB`;
  };
  const ssd = (v: any): string | null => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return "Yes";
    if (["false", "0", "no", "n"].includes(s)) return "No";
    return null;
  };

  return {
    minimum: {
      ramGb: gb(row.minRamGb),
      vramGb: gb(row.minVramGb),
      cpu: row.minCpu || null,
      gpu: row.minGpu || null,
      storage: storageSize || null,
      ssdRequired: ssd(row.ssdRequired),
    },
    recommended: {
      ramGb: gb(row.recRamGb),
      vramGb: gb(row.recVramGb),
      cpu: row.recCpu || null,
      gpu: row.recGpu || null,
      storage: storageSize || null,
      ssdRequired: null,
    },
  };
}

/**
 * Parse and validate game IDs from array or comma-separated string
 */
function parseGameIds(idsInput: string | string[]): string[] {
  if (!idsInput) return [];
  let ids: string[] = [];
  if (Array.isArray(idsInput)) {
    ids = idsInput.map((id) => String(id).trim()).filter((id) => id.length > 0);
  } else if (typeof idsInput === "string") {
    ids = idsInput
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }
  return ids.slice(0, 4); // Max 4 IDs as per requirements
}

/**
 * Fetch Device Info by ID
 */
function getDeviceInfo(deviceId: string | null): DeviceInfo | null {
  if (!deviceId) return null;
  if (deviceId === "deck_h") {
    return {
      deviceId: "deck_h",
      deviceName: "Steam Deck Handheld",
      ramGb: 16,
      vramGb: 16,
      batteryWh: 40,
      gpuModel: "AMD Custom APU (RDNA 2)",
      formFactor: "handheld",
    };
  }
  if (deviceId === "custom-pc-5080") {
    return {
      deviceId: "custom-pc-5080",
      deviceName: "Custom Rig (RTX 5080)",
      ramGb: 64,
      vramGb: 16,
      batteryWh: 0,
      gpuModel: "NVIDIA GeForce RTX 5080",
      formFactor: "desktop",
    };
  }
  try {
    const row = db
      .prepare(
        `
      SELECT "deviceId", "deviceName", "ramGb", "vramGb", "batteryWh", "gpuModel", "formFactor"
      FROM "Devices"
      WHERE "deviceId" = ?
    `,
      )
      .get(deviceId) as DeviceInfo | undefined;
    return row || null;
  } catch (e) {
    console.warn("Failed to fetch device info:", e);
    return null;
  }
}

/**
 * Core handler function for compare logic
 */
function executeCompare(gameIds: string[], deviceId: string | null) {
  ensureGameDeviceProfilesTable();
  ensureInstalledModsTable();

  if (gameIds.length < 2) {
    return {
      status: 400,
      data: { success: false, error: "At least 2 game ids are required, maximum 4" },
    };
  }

  const device = getDeviceInfo(deviceId);

  const placeholders = gameIds.map(() => "?").join(",");

  const sql = `
    SELECT 
      g."GameID" as gameId,
      g."Game Title" as title,
      g."Storage Size" as storageSize,
      g."Min RAM GB" as minRamGb,
      g."Min VRAM GB" as minVramGb,
      g."Primary Genre" as primaryGenre,
      g."cover_url" as coverUrl,
      g."criticScore" as criticScore,
      g."nexusModCount" as nexusModCount,
      g."platformStoreUrls" as platformStoreUrls,
      r."main_story_hours" as mainStoryHours,
      r."Main Story Time" as mainStoryText,
      r."completionist_hours" as completionistHours,
      rev."Score Numeric" as reviewScoreNumeric,
      rev."Recommendation Percent" as recommendationPercent,
      AVG(p."estimatedBatteryRuntime") as estimatedBatteryRuntime,
      (SELECT COUNT(*) FROM "InstalledMods" im WHERE im."isActive" = 1 AND im."gameId" = g."GameID") as installedModCount,
      s."Thermal / Power Mode" as thermalPowerMode
    FROM "AppGames" g
    LEFT JOIN "GameDeviceProfiles" p ON p."gameId" = g."GameID"
    LEFT JOIN "AppCompletionRoadmap" r ON r."GameID" = g."GameID"
    LEFT JOIN "AppReviews" rev ON rev."GameID" = g."GameID"
    LEFT JOIN "AppGameSettings" s ON s."GameID" = g."GameID"
    WHERE g."GameID" IN (${placeholders})
    GROUP BY g."GameID"
  `;

  const rows = db.prepare(sql).all(...gameIds) as Array<{
    gameId: string;
    title: string | null;
    storageSize: string | null;
    minRamGb: string | number | null;
    minVramGb: string | number | null;
    primaryGenre: string | null;
    coverUrl: string | null;
    criticScore: number | null;
    nexusModCount: number | null;
    platformStoreUrls: string | null;
    mainStoryHours: number | null;
    mainStoryText: string | null;
    completionistHours: number | null;
    reviewScoreNumeric: number | null;
    recommendationPercent: number | null;
    estimatedBatteryRuntime: number | null;
    installedModCount: number;
    thermalPowerMode: string | null;
  }>;

  const games: GameComparisonResult[] = rows.map((row) => {
    let storyHours: number | null =
      row.mainStoryHours !== null && row.mainStoryHours !== undefined
        ? Number(row.mainStoryHours)
        : null;
    if ((storyHours === null || Number.isNaN(storyHours)) && row.mainStoryText) {
      const match = row.mainStoryText.match(/([\d.]+)/);
      if (match) {
        storyHours = parseFloat(match[1]);
      }
    }

    const score = row.criticScore ?? row.reviewScoreNumeric ?? null;
    const totalMods = (row.nexusModCount || 0) + (row.installedModCount || 0);

    // WUD-SPRINT9.1: hydrate developer, specs contract, ownership matrix, HLTB & friction
    const supplemental = getGameSupplemental(db, row.gameId);
    const sysSpecs = getSystemSpecsForGame(db, row.gameId);
    const ownershipRows = getOwnershipsForGame(db, row.gameId);
    const frictionRows = getFrictionsForGame(db, row.gameId);

    // Sprint 7 (WUD-7.3): live/cached Steam Store requirements as the final
    // fallback tier. Fills the CPU/GPU (and rec RAM/VRAM) gaps so the matrix
    // never renders empty fields when Steam publishes the specs. Synchronous
    // cache read (curated seed + live fetches populate scripts/.cache).
    const steamSpecs = getCachedSteamSpecs(
      String(row.gameId),
      extractSteamAppId(row.platformStoreUrls),
    );
    const steamMin = steamSpecs?.minimum || null;
    const steamRec = steamSpecs?.recommended || null;

    const specRow = {
      minRamGb: row.minRamGb ?? steamMin?.ramGb,
      minVramGb: row.minVramGb ?? steamMin?.vramGb,
      ssdRequired: supplemental.ssdRequired ?? sysSpecs.ssdRequired,
      minCpu: supplemental.minCpu ?? sysSpecs.minCpu ?? steamMin?.cpu,
      minGpu: supplemental.minGpu ?? sysSpecs.minGpu ?? steamMin?.gpu,
      recRamGb: supplemental.recRamGb ?? sysSpecs.recRamGb ?? steamRec?.ramGb,
      recVramGb: supplemental.recVramGb ?? sysSpecs.recVramGb ?? steamRec?.vramGb,
      recCpu: supplemental.recCpu ?? sysSpecs.recCpu ?? steamRec?.cpu,
      recGpu: supplemental.recGpu ?? sysSpecs.recGpu ?? steamRec?.gpu,
    };
    const specs = buildSpecs(specRow, row.storageSize ?? null);

    const completionistHours =
      row.completionistHours !== null && row.completionistHours !== undefined
        ? Number(row.completionistHours)
        : null;
    const hltb = {
      mainStory: storyHours !== null && !Number.isNaN(storyHours) ? storyHours : null,
      completionist:
        completionistHours !== null && !Number.isNaN(completionistHours)
          ? completionistHours
          : null,
    };

    const rawRam =
      row.minRamGb !== null && row.minRamGb !== undefined ? Number(row.minRamGb) : null;
    const rawVram =
      row.minVramGb !== null && row.minVramGb !== undefined ? Number(row.minVramGb) : null;

    const genreLower = (row.primaryGenre || "").toLowerCase();
    const isDemandingGenre = [
      "action",
      "rpg",
      "shooter",
      "open world",
      "adventure",
      "simulation",
    ].some((g) => genreLower.includes(g));

    const minRamNum = rawRam ?? (isDemandingGenre ? 16 : 8);
    const minVramNum = rawVram ?? (isDemandingGenre ? 6 : 2);

    let targetFps: number | string | null = null;
    let playabilityBadge: string | null = null;
    let deviceBatteryRuntimeText: string | null = null;
    let ramHeadroomGb: number | null = null;
    let vramHeadroomGb: number | null = null;

    if (device) {
      if (device.ramGb !== null) {
        ramHeadroomGb = device.ramGb - minRamNum;
      }
      if (device.vramGb !== null) {
        vramHeadroomGb = device.vramGb - minVramNum;
      }

      const isHandheld =
        (device.formFactor || "").toLowerCase() === "handheld" ||
        (device.deviceName || "").toLowerCase().includes("deck") ||
        device.deviceId === "deck_h";
      const isHighEndRig =
        (device.vramGb !== null && device.vramGb >= 24) ||
        (device.gpuModel || "").includes("4090") ||
        (device.gpuModel || "").includes("5080") ||
        device.deviceId === "custom-pc-5080";

      const ramOk = device.ramGb === null || device.ramGb >= minRamNum;
      const vramOk = device.vramGb === null || device.vramGb >= minVramNum;

      if (!ramOk || !vramOk) {
        targetFps = "< 30";
        playabilityBadge = "⚠️ Below Spec";
      } else if (isHighEndRig) {
        targetFps = "144+";
        playabilityBadge = "⚡ 60+ FPS Great";
      } else if (isHandheld) {
        if (minRamNum <= 8 && minVramNum <= 4) {
          targetFps = 60;
          playabilityBadge = "🟢 60 FPS Great";
        } else {
          targetFps = "30-60";
          playabilityBadge = "🟡 30-60 FPS Playable";
        }
      } else if (
        ramHeadroomGb !== null &&
        ramHeadroomGb >= 8 &&
        (vramHeadroomGb === null || vramHeadroomGb >= 4)
      ) {
        targetFps = 60;
        playabilityBadge = "🟢 60 FPS Great";
      } else {
        targetFps = 45;
        playabilityBadge = "🟡 30-60 FPS Playable";
      }

      // Helper function to resolve TDP
      const resolveGameTdp = (
        modeText: string | null,
        ram: number | null,
        vram: number | null,
      ): number => {
        if (modeText) {
          const match = modeText.match(/(\d+)\s*W/i);
          if (match) return parseInt(match[1], 10);
        }
        if ((ram && ram >= 16) || (vram && vram >= 8)) return 25;
        if ((ram && ram >= 8) || (vram && vram >= 4)) return 15;
        return 10;
      };

      // Calculate Battery Life if device has batteryWh
      if (device.batteryWh && device.batteryWh > 0) {
        const tdp = resolveGameTdp(row.thermalPowerMode, minRamNum, minVramNum);
        const totalDrain = tdp + 6.0; // system overhead
        const runtime = Number((device.batteryWh / totalDrain).toFixed(1));
        deviceBatteryRuntimeText = `${runtime} hrs on ${device.deviceName || "Device"} (${device.batteryWh}Wh)`;
      } else if (device.batteryWh === 0) {
        deviceBatteryRuntimeText = "Plugged Power (AC)";
      }
    }

    return {
      gameId: String(row.gameId),
      title: safeValue(row.title),
      mainStoryHours: safeNumber(storyHours),
      estimatedBatteryRuntime: safeNumber(row.estimatedBatteryRuntime),
      activeModCount: safeNumber(totalMods) ?? 0,
      genres: safeStringArray(getGenresForGame(db, row.gameId, row.primaryGenre)),
      storageSize: safeValue(row.storageSize),
      coverUrl: safeValue(row.coverUrl),
      minRamGb: safeNumber(minRamNum),
      minVramGb: safeNumber(minVramNum),
      criticScore: safeNumber(score),
      recommendationPercent: safeNumber(row.recommendationPercent),
      platforms: safeStringArray(getPlatformsForGame(db, row.gameId)),
      targetFps,
      playabilityBadge: safeValue(playabilityBadge),
      deviceBatteryRuntimeText: safeValue(deviceBatteryRuntimeText),
      ramHeadroomGb: safeNumber(ramHeadroomGb),
      vramHeadroomGb: safeNumber(vramHeadroomGb),
      developer: safeValue(supplemental.developer),
      coverImage: safeValue(supplemental.headerImage ?? row.coverUrl),
      specs,
      ownedPlatforms: safeStringArray(getPlatformsForGame(db, row.gameId)),
      platformMatrix: buildPlatformMatrix(safeValue(row.title) ?? "", ownershipRows),
      hltb,
      frictions: frictionRows.map(normalizeFriction).filter(Boolean),
      frictionScore: computeFrictionScore(frictionRows[0] || {}),
    };
  });

  return {
    status: 200,
    data: {
      success: true,
      device: device
        ? {
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            ramGb: device.ramGb,
            vramGb: device.vramGb,
            batteryWh: device.batteryWh,
          }
        : null,
      comparison: games,
    },
  };
}

/**
 * GET /api/games/compare
 */
router.get("/", (req: Request, res: Response) => {
  try {
    const idsParam = req.query.ids;
    const deviceIdParam = req.query.deviceId;

    const ids = typeof idsParam === "string" ? idsParam : "";
    const deviceId = typeof deviceIdParam === "string" ? deviceIdParam : null;

    if (!ids) {
      return res.status(400).json({
        success: false,
        error: "ids parameter is required",
      });
    }

    const gameIds = parseGameIds(ids);
    const result = executeCompare(gameIds, deviceId);
    return res.status(result.status).json(result.data);
  } catch (error) {
    console.error("Compare error:", error);
    sendApiError(res, 500, "Failed to compare games");
  }
});

/**
 * POST /api/games/compare
 */
router.post("/", (req: Request, res: Response) => {
  try {
    const idsInput = req.body.ids;
    const deviceId = typeof req.body.deviceId === "string" ? req.body.deviceId : null;

    if (!idsInput) {
      return res.status(400).json({
        success: false,
        error: "ids parameter is required in request body",
      });
    }

    const gameIds = parseGameIds(idsInput);
    // Sprint 7 (WUD-7.3): refresh the Steam specs cache in the background
    // (bounded + non-blocking) so subsequent comparisons render live values.
    try {
      for (const gid of gameIds) {
        const gRow = db
          .prepare(
            'SELECT "Game Title" as title, "platformStoreUrls" as psu FROM "AppGames" WHERE "GameID" = ?',
          )
          .get(gid) as { title?: string; psu?: string | null } | undefined;
        if (gRow) {
          enrichSteamSpecsForGame(gid, gRow.title || "", gRow.psu ?? null).catch(() => null);
        }
      }
    } catch (e) {
      // Non-critical — never block the compare response on enrichment.
    }
    const result = executeCompare(gameIds, deviceId);
    return res.status(result.status).json(result.data);
  } catch (error) {
    console.error("Compare POST error:", error);
    sendApiError(res, 500, "Failed to compare games");
  }
});

router.get("/mods/active-count", (req: Request, res: Response) => {
  try {
    ensureInstalledModsTable();
    const row = dbWrite
      .prepare('SELECT COUNT(*) as count FROM "InstalledMods" WHERE "isActive" = 1')
      .get() as { count: number };
    res.json({
      success: true,
      count: row ? row.count : 0,
    });
  } catch (error) {
    console.error("Failed to get active mod count:", error);
    sendApiError(res, 500, "Failed to get active mod count");
  }
});

/* ============================================================================
 * FEAT-0155 — Hardware Fleet Comparison Matrix & Playability Benchmarking
 * POST /api/compare/benchmark
 *
 * Benchmarks a single game against a fleet of hardware devices. For each
 * device we compute VRAM/RAM headroom, a categorical target-FPS tier, an
 * overall headroom rating, and a handheld-optimization flag. All values are
 * derived strictly from persisted DB specs (Anti-Stale Input Rule) — never
 * inferred from UI state.
 * ========================================================================== */

type FpsTier = "30 FPS Low" | "45 FPS Medium (Handheld)" | "60 FPS High" | "120+ FPS Ultra";
type HeadroomRating = "Optimal" | "Adequate" | "Constrained" | "Insufficient";

interface BenchmarkDevice {
  id: string;
  deviceName: string | null;
  cpu: string | null;
  gpu: string | null;
  ramGb: number | null;
  vramGb: number | null;
  tdpWatt: number | null;
  metrics: {
    vramMarginGb: number | null;
    ramMarginGb: number | null;
    targetFpsTier: FpsTier;
    headroomRating: HeadroomRating;
    handheldOptimized: boolean;
  };
}

/**
 * Resolve a device's TDP (watts) from the Devices table (tdpWatts column) or
 * from the hardcoded fallback profiles. Returns null when unknown.
 */
function getDeviceTdpWatt(deviceId: string, formFactor: string | null): number | null {
  if (deviceId === "deck_h") return 15;
  if (deviceId === "custom-pc-5080") return 350;
  try {
    const cols = getTableColumns(db, "Devices");
    if (cols.has("tdpWatts")) {
      const row = db
        .prepare(`SELECT "tdpWatts" FROM "Devices" WHERE "deviceId" = ?`)
        .get(deviceId) as { tdpWatts: number | null } | undefined;
      if (row && row.tdpWatts !== null && row.tdpWatts !== undefined) return Number(row.tdpWatts);
    }
  } catch (e) {
    console.warn(`Failed to read tdpWatts for device ${deviceId}:`, e);
  }
  // Fallback heuristic by form factor when the column is absent.
  const ff = (formFactor || "").toLowerCase();
  if (ff === "handheld") return 15;
  if (ff === "desktop") return 350;
  return null;
}

/**
 * Resolve the recommended RAM/VRAM (GB) for a game using the deterministic
 * fallback chain: Rec columns -> Min columns -> SystemSpecs tables -> genre
 * defaults. Returns null when nothing can be determined (client renders N/A).
 */
function getGameRecommendedSpecs(
  gameId: string,
  primaryGenre: string | null,
): { recRamGb: number; recVramGb: number } {
  const supplemental = getGameSupplemental(db, gameId);
  const sysSpecs = getSystemSpecsForGame(db, gameId);

  const toNum = (v: any): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  let recRamGb = toNum(supplemental.recRamGb ?? sysSpecs.recRamGb);
  let recVramGb = toNum(supplemental.recVramGb ?? sysSpecs.recVramGb);

  // Fall back to minimum columns when recommended is unavailable.
  if (recRamGb === null) {
    const row = db
      .prepare(`SELECT "Min RAM GB" as minRam FROM "AppGames" WHERE "GameID" = ?`)
      .get(gameId) as { minRam: number | null } | undefined;
    recRamGb = toNum(row?.minRam);
  }
  if (recVramGb === null) {
    const row = db
      .prepare(`SELECT "Min VRAM GB" as minVram FROM "AppGames" WHERE "GameID" = ?`)
      .get(gameId) as { minVram: number | null } | undefined;
    recVramGb = toNum(row?.minVram);
  }

  // Genre-based defaults as a last resort (mirrors executeCompare heuristics).
  const genreLower = (primaryGenre || "").toLowerCase();
  const isDemandingGenre = [
    "action",
    "rpg",
    "shooter",
    "open world",
    "adventure",
    "simulation",
  ].some((g) => genreLower.includes(g));
  if (recRamGb === null) recRamGb = isDemandingGenre ? 16 : 8;
  if (recVramGb === null) recVramGb = isDemandingGenre ? 6 : 2;

  return { recRamGb, recVramGb };
}

/**
 * Map headroom margins + form factor + TDP to a categorical FPS tier.
 */
function deriveFpsTier(
  ramMarginGb: number | null,
  vramMarginGb: number | null,
  recRamGb: number,
  recVramGb: number,
  formFactor: string | null,
  tdpWatt: number | null,
): FpsTier {
  const isHandheld =
    (formFactor || "").toLowerCase() === "handheld" || (tdpWatt !== null && tdpWatt <= 25);

  // Any deficit caps the tier at the lowest band.
  if ((ramMarginGb !== null && ramMarginGb < 0) || (vramMarginGb !== null && vramMarginGb < 0)) {
    return "30 FPS Low";
  }

  const ramSurplus = ramMarginGb !== null ? ramMarginGb : 0;
  const vramSurplus = vramMarginGb !== null ? vramMarginGb : 0;

  // High-end desktop capable of 120+ FPS.
  if (!isHandheld && ramSurplus >= recRamGb * 2 && vramSurplus >= recVramGb * 2) {
    return "120+ FPS Ultra";
  }

  // Solid 60 FPS capability.
  if (ramSurplus >= recRamGb && vramSurplus >= recVramGb) {
    return "60 FPS High";
  }

  // Handheld-optimized 45 FPS band.
  if (isHandheld && ramSurplus >= 0 && vramSurplus >= 0) {
    return "45 FPS Medium (Handheld)";
  }

  return "30 FPS Low";
}

/**
 * Map margins to an overall headroom rating.
 */
function deriveHeadroomRating(
  ramMarginGb: number | null,
  vramMarginGb: number | null,
  recRamGb: number,
  recVramGb: number,
): HeadroomRating {
  const ramOk = ramMarginGb === null || ramMarginGb >= 0;
  const vramOk = vramMarginGb === null || vramMarginGb >= 0;

  if (!ramOk || !vramOk) {
    // Both negative -> Insufficient; exactly one negative -> Constrained.
    const ramNeg = ramMarginGb !== null && ramMarginGb < 0;
    const vramNeg = vramMarginGb !== null && vramMarginGb < 0;
    return ramNeg && vramNeg ? "Insufficient" : "Constrained";
  }

  const ramSurplus = ramMarginGb !== null ? ramMarginGb : 0;
  const vramSurplus = vramMarginGb !== null ? vramMarginGb : 0;
  if (ramSurplus >= recRamGb && vramSurplus >= recVramGb) {
    return "Optimal";
  }
  return "Adequate";
}

/**
 * POST /api/compare/benchmark
 */
router.post("/benchmark", (req: Request, res: Response) => {
  try {
    // Sprint 1A (EPICSEC01): hydrate the raw body through the unified
    // coercion helpers so malformed payloads resolve to safe fallbacks.
    const body = safeCoerce.obj(req.body);
    const gameId = safeCoerce.str(body.gameId);

    if (gameId === "") {
      return res.status(400).json({ success: false, error: "gameId is required" });
    }

    let ids: string[] = [];
    if (Array.isArray(body.deviceIds)) {
      ids = safeCoerce
        .arr<string>(body.deviceIds)
        .map((id) => safeCoerce.str(id).trim())
        .filter((id: string) => id.length > 0);
    } else if (typeof body.deviceIds === "string" && String(body.deviceIds).trim() !== "") {
      ids = String(body.deviceIds)
        .split(",")
        .map((id: string) => id.trim())
        .filter((id: string) => id.length > 0);
    }
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: "At least one deviceId is required" });
    }
    if (ids.length > 10) {
      return res.status(400).json({ success: false, error: "Maximum of 10 devices per benchmark" });
    }

    // Game lookup.
    const gameRow = db
      .prepare(
        `
      SELECT "GameID" as id, "Game Title" as title, "Primary Genre" as genre, "cover_url" as coverImage
      FROM "AppGames"
      WHERE "GameID" = ?
    `,
      )
      .get(gameId) as
      | { id: string; title: string | null; genre: string | null; coverImage: string | null }
      | undefined;

    if (!gameRow) {
      return res.status(404).json({ success: false, error: `Game not found: ${gameId}` });
    }

    const { recRamGb, recVramGb } = getGameRecommendedSpecs(gameRow.id, gameRow.genre);

    const devices: BenchmarkDevice[] = ids.map((deviceId) => {
      const info = getDeviceInfo(deviceId);
      if (!info) {
        return {
          id: deviceId,
          deviceName: null,
          cpu: null,
          gpu: null,
          ramGb: null,
          vramGb: null,
          tdpWatt: null,
          metrics: {
            vramMarginGb: null,
            ramMarginGb: null,
            targetFpsTier: "30 FPS Low" as FpsTier,
            headroomRating: "Insufficient" as HeadroomRating,
            handheldOptimized: false,
          },
        };
      }

      const ramMarginGb = info.ramGb !== null ? Number((info.ramGb - recRamGb).toFixed(2)) : null;
      const vramMarginGb =
        info.vramGb !== null ? Number((info.vramGb - recVramGb).toFixed(2)) : null;
      const tdpWatt = getDeviceTdpWatt(info.deviceId, info.formFactor ?? null);

      const targetFpsTier = deriveFpsTier(
        ramMarginGb,
        vramMarginGb,
        recRamGb,
        recVramGb,
        info.formFactor ?? null,
        tdpWatt,
      );
      const headroomRating = deriveHeadroomRating(ramMarginGb, vramMarginGb, recRamGb, recVramGb);

      // Handheld-optimized: TDP budget <= 25W AND capable of at least 30 FPS.
      const handheldOptimized = tdpWatt !== null && tdpWatt <= 25 && targetFpsTier !== "30 FPS Low";

      return {
        id: info.deviceId,
        deviceName: info.deviceName,
        cpu: null,
        gpu: info.gpuModel,
        ramGb: info.ramGb,
        vramGb: info.vramGb,
        tdpWatt,
        metrics: {
          vramMarginGb,
          ramMarginGb,
          targetFpsTier,
          headroomRating,
          handheldOptimized,
        },
      };
    });

    return res.json({
      success: true,
      game: {
        id: gameRow.id,
        title: gameRow.title,
        genre: gameRow.genre,
        coverImage: gameRow.coverImage,
      },
      devices,
    });
  } catch (error) {
    console.error("Benchmark error:", error);
    sendApiError(res, 500, "Failed to run hardware benchmark");
  }
});

export default router;
