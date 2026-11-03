// ACT-08 P-5: code execution sandbox, cost capture only.
//
// The 2026-09-17 run asked for "the standard deviation of ten playtime
// values" and recorded 47.22 (independently verified 47.2171) and 739 total
// tokens. The prompt text and the ten values were not recorded anywhere in
// the repository. Without them this script cannot rerun the same test, and it
// will not substitute an adjacent one: it exits with that finding (exit 3)
// and sends nothing.
//
// If the operator recovers the original prompt, pass it verbatim with
// --prompt-file. The script then reruns that prompt with the code execution
// tool and records tokens and computed cost beside the 2026-09-17 figures.

import { readFile } from "node:fs/promises";
import path from "node:path";
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
  runCli,
} from "./lib.mjs";

export const PROBE = "p5-code-execution";
export const MODEL = "gemini-2.5-flash";
export const RECORDED_2026_09_17 = {
  source: "DOCS/research/ACT-08-phase1-results-and-gemini-charter.md, P-5 (operator-executed)",
  reported_result: "47.22",
  independently_verified: "47.2171",
  tokens: { prompt: 62, response: 224, tool_use_overhead: 361, thinking: 92, total: 739 },
  prompt_recorded: false,
  values_recorded: false,
};
export const FINDING =
  "P-5 cannot be rerun faithfully: the 2026-09-17 prompt and its ten playtime values are not recorded in the repository. Pass the original prompt with --prompt-file to capture cost for the same test.";

export async function main(argv) {
  const args = parseArgs(argv, { "prompt-file": "string" });
  const endpoint = expectedEndpoint(MODEL, "generateContent");
  let prompt = null;
  if (args["prompt-file"]) {
    const file = path.resolve(args["prompt-file"]);
    prompt = await readFile(file, "utf8").catch(() => {
      throw new UsageError(`Prompt file not found: ${file}`);
    });
    if (!prompt.trim()) throw new UsageError("Prompt file is empty");
  }
  const request = prompt && {
    model: MODEL,
    contents: prompt,
    config: { tools: [{ codeExecution: {} }] },
  };

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      printDryRun(
        request
          ? [
              `probe: ${PROBE}`,
              `model: ${MODEL}`,
              `endpoint (expected; the actual URL is recorded on --run): ${endpoint}`,
              "requests: 1",
              `request: ${JSON.stringify(request)}`,
              `estimated input tokens (heuristic, chars/4): ${estimateTokens(prompt)}; 2026-09-17 recorded 739 total including tool overhead`,
            ]
          : [
              `probe: ${PROBE}`,
              `FINDING: ${FINDING}`,
              "--run without --prompt-file sends nothing and exits 3.",
            ],
      );
    } finally {
      restore();
    }
    return 0;
  }

  const rates = await loadRates();
  const record = await baseRecord(PROBE, argv);
  Object.assign(record, {
    model: MODEL,
    endpoint_expected: endpoint,
    rate: rateRef(rates, MODEL),
    recorded_2026_09_17: RECORDED_2026_09_17,
  });
  if (!request) {
    record.finding = FINDING;
    record.computed_cost_usd = 0;
    record.exit_status = 3;
    return finish(
      PROBE,
      record,
      `${PROBE}: FINDING, original prompt not recorded, nothing sent; computed_cost_usd 0`,
    );
  }
  record.prompt_verbatim = prompt;
  record.prompt_source =
    "operator-supplied via --prompt-file; the operator attests it is the 2026-09-17 prompt";
  const capture = createCapture({ maxRequests: 1 });
  record.exchanges = capture.exchanges;
  let failed = false;
  const t0 = Date.now();
  try {
    const ai = await createClient(capture);
    const res = await ai.models.generateContent(request);
    record.latency_ms = Date.now() - t0;
    record.usage = res.usageMetadata ?? null;
    record.cost = computeGenerateCost(rates, MODEL, res.usageMetadata);
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    record.executable_code = parts.filter((p) => p.executableCode).map((p) => p.executableCode);
    record.code_execution_result = parts
      .filter((p) => p.codeExecutionResult)
      .map((p) => p.codeExecutionResult);
    record.text = res.text ?? null;
    record.sandbox_executed = record.code_execution_result.length > 0;
  } catch (e) {
    record.latency_ms = Date.now() - t0;
    record.error = { name: e?.name, status: e?.status ?? null, message: String(e?.message ?? e) };
    failed = true;
  }
  record.computed_cost_usd = record.cost ? record.cost.computed_cost_usd : 0;
  record.exit_status = failed ? 1 : 0;
  return finish(
    PROBE,
    record,
    `${PROBE}: ${failed ? "FAILED" : "done"}; sandbox executed ${record.sandbox_executed ?? false}; tokens ${record.usage?.totalTokenCount ?? "n/a"} (09-17: 739); computed_cost_usd ${record.computed_cost_usd ?? "unpriceable"}`,
  );
}

if (isMain(import.meta.url)) runCli(main);
