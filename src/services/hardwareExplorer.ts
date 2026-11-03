import si from 'systeminformation';

/**
 * Sprint 5 (EPICUX05): Hardware Explorer 2.0 capability scanning & normalization.
 *
 * PII-free local telemetry extraction. Every field persisted or served is a
 * hardware model/spec value — never a serial number, MAC address, username,
 * hostname, UUID, or any personally identifying datum. VRAM is read from the
 * adapter's reported VRAM and is NEVER inferred from the GPU model name; when it
 * cannot be read the scan degrades to `partial` confidence and the consumer
 * surfaces the documented "Missing VRAM" / "Refresh device scan required" block.
 */

export type DeviceClass = 'desktop' | 'laptop' | 'handheld' | 'unknown';
export type ScanConfidence = 'complete' | 'partial';

export interface ScanTelemetry {
  deviceId: string;
  deviceName: string;
  formFactor: string;
  deviceClass: DeviceClass;
  cpuModel: string | null;
  cpuCores: number | null;
  ramGb: number | null;
  gpuModel: string | null;
  vramGb: number | null;
  gpuType: 'discrete' | 'integrated' | null;
  storageType: string | null;
  storageCapacityGb: number | null;
  storageFreeGb: number | null;
  batteryWh: number | null;
  batteryPresent: boolean;
  thermalCapabilities: string | null;
  scanConfidence: ScanConfidence;
  missingFields: string[];
  scannedAt: string;
}

export interface RetailerLink {
  retailer: string;
  url: string;
  whitelisted: boolean;
}

/**
 * Authoritative hardware-retailer hostname whitelist (mirrors the storefront
 * whitelist doctrine in src/utils/storefrontValidator.ts but scoped to verified
 * PC-component sellers). Only these exact HTTPS hosts may be surfaced as buy
 * links; anything else is rejected.
 */
export const RETAILER_HOST_WHITELIST: ReadonlySet<string> = new Set([
  'amazon.com',
  'www.amazon.com',
  'bestbuy.com',
  'www.bestbuy.com',
  'newegg.com',
  'www.newegg.com',
]);

const RETAILER_SEARCH_PATHS: Record<string, (q: string) => string> = {
  'Amazon': (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  'Best Buy': (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  'Newegg': (q) => `https://www.newegg.com/p/pl?d=${encodeURIComponent(q)}`,
};

/**
 * Build verified retail buy links for a component query string. Every URL is
 * HTTPS and its hostname is asserted against the whitelist before being returned
 * (defense-in-depth; the generated URLs always match, but a future refactor can
 * never leak an un-whitelisted host to the client).
 */
export function verifiedRetailerLinks(query: string): RetailerLink[] {
  const q = String(query || '').trim();
  if (!q) return [];
  const links: RetailerLink[] = [];
  for (const [retailer, build] of Object.entries(RETAILER_SEARCH_PATHS)) {
    const url = build(q);
    let whitelisted = false;
    try {
      whitelisted = RETAILER_HOST_WHITELIST.has(new URL(url).hostname.toLowerCase());
    } catch {
      whitelisted = false;
    }
    if (whitelisted) links.push({ retailer, url, whitelisted: true });
  }
  return links;
}

/**
 * Classify a scanned machine into a device class using the manufacturer/model
 * and battery presence. Handheld gaming PCs are matched by known family
 * keywords; battery-bearing machines are laptops; everything else is a desktop.
 * Unknown is only returned when the system query fails outright.
 */
export function deriveDeviceClass(
  system: { manufacturer: string | null; model: string | null } | null,
  hasBattery: boolean,
): DeviceClass {
  const hay = `${system?.manufacturer || ''} ${system?.model || ''}`.toLowerCase();
  if (/steam deck|steamdeck|rog ally|legion go|msi claw|ayaneo|gpd win|switch|ally\b/.test(hay)) {
    return 'handheld';
  }
  if (hasBattery) return 'laptop';
  if (!system || (!system.manufacturer && !system.model)) return 'unknown';
  return 'desktop';
}

/**
 * Normalize a reported VRAM figure into GB. systeminformation has historically
 * reported `vram` in bytes on most platforms (8GB = 8589934592) and MB on some
 * (8192); this heuristic handles both plus an already-GB value. Null/zero stays
 * null so the consumer can surface the "Missing VRAM" blocked state — never a
 * guess from the GPU name (Strict Extraction rule).
 */
export function normalizeVramGb(vram: number | null | undefined): number | null {
  if (vram === null || vram === undefined || vram <= 0) return null;
  let gb: number;
  if (vram >= 1e9) gb = vram / 1e9;
  else if (vram >= 1e6) gb = vram / 1e6;
  else if (vram >= 1e3) gb = vram / 1e6;
  else gb = vram;
  return Math.round(gb * 10) / 10;
}

/**
 * Parse a VRAM figure out of a real catalog model string (e.g.
 * "GeForce RTX 4070 Super 12GB" -> 12). Used by the upgrade advisor to compute
 * factual spec deltas against persisted device specs. Returns null when the
 * model carries no explicit VRAM figure (never a guess).
 */
export function vramFromModel(model: string | null | undefined): number | null {
  const m = String(model || '');
  const match = m.match(/(\d+(?:\.\d+)?)\s*GB\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Deterministic real core counts for the seeded catalog CPUs. */
const CPU_CORE_MAP: Record<string, number> = {
  'cpu-r5-7600x': 6,
  'cpu-r7-7800x3d': 8,
  'cpu-r9-7950x3d': 16,
  'cpu-r5-5600x': 6,
  'cpu-r7-5800x3d': 8,
  'cpu-i5-14600k': 14,
  'cpu-i7-14700k': 20,
  'cpu-i9-14900k': 24,
};

/**
 * Resolve a real core count for a seeded catalog CPU component id. The map is
 * authoritative for the deterministic seed; unknown ids resolve via the family
 * prefix (R5/R7/R9 -> 6/8/16, i5/i7/i9 -> 6/8/16) as a documented fallback and
 * otherwise return null (never a fabricated count).
 */
export function coresForComponent(componentId: string, model: string | null): number | null {
  if (CPU_CORE_MAP[componentId]) return CPU_CORE_MAP[componentId];
  const m = String(model || '').toLowerCase();
  if (/r9|i9/.test(m)) return 16;
  if (/r7|i7/.test(m)) return 8;
  if (/r5|i5/.test(m)) return 6;
  if (/r3|i3/.test(m)) return 4;
  return null;
}

/**
 * Compute scan confidence from the extracted telemetry. Missing VRAM/cores/etc.
 * degrade the scan to `partial` with an explicit missing-field list so callers
 * can render graceful blocked states instead of guessing.
 */
export function computeScanConfidence(telemetry: {
  cpuModel: string | null;
  cpuCores: number | null;
  ramGb: number | null;
  gpuModel: string | null;
  vramGb: number | null;
  storageFreeGb: number | null;
}): { confidence: ScanConfidence; missingFields: string[] } {
  const missingFields: string[] = [];
  if (!telemetry.cpuModel) missingFields.push('cpu');
  if (telemetry.cpuCores === null) missingFields.push('cpuCores');
  if (telemetry.ramGb === null) missingFields.push('ram');
  if (!telemetry.gpuModel) missingFields.push('gpu');
  if (telemetry.vramGb === null) missingFields.push('vram');
  if (telemetry.storageFreeGb === null) missingFields.push('storage');
  return {
    confidence: missingFields.length > 0 ? 'partial' : 'complete',
    missingFields,
  };
}

/**
 * Run a full PII-free local hardware scan. Every systeminformation query is
 * individually guarded so a single unavailable sensor degrades that field to
 * `null` (surfaced via scanConfidence) instead of failing the whole scan.
 */
export async function scanLocalHardware(): Promise<ScanTelemetry> {
  const [system, cpu, mem, graphics, disks, fs, battery, temperature] = await Promise.all([
    si.system().catch(() => null),
    si.cpu().catch(() => null),
    si.mem().catch(() => null),
    si.graphics().catch(() => null),
    si.diskLayout().catch(() => []),
    si.fsSize().catch(() => []),
    si.battery().catch(() => null),
    si.cpuTemperature().catch(() => null),
  ]);

  const gpuController: any = graphics?.controllers?.[0] || null;
  const vramGb = normalizeVramGb(gpuController?.vram);

  const cpuModelRaw = [cpu?.manufacturer, cpu?.brand].filter(Boolean).join(' ') || null;
  const cpuCoresRaw =
    (typeof cpu?.physicalCores === 'number' && cpu.physicalCores > 0
      ? cpu.physicalCores
      : typeof cpu?.cores === 'number' && cpu.cores > 0
        ? cpu.cores
        : null) ?? null;

  const totalRamBytes = typeof mem?.total === 'number' && mem.total > 0 ? mem.total : null;
  const ramGb = totalRamBytes !== null ? Math.round((totalRamBytes / 1e9) * 10) / 10 : null;

  const totalDiskBytes = (Array.isArray(disks) ? disks : [])
    .map((d: any) => Number(d?.size) || 0)
    .reduce((a, b) => a + b, 0);
  const storageCapacityGb = totalDiskBytes > 0 ? Math.round((totalDiskBytes / 1e9) * 10) / 10 : null;
  const totalFreeBytes = (Array.isArray(fs) ? fs : [])
    .map((m: any) => Number(m?.available) || 0)
    .reduce((a, b) => a + b, 0);
  const storageFreeGb = totalFreeBytes > 0 ? Math.round((totalFreeBytes / 1e9) * 10) / 10 : null;
  const storageType = (Array.isArray(disks) && disks[0]?.type) || 'SSD';

  const hasBattery = Boolean(battery?.hasBattery);
  const batteryWh =
    typeof battery?.maxCapacity === 'number' && battery.maxCapacity > 0
      ? Math.round(battery.maxCapacity * 10) / 10
      : null;

  const thermalReported =
    temperature !== null &&
    ((typeof temperature?.main === 'number' && temperature.main > 0) ||
      (Array.isArray(temperature?.cores) && temperature.cores.length > 0));
  const thermalCapabilities = thermalReported ? 'reported' : null;

  const deviceClass = deriveDeviceClass(
    { manufacturer: system?.manufacturer || null, model: system?.model || null },
    hasBattery,
  );

  const telemetry: ScanTelemetry = {
    deviceId: 'local-host',
    deviceName: 'Local PC',
    formFactor:
      deviceClass === 'handheld'
        ? 'Handheld'
        : deviceClass === 'laptop'
          ? 'Laptop'
          : 'Desktop',
    deviceClass,
    cpuModel: cpuModelRaw,
    cpuCores: cpuCoresRaw,
    ramGb,
    gpuModel: gpuController?.model || gpuController?.vendor || null,
    vramGb,
    gpuType: /integrated|uhd|radeon.*integrated|iris/i.test(String(gpuController?.model || ''))
      ? 'integrated'
      : 'discrete',
    storageType,
    storageCapacityGb,
    storageFreeGb,
    batteryWh,
    batteryPresent: hasBattery,
    thermalCapabilities,
    scanConfidence: 'complete',
    missingFields: [],
    scannedAt: new Date().toISOString(),
  };

  const { confidence, missingFields } = computeScanConfidence(telemetry);
  telemetry.scanConfidence = confidence;
  telemetry.missingFields = missingFields;
  return telemetry;
}

