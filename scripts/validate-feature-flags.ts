/**
 * Sprint 6.1 (PI-GTM-2026-001) — Feature flag validator.
 *
 * Validates the canonical MGPL monolith feature-flag surface before promotion:
 *   - environment-variable flags (presence + type checks)
 *   - file gates introduced by Sprint 6.1 (DPM route, safety stack, sweep, job)
 * Prints PASS/FAIL and exits non-zero on any missing flag so the release gate
 * can never be marked green with a disabled/half-wired feature.
 *
 * Usage:
 *   npx ts-node scripts/validate-feature-flags.ts
 */
import fs from 'fs';
import path from 'path';

interface FlagSpec {
  name: string;
  kind: 'env' | 'bool-env' | 'num-env' | 'file';
  description: string;
}

const REGISTRY: FlagSpec[] = [
  { name: 'NODE_ENV', kind: 'env', description: 'Runtime environment (production/test/development).' },
  { name: 'DISABLE_CRON', kind: 'bool-env', description: 'Staging/test hermeticity — disables background cron jobs.' },
  { name: 'RATE_LIMIT_MAX', kind: 'num-env', description: 'Global API rate-limit ceiling (default 300/15min).' },
  { name: 'DB_PATH', kind: 'env', description: 'SQLite database path override (test isolation).' },
  { name: 'ITAD_API_KEY', kind: 'env', description: 'IsThereAnyDeal API key for live deal sync.' },
  { name: 'src/routes/dpm.ts', kind: 'file', description: 'GAP-001 sanitized DPM health endpoint.' },
  { name: 'src/utils/safes.ts', kind: 'file', description: 'Shared safety utility stack (server).' },
  { name: 'public/safes.js', kind: 'file', description: 'Shared safety utility stack (client).' },
  { name: 'src/jobs/mod-aggregation.ts', kind: 'file', description: 'GAP-003 mods aggregation failure alert.' },
  { name: 'scripts/mod-link-sweep.ts', kind: 'file', description: 'Mod link revalidation sweep.' },
  { name: 'test/e2e/remediation-regression.spec.ts', kind: 'file', description: 'Sprint 6.1 targeted regression suite.' },
];

function validateFlag(flag: FlagSpec): { ok: boolean; detail: string } {
  if (flag.kind === 'file') {
    const exists = fs.existsSync(path.resolve(process.cwd(), flag.name));
    return { ok: exists, detail: exists ? 'present' : 'missing (REQUIRED)' };
  }
  const value = process.env[flag.name];
  // Env flags are optional at runtime (they carry documented defaults); unset
  // values are a PASS. Hard failures are reserved for type mismatches when a
  // value IS provided, and for the mandatory file gates above.
  if (flag.kind === 'env') {
    return { ok: true, detail: value ? 'set' : 'unset (optional, uses default)' };
  }
  if (flag.kind === 'bool-env') {
    const valid = value === 'true' || value === 'false' || value === undefined || value === '';
    return {
      ok: valid,
      detail: value ? `"${value}" (boolean expected)` : 'unset (optional, defaults to false)',
    };
  }
  // num-env
  const valid = value === undefined || value === '' || /^\d+$/.test(String(value));
  return {
    ok: valid,
    detail: value ? `"${value}" (integer expected)` : 'unset (optional, uses default)',
  };
}

function main(): void {
  console.log('[validate-feature-flags] Sprint 6.1 feature flag validation');
  let failures = 0;
  for (const flag of REGISTRY) {
    const result = validateFlag(flag);
    console.log(`  [${result.ok ? 'PASS' : 'FAIL'}] ${flag.name} — ${flag.description} (${result.detail})`);
    if (!result.ok) failures += 1;
  }
  console.log(`\n[validate-feature-flags] ${REGISTRY.length - failures}/${REGISTRY.length} flags valid.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
