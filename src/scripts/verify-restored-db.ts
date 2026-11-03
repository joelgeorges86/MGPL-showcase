import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { assertIsolatedRestoreTarget } from "../utils/recoveryValidation";

const REQUIRED_TABLES = [
  "AppGames",
  "AuthUsers",
  "AppOwnership",
  "AppTracking",
  "AppWishlist",
  "AppFriendships",
  "AppGameTags",
  "AppGameNotes",
  "AppBacklog",
  "AppPlaySessions",
];

function main(): void {
  const requested = process.argv[2] ?? process.env.DB_PATH;
  if (!requested)
    throw new Error("Provide a restored database path as the first argument or DB_PATH.");
  const databasePath = assertIsolatedRestoreTarget(requested);
  if (!fs.existsSync(databasePath)) throw new Error(`Restored database not found: ${databasePath}`);

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeyRows = database.pragma("foreign_key_check") as unknown[];
    const existingTables = new Set(
      (
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));
    const rowCounts = Object.fromEntries(
      REQUIRED_TABLES.filter((table) => existingTables.has(table)).map((table) => {
        const escaped = table.replace(/"/g, '""');
        const row = database.prepare(`SELECT COUNT(*) AS count FROM "${escaped}"`).get() as {
          count: number;
        };
        return [table, row.count];
      }),
    );
    const integrity = integrityRows.length === 1 && integrityRows[0]?.integrity_check === "ok";
    const passed = integrity && foreignKeyRows.length === 0 && missingTables.length === 0;
    console.log(
      JSON.stringify({
        passed,
        databasePath: path.normalize(databasePath),
        bytes: fs.statSync(databasePath).size,
        integrityCheck: integrity ? "ok" : integrityRows,
        foreignKeyViolations: foreignKeyRows.length,
        missingTables,
        rowCounts,
        verifiedAt: new Date().toISOString(),
      }),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Restore verification failed.");
  process.exitCode = 1;
}
