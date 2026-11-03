// WU-009a (#158): the Steam cross-check for titles Wikidata links to Steam (P1733).
// WU-009a3 (task proposal 022): through the official Steam Web API, with the existing key, in
// place of the store's appdetails route (retired by proposal 020). Free; no billed call.
// Facts only: no description, image, price, review text or link beyond the store page is kept.
//
//   doppler run -- node scripts/catalogue/steam-ingest.mjs [games] [--data-dir <dir>] [--limit <n>] [--interval-ms <n>]
//   doppler run -- node scripts/catalogue/steam-ingest.mjs dlc [--data-dir <dir>] [--limit <n>] [--max-pages <n>] [--interval-ms <n>]
//   doppler run -- node scripts/catalogue/steam-ingest.mjs categories [--data-dir <dir>]
//
// games:      the Steam app IDs in <data-dir>/wikidata.jsonl, 100 per GetItems call, appended to
//             steam.jsonl. Resumable: IDs already fetched by this route are skipped.
// dlc:        every DLC Steam lists (IStoreService/GetAppList, paged) into steam-dlc-ids.jsonl,
//             then GetItems on them into steam-dlc.jsonl, each with its parent_appid. Resumable.
// categories: the store's category names (GetStoreCategories, one call) into
//             steam-categories.json.
// One request every 1.5 s by default, never faster than one a second. The key is read from
// STEAM_API_KEY and is never printed or written. The first error of any kind stops the run.
// cspell:words appdetails jsonl steamos elanguage categoryid categoryids descriptorids appid appids
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_DATA_DIR,
  STEAM_WEB_API,
  appendJsonl,
  ensureDir,
  isMain,
  parseCliArgs,
  readJsonl,
  resumeJsonl,
  safeMessage,
  steamAppUrl,
  steamWebApi,
  unixDay,
} from "./lib.mjs";

export const GET_ITEMS = "IStoreBrowseService/GetItems/v1";
export const GET_APP_LIST = "IStoreService/GetAppList/v1";
export const GET_CATEGORIES = "IStoreBrowseService/GetStoreCategories/v1";
export const ROUTE = `Steam Web API ${GET_ITEMS}`;
export const BATCH = 100;
export const DEFAULT_INTERVAL_MS = 1500;

/** The data asked for: facts only. Descriptions, images, videos and prices are not requested. */
export const DATA_REQUEST = Object.freeze({
  include_basic_info: true,
  include_release: true,
  include_platforms: true,
  include_supported_languages: true,
  include_reviews: true,
  include_assets: false,
  include_screenshots: false,
  include_trailers: false,
  include_full_description: false,
  include_all_purchase_options: false,
  include_links: false,
  include_ratings: false,
  include_tag_count: 0,
});

/** The input_json of one GetItems call. Only numeric app IDs are ever sent. */
export function getItemsInput(appids) {
  if (!Array.isArray(appids) || !appids.length || appids.length > BATCH)
    throw new Error(`GetItems takes 1 to ${BATCH} app IDs (got ${appids?.length})`);
  for (const id of appids)
    if (!/^\d+$/.test(String(id))) throw new Error(`not a Steam app ID: ${id}`);
  return JSON.stringify({
    ids: appids.map((id) => ({ appid: Number(id) })),
    context: { language: "english", country_code: "US" },
    data_request: DATA_REQUEST,
  });
}

const TYPES = { 0: "game", 4: "dlc" };
const names = (a) =>
  Array.isArray(a)
    ? a.map((x) => (typeof x?.name === "string" ? x.name.trim() : "")).filter(Boolean)
    : [];
const ids = (a) => (Array.isArray(a) ? a.filter((n) => Number.isSafeInteger(n)) : []);

/**
 * One GetItems store item as a record of facts. An item Steam does not list (success other
 * than 1) is kept with success: false and Steam's code, so it is not asked for again.
 * nowSeconds decides whether a release date is still in the future (coming soon).
 */
export function toRecord(item, fetchedAt, nowSeconds = Math.floor(Date.parse(fetchedAt) / 1000)) {
  const appid = String(item?.id ?? "");
  if (!/^\d+$/.test(appid)) throw new Error("a GetItems store item has no numeric id");
  const source = {
    name: "steam",
    route: ROUTE,
    terms: "Steam Web API terms; facts only",
    url: steamAppUrl(appid),
    fetched_at: fetchedAt,
  };
  if (item.success !== 1)
    return { appid, success: false, steam_status: item.success ?? null, source };
  // A listed item must say what it is: without an integer type it could be compared as a game
  // when it is not one (Codex pre-dispatch review r1, finding 3). It is kept, as not usable.
  if (!Number.isSafeInteger(item.type))
    return { appid, success: false, steam_status: "missing_type", source };
  const rel = item.release ?? {};
  const store = Number.isSafeInteger(rel.steam_release_date) ? rel.steam_release_date : null;
  const comingSoon =
    rel.is_coming_soon === true ||
    (store != null && Number.isFinite(nowSeconds) && store > nowSeconds);
  const original = unixDay(rel.original_release_date);
  const plat = item.platforms ?? {};
  const cats = item.categories ?? {};
  const review = item.reviews?.summary_filtered;
  const typeId = item.type;
  return {
    appid,
    success: true,
    type: TYPES[typeId] ?? `type_${typeId}`,
    type_id: typeId,
    name: typeof item.name === "string" ? item.name : null,
    is_free: item.is_free === true,
    release_date: {
      raw: null,
      unix: store,
      coming_soon: comingSoon,
      parsed: comingSoon ? null : unixDay(store),
    },
    original_release_date: original ? { unix: rel.original_release_date, parsed: original } : null,
    developers: names(item.basic_info?.developers),
    publishers: names(item.basic_info?.publishers),
    franchises: names(item.basic_info?.franchises),
    platforms: [
      ["windows", plat.windows],
      ["mac", plat.mac],
      ["linux", plat.steamos_linux],
    ]
      .filter(([, on]) => on === true)
      .map(([p]) => p),
    steam_deck_compat_category: Number.isSafeInteger(plat.steam_deck_compat_category)
      ? plat.steam_deck_compat_category
      : null,
    categories: {
      player: ids(cats.supported_player_categoryids),
      feature: ids(cats.feature_categoryids),
      controller: ids(cats.controller_categoryids),
    },
    languages: Array.isArray(item.supported_languages)
      ? item.supported_languages
          .filter((l) => l?.supported === true && Number.isSafeInteger(l.elanguage))
          .map((l) => ({
            elanguage: l.elanguage,
            full_audio: l.full_audio === true,
            subtitles: l.subtitles === true,
          }))
      : [],
    parent_appid: Number.isSafeInteger(item.related_items?.parent_appid)
      ? String(item.related_items.parent_appid)
      : null,
    content_descriptorids: ids(item.content_descriptorids),
    reviews:
      review && Number.isSafeInteger(review.review_count)
        ? {
            review_count: review.review_count,
            percent_positive: Number.isFinite(review.percent_positive)
              ? review.percent_positive
              : null,
          }
        : null,
    source,
  };
}

/**
 * One GetItems call for up to 100 app IDs. The response must hold exactly one store item for
 * each ID asked for, by its id; anything else is malformed and stops the run.
 */
export async function getItems(call, appids, fetchedAt) {
  const json = await call(GET_ITEMS, { input_json: getItemsInput(appids) });
  const items = json?.response?.store_items;
  if (!Array.isArray(items))
    throw new Error(`Steam Web API ${GET_ITEMS}: the response has no store_items; stopped`);
  const byId = new Map();
  for (const it of items) {
    const id = String(it?.id ?? "");
    if (!appids.map(String).includes(id) || byId.has(id))
      throw new Error(
        `Steam Web API ${GET_ITEMS}: an item was not asked for, or came twice; stopped`,
      );
    byId.set(id, it);
  }
  if (byId.size !== appids.length)
    throw new Error(
      `Steam Web API ${GET_ITEMS}: ${byId.size} items for ${appids.length} IDs asked for; stopped`,
    );
  return appids.map((id) => toRecord(byId.get(String(id)), fetchedAt));
}

export function steamIdsFrom(wikidataRecords) {
  const out = new Set();
  for (const r of wikidataRecords)
    for (const id of r.steam_app_ids ?? []) if (/^\d+$/.test(id)) out.add(id);
  return [...out].sort((a, b) => Number(a) - Number(b));
}

/** Fetches every ID not already in outFile by this route, BATCH at a time. */
async function fetchAll({ call, ids: all, outFile, limit, now, log, label }) {
  const resumed = resumeJsonl(outFile);
  if (resumed.dropped != null)
    log(
      `${label}: dropped an incomplete last record in ${path.basename(outFile)} (an interrupted run); it will be fetched again`,
    );
  // Only records from this route count as done: an older appdetails record is fetched again.
  const done = new Set(
    resumed.records.filter((r) => r.source?.route === ROUTE).map((r) => r.appid),
  );
  const todo = all.filter((id) => !done.has(id)).slice(0, limit);
  let listed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const recs = await getItems(call, chunk, now().toISOString());
    for (const rec of recs) {
      appendJsonl(outFile, rec);
      if (rec.success) listed++;
    }
    log(`${label}: ${Math.min(i + BATCH, todo.length)}/${todo.length} fetched, ${listed} listed`);
  }
  return {
    requested: todo.length,
    listed,
    remaining: all.filter((id) => !done.has(id)).length - todo.length,
  };
}

export async function ingest({
  dataDir,
  call,
  limit = Infinity,
  now = () => new Date(),
  log = () => {},
}) {
  ensureDir(dataDir);
  const all = steamIdsFrom(readJsonl(path.join(dataDir, "wikidata.jsonl")));
  if (!all.length)
    throw new Error("no Steam app IDs in wikidata.jsonl: run wikidata-ingest.mjs details first");
  return fetchAll({
    call,
    ids: all,
    outFile: path.join(dataDir, "steam.jsonl"),
    limit,
    now,
    log,
    label: "steam",
  });
}

/**
 * Every DLC Steam lists, page by page, into steam-dlc-ids.jsonl. A page's IDs are appended
 * before the next page is asked for, so an interrupted listing continues after the highest ID
 * already written. steam-dlc-ids.done.json marks a finished listing.
 */
export async function listDlc({
  dataDir,
  call,
  now = () => new Date(),
  log = () => {},
  maxPages = Infinity,
}) {
  ensureDir(dataDir);
  const idsFile = path.join(dataDir, "steam-dlc-ids.jsonl");
  const doneFile = path.join(dataDir, "steam-dlc-ids.done.json");
  const resumed = resumeJsonl(idsFile);
  if (existsSync(doneFile))
    return { ids: resumed.records.map((r) => r.appid), pages: 0, complete: true };
  const seen = new Set(resumed.records.map((r) => r.appid));
  let last = resumed.records.reduce((m, r) => Math.max(m, Number(r.appid)), 0);
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) return { ids: [...seen], pages, complete: false };
    const params = {
      include_games: "false",
      include_dlc: "true",
      include_software: "false",
      include_videos: "false",
      include_hardware: "false",
      max_results: "50000",
    };
    if (last > 0) params.last_appid = String(last);
    const json = await call(GET_APP_LIST, params);
    const r = json?.response;
    if (!r || typeof r !== "object")
      throw new Error(
        `Steam Web API ${GET_APP_LIST}: the response has no response object; stopped`,
      );
    // The page is checked whole before anything from it is written (Codex pre-dispatch review
    // r1, finding 2). Steam's JSON leaves out an empty list and a false flag, so a missing
    // apps or have_more_results is read as empty or false; a wrong type is malformed. A first
    // page with no DLC at all is malformed too: Steam lists tens of thousands.
    if (r.apps !== undefined && !Array.isArray(r.apps))
      throw new Error(`Steam Web API ${GET_APP_LIST}: apps is not a list; stopped`);
    if (r.have_more_results !== undefined && typeof r.have_more_results !== "boolean")
      throw new Error(
        `Steam Web API ${GET_APP_LIST}: have_more_results is not true or false; stopped`,
      );
    const apps = r.apps ?? [];
    for (const a of apps)
      if (!Number.isSafeInteger(a?.appid) || a.appid <= 0)
        throw new Error(`Steam Web API ${GET_APP_LIST}: an app without a valid appid; stopped`);
    if (!apps.length && !seen.size)
      throw new Error(`Steam Web API ${GET_APP_LIST}: the first page lists no DLC; stopped`);
    const fetchedAt = now().toISOString();
    let added = 0;
    // In ascending order, so an interrupted page resumes after its highest written ID with
    // nothing below it missed.
    for (const id of apps.map((a) => a.appid).sort((x, y) => x - y)) {
      if (seen.has(String(id))) continue;
      appendJsonl(idsFile, { appid: String(id), listed_at: fetchedAt });
      seen.add(String(id));
      added++;
      last = Math.max(last, id);
    }
    pages++;
    log(`dlc list: page ${pages}, ${seen.size} DLC IDs so far`);
    if (r.have_more_results !== true) break;
    // A page that adds nothing new would repeat for ever: it is a malformed answer.
    if (added === 0)
      throw new Error(`Steam Web API ${GET_APP_LIST}: a page with no new DLC IDs; stopped`);
    const next = Number(r.last_appid);
    if (!Number.isSafeInteger(next) || next <= 0)
      throw new Error(`Steam Web API ${GET_APP_LIST}: more results but no last_appid; stopped`);
    last = Math.max(last, next);
  }
  writeFileSync(
    doneFile,
    `${JSON.stringify({ completed_at: now().toISOString(), count: seen.size })}\n`,
  );
  return { ids: [...seen], pages, complete: true };
}

export async function dlc({
  dataDir,
  call,
  limit = Infinity,
  now = () => new Date(),
  log = () => {},
  maxPages = Infinity,
}) {
  const listed = await listDlc({ dataDir, call, now, log, maxPages });
  const all = [...listed.ids].sort((a, b) => Number(a) - Number(b));
  const r = await fetchAll({
    call,
    ids: all,
    outFile: path.join(dataDir, "steam-dlc.jsonl"),
    limit,
    now,
    log,
    label: "dlc",
  });
  return { ...r, dlc_ids: all.length, listing_complete: listed.complete };
}

/** The store's category IDs with their names and types, from one call. */
export async function categories({ dataDir, call, now = () => new Date() }) {
  const json = await call(GET_CATEGORIES, { input_json: JSON.stringify({ language: "english" }) });
  const list = json?.response?.categories;
  if (!Array.isArray(list) || !list.length)
    throw new Error(`Steam Web API ${GET_CATEGORIES}: the response has no categories; stopped`);
  // Every entry must have an integer categoryid, or nothing is written: a response with malformed
  // entries must not replace a good snapshot with a short or empty list (Codex review of PR #188).
  const bad = list.filter((c) => !Number.isSafeInteger(c?.categoryid)).length;
  if (bad)
    throw new Error(
      `Steam Web API ${GET_CATEGORIES}: ${bad} of ${list.length} categories have no integer categoryid; nothing was written`,
    );
  const out = list
    .map((c) => ({
      categoryid: c.categoryid,
      type: Number.isSafeInteger(c.type) ? c.type : null,
      internal_name: typeof c.internal_name === "string" ? c.internal_name : null,
      display_name: typeof c.display_name === "string" ? c.display_name : null,
    }))
    .sort((a, b) => a.categoryid - b.categoryid);
  ensureDir(dataDir);
  writeFileSync(
    path.join(dataDir, "steam-categories.json"),
    `${JSON.stringify(
      {
        source: {
          name: "steam",
          route: `Steam Web API ${GET_CATEGORIES}`,
          url: STEAM_WEB_API,
          fetched_at: now().toISOString(),
        },
        categories: out,
      },
      null,
      2,
    )}\n`,
  );
  return { categories: out.length };
}

export async function main(argv, deps = {}) {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "games";
  const rest = argv[0] && !argv[0].startsWith("--") ? argv.slice(1) : argv;
  if (!["games", "dlc", "categories"].includes(cmd))
    throw new Error(
      "usage: steam-ingest.mjs [games|dlc|categories] [--data-dir <dir>] [--limit <n>] [--max-pages <n>] [--interval-ms <n>]",
    );
  const args = parseCliArgs(rest, {
    "data-dir": "string",
    limit: "int",
    "interval-ms": "int",
    "max-pages": "int",
  });
  if (args["max-pages"] !== undefined && cmd !== "dlc")
    throw new Error("--max-pages applies only to the dlc step");
  const interval = args["interval-ms"] ?? DEFAULT_INTERVAL_MS;
  if (interval < 1000)
    throw new Error("--interval-ms below 1000 is not allowed (Steam rate limits)");
  const dataDir = path.resolve(args["data-dir"] ?? DEFAULT_DATA_DIR);
  const env = deps.env ?? process.env;
  const call =
    deps.call ??
    steamWebApi({
      key: env.STEAM_API_KEY,
      minIntervalMs: interval,
      fetchImpl: deps.fetchImpl,
      env,
    });
  const log = deps.log ?? ((s) => console.log(s));
  if (cmd === "categories") {
    const r = await categories({ dataDir, call });
    log(`categories: ${r.categories} written to steam-categories.json`);
    return r;
  }
  if (cmd === "dlc") {
    const r = await dlc({ dataDir, call, limit: args.limit, log, maxPages: args["max-pages"] });
    log(
      `dlc: ${r.dlc_ids} DLC IDs (listing ${r.listing_complete ? "complete" : "incomplete"}); ${r.requested} fetched (${r.listed} listed); ${r.remaining} still to fetch`,
    );
    return r;
  }
  const r = await ingest({ dataDir, call, limit: args.limit, log });
  log(`steam: ${r.requested} fetched (${r.listed} listed); ${r.remaining} still to fetch`);
  return r;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(safeMessage(e));
    process.exitCode = 1;
  });
}
