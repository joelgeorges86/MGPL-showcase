import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:4000';

test.describe('Accessible Navigation & Focus Management (EPIC-COMPLIANCE-0001 Sprint 1)', () => {
  test.beforeEach(async ({ page }: { page: any }) => {
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');
  });

  test('1. Skip link becomes visible on keyboard focus and shifts focus to #main-content', async ({ page }: { page: any }) => {
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    await expect(page.locator('#main-content')).toHaveAttribute('tabindex', '-1');
  });

  test('2. Opening the game detail drawer moves focus inside and traps Tab navigation', async ({ page }: { page: any }) => {
    await page.locator('#command-search-input').focus();
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    const drawer = page.locator('#game-detail-drawer');
    await expect(drawer).toBeVisible();
    // Focus is moved inside the dialog on open (WCAG 2.4.3).
    await expect(page.locator('#game-detail-close')).toBeFocused();

    // Wait for the aggregated detail fetch to settle so the focusable set is
    // stable before exercising the focus trap. The content pane stays hidden
    // until GET /api/games/detail resolves (same wait pattern as
    // price-alerts.spec.ts / game-drawer.spec.ts).
    await page.waitForFunction(() => {
      const content = document.getElementById('drawer-content');
      return content && !content.classList.contains('hidden');
    }, { timeout: 15000 });

    // Move focus to the last focusable element inside the dialog, then press
    // Tab: the trap must cycle back to the first focusable (close button)
    // instead of escaping into the page behind the overlay.
    const lastFocused = await drawer.evaluate((el: HTMLElement) => {
      // Only visible focusables count: ownership-aware hiding leaves hidden
      // wishlist/deals controls in the DOM that cannot receive focus.
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((f) => f.getClientRects().length > 0);
      if (focusables.length === 0) return null;
      focusables[focusables.length - 1].focus();
      return focusables[focusables.length - 1].id || focusables[focusables.length - 1].tagName;
    });
    expect(lastFocused).toBeTruthy();

    // Tab from the last visible focusable must wrap to the first visible
    // focusable inside the dialog — the drawer's "Open Full Game Page" link
    // precedes the close button in DOM order — instead of escaping the overlay.
    await page.keyboard.press('Tab');
    const wrappedToFirst = await drawer.evaluate((el: HTMLElement) => {
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((f) => f.getClientRects().length > 0);
      return document.activeElement === focusables[0];
    });
    expect(wrappedToFirst).toBeTruthy();

    // Shift+Tab from the first focusable must wrap to the last focusable.
    await page.keyboard.press('Shift+Tab');
    const backToLast = await drawer.evaluate((el: HTMLElement) => {
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((f) => f.getClientRects().length > 0);
      return document.activeElement === focusables[focusables.length - 1];
    });
    expect(backToLast).toBeTruthy();
  });

  test('3. Pressing Escape closes the drawer and returns focus to the triggering element', async ({ page }: { page: any }) => {
    const trigger = page.locator('#command-search-input');
    await trigger.focus();
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#game-detail-drawer')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('4. All icon-only interactive elements supply an accessible aria-label', async ({ page }: { page: any }) => {
    await page.evaluate(() => {
      (window as any).openGameDetailDrawer('Elden Ring');
    });
    await expect(page.locator('#game-detail-drawer')).toBeVisible();
    const iconOnlyButtons = await page.locator('button').evaluateAll((buttons: HTMLButtonElement[]) => {
      return buttons
        .filter((btn: HTMLButtonElement) => {
          const text = (btn.textContent || '').trim();
          return text === '' && btn.querySelectorAll('i, svg').length > 0;
        })
        .map((btn: HTMLButtonElement) => ({ id: btn.id, ariaLabel: btn.getAttribute('aria-label') }));
    });
    expect(iconOnlyButtons.length).toBeGreaterThan(0);
    for (const btn of iconOnlyButtons) {
      expect(btn.ariaLabel, `Icon-only button #${btn.id} must have an aria-label`).toBeTruthy();
    }
  });
});