/* MGPL Granular Storage Consent & GPC Listener (EPIC-COMPLIANCE-0001 Sprint 2)
 *
 * Self-contained vanilla-JS consent engine (no external dependencies):
 *   - Renders a first-visit consent banner (#consent-banner) when no explicit
 *     choice is stored under localStorage key `mgpl_consent_settings`.
 *   - Categorizes permissions into:
 *       Strictly Necessary         (always allowed, locked)
 *       Functional & Preferences   (theme, default sorting, drawer prefs)
 *       Analytics & Telemetry      (external deals click tracking)
 *   - "Accept All", "Reject Non-Essential" and "Custom Preferences" actions.
 *   - Reopenable consent manager modal: window.openConsentModal().
 *   - Global Privacy Control (GPC): when navigator.globalPrivacyControl ===
 *     true, analytics/telemetry is forced OFF and gpcActive is persisted +
 *     reflected in the UI.
 *   - CCPA/CPRA "Do Not Sell or Share" helpers used by the Account Settings
 *     Privacy tab (localStorage key `mgpl_dns`).
 *
 * Exposes:
 *   window.__consent = {
 *     getSettings, saveSettings, openConsentModal, closeConsentModal,
 *     isGpcActive, getDoNotSell, setDoNotSell,
 *   };
 *   window.openConsentModal()
 */
(function () {
  "use strict";

  var STORAGE_KEY = "mgpl_consent_settings";
  var DNS_KEY = "mgpl_dns";

  // Default "Custom" preferences: non-essential categories start enabled so the
  // user can explicitly uncheck categories they reject. "Reject Non-Essential"
  // and GPC flip these off; "Accept All" flips them on.
  var DEFAULTS = {
    necessary: true,
    functional: false,
    analytics: false,
    gpcActive: false,
    updatedAt: null,
  };

  var bannerEl = null;
  var modalEl = null;
  var gpcStatusEl = null;
  var analyticsInput = null;
  var functionalInput = null;
  var lastFocused = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function safeGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch (e) {
      return fallback;
    }
  }

  function safeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // Storage unavailable (private mode) — consent is effectively opt-out.
    }
  }

  function parseSettings() {
    var raw = safeGet(STORAGE_KEY, null);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      // Normalize shape defensively.
      return {
        necessary: parsed.necessary !== false,
        functional: parsed.functional === true,
        analytics: parsed.analytics === true,
        gpcActive: parsed.gpcActive === true,
        updatedAt: parsed.updatedAt || null,
      };
    } catch (e) {
      return null;
    }
  }

  function writeSettings(settings) {
    var next = {
      necessary: settings.necessary !== false,
      functional: settings.functional === true,
      analytics: settings.analytics === true,
      gpcActive: settings.gpcActive === true,
      updatedAt: new Date().toISOString(),
    };
    safeSet(STORAGE_KEY, JSON.stringify(next));
    reflectUi(next);
    return next;
  }

  function isGpcActive() {
    return typeof navigator !== "undefined" && navigator.globalPrivacyControl === true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function getSettings() {
    var stored = parseSettings();
    if (stored) return stored;
    // No explicit choice yet: derive a session default. GPC permanently forces
    // analytics off even before a choice is stored.
    var gpc = isGpcActive();
    return {
      necessary: DEFAULTS.necessary,
      functional: DEFAULTS.functional,
      analytics: gpc ? false : DEFAULTS.analytics,
      gpcActive: gpc,
      updatedAt: null,
    };
  }

  function saveSettings(settings) {
    var gpc = isGpcActive();
    var next = {
      necessary: true,
      functional: settings ? settings.functional === true : getSettings().functional,
      analytics: gpc ? false : settings ? settings.analytics === true : getSettings().analytics,
      gpcActive: gpc,
    };
    writeSettings(next);
    hideBanner();
    return next;
  }

  function hasStoredSettings() {
    return parseSettings() !== null;
  }

  function getDoNotSell() {
    return safeGet(DNS_KEY, "false") === "true";
  }

  function setDoNotSell(value) {
    safeSet(DNS_KEY, value ? "true" : "false");
    window.dispatchEvent(new CustomEvent("mgpl:privacy-changed", { detail: { dns: !!value } }));
    return getDoNotSell();
  }

  // ---------------------------------------------------------------------------
  // UI reflection
  // ---------------------------------------------------------------------------

  function reflectUi(settings) {
    var s = settings || getSettings();
    if (functionalInput) {
      functionalInput.checked = s.functional === true;
    }
    var gpc = s.gpcActive === true || isGpcActive();
    if (analyticsInput) {
      analyticsInput.checked = s.analytics === true && !gpc;
      analyticsInput.disabled = gpc;
    }
    if (gpcStatusEl) {
      if (gpc) {
        gpcStatusEl.classList.remove("hidden");
        gpcStatusEl.classList.add("flex");
        gpcStatusEl.textContent =
          "Global Privacy Control is active — Analytics & Telemetry are automatically disabled.";
      } else {
        gpcStatusEl.classList.add("hidden");
        gpcStatusEl.classList.remove("flex");
      }
    }
  }

  function hideBanner() {
    if (bannerEl) {
      bannerEl.classList.add("hidden");
    }
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------

  function openConsentModal() {
    if (!modalEl) return;
    lastFocused = document.activeElement;
    reflectUi(getSettings());
    modalEl.classList.remove("hidden");
    modalEl.classList.add("flex");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () {
      var first = modalEl.querySelector("button, [href], input, select, textarea");
      if (first && typeof first.focus === "function") first.focus();
    });
  }

  function closeConsentModal() {
    if (!modalEl) return;
    modalEl.classList.add("hidden");
    modalEl.classList.remove("flex");
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  function isModalOpen() {
    return !!modalEl && !modalEl.classList.contains("hidden");
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function onReady() {
    bannerEl = document.getElementById("consent-banner");
    modalEl = document.getElementById("consent-modal");
    gpcStatusEl = document.getElementById("gpc-status");
    functionalInput = document.getElementById("consent-functional");
    analyticsInput = document.getElementById("consent-analytics");

    if (hasStoredSettings()) {
      hideBanner();
      reflectUi(parseSettings());
    } else if (isGpcActive()) {
      // GPC users never see the banner and are never asked — GPC is the signal.
      hideBanner();
      writeSettings(getSettings());
    } else {
      if (bannerEl) bannerEl.classList.remove("hidden");
      reflectUi(getSettings());
    }

    // Banner actions.
    var acceptAll = document.getElementById("consent-accept-all");
    if (acceptAll) {
      acceptAll.addEventListener("click", function () {
        saveSettings({ functional: true, analytics: true });
      });
    }
    var rejectAll = document.getElementById("consent-reject-nonessential");
    if (rejectAll) {
      rejectAll.addEventListener("click", function () {
        saveSettings({ functional: false, analytics: false });
      });
    }
    var openPrefs = document.getElementById("consent-open-preferences");
    if (openPrefs) {
      openPrefs.addEventListener("click", openConsentModal);
    }

    // Modal actions.
    var mAcceptAll = document.getElementById("consent-modal-accept-all");
    if (mAcceptAll) {
      mAcceptAll.addEventListener("click", function () {
        saveSettings({ functional: true, analytics: true });
        closeConsentModal();
      });
    }
    var mRejectAll = document.getElementById("consent-modal-reject-nonessential");
    if (mRejectAll) {
      mRejectAll.addEventListener("click", function () {
        saveSettings({ functional: false, analytics: false });
        closeConsentModal();
      });
    }
    var savePrefs = document.getElementById("consent-save-preferences");
    if (savePrefs) {
      savePrefs.addEventListener("click", function () {
        saveSettings({
          functional: functionalInput ? functionalInput.checked : false,
          analytics: analyticsInput ? analyticsInput.checked : false,
        });
        closeConsentModal();
      });
    }
    var modalClose = document.getElementById("consent-modal-close");
    if (modalClose) {
      modalClose.addEventListener("click", closeConsentModal);
    }
    var modalBackdrop = document.getElementById("consent-modal-backdrop");
    if (modalBackdrop) {
      modalBackdrop.addEventListener("click", closeConsentModal);
    }

    // Footer / settings reopen links.
    var footerConsent = document.getElementById("footer-consent-link");
    if (footerConsent) {
      footerConsent.addEventListener("click", function (e) {
        e.preventDefault();
        openConsentModal();
      });
    }
    var footerDns = document.getElementById("footer-dns-link");
    if (footerDns) {
      footerDns.addEventListener("click", function (e) {
        e.preventDefault();
        openConsentModal();
      });
    }

    // Escape closes the modal; Tab is trapped while open.
    document.addEventListener("keydown", function (e) {
      if (!isModalOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeConsentModal();
        return;
      }
      if (e.key === "Tab" && modalEl) {
        var focusables = modalEl.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  function bootstrap() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
    }
  }

  bootstrap();

  window.__consent = {
    getSettings: getSettings,
    saveSettings: saveSettings,
    hasStoredSettings: hasStoredSettings,
    openConsentModal: openConsentModal,
    closeConsentModal: closeConsentModal,
    isGpcActive: isGpcActive,
    getDoNotSell: getDoNotSell,
    setDoNotSell: setDoNotSell,
  };
  window.openConsentModal = openConsentModal;
})();
