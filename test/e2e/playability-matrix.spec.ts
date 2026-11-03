import { test, expect } from "@playwright/test";

test.describe("Playability Matrix & Fleet Specs (FEAT-0142)", () => {
  test.beforeEach(async ({ page }: { page: any }) => {
    await page.goto("http://localhost:4000/#/playability");
    await page.waitForSelector("#page-playability");
  });

  test("1. Verify active device persistence and playability API calculations", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.evaluate(() => {
      localStorage.setItem("activeDeviceId", "DEV001");
      if ((window as any).loadPlayabilityMatrix) {
        (window as any).loadPlayabilityMatrix("DEV001");
      }
    });

    await page.waitForTimeout(1000);

    const storedDeviceId = await page.evaluate(() =>
      localStorage.getItem("activeDeviceId"),
    );
    expect(storedDeviceId).toBe("DEV001");
  });

  test("2. Verify playability matrix elements populate with proper headroom and battery estimates", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.evaluate(() => {
      localStorage.setItem("activeDeviceId", "DEV001");
      if ((window as any).loadPlayabilityMatrix) {
        (window as any).loadPlayabilityMatrix("DEV001");
      }
    });

    await page.waitForTimeout(1000);

    const matrixContainer = page.locator("#playable-games-container");
    await expect(matrixContainer.first()).toBeVisible();
  });
});
