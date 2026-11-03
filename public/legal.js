/* MGPL Legal Policy Dialogs (EPIC-COMPLIANCE-0001 Sprint 3)
 *
 * Self-contained vanilla-JS accessible content dialog engine for:
 *   - Privacy Policy
 *   - Terms of Service
 *   - Accessibility Statement
 *
 * Conformance: role="dialog" + aria-modal="true" + visible focus ring,
 * Escape closes, Tab/Shift+Tab is trapped via window.trapFocus (graceful
 * fallback when app.js hasn't loaded it), focus returns to the triggering
 * element on close.
 */
(function () {
  "use strict";

  var CONTENT = {
    privacy: {
      title: "Privacy Policy",
      body: [
        {
          h: "1. Overview",
          p: "MGPL is a local-first, privacy-aware gaming library manager. Your library, fleet, wishlist, alerts, tags, notes, and preferences are stored on your device and in your account-scoped data.",
        },
        {
          h: "2. Data We Process",
          p: "We process strictly necessary account and library data required to run the dashboard, plus any functional preferences and analytics/telemetry you explicitly consent to. Global Privacy Control (GPC) is honored as an automatic opt-out.",
        },
        {
          h: "3. Affiliate Disclosure",
          p: "MGPL may earn a commission on qualifying purchases made via external storefront links. This never affects the price you pay.",
        },
        {
          h: "4. Your Rights",
          p: "Depending on your jurisdiction (GDPR, CCPA/CPRA, LGPD), you may access, export, correct, or delete your personal data. Use the Data & Backup Management tools in Settings or contact us below.",
        },
        {
          h: "5. Contact",
          p: "Privacy contact: privacy@mgpl.io (or use the accessibility feedback channel in the Accessibility Statement).",
        },
      ],
    },
    terms: {
      title: "Terms of Service",
      body: [
        {
          h: "1. Acceptance",
          p: "By using MGPL you agree to these Terms. If you do not agree, discontinue use of the service.",
        },
        {
          h: "2. Local-First Usage",
          p: "MGPL is provided as-is for personal library management. Always ensure you have lawful rights to any game files, ROMs, or patches you import.",
        },
        {
          h: "3. No Hosting of Protected Content",
          p: "MGPL never hosts, uploads, or distributes copyrighted ROMs or proprietary game assets. You are responsible for the legality of your own files.",
        },
        {
          h: "4. Limitations",
          p: "To the maximum extent permitted by law, MGPL is provided without warranties of any kind, and its operators are not liable for indirect or consequential damages.",
        },
        {
          h: "5. Changes",
          p: "We may update these Terms. Continued use after changes constitutes acceptance.",
        },
        { h: "6. Contact", p: "Terms contact: legal@mgpl.io" },
      ],
    },
    a11y: {
      title: "Accessibility Statement",
      body: [
        {
          h: "1. Commitment",
          p: "MGPL is committed to digital accessibility in line with Section 508 of the Rehabilitation Act and the WCAG 2.1 AA standard.",
        },
        {
          h: "2. Conformance",
          p: "This dashboard targets WCAG 2.1 Level AA conformance, including keyboard operability, visible focus indicators, accessible dialog/drawer semantics, live-region announcements, reduced-motion support, and skip-to-content navigation.",
        },
        {
          h: "3. Accessibility Features",
          p: "Skip to main content link, focus trapping in modals and drawers, screen-reader live regions, semantic landmark roles, and high-contrast / reduced-motion theme options.",
        },
        {
          h: "4. Feedback Channels",
          p: "We welcome your accessibility feedback. Please email accessibility@mgpl.io with the page or feature, the assistive technology used, and a description of the barrier.",
        },
        {
          h: "5. Response Time",
          p: "We will respond to accessibility feedback within 5 business days and address validated barriers in a reasonable timeframe.",
        },
      ],
    },
  };

  var modalEl = null;
  var contentEl = null;
  var titleEl = null;
  var lastFocused = null;

  function openLegalModal(key) {
    if (!modalEl) return;
    var doc = CONTENT[key] || CONTENT.privacy;
    lastFocused = document.activeElement;

    if (titleEl) titleEl.textContent = doc.title;
    if (contentEl) {
      contentEl.innerHTML =
        '<h3 class="text-base font-bold text-white mb-3">' +
        doc.title +
        "</h3>" +
        doc.body
          .map(function (block) {
            return (
              '<div class="space-y-1">' +
              '<h4 class="text-xs font-bold uppercase tracking-wider text-brand-400">' +
              block.h +
              "</h4>" +
              '<p class="text-sm text-slate-300 leading-relaxed">' +
              block.p +
              "</p>" +
              "</div>"
            );
          })
          .join("");
    }

    modalEl.classList.remove("hidden");
    modalEl.classList.add("flex");
    document.body.style.overflow = "hidden";

    modalEl.addEventListener("keydown", legalModalKeydownHandler);
    document.addEventListener("keydown", legalModalEscapeHandler);

    requestAnimationFrame(function () {
      var closeBtn = document.getElementById("legal-modal-close");
      if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    });
  }

  function closeLegalModal() {
    if (!modalEl) return;
    modalEl.classList.add("hidden");
    modalEl.classList.remove("flex");
    document.body.style.overflow = "";
    modalEl.removeEventListener("keydown", legalModalKeydownHandler);
    document.removeEventListener("keydown", legalModalEscapeHandler);
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function legalModalKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") {
      window.trapFocus(modalEl, e);
    } else {
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
  }

  function legalModalEscapeHandler(e) {
    if (e.key !== "Escape") return;
    var modal = document.getElementById("legal-modal");
    if (modal && !modal.classList.contains("hidden")) {
      e.preventDefault();
      closeLegalModal();
    }
  }

  function onReady() {
    modalEl = document.getElementById("legal-modal");
    contentEl = document.getElementById("legal-modal-content");
    titleEl = document.getElementById("legal-modal-title");

    var closeBtn = document.getElementById("legal-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", closeLegalModal);

    var backdrop = document.getElementById("legal-modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeLegalModal);

    document.getElementById("footer-privacy-link").addEventListener("click", function (e) {
      e.preventDefault();
      openLegalModal("privacy");
    });
    document.getElementById("footer-terms-link").addEventListener("click", function (e) {
      e.preventDefault();
      openLegalModal("terms");
    });
    document.getElementById("footer-a11y-link").addEventListener("click", function (e) {
      e.preventDefault();
      openLegalModal("a11y");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }

  window.__legal = {
    open: openLegalModal,
    close: closeLegalModal,
  };
})();
