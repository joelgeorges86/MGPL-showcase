// Sprint 3 (WUD-3.2 / EPICUX02 + EPICEOT04) — Game Discovery 2.0.
// Self-contained module (loaded with `defer` after app.js) that drives the
// #/discovery route:
//
//   - Mood selector (cozy / story / focused / fast / immersive). Selecting a
//     mood NEVER recomputes — rails only build on the explicit "Generate my
//     rails" action (Explicit Action Trigger Rule, Ch. 23).
//   - POST /api/discovery/rails returns personalized recommendation rails.
//   - "Surprise Me" -> POST /api/discovery/surprise returns a single seeded
//     pick rendered in the same unified game card contract as the rails.
//
// Exposes window.__discovery = { init, renderRails, renderSurprise } for the
// router (app.js) and the E2E suite.
(function () {
  "use strict";

  var API_BASE = "";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function apiPost(url, data) {
    return fetch(API_BASE + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data || {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Unified game card renderer (WUD-3.2 "unified game page" contract). The same
  // markup shape is used for rails and the surprise pick so one card renderer
  // covers every discovery surface. Clicking a card deep-links to #/game/:id.
  // ---------------------------------------------------------------------------
  function gameCardHtml(card) {
    var title = esc(card.title || "Untitled Game");
    var cover = card.coverUrl || "";
    var coverHtml = cover
      ? '<img src="' +
        esc(cover) +
        '" alt="" loading="lazy" class="w-full h-full object-cover" onerror="this.closest(\'.disc-card-cover\').innerHTML=\'<div class=\\\'w-full h-full bg-gray-900 flex items-center justify-center p-2 text-center text-xs text-gray-400 font-semibold\\\'>' +
        title +
        "</div>'\" />"
      : '<div class="w-full h-full bg-gray-900 flex items-center justify-center p-2 text-center text-xs text-gray-400 font-semibold">' +
        title +
        "</div>";

    var genres =
      Array.isArray(card.genres) && card.genres.length
        ? card.genres
        : card.primaryGenre
          ? [card.primaryGenre]
          : [];
    var genreHtml = genres
      .slice(0, 3)
      .map(function (g) {
        return (
          '<span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[9px] font-bold uppercase tracking-wide">' +
          esc(g) +
          "</span>"
        );
      })
      .join("");

    var reasons = (Array.isArray(card.reasonTags) ? card.reasonTags : [])
      .map(function (t) {
        return (
          '<span class="text-[10px] font-semibold text-brand-300">#' +
          esc(t).replace(/\s+/g, "-").toLowerCase() +
          "</span>"
        );
      })
      .join(" ");

    var meta = [];
    if (card.matchScore != null)
      meta.push(
        '<span class="text-brand-400 font-black text-sm">' +
          Math.round(card.matchScore) +
          "%</span>",
      );
    if (card.hoursPlayed > 0)
      meta.push(
        '<span class="text-slate-400 text-[10px] font-semibold">' +
          card.hoursPlayed +
          "h played</span>",
      );
    if (card.playStatus)
      meta.push(
        '<span class="text-slate-500 text-[10px] font-semibold uppercase">' +
          esc(card.playStatus) +
          "</span>",
      );
    if (card.mainStoryHours != null)
      meta.push(
        '<span class="text-slate-500 text-[10px] font-semibold">~' +
          card.mainStoryHours +
          "h main</span>",
      );

    return (
      '<a href="#/game/' +
      encodeURIComponent(card.gameId) +
      '" class="group block bg-slate-900/60 border border-slate-800 hover:border-brand-500/40 rounded-2xl overflow-hidden shadow-xl transition-all hover:scale-[1.02] hover:-translate-y-0.5" data-game-id="' +
      esc(card.gameId) +
      '">' +
      '<div class="disc-card-cover aspect-[3/4] bg-slate-950 overflow-hidden">' +
      coverHtml +
      "</div>" +
      '<div class="p-3 space-y-2">' +
      '<h4 class="font-bold text-white text-xs truncate group-hover:text-brand-400 transition-colors" title="' +
      title +
      '">' +
      title +
      "</h4>" +
      (genreHtml ? '<div class="flex flex-wrap gap-1">' + genreHtml + "</div>" : "") +
      (reasons ? '<div class="flex flex-wrap gap-x-2 gap-y-0.5">' + reasons + "</div>" : "") +
      '<div class="flex items-center justify-between pt-1">' +
      meta.join("") +
      "</div>" +
      "</div>" +
      "</a>"
    );
  }

  function railCardGrid(cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
      return '<p class="text-xs text-slate-500 italic">No matches for this rail.</p>';
    }
    return (
      '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">' +
      cards.map(gameCardHtml).join("") +
      "</div>"
    );
  }

  function renderRails(data) {
    var container = document.getElementById("discovery-rails");
    if (!container) return;
    var rails = (data && Array.isArray(data.rails) && data.rails) || [];
    if (rails.length === 0) {
      container.innerHTML =
        '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">' +
        '<p class="text-sm text-slate-400 font-semibold">No rails could be built yet.</p>' +
        '<p class="text-xs text-slate-500 mt-1">Add games to your library and try again.</p>' +
        "</div>";
      refreshIcons();
      return;
    }
    container.innerHTML = rails
      .map(function (rail) {
        return (
          '<section class="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl" data-rail-id="' +
          esc(rail.railId) +
          '">' +
          '<div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">' +
          '<h3 class="text-sm font-extrabold text-white flex items-center gap-2"><i data-lucide="sparkles" class="w-4 h-4 text-brand-400"></i>' +
          esc(rail.title) +
          "</h3>" +
          (rail.reason
            ? '<span class="text-[10px] text-slate-500 font-medium">' + esc(rail.reason) + "</span>"
            : "") +
          "</div>" +
          railCardGrid(rail.games) +
          "</section>"
        );
      })
      .join("");
    refreshIcons();
  }

  function renderSurprise(data) {
    var container = document.getElementById("discovery-surprise");
    if (!container) return;
    var game = data && data.game;
    if (!game) {
      container.classList.remove("hidden");
      container.innerHTML =
        '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">' +
        '<p class="text-sm text-slate-400 font-semibold">No surprise available — your library looks empty.</p>' +
        "</div>";
      return;
    }
    container.classList.remove("hidden");
    container.innerHTML =
      '<div class="bg-gradient-to-r from-slate-900 to-slate-950 border border-brand-500/30 rounded-2xl p-5 shadow-xl">' +
      '<div class="mb-3 flex items-center gap-2">' +
      '<i data-lucide="dices" class="w-4 h-4 text-brand-400"></i>' +
      '<h3 class="text-sm font-extrabold text-white">Surprise pick for you</h3>' +
      (data.seed != null
        ? '<span class="ml-auto text-[10px] text-slate-500 font-semibold">seed ' +
          data.seed +
          "</span>"
        : "") +
      "</div>" +
      '<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 max-w-4xl">' +
      gameCardHtml(game) +
      "</div>" +
      "</div>";
    refreshIcons();
  }

  function setStatus(text) {
    var status = document.getElementById("discovery-status");
    if (status) status.textContent = text || "";
  }

  function buildRails() {
    var selected = getSelectedMood();
    setStatus("Building your rails…");
    return apiPost("/api/discovery/rails", { mood: selected })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderRails(data);
        setStatus("");
        return data;
      })
      .catch(function (err) {
        renderRails({ rails: [] });
        setStatus("Failed to build rails. Please try again.");
        console.error("[discovery] rails error:", err);
      });
  }

  function surpriseMe() {
    setStatus("Rolling the dice…");
    return apiPost("/api/discovery/surprise", {})
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderSurprise(data);
        setStatus("");
        return data;
      })
      .catch(function (err) {
        setStatus("Failed to pick a surprise game. Please try again.");
        console.error("[discovery] surprise error:", err);
      });
  }

  function getSelectedMood() {
    var active = document.querySelector(".discovery-mood-btn[aria-pressed='true']");
    return active ? active.getAttribute("data-mood") || "cozy" : "cozy";
  }

  function highlightMood(mood) {
    document.querySelectorAll(".discovery-mood-btn").forEach(function (btn) {
      var isActive = btn.getAttribute("data-mood") === mood;
      btn.setAttribute("aria-pressed", String(isActive));
      btn.className =
        "discovery-mood-btn flex flex-col items-center gap-1.5 px-3 py-4 rounded-xl border text-xs font-semibold transition-all active:scale-95 " +
        (isActive
          ? "border-brand-400 bg-brand-500/20 text-white"
          : "border-slate-700 bg-slate-950 text-slate-300 hover:border-brand-400 hover:text-white");
    });
  }

  function init() {
    var moodsContainer = document.getElementById("discovery-moods");
    var buildBtn = document.getElementById("btn-build-rails");
    var surpriseBtn = document.getElementById("btn-surprise-me");
    if (!moodsContainer || !buildBtn) return;

    // Default selection (cozy) is deterministic for the E2E suite.
    highlightMood("cozy");

    moodsContainer.addEventListener("click", function (e) {
      var btn = e.target.closest(".discovery-mood-btn");
      if (!btn) return;
      highlightMood(btn.getAttribute("data-mood"));
    });

    buildBtn.addEventListener("click", function () {
      buildRails();
    });

    if (surpriseBtn) {
      surpriseBtn.addEventListener("click", function () {
        surpriseMe();
      });
    }
  }

  window.__discovery = {
    init: init,
    renderRails: renderRails,
    renderSurprise: renderSurprise,
    buildRails: buildRails,
    surpriseMe: surpriseMe,
    getSelectedMood: getSelectedMood,
    highlightMood: highlightMood,
  };

  // Wire once the DOM is ready (script loads with defer, so it usually is).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
