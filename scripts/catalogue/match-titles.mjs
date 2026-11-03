// Task proposal 021 (WU-008 item 1): match the titles read from a user's library page to the
// catalogue, offline. Free; no network call and no billed call.
//
//   node scripts/catalogue/match-titles.mjs --data-dir <catalogue dir> --titles <file> --out <file>
//
// <catalogue dir> holds wikidata.jsonl (and, if present, wikidata-xids.jsonl, whose aliases are
// used). <file> is JSON: an array of { title, platforms?: ["PS4" | "PS5"], ps_plus?: boolean }.
// The results go to --out only, which must be outside the repository: they are personal data.
// The console shows counts, never a title, and an error shows only its type, never its text.
//
// The rules come from the free matching test of 2026-10-09 (76 of 84 store titles matched with no
// model). They are tried in order, and the first that finds a candidate decides:
//   confirmed tiers  exact     the title equals a catalogue label after normalising (normTitle)
//                    edition   equal after removing a store edition label ("Standard Edition",
//                              "(PS4 & PS5)", "PS5", "PS4")
//   suggested tiers  alias     equal to one of the item's Wikidata aliases (exact or edition)
//                    prefix    equal after removing a brand prefix ("Marvel's", "Tom Clancy's",
//                              "Sid Meier's", "Disney")
//                    symbol    equal after spelling a symbol out ("Δ" as "Delta")
//                    accent    equal after removing accents ("Sturmjäger" and "Sturmjager")
//                    vr        equal after removing a trailing "VR" (the VR edition can be a
//                              different product, so the user confirms)
// Several candidates are narrowed by platform: a PS4 or PS5 badge keeps the candidates Wikidata
// lists on that platform. If more than one is left, the title is "ambiguous" and is never
// auto-accepted. Word overlap is never used: the free test showed it picks the wrong game.
// Nothing below a confirmed tier is accepted without the user.
// cspell:words wikidata jsonl xids Sturmj Clancy Meier
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, normTitle, parseCliArgs, readJsonl } from "./lib.mjs";

/** The repository root: two folders above this script. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A usage error this script wrote. Its message is always fixed text, never an argument's value. */
export class MatchUsageError extends Error {}

/** Wikidata items for the PlayStation consoles a library page shows. */
export const PS_PLATFORMS = Object.freeze({ PS4: "Q5014725", PS5: "Q63184502" });

export const CONFIRMED_METHODS = Object.freeze(["exact", "edition"]);
export const SUGGESTED_METHODS = Object.freeze(["alias", "prefix", "symbol", "accent", "vr"]);

/** Store edition labels, as normTitle gives them, removed from the end, one at a time. */
const EDITION_LABELS = ["standard edition", "ps4 and ps5", "ps5 and ps4", "ps5", "ps4"];
const BRAND_PREFIXES = ["Marvel's", "Tom Clancy's", "Sid Meier's", "Disney"].map(normTitle);
const SYMBOLS = [[/[Δ∆]/g, " Delta "]];

/** The title without trailing store edition labels; null if that would leave nothing. */
export function stripEdition(key) {
  if (!key) return null;
  let t = key;
  let removed = false;
  for (let changed = true; changed;) {
    changed = false;
    for (const label of EDITION_LABELS) {
      if (t.endsWith(` ${label}`)) {
        t = t.slice(0, -label.length - 1).trim();
        removed = changed = true;
      }
    }
  }
  return removed && t ? t : null;
}

export function stripPrefix(key) {
  if (!key) return null;
  for (const p of BRAND_PREFIXES) if (key.startsWith(`${p} `)) return key.slice(p.length + 1);
  return null;
}

export function spellSymbols(title) {
  let t = String(title ?? "");
  let changed = false;
  for (const [re, word] of SYMBOLS) {
    if (re.test(t)) {
      t = t.replace(re, word);
      changed = true;
    }
    re.lastIndex = 0;
  }
  return changed ? normTitle(t) : null;
}

/** A normalised title without accents or other combining marks, for user entries only. */
export function foldAccents(key) {
  if (!key) return null;
  const f = key.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  return f || null;
}

function stripVr(key) {
  return key && key.endsWith(" vr") && key.length > 3 ? key.slice(0, -3).trim() : null;
}

function add(map, key, qid) {
  if (!key) return;
  const list = map.get(key);
  if (!list) map.set(key, [qid]);
  else if (!list.includes(qid)) list.push(qid);
}

/**
 * The catalogue as lookup maps. records: wikidata.jsonl; xids: wikidata-xids.jsonl (optional).
 */
export function buildIndex(records, xids = []) {
  const items = new Map();
  const label = new Map();
  const folded = new Map();
  const alias = new Map();
  for (const r of records) {
    if (!r?.qid) continue;
    const years = (r.release_dates ?? []).map((d) => Number(String(d.iso).slice(0, 4)));
    items.set(r.qid, {
      qid: r.qid,
      label: r.label ?? null,
      first_year: years.length ? Math.min(...years) : null,
      platforms: (r.platforms ?? []).map((p) => p.id),
    });
    const k = normTitle(r.label);
    add(label, k, r.qid);
    add(folded, foldAccents(k), r.qid);
  }
  for (const x of xids) {
    if (!items.has(x?.qid)) continue;
    for (const a of x.aliases ?? []) add(alias, normTitle(a), x.qid);
  }
  return { items, label, folded, alias };
}

/** The candidates a PS4/PS5 badge keeps, or all of them if the badge keeps none. */
function byPlatform(index, qids, platforms) {
  const wanted = (platforms ?? []).map((p) => PS_PLATFORMS[p]).filter(Boolean);
  if (qids.length < 2 || !wanted.length) return { qids, narrowed: false };
  const kept = qids.filter((q) => index.items.get(q)?.platforms.some((p) => wanted.includes(p)));
  return kept.length && kept.length < qids.length
    ? { qids: kept, narrowed: true }
    : { qids, narrowed: false };
}

/** Matches one title read from a library page. */
export function matchTitle(index, entry) {
  const title = entry?.title ?? "";
  const key = normTitle(title);
  const edition = stripEdition(key);
  const tiers = [
    ["exact", () => index.label.get(key)],
    ["edition", () => index.label.get(edition)],
    ["alias", () => index.alias.get(key) ?? index.alias.get(edition)],
    ["prefix", () => index.label.get(stripPrefix(key)) ?? index.label.get(stripPrefix(edition))],
    ["symbol", () => index.label.get(spellSymbols(title))],
    ["accent", () => index.folded.get(foldAccents(edition ?? key))],
    ["vr", () => index.label.get(stripVr(key))],
  ];
  for (const [method, find] of tiers) {
    const found = find();
    if (!found?.length) continue;
    const { qids, narrowed } = byPlatform(index, found, entry.platforms);
    const candidates = qids.map((q) => {
      const it = index.items.get(q);
      return {
        qid: q,
        label: it?.label ?? null,
        first_year: it?.first_year ?? null,
        playstation: Object.entries(PS_PLATFORMS)
          .filter(([, id]) => it?.platforms.includes(id))
          .map(([name]) => name),
      };
    });
    const one = qids.length === 1;
    const status = !one
      ? "ambiguous"
      : CONFIRMED_METHODS.includes(method)
        ? "confirmed"
        : "suggested";
    return {
      title,
      method,
      status,
      narrowed_by_platform: narrowed,
      chosen: one ? qids[0] : null,
      candidates,
    };
  }
  return {
    title,
    method: null,
    status: "not_found",
    narrowed_by_platform: false,
    chosen: null,
    candidates: [],
  };
}

/**
 * The library's rows (one per tile), each matched on its own with its own badge, then grouped
 * into games by what they matched (Codex pre-dispatch review of WU-021, finding 4):
 * - rows that match the same single catalogue item are one game, with the platforms of all its
 *   rows. A game is confirmed only if every row of it is; otherwise it is suggested;
 * - rows that match no single item are grouped only when their title (without edition labels),
 *   status and candidates are all the same;
 * - two rows that match different items stay two games, whatever their titles.
 * Access per platform: "Owned License", or "Subscription Access" when the only rows for that
 * platform carry the PS Plus badge.
 */
export function matchLibrary(index, rows) {
  const games = new Map();
  for (const r of rows ?? []) {
    const key = normTitle(r?.title);
    if (!key) continue;
    const res = matchTitle(index, r);
    const id = res.chosen
      ? `qid:${res.chosen}`
      : `title:${stripEdition(key) ?? key}|${res.status}|${res.candidates
          .map((c) => c.qid)
          .sort()
          .join(",")}`;
    let g = games.get(id);
    if (!g) {
      g = { ...res, methods: [], platforms: [], access: {}, rows: 0 };
      games.set(id, g);
    }
    g.rows++;
    if (!g.methods.includes(res.method)) g.methods.push(res.method);
    if (res.status !== g.status) g.status = "suggested";
    for (const p of r.platforms ?? []) {
      if (!PS_PLATFORMS[p]) continue;
      if (!g.platforms.includes(p)) g.platforms.push(p);
      const a = r.ps_plus === true ? "Subscription Access" : "Owned License";
      if (g.access[p] !== "Owned License") g.access[p] = a;
    }
  }
  for (const g of games.values()) g.platforms.sort();
  return [...games.values()];
}

/** A path with its nearest existing folder replaced by that folder's real path (links resolved). */
export function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = realpathSync.native(cur);
  } catch {
    // An unreadable folder is compared as written.
  }
  return path.join(real, ...rest);
}

/**
 * Whether child is parent or inside it, after resolving links and junctions, ignoring letter
 * case on Windows. A name that only begins with ".." (such as "..private") is inside.
 */
export function isInside(child, parent, platform = process.platform) {
  const fold = (s) => (platform === "win32" ? s.toLowerCase() : s);
  const rel = path.relative(fold(realish(parent)), fold(realish(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The console message for an error a script that handles a user's library did not write itself
 * (Codex pre-dispatch review of WU-021, finding 2): only its type and code. A file-system error
 * names its file, and a JSON error quotes the text, so neither message is ever shown.
 */
export function privateCliMessage(e) {
  const name = typeof e?.name === "string" && /^[A-Za-z]+$/.test(e.name) ? e.name : "Error";
  const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? ` ${e.code}` : "";
  return `stopped (${name}${code}); the details are not shown, because they may name a personal file`;
}

/** Counts per status and method, with no title in them. */
export function summarize(results) {
  const by = (k) =>
    results.reduce((m, r) => ((m[r[k] ?? "none"] = (m[r[k] ?? "none"] ?? 0) + 1), m), {});
  return { titles: results.length, by_status: by("status"), by_method: by("method") };
}

/** A fixed usage message for an argument error, never carrying the argument's value. */
function argumentProblem(message) {
  const m = String(message);
  if (m.startsWith("unexpected argument: ")) return "unexpected argument (not shown)";
  if (m.startsWith("unknown option ")) return "unknown option (not shown)";
  const x = /^--(data-dir|titles|out) needs a value$/.exec(m);
  return x ? m : "usage error (details not shown)";
}

export function main(argv, deps = {}) {
  let args;
  try {
    args = parseCliArgs(argv, { "data-dir": "string", titles: "string", out: "string" });
  } catch (e) {
    throw new MatchUsageError(argumentProblem(e?.message ?? e));
  }
  if (!args["data-dir"] || !args.titles || !args.out)
    throw new MatchUsageError(
      "usage: match-titles.mjs --data-dir <dir> --titles <file> --out <file>",
    );
  const out = path.resolve(args.out);
  if (isInside(out, deps.root ?? REPO_ROOT))
    throw new MatchUsageError(
      "--out must be outside the repository: the results are personal data",
    );
  const dataDir = path.resolve(args["data-dir"]);
  const index = buildIndex(
    readJsonl(path.join(dataDir, "wikidata.jsonl")),
    readJsonl(path.join(dataDir, "wikidata-xids.jsonl")),
  );
  const entries = JSON.parse(readFileSync(path.resolve(args.titles), "utf8"));
  if (!Array.isArray(entries)) throw new MatchUsageError("the titles file is not a JSON array");
  const results = matchLibrary(index, entries);
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const log = deps.log ?? ((s) => console.log(s));
  const s = summarize(results);
  log(`match-titles: ${entries.length} rows, ${s.titles} games; ${JSON.stringify(s.by_status)}`);
  return s;
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // A MatchUsageError carries only fixed text (argumentProblem and the fixed messages above).
    console.error(
      `match-titles: ${e instanceof MatchUsageError ? e.message : privateCliMessage(e)}`,
    );
    process.exitCode = 1;
  }
}
