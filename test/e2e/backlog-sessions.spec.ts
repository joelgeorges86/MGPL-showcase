import { test, expect } from '@playwright/test';

test.describe('Sprint 28: Backlog Session Tracking, Stopwatch & Offline Sync', () => {

  test('1. Start Session button displays stopwatch timer panel', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/backlog');
    await page.evaluate(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await expect(page.locator('#page-backlog')).toBeVisible({ timeout: 15000 });

    await page.waitForFunction(() => {
      const grid = document.getElementById('backlog-games-grid');
      return grid && grid.querySelectorAll('.backlog-session-btn').length > 0;
    }, { timeout: 15000 });

    const sessionBtn = page.locator('.backlog-session-btn').first();
    await expect(sessionBtn).toBeVisible();

    // Click Start Session
    await sessionBtn.click();

    // Stopwatch panel should now be visible
    const timerPanel = page.locator('#session-timer-panel');
    await expect(timerPanel).toBeVisible();
    await expect(page.locator('#session-timer-title')).not.toBeEmpty();

    // The stopwatch is a live counter, so assert resiliently on the HH:MM:SS
    // format rather than a brittle "still at 00:00:0x" timing assumption.
    const timerDisplay = page.locator('#session-timer-display');
    await expect(timerDisplay).toBeVisible();
    await expect(timerDisplay).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  });


  test('2. Direct API logging via POST /api/backlog/session with sessionUuid idempotency', async ({ request }: { request: any }) => {
    const sessionUuid = 'test-uuid-' + Date.now();
    const payload = {
      gameId: 'G00001',
      sessionUuid,
      sessionMinutes: 45,
      notes: 'Playwright test session log',
      platform: 'PC',
    };

    // First POST - create session
    const response1 = await request.post('http://localhost:4000/api/backlog/session', {
      data: payload,
    });
    expect(response1.ok()).toBeTruthy();
    const body1 = await response1.json();
    expect(body1.success).toBe(true);
    expect(body1.session.sessionUuid).toBe(sessionUuid);
    expect(body1.session.durationMinutes).toBe(45);

    // Second POST with same sessionUuid - idempotent (duplicate ignored)
    const response2 = await request.post('http://localhost:4000/api/backlog/session', {
      data: payload,
    });
    expect(response2.ok()).toBeTruthy();
    const body2 = await response2.json();
    expect(body2.success).toBe(true);
    expect(body2.duplicate).toBe(true);
  });

  test('3. Backlog summary API includes play sessions and priority scores', async ({ request }: { request: any }) => {
    const summaryResponse = await request.get('http://localhost:4000/api/backlog/summary');
    expect(summaryResponse.ok()).toBeTruthy();
    const summary = await summaryResponse.json();
    expect(summary.success).toBe(true);
    expect(Array.isArray(summary.items)).toBeTruthy();
    expect(summary.items.length).toBeGreaterThan(0);

    const firstItem = summary.items[0];
    expect(firstItem).toHaveProperty('priorityScore');
    expect(typeof firstItem.priorityScore).toBe('number');
  });

  test('4. Client-side IndexedDB offline session queueing and sync', async ({ page }: { page: any }) => {
    await page.goto('http://localhost:4000/#/backlog');
    await page.evaluate(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await expect(page.locator('#page-backlog')).toBeVisible({ timeout: 15000 });

    await page.evaluate(async () => {
      const testSession = {
        gameId: 'G00002',
        sessionUuid: 'idb-test-' + Date.now(),
        sessionMinutes: 30,
        notes: 'IndexedDB test session',
        platform: 'PC',
        timestamp: new Date().toISOString(),
      };
      await (window as any).OfflineStorage.enqueueSession(testSession);
    });

    // Verify queue retrieval
    const queuedCount = await page.evaluate(async () => {
      const items = await (window as any).OfflineStorage.getQueuedSessions();
      return items.length;
    });
    expect(queuedCount).toBeGreaterThan(0);

    // Trigger sync
    await page.evaluate(async () => {
      await (window as any).OfflineStorage.syncPlaySessions();
    });

    // Verify queue is empty after sync
    const remainingCount = await page.evaluate(async () => {
      const items = await (window as any).OfflineStorage.getQueuedSessions();
      return items.length;
    });
    expect(remainingCount).toBe(0);
  });
});
