export interface PCComponent {
  id: string;
  name: string;
  category: 'gpu' | 'cpu' | 'ram' | 'motherboard' | 'case' | 'psu' | 'storage' | 'os';
  specs: {
    vramGb?: number;
    ramGb?: number;
    capacityGb?: number;
    socket?: string;
    formFactor?: string;
    wattage?: number;
    cores?: number;
    clockGHz?: number;
    type?: string;
  };
}

export const PC_COMPONENTS: Record<string, PCComponent[]> = {
  gpus: [
    { id: 'gpu-rtx-4090', name: 'NVIDIA GeForce RTX 4090', category: 'gpu', specs: { vramGb: 24 } },
    { id: 'gpu-rtx-4080-super', name: 'NVIDIA GeForce RTX 4080 Super', category: 'gpu', specs: { vramGb: 16 } },
    { id: 'gpu-rtx-4070-ti-super', name: 'NVIDIA GeForce RTX 4070 Ti Super', category: 'gpu', specs: { vramGb: 16 } },
    { id: 'gpu-rtx-4070-super', name: 'NVIDIA GeForce RTX 4070 Super', category: 'gpu', specs: { vramGb: 12 } },
    { id: 'gpu-rtx-4060-ti', name: 'NVIDIA GeForce RTX 4060 Ti', category: 'gpu', specs: { vramGb: 8 } },
    { id: 'gpu-rtx-4060', name: 'NVIDIA GeForce RTX 4060', category: 'gpu', specs: { vramGb: 8 } },
    { id: 'gpu-rx-7900-xtx', name: 'AMD Radeon RX 7900 XTX', category: 'gpu', specs: { vramGb: 24 } },
    { id: 'gpu-rx-7900-xt', name: 'AMD Radeon RX 7900 XT', category: 'gpu', specs: { vramGb: 20 } },
    { id: 'gpu-rx-7800-xt', name: 'AMD Radeon RX 7800 XT', category: 'gpu', specs: { vramGb: 16 } },
    { id: 'gpu-rx-7700-xt', name: 'AMD Radeon RX 7700 XT', category: 'gpu', specs: { vramGb: 12 } },
    { id: 'gpu-rx-7600', name: 'AMD Radeon RX 7600', category: 'gpu', specs: { vramGb: 8 } },
    { id: 'gpu-arc-a770', name: 'Intel Arc A770', category: 'gpu', specs: { vramGb: 16 } }
  ],
  cpus: [
    { id: 'cpu-7800x3d', name: 'AMD Ryzen 7 7800X3D', category: 'cpu', specs: { socket: 'AM5', cores: 8, clockGHz: 4.2 } },
    { id: 'cpu-7950x3d', name: 'AMD Ryzen 9 7950X3D', category: 'cpu', specs: { socket: 'AM5', cores: 16, clockGHz: 4.2 } },
    { id: 'cpu-7600x', name: 'AMD Ryzen 5 7600X', category: 'cpu', specs: { socket: 'AM5', cores: 6, clockGHz: 4.7 } },
    { id: 'cpu-14900k', name: 'Intel Core i9-14900K', category: 'cpu', specs: { socket: 'LGA1700', cores: 24, clockGHz: 3.2 } },
    { id: 'cpu-14700k', name: 'Intel Core i7-14700K', category: 'cpu', specs: { socket: 'LGA1700', cores: 20, clockGHz: 3.4 } },
    { id: 'cpu-14600k', name: 'Intel Core i5-14600K', category: 'cpu', specs: { socket: 'LGA1700', cores: 14, clockGHz: 3.5 } },
    { id: 'cpu-5800x3d', name: 'AMD Ryzen 7 5800X3D', category: 'cpu', specs: { socket: 'AM4', cores: 8, clockGHz: 3.4 } },
    { id: 'cpu-13400f', name: 'Intel Core i5-13400F', category: 'cpu', specs: { socket: 'LGA1700', cores: 10, clockGHz: 2.5 } }
  ],
  ram: [
    { id: 'ram-64gb-ddr5', name: '64GB (2x32GB) DDR5-6000 MHz', category: 'ram', specs: { ramGb: 64, type: 'DDR5' } },
    { id: 'ram-32gb-ddr5', name: '32GB (2x16GB) DDR5-6000 MHz', category: 'ram', specs: { ramGb: 32, type: 'DDR5' } },
    { id: 'ram-16gb-ddr5', name: '16GB (2x8GB) DDR5-5200 MHz', category: 'ram', specs: { ramGb: 16, type: 'DDR5' } },
    { id: 'ram-32gb-ddr4', name: '32GB (2x16GB) DDR4-3600 MHz', category: 'ram', specs: { ramGb: 32, type: 'DDR4' } },
    { id: 'ram-16gb-ddr4', name: '16GB (2x8GB) DDR4-3200 MHz', category: 'ram', specs: { ramGb: 16, type: 'DDR4' } },
    { id: 'ram-8gb-ddr4', name: '8GB (1x8GB) DDR4-2666 MHz', category: 'ram', specs: { ramGb: 8, type: 'DDR4' } }
  ],
  motherboards: [
    { id: 'mb-asus-rog-x670e', name: 'ASUS ROG Crosshair X670E Hero (AM5)', category: 'motherboard', specs: { socket: 'AM5', formFactor: 'ATX' } },
    { id: 'mb-msi-b650-tomahawk', name: 'MSI MAG B650 Tomahawk WiFi (AM5)', category: 'motherboard', specs: { socket: 'AM5', formFactor: 'ATX' } },
    { id: 'mb-gigabyte-b650m-ds3h', name: 'GIGABYTE B650M DS3H (AM5 Micro-ATX)', category: 'motherboard', specs: { socket: 'AM5', formFactor: 'Micro-ATX' } },
    { id: 'mb-asus-z790-e', name: 'ASUS ROG Strix Z790-E Gaming WiFi (LGA1700)', category: 'motherboard', specs: { socket: 'LGA1700', formFactor: 'ATX' } },
    { id: 'mb-msi-b760-pro', name: 'MSI PRO B760-P WiFi (LGA1700)', category: 'motherboard', specs: { socket: 'LGA1700', formFactor: 'ATX' } },
    { id: 'mb-msi-b550-gaming', name: 'MSI MPG B550 Gaming Plus (AM4)', category: 'motherboard', specs: { socket: 'AM4', formFactor: 'ATX' } }
  ],
  cases: [
    { id: 'case-corsair-4000d', name: 'Corsair 4000D Airflow Mid-Tower', category: 'case', specs: { formFactor: 'ATX Mid-Tower' } },
    { id: 'case-lianli-o11-dynamic', name: 'Lian Li O11 Dynamic EVO', category: 'case', specs: { formFactor: 'ATX Mid-Tower' } },
    { id: 'case-nzxt-h7-flow', name: 'NZXT H7 Flow Mid-Tower', category: 'case', specs: { formFactor: 'ATX Mid-Tower' } },
    { id: 'case-fractal-north', name: 'Fractal Design North ATX', category: 'case', specs: { formFactor: 'ATX Mid-Tower' } },
    { id: 'case-coolermaster-q300l', name: 'Cooler Master MasterBox Q300L Micro-ATX', category: 'case', specs: { formFactor: 'Micro-ATX' } }
  ],
  psus: [
    { id: 'psu-corsair-rm1000x', name: 'Corsair RM1000x 1000W 80+ Gold Fully Modular', category: 'psu', specs: { wattage: 1000 } },
    { id: 'psu-seasonic-focus-850', name: 'Seasonic Focus GX-850 850W 80+ Gold', category: 'psu', specs: { wattage: 850 } },
    { id: 'psu-corsair-rm750x', name: 'Corsair RM750x 750W 80+ Gold Fully Modular', category: 'psu', specs: { wattage: 750 } },
    { id: 'psu-evga-600-ba', name: 'EVGA 600 BA 600W 80+ Bronze', category: 'psu', specs: { wattage: 600 } }
  ],
  storage: [
    { id: 'storage-4tb-nvme', name: '4TB NVMe PCIe 4.0 M.2 SSD (7000 MB/s)', category: 'storage', specs: { capacityGb: 4000 } },
    { id: 'storage-2tb-nvme', name: '2TB NVMe PCIe 4.0 M.2 SSD (7000 MB/s)', category: 'storage', specs: { capacityGb: 2000 } },
    { id: 'storage-1tb-nvme', name: '1TB NVMe PCIe 4.0 M.2 SSD (5000 MB/s)', category: 'storage', specs: { capacityGb: 1000 } },
    { id: 'storage-2tb-sata', name: '2TB 2.5" SATA III SSD', category: 'storage', specs: { capacityGb: 2000 } },
    { id: 'storage-4tb-hdd', name: '4TB 3.5" 7200RPM HDD', category: 'storage', specs: { capacityGb: 4000 } }
  ],
  os: [
    { id: 'os-win-11-pro', name: 'Windows 11 Pro (64-bit)', category: 'os', specs: {} },
    { id: 'os-win-11-home', name: 'Windows 11 Home (64-bit)', category: 'os', specs: {} },
    { id: 'os-win-10-pro', name: 'Windows 10 Pro (64-bit)', category: 'os', specs: {} },
    { id: 'os-steamos', name: 'SteamOS 3.0 / Bazzite Linux', category: 'os', specs: {} },
    { id: 'os-ubuntu', name: 'Ubuntu Linux 24.04 LTS', category: 'os', specs: {} }
  ]
};

const RAM_KITS = PC_COMPONENTS.ram;
const STORAGE_DRIVES = PC_COMPONENTS.storage;
const OPERATING_SYSTEMS = PC_COMPONENTS.os;

// Expose alias keys so frontend lookups for ramKits, storageDrives, and operatingSystems succeed
PC_COMPONENTS.ramKits = RAM_KITS;
PC_COMPONENTS.storageDrives = STORAGE_DRIVES;
PC_COMPONENTS.operatingSystems = OPERATING_SYSTEMS;
