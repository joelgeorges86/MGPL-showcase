import { Database as DatabaseType } from 'better-sqlite3';

/**
 * Sprint 2 (EPIC-DEV-001): Custom PC Builder component & compatibility seed.
 *
 * Seeds the physical component catalog (device_components) and the declarative
 * compatibility rule set (compatibility_rules) that power the Custom PC
 * Builder. The seed is idempotent (INSERT OR IGNORE keyed on the natural keys)
 * and re-runs safely on every server boot from initDb().
 *
 * The form-factor fit ranking used by the compatibility engine:
 *   Mini-ITX (1) < Micro-ATX (2) < ATX (3)
 * A motherboard fits a case when the motherboard form factor rank is <= the
 * case form factor rank (an ATX case fits any board; an ITX case only fits ITX).
 */

export type ComponentCategory =
  | 'CPU'
  | 'GPU'
  | 'Motherboard'
  | 'RAM'
  | 'Storage'
  | 'PSU'
  | 'Case'
  | 'Cooler'
  | 'OS';

export interface ComponentSeed {
  componentId: string;
  category: ComponentCategory;
  brand: string;
  model: string;
  socketType: string | null;
  ddrGen: string | null;
  formFactor: string | null;
  tdpWatts: number | null;
  priceUsd: number;
  imageUrl: string | null;
}

export interface CompatibilityRuleSeed {
  ruleId: string;
  categoryA: ComponentCategory;
  fieldA: string;
  operator: 'eq' | 'fits' | 'headroom';
  categoryB: ComponentCategory | null;
  fieldB: string | null;
  severity: 'error' | 'warning';
  messageTemplate: string;
}

/**
 * Realistic PC component catalog spanning every builder category. Component
 * IDs are stable slugs so saves/reloads and the shared-build snapshot remain
 * deterministic across seeds. Prices are USD MSRP estimates; TDP figures are
 * rated wattage from the manufacturer.
 */
export const PC_COMPONENT_SEED: ComponentSeed[] = [
  // -------------------------------------------------------------------------
  // CPUs
  // -------------------------------------------------------------------------
  { componentId: 'cpu-r5-7600x', category: 'CPU', brand: 'AMD', model: 'Ryzen 5 7600X', socketType: 'AM5', ddrGen: 'DDR5', formFactor: null, tdpWatts: 105, priceUsd: 239.99, imageUrl: null },
  { componentId: 'cpu-r7-7800x3d', category: 'CPU', brand: 'AMD', model: 'Ryzen 7 7800X3D', socketType: 'AM5', ddrGen: 'DDR5', formFactor: null, tdpWatts: 120, priceUsd: 389.99, imageUrl: null },
  { componentId: 'cpu-r9-7950x3d', category: 'CPU', brand: 'AMD', model: 'Ryzen 9 7950X3D', socketType: 'AM5', ddrGen: 'DDR5', formFactor: null, tdpWatts: 120, priceUsd: 549.99, imageUrl: null },
  { componentId: 'cpu-r5-5600x', category: 'CPU', brand: 'AMD', model: 'Ryzen 5 5600X', socketType: 'AM4', ddrGen: 'DDR4', formFactor: null, tdpWatts: 65, priceUsd: 159.99, imageUrl: null },
  { componentId: 'cpu-r7-5800x3d', category: 'CPU', brand: 'AMD', model: 'Ryzen 7 5800X3D', socketType: 'AM4', ddrGen: 'DDR4', formFactor: null, tdpWatts: 105, priceUsd: 319.99, imageUrl: null },
  { componentId: 'cpu-i5-14600k', category: 'CPU', brand: 'Intel', model: 'Core i5-14600K', socketType: 'LGA1700', ddrGen: 'DDR5', formFactor: null, tdpWatts: 125, priceUsd: 289.99, imageUrl: null },
  { componentId: 'cpu-i7-14700k', category: 'CPU', brand: 'Intel', model: 'Core i7-14700K', socketType: 'LGA1700', ddrGen: 'DDR4', formFactor: null, tdpWatts: 125, priceUsd: 379.99, imageUrl: null },
  { componentId: 'cpu-i9-14900k', category: 'CPU', brand: 'Intel', model: 'Core i9-14900K', socketType: 'LGA1700', ddrGen: 'DDR5', formFactor: null, tdpWatts: 125, priceUsd: 539.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // GPUs
  // -------------------------------------------------------------------------
  { componentId: 'gpu-rtx-4060', category: 'GPU', brand: 'NVIDIA', model: 'GeForce RTX 4060 8GB', socketType: null, ddrGen: null, formFactor: 'Dual Slot', tdpWatts: 115, priceUsd: 299.99, imageUrl: null },
  { componentId: 'gpu-rtx-4070-super', category: 'GPU', brand: 'NVIDIA', model: 'GeForce RTX 4070 Super 12GB', socketType: null, ddrGen: null, formFactor: 'Dual Slot', tdpWatts: 220, priceUsd: 599.99, imageUrl: null },
  { componentId: 'gpu-rtx-4080-super', category: 'GPU', brand: 'NVIDIA', model: 'GeForce RTX 4080 Super 16GB', socketType: null, ddrGen: null, formFactor: 'Triple Slot', tdpWatts: 320, priceUsd: 999.99, imageUrl: null },
  { componentId: 'gpu-rtx-4090', category: 'GPU', brand: 'NVIDIA', model: 'GeForce RTX 4090 24GB', socketType: null, ddrGen: null, formFactor: 'Triple Slot', tdpWatts: 450, priceUsd: 1599.99, imageUrl: null },
  { componentId: 'gpu-rx-7600', category: 'GPU', brand: 'AMD', model: 'Radeon RX 7600 8GB', socketType: null, ddrGen: null, formFactor: 'Dual Slot', tdpWatts: 165, priceUsd: 269.99, imageUrl: null },
  { componentId: 'gpu-rx-7800-xt', category: 'GPU', brand: 'AMD', model: 'Radeon RX 7800 XT 16GB', socketType: null, ddrGen: null, formFactor: 'Triple Slot', tdpWatts: 263, priceUsd: 499.99, imageUrl: null },
  { componentId: 'gpu-rx-7900-xtx', category: 'GPU', brand: 'AMD', model: 'Radeon RX 7900 XTX 24GB', socketType: null, ddrGen: null, formFactor: 'Triple Slot', tdpWatts: 355, priceUsd: 949.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // Motherboards
  // -------------------------------------------------------------------------
  { componentId: 'mb-asus-x670e-hero', category: 'Motherboard', brand: 'ASUS', model: 'ROG Crosshair X670E Hero', socketType: 'AM5', ddrGen: 'DDR5', formFactor: 'ATX', tdpWatts: 30, priceUsd: 479.99, imageUrl: null },
  { componentId: 'mb-msi-b650-tomahawk', category: 'Motherboard', brand: 'MSI', model: 'MAG B650 Tomahawk WiFi', socketType: 'AM5', ddrGen: 'DDR5', formFactor: 'ATX', tdpWatts: 20, priceUsd: 219.99, imageUrl: null },
  { componentId: 'mb-gigabyte-b650i', category: 'Motherboard', brand: 'GIGABYTE', model: 'B650I AORUS Ultra', socketType: 'AM5', ddrGen: 'DDR5', formFactor: 'Mini-ITX', tdpWatts: 15, priceUsd: 259.99, imageUrl: null },
  { componentId: 'mb-msi-b550-gaming', category: 'Motherboard', brand: 'MSI', model: 'MPG B550 Gaming Plus', socketType: 'AM4', ddrGen: 'DDR4', formFactor: 'ATX', tdpWatts: 20, priceUsd: 139.99, imageUrl: null },
  { componentId: 'mb-asus-z790-e', category: 'Motherboard', brand: 'ASUS', model: 'ROG Strix Z790-E Gaming WiFi', socketType: 'LGA1700', ddrGen: 'DDR5', formFactor: 'ATX', tdpWatts: 25, priceUsd: 329.99, imageUrl: null },
  { componentId: 'mb-msi-b760m', category: 'Motherboard', brand: 'MSI', model: 'PRO B760M-A WiFi', socketType: 'LGA1700', ddrGen: 'DDR5', formFactor: 'Micro-ATX', tdpWatts: 15, priceUsd: 159.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // RAM
  // -------------------------------------------------------------------------
  { componentId: 'ram-32gb-ddr5', category: 'RAM', brand: 'Corsair', model: 'Vengeance 32GB DDR5-6000 CL30', socketType: null, ddrGen: 'DDR5', formFactor: 'DIMM', tdpWatts: 5, priceUsd: 104.99, imageUrl: null },
  { componentId: 'ram-64gb-ddr5', category: 'RAM', brand: 'G.Skill', model: 'Trident Z5 64GB DDR5-6000 CL30', socketType: null, ddrGen: 'DDR5', formFactor: 'DIMM', tdpWatts: 8, priceUsd: 199.99, imageUrl: null },
  { componentId: 'ram-16gb-ddr4', category: 'RAM', brand: 'Corsair', model: 'Vengeance LPX 16GB DDR4-3600', socketType: null, ddrGen: 'DDR4', formFactor: 'DIMM', tdpWatts: 4, priceUsd: 44.99, imageUrl: null },
  { componentId: 'ram-32gb-ddr4', category: 'RAM', brand: 'G.Skill', model: 'Ripjaws V 32GB DDR4-3600 CL16', socketType: null, ddrGen: 'DDR4', formFactor: 'DIMM', tdpWatts: 6, priceUsd: 74.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  { componentId: 'storage-1tb-nvme', category: 'Storage', brand: 'Samsung', model: '980 Pro 1TB NVMe PCIe 4.0', socketType: null, ddrGen: null, formFactor: 'M.2 2280', tdpWatts: 7, priceUsd: 89.99, imageUrl: null },
  { componentId: 'storage-2tb-nvme', category: 'Storage', brand: 'Samsung', model: '990 Pro 2TB NVMe PCIe 4.0', socketType: null, ddrGen: null, formFactor: 'M.2 2280', tdpWatts: 9, priceUsd: 169.99, imageUrl: null },
  { componentId: 'storage-4tb-nvme', category: 'Storage', brand: 'Crucial', model: 'T500 4TB NVMe PCIe 4.0', socketType: null, ddrGen: null, formFactor: 'M.2 2280', tdpWatts: 10, priceUsd: 309.99, imageUrl: null },
  { componentId: 'storage-2tb-sata', category: 'Storage', brand: 'Samsung', model: '870 EVO 2TB SATA III', socketType: null, ddrGen: null, formFactor: '2.5"', tdpWatts: 3, priceUsd: 129.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // PSUs
  // -------------------------------------------------------------------------
  { componentId: 'psu-evga-500', category: 'PSU', brand: 'EVGA', model: '500 BR 500W 80+ Bronze', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 500, priceUsd: 54.99, imageUrl: null },
  { componentId: 'psu-corsair-rm650', category: 'PSU', brand: 'Corsair', model: 'RM650x 650W 80+ Gold', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 650, priceUsd: 109.99, imageUrl: null },
  { componentId: 'psu-seasonic-focus-750', category: 'PSU', brand: 'Seasonic', model: 'Focus GX-750 750W 80+ Gold', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 750, priceUsd: 119.99, imageUrl: null },
  { componentId: 'psu-corsair-rm850x', category: 'PSU', brand: 'Corsair', model: 'RM850x 850W 80+ Gold', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 850, priceUsd: 139.99, imageUrl: null },
  { componentId: 'psu-seasonic-vertex-1000', category: 'PSU', brand: 'Seasonic', model: 'Vertex GX-1000 1000W 80+ Gold', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 1000, priceUsd: 199.99, imageUrl: null },
  { componentId: 'psu-corsair-sf750', category: 'PSU', brand: 'Corsair', model: 'SF750 750W 80+ Platinum SFX', socketType: null, ddrGen: null, formFactor: 'SFX', tdpWatts: 750, priceUsd: 189.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // Cases
  // -------------------------------------------------------------------------
  { componentId: 'case-corsair-4000d', category: 'Case', brand: 'Corsair', model: '4000D Airflow Black ATX', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 0, priceUsd: 94.99, imageUrl: null },
  { componentId: 'case-lianli-o11', category: 'Case', brand: 'Lian Li', model: 'O11 Dynamic EVO ATX', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 0, priceUsd: 159.99, imageUrl: null },
  { componentId: 'case-nzxt-h5-flow', category: 'Case', brand: 'NZXT', model: 'H5 Flow RGB ATX', socketType: null, ddrGen: null, formFactor: 'ATX', tdpWatts: 0, priceUsd: 94.99, imageUrl: null },
  { componentId: 'case-fractal-pop-mini', category: 'Case', brand: 'Fractal', model: 'Pop Mini Air Micro-ATX', socketType: null, ddrGen: null, formFactor: 'Micro-ATX', tdpWatts: 0, priceUsd: 89.99, imageUrl: null },
  { componentId: 'case-coolermaster-q300l', category: 'Case', brand: 'Cooler Master', model: 'MasterBox Q300L Micro-ATX', socketType: null, ddrGen: null, formFactor: 'Micro-ATX', tdpWatts: 0, priceUsd: 39.99, imageUrl: null },
  { componentId: 'case-nzxt-h210i', category: 'Case', brand: 'NZXT', model: 'H210i Mini-ITX', socketType: null, ddrGen: null, formFactor: 'Mini-ITX', tdpWatts: 0, priceUsd: 109.99, imageUrl: null },
  { componentId: 'case-coolermaster-nr200p', category: 'Case', brand: 'Cooler Master', model: 'NR200P Max Mini-ITX', socketType: null, ddrGen: null, formFactor: 'Mini-ITX', tdpWatts: 0, priceUsd: 179.99, imageUrl: null },

  // -------------------------------------------------------------------------
  // Coolers
  // -------------------------------------------------------------------------
  { componentId: 'cooler-corsair-h100i', category: 'Cooler', brand: 'Corsair', model: 'iCUE H100i Elite Capellix 240mm AIO', socketType: null, ddrGen: null, formFactor: '240mm', tdpWatts: 15, priceUsd: 159.99, imageUrl: null },
  { componentId: 'cooler-nzxt-kraken-360', category: 'Cooler', brand: 'NZXT', model: 'Kraken Elite 360mm AIO', socketType: null, ddrGen: null, formFactor: '360mm', tdpWatts: 18, priceUsd: 279.99, imageUrl: null },
  { componentId: 'cooler-noctua-nh-d15', category: 'Cooler', brand: 'Noctua', model: 'NH-D15 Dual Tower Air', socketType: null, ddrGen: null, formFactor: 'Air Tower', tdpWatts: 3, priceUsd: 109.99, imageUrl: null },
  { componentId: 'cooler-arctic-lf-280', category: 'Cooler', brand: 'Arctic', model: 'Liquid Freezer III 280mm AIO', socketType: null, ddrGen: null, formFactor: '280mm', tdpWatts: 14, priceUsd: 119.99, imageUrl: null },
  { componentId: 'cooler-amd-wraith', category: 'Cooler', brand: 'AMD', model: 'Wraith Stealth Stock Cooler', socketType: null, ddrGen: null, formFactor: 'Air Stock', tdpWatts: 0, priceUsd: 0.0, imageUrl: null },

  // -------------------------------------------------------------------------
  // Operating Systems
  // -------------------------------------------------------------------------
  { componentId: 'os-win-11-home', category: 'OS', brand: 'Microsoft', model: 'Windows 11 Home (64-bit)', socketType: null, ddrGen: null, formFactor: null, tdpWatts: 0, priceUsd: 139.99, imageUrl: null },
  { componentId: 'os-win-11-pro', category: 'OS', brand: 'Microsoft', model: 'Windows 11 Pro (64-bit)', socketType: null, ddrGen: null, formFactor: null, tdpWatts: 0, priceUsd: 199.99, imageUrl: null },
  { componentId: 'os-ubuntu-2404', category: 'OS', brand: 'Canonical', model: 'Ubuntu Linux 24.04 LTS', socketType: null, ddrGen: null, formFactor: null, tdpWatts: 0, priceUsd: 0.0, imageUrl: null },
  { componentId: 'os-steamos', category: 'OS', brand: 'Valve', model: 'SteamOS 3.6 / Bazzite Linux', socketType: null, ddrGen: null, formFactor: null, tdpWatts: 0, priceUsd: 0.0, imageUrl: null },
];

/**
 * Declarative compatibility rules. The `headroom` rule is a hybrid: it is
 * declared here with categoryB='PSU' fieldB='tdpWatts' but the engine computes
 * the required headroom dynamically (selected TDP sum with +20% overhead).
 */
export const COMPATIBILITY_RULES_SEED: CompatibilityRuleSeed[] = [
  {
    ruleId: 'rule-socket-match',
    categoryA: 'CPU',
    fieldA: 'socketType',
    operator: 'eq',
    categoryB: 'Motherboard',
    fieldB: 'socketType',
    severity: 'error',
    messageTemplate: '{CPU} requires the {socketA} socket but the motherboard is {socketB}.',
  },
  {
    ruleId: 'rule-ddr-match',
    categoryA: 'Motherboard',
    fieldA: 'ddrGen',
    operator: 'eq',
    categoryB: 'RAM',
    fieldB: 'ddrGen',
    severity: 'error',
    messageTemplate: 'The motherboard supports {ddrA} memory but this kit is {ddrB}.',
  },
  {
    ruleId: 'rule-form-factor',
    categoryA: 'Motherboard',
    fieldA: 'formFactor',
    operator: 'fits',
    categoryB: 'Case',
    fieldB: 'formFactor',
    severity: 'error',
    messageTemplate: 'The {boardA} motherboard does not physically fit in the {caseB} case.',
  },
  {
    ruleId: 'rule-psu-headroom',
    categoryA: 'PSU',
    fieldA: 'tdpWatts',
    operator: 'headroom',
    categoryB: null,
    fieldB: null,
    severity: 'error',
    messageTemplate: 'Estimated load of {load}W exceeds the {supply}W power supply rating.',
  },
];

/** Normalized form-factor fit ordering (lower rank = physically smaller). */
export const FORM_FACTOR_RANK: Record<string, number> = {
  'Mini-ITX': 1,
  'Micro-ATX': 2,
  'ATX': 3,
};

/**
 * Idempotent sprint-2 seed. Inserts the component catalog and compatibility
 * rule rows using INSERT OR IGNORE keyed on the natural keys so re-boots never
 * duplicate rows.
 */
export function seedBuilderComponents(db: DatabaseType): void {
  const insertComponent = db.prepare(`
    INSERT OR IGNORE INTO "device_components" (
      componentId, category, brand, model, socketType, ddrGen, formFactor,
      tdpWatts, priceUsd, imageUrl
    ) VALUES (
      @componentId, @category, @brand, @model, @socketType, @ddrGen, @formFactor,
      @tdpWatts, @priceUsd, @imageUrl
    )
  `);
  const insertRule = db.prepare(`
    INSERT OR IGNORE INTO "compatibility_rules" (
      ruleId, categoryA, fieldA, operator, categoryB, fieldB, severity, messageTemplate
    ) VALUES (
      @ruleId, @categoryA, @fieldA, @operator, @categoryB, @fieldB, @severity, @messageTemplate
    )
  `);

  const tx = db.transaction(() => {
    for (const c of PC_COMPONENT_SEED) {
      insertComponent.run({
        componentId: c.componentId,
        category: c.category,
        brand: c.brand,
        model: c.model,
        socketType: c.socketType,
        ddrGen: c.ddrGen,
        formFactor: c.formFactor,
        tdpWatts: c.tdpWatts,
        priceUsd: c.priceUsd,
        imageUrl: c.imageUrl,
      });
    }
    for (const r of COMPATIBILITY_RULES_SEED) {
      insertRule.run({
        ruleId: r.ruleId,
        categoryA: r.categoryA,
        fieldA: r.fieldA,
        operator: r.operator,
        categoryB: r.categoryB,
        fieldB: r.fieldB,
        severity: r.severity,
        messageTemplate: r.messageTemplate,
      });
    }
  });

  tx();
}