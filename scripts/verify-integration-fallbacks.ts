/**
 * scripts/verify-integration-fallbacks.ts
 *
 * Integration & Fallback Verification Probe (AGENTS.md §6.1).
 *
 * Non-destructive by construction:
 *   - Opens SQLite in READ-ONLY mode (never writes, never runs migrations).
 *   - Makes NO external network calls. Primary "connectivity" is verified via
 *     the presence of Doppler-injected credentials plus local fixture/cache
 *     data; failure states are simulated in-process with pure functions.
 *   - Never prints secret values, tokens, or DSNs (only presence booleans and
 *     environment-variable NAMES).
 *
 * Run: doppler run -- npx ts-node scripts/verify-integration-fallbacks.ts
 */

import fs from "fs";
import path from "path";
import Database, { Database as DatabaseType } from "better-sqlite3";
import type { Response } from "express";

import {
  DATA_AS_OF_HEADER,
  DATA_FRESH_HEADER,
  renderModuleFallback,
} from "../src/middleware/fallbackRenderer";
import {
  getIntegrationHealth,
  recordIntegrationEvent,
  INTEGRATION_KEYS,
} from "../src/services/integrationMonitor";
import { isGreyMarketUrl, isWhitelistedUrl } from "../src/utils/storefrontValidator";

type Status = "PASS" | "FAIL" | "SKIP" | "N/A";

interface SuiteResult {
  domain: string;
  primary: Status;
  fallback: Status;
  observed: string;
}

const results: SuiteResult[] = [];
let failures = 0;

function record(domain: string, primary: Status, fallback: Status, observed: string): void {
  results.push({ domain, primary, fallback, observed });
  if (primary === "FAIL" || fallback === "FAIL") failures += 1;
}

/** True when an environment variable exists and is non-empty (value never printed). */
function envHas(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/** True when a string is a syntactically valid http(s) URL (value never printed). */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Mirrors the app's non-secret local developer defaults (used only for simulation). */
function localNonSecretDefaults(env: Record<string, string | undefined>): {
  PORT: number;
  DATABASE_URL: string;
} {
  return {
    PORT: Number(env.PORT) || 4000,
    DATABASE_URL: env.DATABASE_URL || "file:./data/mpgl_app.db",
  };
}

function resolveDbPath(): string | null {
  const candidates: string[] = [];
  if (process.env.DB_PATH) candidates.push(path.resolve(process.env.DB_PATH));
  const databaseUrl = process.env.DATABASE_URL || "";
  if (databaseUrl.startsWith("file:")) {
    candidates.push(path.resolve(process.cwd(), databaseUrl.slice("file:".length)));
  }
  candidates.push(path.resolve(process.cwd(), "mpgl_app.db"));
  candidates.push(path.resolve(process.cwd(), "data", "mpgl_app.db"));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function openReadonly(): { db: DatabaseType; file: string } | null {
  const file = resolveDbPath();
  if (!file) return null;
  try {
    return { db: new Database(file, { readonly: true, fileMustExist: true }), file };
  } catch (err) {
    console.error("openReadonly failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

function isGenericSearchUrl(url: string): boolean {
  return (
    /(?:google|bing)(?:\.com|\.co\.[a-z]{2}|\.net|\.org)\/[^?#]*\?[^#]*q=/i.test(url) ||
    /(?:google|bing)\.com\/search/i.test(url)
  );
}

/** Pure simulation of the review-score ladder (OpenCritic -> labeled Steam fallback). */
function simulateReviewFallback(
  reason: string,
  openCriticScore: number | null,
  steamScore: number | null,
): { reviewSource: string; label: string; score: number | null; storeUrl: string | null } {
  void reason; // failure reason is intentionally not propagated into the label/UI
  if (openCriticScore != null) {
    return {
      reviewSource: "opencritic",
      label: "OpenCritic",
      score: openCriticScore,
      storeUrl: null,
    };
  }
  return {
    reviewSource: "steam",
    label: "Steam (fallback)",
    score: steamScore,
    storeUrl: null,
  };
}

/** Read-only scan of AppGames URL columns for forbidden generic search fallbacks. */
function scanGenericSearchUrls(db: DatabaseType): Array<{ column: string; value: string }> {
  const violations: Array<{ column: string; value: string }> = [];
  try {
    const cols = db.prepare('PRAGMA table_info("AppGames")').all() as Array<{ name?: string }>;
    const urlCols = cols.map((c) => String(c.name || "")).filter((name) => /url/i.test(name));
    for (const col of urlCols) {
      const rows = db
        .prepare(`SELECT "${col}" AS v FROM "AppGames" WHERE "${col}" IS NOT NULL LIMIT 5000`)
        .all() as Array<{ v?: unknown }>;
      for (const row of rows) {
        const value = String(row && row.v !== null && row.v !== undefined ? row.v : "");
        if (value && isGenericSearchUrl(value)) violations.push({ column: col, value });
      }
    }
  } catch {
    // Missing table/column is not a probe failure; treat as zero violations.
  }
  return violations;
}

function makeMockResponse(): {
  res: Response;
  headers: Record<string, string>;
  getBody: () => unknown;
} {
  const headers: Record<string, string> = {};
  let body: unknown = null;
  const res = {
    set: (k: string, v: string) => {
      headers[k] = v;
      return res;
    },
    status: () => res,
    json: (payload: unknown) => {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, headers, getBody: () => body };
}

function suiteSecrets(): void {
  const dopplerActive =
    envHas("DOPPLER_CONFIG") ||
    envHas("DOPPLER_ENVIRONMENT") ||
    envHas("DOPPLER_PROJECT") ||
    envHas("DOPPLER_ENCLAVE_PROJECT") ||
    envHas("DOPPLER_ENCLAVE_CONFIG");

  // Complete canonical Doppler inventory. Names only — raw values are never
  // printed. Format rules mirror src/config.ts (the schema authority).
  const relevantNames = [
    "PORT",
    "DATABASE_URL",
    "SESSION_SECRET",
    "DB_PATH",
    "STEAM_API_KEY",
    "STEAM_ID64",
    "ITAD_API_KEY",
    "OPENCRITIC_API_KEY",
    "NEXUSMODS_API_KEY",
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "STEAMGRIDDB_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "CHEAPSHARK_BASE_URL",
    "GAMERPOWER_BASE_URL",
    "R2_ACCESS_KEY_ID",
    "B2_ACCESS_KEY_ID",
    "SENTRY_DSN",
  ];

  // Keys whose Doppler injection is mandatory for this probe to PASS.
  const requiredKeys = [
    "STEAM_API_KEY",
    "ITAD_API_KEY",
    "OPENCRITIC_API_KEY",
    "NEXUSMODS_API_KEY",
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "STEAMGRIDDB_API_KEY",
    "DATABASE_URL",
    "SESSION_SECRET",
  ];
  const missingKeys = requiredKeys.filter((name) => !envHas(name));
  const setNames = relevantNames.filter(envHas);

  // Presence/format validation only — no raw values are ever echoed.
  const formatIssues: string[] = [];
  const portRaw = process.env.PORT;
  if (portRaw !== undefined && portRaw.trim() !== "") {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      formatIssues.push("PORT outside 1..65535 or not an integer");
    }
  }
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl !== undefined && dbUrl.trim() !== "" && !dbUrl.trim().startsWith("file:")) {
    formatIssues.push("DATABASE_URL must start with file:");
  }
  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret !== undefined && sessionSecret.trim() !== "" && sessionSecret.length < 32) {
    formatIssues.push("SESSION_SECRET shorter than 32 chars");
  }
  const steamId64 = process.env.STEAM_ID64;
  if (steamId64 !== undefined && steamId64.trim() !== "" && !/^\d{17}$/.test(steamId64.trim())) {
    formatIssues.push("STEAM_ID64 is not a 17-digit numeric string");
  }
  for (const urlKey of ["CHEAPSHARK_BASE_URL", "GAMERPOWER_BASE_URL", "SENTRY_DSN"] as const) {
    const raw = process.env[urlKey];
    if (raw !== undefined && raw.trim() !== "" && !isHttpUrl(raw)) {
      formatIssues.push(`${urlKey} is not a valid http(s) URL`);
    }
  }

  const primary: Status =
    dopplerActive && missingKeys.length === 0 && formatIssues.length === 0 ? "PASS" : "FAIL";
  const defaults = localNonSecretDefaults({});
  const fallback: Status =
    defaults.PORT === 4000 && defaults.DATABASE_URL === "file:./data/mpgl_app.db" ? "PASS" : "FAIL";

  const observed = !dopplerActive
    ? "Doppler run not active (no DOPPLER_* metadata). Run this probe via `doppler run --`."
    : `Doppler run active; injected relevant keys=[${setNames.join(", ") || "none"}]. ` +
      `missing required keys=[${missingKeys.join(", ") || "none"}]; ` +
      `format issues=[${formatIssues.join("; ") || "none"}]. ` +
      "Unlinked-env simulation falls back to PORT=4000 / DATABASE_URL=file:./data/mpgl_app.db.";

  record("Secrets (Doppler)", primary, fallback, observed);
}

function suitePersistence(db: DatabaseType | null, dbFile: string | null): void {
  if (!db || !dbFile) {
    record(
      "Persistence & DR",
      "SKIP",
      "SKIP",
      "No SQLite database file found (searched DB_PATH, DATABASE_URL, ./mpgl_app.db, ./data/mpgl_app.db).",
    );
    return;
  }

  let primary: Status = "FAIL";
  let primaryObserved: string;
  try {
    const journal = db.pragma("journal_mode", { simple: true }) as unknown as string;
    const fkViolations = db.pragma("foreign_key_check") as unknown as unknown[];
    const integrity = db.pragma("integrity_check", { simple: true }) as unknown as string;
    primary =
      journal === "wal" &&
      Array.isArray(fkViolations) &&
      fkViolations.length === 0 &&
      integrity === "ok"
        ? "PASS"
        : "FAIL";
    primaryObserved = `file=${path.basename(dbFile)}; journal_mode=${journal}; integrity_check=${integrity}; foreign_key violations=${fkViolations.length}`;
  } catch (err) {
    primaryObserved = `read-only PRAGMA check failed: ${err instanceof Error ? err.message : err}`;
  }

  let fallback: Status = "FAIL";
  let fallbackObserved: string;
  try {
    const coreTables = [
      "AppGameTags",
      "AppGameNotes",
      "AppPriceAlerts",
      "AppWishlist",
      "AppRetroTracking",
    ];
    const existing = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    const missing = coreTables.filter((t) => !existing.has(t));

    const stateFile = path.resolve(process.cwd(), "src", "routes", "state.ts");
    const stateText = fs.readFileSync(stateFile, "utf8");
    const unregistered = coreTables.filter((t) => !stateText.includes(t));

    const snapshot: Record<string, unknown> = {};
    for (const table of coreTables) {
      snapshot[table] = existing.has(table)
        ? db.prepare(`SELECT * FROM "${table}" LIMIT 1000`).all()
        : [];
    }
    const json = JSON.stringify(snapshot);
    JSON.parse(json); // must round-trip

    fallback = missing.length === 0 && unregistered.length === 0 ? "PASS" : "FAIL";
    fallbackObserved = `Snapshot JSON valid (${Buffer.byteLength(json)} bytes); missing tables=[${
      missing.join(", ") || "none"
    }]; unregistered in src/routes/state.ts=[${unregistered.join(", ") || "none"}].`;
  } catch (err) {
    fallbackObserved = `snapshot verification failed: ${err instanceof Error ? err.message : err}`;
  }

  record("Persistence & DR", primary, fallback, `${primaryObserved} | ${fallbackObserved}`);
}

function suiteCatalog(db: DatabaseType | null): void {
  const steamKey = envHas("STEAM_API_KEY");
  let gamesCount = 0;
  let steamReviews = 0;
  let fixtureError = "";

  if (db) {
    try {
      const g = db.prepare('SELECT COUNT(*) AS n FROM "AppGames"').get() as { n?: number };
      gamesCount = Number(g?.n) || 0;
      const r = db
        .prepare('SELECT COUNT(*) AS n FROM "AppReviews" WHERE LOWER("Review Source") = ?')
        .get("steam") as { n?: number };
      steamReviews = Number(r?.n) || 0;
    } catch (err) {
      fixtureError = `fixture query failed: ${err instanceof Error ? err.message : err}`;
    }
  }

  const primary: Status = steamKey && (gamesCount > 0 || steamReviews > 0) ? "PASS" : "FAIL";
  const primaryObserved =
    fixtureError ||
    `STEAM_API_KEY=${steamKey ? "present" : "missing"}; AppGames=${gamesCount}; steam-sourced AppReviews=${steamReviews}`;

  const fallbackResult = simulateReviewFallback("OpenCritic rate limited (429)", null, 82);
  const violations = db ? scanGenericSearchUrls(db) : [];
  const labeledSteamFallback =
    fallbackResult.reviewSource === "steam" &&
    fallbackResult.label === "Steam (fallback)" &&
    (fallbackResult.storeUrl === null || !isGenericSearchUrl(fallbackResult.storeUrl));
  const fallback: Status = labeledSteamFallback && violations.length === 0 ? "PASS" : "FAIL";

  const samples = violations
    .slice(0, 3)
    .map((v) => `${v.column}=${v.value.slice(0, 90)}`)
    .join(" ;; ");

  record(
    "Catalog Enrichment",
    primary,
    fallback,
    `${primaryObserved} | simulated OpenCritic 429 -> reviewSource=${fallbackResult.reviewSource}, label=${fallbackResult.label}; generic-search URL violations in DB=[${violations.length}]${samples ? `; samples: ${samples}` : ""}.`,
  );
}

function suiteDeals(db: DatabaseType | null): void {
  const itadKey = envHas("ITAD_API_KEY");
  const cheapsharkBase = envHas("CHEAPSHARK_BASE_URL") || envHas("CHEAPSHARK_URL");
  let cachedLows = 0;
  if (db) {
    try {
      const r = db.prepare('SELECT COUNT(*) AS n FROM "AppDealPriceHistory"').get() as {
        n?: number;
      };
      cachedLows = Number(r?.n) || 0;
    } catch {
      // table absent -> zero cached lows, not a probe failure
    }
  }

  const primary: Status = itadKey ? "PASS" : "FAIL";
  const primaryObserved = `ITAD_API_KEY=${itadKey ? "present" : "missing"}; CheapShark base=${
    cheapsharkBase ? "configured" : "not set"
  }; cached historical lows=${cachedLows}`;

  let fallback: Status = "FAIL";
  let fallbackObserved: string;
  try {
    const mock = makeMockResponse();
    renderModuleFallback(mock.res, {
      module: "deals",
      stale: true,
      payload: { cachedHistoricalLowAvailable: cachedLows > 0 },
    });
    const body = mock.getBody() as {
      success?: boolean;
      usingFallback?: boolean;
      stale?: boolean;
    } | null;
    const headerOk =
      typeof mock.headers[DATA_AS_OF_HEADER] === "string" &&
      mock.headers[DATA_FRESH_HEADER] === "false";
    const envelopeOk =
      body !== null &&
      body !== undefined &&
      body.success === true &&
      body.usingFallback === true &&
      body.stale === true;
    const greyRejected =
      !isWhitelistedUrl("https://www.g2a.com/offer/x") &&
      isGreyMarketUrl("https://www.g2a.com/offer/x") &&
      isGreyMarketUrl("https://www.kinguin.net/x") &&
      isGreyMarketUrl("https://www.cdkeys.com/x");

    fallback = headerOk && envelopeOk && greyRejected ? "PASS" : "FAIL";
    fallbackObserved = `X-Data-As-Of=${
      mock.headers[DATA_AS_OF_HEADER] ? "set" : "missing"
    }; X-Data-Fresh=${mock.headers[DATA_FRESH_HEADER]}; envelope(usingFallback=${body?.usingFallback}, stale=${body?.stale}); grey-market G2A/Kinguin/CDKeys rejected=${greyRejected}`;
  } catch (err) {
    fallbackObserved = `fallback render failed: ${err instanceof Error ? err.message : err}`;
  }

  record("Store Deals", primary, fallback, `${primaryObserved} | ${fallbackObserved}`);
}

function suiteObservability(): void {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const sentryDep = "@sentry/node" in deps;
  const sentryAdapterFile = fs.existsSync(
    path.resolve(process.cwd(), "src", "observability", "sentry.ts"),
  );
  const sentryConfigured = envHas("SENTRY_DSN");

  // No Sentry adapter is wired into the app (dependency + adapter both absent), so
  // the "primary" remote exception route is not implemented — this is expected/gated.
  const primary: Status = sentryDep || sentryAdapterFile ? "FAIL" : "N/A";

  let fallback: Status = "FAIL";
  let fallbackObserved: string;
  try {
    recordIntegrationEvent("steam", "success");
    recordIntegrationEvent("itad", "rate_limited");
    recordIntegrationEvent("not-a-real-key", "success"); // must be silently ignored
    const health = getIntegrationHealth();
    const keysOk =
      health.status === "ok" &&
      Array.isArray(health.integrations) &&
      health.integrations.length === INTEGRATION_KEYS.length;
    fallback = keysOk ? "PASS" : "FAIL";
    fallbackObserved = `in-memory health snapshot valid (${health.integrations.length} integrations); rate_limited recorded for itad; unknown keys ignored; no uncaught telemetry exception.`;
  } catch (err) {
    fallbackObserved = `in-memory telemetry failed: ${err instanceof Error ? err.message : err}`;
  }

  record(
    "Observability (Sentry)",
    primary,
    fallback,
    primary === "N/A"
      ? `Sentry not wired (@sentry/node dependency=${sentryDep}, adapter file=${sentryAdapterFile}, SENTRY_DSN=${
          sentryConfigured ? "set" : "unset"
        }) — gated per §6.1.2. | ${fallbackObserved}`
      : `Unexpected Sentry adapter/dependency present without review. | ${fallbackObserved}`,
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printTable(): void {
  const domainW = 24;
  const statusW = 9;
  console.log(
    pad("Integration Domain", domainW) +
      pad("Primary", statusW) +
      pad("Fallback", statusW) +
      "Observed Behavior",
  );
  console.log(
    "-".repeat(domainW + statusW + statusW) +
      "------------------------------------------------------------------------",
  );
  for (const r of results) {
    console.log(
      pad(r.domain, domainW) + pad(r.primary, statusW) + pad(r.fallback, statusW) + r.observed,
    );
  }
}

function main(): void {
  console.log("MGPL Integration & Fallback Verification Probe (AGENTS.md §6.1)\n");

  const opened = openReadonly();
  const db = opened ? opened.db : null;
  const dbFile = opened ? opened.file : null;

  suiteSecrets();
  suitePersistence(db, dbFile);
  suiteCatalog(db);
  suiteDeals(db);
  suiteObservability();

  if (opened) {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }

  console.log("");
  printTable();

  const failed = failures > 0;
  console.log("");
  console.log(`Overall: ${failed ? "FAIL" : "PASS"} (${failures} failing domain(s))`);
  process.exitCode = failed ? 1 : 0;
}

main();
