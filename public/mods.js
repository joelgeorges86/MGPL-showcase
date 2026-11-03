/**
 * Sprint 4 (EPICUX04) — Mods Hub 2.0 (public/mods.js)
 *
 * Adds the rich Mod Detail drawer (Description / Screenshots / Changelog /
 * Dependency Tree tabs), the interactive Load Order Manager (drag-and-drop +
 * keyboard reordering with instant SQLite persistence + undo), and automated
 * file-level conflict warnings on mod cards and inside the load order list.
 *
 * Security contract (EPICSEC01/02/05): every external URL is passed through
 * safeModUrl() (defined in app.js), every rendered string is HTML-escaped, and
 * every error path runs through window.safeToastError before reaching the UI.
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function el(id) {
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

  function safeUrl(raw) {
    if (typeof window.safeModUrl === "function") return window.safeModUrl(raw);
    return null;
  }

  function apiRequest(url, options) {
    if (typeof window.apiFetch === "function") return window.apiFetch(url, options || {});
    return fetch(url, options || {});
  }

  function toast(message, isError) {
    if (window.showToast && typeof window.showToast === "function") {
      window.showToast(message, isError);
    }
  }

  function safeError(err, fallback) {
    if (window.safeToastError && typeof window.safeToastError === "function") {
      return window.safeToastError(err, fallback);
    }
    return fallback;
  }

  function icon(name, className) {
    return `<i data-lucide="${name}" class="${className || "w-4 h-4"}"></i>`;
  }

  // -------------------------------------------------------------------------
  // Mod Detail drawer
  // -------------------------------------------------------------------------

  function openModDetail(gameDomain, modId, modName) {
    const drawer = el("mod-detail-drawer");
    if (!drawer) return;
    const title = el("mod-detail-title");
    if (title) title.textContent = modName || "Mod Details";
    const author = el("mod-detail-author");
    if (author) author.textContent = "Loading author profile…";
    const provider = el("mod-detail-provider");
    if (provider) provider.textContent = gameDomain || "";
    renderDetailLoading();
    switchDetailTab("mod-detail-tab-description");
    if (typeof window.saveFocus === "function") window.saveFocus();
    drawer.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    drawer.addEventListener("keydown", modDetailKeydownHandler);
    const closeBtn = el("mod-detail-close");
    if (closeBtn) closeBtn.focus();
    fetchModDetail(gameDomain, modId);
  }

  function renderDetailLoading() {
    const box = el("mod-detail-description");
    if (box) {
      box.innerHTML =
        '<div class="flex items-center gap-3 text-slate-400 text-sm"><div class="animate-spin rounded-full h-5 w-5 border-b-2 border-amber-500"></div>Loading mod details…</div>';
    }
    ["mod-detail-screenshots", "mod-detail-changelog", "mod-detail-deps"].forEach((id) => {
      const panel = el(id);
      if (panel) panel.innerHTML = "";
    });
  }

  function renderDetailError(message) {
    const box = el("mod-detail-description");
    if (!box) return;
    box.innerHTML = `<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">${esc(
      safeError(message, "Failed to load mod details."),
    )}</div>`;
    ["mod-detail-screenshots", "mod-detail-changelog", "mod-detail-deps"].forEach((id) => {
      const panel = el(id);
      if (panel) panel.innerHTML = "";
    });
  }

  async function fetchModDetail(gameDomain, modId) {
    try {
      const res = await apiRequest(
        `/api/mods/detail?game=${encodeURIComponent(gameDomain)}&modId=${encodeURIComponent(modId)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        renderDetailError(body && body.error ? body.error : "Failed to load mod details.");
        return;
      }
      const detail = await res.json();
      renderModDetail(detail);
    } catch (err) {
      renderDetailError(safeError(err, "Failed to load mod details."));
    }
  }

  function renderModDetail(detail) {
    const title = el("mod-detail-title");
    if (title) title.textContent = detail.modName || "Mod Details";
    const provider = el("mod-detail-provider");
    if (provider) {
      provider.textContent = `${detail.provider || "Community"} · ${detail.category || "General"}`;
    }
    const author = el("mod-detail-author");
    if (author) {
      author.textContent = `by ${
        detail.author && detail.author.handle ? detail.author.handle : "anonymous"
      }`;
    }

    const stats = el("mod-detail-stats");
    if (stats) {
      const d = detail.stats || {};
      stats.innerHTML = [
        statTile(
          "download",
          "Downloads",
          d.downloadsLabel != null
            ? d.downloadsLabel
            : String(detail.downloads != null ? detail.downloads : 0),
        ),
        statTile(
          "users",
          "Active Installs",
          d.installsLabel != null
            ? d.installsLabel
            : String(detail.activeInstalls != null ? detail.activeInstalls : 0),
        ),
        statTile(
          "star",
          "Rating Count",
          String(detail.ratingCount != null ? detail.ratingCount : 0),
        ),
      ].join("");
    }

    const description = el("mod-detail-description");
    if (description) {
      const longText = detail.longDescription || detail.description || "No description provided.";
      const safeSourceUrl = safeUrl(detail.sourceUrl);
      const sourceLink = safeSourceUrl
        ? `<a href="${esc(safeSourceUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 hover:text-amber-300 hover:underline">${icon("external-link", "w-3 h-3")} View on ${esc(detail.sourceDomain || detail.provider || "provider")}</a>`
        : "";
      const installBadge = detail.installed
        ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-2 py-1">${icon("check-circle", "w-3 h-3")} Tracked</span>`
        : `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1">Not tracked</span>`;
      description.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold uppercase tracking-wider">v${esc(detail.version || "1.0.0")}</span>
          ${installBadge}
        </div>
        <p class="text-xs text-slate-300 leading-relaxed whitespace-pre-line">${esc(longText)}</p>
        <div class="flex flex-wrap items-center gap-3 text-[10px] text-slate-500 font-bold">
          <span>Min VRAM: ${detail.minVramGb != null ? esc(String(detail.minVramGb)) + " GB" : "Unknown"}</span>
          <span>Min RAM: ${detail.minRamGb != null ? esc(String(detail.minRamGb)) + " GB" : "Unknown"}</span>
          ${sourceLink}
        </div>
      `;
    }

    const screenshots = el("mod-detail-screenshots");
    if (screenshots) {
      const shots = Array.isArray(detail.screenshots) ? detail.screenshots : [];
      screenshots.innerHTML = shots.length
        ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${shots
            .map(
              (s) =>
                `<div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 flex flex-col items-center justify-center gap-2 min-h-[120px]"><span class="text-slate-600">${icon("image", "w-8 h-8")}</span><p class="text-[10px] text-slate-400 font-bold text-center">${esc(s)}</p></div>`,
            )
            .join("")}</div>`
        : `<p class="text-xs text-slate-500">No screenshots available for this mod.</p>`;
    }

    const changelog = el("mod-detail-changelog");
    if (changelog) {
      const history = Array.isArray(detail.versionHistory) ? detail.versionHistory : [];
      changelog.innerHTML = history.length
        ? `<div class="space-y-3">${history
            .map(
              (v) =>
                `<div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-1"><div class="flex items-center justify-between gap-2"><span class="text-xs font-bold text-amber-400">v${esc(v.version)}</span>${
                  v.releasedAt
                    ? `<span class="text-[10px] text-slate-500 font-bold">${esc(v.releasedAt)}</span>`
                    : ""
                }</div><p class="text-[11px] text-slate-300">${esc(v.changelog || "No changelog entry.")}</p></div>`,
            )
            .join("")}</div>`
        : `<p class="text-xs text-slate-500">No changelog entries available.</p>`;
    }

    const deps = el("mod-detail-deps");
    if (deps) {
      const tree = Array.isArray(detail.dependencyTree) ? detail.dependencyTree : [];
      deps.innerHTML = tree.length
        ? `<div class="space-y-2">${tree.map((node) => renderDepNode(node, 0)).join("")}</div>`
        : `<p class="text-xs text-slate-500">No dependencies. This mod is standalone.</p>`;
    }

    if (window.lucide) window.lucide.createIcons();
  }

  function statTile(iconName, label, value) {
    return `<div class="flex flex-col items-center justify-center gap-0.5 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-2 text-center">
      <span class="text-amber-400">${icon(iconName, "w-3.5 h-3.5")}</span>
      <span class="text-sm font-extrabold text-white">${esc(value)}</span>
      <span class="text-[9px] uppercase tracking-wider text-slate-500 font-bold">${esc(label)}</span>
    </div>`;
  }

  function renderDepNode(node, depth) {
    const pad = depth * 18;
    const hardTag = node.isHard
      ? `<span class="px-1.5 py-0.5 rounded-md bg-rose-500/10 text-rose-300 border border-rose-500/25 text-[9px] font-bold">Hard</span>`
      : `<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[9px] font-bold">Optional</span>`;
    const children =
      Array.isArray(node.children) && node.children.length
        ? `<div class="space-y-1.5 mt-1.5 border-l border-slate-800 pl-3">${node.children
            .map((c) => renderDepNode(c, depth + 1))
            .join("")}</div>`
        : "";
    return `
      <div class="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-2" style="margin-left:${pad}px">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-amber-400">${icon(node.depth === 0 ? "layers" : "package", "w-3.5 h-3.5")}</span>
          <span class="text-[11px] font-bold text-white">${esc(node.modName || node.modId)}</span>
          ${node.depth === 0 ? "" : hardTag}
        </div>
        <p class="text-[10px] text-slate-500 font-bold">${esc(node.modId)}</p>
        ${children}
      </div>
    `;
  }

  function switchDetailTab(tabId) {
    const tabMap = {
      "mod-detail-tab-description": "mod-detail-description",
      "mod-detail-tab-screenshots": "mod-detail-screenshots",
      "mod-detail-tab-changelog": "mod-detail-changelog",
      "mod-detail-tab-deps": "mod-detail-deps",
    };
    const panelId = tabMap[tabId];
    if (!panelId) return;
    document.querySelectorAll(".mod-detail-tab").forEach((btn) => {
      const active = btn.getAttribute("id") === tabId;
      btn.classList.toggle("bg-amber-600", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("text-slate-400", !active);
      btn.classList.toggle("hover:bg-slate-800", !active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    Object.keys(tabMap).forEach((id) => {
      const panel = el(tabMap[id]);
      if (panel) panel.classList.toggle("hidden", id !== tabId);
    });
  }

  function closeModDetail() {
    const drawer = el("mod-detail-drawer");
    if (!drawer) return;
    drawer.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    drawer.removeEventListener("keydown", modDetailKeydownHandler);
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  }

  function modDetailKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") window.trapFocus(el("mod-detail-drawer"), e);
  }

  // -------------------------------------------------------------------------
  // Load Order Manager
  // -------------------------------------------------------------------------

  const loadOrderState = { gameDomain: null, rows: [], undoStack: [] };
  let dragModId = null;

  function showLoadOrderPanel() {
    const panel = el("mods-load-order-panel");
    if (panel) panel.classList.remove("hidden");
  }

  function hideLoadOrderPanel() {
    const panel = el("mods-load-order-panel");
    if (panel) panel.classList.add("hidden");
  }

  async function loadLoadOrder(gameDomain) {
    if (!gameDomain) return;
    const listEl = el("mods-load-order-list");
    if (!listEl) return;
    listEl.innerHTML =
      '<div class="flex items-center gap-2 text-slate-500 text-xs"><div class="animate-spin rounded-full h-4 w-4 border-b-2 border-amber-500"></div>Loading load order…</div>';
    try {
      const res = await apiRequest(`/api/mods/load-order?game=${encodeURIComponent(gameDomain)}`);
      const body = await res.json().catch(() => ({}));
      const rows = body && Array.isArray(body.loadOrder) ? body.loadOrder : [];
      loadOrderState.gameDomain = gameDomain;
      loadOrderState.rows = rows;
      loadOrderState.undoStack = [];
      const undoBtn = el("mods-load-order-undo");
      if (undoBtn) undoBtn.disabled = true;
      renderLoadOrder(rows);
      await refreshLoadOrderConflicts(gameDomain, rows);
    } catch (err) {
      listEl.innerHTML = `<p class="text-xs text-rose-400">${esc(safeError(err, "Failed to load load order."))}</p>`;
    }
  }

  function renderLoadOrder(rows) {
    const listEl = el("mods-load-order-list");
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML =
        '<p class="text-xs text-slate-500">No active mods in the load order yet. Track mods in the Trending tab to build one.</p>';
      return;
    }
    listEl.innerHTML = rows
      .map((row, index) => {
        const upDisabled = index === 0;
        const downDisabled = index === rows.length - 1;
        const rowName = row.modName || row.modId;
        return `
          <div class="load-order-row flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 hover:border-amber-500/40 transition-all"
               draggable="true" data-mod-id="${esc(row.modId)}" data-position="${index}" tabindex="0"
               aria-label="Mod ${index + 1}: ${esc(rowName)}">
            <button type="button" class="load-order-handle shrink-0 w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center cursor-grab" title="Drag to reorder" aria-label="Drag to reorder ${esc(rowName)}">⋮⋮</button>
            <span class="text-[10px] text-slate-500 font-bold w-5 text-right">${index + 1}</span>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-white truncate">${esc(rowName)}</p>
              <p class="text-[10px] text-slate-500">${esc(row.modId)}</p>
            </div>
            <button type="button" class="load-order-up px-1.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold disabled:opacity-30 disabled:cursor-not-allowed" aria-label="Move ${esc(rowName)} up" ${upDisabled ? "disabled" : ""}>↑</button>
            <button type="button" class="load-order-down px-1.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold disabled:opacity-30 disabled:cursor-not-allowed" aria-label="Move ${esc(rowName)} down" ${downDisabled ? "disabled" : ""}>↓</button>
          </div>
        `;
      })
      .join("");
    wireLoadOrderRows();
    if (window.lucide) window.lucide.createIcons();
  }

  function wireLoadOrderRows() {
    const listEl = el("mods-load-order-list");
    if (!listEl) return;
    listEl.querySelectorAll(".load-order-row").forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        dragModId = row.getAttribute("data-mod-id");
        row.classList.add("opacity-50", "ring-2", "ring-amber-500");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("opacity-50", "ring-2", "ring-amber-500");
        dragModId = null;
      });
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragModId) return;
        const targetId = row.getAttribute("data-mod-id");
        if (dragModId !== targetId) moveModBefore(dragModId, targetId);
        dragModId = null;
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          moveModByDelta(row.getAttribute("data-mod-id"), -1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          moveModByDelta(row.getAttribute("data-mod-id"), 1);
        }
      });
    });
    listEl.querySelectorAll(".load-order-up").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const row = e.target.closest(".load-order-row");
        if (row) moveModByDelta(row.getAttribute("data-mod-id"), -1);
      });
    });
    listEl.querySelectorAll(".load-order-down").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const row = e.target.closest(".load-order-row");
        if (row) moveModByDelta(row.getAttribute("data-mod-id"), 1);
      });
    });
  }

  function moveModByDelta(modId, delta) {
    const rows = loadOrderState.rows;
    const idx = rows.findIndex((r) => String(r.modId) === String(modId));
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= rows.length) return;
    const next = rows.slice();
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item);
    applyLoadOrder(next);
  }

  function moveModBefore(modId, targetId) {
    const rows = loadOrderState.rows;
    const fromIdx = rows.findIndex((r) => String(r.modId) === String(modId));
    const toIdx = rows.findIndex((r) => String(r.modId) === String(targetId));
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const next = rows.slice();
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    applyLoadOrder(next);
  }

  function applyLoadOrder(nextRows) {
    const gameDomain = loadOrderState.gameDomain;
    loadOrderState.undoStack.push(loadOrderState.rows.map((r) => r.modId));
    loadOrderState.rows = nextRows;
    renderLoadOrder(nextRows);
    const undoBtn = el("mods-load-order-undo");
    if (undoBtn) undoBtn.disabled = false;
    if (gameDomain)
      persistLoadOrderToServer(
        gameDomain,
        nextRows.map((r) => r.modId),
      );
  }

  async function persistLoadOrderToServer(gameDomain, orderedModIds) {
    try {
      const res = await apiRequest("/api/mods/load-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameDomain, orderedModIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (body && body.success) {
        toast("Load order saved.");
        loadOrderState.rows = Array.isArray(body.loadOrder) ? body.loadOrder : loadOrderState.rows;
        renderLoadOrder(loadOrderState.rows);
        await refreshLoadOrderConflicts(gameDomain, loadOrderState.rows);
      } else {
        toast(
          body && body.error
            ? safeError(body.error, "Failed to save load order.")
            : "Failed to save load order.",
          true,
        );
      }
    } catch (err) {
      toast(safeError(err, "Failed to save load order."), true);
    }
  }

  function undoLoadOrder() {
    const previous = loadOrderState.undoStack.pop();
    if (!previous) return;
    const gameDomain = loadOrderState.gameDomain;
    const byId = new Map(loadOrderState.rows.map((r) => [String(r.modId), r]));
    loadOrderState.rows = previous.map(
      (modId) => byId.get(String(modId)) || { modId, modName: modId, position: 0, isActive: 1 },
    );
    const undoBtn = el("mods-load-order-undo");
    if (undoBtn) undoBtn.disabled = loadOrderState.undoStack.length === 0;
    renderLoadOrder(loadOrderState.rows);
    if (gameDomain)
      persistLoadOrderToServer(
        gameDomain,
        loadOrderState.rows.map((r) => r.modId),
      );
  }

  async function refreshLoadOrderConflicts(gameDomain, rows) {
    const strip = el("mods-load-order-conflicts");
    if (!strip) return;
    if (!rows || !rows.length) {
      strip.classList.add("hidden");
      strip.innerHTML = "";
      return;
    }
    const ids = rows.map((r) => String(r.modId));
    try {
      const res = await apiRequest(
        `/api/mods/conflicts?game=${encodeURIComponent(gameDomain)}&modIds=${encodeURIComponent(ids.join(","))}`,
      );
      const body = await res.json().catch(() => ({}));
      const conflicts = body && Array.isArray(body.conflicts) ? body.conflicts : [];
      if (!conflicts.length) {
        strip.classList.add("hidden");
        strip.innerHTML = "";
        return;
      }
      strip.classList.remove("hidden");
      strip.innerHTML =
        `<p class="text-[10px] font-black uppercase tracking-wider text-rose-400">⚠ ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} detected</p>` +
        conflicts
          .map(
            (c) => `
              <div class="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[10px] text-rose-200" data-load-order-conflict>
                <span class="mt-0.5 shrink-0">${c.type === "missing-dependency" ? "🧩" : "⚔"}</span>
                <div class="min-w-0">
                  <p class="font-bold">${esc(c.message || "")}</p>
                  ${
                    Array.isArray(c.filePaths) && c.filePaths.length
                      ? `<p class="text-rose-300/80 mt-0.5 break-all">${c.filePaths.map((p) => esc(p)).join(" · ")}</p>`
                      : ""
                  }
                </div>
              </div>
            `,
          )
          .join("");
    } catch (err) {
      // Non-blocking — conflict refresh must never break the manager.
    }
  }

  // -------------------------------------------------------------------------
  // Conflict badges on trending/search/installed cards
  // -------------------------------------------------------------------------

  async function refreshModConflictBadges(gameDomain) {
    const container = el("mods-list-container");
    if (!container || !gameDomain) return;
    const cards = container.querySelectorAll(".mod-card[data-mod-id]");
    if (!cards.length) return;
    const ids = Array.from(cards)
      .map((c) => c.getAttribute("data-mod-id"))
      .filter(Boolean);
    try {
      const res = await apiRequest(
        `/api/mods/conflicts?game=${encodeURIComponent(gameDomain)}&modIds=${encodeURIComponent(ids.join(","))}`,
      );
      const body = await res.json().catch(() => ({}));
      const conflicts = body && Array.isArray(body.conflicts) ? body.conflicts : [];
      const conflictIds = new Set();
      conflicts.forEach((c) => {
        conflictIds.add(String(c.modA));
        if (c.modB) conflictIds.add(String(c.modB));
      });
      cards.forEach((card) => {
        const modId = String(card.getAttribute("data-mod-id"));
        const hasConflict = conflictIds.has(modId);
        let badge = card.querySelector(".mod-conflict-badge");
        if (hasConflict && !badge) {
          badge = document.createElement("span");
          badge.className = "mod-conflict-badge";
          badge.textContent = "⚠ Conflict";
          badge.title = "File-level conflict detected";
          card.appendChild(badge);
        } else if (!hasConflict && badge) {
          badge.remove();
        }
      });
    } catch (err) {
      // Non-blocking.
    }
  }

  // -------------------------------------------------------------------------
  // Tab wiring (called from app.js loadModsData)
  // -------------------------------------------------------------------------

  function syncModsHubForTab(tab, gameDomain) {
    if (tab === "installed") {
      showLoadOrderPanel();
      if (gameDomain) loadLoadOrder(gameDomain);
    } else {
      hideLoadOrderPanel();
    }
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function initModsHub() {
    const closeBtn = el("mod-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", closeModDetail);
    const backdrop = el("mod-detail-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeModDetail);

    document.querySelectorAll(".mod-detail-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchDetailTab(tab.getAttribute("id")));
    });

    const undoBtn = el("mods-load-order-undo");
    if (undoBtn) undoBtn.addEventListener("click", undoLoadOrder);
    const refreshBtn = el("mods-load-order-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        if (loadOrderState.gameDomain) loadLoadOrder(loadOrderState.gameDomain);
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const drawer = el("mod-detail-drawer");
      if (drawer && !drawer.classList.contains("hidden")) closeModDetail();
    });

    // Delegated detail-open for cards rendered by app.js renderModsList.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mod-details]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      openModDetail(
        btn.getAttribute("data-game-domain") || "",
        btn.getAttribute("data-mod-details") || "",
        btn.getAttribute("data-mod-name") || "Mod Details",
      );
    });
  }

  window.openModDetail = openModDetail;
  window.closeModDetail = closeModDetail;
  window.loadLoadOrder = loadLoadOrder;
  window.refreshModConflictBadges = refreshModConflictBadges;
  window.syncModsHubForTab = syncModsHubForTab;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initModsHub);
  } else {
    initModsHub();
  }
})();
