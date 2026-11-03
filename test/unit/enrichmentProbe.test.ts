import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("G-2 local-only probe", () => {
  it("records Tranche A null output and does not decide the gate", async () => {
    const probe = await import("../../scripts/probes/g2-enrichment-probe.mjs");
    const fixture = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "scripts/probes/g2-fixture.json"), "utf8"),
    );
    const report = probe.inspectProbeOutput(fixture);
    expect(report.fabricationFindings).toEqual([]);
    expect(report.observations[0].nullState.steamAppId).toBe(true);
    expect(report.observations[1].provenance).toBe("assumed_absent");
  });
});
