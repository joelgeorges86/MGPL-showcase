import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promoteReviewedEnrichmentRun } from "../../src/services/enrichmentPromotion";
import { isCanonicalEnrichmentResponse } from "../../src/services/enrichmentSchema";

function authoritativeTableDdl(tableName: "AppGames" | "AppGames_Staging") {
  const dbSource = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");
  const statement = dbSource.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n    \\);`),
  )?.[0];
  if (!statement) throw new Error(`Could not find ${tableName} DDL in src/db.ts`);
  return statement;
}

function fixtureDb() {
  const db = new Database(":memory:");
  db.exec(`
    ${authoritativeTableDdl("AppGames")}
    ${authoritativeTableDdl("AppGames_Staging")}
    INSERT INTO AppGames ("GameID", "Game Title", publisher, originalGameReleaseDate, enrichmentConfidence)
      VALUES ('g1', 'Old', 'Verified Publisher', '1999-01-01', 0.7);
    INSERT INTO AppGames_Staging
      (staging_id, run_id, model_id, source, fetched_at, game_id, title, publisher, original_game_release_date, confidence_score)
      VALUES ('s1', 'run-1', 'model-1', 'source-1', '2026-09-23T00:00:00.000Z', 'g1', 'New', 'Pub', '2020-01-01', 0.9);
  `);
  return db;
}

const marker = {
  runId: "run-1" as const,
  source: "live-source-count-regeneration" as const,
  status: "complete" as const,
  generatedAt: "2026-09-22T00:00:00.000Z",
  counts: { sourceCount: 1, stagingCount: 1 },
};

describe("G-2 reviewed promotion guard", () => {
  it("blocks missing marker, mismatched run, and missing review", () => {
    const db = fixtureDb();
    expect(() =>
      promoteReviewedEnrichmentRun(db, {
        runId: "run-1",
        reviewConfirmed: true,
        ai014Marker: null,
      }),
    ).toThrow("AI-014");
    expect(() =>
      promoteReviewedEnrichmentRun(db, {
        runId: "run-1",
        reviewConfirmed: false,
        ai014Marker: marker,
      }),
    ).toThrow("review");
    expect(() =>
      promoteReviewedEnrichmentRun(db, {
        runId: "run-2",
        reviewConfirmed: true,
        ai014Marker: marker,
      }),
    ).toThrow("runId");
    db.close();
  });

  it("promotes one explicitly reviewed run in a transaction", () => {
    const db = fixtureDb();
    expect(
      promoteReviewedEnrichmentRun(db, {
        runId: "run-1",
        reviewConfirmed: true,
        ai014Marker: marker,
      }),
    ).toEqual({ runId: "run-1", matchedRows: 1 });
    expect(db.prepare('SELECT * FROM AppGames WHERE "GameID" = ?').get("g1")).toMatchObject({
      "Game Title": "New",
      publisher: "Pub",
      enrichmentStatus: "reviewed",
    });
    db.close();
  });

  it("promotes a genuine canonical enrichment value without altering it", () => {
    const db = fixtureDb();
    const enrichment = {
      title: "Genuine Enriched Game",
      confidenceScore: 0.94,
      publisher: "Verified Publisher",
      releaseDate: "2020-01-01",
    };
    expect(isCanonicalEnrichmentResponse(enrichment)).toBe(true);
    db.prepare(
      `UPDATE AppGames_Staging
       SET title = ?, publisher = ?, original_game_release_date = ?, confidence_score = ?
       WHERE run_id = ?`,
    ).run(
      enrichment.title,
      enrichment.publisher,
      enrichment.releaseDate,
      enrichment.confidenceScore,
      "run-1",
    );

    const result = promoteReviewedEnrichmentRun(db, {
      runId: "run-1",
      reviewConfirmed: true,
      ai014Marker: marker,
    });

    expect(result).toEqual({ runId: "run-1", matchedRows: 1 });
    expect(
      db
        .prepare(
          'SELECT "Game Title", publisher, originalGameReleaseDate, enrichmentConfidence FROM AppGames WHERE "GameID" = ?',
        )
        .get("g1"),
    ).toEqual({
      "Game Title": enrichment.title,
      publisher: enrichment.publisher,
      originalGameReleaseDate: enrichment.releaseDate,
      enrichmentConfidence: enrichment.confidenceScore,
    });
    db.close();
  });

  it("preserves verified values when staging leaves nullable fields unenriched", () => {
    const db = fixtureDb();
    db.prepare(
      `UPDATE AppGames_Staging
       SET publisher = NULL, original_game_release_date = NULL
       WHERE run_id = ?`,
    ).run("run-1");

    const result = promoteReviewedEnrichmentRun(db, {
      runId: "run-1",
      reviewConfirmed: true,
      ai014Marker: marker,
    });

    expect(result).toEqual({ runId: "run-1", matchedRows: 1 });
    expect(
      db
        .prepare('SELECT publisher, originalGameReleaseDate FROM AppGames WHERE "GameID" = ?')
        .get("g1"),
    ).toEqual({
      publisher: "Verified Publisher",
      originalGameReleaseDate: "1999-01-01",
    });
    db.close();
  });

  it("rejects a staging game that has no AppGames target", () => {
    const db = fixtureDb();
    db.prepare(
      `INSERT INTO AppGames_Staging
       (staging_id, run_id, model_id, source, fetched_at, game_id, title, confidence_score)
       VALUES ('s2', 'run-1', 'model-1', 'source-1', '2026-09-23T00:00:00.000Z', 'missing', 'Missing', 0.8)`,
    ).run();

    expect(() =>
      promoteReviewedEnrichmentRun(db, {
        runId: "run-1",
        reviewConfirmed: true,
        ai014Marker: marker,
      }),
    ).toThrow("AppGames row not found");
    expect(
      db.prepare('SELECT enrichmentStatus FROM AppGames WHERE "GameID" = ?').get("g1"),
    ).toEqual({
      enrichmentStatus: null,
    });
    db.close();
  });
});
