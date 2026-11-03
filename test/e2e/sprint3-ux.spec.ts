import { test, expect } from "../fixtures";

/**
 * Sprint 3 (WUD-3.1 / EPICUX01, WUD-3.2 / EPICUX02 + EPICEOT04,
 * WUD-3.3 / EPICUX03 + EPICEOT03) — UX Foundations: Navigation & IA,
 * Game Discovery 2.0, and Gamer Profile Foundations & Privacy.
 *
 * Drives the real SPA shell (public/index.html + app.js + discovery.js +
 * profile-dashboard.js + palette.js) against the seeded test DB:
 *
 *   Test 1: Desktop left rail is visible at lg+, navigates routes, and marks
 *           the active destination with aria-current="page".
 *   Test 2: The left-rail search control and Ctrl+K open the command palette.
 *   Test 3: Mobile bottom tab bar (5 tabs) + search FAB render on small
 *           viewports while the desktop rail stays hidden.
 *   Test 4: Discovery mood selector -> "Generate my rails" builds personalized
 *           recommendation rails via POST /api/discovery/rails.
 *   Test 5: "Surprise Me" renders a single seeded pick.
 *   Test 6: Profile dashboard renders identity, local privacy dashboard,
 *           summary stats, achievement showcase and play-history timeline.
 *   Test 7: profileVisibility: 'private' enforcement — public @gamerTag lookup
 *           returns 404 until the profile is made public (privacy-minimized either way).
 *
 * Every user is registered with a unique email + @gamerTag via an API context
 * so the shared deterministic seed dataset is never mutated.
 */

const BASE = "http://localhost:4000";

const UX_PROFILE_USER = { email: "ux.profile@mgpl.test", password: "UXProfilePass2026!" };
const UX_PROFILE_USER_2 = { email: "ux.profile.two@mgpl.test", password: "UXProfilePass2026!" };

async function registerUser(ctx: any, user: { email: string; password: string }): Promise<void> {
  const res = await ctx.post(`${BASE}/api/auth/register`, { data: user });
  expect(res.status()).toBe(201);
}

async function patchProfile(
  ctx: any,
  data: { displayName?: string; gamerTag?: string; profileVisibility?: string }
): Promise<void> {
  const res = await ctx.patch(`${BASE}/api/user/profile`, { data });
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

/**
 * The granular storage consent banner (fixed bottom, z-[55]) intercepts pointer
 * events over the bottom tab bar / left-rail footer on first visit. Dismiss it
 * up front (established pattern from legal-compliance.spec.ts).
 */
async function dismissConsent(page: any): Promise<void> {
  const banner = page.locator("#consent-banner");
  if (await banner.isVisible()) {
    await page.locator("#consent-reject-nonessential").click();
    await expect(banner).toBeHidden();
  }
}

test.describe("Sprint 3 (WUD-3.1 / EPICUX01) — Unified Navigation & IA", () => {
  test.beforeEach(async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    await dismissConsent(page);
  });

  test("1. Desktop left rail is visible, navigates routes, and sets aria-current", async ({ page }: { page: any }) => {
    const rail = page.locator("#desktop-rail");
    // lg+ viewport (default 1280x720) shows the rail; mobile tab bar is hidden.
    await expect(rail).toBeVisible();
    await expect(page.locator("nav.fixed.bottom-0.md\\:hidden")).toBeHidden();

    // Click the Library rail destination.
    await rail.locator('a[data-route="library"]').click();
    await expect(page.locator("#page-library")).toBeVisible();
    await expect(page).toHaveURL(/#\/library/);

    // The active rail link is highlighted and announced to AT.
    await expect(rail.locator('a[data-route="library"]')).toHaveAttribute("aria-current", "page");
    await expect(rail.locator('a[data-route="home"]')).not.toHaveAttribute("aria-current", "page");
  });

  test("2. Left-rail search control and Ctrl+K open the command palette", async ({ page }: { page: any }) => {
    const palette = page.locator("#command-palette");
    await expect(palette).toBeHidden();

    // Left-rail search button (WUD-3.1 persistent search affordance).
    await page.locator("#rail-search-fab").click();
    await expect(palette).toBeVisible();
    await expect(page.locator("#command-palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // Global Ctrl+K shortcut still works.
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible();
  });

  test("3. Mobile bottom tab bar + search FAB render on small viewports", async ({ page }: { page: any }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#page-home");
    await dismissConsent(page);

    // Desktop rail hidden; bottom tab bar visible with five destinations.
    await expect(page.locator("#desktop-rail")).toBeHidden();
    const tabBar = page.locator("nav.fixed.bottom-0.md\\:hidden");
    await expect(tabBar).toBeVisible();
    await expect(tabBar.locator("#mobile-nav-hero")).toBeVisible();
    await expect(tabBar.locator("#mobile-nav-library")).toBeVisible();
    await expect(tabBar.locator("#mobile-nav-profile")).toBeVisible();

    // The Profile tab navigates to the profile route.
    await tabBar.locator("#mobile-nav-profile").click();
    await expect(page.locator("#page-profile")).toBeVisible();

    // Search FAB opens the command palette from mobile.
    const fab = page.locator("#search-fab");
    await expect(fab).toBeVisible();
    await fab.click();
    await expect(page.locator("#command-palette")).toBeVisible();
  });
});

test.describe("Sprint 3 (WUD-3.2 / EPICUX02) — Game Discovery 2.0", () => {
  test.beforeEach(async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/discovery`);
    await page.waitForSelector("#page-discovery");
    await dismissConsent(page);
  });

  test("4. Mood selector builds personalized recommendation rails", async ({ page }: { page: any }) => {
    const moodButtons = page.locator(".discovery-mood-btn");
    await expect(moodButtons).toHaveCount(5);

    // Default selection is deterministic (cozy).
    await expect(page.locator('.discovery-mood-btn[data-mood="cozy"]')).toHaveAttribute("aria-pressed", "true");

    // Selecting a mood is a UI-only action (no recompute) until the explicit
    // "Generate my rails" action fires.
    await page.locator('.discovery-mood-btn[data-mood="story"]').click();
    await expect(page.locator('.discovery-mood-btn[data-mood="story"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.discovery-mood-btn[data-mood="cozy"]')).toHaveAttribute("aria-pressed", "false");

    await page.locator("#btn-build-rails").click();
    // Rails render with at least one rail and the moodPicks rail present.
    await expect(page.locator("#discovery-rails [data-rail-id]").first()).toBeVisible();
    await expect(page.locator('#discovery-rails [data-rail-id="moodPicks"]')).toBeVisible();
    // Unified game card contract: every rail card deep-links to #/game/:id.
    await expect(page.locator("#discovery-rails a[data-game-id]").first()).toBeVisible();
  });

  test("5. Surprise Me renders a single seeded pick", async ({ page }: { page: any }) => {
    const surprise = page.locator("#discovery-surprise");
    await expect(surprise).toBeHidden();

    await page.locator("#btn-surprise-me").click();
    await expect(surprise).toBeVisible();
    const card = surprise.locator("a[data-game-id]").first();
    await expect(card).toBeVisible();
    // The pick is a real seeded title.
    await expect(surprise).toContainText(/Seed \d+/i);
  });
});

test.describe("Sprint 3 (WUD-3.3 / EPICUX03 + EPICEOT03) — Profile Foundations & Privacy", () => {
  test("6. Profile dashboard renders identity, privacy, achievements and play history", async ({ page, playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, UX_PROFILE_USER);
      await patchProfile(ctx, {
        displayName: "UX Tester",
        gamerTag: "UxTester",
        profileVisibility: "private",
      });

      await loginViaUi(page, UX_PROFILE_USER.email, UX_PROFILE_USER.password);
      await page.goto(`${BASE}/#/profile`);
      await page.waitForSelector("#page-profile");
      await dismissConsent(page);

      // Identity header (avatar fallback + display name + private badge).
      await expect(page.locator("#profile-dashboard-root")).toContainText("UX Tester");
      await expect(page.locator("#profile-dashboard-root")).toContainText("@UxTester");
      await expect(page.locator("#profile-dashboard-root")).toContainText("Private");

      // Local privacy dashboard (WUD-3.3 privacy integration).
      const privacy = page.locator('[data-testid="privacy-dashboard"]');
      await expect(privacy).toBeVisible();
      await expect(privacy).toContainText("Local Privacy Dashboard");
      await expect(privacy).toContainText(/Private — only you can see this profile/);

      // Summary stats.
      await expect(page.locator('[data-testid="profile-summary"]')).toContainText("Total Hours");

      // Achievement showcase (seeded completed titles qualify).
      const showcase = page.locator('[data-testid="achievement-showcase"]');
      await expect(showcase).toBeVisible();
      await expect(showcase).toContainText("The Witcher 3");

      // Play-history timeline (seeded AppTracking rows, newest first).
      const timeline = page.locator('[data-testid="play-history"]');
      await expect(timeline).toBeVisible();
      await expect(timeline).toContainText("Cyberpunk 2077");
    } finally {
      await ctx.dispose();
    }
  });

  test("7. profileVisibility 'private' enforcement — public lookup 404 until made public", async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, UX_PROFILE_USER_2);
      await patchProfile(ctx, { displayName: "UX Tester", gamerTag: "UxTesterTwo", profileVisibility: "private" });

      // Private default: anonymous public lookup returns 404 (no enumeration).
      const anon = await playwright.request.newContext();
      try {
        const hidden = await anon.get(`${BASE}/api/user/u/UxTesterTwo`);
        expect(hidden.status()).toBe(404);
      } finally {
        await anon.dispose();
      }

      // Publish the profile, then the same lookup succeeds with privacy-minimized.
      await patchProfile(ctx, { profileVisibility: "public" });
      const visible = await ctx.get(`${BASE}/api/user/u/UxTesterTwo`);
      expect(visible.status()).toBe(200);
      const body = await visible.json();
      expect(body.displayName).toBe("UX Tester");
      expect(body.gamerTag).toBe("UxTesterTwo");
      // privacy-minimized contract: email is never exposed on the public profile.
      expect("email" in body).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});
