import { test, expect } from "../fixtures";
import Database from "better-sqlite3";
import path from "path";

/**
 * Sprint 2 (WUD-2.1 / EPIC-01) — Unified Cross-Platform Profile Sync Adapters.
 *
 * Drives the real SPA shell + the /api/profile-sync routes against the seeded
 * test DB to verify:
 *
 *   Test 1: Connecting a platform stores the token ENCRYPTED at rest in the
 *           AuthPlatformLinks WAL table (tokenEnc != plaintext) and returns a
 *           masked display handle that never leaks the raw public ID.
 *   Test 2: POST /api/profile-sync/sync runs the Steam adapter (hermetic fetch
 *           mock) and persists playtime into AppTracking for matched titles.
 *   Test 3 (VBAC): User navigates Settings -> Connected Accounts -> clicks
 *           "Connect Steam" -> enters public ID/token -> state flips to
 *           "Connected" with a masked display handle.
 *   Test 4 (VBAC): Toggling "Hide Platform IDs" immediately masks handles on
 *           the public profile view (/api/user/u/:gamerTag).
 *
 * Every test registers a unique user so the shared deterministic seed is never
 * mutated, and cleans up its platform link at the end.
 */

const BASE = "http://localhost:4000";
const TEST_DB_PATH = path.resolve(process.cwd(), "data", "test_mgpl.db");

const SYNC_USER_A = { email: "sync.a@mgpl.test", password: "SyncPassA2026!" };
const SYNC_USER_B = { email: "sync.b@mgpl.test", password: "SyncPassB2026!" };
const SYNC_USER_C = { email: "sync.c@mgpl.test", password: "SyncPassC2026!" };
const SYNC_USER_D = { email: "sync.d@mgpl.test", password: "SyncPassD2026!" };

async function registerUser(ctx: any, user: { email: string; password: string }): Promise<void> {
  const res = await ctx.post(`${BASE}/api/auth/register`, { data: user });
  expect(res.status()).toBe(201);
}

async function publishProfile(
  ctx: any,
  gamerTag: string,
  visibility: "public" | "private" = "public",
): Promise<void> {
  const res = await ctx.patch(`${BASE}/api/user/profile`, {
    data: { gamerTag, profileVisibility: visibility },
  });
  expect(res.status()).toBe(200);
}

async function loginViaUi(page: any, email: string, password: string): Promise<void> {
  await page.goto("/");
  const loginBtn = page.locator("#btn-auth-open-login");
  await expect(loginBtn).toBeVisible();
  await loginBtn.click();
  const modal = page.locator("#auth-modal");
  await expect(modal).toBeVisible();
  await page.locator("#auth-login-email").fill(email);
  await page.locator("#auth-login-password").fill(password);
  await page.locator('#auth-login-form button[type="submit"]').click();
  await expect(modal).toBeHidden();
  await expect(page.locator("#auth-user-pill")).toBeVisible();
}

async function openSettingsDrawer(page: any): Promise<void> {
  await page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-trigger').click();
  await expect(page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-menu')).toBeVisible();
  await page.locator('[data-route="settings"]').first().click();
  await expect(page.locator("#settings-drawer")).toBeVisible();
}

function readAuthRow<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

test.describe("Unified Cross-Platform Profile Sync (WUD-2.1 / EPIC-01)", () => {
  test("1. Connect stores an encrypted token at rest and returns a masked handle", async ({
    playwright,
  }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, SYNC_USER_A);

      const connectRes = await ctx.post(`${BASE}/api/profile-sync/connect`, {
        data: { platform: "steam", publicId: "76561198000000001", token: "steam-local-token-abc" },
      });
      expect(connectRes.status()).toBe(200);
      const body = await connectRes.json();
      expect(body.success).toBe(true);
      expect(body.connected.platform).toBe("steam");
      expect(body.connected.connected).toBe(true);
      // The masked handle must never contain the raw public ID.
      expect(body.connected.displayHandle).toContain("•");
      expect(body.connected.displayHandle).not.toContain("76561198000000001");

      // The token is stored encrypted at rest — never as plaintext.
      const link = readAuthRow<{ platform: string; publicId: string; tokenEnc: string; tokenIv: string }>(
        "SELECT platform, publicId, tokenEnc, tokenIv FROM AuthPlatformLinks WHERE platform = 'steam' AND publicId = ? ORDER BY connectedAt DESC LIMIT 1",
        "76561198000000001",
      );
      expect(link).toBeTruthy();
      expect(link!.platform).toBe("steam");
      expect(link!.publicId).toBe("76561198000000001");
      expect(link!.tokenEnc).toBeTruthy();
      expect(link!.tokenIv).toBeTruthy();
      expect(link!.tokenEnc).not.toContain("steam-local-token-abc");

      // /platforms lists the connection with a masked handle only.
      const platformsRes = await ctx.get(`${BASE}/api/profile-sync/platforms`);
      expect(platformsRes.status()).toBe(200);
      const platforms = await platformsRes.json();
      expect(platforms.encryptionConfigured).toBe(true);
      const steam = platforms.platforms.find((p: any) => p.platform === "steam");
      expect(steam).toBeTruthy();
      expect(steam.connected).toBe(true);
      expect(steam.displayHandle).toContain("•");
      expect(steam.displayHandle).not.toContain("76561198000000001");

      const disconnectRes = await ctx.post(`${BASE}/api/profile-sync/disconnect`, {
        data: { platform: "steam" },
      });
      expect(disconnectRes.status()).toBe(200);
      expect((await disconnectRes.json()).wasConnected).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("2. Sync runs the Steam adapter and persists playtime into AppTracking", async ({
    playwright,
  }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, SYNC_USER_B);
      const connectRes = await ctx.post(`${BASE}/api/profile-sync/connect`, {
        data: { platform: "steam", publicId: "76561198000000003", token: "steam-sync-token-def" },
      });
      expect(connectRes.status()).toBe(200);

      const syncRes = await ctx.post(`${BASE}/api/profile-sync/sync`, {
        data: { platform: "steam" },
      });
      expect(syncRes.status()).toBe(200);
      const syncBody = await syncRes.json();
      expect(syncBody.success).toBe(true);
      expect(syncBody.syncedGames).toBeGreaterThanOrEqual(3);
      expect(syncBody.summary.totalPlaytimeMinutes).toBeGreaterThan(0);
      expect(syncBody.summary.achievements).toBeGreaterThan(0);

      // The Steam fixture reports Cyberpunk 2077 (gameId cyberpunk-2077) with
      // 3600 minutes => 60 hours persisted into AppTracking.
      const tracking = readAuthRow<{ hours: number | null }>(
        'SELECT "Hours Played" AS hours FROM "AppTracking" WHERE "GameID" = ?',
        "cyberpunk-2077",
      );
      expect(tracking).toBeTruthy();
      expect(tracking!.hours).not.toBeNull();
      expect(Number(tracking!.hours)).toBeGreaterThanOrEqual(60);

      await ctx.post(`${BASE}/api/profile-sync/disconnect`, { data: { platform: "steam" } });
    } finally {
      await ctx.dispose();
    }
  });

  test("3. UI: Connect Steam -> state updates to Connected with masked handle", async ({
    page,
    playwright,
  }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, SYNC_USER_C);
      await loginViaUi(page, SYNC_USER_C.email, SYNC_USER_C.password);
      await openSettingsDrawer(page);

      await page.locator("#settings-tab-accounts").click();
      await expect(page.locator("#settings-panel-accounts")).toBeVisible();
      const syncPanel = page.locator("#settings-profile-sync");
      await expect(syncPanel).toBeVisible();

      const steamRow = syncPanel.locator('[data-sync-row][data-sync-platform="steam"]');
      await expect(steamRow).toBeVisible();
      await expect(steamRow.locator("[data-sync-disconnected]")).toBeVisible();

      // Click Connect Steam, fill the public ID + token, submit.
      await steamRow.locator('[data-sync-action="connect"]').click();
      await expect(syncPanel.locator("[data-connect-form]")).toBeVisible();
      await syncPanel.locator("[data-connect-publicid]").fill("76561198000000005");
      await syncPanel.locator("[data-connect-token]").fill("steam-ui-token-xyz");
      await syncPanel.locator("[data-connect-submit]").click();

      // State flips to Connected with a masked handle.
      await expect(steamRow.locator("[data-sync-connected]")).toBeVisible({ timeout: 10000 });
      const handleEl = steamRow.locator("[data-sync-handle]");
      await expect(handleEl).toBeVisible();
      const handleText = (await handleEl.textContent()) || "";
      expect(handleText).toContain("•");
      expect(handleText).not.toContain("76561198000000005");

      // Cleanup via API so the next run starts clean.
      const cleanup = await playwright.request.newContext();
      try {
        await cleanup.post(`${BASE}/api/auth/login`, {
          data: { email: SYNC_USER_C.email, password: SYNC_USER_C.password },
        });
        await cleanup.post(`${BASE}/api/profile-sync/disconnect`, { data: { platform: "steam" } });
      } finally {
        await cleanup.dispose();
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("4. Hide Platform IDs masks handles across public profile views", async ({
    playwright,
  }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, SYNC_USER_D);
      await publishProfile(ctx, "SyncUserD", "public");
      await ctx.post(`${BASE}/api/profile-sync/connect`, {
        data: { platform: "steam", publicId: "76561198000000009", token: "steam-vis-token-xyz" },
      });

      // Before hiding: the public profile shows the raw public handle.
      let publicRes = await ctx.get(`${BASE}/api/user/u/SyncUserD`);
      expect(publicRes.status()).toBe(200);
      let publicBody = await publicRes.json();
      expect(publicBody.platformHandles.steamUsername).toBe("76561198000000009");

      // Toggle Hide Platform IDs on -> the public profile is masked instantly.
      const hideRes = await ctx.post(`${BASE}/api/profile-sync/visibility`, {
        data: { hidePlatformIds: true },
      });
      expect(hideRes.status()).toBe(200);
      publicRes = await ctx.get(`${BASE}/api/user/u/SyncUserD`);
      publicBody = await publicRes.json();
      expect(publicBody.platformHandles.steamUsername).toContain("•");
      expect(publicBody.platformHandles.steamUsername).not.toContain("76561198000000009");

      // Toggle off -> the raw handle returns (state is server-authoritative).
      const showRes = await ctx.post(`${BASE}/api/profile-sync/visibility`, {
        data: { hidePlatformIds: false },
      });
      expect(showRes.status()).toBe(200);
      publicRes = await ctx.get(`${BASE}/api/user/u/SyncUserD`);
      publicBody = await publicRes.json();
      expect(publicBody.platformHandles.steamUsername).toBe("76561198000000009");

      await ctx.post(`${BASE}/api/profile-sync/disconnect`, { data: { platform: "steam" } });
    } finally {
      await ctx.dispose();
    }
  });
});



