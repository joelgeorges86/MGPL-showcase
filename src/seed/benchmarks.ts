import { Database as DatabaseType } from 'better-sqlite3';

/**
 * Sprint 5 (EPICUX05): Deterministic community benchmark seeding.
 *
 * Populates the `community_benchmarks` table with crowdsourced-style average FPS
 * and 1% low FPS figures for the seeded GPU/CPU catalog components, per
 * resolution (1080p / 1440p / 4K) and settings preset. Data is fully
 * deterministic (no network, no randomness) so the filterable benchmark tables
 * and the component Comparison Tool have stable fixtures across every boot and
 * E2E run. `sampleCount` models community sample sizes; `source` is always
 * 'community'.
 */

export type BenchmarkResolution = '1080p' | '1440p' | '4K';
export type BenchmarkPreset = 'Low' | 'Medium' | 'High' | 'Ultra';

export interface CommunityBenchmarkRow {
  benchmarkId: string;
  componentId: string;
  componentType: 'gpu' | 'cpu';
  componentName: string;
  resolution: BenchmarkResolution;
  settingsPreset: BenchmarkPreset;
  avgFps: number;
  onePercentLowFps: number;
  sampleCount: number;
  source: string;
}

interface BenchmarkSeedEntry {
  componentId: string;
  name: string;
  rows: Array<{
    resolution: BenchmarkResolution;
    settingsPreset: BenchmarkPreset;
    avgFps: number;
    onePercentLowFps: number;
    sampleCount: number;
  }>;
}

const GPU_BENCHMARKS: BenchmarkSeedEntry[] = [
  {
    componentId: 'gpu-rtx-4060', name: 'NVIDIA GeForce RTX 4060', rows: [
      { resolution: '1080p', settingsPreset: 'High', avgFps: 105, onePercentLowFps: 78, sampleCount: 640 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 75, onePercentLowFps: 55, sampleCount: 310 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 42, onePercentLowFps: 30, sampleCount: 120 },
    ],
  },
  {
    componentId: 'gpu-rtx-4070-super', name: 'NVIDIA GeForce RTX 4070 Super', rows: [
      { resolution: '1080p', settingsPreset: 'Ultra', avgFps: 120, onePercentLowFps: 92, sampleCount: 720 },
      { resolution: '1440p', settingsPreset: 'Ultra', avgFps: 88, onePercentLowFps: 66, sampleCount: 460 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 55, onePercentLowFps: 40, sampleCount: 180 },
    ],
  },
  {
    componentId: 'gpu-rtx-4080-super', name: 'NVIDIA GeForce RTX 4080 Super', rows: [
      { resolution: '1080p', settingsPreset: 'Ultra', avgFps: 160, onePercentLowFps: 120, sampleCount: 480 },
      { resolution: '1440p', settingsPreset: 'Ultra', avgFps: 118, onePercentLowFps: 90, sampleCount: 520 },
      { resolution: '4K', settingsPreset: 'Ultra', avgFps: 78, onePercentLowFps: 58, sampleCount: 260 },
    ],
  },
  {
    componentId: 'gpu-rtx-4090', name: 'NVIDIA GeForce RTX 4090', rows: [
      { resolution: '1080p', settingsPreset: 'Ultra', avgFps: 210, onePercentLowFps: 155, sampleCount: 410 },
      { resolution: '1440p', settingsPreset: 'Ultra', avgFps: 165, onePercentLowFps: 122, sampleCount: 590 },
      { resolution: '4K', settingsPreset: 'Ultra', avgFps: 110, onePercentLowFps: 80, sampleCount: 340 },
    ],
  },
  {
    componentId: 'gpu-rx-7600', name: 'AMD Radeon RX 7600', rows: [
      { resolution: '1080p', settingsPreset: 'High', avgFps: 100, onePercentLowFps: 74, sampleCount: 380 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 70, onePercentLowFps: 50, sampleCount: 210 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 38, onePercentLowFps: 26, sampleCount: 90 },
    ],
  },
  {
    componentId: 'gpu-rx-7800-xt', name: 'AMD Radeon RX 7800 XT', rows: [
      { resolution: '1080p', settingsPreset: 'Ultra', avgFps: 145, onePercentLowFps: 108, sampleCount: 420 },
      { resolution: '1440p', settingsPreset: 'Ultra', avgFps: 105, onePercentLowFps: 78, sampleCount: 390 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 62, onePercentLowFps: 45, sampleCount: 150 },
    ],
  },
  {
    componentId: 'gpu-rx-7900-xtx', name: 'AMD Radeon RX 7900 XTX', rows: [
      { resolution: '1080p', settingsPreset: 'Ultra', avgFps: 190, onePercentLowFps: 140, sampleCount: 360 },
      { resolution: '1440p', settingsPreset: 'Ultra', avgFps: 142, onePercentLowFps: 105, sampleCount: 440 },
      { resolution: '4K', settingsPreset: 'Ultra', avgFps: 95, onePercentLowFps: 70, sampleCount: 280 },
    ],
  },
];

const CPU_BENCHMARKS: BenchmarkSeedEntry[] = [
  {
    componentId: 'cpu-r5-7600x', name: 'AMD Ryzen 5 7600X', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 110, onePercentLowFps: 85, sampleCount: 300 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 100, onePercentLowFps: 78, sampleCount: 220 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 90, onePercentLowFps: 68, sampleCount: 110 },
    ],
  },
  {
    componentId: 'cpu-r7-7800x3d', name: 'AMD Ryzen 7 7800X3D', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 130, onePercentLowFps: 100, sampleCount: 510 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 118, onePercentLowFps: 92, sampleCount: 410 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 105, onePercentLowFps: 80, sampleCount: 190 },
    ],
  },
  {
    componentId: 'cpu-r9-7950x3d', name: 'AMD Ryzen 9 7950X3D', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 140, onePercentLowFps: 108, sampleCount: 250 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 125, onePercentLowFps: 98, sampleCount: 260 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 112, onePercentLowFps: 86, sampleCount: 130 },
    ],
  },
  {
    componentId: 'cpu-r5-5600x', name: 'AMD Ryzen 5 5600X', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 95, onePercentLowFps: 72, sampleCount: 430 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 88, onePercentLowFps: 68, sampleCount: 240 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 82, onePercentLowFps: 62, sampleCount: 100 },
    ],
  },
  {
    componentId: 'cpu-r7-5800x3d', name: 'AMD Ryzen 7 5800X3D', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 112, onePercentLowFps: 86, sampleCount: 380 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 102, onePercentLowFps: 80, sampleCount: 290 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 95, onePercentLowFps: 74, sampleCount: 120 },
    ],
  },
  {
    componentId: 'cpu-i5-14600k', name: 'Intel Core i5-14600K', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 122, onePercentLowFps: 94, sampleCount: 330 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 112, onePercentLowFps: 87, sampleCount: 210 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 100, onePercentLowFps: 76, sampleCount: 95 },
    ],
  },
  {
    componentId: 'cpu-i7-14700k', name: 'Intel Core i7-14700K', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 132, onePercentLowFps: 102, sampleCount: 300 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 120, onePercentLowFps: 93, sampleCount: 230 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 108, onePercentLowFps: 82, sampleCount: 105 },
    ],
  },
  {
    componentId: 'cpu-i9-14900k', name: 'Intel Core i9-14900K', rows: [
      { resolution: '1080p', settingsPreset: 'Medium', avgFps: 142, onePercentLowFps: 110, sampleCount: 280 },
      { resolution: '1440p', settingsPreset: 'High', avgFps: 128, onePercentLowFps: 100, sampleCount: 250 },
      { resolution: '4K', settingsPreset: 'High', avgFps: 115, onePercentLowFps: 88, sampleCount: 115 },
    ],
  },
];

/**
 * Idempotent seed (INSERT OR IGNORE keyed on benchmarkId). Runs from initDb()
 * on every server boot; the Playwright global-setup re-runs it after its
 * deterministic table wipe so the E2E suite always sees stable fixtures.
 */
export function seedCommunityBenchmarks(db: DatabaseType): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO "community_benchmarks" (
      benchmarkId, componentId, componentType, componentName, resolution,
      settingsPreset, avgFps, onePercentLowFps, sampleCount, source
    ) VALUES (
      @benchmarkId, @componentId, @componentType, @componentName, @resolution,
      @settingsPreset, @avgFps, @onePercentLowFps, @sampleCount, @source
    )
  `);
  const entries: Array<BenchmarkSeedEntry & { componentType: 'gpu' | 'cpu' }> = [
    ...GPU_BENCHMARKS.map((e) => ({ ...e, componentType: 'gpu' as const })),
    ...CPU_BENCHMARKS.map((e) => ({ ...e, componentType: 'cpu' as const })),
  ];
  const tx = db.transaction(() => {
    for (const entry of entries) {
      for (const row of entry.rows) {
        insert.run({
          benchmarkId: `bm-${entry.componentId}-${row.resolution.toLowerCase()}-${row.settingsPreset.toLowerCase()}`,
          componentId: entry.componentId,
          componentType: entry.componentType,
          componentName: entry.name,
          resolution: row.resolution,
          settingsPreset: row.settingsPreset,
          avgFps: row.avgFps,
          onePercentLowFps: row.onePercentLowFps,
          sampleCount: row.sampleCount,
          source: 'community',
        });
      }
    }
  });
  tx();
}

