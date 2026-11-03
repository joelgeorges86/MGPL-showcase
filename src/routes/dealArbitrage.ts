import { Router, Request, Response } from "express";
import {
  getArbitrageFeed,
  getPriceHistorySnapshot,
  ingestAllDeals,
  seedHistoryBaseline,
  seedDemoArbitrage,
} from "../services/dealAggregator";
import { sendApiError } from "../middleware/errorSanitizer";
import { SHUTDOWN_RETRY_MESSAGE, ShutdownInProgressError } from "../lib/shutdown";

const router = Router();

/**
 * Sprint 2 (WUD-2.2 / EPIC-02) — Advanced Deal Arbitrage & Price History.
 *
 *   GET  /api/deals/arbitrage               -> active deal cards enriched with
 *                                             30-day low, verified all-time low,
 *                                             and a 24-month price series.
 *   POST /api/deals/arbitrage/ingest        -> run the multi-source ingestion
 *                                             (ITAD / GG.deals / Deku Deals).
 *   GET  /api/deals/arbitrage/:gameId/history -> 24-month price history points.
 *
 * Every deal card carries only whitelisted storefront links; grey-market
 * domains and out-of-bounds prices are rejected at ingestion.
 */

function parseLimit(raw: unknown, fallback = 24, max = 48): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

/**
 * GET /api/deals/arbitrage
 * Returns the active arbitrage feed. When no local history baseline exists yet
 * it is seeded deterministically from the catalog so the Deal Finder renders
 * sparkline cards offline (pure-SVG, no charting library).
 */
router.get("/arbitrage", (_req: Request, res: Response) => {
  try {
    const limit = parseLimit(_req.query.limit, 24, 48);
    let feed = getArbitrageFeed(limit);
    if (feed.length === 0 || feed.some((deal) => deal.history.length < 2)) {
      seedDemoArbitrage();
      feed = getArbitrageFeed(limit);
    }
    res.json({ success: true, count: feed.length, deals: feed });
  } catch (err: any) {
    console.error("Error in GET /api/deals/arbitrage:", err?.message || err);
    sendApiError(res, 500, "Failed to load deal arbitrage feed");
  }
});

/**
 * POST /api/deals/arbitrage/ingest
 * Runs the multi-source arbitrage ingestion (ITAD / GG.deals / Deku Deals)
 * with rate limiting + backoff, persists price-history baseline points, and
 * refreshes wishlist / price-alert trigger state. One source failing never
 * aborts the others.
 */
router.post("/arbitrage/ingest", async (_req: Request, res: Response) => {
  try {
    const result = await ingestAllDeals();
    res.json({ ...result });
  } catch (err: any) {
    if (err instanceof ShutdownInProgressError) {
      sendApiError(res, 503, SHUTDOWN_RETRY_MESSAGE);
      return;
    }
    console.error("Error in POST /api/deals/arbitrage/ingest:", err?.message || err);
    sendApiError(res, 500, "Failed to ingest deal arbitrage sources");
  }
});

/**
 * GET /api/deals/arbitrage/:gameId/history
 * Returns the 24-month price history series (newest first) for the inline
 * pure-SVG sparkline.
 */
router.get("/arbitrage/:gameId/history", (req: Request, res: Response) => {
  try {
    const gameId = String(req.params.gameId || "").trim();
    if (!gameId) {
      return res.status(400).json({ success: false, error: "gameId is required." });
    }
    const months = parseLimit(req.query.months, 24, 24);
    let snapshot = getPriceHistorySnapshot(gameId, months, 48, true);
    if (snapshot.points.length < 2) {
      seedHistoryBaseline(gameId, gameId, snapshot.points[0]?.price || 1, true);
      snapshot = getPriceHistorySnapshot(gameId, months, 48, true);
    }
    res.json({
      success: true,
      gameId,
      count: snapshot.points.length,
      points: snapshot.points,
      availability: snapshot.availability,
      latestObservedAt: snapshot.latestObservedAt,
      coveredPeriod: snapshot.coveredPeriod,
      freshnessBoundDays: snapshot.freshnessBoundDays,
    });
  } catch (err: any) {
    console.error("Error in GET /api/deals/arbitrage/:gameId/history:", err?.message || err);
    sendApiError(res, 500, "Failed to load price history");
  }
});

export default router;
