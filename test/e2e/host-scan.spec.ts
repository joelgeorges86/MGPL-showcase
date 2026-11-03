import { test, expect, Page } from "@playwright/test";

const BASE = "http://localhost:4000";

/**
 * AI-082 (#161) — "Scan Local PC" and "Scan Rig" scan the server's own
 * hardware, so they run only in local development and tests.
 *
 *  1. In test mode the status endpoint reports the scan enabled, and
 *     "Scan Local PC" still scans.
 *  2. Where the server reports the scan disabled (a hosted site, simulated
 *     here by answering the status request), "Scan Local PC" sends no scan
 *     and opens the Device Fleet form instead.
 *  3. The same for "Scan Rig" in the Hardware Explorer, which also sets the
 *     header badge and leaves its button usable.
 *
 * The server in this suite runs with NODE_ENV=test, so the hosted case is
 * simulated in the browser; the server side is covered by
 * test/unit/hostScanGuard.test.ts.
 */

// The modal's open state is read from its attributes, not from CSS
// visibility, so the check holds even if the page's stylesheet fails to load.
const HIDDEN_CLASS = /(^|\s)hidden(\s|$)/;

async function expectFleetFormOpen(page: Page): Promise<void> {
  const modal = page.locator("#fleet-add-modal");
  await expect(modal).toHaveAttribute("aria-hidden", "false", { timeout: 15000 });
  await expect(modal).not.toHaveClass(HIDDEN_CLASS);
  await expect(page.locator("#fleet-modal-title")).toHaveText("Add Device Profile");
  await expect(page).toHaveURL(/#\/fleet$/);
}

async function simulateHostedSite(page: Page): Promise<string[]> {
  await page.route("**/api/host-scan/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, enabled: false }),
    }),
  );
  const scans: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      req.method() === "POST" &&
      ["/api/devices/scan", "/api/devices/scan-local", "/api/scan"].includes(url.pathname)
    ) {
      scans.push(url.pathname);
    }
  });
  return scans;
}

test.describe("AI-082 — hardware scan only where the server is the user's PC", () => {
  // The app registers a service worker that handles fetches itself; requests it
  // handles bypass page.route(), so block it to let the stub answer.
  test.use({ serviceWorkers: "block" });

  test("1. In test mode the scan is enabled and Scan Local PC still scans", async ({ page }) => {
    const status = await page.request.get(`${BASE}/api/host-scan/status`);
    expect(status.status()).toBe(200);
    expect(await status.json()).toEqual({ success: true, enabled: true });

    await page.goto(BASE);
    const scan = page.waitForResponse(
      (res) => res.url().endsWith("/api/devices/scan") && res.request().method() === "POST",
      { timeout: 30000 },
    );
    await page.click("#scan-btn");
    expect((await scan).status()).toBe(200);
    await expect(page.locator("#fleet-add-modal")).toHaveClass(HIDDEN_CLASS);
  });

  test("2. Where the scan is disabled, Scan Local PC opens the Device Fleet form", async ({
    page,
  }) => {
    const scans = await simulateHostedSite(page);
    await page.goto(BASE);
    await page.click("#scan-btn");

    await expectFleetFormOpen(page);
    await expect(page.locator("#device-status-text")).toHaveText("Scan not available on this site");
    expect(scans).toEqual([]);
  });

  test("3. Where the scan is disabled, Scan Rig opens the Device Fleet form", async ({ page }) => {
    const scans = await simulateHostedSite(page);
    await page.goto(BASE);
    await page.evaluate(() => {
      window.location.hash = "#/hardware";
    });
    // The Hardware Explorer binds its buttons when it first loads; its
    // benchmark table rendering shows that has happened.
    await expect(page.locator("#hw-bench-table table tbody tr").first()).toBeVisible({
      timeout: 15000,
    });
    await page.click("#hw-scan-btn");

    await expectFleetFormOpen(page);
    // The same hand-off as Scan Local PC, so the header badge says why.
    await expect(page.locator("#device-status-text")).toHaveText("Scan not available on this site");
    await expect(page.locator("#hw-scan-btn")).toBeEnabled();
    expect(scans).toEqual([]);
  });
});
