import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4000";

/**
 * Sprint 1 (EPIC-DEAL-001) — Ingestion Hardening & Storefront Security E2E.
 *
 * Test 1: Ingestion rejects unwhitelisted / grey-market seller URLs.
 * Test 2: Ingestion drops out-of-bounds prices (negative / overflow).
 * Test 3: Circuit breaker trips to cached fallback data on upstream 500s.
 * Test 4: Every external deal link in the API response is HTTPS + whitelisted.
 */

const ALLOWED_HOSTS = new Set([
  "store.steampowered.com",
  "gog.com",
  "www.gog.com",
  "store.epicgames.com",
  "fanatical.com",
  "www.fanatical.com",
  "greenmangaming.com",
  "www.greenmangaming.com",
  "humblebundle.com",
  "www.humblebundle.com",
  "gamesplanet.com",
  "www.gamesplanet.com",
  "gamebillet.com",
  "www.gamebillet.com",
  "gamerpower.com",
  "www.gamerpower.com",
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function resetTestState(request: any) {
  await request.post(`${BASE}/api/mock/breaker/reset`);
  await request.delete(`${BASE}/api/mock/upstream`, {
    data: { host: "cheapshark.com" },
  });
}

test.describe("EPIC-DEAL-001 — Deals Ingestion Security", () => {
  test.beforeEach(async ({ request }) => {
    await resetTestState(request);
  });

  test.afterEach(async ({ request }) => {
    await resetTestState(request);
  });

  test("1. ingestion rejects unwhitelisted and grey-market seller URLs", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/deals/search`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);

    const deals: any[] = data.deals || [];
    expect(deals.length).toBeGreaterThan(0);

    const titles = deals.map((d: any) => String(d.title || ""));
    const stores = deals.map((d: any) => String(d.store || "").toLowerCase());
    const urls = deals.map((d: any) => String(d.storeUrl || "").toLowerCase());

    // Grey-market store canary (CheapShark storeID 37 -> "Gamivo") is dropped.
    expect(titles.join(" ")).not.toContain("Grey Market Gamivo");
    expect(stores.join(" ")).not.toContain("gamivo");

    // Grey-market URL canary (g2a.com) is dropped entirely.
    expect(titles.join(" ")).not.toContain("G2A Phishing");
    expect(urls.join(" ")).not.toContain("g2a.com");

    // The known-good deal still flows through.
    expect(titles.join(" ")).toContain("Cyberpunk 2077");
  });

  test("2. ingestion drops records with out-of-bounds prices", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/deals/search`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);

    const deals: any[] = data.deals || [];
    const titles = deals.map((d: any) => String(d.title || ""));

    // Negative and overflow price canaries are dropped.
    expect(titles.join(" ")).not.toContain("Negative Price Canary");
    expect(titles.join(" ")).not.toContain("Overflow Price Canary");

    // Every remaining price is within [0, 999.99].
    for (const d of deals) {
      const price = Number(d.currentPrice);
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThanOrEqual(0);
      expect(price).toBeLessThanOrEqual(999.99);
    }
  });

  test("3. circuit breaker trips cleanly to cached fallback on upstream 500s", async ({
    request,
  }) => {
    // Prime the breaker snapshot with a successful CheapShark fetch.
    const prime = await request.get(`${BASE}/api/deals/search`);
    expect(prime.ok()).toBeTruthy();
    const primeData = await prime.json();
    expect(primeData.source).toBe("cheapshark");
    expect(primeData.circuitState).toBe("CLOSED");

    // Simulate an upstream 500 outage.
    const override = await request.post(`${BASE}/api/mock/upstream`, {
      data: { host: "cheapshark.com", status: 500 },
    });
    expect(override.ok()).toBeTruthy();

    // First failure: breaker is still CLOSED but serves the stale snapshot.
    const first = await request.get(`${BASE}/api/deals/search`);
    const firstData = await first.json();
    expect(firstData.fallback).toBe(true);
    expect(firstData.source).toBe("stale-snapshot");

    // Second failure trips the breaker OPEN.
    const second = await request.get(`${BASE}/api/deals/search`);
    const secondData = await second.json();
    expect(secondData.fallback).toBe(true);
    expect(secondData.circuitState).toBe("OPEN");
    expect(secondData.source).toBe("stale-snapshot");

    // A further request is short-circuited while OPEN and still serves cached
    // deals with valid whitelisted URLs.
    const third = await request.get(`${BASE}/api/deals/search`);
    const thirdData = await third.json();
    expect(thirdData.fallback).toBe(true);
    expect(thirdData.circuitState).toBe("OPEN");

    const deals: any[] = thirdData.deals || [];
    expect(deals.length).toBeGreaterThan(0);
    for (const d of deals) {
      const host = hostOf(String(d.storeUrl || ""));
      expect(host).not.toBe("");
      expect(ALLOWED_HOSTS.has(host)).toBe(true);
    }
  });

  test("4. external deal links strictly adhere to the HTTPS domain whitelist", async ({
    request,
  }) => {
    const endpoints = [
      `${BASE}/api/deals/search`,
      `${BASE}/api/deals/by-store?store=all`,
    ];

    for (const url of endpoints) {
      const res = await request.get(url);
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      const deals: any[] = data.deals || [];

      for (const d of deals) {
        const storeUrl = String(d.storeUrl || "");
        expect(storeUrl.startsWith("https://")).toBe(true);

        const host = hostOf(storeUrl);
        expect(host).not.toBe("");
        expect(ALLOWED_HOSTS.has(host)).toBe(true);
      }
    }
  });
});
