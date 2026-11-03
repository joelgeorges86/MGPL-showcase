import Database, { Database as DatabaseType } from 'better-sqlite3';

// Direct SQLite normalization using better-sqlite3
// - Reads tables from sqlite_master
// - Uses PRAGMA table_info to discover columns
// - Normalizes boolean-like strings and extracts integers from textual fields

const DB_FILE = 'mpgl_app.db';

function normalizeBool(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v === 1 ? 'true' : v === 0 ? 'false' : null;
  const s = String(v).trim().toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return 'true';
  if (s === 'no' || s === 'n' || s === 'false' || s === '0') return 'false';
  return null;
}

function extractNumberString(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  return String(n);
}

function quoteIdentifier(name: string) {
  return '"' + name.replace(/"/g, '""') + '"';
}

function isTextType(sqlType: string) {
  if (!sqlType) return true; // no type declared -> treat as text
  const t = sqlType.toLowerCase();
  return t.includes('char') || t.includes('text') || t.includes('clob');
}

function getTables(db: DatabaseType): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  const names = rows.map(r => r.name).filter(n => n && !n.startsWith('sqlite_'));
  return names;
}

function getTableColumns(db: DatabaseType, table: string) {
  const pragma = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as any[];
  // pragma returns: cid, name, type, notnull, dflt_value, pk
  return pragma.map(p => ({ name: p.name, type: p.type, pk: p.pk }));
}

function findPrimaryKey(cols: Array<any>) {
  const pk = cols.find(c => c.pk === 1);
  return pk ? pk.name : null;
}

function isProtectedColumn(colName: string, pk?: string) {
  const ln = String(colName || '').toLowerCase();
  if (!ln) return true; // be conservative
  if (pk && ln === String(pk).toLowerCase()) return true; // primary key
  // Common foreign-key naming patterns (ends with 'id' or contains '_id')
  if (ln.endsWith('id') || ln.endsWith('_id')) return true;
  // explicit common columns
  const blacklist = new Set(['gameid', 'ownershipid', 'reviewid', 'frictionid', 'userid', 'id']);
  if (blacklist.has(ln)) return true;
  return false;
}

function shouldNormalizeColumn(col: any, value: any) {
  // Only attempt normalization for text-like columns or values that are strings
  if (typeof value === 'string') return true;
  if (isTextType(col.type)) return true;
  return false;
}

function normalizeValueForColumn(col: any, value: any): string | null {
  if (!shouldNormalizeColumn(col, value)) return null;
  // Try boolean normalization first
  const b = normalizeBool(value);
  if (b !== null) return b;
  // Then numeric extraction
  const n = extractNumberString(value);
  if (n !== null) return n;
  return null;
}

async function runNormalization() {
  const db = new Database(DB_FILE);
  // Disable foreign key checks during the normalization run to avoid SQLITE_CONSTRAINT_FOREIGNKEY
  try {
    db.pragma('foreign_keys = OFF;');
  } catch (e) {
    console.warn('Could not set PRAGMA foreign_keys = OFF:', e);
  }

  console.log(`Opened DB: ${DB_FILE}`);
  let totalUpdated = 0;

  try {
    const tables = getTables(db);
    console.log('Discovered tables:', tables.join(', '));

    for (const table of tables) {
      try {
        console.log(`\nProcessing table: ${table}`);
        const cols = getTableColumns(db, table);
        if (cols.length === 0) {
          console.log('  No columns found, skipping');
          continue;
        }
        const pk = findPrimaryKey(cols);

        // Select all rows, include rowid for fallback
        const rows = db.prepare(`SELECT rowid as __rowid, * FROM ${quoteIdentifier(table)}`).all() as any[];
        console.log(`  Rows: ${rows.length}`);

        let tableChanged = 0;
        const updateTxn = db.transaction((updates: Array<{ sql: string; params: any[] }>) => {
          for (const u of updates) {
            db.prepare(u.sql).run(...u.params);
          }
        });

        const batchedUpdates: Array<{ sql: string; params: any[] }> = [];

        for (const r of rows) {
          try {
            const idVal = pk ? r[pk] : r.__rowid;
            const idCol = pk ? quoteIdentifier(pk) : 'rowid';

            const changes: Array<{ col: string; val: string }> = [];
            for (const col of cols) {
              const colName = col.name;
              // Do not update primary key or foreign-key-like columns
              if (isProtectedColumn(colName, pk)) continue;
              const cur = r[colName];
              const normalized = normalizeValueForColumn(col, cur);
              if (normalized !== null && String(cur) !== normalized) {
                changes.push({ col: colName, val: normalized });
              }
            }

            if (changes.length > 0) {
              const setClause = changes.map(c => `${quoteIdentifier(c.col)} = ?`).join(', ');
              const sql = `UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE ${idCol} = ?`;
              const params = changes.map(c => c.val);
              params.push(String(idVal));
              batchedUpdates.push({ sql, params });
              tableChanged++;
            }
          } catch (rowErr) {
            console.error(`  Row error in table ${table}, skipping row:`, rowErr);
            continue;
          }
        }

        if (batchedUpdates.length > 0) {
          try {
            updateTxn(batchedUpdates);
            totalUpdated += batchedUpdates.length;
            console.log(`  Updated ${batchedUpdates.length} rows in ${table}`);
          } catch (execErr) {
            console.error(`  Failed executing updates for table ${table}:`, execErr);
          }
        } else {
          console.log(`  No changes for table ${table}`);
        }

      } catch (tblErr) {
        console.error(`Failed processing table ${table}:`, tblErr);
        continue;
      }
    }

    console.log(`\nNormalization finished. Total rows updated: ${totalUpdated}`);
  } catch (e) {
    console.error('Normalization run failed:', e);
  } finally {
    // Re-enable foreign keys before closing
    try {
      db.pragma('foreign_keys = ON;');
    } catch (e) {
      console.warn('Could not set PRAGMA foreign_keys = ON:', e);
    }
    try { db.close(); } catch (e) { /* ignore */ }
    console.log('Database closed');
  }
}

if (require.main === module) {
  runNormalization().catch(e => {
    console.error('Error running normalization:', e);
    process.exit(1);
  });
}
