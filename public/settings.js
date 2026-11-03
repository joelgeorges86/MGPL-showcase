/* MGPL Settings Drawer, Profile Customizer & Social Hub (Sprint 4 / EPIC-PROFILE-0001)
 *
 * Self-contained module (loaded with `defer` after auth.js) that injects an
 * accessible right-side settings drawer into the DOM:
 *
 *   Tab 1 — Profile & Privacy      : displayName / @gamerTag / avatarUrl +
 *                                    profileVisibility toggle -> PATCH /api/user/profile
 *   Tab 2 — Connected Accounts     : Steam/PSN/Xbox/GOG platform handles +
 *                                    active OAuth/OpenID links (Unlink)
 *   Tab 3 — Social & Friends       : incoming requests, suggestions, active friends
 *   Tab 4 — Privacy (EPIC-COMPLIANCE-0001 Sprint 2):
 *                                    Do Not Sell or Share toggle (CCPA/CPRA),
 *                                    Export My Data (JSON) via /api/state/export/me,
 *                                    Delete Account via DELETE /api/users/me.
 *
 * privacy-minimized contract: this drawer NEVER renders or requests physical email
 * addresses, phone numbers, or real names. Every social card is limited to
 * { displayName, gamerTag, avatarUrl, platformHandles }.
 *
 * Accessibility: role="dialog", aria-modal="true", aria-labelledby, ARIA
 * tabs/tabpanels, Escape-to-close, and Tab focus trapping using the app-global
 * window.saveFocus / window.restoreFocus / window.trapFocus helpers.
 *
 * Exposes window.__settings = { open, close, refresh } for Playwright E2E tests.
 */
(function () {
  "use strict";

  var API_BASE = "";
  var drawerRoot = null;
  var els = {};
  var banTimers = {};

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

  // -------------------------------------------------------------------------
  // Drawer markup
  // -------------------------------------------------------------------------

  function drawerMarkup() {
    return (
      '<div id="settings-drawer" class="hidden fixed inset-0 z-[95]" role="dialog" aria-modal="true" aria-labelledby="settings-drawer-title">' +
      '<div id="settings-backdrop" class="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"></div>' +
      '<div class="absolute right-0 top-0 bottom-0 w-full max-w-lg bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col" role="document">' +
      // Header
      '<div class="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">' +
      '<div class="flex items-center gap-2.5">' +
      '<div class="bg-brand-500 p-2 rounded-xl text-white shadow-lg shadow-brand-500/20">' +
      '<i data-lucide="settings" class="w-5 h-5"></i>' +
      "</div>" +
      "<div>" +
      '<h2 id="settings-drawer-title" class="text-lg font-bold text-white">Settings</h2>' +
      '<p class="text-xs text-slate-400">Profile, connected accounts & social hub</p>' +
      "</div>" +
      "</div>" +
      '<button id="btn-settings-close" type="button" aria-label="Close settings drawer" class="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="x" class="w-5 h-5"></i>' +
      "</button>" +
      "</div>" +
      // Tabs
      '<div class="px-5 pt-3 pb-2 shrink-0">' +
      '<div class="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-semibold" role="tablist" aria-label="Settings sections">' +
      '<button id="settings-tab-profile" type="button" role="tab" aria-selected="true" aria-controls="settings-panel-profile" class="settings-tab-btn flex-1 px-2.5 py-1.5 rounded-lg bg-brand-600 text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Profile</button>' +
      '<button id="settings-tab-accounts" type="button" role="tab" aria-selected="false" aria-controls="settings-panel-accounts" class="settings-tab-btn flex-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Accounts</button>' +
      '<button id="settings-tab-social" type="button" role="tab" aria-selected="false" aria-controls="settings-panel-social" class="settings-tab-btn flex-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Social</button>' +
      '<button id="settings-tab-privacy" type="button" role="tab" aria-selected="false" aria-controls="settings-panel-privacy" class="settings-tab-btn flex-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Privacy</button>' +
      "</div>" +
      "</div>" +
      // Feedback banner
      '<div id="settings-banner" class="hidden mx-5 mt-2 px-3 py-2.5 rounded-xl text-xs font-semibold items-center gap-2" role="status" aria-live="polite"></div>' +
      // Scrollable body
      '<div class="flex-1 overflow-y-auto px-5 py-4 space-y-6">' +
      // ---- Tab 1: Profile & Privacy ----
      '<section id="settings-panel-profile" role="tabpanel" aria-labelledby="settings-tab-profile" class="space-y-5">' +
      "<div>" +
      '<h3 class="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">' +
      '<i data-lucide="user" class="w-4 h-4 text-brand-400"></i> Profile Identity</h3>' +
      '<p class="text-xs text-slate-400">Customize how you appear to other MGPL players. Your email is never shown.</p>' +
      "</div>" +
      '<form id="settings-profile-form" class="space-y-3.5">' +
      "<div>" +
      '<label for="settings-display-name" class="block text-xs font-semibold text-slate-400 mb-1">Display Name</label>' +
      '<input id="settings-display-name" name="displayName" type="text" maxlength="60" placeholder="e.g. Alex Gamer" autocomplete="nickname" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="settings-gamertag" class="block text-xs font-semibold text-slate-400 mb-1">@GamerTag</label>' +
      '<input id="settings-gamertag" name="gamerTag" type="text" maxlength="21" placeholder="e.g. @AlexCyber" autocomplete="username" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      '<p class="text-[11px] text-slate-500 mt-1">3–20 alphanumeric characters, underscores or hyphens. Optional leading @.</p>' +
      "</div>" +
      "<div>" +
      '<label for="settings-avatar-url" class="block text-xs font-semibold text-slate-400 mb-1">Avatar URL</label>' +
      '<input id="settings-avatar-url" name="avatarUrl" type="url" maxlength="2048" placeholder="https://..." class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<span class="block text-xs font-semibold text-slate-400 mb-1.5">Profile Visibility</span>' +
      '<div class="flex gap-2" role="radiogroup" aria-label="Profile visibility">' +
      '<label class="cursor-pointer flex-1">' +
      '<input id="settings-visibility-private" type="radio" name="profileVisibility" value="private" class="peer sr-only">' +
      '<span class="flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border border-slate-700 bg-slate-950 text-slate-300 text-xs font-semibold transition-all peer-checked:border-brand-400 peer-checked:text-white peer-checked:bg-brand-500/20">' +
      '<i data-lucide="lock" class="w-4 h-4"></i><span>Private</span>' +
      "</span>" +
      "</label>" +
      '<label class="cursor-pointer flex-1">' +
      '<input id="settings-visibility-public" type="radio" name="profileVisibility" value="public" class="peer sr-only">' +
      '<span class="flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border border-slate-700 bg-slate-950 text-slate-300 text-xs font-semibold transition-all peer-checked:border-emerald-400 peer-checked:text-emerald-200 peer-checked:bg-emerald-500/20">' +
      '<i data-lucide="globe" class="w-4 h-4"></i><span>Public</span>' +
      "</span>" +
      "</label>" +
      "</div>" +
      '<p class="text-[11px] text-slate-500 mt-1">Public profiles appear in friend suggestions and can be found by @gamerTag.</p>' +
      "</div>" +
      '<div class="flex items-center gap-2">' +
      '<button type="submit" id="settings-profile-save" class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-sm font-bold text-white shadow-md shadow-brand-600/15 hover:shadow-brand-500/25 active:scale-[0.98] transition-all disabled:opacity-60 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="save" class="w-4 h-4"></i><span>Save Profile</span>' +
      "</button>" +
      '<button type="button" id="settings-profile-refresh" class="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="refresh-cw" class="w-4 h-4"></i><span>Reload</span>' +
      "</button>" +
      "</div>" +
      "</form>" +
      "</section>" +
      // ---- Tab 2: Connected Accounts & Handles ----
      '<section id="settings-panel-accounts" role="tabpanel" aria-labelledby="settings-tab-accounts" class="hidden space-y-5">' +
      "<div>" +
      '<h3 class="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">' +
      '<i data-lucide="link" class="w-4 h-4 text-brand-400"></i> Platform Handles</h3>' +
      '<p class="text-xs text-slate-400">Share your storefront handles so friends can find you and suggestions match shared platforms.</p>' +
      "</div>" +
      '<form id="settings-handles-form" class="space-y-3.5">' +
      '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
      "<div>" +
      '<label for="handle-steam" class="block text-xs font-semibold text-slate-400 mb-1">Steam Username</label>' +
      '<input id="handle-steam" name="steamUsername" type="text" maxlength="80" placeholder="Steam username" autocomplete="off" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="handle-psn" class="block text-xs font-semibold text-slate-400 mb-1">PSN ID</label>' +
      '<input id="handle-psn" name="psnId" type="text" maxlength="80" placeholder="PlayStation Network ID" autocomplete="off" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="handle-xbox" class="block text-xs font-semibold text-slate-400 mb-1">Xbox Gamertag</label>' +
      '<input id="handle-xbox" name="xboxGamertag" type="text" maxlength="80" placeholder="Xbox gamertag" autocomplete="off" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="handle-gog" class="block text-xs font-semibold text-slate-400 mb-1">GOG Username</label>' +
      '<input id="handle-gog" name="gogUsername" type="text" maxlength="80" placeholder="GOG username" autocomplete="off" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all">' +
      "</div>" +
      "</div>" +
      '<button type="submit" id="settings-handles-save" class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-sm font-bold text-white shadow-md shadow-brand-600/15 hover:shadow-brand-500/25 active:scale-[0.98] transition-all disabled:opacity-60 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="save" class="w-4 h-4"></i><span>Save Handles</span>' +
      "</button>" +
      "</form>" +
      // Sprint 2 (WUD-2.1 / EPIC-01): Storefront Profile Sync panel. Rendered
      // by public/profile.js (window.__profile) when the Accounts tab loads.
      "<div>" +
      '<h3 class="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">' +
      '<i data-lucide="refresh-cw" class="w-4 h-4 text-sky-400"></i> Storefront Profile Sync</h3>' +
      '<p class="text-xs text-slate-400 mb-2">Connect storefront accounts to populate your unified gamer profile. Tokens are encrypted and stored only on this device — never synced externally.</p>' +
      '<div id="settings-profile-sync" class="space-y-2">' +
      '<p class="text-xs text-slate-500 italic">Loading sync state…</p>' +
      "</div>" +
      "</div>" +
      "<div>" +
      '<h3 class="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">' +
      '<i data-lucide="key-round" class="w-4 h-4 text-amber-400"></i> Linked Sign-In Accounts</h3>' +
      '<p class="text-xs text-slate-400 mb-2">OAuth / OpenID providers connected to your MGPL account. Unlinking the only provider is blocked for safety.</p>' +
      '<div id="settings-linked-accounts" class="space-y-2">' +
      '<p class="text-xs text-slate-500 italic">Loading linked accounts…</p>' +
      "</div>" +
      '<div class="mt-3 pt-3 border-t border-slate-800">' +
      '<p class="text-xs text-slate-500 mb-2">Link a new provider:</p>' +
      '<div class="flex flex-wrap gap-2">' +
      '<a href="/api/auth/oauth/google" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="chrome" class="w-3.5 h-3.5 text-emerald-400"></i>Google</a>' +
      '<a href="/api/auth/openid/steam" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<span class="text-sky-400 font-black text-[10px]">S</span>Steam OpenID</a>' +
      "</div>" +
      "</div>" +
      "</div>" +
      "</section>" +
      // ---- Tab 3: Social & Friends ----
      '<section id="settings-panel-social" role="tabpanel" aria-labelledby="settings-tab-social" class="hidden space-y-6">' +
      "<div>" +
      '<h3 class="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">' +
      '<i data-lucide="users" class="w-4 h-4 text-brand-400"></i> Social Hub</h3>' +
      '<p class="text-xs text-slate-400">privacy-minimized connections. Only public display names, gamerTags and avatars are shown.</p>' +
      "</div>" +
      "<div>" +
      '<h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">' +
      '<i data-lucide="inbox" class="w-4 h-4 text-amber-400"></i> Friend Requests</h4>' +
      '<div id="settings-social-requests" class="space-y-2">' +
      '<p class="text-xs text-slate-500 italic">Loading requests…</p>' +
      "</div>" +
      "</div>" +
      "<div>" +
      '<h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">' +
      '<i data-lucide="sparkles" class="w-4 h-4 text-emerald-400"></i> Suggested Friends</h4>' +
      '<div id="settings-social-suggestions" class="space-y-2">' +
      '<p class="text-xs text-slate-500 italic">Loading suggestions…</p>' +
      "</div>" +
      "</div>" +
      "<div>" +
      '<h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">' +
      '<i data-lucide="users" class="w-4 h-4 text-sky-400"></i> Friends</h4>' +
      '<div id="settings-social-friends" class="space-y-2">' +
      '<p class="text-xs text-slate-500 italic">Loading friends…</p>' +
      "</div>" +
      "</div>" +
      '<div id="settings-social-add-form" class="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-2">' +
      '<label for="settings-social-add-tag" class="block text-xs font-semibold text-slate-400">Add friend by @gamerTag</label>' +
      '<div class="flex items-center gap-2">' +
      '<input id="settings-social-add-tag" type="text" maxlength="21" placeholder="@AlexCyber" autocomplete="off" class="flex-1 bg-slate-900 border border-slate-700/60 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      '<button id="settings-social-add-btn" type="button" class="px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-lg text-xs font-bold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Add</button>' +
      "</div>" +
      '<p id="settings-social-add-status" class="text-[11px] font-medium text-slate-500"></p>' +
      "</div>" +
      "</section>" +
      // ---- Tab 4: Privacy & Data Rights (EPIC-COMPLIANCE-0001 Sprint 2) ----
      '<section id="settings-panel-privacy" role="tabpanel" aria-labelledby="settings-tab-privacy" class="hidden space-y-5">' +
      "<div>" +
      '<h3 class="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">' +
      '<i data-lucide="shield" class="w-4 h-4 text-emerald-400"></i> Privacy & Data Rights</h3>' +
      '<p class="text-xs text-slate-400">CCPA / CPRA / GDPR / LGPD self-service controls for your stored data.</p>' +
      "</div>" +
      '<div id="privacy-gpc-inline" class="hidden"></div>' +
      '<div class="rounded-xl border border-slate-800 bg-slate-950 p-4">' +
      '<label class="flex items-center gap-3 cursor-pointer select-none">' +
      '<input type="checkbox" id="privacy-dns-toggle" class="w-4 h-4 rounded border-slate-700 bg-slate-900 text-emerald-600 focus:ring-emerald-500">' +
      '<span class="flex-1">' +
      '<span class="block text-sm font-bold text-white">Do Not Sell or Share My Personal Info</span>' +
      '<span class="block text-xs text-slate-400 mt-0.5">Prevents the sale or sharing of your personal information under the California Consumer Privacy Act (CCPA / CPRA).</span>' +
      "</span>" +
      "</label>" +
      '<p id="privacy-dns-status" class="text-[11px] font-medium text-emerald-400 mt-2"></p>' +
      "</div>" +
      '<div class="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3">' +
      '<div class="flex items-center gap-2">' +
      '<i data-lucide="download" class="w-4 h-4 text-brand-400"></i>' +
      '<h4 class="text-xs font-bold uppercase tracking-wider text-slate-400">Export My Data</h4>' +
      "</div>" +
      '<p class="text-xs text-slate-400 leading-relaxed">Download the full MGPL state snapshot exported by this account as a JSON file (data portability).</p>' +
      '<button id="btn-export-my-data" type="button" class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/20 active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">' +
      '<i data-lucide="download" class="w-4 h-4"></i><span>Export My Data (JSON)</span>' +
      "</button>" +
      "</div>" +
      '<div class="rounded-xl border border-rose-800/40 bg-slate-950 p-4 space-y-3">' +
      '<div class="flex items-center gap-2">' +
      '<i data-lucide="trash-2" class="w-4 h-4 text-rose-400"></i>' +
      '<h4 class="text-xs font-bold uppercase tracking-wider text-rose-400">Delete Account</h4>' +
      "</div>" +
      '<p class="text-xs text-slate-400 leading-relaxed">Permanently erases your account and all associated data (wishlist, alerts, tags, notes, devices, social graph). This action cannot be undone — export your data first if you want to keep it.</p>' +
      '<button id="btn-delete-account" type="button" class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold shadow-lg shadow-rose-700/20 active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">' +
      '<i data-lucide="trash-2" class="w-4 h-4"></i><span>Delete Account</span>' +
      "</button>" +
      "</div>" +
      "</section>" +
      "</div>" +
      // Footer spacer
      '<div class="shrink-0 border-t border-slate-800 px-4 py-3 flex items-center justify-between">' +
      '<span class="text-[10px] uppercase tracking-wider text-slate-600 font-semibold">MGPL Social · privacy-minimized</span>' +
      '<button id="btn-settings-close-bottom" type="button" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Close</button>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  function injectDrawer() {
    if (drawerRoot) return;
    var host = document.createElement("div");
    host.innerHTML = drawerMarkup();
    drawerRoot = host.firstElementChild;
    document.body.appendChild(drawerRoot);

    els.drawer = drawerRoot;
    els.backdrop = document.getElementById("settings-backdrop");
    els.closeBtn = document.getElementById("btn-settings-close");
    els.closeBottomBtn = document.getElementById("btn-settings-close-bottom");
    els.tabProfile = document.getElementById("settings-tab-profile");
    els.tabAccounts = document.getElementById("settings-tab-accounts");
    els.tabSocial = document.getElementById("settings-tab-social");
    els.tabPrivacy = document.getElementById("settings-tab-privacy");
    els.privacyDnsToggle = document.getElementById("privacy-dns-toggle");
    els.privacyDnsStatus = document.getElementById("privacy-dns-status");
    els.privacyGpcInline = document.getElementById("privacy-gpc-inline");
    els.exportMyDataBtn = document.getElementById("btn-export-my-data");
    els.deleteAccountBtn = document.getElementById("btn-delete-account");
    els.banner = document.getElementById("settings-banner");
    els.profileForm = document.getElementById("settings-profile-form");
    els.handlesForm = document.getElementById("settings-handles-form");
    els.inputs = {
      displayName: document.getElementById("settings-display-name"),
      gamerTag: document.getElementById("settings-gamertag"),
      avatarUrl: document.getElementById("settings-avatar-url"),
      steam: document.getElementById("handle-steam"),
      psn: document.getElementById("handle-psn"),
      xbox: document.getElementById("handle-xbox"),
      gog: document.getElementById("handle-gog"),
    };
    els.visibilityRadios = document.querySelectorAll('input[name="profileVisibility"]');
    els.linkedAccounts = document.getElementById("settings-linked-accounts");
    els.socialRequests = document.getElementById("settings-social-requests");
    els.socialSuggestions = document.getElementById("settings-social-suggestions");
    els.socialFriends = document.getElementById("settings-social-friends");
    els.socialAddTag = document.getElementById("settings-social-add-tag");
    els.socialAddBtn = document.getElementById("settings-social-add-btn");
    els.socialAddStatus = document.getElementById("settings-social-add-status");
    els.refreshProfileBtn = document.getElementById("settings-profile-refresh");

    refreshIcons();
  }

  // -------------------------------------------------------------------------
  // Feedback banner
  // -------------------------------------------------------------------------

  function setBanner(message, kind) {
    if (!els.banner) return;
    if (!message) {
      els.banner.classList.add("hidden");
      els.banner.classList.remove("flex");
      els.banner.textContent = "";
      return;
    }
    els.banner.textContent = message;
    els.banner.classList.remove("hidden");
    els.banner.classList.add("flex");
    els.banner.className =
      "flex mx-5 mt-2 px-3 py-2.5 rounded-xl text-xs font-semibold items-center gap-2 " +
      (kind === "error"
        ? "bg-rose-900/50 border border-rose-500/40 text-rose-200"
        : "bg-emerald-900/40 border border-emerald-500/30 text-emerald-200");
    if (banTimers.banner) clearTimeout(banTimers.banner);
    if (kind !== "error") {
      banTimers.banner = setTimeout(function () {
        setBanner("");
      }, 4000);
    }
  }

  // -------------------------------------------------------------------------
  // Open / close / tab switching
  // -------------------------------------------------------------------------

  function setActiveTab(tab) {
    var panels = {
      profile: "settings-panel-profile",
      accounts: "settings-panel-accounts",
      social: "settings-panel-social",
      privacy: "settings-panel-privacy",
    };
    var tabIds = {
      profile: els.tabProfile,
      accounts: els.tabAccounts,
      social: els.tabSocial,
      privacy: els.tabPrivacy,
    };
    Object.keys(panels).forEach(function (key) {
      var panel = document.getElementById(panels[key]);
      var tabBtn = tabIds[key];
      var selected = key === tab;
      if (panel) panel.classList.toggle("hidden", !selected);
      if (tabBtn) {
        tabBtn.setAttribute("aria-selected", selected ? "true" : "false");
        if (selected) {
          tabBtn.className =
            "settings-tab-btn flex-1 px-2.5 py-1.5 rounded-lg bg-brand-600 text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400";
        } else {
          tabBtn.className =
            "settings-tab-btn flex-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400";
        }
      }
    });
  }

  function loadTab(tab) {
    setBanner("");
    if (tab === "profile") {
      loadProfileFields();
    } else if (tab === "accounts") {
      loadHandlesFields();
      loadLinkedAccounts();
      // Sprint 2 (WUD-2.1 / EPIC-01): refresh the storefront sync panel.
      if (window.__profile && typeof window.__profile.refresh === "function") {
        window.__profile.refresh();
      }
    } else if (tab === "social") {
      loadSocialHub();
    } else if (tab === "privacy") {
      loadPrivacyTab();
    }
  }

  function open(tab) {
    if (!isAuthenticated()) return;
    if (!drawerRoot) injectDrawer();
    var safeTab = tab === "accounts" || tab === "social" || tab === "privacy" ? tab : "profile";
    if (typeof window.saveFocus === "function") window.saveFocus();
    drawerRoot.classList.remove("hidden");
    drawerRoot.classList.add("flex");
    document.body.style.overflow = "hidden";
    setActiveTab(safeTab);
    loadTab(safeTab);
    requestAnimationFrame(function () {
      var focusTarget =
        safeTab === "profile"
          ? els.inputs.displayName
          : safeTab === "accounts"
            ? els.inputs.steam
            : els.socialAddTag || els.tabSocial;
      if (focusTarget && typeof focusTarget.focus === "function") {
        focusTarget.focus();
      }
    });
  }

  function close() {
    if (!drawerRoot) return;
    setBanner("");
    drawerRoot.classList.add("hidden");
    drawerRoot.classList.remove("flex");
    document.body.style.overflow = "";
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  }

  function refresh() {
    if (!isOpen()) return;
    var activeTab = "profile";
    if (els.tabAccounts && els.tabAccounts.getAttribute("aria-selected") === "true") {
      activeTab = "accounts";
    } else if (els.tabSocial && els.tabSocial.getAttribute("aria-selected") === "true") {
      activeTab = "social";
    } else if (els.tabPrivacy && els.tabPrivacy.getAttribute("aria-selected") === "true") {
      activeTab = "privacy";
    }
    loadTab(activeTab);
  }

  function isOpen() {
    return !!drawerRoot && !drawerRoot.classList.contains("hidden");
  }

  // -------------------------------------------------------------------------
  // Tab 1 — Profile & Privacy
  // -------------------------------------------------------------------------

  async function loadProfileFields() {
    try {
      var res = await apiFetch(API_BASE + "/api/user/profile");
      if (!res.ok) throw new Error("Request failed: " + res.status);
      var data = await res.json();
      var p = data.profile || {};
      if (els.inputs.displayName) els.inputs.displayName.value = p.displayName || "";
      if (els.inputs.gamerTag) els.inputs.gamerTag.value = p.gamerTag || "";
      if (els.inputs.avatarUrl) els.inputs.avatarUrl.value = p.avatarUrl || "";
      els.visibilityRadios.forEach(function (radio) {
        radio.checked = radio.value === (p.profileVisibility === "public" ? "public" : "private");
      });
    } catch (err) {
      console.error("Failed to load profile fields:", err);
      setBanner("Failed to load profile.", "error");
    }
  }

  async function handleProfileSubmit(e) {
    e.preventDefault();
    // Optional fields are cleared by sending null (the PATCH contract accepts
    // null for displayName/avatarUrl and treats an empty string as invalid).
    // gamerTag is the profile's primary identity: a blank input keeps the
    // persisted handle (null is ignored by the backend, never cleared).
    var gamerTagValue = els.inputs.gamerTag.value.trim();
    var payload = {
      displayName: els.inputs.displayName.value.trim() || null,
      gamerTag: gamerTagValue || null,
      avatarUrl: els.inputs.avatarUrl.value.trim() || null,
      profileVisibility: Array.prototype.find.call(els.visibilityRadios, function (r) {
        return r.checked;
      }).value,
    };

    var saveBtn = document.getElementById("settings-profile-save");
    if (saveBtn && saveBtn.dataset.busy === "1") return;
    if (saveBtn) {
      saveBtn.dataset.busy = "1";
      saveBtn.disabled = true;
      saveBtn.innerHTML =
        '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Saving…</span>';
      refreshIcons();
    }
    try {
      var res = await apiFetch(API_BASE + "/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        var errMsg =
          data.error ||
          (res.status === 409 ? "That @gamerTag is already taken." : "Failed to save profile.");
        setBanner(errMsg, "error");
        return;
      }
      setBanner("Profile saved successfully.");
      // Immediately refresh the header display.
      if (window.__auth && typeof window.__auth.refreshUser === "function") {
        window.__auth.refreshUser();
      }
      window.dispatchEvent(new CustomEvent("mgpl:data-rehydrate", { detail: {} }));
      // Persist an updated snapshot of form fields straight from the response.
      var updated = data.profile || {};
      if (updated.displayName != null) els.inputs.displayName.value = updated.displayName;
      if (updated.gamerTag != null) els.inputs.gamerTag.value = updated.gamerTag;
      if (updated.avatarUrl != null) els.inputs.avatarUrl.value = updated.avatarUrl;
      if (updated.profileVisibility != null) {
        els.visibilityRadios.forEach(function (radio) {
          radio.checked = radio.value === updated.profileVisibility;
        });
      }
    } catch (err) {
      console.error("Profile save error:", err);
      setBanner("Unable to reach the server. Please try again.", "error");
    } finally {
      if (saveBtn) {
        delete saveBtn.dataset.busy;
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i data-lucide="save" class="w-4 h-4"></i><span>Save Profile</span>';
        refreshIcons();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tab 2 — Connected Accounts & Handles
  // -------------------------------------------------------------------------

  async function loadHandlesFields() {
    try {
      var res = await apiFetch(API_BASE + "/api/user/platform-handles");
      if (!res.ok) throw new Error("Request failed: " + res.status);
      var data = await res.json();
      var handles = data.platformHandles || {};
      if (els.inputs.steam) els.inputs.steam.value = handles.steamUsername || "";
      if (els.inputs.psn) els.inputs.psn.value = handles.psnId || "";
      if (els.inputs.xbox) els.inputs.xbox.value = handles.xboxGamertag || "";
      if (els.inputs.gog) els.inputs.gog.value = handles.gogUsername || "";
    } catch (err) {
      console.error("Failed to load platform handles:", err);
      setBanner("Failed to load platform handles.", "error");
    }
  }

  async function handleHandlesSubmit(e) {
    e.preventDefault();
    var payload = {
      steamUsername: els.inputs.steam.value.trim() || null,
      psnId: els.inputs.psn.value.trim() || null,
      xboxGamertag: els.inputs.xbox.value.trim() || null,
      gogUsername: els.inputs.gog.value.trim() || null,
    };

    var saveBtn = document.getElementById("settings-handles-save");
    if (saveBtn && saveBtn.dataset.busy === "1") return;
    if (saveBtn) {
      saveBtn.dataset.busy = "1";
      saveBtn.disabled = true;
      saveBtn.innerHTML =
        '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Saving…</span>';
      refreshIcons();
    }
    try {
      var res = await apiFetch(API_BASE + "/api/user/platform-handles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setBanner(data.error || "Failed to save platform handles.", "error");
        return;
      }
      setBanner("Platform handles saved successfully.");
      // Re-persist the authoritative response into the form.
      var saved = data.platformHandles || {};
      if (els.inputs.steam) els.inputs.steam.value = saved.steamUsername || "";
      if (els.inputs.psn) els.inputs.psn.value = saved.psnId || "";
      if (els.inputs.xbox) els.inputs.xbox.value = saved.xboxGamertag || "";
      if (els.inputs.gog) els.inputs.gog.value = saved.gogUsername || "";
    } catch (err) {
      console.error("Handles save error:", err);
      setBanner("Unable to reach the server. Please try again.", "error");
    } finally {
      if (saveBtn) {
        delete saveBtn.dataset.busy;
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i data-lucide="save" class="w-4 h-4"></i><span>Save Handles</span>';
        refreshIcons();
      }
    }
  }

  async function loadLinkedAccounts() {
    if (!els.linkedAccounts) return;
    els.linkedAccounts.innerHTML =
      '<p class="text-xs text-slate-500 italic">Loading linked accounts…</p>';
    try {
      var res = await apiFetch(API_BASE + "/api/user/accounts");
      if (!res.ok) throw new Error("Request failed: " + res.status);
      var data = await res.json();
      renderLinkedAccounts(data.accounts || []);
    } catch (err) {
      console.error("Failed to load linked accounts:", err);
      els.linkedAccounts.innerHTML =
        '<p class="text-xs text-rose-400">Failed to load linked accounts.</p>';
    }
  }

  function renderLinkedAccounts(accounts) {
    if (!els.linkedAccounts) return;
    if (!accounts.length) {
      els.linkedAccounts.innerHTML =
        '<p class="text-xs text-slate-500 italic">No third-party sign-in providers linked.</p>';
      return;
    }
    var providerLabels = {
      google: { label: "Google", color: "text-emerald-400", icon: "chrome" },
      steam: { label: "Steam OpenID", color: "text-sky-400", icon: "" },
    };
    els.linkedAccounts.innerHTML = accounts
      .map(function (acc) {
        var meta = providerLabels[acc.provider] || {
          label: acc.provider.charAt(0).toUpperCase() + acc.provider.slice(1),
          color: "text-slate-300",
          icon: "link",
        };
        return (
          '<div class="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5">' +
          '<div class="flex items-center gap-2 min-w-0">' +
          (meta.icon
            ? '<i data-lucide="' + meta.icon + '" class="w-4 h-4 ' + meta.color + ' shrink-0"></i>'
            : '<span class="w-4 h-4 flex items-center justify-center rounded-full bg-sky-500/20 text-sky-400 font-black text-[10px] shrink-0">S</span>') +
          '<div class="min-w-0">' +
          '<p class="text-xs font-bold text-white truncate">' +
          esc(meta.label) +
          "</p>" +
          '<p class="text-[10px] text-slate-500 truncate">Linked ' +
          esc(String(acc.linkedAt || "").slice(0, 10)) +
          "</p>" +
          "</div>" +
          "</div>" +
          '<button type="button" class="btn-unlink-account px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 text-rose-300 text-[11px] font-bold border border-rose-500/30 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400" data-provider="' +
          esc(acc.provider) +
          '">Unlink</button>' +
          "</div>"
        );
      })
      .join("");
    refreshIcons();

    els.linkedAccounts.querySelectorAll(".btn-unlink-account").forEach(function (btn) {
      btn.addEventListener("click", function () {
        unlinkAccount(btn.getAttribute("data-provider"));
      });
    });
  }

  async function unlinkAccount(provider) {
    if (!provider) return;
    try {
      var res = await apiFetch(API_BASE + "/api/user/accounts/" + encodeURIComponent(provider), {
        method: "DELETE",
      });
      if (!res.ok) {
        var errData = await res.json().catch(function () {
          return {};
        });
        setBanner(errData.error || "Failed to unlink account.", "error");
        return;
      }
      setBanner(provider.charAt(0).toUpperCase() + provider.slice(1) + " unlinked successfully.");
      loadLinkedAccounts();
    } catch (err) {
      console.error("Unlink error:", err);
      setBanner("Unable to reach the server. Please try again.", "error");
    }
  }

  // -------------------------------------------------------------------------
  // Tab 3 — Social & Friends
  // -------------------------------------------------------------------------

  async function loadSocialHub() {
    await Promise.all([loadFriendRequests(), loadSuggestions(), loadFriends()]);
  }

  function loadFriendRequests() {
    return apiFetch(API_BASE + "/api/social/requests")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderRequests(data.requests || []);
      })
      .catch(function (err) {
        console.error("Failed to load friend requests:", err);
        if (els.socialRequests)
          els.socialRequests.innerHTML =
            '<p class="text-xs text-rose-400">Failed to load requests.</p>';
      });
  }

  function loadSuggestions() {
    return apiFetch(API_BASE + "/api/social/suggestions")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderSuggestions(data.suggestions || []);
      })
      .catch(function (err) {
        console.error("Failed to load suggestions:", err);
        if (els.socialSuggestions)
          els.socialSuggestions.innerHTML =
            '<p class="text-xs text-rose-400">Failed to load suggestions.</p>';
      });
  }

  function loadFriends() {
    return apiFetch(API_BASE + "/api/social/friends")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderFriends(data.friends || []);
      })
      .catch(function (err) {
        console.error("Failed to load friends:", err);
        if (els.socialFriends)
          els.socialFriends.innerHTML =
            '<p class="text-xs text-rose-400">Failed to load friends.</p>';
      });
  }

  // privacy-minimized avatar + identity helper shared by all three social lists.
  function socialCardHtml(person, actionHtml) {
    var label = person.displayName || person.gamerTag || "Player";
    var sub = person.gamerTag ? "@" + esc(String(person.gamerTag).replace(/^@/, "")) : "";
    var avatarHtml = person.avatarUrl
      ? '<img src="' +
        esc(person.avatarUrl) +
        '" alt="" class="w-9 h-9 rounded-full object-cover border border-slate-700 bg-slate-800" loading="lazy" referrerpolicy="no-referrer" />'
      : '<span class="w-9 h-9 rounded-full bg-brand-600 text-white text-[10px] font-black flex items-center justify-center shadow-inner" aria-hidden="true">' +
        esc(initialsFor(person)) +
        "</span>";
    return (
      '<div class="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5">' +
      '<div class="flex items-center gap-2.5 min-w-0">' +
      avatarHtml +
      '<div class="min-w-0">' +
      '<p class="text-xs font-bold text-white truncate">' +
      esc(label) +
      "</p>" +
      (sub ? '<p class="text-[10px] text-slate-500 truncate">' + sub + "</p>" : "") +
      "</div>" +
      "</div>" +
      '<div class="flex items-center gap-1.5 shrink-0">' +
      actionHtml +
      "</div>" +
      "</div>"
    );
  }

  function initialsFor(person) {
    var name = person.displayName || person.gamerTag || "";
    var parts = String(name)
      .replace(/^@/, "")
      .split(/[\s._-]+/)
      .filter(Boolean);
    if (!parts.length) return "MG";
    var first = (parts[0][0] || "").toUpperCase();
    var second =
      parts.length > 1
        ? (parts[1][0] || "").toUpperCase()
        : name.length > 1
          ? name.charAt(name.length - 1).toUpperCase()
          : first;
    return (first + second).slice(0, 2);
  }

  function renderRequests(requests) {
    if (!els.socialRequests) return;
    if (!requests.length) {
      els.socialRequests.innerHTML =
        '<p class="text-xs text-slate-500 italic">No pending friend requests.</p>';
      return;
    }
    els.socialRequests.innerHTML = requests
      .map(function (r) {
        var from = r.from || {};
        var actions =
          '<button type="button" class="btn-accept-request px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" data-request-id="' +
          esc(r.id) +
          '">Accept</button>' +
          '<button type="button" class="btn-decline-request px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 text-rose-300 text-[11px] font-bold border border-rose-500/30 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400" data-request-id="' +
          esc(r.id) +
          '">Decline</button>';
        return socialCardHtml(from, actions);
      })
      .join("");
    wireSocialCardActions();
  }

  function renderSuggestions(suggestions) {
    if (!els.socialSuggestions) return;
    if (!suggestions.length) {
      els.socialSuggestions.innerHTML =
        '<p class="text-xs text-slate-500 italic">No suggestions right now. Link shareable platform handles or ask friends for their @gamerTag.</p>';
      return;
    }
    els.socialSuggestions.innerHTML = suggestions
      .slice(0, 10)
      .map(function (person) {
        var actions =
          '<button type="button" class="btn-add-friend px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-[11px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" data-gamertag="' +
          esc(person.gamerTag || "") +
          '">Add</button>';
        return socialCardHtml(person, actions);
      })
      .join("");
    wireSocialCardActions();
  }

  function renderFriends(friends) {
    if (!els.socialFriends) return;
    if (!friends.length) {
      els.socialFriends.innerHTML =
        '<p class="text-xs text-slate-500 italic">No friends yet. Accept requests or add players by @gamerTag.</p>';
      return;
    }
    els.socialFriends.innerHTML = friends
      .map(function (person) {
        var actions =
          '<button type="button" class="btn-unfriend px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 text-rose-300 text-[11px] font-bold border border-rose-500/30 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400" data-friend-id="' +
          esc(person.id) +
          '">Unfriend</button>';
        return socialCardHtml(person, actions);
      })
      .join("");
    wireSocialCardActions();
  }

  function wireSocialCardActions() {
    if (!els.socialRequests || !els.socialSuggestions || !els.socialFriends) return;
    els.socialRequests.querySelectorAll(".btn-accept-request").forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", function () {
        respondToRequest(btn.getAttribute("data-request-id"), "accept");
      });
    });
    els.socialRequests.querySelectorAll(".btn-decline-request").forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", function () {
        respondToRequest(btn.getAttribute("data-request-id"), "reject");
      });
    });
    els.socialSuggestions.querySelectorAll(".btn-add-friend").forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", function () {
        var tag = btn.getAttribute("data-gamertag") || "";
        if (!tag) return;
        sendFriendRequest(tag);
      });
    });
    els.socialFriends.querySelectorAll(".btn-unfriend").forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", function () {
        unfriend(btn.getAttribute("data-friend-id"));
      });
    });
  }

  async function respondToRequest(requestId, action) {
    if (!requestId) return;
    try {
      var res = await apiFetch(API_BASE + "/api/social/request/" + encodeURIComponent(requestId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setBanner(data.error || "Failed to " + action + " request.", "error");
        return;
      }
      setBanner(action === "accept" ? "Friend request accepted." : "Friend request declined.");
      loadSocialHub();
    } catch (err) {
      console.error("Request response error:", err);
      setBanner("Unable to reach the server. Please try again.", "error");
    }
  }

  async function sendFriendRequest(gamerTag) {
    if (!gamerTag) return;
    try {
      var res = await apiFetch(API_BASE + "/api/social/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gamerTag: gamerTag }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setBanner(data.error || "Failed to send friend request.", "error");
        return;
      }
      setBanner(data.status === "accepted" ? "You are now friends!" : "Friend request sent.");
      loadSocialHub();
    } catch (err) {
      console.error("Send friend request error:", err);
      setBanner("Unable to reach the server. Please try again.", "error");
    }
  }

  async function unfriend(friendId) {
    if (!friendId) return;
    if (!window.confirm("Remove this friend from your list?")) return;
    try {
      var res = await apiFetch(API_BASE + "/api/social/friends/" + encodeURIComponent(friendId), {
        method: "DELETE",
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setBanner(data.error || "Failed to remove friend.", "error");
        return;
      }
      setBanner("Friend removed.");
      loadSocialHub();
    } catch (err) {
      console.error("Unfriend error:", err);
      setBanner("Unable to reach the server. Please try again.", "error");
    }
  }

  // -------------------------------------------------------------------------
  // Tab 4 — Privacy & Data Rights (EPIC-COMPLIANCE-0001 Sprint 2)
  // -------------------------------------------------------------------------

  function loadPrivacyTab() {
    // GPC status line
    var gpcActive =
      window.__consent && typeof window.__consent.isGpcActive === "function"
        ? window.__consent.isGpcActive()
        : false;
    if (els.privacyGpcInline) {
      if (gpcActive) {
        els.privacyGpcInline.classList.remove("hidden");
        els.privacyGpcInline.className =
          "flex items-center gap-2 px-3 py-2.5 rounded-xl bg-emerald-900/40 border border-emerald-500/30 text-xs font-semibold text-emerald-200";
        els.privacyGpcInline.textContent =
          "Global Privacy Control (GPC) is active — your opt-out preference is enforced automatically.";
      } else {
        els.privacyGpcInline.classList.add("hidden");
        els.privacyGpcInline.classList.remove("flex");
      }
    }

    // Do Not Sell or Share toggle
    var dns =
      window.__consent && typeof window.__consent.getDoNotSell === "function"
        ? window.__consent.getDoNotSell()
        : false;
    if (els.privacyDnsToggle) els.privacyDnsToggle.checked = dns;
    updateDnsStatus(dns);
  }

  function updateDnsStatus(value) {
    if (!els.privacyDnsStatus) return;
    els.privacyDnsStatus.textContent = value
      ? "You have opted out of the sale or sharing of your personal information."
      : 'Your "Do Not Sell or Share" preference is currently not set.';
  }

  function handleDnsToggle() {
    var value = !!els.privacyDnsToggle && els.privacyDnsToggle.checked;
    if (window.__consent && typeof window.__consent.setDoNotSell === "function") {
      window.__consent.setDoNotSell(value);
    }
    updateDnsStatus(value);
    setBanner(
      value
        ? "Do Not Sell or Share My Personal Info is enabled."
        : "Do Not Sell or Share My Personal Info is disabled.",
      value ? "success" : "",
    );
  }

  async function handleExportMyData() {
    var btn = els.exportMyDataBtn;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Exporting...</span>';
      refreshIcons();
    }
    try {
      // AI-084 (#163): only the signed-in user's own rows; the whole-database
      // export (/api/state/export) is admin-only.
      var res = await apiFetch(API_BASE + "/api/state/export/me");
      if (!res.ok) {
        var errData = await res.json().catch(function () {
          return {};
        });
        throw new Error(errData.error || "Export failed");
      }
      var snapshot = await res.json();
      var blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      var ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = "mgpl-my-data-" + ts + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBanner("Your data export has been downloaded (JSON).");
    } catch (err) {
      console.error("Export my data error:", err);
      // Sprint 1A (EPICSEC04): sanitize raw errors before they reach the UI.
      setBanner(
        typeof window.safeToastError === "function"
          ? window.safeToastError(err, "Failed to export your data.")
          : err && err.message
            ? err.message
            : "Failed to export your data.",
        "error",
      );
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML =
          '<i data-lucide="download" class="w-4 h-4"></i><span>Export My Data (JSON)</span>';
        refreshIcons();
      }
    }
  }

  async function handleDeleteAccount() {
    if (
      !window.confirm(
        "Permanently delete your MGPL account and all associated data? This action cannot be undone.",
      )
    ) {
      return;
    }
    var btn = els.deleteAccountBtn;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Deleting...</span>';
      refreshIcons();
    }
    try {
      var res = await apiFetch(API_BASE + "/api/users/me", { method: "DELETE" });
      if (!res.ok) {
        var errData = await res.json().catch(function () {
          return {};
        });
        throw new Error(errData.error || "Failed to delete account");
      }
      close();
      // Clear the local auth session and broadcast to rehydrate the UI.
      if (window.__auth && typeof window.__auth.logout === "function") {
        await window.__auth.logout();
      }
      window.location.hash = "#/home";
    } catch (err) {
      console.error("Delete account error:", err);
      // Sprint 1A (EPICSEC04): sanitize raw errors before they reach the UI.
      setBanner(
        typeof window.safeToastError === "function"
          ? window.safeToastError(err, "Failed to delete account.")
          : err && err.message
            ? err.message
            : "Failed to delete account.",
        "error",
      );
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i><span>Delete Account</span>';
        refreshIcons();
      }
    }
  }

  // "Add by @gamerTag" form in Social tab.
  async function handleAddByTag() {
    var tag = els.socialAddTag ? els.socialAddTag.value.trim() : "";
    if (!tag) {
      if (els.socialAddStatus) els.socialAddStatus.textContent = "Enter a @gamerTag first.";
      return;
    }
    if (els.socialAddStatus) els.socialAddStatus.textContent = "Sending request…";
    try {
      var res = await apiFetch(API_BASE + "/api/social/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gamerTag: tag }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        if (els.socialAddStatus)
          els.socialAddStatus.textContent = data.error || "Failed to send request.";
        setBanner(data.error || "Failed to send friend request.", "error");
        return;
      }
      if (els.socialAddStatus)
        els.socialAddStatus.textContent =
          data.status === "accepted" ? "You are now friends!" : "Friend request sent.";
      if (els.socialAddTag) els.socialAddTag.value = "";
      setBanner(data.status === "accepted" ? "You are now friends!" : "Friend request sent.");
      loadSocialHub();
    } catch (err) {
      console.error("Add by tag error:", err);
      if (els.socialAddStatus) els.socialAddStatus.textContent = "Unable to reach the server.";
      setBanner("Unable to reach the server. Please try again.", "error");
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function wireEvents() {
    if (els.closeBtn && !els.closeBtn.dataset.settingsWired) {
      els.closeBtn.dataset.settingsWired = "1";
      els.closeBtn.addEventListener("click", close);
    }
    if (els.closeBottomBtn && !els.closeBottomBtn.dataset.settingsWired) {
      els.closeBottomBtn.dataset.settingsWired = "1";
      els.closeBottomBtn.addEventListener("click", close);
    }
    if (els.backdrop && !els.backdrop.dataset.settingsWired) {
      els.backdrop.dataset.settingsWired = "1";
      els.backdrop.addEventListener("click", close);
    }
    if (els.tabProfile && !els.tabProfile.dataset.settingsWired) {
      els.tabProfile.dataset.settingsWired = "1";
      els.tabProfile.addEventListener("click", function () {
        setActiveTab("profile");
        loadTab("profile");
      });
    }
    if (els.tabAccounts && !els.tabAccounts.dataset.settingsWired) {
      els.tabAccounts.dataset.settingsWired = "1";
      els.tabAccounts.addEventListener("click", function () {
        setActiveTab("accounts");
        loadTab("accounts");
      });
    }
    if (els.tabSocial && !els.tabSocial.dataset.settingsWired) {
      els.tabSocial.dataset.settingsWired = "1";
      els.tabSocial.addEventListener("click", function () {
        setActiveTab("social");
        loadTab("social");
      });
    }
    if (els.tabPrivacy && !els.tabPrivacy.dataset.settingsWired) {
      els.tabPrivacy.dataset.settingsWired = "1";
      els.tabPrivacy.addEventListener("click", function () {
        setActiveTab("privacy");
        loadTab("privacy");
      });
    }
    if (els.privacyDnsToggle && !els.privacyDnsToggle.dataset.settingsWired) {
      els.privacyDnsToggle.dataset.settingsWired = "1";
      els.privacyDnsToggle.addEventListener("change", handleDnsToggle);
    }
    if (els.exportMyDataBtn && !els.exportMyDataBtn.dataset.settingsWired) {
      els.exportMyDataBtn.dataset.settingsWired = "1";
      els.exportMyDataBtn.addEventListener("click", handleExportMyData);
    }
    if (els.deleteAccountBtn && !els.deleteAccountBtn.dataset.settingsWired) {
      els.deleteAccountBtn.dataset.settingsWired = "1";
      els.deleteAccountBtn.addEventListener("click", handleDeleteAccount);
    }
    if (els.profileForm && !els.profileForm.dataset.settingsWired) {
      els.profileForm.dataset.settingsWired = "1";
      els.profileForm.addEventListener("submit", handleProfileSubmit);
    }
    if (els.handlesForm && !els.handlesForm.dataset.settingsWired) {
      els.handlesForm.dataset.settingsWired = "1";
      els.handlesForm.addEventListener("submit", handleHandlesSubmit);
    }
    if (els.refreshProfileBtn && !els.refreshProfileBtn.dataset.settingsWired) {
      els.refreshProfileBtn.dataset.settingsWired = "1";
      els.refreshProfileBtn.addEventListener("click", function () {
        loadProfileFields();
        setBanner("Profile reloaded.");
      });
    }
    if (els.socialAddBtn && !els.socialAddBtn.dataset.settingsWired) {
      els.socialAddBtn.dataset.settingsWired = "1";
      els.socialAddBtn.addEventListener("click", handleAddByTag);
    }
    if (els.socialAddTag && !els.socialAddTag.dataset.settingsWired) {
      els.socialAddTag.dataset.settingsWired = "1";
      els.socialAddTag.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          handleAddByTag();
        }
      });
    }

    // Global key handling: Escape closes, Tab is trapped while open.
    document.addEventListener("keydown", function (e) {
      if (!isOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab" && typeof window.trapFocus === "function") {
        window.trapFocus(drawerRoot, e);
      }
    });

    // Clicking the authenticated user pill opens the drawer on the Profile tab.
    // Delegated on document because auth.js re-renders the header via innerHTML.
    document.addEventListener("click", function (e) {
      var pill = e.target.closest("#auth-user-pill");
      if (pill && isAuthenticated()) {
        e.preventDefault();
        open("profile");
      }
    });

    // "Settings" nav links open the drawer when authenticated instead of
    // navigating to the settings page. Guests keep the normal #/settings route.
    document.addEventListener("click", function (e) {
      var link = e.target.closest('[data-route="settings"]');
      if (link && isAuthenticated()) {
        e.preventDefault();
        open("profile");
      }
    });

    // Rehydrate profile fields + social lists after auth or data changes.
    window.addEventListener("mgpl:auth-changed", function () {
      if (isOpen()) loadTab("profile");
    });
  }

  function init() {
    injectDrawer();
    wireEvents();
    return window.__settings;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.__settings = {
    init: init,
    open: open,
    close: close,
    refresh: refresh,
  };
})();
