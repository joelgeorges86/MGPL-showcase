import { test, expect } from "../fixtures";

// AI-077: the HTML-escaping helpers in public/ once replaced each character with
// itself, so text from other users or third-party APIs reached innerHTML as
// markup. This renders a review whose fields carry markup through the real
// renderer, with the API response stubbed, and checks the markup stays text.

const BASE = "http://localhost:4000";
const PAYLOAD = '<img src="x" id="ai077-probe" onerror="window.__ai077 = 1">';

test.describe("AI-077 HTML escaping in the browser scripts", () => {
  // The app registers a service worker that handles fetches itself; requests it
  // handles bypass page.route(), so block it to let the stub answer.
  test.use({ serviceWorkers: "block" });

  test("a review's title, body, pros and author render as text, not markup", async ({ page }) => {
    await page.route(/\/api\/devices\/ai077-device\/reviews(\?|$)/, (route) =>
      route.fulfill({
        json: {
          success: true,
          aggregate: { average: 5, count: 1 },
          reviews: [
            {
              reviewId: 'ai077"review',
              rating: 5,
              title: PAYLOAD,
              body: PAYLOAD,
              pros: [PAYLOAD],
              cons: [],
              author: PAYLOAD,
              helpfulScore: 0,
            },
          ],
        },
      }),
    );
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => Boolean((window as any).__reviews));

    await page.evaluate(() =>
      (window as any).__reviews.loadReviews(
        "ai077-device",
        "devices-reviews-list",
        "devices-reviews-aggregate",
      ),
    );

    const list = page.locator("#devices-reviews-list");
    await expect(list).toContainText("5.0");
    await expect(page.locator("#ai077-probe")).toHaveCount(0);
    await expect(list.locator('[data-testid="device-review"]')).toHaveCount(1);
    await expect(list).toContainText('<img src="x" id="ai077-probe"');
    await expect(list.locator('[data-testid="device-review"]')).toHaveAttribute(
      "data-review-id",
      'ai077"review',
    );
    expect(await page.evaluate(() => (window as any).__ai077)).toBeUndefined();
  });
});
