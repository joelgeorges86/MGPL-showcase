import { Database as DatabaseType } from "better-sqlite3";
import { HARDWARE_PROFILES } from "./devices";

/**
 * Sprint 4 (EPIC-DEV-001): Community hardware reviews + hardware price history
 * seed data.
 *
 * seedReviews() inserts deterministic baseline community reviews (with pros/cons
 * JSON) against a stable MGPL seed author so the public review endpoints have
 * data without any user having to submit. seedHardwarePriceHistory() generates
 * a deterministic 12-month price series per catalog device across Amazon, Best
 * Buy and Newegg so the /price-history chart and "Best Time to Buy" classifier
 * always render. Both are idempotent (INSERT OR IGNORE) and safe to re-run on
 * every server boot.
 */

// Stable MGPL seed author. Reviews are authored by this synthetic user so the
// public review list renders an author display name without exposing any real
// account. The row is inserted idempotently (ignored if already present).
const SEED_AUTHOR_ID = "seed-user-mgpl-reviews";

interface SeedReview {
  deviceId: string;
  rating: number;
  title: string;
  body: string;
  pros: string[];
  cons: string[];
  isEditorsPick: boolean;
  helpfulScore: number;
}

const SEED_REVIEWS: SeedReview[] = [
  {
    deviceId: "steam-deck-oled",
    rating: 5,
    title: "The definitive handheld",
    body: "The OLED panel and 90Hz refresh transform the experience. Suspend/resume remains best in class and the battery finally lasts a full session.",
    pros: ["Stunning OLED screen", "Best-in-class suspend/resume", "Huge verified library"],
    cons: ["Larger games can push the APU", "SteamOS learning curve for tinkerers"],
    isEditorsPick: true,
    helpfulScore: 42,
  },
  {
    deviceId: "rog-ally-x",
    rating: 4,
    title: "Desktop muscle in your hands",
    body: "24GB RAM and the 80Wh battery fix the original's biggest pain points. Windows means full launcher compatibility, though it's heavier than SteamOS.",
    pros: ["Z1 Extreme performance", "24GB RAM headroom", "Full Windows compatibility"],
    cons: ["Windows handheld polish", "Fan noise under load"],
    isEditorsPick: true,
    helpfulScore: 31,
  },
  {
    deviceId: "ps5",
    rating: 5,
    title: "The console benchmark",
    body: "A rock-solid 4K machine with an unmatched exclusive library. The DualSense haptics are still the most immersive controller feature this generation.",
    pros: ["Excellent exclusive library", "Fast NVMe load times", "DualSense haptics"],
    cons: ["Expensive storage expansion", "Large physical footprint"],
    isEditorsPick: false,
    helpfulScore: 27,
  },
  {
    deviceId: "xbox-series-x",
    rating: 4,
    title: "Game Pass value king",
    body: "12 TFLOPS plus Quick Resume makes this the best value in console gaming. Game Pass keeps the library flowing every month.",
    pros: ["Game Pass value", "Quick Resume", "Quiet under load"],
    cons: ["Fewer generation-defining exclusives", "UI can feel busy"],
    isEditorsPick: false,
    helpfulScore: 19,
  },
  {
    deviceId: "alienware-aurora-r15",
    rating: 4,
    title: "No-compromise prebuilt",
    body: "RTX 4080 and a liquid-cooled i9 in a serviceable chassis. Pricey, but it ships ready to run every current title at high refresh rates.",
    pros: ["RTX 4080 performance", "Clean serviceable chassis", "Liquid cooling included"],
    cons: ["Premium price", "Proprietary motherboard"],
    isEditorsPick: false,
    helpfulScore: 14,
  },
];

export function seedReviews(db: DatabaseType): void {
  db.prepare(
    `INSERT OR IGNORE INTO "AuthUsers" (id, email, role, displayName, createdAt, updatedAt)
     VALUES (?, ?, 'user', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(SEED_AUTHOR_ID, "reviews@mgpl.local", "MGPL Community");

  const insert = db.prepare(`
    INSERT OR IGNORE INTO device_reviews
      (deviceId, userId, rating, title, body, prosJson, consJson, isEditorsPick, helpfulScore, isVerifiedOwner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const review of SEED_REVIEWS) {
      insert.run(
        review.deviceId,
        SEED_AUTHOR_ID,
        review.rating,
        review.title,
        review.body,
        JSON.stringify(review.pros),
        JSON.stringify(review.cons),
        review.isEditorsPick ? 1 : 0,
        review.helpfulScore,
        0,
      );
    }
  });

  tx();
}

/**
 * Deterministic 12-month price history for every catalog device.
 *
 * Each device gets 12 monthly points per retailer (Amazon, Best Buy, Newegg).
 * Prices are derived deterministically from the device MSRP with a small
 * per-retailer and per-month variation so the SVG sparkline is non-flat and the
 * "Best Time to Buy" classifier always finds a meaningful low. The series
 * anchors to a fixed end month (the seed is fully deterministic across runs).
 */
const RETAILERS = ["Amazon", "Best Buy", "Newegg"];

function monthlyPrice(msrp: number, retailerIndex: number, monthIndex: number): number {
  // Fixed pseudo-random phase per retailer keeps values stable and reproducible.
  const retailerOffset = [0, -0.035, 0.02][retailerIndex] || 0;
  const seasonal = Math.sin((monthIndex / 12) * Math.PI * 2 + retailerIndex) * 0.04;
  const drift = ((monthIndex - 5) / 12) * 0.015;
  const price = msrp * (1 + retailerOffset + seasonal + drift);
  return Math.round(price * 100) / 100;
}

export function seedHardwarePriceHistory(db: DatabaseType): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO hardware_price_history
      (deviceId, componentId, retailer, priceUsd, condition, recordedAt)
    VALUES (?, NULL, ?, ?, 'new', ?)
  `);
  // Sprint 5 (EPICUX05): component-level price series so the Comparison Tool's
  // Price History tab shows real trend indicators for GPU/CPU candidates.
  const insertComponent = db.prepare(`
    INSERT OR IGNORE INTO hardware_price_history
      (deviceId, componentId, retailer, priceUsd, condition, recordedAt)
    VALUES (NULL, ?, ?, ?, 'new', ?)
  `);
  const COMPONENT_MSRP: Array<{ componentId: string; msrp: number }> = [
    { componentId: 'gpu-rtx-4070-super', msrp: 599.99 },
    { componentId: 'gpu-rtx-4080-super', msrp: 999.99 },
    { componentId: 'gpu-rtx-4090', msrp: 1599.99 },
    { componentId: 'gpu-rx-7800-xt', msrp: 499.99 },
    { componentId: 'gpu-rx-7900-xtx', msrp: 949.99 },
    { componentId: 'cpu-r7-7800x3d', msrp: 389.99 },
    { componentId: 'cpu-i9-14900k', msrp: 539.99 },
  ];

  // End month anchored to the current year so charts always render a fresh
  // trailing 12-month window. Month keys use YYYY-MM format.
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1; // 1-12

  const tx = db.transaction(() => {
    for (const profile of HARDWARE_PROFILES) {
      const msrp = Number(profile.msrp) || 499.99;
      // Generate the 12 trailing months (oldest -> newest).
      for (let back = 11; back >= 0; back -= 1) {
        const absoluteMonth = endMonth - back;
        let year = endYear;
        let month = absoluteMonth;
        if (month <= 0) {
          month += 12;
          year -= 1;
        }
        const recordedAt = `${year}-${String(month).padStart(2, "0")}-01`;
        const monthIndex = 11 - back; // 0..11 oldest-to-newest
        RETAILERS.forEach((retailer, retailerIndex) => {
          insert.run(
            profile.id,
            retailer,
            monthlyPrice(msrp, retailerIndex, monthIndex),
            recordedAt,
          );
        });
      }
    }

    for (const comp of COMPONENT_MSRP) {
      for (let back = 11; back >= 0; back -= 1) {
        const absoluteMonth = endMonth - back;
        let year = endYear;
        let month = absoluteMonth;
        if (month <= 0) {
          month += 12;
          year -= 1;
        }
        const recordedAt = `${year}-${String(month).padStart(2, "0")}-01`;
        const monthIndex = 11 - back;
        RETAILERS.forEach((retailer, retailerIndex) => {
          insertComponent.run(
            comp.componentId,
            retailer,
            monthlyPrice(comp.msrp, retailerIndex, monthIndex),
            recordedAt,
          );
        });
      }
    }
  });

  tx();
}