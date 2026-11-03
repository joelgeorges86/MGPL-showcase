import { test, expect } from "@playwright/test";

/**
 * EPIC-UX-REFINE-0002 — Home Page Visual Enrichment, Card Density & Hero
 * Spotlight Showcase.
 *
 * Test 1: Hero introduction + featured spotlight card render on home.
 * Test 2: Freebie cards display cover art, store badge, value, and expiry.
 * Test 3: Top Deal cards display thumbnail, review score, price breakdown.
 * Test 4: Modded game items render thumbnail and mod taxonomy badges.
 */
test.describe("EPIC-UX-REFINE-0002 Home Enrichment", () => {
  test("1. Hero introduction and featured spotlight card render on the home surface", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/home");
    await page.waitForSelector("#page-home");

    const hero = page.locator("#hero-intro-banner");
    await expect(hero).toBeVisible();
    await expect(hero).toContainText("Your Command Center");

    const spotlight = page.locator("#dashboard-featured-spotlight");
    await expect(spotlight).toBeVisible();
    await expect(spotlight.getByText("Featured Spotlight")).toBeVisible();

    // Wait for the spotlight content to be populated (not the loading label).
    await page.waitForFunction(
      () => {
        const el = document.getElementById("dashboard-featured-spotlight-content");
        return el && !el.textContent?.includes("Loading spotlight");
      },
      { timeout: 15000 },
    );

    const content = page.locator("#dashboard-featured-spotlight-content");
    // Cover art or its SVG placeholder must exist.
    await expect(content.locator("img").first()).toBeVisible();
    // A review badge and an action button must render.
    await expect(content.locator("[data-featured-score]")).toBeVisible();
    await expect(content.locator("[data-featured-action]")).toBeVisible();
  });

  test("2. Freebie cards display cover art, store badge, value, and expiry urgency timers", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/home");
    await page.waitForSelector("#page-home");

    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll("#dashboard-deals-radar [data-freebie-card]");
        return cards.length > 0;
      },
      { timeout: 15000 },
    );

    const freebieCards = page.locator("#dashboard-deals-radar [data-freebie-card]");
    const count = await freebieCards.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);

    const first = freebieCards.first();
    // Cover art placeholder (SVG data URI) or real <img>.
    await expect(first.locator("img").first()).toBeVisible();
    // Store badge pill.
    await expect(first.locator("[data-freebie-store]")).toBeVisible();
    // Retail value !== FREE badge.
    await expect(first.locator("[data-freebie-free-badge]")).toBeVisible();
    // Expiry urgency badge ("Ends in ...", "Ending soon", or "No expiry listed").
    await expect(
      first.locator("text=/Ends in|Ends soon|Ending soon|No expiry listed|Expires in/"),
    ).toBeVisible();
    // Direct claim action.
    await expect(first.locator(".freebie-claim-btn")).toBeVisible();
  });

  test("3. Top Deal cards display thumbnail, review score badges, and price breakdown", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/home");
    await page.waitForSelector("#page-home");

    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll("#dashboard-deals-radar [data-deal-card]");
        return cards.length > 0;
      },
      { timeout: 15000 },
    );

    const dealCards = page.locator("#dashboard-deals-radar [data-deal-card]");
    const count = await dealCards.count();
    expect(count).toBeGreaterThan(0);

    const first = dealCards.first();
    // Thumbnail (real image or SVG placeholder).
    await expect(first.locator("img").first()).toBeVisible();
    // Review score pill (numeric or "Score —" fallback).
    await expect(first.locator("[data-deal-score]")).toBeVisible();
    // Store badge + price breakdown (sale price + discount badge).
    await expect(first.locator("[data-deal-store]")).toBeVisible();
    await expect(first.locator("[data-deal-discount]").first()).toBeVisible();
    // Direct "View Deal" redirect link.
    await expect(first.locator("[data-deal-view]")).toBeVisible();
  });

  test("4. Modded game items render thumbnail and mod taxonomy badges", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/home");
    await page.waitForSelector("#page-home");

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll("#dashboard-moddable [data-mod-tag]");
        return rows.length > 0;
      },
      { timeout: 15000 },
    );

    const modTags = page.locator("#dashboard-moddable [data-mod-tag]");
    expect(await modTags.count()).toBeGreaterThan(0);

    const modCard = page.locator("#dashboard-moddable .moddable-game-btn").first();
    await expect(modCard).toBeVisible();
    // Cover thumbnail (real image or SVG placeholder).
    await expect(modCard.locator("img").first()).toBeVisible();
    // Mod count badge.
    await expect(modCard.locator("[data-mod-count]")).toBeVisible();
    // Nexus quick-link.
    await expect(modCard.locator("[data-mod-nexus-link]")).toBeVisible();
  });
});
