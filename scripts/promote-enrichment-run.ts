import Database from "better-sqlite3";
import { readFileSync } from "fs";
import path from "path";
import {
  promoteReviewedEnrichmentRun,
  type Ai014Marker,
} from "../src/services/enrichmentPromotion";

// Explicit reviewed command only. Never invoke this from an enrichment run.
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const runId = args.get("--run-id");
const review = args.get("--review-confirmed") === "true";
if (!runId || !review) {
  throw new Error(
    "Usage: ts-node scripts/promote-enrichment-run.ts --run-id <run> --review-confirmed true",
  );
}

const markerPath = path.resolve(
  process.cwd(),
  "reports",
  "ai-014-count-regeneration",
  `${runId}.json`,
);
const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Ai014Marker;
const db = new Database(process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db"));
try {
  const result = promoteReviewedEnrichmentRun(db, {
    runId,
    reviewConfirmed: true,
    ai014Marker: marker,
  });
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
