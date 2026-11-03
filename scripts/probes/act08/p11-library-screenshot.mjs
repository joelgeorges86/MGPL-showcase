// ACT-08 P-11: reading a user's game-library page from a picture (task proposal 021,
// WU-008 item 1).
//
// For each page image (PNG or JPEG, up to 5), Gemini 3.8 Flash (global endpoint) returns one
// row per game tile:
// the title, the PS4/PS5 badges and the PS Plus badge. The rows are scored against a reference
// list of the library's titles (--reference, one title per line; proposal 021, Addendum 3):
// how many tiles were read against how many the page holds (--tiles-per-page), and how many of
// the titles read are on the list. The list is not exact page-by-page truth, so a title that is
// not on it is a possible misreading for the operator to check, not a proven one. Badges are
// counted, not scored. The rows are matched to the catalogue offline
// (scripts/catalogue/match-titles.mjs). A title left with several candidates
// gets one short text request asking the model to choose; its answer is only a suggestion.
//
// PRIVACY (proposal 021, section 6): a library is personal data. This script prints counts only,
// never a title. Everything it writes goes to --out, a folder OUTSIDE the repository, which is
// the output location its AGENTS.md section 3.1 entry names: the per-title results, and an
// aggregate record with counts, costs and timings and no title, image or file name. Request
// bodies (which hold the image) are never written anywhere.
//
// It is dry-run by default. On --run it opens a run through the section 3.1 guard in lib.mjs
// for the entry given by --entry, which must name this script. The Principal Operator runs it.
//
//   node scripts/probes/act08/p11-library-screenshot.mjs --pages <dir> --catalogue <dir>
//        [--reference <titles.txt>] [--tiles-per-page <n>]
//   node scripts/probes/act08/p11-library-screenshot.mjs --run --entry "#NNN" --pages <dir> \
//        --catalogue <dir> --out <dir outside the repository> [--reference <titles.txt>]
// cspell:words aiplatform jsonl xids

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_PATH,
  GuardRefusal,
  ROOT,
  UsageError,
  computeGenerateCost,
  createCapture,
  createClient,
  expectedEndpoint,
  forbidNetwork,
  gcpDir,
  isMain,
  loadRates,
  maxRequestCostUsd,
  openRun,
  parseArgs,
  parseAuthorizations,
  printDryRun,
  rateRef,
  readLedger,
  round,
  sumComputedCosts,
  summarizeLedger,
  utcStamp,
} from "./lib.mjs";
import {
  buildIndex,
  isInside,
  matchLibrary,
  privateCliMessage,
  summarize,
} from "../../catalogue/match-titles.mjs";
import { normTitle, readJsonl } from "../../catalogue/lib.mjs";

export const PROBE = "p11-library-screenshot";
export const MODEL = "gemini-3.8-flash";
/** Gemini 3.8 Flash is served on the global endpoint only (countTokens check, 2026-10-13). */
export const P11_LOCATION = "global";
export const MAX_PAGES = 5;
export const MAX_OUTPUT_TOKENS = 4096;
export const CHOICE_MAX_OUTPUT_TOKENS = 256;
/** Gemini 3 takes a thinking level, not a budget; "minimal" is refused by 3.8 Flash. */
export const THINKING_LEVEL = "LOW";
export const MAX_CHOICES = 20;
/** A title with more candidates than this is left ambiguous, with no choice request. */
export const MAX_CHOICE_CANDIDATES = 5;
/** Characters of a title or a candidate's label that a choice prompt carries. */
export const CHOICE_TEXT_CHARS = 120;
export const TILES_PER_PAGE = 24;
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

export const READ_PROMPT = [
  "This is a picture of one page of a PlayStation game library.",
  "List every game tile on the page, in reading order, once per tile.",
  "For each tile give: title, exactly as printed on the tile; platforms, the platform badges",
  'printed on the tile ("PS4", "PS5"); ps_plus, true only if the tile shows a PS Plus badge;',
  "and position, starting at 1. Do not add games that are not on the page, and do not correct",
  "or complete a title.",
].join(" ");

/** The response schema for one page: the tiles, in order. */
export const TILES_SCHEMA = Object.freeze({
  type: "OBJECT",
  properties: {
    tiles: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          platforms: { type: "ARRAY", items: { type: "STRING", enum: ["PS4", "PS5"] } },
          ps_plus: { type: "BOOLEAN" },
          position: { type: "INTEGER" },
        },
        required: ["title", "platforms", "ps_plus", "position"],
      },
    },
  },
  required: ["tiles"],
});

export const CHOICE_SCHEMA = Object.freeze({
  type: "OBJECT",
  properties: { choice: { type: "INTEGER", nullable: true } },
  required: ["choice"],
});

/** The page images in a folder, sorted by name. */
export function findPages(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory())
    throw new UsageError("--pages must be a folder that holds the page images");
  const pages = readdirSync(dir)
    .filter((f) => IMAGE_TYPES[path.extname(f).toLowerCase()])
    .sort()
    .map((f) => {
      return {
        image: path.join(dir, f),
        mimeType: IMAGE_TYPES[path.extname(f).toLowerCase()],
        bytes: statSync(path.join(dir, f)).size,
      };
    });
  if (!pages.length) throw new UsageError("--pages holds no .png, .jpg or .jpeg image");
  if (pages.length > MAX_PAGES)
    throw new UsageError(`--pages holds ${pages.length} images; at most ${MAX_PAGES} are read`);
  return pages;
}

/** Whether two folders are the same, ignoring letter case on Windows. */
export function samePath(a, b, platform = process.platform) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** --out must not be inside the repository: per-title results are personal data. */
export function checkOutDir(out, root = ROOT) {
  if (!out) throw new UsageError("--run needs --out <folder outside the repository>");
  // Resolves links and junctions, and treats a name like "..private" as inside (Codex
  // pre-dispatch review of WU-021, finding 3).
  if (isInside(out, root)) throw new UsageError("--out must be a folder outside the repository");
  return path.resolve(out);
}

export function readParams(page, data) {
  return {
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: READ_PROMPT }, { inlineData: { mimeType: page.mimeType, data } }],
      },
    ],
    config: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
      responseMimeType: "application/json",
      responseSchema: TILES_SCHEMA,
    },
  };
}

const cap = (t) => String(t ?? "").slice(0, CHOICE_TEXT_CHARS);
/** A four-digit year, or "unknown" (the longer text) for anything else (Codex re-review r3, finding 2). */
const yearText = (y) => (Number.isInteger(y) && y >= 1000 && y <= 9999 ? String(y) : "unknown");
const PS_BADGES = ["PS4", "PS5"];

/**
 * The choice prompt. Its size is bounded so that the planned reservation holds for any input
 * (Codex re-review r2, finding 2): at most MAX_CHOICE_CANDIDATES candidates, each title and
 * label cut to CHOICE_TEXT_CHARS characters, and only the PS4/PS5 badges.
 */
export function choicePrompt(game, candidates) {
  if (candidates.length > MAX_CHOICE_CANDIDATES)
    throw new Error(`a choice prompt takes at most ${MAX_CHOICE_CANDIDATES} candidates`);
  const badges = (list) => PS_BADGES.filter((b) => (list ?? []).includes(b));
  const lines = candidates.map(
    (c, i) =>
      `${i + 1}. ${cap(c.label ?? c.qid)} (first released ${yearText(c.first_year)}; PlayStation: ${badges(c.playstation).join(", ") || "none listed"})`,
  );
  return [
    `A PlayStation library tile reads "${cap(game.title)}", with the badges ${badges(game.platforms).join(", ") || "none"}.`,
    "Which of these catalogue entries is that game? Answer with its number, or null if you",
    "cannot tell from this information.",
    ...lines,
  ].join("\n");
}

export function choiceParams(game, candidates) {
  return {
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: choicePrompt(game, candidates) }] }],
    config: {
      maxOutputTokens: CHOICE_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
      responseMimeType: "application/json",
      responseSchema: CHOICE_SCHEMA,
    },
  };
}

/**
 * The largest bound any choice request can have: the most candidates, every title and label at
 * the character cap in the character JSON escapes most (a control character, 6 bytes), both
 * badges, and an unknown year (the longest year text). Real choice bodies are never larger.
 */
export function worstChoiceBound(rates) {
  const t = "\u0001".repeat(CHOICE_TEXT_CHARS);
  const cands = Array.from({ length: MAX_CHOICE_CANDIDATES }, (_, i) => ({
    qid: `Q${i}`,
    label: t,
    first_year: null,
    playstation: PS_BADGES,
  }));
  return maxRequestCostUsd(
    rates,
    MODEL,
    vertexBody(choiceParams({ title: t, platforms: PS_BADGES }, cands)),
  ).max_cost_usd;
}

/** The reservation the whole plan needs: every page's bound and MAX_CHOICES worst choices. */
export function planUsd(pageBounds, choiceBound) {
  return Math.ceil((pageBounds.reduce((n, b) => n + b, 0) + MAX_CHOICES * choiceBound) * 1e6) / 1e6;
}

/**
 * The JSON body @google/genai sends to Vertex for one of these requests, for the dry-run's
 * bound. A unit test compares it with the SDK's own output.
 */
export function vertexBody(params) {
  const { contents, config } = params;
  const gc = {
    maxOutputTokens: config.maxOutputTokens,
    responseMimeType: config.responseMimeType,
    responseSchema: config.responseSchema,
    thinkingConfig: config.thinkingConfig,
  };
  return JSON.stringify({ contents, generationConfig: gc });
}

/**
 * The reference list: one title per line; blank lines and lines starting with # are skipped.
 * Returns the set of normalized titles (scripts/catalogue/lib.mjs normTitle).
 */
export function readReference(text) {
  const set = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const k = normTitle(t);
    if (k) set.add(k);
  }
  return set;
}

/**
 * One page's reading score (proposal 021, Addendum 3). completeness is the tiles read against
 * the tiles the page holds. precision is the share of the distinct titles read that are on the
 * reference list; with no list it is null. Badges are counted, not scored. notInReference holds
 * the titles read that are not on the list: they go to the local results only, never to the
 * aggregate or the console.
 */
export function scoreReading(read, reference, expectedTiles) {
  const distinct = new Map();
  for (const r of read) {
    const k = normTitle(r.title);
    if (k && !distinct.has(k)) distinct.set(k, r.title);
  }
  const notInReference = reference
    ? [...distinct].filter(([k]) => !reference.has(k)).map(([, t]) => t)
    : [];
  const inRef = distinct.size - notInReference.length;
  return {
    score: {
      expected_tiles: expectedTiles,
      read_tiles: read.length,
      completeness: expectedTiles ? round(read.length / expectedTiles) : null,
      distinct_titles: distinct.size,
      in_reference: reference ? inRef : null,
      not_in_reference: reference ? notInReference.length : null,
      precision: reference && distinct.size ? round(inRef / distinct.size) : null,
      badges_counted_not_scored: {
        ps4: read.filter((r) => r.platforms.includes("PS4")).length,
        ps5: read.filter((r) => r.platforms.includes("PS5")).length,
        ps_plus: read.filter((r) => r.ps_plus).length,
        no_platform: read.filter((r) => !r.platforms.length).length,
      },
    },
    notInReference,
  };
}

/** What the probe's entry has left: requests and dollars, from AGENTS.md and the ledger. */
export async function entryHeadroom({ entry, dir, agentsPath = AGENTS_PATH }) {
  const auth = parseAuthorizations(await readFile(agentsPath, "utf8"));
  const e = auth.entries.find((x) => x.id === entry);
  if (!e) throw new UsageError(`AGENTS.md section 3.1 has no entry ${entry}`);
  const sum = summarizeLedger(readLedger(gcpDir(dir)));
  const used = sum.attemptsByEntry.get(entry) ?? 0;
  const liabilities = [...sum.runs.values()]
    .filter((r) => r.entry === entry)
    .reduce((n, r) => n + r.liability_usd, 0);
  return {
    requests: e.request_cap - used,
    usd: Math.floor((e.dollar_cap_usd - liabilities) * 100 + 1e-9) / 100,
    lane: e.lane,
    writes_to: e.writes_to,
  };
}

async function send(ai, params, rates) {
  const t0 = Date.now();
  try {
    const res = await ai.models.generateContent(params);
    let value = null;
    let parseError = null;
    const raw = typeof res.text === "string" ? res.text : null;
    try {
      value = JSON.parse(raw);
    } catch {
      parseError = "not JSON";
    }
    return {
      latency_ms: Date.now() - t0,
      usage: res.usageMetadata ?? null,
      cost: computeGenerateCost(rates, MODEL, res.usageMetadata),
      value,
      raw,
      parse_error: parseError,
    };
  } catch (e) {
    return {
      latency_ms: Date.now() - t0,
      error: { name: e?.name, status: e?.status ?? null, message: String(e?.message ?? e) },
    };
  }
}

/**
 * What is wrong with a page response, or null if it is usable: JSON with a tiles list whose every
 * tile has a non-empty title, a platforms list of PS4/PS5 only, a ps_plus flag and a position
 * (Codex pre-dispatch review of WU-021, finding 5). An unusable response stops the run.
 */
export function tilesProblem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not an object";
  if (!Array.isArray(value.tiles)) return "no tiles list";
  for (const t of value.tiles) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return "a tile is not an object";
    if (typeof t.title !== "string" || !t.title.trim()) return "a tile has no title";
    if (!Array.isArray(t.platforms) || !t.platforms.every((p) => p === "PS4" || p === "PS5"))
      return "a tile's platforms are not PS4 or PS5";
    if (typeof t.ps_plus !== "boolean") return "a tile's ps_plus is not true or false";
    if (!Number.isInteger(t.position)) return "a tile's position is not a whole number";
  }
  return null;
}

/** What is wrong with a choice response for n candidates, or null: a choice of 1..n, or null. */
export function choiceProblem(value, n) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not an object";
  if (!("choice" in value)) return "no choice";
  if (value.choice === null) return null;
  if (!Number.isInteger(value.choice) || value.choice < 1 || value.choice > n)
    return "the choice is not one of the candidates";
  return null;
}

function rowsOf(value) {
  return value.tiles.map((t) => ({
    title: t.title.trim(),
    platforms: [...new Set(t.platforms)],
    ps_plus: t.ps_plus,
  }));
}

/**
 * deps (tests only): dir (records folder), agentsPath, makeClient(capture), baseFetch, now,
 * root (for the --out check), log.
 */
export async function main(argv, deps = {}) {
  const args = parseArgs(argv, {
    entry: "string",
    pages: "string",
    catalogue: "string",
    out: "string",
    reference: "string",
    "tiles-per-page": "int",
    "show-refusal": "boolean",
  });
  const log = deps.log ?? ((s) => console.log(s));
  const pages = findPages(args.pages);
  if (!args.catalogue || !existsSync(path.join(args.catalogue, "wikidata.jsonl")))
    throw new UsageError("--catalogue must be the folder that holds wikidata.jsonl");
  if (args.reference && !existsSync(args.reference))
    throw new UsageError("--reference must be a text file of titles, one per line");
  const reference = args.reference ? readReference(readFileSync(args.reference, "utf8")) : null;
  if (reference && !reference.size) throw new UsageError("--reference holds no title");
  const tilesPerPage = args["tiles-per-page"] ?? TILES_PER_PAGE;
  const endpoint = expectedEndpoint(MODEL, "generateContent", P11_LOCATION);
  const rates = await loadRates();

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      const bounds = pages.map((p) => {
        const data = readFileSync(p.image).toString("base64");
        return maxRequestCostUsd(rates, MODEL, vertexBody(readParams(p, data))).max_cost_usd;
      });
      const choiceBound = worstChoiceBound(rates);
      const plan = planUsd(bounds, choiceBound);
      printDryRun([
        `probe: ${PROBE}; the AGENTS.md section 3.1 entry is given with --entry on --run`,
        `model: ${MODEL}; endpoint (expected): ${endpoint}`,
        `pages: ${pages.length}; tiles per page: ${tilesPerPage}; reference titles: ${reference ? reference.size : "none (the reading is not scored for precision)"}`,
        ...bounds.map(
          (b, i) => `  page ${i + 1}: guard bound $${b} (the reservation, not the cost)`,
        ),
        `then up to ${MAX_CHOICES} choice requests for titles with several candidates, bound $${choiceBound} each`,
        `plan: $${plan} reserved at most (every page bound and ${MAX_CHOICES} choices); --run refuses to start if the entry has less left`,
        `every request: schema-constrained JSON, thinking level ${THINKING_LEVEL}, no SDK retries`,
        "outputs on --run: only in --out, outside the repository; the console shows counts only",
      ]);
    } finally {
      restore();
    }
    return 0;
  }

  if (!args.entry || !/^#\d+$/.test(args.entry))
    throw new UsageError('--run needs --entry "#NNN", the section 3.1 entry for this script');
  const out = checkOutDir(args.out, deps.root ?? ROOT);
  const index = buildIndex(
    readJsonl(path.join(args.catalogue, "wikidata.jsonl")),
    readJsonl(path.join(args.catalogue, "wikidata-xids.jsonl")),
  );
  const headroom = await entryHeadroom({
    entry: args.entry,
    dir: deps.dir,
    agentsPath: deps.agentsPath,
  });
  // AGENTS.md section 3.1, condition 8: the run writes only to the output location its entry
  // names. A relative location is read from the repository root.
  if (!samePath(path.resolve(deps.root ?? ROOT, headroom.writes_to), out))
    throw new UsageError(
      `--out must be the output location entry ${args.entry} names in AGENTS.md section 3.1`,
    );
  // The whole plan must fit what the entry has left before anything is sent, so the run never
  // stops part-way for lack of headroom (Codex re-review r2, finding 2).
  const pageBounds = pages.map(
    (p) =>
      maxRequestCostUsd(
        rates,
        MODEL,
        vertexBody(readParams(p, readFileSync(p.image).toString("base64"))),
      ).max_cost_usd,
  );
  const plan = planUsd(pageBounds, worstChoiceBound(rates));
  if (plan > headroom.usd)
    throw new UsageError(
      `the plan needs up to $${plan}; entry ${args.entry} has $${headroom.usd} left`,
    );
  if (pages.length + MAX_CHOICES > headroom.requests)
    throw new UsageError(
      `the plan needs up to ${pages.length + MAX_CHOICES} requests; entry ${args.entry} has ${headroom.requests} left`,
    );
  const now = deps.now ?? Date.now;
  const run = openRun({
    entry: args.entry,
    scriptUrl: import.meta.url,
    maxRequests: headroom.requests,
    maxUsd: headroom.usd,
    rates,
    dir: deps.dir,
    agentsPath: deps.agentsPath,
    now,
  });

  const interrupts = deps.interrupts ?? process;
  let stop = null;
  const onSigint = () => {
    stop = stop ?? "operator interrupt (SIGINT)";
  };
  interrupts.once("SIGINT", onSigint);
  let endStatus = "failed";
  let capture = null;
  const full = { pages: [], choices: [] };
  const costs = [];
  const latencies = { read: [], choice: [] };
  const tokens = { read: [], choice: [] };
  let results = [];
  const scores = [];
  try {
    capture = createCapture({
      maxRequests: headroom.requests,
      guard: run,
      ...(deps.baseFetch ? { baseFetch: deps.baseFetch } : {}),
    });
    const ai = deps.makeClient
      ? deps.makeClient(capture)
      : await createClient(capture, {}, P11_LOCATION);
    const rows = [];
    for (const [i, p] of pages.entries()) {
      if (stop) break;
      const data = (await readFile(p.image)).toString("base64");
      const r = await send(ai, readParams(p, data), rates);
      if (r.error) {
        stop = `page ${i + 1} failed: ${r.error.status ?? ""} ${r.error.name ?? ""}`.trim();
        full.pages.push({ page: i + 1, error: r.error });
        break;
      }
      costs.push(r.cost);
      latencies.read.push(r.latency_ms);
      tokens.read.push(r.usage);
      const problem = r.parse_error ?? tilesProblem(r.value);
      if (problem) {
        stop = `page ${i + 1}: unusable response (${problem})`;
        // The raw response stays in the local results only.
        full.pages.push({ page: i + 1, unusable: problem, raw: r.raw });
        break;
      }
      const read = rowsOf(r.value);
      const { score, notInReference } = scoreReading(read, reference, tilesPerPage);
      scores.push(score);
      rows.push(...read);
      full.pages.push({
        page: i + 1,
        read,
        not_in_reference: notInReference,
        score,
      });
    }
    results = matchLibrary(index, rows);
    for (const res of results) {
      if (stop || res.status !== "ambiguous") continue;
      if (res.candidates.length > MAX_CHOICE_CANDIDATES) {
        full.choices.push({ title: res.title, skipped: "too many candidates" });
        continue;
      }
      if (full.choices.filter((c) => !c.skipped).length >= MAX_CHOICES) break;
      const r = await send(ai, choiceParams(res, res.candidates), rates);
      if (r.error) {
        stop = `a choice request failed: ${r.error.status ?? ""} ${r.error.name ?? ""}`.trim();
        break;
      }
      costs.push(r.cost);
      latencies.choice.push(r.latency_ms);
      tokens.choice.push(r.usage);
      const problem = r.parse_error ?? choiceProblem(r.value, res.candidates.length);
      if (problem) {
        stop = `a choice request: unusable response (${problem})`;
        full.choices.push({ title: res.title, unusable: problem, raw: r.raw });
        break;
      }
      const n = r.value.choice;
      const picked = n === null ? null : res.candidates[n - 1].qid;
      full.choices.push({ title: res.title, choice: n, picked });
      if (picked) {
        res.status = "suggested";
        res.method = `${res.method}+model_choice`;
        res.chosen = picked;
      }
    }
    endStatus = stop ? (stop.startsWith("operator") ? "stopped" : "failed") : "completed";
  } catch (e) {
    stop = stop ?? `unexpected: ${e?.name ?? "error"}`;
    full.error = { name: e?.name, message: String(e?.message ?? e) };
  } finally {
    interrupts.removeListener("SIGINT", onSigint);
    run.end(endStatus);
  }

  const sent = capture ? capture.attempts : 0;
  const totals = sumComputedCosts(costs);
  const stamp = utcStamp(new Date(now()));
  // The aggregate record: counts, costs and timings only. No title, image, file name or path.
  const aggregate = {
    probe: PROBE,
    ledger_entry: args.entry,
    run_id: run.run_id,
    executed_by: `${headroom.lane}, the lane AGENTS.md section 3.1 entry ${args.entry} names`,
    model: MODEL,
    endpoint_expected: endpoint,
    rate: rateRef(rates, MODEL),
    reservation: { max_requests: headroom.requests, max_usd: headroom.usd },
    pages: pages.length,
    tiles_per_page: tilesPerPage,
    reference_titles: reference ? reference.size : null,
    requests_sent: sent,
    stop_reason: stop,
    reading: scores,
    matching: summarize(results),
    access: results.reduce((m, r) => {
      for (const a of Object.values(r.access ?? {})) m[a] = (m[a] ?? 0) + 1;
      return m;
    }, {}),
    choices: {
      asked: full.choices.filter((c) => !c.skipped).length,
      picked: full.choices.filter((c) => c.picked).length,
      skipped_too_many_candidates: full.choices.filter((c) => c.skipped).length,
    },
    wrongly_confirmed:
      "to be checked by the operator in the local results; titles not on the reference list are listed there per page",
    latency_ms: latencies,
    usage: tokens,
    computed_cost_usd: totals.computed_cost_usd,
    computed_cost_totals: totals,
    note: "computed_cost_usd is computed from usage and rates.json, not charged; reconciliation against the billing export follows (AGENTS.md section 3.1)",
  };
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, `${PROBE}-${stamp}-aggregate.json`),
    `${JSON.stringify(aggregate, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(out, `${PROBE}-${stamp}-results.json`),
    `${JSON.stringify({ run_id: run.run_id, ...full, results }, null, 2)}\n`,
    "utf8",
  );
  const s = aggregate.matching.by_status;
  log(
    `${PROBE}: ${stop ? `STOPPED (${stop})` : "done"}; run ${run.run_id}; requests ${sent}; pages ${pages.length}; games ${aggregate.matching.titles}; ${JSON.stringify(s)}; computed_cost_usd ${totals.computed_cost_usd ?? "unpriceable"}; written to --out`,
  );
  return stop ? 1 : 0;
}

// The console boundary: a game library is personal data. A usage message is shown only when it
// is one of this script's fixed messages (numbers and the validated entry ID are the only values
// they carry); a message that would carry an argument's value is replaced by a fixed one. A run
// guard refusal shows its check and, if it names no file, its reason. Any other error shows only
// its type (Codex pre-dispatch review of WU-021, finding 2; re-review r2, finding 1).
const KNOWN_FLAGS = new Set([
  "show-refusal",
  "run",
  "dry-run",
  "entry",
  "pages",
  "catalogue",
  "out",
  "reference",
  "tiles-per-page",
]);
export const USAGE_MESSAGES = Object.freeze([
  /^--pages must be a folder that holds the page images$/,
  /^--pages holds no \.png, \.jpg or \.jpeg image$/,
  /^--pages holds \d+ images; at most \d+ are read$/,
  /^--catalogue must be the folder that holds wikidata\.jsonl$/,
  /^--reference must be a text file of titles, one per line$/,
  /^--reference holds no title$/,
  /^--run needs --out <folder outside the repository>$/,
  /^--out must be a folder outside the repository$/,
  /^--run needs --entry "#NNN", the section 3\.1 entry for this script$/,
  /^--out must be the output location entry #\d+ names in AGENTS\.md section 3\.1$/,
  /^AGENTS\.md section 3\.1 has no entry #\d+$/,
  /^the plan needs up to \$[0-9.]+; entry #\d+ has \$[0-9.]+ left$/,
  /^the plan needs up to \d+ requests; entry #\d+ has -?\d+ left$/,
  /^Pass --run or --dry-run, not both$/,
]);

export function usageMessage(message) {
  const m = String(message);
  if (USAGE_MESSAGES.some((re) => re.test(m))) return m;
  if (m.startsWith("Unknown flag: ")) return "unknown flag (not shown)";
  if (m.startsWith("Unexpected argument: ")) return "unexpected argument (not shown)";
  let x = /^--([a-z-]+) needs a value$/.exec(m);
  if (x && KNOWN_FLAGS.has(x[1])) return m;
  x = /^--([a-z-]+) must be a positive integer, got /.exec(m);
  if (x && KNOWN_FLAGS.has(x[1]))
    return `--${x[1]} must be a positive integer (the value is not shown)`;
  return "usage error (details not shown)";
}

export function cliMessage(e, showRefusal = false) {
  if (e instanceof UsageError) return usageMessage(e.message);
  if (e instanceof GuardRefusal) {
    // The check only: a reason can name a record file (Codex re-review r3, finding 1). The
    // operator sees the full reason with --show-refusal, on the operator's own console.
    const check = typeof e.check === "string" && /^[a-z0-9-]+$/.test(e.check) ? e.check : "?";
    return showRefusal
      ? e.message
      : `RUN GUARD REFUSED (${check}); the reason is not shown (add --show-refusal to see it)`;
  }
  return privateCliMessage(e);
}

export async function cli(argv, log = (s) => console.error(s)) {
  try {
    return (await main(argv)) ?? 0;
  } catch (e) {
    log(`${PROBE}: ${cliMessage(e, argv.includes("--show-refusal"))}`);
    return e instanceof UsageError || e instanceof GuardRefusal ? 2 : 1;
  }
}

if (isMain(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
