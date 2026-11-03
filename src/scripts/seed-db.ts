import path from "path";
import Database from "better-sqlite3";
import { seedDeviceCatalog } from "../seed/devices";
import { seedBuilderComponents } from "../seed/components";
import { seedPerformanceProfiles } from "../seed/performance";
import { seedReviews, seedHardwarePriceHistory } from "../seed/reviews";
import { seedRadar } from "../seed/radar";
import { seedCommunityBenchmarks } from "../seed/benchmarks";
import { ensureModHubSeed } from "../services/modManager";
import {
  DEV_DEVICES,
  DEV_GAMES,
  DEV_NOTES,
  DEV_OWNERSHIP,
  DEV_PRICE_ALERTS,
  DEV_TAGS,
  DEV_TRACKING,
  DEV_USERS,
  DEV_WISHLIST,
} from "./schema-tools/devSeedData";
import {
  bootstrapDatabase,
  defaultDevDbPath,
  ensureSafeDbPath,
  resetDatabaseFile,
} from "./schema-tools/schemaTooling";

function main(): void {
  const target = path.resolve(process.argv[2] ?? process.env.DB_PATH ?? defaultDevDbPath());
  ensureSafeDbPath(target);
  resetDatabaseFile(target);
  bootstrapDatabase(target);

  const db = new Database(target);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");
    db.pragma("foreign_keys = ON");

    seedDeviceCatalog(db);
    seedBuilderComponents(db);
    seedPerformanceProfiles(db);
    seedReviews(db);
    seedHardwarePriceHistory(db);
    seedRadar(db);
    seedCommunityBenchmarks(db);
    ensureModHubSeed(db);

    const insertUser = db.prepare(`
      INSERT OR REPLACE INTO "AuthUsers"
      (id, email, passwordHash, displayName, avatarUrl, gamerTag, profileVisibility, role)
      VALUES (@id, @email, @passwordHash, @displayName, @avatarUrl, @gamerTag, @profileVisibility, @role)
    `);
    const insertGame = db.prepare(`
      INSERT OR REPLACE INTO "AppGames"
      ("GameID", "Game Title", "Primary Genre", "Storage Size", "Min RAM GB", "Min VRAM GB", "SSD Required?", "Active", cover_url, nexusUrl, nexusModCount, trackedModCount, platformStoreUrls, storeUrl, storefront)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOwnership = db.prepare(`
      INSERT OR REPLACE INTO "AppOwnership"
      ("OwnershipID", "GameID", "Platform", "Store URL", "Edition", "Format", "Ownership Access Type", "Currency", "platformCanonical")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTracking = db.prepare(`
      INSERT OR REPLACE INTO "AppTracking"
      ("GameID", "Play Status", "Hours Played", "Played Platform", "Played Hardware Device", targetFps, resolution)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDevice = db.prepare(`
      INSERT OR REPLACE INTO "AppDevices"
      (id, userId, deviceName, deviceType, cpuModel, cpuCores, ramGb, gpuModel, vramGb, gpuType, storageType, storageFreeGb, isPortable, isPrimary)
      VALUES (@id, @userId, @deviceName, @deviceType, @cpuModel, @cpuCores, @ramGb, @gpuModel, @vramGb, @gpuType, @storageType, @storageFreeGb, @isPortable, @isPrimary)
    `);
    const insertWishlist = db.prepare(`
      INSERT OR REPLACE INTO "AppWishlist"
      (userId, gameId, title, coverImage, targetPrice, currentBestPrice, bestStore, bestStoreType, historicalLow, isTriggered, notes)
      VALUES (@userId, @gameId, @title, @coverImage, @targetPrice, @currentBestPrice, @bestStore, @bestStoreType, @historicalLow, @isTriggered, @notes)
    `);
    const insertAlert = db.prepare(`
      INSERT OR REPLACE INTO "AppPriceAlerts"
      (userId, gameId, title, targetPrice, currentPrice, historicalLow, isTriggered)
      VALUES (@userId, @gameId, @title, @targetPrice, @currentPrice, @historicalLow, @isTriggered)
    `);
    const insertTag = db.prepare(`
      INSERT OR REPLACE INTO "AppGameTags"
      (userId, gameId, tagName, colorHex)
      VALUES (@userId, @gameId, @tagName, @colorHex)
    `);
    const insertNote = db.prepare(`
      INSERT OR REPLACE INTO "AppGameNotes"
      (userId, gameId, noteMarkdown)
      VALUES (@userId, @gameId, @noteMarkdown)
    `);

    const tx = db.transaction(() => {
      for (const row of DEV_USERS) insertUser.run(row);
      for (const row of DEV_GAMES) {
        insertGame.run(
          row.GameID,
          row["Game Title"],
          row["Primary Genre"],
          row["Storage Size"],
          row["Min RAM GB"],
          row["Min VRAM GB"],
          row["SSD Required?"],
          row.Active,
          row.cover_url,
          row.nexusUrl,
          row.nexusModCount,
          row.trackedModCount,
          row.platformStoreUrls,
          row.storeUrl,
          row.storefront,
        );
      }
      for (const row of DEV_OWNERSHIP) {
        insertOwnership.run(
          row.OwnershipID,
          row.GameID,
          row.Platform,
          row["Store URL"],
          row.Edition,
          row.Format,
          row["Ownership Access Type"],
          row.Currency,
          row.platformCanonical,
        );
      }
      for (const row of DEV_TRACKING) {
        insertTracking.run(
          row.GameID,
          row["Play Status"],
          row["Hours Played"],
          row["Played Platform"],
          row["Played Hardware Device"],
          row.targetFps,
          row.resolution,
        );
      }
      for (const row of DEV_DEVICES) insertDevice.run(row);
      for (const row of DEV_WISHLIST) insertWishlist.run(row);
      for (const row of DEV_PRICE_ALERTS) insertAlert.run(row);
      for (const row of DEV_TAGS) insertTag.run(row);
      for (const row of DEV_NOTES) insertNote.run(row);
    });

    tx();

    const summary = {
      users: db.prepare('SELECT COUNT(*) AS c FROM "AuthUsers"').get() as { c: number },
      games: db.prepare('SELECT COUNT(*) AS c FROM "AppGames"').get() as { c: number },
      devices: db.prepare('SELECT COUNT(*) AS c FROM "AppDevices"').get() as { c: number },
      wishlist: db.prepare('SELECT COUNT(*) AS c FROM "AppWishlist"').get() as { c: number },
    };

    console.log(
      `Seeded ${target}: ${summary.users.c} users, ${summary.games.c} games, ${summary.devices.c} devices, ${summary.wishlist.c} wishlist rows.`,
    );
  } finally {
    db.close();
  }
}

main();
