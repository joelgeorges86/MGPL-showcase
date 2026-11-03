import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import axios from "axios";
import path from "path";
import fs from "fs";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import {
  SHUTDOWN_RETRY_MESSAGE,
  ShutdownInProgressError,
  shutdownCheckpoint,
} from "../lib/shutdown";
import { getNexusStats } from "../services/nexusService";
import {
  getCachedSteamSpecs,
  extractSteamAppId,
  seedSteamSpecsCache,
  enrichSteamSpecsForGame,
} from "../services/steamSpecs";
import { sendApiError } from "../middleware/errorSanitizer";
import { sanitizeErrorMessage } from "../utils/errorSanitizer";
const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const db: DatabaseType = openDatabase(dbPath, { readonly: true });
// writable handle for updates
const dbWrite: DatabaseType = openDatabase(dbPath);

// Sprint 7 (WUD-7.3): merge the curated public Steam Store requirements into
// the on-disk cache once at module load (live fetches refresh the cache).
seedSteamSpecsCache();

const router = Router();

// Catalog reads remain public, but every state-changing operation requires a
// valid session. This shared boundary also protects future mutation routes.
router.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    requireAuth(req, res, next);
    return;
  }
  next();
});

/**
 * `AppGames.platformStoreUrls` is stored as a JSON object string keyed by the
 * workbook's platform label ({ Steam: url, GOG: url, ... }). Always hand the
 * client an object so it never has to parse, and never throw on a bad value.
 */
const VERIFIED_LINK_HOSTS = new Set(["store.steampowered.com", "opencritic.com"]);

function verifiedExternalUrl(
  raw: unknown,
  allowedHosts: Set<string> = VERIFIED_LINK_HOSTS,
): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") return null;
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) return null;
    if (/\/search\b|[?&](q|query|term)=/i.test(parsed.href)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function parsePlatformStoreUrls(raw: any): Record<string, string> {
  if (!raw) return {};
  const parsedInput =
    typeof raw === "object"
      ? raw
      : (() => {
          try {
            return JSON.parse(String(raw));
          } catch {
            return null;
          }
        })();
  if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput)) {
    const direct = verifiedExternalUrl(raw, new Set(["store.steampowered.com"]));
    return direct ? { Steam: direct } : {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsedInput)) {
    const safe = verifiedExternalUrl(v, new Set(["store.steampowered.com"]));
    if (safe) out[k] = safe;
  }
  return out;
}

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return undefined;
};

/**
 * EPIC-03 (Paginated Browsing): strict query-parameter validation for the
 * catalog routes.
 *
 * `limit` only accepts the supported page sizes (12 / 24 / 48). Anything
 * invalid, negative, zero, or out-of-set gracefully falls back to the default
 * of 24 — callers can never force an arbitrary row cap that leaks catalog size
 * constraints or trips the SQL layer.
 *
 * `page` must be a positive integer; non-numeric, negative, or zero values
 * fall back to 1. Pages beyond the final page are clamped at slice time so a
 * deep link (?page=9999) resolves to the last page instead of an empty grid.
 */
const CATALOG_PAGE_SIZES = [12, 24, 48] as const;
const CATALOG_DEFAULT_PAGE_SIZE = 24;

function parseCatalogPage(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = typeof raw === "string" ? parseFloat(raw) : Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseCatalogLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return CATALOG_DEFAULT_PAGE_SIZE;
  const n = typeof raw === "string" ? parseFloat(raw) : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return CATALOG_DEFAULT_PAGE_SIZE;
  return (CATALOG_PAGE_SIZES as readonly number[]).includes(n) ? n : CATALOG_DEFAULT_PAGE_SIZE;
}

/**
 * EPIC-01 (Multi-Genre Filtering Engine): strict multi-value facet parser for
 * `?genre=a,b,c`. Each token is trimmed, lowercased, and cleaned of characters
 * outside a safe alphanumeric/punctuation set; tokens are de-duplicated and the
 * total is capped so a caller can never force an unbounded facet scan (mirrors
 * the page/limit hardening from EPIC-03). Returns [] when nothing valid remains
 * so callers treat the filter as absent — never an error and never a guess.
 */
const GENRE_FACET_MAX = 20;
const GENRE_FACET_CLEAN = /[^a-z0-9 &'+/._-]/g;

function parseGenreFacet(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const rawValues = Array.isArray(raw) ? raw.map((v) => String(v)) : String(raw).split(",");
  const seen = new Set<string>();
  for (const value of rawValues) {
    if (seen.size >= GENRE_FACET_MAX) break;
    const cleaned = String(value)
      .toLowerCase()
      .replace(GENRE_FACET_CLEAN, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned && !seen.has(cleaned)) seen.add(cleaned);
  }
  return [...seen];
}

/**
 * EPIC-01 (Multi-Genre Filtering Engine): facet match mode for `?genreMode=`.
 * `all` (default) requires every selected genre (intersection); `any` matches
 * games carrying at least one selected genre (union). Anything unrecognized
 * falls back to `all` so legacy single-genre callers keep identical behavior.
 */
function parseGenreMode(raw: unknown): "all" | "any" {
  if (raw === undefined || raw === null) return "all";
  const mode = String(Array.isArray(raw) ? raw[0] : raw)
    .trim()
    .toLowerCase();
  return mode === "any" ? "any" : "all";
}

/**
 * Normalizes game data from various tables to provide a consistent API with camelCase aliases.
 */
function normalizeGame(g: any) {
  if (!g) return g;
  const res = { ...g };

  // AppGames canonical fields
  res.storageSize = g["Storage Size"] ?? g.storageSize;
  res.minRamGb = g["Min RAM GB"] ?? g.minRamGb;
  res.minVramGb = g["Min VRAM GB"] ?? g.minVramGb;
  res.ssdRequired = parseBoolean(String(g["SSD Required?"] ?? g.ssdRequired));
  res.primaryGenre = g["Primary Genre"] ?? g.primaryGenre;

  // Enrichment columns from scripts/enrich_game_data.js. Null until that runs,
  // so the UI must treat every one of these as optional.
  res.storeUrl = g.storeUrl ?? null;
  res.reviewUrl = g.reviewUrl ?? null;
  res.criticScore = g.criticScore ?? null;
  res.publisher = g.publisher ?? null;
  res.developer = g.developer ?? null;
  res.headerImage = g.headerImage ?? null;
  res.cover_url = g.cover_url ?? null;
  res.platformStoreUrls = parsePlatformStoreUrls(g.platformStoreUrls);
  res.nexusUrl = g.nexusUrl ?? null;
  res.nexusModCount = g.nexusModCount ?? null;
  res.youtubeUrl = g.youtubeUrl ?? null;
  res.ignUrl = g.ignUrl ?? null;
  res.gamefaqsUrl = g.gamefaqsUrl ?? null;

  // Sprint 7 (WUD-7.1): synopsis/overview — persisted `synopsis` column first,
  // otherwise a deterministic structured summary derived from metadata already
  // in the row (never fabricated facts). UI treats it as optional.
  res.synopsis = g.synopsis ?? buildSynopsis(g) ?? null;

  // AppOwnership
  if (Array.isArray(g.ownerships)) {
    res.ownerships = g.ownerships.map((o: any) => ({
      ...o,
      platform: o.Platform ?? o.platform,
      platformCanonical: o.platformCanonical ?? null,
      storeUrl: o["Store URL"] ?? o.storeUrl ?? o.storeURL,
      ownershipType: o["Ownership Access Type"] ?? o.ownershipType ?? o.ownershipAccessType,
    }));
    res.platforms = res.ownerships;
  }

  // AppTracking
  if (Array.isArray(g.tracking)) {
    res.tracking = g.tracking.map((t: any) => ({
      ...t,
      playStatus: t["Play Status"] ?? t.playStatus,
      hoursPlayed: t["Hours Played"] ?? t.hoursPlayed,
      personalRating: t["Personal Rating (1-10)"] ?? t.personalRating,
      wantToPlay: parseBoolean(String(t["Want to Play?"] ?? t.wantToPlay)),
      notes: t.Notes ?? t.notes,
    }));
    // EPIC-UX-LIBRARY-0002: lift the primary tracking row to top level so the
    // Play Status filter and library card badges read it without re-parsing.
    const primaryTracking = res.tracking[0];
    if (primaryTracking) {
      res.playStatus = primaryTracking.playStatus ?? null;
      res.hoursPlayed = primaryTracking.hoursPlayed ?? 0;
      res.lastPlayedDate =
        primaryTracking["Last Played Date"] ?? primaryTracking.lastPlayedDate ?? null;
    }
  }

  // AppGameSettings
  if (Array.isArray(g.settings)) {
    res.settings = g.settings.map((s: any) => ({
      ...s,
      hardwareProfile: s["Hardware Profile"] ?? s.hardwareProfile,
      resolution: s["Target Resolution"] ?? s.resolution,
      fps: s["Target Framerate"] ?? s.fps,
      tdp: s["Thermal / Power Mode"] ?? s.tdp ?? s.targetTdp,
      graphicsPresets: s["Preset Level"] ?? s.graphicsPresets,
    }));
  }

  // AppGameFriction
  if (Array.isArray(g.frictions)) {
    res.frictions = g.frictions.map((f: any) => ({
      ...f,
      saveSystemType: f["Save System Type"] ?? f.saveSystemType,
      sessionLength: f["Core Session Loop Length"] ?? f.sessionLength,
      mentalEnergy: f["Cognitive / Mental Energy Required"] ?? f.mentalEnergy,
    }));
  }

  // AppCompletionRoadmap
  if (Array.isArray(g.completionRoadmaps)) {
    res.completionRoadmaps = g.completionRoadmaps.map((r: any) => ({
      ...r,
      trophyDifficulty: r["Trophy / Platinum Difficulty"] ?? r.trophyDifficulty,
      estimated100Hours: r["Estimated 100% Completion Time"] ?? r.estimated100Hours,
    }));
  }

  return res;
}

/**
 * Key Mapping Helper: Maps raw SQLite keys to frontend property names.
 */
function mapGameFields(row: any) {
  if (!row) return row;
  return {
    ...row,
    // Canonical Game Specs
    id: row.GameID || row.gameId || row.id,
    title: row["Game Title"] || row.GameTitle || row.title,
    genre: row["Primary Genre"] || row.PrimaryGenre || row.genre,
    // Granular Steam tags; `genre`/`primaryGenre` stay as the fallback display string
    genres: Array.isArray(row.genres) ? row.genres : [],
    active: row.Active || row.active || "Yes",
    storageSize: row["Storage Size"] || row.StorageSize || "N/A",
    minRamGb: row["Minimum RAM"] || row.MinimumRAM || row.minRamGb || "N/A",
    minVramGb: row["Minimum VRAM"] || row.MinimumVRAM || row.minVramGb || "N/A",
    ssdRequired: row["SSD Required?"] || row.SSDRequired || row.ssdRequired || "No",

    // EPIC-UX-LIBRARY-0002: robustly lift the primary tracking row's play
    // status + hours so the Play Status filter works regardless of the
    // intermediate normalization path.
    playStatus:
      (Array.isArray(row.tracking) &&
        row.tracking[0] &&
        (row.tracking[0]["Play Status"] || row.tracking[0].playStatus)) ||
      row.playStatus ||
      "Not Started",
    personalRating:
      row["Personal Rating (1-10)"] || row.PersonalRating || row.personalRating || null,
    wantToPlay: row["Want to Play?"] || row.WantToPlay || row.wantToPlay || "Undecided",
    hoursPlayed: Number(
      (Array.isArray(row.tracking) &&
        row.tracking[0] &&
        (row.tracking[0]["Hours Played"] ?? row.tracking[0].hoursPlayed)) ??
        row.hoursPlayed ??
        0,
    ),
    notes: row.Notes || row.notes || row["Personal Review"] || null,

    // Hardware Settings & DLC
    hardwareProfile: row["Hardware Profile"] || row.HardwareProfile || null,
    targetResolution: row["Target Resolution"] || row.TargetResolution || null,
    targetFramerate: row["Target Framerate"] || row.TargetFramerate || null,

    // External landing pages / critic metadata (see enrich_game_data.js).
    // `?? null` not `|| null` so criticScore 0 survives.
    storeUrl: row.storeUrl ?? null,
    reviewUrl: row.reviewUrl ?? null,
    criticScore: row.criticScore ?? null,
    publisher: row.publisher ?? null,
    developer: row.developer ?? null,
    headerImage: row.headerImage ?? null,
    cover_url: row.cover_url ?? null,
    platformStoreUrls: parsePlatformStoreUrls(row.platformStoreUrls),
    nexusUrl: row.nexusUrl ?? null,
    nexusModCount: row.nexusModCount ?? null,
    youtubeUrl: row.youtubeUrl ?? null,
    ignUrl: row.ignUrl ?? null,
    gamefaqsUrl: row.gamefaqsUrl ?? null,

    // Sprint 7 (WUD-7.1): synopsis/overview — persisted column first, then the
    // deterministic structured summary fallback so every card can render one.
    synopsis: row.synopsis ?? buildSynopsis(row) ?? null,

    // EPIC-UX-LIBRARY-0001: Decision-support card & sorting fields.
    // HLTB roadmap row (AppCompletionRoadmap join) already carries
    // main_story_hours / completionist_hours / Main Story Time.
    hltbMainHours:
      (Array.isArray(row.completionRoadmaps) ? row.completionRoadmaps[0] : row.completionRoadmaps)
        ?.main_story_hours ?? null,
    hltbCompletionistHours:
      (Array.isArray(row.completionRoadmaps) ? row.completionRoadmaps[0] : row.completionRoadmaps)
        ?.completionist_hours ?? null,
    // Tracking-derived sort keys (AppTracking join).
    lastPlayedDate:
      (Array.isArray(row.tracking) ? row.tracking[0] : row.tracking)?.["Last Played Date"] ??
      row.lastPlayedDate ??
      null,
    // Catalog lifecycle key (AppGames "Date Added").
    dateAdded: row["Date Added"] ?? row.dateAdded ?? null,
    // 4-digit release year derived from the platform-agnostic release date.
    releaseYear: extractReleaseYear(
      row["Original Game Release Date"] ?? row.originalGameReleaseDate ?? null,
    ),

    // Ensure ownerships and platforms array exists
    ownerships: row.ownerships || row.platforms || [],
    platforms: row.platforms || row.ownerships || [],
  };
}

/**
 * EPIC-UX-LIBRARY-0001: Extract a 4-digit release year from a raw date cell.
 * Returns null for missing / unparseable values so cards and sort comparators
 * always degrade gracefully (the UI never guesses a year).
 */
function extractReleaseYear(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const match = String(raw).match(/(19|20)\d{2}/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1970 && year <= 2100 ? year : null;
}

/**
 * Sprint 7 (WUD-7.1): deterministic structured synopsis generator.
 *
 * Composes a clean one-sentence overview purely from metadata that already
 * exists in the row (genre, developer, publisher, release year). It never
 * fabricates gameplay facts, scores, or storefront claims — when nothing
 * meaningful is present it returns null so the UI renders a neutral fallback.
 * The persisted `synopsis` column always wins over this fallback (see
 * normalizeGame / mapGameFields).
 */
function buildSynopsis(g: any): string | null {
  if (!g) return null;
  const title = String(g["Game Title"] ?? g.gameTitle ?? g.title ?? "").trim();
  if (!title) return null;
  const genre = String(g["Primary Genre"] ?? g.primaryGenre ?? g.genre ?? "").trim();
  const developer = String(g.developer ?? g["Developer"] ?? "").trim();
  const publisher = String(g.publisher ?? g["Publisher"] ?? "").trim();
  const year = extractReleaseYear(
    g["Original Game Release Date"] ?? g.originalGameReleaseDate ?? g.releaseDate ?? null,
  );

  const parts: string[] = [];
  if (genre) parts.push(`a ${genre} title`);
  if (developer || publisher) {
    const maker = developer || publisher;
    parts.push(`from ${maker}`);
  }
  if (year) parts.push(`released in ${year}`);

  if (parts.length === 0) return null;
  return `${title} — ${parts.join(", ")}.`;
}

/**
 * Sprint 7 (WUD-7.1): additive, self-healing migration for the `synopsis`
 * column on AppGames. PRAGMA-guarded so pre-migration DBs never throw and
 * re-runs are no-ops (Local-First & Non-Destructive doctrine).
 */
function ensureSynopsisColumn(): void {
  try {
    const info = dbWrite.prepare('PRAGMA table_info("AppGames")').all() as Array<{ name: string }>;
    if (!info.some((c) => c.name.toLowerCase() === "synopsis")) {
      dbWrite.prepare('ALTER TABLE "AppGames" ADD COLUMN "synopsis" TEXT').run();
      console.log('[games] Added "synopsis" column to AppGames.');
    }
  } catch (e) {
    console.warn("Could not ensure synopsis column:", e);
  }
}

/**
 * Sprint 7 (WUD-7.1): backfill empty synopsis cells from the deterministic
 * structured summary so library cards always have a clean overview without
 * ever guessing. Self-healing — runs once per server boot.
 */
function backfillSynopses(): void {
  try {
    ensureSynopsisColumn();
    // PRAGMA-guard optional enrichment/legacy columns (developer/publisher and
    // "Original Game Release Date" may be absent on fresh or minimal DBs).
    const appGamesCols = new Set(
      (dbWrite.prepare('PRAGMA table_info("AppGames")').all() as Array<{ name: string }>).map((c) =>
        c.name.toLowerCase(),
      ),
    );
    const selectCols = [
      '"GameID" as id',
      '"Game Title" as title',
      '"Primary Genre" as genre',
      appGamesCols.has("original game release date")
        ? '"Original Game Release Date" as releaseDate'
        : null,
      appGamesCols.has("developer") ? "developer" : null,
      appGamesCols.has("publisher") ? "publisher" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const rows = dbWrite
      .prepare(
        `SELECT ${selectCols} FROM "AppGames" WHERE "synopsis" IS NULL OR TRIM("synopsis") = ''`,
      )
      .all() as Array<{
      id: string;
      title: string;
      genre: string | null;
      developer?: string | null;
      publisher?: string | null;
      releaseDate?: string | null;
    }>;
    const stmt = dbWrite.prepare('UPDATE "AppGames" SET "synopsis" = ? WHERE "GameID" = ?');
    const tx = dbWrite.transaction((list: Array<{ id: string; text: string }>) => {
      for (const item of list) stmt.run(item.text, item.id);
    });
    const fills: Array<{ id: string; text: string }> = [];
    for (const r of rows) {
      const text = buildSynopsis(r);
      if (text) fills.push({ id: r.id, text });
    }
    if (fills.length) tx(fills);
  } catch (e) {
    console.warn("Could not backfill synopses:", e);
  }
}

/**
 * Granular Steam-style genre tags, sourced from AppGameGenreMap.
 * Returns an empty map if the taxonomy tables are absent (pre-migration DB),
 * so callers always fall back to the composite `primaryGenre` string.
 */
function readGenresByGame(): Record<string, string[]> {
  const byGame: Record<string, string[]> = {};
  try {
    const rows = db
      .prepare(
        `
      SELECT m."GameID" AS gameId, n."GenreName" AS genreName
      FROM "AppGameGenreMap" m
      JOIN "AppGenres" n ON n."GenreID" = m."GenreID"
      ORDER BY m."GameID", n."GenreName"
    `,
      )
      .all() as Array<{ gameId: string; genreName: string }>;
    for (const r of rows) {
      const k = String(r.gameId ?? "");
      if (!k || !r.genreName) continue;
      if (!byGame[k]) byGame[k] = [];
      byGame[k].push(r.genreName);
    }
  } catch (e) {
    // Tables not present yet - genres degrade to [] and primaryGenre is used.
  }
  return byGame;
}

/** Genre tags for a single game, empty array when unavailable. */
function readGenresForGame(gameId: string): string[] {
  try {
    const rows = db
      .prepare(
        `
      SELECT n."GenreName" AS genreName
      FROM "AppGameGenreMap" m
      JOIN "AppGenres" n ON n."GenreID" = m."GenreID"
      WHERE m."GameID" = ?
      ORDER BY n."GenreName"
    `,
      )
      .all(gameId) as Array<{ genreName: string }>;
    return rows.map((r) => r.genreName).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Review scores keyed by GameID, derived from AppReviews.
 *  - steamScore: "Steam Users" source -> Recommendation Percent (0-100)
 *  - openCriticScore: "OpenCritic" source -> Score Numeric (0-100)
 * Returns a map so callers can attach scores to each game without N+1 queries.
 */
function readScoresByGame(): Record<
  string,
  { steamScore: number | null; openCriticScore: number | null }
> {
  const byGame: Record<string, { steamScore: number | null; openCriticScore: number | null }> = {};
  try {
    const rows = db
      .prepare(
        `
      SELECT "GameID" AS gameId, "Review Source" AS source,
             "Score Numeric" AS scoreNumeric, "Recommendation Percent" AS recPercent
      FROM AppReviews
      WHERE "GameID" IS NOT NULL AND "GameID" != ''
    `,
      )
      .all() as Array<{
      gameId: string;
      source: string | null;
      scoreNumeric: number | null;
      recPercent: number | null;
    }>;
    for (const r of rows) {
      const k = String(r.gameId ?? "");
      if (!k) continue;
      if (!byGame[k]) byGame[k] = { steamScore: null, openCriticScore: null };
      const src = String(r.source || "").toLowerCase();
      if (src.includes("steam")) {
        const v = Number(r.recPercent ?? r.scoreNumeric);
        if (!Number.isNaN(v)) byGame[k].steamScore = Math.max(0, Math.min(100, Math.round(v)));
      } else if (src.includes("opencritic")) {
        const v = Number(r.scoreNumeric ?? r.recPercent);
        if (!Number.isNaN(v)) byGame[k].openCriticScore = Math.max(0, Math.min(100, Math.round(v)));
      }
    }
  } catch (e) {
    // Reviews table absent - scores degrade to null.
  }
  return byGame;
}

/**
 * Composite score: average of the available review scores (steam + openCritic).
 * Returns null when no review score exists for the game.
 */
function computeCompositeScore(
  steamScore: number | null,
  openCriticScore: number | null,
): number | null {
  const scores = [steamScore, openCriticScore].filter(
    (s): s is number => s !== null && !Number.isNaN(s),
  );
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

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

function getCachedGiveaways(): any[] {
  try {
    const giveawaysPath = path.join(
      process.cwd(),
      "scripts",
      ".cache",
      "gamerpower_giveaways.json",
    );
    if (fs.existsSync(giveawaysPath)) {
      const raw = fs.readFileSync(giveawaysPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.warn("Failed to load GamerPower giveaways cache:", err);
  }
  return [];
}

function getCachedDlcDetails(): Record<string, any> {
  try {
    const dlcDetailsPath = path.join(process.cwd(), "scripts", ".cache", "dlc_details.json");
    if (fs.existsSync(dlcDetailsPath)) {
      const raw = fs.readFileSync(dlcDetailsPath, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn("Failed to load DLC details cache:", err);
  }
  return {};
}

function buildDlcRewardsArray(
  dlcRows: any[],
  gameId: string,
  gameTitle: string,
): { dlcs: any[]; meta: any } {
  const deals = getCachedItadDeals();
  const giveaways = getCachedGiveaways();
  const dlcDetailsCache = getCachedDlcDetails();
  const cleanGameTitle = sanitizeTitle(gameTitle);

  // Check game-level status signal from DLC rows or game availability
  const hasNoDlcSignal = dlcRows.some((d: any) => {
    const avail = String(
      d["DLC Availability Status"] || d.dlcAvailabilityStatus || "",
    ).toLowerCase();
    const owned = String(d["Owned Status"] || d.ownedStatus || "").toLowerCase();
    return (
      avail.includes("no major dlc") || avail.includes("base game only") || owned.includes("no dlc")
    );
  });

  if (hasNoDlcSignal && dlcRows.length <= 1) {
    return {
      dlcs: [],
      meta: {
        totalDlcs: 0,
        ownedCount: 0,
        includedCount: 0,
        availableDealsCount: 0,
        freeRewardsCount: 0,
        availabilityStatus: "No DLCs or Expansions Available",
      },
    };
  }

  const dlcList: any[] = [];
  let ownedCount = 0;
  let includedCount = 0;
  let availableDealsCount = 0;
  let freeRewardsCount = 0;

  for (let i = 0; i < dlcRows.length; i++) {
    const d = dlcRows[i];
    const name = d["DLC Title"] || d.name || d.title || `DLC Pack ${i + 1}`;
    const cleanDlcName = sanitizeTitle(name);

    const rawOwnedStatus = String(d["Owned Status"] || d.ownedStatus || "");
    if (rawOwnedStatus.toLowerCase().includes("no dlc") || name.toLowerCase().includes("no dlc")) {
      continue;
    }

    const isIncludedInEdition = rawOwnedStatus.toLowerCase().includes("included in edition");
    const isOwned =
      rawOwnedStatus.toLowerCase().includes("owned") ||
      rawOwnedStatus.toLowerCase().includes("yes") ||
      isIncludedInEdition;

    if (isOwned && !isIncludedInEdition) ownedCount++;
    if (isIncludedInEdition) includedCount++;

    const dlcDeal = deals.find((deal: any) => {
      if (deal.type && deal.type.toLowerCase() !== "dlc") return false;
      const dealTitle = sanitizeTitle(deal.title || deal.slug || "");
      if (!dealTitle || !cleanDlcName) return false;
      return (
        dealTitle === cleanDlcName ||
        dealTitle.includes(cleanDlcName) ||
        cleanDlcName.includes(dealTitle)
      );
    });

    let price = dlcDeal?.deal?.price?.amount ? `$${dlcDeal.deal.price.amount.toFixed(2)}` : null;
    let discountPercent = dlcDeal?.deal?.cut ? `${dlcDeal.deal.cut}%` : null;
    let storeUrl = dlcDeal?.deal?.url || d["Store URL"] || d.storeUrl || null;

    if (dlcDeal) availableDealsCount++;

    const giveawayMatch = giveaways.find((g: any) => {
      const gTitle = sanitizeTitle(g.title || "");
      if (!gTitle) return false;
      return (
        (cleanDlcName && gTitle.includes(cleanDlcName)) ||
        (cleanGameTitle && gTitle.includes(cleanGameTitle) && gTitle.includes("dlc"))
      );
    });

    const isFreeReward = !!giveawayMatch;
    if (isFreeReward) {
      freeRewardsCount++;
      if (!storeUrl) storeUrl = giveawayMatch.open_giveaway_url || giveawayMatch.giveaway_url;
    }

    const cachedDetails = dlcDetailsCache[name] || dlcDetailsCache[cleanDlcName] || {};

    dlcList.push({
      dlcId: d.dlcID || d.dlcId || `dlc-${gameId}-${i + 1}`,
      name,
      isOwned,
      isIncludedInEdition,
      price,
      discountPercent,
      isFreeReward,
      storeUrl,
      notes: d["Expansion & DLC Notes"] || d.notes || cachedDetails.description || null,
      giveawayTitle: giveawayMatch?.title || null,
      giveawayInstructions: giveawayMatch?.instructions || null,
    });
  }

  return {
    dlcs: dlcList,
    meta: {
      totalDlcs: dlcList.length,
      ownedCount,
      includedCount,
      availableDealsCount,
      freeRewardsCount,
      availabilityStatus: dlcList.length > 0 ? "Available" : "No DLCs or Expansions Available",
    },
  };
}

function sanitizeTitle(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
      isInstalled: parseBoolean(String(o.isInstalled ?? o.Installed ?? "false")) ?? false,
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
      purchaseDate: o["Purchase Date"] || o.purchaseDate || null,
    });
  }

  for (const d of matchingDeals) {
    const shopName = d.deal?.shop?.name || "Store";
    if (!ownedPlatformNames.has(shopName.toLowerCase())) {
      ownedPlatformNames.add(shopName.toLowerCase());
      matrix.push({
        platform: shopName,
        isOwned: false,
        isInstalled: false,
        purchasePrice: null,
        currentPrice: d.deal?.price?.amount ? `$${d.deal.price.amount.toFixed(2)}` : null,
        discountPercent: d.deal?.cut ? `${d.deal.cut}%` : null,
        regularPrice: d.deal?.regular?.amount ? `$${d.deal.regular.amount.toFixed(2)}` : null,
        storeUrl: d.deal?.url || null,
        ownershipType: "Storefront Deal",
        edition: "Standard Edition",
        purchaseDate: null,
      });
    }
  }

  if (matrix.length === 0) {
    matrix.push({
      platform: "PC / Storefront",
      isOwned: false,
      isInstalled: false,
      purchasePrice: null,
      currentPrice: null,
      discountPercent: null,
      regularPrice: null,
      storeUrl: null,
      ownershipType: "Not Owned / Store Unlisted",
      edition: "N/A",
      purchaseDate: null,
    });
  }

  return matrix;
}

let _schemaSampleLogged = false;

/**
 * Niche / indie classification used by the Hidden Gems discovery filter
 * (EPIC-RADAR-0001). Every keyword is matched case-insensitively against the
 * game's granular Steam-style genre tags first, then falls back to the
 * composite `primaryGenre` string. Unknown or empty genres never classify —
 * the filter must never guess.
 */
const INDIE_NICHE_KEYWORDS = [
  "indie",
  "roguelike",
  "roguelite",
  "metroidvania",
  "platformer",
  "soulslike",
  "deckbuilder",
  "deck-builder",
  "visual novel",
  "puzzle",
  "strategy",
  "simulation",
  "sandbox",
  "survival",
  "point-and-click",
  "point & click",
  "tower defense",
  "tower defence",
  "hidden object",
  "dungeon crawler",
  "bullet hell",
  "rhythm",
];

function isIndieOrNiche(g: any): boolean {
  const tags: string[] = Array.isArray(g.genres)
    ? g.genres.map((t: string) => String(t).toLowerCase())
    : [];
  // Prefer explicit granular tags — nearest thing to a "niche/indie" signal.
  if (tags.length > 0) {
    return tags.some((t) => INDIE_NICHE_KEYWORDS.some((kw) => t.includes(kw)));
  }
  const genreVal = String(g["Primary Genre"] ?? g.primaryGenre ?? g.genre ?? "").toLowerCase();
  return INDIE_NICHE_KEYWORDS.some((kw) => genreVal.includes(kw));
}

// open better-sqlite3 DB once at module load to avoid Prisma coercion on read

router.get("/", async (req, res, next) => {
  try {
    const {
      search,
      genre,
      genreMode,
      platform,
      hardware,
      active,
      owned,
      minRamGb,
      maxRamGb,
      ssdRequired,
      tag,
      filter,
      page,
      limit,
    } = req.query;

    // Accept either ?platform= or ?hardware=
    const hwParam =
      typeof platform === "string" && platform
        ? platform
        : typeof hardware === "string"
          ? hardware
          : undefined;

    // Sprint 7 (WUD-7.1): self-healing synopsis column + deterministic backfill.
    backfillSynopses();

    // We will fetch raw rows directly and apply filters / relations in-memory so Prisma never coerces types
    const readTable = (names: string[]) => {
      for (const n of names) {
        try {
          return db.prepare(`SELECT * FROM ${n}`).all();
        } catch (e) {
          // ignore and try next
        }
      }
      return [];
    };

    const rawGames: any[] = readTable(["AppGames", "AppGame"]);
    const rawOwnerships: any[] = readTable(["AppOwnership", "AppOwnerships"]);
    const rawTrackings: any[] = readTable(["AppTracking", "AppTrackings"]);
    const rawSettings: any[] = readTable(["AppGameSettings", "AppSettings"]);
    const rawFrictions: any[] = readTable(["AppGameFriction"]);
    const rawRoadmaps: any[] = readTable(["AppCompletionRoadmap"]);

    // Build maps keyed by canonical id string
    const ownershipsByGame: Record<string, any[]> = {};
    for (const o of rawOwnerships) {
      const key = o.GameID ?? o.gameID ?? o.gameId ?? o.game_id ?? o.id ?? Object.values(o)[0];
      const k = String(key ?? "").toString();
      if (!ownershipsByGame[k]) ownershipsByGame[k] = [];
      ownershipsByGame[k].push(o);
    }

    const trackingsByGame: Record<string, any[]> = {};
    for (const t of rawTrackings) {
      const key = t.GameID ?? t.gameID ?? t.gameId ?? t.game_id ?? t.id ?? Object.values(t)[0];
      const k = String(key ?? "").toString();
      if (!trackingsByGame[k]) trackingsByGame[k] = [];
      trackingsByGame[k].push(t);
    }

    const settingsByGame: Record<string, any[]> = {};
    for (const s of rawSettings) {
      const key = s.GameID ?? s.gameID ?? s.gameId ?? s.game_id ?? s.id ?? Object.values(s)[0];
      const k = String(key ?? "").toString();
      if (!settingsByGame[k]) settingsByGame[k] = [];
      settingsByGame[k].push(s);
    }

    const frictionsByGame: Record<string, any[]> = {};
    for (const f of rawFrictions) {
      const key = f.GameID ?? f.gameID ?? f.gameId ?? f.game_id ?? f.id ?? Object.values(f)[0];
      const k = String(key ?? "").toString();
      if (!frictionsByGame[k]) frictionsByGame[k] = [];
      frictionsByGame[k].push(f);
    }

    const genresByGame = readGenresByGame();

    const roadmapsByGame: Record<string, any[]> = {};
    for (const r of rawRoadmaps) {
      const key = r.GameID ?? r.gameID ?? r.gameId ?? r.game_id ?? r.id ?? Object.values(r)[0];
      const k = String(key ?? "").toString();
      if (!roadmapsByGame[k]) roadmapsByGame[k] = [];
      roadmapsByGame[k].push(r);
    }

    // Sprint 2 (FEAT-MULTITENANT): Only aggregate the signed-in user's custom
    // tags. Guests (optionalAuth no-ops) get an empty tag map — never global data.
    const customTagsByGame: Record<string, any[]> = {};
    // EPIC-UX-LIBRARY-0002: signed-in user's note markdown per game, used to
    // render pinned-note snippets on library grid cards. Scoped like tags.
    const notesByGame: Record<string, string> = {};
    try {
      const viewerUserId = (req as any).user?.userId || null;
      const tagRows = viewerUserId
        ? (db
            .prepare("SELECT gameId, tagName, colorHex FROM AppGameTags WHERE userId = ?")
            .all(viewerUserId) as Array<{ gameId: string; tagName: string; colorHex?: string }>)
        : [];
      for (const tr of tagRows) {
        const k = String(tr.gameId ?? "");
        if (!k) continue;
        if (!customTagsByGame[k]) customTagsByGame[k] = [];
        customTagsByGame[k].push({ tagName: tr.tagName, colorHex: tr.colorHex });
      }
    } catch (e) {
      // ignore if table doesn't exist
    }
    try {
      const viewerUserId = (req as any).user?.userId || null;
      const noteRows = viewerUserId
        ? (db
            .prepare("SELECT gameId, noteMarkdown FROM AppGameNotes WHERE userId = ?")
            .all(viewerUserId) as Array<{ gameId: string; noteMarkdown: string }>)
        : [];
      for (const nr of noteRows) {
        const k = String(nr.gameId ?? "");
        if (k && nr.noteMarkdown) notesByGame[k] = nr.noteMarkdown;
      }
    } catch (e) {
      // ignore if table doesn't exist
    }
    const games = rawGames.map((g) => {
      const gid =
        g["GameID"] ??
        g["GameId"] ??
        g.gameID ??
        g.GameID ??
        g.gameId ??
        g.game_id ??
        g.id ??
        Object.values(g)[0];
      const k = String(gid ?? "").toString();
      const own = ownershipsByGame[k] || [];
      const trk = trackingsByGame[k] || [];
      const set = settingsByGame[k] || [];
      const fric = frictionsByGame[k] || [];
      const road = roadmapsByGame[k] || [];

      return normalizeGame({
        ...g,
        genres: genresByGame[k] || [],
        tags: customTagsByGame[k] || [],
        noteMarkdown: notesByGame[k] || "",
        ownerships: own,
        platforms: own,
        tracking: trk,
        settings: set,
        frictions: fric,
        completionRoadmaps: road,
        dlc: [], // Default to empty array
        dlcs: [],
      });
    });

    // Apply basic in-memory filters (search, genre, active, owned, min/max RAM, ssdRequired)
    let filtered = games.slice();

    if (search && typeof search === "string") {
      const s = search.toLowerCase();
      filtered = filtered.filter((g) => {
        const title = g["Game Title"] ?? g.gameTitle ?? g.title ?? "";
        const genreVal = g["Primary Genre"] ?? g.primaryGenre ?? g.genre ?? "";
        const web = g["Official Website URL"] ?? g.officialWebsiteUrl ?? "";
        const mods = g["Nexus Mods URL"] ?? g.nexusModsUrl ?? "";
        return (String(title) + " " + String(genreVal) + " " + String(web) + " " + String(mods))
          .toLowerCase()
          .includes(s);
      });
    }

    // EPIC-01 (Multi-Genre Filtering Engine): `?genre=a,b` multi-select facet
    // with configurable intersection/union semantics. Tokens are strictly
    // sanitized/capped by parseGenreFacet; `genreMode=any` switches the default
    // `all` intersection to union matching. Tagged games match on their granular
    // AppGameGenreMap tags only; the composite `Primary Genre` string is a
    // fallback for untagged rows, never a second chance to satisfy a tag.
    const wantedGenres = parseGenreFacet(genre);
    const genreMatchMode = parseGenreMode(genreMode);
    if (wantedGenres.length) {
      filtered = filtered.filter((g) => {
        const tags: string[] = Array.isArray(g.genres)
          ? g.genres.map((t: string) => String(t).toLowerCase())
          : [];
        const genreVal = String(
          g["Primary Genre"] ?? g.primaryGenre ?? g.genre ?? "",
        ).toLowerCase();
        if (genreMatchMode === "any") {
          return tags.length
            ? wantedGenres.some((w) => tags.includes(w))
            : wantedGenres.some((w) => genreVal.includes(w));
        }
        return tags.length
          ? wantedGenres.every((w) => tags.includes(w))
          : wantedGenres.every((w) => genreVal.includes(w));
      });
    }

    if (active && typeof active === "string") {
      const b = parseBoolean(active);
      if (typeof b === "boolean")
        filtered = filtered.filter((g) => {
          const val = g["Active"] ?? g.active;
          if (typeof val === "boolean") return val === b;
          if (typeof val === "string") return parseBoolean(val) === b;
          return false;
        });
    }

    if (owned && typeof owned === "string") {
      const b = parseBoolean(owned);
      if (typeof b === "boolean")
        filtered = filtered.filter((g) => {
          const key = String(g.gameID ?? g.gameId ?? g.id ?? Object.values(g)[0] ?? "");
          const has = (ownershipsByGame[key] || []).length > 0;
          return b ? has : !has;
        });
    }

    // Sprint 24 (FEAT-0156): filter by a custom tag (smart collection binder).
    // Matches gameIds present in AppGameTags for the given tag name
    // (case-insensitive). Sprint 2 (FEAT-MULTITENANT): scoped to the signed-in
    // user; guests / mismatched users get an empty result set.
    if (tag && typeof tag === "string") {
      const wanted = tag.trim().toLowerCase();
      if (wanted) {
        let taggedGameIds: Set<string>;
        const viewerUserId = (req as any).user?.userId || null;
        try {
          const rows = viewerUserId
            ? (db
                .prepare("SELECT gameId FROM AppGameTags WHERE userId = ? AND LOWER(tagName) = ?")
                .all(viewerUserId, wanted) as Array<{ gameId: string }>)
            : [];
          taggedGameIds = new Set(rows.map((r) => String(r.gameId ?? "")));
        } catch (e) {
          taggedGameIds = new Set();
        }
        filtered = filtered.filter((g) => {
          const key = String(g.gameID ?? g.gameId ?? g.id ?? Object.values(g)[0] ?? "");
          return taggedGameIds.has(key);
        });
      }
    }

    if (typeof minRamGb === "string") {
      const minV = Number(minRamGb);
      if (!Number.isNaN(minV))
        filtered = filtered.filter((g) => {
          const v = Number(g["Min RAM GB"] ?? g.minRamGb ?? g.minRam ?? g.min_ram ?? 0);
          return !Number.isNaN(v) ? v >= minV : false;
        });
    }

    if (typeof maxRamGb === "string") {
      const maxV = Number(maxRamGb);
      if (!Number.isNaN(maxV))
        filtered = filtered.filter((g) => {
          const v = Number(g["Min RAM GB"] ?? g.minRamGb ?? g.minRam ?? g.min_ram ?? 0);
          return !Number.isNaN(v) ? v <= maxV : true;
        });
    }

    if (ssdRequired && typeof ssdRequired === "string") {
      const b = parseBoolean(ssdRequired);
      if (typeof b === "boolean")
        filtered = filtered.filter((g) => {
          const v = g["SSD Required?"] ?? g.ssdRequired ?? g.ssd_required;
          if (typeof v === "boolean") return v === b;
          if (typeof v === "string") return parseBoolean(v) === b;
          return false;
        });
    }

    // Limit and sort (by title)
    const sortByTitle = (a: any, b: any) => {
      const tA = a["Game Title"] ?? a.gameTitle ?? a.title ?? "";
      const tB = b["Game Title"] ?? b.gameTitle ?? b.title ?? "";
      return String(tA).localeCompare(String(tB));
    };
    filtered.sort(sortByTitle);
    const limited = filtered.slice(0, 1000); // Increased from 200 to show full library (approx 879 titles)

    // proceed with rest of the handler which relies on games variable (below)

    // Helper: pick a readable title from game, ownerships, settings, or tracking
    function pickTitle(g: any) {
      const titleKeys = ["Game Title", "gameTitle", "title", "name", "Edition"];
      const bad = new Set(["not started", "completed", "in progress", "true", "false", ""]);

      let numericCandidate: string | null = null;

      // Primary pass: prefer non-numeric textual titles
      for (const key of titleKeys) {
        const val = g[key];
        if (val === undefined || val === null) continue;
        if (typeof val === "number") return `Game #${val}`;
        if (typeof val === "string") {
          const s = val.trim();
          if (!s) continue;
          const low = s.toLowerCase();
          if (bad.has(low)) continue;
          // purely numeric strings -> remember candidate but keep searching relations
          if (/^\d+$/.test(s)) {
            numericCandidate = s;
            continue;
          }
          return s;
        }
      }

      // Second pass: scan ownerships for descriptive fields (Platform, Store URL, Edition)
      if (Array.isArray(g.ownerships)) {
        for (const o of g.ownerships) {
          if (!o) continue;
          const fields = [
            o.platform,
            o.Platform,
            o.storeUrl,
            o.storeURL,
            o.StoreURL,
            o.edition,
            o.Edition,
            o.title,
          ];
          for (const f of fields) {
            if (!f) continue;
            if (typeof f === "number") return `Game #${f}`;
            if (typeof f === "string") {
              const s = f.trim();
              const low = s.toLowerCase();
              if (!s) continue;
              if (bad.has(low)) continue;
              if (/^\d+$/.test(s)) {
                if (!numericCandidate) numericCandidate = s;
                continue;
              }
              return s;
            }
          }
        }
      }

      // Third pass: scan settings and tracking for descriptive notes
      const collections: any[] = [];
      if (Array.isArray(g.settings)) collections.push(...g.settings);
      if (g.tracking) collections.push(...(Array.isArray(g.tracking) ? g.tracking : [g.tracking]));
      if (g.trackings)
        collections.push(...(Array.isArray(g.trackings) ? g.trackings : [g.trackings]));
      for (const rec of collections) {
        if (!rec) continue;
        for (const v of Object.values(rec)) {
          if (v === undefined || v === null) continue;
          if (typeof v === "number") return `Game #${v}`;
          if (typeof v === "string") {
            const s = v.trim();
            const low = s.toLowerCase();
            if (!s) continue;
            if (bad.has(low)) continue;
            if (/^\d+$/.test(s)) {
              if (!numericCandidate) numericCandidate = s;
              continue;
            }
            return s;
          }
        }
      }

      // If we found only a numeric candidate, prefer a readable Game ID label instead
      if (numericCandidate) {
        const explicit = g.titleMap ?? g.title_map ?? g.titleMapping ?? g.title_map_lookup;
        if (explicit && typeof explicit === "string" && explicit.trim()) return explicit.trim();
        return `Game ID: #${g.GameID ?? g.gameID ?? g.gameId ?? g.id ?? numericCandidate}`;
      }

      // Last resort: use Game ID if present
      return `Game ID: #${g.GameID ?? g.gameID ?? g.gameId ?? g.id ?? "Unknown"}`;
    }

    // Compute ROG Ally compatibility using exact DB columns when available
    function computeIsRogAlly(g: any) {
      // Check exact columns
      const playability =
        (g["ROG Ally Playability"] ?? g.ROGAllyPlayability ?? g["rogAllyPlayability"]) || null;
      if (playability) {
        const s = String(playability).toLowerCase();
        if (s.includes("ideal") || s.includes("playable") || s === "true") return true;
      }

      // Settings: look for 'Hardware Profile' === 'ROG Ally (Handheld)'
      if (Array.isArray(g.settings)) {
        for (const s of g.settings) {
          if (!s) continue;
          const profile =
            s["Hardware Profile"] ??
            s.hardwareProfile ??
            s["hardware_profile"] ??
            s.HardwareProfile;
          if (profile && String(profile).toLowerCase().includes("rog ally")) return true;
        }
      }

      // Tracking: Played Hardware Device
      const tarr = [] as any[];
      if (g.tracking) tarr.push(...(Array.isArray(g.tracking) ? g.tracking : [g.tracking]));
      if (g.trackings) tarr.push(...(Array.isArray(g.trackings) ? g.trackings : [g.trackings]));
      for (const t of tarr) {
        const dev =
          t["Played Hardware Device"] ??
          t.playedHardwareDevice ??
          t.played_hardware_device ??
          t.PlayedHardwareDevice;
        if (dev && String(dev).toLowerCase().includes("rog ally")) return true;
      }

      // Fallback: check common flags and text across top-level and ownerships
      const fields = [
        g.preferredPlatform,
        g.platform,
        g.hardwareCompatibility,
        g.supportedHardware,
        g.platforms,
        g.isRogAlly,
        g.rogAlly,
        g.isRog,
      ];
      for (const f of fields) {
        if (!f && f !== 0) continue;
        if (f === true) return true;
        if (typeof f === "string" && /rog|ally|handheld|true|yes|1/i.test(f)) return true;
      }

      if (Array.isArray(g.ownerships)) {
        for (const o of g.ownerships) {
          for (const v of Object.values(o || {})) {
            if (!v && v !== 0) continue;
            if (typeof v === "string" && /rog ally/i.test(v)) return true;
          }
        }
      }

      return false;
    }

    // Review scores (steam + openCritic) keyed by GameID, attached to each game.
    const scoresByGame = readScoresByGame();

    const gamesWithTitles = limited.map((g) => {
      const gid = String(g.GameID ?? g.gameID ?? g.gameId ?? g.id ?? Object.values(g)[0] ?? "");
      const scores = scoresByGame[gid] || { steamScore: null, openCriticScore: null };
      const steamScore = scores.steamScore;
      const openCriticScore = scores.openCriticScore;
      const compositeScore = computeCompositeScore(steamScore, openCriticScore);
      const title = pickTitle(g);
      const domain = gameDomainForTitle(title);
      const hasNexusSignal = !!(g.nexusUrl || g.nexusModCount || g.trackedModCount);
      const isModdable = !!domain && domain !== "unknown" && hasNexusSignal;
      return mapGameFields({
        ...g,
        gameTitle: title,
        isRogAlly: computeIsRogAlly(g),
        steamScore,
        openCriticScore,
        compositeScore,
        isModdable,
      });
    });

    // If a hardware/platform parameter was provided, perform robust, case-insensitive filtering in-memory
    let finalGames = gamesWithTitles;

    if (hwParam && typeof hwParam === "string") {
      const needle = hwParam.trim().toLowerCase();
      const needleWeak = needle.replace(/[^a-z0-9]/g, "");
      // If the query is a broad hardware token like 'rog' or 'ally' or 'handheld', search for those tokens instead
      const broadTokens = ["rog", "ally", "handheld"];
      const useBroad = broadTokens.some((t) => needle.includes(t) || needleWeak.includes(t));
      const tokens = useBroad ? broadTokens : [needle];

      finalGames = finalGames.filter((g) => {
        // Check exact platform matches in platforms/ownerships arrays safely
        const platMatch =
          (Array.isArray(g.platforms) ? g.platforms : []).some((p: any) => {
            const name = typeof p === "string" ? p : (p?.platform ?? p?.Platform ?? "");
            return name.toLowerCase().trim() === needle;
          }) ||
          (Array.isArray(g.ownerships) ? g.ownerships : []).some((o: any) => {
            const name = typeof o === "string" ? o : (o?.platform ?? o?.Platform ?? "");
            return name.toLowerCase().trim() === needle;
          });

        if (platMatch) return true;

        // Check top-level fields and settings/tracking
        const tops = [
          g["preferredPlatform"],
          g["platform"],
          g["hardwareCompatibility"],
          g["supportedHardware"],
        ];
        // include settings values
        if (Array.isArray(g.settings)) {
          for (const s of g.settings) {
            if (!s) continue;
            tops.push(...Object.values(s));
          }
        }
        // include tracking values
        if (g.tracking) {
          const tarr = Array.isArray(g.tracking) ? g.tracking : [g.tracking];
          for (const t of tarr) {
            if (!t) continue;
            tops.push(...Object.values(t));
          }
        }

        const normalizedTops = tops.filter(Boolean).map((v) => String(v).toLowerCase());
        for (const t of normalizedTops) {
          const cleaned = t.replace(/[^a-z0-9]/g, "");
          for (const token of tokens) {
            if (t.includes(token) || cleaned.includes(token)) return true;
          }
        }

        // Check ownerships
        if (Array.isArray(g.ownerships)) {
          for (const o of g.ownerships) {
            const opts = [o.platform, o.preferredPlatform];
            opts.push(...Object.values(o || {}));
            const norm = opts.filter(Boolean).map((v) => String(v).toLowerCase());
            for (const t of norm) {
              const cleaned = t.replace(/[^a-z0-9]/g, "");
              for (const token of tokens) {
                if (t.includes(token) || cleaned.includes(token)) return true;
              }
            }
          }
        }

        // Check boolean/string flags (only if searching for broad hardware like ROG Ally)
        if (useBroad) {
          const flags = [g.isRogAlly, g.rogAlly, g["isRog"], g["rog"]];
          for (const f of flags) {
            if (f === true) return true;
            if (typeof f === "string" && ["true", "yes", "1"].includes(String(f).toLowerCase()))
              return true;
          }
        }

        return false;
      });
    }

    finalGames = Array.from(
      new Map(
        finalGames.map((g) => [(g.title || g.gameTitle || "").toLowerCase().trim(), g]),
      ).values(),
    );

    // Sprint 1 (EPIC-RADAR-0001): Hidden Gems discovery filter. Surfaces only
    // titles with a composite critic/community rating >= 80 AND a niche/indie
    // classification, ranked by composite score descending so the highest-rated
    // hidden gems surface first. Builds purely on existing catalog data.
    if (filter === "hidden-gems") {
      finalGames = finalGames.filter((g: any) => {
        const score = Number(g.compositeScore);
        if (!Number.isFinite(score) || score < 80) return false;
        return isIndieOrNiche(g);
      });
      finalGames = finalGames.slice().sort((a: any, b: any) => {
        const sa = Number(a.compositeScore) || -1;
        const sb = Number(b.compositeScore) || -1;
        if (sb !== sa) return sb - sa;
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
    }

    // Platform quick-lists (dashboard platform breakdown) are ranked by
    // composite score descending so the highest-rated owned games surface first.
    if (hwParam && typeof hwParam === "string") {
      finalGames = finalGames.slice().sort((a: any, b: any) => {
        const sa = a.compositeScore ?? -1;
        const sb = b.compositeScore ?? -1;
        if (sb !== sa) return sb - sa;
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
    }

    const total = finalGames.length;

    // EPIC-03 (Paginated Browsing): server-side pagination is opt-in via the
    // `page` query parameter. `limit` (validated to 12/24/48) and `page` are
    // strictly parsed above; when `page` is supplied the payload carries page
    // metadata so deep links (?page=N) resolve deterministically and callers
    // can render Previous / Page N of M / Next controls. Callers that omit
    // `page` keep the legacy full-catalog contract unchanged, so existing
    // consumers (and the client-side facet pipeline) are untouched.
    const paginationRequested = page !== undefined && page !== null && String(page).trim() !== "";
    if (paginationRequested) {
      const pageSize = parseCatalogLimit(limit);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(parseCatalogPage(page), totalPages);
      const start = (safePage - 1) * pageSize;
      return res.json({
        success: true,
        games: finalGames.slice(start, start + pageSize),
        total,
        page: safePage,
        limit: pageSize,
        totalPages,
      });
    }

    res.json({
      success: true,
      games: finalGames,
      total,
    });
  } catch (error) {
    console.error("Catalog fetch error:", error);
    sendApiError(res, 500, "Failed to load catalog");
  }
});

/**
 * EPIC-01 (Multi-Genre Filtering Engine): distinct genre facet list sourced
 * from the CMS-extensible `AppGenres` taxonomy (managed by the Steam-tag sync
 * pipeline), each with its live catalog game count. The client uses this as the
 * authoritative genre tag source so the facet pills stay CMS-extensible. The
 * route is declared before the `/:gameId` catch-all so `genres` never resolves
 * as a game id.
 */
router.get("/genres", (_req, res) => {
  try {
    // Graceful degradation: the AppGenres / AppGameGenreMap taxonomy tables are
    // created by the Steam-tag sync pipeline (scripts/fetch_steam_tags.js). On a
    // DB where the pipeline has not run, return an empty facet list — never a
    // 500 — mirroring how readGenresByGame() treats absent taxonomy tables.
    const hasTaxonomy = db
      .prepare(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name IN ('AppGenres','AppGameGenreMap')`,
      )
      .get() as { c: number };
    if (!hasTaxonomy || hasTaxonomy.c < 2) {
      return res.json({ success: true, genres: [] });
    }
    const rows = db
      .prepare(
        `
      SELECT n."GenreName" AS genre, COUNT(m."GameID") AS count
      FROM "AppGenres" n
      LEFT JOIN "AppGameGenreMap" m ON m."GenreID" = n."GenreID"
      GROUP BY n."GenreID", n."GenreName"
      ORDER BY n."GenreName" COLLATE NOCASE ASC
    `,
      )
      .all() as Array<{ genre: string; count: number }>;
    res.json({ success: true, genres: rows });
  } catch (err) {
    console.error("Error in /api/games/genres:", err);
    sendApiError(res, 500, "Failed to load genre facets");
  }
});

router.get("/:gameId/nexus-stats", async (req, res) => {
  try {
    const { gameId } = req.params;
    let game: any = null;
    const mainTables = ["AppGames", "AppGame"];
    for (const tbl of mainTables) {
      try {
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as any[];
        const idCol = cols.find((c) =>
          ["GameID", "GameId", "gameID", "gameId", "id"].includes(c.name),
        )?.name;
        if (idCol) {
          game = db.prepare(`SELECT * FROM ${tbl} WHERE "${idCol}" = ?`).get(gameId);
          if (game) break;
        }
      } catch (e) {
        /* continue */
      }
    }

    if (!game) {
      return res.status(404).json({ error: "Game not found" });
    }

    const title = game["Game Title"] || game.title || game.gameTitle || "";
    const stats = await getNexusStats(gameId, title);

    return res.json({
      success: true,
      ...stats,
    });
  } catch (err) {
    console.error("Error fetching nexus stats:", err);
    return sendApiError(res, 500, "Failed to fetch nexus stats", undefined, {
      includeSuccess: false,
    });
  }
});

/**
 * Map a normalized game title to a Nexus Mods game domain slug used by the
 * InstalledMods table. Falls back to a sanitized slug when no known mapping
 * exists so the drawer still surfaces any matching installed mods.
 */
export function gameDomainForTitle(title: string): string {
  const t = (title || "").trim().toLowerCase();
  const known: Record<string, string> = {
    skyrim: "skyrimspecialedition",
    "skyrim special edition": "skyrimspecialedition",
    "the elder scrolls v: skyrim": "skyrimspecialedition",
    "the elder scrolls v skyrim": "skyrimspecialedition",
    "cyberpunk 2077": "cyberpunk2077",
    "the witcher 3": "witcher3",
    "the witcher 3: wild hunt": "witcher3",
    "witcher 3": "witcher3",
    "baldurs gate 3": "baldursgate3",
    "baldur's gate 3": "baldursgate3",
    "stardew valley": "stardewvalley",
    "fallout 4": "fallout4",
    "fallout: new vegas": "falloutnewvegas",
    "fallout new vegas": "falloutnewvegas",
    "elden ring": "eldenring",
    "red dead redemption 2": "reddeadredemption2",
    rdr2: "reddeadredemption2",
    starfield: "starfield",
    "hogwarts legacy": "hogwartslegacy",
    "god of war": "godofwar",
    "god of war ragnarok": "godofwarragnarok",
    "horizon zero dawn": "horizonzerodawn",
    "horizon forbidden west": "horizonforbiddenwest",
    "mass effect": "masseffect",
    "the sims 4": "thesims4",
    "cities: skylines": "citiesskylines",
    "cities skylines": "citiesskylines",
    factorio: "factorio",
    satisfactory: "satisfactory",
    valheim: "valheim",
    subnautica: "subnautica",
    "no man's sky": "nomanssky",
    "no mans sky": "nomanssky",
    minecraft: "minecraft",
    terraria: "terraria",
    hades: "hades",
    "hades ii": "hades2",
    "hades 2": "hades2",
    "disco elysium": "discoelysium",
    "outer wilds": "outerwilds",
    "the outer worlds": "theouterworlds",
    control: "control",
    "death stranding": "deathstranding",
    "ghost of tsushima": "ghostoftsushima",
    "spider-man": "spiderman",
    "spider-man remastered": "spidermanremastered",
    "spider-man miles morales": "spidermanmilesmorales",
    "ratchet & clank: rift apart": "ratchetandclankriftapart",
    returnal: "returnal",
    "the last of us part i": "thelastofusparti",
    "uncharted: legacy of thieves": "unchartedlegacyofthieves",
    "days gone": "daysgone",
    "detroit: become human": "detroitbecomehuman",
    "heavy rain": "heavyrain",
    "beyond: two souls": "beyondtwosouls",
    "resident evil 4": "residentevil4",
    "resident evil 2": "residentevil2",
    "resident evil 3": "residentevil3",
    "resident evil village": "residentevilvillage",
    "resident evil 7": "residentevil7",
    "dead space": "deadspace",
    "alan wake": "alanwake",
    "alan wake 2": "alanwake2",
    "max payne": "maxpayne",
    "max payne 3": "maxpayne3",
    "grand theft auto v": "grandtheftautov",
    "gta v": "grandtheftautov",
    "fallout 76": "fallout76",
    "fallout 3": "fallout3",
  };
  if (known[t]) return known[t];
  // Sanitized slug fallback: strip non-alphanumerics, collapse spaces.
  return t.replace(/[^a-z0-9]+/g, "").replace(/^the/, "") || "unknown";
}

/**
 * GET /api/games/detail?title=
 * Unified cross-hub game drawer aggregator. Combines deals, installed mods,
 * HLTB time-to-beat metrics, and a fleet headroom playability rating into a
 * single payload for the frontend drawer.
 */
router.get("/detail", (req, res, next) => {
  const title = String((req.query.title as string) || "").trim();
  if (!title) {
    return res.status(400).json({ error: "title query parameter is required" });
  }
  try {
    // Deals: wishlist entry + price alerts for this title.
    let wishlist: any = null;
    let alerts: any[] = [];
    try {
      wishlist =
        db.prepare("SELECT * FROM AppDealsWishlist WHERE gameTitle = ?").get(title) || null;
    } catch (e) {
      /* table may be empty */
    }
    try {
      alerts = db
        .prepare(
          "SELECT * FROM AppPriceAlerts WHERE title = ? OR gameId = ? ORDER BY updatedAt DESC",
        )
        .all(title, title) as any[];
    } catch (e) {
      /* table may be empty */
    }

    // Mods: installed mods matching the game's Nexus domain slug.
    const gameDomain = gameDomainForTitle(title);
    let installedMods: any[] = [];
    try {
      installedMods = db
        .prepare("SELECT * FROM InstalledMods WHERE gameDomain = ? ORDER BY installedAt DESC")
        .all(gameDomain) as any[];
    } catch (e) {
      /* table may be empty */
    }

    // HLTB: cached roadmap metrics (main story / main+extra / completionist).
    let hltb = {
      mainStory: null,
      mainExtra: null,
      completionist: null,
      hltbScore: null,
      source: "none",
    };
    try {
      const cached = db
        .prepare(
          'SELECT "mainStory", "mainExtra", "completionist", "hltbScore" FROM "AppCompletionRoadmapCache" WHERE "gameTitle" = ?',
        )
        .get(title) as any;
      if (cached) {
        hltb = {
          mainStory: cached.mainStory ?? null,
          mainExtra: cached.mainExtra ?? null,
          completionist: cached.completionist ?? null,
          hltbScore: cached.hltbScore ?? null,
          source: "cache",
        };
      }
    } catch (e) {
      /* no cached metrics */
    }

    // Fleet headroom: estimated playability rating from the primary device rig.
    let fleetHeadroom: {
      rating: string;
      deviceName: string | null;
      ramGb: number | null;
      vramGb: number | null;
    } = { rating: "30-60 FPS Playable", deviceName: null, ramGb: null, vramGb: null };
    try {
      const device = db
        .prepare("SELECT * FROM Devices ORDER BY isPrimary DESC, updatedAt DESC LIMIT 1")
        .get() as any;
      if (device) {
        const devRam = Number(device.ramGb) || 16;
        const devVram = Number(device.vramGb) || 6;
        const game = db.prepare('SELECT * FROM AppGames WHERE "Game Title" = ?').get(title) as any;
        const minRam = Number(game?.minRamGb) || 8;
        const minVram = Number(game?.minVramGb) || 2;
        let rating = "30-60 FPS Playable";
        if (devRam < minRam || devVram < minVram) rating = "Low FPS / Tweaks Needed";
        else if (devRam >= minRam + 8 && devVram >= minVram + 4) rating = "Optimal / 60+ FPS";
        fleetHeadroom = {
          rating,
          deviceName: device.deviceName || device.name || null,
          ramGb: devRam,
          vramGb: devVram,
        };
      }
    } catch (e) {
      /* no device profile */
    }

    // ProtonDB (WUD-2.3 / EPIC-03): resolve a Steam AppID for the community
    // compatibility badge. Preferred source: the Steam store URL; fallback to
    // a numeric GameID. Never blocks the aggregated payload when absent.
    let steamAppId: string | null = null;
    try {
      const game = db
        .prepare(
          'SELECT "GameID" AS gameId, "storeUrl" AS storeUrl, "platformStoreUrls" AS platformStoreUrls FROM "AppGames" WHERE "Game Title" = ?',
        )
        .get(title) as
        { gameId: string; storeUrl: string | null; platformStoreUrls: string | null } | undefined;
      const candidates = [game?.storeUrl, game?.platformStoreUrls];
      const appUrl = candidates.find(
        (u) => typeof u === "string" && /store\.steampowered\.com\/app\/\d+/.test(u),
      );
      const m = appUrl ? /store\.steampowered\.com\/app\/(\d+)/.exec(appUrl) : null;
      if (m) {
        steamAppId = m[1];
      } else if (game?.gameId && /^\d+$/.test(String(game.gameId))) {
        steamAppId = String(game.gameId);
      }
    } catch (e) {
      /* ProtonDB AppID resolution is best-effort */
    }

    return res.json({
      gameTitle: title,
      gameDomain,
      steamAppId,
      deals: { wishlist, alerts, alertCount: alerts.length },
      mods: { count: installedMods.length, installedMods },
      hltb,
      fleetHeadroom,
    });
  } catch (err: any) {
    console.error("Error aggregating game detail:", err);
    // Sprint 1A (EPICSEC04): never send the raw error message to the client.
    return sendApiError(res, 500, "Failed to aggregate game detail", undefined, {
      includeSuccess: false,
    });
  }
});

router.get("/:gameId", (req, res, next) => {
  const { gameId } = req.params;
  if (gameId === "quick-matcher" || gameId === "nexus-stats") return next(); // Delegate to next route
  if (gameId === "stats" || gameId === "analytics") return next();

  // Sprint 7 (WUD-7.1): self-healing synopsis column + deterministic backfill.
  backfillSynopses();

  console.log("Fetching game details for:", gameId);
  try {
    // Use raw better-sqlite3 to ensure all space-containing column names and complex relations are fetched correctly
    // We try several likely table names for the main game record
    let game: any = null;
    const mainTables = ["AppGames", "AppGame"];
    for (const tbl of mainTables) {
      try {
        // Check columns first to avoid "no such column" errors
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as any[];
        const idCol = cols.find((c) =>
          ["GameID", "GameId", "gameID", "gameId", "id"].includes(c.name),
        )?.name;
        if (idCol) {
          game = db.prepare(`SELECT * FROM ${tbl} WHERE "${idCol}" = ?`).get(gameId);
          if (game) break;
        }
      } catch (e) {
        /* continue */
      }
    }

    if (!game) {
      return res.status(404).json({ error: "Game not found" });
    }

    const gid = game.GameID || game.GameId || game.gameID || game.id;

    // Helper to fetch from likely table names for relations
    const fetchRelation = (tables: string[], id: string) => {
      for (const tbl of tables) {
        try {
          const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as any[];
          const idCol = cols.find((c) =>
            ["GameID", "GameId", "gameID", "gameId", "id"].includes(c.name),
          )?.name;
          if (idCol) {
            return db.prepare(`SELECT * FROM ${tbl} WHERE "${idCol}" = ?`).all(id);
          }
        } catch (e) {
          /* continue */
        }
      }
      return [];
    };

    const ownerships = fetchRelation(["AppOwnership", "AppOwnerships"], gid);
    const tracking = fetchRelation(["AppTracking", "AppTrackings"], gid);
    const settings = fetchRelation(["AppGameSettings", "AppSettings"], gid);
    const frictions = fetchRelation(["AppGameFriction"], gid);
    const completionRoadmaps = fetchRelation(["AppCompletionRoadmap"], gid);
    const reviews = fetchRelation(["AppReviews", "AppReview"], gid);
    const dlcRows = fetchRelation(["AppDLCs", "AppDLC", "AppGameDLC"], gid);

    const gameTitleStr = game["Game Title"] || game.title || game.gameTitle || "";
    const { dlcs, meta: dlcRewardsMeta } = buildDlcRewardsArray(dlcRows, String(gid), gameTitleStr);

    // Individual tracked Nexus Mods for this game (InstalledMods table)
    let installedModsRows: any[] = [];
    try {
      installedModsRows = db
        .prepare('SELECT * FROM "InstalledMods" WHERE "gameId" = ? ORDER BY "installed_at" DESC')
        .all(String(gid)) as any[];
    } catch (e) {
      installedModsRows = [];
    }
    const mods = installedModsRows.map((m: any) => ({
      id: m.modId ?? String(m.id),
      name: m.modName ?? "Unknown Mod",
      version: m.version ?? m.modVersion ?? null,
      category: m.category ?? m.modCategory ?? null,
      isEnabled: m.isActive === 1 || m.isActive === true,
      nexusUrl: m.nexusUrl ?? m.modUrl ?? (game.nexusUrl ? String(game.nexusUrl) : null),
    }));

    // Pull tracking fields to top level as requested
    const trackingRow = (Array.isArray(tracking) ? tracking[0] : tracking) as any;

    // Process hardware requirements with clean fallbacks (supports AppGames & SystemSpecs)
    const sysSpecsRows = fetchRelation(["SystemSpecs", "SystemSpec", "AppSystemSpecs"], gid);
    const sysSpecsRow =
      ((Array.isArray(sysSpecsRows) ? sysSpecsRows[0] : sysSpecsRows) as any) || {};

    const minRam =
      game["Min RAM GB"] ??
      game.minRamGb ??
      sysSpecsRow["Min RAM GB"] ??
      sysSpecsRow.minRamGb ??
      sysSpecsRow.ramGb ??
      null;
    const minVram =
      game["Min VRAM GB"] ??
      game.minVramGb ??
      sysSpecsRow["Min VRAM GB"] ??
      sysSpecsRow.minVramGb ??
      sysSpecsRow.vramGb ??
      null;
    const minCpu =
      game["Min CPU"] ??
      game["Minimum CPU"] ??
      game.minCpu ??
      sysSpecsRow["Min CPU"] ??
      sysSpecsRow["Minimum CPU"] ??
      sysSpecsRow.minCpu ??
      sysSpecsRow.cpu ??
      null;
    const minGpu =
      game["Min GPU"] ??
      game["Minimum GPU"] ??
      game.minGpu ??
      sysSpecsRow["Min GPU"] ??
      sysSpecsRow["Minimum GPU"] ??
      sysSpecsRow.minGpu ??
      sysSpecsRow.gpu ??
      null;
    const ssdReq =
      parseBoolean(
        String(
          game["SSD Required?"] ??
            game.ssdRequired ??
            sysSpecsRow["SSD Required?"] ??
            sysSpecsRow.ssdRequired,
        ),
      ) ?? null;
    const storageSize =
      game["Storage Size"] ||
      game.storageSize ||
      sysSpecsRow["Storage Size"] ||
      sysSpecsRow.storageSize ||
      null;

    const recRam =
      game["Rec RAM GB"] ??
      game["Recommended RAM GB"] ??
      game.recRamGb ??
      sysSpecsRow["Rec RAM GB"] ??
      sysSpecsRow["Recommended RAM GB"] ??
      sysSpecsRow.recRamGb ??
      null;
    const recVram =
      game["Rec VRAM GB"] ??
      game["Recommended VRAM GB"] ??
      game.recVramGb ??
      sysSpecsRow["Rec VRAM GB"] ??
      sysSpecsRow["Recommended VRAM GB"] ??
      sysSpecsRow.recVramGb ??
      null;
    const recCpu =
      game["Rec CPU"] ??
      game["Recommended CPU"] ??
      game.recCpu ??
      sysSpecsRow["Rec CPU"] ??
      sysSpecsRow["Recommended CPU"] ??
      sysSpecsRow.recCpu ??
      null;
    const recGpu =
      game["Rec GPU"] ??
      game["Recommended GPU"] ??
      game.recGpu ??
      sysSpecsRow["Rec GPU"] ??
      sysSpecsRow["Recommended GPU"] ??
      sysSpecsRow.recGpu ??
      null;

    // Sprint 7 (WUD-7.3): live/cached Steam Store requirements as the final
    // fallback tier — fills CPU/GPU (and rec RAM/VRAM) gaps so detail pages
    // never render empty spec fields. Sync cache read + non-blocking refresh.
    const steamSpecs = getCachedSteamSpecs(String(gid), extractSteamAppId(game.platformStoreUrls));
    const steamMin = steamSpecs?.minimum || null;
    const steamRec = steamSpecs?.recommended || null;
    if (game.platformStoreUrls && !steamSpecs) {
      enrichSteamSpecsForGame(String(gid), gameTitleStr, game.platformStoreUrls).catch(() => null);
    }

    // Return exact structure as requested
    const result = {
      id: gid,
      title: game["Game Title"] || game.title || game.gameTitle,
      genre: game["Primary Genre"] || game.genre || game.primaryGenre,
      // Granular Steam tags; `genre`/`primaryGenre` remain the fallback display string
      genres: readGenresForGame(String(gid)),
      primaryGenre: game["Primary Genre"] || game.primaryGenre || game.genre,
      active:
        game.Active === 1 || game.Active === true || String(game.Active).toLowerCase() === "yes"
          ? "Yes"
          : "No",
      storageSize: storageSize || "N/A",
      officialWebsiteUrl: game["Official Website URL"] || game.officialWebsiteUrl || null,
      releaseDate: game["Original Game Release Date"] ?? game["originalGameReleaseDate"] ?? null,

      // Hardware Specs Contract
      specs: {
        minimum: {
          ramGb: minRam
            ? String(minRam).toLowerCase().includes("gb")
              ? String(minRam)
              : `${minRam} GB`
            : steamMin?.ramGb != null
              ? `${steamMin.ramGb} GB`
              : null,
          vramGb: minVram
            ? String(minVram).toLowerCase().includes("gb")
              ? String(minVram)
              : `${minVram} GB`
            : steamMin?.vramGb != null
              ? `${steamMin.vramGb} GB`
              : null,
          cpu: minCpu || steamMin?.cpu || null,
          gpu: minGpu || steamMin?.gpu || null,
          storage: storageSize || steamMin?.storage || null,
          ssdRequired: ssdReq !== null ? (ssdReq ? "Yes" : "No") : null,
        },
        recommended: {
          ramGb: recRam
            ? String(recRam).toLowerCase().includes("gb")
              ? String(recRam)
              : `${recRam} GB`
            : steamRec?.ramGb != null
              ? `${steamRec.ramGb} GB`
              : null,
          vramGb: recVram
            ? String(recVram).toLowerCase().includes("gb")
              ? String(recVram)
              : `${recVram} GB`
            : steamRec?.vramGb != null
              ? `${steamRec.vramGb} GB`
              : null,
          cpu: recCpu || steamRec?.cpu || null,
          gpu: recGpu || steamRec?.gpu || null,
          storage: storageSize || steamRec?.storage || null,
          ssdRequired: null,
        },
      },
      minRamGb: minRam,
      minVramGb: minVram,
      ssdRequired: ssdReq,

      // Direct external landing pages, mirrored from the list payload so the
      // modal can link out without a second lookup.
      storeUrl: verifiedExternalUrl(game.storeUrl, new Set(["store.steampowered.com"])),
      reviewUrl: verifiedExternalUrl(game.reviewUrl, new Set(["opencritic.com"])),
      criticScore: game.criticScore ?? null,
      reviewSource: game.reviewSource ?? null,
      publisher: game.publisher ?? game["Publisher"] ?? null,
      developer: game.developer ?? game["Developer"] ?? game.publisher ?? null,
      headerImage: game.headerImage ?? null,
      cover_url: game.cover_url ?? game["Cover URL"] ?? game.headerImage ?? null,
      coverUrl: game.cover_url ?? game["Cover URL"] ?? game.headerImage ?? null,
      cover: game.cover_url ?? game["Cover URL"] ?? game.headerImage ?? null,
      gameId: gid,
      platformStoreUrls: parsePlatformStoreUrls(game.platformStoreUrls),
      nexusUrl: game.nexusUrl ?? null,
      nexusModCount: game.nexusModCount ?? null,
      youtubeUrl: game.youtubeUrl ?? null,
      ignUrl: game.ignUrl ?? null,
      gamefaqsUrl: game.gamefaqsUrl ?? null,
      // Sprint 7 (WUD-7.1): synopsis/overview surfaced on the detail payload.
      synopsis: game.synopsis ?? buildSynopsis(game) ?? null,
      platforms: buildPlatformMatrix(
        game["Game Title"] || game.title || game.gameTitle || "",
        ownerships,
      ),
      ownerships: ownerships.map((o: any) => ({
        platform: o.Platform || o.platform,
        storeUrl: verifiedExternalUrl(
          o["Store URL"] || o.storeUrl || o.storeURL,
          new Set(["store.steampowered.com"]),
        ),
      })),
      dlcs,
      dlcRewardsMeta,
      mods,

      dlc: dlcs.map((d: any) => ({
        name: d.name,
        status: d.isOwned ? (d.isIncludedInEdition ? "Included in Edition" : "Owned") : "Not Owned",
        notes: d.notes || "—",
      })),
      settings: settings.map((s: any) => ({
        hardwareProfile: s["Hardware Profile"] || s.hardwareProfile,
        targetResolution: s["Target Resolution"] || s.resolution || s.targetResolution,
        targetFramerate: s["Target Framerate"] || s.fps || s.targetFramerate,
        tdp: s["Thermal / Power Mode"] || s.tdp || s.targetTdp,
      })),
      frictions: frictions.map((f: any) => ({
        saveSystemType: f["Save System Type"] || f.saveSystemType,
        sessionLength: f["Core Session Loop Length"] || f.sessionLength,
        mentalEnergy: f["Cognitive / Mental Energy Required"] || f.mentalEnergy,
        thirdPartyLauncher: f["Third-Party Launcher Required?"] || f.thirdPartyLauncherRequired,
        alwaysOnline: f["Always-Online Required?"] || f.alwaysOnlineRequired,
      })),
      completionRoadmaps: completionRoadmaps.map((r: any) => ({
        mainStoryTime:
          r["Main Story Time"] ||
          r.mainStoryTime ||
          (r.main_story_hours ? `${r.main_story_hours} hrs` : null),
        estimated100Hours:
          r["Estimated 100% Completion Time"] ||
          r.estimated100Hours ||
          (r.completionist_hours ? `${r.completionist_hours} hrs` : null),
        mainStoryHours: r.main_story_hours ?? null,
        completionistHours: r.completionist_hours ?? null,
        trophyDifficulty: r["Trophy / Platinum Difficulty"] || r.trophyDifficulty || null,
        trophyRoadmapGuideUrl: r["Trophy Roadmap & Guide URL"] || r.trophyRoadmapGuideUrl || null,
      })),
      playStatus: trackingRow?.["Play Status"] || trackingRow?.playStatus || "Not Started",
      personalRating:
        trackingRow?.["Personal Rating (1-10)"] || trackingRow?.personalRating || null,
      personalReview: trackingRow?.["Personal Review"] || trackingRow?.personalReview || null,
      estimatedTime: game["Estimated Game Time"] || game.estimatedGameTime || "10 hrs",
      notes: trackingRow?.["DLC Status"] || trackingRow?.notes || "—",
      reviews: reviews.map((r: any) => ({
        source: r["Review Source"] || r.source,
        summary: r["Review Summary / Score"] || r.summary,
        scoreNumeric: r["Score Numeric"] || r.scoreNumeric,
        recommendationPercent: r["Recommendation Percent"] || r.recommendationPercent,
        worthGrade: r["Worth Playing Grade"] || r.worthGrade,
        url: verifiedExternalUrl(r["Review URL"] || r.url, new Set(["opencritic.com"])),
      })),
    };

    return res.json({
      success: true,
      game: result,
    });
  } catch (error) {
    console.error(`Primary query for game ${gameId} failed:`, error);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

function ensureTuningColumns() {
  const table = "AppTracking";
  const columns = [
    { name: "targetTdp", type: "TEXT" },
    { name: "targetFps", type: "TEXT" },
    { name: "resolution", type: "TEXT" },
    { name: "cpuBoost", type: "TEXT" },
    { name: "tuningNotes", type: "TEXT" },
    { name: "playNotes", type: "TEXT" },
    { name: "achievementNotes", type: "TEXT" },
    { name: "tags", type: "TEXT" },
  ];

  try {
    const info = dbWrite.prepare(`PRAGMA table_info("${table}")`).all() as any[];
    const existingNames = info.map((c) => c.name.toLowerCase());

    for (const col of columns) {
      if (!existingNames.includes(col.name.toLowerCase())) {
        dbWrite.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${col.type}`).run();
      }
    }
  } catch (e) {
    console.warn("Could not ensure tuning columns:", e);
  }
}

router.patch("/:gameId/tags", (req, res) => {
  try {
    const { gameId } = req.params;
    let { tags } = req.body;

    if (Array.isArray(tags)) {
      tags = tags.join(", ");
    }

    ensureTuningColumns();

    const candidateTables = ["AppTracking", "AppTrackings"];
    let updated = false;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}" 
          SET tags = ?
          WHERE GameID = ? OR gameId = ?
        `,
          )
          .run(tags, gameId, gameId);

        if (info.changes > 0) {
          updated = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!updated) {
      try {
        dbWrite
          .prepare(
            `
          INSERT INTO AppTracking (GameID, tags)
          VALUES (?, ?)
        `,
          )
          .run(gameId, tags);
        updated = true;
      } catch (e) {
        console.error("Failed to insert tags record:", e);
      }
    }

    if (updated) {
      return res.json({
        success: true,
        gameId,
        tags,
      });
    }
    return res.status(404).json({ error: "Game not found" });
  } catch (err) {
    console.error("Error updating tags:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.patch("/:gameId/notes", (req, res) => {
  try {
    const { gameId } = req.params;
    const { playNotes, achievementNotes } = req.body;

    ensureTuningColumns();

    const candidateTables = ["AppTracking", "AppTrackings"];
    let updated = false;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}" 
          SET playNotes = ?, achievementNotes = ?
          WHERE GameID = ? OR gameId = ?
        `,
          )
          .run(playNotes, achievementNotes, gameId, gameId);

        if (info.changes > 0) {
          updated = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!updated) {
      try {
        dbWrite
          .prepare(
            `
          INSERT INTO AppTracking (GameID, playNotes, achievementNotes)
          VALUES (?, ?, ?)
        `,
          )
          .run(gameId, playNotes, achievementNotes);
        updated = true;
      } catch (e) {
        console.error("Failed to insert notes record:", e);
      }
    }

    if (updated) {
      return res.json({
        success: true,
        gameId,
        notes: { playNotes, achievementNotes },
      });
    }
    return res.status(404).json({ error: "Game not found" });
  } catch (err) {
    console.error("Error updating notes:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.patch("/:gameId/tuning", (req, res) => {
  try {
    const { gameId } = req.params;
    const { tdp, targetFps, resolution, cpuBoost, notes } = req.body;

    ensureTuningColumns();

    const candidateTables = ["AppTracking", "AppTrackings"];
    let updated = false;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}" 
          SET targetTdp = ?, targetFps = ?, resolution = ?, cpuBoost = ?, tuningNotes = ?
          WHERE GameID = ? OR gameId = ?
        `,
          )
          .run(tdp, targetFps, resolution, cpuBoost, notes, gameId, gameId);

        if (info.changes > 0) {
          updated = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!updated) {
      // try insert
      try {
        dbWrite
          .prepare(
            `
          INSERT INTO AppTracking (GameID, targetTdp, targetFps, resolution, cpuBoost, tuningNotes)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(gameId, tdp, targetFps, resolution, cpuBoost, notes);
        updated = true;
      } catch (e) {
        console.error("Failed to insert tuning record:", e);
      }
    }

    if (updated) {
      return res.json({
        success: true,
        gameId,
        tuning: { tdp, targetFps, resolution, cpuBoost, notes },
      });
    }
    return res.status(404).json({ error: "Game not found" });
  } catch (err) {
    console.error("Error updating tuning:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.patch("/:gameId/review", (req, res) => {
  try {
    const { gameId } = req.params;
    const { personalReview, personalRating } = req.body;

    ensureTuningColumns();

    const candidateTables = ["AppTracking", "AppTrackings"];
    let updated = false;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}" 
          SET "Personal Review" = ?, "Personal Rating (1-10)" = ?
          WHERE GameID = ? OR gameId = ?
        `,
          )
          .run(personalReview, personalRating, gameId, gameId);

        if (info.changes > 0) {
          updated = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!updated) {
      try {
        dbWrite
          .prepare(
            `
          INSERT INTO AppTracking (GameID, "Personal Review", "Personal Rating (1-10)")
          VALUES (?, ?, ?)
        `,
          )
          .run(gameId, personalReview, personalRating);
        updated = true;
      } catch (e) {
        console.error("Failed to insert review record:", e);
      }
    }

    if (updated) {
      return res.json({
        success: true,
        gameId,
        review: { personalReview, personalRating },
      });
    }
    return res.status(404).json({ error: "Game not found" });
  } catch (err) {
    console.error("Error updating review:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.patch("/:gameId/rating", (req, res) => {
  try {
    const { gameId } = req.params;
    const { personalRating, rating: bodyRating } = req.body as {
      personalRating?: any;
      rating?: any;
    };
    const rawRating = personalRating !== undefined ? personalRating : bodyRating;

    if (rawRating === undefined)
      return res.status(400).json({ error: "personalRating or rating is required" });
    const rating = rawRating === null ? null : Number(rawRating);
    if (rating !== null && (!Number.isFinite(rating) || rating < 1 || rating > 10)) {
      return res.status(400).json({ error: "Rating must be a number between 1 and 10 or null" });
    }

    const candidateTables = ["AppTracking", "AppTrackings", "App_Tracking", "App_Trackings"];
    let totalUpdated = 0;

    for (const tbl of candidateTables) {
      try {
        const cols = db.prepare(`PRAGMA table_info("${tbl}")`).all() as any[];
        if (!cols || cols.length === 0) continue;
        // find id column
        const idCol = cols.find(
          (c: any) => /gameid/i.test(c.name) || /game_id/i.test(c.name) || /^id$/i.test(c.name),
        );
        if (!idCol) continue;
        // find rating column candidates
        const ratingCol = cols.find(
          (c: any) =>
            /personal\W*rating/i.test(c.name) ||
            /personal_rating/i.test(c.name) ||
            /rating/i.test(c.name),
        );
        if (!ratingCol) continue;

        const stmt = dbWrite.prepare(
          `UPDATE "${tbl}" SET "${ratingCol.name}" = ? WHERE "${idCol.name}" = ?`,
        );
        const info = stmt.run(rating, gameId);
        totalUpdated += info.changes || 0;
      } catch (e) {
        // ignore and try next candidate
        continue;
      }
    }

    if (totalUpdated > 0) return res.json({ success: true, updated: totalUpdated });
    return res.status(404).json({ error: "No tracking rows updated for provided gameId" });
  } catch (err) {
    console.error("Error updating personal rating:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.patch("/dlc/status", (req, res) => {
  try {
    const { gameId, dlcId, status } = req.body;
    if (!gameId || !status) {
      return res.status(400).json({ error: "gameId and status are required" });
    }

    const candidateTables = ["AppDLC", "AppDLCs", "AppGameDLC", "AppGameDLCs"];
    let updatedCount = 0;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}" 
          SET ownedStatus = ?
          WHERE (gameID = ? OR gameId = ?) 
            AND (dlcID = ? OR dlcId = ? OR 1=1) 
        `,
          )
          .run(status, gameId, gameId, dlcId, dlcId);

        if (info.changes > 0) {
          updatedCount += info.changes;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    return res.json({ success: true, updated: updatedCount });
  } catch (err) {
    console.error("Error updating DLC status:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.patch("/batch-status", async (req, res) => {
  try {
    const { gameIds, playStatus } = req.body;
    if (!Array.isArray(gameIds) || !playStatus) {
      return res
        .status(400)
        .json({ error: "gameIds (array) and playStatus (string) are required" });
    }

    const candidateTables = ["AppTracking", "AppTrackings"];
    let totalUpdated = 0;

    const updateTx = dbWrite.transaction((ids, status) => {
      let count = 0;
      for (const gameId of ids) {
        for (const tbl of candidateTables) {
          try {
            const info = dbWrite
              .prepare(
                `
              UPDATE "${tbl}" 
              SET playStatus = ?
              WHERE GameID = ? OR gameId = ?
            `,
              )
              .run(status, gameId, gameId);

            if (info.changes > 0) {
              count += info.changes;
              break; // assume one tracking record per game per table
            }
          } catch (e) {
            continue;
          }
        }
      }
      return count;
    });

    // AI-056: one game per transaction, taking the write lock first, with a
    // shutdown checkpoint between games (see /backup/restore-tuning).
    for (const gameId of gameIds) {
      await shutdownCheckpoint();
      totalUpdated += updateTx.immediate([gameId], playStatus);
    }

    return res.json({ success: true, count: totalUpdated });
  } catch (err) {
    if (err instanceof ShutdownInProgressError) {
      return sendApiError(res, 503, SHUTDOWN_RETRY_MESSAGE, undefined, { includeSuccess: false });
    }
    console.error("Error in batch-status:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.get("/stats/summary", (req, res) => {
  try {
    const totalGames = db.prepare("SELECT COUNT(*) as count FROM AppGames").get() as {
      count: number;
    };

    const statusCounts = db
      .prepare(
        `
      SELECT "Play Status" as playStatus, COUNT(*) as count 
      FROM AppTracking 
      WHERE "Play Status" IS NOT NULL 
      GROUP BY "Play Status"
    `,
      )
      .all() as { playStatus: string; count: number }[];

    const totalHoursPlayed = db
      .prepare('SELECT SUM("Hours Played") as total FROM AppTracking')
      .get() as { total: number };

    // TDP distribution from AppGameSettings
    const tdpRows = db
      .prepare(
        `
      SELECT "Thermal / Power Mode" as tdp, COUNT(*) as count 
      FROM AppGameSettings 
      WHERE "Thermal / Power Mode" IS NOT NULL 
      GROUP BY "Thermal / Power Mode"
    `,
      )
      .all() as { tdp: string; count: number }[];

    // Normalize TDP counts into requested buckets
    const tdpCounts = {
      "9W": 0,
      "15W": 0,
      "18W": 0,
      "25W+": 0,
      Unset: 0,
    };

    tdpRows.forEach((row) => {
      if (!row.tdp) return;
      const val = parseInt(row.tdp.replace(/[^0-9]/g, ""), 10);
      if (!val) return;
      if (val <= 9) tdpCounts["9W"] += row.count;
      else if (val <= 15) tdpCounts["15W"] += row.count;
      else if (val <= 18) tdpCounts["18W"] += row.count;
      else tdpCounts["25W+"] += row.count;
    });

    const unsetCount = db
      .prepare(
        `
      SELECT COUNT(*) as count 
      FROM AppGames g 
      LEFT JOIN AppGameSettings s ON g.GameID = s.GameID 
      WHERE s."Thermal / Power Mode" IS NULL
    `,
      )
      .get() as { count: number };
    tdpCounts["Unset"] = unsetCount.count;

    return res.json({
      success: true,
      stats: {
        totalGames: totalGames.count,
        statusCounts: statusCounts.reduce(
          (acc, curr) => ({ ...acc, [curr.playStatus]: curr.count }),
          {},
        ),
        totalHoursPlayed: totalHoursPlayed.total || 0,
        tdpCounts,
      },
    });
  } catch (err) {
    console.error("Stats error:", err);
    sendApiError(res, 500, "Failed to load stats");
  }
});

router.get("/quick-matcher", (req, res) => {
  try {
    ensureTuningColumns();
    const { minutes, maxTdp } = req.query;
    const maxMins = Number(minutes) || 60;

    let tdpLimit: number | null = null;
    if (typeof maxTdp === "string" && maxTdp) {
      tdpLimit = parseInt(maxTdp.replace(/[^0-9]/g, ""), 10);
    }

    // Use better-sqlite3 for complex CAST/REPLACE query
    // We join AppGame and AppTracking.
    // We also need to handle the case where AppTracking records might not exist yet for some games.
    const query = `
      SELECT g.*, t.targetTdp, t.targetFps, t.resolution, t."Play Status" as playStatus
      FROM AppGames g
      LEFT JOIN AppTracking t ON g.gameID = t.gameID
      WHERE (t."Play Status" IS NULL OR t."Play Status" IN ('Not Started', 'In Progress'))
      ${tdpLimit ? 'AND CAST(REPLACE(COALESCE(t.targetTdp, "0"), "W", "") AS INTEGER) <= ?' : ""}
      LIMIT 100
    `;

    const stmt = db.prepare(query);
    const results = tdpLimit ? stmt.all(tdpLimit) : stmt.all();

    // Secondary filtering for session time (since time data is often messy in the DB)
    // We reuse the heuristic from the frontend but simplified for the backend
    const parseMins = (g: any) => {
      const c = g["Estimated Game Time"] || g.estimatedGameTime || 0;
      const val = parseInt(String(c).replace(/[^0-9]/g, ""), 10);
      if (!val) return 45;
      if (val <= 200) return (val * 60) / 4; // assume total hours, 4 sessions
      return val;
    };

    const matches = results.filter((g) => parseMins(g) <= maxMins);

    return res.json(matches);
  } catch (err) {
    console.error("Quick Matcher error:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.post("/:id/launch", async (req, res) => {
  try {
    const gameId = req.params.id;

    // 1. Fetch game details with ownerships and tracking
    const game = db
      .prepare(
        `
      SELECT GameID, "Game Title" as title
      FROM AppGames
      WHERE GameID = ?
    `,
      )
      .get(gameId) as any;

    if (!game) {
      return res.status(404).json({ error: "Game not found" });
    }

    const ownerships = db
      .prepare(
        `
      SELECT Platform, "Store URL" as storeUrl, "Preferred Platform?" as preferred
      FROM AppOwnership
      WHERE GameID = ?
    `,
      )
      .all(gameId) as any[];

    // Extract launch URL or platform ID
    let launchUrl: string | null = null;

    // Check ownerships for store URLs or platform handlers
    for (const own of ownerships) {
      const url = own.storeUrl || "";
      const platform = (own.Platform || "").toLowerCase();

      // Steam App ID extraction
      const steamMatch = url.match(/store\.steampowered\.com\/app\/(\d+)/i) || url.match(/^(\d+)$/);
      if (steamMatch || platform.includes("steam")) {
        const steamId = steamMatch ? steamMatch[1] : null;
        if (steamId) {
          launchUrl = `steam://run/${steamId}`;
          break;
        }
      }

      // Epic Games Launcher extraction
      const epicMatch =
        url.match(/epicgames\.com\/.*\/p\/([a-zA-Z0-9_-]+)/i) ||
        url.match(/epicCatalogId[:=]([a-zA-Z0-9_-]+)/i);
      if (epicMatch || platform.includes("epic")) {
        const epicId = epicMatch ? epicMatch[1] : null;
        if (epicId) {
          launchUrl = `com.epicgames.launcher://apps/${epicId}?action=launch`;
          break;
        }
      }

      // GOG Galaxy extraction
      const gogMatch =
        url.match(/gog\.com\/.*\/game\/([a-zA-Z0-9_-]+)/i) || url.match(/gogAppId[:=](\d+)/i);
      if (gogMatch || platform.includes("gog")) {
        const gogId = gogMatch ? gogMatch[1] : null;
        if (gogId) {
          launchUrl = `goggalaxy://openGameView/${gogId}`;
          break;
        }
      }

      // Executable path or direct protocol handler
      if (url.startsWith("file://") || url.endsWith(".exe") || url.includes("://")) {
        launchUrl = url;
        break;
      }
    }

    // Fallback if no specific protocol handler was parsed but a storeUrl exists
    if (!launchUrl && ownerships.length > 0 && ownerships[0].storeUrl) {
      launchUrl = ownerships[0].storeUrl;
    }

    if (launchUrl) {
      // S1 SAST: launch via spawn with an argv array — `cmd /c start` receives
      // each argument separately and Node never builds a shell-interpolated
      // command string from the storeUrl value.
      const { spawn } = await import("child_process");
      spawn("cmd", ["/c", "start", "", launchUrl], { detached: true, stdio: "ignore" }).unref();
    }

    // 2. Update AppTracking lastPlayedDate
    const nowIso = new Date().toISOString();
    const candidateTables = ["AppTracking", "AppTrackings", "App_Tracking"];
    let updatedTracking = false;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}"
          SET "Last Played Date" = ?
          WHERE GameID = ? OR gameId = ?
        `,
          )
          .run(nowIso, gameId, gameId);

        if (info.changes > 0) {
          updatedTracking = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!updatedTracking) {
      try {
        dbWrite
          .prepare(
            `
          INSERT INTO AppTracking (GameID, "Last Played Date")
          VALUES (?, ?)
        `,
          )
          .run(gameId, nowIso);
        updatedTracking = true;
      } catch (e) {
        console.error("Failed to insert AppTracking record during launch:", e);
      }
    }

    return res.json({
      success: true,
      message: `Launched ${game.title || gameId}`,
      launchUrl,
      lastPlayedDate: nowIso,
    });
  } catch (err) {
    console.error("Error launching game:", err);
    return sendApiError(res, 500, "Failed to launch game", undefined, { includeSuccess: false });
  }
});

router.post("/:gameId/auto-preset", async (req, res) => {
  try {
    ensureTuningColumns();
    const { gameId } = req.params;

    // Fetch game metadata to check genre
    const game = db
      .prepare("SELECT primaryGenre FROM AppGames WHERE gameID = ? OR id = ?")
      .get(gameId, gameId) as { primaryGenre?: string } | undefined;

    const genre = (game?.primaryGenre || "").toLowerCase();

    // High-demand 3D/AAA genres
    const highDemandGenres = [
      "action",
      "rpg",
      "adventure",
      "fps",
      "simulation",
      "racing",
      "open world",
      "aaa",
      "3d",
    ];
    // 2D/Indie/Platformer genres
    const indieGenres = [
      "2d",
      "indie",
      "platformer",
      "casual",
      "puzzle",
      "arcade",
      "roguelike",
      "strategy",
    ];

    let preset = {
      tdp: "15W",
      targetFps: "45",
      resolution: "1080p",
      cpuBoost: "Disabled",
    };

    const isHighDemand = highDemandGenres.some((g) => genre.includes(g));
    const isIndie = indieGenres.some((g) => genre.includes(g));

    if (isHighDemand) {
      preset = { tdp: "18W", targetFps: "45", resolution: "900p", cpuBoost: "Disabled" };
    } else if (isIndie) {
      preset = { tdp: "9W", targetFps: "60", resolution: "1080p", cpuBoost: "Disabled" };
    }

    ensureTuningColumns();

    const candidateTables = ["AppTracking", "AppTrackings"];
    let updated = false;

    for (const tbl of candidateTables) {
      try {
        const info = dbWrite
          .prepare(
            `
          UPDATE "${tbl}" 
          SET targetTdp = ?, targetFps = ?, resolution = ?, cpuBoost = ?
          WHERE GameID = ? OR gameId = ?
        `,
          )
          .run(preset.tdp, preset.targetFps, preset.resolution, preset.cpuBoost, gameId, gameId);

        if (info.changes > 0) {
          updated = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!updated) {
      try {
        dbWrite
          .prepare(
            `
          INSERT INTO AppTracking (GameID, targetTdp, targetFps, resolution, cpuBoost)
          VALUES (?, ?, ?, ?, ?)
        `,
          )
          .run(gameId, preset.tdp, preset.targetFps, preset.resolution, preset.cpuBoost);
        updated = true;
      } catch (e) {
        console.error("Failed to insert auto-preset record:", e);
      }
    }

    return res.json(preset);
  } catch (err) {
    console.error("Error in auto-preset:", err);
    return sendApiError(res, 500, "Internal server error", undefined, { includeSuccess: false });
  }
});

router.get("/backup/db", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr =
      now.getHours().toString().padStart(2, "0") + now.getMinutes().toString().padStart(2, "0");
    const filename = `mpgl_backup_${dateStr}_${timeStr}.db`;
    const backupsDir = path.join(process.cwd(), "backups");

    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const backupPath = path.join(backupsDir, filename);

    // better-sqlite3 backup API
    await dbWrite.backup(backupPath);

    res.download(backupPath, filename, (err) => {
      if (err) {
        console.error("Download failed:", err);
      }
      // Optional: clean up old backups here if needed
    });
  } catch (err) {
    console.error("Backup failed:", err);
    sendApiError(res, 500, "Failed to create database backup", undefined, {
      includeSuccess: false,
    });
  }
});

router.get("/backup/tuning", requireAuth, (req, res) => {
  try {
    const candidateTables = ["AppTracking", "AppTrackings"];
    let records: any[] = [];

    for (const tbl of candidateTables) {
      try {
        const rows = db
          .prepare(
            `
          SELECT * FROM "${tbl}"
          WHERE targetTdp IS NOT NULL 
             OR targetFps IS NOT NULL 
             OR resolution IS NOT NULL 
             OR cpuBoost IS NOT NULL 
             OR tuningNotes IS NOT NULL
        `,
          )
          .all();
        if (rows.length > 0) {
          records = rows;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", 'attachment; filename="mpgl_tuning_profiles.json"');
    res.json(records);
  } catch (err) {
    console.error("Export failed:", err);
    sendApiError(res, 500, "Failed to export tuning profiles", undefined, {
      includeSuccess: false,
    });
  }
});

router.post("/backup/restore-tuning", async (req, res) => {
  try {
    const rawData = req.body;
    const profiles = Array.isArray(rawData) ? rawData : rawData.profiles || [];

    if (profiles.length === 0) {
      return res.status(400).json({ error: "No profiles provided in request body" });
    }

    ensureTuningColumns();
    const candidateTables = ["AppTracking", "AppTrackings"];
    let importedCount = 0;
    const errors: string[] = [];

    const restoreTx = dbWrite.transaction((profilesList) => {
      let count = 0;
      for (const profile of profilesList) {
        const gameId = profile.gameID || profile.GameID || profile.gameId || profile.id;
        if (!gameId) {
          errors.push(`Profile missing game identifier: ${JSON.stringify(profile).slice(0, 50)}`);
          continue;
        }

        let updated = false;
        for (const tbl of candidateTables) {
          try {
            const info = dbWrite
              .prepare(
                `
              UPDATE "${tbl}" 
              SET targetTdp = ?, targetFps = ?, resolution = ?, cpuBoost = ?, tuningNotes = ?
              WHERE GameID = ? OR gameId = ?
            `,
              )
              .run(
                profile.targetTdp || null,
                profile.targetFps || null,
                profile.resolution || null,
                profile.cpuBoost || null,
                profile.tuningNotes || null,
                gameId,
                gameId,
              );

            if (info.changes > 0) {
              updated = true;
              count += info.changes;
              break;
            }
          } catch (e) {
            continue;
          }
        }

        if (!updated) {
          // If no row existed, try inserting into AppTracking
          try {
            dbWrite
              .prepare(
                `
              INSERT INTO AppTracking (GameID, targetTdp, targetFps, resolution, cpuBoost, tuningNotes)
              VALUES (?, ?, ?, ?, ?, ?)
            `,
              )
              .run(
                gameId,
                profile.targetTdp || null,
                profile.targetFps || null,
                profile.resolution || null,
                profile.cpuBoost || null,
                profile.tuningNotes || null,
              );
            count++;
          } catch (e: any) {
            errors.push(`Failed to update/insert record for ${gameId}: ${e.message}`);
          }
        }
      }
      return count;
    });

    // AI-056: one profile per transaction. BEGIN IMMEDIATE takes the write lock
    // before any statement, so a held lock costs one wait per profile instead of
    // one per caught statement, and the checkpoint between profiles lets shutdown
    // stop the loop instead of waiting out the rest of the payload.
    for (const profile of profiles) {
      await shutdownCheckpoint();
      try {
        importedCount += restoreTx.immediate([profile]);
      } catch (e: any) {
        errors.push(`Failed to update/insert record: ${e.message}`);
      }
    }

    return res.json({ success: true, importedCount, errors });
  } catch (err) {
    if (err instanceof ShutdownInProgressError) {
      return sendApiError(res, 503, SHUTDOWN_RETRY_MESSAGE, undefined, { includeSuccess: false });
    }
    console.error("Restore failed:", err);
    return sendApiError(res, 500, "Internal server error during restore", undefined, {
      includeSuccess: false,
    });
  }
});

router.post("/sync/steam", async (req, res) => {
  try {
    const apiKey = req.body.apiKey || process.env.STEAM_API_KEY;
    const steamId = req.body.steamId || process.env.STEAM_ID;

    if (!apiKey || !steamId) {
      return res.status(400).json({ error: "Steam API Key and Steam ID are required" });
    }

    const response = await axios.get(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/`,
      {
        params: {
          key: apiKey,
          steamid: steamId,
          format: "json",
          include_appinfo: 1,
        },
      },
    );

    const games = (response as any).data?.response?.games;
    if (!Array.isArray(games)) {
      return sendApiError(res, 500, "Invalid response from Steam API", undefined, {
        includeSuccess: false,
      });
    }

    let updatedCount = 0;

    // AI-056: the library can hold thousands of games. Each game's writes share one
    // try, so a held lock costs one wait per game; the checkpoint lets shutdown stop
    // the loop there.
    for (const steamGame of games) {
      await shutdownCheckpoint();
      const appId = String(steamGame.appid);
      const gameName = steamGame.name;
      const playtimeForever = steamGame.playtime_forever || 0; // minutes
      const hoursPlayed = parseFloat((playtimeForever / 60).toFixed(2));

      // Attempt to find game in our DB by some identifier (we might need a mapping or just search by name/appId)
      // For now, we'll try to find or create entries.
      // Requirement says "perform parameterized updates/upserts on AppOwnership and AppTracking"

      try {
        // Find existing game by title or some mapping
        const game = db.prepare("SELECT gameID FROM AppGames WHERE gameTitle = ?").get(gameName) as
          { gameID: string } | undefined;
        let gameId = game?.gameID;

        if (!gameId) {
          // If not found, maybe we should create it or skip. Requirement says "upsert".
          // Let's create a minimal entry if missing to allow tracking.
          const newId = `STEAM_${appId}`;
          dbWrite
            .prepare("INSERT OR IGNORE INTO AppGames (gameID, gameTitle, active) VALUES (?, ?, 1)")
            .run(newId, gameName);
          gameId = newId;
        }

        // Upsert AppOwnership
        dbWrite
          .prepare(
            `
          INSERT INTO AppOwnership (gameID, platform, ownedStatus)
          VALUES (?, 'Steam', 'Owned')
          ON CONFLICT(gameID, platform) DO NOTHING
        `,
          )
          .run(gameId);

        // Upsert AppTracking
        // Note: Table schema might vary, we'll use a generic approach based on existing columns
        const trackingCols = db.prepare('PRAGMA table_info("AppTracking")').all() as any[];
        const hasHoursPlayed = trackingCols.some((c) => /hours\W*played/i.test(c.name));

        if (hasHoursPlayed) {
          const hoursCol = trackingCols.find((c) => /hours\W*played/i.test(c.name))?.name;
          dbWrite
            .prepare(
              `
            INSERT INTO AppTracking (gameID, "${hoursCol}")
            VALUES (?, ?)
            ON CONFLICT(gameID) DO UPDATE SET "${hoursCol}" = excluded."${hoursCol}"
          `,
            )
            .run(gameId, hoursPlayed);
          updatedCount++;
        }
      } catch (err) {
        console.warn(`Failed to sync game ${gameName}:`, err);
      }
    }

    return res.json({ success: true, count: games.length, updated: updatedCount });
  } catch (error: any) {
    if (error instanceof ShutdownInProgressError) {
      return sendApiError(res, 503, SHUTDOWN_RETRY_MESSAGE, undefined, { includeSuccess: false });
    }
    console.error("Steam sync error:", error.message);
    return sendApiError(res, 500, "Failed to sync with Steam", undefined, {
      includeSuccess: false,
    });
  }
});

router.post("/sync/all-stats", async (req, res) => {
  console.log("Starting multi-platform account sync...");
  const { execFile } = require("child_process");

  // Execute scripts/sync_all_user_stats.js (execFile, no shell — S1 SAST)
  const scriptPath = path.join(__dirname, "../../scripts/sync_all_user_stats.js");

  execFile("node", [scriptPath], (error: any, stdout: string, stderr: string) => {
    if (error) {
      console.error(`Sync script execution error: ${error.message}`);
      // Sprint 1A (EPICSEC04): the raw child-process error message must never
      // reach the client unsanitized.
      return res.status(500).json({
        success: false,
        error: sanitizeErrorMessage(error, "Sync execution failed"),
        platforms: { steam: 0, psn: 0, gog: 0, nexus: 0 },
      });
    }

    if (stderr) {
      console.warn(`Sync script stderr: ${stderr}`);
    }

    // Parse summary JSON from stdout
    let platforms = { steam: 0, psn: 0, gog: 0, nexus: 0 };
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("JSON_SUMMARY:")) {
        try {
          const summaryStr = line.slice("JSON_SUMMARY:".length).trim();
          platforms = JSON.parse(summaryStr);
        } catch (e) {
          console.error("Failed to parse JSON_SUMMARY from sync script stdout:", e);
        }
      }
    }

    return res.json({
      success: true,
      platforms,
    });
  });
});

export default router;
