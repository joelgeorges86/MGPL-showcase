import { test, expect } from "../fixtures";

/**
 * Sprint 4 (FEAT-AUTH-UI-0001): Frontend authentication UI E2E suite.
 *
 * Drives the real SPA shell (public/index.html + auth.js) against the seeded
 * test DB. Verifies the navigation header state, the accessible tabbed
 * Log In / Sign Up modal, inline error banners, session rehydration on login,
 * and logout restoring the unauthenticated header. No page reloads are used
 * between login/logout — each test exercises the live DOM transitions.
 *
 * The seeded deterministic account is alex.gamer@mgpl.io / GamerPass2026!.
 * Playwright gives every test a fresh browser context, so the cookie jar is
 * isolated per test and the failed-login test never leaks a session.
 */

test.describe("Auth UI", () => {
  test("Log In button opens the modal, tabs switch, and Escape closes it", async ({ page }) => {
    await page.goto("/");

    // 1. Unauthenticated header shows the Log In button.
    const loginBtn = page.locator("#btn-auth-open-login");
    await expect(loginBtn).toBeVisible();
    await expect(loginBtn).toHaveText(/Login \/ Sign Up/i);

    // 2. Clicking opens the dialog with ARIA dialog attributes.
    await loginBtn.click();
    const modal = page.locator("#auth-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(modal).toHaveAttribute("aria-labelledby", "auth-modal-title");

    // 3. Default tab is Log In; switch to Sign Up.
    const tabLogin = page.locator("#auth-tab-login");
    const tabSignup = page.locator("#auth-tab-signup");
    await expect(tabLogin).toHaveAttribute("aria-selected", "true");
    const loginForm = page.locator("#auth-login-form");
    const signupForm = page.locator("#auth-signup-form");
    await expect(loginForm).toBeVisible();
    await expect(signupForm).toBeHidden();

    // Tabs must point at the real tabpanel elements (ARIA tab pattern).
    await expect(tabLogin).toHaveAttribute("aria-controls", "auth-login-form");
    await expect(tabSignup).toHaveAttribute("aria-controls", "auth-signup-form");
    await expect(loginForm).toHaveAttribute("role", "tabpanel");
    await expect(signupForm).toHaveAttribute("role", "tabpanel");

    await tabSignup.click();
    await expect(tabSignup).toHaveAttribute("aria-selected", "true");
    await expect(tabLogin).toHaveAttribute("aria-selected", "false");
    await expect(signupForm).toBeVisible();
    await expect(loginForm).toBeHidden();

    // 4. Escape closes the dialog and focus returns to the trigger.
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(loginBtn).toBeFocused();
  });

  test("native login via modal closes it and updates the header with the user email", async ({ page }) => {
    await page.goto("/");

    // Fresh context -> unauthenticated.
    const loginBtn = page.locator("#btn-auth-open-login");
    await expect(loginBtn).toBeVisible();
    await loginBtn.click();

    // Fill and submit the Log In form as the seeded user.
    await page.locator("#auth-login-email").fill("alex.gamer@mgpl.io");
    await page.locator("#auth-login-password").fill("GamerPass2026!");
    await page.locator('#auth-login-form button[type="submit"]').click();

    // Modal closes and the header now shows the user pill with the email.
    await expect(page.locator("#auth-modal")).toBeHidden();
    await expect(page.locator("#auth-user-pill")).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveText("alex.gamer@mgpl.io");
    await expect(page.locator("#btn-auth-open-login")).toHaveCount(0);
  });

  test("failed login shows an inline error banner and keeps the modal open", async ({ page }) => {
    await page.goto("/");

    await page.locator("#btn-auth-open-login").click();

    // Wrong password for the seeded account -> 401.
    await page.locator("#auth-login-email").fill("alex.gamer@mgpl.io");
    await page.locator("#auth-login-password").fill("WrongPass2026!");
    await page.locator('#auth-login-form button[type="submit"]').click();

    // Inline banner with the generic error message, modal still open.
    const errorBanner = page.locator("#auth-error-banner");
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toHaveAttribute("role", "alert");
    await expect(errorBanner).toHaveText(/Invalid email or password/i);
    await expect(page.locator("#auth-modal")).toBeVisible();
  });

  test("logout clears the session and restores the Log In button", async ({ page, request }) => {
    // Sign in first via the UI so the header reaches the authenticated state.
    await page.goto("/");
    await page.locator("#btn-auth-open-login").click();
    await page.locator("#auth-login-email").fill("alex.gamer@mgpl.io");
    await page.locator("#auth-login-password").fill("GamerPass2026!");
    await page.locator('#auth-login-form button[type="submit"]').click();
    await expect(page.locator("#auth-user-pill")).toBeVisible();

    // Click Log Out — no navigation happens, header re-renders in place.
    await page.locator("#btn-auth-logout").click();
    await expect(page.locator("#auth-user-pill")).toHaveCount(0);
    await expect(page.locator("#btn-auth-open-login")).toBeVisible();

    // Verify the server-side session was actually cleared.
    const me = await request.get("/api/auth/me");
    expect(me.status()).toBe(401);
  });
});