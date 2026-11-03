import { Router, Request, Response } from "express";
import { db } from "../db";
import { AuthedRequest, optionalAuth } from "../middleware/auth";
import { generateToken, setSessionCookie } from "../lib/auth";
import {
  isTestMode,
  generateCodeVerifier,
  generateCodeChallenge,
  createOAuthState,
  consumeOAuthState,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCodeForToken,
  fetchGoogleProfile,
  buildSteamOpenIdUrl,
  verifySteamOpenIdResponse,
  parseSteamId64,
  buildMockGoogleCallbackUrl,
  buildMockSteamCallbackUrl,
  upsertOAuthUser,
  linkOAuthAccountToUser,
} from "../lib/oauth";
import { MOCK_GOOGLE_PROFILES, MOCK_GOOGLE_CODE } from "../lib/oauthFixtures";

/**
 * Sprint 3 (FEAT-OAUTH-0001): Third-party authentication endpoints.
 *
 * Google OAuth 2.0 (authorization-code + PKCE S256) and Steam OpenID 2.0
 * (checkid_setup / check_authentication). Mounted under /api/auth so the full
 * paths are:
 *   GET /api/auth/oauth/google
 *   GET /api/auth/oauth/google/callback
 *   GET /api/auth/openid/steam
 *   GET /api/auth/openid/steam/callback
 *
 * On success all flows set the identical httpOnly `mgpl_session` cookie and
 * redirect the browser back to the SPA shell.
 *
 * Test mode (NODE_ENV=test) short-circuits the start endpoints to an
 * in-process mock callback URL and the callbacks to deterministic fixtures,
 * so the E2E suite runs fully offline with zero live Google/Steam credentials.
 * The test-only `<steamId>` / `<link>` query overrides are hard-guarded and
 * ignored outside NODE_ENV=test — production can never forge a Steam identity.
 */

const router = Router();

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:4000";
const TRUSTED_OAUTH_ORIGINS = new Set([
  "https://accounts.google.com",
  "https://steamcommunity.com",
]);

function safeRedirect(res: Response, target: string): void {
  if (/^https?:\/\//.test(target)) {
    let targetUrl: URL;
    let clientUrl: URL;

    try {
      targetUrl = new URL(target);
      clientUrl = new URL(CLIENT_ORIGIN);
    } catch {
      res.status(400).json({ error: "Invalid redirect target" });
      return;
    }

    if (targetUrl.origin !== clientUrl.origin && !TRUSTED_OAUTH_ORIGINS.has(targetUrl.origin)) {
      res.status(400).json({ error: "Invalid redirect target" });
      return;
    }
  }
  res.redirect(target);
}

function failureRedirect(res: Response, error: string): void {
  res.redirect(`${CLIENT_ORIGIN}/?auth_error=${encodeURIComponent(error)}`);
}

// ---------------------------------------------------------------------------
// Google OAuth 2.0
// ---------------------------------------------------------------------------

router.get("/oauth/google", (_req: Request, res: Response) => {
  const verifier = generateCodeVerifier();
  const state = createOAuthState({ provider: "google", verifier });

  if (isTestMode()) {
    const mockUrl = buildMockGoogleCallbackUrl({
      origin: CLIENT_ORIGIN,
      state,
      code: MOCK_GOOGLE_CODE,
    });
    return safeRedirect(res, mockUrl);
  }

  const authorizeUrl = buildGoogleAuthorizeUrl({
    state,
    codeChallenge: generateCodeChallenge(verifier),
  });
  return safeRedirect(res, authorizeUrl);
});

router.get("/oauth/google/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) {
    return failureRedirect(res, "Missing OAuth code or state");
  }
  const pending = consumeOAuthState(state);
  if (!pending || pending.provider !== "google") {
    return failureRedirect(res, "Invalid or expired OAuth state");
  }

  try {
    let profile: { sub: string; email: string | null; name?: string; picture?: string };

    if (isTestMode()) {
      const fixture = MOCK_GOOGLE_PROFILES[code];
      if (!fixture) {
        return failureRedirect(res, "Unknown mock Google code");
      }
      profile = {
        sub: fixture.sub,
        email: fixture.email,
        name: fixture.name,
        picture: fixture.picture,
      };
    } else {
      const token = await exchangeGoogleCodeForToken(code, pending.verifier ?? "");
      profile = await fetchGoogleProfile(token.access_token);
    }

    const user = upsertOAuthUser({
      provider: "google",
      providerAccountId: profile.sub,
      email: profile.email,
      name: profile.name,
    });

    setSessionCookie(
      res,
      generateToken({ userId: user.id, email: user.email ?? undefined, role: user.role }),
    );
    return safeRedirect(res, `${CLIENT_ORIGIN}/`);
  } catch (error) {
    console.error("GET /api/auth/oauth/google/callback error:", error);
    return failureRedirect(res, "Google authentication failed");
  }
});

// ---------------------------------------------------------------------------
// Steam OpenID 2.0
// ---------------------------------------------------------------------------

router.get("/openid/steam", (req: Request, res: Response) => {
  const state = createOAuthState({ provider: "steam" });
  const link = req.query.link === "1";

  if (isTestMode()) {
    // Test-only override: deterministic Steam ID that the callback will accept.
    const steamId =
      typeof req.query.steamId === "string" && /^\d{17}$/.test(req.query.steamId)
        ? req.query.steamId
        : undefined;
    const mockUrl = buildMockSteamCallbackUrl({
      origin: CLIENT_ORIGIN,
      state,
      steamId: steamId || "76561198000000001",
      link,
    });
    return safeRedirect(res, mockUrl);
  }

  const realm = `${CLIENT_ORIGIN}/`;
  const returnTo = `${CLIENT_ORIGIN}/api/auth/openid/steam/callback`;
  const openIdUrl = buildSteamOpenIdUrl({ state, returnTo, realm, link });
  return safeRedirect(res, openIdUrl);
});

router.get("/openid/steam/callback", optionalAuth, async (req: Request, res: Response) => {
  const { state } = req.query as { state?: string };
  if (!state) {
    return failureRedirect(res, "Missing OpenID state");
  }
  const pending = consumeOAuthState(state);
  if (!pending || pending.provider !== "steam") {
    return failureRedirect(res, "Invalid or expired OpenID state");
  }

  // OpenID return_to must match the query values this server captured. Any
  // variation in production is a signature-validation failure.
  if (!isTestMode()) {
    const valid = await verifySteamOpenIdResponse(req.query);
    if (!valid) {
      return failureRedirect(res, "Steam OpenID validation failed");
    }
  }

  const link = req.query.link === "1";

  // Production: the Steam-verified claimed_id/identity is the ONLY acceptable
  // source of the Steam ID. The test-mode `<steamId>` override is stripped
  // from the production codepath by hard-guarding it below.
  let steamId: string | null;
  if (isTestMode()) {
    const override =
      typeof req.query.steamId === "string" && /^\d{17}$/.test(req.query.steamId)
        ? req.query.steamId
        : undefined;
    const claimed =
      typeof req.query["openid.claimed_id"] === "string" ? req.query["openid.claimed_id"] : "";
    steamId = override || parseSteamId64(claimed);
  } else {
    const claimed =
      typeof req.query["openid.claimed_id"] === "string" ? req.query["openid.claimed_id"] : "";
    steamId = parseSteamId64(claimed);
  }
  if (!steamId) {
    return failureRedirect(res, "Malformed Steam ID");
  }

  try {
    if (link) {
      const authed = req as AuthedRequest;
      if (!authed.user) {
        return failureRedirect(res, "Linking requires an authenticated session");
      }
      const result = linkOAuthAccountToUser({
        userId: authed.user.userId,
        provider: "steam",
        providerAccountId: steamId,
      });
      if (result.conflict) {
        return failureRedirect(res, "Steam account already linked to another user");
      }
      // Re-issue the session cookie for the SAME user so the client stays
      // signed in after the link redirect round-trip.
      const user = db
        .prepare("SELECT id, email, role FROM AuthUsers WHERE id = ?")
        .get(authed.user.userId) as { id: string; email: string | null; role: string };
      setSessionCookie(
        res,
        generateToken({ userId: user.id, email: user.email ?? undefined, role: user.role }),
      );
      return safeRedirect(res, `${CLIENT_ORIGIN}/`);
    }

    const user = upsertOAuthUser({
      provider: "steam",
      providerAccountId: steamId,
    });

    setSessionCookie(
      res,
      generateToken({ userId: user.id, email: user.email ?? undefined, role: user.role }),
    );
    return safeRedirect(res, `${CLIENT_ORIGIN}/`);
  } catch (error) {
    console.error("GET /api/auth/openid/steam/callback error:", error);
    return failureRedirect(res, "Steam authentication failed");
  }
});

export default router;
