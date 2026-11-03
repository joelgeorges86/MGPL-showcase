// ACT-08 P-8: rate and quota behaviour under sustained load.
//
// The only probe whose cost is not bounded by its own design, so the bound
// is a hard request counter: --max-requests is mandatory, has no default,
// and counts every HTTP attempt, SDK retries included. Once it is reached no
// further request is sent. Reaching the cap without throttling is a valid
// result, recorded as "ceiling not reached at N requests".
//
// Stops at the first request that ultimately fails, including the first 429
// (with SDK retries off, which is the SDK's own default), and records the
// exact error body. Prints cumulative computed cost after every request so
// the operator can stop by eye (Ctrl+C still writes the record).

import {
  UsageError,
  baseRecord,
  computeGenerateCost,
  createCapture,
  createClient,
  estimateTokens,
  expectedEndpoint,
  finish,
  forbidNetwork,
  isMain,
  loadRates,
  parseArgs,
  printDryRun,
  rateRef,
  round,
  sumComputedCosts,
  runCli,
} from "./lib.mjs";

export const PROBE = "p8-rate-quota";
export const MODEL = "gemini-2.5-flash";
export const MAX_CONCURRENCY = 32;
export const REQUEST = {
  model: MODEL,
  contents: "Reply with the single word: ok",
  config: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 4 },
};
const EST_OUTPUT_TOKENS = 4;

export function parseP8Args(argv) {
  const args = parseArgs(argv, { "max-requests": "int", concurrency: "int", "sdk-retries": "int" });
  if (args["max-requests"] === undefined) {
    throw new UsageError(
      "--max-requests is mandatory and has no default. The cap is the only bound on this probe's cost.",
    );
  }
  args.concurrency = args.concurrency ?? 1;
  if (args.concurrency > MAX_CONCURRENCY)
    throw new UsageError(`--concurrency above ${MAX_CONCURRENCY} is refused`);
  return args;
}

export function worstCaseCost(rates, maxRequests) {
  const perRequest = computeGenerateCost(rates, MODEL, {
    promptTokenCount: estimateTokens(REQUEST.contents),
    candidatesTokenCount: EST_OUTPUT_TOKENS,
  }).computed_cost_usd;
  return {
    per_request_estimate_usd: perRequest,
    cap_estimate_usd: round(perRequest * maxRequests),
  };
}

/** Classifies what the client did around the first throttled attempt, from the captured exchanges. */
export function classifyClientBehaviour(exchanges, logical) {
  const first429 = exchanges.findIndex((x) => x.status === 429);
  if (first429 < 0) return "no throttling observed";
  const failedLogical = logical.find((l) => l.error);
  const retriesAfter = exchanges.slice(first429 + 1).length;
  if (!failedLogical) return "throttled attempt(s) retried by the SDK and recovered";
  return retriesAfter > 0 && failedLogical.attempts > 1
    ? "retried by the SDK, then failed"
    : "failed on the first 429 (no retry)";
}

export async function main(argv) {
  const args = parseP8Args(argv);
  const cap = args["max-requests"];
  const rates = await loadRates();
  const endpoint = expectedEndpoint(MODEL, "generateContent");
  const retryOptions = args["sdk-retries"] ? { attempts: args["sdk-retries"] } : undefined;
  const worst = worstCaseCost(rates, cap);

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      printDryRun([
        `probe: ${PROBE}`,
        `model: ${MODEL}`,
        `endpoint (expected; the actual URL is recorded on --run): ${endpoint}`,
        `request (repeated): ${JSON.stringify(REQUEST)}`,
        `hard cap: ${cap} HTTP attempts, SDK retries included; concurrency ${args.concurrency}`,
        `SDK retries: ${retryOptions ? `on, attempts ${retryOptions.attempts} per request` : "off (SDK default)"}`,
        `stops at: the first request that ultimately fails (including the first 429), or the cap`,
        `computed cost estimate (heuristic tokens): ${worst.per_request_estimate_usd} per request; ${worst.cap_estimate_usd} if the cap is reached`,
      ]);
    } finally {
      restore();
    }
    return 0;
  }

  const record = await baseRecord(PROBE, argv);
  Object.assign(record, {
    model: MODEL,
    endpoint_expected: endpoint,
    rate: rateRef(rates, MODEL),
    max_requests_cap: cap,
    concurrency: args.concurrency,
    sdk_retry_options: retryOptions ?? "none (SDK default: no retry)",
    request: REQUEST,
    pre_run_estimate: worst,
  });
  const capture = createCapture({ maxRequests: cap });
  record.exchanges = capture.exchanges;
  const logical = [];
  let stop = false;
  let stopReason = null;
  let cumulative = 0;
  const onSigint = () => {
    stop = true;
    stopReason = stopReason ?? "operator interrupt (SIGINT)";
  };
  process.once("SIGINT", onSigint);
  const t0 = Date.now();
  try {
    const ai = await createClient(capture, retryOptions ? { retryOptions } : {});
    const worker = async () => {
      while (!stop && capture.attempts < cap) {
        const before = capture.attempts;
        const entry = { n: logical.length + 1, started_ms: Date.now() - t0 };
        logical.push(entry);
        try {
          const res = await ai.models.generateContent(REQUEST);
          entry.attempts = capture.attempts - before;
          entry.cost = computeGenerateCost(rates, MODEL, res.usageMetadata);
          cumulative = sumComputedCosts(logical.map((l) => l.cost)).computed_cost_usd;
          console.log(
            `#${entry.n} ok attempts=${capture.attempts}/${cap} cumulative computed_cost_usd ${cumulative ?? "unpriceable"}`,
          );
        } catch (e) {
          entry.attempts = capture.attempts - before;
          if (e?.capReached) {
            logical.splice(logical.indexOf(entry), 1);
            stop = true;
            stopReason = stopReason ?? "cap reached";
            break;
          }
          entry.error = {
            name: e?.name,
            status: e?.status ?? null,
            message: String(e?.message ?? e),
          };
          console.log(
            `#${entry.n} error status=${entry.error.status} attempts=${capture.attempts}/${cap} cumulative computed_cost_usd ${cumulative ?? "unpriceable"}`,
          );
          stop = true;
          stopReason =
            stopReason ??
            (entry.error.status === 429
              ? "throttled (429)"
              : `error (status ${entry.error.status})`);
        }
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, worker));
    if (!stopReason && capture.attempts >= cap) stopReason = "cap reached";
  } catch (e) {
    record.error = { name: e?.name, message: String(e?.message ?? e) };
    stopReason = stopReason ?? "client setup failed";
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  const elapsed = Date.now() - t0;
  const ok = logical.filter((l) => !l.error).length;
  const first429 = capture.exchanges.find((x) => x.status === 429);
  record.logical_requests = logical;
  const totals = sumComputedCosts(logical.map((l) => l.cost));
  record.computed_cost_usd = totals.computed_cost_usd;
  record.computed_cost_totals = totals;
  record.result = {
    stop_reason: stopReason,
    http_attempts: capture.attempts,
    successful_requests: ok,
    elapsed_ms: elapsed,
    observed_rate_per_min: elapsed > 0 ? round((ok / elapsed) * 60000) : null,
    ceiling:
      first429 != null
        ? `throttled at HTTP attempt ${first429.attempt} after ${ok} successful requests in ${elapsed} ms`
        : stopReason === "cap reached"
          ? `ceiling not reached at ${cap} requests`
          : `not determined (${stopReason})`,
    first_429_error_body_verbatim: first429?.response_body ?? null,
    client_behaviour: classifyClientBehaviour(capture.exchanges, logical),
  };
  const throttledOrCap = first429 != null || stopReason === "cap reached";
  record.exit_status =
    record.error || (!throttledOrCap && stopReason !== "operator interrupt (SIGINT)") ? 1 : 0;
  return finish(
    PROBE,
    record,
    `${PROBE}: ${record.result.ceiling}; client: ${record.result.client_behaviour}; attempts ${capture.attempts}/${cap}; computed_cost_usd ${totals.computed_cost_usd ?? "unpriceable"}`,
  );
}

if (isMain(import.meta.url)) runCli(main);
