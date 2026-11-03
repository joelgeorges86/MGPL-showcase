/* Fix the recommender "<30m" button in public/index.html.
 *
 * The recommender controls must match the app.js binding contract:
 *   - container id  -> #recommender-time-btns
 *   - button class  -> .rec-time-btn
 *   - value attr    -> data-val
 * The "<30m" value is HTML-entity-escaped (&lt;30m) so the attribute value is
 * valid HTML while the browser decodes it back to "<30m", which the backend
 * recommender route already accepts.
 */
const fs = require("fs");
const path = require("path");

const target = path.resolve(__dirname, "..", "public", "index.html");
let txt = fs.readFileSync(target, "utf8");

const corrupted = '<button data-time="<30m" class="recommender-time-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white transition-all"><30m</button>';
const fixed = '<button data-val="&lt;30m" class="rec-time-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white transition-all">&lt;30m</button>';

const count = txt.split(corrupted).length - 1;
if (count === 0) {
  console.error("Corrupted pattern not found. No change made.");
  process.exit(1);
}

txt = txt.split(corrupted).join(fixed);
fs.writeFileSync(target, txt, "utf8");
console.log("Fixed " + count + " occurrence(s) of the corrupted recommender button.");
