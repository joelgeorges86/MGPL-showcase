/* MGPL Offline-First Service Worker (FEAT-0151)
 *
 * Cache strategies:
 *  - App shell (static assets): Cache-First with stale-while-revalidate refresh.
 *  - Navigation requests: Network-First, falling back to cached /index.html.
 *  - Same-origin /api/* GET: Network-First, falling back to runtime api-cache.
 *  - Cross-origin CDN (Tailwind CSS, Lucide): Stale-While-Revalidate.
 */
const CACHE_NAME = "mgpl-dashboard-v4";
const API_CACHE_NAME = "mgpl-api-cache-v1";

const APP_SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/storage.js",
  "/consent.js",
  "/drawer.js",
  "/palette.js",
  "/analytics.js",
  "/manifest.json",
  "/style.css",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg",
];

// CDN resources required for correct offline styling/icons.
const CDN_RESOURCES = ["https://cdn.tailwindcss.com", "https://unpkg.com/lucide@latest"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME && key !== API_CACHE_NAME) {
              return caches.delete(key);
            }
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Stale-While-Revalidate: serve cached copy immediately, refresh in background.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

// Network-First with fallback: try network, else serve cached copy.
async function networkFirst(request, cacheName, fallbackRequest) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackRequest) {
      const fallback = await caches.match(fallbackRequest);
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Allow play-session sync POSTs through to the network (never cached).
  if (
    request.method === "POST" &&
    url.origin === self.location.origin &&
    url.pathname === "/api/backlog/session"
  ) {
    return;
  }

  // Only handle GET requests.
  if (request.method !== "GET") return;

  // Same-origin API endpoints: Network-First with api-cache fallback.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, API_CACHE_NAME));
    return;
  }

  // Navigation requests: Network-First, fall back to cached app shell.
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, CACHE_NAME, "/index.html").catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Cross-origin CDN resources: Stale-While-Revalidate.
  if (CDN_RESOURCES.some((cdn) => url.href.startsWith(cdn))) {
    event.respondWith(staleWhileRevalidate(request, CACHE_NAME));
    return;
  }

  // Same-origin static assets: Cache-First with stale-while-revalidate refresh.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, CACHE_NAME));
    return;
  }
});

// Background Sync: flush queued play sessions when connectivity returns.
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-play-sessions") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: "MGPL_SYNC_PLAY_SESSIONS" });
        }
      }),
    );
  }
});

// Relay a request from a page to register a background sync tag.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "MGPL_REGISTER_SYNC") {
    if ("sync" in self.registration) {
      self.registration.sync.register("sync-play-sessions").catch(() => {});
    }
  }
});

// Push notifications: display a deal alert when the server pushes one.
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "MGPL Deal Alert", body: "A tracked game just hit your target price!" };
  }

  const title = data.title || "MGPL Deal Alert";
  const options = {
    body: data.body || "A tracked game just hit your target price!",
    icon: data.icon || "/manifest.json",
    badge: data.badge || "/manifest.json",
    tag: data.tag || "mgpl-deal-alert",
    data: { url: data.url || "/#/wishlist" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click: focus an existing client or open the wishlist view.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/#/wishlist";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
