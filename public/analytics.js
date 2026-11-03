/* MGPL Backlog Analytics Visualizer (FEAT-0152)
 *
 * Pure vanilla SVG chart engine (no external charting CDNs). Renders:
 *   - Donut chart  -> Genre Breakdown
 *   - Stacked bars -> Platform Backlog Distribution
 *   - Sparklines   -> Cost-Per-Hour value scorecards
 *
 * All dynamic chart markup is assembled off-DOM as template strings and then
 * mounted in a single innerHTML assignment. Responses are cached in IndexedDB
 * via window.OfflineStorage so charts render instantly offline.
 */
(function () {
  "use strict";

  const STORE = "store_analytics";
  const CACHE_KEY = "analytics";

  // ---- Small helpers -----------------------------------------------------
  function esc(value) {
    const amp = String.fromCharCode(38) + "amp;";
    const lt = String.fromCharCode(38) + "lt;";
    const gt = String.fromCharCode(38) + "gt;";
    const quot = String.fromCharCode(38) + "quot;";
    const apos = String.fromCharCode(38) + "#39;";
    return String(value == null ? "" : value)
      .replace(/&/g, amp)
      .replace(/</g, lt)
      .replace(/>/g, gt)
      .replace(/"/g, quot)
      .replace(/'/g, apos);
  }

  function fmtHours(value) {
    const n = Number(value) || 0;
    return n % 1 === 0 ? `${n}h` : `${n.toFixed(1)}h`;
  }

  function fmtMoney(value) {
    const n = Number(value) || 0;
    return n === 0 ? "$0" : `$${n.toFixed(2)}`;
  }

  // Deterministic palette derived from an index (stable across renders).
  const PALETTE = [
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ef4444",
    "#06b6d4",
    "#ec4899",
    "#84cc16",
    "#f97316",
    "#14b8a6",
    "#6366f1",
    "#eab308",
    "#22c55e",
    "#a855f7",
    "#f43f5e",
  ];
  function colorFor(index) {
    return PALETTE[index % PALETTE.length];
  }

  // ---- SVG builders (off-DOM template strings) ---------------------------
  function buildDonut(genres) {
    const total = genres.reduce((sum, g) => sum + (g.count || 0), 0);
    if (!total) {
      return `<div class="text-center py-10 text-slate-500 text-xs">No genre data available.</div>`;
    }

    const size = 220;
    const cx = size / 2;
    const cy = size / 2;
    const radius = 80;
    const strokeWidth = 34;
    const circumference = 2 * Math.PI * radius;

    let offset = 0;
    const segments = genres.map((g, i) => {
      const fraction = (g.count || 0) / total;
      const dash = fraction * circumference;
      const seg = `
        <circle
          cx="${cx}" cy="${cy}" r="${radius}"
          fill="none"
          stroke="${colorFor(i)}"
          stroke-width="${strokeWidth}"
          stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          stroke-linecap="butt"
          transform="rotate(-90 ${cx} ${cy})"
        >
          <title>${esc(g.name)}: ${g.count} (${g.percentage}%)</title>
        </circle>`;
      offset += dash;
      return seg;
    });

    const legend = genres
      .map(
        (g, i) => `
        <li class="flex items-center justify-between gap-3 text-xs">
          <span class="flex items-center gap-2 text-slate-300">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${colorFor(i)}"></span>
            <span class="truncate">${esc(g.name)}</span>
          </span>
          <span class="text-slate-400 font-semibold whitespace-nowrap">${g.count} · ${g.percentage}%</span>
        </li>`,
      )
      .join("");

    return `
      <div class="flex flex-col sm:flex-row items-center gap-6">
        <svg class="analytics-donut shrink-0" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Genre breakdown donut chart">
          ${segments.join("")}
          <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="fill-white font-black" font-size="22">${total}</text>
          <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="fill-slate-400" font-size="11">Games</text>
        </svg>
        <ul class="w-full space-y-1.5 min-w-0">${legend}</ul>
      </div>`;
  }

  function buildStackedBars(platforms) {
    if (!platforms.length) {
      return `<div class="text-center py-10 text-slate-500 text-xs">No platform data available.</div>`;
    }

    const maxCount = Math.max(...platforms.map((p) => p.gameCount || 0), 1);
    const maxHours = Math.max(...platforms.map((p) => p.totalHours || 0), 1);

    const bars = platforms
      .map((p) => {
        const countPct = Math.max(2, Math.round(((p.gameCount || 0) / maxCount) * 100));
        const hoursPct = Math.max(2, Math.round(((p.totalHours || 0) / maxHours) * 100));
        return `
        <div class="space-y-1">
          <div class="flex items-center justify-between text-xs">
            <span class="text-slate-300 font-semibold">${esc(p.platform)}</span>
            <span class="text-slate-400">${p.gameCount} games · ${fmtHours(p.totalHours)}</span>
          </div>
          <div class="flex gap-1 h-4">
            <div class="rounded bg-brand-500/80" style="width:${countPct}%" title="${p.gameCount} owned games"></div>
            <div class="rounded bg-emerald-500/80" style="width:${hoursPct}%" title="${fmtHours(p.totalHours)} played"></div>
          </div>
        </div>`;
      })
      .join("");

    return `
      <div class="space-y-4">
        <div class="flex items-center gap-4 text-[11px] text-slate-400">
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-brand-500/80"></span> Owned games</span>
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-emerald-500/80"></span> Hours played</span>
        </div>
        <div class="analytics-stacked-bar space-y-4">${bars}</div>
      </div>`;
  }

  function buildSparkline(values, color) {
    if (!values || !values.length) {
      return `<svg class="analytics-sparkline w-full h-10" role="img" aria-label="Trend sparkline"></svg>`;
    }
    const w = 120;
    const h = 40;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const step = w / (values.length - 1 || 1);
    const points = values
      .map((v, i) => {
        const x = i * step;
        const y = h - ((v - min) / range) * (h - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `
      <svg class="analytics-sparkline w-full h-10" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Trend sparkline">
        <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}"></polyline>
      </svg>`;
  }

  function buildValueScorecards(valueSummary) {
    const vs = valueSummary || {};
    const breakdown = Array.isArray(vs.breakdown) ? vs.breakdown : [];

    // Sparkline data: cost-per-hour per priced game (nulls skipped).
    const cphSeries = breakdown
      .filter((b) => b.cph != null)
      .map((b) => b.cph)
      .slice(0, 20);

    const ratingColor =
      vs.valueRating === "Excellent"
        ? "#10b981"
        : vs.valueRating === "Good"
          ? "#84cc16"
          : vs.valueRating === "Fair"
            ? "#f59e0b"
            : "#ef4444";

    const scorecards = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Spent</p>
          <p class="text-2xl font-black text-white mt-1">${fmtMoney(vs.totalSpent)}</p>
          <p class="text-[11px] text-slate-500 mt-1">${vs.pricedCount || 0} priced · ${vs.freeOrUnpricedCount || 0} free/unpriced</p>
        </div>
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Playtime</p>
          <p class="text-2xl font-black text-white mt-1">${fmtHours(vs.totalHours)}</p>
          <p class="text-[11px] text-slate-500 mt-1">Across ${breakdown.length} tracked games</p>
        </div>
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Cost Per Hour</p>
          <p class="text-2xl font-black mt-1" style="color:${ratingColor}">${vs.overallCph > 0 ? `$${vs.overallCph.toFixed(2)}` : "—"}</p>
          <p class="text-[11px] font-semibold mt-1" style="color:${ratingColor}">${esc(vs.valueRating || "No data")}</p>
          ${buildSparkline(cphSeries, ratingColor)}
        </div>
      </div>`;

    const tableRows = breakdown
      .slice(0, 10)
      .map(
        (b) => `
        <tr class="border-b border-slate-800/60 last:border-0">
          <td class="p-2 text-xs text-slate-300 truncate max-w-[220px]" title="${esc(b.title)}">${esc(b.title)}</td>
          <td class="p-2 text-xs text-slate-400 text-right">${fmtMoney(b.price)}</td>
          <td class="p-2 text-xs text-slate-400 text-right">${fmtHours(b.hours)}</td>
          <td class="p-2 text-xs text-slate-300 text-right font-semibold">${b.cph != null ? `$${b.cph.toFixed(2)}` : "—"}</td>
          <td class="p-2 text-xs text-right font-semibold">${esc(b.rating)}</td>
        </tr>`,
      )
      .join("");

    const table = `
      <div class="mt-4 overflow-x-auto">
        <table class="analytics-value-table w-full text-left">
          <thead>
            <tr class="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <th class="p-2">Game</th>
              <th class="p-2 text-right">Price</th>
              <th class="p-2 text-right">Hours</th>
              <th class="p-2 text-right">$/hr</th>
              <th class="p-2 text-right">Rating</th>
            </tr>
          </thead>
          <tbody>${tableRows || '<tr><td class="p-2 text-xs text-slate-500" colspan="5">No value data available.</td></tr>'}</tbody>
        </table>
      </div>`;

    return scorecards + table;
  }

  function buildVelocity(velocity) {
    const v = velocity || {};
    const ss = v.statusSummary || {};
    const intervals = Array.isArray(v.intervals) ? v.intervals : [];

    const statusCards = [
      { label: "Completed", value: ss.completed || 0, color: "text-emerald-400" },
      { label: "In Progress", value: ss.inProgress || 0, color: "text-amber-400" },
      { label: "Unplayed", value: ss.unplayed || 0, color: "text-slate-400" },
    ]
      .map(
        (c) => `
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">${c.label}</p>
          <p class="text-2xl font-black ${c.color} mt-1">${c.value}</p>
        </div>`,
      )
      .join("");

    const intervalRows = intervals
      .map(
        (iv) => `
        <tr class="border-b border-slate-800/60 last:border-0">
          <td class="p-2 text-xs text-slate-300 font-semibold">${esc(iv.label)}</td>
          <td class="p-2 text-xs text-emerald-400 text-right">${iv.completed || 0}</td>
          <td class="p-2 text-xs text-amber-400 text-right">${iv.inProgress || 0}</td>
          <td class="p-2 text-xs text-slate-400 text-right">${iv.unplayed || 0}</td>
        </tr>`,
      )
      .join("");

    return `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">${statusCards}</div>
      <div class="overflow-x-auto">
        <table class="analytics-velocity-table w-full text-left">
          <thead>
            <tr class="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <th class="p-2">Interval</th>
              <th class="p-2 text-right">Completed</th>
              <th class="p-2 text-right">In Progress</th>
              <th class="p-2 text-right">Unplayed</th>
            </tr>
          </thead>
          <tbody>${intervalRows || '<tr><td class="p-2 text-xs text-slate-500" colspan="4">No activity data available.</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  // ---- Session telemetry (Hardware Efficiency & Power Radar) -------------
  function buildWeeklySparkline(weekly) {
    const values = (Array.isArray(weekly) ? weekly : [])
      .map((w) => Number(w.playtimeHours) || 0)
      .slice(-12);
    if (!values.length) {
      return `<svg class="analytics-sparkline w-full h-10" role="img" aria-label="Weekly playtime trend sparkline"></svg>`;
    }
    const w = 120;
    const h = 40;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const step = w / (values.length - 1 || 1);
    const points = values
      .map((v, i) => {
        const x = i * step;
        const y = h - ((v - min) / range) * (h - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `
      <svg class="analytics-sparkline w-full h-10" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Weekly playtime trend sparkline">
        <polyline fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}"></polyline>
      </svg>`;
  }

  function buildSessionsTelemetry(sessions) {
    const s = sessions || {};
    const dist = Array.isArray(s.sessionDistribution) ? s.sessionDistribution : [];
    if (!dist.length) {
      return `<div class="text-center py-10 text-slate-500 text-xs">No session telemetry available.</div>`;
    }

    const maxHours = Math.max(...dist.map((d) => d.playtimeHours || 0), 1);

    const deviceBars = dist
      .map((d, i) => {
        const pct = Math.max(2, Math.round(((d.playtimeHours || 0) / maxHours) * 100));
        const battery =
          d.batteryCycles != null
            ? `${d.batteryCycles.toFixed(2)} cycles · ${d.batteryRuntimeHours != null ? d.batteryRuntimeHours.toFixed(1) + "h runtime" : ""}`
            : "N/A (Plugged Only)";
        return `
        <div class="space-y-1">
          <div class="flex items-center justify-between text-xs">
            <span class="flex items-center gap-2 text-slate-300 font-semibold">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${colorFor(i)}"></span>
              <span class="truncate">${esc(d.deviceName || d.deviceId || "Unattributed")}</span>
              <span class="text-[10px] text-slate-500 uppercase tracking-wider">${esc(d.deviceType || "Unknown")}</span>
            </span>
            <span class="text-slate-400 whitespace-nowrap">${fmtHours(d.playtimeHours)} · ${d.sharePct != null ? d.sharePct.toFixed(0) : 0}%</span>
          </div>
          <div class="flex h-3 rounded bg-slate-800/60 overflow-hidden">
            <div class="rounded" style="width:${pct}%;background:${colorFor(i)}" title="${fmtHours(d.playtimeHours)} played"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-slate-500">
            <span>${d.sessionCount || 0} sessions</span>
            <span>${d.estimatedEnergyKwh != null ? d.estimatedEnergyKwh.toFixed(2) + " kWh" : "—"} · ${esc(battery)}</span>
          </div>
        </div>`;
      })
      .join("");

    return `
      <div class="space-y-4" role="region" aria-label="Hardware efficiency and power radar">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-2">
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
            <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Playtime</p>
            <p class="text-2xl font-black text-white mt-1">${fmtHours(s.totalHours)}</p>
            <p class="text-[11px] text-slate-500 mt-1">${s.sessionCount || 0} sessions</p>
          </div>
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
            <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Weekly Trend</p>
            <div class="mt-1">${buildWeeklySparkline(s.weekly)}</div>
          </div>
          <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
            <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Devices</p>
            <p class="text-2xl font-black text-white mt-1">${dist.length}</p>
            <p class="text-[11px] text-slate-500 mt-1">attributed fleet profiles</p>
          </div>
        </div>
        <div class="analytics-sessions-bars space-y-4">${deviceBars}</div>
      </div>`;
  }

  // ---- Backlog velocity & burn-down --------------------------------------
  function buildBacklogVelocity(velocity) {
    const v = velocity || {};
    const games = Array.isArray(v.games) ? v.games : [];
    const stalled = Array.isArray(v.stalledGames) ? v.stalledGames : [];

    const headerCards = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Weekly Velocity</p>
          <p class="text-2xl font-black text-emerald-400 mt-1">${fmtHours(v.velocityHoursPerWeek)}</p>
          <p class="text-[11px] text-slate-500 mt-1">7-day rolling window</p>
        </div>
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Burn-Down ETA</p>
          <p class="text-2xl font-black text-white mt-1">${v.burnDownEtaDays != null ? Math.ceil(v.burnDownEtaDays) + "d" : "—"}</p>
          <p class="text-[11px] text-slate-500 mt-1">${v.activeGameCount || 0} active games</p>
        </div>
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4">
          <p class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Stalled</p>
          <p class="text-2xl font-black ${stalled.length ? "text-rose-400" : "text-slate-400"} mt-1">${stalled.length}</p>
          <p class="text-[11px] text-slate-500 mt-1">no sessions >14 days</p>
        </div>
      </div>`;

    const rows = games
      .slice(0, 12)
      .map((g) => {
        const eta =
          g.burnDownEtaDays != null
            ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">${Math.ceil(g.burnDownEtaDays)}d ETA</span>`
            : `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-700/40 text-slate-400">—</span>`;
        const stalledBadge = g.stalled
          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/15 text-rose-400">Stalled</span>`
          : "";
        return `
        <tr class="border-b border-slate-800/60 last:border-0">
          <td class="p-2 text-xs text-slate-300 truncate max-w-[200px]" title="${esc(g.title)}">${esc(g.title)}</td>
          <td class="p-2 text-xs text-slate-400">${esc(g.status || "—")}</td>
          <td class="p-2 text-xs text-slate-400 text-right">${fmtHours(g.actualHoursPlayed)}</td>
          <td class="p-2 text-xs text-slate-400 text-right">${g.targetHours != null ? fmtHours(g.targetHours) : "—"}</td>
          <td class="p-2 text-xs text-right">${eta} ${stalledBadge}</td>
        </tr>`;
      })
      .join("");

    const table = `
      <div class="overflow-x-auto">
        <table class="analytics-velocity-burndown-table w-full text-left">
          <thead>
            <tr class="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <th class="p-2">Game</th>
              <th class="p-2">Status</th>
              <th class="p-2 text-right">Played</th>
              <th class="p-2 text-right">Target</th>
              <th class="p-2 text-right">ETA</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td class="p-2 text-xs text-slate-500" colspan="5">No active backlog games.</td></tr>'}</tbody>
        </table>
      </div>`;

    return `
      <div class="space-y-4" role="region" aria-label="Backlog velocity and burn down">
        ${headerCards}
        ${table}
      </div>`;
  }

  // ---- Main render -------------------------------------------------------
  function renderAnalyticsVisualizer() {
    const page = document.getElementById("page-analytics");
    if (!page) return;

    const genreCard = document.getElementById("analytics-genre-body");
    const platformCard = document.getElementById("analytics-platform-body");
    const valueCard = document.getElementById("analytics-value-body");
    const velocityCard = document.getElementById("analytics-velocity-body");
    const sessionsCard = document.getElementById("analytics-sessions-body");
    const velocityBurnCard = document.getElementById("analytics-velocity-burndown-body");

    const loading = `
      <div class="flex flex-col items-center justify-center py-10 text-slate-500">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500 mb-2"></div>
        <p class="text-xs font-medium">Computing analytics...</p>
      </div>`;
    if (genreCard) genreCard.innerHTML = loading;
    if (platformCard) platformCard.innerHTML = loading;
    if (valueCard) valueCard.innerHTML = loading;
    if (velocityCard) velocityCard.innerHTML = loading;
    if (sessionsCard) sessionsCard.innerHTML = loading;
    if (velocityBurnCard) velocityBurnCard.innerHTML = loading;

    const errHtml = `<div class="text-center py-10 text-rose-400 text-xs font-semibold">Failed to load analytics.</div>`;

    // Sprint 5 (EPIC-07): explicit role-gated blocked state. The server enforces
    // the gate; this is the graceful client-facing message for 401/403.
    const deniedHtml = `
      <div role="alert" class="text-center py-10 space-y-2">
        <div class="text-rose-400 font-bold text-sm">Access Denied</div>
        <p class="text-xs text-slate-400 max-w-md mx-auto">
          Analytics is restricted to Product, Data, or Leadership roles. Ask an
          administrator to grant your account access.
        </p>
      </div>`;

    function fetchWithStatus(url) {
      return apiFetch(url).then(function (r) {
        return r.json().then(function (body) {
          return { status: r.status, ok: r.ok, body: body };
        });
      });
    }

    return Promise.all([
      fetchWithStatus("/api/analytics/summary"),
      fetchWithStatus("/api/analytics/sessions"),
      fetchWithStatus("/api/backlog/velocity"),
    ])
      .then(([summaryRes, sessionsRes, velocityRes]) => {
        const blocked =
          summaryRes.status === 401 ||
          summaryRes.status === 403 ||
          sessionsRes.status === 401 ||
          sessionsRes.status === 403;
        if (blocked) {
          const cards = [
            genreCard,
            platformCard,
            valueCard,
            velocityCard,
            sessionsCard,
            velocityBurnCard,
          ];
          cards.forEach(function (card) {
            if (card) card.innerHTML = deniedHtml;
          });
          return;
        }
        const summary = summaryRes.body;
        const sessions = sessionsRes.body;
        const velocity = velocityRes.body;
        if (!summary || !summary.success) {
          if (genreCard) genreCard.innerHTML = errHtml;
          if (platformCard) platformCard.innerHTML = errHtml;
          if (valueCard) valueCard.innerHTML = errHtml;
          if (velocityCard) velocityCard.innerHTML = errHtml;
        } else {
          // Off-DOM assembly: build all chart strings before mounting.
          const genreHtml = buildDonut(summary.genres || []);
          const platformHtml = buildStackedBars(summary.platforms || []);
          const valueHtml = buildValueScorecards(summary.valueSummary || {});
          const velocityHtml = buildVelocity(summary.velocity || {});

          if (genreCard) genreCard.innerHTML = genreHtml;
          if (platformCard) platformCard.innerHTML = platformHtml;
          if (valueCard) valueCard.innerHTML = valueHtml;
          if (velocityCard) velocityCard.innerHTML = velocityHtml;
        }

        if (sessionsCard) {
          sessionsCard.innerHTML =
            sessions && sessions.success ? buildSessionsTelemetry(sessions) : errHtml;
        }
        if (velocityBurnCard) {
          velocityBurnCard.innerHTML =
            velocity && velocity.success ? buildBacklogVelocity(velocity) : errHtml;
        }

        if (window.lucide) window.lucide.createIcons();
      })
      .catch((err) => {
        console.error("Error rendering analytics visualizer:", err);
        if (genreCard) genreCard.innerHTML = errHtml;
        if (platformCard) platformCard.innerHTML = errHtml;
        if (valueCard) valueCard.innerHTML = errHtml;
        if (velocityCard) velocityCard.innerHTML = errHtml;
        if (sessionsCard) sessionsCard.innerHTML = errHtml;
        if (velocityBurnCard) velocityBurnCard.innerHTML = errHtml;
      });
  }

  // Wire the refresh button (event delegation-safe).
  function initAnalytics() {
    const refreshBtn = document.getElementById("analytics-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => renderAnalyticsVisualizer());
    }
  }

  // Expose hooks for Playwright E2E tests.
  window.renderAnalyticsVisualizer = renderAnalyticsVisualizer;
  window.__analyticsHelpers = {
    renderAnalyticsVisualizer,
    buildDonut,
    buildStackedBars,
    buildValueScorecards,
    buildVelocity,
    buildSessionsTelemetry,
    buildBacklogVelocity,
    buildWeeklySparkline,
    STORE,
    CACHE_KEY,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAnalytics);
  } else {
    initAnalytics();
  }
})();
