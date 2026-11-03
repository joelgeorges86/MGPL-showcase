/**
 * Sprint 2 (EPIC-DEV-001): Custom PC Builder UI controller.
 *
 * Powers the 9-category builder row view inside #devices-panel-builder.
 * Fetches components from /api/builder/components, renders category rows,
 * opens a part picker modal with live search/spec filters, and keeps a
 * summary bar (total price + estimated wattage + compatibility banner) in sync
 * via POST /api/builder/validate. Save/Share/My Builds call the auth-scoped
 * build endpoints and shared builds are rendered read-only from a share slug.
 *
 * Exposes window.__builder.init(slug?) so public/devices.js and the share
 * deep-link in public/app.js can hydrate the surface.
 */
(function () {
  "use strict";

  var CATEGORY_ORDER = [
    "CPU",
    "Motherboard",
    "GPU",
    "RAM",
    "Storage",
    "PSU",
    "Case",
    "Cooler",
    "OS",
  ];

  var CATEGORY_META = {
    CPU: { icon: "cpu", label: "Processor" },
    Motherboard: { icon: "circuit-board", label: "Motherboard" },
    GPU: { icon: "monitor", label: "Graphics Card" },
    RAM: { icon: "memory-stick", label: "Memory" },
    Storage: { icon: "hard-drive", label: "Storage" },
    PSU: { icon: "plug-zap", label: "Power Supply" },
    Case: { icon: "box", label: "Case" },
    Cooler: { icon: "fan", label: "Cooler" },
    OS: { icon: "app-window", label: "Operating System" },
  };

  var allComponents = [];
  var byCategory = {};
  var selected = {}; // category -> componentId
  var currentShareSlug = null;
  var pickerCategory = null;
  var pickerSearch = "";
  var pickerFilters = {};

  function $(id) {
    return document.getElementById(id);
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function money(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return "$0.00";
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function toast(msg, isError) {
    if (window.showToast && typeof window.showToast === "function") {
      window.showToast(msg, isError);
      return;
    }
    console.log("[builder.js]", msg);
  }

  function selectedIds() {
    return CATEGORY_ORDER.map(function (cat) {
      return selected[cat];
    }).filter(Boolean);
  }

  function selectedComponentsMap() {
    var map = {};
    for (var i = 0; i < allComponents.length; i++) {
      var c = allComponents[i];
      if (selected[c.category] === c.componentId) map[c.category] = c;
    }
    return map;
  }

  function apiFetch(url, options) {
    var o = options || {};
    o.headers = o.headers || {};
    if (o.body && typeof o.body === "string") {
      o.headers["Content-Type"] = o.headers["Content-Type"] || "application/json";
    }
    return fetch(url, o);
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------
  async function loadComponents() {
    var res = await apiFetch("/api/builder/components");
    var data = await res.json();
    if (!data.success || !Array.isArray(data.components)) {
      throw new Error("Failed to load builder components");
    }
    allComponents = data.components;
    byCategory = {};
    for (var i = 0; i < allComponents.length; i++) {
      var c = allComponents[i];
      if (!byCategory[c.category]) byCategory[c.category] = [];
      byCategory[c.category].push(c);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function renderRows() {
    var root = $("builder-component-rows");
    if (!root) return;

    root.innerHTML = CATEGORY_ORDER.map(function (cat) {
      var comp = null;
      if (selected[cat]) {
        for (var i = 0; i < (byCategory[cat] || []).length; i++) {
          if (byCategory[cat][i].componentId === selected[cat]) {
            comp = byCategory[cat][i];
            break;
          }
        }
      }
      var meta = CATEGORY_META[cat] || { icon: "box", label: cat };
      var title = comp ? esc(comp.name) : "Choose " + meta.label;
      var price = comp ? money(comp.priceUsd) : "—";

      return (
        '<div class="bg-slate-950/70 border border-slate-800 rounded-xl p-3 flex items-center gap-3">' +
        '<div class="w-9 h-9 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center flex-shrink-0">' +
        '<i data-lucide="' +
        esc(meta.icon) +
        '" class="w-4 h-4 text-brand-400"></i></div>' +
        '<div class="min-w-0 flex-1">' +
        '<p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">' +
        esc(meta.label) +
        "</p>" +
        '<p class="text-xs font-semibold text-slate-200 truncate">' +
        title +
        "</p>" +
        '<p class="text-[11px] font-bold text-emerald-400">' +
        price +
        "</p>" +
        "</div>" +
        '<button type="button" data-builder-pick="' +
        esc(cat) +
        '" class="shrink-0 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-brand-600 hover:text-white text-slate-300 text-xs font-bold transition-all">' +
        "Choose</button>" +
        "</div>"
      );
    }).join("");

    if (window.lucide) window.lucide.createIcons();

    // Wire pick buttons via delegation.
    root.querySelectorAll("[data-builder-pick]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openPicker(btn.getAttribute("data-builder-pick"));
      });
    });
  }

  function renderSummary(validation) {
    var totalEl = $("builder-total-price");
    var wattEl = $("builder-estimated-wattage");
    var countEl = $("builder-part-count");
    var bannerEl = $("builder-compat-banner");
    var ids = selectedIds();

    if (totalEl) totalEl.textContent = money(validation ? validation.totalPrice : 0);
    if (wattEl) wattEl.textContent = (validation ? validation.estimatedWattage : 0) + " W";
    if (countEl) countEl.textContent = String(ids.length);

    if (bannerEl) {
      var issues = (validation && validation.issues) || [];
      if (validation && !validation.compatible) {
        var errorCount = issues.filter(function (i) {
          return i.severity === "error";
        }).length;
        bannerEl.className =
          "rounded-xl border px-4 py-2.5 text-xs font-bold flex items-center gap-2 border-rose-500/40 bg-rose-900/30 text-rose-300";
        bannerEl.setAttribute("data-testid", "builder-incompat-banner");
        bannerEl.innerHTML =
          '<i data-lucide="alert-triangle" class="w-4 h-4"></i>' +
          "<span>" +
          esc(errorCount + " Issues Found") +
          "</span>";
      } else if (validation && validation.compatible) {
        bannerEl.className =
          "rounded-xl border px-4 py-2.5 text-xs font-bold flex items-center gap-2 border-emerald-500/40 bg-emerald-900/20 text-emerald-300";
        bannerEl.setAttribute("data-testid", "builder-compat-banner");
        bannerEl.innerHTML =
          '<i data-lucide="check-circle" class="w-4 h-4"></i>' + "<span>✓ Compatible</span>";
      } else {
        bannerEl.className =
          "hidden rounded-xl border px-4 py-2.5 text-xs font-bold flex items-center gap-2";
        bannerEl.removeAttribute("data-testid");
        bannerEl.innerHTML = "";
      }
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // Compatibility-driven "incompatible" pre-check for the picker.
  function isIncompatible(candidate) {
    var map = selectedComponentsMap();
    // Socket rule: candidate CPU vs selected Motherboard (and vice versa).
    if (candidate.category === "CPU" && map.Motherboard) {
      if (
        candidate.socketType &&
        map.Motherboard.socketType &&
        candidate.socketType !== map.Motherboard.socketType
      )
        return true;
    }
    if (candidate.category === "Motherboard" && map.CPU) {
      if (candidate.socketType && map.CPU.socketType && candidate.socketType !== map.CPU.socketType)
        return true;
    }
    // DDR rule: candidate RAM vs selected Motherboard (and vice versa).
    if (candidate.category === "RAM" && map.Motherboard) {
      if (candidate.ddrGen && map.Motherboard.ddrGen && candidate.ddrGen !== map.Motherboard.ddrGen)
        return true;
    }
    if (candidate.category === "Motherboard" && map.RAM) {
      if (candidate.ddrGen && map.RAM.ddrGen && candidate.ddrGen !== map.RAM.ddrGen) return true;
    }
    // Form factor rule: candidate Motherboard vs selected Case (and vice versa).
    var FF_RANK = { "Mini-ITX": 1, "Micro-ATX": 2, ATX: 3 };
    if (candidate.category === "Case" && map.Motherboard) {
      var caseRank = FF_RANK[candidate.formFactor];
      var mbRank = FF_RANK[map.Motherboard.formFactor];
      if (caseRank !== undefined && mbRank !== undefined && mbRank > caseRank) return true;
    }
    if (candidate.category === "Motherboard" && map.Case) {
      var mRank = FF_RANK[candidate.formFactor];
      var cRank = FF_RANK[map.Case.formFactor];
      if (mRank !== undefined && cRank !== undefined && mRank > cRank) return true;
    }
    // PSU headroom rule: candidate PSU vs current total load (excluding existing PSU).
    if (candidate.category === "PSU") {
      var load = estimateWattageForSelection();
      if (load > 0 && candidate.tdpWatts != null && candidate.tdpWatts < load) return true;
    }
    return false;
  }

  function estimateWattageForSelection() {
    var map = selectedComponentsMap();
    var totalTdp = 0;
    for (var cat in map) {
      totalTdp += map[cat].tdpWatts || 0;
    }
    return totalTdp > 0 ? Math.ceil(totalTdp * 1.2) : 0;
  }

  async function validateAndRender() {
    var ids = selectedIds();
    if (ids.length === 0) {
      renderSummary(null);
      return;
    }
    try {
      var res = await apiFetch("/api/builder/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ componentIds: ids }),
      });
      var data = await res.json();
      if (data.success) {
        renderSummary(data);
      } else {
        renderSummary(null);
      }
    } catch (err) {
      console.error("builder validate error:", err);
      renderSummary(null);
    }
  }

  async function pickComponent(componentId) {
    var comp = null;
    for (var i = 0; i < allComponents.length; i++) {
      if (allComponents[i].componentId === componentId) {
        comp = allComponents[i];
        break;
      }
    }
    if (!comp) return;
    selected[comp.category] = comp.componentId;
    renderRows();
    await validateAndRender();
    closePicker();
  }

  // -------------------------------------------------------------------------
  // Picker modal
  // -------------------------------------------------------------------------
  function openPicker(category) {
    pickerCategory = category;
    pickerSearch = "";
    pickerFilters = {};
    var modal = $("builder-picker-modal");
    if (!modal) return;

    var meta = CATEGORY_META[category] || { label: category };
    var titleEl = $("builder-picker-title");
    if (titleEl) titleEl.textContent = "Choose " + meta.label;

    renderPickerOptions();
    modal.classList.remove("hidden");
    modal.classList.add("flex");

    var searchEl = $("builder-picker-search");
    if (searchEl) searchEl.value = "";
  }

  function closePicker() {
    var modal = $("builder-picker-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
  }

  function specLabel(comp) {
    var bits = [];
    if (comp.socketType) bits.push(comp.socketType);
    if (comp.ddrGen) bits.push(comp.ddrGen);
    if (comp.formFactor) bits.push(comp.formFactor);
    if (comp.tdpWatts != null) bits.push(comp.tdpWatts + "W");
    return bits.join(" · ");
  }

  function renderPickerOptions() {
    var list = byCategory[pickerCategory] || [];
    var q = pickerSearch.trim().toLowerCase();
    var filtered = list.filter(function (c) {
      if (q && c.name.toLowerCase().indexOf(q) === -1) return false;
      // apply spec filter
      if (pickerFilters.socket && c.socketType !== pickerFilters.socket) return false;
      if (pickerFilters.ddr && c.ddrGen !== pickerFilters.ddr) return false;
      if (pickerFilters.formFactor && c.formFactor !== pickerFilters.formFactor) return false;
      return true;
    });

    var listEl = $("builder-picker-list");
    if (!listEl) return;

    var currentlySelected = selected[pickerCategory];

    if (filtered.length === 0) {
      listEl.innerHTML =
        '<div class="col-span-full text-center py-8 text-slate-500 text-xs">No components match your filters.</div>';
      return;
    }

    // Build spec facet options for the current category.
    var sockets = unique(
      list
        .map(function (c) {
          return c.socketType;
        })
        .filter(Boolean),
    );
    var ddrs = unique(
      list
        .map(function (c) {
          return c.ddrGen;
        })
        .filter(Boolean),
    );
    var formFactors = unique(
      list
        .map(function (c) {
          return c.formFactor;
        })
        .filter(Boolean),
    );
    renderPickerFacets(sockets, ddrs, formFactors);

    listEl.innerHTML = filtered
      .map(function (c) {
        var incompatible = isIncompatible(c);
        var isSel = c.componentId === currentlySelected;
        var classes =
          "bg-slate-950/70 border rounded-xl p-3 flex flex-col justify-between gap-2 transition-all cursor-pointer ";
        classes += isSel
          ? "border-emerald-500/70 ring-1 ring-emerald-500/40"
          : "border-slate-800 hover:border-slate-600";
        if (incompatible) classes += " opacity-70";

        return (
          '<div data-component-id="' +
          esc(c.componentId) +
          '" ' +
          'data-testid="builder-picker-option" data-incompatible="' +
          (incompatible ? "1" : "0") +
          '" ' +
          'class="' +
          classes +
          '">' +
          '<div class="flex items-start justify-between gap-2">' +
          '<p class="text-xs font-bold text-slate-200 leading-snug">' +
          esc(c.name) +
          "</p>" +
          (incompatible
            ? '<span class="shrink-0 px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/40 text-[9px] font-black uppercase">Incompatible</span>'
            : isSel
              ? '<span class="shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 text-[9px] font-black uppercase">Selected</span>'
              : "") +
          "</div>" +
          '<div class="flex items-center justify-between gap-2">' +
          '<span class="text-[10px] text-slate-500">' +
          esc(specLabel(c)) +
          "</span>" +
          '<span class="text-xs font-black text-emerald-400">' +
          money(c.priceUsd) +
          "</span>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    listEl.querySelectorAll("[data-component-id]").forEach(function (el) {
      el.addEventListener("click", function () {
        pickComponent(el.getAttribute("data-component-id"));
      });
    });
  }

  function unique(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (!seen[v]) {
        seen[v] = true;
        out.push(v);
      }
    }
    return out;
  }

  function renderPickerFacets(sockets, ddrs, formFactors) {
    var socketEl = $("builder-picker-socket");
    var ddrEl = $("builder-picker-ddr");
    var ffEl = $("builder-picker-formfactor");

    if (socketEl) {
      socketEl.style.display = sockets.length ? "block" : "none";
      socketEl.innerHTML =
        '<option value="">All Sockets</option>' +
        sockets
          .map(function (s) {
            return (
              '<option value="' +
              esc(s) +
              '"' +
              (pickerFilters.socket === s ? " selected" : "") +
              ">" +
              esc(s) +
              "</option>"
            );
          })
          .join("");
    }
    if (ddrEl) {
      ddrEl.style.display = ddrs.length ? "block" : "none";
      ddrEl.innerHTML =
        '<option value="">All DDR</option>' +
        ddrs
          .map(function (s) {
            return (
              '<option value="' +
              esc(s) +
              '"' +
              (pickerFilters.ddr === s ? " selected" : "") +
              ">" +
              esc(s) +
              "</option>"
            );
          })
          .join("");
    }
    if (ffEl) {
      ffEl.style.display = formFactors.length ? "block" : "none";
      ffEl.innerHTML =
        '<option value="">All Form Factors</option>' +
        formFactors
          .map(function (s) {
            return (
              '<option value="' +
              esc(s) +
              '"' +
              (pickerFilters.formFactor === s ? " selected" : "") +
              ">" +
              esc(s) +
              "</option>"
            );
          })
          .join("");
    }
  }

  // -------------------------------------------------------------------------
  // Save / Share / My Builds
  // -------------------------------------------------------------------------
  function ensureSaveModal() {
    if ($("builder-save-modal")) return;
    var modal = document.createElement("div");
    modal.id = "builder-save-modal";
    modal.className = "hidden fixed inset-0 z-[80] items-center justify-center p-4";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "builder-save-modal-title");
    modal.innerHTML =
      '<div class="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" data-builder-save-close></div>' +
      '<div class="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-5 space-y-4">' +
      '<div class="flex items-center justify-between">' +
      '<h3 id="builder-save-modal-title" class="text-base font-bold text-white flex items-center gap-2"><i data-lucide="save" class="w-4 h-4 text-emerald-400"></i> Save Build</h3>' +
      '<button id="builder-save-close" type="button" aria-label="Close" class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button>' +
      "</div>" +
      "<div>" +
      '<label for="builder-save-name" class="block text-xs font-semibold text-slate-400 mb-1">Build Name</label>' +
      '<input id="builder-save-name" type="text" placeholder="e.g. Living Room Rig" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500">' +
      "</div>" +
      '<div class="flex items-center justify-end gap-2 pt-1">' +
      '<button id="builder-save-cancel" type="button" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all">Cancel</button>' +
      '<button id="builder-save-confirm" type="button" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-lg shadow-emerald-600/20 active:scale-95">Save Build</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(modal);

    var closeBtn = $("builder-save-close");
    var cancelBtn = $("builder-save-cancel");
    var confirmBtn = $("builder-save-confirm");
    if (closeBtn) closeBtn.addEventListener("click", closeSaveModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeSaveModal);
    if (confirmBtn) confirmBtn.addEventListener("click", confirmSaveBuild);
    modal.querySelectorAll("[data-builder-save-close]").forEach(function (el) {
      el.addEventListener("click", closeSaveModal);
    });

    if (window.lucide) window.lucide.createIcons();
  }

  function openSaveModal() {
    var ids = selectedIds();
    if (ids.length === 0) {
      toast("Select at least one component before saving.", true);
      return;
    }
    ensureSaveModal();
    var modal = $("builder-save-modal");
    var input = $("builder-save-name");
    if (input) input.value = "";
    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("flex");
      if (input && typeof input.focus === "function") input.focus();
    }
  }

  function closeSaveModal() {
    var modal = $("builder-save-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
  }

  async function confirmSaveBuild() {
    var input = $("builder-save-name");
    var name = input ? input.value.trim() : "";
    if (!name) {
      toast("Build name is required.", true);
      return;
    }

    var ids = selectedIds();
    closeSaveModal();

    try {
      var res = await apiFetch("/api/builder/builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buildName: name, componentIds: ids }),
      });
      var data = await res.json();
      if (!res.ok || !data.success) {
        toast(data.error || "Failed to save build", true);
        return;
      }
      currentShareSlug = data.build.shareSlug;
      var slugEl = $("builder-saved-slug");
      if (slugEl) {
        slugEl.textContent = "Share: #/devices/builder/share/" + currentShareSlug;
        slugEl.classList.remove("hidden");
      }
      toast("Build saved: " + data.build.buildName);
      renderMyBuilds();
    } catch (err) {
      console.error("Save build error:", err);
      toast("Failed to save build", true);
    }
  }

  async function shareBuild() {
    var slug = currentShareSlug;
    if (!slug) {
      // Try to load the most recent build and share that.
      try {
        var res = await apiFetch("/api/builder/builds");
        var data = await res.json();
        if (res.status === 401) {
          toast("Sign in and save a build before sharing.", true);
          return;
        }
        if (data.success && data.builds && data.builds.length) {
          slug = data.builds[0].shareSlug;
        } else {
          toast("No saved build to share yet.", true);
          return;
        }
      } catch (err) {
        toast("No saved build to share yet.", true);
        return;
      }
    }

    var url = window.location.origin + "/#/devices/builder/share/" + encodeURIComponent(slug);
    try {
      await navigator.clipboard.writeText(url);
      toast("Share link copied to clipboard");
    } catch (err) {
      // Fallback for non-secure contexts / clipboard permission denied.
      var ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast("Share link copied to clipboard");
      } catch (e2) {
        toast("Copy failed: " + url, true);
      }
      document.body.removeChild(ta);
    }
  }

  async function renderMyBuilds() {
    var container = $("builder-my-builds");
    if (!container) return;

    container.classList.remove("hidden");
    container.innerHTML = '<p class="text-xs text-slate-500">Loading saved builds…</p>';

    try {
      var res = await apiFetch("/api/builder/builds");
      var data = await res.json();
      if (res.status === 401) {
        container.innerHTML =
          '<p class="text-xs text-slate-500">Sign in to view your saved builds.</p>';
        return;
      }
      if (!data.success || !Array.isArray(data.builds)) {
        container.innerHTML = '<p class="text-xs text-rose-400">Failed to load builds.</p>';
        return;
      }
      if (data.builds.length === 0) {
        container.innerHTML = '<p class="text-xs text-slate-500">No saved builds yet.</p>';
        return;
      }

      container.innerHTML = data.builds
        .map(function (b) {
          return (
            '<div class="flex items-center justify-between gap-3 bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2">' +
            "<div>" +
            '<p class="text-xs font-bold text-white">' +
            esc(b.buildName) +
            "</p>" +
            '<p class="text-[10px] text-slate-500">' +
            esc(b.componentCount || (b.components ? b.components.length : 0)) +
            " parts · " +
            money(b.totalPrice) +
            " · " +
            b.estimatedWattage +
            "W</p>" +
            "</div>" +
            '<button type="button" data-builder-load="' +
            esc(b.shareSlug) +
            '" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-brand-600 hover:text-white text-slate-300 text-xs font-bold transition-all">Load</button>' +
            "</div>"
          );
        })
        .join("");

      container.querySelectorAll("[data-builder-load]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          renderSharedBuild(btn.getAttribute("data-builder-load"), false);
        });
      });
    } catch (err) {
      console.error("Load builds error:", err);
      container.innerHTML = '<p class="text-xs text-rose-400">Failed to load builds.</p>';
    }
  }

  // -------------------------------------------------------------------------
  // Shared build (read-only) rendering
  // -------------------------------------------------------------------------
  async function renderSharedBuild(slug, readOnly) {
    var root = $("builder-root");
    if (!root) return;

    // Restore runtime picker-only markup if missing (shared view reuses tabs).
    if (!$("builder-component-rows")) {
      root.innerHTML = defaultRootMarkup();
      wireStaticButtons();
    }

    try {
      var res = await apiFetch("/api/builder/share/" + encodeURIComponent(slug));
      if (!res.ok) {
        toast("Shared build not found", true);
        return;
      }
      var data = await res.json();
      if (!data.success || !data.build) {
        toast("Shared build not found", true);
        return;
      }
      currentShareSlug = data.build.shareSlug;

      var build = data.build;
      var rowsEl = $("builder-component-rows");
      if (rowsEl) {
        var rendered = CATEGORY_ORDER.map(function (cat) {
          var comp = (build.components || []).find(function (c) {
            return c.category === cat;
          });
          var meta = CATEGORY_META[cat] || { label: cat, icon: "box" };
          return (
            '<div class="bg-slate-950/70 border border-slate-800 rounded-xl p-3 flex items-center gap-3">' +
            '<div class="w-9 h-9 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center flex-shrink-0">' +
            '<i data-lucide="' +
            esc(meta.icon) +
            '" class="w-4 h-4 text-brand-400"></i></div>' +
            '<div class="min-w-0 flex-1">' +
            '<p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">' +
            esc(meta.label) +
            "</p>" +
            '<p class="text-xs font-semibold text-slate-200 truncate">' +
            esc(comp ? comp.name : "Not selected") +
            "</p>" +
            '<p class="text-[11px] font-bold text-emerald-400">' +
            (comp ? money(comp.priceUsd) : "—") +
            "</p>" +
            "</div></div>"
          );
        }).join("");
        rowsEl.innerHTML = rendered;
      }

      var totalEl = $("builder-total-price");
      var wattEl = $("builder-estimated-wattage");
      var countEl = $("builder-part-count");
      if (totalEl) totalEl.textContent = money(build.totalPrice);
      if (wattEl) wattEl.textContent = build.estimatedWattage + " W";
      if (countEl) countEl.textContent = String((build.components || []).length);

      if (readOnly) {
        // Show a read-only banner.
        var bannerEl = $("builder-compat-banner");
        if (bannerEl) {
          bannerEl.className =
            "rounded-xl border px-4 py-2.5 text-xs font-bold flex items-center gap-2 border-sky-500/40 bg-sky-900/20 text-sky-300";
          bannerEl.innerHTML =
            '<i data-lucide="lock" class="w-4 h-4"></i><span>Shared build snapshot (read-only)</span>';
        }
        // Hide editor-only controls.
        var saveBtn = $("builder-save-btn");
        var pickBtns = rowsEl ? rowsEl.querySelectorAll("[data-builder-pick]") : [];
        if (saveBtn) saveBtn.disabled = true;
        pickBtns.forEach(function (b) {
          b.disabled = true;
          b.classList.add("opacity-40");
        });
      }

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Shared build error:", err);
      toast("Failed to load shared build", true);
    }
  }

  function defaultRootMarkup() {
    return (
      '<div class="space-y-4">' +
      '<div class="flex items-center justify-between gap-3">' +
      '<div class="flex items-center gap-2.5"><div class="bg-brand-500/10 text-brand-400 p-2 rounded-lg"><i data-lucide="cpu" class="w-5 h-5"></i></div>' +
      '<div><h3 class="text-sm font-bold text-white">Custom PC Builder</h3><p class="text-[11px] text-slate-400">Pick parts across 9 categories. Total price & wattage update in real time.</p></div></div>' +
      '<div class="flex items-center gap-2">' +
      '<button id="builder-save-btn" type="button" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all flex items-center gap-1.5 shadow-md shadow-emerald-600/20 active:scale-95"><i data-lucide="save" class="w-3.5 h-3.5"></i> Save Build</button>' +
      '<button id="builder-share-btn" type="button" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-all flex items-center gap-1.5 border border-slate-700 active:scale-95"><i data-lucide="share-2" class="w-3.5 h-3.5"></i> Share</button>' +
      '<button id="builder-my-builds-btn" type="button" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-all flex items-center gap-1.5 border border-slate-700 active:scale-95"><i data-lucide="list" class="w-3.5 h-3.5"></i> My Builds</button>' +
      "</div></div>" +
      '<div id="builder-compat-banner" class="hidden rounded-xl border px-4 py-2.5 text-xs font-bold flex items-center gap-2"></div>' +
      '<div id="builder-component-rows" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"></div>' +
      '<div class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center gap-4">' +
      '<div class="flex items-center gap-2"><span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Price</span><span id="builder-total-price" data-testid="builder-total-price" class="text-lg font-black text-emerald-400">$0.00</span></div>' +
      '<div class="flex items-center gap-2"><span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Est. Wattage</span><span id="builder-estimated-wattage" data-testid="builder-estimated-wattage" class="text-lg font-black text-amber-400">0 W</span></div>' +
      '<div class="flex items-center gap-2"><span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Parts</span><span id="builder-part-count" class="text-lg font-black text-white">0</span></div>' +
      '<span id="builder-saved-slug" class="ml-auto text-[11px] text-slate-500 hidden"></span></div>' +
      '<div id="builder-my-builds" class="hidden bg-slate-950/70 border border-slate-800 rounded-xl p-4 space-y-2"></div>' +
      "</div>"
    );
  }

  function ensurePickerModal() {
    if ($("builder-picker-modal")) return;
    var modal = document.createElement("div");
    modal.id = "builder-picker-modal";
    modal.className = "hidden fixed inset-0 z-[80] items-center justify-center p-4";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML =
      '<div class="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" data-builder-picker-close></div>' +
      '<div class="relative w-full max-w-2xl max-h-[85vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col">' +
      '<div class="flex items-center justify-between px-5 py-4 border-b border-slate-800">' +
      '<h3 id="builder-picker-title" class="text-base font-bold text-white">Choose Component</h3>' +
      '<button id="builder-picker-close" type="button" aria-label="Close" class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button>' +
      "</div>" +
      '<div class="px-5 py-3 border-b border-slate-800 space-y-3">' +
      '<input id="builder-picker-search" type="text" placeholder="Search parts…" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500">' +
      '<div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">' +
      '<select id="builder-picker-socket" class="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none"><option value="">All Sockets</option></select>' +
      '<select id="builder-picker-ddr" class="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none"><option value="">All DDR</option></select>' +
      '<select id="builder-picker-formfactor" class="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none"><option value="">All Form Factors</option></select>' +
      "</div>" +
      "</div>" +
      '<div id="builder-picker-list" class="flex-1 overflow-y-auto p-4 grid grid-cols-1 sm:grid-cols-2 gap-3"></div>' +
      "</div>";
    document.body.appendChild(modal);
    wirePickerModal();
  }

  function wirePickerModal() {
    var modal = $("builder-picker-modal");
    if (!modal) return;
    var closeBtn = $("builder-picker-close");
    if (closeBtn) closeBtn.addEventListener("click", closePicker);
    modal.querySelectorAll("[data-builder-picker-close]").forEach(function (el) {
      el.addEventListener("click", closePicker);
    });
    var searchEl = $("builder-picker-search");
    if (searchEl) {
      searchEl.addEventListener("input", function () {
        pickerSearch = searchEl.value;
        renderPickerOptions();
      });
    }
    var socketEl = $("builder-picker-socket");
    if (socketEl)
      socketEl.addEventListener("change", function () {
        pickerFilters.socket = socketEl.value || undefined;
        renderPickerOptions();
      });
    var ddrEl = $("builder-picker-ddr");
    if (ddrEl)
      ddrEl.addEventListener("change", function () {
        pickerFilters.ddr = ddrEl.value || undefined;
        renderPickerOptions();
      });
    var ffEl = $("builder-picker-formfactor");
    if (ffEl)
      ffEl.addEventListener("change", function () {
        pickerFilters.formFactor = ffEl.value || undefined;
        renderPickerOptions();
      });
  }

  function wireStaticButtons() {
    var saveBtn = $("builder-save-btn");
    var shareBtn = $("builder-share-btn");
    var buildsBtn = $("builder-my-builds-btn");
    if (saveBtn) saveBtn.addEventListener("click", openSaveModal);
    if (shareBtn) shareBtn.addEventListener("click", shareBuild);
    if (buildsBtn) buildsBtn.addEventListener("click", renderMyBuilds);
  }

  function wireEditor() {
    ensurePickerModal();
    wireStaticButtons();

    // If a prior shared render disabled the pick buttons, restore them.
    var saveBtn = $("builder-save-btn");
    if (saveBtn) saveBtn.disabled = false;
    document.querySelectorAll("[data-builder-pick]").forEach(function (b) {
      b.disabled = false;
      b.classList.remove("opacity-40");
    });
  }

  // -------------------------------------------------------------------------
  // Public init
  // -------------------------------------------------------------------------
  async function init(slug) {
    ensurePickerModal();
    wireStaticButtons();

    if (!allComponents.length) {
      try {
        await loadComponents();
      } catch (err) {
        console.error("builder load error:", err);
        return;
      }
    }

    if (slug) {
      await renderSharedBuild(slug, true);
      return;
    }

    renderRows();
    await validateAndRender();
    wireEditor();
  }

  window.__builder = { init: init };
})();
