import fs from "fs";
import path from "path";
import Database, { type Database as DatabaseType } from "better-sqlite3";

export type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

export type ForeignKeyInfo = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
};

export type ActualTable = {
  name: string;
  sql: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
};

export type CanonicalTable = {
  name: string;
  sql: string;
  columns: CanonicalColumn[];
  foreignKeys: CanonicalForeignKey[];
};

export type CanonicalColumn = {
  name: string;
  type: string;
  raw: string;
  nullable: boolean;
  primaryKey: boolean;
  hasDefault: boolean;
};

export type CanonicalForeignKey = {
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
};

export type SchemaSnapshot = {
  tables: Map<string, CanonicalTable>;
  indexes: string[];
  triggers: string[];
  ddl: string;
};

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DB_FILE_GUARD = /(prod|production)/i;

export function repoPath(...segments: string[]): string {
  return path.resolve(ROOT, ...segments);
}

export function defaultDevDbPath(): string {
  return repoPath("data", "dev_mgpl.db");
}

export function defaultTestDbPath(): string {
  return repoPath("data", "test_mgpl.db");
}

export function canonicalSchemaSource(): string {
  return fs.readFileSync(repoPath("src", "db.ts"), "utf8");
}

export function canonicalSchema(): SchemaSnapshot {
  const source = canonicalSchemaSource();
  const ddlBlockMatch = source.match(/db\.exec\(`([\s\S]*?)`\);/);
  if (!ddlBlockMatch) {
    throw new Error("Unable to locate canonical db.exec DDL block in src/db.ts");
  }

  const ddl = ddlBlockMatch[1];
  const tableRegex = /CREATE TABLE IF NOT EXISTS\s+"?([A-Za-z0-9_ ]+)"?\s*\(([\s\S]*?)\);/g;
  const indexRegex = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+"?([A-Za-z0-9_]+)"?/g;
  const triggerRegex = /CREATE TRIGGER IF NOT EXISTS\s+"?([A-Za-z0-9_]+)"?/g;

  const tables = new Map<string, CanonicalTable>();
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(ddl)) !== null) {
    const name = tableMatch[1].trim();
    const sql = tableMatch[0].trim();
    const body = tableMatch[2];
    const definitions = splitSqlDefinitions(body);
    const columns: CanonicalColumn[] = [];
    const foreignKeys: CanonicalForeignKey[] = [];

    for (const def of definitions) {
      const trimmed = def.trim();
      if (!trimmed) {
        continue;
      }
      if (/^FOREIGN KEY\s*\(/i.test(trimmed)) {
        const fk = parseCanonicalForeignKey(trimmed);
        if (fk) {
          foreignKeys.push(fk);
        }
        continue;
      }
      if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK)/i.test(trimmed)) {
        continue;
      }
      const column = parseCanonicalColumn(trimmed);
      if (column) {
        columns.push(column);
      }
    }

    tables.set(name, { name, sql, columns, foreignKeys });
  }

  const indexes = [...ddl.matchAll(indexRegex)].map((match) => match[1]);
  const triggers = [...ddl.matchAll(triggerRegex)].map((match) => match[1]);
  return { tables, indexes, triggers, ddl };
}

export function openDatabase(dbPath: string, readonly = true): DatabaseType {
  return new Database(dbPath, readonly ? { readonly: true } : undefined);
}

export function actualSchema(dbPath: string): Map<string, ActualTable> {
  const db = openDatabase(dbPath, true);
  try {
    const rows = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string | null }>;

    const tables = new Map<string, ActualTable>();
    for (const row of rows) {
      const columns = db
        .prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`)
        .all() as ColumnInfo[];
      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(row.name)})`)
        .all() as ForeignKeyInfo[];
      tables.set(row.name, {
        name: row.name,
        sql: row.sql ?? "",
        columns,
        foreignKeys,
      });
    }
    return tables;
  } finally {
    db.close();
  }
}

export function sqliteObjects(dbPath: string, type: "index" | "trigger"): string[] {
  const db = openDatabase(dbPath, true);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(type) as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

export function foreignKeyViolations(dbPath: string): Array<Record<string, unknown>> {
  const db = openDatabase(dbPath, true);
  try {
    return db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

export function integrityCheck(dbPath: string): string[] {
  const db = openDatabase(dbPath, true);
  try {
    return (db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map(
      (row) => row.integrity_check,
    );
  } finally {
    db.close();
  }
}

export function ensureSafeDbPath(dbPath: string): void {
  const normalized = path.resolve(dbPath);
  if (DB_FILE_GUARD.test(normalized)) {
    throw new Error(`Refusing to operate on production-like database path: ${normalized}`);
  }
}

export function resetDatabaseFile(dbPath: string): void {
  ensureSafeDbPath(dbPath);
  const normalized = path.resolve(dbPath);
  const dir = path.dirname(normalized);
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ["-wal", "-shm", ""]) {
    const file = `${normalized}${suffix}`;
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wrappedError = new Error(
        `Unable to remove ${file}. Close any process using the database and retry. ${message}`,
      );
      Object.assign(wrappedError, { cause: error });
      throw wrappedError;
    }
  }
}

export function bootstrapDatabase(dbPath: string): void {
  ensureSafeDbPath(dbPath);
  const normalized = path.resolve(dbPath);
  const dir = path.dirname(normalized);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(normalized);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");
    db.pragma("foreign_keys = ON");
    db.exec(canonicalSchema().ddl);
  } finally {
    db.close();
  }
}

export function splitSqlDefinitions(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let inSingleQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "'" && input[i - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
    }
    if (!inSingleQuote) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        result.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) {
    result.push(current);
  }
  return result;
}

function parseCanonicalColumn(definition: string): CanonicalColumn | null {
  const match = definition.match(/^("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const name = unquoteIdentifier(match[1]);
  const remainder = match[2].trim();
  const tokens = remainder.split(/\s+/);
  const typeTokens: string[] = [];
  for (const token of tokens) {
    if (
      /^(PRIMARY|NOT|DEFAULT|CHECK|UNIQUE|REFERENCES|COLLATE|CONSTRAINT|GENERATED|AS)$/i.test(token)
    ) {
      break;
    }
    typeTokens.push(token);
  }
  return {
    name,
    type: typeTokens.join(" ").trim().toUpperCase(),
    raw: definition,
    nullable: !/NOT NULL/i.test(remainder),
    primaryKey: /PRIMARY KEY/i.test(remainder),
    hasDefault: /DEFAULT/i.test(remainder),
  };
}

function parseCanonicalForeignKey(definition: string): CanonicalForeignKey | null {
  const match = definition.match(
    /^FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+"?([A-Za-z0-9_ ]+)"?\s*\(([^)]+)\)(.*)$/i,
  );
  if (!match) {
    return null;
  }
  const trailing = match[4] ?? "";
  const onDelete =
    trailing.match(/ON DELETE\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i)?.[1] ?? null;
  const onUpdate =
    trailing.match(/ON UPDATE\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i)?.[1] ?? null;
  return {
    columns: splitIdentifiers(match[1]),
    referencedTable: match[2].trim(),
    referencedColumns: splitIdentifiers(match[3]),
    onDelete,
    onUpdate,
  };
}

function splitIdentifiers(value: string): string[] {
  return value
    .split(",")
    .map((entry) => unquoteIdentifier(entry.trim()))
    .filter(Boolean);
}

function unquoteIdentifier(value: string): string {
  return value.replace(/^['"`[]/, "").replace(/['"`\]]$/, "");
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
