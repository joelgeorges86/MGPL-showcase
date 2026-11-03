import type { Page } from "@playwright/test";

/**
 * EPIC-03 (Paginated Browsing) — Library grid paging helper.
 *
 * The games library now renders one page (24 games by default) at a time via
 * #library-pagination. Cards for unrated titles (or titles deep in the
 * score-desc ordering) may live on a later page, so this helper:
 *
 *   1. Lets any pending 120ms filter-debounce settle (a freshly-changed facet
 *      can briefly leave Next disabled on a stale single-page render).
 *   2. Resets to page 1 via Previous (paging only moves forward, so a previous
 *      search that advanced pages would otherwise strand the target behind us).
 *   3. Pages forward until a card containing `text` is present in the DOM or
 *      the last page is reached.
 *
 * Returns `true` when the card was found.
 */
export async function revealLibraryGameCard(
  page: Page,
  text: string,
  maxPages = 20,
): Promise<boolean> {
  // Debounce settle: scheduleLibraryFilterApply re-renders after 120ms.
  await page.waitForTimeout(200);

  // Reset to page 1 so a prior forward-only search cannot skip past the target.
  for (let i = 0; i < maxPages; i++) {
    const prev = page.locator("#library-prev");
    if ((await prev.count()) === 0 || (await prev.isDisabled())) break;
    await prev.click();
    await page.waitForTimeout(40);
  }

  const card = page
    .locator("#library-games-grid .game-card")
    .filter({ hasText: text })
    .first();
  for (let i = 0; i < maxPages; i++) {
    if ((await card.count()) > 0) return true;
    const next = page.locator("#library-next");
    if ((await next.count()) === 0 || (await next.isDisabled())) return false;
    await next.click();
    // Page turns are synchronous in the SPA, but wait for the grid + label to
    // settle so a fast double-page never races the next presence check.
    await page.waitForSelector("#library-games-grid .game-card", {
      state: "attached",
    });
    await page.waitForTimeout(50);
  }
  return false;
}

/**
 * EPIC-03 (Paginated Browsing) — navigate the library to a specific page
 * number by clicking #library-next until the #library-pagination-label reports
 * the requested page (or the last page is reached). Used to make deep-link
 * assertions deterministic without relying on exact card ordering.
 */
export async function gotoLibraryPage(
  page: Page,
  target: number,
  maxPages = 20,
): Promise<boolean> {
  for (let i = 0; i < maxPages; i++) {
    const label = await page.locator("#library-pagination-label").textContent();
    const match = label ? label.match(/Page\s+(\d+)\s+of\s+(\d+)/) : null;
    if (!match) return false;
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (current >= target) return current === target;
    const next = page.locator("#library-next");
    if ((await next.count()) === 0 || (await next.isDisabled()) || current >= total) {
      return false;
    }
    await next.click();
    await page.waitForTimeout(50);
  }
  return false;
}
