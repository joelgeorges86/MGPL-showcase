/**
 * Sprint 3 (FEAT-OAUTH-0001): Deterministic OAuth/OpenID mock fixtures.
 *
 * Pure constants only — importable by the server routes, global test setup,
 * and E2E specs without pulling in express/axios/db module side-effects.
 *
 * In NODE_ENV=test the /api/auth/oauth/* and /api/auth/openid/* handlers
 * short-circuit to these fixtures, so the E2E suite runs fully offline with
 * zero live Google/Steam credentials or network calls.
 */

export const MOCK_GOOGLE_CODE = 'mock-google-code-1';
export const MOCK_GOOGLE_SUB = 'mock-google-sub-1';
export const MOCK_GOOGLE_EMAIL = 'mock.user@example.com';
export const MOCK_GOOGLE_NAME = 'Samy Cloud';

export const MOCK_STEAM_ID_64 = '76561198000000001';
export const MOCK_STEAM_ID_64_LINK = '76561198000000002';

export interface GoogleProfileFixture {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

/**
 * Mock Google userinfo keyed by the authorization code the test-mode callback
 * receives. Mirrors the MOCK_CHEAPSHARK_* deterministic-payload pattern used
 * by src/services/externalMocks.ts and test/fixtures.ts.
 */
export const MOCK_GOOGLE_PROFILES: Record<string, GoogleProfileFixture> = {
  [MOCK_GOOGLE_CODE]: {
    sub: MOCK_GOOGLE_SUB,
    email: MOCK_GOOGLE_EMAIL,
    name: MOCK_GOOGLE_NAME,
    picture: '',
  },
};

/** Single shared bundle consumed by test/global-setup.ts and the oauth spec. */
export const OAUTH_FIXTURES = {
  google: {
    code: MOCK_GOOGLE_CODE,
    sub: MOCK_GOOGLE_SUB,
    email: MOCK_GOOGLE_EMAIL,
    name: MOCK_GOOGLE_NAME,
  },
  steam: {
    steamId: MOCK_STEAM_ID_64,
    linkSteamId: MOCK_STEAM_ID_64_LINK,
  },
} as const;