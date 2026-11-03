import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// src/config.ts computes `config` at import time via loadConfig(), which calls
// process.exit(1) when required variables are missing. Seeding a valid required
// environment before the first dynamic import (and guarding process.exit) lets
// the module's pure exports load without killing the Vitest worker.
type ConfigModule = typeof import("../../src/config");

const REQUIRED_KEYS = ["DATABASE_URL", "SESSION_SECRET", "PORT"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

const VALID_BASE: Record<string, string | undefined> = {
  DATABASE_URL: "file:./data/test_mgpl.db",
  SESSION_SECRET: "x".repeat(32),
  PORT: "4000",
};

let configModule: ConfigModule | null = null;

function api(): ConfigModule {
  if (!configModule) {
    throw new Error("config module was not loaded in beforeAll");
  }
  return configModule;
}

function envWith(
  overrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...VALID_BASE, ...overrides };
}

beforeAll(async () => {
  for (const key of REQUIRED_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
  }
  process.env.DATABASE_URL = VALID_BASE.DATABASE_URL;
  process.env.SESSION_SECRET = VALID_BASE.SESSION_SECRET;
  process.env.PORT = VALID_BASE.PORT;
  vi.spyOn(process, "exit").mockImplementation((_code?: number): never => {
    throw new Error("process.exit() must not run during config unit tests");
  });
  configModule = await import("../../src/config");
});

afterAll(() => {
  for (const key of REQUIRED_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  vi.restoreAllMocks();
});

describe("validateConfig (src/config.ts)", () => {
  it("accepts a fully valid environment with zero errors", () => {
    const { validateConfig } = api();
    const result = validateConfig(envWith({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.PORT).toBe(4000);
      expect(result.value.DATABASE_URL).toBe(VALID_BASE.DATABASE_URL);
      expect(result.value.SESSION_SECRET).toBe(VALID_BASE.SESSION_SECRET);
    }
  });

  it("rejects a DATABASE_URL that does not start with file:", () => {
    const { validateConfig } = api();
    const result = validateConfig(envWith({ DATABASE_URL: "https://localhost/mgpl.db" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain('must start with "file:"');
    }
  });

  it("flags a missing DATABASE_URL as a required error", () => {
    const { validateConfig } = api();
    const missing = { SESSION_SECRET: VALID_BASE.SESSION_SECRET, PORT: VALID_BASE.PORT };
    const result = validateConfig(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("DATABASE_URL is required");
    }
  });

  it("flags a SESSION_SECRET shorter than 32 characters", () => {
    const { validateConfig } = api();
    const result = validateConfig(envWith({ SESSION_SECRET: "way-too-short" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("SESSION_SECRET must be at least 32");
    }
  });

  it("flags a missing SESSION_SECRET as a required error", () => {
    const { validateConfig } = api();
    const missing = { DATABASE_URL: VALID_BASE.DATABASE_URL, PORT: VALID_BASE.PORT };
    const result = validateConfig(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("SESSION_SECRET must be at least 32");
    }
  });

  it("rejects PORT values outside the 1..65535 range", () => {
    const { validateConfig } = api();
    const tooHigh = validateConfig(envWith({ PORT: "70000" }));
    const tooLow = validateConfig(envWith({ PORT: "0" }));
    const notANumber = validateConfig(envWith({ PORT: "abc" }));
    for (const result of [tooHigh, tooLow, notANumber]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toContain("PORT must be an integer between 1 and 65535");
      }
    }
  });

  it("rejects invalid http(s) URL values for the deal feed base URLs", () => {
    const { validateConfig } = api();
    const badCheapShark = validateConfig(envWith({ CHEAPSHARK_BASE_URL: "not a url" }));
    const badGamerPower = validateConfig(
      envWith({ GAMERPOWER_BASE_URL: "ftp://gamerpower.com/api" }),
    );
    for (const result of [badCheapShark, badGamerPower]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toContain("must be a valid URL");
      }
    }
  });

  it("collects every problem at once instead of halting on the first error", () => {
    const { validateConfig } = api();
    const result = validateConfig({ SESSION_SECRET: "short", PORT: "0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("carries optional secrets through only when present and non-blank", () => {
    const { validateConfig } = api();
    const result = validateConfig(
      envWith({ STEAM_API_KEY: "steam-test-key", OPENCRITIC_API_KEY: "", TWITCH_CLIENT_ID: "   " }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.STEAM_API_KEY).toBe("steam-test-key");
      expect(result.value.OPENCRITIC_API_KEY).toBeUndefined();
      expect(result.value.TWITCH_CLIENT_ID).toBeUndefined();
    }
  });

  it("enforces the 17-digit STEAM_ID64 format only when present", () => {
    const { validateConfig } = api();
    const bad = validateConfig(envWith({ STEAM_ID64: "12345" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(" ")).toContain("STEAM_ID64 must be a 17-digit numeric string");
    }
    const good = validateConfig(envWith({ STEAM_ID64: "76561198000000000" }));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.STEAM_ID64).toBe("76561198000000000");
    }
  });

  it("accepts a valid SENTRY_DSN and rejects a malformed one", () => {
    const { validateConfig } = api();
    const bad = validateConfig(envWith({ SENTRY_DSN: "not-a-dsn" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(" ")).toContain("SENTRY_DSN must be a valid URL");
    }
    const good = validateConfig(
      envWith({ SENTRY_DSN: "https://abcdef1234567890@example.com/sentry/123" }),
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.SENTRY_DSN).toBe("https://abcdef1234567890@example.com/sentry/123");
    }
  });
});

describe("parseConfig / loadConfig exports (src/config.ts)", () => {
  it("applies PORT and base-URL defaults on a valid environment", () => {
    const { parseConfig } = api();
    const cfg = parseConfig({
      DATABASE_URL: VALID_BASE.DATABASE_URL,
      SESSION_SECRET: VALID_BASE.SESSION_SECRET,
    });
    expect(cfg.PORT).toBe(4000);
    expect(cfg.CHEAPSHARK_BASE_URL).toBe("https://www.cheapshark.com/api/1.0");
    expect(cfg.GAMERPOWER_BASE_URL).toBe("https://www.gamerpower.com/api");
    expect(cfg.STEAM_API_KEY).toBeUndefined();
  });

  it("throws an aggregate error when the environment is invalid", () => {
    const { parseConfig } = api();
    expect(() => parseConfig({ DATABASE_URL: "nope", SESSION_SECRET: "short" })).toThrow(
      "Invalid configuration",
    );
  });

  it("exports a frozen config object", () => {
    expect(Object.isFrozen(api().config)).toBe(true);
  });
});
