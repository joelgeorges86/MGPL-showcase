/* MGPL Retro Gaming Hub (FEAT-0159)
 *
 * Sprint 26 — Legal Store Re-releases & Sandboxed Local Runner.
 * Sprint 31 — Client ROM Patcher, CRC32 Validator, Save-State Slots & Gamepad API.
 *
 * Self-contained module loaded after storage.js and before app.js. Uses the
 * same API_BASE convention and window.__offlineHelpers.apiFetch for network
 * calls so the retro catalog is cached offline via IndexedDB.
 *
 * Exposes window.__retro with:
 *   - init()            -> fetch + render catalog, systems & wire dropzone
 *   - filterSystem(sys) -> re-render catalog filtered by system chip
 *   - loadLocalRom(file)-> sandboxed local runner (WASM canvas + CHIP-8 fallback)
 *   - applyPatch(rom, patch) -> { success, patchedBuffer?, error? }
 *   - crc32Hex(bytes)   -> CRC-32 hex digest of an ArrayBuffer/Uint8Array
 *   - md5Hex(bytes)     -> MD5 hex digest of an ArrayBuffer/Uint8Array
 *   - saveState(slot)   -> persist current runner state to IndexedDB
 *   - loadState(slot)   -> restore runner state from IndexedDB
 *
 * All dynamic UI nodes are assembled off-DOM and appended once, so the page
 * never flashes partial content and re-renders are cheap.
 */
(function () {
  "use strict";

  var API_BASE = "";

  function apiFetch(url, options) {
    if (window.__offlineHelpers && typeof window.__offlineHelpers.apiFetch === "function") {
      return window.__offlineHelpers.apiFetch(url, options);
    }
    return fetch(url, options);
  }

  function showToast(message, isError) {
    if (typeof window.showToast === "function") {
      window.showToast(message, isError);
    }
  }

  // Sprint 7 (WUD-7.5): strict HTTPS host whitelist + validator for the retro
  // emulator resource / setup-guide outbound links (mirrors safeModUrl in
  // app.js). Exact-match domains only — arbitrary subdomains are rejected.
  var RETRO_SOURCE_DOMAINS = [
    "retroarch.com",
    "libretro.com",
    "dolphin-emu.org",
    "pcsx2.net",
    "duckstation.org",
    "mgba.io",
    "mesen.ca",
    "sameboy.github.io",
    "ares-emu.net",
    "youtube.com",
  ];

  function normalizeRetroHost(host) {
    var h = String(host || "")
      .trim()
      .toLowerCase();
    if (h.indexOf("www.") === 0) h = h.slice(4);
    return h;
  }

  function safeRetroUrl(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    var parsed;
    try {
      parsed = new URL(raw.trim());
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname || parsed.hostname.indexOf(".") === parsed.hostname.length - 1)
      return null;
    var domain = normalizeRetroHost(parsed.hostname);
    if (RETRO_SOURCE_DOMAINS.indexOf(domain) === -1) return null;
    return parsed.toString();
  }

  // ---- Checksum Engine (FEAT-0165) ---------------------------------------
  // Pure in-browser CRC-32 and MD5 over ArrayBuffer. No external libraries and
  // no server transmission — every byte is processed client-side.

  var CRC32_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  /** Compute the CRC-32 of an ArrayBuffer/Uint8Array. Returns unsigned int. */
  function crc32Bytes(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var crc = 0xffffffff;
    for (var i = 0; i < u8.length; i++) {
      crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ u8[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Hex string (8 chars, zero-padded) of a CRC-32 value. */
  function crc32Hex(bytes) {
    var v = crc32Bytes(bytes);
    return ("00000000" + v.toString(16)).slice(-8);
  }

  // MD5 implementation (RFC 1321) over bytes.
  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  var MD5_K = (function () {
    var k = new Int32Array(64);
    for (var i = 0; i < 64; i++) {
      k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }
    return k;
  })();

  function md5Rotl(x, c) {
    return (x << c) | (x >>> (32 - c));
  }

  /** Compute the MD5 digest of an ArrayBuffer/Uint8Array as a hex string. */
  function md5Hex(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var len = u8.length;
    var bitLen = len * 8;
    var paddedLen = (((len + 8) >> 6) + 1) << 6;
    var padded = new Uint8Array(paddedLen);
    padded.set(u8);
    padded[len] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
    dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);

    var a0 = 0x67452301,
      b0 = 0xefcdab89,
      c0 = 0x98badcfe,
      d0 = 0x10325476;
    var m = new Int32Array(16);
    for (var off = 0; off < paddedLen; off += 64) {
      for (var j = 0; j < 16; j++) {
        m[j] = dv.getInt32(off + j * 4, true);
      }
      var A = a0,
        B = b0,
        C = c0,
        D = d0;
      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + MD5_K[i] + m[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + md5Rotl(F, MD5_S[i])) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    function toHex(x) {
      return ("00000000" + (x >>> 0).toString(16)).slice(-8);
    }
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
  }

  // ---- Binary Patch Engine (FEAT-0165) -----------------------------------
  // IPS (International Patching System) and BPS (Beat Patching System with
  // CRC32 verification) parsers/applicators. All processing is client-side.

  function readU24(u8, off) {
    return (u8[off] << 16) | (u8[off + 1] << 8) | u8[off + 2];
  }

  function readU16(u8, off) {
    return (u8[off] << 8) | u8[off + 1];
  }

  /** Apply an IPS patch to a ROM buffer. Returns { success, patchedBuffer?, error? }. */
  function applyIps(rom, patch) {
    var romU8 = new Uint8Array(rom);
    var p = new Uint8Array(patch);
    if (
      p.length < 8 ||
      p[0] !== 0x50 ||
      p[1] !== 0x41 ||
      p[2] !== 0x54 ||
      p[3] !== 0x43 ||
      p[4] !== 0x48
    ) {
      return { success: false, error: "Invalid IPS header." };
    }
    var out = new Uint8Array(romU8);
    var pos = 5;
    while (pos + 3 <= p.length) {
      if (p[pos] === 0x45 && p[pos + 1] === 0x4f && p[pos + 2] === 0x46) {
        pos += 3;
        // Optional truncate length (4 bytes) after EOF.
        if (pos + 4 <= p.length) {
          var trunc = (p[pos] << 24) | (p[pos + 1] << 16) | (p[pos + 2] << 8) | p[pos + 3];
          if (trunc > 0 && trunc < out.length) {
            out = out.slice(0, trunc);
          }
        }
        return { success: true, patchedBuffer: out.buffer };
      }
      var offset = readU24(p, pos);
      pos += 3;
      var size = readU16(p, pos);
      pos += 2;
      if (size === 0) {
        // RLE record: 2-byte length + 1 fill byte.
        var rleLen = readU16(p, pos);
        pos += 2;
        var fill = p[pos];
        pos += 1;
        for (var r = 0; r < rleLen; r++) {
          if (offset + r < out.length) out[offset + r] = fill;
        }
      } else {
        for (var i = 0; i < size; i++) {
          if (offset + i < out.length) out[offset + i] = p[pos + i];
        }
        pos += size;
      }
    }
    return { success: true, patchedBuffer: out.buffer };
  }

  /** Decode a BPS varint. Returns { value, next }. */
  function bpsVarint(u8, pos) {
    var shift = 0;
    var value = 0;
    while (true) {
      var b = u8[pos];
      pos++;
      value |= (b & 0x7f) << shift;
      if (b & 0x80) break;
      shift += 7;
    }
    return { value: value >>> 0, next: pos };
  }

  /** Apply a BPS patch to a ROM buffer with CRC32 verification. */
  function applyBps(rom, patch) {
    var romU8 = new Uint8Array(rom);
    var p = new Uint8Array(patch);
    if (p.length < 19 || p[0] !== 0x42 || p[1] !== 0x50 || p[2] !== 0x53 || p[3] !== 0x31) {
      return { success: false, error: "Invalid BPS header." };
    }
    var pos = 4;
    var srcSize = bpsVarint(p, pos);
    pos = srcSize.next;
    var tgtSize = bpsVarint(p, pos);
    pos = tgtSize.next;
    var metaSize = bpsVarint(p, pos);
    pos = metaSize.next;
    pos += metaSize.value; // skip metadata

    var out = new Uint8Array(tgtSize.value);
    var outPos = 0;
    var srcRel = 0;
    var tgtRel = 0;
    var src = romU8;

    while (pos < p.length - 12) {
      var data = bpsVarint(p, pos);
      pos = data.next;
      var command = data.value & 3;
      var length = (data.value >>> 2) + 1;
      if (command === 0) {
        // SourceRead
        for (var i = 0; i < length; i++) {
          out[outPos++] = src[srcRel++];
        }
      } else if (command === 1) {
        // TargetRead
        for (var j = 0; j < length; j++) {
          out[outPos++] = p[pos++];
        }
      } else if (command === 2) {
        // SourceCopy
        var sOff = bpsVarint(p, pos);
        pos = sOff.next;
        srcRel += sOff.value;
        for (var k = 0; k < length; k++) {
          out[outPos++] = src[srcRel++];
        }
      } else {
        // TargetCopy
        var tOff = bpsVarint(p, pos);
        pos = tOff.next;
        tgtRel += tOff.value;
        for (var m = 0; m < length; m++) {
          out[outPos++] = out[tgtRel++];
        }
      }
    }

    // Verify the three trailing CRC32s (source, target, patch).
    var srcCrc =
      (p[p.length - 12] << 24) |
      (p[p.length - 11] << 16) |
      (p[p.length - 10] << 8) |
      p[p.length - 9];
    var tgtCrc =
      (p[p.length - 8] << 24) | (p[p.length - 7] << 16) | (p[p.length - 6] << 8) | p[p.length - 5];
    var patchCrc =
      (p[p.length - 4] << 24) | (p[p.length - 3] << 16) | (p[p.length - 2] << 8) | p[p.length - 1];

    if (crc32Bytes(src) !== srcCrc >>> 0) {
      return { success: false, error: "BPS source CRC32 mismatch." };
    }
    if (crc32Bytes(out) !== tgtCrc >>> 0) {
      return { success: false, error: "BPS target CRC32 mismatch." };
    }
    // Per the BPS spec, the patch CRC32 is computed over the entire patch file
    // EXCLUDING the trailing 12 bytes (the three CRC32 values themselves).
    var patchBody = p.subarray(0, p.length - 12);
    if (crc32Bytes(patchBody) !== patchCrc >>> 0) {
      return { success: false, error: "BPS patch CRC32 mismatch." };
    }
    return { success: true, patchedBuffer: out.buffer };
  }

  /**
   * Public patch application interface.
   * applyPatch(romBuffer, patchBuffer) -> { success, patchedBuffer?, error? }
   * Auto-detects IPS vs BPS by magic header.
   */
  function applyPatch(romBuffer, patchBuffer) {
    if (!romBuffer || !patchBuffer) {
      return { success: false, error: "Both a ROM and a patch are required." };
    }
    var p = new Uint8Array(patchBuffer);
    if (
      p.length >= 5 &&
      p[0] === 0x50 &&
      p[1] === 0x41 &&
      p[2] === 0x54 &&
      p[3] === 0x43 &&
      p[4] === 0x48
    ) {
      return applyIps(romBuffer, patchBuffer);
    }
    if (p.length >= 4 && p[0] === 0x42 && p[1] === 0x50 && p[2] === 0x53 && p[3] === 0x31) {
      return applyBps(romBuffer, patchBuffer);
    }
    return { success: false, error: "Unsupported patch format. Use .ips or .bps." };
  }

  // ---- State -------------------------------------------------------------
  var catalog = [];
  var systems = [];
  var activeSystem = "all";
  var initialized = false;

  // ---- Patch UI state (FEAT-0165) ----------------------------------------
  var patchState = {
    romBuffer: null,
    romName: "",
    patchBuffer: null,
    patchName: "",
    patchedBuffer: null,
    patchedName: "",
  };

  // ---- Catalog rendering -------------------------------------------------
  function systemBadgeClass(system) {
    switch (system) {
      case "NES":
        return "bg-red-500/10 text-red-400 border-red-500/30";
      case "SNES":
        return "bg-purple-500/10 text-purple-400 border-purple-500/30";
      case "Genesis":
        return "bg-blue-500/10 text-blue-400 border-blue-500/30";
      case "PS1":
        return "bg-slate-500/10 text-slate-300 border-slate-500/30";
      case "GBA":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
      case "Arcade":
        return "bg-amber-500/10 text-amber-400 border-amber-500/30";
      case "Homebrew":
        return "bg-pink-500/10 text-pink-400 border-pink-500/30";
      default:
        return "bg-slate-500/10 text-slate-300 border-slate-500/30";
    }
  }

  function platformLabel(platform) {
    switch (platform) {
      case "Steam":
        return "Steam";
      case "GOG":
        return "GOG";
      case "PSN":
        return "PSN";
      case "Antstream":
        return "Antstream";
      default:
        return platform;
    }
  }

  function buildCard(entry) {
    var card = document.createElement("article");
    card.className =
      "retro-card bg-slate-950 border border-slate-800 rounded-2xl p-5 space-y-4 flex flex-col";
    card.setAttribute("data-system", entry.system);
    card.setAttribute("data-retro-id", entry.id);

    // Header: title + system badge
    var header = document.createElement("div");
    header.className = "flex items-start justify-between gap-3";
    var titleWrap = document.createElement("div");
    titleWrap.className = "min-w-0";
    var title = document.createElement("h3");
    title.className = "text-base font-bold text-white leading-tight";
    title.textContent = entry.title;
    var meta = document.createElement("p");
    meta.className = "text-[11px] text-slate-500 mt-0.5";
    meta.textContent = entry.year + " · " + entry.genre;
    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);
    var badge = document.createElement("span");
    badge.className =
      "shrink-0 px-2 py-1 rounded-full text-[10px] font-bold border " +
      systemBadgeClass(entry.system);
    badge.textContent = entry.system;
    header.appendChild(titleWrap);
    header.appendChild(badge);
    card.appendChild(header);

    // Description
    var desc = document.createElement("p");
    desc.className = "text-xs text-slate-400 leading-relaxed";
    desc.textContent = entry.description;
    card.appendChild(desc);

    // Where to Play Legally
    if (entry.officialSources && entry.officialSources.length) {
      var legalLabel = document.createElement("p");
      legalLabel.className =
        "text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5";
      legalLabel.textContent = "Where to Play Legally";
      card.appendChild(legalLabel);
      var sources = document.createElement("div");
      sources.className = "space-y-1.5";
      entry.officialSources.forEach(function (src) {
        var a = document.createElement("a");
        a.href = src.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className =
          "retro-store-link flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-emerald-500/40 hover:bg-slate-800/60 transition-all text-xs";
        var left = document.createElement("span");
        left.className = "flex items-center gap-2 min-w-0";
        var dot = document.createElement("span");
        dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0";
        var name = document.createElement("span");
        name.className = "font-semibold text-slate-200 truncate";
        name.textContent = src.title;
        left.appendChild(dot);
        left.appendChild(name);
        var right = document.createElement("span");
        right.className = "flex items-center gap-2 shrink-0";
        var plat = document.createElement("span");
        plat.className = "text-[10px] font-bold text-slate-400";
        plat.textContent = platformLabel(src.platform);
        var price = document.createElement("span");
        price.className = "text-[11px] font-bold text-emerald-400";
        price.textContent = typeof src.price === "number" ? "$" + src.price.toFixed(2) : "Free";
        right.appendChild(plat);
        right.appendChild(price);
        a.appendChild(left);
        a.appendChild(right);
        sources.appendChild(a);
      });
      card.appendChild(sources);
    }

    // Homebrew link
    if (entry.homebrewUrl) {
      var hb = document.createElement("a");
      hb.href = entry.homebrewUrl;
      hb.target = "_blank";
      hb.rel = "noopener noreferrer";
      hb.className =
        "retro-homebrew-link inline-flex items-center gap-1.5 text-xs font-bold text-pink-400 hover:text-pink-300 transition-colors";
      hb.textContent = "Play the free original on itch.io →";
      card.appendChild(hb);
    }

    // Enhancement patches
    if (entry.enhancementPatches && entry.enhancementPatches.length) {
      var patchLabel = document.createElement("p");
      patchLabel.className =
        "text-[11px] font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5 pt-1";
      patchLabel.textContent = "Community Enhancement Patches";
      card.appendChild(patchLabel);
      var patches = document.createElement("div");
      patches.className = "space-y-1.5";
      entry.enhancementPatches.forEach(function (patch) {
        var a = document.createElement("a");
        a.href = patch.patchUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className =
          "retro-patch-link block px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:bg-slate-800/60 transition-all text-xs";
        var name = document.createElement("span");
        name.className = "block font-semibold text-amber-300";
        name.textContent = patch.name;
        var descTxt = document.createElement("span");
        descTxt.className = "block text-[11px] text-slate-400 mt-0.5";
        descTxt.textContent = patch.description;
        a.appendChild(name);
        a.appendChild(descTxt);
        patches.appendChild(a);
      });
      card.appendChild(patches);
    }

    return card;
  }

  function renderCatalog() {
    var grid = document.getElementById("retro-catalog");
    if (!grid) return;
    grid.textContent = "";
    var filtered =
      activeSystem === "all"
        ? catalog
        : catalog.filter(function (e) {
            return e.system === activeSystem;
          });

    if (!filtered.length) {
      var empty = document.createElement("div");
      empty.className = "col-span-full text-center py-12 text-slate-500 text-sm";
      empty.textContent = "No classic titles found for this system yet.";
      grid.appendChild(empty);
      return;
    }

    filtered.forEach(function (entry) {
      grid.appendChild(buildCard(entry));
    });
  }

  // ---- System filter chips ----------------------------------------------
  function wireFilters() {
    var container = document.getElementById("retro-system-filters");
    if (!container) return;
    container.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".retro-filter-btn");
      if (!btn) return;
      var sys = btn.getAttribute("data-system");
      if (!sys) return;
      filterSystem(sys);
    });
  }

  function filterSystem(sys) {
    activeSystem = sys || "all";
    var container = document.getElementById("retro-system-filters");
    if (container) {
      var btns = container.querySelectorAll(".retro-filter-btn");
      btns.forEach(function (b) {
        var isActive = b.getAttribute("data-system") === activeSystem;
        b.classList.toggle("bg-purple-600", isActive);
        b.classList.toggle("text-white", isActive);
        b.classList.toggle("bg-slate-800", !isActive);
        b.classList.toggle("text-slate-300", !isActive);
      });
    }
    renderCatalog();
  }

  // ---- Systems / hardware guides ----------------------------------------
  function renderSystems() {
    var container = document.getElementById("retro-systems-list");
    if (!container || !systems.length) return;
    container.textContent = "";
    systems.forEach(function (sys) {
      var item = document.createElement("div");
      item.className =
        "retro-system-item flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs";
      var left = document.createElement("div");
      left.className = "min-w-0";
      var name = document.createElement("p");
      name.className = "font-bold text-slate-200";
      name.textContent = sys.label;
      var hw = document.createElement("p");
      hw.className = "text-[11px] text-slate-500 mt-0.5";
      hw.textContent = "Dump hardware: " + sys.dumpHardware;
      left.appendChild(name);
      left.appendChild(hw);
      var link = document.createElement("a");
      link.href = sys.dumpGuide;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className =
        "retro-dump-link shrink-0 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold transition-all";
      link.textContent = "Guide";
      item.appendChild(left);
      item.appendChild(link);
      container.appendChild(item);
    });
  }

  // Sprint 7 (WUD-7.5): trusted emulator resource links + embedded setup video
  // guide. Server serves static whitelist-validated HTTPS constants; the client
  // re-validates every outbound link through safeRetroUrl() before render.
  function renderResources() {
    apiFetch(API_BASE + "/api/retro/resources")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.success) return;

        var list = document.getElementById("retro-resources-list");
        if (list && Array.isArray(data.emulators)) {
          list.textContent = "";
          data.emulators.forEach(function (emu) {
            var safe = safeRetroUrl(emu && emu.url);
            if (!safe || !emu || !emu.name) return;
            var a = document.createElement("a");
            a.href = safe;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.className =
              "retro-emulator-link inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-purple-500/50 text-slate-200 text-xs font-bold transition-all";
            var name = document.createElement("span");
            name.textContent = emu.name;
            var sys = document.createElement("span");
            sys.className = "text-[9px] text-slate-500 font-semibold";
            sys.textContent = emu.systems || "";
            a.appendChild(name);
            if (sys.textContent) a.appendChild(sys);
            list.appendChild(a);
          });
        }

        var guide = document.getElementById("retro-setup-guide");
        if (guide && data.setupGuide) {
          var g = data.setupGuide;
          guide.textContent = "";
          var title = document.createElement("p");
          title.className = "text-[11px] font-bold text-slate-300";
          title.textContent = g.title || "Setup video guide";
          guide.appendChild(title);
          var desc = document.createElement("p");
          desc.className = "text-[10px] text-slate-500 mt-0.5";
          desc.textContent = g.description || "";
          guide.appendChild(desc);
          var embed = safeRetroUrl(g.embedUrl);
          if (embed) {
            var frame = document.createElement("iframe");
            frame.className =
              "w-full aspect-video rounded-xl border border-slate-800 bg-slate-950 mt-2";
            frame.src = embed;
            frame.title = g.title || "Setup video guide";
            frame.setAttribute("loading", "lazy");
            frame.setAttribute("frameborder", "0");
            frame.setAttribute(
              "allow",
              "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
            );
            frame.setAttribute("allowfullscreen", "true");
            guide.appendChild(frame);
          }
        }
      })
      .catch(function () {
        /* non-critical — resources degrade silently */
      });
  }

  var runner = {
    ctx: null,
    canvas: null,
    raf: null,
    keys: {},
    chip8: null,
    running: false,
    gameKey: "local-rom",
  };

  // Minimal CHIP-8 interpreter used as a sandboxed fallback so users can run
  // legally dumped .ch8 ROMs entirely client-side. Real console cores are
  // multi-MB binaries that cannot ship inline; this keeps the runner fully
  // self-contained and offline-capable.
  function Chip8() {
    this.memory = new Uint8Array(4096);
    this.v = new Uint8Array(16);
    this.i = 0;
    this.pc = 0x200;
    this.stack = [];
    this.delay = 0;
    this.sound = 0;
    this.display = new Uint8Array(64 * 32);
    this.keys = new Uint8Array(16);
    this.drawFlag = false;
    // Font sprites
    var font = [
      0xf0, 0x90, 0x90, 0x90, 0xf0, 0x20, 0x60, 0x20, 0x20, 0x70, 0xf0, 0x10, 0xf0, 0x80, 0xf0,
      0xf0, 0x10, 0xf0, 0x10, 0xf0, 0x90, 0x90, 0xf0, 0x10, 0x10, 0xf0, 0x80, 0xf0, 0x10, 0xf0,
      0xf0, 0x80, 0xf0, 0x90, 0xf0, 0xf0, 0x10, 0x20, 0x40, 0x40, 0xf0, 0x90, 0xf0, 0x90, 0xf0,
      0xf0, 0x90, 0xf0, 0x10, 0xf0, 0xf0, 0x90, 0xf0, 0x90, 0x90, 0xe0, 0x90, 0xe0, 0x90, 0xe0,
      0xf0, 0x80, 0x80, 0x80, 0xf0, 0xe0, 0x90, 0x90, 0x90, 0xe0, 0xf0, 0x80, 0xf0, 0x80, 0xf0,
      0xf0, 0x80, 0xf0, 0x80, 0x80,
    ];
    for (var i = 0; i < font.length; i++) {
      this.memory[i] = font[i];
    }
  }

  Chip8.prototype.load = function (rom) {
    for (var i = 0; i < rom.length && 0x200 + i < 4096; i++) {
      this.memory[0x200 + i] = rom[i];
    }
    this.pc = 0x200;
    this.stack = [];
    this.delay = 0;
    this.sound = 0;
    this.display.fill(0);
    this.drawFlag = true;
  };

  Chip8.prototype.step = function () {
    var opcode = (this.memory[this.pc] << 8) | this.memory[this.pc + 1];
    var x = (opcode & 0x0f00) >> 8;
    var y = (opcode & 0x00f0) >> 4;
    var n = opcode & 0x000f;
    var nn = opcode & 0x00ff;
    var nnn = opcode & 0x0fff;
    this.pc += 2;

    switch (opcode & 0xf000) {
      case 0x0000:
        if (nn === 0xe0) {
          this.display.fill(0);
          this.drawFlag = true;
        } else if (nn === 0xee) {
          this.pc = this.stack.pop() || 0x200;
        }
        break;
      case 0x1000:
        this.pc = nnn;
        break;
      case 0x2000:
        this.stack.push(this.pc);
        this.pc = nnn;
        break;
      case 0x3000:
        if (this.v[x] === nn) this.pc += 2;
        break;
      case 0x4000:
        if (this.v[x] !== nn) this.pc += 2;
        break;
      case 0x5000:
        if (this.v[x] === this.v[y]) this.pc += 2;
        break;
      case 0x6000:
        this.v[x] = nn;
        break;
      case 0x7000:
        this.v[x] = (this.v[x] + nn) & 0xff;
        break;
      case 0x8000:
        switch (n) {
          case 0x0:
            this.v[x] = this.v[y];
            break;
          case 0x1:
            this.v[x] |= this.v[y];
            break;
          case 0x2:
            this.v[x] &= this.v[y];
            break;
          case 0x3:
            this.v[x] ^= this.v[y];
            break;
          case 0x4: {
            var sum = this.v[x] + this.v[y];
            this.v[0xf] = sum > 0xff ? 1 : 0;
            this.v[x] = sum & 0xff;
            break;
          }
          case 0x5: {
            this.v[0xf] = this.v[x] >= this.v[y] ? 1 : 0;
            this.v[x] = (this.v[x] - this.v[y]) & 0xff;
            break;
          }
          case 0x6:
            this.v[0xf] = this.v[x] & 1;
            this.v[x] >>= 1;
            break;
          case 0x7: {
            this.v[0xf] = this.v[y] >= this.v[x] ? 1 : 0;
            this.v[x] = (this.v[y] - this.v[x]) & 0xff;
            break;
          }
          case 0xe:
            this.v[0xf] = (this.v[x] >> 7) & 1;
            this.v[x] = (this.v[x] << 1) & 0xff;
            break;
        }
        break;
      case 0x9000:
        if (this.v[x] !== this.v[y]) this.pc += 2;
        break;
      case 0xa000:
        this.i = nnn;
        break;
      case 0xb000:
        this.pc = nnn + this.v[0];
        break;
      case 0xc000:
        this.v[x] = Math.floor(Math.random() * 256) & nn;
        break;
      case 0xd000: {
        var xp = this.v[x] % 64;
        var yp = this.v[y] % 32;
        this.v[0xf] = 0;
        for (var row = 0; row < n; row++) {
          var sprite = this.memory[this.i + row];
          for (var col = 0; col < 8; col++) {
            if ((sprite & (0x80 >> col)) !== 0) {
              var px = (xp + col) % 64;
              var py = (yp + row) % 32;
              var idx = px + py * 64;
              if (this.display[idx] === 1) this.v[0xf] = 1;
              this.display[idx] ^= 1;
            }
          }
        }
        this.drawFlag = true;
        break;
      }
      case 0xe000:
        if (nn === 0x9e) {
          if (this.keys[this.v[x]]) this.pc += 2;
        } else if (nn === 0xa1) {
          if (!this.keys[this.v[x]]) this.pc += 2;
        }
        break;
      case 0xf000:
        switch (nn) {
          case 0x07:
            this.v[x] = this.delay;
            break;
          case 0x0a: {
            var waiting = true;
            for (var k = 0; k < 16; k++) {
              if (this.keys[k]) {
                this.v[x] = k;
                waiting = false;
                break;
              }
            }
            if (waiting) {
              this.pc -= 2;
            }
            break;
          }
          case 0x15:
            this.delay = this.v[x];
            break;
          case 0x18:
            this.sound = this.v[x];
            break;
          case 0x1e:
            this.i = (this.i + this.v[x]) & 0xfff;
            break;
          case 0x29:
            this.i = this.v[x] * 5;
            break;
          case 0x33: {
            this.memory[this.i] = Math.floor(this.v[x] / 100);
            this.memory[this.i + 1] = Math.floor((this.v[x] % 100) / 10);
            this.memory[this.i + 2] = this.v[x] % 10;
            break;
          }
          case 0x55:
            for (var r = 0; r <= x; r++) this.memory[this.i + r] = this.v[r];
            break;
          case 0x65:
            for (var r2 = 0; r2 <= x; r2++) this.v[r2] = this.memory[this.i + r2];
            break;
        }
        break;
    }
  };

  function drawChip8() {
    if (!runner.ctx || !runner.chip8) return;
    var img = runner.ctx.createImageData(64, 32);
    var data = img.data;
    for (var i = 0; i < 64 * 32; i++) {
      var on = runner.chip8.display[i] === 1;
      var idx = i * 4;
      data[idx] = on ? 0xe9 : 0x0b;
      data[idx + 1] = on ? 0xd5 : 0x0f;
      data[idx + 2] = on ? 0xff : 0x19;
      data[idx + 3] = 255;
    }
    runner.ctx.putImageData(img, 0, 0);
    runner.chip8.drawFlag = false;
  }

  function chip8Loop() {
    if (!runner.running) return;
    if (runner.chip8) {
      for (var i = 0; i < 10; i++) {
        runner.chip8.step();
      }
      if (runner.chip8.delay > 0) runner.chip8.delay--;
      if (runner.chip8.sound > 0) runner.chip8.sound--;
      if (runner.chip8.drawFlag) drawChip8();
    }
    pollGamepad();
    runner.raf = requestAnimationFrame(chip8Loop);
  }

  function keyToChip8(code) {
    // Map keyboard to CHIP-8 hex keypad (1-4, Q-R, A-F, Z-V)
    var map = {
      Digit1: 0x1,
      Digit2: 0x2,
      Digit3: 0x3,
      Digit4: 0xc,
      KeyQ: 0x4,
      KeyW: 0x5,
      KeyE: 0x6,
      KeyR: 0xd,
      KeyA: 0x7,
      KeyS: 0x8,
      KeyD: 0x9,
      KeyF: 0xe,
      KeyZ: 0xa,
      KeyX: 0x0,
      KeyC: 0xb,
      KeyV: 0xf,
    };
    return map[code];
  }

  function wireRunnerControls() {
    var fullscreenBtn = document.getElementById("retro-runner-fullscreen");
    var closeBtn = document.getElementById("retro-runner-close");
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", function () {
        var wrap = document.getElementById("retro-runner-wrap");
        if (!wrap) return;
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else if (wrap.requestFullscreen) {
          wrap.requestFullscreen();
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", stopRunner);
    }
    document.addEventListener("keydown", function (ev) {
      if (!runner.running) return;
      runner.keys[ev.code] = true;
      if (runner.chip8) {
        var k = keyToChip8(ev.code);
        if (k !== undefined) runner.chip8.keys[k] = 1;
      }
      if (ev.code === "KeyF") {
        var wrap = document.getElementById("retro-runner-wrap");
        if (wrap && !document.fullscreenElement && wrap.requestFullscreen) wrap.requestFullscreen();
      }
    });
    document.addEventListener("keyup", function (ev) {
      runner.keys[ev.code] = false;
      if (runner.chip8) {
        var k = keyToChip8(ev.code);
        if (k !== undefined) runner.chip8.keys[k] = 0;
      }
    });
  }

  function setRunnerStatus(msg, isError) {
    var el = document.getElementById("retro-runner-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    el.classList.toggle("border-rose-500/40", !!isError);
    el.classList.toggle("bg-rose-900/40", !!isError);
    el.classList.toggle("text-rose-200", !!isError);
    el.classList.toggle("border-slate-800", !isError);
    el.classList.toggle("bg-slate-900/60", !isError);
    el.classList.toggle("text-slate-300", !isError);
  }

  function startRunner(title) {
    var wrap = document.getElementById("retro-runner-wrap");
    var titleEl = document.getElementById("retro-runner-title");
    var canvas = document.getElementById("retro-runner-canvas");
    if (!wrap || !canvas) return;
    runner.canvas = canvas;
    runner.ctx = canvas.getContext("2d");
    if (titleEl) titleEl.textContent = title;
    wrap.classList.remove("hidden");
    runner.running = true;
    if (runner.raf) cancelAnimationFrame(runner.raf);
    runner.raf = requestAnimationFrame(chip8Loop);
  }

  function stopRunner() {
    runner.running = false;
    if (runner.raf) cancelAnimationFrame(runner.raf);
    runner.raf = null;
    var wrap = document.getElementById("retro-runner-wrap");
    if (wrap) wrap.classList.add("hidden");
    if (document.fullscreenElement) document.exitFullscreen();
  }

  function loadLocalRom(file) {
    if (!file) return;
    var name = file.name || "local-rom";
    var ext = (name.split(".").pop() || "").toLowerCase();

    function handleBytes(buf) {
      var bytes = new Uint8Array(buf);
      runner.gameKey = name;
      if (ext === "ch8" || ext === "bin") {
        // CHIP-8 fallback runner
        if (!runner.chip8) runner.chip8 = new Chip8();
        runner.chip8.load(bytes);
        setRunnerStatus("Loaded " + name + " via sandboxed CHIP-8 interpreter.", false);
        startRunner(name);
      } else {
        // Other ROM formats: attempt WASM core if available, else graceful block.
        if (
          typeof window.__retroWasm !== "undefined" &&
          window.__retroWasm &&
          typeof window.__retroWasm.load === "function"
        ) {
          try {
            window.__retroWasm.load(name, bytes);
            setRunnerStatus("Loaded " + name + " via sandboxed WebAssembly core.", false);
            startRunner(name);
          } catch (e) {
            setRunnerStatus(
              "This ROM format (" +
                ext +
                ") requires a WebAssembly core that is not bundled. Try a .ch8 file for the built-in runner.",
              true,
            );
          }
        } else {
          setRunnerStatus(
            "This ROM format (" +
              ext +
              ") requires a WebAssembly core that is not bundled. Try a .ch8 file for the built-in runner.",
            true,
          );
        }
      }
    }

    // Prefer the modern Blob.arrayBuffer() API when available (also accepts
    // plain objects exposing an arrayBuffer() method, e.g. in tests). Fall back
    // to FileReader for older browsers / real File objects.
    if (typeof file.arrayBuffer === "function") {
      file
        .arrayBuffer()
        .then(handleBytes)
        .catch(function () {
          setRunnerStatus("Failed to read the selected file.", true);
        });
      return;
    }

    var reader = new FileReader();
    reader.onload = function (ev) {
      handleBytes(ev.target.result);
    };
    reader.onerror = function () {
      setRunnerStatus("Failed to read the selected file.", true);
    };
    reader.readAsArrayBuffer(file);
  }

  function wireDropzone() {
    var dropzone = document.getElementById("retro-rom-dropzone");
    var input = document.getElementById("retro-rom-input");
    if (!dropzone || !input) return;

    input.addEventListener("change", function () {
      if (input.files && input.files.length) {
        loadLocalRom(input.files[0]);
      }
      input.value = "";
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        dropzone.classList.add("border-purple-500", "bg-purple-500/5");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        dropzone.classList.remove("border-purple-500", "bg-purple-500/5");
      });
    });
    dropzone.addEventListener("drop", function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) {
        loadLocalRom(files[0]);
      }
    });
  }

  // ---- Save-State Slots (FEAT-0165) --------------------------------------
  // Serialize the CHIP-8 runner state into a plain object and persist it to
  // IndexedDB via OfflineStorage.saveRetroState. Restore rehydrates the runner.

  function serializeChip8State() {
    if (!runner.chip8) return null;
    return {
      memory: Array.from(runner.chip8.memory),
      v: Array.from(runner.chip8.v),
      i: runner.chip8.i,
      pc: runner.chip8.pc,
      stack: runner.chip8.stack.slice(),
      delay: runner.chip8.delay,
      sound: runner.chip8.sound,
      display: Array.from(runner.chip8.display),
      keys: Array.from(runner.chip8.keys),
      drawFlag: runner.chip8.drawFlag,
    };
  }

  function deserializeChip8State(state) {
    if (!state) return;
    if (!runner.chip8) runner.chip8 = new Chip8();
    runner.chip8.memory.set(state.memory || []);
    runner.chip8.v.set(state.v || []);
    runner.chip8.i = state.i || 0;
    runner.chip8.pc = state.pc || 0x200;
    runner.chip8.stack = (state.stack || []).slice();
    runner.chip8.delay = state.delay || 0;
    runner.chip8.sound = state.sound || 0;
    runner.chip8.display.set(state.display || []);
    runner.chip8.keys.set(state.keys || []);
    runner.chip8.drawFlag = state.drawFlag !== false;
  }

  /** Persist the current runner state to IndexedDB slot. Returns a Promise. */
  function saveState(slot) {
    var s = slot || 1;
    var state = serializeChip8State();
    if (!state) {
      return Promise.reject(new Error("No active runner state to save."));
    }
    if (window.OfflineStorage && typeof window.OfflineStorage.saveRetroState === "function") {
      return window.OfflineStorage.saveRetroState(runner.gameKey, s, state).then(function () {
        setRunnerStatus("Saved state to slot " + s + ".", false);
        showToast("Save state stored in slot " + s + ".", false);
      });
    }
    return Promise.reject(new Error("Offline storage is unavailable."));
  }

  /** Restore a runner state from IndexedDB slot. Returns a Promise. */
  function loadState(slot) {
    var s = slot || 1;
    if (window.OfflineStorage && typeof window.OfflineStorage.loadRetroState === "function") {
      return window.OfflineStorage.loadRetroState(runner.gameKey, s).then(function (record) {
        if (!record || !record.stateData) {
          setRunnerStatus("No save found in slot " + s + ".", true);
          return null;
        }
        deserializeChip8State(record.stateData);
        setRunnerStatus("Loaded state from slot " + s + ".", false);
        showToast("Save state loaded from slot " + s + ".", false);
        if (!runner.running) {
          var wrap = document.getElementById("retro-runner-wrap");
          if (wrap) {
            wrap.classList.remove("hidden");
            runner.running = true;
            if (runner.raf) cancelAnimationFrame(runner.raf);
            runner.raf = requestAnimationFrame(chip8Loop);
          }
        }
        return record.stateData;
      });
    }
    return Promise.reject(new Error("Offline storage is unavailable."));
  }

  // ---- Gamepad API (FEAT-0165) -------------------------------------------
  // Bind gamepadconnected/gamepaddisconnected to update the status badge and
  // poll navigator.getGamepads() in the runner loop to route D-pad/buttons to
  // the CHIP-8 hex keypad.

  var gamepadConnected = false;

  // Map a standard gamepad to the CHIP-8 hex keypad (0-F).
  // D-pad up/down/left/right -> 2/8/4/6, face buttons -> 5/7/1/3, triggers -> 0/F.
  function gamepadToChip8(gp) {
    if (!gp || !runner.chip8) return;
    var keys = runner.chip8.keys;
    // Clear previous gamepad-driven keys each poll.
    for (var i = 0; i < 16; i++) keys[i] = 0;
    var map = {
      12: 0x2, // D-pad up
      13: 0x8, // D-pad down
      14: 0x4, // D-pad left
      15: 0x6, // D-pad right
      0: 0x5, // A (bottom)
      1: 0x7, // B (right)
      2: 0x1, // X (left)
      3: 0x3, // Y (top)
      6: 0x0, // L1
      7: 0xf, // R1
    };
    for (var b in map) {
      if (gp.buttons[b] && gp.buttons[b].pressed) {
        keys[map[b]] = 1;
      }
    }
  }

  function pollGamepad() {
    if (!gamepadConnected) return;
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
      if (pads[i]) {
        gamepadToChip8(pads[i]);
        return;
      }
    }
  }

  function updateGamepadStatus(connected) {
    gamepadConnected = connected;
    var el = document.getElementById("gamepad-status");
    if (!el) return;
    if (connected) {
      el.textContent = "🎮 Controller Connected";
      el.classList.remove("bg-slate-800", "text-slate-300", "border-slate-700");
      el.classList.add("bg-emerald-500/10", "text-emerald-300", "border-emerald-500/30");
    } else {
      el.textContent = "🎮 No Controller";
      el.classList.remove("bg-emerald-500/10", "text-emerald-300", "border-emerald-500/30");
      el.classList.add("bg-slate-800", "text-slate-300", "border-slate-700");
    }
  }

  function wireGamepad() {
    window.addEventListener("gamepadconnected", function () {
      updateGamepadStatus(true);
    });
    window.addEventListener("gamepaddisconnected", function () {
      updateGamepadStatus(false);
    });
    // Detect already-connected gamepads on init.
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
      if (pads[i]) {
        updateGamepadStatus(true);
        break;
      }
    }
  }

  // ---- Patch UI Wiring (FEAT-0165) ---------------------------------------
  function setPatchStatus(msg, isError) {
    var el = document.getElementById("retro-patch-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    el.classList.toggle("border-rose-500/40", !!isError);
    el.classList.toggle("bg-rose-900/40", !!isError);
    el.classList.toggle("text-rose-200", !!isError);
    el.classList.toggle("border-slate-800", !isError);
    el.classList.toggle("bg-slate-900/60", !isError);
    el.classList.toggle("text-slate-300", !isError);
  }

  function updatePatchChecksum() {
    var el = document.getElementById("retro-patch-checksum");
    if (!el) return;
    if (patchState.patchedBuffer) {
      el.textContent = "Patched CRC32: " + crc32Hex(patchState.patchedBuffer);
    } else if (patchState.romBuffer) {
      el.textContent = "ROM CRC32: " + crc32Hex(patchState.romBuffer);
    } else {
      el.textContent = "";
    }
  }

  function updateExportButton() {
    var btn = document.getElementById("btn-retro-export-patched");
    if (!btn) return;
    btn.disabled = !patchState.patchedBuffer;
  }

  function tryApplyPatch() {
    if (!patchState.romBuffer || !patchState.patchBuffer) {
      setPatchStatus("Load both a base ROM and a patch to apply.", true);
      return;
    }
    var result = applyPatch(patchState.romBuffer, patchState.patchBuffer);
    if (result.success && result.patchedBuffer) {
      patchState.patchedBuffer = result.patchedBuffer;
      var base = (patchState.romName || "rom").replace(/\.[^.]+$/, "");
      patchState.patchedName = base + "-patched.bin";
      setPatchStatus("Patch applied successfully. CRC32 verified.", false);
      updatePatchChecksum();
      updateExportButton();
      showToast("Patch applied successfully.", false);
    } else {
      patchState.patchedBuffer = null;
      patchState.patchedName = "";
      setPatchStatus(result.error || "Failed to apply patch.", true);
      updatePatchChecksum();
      updateExportButton();
    }
  }

  function exportPatchedRom() {
    if (!patchState.patchedBuffer) return;
    var blob = new Blob([patchState.patchedBuffer], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = patchState.patchedName || "patched-rom.bin";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    showToast("Patched ROM exported.", false);
  }

  function wirePatchDropzone() {
    var dropzone = document.getElementById("retro-patch-dropzone");
    var input = document.getElementById("retro-patch-input");
    if (!dropzone || !input) return;

    input.addEventListener("change", function () {
      if (input.files && input.files.length) {
        var file = input.files[0];
        var reader = new FileReader();
        reader.onload = function (ev) {
          patchState.patchBuffer = ev.target.result;
          patchState.patchName = file.name;
          setPatchStatus("Loaded patch: " + file.name + ".", false);
          tryApplyPatch();
        };
        reader.onerror = function () {
          setPatchStatus("Failed to read the patch file.", true);
        };
        reader.readAsArrayBuffer(file);
      }
      input.value = "";
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        dropzone.classList.add("border-amber-500", "bg-amber-500/5");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        dropzone.classList.remove("border-amber-500", "bg-amber-500/5");
      });
    });
    dropzone.addEventListener("drop", function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) {
        var file = files[0];
        var reader = new FileReader();
        reader.onload = function (ev2) {
          patchState.patchBuffer = ev2.target.result;
          patchState.patchName = file.name;
          setPatchStatus("Loaded patch: " + file.name + ".", false);
          tryApplyPatch();
        };
        reader.onerror = function () {
          setPatchStatus("Failed to read the patch file.", true);
        };
        reader.readAsArrayBuffer(file);
      }
    });
  }

  function wirePatchRomCapture() {
    // Capture the base ROM loaded via the runner dropzone so it can be patched.
    var romInput = document.getElementById("retro-rom-input");
    if (romInput) {
      romInput.addEventListener("change", function () {
        if (romInput.files && romInput.files.length) {
          var file = romInput.files[0];
          var reader = new FileReader();
          reader.onload = function (ev) {
            patchState.romBuffer = ev.target.result;
            patchState.romName = file.name;
            updatePatchChecksum();
            tryApplyPatch();
          };
          reader.readAsArrayBuffer(file);
        }
      });
    }
  }

  function wireSandboxControls() {
    var saveBtn = document.getElementById("btn-retro-save-slot1");
    var loadBtn = document.getElementById("btn-retro-load-slot1");
    var mapBtn = document.getElementById("btn-retro-gamepad-map");
    var mapPanel = document.getElementById("retro-gamepad-map-panel");
    var exportBtn = document.getElementById("btn-retro-export-patched");

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        saveState(1).catch(function (err) {
          // Sprint 1A (EPICSEC04): sanitize raw errors before they reach the UI.
          setRunnerStatus(
            typeof window.safeToastError === "function"
              ? window.safeToastError(err, "Failed to save state.")
              : err && err.message
                ? err.message
                : "Failed to save state.",
            true,
          );
        });
      });
    }
    if (loadBtn) {
      loadBtn.addEventListener("click", function () {
        loadState(1).catch(function (err) {
          // Sprint 1A (EPICSEC04): sanitize raw errors before they reach the UI.
          setRunnerStatus(
            typeof window.safeToastError === "function"
              ? window.safeToastError(err, "Failed to load state.")
              : err && err.message
                ? err.message
                : "Failed to load state.",
            true,
          );
        });
      });
    }
    if (mapBtn && mapPanel) {
      mapBtn.addEventListener("click", function () {
        mapPanel.classList.toggle("hidden");
      });
    }
    if (exportBtn) {
      exportBtn.addEventListener("click", exportPatchedRom);
    }
  }

  // ---- Onboarding wiring (Sprint 5 / EPIC-07) ---------------------------
  // Collapsible "Getting Started" panel, dismissible contextual tooltips and
  // versioned documentation links. Dismissal/collapse state persists in
  // localStorage so returning visitors are not re-onboarded.
  var ONBOARDING_KEY = "mgpl_retro_onboarding_dismissed";
  var ONBOARDING_COLLAPSED_KEY = "mgpl_retro_onboarding_collapsed";
  var TOOLTIPS_KEY = "mgpl_retro_tooltips_dismissed";

  function readLocal(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch (e) {
      return fallback;
    }
  }

  function writeLocal(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* private-mode ignores writes */
    }
  }

  function wireOnboarding() {
    var panel = document.getElementById("retro-onboarding");
    var body = document.getElementById("retro-onboarding-body");
    var toggle = document.getElementById("retro-onboarding-toggle");

    // Whole-panel dismissal persists across visits.
    if (panel && readLocal(ONBOARDING_KEY, "") === "1") {
      panel.classList.add("hidden");
      return;
    }

    // Restore the collapsed state and chevron orientation.
    if (body && toggle) {
      var collapsed = readLocal(ONBOARDING_COLLAPSED_KEY, "") === "1";
      if (collapsed) {
        body.classList.add("hidden");
        toggle.setAttribute("aria-expanded", "false");
        var chev = toggle.querySelector(".retro-onboarding-chevron");
        if (chev) chev.classList.add("rotate-180");
      }
    }

    if (toggle && body) {
      toggle.addEventListener("click", function () {
        var isCollapsed = body.classList.toggle("hidden");
        toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        writeLocal(ONBOARDING_COLLAPSED_KEY, isCollapsed ? "1" : "");
        var chev = toggle.querySelector(".retro-onboarding-chevron");
        if (chev) chev.classList.toggle("rotate-180", isCollapsed);
      });
    }

    // Dismiss-for-good button.
    var dismissBtn = document.getElementById("retro-onboarding-dismiss");
    if (dismissBtn && panel) {
      dismissBtn.addEventListener("click", function () {
        writeLocal(ONBOARDING_KEY, "1");
        panel.classList.add("hidden");
        showToast("Getting Started guide dismissed. You can reset it from Settings > Data.", false);
      });
    }

    // Dismissible contextual tooltips (persisted per tip id).
    var dismissedTips = [];
    try {
      dismissedTips = JSON.parse(readLocal(TOOLTIPS_KEY, "[]")) || [];
    } catch (e) {
      dismissedTips = [];
    }

    var tips = document.querySelectorAll("[data-retro-tip]");
    Array.prototype.forEach.call(tips, function (tip) {
      var id = tip.getAttribute("data-retro-tip");
      if (!id) return;
      if (dismissedTips.indexOf(id) !== -1) {
        tip.classList.add("hidden");
        return;
      }
      var closeBtn = tip.querySelector(".retro-tip-dismiss");
      if (closeBtn) {
        closeBtn.addEventListener("click", function () {
          tip.classList.add("hidden");
          if (dismissedTips.indexOf(id) === -1) dismissedTips.push(id);
          writeLocal(TOOLTIPS_KEY, JSON.stringify(dismissedTips));
        });
      }
    });
  }

  // ---- Init --------------------------------------------------------------
  // Sprint 6.1 (GAP-RETRO): deterministic fallback catalog of classic titles
  // pointing ONLY at official digital re-releases / subscription catalogs
  // (zero-hosting doctrine — no ROMs, no copyrighted assets). Used when the live
  // /api/retro/catalog endpoint is unreachable or returns malformed JSON.
  var RETRO_FALLBACK_CATALOG = [
    {
      title: "Super Mario Bros.",
      system: "NES",
      year: "1985",
      description: "Official re-release via Nintendo Switch Online.",
      legalSources: [
        {
          label: "Nintendo Switch Online",
          url: "https://www.nintendo.com/us/store/products/super-mario-bros-nes-switch/",
        },
      ],
    },
    {
      title: "Sonic the Hedgehog",
      system: "Sega Genesis",
      year: "1991",
      description: "Official SEGA re-release on Steam.",
      legalSources: [{ label: "Steam (SEGA)", url: "https://store.steampowered.com/app/71163/" }],
    },
    {
      title: "Final Fantasy VII",
      system: "PlayStation",
      year: "1997",
      description: "Official Square Enix re-release on Steam.",
      legalSources: [
        { label: "Steam (Square Enix)", url: "https://store.steampowered.com/app/39140/" },
      ],
    },
    {
      title: "Castlevania Anniversary Collection",
      system: "Multi",
      year: "2019",
      description: "Official Konami collection on Steam.",
      legalSources: [
        { label: "Steam (Konami)", url: "https://store.steampowered.com/app/1012530/" },
      ],
    },
  ];

  function renderRetroFallbackGrid(grid, message) {
    if (!grid) return;
    grid.textContent = "";
    var info = document.createElement("div");
    info.className = "col-span-full text-center py-8 text-slate-400 text-sm";
    info.innerHTML =
      '<p class="font-semibold text-amber-300 mb-1">⚠️ Offline / catalog unavailable</p>' +
      '<p class="mb-3">' +
      message +
      "</p>";
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className =
      "px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold";
    retry.textContent = "Retry";
    retry.addEventListener("click", function () {
      loadCatalogWithFallback(grid);
    });
    info.appendChild(retry);
    grid.appendChild(info);

    RETRO_FALLBACK_CATALOG.forEach(function (item) {
      var card = document.createElement("div");
      card.className = "bg-slate-950/80 border border-slate-800 rounded-2xl p-5";
      var titleEl = document.createElement("h4");
      titleEl.className = "text-sm font-bold text-white";
      titleEl.textContent = item.title;
      var meta = document.createElement("p");
      meta.className = "text-xs text-slate-400 mt-1";
      meta.textContent = item.system + " · " + item.year;
      var desc = document.createElement("p");
      desc.className = "text-xs text-slate-500 mt-1";
      desc.textContent = item.description;
      var link = document.createElement("a");
      link.href = item.legalSources[0].url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className =
        "mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white text-[11px] font-bold border border-purple-500/30";
      link.textContent = item.legalSources[0].label;
      card.appendChild(titleEl);
      card.appendChild(meta);
      card.appendChild(desc);
      card.appendChild(link);
      grid.appendChild(card);
    });
  }

  function loadCatalogWithFallback(grid) {
    if (!grid) return;
    grid.textContent = "";
    var loading = document.createElement("div");
    loading.className =
      "col-span-full flex flex-col items-center justify-center py-12 text-slate-500";
    loading.innerHTML =
      '<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500 mb-2"></div><p class="text-sm font-medium">Loading classic catalog...</p>';
    grid.appendChild(loading);

    function attempt(remaining) {
      apiFetch(API_BASE + "/api/retro/catalog")
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data && data.success && Array.isArray(data.catalog) && data.catalog.length > 0) {
            catalog = data.catalog;
            renderCatalog();
            return;
          }
          throw new Error("Malformed retro catalog payload.");
        })
        .catch(function () {
          if (remaining > 0) {
            setTimeout(function () {
              attempt(remaining - 1);
            }, 800);
          } else {
            renderRetroFallbackGrid(
              grid,
              "The live retro catalog could not be reached. Showing a small offline legal-directory fallback.",
            );
          }
        });
    }
    attempt(1); // one retry after the initial attempt
  }

  function init() {
    if (initialized) {
      // Re-render in case catalog changed while away.
      renderCatalog();
      return;
    }
    initialized = true;

    wireFilters();
    wireOnboarding();
    wireDropzone();
    wireRunnerControls();
    wireGamepad();
    wirePatchDropzone();
    wirePatchRomCapture();
    wireSandboxControls();
    updateExportButton();

    var grid = document.getElementById("retro-catalog");
    if (grid) {
      grid.textContent = "";
      var loading = document.createElement("div");
      loading.className =
        "col-span-full flex flex-col items-center justify-center py-12 text-slate-500";
      loading.innerHTML =
        '<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500 mb-2"></div><p class="text-sm font-medium">Loading classic catalog...</p>';
      grid.appendChild(loading);
    }

    // Sprint 6.1 (GAP-RETRO): catalog fallback loader — network or JSON parsing
    // failures degrade gracefully to the offline legal-directory fallback
    // instead of a bare error string.
    loadCatalogWithFallback(grid);

    apiFetch(API_BASE + "/api/retro/systems")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data && data.success && Array.isArray(data.systems)) {
          systems = data.systems;
          renderSystems();
        }
      })
      .catch(function () {
        /* non-critical */
      });

    // Sprint 7 (WUD-7.5): render trusted emulator resources + setup video guide.
    renderResources();
  }

  // Expose public API
  window.__retro = {
    init: init,
    filterSystem: filterSystem,
    loadLocalRom: loadLocalRom,
    applyPatch: applyPatch,
    crc32Hex: crc32Hex,
    md5Hex: md5Hex,
    saveState: saveState,
    loadState: loadState,
  };
})();
