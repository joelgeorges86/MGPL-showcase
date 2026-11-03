/* MGPL Universal Multi-Store Wishlist (FEAT-0158)
 *
 * Sprint 25.1 — Cross-Platform Price Comparison & Target Threshold Alerts.
 *
 * Self-contained module loaded after analytics.js and before app.js. Uses the
 * same API_BASE convention and window.__offlineHelpers.apiFetch for network
 * calls so wishlist data is cached offline via IndexedDB.
 *
 * Exposes window.__wishlist with:
 *   - init()            -> fetch + render wishlist overview & game grid
 *   - addGame()         -> POST /api/wishlist (upsert with target threshold)
 *   - removeGame(id)    -> DELETE /api/wishlist/:gameId
 *   - updateThreshold() -> POST /api/wishlist to update a target price
 *   - compareStores(id) -> GET /api/wishlist/compare/:gameId (modal)
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

  function esc(value) {
    var amp = String.fromCharCode(38) + "amp;";
    var lt = String.fromCharCode(38) + "lt;";
    var gt = String.fromCharCode(38) + "gt;";
    var quot = String.fromCharCode(38) + "quot;";
    var apos = String.fromCharCode(38) + "#39;";
    return String(value == null ? "" : value)
      .replace(/&/g, amp)
      .replace(/</g, lt)
      .replace(/>/g, gt)
      .replace(/"/g, quot)
      .replace(/'/g, apos);
  }

  function fmtMoney(value) {
    var n = Number(value);
    if (isNaN(n)) return "—";
    return "$" + n.toFixed(2);
  }

  function showToast(message, isError) {
    if (typeof window.showToast === "function") {
      window.showToast(message, isError);
    }
  }

  // ---- Overview stats ----------------------------------------------------
  function renderOverview(items) {
    var totalEl = document.getElementById("wishlist-total-games");
    var triggeredEl = document.getElementById("wishlist-triggered-count");
    var bestStoreEl = document.getElementById("wishlist-best-store");
    var avgSavingsEl = document.getElementById("wishlist-avg-savings");
    var totalValueEl = document.getElementById("wishlist-total-value");

    var total = items.length;
    var triggered = items.filter(function (i) {
      return Number(i.isTriggered) === 1;
    }).length;

    // Best store = store with the most tracked entries.
    var storeCounts = {};
    items.forEach(function (i) {
      var s = i.bestStore || "Unknown";
      storeCounts[s] = (storeCounts[s] || 0) + 1;
    });
    var bestStore = "—";
    var bestCount = 0;
    Object.keys(storeCounts).forEach(function (s) {
      if (storeCounts[s] > bestCount) {
        bestCount = storeCounts[s];
        bestStore = s;
      }
    });

    // Avg savings = mean discount off regular price across tracked entries.
    var savingsPct = 0;
    var priced = 0;
    items.forEach(function (i) {
      var reg = Number(i.currentBestPrice);
      var low = Number(i.historicalLow);
      if (reg > 0 && low > 0) {
        savingsPct += Math.max(0, ((reg - low) / reg) * 100);
        priced++;
      }
    });
    var avgSavings = priced ? Math.round(savingsPct / priced) : 0;

    // Total value = sum of current best prices.
    var totalValue = items.reduce(function (sum, i) {
      return sum + (Number(i.currentBestPrice) || 0);
    }, 0);

    if (totalEl) totalEl.textContent = total;
    if (triggeredEl) triggeredEl.textContent = triggered;
    if (bestStoreEl) bestStoreEl.textContent = bestStore;
    if (avgSavingsEl) avgSavingsEl.textContent = avgSavings + "%";
    if (totalValueEl) totalValueEl.textContent = fmtMoney(totalValue);
  }

  // ---- Inline SVG price trend sparkline ----------------------------------
  // Deterministic 30-point series derived from the gameId so it is stable
  // across renders without any external network dependency.
  function buildSparkline(gameId) {
    var hash = 0;
    var seed = gameId || "unknown";
    for (var i = 0; i < seed.length; i++) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    var points = [];
    var base = 30 + (Math.abs(hash) % 40);
    for (var p = 0; p < 30; p++) {
      var wobble = ((Math.abs(hash + p * 131) % 20) - 10) / 100;
      points.push(Math.round(base * (1 + wobble) * 100) / 100);
    }
    var min = Math.min.apply(null, points);
    var max = Math.max.apply(null, points);
    var range = max - min || 1;
    var W = 200;
    var H = 40;
    var coords = points.map(function (v, idx) {
      var x = (idx / (points.length - 1)) * W;
      var y = H - ((v - min) / range) * (H - 6) - 3;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var line = coords.join(" ");
    var area = "0," + H + " " + line + " " + W + "," + H;
    return (
      '<svg class="w-full h-12 overflow-visible" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" preserveAspectRatio="none" role="img" aria-label="Price trend sparkline">' +
      '<polygon points="' +
      area +
      '" fill="rgba(99,102,241,0.15)"></polygon>' +
      '<polyline points="' +
      line +
      '" fill="none" stroke="#818cf8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
      '<circle cx="' +
      coords[coords.length - 1].split(",")[0] +
      '" cy="' +
      coords[coords.length - 1].split(",")[1] +
      '" r="2.5" fill="#a5b4fc"></circle>' +
      "</svg>"
    );
  }

  // ---- DRM badge helpers -------------------------------------------------
  function drmBadge(drmType) {
    var t = String(drmType || "");
    if (t.indexOf("DRM-Free") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[10px] font-bold whitespace-nowrap">🟢 DRM-Free</span>';
    if (t.indexOf("Steamworks") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-bold whitespace-nowrap">🔵 Steamworks</span>';
    if (t.indexOf("Epic") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-300 text-[10px] font-bold whitespace-nowrap">⚫ Epic DRM</span>';
    if (t.indexOf("Ubisoft") !== -1 || t.indexOf("EA") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 text-[10px] font-bold whitespace-nowrap">🟣 Ubisoft/EA</span>';
    if (t.indexOf("Xbox") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-teal-500/15 text-teal-300 text-[10px] font-bold whitespace-nowrap">⬛ Xbox App</span>';
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-300 text-[10px] font-bold whitespace-nowrap">⬛ Console</span>';
  }

  function moddingPill(moddingStatus) {
    var s = String(moddingStatus || "");
    if (s.indexOf("Full") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[10px] font-bold whitespace-nowrap">🟢 Full</span>';
    if (s.indexOf("Partial") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[10px] font-bold whitespace-nowrap">🟡 Partial</span>';
    if (s.indexOf("Restricted") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[10px] font-bold whitespace-nowrap">🔴 Restricted</span>';
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[10px] font-bold whitespace-nowrap">🔴 Locked</span>';
  }

  function offlinePill(offlineStatus) {
    var s = String(offlineStatus || "");
    if (s.indexOf("Native Offline") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[10px] font-bold whitespace-nowrap">✓ Native Offline</span>';
    if (s.indexOf("Console Offline") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-bold whitespace-nowrap">✓ Console Offline</span>';
    if (s.indexOf("Token") !== -1)
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[10px] font-bold whitespace-nowrap">⚠ Offline Token</span>';
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[10px] font-bold whitespace-nowrap">✕ Online Only</span>';
  }

  // ---- Moddability & offline readiness section ---------------------------
  function buildModStatus(item, slug) {
    var mod = item.moddability || {};
    var isModdable = !!mod.isModdable;
    var count = Number(mod.totalModsCount) || 0;
    var nexusUrl = mod.nexusUrl || "";
    var offline = "Native Offline";
    var comparisons = Array.isArray(item.storeComparisons) ? item.storeComparisons : [];
    if (comparisons.length) {
      offline = comparisons[0].offlineStatus || offline;
    }
    var offlineReady =
      offline.indexOf("Native Offline") !== -1 || offline.indexOf("Console Offline") !== -1;

    var modHtml;
    if (isModdable) {
      modHtml =
        '<div class="flex items-center gap-2 flex-wrap">' +
        '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[10px] font-bold">🟢 Moddable — ' +
        count.toLocaleString() +
        " Nexus Mods</span>" +
        (nexusUrl
          ? '<a href="' +
            esc(nexusUrl) +
            '" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 text-[10px] font-bold transition-colors">🔗 Open Nexus Mods Community Hub ↗</a>'
          : "") +
        "</div>";
    } else {
      modHtml =
        '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-400 text-[10px] font-bold">No Nexus Mods Hub</span>';
    }

    var offlineHtml = offlineReady
      ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[10px] font-bold">✓ Offline Play Ready</span>'
      : '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[10px] font-bold">⚠ Offline Play Limited</span>';

    return (
      '<div class="wishlist-mod-status mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-2 space-y-1.5" id="wishlist-mod-status-' +
      slug +
      '">' +
      '<div class="flex items-center justify-between gap-2 flex-wrap">' +
      modHtml +
      offlineHtml +
      "</div>" +
      "</div>"
    );
  }

  // ---- Multi-store price & DRM matrix table ------------------------------
  function buildMatrixTable(item, _slug) {
    var comparisons = Array.isArray(item.storeComparisons) ? item.storeComparisons : [];
    if (!comparisons.length) return "";
    var bestPrice = Infinity;
    comparisons.forEach(function (o) {
      if (Number(o.currentPrice) < bestPrice) bestPrice = Number(o.currentPrice);
    });

    var rows = comparisons
      .map(function (o) {
        var storeName = o.storeName || "Unknown";
        var currentPrice = Number(o.currentPrice);
        var regularPrice = Number(o.regularPrice);
        var isBest = currentPrice === bestPrice;
        var url = o.url || "";
        var isAuthorized = !!o.isAuthorized;
        var storeCell = url
          ? '<a href="' +
            esc(url) +
            '" target="_blank" rel="noopener noreferrer" class="text-indigo-300 hover:text-indigo-200 underline decoration-indigo-500/40 underline-offset-2">' +
            esc(storeName) +
            "</a>"
          : esc(storeName);
        var tag = isAuthorized
          ? '<span class="text-[9px] font-black uppercase tracking-wider text-amber-400">🔑 Authorized</span>'
          : '<span class="text-[9px] font-black uppercase tracking-wider text-slate-500">Direct</span>';
        var savings =
          !isNaN(regularPrice) && regularPrice > 0 && !isNaN(currentPrice)
            ? Math.max(0, Math.round(((regularPrice - currentPrice) / regularPrice) * 100))
            : 0;
        var bestBadge = isBest
          ? ' <span class="text-[9px] font-black uppercase text-emerald-400">🔥 Best Deal</span>'
          : "";
        return (
          '<tr class="border-b border-slate-800/60 last:border-0">' +
          '<td class="p-2 text-xs text-slate-300 font-semibold">' +
          storeCell +
          "<div>" +
          tag +
          "</div></td>" +
          '<td class="p-2 text-xs text-right">' +
          '<div class="font-bold ' +
          (isBest ? "text-emerald-400" : "text-slate-200") +
          '">' +
          fmtMoney(currentPrice) +
          bestBadge +
          "</div>" +
          '<div class="text-[10px] text-slate-500">' +
          fmtMoney(regularPrice) +
          (savings > 0 ? ' · <span class="text-amber-400">' + savings + "% off</span>" : "") +
          "</div>" +
          "</td>" +
          '<td class="p-2 text-right">' +
          drmBadge(o.drmType) +
          "</td>" +
          '<td class="p-2 text-right">' +
          moddingPill(o.moddingStatus) +
          "</td>" +
          '<td class="p-2 text-right">' +
          offlinePill(o.offlineStatus) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    return (
      '<div class="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg overflow-hidden">' +
      '<div class="px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-400 border-b border-slate-800">Store Price & DRM Matrix</div>' +
      '<div class="overflow-x-auto">' +
      '<table class="wishlist-matrix-table w-full text-left">' +
      '<thead><tr class="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800">' +
      '<th class="p-2">Storefront / Distributor</th><th class="p-2 text-right">Price & Savings</th><th class="p-2 text-right">DRM Type</th><th class="p-2 text-right">Modding</th><th class="p-2 text-right">Offline</th>' +
      "</tr></thead>" +
      "<tbody>" +
      rows +
      "</tbody>" +
      "</table>" +
      "</div>" +
      "</div>"
    );
  }

  // ---- Available expansions & DLC catalog --------------------------------
  function buildDlcTable(item, _slug) {
    var dlcs = Array.isArray(item.dlcs) ? item.dlcs : [];
    if (!dlcs.length) return "";
    var rows = dlcs
      .map(function (d) {
        var url = d.url || "";
        var name = d.name || "DLC";
        var buyCell = url
          ? '<a href="' +
            esc(url) +
            '" target="_blank" rel="noopener noreferrer" class="text-indigo-300 hover:text-indigo-200 underline decoration-indigo-500/40 underline-offset-2">Buy ↗</a>'
          : "—";
        return (
          '<tr class="border-b border-slate-800/60 last:border-0">' +
          '<td class="p-2 text-xs text-slate-200 font-semibold">' +
          esc(name) +
          "</td>" +
          '<td class="p-2 text-xs text-slate-400">' +
          esc(d.type || "DLC") +
          "</td>" +
          '<td class="p-2 text-xs text-right font-bold text-emerald-400">' +
          fmtMoney(d.bestPrice) +
          "</td>" +
          '<td class="p-2 text-xs text-right text-slate-500">' +
          fmtMoney(d.regularPrice) +
          "</td>" +
          '<td class="p-2 text-xs text-right text-amber-400">' +
          (isNaN(Number(d.discountPercent)) ? "0" : Number(d.discountPercent)) +
          "%</td>" +
          '<td class="p-2 text-xs text-right text-slate-300">' +
          esc(d.bestStore || "—") +
          "</td>" +
          '<td class="p-2 text-xs text-right">' +
          buyCell +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    return (
      '<div class="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg overflow-hidden">' +
      '<div class="px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-400 border-b border-slate-800">Available Expansions & DLCs</div>' +
      '<div class="overflow-x-auto">' +
      '<table class="wishlist-dlc-table w-full text-left">' +
      '<thead><tr class="text-[9px] uppercase tracking-wider text-slate-500 border-b border-slate-800">' +
      '<th class="p-2">Name</th><th class="p-2">Type</th><th class="p-2 text-right">Best Price</th><th class="p-2 text-right">Regular</th><th class="p-2 text-right">Discount</th><th class="p-2 text-right">Store</th><th class="p-2 text-right">Link</th>' +
      "</tr></thead>" +
      "<tbody>" +
      rows +
      "</tbody>" +
      "</table>" +
      "</div>" +
      "</div>"
    );
  }

  // ---- Game card ---------------------------------------------------------
  function buildCard(item) {
    var gameId = item.gameId || item.id || "";
    var title = item.title || "Untitled Game";
    var cover = item.coverImage || "";
    var target = Number(item.targetPrice);
    var best = Number(item.currentBestPrice);
    var store = item.bestStore || "—";
    var low = Number(item.historicalLow);
    var triggered = Number(item.isTriggered) === 1;
    var atAllTimeLow = !isNaN(low) && low > 0 && !isNaN(best) && best <= low;
    var isAuthorizedBest = !!item.isAuthorizedBest;
    var slug =
      String(gameId || title)
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase() || "game";

    var coverHtml = cover
      ? '<img src="' +
        esc(cover) +
        '" onerror="this.onerror=null; this.parentElement.innerHTML=\'<div class=\\"w-full h-full bg-slate-900 flex items-center justify-center p-2 text-center text-xs text-slate-400 font-semibold\\">' +
        esc(title) +
        '</div>\';" class="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="' +
        esc(title) +
        '" />'
      : '<div class="w-full h-full bg-slate-900 flex items-center justify-center p-2 text-center text-xs text-slate-400 font-semibold">' +
        esc(title) +
        "</div>";

    var triggeredBadge = triggered
      ? '<span class="absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-emerald-500/90 text-white text-[10px] font-black tracking-wider uppercase shadow-lg">🚨 Below Target</span>'
      : '<span class="absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-slate-950/80 backdrop-blur text-[10px] font-black tracking-wider uppercase text-slate-300 border border-slate-700">Watching</span>';

    var targetText = !isNaN(target) && target > 0 ? fmtMoney(target) : "—";

    return (
      '<div class="wishlist-card bg-slate-900/40 border border-slate-800 hover:border-indigo-500/40 rounded-2xl p-4 flex flex-col justify-between shadow-xl transition-all hover:scale-[1.01] group" data-game-id="' +
      esc(gameId) +
      '" data-game-title="' +
      esc(title) +
      '" data-triggered="' +
      (triggered ? "1" : "0") +
      '" data-at-low="' +
      (atAllTimeLow ? "1" : "0") +
      '" data-authorized="' +
      (isAuthorizedBest ? "1" : "0") +
      '">' +
      "<div>" +
      '<div class="aspect-[3/4] bg-slate-950 rounded-xl mb-4 overflow-hidden flex items-center justify-center relative shadow-inner">' +
      coverHtml +
      triggeredBadge +
      "</div>" +
      '<h3 class="font-bold text-white text-sm mb-1.5 truncate group-hover:text-indigo-400 transition-colors" title="' +
      esc(title) +
      '">' +
      esc(title) +
      "</h3>" +
      '<div class="space-y-1.5 text-xs text-slate-400">' +
      '<div class="flex items-center justify-between"><span>Target</span><strong class="text-slate-200 font-semibold">' +
      targetText +
      "</strong></div>" +
      '<div class="flex items-center justify-between"><span>Best Price</span><strong class="' +
      (triggered ? "text-emerald-400" : "text-white") +
      ' font-semibold">' +
      fmtMoney(best) +
      "</strong></div>" +
      '<div class="flex items-center justify-between"><span>Best Store</span><strong class="text-indigo-300 font-semibold">' +
      esc(store) +
      "</strong></div>" +
      '<div class="flex items-center justify-between"><span>Hist. Low</span><strong class="' +
      (atAllTimeLow ? "text-amber-400" : "text-slate-200") +
      ' font-semibold">' +
      fmtMoney(low) +
      "</strong></div>" +
      "</div>" +
      '<div class="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-2">' +
      buildSparkline(gameId) +
      "</div>" +
      buildModStatus(item, slug) +
      buildMatrixTable(item, slug) +
      buildDlcTable(item, slug) +
      "</div>" +
      '<div class="border-t border-slate-800/60 pt-3 mt-3.5 flex items-center gap-2">' +
      '<button type="button" data-action="compare" class="wishlist-compare-btn flex-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-all flex items-center justify-center gap-1.5">' +
      '<i data-lucide="git-compare" class="w-3.5 h-3.5"></i> Compare' +
      "</button>" +
      '<button type="button" data-action="remove" class="wishlist-remove-btn px-3 py-1.5 rounded-lg bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 text-xs font-bold transition-all flex items-center justify-center gap-1.5" aria-label="Remove ' +
      esc(title) +
      ' from wishlist">' +
      '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i>' +
      "</button>" +
      "</div>" +
      "</div>"
    );
  }

  // Current active filter: all | triggered | lows | authorized
  var activeFilter = "all";

  function applyFilter() {
    var grid = document.getElementById("wishlist-cards-grid");
    if (!grid) return;
    grid.querySelectorAll(".wishlist-card").forEach(function (card) {
      var show = true;
      if (activeFilter === "triggered") {
        show = card.getAttribute("data-triggered") === "1";
      } else if (activeFilter === "lows") {
        show = card.getAttribute("data-at-low") === "1";
      } else if (activeFilter === "authorized") {
        show = card.getAttribute("data-authorized") === "1";
      }
      card.style.display = show ? "" : "none";
    });
  }

  function renderGrid(items) {
    var grid = document.getElementById("wishlist-cards-grid");
    if (!grid) return;

    if (!items.length) {
      grid.innerHTML =
        '<div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-500">' +
        '<i data-lucide="star" class="w-10 h-10 mb-3 text-slate-700"></i>' +
        '<p class="text-sm font-medium">Your wishlist is empty.</p>' +
        '<p class="text-xs text-slate-600 mt-1">Add a game above to start tracking target prices across stores.</p>' +
        "</div>";
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    grid.innerHTML = items.map(buildCard).join("");

    // Wire per-card buttons.
    grid.querySelectorAll(".wishlist-remove-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = btn.closest(".wishlist-card");
        var id = card ? card.getAttribute("data-game-id") : "";
        if (id) removeGame(id);
      });
    });
    grid.querySelectorAll(".wishlist-compare-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = btn.closest(".wishlist-card");
        var id = card ? card.getAttribute("data-game-id") : "";
        if (id) compareStores(id);
      });
    });

    applyFilter();
    if (window.lucide) window.lucide.createIcons();
  }

  // ---- Compare modal -----------------------------------------------------
  function compareStores(gameId) {
    if (!gameId) return;
    apiFetch(API_BASE + "/api/wishlist/compare/" + encodeURIComponent(gameId))
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (!data.success) {
          showToast("Failed to compare prices.", true);
          return;
        }
        // Prefer the enriched storeComparisons payload (FEAT-0158); fall back to
        // the legacy offers array for backward compatibility.
        var comparisons = Array.isArray(data.storeComparisons) ? data.storeComparisons : [];
        var offers = Array.isArray(data.offers) ? data.offers : [];
        var source = comparisons.length ? comparisons : offers;
        var bestPrice = Number(data.bestPrice);
        if (!bestPrice || isNaN(bestPrice)) {
          bestPrice = Infinity;
          source.forEach(function (o) {
            var p = Number(o.currentPrice);
            if (!isNaN(p) && p < bestPrice) bestPrice = p;
          });
        }
        var rows = source
          .map(function (o) {
            var isBest = o.isBest === true || Number(o.currentPrice) === bestPrice;
            var storeName = o.storeName || o.store || "Unknown";
            var currentPrice = Number(o.currentPrice);
            var regularPrice = Number(o.regularPrice);
            var discountPercent = Number(o.discountPercent);
            var hasPrice = o.availability === "real" && isFinite(currentPrice);
            var url = o.url || "";
            var isAuthorized = !!o.isAuthorized;
            var storeCell = url
              ? '<a href="' +
                esc(url) +
                '" target="_blank" rel="noopener noreferrer" class="text-indigo-300 hover:text-indigo-200 underline decoration-indigo-500/40 underline-offset-2">' +
                esc(storeName) +
                "</a>"
              : esc(storeName);
            var availabilityCell = hasPrice
              ? '<span class="text-[9px] text-emerald-400">Observed ' +
                esc(o.observedAt || "") +
                "</span>"
              : '<span class="text-[9px] text-slate-500">No observed price</span>';
            var tag = isAuthorized
              ? '<span class="text-[9px] font-black uppercase tracking-wider text-amber-400">🔑 Authorized</span>'
              : '<span class="text-[9px] font-black uppercase tracking-wider text-slate-500">Direct</span>';
            var drmCell = o.drmType ? drmBadge(o.drmType) : "";
            var modCell = o.moddingStatus ? moddingPill(o.moddingStatus) : "";
            var offlineCell = o.offlineStatus ? offlinePill(o.offlineStatus) : "";
            return (
              '<tr class="border-b border-slate-800/60 last:border-0">' +
              '<td class="p-2.5 text-xs text-slate-300 font-semibold">' +
              storeCell +
              "<div>" +
              tag +
              "</div><div>" +
              availabilityCell +
              "</div></td>" +
              '<td class="p-2.5 text-xs text-slate-400 text-right">' +
              fmtMoney(regularPrice) +
              "</td>" +
              '<td class="p-2.5 text-xs text-right font-bold ' +
              (isBest ? "text-emerald-400" : "text-slate-200") +
              '">' +
              fmtMoney(currentPrice) +
              (isBest
                ? ' <span class="text-[10px] text-emerald-500 font-black uppercase">Best</span>'
                : "") +
              "</td>" +
              '<td class="p-2.5 text-xs text-right text-amber-400">' +
              (isNaN(discountPercent) ? "0" : discountPercent) +
              "% off</td>" +
              (drmCell ? '<td class="p-2.5 text-right">' + drmCell + "</td>" : "") +
              (modCell ? '<td class="p-2.5 text-right">' + modCell + "</td>" : "") +
              (offlineCell ? '<td class="p-2.5 text-right">' + offlineCell + "</td>" : "") +
              "</tr>"
            );
          })
          .join("");
        var modal = document.getElementById("wishlist-compare-modal");

        if (!modal) {
          modal = document.createElement("div");
          modal.id = "wishlist-compare-modal";
          modal.className = "fixed inset-0 z-[100] flex items-center justify-center p-4";
          modal.setAttribute("role", "dialog");
          modal.setAttribute("aria-modal", "true");
          modal.setAttribute("aria-label", "Cross-store price comparison");
          document.body.appendChild(modal);
        }

        var hasEnriched = comparisons.length > 0;
        var headerCells =
          '<th class="p-2.5">Store</th><th class="p-2.5 text-right">Regular</th><th class="p-2.5 text-right">Price</th><th class="p-2.5 text-right">Discount</th>' +
          (hasEnriched
            ? '<th class="p-2.5 text-right">DRM</th><th class="p-2.5 text-right">Modding</th><th class="p-2.5 text-right">Offline</th>'
            : "");
        var colspan = hasEnriched ? 7 : 4;

        modal.innerHTML =
          '<div class="absolute inset-0 bg-black/70" data-close="1"></div>' +
          '<div class="relative bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl p-6">' +
          '<div class="flex items-center justify-between mb-4">' +
          '<h3 class="text-base font-bold text-white flex items-center gap-2"><i data-lucide="git-compare" class="w-4 h-4 text-indigo-400"></i> Store Price Comparison</h3>' +
          '<button type="button" data-close="1" class="text-slate-400 hover:text-white transition-colors" aria-label="Close comparison">&times;</button>' +
          "</div>" +
          '<p class="text-xs text-slate-400 mb-3">Historical low: <strong class="text-amber-400">' +
          fmtMoney(data.historicalLow) +
          '</strong> · Best: <strong class="text-emerald-400">' +
          esc(data.bestStore || "Unavailable") +
          "</strong></p>" +
          '<p class="text-[10px] text-slate-500 mb-3">Data: <strong class="text-slate-300">' +
          esc(data.historyAvailability || "missing") +
          "</strong> · Covered: " +
          esc(
            data.historicalLowPeriod
              ? data.historicalLowPeriod.from + " to " + data.historicalLowPeriod.to
              : "No observed history",
          ) +
          "</p>" +
          '<div class="overflow-x-auto">' +
          '<table class="w-full text-left">' +
          '<thead><tr class="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">' +
          headerCells +
          "</tr></thead>" +
          "<tbody>" +
          (rows ||
            '<tr><td class="p-2.5 text-xs text-slate-500" colspan="' +
              colspan +
              '">No offers available.</td></tr>') +
          "</tbody>" +
          "</table>" +
          "</div>" +
          "</div>";

        modal.querySelectorAll("[data-close]").forEach(function (el) {
          el.addEventListener("click", function () {
            modal.classList.add("hidden");
          });
        });
        modal.classList.remove("hidden");
        if (window.lucide) window.lucide.createIcons();
      })
      .catch(function (err) {
        console.error("Error comparing prices:", err);
        showToast("Failed to compare prices.", true);
      });
  }

  // ---- CRUD --------------------------------------------------------------
  function addGame(gameId, title, targetPrice, coverImage) {
    var payload = {
      gameId: gameId || title,
      title: title,
      targetPrice: Number(targetPrice) || 0,
    };
    if (coverImage) payload.coverImage = coverImage;

    return apiFetch(API_BASE + "/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.success) {
          showToast(data.message || "Added to wishlist.");
          init();
          return data;
        }
        showToast(data.error || "Failed to add to wishlist.", true);
        return data;
      })
      .catch(function (err) {
        console.error("Error adding to wishlist:", err);
        showToast("Failed to add to wishlist.", true);
        return { success: false };
      });
  }

  function removeGame(gameId) {
    if (!gameId) return;
    apiFetch(API_BASE + "/api/wishlist/" + encodeURIComponent(gameId), { method: "DELETE" })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.success) {
          showToast(data.message || "Removed from wishlist.");
          init();
        } else {
          showToast(data.error || "Failed to remove from wishlist.", true);
        }
      })
      .catch(function (err) {
        console.error("Error removing from wishlist:", err);
        showToast("Failed to remove from wishlist.", true);
      });
  }

  function updateThreshold(gameId, title, targetPrice, coverImage) {
    return addGame(gameId, title, targetPrice, coverImage);
  }

  // Sprint 4 (EPIC-DEAL-001): fetch the authenticated user's wishlist status
  // for a single game so the drawer / full game page can render a deterministic
  // "Add" vs "Remove" toggle state.
  function getStatus(gameId) {
    if (!gameId) return Promise.resolve({ success: false, inWishlist: false });
    return apiFetch(API_BASE + "/api/wishlist/status/" + encodeURIComponent(gameId))
      .then(function (res) {
        return res.json();
      })
      .catch(function (err) {
        console.error("Error fetching wishlist status:", err);
        return { success: false, inWishlist: false };
      });
  }

  // ---- Live store price sync (Sprint 32 / FEAT-0166) ---------------------
  // POSTs to the backend proxy which ingests live multi-store pricing from
  // CheapShark (or falls back to deterministic synthesis), then hot-rehydrates
  // the grid and fires browser notifications for any newly-triggered alerts.
  function syncLivePrices() {
    var btn = document.getElementById("btn-sync-live-prices");
    var originalHtml = btn ? btn.innerHTML : "";
    var originalDisabled = btn ? btn.disabled : false;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Syncing...</span>';
      if (window.lucide) window.lucide.createIcons();
    }

    return apiFetch(API_BASE + "/api/wishlist/refresh-prices", { method: "POST" })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data && data.success) {
          var source = data.source === "cheapshark" ? "live" : "synthesis";
          var synced = Number(data.synced) || 0;
          var triggered = Number(data.triggered) || 0;
          showToast(
            "Synced " +
              synced +
              " wishlist item(s) (" +
              source +
              ")" +
              (triggered > 0 ? " · " + triggered + " deal alert(s) triggered!" : "."),
          );
          // Fire browser notifications for newly-triggered alerts.
          if (triggered > 0 && typeof window.notifyDealAlerts === "function") {
            window.notifyDealAlerts();
          }
          // Hot rehydration of the overview + grid.
          init();
        } else {
          showToast((data && data.error) || "Failed to sync live prices.", true);
        }
        return data;
      })
      .catch(function (err) {
        console.error("Error syncing live prices:", err);
        showToast("Failed to sync live prices.", true);
        return { success: false };
      })
      .finally(function () {
        if (btn) {
          btn.disabled = originalDisabled;
          btn.innerHTML = originalHtml;
          if (window.lucide) window.lucide.createIcons();
        }
      });
  }

  // ---- Init --------------------------------------------------------------
  function init() {
    var grid = document.getElementById("wishlist-cards-grid");
    if (grid) {
      grid.innerHTML =
        '<div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">' +
        '<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mb-2"></div>' +
        '<p class="text-sm font-medium">Loading wishlist...</p>' +
        "</div>";
    }

    return apiFetch(API_BASE + "/api/wishlist")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        var items = data.success && Array.isArray(data.wishlist) ? data.wishlist : [];
        renderOverview(items);
        renderGrid(items);
      })
      .catch(function (err) {
        console.error("Error loading wishlist:", err);
        if (grid) {
          grid.innerHTML =
            '<div class="col-span-full text-center py-12 text-rose-400 text-xs font-semibold">Failed to load wishlist.</div>';
        }
      });
  }

  // ---- Search autocomplete ----------------------------------------------
  function wireSearch() {
    var searchInput = document.getElementById("wishlist-game-search");
    var resultsEl = document.getElementById("wishlist-search-results");
    if (!searchInput || !resultsEl) return;

    var debounceTimer = null;
    searchInput.addEventListener("input", function () {
      var q = searchInput.value.trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (!q) {
        resultsEl.classList.add("hidden");
        resultsEl.innerHTML = "";
        return;
      }
      debounceTimer = setTimeout(function () {
        apiFetch(API_BASE + "/api/wishlist/search?q=" + encodeURIComponent(q))
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            var results = data.success && Array.isArray(data.results) ? data.results : [];
            if (!results.length) {
              resultsEl.innerHTML =
                '<div class="px-3 py-2 text-xs text-slate-500">No matching games found.</div>';
            } else {
              resultsEl.innerHTML = results
                .map(function (r) {
                  return (
                    '<button type="button" data-result-id="' +
                    esc(r.gameId) +
                    '" data-result-title="' +
                    esc(r.title) +
                    '" class="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 transition-colors flex items-center justify-between gap-2">' +
                    '<span class="truncate">' +
                    esc(r.title) +
                    "</span>" +
                    '<span class="text-slate-500 shrink-0">' +
                    fmtMoney(r.currentBestPrice) +
                    "</span>" +
                    "</button>"
                  );
                })
                .join("");
            }
            resultsEl.classList.remove("hidden");
            resultsEl.querySelectorAll("[data-result-id]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                searchInput.value = btn.getAttribute("data-result-title");
                searchInput.setAttribute("data-selected-id", btn.getAttribute("data-result-id"));
                resultsEl.classList.add("hidden");
                resultsEl.innerHTML = "";
              });
            });
          })
          .catch(function () {
            resultsEl.classList.add("hidden");
          });
      }, 250);
    });

    document.addEventListener("click", function (e) {
      if (!resultsEl.contains(e.target) && e.target !== searchInput) {
        resultsEl.classList.add("hidden");
      }
    });
  }

  // ---- Filter toggles ----------------------------------------------------
  function wireFilters() {
    var filterBtns = document.querySelectorAll(".wishlist-filter-btn");
    filterBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeFilter = btn.getAttribute("data-filter") || "all";
        filterBtns.forEach(function (b) {
          var isActive = b === btn;
          b.classList.toggle("active", isActive);
          b.classList.toggle("bg-indigo-600", isActive);
          b.classList.toggle("text-white", isActive);
          b.classList.toggle("bg-slate-800", !isActive);
          b.classList.toggle("text-slate-300", !isActive);
        });
        applyFilter();
      });
    });
  }

  function initWishlist() {
    var addBtn = document.getElementById("wishlist-add-btn");
    if (addBtn) {
      addBtn.addEventListener("click", function () {
        var searchInput = document.getElementById("wishlist-game-search");
        var targetInput = document.getElementById("wishlist-target-input");
        var statusEl = document.getElementById("wishlist-add-status");
        var title = searchInput ? searchInput.value.trim() : "";
        var selectedId = searchInput ? searchInput.getAttribute("data-selected-id") : "";
        var target = targetInput ? targetInput.value : "";

        if (!title) {
          if (statusEl) statusEl.textContent = "Please enter a game title.";
          return;
        }
        if (statusEl) statusEl.textContent = "Adding...";
        addGame(selectedId || title, title, target).then(function (data) {
          if (data && data.success) {
            if (searchInput) {
              searchInput.value = "";
              searchInput.removeAttribute("data-selected-id");
            }
            if (targetInput) targetInput.value = "";
            if (statusEl) statusEl.textContent = "";
          } else if (statusEl) {
            statusEl.textContent = "Failed to add game.";
          }
        });
      });
    }

    var refreshBtn = document.getElementById("wishlist-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        init();
      });
    }

    var syncBtn = document.getElementById("btn-sync-live-prices");
    if (syncBtn) {
      syncBtn.addEventListener("click", function () {
        syncLivePrices();
      });
    }

    wireSearch();
    wireFilters();
  }

  // Expose hooks for Playwright E2E tests.
  window.__wishlist = {
    init: init,
    addGame: addGame,
    removeGame: removeGame,
    updateThreshold: updateThreshold,
    compareStores: compareStores,
    getStatus: getStatus,
    renderOverview: renderOverview,
    renderGrid: renderGrid,
    syncLivePrices: syncLivePrices,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWishlist);
  } else {
    initWishlist();
  }
})();
