// Explicit offline mobile development copy tool. Never opens application default database.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface MobileDevCopyReceipt {
  schema: "mgpl-mobile-devcopy-receipt/1";
  from: string;
  from_sha256: string;
  from_wal_sha256: string | null;
  from_unchanged: true;
  to: string;
  to_sha256: string;
  integrity: "ok";
  mobile_tables_present: string[];
  mobile_row_counts: Record<string, number>;
  dpx_row_counts: Record<string, number>;
  copied_at: string;
}

class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

function landingPath(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

let cachedRepoRoot: string | null = null;
function getRepoRoot(): string {
  if (!cachedRepoRoot) {
    cachedRepoRoot = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  }
  return cachedRepoRoot;
}

function assertOutsideRepo(targetPath: string, label: string): void {
  const lp = landingPath(targetPath);
  const rel = path.relative(getRepoRoot(), lp);
  if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
    refuse(`${label} must be outside the repository`);
  }
}
import { createHash } from "node:crypto";

export interface MobileStateHash {
  schema: "mgpl-mobile-state-hash/1";
  mobile_tables: Record<string, { rows: number; raw_sha256: string }>;
  mobile_normalized_sha256: string;
  other_tables_sha256: string;
  schema_sha256: string;
}

export const MOBILE_STAGING_TABLES = [
  "mobile_import_batches",
  "mobile_sources",
  "mobile_device_families",
  "mobile_hardware_references",
  "mobile_device_variants",
  "mobile_variant_sightings",
  "mobile_observations",
  "mobile_listing_observations",
] as const;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function canonicalJson(val: unknown): string {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (!Number.isFinite(val)) throw new Error("unsupported_state_value: non_finite_real");
    return JSON.stringify(val);
  }
  if (typeof val === "string") return JSON.stringify(val);
  if (Array.isArray(val)) {
    return "[" + val.map(canonicalJson).join(",") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJson((val as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(`unsupported_state_value: unsupported_type_${typeof val}`);
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function validateAndDecodeUtf8(buf: Buffer | Uint8Array): string {
  try {
    return utf8Decoder.decode(buf);
  } catch {
    throw new Error("unsupported_state_value: malformed_utf8_text");
  }
}

type EncodedValue = null | string | { $blob: string } | { $int: number } | { $real: number };
type EncodedRow = Record<string, EncodedValue>;

function encodeColumnValue(t: string, b: Buffer | null, v: unknown): EncodedValue {
  if (t === "null") return null;
  if (t === "text") {
    if (!b) return "";
    return validateAndDecodeUtf8(b);
  }
  if (t === "blob") {
    if (!b) return { $blob: "" };
    return { $blob: b.toString("hex") };
  }
  if (t === "integer") {
    if (typeof v !== "bigint" && typeof v !== "number")
      throw new Error("unsupported_state_value: invalid_integer_storage");
    const bi = typeof v === "bigint" ? v : BigInt(v);
    if (bi < -9007199254740991n || bi > 9007199254740991n) {
      throw new Error("unsupported_state_value: integer_out_of_range");
    }
    return { $int: Number(bi) };
  }
  if (t === "real") {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("unsupported_state_value: non_finite_real");
    }
    return { $real: v };
  }
  throw new Error(`unsupported_state_value: unknown_storage_class_${t}`);
}

function extractTableRows(db: Database.Database, tableName: string): EncodedRow[] {
  const tableList = db.prepare("PRAGMA table_list;").safeIntegers(true).all() as Array<{
    schema: string;
    name: string;
    wr: number | bigint;
  }>;
  const tlEntry = tableList.find((t) => t.schema === "main" && t.name === tableName);
  const isWithoutRowid = tlEntry ? Number(tlEntry.wr) === 1 : false;

  const allCols = db
    .prepare(`PRAGMA main.table_xinfo(${quoteIdent(tableName)});`)
    .safeIntegers(true)
    .all() as Array<{
    cid: number | bigint;
    name: string;
    type: string;
    pk: number | bigint;
    hidden: number | bigint;
  }>;

  for (const col of allCols) {
    validateAndDecodeUtf8(Buffer.from(col.name, "utf8"));
  }

  const declaredLower = new Set(allCols.map((c) => c.name.toLowerCase()));
  if (!isWithoutRowid && declaredLower.has("__rowid__")) {
    throw new Error("unsupported_table_schema: declared column __rowid__ collision");
  }

  let hasIpkAlias = false;
  if (!isWithoutRowid) {
    const pkCols = allCols.filter((c) => Number(c.pk) > 0);
    if (pkCols.length === 1) {
      const pkCol = pkCols[0];
      if (Number(pkCol.hidden) === 0 && pkCol.type.trim().toUpperCase() === "INTEGER") {
        const idxList = db
          .prepare(`PRAGMA main.index_list(${quoteIdent(tableName)});`)
          .safeIntegers(true)
          .all() as Array<{ name: string; origin: string }>;
        const pkIdx = idxList.find((i) => i.origin === "pk");
        let isDesc = false;
        if (pkIdx) {
          const idxInfo = db
            .prepare(`PRAGMA main.index_xinfo(${quoteIdent(pkIdx.name)});`)
            .safeIntegers(true)
            .all() as Array<{ cid: number | bigint; desc: number | bigint }>;
          const colInfo = idxInfo.find((x) => Number(x.cid) === Number(pkCol.cid));
          if (colInfo && Number(colInfo.desc) === 1) {
            isDesc = true;
          }
        }
        if (!isDesc) {
          hasIpkAlias = true;
        }
      }
    }
  }

  let rowidAlias: string | null = null;
  const needsRowid = !isWithoutRowid && !hasIpkAlias;
  if (needsRowid) {
    for (const cand of ["_rowid_", "rowid", "oid"]) {
      if (!declaredLower.has(cand.toLowerCase())) {
        rowidAlias = cand;
        break;
      }
    }
    if (!rowidAlias) {
      throw new Error("unsupported_table_schema: all rowid aliases shadowed");
    }
  }

  const userCols = allCols.filter((c) => Number(c.hidden) !== 1);

  const selectItems: string[] = [];
  for (const col of userCols) {
    const q = quoteIdent(col.name);
    selectItems.push(`typeof(${q}), CAST(${q} AS BLOB), ${q}`);
  }
  if (needsRowid && rowidAlias) {
    const q = quoteIdent(rowidAlias);
    selectItems.push(`typeof(${q}), CAST(${q} AS BLOB), ${q}`);
  }

  const selectSql =
    selectItems.length > 0
      ? `SELECT ${selectItems.join(", ")} FROM main.${quoteIdent(tableName)}`
      : `SELECT 1 FROM main.${quoteIdent(tableName)} WHERE 0`;

  const rowsRaw = db.prepare(selectSql).safeIntegers(true).raw(true).all() as unknown[][];
  const rows: EncodedRow[] = [];

  for (const rawRow of rowsRaw) {
    const rowObj: EncodedRow = Object.create(null);
    let idx = 0;
    for (const col of userCols) {
      const t = rawRow[idx++] as string;
      const b = rawRow[idx++] as Buffer | null;
      const v = rawRow[idx++];
      const val = encodeColumnValue(t, b, v);
      Object.defineProperty(rowObj, col.name, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (needsRowid) {
      const t = rawRow[idx++] as string;
      const b = rawRow[idx++] as Buffer | null;
      const v = rawRow[idx];
      const val = encodeColumnValue(t, b, v);
      Object.defineProperty(rowObj, "__rowid__", {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    rows.push(rowObj);
  }

  rows.sort((a, b) => {
    const ja = canonicalJson(a);
    const jb = canonicalJson(b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });

  return rows;
}

export function computeMobileStateHash(db: Database.Database): MobileStateHash {
  const encRow = db.prepare("PRAGMA encoding;").safeIntegers(true).get() as
    { encoding?: string } | undefined;
  if (encRow?.encoding !== "UTF-8") {
    throw new Error(
      `unsupported_state_value: unsupported_database_encoding_${encRow?.encoding ?? "unknown"}`,
    );
  }

  const schemaRaw = db
    .prepare(
      "SELECT typeof(type), CAST(type AS BLOB), typeof(name), CAST(name AS BLOB), typeof(tbl_name), CAST(tbl_name AS BLOB), typeof(sql), CAST(sql AS BLOB) FROM main.sqlite_master ORDER BY type ASC, name ASC;",
    )
    .safeIntegers(true)
    .raw(true)
    .all() as unknown[][];

  const schemaTuples: [string, string, string, string | null][] = [];
  for (const row of schemaRaw) {
    const typeStr = validateAndDecodeUtf8(row[1] as Buffer);
    const nameStr = validateAndDecodeUtf8(row[3] as Buffer);
    const tblStr = validateAndDecodeUtf8(row[5] as Buffer);
    let sqlStr: string | null = null;
    if (row[6] === "text" && row[7] !== null) {
      sqlStr = validateAndDecodeUtf8(row[7] as Buffer);
    } else if (row[6] !== "null") {
      throw new Error("unsupported_state_value: malformed_schema_sql");
    }
    schemaTuples.push([typeStr, nameStr, tblStr, sqlStr]);
  }

  schemaTuples.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });

  const schema_sha256 = sha256(canonicalJson(schemaTuples));

  const tableNames: string[] = [];
  for (const entry of schemaTuples) {
    if (entry[0] === "table") {
      tableNames.push(entry[1]);
    }
  }
  tableNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const tableDataMap = new Map<string, EncodedRow[]>();
  for (const tbl of tableNames) {
    tableDataMap.set(tbl, extractTableRows(db, tbl));
  }

  const mobileTableNames = tableNames.filter((t) => t.startsWith("mobile_"));
  const otherTableNames = tableNames.filter((t) => !t.startsWith("mobile_"));

  const otherTablesList: [string, EncodedRow[]][] = [];
  for (const tbl of otherTableNames) {
    otherTablesList.push([tbl, tableDataMap.get(tbl)!]);
  }
  const other_tables_sha256 = sha256(canonicalJson(otherTablesList));

  const mobile_tables: Record<string, { rows: number; raw_sha256: string }> = Object.create(null);
  for (const tbl of mobileTableNames) {
    const tblRows = tableDataMap.get(tbl)!;
    const raw_sha256 = sha256(canonicalJson(tblRows));
    mobile_tables[tbl] = {
      rows: tblRows.length,
      raw_sha256,
    };
  }

  const batchMap = new Map<unknown, string>();
  if (tableDataMap.has("mobile_import_batches")) {
    const batchRows = tableDataMap.get("mobile_import_batches")!;
    for (const r of batchRows) {
      const shaVal = r.input_sha256;
      let shaStr: string | null = null;
      if (typeof shaVal === "string") {
        shaStr = shaVal;
      } else if (shaVal && typeof shaVal === "object" && "$blob" in shaVal) {
        shaStr = shaVal.$blob;
      } else if (shaVal !== null && shaVal !== undefined) {
        shaStr = String(shaVal);
      }
      if (shaStr !== null) {
        const registerKey = (k: unknown) => {
          if (k !== null && k !== undefined) {
            batchMap.set(k, shaStr!);
            batchMap.set(String(k), shaStr!);
            if (typeof k === "object" && "$int" in k) {
              batchMap.set(k.$int, shaStr!);
              batchMap.set(String(k.$int), shaStr!);
            }
          }
        };
        registerKey(r.id);
        registerKey(r.batch_id);
        registerKey(r.__rowid__);
      }
    }
  }

  const batchColNames = new Set([
    "batch_id",
    "first_batch_id",
    "model_code_batch_id",
    "quarantined_batch_id",
  ]);
  const normalizedMobileTableOrder: string[] = [];
  for (const tbl of MOBILE_STAGING_TABLES) {
    if (tableDataMap.has(tbl)) {
      normalizedMobileTableOrder.push(tbl);
    }
  }
  for (const tbl of tableNames) {
    if (tbl.startsWith("mobile_") && !MOBILE_STAGING_TABLES.some((known) => known === tbl)) {
      normalizedMobileTableOrder.push(tbl);
    }
  }

  const normalizedTablesList: [string, EncodedRow[]][] = [];
  for (const tbl of normalizedMobileTableOrder) {
    const originalRows = tableDataMap.get(tbl)!;
    const normRows: EncodedRow[] = [];
    for (const r of originalRows) {
      const normObj: EncodedRow = Object.create(null);
      for (const k of Object.keys(r)) {
        if (k === "applied_at" || k === "__rowid__") continue;
        let val = r[k];
        if (batchColNames.has(k) && val !== null) {
          let lookupKey: unknown = val;
          if (typeof val === "object" && val !== null && "$int" in val) {
            lookupKey = val.$int;
          }
          if (batchMap.has(lookupKey)) {
            val = batchMap.get(lookupKey)!;
          } else if (batchMap.has(String(lookupKey))) {
            val = batchMap.get(String(lookupKey))!;
          }
        }
        Object.defineProperty(normObj, k, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      normRows.push(normObj);
    }
    normRows.sort((a, b) => {
      const ja = canonicalJson(a);
      const jb = canonicalJson(b);
      return ja < jb ? -1 : ja > jb ? 1 : 0;
    });
    normalizedTablesList.push([tbl, normRows]);
  }

  const mobile_normalized_sha256 = sha256(canonicalJson(normalizedTablesList));

  return {
    schema: "mgpl-mobile-state-hash/1",
    mobile_tables,
    mobile_normalized_sha256,
    other_tables_sha256,
    schema_sha256,
  };
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseCliOptions(
  args: string[],
  allowed: string[],
  repeatable: string[] = [],
): Map<string, string | string[]> {
  const options = new Map<string, string | string[]>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key)) {
      refuse(`unknown option: ${key}`);
    }
    const val = args[++i];
    if (!val || val.startsWith("--")) {
      refuse(`missing value for option: ${key}`);
    }
    if (repeatable.includes(key)) {
      const arr = (options.get(key) as string[]) || [];
      arr.push(val);
      options.set(key, arr);
    } else {
      if (options.has(key)) {
        refuse(`repeated option: ${key}`);
      }
      options.set(key, val);
    }
  }
  return options;
}

async function runCopy(args: string[], now: Date): Promise<number> {
  const opts = parseCliOptions(args, ["--from", "--to", "--receipt"]);
  for (const req of ["--from", "--to", "--receipt"]) {
    if (!opts.has(req)) refuse(`missing required option: ${req}`);
  }
  const fromPath = opts.get("--from") as string;
  const toPath = opts.get("--to") as string;
  const receiptPath = opts.get("--receipt") as string;

  if (!fs.existsSync(fromPath)) refuse(`source database does not exist: ${fromPath}`);
  assertOutsideRepo(toPath, "--to");
  assertOutsideRepo(receiptPath, "--receipt");

  const fromReal = fs.realpathSync(fromPath);
  const toLanding = landingPath(toPath);
  const receiptLanding = landingPath(receiptPath);

  if (toLanding === receiptLanding || path.resolve(toPath) === path.resolve(receiptPath)) {
    refuse("destination and receipt must not be the same path");
  }
  if (fromReal === toLanding || path.resolve(fromPath) === path.resolve(toPath)) {
    refuse("source and destination must not be the same path");
  }
  if (fromReal === receiptLanding || path.resolve(fromPath) === path.resolve(receiptPath)) {
    refuse("source and receipt must not be the same path");
  }

  let toOwned = false;
  let receiptOwned = false;
  let srcDb: Database.Database | undefined;
  let toDb: Database.Database | undefined;
  let success = false;

  try {
    try {
      const fd = fs.openSync(toPath, "wx");
      fs.closeSync(fd);
      toOwned = true;
    } catch (err: unknown) {
      if (
        (err !== null && typeof err === "object" && "code" in err && err.code === "EEXIST") ||
        fs.existsSync(toPath)
      ) {
        refuse(`destination database already exists: ${toPath}`);
      }
      throw err;
    }

    try {
      const fd = fs.openSync(receiptPath, "wx");
      fs.closeSync(fd);
      receiptOwned = true;
    } catch (err: unknown) {
      if (
        (err !== null && typeof err === "object" && "code" in err && err.code === "EEXIST") ||
        fs.existsSync(receiptPath)
      ) {
        refuse(`receipt already exists: ${receiptPath}`);
      }
      throw err;
    }

    const from_sha256 = hashFile(fromReal);
    const walPath = `${fromReal}-wal`;
    const from_wal_sha256 = fs.existsSync(walPath) ? hashFile(walPath) : null;

    srcDb = new Database(fromReal, { readonly: true, fileMustExist: true });
    await srcDb.backup(toPath);
    srcDb.close();
    srcDb = undefined;

    const postFromSha = hashFile(fromReal);
    const postWalSha = fs.existsSync(walPath) ? hashFile(walPath) : null;
    if (postFromSha !== from_sha256 || postWalSha !== from_wal_sha256) {
      refuse("source_changed: stop the app first");
    }

    toDb = new Database(toPath, { readonly: true, fileMustExist: true });
    let mobile_tables_present: string[] = [];
    const mobile_row_counts: Record<string, number> = {};
    const dpx_row_counts: Record<string, number> = {};

    const check = toDb.prepare("PRAGMA integrity_check;").all() as Array<{
      integrity_check?: string;
    }>;
    if (!check.length || check[0].integrity_check !== "ok") {
      refuse("destination integrity check failed");
    }
    const allTables = toDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table';")
      .all() as Array<{ name: string }>;
    const tableSet = new Set(allTables.map((t) => t.name));
    mobile_tables_present = MOBILE_STAGING_TABLES.filter((t) => tableSet.has(t));
    for (const t of mobile_tables_present) {
      const r = toDb.prepare(`SELECT COUNT(*) as c FROM ${quoteIdent(t)};`).get() as {
        c: number | bigint;
      };
      mobile_row_counts[t] = Number(r.c);
    }
    for (const t of allTables
      .map((t) => t.name)
      .filter((n) => n.startsWith("dpx_"))
      .sort()) {
      const r = toDb.prepare(`SELECT COUNT(*) as c FROM ${quoteIdent(t)};`).get() as {
        c: number | bigint;
      };
      dpx_row_counts[t] = Number(r.c);
    }
    toDb.close();
    toDb = undefined;

    const to_sha256 = hashFile(toPath);
    const toReal = fs.realpathSync(toPath);

    const receipt: MobileDevCopyReceipt = {
      schema: "mgpl-mobile-devcopy-receipt/1",
      from: fromReal,
      from_sha256,
      from_wal_sha256,
      from_unchanged: true,
      to: toReal,
      to_sha256,
      integrity: "ok",
      mobile_tables_present,
      mobile_row_counts,
      dpx_row_counts,
      copied_at: now.toISOString(),
    };

    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    success = true;
    return 0;
  } finally {
    if (toDb) {
      try {
        toDb.close();
      } catch {
        // Preserve the original operation error while cleaning up owned resources.
      }
    }
    if (srcDb) {
      try {
        srcDb.close();
      } catch {
        // Preserve the original operation error while cleaning up owned resources.
      }
    }
    if (!success) {
      if (toOwned) {
        try {
          if (fs.existsSync(toPath)) fs.unlinkSync(toPath);
        } catch {
          // Preserve the original operation error while cleaning up owned resources.
        }
      }
      if (receiptOwned) {
        try {
          if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
        } catch {
          // Preserve the original operation error while cleaning up owned resources.
        }
      }
    }
  }
}

function runSchema(args: string[]): number {
  const opts = parseCliOptions(args, ["--db", "--receipt"]);
  for (const req of ["--db", "--receipt"]) {
    if (!opts.has(req)) refuse(`missing required option: ${req}`);
  }
  const dbPath = opts.get("--db") as string;
  const receiptPath = opts.get("--receipt") as string;

  if (!fs.existsSync(receiptPath)) refuse(`receipt does not exist: ${receiptPath}`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as MobileDevCopyReceipt;
  if (receipt.schema !== "mgpl-mobile-devcopy-receipt/1") refuse("receipt schema mismatch");

  if (!fs.existsSync(dbPath)) refuse(`database does not exist: ${dbPath}`);
  const dbReal = fs.realpathSync(dbPath);
  const receiptToReal = fs.existsSync(receipt.to)
    ? fs.realpathSync(receipt.to)
    : path.resolve(receipt.to);
  if (dbReal !== receiptToReal && dbReal !== receipt.to) {
    refuse("database path does not match receipt to");
  }

  const dbTsPath = path.join(getRepoRoot(), "src", "db.ts");
  if (!fs.existsSync(dbTsPath)) refuse("src/db.ts does not exist");
  const dbSource = fs.readFileSync(dbTsPath, "utf8");
  const match = dbSource.match(/const MOBILE_STAGING_DDL = `\n([\s\S]*?)`;/);
  if (!match) refuse("failed to extract MOBILE_STAGING_DDL from src/db.ts");
  const ddl = match[1];

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON;");
    db.exec(ddl);
  } finally {
    db.close();
  }
  return 0;
}

function runHash(args: string[]): number {
  const opts = parseCliOptions(args, ["--db"]);
  if (!opts.has("--db")) refuse("missing required option: --db");
  const dbPath = opts.get("--db") as string;
  if (!fs.existsSync(dbPath)) refuse(`database does not exist: ${dbPath}`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON;");
    const state = computeMobileStateHash(db);
    process.stdout.write(canonicalJson(state) + "\n");
  } finally {
    db.close();
  }
  return 0;
}

function runVerifySource(args: string[]): number {
  const opts = parseCliOptions(args, ["--from", "--receipt"], ["--receipt"]);
  if (!opts.has("--from")) refuse("missing required option: --from");
  const receiptPaths = (opts.get("--receipt") as string[]) || [];
  if (receiptPaths.length === 0) refuse("at least one --receipt required");

  const fromPath = opts.get("--from") as string;
  if (!fs.existsSync(fromPath)) refuse(`source database does not exist: ${fromPath}`);
  const fromReal = fs.realpathSync(fromPath);
  const main_sha256 = hashFile(fromReal);
  const walPath = `${fromReal}-wal`;
  const wal_sha256 = fs.existsSync(walPath) ? hashFile(walPath) : null;

  const parsedReceipts: Array<{ path: string; data: MobileDevCopyReceipt }> = [];
  for (const rp of receiptPaths) {
    if (!fs.existsSync(rp)) refuse(`receipt does not exist: ${rp}`);
    const data = JSON.parse(fs.readFileSync(rp, "utf8")) as MobileDevCopyReceipt;
    if (data.schema !== "mgpl-mobile-devcopy-receipt/1") refuse(`invalid receipt schema in ${rp}`);
    parsedReceipts.push({ path: rp, data });
  }

  const first = parsedReceipts[0].data;
  for (const { data } of parsedReceipts) {
    const rFromReal = fs.existsSync(data.from)
      ? fs.realpathSync(data.from)
      : path.resolve(data.from);
    const firstFromReal = fs.existsSync(first.from)
      ? fs.realpathSync(first.from)
      : path.resolve(first.from);
    if (rFromReal !== firstFromReal || data.from !== first.from) {
      refuse("two receipts with different from paths");
    }
    if (data.from_sha256 !== first.from_sha256) {
      refuse("two receipts with different from_sha256");
    }
    if (rFromReal !== fromReal && path.resolve(data.from) !== path.resolve(fromPath)) {
      refuse("receipt from does not match --from");
    }
  }

  const comparisons: Array<{ path: string; main_match: boolean; wal_match: boolean }> = [];
  let allMatch = true;
  let failingComponent: "main" | "wal_changed" | "wal_appeared" | "wal_disappeared" | null = null;

  for (const { path: rp, data } of parsedReceipts) {
    const main_match = data.from_sha256 === main_sha256;
    const wal_match = data.from_wal_sha256 === wal_sha256;
    comparisons.push({ path: rp, main_match, wal_match });

    if (!main_match && !failingComponent) {
      failingComponent = "main";
      allMatch = false;
    }
    if (!wal_match && !failingComponent) {
      if (data.from_wal_sha256 === null && wal_sha256 !== null) {
        failingComponent = "wal_appeared";
      } else if (data.from_wal_sha256 !== null && wal_sha256 === null) {
        failingComponent = "wal_disappeared";
      } else {
        failingComponent = "wal_changed";
      }
      allMatch = false;
    }
  }

  const output = {
    main_sha256,
    wal_sha256,
    receipts: comparisons,
  };
  console.log(JSON.stringify(output));

  if (!allMatch && failingComponent) {
    console.error(`source_changed: ${failingComponent}`);
    return 2;
  }
  return 0;
}

function runRollback(args: string[]): number {
  const opts = parseCliOptions(args, ["--db", "--receipt"]);
  for (const req of ["--db", "--receipt"]) {
    if (!opts.has(req)) refuse(`missing required option: ${req}`);
  }
  const dbPath = opts.get("--db") as string;
  const receiptPath = opts.get("--receipt") as string;

  if (!fs.existsSync(receiptPath)) refuse(`receipt does not exist: ${receiptPath}`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as MobileDevCopyReceipt;
  if (receipt.schema !== "mgpl-mobile-devcopy-receipt/1") refuse("receipt schema mismatch");

  if (!fs.existsSync(dbPath)) refuse(`database does not exist: ${dbPath}`);
  const dbReal = fs.realpathSync(dbPath);
  const receiptToReal = fs.existsSync(receipt.to)
    ? fs.realpathSync(receipt.to)
    : path.resolve(receipt.to);
  if (dbReal !== receiptToReal && dbReal !== receipt.to) {
    refuse("database path does not match receipt to");
  }

  const sqlPath = path.join(getRepoRoot(), "scripts", "rollback-mobile-catalogue-tables.sql");
  if (!fs.existsSync(sqlPath)) refuse("rollback sql script does not exist");
  const rollbackSql = fs.readFileSync(sqlPath, "utf8");

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON;");
    db.exec(rollbackSql);
  } finally {
    db.close();
  }
  return 0;
}

export async function main(argv: string[], now = new Date()): Promise<number> {
  try {
    if (process.env.NODE_ENV === "production") {
      refuse("production refused");
    }
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      console.log("Usage: mobile-devcopy <copy|schema|hash|verify-source|rollback> [options]");
      return argv.length === 0 ? 2 : 0;
    }

    const command = argv[0];
    const restArgs = argv.slice(1);

    switch (command) {
      case "copy":
        return await runCopy(restArgs, now);
      case "schema":
        return runSchema(restArgs);
      case "hash":
        return runHash(restArgs);
      case "verify-source":
        return runVerifySource(restArgs);
      case "rollback":
        return runRollback(restArgs);
      default:
        refuse(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(error.message);
      return 2;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.startsWith("unsupported_state_value") ||
      msg.startsWith("unsupported_table_schema") ||
      msg.startsWith("source_changed")
    ) {
      console.error(msg);
      return 2;
    }
    console.error(msg);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    },
  );
}
