import { describe, it, expect } from 'vitest';
import {
  parseRequirementGb,
  evaluateCompatibility,
  deriveTierRequirements,
  evaluateTieredCompatibility,
} from '../../src/services/headroom';
import type { DeviceSpecs, GameRequirements } from '../../src/services/headroom';

const beefyDesktop: DeviceSpecs = {
  id: 'dev-1',
  deviceName: 'Beefy Desktop',
  deviceType: 'desktop',
  cpuModel: 'Ryzen 9 7950X',
  cpuCores: 16,
  ramGb: 64,
  gpuModel: 'RTX 4080',
  vramGb: 24,
  gpuType: 'discrete',
  storageType: 'nvme',
  storageFreeGb: 500,
  isPortable: false,
};

const demandingGame: GameRequirements = {
  GameID: 'GAME-001',
  'Game Title': 'Demanding Game',
  'Min RAM GB': 16,
  'Min VRAM GB': 8,
  'Storage Size': '100 GB',
  'Min CPU Cores': 8,
};

describe('headroom / compatibility engine', () => {
  it('parses requirement strings like "70 GB" into numbers', () => {
    expect(parseRequirementGb('70 GB')).toBe(70);
    expect(parseRequirementGb('1.5 GB')).toBe(1.5);
    expect(parseRequirementGb(16)).toBe(16);
    expect(parseRequirementGb(null)).toBeNull();
    expect(parseRequirementGb(undefined)).toBeNull();
    expect(parseRequirementGb('unknown')).toBeNull();
  });

  it('rates a fully-specified beefy device as Optimal', () => {
    const result = evaluateCompatibility(beefyDesktop, demandingGame);
    expect(result.rating).toBe('Optimal');
    expect(result.powerProfile).toBe('Plugged-In');
    expect(result.primaryBottleneck).toBeNull();
  });

  it('returns Incomplete Specs when a device field is missing (DPM-12 gate)', () => {
    const incomplete: DeviceSpecs = { ...beefyDesktop, ramGb: null };
    const result = evaluateCompatibility(incomplete, demandingGame);
    expect(result.rating).toBe('Incomplete Specs');
  });

  it('flags a CPU core bottleneck below the requirement', () => {
    const lowCores: DeviceSpecs = { ...beefyDesktop, cpuCores: 6 };
    const result = evaluateCompatibility(lowCores, demandingGame);
    expect(result.rating).toBe('Bottlenecked');
    expect(result.primaryBottleneck).toBe('CPU');
  });

  it('marks Unsupported when VRAM falls below the minimum', () => {
    const weakGpu: DeviceSpecs = { ...beefyDesktop, vramGb: 4 };
    const result = evaluateCompatibility(weakGpu, demandingGame);
    expect(result.rating).toBe('Unsupported');
    expect(result.primaryBottleneck).toBe('VRAM');
  });

  it('applies Battery Saver only for portable devices', () => {
    const handheld: DeviceSpecs = { ...beefyDesktop, isPortable: true };
    const plugged = evaluateCompatibility(handheld, demandingGame, 'Plugged-In');
    const battery = evaluateCompatibility(handheld, demandingGame, 'Battery Saver');
    expect(plugged.powerProfile).toBe('Plugged-In');
    expect(battery.powerProfile).toBe('Battery Saver');
  });

  it('ignores Battery Saver request for non-portable devices', () => {
    const result = evaluateCompatibility(beefyDesktop, demandingGame, 'Battery Saver');
    expect(result.powerProfile).toBe('Plugged-In');
  });
});

describe('tier derivation', () => {
  it('scales requirements deterministically per tier', () => {
    const minimum = deriveTierRequirements(demandingGame, 'minimum');
    const recommended = deriveTierRequirements(demandingGame, 'recommended');
    const ultra = deriveTierRequirements(demandingGame, 'ultra');

    expect(minimum['Min RAM GB']).toBe(16);
    // recommended RAM = 2× min rounded to even → 32; ultra = 4× → 64
    expect(recommended['Min RAM GB']).toBe(32);
    expect(ultra['Min RAM GB']).toBe(64);
    // recommended VRAM = ceil(1.5× 8) = 12; ultra = ceil(2.5× 8) = 20
    expect(recommended['Min VRAM GB']).toBe(12);
    expect(ultra['Min VRAM GB']).toBe(20);
    // CPU: recommended = max(8, 8+4) = 12; ultra = max(12, 8+8) = 16
    expect(recommended['Min CPU Cores']).toBe(12);
    expect(ultra['Min CPU Cores']).toBe(16);
  });

  it('keeps unknown minimums null instead of guessing', () => {
    const noVram: GameRequirements = { GameID: 'X', 'Min RAM GB': 8 };
    const ultra = deriveTierRequirements(noVram, 'ultra');
    expect(ultra['Min VRAM GB']).toBeNull();
    expect(ultra['Min RAM GB']).toBe(32);
  });

  it('evaluates all three tiers with derived flag', () => {
    const tiered = evaluateTieredCompatibility(beefyDesktop, demandingGame);
    expect(tiered.derived).toBe(true);
    expect(Object.keys(tiered.tiers).sort()).toEqual(['minimum', 'recommended', 'ultra']);
    expect(tiered.tiers.minimum.rating).toBe('Optimal');
  });
});
