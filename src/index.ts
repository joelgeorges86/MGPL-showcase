import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import authRouter from "./routes/auth";
import userRouter from "./routes/user";
import oauthRouter from "./routes/oauth";
import healthRouter from "./routes/health";
import dpmRouter from "./routes/dpm";
import gamesRouter from "./routes/games";
import quickMatchRouter from "./routes/quickMatch";
import dlcAuditRouter from "./routes/dlcAudit";
import trackingRouter from "./routes/tracking";
import usersRouter from "./routes/users";
import enrichRouter from "./routes/enrich";
import giveawaysRouter from "./routes/giveaways";
import fleetRouter from "./routes/fleet";
import compatibilityRouter from "./routes/compatibility";
import syncRouter from "./routes/sync";
import profileSyncRouter from "./routes/profileSync";
import recommendRouter from "./routes/recommend";
import compareRouter from "./routes/compare";
import dealsRouter from "./routes/deals";
import dealArbitrageRouter from "./routes/dealArbitrage";
import wishlistRouter from "./routes/wishlist";
import alertsRouter from "./routes/alerts";
import { optionalAuth, requireAuth } from "./middleware/auth";

import platformsRouter from "./routes/platforms";
import hardwareRouter from "./routes/hardware";
import recommenderRouter from "./routes/recommender";
import modsRouter from "./routes/mods";
import hltbRouter from "./routes/hltb";
import stateRouter from "./routes/state";
import deviceCatalogRouter from "./routes/deviceCatalog";
import devicePricingRouter from "./routes/devicePricing";
import deviceReviewsRouter from "./routes/deviceReviews";
import devicesRouter from "./routes/devices";
import hardwareExplorerRouter from "./routes/hardwareExplorer";
import hostScanRouter from "./middleware/hostScan";
import analyticsRouter from "./routes/analytics";
import libraryRouter from "./routes/library";
import dashboardRouter from "./routes/dashboard";
import tagsRouter from "./routes/tags";
import notesRouter from "./routes/notes";
import retroRouter from "./routes/retro";
import mockRouter from "./routes/mock";
import discoveryRouter from "./routes/discovery";
import profileDashboardRouter from "./routes/profileDashboard";
import protonDbRouter from "./routes/protonDb";
import backlogRouter from "./routes/backlog";
import socialRouter from "./routes/social";
import friendsRouter from "./routes/friends";
import builderRouter from "./routes/builder";
import performanceRouter from "./routes/performance";
import { initSyncScheduler } from "./services/scheduler";
import { installExternalMocks } from "./services/externalMocks";
import { apiErrorHandler } from "./middleware/errorSanitizer";
import observabilityRouter from "./routes/observability";
import { dataAsOfHeader } from "./middleware/fallbackRenderer";
import { initSentry } from "./observability/sentry";
import { closeAllDatabases, shortenBusyTimeouts } from "./lib/dbHandles";
import { installShutdownHandlers } from "./lib/shutdown";

dotenv.config();

// WUD-PI003-4 (Privacy-Minimized Error Observability): initialize the
// isolated Sentry adapter before any request-handling middleware is
// registered. Remains a complete no-op when SENTRY_DSN is unset ΓÇö no
// network call, no SDK state, and no change to startup behavior. Dev/
// staging readiness only; production activation is a separate, unapproved
// step (Doppler SENTRY_DSN values are set exclusively by the Principal
// Operator ΓÇö see src/observability/sentry.ts for the full contract).
initSentry();

// In test mode, install the deterministic server-side axios mock adapter so
// external API calls (CheapShark, GamerPower, ITAD, Steam, Nexus Mods) never
// hit the network during the E2E suite. This keeps runs hermetic and green.
installExternalMocks();

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

// CSP policy selection:
//  - production: strict, allow-listed CDN script/style sources.
//  - test:       explicitly relaxed so the local @axe-core/playwright scanner
//                and injected test scripts are never blocked by CSP.
//  - development: disabled (helmet CSP off) for local iteration.
// NOTE (EPIC-FLEET-0001 hotfix): Helmet's CSP default for `script-src-attr`
// is `'none'`, which silently blocks the codebase's existing inline
// `onclick="..."` handlers (used throughout public/app.js's Fleet Dashboard
// row actions ΓÇö deleteDevice/editDevice/archiveDevice/restoreDevice/
// setActiveDevice) even though `scriptSrc` already explicitly allows
// 'unsafe-inline'. Without this directive, clicks on those buttons are
// blocked by the browser with zero visible error to the user, so the button
// appears to do nothing. Explicitly aligning `scriptSrcAttr` with the
// existing `scriptSrc` inline allowance restores intended behavior.
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.jsdelivr.net",
    "https://cdn.tailwindcss.com",
    "https://unpkg.com",
  ],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.jsdelivr.net",
    "https://cdn.tailwindcss.com",
  ],
  imgSrc: ["'self'", "data:", "https:", "http:"],
  connectSrc: ["'self'", "https:", "http:"],
  fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
  objectSrc: ["'none'"],
  upgradeInsecureRequests: [],
};

app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === "production"
        ? { directives: cspDirectives }
        : process.env.NODE_ENV === "test"
          ? {
              directives: {
                ...cspDirectives,
                scriptSrc: [
                  "'self'",
                  "'unsafe-inline'",
                  "'unsafe-eval'",
                  "https://cdn.jsdelivr.net",
                  "https://cdn.tailwindcss.com",
                  "https://unpkg.com",
                ],
              },
            }
          : false,

    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: "deny",
    },
    noSniff: true,
  }),
);

// Sprint 34 (FEAT-0168): gzip compression for all responses (API + static).
app.use(compression());

app.use(express.static(path.join(__dirname, "../public")));

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:4000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:4000",
      "http://localhost:64420",
    ],
  }),
);

// Sprint 5 (EPIC-06): state snapshots (full-DB export/import, including the
// Mods catalog) routinely exceed the 100KB express.json default, which broke
// restore of legitimate backups with HTTP 413. 25MB covers full-library JSON
// backups while remaining a sane ceiling for the single-user API.
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());

// Sprint 6 (PI-GTM-2026-002): stamp every API response with "Data as of"
// freshness headers so modules can render completeness indicators and the
// Integration Health Dashboard can surface staleness deterministically.
app.use(dataAsOfHeader);

// Rate limit is configurable so the E2E suite (which issues hundreds of API
// requests from a single IP) can raise the ceiling without weakening the
// production default of 300 requests / 15 minutes.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_MAX) || 300, // max requests per window
  message: { error: "Too many requests from this IP, please try again later." },
});

// Health probes mounted before rate limiters
app.use(healthRouter);
// Sprint 6.1 (GAP-001): sanitized DPM health endpoint with its own 5 req/sec limiter.
app.use("/api/dpm", dpmRouter);
// Sprint 6 (PI-GTM-2026-002): Unified Integration Health Dashboard API.
// Mounted before the global API limiter so its dedicated rate limiters govern
// the health/metrics/record surfaces independently (mirrors /api/dpm).
app.use("/api/observability", observabilityRouter);

app.use("/api/", apiLimiter);

const syncLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10, // Max 10 sync attempts per 5 minutes
});
app.use("/api/sync", syncLimiter);
app.use("/api/games/sync", syncLimiter);

app.use("/api/sync", requireAuth, syncRouter);

// Map /api/games/sync/* requests directly to gamesRouter sync endpoints (if any)
app.use("/api/games/sync", (req: Request, res: Response, next: NextFunction) => {
  req.url = "/sync" + req.url;
  gamesRouter(req, res, next);
});

app.use("/api/games/recommend", recommendRouter);
app.use("/api/games/compare", compareRouter);
app.use("/api/compare", compareRouter);

// Sprint 2 (FEAT-MULTITENANT): The library route reads custom tags for smart
// binders. optionalAuth lets a signed-in user see only their own tags while
// guests get mock empty state instead of global tag data.
app.use("/api/games", optionalAuth, gamesRouter);

app.use("/api/quick-match", quickMatchRouter);
app.use("/api/dlc-audit", dlcAuditRouter);
app.use("/api/tracking", trackingRouter);
app.use("/api/users", usersRouter);
app.use("/api/enrich", enrichRouter);
app.use("/api/giveaways", giveawaysRouter);
// AI-082 (#161): the hardware scan routes (POST /api/devices/scan, /scan-local
// and /api/scan) read the server's own hardware. They run only in local
// development and tests; on a hosted site they answer 404 before any router
// below is reached. GET /api/host-scan/status tells the client which applies.
app.use(hostScanRouter);
// Sprint 4 (EPIC-DEV-001): public hardware pricing, price history and
// community review routes. These MUST be mounted before the fully
// requireAuth-enforced fleetRouter/compatibilityRouter below, otherwise the
// public GET /api/devices/:id/pricing|price-history endpoints would be 401'd
// by the fleet router's blanket requireAuth middleware.
app.use("/api/devices", devicePricingRouter);
// Sprint 1B (EPICSEC06): public DPM playability / scan / upsert routes.
// Mounted BEFORE the requireAuth-gated compatibility/fleet routers so the
// playability matrix endpoints stay public (guest playability page) while the
// fleet CRUD (AppDevices) remains auth-only. The legacy `GET /` listing is
// intentionally not exposed here ΓÇö fleetRouter owns that path.
app.use("/api/devices", devicesRouter);
app.use("/api", deviceReviewsRouter);
app.use("/api/devices", compatibilityRouter);
app.use("/api/devices", fleetRouter);
app.use("/api/deals", dealArbitrageRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/alerts", alertsRouter);

app.use("/api/platforms", platformsRouter);
app.use("/api/hardware", hardwareRouter);
// Sprint 5 (EPICUX05): Hardware Explorer 2.0 ΓÇö POST /api/scan plus the
// /api/hardware/* capability, compatibility, benchmark, compare and upgrade
// surfaces. Mounted at /api so the documented /api/scan endpoint is exact.
app.use("/api", hardwareExplorerRouter);
app.use("/api/recommender", recommenderRouter);
app.use("/api/mods", modsRouter);
app.use("/api/hltb", hltbRouter);
app.use("/api/state", stateRouter);
app.use("/api/catalog", deviceCatalogRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/library", libraryRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/tags", tagsRouter);
app.use("/api/notes", notesRouter);
app.use("/api/retro", retroRouter);
// Sprint 2 (WUD-2.3 / EPIC-03): ProtonDB compatibility ingestion.
// Community tiers by Steam AppID with a local TTL cache.
app.use("/api/protondb", protonDbRouter);
app.use("/api/mock", mockRouter);
app.use("/api/backlog", backlogRouter);
app.use("/api/builder", builderRouter);
app.use("/api/performance", performanceRouter);
// Sprint 3 (EPIC-PROFILE-0001): privacy-minimized friend suggestions & social connections.
// Mounted under /api/social ΓÇö every route requires an authenticated session.
app.use("/api/social", socialRouter);
// PI-004: privacy-minimized friend library visibility.
app.use("/api/friends", friendsRouter);
// Sprint 2 (WUD-2.1 / EPIC-01): secure local cross-platform profile sync.
// Mounted under /api/profile-sync ΓÇö every route requires an authenticated
// session; tokens stay encrypted in the local SQLite WAL and never leave it.
app.use("/api/profile-sync", profileSyncRouter);
app.use("/api/user", userRouter);
// Sprint 3 (WUD-3.2 / EPICUX02): Game Discovery 2.0 ΓÇö mood rails + Surprise Me.
app.use("/api/discovery", discoveryRouter);
// Sprint 3 (WUD-3.3 / EPICUX03): Gamer Profile Foundations & Privacy dashboard.
app.use("/api/profile", profileDashboardRouter);
app.use("/api/auth", authRouter);
// Sprint 3 (FEAT-OAUTH-0001): Google OAuth 2.0 + Steam OpenID 2.0 flows.
// Mounted under /api/auth so the full paths are /api/auth/oauth/* and
// /api/auth/openid/* ΓÇö no collision with the native register/login/logout/me.
app.use("/api/auth", oauthRouter);

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "MPGL API" });
});

// SPA fallback: serve the app shell for any non-API GET request so client-side
// hash routing and deep links never 404. Real static files are still served by
// express.static above; this only catches unmatched navigation requests.
app.get("*", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Sprint 1A (EPICSEC04): terminal Express error handler. Never leaks stack
// traces, internal paths, environment variables, or pod names to clients ΓÇö
// full detail is logged server-side only, and every response is standardized
// through sendApiError with sanitized messages.
app.use(apiErrorHandler);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`MPGL API listening on http://0.0.0.0:${port}`);
  initSyncScheduler();
});

// AI-043: close HTTP and every SQLite handle cleanly on SIGTERM / SIGINT.
installShutdownHandlers({ server, closeDatabases: closeAllDatabases, shortenBusyTimeouts });
