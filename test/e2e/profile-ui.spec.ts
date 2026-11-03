import { test, expect } from "../fixtures";

/**
 * Sprint 4 (EPIC-PROFILE-0001) — Settings Drawer, Profile Customizer & Social Hub.
 *
 * Drives the real SPA shell (public/index.html + auth.js + settings.js) against
 * the seeded test DB to verify the accessible settings drawer end-to-end:
 *
 *   Test 1: Open Settings drawer -> switch tabs -> close via Escape key
 *           (ARIA dialog + ARIA tab/panels + focus restore).
 *   Test 2: Update @gamerTag and switch profileVisibility to "public" via the
 *           UI -> assert the header pill reflects it and the PATCH persisted.
 *   Test 3: Save Steam/PSN/Xbox/GOG platform handles via the UI form -> assert
 *           the success feedback banner and the row persisted.
 *   Test 4: Accept an incoming friend request in the Social tab -> verify the
 *           sender moves from requests into the active friends list.
 *
 * Every user is registered with a unique email + @gamerTag via an API context
 * so the shared deterministic seed dataset is never mutated. Each test owns a
 * fresh browser context (isolated cookie jar) plus its own API context.
 */

const BASE = "http://localhost:4000";

const PROFILE_A = { email: "ui.profile.a@mgpl.test", password: "UIProfilePassA2026!" };
const PROFILE_B = { email: "ui.profile.b@mgpl.test", password: "UIProfilePassB2026!" };
const HANDLE_USER = { email: "ui.handle@mgpl.test", password: "UIHandlePass2026!" };
const SOCIAL_USER_A = { email: "ui.social.a@mgpl.test", password: "UISocialPassA2026!" };
const SOCIAL_USER_B = { email: "ui.social.b@mgpl.test", password: "UISocialPassB2026!" };

async function registerUser(ctx: any, user: { email: string; password: string }): Promise<void> {
  const res = await ctx.post(`${BASE}/api/auth/register`, { data: user });
  expect(res.status()).toBe(201);
}

async function publishProfile(
  ctx: any,
  displayName: string,
  gamerTag: string,
  visibility: "public" | "private" = "public"
): Promise<void> {
  const res = await ctx.patch(`${BASE}/api/user/profile`, {
    data: { displayName, gamerTag, profileVisibility: visibility },
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
  // EPIC-UX-REFINE-0001: "Settings" is now a dropdown group. Open the
  // dropdown, then click the Profile action (which carries data-route="settings"
  // so settings.js's global delegation opens the drawer).
  await page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-trigger').click();
  await expect(page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-menu')).toBeVisible();
  await page.locator('[data-route="settings"]').first().click();
  const drawer = page.locator("#settings-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("role", "dialog");
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await expect(drawer).toHaveAttribute("aria-labelledby", "settings-drawer-title");
}

test.describe("Settings Drawer, Profile Customizer & Social Hub", () => {
  test("1. Open Settings drawer, switch tabs, close via Escape", async ({ page, playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, PROFILE_A);
      await publishProfile(ctx, "UI Profiler A", "UIProfilerA", "private");
      await loginViaUi(page, PROFILE_A.email, PROFILE_A.password);

      // Open the drawer via the top-nav Settings link.
      await openSettingsDrawer(page);
      const drawer = page.locator("#settings-drawer");

      // Default tab is Profile.
      const tabProfile = page.locator("#settings-tab-profile");
      const tabAccounts = page.locator("#settings-tab-accounts");
      const tabSocial = page.locator("#settings-tab-social");
      await expect(tabProfile).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#settings-panel-profile")).toBeVisible();
      await expect(page.locator("#settings-panel-accounts")).toBeHidden();
      await expect(page.locator("#settings-panel-social")).toBeHidden();

      // ARIA tab pattern: tabs point at real tabpanel elements.
      await expect(tabProfile).toHaveAttribute("aria-controls", "settings-panel-profile");
      await expect(tabAccounts).toHaveAttribute("aria-controls", "settings-panel-accounts");
      await expect(tabSocial).toHaveAttribute("aria-controls", "settings-panel-social");
      await expect(page.locator("#settings-panel-profile")).toHaveAttribute("role", "tabpanel");
      await expect(page.locator("#settings-panel-accounts")).toHaveAttribute("role", "tabpanel");
      await expect(page.locator("#settings-panel-social")).toHaveAttribute("role", "tabpanel");

      // Switch to Accounts tab.
      await tabAccounts.click();
      await expect(tabAccounts).toHaveAttribute("aria-selected", "true");
      await expect(tabProfile).toHaveAttribute("aria-selected", "false");
      await expect(page.locator("#settings-panel-accounts")).toBeVisible();
      await expect(page.locator("#settings-panel-profile")).toBeHidden();
      // Platform handle inputs are rehydrated from the DB.
      await expect(page.locator("#handle-steam")).toBeVisible();

      // Switch to Social tab.
      await tabSocial.click();
      await expect(tabSocial).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#settings-panel-social")).toBeVisible();
      await expect(page.locator("#settings-panel-accounts")).toBeHidden();

      // Escape closes the drawer and restores focus to the dropdown trigger
      // that opened it (the Profile action is a hidden dropdown item).
      const settingsTrigger = page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-trigger');
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(settingsTrigger).toBeFocused();
    } finally {
      await ctx.dispose();
    }
  });

  test("2. Update @gamerTag + visibility public via UI, header reflects and persists", async ({
    page,
    playwright,
  }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, PROFILE_B);
      // Start private so we prove the public switch is user-initiated.
      await publishProfile(ctx, "UI Profiler B", "UIProfilerB", "private");
      await loginViaUi(page, PROFILE_B.email, PROFILE_B.password);

      // Open the drawer via the user pill (Acceptance Criterion 1).
      await page.locator("#auth-user-pill").click();
      const drawer = page.locator("#settings-drawer");
      await expect(drawer).toBeVisible();

      // Change the @gamerTag and flip visibility to Public.
      const gamerTagInput = page.locator("#settings-gamertag");
      await expect(gamerTagInput).toHaveValue("UIProfilerB");
      await gamerTagInput.fill("@UIProfilerUpdated");

      // Flip the visibility toggle. The radio is sr-only inside a styled
      // label, so click the label (real-user interaction) and assert the
      // hidden input received the selection.
      await page.locator('label:has(#settings-visibility-public)').click();
      await expect(page.locator("#settings-visibility-public")).toBeChecked();

      await page.locator("#settings-profile-save").click();

      // Success feedback + header pill reflection.
      const banner = page.locator("#settings-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveText(/Profile saved successfully/i);
      // After the PATCH, auth.js reloads the profile -> @gamerTag appears in pill.
      await expect(page.locator("#auth-gamertag")).toHaveText("@UIProfilerUpdated");
      await expect(banner).toBeHidden({ timeout: 6000 }); // auto-dismiss banner

      // Persistence via the backend (DB-authoritative rehydrate). The API
      // context registered this user, so its session cookie reads the same
      // profile row the UI just updated.
      const profileRes = await ctx.get(`${BASE}/api/user/profile`);
      expect(profileRes.status()).toBe(200);
      const profile = (await profileRes.json()).profile;
      expect(profile.gamerTag).toBe("@UIProfilerUpdated");
      expect(profile.profileVisibility).toBe("public");
      expect(profile.displayName).toBe("UI Profiler B");
    } finally {
      await ctx.dispose();
    }
  });

  test("3. Save platform handles via UI form and see success banner", async ({ page, playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await registerUser(ctx, HANDLE_USER);
      await publishProfile(ctx, "UI Handle User", "UIHandleUser", "public");
      await loginViaUi(page, HANDLE_USER.email, HANDLE_USER.password);

      await page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-trigger').click();
      await page.locator('[data-route="settings"]').first().click();
      await page.locator("#settings-tab-accounts").click();
      await expect(page.locator("#settings-panel-accounts")).toBeVisible();

      // The form rehydrates empty handles from the DB first.
      await expect(page.locator("#handle-steam")).toHaveValue("");

      await page.locator("#handle-steam").fill("UISteamHandle");
      await page.locator("#handle-psn").fill("UIPsnId");
      await page.locator("#handle-xbox").fill("UIXboxTag");
      await page.locator("#handle-gog").fill("UIGogName");
      await page.locator("#settings-handles-save").click();

      // Success feedback banner (Acceptance Criterion 3).
      const banner = page.locator("#settings-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveText(/Platform handles saved successfully/i);

      // Persistence via the new GET /api/user/platform-handles endpoint.
      const handlesRes = await ctx.get(`${BASE}/api/user/platform-handles`);
      expect(handlesRes.status()).toBe(200);
      const handles = (await handlesRes.json()).platformHandles;
      expect(handles.steamUsername).toBe("UISteamHandle");
      expect(handles.psnId).toBe("UIPsnId");
      expect(handles.xboxGamertag).toBe("UIXboxTag");
      expect(handles.gogUsername).toBe("UIGogName");
    } finally {
      await ctx.dispose();
    }
  });

  test("4. Accept an incoming friend request in Social tab and verify it moves to friends", async ({
    page,
    playwright,
  }) => {
    const ctxA = await playwright.request.newContext();
    const ctxB = await playwright.request.newContext();
    try {
      // User A (UI operator) needs a public @gamerTag so B can address the request.
      await registerUser(ctxA, SOCIAL_USER_A);
      await publishProfile(ctxA, "UI Social User A", "UISocialUserA", "public");

      // User B (API-only counterpart) publishes and sends A a friend request.
      await registerUser(ctxB, SOCIAL_USER_B);
      await publishProfile(ctxB, "UI Social User B", "UISocialUserB", "public");
      const sendRes = await ctxB.post(`${BASE}/api/social/request`, {
        data: { gamerTag: "UISocialUserA" },
      });
      expect(sendRes.status()).toBe(201);

      // User A logs in via UI and opens the Social tab.
      await loginViaUi(page, SOCIAL_USER_A.email, SOCIAL_USER_A.password);
      await page.locator('.nav-dropdown[data-nav-group="settings"] .nav-dropdown-trigger').click();
      await page.locator('[data-route="settings"]').first().click();
      await page.locator("#settings-tab-social").click();
      await expect(page.locator("#settings-panel-social")).toBeVisible();

      // Incoming request rendered with the sender's privacy-minimized card.
      const requestCard = page.locator("#settings-social-requests .btn-accept-request");
      await expect(requestCard).toBeVisible();
      await expect(page.locator("#settings-social-requests")).toContainText("UI Social User B");
      await expect(page.locator("#settings-social-requests")).toContainText("@UISocialUserB");
      // Active friends list should NOT contain B yet.
      await expect(page.locator("#settings-social-friends")).not.toContainText("UI Social User B");

      // Accept the request.
      await requestCard.click();

      // The sender moves out of requests and into the active friends list.
      await expect(page.locator("#settings-social-requests")).not.toContainText("UI Social User B");
      await expect(page.locator("#settings-social-requests .btn-accept-request")).toHaveCount(0);
      const friendCard = page.locator("#settings-social-friends");
      await expect(friendCard).toContainText("UI Social User B");
      await expect(friendCard).toContainText("@UISocialUserB");

      // Backend confirms the bidirectional friendship (single canonical row).
      const friendsRes = await ctxA.get(`${BASE}/api/social/friends`);
      expect(friendsRes.status()).toBe(200);
      const friends = (await friendsRes.json()).friends;
      const bFromA = friends.find((f: any) => f.gamerTag === "UISocialUserB");
      expect(bFromA).toBeTruthy();
      // privacy-minimized card contract.
      expect("email" in bFromA).toBe(false);
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });
});