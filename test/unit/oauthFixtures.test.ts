import { describe, expect, it } from "vitest";
import {
  MOCK_GOOGLE_CODE,
  MOCK_GOOGLE_EMAIL,
  MOCK_GOOGLE_NAME,
  MOCK_GOOGLE_PROFILES,
  MOCK_GOOGLE_SUB,
  MOCK_STEAM_ID_64,
  MOCK_STEAM_ID_64_LINK,
  OAUTH_FIXTURES,
} from "../../src/lib/oauthFixtures";

describe("oauthFixtures", () => {
  it("keeps the shared Google fixture bundle internally consistent", () => {
    expect(MOCK_GOOGLE_PROFILES[MOCK_GOOGLE_CODE]).toEqual({
      sub: MOCK_GOOGLE_SUB,
      email: MOCK_GOOGLE_EMAIL,
      name: MOCK_GOOGLE_NAME,
      picture: "",
    });
  });

  it("exposes the same values through OAUTH_FIXTURES", () => {
    expect(OAUTH_FIXTURES.google.code).toBe(MOCK_GOOGLE_CODE);
    expect(OAUTH_FIXTURES.google.sub).toBe(MOCK_GOOGLE_SUB);
    expect(OAUTH_FIXTURES.google.email).toBe(MOCK_GOOGLE_EMAIL);
    expect(OAUTH_FIXTURES.steam.steamId).toBe(MOCK_STEAM_ID_64);
    expect(OAUTH_FIXTURES.steam.linkSteamId).toBe(MOCK_STEAM_ID_64_LINK);
  });
});
