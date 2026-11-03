import { Database as DatabaseType } from 'better-sqlite3';

/**
 * Sprint 3 (EPIC-DEV-001): Deterministic cross-library performance seeding.
 *
 * Seeds the `game_performance_profiles` table with an FPS value for every
 * (game x GPU tier x CPU tier) combination so the Performance Matrix,
 * Two-Device Compare, and Upgrade Advisor routes can compute projections
 * without any network or randomness.
 *
 * The tier vocabulary is exactly the task contract: Entry | Mid | High |
 * Flagship. Catalog tiers use a slightly different set (GPU:
 * integrated/entry/mid/high/enthusiast; CPU: entry/mid/high/flagship), so
 * `normalizeGpuTier` / `normalizeCpuTier` fold those into the four-tier
 * contract. Free-text My Device models and saved PC builds are classified
 * with model/vram/core keyword + fallback rules.
 *
 * The FPS model is intentionally simple but deterministic:
 *   - A game is assigned a `DemandClass` from its minimum RAM/VRAM/SSD needs.
 *   - A per-(demand, gpuTier) 1080p baseline is multiplied by a CPU modifier,
 *     then scaled by fixed per-resolution multipliers (4K Ultra, 1440p High,
 *     1080p Medium, 720p Low). This shape guarantees Entry/Entry keeps light
 *     indies at 60+ while dropping demanding AAA titles well under 60 —
 *     the exact spread the color badges and <70% advisor gate depend on.
 */

export const PERFORMANCE_TIERS = ['Entry', 'Mid', 'High', 'Flagship'] as const;
export type PerformanceTier = (typeof PERFORMANCE_TIERS)[number];

export type DemandClass =
  | 'Light'
  | 'Moderate'
  | 'Demanding'
  | 'Very Demanding';

const GPU_BASE_FPS: Record<DemandClass, Record<PerformanceTier, number>> = {
  Light: { Entry: 120, Mid: 144, High: 165, Flagship: 200 },
  Moderate: { Entry: 60, Mid: 90, High: 130, Flagship: 165 },
  Demanding: { Entry: 30, Mid: 60, High: 95, Flagship: 130 },
  'Very Demanding': { Entry: 18, Mid: 42, High: 70, Flagship: 100 },
};

const CPU_MODIFIER: Record<PerformanceTier, number> = {
  Entry: 0.8,
  Mid: 0.95,
  High: 1.0,
  Flagship: 1.05,
};

/**
 * Normalize a catalog GPU tier (integrated/entry/mid/high/enthusiast) into the
 * performance matrix's four-tier vocabulary.
 */
export function normalizeGpuTier(tier: string | null | undefined): PerformanceTier {
  const t = (tier || '').trim().toLowerCase();
  if (t === 'enthusiast' || t === 'flagship') return 'Flagship';
  if (t === 'high') return 'High';
  if (t === 'mid') return 'Mid';
  if (t === 'integrated' || t === 'entry') return 'Entry';
  return 'Entry';
}

/**
 * Normalize a catalog CPU tier (entry/mid/high/flagship) into the matrix's
 * four-tier vocabulary. Unknown tiers default to Entry (never guessed upward).
 */
export function normalizeCpuTier(tier: string | null | undefined): PerformanceTier {
  const t = (tier || '').trim().toLowerCase();
  if (t === 'flagship') return 'Flagship';
  if (t === 'high') return 'High';
  if (t === 'mid') return 'Mid';
  return 'Entry';
}

/**
 * Classify a free-text GPU model (My Devices) into a performance tier using
 * explicit model keywords first, then a VRAM rule, then integrated fallback.
 * Unknown properties are stored as Entry — never guessed upward — matching the
 * VCM "unknown must trigger clarification" doctrine.
 */
export function classifyGpuModel(
  model: string | null | undefined,
  vramGb: number | null | undefined,
  gpuType: string | null | undefined,
): PerformanceTier {
  const m = (model || '').toLowerCase();
  const type = (gpuType || '').toLowerCase();
  const vram = Number(vramGb) || 0;

  if (
    type === 'integrated' ||
    m.includes('integrated') ||
    m.includes('igpu') ||
    /intel arc/i.test(m) ||
    /680m|780m/i.test(m)
  ) {
    if (vram >= 16) return 'High';
    if (vram >= 8) return 'Mid';
    return 'Entry';
  }

  if (/rtx 4090|rtx 4080|rx 7900 xtx/i.test(m)) return 'Flagship';
  if (/rtx 4070|rtx 3080|rx 7800|rx 7700|rtx 3070/i.test(m)) return 'High';
  if (/rtx 4060|rtx 3060|rtx 3050|rx 7600|rx 6600|rtx 3060 ti|rtx 4060 ti/i.test(m)) return 'Mid';

  if (vram >= 16) return 'Flagship';
  if (vram >= 12) return 'High';
  if (vram >= 8) return 'Mid';
  return 'Entry';
}

/**
 * Classify a free-text CPU model (My Devices / saved builds) into a performance
 * tier using family keywords first, then core count. Defaults to Entry.
 */
export function classifyCpuModel(
  model: string | null | undefined,
  cores: number | null | undefined,
): PerformanceTier {
  const m = (model || '').toLowerCase();
  const c = Number(cores) || 0;

  if (/i9|ryzen 9|ultra 9/i.test(m) || c >= 12) return 'Flagship';
  if (/i7|ryzen 7|ultra 7/i.test(m) || c >= 8) return 'High';
  if (/i5|ryzen 5|ultra 5/i.test(m) || c >= 6) return 'Mid';
  if (c >= 4) return 'Mid';
  return 'Entry';
}

/**
 * Classify a saved PC build's GPU/CPU snapshot (device_builds.componentsJson)
 * into matrix tiers. Missing categories degrade to Entry.
 */
export function classifyBuildTiers(
  componentsJson: string | null | undefined,
): { gpuTier: PerformanceTier; cpuTier: PerformanceTier } {
  let gpu: any = null;
  let cpu: any = null;
  try {
    const parsed = JSON.parse(componentsJson || '{}');
    const components = Array.isArray(parsed.components) ? parsed.components : [];
    gpu = components.find((c: any) => c && c.category === 'GPU');
    cpu = components.find((c: any) => c && c.category === 'CPU');
  } catch {
    // Malformed snapshot degrades to Entry/Entry.
  }
  return {
    gpuTier: classifyGpuModel(gpu?.model || null, gpu?.vramGb ?? null, null),
    cpuTier: classifyCpuModel(cpu?.model || null, cpu?.cores ?? null),
  };
}

/** Assign a game demand class from its min RAM/VRAM/SSD requirements. */
export function demandClassFor(game: {
  'Min VRAM GB'?: number | null;
  'Min RAM GB'?: number | null;
  'SSD Required?'?: string | null;
}): DemandClass {
  const vram = Number(game['Min VRAM GB']) || 0;
  const ram = Number(game['Min RAM GB']) || 0;
  if (vram >= 8 || ram >= 16) return 'Very Demanding';
  if (vram >= 6 || ram >= 12) return 'Demanding';
  if (vram >= 2 || ram >= 8) return 'Moderate';
  return 'Light';
}

export interface PerformanceFps {
  fps4kUltra: number;
  fps1440pHigh: number;
  fps1080pMed: number;
  fps720pLow: number;
}

/** Compute deterministic FPS across the four resolution tiers. */
export function computeFps(
  demand: DemandClass,
  gpuTier: PerformanceTier,
  cpuTier: PerformanceTier,
): PerformanceFps {
  const base = GPU_BASE_FPS[demand][gpuTier];
  const mod = CPU_MODIFIER[cpuTier];
  const fps1080pMed = Math.max(1, Math.round(base * mod));
  return {
    fps4kUltra: Math.max(1, Math.round(fps1080pMed * 0.45)),
    fps1440pHigh: Math.max(1, Math.round(fps1080pMed * 0.68)),
    fps1080pMed,
    fps720pLow: Math.max(1, Math.round(fps1080pMed * 1.5)),
  };
}

/**
 * Idempotent seed. Generates rows only for games missing performance profiles
 * (checked once up front) so repeated server boots never duplicate work.
 */
export function seedPerformanceProfiles(db: DatabaseType): void {
  const games = db
    .prepare(
      'SELECT "GameID", "Min VRAM GB", "Min RAM GB", "SSD Required?" FROM "AppGames"',
    )
    .all() as Array<{
    GameID: string;
    'Min VRAM GB'?: number | null;
    'Min RAM GB'?: number | null;
    'SSD Required?'?: string | null;
  }>;

  const existingRows = db
    .prepare('SELECT DISTINCT gameId FROM "game_performance_profiles"')
    .all() as Array<{ gameId: string }>;
  const existing = new Set(existingRows.map((r) => r.gameId));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO "game_performance_profiles" (
      profileId, gameId, gpuTier, cpuTier,
      fps4kUltra, fps1440pHigh, fps1080pMed, fps720pLow, dataSource
    ) VALUES (
      @profileId, @gameId, @gpuTier, @cpuTier,
      @fps4kUltra, @fps1440pHigh, @fps1080pMed, @fps720pLow, @dataSource
    )
  `);

  const tx = db.transaction(() => {
    for (const game of games) {
      if (existing.has(game.GameID)) continue;
      const demand = demandClassFor(game);
      for (const gpuTier of PERFORMANCE_TIERS) {
        for (const cpuTier of PERFORMANCE_TIERS) {
          const fps = computeFps(demand, gpuTier, cpuTier);
          insert.run({
            profileId: `${game.GameID}::${gpuTier}::${cpuTier}`,
            gameId: game.GameID,
            gpuTier,
            cpuTier,
            fps4kUltra: fps.fps4kUltra,
            fps1440pHigh: fps.fps1440pHigh,
            fps1080pMed: fps.fps1080pMed,
            fps720pLow: fps.fps720pLow,
            dataSource: 'baseline',
          });
        }
      }
    }
  });

  tx();
}