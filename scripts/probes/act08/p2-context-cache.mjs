// ACT-08 P-2: context caching at repository scale.
//
// Submits one large, stable context (repository tree, rule files, schema
// authority, as listed in the corpus manifest) twice, as byte-identical
// requests, and records the computed cost of each call separately. The
// difference between the two is the result.
//
// Implicit caching only. Explicit caching creates a cachedContents resource,
// and these scripts create no resources, so it is not attempted.
//
// Prior results stay on the record and are not reconciled here:
//   2026-09-17 (operator, raw REST): implicit caching returned no cache
//     metadata on two calls; explicit caching refused the body as "1 tokens".
//   2026-09-22 (RETEST, SDK, unattributed): an explicit cache was created and
//     one follow-up call reported 46,562 cached tokens.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  HERE,
  ROOT,
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
  runCli,
  sumComputedCosts,
} from "./lib.mjs";

export const PROBE = "p2-context-cache";
export const MODEL = "gemini-2.5-flash";
export const DEFAULT_MANIFEST = path.join(HERE, "p2-corpus.manifest");
export const QUESTION =
  "In one sentence, name the file this corpus identifies as the sole schema authority.";
const DEFAULT_GAP_MS = 5000;
const MAX_ESTIMATED_TOKENS = 1_000_000;

export function parseManifest(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export async function assembleCorpus(entries, { root = ROOT, lsFiles } = {}) {
  const parts = [];
  const files = [];
  for (const entry of entries) {
    let content;
    let label = entry;
    if (entry === "@git-ls-files") {
      content = lsFiles ?? execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
      label = "repository tree (git ls-files)";
    } else {
      const abs = path.resolve(root, entry);
      if (!abs.startsWith(path.resolve(root) + path.sep))
        throw new UsageError(`Manifest path escapes the repository: ${entry}`);
      try {
        content = await readFile(abs, "utf8");
      } catch {
        throw new UsageError(`Manifest path not found: ${entry}. Nothing was sent.`);
      }
    }
    files.push({
      entry,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    parts.push(`===== ${label} =====\n${content}`);
  }
  const corpus = parts.join("\n\n");
  return { corpus, files, sha256: createHash("sha256").update(corpus).digest("hex") };
}

export function buildRequest(corpus) {
  return {
    model: MODEL,
    contents: `${corpus}\n\n===== question =====\n${QUESTION}`,
    config: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 64 },
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { "corpus-manifest": "string", "gap-ms": "int" });
  const manifestPath = path.resolve(args["corpus-manifest"] ?? DEFAULT_MANIFEST);
  const manifestText = await readFile(manifestPath, "utf8").catch(() => {
    throw new UsageError(`Corpus manifest not found: ${manifestPath}`);
  });
  const entries = parseManifest(manifestText);
  if (entries.length === 0) throw new UsageError("Corpus manifest lists no entries");
  const { corpus, files, sha256 } = await assembleCorpus(entries);
  const request = buildRequest(corpus);
  const estimated = estimateTokens(request.contents);
  if (estimated > MAX_ESTIMATED_TOKENS) {
    throw new UsageError(
      `Corpus estimated at ${estimated} tokens, above ${MAX_ESTIMATED_TOKENS}. Nothing was sent.`,
    );
  }
  const gapMs = args["gap-ms"] ?? DEFAULT_GAP_MS;
  const endpoint = expectedEndpoint(MODEL, "generateContent");

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      printDryRun([
        `probe: ${PROBE}`,
        `model: ${MODEL}`,
        `endpoint (expected; the actual URL is recorded on --run): ${endpoint}`,
        `manifest: ${path.relative(ROOT, manifestPath).split(path.sep).join("/")}`,
        ...files.map((f) => `  ${f.entry}  ${f.bytes} bytes  sha256 ${f.sha256}`),
        `corpus sha256: ${sha256}; ${Buffer.byteLength(corpus, "utf8")} bytes`,
        `requests: 2, byte-identical, ${gapMs} ms apart`,
        `config: ${JSON.stringify(request.config)}`,
        `question: ${QUESTION}`,
        `estimated input tokens per call (heuristic, chars/4): ${estimated}`,
        "explicit caching: not attempted (creates a cachedContents resource)",
      ]);
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
    corpus: {
      manifest: path.relative(ROOT, manifestPath).split(path.sep).join("/"),
      manifest_verbatim: manifestText,
      files,
      sha256,
    },
    request_config: request.config,
    question: QUESTION,
    gap_ms: gapMs,
    caching_mode:
      "implicit only; explicit caching not attempted because it creates a cachedContents resource",
    prior_results_not_reconciled: [
      "2026-09-17, operator, raw REST: implicit caching returned no cache metadata on two calls; explicit caching refused as '1 tokens' (DOCS/research/ACT-08-phase1-results-and-gemini-charter.md)",
      "2026-09-22, RETEST, SDK, executor unattributed: explicit cache created; one follow-up call reported 46,562 cached tokens (DOCS/research/ACT-08-RETEST-EVIDENCE.md)",
    ],
    calls: [],
  });
  const capture = createCapture({ maxRequests: 2 });
  record.exchanges = capture.exchanges;
  let failed = false;
  try {
    const ai = await createClient(capture);
    for (let i = 0; i < 2; i++) {
      if (i === 1) await new Promise((r) => setTimeout(r, gapMs));
      const call = { call: i + 1 };
      record.calls.push(call);
      const t0 = Date.now();
      try {
        const res = await ai.models.generateContent(request);
        call.latency_ms = Date.now() - t0;
        call.usage = res.usageMetadata ?? null;
        call.cost = computeGenerateCost(rates, MODEL, res.usageMetadata);
        call.text = res.text ?? null;
      } catch (e) {
        call.latency_ms = Date.now() - t0;
        call.error = { name: e?.name, status: e?.status ?? null, message: String(e?.message ?? e) };
        failed = true;
        break;
      }
    }
  } catch (e) {
    record.error = { name: e?.name, message: String(e?.message ?? e) };
    failed = true;
  }
  const [c1, c2] = record.calls;
  record.result =
    c1?.cost && c2?.cost && !c1.cost.unpriceable && !c2.cost.unpriceable
      ? {
          computed_cost_call_1_usd: c1.cost.computed_cost_usd,
          computed_cost_call_2_usd: c2.cost.computed_cost_usd,
          computed_difference_usd: round(c1.cost.computed_cost_usd - c2.cost.computed_cost_usd),
          cached_tokens_call_1: c1.cost.tokens_in_cached,
          cached_tokens_call_2: c2.cost.tokens_in_cached,
          implicit_cache_hit_on_call_2: c2.cost.tokens_in_cached > 0,
        }
      : c1?.cost && c2?.cost
        ? {
            unpriceable: true,
            reason_call_1: c1.cost.reason ?? null,
            reason_call_2: c2.cost.reason ?? null,
          }
        : { incomplete: true };
  const totals = sumComputedCosts(record.calls.map((c) => c.cost));
  record.computed_cost_usd = totals.computed_cost_usd;
  record.computed_cost_totals = totals;
  record.exit_status = failed ? 1 : 0;
  const r = record.result;
  return finish(
    PROBE,
    record,
    r.unpriceable
      ? `${PROBE}: done, UNPRICEABLE usage (${r.reason_call_1 ?? r.reason_call_2}); requests ${capture.attempts}; computed_cost_usd unpriceable`
      : r.incomplete
        ? `${PROBE}: FAILED; requests ${capture.attempts}; computed_cost_usd ${record.computed_cost_usd}`
        : `${PROBE}: done; call1 ${r.computed_cost_call_1_usd} call2 ${r.computed_cost_call_2_usd} diff ${r.computed_difference_usd}; cached tokens call2 ${r.cached_tokens_call_2}; computed_cost_usd ${record.computed_cost_usd}`,
  );
}

if (isMain(import.meta.url)) runCli(main);
