const API_BASE = "";

/* ===== Offline-First Helpers (FEAT-0151) ===== */
// Map an API URL to an IndexedDB { store, key } target for offline caching.
function offlineCacheTarget(url) {
  const path = url.split("?")[0];
  if (path.includes("/api/devices/playability"))
    return { store: "store_games", key: "playability" };
  if (path.includes("/api/devices")) return { store: "store_fleet", key: "devices" };
  if (path.includes("/api/deals")) return { store: "store_deals", key: "deals" };
  if (path.includes("/api/hltb")) return { store: "store_hltb", key: "hltb" };
  // Distinct cache keys for the session/velocity sub-endpoints so their payloads
  // don't overwrite the summary caches (FEAT-0163).
  if (path.includes("/api/backlog/velocity"))
    return { store: "backlog_cache", key: "backlog-velocity" };
  if (path.includes("/api/backlog")) return { store: "backlog_cache", key: "backlog" };
  if (path.includes("/api/games")) return { store: "store_games", key: "games" };
  if (path.includes("/api/analytics/sessions"))
    return { store: "store_analytics", key: "analytics-sessions" };
  if (path.includes("/api/analytics")) return { store: "store_analytics", key: "analytics" };
  if (path.includes("/api/dashboard")) return { store: "store_games", key: "dashboard" };
  return null;
}

// Build a synthetic Response-like object from cached data.
function cachedResponse(data) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

// Network-first fetch that persists successful responses to IndexedDB and
// falls back to cached data when the network is unavailable.
async function apiFetch(url, options) {
  const target = offlineCacheTarget(url);
  try {
    const res = await fetch(url, options);
    if (res.ok && target && window.OfflineStorage) {
      const data = await res.clone().json();
      window.OfflineStorage.save(target.store, target.key, data).catch(() => {});
    }
    return res;
  } catch (err) {
    if (target && window.OfflineStorage) {
      const cached = await window.OfflineStorage.get(target.store, target.key);
      if (cached != null) {
        setOfflineStatus(true);
        return cachedResponse(cached);
      }
    }
    throw err;
  }
}

// Toggle the offline status pill in the header.
function setOfflineStatus(isOffline) {
  const pill = document.getElementById("offline-status-pill");
  if (!pill) return;
  if (isOffline) {
    pill.classList.remove("hidden");
    pill.classList.add("flex");
  } else {
    pill.classList.add("hidden");
    pill.classList.remove("flex");
  }
}

// Register the service worker for offline app-shell caching.
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }
}

// Wire online/offline browser events to the status pill.
function initOfflineStatusListeners() {
  window.addEventListener("online", () => {
    setOfflineStatus(false);
    // Flush any queued play sessions recorded while offline.
    if (window.OfflineStorage && typeof window.OfflineStorage.syncPlaySessions === "function") {
      window.OfflineStorage.syncPlaySessions()
        .then((n) => {
          if (n > 0) showToast(`Synced ${n} offline play session${n > 1 ? "s" : ""}`);
        })
        .catch(() => {});
    }
  });
  window.addEventListener("offline", () => setOfflineStatus(true));
}

// =========================================================================
// Affiliate & Commercial Disclosure (EPIC-COMPLIANCE-0001 Sprint 3)
// FTC 16 CFR Part 255 / EU Consumer Rights & Omnibus Directive.
// A subtle, accessible disclosure badge rendered adjacent to every external
// storefront redirect link (Steam, Epic, GOG, Fanatical, CheapShark, etc.).
// `role="note"` tags it as a non-essential but useful annotation for AT users;
// the visible text itself carries the disclosure so no hidden content is
// announced. Contrast uses the theme's success token so WCAG 2.1 AA holds
// across every palette (including the light "contrast" theme).
// =========================================================================
const AFFILIATE_DISCLOSURE_TEXT =
  "MGPL may earn a commission on qualifying purchases via store links.";

function affiliateDisclosureHtml() {
  return (
    '<p role="note" class="affiliate-disclosure" data-affiliate-disclosure aria-label="' +
    AFFILIATE_DISCLOSURE_TEXT +
    '">' +
    AFFILIATE_DISCLOSURE_TEXT +
    "</p>"
  );
}

// =========================================================================
// Sprint 6.1 (GAP-001/GAP-003): client-side mirror of the v1.0 mod-source
// whitelist + URL re-sanitization. Any persisted or generated mod link that
// fails revalidation is suppressed at render time (never emitted as href).
// =========================================================================
const MOD_SOURCE_DOMAINS = [
  "nexusmods.com",
  "moddb.com",
  "curseforge.com",
  "github.com",
  "modrinth.com",
];

function normalizeModHost(host) {
  let h = String(host || "")
    .trim()
    .toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

function safeModUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // Sprint 1B (EPICSEC02): mirror the server sanitizer's edge-case defenses.
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname || parsed.hostname.endsWith(".")) return null;
  const domain = normalizeModHost(parsed.hostname);
  if (!MOD_SOURCE_DOMAINS.includes(domain)) return null;
  if (domain === "github.com" && !/^\/[^/]+\/[^/]+\/releases(\/|$)/.test(parsed.pathname)) {
    return null;
  }
  return parsed.toString();
}

// Sprint 7 (WUD-7.4): strict validator for the approved mod-provider HOME
// links (Nexus Mods / ModDB / CurseForge / GitHub / Modrinth). Same HTTPS +
// exact-match host whitelist as safeModUrl, but GitHub is restricted to the
// bare repository root (https://github.com/) so a provider hub can never
// point into an arbitrary repository. These are static code-embedded
// constants, so this is a defense-in-depth guard, not a data path.
function safeProviderHomeUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname || parsed.hostname.endsWith(".")) return null;
  const domain = normalizeModHost(parsed.hostname);
  if (!MOD_SOURCE_DOMAINS.includes(domain)) return null;
  if (domain === "github.com" && parsed.pathname.replace(/\/+$/, "") !== "") {
    return null;
  }
  return parsed.toString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =========================================================================
// Custom Theme Engine (Sprint 33 / FEAT-0167)
// =========================================================================
// Persists the active theme to localStorage (immediate) AND IndexedDB
// (store_prefs) so the choice survives across devices/offline. Supports OS
// auto-detection via prefers-color-scheme and prefers-reduced-motion.
const THEME_KEY = "mgpl_theme";
const THEMES = ["system", "oled", "cyberpunk", "retro", "contrast"];

// Resolve the effective theme name given the stored preference. "system"
// maps to light/dark based on the OS color-scheme preference.
function resolveTheme(pref) {
  if (pref && pref !== "system") return pref;
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "oled" : "contrast";
}

// Apply the resolved theme to the <html> element and toggle the reduced-motion
// override class based on the OS prefers-reduced-motion setting.
function applyTheme(pref) {
  let resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  // Sprint 6.1 (GAP-002): palette self-healing — verify the active theme's
  // critical custom property resolves to a valid value through the strict
  // safeCSSVar sanitizer (rejects url(...), chained var(--...), non-strings).
  // A missing or malformed palette falls back to a known-good theme instead of
  // leaving the UI unstyled.
  const bgToken =
    typeof window.safeCSSVar === "function" ? window.safeCSSVar("--bg-primary", "") : "";
  if (!bgToken) {
    resolved = "oled";
    root.setAttribute("data-theme", resolved);
  }
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.classList.toggle("reduced-motion-override", reduce);
  return resolved;
}

// Return the currently stored theme preference (defaults to "system").
function getTheme() {
  return localStorage.getItem(THEME_KEY) || "system";
}

// Persist a theme preference to localStorage + IndexedDB and apply it.
async function setTheme(name) {
  const safe = THEMES.includes(name) ? name : "system";
  localStorage.setItem(THEME_KEY, safe);
  applyTheme(safe);
  // Reflect the active radio option in the Settings theme switcher.
  const radio = document.querySelector(`input[name="theme"][value="${safe}"]`);
  if (radio) radio.checked = true;
  const statusEl = document.getElementById("theme-status");
  if (statusEl) {
    const resolved = resolveTheme(safe);
    statusEl.textContent = `Active theme: ${resolved}${safe === "system" ? " (auto)" : ""}`;
  }
  // Persist to IndexedDB for cross-session/offline durability.
  if (window.OfflineStorage && typeof window.OfflineStorage.save === "function") {
    try {
      await window.OfflineStorage.save("store_prefs", "theme", { name: safe });
    } catch (err) {
      console.warn("Failed to persist theme to IndexedDB:", err);
    }
  }
  return safe;
}

// =========================================================================
// Screen Reader Live Region (EPIC-COMPLIANCE-0001 Sprint 1, WCAG 2.1 AA)
// =========================================================================
// announceToScreenReader broadcasts transient status changes (e.g. "Game
// details loaded", "Filter applied", "Device saved") to assistive technology
// via the hidden #a11y-live-region container in index.html.
function announceToScreenReader(message) {
  if (!message) return;
  const region = document.getElementById("a11y-live-region");
  if (!region) return;
  // Clear then re-set on the next frame so repeated identical messages still
  // trigger a screen-reader announcement.
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

// =========================================================================
// Reusable Focus Management Helpers (Sprint 33 / FEAT-0167)
// =========================================================================
// saveFocus/restoreFocus preserve the element that opened a modal/drawer so
// keyboard focus returns there on close. trapFocus keeps Tab/Shift+Tab
// navigation contained within an open overlay (WCAG 2.4.3 / 2.1.2).
let __lastFocusedEl = null;

function saveFocus() {
  __lastFocusedEl = document.activeElement;
}

function restoreFocus() {
  if (__lastFocusedEl && typeof __lastFocusedEl.focus === "function") {
    __lastFocusedEl.focus();
  }
  __lastFocusedEl = null;
}

function trapFocus(containerEl, event) {
  if (!containerEl || !event || event.key !== "Tab") return;
  // Sprint 6 (PI-GTM-2026-001): only consider *visible* focusables. Ownership-
  // aware drawers hide controls (wishlist/deals) with display:none, and the
  // browser's default Tab order skips those — so the trap must too, otherwise
  // Tab from the last visible control would escape the dialog instead of
  // wrapping (WCAG 2.1.2 No Keyboard Trap).
  const focusables = Array.from(
    containerEl.querySelectorAll(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.getClientRects().length > 0);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// =========================================================================
// PWA Install Prompt (Sprint 33 / FEAT-0167)
// =========================================================================
let deferredInstallPrompt = null;

function showInstallBanner() {
  const banner = document.getElementById("pwa-install-banner");
  if (banner) banner.classList.remove("hidden");
}

function hideInstallBanner() {
  const banner = document.getElementById("pwa-install-banner");
  if (banner) banner.classList.add("hidden");
}

// Reflect the current installability state in the Settings PWA card.
function updatePwaInstallStatus() {
  const statusEl = document.getElementById("pwa-install-status");
  if (!statusEl) return;
  const isStandalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  if (isStandalone) {
    statusEl.textContent = "✅ Installed — running as a standalone app.";
    statusEl.className = "text-xs font-semibold text-emerald-400";
  } else if (deferredInstallPrompt) {
    statusEl.textContent = "📲 Installable — use the button below to add MGPL to your device.";
    statusEl.className = "text-xs font-semibold text-brand-400";
  } else {
    statusEl.textContent = "ℹ️ Not installable in this browser/context.";
    statusEl.className = "text-xs font-semibold text-slate-400";
  }
}

async function handleInstallClick() {
  if (!deferredInstallPrompt) {
    showToast("This browser does not support app installation here.", true);
    return;
  }
  deferredInstallPrompt.prompt();
  try {
    const choice = await deferredInstallPrompt.userChoice;
    if (choice && choice.outcome === "accepted") {
      showToast("MGPL installed successfully 🎉");
    }
  } catch (err) {
    console.warn("Install prompt dismissed:", err);
  }
  deferredInstallPrompt = null;
  hideInstallBanner();
  updatePwaInstallStatus();
}

// Expose the theme engine, focus helpers, and PWA simulation hook globally so
// drawer.js/palette.js and the E2E suite can use them.
window.setTheme = setTheme;
window.getTheme = getTheme;
window.saveFocus = saveFocus;
window.restoreFocus = restoreFocus;
window.trapFocus = trapFocus;
window.__simulateBeforeInstallPrompt = () => {
  deferredInstallPrompt = {
    prompt: () => {},
    userChoice: Promise.resolve({ outcome: "accepted" }),
  };
  showInstallBanner();
  updatePwaInstallStatus();
};
window.announceToScreenReader = announceToScreenReader;

// Register a background-sync tag so the service worker can flush queued play

// sessions when connectivity returns even if the page is closed.
function registerPlaySessionSync() {
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "MGPL_REGISTER_SYNC" });
  }
}

// =========================================================================
// Play Session Stopwatch (Sprint 28) - FEAT-0162
// =========================================================================
// Tracks an active play session with a client-side stopwatch. When the user
// stops the timer, the session is POSTed to /api/backlog/session. If the
// network is unavailable the session is queued in IndexedDB and flushed later
// via background sync / the online event.
let activeSession = null; // { gameId, title, startedAt, timerId, elapsedSeconds }
let sessionTimerInterval = null;

function formatStopwatch(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function updateStopwatchDisplay() {
  const el = document.getElementById("session-timer-display");
  if (!el || !activeSession) return;
  const elapsed = Math.floor((Date.now() - activeSession.startedAt) / 1000);
  activeSession.elapsedSeconds = elapsed;
  el.textContent = formatStopwatch(elapsed);
}

function startStopwatchTicker() {
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  updateStopwatchDisplay();
  sessionTimerInterval = setInterval(updateStopwatchDisplay, 1000);
}

function stopStopwatchTicker() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

// Begin a play session for a given game. Returns the active session object.
function startPlaySession(gameId, title) {
  if (activeSession) {
    showToast("A play session is already running. Stop it first.", true);
    return activeSession;
  }
  if (!gameId) {
    showToast("Missing game ID to start a session.", true);
    return null;
  }
  activeSession = {
    gameId,
    title: title || "Untitled Game",
    startedAt: Date.now(),
    elapsedSeconds: 0,
  };
  startStopwatchTicker();

  // Reveal the stopwatch UI
  const panel = document.getElementById("session-timer-panel");
  if (panel) panel.classList.remove("hidden");
  const titleEl = document.getElementById("session-timer-title");
  if (titleEl) titleEl.textContent = activeSession.title;

  showToast(`⏱️ Session started for "${activeSession.title}"`);
  return activeSession;
}

// Stop the active play session and persist it (online or queued offline).
async function stopPlaySession() {
  if (!activeSession) {
    showToast("No active play session to stop.", true);
    return null;
  }
  stopStopwatchTicker();
  const session = activeSession;
  activeSession = null;

  const durationSeconds = Math.max(1, Math.floor((Date.now() - session.startedAt) / 1000));
  const sessionUuid =
    "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  const payload = {
    sessionUuid,
    gameId: session.gameId,
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds,
    deviceId: localStorage.getItem("activeDeviceId") || "local-host",
  };

  // Hide the stopwatch UI
  const panel = document.getElementById("session-timer-panel");
  if (panel) panel.classList.add("hidden");

  try {
    const res = await fetch("/api/backlog/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Logged ${formatStopwatch(durationSeconds)} for "${session.title}"`);
      registerPlaySessionSync();
      return data;
    }
    throw new Error(data.error || "Session sync failed");
  } catch (err) {
    // Offline path: queue the session for later background sync.
    if (window.OfflineStorage && typeof window.OfflineStorage.enqueueSession === "function") {
      await window.OfflineStorage.enqueueSession(payload);
      registerPlaySessionSync();
      showToast(`📴 Offline: session queued (${formatStopwatch(durationSeconds)})`);
      return { success: true, queued: true };
    }
    showToast("Failed to save play session", true);
    return null;
  }
}

// Expose session hooks for E2E verification and inline UI buttons.
window.startPlaySession = startPlaySession;
window.stopPlaySession = stopPlaySession;

// Expose helpers for e2e verification.
window.__offlineHelpers = { apiFetch, setOfflineStatus, offlineCacheTarget };

document.addEventListener("DOMContentLoaded", () => {
  // Initialize Lucide icons if available
  if (window.lucide) window.lucide.createIcons();

  // Register service worker & offline status listeners (FEAT-0151)
  registerServiceWorker();
  initOfflineStatusListeners();

  // =========================================================================
  // Theme Engine Boot (Sprint 33 / FEAT-0167)
  // =========================================================================
  // Apply the persisted theme on startup and react to OS preference changes.
  applyTheme(getTheme());

  // Re-apply the theme when the OS color-scheme or reduced-motion preference
  // changes so "system" auto-detection stays live.
  if (window.matchMedia) {
    const colorSchemeMq = window.matchMedia("(prefers-color-scheme: dark)");
    const reducedMotionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onPrefChange = () => applyTheme(getTheme());
    if (colorSchemeMq.addEventListener) {
      colorSchemeMq.addEventListener("change", onPrefChange);
      reducedMotionMq.addEventListener("change", onPrefChange);
    } else if (colorSchemeMq.addListener) {
      colorSchemeMq.addListener(onPrefChange);
      reducedMotionMq.addListener(onPrefChange);
    }
  }

  // =========================================================================
  // PWA Install Prompt Listeners (Sprint 33 / FEAT-0167)
  // =========================================================================
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallBanner();
    updatePwaInstallStatus();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    hideInstallBanner();
    updatePwaInstallStatus();
  });

  // Wire the install banner buttons (top-of-page banner).
  const pwaInstallBtn = document.getElementById("btn-pwa-install");
  if (pwaInstallBtn) {
    pwaInstallBtn.addEventListener("click", handleInstallClick);
  }
  const pwaDismissBtn = document.getElementById("btn-pwa-dismiss");
  if (pwaDismissBtn) {
    pwaDismissBtn.addEventListener("click", hideInstallBanner);
  }

  // Listen for background-sync messages from the service worker. When the SW

  // fires the "sync-play-sessions" tag, flush any queued offline sessions.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "MGPL_SYNC_PLAY_SESSIONS") {
        if (window.OfflineStorage && typeof window.OfflineStorage.syncPlaySessions === "function") {
          window.OfflineStorage.syncPlaySessions()
            .then((n) => {
              if (n > 0) showToast(`Synced ${n} offline play session${n > 1 ? "s" : ""}`);
            })
            .catch(() => {});
        }
      }
    });
  }

  // Wire the stopwatch Start/Stop buttons (event delegation on the timer panel).
  const sessionTimerPanel = document.getElementById("session-timer-panel");
  if (sessionTimerPanel) {
    sessionTimerPanel.addEventListener("click", (e) => {
      const startBtn = e.target.closest("#session-timer-start");
      const stopBtn = e.target.closest("#session-timer-stop");
      if (startBtn) {
        const gameId = startBtn.getAttribute("data-game-id");
        const title = startBtn.getAttribute("data-title");
        startPlaySession(gameId, title);
      } else if (stopBtn) {
        stopPlaySession();
      }
    });
  }

  // Elements
  const scanBtn = document.getElementById("scan-btn");

  const deviceBadge = document.getElementById("device-badge");

  // Sprint 3 (EPIC-DEAL-001): canonical Deals 4-tab panel resolver.
  // Legacy keys are mapped to the canonical panel IDs so existing links and
  // the deep-link query string remain backward compatible.
  function normalizeDealsTab(store) {
    const s = String(store || "").toLowerCase();
    if (s === "all" || s === "store" || s === "store-sales") return "sales";
    if (s === "release-radar" || s === "releases") return "radar";
    if (s === "giveaways" || s === "giveaway" || s === "freebies") return "giveaways";
    if (s === "wishlist" || s === "wishlist-drops") return "wishlist";
    // Sprint 2 (WUD-2.2 / EPIC-02): Price Arbitrage tab.
    if (s === "arbitrage" || s === "price-arbitrage" || s === "pricearbitrage") return "arbitrage";
    if (s === "sales" || s === "radar") return s;
    return "sales";
  }

  // Resolve the active deals content panel element for a canonical tab key.
  function dealsContainerFor(store) {
    const key = normalizeDealsTab(store);
    return document.getElementById("deals-panel-" + key);
  }

  // Playability Matrix State
  let currentDeviceId = localStorage.getItem("activeDeviceId") || "local-host";
  let currentTierFilter = "all";
  // Sprint 7 (WUD-7.2): "Display only current system hardware" toggle. When
  // enabled, the matrix only shows games whose ratings were computed against
  // the real persisted active system (never a fallback/blocked profile).
  let dpmCurrentSystemOnly = false;
  let playabilityMatrixData = null;

  // AI-082 (#161): on a hosted site the server would scan its own hardware,
  // not the visitor's PC. GET /api/host-scan/status says whether the scan
  // routes run here; only a successful answer is remembered, so a failed
  // request is retried on the next click and never enables the scan.
  let hostScanStatus = null;
  async function hostScanAvailable() {
    if (hostScanStatus !== null) return hostScanStatus;
    try {
      const res = await fetch("/api/host-scan/status");
      if (!res.ok) return false;
      const data = await res.json();
      hostScanStatus = data?.enabled === true;
      return hostScanStatus;
    } catch (err) {
      console.error("Host scan status error:", err);
      return false;
    }
  }

  // Where the scan does not run, "Scan Local PC" opens the Device Fleet form
  // so the user adds their own device instead.
  function openFleetFormInsteadOfScan() {
    const notAvailable = "Scan not available on this site";
    const statusText = document.getElementById("device-status-text");
    if (statusText) {
      statusText.textContent = notAvailable;
    } else if (deviceBadge) {
      // A scan already started replaced the badge's contents with its own text.
      deviceBadge.textContent = notAvailable;
      deviceBadge.className =
        "px-3 py-1 bg-slate-800 text-slate-300 text-xs font-semibold rounded-full";
    }
    showToast("Scanning this PC is not available on this site. Add your device in Device Fleet.");
    window.location.hash = "#/fleet";
    if (typeof window.openFleetModal === "function") window.openFleetModal();
  }
  // The Hardware Explorer's "Scan Rig" (hardware.js) uses the same hand-off,
  // so the header badge reads the same whichever button was clicked.
  window.mgplOpenFleetInsteadOfScan = openFleetFormInsteadOfScan;

  // 1. Scan Local Device
  async function fetchLocalDevice(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!(await hostScanAvailable())) {
      openFleetFormInsteadOfScan();
      return;
    }
    try {
      if (deviceBadge) {
        deviceBadge.textContent = "Scanning...";
        deviceBadge.className =
          "px-3 py-1 bg-amber-900 text-amber-300 text-xs font-semibold rounded-full animate-pulse";
      }
      showToast("Scanning local PC hardware specs...");
      const res = await fetch("/api/devices/scan", { method: "POST" });
      const data = await res.json();
      if (res.status === 404 && data?.code === "HOST_SCAN_DISABLED") {
        hostScanStatus = false;
        openFleetFormInsteadOfScan();
        return;
      }
      if (data?.success && data?.device) {
        const dev = data.device;
        if (deviceBadge) {
          deviceBadge.textContent = `${dev.cpuModel ?? "CPU"} | ${dev.gpuModel ?? "GPU"}`;
          deviceBadge.className =
            "px-3 py-1 bg-green-900 text-green-300 text-xs font-semibold rounded-full";
        }
        localStorage.setItem("activeDeviceId", dev.id || dev.deviceId || "local-host");
        currentDeviceId = dev.id || dev.deviceId || "local-host";

        // Auto-select Local PC and trigger scan matrix fetch
        const presetSelect = document.getElementById("device-preset-select");
        if (presetSelect) {
          presetSelect.value = currentDeviceId;
        }
        showToast("Local PC hardware specs updated!");
        fetchPlayableGames(currentDeviceId, currentTierFilter);
        if (typeof renderDeviceFleet === "function") {
          renderDeviceFleet();
        }
      } else {
        if (deviceBadge) deviceBadge.textContent = "Scan Failed";
        showToast("Failed to scan local device hardware", "error");
      }
    } catch (err) {
      console.error("Local device scan error:", err);
      if (deviceBadge) deviceBadge.textContent = "Scan Error";
      showToast("Error scanning local PC hardware specs", "error");
    }
  }

  async function resolveFallbackDevice() {
    try {
      const res = await apiFetch("/api/devices");
      const data = await res.json();
      if (data.success && Array.isArray(data.devices) && data.devices.length > 0) {
        return data.devices[0].id || "local-host";
      }
    } catch (e) {
      console.warn("Could not fetch device fleet for fallback resolution:", e);
    }
    return "local-host";
  }

  // DPM-07 / DPM-11: render a graceful blocked/stale/fallback banner above the
  // playability grid. The matrix never silently pretends an incomplete or
  // stale device (or a pure fallback profile) is authoritative.
  function renderPlayabilityBanner(data) {
    const banner = document.getElementById("playability-matrix-banner");
    if (!banner) return;
    const base = "hidden px-4 py-3 rounded-xl border text-xs font-semibold";
    if (!data) {
      banner.textContent = "";
      banner.className = base;
      return;
    }
    let text = "";
    let cls = base;
    if (data.blockedSpecs) {
      text =
        "⚠️ Device specs incomplete (missing RAM/VRAM). Run a hardware scan to refresh before evaluating playability.";
      cls += " bg-amber-500/10 border-amber-500/30 text-amber-300";
    } else if (data.staleSpecs) {
      text =
        "⚠️ Stale hardware specs — run a device scan to refresh before relying on these ratings.";
      cls += " bg-amber-500/10 border-amber-500/30 text-amber-300";
    } else if (data.usingFallback) {
      text =
        "ℹ️ Using a fallback hardware profile — no matching scanned device was found in your fleet.";
      cls += " bg-sky-500/10 border-sky-500/30 text-sky-300";
    }
    banner.textContent = text;
    banner.className = cls;
  }

  // Playability Matrix Logic
  function getDpmGamesToRender(games) {
    const allGames = Array.isArray(games) ? games : [];
    let gamesToRender = [];
    if (currentTierFilter === "all") {
      gamesToRender = allGames;
    } else if (currentTierFilter === "great") {
      gamesToRender = allGames.filter((g) =>
        (g?.playabilityTier || "Playable").toLowerCase().includes("great"),
      );
    } else if (currentTierFilter === "playable") {
      gamesToRender = allGames.filter((g) => {
        const tierLower = (g?.playabilityTier || "Playable").toLowerCase();
        return (
          tierLower.includes("playable") ||
          tierLower.includes("low fps") ||
          tierLower.includes("tweaks")
        );
      });
    }

    if (dpmCurrentSystemOnly) {
      gamesToRender = gamesToRender.filter((g) => g && g.deviceMatched !== false);
    }

    return gamesToRender;
  }

  function renderDpmCountLabel(gamesToRender) {
    const dpmCountEl = document.getElementById("dpm-count-label");
    if (!dpmCountEl) return;
    const count = Array.isArray(gamesToRender) ? gamesToRender.length : 0;
    const shown = Math.min(count, libraryPageSize);
    dpmCountEl.textContent =
      count > libraryPageSize
        ? `Showing ${shown} of ${count} games · Library page size (${libraryPageSize})`
        : `${count} games · Library page size (${libraryPageSize})`;
  }

  async function fetchPlayableGames(deviceId, tierFilter, isRetry = false) {
    currentDeviceId = deviceId || localStorage.getItem("activeDeviceId") || "local-host";
    localStorage.setItem("activeDeviceId", currentDeviceId);

    // Sync dropdowns
    const presetSelect = document.getElementById("device-preset-select");
    if (presetSelect && presetSelect.value !== currentDeviceId) {
      presetSelect.value = currentDeviceId;
    }
    const fleetSelect = document.getElementById("fleet-device-select");
    if (fleetSelect && fleetSelect.value !== currentDeviceId) {
      fleetSelect.value = currentDeviceId;
    }

    const container = document.getElementById("playable-games-container");
    if (container) {
      container.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500 mb-2"></div>
          <p class="text-sm font-medium">Compiling playability list...</p>
        </div>
      `;
    }
    renderPlayabilityBanner(null);

    try {
      const res = await apiFetch(
        `/api/devices/playability?deviceId=${encodeURIComponent(currentDeviceId)}`,
      );
      const data = await res.json();

      if (data.success && data.games) {
        playabilityMatrixData = data;
        renderPlayabilityBanner(data);
        currentTierFilter = tierFilter || currentTierFilter || "all";
        renderDpmCountLabel(getDpmGamesToRender(data.games));

        // DPM-07: graceful failure — never compute a matrix with missing RAM/VRAM.
        if (data.blockedSpecs) {
          if (container) {
            container.innerHTML = `
              <div class="col-span-full text-center py-12 text-slate-500">
                <p class="text-sm font-medium">Refresh device scan required — hardware specs incomplete.</p>
              </div>
            `;
          }
          return;
        }

        // Update Summary Bar
        const summaryDeviceName = document.getElementById("summary-device-name");
        const summaryGpu = document.getElementById("summary-gpu");
        const summaryVram = document.getElementById("summary-vram");
        const summaryCpu = document.getElementById("summary-cpu");
        const summaryBattery = document.getElementById("summary-battery");

        const specs = data.deviceSpecs || {};
        if (summaryDeviceName) summaryDeviceName.textContent = data.deviceName || currentDeviceId;
        if (summaryGpu) summaryGpu.textContent = specs.gpuModel || "N/A";
        if (summaryVram)
          summaryVram.textContent = specs.vramGb != null ? `${specs.vramGb} GB` : "N/A";
        if (summaryCpu) summaryCpu.textContent = specs.cpuModel || "N/A";
        if (summaryBattery)
          summaryBattery.textContent =
            specs.batteryWh != null && specs.batteryWh > 0 ? `${specs.batteryWh} Wh` : "N/A";

        updateTabStyles();
        try {
          renderPlayableGames();
        } catch (renderErr) {
          console.error("Error rendering playable games matrix:", renderErr);
          renderFallbackCatalogCards(data.games, container);
        }
      } else {
        if (!isRetry) {
          const fallbackId = await resolveFallbackDevice();
          if (fallbackId && fallbackId !== currentDeviceId) {
            return fetchPlayableGames(fallbackId, tierFilter, true);
          }
        }
        if (container) {
          container.innerHTML = `
            <div class="col-span-full text-center py-12 text-red-400">
              <p class="text-sm">Failed to retrieve playability details.</p>
            </div>
          `;
        }
      }
    } catch (err) {
      console.error("Failed to fetch playable games matrix:", err);
      if (!isRetry) {
        const fallbackId = await resolveFallbackDevice();
        if (fallbackId && fallbackId !== currentDeviceId) {
          return fetchPlayableGames(fallbackId, tierFilter, true);
        }
      }
      if (container) {
        container.innerHTML = `
          <div class="col-span-full text-center py-12 text-red-400">
            <p class="text-sm">Failed to retrieve playability details.</p>
          </div>
        `;
      }
    }
  }

  function renderFallbackCatalogCards(games, container) {
    const targetContainer = container || document.getElementById("playable-games-container");
    if (!targetContainer) return;
    if (!Array.isArray(games) || games.length === 0) {
      targetContainer.innerHTML = `
        <div class="col-span-full text-center py-12 text-slate-500">
          <p class="text-sm font-medium">No catalog games available.</p>
        </div>
      `;
      return;
    }

    targetContainer.innerHTML = games
      .map((g) => {
        const gameId = g?.id || g?.gameId || g?.gameID || "";
        const title = g?.gameTitle || g?.title || "Untitled Game";
        const coverUrl = g?.coverUrl || g?.cover_url || "";
        const tier = g?.playabilityTier || "Playable";

        return `
        <a href="#/game/${gameId}" class="game-card cursor-pointer bg-slate-900/40 border border-slate-800 hover:border-brand-500/30 rounded-2xl p-4 flex flex-col justify-between shadow-xl transition-all hover:scale-[1.01] group block no-underline" data-game-id="${gameId}" data-game-title="${title}">
          <div>
            <div class="aspect-[3/4] bg-slate-950 rounded-xl mb-4 overflow-hidden flex items-center justify-center relative shadow-inner">
              ${
                coverUrl
                  ? `<img src="${coverUrl}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-slate-900 flex items-center justify-center p-2 text-center text-xs text-slate-400 font-semibold\\'>${title}</div>';" class="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="${title}" />`
                  : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-2 text-center text-xs text-slate-400 font-semibold">${title}</div>`
              }
              <span class="playability-tier-badge absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-slate-950/80 backdrop-blur text-[10px] font-black tracking-wider uppercase text-slate-300 border border-slate-700">
                ${tier}
              </span>
            </div>
            <h3 class="font-bold text-white text-sm mb-1.5 truncate group-hover:text-brand-400 transition-colors" title="${title}">${title}</h3>
          </div>
        </a>
      `;
      })
      .join("");

    if (window.lucide) window.lucide.createIcons();
  }

  function renderPlayableGames() {
    const container = document.getElementById("playable-games-container");
    if (!container) return;
    if (!playabilityMatrixData || !Array.isArray(playabilityMatrixData.games)) {
      container.innerHTML = `
        <div class="col-span-full text-center py-12 text-slate-500">
          <p class="text-sm">No playability data available.</p>
        </div>
      `;
      return;
    }

    let gamesToRender = getDpmGamesToRender(playabilityMatrixData.games);
    renderDpmCountLabel(gamesToRender);
    gamesToRender = gamesToRender.slice(0, libraryPageSize);

    if (gamesToRender.length === 0) {
      container.innerHTML = `
        <div class="col-span-full text-center py-12 text-slate-500">
          <p class="text-sm font-medium">${
            dpmCurrentSystemOnly
              ? "No games verified for the current system hardware — run a device scan (or select your active device) to enable this filter."
              : "No games found in this performance category."
          }</p>
        </div>
      `;
      return;
    }

    container.innerHTML = gamesToRender
      .map((game) => {
        const tierStr = (game?.playabilityTier || "Playable").toLowerCase();
        const rawTierDisplay = game?.playabilityTier || "Playable";
        const isGreat = tierStr.includes("great") || tierStr.includes("60 fps");
        const isPlayable = tierStr.includes("playable") || tierStr.includes("30-60");

        const badgeColor = isGreat
          ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
          : isPlayable
            ? "text-amber-400 bg-amber-500/10 border border-amber-500/20"
            : "text-rose-400 bg-rose-500/10 border border-rose-500/20";
        const badgeIcon = isGreat ? "🟢" : isPlayable ? "🟡" : "🔴";

        const ramHeadroom = game?.ramHeadroomGb ?? game?.specs?.ramHeadroomGb ?? null;
        const vramHeadroom = game?.vramHeadroomGb ?? game?.specs?.vramHeadroomGb ?? null;

        const ramText =
          ramHeadroom != null
            ? ramHeadroom >= 0
              ? `+${ramHeadroom} GB`
              : `${ramHeadroom} GB`
            : "N/A";
        const vramText =
          vramHeadroom != null
            ? vramHeadroom >= 0
              ? `+${vramHeadroom} GB`
              : `${vramHeadroom} GB`
            : "N/A";

        const ramColor =
          ramHeadroom != null && ramHeadroom < 0
            ? "text-rose-400 font-bold"
            : "text-slate-300 font-semibold";
        const vramColor =
          vramHeadroom != null && vramHeadroom < 0
            ? "text-rose-400 font-bold"
            : "text-slate-300 font-semibold";

        const gameTitle = game?.gameTitle || game?.title || "Untitled Game";
        const gameId = game?.gameID || game?.id || game?.gameId || "";
        const coverUrl = game?.coverUrl || game?.cover_url || "";
        const batteryRuntimeText =
          game?.estimatedBatteryRuntimeText ||
          (game?.estimatedBatteryRuntime ? `${game.estimatedBatteryRuntime}h` : "N/A");
        const targetRes = game?.targetResolution || "N/A";
        const targetFps = game?.targetFramerate || "N/A";
        const presetLevel = game?.presetLevel || "N/A";
        const recNotes = game?.recommendedNotes || "No specific recommendations.";

        const tags = Array.isArray(game?.tags) ? game.tags : [];
        const tagsHtml = tags
          .map((t) => {
            const tagName = typeof t === "string" ? t : t.tagName || t.tag_name || "";
            const colorHex =
              typeof t === "object" && (t.colorHex || t.color_hex)
                ? t.colorHex || t.color_hex
                : "#38bdf8";
            if (!tagName) return "";
            return `<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold border" style="background-color: ${colorHex}15; color: ${colorHex}; border-color: ${colorHex}30;">${tagName}</span>`;
          })
          .filter(Boolean)
          .join(" ");

        const nexusUrl =
          game?.nexusUrl ||
          game?.nexus_url ||
          game?.nexusModsUrl ||
          (tags.some((t) => (typeof t === "string" ? t : t.tagName) === "Moddable")
            ? `https://www.nexusmods.com/${gameId.replace(/[^a-z0-9]/gi, "")}`
            : null);

        const nexusLinkHtml = safeModUrl(nexusUrl)
          ? `<div class="mt-2"><a href="${safeModUrl(nexusUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="inline-flex items-center gap-1 text-[11px] font-medium text-orange-400 hover:text-orange-300 hover:underline"><span>Nexus Mods</span> <i data-lucide="external-link" class="w-3 h-3"></i></a></div>`
          : "";

        const titleForId = game?.title || game?.gameTitle || "";
        const gameIdentifier =
          game?.id || game?.gameId || (titleForId ? titleForId.replace(/[^a-z0-9]/gi, "") : "");

        return `
        <div onclick="if (!event.target.closest('a')) window.location.hash='#/game/${gameId}'" class="game-card cursor-pointer bg-slate-900/40 border border-slate-800 hover:border-brand-500/30 rounded-2xl p-4 flex flex-col justify-between shadow-xl transition-all hover:scale-[1.01] group block" data-game-id="${gameId}" data-game-title="${gameTitle}">
          <div>
            <div class="aspect-[3/4] bg-slate-950 rounded-xl mb-4 overflow-hidden flex items-center justify-center relative shadow-inner">
              ${
                coverUrl
                  ? `<img src="${coverUrl}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-gray-900 flex items-center justify-center p-2 text-center text-xs text-gray-400 font-semibold\\'>${gameTitle}</div>';" class="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="${gameTitle}" />`
                  : `<div class="w-full h-full bg-gray-900 flex items-center justify-center p-2 text-center text-xs text-gray-400 font-semibold">${gameTitle}</div>`
              }
              <span class="playability-tier-badge absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-slate-950/80 backdrop-blur text-[10px] font-black tracking-wider uppercase ${badgeColor}">
                ${badgeIcon} ${rawTierDisplay}
              </span>
            </div>
            <h3 class="font-bold text-white text-sm mb-1.5 truncate group-hover:text-brand-400 transition-colors" title="${gameTitle}">${gameTitle}</h3>
            
            ${tagsHtml ? `<div class="flex flex-wrap gap-1 mb-2">${tagsHtml}</div>` : ""}

            <div class="space-y-1.5 text-xs text-slate-400">
              <div class="flex items-center gap-1.5">
                <i data-lucide="cpu" class="w-3.5 h-3.5 text-slate-500"></i>
                <span>RAM Headroom: <strong class="ram-headroom-val ${ramColor}">${ramText}</strong></span>
              </div>
              <div class="flex items-center gap-1.5">
                <i data-lucide="monitor" class="w-3.5 h-3.5 text-slate-500"></i>
                <span>VRAM Headroom: <strong class="vram-headroom-val ${vramColor}">${vramText}</strong></span>
              </div>
              <div class="flex items-center gap-1.5">
                <i data-lucide="battery" class="w-3.5 h-3.5 text-slate-500"></i>
                <span>Battery Runtime: <strong class="battery-runtime-val text-slate-300 font-semibold">${batteryRuntimeText}</strong></span>
              </div>
              <div class="flex items-center gap-1.5">
                <i data-lucide="sliders" class="w-3.5 h-3.5 text-slate-500"></i>
                <span>Target & Preset: <strong class="text-slate-300 font-semibold">${targetRes} @ ${targetFps} (${presetLevel})</strong></span>
              </div>
            </div>

            ${nexusLinkHtml}
            <div id="nexus-badge-${gameIdentifier}"></div>
          </div>
          
          <div class="border-t border-slate-800/60 pt-3 mt-3.5">
            <p class="text-[11px] text-slate-400 italic line-clamp-2" title="${recNotes}">${recNotes}</p>
          </div>
        </div>
      `;
      })
      .join("");

    if (window.lucide) window.lucide.createIcons();

    // Asynchronously fetch Nexus Stats for rendered games
    gamesToRender.forEach((game) => {
      const titleForId = game?.title || game?.gameTitle || "";
      const gameIdentifier =
        game?.id || game?.gameId || (titleForId ? titleForId.replace(/[^a-z0-9]/gi, "") : "");
      const badgeEl = document.getElementById(`nexus-badge-${gameIdentifier}`);
      if (!badgeEl) return;

      const targetId = game.id || game.gameId;
      if (!targetId) return;

      fetch(`/api/games/${encodeURIComponent(targetId)}/nexus-stats`)
        .then((res) => res.json())
        .then((data) => {
          if (data.success && (data.modCount > 0 || data.collectionCount > 0)) {
            const modsText = `${data.modCount.toLocaleString()} Mods`;
            const collectionsText =
              data.collectionCount > 0
                ? ` | ${data.collectionCount.toLocaleString()} Collections`
                : "";
            badgeEl.innerHTML = `
              <div class="flex items-center gap-1.5 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-1 rounded-lg w-fit mt-1">
                <i data-lucide="package" class="w-3.5 h-3.5"></i>
                <span>Nexus Mods: <strong class="font-bold">${modsText}${collectionsText}</strong></span>
              </div>
            `;
            if (window.lucide) window.lucide.createIcons();
          } else {
            badgeEl.innerHTML = "";
          }
        })
        .catch(() => {
          badgeEl.innerHTML = "";
        });
    });
  }

  function updateTabStyles() {
    const activeClass = "text-brand-400 bg-slate-900 shadow-sm";
    const inactiveClass = "text-slate-400 hover:text-slate-200 bg-transparent";
    const tabAll = document.getElementById("tab-all-playable");
    const tabGreat = document.getElementById("tab-great");
    const tabPlayable = document.getElementById("tab-playable");

    if (tabAll) {
      tabAll.className = `px-3 py-1.5 rounded-lg transition-all ${currentTierFilter === "all" ? activeClass : inactiveClass}`;
    }
    if (tabGreat) {
      tabGreat.className = `px-3 py-1.5 rounded-lg transition-all ${currentTierFilter === "great" ? activeClass : inactiveClass}`;
    }
    if (tabPlayable) {
      tabPlayable.className = `px-3 py-1.5 rounded-lg transition-all ${currentTierFilter === "playable" ? activeClass : inactiveClass}`;
    }
  }

  // =========================================================================
  // 2. Smart Session Recommender Engine
  // =========================================================================
  let recSelectedTime = "any";
  let recSelectedEnergy = "any";

  const recTimeBtnsContainer = document.getElementById("recommender-time-btns");
  if (recTimeBtnsContainer) {
    recTimeBtnsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".rec-time-btn");
      if (!btn) return;
      const val = btn.getAttribute("data-val");
      if (val) {
        recSelectedTime = val;
        recTimeBtnsContainer.querySelectorAll(".rec-time-btn").forEach((b) => {
          if (b.getAttribute("data-val") === recSelectedTime) {
            b.className =
              "rec-time-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-600 text-white transition-all shadow-md";
          } else {
            b.className =
              "rec-time-btn px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 transition-all";
          }
        });
      }
    });
  }

  const recEnergyBtnsContainer = document.getElementById("recommender-energy-btns");
  if (recEnergyBtnsContainer) {
    recEnergyBtnsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".rec-energy-btn");
      if (!btn) return;
      const val = btn.getAttribute("data-val");
      if (val) {
        recSelectedEnergy = val;
        recEnergyBtnsContainer.querySelectorAll(".rec-energy-btn").forEach((b) => {
          if (b.getAttribute("data-val") === recSelectedEnergy) {
            b.className =
              "rec-energy-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-600 text-white transition-all shadow-md";
          } else {
            b.className =
              "rec-energy-btn px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 hover:bg-slate-800 transition-all";
          }
        });
      }
    });
  }

  const recFindBtn = document.getElementById("btn-find-recommendation");
  if (recFindBtn) {
    recFindBtn.addEventListener("click", () => {
      fetchRecommendations();
    });
  }

  async function fetchRecommendations() {
    const recsContainer = document.getElementById("recommendations-container");
    if (!recsContainer) return;

    const installedOnly = document.getElementById("rec-installed-only")?.checked || false;

    recsContainer.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500 mb-2"></div>
        <p class="text-sm font-medium">Analyzing gaming matrix...</p>
      </div>
    `;

    try {
      const activeDevice = currentDeviceId || "local-host";
      const payload = {
        timeAvailable: recSelectedTime,
        energyLevel: recSelectedEnergy,
        installedOnly: Boolean(installedOnly),
        deviceId: activeDevice,
      };

      const res = await fetch("/api/recommender/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (
        !data.success ||
        !Array.isArray(data.recommendations) ||
        data.recommendations.length === 0
      ) {
        recsContainer.innerHTML = `
          <div class="col-span-full text-center py-12 text-slate-500">
            <p class="text-sm font-medium">No games match these exact session constraints.</p>
          </div>
        `;
        return;
      }

      recsContainer.innerHTML = data.recommendations
        .map((item) => {
          const gameId = item.gameId || item.id || "";
          const title = item.title || "Untitled Game";
          const coverUrl = item.coverUrl || "";
          const score = item.matchScore != null ? item.matchScore : 50;
          const tier = item.playabilityTier || "Playable";
          const hltb = item.hltbMainStoryHours ? `${item.hltbMainStoryHours}h` : "N/A";
          const reasons = Array.isArray(item.reasonTags) ? item.reasonTags : [];

          let badgeClass = "bg-slate-800 text-slate-300 border-slate-700";
          if (tier === "Verified" || tier === "Great") {
            badgeClass = "bg-emerald-950/80 text-emerald-400 border-emerald-500/30";
          } else if (tier === "Playable") {
            badgeClass = "bg-sky-950/80 text-sky-400 border-sky-500/30";
          } else if (tier === "Unsupported") {
            badgeClass = "bg-rose-950/80 text-rose-400 border-rose-500/30";
          }

          const tagsHtml = reasons
            .map(
              (r) =>
                `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">${r}</span>`,
            )
            .join(" ");

          return `
          <div class="game-card bg-slate-900/60 border border-slate-800 hover:border-brand-500/40 rounded-2xl p-4 flex flex-col justify-between shadow-xl transition-all hover:scale-[1.01] group">
            <div>
              <div class="aspect-[3/4] bg-slate-950 rounded-xl mb-3 overflow-hidden flex items-center justify-center relative shadow-inner">
                ${
                  coverUrl
                    ? `<img src="${coverUrl}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-slate-900 flex items-center justify-center p-2 text-center text-xs text-slate-400 font-semibold\\'>${title}</div>';" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="${title}"/>`
                    : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-2 text-center text-xs text-slate-400 font-semibold">${title}</div>`
                }
                <span class="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-lg bg-brand-950/90 backdrop-blur text-xs font-black text-brand-400 border border-brand-500/40 shadow-lg">
                  ${score}% Match
                </span>
                <span class="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md backdrop-blur text-[10px] font-bold uppercase tracking-wider border ${badgeClass}">
                  ${tier}
                </span>
              </div>
              
              <h3 class="font-bold text-white text-sm mb-1 truncate group-hover:text-brand-400 transition-colors" title="${title}">${title}</h3>
              
              <div class="flex flex-wrap gap-1.5 my-2.5">
                ${tagsHtml || '<span class="text-[10px] text-slate-500">Suggested for session</span>'}
              </div>
            </div>

            <div class="border-t border-slate-800/80 pt-3 mt-2 flex items-center justify-between gap-2">
              <span class="flex items-center gap-1 text-xs text-slate-400">
                <i data-lucide="clock" class="w-3.5 h-3.5 text-brand-400"></i>
                <span>HLTB: <strong class="text-white font-semibold">${hltb}</strong></span>
              </span>
              <a href="#/game/${gameId}" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold transition-all shadow-md hover:shadow-brand-500/20 no-underline">
                <i data-lucide="play" class="w-3 h-3 fill-current"></i>
                <span>Launch</span>
              </a>
            </div>
          </div>
        `;
        })
        .join("");

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Error fetching recommendations:", err);
      recsContainer.innerHTML =
        '<div class="col-span-full text-center py-12 text-rose-400 text-xs font-semibold">Failed to retrieve session recommendations.</div>';
    }
  }

  // =========================================================================
  // 3. Multi-Game Comparison Matrix Engine
  // =========================================================================
  let compareCatalogGames = [];
  let selectedCompareIds = [];

  // WUD-SPRINT9.2-COMPARE-DIFFERENCES-AND-PRESETS state
  let highlightDifferences = false;
  let lastComparisonGames = null;
  // EPIC-06 (Compare Section Reorganization): the default matrix view caps at
  // 8 key attribute rows; compareShowAll reveals the remaining cluster rows.
  let compareShowAll = false;
  const COMPARE_PRESETS = [
    {
      key: "backlog",
      label: "Backlog Showdown",
      icon: "⚔️",
      match: ["Elden Ring", "Cyberpunk 2077", "The Witcher 3", "Baldur's Gate"],
    },
    {
      key: "handheld",
      label: "Handheld Friendly",
      icon: "🎮",
      match: ["Hades", "Stardew Valley", "Hollow Knight", "Celeste"],
    },
  ];

  const compareTrigger = document.getElementById("compare-select-trigger");
  const compareDropdown = document.getElementById("compare-select-dropdown");
  const compareSearchInput = document.getElementById("compare-search-input");
  const compareGamesList = document.getElementById("compare-games-list");
  const selectedTagsContainer = document.getElementById("selected-tags-container");
  const comparePlaceholder = document.getElementById("compare-select-placeholder");
  const matrixValidationMsg = document.getElementById("matrix-validation-msg");

  if (compareTrigger && compareDropdown) {
    compareTrigger.addEventListener("click", (e) => {
      // Don't toggle if clicking a tag close button
      if (e.target.closest(".tag-remove-btn")) return;
      compareDropdown.classList.toggle("hidden");
      if (!compareDropdown.classList.contains("hidden") && compareSearchInput) {
        compareSearchInput.focus();
      }
    });

    document.addEventListener("click", (e) => {
      if (!compareTrigger.contains(e.target) && !compareDropdown.contains(e.target)) {
        compareDropdown.classList.add("hidden");
      }
    });
  }

  if (compareSearchInput) {
    compareSearchInput.addEventListener("input", (e) => {
      const term = e.target.value.toLowerCase().trim();
      renderCompareDropdownOptions(term);
    });
  }

  async function loadCompareCatalog() {
    if (compareCatalogGames.length > 0) {
      renderCompareDropdownOptions();
      return;
    }

    try {
      const res = await apiFetch("/api/games?active=true&owned=true");
      const data = await res.json();
      if (data.success && Array.isArray(data.games)) {
        compareCatalogGames = data.games;
        renderCompareDropdownOptions();
      }
    } catch (err) {
      console.error("Failed to load compare catalog:", err);
    }
  }

  function renderCompareDropdownOptions(filterTerm = "") {
    if (!compareGamesList) return;

    const filtered = compareCatalogGames.filter((g) => {
      const title = (g["Game Title"] || g.gameTitle || g.title || "").toLowerCase();
      return !filterTerm || title.includes(filterTerm);
    });

    if (filtered.length === 0) {
      compareGamesList.innerHTML =
        '<div class="text-center py-4 text-slate-500 text-xs">No matching games found</div>';
      return;
    }

    compareGamesList.innerHTML = filtered
      .map((g) => {
        const id = g.GameID || g.id || g.gameId;
        const title = g["Game Title"] || g.gameTitle || g.title || "Game";
        const isSelected = selectedCompareIds.includes(id);

        return `
        <label class="flex items-center justify-between p-2 hover:bg-slate-800 rounded-lg cursor-pointer transition-colors text-xs">
          <div class="flex items-center gap-2">
            <input type="checkbox" value="${id}" ${isSelected ? "checked" : ""} class="compare-game-checkbox rounded border-slate-700 text-brand-600 focus:ring-brand-500 bg-slate-950">
            <span class="text-white font-medium">${title}</span>
          </div>
          <span class="text-[10px] text-slate-500">${g["Primary Genre"] || g.primaryGenre || ""}</span>
        </label>
      `;
      })
      .join("");

    // Wire checkbox listeners
    compareGamesList.querySelectorAll(".compare-game-checkbox").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.value;
        if (e.target.checked) {
          if (selectedCompareIds.length >= 4) {
            e.target.checked = false;
            showToast("You can compare a maximum of 4 games at once.", true);
            return;
          }
          if (!selectedCompareIds.includes(id)) selectedCompareIds.push(id);
        } else {
          selectedCompareIds = selectedCompareIds.filter((i) => i !== id);
        }
        updateCompareSelectionUI();
      });
    });
  }

  function updateCompareSelectionUI() {
    if (!selectedTagsContainer || !comparePlaceholder) return;

    if (selectedCompareIds.length === 0) {
      comparePlaceholder.style.display = "inline";
      selectedTagsContainer.innerHTML = "";
    } else {
      comparePlaceholder.style.display = "none";
      selectedTagsContainer.innerHTML = selectedCompareIds
        .map((id) => {
          const game = compareCatalogGames.find((g) => (g.GameID || g.id || g.gameId) === id);
          const title = game ? game["Game Title"] || game.gameTitle || game.title || id : id;

          return `
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold">
            <span>${title}</span>
            <button data-id="${id}" type="button" aria-label="Remove ${title} from comparison" title="Remove ${title} from comparison" class="tag-remove-btn hover:text-white transition-colors">&times;</button>
          </span>
        `;
        })
        .join("");

      selectedTagsContainer.querySelectorAll(".tag-remove-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const removeId = btn.getAttribute("data-id");
          selectedCompareIds = selectedCompareIds.filter((i) => i !== removeId);
          renderCompareDropdownOptions(
            compareSearchInput ? compareSearchInput.value.toLowerCase().trim() : "",
          );
          updateCompareSelectionUI();
        });
      });
    }

    if (selectedCompareIds.length >= 2 && selectedCompareIds.length <= 4) {
      if (matrixValidationMsg) matrixValidationMsg.style.display = "none";
      fetchComparison(selectedCompareIds);
    } else {
      if (matrixValidationMsg) matrixValidationMsg.style.display = "flex";
      lastComparisonGames = null;
      renderEmptyMatrix();
    }

    // WUD-SPRINT9.2: enable/disable the Markdown copy button based on selection
    const copyMdBtnState = document.getElementById("btn-copy-md-summary");
    if (copyMdBtnState) {
      const canCopy = selectedCompareIds.length >= 2 && selectedCompareIds.length <= 4;
      copyMdBtnState.disabled = !canCopy;
      copyMdBtnState.className = canCopy
        ? "px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-all flex items-center gap-2"
        : "px-4 py-2 rounded-xl bg-slate-800 text-slate-500 text-xs font-bold border border-slate-700 transition-all flex items-center gap-2 cursor-not-allowed";
    }
  }

  // ---- Matrix render helpers (WUD-SPRINT9.1-COMPARE-MATRIX-ENGINE) ----
  const matrixLabelCell = '<td class="p-4 font-semibold text-slate-400 bg-slate-900/40">';

  function matrixGameCell(html, cls = "") {
    return `<td class="p-4 text-center align-top border-l border-slate-800/80 ${cls}">${html}</td>`;
  }

  function buildAddGameSlotButton() {
    return `
      <button data-action="add-game" class="add-game-slot-btn w-full min-h-[72px] px-3 py-4 rounded-xl border-2 border-dashed border-slate-700 hover:border-amber-500/60 hover:bg-amber-500/5 text-slate-500 hover:text-amber-400 transition-all flex flex-col items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-wider">
        <i data-lucide="plus" class="w-4 h-4"></i>
        <span>Add Game</span>
      </button>
    `;
  }

  function buildAddGameSlotCell() {
    return `
      <td class="p-4 text-center align-top border-l border-slate-800/80 bg-slate-900/20">
        ${buildAddGameSlotButton()}
      </td>
    `;
  }

  // Header variant: the <th> must NOT wrap a <td> (invalid HTML that leaves
  // the header cell empty — an axe empty-table-header violation). scope="col"
  // plus the visible "Add Game" button keep it WCAG 2.1 AA compliant.
  function buildAddGameSlotHeader() {
    return `
      <th scope="col" class="p-4 text-center align-top border-l border-slate-800 bg-slate-900/40 min-w-[150px]">
        ${buildAddGameSlotButton()}
      </th>
    `;
  }

  function matrixSectionHeader(label, sub, colCount, cluster = "") {
    const clusterAttr = cluster ? ` data-compare-cluster="${cluster}"` : "";
    return `
      <tr class="matrix-section-header"${clusterAttr}>
        <td class="p-3 font-extrabold text-white uppercase tracking-wider text-xs bg-slate-800/70" colspan="${colCount}">
          ${label}
          ${sub ? `<span class="ml-2 font-normal text-slate-400 normal-case">${sub}</span>` : ""}
        </td>
      </tr>
    `;
  }

  function matrixLabelRow(label, cellsHtml, renderAddSlot = true, extra = false) {
    const cells = cellsHtml.map((html) => matrixGameCell(html)).join("");
    const addSlot = renderAddSlot ? buildAddGameSlotCell() : "";
    const extraAttr = extra ? ' data-compare-extra="true"' : "";
    return `<tr${extraAttr}>${matrixLabelCell}${label}</td>${cells}${addSlot}</tr>`;
  }

  // ---- WUD-SPRINT9.2-COMPARE-DIFFERENCES-AND-PRESETS helpers ----

  function applyDifferenceHighlights(body) {
    if (!body) return;
    const diffCells = [];
    body.querySelectorAll("tr").forEach((tr) => {
      if (tr.classList.contains("matrix-section-header")) return;
      const cells = Array.from(tr.querySelectorAll("td.border-l"));
      if (cells.length < 2) return;
      const texts = cells.map((td) => (td.textContent || "").replace(/\s+/g, " ").trim());
      if (new Set(texts).size > 1) {
        cells.forEach((td) => {
          if (!td.querySelector(".add-game-slot-btn")) diffCells.push(td);
        });
      }
    });
    diffCells.forEach((td) => {
      if (highlightDifferences) {
        if (!td.classList.contains("bg-amber-500/10")) {
          td.classList.add("bg-amber-500/10", "border-amber-500/30");
        }
      } else {
        td.classList.remove("bg-amber-500/10", "border-amber-500/30");
      }
    });
  }

  function resolvePresetByIds(presetKey) {
    const preset = COMPARE_PRESETS.find((p) => p.key === presetKey);
    if (!preset || !Array.isArray(preset.match)) return [];
    return preset.match
      .map((needle) => {
        const lower = needle.toLowerCase();
        const found = compareCatalogGames.find((g) => {
          const title = (g["Game Title"] || g.gameTitle || g.title || "").toLowerCase();
          return title.includes(lower) || lower.includes(title);
        });
        return found ? found.GameID || found.id || found.gameId : null;
      })
      .filter(Boolean)
      .slice(0, 4);
  }

  function mdCell(value) {
    return String(value ?? "N/A")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
  }

  function buildMarkdownSummary(games) {
    if (!Array.isArray(games) || games.length < 2) return "";
    const headers = ["Specification", ...games.map((g) => mdCell(g.title || g.gameId))];
    const headerRow = `| ${headers.join(" | ")} |`;
    const sepRow = `| ${headers.map(() => "---").join(" | ")} |`;

    const rows = [
      ["Developer", (g) => mdCell(g.developer)],
      [
        "Genres",
        (g) => mdCell(Array.isArray(g.genres) && g.genres.length ? g.genres.join(", ") : null),
      ],
      [
        "RAM Min / Rec",
        (g) => `${mdCell(g.specs?.minimum?.ramGb)} / ${mdCell(g.specs?.recommended?.ramGb)}`,
      ],
      [
        "VRAM Min / Rec",
        (g) => `${mdCell(g.specs?.minimum?.vramGb)} / ${mdCell(g.specs?.recommended?.vramGb)}`,
      ],
      [
        "CPU Min / Rec",
        (g) => `${mdCell(g.specs?.minimum?.cpu)} / ${mdCell(g.specs?.recommended?.cpu)}`,
      ],
      [
        "GPU Min / Rec",
        (g) => `${mdCell(g.specs?.minimum?.gpu)} / ${mdCell(g.specs?.recommended?.gpu)}`,
      ],
      ["Storage Size", (g) => mdCell(g.specs?.minimum?.storage || g.storageSize)],
      ["SSD Required", (g) => mdCell(g.specs?.minimum?.ssdRequired)],
      [
        "Friction Score",
        (g) => (g.frictionScore ? `${g.frictionScore.level} (${g.frictionScore.score}/100)` : null),
      ],
      ["HLTB Main Story", (g) => (g.hltb?.mainStory != null ? `${g.hltb.mainStory} hrs` : null)],
      ["HLTB 100%", (g) => (g.hltb?.completionist != null ? `${g.hltb.completionist} hrs` : null)],
      ["Playability", (g) => mdCell(g.playabilityBadge)],
      [
        "Est. Battery",
        (g) => (g.estimatedBatteryRuntime != null ? `${g.estimatedBatteryRuntime} hrs` : null),
      ],
      ["Active Mods", (g) => mdCell(g.activeModCount != null ? `${g.activeModCount} Mods` : null)],
    ];

    const bodyRows = rows.map(([label, fn]) => {
      const cells = [label, ...games.map(fn)];
      return `| ${cells.join(" | ")} |`;
    });

    return [headerRow, sepRow, ...bodyRows].join("\n");
  }

  async function copyMarkdownSummary() {
    if (!lastComparisonGames || lastComparisonGames.length < 2) {
      showToast("Select at least 2 games to copy a Markdown summary.", true);
      return;
    }
    const md = buildMarkdownSummary(lastComparisonGames);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(md);
      } else {
        const ta = document.createElement("textarea");
        ta.value = md;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      showToast("Markdown summary copied to clipboard");
    } catch (err) {
      console.error("Failed to copy Markdown summary:", err);
      showToast("Failed to copy Markdown summary", true);
    }
  }

  function openCompareDropdown() {
    const dd = document.getElementById("compare-select-dropdown");
    if (dd) {
      dd.classList.remove("hidden");
      if (compareSearchInput) compareSearchInput.focus();
    }
  }

  function buildPlatformOwnershipCell(g) {
    const matrix = Array.isArray(g.platformMatrix) ? g.platformMatrix : [];
    const owned = matrix.filter((p) => p.isOwned);
    if (owned.length === 0) return '<span class="text-slate-500 text-xs">Not owned anywhere</span>';
    return owned
      .map(
        (p) => `
        <div class="flex flex-wrap items-center justify-center gap-1.5">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">✓ ${p.platform}</span>
          ${p.purchasePrice ? `<span class="text-[10px] font-bold text-emerald-300">${p.purchasePrice}</span>` : ""}
          ${p.edition && p.edition !== "Standard Edition" ? `<span class="text-[10px] text-slate-400">${p.edition}</span>` : ""}
        </div>
      `,
      )
      .join('<div class="h-1.5"></div>');
  }

  function buildDealCell(g) {
    const matrix = Array.isArray(g.platformMatrix) ? g.platformMatrix : [];
    const deals = matrix.filter((p) => !p.isOwned);
    if (deals.length === 0)
      return '<span class="text-slate-500 text-xs">No unowned store deals listed</span>';
    return deals
      .map(
        (p) => `
        <div class="flex flex-wrap items-center justify-center gap-1.5">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-bold">🏷️ ${p.platform}</span>
          ${p.currentPrice ? `<span class="text-[10px] font-bold text-amber-300">${p.currentPrice}</span>` : ""}
          ${p.discountPercent ? `<span class="text-[10px] font-bold text-rose-400">-${p.discountPercent}</span>` : ""}
          ${p.regularPrice ? `<span class="text-[10px] text-slate-500 line-through">${p.regularPrice}</span>` : ""}
          ${p.storeUrl ? `<a href="${p.storeUrl}" target="_blank" rel="noopener" class="text-[10px] text-slate-400 hover:text-white underline">view</a>` : ""}
        </div>
      `,
      )
      .join('<div class="h-1.5"></div>');
  }

  function buildFrictionScoreCell(g) {
    const fs = g.frictionScore;
    if (!fs) return "N/A";
    const color =
      fs.level === "Low"
        ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
        : fs.level === "Moderate"
          ? "text-amber-300 bg-amber-500/10 border-amber-500/30"
          : "text-rose-300 bg-rose-500/10 border-rose-500/30";
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold ${color}">${fs.level} · ${fs.score}/100</span>`;
  }

  function buildFrictionFactorsCell(g) {
    const factors = Array.isArray(g.frictionScore?.factors) ? g.frictionScore.factors : [];
    if (!factors.length) return "N/A";
    return factors
      .map(
        (f) => `
        <span class="inline-block px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[10px] font-semibold border border-slate-700">${f}</span>
      `,
      )
      .join(" ");
  }

  function buildFrictionBadgesCell(g) {
    const f = Array.isArray(g.frictions) ? g.frictions[0] : null;
    if (!f) return "N/A";
    const chips = [];
    if (f.saveSystemType) chips.push(`Save: ${f.saveSystemType}`);
    if (f.sessionLength) chips.push(`Session: ${f.sessionLength}`);
    if (f.mentalEnergy) chips.push(`Energy: ${f.mentalEnergy}`);
    if (f.alwaysOnline) chips.push(`Online: ${f.alwaysOnline}`);
    if (f.thirdPartyLauncher) chips.push(`Launcher: ${f.thirdPartyLauncher}`);
    if (!chips.length) return "N/A";
    return chips
      .map(
        (c) => `
        <span class="inline-block px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[10px] font-semibold border border-slate-700">${c}</span>
      `,
      )
      .join(" ");
  }

  const buildHeadroomCell = (key, unit) => (g) => {
    const v = g[key];
    if (v === null || v === undefined) return '<span class="text-xs text-slate-500">N/A</span>';
    const isPos = v >= 0;
    const cls = isPos ? "text-emerald-400 font-bold" : "text-rose-400 font-bold";
    return `<span class="text-xs ${cls}">${isPos ? `+${v} ${unit} Headroom` : `${v} ${unit} Deficit`}</span>`;
  };

  function renderEmptyMatrix() {
    const headerRow = document.getElementById("matrix-header-row");
    const body = document.getElementById("matrix-body");
    if (headerRow) {
      headerRow.innerHTML = `
        <th class="p-4 w-60 bg-slate-900/80">Specifications</th>
        <th class="p-4 text-center text-slate-500">Select 2 to 4 games to view matrix</th>
      `;
    }
    if (body) {
      const colCount = 2;
      const rows = [
        matrixSectionHeader("Performance", "Requirements & Playability", colCount, "performance"),
        matrixLabelRow("RAM (Min / Rec)", []),
        matrixLabelRow("VRAM (Min / Rec)", []),
        matrixLabelRow("CPU (Min / Rec)", []),
        matrixLabelRow("GPU (Min / Rec)", []),
        matrixLabelRow("Target FPS & Playability", []),
        matrixLabelRow("Storage Size", [], true, true),
        matrixLabelRow("SSD Required", [], true, true),
        matrixLabelRow("RAM Headroom", [], true, true),
        matrixLabelRow("VRAM Headroom", [], true, true),
        matrixLabelRow("Est. Battery Runtime", [], true, true),
        matrixLabelRow("Device Battery Life", [], true, true),
        matrixSectionHeader("Platform", "Ownership & Community", colCount, "platform"),
        matrixLabelRow("Owned Platforms", []),
        matrixLabelRow("Genres", [], true, true),
        matrixLabelRow("Active Mod Count", [], true, true),
        matrixSectionHeader("Price", "Store Deals & Savings", colCount, "price"),
        matrixLabelRow("Unowned Deals (ITAD)", []),
        matrixSectionHeader("Availability", "Friction & Time-to-Play", colCount, "availability"),
        matrixLabelRow("Friction Score", []),
        matrixLabelRow("Friction Factors", [], true, true),
        matrixLabelRow("Friction Badges", [], true, true),
        matrixLabelRow("HLTB Main Story", [], true, true),
        matrixLabelRow("HLTB 100% Completion", [], true, true),
      ].join("");
      body.innerHTML = rows;
      body.querySelectorAll(".add-game-slot-btn").forEach((btn) => {
        btn.addEventListener("click", openCompareDropdown);
      });
      // EPIC-06: the empty matrix has no comparison data, so the Show all
      // control stays hidden (all placeholder rows remain visible).
      applyCompareShowAllState();
    }
  }

  // EPIC-06 (Compare Section Reorganization): reconcile the "Show all" control
  // with the current matrix body. Extra cluster rows (data-compare-extra) are
  // hidden by default and only revealed when the control is toggled. The
  // control stays hidden until a 2-4 game comparison has actually rendered.
  function applyCompareShowAllState() {
    const body = document.getElementById("matrix-body");
    const btn = document.getElementById("compare-show-all");
    if (!body || !btn) return;
    const extraRows = body.querySelectorAll('tr[data-compare-extra="true"]');
    const hasData = Array.isArray(lastComparisonGames) && lastComparisonGames.length >= 2;
    btn.classList.toggle("hidden", !hasData || extraRows.length === 0);
    if (hasData && extraRows.length > 0) {
      extraRows.forEach((row) => {
        row.classList.toggle("hidden", !compareShowAll);
      });
    }
    btn.setAttribute("aria-expanded", String(compareShowAll));
    btn.innerHTML = compareShowAll
      ? '<i data-lucide="chevron-up" class="w-3.5 h-3.5"></i><span>Show fewer attributes</span>'
      : `<i data-lucide="chevron-down" class="w-3.5 h-3.5"></i><span>Show all attributes (${extraRows.length} more)</span>`;
    if (window.lucide) window.lucide.createIcons();
  }

  let compareDevicesCache = [];

  // Reference devices used when the fleet is empty / the API is unreachable so
  // the target-device specs strip always has content (mirrors compare.js).
  const COMPARE_FALLBACK_DEVICES = [
    {
      id: "deck_h",
      deviceName: "Steam Deck (Handheld)",
      cpuModel: "AMD Zen 2 4c/8t",
      gpuModel: "AMD RDNA2 8CU",
      ramGb: 16,
      vramGb: 16,
      formFactor: "handheld",
    },
    {
      id: "custom-pc-5080",
      deviceName: "RTX 5080 Desktop",
      cpuModel: "AMD Ryzen 7",
      gpuModel: "NVIDIA RTX 5080",
      ramGb: 64,
      vramGb: 16,
      formFactor: "desktop",
    },
  ];

  // Heuristic Target FPS label for the target-device specs strip.
  function targetFpsLabelForDevice(d) {
    const vram = Number(d && d.vramGb) || 0;
    const ff = String((d && d.formFactor) || "").toLowerCase();
    const name = String((d && d.deviceName) || "").toLowerCase();
    if (ff === "handheld" || name.includes("deck") || name.includes("ally")) {
      return "30-60 FPS (Tweaks)";
    }
    if (vram >= 8) return "60-144 FPS";
    if (vram > 0) return "30-60 FPS";
    return "Unknown";
  }

  // Render GPU/CPU/RAM/VRAM/Target FPS for the selected target device into the
  // comparison header specs strip (#compare-target-device-specs).
  function renderCompareTargetDeviceSpecs() {
    const container = document.getElementById("compare-target-device-specs");
    const grid = document.getElementById("compare-target-device-specs-grid");
    if (!container || !grid) return;
    const select = document.getElementById("compare-device-select");
    const deviceId = select ? select.value : "";
    const device = compareDevicesCache.find((d) => String(d.id || d.deviceId) === deviceId);
    if (!device) {
      container.classList.add("hidden");
      grid.innerHTML = "";
      return;
    }
    const specs = [
      ["GPU", device.gpuModel || "Unknown GPU"],
      ["CPU", device.cpuModel || "Unknown CPU"],
      ["RAM", device.ramGb != null ? `${device.ramGb} GB` : "Unknown"],
      ["VRAM", device.vramGb != null ? `${device.vramGb} GB` : "Unknown"],
      ["Target FPS", targetFpsLabelForDevice(device)],
    ];
    grid.innerHTML = specs
      .map(
        ([label, value]) => `
          <div class="bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-1.5">
            <p class="text-[9px] font-black uppercase tracking-wider text-slate-500">${label}</p>
            <p class="text-[11px] font-bold text-slate-200 truncate" title="${value}">${value}</p>
          </div>`,
      )
      .join("");
    container.classList.remove("hidden");
  }

  async function populateCompareDeviceSelect() {
    const select = document.getElementById("compare-device-select");
    if (!select) return;

    let devices = [];
    try {
      const res = await apiFetch("/api/devices?status=active");
      const data = await res.json();
      if (data.success && Array.isArray(data.devices)) {
        devices = data.devices;
      }
    } catch (err) {
      console.error("Failed to populate compare device select:", err);
    }

    // Reference fallback devices keep the target-device specs feature usable
    // for guests / empty fleets (mirrors the compare.js fallback set).
    if (devices.length === 0) {
      devices = COMPARE_FALLBACK_DEVICES;
    }
    compareDevicesCache = devices;
    const prevVal = select.value;
    select.innerHTML =
      '<option value="">-- No Device Selected --</option>' +
      devices
        .map(
          (d) => `
          <option value="${d.id || d.deviceId}">${d.deviceName || d.id} (${d.gpuModel || "N/A"})</option>
        `,
        )
        .join("");
    if (prevVal) select.value = prevVal;
    renderCompareTargetDeviceSpecs();
  }

  const compareDeviceSelectEl = document.getElementById("compare-device-select");
  if (compareDeviceSelectEl) {
    compareDeviceSelectEl.addEventListener("change", () => {
      renderCompareTargetDeviceSpecs();
      if (selectedCompareIds.length >= 2 && selectedCompareIds.length <= 4) {
        fetchComparison(selectedCompareIds);
      }
    });
  }

  const btnRunCompare = document.getElementById("btn-run-compare");
  if (btnRunCompare) {
    btnRunCompare.addEventListener("click", () => {
      if (selectedCompareIds.length >= 2 && selectedCompareIds.length <= 4) {
        fetchComparison(selectedCompareIds);
      }
    });
  }

  // WUD-SPRINT9.2-COMPARE-DIFFERENCES-AND-PRESETS: toggle + copy + presets
  const highlightToggle = document.getElementById("highlight-differences-toggle");
  if (highlightToggle) {
    highlightToggle.addEventListener("change", (e) => {
      highlightDifferences = e.target.checked;
      const body = document.getElementById("matrix-body");
      if (body) applyDifferenceHighlights(body);
    });
  }

  const copyMdBtn = document.getElementById("btn-copy-md-summary");
  if (copyMdBtn) {
    copyMdBtn.addEventListener("click", copyMarkdownSummary);
  }

  // EPIC-06 (Compare Section Reorganization): collapsible "Show all" control
  // for the capped 8-attribute default matrix view.
  const compareShowAllBtn = document.getElementById("compare-show-all");
  if (compareShowAllBtn) {
    compareShowAllBtn.addEventListener("click", () => {
      compareShowAll = !compareShowAll;
      applyCompareShowAllState();
    });
  }

  document.querySelectorAll(".compare-preset-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const presetKey = btn.getAttribute("data-preset");
      if (compareCatalogGames.length === 0) {
        await loadCompareCatalog();
      }
      const matchedIds = resolvePresetByIds(presetKey);
      if (matchedIds.length < 2) {
        showToast("Preset could not find 2+ matching games in your library.", true);
        return;
      }
      selectedCompareIds = matchedIds;
      renderCompareDropdownOptions(
        compareSearchInput ? compareSearchInput.value.toLowerCase().trim() : "",
      );
      updateCompareSelectionUI();
      const preset = COMPARE_PRESETS.find((p) => p.key === presetKey);
      if (preset) {
        showToast(
          `${preset.icon} ${preset.label}: added ${matchedIds.length} games to comparison.`,
        );
      }
    });
  });

  async function fetchComparison(ids) {
    const headerRow = document.getElementById("matrix-header-row");
    const body = document.getElementById("matrix-body");
    if (!headerRow || !body) return;

    headerRow.innerHTML = `
      <th class="p-4 w-60 bg-slate-900/80">Specifications</th>
      <th colspan="${ids.length}" class="p-4 text-center text-slate-400">Loading comparison matrix...</th>
    `;

    try {
      const compareDeviceSelect = document.getElementById("compare-device-select");
      const deviceId = compareDeviceSelect ? compareDeviceSelect.value : "";
      let url = `/api/games/compare?ids=${encodeURIComponent(ids.join(","))}`;
      if (deviceId) {
        url += `&deviceId=${encodeURIComponent(deviceId)}`;
      }

      const res = await apiFetch(url);
      const data = await res.json();

      if (!data.success || !data.comparison || data.comparison.length === 0) {
        renderEmptyMatrix();
        return;
      }

      const games = data.comparison;
      const colCount = games.length + 1 + (games.length < 4 ? 1 : 0);

      // Render header cards: cover art, title, developer, remove button
      headerRow.innerHTML = `
        <th class="p-4 w-60 bg-slate-900/80">Specifications</th>
        ${games
          .map(
            (g) => `
          <th class="p-4 text-center align-top border-l border-slate-800 bg-slate-900/40 min-w-[200px]">
            <div class="flex flex-col items-center gap-2">
              <div class="relative w-20 h-28 rounded-xl overflow-hidden bg-slate-950 border border-slate-800 shadow-md">
                ${
                  g.coverUrl || g.coverImage
                    ? `<img src="${g.coverUrl || g.coverImage}" class="w-full h-full object-cover" alt="${g.title}"/>`
                    : `<div class="w-full h-full flex items-center justify-center text-[10px] text-slate-500 p-1">${g.title}</div>`
                }
                <button data-action="remove-game" data-id="${g.gameId}" type="button" aria-label="Remove ${g.title} from comparison" title="Remove ${g.title} from comparison" class="absolute top-1 right-1 w-6 h-6 rounded-full bg-slate-950/80 border border-slate-700 text-slate-400 hover:text-rose-400 hover:border-rose-500/50 flex items-center justify-center text-xs font-bold transition-colors">&times;</button>
              </div>
              <div class="text-white font-extrabold text-xs leading-tight">${g.title}</div>
              <div class="text-[10px] text-slate-400">${g.developer || "Unknown Developer"}</div>
            </div>
          </th>
        `,
          )
          .join("")}
        ${games.length < 4 ? buildAddGameSlotHeader() : ""}
      `;

      headerRow.querySelectorAll(".add-game-slot-btn").forEach((btn) => {
        btn.addEventListener("click", openCompareDropdown);
      });
      headerRow.querySelectorAll('[data-action="remove-game"]').forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = btn.getAttribute("data-id");
          selectedCompareIds = selectedCompareIds.filter((i) => i !== id);
          renderCompareDropdownOptions(
            compareSearchInput ? compareSearchInput.value.toLowerCase().trim() : "",
          );
          updateCompareSelectionUI();
        });
      });

      // Render sectioned matrix rows. EPIC-06 (Compare Section Reorganization):
      // attributes are grouped into four logical clusters (Performance,
      // Platform, Price, Availability) and the default view caps at 8 key rows.
      // Remaining rows carry data-compare-extra and are revealed by the "Show
      // all" control.
      const rows = [
        matrixSectionHeader("Performance", "Requirements & Playability", colCount, "performance"),
        matrixLabelRow(
          "RAM (Min / Rec)",
          games.map(
            (g) =>
              `${g.specs?.minimum?.ramGb || "N/A"} <span class="text-slate-500">/</span> ${g.specs?.recommended?.ramGb || "N/A"}`,
          ),
        ),
        matrixLabelRow(
          "VRAM (Min / Rec)",
          games.map(
            (g) =>
              `${g.specs?.minimum?.vramGb || "N/A"} <span class="text-slate-500">/</span> ${g.specs?.recommended?.vramGb || "N/A"}`,
          ),
        ),
        matrixLabelRow(
          "CPU (Min / Rec)",
          games.map(
            (g) =>
              `${g.specs?.minimum?.cpu || "N/A"}<br/><span class="text-[10px] text-slate-500">${g.specs?.recommended?.cpu || "N/A"}</span>`,
          ),
        ),
        matrixLabelRow(
          "GPU (Min / Rec)",
          games.map(
            (g) =>
              `${g.specs?.minimum?.gpu || "N/A"}<br/><span class="text-[10px] text-slate-500">${g.specs?.recommended?.gpu || "N/A"}</span>`,
          ),
        ),
        matrixLabelRow(
          "Target FPS & Playability",
          games.map((g) => g.playabilityBadge || '<span class="text-slate-500">N/A</span>'),
        ),
        matrixLabelRow(
          "Storage Size",
          games.map((g) => `${g.specs?.minimum?.storage || g.storageSize || "N/A"}`),
          true,
          true,
        ),
        matrixLabelRow(
          "SSD Required",
          games.map((g) => `${g.specs?.minimum?.ssdRequired || "N/A"}`),
          true,
          true,
        ),
        matrixLabelRow(
          "RAM Headroom",
          games.map(buildHeadroomCell("ramHeadroomGb", "GB")),
          true,
          true,
        ),
        matrixLabelRow(
          "VRAM Headroom",
          games.map(buildHeadroomCell("vramHeadroomGb", "GB")),
          true,
          true,
        ),
        matrixLabelRow(
          "Est. Battery Runtime",
          games.map(
            (g) =>
              `${g.estimatedBatteryRuntime != null ? `${g.estimatedBatteryRuntime} hrs` : "N/A"}`,
          ),
          true,
          true,
        ),
        matrixLabelRow(
          "Device Battery Life",
          games.map((g) => g.deviceBatteryRuntimeText || "N/A"),
          true,
          true,
        ),

        matrixSectionHeader("Platform", "Ownership & Community", colCount, "platform"),
        matrixLabelRow("Owned Platforms", games.map(buildPlatformOwnershipCell)),
        matrixLabelRow(
          "Genres",
          games.map(
            (g) => `${Array.isArray(g.genres) && g.genres.length ? g.genres.join(", ") : "N/A"}`,
          ),
          true,
          true,
        ),
        matrixLabelRow(
          "Active Mod Count",
          games.map((g) => `${g.activeModCount || 0} Mods`),
          true,
          true,
        ),

        matrixSectionHeader("Price", "Store Deals & Savings", colCount, "price"),
        matrixLabelRow("Unowned Deals (ITAD)", games.map(buildDealCell)),

        matrixSectionHeader("Availability", "Friction & Time-to-Play", colCount, "availability"),
        matrixLabelRow("Friction Score", games.map(buildFrictionScoreCell)),
        matrixLabelRow("Friction Factors", games.map(buildFrictionFactorsCell), true, true),
        matrixLabelRow("Friction Badges", games.map(buildFrictionBadgesCell), true, true),
        matrixLabelRow(
          "HLTB Main Story",
          games.map(
            (g) =>
              `${g.hltb?.mainStory != null ? `${g.hltb.mainStory} hrs` : g.mainStoryHours ? `${g.mainStoryHours} hrs` : "N/A"}`,
          ),
          true,
          true,
        ),
        matrixLabelRow(
          "HLTB 100% Completion",
          games.map(
            (g) => `${g.hltb?.completionist != null ? `${g.hltb.completionist} hrs` : "N/A"}`,
          ),
          true,
          true,
        ),
      ].join("");
      body.innerHTML = rows;

      body.querySelectorAll(".add-game-slot-btn").forEach((btn) => {
        btn.addEventListener("click", openCompareDropdown);
      });

      // WUD-SPRINT9.2: cache comparison + re-apply difference highlights
      lastComparisonGames = games;
      if (highlightDifferences) applyDifferenceHighlights(body);
      // EPIC-06: enforce the 8-row default / "Show all" expansion state.
      applyCompareShowAllState();

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Error fetching comparison matrix:", err);
      lastComparisonGames = null;
      renderEmptyMatrix();
    }
  }

  // Toast Helper
  function showToast(message, isError = false) {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.className = "fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `px-4 py-3 rounded-xl shadow-2xl text-xs font-bold transition-all duration-300 transform translate-y-2 opacity-0 pointer-events-auto flex items-center gap-2 ${
      isError
        ? "bg-red-900/90 border border-red-500/50 text-red-200"
        : "bg-emerald-900/90 border border-emerald-500/50 text-emerald-200"
    }`;
    // Sprint 6.1 (GAP-002): universal error sanitization — strip stack traces,
    // internal paths and secrets via safeToastError, then HTML-escape so error
    // payloads can never inject markup into the toast container.
    const rawMsg = message == null ? "" : String(message);
    const safeMsg =
      isError && typeof window.safeToastError === "function"
        ? window.safeToastError(rawMsg)
        : rawMsg;
    const escMsg = String(safeMsg)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    toast.innerHTML = `
      <span>${isError ? "⚠️" : "🚀"}</span>
      <span>${escMsg}</span>
    `;

    container.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.remove("translate-y-2", "opacity-0");
    });

    setTimeout(() => {
      toast.classList.add("opacity-0", "translate-y-2");
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // Sprint 4 (EPIC-DEAL-001): expose the toast helper globally so the
  // self-contained wishlist/drawer modules can surface wishlist status feedback
  // through the shared notification channel.
  window.showToast = showToast;

  // Active store tab state
  let currentStoreTab = "sales";

  // 4. Fetch Deals & Wishlist Items
  async function fetchDeals(store = "sales") {
    currentStoreTab = normalizeDealsTab(store);
    const container = dealsContainerFor(currentStoreTab);
    if (!container) return;

    // Show the active panel and hide the other three 4-tab panels.
    document.querySelectorAll(".deals-tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== "deals-panel-" + currentStoreTab);
    });

    // Update active tab button styles + aria-selected.
    const tabBtns = document.querySelectorAll(".deals-tab-btn");
    tabBtns.forEach((btn) => {
      const active = normalizeDealsTab(btn.getAttribute("data-store")) === currentStoreTab;
      btn.className = active
        ? "deals-tab-btn active px-3 py-1.5 rounded-lg bg-pink-600 text-white transition-all whitespace-nowrap flex items-center gap-1.5"
        : "deals-tab-btn px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-all whitespace-nowrap flex items-center gap-1.5";
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    // Extract filters from Deals Hub control bar
    const titleVal = document.getElementById("deals-search-title")?.value?.trim() || "";
    const storeVal = document.getElementById("deals-store-select")?.value || "all";
    const priceMin = document.getElementById("deals-price-min")?.value || "";
    const priceMax = document.getElementById("deals-price-max")?.value || "";
    const discountMin = document.getElementById("deals-discount-min")?.value || "";

    container.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-20 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-pink-500 mb-2"></div>
        <p class="text-xs font-medium">Fetching ${currentStoreTab === "wishlist" ? "wishlist deals" : currentStoreTab === "radar" ? "upcoming releases" : "store offers"}...</p>
      </div>
    `;

    try {
      let dealList = [];
      let queryParams = new URLSearchParams();

      if (titleVal) queryParams.set("title", titleVal);
      if (storeVal && storeVal !== "all") queryParams.set("storeID", storeVal);
      if (priceMin) queryParams.set("lowerPrice", priceMin);
      if (priceMax) queryParams.set("upperPrice", priceMax);

      let url = `/api/deals/search?${queryParams.toString()}`;
      if (currentStoreTab === "wishlist") {
        url = "/api/deals/wishlist-drops";
      } else if (currentStoreTab === "giveaways") {
        url = "/api/deals/by-store?store=giveaways";
      } else if (currentStoreTab === "radar") {
        url = "/api/deals/radar";
      } else if (currentStoreTab === "arbitrage") {
        url = "/api/deals/arbitrage";
      }

      const res = await apiFetch(url);
      const data = await res.json();

      // Sprint 2/3 (EPIC-DEAL-001): Release Radar grid (chronological, countdowns).
      if (currentStoreTab === "radar") {
        const releases = Array.isArray(data.releases) ? data.releases : [];
        const dealsApi = window.__deals || {};
        if (!releases.length) {
          container.innerHTML = `<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">No upcoming releases found.</div>`;
          return;
        }
        const radarCards = (
          dealsApi.buildRadarCard ? releases.map((r) => dealsApi.buildRadarCard(r)) : []
        ).join("");
        container.innerHTML = radarCards;
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      // Sprint 2/3 (EPIC-DEAL-001): Wishlist Drops panel with savings deltas
      // and DLC sales folded underneath the discounted wishlist games.
      if (currentStoreTab === "wishlist") {
        const drops = Array.isArray(data.drops) ? data.drops : [];
        const dealsApi = window.__deals || {};
        let dlcSales = [];
        try {
          const dlcRes = await apiFetch("/api/deals/dlc-sales");
          if (dlcRes.ok) {
            const dlcData = await dlcRes.json();
            dlcSales = Array.isArray(dlcData.dlcSales) ? dlcData.dlcSales : [];
          }
        } catch (e) {
          /* DLC optional */
        }
        if (!drops.length && !dlcSales.length) {
          container.innerHTML = `<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">No discounted wishlist items right now.</div>`;
          return;
        }
        const dropCards = (
          dealsApi.buildWishlistDropCard ? drops.map((d) => dealsApi.buildWishlistDropCard(d)) : []
        ).join("");
        const dlcCards = dlcSales.length
          ? '<div class="col-span-full"><div class="flex items-center gap-2 mb-2 mt-4"><i data-lucide="layers" class="w-4 h-4 text-indigo-400"></i><h4 class="text-xs font-bold text-indigo-300 uppercase tracking-wider">DLC Sales</h4></div><div class="grid grid-cols-1 md:grid-cols-2 gap-3">' +
            (dealsApi.buildDlcSaleCard
              ? dlcSales.map((d) => dealsApi.buildDlcSaleCard(d)).join("")
              : "") +
            "</div></div>"
          : "";
        container.innerHTML = dropCards + dlcCards;
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      // Sprint 2 (WUD-2.2 / EPIC-02): Price Arbitrage panel. Renders active
      // deal cards with 24-month pure-SVG price-trend sparklines, 30-day low
      // and verified "Lowest Price Ever" badges.
      if (currentStoreTab === "arbitrage") {
        const arbCards = Array.isArray(data.deals) ? data.deals : [];
        const dealsApi = window.__deals || {};
        if (!arbCards.length) {
          container.innerHTML =
            '<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">No arbitrage deals found yet.</div>';
          return;
        }
        const arbHtml = (
          dealsApi.buildArbitrageCard ? arbCards.map((d) => dealsApi.buildArbitrageCard(d)) : []
        ).join("");
        container.innerHTML = arbHtml;

        // Mount 24-month inline SVG sparklines via createElementNS (no markup
        // injection) into each card's history slot.
        if (dealsApi.buildPriceHistorySparklineEl) {
          container.querySelectorAll("[data-arb-history-slot]").forEach((slot) => {
            const gameKey = slot.getAttribute("data-game-key");
            const deal = arbCards.find((c) => c.gameKey === gameKey);
            if (deal && Array.isArray(deal.history) && deal.history.length) {
              const el = dealsApi.buildPriceHistorySparklineEl(deal.history, {
                width: 120,
                height: 32,
                strokeColor: "#f472b6",
              });
              slot.replaceWith(el);
            } else {
              slot.remove();
            }
          });
        }

        if (window.lucide) window.lucide.createIcons();
        return;
      }

      if (currentStoreTab === "wishlist") {
        dealList = data.wishlistDeals || [];
      } else {
        dealList = data.deals || [];
      }

      // Client side filter min discount if supplied
      if (discountMin && Array.isArray(dealList)) {
        const minCut = parseFloat(discountMin);
        if (!isNaN(minCut)) {
          dealList = dealList.filter(
            (d) => (parseFloat(d.savings || d.discountPercent) || 0) >= minCut,
          );
        }
      }

      if (!Array.isArray(dealList) || dealList.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">No active deals found for this filter.</div>`;
        return;
      }

      // EPIC-UX-REFINE-0002: Active Freebies shelf renders rich horizontal
      // media cards — thumbnail w/ placeholder, store badge, description,
      // value vs FREE badge, expiry countdown, and a direct claim link.
      // No personal user data is ever required — privacy-minimized by construction.
      if (currentStoreTab === "giveaways") {
        const dealsApi = window.__deals || {};
        const escAttr = (v) =>
          String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const countdownFor =
          dealsApi.countdownFor ||
          ((endDate) => {
            if (!endDate)
              return '<span class="text-[10px] text-slate-500 font-semibold">No expiry listed</span>';
            const endTime = new Date(String(endDate).replace(" ", "T")).getTime();
            const now = Date.now();
            if (Number.isNaN(endTime) || endTime <= now) {
              return '<span class="text-[10px] text-amber-400 font-bold">Ending soon</span>';
            }
            const diffMs = endTime - now;
            const days = Math.floor(diffMs / 86400000);
            const hours = Math.floor((diffMs % 86400000) / 3600000);
            if (days > 0)
              return `<span class="text-[10px] text-emerald-400 font-bold" data-countdown-days="${days}">Expires in ${days}d ${hours}h</span>`;
            const mins = Math.floor((diffMs % 3600000) / 60000);
            return `<span class="text-[10px] text-amber-400 font-bold" data-countdown-hours="${hours}">Expires in ${hours}h ${mins}m</span>`;
          });

        const freebieCards = dealList.slice(0, 16).map((d) => {
          const title = d.title || d.gameTitle || "Free Giveaway";
          const rawPlatforms = String(d.store || d.platforms || "PC");
          const platformChips = rawPlatforms
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
            .slice(0, 4)
            .map(
              (p) =>
                `<span class="freebie-platform inline-block px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[10px] font-bold border border-slate-700">${escAttr(p)}</span>`,
            )
            .join(" ");
          const storeBadgeLabel =
            (dealsApi.storeBadgeFor ? dealsApi.storeBadgeFor(rawPlatforms) : platformChips) ||
            '<span class="text-[10px] text-slate-500">PC</span>';
          // EPIC-UX-LIBRARY-0001 regression guard: expose the per-platform
          // ownership chips on the freebie card (the .freebie-platform row) so
          // the E2E contract that asserts each giveaway surfaces its platform
          // badges stays green alongside the summary store badge.
          const platformChipsRow = platformChips
            ? `<div class="flex flex-wrap items-center gap-1.5 pt-1">${platformChips}</div>`
            : "";
          const worthBadge =
            d.worth && d.worth !== "N/A"
              ? `<span class="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 text-[10px] font-bold border border-amber-500/30">Worth ${escAttr(d.worth)}</span>`
              : "";
          const typeBadge = d.giveawayType
            ? `<span class="px-2 py-0.5 rounded-md bg-brand-500/10 text-brand-300 text-[10px] font-bold border border-brand-500/30">${escAttr(d.giveawayType)}</span>`
            : "";
          const description = escAttr(
            (d.description || "").slice(0, 90) ||
              "Free limited-time giveaway — claim it before it expires.",
          );
          const attributionHtml = dealsApi.attributionLink
            ? dealsApi.attributionLink(rawPlatforms, d.storeUrl, null)
            : "";

          return `
            <div class="freebie-card bg-slate-950/80 border border-emerald-500/20 hover:border-emerald-500/50 rounded-2xl p-4 flex flex-col sm:flex-row gap-3 transition-all shadow-md" data-freebie>
              ${dealsApi.coverArtHtml ? dealsApi.coverArtHtml(d.boxart, title, "w-16 h-20 rounded-xl flex-shrink-0") : ""}
              <div class="flex-1 min-w-0 space-y-2">
                <div class="flex flex-wrap items-center gap-1">
                  ${typeBadge}
                  ${storeBadgeLabel}
                  ${attributionHtml}
                  ${worthBadge}
                  <span class="px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-black" data-freebie-free-badge>FREE</span>
                </div>
                <h4 class="font-bold text-white text-sm leading-snug line-clamp-2 group-hover:text-emerald-400 transition-colors" data-freebie-title>${escAttr(title)}</h4>
                <p class="text-[11px] text-slate-400 leading-relaxed line-clamp-2" data-freebie-desc>${description}</p>
                ${platformChipsRow}
                <div class="flex items-center gap-1.5 pt-1">
                  <i data-lucide="timer" class="w-3.5 h-3.5 text-emerald-400"></i>
                  ${countdownFor(d.endDate)}
                </div>
              </div>
              <div class="pt-2 sm:pt-0 sm:border-t-0 border-t border-slate-800/60 space-y-2 sm:w-36 sm:flex sm:flex-col sm:justify-center">
                <a href="${escAttr(d.storeUrl || "#")}" target="_blank" rel="noopener noreferrer" class="freebie-claim-btn w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-md shadow-emerald-600/20 flex items-center justify-center gap-1.5" title="Claim this free giveaway">
                  <i data-lucide="gift" class="w-3.5 h-3.5"></i>
                  <span>Claim Now →</span>
                </a>
                ${affiliateDisclosureHtml()}
              </div>
            </div>
          `;
        });

        container.innerHTML = freebieCards.join("");
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      // Fetch historical low values for CheapShark deal IDs if available
      const sparklineSeries = [];
      const dealCardsHtmlArray = await Promise.all(
        dealList.slice(0, 16).map(async (d) => {
          const discountPct =
            d.discountCut != null
              ? d.discountCut
              : d.savings
                ? Math.round(parseFloat(d.savings))
                : d.discountPercent || 0;
          const currentPriceNum = parseFloat(
            d.currentPrice != null ? d.currentPrice : d.salePrice || d.price || 0,
          );
          const currentPriceStr = currentPriceNum > 0 ? `$${currentPriceNum.toFixed(2)}` : "FREE";
          const regularPriceNum = parseFloat(
            d.regularPrice != null ? d.regularPrice : d.normalPrice || 0,
          );
          const regularPriceStr = regularPriceNum > 0 ? `$${regularPriceNum.toFixed(2)}` : "";
          const gameTitle = d.title || d.gameTitle || "Untitled Deal";
          const storeName = d.store || d.storeName || "Store";

          // Fetch historical low
          let isAllTimeLow = false;
          try {
            const lowRes = await fetch(
              `/api/deals/historical-low?id=${d.gameID || d.dealID || encodeURIComponent(gameTitle)}`,
            );
            if (lowRes.ok) {
              const lowData = await lowRes.json();
              if (lowData && lowData.historicalLow != null) {
                const lowNum = parseFloat(lowData.historicalLow);
                if (currentPriceNum <= lowNum && currentPriceNum > 0) {
                  isAllTimeLow = true;
                }
              }
            }
          } catch (err) {
            // ignore
          }

          // Fetch history for sparkline + EU Omnibus 30-day lowest baseline
          let sparklinePoints = [];
          let lowestPrice30d = null;
          let msrp = null;
          let historyAvailability = "missing";
          try {
            const histRes = await fetch(
              `/api/deals/history/${d.gameID || d.dealID || encodeURIComponent(gameTitle)}`,
            );
            if (histRes.ok) {
              const histData = await histRes.json();
              const histPoints =
                histData && Array.isArray(histData.points)
                  ? histData.points
                  : histData && Array.isArray(histData.history)
                    ? histData.history
                    : [];
              historyAvailability =
                histData && histData.availability
                  ? histData.availability
                  : histPoints.length
                    ? "real"
                    : "missing";
              if (histData && histData.lowestPrice30d != null) {
                lowestPrice30d = parseFloat(histData.lowestPrice30d);
              } else if (histPoints.length > 0) {
                // Client-side fallback: min price over the trailing 30 days.
                const now = new Date();
                const windowStart = new Date(now);
                windowStart.setDate(windowStart.getDate() - 30);
                const recent = histPoints.filter((p) => {
                  if (!p.date) return false;
                  const d = new Date(String(p.date).replace(" ", "T"));
                  return !isNaN(d.getTime()) && d >= windowStart && d <= now;
                });
                const prices = (recent.length ? recent : histPoints)
                  .map((p) => parseFloat(p.price || p.salePrice || 0))
                  .filter((n) => !isNaN(n) && n > 0);
                if (prices.length) lowestPrice30d = Math.min.apply(null, prices);
              }
              if (histData && histData.msrp != null) {
                msrp = parseFloat(histData.msrp);
              }
              if (histPoints.length > 0) {
                sparklinePoints = histPoints.map((p) => parseFloat(p.price || p.salePrice || 0));
              }
            }
          } catch (err) {
            // ignore
          }

          if (!sparklinePoints.length) {
            sparklinePoints = [currentPriceNum || 10, currentPriceNum || 10];
          }
          sparklineSeries.push(sparklinePoints);

          const dealsApi = window.__deals || {};
          const escAttr = (v) =>
            String(v == null ? "" : v)
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
          // EPIC-UX-REFINE-0002: backend enrichDealMeta supplies genre pills,
          // review scores, and cover art for Store Sales cards.
          const genreBadges =
            Array.isArray(d.genres) && d.genres.length
              ? d.genres
                  .slice(0, 2)
                  .map(
                    (gr) =>
                      `<span class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${escAttr(gr)}</span>`,
                  )
                  .join("")
              : "";
          const reviewScore = d.compositeScore ?? d.steamScore ?? d.openCriticScore ?? null;
          const scoreBadge =
            reviewScore != null
              ? `<span class="px-1.5 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold whitespace-nowrap" data-deal-score>★ ${reviewScore}</span>`
              : '<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-bold whitespace-nowrap" data-deal-score>Score —</span>';
          const isBestStore = d.isBestStore || isAllTimeLow;
          const safeDealUrl =
            window.__deals && window.__deals.sanitizeStoreUrl
              ? window.__deals.sanitizeStoreUrl(d.storeUrl || d.dealUrl || d.url)
              : null;

          return `
          <div class="deal-card bg-slate-950/80 border border-slate-800/80 rounded-2xl p-4 flex flex-col justify-between hover:border-pink-500/40 transition-all shadow-md group" data-deal-card>
            ${dealsApi.coverArtHtml ? dealsApi.coverArtHtml(d.boxart || d.coverUrl, gameTitle, "w-14 h-16 rounded-lg flex-shrink-0") : ""}
            <div class="flex-1 min-w-0 space-y-2 mt-3">
              <div class="flex flex-wrap items-center justify-between gap-1">
                <span class="px-2 py-0.5 rounded-lg bg-pink-500/10 text-pink-400 border border-pink-500/20 text-[10px] font-bold uppercase tracking-wider" data-deal-store>
                  ${escAttr(storeName)}
                </span>
                <div class="flex items-center gap-1">
                  ${isBestStore ? `<span class="badge-arbitrage">Best Price</span>` : ""}
                  ${isAllTimeLow ? `<span class="badge-historical-low">★ Historic Low</span>` : ""}
                  ${discountPct > 0 ? `<span class="px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold" data-deal-discount>-${discountPct}% OFF</span>` : ""}
                  ${lowestPrice30d != null && lowestPrice30d > 0 ? `<span class="px-2 py-0.5 rounded-lg bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold" data-30d-low title="Lowest verified price in the last 30 days">Lowest in 30 days: $${lowestPrice30d.toFixed(2)}</span>` : `<span class="px-2 py-0.5 rounded-lg bg-slate-800/80 text-slate-500 border border-slate-700 text-[10px] font-bold" data-history-unavailable title="No verified observed price history is available">No verified 30-day low (${escAttr(historyAvailability)})</span>`}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-1">
                ${genreBadges}
                ${scoreBadge}
              </div>
              <h4 class="font-bold text-white text-sm line-clamp-1 group-hover:text-pink-400 transition-colors" data-deal-title>${escAttr(gameTitle)}</h4>
              <div class="mt-2 flex items-center justify-between text-[10px] text-slate-400 bg-slate-900/60 p-1.5 rounded-lg border border-slate-800"><span>Price Trend</span><span data-sparkline-slot></span></div>
            </div>

            <div class="pt-4 mt-4 border-t border-slate-800/60 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <div class="deal-price">
                  <span class="text-lg font-black text-emerald-400">${escAttr(currentPriceStr)}</span>
                  ${regularPriceStr && regularPriceStr !== currentPriceStr ? `<span class="text-xs text-slate-500 line-through ml-1.5">${escAttr(regularPriceStr)}</span>` : ""}
                  ${msrp != null && msrp > 0 && regularPriceStr !== `$${msrp.toFixed(2)}` ? `<span class="text-[10px] text-slate-600 ml-1">MSRP $${msrp.toFixed(2)}</span>` : ""}
                </div>
                <button data-app-id="${d.gameID || d.dealID || d.title}" data-title="${gameTitle}" class="deal-alert-btn px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] font-semibold border border-slate-700 transition-all flex items-center gap-1" title="Set Price Threshold Alert">
                  <i data-lucide="bell" class="w-3 h-3 text-amber-400"></i>
                  <span>Watch</span>
                </button>
              </div>

              <div class="space-y-1.5">
                <a href="${safeDealUrl || "#"}" target="_blank" rel="noopener noreferrer" class="w-full py-1.5 rounded-xl bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold transition-all shadow-md shadow-pink-600/20 flex items-center justify-center gap-1" data-deal-view>
                  <span>View Deal</span>
                  <i data-lucide="external-link" class="w-3 h-3"></i>
                </a>
                ${affiliateDisclosureHtml()}
              </div>
            </div>
          </div>
        `;
        }),
      );

      // Off-DOM rendering assemble string before insertion
      container.innerHTML = dealCardsHtmlArray.join("");

      // Sprint 3 (EPIC-DEAL-001): mount safe DOM sparklines (createElementNS)
      // into each price-trend slot so no SVG script/handler markup is injected.
      if (window.__deals && window.__deals.buildPriceSparklineEl) {
        const slots = container.querySelectorAll("[data-sparkline-slot]");
        slots.forEach((slot, idx) => {
          const series = sparklineSeries[idx];
          if (Array.isArray(series)) {
            const el = window.__deals.buildPriceSparklineEl(series, {
              width: 80,
              height: 24,
              strokeColor: "#38bdf8",
            });
            slot.replaceWith(el);
          }
        });
      }

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Error fetching deals:", err);
      container.innerHTML =
        '<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">Unable to load deals right now.</div>';
    }
  }

  // Setup deals controls & handlers
  const dealsSearchBtn = document.getElementById("deals-search-btn");
  if (dealsSearchBtn) {
    dealsSearchBtn.addEventListener("click", () => fetchDeals(currentStoreTab));
  }

  // Sprint 1 (EPIC-RADAR-0001): the Deals Hub sub-tabs (Store Sales, Active
  // Giveaways, Release Radar, Wishlist Drops) drive fetchDeals(store). Wire
  // them with event delegation so the existing HTML buttons become live.
  const dealsStoreTabs = document.getElementById("deals-store-tabs");
  if (dealsStoreTabs) {
    dealsStoreTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".deals-tab-btn");
      if (!btn) return;
      const store = btn.getAttribute("data-store");
      if (store && store !== currentStoreTab) {
        fetchDeals(store);
      }
    });
  }

  const historicLowsPill = document.getElementById("deals-historic-lows-pill");
  if (historicLowsPill) {
    historicLowsPill.addEventListener("click", () => {
      historicLowsPill.classList.toggle("active");
      if (historicLowsPill.classList.contains("active")) {
        historicLowsPill.className =
          "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border transition-all bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm active";
      } else {
        historicLowsPill.className =
          "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border transition-all bg-slate-900 text-slate-400 border-slate-800 hover:text-white hover:border-slate-700";
      }
      fetchDeals(currentStoreTab);
    });
  }

  const wishlistSyncBtn = document.getElementById("deals-wishlist-sync-btn");
  if (wishlistSyncBtn) {
    wishlistSyncBtn.addEventListener("click", async () => {
      try {
        wishlistSyncBtn.disabled = true;
        wishlistSyncBtn.innerHTML = `<div class="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white"></div><span>Syncing...</span>`;
        const res = await fetch("/api/deals/wishlist/sync", { method: "POST" });
        const data = await res.json();
        alert(`Wishlist Sync Complete! Synced ${data.syncedCount || 0} games.`);
        fetchDeals("wishlist");
      } catch (e) {
        console.error("Wishlist sync failed:", e);
        alert("Failed to sync wishlist games.");
      } finally {
        wishlistSyncBtn.disabled = false;
        wishlistSyncBtn.innerHTML = `<i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i><span>Sync Wishlist Games</span>`;
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  // Event delegation for price alert trigger watch buttons. Delegated on the
  // stable Deals Hub section so it remains live across 4-tab panel re-renders.
  const dealsHubSection = document.getElementById("page-deals");
  if (dealsHubSection) {
    dealsHubSection.addEventListener("click", async (e) => {
      const alertBtn = e.target.closest(".deal-alert-btn");
      if (alertBtn) {
        const appId = alertBtn.getAttribute("data-app-id");
        const title = alertBtn.getAttribute("data-title");
        const thresholdStr = prompt(`Set price alert threshold ($) for "${title}":`, "19.99");
        if (thresholdStr !== null) {
          const threshold = parseFloat(thresholdStr);
          if (isNaN(threshold) || threshold < 0) {
            alert("Please enter a valid target price number.");
            return;
          }
          try {
            const res = await fetch("/api/deals/alerts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ gameId: appId, title: title, targetPrice: threshold }),
            });
            const result = await res.json();
            if (res.ok) {
              alert(
                `Price alert saved! Alert triggered: ${result.triggered ? "YES (Current price is below threshold)" : "No (Watching for price drops)"}`,
              );
            } else {
              alert(result.error || "Failed to set alert.");
            }
          } catch (err) {
            console.error("Set alert failed:", err);
            alert("Error setting price alert.");
          }
        }
      }
    });
  }

  // Sprint 2 (EPIC-DEAL-001): Active Alerts Manager actions — inline target
  // price updates (PUT/POST via /api/alerts) and deletion, with instant toast
  // confirmation. The alerts manager UI lives in the Wishlist page now, so this
  // delegation is attached to the Deals Hub section defensively (no panel).
  if (dealsHubSection) {
    dealsHubSection.addEventListener("click", async (e) => {
      const saveBtn = e.target.closest("[data-alert-save]");
      const deleteBtn = e.target.closest("[data-alert-delete]");
      if (!saveBtn && !deleteBtn) return;

      const row = (saveBtn || deleteBtn).closest("[data-alert-row]");
      if (!row) return;
      const gameId = row.getAttribute("data-game-id");
      const titleEl = row.querySelector("[data-alert-title]");
      const title = titleEl ? titleEl.textContent.trim() : gameId;

      if (saveBtn) {
        const targetInput = row.querySelector("[data-alert-target]");
        const targetPrice = parseFloat(targetInput ? targetInput.value : "");
        if (isNaN(targetPrice) || targetPrice < 0) {
          showToast("Please enter a valid target price.", true);
          return;
        }
        try {
          const res = await fetch("/api/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId, title, targetPrice }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Price alert updated for ${title}`);
          } else {
            showToast(data.error || "Failed to update alert", true);
          }
        } catch (err) {
          console.error("Alert update failed:", err);
          showToast("Error updating price alert", true);
        }
      } else if (deleteBtn) {
        try {
          const res = await fetch(`/api/alerts/${encodeURIComponent(gameId)}`, {
            method: "DELETE",
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Price alert removed for ${title}`);
          } else {
            showToast(data.error || "Failed to delete alert", true);
          }
        } catch (err) {
          console.error("Alert delete failed:", err);
          showToast("Error deleting price alert", true);
        }
      }
    });
  }

  // =========================================================================
  // Game Details Page Hydration (WUD-SPRINT8.1-GAME-DETAIL-PAGE-ROUTING)
  // =========================================================================
  async function fetchAndHydrateGameDetail(gameId) {
    const loadingEl = document.getElementById("game-detail-loading");
    const contentEl = document.getElementById("game-detail-content");
    const errorEl = document.getElementById("game-detail-error");
    const errorMsgEl = document.getElementById("game-detail-error-msg");

    if (!contentEl) return;

    if (loadingEl) loadingEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    if (errorEl) errorEl.classList.add("hidden");

    try {
      const res = await apiFetch(`/api/games/${encodeURIComponent(gameId)}`);
      const data = await res.json();

      if (!res.ok || !data) {
        if (loadingEl) loadingEl.classList.add("hidden");
        if (errorEl) {
          errorEl.classList.remove("hidden");
          if (errorMsgEl)
            errorMsgEl.textContent = `Unable to retrieve game record for ID: ${gameId}`;
        }
        return;
      }

      const g = data && data.game ? data.game : data || {};
      const title = g.title || "Unknown Title";
      const developer = g.developer || "Unknown Developer";
      const publisher = g.publisher || "Unknown Publisher";
      const genre = g.primaryGenre || g.genre || "Uncategorized";
      const coverUrl = g.cover_url || g.coverUrl || g.headerImage || "";

      // Set Header Banner Info
      const titleEl = document.getElementById("detail-title");
      if (titleEl) titleEl.textContent = title;

      const devEl = document.getElementById("detail-developer");
      if (devEl) devEl.textContent = `Developer: ${developer} | Publisher: ${publisher}`;

      const coverImg = document.getElementById("detail-cover-img");
      const coverFallback = document.getElementById("detail-cover-fallback");
      if (coverImg && coverFallback) {
        if (coverUrl) {
          coverImg.src = coverUrl;
          coverImg.alt = title;
          coverImg.classList.remove("hidden");
          coverFallback.classList.add("hidden");
          coverImg.onerror = () => {
            coverImg.classList.add("hidden");
            coverFallback.classList.remove("hidden");
          };
        } else {
          coverImg.classList.add("hidden");
          coverFallback.classList.remove("hidden");
        }
      }

      // Genre Badges
      const genreContainer = document.getElementById("detail-genres-badges");
      if (genreContainer) {
        const genresList = Array.isArray(g.genres) && g.genres.length > 0 ? g.genres : [genre];
        genreContainer.innerHTML = genresList
          .map(
            (gr) => `
          <span class="px-2.5 py-1 rounded-full bg-brand-500/10 text-brand-400 text-xs font-bold border border-brand-500/20 uppercase tracking-wider">${gr}</span>
        `,
          )
          .join("");
      }

      // Store Links & Meta Pills
      const metaContainer = document.getElementById("detail-meta-pills");
      if (metaContainer) {
        const sanitizeStoreUrl =
          window.__deals && typeof window.__deals.sanitizeStoreUrl === "function"
            ? window.__deals.sanitizeStoreUrl
            : (u) => u;
        const storeUrls = g.platformStoreUrls || {};
        const steamUrl = sanitizeStoreUrl(storeUrls.steam || g.storeUrl || null);
        const psnUrl = sanitizeStoreUrl(storeUrls.psn || storeUrls.playstation || null);
        const gogUrl = sanitizeStoreUrl(storeUrls.gog || null);
        const officialSite = g.officialWebsiteUrl || null;

        const storePills = `
          ${steamUrl ? `<a href="${steamUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-xl bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white font-bold transition-all flex items-center gap-1.5 border border-blue-500/30"><i data-lucide="external-link" class="w-3.5 h-3.5"></i> Steam</a>` : ""}
          ${psnUrl ? `<a href="${psnUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-xl bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600 hover:text-white font-bold transition-all flex items-center gap-1.5 border border-indigo-500/30"><i data-lucide="external-link" class="w-3.5 h-3.5"></i> PSN</a>` : ""}
          ${gogUrl ? `<a href="${gogUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-xl bg-purple-600/20 text-purple-400 hover:bg-purple-600 hover:text-white font-bold transition-all flex items-center gap-1.5 border border-purple-500/30"><i data-lucide="external-link" class="w-3.5 h-3.5"></i> GOG</a>` : ""}
          ${officialSite ? `<a href="${officialSite}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white font-bold transition-all flex items-center gap-1.5 border border-slate-700"><i data-lucide="globe" class="w-3.5 h-3.5"></i> Website</a>` : ""}
        `;
        metaContainer.innerHTML = `
          <div class="flex flex-wrap items-center gap-2">${storePills}</div>
          ${steamUrl || psnUrl || gogUrl ? affiliateDisclosureHtml() : ""}
        `;
      }

      // Sprint 4 (EPIC-DEAL-001): render a stateful Add/Remove Wishlist toggle
      // on the full game detail page, driven by the authoritative AppWishlist
      // status for the current gameId.
      const wishlistActionSlot = document.getElementById("game-detail-wishlist-action");
      if (wishlistActionSlot) {
        const renderWishlistAction = (inWishlist) => {
          wishlistActionSlot.innerHTML = inWishlist
            ? `<button type="button" data-game-detail-wishlist="remove" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-900/50 hover:bg-rose-800 text-rose-200 border border-rose-500/30 text-xs font-bold transition-all shadow-md active:scale-95">
                <i data-lucide="trash-2" class="w-4 h-4"></i> Remove from Wishlist
              </button>`
            : `<button type="button" data-game-detail-wishlist="add" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-md shadow-indigo-600/20 active:scale-95">
                <i data-lucide="star" class="w-4 h-4"></i> Add to Wishlist
              </button>`;
          if (window.lucide) window.lucide.createIcons();
        };

        const getWishlistStatus =
          window.__wishlist && typeof window.__wishlist.getStatus === "function"
            ? window.__wishlist.getStatus.bind(window.__wishlist)
            : () => Promise.resolve({ success: false, inWishlist: false });

        getWishlistStatus(gameId).then((s) => renderWishlistAction(!!(s && s.inWishlist)));

        wishlistActionSlot.onclick = (e) => {
          const btn = e.target.closest("[data-game-detail-wishlist]");
          if (!btn || !window.__wishlist) return;
          const mode = btn.getAttribute("data-game-detail-wishlist");
          if (mode === "remove") {
            window.__wishlist.removeGame(gameId);
            renderWishlistAction(false);
          } else {
            window.__wishlist.addGame(gameId, title, 0).then((d) => {
              if (d && d.success) renderWishlistAction(true);
            });
          }
        };
      }

      // Specs
      const minSpecs = g.specs?.minimum || {};
      const recSpecs = g.specs?.recommended || {};
      const renderSpecValue = (val) =>
        val
          ? `<span class="text-slate-200 font-semibold">${val}</span>`
          : `<span class="px-2 py-0.5 rounded bg-slate-800 text-slate-500 text-[10px] font-bold border border-slate-700/60">Spec Unlisted</span>`;

      // HLTB & Reviews
      const roadmap = (Array.isArray(g.completionRoadmaps) && g.completionRoadmaps[0]) || {};
      const mainStory = roadmap.mainStoryHours || roadmap.mainStoryTime || "N/A";
      const completionist = roadmap.completionistHours || roadmap.estimated100Hours || "N/A";

      const reviews = Array.isArray(g.reviews) ? g.reviews : [];
      const primaryReview = reviews[0] || {};
      const criticScore = g.criticScore || primaryReview.scoreNumeric || "N/A";

      // 1. Overview Panel
      const panelOverview = document.getElementById("tab-panel-overview");
      if (panelOverview) {
        panelOverview.innerHTML = `
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-1">
              <span class="text-slate-500 block font-semibold uppercase tracking-wider text-[10px]">Library Status</span>
              <span class="text-slate-200 font-bold text-sm">${g.active || "Active"}</span>
            </div>
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-1">
              <span class="text-slate-500 block font-semibold uppercase tracking-wider text-[10px]">Storage Required</span>
              <span class="text-slate-200 font-bold text-sm">${g.storageSize || "N/A"}</span>
            </div>
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-1">
              <span class="text-slate-500 block font-semibold uppercase tracking-wider text-[10px]">Nexus Mod Count</span>
              <span class="text-amber-400 font-bold text-sm">${g.nexusModCount ? g.nexusModCount + " Active Mods" : "0 Mods Tracked"}</span>
            </div>
          </div>

          ${
            Array.isArray(g.frictions) && g.frictions.length > 0
              ? `
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-3">
              <span class="text-xs font-bold text-slate-300 block uppercase tracking-wider">System & Gameplay Friction</span>
              <div class="flex flex-wrap gap-2 text-xs">
                ${g.frictions
                  .map(
                    (f) => `
                  <span class="px-3 py-1.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-semibold">
                    ${f.thirdPartyLauncher ? `Launcher Required: ${f.thirdPartyLauncher}` : f.sessionLength ? `Ideal Session: ${f.sessionLength}` : "General Friction"}
                  </span>
                `,
                  )
                  .join("")}
              </div>
            </div>
          `
              : ""
          }
        `;
      }

      // 2. Hardware Specs Panel
      // EPIC-UX-POLISH-0001: when specific CPU/GPU/VRAM fields are unlisted,
      // collapse the empty rows into a clean summary — no long chains of
      // repeated "Spec Unlisted" rows.
      const panelSpecs = document.getElementById("tab-panel-specs");
      if (panelSpecs) {
        const specRow = (label, val) =>
          val
            ? `<p><strong class="text-slate-300">${label}:</strong> ${renderSpecValue(val)}</p>`
            : "";
        const buildSpecPanel = (mode, s) => {
          const fields = [
            ["RAM", s.ramGb],
            ["VRAM", s.vramGb],
            ["CPU", s.cpu],
            ["GPU", s.gpu],
            ["Storage", s.storage],
            ["SSD Required", s.ssdRequired],
          ];
          const known = fields.filter(([, v]) => v);
          const unlistedCount = fields.length - known.length;
          const heading =
            mode === "min"
              ? `<h4 class="font-extrabold text-brand-400 uppercase tracking-wider text-xs border-b border-slate-800 pb-2 flex items-center gap-2"><i data-lucide="cpu" class="w-4 h-4"></i> Minimum Requirements</h4>`
              : `<h4 class="font-extrabold text-emerald-400 uppercase tracking-wider text-xs border-b border-slate-800 pb-2 flex items-center gap-2"><i data-lucide="zap" class="w-4 h-4"></i> Recommended Requirements</h4>`;
          let rows = known.map(([label, val]) => specRow(label, val)).join("");
          if (!known.length) {
            // Full fallback summary line (storage is almost always known).
            rows = `<p class="text-slate-400"><strong class="text-slate-300">Standard System Requirements</strong> — ${s.storage ? "41 GB Storage Required" : "Minimum specs not published by developer"}.</p>`;
          } else if (unlistedCount > 0) {
            rows += `<p class="text-slate-500 italic pt-1">${unlistedCount} spec${unlistedCount > 1 ? "s" : ""} unlisted by developer.</p>`;
          }
          return `<div class="p-5 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-3">${heading}<div class="space-y-2 text-slate-400">${rows}</div></div>`;
        };
        panelSpecs.innerHTML = `<div class="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">${buildSpecPanel("min", minSpecs)}${buildSpecPanel("rec", recSpecs)}</div>`;
      }

      // 3. Reviews & HLTB Panel
      const panelReviews = document.getElementById("tab-panel-reviews");
      if (panelReviews) {
        panelReviews.innerHTML = `
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 text-center space-y-1">
              <span class="text-slate-500 block text-xs font-semibold uppercase tracking-wider">Critic Score</span>
              <span class="text-indigo-400 font-black text-2xl">${criticScore}</span>
            </div>
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 text-center space-y-1">
              <span class="text-slate-500 block text-xs font-semibold uppercase tracking-wider">Main Story (HLTB)</span>
              <span class="text-emerald-400 font-black text-2xl">${mainStory}${typeof mainStory === "number" ? " hrs" : ""}</span>
            </div>
            <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 text-center space-y-1 col-span-2 sm:col-span-1">
              <span class="text-slate-500 block text-xs font-semibold uppercase tracking-wider">Completionist</span>
              <span class="text-amber-400 font-black text-2xl">${completionist}${typeof completionist === "number" ? " hrs" : ""}</span>
            </div>
          </div>

          ${
            reviews.length > 0
              ? `
            <div class="space-y-3 pt-2">
              <h4 class="font-bold text-slate-300 text-xs uppercase tracking-wider">Metacritic & Outlet Reviews</h4>
              ${reviews
                .map(
                  (r) => `
                <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-1.5">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-white text-sm">${r.source || "Review"}</span>
                    ${r.worthGrade ? `<span class="px-2.5 py-0.5 rounded-lg bg-brand-500/20 text-brand-300 font-bold text-xs">${r.worthGrade}</span>` : ""}
                  </div>
                  ${r.summary ? `<p class="text-slate-400 text-xs italic">${r.summary}</p>` : ""}
                </div>
              `,
                )
                .join("")}
            </div>
          `
              : '<div class="p-6 bg-slate-950/60 rounded-2xl border border-slate-800 text-slate-500 text-center text-xs">No detailed reviews listed.</div>'
          }
        `;
      }

      // 4. Platforms & Deals Panel
      const panelPlatforms = document.getElementById("tab-panel-platforms");
      if (panelPlatforms) {
        panelPlatforms.innerHTML = `
          <h4 class="font-bold text-slate-300 text-xs uppercase tracking-wider">Platform Matrix & Live Storefronts</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${
              Array.isArray(g.platforms) && g.platforms.length > 0
                ? g.platforms
                    .map((p) => {
                      if (p.isOwned) {
                        const installStatus = p.isInstalled
                          ? `<span class="px-2.5 py-1 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 text-xs font-bold flex items-center gap-1"><i data-lucide="download" class="w-3.5 h-3.5"></i> Installed</span>`
                          : `<span class="px-2.5 py-1 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700 text-xs font-bold flex items-center gap-1"><i data-lucide="library" class="w-3.5 h-3.5"></i> Library</span>`;
                        return `
                  <div class="p-4 bg-slate-950/70 rounded-2xl border border-emerald-500/30 space-y-2 shadow-md">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-extrabold text-white text-sm flex items-center gap-1.5">
                        <i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-400"></i> ${p.platform || "Platform"}
                      </span>
                      <span class="flex items-center gap-2 flex-wrap justify-end">
                        ${installStatus}
                        <span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold">
                          ${p.ownershipType || "Owned License"}
                        </span>
                      </span>
                    </div>
                    <div class="text-xs text-slate-400 space-y-1">
                      <p><strong class="text-slate-300">Edition:</strong> ${p.edition || "Standard Edition"}</p>
                      <p><strong class="text-slate-300">Purchase Price:</strong> ${p.purchasePrice ? p.purchasePrice : '<span class="text-slate-500 italic">Price Unlisted</span>'}</p>
                      ${p.purchaseDate ? `<p><strong class="text-slate-300">Acquired:</strong> ${p.purchaseDate}</p>` : ""}
                    </div>
                    ${
                      p.storeUrl
                        ? `
                      <div class="pt-2">
                        <a href="${p.storeUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs border border-slate-700 transition-all">
                          <i data-lucide="external-link" class="w-3.5 h-3.5 text-emerald-400"></i> Open Storefront
                        </a>
                      </div>
                    `
                        : ""
                    }
                  </div>
                `;
                      } else if (p.currentPrice || p.storeUrl) {
                        return `
                  <div class="p-4 bg-slate-950/70 rounded-2xl border border-brand-500/30 space-y-2 shadow-md">
                    <div class="flex items-center justify-between">
                      <span class="font-extrabold text-white text-sm flex items-center gap-1.5">
                        <i data-lucide="shopping-bag" class="w-4 h-4 text-brand-400"></i> ${p.platform || "Storefront"}
                      </span>
                      ${p.discountPercent ? `<span class="px-2.5 py-1 rounded-lg bg-brand-500/20 text-brand-300 border border-brand-500/30 text-xs font-bold">-${p.discountPercent} OFF</span>` : ""}
                    </div>
                    <div class="text-xs text-slate-400 space-y-1">
                      <p><strong class="text-slate-300">Current Deal:</strong> <span class="text-emerald-400 font-bold text-sm">${p.currentPrice || "N/A"}</span> ${p.regularPrice ? `<span class="line-through text-slate-500 text-xs ml-1">${p.regularPrice}</span>` : ""}</p>
                    </div>
                    ${
                      p.storeUrl
                        ? `
                      <div class="pt-2">
                        <a href="${p.storeUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs transition-all">
                          <i data-lucide="external-link" class="w-3.5 h-3.5"></i> View Deal on ${p.platform || "Store"}
                        </a>
                      </div>
                    `
                        : ""
                    }
                  </div>
                `;
                      } else {
                        return `
                  <div class="p-4 bg-slate-950/40 rounded-2xl border border-slate-800 space-y-1 text-slate-500">
                    <div class="flex items-center justify-between">
                      <span class="font-bold text-slate-400 text-xs">${p.platform || "Platform"}</span>
                      <span class="px-2 py-0.5 rounded bg-slate-800/80 text-slate-400 text-[10px] font-semibold">Not Owned / Store Unlisted</span>
                    </div>
                  </div>
                `;
                      }
                    })
                    .join("")
                : '<div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 text-slate-500 text-center col-span-2 text-xs">No platform or deal data available.</div>'
            }
          </div>
        `;
      }

      // 5. DLCs & Rewards Panel
      const panelDlcs = document.getElementById("tab-panel-dlcs");
      if (panelDlcs) {
        panelDlcs.innerHTML = `
          <div class="flex items-center justify-between border-b border-slate-800 pb-2">
            <h4 class="font-bold text-slate-300 text-xs uppercase tracking-wider">DLCs, Expansions & Free Drops</h4>
            ${
              g.dlcRewardsMeta
                ? `
              <span class="text-xs text-slate-400 font-medium">
                ${g.dlcRewardsMeta.totalDlcs} Total | <span class="text-emerald-400 font-bold">${g.dlcRewardsMeta.ownedCount} Owned</span>
              </span>
            `
                : ""
            }
          </div>

          ${
            Array.isArray(g.dlcs) && g.dlcs.length > 0
              ? `
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              ${g.dlcs
                .map((d) => {
                  let badge;
                  let borderClass = "border-slate-800/80";

                  if (d.isOwned) {
                    if (d.isIncludedInEdition) {
                      badge = `<span class="px-2.5 py-1 rounded-lg bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold flex items-center gap-1"><i data-lucide="package-check" class="w-3.5 h-3.5 text-sky-400"></i> Included in GOTY</span>`;
                      borderClass = "border-sky-500/30 bg-sky-950/10";
                    } else {
                      badge = `<span class="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold flex items-center gap-1"><i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-400"></i> Owned</span>`;
                      borderClass = "border-emerald-500/30 bg-emerald-950/10";
                    }
                  } else if (d.price || d.discountPercent) {
                    badge = `<span class="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold flex items-center gap-1"><i data-lucide="tag" class="w-3.5 h-3.5 text-amber-400"></i> On Sale ${d.discountPercent ? `(-${d.discountPercent})` : ""}</span>`;
                    borderClass = "border-amber-500/30 bg-amber-950/10";
                  } else {
                    badge = `<span class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-400 text-xs font-semibold">Unowned</span>`;
                  }

                  return `
                  <div class="p-4 bg-slate-950/70 rounded-2xl border ${borderClass} space-y-3 shadow-md flex flex-col justify-between">
                    <div class="space-y-2">
                      <div class="flex items-start justify-between gap-2">
                        <span class="font-extrabold text-white text-xs leading-snug line-clamp-2">${d.name}</span>
                        <div class="flex-shrink-0">${badge}</div>
                      </div>

                      ${
                        d.isFreeReward
                          ? `
                        <div class="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-2 animate-pulse">
                          <i data-lucide="gift" class="w-4 h-4 text-emerald-400"></i>
                          <span>Free Reward / Giveaway Available!</span>
                        </div>
                      `
                          : ""
                      }

                      ${d.notes ? `<p class="text-xs text-slate-400 leading-relaxed">${d.notes}</p>` : ""}
                    </div>

                    <div class="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
                      <div>
                        ${d.price ? `<span class="text-emerald-400 font-extrabold text-xs">${d.price}</span>` : '<span class="text-slate-500 italic">No Deal Price</span>'}
                      </div>
                      ${
                        d.storeUrl
                          ? `
                        <a href="${d.storeUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs border border-slate-700 transition-all">
                          <i data-lucide="external-link" class="w-3.5 h-3.5 text-emerald-400"></i> View Store
                        </a>
                      `
                          : ""
                      }
                    </div>
                  </div>
                `;
                })
                .join("")}
            </div>
          `
              : `
            <div class="p-6 bg-slate-950/40 rounded-2xl border border-slate-800/80 text-center space-y-2">
              <div class="inline-flex p-3 rounded-full bg-slate-800/60 text-slate-400 mb-1">
                <i data-lucide="package-x" class="w-6 h-6"></i>
              </div>
              <h5 class="text-slate-300 font-bold text-xs">No DLCs or Expansions Available</h5>
              <p class="text-xs text-slate-500 max-w-xs mx-auto">This title either has no major DLC packs released or represents a base game build with all content included.</p>
            </div>
          `
          }
        `;
      }

      // 6. Mods Panel
      const panelMods = document.getElementById("tab-panel-mods");
      if (panelMods) {
        const nexusUrl =
          g.nexusUrl || `https://www.nexusmods.com/search/?gsearch=${encodeURIComponent(title)}`;
        const modCount = g.nexusModCount || 0;
        const trackedMods = Array.isArray(g.mods) ? g.mods : [];

        panelMods.innerHTML = `
          <div class="p-6 bg-slate-950/70 rounded-2xl border border-amber-500/30 space-y-4 shadow-xl">
            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div class="flex items-center gap-3">
                <div class="bg-amber-500/10 text-amber-400 p-2.5 rounded-xl border border-amber-500/20">
                  <i data-lucide="puzzle" class="w-6 h-6"></i>
                </div>
                <div>
                  <h4 class="text-base font-bold text-white">Nexus Mods Directory</h4>
                  <p class="text-xs text-slate-400">Explore community modifications and enhancements</p>
                </div>
              </div>
              <a href="${nexusUrl}" target="_blank" rel="noopener noreferrer" class="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shadow-lg shadow-amber-600/20 active:scale-95 transition-all flex items-center gap-2">
                <i data-lucide="external-link" class="w-4 h-4"></i>
                <span>Open Nexus Mods Hub</span>
              </a>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div class="p-4 bg-slate-900 rounded-xl border border-slate-800 space-y-1">
                <span class="text-slate-500 block font-semibold">Tracked Nexus Mods</span>
                <span class="text-amber-400 font-black text-lg">${modCount > 0 ? modCount.toLocaleString() + " Mods" : "Mods Available"}</span>
              </div>
              <div class="p-4 bg-slate-900 rounded-xl border border-slate-800 space-y-1">
                <span class="text-slate-500 block font-semibold">Modding Compatibility</span>
                <span class="text-emerald-400 font-black text-lg">Full Support</span>
              </div>
            </div>
          </div>

          <div class="space-y-3">
            <h4 class="font-bold text-slate-300 text-xs uppercase tracking-wider flex items-center gap-2">
              <i data-lucide="list" class="w-4 h-4 text-amber-400"></i> Installed / Tracked Mods
            </h4>
            ${
              trackedMods.length > 0
                ? `
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                ${trackedMods
                  .map(
                    (m) => `
                  <div class="p-4 bg-slate-950/60 rounded-2xl border border-slate-800 space-y-2 flex flex-col justify-between">
                    <div class="space-y-1.5">
                      <div class="flex items-start justify-between gap-2">
                        <span class="font-bold text-white text-xs leading-snug">${m.name || "Unknown Mod"}</span>
                        <span class="px-2 py-0.5 rounded-md text-[10px] font-bold flex-shrink-0 ${m.isEnabled ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-400"}">${m.isEnabled ? "Enabled" : "Disabled"}</span>
                      </div>
                      <div class="flex items-center gap-2 flex-wrap text-[10px]">
                        ${m.category ? `<span class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold">${m.category}</span>` : ""}
                        ${m.version ? `<span class="px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 font-bold">v${m.version}</span>` : ""}
                      </div>
                    </div>
                    ${
                      m.nexusUrl
                        ? `
                      <a href="${m.nexusUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white font-bold text-[11px] border border-amber-500/30 transition-all">
                        <i data-lucide="external-link" class="w-3.5 h-3.5"></i> View on Nexus
                      </a>
                    `
                        : ""
                    }
                  </div>
                `,
                  )
                  .join("")}
              </div>
            `
                : `
              <div class="p-6 bg-slate-950/40 rounded-2xl border border-slate-800/80 text-center space-y-2">
                <div class="inline-flex p-3 rounded-full bg-slate-800/60 text-slate-400 mb-1">
                  <i data-lucide="package-x" class="w-6 h-6"></i>
                </div>
                <h5 class="text-slate-300 font-bold text-xs">No Active Mods Tracked</h5>
                <p class="text-xs text-slate-500 max-w-xs mx-auto">No individual mods are currently tracked for this title. Browse the Nexus Mods hub above to find available mods.</p>
              </div>
            `
            }
          </div>
        `;
      }

      if (loadingEl) loadingEl.classList.add("hidden");
      contentEl.classList.remove("hidden");

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Failed to fetch game details:", err);
      if (loadingEl) loadingEl.classList.add("hidden");
      if (errorEl) {
        errorEl.classList.remove("hidden");
        if (errorMsgEl) errorMsgEl.textContent = "Network or server error encountered.";
      }
    }
  }

  // Setup Game Detail Tab Switching Listener
  const gameDetailTabs = document.getElementById("game-detail-tabs");
  if (gameDetailTabs) {
    gameDetailTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-detail-tab]");
      if (btn) {
        const tabKey = btn.getAttribute("data-detail-tab");
        gameDetailTabs.querySelectorAll("[data-detail-tab]").forEach((b) => {
          b.className =
            "game-tab-btn px-4 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-bold transition-all whitespace-nowrap flex items-center gap-2";
        });
        btn.className =
          "game-tab-btn active px-4 py-2 rounded-xl bg-brand-600 text-white text-xs font-bold transition-all whitespace-nowrap flex items-center gap-2";

        document.querySelectorAll(".game-tab-panel").forEach((panel) => {
          if (panel.id === `tab-panel-${tabKey}`) {
            panel.classList.remove("hidden");
          } else {
            panel.classList.add("hidden");
          }
        });
      }
    });
  }

  // Global Click Event Delegation
  document.addEventListener("click", (e) => {
    // 1. Target game cards to navigate to full game detail page. Library cards
    //    opt out via data-card-action="open-drawer" (EPIC-UX-LIBRARY-0001) so
    //    they open the unified game detail drawer instead of navigating.
    const gameCard = e.target.closest(".game-card");
    if (gameCard && !gameCard.hasAttribute("data-card-action")) {
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.button === 0) {
        if (e.target.closest('a[target="_blank"]') || e.target.closest("button")) {
          return;
        }
        e.preventDefault();
        const gameId = gameCard.getAttribute("data-game-id") || "";
        if (gameId) {
          window.location.hash = "#/game/" + encodeURIComponent(gameId);
        }
      }
    }

    // 2. Target Local PC Scan button directly or delegated
    const scanPcBtn = e.target.closest("#scan-pc-btn");
    if (scanPcBtn) {
      e.preventDefault();
      fetchLocalDevice();
    }
  });

  // Event Listeners
  if (scanBtn) scanBtn.addEventListener("click", fetchLocalDevice);

  // Playability Preset Select & Tabs
  const presetSelect = document.getElementById("device-preset-select");
  if (presetSelect) {
    presetSelect.addEventListener("change", (e) => {
      currentDeviceId = e.target.value;
      fetchPlayableGames(currentDeviceId, currentTierFilter);
    });
  }

  const tabAll = document.getElementById("tab-all-playable");
  const tabGreat = document.getElementById("tab-great");
  const tabPlayable = document.getElementById("tab-playable");

  if (tabAll) {
    tabAll.addEventListener("click", () => {
      currentTierFilter = "all";
      updateTabStyles();
      renderPlayableGames();
    });
  }
  if (tabGreat) {
    tabGreat.addEventListener("click", () => {
      currentTierFilter = "great";
      updateTabStyles();
      renderPlayableGames();
    });
  }
  if (tabPlayable) {
    tabPlayable.addEventListener("click", () => {
      currentTierFilter = "playable";
      updateTabStyles();
      renderPlayableGames();
    });
  }

  // Sprint 7 (WUD-7.2): "Display only current system hardware" filter toggle.
  // Explicit user action re-renders the matrix — never a reactive recompute.
  const dpmCurrentSystemToggle = document.getElementById("dpm-current-system-toggle");
  if (dpmCurrentSystemToggle) {
    dpmCurrentSystemToggle.addEventListener("change", (e) => {
      dpmCurrentSystemOnly = !!e.target.checked;
      renderPlayableGames();
    });
  }

  // 6b. Fetch Dashboard Summary (FEAT-0154 Splash Overhaul)
  async function fetchDashboardSummary() {
    const dealsRadarCard = document.getElementById("dashboard-deals-radar");
    const platformTotalEl = document.getElementById("dashboard-platform-total");
    const platformsEl = document.getElementById("dashboard-platforms");
    const fleetEl = document.getElementById("dashboard-fleet");
    const moddableEl = document.getElementById("dashboard-moddable");
    const featuredSpotlightEl = document.getElementById("dashboard-featured-spotlight-content");

    try {
      const res = await apiFetch("/api/dashboard/summary");
      const data = await res.json();
      if (!data?.success || !data?.summary) return;
      const s = data.summary;

      // ---- Featured Spotlight (EPIC-UX-REFINE-0002) ----
      if (featuredSpotlightEl) {
        const f = s.featured;
        const dealsApi = window.__deals || {};
        const escAttr = (v) =>
          String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        if (f && f.title) {
          const coverHtml = dealsApi.coverArtHtml
            ? dealsApi.coverArtHtml(
                f.coverUrl,
                f.title,
                "w-28 h-36 sm:w-32 sm:h-40 rounded-xl flex-shrink-0",
              )
            : "";
          const genrePills = (Array.isArray(f.genres) ? f.genres : [])
            .slice(0, 3)
            .map(
              (gr) =>
                `<span class="px-2 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${escAttr(gr)}</span>`,
            )
            .join("");
          const reviewBadge =
            f.reviewScore != null
              ? `<span class="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold whitespace-nowrap" data-featured-score>★ ${f.reviewScore}</span>`
              : '<span class="px-2 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-bold" data-featured-score>Score —</span>';
          const priceStack =
            f.kind === "giveaway"
              ? `<span class="text-xs font-bold text-amber-300 px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30" data-featured-price>${escAttr(f.price) || "FREE"}</span>`
              : f.price != null
                ? `<span class="text-lg font-black text-emerald-400" data-featured-price>$${Number(f.price).toFixed(2)}</span>`
                : '<span class="text-lg font-black text-emerald-400" data-featured-price>FREE</span>';
          const urgency = f.endAt && dealsApi.countdownFor ? dealsApi.countdownFor(f.endAt) : "";
          const actionLabel =
            f.kind === "giveaway" ? "Claim Freebie" : f.kind === "deal" ? "View Deal" : "Open Game";
          featuredSpotlightEl.innerHTML = `
            <div class="flex flex-col sm:flex-row gap-5">
              ${coverHtml}
              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-1.5 mb-1.5">
                  ${genrePills}
                  ${reviewBadge}
                </div>
                <h4 class="text-lg font-extrabold text-white truncate" data-featured-title>${escAttr(f.title)}</h4>
                <p class="text-xs text-slate-400 mt-1.5 leading-relaxed line-clamp-2" data-featured-synopsis>${escAttr(f.synopsis || "Featured pick from across your library and active store deals.")}</p>
                <div class="flex flex-wrap items-center gap-3 mt-3">
                  ${priceStack}
                  <span class="text-[10px] font-bold text-slate-400 px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700" data-featured-store>${escAttr(f.store || "MGPL")}</span>
                  ${urgency}
                </div>
                <div class="mt-4 flex flex-wrap items-center gap-2">
                  <a href="${escAttr(f.url || "#")}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold shadow-lg shadow-amber-600/20 transition-all active:scale-95" data-featured-action>
                    <i data-lucide="${f.kind === "giveaway" ? "gift" : f.kind === "deal" ? "external-link" : "gamepad-2"}" class="w-3.5 h-3.5"></i>
                    <span>${actionLabel}</span>
                  </a>
                  ${window.affiliateDisclosureHtml ? window.affiliateDisclosureHtml() : ""}
                </div>
              </div>
            </div>
          `;
        } else {
          featuredSpotlightEl.innerHTML =
            '<p class="text-sm text-slate-400">No featured pick right now — check back after your first sync.</p>';
        }
      }

      // ---- Deals & Freebies Radar Card (EPIC-UX-REFINE-0002 rich media) ----
      if (dealsRadarCard) {
        const fb = s.freebiesAndDeals || {};
        const giveaways = Array.isArray(fb.giveaways) ? fb.giveaways : [];
        const deals = Array.isArray(fb.deals) ? fb.deals : [];
        const giveawayCount = fb.giveawayCount ?? giveaways.length;
        const dealCount = fb.dealCount ?? deals.length;
        const dealsApi = window.__deals || {};
        const escAttr = (v) =>
          String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const urgencyFor =
          dealsApi.countdownFor ||
          ((endAt) => {
            if (!endAt)
              return '<span class="text-[10px] text-slate-500 font-bold">No expiry listed</span>';
            const endTime = new Date(String(endAt).replace(" ", "T")).getTime();
            const now = Date.now();
            // Sprint 6.1 (stability): an unparseable date string (e.g. "N/A") is
            // "No expiry listed", never "Ending soon".
            if (Number.isNaN(endTime)) {
              return '<span class="text-[10px] text-slate-500 font-bold">No expiry listed</span>';
            }
            if (endTime <= now) {
              return '<span class="text-[10px] text-amber-400 font-bold">Ending soon</span>';
            }
            const diffMs = endTime - now;
            const days = Math.floor(diffMs / 86400000);
            const hours = Math.floor((diffMs % 86400000) / 3600000);
            if (days >= 1)
              return `<span class="text-[10px] text-emerald-400 font-bold">Ends in ${days}d</span>`;
            if (hours >= 1)
              return `<span class="text-[10px] text-amber-400 font-bold">Ends in ${hours}h</span>`;
            return '<span class="text-[10px] text-rose-400 font-bold">Ends soon</span>';
          });
        const storePill = (store) => {
          const label = dealsApi.storeBadgeFor
            ? dealsApi.storeBadgeFor(store)
            : store || "Free Giveaway";
          return `<span class="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold whitespace-nowrap" data-freebie-store>${escAttr(label)}</span>`;
        };

        const giveawayHtml = giveaways.length
          ? giveaways
              .map(
                (g) => `
              <div class="flex items-center gap-3 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-emerald-500/40 transition-all group" data-freebie-card>
                ${dealsApi.coverArtHtml ? dealsApi.coverArtHtml(g.image, g.title, "w-12 h-14 rounded-lg flex-shrink-0") : ""}
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    ${storePill(g.store || g.platforms)}
                    ${g.worth && g.worth !== "N/A" ? `<span class="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-bold whitespace-nowrap">Worth ${escAttr(g.worth)}</span>` : ""}
                    <span class="px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-black whitespace-nowrap" data-freebie-free-badge>FREE</span>
                  </div>
                  <p class="text-xs font-bold text-white truncate group-hover:text-emerald-400 transition-colors mt-1" data-freebie-title>${escAttr(g.title || "Free Giveaway")}</p>
                  <p class="text-[10px] text-slate-400 truncate mt-0.5" data-freebie-desc>${escAttr((g.description || "").slice(0, 90) || "Free limited-time giveaway — claim it before it expires.")}</p>
                  <div class="flex items-center gap-1.5 mt-0.5">
                    <i data-lucide="timer" class="w-3 h-3 text-emerald-400"></i>
                    ${urgencyFor(g.endAt)}
                  </div>
                </div>
                <a href="${escAttr(g.url || "#")}" target="_blank" rel="noopener noreferrer" class="freebie-claim-btn shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition-all shadow-md shadow-emerald-600/20" title="Claim this free giveaway">
                  <i data-lucide="gift" class="w-3 h-3"></i>
                  <span>Claim</span>
                </a>
              </div>
            `,
              )
              .join("")
          : '<p class="text-xs text-slate-500">No active giveaways right now.</p>';

        // EPIC-UX-REFINE-0002: top deal cards carry cover art, genre pills,
        // review score pills, price breakdown and a verified 30-day low tooltip.
        const dealHtml = deals.length
          ? deals
              .map((d) => {
                const genreBadges =
                  Array.isArray(d.genres) && d.genres.length
                    ? d.genres
                        .slice(0, 2)
                        .map(
                          (gr) =>
                            `<span class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${escAttr(gr)}</span>`,
                        )
                        .join("")
                    : "";
                const reviewScore = d.compositeScore ?? d.steamScore ?? d.openCriticScore ?? null;
                const ratingBadge =
                  reviewScore != null
                    ? `<span class="px-1.5 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold whitespace-nowrap" data-deal-score>★ ${reviewScore}</span>`
                    : '<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-bold whitespace-nowrap" data-deal-score>Score —</span>';
                const currentPriceNum = parseFloat(d.currentPrice);
                const currentPriceStr =
                  currentPriceNum > 0 ? `$${currentPriceNum.toFixed(2)}` : "FREE";
                const regularPriceNum = parseFloat(d.regularPrice);
                const regularPriceStr = regularPriceNum > 0 ? `$${regularPriceNum.toFixed(2)}` : "";
                const lowTooltip =
                  d.lowest30d != null && d.lowest30d > 0
                    ? `<span class="px-1.5 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold whitespace-nowrap" title="Verified lowest price in the last 30 days" data-deal-30d-low>30d low: $${Number(d.lowest30d).toFixed(2)}</span>`
                    : "";
                return `
              <div class="flex items-center gap-3 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-pink-500/40 transition-all group" data-deal-card>
                ${dealsApi.coverArtHtml ? dealsApi.coverArtHtml(d.coverUrl, d.title, "w-12 h-14 rounded-lg flex-shrink-0") : ""}
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="px-2 py-0.5 rounded-md bg-pink-500/10 text-pink-300 border border-pink-500/30 text-[10px] font-bold whitespace-nowrap" data-deal-store>${escAttr(d.store || "Store")}</span>
                    ${genreBadges}
                    ${ratingBadge}
                    ${lowTooltip}
                  </div>
                  <p class="text-xs font-bold text-white truncate group-hover:text-pink-400 transition-colors mt-1" data-deal-title>${escAttr(d.title || "Deal")}</p>
                  <div class="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                    <span class="text-slate-500 line-through">${regularPriceStr && regularPriceStr !== currentPriceStr ? escAttr(regularPriceStr) : ""}</span>
                    <span class="text-emerald-400 font-bold">${escAttr(currentPriceStr)}</span>
                    ${d.discountCut ? `<span class="px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold" data-deal-discount>-${escAttr(d.discountCut)}%</span>` : ""}
                  </div>
                </div>
                <a href="${escAttr(d.url || "#")}" target="_blank" rel="noopener noreferrer" class="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 text-white text-[11px] font-bold transition-all shadow-md shadow-pink-600/20" data-deal-view>
                  <i data-lucide="external-link" class="w-3 h-3"></i>
                  <span>View Deal</span>
                </a>
              </div>
            `;
              })
              .join("")
          : '<p class="text-xs text-slate-500">No top deals right now.</p>';

        dealsRadarCard.innerHTML = `
          <div class="space-y-4">
            <div>
              <div class="flex items-center justify-between mb-2">
                <h4 class="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                  <i data-lucide="gift" class="w-4 h-4"></i> Freebies & Giveaways
                </h4>
                <span class="px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-300 text-[10px] font-bold border border-emerald-500/20">${giveawayCount} Active</span>
              </div>
              <div class="space-y-1.5">${giveawayHtml}</div>
            </div>
            <div>
              <div class="flex items-center justify-between mb-2">
                <h4 class="text-xs font-bold text-pink-400 uppercase tracking-wider flex items-center gap-1.5">
                  <i data-lucide="tag" class="w-4 h-4"></i> Top Deals
                </h4>
                <span class="px-2 py-0.5 rounded-lg bg-pink-500/10 text-pink-300 text-[10px] font-bold border border-pink-500/20">${dealCount} Deals</span>
              </div>
              <div class="space-y-1.5">${dealHtml}</div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <a href="#/deals" data-deals-tab="release-radar" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-all w-fit">
                <i data-lucide="calendar" class="w-3.5 h-3.5 text-pink-400"></i>
                <span>View complete drop schedule →</span>
              </a>
              <a href="#/deals" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition-all w-fit">
                <i data-lucide="radar" class="w-3.5 h-3.5 text-pink-400"></i>
                <span>All Deals</span>
              </a>
            </div>
          </div>
        `;
      }

      // ---- Recurring Giveaway Schedule Alert Banner ----
      const scheduleBannerEl = document.getElementById("dashboard-schedule-banner");
      if (scheduleBannerEl) {
        scheduleBannerEl.innerHTML = renderGiveawayScheduleBanner();
        scheduleBannerEl.classList.remove("hidden");
      }

      // ---- Platform Breakdown ----
      if (platformTotalEl) {
        platformTotalEl.textContent = `Total Games: ${s.platformBreakdown?.total ?? 0}`;
      }

      if (platformsEl) {
        const platforms = Array.isArray(s.platformBreakdown?.platforms)
          ? s.platformBreakdown.platforms
          : [];
        if (platforms.length) {
          const disclaimer = `<p class="text-[11px] text-slate-400 italic mb-2">Counts reflect multi-platform ownership across stores.</p>`;
          // EPIC-UX-REFINE-0001: "All Games" is the first entry point.
          const allChip = `
            <a href="#/library" data-platform="All Games" class="platform-chip inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/40 hover:border-emerald-400/70 hover:bg-emerald-500/20 transition-all group">
              <span class="text-xs font-bold text-emerald-300 group-hover:text-emerald-200 transition-colors">All Games</span>
              <span class="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-200 text-[10px] font-extrabold">${s.platformBreakdown?.total ?? 0}</span>
            </a>
          `;
          const chipsHtml = platforms
            .map(
              (p) => `
              <a href="javascript:void(0)" data-platform="${p.name}" class="platform-chip inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-brand-500/40 hover:bg-slate-900 transition-all group">
                <span class="text-xs font-bold text-white group-hover:text-brand-400 transition-colors">${p.name}</span>
                <span class="px-2 py-0.5 rounded-md bg-brand-500/20 text-brand-300 text-[10px] font-extrabold">${p.count}</span>
              </a>
            `,
            )
            .join("");
          platformsEl.innerHTML =
            disclaimer + `<div class="flex flex-wrap gap-2">${allChip}${chipsHtml}</div>`;
        } else {
          platformsEl.innerHTML =
            '<p class="text-xs text-slate-500">No platform data available.</p>';
        }
      }

      // ---- Active Device (EPIC-UX-REFINE-0001): compact active-device pill ----
      if (fleetEl) {
        const fs = s.fleetSummary || {};
        const totalCount =
          fs.totalDevices ?? (Array.isArray(fs.activeDevices) ? fs.activeDevices.length : 0);
        const deviceList = Array.isArray(fs.activeDevices)
          ? fs.activeDevices
          : fs.primary
            ? [fs.primary]
            : [];
        const primary = deviceList[0];

        if (primary) {
          const name = primary.deviceName || primary.deviceId || "Device";
          const gpu = primary.gpu || primary.gpuModel || "N/A";
          const vram = primary.vramGb != null ? `${primary.vramGb} GB` : "N/A";
          fleetEl.innerHTML = `
            <div class="flex flex-wrap items-center gap-3">
              <a href="#/fleet" class="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 transition-all group">
                <span class="flex h-2 w-2 relative">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span class="truncate max-w-[160px]" title="${name}">${name}</span>
                <span class="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-200 text-[10px] font-extrabold">${totalCount} Active</span>
              </a>
              <span class="text-[11px] text-slate-400 truncate max-w-[220px]" title="${gpu}">${gpu} · ${vram} VRAM</span>
            </div>
          `;
        } else {
          fleetEl.innerHTML = '<p class="text-xs text-slate-500">No active devices registered.</p>';
        }
      }

      // ---- Top Modded (EPIC-UX-REFINE-0002): rich cards w/ cover + taxonomy ----
      if (moddableEl) {
        const moddable = Array.isArray(s.moddableGames) ? s.moddableGames.slice(0, 5) : [];
        const escAttr = (v) =>
          String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const dealsApi = window.__deals || {};
        if (moddable.length) {
          moddableEl.innerHTML = moddable
            .map((m, i) => {
              const safeTitle = escAttr(m.title);
              const tags = (Array.isArray(m.modTags) ? m.modTags : [])
                .slice(0, 3)
                .map(
                  (t) =>
                    `<span class="px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px] font-bold whitespace-nowrap" data-mod-tag>${escAttr(t)}</span>`,
                )
                .join("");
              const nexusHref =
                safeModUrl(m.nexusUrl) ||
                safeModUrl(
                  `https://www.nexusmods.com/${String(m.domain || "").replace(/[^a-z0-9]/gi, "")}`,
                ) ||
                "https://www.nexusmods.com/";
              return `
              <div class="moddable-game-btn cursor-pointer text-left w-full bg-slate-900/40 border border-slate-800 hover:border-amber-500/40 rounded-xl px-3 py-2 transition-all group flex items-center justify-between gap-3" data-moddable-title="${safeTitle}">
                <div class="flex items-center gap-2.5 min-w-0">
                  ${dealsApi.coverArtHtml ? dealsApi.coverArtHtml(m.coverUrl, m.title, "w-10 h-12 rounded-lg flex-shrink-0") : ""}
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-black text-slate-500 w-4 flex-shrink-0">${i + 1}</span>
                      <span class="text-xs font-bold text-white group-hover:text-amber-400 transition-colors truncate" title="${safeTitle}">${safeTitle}</span>
                      <span class="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 text-[10px] font-bold border border-amber-500/20 flex-shrink-0" data-mod-count>${m.modCount ?? 0} Mods</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-1 mt-1">${tags || '<span class="text-[10px] text-slate-500">Mods</span>'}</div>
                  </div>
                </div>
                <a href="${escAttr(nexusHref)}" target="_blank" rel="noopener noreferrer" class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white text-[11px] font-bold transition-all border border-amber-500/30" data-mod-nexus-link>
                  <i data-lucide="external-link" class="w-3 h-3"></i>
                  <span>Nexus</span>
                </a>
              </div>
            `;
            })
            .join("");
        } else {
          moddableEl.innerHTML =
            '<p class="text-xs text-slate-500">No moddable games found in your library.</p>';
        }
      }

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Failed to fetch dashboard summary:", err);
    }
  }

  // Wire moddable game hub triggers (event delegation). Clicking anywhere on
  // the card opens the game drawer EXCEPT clicking the inner Nexus links.
  document.addEventListener("click", (e) => {
    const modBtn = e.target.closest(".moddable-game-btn");
    if (modBtn) {
      if (e.target.closest("[data-mod-nexus-link]")) return;
      const title = modBtn.getAttribute("data-moddable-title");
      if (title && typeof window.openGameDetailDrawer === "function") {
        window.openGameDetailDrawer(title);
      }
    }
  });

  // Map a DB platform display name to a Platform Hub tab key.
  // EPIC-04: canonical taxonomy labels resolve to their hub tab.
  // EPIC-05 (HUB defect): unknown platforms return null so the caller hides the
  // deep-link instead of emitting a broken "steam" fallback link.
  function platformHubKey(platformName) {
    const name = String(platformName || "").toLowerCase();
    if (name === "pc" || name === "pc / storefront") return "steam";
    if (name.includes("console – playstation")) return "playstation";
    if (name.includes("console – xbox")) return "xbox";
    if (name.includes("console – nintendo")) return "nintendo";
    if (name.includes("mobile –") || name.includes("cloud")) return null;
    if (name.includes("steam")) return "steam";
    if (name.includes("gog")) return "gog";
    if (name.includes("epic")) return "epic";
    if (
      name.includes("ps4") ||
      name.includes("ps5") ||
      name.includes("playstation") ||
      name.includes("psn")
    )
      return "playstation";
    if (name.includes("xbox")) return "xbox";
    if (name.includes("ubisoft")) return "ubisoft";
    if (name.includes("ea") || name.includes("origin")) return "ea";
    if (name.includes("battle") || name.includes("blizzard")) return "battlenet";
    if (name.includes("amazon")) return "amazon";
    if (name.includes("itch")) return "itchio";
    if (name.includes("nintendo") || name.includes("switch") || name.includes("eshop"))
      return "nintendo";
    return null;
  }

  // Render the recurring giveaway schedule alert banner (Epic / Humble drops).
  function renderGiveawayScheduleBanner() {
    const day = new Date().getDay(); // 0=Sun ... 4=Thu ... 6=Sat
    const isThursday = day === 4;
    const epicUrl = "https://store.epicgames.com/free-games";
    const humbleUrl = "https://www.humblebundle.com/store/free-games";

    if (isThursday) {
      return `
        <div class="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/40 animate-pulse">
          <span class="text-lg" aria-hidden="true">🚨</span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-emerald-300">Free Game Drop Live Today (Epic / Humble)</p>
            <p class="text-[10px] text-slate-400">Weekly giveaways refresh every Thursday at 11:00 AM ET.</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <a href="${epicUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition-all">Click to Claim →</a>
            <a href="${humbleUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold transition-all">Humble</a>
          </div>
        </div>
      `;
    }

    return `
      <div class="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-slate-800/40 border border-slate-700">
        <span class="text-lg" aria-hidden="true">📅</span>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-bold text-slate-200">Next Weekly Drop: Thursday 11:00 AM ET</p>
          <p class="text-[10px] text-slate-400">Epic Games & Humble Bundle refresh their free game giveaways every Thursday.</p>
        </div>
        <a href="${epicUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold transition-all">Epic Free Games</a>
      </div>
    `;
  }

  async function renderPlatformGameList(platformName) {
    const container = document.getElementById("dashboard-platform-games");
    if (!container) return;

    container.classList.remove("hidden");
    container.innerHTML = `
      <div class="flex items-center justify-between py-1">
        <span class="text-xs font-bold text-slate-300">Showing top games for <span class="text-brand-400">${platformName}</span></span>
        <button id="close-platform-games-btn" class="text-xs text-slate-400 hover:text-white flex items-center gap-1">
          <i data-lucide="x" class="w-3.5 h-3.5"></i> Close
        </button>
      </div>
      <div class="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        <p class="text-xs text-slate-400 py-2">Loading platform games…</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    const closeBtn = document.getElementById("close-platform-games-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        container.classList.add("hidden");
        container.innerHTML = "";
      });
    }

    // Show the "Open [Platform] in Platform Hub →" deep-link
    const hubLinkEl = document.getElementById("dashboard-platform-hub-link");
    if (hubLinkEl) {
      const hubKey = platformHubKey(platformName);
      if (hubKey) {
        hubLinkEl.classList.remove("hidden");
        hubLinkEl.innerHTML = `
          <a href="#/platforms?store=${hubKey}" class="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-400 hover:text-brand-300 transition-colors">
            Open ${platformName} in Platform Hub →
          </a>
        `;
      } else {
        // EPIC-05 (HUB defect): no valid hub tab for this platform — hide the
        // deep-link instead of emitting a broken fallback link.
        hubLinkEl.classList.add("hidden");
        hubLinkEl.innerHTML = "";
      }
    }

    try {
      const res = await apiFetch(
        `/api/games?active=true&owned=true&platform=${encodeURIComponent(platformName)}`,
      );
      const data = await res.json();
      const listEl = container.querySelector(".space-y-1\\.5");
      if (!listEl) return;

      if (data.success && Array.isArray(data.games) && data.games.length > 0) {
        // Server already sorts by compositeScore DESC; keep a client-side fallback.
        const sorted = [...data.games].sort((a, b) => {
          const sa = a.compositeScore ?? -1;
          const sb = b.compositeScore ?? -1;
          if (sb !== sa) return sb - sa;
          return (a.title || a["Game Title"] || "").localeCompare(b.title || b["Game Title"] || "");
        });

        listEl.innerHTML = sorted
          .slice(0, 8)
          .map((g) => {
            const title = g.title || g["Game Title"] || "Untitled Game";
            const cover = g.cover_url || g.coverUrl || "";
            const hours = g.hoursPlayed ?? g.playtime_forever ?? 0;
            const playStatus = g.playStatus || "Backlog";
            const isModdable = Boolean(g.isModdable);
            const steamScore = g.steamScore != null ? Math.round(g.steamScore) : null;
            const openCriticScore =
              g.openCriticScore != null ? Math.round(g.openCriticScore) : null;
            const genres = Array.isArray(g.genres) && g.genres.length ? g.genres.slice(0, 3) : [];

            const moddablePill = isModdable
              ? `<span class="px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-bold whitespace-nowrap">🛠️ Moddable</span>`
              : "";
            const steamPill =
              steamScore != null
                ? `<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-bold whitespace-nowrap">Steam: ${steamScore}%</span>`
                : "";
            const ocPill =
              openCriticScore != null
                ? `<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-bold whitespace-nowrap">OpenCritic: ${openCriticScore}</span>`
                : "";
            const genrePill = genres.length
              ? `<span class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${genres.join(", ")}</span>`
              : "";

            return `
              <div data-game-title="${title}" class="platform-game-row flex items-center justify-between gap-2 p-2 rounded-xl bg-slate-950/60 border border-slate-800/80 hover:border-brand-500/50 hover:bg-slate-800/40 transition-all cursor-pointer group">
                <div class="flex items-center gap-2.5 min-w-0">
                  ${
                    cover
                      ? `<img src="${cover}" class="w-8 h-8 rounded-lg object-cover flex-shrink-0" alt="${title}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-[9px] text-slate-400 font-bold flex-shrink-0\\'>MGPL</div>';" />`
                      : `<div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-[9px] text-slate-400 font-bold flex-shrink-0">MGPL</div>`
                  }
                  <div class="min-w-0">
                    <p class="text-xs font-bold text-white group-hover:text-brand-400 transition-colors truncate">${title}</p>
                    <div class="flex flex-wrap items-center gap-1 mt-0.5">
                      ${moddablePill}${steamPill}${ocPill}${genrePill}
                    </div>
                    <p class="text-[10px] text-slate-400 mt-0.5">${playStatus} · ${hours}h played</p>
                  </div>
                </div>
                <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 group-hover:text-brand-400 transition-colors flex-shrink-0"></i>
              </div>
            `;
          })
          .join("");
        if (window.lucide) window.lucide.createIcons();
      } else {
        listEl.innerHTML = `<p class="text-xs text-slate-500 py-2">No owned games found for ${platformName}.</p>`;
      }
    } catch (err) {
      console.error("Failed to fetch platform games:", err);
      const listEl = container.querySelector(".space-y-1\\.5");
      if (listEl) {
        listEl.innerHTML = `<p class="text-xs text-rose-400 py-2">Failed to load games for ${platformName}.</p>`;
      }
    }
  }

  // Click delegation for Platform Breakdown chips & compact game rows
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("#dashboard-platforms .platform-chip");
    if (chip) {
      const platformName = chip.getAttribute("data-platform");
      if (platformName) {
        // Set active chip state
        document.querySelectorAll("#dashboard-platforms .platform-chip").forEach((c) => {
          c.classList.remove("ring-2", "ring-brand-500", "border-brand-500");
        });
        chip.classList.add("ring-2", "ring-brand-500", "border-brand-500");
        renderPlatformGameList(platformName);
      }
      return;
    }

    const gameRow = e.target.closest(".platform-game-row");
    if (gameRow) {
      const title = gameRow.getAttribute("data-game-title");
      if (title && typeof window.openGameDetailDrawer === "function") {
        window.openGameDetailDrawer(title);
      }
    }
  });

  // Expose dashboard summary hook for E2E verification
  window.fetchDashboardSummary = fetchDashboardSummary;

  // 7. Command/Fuzzy Search Input
  const commandInput = document.getElementById("command-search-input");
  const dropdownResults = document.getElementById("search-results-dropdown");

  // Keyboard shortcut listener for Ctrl+K or /
  document.addEventListener("keydown", (e) => {
    // Yield to the global command palette (FEAT-0150) when it is open.
    const paletteEl = document.getElementById("command-palette");
    const paletteOpen = paletteEl && !paletteEl.classList.contains("hidden");
    if (paletteOpen) return;

    if (
      (e.ctrlKey && e.key.toLowerCase() === "k") ||
      (e.key === "/" && document.activeElement !== commandInput)
    ) {
      e.preventDefault();
      if (commandInput) {
        commandInput.focus();
        commandInput.select();
      }
    }
  });

  let searchDebounceTimer = null;
  if (commandInput && dropdownResults) {
    commandInput.addEventListener("input", (e) => {
      const query = e.target.value.trim();
      clearTimeout(searchDebounceTimer);

      if (!query) {
        dropdownResults.classList.add("hidden");
        dropdownResults.innerHTML = "";
        return;
      }

      searchDebounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/games?search=${encodeURIComponent(query)}`);
          const data = await res.json();
          const games = data.games || [];

          if (games.length === 0) {
            dropdownResults.innerHTML =
              '<div class="p-4 text-center text-xs text-slate-500 font-semibold">No matching games or features found.</div>';
          } else {
            dropdownResults.innerHTML = games
              .slice(0, 6)
              .map(
                (g, idx) => `
              <div data-search-index="${idx}" class="search-result-row flex items-center justify-between p-2.5 hover:bg-slate-800 rounded-xl transition-colors cursor-pointer group">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-12 bg-slate-950 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center border border-slate-800">
                    ${g.cover_url ? `<img src="${g.cover_url}" class="w-full h-full object-cover" />` : `<i data-lucide="gamepad-2" class="w-4 h-4 text-slate-600"></i>`}
                  </div>
                  <div>
                    <h5 class="text-xs font-bold text-white group-hover:text-brand-400 transition-colors">${g["Game Title"] || g.gameTitle || "Game"}</h5>
                    <p class="text-[10px] text-slate-400">${g["Primary Genre"] || g.primaryGenre || "Game"}</p>
                  </div>
                </div>
                <button data-search-open-drawer type="button" class="px-2.5 py-1 rounded-lg bg-brand-600/20 text-brand-400 hover:bg-brand-600 hover:text-white text-[11px] font-bold transition-all">Open</button>
              </div>
            `,
              )
              .join("");
            // EPIC-UX-REFINE-0001: clicking a search result opens the game detail drawer.
            dropdownResults.querySelectorAll(".search-result-row").forEach((row, idx) => {
              row.addEventListener("click", (e) => {
                if (e.target.closest("[data-search-open-drawer]")) return;
                const gameRow = games[idx];
                const gid = gameRow?.GameID || gameRow?.id || gameRow?.gameId;
                const title = gameRow?.["Game Title"] || gameRow?.gameTitle || gameRow?.title;
                if (typeof window.openGameDetailDrawer === "function") {
                  window.openGameDetailDrawer(title, gid);
                }
              });
              const viewBtn = row.querySelector("[data-search-open-drawer]");
              if (viewBtn) {
                viewBtn.addEventListener("click", (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const gameRow = games[idx];
                  const gid = gameRow?.GameID || gameRow?.id || gameRow?.gameId;
                  const title = gameRow?.["Game Title"] || gameRow?.gameTitle || gameRow?.title;
                  if (typeof window.openGameDetailDrawer === "function") {
                    window.openGameDetailDrawer(title, gid);
                  }
                });
              }
            });
            if (window.lucide) window.lucide.createIcons();
          }
          dropdownResults.classList.remove("hidden");
        } catch (err) {
          console.error("Search error:", err);
        }
      }, 250);
    });

    // Close search dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (!commandInput.contains(e.target) && !dropdownResults.contains(e.target)) {
        dropdownResults.classList.add("hidden");
      }
    });
  }

  // 8. Quick Nav Cards & Progressive Disclosure
  const navCardDeals = document.getElementById("nav-card-deals");
  const navCardFleet = document.getElementById("nav-card-fleet");

  if (navCardDeals) {
    navCardDeals.addEventListener("click", () => {
      const dealsHub = document.getElementById("deals-store-tabs");
      if (dealsHub) dealsHub.scrollIntoView({ behavior: "smooth" });
    });
  }

  if (navCardFleet) {
    navCardFleet.addEventListener("click", () => {
      window.location.hash = "#/fleet";
    });
  }

  // Fetch Wishlist Sales Count for Quick Nav Card 2
  async function fetchWishlistCount() {
    try {
      const res = await apiFetch("/api/wishlist/on-sale");
      const data = await res.json();
      if (data.success && Array.isArray(data.wishlistDeals)) {
        const salesCountEl = document.getElementById("wishlist-sales-count");
        if (salesCountEl) salesCountEl.textContent = data.wishlistDeals.length;
      }
    } catch (err) {
      console.error("Failed to fetch wishlist sales count:", err);
    }
  }

  // Device Fleet Management Logic
  let currentFleetStatus = "active";
  let currentFleetDevices = [];

  const tabFleetActive = document.getElementById("tab-fleet-active");
  const tabFleetArchived = document.getElementById("tab-fleet-archived");

  if (tabFleetActive && tabFleetArchived) {
    tabFleetActive.addEventListener("click", () => {
      currentFleetStatus = "active";
      updateFleetTabStyles();
      fetchDeviceFleet("active");
    });

    tabFleetArchived.addEventListener("click", () => {
      currentFleetStatus = "archived";
      updateFleetTabStyles();
      fetchDeviceFleet("archived");
    });
  }

  function updateFleetTabStyles() {
    if (!tabFleetActive || !tabFleetArchived) return;
    if (currentFleetStatus === "active") {
      tabFleetActive.className =
        "px-3 py-1.5 rounded-lg text-emerald-400 bg-slate-900 transition-all flex items-center gap-1.5";
      tabFleetArchived.className =
        "px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all flex items-center gap-1.5";
    } else {
      tabFleetArchived.className =
        "px-3 py-1.5 rounded-lg text-emerald-400 bg-slate-900 transition-all flex items-center gap-1.5";
      tabFleetActive.className =
        "px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all flex items-center gap-1.5";
    }
  }

  // Custom PC Builder Event Handlers
  const btnToggleBuilder = document.getElementById("btn-toggle-builder");
  const btnCloseBuilder = document.getElementById("btn-close-builder");
  const btnCancelBuilder = document.getElementById("btn-cancel-builder");
  const pcBuilderCard = document.getElementById("pc-builder-card");
  const pcBuilderForm = document.getElementById("pc-builder-form");

  function togglePcBuilderCard(show) {
    if (!pcBuilderCard) return;
    if (show === undefined) {
      pcBuilderCard.classList.toggle("hidden");
    } else if (show) {
      pcBuilderCard.classList.remove("hidden");
    } else {
      pcBuilderCard.classList.add("hidden");
    }
  }

  if (btnToggleBuilder) {
    btnToggleBuilder.addEventListener("click", () => togglePcBuilderCard());
  }
  if (btnCloseBuilder) {
    btnCloseBuilder.addEventListener("click", () => togglePcBuilderCard(false));
  }
  if (btnCancelBuilder) {
    btnCancelBuilder.addEventListener("click", () => togglePcBuilderCard(false));
  }

  // PC Part Picker Catalog & Auto-Fill Integration
  let pcComponentsCatalog = null;

  async function loadPcComponentsCatalog() {
    try {
      const res = await apiFetch("/api/hardware/components");
      const data = await res.json();
      if (data.success && data.components) {
        pcComponentsCatalog = data.components;
        populatePartPickerDropdowns();
      }
    } catch (err) {
      console.error("Failed to load hardware catalog:", err);
    }
  }

  function populatePartPickerDropdowns() {
    if (!pcComponentsCatalog) return;

    const gpuSelect = document.getElementById("builder-gpu-select");
    const cpuSelect = document.getElementById("builder-cpu-select");
    const ramSelect = document.getElementById("builder-ram-select");
    const moboSelect = document.getElementById("builder-motherboard-select");
    const caseSelect = document.getElementById("builder-case-select");
    const psuSelect = document.getElementById("builder-psu-select");
    const storageSelect = document.getElementById("builder-storage-select");
    const osSelect = document.getElementById("builder-os-select");

    if (gpuSelect && pcComponentsCatalog.gpus) {
      gpuSelect.innerHTML =
        '<option value="">-- Select GPU --</option>' +
        pcComponentsCatalog.gpus
          .map((g) => `<option value="${g.name}">${g.name} (${g.specs?.vramGb}GB VRAM)</option>`)
          .join("");
    }
    if (cpuSelect && pcComponentsCatalog.cpus) {
      cpuSelect.innerHTML =
        '<option value="">-- Select CPU --</option>' +
        pcComponentsCatalog.cpus
          .map((c) => `<option value="${c.name}">${c.name}</option>`)
          .join("");
    }
    if (ramSelect && pcComponentsCatalog.ramKits) {
      ramSelect.innerHTML =
        '<option value="">-- Select Memory --</option>' +
        pcComponentsCatalog.ramKits
          .map((r) => `<option value="${r.name}">${r.name} (${r.specs?.ramGb}GB)</option>`)
          .join("");
    }
    if (moboSelect && pcComponentsCatalog.motherboards) {
      moboSelect.innerHTML =
        '<option value="">-- Select Motherboard --</option>' +
        pcComponentsCatalog.motherboards
          .map((m) => `<option value="${m.name}">${m.name}</option>`)
          .join("");
    }
    if (caseSelect && pcComponentsCatalog.cases) {
      caseSelect.innerHTML =
        '<option value="">-- Select Case --</option>' +
        pcComponentsCatalog.cases
          .map((c) => `<option value="${c.name}">${c.name}</option>`)
          .join("");
    }
    if (psuSelect && pcComponentsCatalog.psus) {
      psuSelect.innerHTML =
        '<option value="">-- Select Power Supply --</option>' +
        pcComponentsCatalog.psus
          .map((p) => `<option value="${p.name}">${p.name}</option>`)
          .join("");
    }
    if (storageSelect && pcComponentsCatalog.storageDrives) {
      storageSelect.innerHTML =
        '<option value="">-- Select Storage --</option>' +
        pcComponentsCatalog.storageDrives
          .map((s) => `<option value="${s.name}">${s.name} (${s.specs?.capacityGb}GB)</option>`)
          .join("");
    }
    if (osSelect && pcComponentsCatalog.operatingSystems) {
      osSelect.innerHTML =
        '<option value="">-- Select OS --</option>' +
        pcComponentsCatalog.operatingSystems
          .map((o) => `<option value="${o.name}">${o.name}</option>`)
          .join("");
    }
  }

  loadPcComponentsCatalog();

  async function runPlayabilitySimulation(deviceId) {
    const resultsContainer = document.getElementById("builder-results");
    const contentContainer = document.getElementById("builder-results-content");
    if (!resultsContainer || !contentContainer) return;

    resultsContainer.classList.remove("hidden");
    contentContainer.innerHTML = `
      <div class="col-span-full flex items-center justify-center py-4 text-slate-400 gap-2">
        <div class="animate-spin rounded-full h-4 w-4 border-b-2 border-emerald-500"></div>
        <span>Running real-time library playability simulation...</span>
      </div>
    `;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/devices/${encodeURIComponent(deviceId)}/playable-games`,
      );
      const data = await res.json();

      if (!data.success || !data.games) {
        contentContainer.innerHTML = `<div class="col-span-full text-red-400 py-2">Simulation failed to evaluate device library performance.</div>`;
        return;
      }

      const great = data.games.great || [];
      const playable = data.games.playable || [];
      const unplayable = data.games.unplayable || [];

      const renderTier = (title, games, badgeColor, borderColor) => `
        <div class="bg-slate-900/80 border ${borderColor} rounded-xl p-3 flex flex-col space-y-2">
          <div class="flex items-center justify-between">
            <span class="font-bold ${badgeColor}">${title}</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-300">${games.length} Games</span>
          </div>
          <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            ${
              games.length === 0
                ? `<div class="text-[10px] text-slate-500 italic">No games in this tier</div>`
                : games
                    .slice(0, 10)
                    .map(
                      (g) => `
              <div class="flex items-center justify-between bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                <span class="text-white font-medium truncate max-w-[140px]" title="${g.title}">${g.title}</span>
                <span class="text-[10px] text-slate-400 font-mono">${g.fps}</span>
              </div>
            `,
                    )
                    .join("")
            }
          </div>
        </div>
      `;

      contentContainer.innerHTML = `
        ${renderTier("⚡ 60+ FPS Great", great, "text-emerald-400", "border-emerald-500/30")}
        ${renderTier("🎮 30-60 FPS Playable", playable, "text-amber-400", "border-amber-500/30")}
        ${renderTier("⚠️ Low Performance (<30 FPS)", unplayable, "text-red-400", "border-red-500/30")}
      `;

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Simulation error:", err);
      contentContainer.innerHTML = `<div class="col-span-full text-red-400 py-2">Error executing simulation.</div>`;
    }
  }

  if (pcBuilderForm) {
    pcBuilderForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const deviceName = document.getElementById("builder-name")?.value?.trim();
      const deviceType = document.getElementById("builder-type")?.value || "Custom Desktop PC";
      const formFactor = document.getElementById("builder-form-factor")?.value?.trim() || "Desktop";
      const gpuModel =
        document.getElementById("builder-gpu-select")?.value?.trim() ||
        document.getElementById("builder-gpu")?.value?.trim() ||
        "Unspecified GPU";
      const cpuModel =
        document.getElementById("builder-cpu-select")?.value?.trim() ||
        document.getElementById("builder-cpu")?.value?.trim() ||
        "Unspecified CPU";
      const motherboard =
        document.getElementById("builder-motherboard-select")?.value?.trim() || "";
      const caseModel = document.getElementById("builder-case-select")?.value?.trim() || "";
      const psu = document.getElementById("builder-psu-select")?.value?.trim() || "";
      const storageSelectVal =
        document.getElementById("builder-storage-select")?.value?.trim() || "";
      const os =
        document.getElementById("builder-os-select")?.value?.trim() ||
        document.getElementById("builder-os")?.value?.trim() ||
        "Windows 11";

      let ramGb = 32;
      const ramSelectVal = document.getElementById("builder-ram-select")?.value?.trim();
      if (ramSelectVal && pcComponentsCatalog) {
        const ramList = pcComponentsCatalog.ramKits || pcComponentsCatalog.ram || [];
        const foundRam = ramList.find((r) => r.name === ramSelectVal);
        const ramVal = foundRam?.specs?.ramGb ?? foundRam?.ramGb;
        if (ramVal) ramGb = Number(ramVal);
      }

      let vramGb = 24;
      const gpuSelectVal = document.getElementById("builder-gpu-select")?.value?.trim();
      if (gpuSelectVal && pcComponentsCatalog) {
        const gpuList = pcComponentsCatalog.gpus || [];
        const foundGpu = gpuList.find((g) => g.name === gpuSelectVal);
        const vramVal = foundGpu?.specs?.vramGb ?? foundGpu?.vramGb;
        if (vramVal) vramGb = Number(vramVal);
      }

      let storageCapacityGb = 1000;
      if (storageSelectVal && pcComponentsCatalog) {
        const storageList = pcComponentsCatalog.storageDrives || pcComponentsCatalog.storage || [];
        const foundStorage = storageList.find((s) => s.name === storageSelectVal);
        const storageVal = foundStorage?.specs?.capacityGb ?? foundStorage?.capacityGb;
        if (storageVal) storageCapacityGb = Number(storageVal);
      }

      if (!deviceName) {
        alert("Please enter a device name");
        return;
      }

      // Generate a slug deviceId
      const deviceId =
        "custom-" +
        deviceName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") +
        "-" +
        Date.now().toString(36);

      try {
        const res = await fetch(`${API_BASE}/api/devices/upsert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId,
            deviceName,
            deviceType,
            formFactor,
            cpuModel,
            gpuModel,
            motherboard,
            caseModel,
            psu,
            ramGb,
            vramGb,
            storageCapacityGb,
            os,
            batteryWh: 0,
            isArchived: 0,
          }),
        });
        const data = await res.json();
        if (data.success) {
          fetchDeviceFleet("active");
          await runPlayabilitySimulation(deviceId);
          showToast(`Saved custom build "${deviceName}" and simulated library performance!`);
        } else {
          alert(data.error || "Failed to save custom PC build");
        }
      } catch (err) {
        console.error("Error submitting custom PC build:", err);
        alert("Error saving custom PC build");
      }
    });
  }

  // Scanned Hardware Game Filter Logic
  const fleetDeviceSelect = document.getElementById("fleet-device-select");
  if (fleetDeviceSelect) {
    fleetDeviceSelect.addEventListener("change", (e) => {
      const selectedId = e.target.value;
      if (selectedId) {
        fetchFleetPlayableGames(selectedId);
      }
    });
  }

  async function populateFleetDeviceSelect(devices) {
    if (!fleetDeviceSelect) return;
    const activeDevices = devices.filter((d) => !d.isArchived);
    if (!activeDevices.length) {
      fleetDeviceSelect.innerHTML = '<option value="">No Active Devices</option>';
      return;
    }

    const previousValue = fleetDeviceSelect.value;
    fleetDeviceSelect.innerHTML = activeDevices
      .map(
        (d) => `
      <option value="${d.id || d.deviceId}">${d.deviceName || d.id || d.deviceId} (${d.gpuModel || "N/A"})</option>
    `,
      )
      .join("");

    // Maintain selection or select first device
    const exists = activeDevices.some((d) => (d.id || d.deviceId) === previousValue);
    const selectedId = exists ? previousValue : activeDevices[0].id || activeDevices[0].deviceId;
    fleetDeviceSelect.value = selectedId;

    if (selectedId) {
      fetchFleetPlayableGames(selectedId);
    }
  }

  async function fetchFleetPlayableGames(deviceId) {
    const container = document.getElementById("fleet-playable-games-container");
    if (!container) return;

    container.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-8 text-slate-500">
        <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500 mb-2"></div>
        <p class="text-xs font-medium">Evaluating hardware compatibility...</p>
      </div>
    `;

    try {
      const res = await apiFetch(
        `${API_BASE}/api/devices/${encodeURIComponent(deviceId)}/playable-games`,
      );
      const data = await res.json();

      if (!data.success) {
        container.innerHTML = `<div class="col-span-full text-center py-8 text-red-400 text-xs">${data.error || "Failed to evaluate games for hardware"}</div>`;
        return;
      }

      // Combine games from tier1, tier2, tier3 or render all playable games
      const tier1 = data.tier1Games || data.games?.tier1 || [];
      const tier2 = data.tier2Games || data.games?.tier2 || [];
      const tier3 = data.tier3Games || data.games?.tier3 || [];
      const allGames = data.playableGames || [...tier1, ...tier2, ...tier3];

      if (!allGames.length) {
        container.innerHTML =
          '<div class="col-span-full text-center py-8 text-slate-500 text-xs">No games found meeting hardware specs for this device.</div>';
        return;
      }

      container.innerHTML = allGames
        .map((g) => {
          const gameTitle = g.gameTitle || g.title || "Unknown Game";
          const coverUrl = g.coverUrl || "";
          const preset = g.presetLevel || g.targetResolution || "Compatible";

          return `
          <div class="bg-slate-950/80 border border-slate-800 hover:border-emerald-500/40 rounded-xl overflow-hidden p-2 flex flex-col justify-between space-y-2 group transition-all">
            <div class="aspect-[3/4] bg-slate-900 rounded-lg overflow-hidden relative flex items-center justify-center">
              ${
                coverUrl
                  ? `<img src="${coverUrl}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2\\'>${gameTitle}</div>';" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="${gameTitle}" />`
                  : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2">${gameTitle}</div>`
              }
              <span class="absolute top-1 right-1 px-1 py-0.5 rounded text-[8px] font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-500/30">${preset}</span>
            </div>
            <h4 class="text-[11px] font-bold text-white truncate group-hover:text-emerald-400 transition-colors" title="${gameTitle}">${gameTitle}</h4>
          </div>
        `;
        })
        .join("");

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Failed to fetch fleet playable games:", err);
      if (container)
        container.innerHTML =
          '<div class="col-span-full text-center py-8 text-red-400 text-xs">Failed to load compatible games.</div>';
    }
  }

  async function fetchDeviceFleet(status = "active") {
    const container = document.getElementById("fleet-devices-container");
    if (container) {
      container.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-8 text-slate-500">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500 mb-2"></div>
          <p class="text-xs font-medium">Loading device fleet...</p>
        </div>
      `;
    }

    try {
      const res = await apiFetch(`${API_BASE}/api/devices?status=${status}`);
      const data = await res.json();

      if (res.ok && Array.isArray(data.devices)) {
        currentFleetDevices = data.devices;
        renderDeviceFleet(data.devices, status);
        if (status === "active") {
          populateFleetDeviceSelect(data.devices);
        }
      } else {
        if (container) {
          container.innerHTML = `
            <div class="col-span-full text-center py-8 text-red-400 text-xs">
              Failed to load device fleet.
            </div>
          `;
        }
      }
    } catch (err) {
      console.error("Failed to fetch device fleet:", err);
      if (container) {
        container.innerHTML = `
          <div class="col-span-full text-center py-8 text-red-400 text-xs">
            Failed to load device fleet.
          </div>
        `;
      }
    }
  }

  function renderDeviceFleet(devices, status) {
    const container = document.getElementById("fleet-devices-container");
    if (!container) return;

    if (devices.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-slate-500 text-xs">
          No ${status} devices found in fleet.
        </div>
      `;
      return;
    }

    const activeDeviceId =
      localStorage.getItem("activeDeviceId") || currentDeviceId || "local-host";

    // Sprint 3 (EPIC-FLEET-0001): horizontal data rows per VCM Ch 23.5/23.6 —
    // icon, name, CPU, GPU/VRAM, RAM, free storage displayed inline, with
    // an "Incomplete Specs" warning affordance when core fields are missing.
    container.innerHTML = devices
      .map((device) => {
        const deviceId = device.deviceId || device.id;
        const isArchived = device.isArchived;
        const isCurrentActive = deviceId === activeDeviceId;

        const devNameEscaped = (device.deviceName || deviceId).replace(/'/g, "\\'");

        const hasIncompleteSpecs =
          !device.cpuModel ||
          device.ramGb == null ||
          !device.gpuModel ||
          device.vramGb == null ||
          device.storageFreeGb == null;

        const iconName =
          device.deviceType === "handheld" || device.deviceType === "console"
            ? "gamepad-2"
            : device.deviceType === "laptop"
              ? "laptop"
              : "monitor";

        return `
        <div data-testid="fleet-device-row" data-device-id="${deviceId}" class="bg-slate-950/60 border ${isCurrentActive ? "border-emerald-500/60 ring-1 ring-emerald-500/30" : "border-slate-800 hover:border-slate-700"} rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3 transition-all">
          <div class="flex items-center gap-3 flex-1 min-w-0">
            <div class="w-9 h-9 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center flex-shrink-0">
              <i data-lucide="${iconName}" class="w-4.5 h-4.5 text-slate-400"></i>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h4 class="text-sm font-bold text-white truncate">${device.deviceName || deviceId}</h4>
                ${
                  isCurrentActive
                    ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">Active</span>`
                    : isArchived
                      ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">Archived</span>`
                      : ""
                }
                ${
                  hasIncompleteSpecs
                    ? `<span data-testid="device-incomplete-specs-warning" class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30 flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> Incomplete Specs</span>`
                    : ""
                }
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400 flex-1 min-w-0">
            <span class="flex items-center gap-1.5" title="${device.cpuModel || "N/A"}">
              <i data-lucide="cpu" class="w-3.5 h-3.5 text-slate-500"></i>
              <span class="text-slate-300 font-semibold truncate max-w-[160px]">${device.cpuModel || "N/A"}</span>
            </span>
            <span class="flex items-center gap-1.5" title="${device.gpuModel || "N/A"}">
              <i data-lucide="monitor" class="w-3.5 h-3.5 text-slate-500"></i>
              <span class="text-slate-300 font-semibold truncate max-w-[160px]">${device.gpuModel || "N/A"}${device.vramGb != null ? ` (${device.vramGb}GB)` : ""}</span>
            </span>
            <span class="flex items-center gap-1.5">
              <i data-lucide="memory-stick" class="w-3.5 h-3.5 text-slate-500"></i>
              <span class="text-slate-300 font-semibold">${device.ramGb != null ? device.ramGb + " GB RAM" : "N/A"}</span>
            </span>
            <span class="flex items-center gap-1.5">
              <i data-lucide="hard-drive" class="w-3.5 h-3.5 text-slate-500"></i>
              <span class="text-slate-300 font-semibold">${device.storageFreeGb != null ? device.storageFreeGb + " GB free" : "N/A"}</span>
            </span>
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            ${
              isArchived
                ? `<button onclick="restoreDevice('${deviceId}')" class="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600 hover:text-white text-xs font-semibold transition-all flex items-center gap-1">
                    <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>
                    Restore
                  </button>`
                : `
                  ${
                    !isCurrentActive
                      ? `<button onclick="setActiveDevice('${deviceId}', '${devNameEscaped}')" title="Set Active" class="p-1.5 rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600 hover:text-white text-xs font-semibold transition-all flex items-center">
                          <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>
                        </button>`
                      : ""
                  }
                  <button onclick="editDevice('${deviceId}')" title="Edit Specs" class="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white text-xs font-semibold transition-all flex items-center">
                    <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
                  </button>
                  <button onclick="archiveDevice('${deviceId}')" title="Archive" class="p-1.5 rounded-lg bg-amber-600/20 text-amber-400 hover:bg-amber-600 hover:text-white text-xs font-semibold transition-all flex items-center">
                    <i data-lucide="archive" class="w-3.5 h-3.5"></i>
                  </button>
                  <button data-testid="btn-delete-device" onclick="deleteDevice('${deviceId}')" title="Delete Device" class="p-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white text-xs font-semibold transition-all flex items-center">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                  </button>
                `
            }
          </div>
        </div>
      `;
      })
      .join("");

    if (window.lucide) window.lucide.createIcons();
  }

  // =========================================================================
  // Nexus Mods Hub & Tracker Engine
  // =========================================================================
  let currentModsTab = "trending";
  let selectedGameDomain = "cyberpunk2077";
  // Step 7: approved multi-site provider filter for the mods hub.
  let currentModsProvider = "All";

  function applyModsProviderFilter(modsList) {
    if (currentModsProvider === "All") return modsList;
    const needle = currentModsProvider.toLowerCase();
    return modsList.filter((m) => String(m.provider || "").toLowerCase() === needle);
  }

  // Sprint 7 (WUD-7.4): approved mod provider home links. Static, code-embedded
  // HTTPS constants, validated through safeProviderHomeUrl() (strict host
  // whitelist + GitHub-root-only) as a defense-in-depth guard before render.
  const MOD_PROVIDER_HOME_LINKS = [
    { name: "Nexus Mods", domain: "nexusmods.com", url: "https://www.nexusmods.com/" },
    { name: "ModDB", domain: "moddb.com", url: "https://www.moddb.com/" },
    { name: "CurseForge", domain: "curseforge.com", url: "https://www.curseforge.com/" },
    { name: "GitHub", domain: "github.com", url: "https://github.com/" },
    { name: "Modrinth", domain: "modrinth.com", url: "https://modrinth.com/" },
  ];
  function renderModProviderLinks() {
    const container = document.getElementById("mods-provider-links");
    if (!container) return;
    container.innerHTML = MOD_PROVIDER_HOME_LINKS.map((p) => {
      const safe = safeProviderHomeUrl(p.url);
      if (!safe) return "";
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer" data-mod-provider-home="${p.domain}" title="Open ${p.name} in a new tab" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 hover:border-amber-500/50 text-slate-200 text-[11px] font-bold transition-all"><i data-lucide="external-link" class="w-3 h-3 text-amber-400"></i>${p.name}</a>`;
    }).join("");
    if (window.lucide) window.lucide.createIcons();
  }

  function initModsHub() {
    const domainSelect = document.getElementById("mods-game-domain-select");
    const searchInput = document.getElementById("mods-search-input");
    const searchBtn = document.getElementById("btn-mods-search");
    const tabTrending = document.getElementById("tab-mods-trending");
    const tabInstalled = document.getElementById("tab-mods-installed");

    if (domainSelect) {
      domainSelect.addEventListener("change", (e) => {
        selectedGameDomain = e.target.value;
        loadModsData();
      });
    }

    if (searchBtn && searchInput) {
      searchBtn.addEventListener("click", () => {
        const query = searchInput.value.trim();
        if (query) {
          fetchSearchedMods(query);
        } else {
          loadModsData();
        }
      });
    }

    if (tabTrending) {
      tabTrending.addEventListener("click", () => {
        currentModsTab = "trending";
        updateModsTabStyles();
        loadModsData();
      });
    }

    if (tabInstalled) {
      tabInstalled.addEventListener("click", () => {
        currentModsTab = "installed";
        updateModsTabStyles();
        loadModsData();
      });
    }

    // Multi-site provider filter buttons (Step 7).
    document.querySelectorAll("[data-mod-provider]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentModsProvider = btn.getAttribute("data-mod-provider") || "All";
        updateModsTabStyles();
        loadModsData();
      });
    });

    loadModsData();
    // Sprint 7 (WUD-7.4): render the approved provider home links + disclaimer.
    renderModProviderLinks();
    // EPIC-06 (Mods Frontend Prep): render the client-side mock compatibility
    // tags panel (preview until the P1 backend ingest gates are cleared).
    renderMockModCompatTags(document.getElementById("mods-compat-tags-list"));
  }

  function updateModsTabStyles() {
    const tabTrending = document.getElementById("tab-mods-trending");
    const tabInstalled = document.getElementById("tab-mods-installed");
    const activeClass =
      "px-4 py-2 rounded-xl bg-amber-600 text-white font-bold text-xs shadow-md shadow-amber-600/20 transition-all flex items-center gap-2";
    const inactiveClass =
      "px-4 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 font-bold text-xs transition-all flex items-center gap-2";

    if (tabTrending) {
      tabTrending.className = currentModsTab === "trending" ? activeClass : inactiveClass;
    }
    if (tabInstalled) {
      tabInstalled.className = currentModsTab === "installed" ? activeClass : inactiveClass;
    }

    // Provider filter button active state.
    document.querySelectorAll("[data-mod-provider]").forEach((btn) => {
      const active = btn.getAttribute("data-mod-provider") === currentModsProvider;
      btn.className = `mods-provider-btn px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${active ? "bg-amber-600/90 text-white border-amber-500" : "bg-slate-900 text-slate-400 border-slate-700 hover:text-white hover:border-amber-500/50"}`;
    });
  }

  async function loadModsData() {
    if (currentModsTab === "trending") {
      fetchTrendingMods();
    } else {
      fetchInstalledMods();
    }
    checkModsAggregationStatus();
    // Sprint 4 (EPICUX04): let the Mods Hub 2.0 module (public/mods.js) sync
    // the Load Order Manager + conflict badges to the active tab/domain.
    if (window.syncModsHubForTab && typeof window.syncModsHubForTab === "function") {
      window.syncModsHubForTab(currentModsTab, selectedGameDomain);
    }
  }

  // Sprint 6.1 (GAP-003): surface a warning toast when the mods aggregation
  // job has stalled >24h (logged by src/jobs/mod-aggregation.ts).
  async function checkModsAggregationStatus() {
    try {
      const res = await apiFetch("/api/mods/aggregation/status");
      const data = await res.json();
      if (data && data.stalled) {
        showToast(data.message || "⚠️ Mods aggregation stalled >24h.", true);
      }
    } catch (err) {
      // Non-critical — never block the mods tab on this check.
    }
  }

  async function fetchTrendingMods() {
    const listContainer = document.getElementById("mods-list-container");
    if (!listContainer) return;

    listContainer.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500 mb-2"></div>
        <p class="text-sm font-medium">Fetching trending mods for ${selectedGameDomain}...</p>
      </div>
    `;

    try {
      const res = await apiFetch(
        `/api/mods/trending?game=${encodeURIComponent(selectedGameDomain)}`,
      );
      const data = await res.json();

      let modsList =
        window.safeArray && Array.isArray(data.mods)
          ? window.safeArray(data.mods)
          : Array.isArray(data)
            ? data
            : [];
      modsList = applyModsProviderFilter(modsList);

      if (modsList.length === 0) {
        listContainer.innerHTML = `
          <div class="col-span-full text-center py-12 text-slate-500">
            <p class="text-sm font-medium">No ${currentModsProvider === "All" ? "trending" : currentModsProvider} mods found for ${selectedGameDomain}.</p>
          </div>
        `;
        return;
      }

      renderModsList(modsList, false);
    } catch (err) {
      console.error("Error fetching trending mods:", err);
      listContainer.innerHTML = `
        <div class="col-span-full text-center py-12 text-rose-400">
          <p class="text-sm">Failed to retrieve trending mods.</p>
        </div>
      `;
    }
  }

  async function fetchSearchedMods(query) {
    const listContainer = document.getElementById("mods-list-container");
    if (!listContainer) return;

    listContainer.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500 mb-2"></div>
        <p class="text-sm font-medium">Searching mods for "${query}"...</p>
      </div>
    `;

    try {
      const res = await apiFetch(
        `/api/mods/search?q=${encodeURIComponent(query)}&game=${encodeURIComponent(selectedGameDomain)}`,
      );
      const data = await res.json();

      let modsList =
        window.safeArray && Array.isArray(data.mods)
          ? window.safeArray(data.mods)
          : Array.isArray(data)
            ? data
            : [];
      modsList = applyModsProviderFilter(modsList);

      if (modsList.length === 0) {
        listContainer.innerHTML = `
          <div class="col-span-full text-center py-12 text-slate-500">
            <p class="text-sm font-medium">No ${currentModsProvider === "All" ? "" : currentModsProvider + " "}mods found matching "${query}".</p>
          </div>
        `;
        return;
      }

      renderModsList(modsList, false);
    } catch (err) {
      console.error("Error searching mods:", err);
      listContainer.innerHTML = `
        <div class="col-span-full text-center py-12 text-rose-400">
          <p class="text-sm">Failed to search mods.</p>
        </div>
      `;
    }
  }

  async function fetchInstalledMods() {
    const listContainer = document.getElementById("mods-list-container");
    if (!listContainer) return;

    listContainer.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500 mb-2"></div>
        <p class="text-sm font-medium">Loading installed mods tracker...</p>
      </div>
    `;

    try {
      const res = await apiFetch(
        `/api/mods/installed?gameDomain=${encodeURIComponent(selectedGameDomain)}`,
      );
      const data = await res.json();

      const modsList =
        window.safeArray && Array.isArray(data.installedMods)
          ? window.safeArray(data.installedMods)
          : Array.isArray(data.mods)
            ? data.mods
            : Array.isArray(data)
              ? data
              : [];

      if (modsList.length === 0) {
        listContainer.innerHTML = `
          <div class="col-span-full text-center py-12 text-slate-500">
            <p class="text-sm font-medium">No tracked/installed mods for ${selectedGameDomain}.</p>
          </div>
        `;
        return;
      }

      renderModsList(modsList, true);
    } catch (err) {
      console.error("Error fetching installed mods:", err);
      listContainer.innerHTML = `
        <div class="col-span-full text-center py-12 text-rose-400">
          <p class="text-sm">Failed to load installed mods.</p>
        </div>
      `;
    }
  }

  function renderModsList(mods, isInstalledTab) {
    const listContainer = document.getElementById("mods-list-container");
    if (!listContainer) return;

    listContainer.innerHTML = mods
      .map((mod) => {
        const modId = mod.modId || mod.id;
        const modName = mod.modName || mod.name || "Mod #" + modId;
        const category = mod.category || "General";
        const downloads =
          mod.downloads != null && isFinite(Number(mod.downloads)) && Number(mod.downloads) >= 0
            ? Number(mod.downloads).toLocaleString()
            : "N/A";
        const version = mod.version || "1.0.0";
        const summary = mod.summary || "No description provided.";
        const provider = mod.provider || mod.sourceDomain || "Nexus Mods";
        const safeUrl = safeModUrl(mod.sourceUrl);
        const providerBadge =
          provider && provider !== "Nexus Mods"
            ? `<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[9px] font-bold" title="Provider">${provider}</span>`
            : "";
        const sourceLink = safeUrl
          ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 hover:text-amber-300 hover:underline"><i data-lucide="external-link" class="w-3 h-3"></i> View Mod</a>`
          : "";
        const isTracked = isInstalledTab || mod.installed;

        return `
        <div class="mod-card relative bg-slate-950/80 border border-slate-800 hover:border-amber-500/40 rounded-2xl p-5 flex flex-col justify-between space-y-4 shadow-xl transition-all group" data-mod-id="${modId}" data-game-domain="${selectedGameDomain}">
          <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 flex-wrap">
                <span class="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-bold uppercase tracking-wider">${category}</span>
                ${providerBadge}
              </span>
              <span class="text-xs text-slate-400 font-semibold flex items-center gap-1"><i data-lucide="download" class="w-3.5 h-3.5 text-amber-400"></i> ${downloads}</span>
            </div>
            <h4 class="font-extrabold text-white text-base group-hover:text-amber-400 transition-colors truncate" title="${modName}">${modName}</h4>
            <p class="text-xs text-slate-400 leading-relaxed line-clamp-2">${summary}</p>
          </div>

          <div class="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
            <span class="flex items-center gap-2">
              <span class="text-[11px] text-slate-500 font-bold">v${version}</span>
              ${sourceLink}
            </span>
            <span class="flex items-center gap-1.5">
              <button data-mod-details="${modId}" data-game-domain="${selectedGameDomain}" data-mod-name="${modName.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" class="mod-details-btn px-2.5 py-1.5 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900 text-slate-300 hover:text-white hover:border-amber-500/50 transition-all flex items-center gap-1.5" title="View full details, changelog and dependency tree">Details</button>
              <button data-mod-id="${modId}" data-mod-name="${modName.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" data-version="${version}" class="toggle-mod-btn px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${isTracked ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-500/30" : "bg-amber-600 hover:bg-amber-500 text-white shadow-md shadow-amber-600/20"}">
                <i data-lucide="${isTracked ? "check-circle" : "plus"}" class="w-3.5 h-3.5"></i>
                <span>${isTracked ? "Tracked" : "Track Mod"}</span>
              </button>
            </span>
          </div>
        </div>
      `;
      })
      .join("");

    if (window.lucide) window.lucide.createIcons();

    // Attach tracking toggle event listeners
    listContainer.querySelectorAll(".toggle-mod-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const modId = parseInt(btn.getAttribute("data-mod-id"), 10);
        const modName = btn.getAttribute("data-mod-name");
        const version = btn.getAttribute("data-version");

        try {
          const res = await fetch("/api/mods/installed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              modId,
              gameDomain: selectedGameDomain,
              modName,
              version,
            }),
          });
          const data = await res.json();
          if (data.success) {
            showToast(data.installed ? `Tracked "${modName}"` : `Untracked "${modName}"`);
            loadModsData();
          } else {
            showToast("Failed to update mod tracker", true);
          }
        } catch (err) {
          console.error("Mod toggle error:", err);
          showToast("Error toggling mod tracker", true);
        }
      });
    });

    // Sprint 4 (EPICUX04): surface automated file-level conflict warnings as
    // inline badges on the rendered cards (backed by /api/mods/conflicts).
    if (window.refreshModConflictBadges && typeof window.refreshModConflictBadges === "function") {
      window.refreshModConflictBadges(selectedGameDomain);
    }
  }

  // =========================================================================
  // EPIC-06 (Compare Section Reorganization / Mods Frontend Prep): client-side
  // community mod listings + compatibility tags surface. These MOCK stubs stand
  // in for the P1 backend ingest until the Security/Legal gates clear. Preview
  // data only — never persisted to the server.
  // =========================================================================
  const MOCK_COMPAT_TAGS = [
    "Safe",
    "Full File Access",
    "Sandboxed/Hook",
    "Locked/Anti-Cheat",
    "Requires Script Extender",
    "Performance Heavy",
  ];
  const MOCK_MOD_LISTINGS = [
    {
      id: 1,
      name: "HD Texture Pack",
      author: "community_artist",
      category: "Visuals",
      version: "2.1",
      downloads: 1240000,
      compatTags: ["Safe", "Full File Access"],
    },
    {
      id: 2,
      name: "Quality of Life UI Overhaul",
      author: "interface_crew",
      category: "UI",
      version: "1.8",
      downloads: 842000,
      compatTags: ["Safe", "Full File Access"],
    },
    {
      id: 3,
      name: "FPS Unlocker & Widescreen Fix",
      author: "performance_labs",
      category: "Performance",
      version: "3.0",
      downloads: 510000,
      compatTags: ["Sandboxed/Hook", "Performance Heavy"],
    },
    {
      id: 4,
      name: "Hardcore Survival Rebalance",
      author: "difficulty_team",
      category: "Gameplay",
      version: "1.4",
      downloads: 267000,
      compatTags: ["Requires Script Extender"],
    },
    {
      id: 5,
      name: "Ray Tracing Enhancer",
      author: "graphics_labs",
      category: "Visuals",
      version: "0.9",
      downloads: 98000,
      compatTags: ["Performance Heavy", "Sandboxed/Hook"],
    },
  ];

  function buildMockModListingCard(mod) {
    return `
      <div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2" data-mod-listing>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs font-bold text-white truncate">${mod.name}</p>
            <p class="text-[10px] text-slate-400">by ${mod.author} · ${mod.category} · v${mod.version}</p>
          </div>
          <span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[9px] font-bold whitespace-nowrap">${Number(mod.downloads).toLocaleString()} DL</span>
        </div>
        <div class="flex flex-wrap gap-1">
          ${mod.compatTags.map((tag) => `<span class="px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/25 text-[9px] font-bold">${tag}</span>`).join("")}
        </div>
      </div>
    `;
  }

  function renderMockModCompatTags(container) {
    if (!container) return;
    container.innerHTML = MOCK_COMPAT_TAGS.map(
      (tag) =>
        `<span class="px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 text-[10px] font-semibold border border-slate-700">${tag}</span>`,
    ).join("");
  }

  function openModsDrawer(gameTitle, gameId) {
    const drawer = document.getElementById("mods-drawer");
    if (!drawer) return;
    const gameEl = document.getElementById("mods-drawer-game");
    if (gameEl) gameEl.textContent = gameTitle || gameId || "Game";
    renderMockModCompatTags(document.getElementById("mods-drawer-compat"));
    const listEl = document.getElementById("mods-drawer-list");
    if (listEl) {
      listEl.innerHTML = MOCK_MOD_LISTINGS.length
        ? MOCK_MOD_LISTINGS.map(buildMockModListingCard).join("")
        : '<p class="text-xs text-slate-500">No community mod listings in the preview dataset.</p>';
    }
    // Sprint 6 (PI-GTM-2026-001 WCAG 2.4.3): preserve the triggering element so
    // keyboard focus returns there on close.
    if (typeof window.saveFocus === "function") window.saveFocus();
    drawer.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Trap Tab navigation within the open dialog (WCAG 2.1.2 / 2.4.3).
    drawer.addEventListener("keydown", modsDrawerKeydownHandler);
    const closeBtn = document.getElementById("mods-drawer-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeModsDrawer() {
    const drawer = document.getElementById("mods-drawer");
    if (!drawer) return;
    drawer.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    drawer.removeEventListener("keydown", modsDrawerKeydownHandler);
    // Return keyboard focus to the element that opened the drawer.
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  }

  function modsDrawerKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") {
      window.trapFocus(document.getElementById("mods-drawer"), e);
    }
  }

  window.openModsDrawer = openModsDrawer;
  window.closeModsDrawer = closeModsDrawer;

  // Wire the mods drawer chrome + delegated library-card opener.
  const modsDrawerCloseBtn = document.getElementById("mods-drawer-close");
  if (modsDrawerCloseBtn) {
    modsDrawerCloseBtn.addEventListener("click", closeModsDrawer);
  }
  const modsDrawerBackdrop = document.getElementById("mods-drawer-backdrop");
  if (modsDrawerBackdrop) {
    modsDrawerBackdrop.addEventListener("click", closeModsDrawer);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const drawer = document.getElementById("mods-drawer");
    if (drawer && !drawer.classList.contains("hidden")) closeModsDrawer();
  });
  document.addEventListener("click", (e) => {
    const badge = e.target.closest('[data-card-action="open-mods-drawer"]');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    openModsDrawer(badge.getAttribute("data-game-title"), badge.getAttribute("data-game-id"));
  });

  window.fetchComparison = function (ids) {
    const idsToFetch =
      ids ||
      (window.selectedCompareIds && window.selectedCompareIds.length
        ? window.selectedCompareIds
        : selectedCompareIds);
    return fetchComparison(idsToFetch);
  };
  window.applyDifferenceHighlights =
    typeof applyDifferenceHighlights !== "undefined" ? applyDifferenceHighlights : undefined;
  window.loadPlayabilityMatrix =
    typeof loadPlayabilityMatrix !== "undefined" ? loadPlayabilityMatrix : undefined;
  window.setActiveDevice = function (id, name) {
    localStorage.setItem("activeDeviceId", id);
    currentDeviceId = id;
    if (deviceBadge) {
      deviceBadge.textContent = name || id;
      deviceBadge.className =
        "px-3 py-1 bg-green-900 text-green-300 text-xs font-semibold rounded-full";
    }
    fetchPlayableGames(id, currentTierFilter);
    showToast(`Active device set to ${name || id}`);
    fetchDeviceFleet(currentFleetStatus);
  };

  // WUD-SPRINT-3: Fleet Device Management Modal & REST API CRUD Integration
  window.openFleetModal = function (device = null) {
    const modal = document.getElementById("fleet-add-modal");
    if (!modal) return;
    // Save the currently focused element so focus can be restored on close.
    if (typeof window.saveFocus === "function") window.saveFocus();
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Trap Tab/Shift+Tab focus within the modal while it is open.
    modal.addEventListener("keydown", fleetModalKeydownHandler);
    // Close on Escape (Section 508 / WCAG 2.1 AA dialog semantics).
    document.addEventListener("keydown", fleetModalEscapeHandler);
    const titleEl = document.getElementById("fleet-modal-title");
    const idInput = document.getElementById("fleet-add-id");
    const devIdInput = document.getElementById("fleet-device-id");
    const devNameInput = document.getElementById("fleet-device-name");
    const devTypeInput = document.getElementById("fleet-device-type");
    const devPortableInput = document.getElementById("fleet-device-portable");
    const devCpuInput = document.getElementById("fleet-device-cpu");
    const devCoresInput = document.getElementById("fleet-device-cores");
    const devGpuInput = document.getElementById("fleet-device-gpu");
    const devVramInput = document.getElementById("fleet-device-vram");
    const devRamInput = document.getElementById("fleet-device-ram");
    const devGpuTypeInput = document.getElementById("fleet-device-gputype");
    const devStorageTypeInput = document.getElementById("fleet-device-storagetype");
    const devStorageFreeInput = document.getElementById("fleet-device-storagefree");

    if (device) {
      if (titleEl) titleEl.textContent = "Edit Device Profile";
      if (idInput) idInput.value = device.id || "";
      if (devIdInput) {
        devIdInput.value = device.deviceId || device.id || "";
        devIdInput.disabled = true;
      }
      if (devNameInput) devNameInput.value = device.deviceName || "";
      if (devTypeInput) devTypeInput.value = device.deviceType || "desktop";
      if (devPortableInput) devPortableInput.checked = Boolean(device.isPortable);
      if (devCpuInput) devCpuInput.value = device.cpuModel || "";
      if (devCoresInput) devCoresInput.value = device.cpuCores ?? "";
      if (devGpuInput) devGpuInput.value = device.gpuModel || "";
      if (devVramInput) devVramInput.value = device.vramGb ?? "";
      if (devRamInput) devRamInput.value = device.ramGb ?? "";
      if (devGpuTypeInput) devGpuTypeInput.value = device.gpuType || "dedicated";
      if (devStorageTypeInput) devStorageTypeInput.value = device.storageType || "SSD";
      if (devStorageFreeInput)
        devStorageFreeInput.value = device.storageCapacityGb ?? device.storageFreeGb ?? "";
    } else {
      if (titleEl) titleEl.textContent = "Add Device Profile";
      if (idInput) idInput.value = "";
      if (devIdInput) {
        devIdInput.value = "";
        devIdInput.disabled = false;
      }
      if (devNameInput) devNameInput.value = "";
      if (devTypeInput) devTypeInput.value = "desktop";
      if (devPortableInput) devPortableInput.checked = false;
      if (devCpuInput) devCpuInput.value = "";
      if (devCoresInput) devCoresInput.value = "";
      if (devGpuInput) devGpuInput.value = "";
      if (devVramInput) devVramInput.value = "";
      if (devRamInput) devRamInput.value = "";
      if (devGpuTypeInput) devGpuTypeInput.value = "dedicated";
      if (devStorageTypeInput) devStorageTypeInput.value = "SSD";
      if (devStorageFreeInput) devStorageFreeInput.value = "";
    }
    modal.classList.remove("hidden");
    requestAnimationFrame(() => {
      const nameInput = document.getElementById("fleet-device-name");
      if (nameInput && typeof nameInput.focus === "function") nameInput.focus();
    });
  };

  // Trap Tab/Shift+Tab focus within the fleet modal while it is open.
  function fleetModalKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") {
      window.trapFocus(document.getElementById("fleet-add-modal"), e);
    }
  }

  // Close the fleet modal when Escape is pressed and return focus to the
  // element that opened it.
  function fleetModalEscapeHandler(e) {
    if (e.key !== "Escape") return;
    const modal = document.getElementById("fleet-add-modal");
    if (modal && !modal.classList.contains("hidden")) {
      e.preventDefault();
      window.closeFleetModal();
    }
  }

  window.closeFleetModal = function () {
    const modal = document.getElementById("fleet-add-modal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    modal.removeEventListener("keydown", fleetModalKeydownHandler);
    document.removeEventListener("keydown", fleetModalEscapeHandler);
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  };

  window.editDevice = function (deviceId) {
    // Look up the full device object from the last-fetched fleet cache so
    // editing preserves ALL fields (deviceType, cpuCores, gpuType,
    // storageType, storageFreeGb, isPortable), not just a lossy subset.
    const device = currentFleetDevices.find((d) => (d.id || d.deviceId) === deviceId);
    if (!device) {
      showToast("Unable to load device profile for editing.", true);
      return;
    }
    openFleetModal(device);
  };

  window.deleteDevice = async function (id) {
    if (!confirm(`Are you sure you want to delete device ${id}?`)) return;
    try {
      const res = await apiFetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        showToast("Device profile removed");
        fetchDeviceFleet(currentFleetStatus);
      } else {
        showToast(data.error || "Failed to delete device", true);
      }
    } catch (err) {
      console.error("Error deleting device:", err);
      showToast("Error deleting device profile", true);
    }
  };

  window.archiveDevice = async function (id) {
    try {
      const res = await apiFetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: true }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("Device archived");
        fetchDeviceFleet(currentFleetStatus);
      } else {
        alert(data.error || "Failed to archive device");
      }
    } catch (err) {
      console.error("Error archiving device:", err);
      alert("Error archiving device");
    }
  };

  window.restoreDevice = async function (id) {
    try {
      const res = await apiFetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: false }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("Device restored");
        fetchDeviceFleet(currentFleetStatus);
      } else {
        alert(data.error || "Failed to restore device");
      }
    } catch (err) {
      console.error("Error restoring device:", err);
      alert("Error restoring device");
    }
  };

  // Wire Fleet Modal Event Listeners
  const btnAddDevice = document.getElementById("btn-add-device");
  if (btnAddDevice) {
    btnAddDevice.addEventListener("click", () => openFleetModal());
  }
  const btnFleetModalCancel = document.getElementById("btn-fleet-modal-cancel");
  if (btnFleetModalCancel) {
    btnFleetModalCancel.addEventListener("click", () => closeFleetModal());
  }
  const btnFleetModalClose = document.getElementById("btn-fleet-modal-close");
  if (btnFleetModalClose) {
    btnFleetModalClose.addEventListener("click", () => closeFleetModal());
  }

  const fleetAddForm = document.getElementById("fleet-add-form");
  if (fleetAddForm) {
    fleetAddForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const dbId = document.getElementById("fleet-add-id")?.value;
      const deviceId = document.getElementById("fleet-device-id")?.value.trim();
      const deviceName = document.getElementById("fleet-device-name")?.value.trim();
      const deviceType = document.getElementById("fleet-device-type")?.value;
      const isPortable = document.getElementById("fleet-device-portable")?.checked;
      const cpuModel = document.getElementById("fleet-device-cpu")?.value.trim();
      const cpuCores = parseInt(document.getElementById("fleet-device-cores")?.value, 10) || null;
      const gpuModel = document.getElementById("fleet-device-gpu")?.value.trim();
      const vramGb = parseFloat(document.getElementById("fleet-device-vram")?.value) || null;
      const ramGb = parseFloat(document.getElementById("fleet-device-ram")?.value) || null;
      const gpuType = document.getElementById("fleet-device-gputype")?.value;
      const storageType = document.getElementById("fleet-device-storagetype")?.value;
      const storageFreeGb =
        parseFloat(document.getElementById("fleet-device-storagefree")?.value) || null;

      const payload = {
        deviceId,
        deviceName,
        deviceType,
        isPortable,
        cpuModel,
        cpuCores,
        gpuModel,
        vramGb,
        ramGb,
        gpuType,
        storageType,
        storageFreeGb,
      };

      try {
        let res;
        if (dbId) {
          res = await apiFetch(`/api/devices/${encodeURIComponent(dbId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } else {
          res = await apiFetch("/api/devices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        }
        const data = await res.json();
        // fleet.ts POST / and PATCH /:id both return { device: {...} } on
        // success with NO "success" field, so gate on res.ok + data.device.
        if (res.ok && data.device) {
          showToast(dbId ? "Device profile updated" : "Device profile created");
          closeFleetModal();
          fetchDeviceFleet(currentFleetStatus);
        } else {
          showToast(data.error || "Failed to save device profile", true);
        }
      } catch (err) {
        console.error("Error saving device profile:", err);
        showToast("Error saving device profile", true);
      }
    });
  }

  // =========================================================================
  // Platform Intelligence Hub
  // =========================================================================
  let currentPlatform = "playstation";
  let cachedPlatformGames = [];
  let currentPlatformSort = "title-asc";

  const platformSortSelect = document.getElementById("platform-sort-select");
  if (platformSortSelect) {
    platformSortSelect.addEventListener("change", (e) => {
      currentPlatformSort = e.target.value;
      renderPlatformGames(cachedPlatformGames);
    });
  }

  async function fetchPlatformSummary(_platform) {
    const gamesGridEl = document.getElementById("platform-games-grid");

    if (gamesGridEl)
      gamesGridEl.innerHTML =
        '<div class="col-span-full flex flex-col items-center justify-center py-8 text-slate-500"><div class="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500 mb-2"></div><p class="text-xs font-medium">Loading owned games...</p></div>';

    try {
      const res = await apiFetch(
        `${API_BASE}/api/devices/playability?deviceId=${encodeURIComponent(currentDeviceId)}`,
      );

      if (!res.ok) {
        console.error("Playability fetch error:", res.status, res.statusText);
      }

      if (res.ok) {
        const data = await res.json();
        playabilityMatrixData = data;
        renderPlayableGames();
      } else {
        const fallbackId = await resolveFallbackDevice();
        if (fallbackId && fallbackId !== currentDeviceId) {
          return fetchPlayableGames(fallbackId, currentTierFilter, true);
        }
        if (gamesGridEl) {
          gamesGridEl.innerHTML = `
            <div class="col-span-full text-center py-12 text-slate-400">
              <p class="text-sm">No games in library match filter.</p>
            </div>
          `;
        }
      }
    } catch (err) {
      console.error("Error fetching playability matrix:", err);
      const fallbackId = await resolveFallbackDevice();
      if (fallbackId && fallbackId !== currentDeviceId) {
        return fetchPlayableGames(fallbackId, currentTierFilter, true);
      }
      if (gamesGridEl) {
        gamesGridEl.innerHTML = `
          <div class="col-span-full text-center py-12 text-slate-400">
            <p class="text-sm">No games in library match filter.</p>
          </div>
        `;
      }
    }
  }

  function renderPlatformGames(games) {
    const container = document.getElementById("platform-games-grid");
    if (!container) return;

    if (!games || !games.length) {
      container.innerHTML =
        '<div class="col-span-full text-center py-8 text-slate-500 text-xs">No owned games found for this platform.</div>';
      return;
    }

    const sorted = [...games].sort((a, b) => {
      switch (currentPlatformSort) {
        case "title-desc":
          return (b.title || "").localeCompare(a.title || "");
        case "playtime-desc":
          return (b.hoursPlayed || 0) - (a.hoursPlayed || 0);
        case "playtime-asc":
          return (a.hoursPlayed || 0) - (b.hoursPlayed || 0);
        case "rating-desc":
          return (
            (b.reviewScore || b.criticScore || b.personalRating || 0) -
            (a.reviewScore || a.criticScore || a.personalRating || 0)
          );
        case "lastplayed-desc":
          return (
            new Date(b.lastPlayedDate || 0).getTime() - new Date(a.lastPlayedDate || 0).getTime()
          );
        case "title-asc":
        default:
          return (a.title || "").localeCompare(b.title || "");
      }
    });

    container.innerHTML = sorted.map((g) => createPlatformGameCardHtml(g)).join("");

    if (window.lucide) window.lucide.createIcons();
  }

  function createPlatformGameCardHtml(g) {
    const statusColor =
      g.playStatus && /completed|finished|100%/i.test(g.playStatus)
        ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
        : g.playStatus && /playing|in progress/i.test(g.playStatus)
          ? "text-amber-400 bg-amber-500/10 border border-amber-500/20"
          : "text-slate-400 bg-slate-800/60 border border-slate-700/60";
    const gameId = g.id || g.gameID || g.gameId || "";

    let storeUrl = g.storeUrl || null;
    if (!storeUrl && g.platformStoreUrls && typeof g.platformStoreUrls === "object") {
      storeUrl = Object.values(g.platformStoreUrls)[0] || null;
    }

    const storeBtn = storeUrl
      ? `<a href="${storeUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();" class="inline-flex items-center gap-1 bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white text-[10px] font-bold py-1 px-2 rounded-lg transition-colors border border-brand-500/30">
          <i data-lucide="external-link" class="w-3 h-3"></i>
          <span>Store</span>
        </a>`
      : "";

    return `
      <a href="#/game/${gameId}" class="game-card cursor-pointer bg-slate-950/60 border border-slate-800 hover:border-brand-500/40 rounded-xl overflow-hidden transition-all group flex flex-col justify-between block no-underline" data-game-id="${gameId}" data-game-title="${g.title}">
        <div>
          <div class="aspect-[3/4] bg-slate-900 relative flex items-center justify-center">
            ${
              g.coverUrl
                ? `<img src="${g.coverUrl}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2\\'>${g.title}</div>';" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="${g.title}" />`
                : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2">${g.title}</div>`
            }
            <span class="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-bold ${statusColor}">${g.playStatus || "Not Started"}</span>
          </div>
          <div class="p-2.5 space-y-1.5">
            <h4 class="text-[11px] font-bold text-white truncate group-hover:text-brand-400 transition-colors" title="${g.title}">${g.title}</h4>
            <div class="flex items-center justify-between text-[10px] text-slate-400">
              <span>${(g.hoursPlayed || 0).toFixed(1)}h</span>
              ${g.trophyDifficulty ? `<span class="text-amber-400/80">${g.trophyDifficulty}</span>` : ""}
            </div>
          </div>
        </div>
        ${storeBtn ? `<div class="p-2 pt-0">${storeBtn}</div>` : ""}
      </a>
    `;
  }

  function updatePlatformTabStyles() {
    const tabBtns = document.querySelectorAll(".platform-tab-btn");
    tabBtns.forEach((btn) => {
      if (btn.getAttribute("data-platform") === currentPlatform) {
        btn.className =
          "platform-tab-btn active px-3 py-1.5 rounded-lg bg-brand-600 text-white transition-all whitespace-nowrap flex items-center gap-1.5";
      } else {
        btn.className =
          "platform-tab-btn px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-all whitespace-nowrap flex items-center gap-1.5";
      }
    });
  }

  const platformTabsContainer = document.getElementById("platform-tabs");
  if (platformTabsContainer) {
    platformTabsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".platform-tab-btn");
      if (btn) {
        const platform = btn.getAttribute("data-platform");
        if (platform && platform !== currentPlatform) {
          currentPlatform = platform;
          updatePlatformTabStyles();
          fetchPlatformSummary(platform);
        }
      }
    });
  }

  // =========================================================================
  // Game Library Hub
  // =========================================================================
  let currentTagFilter = "";

  // EPIC-UX-LIBRARY-0001: multi-faceted library filtering state.
  // Platform facets are normalized against ownership platform labels. "legacy"
  // catches any owned platform outside the primary storefront set (EA App,
  // Battle.net, Itch.io, Nintendo, GOG Galaxy variants, etc.).
  const LIBRARY_PLATFORM_CONFIG = [
    { slug: "steam", label: "Steam" },
    { slug: "epic", label: "Epic Games" },
    { slug: "gog", label: "GOG" },
    { slug: "playstation", label: "PlayStation" },
    { slug: "xbox", label: "Xbox" },
    { slug: "ubisoft", label: "Ubisoft" },
    { slug: "amazon", label: "Amazon Games" },
    { slug: "legacy", label: "Legacy" },
  ];
  let librarySearchTerm = "";
  let librarySelectedPlatforms = new Set();
  let librarySelectedGenres = new Set();
  let libraryTagFilter = "";
  let libraryMinScore = 0;
  let libraryModsOnly = false;
  let libraryHiddenGemsOnly = false;
  let librarySort = "score-desc";
  let libraryDebounceTimer = null;
  // EPIC-03 (Paginated Browsing): client-side page state. Pagination slices the
  // already filtered + sorted library so facet/sort state is never clobbered.
  // Sprint 7 (WUD-7.2): the page size is the global "Library tab configuration"
  // — persisted to localStorage (mgpl_library_page_size) so the Device
  // Playability Matrix count syncs with the exact same value.
  const LIBRARY_PAGE_SIZE_KEY = "mgpl_library_page_size";
  const LIBRARY_PAGE_SIZES = [12, 24, 48];
  function readLibraryPageSize() {
    try {
      const n = Number(localStorage.getItem(LIBRARY_PAGE_SIZE_KEY));
      return LIBRARY_PAGE_SIZES.includes(n) ? n : 24;
    } catch (err) {
      return 24;
    }
  }
  let libraryPage = 1;
  let libraryPageSize = readLibraryPageSize();
  // EPIC-UX-LIBRARY-0002: independent review thresholds, play status & flags.
  let librarySteamMinScore = 0;
  let libraryOpenCriticMinScore = 0;
  let libraryPlayStatusFilter = "all";
  let libraryFavoriteOnly = false;
  let libraryBacklogOnly = false;
  // EPIC-01 (Multi-Genre Filtering Engine): dual-mode tile-grid / list view.
  // Persists across pagination and facet changes because it only changes how
  // the already-filtered page slice is rendered (never the slice itself).
  // EPIC-02 (Dual-Mode Tile View Enhancements): the active view mode is also
  // persisted to localStorage (mgpl_library_view_mode) so the preference
  // survives browser sessions. Unknown/legacy values collapse to "grid".
  const LIBRARY_VIEW_MODE_KEY = "mgpl_library_view_mode";
  function readLibraryViewMode() {
    try {
      const stored = localStorage.getItem(LIBRARY_VIEW_MODE_KEY);
      return stored === "list" || stored === "grid" ? stored : "grid";
    } catch (err) {
      return "grid";
    }
  }
  let libraryViewMode = readLibraryViewMode();

  // Render the Smart Binders tag pill bar. Each pill carries data-tag-name so
  // both the UI toggle and E2E assertions can address it deterministically.
  // The tag summary payload already includes { tagName, count, colorHex }.
  async function renderSmartBinders() {
    const container = document.getElementById("library-smart-binders");
    if (!container) return;
    try {
      const res = await apiFetch("/api/tags/summary");
      const data = await res.json();
      if (!data.success || !Array.isArray(data.tags) || data.tags.length === 0) {
        container.innerHTML = "";
        return;
      }

      const pillsHtml = data.tags
        .map((t) => {
          const tagName = String(t.tagName || "").trim();
          const colorHex = t.colorHex || "#38bdf8";
          if (!tagName) return "";
          const isSelected = currentTagFilter === tagName;
          const activeClass = isSelected ? "ring-2 ring-brand-500 font-bold" : "hover:bg-slate-800";
          const bgStyle = isSelected
            ? `style="background-color: ${colorHex}33; border-color: ${colorHex}; color: ${colorHex};"`
            : `style="border-color: ${colorHex}44; color: ${colorHex};"`;

          return `
          <button type="button" data-tag-name="${tagName.replace(/"/g, "\u0026quot;")}" aria-pressed="${isSelected}" class="smart-binder-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-all active:scale-95 bg-slate-900/60 ${activeClass}" ${bgStyle}>
            <span>${tagName}</span>
            <span class="px-1.5 py-0.5 rounded-full text-[10px] font-black ${isSelected ? "bg-white/20 text-white" : "bg-slate-800/80 text-slate-300"}">${Number(t.count) || 0}</span>
          </button>
        `;
        })
        .filter(Boolean)
        .join("");

      container.innerHTML = `
        <div class="flex flex-wrap items-center gap-2 pb-2 mb-3">
          <span class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
            <i data-lucide="bookmarks" class="w-3.5 h-3.5 text-brand-400"></i> Smart Binders:
          </span>
          ${
            currentTagFilter
              ? `<button id="clear-tag-filter-btn" class="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition-all flex items-center gap-1">
                   <span>Clear Tag Filter (${currentTagFilter})</span>
                   <i data-lucide="x" class="w-3 h-3"></i>
                 </button>`
              : ""
          }
          ${pillsHtml}
        </div>
      `;

      if (window.lucide) window.lucide.createIcons();

      container.querySelectorAll(".smart-binder-pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          const tagName = pill.getAttribute("data-tag-name");
          if (currentTagFilter === tagName) {
            currentTagFilter = "";
          } else {
            currentTagFilter = tagName;
          }
          // Keep both smart-binder and toolbar tag-facet state in sync.
          libraryTagFilter = currentTagFilter;
          renderSmartBinders();
          renderLibraryToolbar();
          scheduleLibraryFilterApply();
        });
      });

      const clearBtn = document.getElementById("clear-tag-filter-btn");
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          currentTagFilter = "";
          libraryTagFilter = "";
          renderSmartBinders();
          renderLibraryToolbar();
          scheduleLibraryFilterApply();
        });
      }
    } catch (err) {
      console.error("Failed to render smart binders:", err);
    }
  }

  window.renderSmartBinders = renderSmartBinders;

  // Normalize a platform label (DB ownership value or platformStoreUrls key)
  // into a facet slug (steam / epic / gog / playstation / xbox / ubisoft /
  // amazon / legacy). Exact-match governance: raw labels are matched on
  // word-boundary tokens rather than bare substrings so a platform can never
  // cross-group into a different facet (e.g. "epic" never matches inside an
  // unrelated word). The filter pipeline then compares the normalized slugs
  // via exact Set membership — never a loose game.platforms.includes check.
  // Unknown values collapse to "legacy" so the facet group stays exhaustive
  // without guessing.
  function libraryPlatformSlugFor(label) {
    const name = String(label || "").toLowerCase();
    if (!name) return "legacy";
    const word = (token) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(name);
    if (word("steam") || name === "steamdeck") return "steam";
    if (word("epic") || name === "epicgames") return "epic";
    if (word("gog")) return "gog";
    if (word("playstation") || word("ps4") || word("ps5") || word("psn")) return "playstation";
    if (word("xbox")) return "xbox";
    if (word("ubisoft")) return "ubisoft";
    if (word("amazon")) return "amazon";
    return "legacy";
  }

  // Collect every owned platform slug for a game (deduplicated).
  function libraryGamePlatformSlugs(g) {
    const platforms = Array.isArray(g.platforms) ? g.platforms : [];
    const labels = [];
    for (const p of platforms) {
      const label = typeof p === "string" ? p : p.platform || p.Platform || p.name || "";
      if (label) labels.push(label);
    }
    if (g.platformStoreUrls && typeof g.platformStoreUrls === "object") {
      labels.push(...Object.keys(g.platformStoreUrls));
    }
    const slugs = new Set(labels.map(libraryPlatformSlugFor));
    return [...slugs];
  }

  // Render the wrapped multi-select platform facet badge group with game count
  // pills + the "All Platforms" reset facet. Counts are pulled from the full
  // owned library (all filters combined) so totals stay truthful.
  function renderLibraryPlatformFacets() {
    const container = document.getElementById("library-platform-facets");
    if (!container) return;

    const counts = {};
    for (const g of libraryAllGames) {
      for (const slug of libraryGamePlatformSlugs(g)) {
        counts[slug] = (counts[slug] || 0) + 1;
      }
    }

    const allActive = librarySelectedPlatforms.size === 0;
    const allBtn = `
      <button type="button" data-platform-facet="all" class="library-facet-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 ${
        allActive
          ? "bg-brand-600 text-white border-brand-500 shadow-md shadow-brand-600/20"
          : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700 hover:text-white"
      }">
        <i data-lucide="layers" class="w-3.5 h-3.5"></i>
        <span>All Platforms</span>
        <span class="px-1.5 py-0.5 rounded-full text-[10px] font-black ${
          allActive ? "bg-white/20 text-white" : "bg-slate-700 text-slate-200"
        }">${libraryAllGames.length}</span>
      </button>
    `;

    const facetBtns = LIBRARY_PLATFORM_CONFIG.map((cfg) => {
      const count = counts[cfg.slug] || 0;
      const active = librarySelectedPlatforms.has(cfg.slug);
      return `
        <button type="button" data-platform-facet="${cfg.slug}" class="library-facet-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 ${
          active
            ? "bg-brand-600 text-white border-brand-500 shadow-md shadow-brand-600/20"
            : "bg-slate-900 text-slate-300 border-slate-700 hover:border-brand-500/50 hover:text-white"
        }">
          <i data-lucide="${cfg.slug === "steam" ? "cloud" : cfg.slug === "epic" ? "layers" : cfg.slug === "gog" ? "package" : cfg.slug === "playstation" ? "disc" : cfg.slug === "xbox" ? "box" : cfg.slug === "ubisoft" ? "shield" : cfg.slug === "amazon" ? "shopping-cart" : "archive"}" class="w-3.5 h-3.5"></i>
          <span>${cfg.label}</span>
          <span class="px-1.5 py-0.5 rounded-full text-[10px] font-black ${
            active ? "bg-white/20 text-white" : "bg-slate-800 text-slate-300"
          }">${count}</span>
        </button>
      `;
    }).join("");

    container.innerHTML = allBtn + facetBtns;
    if (window.lucide) window.lucide.createIcons();

    container.querySelectorAll("[data-platform-facet]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-platform-facet");
        if (slug === "all") {
          librarySelectedPlatforms.clear();
        } else if (librarySelectedPlatforms.has(slug)) {
          librarySelectedPlatforms.delete(slug);
        } else {
          librarySelectedPlatforms.add(slug);
        }
        scheduleLibraryFilterApply();
        renderLibraryPlatformFacets();
      });
    });
  }

  // Rebuild the genre dropdown + tag dropdown + review-score slider labels
  // from the full owned library, preserving current selections.
  function renderLibraryToolbar() {
    const genreFacetsEl = document.getElementById("library-genre-facets");
    const genreDropdownLabel = document.getElementById("library-genre-dropdown-label");
    if (genreFacetsEl || genreDropdownLabel) {
      const genreCounts = {};
      for (const g of libraryAllGames) {
        const genres =
          Array.isArray(g.genres) && g.genres.length
            ? g.genres
            : g.primaryGenre || g.genre
              ? [g.primaryGenre || g.genre]
              : [];
        for (const gr of genres) {
          const key = String(gr || "").trim();
          if (key) genreCounts[key] = (genreCounts[key] || 0) + 1;
        }
      }
      const sortedGenres = Object.entries(genreCounts).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );

      // Multi-select genre checkbox dropdown: each genre renders as a row of
      // <input type="checkbox"> inside #library-genre-dropdown. Selections
      // combine via intersection (librarySelectedGenres) exactly as before.
      if (genreFacetsEl) {
        genreFacetsEl.innerHTML =
          sortedGenres
            .map(([name, count]) => {
              const active = librarySelectedGenres.has(name);
              return `<label class="library-genre-option flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-800 cursor-pointer transition-colors ${active ? "bg-brand-500/10" : ""}">
              <input type="checkbox" data-genre-facet="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" ${active ? "checked" : ""} class="accent-brand-500 w-3.5 h-3.5 shrink-0" />
              <span class="text-xs ${active ? "text-brand-300 font-semibold" : "text-slate-200"}">${name}</span>
              <span class="ml-auto text-[10px] text-slate-500 font-bold">${count}</span>
            </label>`;
            })
            .join("") || '<p class="text-xs text-slate-500 px-2 py-1.5">No genres available.</p>';
      }

      // Dropdown trigger label reflects the current selection summary.
      if (genreDropdownLabel) {
        if (librarySelectedGenres.size === 0) {
          genreDropdownLabel.textContent = "All Genres";
        } else if (librarySelectedGenres.size === 1) {
          genreDropdownLabel.textContent = [...librarySelectedGenres][0];
        } else {
          genreDropdownLabel.textContent = `${librarySelectedGenres.size} Genres`;
        }
      }
    }
    const tagSelect = document.getElementById("library-tag-select");
    if (tagSelect) {
      const tagCounts = {};
      for (const g of libraryAllGames) {
        for (const t of Array.isArray(g.tags) ? g.tags : []) {
          const name = typeof t === "string" ? t : t.tagName || t.tag_name || "";
          if (name) tagCounts[name] = (tagCounts[name] || 0) + 1;
        }
      }
      const sortedTags = Object.entries(tagCounts).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      tagSelect.innerHTML = [
        `<option value="">All Custom Tags</option>`,
        ...sortedTags.map(
          ([name, count]) =>
            `<option value="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" ${libraryTagFilter === name ? "selected" : ""}>${name} (${count})</option>`,
        ),
      ].join("");
    }

    const scoreOutput = document.getElementById("library-score-output");
    const scoreSlider = document.getElementById("library-score-slider");
    if (scoreOutput) {
      scoreOutput.textContent = libraryMinScore > 0 ? `${libraryMinScore}%+` : "Any";
    }
    if (scoreSlider) scoreSlider.value = libraryMinScore;

    const modsToggle = document.getElementById("library-mods-toggle");
    if (modsToggle) modsToggle.checked = libraryModsOnly;

    const gemsToggle = document.getElementById("library-hidden-gems-toggle");
    if (gemsToggle) gemsToggle.checked = libraryHiddenGemsOnly;

    const sortSelect = document.getElementById("library-sort-select");
    if (sortSelect) sortSelect.value = librarySort;

    // EPIC-UX-LIBRARY-0002: independent Steam / OpenCritic min-score selects.
    const scoreOptions = [0, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
    const steamScoreSelect = document.getElementById("library-steam-score-select");
    if (steamScoreSelect) {
      steamScoreSelect.innerHTML = scoreOptions
        .map(
          (v) =>
            `<option value="${v}" ${librarySteamMinScore === v ? "selected" : ""}>${v === 0 ? "Any" : v + "%+"}</option>`,
        )
        .join("");
    }
    const openCriticScoreSelect = document.getElementById("library-opencritic-score-select");
    if (openCriticScoreSelect) {
      openCriticScoreSelect.innerHTML = scoreOptions
        .map(
          (v) =>
            `<option value="${v}" ${libraryOpenCriticMinScore === v ? "selected" : ""}>${v === 0 ? "Any" : v + "%+"}</option>`,
        )
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
    renderLibraryViewToggle();
  }

  function renderLibraryResultCount() {
    const el = document.getElementById("library-result-count");
    if (!el) return;
    const filtered = applyLibraryFilters(libraryAllGames);
    el.textContent = `${filtered.length} of ${libraryAllGames.length} games`;
  }

  // EPIC-01 (Multi-Genre Filtering Engine): sync the Grid/List dual-mode toggle
  // buttons (aria-pressed + active styling) after any re-render so the pressed
  // state always matches libraryViewMode.
  function renderLibraryViewToggle() {
    const buttons = document.querySelectorAll(".library-view-btn[data-view-mode]");
    buttons.forEach((btn) => {
      const mode = btn.getAttribute("data-view-mode");
      const active = mode === libraryViewMode;
      btn.setAttribute("aria-pressed", String(active));
      btn.classList.toggle("bg-brand-600", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("bg-slate-800", !active);
      btn.classList.toggle("text-slate-300", !active);
    });
  }

  // Debounced re-render: debounces text search and instant-apply toggles into a
  // single queue so typing never blocks the UI thread (Explicit Action Rule
  // does not apply — these filters run over already-fetched local data).
  function scheduleLibraryFilterApply() {
    if (libraryDebounceTimer) clearTimeout(libraryDebounceTimer);
    libraryDebounceTimer = setTimeout(() => {
      libraryDebounceTimer = null;
      // EPIC-03: any filter/sort change restarts browsing at page 1 so the
      // active facet never strands the user on an out-of-range page.
      libraryPage = 1;
      renderLibraryGames(applyLibraryFilters(libraryAllGames));
    }, 120);
  }

  // Pure filter pipeline over the full owned library.
  function applyLibraryFilters(games) {
    let out = games.slice();

    if (currentTagFilter) {
      const want = currentTagFilter.toLowerCase();
      out = out.filter((g) => {
        const tags = Array.isArray(g.tags) ? g.tags : [];
        return tags.some((t) => {
          const name = typeof t === "string" ? t : t.tagName || t.tag_name || "";
          return String(name).toLowerCase() === want;
        });
      });
    }

    if (libraryTagFilter) {
      const want = libraryTagFilter.toLowerCase();
      out = out.filter((g) => {
        const tags = Array.isArray(g.tags) ? g.tags : [];
        return tags.some((t) => {
          const name = typeof t === "string" ? t : t.tagName || t.tag_name || "";
          return String(name).toLowerCase() === want;
        });
      });
    }

    // Exact-match platform isolation: every owned platform label is normalized
    // once (libraryPlatformSlugFor) into a facet slug, then compared via exact
    // Set membership — never a loose substring check against the raw title or
    // platform string. Selecting "Steam" therefore surfaces only games whose
    // normalized ownership set contains the "steam" slug, with no cross-grouping.
    if (librarySelectedPlatforms.size > 0) {
      out = out.filter((g) => {
        const slugs = new Set(libraryGamePlatformSlugs(g));
        return [...librarySelectedPlatforms].some((slug) => slugs.has(slug));
      });
    }

    if (librarySelectedGenres.size > 0) {
      const wanted = [...librarySelectedGenres].map((x) => String(x).toLowerCase());
      out = out.filter((g) => {
        const genres =
          Array.isArray(g.genres) && g.genres.length
            ? g.genres.map((x) => String(x).toLowerCase())
            : g.primaryGenre || g.genre
              ? [String(g.primaryGenre || g.genre).toLowerCase()]
              : [];
        // EPIC-01 (Multi-Genre Filtering Engine): multi-select genres narrow
        // (intersection) — every selected genre must be present, matching the
        // backend `?genre=a,b` all-mode default. A single selection behaves
        // exactly as before (zero regression for single-genre filters).
        return wanted.every((w) => genres.includes(w));
      });
    }

    // EPIC-UX-LIBRARY-0002: independent Steam Score and OpenCritic minimums.
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
          const name = typeof t === "string" ? t : t.tagName || t.tag_name || "";
          return /^favorite$/i.test(String(name).trim());
        });
      });
    }

    if (libraryBacklogOnly) {
      out = out.filter((g) => {
        const tags = Array.isArray(g.tags) ? g.tags : [];
        return tags.some((t) => {
          const name = typeof t === "string" ? t : t.tagName || t.tag_name || "";
          return /^backlog$/i.test(String(name).trim());
        });
      });
    }

    if (libraryModsOnly) {
      out = out.filter((g) => {
        const modCount = Number(g.nexusModCount || 0);
        return Boolean(g.nexusUrl || g.nexusModsUrl) || modCount > 0;
      });
    }

    if (libraryHiddenGemsOnly) {
      const keywords = [
        "indie",
        "roguelike",
        "roguelite",
        "metroidvania",
        "platformer",
        "soulslike",
        "deckbuilder",
        "visual novel",
        "puzzle",
        "strategy",
        "simulation",
        "sandbox",
        "survival",
        "tower defense",
        "tower defence",
        "dungeon crawler",
        "bullet hell",
        "rhythm",
      ];
      out = out.filter((g) => {
        const score = Number(g.compositeScore ?? g.steamScore ?? g.openCriticScore ?? 0);
        if (!Number.isFinite(score) || score < 80) return false;
        const genres =
          Array.isArray(g.genres) && g.genres.length
            ? g.genres.map((x) => String(x).toLowerCase())
            : g.primaryGenre || g.genre
              ? [String(g.primaryGenre || g.genre).toLowerCase()]
              : [];
        return genres.some((gr) => keywords.some((kw) => gr.includes(kw)));
      });
    }

    if (librarySearchTerm) {
      const q = librarySearchTerm.toLowerCase();
      out = out.filter((g) => {
        const title = String(g.title || g.gameTitle || "");
        const genre = String(g.primaryGenre || g.genre || "");
        const genres = Array.isArray(g.genres) ? g.genres.join(" ") : "";
        const tags = Array.isArray(g.tags)
          ? g.tags.map((t) => (typeof t === "string" ? t : t.tagName || t.tag_name || "")).join(" ")
          : "";
        return (title + " " + genre + " " + genres + " " + tags).toLowerCase().includes(q);
      });
    }

    out.sort(librarySortGames);

    return out;
  }

  function librarySortGames(a, b) {
    switch (librarySort) {
      case "hltb-asc":
        return (Number(a.hltbMainHours) || Infinity) - (Number(b.hltbMainHours) || Infinity);
      case "hltb-desc":
        return (Number(b.hltbMainHours) || -Infinity) - (Number(a.hltbMainHours) || -Infinity);
      case "title-asc":
        return String(a.title || "").localeCompare(String(b.title || ""));
      case "title-desc":
        return String(b.title || "").localeCompare(String(a.title || ""));
      case "recently-played":
        return (
          (new Date(String(b.lastPlayedDate || 0)).getTime() || 0) -
          (new Date(String(a.lastPlayedDate || 0)).getTime() || 0)
        );
      case "recently-added":
        return (
          (new Date(String(b.dateAdded || 0)).getTime() || 0) -
          (new Date(String(a.dateAdded || 0)).getTime() || 0)
        );
      case "score-desc":
      default: {
        const sa = Number(a.compositeScore ?? a.steamScore ?? a.openCriticScore ?? -1) || -1;
        const sb = Number(b.compositeScore ?? b.steamScore ?? b.openCriticScore ?? -1) || -1;
        if (sb !== sa) return sb - sa;
        return String(a.title || "").localeCompare(String(b.title || ""));
      }
    }
  }

  async function fetchLibraryGames(filter = "all") {
    if (libraryFetchAbortController) {
      libraryFetchAbortController.abort();
    }
    libraryFetchAbortController = new AbortController();
    const { signal } = libraryFetchAbortController;

    const container = document.getElementById("library-games-grid");
    if (container) {
      container.innerHTML =
        '<div class="col-span-full flex flex-col items-center justify-center py-8 text-slate-500"><div class="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500 mb-2"></div><p class="text-xs font-medium">Loading library...</p></div>';
    }

    try {
      let url = `${API_BASE}/api/games?active=true&owned=true`;
      if (filter && filter !== "all") {
        // Sprint 1 (EPIC-RADAR-0001): "hidden-gems" is a curated discovery
        // filter backed by GET /api/games?filter=hidden-gems, not a platform.
        if (filter === "hidden-gems") {
          url += `&filter=hidden-gems`;
        } else {
          url += `&platform=${encodeURIComponent(filter)}`;
        }
      }
      if (currentTagFilter) {
        url += `&tag=${encodeURIComponent(currentTagFilter)}`;
      }
      const res = await apiFetch(url, { signal });
      const data = await res.json();

      if (data.success && Array.isArray(data.games)) {
        // EPIC-UX-LIBRARY-0001: every library fetch replaces the full owned
        // library held in module state. All filtering/sorting is then applied
        // client-side across the multi-facet toolbar.
        libraryAllGames = data.games;
        renderLibraryPlatformFacets();
        renderLibraryToolbar();
        renderLibraryGames(applyLibraryFilters(libraryAllGames));
      } else {
        if (container)
          container.innerHTML =
            '<div class="col-span-full text-center py-8 text-red-400 text-xs">Failed to load library.</div>';
      }
    } catch (err) {
      if (err.name === "AbortError") {
        return;
      }
      console.error("Failed to fetch library games:", err);
      if (container)
        container.innerHTML =
          '<div class="col-span-full text-center py-8 text-red-400 text-xs">Failed to load library.</div>';
    }
  }

  // Library rendering state (EPIC-03 pagination over the Sprint 34 virtualized
  // renderer): `libraryAllGames` is the full owned source set (replaced on every
  // fetch); `libraryVisibleGames` is the current page slice of the filtered +
  // sorted subset. Pagination caps a page at 48 cards (12/24/48 selectable), so
  // each page renders in a single innerHTML write — no IntersectionObserver
  // sentinel hydration needed (Anti-Stale Input Rule — the DB-backed source
  // list stays authoritative). `LIBRARY_CHUNK_SIZE` remains the page-budget
  // constant exposed through the __library debug hook that legacy perf specs
  // assert against.
  const LIBRARY_CHUNK_SIZE = 24;
  let libraryAllGames = [];
  let libraryVisibleGames = [];
  let libraryRenderedCount = 0;
  let libraryFetchAbortController = null;

  // EPIC-UX-LIBRARY-0001: Rich decision-support card. Cover art with a
  // platform overlay, then title + genre pill + release year, followed by
  // HLTB completion time, review score, mod count and owned platform icons.
  // Clicking anywhere on the card opens the unified game detail drawer.
  function buildLibraryCardHtml(g) {
    const statusColor =
      g.playStatus && /completed|finished|100%/i.test(g.playStatus)
        ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
        : g.playStatus && /playing|in progress/i.test(g.playStatus)
          ? "text-amber-400 bg-amber-500/10 border border-amber-500/20"
          : "text-slate-400 bg-slate-800/60 border border-slate-700/60";
    const gameId = g.id || g.gameId || "";
    const title = String(g.title || g.gameTitle || "Untitled Game");

    // Sprint 7 (WUD-7.1): clean one-line synopsis/overview on library cards.
    // HTML-escaped before it can reach innerHTML; cards degrade gracefully
    // (no line) when the payload has no synopsis yet.
    const synopsisText = String(g.synopsis || "").trim();
    const synopsisLine = synopsisText
      ? `<p class="text-[10px] text-slate-400 leading-snug line-clamp-2 library-card-synopsis" title="${escapeHtml(synopsisText)}">${escapeHtml(synopsisText)}</p>`
      : "";

    // Owned platform labels (deduplicated, capped at 4 for the icon row).
    const platforms = g.platforms || g.ownerships || [];
    const platformLabels = Array.isArray(platforms)
      ? platforms
          .map((p) => (typeof p === "string" ? p : p.platform || p.name || ""))
          .filter(Boolean)
      : [];
    const storeUrlKeys =
      g.platformStoreUrls && typeof g.platformStoreUrls === "object"
        ? Object.keys(g.platformStoreUrls)
        : [];
    const allPlatforms = [...new Set([...platformLabels, ...storeUrlKeys])];

    // Canonical platform label + icon resolver: maps every owned platform key
    // to an explicit, clean identifier (Steam, Epic, GOG, PlayStation, Xbox,
    // Amazon, Legacy) with a distinct non-controller icon so the library card
    // never relies on a generic gamepad glyph.
    const platformVisual = (label) => {
      const key = String(label).toLowerCase();
      let lucideName = "archive";
      let display = String(label);
      if (key.includes("steam")) {
        lucideName = "cloud";
        display = "Steam";
      } else if (key.includes("epic")) {
        lucideName = "layers";
        display = "Epic";
      } else if (key.includes("gog")) {
        lucideName = "package";
        display = "GOG";
      } else if (key.includes("playstation") || key.includes("ps4") || key.includes("ps5")) {
        lucideName = "disc";
        display = "PlayStation";
      } else if (key.includes("xbox")) {
        lucideName = "box";
        display = "Xbox";
      } else if (key.includes("ubisoft")) {
        lucideName = "shield";
        display = "Ubisoft";
      } else if (key.includes("amazon")) {
        lucideName = "shopping-cart";
        display = "Amazon";
      } else if (key.includes("nintendo")) {
        lucideName = "star";
        display = "Nintendo";
      } else if (key.includes("itch")) {
        lucideName = "heart";
        display = "Itch.io";
      } else if (key.includes("battle") || key.includes("blizzard")) {
        lucideName = "sword";
        display = "Battle.net";
      } else if (key.includes("ea ")) {
        lucideName = "zap";
        display = "EA";
      } else if (key.includes("legacy")) {
        lucideName = "archive";
        display = "Legacy";
      }
      return { lucideName, display };
    };

    // Explicit platform identifier badges (icon + label text) for card parity.
    const platformBadges = allPlatforms
      .slice(0, 4)
      .map((p) => {
        const { lucideName, display } = platformVisual(p);
        const label = String(p);
        return `<span title="${label}" data-owned-platform="${label}" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-800/90 border border-slate-700 text-slate-300">
        <i data-lucide="${lucideName}" class="w-3 h-3"></i>
        <span class="text-[9px] font-bold">${display}</span>
      </span>`;
      })
      .join("");

    const primaryPlatform = allPlatforms[0] || "";
    const genre = g.primaryGenre || g.genre || "";
    const releaseYear = g.releaseYear || "";

    // Genre tags: render the full genre array (capped at 3), falling back to
    // the primary genre so grid and list rows share identical metadata parity.
    const genreTags =
      Array.isArray(g.genres) && g.genres.length ? g.genres.slice(0, 3) : genre ? [genre] : [];
    const genreTagsHtml = genreTags
      .map(
        (gr) =>
          `<span data-card-genre="${String(gr).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${String(gr)}</span>`,
      )
      .join("");

    // Playtime badge (hours played) complements the play-status pill.
    const hoursPlayed = Number(g.hoursPlayed ?? g.playtime_forever ?? 0);
    const playtimeBadge =
      hoursPlayed > 0
        ? `<span class="library-card-playtime inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/25 text-[10px] font-bold" title="Hours played">🕹️ ${hoursPlayed >= 100 ? Math.round(hoursPlayed) : hoursPlayed.toFixed(1)}h</span>`
        : "";

    // HLTB completion time badge.
    const hltbMain = Number(g.hltbMainHours);
    const hltbText =
      hltbMain > 0 ? `⏱️ ${Number.isInteger(hltbMain) ? hltbMain : hltbMain.toFixed(1)}h Main` : "";
    const hltbBadge = hltbText
      ? `<span class="library-card-hltb inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-bold">${hltbText}</span>`
      : "";

    // Review score badge (composite > steam > openCritic).
    const reviewScore = Number(g.compositeScore ?? g.steamScore ?? g.openCriticScore ?? 0);
    const scoreBadge =
      Number.isFinite(reviewScore) && reviewScore > 0
        ? `<span class="library-card-score inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/25 text-[10px] font-bold" data-score="${reviewScore}">★ ${Math.round(reviewScore)}</span>`
        : '<span class="library-card-score inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-800/80 text-slate-500 border border-slate-700/60 text-[10px] font-bold" data-score="0">★ —</span>';

    // Mod badge. EPIC-06 (Mods Frontend Prep): the badge is a real button that
    // opens the community mods drawer (mock stub surface) instead of bubbling
    // into the card's game-detail click handler.
    const nexusUrl = g.nexusUrl || g.nexusModsUrl || "";
    const nexusModCount = Number(g.nexusModCount || 0);
    const modsBadge =
      nexusUrl || nexusModCount > 0
        ? `<button type="button" data-card-action="open-mods-drawer" data-game-id="${gameId}" data-game-title="${title}" title="View community mods & compatibility tags" class="library-card-mods inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/25 text-[10px] font-bold hover:bg-amber-500/20 transition-colors duration-200 cursor-pointer"><i data-lucide="package" class="w-3 h-3"></i><span>${nexusModCount > 0 ? `${nexusModCount.toLocaleString()} Mods` : "Mods"}</span></button>`
        : "";

    const gameTags = Array.isArray(g.tags) ? g.tags : [];
    // EPIC-UX-LIBRARY-0002: first-class flag badges + pinned-note snippet.
    const isFavoriteTag = gameTags.some((t) =>
      /^favorite$/i.test(String(typeof t === "string" ? t : t.tagName || t.tag_name || "").trim()),
    );
    const isBacklogTag = gameTags.some((t) =>
      /^backlog$/i.test(String(typeof t === "string" ? t : t.tagName || t.tag_name || "").trim()),
    );
    const pinnedNote = (g.noteMarkdown || "").trim();
    const pinnedSnippet = pinnedNote
      ? `<div class="mt-1.5 px-1.5 py-1 rounded-md bg-brand-500/10 border border-brand-500/20 text-[9px] text-brand-300 font-medium leading-snug library-card-note line-clamp-2"><span class="font-bold">📌</span> ${pinnedNote.replace(/[<>&]/g, (m) => ({ "<": String.fromCharCode(38) + "lt;", ">": String.fromCharCode(38) + "gt;", "&": String.fromCharCode(38) + "amp;" })[m]).slice(0, 140)}</div>`
      : "";
    const tagsHtml = gameTags
      .map((t) => {
        const tagName = typeof t === "string" ? t : t.tagName || t.tag_name || "";
        const colorHex =
          typeof t === "object" && (t.colorHex || t.color_hex)
            ? t.colorHex || t.color_hex
            : "#38bdf8";
        if (!tagName) return "";
        return `<span class="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold border" style="background-color: ${colorHex}15; color: ${colorHex}; border-color: ${colorHex}30;">${tagName}</span>`;
      })
      .filter(Boolean)
      .join(" ");

    // EPIC-01 (Multi-Genre Filtering Engine): detailed horizontal list-mode
    // card. Two-tier row — the top row keeps the flex items-center gap-3
    // contract (thumbnail, title, dev/publisher, platform badge, status,
    // composite score, Details CTA) while the lower strip surfaces the full
    // metadata parity set (uncapped genres, custom tags, split Steam /
    // OpenCritic scores, playtime, HLTB, active mod count, owned-platform
    // badges, pinned note). Same data-game-id / title / card-action attributes
    // keep drawer navigation and E2E hooks identical.
    if (libraryViewMode === "list") {
      // Resolved platform badge (icon + canonical label) for the primary
      // ownership, reusing the shared platformVisual() resolver so list rows
      // render a distinct platform glyph instead of a generic gamepad icon.
      const primaryVisual = primaryPlatform ? platformVisual(primaryPlatform) : null;
      const primaryPlatformBadge = primaryVisual
        ? `<span data-card-platform="${String(primaryPlatform)}" title="${String(primaryPlatform)}" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-950/90 border border-slate-700 text-slate-300 text-[9px] font-bold">
            <i data-lucide="${primaryVisual.lucideName}" class="w-3 h-3"></i>${primaryVisual.display}
          </span>`
        : "";

      // Sprint 7 (WUD-7.1): eliminate double platform tag injection in list
      // mode. The primary platform already renders in the top meta row via
      // primaryPlatformBadge — the lower strip must NOT repeat it, so it only
      // surfaces the remaining secondary owned platforms (data-owned-platform
      // hooks preserved for E2E parity).
      const secondaryPlatforms = allPlatforms.slice(1, 5);
      const secondaryPlatformBadges = secondaryPlatforms
        .map((p) => {
          const { lucideName, display } = platformVisual(p);
          const label = String(p);
          return `<span title="${label}" data-owned-platform="${label}" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-800/90 border border-slate-700 text-slate-300">
          <i data-lucide="${lucideName}" class="w-3 h-3"></i>
          <span class="text-[9px] font-bold">${display}</span>
        </span>`;
        })
        .join("");

      const releaseYearBadge = releaseYear
        ? `<span data-card-release-year class="px-1.5 py-0.5 rounded-md bg-slate-950/90 border border-slate-700 text-slate-300 text-[9px] font-bold">${releaseYear}</span>`
        : "";

      // Developer / Publisher metadata line (DB-enrichment fields, both optional).
      const developerText = String(g.developer || "").trim();
      const publisherText = String(g.publisher || "").trim();
      const devPubLine =
        developerText || publisherText
          ? `<div class="flex flex-wrap items-center gap-x-1 text-[10px] text-slate-400 font-medium min-w-0">
            ${developerText ? `<span data-card-developer class="truncate" title="${developerText}">${developerText}</span>` : ""}
            ${developerText && publisherText ? '<span class="text-slate-600 shrink-0" aria-hidden="true">·</span>' : ""}
            ${publisherText ? `<span data-card-publisher class="truncate" title="${publisherText}">${publisherText}</span>` : ""}
          </div>`
          : "";

      // Full uncapped genre list — list rows show every genre (no 3-chip cap)
      // so the detailed view matches every grid attribute without truncation.
      const listGenres =
        Array.isArray(g.genres) && g.genres.length ? g.genres : genre ? [genre] : [];
      const quoteEsc = String.fromCharCode(92) + String.fromCharCode(34);
      const listGenreTagsHtml = listGenres
        .map(
          (gr) =>
            `<span data-card-genre="${String(gr).replace(/"/g, quoteEsc)}" class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${String(gr)}</span>`,
        )
        .join("");

      // Split Steam / OpenCritic score badges. These use dedicated classes and
      // attribute names (NOT `.library-card-score[data-score]`) so the numeric
      // composite-score sort assertions in library-ux.spec.ts stay unambiguous.
      const steamNum =
        g.steamScore != null && Number.isFinite(Number(g.steamScore))
          ? Math.round(Number(g.steamScore))
          : null;
      const ocNum =
        g.openCriticScore != null && Number.isFinite(Number(g.openCriticScore))
          ? Math.round(Number(g.openCriticScore))
          : null;
      const steamScoreBadge =
        steamNum != null
          ? `<span class="library-card-score-steam inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-bold whitespace-nowrap" data-score-steam="${steamNum}" title="Steam score">Steam ${steamNum}%</span>`
          : "";
      const openCriticScoreBadge =
        ocNum != null
          ? `<span class="library-card-score-oc inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-bold whitespace-nowrap" data-score-opencritic="${ocNum}" title="OpenCritic score">OpenCritic ${ocNum}</span>`
          : "";

      const statusPill = `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold ${statusColor}">${g.playStatus || "Not Started"}</span>`;

      return `
        <div data-card-action="open-drawer" data-game-id="${gameId}" data-game-title="${title}" class="game-card cursor-pointer bg-slate-950/60 border border-slate-800 hover:border-brand-500/40 rounded-xl overflow-hidden transition-all duration-200 group block w-full">
          <div class="flex items-center gap-3 p-3">
            <div class="w-14 h-14 shrink-0 rounded-md bg-slate-900 overflow-hidden relative flex items-center justify-center">
              ${
                g.coverUrl || g.cover_url
                  ? `<img src="${g.coverUrl || g.cover_url}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\\\'w-full h-full bg-slate-900 flex items-center justify-center p-0.5 text-center text-[8px] text-slate-500 font-bold line-clamp-2\\\\'>${title}</div>';" class="w-full h-full object-cover" alt="${title}" />`
                  : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-0.5 text-center text-[8px] text-slate-500 font-bold line-clamp-2">${title}</div>`
              }
            </div>
            <div class="flex-1 min-w-0 space-y-1">
              <h4 class="text-[11px] font-bold text-white truncate group-hover:text-brand-400 transition-colors" title="${title}">${title}</h4>
              ${synopsisLine}
              ${devPubLine}
              <div class="flex flex-wrap items-center gap-1">
                ${primaryPlatformBadge}
                ${releaseYearBadge}
                ${scoreBadge}
                ${statusPill}
              </div>
            </div>
            <div class="shrink-0 flex flex-col items-end gap-1.5">
              ${playtimeBadge}
              <button type="button" data-card-action="open-drawer" data-game-id="${gameId}" data-game-title="${title}" class="library-card-cta inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-bold transition-all duration-200 cursor-pointer">
                <i data-lucide="external-link" class="w-3 h-3"></i> Details
              </button>
            </div>
          </div>
          <div class="px-3 pb-3 space-y-1.5">
            ${listGenreTagsHtml ? `<div class="flex flex-wrap items-center gap-1">${listGenreTagsHtml}</div>` : `<span data-card-genre="${genre.replace(/"/g, String.fromCharCode(38) + "quot;")}" class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${genre}</span>`}
            <div class="flex flex-wrap items-center gap-1">
              ${steamScoreBadge}
              ${openCriticScoreBadge}
              ${modsBadge}
              ${hltbBadge}
            </div>
            ${tagsHtml ? `<div class="flex flex-wrap gap-1">${tagsHtml}</div>` : ""}
            ${secondaryPlatformBadges ? `<div class="flex flex-wrap items-center gap-1">${secondaryPlatformBadges}</div>` : ""}
            ${pinnedSnippet}
          </div>
        </div>
      `;
    }

    return `
        <div data-card-action="open-drawer" data-game-id="${gameId}" data-game-title="${title}" class="game-card cursor-pointer bg-slate-950/60 border border-slate-800 hover:border-brand-500/40 rounded-xl overflow-hidden transition-all duration-200 group block" >
          <div class="aspect-[3/4] bg-slate-900 relative flex items-center justify-center">
            ${
              g.coverUrl || g.cover_url
                ? `<img src="${g.coverUrl || g.cover_url}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2\\'>${title}</div>';" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="${title}" />`
                : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2">${title}</div>`
            }
            <span class="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[9px] font-bold ${statusColor}">${g.playStatus || "Not Started"}</span>
            ${isFavoriteTag ? '<span class="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500 text-slate-950" title="Favorite">★</span>' : ""}
            ${isBacklogTag ? '<span class="absolute top-7 right-2 px-1.5 py-0.5 rounded text-[9px] font-black bg-sky-500 text-slate-950" title="Backlog">📚</span>' : ""}
            ${
              primaryPlatform
                ? `<span class="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-slate-950/90 border border-slate-700 text-slate-300 text-[9px] font-bold" data-card-platform>${primaryPlatform}</span>`
                : ""
            }
            <span class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-md bg-slate-950/90 border border-slate-700 text-slate-300 text-[9px] font-bold">${releaseYear || "—"}</span>
          </div>
          <div class="p-2 space-y-1.5">
            <h4 class="text-[11px] font-bold text-white truncate group-hover:text-brand-400 transition-colors" title="${title}">${title}</h4>
            ${synopsisLine}
            <div class="flex flex-wrap items-center gap-1">
              ${genreTagsHtml || `<span class="px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-300 border border-brand-500/20 text-[10px] font-bold whitespace-nowrap">${genre}</span>`}
              ${hltbBadge}
              ${playtimeBadge}
            </div>
            <div class="flex flex-wrap items-center gap-1">
              ${scoreBadge}
              ${modsBadge}
            </div>
            ${tagsHtml ? `<div class="flex flex-wrap gap-1">${tagsHtml}</div>` : ""}
            ${platformBadges ? `<div class="flex flex-wrap items-center gap-1 pt-0.5">${platformBadges}</div>` : ""}
            ${pinnedSnippet}
          </div>
        </div>
      `;
  }

  // EPIC-UX-LIBRARY-0001: clicking anywhere on a library card opens the game
  // detail drawer (the card's <div> is non-navigating). Keyboard Enter/Space
  // parity keeps the card accessible (Section 508 / WCAG 2.1 AA).
  document.addEventListener("click", (e) => {
    const card = e.target.closest('[data-card-action="open-drawer"]');
    if (!card) return;
    if (e.target.closest("a") || e.target.closest("button")) return;
    e.preventDefault();
    const title = card.getAttribute("data-game-title");
    const gid = card.getAttribute("data-game-id");
    if (title && typeof window.openGameDetailDrawer === "function") {
      window.openGameDetailDrawer(title, gid);
    } else if (gid) {
      window.location.hash = "#/game/" + encodeURIComponent(gid);
    }
  });

  // EPIC-02 (Dual-Mode Tile View Enhancements): the quick-action CTA button in
  // list-mode cards opens the game detail drawer directly. The generic card
  // handler above ignores button clicks, so the CTA carries its own delegated
  // listener (stopPropagation keeps it from also bubbling into card chrome).
  document.addEventListener("click", (e) => {
    const cta = e.target.closest("button.library-card-cta");
    if (!cta) return;
    e.preventDefault();
    e.stopPropagation();
    const title = cta.getAttribute("data-game-title");
    const gid = cta.getAttribute("data-game-id");
    if (title && typeof window.openGameDetailDrawer === "function") {
      window.openGameDetailDrawer(title, gid);
    } else if (gid) {
      window.location.hash = "#/game/" + encodeURIComponent(gid);
    }
  });

  document.addEventListener("keydown", (e) => {
    const card = e.target.closest('[data-card-action="open-drawer"]');
    if (!card) return;
    // The card container is NOT a widget itself (EPIC-06 a11y fix): the Details
    // CTA and mods badge are real buttons that handle their own keyboard
    // activation. Skip them so Enter/Space never double-fires the drawer.
    if (e.target.closest("button") || e.target.closest("a")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const title = card.getAttribute("data-game-title");
      const gid = card.getAttribute("data-game-id");
      if (title && typeof window.openGameDetailDrawer === "function") {
        window.openGameDetailDrawer(title, gid);
      } else if (gid) {
        window.location.hash = "#/game/" + encodeURIComponent(gid);
      }
    }
  });

  function renderLibraryGames(games) {
    const container = document.getElementById("library-games-grid");
    if (!container) return;

    // EPIC-01 (Multi-Genre Filtering Engine): dual-mode layout. Grid keeps the
    // static Tailwind grid classes; list switches the container to a single
    // column flex stack while each card renders its compact row variant. The
    // page slice (filtered + sorted + paginated) is unchanged, so facets and
    // pagination state survive the toggle exactly.
    if (libraryViewMode === "list") {
      container.style.display = "flex";
      container.style.flexDirection = "column";
      container.style.gap = "0.5rem";
    } else {
      container.style.display = "";
      container.style.flexDirection = "";
      container.style.gap = "";
    }

    if (!games.length) {
      container.innerHTML =
        '<div class="col-span-full text-center py-8 text-slate-500 text-xs">No games found in your library for this filter.</div>';
      libraryVisibleGames = [];
      libraryRenderedCount = 0;
      renderLibraryPagination({ page: 1, totalPages: 1, total: 0 });
      return;
    }

    // EPIC-03 (Paginated Browsing): paginate the filtered + sorted subset
    // client-side. The page is clamped into [1, totalPages] so a deep-linked
    // ?page=N or a shrinking result set can never render an empty/out-of-range
    // page. A page holds at most 48 cards, so a single innerHTML write keeps
    // the render deterministic (and the __library debug hook honest).
    const total = games.length;
    const totalPages = Math.max(1, Math.ceil(total / libraryPageSize));
    if (libraryPage > totalPages) libraryPage = totalPages;
    if (libraryPage < 1) libraryPage = 1;
    const pageStart = (libraryPage - 1) * libraryPageSize;
    libraryVisibleGames = games.slice(pageStart, pageStart + libraryPageSize);
    libraryRenderedCount = libraryVisibleGames.length;
    container.innerHTML = libraryVisibleGames.map(buildLibraryCardHtml).join("");
    if (window.lucide) window.lucide.createIcons();
    renderLibraryPagination({ page: libraryPage, totalPages, total });
    syncLibraryPageUrl();
    // Keep the toolbar count + platform facet pills in sync after re-renders.
    renderLibraryPlatformFacets();
    renderLibraryToolbar();
  }

  // Debug hook for deterministic E2E assertions on the virtualized grid.
  window.__library = {
    getState: () => ({
      rendered: libraryRenderedCount,
      total: libraryVisibleGames.length,
      chunkSize: LIBRARY_CHUNK_SIZE,
      // EPIC-03: expose page state so pagination assertions are deterministic.
      page: libraryPage,
      pageSize: libraryPageSize,
      totalGames: libraryAllGames.length,
    }),
  };

  // EPIC-03 (Paginated Browsing): render Previous / Page N of M / Next and the
  // page-size selector into #library-pagination. The label doubles as an ARIA
  // live region (role="status" + aria-live="polite") so page transitions are
  // announced to screen readers.
  function renderLibraryPagination(data) {
    const container = document.getElementById("library-pagination");
    if (!container) return;
    container.classList.remove("hidden");
    const labelEl = document.getElementById("library-pagination-label");
    const prevEl = document.getElementById("library-prev");
    const nextEl = document.getElementById("library-next");
    const sizeEl = document.getElementById("library-page-size");
    if (labelEl) {
      labelEl.textContent = "Page " + data.page + " of " + data.totalPages;
    }
    if (prevEl) prevEl.disabled = data.page <= 1;
    if (nextEl) nextEl.disabled = data.page >= data.totalPages;
    if (sizeEl) sizeEl.value = String(libraryPageSize);
  }

  // EPIC-03 (Paginated Browsing): reflect the active page in the deep-linkable
  // hash (?page=N) without clobbering pre-existing query params (filter /
  // platform) and without pushing duplicate history entries per page turn.
  function syncLibraryPageUrl() {
    const rawHash = window.location.hash.replace(/^#\/?/, "");
    const hashPath = rawHash.split("?")[0] || "library";
    const params = new URLSearchParams(
      rawHash.includes("?") ? rawHash.slice(rawHash.indexOf("?") + 1) : "",
    );
    params.set("page", String(libraryPage));
    const next = "#/" + hashPath + (params.toString() ? "?" + params.toString() : "");
    try {
      if (window.location.hash !== next) {
        window.history.replaceState(null, "", next);
      }
    } catch (e) {
      window.location.hash = next;
    }
  }

  // EPIC-03 (Paginated Browsing): wire the pagination bar. Page turns re-run
  // the filter pipeline over the authoritative full library (libraryAllGames)
  // so facet/sort selections are cleanly preserved, then the ?page=N deep link
  // is synced. Out-of-range turns are clamped inside renderLibraryGames.
  const libraryPrevBtn = document.getElementById("library-prev");
  if (libraryPrevBtn) {
    libraryPrevBtn.addEventListener("click", () => {
      if (libraryPage <= 1) return;
      libraryPage -= 1;
      renderLibraryGames(applyLibraryFilters(libraryAllGames));
    });
  }
  const libraryNextBtn = document.getElementById("library-next");
  if (libraryNextBtn) {
    libraryNextBtn.addEventListener("click", () => {
      libraryPage += 1;
      renderLibraryGames(applyLibraryFilters(libraryAllGames));
    });
  }
  const libraryPageSizeSelect = document.getElementById("library-page-size");
  if (libraryPageSizeSelect) {
    libraryPageSizeSelect.addEventListener("change", (e) => {
      const nextSize = Number(e.target.value);
      if (LIBRARY_PAGE_SIZES.includes(nextSize)) {
        libraryPageSize = nextSize;
        libraryPage = 1;
        // Sprint 7 (WUD-7.2): persist the global Library tab page-size so the
        // Device Playability Matrix stays in sync across sessions/tabs.
        try {
          localStorage.setItem(LIBRARY_PAGE_SIZE_KEY, String(nextSize));
        } catch (err) {
          /* localStorage unavailable */
        }
        renderLibraryGames(applyLibraryFilters(libraryAllGames));
      }
    });
  }

  // EPIC-UX-LIBRARY-0001: wire the multi-facet toolbar controls. Genre and
  // tag selects mutate the active facet sets; the search input debounces; the
  // score slider, mods toggle, hidden-gems toggle and sort dropdown apply
  // immediately. All of these re-render through scheduleLibraryFilterApply.
  const librarySearchInput = document.getElementById("library-search-input");
  if (librarySearchInput) {
    librarySearchInput.addEventListener("input", (e) => {
      librarySearchTerm = e.target.value.trim();
      scheduleLibraryFilterApply();
    });
  }

  // Multi-select genre checkbox dropdown: the trigger toggles the checkbox
  // panel; checkbox changes update librarySelectedGenres (intersection) and
  // re-apply filters. Closes on outside click / Escape.
  const genreDropdownBtn = document.getElementById("library-genre-dropdown-btn");
  const genreDropdown = document.getElementById("library-genre-dropdown");
  if (genreDropdownBtn && genreDropdown) {
    genreDropdownBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = genreDropdown.classList.contains("hidden");
      genreDropdown.classList.toggle("hidden");
      genreDropdownBtn.setAttribute("aria-expanded", String(willOpen));
    });

    document.addEventListener("click", (e) => {
      if (genreDropdown.classList.contains("hidden")) return;
      if (
        e.target.closest("#library-genre-dropdown-btn") ||
        e.target.closest("#library-genre-dropdown")
      )
        return;
      genreDropdown.classList.add("hidden");
      genreDropdownBtn.setAttribute("aria-expanded", "false");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !genreDropdown.classList.contains("hidden")) {
        genreDropdown.classList.add("hidden");
        genreDropdownBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Checkbox change delegation (rows are re-rendered by renderLibraryToolbar).
    genreDropdown.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-genre-facet]");
      if (!cb) return;
      const name = cb.getAttribute("data-genre-facet");
      if (cb.checked) {
        librarySelectedGenres.add(name);
      } else {
        librarySelectedGenres.delete(name);
      }
      renderLibraryToolbar();
      scheduleLibraryFilterApply();
    });

    // Clear all genre selections.
    const genreClearBtn = document.getElementById("library-genre-clear");
    if (genreClearBtn) {
      genreClearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        librarySelectedGenres.clear();
        renderLibraryToolbar();
        scheduleLibraryFilterApply();
      });
    }
  }

  const libraryTagSelect = document.getElementById("library-tag-select");
  if (libraryTagSelect) {
    libraryTagSelect.addEventListener("change", (e) => {
      libraryTagFilter = e.target.value;
      // Keep the smart-binder tag filter in sync with the toolbar facet.
      currentTagFilter = libraryTagFilter;
      scheduleLibraryFilterApply();
    });
  }

  const libraryScoreSlider = document.getElementById("library-score-slider");
  if (libraryScoreSlider) {
    libraryScoreSlider.addEventListener("input", (e) => {
      libraryMinScore = Number(e.target.value) || 0;
      const output = document.getElementById("library-score-output");
      if (output) output.textContent = libraryMinScore > 0 ? `${libraryMinScore}%+` : "Any";
    });
    libraryScoreSlider.addEventListener("change", scheduleLibraryFilterApply);
  }

  const libraryModsToggle = document.getElementById("library-mods-toggle");
  if (libraryModsToggle) {
    libraryModsToggle.addEventListener("change", (e) => {
      libraryModsOnly = e.target.checked;
      scheduleLibraryFilterApply();
    });
  }

  const libraryHiddenGemsToggle = document.getElementById("library-hidden-gems-toggle");
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
  }

  const librarySortSelect = document.getElementById("library-sort-select");
  if (librarySortSelect) {
    librarySortSelect.addEventListener("change", (e) => {
      librarySort = e.target.value;
      scheduleLibraryFilterApply();
    });
  }

  // EPIC-01 (Multi-Genre Filtering Engine): Grid/List dual-mode view toggle.
  // Switching only re-renders the current filtered page slice, so every facet
  // (genre/platform/tag/score) and the pagination state survive the toggle.
  // EPIC-02 (Dual-Mode Tile View Enhancements): the chosen mode is persisted
  // to localStorage so it survives reloads and future browser sessions.
  document.querySelectorAll(".library-view-btn[data-view-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-view-mode");
      if (!mode || mode === libraryViewMode) return;
      libraryViewMode = mode;
      try {
        localStorage.setItem(LIBRARY_VIEW_MODE_KEY, mode);
      } catch (err) {
        /* storage unavailable (private mode) — the in-memory choice still applies */
      }
      renderLibraryGames(applyLibraryFilters(libraryAllGames));
    });
  });

  // =========================================================================
  // Backlog Hub (HLTB Insights & Completion Roadmap) - FEAT-0147
  // =========================================================================
  function formatHours(value) {
    if (value === null || value === undefined || isNaN(Number(value))) return "N/A";
    const n = Number(value);
    return n % 1 === 0 ? `${n}h` : `${n.toFixed(1)}h`;
  }

  function buildBacklogCardHtml(g) {
    const gameId = g.gameId || g.id || "";
    const title = g.title || g.gameTitle || "Untitled Game";
    const coverUrl = g.coverUrl || g.cover_url || "";
    const hltb = g.hltb || {};
    const mainStory = hltb.mainStory;
    const mainExtra = hltb.mainExtra;
    const completionist = hltb.completionist;
    const hoursPlayed = Number(g.hoursPlayed || 0);
    const targetHours = Number(g.targetHours || mainStory || 0);
    const progressPercent = Math.min(
      100,
      Math.max(0, targetHours > 0 ? Math.round((hoursPlayed / targetHours) * 100) : 0),
    );
    const playStatus = g.playStatus || "Not Started";
    const isCompleted = /completed|finished|100%/i.test(playStatus);

    const statusColor = isCompleted
      ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
      : /playing|in progress/i.test(playStatus)
        ? "text-amber-400 bg-amber-500/10 border border-amber-500/20"
        : "text-slate-400 bg-slate-800/60 border border-slate-700/60";

    const barColor = isCompleted
      ? "bg-emerald-500"
      : progressPercent >= 100
        ? "bg-emerald-500"
        : progressPercent >= 50
          ? "bg-amber-500"
          : "bg-brand-500";

    return `
      <div class="bg-slate-950/70 border border-slate-800 hover:border-emerald-500/40 rounded-2xl overflow-hidden transition-all group flex flex-col justify-between shadow-xl" data-game-id="${gameId}">
        <div>
          <div class="aspect-[3/4] bg-slate-900 relative flex items-center justify-center">
            ${
              coverUrl
                ? `<img src="${coverUrl}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2\\'>${title}</div>';" class="w-full h-full object-cover group-hover:scale-105 transition-transform" alt="${title}" />`
                : `<div class="w-full h-full bg-slate-900 flex items-center justify-center p-1 text-center text-[10px] text-slate-500 font-bold line-clamp-2">${title}</div>`
            }
            <span class="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-bold ${statusColor}">${playStatus}</span>
          </div>
          <div class="p-3 space-y-2">
            <h4 class="text-[12px] font-bold text-white truncate group-hover:text-emerald-400 transition-colors" title="${title}">${title}</h4>

            <div class="flex flex-wrap gap-1.5">
              <span class="px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-bold">Main Story ${formatHours(mainStory)}</span>
              <span class="px-2 py-0.5 rounded-lg bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold">Main + Extras ${formatHours(mainExtra)}</span>
              <span class="px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px] font-bold">Completionist ${formatHours(completionist)}</span>
            </div>

            <div>
              <div class="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                <span>${hoursPlayed.toFixed(1)}h logged</span>
                <span class="font-bold ${isCompleted ? "text-emerald-400" : "text-slate-300"}">${progressPercent}%</span>
              </div>
              <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div class="h-full ${barColor} rounded-full transition-all duration-500" style="width:${progressPercent}%"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="p-3 pt-0 space-y-2">
          <button data-game-id="${gameId}" data-title="${title.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" class="backlog-log-btn w-full py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-md shadow-emerald-600/20 flex items-center justify-center gap-1.5">

            <i data-lucide="plus" class="w-3.5 h-3.5"></i>
            <span>Quick Log Hours</span>
          </button>
          <button data-game-id="${gameId}" data-title="${title.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" class="backlog-session-btn w-full py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold transition-all shadow-md shadow-sky-600/20 flex items-center justify-center gap-1.5">
            <i data-lucide="timer" class="w-3.5 h-3.5"></i>
            <span>Start Session</span>
          </button>
        </div>
      </div>
    `;
  }

  async function renderBacklogHub() {
    const grid = document.getElementById("backlog-games-grid");
    if (!grid) return;

    grid.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500 mb-2"></div>
        <p class="text-xs font-medium">Analyzing backlog & HLTB roadmap...</p>
      </div>
    `;

    try {
      const res = await apiFetch("/api/hltb/summary");
      const data = await res.json();

      if (!data.success) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-12 text-rose-400 text-xs font-semibold">Failed to load backlog analytics.</div>';
        return;
      }

      // Update overview banner stats
      const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setText("backlog-total-games", data.totalGames ?? 0);
      setText("backlog-total-main", formatHours(data.totalHoursMain));
      setText("backlog-total-completionist", formatHours(data.totalHoursCompletionist));
      setText("backlog-avg-length", formatHours(data.averageGameLength));
      setText("backlog-completed-count", data.completedCount ?? 0);
      setText("backlog-completion-percent", `${data.completionPercent ?? 0}%`);

      const games = Array.isArray(data.games) ? data.games : [];
      if (games.length === 0) {
        grid.innerHTML =
          '<div class="col-span-full text-center py-12 text-slate-500 text-xs font-medium">No tracked games in your backlog yet.</div>';
        return;
      }

      // Off-DOM assembly: build full HTML string before insertion
      grid.innerHTML = games.map(buildBacklogCardHtml).join("");

      if (window.lucide) window.lucide.createIcons();
    } catch (err) {
      console.error("Error rendering backlog hub:", err);
      grid.innerHTML =
        '<div class="col-span-full text-center py-12 text-rose-400 text-xs font-semibold">Unable to load backlog analytics.</div>';
    }
  }

  async function logBacklogProgress(gameId, hours) {
    try {
      const res = await fetch("/api/hltb/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, hoursPlayed: hours }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Logged ${hours}h for ${data.title || gameId}`);
        renderBacklogHub();
      } else {
        showToast(data.error || "Failed to log progress", true);
      }
    } catch (err) {
      console.error("Error logging backlog progress:", err);
      showToast("Error logging progress", true);
    }
  }

  // Wire up refresh + quick-log buttons (event delegation)
  const backlogRefreshBtn = document.getElementById("backlog-refresh-btn");
  if (backlogRefreshBtn) {
    backlogRefreshBtn.addEventListener("click", () => renderBacklogHub());
  }

  const backlogGridEl = document.getElementById("backlog-games-grid");
  if (backlogGridEl) {
    backlogGridEl.addEventListener("click", (e) => {
      const sessionBtn = e.target.closest(".backlog-session-btn");
      if (sessionBtn) {
        const gameId = sessionBtn.getAttribute("data-game-id");
        const title = sessionBtn.getAttribute("data-title");
        startPlaySession(gameId, title);
        return;
      }

      const btn = e.target.closest(".backlog-log-btn");
      if (!btn) return;
      const gameId = btn.getAttribute("data-game-id");
      const title = btn.getAttribute("data-title");
      const hoursStr = prompt(`Log hours played for "${title}":`, "1");
      if (hoursStr === null) return;
      const hours = parseFloat(hoursStr);
      if (isNaN(hours) || hours < 0) {
        showToast("Please enter a valid number of hours.", true);
        return;
      }
      logBacklogProgress(gameId, hours);
    });
  }

  // Expose hooks for Playwright E2E tests
  window.renderBacklogHub = renderBacklogHub;
  window.logBacklogProgress = logBacklogProgress;

  // =========================================================================
  // Settings Hub (Backup & State Sync) - FEAT-0149
  // =========================================================================
  function setBackupStatus(message, isError = false) {
    const statusEl = document.getElementById("backup-sync-status");
    if (!statusEl) return;
    statusEl.classList.remove("hidden");
    statusEl.className = `text-xs font-semibold rounded-xl border px-4 py-3 ${
      isError
        ? "border-rose-500/30 bg-rose-900/20 text-rose-300"
        : "border-emerald-500/30 bg-emerald-900/20 text-emerald-300"
    }`;
    statusEl.textContent = message;
  }

  async function handleExportBackup() {
    const btn = document.getElementById("btn-export-backup");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Exporting...</span>`;
    }
    try {
      const res = await fetch("/api/state/export");
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Export failed");
      }
      const snapshot = await res.json();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `mgpl-backup-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const counts = snapshot.data || {};
      const total =
        (counts.fleet?.length || 0) +
        (counts.deals?.length || 0) +
        (counts.alerts?.length || 0) +
        (counts.mods?.length || 0) +
        (counts.hltb?.length || 0) +
        (counts.tracking?.length || 0);
      showToast(`Backup exported (${total} records)`);
      setBackupStatus(`Backup exported successfully with ${total} records across all tables.`);
    } catch (err) {
      console.error("Export error:", err);
      showToast(err.message || "Failed to export backup", true);
      setBackupStatus(err.message || "Failed to export backup", true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="download" class="w-4 h-4"></i><span>Export Full Backup</span>`;
        if (window.lucide) window.lucide.createIcons();
      }
    }
  }

  async function handleImportBackup(file) {
    if (!file) return;
    const statusEl = document.getElementById("backup-sync-status");
    try {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (parseErr) {
        showToast("Invalid JSON file. Please select a valid backup.", true);
        setBackupStatus("Invalid JSON file. Please select a valid backup.", true);
        return;
      }

      const res = await fetch("/api/state/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        const msg = data.error || "Import failed";
        showToast(msg, true);
        setBackupStatus(msg, true);
        return;
      }

      const r = data.restored || {};
      const summary = `Fleet: ${r.fleetCount ?? 0} | Deals: ${r.dealsCount ?? 0} | Alerts: ${r.alertsCount ?? 0} | Mods: ${r.modsCount ?? 0} | HLTB: ${r.hltbCount ?? 0}`;
      showToast(`Backup restored successfully (${summary})`);
      setBackupStatus(`Backup restored successfully. ${summary}`);
    } catch (err) {
      console.error("Import error:", err);
      showToast("Failed to import backup", true);
      setBackupStatus("Failed to import backup", true);
    } finally {
      if (statusEl) {
        // Reset the file input so the same file can be re-selected
        const input = document.getElementById("file-import-backup");
        if (input) input.value = "";
      }
    }
  }

  // =========================================================================
  // Data & Backup Management (Snapshot Export / Validate / Restore) - FEAT-0164
  // =========================================================================
  function setSnapshotStatus(message, isError = false) {
    const statusEl = document.getElementById("snapshot-status");
    if (!statusEl) return;
    statusEl.classList.remove("hidden");
    statusEl.className = `text-xs font-semibold rounded-xl border px-4 py-3 ${
      isError
        ? "border-rose-500/30 bg-rose-900/20 text-rose-300"
        : "border-emerald-500/30 bg-emerald-900/20 text-emerald-300"
    }`;
    statusEl.textContent = message;
  }

  function setSnapshotError(message) {
    const errEl = document.getElementById("snapshot-error");
    if (!errEl) return;
    if (message) {
      errEl.classList.remove("hidden");
      errEl.textContent = message;
    } else {
      errEl.classList.add("hidden");
      errEl.textContent = "";
    }
  }

  function hideSnapshotPreview() {
    const preview = document.getElementById("snapshot-restore-preview");
    if (preview) preview.classList.add("hidden");
    const body = document.getElementById("snapshot-summary-body");
    if (body) body.innerHTML = "";
  }

  function renderSnapshotSummary(summary) {
    const body = document.getElementById("snapshot-summary-body");
    if (!body) return;
    body.innerHTML = "";
    const rows = Object.entries(summary || {});
    if (!rows.length) {
      body.innerHTML =
        '<tr><td colspan="2" class="px-4 py-2 text-xs text-slate-400">No records found in snapshot.</td></tr>';
      return;
    }
    rows.forEach(([key, count]) => {
      const tr = document.createElement("tr");
      const label = document.createElement("td");
      label.className = "px-4 py-2 text-xs font-semibold text-slate-300";
      label.textContent = key;
      const value = document.createElement("td");
      value.className = "px-4 py-2 text-xs text-right font-bold text-emerald-300";
      value.textContent = String(count);
      tr.appendChild(label);
      tr.appendChild(value);
      body.appendChild(tr);
    });
  }

  async function handleExportState() {
    const btn = document.getElementById("btn-export-state");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Exporting...</span>`;
    }
    try {
      const res = await fetch("/api/state/export");
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Export failed");
      }
      const snapshot = await res.json();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `mgpl-snapshot-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      // Cache the latest snapshot locally as a fallback point (FEAT-0164).
      if (window.OfflineStorage && window.OfflineStorage.saveSnapshot) {
        window.OfflineStorage.saveSnapshot(snapshot).catch((err) =>
          console.warn("Snapshot cache failed:", err),
        );
      }

      const counts = snapshot.data || {};
      const total = Object.values(counts).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      );
      showToast(`Snapshot exported (${total} records)`);
      setSnapshotStatus(`Snapshot exported successfully with ${total} records across all tables.`);
    } catch (err) {
      console.error("Snapshot export error:", err);
      showToast(err.message || "Failed to export snapshot", true);
      setSnapshotStatus(err.message || "Failed to export snapshot", true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="download" class="w-4 h-4"></i><span>Export Snapshot</span>`;
        if (window.lucide) window.lucide.createIcons();
      }
    }
  }

  async function handleSnapshotFile(file) {
    if (!file) return;
    setSnapshotError("");
    hideSnapshotPreview();
    try {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (parseErr) {
        setSnapshotError("Invalid JSON file. Please select a valid snapshot.");
        setSnapshotStatus("Invalid JSON file. Please select a valid snapshot.", true);
        return;
      }

      const res = await fetch("/api/state/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.valid) {
        const errors = (data.errors || []).join(" ");
        const msg = errors || data.error || "Snapshot validation failed";
        setSnapshotError(msg);
        setSnapshotStatus(msg, true);
        return;
      }

      // Store the validated payload for the confirm step.
      window.__pendingSnapshot = payload;
      renderSnapshotSummary(data.summary || {});
      const preview = document.getElementById("snapshot-restore-preview");
      if (preview) preview.classList.remove("hidden");
      setSnapshotStatus(
        `Snapshot validated (version ${data.version}). Review the summary and confirm to restore.`,
      );
    } catch (err) {
      console.error("Snapshot validation error:", err);
      setSnapshotError("Failed to validate snapshot.");
      setSnapshotStatus("Failed to validate snapshot.", true);
    }
  }

  async function confirmSnapshotRestore() {
    const payload = window.__pendingSnapshot;
    if (!payload) {
      setSnapshotError("No validated snapshot to restore.");
      return;
    }
    const btn = document.getElementById("btn-confirm-restore");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Restoring...";
    }
    try {
      const res = await fetch("/api/state/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const msg = data.error || "Restore failed";
        setSnapshotError(msg);
        setSnapshotStatus(msg, true);
        return;
      }
      const r = data.restored || {};
      const summary = `Fleet: ${r.fleetCount ?? 0} | Deals: ${r.dealsCount ?? 0} | Alerts: ${r.alertsCount ?? 0} | Mods: ${r.modsCount ?? 0} | HLTB: ${r.hltbCount ?? 0}`;
      showToast(`Snapshot restored successfully (${summary})`);
      setSnapshotStatus(`Snapshot restored successfully. ${summary}`);
      hideSnapshotPreview();
      window.__pendingSnapshot = null;
      // Hot rehydrate all views so the UI reflects the restored state.
      rehydrateAllViews();
    } catch (err) {
      console.error("Snapshot restore error:", err);
      setSnapshotError("Failed to restore snapshot.");
      setSnapshotStatus("Failed to restore snapshot.", true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Confirm Restore";
      }
      const input = document.getElementById("snapshot-file-input");
      if (input) input.value = "";
    }
  }

  // Update the notification permission status label in Settings.
  function updateNotificationStatus(permission) {
    const statusEl = document.getElementById("notification-permission-status");
    if (!statusEl) return;
    if (permission === "granted") {
      statusEl.textContent = "✅ Notifications enabled — you'll be alerted on price drops.";
      statusEl.className = "text-xs font-semibold text-emerald-400";
    } else if (permission === "denied") {
      statusEl.textContent = "⛔ Notifications blocked. Enable them in browser settings.";
      statusEl.className = "text-xs font-semibold text-rose-400";
    } else if (permission === "unsupported") {
      statusEl.textContent = "Web notifications are not supported in this browser.";
      statusEl.className = "text-xs font-semibold text-slate-500";
    } else {
      statusEl.textContent = "Notifications not yet enabled.";
      statusEl.className = "text-xs font-semibold text-slate-400";
    }
  }

  // Fire a browser notification for each currently-triggered wishlist alert.
  // Called after a live price sync when new alerts cross their target threshold.
  async function notifyDealAlerts() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const res = await apiFetch("/api/wishlist");
      const data = await res.json();
      const items = data.success && Array.isArray(data.wishlist) ? data.wishlist : [];
      const triggered = items.filter((i) => Number(i.isTriggered) === 1);
      triggered.forEach((item) => {
        const title = item.title || "Game";
        const price = Number(item.currentBestPrice);
        const store = item.bestStore || "Store";
        const body = `🚨 Deal Alert: ${title} is now $${price.toFixed(2)} at ${store}!`;
        try {
          new Notification("MGPL Deal Alert", {
            body,
            icon: item.coverImage || "/manifest.json",
            tag: "deal-alert-" + (item.gameId || title),
          });
        } catch (err) {
          console.warn("Notification failed:", err);
        }
      });
    } catch (err) {
      console.error("Failed to load triggered alerts for notification:", err);
    }
  }
  window.notifyDealAlerts = notifyDealAlerts;

  function initSettingsHub() {
    const exportBtn = document.getElementById("btn-export-backup");

    if (exportBtn && !exportBtn.dataset.wired) {
      exportBtn.dataset.wired = "1";
      exportBtn.addEventListener("click", handleExportBackup);
    }
    const importInput = document.getElementById("file-import-backup");
    if (importInput && !importInput.dataset.wired) {
      importInput.dataset.wired = "1";
      importInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) handleImportBackup(file);
      });
    }

    // --- Data & Backup Management (FEAT-0164) ---
    const exportStateBtn = document.getElementById("btn-export-state");
    if (exportStateBtn && !exportStateBtn.dataset.wired) {
      exportStateBtn.dataset.wired = "1";
      exportStateBtn.addEventListener("click", handleExportState);
    }

    const dropzone = document.getElementById("snapshot-dropzone");
    const fileInput = document.getElementById("snapshot-file-input");
    if (dropzone && !dropzone.dataset.wired) {
      dropzone.dataset.wired = "1";
      dropzone.addEventListener("click", () => {
        if (fileInput) fileInput.click();
      });
      ["dragenter", "dragover"].forEach((evt) => {
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add("border-emerald-500", "bg-emerald-900/20");
        });
      });
      ["dragleave", "drop"].forEach((evt) => {
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove("border-emerald-500", "bg-emerald-900/20");
        });
      });
      dropzone.addEventListener("drop", (e) => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleSnapshotFile(file);
      });
    }
    if (fileInput && !fileInput.dataset.wired) {
      fileInput.dataset.wired = "1";
      fileInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) handleSnapshotFile(file);
      });
    }

    const confirmBtn = document.getElementById("btn-confirm-restore");
    if (confirmBtn && !confirmBtn.dataset.wired) {
      confirmBtn.dataset.wired = "1";
      confirmBtn.addEventListener("click", confirmSnapshotRestore);
    }
    const cancelBtn = document.getElementById("btn-cancel-restore");
    if (cancelBtn && !cancelBtn.dataset.wired) {
      cancelBtn.dataset.wired = "1";
      cancelBtn.addEventListener("click", () => {
        hideSnapshotPreview();
        window.__pendingSnapshot = null;
        setSnapshotError("");
        const input = document.getElementById("snapshot-file-input");
        if (input) input.value = "";
      });
    }

    // --- Deal Alerts & Web Notifications (Sprint 32 / FEAT-0166) ---
    const notifBtn = document.getElementById("btn-enable-notifications");
    if (notifBtn && !notifBtn.dataset.wired) {
      notifBtn.dataset.wired = "1";
      notifBtn.addEventListener("click", async () => {
        if (!("Notification" in window)) {
          showToast("Web notifications are not supported in this browser.", true);
          return;
        }
        try {
          const perm = await Notification.requestPermission();
          updateNotificationStatus(perm);
          if (perm === "granted") {
            showToast("Deal alerts enabled. You'll be notified on price drops.");
          } else {
            showToast("Notifications blocked. Enable them in browser settings.", true);
          }
        } catch (err) {
          console.error("Notification permission error:", err);
          showToast("Failed to request notification permission.", true);
        }
      });
    }
    updateNotificationStatus(
      Notification && "permission" in Notification ? Notification.permission : "unsupported",
    );

    // --- Theme & Appearance (FEAT-0167) ---
    const themeSwitcher = document.getElementById("theme-switcher");
    if (themeSwitcher && !themeSwitcher.dataset.wired) {
      themeSwitcher.dataset.wired = "1";
      themeSwitcher.addEventListener("change", (e) => {
        const value = e.target && e.target.value;
        if (value) setTheme(value);
      });
    }
    // Reflect the persisted theme on the radio group.
    const currentTheme = getTheme();
    const activeRadio = document.querySelector(`input[name="theme"][value="${currentTheme}"]`);
    if (activeRadio) activeRadio.checked = true;
    const themeStatusEl = document.getElementById("theme-status");
    if (themeStatusEl) {
      themeStatusEl.textContent = currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1);
    }

    // --- PWA Install Status (FEAT-0167) ---
    const pwaInstallSettingsBtn = document.getElementById("btn-pwa-install-settings");
    if (pwaInstallSettingsBtn && !pwaInstallSettingsBtn.dataset.wired) {
      pwaInstallSettingsBtn.dataset.wired = "1";
      pwaInstallSettingsBtn.addEventListener("click", handleInstallClick);
    }
    updatePwaInstallStatus();
  }

  // Expose backup export to the global command palette (FEAT-0150).
  window.exportBackupSnapshot = handleExportBackup;

  // =========================================================================
  // Dev Seed Bar (FEAT-0161): full-platform mock seeding for E2E validation
  // =========================================================================
  function rehydrateAllViews() {
    // Clear the lazy-load guard so every route controller re-fetches fresh data.
    loadedRoutes.clear();
    handleRoute();
    // Refresh the persistent wishlist badge count.
    fetchWishlistCount();
  }

  // AI-081 (#160): the Dev Seed Bar exists only when the server says test
  // mode is on. GET /api/mock/status answers 404 outside test mode, so in a
  // production build the bar is never created and its buttons never wired.
  function buildMockSeedBar() {
    const bar = document.createElement("div");
    bar.id = "dev-seed-bar";
    bar.className =
      "fixed bottom-16 left-0 right-0 z-40 md:bottom-4 md:left-auto md:right-4 md:w-auto flex items-center justify-center gap-2 px-3 py-2";
    const seed = document.createElement("button");
    seed.id = "btn-seed-mock";
    seed.type = "button";
    seed.className =
      "btn btn-sm btn-outline inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-all active:scale-95";
    seed.textContent = "🧪 Seed Full Platform Data";
    const clear = document.createElement("button");
    clear.id = "btn-clear-mock";
    clear.type = "button";
    clear.className =
      "btn btn-sm btn-danger inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 text-xs font-bold border border-rose-800/60 transition-all active:scale-95";
    clear.textContent = "🗑️ Reset Data";
    bar.append(seed, clear);
    // The bar is position: fixed, so where it sits in the DOM does not matter.
    document.body.appendChild(bar);
  }

  async function initMockSeedBar() {
    // Ask the server first, every time: nothing is created or wired unless it
    // answers enabled === true, even if a bar element already exists.
    let enabled = false;
    try {
      const res = await fetch("/api/mock/status");
      if (res.ok) {
        const data = await res.json();
        enabled = data?.enabled === true;
      }
    } catch {
      enabled = false;
    }
    if (!enabled) return;
    if (!document.getElementById("btn-seed-mock")) {
      buildMockSeedBar();
    }

    const seedBtn = document.getElementById("btn-seed-mock");
    if (seedBtn && !seedBtn.dataset.wired) {
      seedBtn.dataset.wired = "1";
      seedBtn.addEventListener("click", async () => {
        seedBtn.disabled = true;
        seedBtn.textContent = "⏳ Seeding...";
        try {
          const res = await fetch("/api/mock/seed", { method: "POST" });
          const data = await res.json();
          if (!res.ok || !data.success) {
            showToast(data.error || "Seed failed", true);
            return;
          }
          showToast("Mock platform data seeded successfully");
          rehydrateAllViews();
        } catch (err) {
          console.error("Seed error:", err);
          showToast("Failed to seed mock data", true);
        } finally {
          seedBtn.disabled = false;
          seedBtn.textContent = "🧪 Seed Full Platform Data";
        }
      });
    }

    const clearBtn = document.getElementById("btn-clear-mock");
    if (clearBtn && !clearBtn.dataset.wired) {
      clearBtn.dataset.wired = "1";
      clearBtn.addEventListener("click", async () => {
        clearBtn.disabled = true;
        clearBtn.textContent = "⏳ Resetting...";
        try {
          const res = await fetch("/api/mock/clear", { method: "DELETE" });
          const data = await res.json();
          if (!res.ok || !data.success) {
            showToast(data.error || "Reset failed", true);
            return;
          }
          showToast("Mock data reset to clean state");
          rehydrateAllViews();
        } catch (err) {
          console.error("Clear error:", err);
          showToast("Failed to reset mock data", true);
        } finally {
          clearBtn.disabled = false;
          clearBtn.textContent = "🗑️ Reset Data";
        }
      });
    }
  }

  // Wire the Dev Seed Bar buttons on initial load so they are functional
  // immediately (not just on lazy route hydration).
  initMockSeedBar();

  // =========================================================================
  // Auth UI (Sprint 4 / FEAT-AUTH-UI-0001)
  // =========================================================================
  // Bootstrap the session state asynchronously (auth.js already rendered the
  // unauthenticated Log In button synchronously on its own defer load). On
  // login/logout, auth.js dispatches a custom event that re-fetches every
  // user-scoped view (wishlist, tags, alerts, etc.) via the existing
  // rehydrateAllViews() helper — no page reload.
  if (window.__auth && typeof window.__auth.init === "function") {
    window.__auth.init();
  }
  window.addEventListener("mgpl:data-rehydrate", () => {
    rehydrateAllViews();
  });

  // =========================================================================
  // Router Engine & Hash Change Listener
  // =========================================================================

  const ROUTES = {
    home: "page-home",
    playability: "page-playability",
    fleet: "page-fleet",
    devices: "page-devices",
    // Sprint 5 (EPICUX05): Hardware Explorer 2.0.
    hardware: "page-hardware",
    recommender: "page-recommender",
    deals: "page-deals",
    wishlist: "page-wishlist",
    library: "page-library",

    platforms: "page-platforms",
    compare: "page-compare",
    mods: "page-mods",
    backlog: "page-backlog",
    analytics: "page-analytics",
    settings: "page-settings",
    importer: "page-importer",
    retro: "page-retro",
    // Sprint 3 (WUD-3.2 / EPICUX02): Game Discovery 2.0.
    discovery: "page-discovery",
    // Sprint 3 (WUD-3.3 / EPICUX03): Gamer Profile Foundations & Privacy.
    profile: "page-profile",
    // Sprint 6 (PI-GTM-2026-002): Unified Integration Health Dashboard.
    observability: "page-observability",
  };

  const DEFAULT_ROUTE = "home";
  const loadedRoutes = new Set();

  function handleRoute() {
    const rawHash = window.location.hash.replace(/^#\/?/, "").trim();
    // Split off any query string (e.g. "#/library?platform=Steam")
    const hash = rawHash.split("?")[0];
    const query = rawHash.includes("?") ? rawHash.slice(rawHash.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    const gameMatch = hash.match(/^game\/(.+)$/);

    const detailPage = document.getElementById("page-game-detail");

    if (gameMatch) {
      const gameId = decodeURIComponent(gameMatch[1]);

      // Hide all standard route pages
      Object.keys(ROUTES).forEach((key) => {
        const el = document.getElementById(ROUTES[key]);
        if (el) el.classList.add("hidden");
      });

      // Show full detail page
      if (detailPage) detailPage.classList.remove("hidden");

      // Clear route link active highlights
      document.querySelectorAll(".route-link").forEach((link) => {
        link.className =
          "route-link px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 hover:text-white hover:bg-slate-800 transition-all flex items-center gap-1.5 whitespace-nowrap";
        link.removeAttribute("aria-current");
      });
      document.querySelectorAll(".mobile-route-link").forEach((link) => {
        link.className =
          "mobile-route-link flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-brand-400 active:text-brand-400 min-h-[44px] transition-colors";
      });
      // Sprint 3 (WUD-3.1 / EPICUX01): reset the desktop left rail active state.
      document.querySelectorAll(".rail-link").forEach((link) => {
        link.className =
          "rail-link flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-slate-300 hover:text-white hover:bg-slate-800 transition-all";
        link.removeAttribute("aria-current");
      });

      window.scrollTo({ top: 0, behavior: "instant" });
      fetchAndHydrateGameDetail(gameId);
      return;
    }

    // Sprint 2 (EPIC-DEV-001): shared build deep link.
    const builderShareMatch = hash.match(/^devices\/builder\/share\/(.+)$/);
    if (builderShareMatch) {
      const shareSlug = decodeURIComponent(builderShareMatch[1]);
      Object.keys(ROUTES).forEach((key) => {
        const el = document.getElementById(ROUTES[key]);
        if (el) el.classList.add("hidden");
      });
      if (detailPage) detailPage.classList.add("hidden");
      const devicesPage = document.getElementById("page-devices");
      if (devicesPage) devicesPage.classList.remove("hidden");

      document.querySelectorAll(".devices-tab-btn").forEach((btn) => {
        const key = btn.getAttribute("data-devices-tab");
        const active = key === "builder";
        btn.className =
          "devices-tab-btn px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 " +
          (active
            ? "active bg-brand-600 text-white"
            : "text-slate-400 hover:text-slate-200 hover:bg-slate-800");
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
      document.querySelectorAll(".devices-tab-panel").forEach((panel) => {
        const key = panel.id.replace("devices-panel-", "");
        panel.classList.toggle("hidden", key !== "builder");
      });

      if (window.__builder && typeof window.__builder.init === "function") {
        window.__builder.init(shareSlug);
      }
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }

    // Standard Route Matching
    if (detailPage) detailPage.classList.add("hidden");
    const routeKey = ROUTES[hash] ? hash : DEFAULT_ROUTE;

    // Toggle route page visibility
    Object.keys(ROUTES).forEach((key) => {
      const el = document.getElementById(ROUTES[key]);
      if (el) {
        if (key === routeKey) {
          el.classList.remove("hidden");
        } else {
          el.classList.add("hidden");
        }
      }
    });

    // Update active state in top header nav links.
    // EPIC-UX-REFINE-0001: dropdown sub-navigation links (.nav-dropdown-menu)
    // keep their own block layout — only top-level links get restyled.
    document.querySelectorAll(".route-link").forEach((link) => {
      if (link.closest(".nav-dropdown-menu")) return;
      const r = link.getAttribute("data-route");
      if (r === routeKey) {
        link.className =
          "route-link px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-600 text-white transition-all flex items-center gap-1.5 whitespace-nowrap shadow-sm";
        link.setAttribute("aria-current", "page");
      } else {
        link.className =
          "route-link px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 hover:text-white hover:bg-slate-800 transition-all flex items-center gap-1.5 whitespace-nowrap";
        link.removeAttribute("aria-current");
      }
    });

    // Update active state in mobile bottom nav
    document.querySelectorAll(".mobile-route-link").forEach((link) => {
      const r = link.getAttribute("data-route");
      if (r === routeKey) {
        link.className =
          "mobile-route-link flex flex-col items-center justify-center gap-1 text-brand-400 min-h-[44px] transition-colors font-bold";
      } else {
        link.className =
          "mobile-route-link flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-brand-400 active:text-brand-400 min-h-[44px] transition-colors";
      }
    });

    // Sprint 3 (WUD-3.1 / EPICUX01): update active state in the desktop left
    // rail. .rail-link elements live inside #desktop-rail only.
    document.querySelectorAll("#desktop-rail .rail-link").forEach((link) => {
      const r = link.getAttribute("data-route");
      if (r === routeKey) {
        link.className =
          "rail-link flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold bg-brand-600 text-white transition-all shadow-sm";
        link.setAttribute("aria-current", "page");
      } else {
        link.className =
          "rail-link flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-bold text-slate-300 hover:text-white hover:bg-slate-800 transition-all";
        link.removeAttribute("aria-current");
      }
    });

    // Scroll to top on route change
    window.scrollTo({ top: 0, behavior: "instant" });

    // Platform Hub deep-linking: honor ?store= param on every navigation so the
    // active platform tab is pre-selected and its summary is loaded even when the
    // platforms route was already visited (loadedRoutes guard bypassed).
    if (routeKey === "platforms") {
      const storeParam = params.get("store");
      if (storeParam) {
        currentPlatform = storeParam;
        updatePlatformTabStyles();
        loadedRoutes.delete("platforms");
      }
    }

    // Deals Hub deep-linking: honor ?tab= param (e.g. #/deals?tab=giveaways)
    // so the target 4-tab panel is activated immediately on every navigation.
    if (routeKey === "deals") {
      const tabParam = params.get("tab");
      if (tabParam) {
        currentStoreTab = normalizeDealsTab(tabParam);
        loadedRoutes.delete("deals");
      }
    }

    // Hardware Explorer deep-linking: honor ?tool= param
    // (e.g. #/hardware?tool=compatibility) so the target tool is preselected
    // even when the hardware route was already visited.
    if (routeKey === "hardware") {
      const toolParam = params.get("tool");
      if (toolParam) {
        loadedRoutes.delete("hardware");
      }
    }

    // Lazy data loading for active route
    if (!loadedRoutes.has(routeKey)) {
      loadedRoutes.add(routeKey);
      switch (routeKey) {
        case "home":
          fetchDashboardSummary();
          break;
        case "playability":
          fetchPlayableGames(localStorage.getItem("activeDeviceId") || "local-host", "all");
          break;
        case "fleet":
          fetchDeviceFleet("active");
          break;
        case "devices":
          if (window.__devices && typeof window.__devices.init === "function") {
            window.__devices.init();
          }
          break;
        case "hardware":
          if (window.__hardware && typeof window.__hardware.init === "function") {
            window.__hardware.init(params.get("tool") || "");
          }
          break;
        case "recommender":
          fetchRecommendations();
          break;
        case "deals":
          fetchDeals(currentStoreTab);
          // renderDealsTriggeredAlerts is defined in drawer.js and exposed on
          // window; guard the call so a load-order race cannot throw.
          if (typeof window.renderDealsTriggeredAlerts === "function") {
            window.renderDealsTriggeredAlerts();
          }
          break;

        case "wishlist":
          if (window.__wishlist && typeof window.__wishlist.init === "function") {
            window.__wishlist.init();
          }
          break;
        case "library": {
          renderSmartBinders();
          // Sprint 1 (EPIC-RADAR-0001): support deep-linking to the Hidden
          // Gems curated discovery filter via #/library?filter=hidden-gems.
          const filterParam = params.get("filter");
          const platformParam = params.get("platform");
          // EPIC-03 (Paginated Browsing): ?page=N deep-links directly to a
          // catalog page. Invalid/absent values fall back to page 1; the page
          // is clamped to [1, totalPages] when the library renders.
          const pageParam = parseInt(String(params.get("page") || ""), 10);
          libraryPage = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
          if (filterParam === "hidden-gems") {
            fetchLibraryGames("hidden-gems");
          } else if (platformParam) {
            fetchLibraryGames(platformParam);
          } else {
            fetchLibraryGames("all");
          }
          break;
        }
        case "platforms":
          fetchPlatformSummary(currentPlatform);
          break;

        case "compare":
          loadCompareCatalog();
          populateCompareDeviceSelect();
          if (window.__compare && typeof window.__compare.init === "function") {
            window.__compare.init();
          }
          break;
        case "mods":
          initModsHub();
          break;
        case "backlog":
          renderBacklogHub();
          break;
        case "analytics":
          renderAnalyticsVisualizer();
          break;
        case "settings":
          initSettingsHub();
          break;
        case "importer":
          if (window.__importer && typeof window.__importer.init === "function") {
            window.__importer.init();
          }
          break;
        case "retro":
          if (window.__retro && typeof window.__retro.init === "function") {
            window.__retro.init();
          }
          break;
        case "discovery":
          if (window.__discovery && typeof window.__discovery.init === "function") {
            window.__discovery.init();
          }
          break;
        case "profile":
          if (window.__profileDashboard && typeof window.__profileDashboard.init === "function") {
            window.__profileDashboard.init();
          }
          break;
        case "observability":
          if (window.__admin && typeof window.__admin.init === "function") {
            window.__admin.init();
          }
          break;
      }
    }
  }

  window.addEventListener("hashchange", handleRoute);

  // Global initial fetchers required for persistent badge counts
  fetchWishlistCount();

  // Initial Router Dispatch
  handleRoute();
});
