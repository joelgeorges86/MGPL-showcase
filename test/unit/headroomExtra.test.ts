import { describe, expect, it } from "vitest";
import {
  deriveTierRequirements,
  evaluateCompatibility,
  evaluateTieredCompatibility,
  parseRequirementGb,
  type DeviceSpecs,
  type GameRequirements,
} from "../../src/services/headroom";

const portableRig: DeviceSpecs = {
  id: "handheld-1",
  deviceName: "Portable Rig",
  cpuModel: "Ryzen Z1 Extreme",
  cpuCores: 8,
  ramGb: 16,
  gpuModel: "Radeon 780M",
  vramGb: 4,
  storageFreeGb: 128,
  isPortable: true,
};

const moderateGame: GameRequirements = {
  GameID: "game-req-1",
  "Min RAM GB": "8 GB",
  "Min VRAM GB": "4 GB",
  "Storage Size": "100 GB",
  minCpuCores: 6,
};

describe("headroom extra coverage", () => {
  it("parses numeric strings with punctuation and rejects empty strings", () => {
    expect(parseRequirementGb(" 256GB ")).toBe(256);
    expect(parseRequirementGb("0.75 gb")).toBe(0.75);
    expect(parseRequirementGb("")).toBeNull();
  });

  it("marks storage as playable when free space meets the minimum without extra headroom", () => {
    const result = evaluateCompatibility(portableRig, moderateGame, "plugged");
    expect(result.rating).toBe("Playable");
    expect(result.primaryBottleneck).toBeNull();
    expect(result.axes.storage.status).toBe("optimal");
  });

  it("uses minCpuCores alias when canonical cpu field is absent", () => {
    const result = evaluateCompatibility({ ...portableRig, storageFreeGb: 256 }, moderateGame);
    expect(result.axes.cpu.requiredValue).toBe(6);
    expect(result.axes.cpu.status).toBe("playable");
  });

  it("keeps minimum tier as a passthrough and derives higher tiers deterministically", () => {
    const minimum = deriveTierRequirements(moderateGame, "minimum");
    const recommended = deriveTierRequirements(moderateGame, "recommended");
    expect(minimum["Min VRAM GB"]).toBe(4);
    expect(recommended["Min VRAM GB"]).toBe(6);
    expect(recommended["Min CPU Cores"]).toBe(10);
  });

  it("evaluates all tiers and degrades tougher derived tiers for weaker hardware", () => {
    const tiered = evaluateTieredCompatibility(
      { ...portableRig, storageFreeGb: 256 },
      moderateGame,
      "battery",
    );
    expect(tiered.tiers.minimum.powerProfile).toBe("Battery Saver");
    expect(["Playable", "Bottlenecked", "Unsupported"]).toContain(tiered.tiers.recommended.rating);
    expect(["Bottlenecked", "Unsupported", "Playable"]).toContain(tiered.tiers.ultra.rating);
  });
});
