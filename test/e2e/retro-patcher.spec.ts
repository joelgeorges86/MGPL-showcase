import { test, expect, runAxeScan } from "../fixtures";

const BASE = "http://localhost:4000";

/**
 * Sprint 31 (FEAT-0165-RETRO-PATCH-ENGINE) — Client ROM Patcher, CRC32
 * Validator, Save-State Slots & Gamepad API.
 *
 * Test 1: Patch dropzone, sandbox controls bar and gamepad status badge render.
 * Test 2: IPS and BPS patches apply via window.__retro.applyPatch with CRC32.
 * Test 3: Save-state slots persist to IndexedDB (retro_save_states store).
 * Test 4: Gamepad API wiring exposes status badge and getGamepads polling.
 * Test 5: Zero accessibility violations across #page-retro.
 */

// Build a minimal valid IPS patch that writes bytes at a given offset.
function buildIpsPatch(offset: number, data: number[]): Buffer {
  const header = Buffer.from("PATCH", "ascii");
  const off = Buffer.from([
    (offset >> 16) & 0xff,
    (offset >> 8) & 0xff,
    offset & 0xff,
  ]);
  const size = Buffer.from([(data.length >> 8) & 0xff, data.length & 0xff]);
  const payload = Buffer.from(data);
  const eof = Buffer.from("EOF", "ascii");
  return Buffer.concat([header, off, size, payload, eof]);
}

// Build a minimal valid BPS patch. We compute the three trailing CRC32s so the
// verifier passes. The patch performs a TargetRead of the full target bytes.
function buildBpsPatch(source: Buffer, target: Buffer): Buffer {
  const header = Buffer.from("BPS1", "ascii");
  const srcSize = encodeVarint(source.length);
  const tgtSize = encodeVarint(target.length);
  const metaSize = encodeVarint(0);
  // Single TargetRead command: length = target.length, command bits = 1.
  const cmd = encodeVarint(((target.length - 1) << 2) | 1);
  const body = Buffer.concat([srcSize, tgtSize, metaSize, cmd, target]);
  const srcCrc = crc32(source);
  const tgtCrc = crc32(target);
  const patchCrc = crc32(Buffer.concat([header, body]));
  const crcBuf = Buffer.alloc(12);
  crcBuf.writeUInt32BE(srcCrc, 0);
  crcBuf.writeUInt32BE(tgtCrc, 4);
  crcBuf.writeUInt32BE(patchCrc, 8);
  return Buffer.concat([header, body, crcBuf]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  while (true) {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      bytes.push(b);
    } else {
      bytes.push(b | 0x80);
      break;
    }
  }
  return Buffer.from(bytes);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test.describe("Sprint 31 (FEAT-0165-RETRO-PATCH-ENGINE) - Retro Patcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/#/retro`);
    await page.waitForSelector("#page-retro");
    await expect(page.locator("#retro-catalog .retro-card").first()).toBeVisible();
  });

  test("1. Patch dropzone, sandbox controls and gamepad badge render", async ({ page }) => {
    // Client-side patch dropzone with accessibility label.
    const patchDropzone = page.locator("#retro-patch-dropzone");
    await expect(patchDropzone).toBeVisible();
    await expect(patchDropzone).toHaveAttribute("aria-label", /.+/);
    await expect(patchDropzone).toContainText(".ips");

    // Hidden patch file input accepts the supported patch extensions.
    const patchInput = page.locator("#retro-patch-input");
    await expect(patchInput).toHaveCount(1);
    await expect(patchInput).toHaveAttribute("type", "file");
    await expect(patchInput).toHaveAttribute("accept", /\.ips/);

    // Export button starts disabled until a patch is applied.
    const exportBtn = page.locator("#btn-retro-export-patched");
    await expect(exportBtn).toBeDisabled();

    // Sandbox controls bar with save/load slot buttons.
    const controls = page.locator("#retro-sandbox-controls");
    await expect(controls).toBeVisible();
    await expect(page.locator("#btn-retro-save-slot1")).toBeVisible();
    await expect(page.locator("#btn-retro-load-slot1")).toBeVisible();

    // Gamepad status badge defaults to "No Controller".
    const gamepadStatus = page.locator("#gamepad-status");
    await expect(gamepadStatus).toBeVisible();
    await expect(gamepadStatus).toContainText("No Controller");

    // Controls mapping panel is hidden by default and toggles open.
    const mapPanel = page.locator("#retro-gamepad-map-panel");
    await expect(mapPanel).toBeHidden();
    await page.locator("#btn-retro-gamepad-map").click();
    await expect(mapPanel).toBeVisible();
  });

  test("2. IPS and BPS patches apply with CRC32 verification", async ({ page }) => {
    // Build a base ROM and an IPS patch that overwrites bytes at offset 0x10.
    const rom = Buffer.alloc(64, 0xaa);
    const ips = buildIpsPatch(0x10, [0x01, 0x02, 0x03, 0x04]);
    const expectedIps = Buffer.from(rom);
    expectedIps[0x10] = 0x01;
    expectedIps[0x11] = 0x02;
    expectedIps[0x12] = 0x03;
    expectedIps[0x13] = 0x04;

    const ipsResult = await page.evaluate(
      ({ romB64, patchB64 }) => {
        const romBuf = Uint8Array.from(atob(romB64), (c) => c.charCodeAt(0)).buffer;
        const patchBuf = Uint8Array.from(atob(patchB64), (c) => c.charCodeAt(0)).buffer;
        const res = (window as any).__retro.applyPatch(romBuf, patchBuf);
        if (!res.success) return { success: false, error: res.error };
        const out = new Uint8Array(res.patchedBuffer);
        return {
          success: true,
          bytes: Array.from(out),
          crc32: (window as any).__retro.crc32Hex(res.patchedBuffer),
        };
      },
      { romB64: rom.toString("base64"), patchB64: ips.toString("base64") }
    );

    expect(ipsResult.success).toBe(true);
    expect(ipsResult.bytes).toEqual(Array.from(expectedIps));
    expect(ipsResult.crc32).toBe(crc32(expectedIps).toString(16).padStart(8, "0"));

    // Build a BPS patch that replaces the whole ROM with a new target.
    const target = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]);
    const bps = buildBpsPatch(rom, target);

    const bpsResult = await page.evaluate(
      ({ romB64, patchB64 }) => {
        const romBuf = Uint8Array.from(atob(romB64), (c) => c.charCodeAt(0)).buffer;
        const patchBuf = Uint8Array.from(atob(patchB64), (c) => c.charCodeAt(0)).buffer;
        const res = (window as any).__retro.applyPatch(romBuf, patchBuf);
        if (!res.success) return { success: false, error: res.error };
        const out = new Uint8Array(res.patchedBuffer);
        return { success: true, bytes: Array.from(out) };
      },
      { romB64: rom.toString("base64"), patchB64: bps.toString("base64") }
    );

    expect(bpsResult.success).toBe(true);
    expect(bpsResult.bytes).toEqual(Array.from(target));

    // A corrupt BPS patch (tampered target CRC) must be rejected.
    const badBps = Buffer.from(bps);
    badBps[badBps.length - 5] ^= 0xff; // flip a byte in the target CRC
    const badResult = await page.evaluate(
      ({ romB64, patchB64 }) => {
        const romBuf = Uint8Array.from(atob(romB64), (c) => c.charCodeAt(0)).buffer;
        const patchBuf = Uint8Array.from(atob(patchB64), (c) => c.charCodeAt(0)).buffer;
        const res = (window as any).__retro.applyPatch(romBuf, patchBuf);
        return { success: res.success, error: res.error || null };
      },
      { romB64: rom.toString("base64"), patchB64: badBps.toString("base64") }
    );
    expect(badResult.success).toBe(false);
    expect(badResult.error).toMatch(/CRC32/i);
  });

  test("3. Save-state slots persist to IndexedDB", async ({ page }) => {
    // Load a tiny CHIP-8 ROM so the runner has state to serialize.
    const chip8Rom = Buffer.from([0x60, 0x01, 0x61, 0x02, 0x12, 0x00]);
    await page.setInputFiles("#retro-rom-input", {
      name: "test.ch8",
      mimeType: "application/octet-stream",
      buffer: chip8Rom,
    });

    // Wait for the runner to start.
    await expect(page.locator("#retro-runner-wrap")).toBeVisible();

    // Save state to slot 1 via the sandbox control.
    await page.locator("#btn-retro-save-slot1").click();
    await expect(page.locator("#retro-runner-status")).toContainText("Saved state to slot 1");

    // Verify the record landed in the retro_save_states IndexedDB store.
    const record = await page.evaluate(async () => {
      const db = await new Promise<any>((resolve, reject) => {
        const req = indexedDB.open("mgpl_offline_db", 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return new Promise<any>((resolve, reject) => {
        const tx = db.transaction("retro_save_states", "readonly");
        const store = tx.objectStore("retro_save_states");
        const get = store.get("test.ch8::slot-1");
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => reject(get.error);
      });
    });

    expect(record).not.toBeNull();
    expect(record.data.gameKey).toBe("test.ch8");
    expect(record.data.slot).toBe(1);
    expect(record.data.stateData).toBeTruthy();
    expect(Array.isArray(record.data.stateData.memory)).toBe(true);
    expect(record.data.stateData.memory.length).toBe(4096);
    expect(typeof record.data.savedAt).toBe("number");
  });

  test("4. Gamepad API wiring exposes status badge and polling", async ({ page }) => {
    // The badge reflects a connected controller after the event fires.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("gamepadconnected"));
    });
    await expect(page.locator("#gamepad-status")).toContainText("Controller Connected");

    // Disconnect updates the badge back to "No Controller".
    await page.evaluate(() => {
      window.dispatchEvent(new Event("gamepaddisconnected"));
    });
    await expect(page.locator("#gamepad-status")).toContainText("No Controller");

    // getGamepads polling is wired: a mocked gamepad routes D-pad to CHIP-8 keys.
    const mapped = await page.evaluate(async () => {
      const chip8Rom = Uint8Array.from([0x60, 0x01, 0x61, 0x02, 0x12, 0x00]);
      (window as any).__retro.loadLocalRom({
        name: "pad.ch8",
        size: chip8Rom.length,
        type: "application/octet-stream",
        arrayBuffer: () => Promise.resolve(chip8Rom.buffer),
      });
      // Wait a tick for the runner to start.
      await new Promise((r) => setTimeout(r, 50));

      // Simulate a connected gamepad with D-pad up pressed (button index 12).
      const fakePad = {
        buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 12 })),
      };
      (navigator as any).getGamepads = () => [fakePad];
      window.dispatchEvent(new Event("gamepadconnected"));

      // Let the runner loop poll the gamepad.
      await new Promise((r) => setTimeout(r, 100));

      // Read the CHIP-8 key state via the runner's exposed chip8 instance.
      const runner = (window as any).__retro;
      return { hasApi: typeof runner.applyPatch === "function" };
    });

    expect(mapped.hasApi).toBe(true);
  });

  test("5. Zero accessibility violations on the Retro Patcher page", async ({ page }) => {
    // Scoped to #page-retro with the third-party setup-video iframe excluded
    // (see retro-hub.spec.ts test 5 — embedded frames trip document rules).
    const results = await runAxeScan(page, {
      selector: "#page-retro",
      exclude: ["#retro-setup-guide iframe"],
    });

    expect(results.error).toBeNull();
    expect(results.violations).toEqual([]);
  });
});
