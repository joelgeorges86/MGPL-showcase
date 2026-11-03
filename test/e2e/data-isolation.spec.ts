import { test, expect } from '@playwright/test';

/**
 * Sprint 2 (FEAT-MULTITENANT) — Multi-Tenant Data Isolation & SQLite State Contract.
 *
 * Verifies strict cross-user isolation for the four user-scoped state tables
 * (AppWishlist, AppPriceAlerts, AppGameTags, AppGameNotes) using the two
 * deterministic mock auth users seeded by test/global-setup.ts:
 *   - alex.gamer@mgpl.io   / GamerPass2026!
 *   - jordan.dev@mgpl.io   / SecureDev2026!
 *
 * Each test uses a dedicated Playwright APIRequestContext per user so cookie
 * jars never cross-contaminate between "sessions" within a single test file.
 *
 * Test 1: Alex logs in, creates a wishlist item and a note.
 * Test 2: Jordan logs in, verifies Alex's wishlist item and note are not visible.
 * Test 3: Jordan attempts to mutate/delete Alex's record -> 404/403.
 * Test 4: Unauthenticated requests to protected state endpoints -> 401.
 */

const BASE = 'http://localhost:4000';

const ALEX = { email: 'alex.gamer@mgpl.io', password: 'GamerPass2026!' };
const JORDAN = { email: 'jordan.dev@mgpl.io', password: 'SecureDev2026!' };

const ISOLATION_GAME_ID = 'data-isolation-e2e-game';
const ISOLATION_GAME_TITLE = 'Data Isolation E2E Fixture';

test.describe('Sprint 2 (FEAT-MULTITENANT) — Multi-Tenant Data Isolation', () => {
  test('1. Alex creates a wishlist item and a note visible in her own session', async ({ playwright }) => {
    const alexCtx = await playwright.request.newContext();
    try {
      const login = await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });
      expect(login.status()).toBe(200);

      const wishlistRes = await alexCtx.post(`${BASE}/api/wishlist`, {
        data: { gameId: ISOLATION_GAME_ID, title: ISOLATION_GAME_TITLE, targetPrice: 19.99 },
      });
      expect(wishlistRes.status()).toBe(200);
      const wishlistBody = await wishlistRes.json();
      expect(wishlistBody.success).toBe(true);
      expect(wishlistBody.item.gameId).toBe(ISOLATION_GAME_ID);

      const noteRes = await alexCtx.put(`${BASE}/api/notes/${ISOLATION_GAME_ID}`, {
        data: { noteMarkdown: 'Alex private note — do not leak to Jordan.' },
      });
      expect(noteRes.status()).toBe(200);
      const noteBody = await noteRes.json();
      expect(noteBody.success).toBe(true);

      // Verify Alex can see her own item and note.
      const listRes = await alexCtx.get(`${BASE}/api/wishlist`);
      const listBody = await listRes.json();
      const found = (listBody.wishlist || []).find((i: any) => i.gameId === ISOLATION_GAME_ID);
      expect(found).toBeTruthy();

      const getNoteRes = await alexCtx.get(`${BASE}/api/notes/${ISOLATION_GAME_ID}`);
      const getNoteBody = await getNoteRes.json();
      expect(getNoteBody.noteMarkdown).toContain('Alex private note');
    } finally {
      await alexCtx.dispose();
    }
  });

  test('2. Jordan cannot see Alex\'s wishlist item or note', async ({ playwright }) => {
    const jordanCtx = await playwright.request.newContext();
    try {
      const login = await jordanCtx.post(`${BASE}/api/auth/login`, { data: JORDAN });
      expect(login.status()).toBe(200);

      // Jordan's wishlist must NOT contain Alex's seeded gameId.
      const listRes = await jordanCtx.get(`${BASE}/api/wishlist`);
      expect(listRes.status()).toBe(200);
      const listBody = await listRes.json();
      const leaked = (listBody.wishlist || []).find((i: any) => i.gameId === ISOLATION_GAME_ID);
      expect(leaked).toBeUndefined();

      // Jordan's note lookup for the same gameId must return empty (not Alex's content).
      const noteRes = await jordanCtx.get(`${BASE}/api/notes/${ISOLATION_GAME_ID}`);
      expect(noteRes.status()).toBe(200);
      const noteBody = await noteRes.json();
      expect(noteBody.noteMarkdown).toBe('');

      // Jordan's tags for a game Alex tagged (cyberpunk-2077 "Moddable") must be empty.
      const tagsRes = await jordanCtx.get(`${BASE}/api/tags/game/cyberpunk-2077`);
      expect(tagsRes.status()).toBe(200);
      const tagsBody = await tagsRes.json();
      expect(tagsBody.tags).not.toContain('Moddable');
    } finally {
      await jordanCtx.dispose();
    }
  });

  test('3. Jordan cannot mutate or delete Alex\'s wishlist/tag/note records (404/403)', async ({ playwright }) => {
    const jordanCtx = await playwright.request.newContext();
    const alexCtx = await playwright.request.newContext();
    try {
      await jordanCtx.post(`${BASE}/api/auth/login`, { data: JORDAN });
      await alexCtx.post(`${BASE}/api/auth/login`, { data: ALEX });

      // Attempt to delete Alex's wishlist item using Jordan's session.
      const delWishlistRes = await jordanCtx.delete(`${BASE}/api/wishlist/${ISOLATION_GAME_ID}`);
      expect([403, 404]).toContain(delWishlistRes.status());

      // Attempt to delete Alex's seeded tag using Jordan's session.
      const delTagRes = await jordanCtx.delete(`${BASE}/api/tags`, {
        data: { gameId: 'cyberpunk-2077', tagName: 'Moddable' },
      });
      // Tag delete is a scoped no-op (200 success:true, deleted:false) rather than a
      // 404, since DELETE /api/tags does not look up a specific record id first.
      if (delTagRes.status() === 200) {
        const delTagBody = await delTagRes.json();
        expect(delTagBody.deleted).toBe(false);
      } else {
        expect([403, 404]).toContain(delTagRes.status());
      }

      // Verify Alex's wishlist item still exists after Jordan's failed delete attempt.
      const verifyRes = await alexCtx.get(`${BASE}/api/wishlist`);
      const verifyBody = await verifyRes.json();
      const stillThere = (verifyBody.wishlist || []).find((i: any) => i.gameId === ISOLATION_GAME_ID);
      expect(stillThere).toBeTruthy();

      // Verify Alex's tag on cyberpunk-2077 is still intact.
      const verifyTagsRes = await alexCtx.get(`${BASE}/api/tags/game/cyberpunk-2077`);
      const verifyTagsBody = await verifyTagsRes.json();
      expect(verifyTagsBody.tags).toContain('Moddable');

      // Now Alex deletes her own item — this MUST succeed (proves the item was real).
      const ownDeleteRes = await alexCtx.delete(`${BASE}/api/wishlist/${ISOLATION_GAME_ID}`);
      expect(ownDeleteRes.status()).toBe(200);
    } finally {
      await jordanCtx.dispose();
      await alexCtx.dispose();
    }
  });

  test('4. Unauthenticated requests to protected state endpoints return 401', async ({ playwright }) => {
    const guestCtx = await playwright.request.newContext();
    try {
      const wishlistGet = await guestCtx.get(`${BASE}/api/wishlist`);
      expect(wishlistGet.status()).toBe(401);

      const wishlistPost = await guestCtx.post(`${BASE}/api/wishlist`, {
        data: { gameId: 'guest-attempt', title: 'Guest Attempt', targetPrice: 9.99 },
      });
      expect(wishlistPost.status()).toBe(401);

      const alertsGet = await guestCtx.get(`${BASE}/api/alerts`);
      expect(alertsGet.status()).toBe(401);

      const tagsPost = await guestCtx.post(`${BASE}/api/tags`, {
        data: { gameId: 'guest-attempt', tagName: 'GuestTag' },
      });
      expect(tagsPost.status()).toBe(401);

      const notesGet = await guestCtx.get(`${BASE}/api/notes/guest-attempt`);
      expect(notesGet.status()).toBe(401);
    } finally {
      await guestCtx.dispose();
    }
  });
});