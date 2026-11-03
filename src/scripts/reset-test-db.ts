import path from "path";
import {
  defaultTestDbPath,
  ensureSafeDbPath,
  resetDatabaseFile,
} from "./schema-tools/schemaTooling";

function main(): void {
  const target = path.resolve(process.argv[2] ?? process.env.DB_PATH ?? defaultTestDbPath());
  ensureSafeDbPath(target);
  resetDatabaseFile(target);
  console.log(`Reset test database files: ${target}`);
}

main();
