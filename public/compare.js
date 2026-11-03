/* MGPL Hardware Fleet Comparison Matrix & Playability Benchmarking (FEAT-0155)
 *
 * Exposes window.__compare — a self-contained module that:
 *   - Loads the owned game catalog into #compare-game-select
 *   - Loads fleet devices into #compare-device-chips as toggle chips
 *   - Fetches POST /api/compare/benchmark on explicit "Analyze Benchmark" action
 *   - Renders a side-by-side matrix table off-DOM with visual status pills
 *   - Provides a "Desktop vs Handheld" quick preset
 *   - Persists benchmark results to IndexedDB (store_games) for offline fallback
 *
 * Explicit Action Trigger Rule (Chapter 23): the benchmark is only computed when
 * the user clicks "Analyze Benchmark" — never via reactive recalculation.
 */
(function () {
  "use strict";

  const API_BASE = "";

  // Sprint 6.1 (GAP-006): safeValue — reject null/undefined/malformed values
  // and HTML-escape everything before it can reach innerHTML. The spec fallback
  // for missing values is "Data unavailable".
  function escHtml(v) {
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeValue(v) {
    if (v === null || v === undefined) return "Data unavailable";
    const s = String(v).trim();
    if (s === "") return "Data unavailable";
    return escHtml(s);
  }

  // Fallback fleet profiles used when the Devices table is empty or a known
  // reference device is missing. Mirrors the backend fallbacks in compare.ts.
  const FALLBACK_DEVICES = [
    {
      id: "deck_h",
      deviceName: "Steam Deck (Handheld)",
      cpu: "AMD Zen 2 4c/8t",
      gpu: "AMD RDNA2 8CU",
      ramGb: 16,
      vramGb: 16,
      tdpWatt: 15,
      formFactor: "handheld",
    },
    {
      id: "custom-pc-5080",
      deviceName: "RTX 5080 Desktop",
      cpu: "AMD Ryzen 7",
      gpu: "NVIDIA RTX 5080",
      ramGb: 64,
      vramGb: 16,
      tdpWatt: 350,
      formFactor: "desktop",
    },
  ];

  // Internal state.
  let games = [];
  let devices = [];
  let selectedDeviceIds = [];
  let selectedGameId = "";
  let initialized = false;
  // True when the Hardware Fleet Benchmark section is absent from the page
  // (removed from #page-compare) — every public entry point becomes a no-op.
  let moduleUnavailable = false;

  // DOM element references (resolved lazily on init).
  let elGameSelect = null;
  let elDeviceChips = null;
  let elRunBtn = null;
  let elStatus = null;
  let elMatrix = null;
  let elPreset = null;

  /* ===== Small DOM helpers ===== */

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(message, isError) {
    if (!elStatus) return;
    elStatus.textContent = message || "";
    elStatus.classList.toggle("text-rose-400", !!isError);
    elStatus.classList.toggle("text-slate-500", !isError);
  }

  function setRunEnabled(enabled) {
    if (!elRunBtn) return;
    elRunBtn.disabled = !enabled;
  }

  /* ===== Data loading ===== */

  async function loadGames() {
    try {
      const res = await fetch(`${API_BASE}/api/games?active=true&owned=true`);
      const data = await res.json();
      if (data && data.success) {
        games = window.safeArray
          ? window.safeArray(data.games)
          : Array.isArray(data.games)
            ? data.games
            : [];
      }
    } catch (err) {
      console.error("compare.js: failed to load games catalog", err);
    }
    renderGameSelect();
  }

  function gameIdOf(g) {
    return g.GameID || g.id || g.gameId;
  }

  function gameTitleOf(g) {
    return g["Game Title"] || g.gameTitle || g.title || "Game";
  }

  function renderGameSelect() {
    if (!elGameSelect) return;
    const current = elGameSelect.value;
    elGameSelect.innerHTML =
      '<option value="">-- Select a game --</option>' +
      games.map((g) => `<option value="${gameIdOf(g)}">${gameTitleOf(g)}</option>`).join("");
    if (current) elGameSelect.value = current;
  }

  async function loadDevices() {
    let fetched = [];
    try {
      const res = await fetch(`${API_BASE}/api/devices?status=active`);
      const data = await res.json();
      const devicesRaw =
        data && data.success
          ? window.safeArray
            ? window.safeArray(data.devices)
            : Array.isArray(data.devices)
              ? data.devices
              : []
          : [];
      fetched = devicesRaw.map((d) => {
        const prof = window.safeDeviceProfile ? window.safeDeviceProfile(d) : null;
        return {
          id: d.id || d.deviceId,
          deviceName: d.deviceName || d.id || "Device",
          cpu: prof ? prof.cpu : d.cpu || d.cpuModel || null,
          gpu: prof ? prof.gpu : d.gpuModel || d.gpu || null,
          ramGb: d.ramGb != null ? Number(d.ramGb) : prof && prof.ramGb > 0 ? prof.ramGb : null,
          vramGb:
            d.vramGb != null ? Number(d.vramGb) : prof && prof.vramGb > 0 ? prof.vramGb : null,
          tdpWatt: d.tdpWatt != null ? Number(d.tdpWatt) : null,
          formFactor: d.formFactor || null,
        };
      });
    } catch (err) {
      console.error("compare.js: failed to load fleet devices", err);
    }

    // Merge fallback reference profiles so the matrix always has content.
    const knownIds = new Set(fetched.map((d) => d.id));
    const merged = fetched.slice();
    FALLBACK_DEVICES.forEach((fb) => {
      if (!knownIds.has(fb.id)) merged.push(fb);
    });
    devices = merged;
    renderDeviceChips();
  }

  function renderDeviceChips() {
    if (!elDeviceChips) return;
    if (devices.length === 0) {
      elDeviceChips.innerHTML =
        '<span class="text-xs text-slate-500">No fleet devices found.</span>';
      return;
    }
    elDeviceChips.innerHTML = devices
      .map((d) => {
        const active = selectedDeviceIds.includes(d.id);
        return `
          <button type="button" data-device-id="${d.id}" aria-pressed="${active}"
            class="device-chip px-3 py-1.5 rounded-lg text-xs font-bold border transition-all flex items-center gap-1.5 ${
              active
                ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-200"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500"
            }">
            <span>${d.deviceName}</span>
            <span class="text-[10px] opacity-70">${d.gpu || ""}</span>
          </button>
        `;
      })
      .join("");

    elDeviceChips.querySelectorAll(".device-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const id = chip.getAttribute("data-device-id");
        toggleDevice(id);
      });
    });
  }

  function toggleDevice(id) {
    const idx = selectedDeviceIds.indexOf(id);
    if (idx >= 0) {
      selectedDeviceIds.splice(idx, 1);
    } else {
      if (selectedDeviceIds.length >= 10) {
        setStatus("Maximum of 10 devices per benchmark.", true);
        return;
      }
      selectedDeviceIds.push(id);
    }
    renderDeviceChips();
    updateRunState();
  }

  function updateRunState() {
    const ready = selectedGameId && selectedDeviceIds.length > 0;
    setRunEnabled(!!ready);
    if (!ready) {
      setStatus(
        selectedGameId ? "Select at least one device." : "Select a game and at least one device.",
      );
    } else {
      setStatus("");
    }
  }

  /* ===== Benchmark execution ===== */

  function cacheKey() {
    const ids = selectedDeviceIds.slice().sort().join(",");
    return `compare:${selectedGameId}:${ids}`;
  }

  async function runBenchmark() {
    if (moduleUnavailable) return;
    if (!selectedGameId || selectedDeviceIds.length === 0) {
      setStatus("Select a game and at least one device.", true);
      return;
    }

    setStatus("Analyzing benchmark…");
    setRunEnabled(false);

    const payload = { gameId: selectedGameId, deviceIds: selectedDeviceIds };
    const key = cacheKey();

    try {
      const res = await fetch(`${API_BASE}/api/compare/benchmark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Benchmark failed");
      }
      // Persist for offline fallback (reuse store_games with a compare key).
      if (window.OfflineStorage) {
        window.OfflineStorage.save("store_games", key, data).catch(() => {});
      }
      renderMatrix(data);
      setStatus("Benchmark complete.");
    } catch (err) {
      console.error("compare.js: benchmark error", err);
      // Offline / failure fallback: render cached result if available.
      const cached = await getCachedBenchmark(key);
      if (cached) {
        renderMatrix(cached);
        setStatus("Showing cached benchmark (offline).");
      } else {
        setStatus("Benchmark failed. Check connection and try again.", true);
      }
    } finally {
      setRunEnabled(true);
    }
  }

  async function getCachedBenchmark(key) {
    if (!window.OfflineStorage) return null;
    try {
      return await window.OfflineStorage.get("store_games", key);
    } catch (err) {
      return null;
    }
  }

  /* ===== Matrix rendering (off-DOM assembly) ===== */

  function statusPill(rating) {
    // green = surplus headroom, amber = tight, red = deficit
    let cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    if (rating === "Adequate") {
      cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    } else if (rating === "Constrained") {
      cls = "bg-amber-500/15 text-amber-300 border-amber-500/40";
    } else if (rating === "Insufficient") {
      cls = "bg-rose-500/15 text-rose-300 border-rose-500/40";
    }
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${cls}">${rating}</span>`;
  }

  function fpsTierPill(tier) {
    let cls;
    if (tier === "120+ FPS Ultra") {
      cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    } else if (tier === "60 FPS High") {
      cls = "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
    } else if (tier === "45 FPS Medium (Handheld)") {
      cls = "bg-amber-500/15 text-amber-300 border-amber-500/40";
    } else {
      cls = "bg-rose-500/15 text-rose-300 border-rose-500/40";
    }
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${cls}">${tier}</span>`;
  }

  function marginCell(value, isVram) {
    if (value === null || value === undefined) {
      return '<span class="text-slate-500">—</span>';
    }
    const num = Number(value);
    const label = isVram ? "VRAM" : "RAM";
    // Visual status pill: green = surplus, amber = tight, red = deficit.
    let cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    if (num < 0) cls = "bg-rose-500/15 text-rose-300 border-rose-500/40";
    else if (num < 2) cls = "bg-amber-500/15 text-amber-300 border-amber-500/40";
    const sign = num > 0 ? "+" : "";
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${cls}">${sign}${num.toFixed(1)} GB ${label}</span>`;
  }

  // Per-run memoization caches for derived tier/pill lookups (Sprint 34 perf).
  // Keyed by device id + raw metric value so repeated derivations across the
  // matrix are computed once per benchmark run instead of per cell.
  const memo = {
    fpsTier: new Map(),
    headroom: new Map(),
    margin: new Map(),
  };

  function memoizedFpsTier(deviceId, tier) {
    const key = deviceId + ":" + tier;
    if (memo.fpsTier.has(key)) return memo.fpsTier.get(key);
    const html = fpsTierPill(tier);
    memo.fpsTier.set(key, html);
    return html;
  }

  function memoizedHeadroom(deviceId, rating) {
    const key = deviceId + ":" + rating;
    if (memo.headroom.has(key)) return memo.headroom.get(key);
    const html = statusPill(rating);
    memo.headroom.set(key, html);
    return html;
  }

  function memoizedMargin(deviceId, value, isVram) {
    const key = deviceId + ":" + (isVram ? "v" : "r") + ":" + value;
    if (memo.margin.has(key)) return memo.margin.get(key);
    const html = marginCell(value, isVram);
    memo.margin.set(key, html);
    return html;
  }

  function renderMatrix(data) {
    if (!elMatrix) return;
    const game = data.game || {};
    const deviceRows = Array.isArray(data.devices) ? data.devices : [];

    // Reset per-run memoization caches.
    memo.fpsTier.clear();
    memo.headroom.clear();
    memo.margin.clear();

    const frag = document.createDocumentFragment();
    const wrap = document.createElement("div");
    wrap.className = "p-4 space-y-4 min-w-0";

    // Header: game identity.
    const header = document.createElement("div");
    header.className = "flex items-center gap-3";
    if (game.coverImage) {
      const img = document.createElement("img");
      img.src = game.coverImage;
      img.alt = game.title || "Game cover";
      img.className = "w-12 h-16 object-cover rounded-lg border border-slate-700";
      header.appendChild(img);
    }
    const titleBlock = document.createElement("div");
    titleBlock.innerHTML = `
      <h3 class="text-sm font-bold text-white">${safeValue(game.title) || "Game"}</h3>
      <p class="text-xs text-slate-400">${safeValue(game.genre)}</p>
    `;
    header.appendChild(titleBlock);
    wrap.appendChild(header);

    if (deviceRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "p-6 text-center text-slate-500 text-sm";
      empty.textContent = "No device results returned.";
      wrap.appendChild(empty);
    } else {
      const table = document.createElement("table");
      table.className = "w-full whitespace-nowrap text-left text-xs";
      table.setAttribute("role", "table");
      table.setAttribute("aria-label", "Hardware fleet benchmark matrix");

      const thead = document.createElement("thead");
      thead.className = "bg-slate-950 text-slate-400 uppercase tracking-wider";
      const headRow = document.createElement("tr");
      headRow.innerHTML =
        '<th scope="col" class="px-4 py-3 font-bold">Device</th>' +
        deviceRows
          .map(
            (d) =>
              `<th scope="col" class="px-4 py-3 font-bold">${safeValue(d.deviceName) || safeValue(d.id)}</th>`,
          )
          .join("");
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      tbody.className = "divide-y divide-slate-800";

      function addRow(label, metric, cellBuilder) {
        const tr = document.createElement("tr");
        const labelTd = document.createElement("td");
        labelTd.className = "px-4 py-3 font-bold text-slate-300 whitespace-nowrap";
        labelTd.textContent = label;
        tr.appendChild(labelTd);
        deviceRows.forEach((d) => {
          const td = document.createElement("td");
          td.className = "px-4 py-3";
          if (metric) td.setAttribute("data-metric", metric);
          if (d.id) td.setAttribute("data-device", d.id);
          td.innerHTML = cellBuilder(d);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }

      addRow("GPU", null, (d) => `<span class="text-slate-200">${safeValue(d.gpu)}</span>`);
      addRow(
        "RAM",
        null,
        (d) =>
          `<span class="text-slate-200">${d.ramGb != null ? safeValue(d.ramGb) + " GB" : "Data unavailable"}</span>`,
      );
      addRow(
        "VRAM",
        null,
        (d) =>
          `<span class="text-slate-200">${d.vramGb != null ? safeValue(d.vramGb) + " GB" : "Data unavailable"}</span>`,
      );
      addRow(
        "TDP",
        null,
        (d) =>
          `<span class="text-slate-200">${d.tdpWatt != null ? safeValue(d.tdpWatt) + " W" : "Data unavailable"}</span>`,
      );
      addRow("RAM Margin", "ramMargin", (d) =>
        memoizedMargin(d.id, d.metrics && d.metrics.ramMarginGb, false),
      );
      addRow("VRAM Margin", "vramMargin", (d) =>
        memoizedMargin(d.id, d.metrics && d.metrics.vramMarginGb, true),
      );
      addRow("Target FPS", "fpsTier", (d) =>
        memoizedFpsTier(d.id, d.metrics && d.metrics.targetFpsTier),
      );
      addRow("Headroom", "headroom", (d) =>
        memoizedHeadroom(d.id, d.metrics && d.metrics.headroomRating),
      );

      addRow("Handheld Optimized", "handheldOptimized", (d) => {
        const ok = d.metrics && d.metrics.handheldOptimized;
        return ok
          ? '<span class="text-emerald-300 font-bold">✓ Yes</span>'
          : '<span class="text-slate-500">—</span>';
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
    }

    frag.appendChild(wrap);
    elMatrix.innerHTML = "";
    elMatrix.appendChild(frag);
  }

  /* ===== Presets ===== */

  function applyDesktopVsHandheldPreset() {
    if (moduleUnavailable) return;
    const desktop = devices.find((d) => d.id === "custom-pc-5080");
    const handheld = devices.find((d) => d.id === "deck_h");
    selectedDeviceIds = [];
    if (desktop) selectedDeviceIds.push(desktop.id);
    if (handheld) selectedDeviceIds.push(handheld.id);
    renderDeviceChips();
    updateRunState();
    if (desktop && handheld) {
      setStatus("Preset applied: Desktop vs Handheld.");
    }
  }

  /* ===== Public API ===== */

  function init() {
    if (initialized) return;
    initialized = true;

    elGameSelect = $("compare-game-select");
    elDeviceChips = $("compare-device-chips");
    elRunBtn = $("btn-run-benchmark");
    elStatus = $("benchmark-status");
    elMatrix = $("compare-matrix-table");
    elPreset = $("benchmark-preset-desktop-handheld");

    // The Hardware Fleet Benchmark section was removed from the compare page
    // (the multi-game comparison matrix is now the single compare surface).
    // When the benchmark DOM is absent, degrade to a safe no-op so app.js can
    // still call window.__compare.init() without side effects or stray fetches.
    if (!elGameSelect && !elDeviceChips && !elRunBtn && !elMatrix) {
      moduleUnavailable = true;
      return;
    }

    if (elGameSelect) {
      elGameSelect.addEventListener("change", (e) => {
        selectedGameId = e.target.value;
        updateRunState();
      });
    }

    if (elRunBtn) {
      elRunBtn.addEventListener("click", runBenchmark);
    }

    if (elPreset) {
      elPreset.addEventListener("click", applyDesktopVsHandheldPreset);
    }

    loadGames();
    loadDevices();
  }

  window.__compare = {
    init,
    runBenchmark,
    applyDesktopVsHandheldPreset,
    getState: () => ({
      selectedGameId,
      selectedDeviceIds: selectedDeviceIds.slice(),
      games: games.length,
      devices: devices.length,
      initialized,
    }),
  };
})();
