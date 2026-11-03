import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDpmFallbackPayload,
  cacheGet,
  cacheInvalidate,
  cacheSet,
  getDpmCounters,
  normalizeDeviceKey,
  recordDpmCounter,
  renderDpmMetricsText,
  setDpmHealth,
  withDpmRetry,
} from "../../src/services/devicePlayability";

describe("devicePlayability extra coverage", () => {
  afterEach(() => {
    cacheInvalidate("deck_h");
    setDpmHealth(true);
    vi.useRealTimers();
  });

  it("retains inserted entries below the actual cache cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    for (let i = 0; i < 101; i += 1) {
      cacheSet(`playability:item-${i}`, { id: i });
    }

    expect(cacheGet("playability:item-0")).toEqual({ id: 0 });
    expect(cacheGet("playability:item-100")).toEqual({ id: 100 });
  });

  it("invalidates both normalized playability cache key variants", () => {
    cacheSet("playability:deck_h", { rating: "Playable" });
    cacheSet("playable:deck_h", { legacy: true });
    cacheInvalidate("steam-deck");
    expect(cacheGet("playability:deck_h")).toBeNull();
    expect(cacheGet("playable:deck_h")).toBeNull();
  });

  it("returns fallback payloads with explicit normalized device ids", () => {
    expect(buildDpmFallbackPayload("steam-deck").deviceId).toBe("steam-deck");
    expect(normalizeDeviceKey("steam-deck")).toBe("deck_h");
  });

  it("records retry counters only on retried attempts", () => {
    const before = getDpmCounters().dpm_retries_total;
    let calls = 0;
    const result = withDpmRetry(
      () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("transient");
        }
        return "ok";
      },
      3,
      "metrics",
    );

    expect(result.ok).toBe(true);
    expect(getDpmCounters().dpm_retries_total).toBe(before + 1);
  });

  it("renders counters after manual increments", () => {
    recordDpmCounter("dpm_requests_total", "metrics");
    const text = renderDpmMetricsText();
    expect(text).toContain(
      "# HELP dpm_requests_total Total DPM playability/health requests received.",
    );
    expect(text).toMatch(/dpm_requests_total \d+/);
  });
});
