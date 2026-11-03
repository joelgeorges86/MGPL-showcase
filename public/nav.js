/**
 * Navigation & Notification Center Controller (Sprint 3 / FEAT-RADAR-0001,
 * EPIC-UX-REFINE-0001 navigation dropdowns)
 */

(function () {
  // --- Consolidated 5-group navigation dropdown controller (EPIC-UX-REFINE-0001) ---
  const navDropdowns = document.querySelectorAll(".nav-dropdown");

  function closeAllDropdowns(exceptGroup) {
    navDropdowns.forEach((dd) => {
      const group = dd.getAttribute("data-nav-group");
      if (group === exceptGroup) return;
      dd.classList.remove("nav-dropdown-open");
      const trigger = dd.querySelector(".nav-dropdown-trigger");
      const menu = dd.querySelector(".nav-dropdown-menu");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      if (menu) menu.classList.add("hidden");
    });
  }

  function toggleDropdown(dd) {
    const isOpen = dd.classList.contains("nav-dropdown-open");
    closeAllDropdowns();
    if (isOpen) {
      dd.classList.remove("nav-dropdown-open");
      const trigger = dd.querySelector(".nav-dropdown-trigger");
      const menu = dd.querySelector(".nav-dropdown-menu");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      if (menu) menu.classList.add("hidden");
      return;
    }
    dd.classList.add("nav-dropdown-open");
    const trigger = dd.querySelector(".nav-dropdown-trigger");
    const menu = dd.querySelector(".nav-dropdown-menu");
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    if (menu) menu.classList.remove("hidden");
  }

  navDropdowns.forEach((dd) => {
    const trigger = dd.querySelector(".nav-dropdown-trigger");
    if (!trigger) return;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown(dd);
    });

    // Close after navigating to a dropdown destination link.
    const links = dd.querySelectorAll(".nav-dropdown-menu a.route-link");
    links.forEach((link) => link.addEventListener("click", () => closeAllDropdowns()));
  });

  // Settings dropdown actions (Profile / Linked Stores / Socials) open the
  // settings drawer. settings.js already registers a global click delegation
  // on [data-route="settings"]; importantly we must NOT stopPropagation here
  // so the event bubbles to settings.js's document listener and opens the
  // drawer. We only close the dropdown and provide a guest fallback.
  document.querySelectorAll('.nav-settings-action[data-route="settings"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      // Sprint 6 (PI-GTM-2026-001 WCAG 2.4.3): keep the nav dropdown trigger
      // focused as the menu collapses so settings.js's saveFocus() (which runs
      // on the bubbled click) captures a visible element — otherwise focus
      // restore on drawer close targets the now-hidden dropdown item.
      const dd = btn.closest(".nav-dropdown");
      const trigger = dd ? dd.querySelector(".nav-dropdown-trigger") : null;
      if (trigger && typeof trigger.focus === "function") trigger.focus();
      closeAllDropdowns();
      if (!(window.__settings && typeof window.__settings.open === "function")) {
        window.location.hash = "#/settings";
      }
    });
  });
  document.querySelectorAll("[data-consent-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      if (window.__consent && typeof window.__consent.open == "function") {
        window.__consent.open();
      } else {
        const consentModal = document.getElementById("consent-modal");
        if (consentModal) consentModal.classList.remove("hidden");
      }
    });
  });

  // Close any open dropdown when clicking outside the nav.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".nav-dropdown")) closeAllDropdowns();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllDropdowns();
  });

  // Deals sub-tab deep-link (Freebies Calendar → Release Radar tab).
  // Sprint 3 (EPIC-DEAL-001): normalize legacy keys so pre-existing links
  // (e.g. "release-radar") resolve to the canonical "radar" 4-tab key.
  document.querySelectorAll("[data-deals-tab]").forEach((link) => {
    link.addEventListener("click", () => {
      const rawTab = link.getAttribute("data-deals-tab");
      if (!rawTab) return;
      const canonical = rawTab === "release-radar" || rawTab === "releases" ? "radar" : rawTab;
      if (window.location.hash.indexOf("#/deals") !== 0) {
        // Navigate first (no preventDefault), handling happens on hashchange.
        return;
      }
      const tabBtn = document.querySelector(`.deals-tab-btn[data-store="${canonical}"]`);
      if (tabBtn) tabBtn.click();
    });
  });

  const triggerBtn = document.getElementById("notification-trigger");
  const badge = document.getElementById("notification-badge");
  const drawer = document.getElementById("notification-drawer");
  const drawerCloseBtn = document.getElementById("notification-drawer-close");
  const drawerContent = document.getElementById("notification-drawer-content");

  let activeAlerts = [];

  async function fetchTriggeredAlerts() {
    try {
      const res = await fetch("/api/alerts/triggered", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        if (res.status === 401) {
          activeAlerts = [];
          updateUI();
        }
        return;
      }
      const data = await res.json();
      activeAlerts = Array.isArray(data) ? data : Array.isArray(data?.alerts) ? data.alerts : [];
      updateUI();
    } catch (err) {
      console.error("[nav.js] Failed to fetch triggered alerts:", err);
    }
  }

  function updateUI() {
    const unacknowledgedCount = activeAlerts.length;

    if (badge) {
      badge.textContent = String(unacknowledgedCount);
      if (unacknowledgedCount > 0) {
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }

    if (!drawerContent) return;

    if (unacknowledgedCount === 0) {
      drawerContent.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-slate-500">
          <i data-lucide="bell-off" class="w-8 h-8 mb-2 opacity-50"></i>
          <p class="text-sm font-medium">No active price alerts triggered.</p>
        </div>
      `;
      if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons();
      }
      return;
    }

    drawerContent.innerHTML = activeAlerts
      .map((alert) => {
        const title = alert.title || alert.gameId || "Tracked Deal";
        const targetPrice =
          alert.targetPrice !== undefined && alert.targetPrice !== null
            ? `$${Number(alert.targetPrice).toFixed(2)}`
            : "$0.00";
        const currentPrice =
          alert.currentPrice !== undefined && alert.currentPrice !== null
            ? `$${Number(alert.currentPrice).toFixed(2)}`
            : "$0.00";

        return `
          <div class="notification-item bg-slate-950 border border-slate-800/80 rounded-xl p-4 space-y-3 shadow-md" data-game-id="${alert.gameId}">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-bold text-white">${title}</h3>
                <p class="text-xs text-amber-400 font-semibold mt-0.5">Target reached!</p>
              </div>
              <button data-acknowledge-id="${alert.id}" type="button" class="btn-dismiss-alert px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-semibold transition-colors">
                Dismiss
              </button>
            </div>
            <div class="grid grid-cols-2 gap-2 text-xs bg-slate-900 p-2.5 rounded-lg border border-slate-800/60">
              <div>
                <span class="text-slate-500 font-medium block">Target Price</span>
                <span class="text-slate-300 font-bold">${targetPrice}</span>
              </div>
              <div>
                <span class="text-slate-500 font-medium block">Current Price</span>
                <span class="text-emerald-400 font-bold">${currentPrice}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }

    // Attach click listeners to dismiss buttons
    const dismissBtns = drawerContent.querySelectorAll("[data-acknowledge-id]");
    dismissBtns.forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.currentTarget.getAttribute("data-acknowledge-id");
        if (!id) return;
        try {
          const res = await fetch(`/api/alerts/triggered/${id}/acknowledge`, {
            method: "POST",
            headers: { Accept: "application/json" },
          });
          if (res.ok) {
            fetchTriggeredAlerts();
          }
        } catch (err) {
          console.error("[nav.js] Failed to acknowledge alert:", err);
        }
      });
    });
  }

  function openDrawer() {
    if (!drawer) return;
    // Save the currently focused element so focus can be restored on close.
    if (typeof window.saveFocus === "function") window.saveFocus();
    drawer.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
    // Move focus into the drawer (close button) and trap Tab navigation
    // (Section 508 / WCAG 2.1 AA dialog semantics).
    if (drawerCloseBtn && typeof drawerCloseBtn.focus === "function") {
      drawerCloseBtn.focus();
    }
    drawer.addEventListener("keydown", drawerKeydownHandler);
    fetchTriggeredAlerts();
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
    drawer.removeEventListener("keydown", drawerKeydownHandler);
    // Restore focus to the element that opened the drawer.
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  }

  // Trap Tab/Shift+Tab focus within the notification drawer while it is open.
  function drawerKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") {
      window.trapFocus(drawer, e);
    }
  }

  if (triggerBtn) {
    triggerBtn.addEventListener("click", () => {
      if (drawer && drawer.classList.contains("hidden")) {
        openDrawer();
      } else {
        closeDrawer();
      }
    });
  }

  if (drawerCloseBtn) {
    drawerCloseBtn.addEventListener("click", closeDrawer);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer && !drawer.classList.contains("hidden")) {
      closeDrawer();
    }
  });

  document.addEventListener("mgpl:auth-changed", fetchTriggeredAlerts);
  document.addEventListener("mgpl:data-rehydrate", fetchTriggeredAlerts);

  window.__notifications = {
    refresh: fetchTriggeredAlerts,
    openDrawer,
    closeDrawer,
  };

  // Initial load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fetchTriggeredAlerts);
  } else {
    fetchTriggeredAlerts();
  }
})();
