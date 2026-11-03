import { test as base, expect, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Shared E2E fixtures (v5.0.4 Chapter 17.3 / DoD).
 *
 * 1. `mockExternalApis` — a page.route() interceptor that stubs the external
 *    storefront APIs (CheapShark, GamerPower) and external asset/avatar hosts
 *    so browser-initiated requests never leave the machine. This complements
 *    the server-side axios mocks (src/services/externalMocks.ts) which cover
 *    the Node-side calls that page.route() cannot intercept.
 *
 * 2. `runAxeScan` — a local accessibility scan built on @axe-core/playwright
 *    (installed as an npm dependency, NOT injected from a CDN). Returns a
 *    normalized { violations, error } shape so existing spec assertions
 *    (`expect(results.error).toBeNull(); expect(results.violations).toEqual([])`)
 *    keep working unchanged.
 */

export const BASE = "http://localhost:4000";

/** Deterministic CheapShark deals payload used by the browser interceptor. */
const MOCK_CHEAPSHARK_DEALS = [
  {
    internalName: "CYBERPUNK2077",
    title: "Cyberpunk 2077",
    salePrice: "16.49",
    normalPrice: "59.99",
    savings: "72.510000",
    storeID: "15",
    gameID: "1091500",
    steamAppID: "1091500",
    dealID: "mock-cp2077",
    thumb: "",
  },
  {
    internalName: "THEWITCHER3WILDHUNT",
    title: "The Witcher 3: Wild Hunt",
    salePrice: "9.99",
    normalPrice: "39.99",
    savings: "75.020000",
    storeID: "7",
    gameID: "292030",
    steamAppID: "292030",
    dealID: "mock-tw3",
    thumb: "",
  },
  {
    internalName: "MONSTERHUNTERWILDS",
    title: "Monster Hunter Wilds",
    salePrice: "54.99",
    normalPrice: "69.99",
    savings: "21.430000",
    storeID: "3",
    gameID: "2246340",
    steamAppID: "2246340",
    dealID: "mock-mhw",
    thumb: "",
  },
];

/** Deterministic GamerPower giveaways payload used by the browser interceptor. */
const MOCK_GAMERPOWER_GIVEAWAYS = [
  {
    id: 1,
    title: "Free Indie Bundle Giveaway",
    worth: "$19.99",
    platforms: "PC",
    open_giveaway_url: "https://www.gamerpower.com/",
    gamerpower_url: "https://www.gamerpower.com/",
    image: "",
    thumbnail: "",
  },
];

/**
 * Intercept external storefront API + asset requests at the browser layer.
 * Call this in a test's beforeEach (or once per test) to guarantee no
 * browser-initiated request escapes to the live network.
 */
export async function mockExternalApis(page: Page): Promise<void> {
  // CheapShark deals + game lookups.
  await page.route("**/api.cheapshark.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/1.0/games?")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          info: { title: "Mock Game" },
          cheapestPriceEver: { price: "9.99", date: 1700000000 },
          deals: [],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CHEAPSHARK_DEALS),
    });
  });

  // GamerPower giveaways.
  await page.route("**/gamerpower.com/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_GAMERPOWER_GIVEAWAYS),
    });
  });

  // External storefront asset/avatar hosts (Steam CDN, PlayStation, etc.).
  await page.route("**/shared.cloudflare.steamstatic.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });
  await page.route("**/store.steampowered.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });
  await page.route("**/store.playstation.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });
  await page.route("**/cdn.akamai.steamstatic.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  });
}

export interface AxeScanResult {
  violations: Array<{ id: string; impact?: string | null; description?: string }>;
  error: string | null;
}


/**
 * Run a local axe-core accessibility scan via @axe-core/playwright.
 * color-contrast is disabled by default to match the existing suite's
 * convention (the custom theme engine intentionally uses low-contrast
 * decorative palettes that are out of scope for the automated audit).
 *
 * `exclude` removes third-party frames/embeds from the audit (e.g. the Retro
 * Hub's lazy-loaded Libretro setup-video iframe), whose empty remote document
 * otherwise trips document-level rules (page-has-main / page-has-heading-one).
 */
export async function runAxeScan(
  page: Page,
  options: {
    selector?: string;
    disableColorContrast?: boolean;
    disableRules?: string[];
    exclude?: string[];
  } = {}
): Promise<AxeScanResult> {
  try {
    const builder = new AxeBuilder({ page });
    if (options.selector) {
      builder.include(options.selector);
    }
    if (options.exclude && options.exclude.length > 0) {
      for (const sel of options.exclude) {
        builder.exclude(sel);
      }
    }
    const disabled: string[] = [];
    if (options.disableColorContrast !== false) {
      disabled.push("color-contrast");
    }
    if (options.disableRules && options.disableRules.length > 0) {
      disabled.push(...options.disableRules);
    }
    if (disabled.length > 0) {
      builder.disableRules(disabled);
    }
    const results = await builder.analyze();
    return { violations: results.violations, error: null };
  } catch (err: any) {
    return { violations: [], error: err?.message || String(err) };
  }
}


/**
 * Extended test fixture. Exposes `mockExternalApis` and `runAxeScan` on the
 * test context so specs can call them without importing the helpers directly.
 *
 * `mockExternalApis` is registered with `{ auto: true }` so every spec that
 * imports `test` from this module gets the CheapShark / GamerPower / asset
 * host route interceptors wired up automatically — no per-test setup call
 * required. The fixture still resolves to the underlying helper function so
 * specs that need to re-arm routes after a `page.goto()` navigation reset can
 * call it explicitly as well.
 */
export const test = base.extend<{
  mockExternalApis: (page: Page) => Promise<void>;
  runAxeScan: (page: Page, options?: { selector?: string; disableColorContrast?: boolean; disableRules?: string[]; exclude?: string[] }) => Promise<AxeScanResult>;
}>({

  mockExternalApis: [
    async ({ page }, use) => {
      await mockExternalApis(page);
      await use(mockExternalApis);
    },
    { auto: true },
  ],
  runAxeScan: async ({}, use) => {
    await use(runAxeScan);
  },
});


export { expect };
