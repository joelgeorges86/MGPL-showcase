/**
 * importer.js — Multi-Source Library Importer (FEAT-0153)
 *
 * Client-side parsers for Steam .acf (KeyValues/VDF), GOG goggame-*.info and
 * Epic *.item manifests. Assembles a deduplication preview table and posts a
 * validated batch payload to POST /api/library/import.
 *
 * Exposes window.__importer = { init } which is invoked lazily by app.js's
 * handleRoute() when the #/importer route is navigated to.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Small DOM + toast helpers (showToast lives in app.js, loaded AFTER this
  // file, so it is only referenced at call-time inside event handlers).
  // ---------------------------------------------------------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function showToast(message, isError) {
    if (typeof window.showToast === "function") {
      window.showToast(message, isError);
    }
  }

  function setError(message) {
    const el = $("import-error");
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function setResult(message) {
    const el = $("import-result");
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  // ---------------------------------------------------------------------------
  // Normalization (mirrors backend normalizeTitle for consistent status tags).
  // ---------------------------------------------------------------------------
  function normalizeTitle(title) {
    return String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Parsers
  // ---------------------------------------------------------------------------

  /**
   * Parse a Steam appmanifest_*.acf KeyValues/VDF document.
   * Returns { appid, name, installdir } or null when the document is invalid.
   */
  function parseSteamAcf(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    const appid = extractKeyValue(trimmed, "appid");
    const name = extractKeyValue(trimmed, "name");
    const installdir = extractKeyValue(trimmed, "installdir");

    // A valid .acf must at least carry an appid and a name.
    if (!appid && !name) return null;

    return {
      appid: appid || null,
      name: name || null,
      installdir: installdir || null,
    };
  }

  /**
   * Extract a single quoted key/value pair from a KeyValues/VDF document.
   * Handles both `"key" "value"` and `"key"\n\t\t"value"` layouts.
   */
  function extractKeyValue(text, key) {
    const re = new RegExp('"' + key + '"\\s*"([^"]*)"', "i");
    const m = text.match(re);
    return m ? m[1] : null;
  }

  /**
   * Parse a GOG goggame-*.info JSON document.
   * Returns { gameId, rootGameId, name } or null when invalid.
   */
  function parseGogJson(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const gameId = data.gameId || data.gameID || data.id || null;
    const rootGameId = data.rootGameId || data.rootGameID || null;
    const name = data.name || data.title || null;

    if (!gameId && !name) return null;

    return {
      gameId: gameId != null ? String(gameId) : null,
      rootGameId: rootGameId != null ? String(rootGameId) : null,
      name: name != null ? String(name) : null,
    };
  }

  /**
   * Parse an Epic *.item manifest JSON document.
   * Returns { AppName, DisplayName, InstallLocation } or null when invalid.
   */
  function parseEpicJson(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const appName = data.AppName || data.appName || data.CatalogItemId || null;
    const displayName = data.DisplayName || data.displayName || data.name || null;
    const installLocation = data.InstallLocation || data.installLocation || null;

    if (!appName && !displayName) return null;

    return {
      AppName: appName != null ? String(appName) : null,
      DisplayName: displayName != null ? String(displayName) : null,
      InstallLocation: installLocation != null ? String(installLocation) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // File-type detection + dispatch
  // ---------------------------------------------------------------------------

  /**
   * Detect the platform for a given filename.
   * Returns 'steam' | 'gog' | 'epic' | null.
   */
  function detectPlatform(filename) {
    const name = String(filename || "").toLowerCase();
    if (name.endsWith(".acf")) return "steam";
    if (name.includes("goggame") && name.endsWith(".info")) return "gog";
    if (name.endsWith(".item")) return "epic";
    if (name.endsWith(".json")) return "json"; // ambiguous -> try GOG then Epic
    return null;
  }

  /**
   * Parse a single File into an import item descriptor.
   * Returns { ok, item?, error? }.
   */
  function parseFile(file) {
    const platform = detectPlatform(file.name);
    if (!platform) {
      return {
        ok: false,
        error: `Unsupported file type: "${file.name}". Expected .acf, goggame-*.info or *.item.`,
      };
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve({ ok: false, error: `Could not read "${file.name}".` });
      reader.onload = () => {
        const text = String(reader.result || "");

        if (platform === "steam") {
          const parsed = parseSteamAcf(text);
          if (!parsed) {
            resolve({
              ok: false,
              error: `"${file.name}" is not a valid Steam .acf manifest (missing appid/name).`,
            });
            return;
          }
          resolve({
            ok: true,
            item: {
              title: parsed.name,
              platform: "Steam",
              externalId: parsed.appid,
              installPath: parsed.installdir,
            },
          });
          return;
        }

        if (platform === "gog") {
          const parsed = parseGogJson(text);
          if (!parsed) {
            resolve({
              ok: false,
              error: `"${file.name}" is not a valid GOG .info manifest (missing gameId/name).`,
            });
            return;
          }
          resolve({
            ok: true,
            item: {
              title: parsed.name,
              platform: "GOG",
              externalId: parsed.gameId || parsed.rootGameId,
              installPath: null,
            },
          });
          return;
        }

        if (platform === "epic") {
          const parsed = parseEpicJson(text);
          if (!parsed) {
            resolve({
              ok: false,
              error: `"${file.name}" is not a valid Epic .item manifest (missing AppName/DisplayName).`,
            });
            return;
          }
          resolve({
            ok: true,
            item: {
              title: parsed.DisplayName,
              platform: "Epic Games",
              externalId: parsed.AppName,
              installPath: parsed.InstallLocation,
            },
          });
          return;
        }

        // Ambiguous .json: try GOG first, then Epic.
        const gog = parseGogJson(text);
        if (gog) {
          resolve({
            ok: true,
            item: {
              title: gog.name,
              platform: "GOG",
              externalId: gog.gameId || gog.rootGameId,
              installPath: null,
            },
          });
          return;
        }
        const epic = parseEpicJson(text);
        if (epic) {
          resolve({
            ok: true,
            item: {
              title: epic.DisplayName,
              platform: "Epic Games",
              externalId: epic.AppName,
              installPath: epic.InstallLocation,
            },
          });
          return;
        }
        resolve({
          ok: false,
          error: `"${file.name}" is not a recognized GOG or Epic JSON manifest.`,
        });
      };
      reader.readAsText(file);
    });
  }

  // ---------------------------------------------------------------------------
  // Existing library titles (for client-side status tags)
  // ---------------------------------------------------------------------------
  let existingTitles = null;

  async function loadExistingTitles() {
    if (existingTitles) return existingTitles;
    try {
      const res = await fetch("/api/games?active=true&owned=true");
      const data = await res.json();
      const games = Array.isArray(data.games) ? data.games : [];
      existingTitles = new Set(
        games
          .map((g) => g.title || g["Game Title"] || g.gameTitle || "")
          .filter(Boolean)
          .map(normalizeTitle),
      );
    } catch (e) {
      existingTitles = new Set();
    }
    return existingTitles;
  }

  // ---------------------------------------------------------------------------
  // Preview rendering
  // ---------------------------------------------------------------------------
  let pendingItems = [];

  function statusFor(item) {
    if (!existingTitles) return "New";
    return existingTitles.has(normalizeTitle(item.title)) ? "Update" : "New";
  }

  function renderPreview() {
    const body = $("import-preview-body");
    const wrap = $("import-preview-wrap");
    const count = $("import-preview-count");
    if (!body || !wrap) return;

    body.textContent = "";
    const frag = document.createDocumentFragment();

    pendingItems.forEach((item) => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-slate-800/40 transition-colors";

      const tdTitle = document.createElement("td");
      tdTitle.className = "px-4 py-3 font-semibold text-white";
      tdTitle.textContent = item.title || "(Untitled)";

      const tdPlatform = document.createElement("td");
      tdPlatform.className = "px-4 py-3 text-slate-300";
      tdPlatform.textContent = item.platform || "Other";

      const tdStatus = document.createElement("td");
      tdStatus.className = "px-4 py-3";
      const status = statusFor(item);
      const badge = document.createElement("span");
      badge.className =
        status === "Update"
          ? "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30"
          : "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30";
      badge.textContent = status;
      tdStatus.appendChild(badge);

      const tdPath = document.createElement("td");
      tdPath.className = "px-4 py-3 text-slate-400";
      tdPath.textContent = item.installPath || "—";

      tr.appendChild(tdTitle);
      tr.appendChild(tdPlatform);
      tr.appendChild(tdStatus);
      tr.appendChild(tdPath);
      frag.appendChild(tr);
    });

    body.appendChild(frag);

    if (count) {
      count.textContent = `${pendingItems.length} game${pendingItems.length === 1 ? "" : "s"} ready to sync`;
    }
    wrap.classList.remove("hidden");
  }

  // ---------------------------------------------------------------------------
  // File ingestion
  // ---------------------------------------------------------------------------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    setError("");
    setResult("");
    pendingItems = [];

    const errors = [];
    for (const file of files) {
      const result = await parseFile(file);
      if (result.ok && result.item) {
        pendingItems.push(result.item);
      } else if (result.error) {
        errors.push(result.error);
      }
    }

    if (errors.length) {
      setError(errors.join(" "));
    }

    if (pendingItems.length) {
      await loadExistingTitles();
      renderPreview();
      showToast(`Parsed ${pendingItems.length} manifest${pendingItems.length === 1 ? "" : "s"}.`);
    } else if (!errors.length) {
      setError("No valid manifests were found in the selected files.");
    }
  }

  // ---------------------------------------------------------------------------
  // Confirm & Sync
  // ---------------------------------------------------------------------------
  async function confirmSync() {
    if (!pendingItems.length) return;

    const btn = $("import-confirm-btn");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("opacity-60", "cursor-not-allowed");
    }

    try {
      const res = await fetch("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ games: pendingItems }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || "Library sync failed.");
      }

      const summary = `Sync complete — ${data.inserted} inserted, ${data.updated} updated, ${data.skipped} skipped (${data.total} total).`;
      setResult(summary);
      showToast(summary);

      // Reset preview after a successful sync.
      pendingItems = [];
      const body = $("import-preview-body");
      const wrap = $("import-preview-wrap");
      if (body) body.textContent = "";
      if (wrap) wrap.classList.add("hidden");
    } catch (err) {
      // Sprint 1A (EPICSEC04): sanitize through the shared client shield so
      // raw error internals (paths, secrets, stacks) never render in the UI.
      const msg =
        typeof window.safeToastError === "function"
          ? window.safeToastError(err, "Library sync failed.")
          : err && err.message
            ? err.message
            : "Library sync failed.";
      setError(msg);
      showToast(msg, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-60", "cursor-not-allowed");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dropzone wiring
  // ---------------------------------------------------------------------------
  function wireDropzone() {
    const dropzone = $("import-dropzone");
    const fileInput = $("import-file-input");
    const confirmBtn = $("import-confirm-btn");

    if (dropzone) {
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("border-brand-500", "bg-brand-500/5");
      });
      dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("border-brand-500", "bg-brand-500/5");
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("border-brand-500", "bg-brand-500/5");
        handleFiles(e.dataTransfer && e.dataTransfer.files);
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", () => {
        handleFiles(fileInput.files);
        fileInput.value = "";
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener("click", confirmSync);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function init() {
    wireDropzone();
  }

  window.__importer = { init };
})();
