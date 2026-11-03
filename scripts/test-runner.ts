/**
 * Sprint 1 (EPIC-TEST-STD-0001) — Unified, lock-safe test orchestration &
 * benchmarking harness.
 *
 * Discovers all Playwright E2E specs under test/e2e, executes each suite
 * sequentially (single worker => serialized SQLite access on test_mgpl.db),
 * captures per-suite metrics (status, test/assertion counts, duration,
 * orchestrator-process memory delta), and prints a clean ANSI/Markdown summary
 * table before exiting 0 (all passed) or 1 (any failed).
 *
 * Anti-loop / fail-fast guardrail: each suite spawns exactly once. No retries,
 * no uncontrolled re-runs. Failures are captured to stderr and reported.
 *
 * Usage:
 *   npm run test:benchmark                       # run all discovered specs
 *   npm run test:benchmark -- auth-core oauth    # run only matching basenames
 *
 * Imports only Node builtins + child_process so the harness boots cleanly
 * under ts-node without pulling in Playwright's test runtime.
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const E2E_DIR = path.join(ROOT, "test", "e2e");
// Invoke Playwright's JS CLI entry through the current Node binary rather than
// the platform-specific .bin shim: spawn(SHELL_CMD) on Windows raises EINVAL
// without a shell, and this form is portable across Windows/macOS/Linux.
const PLAYWRIGHT_CLI = path.join(ROOT, "node_modules", "playwright", "cli.js");

/**
 * Bounded hard ceiling per suite. Each spawned run pays global-setup +
 * webServer boot latency (~8-17s) on top of the suite's own execution, and
 * long sequential suites (e.g. wishlist) legitimately exceed the 120s
 * per-test engine timeout. 300s keeps runs deterministic without masking
 * genuinely pathological suites.
 */
const SUITE_TIMEOUT_MS = 300 * 1000;

/** Human-friendly duration formatting. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Count assertions deterministically from the spec source rather than relying
 * on runtime report internals: Playwright's JSON report does not emit per-test
 * `steps` arrays, so we count `expect(...)` call sites (word-boundary, comment
 * noise tolerated) as the per-suite assertion metric.
 */
function countAssertionsInSource(source: string): number {
  const matches = source.match(/\bexpect\s*\(/g);
  return matches ? matches.length : 0;
}

/**
 * Walk the JSON report tree and flatten every executed test node.
 * Playwright's JSON reporter emits a recursive suite tree where each suite
 * node carries a `specs` array and each spec carries a `tests` array:
 *   suites -> [{ type: "project", specs: [{ title, tests: [{ results: [...] }] }] }]
 */
function collectTests(
  node: any,
  out: Array<{ title: string; file: string; status: string; duration: number; assertions: number }> = []
) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectTests(n, out);
    return out;
  }

  // Specs are the immediate parents of actual test cases.
  if (node.specs) {
    for (const spec of node.specs) {
      for (const t of spec?.tests ?? []) {
        const result = t?.results && t.results.length > 0 ? t.results[t.results.length - 1] : undefined;
        out.push({
          title: t?.title ?? "(untitled)",
          file: spec?.file ?? "",
          status: result?.status ?? "skipped",
          duration: result?.duration ?? 0,
          assertions: 0, // populated per-suite from source scan; avoids JSON-report variance
        });
      }
    }
  }

  // Recurse into nested suite nodes.
  for (const s of node.suites ?? []) collectTests(s, out);
  return out;
}

/**
 * Playwright's JSON report is written to stdout, but the stream may include a
 * BOM, ANSI escape sequences, or progress prefix before the JSON envelope.
 * Extract the outermost JSON object between the first `{` and the last `}`.
 */
function extractJsonEnvelope(raw: string): string {
  const cleaned = raw.replace(/^\uFEFF/, "").replace(/\x1b\[[0-9;]*m/g, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return cleaned;
  return cleaned.slice(firstBrace, lastBrace + 1);
}

interface SuiteResult {
  specFile: string;
  suiteName: string;
  status: "Passed" | "Failed";
  tests: number;
  assertions: number;
  durationMs: number;
  memoryDeltaMb: number;
  stderr: string;
}

async function runSuite(specFile: string, filters: string[]): Promise<SuiteResult | null> {
  const base = path.basename(specFile, ".spec.ts");

  // Optional basename filter (case-insensitive substring match).
  if (filters.length > 0 && !filters.some((f) => base.toLowerCase().includes(f.toLowerCase()))) {
    return null;
  }

  const beforeRss = process.memoryUsage().rss;

  let stdout = "";
  let stderr = "";
  const start = Date.now();

  // Playwright interprets positional args as glob/regex file filters, so the
  // absolute Windows path (backslashes + spaces) matches nothing. Always pass
  // a relative POSIX-style path that Playwright can resolve against testDir.
  const relativeSpec = path.relative(ROOT, specFile).split(path.sep).join("/");

  try {
    // Deterministic SQLite execution (EPIC-TEST-STD-0001): the shared
    // test_mgpl.db cannot tolerate concurrent writers, so every spawned
    // invocation MUST run with --workers=1 regardless of shell/CI overrides.
    const { stdout: out, stderr: err } = await execFileAsync(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", relativeSpec, "--reporter=json", "--workers=1"],
      {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: "test", CI: "0" },
        timeout: SUITE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }
    );
    stdout = out;
    stderr = err;
  } catch (err: any) {
    stdout = err?.stdout ?? "";
    stderr = err?.stderr ?? String(err?.message ?? err);
  }

  const durationMs = Date.now() - start;
  const memoryDeltaMb = (process.memoryUsage().rss - beforeRss) / (1024 * 1024);
  const assertionCount = countAssertionsInSource(fs.readFileSync(specFile, "utf8"));

  // Parse the JSON report. If the file is missing/corrupt, the suite failed.
  let parsed: any = null;
  try {
    parsed = JSON.parse(extractJsonEnvelope(stdout));
  } catch {
    parsed = null;
  }

  const tests = parsed ? collectTests(parsed) : [];
  const hasFailures =
    !parsed ||
    (parsed.stats?.unexpected ?? 0) > 0 ||
    (parsed.errors?.length ?? 0) > 0;
  const status: "Passed" | "Failed" = hasFailures ? "Failed" : "Passed";

  // Preserve a bounded tail of stderr/stdout so failures are diagnosable
  // without flooding the terminal.
  const tail = (text: string, max = 4000) => (text.length > max ? "...\n" + text.slice(-max) : text);
  const diagnostics =
    status === "Failed"
      ? `--- playlist: ${specFile} ---\n${tail(stdout + "\n" + stderr)}`
      : "";

  if (diagnostics) process.stderr.write(diagnostics + "\n");

  return {
    specFile: path.relative(ROOT, specFile),
    suiteName: base,
    status,
    tests: tests.length,
    assertions: assertionCount,
    durationMs,
    memoryDeltaMb: Number(memoryDeltaMb.toFixed(2)),
    stderr: diagnostics,
  };
}

// ---------------------------------------------------------------------------
// ANSI helpers & table rendering
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, width - visible.length));
}

function renderTable(rows: SuiteResult[]): string {
  const headers = ["Suite", "File", "Status", "Tests", "Assertions", "Duration", "Mem Delta (MB)"];
  const widths = [24, 48, 8, 7, 11, 12, 12];
  const line = (cells: string[]) => "| " + cells.map((c, i) => pad(c, widths[i])).join(" | ") + " |";

  const header = line(headers);
  const sep = "|-" + widths.map((w) => "-".repeat(w)).join("-|-") + "-|";
  const body = rows.map((r) =>
    line([
      r.suiteName,
      r.specFile,
      r.status === "Passed" ? `${C.green}Passed${C.reset}` : `${C.red}Failed${C.reset}`,
      String(r.tests),
      String(r.assertions),
      formatDuration(r.durationMs),
      `${r.memoryDeltaMb >= 0 ? "+" : ""}${r.memoryDeltaMb.toFixed(2)}`,
    ])
  );

  return [header, sep, ...body].join("\n");
}

async function main() {
  const filters = process.argv.slice(2);

  if (!fs.existsSync(E2E_DIR)) {
    process.stderr.write(`E2E directory not found: ${E2E_DIR}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(PLAYWRIGHT_CLI)) {
    process.stderr.write(`Playwright CLI not found: ${PLAYWRIGHT_CLI}\n`);
    process.exit(1);
  }

  const specFiles = fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => path.join(E2E_DIR, f))
    .sort();

  if (specFiles.length === 0) {
    process.stderr.write("No spec files discovered under test/e2e/*.spec.ts\n");
    process.exit(1);
  }

  process.stdout.write(
    `${C.bold}MGPL Test Benchmark (EPIC-TEST-STD-0001)${C.reset}\n` +
      `${C.dim}Workers: 1 (serialized SQLite, enforced via --workers=1) | Specs discovered: ${specFiles.length}${C.reset}\n\n`
  );

  const results: SuiteResult[] = [];
  for (const spec of specFiles) {
    const r = await runSuite(spec, filters);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    process.stderr.write("No suites matched the provided filters.\n");
    process.exit(1);
  }

  const totalTests = results.reduce((s, r) => s + r.tests, 0);
  const totalAssertions = results.reduce((s, r) => s + r.assertions, 0);
  const totalDurationMs = results.reduce((s, r) => s + r.durationMs, 0);
  const failed = results.filter((r) => r.status === "Failed");

  process.stdout.write(renderTable(results) + "\n\n");
  process.stdout.write(
    `${C.bold}Totals${C.reset}: ${results.length} suites | ` +
      `${totalTests} tests | ${totalAssertions} assertions | ` +
      `${formatDuration(totalDurationMs)} wall-clock\n`
  );

  if (failed.length > 0) {
    process.stdout.write(
      `${C.red}FAILED${C.reset}: ${failed.length} suite(s) failed - see diagnostics above. ` +
        `No retries will be spawned (anti-loop guardrail).\n`
    );
    process.exit(1);
  }

  process.stdout.write(`${C.green}ALL SUITES PASSED${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Fatal runner error: ${err?.stack || err}\n`);
  process.exit(1);
});