/**
 * src/config.ts
 *
 * Centralized, zero-dependency environment validation for MGPL.
 *
 * Validates every required and optional environment variable read from
 * process.env and fails fast (process.exit(1)) with a clean, sanitized error
 * summary whenever the runtime contract is violated. Secret values are never
 * logged — only variable names and short reasons are emitted.
 *
 * `config` is the frozen, strongly-typed object consumed by the application.
 * `validateConfig` and `parseConfig` are exported as pure seams for the
 * integration probe and unit tests.
 */

type Env = NodeJS.ProcessEnv;

export interface AppConfig {
  PORT: number;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  STEAM_API_KEY?: string;
  OPENCRITIC_API_KEY?: string;
  ITAD_API_KEY?: string;
  NEXUSMODS_API_KEY?: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  STEAMGRIDDB_API_KEY?: string;
  STEAM_ID64?: string;
  SENTRY_DSN?: string;
  CHEAPSHARK_BASE_URL: string;
  GAMERPOWER_BASE_URL: string;
}

export type ConfigValidationResult =
  { ok: true; value: AppConfig } | { ok: false; errors: string[] };

const DEFAULT_CHEAPSHARK_BASE_URL = "https://www.cheapshark.com/api/1.0";
const DEFAULT_GAMERPOWER_BASE_URL = "https://www.gamerpower.com/api";

const STEAM_ID64_RE = /^\d{17}$/;

const OPTIONAL_SECRET_KEYS = [
  "STEAM_API_KEY",
  "OPENCRITIC_API_KEY",
  "ITAD_API_KEY",
  "NEXUSMODS_API_KEY",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "STEAMGRIDDB_API_KEY",
] as const;

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function optionalSecret(env: Env, key: string): string | undefined {
  const raw = env[key];
  return isNonEmpty(raw) ? raw : undefined;
}

function formatConfigErrors(errors: string[]): string {
  return errors.map((error, index) => `  ${index + 1}. ${error}`).join("\n");
}

export function validateConfig(env: Env): ConfigValidationResult {
  const errors: string[] = [];

  // PORT — coerced number with a 1..65535 range; unset falls back to 4000.
  let port = 4000;
  if (env.PORT !== undefined && env.PORT.trim() !== "") {
    const parsed = Number(env.PORT);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535; received "${env.PORT}".`);
    } else {
      port = parsed;
    }
  }

  // DATABASE_URL — required; must be a SQLite file: URI.
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!isNonEmpty(databaseUrl)) {
    errors.push("DATABASE_URL is required and must be a non-empty string.");
  } else if (!databaseUrl.startsWith("file:")) {
    errors.push('DATABASE_URL must start with "file:".');
  }

  // SESSION_SECRET — required; minimum 32 characters.
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    errors.push(`SESSION_SECRET must be at least 32 characters; received ${sessionSecret.length}.`);
  }

  // Optional integration secrets — presence optional, values never logged.
  const secrets: Record<string, string | undefined> = {};
  for (const key of OPTIONAL_SECRET_KEYS) {
    secrets[key] = optionalSecret(env, key);
  }

  // STEAM_ID64 — optional; must be a 17-digit numeric string when present.
  const steamId64 = optionalSecret(env, "STEAM_ID64");
  if (steamId64 !== undefined && !STEAM_ID64_RE.test(steamId64)) {
    errors.push("STEAM_ID64 must be a 17-digit numeric string.");
  }

  // SENTRY_DSN — optional; must be a valid URL when present.
  const sentryDsn = optionalSecret(env, "SENTRY_DSN");
  if (sentryDsn !== undefined && !isHttpUrl(sentryDsn)) {
    errors.push("SENTRY_DSN must be a valid URL when present.");
  }

  // Deals/giveaways base URLs — validated with new URL(), with safe defaults.
  const cheapsharkBaseUrl =
    optionalSecret(env, "CHEAPSHARK_BASE_URL") ?? DEFAULT_CHEAPSHARK_BASE_URL;
  if (!isHttpUrl(cheapsharkBaseUrl)) {
    errors.push("CHEAPSHARK_BASE_URL must be a valid URL.");
  }

  const gamerpowerBaseUrl =
    optionalSecret(env, "GAMERPOWER_BASE_URL") ?? DEFAULT_GAMERPOWER_BASE_URL;
  if (!isHttpUrl(gamerpowerBaseUrl)) {
    errors.push("GAMERPOWER_BASE_URL must be a valid URL.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      PORT: port,
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: sessionSecret,
      STEAM_API_KEY: secrets.STEAM_API_KEY,
      OPENCRITIC_API_KEY: secrets.OPENCRITIC_API_KEY,
      ITAD_API_KEY: secrets.ITAD_API_KEY,
      NEXUSMODS_API_KEY: secrets.NEXUSMODS_API_KEY,
      TWITCH_CLIENT_ID: secrets.TWITCH_CLIENT_ID,
      TWITCH_CLIENT_SECRET: secrets.TWITCH_CLIENT_SECRET,
      STEAMGRIDDB_API_KEY: secrets.STEAMGRIDDB_API_KEY,
      STEAM_ID64: steamId64,
      SENTRY_DSN: sentryDsn,
      CHEAPSHARK_BASE_URL: cheapsharkBaseUrl,
      GAMERPOWER_BASE_URL: gamerpowerBaseUrl,
    },
  };
}

export function parseConfig(env: Env): AppConfig {
  const result = validateConfig(env);
  if (!result.ok) {
    throw new Error(`Invalid configuration:\n${formatConfigErrors(result.errors)}`);
  }
  return result.value;
}

export function loadConfig(env: Env = process.env): Readonly<AppConfig> {
  const result = validateConfig(env);
  if (!result.ok) {
    console.error("Configuration validation failed:\n" + formatConfigErrors(result.errors));
    process.exit(1);
  }
  return Object.freeze(result.value);
}

export const config: Readonly<AppConfig> = loadConfig();
