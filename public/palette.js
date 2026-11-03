// Global Keyboard Command Palette & Quick Action Engine (FEAT-0150)
// Self-contained module loaded after app.js and drawer.js.
// Provides Ctrl/Cmd+K palette, navigation commands, quick actions, and live game fuzzy search.
(function () {
  "use strict";

  var paletteEl = document.getElementById("command-palette");
  var inputEl = document.getElementById("command-palette-input");
  var resultsEl = document.getElementById("command-palette-results");
  var backdropEl = document.getElementById("command-palette-backdrop");

  var activeIndex = -1;
  var items = []; // { id, label, sublabel, icon, action }
  var searchDebounceTimer = null;

  // ---------------------------------------------------------------------------
  // Command Registry
  // ---------------------------------------------------------------------------
  var NAV_COMMANDS = [
    { label: "Go to Dashboard", keywords: "home dashboard", icon: "home", route: "#/home" },
    {
      label: "Go to Hardware Fleet",
      keywords: "fleet devices hardware",
      icon: "smartphone",
      route: "#/fleet",
    },
    { label: "Go to Deals Hub", keywords: "deals sales store", icon: "tag", route: "#/deals" },
    { label: "Go to Nexus Mods", keywords: "mods nexus", icon: "puzzle", route: "#/mods" },
    {
      label: "Go to Backlog Analytics",
      keywords: "backlog hltb roadmap",
      icon: "list-checks",
      route: "#/backlog",
    },
    {
      label: "Go to Settings",
      keywords: "settings backup state",
      icon: "settings",
      route: "#/settings",
    },
  ];

  var QUICK_ACTIONS = [
    {
      label: "Export Backup Snapshot",
      keywords: "export backup snapshot state",
      icon: "download",
      action: function () {
        if (typeof window.exportBackupSnapshot === "function") {
          window.exportBackupSnapshot();
        }
      },
    },
    {
      label: "Sync Wishlist Deals",
      keywords: "sync wishlist deals refresh",
      icon: "refresh-cw",
      action: function () {
        var btn = document.getElementById("deals-wishlist-sync-btn");
        if (btn) btn.click();
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // Open / Close
  // ---------------------------------------------------------------------------
  function isOpen() {
    return paletteEl && !paletteEl.classList.contains("hidden");
  }

  function openPalette() {
    if (!paletteEl || !inputEl) return;
    // Save the currently focused element so focus can be restored on close.
    if (typeof window.saveFocus === "function") window.saveFocus();
    paletteEl.classList.remove("hidden");
    paletteEl.setAttribute("aria-hidden", "false");
    inputEl.setAttribute("aria-expanded", "true");
    inputEl.value = "";
    renderDefaultItems();
    inputEl.focus();
    // Trap Tab/Shift+Tab focus within the palette while it is open.
    paletteEl.addEventListener("keydown", paletteKeydownHandler);
  }

  function closePalette() {
    if (!paletteEl) return;
    paletteEl.classList.add("hidden");
    paletteEl.setAttribute("aria-hidden", "true");
    inputEl.setAttribute("aria-expanded", "false");
    inputEl.setAttribute("aria-activedescendant", "");
    activeIndex = -1;
    if (resultsEl) resultsEl.innerHTML = "";
    paletteEl.removeEventListener("keydown", paletteKeydownHandler);
    // Restore focus to the element that opened the palette.
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  }

  // Trap Tab/Shift+Tab focus within the command palette while it is open.
  function paletteKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") {
      window.trapFocus(paletteEl, e);
    }
  }

  function togglePalette() {
    if (isOpen()) {
      closePalette();
    } else {
      openPalette();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering (off-DOM assembly, single injection)
  // ---------------------------------------------------------------------------
  function renderItems(list) {
    if (!resultsEl) return;
    items = list;
    activeIndex = list.length ? 0 : -1;

    if (!list.length) {
      resultsEl.innerHTML =
        '<div class="p-4 text-center text-xs text-slate-500 font-semibold">No matching commands or games found.</div>';
      inputEl.setAttribute("aria-activedescendant", "");
      return;
    }

    var html = "";
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var selected = i === activeIndex;
      html +=
        '<div id="' +
        it.id +
        '" role="option" aria-selected="' +
        selected +
        '" data-palette-index="' +
        i +
        '" class="palette-option flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors ' +
        (selected ? "bg-brand-600/20 text-white" : "text-slate-300 hover:bg-slate-800") +
        '">' +
        '<i data-lucide="' +
        it.icon +
        '" class="w-4 h-4 shrink-0 ' +
        (selected ? "text-brand-400" : "text-slate-500") +
        '"></i>' +
        '<div class="min-w-0 flex-1">' +
        '<p class="text-sm font-semibold truncate">' +
        it.label +
        "</p>" +
        (it.sublabel
          ? '<p class="text-[11px] text-slate-500 truncate">' + it.sublabel + "</p>"
          : "") +
        "</div>" +
        "</div>";
    }

    resultsEl.innerHTML = html;
    inputEl.setAttribute("aria-activedescendant", list[activeIndex].id);
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function renderDefaultItems() {
    var list = [];
    NAV_COMMANDS.forEach(function (c) {
      list.push({
        id: "palette-cmd-" + slugify(c.label),
        label: c.label,
        sublabel: "Navigate",
        icon: c.icon,
        action: function () {
          window.location.hash = c.route;
        },
      });
    });
    QUICK_ACTIONS.forEach(function (q) {
      list.push({
        id: "palette-cmd-" + slugify(q.label),
        label: q.label,
        sublabel: "Quick action",
        icon: q.icon,
        action: q.action,
      });
    });
    renderItems(list);
  }

  function slugify(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // ---------------------------------------------------------------------------
  // Live Game Fuzzy Search
  // ---------------------------------------------------------------------------
  function runSearch(query) {
    clearTimeout(searchDebounceTimer);
    if (!query) {
      renderDefaultItems();
      return;
    }

    // Filter static commands first (label + keywords match) and render them
    // immediately so keyboard selection works before the debounced fetch lands.
    var staticMatches = [];
    NAV_COMMANDS.forEach(function (c) {
      if (matchesQuery(c.label + " " + c.keywords, query)) {
        staticMatches.push({
          id: "palette-cmd-" + slugify(c.label),
          label: c.label,
          sublabel: "Navigate",
          icon: c.icon,
          action: function () {
            window.location.hash = c.route;
          },
        });
      }
    });
    QUICK_ACTIONS.forEach(function (q) {
      if (matchesQuery(q.label + " " + q.keywords, query)) {
        staticMatches.push({
          id: "palette-cmd-" + slugify(q.label),
          label: q.label,
          sublabel: "Quick action",
          icon: q.icon,
          action: q.action,
        });
      }
    });
    renderItems(staticMatches);

    searchDebounceTimer = setTimeout(function () {
      fetch("/api/games?search=" + encodeURIComponent(query))
        .then(function (res) {
          if (!res.ok) throw new Error("Search failed");
          return res.json();
        })
        .then(function (data) {
          var games = (data && data.games) || [];
          var gameItems = games.slice(0, 6).map(function (g) {
            var title = g["Game Title"] || g.gameTitle || g.title || "Game";
            var genre = g["Primary Genre"] || g.primaryGenre || "Game";
            return {
              id: "palette-game-" + slugify(title),
              label: title,
              sublabel: genre,
              icon: "gamepad-2",
              action: function () {
                if (typeof window.openGameDetailDrawer === "function") {
                  var gid = g.gameId || g.gameID || g.id || g.GameID || "";
                  window.openGameDetailDrawer(title, gid);
                }
              },
            };
          });
          renderItems(staticMatches.concat(gameItems));
        })
        .catch(function (err) {
          console.error("Palette search error:", err);
          renderItems(staticMatches);
        });
    }, 250);
  }

  function matchesQuery(text, query) {
    return text.toLowerCase().indexOf(query.toLowerCase()) !== -1;
  }

  // ---------------------------------------------------------------------------
  // Keyboard Navigation
  // ---------------------------------------------------------------------------
  function moveActive(delta) {
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    updateActiveHighlight();
  }

  function updateActiveHighlight() {
    if (!resultsEl) return;
    var options = resultsEl.querySelectorAll(".palette-option");
    options.forEach(function (opt, i) {
      var selected = i === activeIndex;
      opt.setAttribute("aria-selected", String(selected));
      opt.className =
        "palette-option flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors " +
        (selected ? "bg-brand-600/20 text-white" : "text-slate-300 hover:bg-slate-800");
      var icon = opt.querySelector("i");
      if (icon) {
        icon.className = "w-4 h-4 shrink-0 " + (selected ? "text-brand-400" : "text-slate-500");
      }
    });
    if (activeIndex >= 0 && items[activeIndex]) {
      inputEl.setAttribute("aria-activedescendant", items[activeIndex].id);
      var activeEl = resultsEl.querySelector('[data-palette-index="' + activeIndex + '"]');
      if (activeEl && activeEl.scrollIntoView) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function selectActive() {
    if (activeIndex >= 0 && items[activeIndex]) {
      var action = items[activeIndex].action;
      closePalette();
      if (typeof action === "function") action();
    }
  }

  // ---------------------------------------------------------------------------
  // Event Wiring
  // ---------------------------------------------------------------------------
  function init() {
    if (!paletteEl || !inputEl || !resultsEl) return;

    // Global keyboard shortcut: Ctrl+K / Cmd+K toggles; Escape closes.
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (e.key === "Escape" && isOpen()) {
        e.preventDefault();
        closePalette();
        return;
      }
      if (!isOpen()) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectActive();
      }
    });

    // Live search on input.
    inputEl.addEventListener("input", function (e) {
      runSearch(e.target.value.trim());
    });

    // Backdrop click closes.
    if (backdropEl) {
      backdropEl.addEventListener("click", closePalette);
    }

    // Sprint 3 (WUD-3.1 / EPICUX01): any [data-palette-open] control (the
    // global search FAB and the left-rail search button) opens the palette.
    document.querySelectorAll("[data-palette-open]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openPalette();
      });
    });

    // Delegated click selection on results.
    resultsEl.addEventListener("click", function (e) {
      var opt = e.target.closest(".palette-option");
      if (!opt) return;
      var idx = parseInt(opt.getAttribute("data-palette-index"), 10);
      if (!isNaN(idx) && items[idx]) {
        var action = items[idx].action;
        closePalette();
        if (typeof action === "function") action();
      }
    });

    // Expose hooks for Playwright E2E tests.
    window.toggleCommandPalette = togglePalette;
    window.openCommandPalette = openPalette;
    window.closeCommandPalette = closePalette;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
