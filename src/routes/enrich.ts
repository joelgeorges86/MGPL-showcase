import { Router } from "express";
import { HowLongToBeatService, HowLongToBeatEntry } from "howlongtobeat";
import { Database as DatabaseType } from "better-sqlite3";
import { openDatabase } from "../lib/dbHandles";
import path from "path";
import { sendApiError } from "../middleware/errorSanitizer";

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const dbWrite: DatabaseType = openDatabase(dbPath);
const hltbService = new HowLongToBeatService();

const router = Router();

function ensureHltbColumn() {
  try {
    const info = dbWrite.prepare('PRAGMA table_info("AppGames")').all() as any[];
    const hasColumn = info.some((c) => c.name === "hltbMainHours");
    if (!hasColumn) {
      dbWrite.prepare('ALTER TABLE "AppGames" ADD COLUMN "hltbMainHours" REAL').run();
    }
  } catch (e) {
    console.error("Failed to ensure hltbMainHours column:", e);
  }
}

router.post("/hltb", async (req, res) => {
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  try {
    ensureHltbColumn();

    const results = await hltbService.search(title);

    if (!results || results.length === 0) {
      return res.json({ success: false, message: "No results found on HLTB" });
    }

    // Pick the first result as the best match
    const bestMatch: HowLongToBeatEntry = results[0];
    const mainHours = bestMatch.gameplayMain;

    // Update the database
    const updateResult = dbWrite
      .prepare(
        `
      UPDATE "AppGames"
      SET "hltbMainHours" = ?
      WHERE "Game Title" = ?
    `,
      )
      .run(mainHours, title);

    if (updateResult.changes === 0) {
      return res.json({
        success: false,
        message: "Game title not found in database",
        hltbResult: { title: bestMatch.name, mainHours },
      });
    }

    res.json({
      success: true,
      game: title,
      mainHours: mainHours,
    });
  } catch (error) {
    console.error("HLTB enrichment error:", error);
    sendApiError(res, 500, "Failed to enrich game data", undefined, { includeSuccess: false });
  }
});

export default router;
