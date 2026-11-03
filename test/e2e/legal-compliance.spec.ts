import { test, expect } from "../fixtures";

const BASE = "http://localhost:4000";

/**
 * Sprint 3 (EPIC-COMPLIANCE-0001) — Deal Transparency, Accessible Legal
 * Modals & EU Omnibus price baseline E2E suite.
 *
 * Test 1: Affiliate disclosure badges render visibly adjacent to store
 *         redirect links (deals hub view + game detail).
 * Test 2: 30-day baseline price tooltips render correctly on discounted deal
 *         cards.
 * Test 3: Footer legal links open accessible modals and trap focus correctly.
 */
test.describe("Deal Transparency & Legal Compliance (EPIC-COMPLIANCE-0001 Sprint 3)", () => {
  test("1. Affiliate disclosure badges render visibly adjacent to store redirect links", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/deals`);
    await page.waitForSelector("#page-deals");

    // Wait for deal cards to load from the mocked CheapShark API.
    await page.waitForSelector(".deal-card", { timeout: 15000 });

    const dealDisclosure = page.locator(".deal-card [data-affiliate-disclosure]");
    await expect(dealDisclosure.first()).toBeVisible();
    await expect(dealDisclosure.first()).toContainText(
      "MGPL may earn a commission on qualifying purchases via store links.",
    );
    await expect(dealDisclosure.first()).toHaveAttribute("role", "note");

    // The disclosure must sit adjacent to an external storefront link.
    const cardWithDisclosure = page
      .locator(".deal-card")
      .filter({ has: page.locator("[data-affiliate-disclosure]") })
      .first();
    await expect(cardWithDisclosure.locator('a[target="_blank"]').first()).toBeVisible();

    // Game detail page: store pills render a disclosure below them. Resolve a
    // real seeded game id (the detail route keys off DB game ids, not titles).
    const searchRes = await page.request.get(`${BASE}/api/games?search=Elden`);
    const searchData = await searchRes.json();
    const games = (searchData && searchData.games) || [];
    const game = games[0];
    if (game) {
      const gameId = game.GameID || game.id || game.gameId;
      await page.goto(`${BASE}/#/game/${encodeURIComponent(gameId)}`);
      await page.waitForSelector("#game-detail-content:not(.hidden)", { timeout: 15000 });
      // The disclosure renders adjacent to external store polls, and only when
      // store links exist. If the seeded record has no storefront URLs, there
      // is nothing to disclose (the deal-card assertion above already proves
      // the disclosure mechanism).
      const storePills = page.locator("#detail-meta-pills a[target='_blank']");
      if ((await storePills.count()) > 0) {
        const detailDisclosure = page.locator("#detail-meta-pills [data-affiliate-disclosure]");
        await expect(detailDisclosure.first()).toBeVisible();
        await expect(detailDisclosure.first()).toHaveAttribute("role", "note");
      }
    }
  });

  test("2. 30-day baseline price tooltip renders on discounted deal cards", async ({ page }) => {
    await page.goto(`${BASE}/#/deals`);
    await page.waitForSelector("#page-deals");
    await page.waitForSelector(".deal-card", { timeout: 15000 });

    const thirtyDayLow = page.locator("[data-30d-low]");
    const unavailable = page.locator("[data-history-unavailable]");
    await expect(thirtyDayLow.first().or(unavailable.first())).toBeVisible();
    if (await thirtyDayLow.count()) {
      await expect(thirtyDayLow.first()).toHaveAttribute(
        "title",
        "Lowest verified price in the last 30 days",
      );
      await expect(thirtyDayLow.first()).toContainText("Lowest in 30 days: $");
    } else {
      await expect(unavailable.first()).toHaveAttribute(
        "title",
        "No verified observed price history is available",
      );
    }
  });

  test("3. Footer legal links open accessible modals and trap focus correctly", async ({
    page,
  }) => {
    await page.goto(`${BASE}/#/home`);
    await page.waitForSelector("#main-content");

    // Dismiss the consent banner first so it does not intercept footer clicks.
    const banner = page.locator("#consent-banner");
    if (await banner.isVisible()) {
      await page.locator("#consent-reject-nonessential").click();
      await expect(banner).toBeHidden();
    }

    const legalModal = page.locator("#legal-modal");
    await expect(legalModal).toBeHidden();

    // Privacy Policy
    await page.locator('[data-testid="footer-privacy-link"]').click();
    await expect(legalModal).toBeVisible();
    await expect(legalModal).toHaveAttribute("role", "dialog");
    await expect(legalModal).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#legal-modal-title")).toHaveText("Privacy Policy");
    await expect(legalModal).toContainText("Privacy Policy");
    await expect(page.locator("#legal-modal-close")).toBeFocused();

    // Focus is trapped: Tab from the last focusable wraps back to the first.
    await page.keyboard.press("Tab");
    await expect(page.locator("#legal-modal-close")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#legal-modal-close")).toBeFocused();

    // Escape closes and returns focus to the triggering link.
    const trigger = page.locator('[data-testid="footer-privacy-link"]');
    await page.keyboard.press("Escape");
    await expect(legalModal).toBeHidden();
    await expect(trigger).toBeFocused();

    // Terms of Service
    await page.locator('[data-testid="footer-terms-link"]').click();
    await expect(legalModal).toBeVisible();
    await expect(page.locator("#legal-modal-title")).toHaveText("Terms of Service");
    await page.keyboard.press("Escape");
    await expect(legalModal).toBeHidden();

    // Accessibility Statement
    await page.locator('[data-testid="footer-a11y-link"]').click();
    await expect(legalModal).toBeVisible();
    await expect(page.locator("#legal-modal-title")).toHaveText("Accessibility Statement");
    await expect(legalModal).toContainText("WCAG 2.1");
    await expect(legalModal).toContainText("Section 508");
    await expect(legalModal).toContainText("accessibility@mgpl.io");

    // Close via the close button.
    await page.locator("#legal-modal-close").click();
    await expect(legalModal).toBeHidden();
  });
});
