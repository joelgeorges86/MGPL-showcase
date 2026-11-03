/**
 * Sprint 6.1 (PI-GTM-2026-001) — Pre-deployment rollout snapshot.
 *
 * Calls /api/state/export for the authoritative JSON snapshot and writes a
 * versioned companion .meta.json capturing the Mods table, compare-matrix
 * config tables, palette tokens (from public/style.css), and feature flags.
 * Intended to be run immediately before promoting a release candidate so a
 * broken rollout can be rolled back to the exact pre-deployment state.
 *
 * Usage:
 *   npx ts-node scripts/pre-deploy-snapshot.ts [baseUrl]
 *   (with MGPL_SNAPSHOT_TOKEN set to an admin session token: the export is admin-only)
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const BASE = process.env.SNAPSHOT_BASE_URL || process.argv[2] || "http://localhost:4000";
const OUT_DIR = path.resolve(process.cwd(), "backups");
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), "mpgl_app.db");
const TIMEOUT_MS = 20000;

function readMeta(): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    featureFlags: {
      NODE_ENV: process.env.NODE_ENV ?? null,
      DISABLE_CRON: process.env.DISABLE_CRON ?? null,
      RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? null,
      DB_PATH: process.env.DB_PATH ?? null,
    },
  };

  try {
    const db = new Database(DB_PATH, { readonly: true });
    const count = (t: string): number => {
      try {
        return (db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c;
      } catch {
        return 0;
      }
    };
    meta.mods = {
      table: "Mods",
      count: count("Mods"),
      columns: (db.prepare('PRAGMA table_info("Mods")').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    };
    meta.compareMatrix = {
      tables: ["InstalledMods", "GameDeviceProfiles"],
      counts: {
        InstalledMods: count("InstalledMods"),
        GameDeviceProfiles: count("GameDeviceProfiles"),
      },
    };
    db.close();
  } catch (err: unknown) {
    meta.dbError = (err instanceof Error && err.message) || "Failed to introspect DB";
  }

  // Palette tokens from the live stylesheet (semantic CSS custom properties).
  try {
    const css = fs.readFileSync(path.resolve(process.cwd(), "public", "style.css"), "utf8");
    const tokens: Record<string, string> = {};
    const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      if (!(m[1] in tokens)) tokens[m[1]] = m[2].trim();
    }
    meta.paletteTokens = { count: Object.keys(tokens).length, tokens };
  } catch (err: unknown) {
    meta.paletteError = (err instanceof Error && err.message) || "Failed to read style.css";
  }

  return meta;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(OUT_DIR, `predeploy-snapshot-${stamp}.json`);
  const metaPath = path.join(OUT_DIR, `predeploy-meta-${stamp}.json`);

  console.log(`[pre-deploy-snapshot] Fetching /api/state/export from ${BASE}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // AI-084 (#163): /api/state/export is admin-only. The operator supplies an
  // admin session token in MGPL_SNAPSHOT_TOKEN; this script never prints it.
  const token = process.env.MGPL_SNAPSHOT_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${BASE}/api/state/export`, { signal: controller.signal, headers });
  clearTimeout(timer);
  if (!res.ok) {
    console.error(`[pre-deploy-snapshot] FAILED: /api/state/export returned ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      console.error(
        "[pre-deploy-snapshot] The export is admin-only: set MGPL_SNAPSHOT_TOKEN to an admin session token.",
      );
    }
    process.exit(1);
  }
  const body = await res.json();

  const snapshot = body && typeof body === "object" ? body : { state: body };
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(metaPath, JSON.stringify(readMeta(), null, 2), "utf8");

  console.log(`[pre-deploy-snapshot] Snapshot written: ${snapshotPath}`);
  console.log(`[pre-deploy-snapshot] Meta written:      ${metaPath}`);
  console.log("[pre-deploy-snapshot] Snapshot complete.");
}

main();
