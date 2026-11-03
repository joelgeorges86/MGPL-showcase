import crypto from 'crypto';
import axios from 'axios';
import { db } from '../db';
import { MOCK_GOOGLE_PROFILES } from './oauthFixtures';

/**
 * Sprint 3 (FEAT-OAUTH-0001): Third-party authentication primitives.
 *
 * Google OAuth 2.0 (authorization-code + PKCE S256) and Steam OpenID 2.0
 * (checkid_setup / check_authentication). All state is single-use with a
 * 10-minute TTL stored in an in-memory Map — sufficient for this single-node
 * Express app and fully deterministic in the E2E suite.
 *
 * Test mode (NODE_ENV=test) short-circuits every network exchange before
 * axios is reached, so the suite never leaves the machine and requires no
 * real Google/Steam credentials.
 */

export function isTestMode(): boolean {
  return process.env.NODE_ENV === 'test';
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// Single-use OAuth state store
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthPendingState {
  provider: 'google' | 'steam';
  verifier?: string;
  createdAt: number;
}

const stateStore = new Map<string, OAuthPendingState>();

function sweepExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of stateStore) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      stateStore.delete(key);
    }
  }
}

export function createOAuthState(input: { provider: 'google' | 'steam'; verifier?: string }): string {
  sweepExpiredStates();
  const state = crypto.randomBytes(24).toString('hex');
  stateStore.set(state, { provider: input.provider, verifier: input.verifier, createdAt: Date.now() });
  return state;
}

/**
 * Delete-on-consume (single-use) with TTL enforcement. Returns null for a
 * replayed, expired, or unknown state so the callback can reject cleanly.
 */
export function consumeOAuthState(state: string): OAuthPendingState | null {
  const entry = stateStore.get(state);
  if (!entry) {
    return null;
  }
  stateStore.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) {
    return null;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Google OAuth 2.0
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function googleClientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) {
    throw new Error('GOOGLE_CLIENT_ID is required for production Google OAuth');
  }
  return v;
}

function googleClientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) {
    throw new Error('GOOGLE_CLIENT_SECRET is required for production Google OAuth');
  }
  return v;
}

/** Absolute callback URL for Google to return the authorization code to. */
export function getGoogleRedirectUrl(): string {
  return process.env.OAUTH_REDIRECT_URL || 'http://localhost:4000/api/auth/oauth/google/callback';
}

export function buildGoogleAuthorizeUrl(input: { state: string; codeChallenge: string }): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: getGoogleRedirectUrl(),
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
}

export async function exchangeGoogleCodeForToken(
  code: string,
  codeVerifier: string
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: getGoogleRedirectUrl(),
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const res = await axios.post<GoogleTokenResponse>(GOOGLE_TOKEN_URL, params.toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  return res.data;
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  name?: string;
  picture?: string;
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await axios.get<GoogleProfile & { email?: string }>(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });
  const p = res.data;
  if (!p.sub) {
    throw new Error('Google profile response missing sub (subject) claim');
  }
  return { sub: p.sub, email: p.email ?? null, name: p.name, picture: p.picture };
}

// ---------------------------------------------------------------------------
// Steam OpenID 2.0
// ---------------------------------------------------------------------------

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const STEAM_OPENID_NS = 'http://specs.openid.net/auth/2.0';
const STEAM_IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

export function buildSteamOpenIdUrl(input: {
  state: string;
  returnTo: string;
  realm: string;
  link?: boolean;
}): string {
  const returnTo =
    input.returnTo +
    (input.returnTo.includes('?') ? '&' : '?') +
    `state=${encodeURIComponent(input.state)}` +
    (input.link ? '&link=1' : '');
  const params = new URLSearchParams({
    'openid.ns': STEAM_OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': input.realm,
    'openid.identity': STEAM_IDENTIFIER_SELECT,
    'openid.claimed_id': STEAM_IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_URL}?${params.toString()}`;
}

/**
 * Production path: echo the incoming id_res params back to Steam with
 * openid.mode=check_authentication and require is_valid:true. The test suite
 * skips this entirely (see routes/oauth.ts) so steamcommunity.com is never
 * called offline.
 */
export async function verifySteamOpenIdResponse(
  params: Record<string, unknown>
): Promise<boolean> {
  const q = params as Record<string, string | undefined>;
  if (q['openid.mode'] !== 'id_res') {
    return false;
  }
  const required = [
    'openid.ns',
    'openid.op_endpoint',
    'openid.claimed_id',
    'openid.identity',
    'openid.return_to',
    'openid.response_nonce',
    'openid.assoc_handle',
    'openid.signed',
    'openid.sig',
  ];
  if (required.some((k) => !q[k])) {
    return false;
  }
  const verifyParams = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) {
    if (key.startsWith('openid.') && value !== undefined) {
      verifyParams.set(key, value);
    }
  }
  verifyParams.set('openid.mode', 'check_authentication');
  try {
    const res = await axios.post<string>(STEAM_OPENID_URL, verifyParams.toString(), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    return /is_valid:true/.test(res.data);
  } catch (error) {
    console.error('Steam OpenID check_authentication error:', error);
    return false;
  }
}

/**
 * Extract the 64-bit numeric Steam ID from an OpenID claimed_id/identity:
 *   https://steamcommunity.com/openid/id/<64-bit-id>
 * Returns null for malformed values.
 */
export function parseSteamId64(claimedId: unknown): string | null {
  const raw = typeof claimedId === 'string' ? claimedId : '';
  const m = raw.match(/\/id\/(\d{17})$/);
  if (!m) {
    return null;
  }
  // Reject non-numeric overflow / leading-zero abuse by normalizing.
  const value = m[1].replace(/^0+(?=\d)/, '');
  return value.length === 17 ? value : null;
}

// ---------------------------------------------------------------------------
// Test-mode deterministic mock harness
// ---------------------------------------------------------------------------

export function buildMockGoogleCallbackUrl(input: { origin: string; state: string; code: string }): string {
  const params = new URLSearchParams({
    code: input.code,
    state: input.state,
    mock: '1',
  });
  return `${input.origin}/api/auth/oauth/google/callback?${params.toString()}`;
}

export function buildMockSteamCallbackUrl(input: {
  origin: string;
  state: string;
  steamId: string;
  link?: boolean;
}): string {
  const params = new URLSearchParams({
    'openid.ns': STEAM_OPENID_NS,
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM_OPENID_URL,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${input.steamId}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${input.steamId}`,
    'openid.return_to': `${input.origin}/api/auth/openid/steam/callback`,
    'openid.response_nonce': '2026-08-19T00:00:00Z-mock-signature',
    'openid.assoc_handle': 'mock-assoc-handle',
    'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'mock-signature',
    state: input.state,
    mock: '1',
  });
  if (input.link) {
    params.set('link', '1');
  }
  return `${input.origin}/api/auth/openid/steam/callback?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// AuthUser / AuthAccount persistence & account linking
// ---------------------------------------------------------------------------

/** cuid-shaped id generator matching src/routes/auth.ts's cuuid(). */
function cuuid(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface OAuthIdentity {
  provider: 'google' | 'steam';
  providerAccountId: string;
  email?: string | null;
  name?: string | null;
}

export interface OAuthUserResult {
  id: string;
  email: string | null;
  role: string;
}

interface AuthUserRow {
  id: string;
  email: string | null;
  role: string;
}

function readUser(userId: string): AuthUserRow | undefined {
  return db
    .prepare('SELECT id, email, role FROM AuthUsers WHERE id = ?')
    .get(userId) as AuthUserRow | undefined;
}

function findAllAccountsForProvider(
  provider: string,
  providerAccountId: string
): { id: string; userId: string }[] {
  return db
    .prepare('SELECT id, userId FROM AuthAccounts WHERE provider = ? AND providerAccountId = ?')
    .all(provider, providerAccountId) as { id: string; userId: string }[];
}

/**
 * Upsert a third-party identity into AuthUser + AuthAccount.
 *
 * Linking rules (account-hijack safe):
 *  1. Existing AuthAccount(provider, providerAccountId) → log that user in
 *     (idempotent re-auth, never duplicated).
 *  2. Google with a verified email that matches an existing AuthUser → link
 *     the AuthAccount to that user (Google already verified the email).
 *  3. No match → create AuthUser with passwordHash = NULL and link the account.
 *
 * Steam identities are NEVER auto-linked by email (Steam supplies no verified
 * email); linking a Steam identity to an existing user requires an explicit,
 * authenticated `link=1` request which routes through linkOAuthAccountToUser().
 * Wrapped in a single transaction so account creation + linking is atomic.
 */
export function upsertOAuthUser(identity: OAuthIdentity): OAuthUserResult {
  return db.transaction(() => {
    const existingAccounts = findAllAccountsForProvider(identity.provider, identity.providerAccountId);
    if (existingAccounts.length > 0) {
      const user = readUser(existingAccounts[0].userId);
      if (user) {
        return user;
      }
      // Orphaned account (AuthUser deleted but cascade failed) — fall through.
    }

    let userId: string | null = null;
    if (identity.email) {
      const byEmail = db.prepare('SELECT id FROM AuthUsers WHERE email = ?').get(identity.email) as
        | { id: string }
        | undefined;
      if (byEmail) {
        userId = byEmail.id;
      }
    }

    if (!userId) {
      const newId = cuuid();
      try {
        db.prepare(
          "INSERT INTO AuthUsers (id, email, passwordHash, role, createdAt, updatedAt) VALUES (?, ?, NULL, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ).run(newId, identity.email ?? null);
        userId = newId;
      } catch (error: any) {
        // Unique email race — re-resolve the existing user.
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          const byEmail = identity.email
            ? (db.prepare('SELECT id FROM AuthUsers WHERE email = ?').get(identity.email) as
                | { id: string }
                | undefined)
            : undefined;
          if (byEmail) {
            userId = byEmail.id;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    db.prepare(
      'INSERT OR IGNORE INTO AuthAccounts (id, userId, provider, providerAccountId, createdAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(cuuid(), userId, identity.provider, identity.providerAccountId);

    // Resolve final owner (INSERT OR IGNORE may have lost a concurrent race).
    const finalUser = readUser(userId);
    if (!finalUser) {
      throw new Error('OAuth user creation failed: user row missing after upsert');
    }
    return finalUser;
  })();
}

export interface LinkAccountResult {
  linked: boolean;
  alreadyLinkedToSameUser?: boolean;
  conflict?: boolean;
}

/**
 * Attach a third-party identity to an already authenticated AuthUser
 * (`link=1` flow). Refuses to move an identity that another user already
 * claimed — that is a hard 409 conflict, never a silent re-owner.
 */
export function linkOAuthAccountToUser(input: {
  userId: string;
  provider: 'google' | 'steam';
  providerAccountId: string;
}): LinkAccountResult {
  return db.transaction(() => {
    const existingAccounts = findAllAccountsForProvider(input.provider, input.providerAccountId);
    if (existingAccounts.length > 0) {
      if (existingAccounts[0].userId === input.userId) {
        return { linked: true, alreadyLinkedToSameUser: true };
      }
      return { linked: false, conflict: true };
    }
    db.prepare(
      'INSERT INTO AuthAccounts (id, userId, provider, providerAccountId, createdAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(cuuid(), input.userId, input.provider, input.providerAccountId);
    return { linked: true };
  })();
}