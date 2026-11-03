import { test, expect } from "../fixtures";

const BASE = "http://localhost:4000";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
// The seeded id of ALEX (test/global-setup.ts).
const ALEX_ID = "auth-user-alex-gamer";

const CONSENT_KEY = "mgpl_consent_settings";

function readConsent(page: any) {
  return page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, CONSENT_KEY);
}

/**
 * Sprint 2 (EPIC-COMPLIANCE-0001) — Global Privacy (GDPR/CCPA/LGPD),
 * GPC Listener & Granular Storage Consent.
 *
 * Test 1: The consent banner renders on a fresh visit (no stored preference);
 *         clicking "Reject Non-Essential" stores strict-only flags and
 *         dismisses the banner.
 * Test 2: GPC flag detection enforces the opt-out automatically (analytics is
 *         forced off and the status is reflected in the UI).
 * Test 3: "Export My Data" initiates a valid JSON payload download.
 * Test 4: Reopening the consent manager from the footer updates stored
 *         preferences.
 */
test.describe("EPIC-COMPLIANCE-0001 Sprint 2 - Privacy, GPC & Consent", () => {
  test("1. Consent banner renders on fresh visit; Reject Non-Essential stores strict-only flags", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#consent-banner");

    // Banner should be visible on a fresh visit with no stored preference.
    await expect(page.locator("#consent-banner")).toBeVisible();
    await expect(page.locator("#consent-accept-all")).toBeVisible();
    await expect(page.locator("#consent-reject-nonessential")).toBeVisible();
    await expect(page.locator("#consent-open-preferences")).toBeVisible();

    // Reject non-essential storage.
    await page.locator("#consent-reject-nonessential").click();

    // Banner dismisses.
    await expect(page.locator("#consent-banner")).toBeHidden();

    // Stored settings: strictly necessary only; functional + analytics off.
    const settings = await readConsent(page);
    expect(settings).not.toBeNull();
    expect(settings.necessary).toBe(true);
    expect(settings.functional).toBe(false);
    expect(settings.analytics).toBe(false);

    // A reload keeps the banner hidden (choice persisted).
    await page.reload();
    await page.waitForSelector("#main-content");
    await expect(page.locator("#consent-banner")).toBeHidden();
  });

  test("2. GPC flag detection enforces automatic opt-out", async ({ page }) => {
    // Simulate a browser with Global Privacy Control enabled before the app
    // scripts run so consent.js sees navigator.globalPrivacyControl === true.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "globalPrivacyControl", {
        get: () => true,
        configurable: true,
      });
    });

    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#main-content");

    // GPC users never see the banner — the signal IS the opt-out.
    await expect(page.locator("#consent-banner")).toBeHidden();

    // Settings force analytics off and record gpcActive.
    const settings = await readConsent(page);
    expect(settings).not.toBeNull();
    expect(settings.gpcActive).toBe(true);
    expect(settings.analytics).toBe(false);

    // Open the consent manager and verify the status is reflected in the UI.
    await page.evaluate(() => (window as any).openConsentModal());
    await expect(page.locator("#consent-modal")).toBeVisible();
    await expect(page.locator("#gpc-status")).toContainText("Global Privacy Control is active");

    // The analytics toggle is locked (disabled) under GPC.
    await expect(page.locator("#consent-analytics")).toBeDisabled();
  });

  test("3. Export My Data initiates a valid JSON payload download", async ({ page }) => {
    // Authenticate as the seeded user so /api/user endpoints are reachable.
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, {
      data: ALEX,
    });
    expect(loginRes.status()).toBe(200);

    // Accept consent so no banner overlays the settings drawer.
    await page.addInitScript((key: string) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          necessary: true,
          functional: true,
          analytics: true,
          gpcActive: false,
          updatedAt: new Date().toISOString(),
        }),
      );
    }, CONSENT_KEY);

    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#main-content");

    // Open the settings drawer on the Privacy tab.
    await page.evaluate(() => {
      (window as any).__settings.open("privacy");
    });
    await expect(page.locator("#settings-drawer")).toBeVisible();
    await expect(page.locator("#settings-panel-privacy")).toBeVisible();

    // Trigger the download and capture it.
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#btn-export-my-data").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^mgpl-my-data-.*\.json$/);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf-8");
    const payload = JSON.parse(text);

    // Valid snapshot shape: versioned + data object with array keys.
    expect(payload.version).toBe(1);
    expect(typeof payload.exportedAt).toBe("string");
    expect(payload.data).toBeTruthy();
    expect(Array.isArray(payload.data.wishlist)).toBe(true);
    expect(Array.isArray(payload.data.appDevices)).toBe(true);

    // AI-084 (#163): only the signed-in user's own data. No shared or
    // whole-database tables, no other user's rows, no email address and no
    // credential fields.
    expect(payload.scope).toBe("user");
    expect(payload.account?.id).toBe(ALEX_ID);
    expect(payload.account?.email).toBeUndefined();
    expect(payload.data.fleet).toBeUndefined();
    for (const [key, rows] of Object.entries(
      payload.data as Record<string, Array<Record<string, unknown>>>,
    )) {
      for (const row of rows) {
        const own =
          key === "friendships"
            ? row.userId === ALEX_ID || row.friendId === ALEX_ID
            : row.userId === ALEX_ID;
        expect(own, `${key} row ${JSON.stringify(row).slice(0, 120)}`).toBe(true);
      }
    }
    expect(text).not.toMatch(/tokenEnc|tokenIv|passwordHash/);
  });

  test("4. Reopening consent manager from footer updates stored preferences", async ({ page }) => {
    const url = BASE + "/#/home";
    await page.goto(url);
    await page.waitForSelector("#main-content");

    // Start from a stored strict-only preference.
    await page.evaluate((key: string) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          necessary: true,
          functional: false,
          analytics: false,
          gpcActive: false,
          updatedAt: new Date().toISOString(),
        }),
      );
    }, CONSENT_KEY);

    await page.reload();
    await page.waitForSelector("#main-content");
    await expect(page.locator("#consent-banner")).toBeHidden();

    // Reopen via the footer "Cookie / Privacy Preferences" link.
    await page.locator('[data-testid="footer-consent-link"]').click();
    await expect(page.locator("#consent-modal")).toBeVisible();

    // Enable Functional & Preferences, then save.
    await page.locator("#consent-functional").check();
    await page.locator("#consent-save-preferences").click();
    await expect(page.locator("#consent-modal")).toBeHidden();

    // Persisted settings reflect the update.
    const settings = await readConsent(page);
    expect(settings).not.toBeNull();
    expect(settings.functional).toBe(true);
    expect(settings.analytics).toBe(false);
    expect(settings.necessary).toBe(true);
  });
});
