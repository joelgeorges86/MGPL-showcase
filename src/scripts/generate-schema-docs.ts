import fs from "fs";
import { canonicalSchema, repoPath } from "./schema-tools/schemaTooling";

function main(): void {
  const schema = canonicalSchema();
  const lines: string[] = [];
  lines.push("# MGPL SQLite Schema");
  lines.push("");
  lines.push(`Generated on 2026-09-01 from \`src/db.ts\`.`);
  lines.push("");
  lines.push("## Mermaid ERD");
  lines.push("");
  lines.push("```mermaid");
  lines.push("erDiagram");

  for (const table of schema.tables.values()) {
    lines.push(`  ${sanitizeName(table.name)} {`);
    for (const column of table.columns) {
      const type = column.type || "TEXT";
      const pk = column.primaryKey ? " PK" : "";
      lines.push(`    ${type} ${sanitizeName(column.name)}${pk}`);
    }
    lines.push("  }");
  }

  const emittedRelations = new Set<string>();
  for (const table of schema.tables.values()) {
    for (const fk of table.foreignKeys) {
      const relation = `${sanitizeName(fk.referencedTable)} ||--o{ ${sanitizeName(table.name)} : references`;
      if (!emittedRelations.has(relation)) {
        emittedRelations.add(relation);
        lines.push(relation);
      }
    }
  }

  lines.push("```");
  lines.push("");
  lines.push("## Tables");
  lines.push("");
  for (const table of schema.tables.values()) {
    lines.push(`### ${table.name}`);
    lines.push("");
    lines.push("| Column | Type | Nullable | PK | Default |\n|---|---|---|---|---|");
    for (const column of table.columns) {
      lines.push(
        `| ${column.name} | ${column.type || "TEXT"} | ${column.nullable ? "Yes" : "No"} | ${column.primaryKey ? "Yes" : "No"} | ${column.hasDefault ? "Yes" : "No"} |`,
      );
    }
    if (table.foreignKeys.length > 0) {
      lines.push("");
      lines.push("Foreign keys:");
      for (const fk of table.foreignKeys) {
        lines.push(
          `- (${fk.columns.join(", ")}) -> ${fk.referencedTable}(${fk.referencedColumns.join(", ")})` +
            `${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ""}` +
            `${fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : ""}`,
        );
      }
    }
    lines.push("");
  }

  const output = repoPath("DOCS", "SCHEMA.md");
  fs.writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
  console.log(`Generated ${output}`);
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

main();
