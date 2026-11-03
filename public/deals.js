/**
 * MGPL Deals Module — Client-side Deal Arbitrage & Sparkline Helper
 * Pure inline SVG sparkline generator with zero external charting dependencies.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * Sprint 3 (EPIC-DEAL-001): explicit SVG sanitization whitelist.
   *
   * Strips any embedded script/foreign content, inline event handlers, and
   * outbound href attributes before a generated SVG string is ever injected.
   * Rendering code should prefer buildPriceSparklineEl() (pure createElementNS);
   * this string-level filter is defense-in-depth for any markup that still flows
   * through innerHTML/outerHTML.
   *
   * @param {string} markup
   * @returns {string}
   */
  function sanitizeSvg(markup) {
    var s = String(markup == null ? "" : markup);
    // Remove <script> and <foreignObject> blocks entirely (non-greedy, any case).
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    s = s.replace(/<script\b[^>]*\/?>/gi, "");
    s = s.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "");
    s = s.replace(/<foreignObject\b[^>]*\/?>/gi, "");
    // Remove any inline event handler attributes (onclick, onload, onerror, …).
    s = s.replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    // Remove external reference attributes (xlink:href and plain href) which
    // could load remote resources or scripts.
    s = s.replace(/\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return s;
  }

  /**
   * Sprint 3 (EPIC-DEAL-001): client-side storefront host allowlist.
   *
   * Superset of every HTTPS host the backend legitimately emits across direct
   * platform stores, authorized retailers, the GamerPower feed, radar seed URLs
   * (PSN/Xbox/Nintendo), and wishlist pricing synthesis (Gamesplanet/GameBillet).
   * Any outbound deal/giveaway/pre-order link must resolve to one of these hosts
   * before it is rendered as an actionable <a href>.
   */
  var CLIENT_STOREFRONT_ALLOWLIST = [
    "store.steampowered.com",
    "gog.com",
    "www.gog.com",
    "store.epicgames.com",
    "store.playstation.com",
    "www.playstation.com",
    "www.xbox.com",
    "www.nintendo.com",
    "fanatical.com",
    "www.fanatical.com",
    "greenmangaming.com",
    "www.greenmangaming.com",
    "humblebundle.com",
    "www.humblebundle.com",
    "gamerpower.com",
    "www.gamerpower.com",
    "gamesplanet.com",
    "www.gamesplanet.com",
    "gamebillet.com",
    "www.gamebillet.com",
  ];

  /**
   * Sprint 3 (EPIC-DEAL-001): validate + canonicalize an outbound store URL.
   * Returns an HTTPS URL whose hostname matches the allowlist, or null when the
   * input is missing, malformed, non-HTTPS, or host-blocked.
   *
   * @param {string|null|undefined} url
   * @returns {string|null}
   */
  function sanitizeStoreUrl(url) {
    var raw = String(url == null ? "" : url).trim();
    if (!raw) return null;
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    var host = (parsed.hostname || "").toLowerCase();
    if (!host) return null;
    var allowed = CLIENT_STOREFRONT_ALLOWLIST.some(function (h) {
      return host === h;
    });
    return allowed ? parsed.href : null;
  }

  /**
   * Compute normalized polyline coordinates for a price history series.
   * Shared by the string sparkline and the safe DOM sparkline so both render
   * identical geometry without NaN in the 0/1-point and flat-price cases.
   *
   * @param {Array<{date?: string, price: number}>} points
   * @param {{width:number,height:number,strokeWidth:number}} dims
   * @returns {{ prices: number[], coords: string[], midY: number }}
   */
  function computeSparklineGeometry(points, dims) {
    var width = dims.width;
    var height = dims.height;
    var strokeWidth = dims.strokeWidth;

    if (!Array.isArray(points) || points.length === 0) {
      return {
        prices: [],
        coords: ["0," + (height / 2).toFixed(1), width + "," + (height / 2).toFixed(1)],
        midY: height / 2,
      };
    }

    var prices = points.map(function (p) {
      return typeof p === "number" ? p : Number(p.price) || 0;
    });

    var minPrice = Math.min.apply(null, prices);
    var maxPrice = Math.max.apply(null, prices);
    var priceRange = maxPrice - minPrice;

    var padding = strokeWidth * 2;
    var drawWidth = width - padding * 2;
    var drawHeight = height - padding * 2;

    var coords = [];
    var count = prices.length;

    for (var i = 0; i < count; i++) {
      var x = count === 1 ? width / 2 : padding + (i / (count - 1)) * drawWidth;
      var y =
        priceRange === 0
          ? height / 2
          : padding + drawHeight - ((prices[i] - minPrice) / priceRange) * drawHeight;
      coords.push(x.toFixed(1) + "," + y.toFixed(1));
    }

    if (count === 1) {
      coords = ["0," + (height / 2).toFixed(1), width + "," + (height / 2).toFixed(1)];
    }

    return { prices: prices, coords: coords, midY: height / 2 };
  }

  /**
   * Generates a pure SVG polyline sparkline string for a price history series.
   * The emitted markup is passed through sanitizeSvg() so no script, foreign
   * object, event handler, or href can survive even if callers inject it.
   *
   * @param {Array<{date?: string, price: number}>} points
   * @param {Object} [options]
   * @param {number} [options.width=160]
   * @param {number} [options.height=40]
   * @param {string} [options.strokeColor='#38bdf8']
   * @param {number} [options.strokeWidth=2]
   * @returns {string} Inline SVG string
   */
  function buildPriceSparkline(points, options) {
    var opts = options || {};
    var width = typeof opts.width === "number" ? opts.width : 160;
    var height = typeof opts.height === "number" ? opts.height : 40;
    var strokeColor = opts.strokeColor || "#38bdf8";
    var strokeWidth = typeof opts.strokeWidth === "number" ? opts.strokeWidth : 2;

    var geo = computeSparklineGeometry(points, {
      width: width,
      height: height,
      strokeWidth: strokeWidth,
    });

    return sanitizeSvg(
      '<svg viewBox="0 0 ' +
        width +
        " " +
        height +
        '" class="price-sparkline" width="' +
        width +
        '" height="' +
        height +
        '">' +
        '<polyline fill="none" stroke="' +
        strokeColor +
        '" stroke-width="' +
        strokeWidth +
        '" points="' +
        geo.coords.join(" ") +
        '" />' +
        "</svg>",
    );
  }

  /**
   * Sprint 3 (EPIC-DEAL-001): safe DOM-sparkline builder using only
   * document.createElementNS. Emits a pure <svg> (with an optional <polyline>
   * and optional <text> label) — no innerHTML, no scripts, no foreign content.
   *
   * @param {Array<{date?: string, price: number}>} points
   * @param {Object} [options]
   * @returns {SVGSVGElement}
   */
  function buildPriceSparklineEl(points, options) {
    var opts = options || {};
    var width = typeof opts.width === "number" ? opts.width : 160;
    var height = typeof opts.height === "number" ? opts.height : 40;
    var strokeColor = opts.strokeColor || "#38bdf8";
    var strokeWidth = typeof opts.strokeWidth === "number" ? opts.strokeWidth : 2;

    var geo = computeSparklineGeometry(points, {
      width: width,
      height: height,
      strokeWidth: strokeWidth,
    });

    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("class", opts.className || "price-sparkline");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Price trend sparkline");
    if (opts.id) svg.setAttribute("id", opts.id);

    var polyline = document.createElementNS(SVG_NS, "polyline");
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", strokeColor);
    polyline.setAttribute("stroke-width", String(strokeWidth));
    polyline.setAttribute("points", geo.coords.join(" "));
    svg.appendChild(polyline);

    if (opts.label) {
      var text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(width / 2));
      text.setAttribute("y", String(height - 2));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", "7");
      text.setAttribute("fill", "#64748b");
      text.setAttribute("font-family", "sans-serif");
      text.textContent = String(opts.label);
      svg.appendChild(text);
    }

    return svg;
  }

  /**
   * EPIC-UX-REFINE-0002: HTML-escape a value for safe attribute/text injection.
   * @param {*} value
   * @returns {string}
   */
  function esc(value) {
    // Build HTML-entity strings at runtime so the source never contains literal
    // entity syntax (safe across aggressive post-processing / minifiers).
    var amp = String.fromCharCode(38); // &
    return String(value == null ? "" : value)
      .replace(/&/g, function () {
        return amp + "amp;";
      })
      .replace(/"/g, function () {
        return amp + "quot;";
      })
      .replace(/</g, function () {
        return amp + "lt;";
      })
      .replace(/>/g, function () {
        return amp + "gt;";
      })
      .replace(/'/g, function () {
        return amp + "#39;";
      });
  }

  /**
   * EPIC-UX-REFINE-0002: shared cover-art thumbnail with an inline SVG
   * placeholder fallback (data URI) when the image is missing or fails to load.
   * @param {string|null} url
   * @param {string} alt
   * @param {string} [className] extra Tailwind classes for the wrapper
   * @returns {string}
   */
  function coverArtHtml(url, alt, className) {
    var cls = className || "w-14 h-16 rounded-lg flex-shrink-0";
    var safeAlt = esc(alt || "Game cover");
    var placeholderSvg =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 64">' +
          '<rect width="56" height="64" rx="6" fill="#0f172a"/>' +
          '<rect x="8" y="8" width="40" height="40" rx="4" fill="#1e293b"/>' +
          '<path d="M20 46l8-12 6 8 4-5 6 9z" fill="#475569"/>' +
          '<text x="28" y="58" text-anchor="middle" font-size="7" fill="#64748b" font-family="sans-serif">MGPL</text>' +
          "</svg>",
      );
    var fallbackAttr = "onerror=\"this.onerror=null;this.src='" + placeholderSvg + "';\"";
    if (!url)
      return (
        '<div class="' +
        cls +
        ' overflow-hidden bg-slate-900 border border-slate-800 flex items-center justify-center"><img src="' +
        placeholderSvg +
        '" alt="' +
        safeAlt +
        '" class="w-full h-full object-cover"/></div>'
      );
    return (
      '<div class="' +
      cls +
      ' overflow-hidden bg-slate-900 border border-slate-800 flex items-center justify-center"><img src="' +
      esc(url) +
      '" alt="' +
      safeAlt +
      '" loading="lazy" ' +
      fallbackAttr +
      ' class="w-full h-full object-cover"/></div>'
    );
  }

  /**
   * EPIC-UX-REFINE-0002: normalize a raw platform/store string into a short
   * store badge label. Mirrors the server-side normalizePlatform mapping.
   * @param {string} raw
   * @returns {string}
   */
  /**
   * Sprint 4 (EPIC-DEAL-001): render a clearly attributed outbound store link.
   * Runs the URL through sanitizeStoreUrl (strict HTTPS + allowlist) and emits
   * a visible attribution badge alongside the anchor so every deal/giveaway
   * card carries an explicit, verifiable platform reference.
   */
  function attributionLink(storeName, storeUrl, label) {
    var safeUrl = sanitizeStoreUrl(storeUrl);
    var display = label || storeName || "Store";
    var badge =
      '<span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[9px] font-bold" data-attribution-badge>' +
      esc(storeBadgeFor(storeName || display)) +
      "</span>";
    if (!safeUrl) {
      return (
        '<span class="inline-flex items-center gap-1.5">' +
        badge +
        "<span>" +
        esc(display) +
        "</span></span>"
      );
    }
    return (
      '<a href="' +
      esc(safeUrl) +
      '" target="_blank" rel="noopener noreferrer" data-attribution-link class="inline-flex items-center gap-1.5 text-indigo-300 hover:text-indigo-200 underline decoration-indigo-500/40 underline-offset-2">' +
      badge +
      "<span>" +
      esc(display) +
      "</span>" +
      "</a>"
    );
  }

  function storeBadgeFor(raw) {
    var s = String(raw || "").toLowerCase();
    if (s.includes("epic")) return "Epic";
    if (s.includes("steam")) return "Steam";
    if (s.includes("gog")) return "GOG";
    if (s.includes("humble")) return "Humble";
    if (s.includes("itch")) return "Itch.io";
    if (s.includes("indiegala")) return "IndieGala";
    if (s.includes("stove")) return "Stove";
    if (s.includes("amazon")) return "Amazon";
    return "Free Giveaway";
  }

  /**
   * EPIC-UX-REFINE-0002: deterministic mod taxonomy tag pills derived from a
   * game's primary genre. Mirrors the server-side modTaxonomyFor mapping.
   * @param {string|null} genre
   * @returns {Array<string>}
   */
  function modTaxonomyFor(genre) {
    var g = String(genre || "").toLowerCase();
    if (g.includes("rpg") || g.includes("action")) return ["Total Conversion", "Graphics", "Fixes"];
    if (g.includes("shooter")) return ["Graphics", "Fixes", "Gameplay"];
    if (g.includes("strategy") || g.includes("simulation"))
      return ["Total Conversion", "UI", "Balance"];
    if (g.includes("roguelike") || g.includes("metroidvania")) return ["Gameplay", "Fixes"];
    if (g.includes("survival") || g.includes("sandbox")) return ["Content", "Graphics", "Fixes"];
    if (g.includes("horror")) return ["Graphics", "Fixes"];
    if (g.includes("adventure")) return ["Content", "Graphics"];
    return ["Graphics", "Fixes"];
  }

  /**
   * EPIC-UX-REFINE-0002: return an expiration countdown badge ("Ends in 2d 14h")
   * or a graceful fallback label.
   * @param {string|null} endAt
   * @returns {string}
   */
  function countdownFor(endAt) {
    if (!endAt) {
      return '<span class="text-[10px] text-slate-500 font-semibold" data-expiry-status="none">No expiry listed</span>';
    }
    var endTime = new Date(String(endAt).replace(" ", "T")).getTime();
    var now = Date.now();
    if (Number.isNaN(endTime) || endTime <= now) {
      return '<span class="text-[10px] text-amber-400 font-bold" data-expiry-status="ending">Ending soon</span>';
    }
    var diffMs = endTime - now;
    var days = Math.floor(diffMs / 86400000);
    var hours = Math.floor((diffMs % 86400000) / 3600000);
    if (days >= 1) {
      return (
        '<span class="text-[10px] text-emerald-400 font-bold" data-expiry-status="active">Ends in ' +
        days +
        "d " +
        hours +
        "h</span>"
      );
    }
    if (hours >= 1) {
      return (
        '<span class="text-[10px] text-amber-400 font-bold" data-expiry-status="active">Ends in ' +
        hours +
        "h</span>"
      );
    }
    return '<span class="text-[10px] text-rose-400 font-bold" data-expiry-status="active">Ends soon</span>';
  }

  /**
   * Defensive fallback for the global affiliate disclosure helper (defined in
   * app.js). Keeps the Sprint 2 panel builders safe to invoke from any context.
   */
  function affiliateDisclosureHtml() {
    if (typeof window.affiliateDisclosureHtml === "function") {
      return window.affiliateDisclosureHtml();
    }
    return (
      '<p role="note" class="affiliate-disclosure" data-affiliate-disclosure>' +
      "MGPL may earn a commission on qualifying purchases via store links." +
      "</p>"
    );
  }

  /**
   * Sprint 2 (EPIC-DEAL-001): render a Release Radar card.
   * - verified badge (data-verified)
   * - platform pill
   * - countdown chip with data-days ("Releases in X days")
   * - sanitized pre-order store link
   */
  function buildRadarCard(r) {
    var title = r.title || "Untitled Release";
    var platform = r.platform || "PC";
    var publisher = r.publisher || "";
    var releaseDate = r.releaseDate || "";
    var priceUsd = Number(r.priceUsd);
    var daysUntil = Number.isFinite(Number(r.daysUntil)) ? Number(r.daysUntil) : 0;
    var safePreorderUrl = sanitizeStoreUrl(r.preorderUrl);
    var verified = r.isVerified === true || Number(r.isVerified) === 1;
    // EU Omnibus / FTC: surface a 30-day low when the (future) release carries one.
    var lowest30d = Number(r.lowest30d != null ? r.lowest30d : r.lowestPrice30d);

    var verifiedBadge = verified
      ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[10px] font-black uppercase tracking-wider" data-verified="true" title="Source-verified upcoming release">\u2713 Verified</span>'
      : "";

    var priceStr = Number.isFinite(priceUsd) && priceUsd > 0 ? "$" + priceUsd.toFixed(2) : "TBA";

    var omnibusBadge =
      Number.isFinite(lowest30d) && lowest30d > 0
        ? '<span class="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold" data-30d-low title="Lowest verified price in the last 30 days">Lowest in 30 days: $' +
          lowest30d.toFixed(2) +
          "</span>"
        : "";

    var countdownChip =
      daysUntil > 0
        ? '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[11px] font-black" data-days="' +
          daysUntil +
          '"><i data-lucide="hourglass" class="w-3 h-3"></i> Releases in ' +
          daysUntil +
          " days</span>"
        : '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[11px] font-black" data-days="' +
          daysUntil +
          '">Releasing today</span>';

    var storeLink = safePreorderUrl
      ? '<a href="' +
        esc(safePreorderUrl) +
        '" target="_blank" rel="noopener noreferrer" class="radar-preorder-btn w-full py-2 rounded-xl bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold transition-all shadow-md shadow-pink-600/20 flex items-center justify-center gap-1.5" data-preorder-url>' +
        "Pre-Order" +
        ' <i data-lucide="external-link" class="w-3 h-3"></i></a>'
      : "";

    return (
      '<div class="radar-card bg-slate-950/80 border border-slate-800 hover:border-pink-500/40 rounded-2xl p-4 flex flex-col justify-between transition-all shadow-md" data-radar-card>' +
      '<div class="flex items-start justify-between gap-2 mb-2">' +
      '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-bold" data-platform>' +
      esc(platform) +
      "</span>" +
      verifiedBadge +
      "</div>" +
      '<h4 class="font-bold text-white text-sm leading-snug line-clamp-2" data-radar-title>' +
      esc(title) +
      "</h4>" +
      (publisher
        ? '<p class="text-[11px] text-slate-400" data-publisher>' + esc(publisher) + "</p>"
        : "") +
      (releaseDate
        ? '<p class="text-[11px] text-slate-500" data-release-date>' + esc(releaseDate) + "</p>"
        : "") +
      '<div class="flex flex-wrap items-center justify-between gap-2 mt-2">' +
      '<span class="text-sm font-black text-emerald-400" data-price>' +
      esc(priceStr) +
      "</span>" +
      omnibusBadge +
      countdownChip +
      "</div>" +
      '<div class="pt-3 mt-3 border-t border-slate-800/60 space-y-2">' +
      storeLink +
      affiliateDisclosureHtml() +
      "</div>" +
      "</div>"
    );
  }

  /**
   * Sprint 2 (EPIC-DEAL-001): render a Wishlist Drop card.
   * Green savings delta chip (data-savings), MSRP comparison (data-msrp),
   * current price (data-current-price), and direct deal link.
   */
  function buildWishlistDropCard(d) {
    var title = d.title || "Untitled Game";
    var currentPrice = Number(d.currentPrice);
    var msrp = Number(d.msrp);
    var savingsPct = Number(d.savingsPct);
    var bestStore = d.bestStore || "Store";
    var safeStoreUrl = sanitizeStoreUrl(d.storeUrl);
    var lowest30d = Number(d.lowest30d != null ? d.lowest30d : d.lowestPrice30d);

    var currentStr = Number.isFinite(currentPrice) ? "$" + currentPrice.toFixed(2) : "—";
    var msrpStr = Number.isFinite(msrp) && msrp > 0 ? "$" + msrp.toFixed(2) : "—";
    var savingsDelta =
      savingsPct > 0
        ? '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 text-[11px] font-black" data-savings>-' +
          savingsPct +
          "% OFF | " +
          currentStr +
          "</span>"
        : '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 text-slate-400 border border-slate-700 text-[11px] font-bold" data-savings>' +
          currentStr +
          "</span>";

    var omnibusBadge =
      Number.isFinite(lowest30d) && lowest30d > 0
        ? '<span class="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20 text-[10px] font-bold" data-30d-low title="Lowest verified price in the last 30 days">Lowest in 30 days: $' +
          lowest30d.toFixed(2) +
          "</span>"
        : "";

    var storeLink = safeStoreUrl
      ? '<a href="' +
        esc(safeStoreUrl) +
        '" target="_blank" rel="noopener noreferrer" class="wishlist-drop-link w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-md shadow-indigo-600/20 flex items-center justify-center gap-1.5" data-deal-link>View Deal <i data-lucide="external-link" class="w-3 h-3"></i></a>'
      : "";

    return (
      '<div class="wishlist-drop-card bg-slate-950/80 border border-emerald-500/20 hover:border-emerald-500/50 rounded-2xl p-4 flex flex-col justify-between transition-all shadow-md" data-wishlist-drop-card data-game-id="' +
      esc(d.gameId || title) +
      '">' +
      '<div class="flex items-start justify-between gap-2 mb-2">' +
      attributionLink(bestStore, d.storeUrl, bestStore) +
      omnibusBadge +
      "</div>" +
      '<h4 class="font-bold text-white text-sm leading-snug line-clamp-2" data-wishlist-drop-title>' +
      esc(title) +
      "</h4>" +
      '<div class="mt-3 space-y-2">' +
      '<div class="flex items-center justify-between gap-2">' +
      '<span class="text-[11px] text-slate-500">MSRP</span>' +
      '<span class="text-[11px] text-slate-400 line-through" data-msrp>' +
      esc(msrpStr) +
      "</span>" +
      "</div>" +
      '<div class="flex items-center justify-between gap-2">' +
      '<span class="text-[11px] text-slate-500">Current</span>' +
      '<span class="text-sm font-black text-emerald-400" data-current-price>' +
      esc(currentStr) +
      "</span>" +
      "</div>" +
      savingsDelta +
      "</div>" +
      '<div class="pt-3 mt-3 border-t border-slate-800/60 space-y-2">' +
      storeLink +
      affiliateDisclosureHtml() +
      "</div>" +
      "</div>"
    );
  }

  /**
   * Sprint 2 (EPIC-DEAL-001): render a DLC sale row/card.
   * data-dlc-sale marks the element for E2E selection.
   */
  function buildDlcSaleCard(d) {
    var name = d.name || "DLC";
    var baseTitle = d.baseGameTitle || "";
    var type = d.type || "DLC";
    var bestPrice = Number(d.bestPrice);
    var regularPrice = Number(d.regularPrice);
    var discountPercent = Number(d.discountPercent);
    var bestStore = d.bestStore || "Store";

    var priceStr = Number.isFinite(bestPrice) ? "$" + bestPrice.toFixed(2) : "—";
    var regularStr = Number.isFinite(regularPrice) ? "$" + regularPrice.toFixed(2) : "—";
    var discountBadge =
      discountPercent > 0
        ? '<span class="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 text-[10px] font-black" data-dlc-discount>-' +
          discountPercent +
          "%</span>"
        : "";

    var safeUrl = sanitizeStoreUrl(d.url);
    var storeLink = safeUrl
      ? '<a href="' +
        esc(safeUrl) +
        '" target="_blank" rel="noopener noreferrer" class="text-indigo-300 hover:text-indigo-200 underline decoration-indigo-500/40 underline-offset-2 text-[11px] font-bold" data-dlc-link>Buy \u2197</a>'
      : "";

    return (
      '<div class="dlc-sale-card bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-3 transition-all hover:border-indigo-500/40" data-dlc-sale>' +
      '<div class="min-w-0">' +
      '<p class="font-bold text-white text-xs truncate" data-dlc-name>' +
      esc(name) +
      "</p>" +
      (baseTitle
        ? '<p class="text-[10px] text-slate-500 truncate" data-dlc-base>' + esc(baseTitle) + "</p>"
        : "") +
      '<span class="inline-block mt-1 px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-bold" data-dlc-type>' +
      esc(type) +
      "</span>" +
      "</div>" +
      '<div class="text-right shrink-0">' +
      '<div class="flex items-center justify-end gap-1.5">' +
      '<span class="text-sm font-black text-emerald-400" data-dlc-price>' +
      esc(priceStr) +
      "</span>" +
      '<span class="text-[10px] text-slate-500 line-through" data-dlc-regular>' +
      esc(regularStr) +
      "</span>" +
      discountBadge +
      "</div>" +
      '<div class="flex items-center justify-end gap-1.5 mt-1">' +
      '<span class="text-[10px] text-slate-400" data-dlc-store>' +
      esc(bestStore) +
      "</span>" +
      storeLink +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  /**
   * Sprint 2 (EPIC-DEAL-001): render an Active Alerts row with an inline
   * editable target price and delete control.
   */
  function buildAlertRow(a) {
    var gameId = a.gameId || a.id || "";
    var title = a.title || "Untitled Alert";
    var targetPrice = Number(a.targetPrice);
    var currentPrice = Number(a.currentPrice);
    var isTriggered = Number(a.isTriggered) === 1;

    var targetStr = Number.isFinite(targetPrice) ? targetPrice.toFixed(2) : "0.00";
    var currentStr = Number.isFinite(currentPrice) ? "$" + currentPrice.toFixed(2) : "—";
    var statusBadge = isTriggered
      ? '<span class="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 text-[10px] font-black uppercase tracking-wider" data-alert-triggered>Below Target</span>'
      : '<span class="px-2 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-bold uppercase tracking-wider" data-alert-triggered>Watching</span>';

    return (
      '<div class="alert-row bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3" data-alert-row data-game-id="' +
      esc(gameId) +
      '">' +
      '<div class="flex-1 min-w-0">' +
      '<p class="font-bold text-white text-xs truncate" data-alert-title>' +
      esc(title) +
      "</p>" +
      '<div class="flex items-center gap-2 mt-1">' +
      statusBadge +
      '<span class="text-[10px] text-slate-400" data-alert-current>Current: ' +
      esc(currentStr) +
      "</span>" +
      "</div>" +
      "</div>" +
      '<div class="flex items-center gap-2 shrink-0">' +
      '<label class="text-[10px] font-semibold text-slate-500">Target $</label>' +
      '<input type="number" step="0.01" min="0" value="' +
      esc(targetStr) +
      '" data-alert-target class="w-24 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-pink-500" />' +
      '<button type="button" data-alert-save class="px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold transition-all flex items-center gap-1 active:scale-95"><i data-lucide="save" class="w-3 h-3"></i> Save</button>' +
      '<button type="button" data-alert-delete class="px-2.5 py-1.5 rounded-lg bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 text-xs font-bold border border-rose-500/30 transition-all active:scale-95" aria-label="Delete alert for ' +
      esc(title) +
      '"><i data-lucide="trash-2" class="w-3 h-3"></i></button>' +
      "</div>" +
      "</div>"
    );
  }

  /**
   * Sprint 2 (WUD-2.2 / EPIC-02): 24-month price-history sparkline element.
   * Delegates to the shared safe buildPriceSparklineEl geometry with a wider
   * default aspect ratio and a "24M" label so arbitrage cards render a
   * readable long-range trend without a charting library.
   */
  function buildPriceHistorySparklineEl(points, options) {
    var opts = options || {};
    var width = typeof opts.width === "number" ? opts.width : 160;
    var height = typeof opts.height === "number" ? opts.height : 36;
    var el = buildPriceSparklineEl(points, {
      width: width,
      height: height,
      strokeColor: opts.strokeColor || "#f472b6",
      strokeWidth: typeof opts.strokeWidth === "number" ? opts.strokeWidth : 2,
      label: opts.label || "24M",
    });
    return el;
  }

  /**
   * Sprint 2 (WUD-2.2 / EPIC-02): arbitrage deal card with 24-month sparkline
   * slot, 30-day low, verified all-time low, "Lowest Price Ever" badge, and a
   * price-alert Watch button (delegated by app.js's .deal-alert-btn handler).
   * Every outbound link passes the strict client storefront allowlist.
   */
  function buildArbitrageCard(deal) {
    var title = deal && deal.title ? deal.title : "Untitled Deal";
    var store = deal && deal.store ? deal.store : "Store";
    var gameKey = deal && deal.gameKey ? deal.gameKey : title;
    var currentPrice = Number(deal && deal.currentPrice);
    var currentStr = Number.isFinite(currentPrice) ? "$" + currentPrice.toFixed(2) : "—";
    var lowest30d = deal && deal.lowest30d != null ? Number(deal.lowest30d) : null;
    var historyLow = deal && deal.historyLow != null ? Number(deal.historyLow) : null;

    var lowestEverBadge =
      deal && deal.isLowestEver
        ? '<span class="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-black uppercase tracking-wider whitespace-nowrap" data-lowest-ever>🏆 Lowest Price Ever</span>'
        : "";

    var low30Label =
      lowest30d !== null
        ? '<span class="text-[10px] text-slate-500" data-low-30d>30-day low $' +
          lowest30d.toFixed(2) +
          "</span>"
        : "";
    var allTimeLabel =
      historyLow !== null
        ? '<span class="text-[10px] text-slate-500" data-all-time-low>All-time low $' +
          historyLow.toFixed(2) +
          "</span>"
        : "";

    var safeUrl = sanitizeStoreUrl(deal && deal.storeUrl);
    var viewLink = safeUrl
      ? '<a href="' +
        esc(safeUrl) +
        '" target="_blank" rel="noopener noreferrer" class="w-full py-1.5 rounded-xl bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold transition-all shadow-md shadow-pink-600/20 flex items-center justify-center gap-1" data-arb-view>View Deal <i data-lucide="external-link" class="w-3 h-3"></i></a>'
      : "";

    return (
      '<div class="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden shadow-xl hover:border-pink-500/40 transition-all" data-arb-card data-game-key="' +
      esc(gameKey) +
      '">' +
      '<div class="p-4 space-y-3">' +
      '<div class="flex items-start justify-between gap-2">' +
      '<div class="min-w-0">' +
      '<p class="font-bold text-white text-sm truncate" data-arb-title>' +
      esc(title) +
      "</p>" +
      '<span class="text-[10px] font-bold text-slate-400" data-arb-store>' +
      esc(store) +
      "</span>" +
      "</div>" +
      lowestEverBadge +
      "</div>" +
      '<div class="bg-slate-950/60 border border-slate-800 rounded-lg p-2">' +
      '<span class="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Price History (24 months)</span>' +
      '<div data-arb-history-slot data-game-key="' +
      esc(gameKey) +
      '"></div>' +
      "</div>" +
      '<div class="flex items-center justify-between gap-2">' +
      '<div class="deal-price"><span class="text-lg font-black text-emerald-400">' +
      esc(currentStr) +
      "</span></div>" +
      '<button data-app-id="' +
      esc(gameKey) +
      '" data-title="' +
      esc(title) +
      '" class="deal-alert-btn px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] font-semibold border border-slate-700 transition-all flex items-center gap-1" title="Set Price Threshold Alert"><i data-lucide="bell" class="w-3 h-3 text-amber-400"></i><span>Set Alert</span></button>' +
      "</div>" +
      '<div class="flex items-center justify-between gap-2">' +
      low30Label +
      allTimeLabel +
      "</div>" +
      (viewLink ? viewLink : "") +
      "</div>" +
      "</div>"
    );
  }

  window.__deals = {
    buildPriceSparkline: buildPriceSparkline,
    buildPriceSparklineEl: buildPriceSparklineEl,
    buildPriceHistorySparklineEl: buildPriceHistorySparklineEl,
    buildArbitrageCard: buildArbitrageCard,
    sanitizeSvg: sanitizeSvg,
    sanitizeStoreUrl: sanitizeStoreUrl,
    attributionLink: attributionLink,
    coverArtHtml: coverArtHtml,
    storeBadgeFor: storeBadgeFor,
    modTaxonomyFor: modTaxonomyFor,
    countdownFor: countdownFor,
    esc: esc,
    buildRadarCard: buildRadarCard,
    buildWishlistDropCard: buildWishlistDropCard,
    buildDlcSaleCard: buildDlcSaleCard,
    buildAlertRow: buildAlertRow,
  };
})();
