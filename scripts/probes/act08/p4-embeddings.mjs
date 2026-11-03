// ACT-08 P-4: embeddings over the game catalogue, cost capture only.
//
// Reproduces the 2026-09-17 test (20 fixtures, 5 queries, text-embedding-005,
// top-3 by cosine) to record tokens and computed cost, which that run did not.
// It is not a redesign. Faithfulness is checked, not assumed:
//   1. before sending anything, every fixture text must be present in the
//      2026-09-17 reference vectors (blob 8108e75b...), which must be readable
//      from this clone's object store;
//   2. after embedding the fixtures, each new vector must match its stored
//      vector (cosine >= FAITHFUL_COSINE) before any query is sent.
// Either failure ends the run with a finding (exit 3), not an adjacent test.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  HERE,
  ROOT,
  baseRecord,
  billableCharactersFrom,
  computeEmbeddingCost,
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
} from "./lib.mjs";

export const PROBE = "p4-embeddings";
export const FIXTURE_FILE = path.join(HERE, "p4-fixtures-2026-09-17.json");
export const FAITHFUL_COSINE = 0.999;

export function cosine(a, b) {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

export function readReference(blob) {
  try {
    const raw = execFileSync("git", ["cat-file", "blob", blob], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    return { __error: String(e?.message ?? e).split("\n")[0] };
  }
}

/** Pre-spend check. Returns a list of findings; empty means the reference supports a faithful rerun. */
export function checkReference(fixture, reference) {
  if (reference.__error)
    return [`reference blob ${fixture.reference_blob} not readable here: ${reference.__error}`];
  const findings = [];
  const keys = Object.keys(reference);
  if (keys.length !== fixture.fixtures.length) {
    findings.push(
      `reference has ${keys.length} vectors, fixture file has ${fixture.fixtures.length} texts`,
    );
  }
  for (const text of fixture.fixtures) {
    if (!(text in reference)) findings.push(`fixture text not in reference: ${text}`);
    else if (reference[text].length !== fixture.dimensions) {
      findings.push(
        `reference vector for "${text.split(":")[0]}" has ${reference[text].length} dims, expected ${fixture.dimensions}`,
      );
    }
  }
  return findings;
}

function tokenCountFrom(exchange) {
  try {
    const body = JSON.parse(exchange.response_body);
    return body?.predictions?.[0]?.embeddings?.statistics?.token_count ?? null;
  } catch {
    return null;
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  const fixture = JSON.parse(await readFile(FIXTURE_FILE, "utf8"));
  const model = fixture.model;
  const texts = [...fixture.fixtures, ...fixture.queries.map((q) => q.query)];
  const endpoint = expectedEndpoint(model, "predict");
  const reference = readReference(fixture.reference_blob);
  const referenceFindings = checkReference(fixture, reference);

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      printDryRun([
        `probe: ${PROBE}`,
        `model: ${model}`,
        `endpoint (expected; the actual URL is recorded on --run): ${endpoint}`,
        `requests: ${texts.length} (one per text: ${fixture.fixtures.length} fixtures, then ${fixture.queries.length} queries)`,
        ...texts.map((t, i) => `  ${i + 1}. ${JSON.stringify({ model, contents: t })}`),
        `input characters: ${texts.reduce((n, t) => n + t.length, 0)}; estimated tokens (heuristic, chars/4): ${texts.reduce((n, t) => n + estimateTokens(t), 0)}`,
        referenceFindings.length
          ? `reference check: FAILS, so --run would stop before sending: ${referenceFindings.join("; ")}`
          : `reference check: passes (${fixture.fixtures.length} texts found in blob ${fixture.reference_blob})`,
        `faithfulness threshold after fixtures: cosine >= ${FAITHFUL_COSINE} against every stored vector`,
      ]);
    } finally {
      restore();
    }
    return 0;
  }

  const rates = await loadRates();
  const record = await baseRecord(PROBE, argv);
  Object.assign(record, {
    model,
    endpoint_expected: endpoint,
    rate: rateRef(rates, model),
    fixture_file: path.relative(ROOT, FIXTURE_FILE).split(path.sep).join("/"),
    fixture_provenance: fixture._provenance,
    faithful_cosine_threshold: FAITHFUL_COSINE,
    reference_check: referenceFindings,
  });
  if (referenceFindings.length) {
    record.finding = "Cannot reproduce the 2026-09-17 test faithfully; nothing was sent.";
    record.computed_cost_usd = 0;
    record.exit_status = 3;
    return finish(
      PROBE,
      record,
      `${PROBE}: FINDING, reference check failed, nothing sent; computed_cost_usd 0`,
    );
  }

  const capture = createCapture({ maxRequests: texts.length });
  record.exchanges = capture.exchanges;
  const embedded = [];
  let failed = false;
  let finding = null;
  try {
    const ai = await createClient(capture);
    const embedOne = async (text) => {
      const res = await ai.models.embedContent({ model, contents: text });
      const values = res.embeddings?.[0]?.values;
      if (!values) throw new Error("No embedding values in response");
      const exchange = capture.exchanges[capture.exchanges.length - 1];
      embedded.push({
        text,
        characters: text.length,
        billable_characters: billableCharactersFrom([exchange.response_body]),
        tokens: tokenCountFrom(exchange),
        dims: values.length,
      });
      return values;
    };
    const fixtureVectors = [];
    for (const text of fixture.fixtures) fixtureVectors.push(await embedOne(text));
    record.faithfulness = fixture.fixtures.map((text, i) => ({
      fixture: text.split(":")[0],
      cosine_to_2026_09_17: round(cosine(fixtureVectors[i], reference[text])),
    }));
    const minCos = Math.min(...record.faithfulness.map((f) => f.cosine_to_2026_09_17));
    record.faithfulness_min_cosine = minCos;
    if (minCos < FAITHFUL_COSINE) {
      finding = `Fixture vectors differ from 2026-09-17 (min cosine ${minCos}). Configuration or model version is not the same, so queries were not sent.`;
    } else {
      record.queries = [];
      for (const q of fixture.queries) {
        const qv = await embedOne(q.query);
        const ranked = fixture.fixtures
          .map((text, i) => ({
            title: text.split(":")[0],
            score: round(cosine(qv, fixtureVectors[i])),
          }))
          .sort((a, b) => b.score - a.score);
        record.queries.push({
          query: q.query,
          recorded_top3_2026_09_17: q.recorded_top3,
          top3_now: ranked.slice(0, 3),
          ranking: ranked,
        });
      }
    }
  } catch (e) {
    record.error = { name: e?.name, status: e?.status ?? null, message: String(e?.message ?? e) };
    failed = true;
  }
  record.embedded = embedded;
  const characters = embedded.reduce((n, e) => n + e.characters, 0);
  const tokens = embedded.every((e) => e.tokens != null)
    ? embedded.reduce((n, e) => n + e.tokens, 0)
    : null;
  // Priced on what the API reports as billable, summed over every response
  // that carried an embedding (#114). String length stays as a secondary field.
  const billableCharacters = embedded.every((e) => e.billable_characters != null)
    ? embedded.reduce((n, e) => n + e.billable_characters, 0)
    : null;
  record.cost = computeEmbeddingCost(rates, model, { billableCharacters, characters, tokens });
  record.computed_cost_usd = record.cost.computed_cost_usd;
  if (finding) record.finding = finding;
  record.exit_status = failed ? 1 : finding ? 3 : 0;
  const status = failed ? "FAILED" : finding ? "FINDING" : "done";
  return finish(
    PROBE,
    record,
    `${PROBE}: ${status}; requests ${capture.attempts}; min cosine to 09-17 ${record.faithfulness_min_cosine ?? "n/a"}; computed_cost_usd ${record.computed_cost_usd ?? "unpriceable"}`,
  );
}

if (isMain(import.meta.url)) runCli(main);
