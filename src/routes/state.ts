import { Router, Request, Response, NextFunction } from "express";
import { db } from "../db";
import { sendApiError } from "../middleware/errorSanitizer";
import { requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();

/**
 * Sprint 17 (FEAT-0149) — State Export/Import, Database Snapshot Engine & Cloud-Ready Backup.
 *
 * GET  /api/state/export  -> versioned JSON snapshot of all key tables (browser download).
 * POST /api/state/import  -> atomic upsert restore of a previously exported snapshot.
 *
 * All column lists are introspected at runtime via PRAGMA table_info so the engine
 * stays resilient to schema drift (e.g. InstalledMods differs between db.ts DDL and
 * the live schema.prisma-managed table).
 */

const SNAPSHOT_VERSION = 1;

// PI-GTM-2026-001 (EPIC-04): `platform_audit_logs` is intentionally NOT
// registered below — it is an immutable append-only audit table and must not be
// rewritten or truncated by the snapshot export/import lifecycle.

// Sprint 6 (PI-GTM-2026-002): Unified Integration Health telemetry
// (src/services/integrationMonitor.ts) is ephemeral in-memory runtime state —
// like the DPM counters (src/services/devicePlayability.ts) and the immutable
// platform_audit_logs table above — and is intentionally NOT registered here.
// Mixing transient operational counters into portable user-state snapshots
// would bloat the backup payload and violate snapshot integrity.

// Allowed writable columns per table (subset of live schema). Introspection intersects
// these with the actual table columns so we never write to a column that does not exist.
const TABLE_COLUMNS: Record<string, string[]> = {
  AppDevices: [
    "id",
    "userId",
    "deviceName",
    "deviceType",
    "cpuModel",
    "cpuCores",
    "ramGb",
    "gpuModel",
    "vramGb",
    "gpuType",
    "storageType",
    "storageFreeGb",
    "isPortable",
    "isPrimary",
    "createdAt",
    "updatedAt",
  ],
  catalog_devices: [
    "id",
    "name",
    "brand",
    "type",
    "releaseDate",
    "msrp",
    "imageUrl",
    "isPrebuilt",
    "platformCanonical",
  ],
  catalog_device_specs: [
    "specId",
    "deviceId",
    "cpuModel",
    "gpuModel",
    "gpuVramGb",
    "ramGb",
    "storageGb",
    "tdpWatts",
    "gpuTier",
    "cpuTier",
  ],
  Devices: [
    "deviceId",
    "deviceName",
    "formFactor",
    "gpuModel",
    "vramGb",
    "cpuModel",
    "batteryWh",
    "isArchived",
    "archivedAt",
    "createdAt",
    "updatedAt",
    "ramGb",
    "motherboard",
    "caseModel",
    "psu",
    "storageCapacityGb",
    "os",
    "tdpWatts",
    "lastScanAt",
    "cpuCores",
    "storageType",
    "storageFreeGb",
    "scanConfidence",
    "deviceClass",
    "thermalCapabilities",
  ],
  AppDealsWishlist: ["steamAppId", "gameTitle", "targetPrice", "createdAt"],
  AppDealPriceHistory: ["gameId", "title", "store", "price", "recordedAt"],
  AppPriceAlerts: [
    "userId",
    "gameId",
    "title",
    "targetPrice",
    "currentPrice",
    "historicalLow",
    "isTriggered",
    "acknowledged",
    "updatedAt",
  ],
  InstalledMods: ["modId", "gameDomain", "modName", "version", "installedAt"],
  Mods: [
    "gameId",
    "modName",
    "author",
    "sourceDomain",
    "sourceUrl",
    "downloads",
    "version",
    "minVramGb",
    "minRamGb",
    "is_active",
    "download_count",
    "active_installs",
    "rating_count",
    "version_tag",
    "author_handle",
    "description",
    "createdAt",
    "updatedAt",
  ],
  ModVersions: ["gameDomain", "modId", "version", "changelog", "releasedAt", "createdAt"],
  ModDependencies: ["gameDomain", "modId", "dependsOn", "isHard", "filePaths", "createdAt"],
  ModLoadOrder: ["gameDomain", "modId", "position", "isActive", "updatedAt"],
  AppCompletionRoadmapCache: [
    "gameTitle",
    "mainStory",
    "mainExtra",
    "completionist",
    "hltbScore",
    "cachedAt",
  ],
  AppTracking: [
    "GameID",
    "Play Status",
    "Want to Play?",
    "Personal Rating (1-10)",
    "Hours Played",
    "Last Played Date",
    "Played Platform",
    "Played Hardware Device",
    "Completed Date",
    "Replay Interest",
    "DLC Status",
    "Personal Review",
    "Notes",
    "targetTdp",
    "targetFps",
    "resolution",
    "cpuBoost",
    "tuningNotes",
    "playNotes",
    "achievementNotes",
    "tags",
    "Trophy Progress",
    "targetStyle",
  ],
  AppGameTags: ["userId", "gameId", "tagName", "colorHex", "createdAt"],
  AppGameNotes: ["userId", "gameId", "noteMarkdown", "updatedAt"],
  AppPlatformHandles: [
    "id",
    "userId",
    "steamUsername",
    "psnId",
    "xboxGamertag",
    "gogUsername",
    "epicUsername",
    "ubisoftUsername",
    "hidePlatformIds",
    "createdAt",
    "updatedAt",
  ],
  AuthPlatformLinks: [
    "id",
    "userId",
    "platform",
    "publicId",
    "displayHandle",
    "tokenEnc",
    "tokenIv",
    "connectedAt",
    "lastSyncedAt",
  ],
  AppWishlist: [
    "userId",
    "gameId",
    "title",
    "coverImage",
    "targetPrice",
    "currentBestPrice",
    "bestStore",
    "bestStoreType",
    "historicalLow",
    "isTriggered",
    "notes",
    "createdAt",
    "updatedAt",
  ],

  AppRetroTracking: [
    "gameTitle",
    "system",
    "status",
    "playtimeHours",
    "personalRating",
    "isFavorite",
    "notes",
    "createdAt",
    "updatedAt",
  ],
  AppGames: [
    "GameID",
    "Game Title",
    "Primary Genre",
    "Storage Size",
    "Min RAM GB",
    "Min VRAM GB",
    "SSD Required?",
    "Active",
    "Nexus Mods URL",
    "cover_url",
    "nexusUrl",
    "nexusModCount",
    "trackedModCount",
    "platformStoreUrls",
  ],
  AppBacklog: [
    "gameId",
    "title",
    "status",
    "priorityScore",
    "hltbMainHours",
    "hltbMainExtraHours",
    "hltbCompletionistHours",
    "etaDays",
    "updatedAt",
  ],
  AppPlaySessions: [
    "sessionUuid",
    "gameId",
    "startedAt",
    "endedAt",
    "durationSeconds",
    "deviceId",
    "synced",
    "createdAt",
  ],
  AppFriendships: ["id", "userId", "friendId", "status", "source", "createdAt", "updatedAt"],
  device_components: [
    "componentId",
    "category",
    "brand",
    "model",
    "socketType",
    "ddrGen",
    "formFactor",
    "tdpWatts",
    "priceUsd",
    "imageUrl",
  ],
  device_builds: [
    "buildId",
    "userId",
    "buildName",
    "shareSlug",
    "componentsJson",
    "totalPriceSnapshot",
    "estimatedWattage",
    "createdAt",
  ],
  compatibility_rules: [
    "ruleId",
    "categoryA",
    "fieldA",
    "operator",
    "categoryB",
    "fieldB",
    "severity",
    "messageTemplate",
  ],
  game_performance_profiles: [
    "profileId",
    "gameId",
    "gpuTier",
    "cpuTier",
    "fps4kUltra",
    "fps1440pHigh",
    "fps1080pMed",
    "fps720pLow",
    "dataSource",
  ],
  device_reviews: [
    "reviewId",
    "deviceId",
    "userId",
    "rating",
    "title",
    "body",
    "prosJson",
    "consJson",
    "isEditorsPick",
    "helpfulScore",
    "isVerifiedOwner",
    "createdAt",
  ],
  review_votes: ["voteId", "reviewId", "userId", "voteType"],
  hardware_price_history: [
    "priceId",
    "deviceId",
    "componentId",
    "retailer",
    "priceUsd",
    "condition",
    "recordedAt",
  ],
  release_radar: [
    "releaseId",
    "title",
    "releaseDate",
    "platform",
    "publisher",
    "priceUsd",
    "preorderUrl",
    "bannerUrl",
    "isVerified",
  ],
  community_benchmarks: [
    "benchmarkId",
    "componentId",
    "componentType",
    "componentName",
    "resolution",
    "settingsPreset",
    "avgFps",
    "onePercentLowFps",
    "sampleCount",
    "source",
    "recordedAt",
  ],
};

// Conflict keys used for upsert semantics (never destructive).
const CONFLICT_KEYS: Record<string, string[]> = {
  AppDevices: ["id"],
  Devices: ["deviceId"],
  AppDealsWishlist: ["gameTitle"],
  AppDealPriceHistory: ["gameId", "store", "recordedAt"],
  AppPriceAlerts: ["userId", "gameId"],
  InstalledMods: ["modId", "gameDomain"],
  Mods: ["gameId", "modName", "sourceDomain"],
  ModVersions: ["gameDomain", "modId", "version"],
  ModDependencies: ["gameDomain", "modId", "dependsOn"],
  ModLoadOrder: ["gameDomain", "modId"],
  AppCompletionRoadmapCache: ["gameTitle"],
  AppTracking: ["GameID"],
  AppGameTags: ["userId", "gameId", "tagName"],
  AppGameNotes: ["userId", "gameId"],
  AppPlatformHandles: ["userId"],
  AuthPlatformLinks: ["userId", "platform"],
  AppWishlist: ["userId", "gameId"],
  AppRetroTracking: ["gameTitle"],
  AppGames: ["GameID"],
  AppBacklog: ["gameId"],
  AppPlaySessions: ["sessionUuid"],
  catalog_devices: ["id"],
  catalog_device_specs: ["deviceId"],
  AppFriendships: ["userId", "friendId"],
  device_components: ["componentId"],
  device_builds: ["buildId"],
  compatibility_rules: ["ruleId"],
  game_performance_profiles: ["profileId"],
  device_reviews: ["deviceId", "userId"],
  review_votes: ["reviewId", "userId"],
  hardware_price_history: ["deviceId", "retailer", "recordedAt"],
  release_radar: ["releaseId"],
  community_benchmarks: ["benchmarkId"],
};

// Map snapshot data keys -> table names.
const DATA_KEY_TO_TABLE: Record<string, string> = {
  appDevices: "AppDevices",
  fleet: "Devices",
  deals: "AppDealsWishlist",
  dealPriceHistory: "AppDealPriceHistory",
  alerts: "AppPriceAlerts",
  mods: "InstalledMods",
  modCatalog: "Mods",
  modVersions: "ModVersions",
  modDependencies: "ModDependencies",
  modLoadOrder: "ModLoadOrder",
  hltb: "AppCompletionRoadmapCache",
  tracking: "AppTracking",
  tags: "AppGameTags",
  notes: "AppGameNotes",
  platformHandles: "AppPlatformHandles",
  platformLinks: "AuthPlatformLinks",
  wishlist: "AppWishlist",
  retro: "AppRetroTracking",
  games: "AppGames",
  backlog: "AppBacklog",
  playSessions: "AppPlaySessions",
  devices: "catalog_devices",
  deviceSpecs: "catalog_device_specs",
  friendships: "AppFriendships",
  builderComponents: "device_components",
  builderBuilds: "device_builds",
  builderRules: "compatibility_rules",
  performanceProfiles: "game_performance_profiles",
  deviceReviews: "device_reviews",
  reviewVotes: "review_votes",
  hardwarePriceAlerts: "hardware_price_history",
  radar: "release_radar",
  communityBenchmarks: "community_benchmarks",
};

// Snapshot keys that are optional on import. Older snapshots exported before a
// feature existed (e.g. wishlist) must still restore cleanly, so these keys are
// excluded from the "missing required array keys" validation.
const OPTIONAL_DATA_KEYS: Record<string, boolean> = {
  appDevices: true,
  modCatalog: true,
  modVersions: true,
  modDependencies: true,
  modLoadOrder: true,
  wishlist: true,
  platformHandles: true,
  platformLinks: true,
  retro: true,
  games: true,
  backlog: true,
  playSessions: true,
  devices: true,
  deviceSpecs: true,
  friendships: true,
  builderComponents: true,
  builderBuilds: true,
  builderRules: true,
  performanceProfiles: true,
  deviceReviews: true,
  reviewVotes: true,
  hardwarePriceAlerts: true,
  dealPriceHistory: true,
  radar: true,
  communityBenchmarks: true,
};

function getTableColumns(table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch (e) {
    console.error(`Failed to introspect columns for ${table}:`, e);
    return [];
  }
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Determine whether the given conflict columns form a real UNIQUE or PRIMARY KEY
 * constraint on the table. SQLite's `ON CONFLICT(<cols>)` clause only works when
 * the target columns match an actual unique index; otherwise it throws
 * "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
 */
function hasUniqueConstraint(table: string, columns: string[]): boolean {
  try {
    const indexes = db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    for (const idx of indexes) {
      if (!idx.unique) continue;
      const info = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
      const cols = info.map((c) => c.name);
      if (cols.length === columns.length && columns.every((c) => cols.includes(c))) {
        return true;
      }
    }
  } catch (e) {
    console.error(`Failed to inspect unique constraints for ${table}:`, e);
  }
  return false;
}

/**
 * AI-084 (#163): whole-database export and import are admin-only. Without a
 * valid session the caller gets 401; signed in without the `admin` role, 403.
 * The check runs before any database access. POST /validate stays open: it
 * only checks the uploaded payload's shape and reads no table.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if ((req as AuthedRequest).user?.role !== "admin") {
      res.status(403).json({ error: "Only an admin can export or import the whole database." });
      return;
    }
    next();
  });
}

/**
 * POST /api/state/validate
 * Inspects an uploaded JSON snapshot WITHOUT applying any changes. Validates the
 * schema version, confirms every table key maps to DATA_KEY_TO_TABLE, and returns
 * an itemized per-table record count summary. Malformed payloads return descriptive
 * errors via `{ valid: false, errors: [...] }`.
 */
router.post("/validate", (req: Request, res: Response) => {
  const errors: string[] = [];
  const body = req.body || {};

  // --- Structural validation (descriptive errors for malformed payloads) ---
  if (typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      valid: false,
      errors: ["Snapshot payload must be a JSON object."],
    });
  }
  if (body.version !== SNAPSHOT_VERSION) {
    errors.push(
      `Unsupported snapshot version "${body.version}". Expected version ${SNAPSHOT_VERSION}.`,
    );
  }
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    errors.push('Snapshot payload is missing a valid "data" object.');
  }

  // If the top-level shape is fundamentally broken, stop early.
  if (errors.length > 0) {
    return res.status(400).json({ valid: false, errors });
  }

  const data = body.data as Record<string, any>;

  // --- Confirm table keys match DATA_KEY_TO_TABLE ---
  const knownKeys = Object.keys(DATA_KEY_TO_TABLE);
  const unknownKeys = Object.keys(data).filter((k) => !knownKeys.includes(k));
  if (unknownKeys.length > 0) {
    errors.push(
      `Snapshot contains unknown table keys: ${unknownKeys.join(", ")}. Expected keys: ${knownKeys.join(", ")}.`,
    );
  }

  // --- Missing required array keys ---
  const missingKeys = knownKeys.filter((k) => !Array.isArray(data[k]) && !OPTIONAL_DATA_KEYS[k]);
  if (missingKeys.length > 0) {
    errors.push(`Snapshot is missing required array keys: ${missingKeys.join(", ")}.`);
  }

  // --- Per-key array + conflict-key row validation ---
  const summary: Record<string, number> = {};
  for (const key of knownKeys) {
    const value = data[key];
    if (value === undefined) {
      summary[key] = 0;
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push(`Snapshot key "${key}" must be an array, got ${typeof value}.`);
      continue;
    }
    summary[key] = value.length;
    const conflictCols = CONFLICT_KEYS[DATA_KEY_TO_TABLE[key]] || [];
    for (let i = 0; i < value.length; i++) {
      const row = value[i];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        errors.push(`Snapshot key "${key}" row ${i} must be a JSON object.`);
        continue;
      }
      for (const col of conflictCols) {
        if (row[col] === undefined || row[col] === null || row[col] === "") {
          errors.push(`Snapshot key "${key}" row ${i} is missing required conflict key "${col}".`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ valid: false, errors });
  }

  return res.json({
    valid: true,
    version: body.version,
    exportedAt: body.exportedAt || null,
    summary,
  });
});

/**
 * GET /api/state/export
 * Assembles a versioned JSON snapshot of all key tables and streams it as a download.
 */
router.get("/export", requireAdmin, (_req: Request, res: Response) => {
  try {
    const data: Record<string, any[]> = {};
    for (const key of Object.keys(DATA_KEY_TO_TABLE)) {
      const table = DATA_KEY_TO_TABLE[key];
      data[key] = db.prepare(`SELECT * FROM "${table}"`).all() as any[];
    }

    const snapshot = {
      version: SNAPSHOT_VERSION,
      exportedAt: new Date().toISOString(),
      data,
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `mgpl-backup-${timestamp}.json`;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json(snapshot);
  } catch (err: any) {
    console.error("Error in /api/state/export:", err?.message || err);
    sendApiError(res, 500, "Failed to export state snapshot");
  }
});

/**
 * AI-084 (#163): the snapshot keys whose tables record the owning user, and the
 * column that holds it. "Export My Data" returns only these, filtered to the
 * signed-in user. Tables without an owner column hold shared catalogue data and
 * are left out until per-user scoping (#162) gives them one.
 */
const USER_EXPORT_KEYS: Record<string, string> = {
  appDevices: "userId",
  alerts: "userId",
  tags: "userId",
  notes: "userId",
  platformHandles: "userId",
  platformLinks: "userId",
  wishlist: "userId",
  friendships: "userId",
  builderBuilds: "userId",
  deviceReviews: "userId",
  reviewVotes: "userId",
};

/** Columns never returned by the per-user export (for example tokenEnc, tokenIv). */
const CREDENTIAL_COLUMN = /token|secret|password|hash/i;

function withoutCredentials(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!CREDENTIAL_COLUMN.test(k)) out[k] = v;
  }
  return out;
}

/**
 * GET /api/state/export/me
 * The signed-in user's own data, for "Export My Data" in Settings: their profile
 * (no email address, in keeping with the Settings drawer's privacy-minimized
 * contract) and their rows from the tables in USER_EXPORT_KEYS (friendships where
 * they are either party). No other user's rows and no credential fields.
 */
router.get("/export/me", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const account = db
      .prepare(
        `SELECT id, displayName, avatarUrl, gamerTag, profileVisibility, libraryVisibility, role, createdAt, updatedAt
         FROM AuthUsers WHERE id = ?`,
      )
      .get(userId);

    const data: Record<string, Record<string, unknown>[]> = {};
    for (const [key, column] of Object.entries(USER_EXPORT_KEYS)) {
      const table = DATA_KEY_TO_TABLE[key];
      const rows =
        key === "friendships"
          ? db
              .prepare(`SELECT * FROM "${table}" WHERE "userId" = ? OR "friendId" = ?`)
              .all(userId, userId)
          : db.prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`).all(userId);
      data[key] = (rows as Record<string, unknown>[]).map(withoutCredentials);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="mgpl-my-data-${timestamp}.json"`);
    res.json({
      version: SNAPSHOT_VERSION,
      scope: "user",
      exportedAt: new Date().toISOString(),
      account: account ? withoutCredentials(account as Record<string, unknown>) : null,
      data,
    });
  } catch (err: any) {
    console.error("Error in /api/state/export/me:", err?.message || err);
    sendApiError(res, 500, "Failed to export your data");
  }
});

/**
 * POST /api/state/import
 * Validates the payload structure and atomically upserts records across all tables.
 */
router.post("/import", requireAdmin, (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    // --- Structural validation (descriptive errors for malformed payloads) ---
    if (typeof body !== "object" || Array.isArray(body)) {
      return res
        .status(400)
        .json({ success: false, error: "Import payload must be a JSON object." });
    }
    if (body.version !== SNAPSHOT_VERSION) {
      return res.status(400).json({
        success: false,
        error: `Unsupported snapshot version "${body.version}". Expected version ${SNAPSHOT_VERSION}.`,
      });
    }
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      return res
        .status(400)
        .json({ success: false, error: 'Import payload is missing a valid "data" object.' });
    }

    const data = body.data as Record<string, any>;
    const missingKeys = Object.keys(DATA_KEY_TO_TABLE).filter(
      (k) => !Array.isArray(data[k]) && !OPTIONAL_DATA_KEYS[k],
    );
    if (missingKeys.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Import payload is missing required array keys: ${missingKeys.join(", ")}.`,
      });
    }

    // Sprint 4 (EPIC-TEST-STD-0001): Reject unknown table keys up front so a
    // tampered snapshot with fabricated schema keys is never silently ignored.
    // Mirrors the /validate contract so import and validate behave identically.
    const knownKeys = Object.keys(DATA_KEY_TO_TABLE);
    const unknownKeys = Object.keys(data).filter((k) => !knownKeys.includes(k));
    if (unknownKeys.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Snapshot contains unknown table keys: ${unknownKeys.join(", ")}. Expected keys: ${knownKeys.join(", ")}.`,
      });
    }

    // Sprint 4 (EPIC-TEST-STD-0001): Foreign-key pre-flight for user-scoped
    // tables. Collects every explicit userId present in the snapshot and verifies
    // each references a real AuthUsers row BEFORE the upsert transaction runs.
    // Rows that omit userId entirely are left untouched (the per-table conflict
    // resolution skips them later), so legacy snapshots without user scoping —
    // e.g. the Sprint 17 backup spec's tags/notes/alerts rows — still restore.
    const userScopedTables = [
      "AppDevices",
      "AppWishlist",
      "AppPriceAlerts",
      "AppGameTags",
      "AppGameNotes",
      "AppPlatformHandles",
      "AuthPlatformLinks",
      "AppFriendships",
      "device_builds",
      "device_reviews",
      "review_votes",
    ];
    const userIds = new Set<string>();
    for (const table of userScopedTables) {
      const key = Object.keys(DATA_KEY_TO_TABLE).find((k) => DATA_KEY_TO_TABLE[k] === table);
      if (!key) continue;
      const rows = data[key];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (
          typeof row === "object" &&
          row !== null &&
          typeof (row as any).userId === "string" &&
          (row as any).userId
        ) {
          userIds.add((row as any).userId);
        }
        // AppFriendships has two FK sides — every referenced profile must exist.
        if (
          typeof row === "object" &&
          row !== null &&
          typeof (row as any).friendId === "string" &&
          (row as any).friendId
        ) {
          userIds.add((row as any).friendId);
        }
      }
    }
    if (userIds.size > 0) {
      const allIds = Array.from(userIds);
      const placeholders = allIds.map(() => "?").join(", ");
      const found = db
        .prepare(`SELECT id FROM "AuthUsers" WHERE id IN (${placeholders})`)
        .all(...allIds) as Array<{ id: string }>;
      const foundSet = new Set(found.map((r) => r.id));
      const missingUserIds = allIds.filter((id) => !foundSet.has(id));
      if (missingUserIds.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Foreign key mismatch: snapshot references unknown userId(s): ${missingUserIds.join(", ")}.`,
        });
      }
    }

    // --- Atomic restore (upsert-only, never destructive) ---
    const restored: Record<string, number> = {
      fleetCount: 0,
      dealsCount: 0,
      dealPriceHistoryCount: 0,
      alertsCount: 0,
      modsCount: 0,
      modVersionsCount: 0,
      modDependenciesCount: 0,
      modLoadOrderCount: 0,
      hltbCount: 0,
      tagsCount: 0,
      notesCount: 0,
      platformHandlesCount: 0,
      platformLinksCount: 0,
      wishlistCount: 0,
      retroCount: 0,
      gamesCount: 0,
      backlogCount: 0,
      playSessionsCount: 0,
      friendshipsCount: 0,
      deviceReviewsCount: 0,
      reviewVotesCount: 0,
      hardwarePriceAlertsCount: 0,
      radarCount: 0,
      communityBenchmarksCount: 0,
    };

    const restore = db.transaction(() => {
      for (const key of Object.keys(DATA_KEY_TO_TABLE)) {
        const table = DATA_KEY_TO_TABLE[key];
        const rows = data[key] as any[];
        if (!Array.isArray(rows) || rows.length === 0) continue;

        const liveColumns = getTableColumns(table);
        const writable = TABLE_COLUMNS[table].filter((c) => liveColumns.includes(c));
        if (writable.length === 0) continue;

        const conflictCols = CONFLICT_KEYS[table].filter((c) => writable.includes(c));
        if (conflictCols.length === 0) continue;

        const insertCols = writable;
        const placeholders = insertCols.map(() => "?").join(", ");
        const conflictTarget = conflictCols.map(quoteIdent).join(", ");
        const updateSet = insertCols
          .filter((c) => !conflictCols.includes(c))
          .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
          .join(", ");

        // Prefer a native ON CONFLICT upsert when the conflict columns match a real
        // UNIQUE/PRIMARY KEY constraint. Otherwise fall back to a manual
        // check-then-insert-or-update so we never throw on tables whose only PK is `id`.
        const useNativeUpsert = hasUniqueConstraint(table, conflictCols);

        let upsertStmt: any = null;
        let selectStmt: any = null;
        let insertStmt: any = null;
        let updateStmt: any = null;

        if (useNativeUpsert) {
          const sql = `INSERT INTO "${table}" (${insertCols.map(quoteIdent).join(", ")})
            VALUES (${placeholders})
            ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updateSet}`;
          upsertStmt = db.prepare(sql);
        } else {
          const conflictWhere = conflictCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ");
          const conflictValues = (row: any) =>
            conflictCols.map((c) => (row[c] !== undefined ? row[c] : null));
          const updateAssignments = insertCols
            .filter((c) => !conflictCols.includes(c))
            .map((c) => `${quoteIdent(c)} = ?`)
            .join(", ");
          selectStmt = db.prepare(`SELECT 1 FROM "${table}" WHERE ${conflictWhere} LIMIT 1`);
          insertStmt = db.prepare(
            `INSERT INTO "${table}" (${insertCols.map(quoteIdent).join(", ")}) VALUES (${placeholders})`,
          );
          updateStmt = db.prepare(
            `UPDATE "${table}" SET ${updateAssignments} WHERE ${conflictWhere}`,
          );
        }

        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue;
          const values = insertCols.map((c) => (row[c] !== undefined ? row[c] : null));
          try {
            if (useNativeUpsert) {
              upsertStmt.run(...values);
            } else {
              const conflictVals = conflictCols.map((c) => (row[c] !== undefined ? row[c] : null));
              const exists = selectStmt.get(...conflictVals);
              if (exists) {
                const updateVals = insertCols
                  .filter((c) => !conflictCols.includes(c))
                  .map((c) => (row[c] !== undefined ? row[c] : null));
                updateStmt.run(...updateVals, ...conflictVals);
              } else {
                insertStmt.run(...values);
              }
            }
          } catch (rowErr: any) {
            console.error(`Skipping invalid row in ${table}:`, rowErr?.message || rowErr);
          }
        }
      }
    });

    // AI-056: BEGIN IMMEDIATE takes the write lock before the first row. The rows
    // each catch their own error, so under a deferred BEGIN a held lock cost one
    // full busy-timeout wait per row; now it costs one wait for the whole import.
    // The loop is not cooperative: a shutdown checkpoint needs the event loop, and
    // yielding mid-transaction would let other requests on this shared connection
    // write inside it, so the restore could no longer be atomic.
    restore.immediate();

    // Re-count restored rows for the summary (post-restore authoritative counts).
    restored.deviceProfilesCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppDevices"').get() as any
    ).c;
    restored.fleetCount = (db.prepare('SELECT COUNT(*) AS c FROM "Devices"').get() as any).c;
    restored.dealsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppDealsWishlist"').get() as any
    ).c;
    restored.dealPriceHistoryCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppDealPriceHistory"').get() as any
    ).c;
    restored.alertsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppPriceAlerts"').get() as any
    ).c;
    restored.modsCount = (db.prepare('SELECT COUNT(*) AS c FROM "InstalledMods"').get() as any).c;
    restored.modsCatalogCount = (db.prepare('SELECT COUNT(*) AS c FROM "Mods"').get() as any).c;
    restored.modVersionsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "ModVersions"').get() as any
    ).c;
    restored.modDependenciesCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "ModDependencies"').get() as any
    ).c;
    restored.modLoadOrderCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "ModLoadOrder"').get() as any
    ).c;
    restored.hltbCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppCompletionRoadmapCache"').get() as any
    ).c;
    restored.tagsCount = (db.prepare('SELECT COUNT(*) AS c FROM "AppGameTags"').get() as any).c;
    restored.notesCount = (db.prepare('SELECT COUNT(*) AS c FROM "AppGameNotes"').get() as any).c;
    restored.platformHandlesCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppPlatformHandles"').get() as any
    ).c;
    restored.platformLinksCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AuthPlatformLinks"').get() as any
    ).c;
    restored.wishlistCount = (db.prepare('SELECT COUNT(*) AS c FROM "AppWishlist"').get() as any).c;
    restored.retroCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppRetroTracking"').get() as any
    ).c;
    restored.gamesCount = (db.prepare('SELECT COUNT(*) AS c FROM "AppGames"').get() as any).c;
    restored.backlogCount = (db.prepare('SELECT COUNT(*) AS c FROM "AppBacklog"').get() as any).c;
    restored.playSessionsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppPlaySessions"').get() as any
    ).c;
    restored.friendshipsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "AppFriendships"').get() as any
    ).c;
    restored.deviceReviewsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "device_reviews"').get() as any
    ).c;
    restored.reviewVotesCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "review_votes"').get() as any
    ).c;
    restored.hardwarePriceAlertsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "hardware_price_history"').get() as any
    ).c;
    restored.radarCount = (db.prepare('SELECT COUNT(*) AS c FROM "release_radar"').get() as any).c;
    restored.communityBenchmarksCount = (
      db.prepare('SELECT COUNT(*) AS c FROM "community_benchmarks"').get() as any
    ).c;

    res.json({ success: true, restored });
  } catch (err: any) {
    console.error("Error in /api/state/import:", err?.message || err);
    sendApiError(res, 500, "Failed to import state snapshot");
  }
});

export default router;
