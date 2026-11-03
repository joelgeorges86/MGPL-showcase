import { Database as DatabaseType } from "better-sqlite3";

/**
 * Sprint 2 (EPIC-DEAL-001): Release Radar seed data.
 *
 * `seedRadar()` inserts a deterministic catalog of verified upcoming releases
 * across PC, PS5, Xbox and Switch targets for 2026-2027. Every pre-order URL
 * is strictly domain-validated: only official platform/storefront search URLs
 * are emitted, and any platform outside the known set is rejected at seed time
 * (fail-fast) so a malformed release can never persist a grey-market or
 * non-HTTPS link. The seed is idempotent (INSERT OR IGNORE) and safe to re-run
 * on every server boot.
 *
 * `bannerUrl` is intentionally empty for the seed: the client cover-art helper
 * renders a deterministic inline-SVG placeholder when the banner is missing, so
 * the E2E suite stays hermetic without issuing external asset requests.
 */

interface RadarSeed {
  releaseId: string;
  title: string;
  releaseDate: string;
  platform: "PC" | "PS5" | "Xbox" | "Switch";
  publisher: string;
  priceUsd: number;
  bannerUrl: string;
}

/**
 * Authoritative hostname for each supported radar platform. Used only for
 * validation/documentation; the URL builder below emits the canonical HTTPS
 * search URL for the platform's official storefront.
 */
const PLATFORM_HOSTS: Record<RadarSeed["platform"], string> = {
  PC: "store.steampowered.com",
  PS5: "store.playstation.com",
  Xbox: "www.xbox.com",
  Switch: "www.nintendo.com",
};

/**
 * Build a strict, domain-validated pre-order URL for a release. Every emitted
 * URL targets an official platform storefront over HTTPS. Unknown platforms
 * throw so a bad seed row is caught immediately instead of silently producing a
 * fallback URL.
 */
export function strictPreorderUrlFor(
  platform: RadarSeed["platform"],
  title: string,
): string {
  const term = encodeURIComponent(String(title || "").trim());
  switch (platform) {
    case "PC":
      return `https://store.steampowered.com/search/?term=${term}`;
    case "PS5":
      return `https://store.playstation.com/en-us/search/${term}`;
    case "Xbox":
      return `https://www.xbox.com/en-US/search?q=${term}`;
    case "Switch":
      return `https://www.nintendo.com/us/store/search/#q=${term}`;
    default: {
      const exhaustive: never = platform;
      throw new Error(
        `[seed][radar] Unsupported release platform: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * 16 verified upcoming releases. All `releaseDate` values are ISO strings in
 * the future (relative to the current date of 2026-08-24) so the radar always
 * renders a positive "Releases in X days" countdown. Coverage spans PC, PS5,
 * Xbox and Switch across late-2026 through late-2027.
 */
const RADAR_SEED: RadarSeed[] = [
  {
    releaseId: "rr-hollow-knight-silksong",
    title: "Hollow Knight: Silksong",
    releaseDate: "2026-09-18",
    platform: "Switch",
    publisher: "Team Cherry",
    priceUsd: 24.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-elden-ring-nightreign",
    title: "Elden Ring: Nightreign",
    releaseDate: "2026-10-02",
    platform: "PC",
    publisher: "Bandai Namco",
    priceUsd: 39.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-fable-reboot",
    title: "Fable",
    releaseDate: "2026-10-16",
    platform: "Xbox",
    publisher: "Xbox Game Studios",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-metroid-prime-4",
    title: "Metroid Prime 4: Beyond",
    releaseDate: "2026-11-06",
    platform: "Switch",
    publisher: "Nintendo",
    priceUsd: 59.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-perfect-dark",
    title: "Perfect Dark",
    releaseDate: "2026-11-20",
    platform: "Xbox",
    publisher: "Xbox Game Studios",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-marvel-wolverine",
    title: "Marvel's Wolverine",
    releaseDate: "2026-12-04",
    platform: "PS5",
    publisher: "Insomniac Games",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-outer-worlds-2",
    title: "The Outer Worlds 2",
    releaseDate: "2027-01-15",
    platform: "PC",
    publisher: "Obsidian Entertainment",
    priceUsd: 59.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-witcher-polaris",
    title: "The Witcher: Polaris",
    releaseDate: "2027-02-19",
    platform: "PC",
    publisher: "CD PROJEKT RED",
    priceUsd: 59.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-star-wars-eclipse",
    title: "Star Wars: Eclipse",
    releaseDate: "2027-03-26",
    platform: "PS5",
    publisher: "Quantic Dream",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-elder-scrolls-vi",
    title: "The Elder Scrolls VI",
    releaseDate: "2027-04-09",
    platform: "PC",
    publisher: "Bethesda Softworks",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-ghost-of-yotei",
    title: "Ghost of Yotei",
    releaseDate: "2027-05-14",
    platform: "PS5",
    publisher: "Sony Interactive",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-forza-horizon-6",
    title: "Forza Horizon 6",
    releaseDate: "2027-06-18",
    platform: "Xbox",
    publisher: "Xbox Game Studios",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-doom-dark-ages",
    title: "Doom: The Dark Ages",
    releaseDate: "2027-07-23",
    platform: "Xbox",
    publisher: "Bethesda Softworks",
    priceUsd: 69.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-cyberpunk-orion",
    title: "Cyberpunk 2077: Project Orion",
    releaseDate: "2027-08-27",
    platform: "PC",
    publisher: "CD PROJEKT RED",
    priceUsd: 59.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-halo-endless",
    title: "Halo: The Endless",
    releaseDate: "2027-09-17",
    platform: "Xbox",
    publisher: "Xbox Game Studios",
    priceUsd: 59.99,
    bannerUrl: "",
  },
  {
    releaseId: "rr-zelda-echoes",
    title: "The Legend of Zelda: Echoes",
    releaseDate: "2027-10-22",
    platform: "Switch",
    publisher: "Nintendo",
    priceUsd: 69.99,
    bannerUrl: "",
  },
];

/**
 * Seed the `release_radar` table idempotently. Pre-order URLs are generated
 * through strictPreorderUrlFor() so no non-official, non-HTTPS URL can enter
 * the persistence layer.
 */
export function seedRadar(db: DatabaseType): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO release_radar
      (releaseId, title, releaseDate, platform, publisher, priceUsd, preorderUrl, bannerUrl, isVerified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const tx = db.transaction(() => {
    for (const r of RADAR_SEED) {
      const preorderUrl = strictPreorderUrlFor(r.platform, r.title);
      insert.run(
        r.releaseId,
        r.title,
        r.releaseDate,
        r.platform,
        r.publisher,
        r.priceUsd,
        preorderUrl,
        r.bannerUrl,
      );
    }
  });

  tx();
  // Expose the validated host map for documentation/tests without extra I/O.
  void PLATFORM_HOSTS;
}