import path from "path";
import {
  actualSchema,
  canonicalSchema,
  defaultDevDbPath,
  foreignKeyViolations,
  integrityCheck,
} from "./schema-tools/schemaTooling";

function main(): void {
  const target = path.resolve(process.argv[2] ?? process.env.DB_PATH ?? defaultDevDbPath());
  const canonical = canonicalSchema();
  const actual = actualSchema(target);
  const violations: string[] = [];

  for (const [tableName, table] of canonical.tables) {
    const actualTable = actual.get(tableName);
    if (!actualTable) {
      violations.push(`[DESTRUCTIVE_TABLE_MISSING] ${tableName}`);
      continue;
    }

    for (const column of table.columns) {
      const actualColumn = actualTable.columns.find((entry) => entry.name === column.name);
      if (!actualColumn) {
        violations.push(`[DESTRUCTIVE_COLUMN_MISSING] ${tableName}.${column.name}`);
        continue;
      }

      const actualType = (actualColumn.type || "TEXT").toUpperCase();
      if (column.type && actualType !== column.type) {
        violations.push(
          `[DESTRUCTIVE_TYPE_CHANGE] ${tableName}.${column.name}: canonical=${column.type} actual=${actualType}`,
        );
      }
    }

    for (const fk of table.foreignKeys) {
      const fkMatch = actualTable.foreignKeys.find(
        (entry) =>
          entry.table === fk.referencedTable &&
          entry.from === fk.columns[0] &&
          entry.to === fk.referencedColumns[0],
      );
      if (!fkMatch) {
        violations.push(
          `[FK_MISSING] ${tableName}.${fk.columns.join(",")}: references ${fk.referencedTable}(${fk.referencedColumns.join(",")})`,
        );
      }
    }
  }

  for (const [tableName, actualTable] of actual) {
    const canonicalTable = canonical.tables.get(tableName);
    if (!canonicalTable) {
      continue;
    }
    for (const actualColumn of actualTable.columns) {
      const canonicalColumn = canonicalTable.columns.find(
        (entry) => entry.name === actualColumn.name,
      );
      if (!canonicalColumn) {
        continue;
      }
      if (!canonicalColumn.nullable && actualColumn.notnull === 0 && !canonicalColumn.hasDefault) {
        violations.push(`[NULLABILITY_REGRESSION] ${tableName}.${actualColumn.name}`);
      }
    }
  }

  const integrity = integrityCheck(target);
  if (!(integrity.length === 1 && integrity[0] === "ok")) {
    violations.push(`[INTEGRITY] ${integrity.join(", ")}`);
  }

  const fkViolations = foreignKeyViolations(target);
  if (fkViolations.length > 0) {
    violations.push(`[FK_VIOLATIONS] ${JSON.stringify(fkViolations)}`);
  }

  console.log(`Migration validator target: ${target}`);
  if (violations.length === 0) {
    console.log("Migration validator passed: database state is additive-only and integrity-clean.");
    return;
  }

  console.log("Migration validator failed:");
  for (const violation of violations) {
    console.log(` - ${violation}`);
  }
  process.exitCode = 1;
}

main();
