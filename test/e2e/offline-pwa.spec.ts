import { test, expect } from '@playwright/test';

/**
 * Sprint 19 (FEAT-0151) — Offline-First PWA, Service Worker & IndexedDB Persistence Engine.
 *
 * Test 1: Service worker registers and the web app manifest is linked.
 * Test 2: Online browsing populates the IndexedDB offline stores.
 * Test 3: Simulated offline renders dashboard views (games, fleet, deals, backlog) from IndexedDB cache.
 * Test 4: Offline status pill toggles when connectivity drops and recovers.
 */

// Type augmentation for the client-side offline helpers exposed by app.js/storage.js.
declare global {
  interface Window {
    __offlineHelpers?: {
      apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
      setOfflineStatus: (isOffline: boolean) => void;
      offlineCacheTarget: (url: string) => { store: string; key: string } | null;
    };
    OfflineStorage?: {
      save: (storeName: string, key: string, data: unknown) => Promise<void>;
      get: (storeName: string, key: string) => Promise<unknown>;
      getAll: (storeName: string) => Promise<Array<{ key: string; data: unknown; savedAt: number }>>;
      remove: (storeName: string, key: string) => Promise<void>;
      clear: (storeName: string) => Promise<void>;
      isSupported: () => boolean;
    };
  }
}

const BASE = 'http://localhost:4000';

const ALEX = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

test.describe('Offline-First PWA, Service Worker & IndexedDB Persistence (FEAT-0151)', () => {

  test.beforeEach(async ({ page }: { page: any }) => {
    // Sprint (EPIC-TEST-STD-0001): /api/devices (src/routes/fleet.ts) is
    // tenant-scoped behind requireAuth, so browsing as a guest never caches
    // store_fleet. Authenticate as the deterministic seeded user so all four
    // IndexedDB stores (games/fleet/deals/hltb) populate during online
    // browsing.
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);
  });

  test('1. Service worker registers and manifest is linked', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/');
    await page.waitForSelector('#page-home');

    // Manifest link must be present and point to /manifest.json
    const manifestHref = await page.evaluate(() => {
      const link = document.querySelector('link[rel="manifest"]');
      return link ? link.getAttribute('href') : null;
    });
    expect(manifestHref).toBe('/manifest.json');

    // Manifest metadata must be valid PWA config
    const manifest = await page.evaluate(async () => {
      const res = await fetch('/manifest.json');
      return res.json();
    });
    expect(manifest.name).toBe('MGPL Dashboard');
    expect(manifest.short_name).toBe('MGPL');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toBe('#0ea5e9');

    // Service worker must register and become active
    await page.waitForFunction(() => {
      return 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;
    }, { timeout: 15000 });

    const swState = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return {
        active: !!reg.active,
        scope: reg.scope,
        controller: !!navigator.serviceWorker.controller,
      };
    });
    expect(swState.active).toBe(true);
    expect(swState.controller).toBe(true);
    expect(swState.scope).toContain('localhost:4000');
  });

  test('2. Online browsing populates IndexedDB offline stores', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/');
    await page.waitForSelector('#page-home');

    // Wait for the offline helper to be exposed and IndexedDB to be supported
    await page.waitForFunction(() => {
      return window.__offlineHelpers && window.OfflineStorage && window.OfflineStorage.isSupported();
    }, { timeout: 15000 });

    // Visit each route that triggers an apiFetch-backed data load so the
    // corresponding IndexedDB store gets populated.
    const routes: Array<[string, string]> = [
      ['#/home', 'store_games'],
      ['#/fleet', 'store_fleet'],
      ['#/deals', 'store_deals'],
      ['#/backlog', 'store_hltb'],
    ];

    for (const [route, store] of routes) {
      await page.goto(`http://localhost:4000/${route}`);
      // Give the lazy-loaded route time to fire its apiFetch and persist.
      await page.waitForTimeout(1500);
    }

    // Verify each store now holds at least one cached record.
    const storeCounts = await page.evaluate(async () => {
      const stores = ['store_games', 'store_fleet', 'store_deals', 'store_hltb'];
      const counts: Record<string, number> = {};
      for (const store of stores) {
        const records = await window.OfflineStorage!.getAll(store);
        counts[store] = records.length;
      }
      return counts;

    });

    expect(storeCounts.store_games).toBeGreaterThan(0);
    expect(storeCounts.store_fleet).toBeGreaterThan(0);
    expect(storeCounts.store_deals).toBeGreaterThan(0);
    expect(storeCounts.store_hltb).toBeGreaterThan(0);
  });

  test('3. Offline simulation renders dashboard views from IndexedDB cache', async ({ page, context }: { page: any, context: any }) => {
    // This test performs a lot of work (populating 4 IndexedDB stores, going
    // offline, then navigating 4 routes from cache). Under full-suite parallel
    // load (6 workers) the default 30s timeout is too tight and causes flaky
    // timeouts. Give it a generous budget.
    test.setTimeout(120000);

    // Populate the cache while online first.
    await page.goto('http://localhost:4000/');

    await page.waitForSelector('#page-home');
    await page.waitForFunction(() => {
      return window.__offlineHelpers && window.OfflineStorage && window.OfflineStorage.isSupported();
    }, { timeout: 15000 });

    const routes: Array<[string, string]> = [
      ['#/home', 'store_games'],
      ['#/fleet', 'store_fleet'],
      ['#/deals', 'store_deals'],
      ['#/backlog', 'store_hltb'],
    ];
    for (const [route] of routes) {
      await page.goto(`http://localhost:4000/${route}`);
      await page.waitForTimeout(1500);
    }

    // Confirm the cache is populated before going offline.
    const preCounts = await page.evaluate(async () => {
      const stores = ['store_games', 'store_fleet', 'store_deals', 'store_hltb'];
      const counts: Record<string, number> = {};
      for (const store of stores) {
        counts[store] = (await window.OfflineStorage!.getAll(store)).length;
      }
      return counts;

    });
    expect(preCounts.store_games).toBeGreaterThan(0);
    expect(preCounts.store_fleet).toBeGreaterThan(0);
    expect(preCounts.store_deals).toBeGreaterThan(0);
    expect(preCounts.store_hltb).toBeGreaterThan(0);

    // Simulate going offline.
    await context.setOffline(true);

    // The offline status pill should become visible. Use a single waitForFunction
    // that verifies BOTH the class state AND that the element actually has layout
    // (non-zero dimensions), which is what Playwright's toBeVisible() checks.
    // This avoids the race between the class swap and the visibility re-check.
    await page.waitForFunction(() => {
      const pill = document.getElementById('offline-status-pill');
      if (!pill) return false;
      const rect = pill.getBoundingClientRect();
      return !pill.classList.contains('hidden')
        && pill.classList.contains('flex')
        && rect.width > 0
        && rect.height > 0;
    }, { timeout: 10000 });



    // Navigate to each route and confirm the view still renders (from cache).
    // NOTE: Offline cache rendering is slower under full-suite load (6 workers).
    // Use expect().toBeVisible() (which auto-waits and correctly handles the
    // visible state) instead of waitForSelector, which can race and time out
    // even when the element is already visible.
    const views: Array<[string, string]> = [
      ['#/home', '#page-home'],
      ['#/fleet', '#page-fleet'],
      ['#/deals', '#page-deals'],
      ['#/backlog', '#page-backlog'],
    ];
    for (const [route, pageSelector] of views) {
      await page.goto(`http://localhost:4000/${route}`);
      await expect(page.locator(pageSelector)).toBeVisible({ timeout: 20000 });
    }

    // The fleet container should render cached device cards (not the empty state).
    await page.goto('http://localhost:4000/#/fleet');
    await expect(page.locator('#page-fleet')).toBeVisible({ timeout: 20000 });
    await page.waitForFunction(() => {
      const container = document.getElementById('fleet-devices-container');
      return container && container.textContent && container.textContent.trim().length > 0;
    }, { timeout: 20000 });

    // The backlog overview should render cached summary numbers.
    await page.goto('http://localhost:4000/#/backlog');
    await expect(page.locator('#page-backlog')).toBeVisible({ timeout: 20000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('backlog-total-games');
      return el && el.textContent && el.textContent.trim() !== '0';
    }, { timeout: 20000 });

    // Restore connectivity for subsequent tests.
    await context.setOffline(false);
  });

  test('4. Offline status pill toggles when connectivity drops and recovers', async ({ page, context }: { page: any, context: any }) => {
    await page.goto('http://localhost:4000/');
    await page.waitForSelector('#page-home');
    await page.waitForFunction(() => {
      return window.__offlineHelpers && window.OfflineStorage && window.OfflineStorage.isSupported();
    }, { timeout: 15000 });

    // Pill should be hidden while online.
    await expect(page.locator('#offline-status-pill')).toHaveClass(/hidden/);

    // Drop connectivity — pill should appear (class-based check avoids the
    // CSS :not(.hidden) selector racing the hidden→flex class swap).
    await context.setOffline(true);
    await page.waitForFunction(() => {
      const pill = document.getElementById('offline-status-pill');
      return pill && !pill.classList.contains('hidden') && pill.classList.contains('flex');
    }, { timeout: 10000 });
    await expect(page.locator('#offline-status-pill')).toBeVisible();
    await expect(page.locator('#offline-status-text')).toContainText('Offline');


    // Restore connectivity — pill should hide again.
    await context.setOffline(false);
    await page.waitForFunction(() => {
      const pill = document.getElementById('offline-status-pill');
      return pill && pill.classList.contains('hidden');
    }, { timeout: 10000 });
    await expect(page.locator('#offline-status-pill')).toHaveClass(/hidden/);
  });

});
