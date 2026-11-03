import { test, expect } from "../fixtures";

const BASE = "http://localhost:4000";
const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

test.describe("Game and storefront mutation security", () => {
  test("anonymous clients cannot mutate catalog state, restore backups, or start syncs", async ({
    playwright,
  }) => {
    const anonymous = await playwright.request.newContext();
    try {
      const responses = await Promise.all([
        anonymous.patch(`${BASE}/api/games/G00001/rating`, { data: { rating: 8 } }),
        anonymous.post(`${BASE}/api/games/backup/restore-tuning`, { data: { profiles: [] } }),
        anonymous.post(`${BASE}/api/games/sync/steam`, { data: {} }),
        anonymous.post(`${BASE}/api/sync/steam`, { data: {} }),
        anonymous.get(`${BASE}/api/games/backup/db`),
      ]);

      for (const response of responses) {
        expect(response.status()).toBe(401);
        expect((await response.json()).error).toBe("Unauthorized");
      }
    } finally {
      await anonymous.dispose();
    }
  });

  test("public catalog reads remain available and authenticated requests cross the security boundary", async ({
    request,
  }) => {
    const catalog = await request.get(`${BASE}/api/games?limit=1`);
    expect(catalog.status()).toBe(200);

    const login = await request.post(`${BASE}/api/auth/login`, { data: ALEX });
    expect(login.status()).toBe(200);

    const restore = await request.post(`${BASE}/api/games/backup/restore-tuning`, {
      data: { profiles: [] },
    });
    expect(restore.status()).toBe(400);
    expect((await restore.json()).error).toBe("No profiles provided in request body");
  });
});
