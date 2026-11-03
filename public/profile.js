/* MGPL Storefront Profile Sync (Sprint 2 / WUD-2.1 / EPIC-01)
 *
 * Self-contained module (loaded with `defer` after auth.js and settings.js)
 * that renders the Storefront Profile Sync panel inside the Settings drawer's
 * Connected Accounts tab:
 *
 *   - Connect a storefront (Steam / Xbox / PSN / Epic / GOG / Ubisoft) with a
 *     public ID + token -> state flips to "Connected" with a masked handle.
 *   - Disconnect a storefront and run an on-demand profile sync.
 *   - "Hide Platform IDs" toggle masks every handle across public profile views
 *     immediately (server-authoritative via /api/profile-sync/visibility).
 *
 * privacy-minimized contract: this module never renders tokens, emails, real names or
 * remote telemetry IDs. Tokens are submitted to the server once for encrypted
 * at-rest storage in the local SQLite WAL and never returned.
 *
 * Exposes window.__profile = { refresh, connect, disconnect, sync, toggleHide,
 * maskHandle } for settings.js and the E2E suite.
 */
(function () {
  "use strict";

  var API_BASE = "";

  var PLATFORM_META = {
    steam: { label: "Steam", icon: "steam", color: "text-sky-400" },
    psn: { label: "PlayStation Network", icon: "gamepad-2", color: "text-indigo-400" },
    xbox: { label: "Xbox Live", icon: "gamepad", color: "text-emerald-400" },
    epic: { label: "Epic Games", icon: "layers", color: "text-violet-400" },
    gog: { label: "GOG Galaxy", icon: "package", color: "text-amber-400" },
    ubisoft: { label: "Ubisoft Connect", icon: "shield", color: "text-cyan-400" },
  };

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

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function apiFetch(url, options) {
    return fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
  }

  function isAuthenticated() {
    return !!(
      window.__auth &&
      typeof window.__auth.getCurrentUser === "function" &&
      window.__auth.getCurrentUser()
    );
  }

  /** Client mirror of the server maskHandle: first + last char, bullets between. */
  function maskHandle(handle) {
    var s = String(handle == null ? "" : handle).trim();
    if (!s) return "";
    if (s.length <= 2) return "••••";
    var bullets = Math.min(4, Math.max(2, s.length - 2));
    return s[0] + new Array(bullets + 1).join("•") + s[s.length - 1];
  }

  function loadState() {
    return apiFetch(API_BASE + "/api/profile-sync/platforms").then(function (res) {
      if (!res.ok) throw new Error("Request failed: " + res.status);
      return res.json();
    });
  }

  function platformRow(platform, _data) {
    var meta = PLATFORM_META[platform.platform] || {
      label: platform.label || platform.platform,
      icon: "link",
      color: "text-slate-300",
    };
    var badge = platform.connected
      ? '<span class="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 text-[10px] font-black uppercase tracking-wider" data-sync-connected>Connected</span>'
      : '<span class="px-2 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-bold uppercase tracking-wider" data-sync-disconnected>Not connected</span>';

    var actions;
    if (platform.connected) {
      var handleText = platform.displayHandle
        ? esc(platform.displayHandle)
        : '<span class="text-slate-500">—</span>';
      actions =
        '<div class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">' +
        '<span class="text-[10px] font-semibold text-slate-400" data-sync-handle>' +
        handleText +
        "</span>" +
        '<div class="flex items-center gap-2">' +
        '<button type="button" data-sync-action="sync" data-sync-platform="' +
        esc(platform.platform) +
        '" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold border border-slate-700 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Sync</button>' +
        '<button type="button" data-sync-action="disconnect" data-sync-platform="' +
        esc(platform.platform) +
        '" class="px-2.5 py-1.5 rounded-lg bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 text-[11px] font-bold border border-rose-500/30 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">Disconnect</button>' +
        "</div>" +
        "</div>";
    } else {
      actions =
        '<button type="button" data-sync-action="connect" data-sync-platform="' +
        esc(platform.platform) +
        '" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-[11px] font-bold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Connect</button>';
    }

    return (
      '<div class="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" data-sync-row data-sync-platform="' +
      esc(platform.platform) +
      '">' +
      '<div class="flex items-center gap-2.5 min-w-0">' +
      '<i data-lucide="' +
      esc(meta.icon) +
      '" class="w-4 h-4 ' +
      esc(meta.color) +
      ' shrink-0"></i>' +
      '<div class="min-w-0">' +
      '<p class="text-xs font-bold text-white truncate">' +
      esc(meta.label) +
      "</p>" +
      "</div>" +
      "</div>" +
      '<div class="flex items-center justify-between gap-3 shrink-0">' +
      badge +
      actions +
      "</div>" +
      "</div>"
    );
  }

  function connectFormHtml(platform) {
    var meta = PLATFORM_META[platform.platform] || { label: platform.label };
    return (
      '<div class="rounded-xl border border-brand-500/30 bg-slate-950 p-3 space-y-2" data-connect-form data-sync-platform="' +
      esc(platform.platform) +
      '">' +
      '<p class="text-[11px] font-bold text-white">Connect ' +
      esc(meta.label) +
      "</p>" +
      '<input type="text" data-connect-publicid placeholder="Public ID / username" autocomplete="off" maxlength="64" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all" />' +
      '<input type="password" data-connect-token placeholder="API token (encrypted locally)" autocomplete="off" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all" />' +
      '<div class="flex items-center gap-2">' +
      '<button type="button" data-connect-submit class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-[11px] font-bold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Connect</button>' +
      '<button type="button" data-connect-cancel class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500">Cancel</button>' +
      "</div>" +
      '<p data-connect-status class="text-[10px] font-medium text-slate-500"></p>' +
      "</div>"
    );
  }

  function render(container, data) {
    var hide = !!data.hidePlatformIds;
    var html =
      '<div class="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5">' +
      '<div class="min-w-0">' +
      '<p class="text-xs font-bold text-white">Hide Platform IDs</p>' +
      '<p class="text-[10px] text-slate-500">Mask your storefront handles across public profile views.</p>' +
      "</div>" +
      '<label class="relative inline-flex items-center cursor-pointer shrink-0">' +
      '<input type="checkbox" data-hide-platform-ids class="sr-only peer"' +
      (hide ? " checked" : "") +
      ' aria-label="Hide Platform IDs" />' +
      "<span class=\"w-10 h-5 bg-slate-700 rounded-full peer-checked:bg-brand-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5\"></span>" +
      "</label>" +
      "</div>";

    if (!data.encryptionConfigured) {
      html +=
        '<div class="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">' +
        '<p class="text-[10px] font-semibold text-amber-300">Local token encryption key is not configured. Connecting storefronts is blocked until MGPL_TOKEN_ENC_KEY is set.</p>' +
        "</div>";
    }

    html += (data.platforms || [])
      .map(function (p) {
        return platformRow(p, data);
      })
      .join("");

    container.innerHTML = html;
    refreshIcons();

    var hideToggle = container.querySelector("[data-hide-platform-ids]");
    if (hideToggle) {
      hideToggle.addEventListener("change", function () {
        toggleHide(hideToggle.checked);
      });
    }

    container.querySelectorAll("[data-sync-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var platform = btn.getAttribute("data-sync-platform");
        var action = btn.getAttribute("data-sync-action");
        if (action === "connect") {
          openConnectForm(container, platform);
        } else if (action === "disconnect") {
          disconnect(platform);
        } else if (action === "sync") {
          syncPlatform(platform, btn);
        }
      });
    });
  }

  function openConnectForm(container, platform) {
    container.querySelectorAll("[data-connect-form]").forEach(function (el) {
      el.remove();
    });
    var row = container.querySelector('[data-sync-row][data-sync-platform="' + platform + '"]');
    var form = document.createElement("div");
    form.innerHTML = connectFormHtml({
      platform: platform,
      label: (PLATFORM_META[platform] || {}).label || platform,
    });
    var node = form.firstElementChild;
    if (row && row.parentNode) {
      row.parentNode.insertBefore(node, row.nextSibling);
    } else {
      container.appendChild(node);
    }
    refreshIcons();

    var status = node.querySelector("[data-connect-status]");
    var cancel = node.querySelector("[data-connect-cancel]");
    var submit = node.querySelector("[data-connect-submit]");
    if (cancel)
      cancel.addEventListener("click", function () {
        node.remove();
      });
    if (submit) {
      submit.addEventListener("click", function () {
        var publicId = node.querySelector("[data-connect-publicid]").value.trim();
        var token = node.querySelector("[data-connect-token]").value.trim();
        if (!publicId || !token) {
          if (status) status.textContent = "Public ID and token are required.";
          return;
        }
        if (status) status.textContent = "Connecting…";
        connect(platform, publicId, token).then(function (result) {
          if (status) {
            status.textContent = result.ok ? "" : result.error || "Failed to connect.";
          }
          if (result.ok) {
            node.remove();
            refresh();
          }
        });
      });
    }
  }

  function connect(platform, publicId, token) {
    return apiFetch(API_BASE + "/api/profile-sync/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform, publicId: publicId, token: token }),
    })
      .then(function (res) {
        return res.json().catch(function () {
          return {};
        });
      })
      .then(function (body) {
        if (body && body.success) return { ok: true };
        return { ok: false, error: (body && body.error) || "Failed to connect." };
      })
      .catch(function () {
        return { ok: false, error: "Unable to reach the server." };
      });
  }

  function disconnect(platform) {
    return apiFetch(API_BASE + "/api/profile-sync/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform }),
    })
      .then(function (res) {
        return res.json().catch(function () {
          return {};
        });
      })
      .then(function (body) {
        refresh();
        return !!(body && body.success);
      })
      .catch(function () {
        return false;
      });
  }

  function syncPlatform(platform, btn) {
    if (btn && btn.dataset.busy === "1") return;
    if (btn) {
      btn.dataset.busy = "1";
      btn.textContent = "Syncing…";
    }
    return apiFetch(API_BASE + "/api/profile-sync/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform }),
    })
      .then(function (res) {
        return res.json().catch(function () {
          return {};
        });
      })
      .then(function (body) {
        if (btn) {
          delete btn.dataset.busy;
          btn.textContent = "Sync";
        }
        if (body && body.success) {
          refresh();
        } else if (btn) {
          var statusEl = document.createElement("span");
          statusEl.className = "text-[10px] text-rose-400";
          statusEl.textContent = (body && body.error) || "Sync failed.";
          btn.parentNode.appendChild(statusEl);
        }
        return !!(body && body.success);
      })
      .catch(function () {
        if (btn) {
          delete btn.dataset.busy;
          btn.textContent = "Sync";
        }
        return false;
      });
  }

  function toggleHide(hide) {
    return apiFetch(API_BASE + "/api/profile-sync/visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidePlatformIds: !!hide }),
    })
      .then(function (res) {
        return res.json().catch(function () {
          return {};
        });
      })
      .then(function (body) {
        if (body && body.success) refresh();
        return !!(body && body.success);
      })
      .catch(function () {
        return false;
      });
  }

  function refresh() {
    var container = document.getElementById("settings-profile-sync");
    if (!container) return Promise.resolve();
    if (!isAuthenticated()) {
      container.innerHTML =
        '<p class="text-xs text-slate-500 italic">Sign in to connect storefront profiles.</p>';
      return Promise.resolve();
    }
    container.innerHTML = '<p class="text-xs text-slate-500 italic">Loading sync state…</p>';
    return loadState()
      .then(function (data) {
        render(container, data);
      })
      .catch(function (err) {
        container.innerHTML = '<p class="text-xs text-rose-400">Failed to load sync state.</p>';
        console.error("Storefront sync load error:", err);
      });
  }

  window.__profile = {
    refresh: refresh,
    connect: connect,
    disconnect: disconnect,
    sync: syncPlatform,
    toggleHide: toggleHide,
    maskHandle: maskHandle,
  };
})();
