import path from "path";
import {
  actualSchema,
  canonicalSchema,
  defaultDevDbPath,
  foreignKeyViolations,
  integrityCheck,
  sqliteObjects,
} from "./schema-tools/schemaTooling";

function main(): void {
  const target = path.resolve(process.argv[2] ?? process.env.DB_PATH ?? defaultDevDbPath());
  const canonical = canonicalSchema();
  const actual = actualSchema(target);
  const actualIndexes = new Set(sqliteObjects(target, "index"));
  const actualTriggers = new Set(sqliteObjects(target, "trigger"));
  const issues: string[] = [];

  for (const [tableName, table] of canonical.tables) {
    const actualTable = actual.get(tableName);
    if (!actualTable) {
      issues.push(`[MISSING_TABLE] ${tableName}`);
      continue;
    }
    for (const column of table.columns) {
      const actualColumn = actualTable.columns.find((entry) => entry.name === column.name);
      if (!actualColumn) {
        issues.push(`[MISSING_COLUMN] ${tableName}.${column.name}`);
        continue;
      }
      const actualType = (actualColumn.type || "TEXT").toUpperCase();
      if (column.type && actualType !== column.type) {
        issues.push(
          `[TYPE_MISMATCH] ${tableName}.${column.name}: canonical=${column.type} actual=${actualType}`,
        );
      }
    }
  }

  for (const tableName of actual.keys()) {
    if (!canonical.tables.has(tableName)) {
      issues.push(`[EXTRA_TABLE] ${tableName}`);
    }
  }

  for (const indexName of canonical.indexes) {
    if (!actualIndexes.has(indexName)) {
      issues.push(`[MISSING_INDEX] ${indexName}`);
    }
  }

  for (const triggerName of canonical.triggers) {
    if (!actualTriggers.has(triggerName)) {
      issues.push(`[MISSING_TRIGGER] ${triggerName}`);
    }
  }

  const fkViolations = foreignKeyViolations(target);
  if (fkViolations.length > 0) {
    issues.push(`[FK_VIOLATIONS] ${JSON.stringify(fkViolations)}`);
  }

  const integrity = integrityCheck(target);
  if (!(integrity.length === 1 && integrity[0] === "ok")) {
    issues.push(`[INTEGRITY] ${integrity.join(", ")}`);
  }

  console.log(`Schema diff target: ${target}`);
  if (issues.length === 0) {
    console.log("Schema diff clean: canonical schema matches database state.");
    return;
  }

  console.log("Schema drift detected:");
  for (const issue of issues) {
    console.log(` - ${issue}`);
  }
  process.exitCode = 1;
}

main();
