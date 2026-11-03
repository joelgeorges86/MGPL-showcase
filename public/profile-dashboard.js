// Sprint 3 (WUD-3.3 / EPICUX03 + EPICEOT03) — Gamer Profile Foundations &
// Privacy Integration. Self-contained module (loaded with `defer` after
// settings.js / profile.js) that renders the #/profile route:
//
//   - Profile header: avatar (image or initials), display name, @gamerTag and
//     a profileVisibility badge (Private by default — the DB is authoritative).
//   - Local privacy dashboard: privacy-minimized disclosure, local-first data residency,
//     and a shortcut to the Settings > Profile & Privacy panel.
//   - Lifetime summary stats + achievement showcase grid.
//   - Play-history timeline (AppTracking-derived, newest first).
//
// Exposes window.__profileDashboard = { init, refresh } for the router and the
// E2E suite.
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

  function isAuthenticated() {
    return !!(
      window.__auth &&
      typeof window.__auth.getCurrentUser === "function" &&
      window.__auth.getCurrentUser()
    );
  }

  function initialsFor(displayName, gamerTag) {
    var seed = displayName || gamerTag || "G";
    return seed
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (w) {
        return w[0] ? w[0].toUpperCase() : "";
      })
      .join("");
  }

  function formatDate(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return esc(value);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function statusBadge(status) {
    if (!status) return "";
    var lower = String(status).toLowerCase();
    var color = lower.includes("completed")
      ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/25"
      : lower.includes("playing") || lower.includes("active")
        ? "text-sky-400 bg-sky-500/10 border-sky-500/25"
        : "text-slate-400 bg-slate-500/10 border-slate-600/30";
    return (
      '<span class="px-2 py-0.5 rounded-md border text-[10px] font-black uppercase tracking-wider ' +
      color +
      '">' +
      esc(status) +
      "</span>"
    );
  }

  function avatarHtml(profile) {
    if (profile.avatarUrl) {
      return (
        '<img src="' +
        esc(profile.avatarUrl) +
        '" alt="" class="h-16 w-16 rounded-full object-cover border-2 border-slate-700" loading="lazy" referrerpolicy="no-referrer" />'
      );
    }
    return (
      '<span class="flex h-16 w-16 items-center justify-center rounded-full bg-brand-600 text-white text-xl font-black border-2 border-slate-700 shadow-inner">' +
      esc(initialsFor(profile.displayName, profile.gamerTag)) +
      "</span>"
    );
  }

  function renderHeader(profile) {
    var isPublic = profile.profileVisibility === "public";
    var visibilityBadge = isPublic
      ? '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[10px] font-black uppercase tracking-wider"><i data-lucide="globe" class="w-3 h-3"></i>Public</span>'
      : '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[10px] font-black uppercase tracking-wider"><i data-lucide="lock" class="w-3 h-3"></i>Private</span>';
    return (
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col sm:flex-row items-center sm:items-center gap-5">' +
      avatarHtml(profile) +
      '<div class="flex-1 text-center sm:text-left">' +
      '<h2 class="text-xl font-extrabold text-white">' +
      esc(profile.displayName || "Gamer") +
      "</h2>" +
      '<p class="text-xs text-slate-400 font-semibold mt-0.5">' +
      (profile.gamerTag ? "@" + esc(profile.gamerTag) : "No @gamerTag yet") +
      "</p>" +
      '<div class="mt-2 flex flex-wrap items-center justify-center sm:justify-start gap-2">' +
      visibilityBadge +
      '<span class="text-[10px] text-slate-500 font-medium">Local-first profile · privacy-minimized</span>' +
      "</div>" +
      "</div>" +
      '<button id="btn-edit-profile" type="button" class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-all active:scale-95"><i data-lucide="settings" class="w-4 h-4"></i>Manage Profile</button>' +
      "</div>"
    );
  }

  function renderPrivacy(profile) {
    var isPublic = profile.profileVisibility === "public";
    return (
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl" data-testid="privacy-dashboard">' +
      '<div class="flex items-center gap-2 mb-3">' +
      '<i data-lucide="shield" class="w-4 h-4 text-emerald-400"></i>' +
      '<h3 class="text-sm font-bold text-white">Local Privacy Dashboard</h3>' +
      "</div>" +
      '<p class="text-xs text-slate-400 leading-relaxed mb-4">Everything on this dashboard lives in your local SQLite database. No emails, tokens or remote IDs are stored, rendered or exported — profile visibility controls who can view your public page.</p>' +
      '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
      '<div class="bg-slate-950 border border-slate-800 rounded-xl p-4">' +
      '<p class="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">Profile visibility</p>' +
      '<p class="text-sm font-bold ' +
      (isPublic ? "text-emerald-400" : "text-amber-400") +
      '">' +
      (isPublic
        ? "Public — anyone with your @gamerTag can view it"
        : "Private — only you can see this profile") +
      "</p>" +
      "</div>" +
      '<div class="bg-slate-950 border border-slate-800 rounded-xl p-4">' +
      '<p class="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">Data residency</p>' +
      '<p class="text-sm font-semibold text-slate-300">Stored locally · never synced externally</p>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  function renderSummary(summary) {
    if (!summary) return "";
    var stats = [
      {
        label: "Total Hours",
        value: summary.totalHoursPlayed != null ? Math.round(summary.totalHoursPlayed) : 0,
        icon: "clock",
      },
      { label: "Games Tracked", value: summary.totalGames || 0, icon: "library" },
      { label: "Playing", value: summary.gamesPlaying || 0, icon: "play" },
      { label: "Completed", value: summary.gamesCompleted || 0, icon: "trophy" },
      { label: "With Progress", value: summary.achievementsUnlocked || 0, icon: "award" },
    ];
    return (
      '<div class="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="profile-summary">' +
      stats
        .map(function (s) {
          return (
            '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 text-center shadow-xl">' +
            '<i data-lucide="' +
            s.icon +
            '" class="w-4 h-4 mx-auto text-brand-400"></i>' +
            '<p class="text-2xl font-black text-white mt-1">' +
            s.value +
            "</p>" +
            '<p class="text-[10px] font-bold uppercase tracking-wider text-slate-500">' +
            s.label +
            "</p>" +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderAchievements(achievements) {
    if (!Array.isArray(achievements) || achievements.length === 0) {
      return (
        '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl" data-testid="achievement-showcase">' +
        '<div class="flex items-center gap-2 mb-2"><i data-lucide="trophy" class="w-4 h-4 text-amber-400"></i><h3 class="text-sm font-bold text-white">Achievement Showcase</h3></div>' +
        '<p class="text-xs text-slate-500 italic">No achievements unlocked yet — complete games or sync a storefront to fill this grid.</p>' +
        "</div>"
      );
    }
    return (
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl" data-testid="achievement-showcase">' +
      '<div class="flex items-center gap-2 mb-4"><i data-lucide="trophy" class="w-4 h-4 text-amber-400"></i><h3 class="text-sm font-bold text-white">Achievement Showcase</h3></div>' +
      '<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">' +
      achievements
        .map(function (a) {
          var pct = a.trophyProgress != null ? a.trophyProgress : a.completedDate ? 100 : 0;
          var ringColor =
            pct >= 100 ? "text-emerald-400" : pct >= 50 ? "text-brand-400" : "text-amber-400";
          return (
            '<a href="#/game/' +
            encodeURIComponent(a.gameId) +
            '" class="bg-slate-950 border border-slate-800 hover:border-brand-500/40 rounded-xl p-4 flex items-center gap-3 transition-all" data-achievement-game="' +
            esc(a.gameId) +
            '">' +
            '<div class="flex items-center justify-center w-12 h-12 rounded-full border-2 ' +
            (pct >= 100 ? "border-emerald-500/50" : "border-slate-700") +
            " text-lg font-black " +
            ringColor +
            '">' +
            pct +
            "%</div>" +
            '<div class="min-w-0 flex-1">' +
            '<p class="text-xs font-bold text-white truncate">' +
            esc(a.title) +
            "</p>" +
            '<div class="mt-1 flex flex-wrap gap-1.5 items-center">' +
            (a.personalRating != null
              ? '<span class="text-[10px] font-bold text-amber-300">★ ' +
                a.personalRating +
                "/10</span>"
              : "") +
            (a.completedDate
              ? '<span class="text-[10px] text-slate-500 font-medium">Completed ' +
                esc(a.completedDate) +
                "</span>"
              : "") +
            "</div>" +
            "</div>" +
            statusBadge(a.playStatus) +
            "</a>"
          );
        })
        .join("") +
      "</div>" +
      "</div>"
    );
  }

  function renderPlayHistory(history) {
    var empty =
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl" data-testid="play-history">' +
      '<div class="flex items-center gap-2 mb-2"><i data-lucide="history" class="w-4 h-4 text-sky-400"></i><h3 class="text-sm font-bold text-white">Play History Timeline</h3></div>' +
      '<p class="text-xs text-slate-500 italic">No play history yet — start a session or import your library.</p>' +
      "</div>";
    if (!Array.isArray(history) || history.length === 0) return empty;
    return (
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl" data-testid="play-history">' +
      '<div class="flex items-center gap-2 mb-4"><i data-lucide="history" class="w-4 h-4 text-sky-400"></i><h3 class="text-sm font-bold text-white">Play History Timeline</h3></div>' +
      '<ol class="relative border-l border-slate-800 ml-2 space-y-5">' +
      history
        .map(function (h) {
          return (
            '<li class="ml-5" data-history-game="' +
            esc(h.gameId) +
            '">' +
            '<span class="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-brand-500 border-2 border-slate-900"></span>' +
            '<div class="flex flex-wrap items-center justify-between gap-2">' +
            '<a href="#/game/' +
            encodeURIComponent(h.gameId) +
            '" class="text-sm font-bold text-white hover:text-brand-400 transition-colors">' +
            esc(h.title) +
            "</a>" +
            '<span class="text-[10px] text-slate-500 font-semibold">' +
            formatDate(h.lastPlayedAt) +
            "</span>" +
            "</div>" +
            '<div class="mt-1 flex flex-wrap items-center gap-2">' +
            (h.hoursPlayed > 0
              ? '<span class="text-xs text-slate-400 font-semibold">' +
                h.hoursPlayed +
                "h played</span>"
              : "") +
            (h.platform
              ? '<span class="text-[10px] text-slate-500 font-medium">' +
                esc(h.platform) +
                "</span>"
              : "") +
            statusBadge(h.playStatus) +
            "</div>" +
            "</li>"
          );
        })
        .join("") +
      "</ol>" +
      "</div>"
    );
  }

  function renderRecentSessions(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return "";
    return (
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl" data-testid="recent-sessions">' +
      '<div class="flex items-center gap-2 mb-4"><i data-lucide="activity" class="w-4 h-4 text-violet-400"></i><h3 class="text-sm font-bold text-white">Recent Sessions</h3></div>' +
      '<div class="space-y-2">' +
      sessions
        .map(function (s) {
          var mins = Math.round((s.durationSeconds || 0) / 60);
          return (
            '<div class="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-4 py-3" data-session-game="' +
            esc(s.gameId) +
            '">' +
            '<span class="text-xs font-bold text-white truncate">' +
            esc(s.title || s.gameId) +
            "</span>" +
            '<span class="text-[10px] text-slate-500 font-semibold">' +
            mins +
            "m · " +
            formatDate(s.startedAt) +
            "</span>" +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      "</div>"
    );
  }

  function render(data) {
    var root = document.getElementById("profile-dashboard-root");
    if (!root) return;
    var profile = (data && data.profile) || {};
    root.innerHTML =
      renderHeader(profile) +
      renderPrivacy(profile) +
      renderSummary(data.summary) +
      renderAchievements(data.achievements) +
      renderPlayHistory(data.playHistory) +
      renderRecentSessions(data.recentSessions);
    refreshIcons();

    var editBtn = document.getElementById("btn-edit-profile");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        if (window.__settings && typeof window.__settings.open === "function") {
          window.__settings.open("profile");
        } else {
          window.location.hash = "#/settings";
        }
      });
    }
  }

  function refresh() {
    var root = document.getElementById("profile-dashboard-root");
    if (!root) return Promise.resolve();
    if (!isAuthenticated()) {
      root.innerHTML =
        '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-xl">' +
        '<i data-lucide="user" class="w-8 h-8 mx-auto text-slate-500"></i>' +
        '<p class="text-sm font-bold text-white mt-3">Sign in to view your gamer profile</p>' +
        '<p class="text-xs text-slate-500 mt-1">Your profile, achievements and play history live on this device only.</p>' +
        "</div>";
      refreshIcons();
      return Promise.resolve();
    }
    root.innerHTML =
      '<div class="flex items-center justify-center py-16"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500"></div></div>';
    return fetch(API_BASE + "/api/profile/dashboard", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        render(data);
        return data;
      })
      .catch(function (err) {
        root.innerHTML =
          '<div class="bg-slate-900 border border-rose-500/30 rounded-2xl p-6 text-center shadow-xl">' +
          '<p class="text-sm font-bold text-rose-400">Failed to load your profile dashboard.</p>' +
          '<p class="text-xs text-slate-500 mt-1">Please refresh the page and try again.</p>' +
          "</div>";
        console.error("[profile-dashboard] load error:", err);
      });
  }

  function init() {
    refresh();
  }

  window.__profileDashboard = {
    init: init,
    refresh: refresh,
  };

  document.addEventListener("mgpl:auth-changed", function () {
    if (
      !document.getElementById("page-profile") ||
      document.getElementById("page-profile").classList.contains("hidden")
    )
      return;
    refresh();
  });
})();
