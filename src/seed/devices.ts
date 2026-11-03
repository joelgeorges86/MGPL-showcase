import { Database as DatabaseType } from 'better-sqlite3';

/**
 * Sprint 1 (EPIC-DEV-001): Browsable Hardware Catalog seed data.
 *
 * 54 realistic hardware profiles spanning consoles (PS5 family, Xbox Series,
 * Switch family), handheld gaming PCs (Steam Deck, ROG Ally, Legion Go,
 * MSI Claw, AYANEO, GPD), prebuilt desktops (Alienware, ASUS ROG, MSI,
 * CyberPower, iBUYPOWER, Corsair, Lenovo, HP Omen, Acer, NZXT) and gaming
 * laptops. Device rows land in the `devices` table and spec rows in
 * `device_specs` (UNIQUE deviceId). The seed is idempotent (INSERT OR
 * IGNORE) and re-runs safely on every server boot.
 */

export type GpuTier = 'enthusiast' | 'high' | 'mid' | 'entry' | 'integrated';
export type CpuTier = 'flagship' | 'high' | 'mid' | 'entry';

export interface HardwareProfileSeed {
  id: string;
  name: string;
  brand: string;
  type: 'PC' | 'Console' | 'Handheld';
  releaseDate: string;
  msrp: number;
  imageUrl: string;
  isPrebuilt: boolean;
  /**
   * DPM-05: optional EPIC-04 canonical platform label. When omitted it is
   * derived deterministically at seed time from the device name/type (PC-family
   * for handhelds/desktops/laptops; console family for console-named devices),
   * so a Switch-family "Handheld" row still resolves to "Console – Nintendo".
   */
  platformCanonical?: string;
  specs: {
    cpuModel: string;
    gpuModel: string;
    gpuVramGb: number;
    ramGb: number;
    storageGb: number;
    tdpWatts: number;
    gpuTier: GpuTier;
    cpuTier: CpuTier;
  };
}

const img = (slug: string): string => `https://images.unsplash.com/photo-1547394765-185e1e68f34e?w=200&q=60&sig=${slug}`;

/**
 * DPM-05: deterministic canonical platform derivation for catalog devices.
 * Console-named devices map to their EPIC-04 canonical label; everything else
 * (desktop / laptop / handheld gaming PC) is PC-family. The Switch family is
 * type 'Handheld' in the catalog but is canonically a Nintendo console.
 */
function deriveCatalogPlatform(name: string): string {
  const n = name.toLowerCase();
  if (/playstation|ps[345]|ps vita|psp/.test(n)) return 'Console – PlayStation';
  if (/xbox/.test(n)) return 'Console – Xbox';
  if (/nintendo|switch|wii|3ds/.test(n)) return 'Console – Nintendo';
  return 'PC';
}

export const HARDWARE_PROFILES: HardwareProfileSeed[] = [
  // -------------------------------------------------------------------------
  // Consoles
  // -------------------------------------------------------------------------
  {
    id: 'ps5', name: 'PlayStation 5', brand: 'Sony', type: 'Console',
    releaseDate: '2020-11-12', msrp: 499.99, imageUrl: img('ps5'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 8C/16T (custom)', gpuModel: 'AMD RDNA 2 (custom · 10.3 TFLOPS)',
      gpuVramGb: 16, ramGb: 16, storageGb: 825, tdpWatts: 200,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'ps5-slim', name: 'PlayStation 5 Slim', brand: 'Sony', type: 'Console',
    releaseDate: '2023-11-10', msrp: 449.99, imageUrl: img('ps5slim'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 8C/16T (custom)', gpuModel: 'AMD RDNA 2 (custom · 10.3 TFLOPS)',
      gpuVramGb: 16, ramGb: 16, storageGb: 1024, tdpWatts: 190,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'ps5-pro', name: 'PlayStation 5 Pro', brand: 'Sony', type: 'Console',
    releaseDate: '2024-11-07', msrp: 699.99, imageUrl: img('ps5pro'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 8C/16T (custom, up to 3.85 GHz)', gpuModel: 'AMD RDNA 3 (custom · 16.7 TFLOPS)',
      gpuVramGb: 16, ramGb: 16, storageGb: 2048, tdpWatts: 220,
      gpuTier: 'enthusiast', cpuTier: 'high',
    },
  },
  {
    id: 'xbox-series-x', name: 'Xbox Series X', brand: 'Microsoft', type: 'Console',
    releaseDate: '2020-11-10', msrp: 499.99, imageUrl: img('xboxsx'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 8C/16T (custom · 3.8 GHz)', gpuModel: 'AMD RDNA 2 (custom · 12 TFLOPS)',
      gpuVramGb: 16, ramGb: 16, storageGb: 1024, tdpWatts: 210,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'xbox-series-s', name: 'Xbox Series S', brand: 'Microsoft', type: 'Console',
    releaseDate: '2020-11-10', msrp: 299.99, imageUrl: img('xboxss'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 8C/16T (custom · 3.6 GHz)', gpuModel: 'AMD RDNA 2 (custom · 4 TFLOPS)',
      gpuVramGb: 8, ramGb: 10, storageGb: 512, tdpWatts: 120,
      gpuTier: 'mid', cpuTier: 'high',
    },
  },
  {
    id: 'switch-classic', name: 'Nintendo Switch', brand: 'Nintendo', type: 'Handheld',
    releaseDate: '2017-03-03', msrp: 299.99, imageUrl: img('switchc'), isPrebuilt: true,
    specs: {
      cpuModel: 'NVIDIA Tegra X1 (custom)', gpuModel: 'NVIDIA Maxwell (256 CUDA cores)',
      gpuVramGb: 4, ramGb: 4, storageGb: 32, tdpWatts: 15,
      gpuTier: 'entry', cpuTier: 'entry',
    },
  },
  {
    id: 'switch-lite', name: 'Nintendo Switch Lite', brand: 'Nintendo', type: 'Handheld',
    releaseDate: '2019-09-20', msrp: 199.99, imageUrl: img('switchl'), isPrebuilt: true,
    specs: {
      cpuModel: 'NVIDIA Tegra X1 (custom, pared down)', gpuModel: 'NVIDIA Maxwell (256 CUDA cores)',
      gpuVramGb: 4, ramGb: 4, storageGb: 32, tdpWatts: 10,
      gpuTier: 'entry', cpuTier: 'entry',
    },
  },
  {
    id: 'switch-oled', name: 'Nintendo Switch OLED', brand: 'Nintendo', type: 'Handheld',
    releaseDate: '2021-10-08', msrp: 349.99, imageUrl: img('switcho'), isPrebuilt: true,
    specs: {
      cpuModel: 'NVIDIA Tegra X1 (custom, 7nm revision)', gpuModel: 'NVIDIA Maxwell (256 CUDA cores)',
      gpuVramGb: 4, ramGb: 4, storageGb: 64, tdpWatts: 12,
      gpuTier: 'entry', cpuTier: 'entry',
    },
  },
  // DPM-05: older/legacy console family entries that were missing from the
  // catalog. platformCanonical is derived automatically at seed time.
  {
    id: 'ps4', name: 'PlayStation 4', brand: 'Sony', type: 'Console',
    releaseDate: '2013-11-15', msrp: 399.99, imageUrl: img('ps4'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Jaguar 8C (custom, 1.6 GHz)', gpuModel: 'AMD GCN (custom · 1.84 TFLOPS)',
      gpuVramGb: 8, ramGb: 8, storageGb: 500, tdpWatts: 165,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'ps4-pro', name: 'PlayStation 4 Pro', brand: 'Sony', type: 'Console',
    releaseDate: '2016-11-10', msrp: 399.99, imageUrl: img('ps4pro'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Jaguar 8C (custom, 2.1 GHz)', gpuModel: 'AMD GCN (custom · 4.2 TFLOPS)',
      gpuVramGb: 8, ramGb: 8, storageGb: 1000, tdpWatts: 200,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'switch-v2', name: 'Nintendo Switch V2', brand: 'Nintendo', type: 'Handheld',
    releaseDate: '2019-08-01', msrp: 299.99, imageUrl: img('switchv2'), isPrebuilt: true,
    specs: {
      cpuModel: 'NVIDIA Tegra X1 (custom, rev E)', gpuModel: 'NVIDIA Maxwell (256 CUDA cores)',
      gpuVramGb: 4, ramGb: 4, storageGb: 32, tdpWatts: 11,
      gpuTier: 'entry', cpuTier: 'entry',
    },
  },
  {
    id: 'xbox-series-s-1tb', name: 'Xbox Series S 1TB', brand: 'Microsoft', type: 'Console',
    releaseDate: '2023-09-01', msrp: 349.99, imageUrl: img('xboxss1tb'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 8C/16T (custom · 3.6 GHz)', gpuModel: 'AMD RDNA 2 (custom · 4 TFLOPS)',
      gpuVramGb: 8, ramGb: 10, storageGb: 1024, tdpWatts: 120,
      gpuTier: 'mid', cpuTier: 'high',
    },
  },
  // -------------------------------------------------------------------------
  // Handheld PCs
  // -------------------------------------------------------------------------
  {
    id: 'steam-deck-lcd', name: 'Steam Deck LCD', brand: 'Valve', type: 'Handheld',
    releaseDate: '2022-02-25', msrp: 399.99, imageUrl: img('decklcd'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 4C/8T (custom APU)', gpuModel: 'AMD RDNA 2 (custom APU · 8 RDNA CUs)',
      gpuVramGb: 16, ramGb: 16, storageGb: 256, tdpWatts: 15,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'steam-deck-oled', name: 'Steam Deck OLED', brand: 'Valve', type: 'Handheld',
    releaseDate: '2023-11-16', msrp: 549.99, imageUrl: img('deckoled'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Zen 2 4C/8T (custom APU, 6nm)', gpuModel: 'AMD RDNA 2 (custom APU · 8 RDNA CUs)',
      gpuVramGb: 16, ramGb: 16, storageGb: 512, tdpWatts: 15,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'rog-ally', name: 'ASUS ROG Ally', brand: 'ASUS', type: 'Handheld',
    releaseDate: '2023-06-13', msrp: 599.99, imageUrl: img('rogally'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen Z1 Extreme (8C/16T)', gpuModel: 'AMD RDNA 3 (custom · 12 RDNA 3 CUs)',
      gpuVramGb: 16, ramGb: 16, storageGb: 512, tdpWatts: 30,
      gpuTier: 'high', cpuTier: 'mid',
    },
  },
  {
    id: 'rog-ally-x', name: 'ASUS ROG Ally X', brand: 'ASUS', type: 'Handheld',
    releaseDate: '2024-06-18', msrp: 799.99, imageUrl: img('rogallyx'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen Z1 Extreme (8C/16T)', gpuModel: 'AMD RDNA 3 (custom · 12 RDNA 3 CUs)',
      gpuVramGb: 24, ramGb: 24, storageGb: 1024, tdpWatts: 30,
      gpuTier: 'high', cpuTier: 'mid',
    },
  },
  {
    id: 'legion-go', name: 'Lenovo Legion Go', brand: 'Lenovo', type: 'Handheld',
    releaseDate: '2023-10-31', msrp: 699.99, imageUrl: img('legiongo'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen Z1 Extreme (8C/16T)', gpuModel: 'AMD RDNA 3 (custom · 12 RDNA 3 CUs)',
      gpuVramGb: 16, ramGb: 16, storageGb: 512, tdpWatts: 30,
      gpuTier: 'high', cpuTier: 'mid',
    },
  },
  {
    id: 'legion-go-s', name: 'Lenovo Legion Go S', brand: 'Lenovo', type: 'Handheld',
    releaseDate: '2025-01-07', msrp: 499.99, imageUrl: img('legiongos'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen Z2 Go (6C/12T)', gpuModel: 'AMD RDNA 2 (custom · 8 RDNA 2 CUs)',
      gpuVramGb: 16, ramGb: 16, storageGb: 512, tdpWatts: 25,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'msi-claw', name: 'MSI Claw', brand: 'MSI', type: 'Handheld',
    releaseDate: '2024-03-08', msrp: 699.99, imageUrl: img('msiclaw'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core Ultra 7 155H (16C/22T)', gpuModel: 'Intel Arc (8 Xe cores, iGPU)',
      gpuVramGb: 16, ramGb: 16, storageGb: 512, tdpWatts: 35,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'ayaneo-2s', name: 'AYANEO 2S', brand: 'AYANEO', type: 'Handheld',
    releaseDate: '2023-05-20', msrp: 1299.0, imageUrl: img('ayaneo2s'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 7840U (8C/16T)', gpuModel: 'AMD Radeon 780M (12 RDNA 3 CUs, iGPU)',
      gpuVramGb: 32, ramGb: 32, storageGb: 2048, tdpWatts: 35,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'gpd-win-4', name: 'GPD Win 4', brand: 'GPD', type: 'Handheld',
    releaseDate: '2023-02-28', msrp: 999.0, imageUrl: img('gpdwin4'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 6800U (8C/16T)', gpuModel: 'AMD Radeon 680M (12 RDNA 2 CUs, iGPU)',
      gpuVramGb: 32, ramGb: 32, storageGb: 2048, tdpWatts: 28,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'onexplayer-x1', name: 'OneXPlayer X1', brand: 'OneXPlayer', type: 'Handheld',
    releaseDate: '2024-03-30', msrp: 999.0, imageUrl: img('onexx1'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core Ultra 7 155H (16C/22T)', gpuModel: 'Intel Arc (8 Xe cores, iGPU)',
      gpuVramGb: 32, ramGb: 32, storageGb: 2048, tdpWatts: 28,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  // -------------------------------------------------------------------------
  // Prebuilt desktops
  // -------------------------------------------------------------------------
  {
    id: 'alienware-aurora-r13', name: 'Alienware Aurora R13', brand: 'Dell Alienware', type: 'PC',
    releaseDate: '2021-11-15', msrp: 1699.99, imageUrl: img('aurorar13'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-12700KF (12C/20T)', gpuModel: 'NVIDIA GeForce RTX 3070 Ti',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 650,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'alienware-aurora-r15', name: 'Alienware Aurora R15', brand: 'Dell Alienware', type: 'PC',
    releaseDate: '2023-07-10', msrp: 2199.99, imageUrl: img('aurorar15'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13900KF (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4080',
      gpuVramGb: 16, ramGb: 32, storageGb: 2048, tdpWatts: 1350,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'alienware-aurora-r16', name: 'Alienware Aurora R16', brand: 'Dell Alienware', type: 'PC',
    releaseDate: '2024-01-15', msrp: 1899.99, imageUrl: img('aurorar16'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13900F (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4070 Ti',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 1000,
      gpuTier: 'high', cpuTier: 'flagship',
    },
  },
  {
    id: 'asus-rog-g13ch', name: 'ASUS ROG G13CH', brand: 'ASUS', type: 'PC',
    releaseDate: '2023-04-05', msrp: 1499.99, imageUrl: img('g13ch'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-13700F (16C/24T)', gpuModel: 'NVIDIA GeForce RTX 4070',
      gpuVramGb: 12, ramGb: 16, storageGb: 1024, tdpWatts: 700,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'asus-rog-g22ch', name: 'ASUS ROG G22CH (Compact)', brand: 'ASUS', type: 'PC',
    releaseDate: '2022-09-01', msrp: 1299.99, imageUrl: img('g22ch'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-12700F (12C/20T)', gpuModel: 'NVIDIA GeForce RTX 3060 Ti',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 600,
      gpuTier: 'mid', cpuTier: 'high',
    },
  },
  {
    id: 'asus-rog-strix-g16-gaming', name: 'ASUS ROG Strix G16 Gaming Desktop', brand: 'ASUS', type: 'PC',
    releaseDate: '2023-06-01', msrp: 1799.99, imageUrl: img('g16gaming'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 7700X (8C/16T)', gpuModel: 'NVIDIA GeForce RTX 4080',
      gpuVramGb: 16, ramGb: 32, storageGb: 2048, tdpWatts: 850,
      gpuTier: 'enthusiast', cpuTier: 'high',
    },
  },
  {
    id: 'msi-infinite-rs', name: 'MSI Infinite RS', brand: 'MSI', type: 'PC',
    releaseDate: '2023-06-20', msrp: 1899.99, imageUrl: img('infiniters'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13900K (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4070 Ti',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 1000,
      gpuTier: 'high', cpuTier: 'flagship',
    },
  },
  {
    id: 'msi-codex-r', name: 'MSI Codex R', brand: 'MSI', type: 'PC',
    releaseDate: '2022-08-15', msrp: 1099.99, imageUrl: img('codexr'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i5-12400F (6C/12T)', gpuModel: 'NVIDIA GeForce RTX 3060',
      gpuVramGb: 12, ramGb: 16, storageGb: 1024, tdpWatts: 500,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'cyberpower-gamer-xtreme', name: 'CyberPowerPC Gamer Xtreme VR', brand: 'CyberPowerPC', type: 'PC',
    releaseDate: '2023-03-12', msrp: 1599.99, imageUrl: img('gamerxtreme'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-13700F (16C/24T)', gpuModel: 'NVIDIA GeForce RTX 4060 Ti',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 650,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'cyberpower-supreme', name: 'CyberPowerPC Supreme XT', brand: 'CyberPowerPC', type: 'PC',
    releaseDate: '2024-02-25', msrp: 2499.99, imageUrl: img('supremext'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 9 7950X3D (16C/32T)', gpuModel: 'NVIDIA GeForce RTX 4080 Super',
      gpuVramGb: 16, ramGb: 32, storageGb: 2048, tdpWatts: 1200,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'ibuypower-element', name: 'iBUYPOWER Element MR', brand: 'iBUYPOWER', type: 'PC',
    releaseDate: '2023-05-18', msrp: 1499.99, imageUrl: img('elementmr'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-13700F (16C/24T)', gpuModel: 'NVIDIA GeForce RTX 4070',
      gpuVramGb: 12, ramGb: 16, storageGb: 1024, tdpWatts: 700,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'ibuypower-y40', name: 'iBUYPOWER Y40', brand: 'iBUYPOWER', type: 'PC',
    releaseDate: '2022-11-20', msrp: 1399.99, imageUrl: img('y40'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 5800X (8C/16T)', gpuModel: 'NVIDIA GeForce RTX 3070',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 650,
      gpuTier: 'high', cpuTier: 'mid',
    },
  },
  {
    id: 'corsair-vengeance-a7200', name: 'Corsair Vengeance A7200', brand: 'Corsair', type: 'PC',
    releaseDate: '2023-09-22', msrp: 2199.99, imageUrl: img('vena7200'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 7800X3D (8C/16T)', gpuModel: 'NVIDIA GeForce RTX 4080',
      gpuVramGb: 16, ramGb: 32, storageGb: 2048, tdpWatts: 1000,
      gpuTier: 'enthusiast', cpuTier: 'high',
    },
  },
  {
    id: 'corsair-vengeance-i7500', name: 'Corsair Vengeance i7500', brand: 'Corsair', type: 'PC',
    releaseDate: '2024-03-08', msrp: 2499.99, imageUrl: img('veni7500'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-14900K (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4070 Ti Super',
      gpuVramGb: 16, ramGb: 32, storageGb: 2048, tdpWatts: 1200,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'lenovo-legion-tower-5', name: 'Lenovo Legion Tower 5', brand: 'Lenovo', type: 'PC',
    releaseDate: '2023-02-10', msrp: 1399.99, imageUrl: img('legiont5'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 7700 (8C/16T)', gpuModel: 'NVIDIA GeForce RTX 4060 Ti',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 650,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'lenovo-legion-tower-7i', name: 'Lenovo Legion Tower 7i', brand: 'Lenovo', type: 'PC',
    releaseDate: '2023-04-15', msrp: 1999.99, imageUrl: img('legiont7i'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-13700KF (16C/24T)', gpuModel: 'NVIDIA GeForce RTX 4070 Ti',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 850,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'hp-omen-25l', name: 'HP Omen 25L', brand: 'HP', type: 'PC',
    releaseDate: '2021-02-15', msrp: 1199.99, imageUrl: img('omen25l'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i5-11400F (6C/12T)', gpuModel: 'NVIDIA GeForce RTX 3060 Ti',
      gpuVramGb: 8, ramGb: 16, storageGb: 512, tdpWatts: 500,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'hp-omen-45l', name: 'HP Omen 45L', brand: 'HP', type: 'PC',
    releaseDate: '2022-08-25', msrp: 2099.99, imageUrl: img('omen45l'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-12700K (12C/20T)', gpuModel: 'NVIDIA GeForce RTX 3080',
      gpuVramGb: 10, ramGb: 32, storageGb: 2048, tdpWatts: 750,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'acer-predator-orion-3000', name: 'Acer Predator Orion 3000', brand: 'Acer', type: 'PC',
    releaseDate: '2023-03-08', msrp: 1299.99, imageUrl: img('orion3000'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i5-13400F (10C/16T)', gpuModel: 'NVIDIA GeForce RTX 4060',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 550,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'acer-predator-orion-5000', name: 'Acer Predator Orion 5000', brand: 'Acer', type: 'PC',
    releaseDate: '2022-07-05', msrp: 1599.99, imageUrl: img('orion5000'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-12700KF (12C/20T)', gpuModel: 'NVIDIA GeForce RTX 3080',
      gpuVramGb: 10, ramGb: 32, storageGb: 1024, tdpWatts: 750,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'nzxt-player-one', name: 'NZXT Player: One', brand: 'NZXT', type: 'PC',
    releaseDate: '2023-08-20', msrp: 1099.99, imageUrl: img('playerone'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i5-13400F (10C/16T)', gpuModel: 'NVIDIA GeForce RTX 4060',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 550,
      gpuTier: 'mid', cpuTier: 'mid',
    },
  },
  {
    id: 'nzxt-player-two', name: 'NZXT Player: Two', brand: 'NZXT', type: 'PC',
    releaseDate: '2023-08-20', msrp: 1549.99, imageUrl: img('playertwo'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i5-13400F (10C/16T)', gpuModel: 'NVIDIA GeForce RTX 4070',
      gpuVramGb: 12, ramGb: 16, storageGb: 1024, tdpWatts: 700,
      gpuTier: 'high', cpuTier: 'mid',
    },
  },
  // -------------------------------------------------------------------------
  // Gaming laptops
  // -------------------------------------------------------------------------
  {
    id: 'alienware-m16-r2', name: 'Alienware m16 R2', brand: 'Dell Alienware', type: 'PC',
    releaseDate: '2024-03-15', msrp: 1799.99, imageUrl: img('m16r2'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core Ultra 7 155H (16C/22T)', gpuModel: 'NVIDIA GeForce RTX 4070 Laptop',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 140,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'alienware-m18-r2', name: 'Alienware m18 R2', brand: 'Dell Alienware', type: 'PC',
    releaseDate: '2024-03-15', msrp: 2399.99, imageUrl: img('m18r2'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-14900HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4080 Laptop',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 200,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'asus-rog-zephyrus-g14', name: 'ASUS ROG Zephyrus G14', brand: 'ASUS', type: 'PC',
    releaseDate: '2024-02-28', msrp: 1599.99, imageUrl: img('zephg14'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 9 8945HS (8C/16T)', gpuModel: 'NVIDIA GeForce RTX 4060 Laptop',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 115,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'asus-rog-zephyrus-g16', name: 'ASUS ROG Zephyrus G16', brand: 'ASUS', type: 'PC',
    releaseDate: '2024-02-28', msrp: 1999.99, imageUrl: img('zephg16'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core Ultra 9 185H (16C/22T)', gpuModel: 'NVIDIA GeForce RTX 4070 Laptop',
      gpuVramGb: 8, ramGb: 32, storageGb: 2048, tdpWatts: 145,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'asus-rog-strix-scar-18', name: 'ASUS ROG Strix Scar 18', brand: 'ASUS', type: 'PC',
    releaseDate: '2023-05-05', msrp: 3299.99, imageUrl: img('scar18'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13980HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4090 Laptop',
      gpuVramGb: 16, ramGb: 32, storageGb: 2048, tdpWatts: 250,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'msi-raider-ge78', name: 'MSI Raider GE78 HX', brand: 'MSI', type: 'PC',
    releaseDate: '2023-04-12', msrp: 2799.99, imageUrl: img('raiderge78'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13980HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4080 Laptop',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 200,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'lenovo-legion-pro-7', name: 'Lenovo Legion Pro 7i', brand: 'Lenovo', type: 'PC',
    releaseDate: '2023-08-10', msrp: 2399.99, imageUrl: img('legionpro7'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13900HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4070 Laptop',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 170,
      gpuTier: 'high', cpuTier: 'flagship',
    },
  },
  {
    id: 'lenovo-legion-5', name: 'Lenovo Legion 5', brand: 'Lenovo', type: 'PC',
    releaseDate: '2022-05-15', msrp: 1299.99, imageUrl: img('legion5'), isPrebuilt: true,
    specs: {
      cpuModel: 'AMD Ryzen 7 6800H (8C/16T)', gpuModel: 'NVIDIA GeForce RTX 3060 Laptop',
      gpuVramGb: 6, ramGb: 16, storageGb: 512, tdpWatts: 130,
      gpuTier: 'mid', cpuTier: 'high',
    },
  },
  {
    id: 'acer-predator-helios-16', name: 'Acer Predator Helios 16', brand: 'Acer', type: 'PC',
    releaseDate: '2023-06-15', msrp: 1899.99, imageUrl: img('helios16'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13900HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4060 Laptop',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 170,
      gpuTier: 'high', cpuTier: 'flagship',
    },
  },
  {
    id: 'hp-omen-16', name: 'HP Omen 16', brand: 'HP', type: 'PC',
    releaseDate: '2023-02-20', msrp: 1499.99, imageUrl: img('omen16'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-13700HX (16C/24T)', gpuModel: 'NVIDIA GeForce RTX 4060 Laptop',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 150,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'cyberpower-tracer-vii', name: 'CyberPowerPC Tracer VII', brand: 'CyberPowerPC', type: 'PC',
    releaseDate: '2023-09-05', msrp: 1799.99, imageUrl: img('tracervii'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i7-13700HX (16C/24T)', gpuModel: 'NVIDIA GeForce RTX 4070 Laptop',
      gpuVramGb: 8, ramGb: 16, storageGb: 1024, tdpWatts: 165,
      gpuTier: 'high', cpuTier: 'high',
    },
  },
  {
    id: 'gigabyte-aorus-17x', name: 'GIGABYTE Aorus 17X', brand: 'GIGABYTE', type: 'PC',
    releaseDate: '2023-07-25', msrp: 2599.99, imageUrl: img('aorus17x'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13980HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4080 Laptop',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 200,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'razer-blade-16', name: 'Razer Blade 16', brand: 'Razer', type: 'PC',
    releaseDate: '2023-04-01', msrp: 2699.99, imageUrl: img('blade16'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i9-13950HX (24C/32T)', gpuModel: 'NVIDIA GeForce RTX 4080 Laptop',
      gpuVramGb: 12, ramGb: 32, storageGb: 2048, tdpWatts: 200,
      gpuTier: 'enthusiast', cpuTier: 'flagship',
    },
  },
  {
    id: 'msi-thin-gf63', name: 'MSI Thin GF63', brand: 'MSI', type: 'PC',
    releaseDate: '2022-10-10', msrp: 899.99, imageUrl: img('gf63'), isPrebuilt: true,
    specs: {
      cpuModel: 'Intel Core i5-12450H (8C/12T)', gpuModel: 'NVIDIA GeForce RTX 3050 Laptop',
      gpuVramGb: 4, ramGb: 16, storageGb: 512, tdpWatts: 90,
      gpuTier: 'entry', cpuTier: 'mid',
    },
  },
];

/**
 * Idempotent catalog seed. Inserts the `devices` + `device_specs` rows using
 * INSERT OR IGNORE keyed on devices.id / device_specs.deviceId so re-boots
 * never duplicate catalog entries. Runs on every server boot from initDb().
 */
export function seedDeviceCatalog(db: DatabaseType): void {
  const insertDevice = db.prepare(`
    INSERT OR IGNORE INTO "catalog_devices" (id, name, brand, type, releaseDate, msrp, imageUrl, isPrebuilt, platformCanonical)
    VALUES (@id, @name, @brand, @type, @releaseDate, @msrp, @imageUrl, @isPrebuilt, @platformCanonical)
  `);
  const insertSpecs = db.prepare(`
    INSERT OR IGNORE INTO "catalog_device_specs" (deviceId, cpuModel, gpuModel, gpuVramGb, ramGb, storageGb, tdpWatts, gpuTier, cpuTier)
    VALUES (@deviceId, @cpuModel, @gpuModel, @gpuVramGb, @ramGb, @storageGb, @tdpWatts, @gpuTier, @cpuTier)
  `);

  const tx = db.transaction(() => {
    for (const profile of HARDWARE_PROFILES) {
      insertDevice.run({
        id: profile.id,
        name: profile.name,
        brand: profile.brand,
        type: profile.type,
        releaseDate: profile.releaseDate,
        msrp: profile.msrp,
        imageUrl: profile.imageUrl,
        isPrebuilt: profile.isPrebuilt ? 1 : 0,
        platformCanonical: profile.platformCanonical || deriveCatalogPlatform(profile.name),
      });
      insertSpecs.run({
        deviceId: profile.id,
        cpuModel: profile.specs.cpuModel,
        gpuModel: profile.specs.gpuModel,
        gpuVramGb: profile.specs.gpuVramGb,
        ramGb: profile.specs.ramGb,
        storageGb: profile.specs.storageGb,
        tdpWatts: profile.specs.tdpWatts,
        gpuTier: profile.specs.gpuTier,
        cpuTier: profile.specs.cpuTier,
      });
    }
  });

  tx();
}