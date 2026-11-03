const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const p = path.resolve(process.cwd(), "data", "test_mgpl.db");
console.log("DB path:", p);
console.log("exists:", fs.existsSync(p));
if (fs.existsSync(p)) {
  const db = new Database(p, { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  console.log("tables:", tables.map((x) => x.name).join(", "));
  db.close();
} else {
  console.log("DB does not exist yet.");
}
