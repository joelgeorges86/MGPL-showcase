/**
 * Sprint 6 (PI-GTM-2026-002) — Unified Integration Health Monitor.
 *
 * Dependency-free, in-memory observability telemetry for every external
 * integration the platform talks to. Mirrors the DPM telemetry registry
 * (src/services/devicePlayability.ts) contract:
 *
 *   1. Privacy-minimized by construction: only static integration keys, status names,
 *      and integer counters are ever emitted. Request payloads, tokens,
 *      handles, and raw error text never enter this registry.
 *   2. Deterministic staleness: an integration is `stale` when its last
 *      successful contact is older than the completeness threshold. Staleness
 *      is derived at READ time (not via a live cron), so tests stay hermetic
 *      and DISABLE_CRON runs behave identically.
 *   3. Ephemeral runtime state: like the DPM counters and the immutable
 *      platform_audit_logs table, this registry is intentionally NOT
 *      registered in src/routes/state.ts. Transient operational counters are
 *      excluded from the portable state snapshot lifecycle (see note there).
 */

export type IntegrationKey =
  | 'steam'
  | 'psn'
  | 'xbox'
  | 'epic'
  | 'gog'
  | 'ubisoft'
  | 'protondb'
  | 'cheapshark'
  | 'itad'
  | 'gamerpower'
  | 'nexusmods'
  | 'hltb'
  | 'dpm';

export type IntegrationEvent =
  | 'success'
  | 'failure'
  | 'rate_limited'
  | 'domain_rejected'
  | 'token_expired'
  | 'stale';

export const INTEGRATION_KEYS: readonly IntegrationKey[] = [
  'steam',
  'psn',
  'xbox',
  'epic',
  'gog',
  'ubisoft',
  'protondb',
  'cheapshark',
  'itad',
  'gamerpower',
  'nexusmods',
  'hltb',
  'dpm',
] as const;

export const INTEGRATION_EVENTS: readonly IntegrationEvent[] = [
  'success',
  'failure',
  'rate_limited',
  'domain_rejected',
  'token_expired',
  'stale',
] as const;

type IntegrationKind = 'storefront' | 'pricing' | 'community' | 'playability' | 'identity';

interface IntegrationDefinition {
  key: IntegrationKey;
  label: string;
  kind: IntegrationKind;
}

/** Static registry of record — labels are fixed display names, never user data. */
export const INTEGRATION_DEFS: readonly IntegrationDefinition[] = [
  { key: 'steam', label: 'Steam', kind: 'storefront' },
  { key: 'psn', label: 'PlayStation Network', kind: 'storefront' },
  { key: 'xbox', label: 'Xbox Live', kind: 'storefront' },
  { key: 'epic', label: 'Epic Games', kind: 'storefront' },
  { key: 'gog', label: 'GOG Galaxy', kind: 'storefront' },
  { key: 'ubisoft', label: 'Ubisoft Connect', kind: 'storefront' },
  { key: 'protondb', label: 'ProtonDB', kind: 'playability' },
  { key: 'cheapshark', label: 'CheapShark', kind: 'pricing' },
  { key: 'itad', label: 'IsThereAnyDeal', kind: 'pricing' },
  { key: 'gamerpower', label: 'GamerPower', kind: 'pricing' },
  { key: 'nexusmods', label: 'Nexus Mods', kind: 'community' },
  { key: 'hltb', label: 'HowLongToBeat', kind: 'community' },
  { key: 'dpm', label: 'Device Playability', kind: 'playability' },
];

interface IntegrationState {
  requestsTotal: number;
  successTotal: number;
  failureTotal: number;
  rateLimitedTotal: number;
  domainRejectedTotal: number;
  tokenExpiredTotal: number;
  staleTotal: number;
  lastSeenAt: number | null;
  lastEventAt: number | null;
}

const state: Record<string, IntegrationState> = {};
for (const def of INTEGRATION_DEFS) {
  state[def.key] = {
    requestsTotal: 0,
    successTotal: 0,
    failureTotal: 0,
    rateLimitedTotal: 0,
    domainRejectedTotal: 0,
    tokenExpiredTotal: 0,
    staleTotal: 0,
    lastSeenAt: null,
    lastEventAt: null,
  };
}

let overallGauge = 1;

/** Default completeness threshold before an integration is reported stale (24h). */
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Completeness threshold (override via MGPL_INTEGRATION_STALE_MS for tests/ops). */
export function getCompletenessThresholdMs(): number {
  const raw = Number(process.env.MGPL_INTEGRATION_STALE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_STALE_THRESHOLD_MS;
}

/** Mark the whole integration surface healthy (1) or degraded (0). */
export function setOverallHealth(healthy: boolean): void {
  overallGauge = healthy ? 1 : 0;
}

/** Current overall health gauge (1 = healthy, 0 = degraded). */
export function getOverallHealth(): number {
  return overallGauge;
}

/**
 * Record an integration event. Unknown keys/events are silently ignored so
 * callers can never corrupt the registry. Only integer counters are mutated —
 * no PII, payloads, or raw errors are ever stored.
 */
export function recordIntegrationEvent(
  key: IntegrationKey | string,
  event: IntegrationEvent | string,
): boolean {
  const entry = state[key];
  if (!entry) return false;
  if (!(INTEGRATION_EVENTS as readonly string[]).includes(event)) return false;

  entry.lastEventAt = Date.now();
  switch (event) {
    case 'success':
      entry.successTotal += 1;
      entry.requestsTotal += 1;
      entry.lastSeenAt = Date.now();
      break;
    case 'failure':
      entry.failureTotal += 1;
      entry.requestsTotal += 1;
      break;
    case 'rate_limited':
      entry.rateLimitedTotal += 1;
      entry.failureTotal += 1;
      entry.requestsTotal += 1;
      break;
    case 'domain_rejected':
      entry.domainRejectedTotal += 1;
      entry.failureTotal += 1;
      entry.requestsTotal += 1;
      break;
    case 'token_expired':
      entry.tokenExpiredTotal += 1;
      entry.failureTotal += 1;
      entry.requestsTotal += 1;
      break;
    case 'stale':
      entry.staleTotal += 1;
      break;
  }
  return true;
}

export type IntegrationStatus = 'healthy' | 'degraded' | 'stale' | 'unknown';

/** Derive a deterministic status from the persisted counters + last-seen time. */
function deriveStatus(s: IntegrationState, now: number, thresholdMs: number): IntegrationStatus {
  if (s.lastSeenAt === null) return s.failureTotal > 0 ? 'degraded' : 'unknown';
  if (now - s.lastSeenAt > thresholdMs) return 'stale';
  if (s.failureTotal > 0) return 'degraded';
  return 'healthy';
}

export interface IntegrationHealthEntry {
  key: string;
  label: string;
  kind: string;
  status: IntegrationStatus;
  requestsTotal: number;
  failureRate: number;
  rateLimitedTotal: number;
  domainRejectedTotal: number;
  tokenExpiredTotal: number;
  staleTotal: number;
  lastSeenAt: string | null;
}

export interface IntegrationHealthSnapshot {
  status: 'ok';
  overall: 'healthy' | 'degraded';
  generatedAt: string;
  integrations: IntegrationHealthEntry[];
}

/**
 * Snapshot of the current integration health. Safe by construction: only
 * static keys, status names, ISO timestamps, and integer counters are emitted.
 */
export function getIntegrationHealth(): IntegrationHealthSnapshot {
  const thresholdMs = getCompletenessThresholdMs();
  const now = Date.now();
  const integrations: IntegrationHealthEntry[] = INTEGRATION_DEFS.map((def) => {
    const s = state[def.key];
    return {
      key: def.key,
      label: def.label,
      kind: def.kind,
      status: deriveStatus(s, now, thresholdMs),
      requestsTotal: s.requestsTotal,
      failureRate:
        s.requestsTotal > 0 ? Math.round((s.failureTotal / s.requestsTotal) * 1000) / 1000 : 0,
      rateLimitedTotal: s.rateLimitedTotal,
      domainRejectedTotal: s.domainRejectedTotal,
      tokenExpiredTotal: s.tokenExpiredTotal,
      staleTotal: s.staleTotal,
      lastSeenAt: s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : null,
    };
  });
  const overall: IntegrationHealthSnapshot['overall'] =
    integrations.every((i) => i.status === 'healthy' || i.status === 'unknown')
      ? 'healthy'
      : 'degraded';
  overallGauge = overall === 'healthy' ? 1 : 0;
  return { status: 'ok', overall, generatedAt: new Date().toISOString(), integrations };
}

/**
 * Render the integration telemetry in Prometheus text/plain exposition format.
 * Only static metric names, static label values, and integer values are
 * emitted — never request data, tokens, or raw error text.
 */
export function renderIntegrationMetricsText(): string {
  const lines: string[] = [];
  const thresholdMs = getCompletenessThresholdMs();
  const now = Date.now();

  lines.push(
    '# HELP integration_health_overall 1 when every integration is healthy or unknown, 0 when degraded.',
  );
  lines.push('# TYPE integration_health_overall gauge');
  lines.push(`integration_health_overall ${overallGauge}`);

  for (const def of INTEGRATION_DEFS) {
    const s = state[def.key];
    const status = deriveStatus(s, now, thresholdMs);
    const healthyNum = status === 'healthy' ? 1 : 0;

    lines.push('# HELP integration_health_status 1 when the integration is healthy, 0 otherwise.');
    lines.push('# TYPE integration_health_status gauge');
    lines.push(`integration_health_status{integration="${def.key}"} ${healthyNum}`);

    lines.push('# HELP integration_requests_total Total integration attempts (successes + failures).');
    lines.push('# TYPE integration_requests_total counter');
    lines.push(`integration_requests_total{integration="${def.key}"} ${s.requestsTotal}`);

    lines.push('# HELP integration_success_total Successful integration contacts.');
    lines.push('# TYPE integration_success_total counter');
    lines.push(`integration_success_total{integration="${def.key}"} ${s.successTotal}`);

    lines.push('# HELP integration_failures_total Failed integration attempts.');
    lines.push('# TYPE integration_failures_total counter');
    lines.push(`integration_failures_total{integration="${def.key}"} ${s.failureTotal}`);

    lines.push('# HELP integration_rate_limited_total Requests rejected by the upstream rate limit.');
    lines.push('# TYPE integration_rate_limited_total counter');
    lines.push(`integration_rate_limited_total{integration="${def.key}"} ${s.rateLimitedTotal}`);

    lines.push('# HELP integration_domain_rejected_total Requests rejected by the domain whitelist.');
    lines.push('# TYPE integration_domain_rejected_total counter');
    lines.push(`integration_domain_rejected_total{integration="${def.key}"} ${s.domainRejectedTotal}`);

    lines.push('# HELP integration_token_expired_total Requests rejected by an expired upstream token.');
    lines.push('# TYPE integration_token_expired_total counter');
    lines.push(`integration_token_expired_total{integration="${def.key}"} ${s.tokenExpiredTotal}`);

    lines.push('# HELP integration_stale_total Times the integration was observed as stale.');
    lines.push('# TYPE integration_stale_total counter');
    lines.push(`integration_stale_total{integration="${def.key}"} ${s.staleTotal}`);
  }

  return `${lines.join('\n')}\n`;
}

