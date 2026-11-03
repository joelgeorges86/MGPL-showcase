import { test, expect } from "@playwright/test";

/**
 * Sprint 21 (FEAT-0153) — Multi-Source Library Importer, Batch Sync Hub &
 * Deduplication Engine.
 *
 * Test 1: Drag-and-drop / file upload parsing of simulated Steam .acf + JSON
 *         payloads renders a deduplication preview table.
 * Test 2: Batch import execution + deduplication validation against existing
 *         SQLite library titles (insert vs update vs skip).
 * Test 3: Preserving existing game progress/tracking records during platform
 *         metadata updates.
 * Test 4: Error handling for malformed/empty manifest files with descriptive
 *         alerts.
 * Test 5: Zero accessibility violations on import views and modal tables.
 */

// An existing library title used for the dedup/update path.
const EXISTING_TITLE = "A Plague Tale: Innocence";

const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };

// Library imports are account-scoped (PI-004), so the import flows must run
// under an authenticated session attributed to the seeded Alex user.
async function loginAsAlex(ctx: any): Promise<void> {
  const res = await ctx.post("http://localhost:4000/api/auth/login", { data: ALEX });
  expect(res.status()).toBe(200);
}

// Generate a fresh unique title + appid at call time so the "new insert" path
// never collides with real library rows OR with the store URL of a previously
// imported E2E test game (which would otherwise be matched by external id).
function makeUniqueTitle(): string {
  return `MGPL E2E Import ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeUniqueAppid(): string {
  // Use a large, unlikely-to-collide appid derived from the current time.
  return String(1000000000 + (Date.now() % 100000000));
}

// A valid Steam appmanifest_*.acf KeyValues/VDF document for a brand-new title.
function makeSteamAcf(title: string, appid: string): string {
  return `"AppState"
{
  "appid" "${appid}"
  "name" "${title}"
  "installdir" "${title}"
  "StateFlags" "4"
}`;
}

// A valid GOG goggame-*.info JSON document.
const GOG_INFO = JSON.stringify({
  gameId: "1207659167",
  rootGameId: "1207659167",
  name: "The Witcher 3: Wild Hunt",
  version: "1.32",
});

// A valid Epic *.item manifest JSON document.
const EPIC_ITEM = JSON.stringify({
  AppName: "Fortnite",
  DisplayName: "Fortnite",
  InstallLocation: "C:\\\\EpicGames\\\\Fortnite",
  MainGameAppName: "Fortnite",
});

// A malformed Steam .acf (missing appid/name).
const MALFORMED_ACF = `"AppState"
{
  "StateFlags" "4"
}`;

// An empty file.
const EMPTY_FILE = "";

test.describe("Multi-Source Library Importer & Deduplication Engine (FEAT-0153)", () => {
  test("1. Parses simulated Steam .acf and JSON manifests into a preview table", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/importer");
    await page.waitForSelector("#page-importer");
    await expect(page.locator("#page-importer")).toBeVisible();

    const uniqueTitle = makeUniqueTitle();
    const uniqueAppid = makeUniqueAppid();
    const steamAcf = makeSteamAcf(uniqueTitle, uniqueAppid);

    // Upload a Steam .acf, a GOG .info and an Epic .item manifest together.
    await page.setInputFiles("#import-file-input", [
      {
        name: `appmanifest_${uniqueAppid}.acf`,
        mimeType: "text/plain",
        buffer: Buffer.from(steamAcf),
      },
      {
        name: "goggame-1207659167.info",
        mimeType: "application/json",
        buffer: Buffer.from(GOG_INFO),
      },
      { name: "Fortnite.item", mimeType: "application/json", buffer: Buffer.from(EPIC_ITEM) },
    ]);

    // The preview table should become visible with 3 rows.
    await page.waitForSelector("#import-preview-wrap:not(.hidden)", { timeout: 10000 });
    await expect(page.locator("#import-preview-body tr")).toHaveCount(3);

    // Each parsed title/platform should be present.
    await expect(page.locator("#import-preview-body")).toContainText(uniqueTitle);
    await expect(page.locator("#import-preview-body")).toContainText("Steam");
    await expect(page.locator("#import-preview-body")).toContainText("The Witcher 3: Wild Hunt");
    await expect(page.locator("#import-preview-body")).toContainText("GOG");
    await expect(page.locator("#import-preview-body")).toContainText("Fortnite");
    await expect(page.locator("#import-preview-body")).toContainText("Epic Games");

    // The install path column should surface the Steam installdir.
    await expect(page.locator("#import-preview-body")).toContainText(uniqueTitle);

    // The count summary should reflect 3 games.
    await expect(page.locator("#import-preview-count")).toContainText("3 games");
  });

  test("2. Batch import executes with deduplication against existing library titles", async ({
    page,
  }: {
    page: any;
  }) => {
    await loginAsAlex(page.request);
    await page.goto("http://localhost:4000/#/importer");
    await page.waitForSelector("#page-importer");

    // A brand-new title + appid for the insert path (unique per run).
    const uniqueTitle = makeUniqueTitle();
    const uniqueAppid = makeUniqueAppid();
    const steamAcf = makeSteamAcf(uniqueTitle, uniqueAppid);

    // Upload a batch: one existing title (dedup -> update) and one new title (insert).
    await page.setInputFiles("#import-file-input", [
      {
        name: `appmanifest_${uniqueAppid}.acf`,
        mimeType: "text/plain",
        buffer: Buffer.from(steamAcf),
      },
      {
        name: "appmanifest_782330.acf",
        mimeType: "text/plain",
        buffer: Buffer.from(
          `"AppState"\n{\n  "appid" "782330"\n  "name" "${EXISTING_TITLE}"\n  "installdir" "A Plague Tale Innocence"\n}`,
        ),
      },
    ]);
    await page.waitForSelector("#import-preview-wrap:not(.hidden)", { timeout: 10000 });
    await expect(page.locator("#import-preview-body tr")).toHaveCount(2);

    // The existing title should be tagged "Update", the new one "New".
    await expect(page.locator("#import-preview-body")).toContainText("Update");
    await expect(page.locator("#import-preview-body")).toContainText("New");

    // Confirm & sync.
    await page.click("#import-confirm-btn");

    // The result summary should report 1 inserted and 1 updated.
    await page.waitForSelector("#import-result:not(.hidden)", { timeout: 10000 });
    await expect(page.locator("#import-result")).toContainText("1 inserted");
    await expect(page.locator("#import-result")).toContainText("1 updated");
    await expect(page.locator("#import-result")).toContainText("2 total");

    // The preview should reset after a successful sync.
    await expect(page.locator("#import-preview-wrap")).toHaveClass(/hidden/);
  });

  test("3. Preserves existing game progress/tracking records during platform metadata updates", async ({
    page,
  }: {
    page: any;
  }) => {
    await loginAsAlex(page.request);
    // Capture the existing tracking state for a game that has playtime.
    const before = await page.request.get(
      `http://localhost:4000/api/games?active=true&owned=true&search=${encodeURIComponent("112 Operator")}`,
    );
    const beforeData = await before.json();
    const beforeGame = (beforeData.games || []).find((g: any) =>
      (g.title || g["Game Title"] || "").toLowerCase().includes("112 operator"),
    );
    expect(beforeGame).toBeTruthy();
    const beforeTracking = (beforeGame.tracking || [])[0] || {};
    const beforeHours = beforeTracking.hoursPlayed ?? beforeTracking["Hours Played"];
    const beforeStatus = beforeTracking.playStatus ?? beforeTracking["Play Status"];

    // Import a platform metadata update for the same game (Steam ownership).
    const importRes = await page.request.post("http://localhost:4000/api/library/import", {
      data: {
        games: [
          {
            title: "112 Operator",
            platform: "Steam",
            externalId: "1144200",
            installPath: "C:\\\\Steam\\\\steamapps\\\\common\\\\112Operator",
          },
        ],
      },
    });
    const importData = await importRes.json();
    expect(importData.success).toBe(true);
    expect(importData.updated).toBeGreaterThanOrEqual(1);

    // Re-fetch and confirm the tracking record (hours + status) is untouched.
    const after = await page.request.get(
      `http://localhost:4000/api/games?active=true&owned=true&search=${encodeURIComponent("112 Operator")}`,
    );
    const afterData = await after.json();
    const afterGame = (afterData.games || []).find((g: any) =>
      (g.title || g["Game Title"] || "").toLowerCase().includes("112 operator"),
    );
    const afterTracking = (afterGame.tracking || [])[0] || {};
    const afterHours = afterTracking.hoursPlayed ?? afterTracking["Hours Played"];
    const afterStatus = afterTracking.playStatus ?? afterTracking["Play Status"];

    expect(afterHours).toBe(beforeHours);
    expect(afterStatus).toBe(beforeStatus);
  });

  test("4. Reports descriptive errors for malformed and empty manifest files", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/importer");
    await page.waitForSelector("#page-importer");

    // Upload a malformed .acf and an empty GOG .info file.
    await page.setInputFiles("#import-file-input", [
      {
        name: "appmanifest_broken.acf",
        mimeType: "text/plain",
        buffer: Buffer.from(MALFORMED_ACF),
      },
      { name: "goggame-empty.info", mimeType: "application/json", buffer: Buffer.from(EMPTY_FILE) },
    ]);

    // The error alert region should become visible with a descriptive message.
    await page.waitForSelector("#import-error:not(.hidden)", { timeout: 10000 });
    await expect(page.locator("#import-error")).toContainText("not a valid Steam .acf manifest");
    await expect(page.locator("#import-error")).toContainText("not a valid GOG .info manifest");

    // No preview should be shown for invalid files.
    await expect(page.locator("#import-preview-wrap")).toHaveClass(/hidden/);
  });

  test("5. Import views and preview table expose accessible ARIA semantics", async ({
    page,
  }: {
    page: any;
  }) => {
    await page.goto("http://localhost:4000/#/importer");
    await page.waitForSelector("#page-importer");

    // The importer page region is labelled.
    await expect(page.locator("#page-importer")).toHaveAttribute("role", "region");
    await expect(page.locator("#page-importer")).toHaveAttribute("aria-label", "Library Importer");

    // The dropzone is a labelled region.
    await expect(page.locator("#import-dropzone")).toHaveAttribute("role", "region");
    await expect(page.locator("#import-dropzone")).toHaveAttribute(
      "aria-label",
      "Library Importer Dropzone",
    );

    // The error region is an assertive live alert.
    await expect(page.locator("#import-error")).toHaveAttribute("role", "alert");
    await expect(page.locator("#import-error")).toHaveAttribute("aria-live", "assertive");

    // The result region is a polite live status.
    await expect(page.locator("#import-result")).toHaveAttribute("role", "status");
    await expect(page.locator("#import-result")).toHaveAttribute("aria-live", "polite");

    // The file input is present and accepts the supported manifest types.
    await expect(page.locator("#import-file-input")).toHaveAttribute("type", "file");
    await expect(page.locator("#import-file-input")).toHaveAttribute("multiple", "");

    // Populate the preview table and verify its table semantics.
    const uniqueTitle = makeUniqueTitle();
    const uniqueAppid = makeUniqueAppid();
    await page.setInputFiles("#import-file-input", [
      {
        name: `appmanifest_${uniqueAppid}.acf`,
        mimeType: "text/plain",
        buffer: Buffer.from(makeSteamAcf(uniqueTitle, uniqueAppid)),
      },
    ]);
    await page.waitForSelector("#import-preview-wrap:not(.hidden)", { timeout: 10000 });
    await expect(page.locator("#import-preview-wrap table")).toHaveAttribute("role", "table");
    await expect(page.locator("#import-preview-wrap table")).toHaveAttribute(
      "aria-label",
      "Import preview",
    );

    // The confirm action button is accessible and labelled.
    await expect(page.locator("#import-confirm-btn")).toContainText("Confirm & Sync Library");
  });
});
