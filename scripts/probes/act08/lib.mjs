// Shared recording code for the ACT-08 Phase 1 probes.
//
// These scripts are written for the Principal Operator to execute. Every
// script is dry-run by default: without --run it prints what it would send
// and sends nothing. The SDK is imported only on the --run path, and in
// dry-run the global fetch is replaced with one that throws, so an
// accidental network call fails loudly instead of spending.
//
// Nothing here reads billing. Cost is computed from API-reported token
// counts and the published rates in rates.json, and is always labelled
// computed_cost_usd.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT = "mgpl-508415";
export const LOCATION = "us-central1";
/** Vertex AI locations a ledger entry may name: one region, or the global endpoint. */
const LOCATION_PATTERN = /^(global|[a-z]+-[a-z]+[0-9]+)$/;

/**
 * The only host a request to `location` may go to: the regional host, or for the global
 * endpoint the host @google/genai 2.23.0 uses for location "global".
 */
export function hostFor(location) {
  if (typeof location !== "string" || !LOCATION_PATTERN.test(location))
    throw new Error(`not a Vertex AI location: ${JSON.stringify(location)}`);
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}
export const API_VERSION = "v1beta1"; // @google/genai 2.23.0 VERTEX_AI_API_DEFAULT_VERSION
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../../..");
export const RUNS_DIR = path.join(ROOT, "DOCS", "research", "act08-runs");

// Request headers worth keeping. Everything else, including Authorization
// and any API key header, is dropped rather than masked.
const REQUEST_HEADER_ALLOWLIST = new Set(["content-type", "user-agent", "x-goog-api-client"]);

export class UsageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UsageError";
    if (code !== undefined) this.code = code;
  }
}

/** A run guard refusal (AGENTS.md §3.1). Exit code 2; nothing was sent. */
export class GuardRefusal extends Error {
  constructor(check, message, code) {
    super(`RUN GUARD REFUSED (${check}): ${message}`);
    this.name = "GuardRefusal";
    this.check = check;
    if (code !== undefined) this.code = code;
  }
}

export function isMain(importMetaUrl) {
  return process.argv[1] ? importMetaUrl === pathToFileURL(process.argv[1]).href : false;
}

/**
 * Minimal flag parser. `spec` maps flag name to "boolean" | "string" | "int".
 * --run and --dry-run are always recognised; dry-run wins unless --run is given alone.
 */
export function parseArgs(argv, spec = {}) {
  const full = { run: "boolean", "dry-run": "boolean", ...spec };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const kind = full[name];
    if (!kind) throw new UsageError(`Unknown flag: --${name}`);
    if (kind === "boolean") {
      out[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`--${name} needs a value`);
    if (kind === "int") {
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new UsageError(`--${name} must be a positive integer, got ${value}`);
      }
      out[name] = Number(value);
    } else {
      out[name] = value;
    }
  }
  if (out.run && out["dry-run"]) throw new UsageError("Pass --run or --dry-run, not both");
  out.mode = out.run ? "run" : "dry-run";
  return out;
}

/** Heuristic only: ~4 characters per token. Labelled as such wherever it is printed. */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

export async function loadRates() {
  return JSON.parse(await readFile(path.join(HERE, "rates.json"), "utf8"));
}

export function rateRef(rates, model) {
  const m = rates.models[model];
  if (!m) throw new Error(`No published rate recorded for ${model} in rates.json`);
  return {
    model,
    tier: m.tier,
    unit: m.unit,
    verbatim_rows: m.verbatim_rows,
    source_url: rates.source_url_final,
    // A row read later than the rest of the file carries its own read_at (Codex kit review of WU-026).
    read_at: m.read_at ?? rates.read_at,
  };
}

/**
 * Why a usage record cannot be priced, or null when it can. A count the API
 * reports must be a non-negative integer, the prompt count must be present,
 * and every subtraction the formula makes must stay at or above zero (#125).
 */
export function generateUsageProblem(usage) {
  if (usage == null || typeof usage !== "object") return "no usageMetadata in the response";
  if (usage.promptTokenCount === undefined) return "promptTokenCount is missing";
  for (const key of [
    "promptTokenCount",
    "cachedContentTokenCount",
    "toolUsePromptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
  ]) {
    const v = usage[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return `${key} is ${JSON.stringify(v)}, not a non-negative integer`;
    }
  }
  if ((usage.cachedContentTokenCount ?? 0) > usage.promptTokenCount) {
    return `cachedContentTokenCount ${usage.cachedContentTokenCount} exceeds promptTokenCount ${usage.promptTokenCount}`;
  }
  return null;
}

/**
 * Computed cost for one generateContent response from its usageMetadata.
 * Billable input = promptTokenCount - cachedContentTokenCount + toolUsePromptTokenCount.
 * Billable output = candidatesTokenCount + thoughtsTokenCount ("response and reasoning").
 * Inconsistent usage is never priced: the result is { unpriceable: true, reason,
 * computed_cost_usd: null }, and totals that include it are unpriceable too (#125).
 */
export function computeGenerateCost(rates, model, usage) {
  const r = rates.models[model];
  if (!r) throw new Error(`No published rate recorded for ${model} in rates.json`);
  const problem = generateUsageProblem(usage);
  if (problem) {
    return {
      unpriceable: true,
      reason: problem,
      computed_cost_usd: null,
      usage_as_reported: usage ?? null,
    };
  }
  const prompt = usage.promptTokenCount;
  const cached = usage.cachedContentTokenCount ?? 0;
  const toolUse = usage.toolUsePromptTokenCount ?? 0;
  const candidates = usage.candidatesTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const long = prompt > 200_000;
  const inRate = long ? r.input_gt_200k : r.input_le_200k;
  const cachedRate = long ? r.cached_input_gt_200k : r.cached_input_le_200k;
  const outRate = long ? r.output_gt_200k : r.output_le_200k;
  for (const [name, v] of [
    ["input", inRate],
    ["cached_input", cachedRate],
    ["output", outRate],
  ]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return {
        unpriceable: true,
        reason: `rates.json has no ${name} rate for ${model} (${long ? ">200K" : "<=200K"})`,
        computed_cost_usd: null,
        usage_as_reported: usage,
      };
    }
  }
  const uncachedInput = prompt - cached + toolUse;
  const output = candidates + thoughts;
  const cost = (uncachedInput * inRate + cached * cachedRate + output * outRate) / 1_000_000;
  return {
    computed_cost_usd: round(cost),
    tokens_in: prompt + toolUse,
    tokens_in_cached: cached,
    tokens_out: output,
    context_tier: long ? ">200K" : "<=200K",
    formula:
      "((prompt - cached + toolUsePrompt) * input + cached * cached_input + (candidates + thoughts) * output) / 1e6",
    assumptions: [
      "toolUsePromptTokenCount billed at the input rate (the page has no separate tool line)",
      "thoughtsTokenCount billed as output, per the page's 'response and reasoning' wording",
    ],
    rates_per_1m: { input: inRate, cached_input: cachedRate, output: outRate },
  };
}

/**
 * Sums computed costs. Items with no cost object (no response) add nothing,
 * as before; one unpriceable item makes the total unpriceable (null), never a
 * smaller number. The priced-only subtotal is kept beside it, labelled.
 */
export function sumComputedCosts(costs) {
  let priced = 0;
  let unpriceable = 0;
  for (const c of costs) {
    if (c == null) continue;
    if (c.unpriceable || typeof c.computed_cost_usd !== "number") unpriceable += 1;
    else priced += c.computed_cost_usd;
  }
  return {
    computed_cost_usd: unpriceable ? null : round(priced),
    computed_cost_usd_priced_items_only: round(priced),
    unpriceable_items: unpriceable,
  };
}

/** Sums metadata.billableCharacterCount over predict responses; null if any is missing or invalid. */
export function billableCharactersFrom(responseBodies) {
  let total = 0;
  for (const raw of responseBodies) {
    let body;
    try {
      body = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
    const n = body?.metadata?.billableCharacterCount;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    total += n;
  }
  return total;
}

/**
 * Computed cost for text-embedding-005. Priced on the API's
 * metadata.billableCharacterCount, summed over responses (#114). The
 * string length is kept as a secondary field. Without the billable count
 * the cost is unpriceable; it never falls back to string length.
 */
export function computeEmbeddingCost(rates, model, { billableCharacters, characters, tokens }) {
  const r = rates.models[model];
  if (!r) throw new Error(`No published rate recorded for ${model} in rates.json`);
  const rate = r.input_per_1000_count;
  const secondary = {
    characters_string_length: characters ?? null,
    computed_cost_usd_on_string_length:
      characters == null ? null : round((characters / 1000) * rate),
    tokens_reported: tokens ?? null,
    computed_cost_usd_if_count_means_tokens: tokens == null ? null : round((tokens / 1000) * rate),
  };
  if (
    typeof billableCharacters !== "number" ||
    !Number.isInteger(billableCharacters) ||
    billableCharacters < 0
  ) {
    return {
      unpriceable: true,
      reason: "metadata.billableCharacterCount missing or invalid in at least one response",
      computed_cost_usd: null,
      ...secondary,
    };
  }
  return {
    computed_cost_usd: round((billableCharacters / 1000) * rate),
    billable_characters: billableCharacters,
    ...secondary,
    formula: "(sum of metadata.billableCharacterCount / 1000) * input_per_1000_count",
    unit_ambiguity: r.unit_ambiguity,
  };
}

export function round(n) {
  return Math.round(n * 1e9) / 1e9;
}

export function expectedEndpoint(model, method, location = LOCATION) {
  return `https://${hostFor(location)}/${API_VERSION}/projects/${PROJECT}/locations/${location}/publishers/google/models/${model}:${method}`;
}

/**
 * What kind of failure a request had, as "<name>" or "<name> (<code>)": the error's name and the
 * first code on it or its cause, each kept only if it is a plain identifier. The error's message
 * is never used: one raised while reading a response can quote the response, and a request can
 * carry text that must not be stored, such as reference text given to the model (Codex kit
 * review r3 of WU-029). Used for the capture's network_error and the ledger's result reason.
 */
export function errorKind(e) {
  const ident = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
  const name = ident(e?.name, /^[A-Za-z][A-Za-z0-9]{0,40}$/) ?? "Error";
  const code =
    ident(e?.cause?.code, /^[A-Z][A-Z0-9_]{0,40}$/) ?? ident(e?.code, /^[A-Z][A-Z0-9_]{0,40}$/);
  return code ? `${name} (${code})` : name;
}

/** In dry-run, any fetch is a bug. Replace it with one that throws. */
export function forbidNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("ACT-08 dry-run attempted a network call. Nothing was sent.");
  };
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * A fetch wrapper for the SDK's httpOptions.fetch. It sees API calls only;
 * the SDK's auth traffic does not pass through it. Every attempt, including
 * SDK retries, increments the counter, and once `maxRequests` is reached no
 * further request is sent. With `guard` (a run from openRun), every attempt
 * is first admitted against the real outgoing URL and body, and its attempt
 * line is on disk before the request is sent; its result line follows.
 */
export function createCapture({
  maxRequests = Infinity,
  baseFetch = globalThis.fetch,
  now = Date.now,
  guard = null,
} = {}) {
  // The run's admission and settlement are private to the guard: only a
  // capture built on a real run reaches them, and only through its own
  // fetch (third Codex audit, finding 1).
  const internals = guard ? GUARD_INTERNALS.get(guard) : null;
  if (guard && !internals)
    throw new GuardRefusal("one-run", "the guard is not a run from openRun()");
  const exchanges = [];
  let attempts = 0;
  const capture = {
    exchanges,
    get attempts() {
      return attempts;
    },
    maxRequests,
    async fetch(input, init = {}) {
      if (attempts >= maxRequests) {
        const err = new Error(
          `ACT-08 request cap reached: ${attempts}/${maxRequests}. Request not sent.`,
        );
        err.capReached = true;
        throw err;
      }
      let url = typeof input === "string" ? input : input.url;
      let admission = null;
      let sendInput = input;
      let sendInit = init;
      if (guard) {
        try {
          // A guarded request is a string URL with its method, headers and
          // body in init (Codex pre-dispatch audit, finding 4). Each of them
          // is read once, into a snapshot, and that snapshot is what is
          // admitted, logged and sent: nothing the caller controls is read
          // again after the check (second audit, finding 1).
          if (typeof input !== "string")
            throw new GuardRefusal("endpoint", "a guarded request must be a string URL");
          url = input;
          sendInput = input;
          sendInit = snapshotInit(init);
          admission = internals.admit({ url, init: sendInit });
        } catch (e) {
          if (e instanceof GuardRefusal && e.check === "count") e.capReached = true;
          throw e;
        }
      }
      init = sendInit;
      attempts += 1;
      const entry = {
        attempt: attempts,
        started_at: new Date(now()).toISOString(),
        method: init.method ?? "GET",
        url,
        request_headers: pickHeaders(init.headers),
        request_body:
          typeof init.body === "string"
            ? init.body
            : init.body == null
              ? null
              : "[non-string body]",
      };
      exchanges.push(entry);
      const t0 = now();
      try {
        if (admission) internals.markSent(admission);
        const response = await baseFetch(sendInput, sendInit);
        entry.latency_ms = now() - t0;
        entry.status = response.status;
        entry.response_headers = Object.fromEntries(response.headers?.entries?.() ?? []);
        entry.response_body = await response.clone().text();
        if (admission) {
          entry.guard = internals.settle(admission, {
            status: response.status,
            bodyText: entry.response_body,
          });
        }
        return response;
      } catch (e) {
        entry.latency_ms = now() - t0;
        entry.network_error = errorKind(e);
        if (admission && !entry.guard) entry.guard = internals.settle(admission, { error: e });
        throw e;
      }
    },
  };
  return capture;
}

const INIT_FIELDS = new Set(["method", "headers", "body", "signal"]);

/**
 * Copies a fetch init once: method and body as strings, headers into a new
 * Headers object, and the abort signal. Any other option is refused, since
 * the guard cannot say what it would change.
 */
function snapshotInit(init) {
  if (!init || typeof init !== "object")
    throw new GuardRefusal("endpoint", "a guarded request needs an init object");
  const keys = Object.keys(init);
  const extra = keys.filter((k) => !INIT_FIELDS.has(k));
  if (extra.length)
    throw new GuardRefusal("endpoint", `no admission rule for the fetch option "${extra[0]}"`);
  const method = init.method;
  const rawHeaders = init.headers;
  const body = init.body;
  const signal = init.signal;
  if (typeof method !== "string") throw new GuardRefusal("endpoint", "the method is not a string");
  if (typeof body !== "string")
    throw new GuardRefusal("dollars", "the request body is not a string");
  let headers;
  try {
    headers = new Headers(rawHeaders ?? {});
  } catch {
    throw new GuardRefusal("endpoint", "the request headers cannot be read");
  }
  return Object.freeze({
    method,
    headers,
    body,
    ...(signal === undefined ? {} : { signal }),
  });
}

function pickHeaders(headers) {
  if (!headers) return {};
  const entries =
    typeof headers.entries === "function" ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.filter(([k]) => REQUEST_HEADER_ALLOWLIST.has(String(k).toLowerCase())),
  );
}

export async function createClient(capture, extraHttpOptions = {}, location = LOCATION) {
  hostFor(location);
  const { GoogleGenAI } = await import("@google/genai");
  // Client-level httpOptions only. No request passes its own httpOptions,
  // so the capture fetch is never dropped by the SDK's option patching.
  // @google/genai 2.23.0 retries only when retryOptions is set; none of the
  // probes set it unless a flag asks for it (P-8 --sdk-retries).
  return new GoogleGenAI({
    vertexai: true,
    project: PROJECT,
    location,
    httpOptions: { ...extraHttpOptions, fetch: capture.fetch },
  });
}

export function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function sdkVersion() {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(ROOT, "node_modules", "@google", "genai", "package.json"), "utf8"),
    );
    return pkg.version;
  } catch {
    return null;
  }
}

export function utcStamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Writes the verbatim run record and returns its repository-relative path. */
export async function writeRunRecord(probe, record) {
  await mkdir(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${probe}-${utcStamp(new Date(record.started_at))}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path.relative(ROOT, file).split(path.sep).join("/");
}

export async function baseRecord(probe, argv, location = LOCATION) {
  return {
    probe,
    evidence_contract: "DOCS/specs/ACT-08-google-cloud-capability-exploration.md",
    executed_by:
      "Principal Operator (operator-run script; the recording agent did not execute this)",
    started_at: new Date().toISOString(),
    argv,
    git_head: gitHead(),
    node_version: process.version,
    sdk: { package: "@google/genai", version: await sdkVersion() },
    project: PROJECT,
    location,
    credential:
      "Application Default Credentials, not inspected by the script. Record the identity per the runbook.",
  };
}

/**
 * Runs `body` on --run and writes the record whatever happens.
 * Exit codes: 0 success, 1 failure, 2 usage error or refusal, 3 finding exit.
 */
export async function finish(probe, record, summary) {
  record.finished_at = new Date().toISOString();
  const rel = await writeRunRecord(probe, record);
  console.log(`${summary} -> ${rel}`);
  return record.exit_status;
}

export function printDryRun(lines) {
  console.log(["DRY RUN: nothing will be sent. Re-run with --run to spend.", ...lines].join("\n"));
}

export async function runCli(main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`Usage error: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    if (e instanceof GuardRefusal) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    console.error(`Unexpected failure: ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// The run guard: AGENTS.md §3.1, conditions 3 to 7 (#157).
//
// Every script a §3.1 ledger entry names calls openRun() before anything
// else, sends every request through createCapture({ guard: run }) so that
// admit() runs inside the fetch the SDK calls, and calls run.end() on every
// exit path. The rules come only from AGENTS.md in this checkout; the records
// come from the folder §3.1 names (MGPL_GCP_DIR overrides it, for tests).
// The guard makes no network call. It appends to spend-ledger.jsonl and
// creates and removes spend-ledger.lock; it writes nothing else.
// ---------------------------------------------------------------------------

export const AGENTS_PATH = path.join(ROOT, "AGENTS.md");
// Run handle -> its private admit/markSent/settle. Not exported.
const GUARD_INTERNALS = new WeakMap();
export const DEFAULT_GCP_DIR = "C:\\dev\\_staging\\gcp";
export const LEDGER_FILE = "spend-ledger.jsonl";
export const LOCK_FILE = "spend-ledger.lock";
export const CREDIT_MAX_AGE_MS = 48 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const LEDGER_TYPES = new Set([
  "reservation",
  "attempt",
  "result",
  "end",
  "reconciliation",
  "explained",
  "card_charge",
]);
const LEDGER_HEADER = [
  "Entry",
  "Script and work",
  "Endpoint and methods",
  "Lane",
  "Request cap",
  "Dollar cap",
  "Writes to",
  "Added",
  "Expires",
];
const TOTALS_HEADER = ["Window", "Total for all entries", "Stop line (credit balance)"];
// The request fields the bound accounts for. Anything else (an output
// multiplier such as candidateCount above 1, image or audio output, a speech
// configuration) is refused rather than guessed at.
const REQUEST_FIELDS = new Set([
  "contents",
  "systemInstruction",
  "tools",
  "generationConfig",
  "safetySettings",
  "labels",
]);
// Every level is bounded alike, by the model's whole output ceiling (maxRequestCostUsd), so
// admitting MINIMAL (Gemini 3.1 Flash-Lite's default; Google: it "does not guarantee that
// thinking is off") widens nothing (WU-029).
const THINKING_LEVELS = new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);
const GENERATION_FIELDS = new Set([
  "maxOutputTokens",
  "thinkingConfig",
  "temperature",
  "topP",
  "topK",
  "seed",
  "stopSequences",
  "presencePenalty",
  "frequencyPenalty",
  "responseMimeType",
  "responseSchema",
  "responseJsonSchema",
  "candidateCount",
]);
// The only tool a guarded request may carry, and the rates.json fee it incurs.
// Code execution and function calling are refused: code execution adds
// intermediate input tokens no request field bounds (Codex pre-dispatch
// audit, finding 2), and neither is needed by an authorized script yet.
const TOOL_FEES = { googleSearch: "grounding_google_search" };
// The only fields a content (contents[i], systemInstruction) and a part may
// have. A fileData part can bring billable media whose size is not in the
// request body (audit finding 1), so it is refused. An inlineData part is
// admitted only as a PNG or JPEG image (task proposal 021, Addendum 2). Its
// bytes travel in the body as base64, and the dollar bound prices every byte
// of the body as an input token. Google also counts an image as 258 tokens per
// 768x768 tile (258 for one of 384 px or less): a very compressible image can
// have fewer bytes than tokens, so the bound adds each image's tile tokens,
// read from the image's own header. Audio, video and any other media type are
// still refused: what they bill is not the subject of a rule.
const CONTENT_FIELDS = new Set(["role", "parts"]);
const PART_FIELDS = new Set(["text", "inlineData"]);
const INLINE_FIELDS = new Set(["mimeType", "data"]);
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_SMALL_PX = 384;
const IMAGE_TILE_TOKENS = 258;
// An embeddings predict request (WU-032, #199): the only fields its bound accounts for, as
// @google/genai 2.23.0 sends them for a text embedding model. A text's title, a MIME type or any
// other field is refused rather than guessed at.
const PREDICT_FIELDS = new Set(["instances", "parameters"]);
const PREDICT_INSTANCE_FIELDS = new Set(["content", "task_type"]);
const PREDICT_PARAMETER_FIELDS = new Set(["outputDimensionality", "autoTruncate"]);

const CATALOGUE_MODE_MATRIX = Object.freeze({
  "scripts/catalogue/enrich-gemini.mjs": Object.freeze({
    S3: Object.freeze(new Set(["description", "friction", "genre"])),
    JDG: Object.freeze(new Set(["check"])),
  }),
  "scripts/catalogue/embed-descriptions.mjs": Object.freeze({
    EMB: Object.freeze(new Set(["description"])),
    "EMB-2": Object.freeze(new Set(["title", "friction", "genre"])),
  }),
});

function refuse(check, message, code) {
  throw new GuardRefusal(check, message, code);
}

/**
 * Enforces the WU-034 catalogue entry label / script / mode authorization matrix.
 * Throws GuardRefusal with check='mode' and code='WU034_MODE_ENTRY' on any mismatch.
 */
export function assertEntryMode(entry, { script, mode } = {}) {
  const byLabel =
    typeof script === "string" && Object.prototype.hasOwnProperty.call(CATALOGUE_MODE_MATRIX, script)
      ? CATALOGUE_MODE_MATRIX[script]
      : undefined;
  const allowed =
    entry &&
    typeof entry === "object" &&
    entry.script === script &&
    typeof entry.label === "string" &&
    byLabel &&
    Object.prototype.hasOwnProperty.call(byLabel, entry.label)
      ? byLabel[entry.label]
      : undefined;
  if (!allowed || typeof mode !== "string" || !allowed.has(mode)) {
    refuse(
      "mode",
      `entry ${entry?.id ?? "(unknown)"}${entry?.label ? ` (${entry.label})` : ""} does not authorize ${script ?? "(unknown script)"} in mode ${JSON.stringify(mode)}`,
      "WU034_MODE_ENTRY",
    );
  }
}

export function gcpDir(dir) {
  return dir ?? process.env.MGPL_GCP_DIR ?? DEFAULT_GCP_DIR;
}

function utcDay(text, what) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) refuse("ledger", `${what} is not a YYYY-MM-DD date: ${JSON.stringify(text)}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== text)
    refuse("ledger", `${what} is not a real date: ${text}`);
  return ms;
}

function dollars(text, what) {
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(text);
  if (!m) refuse("ledger", `${what} is not a dollar amount: ${JSON.stringify(text)}`);
  return Number(m[1]);
}

function tableAfter(section, heading) {
  const lines = section.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) refuse("ledger", `AGENTS.md §3.1 has no "${heading}" table`);
  let i = at + 1;
  while (i < lines.length && !lines[i].trim().startsWith("|")) {
    if (/^#{1,4} /.test(lines[i])) refuse("ledger", `"${heading}" has no table`);
    i++;
  }
  const rows = [];
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    const t = lines[i].trim();
    if (!t.endsWith("|")) refuse("ledger", `"${heading}" row is not closed: ${t}`);
    rows.push(
      t
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
    i++;
  }
  if (rows.length < 2 || !rows[1].every((c) => /^:?-{3,}:?$/.test(c)))
    refuse("ledger", `"${heading}" is not a Markdown table`);
  const width = rows[0].length;
  rows.forEach((r, n) => {
    if (r.length !== width)
      refuse("ledger", `"${heading}" row ${n + 1} has ${r.length} cells, not ${width}`);
  });
  return { header: rows[0], rows: rows.slice(2) };
}

/**
 * Parses AGENTS.md §3.1: its ledger and totals tables. Every cell must match
 * its grammar exactly; a qualifier the guard cannot enforce (for example a
 * model named in the endpoint cell) is a refusal, so the guard is never more
 * permissive than the file.
 */
export function parseAuthorizations(text) {
  const start = text.search(/^### 3\.1 Authorized billable work units\s*$/m);
  if (start < 0) refuse("ledger", "AGENTS.md has no §3.1 'Authorized billable work units'");
  const rest = text.slice(start);
  const next = rest.search(/\n#{2,3} /);
  const section = next < 0 ? rest : rest.slice(0, next + 1);

  const totals = tableAfter(section, "#### Totals");
  if (JSON.stringify(totals.header) !== JSON.stringify(TOTALS_HEADER))
    refuse("ledger", `the Totals table header changed: ${totals.header.join(" | ")}`);
  if (totals.rows.length !== 1) refuse("ledger", "the Totals table must have exactly one row");
  const [windowCell, totalCell, stopCell] = totals.rows[0];
  const w = /^to (\d{4}-\d{2}-\d{2}) 00:00 UTC$/.exec(windowCell);
  if (!w) refuse("ledger", `the window is not "to YYYY-MM-DD 00:00 UTC": ${windowCell}`);
  const window = {
    end_ms: utcDay(w[1], "the window end"),
    total_usd: dollars(totalCell, "the window total"),
    stop_line_usd: dollars(stopCell, "the stop line"),
  };

  const ledger = tableAfter(section, "#### Ledger");
  if (JSON.stringify(ledger.header) !== JSON.stringify(LEDGER_HEADER))
    refuse("ledger", `the Ledger table header changed: ${ledger.header.join(" | ")}`);
  const seen = new Set();
  const entries = ledger.rows.map((cells) => {
    const [
      entryCell,
      scriptCell,
      endpointCell,
      lane,
      capCell,
      usdCell,
      writesCell,
      added,
      expires,
    ] = cells;
    const entryMatch = /^(#\d+)(?: \(([A-Za-z0-9-]+)\))?$/.exec(entryCell);
    const id = entryMatch?.[1];
    const label = entryMatch?.[2] ?? null;
    if (!id) refuse("ledger", `the entry cell is not "#NNN" or "#NNN (label)": ${entryCell}`);
    if (seen.has(id)) refuse("ledger", `entry ${id} appears twice`);
    seen.add(id);
    const sc = /^`(scripts\/[A-Za-z0-9._/-]+\.mjs)`(?::|$)/.exec(scriptCell);
    if (!sc || sc[1].includes("..")) refuse("ledger", `${id}: no script path in "${scriptCell}"`);
    // Exactly: `host`, location `location`, `method` only
    const ep = /^`([a-z0-9.-]+)`, location `([a-z0-9-]+)`, `([A-Za-z]+)` only$/.exec(endpointCell);
    if (!ep)
      refuse(
        "ledger",
        `${id}: the endpoint cell is not "\`host\`, location \`location\`, \`method\` only": ${endpointCell}`,
      );
    if (!LOCATION_PATTERN.test(ep[2]) || ep[1] !== hostFor(ep[2]))
      refuse("ledger", `${id}: host ${ep[1]} is not the host for location ${ep[2]}`);
    if (!/^\d+$/.test(capCell)) refuse("ledger", `${id}: request cap "${capCell}"`);
    const wr = /^`([^`]+)`$/.exec(writesCell);
    if (!wr) refuse("ledger", `${id}: the output location is not one path: "${writesCell}"`);
    return {
      id,
      label,
      script: sc[1],
      host: ep[1],
      location: ep[2],
      methods: [ep[3]],
      lane,
      request_cap: Number(capCell),
      dollar_cap_usd: dollars(usdCell, `${id}: dollar cap`),
      writes_to: wr[1],
      added_ms: utcDay(added, `${id}: Added`),
      expires_ms: utcDay(expires, `${id}: Expires`),
    };
  });
  return { window, entries };
}

function readAuthorizations(agentsPath) {
  let text;
  try {
    text = readFileSync(agentsPath, "utf8");
  } catch {
    refuse("ledger", `${agentsPath} cannot be read`);
  }
  return parseAuthorizations(text);
}

const isText = (v) => typeof v === "string" && v.length > 0;
const isAmount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isNote = (v) => typeof v === "string" && v.trim().length > 0;
const RESULT_OUTCOMES = new Set(["priced", "unpriceable", "no_response", "http_error"]);

/** What is wrong with one ledger line on its own, or null. */
function ledgerLineProblem(l) {
  const need = (ok, what) => (ok ? null : what);
  switch (l.type) {
    case "reservation":
      return (
        need(isText(l.run_id) && isText(l.entry), "run_id and entry are required") ??
        need(isAmount(l.max_usd) && l.max_usd > 0, "max_usd must be a positive number") ??
        need(
          Number.isInteger(l.max_requests) && l.max_requests > 0,
          "max_requests must be a positive integer",
        )
      );
    case "attempt":
      return (
        need(
          isText(l.run_id) && isText(l.entry) && isText(l.attempt_id),
          "run_id, entry and attempt_id are required",
        ) ?? need(isAmount(l.max_cost_usd), "max_cost_usd must be a non-negative number")
      );
    case "result":
      return (
        need(
          isText(l.run_id) && isText(l.entry) && isText(l.attempt_id),
          "run_id, entry and attempt_id are required",
        ) ??
        need(
          RESULT_OUTCOMES.has(l.outcome),
          `outcome must be one of ${[...RESULT_OUTCOMES].join(", ")}`,
        ) ??
        need(
          l.outcome === "priced" ? isAmount(l.computed_cost_usd) : l.computed_cost_usd === null,
          "a priced result needs a non-negative computed_cost_usd; any other outcome needs null",
        )
      );
    case "end":
      return need(isText(l.run_id), "run_id is required");
    case "explained":
      return (
        need(isText(l.run_id), "run_id is required") ??
        need(isNote(l.note), "an explanation needs a written note") ??
        need(isNote(l.by), "an explanation needs by")
      );
    case "reconciliation":
      return (
        need(
          isText(l.run_id) && isText(l.credit_record),
          "run_id and credit_record are required",
        ) ??
        need(isAmount(l.billed_usd), "billed_usd must be a non-negative number") ??
        need(isNote(l.by), "a reconciliation needs by")
      );
    default:
      return null;
  }
}

/** Reads every ledger line. A line that does not parse makes the count unknowable: refusal. */
export function readLedger(dir) {
  const file = path.join(dir, LEDGER_FILE);
  if (!existsSync(file)) return [];
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    refuse("count", `the spend ledger cannot be read: ${e?.message ?? e}`);
  }
  const out = [];
  raw.split("\n").forEach((line, i) => {
    const t = line.replace(/\r$/, "");
    if (t.trim() === "") return;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      refuse("count", `spend ledger line ${i + 1} is not valid JSON`);
    }
    if (!obj || typeof obj !== "object" || !LEDGER_TYPES.has(obj.type))
      refuse("count", `spend ledger line ${i + 1} has no known type`);
    const problem = ledgerLineProblem(obj);
    if (problem) refuse("count", `spend ledger line ${i + 1} (${obj.type}): ${problem}`);
    obj.line = i + 1;
    out.push(obj);
  });
  return out;
}

function appendLine(dir, obj) {
  const fd = openSync(path.join(dir, LEDGER_FILE), "a");
  try {
    writeSync(fd, `${JSON.stringify(obj)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const money = (n) => Math.round(n * 1e9) / 1e9;
const over = (a, b) => money(a) > money(b);

/** A difference over max(10% of computed, $1) must be explained (§3.1 Reconciliation). */
export function differenceFlagged(billed, computed) {
  return Math.abs(billed - computed) > Math.max(0.1 * computed, 1);
}

/**
 * Folds the ledger into runs, checking it as a state machine as it goes
 * (Codex pre-dispatch audit, finding 5). Every reference must resolve and
 * every line must come in a legal order; anything else is a refusal, never a
 * skipped line:
 * - a reservation's run_id is new;
 * - an attempt names an open run of the same entry, and its attempt_id is new;
 * - a result names an attempt that has no result yet;
 * - an end names an open run;
 * - a reconciliation names an ended run (a later one for the same run may
 *   only raise the billed figure's effect: the largest billed figure counts);
 * - an explained line names a run with a reconciliation before it.
 * The flag for an unexplained difference is derived here from the amounts,
 * not read from the line.
 */
export function summarizeLedger(lines) {
  const runs = new Map();
  const attempts = new Map();
  const attemptsByEntry = new Map();
  const cardCharges = [];
  const bad = (l, why) => refuse("count", `spend ledger line ${l.line ?? "?"} (${l.type}): ${why}`);
  for (const l of lines) {
    if (l.type === "reservation") {
      if (runs.has(l.run_id)) bad(l, `run ${l.run_id} is reserved twice`);
      runs.set(l.run_id, { ...l, attempts: [], ended: null, reconciliations: [], explained: [] });
    } else if (l.type === "attempt") {
      const r = runs.get(l.run_id);
      if (!r) bad(l, `attempt for run ${l.run_id}, which has no reservation`);
      if (r.ended) bad(l, `attempt for run ${l.run_id} after its end line`);
      if (r.entry !== l.entry) bad(l, `attempt names entry ${l.entry}; its run is ${r.entry}`);
      if (attempts.has(l.attempt_id)) bad(l, `attempt ${l.attempt_id} appears twice`);
      const a = { ...l, result: null };
      attempts.set(l.attempt_id, a);
      r.attempts.push(a);
      attemptsByEntry.set(l.entry, (attemptsByEntry.get(l.entry) ?? 0) + 1);
    } else if (l.type === "result") {
      const a = attempts.get(l.attempt_id);
      if (!a) bad(l, `result for attempt ${l.attempt_id}, which is not on record`);
      if (a.run_id !== l.run_id || a.entry !== l.entry)
        bad(
          l,
          `result names run ${l.run_id} and entry ${l.entry}; attempt ${l.attempt_id} is run ${a.run_id}, entry ${a.entry}`,
        );
      if (a.result) bad(l, `attempt ${l.attempt_id} has two results`);
      // A result after its run's end line would change a cost that a
      // reconciliation may already have been checked against (second audit,
      // finding 2).
      if (runs.get(a.run_id).ended)
        bad(l, `result for attempt ${l.attempt_id} after its run ended`);
      a.result = l;
    } else if (l.type === "end") {
      const r = runs.get(l.run_id);
      if (!r) bad(l, `end for run ${l.run_id}, which has no reservation`);
      if (r.ended) bad(l, `run ${l.run_id} has two end lines`);
      r.ended = l;
    } else if (l.type === "reconciliation") {
      const r = runs.get(l.run_id);
      if (!r) bad(l, `reconciliation for run ${l.run_id}, which has no reservation`);
      if (!r.ended) bad(l, `reconciliation for run ${l.run_id}, which has not ended`);
      r.reconciliations.push(l);
    } else if (l.type === "explained") {
      const r = runs.get(l.run_id);
      if (!r || !r.reconciliations.length)
        bad(l, `explained line for run ${l.run_id}, which has no reconciliation before it`);
      r.explained.push(l);
    } else if (l.type === "card_charge") {
      cardCharges.push(l);
    }
  }
  const unexplained = [];
  for (const r of runs.values()) {
    // An attempt with no priced result (no response, an error, unpriceable
    // usage) counts at its full maximum.
    r.computed_usd = money(
      r.attempts.reduce(
        (n, a) =>
          n +
          (a.result?.outcome === "priced" && typeof a.result.computed_cost_usd === "number"
            ? a.result.computed_cost_usd
            : a.max_cost_usd),
        0,
      ),
    );
    const billed = r.reconciliations.length
      ? Math.max(...r.reconciliations.map((x) => x.billed_usd))
      : null;
    r.billed_usd = billed;
    r.liability_usd =
      billed === null ? Math.max(r.max_usd, r.computed_usd) : Math.max(billed, r.computed_usd);
    // Each flagged reconciliation needs an explained line after it.
    for (const x of r.reconciliations) {
      if (
        differenceFlagged(x.billed_usd, r.computed_usd) &&
        !r.explained.some((e) => e.line > x.line)
      )
        unexplained.push({ run_id: r.run_id, line: x.line });
    }
  }
  return {
    runs,
    attemptsByEntry,
    cardCharges,
    unexplained,
    openRuns: [...runs.values()].filter((r) => !r.ended),
  };
}

/** Every credit-position record in the folder; the newest last. Unreadable or malformed: refusal. */
export function readCreditRecords(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => /^credit-position.*\.json$/.test(n));
  } catch (e) {
    refuse("credit", `the records folder cannot be read: ${e?.message ?? e}`);
  }
  if (!names.length) refuse("credit", `no credit-position record in ${dir}`);
  const records = names.map((name) => {
    let rec;
    try {
      rec = JSON.parse(readFileSync(path.join(dir, name), "utf8").replace(/^﻿/, ""));
    } catch {
      refuse("credit", `${name} is not valid JSON`);
    }
    const at = Date.parse(rec?.read_at);
    if (typeof rec?.read_at !== "string" || !Number.isFinite(at))
      refuse("credit", `${name} has no valid read_at`);
    if (typeof rec.balance_usd !== "number" || !Number.isFinite(rec.balance_usd))
      refuse("credit", `${name} has no numeric balance_usd`);
    return { name, read_at_ms: at, balance_usd: rec.balance_usd };
  });
  return records.sort((a, b) => a.read_at_ms - b.read_at_ms);
}

function checkDates(entry, window, t) {
  if (t < entry.added_ms) refuse("expiry", `${entry.id} is not in force before its Added date`);
  if (t >= entry.expires_ms)
    refuse("expiry", `${entry.id} expired at ${new Date(entry.expires_ms).toISOString()}`);
  if (t >= window.end_ms)
    refuse("expiry", `the window ended at ${new Date(window.end_ms).toISOString()}`);
}

/**
 * Conditions 4, 6 and 7, and the reconciliation and card-charge stops, on
 * the records as they are now. openRun() calls it with the reservation it is
 * about to add (`adding`); admit() calls it before every attempt with
 * `adding` 0, because the run's own open reservation is already a liability
 * in the ledger (Codex pre-dispatch audit, finding 3).
 */
export const WU034_OPERATOR_WAIVER =
  "https://github.com/joelgeorges86/MGPL/issues/207#issuecomment-6316449436";

/** Explicit operator instruction; never inferred from a ledger record or enabled by default. */
export function assertOperatorWaiver(reference, { entry, script, mode } = {}) {
  if (reference === undefined) return false;
  if (
    reference !== WU034_OPERATOR_WAIVER || entry?.id !== "#207" || entry?.label !== "JDG" ||
    script !== "scripts/catalogue/enrich-gemini.mjs" || mode !== "check"
  ) refuse("operator-waiver", "the operator waiver applies only to #207 description checks");
  return true;
}

function checkState({ entry, window, dir, t, adding, addingRequests, operatorWaiver }) {
  const sum = summarizeLedger(readLedger(dir));
  if (sum.cardCharges.length)
    refuse("card-charge", "the spend ledger records a card charge; every authorized run stops");
  if (sum.unexplained.length)
    refuse(
      "reconciliation",
      `run ${sum.unexplained[0].run_id} has a reconciliation difference over max(10%, $1) with no explained line after it`,
    );
  const used = sum.attemptsByEntry.get(entry.id) ?? 0;
  if (used + addingRequests > entry.request_cap)
    refuse(
      "count",
      `${entry.id} has ${used} attempts on record; ${addingRequests} more would exceed its cap of ${entry.request_cap}`,
    );
  if (operatorWaiver) return { sum, newest: null };
  const runs = [...sum.runs.values()];
  const entryLiab = runs
    .filter((r) => r.entry === entry.id)
    .reduce((n, r) => n + r.liability_usd, 0);
  const windowLiab = runs.reduce((n, r) => n + r.liability_usd, 0);
  if (over(entryLiab + adding, entry.dollar_cap_usd))
    refuse(
      "dollars",
      `${entry.id} liabilities $${money(entryLiab)}${adding ? ` + this reservation $${adding}` : ""} exceed its cap of $${entry.dollar_cap_usd}`,
    );
  if (over(windowLiab + adding, window.total_usd))
    refuse(
      "dollars",
      `window liabilities $${money(windowLiab)}${adding ? ` + this reservation $${adding}` : ""} exceed the window total of $${window.total_usd}`,
    );
  const credits = readCreditRecords(dir);
  const newest = credits[credits.length - 1];
  if (newest.read_at_ms > t + CLOCK_SKEW_MS)
    refuse("credit", `${newest.name} is dated in the future`);
  if (t - newest.read_at_ms > CREDIT_MAX_AGE_MS)
    refuse("credit", `${newest.name} is more than 48 hours old`);
  const known = new Map(credits.map((c) => [c.name, c.read_at_ms]));
  for (const r of runs) {
    for (const x of r.reconciliations) {
      if (!known.has(x.credit_record))
        refuse(
          "reconciliation",
          `run ${r.run_id}'s reconciliation names ${x.credit_record}, which is not a credit-position record here`,
        );
    }
  }
  // A run counts as included in the newest record only if a reconciliation
  // names a record no newer than it.
  const notIncluded = runs
    .filter((r) => !r.reconciliations.some((x) => known.get(x.credit_record) <= newest.read_at_ms))
    .reduce((n, r) => n + r.liability_usd, 0);
  if (over(window.stop_line_usd, newest.balance_usd - notIncluded - adding))
    refuse(
      "credit",
      `balance $${newest.balance_usd} (${newest.name}) - unreconciled liabilities $${money(notIncluded)}${adding ? ` - this reservation $${adding}` : ""} is under the $${window.stop_line_usd} stop line`,
    );
  return { sum, newest };
}

function rateValues(row, prefixes) {
  return Object.entries(row)
    .filter(([k, v]) => prefixes.some((p) => k.startsWith(p)) && typeof v === "number")
    .map(([, v]) => v);
}

/**
 * The width and height an image's own header gives, or null. PNG: the IHDR chunk. JPEG: the
 * first start-of-frame segment. Nothing else is read.
 */
export function imageSize(mimeType, buf) {
  if (mimeType === "image/png") {
    const sig = "89504e470d0a1a0a";
    if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== sig) return null;
    if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * Google's documented count for one image (Gemini 2.x): 258 tokens when both sides are at most
 * 384 px; otherwise the image is cut into square crop units of floor(shorter side / 1.5) px, 258
 * tokens each. Google calls the count approximate, so the guard reports it as an estimate only
 * and bounds an image request by the model's whole input context (maxRequestCostUsd).
 */
export function imageTokens({ width, height }) {
  if (width <= IMAGE_SMALL_PX && height <= IMAGE_SMALL_PX) return IMAGE_TILE_TOKENS;
  const unit = Math.max(1, Math.floor(Math.min(width, height) / 1.5));
  return Math.ceil(width / unit) * Math.ceil(height / unit) * IMAGE_TILE_TOKENS;
}

/**
 * An inline image part (task proposal 021): { mimeType: "image/png" | "image/jpeg", data } with
 * base64 data and nothing else, whose header gives a size. Returns the image's tile tokens.
 */
function checkInlineImage(d, where) {
  if (!d || typeof d !== "object" || Array.isArray(d))
    refuse("dollars", `${where} is not an object`);
  for (const key of Object.keys(d)) {
    if (!INLINE_FIELDS.has(key)) refuse("dollars", `no admission rule for ${where}.${key}`);
  }
  if (!INLINE_IMAGE_TYPES.has(d.mimeType))
    refuse(
      "dollars",
      `${where}.mimeType must be image/png or image/jpeg: no admission rule prices "${d.mimeType}"`,
    );
  if (
    typeof d.data !== "string" ||
    !d.data.length ||
    d.data.length % 4 !== 0 ||
    !BASE64.test(d.data)
  )
    refuse("dollars", `${where}.data is not base64 data`);
  const size = imageSize(d.mimeType, Buffer.from(d.data, "base64"));
  if (!size || !(size.width > 0) || !(size.height > 0))
    refuse("dollars", `${where}: the image's own header gives no size for ${d.mimeType}`);
  return imageTokens(size);
}

/** Checks one content; returns the tile tokens of its inline images (0 for text only). */
function checkContent(c, where) {
  let imageTokenSum = 0;
  if (!c || typeof c !== "object" || Array.isArray(c))
    refuse("dollars", `${where} is not a content object`);
  for (const key of Object.keys(c)) {
    if (!CONTENT_FIELDS.has(key)) refuse("dollars", `no admission rule for ${where}.${key}`);
  }
  if (c.role !== undefined && c.role !== "user" && c.role !== "model")
    refuse("dollars", `${where}.role is not "user" or "model"`);
  if (!Array.isArray(c.parts) || !c.parts.length) refuse("dollars", `${where}.parts is not a list`);
  c.parts.forEach((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p))
      refuse("dollars", `${where}.parts[${i}] is not a part`);
    const keys = Object.keys(p);
    for (const key of keys) {
      if (!PART_FIELDS.has(key))
        refuse(
          "dollars",
          `${where}.parts[${i}].${key}: only text parts and inline PNG or JPEG images are admitted; file references are not in the request body`,
        );
    }
    if (keys.length !== 1)
      refuse("dollars", `${where}.parts[${i}] must be exactly one of text or inlineData`);
    if (keys[0] === "inlineData") {
      imageTokenSum += checkInlineImage(p.inlineData, `${where}.parts[${i}].inlineData`);
      return;
    }
    if (typeof p.text !== "string") refuse("dollars", `${where}.parts[${i}].text is not text`);
  });
  return imageTokenSum;
}

/**
 * The most one request can cost (§3.1 condition 5). Only requests whose whole
 * input is in the body are admitted (text, and inline PNG or JPEG images as
 * base64), so every input token is in the body:
 * - input: every byte of the serialized body as a token, at the model's
 *   highest input rate; for a grounded request, and for a request with an
 *   inline image, the model's whole input context instead (or the body's bytes
 *   plus the image estimate, if larger): grounding may add input the body does
 *   not show, and Google gives only an approximate count for an image, while no
 *   request can bill more input than the model's context accepts;
 * - output: the larger of maxOutputTokens + thinkingBudget (both required)
 *   and the model's maximum output tokens, at its highest output rate;
 * - fees: every per-request fee, with no free allowance assumed.
 */
export function maxRequestCostUsd(rates, model, body) {
  const r = rates?.models?.[model];
  if (!r) refuse("dollars", `rates.json has no row for ${model}`);
  // Text and inline images: the input rates, both context tiers. Google prices
  // image input at the text input rate for this model (rates.json verbatim rows).
  const inRates = rateValues(r, ["input_"]);
  const outRates = rateValues(r, ["output_"]);
  if (typeof r.input_le_200k !== "number" || typeof r.input_gt_200k !== "number")
    refuse("dollars", `rates.json has no input rate for ${model}`);
  if (typeof r.output_le_200k !== "number" || typeof r.output_gt_200k !== "number")
    refuse("dollars", `rates.json has no output rate for ${model}`);
  if (!Number.isInteger(r.max_output_tokens) || r.max_output_tokens < 1)
    refuse("dollars", `rates.json has no max_output_tokens for ${model}`);
  if (typeof body !== "string") refuse("dollars", "the request body is not a string");
  let req;
  try {
    req = JSON.parse(body);
  } catch {
    refuse("dollars", "the request body is not JSON");
  }
  if (!req || typeof req !== "object" || Array.isArray(req))
    refuse("dollars", "the request body is not a JSON object");
  if (req.cachedContent !== undefined)
    refuse("dollars", "the request names an explicit cache, which no admission rule prices");
  for (const key of Object.keys(req)) {
    if (!REQUEST_FIELDS.has(key))
      refuse("dollars", `no admission rule for the request field "${key}"`);
  }
  if (!Array.isArray(req.contents) || !req.contents.length)
    refuse("dollars", "the request has no contents list");
  let imageTokenSum = 0;
  req.contents.forEach((c, i) => {
    imageTokenSum += checkContent(c, `contents[${i}]`);
  });
  if (req.systemInstruction !== undefined)
    imageTokenSum += checkContent(req.systemInstruction, "systemInstruction");
  const gc = req.generationConfig ?? {};
  for (const key of Object.keys(gc)) {
    if (!GENERATION_FIELDS.has(key))
      refuse("dollars", `no admission rule for generationConfig.${key}`);
  }
  if (gc.candidateCount !== undefined && gc.candidateCount !== 1)
    refuse("dollars", "generationConfig.candidateCount above 1 multiplies the output; refused");
  const maxOut = gc.maxOutputTokens;
  const tc = gc.thinkingConfig ?? {};
  if (!Number.isInteger(maxOut) || maxOut < 1)
    refuse("dollars", "generationConfig.maxOutputTokens is required");
  for (const key of Object.keys(tc)) {
    if (key !== "thinkingBudget" && key !== "thinkingLevel")
      refuse("dollars", `no admission rule for generationConfig.thinkingConfig.${key}`);
  }
  // Either a numeric budget (Gemini 2.5) or a thinking level (Gemini 3). A level sets no
  // token limit, so its thinking is bounded by the model's whole output ceiling.
  let budget;
  if (tc.thinkingLevel !== undefined) {
    if (tc.thinkingBudget !== undefined)
      refuse("dollars", "thinkingConfig names both thinkingBudget and thinkingLevel");
    if (!THINKING_LEVELS.has(tc.thinkingLevel))
      refuse(
        "dollars",
        `thinkingConfig.thinkingLevel must be one of ${[...THINKING_LEVELS].join(", ")}`,
      );
    if (!Number.isInteger(r.max_output_tokens) || r.max_output_tokens < 1)
      refuse("dollars", `rates.json has no max_output_tokens for ${model}`);
    budget = r.max_output_tokens;
  } else {
    budget = tc.thinkingBudget;
    if (!Number.isInteger(budget) || budget < 0)
      refuse(
        "dollars",
        "generationConfig.thinkingConfig needs thinkingBudget (0 or more; -1, dynamic, is refused) or thinkingLevel",
      );
  }
  let feeUsd = 0;
  let grounding = false;
  if (req.tools !== undefined && !Array.isArray(req.tools))
    refuse("dollars", "tools is not a list");
  for (const tool of req.tools ?? []) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool))
      refuse("dollars", "a tool is not an object");
    for (const key of Object.keys(tool)) {
      if (!(key in TOOL_FEES)) refuse("dollars", `no admission rule for the tool "${key}"`);
      if (grounding) refuse("dollars", "Google Search is named more than once");
      const per1000 = rates.fees?.[TOOL_FEES[key]]?.usd_per_1000;
      if (typeof per1000 !== "number")
        refuse("dollars", `rates.json has no fee "${TOOL_FEES[key]}"`);
      feeUsd += per1000 / 1000;
      grounding = true;
    }
  }
  const bytes = Buffer.byteLength(body, "utf8");
  // Every byte of the body. A grounded request, or one with an inline image, is bounded by the
  // model's whole input context: Google's image count is approximate (Codex pre-dispatch review
  // of WU-021, finding 1), so the estimate never lowers the bound.
  let inputTokens = bytes + imageTokenSum;
  if (grounding || imageTokenSum > 0) {
    if (!Number.isInteger(r.max_input_tokens) || r.max_input_tokens < 1)
      refuse(
        "dollars",
        `rates.json has no max_input_tokens for ${model}, which a grounded or image request needs`,
      );
    inputTokens = Math.max(bytes + imageTokenSum, r.max_input_tokens);
  }
  const outCeiling = Math.max(maxOut + budget, r.max_output_tokens);
  const inRate = Math.max(...inRates);
  const outRate = Math.max(...outRates);
  const usd = (inputTokens * inRate + outCeiling * outRate) / 1_000_000 + feeUsd;
  return {
    max_cost_usd: Math.ceil(usd * 1e9) / 1e9,
    input_bytes: bytes,
    image_tile_tokens: imageTokenSum,
    input_ceiling_tokens: inputTokens,
    output_ceiling_tokens: outCeiling,
    highest_input_rate_per_1m: inRate,
    highest_output_rate_per_1m: outRate,
    fees_usd: feeUsd,
    grounding,
  };
}

/**
 * The most an embeddings predict request can cost (AGENTS.md section 3.1 condition 5, the
 * predict rule): the request body's UTF-8 bytes, priced as count at the model's input rate per
 * 1,000 count. Google does not define this row's "count" (rates.json); a text's bytes are at
 * least its characters and at least its tokens, and the body holds every text, so the bound
 * holds either way. Output is free. autoTruncate must be false: a truncated text is billed only
 * up to the cut, so the bound would hold, but a silently cut text is a fault, so it is refused.
 */
export function maxPredictCostUsd(rates, model, body) {
  const r = rates?.models?.[model];
  if (!r) refuse("dollars", `rates.json has no row for ${model}`);
  const rate = r.input_per_1000_count;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
    refuse("dollars", `rates.json has no input_per_1000_count for ${model}`);
  if (typeof body !== "string") refuse("dollars", "the request body is not a string");
  let req;
  try {
    req = JSON.parse(body);
  } catch {
    refuse("dollars", "the request body is not JSON");
  }
  if (!req || typeof req !== "object" || Array.isArray(req))
    refuse("dollars", "the request body is not a JSON object");
  for (const key of Object.keys(req)) {
    if (!PREDICT_FIELDS.has(key))
      refuse("dollars", `no admission rule for the predict field "${key}"`);
  }
  if (!Array.isArray(req.instances) || !req.instances.length)
    refuse("dollars", "the request has no instances list");
  req.instances.forEach((inst, i) => {
    if (!inst || typeof inst !== "object" || Array.isArray(inst))
      refuse("dollars", `instances[${i}] is not an object`);
    for (const key of Object.keys(inst)) {
      if (!PREDICT_INSTANCE_FIELDS.has(key))
        refuse("dollars", `no admission rule for instances[${i}].${key}`);
    }
    if (typeof inst.content !== "string" || !inst.content.length)
      refuse("dollars", `instances[${i}].content must be a non-empty string`);
    if (inst.task_type !== undefined && typeof inst.task_type !== "string")
      refuse("dollars", `instances[${i}].task_type must be a string`);
  });
  const p = req.parameters;
  if (!p || typeof p !== "object" || Array.isArray(p))
    refuse("dollars", "the request has no parameters object (autoTruncate must be set to false)");
  for (const key of Object.keys(p)) {
    if (!PREDICT_PARAMETER_FIELDS.has(key))
      refuse("dollars", `no admission rule for parameters.${key}`);
  }
  if (p.autoTruncate !== false) refuse("dollars", "parameters.autoTruncate must be false");
  if (
    p.outputDimensionality !== undefined &&
    (!Number.isInteger(p.outputDimensionality) || p.outputDimensionality < 1)
  )
    refuse("dollars", "parameters.outputDimensionality must be a positive integer");
  const bytes = Buffer.byteLength(body, "utf8");
  const usd = (bytes / 1000) * rate;
  return {
    max_cost_usd: Math.ceil(usd * 1e9) / 1e9,
    input_bytes: bytes,
    instances: req.instances.length,
    rate_per_1000_count: rate,
    fees_usd: 0,
    grounding: false,
  };
}

/** The bound for one request, by the method its URL names (AGENTS.md section 3.1 condition 5). */
export function maxCostForMethodUsd(rates, model, method, body) {
  if (method === "generateContent") return maxRequestCostUsd(rates, model, body);
  if (method === "predict") return maxPredictCostUsd(rates, model, body);
  refuse("dollars", `no admission rule for the method ${method}`);
}

/** The computed cost of an answered request, by its method; { unpriceable, reason } if none. */
function computeResponseCost(rates, model, method, body) {
  if (method === "predict") {
    const billable = billableCharactersFrom([body]);
    return computeEmbeddingCost(rates, model, { billableCharacters: billable });
  }
  return computeGenerateCost(rates, model, body.usageMetadata);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function lockPath(dir) {
  return path.join(dir, LOCK_FILE);
}

function readLock(dir) {
  try {
    return JSON.parse(readFileSync(lockPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function releaseLock(dir, runId) {
  const held = readLock(dir);
  if (held?.run_id === runId) unlinkSync(lockPath(dir));
}

function findEntry(auth, id) {
  const e = auth.entries.find((x) => x.id === id);
  if (!e) refuse("entry", `AGENTS.md §3.1 has no ledger entry ${id}`);
  return e;
}

/**
 * Opens an authorized run (§3.1 conditions 3 to 7). Refuses, by throwing
 * GuardRefusal, unless every check holds; on success the reservation line is
 * on disk before it returns. Synchronous by design.
 */
export function openRun({
  entry,
  scriptUrl,
  mode,
  maxRequests,
  maxUsd,
  rates,
  dir,
  agentsPath = AGENTS_PATH,
  now = Date.now,
  root = ROOT,
  operatorWaiver,
}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1)
    refuse("count", "maxRequests must be a positive integer");
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0)
    refuse("dollars", "maxUsd must be a positive number");
  if (!rates?.models) refuse("dollars", "rates.json was not loaded");
  // The run prices with its own frozen copy of the rates, taken now, for
  // both admission and settlement: a later change to the caller's object
  // changes nothing (fourth Codex review, P1).
  let runRates;
  try {
    runRates = deepFreeze(structuredClone(rates));
  } catch {
    refuse("dollars", "rates.json cannot be copied");
  }
  const auth = readAuthorizations(agentsPath);
  const e = findEntry(auth, entry);
  let script;
  try {
    script = path.relative(root, fileURLToPath(scriptUrl)).split(path.sep).join("/");
  } catch {
    refuse("entry", "scriptUrl is not a file URL");
  }
  if (script !== e.script) refuse("entry", `${e.id} names ${e.script}, not ${script}`);
  const isCatalogueScript = Object.prototype.hasOwnProperty.call(CATALOGUE_MODE_MATRIX, script);
  if (isCatalogueScript) {
    assertEntryMode(e, { script, mode });
  }
  assertOperatorWaiver(operatorWaiver, { entry: e, script, mode });
  const t = now();
  checkDates(e, auth.window, t);
  const d = gcpDir(dir);
  if (!existsSync(d)) refuse("records", `the records folder ${d} does not exist`);

  const runId = `${utcStamp(new Date(t))}-${randomUUID().slice(0, 8)}`;
  try {
    const fd = openSync(lockPath(d), "wx");
    try {
      writeSync(
        fd,
        JSON.stringify({
          run_id: runId,
          entry: e.id,
          pid: process.pid,
          at: new Date(t).toISOString(),
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (err?.code === "EEXIST") {
      const held = readLock(d);
      refuse(
        "one-run",
        `another run holds ${LOCK_FILE}${held?.run_id ? ` (run ${held.run_id})` : ""}; if it was killed, recover it with ledger.mjs close-interrupted`,
      );
    }
    refuse("one-run", `${LOCK_FILE} cannot be created: ${err?.message ?? err}`);
  }

  try {
    const { sum, newest } = checkState({
      entry: e,
      window: auth.window,
      dir: d,
      t,
      adding: maxUsd,
      addingRequests: maxRequests,
      operatorWaiver,
    });
    if (sum.openRuns.length)
      refuse(
        "one-run",
        `run ${sum.openRuns[0].run_id} has a reservation with no end line; recover it with ledger.mjs close-interrupted`,
      );
    appendLine(d, {
      type: "reservation",
      run_id: runId,
      entry: e.id,
      script: e.script,
      ...(isCatalogueScript ? { mode } : {}),
      lane: e.lane,
      max_usd: maxUsd,
      max_requests: maxRequests,
      credit_record: newest?.name ?? null,
      ...(operatorWaiver ? { operator_waiver: operatorWaiver, credit_check_waived: true } : {}),
      at: new Date(t).toISOString(),
    });
  } catch (err) {
    releaseLock(d, runId);
    throw err;
  }
  return createRunHandle({
    runId,
    entryId: e.id,
    script: e.script,
    mode: isCatalogueScript ? mode : undefined,
    maxUsd,
    maxRequests,
    rates: runRates,
    dir: d,
    now,
    agentsPath,
    operatorWaiver,
  });
}

function createRunHandle({
  runId,
  entryId,
  script,
  mode,
  maxUsd,
  maxRequests,
  rates,
  dir,
  now,
  agentsPath,
  operatorWaiver,
}) {
  let ended = null;
  // attempt_id -> { model, feesUsd, state: "admitted" | "sent" | "settled" }.
  // Held here, not in anything a caller is given, so the model and fee a
  // result is priced with are the ones admit() checked.
  const pending = new Map();
  const internals = {
    /**
     * Checks one outgoing request against §3.1 conditions 3 to 7, on the
     * rules and records as they are now; appends and flushes its attempt
     * line. Returns the attempt's id, which only the capture holds.
     */
    admit({ url, init = {} }) {
      if (ended) refuse("one-run", `run ${runId} has ended`);
      const t = now();
      const auth = readAuthorizations(agentsPath);
      const entry = findEntry(auth, entryId);
      // The entry must still name the script that opened the run (second
      // audit, finding 4).
      if (entry.script !== script)
        refuse(
          "entry",
          `${entry.id} now names ${entry.script}, not ${script}, which opened this run`,
        );
      if (mode !== undefined) {
        assertEntryMode(entry, { script, mode });
      }
      assertOperatorWaiver(operatorWaiver, { entry, script, mode });
      checkDates(entry, auth.window, t);
      if (typeof url !== "string") refuse("endpoint", "the request URL is not a string");
      let u;
      try {
        u = new URL(url);
      } catch {
        refuse("endpoint", "the request URL cannot be parsed");
      }
      if (u.protocol !== "https:") refuse("endpoint", "the request is not HTTPS");
      if (u.hostname !== entry.host || u.port !== "")
        refuse("endpoint", `host ${u.host} is not ${entry.host}`);
      if (u.search !== "" || u.hash !== "" || u.username || u.password)
        refuse("endpoint", "the request URL carries a query, fragment or credentials");
      const m = new RegExp(
        `^/${API_VERSION}/projects/([^/]+)/locations/([^/]+)/publishers/google/models/([A-Za-z0-9._-]+):([A-Za-z]+)$`,
      ).exec(u.pathname);
      if (!m) refuse("endpoint", `path ${u.pathname} is not a ${API_VERSION} publisher-model call`);
      const [, project, location, model, method] = m;
      if (operatorWaiver && (model !== "gemini-3.8-flash" || method !== "generateContent" || location !== "global"))
        refuse("operator-waiver", "the waiver permits only the existing global description-check model");
      if (project !== PROJECT) refuse("endpoint", `project ${project} is not ${PROJECT}`);
      if (location !== entry.location)
        refuse("endpoint", `location ${location} is not ${entry.location}`);
      if (!entry.methods.includes(method))
        refuse("endpoint", `method ${method} is not one of ${entry.methods.join(", ")}`);
      if (String(init.method ?? "GET").toUpperCase() !== "POST")
        refuse("endpoint", "the request is not a POST");
      let headers;
      try {
        headers = new Headers(init.headers ?? {});
      } catch {
        refuse("endpoint", "the request headers cannot be read");
      }
      if (headers.has("x-goog-api-key"))
        refuse("endpoint", "the request carries an API key; §3.1 forbids one by any route");

      const { sum } = checkState({
        entry,
        window: auth.window,
        dir,
        t,
        adding: 0,
        addingRequests: 1,
        operatorWaiver,
      });
      const mine = sum.runs.get(runId);
      if (!mine || mine.ended) refuse("one-run", `run ${runId} has no open reservation`);
      if (mine.attempts.length >= maxRequests)
        refuse(
          "count",
          `run ${runId} is at its request cap (${mine.attempts.length}/${maxRequests})`,
        );
      const bound = maxCostForMethodUsd(rates, model, method, init.body);
      const remaining = money(maxUsd - mine.computed_usd);
      if (over(bound.max_cost_usd, remaining))
        refuse(
          "dollars",
          `this request could cost $${bound.max_cost_usd}; the reservation has $${remaining} left`,
        );
      const n = mine.attempts.length + 1;
      const attempt = {
        type: "attempt",
        run_id: runId,
        entry: entry.id,
        attempt_id: `${runId}:${n}`,
        n,
        model,
        method,
        max_cost_usd: bound.max_cost_usd,
        grounding: bound.grounding,
        at: new Date(t).toISOString(),
      };
      appendLine(dir, attempt);
      pending.set(attempt.attempt_id, {
        model,
        method,
        feesUsd: bound.fees_usd,
        state: "admitted",
      });
      return attempt.attempt_id;
    },
    /** The capture calls this just before it sends an admitted request. */
    markSent(attemptId) {
      const p = pending.get(attemptId);
      if (!p || p.state !== "admitted")
        refuse("one-run", `attempt ${attemptId} is not waiting to be sent`);
      p.state = "sent";
    },
    /**
     * Appends the result line for a request this run admitted and sent, once.
     * After the run has ended nothing is appended: the attempt keeps its
     * maximum cost.
     */
    settle(attemptId, { status = null, bodyText = null, error = null } = {}) {
      const p = pending.get(attemptId);
      if (!p || p.state !== "sent")
        refuse("one-run", `attempt ${attemptId} was not sent by this run, or is already settled`);
      p.state = "settled";
      if (ended) return { outcome: "not_recorded_run_ended", computed_cost_usd: null };
      let outcome;
      let cost = null;
      let reason = null;
      if (error) {
        outcome = "no_response";
        reason = errorKind(error);
      } else if (!(status >= 200 && status < 300)) {
        outcome = "http_error";
      } else {
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          // handled below as unpriceable
        }
        const c = body ? computeResponseCost(rates, p.model, p.method, body) : null;
        if (!c || c.unpriceable) {
          outcome = "unpriceable";
          reason = c?.reason ?? "the response body is not JSON";
        } else {
          outcome = "priced";
          cost = money(c.computed_cost_usd + p.feesUsd);
        }
      }
      appendLine(dir, {
        type: "result",
        run_id: runId,
        entry: entryId,
        attempt_id: attemptId,
        http_status: status,
        outcome,
        computed_cost_usd: cost,
        ...(reason ? { reason } : {}),
        at: new Date(now()).toISOString(),
      });
      return { outcome, computed_cost_usd: cost };
    },
  };
  const run = {
    run_id: runId,
    entry: entryId,
    max_usd: maxUsd,
    max_requests: maxRequests,
    get ended() {
      return ended;
    },
    /** Appends the end line and removes the lock. Safe to call more than once. */
    end(status) {
      if (ended) return ended;
      const allowed = ["completed", "failed", "cap_reached", "stopped"];
      const s = allowed.includes(status) ? status : "failed";
      appendLine(dir, {
        type: "end",
        run_id: runId,
        entry: entryId,
        status: s,
        at: new Date(now()).toISOString(),
      });
      releaseLock(dir, runId);
      ended = s;
      return s;
    },
  };
  GUARD_INTERNALS.set(run, internals);
  return Object.freeze(run);
}
