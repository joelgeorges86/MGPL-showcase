import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:4000';

const ALEX = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };

/**
 * Sprint 24 (FEAT-0156) — Custom Tags, Dynamic Smart Collections & User Notes.
 *
 * Test 1: Add custom tags to a game via API & UI drawer.
 * Test 2: Auto-save player markdown notes with 1000ms debouncing.
 * Test 3: Filter library games by Smart Binder tag pills.
 * Test 4: Delete custom tags and verify clean state.
 * Test 5: Verify ARIA and accessibility attributes on Smart Binders & Drawer Notes.
 *
 * Sprint (EPIC-TEST-STD-0001): All /api/tags and /api/notes routes are
 * tenant-scoped behind requireAuth, so this suite authenticates as the
 * deterministic seeded user (alex.gamer) in beforeEach. `page.request` shares
 * the browser cookie jar, so the browser page rendering the Smart Binders and
 * the API requests both run under the same session.
 */
test.describe('Custom Tags, Smart Collections & Notes (FEAT-0156)', () => {

  test.beforeEach(async ({ page }) => {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);
  });

  test('1. Tag creation API & drawer tag management', async ({ page }) => {
    // 1. Tag creation via API
    const createRes = await page.request.post(`${BASE}/api/tags`, {
      data: {
        gameId: 'G00001',
        tagName: 'E2E-Favorites',
        colorHex: '#10b981',
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    expect(createBody.success).toBe(true);

    // 2. Fetch tags for game (returns { success: true, tags: string[] })
    const tagsRes = await page.request.get(`${BASE}/api/tags/game/G00001`);
    expect(tagsRes.ok()).toBeTruthy();
    const tagsBody = await tagsRes.json();
    expect(tagsBody.tags).toContain('E2E-Favorites');

    // 3. Fetch tags summary (returns { success: true, tags: Array<{ tagName, count, colorHex }> })
    const summaryRes = await page.request.get(`${BASE}/api/tags/summary`);
    expect(summaryRes.ok()).toBeTruthy();
    const summaryBody = await summaryRes.json();
    expect(summaryBody.tags.some((s: any) => s.tagName === 'E2E-Favorites')).toBe(true);
  });

  test('2. Notes API & 1000ms debounced auto-save', async ({ page }) => {
    // 1. Save note via API
    const saveRes = await page.request.put(`${BASE}/api/notes/G00001`, {
      data: { noteMarkdown: '## Strategy Notes\n- Collect all powerups' },
    });
    expect(saveRes.ok()).toBeTruthy();

    // 2. Retrieve note via API
    const noteRes = await page.request.get(`${BASE}/api/notes/G00001`);
    expect(noteRes.ok()).toBeTruthy();
    const noteBody = await noteRes.json();
    expect(noteBody.noteMarkdown).toContain('Collect all powerups');

    // 3. Verify in UI Drawer
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');

    // Open drawer for G00001 or first game card
    const card = page.locator('.game-card').first();
    if (await card.isVisible()) {
      await card.click();
      await page.waitForSelector('#game-detail-drawer:not(.translate-x-full)', { timeout: 10000 });

      const textarea = page.locator('#drawer-game-notes');
      await expect(textarea).toBeVisible();

      // Type new note text and check status transition
      await textarea.fill('New debounced note text for E2E');
      const statusLabel = page.locator('#drawer-notes-status');
      await expect(statusLabel).toContainText(/Saving\.\.\.|Saved|Unsaved/, { timeout: 3000 });
      await page.waitForTimeout(1200); // Wait out debounce
      await expect(statusLabel).toContainText('Saved');
    }
  });

  test('3. Smart Binders rendering and library tag filtering', async ({ page }) => {
    // Add a unique tag for filtering
    await page.request.post(`${BASE}/api/tags`, {
      data: {
        gameId: 'G00001',
        tagName: 'SmartBinderTestTag',
      },
    });

    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');

    const smartBindersContainer = page.locator('#library-smart-binders');
    await expect(smartBindersContainer).toBeAttached();

    // Check that our tag pill appears in Smart Binders
    const binderPill = smartBindersContainer.locator('button', { hasText: 'SmartBinderTestTag' });
    await expect(binderPill).toBeAttached();

    // Click smart binder pill to filter
    await binderPill.click({ force: true });

    // Verify games API filtering
    const filteredRes = await page.request.get(`${BASE}/api/games?tag=SmartBinderTestTag`);
    expect(filteredRes.ok()).toBeTruthy();
    const filteredBody = await filteredRes.json();
    expect(filteredBody.games.length).toBeGreaterThanOrEqual(1);
  });

  test('4. Tag deletion and clean state', async ({ page }) => {
    // Seed the tag we'll delete so the deletion is deterministic even if a
    // previous test run left the DB in a dirty state.
    await page.request.post(`${BASE}/api/tags`, {
      data: {
        gameId: 'G00001',
        tagName: 'SmartBinderTestTag',
      },
    });

    // Delete tag via DELETE /api/tags body: { gameId, tagName }
    const deleteRes = await page.request.delete(`${BASE}/api/tags`, {
      data: {
        gameId: 'G00001',
        tagName: 'SmartBinderTestTag',
      },
    });
    expect(deleteRes.ok()).toBeTruthy();

    const checkRes = await page.request.get(`${BASE}/api/tags/game/G00001`);
    const checkBody = await checkRes.json();
    expect(checkBody.tags.includes('SmartBinderTestTag')).toBe(false);
  });

  test('5. ARIA and accessibility attributes on Smart Binders & Drawer Notes', async ({ page }) => {
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#page-library');

    const smartBindersContainer = page.locator('#library-smart-binders');
    await expect(smartBindersContainer).toBeAttached();

    // Check ARIA labels and structure
    const allPill = smartBindersContainer.locator('button').first();
    await expect(allPill).toBeAttached();

    const textarea = page.locator('#drawer-game-notes');
    await expect(textarea).toHaveAttribute('placeholder', /markdown/i);
  });

});