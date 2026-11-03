/* MGPL Authentication UI (Sprint 4 / FEAT-AUTH-UI-0001)
 *
 * Client-side auth experience: session bootstrap via GET /api/auth/me,
 * responsive header controls (Log In button vs user pill + Log Out), and an
 * accessible tabbed Log In / Sign Up modal with native + OAuth (Google/Steam)
 * actions. State rehydration is broadcast through custom events so the main
 * app can refetch user-scoped data (wishlist, tags, alerts) without reloads.
 *
 * Exposes window.__auth with:
 *   - init()           -> idempotent bootstrap (safe to call repeatedly)
 *   - refreshUser()    -> re-check GET /api/auth/me and re-render header
 *   - getCurrentUser() -> current user object or null
 *   - openLogin()      -> programmatically open the modal on the Log In tab
 *   - logout()         -> POST /api/auth/logout + header re-render
 */
(function () {
  "use strict";

  var currentUser = null;
  var currentProfile = null;
  var initialized = false;
  var modalRoot = null;
  var lastFocused = null;

  // Cached DOM handles populated during injectModal()/bootstrap().
  var els = {};

  function apiFetch(url, options) {
    return fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
  }

  function initialsFor(email) {
    if (!email) return "MG";
    var local = String(email).split("@")[0] || "";
    var parts = local.split(/[._-]+/).filter(Boolean);
    if (parts.length === 0) return "MG";
    var first = (parts[0][0] || "").toUpperCase();
    var second =
      parts.length > 1
        ? (parts[1][0] || "").toUpperCase()
        : (local[local.length - 1] || "").toUpperCase();
    return (first + second).slice(0, 2);
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

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
    }
  }

  // -------------------------------------------------------------------------
  // Header rendering
  // -------------------------------------------------------------------------

  function renderHeader() {
    var container = document.getElementById("auth-controls");
    if (!container) return;

    if (currentUser) {
      var email = currentUser.email || currentUser.id || "";
      var profile = currentProfile || {};
      var displaySeed = profile.displayName || profile.gamerTag || email;
      var avatarHtml = profile.avatarUrl
        ? '<img id="auth-avatar-img" src="' +
          esc(profile.avatarUrl) +
          '" alt="" class="h-7 w-7 rounded-full object-cover border border-slate-600" loading="lazy" referrerpolicy="no-referrer" />'
        : '<span id="auth-avatar" aria-hidden="true" class="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-white text-[10px] font-black shadow-inner">' +
          esc(initialsFor(displaySeed)) +
          "</span>";
      var gamerTagHtml = profile.gamerTag
        ? '<span id="auth-gamertag" class="text-[10px] font-bold text-brand-300 truncate max-w-[110px]">@' +
          esc(String(profile.gamerTag).replace(/^@/, "")) +
          "</span>"
        : "";
      container.innerHTML =
        '<div class="flex flex-wrap items-center gap-2 justify-end">' +
        '<button id="auth-user-pill" type="button" title="Open profile settings" aria-label="Open profile settings" class="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-300 hover:border-brand-500/50 hover:bg-slate-700/80 cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
        avatarHtml +
        '<span class="flex flex-col items-start leading-tight">' +
        '<span id="auth-email" class="max-w-[150px] truncate">' +
        esc(email) +
        "</span>" +
        gamerTagHtml +
        "</span>" +
        "</button>" +
        '<button id="btn-auth-logout" type="button" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-rose-900/60 border border-slate-700 hover:border-rose-500/40 text-slate-300 hover:text-rose-200 text-xs font-bold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">' +
        '<i data-lucide="log-out" class="w-4 h-4"></i><span>Log Out</span>' +
        "</button>" +
        "</div>";
    } else {
      container.innerHTML =
        '<button id="btn-auth-open-login" type="button" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-md shadow-brand-600/20 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
        '<i data-lucide="log-in" class="w-4 h-4"></i><span>Login / Sign Up</span>' +
        "</button>";
    }
    refreshIcons();

    // Re-wire header controls (innerHTML replaces the previous nodes).
    var openBtn = document.getElementById("btn-auth-open-login");
    if (openBtn && !openBtn.dataset.authWired) {
      openBtn.dataset.authWired = "1";
      openBtn.addEventListener("click", function () {
        openModal("login");
      });
    }
    var logoutBtn = document.getElementById("btn-auth-logout");
    if (logoutBtn && !logoutBtn.dataset.authWired) {
      logoutBtn.dataset.authWired = "1";
      logoutBtn.addEventListener("click", handleLogout);
    }
  }

  // -------------------------------------------------------------------------
  // Modal
  // -------------------------------------------------------------------------

  function modalMarkup() {
    return (
      '<div id="auth-modal" class="hidden fixed inset-0 z-[90] items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title" aria-describedby="auth-modal-desc">' +
      '<div id="auth-backdrop" class="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"></div>' +
      '<div class="relative bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">' +
      '<div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-800">' +
      '<div class="flex items-center gap-2.5">' +
      '<div class="bg-brand-500 p-2 rounded-xl text-white shadow-lg shadow-brand-500/20">' +
      '<i data-lucide="gamepad-2" class="w-5 h-5"></i>' +
      "</div>" +
      "<div>" +
      '<h2 id="auth-modal-title" class="text-lg font-bold text-white">Welcome to MGPL</h2>' +
      '<p id="auth-modal-desc" class="text-xs text-slate-400">Sign in to sync your wishlist, tags & alerts</p>' +
      "</div>" +
      "</div>" +
      '<button id="btn-auth-close" type="button" aria-label="Close authentication dialog" class="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="x" class="w-5 h-5"></i>' +
      "</button>" +
      "</div>" +
      // Tabs
      '<div class="px-6 pt-4">' +
      '<div class="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-semibold" role="tablist" aria-label="Authentication mode">' +
      '<button id="auth-tab-login" type="button" role="tab" aria-selected="true" aria-controls="auth-login-form" class="auth-tab-btn flex-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Log In</button>' +
      '<button id="auth-tab-signup" type="button" role="tab" aria-selected="false" aria-controls="auth-signup-form" class="auth-tab-btn flex-1 px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Sign Up</button>' +
      "</div>" +
      "</div>" +
      // Inline error banner
      '<div id="auth-error-banner" class="hidden mx-6 mt-4 px-3 py-2.5 rounded-xl bg-rose-900/50 border border-rose-500/40 text-xs font-semibold text-rose-200 items-center gap-2" role="alert">' +
      "</div>" +
      '<div class="px-6 py-5 space-y-5">' +
      // LOG IN panel
      '<form id="auth-login-form" role="tabpanel" aria-labelledby="auth-tab-login" class="space-y-3.5">' +
      "<div>" +
      '<label for="auth-login-email" class="block text-xs font-semibold text-slate-400 mb-1">Email</label>' +
      '<input id="auth-login-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="auth-login-password" class="block text-xs font-semibold text-slate-400 mb-1">Password</label>' +
      '<input id="auth-login-password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      '<button type="submit" class="auth-submit-btn w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-sm font-bold text-white shadow-md shadow-brand-600/15 hover:shadow-brand-500/25 active:scale-[0.98] transition-all disabled:opacity-60 disabled:pointer-events-none">' +
      '<i data-lucide="log-in" class="w-4 h-4"></i><span>Log In</span>' +
      "</button>" +
      "</form>" +
      // SIGN UP panel
      '<form id="auth-signup-form" role="tabpanel" aria-labelledby="auth-tab-signup" class="hidden space-y-3.5">' +
      "<div>" +
      '<label for="auth-signup-email" class="block text-xs font-semibold text-slate-400 mb-1">Email</label>' +
      '<input id="auth-signup-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="auth-signup-password" class="block text-xs font-semibold text-slate-400 mb-1">Password</label>' +
      '<input id="auth-signup-password" name="password" type="password" required autocomplete="new-password" placeholder="Min 8 characters" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      "<div>" +
      '<label for="auth-signup-confirm" class="block text-xs font-semibold text-slate-400 mb-1">Confirm Password</label>' +
      '<input id="auth-signup-confirm" name="confirm" type="password" required autocomplete="new-password" placeholder="Re-enter password" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all">' +
      "</div>" +
      '<button type="submit" class="auth-submit-btn w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-sm font-bold text-white shadow-md shadow-brand-600/15 hover:shadow-brand-500/25 active:scale-[0.98] transition-all disabled:opacity-60 disabled:pointer-events-none">' +
      '<i data-lucide="user-plus" class="w-4 h-4"></i><span>Create Account</span>' +
      "</button>" +
      "</form>" +
      // Divider
      '<div class="flex items-center gap-3" aria-hidden="true">' +
      '<span class="h-px flex-1 bg-slate-800"></span>' +
      '<span class="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">or continue with</span>' +
      '<span class="h-px flex-1 bg-slate-800"></span>' +
      "</div>" +
      // OAuth actions
      '<div class="space-y-2.5">' +
      '<button id="btn-auth-google" type="button" class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-200 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<i data-lucide="chrome" class="w-4 h-4 text-emerald-400"></i><span>Continue with Google</span>' +
      "</button>" +
      '<button id="btn-auth-steam" type="button" class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-200 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">' +
      '<svg class="w-4 h-4 text-sky-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.98 2.1a9.9 9.9 0 0 0-9.8 10.63l4.63 1.91a2.9 2.9 0 0 1 1.66-.5l2.06-3A4.74 4.74 0 1 1 15.18 14l-3 2.06a2.87 2.87 0 0 1-.5 1.66l1.9 4.62a9.9 9.9 0 1 0-1.6-20.24zM7.7 15.6l-.78-.32a2.7 2.7 0 0 0 .78 1.85 2.7 2.7 0 0 0 1.88.8h.02a2.7 2.7 0 0 0 1.87-.8 2.7 2.7 0 0 0 .8-1.88A2.7 2.7 0 0 0 11.4 13.7L9.9 14.7a2.7 2.7 0 0 1-2.2.9zm4.5-6.8a2.55 2.55 0 1 1 5.1 0 2.55 2.55 0 0 1-5.1 0z"/></svg>' +
      "<span>Sign in with Steam</span>" +
      "</button>" +
      "</div>" +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  function injectModal() {
    if (modalRoot) return;
    var host = document.createElement("div");
    host.innerHTML = modalMarkup();
    modalRoot = host.firstElementChild;
    document.body.appendChild(modalRoot);

    els.modal = modalRoot;
    els.backdrop = document.getElementById("auth-backdrop");
    els.closeBtn = document.getElementById("btn-auth-close");
    els.tabLogin = document.getElementById("auth-tab-login");
    els.tabSignup = document.getElementById("auth-tab-signup");
    els.errorBanner = document.getElementById("auth-error-banner");
    els.loginForm = document.getElementById("auth-login-form");
    els.signupForm = document.getElementById("auth-signup-form");
    els.loginEmail = document.getElementById("auth-login-email");
    els.loginPassword = document.getElementById("auth-login-password");
    els.signupEmail = document.getElementById("auth-signup-email");
    els.signupPassword = document.getElementById("auth-signup-password");
    els.signupConfirm = document.getElementById("auth-signup-confirm");
    els.googleBtn = document.getElementById("btn-auth-google");
    els.steamBtn = document.getElementById("btn-auth-steam");

    refreshIcons();
  }

  function wireEvents() {
    if (els.closeBtn && !els.closeBtn.dataset.authWired) {
      els.closeBtn.dataset.authWired = "1";
      els.closeBtn.addEventListener("click", closeModal);
    }
    if (els.backdrop && !els.backdrop.dataset.authWired) {
      els.backdrop.dataset.authWired = "1";
      els.backdrop.addEventListener("click", closeModal);
    }
    if (els.tabLogin && !els.tabLogin.dataset.authWired) {
      els.tabLogin.dataset.authWired = "1";
      els.tabLogin.addEventListener("click", function () {
        setActiveTab("login");
      });
    }
    if (els.tabSignup && !els.tabSignup.dataset.authWired) {
      els.tabSignup.dataset.authWired = "1";
      els.tabSignup.addEventListener("click", function () {
        setActiveTab("signup");
      });
    }
    if (els.loginForm && !els.loginForm.dataset.authWired) {
      els.loginForm.dataset.authWired = "1";
      els.loginForm.addEventListener("submit", handleLoginSubmit);
    }
    if (els.signupForm && !els.signupForm.dataset.authWired) {
      els.signupForm.dataset.authWired = "1";
      els.signupForm.addEventListener("submit", handleSignupSubmit);
    }
    if (els.googleBtn && !els.googleBtn.dataset.authWired) {
      els.googleBtn.dataset.authWired = "1";
      els.googleBtn.addEventListener("click", function () {
        window.location.href = "/api/auth/oauth/google";
      });
    }
    if (els.steamBtn && !els.steamBtn.dataset.authWired) {
      els.steamBtn.dataset.authWired = "1";
      els.steamBtn.addEventListener("click", function () {
        window.location.href = "/api/auth/openid/steam";
      });
    }

    // Global key handling: Escape closes; Tab is trapped while the modal is open.
    document.addEventListener("keydown", function (e) {
      if (!isOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key === "Tab") {
        trapFocus(e);
      }
    });
  }

  function isOpen() {
    return !!modalRoot && !modalRoot.classList.contains("hidden");
  }

  function trapFocus(e) {
    var focusables = modalRoot.querySelectorAll(
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

  function openModal(tab) {
    if (!modalRoot) injectModal();
    setActiveTab(tab === "signup" ? "signup" : "login");
    modalRoot.classList.remove("hidden");
    modalRoot.classList.add("flex");
    document.body.style.overflow = "hidden";
    lastFocused = document.activeElement;
    requestAnimationFrame(function () {
      var target = tab === "signup" ? els.signupEmail : els.loginEmail;
      if (target && typeof target.focus === "function") target.focus();
    });
  }

  function closeModal() {
    if (!modalRoot) return;
    clearError();
    modalRoot.classList.add("hidden");
    modalRoot.classList.remove("flex");
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  function setActiveTab(tab) {
    if (!els.tabLogin || !els.tabSignup || !els.loginForm || !els.signupForm) return;
    var login = tab !== "signup";
    els.tabLogin.setAttribute("aria-selected", login ? "true" : "false");
    els.tabSignup.setAttribute("aria-selected", login ? "false" : "true");
    els.tabLogin.classList.toggle("bg-brand-600", login);
    els.tabLogin.classList.toggle("text-white", login);
    els.tabLogin.classList.toggle("text-slate-400", !login);
    els.tabSignup.classList.toggle("bg-brand-600", !login);
    els.tabSignup.classList.toggle("text-white", !login);
    els.tabSignup.classList.toggle("text-slate-400", login);
    els.loginForm.classList.toggle("hidden", !login);
    els.signupForm.classList.toggle("hidden", login);
    clearError();
  }

  // -------------------------------------------------------------------------
  // Error banner
  // -------------------------------------------------------------------------

  function showError(message) {
    if (!els.errorBanner) return;
    els.errorBanner.textContent = message || "Something went wrong. Please try again.";
    els.errorBanner.classList.remove("hidden");
    els.errorBanner.classList.add("flex");
  }

  function clearError() {
    if (!els.errorBanner) return;
    els.errorBanner.textContent = "";
    els.errorBanner.classList.add("hidden");
    els.errorBanner.classList.remove("flex");
  }

  function mapAuthError(status, error) {
    if (status === 401) return "Invalid email or password";
    if (status === 409) return "Email already in use";
    if (status === 400) return error || "Please check your details and try again.";
    return error || "Something went wrong. Please try again.";
  }

  // -------------------------------------------------------------------------
  // Form submission (native login / register)
  // -------------------------------------------------------------------------

  function setSubmitBusy(form, busy) {
    var btn = form && form.querySelector(".auth-submit-btn");
    if (!btn) return;
    btn.disabled = busy;
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    var email = els.loginEmail.value.trim();
    var password = els.loginPassword.value;
    if (!email || !password) {
      showError("Please enter your email and password.");
      return;
    }
    clearError();
    setSubmitBusy(els.loginForm, true);
    try {
      var res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showError(mapAuthError(res.status, data.error));
        return;
      }
      currentUser = data.user || null;
      currentProfile = null;
      renderHeader();
      closeModal();
      refreshProfile();
      broadcastAuth();
    } catch (err) {
      console.error("Login error:", err);
      showError("Unable to reach the server. Please try again.");
    } finally {
      setSubmitBusy(els.loginForm, false);
    }
  }

  async function handleSignupSubmit(e) {
    e.preventDefault();
    var email = els.signupEmail.value.trim();
    var password = els.signupPassword.value;
    var confirm = els.signupConfirm.value;
    if (!email || !password || !confirm) {
      showError("Please fill in all fields.");
      return;
    }
    if (password.length < 8) {
      showError("Password must be at least 8 characters long.");
      return;
    }
    if (password !== confirm) {
      showError("Passwords do not match.");
      return;
    }
    clearError();
    setSubmitBusy(els.signupForm, true);
    try {
      var res = await apiFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showError(mapAuthError(res.status, data.error));
        return;
      }
      currentUser = data.user || null;
      currentProfile = null;
      renderHeader();
      closeModal();
      refreshProfile();
      broadcastAuth();
    } catch (err) {
      console.error("Register error:", err);
      showError("Unable to reach the server. Please try again.");
    } finally {
      setSubmitBusy(els.signupForm, false);
    }
  }

  // -------------------------------------------------------------------------
  // Logout + rehydration events
  // -------------------------------------------------------------------------

  async function handleLogout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.warn("Logout request failed; clearing local session anyway:", err);
    }
    currentUser = null;
    currentProfile = null;
    renderHeader();
    broadcastAuth();
  }

  function broadcastAuth() {
    window.dispatchEvent(new CustomEvent("mgpl:auth-changed", { detail: { user: currentUser } }));
    window.dispatchEvent(new CustomEvent("mgpl:data-rehydrate", { detail: { user: currentUser } }));
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  async function refreshUser() {
    try {
      var res = await apiFetch("/api/auth/me");
      if (!res.ok) {
        currentUser = null;
      } else {
        var data = await res.json().catch(function () {
          return null;
        });
        currentUser = data && data.user ? data.user : null;
      }
    } catch (err) {
      currentUser = null;
    }
    renderHeader();
    if (currentUser) {
      refreshProfile();
    } else {
      currentProfile = null;
    }
  }

  // Fetch the privacy-minimized public profile (displayName / gamerTag / avatarUrl /
  // profileVisibility) so the header pill can surface the player's chosen
  // identity instead of only the account email. Immediately re-renders the
  // header once the profile payload resolves (database-authoritative rehydrate).
  async function refreshProfile() {
    if (!currentUser) {
      currentProfile = null;
      renderHeader();
      return;
    }
    try {
      var res = await apiFetch("/api/user/profile");
      if (!res.ok) {
        currentProfile = null;
      } else {
        var data = await res.json().catch(function () {
          return null;
        });
        currentProfile = data && data.profile ? data.profile : null;
      }
    } catch (err) {
      currentProfile = null;
    }
    renderHeader();
  }

  function bootstrap() {
    // Render the unauthenticated state immediately so the Log In button is
    // present before the async /me check resolves.
    renderHeader();
    injectModal();
    wireEvents();
    refreshUser();
  }

  function init() {
    if (!initialized) {
      initialized = true;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootstrap);
      } else {
        bootstrap();
      }
    } else {
      renderHeader();
    }
    return window.__auth;
  }

  // kick off immediately — this file is loaded with `defer`, so the DOM is
  // parsed and interactive by the time this IIFE runs.
  init();

  window.__auth = {
    init: init,
    refreshUser: refreshUser,
    getCurrentUser: function () {
      return currentUser;
    },
    getProfile: function () {
      return currentProfile;
    },
    openLogin: function () {
      openModal("login");
    },
    logout: handleLogout,
  };
})();
