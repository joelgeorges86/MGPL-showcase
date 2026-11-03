/**
 * Sprint 1 (EPIC-DEV-001): Devices & Hardware Hub controller.
 *
 * Powers the six #page-devices sub-tabs:
 *   - Overview        (catalog summary + deep links)
 *   - My Devices      (user fleet with active/primary badges + spec chips)
 *   - Prebuilts       (paginated, filterable catalog grid + 2-device comparison)
 *   - Custom Builder  (component picker estimate via /api/hardware/components)
 *   - Performance     (GPU/CPU tier distribution from seeded catalog)
 *   - Reviews         (curated editorial community verdicts)
 *
 * Exposes window.__devices.init() so public/app.js's lazy route loader can
 * hydrate the surface on first navigation to #/devices.
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
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

  function formatMoney(value) {
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
    console.log("[devices.js]", message);
  }

  const GPU_TIER_LABELS = {
    enthusiast: "Enthusiast",
    high: "High",
    mid: "Mid",
    entry: "Entry",
    integrated: "Integrated",
  };
  const CPU_TIER_LABELS = {
    flagship: "Flagship",
    high: "High",
    mid: "Mid",
    entry: "Entry",
  };
  const TIER_COLORS = {
    enthusiast: "text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/40",
    flagship: "text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/40",
    high: "text-emerald-300 bg-emerald-500/10 border-emerald-500/40",
    mid: "text-amber-300 bg-amber-500/10 border-amber-500/40",
    entry: "text-slate-300 bg-slate-500/10 border-slate-500/40",
    integrated: "text-sky-300 bg-sky-500/10 border-sky-500/40",
    unclassified: "text-slate-400 bg-slate-800 border-slate-700",
  };

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let currentTab = "overview";
  let catalogState = {
    type: "",
    brand: "",
    gpuTier: "",
    priceMin: "",
    priceMax: "",
    ramMin: "",
    storageMin: "",
    page: 1,
    pageSize: 12,
    totalPages: 1,
  };
  let catalogCompare = []; // selected device ids (max 2)
  let builderComponents = null;
  const REVIEWS = [
    {
      deviceId: "ps5-pro",
      title: "PlayStation 5 Pro",
      verdict:
        "The most capable console on the market — PlayStation Spectral Super Resolution makes 4K/60 the baseline.",
      author: "MGPL Hardware Desk",
      rating: 9.2,
      tags: ["Console", "4K", "PSSR"],
    },
    {
      deviceId: "steam-deck-oled",
      title: "Steam Deck OLED",
      verdict:
        "The definitive handheld. 90Hz OLED, 50Wh battery and the best-in-class suspend/resume make it the default commute companion.",
      author: "MGPL Handheld Lab",
      rating: 9.0,
      tags: ["Handheld", "SteamOS", "OLED"],
    },
    {
      deviceId: "rog-ally-x",
      title: "ASUS ROG Ally X",
      verdict:
        "Windows handheld with real desktop-class muscle. 24GB RAM and an 80Wh battery fix the original\u2019s two biggest complaints.",
      author: "MGPL Handheld Lab",
      rating: 8.6,
      tags: ["Handheld", "Windows", "Z1 Extreme"],
    },
    {
      deviceId: "alienware-aurora-r15",
      title: "Alienware Aurora R15",
      verdict:
        "A no-compromise prebuilt: RTX 4080, 32GB DDR5 and liquid-cooled i9 in a clean, serviceable chassis.",
      author: "MGPL Prebuilt Review",
      rating: 8.8,
      tags: ["Prebuilt", "RTX 4080", "Desktop"],
    },
    {
      deviceId: "xbox-series-x",
      title: "Xbox Series X",
      verdict:
        "Peak console horsepower with Game Pass value. 12 TFLOPS RDNA 2 and Quick Resume remain fantastic value.",
      author: "MGPL Hardware Desk",
      rating: 8.9,
      tags: ["Console", "4K", "Game Pass"],
    },
  ];

  // -------------------------------------------------------------------------
  // Tab controller
  // -------------------------------------------------------------------------
  function setTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".devices-tab-btn").forEach(function (btn) {
      const key = btn.getAttribute("data-devices-tab");
      const active = key === tab;
      btn.className =
        "devices-tab-btn px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 " +
        (active
          ? "active bg-brand-600 text-white"
          : "text-slate-400 hover:text-slate-200 hover:bg-slate-800");
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".devices-tab-panel").forEach(function (panel) {
      const key = panel.id.replace("devices-panel-", "");
      panel.classList.toggle("hidden", key !== tab);
    });

    if (tab === "my-devices") fetchMyDevices();
    if (tab === "prebuilts") fetchCatalog();
    if (tab === "performance") {
      if (window.__performance && typeof window.__performance.init === "function") {
        window.__performance.init();
      }
    }
    if (tab === "reviews") {
      // Sprint 4: initialize the community reviews sub-tab (device selector,
      // verified badges, voting). Falls back to static editorial reviews.
      if (window.__reviews && typeof window.__reviews.initReviewsTab === "function") {
        window.__reviews.initReviewsTab();
      } else {
        renderReviews();
      }
    }
    if (tab === "builder") {
      if (window.__builder && typeof window.__builder.init === "function") {
        window.__builder.init();
      }
    }
    if (tab === "overview") fetchOverview();
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------
  async function fetchOverview() {
    const totalEl = $("devices-overview-total");
    const consolesEl = $("devices-overview-consoles");
    const handheldEl = $("devices-overview-handheld");
    const pcsEl = $("devices-overview-pcs");
    const descEl = $("devices-overview-description");

    try {
      const res = await fetch("/api/catalog/devices?pageSize=100");
      const data = await res.json();
      if (!data.success || !Array.isArray(data.devices)) {
        if (descEl) descEl.textContent = "Catalog summary unavailable.";
        return;
      }
      const devices = data.devices;
      const consoles = devices.filter(function (d) {
        return d.type === "Console";
      }).length;
      const handheld = devices.filter(function (d) {
        return d.type === "Handheld";
      }).length;
      const pcs = devices.filter(function (d) {
        return d.type === "PC";
      }).length;

      if (totalEl) totalEl.textContent = String(devices.length);
      if (consolesEl) consolesEl.textContent = String(consoles);
      if (handheldEl) handheldEl.textContent = String(handheld);
      if (pcsEl) pcsEl.textContent = String(pcs);
      if (descEl) {
        const brands = Array.from(
          new Set(
            devices.map(function (d) {
              return d.brand;
            }),
          ),
        ).sort();
        descEl.textContent =
          "MGPL\u2019s browsable hardware catalog covers " +
          devices.length +
          " devices across " +
          brands.length +
          " brands \u2014 " +
          "consoles, handheld gaming PCs, prebuilt desktops and gaming laptops. " +
          "Use the Prebuilts tab to filter by type, brand, price, GPU tier, RAM and storage, then compare any two side-by-side.";
      }
    } catch (err) {
      console.error("Failed to load overview:", err);
      if (descEl) descEl.textContent = "Catalog summary unavailable.";
    }
  }

  // -------------------------------------------------------------------------
  // My Devices
  // -------------------------------------------------------------------------
  async function fetchMyDevices() {
    const listEl = $("devices-my-list");
    if (!listEl) return;
    listEl.innerHTML =
      '<div class="flex flex-col items-center justify-center py-10 text-slate-500">' +
      '<div class="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500 mb-2"></div>' +
      '<p class="text-xs font-medium">Loading your devices\u2026</p></div>';

    try {
      const res = await fetch("/api/devices");
      if (res.status === 401) {
        listEl.innerHTML =
          '<div class="text-center py-10 text-slate-500 text-xs">' +
          "Sign in to manage your hardware fleet. The Devices hub catalog (Prebuilts tab) is public.</div>";
        return;
      }
      const data = await res.json();
      const devices = Array.isArray(data.devices) ? data.devices : [];
      renderMyDevices(devices);
    } catch (err) {
      console.error("Failed to fetch my devices:", err);
      listEl.innerHTML =
        '<div class="text-center py-10 text-rose-400 text-xs font-semibold">Failed to load your devices.</div>';
    }
  }

  function specChip(label, value) {
    if (value === null || value === undefined || value === "") return "";
    return (
      '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-900 border border-slate-700 text-[10px] font-bold text-slate-200">' +
      '<span class="text-slate-500 font-semibold">' +
      escAttr(label) +
      "</span> " +
      escAttr(value) +
      "</span>"
    );
  }

  function renderMyDevices(devices) {
    const listEl = $("devices-my-list");
    if (!listEl) return;

    if (devices.length === 0) {
      listEl.innerHTML =
        '<div class="text-center py-10 text-slate-500 text-xs">' +
        'No hardware profiles yet. Click "Add Device" to register your first machine.</div>';
      return;
    }

    // Primary device sorts to the top so the active badge is always visible.
    const sorted = devices.slice().sort(function (a, b) {
      return (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0);
    });

    listEl.innerHTML = sorted
      .map(function (device) {
        const id = device.id || device.deviceId || device.deviceName || "";
        const isPrimary = Boolean(device.isPrimary);
        const deviceType = device.deviceType || "desktop";
        const iconName =
          deviceType === "handheld" || deviceType === "console"
            ? "gamepad-2"
            : deviceType === "laptop"
              ? "laptop"
              : "monitor";

        const chips =
          specChip("CPU", device.cpuModel) +
          specChip("RAM", device.ramGb != null ? device.ramGb + " GB" : "") +
          specChip("GPU", device.gpuModel) +
          specChip("VRAM", device.vramGb != null ? device.vramGb + " GB" : "") +
          specChip("Type", deviceType.charAt(0).toUpperCase() + deviceType.slice(1)) +
          specChip(
            "Storage",
            device.storageFreeGb != null ? device.storageFreeGb + " GB free" : "",
          );

        return (
          '<div data-testid="devices-my-row" data-device-id="' +
          escAttr(id) +
          '" ' +
          'class="bg-slate-950/60 border ' +
          (isPrimary
            ? "border-emerald-500/60 ring-1 ring-emerald-500/30"
            : "border-slate-800 hover:border-slate-700") +
          ' rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3 transition-all">' +
          '<div class="flex items-center gap-3 flex-1 min-w-0">' +
          '<div class="w-9 h-9 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center flex-shrink-0">' +
          '<i data-lucide="' +
          iconName +
          '" class="w-4.5 h-4.5 text-slate-400"></i></div>' +
          '<div class="min-w-0">' +
          '<div class="flex items-center gap-2 flex-wrap">' +
          '<h4 class="text-sm font-bold text-white truncate">' +
          escAttr(device.deviceName || id) +
          "</h4>" +
          (isPrimary
            ? '<span data-testid="devices-primary-badge" class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">⭐ Active Device</span>'
            : "") +
          "</div>" +
          '<div class="flex flex-wrap items-center gap-1.5 mt-1.5">' +
          chips +
          "</div>" +
          "</div></div>" +
          '<div class="flex items-center gap-2 flex-shrink-0">' +
          (isPrimary
            ? ""
            : '<button type="button" data-testid="devices-set-primary" data-device-id="' +
              escAttr(id) +
              '" ' +
              'class="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600 hover:text-white text-xs font-semibold transition-all flex items-center gap-1">' +
              '<i data-lucide="star" class="w-3.5 h-3.5"></i> Set Active</button>') +
          '<button type="button" data-testid="devices-delete" data-device-id="' +
          escAttr(id) +
          '" ' +
          'class="p-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white text-xs font-semibold transition-all flex items-center">' +
          '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>' +
          "</div></div>"
        );
      })
      .join("");

    if (window.lucide) window.lucide.createIcons();
  }

  async function setPrimary(deviceId) {
    try {
      const res = await fetch("/api/devices/" + encodeURIComponent(deviceId) + "/primary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.error || "Failed to set active device", true);
        return;
      }
      showToast("Active device updated: " + (data.device?.deviceName || deviceId));
      fetchMyDevices();
    } catch (err) {
      console.error("Set primary error:", err);
      showToast("Failed to set active device", true);
    }
  }

  async function deleteDevice(deviceId) {
    if (!window.confirm("Delete this hardware profile?")) return;
    try {
      const res = await fetch("/api/devices/" + encodeURIComponent(deviceId), {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.error || "Failed to delete device", true);
        return;
      }
      showToast("Device profile removed");
      fetchMyDevices();
    } catch (err) {
      console.error("Delete device error:", err);
      showToast("Failed to delete device", true);
    }
  }

  // -------------------------------------------------------------------------
  // Prebuilts & Consoles catalog + comparison
  // -------------------------------------------------------------------------
  function catalogQueryParams() {
    const params = new URLSearchParams();
    params.set("page", String(catalogState.page));
    params.set("pageSize", String(catalogState.pageSize));
    if (catalogState.type) params.set("type", catalogState.type);
    if (catalogState.brand) params.set("brand", catalogState.brand);
    if (catalogState.gpuTier) params.set("gpuTier", catalogState.gpuTier);
    if (catalogState.priceMin) params.set("priceMin", catalogState.priceMin);
    if (catalogState.priceMax) params.set("priceMax", catalogState.priceMax);
    if (catalogState.ramMin) params.set("ramMin", catalogState.ramMin);
    if (catalogState.storageMin) params.set("storageMin", catalogState.storageMin);
    return params.toString();
  }

  async function fetchCatalog() {
    const gridEl = $("catalog-devices-grid");
    if (!gridEl) return;

    gridEl.innerHTML =
      '<div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">' +
      '<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500 mb-2"></div>' +
      '<p class="text-sm font-medium">Loading hardware catalog\u2026</p></div>';

    try {
      const res = await fetch("/api/catalog/devices?" + catalogQueryParams());
      const data = await res.json();
      if (!data.success) {
        gridEl.innerHTML =
          '<div class="col-span-full text-center py-12 text-rose-400 text-xs font-semibold">Failed to load catalog.</div>';
        return;
      }

      catalogState.totalPages = Number(data.totalPages) || 1;
      renderCatalogFacets(data.facets);
      renderCatalogGrid(data.devices);
      renderCatalogPagination(data);
      renderCompareBar();
    } catch (err) {
      console.error("Catalog fetch error:", err);
      gridEl.innerHTML =
        '<div class="col-span-full text-center py-12 text-rose-400 text-xs font-semibold">Failed to load catalog.</div>';
    }
  }

  function renderCatalogFacets(facets) {
    const typeSelect = $("catalog-filter-type");
    const brandSelect = $("catalog-filter-brand");
    const tierSelect = $("catalog-filter-gputier");

    if (typeSelect && Array.isArray(facets?.types)) {
      typeSelect.innerHTML =
        '<option value="">All Types</option>' +
        facets.types
          .map(function (t) {
            return (
              '<option value="' +
              escAttr(t) +
              '"' +
              (catalogState.type === t ? " selected" : "") +
              ">" +
              escAttr(t) +
              "</option>"
            );
          })
          .join("");
    }
    if (brandSelect && Array.isArray(facets?.brands)) {
      brandSelect.innerHTML =
        '<option value="">All Brands</option>' +
        facets.brands
          .map(function (b) {
            return (
              '<option value="' +
              escAttr(b) +
              '"' +
              (catalogState.brand === b ? " selected" : "") +
              ">" +
              escAttr(b) +
              "</option>"
            );
          })
          .join("");
    }
    if (tierSelect && Array.isArray(facets?.gpuTiers)) {
      tierSelect.innerHTML =
        '<option value="">All GPU Tiers</option>' +
        facets.gpuTiers
          .map(function (t) {
            const label = GPU_TIER_LABELS[t] || t;
            return (
              '<option value="' +
              escAttr(t) +
              '"' +
              (catalogState.gpuTier === t ? " selected" : "") +
              ">" +
              escAttr(label) +
              "</option>"
            );
          })
          .join("");
    }
  }

  function tierPill(tier, labels) {
    const label = (labels && labels[tier]) || tier || "unclassified";
    const color = TIER_COLORS[tier] || TIER_COLORS.unclassified;
    return (
      '<span class="inline-block px-2 py-0.5 rounded-md border text-[10px] font-bold ' +
      color +
      '">' +
      escAttr(label) +
      "</span>"
    );
  }

  function catalogCardHtml(device) {
    const specs = device.specs || {};
    const isSelected = catalogCompare.indexOf(device.id) !== -1;
    const selectedClass = isSelected
      ? "border-emerald-500/70 ring-1 ring-emerald-500/40"
      : "border-slate-800 hover:border-brand-500/40";

    return (
      '<div data-testid="catalog-card" data-device-id="' +
      escAttr(device.id) +
      '" data-device-name="' +
      escAttr(device.name) +
      '" data-device-brand="' +
      escAttr(device.brand || "") +
      '" data-device-type="' +
      escAttr(device.type || "") +
      '" ' +
      'class="catalog-card bg-slate-950/60 border ' +
      selectedClass +
      ' rounded-2xl p-4 flex flex-col justify-between shadow-xl transition-all group">' +
      "<div>" +
      '<div class="h-24 bg-slate-900 rounded-xl mb-3 overflow-hidden flex items-center justify-center relative border border-slate-800">' +
      '<div class="absolute inset-0 flex items-center justify-center text-xs text-slate-400 font-bold">MGPL</div>' +
      (device.imageUrl
        ? '<img src="' +
          escAttr(device.imageUrl) +
          '" loading="lazy" alt="' +
          escAttr(device.name) +
          '" class="relative w-full h-full object-cover group-hover:scale-105 transition-transform" onerror="this.style.display=\'none\';" />'
        : "") +
      '<span class="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-slate-950/90 border border-slate-700 text-[10px] font-black text-slate-300 uppercase tracking-wider">' +
      escAttr(device.type || "PC") +
      "</span>" +
      "</div>" +
      '<h4 class="text-sm font-bold text-white truncate group-hover:text-brand-400 transition-colors" title="' +
      escAttr(device.name) +
      '">' +
      escAttr(device.name) +
      "</h4>" +
      '<p class="text-[11px] text-slate-400 mt-0.5">' +
      escAttr(device.brand || "") +
      (device.releaseDate ? " \u00B7 " + escAttr(device.releaseDate.slice(0, 4)) : "") +
      "</p>" +
      '<div class="flex flex-wrap gap-1 mt-2">' +
      tierPill(specs.gpuTier, GPU_TIER_LABELS) +
      tierPill(specs.cpuTier, CPU_TIER_LABELS) +
      "</div>" +
      '<div class="flex flex-wrap gap-1.5 mt-2 text-[10px] font-semibold text-slate-300">' +
      '<span class="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800">' +
      escAttr(specs.gpuModel || "GPU N/A") +
      "</span>" +
      '<span class="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800">' +
      escAttr(specs.ramGb != null ? specs.ramGb + " GB RAM" : "RAM N/A") +
      "</span>" +
      '<span class="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800">' +
      escAttr(specs.gpuVramGb != null ? specs.gpuVramGb + " GB VRAM" : "VRAM N/A") +
      "</span>" +
      "</div>" +
      "</div>" +
      '<div class="pt-3 mt-3 border-t border-slate-800/60 flex items-center justify-between gap-2">' +
      '<span class="text-sm font-black text-emerald-400">' +
      formatMoney(device.msrp) +
      "</span>" +
      '<label class="inline-flex items-center gap-1.5 cursor-pointer select-none text-[11px] font-bold text-slate-300">' +
      '<input type="checkbox" data-testid="catalog-compare-checkbox" data-device-id="' +
      escAttr(device.id) +
      '" class="catalog-compare-checkbox w-3.5 h-3.5 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500" ' +
      (isSelected ? "checked" : "") +
      " />" +
      "<span>Compare</span>" +
      "</label>" +
      "</div></div>"
    );
  }

  function renderCatalogGrid(devices) {
    const gridEl = $("catalog-devices-grid");
    if (!gridEl) return;
    if (!devices.length) {
      gridEl.innerHTML =
        '<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">No devices match the current filters.</div>';
      return;
    }
    gridEl.innerHTML = devices.map(catalogCardHtml).join("");

    // Wire comparison checkboxes (max 2).
    gridEl.querySelectorAll(".catalog-compare-checkbox").forEach(function (cb) {
      cb.addEventListener("change", function () {
        const id = cb.getAttribute("data-device-id");
        if (cb.checked) {
          if (catalogCompare.length >= 2) {
            cb.checked = false;
            showToast("Compare exactly 2 devices \u2014 deselect one first.", true);
            return;
          }
          if (catalogCompare.indexOf(id) === -1) catalogCompare.push(id);
        } else {
          catalogCompare = catalogCompare.filter(function (i) {
            return i !== id;
          });
        }
        // Reflect selection style on the card.
        const card = cb.closest(".catalog-card");
        if (card) {
          const selected = cb.checked;
          card.classList.toggle("border-emerald-500/70", selected);
          card.classList.toggle("ring-1", selected);
          card.classList.toggle("ring-emerald-500/40", selected);
          card.classList.toggle("border-slate-800", !selected);
        }
        renderCompareBar();
      });
    });

    // Open the device detail modal when a catalog card is clicked (delegated to
    // the card so the compare checkbox and button do not trigger it).
    gridEl.addEventListener("click", function (e) {
      if (e.target.closest(".catalog-compare-checkbox") || e.target.closest(".catalog-compare-btn"))
        return;
      const card = e.target.closest(".catalog-card");
      if (!card) return;
      const id = card.getAttribute("data-device-id");
      const name = card.getAttribute("data-device-name");
      const brand = card.getAttribute("data-device-brand");
      const type = card.getAttribute("data-device-type");
      if (window.__reviews && typeof window.__reviews.openDevice === "function") {
        window.__reviews.openDevice(id, name, brand, type);
      }
    });

    if (window.lucide) window.lucide.createIcons();
  }

  function renderCatalogPagination(data) {
    const labelEl = $("catalog-pagination-label");
    const prevEl = $("catalog-prev");
    const nextEl = $("catalog-next");
    if (labelEl) {
      labelEl.textContent =
        "Page " +
        data.page +
        " of " +
        (data.totalPages || 1) +
        " \u2014 " +
        data.total +
        " devices";
    }
    if (prevEl) prevEl.disabled = Number(data.page) <= 1;
    if (nextEl) nextEl.disabled = Number(data.page) >= Number(data.totalPages || 1);
  }

  function renderCompareBar() {
    const barEl = $("catalog-compare-bar");
    const labelEl = $("catalog-compare-label");
    const btnEl = $("catalog-compare-btn");
    if (!barEl || !labelEl || !btnEl) return;

    if (catalogCompare.length === 0) {
      barEl.classList.add("hidden");
      return;
    }
    barEl.classList.remove("hidden");
    labelEl.textContent =
      catalogCompare.length === 1
        ? "1 device selected \u2014 pick one more to compare."
        : "2 devices selected. Ready to compare.";
    btnEl.disabled = catalogCompare.length !== 2;
  }

  async function runComparison() {
    const container = $("catalog-compare-view");
    const btnEl = $("catalog-compare-btn");
    if (!container || catalogCompare.length !== 2) return;

    container.classList.remove("hidden");
    container.innerHTML =
      '<div class="flex flex-col items-center justify-center py-10 text-slate-500">' +
      '<div class="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500 mb-2"></div>' +
      '<p class="text-xs font-medium">Comparing devices\u2026</p></div>';

    if (btnEl) btnEl.disabled = true;

    try {
      const res = await fetch(
        "/api/catalog/compare?ids=" + encodeURIComponent(catalogCompare.join(",")),
      );
      const data = await res.json();
      if (!data.success) {
        container.innerHTML =
          '<div class="text-center py-8 text-rose-400 text-xs font-semibold">' +
          escAttr(data.error || "Comparison failed") +
          "</div>";
        return;
      }
      renderComparison(container, data);
    } catch (err) {
      console.error("Comparison error:", err);
      container.innerHTML =
        '<div class="text-center py-8 text-rose-400 text-xs font-semibold">Comparison failed.</div>';
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  // Compare rows of matching spec labels. "Higher is better" for VRAM, RAM,
  // storage, TDP (interpreted as power headroom); MSRP lower is better. The
  // tier columns use the tier ordering maps returned by the API. Superior
  // cells render with the emerald highlight (test-id superior-cell).
  function renderComparison(container, data) {
    const left = data.left;
    const right = data.right;
    const gpuOrder = data.gpuTierOrder || {};
    const cpuOrder = data.cpuTierOrder || {};

    // GPU/CPU tiers use the ordering maps: higher tier index wins.
    const gpuCmp = (gpuOrder[right.specs.gpuTier] || 0) - (gpuOrder[left.specs.gpuTier] || 0);
    const cpuCmp = (cpuOrder[right.specs.cpuTier] || 0) - (cpuOrder[left.specs.cpuTier] || 0);

    const headerNames =
      '<th class="p-3 text-center text-xs font-bold text-white border-l border-slate-800">' +
      escAttr(left.name) +
      "</th>" +
      '<th class="p-3 text-center text-xs font-bold text-white border-l border-slate-800">' +
      escAttr(right.name) +
      "</th>";

    const row = function (label, lVal, rVal, cmp, style) {
      const lCell =
        cmp === -1
          ? '<td class="p-3 text-center text-xs text-slate-300 ' +
            (style || "") +
            ' border-l border-slate-800 bg-slate-900/60">' +
            '<span data-testid="superior-cell" class="text-emerald-300 bg-emerald-500/10 border border-emerald-500/40 rounded-md px-2 py-0.5 inline-block">' +
            escAttr(lVal) +
            "</span></td>"
          : '<td class="p-3 text-center text-xs text-slate-300 border-l border-slate-800">' +
            escAttr(lVal) +
            "</td>";
      const rCell =
        cmp === 1
          ? '<td class="p-3 text-center text-xs text-slate-300 border-l border-slate-800 bg-slate-900/60">' +
            '<span data-testid="superior-cell" class="text-emerald-300 bg-emerald-500/10 border border-emerald-500/40 rounded-md px-2 py-0.5 inline-block">' +
            escAttr(rVal) +
            "</span></td>"
          : '<td class="p-3 text-center text-xs text-slate-300 border-l border-slate-800">' +
            escAttr(rVal) +
            "</td>";
      return (
        "<tr>" +
        '<td class="p-3 font-semibold text-slate-400 text-xs w-40">' +
        label +
        "</td>" +
        lCell +
        rCell +
        "</tr>"
      );
    };

    const tierLabel = function (t, labels) {
      return (labels && labels[t]) || t || "unclassified";
    };
    const gb = function (v) {
      return v == null ? "N/A" : v + " GB";
    };

    container.innerHTML =
      '<div class="rounded-xl border border-emerald-500/30 bg-slate-950/60 overflow-x-auto">' +
      '<table data-testid="device-compare-table" class="w-full border-collapse text-left">' +
      '<thead class="bg-slate-900/80 border-b border-slate-800">' +
      '<tr><th class="p-3 text-xs font-semibold text-slate-400 w-40">Specification</th>' +
      headerNames +
      "</tr>" +
      "</thead>" +
      '<tbody class="divide-y divide-slate-800/60">' +
      row(
        "Brand",
        left.brand,
        right.brand,
        left.brand === right.brand ? 0 : left.brand < right.brand ? -1 : 1,
      ) +
      row("Type", left.type, right.type, left.type === right.type ? 0 : 0) +
      row("CPU", left.specs.cpuModel, right.specs.cpuModel, 0) +
      row("GPU", left.specs.gpuModel, right.specs.gpuModel, 0) +
      row(
        "CPU Tier",
        tierLabel(left.specs.cpuTier, CPU_TIER_LABELS),
        tierLabel(right.specs.cpuTier, CPU_TIER_LABELS),
        cpuCmp,
      ) +
      row(
        "GPU Tier",
        tierLabel(left.specs.gpuTier, GPU_TIER_LABELS),
        tierLabel(right.specs.gpuTier, GPU_TIER_LABELS),
        gpuCmp,
      ) +
      row("VRAM", gb(left.specs.gpuVramGb), gb(right.specs.gpuVramGb), gpuVramBetter(left, right)) +
      row("RAM", gb(left.specs.ramGb), gb(right.specs.ramGb), ramBetter(left, right)) +
      row(
        "Storage",
        gb(left.specs.storageGb),
        gb(right.specs.storageGb),
        storageBetter(left, right),
      ) +
      row(
        "TDP (Watts)",
        left.specs.tdpWatts != null ? left.specs.tdpWatts + " W" : "N/A",
        right.specs.tdpWatts != null ? right.specs.tdpWatts + " W" : "N/A",
        0,
      ) +
      row("MSRP", formatMoney(left.msrp), formatMoney(right.msrp), left.msrp - right.msrp) +
      "</tbody></table></div>";

    function gpuVramBetter(a, b) {
      const la = a.specs.gpuVramGb;
      const ra = b.specs.gpuVramGb;
      return (ra || 0) - (la || 0);
    }
    function ramBetter(a, b) {
      const la = a.specs.ramGb;
      const ra = b.specs.ramGb;
      return (ra || 0) - (la || 0);
    }
    function storageBetter(a, b) {
      const la = a.specs.storageGb;
      const ra = b.specs.storageGb;
      return (ra || 0) - (la || 0);
    }
  }

  // -------------------------------------------------------------------------
  // Custom Builder estimate
  // -------------------------------------------------------------------------

  function renderBuilderEstimate() {
    const resultEl = $("builder-cat-result");
    if (!resultEl) return;

    const gpuName = $("builder-cat-gpu")?.value;
    const cpuName = $("builder-cat-cpu")?.value;
    const ramName = $("builder-cat-ram")?.value;
    const storageName = $("builder-cat-storage")?.value;
    const psuName = $("builder-cat-psu")?.value;
    const caseName = $("builder-cat-case")?.value;

    const selected = [gpuName, cpuName, ramName, storageName, psuName, caseName].filter(Boolean);
    if (selected.length === 0) {
      resultEl.innerHTML =
        '<p class="text-xs text-slate-500">Select components above to see the estimated configuration summary.</p>';
      return;
    }

    // Estimate TDP / wattage from the parts catalog if available.
    const findSpec = function (list, name, key) {
      if (!Array.isArray(list) || !name) return null;
      const item = list.find(function (i) {
        return i.name === name;
      });
      return item && item.specs ? item.specs[key] : null;
    };
    const gpuVram = findSpec(builderComponents?.gpus, gpuName, "vramGb");
    const ramGb = findSpec(
      builderComponents?.ramKits || builderComponents?.ram || builderComponents?.memory,
      ramName,
      "ramGb",
    );
    const storageGb = findSpec(
      builderComponents?.storageDrives || builderComponents?.storage,
      storageName,
      "capacityGb",
    );
    const psuWatt = findSpec(builderComponents?.psus, psuName, "wattage");
    const cpuCores = findSpec(builderComponents?.cpus, cpuName, "cores");

    const rows = [
      ["GPU", gpuName, gpuVram != null ? gpuVram + " GB VRAM" : ""],
      ["CPU", cpuName, cpuCores != null ? cpuCores + " cores" : ""],
      ["RAM", ramName, ramGb != null ? ramGb + " GB" : ""],
      ["Storage", storageName, storageGb != null ? storageGb + " GB" : ""],
      ["PSU", psuName, psuWatt != null ? psuWatt + " W" : ""],
      ["Case", caseName, ""],
    ].filter(function (r) {
      return r[1];
    });

    resultEl.innerHTML =
      '<div class="space-y-2">' +
      rows
        .map(function (r) {
          return (
            '<div class="flex items-center justify-between gap-2 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-1.5">' +
            '<span class="text-[11px] font-bold text-slate-400">' +
            escAttr(r[0]) +
            "</span>" +
            '<span class="text-[11px] font-semibold text-slate-200 truncate max-w-[200px]">' +
            escAttr(r[1]) +
            (r[2] ? ' <span class="text-slate-500">(' + escAttr(r[2]) + ")</span>" : "") +
            "</span>" +
            "</div>"
          );
        })
        .join("") +
      '<p class="text-[11px] text-slate-500 pt-1">' +
      "Estimated configuration highlights " +
      selected.length +
      " selected component" +
      (selected.length > 1 ? "s" : "") +
      "." +
      " Save the final build from the My Devices tab to persist it to your fleet.</p>" +
      (window.__deals && typeof window.__deals.buildPriceSparkline === "function" ? "" : "") +
      "</div>";
  }

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------
  function renderReviews() {
    const listEl = $("devices-reviews-list");
    if (!listEl) return;
    if (!REVIEWS.length) {
      listEl.innerHTML =
        '<div class="text-center py-10 text-slate-500 text-xs">Editorial hardware reviews land here as the catalog grows.</div>';
      return;
    }
    listEl.innerHTML = REVIEWS.map(function (review) {
      const tags = (review.tags || [])
        .map(function (t) {
          return (
            '<span class="px-2 py-0.5 rounded-md bg-slate-800/90 border border-slate-700 text-[10px] font-bold text-slate-300">' +
            escAttr(t) +
            "</span>"
          );
        })
        .join(" ");
      return (
        '<div data-testid="devices-review" class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-2">' +
        '<div class="flex flex-wrap items-center justify-between gap-2">' +
        '<h4 class="text-sm font-bold text-white">' +
        escAttr(review.title) +
        "</h4>" +
        '<span class="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[11px] font-black">' +
        review.rating.toFixed(1) +
        " / 10</span>" +
        "</div>" +
        '<p class="text-xs text-slate-300 leading-relaxed">\u201C' +
        escAttr(review.verdict) +
        "\u201D</p>" +
        '<div class="flex flex-wrap items-center gap-1.5">' +
        tags +
        "</div>" +
        '<p class="text-[10px] text-slate-500 font-semibold">\u2014 ' +
        escAttr(review.author) +
        "</p>" +
        "</div>"
      );
    }).join("");
  }

  // -------------------------------------------------------------------------
  // Wiring & init
  // -------------------------------------------------------------------------
  function wireEvents() {
    // Sub-tab buttons
    document.querySelectorAll(".devices-tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTab(btn.getAttribute("data-devices-tab") || "overview");
      });
    });

    // Overview quick links switch tabs
    document.querySelectorAll("[data-devices-goto]").forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        setTab(link.getAttribute("data-devices-goto") || "overview");
      });
    });

    // Catalog filter apply/reset
    const applyBtn = $("catalog-filter-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", function () {
        catalogState.type = $("catalog-filter-type")?.value || "";
        catalogState.brand = $("catalog-filter-brand")?.value || "";
        catalogState.gpuTier = $("catalog-filter-gputier")?.value || "";
        catalogState.priceMin = $("catalog-filter-price-min")?.value || "";
        catalogState.priceMax = $("catalog-filter-price-max")?.value || "";
        catalogState.ramMin = $("catalog-filter-ram")?.value || "";
        catalogState.storageMin = $("catalog-filter-storage")?.value || "";
        catalogState.page = 1;
        fetchCatalog();
      });
    }
    const resetBtn = $("catalog-filter-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        catalogState = {
          type: "",
          brand: "",
          gpuTier: "",
          priceMin: "",
          priceMax: "",
          ramMin: "",
          storageMin: "",
          page: 1,
          pageSize: 12,
          totalPages: 1,
        };
        ["catalog-filter-type", "catalog-filter-brand", "catalog-filter-gputier"].forEach(
          function (id) {
            const el = $(id);
            if (el) el.value = "";
          },
        );
        [
          "catalog-filter-price-min",
          "catalog-filter-price-max",
          "catalog-filter-ram",
          "catalog-filter-storage",
        ].forEach(function (id) {
          const el = $(id);
          if (el) el.value = "";
        });
        fetchCatalog();
      });
    }

    // Pagination
    const prevBtn = $("catalog-prev");
    const nextBtn = $("catalog-next");
    if (prevBtn) {
      prevBtn.addEventListener("click", function () {
        if (catalogState.page > 1) {
          catalogState.page -= 1;
          fetchCatalog();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        if (catalogState.page < catalogState.totalPages) {
          catalogState.page += 1;
          fetchCatalog();
        }
      });
    }

    // Comparison button
    const compareBtn = $("catalog-compare-btn");
    if (compareBtn) {
      compareBtn.addEventListener("click", runComparison);
    }

    // My Devices actions (delegated)
    const myListEl = $("devices-my-list");
    if (myListEl) {
      myListEl.addEventListener("click", function (e) {
        const primaryBtn = e.target.closest('[data-testid="devices-set-primary"]');
        if (primaryBtn) {
          setPrimary(primaryBtn.getAttribute("data-device-id"));
          return;
        }
        const deleteBtn = e.target.closest('[data-testid="devices-delete"]');
        if (deleteBtn) {
          deleteDevice(deleteBtn.getAttribute("data-device-id"));
        }
      });
    }

    // Add Device opens the shared fleet modal (exposed by app.js).
    const addBtn = $("devices-my-add");
    if (addBtn) {
      addBtn.addEventListener("click", function () {
        if (window.openFleetModal && typeof window.openFleetModal === "function") {
          window.openFleetModal();
        } else {
          window.location.hash = "#/fleet";
        }
      });
    }

    // Custom builder estimate
    const estimateBtn = $("builder-cat-estimate");
    if (estimateBtn) {
      estimateBtn.addEventListener("click", renderBuilderEstimate);
    }
  }

  function init() {
    wireEvents();
    // Default to the Overview tab on first load.
    if (!currentTab || !document.querySelector(".devices-tab-btn.active")) {
      setTab("overview");
    } else {
      setTab(currentTab);
    }
  }

  window.__devices = { init: init, setTab: setTab };

  // If the page is already wired (e.g. a re-navigation), re-render current tab.
  document.addEventListener("DOMContentLoaded", function () {
    if (window.location.hash.indexOf("#/devices") === 0) {
      setTab("overview");
    }
  });
})();
