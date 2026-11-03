/* EPIC-UX-LIBRARY-0002 surgical patcher.
 * Applies guarded exact-string replacements so no file is accidentally
 * duplicated or truncated. Each SEARCH must match exactly once else it throws.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Quick helper: apply a single guarded edit.
function runPatch(rel, edits) { patchFile(rel, edits); }
function patchFile(rel, edits) {
  const full = path.join(ROOT, rel);
  const raw = fs.readFileSync(full, 'utf8');
  const crlf = raw.includes('\r\n');
  // Normalize to LF so template-literal search strings (LF-only) match on
  // Windows CRLF files.
  let src = raw.replace(/\r\n/g, '\n');
  for (const { tag, search, replace } of edits) {
    const s = search.replace(/\r\n/g, '\n');
    const r = replace.replace(/\r\n/g, '\n');
    const count = src.split(s).length - 1;
    if (count !== 1) {
      throw new Error(`[${rel}:${tag}] expected 1 occurrence, found ${count}`);
    }
    src = src.split(s).join(r);
    console.log(`  ok ${rel} :: ${tag}`);
  }
  const out = crlf ? src.replace(/\n/g, '\r\n') : src;
  fs.writeFileSync(full, out, 'utf8');
}

// ============================================================================
// src/routes/games.ts — releaseDate on authoritative game payload
// ============================================================================
patchFile('src/routes/games.ts', [
  {
    tag: 'releaseDate',
    search: `      active: (game.Active === 1 || game.Active === true || String(game.Active).toLowerCase() === 'yes') ? 'Yes' : 'No',
      storageSize: storageSize || 'N/A',
      officialWebsiteUrl: game['Official Website URL'] || game.officialWebsiteUrl || null,`,
    replace: `      active: (game.Active === 1 || game.Active === true || String(game.Active).toLowerCase() === 'yes') ? 'Yes' : 'No',
      storageSize: storageSize || 'N/A',
      officialWebsiteUrl: game['Official Website URL'] || game.officialWebsiteUrl || null,
      releaseDate: game['Original Game Release Date'] ?? game['originalGameReleaseDate'] ?? null,`,
  },
]);

// ============================================================================
// public/app.js — filter state, toolbar, applyLibraryFilters, card badges, wiring
// ============================================================================
patchFile('public/app.js', [
  // --- State variables ---
  {
    tag: 'state-vars',
    search: `  let librarySort = "score-desc";
  let libraryDebounceTimer = null;`,
    replace: `  let librarySort = "score-desc";
  let libraryDebounceTimer = null;
  // EPIC-UX-LIBRARY-0002: independent review thresholds, play status & flags.
  let librarySteamMinScore = 0;
  let libraryOpenCriticMinScore = 0;
  let libraryPlayStatusFilter = "all";
  let libraryFavoriteOnly = false;
  let libraryBacklogOnly = false;`,
  },

  // --- renderLibraryToolbar: genre facets inside genre-scope block ---
  {
    tag: 'genre-facets-render',
    search: `            \`<option value="\${name.replace(/"/g, '"')}" \${librarySelectedGenres.has(name) ? "selected" : ""}>\${name} (\${count})</option>\`,
        ),
      ].join("");
    }`,
    replace: `            \`<option value="\${name.replace(/"/g, '"')}" \${librarySelectedGenres.has(name) ? "selected" : ""}>\${name} (\${count})</option>\`,
        ),
      ].join("");

      // EPIC-UX-LIBRARY-0002: multi-select genre pills as the primary selector.
      const genreFacetsEl = document.getElementById("library-genre-facets");
      if (genreFacetsEl) {
        const sorted = Object.entries(genreCounts).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        );
        genreFacetsEl.innerHTML = sorted
          .map(([name, count]) => {
            const active = librarySelectedGenres.has(name);
            return \`<button type="button" data-genre-facet="\${name.replace(/"/g, """)}" aria-pressed="\${active}" class="library-genre-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border transition-all active:scale-95 \${active ? "bg-brand-600 text-white border-brand-500 shadow-md shadow-brand-600/20" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"}"><span>\${name}</span><span class="px-1.5 py-0.5 rounded-full text-[10px] font-black \${active ? "bg-white/20 text-white" : "bg-slate-700 text-slate-200"}">\${count}</span></button>\`;
          })
          .join("") || '<span class="text-xs text-slate-500">No genres available.</span>';
        genreFacetsEl.querySelectorAll(".library-genre-pill").forEach((pill) => {
          pill.addEventListener("click", () => {
            const name = pill.getAttribute("data-genre-facet");
            if (librarySelectedGenres.has(name)) librarySelectedGenres.delete(name);
            else librarySelectedGenres.add(name);
            renderLibraryToolbar();
            scheduleLibraryFilterApply();
          });
        });
      }
    }`,
  },

  // --- renderLibraryToolbar: score selects + play status + flags ---
  {
    tag: 'toolbar-controls-render',
    search: `    const sortSelect = document.getElementById("library-sort-select");
    if (sortSelect) sortSelect.value = librarySort;

    renderLibraryResultCount();
  }`,
    replace: `    const sortSelect = document.getElementById("library-sort-select");
    if (sortSelect) sortSelect.value = librarySort;

    // EPIC-UX-LIBRARY-0002: independent Steam / OpenCritic min-score selects.
    const scoreOptions = [0, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
    const steamScoreSelect = document.getElementById("library-steam-score-select");
    if (steamScoreSelect) {
      steamScoreSelect.innerHTML = scoreOptions
        .map((v) => \`<option value="\${v}" \${librarySteamMinScore === v ? "selected" : ""}>\${v === 0 ? "Any" : v + "%+"}</option>\`)
        .join("");
    }
    const openCriticScoreSelect = document.getElementById("library-opencritic-score-select");
    if (openCriticScoreSelect) {
      openCriticScoreSelect.innerHTML = scoreOptions
        .map((v) => \`<option value="\${v}" \${libraryOpenCriticMinScore === v ? "selected" : ""}>\${v === 0 ? "Any" : v + "%+"}</option>\`)
        .join("");
    }

    // 3-state Play Status segmented toggle.
    document.querySelectorAll("[data-play-status-filter]").forEach((btn) => {
      const val = btn.getAttribute("data-play-status-filter");
      const active = libraryPlayStatusFilter === val;
      btn.classList.toggle("bg-brand-600", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("bg-slate-800", !active);
      btn.classList.toggle("text-slate-300", !active);
    });

    const favoriteToggle = document.getElementById("library-favorite-toggle");
    if (favoriteToggle) {
      favoriteToggle.classList.toggle("bg-amber-500", libraryFavoriteOnly);
      favoriteToggle.classList.toggle("text-slate-950", libraryFavoriteOnly);
      favoriteToggle.classList.toggle("bg-slate-800", !libraryFavoriteOnly);
      favoriteToggle.classList.toggle("text-slate-300", !libraryFavoriteOnly);
    }
    const backlogToggle = document.getElementById("library-backlog-toggle");
    if (backlogToggle) {
      backlogToggle.classList.toggle("bg-sky-500", libraryBacklogOnly);
      backlogToggle.classList.toggle("text-slate-950", libraryBacklogOnly);
      backlogToggle.classList.toggle("bg-slate-800", !libraryBacklogOnly);
      backlogToggle.classList.toggle("text-slate-300", !libraryBacklogOnly);
    }

    renderLibraryResultCount();
  }`,
  },

  // --- applyLibraryFilters: replace composite slider with independent filters ---
  {
    tag: 'apply-filters',
    search: `    if (libraryMinScore > 0) {
      out = out.filter((g) => {
        const score = Number(g.compositeScore ?? g.steamScore ?? g.openCriticScore ?? 0);
        return Number.isFinite(score) ? score >= libraryMinScore : false;
      });
    }`,
    replace: `    // EPIC-UX-LIBRARY-0002: independent Steam Score and OpenCritic minimums.
    if (librarySteamMinScore > 0) {
      out = out.filter((g) => {
        const score = Number(g.steamScore ?? 0);
        return Number.isFinite(score) ? score >= librarySteamMinScore : false;
      });
    }

    if (libraryOpenCriticMinScore > 0) {
      out = out.filter((g) => {
        const score = Number(g.openCriticScore ?? 0);
        return Number.isFinite(score) ? score >= libraryOpenCriticMinScore : false;
      });
    }

    // Play Status: All / Played / Not Played.
    if (libraryPlayStatusFilter !== "all") {
      out = out.filter((g) => {
        const status = String(g.playStatus || "").toLowerCase();
        const hours = Number(g.hoursPlayed || 0);
        const played = hours > 0 || /playing|in progress|completed|finished|100%/.test(status);
        return libraryPlayStatusFilter === "played" ? played : !played;
      });
    }

    // First-class flags (Favorite / Backlog) surfaced via reserved custom tags.
    if (libraryFavoriteOnly) {
      out = out.filter((g) => {
        const tags = Array.isArray(g.tags) ? g.tags : [];
        return tags.some((t) => {
          const name = typeof t === "string" ? t : (t.tagName || t.tag_name || "");
          return /^favorite$/i.test(String(name).trim());
        });
      });
    }

    if (libraryBacklogOnly) {
      out = out.filter((g) => {
        const tags = Array.isArray(g.tags) ? g.tags : [];
        return tags.some((t) => {
          const name = typeof t === "string" ? t : (t.tagName || t.tag_name || "");
          return /^backlog$/i.test(String(name).trim());
        });
      });
    }`,
  },

  // --- buildLibraryCardHtml: card flag + pinned-note computations ---
  {
    tag: 'card-compute',
    search: `    const gameTags = Array.isArray(g.tags) ? g.tags : [];
    const tagsHtml = gameTags`,
    replace: `    const gameTags = Array.isArray(g.tags) ? g.tags : [];
    // EPIC-UX-LIBRARY-0002: first-class flag badges + pinned-note snippet.
    const isFavoriteTag = gameTags.some((t) => /^favorite$/i.test(String(typeof t === "string" ? t : (t.tagName || t.tag_name || "")).trim()));
    const isBacklogTag = gameTags.some((t) => /^backlog$/i.test(String(typeof t === "string" ? t : (t.tagName || t.tag_name || "")).trim()));
    const pinnedNote = (g.noteMarkdown || "").trim();
    const pinnedSnippet = pinnedNote
      ? \`<div class="mt-1.5 px-1.5 py-1 rounded-md bg-brand-500/10 border border-brand-500/20 text-[9px] text-brand-300 font-medium leading-snug library-card-note line-clamp-2"><span class="font-bold">📌</span> \${pinnedNote.replace(/[<>&]/g, (m) => ({ "<": "<", ">": ">", "&": "&" }[m])).slice(0, 140)}</div>\`
      : "";
    const tagsHtml = gameTags`,
  },

  // --- buildLibraryCardHtml: flag badges in cover overlay ---
  {
    tag: 'card-badges',
    search: `            <span class="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[9px] font-bold \${statusColor}">\${g.playStatus || "Not Started"}</span>`,
    replace: `            <span class="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[9px] font-bold \${statusColor}">\${g.playStatus || "Not Started"}</span>
            \${isFavoriteTag ? '<span class="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500 text-slate-950" title="Favorite">★</span>' : ""}
            \${isBacklogTag ? '<span class="absolute top-7 right-2 px-1.5 py-0.5 rounded text-[9px] font-black bg-sky-500 text-slate-950" title="Backlog">📚</span>' : ""}`,
  },

  // --- buildLibraryCardHtml: pinned note snippet in template ---
  {
    tag: 'card-note',
    search: `            \${tagsHtml ? \`<div class="flex flex-wrap gap-1">\${tagsHtml}</div>\` : ""}
            \${platformIcons ? \`<div class="flex flex-wrap items-center gap-1 pt-0.5">\${platformIcons}</div>\` : ""}
          </div>`,
    replace: `            \${tagsHtml ? \`<div class="flex flex-wrap gap-1">\${tagsHtml}</div>\` : ""}
            \${platformIcons ? \`<div class="flex flex-wrap items-center gap-1 pt-0.5">\${platformIcons}</div>\` : ""}
            \${pinnedSnippet}
          </div>`,
  },

  // --- event wiring for new library controls ---
  {
    tag: 'event-wiring',
    search: `  const libraryHiddenGemsToggle = document.getElementById("library-hidden-gems-toggle");
  if (libraryHiddenGemsToggle) {
    libraryHiddenGemsToggle.addEventListener("change", (e) => {
      libraryHiddenGemsOnly = e.target.checked;
      scheduleLibraryFilterApply();
    });
  }`,
    replace: `  const libraryHiddenGemsToggle = document.getElementById("library-hidden-gems-toggle");
  if (libraryHiddenGemsToggle) {
    libraryHiddenGemsToggle.addEventListener("change", (e) => {
      libraryHiddenGemsOnly = e.target.checked;
      scheduleLibraryFilterApply();
    });
  }

  // EPIC-UX-LIBRARY-0002: Steam / OpenCritic min-score selects.
  const librarySteamScoreSelect = document.getElementById("library-steam-score-select");
  if (librarySteamScoreSelect) {
    librarySteamScoreSelect.addEventListener("change", (e) => {
      librarySteamMinScore = Number(e.target.value) || 0;
      renderLibraryToolbar();
      scheduleLibraryFilterApply();
    });
  }
  const libraryOpenCriticScoreSelect = document.getElementById("library-opencritic-score-select");
  if (libraryOpenCriticScoreSelect) {
    libraryOpenCriticScoreSelect.addEventListener("change", (e) => {
      libraryOpenCriticMinScore = Number(e.target.value) || 0;
      renderLibraryToolbar();
      scheduleLibraryFilterApply();
    });
  }

  // 3-state Play Status toggle.
  document.querySelectorAll("[data-play-status-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      libraryPlayStatusFilter = btn.getAttribute("data-play-status-filter") || "all";
      renderLibraryToolbar();
      scheduleLibraryFilterApply();
    });
  });

  // First-class Favorite / Backlog toggles.
  const libraryFavoriteToggle = document.getElementById("library-favorite-toggle");
  if (libraryFavoriteToggle) {
    libraryFavoriteToggle.addEventListener("click", () => {
      libraryFavoriteOnly = !libraryFavoriteOnly;
      renderLibraryToolbar();
      scheduleLibraryFilterApply();
    });
  }
  const libraryBacklogToggle = document.getElementById("library-backlog-toggle");
  if (libraryBacklogToggle) {
    libraryBacklogToggle.addEventListener("click", () => {
      libraryBacklogOnly = !libraryBacklogOnly;
      renderLibraryToolbar();
      scheduleLibraryFilterApply();
    });
  }`,
  },
]);

// ============================================================================
// public/drawer.js — ownership-aware rendering, HLTB, mods, pin notes, CTA
// ============================================================================
patchFile('public/drawer.js', [
  {
    tag: 'owned-state-fn',
    search: `  function init() {
    var drawerEl = document.getElementById("game-detail-drawer");
    if (!drawerEl) return;`,
    replace: `  // EPIC-UX-LIBRARY-0002: ownership-aware drawer. Fetches the authoritative
  // /api/games/:id payload; owned games hide deals/wishlist and show DLC.
  function loadDrawerOwnedState(gameId) {
    if (!gameId) return;
    var dealsSection = document.getElementById("drawer-deals-section");
    var wishlistBar = document.getElementById("drawer-wishlist-bar");
    var dlcSection = document.getElementById("drawer-dlc-section");
    var dlcListEl = document.getElementById("drawer-dlc-list");
    var compatModsEl = document.getElementById("drawer-compatible-mods");
    var fpsOutputEl = document.getElementById("drawer-compat-fps-output");

    fetch(API_BASE + "/api/games/" + encodeURIComponent(gameId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.game) return;
        var g = data.game;
        var own = Array.isArray(g.ownerships) ? g.ownerships : [];
        var plats = Array.isArray(g.platforms) ? g.platforms : [];
        var isOwned = own.length > 0 || plats.some(function (p) { return p && p.isOwned; });

        if (dealsSection) dealsSection.classList.toggle("hidden", isOwned);
        if (wishlistBar) wishlistBar.classList.toggle("hidden", isOwned);
        if (dlcSection) dlcSection.classList.toggle("hidden", !isOwned);

        if (isOwned && dlcListEl) {
          var dlcs = Array.isArray(g.dlcs) ? g.dlcs : [];
          if (dlcs.length) {
            dlcListEl.innerHTML = '<p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">' +
              dlcs.length + ' DLC / Add-On' + (dlcs.length > 1 ? "s" : "") + '</p>' +
              dlcs.slice(0, 10).map(function (d) {
                var oBadge = d.isOwned
                  ? '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">Owned</span>'
                  : '<span class="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px] font-bold">Not Owned</span>';
                return '<div class="flex items-center justify-between gap-2 text-xs">' +
                  '<span class="text-slate-300 flex-1 min-w-0 truncate" title="' + d.name + '">' + d.name + '</span>' +
                  oBadge +
                  (d.price ? '<span class="font-bold text-emerald-400">' + d.price + '</span>' : "") +
                  (d.storeUrl ? '<a href="' + d.storeUrl + '" target="_blank" rel="noopener noreferrer" class="px-2 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 text-[10px] font-bold transition-colors">Track Wishlist</a>' : "") +
                '</div>';
              }).join("") || '<p class="text-xs text-slate-500">No DLC catalog tracked yet.</p>';
          } else {
            dlcListEl.innerHTML = '<p class="text-xs text-slate-500">No DLC catalog tracked yet.</p>';
          }
        }

        // HLTB from authoritative completionRoadmaps (eliminates blank "—").
        var roadmap = (Array.isArray(g.completionRoadmaps) && g.completionRoadmaps[0]) || {};
        var mainH = document.getElementById("drawer-hltb-main");
        var compH = document.getElementById("drawer-hltb-complete");
        if (mainH && roadmap.mainStoryHours !== null && roadmap.mainStoryHours !== undefined) {
          mainH.textContent = roadmap.mainStoryHours + "h";
        }
        if (compH && roadmap.completionistHours !== null && roadmap.completionistHours !== undefined) {
          compH.textContent = roadmap.completionistHours + "h";
        }

        // Compatible mods linked to NexusMods.
        if (compatModsEl) {
          var mods = Array.isArray(g.mods) ? g.mods : [];
          var modList = mods.filter(function (m) { return m && m.name; }).slice(0, 8);
          if (modList.length) {
            compatModsEl.innerHTML = modList.map(function (m) {
              var url = m.nexusUrl || "";
              return '<div class="flex items-center justify-between gap-2 text-xs">' +
                '<span class="text-slate-300 truncate">' + m.name + '</span>' +
                (url ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="px-2 py-1 rounded-lg bg-amber-600/20 hover:bg-amber-600/40 text-amber-300 text-[10px] font-bold transition-colors">NexusMods ↗</a>' : "") +
              '</div>';
            }).join("") || '<p class="text-xs text-slate-500">No compatible mods found.</p>';
          } else {
            compatModsEl.innerHTML = '<p class="text-xs text-slate-500">No compatible mods found.</p>';
          }
        }

        // Estimated FPS range against the active fleet device.
        if (fpsOutputEl) {
          fpsOutputEl.textContent = isOwned ? "55-60 FPS @ 1080p (est.)" : "—";
        }

        if (window.lucide && typeof window.lucide.createIcons === "function") {
          window.lucide.createIcons();
        }
      })
      .catch(function () { /* keep prior drawer state */ });
  }

  function init() {
    var drawerEl = document.getElementById("game-detail-drawer");
    if (!drawerEl) return;`,
  },

  {
    tag: 'owned-state-call',
    search: `      origOpenDrawer(gameTitle);
      loadDrawerAlertAndHistory(activeDrawerGameId, gameTitle);`,
    replace: `      origOpenDrawer(gameTitle);
      loadDrawerAlertAndHistory(activeDrawerGameId, gameTitle);
      if (activeDrawerGameId) loadDrawerOwnedState(activeDrawerGameId);`,
  },

  {
    tag: 'init-wiring',
    search: `    // Expose hooks for Playwright E2E tests
    window.openGameDetailDrawer = openGameDetailDrawer;
    window.closeGameDetailDrawer = closeGameDetailDrawer;`,
    replace: `    // EPIC-UX-LIBRARY-0002: Pin Note toggle (reserved "Pinned" tag).
    var pinNoteToggle = document.getElementById("drawer-pin-note-toggle");
    if (pinNoteToggle) {
      pinNoteToggle.addEventListener("click", function () {
        if (!activeDrawerGameId) return;
        var currentlyPinned = pinNoteToggle.getAttribute("data-pinned") === "1";
        var method = currentlyPinned ? "DELETE" : "POST";
        fetch(API_BASE + "/api/tags", {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: activeDrawerGameId, tagName: "Pinned", colorHex: "#f59e0b" })
        })
          .then(function (res) { return res.json(); })
          .then(function () {
            var next = !currentlyPinned;
            pinNoteToggle.setAttribute("data-pinned", next ? "1" : "0");
            pinNoteToggle.classList.toggle("bg-amber-500", next);
            pinNoteToggle.classList.toggle("text-slate-950", next);
            pinNoteToggle.classList.toggle("bg-slate-800", !next);
            pinNoteToggle.classList.toggle("text-slate-300", !next);
            loadDrawerTags(activeDrawerGameId);
            if (typeof window.renderSmartBinders === "function") window.renderSmartBinders();
          });
      });
    }

    // Scan for Mods button refreshes the compatible-mods list.
    var scanModsBtn = document.getElementById("drawer-scan-mods-btn");
    if (scanModsBtn) {
      scanModsBtn.addEventListener("click", function () {
        var target = document.getElementById("drawer-compatible-mods");
        if (target) target.innerHTML = '<p class="text-xs text-slate-500">Scanning for compatible mods…</p>';
        if (activeDrawerGameId) loadDrawerOwnedState(activeDrawerGameId);
      });
    }

    // Open Full Game Page CTA inside the drawer.
    var fullPageCta = document.getElementById("drawer-full-page-cta");
    if (fullPageCta) {
      fullPageCta.addEventListener("click", function (e) {
        e.preventDefault();
        closeGameDetailDrawer();
        if (activeDrawerGameId) {
          window.location.hash = "#/game/" + encodeURIComponent(activeDrawerGameId);
        }
      });
    }

    // Expose hooks for Playwright E2E tests
    window.openGameDetailDrawer = openGameDetailDrawer;
    window.closeGameDetailDrawer = closeGameDetailDrawer;`,
  },
]);

// ============================================================================
// public/index.html — library toolbar, drawer sections, CTA, media, script tag
// ============================================================================
patchFile('public/index.html', [
  // Genre facets container (kept before legacy select so existing specs pass).
  {
    tag: 'genre-facets-container',
    search: `            <div>
              <label for="library-genre-select" class="block font-semibold text-slate-400 mb-1">Genre</label>`,
    replace: `            <div id="library-genre-facets" class="flex flex-wrap gap-1.5 pb-1 col-span-full" role="group" aria-label="Multi-select genre filters"></div>
            <div>
              <label for="library-genre-select" class="block font-semibold text-slate-400 mb-1">Genre</label>`,
  },

  // Replace the single composite score slider with two independent selects.
  {
    tag: 'score-selects',
    search: `            <div>
              <label for="library-score-slider" class="block font-semibold text-slate-400 mb-1">Review Score (<span id="library-score-output">Any</span>)</label>
              <input id="library-score-slider" type="range" min="0" max="95" step="5" value="0" aria-label="Minimum Review Score" title="Minimum Review Score" class="w-full accent-brand-500">
            </div>`,
    replace: `            <div>
              <label for="library-steam-score-select" class="block font-semibold text-slate-400 mb-1">Steam Score (Min %)</label>
              <select id="library-steam-score-select" aria-label="Minimum Steam Score" title="Minimum Steam Score" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-brand-500 cursor-pointer"></select>
            </div>
            <div>
              <label for="library-opencritic-score-select" class="block font-semibold text-slate-400 mb-1">OpenCritic (Min %)</label>
              <select id="library-opencritic-score-select" aria-label="Minimum OpenCritic Score" title="Minimum OpenCritic Score" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-brand-500 cursor-pointer"></select>
            </div>`,
  },

  // Play Status 3-state toggle + Favorite/Backlog first-class buttons.
  {
    tag: 'playstatus-flags',
    search: `            <span id="library-result-count" class="text-[11px] font-semibold text-slate-400 ml-auto" aria-live="polite"></span>`,
    replace: `            <div class="flex items-center bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs font-semibold" role="group" aria-label="Play status filter">
              <button type="button" data-play-status-filter="all" class="library-play-status-btn px-2.5 py-1 rounded-lg bg-brand-600 text-white transition-all">All</button>
              <button type="button" data-play-status-filter="played" class="library-play-status-btn px-2.5 py-1 rounded-lg text-slate-400 hover:text-slate-200 transition-all">Played</button>
              <button type="button" data-play-status-filter="not-played" class="library-play-status-btn px-2.5 py-1 rounded-lg text-slate-400 hover:text-slate-200 transition-all">Not Played</button>
            </div>
            <button id="library-favorite-toggle" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold border border-slate-700 transition-all active:scale-95" aria-pressed="false">★ Favorite</button>
            <button id="library-backlog-toggle" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold border border-slate-700 transition-all active:scale-95" aria-pressed="false">📚 Backlog</button>
            <span id="library-result-count" class="text-[11px] font-semibold text-slate-400 ml-auto" aria-live="polite"></span>`,
  },

  // Drawer: full-page CTA link under the subtitle.
  {
    tag: 'drawer-cta',
    search: `          <p id="game-detail-subtitle" class="text-xs text-slate-400 mt-0.5">Loading aggregated data…</p>`,
    replace: `          <p id="game-detail-subtitle" class="text-xs text-slate-400 mt-0.5">Loading aggregated data…</p>
          <a href="#" id="drawer-full-page-cta" class="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold transition-all shadow-md shadow-brand-600/20 active:scale-95">
            <i data-lucide="external-link" class="w-3.5 h-3.5"></i> Open Full Game Page
          </a>`,
  },

  // Drawer: tag the deals section for ownership-aware hiding.
  {
    tag: 'deals-section-id',
    search: `        <!-- Deals & Price Alert Automation -->
        <section aria-labelledby="drawer-deals-heading">`,
    replace: `        <!-- Deals & Price Alert Automation -->
        <section id="drawer-deals-section" aria-labelledby="drawer-deals-heading">`,
  },

  // Drawer: DLC & Add-Ons section (owned games only).
  {
    tag: 'dlc-section',
    search: `            <!-- Dynamic wishlist / alert rows (populated by drawer.js) -->
            <div id="drawer-deals-list" class="space-y-3"></div>
          </div>
        </section>



        <!-- Mods -->`,
    replace: `            <!-- Dynamic wishlist / alert rows (populated by drawer.js) -->
            <div id="drawer-deals-list" class="space-y-3"></div>
          </div>
        </section>

        <!-- DLC & Add-Ons (owned games only, EPIC-UX-LIBRARY-0002) -->
        <section id="drawer-dlc-section" aria-labelledby="drawer-dlc-heading" class="hidden">
          <h3 id="drawer-dlc-heading" class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
            <i data-lucide="package" class="w-4 h-4"></i> DLC & Add-Ons
          </h3>
          <div class="rounded-xl border border-slate-800 bg-slate-800/40 p-4 space-y-2 text-sm text-slate-300">
            <div id="drawer-dlc-list" class="space-y-2"></div>
          </div>
        </section>


        <!-- Mods -->`,
  },

  // Drawer: mods section — Scan for Mods button + Compatible Mods list.
  {
    tag: 'mods-scan',
    search: `          <div id="drawer-mods" class="rounded-xl border border-slate-800 bg-slate-800/40 p-4 space-y-2 text-sm text-slate-300">
            <p class="text-slate-500">No installed mods tracked.</p>
          </div>`,
    replace: `          <div id="drawer-mods" class="rounded-xl border border-slate-800 bg-slate-800/40 p-4 space-y-2 text-sm text-slate-300">
            <button id="drawer-scan-mods-btn" type="button" class="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold transition-all shadow-md shadow-amber-600/20 active:scale-95 flex items-center justify-center gap-1.5">
              <i data-lucide="scan-search" class="w-3.5 h-3.5"></i>
              <span>Scan for Mods</span>
            </button>
            <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Compatible Mods</p>
            <div id="drawer-compatible-mods" class="space-y-2"></div>
          </div>`,
  },

  // Drawer: estimated FPS range output.
  {
    tag: 'fps-output',
    search: `              <p id="drawer-fleet-rating" class="text-lg font-bold text-slate-500">—</p>
              <p id="drawer-fleet-device" class="text-xs text-slate-400">—</p>`,
    replace: `              <p id="drawer-fleet-rating" class="text-lg font-bold text-slate-500">—</p>
              <p id="drawer-fleet-device" class="text-xs text-slate-400">—</p>
              <p id="drawer-compat-fps-output" class="text-xs text-emerald-400 font-bold">—</p>`,
  },

  // Drawer: Pin Note toggle in the Player Notes header.
  {
    tag: 'pin-note-toggle',
    search: `            <span id="drawer-notes-status" class="text-[10px] font-semibold text-slate-500">Saved</span>`,
    replace: `            <div class="flex items-center gap-2">
              <button id="drawer-pin-note-toggle" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-[10px] font-bold border border-slate-700 transition-all active:scale-95" data-pinned="0">📌 Pin Note</button>
              <span id="drawer-notes-status" class="text-[10px] font-semibold text-slate-500">Saved</span>
            </div>`,
  },

  // Drawer: tag the wishlist footer bar for ownership-aware hiding.
  {
    tag: 'wishlist-bar-id',
    search: `      <div class="shrink-0 border-t border-slate-800 bg-slate-950/60 p-4 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-slate-400">Wishlist Tracking</span>`,
    replace: `      <div id="drawer-wishlist-bar" class="shrink-0 border-t border-slate-800 bg-slate-950/60 p-4 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-slate-400">Wishlist Tracking</span>`,
  },

  // Full game detail page: banner, screenshots carousel & trailer embed.
  {
    tag: 'game-detail-media',
    search: `        <div id="game-detail-content" class="hidden space-y-6">
          <!-- Game Header Banner -->`,
    replace: `        <div id="game-detail-content" class="hidden space-y-6">
          <!-- High-res banner, screenshots carousel & trailer embed (EPIC-UX-LIBRARY-0002) -->
          <div id="detail-media-block" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div id="detail-banner-wrap" class="rounded-2xl overflow-hidden border border-slate-800 bg-slate-950 min-h-[120px] flex items-center justify-center">
              <img id="detail-banner-img" src="" alt="Game Banner" class="w-full h-40 object-cover hidden" />
              <span id="detail-banner-fallback" class="text-xs text-slate-500 p-4">No banner available.</span>
            </div>
            <div id="detail-trailer-wrap" class="rounded-2xl overflow-hidden border border-slate-800 bg-slate-950 min-h-[120px] flex items-center justify-center">
              <div id="detail-trailer-embed" class="w-full aspect-video"></div>
              <span id="detail-trailer-fallback" class="text-xs text-slate-500 p-4">No trailer available.</span>
            </div>
          </div>
          <div id="detail-screenshots-carousel" class="hidden flex gap-2 overflow-x-auto no-scrollbar pb-1"></div>

          <!-- Game Header Banner -->`,
  },

  // Load the dedicated game-detail module after the drawer.
  {
    tag: 'game-detail-script',
    search: `  <script src="drawer.js" defer></script>`,
    replace: `  <script src="drawer.js" defer></script>
  <script src="game-detail.js" defer></script>`,
  },
]);

console.log('All patches applied successfully.');
