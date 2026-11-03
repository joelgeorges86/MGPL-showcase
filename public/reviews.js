/**
 * Sprint 4 (EPIC-DEV-001): Hardware Deals, Price History, Alerts & Community
 * Reviews controller.
 *
 * Powers the device detail modal:
 *   - Seller links (Amazon, Best Buy, Newegg) + "Best Time to Buy" badge
 *   - 12-month pure inline SVG price history chart
 *   - Price drop alert submission (POST /api/devices/:id/alerts)
 *   - Community reviews with aggregate score, Verified Owner badge,
 *     Editor's Pick gold pin, and thumbs up/down voting.
 *
 * Exposes window.__reviews so public/devices.js can open the detail modal for a
 * catalog card and the Reviews sub-tab can render the same list.
 */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function escAttr(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escText(value) {
    return escAttr(value).replace(/'/g, "&#39;");
  }

  function showToast(message, isError) {
    if (window.showToast && typeof window.showToast === "function") {
      window.showToast(message, isError);
      return;
    }
    console.log("[reviews.js]", message);
  }

  let activeDevice = null; // { id, name, brand, type }

  // -------------------------------------------------------------------------
  // Device detail modal open/close
  // -------------------------------------------------------------------------
  function openDevice(deviceId, deviceName, brand, type) {
    activeDevice = {
      id: deviceId,
      name: deviceName,
      brand: brand || "",
      type: type || "",
    };

    const modal = $("device-detail-modal");
    const title = $("device-detail-title");
    const subtitle = $("device-detail-subtitle");
    if (title) title.textContent = deviceName;
    if (subtitle) subtitle.textContent = (brand ? brand + " · " : "") + (type || "");

    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("flex");
    }

    // Reset dynamic panels before async hydration.
    if ($("device-best-time-buy")) $("device-best-time-buy").textContent = "Loading…";
    if ($("device-current-best")) $("device-current-best").textContent = "—";
    if ($("device-seller-links")) $("device-seller-links").innerHTML = "";
    if ($("device-price-history-container")) {
      $("device-price-history-container").innerHTML =
        '<div class="text-xs text-slate-500">Loading price history…</div>';
    }
    if ($("device-review-aggregate")) $("device-review-aggregate").textContent = "";
    if ($("device-reviews-list")) {
      $("device-reviews-list").innerHTML =
        '<div class="text-xs text-slate-500">Loading reviews…</div>';
    }
    if ($("device-alert-status")) $("device-alert-status").textContent = "";

    loadPricing(deviceId);
    loadPriceHistory(deviceId);
    loadReviews(deviceId, "device-reviews-list", "device-review-aggregate");
  }

  function closeDeviceDetail() {
    const modal = $("device-detail-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
    activeDevice = null;
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------
  async function loadPricing(deviceId) {
    try {
      const res = await fetch("/api/devices/" + encodeURIComponent(deviceId) + "/pricing");
      const data = await res.json();
      if (!data.success) return;

      if ($("device-best-time-buy")) {
        const badgeEl = $("device-best-time-buy");
        badgeEl.textContent = data.classification || "Fair Price";
        const isBest = data.classification === "Best Time to Buy";
        badgeEl.className =
          "px-2.5 py-1 rounded-lg text-[11px] font-black border " +
          (isBest
            ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
            : "bg-amber-500/10 text-amber-300 border-amber-500/30");
      }
      if ($("device-current-best")) {
        $("device-current-best").textContent = "$" + Number(data.currentBestPrice || 0).toFixed(2);
      }

      const linksEl = $("device-seller-links");
      if (linksEl && Array.isArray(data.sellers)) {
        linksEl.innerHTML = data.sellers
          .map(function (seller) {
            const isBest = seller.retailer === data.currentBestRetailer;
            return (
              '<a href="' +
              escAttr(seller.url) +
              '" target="_blank" rel="noopener noreferrer" ' +
              'data-testid="device-seller-link" data-retailer="' +
              escAttr(seller.retailer) +
              '" ' +
              'class="px-3 py-2 rounded-lg border text-xs font-bold transition-all flex items-center gap-2 ' +
              (isBest
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/40"
                : "bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-600") +
              '">' +
              "<span>" +
              escText(seller.retailer) +
              "</span>" +
              '<span class="' +
              (isBest ? "text-emerald-400" : "text-slate-400") +
              ' font-black">' +
              escText(seller.priceLabel) +
              "</span>" +
              "</a>"
            );
          })
          .join("");
      }
    } catch (err) {
      console.error("Failed to load pricing:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Price history SVG
  // -------------------------------------------------------------------------
  function buildPriceHistorySvg(points) {
    const width = 600;
    const height = 120;
    const pad = 10;

    if (!points || points.length === 0) {
      return (
        '<svg viewBox="0 0 ' +
        width +
        " " +
        height +
        '" class="w-full h-28" role="img" aria-label="No price history">' +
        '<text x="' +
        width / 2 +
        '" y="' +
        height / 2 +
        '" text-anchor="middle" fill="#64748b" font-size="12" font-family="sans-serif">No price history available</text>' +
        "</svg>"
      );
    }

    const values = points.map(function (p) {
      return Number(p.priceUsd);
    });
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const range = max - min || 1;

    const stepX = (width - pad * 2) / Math.max(1, points.length - 1);
    const coords = points.map(function (p, i) {
      const x = pad + i * stepX;
      const y = pad + (1 - (Number(p.priceUsd) - min) / range) * (height - pad * 2);
      return { x: x, y: y, price: Number(p.priceUsd) };
    });

    const polylinePoints = coords
      .map(function (c) {
        return c.x.toFixed(1) + "," + c.y.toFixed(1);
      })
      .join(" ");

    // Month labels (first, middle, last). Month uses YYYY-MM.
    const labelFor = function (c, idx) {
      if (idx !== 0 && idx !== coords.length - 1 && idx !== Math.floor(coords.length / 2))
        return null;
      const raw = points[idx].month || "";
      const parts = String(raw).split("-");
      if (parts.length < 2) return null;
      const months = [
        "",
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      return months[Number(parts[1]) || 1];
    };

    const labels = coords
      .map(function (c, idx) {
        const label = labelFor(c, idx);
        if (!label) return "";
        return (
          '<text x="' +
          c.x.toFixed(1) +
          '" y="' +
          (height - 2) +
          '" text-anchor="middle" fill="#64748b" font-size="10" font-family="sans-serif">' +
          escText(label) +
          "</text>"
        );
      })
      .join("");

    return (
      '<svg viewBox="0 0 ' +
      width +
      " " +
      height +
      '" class="w-full h-28" role="img" aria-label="12-month price history">' +
      '<polyline points="' +
      polylinePoints +
      '" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />' +
      coords
        .map(function (c) {
          return (
            '<circle cx="' +
            c.x.toFixed(1) +
            '" cy="' +
            c.y.toFixed(1) +
            '" r="2.5" fill="#34d399" />'
          );
        })
        .join("") +
      labels +
      "</svg>"
    );
  }

  async function loadPriceHistory(deviceId) {
    try {
      const res = await fetch("/api/devices/" + encodeURIComponent(deviceId) + "/price-history");
      const data = await res.json();
      const container = $("device-price-history-container");
      if (!container) return;
      if (!data.success || !Array.isArray(data.points)) {
        container.innerHTML =
          '<div class="text-xs text-slate-500">Price history unavailable.</div>';
        return;
      }
      container.innerHTML = buildPriceHistorySvg(data.points);
    } catch (err) {
      console.error("Failed to load price history:", err);
      const container = $("device-price-history-container");
      if (container)
        container.innerHTML =
          '<div class="text-xs text-rose-400">Failed to load price history.</div>';
    }
  }

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------
  function parseProsCons(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        /* fall through */
      }
    }
    return [];
  }

  function reviewCardHtml(review) {
    const pros = parseProsCons(review.pros);
    const cons = parseProsCons(review.cons);
    const verifiedBadge = review.isVerifiedOwner
      ? '<span data-testid="verified-owner-badge" class="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/30 text-[10px] font-bold">✔ Verified Owner</span>'
      : "";
    const editorsPickBadge = review.isEditorsPick
      ? '<span data-testid="editors-pick-badge" class="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-bold">★ Editor\u2019s Pick</span>'
      : "";

    const chips =
      pros
        .map(function (p) {
          return (
            '<span class="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 text-[10px] font-semibold">+' +
            escText(p) +
            "</span>"
          );
        })
        .join("") +
      cons
        .map(function (c) {
          return (
            '<span class="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 text-[10px] font-semibold">-' +
            escText(c) +
            "</span>"
          );
        })
        .join("");

    return (
      '<div data-testid="device-review" data-review-id="' +
      escAttr(review.reviewId) +
      '" ' +
      'class="bg-slate-950/60 border ' +
      (review.isEditorsPick ? "border-amber-500/30" : "border-slate-800") +
      ' rounded-xl p-3 space-y-2">' +
      '<div class="flex flex-wrap items-center justify-between gap-2">' +
      '<div class="flex items-center gap-2">' +
      '<span class="px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 text-[11px] font-black">' +
      Number(review.rating).toFixed(1) +
      " ★</span>" +
      '<span class="text-xs font-bold text-white">' +
      escText(review.title || "Untitled Review") +
      "</span>" +
      "</div>" +
      '<div class="flex items-center gap-1.5">' +
      verifiedBadge +
      editorsPickBadge +
      "</div>" +
      "</div>" +
      (review.body
        ? '<p class="text-xs text-slate-300 leading-relaxed">' + escText(review.body) + "</p>"
        : "") +
      (chips ? '<div class="flex flex-wrap items-center gap-1.5">' + chips + "</div>" : "") +
      '<div class="flex items-center justify-between gap-2 pt-1">' +
      '<span class="text-[10px] text-slate-500 font-semibold">\u2014 ' +
      escText(review.author || "MGPL Member") +
      "</span>" +
      '<div class="flex items-center gap-2">' +
      '<button type="button" data-testid="review-upvote" data-review-id="' +
      escAttr(review.reviewId) +
      '" ' +
      'class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-emerald-300 text-[10px] font-bold transition-all">👍 Helpful</button>' +
      '<span data-testid="review-helpful-score" data-review-id="' +
      escAttr(review.reviewId) +
      '" class="text-xs font-black text-slate-300">' +
      Number(review.helpfulScore || 0) +
      "</span>" +
      '<button type="button" data-testid="review-downvote" data-review-id="' +
      escAttr(review.reviewId) +
      '" ' +
      'class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-rose-300 text-[10px] font-bold transition-all">👎</button>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  async function loadReviews(deviceId, listId, aggregateId) {
    const listEl = $(listId);
    if (!listEl) return;
    try {
      const res = await fetch(
        "/api/devices/" + encodeURIComponent(deviceId) + "/reviews?pageSize=50&sort=helpful",
      );
      const data = await res.json();
      if (!data.success) {
        listEl.innerHTML = '<div class="text-xs text-slate-500">No reviews yet.</div>';
        return;
      }

      if (aggregateId && $(aggregateId)) {
        const agg = data.aggregate || {};
        $(aggregateId).textContent =
          agg.average != null
            ? Number(agg.average).toFixed(1) +
              " ★ · " +
              agg.count +
              " review" +
              (agg.count === 1 ? "" : "s")
            : "";
      }

      const reviews = Array.isArray(data.reviews) ? data.reviews : [];
      if (reviews.length === 0) {
        listEl.innerHTML =
          '<div class="text-center py-6 text-slate-500 text-xs">No community reviews yet. Be the first to review this device.</div>';
        return;
      }
      listEl.innerHTML = reviews.map(reviewCardHtml).join("");
    } catch (err) {
      console.error("Failed to load reviews:", err);
      listEl.innerHTML = '<div class="text-xs text-rose-400">Failed to load reviews.</div>';
    }
  }

  // -------------------------------------------------------------------------
  // Review submit modal
  // -------------------------------------------------------------------------
  let starRating = 0;

  function renderStarRating() {
    const wrap = $("review-star-rating");
    if (!wrap) return;
    wrap.innerHTML = [1, 2, 3, 4, 5]
      .map(function (n) {
        const active = n <= starRating;
        return (
          '<button type="button" data-star="' +
          n +
          '" aria-label="' +
          n +
          " star" +
          (n > 1 ? "s" : "") +
          '" ' +
          'class="text-2xl leading-none ' +
          (active ? "text-amber-400" : "text-slate-600") +
          ' hover:text-amber-400 transition-colors">★</button>'
        );
      })
      .join("");
    wrap.querySelectorAll("[data-star]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        starRating = Number(btn.getAttribute("data-star"));
        if ($("review-rating-value")) $("review-rating-value").value = String(starRating);
        renderStarRating();
      });
    });
  }

  function openReviewModal(deviceId) {
    if ($("review-device-id")) $("review-device-id").value = deviceId;
    if ($("review-rating-value")) $("review-rating-value").value = "0";
    if ($("review-title")) $("review-title").value = "";
    if ($("review-body")) $("review-body").value = "";
    if ($("review-pros")) $("review-pros").value = "";
    if ($("review-cons")) $("review-cons").value = "";
    if ($("review-submit-status")) $("review-submit-status").textContent = "";
    starRating = 0;
    renderStarRating();

    const modal = $("review-submit-modal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("flex");
    }
  }

  function closeReviewModal() {
    const modal = $("review-submit-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
  }

  async function submitReview(e) {
    e.preventDefault();
    const deviceId = $("review-device-id")
      ? $("review-device-id").value
      : activeDevice
        ? activeDevice.id
        : "";
    const rating = Number($("review-rating-value") ? $("review-rating-value").value : 0);
    const title = $("review-title") ? $("review-title").value.trim() : "";
    const body = $("review-body") ? $("review-body").value.trim() : "";
    const pros = $("review-pros")
      ? $("review-pros")
          .value.split(",")
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
      : [];
    const cons = $("review-cons")
      ? $("review-cons")
          .value.split(",")
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
      : [];

    const statusEl = $("review-submit-status");
    if (rating < 1 || rating > 5) {
      if (statusEl) {
        statusEl.textContent = "Please select a rating (1-5 stars).";
        statusEl.className = "text-[11px] font-medium text-rose-400";
      }
      return;
    }
    if (!title && !body) {
      if (statusEl) {
        statusEl.textContent = "Please provide a title or review body.";
        statusEl.className = "text-[11px] font-medium text-rose-400";
      }
      return;
    }

    try {
      const res = await fetch("/api/devices/" + encodeURIComponent(deviceId) + "/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: rating,
          title: title,
          body: body,
          pros: pros,
          cons: cons,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (statusEl) {
          statusEl.textContent = data.error || "Failed to submit review.";
          statusEl.className = "text-[11px] font-medium text-rose-400";
        }
        return;
      }
      showToast(
        "Review submitted" +
          (data.review && data.review.isVerifiedOwner ? " (Verified Owner)" : ""),
      );
      closeReviewModal();
      if (activeDevice) {
        loadReviews(activeDevice.id, "device-reviews-list", "device-review-aggregate");
      }
    } catch (err) {
      console.error("Submit review error:", err);
      if (statusEl) {
        statusEl.textContent = "Failed to submit review.";
        statusEl.className = "text-[11px] font-medium text-rose-400";
      }
    }
  }

  // -------------------------------------------------------------------------
  // Price alert
  // -------------------------------------------------------------------------
  async function setPriceAlert() {
    if (!activeDevice) return;
    const input = $("device-alert-target");
    const statusEl = $("device-alert-status");
    const target = input ? Number(input.value) : 0;
    if (!Number.isFinite(target) || target <= 0) {
      if (statusEl) {
        statusEl.textContent = "Enter a valid target price.";
        statusEl.className = "text-[11px] font-medium text-rose-400";
      }
      return;
    }
    try {
      const res = await fetch("/api/devices/" + encodeURIComponent(activeDevice.id) + "/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPrice: target }),
      });
      const data = await res.json();
      if (res.status === 401) {
        if (statusEl) {
          statusEl.textContent = "Sign in to save a price alert.";
          statusEl.className = "text-[11px] font-medium text-amber-400";
        }
        return;
      }
      if (!res.ok || !data.success) {
        if (statusEl) {
          statusEl.textContent = data.error || "Failed to save alert.";
          statusEl.className = "text-[11px] font-medium text-rose-400";
        }
        return;
      }
      if (statusEl) {
        statusEl.textContent = data.message || "Price alert saved.";
        statusEl.className = "text-[11px] font-medium text-emerald-400";
      }
    } catch (err) {
      console.error("Set alert error:", err);
      if (statusEl) {
        statusEl.textContent = "Failed to save alert.";
        statusEl.className = "text-[11px] font-medium text-rose-400";
      }
    }
  }

  // -------------------------------------------------------------------------
  // Voting (delegated)
  // -------------------------------------------------------------------------
  async function castVote(reviewId, voteType) {
    try {
      const res = await fetch("/api/reviews/" + encodeURIComponent(reviewId) + "/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voteType: voteType }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.error || "Failed to vote", true);
        return;
      }
      const scoreEl = document.querySelector(
        '[data-testid="review-helpful-score"][data-review-id="' + reviewId + '"]',
      );
      if (scoreEl) scoreEl.textContent = String(data.helpfulScore);
      showToast("Vote recorded");
    } catch (err) {
      console.error("Vote error:", err);
      showToast("Failed to vote", true);
    }
  }

  // -------------------------------------------------------------------------
  // Reviews sub-tab (devices-panel-reviews)
  // -------------------------------------------------------------------------
  let reviewsTabDeviceId = null;

  async function populateReviewsDeviceSelect() {
    const select = $("devices-reviews-device-select");
    if (!select) return;
    try {
      const res = await fetch("/api/catalog/devices?pageSize=100");
      const data = await res.json();
      const devices = Array.isArray(data.devices) ? data.devices : [];
      select.innerHTML =
        '<option value="">Select a device…</option>' +
        devices
          .map(function (d) {
            return '<option value="' + escAttr(d.id) + '">' + escText(d.name) + "</option>";
          })
          .join("");
    } catch (err) {
      console.error("Failed to load reviews device list:", err);
    }
  }

  function loadReviewsTabFor(deviceId, _deviceName) {
    reviewsTabDeviceId = deviceId || null;
    if (deviceId && $("devices-reviews-write-btn")) {
      // Keep the write button available for the selected device.
    }
    if (deviceId) {
      loadReviews(deviceId, "devices-reviews-list", "devices-reviews-aggregate");
    } else {
      if ($("devices-reviews-list")) {
        $("devices-reviews-list").innerHTML =
          '<div class="text-center py-10 text-slate-500 text-xs">Select a device above to read its community reviews.</div>';
      }
      if ($("devices-reviews-aggregate")) $("devices-reviews-aggregate").textContent = "";
    }
  }

  function initReviewsTab() {
    populateReviewsDeviceSelect();
    const select = $("devices-reviews-device-select");
    if (select) {
      select.addEventListener("change", function () {
        const id = select.value;
        const name = select.options[select.selectedIndex]
          ? select.options[select.selectedIndex].textContent
          : "";
        loadReviewsTabFor(id, name);
      });
    }
    const writeBtn = $("devices-reviews-write-btn");
    if (writeBtn) {
      writeBtn.addEventListener("click", function () {
        if (!reviewsTabDeviceId) {
          showToast("Select a device first.", true);
          return;
        }
        openReviewModal(reviewsTabDeviceId);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Event wiring & init
  // -------------------------------------------------------------------------
  function wireEvents() {
    const closeBtn = $("device-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", closeDeviceDetail);

    const writeBtn = $("device-review-write-btn");
    if (writeBtn) {
      writeBtn.addEventListener("click", function () {
        if (activeDevice) openReviewModal(activeDevice.id);
      });
    }

    const alertBtn = $("device-alert-btn");
    if (alertBtn) alertBtn.addEventListener("click", setPriceAlert);

    const reviewForm = $("review-submit-form");
    if (reviewForm) reviewForm.addEventListener("submit", submitReview);

    const reviewClose = $("review-submit-close");
    if (reviewClose) reviewClose.addEventListener("click", closeReviewModal);
    const reviewCancel = $("review-submit-cancel");
    if (reviewCancel) reviewCancel.addEventListener("click", closeReviewModal);

    // Delegate review list vote clicks.
    ["device-reviews-list", "devices-reviews-list"].forEach(function (listId) {
      const listEl = $(listId);
      if (!listEl) return;
      listEl.addEventListener("click", function (e) {
        const up = e.target.closest('[data-testid="review-upvote"]');
        if (up) {
          castVote(up.getAttribute("data-review-id"), "up");
          return;
        }
        const down = e.target.closest('[data-testid="review-downvote"]');
        if (down) {
          castVote(down.getAttribute("data-review-id"), "down");
        }
      });
    });
  }

  function init() {
    wireEvents();
  }

  // Expose the public surface. Render the Reviews sub-tab list for a device by
  // reusing loadReviews directly.
  window.__reviews = {
    init: init,
    openDevice: openDevice,
    loadReviews: loadReviews,
    initReviewsTab: initReviewsTab,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
