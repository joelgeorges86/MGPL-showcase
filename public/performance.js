/**
 * Sprint 3 (EPIC-DEV-001): Performance Matrix & Upgrade Advisor controller.
 *
 * Powers the #devices-panel-performance sub-tab inside #page-devices:
 *   - Device Selector (Active Device, My Devices, Catalog Devices, Saved Builds)
 *   - Performance Grid: Game | 4K Ultra | 1440p High | 1080p Medium | 720p Low
 *     with color-coded FPS badges (green >=60, yellow 30-59, red <30).
 *   - Two-Device Comparison Toggle: 2-column view with delta highlights.
 *   - Upgrade Advisor Card: rendered when <70% of games reach 60 FPS @ 1080p.
 *
 * Exposes window.__performance.init() so public/devices.js delegates the
 * Performance tab here. The DB is authoritative — UI recomputes only on the
 * explicit Analyze click when two devices (multi-variable) are involved.
 */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function escAttr(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escText(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "N/A";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  const SOURCE_LABELS = {
    active: "Active Device",
    "my-device": "My Devices",
    catalog: "Catalog Devices",
    build: "Saved Custom Builds",
  };

  let deviceOptions = [];
  let compareMode = false;

  // -------------------------------------------------------------------------
  // FPS badge helpers
  // -------------------------------------------------------------------------
  function fpsClass(fps) {
    if (fps >= 60) return "text-emerald-300 bg-emerald-500/10 border-emerald-500/40";
    if (fps >= 30) return "text-amber-300 bg-amber-500/10 border-amber-500/40";
    return "text-rose-300 bg-rose-500/10 border-rose-500/40";
  }

  function fpsBadge(fps, extra) {
    const n = Number(fps);
    const text = Number.isFinite(n) ? String(Math.round(n)) : "—";
    return (
      '<span class="inline-block min-w-[44px] px-2 py-0.5 rounded-md border text-[11px] font-bold text-center ' +
      fpsClass(n) +
      '"' +
      (extra ? " " + extra : "") +
      ">" +
      text +
      " FPS</span>"
    );
  }

  function selectedDevice(selectEl) {
    const value = selectEl ? selectEl.value : "";
    if (!value) return null;
    const found = deviceOptions.find(function (d) {
      return d.source + "::" + d.id === value;
    });
    return found || null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function renderOptions() {
    const aSelect = $("perf-device-select");
    const bSelect = $("perf-device-select-b");
    if (!aSelect) return;

    const groups = {};
    deviceOptions.forEach(function (d) {
      const label = SOURCE_LABELS[d.source] || d.source;
      if (!groups[label]) groups[label] = [];
      groups[label].push(d);
    });

    const groupOrder = ["Active Device", "My Devices", "Catalog Devices", "Saved Custom Builds"];
    const html = groupOrder
      .filter(function (label) {
        return groups[label] && groups[label].length > 0;
      })
      .map(function (label) {
        const opts = groups[label]
          .map(function (d) {
            const key = d.source + "::" + d.id;
            return (
              '<option value="' +
              escAttr(key) +
              '">' +
              escText(d.name) +
              " (" +
              escText(d.gpuTier) +
              " / " +
              escText(d.cpuTier) +
              ")" +
              "</option>"
            );
          })
          .join("");
        return '<optgroup label="' + escAttr(label) + '">' + opts + "</optgroup>";
      })
      .join("");

    aSelect.innerHTML = html;
    if (bSelect) bSelect.innerHTML = html;
  }

  function renderSummary(el, summary, deviceName) {
    if (!el) return;
    const total = summary ? summary.total : 0;
    const pct = summary ? summary.pctAt60 : 0;
    el.innerHTML =
      '<div data-testid="perf-summary-device" class="text-sm font-bold text-white">' +
      escText(deviceName || "Device") +
      "</div>" +
      '<div data-testid="perf-summary-pct" class="text-2xl font-black ' +
      (pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-rose-400") +
      '">' +
      pct +
      "%</div>" +
      '<div class="text-[11px] text-slate-400"><span class="font-bold text-slate-200">' +
      (summary ? summary.at60Fps1080p : 0) +
      '</span> of <span class="font-bold text-slate-200">' +
      total +
      "</span> games reach 60 FPS @ 1080p</div>";
  }

  function renderGrid(games) {
    const gridEl = $("perf-grid");
    if (!gridEl) return;

    if (!games || games.length === 0) {
      gridEl.innerHTML =
        '<p data-testid="perf-empty" class="text-xs text-slate-500 py-4">No library games with performance data.</p>';
      return;
    }

    const rows = games
      .map(function (g) {
        return (
          '<tr data-testid="perf-row" class="border-b border-slate-800/60 hover:bg-slate-900/50">' +
          '<td class="px-3 py-2 text-xs font-semibold text-slate-200">' +
          escText(g.title) +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          fpsBadge(g.fps4kUltra, 'data-perf-cell="4k"') +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          fpsBadge(g.fps1440pHigh, 'data-perf-cell="1440"') +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          fpsBadge(g.fps1080pMed, 'data-perf-cell="1080"') +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          fpsBadge(g.fps720pLow, 'data-perf-cell="720"') +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    gridEl.innerHTML =
      '<div class="rounded-xl border border-slate-800 overflow-x-auto">' +
      '<table data-testid="perf-grid" class="w-full border-collapse text-left">' +
      '<thead class="bg-slate-900/80 text-[11px] uppercase tracking-wider text-slate-400">' +
      "<tr>" +
      '<th class="px-3 py-2 font-bold">Game</th>' +
      '<th class="px-3 py-2 font-bold text-center">4K Ultra</th>' +
      '<th class="px-3 py-2 font-bold text-center">1440p High</th>' +
      '<th class="px-3 py-2 font-bold text-center">1080p Medium</th>' +
      '<th class="px-3 py-2 font-bold text-center">720p Low</th>' +
      "</tr>" +
      "</thead>" +
      '<tbody class="divide-y divide-slate-800/60">' +
      rows +
      "</tbody>" +
      "</table></div>";
  }

  function deltaBadge(delta) {
    if (delta === null || delta === undefined) return '<span class="text-slate-500">—</span>';
    const n = Number(delta);
    if (n > 0) {
      return (
        '<span data-testid="perf-delta-win" class="inline-block px-2 py-0.5 rounded-md border text-[11px] font-bold text-emerald-300 bg-emerald-500/10 border-emerald-500/40">+' +
        Math.round(n) +
        "</span>"
      );
    }
    if (n < 0) {
      return (
        '<span data-testid="perf-delta-loss" class="inline-block px-2 py-0.5 rounded-md border text-[11px] font-bold text-rose-300 bg-rose-500/10 border-rose-500/40">' +
        Math.round(n) +
        "</span>"
      );
    }
    return '<span class="inline-block px-2 py-0.5 rounded-md border text-[11px] font-bold text-slate-300 bg-slate-800 border-slate-700">0</span>';
  }

  function renderCompare(data) {
    const viewEl = $("perf-compare-view");
    const summaryEl = $("perf-compare-summary");
    if (!viewEl) return;

    if (summaryEl) {
      const c = data.compare || {};
      summaryEl.innerHTML =
        '<div class="flex flex-wrap items-center gap-4 text-xs">' +
        '<span class="font-bold text-white">' +
        escText(data.deviceA ? data.deviceA.name : "A") +
        " vs " +
        escText(data.deviceB ? data.deviceB.name : "B") +
        "</span>" +
        '<span data-testid="perf-compare-avg-delta" class="px-2 py-0.5 rounded-md border text-[11px] font-bold ' +
        ((c.avgDelta1080p || 0) >= 0
          ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/40"
          : "text-rose-300 bg-rose-500/10 border-rose-500/40") +
        '">Avg 1080p delta: ' +
        (c.avgDelta1080p >= 0 ? "+" : "") +
        (c.avgDelta1080p || 0) +
        " FPS</span>" +
        '<span class="text-slate-400">Device B wins <span class="font-bold text-emerald-300">' +
        (c.bWins || 0) +
        '</span> / loses <span class="font-bold text-rose-300">' +
        (c.bLosses || 0) +
        "</span></span>" +
        "</div>";
    }

    const tableRows = (data.games || [])
      .map(function (g) {
        const a = g.aFps1080pMed != null ? g.aFps1080pMed : null;
        const b = g.bFps1080pMed != null ? g.bFps1080pMed : null;
        return (
          '<tr data-testid="perf-compare-row" class="border-b border-slate-800/60 hover:bg-slate-900/50">' +
          '<td class="px-3 py-2 text-xs font-semibold text-slate-200">' +
          escText(g.title) +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          (a == null ? '<span class="text-slate-500">—</span>' : fpsBadge(a)) +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          fpsBadge(b) +
          "</td>" +
          '<td class="px-3 py-2 text-center">' +
          deltaBadge(g.delta1080p) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    viewEl.innerHTML =
      '<div class="rounded-xl border border-slate-800 overflow-x-auto">' +
      '<table data-testid="perf-compare-table" class="w-full border-collapse text-left">' +
      '<thead class="bg-slate-900/80 text-[11px] uppercase tracking-wider text-slate-400">' +
      "<tr>" +
      '<th class="px-3 py-2 font-bold">Game</th>' +
      '<th class="px-3 py-2 font-bold text-center">' +
      escText(data.deviceA ? data.deviceA.name : "Device A") +
      " (1080p)</th>" +
      '<th class="px-3 py-2 font-bold text-center">' +
      escText(data.deviceB ? data.deviceB.name : "Device B") +
      " (1080p)</th>" +
      '<th class="px-3 py-2 font-bold text-center">Delta</th>' +
      "</tr>" +
      "</thead>" +
      '<tbody class="divide-y divide-slate-800/60">' +
      tableRows +
      "</tbody>" +
      "</table></div>";
  }

  function renderAdvisor(data) {
    const advisorEl = $("perf-advisor");
    if (!advisorEl) return;

    if (!data || !data.belowThreshold) {
      advisorEl.innerHTML =
        '<div class="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4">' +
        '<p class="text-xs font-bold text-emerald-300 flex items-center gap-2">' +
        "<span>✓</span> This device already clears 70% of your library at 60 FPS @ 1080p.</p>" +
        "</div>";
      return;
    }

    const rec = data.recommendations || {};
    const cards = [
      { label: "Cheapest", key: "cheapest", color: "text-sky-300", c: rec.cheapest },
      { label: "Best Value", key: "bestValue", color: "text-emerald-300", c: rec.bestValue },
      {
        label: "Best Performance",
        key: "bestPerformance",
        color: "text-fuchsia-300",
        c: rec.bestPerformance,
      },
    ]
      .map(function (item) {
        const c = item.c;
        if (!c) {
          return (
            '<div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3">' +
            '<p class="text-[10px] font-black uppercase tracking-wider text-slate-500">' +
            item.label +
            "</p>" +
            '<p class="text-xs text-slate-400 mt-1">No single upgrade improves your 1080p threshold.</p>' +
            "</div>"
          );
        }
        return (
          '<div data-testid="perf-advice" class="rounded-xl border border-slate-800 bg-slate-950/60 p-3">' +
          '<p class="text-[10px] font-black uppercase tracking-wider ' +
          item.color +
          '">' +
          item.label +
          "</p>" +
          '<p class="text-xs font-bold text-white mt-1">' +
          escText(c.name) +
          "</p>" +
          '<p class="text-[11px] text-slate-400 mt-1">' +
          formatMoney(c.cost) +
          " · " +
          c.pctAt60 +
          "% reach 60 FPS</p>" +
          '<p class="text-[11px] font-semibold text-emerald-400 mt-0.5">+ ' +
          c.gain +
          "% gain over current</p>" +
          "</div>"
        );
      })
      .join("");

    advisorEl.innerHTML =
      '<div class="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-3">' +
      '<div class="flex items-center justify-between">' +
      '<h3 data-testid="perf-advisor-heading" class="text-sm font-bold text-white flex items-center gap-2">' +
      "<span>⬆</span> Upgrade Advisor</h3>" +
      '<span class="text-[11px] font-bold text-amber-300">' +
      (data.summary ? data.summary.pctAt60 : 0) +
      "% of library at 60 FPS</span>" +
      "</div>" +
      '<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">' +
      cards +
      "</div>" +
      "</div>";
  }

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------
  async function loadDevices() {
    try {
      const res = await fetch("/api/performance/devices");
      const data = await res.json();
      if (!data.success || !Array.isArray(data.devices)) return;
      deviceOptions = data.devices;
      renderOptions();
      return data.devices;
    } catch (err) {
      console.error("Failed to load performance devices:", err);
      return [];
    }
  }

  function defaultDevice() {
    const active = deviceOptions.find(function (d) {
      return d.source === "active";
    });
    if (active) return active;
    const my = deviceOptions.find(function (d) {
      return d.source === "my-device";
    });
    if (my) return my;
    return (
      deviceOptions.find(function (d) {
        return d.source === "catalog";
      }) || null
    );
  }

  async function runMatrix() {
    const aSelect = $("perf-device-select");
    const device = selectedDevice(aSelect);
    if (!device) return;

    const params = new URLSearchParams({
      gpuTier: device.gpuTier,
      cpuTier: device.cpuTier,
      name: device.name,
    });

    const summaryEl = $("perf-summary");
    const gridEl = $("perf-grid");
    if (summaryEl) summaryEl.innerHTML = '<p class="text-xs text-slate-400">Analyzing…</p>';
    if (gridEl)
      gridEl.innerHTML = '<p class="text-xs text-slate-500 py-4">Loading performance matrix…</p>';

    try {
      const res = await fetch("/api/performance/matrix?" + params.toString());
      const data = await res.json();
      if (!data.success) {
        if (gridEl)
          gridEl.innerHTML =
            '<p class="text-xs text-rose-400 py-4">' +
            escText(data.error || "Failed to load matrix") +
            "</p>";
        return;
      }
      renderSummary(summaryEl, data.summary, data.device.name);
      renderGrid(data.games);

      // Auto-fetch recommendations for the advisor card.
      const recRes = await fetch("/api/performance/recommendations?" + params.toString());
      const recData = await recRes.json();
      renderAdvisor(recData.success ? recData : null);
    } catch (err) {
      console.error("Matrix error:", err);
      if (gridEl)
        gridEl.innerHTML =
          '<p class="text-xs text-rose-400 py-4">Failed to load performance matrix.</p>';
    }
  }

  async function runCompare() {
    const a = selectedDevice($("perf-device-select"));
    const b = selectedDevice($("perf-device-select-b"));
    if (!a || !b) return;

    const viewEl = $("perf-compare-view");
    if (viewEl) viewEl.innerHTML = '<p class="text-xs text-slate-400">Comparing devices…</p>';

    const params = new URLSearchParams({
      aGpu: a.gpuTier,
      aCpu: a.cpuTier,
      aName: a.name,
      bGpu: b.gpuTier,
      bCpu: b.cpuTier,
      bName: b.name,
    });

    try {
      const res = await fetch("/api/performance/compare?" + params.toString());
      const data = await res.json();
      if (!data.success) {
        if (viewEl)
          viewEl.innerHTML =
            '<p class="text-xs text-rose-400 py-4">' +
            escText(data.error || "Comparison failed") +
            "</p>";
        return;
      }
      renderCompare(data);
    } catch (err) {
      console.error("Compare error:", err);
      if (viewEl) viewEl.innerHTML = '<p class="text-xs text-rose-400 py-4">Comparison failed.</p>';
    }
  }

  async function analyze() {
    if (compareMode) {
      await runCompare();
    } else {
      await runMatrix();
    }
  }

  // -------------------------------------------------------------------------
  // Wiring & init
  // -------------------------------------------------------------------------
  function wireEvents() {
    const aSelect = $("perf-device-select");
    const toggle = $("perf-compare-toggle");
    const compareWrap = $("perf-compare-selector-wrap");
    const analyzeBtn = $("perf-analyze-btn");

    // Single-device selector updates projections in real time.
    if (aSelect) {
      aSelect.addEventListener("change", function () {
        if (compareMode) return;
        runMatrix();
      });
    }

    if (toggle && compareWrap) {
      toggle.addEventListener("change", function () {
        compareMode = toggle.checked;
        compareWrap.classList.toggle("hidden", !compareMode);
        const gridEl = $("perf-grid");
        const compareView = $("perf-compare-view");
        if (compareMode) {
          if (gridEl) gridEl.classList.add("hidden");
          if (compareView) compareView.classList.remove("hidden");
        } else {
          if (gridEl) gridEl.classList.remove("hidden");
          if (compareView) compareView.classList.add("hidden");
        }
        // Multi-variable state changed → require explicit Analyze click.
      });
    }

    if (analyzeBtn) {
      analyzeBtn.addEventListener("click", analyze);
    }
  }

  async function init() {
    await loadDevices();

    // Default to the active device, else the first catalog device.
    const device = defaultDevice();
    const aSelect = $("perf-device-select");
    if (device && aSelect) {
      aSelect.value = device.source + "::" + device.id;
    }

    wireEvents();
    await analyze();
  }

  window.__performance = { init: init };
})();
