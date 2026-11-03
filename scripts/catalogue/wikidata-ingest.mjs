// WU-009a (#158): read the game backbone from Wikidata (CC0). Free; no billed call.
//
//   node scripts/catalogue/wikidata-ingest.mjs list    [--data-dir <dir>]
//   node scripts/catalogue/wikidata-ingest.mjs details [--data-dir <dir>] [--limit <n>] [--batch <n>]
//   node scripts/catalogue/wikidata-ingest.mjs companies [--data-dir <dir>] [--limit <n>] [--batch <n>]
//   node scripts/catalogue/wikidata-ingest.mjs xids [--data-dir <dir>] [--limit <n>] [--batch <n>]
//
// list:    every item that is an instance of video game (P31 = Q7889), with its current revision,
//          written to <data-dir>/wikidata-ids.jsonl (rewritten each time: it is a snapshot).
// details: for each listed item not yet in <data-dir>/wikidata.jsonl, its English label, release
//          dates with precision, platforms, developers, publishers, series, genres, Steam app IDs
//          (P1733) and English Wikipedia article, appended to <data-dir>/wikidata.jsonl.
//          Resumable: run it again to continue. Each batch is two queries: the details, and every
//          release-date statement with its platform (P400) and place (P291) qualifiers, kept as
//          release_events so a date can be compared with the release it describes (WU-009a2).
// companies: for every developer and publisher in wikidata.jsonl not yet in companies.jsonl, the
//          names Wikidata knows it by (label, aliases, official name; English or "mul"), appended
//          to <data-dir>/companies.jsonl. Agreement uses them to match renamed companies.
//          Resumable. Labels fall back from English to "mul" (the label for all languages).
// xids:    for each listed item not yet in <data-dir>/wikidata-xids.jsonl, its IDs on other
//          catalogues and stores (XID_PROPS: IGDB, MobyGames, the console stores and others) and
//          its aliases (skos:altLabel, English or "mul"), appended to wikidata-xids.jsonl
//          (WU-009a3, task proposal 022). Values are kept exactly as Wikidata gives them.
//          Resumable. Agreement does not read this file.
// Only query.wikidata.org is contacted, one request at a time, with a contact in the User-Agent.
// cspell:words wikidata wikibase sitelink jsonl isPartOf psv altLabel xids mobygames rawg hltb pcgamingwiki opencritic psstore msstore eshop
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_DATA_DIR,
  appendJsonl,
  ensureDir,
  isMain,
  parseCliArgs,
  parseWikidataDate,
  politeFetcher,
  readJsonl,
  safeMessage,
  resumeJsonl,
  wikidataItemUrl,
  wikidataRevisionUrl,
} from "./lib.mjs";

export const ENDPOINT = "https://query.wikidata.org/sparql";
export const SEP = "\u001f"; // unit separator: never in a label
const ENTITY = "http://www.wikidata.org/entity/";

export const LIST_QUERY = `SELECT ?item ?rev WHERE { ?item wdt:P31 wd:Q7889 ; schema:version ?rev . }`;

function multi(prop, v) {
  return `OPTIONAL { ?item wdt:${prop} ?${v} . OPTIONAL { ?${v} rdfs:label ?${v}L FILTER(LANG(?${v}L) = "en") } OPTIONAL { ?${v} rdfs:label ?${v}M FILTER(LANG(?${v}M) = "mul") } }`;
}
function concatPairs(v) {
  return `(GROUP_CONCAT(DISTINCT CONCAT(STRAFTER(STR(?${v}), "${ENTITY}"), "=", COALESCE(?${v}L, ?${v}M, "")); separator="${SEP}") AS ?${v}s)`;
}
function checkQids(qids) {
  for (const q of qids) if (!/^Q[1-9]\d*$/.test(q)) throw new Error(`not a Wikidata item ID: ${q}`);
}

export function detailsQuery(qids) {
  checkQids(qids);
  return `SELECT ?item ?rev ?enwiki (SAMPLE(COALESCE(?labelEn, ?labelMul)) AS ?label)
  (GROUP_CONCAT(DISTINCT ?steam; separator="${SEP}") AS ?steams)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?t), "/", STR(?tp)); separator="${SEP}") AS ?dates)
  ${concatPairs("plat")} ${concatPairs("dev")} ${concatPairs("pub")} ${concatPairs("ser")} ${concatPairs("gen")}
WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  ?item schema:version ?rev .
  OPTIONAL { ?item rdfs:label ?labelEn FILTER(LANG(?labelEn) = "en") }
  OPTIONAL { ?item rdfs:label ?labelMul FILTER(LANG(?labelMul) = "mul") }
  OPTIONAL { ?item wdt:P1733 ?steam }
  OPTIONAL { ?item p:P577/psv:P577 [ wikibase:timeValue ?t ; wikibase:timePrecision ?tp ] }
  ${multi("P400", "plat")}
  ${multi("P178", "dev")}
  ${multi("P123", "pub")}
  ${multi("P179", "ser")}
  ${multi("P136", "gen")}
  OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}
GROUP BY ?item ?rev ?enwiki`;
}

/** Every non-deprecated release-date statement (P577) of the items, with its qualifiers. */
export function releaseEventsQuery(qids) {
  checkQids(qids);
  return `SELECT ?item ?st ?t ?tp ?plat ?place WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  ?item p:P577 ?st .
  ?st psv:P577 [ wikibase:timeValue ?t ; wikibase:timePrecision ?tp ] ;
      wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  OPTIONAL { ?st pq:P400 ?plat }
  OPTIONAL { ?st pq:P291 ?place }
}`;
}

/** The names Wikidata knows each company by: label, aliases and official name, English or "mul". */
export function companiesQuery(qids) {
  checkQids(qids);
  return `SELECT ?c ?rev ?name WHERE {
  VALUES ?c { ${qids.map((q) => `wd:${q}`).join(" ")} }
  ?c schema:version ?rev .
  OPTIONAL {
    { ?c rdfs:label ?name } UNION { ?c skos:altLabel ?name } UNION { ?c wdt:P1448 ?name }
    FILTER(LANG(?name) IN ("en", "mul"))
  }
}`;
}

/**
 * Identifier properties read by the xids step (WU-009a3), keyed by the name stored. Each is a
 * Wikidata external-identifier property; only truthy (best-rank) values are read.
 */
export const XID_PROPS = Object.freeze({
  igdb: "P5794",
  mobygames: "P11688",
  rawg: "P9968",
  hltb: "P2816",
  pcgamingwiki: "P6337",
  opencritic: "P2864",
  psstore_concept: "P12332",
  psstore_na: "P5944",
  msstore: "P5885",
  eshop: "P8084",
  itch: "P12813",
  gog: "P2725",
  humble: "P4477",
  epic: "P6278",
});
const PROP_KEY = Object.fromEntries(Object.entries(XID_PROPS).map(([k, p]) => [p, k]));

/**
 * One row per value: ?prop is the property's wdt: IRI, or skos:altLabel for an alias. An item
 * with no value at all still returns its revision row, so it is recorded and not asked again.
 */
export function xidsQuery(qids) {
  checkQids(qids);
  return `SELECT ?item ?rev ?prop ?v WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  ?item schema:version ?rev .
  OPTIONAL {
    { VALUES ?prop { ${Object.values(XID_PROPS)
      .map((p) => `wdt:${p}`)
      .join(" ")} } ?item ?prop ?v . }
    UNION
    { ?item skos:altLabel ?v . FILTER(LANG(?v) IN ("en", "mul")) BIND(skos:altLabel AS ?prop) }
  }
}`;
}

const WDT = "http://www.wikidata.org/prop/direct/";
const SKOS_ALT = "http://www.w3.org/2004/02/skos/core#altLabel";

/** Rows of xidsQuery() grouped by item: Map qid -> { rev, ids: { key: [values] }, aliases }. */
export function toXids(rows) {
  const byQid = new Map();
  for (const r of rows) {
    const item = val(r, "item");
    if (!item?.startsWith(ENTITY)) continue;
    const qid = item.slice(ENTITY.length);
    if (!/^Q[1-9]\d*$/.test(qid)) continue;
    const e = byQid.get(qid) ?? { rev: val(r, "rev"), ids: new Map(), aliases: new Set() };
    byQid.set(qid, e);
    const prop = val(r, "prop");
    const v = val(r, "v");
    if (!prop || v == null || v === "") continue;
    if (prop === SKOS_ALT) e.aliases.add(v);
    else if (prop.startsWith(WDT)) {
      const key = PROP_KEY[prop.slice(WDT.length)];
      if (!key) continue;
      const set = e.ids.get(key) ?? new Set();
      set.add(v);
      e.ids.set(key, set);
    }
  }
  const out = new Map();
  for (const [qid, e] of byQid) {
    const idsOut = {};
    for (const key of Object.keys(XID_PROPS))
      if (e.ids.has(key)) idsOut[key] = [...e.ids.get(key)].sort();
    out.set(qid, { rev: e.rev, ids: idsOut, aliases: [...e.aliases].sort() });
  }
  return out;
}

const val = (b, k) => b?.[k]?.value ?? null;
const split = (s) => (s ? s.split(SEP).filter(Boolean) : []);

function pairs(s) {
  return split(s)
    .map((p) => {
      const i = p.indexOf("=");
      const id = i < 0 ? p : p.slice(0, i);
      const label = i < 0 ? "" : p.slice(i + 1);
      return /^Q[1-9]\d*$/.test(id) ? { id, label: label || null } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** One SPARQL row of detailsQuery() becomes one record, with links to the revision read. */
export function toRecord(binding, fetchedAt) {
  const item = val(binding, "item");
  if (!item?.startsWith(ENTITY)) return null;
  const qid = item.slice(ENTITY.length);
  const rev = val(binding, "rev");
  const enwiki = val(binding, "enwiki");
  const dates = split(val(binding, "dates"))
    .map((s) => {
      const i = s.lastIndexOf("/");
      return parseWikidataDate(s.slice(0, i), s.slice(i + 1));
    })
    .filter(Boolean)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  const uniqueDates = dates.filter((d, i) => i === 0 || d.iso !== dates[i - 1].iso);
  return {
    qid,
    revision: rev ? Number(rev) : null,
    label: val(binding, "label"),
    release_dates: uniqueDates,
    platforms: pairs(val(binding, "plats")),
    developers: pairs(val(binding, "devs")),
    publishers: pairs(val(binding, "pubs")),
    series: pairs(val(binding, "sers")),
    genres: pairs(val(binding, "gens")),
    steam_app_ids: split(val(binding, "steams"))
      .filter((s) => /^\d+$/.test(s))
      .sort((a, b) => Number(a) - Number(b)),
    enwiki: enwiki
      ? decodeURIComponent(enwiki.replace("https://en.wikipedia.org/wiki/", "")).replace(/_/g, " ")
      : null,
    source: {
      name: "wikidata",
      licence: "CC0-1.0",
      url: wikidataItemUrl(qid),
      revision_url: rev ? wikidataRevisionUrl(qid, rev) : null,
      fetched_at: fetchedAt,
    },
  };
}

const qidOf = (uri) =>
  uri?.startsWith(ENTITY) && /^Q[1-9]\d*$/.test(uri.slice(ENTITY.length))
    ? uri.slice(ENTITY.length)
    : null;

/**
 * Rows of releaseEventsQuery() grouped by statement: Map qid -> [{ iso, precision, platforms,
 * places }], sorted by date. A statement with two platform qualifiers is one event with both.
 */
export function toReleaseEvents(rows) {
  const byStatement = new Map();
  for (const r of rows) {
    const qid = qidOf(val(r, "item"));
    const st = val(r, "st");
    const date = parseWikidataDate(val(r, "t"), val(r, "tp"));
    if (!qid || !st || !date) continue;
    let e = byStatement.get(st);
    if (!e) {
      e = {
        qid,
        iso: date.iso,
        precision: date.precision,
        platforms: new Set(),
        places: new Set(),
      };
      byStatement.set(st, e);
    }
    const plat = qidOf(val(r, "plat"));
    const place = qidOf(val(r, "place"));
    if (plat) e.platforms.add(plat);
    if (place) e.places.add(place);
  }
  const byQid = new Map();
  const byNum = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
  for (const e of byStatement.values()) {
    const list = byQid.get(e.qid) ?? [];
    list.push({
      iso: e.iso,
      precision: e.precision,
      platforms: [...e.platforms].sort(byNum),
      places: [...e.places].sort(byNum),
    });
    byQid.set(e.qid, list);
  }
  for (const list of byQid.values())
    list.sort(
      (a, b) => a.iso.localeCompare(b.iso) || a.platforms.join().localeCompare(b.platforms.join()),
    );
  return byQid;
}

async function sparql(fetchJson, query) {
  const body = new URLSearchParams({ query }).toString();
  const json = await fetchJson(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
    },
    body,
  });
  const rows = json?.results?.bindings;
  if (!Array.isArray(rows)) throw new Error("the SPARQL response has no results.bindings");
  return rows;
}

export async function list({ dataDir, fetchJson, now = () => new Date() }) {
  ensureDir(dataDir);
  const rows = await sparql(fetchJson, LIST_QUERY);
  const fetchedAt = now().toISOString();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const item = val(r, "item");
    if (!item?.startsWith(ENTITY)) continue;
    const qid = item.slice(ENTITY.length);
    if (seen.has(qid)) continue;
    seen.add(qid);
    out.push({ qid, revision: Number(val(r, "rev")), fetched_at: fetchedAt });
  }
  out.sort((a, b) => Number(a.qid.slice(1)) - Number(b.qid.slice(1)));
  writeFileSync(
    path.join(dataDir, "wikidata-ids.jsonl"),
    out.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  return { items: out.length };
}

export function checkBatch(batch) {
  if (!Number.isSafeInteger(batch) || batch < 1)
    throw new Error(`--batch must be a whole number of 1 or more (got ${batch})`);
  return batch;
}

export async function details({
  dataDir,
  fetchJson,
  limit = Infinity,
  batch = 100,
  now = () => new Date(),
  log = () => {},
}) {
  checkBatch(batch);
  const ids = readJsonl(path.join(dataDir, "wikidata-ids.jsonl")).map((r) => r.qid);
  if (!ids.length) throw new Error("no wikidata-ids.jsonl yet: run the list step first");
  const outFile = path.join(dataDir, "wikidata.jsonl");
  const resumed = resumeJsonl(outFile);
  if (resumed.dropped != null)
    log(
      `details: dropped an incomplete last record in ${path.basename(outFile)} (an interrupted run); it will be fetched again`,
    );
  const done = new Set(resumed.records.map((r) => r.qid));
  const todo = ids.filter((q) => !done.has(q)).slice(0, limit);
  let written = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const rows = await sparql(fetchJson, detailsQuery(chunk));
    const events = toReleaseEvents(await sparql(fetchJson, releaseEventsQuery(chunk)));
    const fetchedAt = now().toISOString();
    for (const r of rows) {
      const rec = toRecord(r, fetchedAt);
      if (rec && chunk.includes(rec.qid) && !done.has(rec.qid)) {
        rec.release_events = events.get(rec.qid) ?? [];
        appendJsonl(outFile, rec);
        done.add(rec.qid);
        written++;
      }
    }
    log(
      `details: ${Math.min(i + batch, todo.length)}/${todo.length} requested, ${written} written`,
    );
  }
  return { requested: todo.length, written, remaining: ids.length - done.size };
}

/** The names of every developer and publisher in wikidata.jsonl, for matching renamed companies. */
export async function companies({
  dataDir,
  fetchJson,
  limit = Infinity,
  batch = 200,
  now = () => new Date(),
  log = () => {},
}) {
  checkBatch(batch);
  const wd = readJsonl(path.join(dataDir, "wikidata.jsonl"));
  if (!wd.length) throw new Error("no wikidata.jsonl yet: run the details step first");
  const ids = new Set();
  for (const r of wd)
    for (const c of [...(r.developers ?? []), ...(r.publishers ?? [])]) ids.add(c.id);
  const all = [...ids]
    .filter((q) => /^Q[1-9]\d*$/.test(q))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const outFile = path.join(dataDir, "companies.jsonl");
  const resumed = resumeJsonl(outFile);
  if (resumed.dropped != null)
    log(
      `companies: dropped an incomplete last record in ${path.basename(outFile)} (an interrupted run); it will be fetched again`,
    );
  const done = new Set(resumed.records.map((r) => r.qid));
  const todo = all.filter((q) => !done.has(q)).slice(0, limit);
  let written = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const rows = await sparql(fetchJson, companiesQuery(chunk));
    const fetchedAt = now().toISOString();
    const found = new Map();
    for (const r of rows) {
      const qid = qidOf(val(r, "c"));
      if (!qid || !chunk.includes(qid)) continue;
      const e = found.get(qid) ?? { rev: val(r, "rev"), names: new Set() };
      const name = val(r, "name");
      if (name) e.names.add(name);
      found.set(qid, e);
    }
    // Every requested company is written, even with no English name, so it is not asked again.
    for (const qid of chunk) {
      if (done.has(qid)) continue;
      const e = found.get(qid);
      appendJsonl(outFile, {
        qid,
        names: e ? [...e.names].sort() : [],
        source: {
          name: "wikidata",
          licence: "CC0-1.0",
          url: wikidataItemUrl(qid),
          revision_url: e?.rev ? wikidataRevisionUrl(qid, e.rev) : null,
          fetched_at: fetchedAt,
        },
      });
      done.add(qid);
      written++;
    }
    log(
      `companies: ${Math.min(i + batch, todo.length)}/${todo.length} requested, ${written} written`,
    );
  }
  return { requested: todo.length, written, remaining: all.length - done.size };
}

/** Each listed item's cross-catalogue IDs and aliases (WU-009a3), into wikidata-xids.jsonl. */
export async function xids({
  dataDir,
  fetchJson,
  limit = Infinity,
  batch = 200,
  now = () => new Date(),
  log = () => {},
}) {
  checkBatch(batch);
  const ids = readJsonl(path.join(dataDir, "wikidata-ids.jsonl")).map((r) => r.qid);
  if (!ids.length) throw new Error("no wikidata-ids.jsonl yet: run the list step first");
  const outFile = path.join(dataDir, "wikidata-xids.jsonl");
  const resumed = resumeJsonl(outFile);
  if (resumed.dropped != null)
    log(
      `xids: dropped an incomplete last record in ${path.basename(outFile)} (an interrupted run); it will be fetched again`,
    );
  const done = new Set(resumed.records.map((r) => r.qid));
  const todo = ids.filter((q) => !done.has(q)).slice(0, limit);
  let written = 0;
  let withIds = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const found = toXids(await sparql(fetchJson, xidsQuery(chunk)));
    const fetchedAt = now().toISOString();
    // An item the query did not return (deleted or redirected since the list) is not written,
    // so it stays in the remaining count rather than being recorded as having no IDs.
    for (const qid of chunk) {
      const e = found.get(qid);
      if (!e || done.has(qid)) continue;
      const rec = {
        qid,
        revision: e.rev ? Number(e.rev) : null,
        ids: e.ids,
        aliases: e.aliases,
        source: {
          name: "wikidata",
          licence: "CC0-1.0",
          url: wikidataItemUrl(qid),
          revision_url: e.rev ? wikidataRevisionUrl(qid, e.rev) : null,
          fetched_at: fetchedAt,
        },
      };
      appendJsonl(outFile, rec);
      done.add(qid);
      written++;
      if (Object.keys(e.ids).length) withIds++;
    }
    log(
      `xids: ${Math.min(i + batch, todo.length)}/${todo.length} requested, ${written} written, ${withIds} with at least one ID`,
    );
  }
  return { requested: todo.length, written, with_ids: withIds, remaining: ids.length - done.size };
}

export async function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const args = parseCliArgs(rest, { "data-dir": "string", limit: "int", batch: "int" });
  if (args.batch !== undefined) checkBatch(args.batch);
  const dataDir = path.resolve(args["data-dir"] ?? DEFAULT_DATA_DIR);
  const fetchJson = deps.fetchJson ?? politeFetcher({ minIntervalMs: 1000 });
  const log = deps.log ?? ((s) => console.log(s));
  if (cmd === "list") {
    const r = await list({ dataDir, fetchJson });
    log(`list: ${r.items} video game items -> wikidata-ids.jsonl`);
    return r;
  }
  if (cmd === "details") {
    const r = await details({
      dataDir,
      fetchJson,
      limit: args.limit,
      batch: args.batch ?? 100,
      log,
    });
    log(`details: ${r.written} written; ${r.remaining} items still to fetch`);
    return r;
  }
  if (cmd === "companies") {
    const r = await companies({
      dataDir,
      fetchJson,
      limit: args.limit,
      batch: args.batch ?? 200,
      log,
    });
    log(`companies: ${r.written} written; ${r.remaining} companies still to fetch`);
    return r;
  }
  if (cmd === "xids") {
    const r = await xids({
      dataDir,
      fetchJson,
      limit: args.limit,
      batch: args.batch ?? 200,
      log,
    });
    log(
      `xids: ${r.written} written (${r.with_ids} with at least one ID); ${r.remaining} items still to fetch`,
    );
    return r;
  }
  throw new Error(
    "usage: wikidata-ingest.mjs list|details|companies|xids [--data-dir <dir>] [--limit <n>] [--batch <n>]",
  );
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(safeMessage(e));
    process.exitCode = 1;
  });
}
