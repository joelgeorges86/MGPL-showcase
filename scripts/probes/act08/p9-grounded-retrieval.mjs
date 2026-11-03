// ACT-08 P-9: grounded retrieval, and where a citation comes from (#117, #116).
//
// Runs P-1's three cases twice: bare, as P-1 did, and with Google Search
// grounding. Same model, titles, schema and recording contract as P-1. The
// record states, for every case, whether the model's source_citation matches
// a source in the response's grounding metadata or is text the model wrote.
//
// This is the script AGENTS.md section 3.1 ledger entry #117 names. It is
// dry-run by default. On --run it opens a run through the section 3.1 guard
// in lib.mjs, which checks every request before it is sent and records it in
// the spend ledger. The run reserves what the entry has left (requests and
// dollars), so it is never cut short below what the entry allows; the script
// itself stops when its planned requests are done.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_PATH,
  ROOT,
  baseRecord,
  computeGenerateCost,
  createCapture,
  createClient,
  expectedEndpoint,
  finish,
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
  runCli,
  sumComputedCosts,
  summarizeLedger,
} from "./lib.mjs";
import {
  CASES,
  MODEL,
  TABLE,
  buildResponseSchema,
  parseTableColumns,
  promptFor,
  validate,
} from "./p1-structured-output.mjs";

export const PROBE = "p9-grounded-retrieval";
export const ENTRY = "#117";
export const MAX_OUTPUT_TOKENS = 2048;
export const THINKING_BUDGET = 0;
export const GROUNDING_TOOL = { googleSearch: {} };

// A 400 whose message says the schema and the Search tool cannot be combined.
// All three parts must appear (Codex pre-dispatch review, finding 2): the
// Search tool, structured output, and a statement that they cannot be used
// together. Any other 400, such as an invalid schema, stops the run.
const SEARCH_TERMS = /google_?search|search tool|search grounding|grounding/i;
const SCHEMA_TERMS =
  /controlled generation|response_?schema|json(?:\/[a-z]+)* mode|structured output|response_?mime_?type/i;
const REFUSAL_TERMS =
  /not supported|unsupported|can(?:'|no)t be used|cannot|incompatible|not allowed/i;

export function isSchemaWithSearchRefusal(error) {
  const msg = String(error?.message ?? "");
  return (
    error?.status === 400 &&
    SEARCH_TERMS.test(msg) &&
    SCHEMA_TERMS.test(msg) &&
    REFUSAL_TERMS.test(msg)
  );
}

/** The prompt for the grounded mode when the schema cannot ride with Search. */
export function describedSchemaPrompt(title, modelColumns) {
  const fields = modelColumns
    .map((c) => {
      const type = { TEXT: "string", DATETIME: "string", REAL: "number", INTEGER: "integer" }[
        c.sqlType
      ];
      const range = c.range ? `, ${c.range.minimum} to ${c.range.maximum}` : "";
      return `- ${c.name}: ${type}${c.notNull ? ", required, never null" : ", or null"}${range}`;
    })
    .join("\n");
  return `${promptFor(title)}\n\nAnswer with only one JSON object, and no other text, with exactly these keys:\n${fields}`;
}

/** The SDK parameters of one request. */
export function requestParams({ title, grounded, form, schema, modelColumns }) {
  const config = {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingConfig: { thinkingBudget: THINKING_BUDGET },
  };
  if (form === "schema") {
    config.responseMimeType = "application/json";
    config.responseSchema = schema;
  }
  if (grounded) config.tools = [GROUNDING_TOOL];
  const contents =
    form === "described" ? describedSchemaPrompt(title, modelColumns) : promptFor(title);
  return { model: MODEL, contents, config };
}

/**
 * The JSON body @google/genai 2.23.0 sends to Vertex for requestParams()
 * (a unit test compares it with the SDK's own output). Used for the dry-run
 * and to show the guard's bound before anything is sent.
 */
export function vertexBody(params) {
  const { contents, config } = params;
  const body = { contents: [{ parts: [{ text: contents }], role: "user" }] };
  if (config.tools) body.tools = config.tools;
  const gc = { maxOutputTokens: config.maxOutputTokens };
  if (config.responseMimeType) gc.responseMimeType = config.responseMimeType;
  if (config.responseSchema) gc.responseSchema = config.responseSchema;
  gc.thinkingConfig = config.thinkingConfig;
  body.generationConfig = gc;
  return JSON.stringify(body);
}

/** The planned requests, in order. The preflight decides the form of the rest. */
export function plan(schema, modelColumns) {
  const bare = CASES.map((c, i) => ({
    step: `bare ${i + 1}`,
    mode: "bare",
    case: c,
    form: "schema",
  }));
  const preflight = {
    step: "grounded preflight",
    mode: "grounded",
    case: CASES[0],
    form: "schema",
  };
  const grounded = CASES.slice(1).map((c, i) => ({
    step: `grounded ${i + 2}`,
    mode: "grounded",
    case: c,
    form: "settled by the preflight",
  }));
  return { bare, preflight, grounded, schema, modelColumns };
}

/** Pulls the JSON object out of a model's text, for the described form. */
export function parseJsonText(text) {
  if (typeof text !== "string") return { ok: false, error: "no text" };
  const t = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, error: "no JSON object in the text" };
  try {
    return { ok: true, value: JSON.parse(t.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** The grounding metadata of a response, verbatim, or null. */
export function groundingOf(response) {
  const gm = response?.candidates?.[0]?.groundingMetadata;
  if (!gm) return null;
  return {
    webSearchQueries: gm.webSearchQueries ?? null,
    groundingChunks: gm.groundingChunks ?? null,
    groundingSupports: gm.groundingSupports ?? null,
    searchEntryPoint: gm.searchEntryPoint ?? null,
  };
}

export const PROVENANCE_RULES = [
  "null: the model returned no source_citation",
  "exact_uri: a URL in the citation equals a grounding source's URI, compared as parsed URLs",
  "same_host: a URL in the citation has exactly the host a grounding source's title names (Vertex titles sources by domain)",
  "exact_title: the whole citation equals a grounding source's title, ignoring case and surrounding space",
  "title_mentioned: a grounding source's title appears inside the citation as a separate word or domain, not as part of a longer name",
  "no_match: none of the above; this says only that the text does not correspond to a source, not where the model took it from",
];

function urlsIn(text) {
  const out = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    try {
      out.push(new URL(m[0]));
    } catch {
      // not a URL after all
    }
  }
  return out;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a source_citation value corresponds to the response's grounding
 * sources, by the rules in PROVENANCE_RULES (Codex pre-dispatch review,
 * finding 4). Textual correspondence only: a match does not show the model
 * took the citation from the metadata, and no_match does not show it made the
 * citation up. Both sides are kept.
 */
export function provenanceOf(citation, grounding) {
  const sources = (grounding?.groundingChunks ?? [])
    .map((c) => c?.web ?? c?.retrievedContext ?? null)
    .filter(Boolean)
    .map((w) => ({ uri: w.uri ?? null, title: w.title ?? null }));
  if (citation === null || citation === undefined)
    return { finding: "null", citation: null, sources };
  const text = String(citation);
  const urls = urlsIn(text);
  const result = (finding, matched) => ({
    finding,
    citation: text,
    matched_source: matched ?? null,
    sources,
  });
  for (const s of sources) {
    if (!s.uri) continue;
    let su;
    try {
      su = new URL(s.uri);
    } catch {
      continue;
    }
    if (urls.some((u) => u.href === su.href)) return result("exact_uri", s);
  }
  for (const s of sources) {
    const title = s.title?.trim().toLowerCase();
    if (title && urls.some((u) => u.hostname.toLowerCase() === title))
      return result("same_host", s);
  }
  for (const s of sources) {
    const title = s.title?.trim().toLowerCase();
    if (title && text.trim().toLowerCase() === title) return result("exact_title", s);
  }
  for (const s of sources) {
    const title = s.title?.trim().toLowerCase();
    if (!title) continue;
    // a separate word or domain: not followed or preceded by a letter, digit, dot or hyphen
    const re = new RegExp(`(^|[^a-z0-9.-])${escapeRe(title)}($|[^a-z0-9.-]|\\.(?![a-z0-9]))`, "i");
    if (re.test(text)) return result("title_mentioned", s);
  }
  return result("no_match", null);
}

function groundingFeeUsd(rates) {
  const per1000 = rates.fees?.grounding_google_search?.usd_per_1000;
  if (typeof per1000 !== "number") throw new Error("rates.json has no grounding fee");
  return per1000 / 1000;
}

/** What entry #117 has left: requests and dollars, from AGENTS.md and the ledger. */
export async function entryHeadroom({ dir, agentsPath = AGENTS_PATH } = {}) {
  const auth = parseAuthorizations(await readFile(agentsPath, "utf8"));
  const entry = auth.entries.find((e) => e.id === ENTRY);
  if (!entry) throw new Error(`AGENTS.md section 3.1 has no entry ${ENTRY}`);
  const sum = summarizeLedger(readLedger(gcpDir(dir)));
  const used = sum.attemptsByEntry.get(ENTRY) ?? 0;
  const liabilities = [...sum.runs.values()]
    .filter((r) => r.entry === ENTRY)
    .reduce((n, r) => n + r.liability_usd, 0);
  return {
    requests: entry.request_cap - used,
    // whole cents, rounded down, so the reservation never exceeds the cap
    usd: Math.floor((entry.dollar_cap_usd - liabilities) * 100 + 1e-9) / 100,
    request_cap: entry.request_cap,
    dollar_cap_usd: entry.dollar_cap_usd,
    lane: entry.lane,
  };
}

async function sendOne(ai, step, params, rates, modelColumns, exchanges) {
  const out = {
    step: step.step,
    mode: step.mode,
    title: step.case.title,
    expectation: step.case.expect,
    input_source: step.case.source,
    form: step.formUsed ?? step.form,
    request: params,
  };
  const before = exchanges.length;
  const t0 = Date.now();
  try {
    const res = await ai.models.generateContent(params);
    out.latency_ms = Date.now() - t0;
    out.usage = res.usageMetadata ?? null;
    const cost = computeGenerateCost(rates, MODEL, res.usageMetadata);
    if (!cost.unpriceable && step.mode === "grounded") {
      const fee = groundingFeeUsd(rates);
      cost.grounding_fee_usd = fee;
      cost.grounding_fee_note =
        "the full per-prompt fee, with no free allowance assumed; Google bills it only when sources come back";
      cost.computed_cost_usd = round(cost.computed_cost_usd + fee);
    }
    out.cost = cost;
    out.text = res.text ?? null;
    let parsed;
    if (out.form === "schema") {
      try {
        parsed = { ok: true, value: JSON.parse(out.text) };
      } catch (e) {
        parsed = { ok: false, error: String(e?.message ?? e) };
      }
    } else {
      parsed = parseJsonText(out.text);
    }
    out.parse_ok = parsed.ok;
    if (!parsed.ok) out.parse_error = parsed.error;
    out.violations = parsed.ok
      ? validate(parsed.value, modelColumns)
      : ["response did not parse as JSON"];
    out.schema_honoured = out.violations.length === 0;
    out.grounding = groundingOf(res);
    out.provenance = provenanceOf(parsed.ok ? parsed.value?.source_citation : null, out.grounding);
  } catch (e) {
    out.latency_ms = Date.now() - t0;
    out.error = { name: e?.name, status: e?.status ?? null, message: String(e?.message ?? e) };
  }
  out.exchange_indexes = exchanges.slice(before).map((x) => x.attempt);
  return out;
}

/**
 * deps (tests only): dir (records folder), makeClient(capture), baseFetch,
 * now, interrupts (an event emitter in place of process, for SIGINT), and
 * write(record, summary) in place of writing the run record.
 */
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const dbSource = await readFile(path.join(ROOT, "src", "db.ts"), "utf8");
  const parsed = parseTableColumns(dbSource, TABLE);
  const { modelColumns, schema } = buildResponseSchema(parsed.columns);
  const p = plan(schema, modelColumns);
  const endpoint = expectedEndpoint(MODEL, "generateContent");

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      const rates = await loadRates();
      const show = (step, form) => {
        const params = requestParams({
          title: step.case.title,
          grounded: step.mode === "grounded",
          form,
          schema,
          modelColumns,
        });
        const body = vertexBody(params);
        const bound = maxRequestCostUsd(rates, MODEL, body);
        return `${step.step} (${form}): guard bound $${bound.max_cost_usd}; body ${body}`;
      };
      printDryRun([
        `probe: ${PROBE} (AGENTS.md section 3.1 entry ${ENTRY})`,
        `model: ${MODEL}; endpoint (expected; the actual URL is recorded on --run): ${endpoint}`,
        `every request: text only, maxOutputTokens ${MAX_OUTPUT_TOKENS}, thinkingBudget ${THINKING_BUDGET}, no SDK retries`,
        `reservation on --run: what ${ENTRY} has left (requests and dollars), read from AGENTS.md and the spend ledger`,
        "planned requests, in order:",
        ...p.bare.map((s) => `  ${show(s, "schema")}`),
        `  ${show(p.preflight, "schema")}`,
        "  then, if the preflight is accepted, the other grounded cases with the schema:",
        ...p.grounded.map((s) => `    ${show(s, "schema")}`),
        "  or, if it is refused (400), every grounded case with the schema described in the prompt:",
        ...[{ ...p.preflight, step: "grounded 1" }, ...p.grounded].map(
          (s) => `    ${show(s, "described")}`,
        ),
        "total: 6 requests (preflight accepted) or 7 (preflight refused)",
      ]);
    } finally {
      restore();
    }
    return 0;
  }

  const rates = await loadRates();
  const now = deps.now ?? Date.now;
  const headroom = await entryHeadroom({ dir: deps.dir });
  // Opens the run, or throws GuardRefusal (exit 2) before anything is sent.
  const run = openRun({
    entry: ENTRY,
    scriptUrl: import.meta.url,
    maxRequests: headroom.requests,
    maxUsd: headroom.usd,
    rates,
    dir: deps.dir,
    now,
  });

  // From here every path ends the run (Codex pre-dispatch review, finding 3):
  // the interrupt handler is installed before the next await, and all setup
  // is inside the try whose finally calls run.end().
  const interrupts = deps.interrupts ?? process;
  let stop = null;
  const onSigint = () => {
    stop = stop ?? "operator interrupt (SIGINT)";
  };
  interrupts.once("SIGINT", onSigint);
  let endStatus = "failed";
  const record = {};
  let capture = null;
  try {
    Object.assign(record, await baseRecord(PROBE, argv));
    Object.assign(record, {
      executed_by: `${headroom.lane}, the lane AGENTS.md section 3.1 entry ${ENTRY} names (the run's report confirms who ran it)`,
      interrupt_note:
        "Ctrl+C stops the run before its next request; a request already sent is allowed to finish and is recorded",
      ledger_entry: ENTRY,
      run_id: run.run_id,
      reservation: { max_requests: headroom.requests, max_usd: headroom.usd },
      model: MODEL,
      endpoint_expected: endpoint,
      rate: rateRef(rates, MODEL),
      grounding_fee: rates.fees?.grounding_google_search ?? null,
      schema_source: { file: "src/db.ts", table: TABLE, ddl_verbatim: parsed.ddl },
      response_schema: schema,
      steps: [],
    });
    capture = createCapture({
      maxRequests: headroom.requests,
      guard: run,
      ...(deps.baseFetch ? { baseFetch: deps.baseFetch } : {}),
    });
    record.exchanges = capture.exchanges;
    const ai = deps.makeClient ? deps.makeClient(capture) : await createClient(capture);
    const go = async (step, form) => {
      if (stop) return null;
      step.formUsed = form;
      const params = requestParams({
        title: step.case.title,
        grounded: step.mode === "grounded",
        form,
        schema,
        modelColumns,
      });
      const out = await sendOne(ai, step, params, rates, modelColumns, capture.exchanges);
      record.steps.push(out);
      return out;
    };

    for (const s of p.bare) {
      const out = await go(s, "schema");
      if (!out || out.error) stop = stop ?? `bare request failed: ${out?.error?.message}`;
    }
    let groundedForm = "schema";
    let remaining = p.grounded;
    if (!stop) {
      const pre = await go(p.preflight, "schema");
      if (pre?.error) {
        if (isSchemaWithSearchRefusal(pre.error)) {
          groundedForm = "described";
          record.preflight_finding = {
            schema_with_search: "refused",
            status: 400,
            message: pre.error.message,
            consequence:
              "the grounded cases describe the schema in the prompt and are parsed from text",
          };
          remaining = [p.preflight, ...p.grounded];
        } else {
          stop = `grounded preflight failed: ${pre.error.message}`;
        }
      } else if (pre) {
        record.preflight_finding = { schema_with_search: "accepted" };
      }
    }
    for (const s of remaining) {
      if (stop) break;
      const out = await go({ ...s, step: s === p.preflight ? "grounded 1" : s.step }, groundedForm);
      if (!out || out.error) stop = stop ?? `grounded request failed: ${out?.error?.message}`;
    }
    record.grounded_form = groundedForm;
    endStatus = stop ? (stop.startsWith("operator") ? "stopped" : "failed") : "completed";
  } catch (e) {
    record.error = { name: e?.name, message: String(e?.message ?? e) };
    stop = stop ?? `unexpected: ${record.error.message}`;
  } finally {
    interrupts.removeListener("SIGINT", onSigint);
    run.end(endStatus);
  }

  record.steps = record.steps ?? [];
  const sent = capture ? capture.attempts : 0;
  const bare = record.steps.filter((s) => s.mode === "bare");
  const grounded = record.steps.filter((s) => s.mode === "grounded" && !s.error);
  const totalOf = (xs) => sumComputedCosts(xs.map((s) => s.cost));
  record.result = {
    stop_reason: stop,
    requests_sent: sent,
    grounded_form: record.grounded_form ?? null,
    computed_cost_bare: totalOf(bare),
    computed_cost_grounded: totalOf(grounded),
    provenance: record.steps
      .filter((s) => s.provenance)
      .map((s) => ({ step: s.step, title: s.title, finding: s.provenance.finding })),
    provenance_rules: PROVENANCE_RULES,
    tool_use_prompt_tokens: grounded.map((s) => ({
      step: s.step,
      toolUsePromptTokenCount: s.usage?.toolUsePromptTokenCount ?? null,
    })),
    note: "computed_cost_usd is computed from usage and rates.json, not charged; reconciliation against the billing export follows (AGENTS.md section 3.1)",
  };
  const totals = totalOf(record.steps);
  record.computed_cost_usd = totals.computed_cost_usd;
  record.computed_cost_totals = totals;
  record.exit_status = stop ? 1 : 0;
  const summary = `${PROBE}: ${stop ? `STOPPED (${stop})` : "done"}; run ${run.run_id}; requests ${sent}; grounded form ${record.grounded_form ?? "n/a"}; computed_cost_usd ${totals.computed_cost_usd ?? "unpriceable"}`;
  if (deps.write) return deps.write(record, summary);
  return finish(PROBE, record, summary);
}

if (isMain(import.meta.url)) runCli(main);
