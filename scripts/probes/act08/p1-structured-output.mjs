// ACT-08 P-1: structured output under a repository schema.
//
// The schema is derived at run time from the AppGames_Staging DDL in
// src/db.ts, the sole schema authority, and the response is validated
// against the same parsed columns. Nothing about the shape is hand-written.
// AppGames_Staging is the table generated catalogue enrichment is staged
// into (G-2), so it is the schema such output would actually have to meet.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
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
  sumComputedCosts,
} from "./lib.mjs";

export const PROBE = "p1-structured-output";
export const MODEL = "gemini-2.5-flash";
export const TABLE = "AppGames_Staging";

// Columns the staging pipeline fills itself, never the model. Everything
// else in the table is asked of the model.
export const PIPELINE_COLUMNS = [
  "staging_id",
  "run_id",
  "model_id",
  "source",
  "fetched_at",
  "game_id",
];

// Inputs are taken from existing repository artifacts, not invented:
// Hollow Knight from RETEST P1 and the P-4 fixture set; the other two are
// the G-2 fixture's Tranche A (verified nonexistent) and Tranche B titles.
export const CASES = [
  {
    title: "Hollow Knight",
    source: "DOCS/research/ACT-08-RETEST-EVIDENCE.md P1; P-4 fixture set",
    expect: "known",
  },
  {
    title: "Quarnix Vortex Protocol IX",
    source: "scripts/probes/g2-fixture.json Tranche A",
    expect: "nonexistent",
  },
  {
    title: "Barkley, Shut Up and Jam: Gaiden",
    source: "scripts/probes/g2-fixture.json Tranche B",
    expect: "obscure",
  },
];

const SQLITE_TO_SCHEMA = { TEXT: "STRING", REAL: "NUMBER", INTEGER: "INTEGER", DATETIME: "STRING" };

/** Extracts and parses the column list of `table` from db.ts source text. */
export function parseTableColumns(source, table) {
  const start = source.search(new RegExp(`CREATE TABLE IF NOT EXISTS "?${table}"?\\s*\\(`));
  if (start < 0) throw new Error(`CREATE TABLE ${table} not found in src/db.ts`);
  const open = source.indexOf("(", start);
  let depth = 0;
  let end = open;
  for (; end < source.length; end++) {
    if (source[end] === "(") depth++;
    if (source[end] === ")" && --depth === 0) break;
  }
  const body = source.slice(open + 1, end);
  const ddl = source.slice(start, end + 1);
  const columns = [];
  const unmapped = [];
  for (const raw of splitTopLevel(body)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK|CONSTRAINT)\b/i.test(line)) {
      unmapped.push(line);
      continue;
    }
    const m = line.match(/^(?:"([^"]+)"|(\w+))\s+([A-Z]+)\b(.*)$/s);
    if (!m) {
      unmapped.push(line);
      continue;
    }
    const [, quoted, bare, sqlType, rest] = m;
    const name = quoted ?? bare;
    const col = {
      name,
      sqlType,
      notNull: /\bNOT NULL\b/i.test(rest),
      primaryKey: /\bPRIMARY KEY\b/i.test(rest),
    };
    const check = rest.match(/CHECK\s*\((.*)\)\s*$/is);
    if (check) {
      const range = check[1].match(
        new RegExp(`^${name}\\s*>=\\s*(-?[\\d.]+)\\s+AND\\s+${name}\\s*<=\\s*(-?[\\d.]+)$`, "i"),
      );
      if (range) col.range = { minimum: Number(range[1]), maximum: Number(range[2]) };
      else col.unmappedCheck = check[1];
    }
    columns.push(col);
  }
  return { ddl, columns, unmapped };
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body.replace(/--[^\n]*/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export const MAPPING_RULES = [
  "SQLite TEXT and DATETIME -> STRING; REAL -> NUMBER; INTEGER -> INTEGER",
  "NOT NULL -> non-nullable; otherwise nullable: true",
  "every model column is listed in required, so a nullable field must be present as an explicit null rather than omitted",
  "CHECK (col >= a AND col <= b) -> minimum a / maximum b; any other CHECK is recorded as unmapped, not approximated",
  `pipeline-filled columns excluded: ${PIPELINE_COLUMNS.join(", ")}`,
];

export function buildResponseSchema(columns) {
  const modelColumns = columns.filter((c) => !PIPELINE_COLUMNS.includes(c.name));
  const properties = {};
  for (const c of modelColumns) {
    const type = SQLITE_TO_SCHEMA[c.sqlType];
    if (!type) throw new Error(`No schema mapping for SQLite type ${c.sqlType} (${c.name})`);
    const prop = { type };
    if (!c.notNull) prop.nullable = true;
    if (c.range) Object.assign(prop, c.range);
    properties[c.name] = prop;
  }
  return {
    modelColumns,
    schema: { type: "OBJECT", properties, required: modelColumns.map((c) => c.name) },
  };
}

/** Validates a parsed object against the same parsed columns. No coercion. */
export function validate(value, modelColumns) {
  const violations = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["response is not a JSON object"];
  }
  const names = new Set(modelColumns.map((c) => c.name));
  for (const key of Object.keys(value))
    if (!names.has(key)) violations.push(`unexpected key: ${key}`);
  for (const c of modelColumns) {
    if (!(c.name in value)) {
      violations.push(`missing key: ${c.name}`);
      continue;
    }
    const v = value[c.name];
    if (v === null) {
      if (c.notNull) violations.push(`${c.name} is NOT NULL but null`);
      continue;
    }
    const type = SQLITE_TO_SCHEMA[c.sqlType];
    if (type === "STRING" && typeof v !== "string") violations.push(`${c.name} not a string`);
    if (type === "NUMBER" && typeof v !== "number") violations.push(`${c.name} not a number`);
    if (type === "INTEGER" && !Number.isInteger(v)) violations.push(`${c.name} not an integer`);
    if (c.range && typeof v === "number" && (v < c.range.minimum || v > c.range.maximum)) {
      violations.push(`${c.name}=${v} outside CHECK range ${c.range.minimum}..${c.range.maximum}`);
    }
  }
  return violations;
}

export function promptFor(title) {
  return `Enrich the catalogue entry for the video game titled "${title}". Return only facts you can verify. Use null for any field you cannot verify. If you do not recognise the game, say so through a low confidence_score and null fields rather than guessing.`;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const dbSource = await readFile(path.join(ROOT, "src", "db.ts"), "utf8");
  const parsed = parseTableColumns(dbSource, TABLE);
  const { modelColumns, schema } = buildResponseSchema(parsed.columns);
  const config = {
    thinkingConfig: { thinkingBudget: 0 },
    responseMimeType: "application/json",
    responseSchema: schema,
  };
  const endpoint = expectedEndpoint(MODEL, "generateContent");

  if (args.mode === "dry-run") {
    const restore = forbidNetwork();
    try {
      const requests = CASES.map((c) => ({ model: MODEL, contents: promptFor(c.title), config }));
      const est = requests.reduce(
        (n, r) => n + estimateTokens(r.contents) + estimateTokens(JSON.stringify(schema)),
        0,
      );
      printDryRun([
        `probe: ${PROBE}`,
        `model: ${MODEL}`,
        `endpoint (expected; the actual URL is recorded on --run): ${endpoint}`,
        `schema source: src/db.ts ${TABLE}; mapping rules:`,
        ...MAPPING_RULES.map((r) => `  - ${r}`),
        `unmapped table constraints (not enforced by the schema): ${JSON.stringify(parsed.unmapped)}`,
        `requests: ${requests.length}`,
        ...requests.map((r, i) => `request ${i + 1}: ${JSON.stringify(r)}`),
        `estimated input tokens (heuristic, chars/4): ${est}`,
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
    schema_source: {
      file: "src/db.ts",
      table: TABLE,
      ddl_verbatim: parsed.ddl,
      mapping_rules: MAPPING_RULES,
    },
    unmapped_constraints: parsed.unmapped,
    response_schema: schema,
    config,
    cases: [],
  });
  const capture = createCapture({ maxRequests: CASES.length });
  record.exchanges = capture.exchanges;
  let failed = false;
  try {
    const ai = await createClient(capture);
    for (const c of CASES) {
      const entry = {
        title: c.title,
        input_source: c.source,
        expectation: c.expect,
        prompt: promptFor(c.title),
      };
      record.cases.push(entry);
      const t0 = Date.now();
      try {
        const res = await ai.models.generateContent({
          model: MODEL,
          contents: entry.prompt,
          config,
        });
        entry.latency_ms = Date.now() - t0;
        entry.usage = res.usageMetadata ?? null;
        entry.cost = computeGenerateCost(rates, MODEL, res.usageMetadata);
        entry.text = res.text ?? null;
        let value;
        try {
          value = JSON.parse(entry.text);
          entry.parse_ok = true;
        } catch (e) {
          entry.parse_ok = false;
          entry.parse_error = String(e.message);
        }
        entry.violations = entry.parse_ok
          ? validate(value, modelColumns)
          : ["response did not parse as JSON"];
        entry.schema_honoured = entry.violations.length === 0;
        if (entry.parse_ok && c.expect === "nonexistent") {
          entry.non_null_fields_for_nonexistent_title = Object.entries(value)
            .filter(([k, v]) => k !== "title" && k !== "confidence_score" && v !== null)
            .map(([k]) => k);
        }
      } catch (e) {
        entry.latency_ms = Date.now() - t0;
        entry.error = {
          name: e?.name,
          status: e?.status ?? null,
          message: String(e?.message ?? e),
        };
        failed = true;
      }
    }
  } catch (e) {
    record.error = { name: e?.name, message: String(e?.message ?? e) };
    failed = true;
  }
  const totals = sumComputedCosts(record.cases.map((c) => c.cost));
  const total = totals.computed_cost_usd ?? "unpriceable";
  record.computed_cost_usd = totals.computed_cost_usd;
  record.computed_cost_totals = totals;
  record.result = {
    honoured: record.cases.filter((c) => c.schema_honoured).length,
    of: CASES.length,
    note: "schema_honoured is validation against the db.ts-derived columns, not a judgement of factual accuracy",
  };
  record.exit_status = failed ? 1 : 0;
  return finish(
    PROBE,
    record,
    `${PROBE}: ${failed ? "FAILED" : "done"}; schema honoured ${record.result.honoured}/${CASES.length}; requests ${capture.attempts}; computed_cost_usd ${total}`,
  );
}

if (isMain(import.meta.url)) runCli(main);
