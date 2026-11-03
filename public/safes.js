/* MGPL Sprint 6.1 (PI-GTM-2026-001) — Shared Safety Utility Stack (client mirror).
 *
 * Total-function guards: never throw, always return a well-typed fallback.
 * This module MUST be loaded before app.js / compare.js / retro.js so the
 * window.* helpers are available to every vanilla module. Keep the contracts
 * in sync with src/utils/safes.ts.
 *
 * Stack (MGPL Master Handbook v5.1): safeHydrate, safeArray, safeFetchJSON,
 * safeCSSVar, safeToastError, safeDeviceProfile.
 */
(function () {
  "use strict";

  var FETCH_TIMEOUT_MS = 2500;
  var FETCH_RETRIES = 1;

  // Return `obj` when it is a non-null, non-array object; otherwise `fallback`.
  function safeHydrate(obj, fallback) {
    if (fallback === undefined) fallback = {};
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : fallback;
  }

  // Return `arr` when it is an array; otherwise an empty array.
  function safeArray(arr) {
    return Array.isArray(arr) ? arr : [];
  }

  // Fetch + parse JSON with a 2.5s timeout and 1 retry; resolve to `fallback`
  // on any failure (timeout / network / non-OK / malformed JSON). Never throws.
  async function safeFetchJSON(url, fallback) {
    if (fallback === undefined) fallback = {};
    for (var attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = null;
      if (controller) {
        timer = setTimeout(function () {
          controller.abort();
        }, FETCH_TIMEOUT_MS);
      }
      try {
        var res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (timer) clearTimeout(timer);
        if (!res.ok) continue;
        return await res.json();
      } catch (e) {
        if (timer) clearTimeout(timer);
      }
    }
    return fallback;
  }

  // Strict CSS custom-property value validation: rejects url(...), chained
  // var(--other), and non-string types.
  function sanitizeCSSVarValue(raw, fallback) {
    if (fallback === undefined) fallback = "";
    if (typeof raw !== "string" || raw.trim() === "") return fallback;
    var v = raw.trim();
    if (/url\s*\(/i.test(v)) return fallback;
    if (/var\s*\(--[^)]*\)/.test(v)) return fallback;
    return v;
  }

  // Read a CSS custom property from <html> through the strict sanitizer.
  function safeCSSVar(name, fallback) {
    if (fallback === undefined) fallback = "";
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
      return fallback;
    }
    var raw;
    try {
      raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    } catch (e) {
      return fallback;
    }
    return sanitizeCSSVarValue(raw, fallback);
  }

  var SENSITIVE_KEY_PATTERN =
    /\b(password|passwd|secret|token|apikey|api_key|access_token|refresh_token|authorization|bearer|client_secret)\b\s*[:=]\s*["']?[^\s"',;]+/gi;
  var PATH_PATTERN =
    /(?:[A-Za-z]:)?[\\/][\w\-. ()]+(?:[\\/][\w\-. ()]+)+\.(?:ts|js|tsx|jsx|html|json|db|log)(?::\d+)?\b/gi;

  // Convert an unknown error into a safe user-facing message: strips stack
  // traces, internal filesystem paths, file:// URLs, and secret values.
  // Mirrors src/utils/errorSanitizer.ts (Sprint 1A EPICSEC04) exactly — keep
  // the stack-strip ordering in sync with the server implementation.
  function safeToastError(err, fallback) {
    if (fallback === undefined) fallback = "Something went wrong.";
    if (err === null || err === undefined) return fallback;
    var raw;
    if (typeof err === "string") raw = err;
    else if (err instanceof Error) raw = err.message || fallback;
    else if (err && typeof err.message === "string") raw = err.message;
    else raw = String(err);

    // Strip stack frames ("  at fn (path:line:col)") BEFORE collapsing
    // whitespace so internal call paths can never survive into the message.
    var lines = raw.split(/\r?\n/);
    var stackIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*at\s/.test(lines[i])) {
        stackIdx = i;
        break;
      }
    }
    if (stackIdx > 0) raw = lines.slice(0, stackIdx).join(" ");

    raw = raw.replace(/\s+/g, " ").trim();
    raw = raw.replace(SENSITIVE_KEY_PATTERN, "[redacted]");
    raw = raw.replace(PATH_PATTERN, "[path]");
    raw = raw.replace(/file:\/\/[^\s]+/gi, "[path]");
    return raw.slice(0, 240).trim() || fallback;
  }

  // Normalize a device profile into guaranteed fallback strings/numbers for
  // gpu, cpu, vram, ram, battery, and tier.
  function safeDeviceProfile(device) {
    var d = device && typeof device === "object" && !Array.isArray(device) ? device : {};
    function toStr(v, fb) {
      return typeof v === "string" && v.trim() !== "" ? v.trim() : fb;
    }
    function toNum(v, fb) {
      if (typeof v === "number" && isFinite(v)) return v;
      if (v === null || v === undefined || v === "") return fb;
      var n = Number(v);
      return isFinite(n) ? n : fb;
    }
    return {
      gpu: toStr(d.gpu != null ? d.gpu : d.gpuModel, "Unknown GPU"),
      cpu: toStr(d.cpu != null ? d.cpu : d.cpuModel, "Unknown CPU"),
      vramGb: toNum(d.vramGb != null ? d.vramGb : d.vram, 0),
      ramGb: toNum(d.ramGb != null ? d.ramGb : d.ram, 0),
      batteryWh: d.batteryWh === null || d.batteryWh === undefined ? null : toNum(d.batteryWh, 0),
      tier: toStr(
        d.tier != null
          ? d.tier
          : d.playabilityTier != null
            ? d.playabilityTier
            : d.fpsTier != null
              ? d.fpsTier
              : d.targetFpsTier,
        "Unknown",
      ),
    };
  }

  window.MGPLSafe = {
    safeHydrate: safeHydrate,
    safeArray: safeArray,
    safeFetchJSON: safeFetchJSON,
    safeCSSVar: safeCSSVar,
    sanitizeCSSVarValue: sanitizeCSSVarValue,
    safeToastError: safeToastError,
    safeDeviceProfile: safeDeviceProfile,
  };

  // Global aliases for the existing vanilla modules (loaded after safes.js).
  window.safeHydrate = safeHydrate;
  window.safeArray = safeArray;
  window.safeFetchJSON = safeFetchJSON;
  window.safeCSSVar = safeCSSVar;
  window.sanitizeCSSVarValue = sanitizeCSSVarValue;
  window.safeToastError = safeToastError;
  window.safeDeviceProfile = safeDeviceProfile;
})();
