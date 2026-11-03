import cron from "node-cron";
import axios from "axios";
import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { syncLiveStorePrices } from "./dealSync";
import { runDataFreshnessBaseline, db } from "../db";
import { runModsAggregationJob } from "../jobs/mod-aggregation";
import { reSanitizeModCatalog } from "./modCatalogSanitizer";
import { generateToken } from "../lib/auth";

// Flag to prevent parallel sync runs
let isSyncing = false;

/**
 * Task A: Deals & Giveaways
 * Queries ITAD and GamerPower API endpoints and refreshes cache/db.
 */
async function syncDealsAndGiveaways() {
  console.log("[CRON] Starting Deals & Giveaways sync...");

  const cacheDir = path.join(process.cwd(), "scripts", ".cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // 1. GamerPower Giveaways
  try {
    const response = await axios.get("https://www.gamerpower.com/api/giveaways?platform=pc");
    if (response.data) {
      fs.writeFileSync(
        path.join(cacheDir, "gamerpower_giveaways.json"),
        JSON.stringify(response.data, null, 2),
        "utf8",
      );
      console.log("[CRON] GamerPower giveaways cache refreshed successfully.");
    }
  } catch (error: any) {
    console.error(`[CRON] GamerPower sync failed: ${error.message}`);
  }

  // 2. IsThereAnyDeal (ITAD) Deals
  const itadKey = process.env.ITAD_API_KEY;
  if (!itadKey) {
    console.warn("[CRON] ITAD sync warning: ITAD_API_KEY is not configured in .env.");
  } else {
    try {
      const response = await axios.get(
        "https://api.isthereanydeal.com/deals/v2?country=US&limit=50",
        {
          headers: {
            "ITAD-API-Key": itadKey,
          },
        },
      );
      if (response.data) {
        fs.writeFileSync(
          path.join(cacheDir, "itad_deals.json"),
          JSON.stringify(response.data, null, 2),
          "utf8",
        );
        console.log("[CRON] ITAD deals cache refreshed successfully.");
      }
    } catch (error: any) {
      console.error(`[CRON] ITAD sync failed: ${error.message}`);
    }
  }
}

/**
 * Task B: Storefront Library Ingestion
 * Runs Steam and PSN account sync routines to import newly owned games and update play stats.
 */
async function syncStorefrontLibraries(): Promise<void> {
  console.log("[CRON] Starting Storefront Library Ingestion sync...");

  return new Promise<void>((resolve) => {
    // Execute scripts/sync_all_user_stats.js which handles Steam, PSN, GOG, and Nexus Mods sync.
    // execFile (not exec) runs the binary directly with an argv array — no shell
    // interpretation of the script path (SAST S1: no shell command injection).
    const scriptPath = path.join(process.cwd(), "scripts", "sync_all_user_stats.js");

    execFile("node", [scriptPath], async (error, stdout, stderr) => {
      if (error) {
        console.error(`[CRON] Library sync script execution error: ${error.message}`);
      }
      if (stderr) {
        console.warn(`[CRON] Library sync script stderr: ${stderr}`);
      }
      if (stdout) {
        console.log(`[CRON] Library sync script output:\n${stdout.trim()}`);
      }

      // Also trigger the local Steam library ingestion endpoint /api/sync/steam to import newly owned games.
      const port = process.env.PORT ? Number(process.env.PORT) : 4000;
      try {
        console.log("[CRON] Triggering local Steam sync API for game imports...");
        const schedulerToken = generateToken({ userId: "system-scheduler", role: "system" });
        const response = await axios.post(
          `http://127.0.0.1:${port}/api/sync/steam`,
          {},
          {
            timeout: 30000, // 30 seconds timeout
            headers: { Authorization: `Bearer ${schedulerToken}` },
          },
        );
        console.log("[CRON] Local Steam sync API response:", JSON.stringify(response.data));
      } catch (apiError: any) {
        console.warn(
          `[CRON] Local Steam sync API trigger failed (this is expected if the server is still starting): ${apiError.message}`,
        );
      }

      resolve();
    });
  });
}

/**
 * Run a full automated library auto-sync run.
 * Prevents parallel executions using the isSyncing flag.
 */
async function runAutoSync() {
  if (isSyncing) {
    console.log("[CRON] Sync already in progress, skipping parallel execution.");
    return;
  }

  isSyncing = true;
  console.log("[CRON] Starting library auto-sync...");

  try {
    // Run both Tasks
    await syncDealsAndGiveaways();
    await syncStorefrontLibraries();
    // Sprint 32: Live storefront price sync (CheapShark proxy + synthesis fallback)
    await syncLiveStorePrices();
    console.log("[CRON] Sync completed successfully.");
  } catch (err: any) {
    console.error(`[CRON] Library auto-sync failed with error: ${err.message}`);
  } finally {
    isSyncing = false;
  }
}

/**
 * Initializes the automated scheduler jobs.
 */
export function initSyncScheduler() {
  // MGPL v1.1 (staging harness): honor DISABLE_CRON=true so staging containers
  // do not run background sync jobs against live storefront APIs. This keeps
  // the staging environment deterministic and avoids rate-limit/credential
  // churn while still booting the full API surface.
  if (process.env.DISABLE_CRON === "true") {
    console.log("[CRON] DISABLE_CRON=true - skipping scheduler initialization.");
    return;
  }

  console.log("[CRON] Initializing Automated Library Auto-Sync Scheduler...");

  // Task A: Schedule Deals & Giveaways every 6 hours (0 */6 * * *)
  cron.schedule("0 */6 * * *", async () => {
    console.log("[CRON] Triggered scheduled Deals & Giveaways (Every 6 hours)...");
    if (isSyncing) {
      console.log("[CRON] Sync already in progress, skipping Deals & Giveaways run.");
      return;
    }
    isSyncing = true;
    try {
      await syncDealsAndGiveaways();
    } catch (err: any) {
      console.error(`[CRON] Deals & Giveaways run failed: ${err.message}`);
    } finally {
      isSyncing = false;
    }
  });

  // Task B: Schedule Storefront Library Ingestion daily at 3:00 AM (0 3 * * *)
  cron.schedule("0 3 * * *", async () => {
    console.log("[CRON] Triggered scheduled Storefront Library Ingestion (Daily at 3:00 AM)...");
    if (isSyncing) {
      console.log("[CRON] Sync already in progress, skipping Storefront Library Ingestion run.");
      return;
    }
    isSyncing = true;
    try {
      await syncStorefrontLibraries();
    } catch (err: any) {
      console.error(`[CRON] Storefront Library Ingestion run failed: ${err.message}`);
    } finally {
      isSyncing = false;
    }
  });

  // Task C (Sprint 32): Schedule Live Storefront Price Sync every 4 hours (0 */4 * * *)
  cron.schedule("0 */4 * * *", async () => {
    console.log("[CRON] Triggered scheduled Live Storefront Price Sync (Every 4 hours)...");
    if (isSyncing) {
      console.log("[CRON] Sync already in progress, skipping Live Storefront Price Sync run.");
      return;
    }
    isSyncing = true;
    try {
      const result = await syncLiveStorePrices();
      console.log(
        `[CRON] Live Storefront Price Sync completed: source=${result.source}, synced=${result.synced}, triggered=${result.triggered}`,
      );
    } catch (err: any) {
      console.error(`[CRON] Live Storefront Price Sync run failed: ${err.message}`);
    } finally {
      isSyncing = false;
    }
  });

  // Task D (EPIC-05 / DPM-08): Weekly automated DPM data-freshness check.
  // Runs the canonical-coverage + stale-device baseline every Monday 04:00
  // local time so stale playability data surfaces to operators on a fixed
  // cadence, closing the Sprint-1 "weekly check deferred" gap. Honors the
  // DISABLE_CRON flag above like every other scheduled job.
  cron.schedule("0 4 * * 1", async () => {
    try {
      runDataFreshnessBaseline();
      console.log("[CRON] Weekly DPM data-freshness check completed.");
    } catch (err: any) {
      console.error(`[CRON] Weekly DPM data-freshness check failed: ${err?.message || err}`);
    }
  });

  // Task E (Sprint 6.1 / GAP-003): Mods aggregation health probe + failure
  // alert. Runs hourly; failures are appended to platform_audit_logs and the
  // status endpoint lets the client raise an admin toast when stalled >24h.
  cron.schedule("0 * * * *", () => {
    try {
      const status = runModsAggregationJob();
      if (!status.success) {
        console.error(`[CRON] Mods aggregation alert: ${status.message}`);
      }
    } catch (err: any) {
      console.error(`[CRON] Mods aggregation job failed: ${err?.message || err}`);
    }
  });

  // Task F (Sprint 1B / EPICSEC02): automated mod-link re-sanitization sweep.
  // Re-validates every persisted Mods.sourceUrl against the read-time exact-match
  // whitelist hourly and soft-quarantines (is_active = 0) any non-compliant
  // records so stale/legacy links are purged on a fixed cadence, complementing
  // the boot-time self-heal in src/db.ts initDb(). Honors DISABLE_CRON above.
  cron.schedule("15 * * * *", () => {
    try {
      const report = reSanitizeModCatalog(db);
      if (report.invalid > 0 || report.reactivated > 0) {
        console.log(
          `[CRON] Mod catalog re-sanitization sweep: ${report.quarantined} quarantined, ${report.reactivated} reactivated of ${report.total}.`,
        );
      }
    } catch (err: any) {
      console.error(`[CRON] Mod catalog re-sanitization sweep failed: ${err?.message || err}`);
    }
  });

  // Startup Trigger: Run an initial background sync 10 seconds after server launch
  setTimeout(() => {
    console.log("[CRON] Triggering initial background sync (10 seconds after launch)...");
    runAutoSync();
  }, 10000);
}
