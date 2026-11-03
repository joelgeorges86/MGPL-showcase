export type SeedUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  displayName: string;
  avatarUrl: string | null;
  gamerTag: string | null;
  profileVisibility: string;
  role: string;
};

export const DEV_USERS: SeedUser[] = [
  {
    id: "dev-user-alex",
    email: "alex.dev@mgpl.local",
    passwordHash: null,
    displayName: "Alex Dev",
    avatarUrl: null,
    gamerTag: "AlexBuilds",
    profileVisibility: "private",
    role: "user",
  },
  {
    id: "dev-user-morgan",
    email: "morgan.ops@mgpl.local",
    passwordHash: null,
    displayName: "Morgan Ops",
    avatarUrl: null,
    gamerTag: "MorganOps",
    profileVisibility: "private",
    role: "Leadership",
  },
  {
    id: "legacy-guest",
    email: "legacy.guest@mgpl.local",
    passwordHash: null,
    displayName: "Legacy Guest",
    avatarUrl: null,
    gamerTag: null,
    profileVisibility: "private",
    role: "user",
  },
];

export const DEV_GAMES = [
  {
    GameID: "elden-ring",
    "Game Title": "Elden Ring",
    "Primary Genre": "Action RPG",
    "Storage Size": "60 GB",
    "Min RAM GB": 12,
    "Min VRAM GB": 6,
    "SSD Required?": "Yes",
    Active: "Yes",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/eldenring",
    nexusModCount: 5000,
    trackedModCount: 180,
    platformStoreUrls: "https://store.steampowered.com/app/1245620/",
    storeUrl: "https://store.steampowered.com/app/1245620/",
    storefront: "Steam",
  },
  {
    GameID: "baldurs-gate-3",
    "Game Title": "Baldur's Gate 3",
    "Primary Genre": "RPG",
    "Storage Size": "150 GB",
    "Min RAM GB": 16,
    "Min VRAM GB": 8,
    "SSD Required?": "Yes",
    Active: "Yes",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/baldursgate3",
    nexusModCount: 15000,
    trackedModCount: 420,
    platformStoreUrls: "https://store.steampowered.com/app/1086940/",
    storeUrl: "https://store.steampowered.com/app/1086940/",
    storefront: "Steam",
  },
  {
    GameID: "stardew-valley",
    "Game Title": "Stardew Valley",
    "Primary Genre": "Simulation",
    "Storage Size": "1 GB",
    "Min RAM GB": 2,
    "Min VRAM GB": 0,
    "SSD Required?": "No",
    Active: "Yes",
    cover_url: "",
    nexusUrl: "https://www.nexusmods.com/stardewvalley",
    nexusModCount: 8000,
    trackedModCount: 260,
    platformStoreUrls: "https://store.steampowered.com/app/413150/",
    storeUrl: "https://store.steampowered.com/app/413150/",
    storefront: "Steam",
  },
];

export const DEV_OWNERSHIP = [
  {
    OwnershipID: "own-dev-elden-ring",
    GameID: "elden-ring",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/1245620/",
    Edition: "Standard",
    Format: "Digital",
    "Ownership Access Type": "Owned",
    Currency: "USD",
    platformCanonical: "PC",
  },
  {
    OwnershipID: "own-dev-bg3",
    GameID: "baldurs-gate-3",
    Platform: "Steam",
    "Store URL": "https://store.steampowered.com/app/1086940/",
    Edition: "Digital Deluxe",
    Format: "Digital",
    "Ownership Access Type": "Owned",
    Currency: "USD",
    platformCanonical: "PC",
  },
];

export const DEV_TRACKING = [
  {
    GameID: "elden-ring",
    "Play Status": "Playing",
    "Hours Played": 120,
    "Played Platform": "Steam",
    "Played Hardware Device": "dev-rig-main",
    targetFps: "60",
    resolution: "1440p",
  },
  {
    GameID: "baldurs-gate-3",
    "Play Status": "Backlog",
    "Hours Played": 18,
    "Played Platform": "Steam",
    "Played Hardware Device": "dev-rig-main",
    targetFps: "60",
    resolution: "1440p",
  },
];

export const DEV_DEVICES = [
  {
    id: "dev-rig-main",
    userId: "dev-user-alex",
    deviceName: "Alex Main Rig",
    deviceType: "desktop",
    cpuModel: "AMD Ryzen 7 7800X3D",
    cpuCores: 8,
    ramGb: 32,
    gpuModel: "NVIDIA GeForce RTX 4080",
    vramGb: 16,
    gpuType: "dedicated",
    storageType: "NVMe",
    storageFreeGb: 1400,
    isPortable: 0,
    isPrimary: 1,
  },
  {
    id: "dev-handheld-ally",
    userId: "dev-user-morgan",
    deviceName: "ROG Ally Dev Kit",
    deviceType: "handheld",
    cpuModel: "AMD Ryzen Z1 Extreme",
    cpuCores: 8,
    ramGb: 16,
    gpuModel: "AMD Radeon 780M",
    vramGb: 4,
    gpuType: "integrated",
    storageType: "NVMe",
    storageFreeGb: 380,
    isPortable: 1,
    isPrimary: 1,
  },
];

export const DEV_WISHLIST = [
  {
    userId: "dev-user-alex",
    gameId: "monster-hunter-wilds",
    title: "Monster Hunter Wilds",
    coverImage: "",
    targetPrice: 49.99,
    currentBestPrice: 59.99,
    bestStore: "Steam",
    bestStoreType: "Direct Platform",
    historicalLow: 59.99,
    isTriggered: 0,
    notes: "Waiting for launch discount.",
  },
];

export const DEV_PRICE_ALERTS = [
  {
    userId: "dev-user-alex",
    gameId: "elden-ring",
    title: "Elden Ring",
    targetPrice: 29.99,
    currentPrice: 39.99,
    historicalLow: 29.99,
    isTriggered: 0,
  },
  {
    userId: "dev-user-morgan",
    gameId: "baldurs-gate-3",
    title: "Baldur's Gate 3",
    targetPrice: 44.99,
    currentPrice: 44.99,
    historicalLow: 44.99,
    isTriggered: 1,
  },
];

export const DEV_TAGS = [
  {
    userId: "dev-user-alex",
    gameId: "elden-ring",
    tagName: "soulslike",
    colorHex: "#f97316",
  },
  {
    userId: "dev-user-morgan",
    gameId: "baldurs-gate-3",
    tagName: "coop-candidate",
    colorHex: "#8b5cf6",
  },
];

export const DEV_NOTES = [
  {
    userId: "dev-user-alex",
    gameId: "elden-ring",
    noteMarkdown: "Re-test after DLSS patch lands.",
  },
];
