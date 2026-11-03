/**
 * Sprint 5 (EPICUX05): Hardware Explorer 2.0 controller.
 *
 * Powers the new #page-hardware surface:
 *   - Rig Telemetry        (explicit "Scan Rig" -> POST /api/scan, PII-free)
 *   - Compatibility Checker (explicit "Analyze Compatibility" trigger; tiers)
 *   - Upgrade Advisor       (explicit "Get Upgrade Advice" trigger)
 *   - Component Comparison  (2-4 GPU/CPU slots, sticky headers, tabbed views)
 *   - Community Benchmarks  (filterable avg FPS / 1% low FPS table)
 *
 * Matrix guardrails: VRAM is never inferred client-side; missing persisted
 * specs render explicit "Missing VRAM" / "Refresh device scan required" blocked
 * states; multi-variable recommendations only compute on explicit button clicks.
 *
 * Exposes window.__hardware.init(tool?) so public/app.js's lazy route loader can
 * hydrate the surface on first navigation to #/hardware (and honor ?tool=).
 */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "N/A";
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function showToast(message, isError) {
    if (window.showToast && typeof window.showToast === "function") {
      window.showToast(message, isError);
      return;
    }
    console.log("[hardware.js]", message);
  }

  // -------------------------------------------------------------------------
  // State (UI state is presentation-only; the DB is authoritative).
  // -------------------------------------------------------------------------
  const state = {
    rig: null,
    games: [],
    components: { GPU: [], CPU: [] },
    compare: { type: "GPU", slots: ["", "", "", ""] },
    compareData: null,
    compareTab: "specs",
    benchFilters: { type: "", resolution: "", preset: "" },
  };
  let initialized = false;

  const RATING_COLORS = {
    Optimal: "text-emerald-300 bg-emerald-500/10 border-emerald-500/40",
    Playable: "text-sky-300 bg-sky-500/10 border-sky-500/40",
    Bottlenecked: "text-amber-300 bg-amber-500/10 border-amber-500/40",
    Unsupported: "text-rose-300 bg-rose-500/10 border-rose-500/40",
    "Incomplete Specs": "text-slate-300 bg-slate-500/10 border-slate-500/40",
  };
  const AXIS_COLORS = {
    optimal: "text-emerald-400",
    playable: "text-sky-400",
    bottleneck: "text-amber-400",
    unsupported: "text-rose-400",
    missing: "text-slate-500",
  };

  // -------------------------------------------------------------------------
  // Rig Telemetry
  // -------------------------------------------------------------------------
  function specCard(label, value, highlight) {
    return (
      '<div class="bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2">' +
      '<div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">' +
      esc(label) +
      "</div>" +
      '<div class="text-sm font-semibold ' +
      (highlight ? "text-amber-400" : "text-slate-200") +
      ' truncate">' +
      esc(value) +
      "</div>" +
      "</div>"
    );
  }

  function renderRig(device) {
    const el = $("hw-rig-specs");
    const statusEl = $("hw-rig-status");
    if (!el) return;

    if (!device) {
      el.innerHTML =
        '<div class="col-span-full text-center py-6 text-slate-500">' +
        '<p class="text-sm font-medium">No scanned rig yet.</p>' +
        '<p class="text-xs">Click <span class="text-slate-300 font-semibold">Scan Rig</span> to persist PII-free local telemetry.</p>' +
        "</div>";
      if (statusEl) statusEl.textContent = "";
      return;
    }

    el.innerHTML = [
      specCard("CPU", device.cpuModel || "Unknown"),
      specCard("Cores", device.cpuCores != null ? String(device.cpuCores) : "—"),
      specCard("RAM", device.ramGb != null ? device.ramGb + " GB" : "—"),
      specCard("GPU", device.gpuModel || "Unknown"),
      specCard(
        "VRAM",
        device.vramGb != null ? device.vramGb + " GB" : "Missing VRAM",
        device.vramGb == null,
      ),
      specCard("Free Storage", device.storageFreeGb != null ? device.storageFreeGb + " GB" : "—"),
      specCard("Class", device.deviceClass || device.formFactor || "—"),
      specCard(
        "Battery",
        device.batteryWh != null
          ? device.batteryWh + " Wh"
          : device.batteryPresent
            ? "Not reported"
            : "N/A",
      ),
    ].join("");

    if (statusEl) {
      if (device.blockedSpecs) {
        statusEl.textContent =
          "⚠️ Missing VRAM — refresh device scan required before compatibility checks.";
        statusEl.className = "text-[11px] text-amber-400";
      } else if (device.staleSpecs) {
        statusEl.textContent =
          "⚠️ Stale specs — last scan was over 30 days ago. Re-scan to refresh.";
        statusEl.className = "text-[11px] text-amber-400";
      } else if (device.scanConfidence === "partial") {
        statusEl.textContent =
          "ℹ️ Partial scan (missing: " +
          (Array.isArray(device.missingFields) ? device.missingFields.join(", ") : "vram") +
          ") — some checks may be blocked.";
        statusEl.className = "text-[11px] text-sky-400";
      } else {
        statusEl.textContent = "✅ Fresh PII-free scan · confidence complete.";
        statusEl.className = "text-[11px] text-slate-500";
      }
    }
  }

  async function loadRig() {
    try {
      const res = await fetch("/api/hardware/explorer");
      const data = await res.json();
      state.rig = data.success ? data.device : null;
      renderRig(state.rig);
    } catch (err) {
      console.error("[hardware.js] Failed to load rig telemetry:", err);
    }
  }

  // AI-082 (#161): on a hosted site POST /api/scan would read the server's
  // hardware, not the visitor's PC. GET /api/host-scan/status says whether the
  // scan runs here; only a successful answer is remembered.
  let hostScanStatus = null;
  async function hostScanAvailable() {
    if (hostScanStatus !== null) return hostScanStatus;
    try {
      const res = await fetch("/api/host-scan/status");
      if (!res.ok) return false;
      const data = await res.json();
      hostScanStatus = data && data.enabled === true;
      return hostScanStatus;
    } catch (err) {
      console.error("[hardware.js] Host scan status error:", err);
      return false;
    }
  }

  // Where the scan does not run, open the Device Fleet form instead. app.js
  // owns the header badge, so its hand-off is used when present: it sets the
  // badge to "Scan not available on this site", shows the toast and opens the
  // form, exactly as "Scan Local PC" does.
  function openFleetFormInsteadOfScan() {
    if (typeof window.mgplOpenFleetInsteadOfScan === "function") {
      window.mgplOpenFleetInsteadOfScan();
      return;
    }
    showToast(
      "Scanning this PC is not available on this site. Add your device in Device Fleet.",
      false,
    );
    window.location.hash = "#/fleet";
    if (typeof window.openFleetModal === "function") window.openFleetModal();
  }

  // One scan at a time: the button is disabled before the status request, so
  // a second click while the first is still waiting starts nothing.
  let scanInFlight = false;
  async function scanRig() {
    const btn = $("hw-scan-btn");
    if (!btn || scanInFlight) return;
    scanInFlight = true;
    btn.disabled = true;
    try {
      if (!(await hostScanAvailable())) {
        openFleetFormInsteadOfScan();
        return;
      }
      btn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Scanning...';
      const res = await fetch("/api/scan", { method: "POST" });
      const data = await res.json();
      if (res.status === 404 && data && data.code === "HOST_SCAN_DISABLED") {
        hostScanStatus = false;
        openFleetFormInsteadOfScan();
        return;
      }
      if (data.success && data.telemetry) {
        state.rig = data.telemetry;
        renderRig(data.telemetry);
        showToast("Rig scanned & specs persisted.");
      } else {
        showToast("Scan failed: " + (data.error || "unknown"), true);
      }
    } catch (err) {
      console.error("[hardware.js] Scan error:", err);
      showToast("Failed to scan local hardware.", true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="radar" class="w-4 h-4"></i> Scan Rig';
      if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons();
      }
      scanInFlight = false;
    }
  }

  // -------------------------------------------------------------------------
  // Compatibility Checker (explicit "Analyze Compatibility" trigger)
  // -------------------------------------------------------------------------
  async function loadGames() {
    try {
      const res = await fetch("/api/games?active=true&owned=true&pageSize=1000");
      const data = await res.json();
      const list =
        window.safeArray && typeof window.safeArray === "function"
          ? window.safeArray(data && data.games)
          : Array.isArray(data && data.games)
            ? data.games
            : [];
      state.games = list
        .map((g) => ({
          id: g.GameID || g.id || g.gameId,
          title: g["Game Title"] || g.gameTitle || g.title || "Game",
        }))
        .filter((g) => g.id);
      renderGameSelect();
    } catch (err) {
      console.error("[hardware.js] Failed to load games catalog:", err);
    }
  }

  function renderGameSelect() {
    const sel = $("hw-comp-game");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML =
      '<option value="">-- Select a game --</option>' +
      state.games
        .map((g) => '<option value="' + esc(g.id) + '">' + esc(g.title) + "</option>")
        .join("");
    if (current) sel.value = current;
  }

  function axisRow(label, axis) {
    const color = AXIS_COLORS[axis.status] || AXIS_COLORS.missing;
    const statusLabel = String(axis.status).replace(/^./, function (c) {
      return c.toUpperCase();
    });
    return (
      '<tr class="border-b border-slate-800/60 last:border-0">' +
      '<td class="py-1.5 pr-2 text-[11px] font-bold text-slate-400">' +
      esc(label) +
      "</td>" +
      '<td class="py-1.5 px-2 text-[11px] text-slate-300 text-right">' +
      (axis.deviceValue != null ? esc(String(axis.deviceValue)) : "—") +
      "</td>" +
      '<td class="py-1.5 px-2 text-[11px] text-slate-300 text-right">' +
      (axis.requiredValue != null ? esc(String(axis.requiredValue)) : "—") +
      "</td>" +
      '<td class="py-1.5 px-2 text-[11px] text-slate-300 text-right">' +
      (axis.marginGbOrPct != null
        ? (axis.marginGbOrPct >= 0 ? "+" : "") + axis.marginGbOrPct
        : "—") +
      "</td>" +
      '<td class="py-1.5 px-2 text-[11px] text-right font-semibold ' +
      color +
      '">' +
      statusLabel +
      "</td>" +
      "</tr>"
    );
  }

  function tierCard(tierName, tier) {
    const ratingColor = RATING_COLORS[tier.rating] || RATING_COLORS["Incomplete Specs"];
    const axes = [
      ["CPU", tier.axes.cpu],
      ["RAM", tier.axes.ram],
      ["VRAM", tier.axes.vram],
      ["Storage", tier.axes.storage],
    ];
    const bottleneck = tier.primaryBottleneck
      ? ' · <span class="text-amber-400">Bottleneck: ' + esc(tier.primaryBottleneck) + "</span>"
      : "";
    return (
      '<div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">' +
      '<div class="flex items-center justify-between gap-2 flex-wrap">' +
      '<div class="flex items-center gap-2">' +
      '<span class="text-xs font-black uppercase tracking-wider text-slate-300">' +
      esc(tierName) +
      "</span>" +
      '<span class="text-[10px] px-2 py-0.5 rounded-full border font-bold ' +
      ratingColor +
      '">' +
      esc(tier.rating) +
      "</span>" +
      "</div>" +
      '<span class="text-[10px] text-slate-500">' +
      esc(tier.powerProfile) +
      bottleneck +
      "</span>" +
      "</div>" +
      '<div class="overflow-x-auto">' +
      '<table class="w-full min-w-[420px]">' +
      "<thead>" +
      '<tr class="text-[10px] uppercase tracking-wider text-slate-500">' +
      '<th class="text-left py-1 font-bold">Axis</th>' +
      '<th class="text-right py-1 font-bold">Device</th>' +
      '<th class="text-right py-1 font-bold">Required</th>' +
      '<th class="text-right py-1 font-bold">Margin</th>' +
      '<th class="text-right py-1 font-bold">Status</th>' +
      "</tr>" +
      "</thead>" +
      "<tbody>" +
      axes
        .map(function (a) {
          return axisRow(a[0], a[1]);
        })
        .join("") +
      "</tbody>" +
      "</table>" +
      "</div>" +
      "</div>"
    );
  }

  async function analyzeCompatibility() {
    const gameSel = $("hw-comp-game");
    const powerSel = $("hw-comp-power");
    const resultsEl = $("hw-comp-results");
    if (!gameSel || !powerSel || !resultsEl) return;

    const gameId = gameSel.value;
    if (!gameId) {
      resultsEl.innerHTML =
        '<div class="text-xs text-slate-400 bg-slate-900/70 border border-slate-800 rounded-xl p-3">Select a game first.</div>';
      return;
    }

    resultsEl.innerHTML =
      '<div class="text-xs text-slate-400 py-4 text-center">Analyzing compatibility…</div>';
    try {
      const res = await fetch("/api/hardware/compatibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId,
          powerProfile: powerSel.value || "Plugged-In",
        }),
      });
      const data = await res.json();
      if (!data.success) {
        resultsEl.innerHTML =
          '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">' +
          esc(data.error || "Failed to analyze compatibility") +
          "</div>";
        return;
      }
      renderCompatibilityResults(data, resultsEl);
    } catch (err) {
      console.error("[hardware.js] Compatibility analysis error:", err);
      resultsEl.innerHTML =
        '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">Failed to analyze compatibility.</div>';
    }
  }

  function renderCompatibilityResults(data, resultsEl) {
    if (data.blocked) {
      resultsEl.innerHTML =
        '<div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-1">' +
        '<div class="text-sm font-bold text-amber-300">⚠️ ' +
        esc(data.blockedReason || "Missing VRAM") +
        "</div>" +
        '<div class="text-xs text-slate-400">' +
        esc(data.message || "Refresh device scan required — hardware specs incomplete.") +
        "</div>" +
        '<button type="button" id="hw-blocked-rescan" class="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition-all">' +
        '<i data-lucide="radar" class="w-3.5 h-3.5"></i> Run Hardware Scan</button>' +
        "</div>";
      const rescanBtn = $("hw-blocked-rescan");
      if (rescanBtn) {
        rescanBtn.addEventListener("click", function () {
          scanRig();
          setTimeout(function () {
            if (state.rig && state.rig.vramGb != null) {
              analyzeCompatibility();
            }
          }, 4000);
        });
      }
      return;
    }

    const tiers = data.evaluation && data.evaluation.tiers;
    if (!tiers) {
      resultsEl.innerHTML =
        '<div class="text-xs text-slate-400 bg-slate-900/70 border border-slate-800 rounded-xl p-3">No evaluation returned.</div>';
      return;
    }

    const header =
      '<div class="text-xs text-slate-400 bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-2 flex-wrap">' +
      "<span>" +
      '<span class="font-bold text-slate-200">' +
      esc(data.gameTitle || data.gameId) +
      "</span> on " +
      esc(data.deviceName || "Local PC") +
      "</span>" +
      '<span class="text-[10px] text-slate-500">' +
      (data.evaluation.derived ? "Recommended & Ultra tiers derived from persisted minimums" : "") +
      "</span>" +
      "</div>";

    resultsEl.innerHTML =
      header +
      '<div class="grid grid-cols-1 lg:grid-cols-3 gap-3">' +
      tierCard("Minimum", tiers.minimum) +
      tierCard("Recommended", tiers.recommended) +
      tierCard("Ultra", tiers.ultra) +
      "</div>";
  }

  // -------------------------------------------------------------------------
  // Upgrade Advisor (explicit "Get Upgrade Advice" trigger)
  // -------------------------------------------------------------------------
  function retailerLinksHtml(retailers) {
    if (!Array.isArray(retailers) || retailers.length === 0) {
      return '<span class="text-[10px] text-slate-600">No verified retailers</span>';
    }
    return retailers
      .map(function (r) {
        return (
          '<a href="' +
          esc(r.url) +
          '" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[10px] font-bold transition-all" data-testid="hw-verified-retailer">' +
          '<i data-lucide="external-link" class="w-3 h-3"></i>' +
          esc(r.retailer) +
          "</a>"
        );
      })
      .join("");
  }

  async function loadUpgradeAdvice() {
    const resultsEl = $("hw-upgrade-results");
    if (!resultsEl) return;
    resultsEl.innerHTML =
      '<div class="text-xs text-slate-400 py-4 text-center">Analyzing upgrade options…</div>';
    try {
      const res = await fetch("/api/hardware/upgrade?deviceId=local-host");
      const data = await res.json();
      if (!data.success) {
        resultsEl.innerHTML =
          '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">' +
          esc(data.error || "Failed to load upgrade advice") +
          "</div>";
        return;
      }
      renderUpgradeResults(data, resultsEl);
    } catch (err) {
      console.error("[hardware.js] Upgrade advisor error:", err);
      resultsEl.innerHTML =
        '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">Failed to load upgrade advice.</div>';
    }
  }

  function renderUpgradeResults(data, resultsEl) {
    if (data.blocked) {
      resultsEl.innerHTML =
        '<div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-1">' +
        '<div class="text-sm font-bold text-amber-300">⚠️ ' +
        esc(data.blockedReason || "Missing VRAM") +
        "</div>" +
        '<div class="text-xs text-slate-400">' +
        esc(data.message || "Refresh device scan required — hardware specs incomplete.") +
        "</div>" +
        "</div>";
      return;
    }

    const current = data.current || {};
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (suggestions.length === 0) {
      resultsEl.innerHTML =
        '<div class="text-xs text-slate-400 bg-slate-900/70 border border-slate-800 rounded-xl p-3">' +
        "Your current rig already matches or exceeds every catalog component — no upgrade suggestions.</div>";
      return;
    }

    const summary =
      '<div class="text-[11px] text-slate-400 bg-slate-900/70 border border-slate-800 rounded-xl p-3">' +
      "Current rig: " +
      esc(current.vramGb != null ? current.vramGb + " GB VRAM" : "VRAM unknown") +
      " · " +
      esc(current.cpuCores != null ? current.cpuCores + " CPU cores" : "cores unknown") +
      "</div>";

    const listHtml = suggestions
      .map(function (s) {
        return (
          '<div class="flex items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex-wrap">' +
          '<div class="flex items-center gap-3 min-w-0">' +
          '<span class="text-[10px] px-2 py-0.5 rounded-full bg-brand-500/10 border border-brand-500/40 text-brand-300 font-bold uppercase">' +
          esc(s.category) +
          "</span>" +
          '<div class="min-w-0">' +
          '<div class="text-xs font-bold text-slate-200 truncate">' +
          esc(s.name) +
          "</div>" +
          '<div class="text-[10px] text-slate-500">' +
          esc(s.metric) +
          " " +
          esc(String(s.target)) +
          " (+" +
          esc(String(s.delta)) +
          " vs current)</div>" +
          "</div>" +
          "</div>" +
          '<div class="flex items-center gap-2 flex-wrap">' +
          '<span class="text-xs font-bold text-emerald-400">' +
          money(s.priceUsd) +
          "</span>" +
          retailerLinksHtml(s.retailers) +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    resultsEl.innerHTML =
      summary +
      '<div class="space-y-2" data-testid="hw-upgrade-suggestions">' +
      listHtml +
      "</div>";
  }

  // -------------------------------------------------------------------------
  // Side-by-Side Comparison Tool (up to 4 slots)
  // -------------------------------------------------------------------------
  async function loadComponents() {
    try {
      const res = await fetch("/api/hardware/components/search");
      const data = await res.json();
      if (data.success && Array.isArray(data.components)) {
        state.components.GPU = data.components.filter(function (c) {
          return c.category === "GPU";
        });
        state.components.CPU = data.components.filter(function (c) {
          return c.category === "CPU";
        });
        renderCompareSlots();
      }
    } catch (err) {
      console.error("[hardware.js] Failed to load components:", err);
    }
  }

  function compareList() {
    return state.components[state.compare.type] || [];
  }

  function renderCompareSlots() {
    const slotsEl = $("hw-cmp-slots");
    const typeSel = $("hw-cmp-type");
    if (!slotsEl || !typeSel) return;

    typeSel.value = state.compare.type;
    const list = compareList();

    const slotHtml = state.compare.slots
      .map(function (selected, i) {
        return (
          '<label class="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-xl px-2 py-1.5">' +
          '<span class="text-[10px] font-black text-slate-500">' +
          (i + 1) +
          "</span>" +
          '<select class="hw-cmp-slot bg-transparent text-xs font-semibold text-slate-200 focus:outline-none cursor-pointer" data-slot-index="' +
          i +
          '">' +
          '<option value="">-- Select --</option>' +
          list
            .map(function (c) {
              return (
                '<option value="' +
                esc(c.componentId) +
                '"' +
                (c.componentId === selected ? " selected" : "") +
                ">" +
                esc(c.name) +
                " · " +
                money(c.priceUsd) +
                "</option>"
              );
            })
            .join("") +
          "</select>" +
          "</label>"
        );
      })
      .join("");

    const addBtn =
      state.compare.slots.length < 4
        ? '<button type="button" id="hw-cmp-add" class="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold border border-slate-700 transition-all">' +
          '<i data-lucide="plus" class="w-3.5 h-3.5"></i> Add Slot</button>'
        : "";
    const runBtn =
      '<button type="button" id="hw-cmp-run" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold transition-all active:scale-95">' +
      '<i data-lucide="scale" class="w-4 h-4"></i> Compare</button>';

    slotsEl.innerHTML = slotHtml + addBtn + runBtn;

    slotsEl.querySelectorAll(".hw-cmp-slot").forEach(function (sel) {
      sel.addEventListener("change", function () {
        const idx = Number(sel.getAttribute("data-slot-index"));
        state.compare.slots[idx] = sel.value;
      });
    });
    const addEl = $("hw-cmp-add");
    if (addEl) {
      addEl.addEventListener("click", function () {
        if (state.compare.slots.length < 4) {
          state.compare.slots.push("");
          renderCompareSlots();
        }
      });
    }
    const runEl = $("hw-cmp-run");
    if (runEl) {
      runEl.addEventListener("click", runCompare);
    }
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  async function runCompare() {
    const tableEl = $("hw-cmp-table");
    if (!tableEl) return;
    const ids = state.compare.slots.filter(function (id) {
      return id;
    });
    if (ids.length < 2) {
      tableEl.innerHTML =
        '<div class="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">Select at least 2 components to compare.</div>';
      return;
    }
    tableEl.innerHTML =
      '<div class="text-xs text-slate-400 py-4 text-center">Comparing components…</div>';
    try {
      const res = await fetch(
        "/api/hardware/components/compare?ids=" + encodeURIComponent(ids.join(",")),
      );
      const data = await res.json();
      if (!data.success) {
        tableEl.innerHTML =
          '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">' +
          esc(data.error || "Comparison failed") +
          "</div>";
        return;
      }
      state.compareData = data.components;
      state.compareTab = "specs";
      renderCompareTable();
    } catch (err) {
      console.error("[hardware.js] Compare error:", err);
      tableEl.innerHTML =
        '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">Failed to compare components.</div>';
    }
  }

  function ensureStickyStyles() {
    if (document.getElementById("hw-sticky-style")) return;
    const style = document.createElement("style");
    style.id = "hw-sticky-style";
    style.textContent = ".hw-cmp-sticky th{position:sticky;top:0;background:#0f172a;z-index:5;}";
    document.head.appendChild(style);
  }

  function trendBadge(trend) {
    if (trend === "down") {
      return '<span class="text-[10px] font-bold text-emerald-400">↓ Trending Down</span>';
    }
    if (trend === "up") {
      return '<span class="text-[10px] font-bold text-rose-400">↑ Trending Up</span>';
    }
    return '<span class="text-[10px] font-bold text-slate-400">→ Stable</span>';
  }

  function sparkline(points) {
    const values = (Array.isArray(points) ? points : [])
      .map(function (p) {
        return Number(p && p.priceUsd);
      })
      .filter(function (n) {
        return Number.isFinite(n);
      });
    if (values.length < 2) return "";
    const w = 96;
    const h = 24;
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const range = max - min || 1;
    const coords = values.map(function (v, i) {
      const x = (i / (values.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((v - min) / range) * (h - 6);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return (
      '<svg width="' +
      w +
      '" height="' +
      h +
      '" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" class="inline-block" aria-hidden="true"><polyline points="' +
      coords.join(" ") +
      '" fill="none" stroke="#34d399" stroke-width="1.5" /></svg>'
    );
  }

  function renderCompareTable() {
    const tableEl = $("hw-cmp-table");
    if (!tableEl || !state.compareData || state.compareData.length === 0) return;
    ensureStickyStyles();

    const tabs =
      '<div class="flex items-center gap-1 mb-3" role="tablist" aria-label="Comparison views">' +
      ["specs", "benchmarks", "price-history"]
        .map(function (tab) {
          const labels = {
            specs: "Specs",
            benchmarks: "Benchmarks",
            "price-history": "Price History",
          };
          const active = state.compareTab === tab;
          return (
            '<button type="button" role="tab" aria-selected="' +
            (active ? "true" : "false") +
            '" data-cmp-tab="' +
            tab +
            '" class="hw-cmp-tab px-3 py-1.5 rounded-lg text-xs font-bold transition-all ' +
            (active
              ? "bg-brand-600 text-white"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800") +
            '">' +
            labels[tab] +
            "</button>"
          );
        })
        .join("") +
      "</div>";

    let bodyHtml;
    if (state.compareTab === "specs") {
      bodyHtml = specsTabHtml();
    } else if (state.compareTab === "benchmarks") {
      bodyHtml = benchmarksTabHtml();
    } else {
      bodyHtml = priceHistoryTabHtml();
    }

    tableEl.innerHTML = tabs + bodyHtml;
    tableEl.querySelectorAll(".hw-cmp-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.compareTab = btn.getAttribute("data-cmp-tab");
        renderCompareTable();
      });
    });
  }

  function specsTabHtml() {
    const comps = state.compareData;
    const rows = [
      [
        "Brand",
        function (c) {
          return c.brand;
        },
      ],
      [
        "Model",
        function (c) {
          return c.model;
        },
      ],
      [
        "Category",
        function (c) {
          return c.category;
        },
      ],
      [
        "Price (MSRP)",
        function (c) {
          return money(c.priceUsd);
        },
      ],
      [
        "TDP",
        function (c) {
          return c.tdpWatts != null ? c.tdpWatts + " W" : "—";
        },
      ],
      [
        "Socket",
        function (c) {
          return c.socketType || "—";
        },
      ],
      [
        "Memory",
        function (c) {
          return c.ddrGen || "—";
        },
      ],
      [
        "Form Factor",
        function (c) {
          return c.formFactor || "—";
        },
      ],
      [
        "Verified Retailers",
        function (c) {
          return retailerLinksHtml(c.retailers);
        },
      ],
    ];
    return (
      '<div class="overflow-x-auto"><table class="w-full text-xs hw-cmp-sticky">' +
      "<thead>" +
      "<tr>" +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Attribute</th>' +
      comps
        .map(function (c) {
          return (
            '<th scope="col" class="text-left py-2 px-2 font-bold text-slate-200 border-b border-slate-700">' +
            esc(c.name) +
            "</th>"
          );
        })
        .join("") +
      "</tr>" +
      "</thead>" +
      "<tbody>" +
      rows
        .map(function (row) {
          return (
            "<tr>" +
            '<td class="py-1.5 px-2 font-bold text-slate-400 border-b border-slate-800/60">' +
            esc(row[0]) +
            "</td>" +
            comps
              .map(function (c) {
                return (
                  '<td class="py-1.5 px-2 text-slate-200 border-b border-slate-800/60">' +
                  row[1](c) +
                  "</td>"
                );
              })
              .join("") +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }

  function benchmarksTabHtml() {
    const comps = state.compareData;
    const allBench = comps.reduce(function (acc, c) {
      (Array.isArray(c.benchmarks) ? c.benchmarks : []).forEach(function (b) {
        acc.push({
          name: c.name,
          resolution: b.resolution,
          preset: b.settingsPreset,
          avgFps: b.avgFps,
          onePercentLowFps: b.onePercentLowFps,
          sampleCount: b.sampleCount,
        });
      });
      return acc;
    }, []);
    if (allBench.length === 0) {
      return '<div class="text-xs text-slate-500 py-4 text-center">No community benchmark data for these components.</div>';
    }
    return (
      '<div class="overflow-x-auto"><table class="w-full text-xs hw-cmp-sticky">' +
      "<thead>" +
      "<tr>" +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Component</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Resolution</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Preset</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Avg FPS</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">1% Low</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Samples</th>' +
      "</tr>" +
      "</thead>" +
      "<tbody>" +
      allBench
        .map(function (b) {
          return (
            "<tr>" +
            '<td class="py-1.5 px-2 text-slate-200 border-b border-slate-800/60 font-semibold">' +
            esc(b.name) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-300 border-b border-slate-800/60">' +
            esc(b.resolution) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-300 border-b border-slate-800/60">' +
            esc(b.preset) +
            "</td>" +
            '<td class="py-1.5 px-2 text-emerald-400 font-bold border-b border-slate-800/60 text-right">' +
            esc(String(b.avgFps)) +
            "</td>" +
            '<td class="py-1.5 px-2 text-sky-400 border-b border-slate-800/60 text-right">' +
            esc(String(b.onePercentLowFps)) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-400 border-b border-slate-800/60 text-right">' +
            esc(String(b.sampleCount)) +
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }

  function priceHistoryTabHtml() {
    const comps = state.compareData;
    return (
      '<div class="overflow-x-auto"><table class="w-full text-xs hw-cmp-sticky">' +
      "<thead>" +
      "<tr>" +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Component</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Current</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Trend</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">12-Month</th>' +
      "</tr>" +
      "</thead>" +
      "<tbody>" +
      comps
        .map(function (c) {
          const history = c.priceHistory || {};
          const points = history.points || [];
          return (
            "<tr>" +
            '<td class="py-1.5 px-2 text-slate-200 border-b border-slate-800/60 font-semibold">' +
            esc(c.name) +
            "</td>" +
            '<td class="py-1.5 px-2 text-emerald-400 font-bold border-b border-slate-800/60 text-right">' +
            money(points.length ? points[points.length - 1].priceUsd : c.priceUsd) +
            "</td>" +
            '<td class="py-1.5 px-2 border-b border-slate-800/60">' +
            trendBadge(history.trend) +
            "</td>" +
            '<td class="py-1.5 px-2 border-b border-slate-800/60">' +
            sparkline(points) +
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }

  // -------------------------------------------------------------------------
  // Community Benchmark Tables (filterable)
  // -------------------------------------------------------------------------
  async function loadBenchmarks() {
    const tableEl = $("hw-bench-table");
    if (!tableEl) return;
    const q = new URLSearchParams();
    if (state.benchFilters.type) q.set("type", state.benchFilters.type);
    if (state.benchFilters.resolution) {
      q.set("resolution", state.benchFilters.resolution);
    }
    if (state.benchFilters.preset) q.set("preset", state.benchFilters.preset);
    tableEl.innerHTML =
      '<div class="text-xs text-slate-400 py-4 text-center">Loading community benchmarks…</div>';
    try {
      const res = await fetch("/api/hardware/benchmarks?" + q.toString());
      const data = await res.json();
      renderBenchmarks(data, tableEl);
    } catch (err) {
      console.error("[hardware.js] Benchmark load error:", err);
      tableEl.innerHTML =
        '<div class="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">Failed to load community benchmarks.</div>';
    }
  }

  function renderBenchmarks(data, tableEl) {
    const rows = data.success && Array.isArray(data.benchmarks) ? data.benchmarks : [];
    if (rows.length === 0) {
      tableEl.innerHTML =
        '<div class="text-xs text-slate-500 bg-slate-900/70 border border-slate-800 rounded-xl p-4 text-center">No benchmark rows match these filters.</div>';
      return;
    }
    ensureStickyStyles();
    tableEl.innerHTML =
      '<div class="overflow-x-auto"><table class="w-full text-xs hw-cmp-sticky">' +
      "<thead>" +
      "<tr>" +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Component</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Type</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Resolution</th>' +
      '<th class="text-left py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Preset</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Avg FPS</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">1% Low</th>' +
      '<th class="text-right py-2 px-2 font-black uppercase tracking-wider text-[10px] text-slate-500 border-b border-slate-700">Samples</th>' +
      "</tr>" +
      "</thead>" +
      "<tbody>" +
      rows
        .map(function (b) {
          return (
            "<tr>" +
            '<td class="py-1.5 px-2 text-slate-200 border-b border-slate-800/60 font-semibold">' +
            esc(b.componentName) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-300 border-b border-slate-800/60 uppercase text-[10px]">' +
            esc(b.componentType) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-300 border-b border-slate-800/60">' +
            esc(b.resolution) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-300 border-b border-slate-800/60">' +
            esc(b.settingsPreset) +
            "</td>" +
            '<td class="py-1.5 px-2 text-emerald-400 font-bold border-b border-slate-800/60 text-right">' +
            esc(String(b.avgFps)) +
            "</td>" +
            '<td class="py-1.5 px-2 text-sky-400 border-b border-slate-800/60 text-right">' +
            esc(String(b.onePercentLowFps)) +
            "</td>" +
            '<td class="py-1.5 px-2 text-slate-400 border-b border-slate-800/60 text-right">' +
            esc(String(b.sampleCount)) +
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";
  }

  function applyBenchFilters() {
    const typeSel = $("hw-bench-type");
    const resSel = $("hw-bench-resolution");
    const presetSel = $("hw-bench-preset");
    state.benchFilters.type = typeSel ? typeSel.value : "";
    state.benchFilters.resolution = resSel ? resSel.value : "";
    state.benchFilters.preset = presetSel ? presetSel.value : "";
    loadBenchmarks();
  }

  // -------------------------------------------------------------------------
  // Deep-linking & initialization
  // -------------------------------------------------------------------------
  function preselectTool(tool) {
    const anchors = {
      compatibility: "hw-comp-game",
      upgrade: "hw-upgrade-btn",
      compare: "hw-cmp-type",
      benchmarks: "hw-bench-type",
    };
    const id = anchors[tool] || "hw-scan-btn";
    const el = $(id);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function bindEvents() {
    const scanBtn = $("hw-scan-btn");
    if (scanBtn) scanBtn.addEventListener("click", scanRig);

    const analyzeBtn = $("hw-analyze-btn");
    if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeCompatibility);

    const upgradeBtn = $("hw-upgrade-btn");
    if (upgradeBtn) upgradeBtn.addEventListener("click", loadUpgradeAdvice);

    const cmpType = $("hw-cmp-type");
    if (cmpType) {
      cmpType.addEventListener("change", function () {
        state.compare.type = cmpType.value;
        state.compare.slots = ["", "", "", ""];
        state.compareData = null;
        renderCompareSlots();
        const tableEl = $("hw-cmp-table");
        if (tableEl) tableEl.innerHTML = "";
      });
    }

    const benchApply = $("hw-bench-apply");
    if (benchApply) benchApply.addEventListener("click", applyBenchFilters);
  }

  function init(tool) {
    if (!initialized) {
      bindEvents();
      loadRig();
      loadGames();
      loadComponents();
      loadBenchmarks();
      initialized = true;
    } else {
      loadRig();
      loadBenchmarks();
    }
    if (tool && typeof tool === "string") {
      preselectTool(tool);
    }
  }

  window.__hardware = { init: init, preselectTool: preselectTool };
})();
