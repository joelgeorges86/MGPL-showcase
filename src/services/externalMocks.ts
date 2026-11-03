import axios, { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";

/**
 * Server-side external API mocks (v5.0.4 Chapter 17.3 / DoD).
 *
 * page.route() only intercepts browser-initiated requests. The Node server
 * makes its own axios calls to CheapShark, GamerPower, Steam Web API, Nexus
 * Mods, and ITAD — those would still hit the live network and cause 429 /
 * timeout flakiness in the E2E suite. This module installs a custom axios
 * adapter (active only when NODE_ENV === 'test') that short-circuits those
 * upstream calls with deterministic payloads, so the suite is fully offline
 * and deterministic.
 *
 * Wired in src/index.ts via installExternalMocks().
 *
 * Sprint 1 (EPIC-DEAL-001): the CheapShark payload includes deterministic
 * canary records (grey-market store, grey-market URL, negative price, and
 * overflow price) so the deals-security spec can assert the ingestion pipeline
 * rejects them. It also exposes a mutable upstream-failure override so the
 * circuit-breaker test can simulate a 500 outage deterministically.
 */

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
  // --- Sprint 1 (EPIC-DEAL-001) canary records (must be rejected) ---
  // Grey-market store: CheapShark storeID 37 -> "Gamivo".
  {
    internalName: "GREYMARKETGAMIVO",
    title: "Grey Market Gamivo Deal",
    salePrice: "4.99",
    normalPrice: "9.99",
    savings: "50.000000",
    storeID: "37",
    gameID: "999001",
    steamAppID: "999001",
    dealID: "mock-gamivo",
    thumb: "",
  },
  // Grey-market URL: valid store name (Fanatical) but phishing/grey-market link.
  {
    internalName: "GREYMARKETURL",
    title: "G2A Phishing Deal",
    salePrice: "3.99",
    normalPrice: "7.99",
    savings: "50.000000",
    storeID: "15",
    gameID: "999002",
    steamAppID: "999002",
    dealID: "mock-g2a-url",
    thumb: "",
    storeUrl: "https://www.g2a.com/phishing-link",
  },
  // Out-of-bounds price: negative.
  {
    internalName: "NEGATIVEPRICE",
    title: "Negative Price Canary",
    salePrice: "-5.00",
    normalPrice: "9.99",
    savings: "0.000000",
    storeID: "15",
    gameID: "999003",
    steamAppID: "999003",
    dealID: "mock-negative",
    thumb: "",
  },
  // Out-of-bounds price: above MAX_PRICE (999.99).
  {
    internalName: "OVERFLOWPRICE",
    title: "Overflow Price Canary",
    salePrice: "1500.00",
    normalPrice: "1599.99",
    savings: "6.000000",
    storeID: "15",
    gameID: "999004",
    steamAppID: "999004",
    dealID: "mock-overflow",
    thumb: "",
  },
];

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

const MOCK_ITAD_DEALS = {
  list: [
    {
      id: "mock-itad-cp2077",
      slug: "cyberpunk-2077",
      title: "Cyberpunk 2077",
      type: "game",
      deal: {
        shop: { name: "Fanatical" },
        price: { amount: 16.49 },
        regular: { amount: 59.99 },
        cut: 72,
        historyLow: { amount: 16.49 },
        url: "https://isthereanydeal.com/game/cyberpunk-2077/",
      },
      assets: { boxart: "", banner300: "" },
    },
    {
      id: "mock-itad-tw3",
      slug: "the-witcher-3-wild-hunt",
      title: "The Witcher 3: Wild Hunt",
      type: "game",
      deal: {
        shop: { name: "GOG" },
        price: { amount: 9.99 },
        regular: { amount: 39.99 },
        cut: 75,
        historyLow: { amount: 9.99 },
        url: "https://isthereanydeal.com/game/the-witcher-3-wild-hunt/",
      },
      assets: { boxart: "", banner300: "" },
    },
  ],
};

const MOCK_STEAM_OWNED_GAMES = {
  response: {
    game_count: 2,
    games: [
      {
        appid: 1091500,
        name: "Cyberpunk 2077",
        playtime_forever: 3600,
        img_icon_url: "",
        img_logo_url: "",
      },
      {
        appid: 292030,
        name: "The Witcher 3: Wild Hunt",
        playtime_forever: 7200,
        img_icon_url: "",
        img_logo_url: "",
      },
    ],
  },
};

const MOCK_NEXUS_GAME = {
  mods: 12000,
  collections: 340,
};

// ---------------------------------------------------------------------------
// Sprint 2 (WUD-2.1 / EPIC-01): fetch-level fixtures for the platform profile
// adapters. The adapters use native fetch through safeFetchJSONWithBackoff, so
// the axios adapter above cannot intercept them — these are served by the
// global fetch mock installed in installFetchMocks(). Titles intentionally
// match the seeded AppGames catalog so persistSyncedProfile() resolves them.
// ---------------------------------------------------------------------------
const MOCK_FETCH_FIXTURES: Array<{ host: string; data: unknown }> = [
  {
    host: "api.steampowered.com",
    data: {
      response: {
        game_count: 4,
        games: [
          {
            appid: 1091500,
            name: "Cyberpunk 2077",
            playtime_forever: 3600,
            rtime_last_played: 1700000000,
            achievements: { total: 44, unlocked: 12 },
          },
          {
            appid: 292030,
            name: "The Witcher 3: Wild Hunt",
            playtime_forever: 7200,
            rtime_last_played: 1690000000,
            achievements: { total: 78, unlocked: 31 },
          },
          {
            appid: 1245620,
            name: "Elden Ring",
            playtime_forever: 2400,
            rtime_last_played: 1680000000,
            achievements: { total: 42, unlocked: 9 },
          },
          {
            appid: 1085660,
            name: "Destiny 2",
            playtime_forever: 1200,
            rtime_last_played: null,
            achievements: { total: 40, unlocked: 4 },
          },
        ],
      },
    },
  },
  {
    host: "xbl.io",
    data: {
      titles: [
        { titleId: "Gears5", name: "Gears 5", minutesPlayed: 900 },
        { titleId: "FH5", name: "Forza Horizon 5", minutesPlayed: 1500 },
      ],
    },
  },
  {
    host: "m.np.playstation.com",
    data: {
      titles: [
        {
          titleId: "UP1004-CUSA00000_00-GODOFWAR",
          name: "God of War",
          playDurationMinutes: 2100,
          trophyCount: 24,
        },
        {
          titleId: "UP9000-CUSA07408_00-HORIZONZERODAWN",
          name: "Horizon Zero Dawn",
          playDurationMinutes: 1800,
          trophyCount: 31,
        },
      ],
    },
  },
  {
    host: "api.epicgames.dev",
    data: {
      titles: [
        { titleId: "Fortnite", name: "Fortnite", playtimeMinutes: 5400 },
        { titleId: "RocketLeague", name: "Rocket League", playtimeMinutes: 2600 },
      ],
    },
  },
  {
    host: "api.gog.com",
    data: {
      items: [
        { id: 1207659165, title: "The Witcher 3: Wild Hunt", playtime: 4800 },
        { id: 1207664653, title: "Cyberpunk 2077", playtime: 3900 },
      ],
    },
  },
  {
    host: "public-ubiservices.ubi.com",
    data: {
      games: [
        {
          gameId: "e3d5ea9d-b6ff-4d33-b0c4-9cf23b3b5822",
          title: "Tom Clancy’s The Division 2",
          playtimeMinutes: 1400,
        },
        {
          gameId: "9d2d0eb4-1c6e-4b4d-b9e5-7b1d95f6cf5f",
          title: "Assassin’s Creed Odyssey",
          playtimeMinutes: 1900,
        },
      ],
    },
  },
  // --- Sprint 2 (WUD-2.2 / EPIC-02): deal-arbitrage source fixtures ---
  {
    host: "isthereanydeal.com",
    data: {
      list: [
        {
          id: "mock-ar-itad-cp2077",
          slug: "cyberpunk-2077",
          title: "Cyberpunk 2077",
          type: "game",
          deal: {
            shop: { name: "Fanatical" },
            price: { amount: 16.49 },
            regular: { amount: 59.99 },
            cut: 72,
            historyLow: { amount: 16.49 },
            url: "https://isthereanydeal.com/game/cyberpunk-2077/",
          },
          assets: { boxart: "", banner300: "" },
        },
        {
          id: "mock-ar-itad-tw3",
          slug: "the-witcher-3-wild-hunt",
          title: "The Witcher 3: Wild Hunt",
          type: "game",
          deal: {
            shop: { name: "GOG" },
            price: { amount: 9.99 },
            regular: { amount: 39.99 },
            cut: 75,
            historyLow: { amount: 9.99 },
            url: "https://isthereanydeal.com/game/the-witcher-3-wild-hunt/",
          },
          assets: { boxart: "", banner300: "" },
        },
      ],
    },
  },
  {
    host: "gg.deals",
    data: {
      deals: [
        {
          id: "mock-ar-gg-hades",
          name: "Hades",
          price: 12.49,
          msrp: 24.99,
          discount: 50,
          lowestPrice: 9.99,
          steamAppId: "1145360",
          shop: { name: "Steam" },
        },
        {
          id: "mock-ar-gg-hollow",
          name: "Hollow Knight",
          price: 7.49,
          msrp: 14.99,
          discount: 50,
          lowestPrice: 5.99,
          steamAppId: "367520",
          shop: { name: "Fanatical" },
        },
        // Canary: grey-market shop must be rejected at ingestion.
        {
          id: "mock-ar-gg-grey",
          name: "Grey Market Canary",
          price: 3.99,
          msrp: 9.99,
          discount: 60,
          shop: { name: "G2A" },
        },
      ],
    },
  },
  {
    host: "dekudeals.com",
    data: {
      deals: [
        {
          id: "mock-ar-deku-celeste",
          name: "Celeste",
          price: 4.99,
          msrp: 19.99,
          discount: 75,
          store: "Steam",
        },
        {
          id: "mock-ar-deku-elden",
          name: "Elden Ring",
          price: 39.99,
          msrp: 59.99,
          discount: 33,
          store: "Gamesplanet",
        },
        // Canary: negative price must be rejected at ingestion.
        {
          id: "mock-ar-deku-neg",
          name: "Negative Price Canary",
          price: -5.0,
          msrp: 9.99,
          discount: 0,
          store: "Steam",
        },
      ],
    },
  },
  // --- Sprint 2 (WUD-2.3 / EPIC-03): ProtonDB compatibility fixture ---
  {
    host: "protondb.com",
    data: {
      best: "Gold",
      score: 0.87,
      confidence: "high",
      tier: "Gold",
      total: 412,
      trendingTier: "Platinum",
    },
  },
];

function fetchFixtureFor(url: string): unknown | undefined {
  for (const f of MOCK_FETCH_FIXTURES) {
    if (url.toLowerCase().includes(f.host)) return f.data;
  }
  return undefined;
}

function jsonFetchResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMockInstalled = false;

/**
 * Install a global fetch mock for the platform adapter domains. Only active
 * when NODE_ENV === 'test'. Known upstream domains resolve to deterministic
 * fixtures; unknown domains throw a network-style error so adapters degrade to
 * their deterministic synthesis fallback exactly as they would against a real
 * outage. Idempotent.
 */
export function installFetchMocks(): void {
  if (process.env.NODE_ENV !== "test") return;
  if (fetchMockInstalled) return;
  fetchMockInstalled = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fixture = url ? fetchFixtureFor(url) : undefined;
    if (fixture !== undefined) return jsonFetchResponse(fixture);
    const err: any = new Error(`[externalMocks] Unmocked fetch upstream: ${url}`);
    err.code = "ECONNABORTED";
    throw err;
  }) as typeof fetch;
  console.log(
    "[externalMocks] NODE_ENV=test — global fetch mocks installed for platform adapters.",
  );
}

function jsonResponse(data: unknown, status = 200): AxiosResponse {
  return {
    data,
    status,
    statusText: status === 200 ? "OK" : "Server Error",
    headers: {},
    config: {} as InternalAxiosRequestConfig,
  };
}

/**
 * Test-only upstream failure overrides. When set, the mock adapter throws an
 * axios-style error (with the configured status attached to `response`) for the
 * matching host so the caller's catch path — and the circuit breaker's failure
 * accounting — trigger exactly as it would against a real 5xx.
 */
const upstreamOverrides = new Map<string, number>();

/** True when the URL targets the given upstream host (suffix-insensitive). */
function urlTargetsHost(url: string, host: string): boolean {
  return url.toLowerCase().includes(host.toLowerCase());
}

/**
 * Deterministic axios adapter. Returns a resolved response for known upstream
 * hosts and rejects with a network-style error for anything unexpected so the
 * caller's existing try/catch fallback paths still exercise cleanly.
 */
const mockAdapter: AxiosAdapter = async (
  config: InternalAxiosRequestConfig,
): Promise<AxiosResponse> => {
  const url = config.url || "";
  const method = (config.method || "get").toLowerCase();

  // Test-only failure simulation takes precedence so the deals-security spec
  // can deterministically trip the CheapShark circuit breaker. We reject (throw)
  // instead of resolving, because axios 1.x applies validateStatus inside the
  // real transport adapter via settle(), which a custom adapter bypasses. A
  // resolved 5xx would therefore never surface as a rejection to the caller.
  for (const [host, status] of upstreamOverrides) {
    if (urlTargetsHost(url, host)) {
      const err: any = new Error(`[externalMocks] Simulated ${status} for ${host}`);
      err.code = "ERR_BAD_RESPONSE";
      err.isAxiosError = true;
      err.response = { status, data: { error: `Mocked ${status} for ${host}` } };
      throw err;
    }
  }

  // CheapShark
  if (url.includes("cheapshark.com")) {
    if (url.includes("/api/1.0/games?")) {
      return jsonResponse({
        info: { title: "Mock Game" },
        cheapestPriceEver: { price: "9.99", date: 1700000000 },
        deals: [],
      });
    }
    return jsonResponse(MOCK_CHEAPSHARK_DEALS);
  }

  // GamerPower
  if (url.includes("gamerpower.com")) {
    return jsonResponse(MOCK_GAMERPOWER_GIVEAWAYS);
  }

  // ITAD
  if (url.includes("isthereanydeal.com")) {
    return jsonResponse(MOCK_ITAD_DEALS);
  }

  // Steam Web API
  if (url.includes("api.steampowered.com")) {
    return jsonResponse(MOCK_STEAM_OWNED_GAMES);
  }

  // Nexus Mods
  if (url.includes("api.nexusmods.com")) {
    return jsonResponse(MOCK_NEXUS_GAME);
  }

  // Unknown upstream: reject so callers fall back to their cache/synthesis path.
  const err: any = new Error(
    `[externalMocks] Unmocked upstream request: ${method.toUpperCase()} ${url}`,
  );
  err.code = "ECONNABORTED";
  err.isAxiosError = true;
  throw err;
};

let installed = false;

/**
 * Install the mock adapter on the shared axios instance. Idempotent — safe to
 * call multiple times. Only takes effect when NODE_ENV === 'test'.
 */
export function installExternalMocks(): void {
  if (process.env.NODE_ENV !== "test") {
    return;
  }
  if (installed) {
    return;
  }
  axios.defaults.adapter = mockAdapter;
  installed = true;
  installFetchMocks();
  console.log("[externalMocks] NODE_ENV=test — server-side external API mocks installed.");
}

/** Simulate an upstream failure for the given host (test mode only). */
export function overrideUpstream(host: string, status: number): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  upstreamOverrides.set(host, status);
  return true;
}

/** Clear the simulated failure for the given host (test mode only). */
export function clearUpstreamOverride(host: string): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  return upstreamOverrides.delete(host);
}

/** Clear all simulated upstream failures (test mode only). */
export function clearAllUpstreamOverrides(): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  upstreamOverrides.clear();
  return true;
}
