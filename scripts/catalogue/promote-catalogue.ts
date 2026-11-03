// #158 / WU-033b (task proposal 033): the explicit, reviewed command that promotes the reference
// catalogue into the database the app uses. Never invoke this from an ingest or enrichment run.
//
//   npx tsx scripts/catalogue/promote-catalogue.ts facts \
//     --wikidata <wikidata.jsonl> --agreement <agreement.jsonl> --review-confirmed true
//   npx tsx scripts/catalogue/promote-catalogue.ts drafts --kind description \
//     --in <drafts.jsonl> [--in <more drafts.jsonl>] --summary <sample-....summary.json> \
//     --review-confirmed true
//
// The database is DB_PATH, or mpgl_app.db in the working directory. Its Catalogue* tables are
// created by src/db.ts when the app starts; this command never creates or changes a table.
// Agents run it only against a dev database and fixtures. Against production it is a production
// database write, reserved to the Principal Operator (AGENTS.md section 3.3).
//
// It prints counts only, never a title, fact or draft.
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CATALOGUE_KINDS,
  CataloguePromotionError,
  promoteCatalogueDrafts,
  promoteCatalogueFacts,
  type CatalogueKind,
} from "../../src/services/enrichmentPromotion";

export const TABLES = ["CatalogueGames", "CatalogueFacts", "CatalogueDrafts"] as const;
const USAGE =
  "usage: promote-catalogue.ts facts --wikidata <file> --agreement <file> --review-confirmed true\n" +
  "       promote-catalogue.ts drafts --kind <description|friction|genre> --in <file> [--in <file>] " +
  "--summary <file> --review-confirmed true";

export function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== "facts" && command !== "drafts") throw new CataloguePromotionError(USAGE);
  const opts: Record<string, string> = {};
  const inputs: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new CataloguePromotionError(USAGE);
    if (key === "--in") inputs.push(value);
    else if (key in opts) throw new CataloguePromotionError(`${key} is given twice`);
    else opts[key] = value;
  }
  const allowed =
    command === "facts"
      ? ["--wikidata", "--agreement", "--review-confirmed"]
      : ["--kind", "--summary", "--review-confirmed"];
  for (const k of Object.keys(opts))
    if (!allowed.includes(k))
      throw new CataloguePromotionError(`${k} is not an option of ${command}`);
  if (command === "facts" && inputs.length)
    throw new CataloguePromotionError("--in is not an option of facts");
  if (opts["--review-confirmed"] !== "true")
    throw new CataloguePromotionError("--review-confirmed true is required");
  return { command, opts, inputs };
}

function checkTables(db: DatabaseType) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const t of TABLES)
    if (!has.get(t))
      throw new CataloguePromotionError(
        `the database has no ${t} table; start the app once so src/db.ts creates it`,
      );
}

export function main(
  argv: string[],
  deps: { openDb?: () => DatabaseType; log?: (line: string) => void; now?: Date } = {},
) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { command, opts, inputs } = parseArgs(argv);
  const need = (k: string) => {
    const v = opts[k];
    if (!v) throw new CataloguePromotionError(`${k} is required`);
    return v;
  };
  let run: (db: DatabaseType) => unknown;
  if (command === "facts") {
    const wikidataFile = need("--wikidata");
    const agreementFile = need("--agreement");
    run = (db) =>
      promoteCatalogueFacts(db, {
        wikidataFile,
        agreementFile,
        reviewConfirmed: true,
        now: deps.now,
      });
  } else {
    const kind = need("--kind");
    if (!(CATALOGUE_KINDS as readonly string[]).includes(kind))
      throw new CataloguePromotionError(`--kind must be one of ${CATALOGUE_KINDS.join(", ")}`);
    const summaryFile = need("--summary");
    if (!inputs.length) throw new CataloguePromotionError("give at least one --in file");
    run = (db) =>
      promoteCatalogueDrafts(db, {
        kind: kind as CatalogueKind,
        draftFiles: inputs,
        summaryFile,
        reviewConfirmed: true,
        now: deps.now,
      });
  }
  const db =
    deps.openDb?.() ??
    new Database(process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db"), {
      fileMustExist: true,
    });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 10000");
    checkTables(db);
    const result = run(db);
    log(JSON.stringify(result));
    return result;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    console.error(
      e instanceof CataloguePromotionError
        ? e.message
        : `promotion failed${typeof code === "string" ? ` (${code})` : ""}; no transaction was committed`,
    );
    process.exitCode = 1;
  }
}
