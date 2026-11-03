// WU-009a (#158): compare Wikidata and Steam field by field (accuracy rule 1, task proposal 017).
// WU-009a2 (task proposal 018): compare only facts that describe the same thing, and say why.
// Offline: reads <data-dir>/wikidata.jsonl, steam.jsonl and (if present) companies.jsonl, makes
// no network call, and writes:
//   agreement.jsonl          one line per Wikidata item: each field's status, value, basis and links
//   conflicts.jsonl          the review queue: every "conflict" and "partial" field
//   agreement-summary.json   counts per field and status
//
//   node scripts/catalogue/agreement.mjs [--data-dir <dir>]
//
// Statuses:
//   agree     both sources give the value. value holds only what both support; basis says how
//             they were matched; anything only one source adds is in single_source. Promotable.
//   partial   a list field where Steam names something Wikidata does not, and they share some
//             values: shared values in value, the rest in unmatched. Review queue.
//   conflict  both sources speak to the same fact and differ. Review queue, never resolved here.
//   distinct  both sources have a value, but they describe different things (for example, a
//             Steam store date later than every Wikidata release event). Not compared, not
//             promoted, not queued; counted so the classification can be audited.
//   single    one source only: needs a second source before promotion.
//   none      neither source has it.
// Steam's store facts are also kept as they are, scoped to the app and the fetch time, under
// "store" (steam_store_release_date, steam_store_publishers, steam_original_release_date). They
// are never compared there.
// WU-009a3 (task proposal 022): Steam's facts come from the Steam Web API (GetItems). Where Steam
// records an original release date, that is the date compared (see compareDate).
// cspell:words wikidata jsonl
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_DATA_DIR,
  coarserDate,
  datesAgree,
  isMain,
  normCompany,
  normTitle,
  parseCliArgs,
  readJsonl,
  safeMessage,
  stripPlatformNote,
  stripSteamEdition,
} from "./lib.mjs";

// Wikidata platform items for the three platforms Steam reports.
export const PC_PLATFORMS = { Q1406: "windows", Q14116: "mac", Q388: "linux" };
const WINDOWS = "Q1406";
export const FIELDS = ["title", "release_date", "developers", "publishers", "platforms"];
export const STATUSES = ["agree", "partial", "conflict", "distinct", "single", "none"];
const REVIEW = new Set(["partial", "conflict"]);

const link = (src) =>
  src ? { name: src.name, url: src.revision_url ?? src.url, fetched_at: src.fetched_at } : null;

function result(status, value, sources, values, extra = {}) {
  return { status, value: value ?? null, sources: sources.filter(Boolean), values, ...extra };
}

function compareTitle(w, s, wl, sl) {
  const a = w.label ?? null;
  const b = s?.name ?? null;
  const values = { wikidata: a, steam: b };
  if (a && b) {
    // A title that normalises to nothing (only punctuation) is never evidence of agreement.
    if (normTitle(a) && normTitle(a) === normTitle(b))
      return result("agree", a, [wl, sl], values, { basis: "titles equal after normalising" });
    const stripped = stripSteamEdition(b);
    if (stripped.removed.length && normTitle(a) && normTitle(a) === normTitle(stripped.title))
      return result("agree", a, [wl, sl], values, {
        basis: `titles equal after removing Steam edition label(s): ${stripped.removed.join(" ")}`,
      });
    return result("conflict", null, [wl, sl], values);
  }
  if (a) return result("single", a, [wl], values);
  if (b) return result("single", b, [sl], values);
  return result("none", null, [], values);
}

/** Wikidata release events; records written before WU-009a2 have dates without qualifiers. */
function eventsOf(w) {
  if (Array.isArray(w.release_events)) return w.release_events;
  return (w.release_dates ?? []).map((d) => ({ ...d, platforms: [], places: [] }));
}

/** a is before b at the precision both share. */
const before = (a, b) => {
  const len = Math.min(a.iso.length, b.iso.length);
  return a.iso.slice(0, len) < b.iso.slice(0, len);
};

/** How a matched Wikidata event is described in a basis. */
function eventNote(e) {
  const plats = e.platforms ?? [];
  if (plats.includes(WINDOWS)) return "for Windows";
  if (!plats.length) return "with no platform given";
  return `for ${plats.join(", ")}`;
}

/**
 * The original release date. Wikidata gives release events (P577 with platform and place).
 *
 * WU-009a3: when Steam records an original release date for the app (GetItems
 * release.original_release_date), that is the date compared, with any Wikidata event, since
 * both claim to be a release of the game. Otherwise the WU-009a2 rule applies unchanged: Steam's
 * store date is compared only with a Wikidata event for Windows, or one with no platform given.
 * Either way, a Steam date later than every Wikidata event is a different release ("distinct").
 */
function compareDate(w, s, wl, sl) {
  const events = eventsOf(w);
  const orig = s?.original_release_date?.parsed ?? null;
  const b = orig ?? s?.release_date?.parsed ?? null;
  const what = orig ? "Steam's original release date" : "Steam store date";
  const values = { wikidata: events, steam: b };
  if (orig) values.steam_basis = "original_release_date";
  if (!events.length) return result("none", null, [], values);
  const earliest = events.reduce((m, e) => (e.iso < m.iso ? e : m), events[0]);
  const original = { iso: earliest.iso, precision: earliest.precision };
  if (!b) return result("single", original, [wl], values);
  const windows = events.filter((e) => (e.platforms ?? []).includes(WINDOWS));
  const unqualified = events.filter((e) => !(e.platforms ?? []).length);
  const others = orig ? events.filter((e) => !windows.includes(e) && !unqualified.includes(e)) : [];
  const hit =
    windows.find((e) => datesAgree(e, b)) ??
    unqualified.find((e) => datesAgree(e, b)) ??
    others.find((e) => datesAgree(e, b));
  if (hit) {
    const common = coarserDate(hit, b);
    const extra = {
      basis: [
        `${what} matches a Wikidata release event ${eventNote(hit)}`,
        hit.iso === earliest.iso
          ? "the earliest Wikidata event"
          : "not the earliest Wikidata event",
      ].join("; "),
    };
    if (hit.iso.length !== b.iso.length) {
      const fromWikidata = hit.iso.length > b.iso.length;
      extra.single_source = {
        source: fromWikidata ? "wikidata" : "steam",
        value: fromWikidata ? { iso: hit.iso, precision: hit.precision } : b,
        link: fromWikidata ? wl : sl,
      };
    }
    return result(
      "agree",
      { iso: common.iso, precision: common.precision },
      [wl, sl],
      values,
      extra,
    );
  }
  if (events.every((e) => before(e, b)))
    return result("distinct", null, [wl, sl], values, {
      basis: `the ${what} is later than every Wikidata release event: a later release, not compared`,
      single_source: { source: "wikidata", value: original, link: wl },
    });
  return result("conflict", null, [wl, sl], values);
}

/** Map company QID -> { names: normalised names Wikidata knows it by, source: the revision read }. */
export function companyNames(records) {
  const m = new Map();
  for (const r of records)
    m.set(r.qid, {
      names: new Set((r.names ?? []).map(normCompany).filter(Boolean)),
      source: link(r.source),
    });
  return m;
}

/**
 * Two lists of names, matched one Steam name at a time. A Wikidata entity is a candidate for a
 * Steam name when the normalised name equals its label or one of its names in companies.jsonl.
 * A Steam name matches only when exactly one entity (by QID) is a candidate; two or more is
 * ambiguous and is kept for review with the candidates listed. Each match is recorded in
 * matches, with the company revision that gave the name.
 *   every Steam name matched -> agree on the matched names; Wikidata's extra names stay single
 *   some Steam name unmatched or ambiguous, some matched -> partial (review)
 *   nothing matched -> conflict (review)
 */
function compareNames(wikidata, steam, names, wl, sl, values, steamNorm = (x) => x) {
  // One entity per QID, in first-seen order.
  const ents = [];
  const seenIds = new Set();
  for (const e of wikidata) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    ents.push(e);
  }
  const matched = [];
  const matches = [];
  const usedW = new Set();
  const unmatchedSteam = [];
  const ambiguous = [];
  const seenSteam = new Set();
  for (const name of steam) {
    const n = normCompany(steamNorm(name));
    // A Steam name that normalises to nothing cannot be matched: it is kept for review.
    if (!n) {
      unmatchedSteam.push(name);
      continue;
    }
    if (seenSteam.has(n)) continue;
    seenSteam.add(n);
    const cands = [];
    ents.forEach((e, i) => {
      const byLabel = normCompany(e.label) === n;
      const byAlias = names.get(e.id)?.names.has(n) ?? false;
      if (byLabel || byAlias) cands.push({ i, method: byLabel ? "label" : "alias" });
    });
    if (cands.length !== 1) {
      if (cands.length > 1)
        ambiguous.push({ steam_name: name, candidates: cands.map((c) => ents[c.i].id) });
      unmatchedSteam.push(name);
      continue;
    }
    const { i, method } = cands[0];
    const e = ents[i];
    if (!usedW.has(i)) matched.push(e.label ?? name);
    usedW.add(i);
    matches.push({
      steam_name: name,
      qid: e.id,
      method,
      company_source: names.get(e.id)?.source ?? null,
    });
  }
  const basis = matches
    .map((m) =>
      m.method === "label"
        ? `"${m.steam_name}" = Wikidata label of ${m.qid}`
        : `"${m.steam_name}" = a Wikidata name of ${m.qid} (${ents.find((e) => e.id === m.qid)?.label ?? "no label"})`,
    )
    .join("; ");
  const sources = [wl, sl, ...matches.map((m) => m.company_source).filter(Boolean)];
  const extraW = ents.filter((_, i) => !usedW.has(i)).map((e) => e.label ?? e.id);
  const evidence = { matches };
  if (ambiguous.length) evidence.ambiguous = ambiguous;
  if (!matched.length) return result("conflict", null, sources, values, evidence);
  if (unmatchedSteam.length)
    return result("partial", matched, sources, values, {
      basis,
      ...evidence,
      unmatched: { wikidata: extraW, steam: unmatchedSteam },
    });
  const extra = { basis, ...evidence };
  if (extraW.length) extra.single_source = { source: "wikidata", values: extraW, link: wl };
  return result("agree", matched, sources, values, extra);
}

function compareCompanies(field, w, s, names, wl, sl) {
  const a = (w[field] ?? []).filter((x) => x?.id);
  const b = s?.[field] ?? [];
  const values = { wikidata: a.map((x) => x.label ?? x.id), steam: b };
  if (a.length && b.length) return compareNames(a, b, names, wl, sl, values, stripPlatformNote);
  if (a.length) return result("single", values.wikidata, [wl], values);
  if (b.length) return result("single", b, [sl], values);
  return result("none", null, [], values);
}

function comparePlatforms(w, s, wl, sl) {
  const a = [...new Set((w.platforms ?? []).map((p) => PC_PLATFORMS[p.id]).filter(Boolean))].sort();
  const b = [...(s?.platforms ?? [])].sort();
  const values = { wikidata: a, steam: b };
  if (a.length && b.length) {
    const ents = a.map((p) => ({ id: p, label: p }));
    return compareNames(ents, b, new Map(), wl, sl, values);
  }
  if (a.length) return result("single", a, [wl], values);
  if (b.length) return result("single", b, [sl], values);
  return result("none", null, [], values);
}

/**
 * Picks the Steam record to compare with: the first listed app of type "game". A record with no
 * type is accepted only from the older appdetails route, whose records carry no route; a Web API
 * record must say it is a game (WU-009a3, Codex pre-dispatch review r1, finding 3).
 */
export function pickSteam(w, steamById) {
  for (const id of w.steam_app_ids ?? []) {
    const s = steamById.get(id);
    if (s?.success && (s.type === "game" || (s.type == null && s.source?.route == null))) return s;
  }
  return null;
}

/** Steam's own store facts, kept as they are: scoped to this app at the fetch time. */
function storeFacts(s, sl) {
  if (!s) return null;
  return {
    scope: `Steam app ${s.appid}, as listed at the fetch time`,
    steam_store_release_date: {
      value: s.release_date?.parsed ?? null,
      raw: s.release_date?.raw ?? null,
      coming_soon: s.release_date?.coming_soon === true,
    },
    steam_store_publishers: s.publishers ?? [],
    steam_original_release_date: s.original_release_date?.parsed ?? null,
    source: sl,
  };
}

export function compare(w, s, names = new Map()) {
  const wl = link(w.source);
  const sl = s ? link(s.source) : null;
  return {
    qid: w.qid,
    steam_appid: s?.appid ?? null,
    fields: {
      title: compareTitle(w, s, wl, sl),
      release_date: compareDate(w, s, wl, sl),
      developers: compareCompanies("developers", w, s, names, wl, sl),
      publishers: compareCompanies("publishers", w, s, names, wl, sl),
      platforms: comparePlatforms(w, s, wl, sl),
    },
    store: storeFacts(s, sl),
    // Single-source context, never compared: kept with their links for later stages.
    context: {
      series: { values: w.series ?? [], source: wl },
      genres_wikidata: { values: w.genres ?? [], source: wl },
      genres_steam: { values: s?.genres ?? [], source: sl },
      wikipedia_title: w.enwiki ?? null,
    },
  };
}

export function run({ dataDir }) {
  const wd = readJsonl(path.join(dataDir, "wikidata.jsonl"));
  if (!wd.length) throw new Error("no wikidata.jsonl: run wikidata-ingest.mjs first");
  const steamById = new Map(readJsonl(path.join(dataDir, "steam.jsonl")).map((s) => [s.appid, s]));
  const companiesFile = path.join(dataDir, "companies.jsonl");
  const names = companyNames(existsSync(companiesFile) ? readJsonl(companiesFile) : []);
  const summary = {
    items: wd.length,
    with_steam_id: 0,
    with_steam_record: 0,
    companies_with_names: names.size,
    fields: {},
  };
  for (const f of FIELDS) summary.fields[f] = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const lines = [];
  const conflicts = [];
  for (const w of wd) {
    if ((w.steam_app_ids ?? []).length) summary.with_steam_id++;
    const s = pickSteam(w, steamById);
    if (s) summary.with_steam_record++;
    const rec = compare(w, s, names);
    for (const f of FIELDS) {
      const r = rec.fields[f];
      summary.fields[f][r.status]++;
      if (REVIEW.has(r.status)) {
        conflicts.push({
          qid: w.qid,
          steam_appid: rec.steam_appid,
          field: f,
          kind: r.status,
          agreed: r.value,
          basis: r.basis ?? null,
          matches: r.matches ?? null,
          ambiguous: r.ambiguous ?? null,
          unmatched: r.unmatched ?? null,
          values: r.values,
          sources: r.sources,
        });
      }
    }
    lines.push(JSON.stringify(rec));
  }
  writeFileSync(path.join(dataDir, "agreement.jsonl"), lines.join("\n") + "\n");
  writeFileSync(
    path.join(dataDir, "conflicts.jsonl"),
    conflicts.map((c) => JSON.stringify(c)).join("\n") + (conflicts.length ? "\n" : ""),
  );
  summary.conflicts = conflicts.length;
  writeFileSync(
    path.join(dataDir, "agreement-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  return summary;
}

export function main(argv, deps = {}) {
  const args = parseCliArgs(argv, { "data-dir": "string" });
  const dataDir = path.resolve(args["data-dir"] ?? DEFAULT_DATA_DIR);
  const summary = run({ dataDir });
  const log = deps.log ?? ((s) => console.log(s));
  log(
    `agreement: ${summary.items} items, ${summary.with_steam_record} compared with Steam, ${summary.conflicts} queued for review`,
  );
  log(JSON.stringify(summary, null, 2));
  return summary;
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(safeMessage(e));
    process.exitCode = 1;
  }
}
