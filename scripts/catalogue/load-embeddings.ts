// #158 / WU-032b: The explicit, reviewed command that loads reference catalogue embeddings
// into SQLite for semantic similarity search ("games like X").
//
//   npx tsx scripts/catalogue/load-embeddings.ts --db <path> --in <embeddings.jsonl> --review-confirmed true
//
// The database path must point to an existing SQLite database. This command never creates a missing
// database, never seeds one, and never performs network or billed API calls.
// It prints aggregate counts and durations only, never titles, descriptions, vectors or secret payloads.
// cspell:words jsonl
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CatalogueEmbeddingsError,
  loadCatalogueEmbeddings,
  type LoadEmbeddingsResult,
} from "../../src/services/catalogueSimilarity";

export const USAGE =
  "usage: load-embeddings.ts --db <database.db> --in <embeddings.jsonl> --review-confirmed true";

export interface ParsedArgs {
  dbPath: string;
  inputFile: string;
  reviewConfirmed: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new CatalogueEmbeddingsError(USAGE, "INVALID_ARGS");
    }
    if (key in opts) {
      throw new CatalogueEmbeddingsError(`${key} is specified more than once`, "DUPLICATE_ARG");
    }
    opts[key] = value;
  }

  const allowed = ["--db", "--in", "--review-confirmed"];
  for (const k of Object.keys(opts)) {
    if (!allowed.includes(k)) {
      throw new CatalogueEmbeddingsError(`${k} is not a recognized option`, "UNRECOGNIZED_ARG");
    }
  }

  const dbPath = opts["--db"];
  if (!dbPath) throw new CatalogueEmbeddingsError("--db <database.db> is required", "MISSING_ARG");

  const inputFile = opts["--in"];
  if (!inputFile)
    throw new CatalogueEmbeddingsError("--in <file.jsonl> is required", "MISSING_ARG");

  if (opts["--review-confirmed"] !== "true") {
    throw new CatalogueEmbeddingsError(
      "--review-confirmed true is required for loading embeddings",
      "REVIEW_CONFIRMATION_REQUIRED",
    );
  }

  return { dbPath, inputFile, reviewConfirmed: true };
}

export async function main(
  argv: string[],
  deps: {
    openDb?: (path: string) => DatabaseType;
    log?: (line: string) => void;
    now?: Date;
  } = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { dbPath, inputFile, reviewConfirmed } = parseArgs(argv);

  if (!existsSync(dbPath)) {
    throw new CatalogueEmbeddingsError(
      `Database file does not exist: ${dbPath}. This command will not create a database.`,
      "DATABASE_NOT_FOUND",
    );
  }

  if (!existsSync(inputFile)) {
    throw new CatalogueEmbeddingsError(
      `Input embeddings file does not exist: ${inputFile}`,
      "INPUT_FILE_NOT_FOUND",
    );
  }

  const openDb =
    deps.openDb ??
    ((p: string) => {
      const db = new Database(p, { fileMustExist: true });
      db.pragma("foreign_keys = ON");
      return db;
    });

  const db = openDb(dbPath);
  let result: LoadEmbeddingsResult;
  try {
    result = await loadCatalogueEmbeddings(db, {
      inputFile,
      reviewConfirmed,
      now: deps.now,
    });
  } finally {
    db.close();
  }

  log(
    `Catalogue embeddings import completed: ${result.loaded} loaded, ` +
      `${result.duplicates_skipped} duplicates skipped ` +
      `(${result.processed} processed in ${result.duration_ms}ms).`,
  );
  return 0;
}

export async function cli(
  argv: string[],
  logError = (msg: string) => console.error(msg),
): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`load-embeddings: ${message}`);
    return error instanceof CatalogueEmbeddingsError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
