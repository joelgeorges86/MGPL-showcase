// Unified Cross-Hub Game Detail Drawer (FEAT-0148)
// Self-contained module loaded after app.js. Uses the same API_BASE convention.
(function () {
  "use strict";

  var API_BASE = "";

  function openGameDetailDrawer(gameTitle) {
    var drawerEl = document.getElementById("game-detail-drawer");
    if (!drawerEl || !gameTitle) return;

    // Save the currently focused element so focus can be restored on close.
    if (typeof window.saveFocus === "function") window.saveFocus();

    var titleEl = document.getElementById("game-detail-title");

    var subtitleEl = document.getElementById("game-detail-subtitle");
    var loadingEl = document.getElementById("drawer-loading");
    var errorEl = document.getElementById("drawer-error");
    var errorMsgEl = document.getElementById("drawer-error-msg");
    var contentEl = document.getElementById("drawer-content");
    var fleetRatingEl = document.getElementById("drawer-fleet-rating");
    var fleetDeviceEl = document.getElementById("drawer-fleet-device");
    var dealsEl = document.getElementById("drawer-deals");

    // Interactive Compatibility Section in Drawer (Explicit Action Rule)
    var compatDeviceSelect = document.getElementById("drawer-compat-device");
    var compatPowerSelect = document.getElementById("drawer-compat-power");
    var compatPowerWrapper = document.getElementById("drawer-compat-power-wrapper");
    var compatAnalyzeBtn = document.getElementById("drawer-compat-analyze");
    var compatResult = document.getElementById("drawer-compat-result");
    var compatDevicesCache = [];

    function updatePowerToggleVisibility() {
      if (!compatPowerWrapper || !compatDeviceSelect) return;
      var selectedId = compatDeviceSelect.value;
      var selectedDevice = compatDevicesCache.find(function (d) {
        return (d.id || d.deviceId) === selectedId;
      });
      if (selectedDevice && selectedDevice.isPortable) {
        compatPowerWrapper.classList.remove("hidden");
      } else {
        compatPowerWrapper.classList.add("hidden");
        if (compatPowerSelect) compatPowerSelect.checked = false;
      }
    }

    if (compatDeviceSelect) {
      compatDeviceSelect.innerHTML = '<option value="">Loading devices...</option>';
      apiFetch("/api/devices")
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data && Array.isArray(data.devices)) {
            var activeDevs = data.devices.filter(function (d) {
              return !d.isArchived;
            });
            compatDevicesCache = activeDevs;
            if (activeDevs.length > 0) {
              compatDeviceSelect.innerHTML =
                '<option value="">Select hardware profile...</option>' +
                activeDevs
                  .map(function (d) {
                    var dId = d.id || d.deviceId;
                    var dName = d.deviceName || dId;
                    return (
                      '<option value="' +
                      dId +
                      '">' +
                      dName +
                      " (" +
                      (d.gpuModel || "N/A") +
                      ")</option>"
                    );
                  })
                  .join("");
              var activeId = localStorage.getItem("activeDeviceId");
              if (
                activeId &&
                activeDevs.some(function (d) {
                  return (d.id || d.deviceId) === activeId;
                })
              ) {
                compatDeviceSelect.value = activeId;
              }
            } else {
              compatDeviceSelect.innerHTML = '<option value="">No Active Devices</option>';
            }
          } else {
            compatDeviceSelect.innerHTML = '<option value="">No Active Devices</option>';
          }
          updatePowerToggleVisibility();
        })
        .catch(function (err) {
          console.error("Failed to load devices for drawer compat select:", err);
          compatDeviceSelect.innerHTML = '<option value="">Failed to load devices</option>';
        });

      compatDeviceSelect.addEventListener("change", updatePowerToggleVisibility);
    }

    if (compatAnalyzeBtn && compatResult) {
      compatAnalyzeBtn.onclick = function () {
        var deviceId = compatDeviceSelect ? compatDeviceSelect.value : "";
        var powerProfile =
          compatPowerSelect && compatPowerSelect.checked ? "Battery Saver" : "Plugged-In";
        var gameId = drawerEl.getAttribute("data-game-id") || "";

        if (!deviceId) {
          compatResult.classList.remove("hidden");
          compatResult.innerHTML =
            '<div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 text-xs font-semibold">Please select a device for compatibility analysis.</div>';
          return;
        }
        if (!gameId) {
          compatResult.classList.remove("hidden");
          compatResult.innerHTML =
            '<div class="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs font-semibold">Unable to determine game ID for compatibility analysis.</div>';
          return;
        }

        compatAnalyzeBtn.disabled = true;
        compatAnalyzeBtn.innerHTML =
          '<div class="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white"></div><span>Analyzing...</span>';

        apiFetch(
          "/api/devices/" +
            encodeURIComponent(deviceId) +
            "/compatibility/" +
            encodeURIComponent(gameId),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ powerProfile: powerProfile }),
          },
        )
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            compatResult.classList.remove("hidden");
            if (data && data.evaluation) {
              var ev = data.evaluation;

              if (ev.rating === "Incomplete Specs") {
                compatResult.innerHTML = [
                  '<div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 space-y-1.5" data-testid="incomplete-specs-banner">',
                  '<div class="flex items-center gap-1.5 text-xs font-black uppercase tracking-wide">',
                  '<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i><span>Incomplete Specs</span>',
                  "</div>",
                  '<p class="text-[11px] font-medium text-amber-200">' +
                    (ev.notes && ev.notes[0]
                      ? ev.notes[0]
                      : "This device is missing required hardware specification fields.") +
                    "</p>",
                  '<p class="text-[11px] text-amber-300/80">Edit this device\'s profile on the Fleet Dashboard to add the missing specs, then re-run the analysis.</p>',
                  "</div>",
                ].join("");
                if (window.lucide) window.lucide.createIcons();
                return;
              }

              var badgeBg =
                ev.rating === "Optimal"
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                  : ev.rating === "Playable"
                    ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
                    : ev.rating === "Bottlenecked"
                      ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                      : "bg-rose-500/20 text-rose-300 border-rose-500/40";

              function axisRow(label, axis) {
                if (!axis) return "";
                var margin = axis.marginGbOrPct;
                var marginText =
                  margin === null || margin === undefined
                    ? "N/A"
                    : margin >= 0
                      ? "+" + margin + " GB"
                      : margin + " GB";
                var color =
                  axis.status === "optimal"
                    ? "text-emerald-400"
                    : axis.status === "playable"
                      ? "text-cyan-400"
                      : axis.status === "bottleneck"
                        ? "text-amber-400"
                        : axis.status === "unsupported"
                          ? "text-rose-400"
                          : "text-slate-400";
                return (
                  '<div><span class="text-slate-500">' +
                  label +
                  ':</span> <span class="font-bold ' +
                  color +
                  '">' +
                  marginText +
                  "</span></div>"
                );
              }

              compatResult.innerHTML = [
                '<div class="p-3 bg-slate-900/90 border border-slate-800 rounded-xl space-y-2" data-testid="compat-result">',
                '<div class="flex items-center justify-between">',
                '<span class="text-xs font-bold text-slate-400">Rating:</span>',
                '<span class="px-2.5 py-0.5 rounded-full text-xs font-black border ' +
                  badgeBg +
                  '" data-testid="compat-rating">' +
                  ev.rating +
                  "</span>",
                "</div>",
                '<div class="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-slate-800" data-testid="compat-axes">',
                axisRow("CPU", ev.axes && ev.axes.cpu),
                axisRow("RAM", ev.axes && ev.axes.ram),
                axisRow("VRAM", ev.axes && ev.axes.vram),
                axisRow("Storage", ev.axes && ev.axes.storage),
                "</div>",
                ev.primaryBottleneck
                  ? '<p class="text-[11px] text-amber-300 font-semibold pt-1 border-t border-slate-800/60">Primary Bottleneck: ' +
                    ev.primaryBottleneck +
                    "</p>"
                  : "",
                ev.notes && ev.notes.length
                  ? '<p class="text-[11px] text-slate-300 italic pt-1 border-t border-slate-800/60">' +
                    ev.notes.join(" ") +
                    "</p>"
                  : "",
                "</div>",
              ].join("");
            } else {
              compatResult.innerHTML =
                '<div class="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs font-semibold">' +
                (data.error || "Compatibility calculation failed.") +
                "</div>";
            }
            if (window.lucide) window.lucide.createIcons();
          })
          .catch(function (err) {
            console.error("Compatibility analysis error:", err);
            compatResult.classList.remove("hidden");
            compatResult.innerHTML =
              '<div class="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs font-semibold">Error evaluating compatibility.</div>';
          })
          .finally(function () {
            compatAnalyzeBtn.disabled = false;
            compatAnalyzeBtn.innerHTML =
              '<i data-lucide="cpu" class="w-3.5 h-3.5"></i><span>Analyze Compatibility</span>';
            if (window.lucide) window.lucide.createIcons();
          });
      };
    }

    var modsEl = document.getElementById("drawer-mods");
    var hltbMainEl = document.getElementById("drawer-hltb-main");
    var hltbExtraEl = document.getElementById("drawer-hltb-extra");
    var hltbCompleteEl = document.getElementById("drawer-hltb-complete");

    // Reset drawer state
    drawerEl.classList.remove("hidden");
    drawerEl.setAttribute("aria-hidden", "false");
    if (titleEl) titleEl.textContent = gameTitle;
    if (subtitleEl) subtitleEl.textContent = "Aggregated across hubs";
    if (loadingEl) loadingEl.classList.remove("hidden");
    if (errorEl) errorEl.classList.add("hidden");
    if (contentEl) contentEl.classList.add("hidden");
    if (fleetRatingEl) fleetRatingEl.textContent = "—";
    if (fleetDeviceEl) fleetDeviceEl.textContent = "—";
    if (hltbMainEl) hltbMainEl.textContent = "—";
    if (hltbExtraEl) hltbExtraEl.textContent = "—";
    if (hltbCompleteEl) hltbCompleteEl.textContent = "—";

    // Move focus into the drawer (close button) and trap Tab navigation.
    var closeBtn = document.getElementById("game-detail-close");
    if (closeBtn) closeBtn.focus();
    drawerEl.addEventListener("keydown", drawerKeydownHandler);

    fetch(API_BASE + "/api/games/detail?title=" + encodeURIComponent(gameTitle))
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (loadingEl) loadingEl.classList.add("hidden");
        if (errorEl) errorEl.classList.add("hidden");
        if (contentEl) contentEl.classList.remove("hidden");

        // Fleet Headroom
        if (fleetRatingEl && data.fleetHeadroom) {
          var rating = data.fleetHeadroom.rating || "30-60 FPS Playable";
          fleetRatingEl.textContent = rating;
          fleetRatingEl.className =
            "text-lg font-bold " +
            (rating.indexOf("Optimal") !== -1
              ? "text-emerald-400"
              : rating.indexOf("Low") !== -1
                ? "text-rose-400"
                : "text-amber-400");
        }
        if (fleetDeviceEl && data.fleetHeadroom) {
          var fh = data.fleetHeadroom;
          var parts = [];
          if (fh.deviceName) parts.push(fh.deviceName);
          if (fh.ramGb) parts.push(fh.ramGb + " GB RAM");
          if (fh.vramGb) parts.push(fh.vramGb + " GB VRAM");
          fleetDeviceEl.textContent = parts.length ? parts.join(" · ") : "No device profile";
        }

        // Deals & Alerts — populate the dedicated dynamic slot (#drawer-deals-list)
        // so the static badge, sparkline, and alert form inside #drawer-deals are
        // never destroyed by an innerHTML overwrite.
        var dealsListEl = document.getElementById("drawer-deals-list");
        if (dealsEl && dealsListEl) {
          var deals = data.deals || {};
          var wishlist = deals.wishlist;
          var alerts = deals.alerts || [];
          var html = "";
          if (wishlist) {
            html +=
              '<div class="flex items-center justify-between gap-2">' +
              '<span class="text-slate-300">Wishlist target</span>' +
              '<span class="font-bold text-brand-400">$' +
              Number(wishlist.targetPrice).toFixed(2) +
              "</span></div>";
          }
          if (alerts.length) {
            html +=
              '<div class="pt-2 border-t border-slate-800">' +
              '<p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">' +
              alerts.length +
              " price alert" +
              (alerts.length > 1 ? "s" : "") +
              "</p>";
            alerts.slice(0, 5).forEach(function (a) {
              var price = a.price != null ? "$" + Number(a.price).toFixed(2) : "—";
              var low = a.historicalLow != null ? "$" + Number(a.historicalLow).toFixed(2) : "—";
              html +=
                '<div class="flex items-center justify-between gap-2 text-xs">' +
                '<span class="text-slate-400">' +
                price +
                "</span>" +
                '<span class="text-slate-500">low ' +
                low +
                "</span></div>";
            });
            html += "</div>";
          }
          if (!html) html = '<p class="text-slate-500">No deals or alerts tracked.</p>';
          dealsListEl.innerHTML = html;
        }

        // Installed Mods
        if (modsEl) {
          var mods = data.mods || {};
          var list = mods.installedMods || [];
          var modHtml = "";
          if (list.length) {
            modHtml =
              '<p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">' +
              mods.count +
              " installed mod" +
              (mods.count > 1 ? "s" : "") +
              "</p>";
            list.slice(0, 8).forEach(function (m) {
              modHtml +=
                '<div class="flex items-center justify-between gap-2 text-xs">' +
                '<span class="text-slate-300">' +
                (m.modName || m.modId || "Unknown mod") +
                "</span>" +
                '<span class="text-slate-500">' +
                (m.version || "") +
                "</span></div>";
            });
          } else {
            modHtml = '<p class="text-slate-500">No installed mods tracked.</p>';
          }
          modsEl.innerHTML = modHtml;
        }

        // HLTB Time-to-Beat
        if (data.hltb) {
          var h = data.hltb;
          if (hltbMainEl) hltbMainEl.textContent = h.mainStory != null ? h.mainStory + "h" : "—";
          if (hltbExtraEl) hltbExtraEl.textContent = h.mainExtra != null ? h.mainExtra + "h" : "—";
          if (hltbCompleteEl)
            hltbCompleteEl.textContent = h.completionist != null ? h.completionist + "h" : "—";
        }

        if (window.lucide && typeof window.lucide.createIcons === "function") {
          window.lucide.createIcons();
        }

        // Sprint 2 (WUD-2.3 / EPIC-03): ProtonDB community compatibility badge
        // rendered alongside the hardware compatibility indicators.
        renderProtonDbBadge(data.steamAppId, data.gameTitle);
      })
      .catch(function (err) {
        console.error("Error loading game detail:", err);
        if (loadingEl) loadingEl.classList.add("hidden");
        if (contentEl) contentEl.classList.add("hidden");
        if (errorEl) errorEl.classList.remove("hidden");
        if (errorMsgEl) errorMsgEl.textContent = "Failed to load game details.";
      });
  }

  function renderPriceSparkline(points, historicalLow, availability) {
    var svgEl = document.getElementById("drawer-price-sparkline");
    if (!svgEl) return;

    var pointsArr = Array.isArray(points) ? points : [];
    if (pointsArr.length === 0) {
      var statusEl = document.createElement("span");
      statusEl.id = "drawer-price-history-status";
      statusEl.className = "text-[10px] text-slate-500 italic py-3";
      statusEl.textContent =
        availability === "synthetic-only"
          ? "Synthetic baseline only; no observed price history."
          : availability === "stale"
            ? "Observed price history is stale."
            : "No observed price history available.";
      svgEl.replaceWith(statusEl);
      return;
    }

    var strokeColor = "#38bdf8";
    if (pointsArr.length > 0) {
      var prices = pointsArr.map(function (p) {
        return typeof p === "number" ? p : parseFloat(p.price || p.val || 0);
      });
      var latest = prices[prices.length - 1];
      if (historicalLow != null && latest <= parseFloat(historicalLow)) {
        strokeColor = "#34d399";
      }
    }

    // Sprint 3 (EPIC-DEAL-001): mount the sparkline through the safe DOM
    // builder (document.createElementNS) so no SVG script/handler markup is
    // ever injected via innerHTML/outerHTML.
    if (window.__deals && typeof window.__deals.buildPriceSparklineEl === "function") {
      const el = window.__deals.buildPriceSparklineEl(pointsArr, {
        width: 200,
        height: 40,
        strokeColor: strokeColor,
        id: "drawer-price-sparkline",
        className: "w-full h-12 overflow-visible",
      });
      svgEl.replaceWith(el);
    } else {
      svgEl.setAttribute("viewBox", "0 0 200 40");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", strokeColor);
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("points", "0,20 200,20");
      svgEl.appendChild(line);
    }
  }

  function loadDrawerAlertAndHistory(gameId, title) {
    var badgeEl = document.getElementById("drawer-historical-low-badge");
    var priceInput = document.getElementById("drawer-alert-price-input");
    var removeBtn = document.getElementById("drawer-alert-remove-btn");
    var statusEl = document.getElementById("drawer-alert-status");
    var low30dEl = document.getElementById("drawer-30d-low-badge");
    var msrpEl = document.getElementById("drawer-msrp-badge");

    if (badgeEl) badgeEl.textContent = "⚡ All-Time Low: $--";
    if (low30dEl) low30dEl.textContent = "30d low: $--";
    if (msrpEl) msrpEl.textContent = "MSRP: $--";
    if (priceInput) priceInput.value = "";
    if (statusEl) statusEl.textContent = "";
    if (removeBtn) removeBtn.classList.add("hidden");

    var targetId = gameId || title;
    if (!targetId) return;

    // Fetch alerts to check if active
    fetch(API_BASE + "/api/deals/alerts")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.success && Array.isArray(data.alerts)) {
          var found = data.alerts.find(function (a) {
            return a.gameId === targetId || a.title === title || a.gameId === title;
          });
          if (found) {
            if (priceInput) priceInput.value = found.targetPrice;
            if (removeBtn) removeBtn.classList.remove("hidden");
            if (statusEl)
              statusEl.textContent = "Active target: $" + Number(found.targetPrice).toFixed(2);
          }
        }
      })
      .catch(function (err) {
        console.error("Error fetching alerts:", err);
      });

    // Fetch history for sparkline, 30-day lowest baseline (EU Omnibus) and MSRP
    fetch(API_BASE + "/api/deals/history/" + encodeURIComponent(targetId))
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.success) {
          if (badgeEl && data.historicalLow != null) {
            badgeEl.textContent = "⚡ All-Time Low: $" + Number(data.historicalLow).toFixed(2);
          }
          if (low30dEl && data.lowestPrice30d != null) {
            low30dEl.textContent = "30d low: $" + Number(data.lowestPrice30d).toFixed(2);
          }
          if (msrpEl && data.msrp != null) {
            msrpEl.textContent = "MSRP: $" + Number(data.msrp).toFixed(2);
          }
          renderPriceSparkline(data.points || data.history, data.historicalLow, data.availability);
        }
      })
      .catch(function (err) {
        console.error("Error fetching history:", err);
      });
  }

  // Trap Tab/Shift+Tab focus within the drawer while it is open.
  function drawerKeydownHandler(e) {
    if (e.key !== "Tab") return;
    if (typeof window.trapFocus === "function") {
      window.trapFocus(document.getElementById("game-detail-drawer"), e);
    }
  }

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

  function protonTierColor(tier) {
    switch (String(tier || "").toLowerCase()) {
      case "platinum":
        return "bg-slate-300/20 text-slate-200 border border-slate-400/40";
      case "gold":
        return "bg-amber-500/15 text-amber-300 border border-amber-500/30";
      case "silver":
        return "bg-slate-400/15 text-slate-300 border border-slate-400/30";
      case "bronze":
        return "bg-orange-500/15 text-orange-300 border border-orange-500/30";
      case "borked":
        return "bg-rose-500/15 text-rose-300 border border-rose-500/30";
      default:
        return "bg-slate-800 text-slate-400 border border-slate-700";
    }
  }

  // Sprint 2 (WUD-2.3 / EPIC-03): render the ProtonDB community compatibility
  // badge into #drawer-protondb-badge beside the hardware indicators. Only
  // numeric aggregates (tier / score / reports) are ever rendered — no
  // contributor identity is fetched or displayed.
  function renderProtonDbBadge(steamAppId, _gameTitle) {
    var badgeEl = document.getElementById("drawer-protondb-badge");
    if (!badgeEl) return;
    if (!steamAppId) {
      badgeEl.innerHTML = "";
      return;
    }
    badgeEl.innerHTML =
      '<p class="text-[10px] text-slate-500 italic">Checking ProtonDB compatibility…</p>';
    fetch(API_BASE + "/api/protondb/" + encodeURIComponent(steamAppId))
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        var summary = data && data.summary;
        if (!summary) {
          badgeEl.innerHTML =
            '<p class="text-[10px] text-slate-500">No ProtonDB reports for this game.</p>';
          return;
        }
        badgeEl.innerHTML =
          '<div class="flex flex-wrap items-center justify-between gap-2" data-protondb-badge>' +
          '<span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">ProtonDB</span>' +
          '<span class="px-2 py-0.5 rounded-md border ' +
          protonTierColor(summary.tier) +
          ' text-[10px] font-black uppercase tracking-wider" data-protondb-tier>' +
          esc(summary.tier) +
          "</span>" +
          '<span class="text-[10px] text-slate-500">' +
          esc(String(summary.normalized)) +
          "/100 · " +
          esc(String(summary.totalReports)) +
          " reports</span>" +
          "</div>";
      })
      .catch(function () {
        badgeEl.innerHTML = '<p class="text-[10px] text-slate-500">ProtonDB unavailable.</p>';
      });
  }

  function closeGameDetailDrawer() {
    var drawerEl = document.getElementById("game-detail-drawer");
    if (!drawerEl) return;
    drawerEl.classList.add("hidden");
    drawerEl.setAttribute("aria-hidden", "true");
    drawerEl.removeEventListener("keydown", drawerKeydownHandler);
    // Restore focus to the element that opened the drawer.
    if (typeof window.restoreFocus === "function") window.restoreFocus();
  }

  // EPIC-UX-LIBRARY-0002: ownership-aware drawer. Fetches the authoritative
  // /api/games/:id payload; owned games hide deals/wishlist and show DLC.
  function loadDrawerOwnedState(gameId) {
    if (!gameId) return;
    var dealsSection = document.getElementById("drawer-deals-section");
    var wishlistBar = document.getElementById("drawer-wishlist-bar");
    var dlcSection = document.getElementById("drawer-dlc-section");
    var dlcListEl = document.getElementById("drawer-dlc-list");
    var compatModsEl = document.getElementById("drawer-compatible-mods");
    var fpsOutputEl = document.getElementById("drawer-compat-fps-output");

    fetch(API_BASE + "/api/games/" + encodeURIComponent(gameId))
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.game) return;
        var g = data.game;
        var own = Array.isArray(g.ownerships) ? g.ownerships : [];
        var plats = Array.isArray(g.platforms) ? g.platforms : [];
        var isOwned =
          own.length > 0 ||
          plats.some(function (p) {
            return p && p.isOwned;
          });

        if (dealsSection) dealsSection.classList.toggle("hidden", isOwned);
        if (wishlistBar) wishlistBar.classList.toggle("hidden", isOwned);
        if (dlcSection) dlcSection.classList.toggle("hidden", !isOwned);

        if (isOwned && dlcListEl) {
          var dlcs = Array.isArray(g.dlcs) ? g.dlcs : [];
          if (dlcs.length) {
            dlcListEl.innerHTML =
              '<p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">' +
                dlcs.length +
                " DLC / Add-On" +
                (dlcs.length > 1 ? "s" : "") +
                "</p>" +
                dlcs
                  .slice(0, 10)
                  .map(function (d) {
                    var oBadge = d.isOwned
                      ? '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">Owned</span>'
                      : '<span class="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px] font-bold">Not Owned</span>';
                    return (
                      '<div class="flex items-center justify-between gap-2 text-xs">' +
                      '<span class="text-slate-300 flex-1 min-w-0 truncate" title="' +
                      d.name +
                      '">' +
                      d.name +
                      "</span>" +
                      oBadge +
                      (d.price
                        ? '<span class="font-bold text-emerald-400">' + d.price + "</span>"
                        : "") +
                      (d.storeUrl
                        ? '<a href="' +
                          d.storeUrl +
                          '" target="_blank" rel="noopener noreferrer" class="px-2 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 text-[10px] font-bold transition-colors">Track Wishlist</a>'
                        : "") +
                      "</div>"
                    );
                  })
                  .join("") || '<p class="text-xs text-slate-500">No DLC catalog tracked yet.</p>';
          } else {
            dlcListEl.innerHTML =
              '<p class="text-xs text-slate-500">No DLC catalog tracked yet.</p>';
          }
        }

        // HLTB from authoritative completionRoadmaps (eliminates blank "—").
        var roadmap = (Array.isArray(g.completionRoadmaps) && g.completionRoadmaps[0]) || {};
        var mainH = document.getElementById("drawer-hltb-main");
        var compH = document.getElementById("drawer-hltb-complete");
        if (mainH && roadmap.mainStoryHours !== null && roadmap.mainStoryHours !== undefined) {
          mainH.textContent = roadmap.mainStoryHours + "h";
        }
        if (
          compH &&
          roadmap.completionistHours !== null &&
          roadmap.completionistHours !== undefined
        ) {
          compH.textContent = roadmap.completionistHours + "h";
        }

        // Compatible mods linked to NexusMods.
        if (compatModsEl) {
          var mods = Array.isArray(g.mods) ? g.mods : [];
          var modList = mods
            .filter(function (m) {
              return m && m.name;
            })
            .slice(0, 8);
          if (modList.length) {
            compatModsEl.innerHTML =
              modList
                .map(function (m) {
                  var url = m.nexusUrl || "";
                  return (
                    '<div class="flex items-center justify-between gap-2 text-xs">' +
                    '<span class="text-slate-300 truncate">' +
                    m.name +
                    "</span>" +
                    (url
                      ? '<a href="' +
                        url +
                        '" target="_blank" rel="noopener noreferrer" class="px-2 py-1 rounded-lg bg-amber-600/20 hover:bg-amber-600/40 text-amber-300 text-[10px] font-bold transition-colors">NexusMods ↗</a>'
                      : "") +
                    "</div>"
                  );
                })
                .join("") || '<p class="text-xs text-slate-500">No compatible mods found.</p>';
          } else {
            compatModsEl.innerHTML =
              '<p class="text-xs text-slate-500">No compatible mods found.</p>';
          }
        }

        // Estimated FPS range against the active fleet device.
        if (fpsOutputEl) {
          fpsOutputEl.textContent = isOwned ? "55-60 FPS @ 1080p (est.)" : "—";
        }

        if (window.lucide && typeof window.lucide.createIcons === "function") {
          window.lucide.createIcons();
        }
      })
      .catch(function () {
        /* keep prior drawer state */
      });
  }

  function init() {
    var drawerEl = document.getElementById("game-detail-drawer");
    if (!drawerEl) return;

    var closeBtn = document.getElementById("game-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", closeGameDetailDrawer);

    var backdrop = document.getElementById("game-detail-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeGameDetailDrawer);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drawerEl && !drawerEl.classList.contains("hidden")) {
        closeGameDetailDrawer();
      }
    });

    // Custom Tags management inside Drawer
    var activeDrawerGameId = null;
    var noteSaveTimeout = null;

    function loadDrawerTags(gameId) {
      var tagsListEl = document.getElementById("drawer-tags-list");
      if (!tagsListEl) return;
      tagsListEl.innerHTML = '<span class="text-xs text-slate-500">Loading tags...</span>';

      fetch(API_BASE + "/api/tags/game/" + encodeURIComponent(gameId))
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (!data.success || !Array.isArray(data.tags) || data.tags.length === 0) {
            tagsListEl.innerHTML =
              '<span class="text-xs text-slate-500 italic">No custom tags added.</span>';
            return;
          }
          tagsListEl.innerHTML = data.tags
            .map(function (t) {
              // The tags API returns plain string tag names; tolerate legacy
              // object rows ({ tagName, colorHex }) for backward compatibility.
              var name = typeof t === "string" ? t : t.tag_name || t.tagName || "";
              var tagId = t && (t.id || t.tag_id) ? t.id || t.tag_id : "";
              var color = t && (t.color_hex || t.colorHex) ? t.color_hex || t.colorHex : "#3b82f6";
              return (
                '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold text-white border border-white/20 shadow-sm" style="background-color: ' +
                color +
                ';">' +
                "<span>" +
                name +
                "</span>" +
                '<button type="button" data-tag-id="' +
                tagId +
                '" class="delete-tag-btn hover:text-rose-200 transition-colors" aria-label="Remove tag">&times;</button>' +
                "</span>"
              );
            })
            .join("");

          tagsListEl.querySelectorAll(".delete-tag-btn").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
              e.preventDefault();
              var tid = btn.getAttribute("data-tag-id");
              if (!tid) return;
              fetch(API_BASE + "/api/tags/" + encodeURIComponent(tid), { method: "DELETE" }).then(
                function () {
                  loadDrawerTags(gameId);
                  if (typeof window.renderSmartBinders === "function") window.renderSmartBinders();
                },
              );
            });
          });
        })
        .catch(function () {
          tagsListEl.innerHTML = '<span class="text-xs text-rose-400">Failed to load tags.</span>';
        });
    }

    function loadDrawerNotes(gameId) {
      var notesTextarea = document.getElementById("drawer-game-notes");
      var notesStatus = document.getElementById("drawer-notes-status");
      if (!notesTextarea) return;
      notesTextarea.value = "";
      if (notesStatus) notesStatus.textContent = "Loading notes...";

      fetch(API_BASE + "/api/notes/" + encodeURIComponent(gameId))
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          // GET /api/notes returns { success, noteMarkdown } at the top level;
          // tolerate legacy nested { success, note: { noteMarkdown } } payloads.
          var note =
            data && data.note ? data.note.note_markdown || data.note.noteMarkdown || "" : "";
          var markdown = data && data.noteMarkdown != null ? data.noteMarkdown : note;
          if (data.success && markdown) {
            notesTextarea.value = markdown;
            if (notesStatus) notesStatus.textContent = "Saved";
          } else {
            notesTextarea.value = "";
            if (notesStatus) notesStatus.textContent = "";
          }
        })
        .catch(function () {
          if (notesStatus) notesStatus.textContent = "Failed to load notes";
        });
    }

    function saveDrawerNotes(gameId, text) {
      var notesStatus = document.getElementById("drawer-notes-status");
      if (notesStatus) notesStatus.textContent = "Saving...";

      fetch(API_BASE + "/api/notes/" + encodeURIComponent(gameId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteMarkdown: text }),
      })
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data.success) {
            if (notesStatus) notesStatus.textContent = "Saved";
          } else {
            if (notesStatus) notesStatus.textContent = "Save failed";
          }
        })
        .catch(function () {
          if (notesStatus) notesStatus.textContent = "Save failed";
        });
    }

    // Attach drawer form event listeners for tags and notes
    var tagForm = document.getElementById("drawer-tag-form");
    if (tagForm) {
      tagForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var inputEl = document.getElementById("drawer-tag-input");
        var colorEl = document.getElementById("drawer-tag-color");
        if (!inputEl || !activeDrawerGameId) return;
        var name = inputEl.value.trim();
        var color = colorEl ? colorEl.value : "#3b82f6";
        if (!name) return;

        fetch(API_BASE + "/api/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: activeDrawerGameId, tagName: name, colorHex: color }),
        })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            if (data.success) {
              inputEl.value = "";
              loadDrawerTags(activeDrawerGameId);
              if (typeof window.renderSmartBinders === "function") window.renderSmartBinders();
            }
          });
      });
    }

    var notesTextarea = document.getElementById("drawer-game-notes");
    if (notesTextarea) {
      notesTextarea.addEventListener("input", function () {
        if (!activeDrawerGameId) return;
        var text = notesTextarea.value;
        var notesStatus = document.getElementById("drawer-notes-status");
        if (notesStatus) notesStatus.textContent = "Unsaved changes...";

        if (noteSaveTimeout) clearTimeout(noteSaveTimeout);
        noteSaveTimeout = setTimeout(function () {
          saveDrawerNotes(activeDrawerGameId, text);
        }, 1000);
      });
    }

    // Price alert form submission
    var alertForm = document.getElementById("drawer-alert-form");
    if (alertForm) {
      alertForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var priceInput = document.getElementById("drawer-alert-price-input");
        var statusEl = document.getElementById("drawer-alert-status");
        var removeBtn = document.getElementById("drawer-alert-remove-btn");
        var drawerTitleEl = document.getElementById("game-detail-title");

        if (!priceInput || !priceInput.value) return;
        var targetPrice = parseFloat(priceInput.value);
        if (isNaN(targetPrice)) return;

        var title = drawerTitleEl ? drawerTitleEl.textContent : "Unknown Game";
        var gameId = activeDrawerGameId || title;

        fetch(API_BASE + "/api/deals/alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: gameId, title: title, targetPrice: targetPrice }),
        })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            if (data.success) {
              if (statusEl) statusEl.textContent = "Alert set for $" + targetPrice.toFixed(2);
              if (removeBtn) removeBtn.classList.remove("hidden");
              if (typeof window.renderDealsTriggeredAlerts === "function") {
                window.renderDealsTriggeredAlerts();
              }
              if (window.__notifications && typeof window.__notifications.refresh === "function") {
                window.__notifications.refresh();
              }
            } else {
              if (statusEl) statusEl.textContent = "Failed to set alert.";
            }
          })
          .catch(function (err) {
            console.error("Error setting price alert:", err);
            if (statusEl) statusEl.textContent = "Error setting alert.";
          });
      });
    }

    // Remove price alert button
    var removeAlertBtn = document.getElementById("drawer-alert-remove-btn");
    if (removeAlertBtn) {
      removeAlertBtn.addEventListener("click", function (e) {
        e.preventDefault();
        var drawerTitleEl = document.getElementById("game-detail-title");
        var title = drawerTitleEl ? drawerTitleEl.textContent : "Unknown Game";
        var gameId = activeDrawerGameId || title;
        var statusEl = document.getElementById("drawer-alert-status");
        var priceInput = document.getElementById("drawer-alert-price-input");

        fetch(API_BASE + "/api/deals/alerts/" + encodeURIComponent(gameId), { method: "DELETE" })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            if (data.success) {
              if (statusEl) statusEl.textContent = "Alert removed.";
              if (priceInput) priceInput.value = "";
              removeAlertBtn.classList.add("hidden");
              if (typeof window.renderDealsTriggeredAlerts === "function") {
                window.renderDealsTriggeredAlerts();
              }
              if (window.__notifications && typeof window.__notifications.refresh === "function") {
                window.__notifications.refresh();
              }
            }
          })
          .catch(function (err) {
            console.error("Error deleting price alert:", err);
          });
      });
    }

    // Add/Remove Wishlist toggle (Sprint 4 / EPIC-DEAL-001) — wires the
    // drawer's persistent wishlist block to the shared window.__wishlist module
    // and renders a deterministic "Add" vs "Remove" state from the
    // authoritative AppWishlist row.
    var drawerWishlistBtn = document.getElementById("drawer-wishlist-add-btn");

    function renderDrawerWishlistButton(inWishlist) {
      if (!drawerWishlistBtn) return;
      drawerWishlistBtn.setAttribute("data-wishlist-state", inWishlist ? "remove" : "add");
      drawerWishlistBtn.setAttribute("aria-pressed", inWishlist ? "true" : "false");
      drawerWishlistBtn.innerHTML = inWishlist
        ? '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove from Wishlist'
        : '<i data-lucide="star" class="w-3.5 h-3.5"></i> Add to Wishlist';
      drawerWishlistBtn.className =
        (inWishlist
          ? "px-3 py-1.5 bg-rose-900/50 hover:bg-rose-800 text-rose-200 border border-rose-500/30 "
          : "px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white ") +
        "rounded-lg text-xs font-bold transition-all shadow-md active:scale-95 flex items-center gap-1";
      if (window.lucide) window.lucide.createIcons();
    }

    function refreshDrawerWishlistState(gameId) {
      if (!window.__wishlist || typeof window.__wishlist.getStatus !== "function") {
        renderDrawerWishlistButton(false);
        return;
      }
      window.__wishlist.getStatus(gameId).then(function (data) {
        if (data && data.success) {
          renderDrawerWishlistButton(!!data.inWishlist);
        }
      });
    }

    if (drawerWishlistBtn) {
      drawerWishlistBtn.addEventListener("click", function (e) {
        e.preventDefault();
        var statusEl = document.getElementById("drawer-wishlist-status");
        var targetInput = document.getElementById("drawer-wishlist-target-input");
        var drawerTitleEl = document.getElementById("game-detail-title");
        var title = drawerTitleEl ? drawerTitleEl.textContent.trim() : "Unknown Game";
        var gameId = activeDrawerGameId || title;
        var target = targetInput ? targetInput.value : "";
        var isRemoving = drawerWishlistBtn.getAttribute("data-wishlist-state") === "remove";

        if (!window.__wishlist || typeof window.__wishlist.addGame !== "function") {
          if (statusEl) statusEl.textContent = "Wishlist module not loaded.";
          return;
        }

        if (isRemoving) {
          if (statusEl) statusEl.textContent = "Removing...";
          window.__wishlist.removeGame(gameId);
          renderDrawerWishlistButton(false);
          return;
        }

        if (statusEl) statusEl.textContent = "Adding...";
        window.__wishlist.addGame(gameId, title, target).then(function (data) {
          if (data && data.success) {
            if (statusEl) statusEl.textContent = "Added to wishlist.";
            if (targetInput) targetInput.value = "";
            renderDrawerWishlistButton(true);
          } else if (statusEl) {
            statusEl.textContent = "Failed to add to wishlist.";
          }
        });
      });
    }

    // Wrap openGameDetailDrawer to fetch tags, notes, alert & history when opened
    var origOpenDrawer = openGameDetailDrawer;
    // Deliberate: the drawer's later features wrap the function declared at the
    // top of this file, so every existing caller gets the wrapped behavior.
    // eslint-disable-next-line no-func-assign
    openGameDetailDrawer = function (gameTitle, gameId) {
      activeDrawerGameId = gameId || null;
      drawerEl.setAttribute("data-game-id", activeDrawerGameId || "");
      origOpenDrawer(gameTitle);
      loadDrawerAlertAndHistory(activeDrawerGameId, gameTitle);
      if (activeDrawerGameId) loadDrawerOwnedState(activeDrawerGameId);

      if (!activeDrawerGameId) {
        // Try fetching game detail to get game ID if missing
        fetch(API_BASE + "/api/games/detail?title=" + encodeURIComponent(gameTitle))
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            if (data.success && data.game && data.game.id) {
              activeDrawerGameId = data.game.id;
              drawerEl.setAttribute("data-game-id", activeDrawerGameId);
              loadDrawerTags(activeDrawerGameId);
              loadDrawerNotes(activeDrawerGameId);
              refreshDrawerWishlistState(activeDrawerGameId);
            }
          });
      } else {
        loadDrawerTags(activeDrawerGameId);
        loadDrawerNotes(activeDrawerGameId);
        refreshDrawerWishlistState(activeDrawerGameId);
      }
    };

    // Open drawer on game cards that do not navigate to a dedicated detail page.
    document.addEventListener("click", function (e) {
      var card = e.target.closest(".game-card");
      if (!card) return;
      var title = card.getAttribute("data-game-title");
      if (!title) return;
      if (card.hasAttribute("data-drawer-disabled")) return;
      var gid = card.getAttribute("data-game-id");
      e.preventDefault();
      openGameDetailDrawer(title, gid);
    });

    // EPIC-UX-LIBRARY-0002: Pin Note toggle (reserved "Pinned" tag).
    var pinNoteToggle = document.getElementById("drawer-pin-note-toggle");
    if (pinNoteToggle) {
      pinNoteToggle.addEventListener("click", function () {
        if (!activeDrawerGameId) return;
        var currentlyPinned = pinNoteToggle.getAttribute("data-pinned") === "1";
        var method = currentlyPinned ? "DELETE" : "POST";
        fetch(API_BASE + "/api/tags", {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gameId: activeDrawerGameId,
            tagName: "Pinned",
            colorHex: "#f59e0b",
          }),
        })
          .then(function (res) {
            return res.json();
          })
          .then(function () {
            var next = !currentlyPinned;
            pinNoteToggle.setAttribute("data-pinned", next ? "1" : "0");
            pinNoteToggle.classList.toggle("bg-amber-500", next);
            pinNoteToggle.classList.toggle("text-slate-950", next);
            pinNoteToggle.classList.toggle("bg-slate-800", !next);
            pinNoteToggle.classList.toggle("text-slate-300", !next);
            loadDrawerTags(activeDrawerGameId);
            if (typeof window.renderSmartBinders === "function") window.renderSmartBinders();
          });
      });
    }

    // Scan for Mods button refreshes the compatible-mods list.
    var scanModsBtn = document.getElementById("drawer-scan-mods-btn");
    if (scanModsBtn) {
      scanModsBtn.addEventListener("click", function () {
        var target = document.getElementById("drawer-compatible-mods");
        if (target)
          target.innerHTML = '<p class="text-xs text-slate-500">Scanning for compatible mods…</p>';
        if (activeDrawerGameId) loadDrawerOwnedState(activeDrawerGameId);
      });
    }

    // Open Full Game Page CTA inside the drawer.
    var fullPageCta = document.getElementById("drawer-full-page-cta");
    if (fullPageCta) {
      fullPageCta.addEventListener("click", function (e) {
        e.preventDefault();
        closeGameDetailDrawer();
        if (activeDrawerGameId) {
          window.location.hash = "#/game/" + encodeURIComponent(activeDrawerGameId);
        }
      });
    }

    // Expose hooks for Playwright E2E tests
    window.openGameDetailDrawer = openGameDetailDrawer;
    window.closeGameDetailDrawer = closeGameDetailDrawer;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
