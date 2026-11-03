export interface DeviceSpecs {
  id: string;
  deviceName: string;
  deviceType?: string | null;
  cpuModel?: string | null;
  cpuCores?: number | null;
  ramGb?: number | null;
  gpuModel?: string | null;
  vramGb?: number | null;
  gpuType?: string | null;
  storageType?: string | null;
  storageFreeGb?: number | null;
  isPortable?: boolean | number | null;
}

export interface GameRequirements {
  GameID: string;
  "Game Title"?: string;
  "Min RAM GB"?: number | string | null;
  "Min VRAM GB"?: number | string | null;
  "Storage Size"?: number | string | null;
  "SSD Required?"?: string | boolean | null;
  // DPM-01: optional per-game CPU core requirement. When absent the CPU axis
  // is "not evaluated" instead of applying a universal 4-core bar.
  "Min CPU Cores"?: number | string | null;
  minCpuCores?: number | string | null;
}

export type PowerProfile = 'Plugged-In' | 'Battery Saver' | 'plugged' | 'battery';

export interface AxisResult {
  deviceValue: number | null;
  requiredValue: number | null;
  marginGbOrPct: number | null;
  status: 'optimal' | 'playable' | 'bottleneck' | 'unsupported' | 'missing';
  note: string;
}

export interface CompatibilityResult {
  rating: 'Optimal' | 'Playable' | 'Bottlenecked' | 'Unsupported' | 'Incomplete Specs';
  primaryBottleneck: 'CPU' | 'RAM' | 'VRAM' | 'Storage' | null;
  powerProfile: 'Plugged-In' | 'Battery Saver';
  axes: {
    ram: AxisResult;
    vram: AxisResult;
    storage: AxisResult;
    cpu: AxisResult;
  };
  notes: string[];
}

/**
 * Helper to parse numbers out of string requirements (e.g. "70 GB" -> 70)
 */
export function parseRequirementGb(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  const parsed = parseFloat(val.toString().replace(/[^0-9.]/g, ''));
  return isNaN(parsed) ? null : parsed;
}

/**
 * Calculates multi-axis headroom and compatibility rating for a given device and game.
 */
export function evaluateCompatibility(
  device: DeviceSpecs,
  game: GameRequirements,
  powerProfileOption?: PowerProfile
): CompatibilityResult {
  const isPortable = Boolean(device.isPortable);
  
  // Normalize power profile
  let powerProfile: 'Plugged-In' | 'Battery Saver' = 'Plugged-In';
  if (isPortable) {
    if (powerProfileOption === 'Battery Saver' || powerProfileOption === 'battery') {
      powerProfile = 'Battery Saver';
    }
  }

  // Battery saver penalty multiplier on effective RAM / VRAM / CPU headroom
  const perfMultiplier = powerProfile === 'Battery Saver' ? 0.75 : 1.0;

  const reqRam = parseRequirementGb(game['Min RAM GB']);
  const reqVram = parseRequirementGb(game['Min VRAM GB']);
  const reqStorage = parseRequirementGb(game['Storage Size']);

  const devRam = device.ramGb !== null && device.ramGb !== undefined ? device.ramGb : null;
  const devVram = device.vramGb !== null && device.vramGb !== undefined ? device.vramGb : null;
  const devStorage = device.storageFreeGb !== null && device.storageFreeGb !== undefined ? device.storageFreeGb : null;
  const devCpuCores = device.cpuCores !== null && device.cpuCores !== undefined ? device.cpuCores : null;

  const notes: string[] = [];

  // Device-side completeness gate (DPM-12): the engine reads these device
  // fields unconditionally, so a null value is a blocked "Incomplete Specs"
  // state — never a silent Playable — even when a specific game row carries no
  // matching requirement. This closes the gap where device rows missing
  // cpuCores / storageFreeGb previously rendered "Playable".
  const missingFields: string[] = [];
  if (devCpuCores === null) missingFields.push('CPU Cores');
  if (devRam === null) missingFields.push('RAM');
  if (devVram === null) missingFields.push('VRAM');
  if (devStorage === null) missingFields.push('Free Storage');

  if (missingFields.length > 0) {
    notes.push(`Missing device specification fields: ${missingFields.join(', ')}. Run hardware re-scan to evaluate.`);
    return {
      rating: 'Incomplete Specs',
      primaryBottleneck: null,
      powerProfile,
      axes: {
        ram: { deviceValue: devRam, requiredValue: reqRam, marginGbOrPct: null, status: 'missing', note: 'RAM specs missing' },
        vram: { deviceValue: devVram, requiredValue: reqVram, marginGbOrPct: null, status: 'missing', note: 'VRAM specs missing' },
        storage: { deviceValue: devStorage, requiredValue: reqStorage, marginGbOrPct: null, status: 'missing', note: 'Storage specs missing' },
        cpu: { deviceValue: devCpuCores, requiredValue: 4, marginGbOrPct: null, status: 'playable', note: 'CPU evaluation' },
      },
      notes,
    };
  }

  // Effective capacities after power profile adjustment
  const effectiveRam = devRam !== null ? devRam * perfMultiplier : null;
  const effectiveVram = devVram !== null ? devVram * perfMultiplier : null;

  if (isPortable && powerProfile === 'Battery Saver') {
    notes.push('Portable device running in Battery Saver mode (25% TDP/performance scaling applied).');
  }

  // Evaluate RAM
  const ramAxis: AxisResult = {
    deviceValue: devRam,
    requiredValue: reqRam,
    marginGbOrPct: null,
    status: 'playable',
    note: '',
  };
  if (reqRam !== null && devRam !== null && effectiveRam !== null) {
    const margin = effectiveRam - reqRam;
    ramAxis.marginGbOrPct = Math.round(margin * 10) / 10;
    if (effectiveRam < reqRam) {
      if (effectiveRam < reqRam * 0.75) {
        ramAxis.status = 'unsupported';
        ramAxis.note = `RAM (${devRam} GB) is severely below required ${reqRam} GB.`;
      } else {
        ramAxis.status = 'bottleneck';
        ramAxis.note = `RAM (${devRam} GB) is below required ${reqRam} GB.`;
      }
    } else if (margin >= 4) {
      ramAxis.status = 'optimal';
      ramAxis.note = `Sufficient RAM headroom (+${ramAxis.marginGbOrPct} GB).`;
    } else {
      ramAxis.status = 'playable';
      ramAxis.note = `Meets RAM requirement with minimal margin (+${ramAxis.marginGbOrPct} GB).`;
    }
  }

  // Evaluate VRAM
  const vramAxis: AxisResult = {
    deviceValue: devVram,
    requiredValue: reqVram,
    marginGbOrPct: null,
    status: 'playable',
    note: '',
  };
  if (reqVram !== null && devVram !== null && effectiveVram !== null) {
    const margin = effectiveVram - reqVram;
    vramAxis.marginGbOrPct = Math.round(margin * 10) / 10;
    if (effectiveVram < reqVram) {
      if (effectiveVram < reqVram * 0.75) {
        vramAxis.status = 'unsupported';
        vramAxis.note = `VRAM (${devVram} GB) is severely below required ${reqVram} GB.`;
      } else {
        vramAxis.status = 'bottleneck';
        vramAxis.note = `VRAM (${devVram} GB) is below required ${reqVram} GB.`;
      }
    } else if (margin >= 2) {
      vramAxis.status = 'optimal';
      vramAxis.note = `Sufficient VRAM headroom (+${vramAxis.marginGbOrPct} GB).`;
    } else {
      vramAxis.status = 'playable';
      vramAxis.note = `Meets VRAM requirement with minimal margin (+${vramAxis.marginGbOrPct} GB).`;
    }
  }

  // Evaluate Storage (DPM-02): free space is scaled by the same battery-saver
  // multiplier as RAM/VRAM, so ratings can never overstate storage headroom on
  // battery. The note still reports the raw device free space for transparency.
  const storageAxis: AxisResult = {
    deviceValue: devStorage,
    requiredValue: reqStorage,
    marginGbOrPct: null,
    status: 'playable',
    note: '',
  };
  if (reqStorage !== null && devStorage !== null) {
    const effectiveStorage = devStorage * perfMultiplier;
    const margin = effectiveStorage - reqStorage;
    storageAxis.marginGbOrPct = Math.round(margin * 10) / 10;
    if (effectiveStorage < reqStorage) {
      storageAxis.status = 'unsupported';
      storageAxis.note = `Insufficient Storage (${devStorage} GB free, ${reqStorage} GB required${perfMultiplier < 1 ? ' on battery' : ''}).`;
    } else if (margin >= 20) {
      storageAxis.status = 'optimal';
      storageAxis.note = `Ample free storage space (+${storageAxis.marginGbOrPct} GB available).`;
    } else {
      storageAxis.status = 'playable';
      storageAxis.note = `Free storage meets requirement (+${storageAxis.marginGbOrPct} GB remaining).`;
    }
  }

  // Evaluate CPU (DPM-01): the requirement is data-driven from the game row
  // ("Min CPU Cores") when present. Without a per-game requirement the axis is
  // honestly "not evaluated" instead of applying a universal 4-core bar, and it
  // can never manufacture a CPU bottleneck for titles with no CPU data.
  const reqCpuRaw = game['Min CPU Cores'] ?? game.minCpuCores;
  const reqCpuNum =
    reqCpuRaw === null || reqCpuRaw === undefined || reqCpuRaw === ''
      ? null
      : Number(reqCpuRaw);
  const cpuReq =
    reqCpuNum !== null && Number.isFinite(reqCpuNum) && reqCpuNum > 0
      ? reqCpuNum
      : null;
  const cpuAxis: AxisResult = {
    deviceValue: devCpuCores,
    requiredValue: cpuReq,
    marginGbOrPct: devCpuCores !== null && cpuReq !== null ? devCpuCores - cpuReq : null,
    status: cpuReq === null ? 'missing' : 'playable',
    note: cpuReq === null
      ? 'No per-game CPU requirement defined — CPU headroom not evaluated.'
      : 'CPU cores adequate for baseline execution.',
  };
  if (devCpuCores !== null && cpuReq !== null) {
    if (devCpuCores >= cpuReq + 4) {
      cpuAxis.status = 'optimal';
      cpuAxis.note = `Multi-core CPU headroom (${devCpuCores} cores vs ${cpuReq} required).`;
    } else if (devCpuCores < cpuReq) {
      cpuAxis.status = 'bottleneck';
      cpuAxis.note = `Low CPU core count (${devCpuCores} cores, ${cpuReq} required).`;
    } else {
      cpuAxis.status = 'playable';
      cpuAxis.note = `Meets CPU core requirement (${devCpuCores} cores).`;
    }
  }

  // Primary Bottleneck identification & Overall Rating
  let primaryBottleneck: 'CPU' | 'RAM' | 'VRAM' | 'Storage' | null = null;
  let rating: 'Optimal' | 'Playable' | 'Bottlenecked' | 'Unsupported' | 'Incomplete Specs' = 'Optimal';

  const statuses = [ramAxis.status, vramAxis.status, storageAxis.status];
  if (cpuAxis.status !== 'missing') statuses.push(cpuAxis.status);

  if (statuses.includes('unsupported')) {
    rating = 'Unsupported';
    if (storageAxis.status === 'unsupported') primaryBottleneck = 'Storage';
    else if (vramAxis.status === 'unsupported') primaryBottleneck = 'VRAM';
    else if (ramAxis.status === 'unsupported') primaryBottleneck = 'RAM';
    else primaryBottleneck = 'CPU';
  } else if (statuses.includes('bottleneck')) {
    rating = 'Bottlenecked';
    if (vramAxis.status === 'bottleneck') primaryBottleneck = 'VRAM';
    else if (ramAxis.status === 'bottleneck') primaryBottleneck = 'RAM';
    else if (storageAxis.status === 'bottleneck') primaryBottleneck = 'Storage';
    else primaryBottleneck = 'CPU';
  } else if (statuses.includes('playable')) {
    rating = 'Playable';
  } else {
    rating = 'Optimal';
  }

  if (ramAxis.note) notes.push(ramAxis.note);
  if (vramAxis.note) notes.push(vramAxis.note);
  if (storageAxis.note) notes.push(storageAxis.note);
  if (cpuAxis.note) notes.push(cpuAxis.note);

  return {
    rating,
    primaryBottleneck,
    powerProfile,
    axes: {
      ram: ramAxis,
      vram: vramAxis,
      storage: storageAxis,
      cpu: cpuAxis,
    },
    notes,
  };
}

// =============================================================================
// Sprint 5 (EPICUX05): Multi-tier (Minimum / Recommended / Ultra) headroom.
//
// The AppGames table only persists Minimum requirements (Min RAM GB / Min VRAM
// GB / Storage Size / Min CPU Cores). Recommended & Ultra tiers are therefore
// DERIVED deterministically from those persisted minimums using conservative,
// widely-accepted multipliers — never fabricated from thin air. Every result is
// labeled `derived: true` so the UI can disclose that these tiers are estimates
// and cannot be confused with source-verified requirements (VCM "no synthetic
// tiers" doctrine: all calculations still trace back to persisted real-world
// specifications).
// =============================================================================

export type RequirementTier = 'minimum' | 'recommended' | 'ultra';

const roundUpToEven = (n: number): number => Math.ceil(n / 2) * 2;

/**
 * Derive the persisted-shaped requirements for a tier. `minimum` is a passthrough
 * of the persisted values; `recommended` / `ultra` apply deterministic scaling:
 *
 *   RAM:      recommended = 2× min (rounded to even), ultra = 4× min
 *   VRAM:     recommended = 1.5× min, ultra = 2.5× min
 *   Storage:  recommended = min, ultra = 1.25× min (patches/DLC headroom)
 *   CPU cores: recommended = max(8, min + 4), ultra = max(12, min + 8)
 *
 * Unknown minimums stay `null` so the axis is honestly "not evaluated".
 */
export function deriveTierRequirements(
  game: GameRequirements,
  tier: RequirementTier,
): GameRequirements {
  const minRam = parseRequirementGb(game['Min RAM GB']);
  const minVram = parseRequirementGb(game['Min VRAM GB']);
  const minStorage = parseRequirementGb(game['Storage Size']);
  const rawCpu = game['Min CPU Cores'] ?? game.minCpuCores;
  const minCpu =
    rawCpu === null || rawCpu === undefined || rawCpu === ''
      ? null
      : Number(rawCpu);
  const cpuReq = minCpu !== null && Number.isFinite(minCpu) && minCpu > 0 ? minCpu : null;

  let ram: number | null = null;
  let vram: number | null = null;
  let storage: number | null = null;
  let cpu: number | null = null;

  if (tier === 'minimum') {
    ram = minRam;
    vram = minVram;
    storage = minStorage;
    cpu = cpuReq;
  } else if (tier === 'recommended') {
    ram = minRam !== null ? roundUpToEven(minRam * 2) : null;
    vram = minVram !== null ? Math.ceil(minVram * 1.5) : null;
    storage = minStorage;
    cpu = cpuReq !== null ? Math.max(8, cpuReq + 4) : null;
  } else {
    ram = minRam !== null ? roundUpToEven(minRam * 4) : null;
    vram = minVram !== null ? Math.ceil(minVram * 2.5) : null;
    storage = minStorage !== null ? Math.ceil(minStorage * 1.25) : null;
    cpu = cpuReq !== null ? Math.max(12, cpuReq + 8) : null;
  }

  return {
    GameID: game.GameID,
    'Game Title': game['Game Title'],
    'Min RAM GB': ram,
    'Min VRAM GB': vram,
    'Storage Size': storage,
    'SSD Required?': game['SSD Required?'],
    'Min CPU Cores': cpu,
  };
}

export interface TieredCompatibilityResult {
  powerProfile: 'Plugged-In' | 'Battery Saver';
  derived: boolean;
  tiers: Record<RequirementTier, CompatibilityResult>;
}

/**
 * Evaluates a device against all three requirement tiers (Minimum, Recommended,
 * Ultra). Each tier independently computes CPU / RAM / VRAM / Storage margins
 * via the single-tier engine, so the matrix guardrails (device-side completeness
 * gate, missing-field blocking, battery scaling) apply identically to every tier.
 */
export function evaluateTieredCompatibility(
  device: DeviceSpecs,
  game: GameRequirements,
  powerProfileOption?: PowerProfile,
): TieredCompatibilityResult {
  const minimum = evaluateCompatibility(device, game, powerProfileOption);
  const recommended = evaluateCompatibility(
    device,
    deriveTierRequirements(game, 'recommended'),
    powerProfileOption,
  );
  const ultra = evaluateCompatibility(
    device,
    deriveTierRequirements(game, 'ultra'),
    powerProfileOption,
  );
  return {
    powerProfile: minimum.powerProfile,
    derived: true,
    tiers: { minimum, recommended, ultra },
  };
}
