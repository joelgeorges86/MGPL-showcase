/**
 * Sprint 6.1 (PI-GTM-2026-001) — Unified post-deployment smoke test runner.
 *
 * Probes the live API surface (health, DPM health, mods, compare, state export,
 * retro) and prints PASS/FAIL per probe. Exits non-zero when any probe fails so
 * CI/CD gates can block promotion.
 *
 * Usage:
 *   npx ts-node scripts/smoke-test-post-deployment.ts [baseUrl]
 *   SMOKE_BASE_URL=http://localhost:4000 npx ts-node scripts/smoke-test-post-deployment.ts
 */
const BASE = process.env.SMOKE_BASE_URL || process.argv[2] || "http://localhost:4000";
const TIMEOUT_MS = 5000;

/** A parsed JSON response body (null when the body is not JSON). */
type ProbeBody = Record<string, unknown> | null;

interface ProbeResult {
  ok: boolean;
  detail: string;
}

async function statusProbe(pathname: string, expected: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${pathname}`, { signal: controller.signal });
    clearTimeout(timer);
    return res.status === expected
      ? { ok: true, detail: "PASS" }
      : { ok: false, detail: `HTTP ${res.status}, expected ${expected}` };
  } catch (err: unknown) {
    clearTimeout(timer);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function jsonProbe(
  pathname: string,
  predicate: (body: ProbeBody) => boolean,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${pathname}`, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.json().catch(() => null);
    const ok = res.status < 400 && predicate(body);
    return {
      ok,
      detail: ok ? "PASS" : `status=${res.status} body=${JSON.stringify(body).slice(0, 160)}`,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    return { ok: false, detail: `error=${err instanceof Error ? err.message : String(err)}` };
  }
}

const PROBES: Array<{ name: string; run: () => Promise<ProbeResult> }> = [
  {
    name: "GET /api/health",
    run: () => jsonProbe("/api/health", (b) => b?.status === "ok"),
  },
  {
    name: "GET /api/dpm/health (sanitized, no metadata leak)",
    run: () =>
      jsonProbe(
        "/api/dpm/health",
        (b) =>
          b?.status === "ok" &&
          typeof b?.timestamp === "string" &&
          b?.uptime === undefined &&
          b?.version === undefined &&
          b?.database === undefined,
      ),
  },
  {
    name: "GET /api/games (catalog)",
    run: () => jsonProbe("/api/games?active=true&owned=true", (b) => b?.success !== false),
  },
  {
    name: "GET /api/mods/trending (fallback + non-null counts)",
    run: () =>
      jsonProbe("/api/mods/trending?game=skyrimspecialedition", (b) => {
        const mods = b?.mods;
        if (!Array.isArray(mods)) return false;
        return mods.every(
          (m: { downloads?: unknown }) => typeof m.downloads === "number" && m.downloads >= 0,
        );
      }),
  },
  {
    name: "GET /api/mods/listings (read-time whitelist)",
    run: () => jsonProbe("/api/mods/listings", (b) => Array.isArray(b?.mods)),
  },
  {
    name: "GET /api/mods/aggregation/status",
    run: () => jsonProbe("/api/mods/aggregation/status", (b) => typeof b?.stalled === "boolean"),
  },
  {
    name: "GET /api/compare (matrix structure)",
    run: () => jsonProbe("/api/compare?ids=G00001,G00002", (b) => Array.isArray(b?.comparison)),
  },
  {
    // AI-084 (#163): the whole-database export is admin-only, so without a
    // session it must answer 401. A 200 here would mean the guard is missing.
    name: "GET /api/state/export (admin-only: 401 without a session)",
    run: () => statusProbe("/api/state/export", 401),
  },
  {
    name: "GET /api/retro/catalog",
    run: () => jsonProbe("/api/retro/catalog", (b) => Array.isArray(b?.catalog)),
  },
];

async function main(): Promise<void> {
  console.log(`[smoke-test-post-deployment] Target: ${BASE}`);
  let failures = 0;
  for (const probe of PROBES) {
    const result = await probe.run();
    console.log(
      `  [${result.ok ? "PASS" : "FAIL"}] ${probe.name}${result.detail !== "PASS" ? " — " + result.detail : ""}`,
    );
    if (!result.ok) failures += 1;
  }
  console.log(
    `\n[smoke-test-post-deployment] ${PROBES.length - failures}/${PROBES.length} probes passed.`,
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
