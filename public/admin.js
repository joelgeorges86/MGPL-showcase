/**
 * Sprint 6 (PI-GTM-2026-002) — Unified Integration Health Dashboard.
 *
 * Renders the /api/observability/health payload into #page-observability.
 * privacy-minimized contract: only static integration labels, status names, and integer
 * counters are rendered — never raw error strings, stack traces, or request
 * payloads. The "Data as of [timestamp]" freshness indicator is derived from
 * the snapshot's generatedAt so operators always know how current the status is.
 */
(function () {
  "use strict";

  var HEALTH_URL = "/api/observability/health";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function statusPill(status) {
    var map = { healthy: "emerald", degraded: "amber", stale: "rose", unknown: "slate" };
    var color = map[status] || "slate";
    return (
      '<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold text-' +
      color +
      "-300 bg-" +
      color +
      "-500/10 border border-" +
      color +
      '-500/30">' +
      esc(status) +
      "</span>"
    );
  }

  function formatAsOf(iso) {
    if (!iso) return "Unknown";
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return "Unknown";
    }
  }

  function fetchHealth() {
    return fetch(HEALTH_URL, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("unavailable");
      return res.json();
    });
  }

  function render(container, data) {
    if (!container) return;
    var integrations = Array.isArray(data.integrations) ? data.integrations : [];
    var rows = integrations
      .map(function (i) {
        return (
          '<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">' +
          '<div class="min-w-0">' +
          '<p class="text-sm font-bold text-white truncate">' +
          esc(i.label) +
          "</p>" +
          '<p class="text-[11px] text-slate-500 font-medium">' +
          esc(i.key) +
          " · " +
          esc(i.kind || "integration") +
          "</p>" +
          "</div>" +
          '<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">' +
          statusPill(i.status) +
          '<span>Requests <b class="text-slate-200">' +
          Number(i.requestsTotal) +
          "</b></span>" +
          '<span>Failure rate <b class="text-slate-200">' +
          Number(i.failureRate) +
          "</b></span>" +
          '<span>Rate-limited <b class="text-slate-200">' +
          Number(i.rateLimitedTotal) +
          "</b></span>" +
          '<span>Domain rejected <b class="text-slate-200">' +
          Number(i.domainRejectedTotal) +
          "</b></span>" +
          '<span>Token expired <b class="text-slate-200">' +
          Number(i.tokenExpiredTotal) +
          "</b></span>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    var overall = data.overall === "degraded" ? "Degraded" : "Operational";
    var overallColor = data.overall === "degraded" ? "text-amber-400" : "text-emerald-400";

    container.innerHTML =
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">' +
      '<div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">' +
      "<div>" +
      '<h2 class="text-lg font-bold text-white flex items-center gap-2"><i data-lucide="activity" class="w-5 h-5 text-brand-400"></i>Integration Health Dashboard</h2>' +
      '<p class="text-xs text-slate-500 mt-0.5">Operational status for every external integration. Static status names and counters only — no personal data.</p>' +
      "</div>" +
      '<div class="flex items-center gap-3">' +
      '<span class="text-xs font-bold ' +
      overallColor +
      '">' +
      overall +
      "</span>" +
      '<button id="observability-refresh-btn" type="button" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-all">Refresh</button>' +
      "</div>" +
      "</div>" +
      '<p class="text-xs text-slate-400"><span class="font-semibold text-slate-300">Data as of</span> ' +
      esc(formatAsOf(data.generatedAt)) +
      "</p>" +
      '<div class="grid grid-cols-1 gap-3">' +
      rows +
      "</div>" +
      "</div>";

    var btn = document.getElementById("observability-refresh-btn");
    if (btn) btn.addEventListener("click", refresh);

    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  function renderError(container) {
    if (!container) return;
    container.innerHTML =
      '<div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">' +
      '<h2 class="text-lg font-bold text-white">Integration Health Dashboard</h2>' +
      '<p class="text-xs text-rose-400 mt-2">Health telemetry is currently unavailable. Try again shortly.</p>' +
      '<button id="observability-refresh-btn" type="button" class="mt-4 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-all">Retry</button>' +
      "</div>";
    var btn = document.getElementById("observability-refresh-btn");
    if (btn) btn.addEventListener("click", refresh);
  }

  function refresh() {
    var container = document.getElementById("observability-dashboard");
    if (!container) return;
    container.innerHTML = '<p class="text-xs text-slate-500">Loading integration health…</p>';
    fetchHealth()
      .then(function (data) {
        render(container, data);
      })
      .catch(function () {
        renderError(container);
      });
  }

  function init() {
    var page = document.getElementById("page-observability");
    if (!page) return;
    refresh();
  }

  window.__admin = {
    init: init,
    refresh: refresh,
  };
})();
