import { test, expect } from "../fixtures";
import Database from "better-sqlite3";
import path from "path";

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");
const USER = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

const IDS = {
  real: "ai069-real-history",
  synthetic: "ai069-synthetic-history",
  missing: "ai069-missing-history",
  stale: "ai069-stale-history",
};

// Dates are relative to the day the suite runs. The history contract marks
// observed prices older than HISTORY_FRESHNESS_BOUND_DAYS (30) as stale, so a
// fixed date here would make the "real" case turn "stale" a month later.
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function withDb<T>(callback: (db: Database.Database) => T): T {
  const db = new Database(TEST_DB_PATH);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function seedHistory(gameId: string, store: string, price: number, recordedAt: string): void {
  withDb((db) => {
    db.prepare("DELETE FROM AppDealPriceHistory WHERE gameId = ?").run(gameId);
    db.prepare(
      "INSERT INTO AppDealPriceHistory (gameId, title, store, price, recordedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(gameId, gameId, store, price, recordedAt);
  });
}

test.describe("AI-069 real wishlist pricing and history contract", () => {
  test.beforeEach(async ({ page }) => {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: USER });
    expect(login.status()).toBe(200);
    withDb((db) => {
      for (const gameId of Object.values(IDS)) {
        db.prepare("DELETE FROM AppDealPriceHistory WHERE gameId = ?").run(gameId);
        db.prepare(
          "DELETE FROM AppWishlist WHERE userId = (SELECT id FROM AuthUsers WHERE email = ?) AND gameId = ?",
        ).run(USER.email, gameId);
      }
    });
  });

  test("returns observed prices and explicit unavailable stores without synthetic values", async ({
    page,
  }) => {
    const observedOn = daysAgo(2);
    seedHistory(IDS.real, "Steam", 19.99, observedOn);
    await page.request.post(`${BASE}/api/wishlist`, {
      data: { gameId: IDS.real, title: "AI-069 Real Game", targetPrice: 20 },
    });

    const response = await page.request.get(`${BASE}/api/wishlist/compare/${IDS.real}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.historyAvailability).toBe("real");
    expect(body.historicalLow).toBe(19.99);
    expect(body.historicalLowPeriod).toEqual({ from: observedOn, to: observedOn });
    const steam = body.storeComparisons.find((offer: any) => offer.storeName === "Steam");
    const gog = body.storeComparisons.find((offer: any) => offer.storeName === "GOG");
    expect(steam).toMatchObject({
      currentPrice: 19.99,
      availability: "real",
      source: "AppDealPriceHistory",
    });
    expect(gog).toMatchObject({ currentPrice: null, availability: "unavailable" });
  });

  test("distinguishes synthetic-only, missing, and stale history", async ({ request }) => {
    seedHistory(IDS.synthetic, "Synthesis", 8.99, daysAgo(30));
    seedHistory(IDS.stale, "Steam", 12.99, daysAgo(90));

    const synthetic = await request.get(`${BASE}/api/deals/history/${IDS.synthetic}`);
    const missing = await request.get(`${BASE}/api/deals/history/${IDS.missing}`);
    const stale = await request.get(`${BASE}/api/deals/history/${IDS.stale}`);

    const syntheticBody = await synthetic.json();
    const missingBody = await missing.json();
    expect(syntheticBody.availability).toBe("synthetic-only");
    expect(syntheticBody.points).toEqual([]);
    expect(missingBody.availability).toBe("missing");
    expect(missingBody.points).toEqual([]);
    const staleBody = await stale.json();
    expect(staleBody.availability).toBe("stale");
    expect(staleBody.points).toHaveLength(1);
    expect(staleBody.historicalLow).toBe(12.99);
  });
});
