import { Router, Request, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 4 (EPIC-DEV-001): Hardware pricing, price history & price-drop alerts.
 *
 * GET  /api/devices/:id/pricing       -> active seller links (Amazon, Best Buy,
 *                                        Newegg), current prices and "Best Time
 *                                        to Buy" classification (public).
 * GET  /api/devices/:id/price-history -> 12 monthly price points for SVG
 *                                        charting (public).
 * POST /api/devices/:id/alerts        -> save a user price-drop alert threshold
 *                                        (requireAuth), persisted via the
 *                                        existing AppPriceAlerts model keyed on
 *                                        the device id.
 *
 * Mounted at /api/devices BEFORE fleetRouter (which is fully requireAuth and
 * would otherwise 401 these public reads).
 */

const router = Router();

const RETAILERS = ["Amazon", "Best Buy", "Newegg"];

// Deterministic storefront search slugs for the three authorized sellers.
function sellerUrl(retailer: string, deviceName: string): string {
  const q = encodeURIComponent(deviceName);
  switch (retailer) {
    case "Amazon":
      return `https://www.amazon.com/s?k=${q}`;
    case "Best Buy":
      return `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`;
    case "Newegg":
      return `https://www.newegg.com/p/pl?d=${q}`;
    default:
      return "";
  }
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Resolve a catalog device by id; returns undefined when not found so callers
 * can respond 404 with a consistent payload.
 */
function findDevice(id: string) {
  return db
    .prepare('SELECT * FROM "catalog_devices" WHERE id = ?')
    .get(id) as any;
}

/**
 * Current best price per retailer = the most recent history row for that
 * retailer, or MSRP when no history exists yet.
 */
function currentRetailerPrices(deviceId: string, msrp: number) {
  const prices: Array<{ retailer: string; priceUsd: number }> = [];
  for (const retailer of RETAILERS) {
    const row = db
      .prepare(
        `SELECT priceUsd FROM hardware_price_history
         WHERE deviceId = ? AND retailer = ?
         ORDER BY recordedAt DESC LIMIT 1`,
      )
      .get(deviceId, retailer) as any;
    prices.push({ retailer, priceUsd: Number(row?.priceUsd ?? msrp) });
  }
  return prices;
}

/**
 * GET /api/devices/:id/pricing
 */
router.get("/:id/pricing", (req: Request, res: Response) => {
  try {
    const device = findDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found in catalog" });
    }

    const prices = currentRetailerPrices(device.id, Number(device.msrp) || 0);
    const best = prices.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a), prices[0]);

    // Best Time to Buy classification: historical low vs current best price.
    const lowRow = db
      .prepare(
        `SELECT MIN(priceUsd) AS low FROM hardware_price_history WHERE deviceId = ?`,
      )
      .get(device.id) as any;
    const historicalLow = Number(lowRow?.low ?? best.priceUsd);
    const nearLow = best.priceUsd <= historicalLow * 1.05;
    const classification = nearLow
      ? "Best Time to Buy"
      : best.priceUsd <= Number(device.msrp || 0)
        ? "Fair Price"
        : "Above MSRP";

    res.json({
      success: true,
      deviceId: device.id,
      deviceName: device.name,
      msrp: Number(device.msrp) || 0,
      currentBestPrice: best.priceUsd,
      currentBestRetailer: best.retailer,
      historicalLow,
      classification,
      sellers: prices.map((p) => ({
        retailer: p.retailer,
        url: sellerUrl(p.retailer, device.name),
        priceUsd: p.priceUsd,
        priceLabel: formatMoney(p.priceUsd),
        condition: "new",
      })),
    });
  } catch (err: any) {
    console.error("Error fetching device pricing:", err?.message || err);
    sendApiError(res, 500, "Failed to fetch device pricing");
  }
});

/**
 * GET /api/devices/:id/price-history
 * Returns exactly 12 monthly { month, priceUsd } points (trailing window) by
 * taking the best (min) price across retailers per month, which produces a
 * clean single-series line for the SVG chart.
 */
router.get("/:id/price-history", (req: Request, res: Response) => {
  try {
    const device = findDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found in catalog" });
    }

    const rows = db
      .prepare(
        `SELECT recordedAt, MIN(priceUsd) AS priceUsd
         FROM hardware_price_history
         WHERE deviceId = ?
         GROUP BY recordedAt
         ORDER BY recordedAt ASC
         LIMIT 12`,
      )
      .all(device.id) as any[];

    const points = rows.map((r) => ({
      month: r.recordedAt,
      priceUsd: Number(r.priceUsd),
    }));

    res.json({ success: true, deviceId: device.id, points });
  } catch (err: any) {
    console.error("Error fetching device price history:", err?.message || err);
    sendApiError(res, 500, "Failed to fetch device price history");
  }
});

/**
 * POST /api/devices/:id/alerts
 * Upsert a hardware price-drop alert for the authenticated user. Reuses the
 * same AppPriceAlerts table as game alerts, keyed by gameId = device id.
 */
router.post("/:id/alerts", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const device = findDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found in catalog" });
    }

    const { targetPrice, currentPrice } = req.body || {};
    const tgt = Number(targetPrice);
    if (!Number.isFinite(tgt) || tgt <= 0) {
      return res.status(400).json({ success: false, error: "A valid targetPrice is required" });
    }

    const cur = Number(currentPrice) || (device.msrp ? Number(device.msrp) : tgt);
    const isTriggered = cur > 0 && cur <= tgt ? 1 : 0;

    db.prepare(
      `INSERT INTO AppPriceAlerts (userId, gameId, title, targetPrice, currentPrice, historicalLow, isTriggered, acknowledged, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
       ON CONFLICT(userId, gameId) DO UPDATE SET
         title = excluded.title,
         targetPrice = excluded.targetPrice,
         currentPrice = COALESCE(excluded.currentPrice, AppPriceAlerts.currentPrice),
         historicalLow = COALESCE(excluded.historicalLow, AppPriceAlerts.historicalLow),
         isTriggered = excluded.isTriggered,
         acknowledged = 0,
         updatedAt = CURRENT_TIMESTAMP`,
    ).run(userId, device.id, device.name, tgt, cur, cur, isTriggered);

    const alert = db
      .prepare("SELECT * FROM AppPriceAlerts WHERE userId = ? AND gameId = ?")
      .get(userId, device.id) as any;

    res.json({
      success: true,
      alert,
      deviceId: device.id,
      deviceName: device.name,
      targetPrice: tgt,
      currentPrice: cur,
      triggered: Boolean(isTriggered),
      message: isTriggered
        ? `Price alert triggered for ${device.name}!`
        : `Price alert saved for ${device.name}.`,
    });
  } catch (err: any) {
    console.error("Error saving device price alert:", err?.message || err);
    sendApiError(res, 500, "Failed to save price alert");
  }
});

export default router;