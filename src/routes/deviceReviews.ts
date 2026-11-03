import { Router, Request, Response } from "express";
import { db } from "../db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { sendApiError } from '../middleware/errorSanitizer';

/**
 * Sprint 4 (EPIC-DEV-001): Community hardware review endpoints.
 *
 * GET   /devices/:id/reviews       -> paginated reviews + aggregate score,
 *                                    sort modes (helpful|recent|rating|critical)
 *                                    and verified-owner filter (public).
 * POST  /devices/:id/reviews       -> submit a review (requireAuth, 1 per
 *                                    user/device). isVerifiedOwner is derived
 *                                    from the user's AppDevices fleet.
 * POST  /reviews/:id/vote          -> toggle helpfulness up/down vote.
 * PATCH /reviews/:id/editors-pick  -> toggle Editor's Pick (staff/admin only).
 *
 * Mounted at /api before the auth-enforced fleet route so the public review
 * list remains accessible.
 */

const router = Router();

const SORT_COLUMNS: Record<string, string> = {
  helpful: "r.helpfulScore DESC, r.createdAt DESC",
  recent: "r.createdAt DESC",
  rating: "r.rating DESC, r.helpfulScore DESC",
  critical: "r.rating ASC, r.createdAt ASC",
};

function parseJson(value: any): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findDevice(id: string) {
  return db.prepare('SELECT * FROM "catalog_devices" WHERE id = ?').get(id) as any;
}

function mapReview(row: any) {
  return {
    reviewId: row.reviewId,
    deviceId: row.deviceId,
    rating: Number(row.rating),
    title: row.title,
    body: row.body,
    pros: parseJson(row.prosJson),
    cons: parseJson(row.consJson),
    isEditorsPick: Boolean(row.isEditorsPick),
    helpfulScore: Number(row.helpfulScore ?? 0),
    isVerifiedOwner: Boolean(row.isVerifiedOwner),
    author: row.authorName || row.authorGamerTag || "MGPL Member",
    createdAt: row.createdAt,
  };
}

/**
 * GET /devices/:id/reviews
 */
router.get("/devices/:id/reviews", (req: Request, res: Response) => {
  try {
    const device = findDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found in catalog" });
    }

    const sort = (typeof req.query.sort === "string" && SORT_COLUMNS[req.query.sort])
      ? req.query.sort
      : "helpful";
    const verified = req.query.verified === "1" || req.query.verified === "true";
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || "10"), 10) || 10));

    const where = ["r.deviceId = ?"];
    const params: unknown[] = [device.id];
    if (verified) where.push("r.isVerifiedOwner = 1");
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const orderSql = SORT_COLUMNS[sort];

    const countRow = db
      .prepare(`SELECT COUNT(*) AS total FROM device_reviews r ${whereSql}`)
      .get(...params) as { total: number };

    const aggRow = db
      .prepare(`SELECT AVG(r.rating) AS average, COUNT(*) AS count FROM device_reviews r ${whereSql}`)
      .get(...params) as { average: number | null; count: number };

    const offset = (page - 1) * pageSize;
    const rows = db
      .prepare(
        `SELECT r.*, u.displayName AS authorName, u.gamerTag AS authorGamerTag
         FROM device_reviews r
         LEFT JOIN "AuthUsers" u ON u.id = r.userId
         ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as any[];

    res.json({
      success: true,
      deviceId: device.id,
      deviceName: device.name,
      aggregate: {
        average: aggRow.average != null ? Math.round(Number(aggRow.average) * 10) / 10 : null,
        count: Number(aggRow.count),
      },
      pagination: {
        page,
        pageSize,
        total: Number(countRow.total),
        totalPages: Math.max(1, Math.ceil(Number(countRow.total) / pageSize)),
      },
      sort,
      reviews: rows.map(mapReview),
    });
  } catch (err: any) {
    console.error("Error listing device reviews:", err?.message || err);
    sendApiError(res, 500, "Failed to list device reviews");
  }
});

/**
 * POST /devices/:id/reviews
 * Submit a review for the authenticated user (at most one per user per device).
 */
router.post("/devices/:id/reviews", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const device = findDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: "Device not found in catalog" });
    }

    const { rating, title, body, pros, cons } = req.body || {};
    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ success: false, error: "rating must be an integer 1-5" });
    }
    const titleStr = String(title || "").trim();
    const bodyStr = String(body || "").trim();
    if (!titleStr && !bodyStr) {
      return res.status(400).json({ success: false, error: "A title or body is required" });
    }

    const existing = db
      .prepare("SELECT reviewId FROM device_reviews WHERE deviceId = ? AND userId = ?")
      .get(device.id, userId) as any;
    if (existing) {
      return res.status(409).json({ success: false, error: "You have already reviewed this device" });
    }

    // Verified-owner detection: does the device name match a device in the
    // user's fleet (normalized whitespace/case-insensitive)?
    const owned = db
      .prepare('SELECT deviceName FROM "AppDevices" WHERE userId = ?')
      .all(userId) as any[];
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = normalize(device.name);
    const isVerifiedOwner = owned.some((d: any) => normalize(d.deviceName || "") === target) ? 1 : 0;

    const info = db
      .prepare(
        `INSERT INTO device_reviews
           (deviceId, userId, rating, title, body, prosJson, consJson, isEditorsPick, helpfulScore, isVerifiedOwner)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(
        device.id,
        userId,
        ratingNum,
        titleStr || null,
        bodyStr || null,
        Array.isArray(pros) ? JSON.stringify(pros) : null,
        Array.isArray(cons) ? JSON.stringify(cons) : null,
        isVerifiedOwner,
      );

    const row = db
      .prepare(
        `SELECT r.*, u.displayName AS authorName, u.gamerTag AS authorGamerTag
         FROM device_reviews r
         LEFT JOIN "AuthUsers" u ON u.id = r.userId
         WHERE r.reviewId = ?`,
      )
      .get(info.lastInsertRowid) as any;

    res.status(201).json({ success: true, review: mapReview(row) });
  } catch (err: any) {
    console.error("Error submitting device review:", err?.message || err);
    sendApiError(res, 500, "Failed to submit review");
  }
});

/**
 * POST /reviews/:id/vote
 * Toggle a helpfulness vote. Casting the same vote again removes it; casting
 * the opposite flips it. Recomputes the review's net helpfulScore.
 */
router.post("/reviews/:id/vote", requireAuth, (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).user!.userId;
    const reviewId = Number(req.params.id);
    const voteType = req.body?.voteType === "down" ? "down" : req.body?.voteType === "up" ? "up" : null;
    if (!voteType) {
      return res.status(400).json({ success: false, error: "voteType must be 'up' or 'down'" });
    }

    const review = db.prepare("SELECT reviewId FROM device_reviews WHERE reviewId = ?").get(reviewId) as any;
    if (!review) {
      return res.status(404).json({ success: false, error: "Review not found" });
    }

    const existing = db
      .prepare("SELECT voteId, voteType FROM review_votes WHERE reviewId = ? AND userId = ?")
      .get(reviewId, userId) as any;

    const toggle = db.transaction(() => {
      if (!existing) {
        db.prepare("INSERT INTO review_votes (reviewId, userId, voteType) VALUES (?, ?, ?)").run(reviewId, userId, voteType);
      } else if (existing.voteType === voteType) {
        db.prepare("DELETE FROM review_votes WHERE voteId = ?").run(existing.voteId);
      } else {
        db.prepare("UPDATE review_votes SET voteType = ? WHERE voteId = ?").run(voteType, existing.voteId);
      }
      const counts = db
        .prepare(
          `SELECT
             SUM(CASE WHEN voteType = 'up' THEN 1 ELSE 0 END) AS ups,
             SUM(CASE WHEN voteType = 'down' THEN 1 ELSE 0 END) AS downs
           FROM review_votes WHERE reviewId = ?`,
        )
        .get(reviewId) as any;
      const score = (Number(counts.ups) || 0) - (Number(counts.downs) || 0);
      db.prepare("UPDATE device_reviews SET helpfulScore = ? WHERE reviewId = ?").run(score, reviewId);
      return score;
    });

    const helpfulScore = toggle();

    res.json({
      success: true,
      reviewId,
      helpfulScore,
      userVote: existing?.voteType === voteType ? null : voteType,
    });
  } catch (err: any) {
    console.error("Error voting on review:", err?.message || err);
    sendApiError(res, 500, "Failed to vote on review");
  }
});

/**
 * PATCH /reviews/:id/editors-pick
 * Toggle Editor's Pick status. Staff/admin only.
 */
router.patch("/reviews/:id/editors-pick", requireAuth, (req: Request, res: Response) => {
  try {
    const user = (req as AuthedRequest).user!;
    if (user.role !== "admin" && user.role !== "staff") {
      return res.status(403).json({ success: false, error: "Staff or admin required" });
    }

    const reviewId = Number(req.params.id);
    const review = db.prepare("SELECT reviewId, isEditorsPick FROM device_reviews WHERE reviewId = ?").get(reviewId) as any;
    if (!review) {
      return res.status(404).json({ success: false, error: "Review not found" });
    }

    const newValue = review.isEditorsPick ? 0 : 1;
    db.prepare("UPDATE device_reviews SET isEditorsPick = ? WHERE reviewId = ?").run(newValue, reviewId);

    res.json({ success: true, reviewId, isEditorsPick: Boolean(newValue) });
  } catch (err: any) {
    console.error("Error toggling editor's pick:", err?.message || err);
    sendApiError(res, 500, "Failed to toggle editor's pick");
  }
});

export default router;