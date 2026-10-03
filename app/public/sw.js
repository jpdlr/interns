/**
 * Interns PWA service worker.
 *
 * Goals, in order:
 *  1. Never cache the API. The orchestrator now serves this bundle from the
 *     same origin, so /interns, /cards, /hire and /events would otherwise be
 *     fair game — a cached card list or a replayed SSE stream would be worse
 *     than no offline support at all.
 *  2. Always notice a new build. The HTML shell is network-first, so a
 *     re-exported dist/ is picked up on the next launch.
 *  3. Never re-download an unchanged asset. Everything under /_expo/static is
 *     content-hashed, so it is cache-first and immutable.
 *
 * BUILD is stamped at export time by scripts/stamp-sw.mjs, which is what makes
 * the browser see this file as changed and run the update cycle at all.
 */
const BUILD = "__BUILD__";
const CACHE = `interns-${BUILD}`;

/** Anything the orchestrator answers dynamically. Must never be cached. */
const API_PATHS = /^\/(interns|cards|activity|hire|events|meta|push|capabilities|github|webhooks|attachments|tasks|rooms|reports|suggest|messages|pages|rules|agenda|ideas)(\/|$)/;
/** Content-hashed or otherwise immutable static files. */
const STATIC_PATHS = /^\/(_expo|assets)\/|\.(js|css|png|jpe?g|svg|ico|woff2?|ttf)$/;

self.addEventListener("install", () => {
  // A new build should take over immediately rather than waiting for every
  // tab to close — the update UI reloads the page when it matters.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // `/hire` (and old `/cards` links) are app routes as well as API prefixes.
  // The orchestrator answers a page navigation there with that route's own
  // pre-rendered page, so fetch the request itself: serving the "/" shell
  // would hydrate the home HTML under /hire and throw React #418.
  // (Attachment links opened in a tab are real files — leave those alone.)
  if (request.mode === "navigate" && API_PATHS.test(url.pathname) && !url.pathname.startsWith("/attachments/")) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (API_PATHS.test(url.pathname)) return; // straight to the network, always

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (STATIC_PATHS.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

/** Fresh shell when online; last known good shell when not. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match("/"));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

/**
 * Web Push. iOS 16.4+ only delivers these to a PWA installed to the home
 * screen (see app/README.md) — this handler itself works the same everywhere
 * a push subscription can exist, no platform branching needed here.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Interns", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Interns";
  const options = {
    body: payload.body || "",
    tag: payload.tag || undefined,
    // same-tag notifications replace each other on the lock screen instead
    // of piling up — a chatty intern still gets debounced server-side too.
    renotify: Boolean(payload.tag),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: payload.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Tapping a notification focuses (or opens) the app and navigates to its url. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const requested = new URL(url, self.location.origin);
      const target = requested.origin === self.location.origin ? requested.href : `${self.location.origin}/`;
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const appClients = allClients.filter((client) => new URL(client.url).origin === self.location.origin);
      // Prefer the window the user was most recently looking at. On iOS the
      // standalone PWA and Safari live in separate storage partitions, but
      // focused/visible still makes this deterministic on desktop browsers.
      const client = appClients.find((candidate) => candidate.focused)
        || appClients.find((candidate) => candidate.visibilityState === "visible")
        || appClients[0];
      if (client) return focusAndNavigate(client, target);
      return self.clients.openWindow(target);
    })(),
  );
});

/**
 * iOS frequently focuses an installed PWA but rejects WindowClient.navigate.
 * Ask the already-running Expo router to navigate first and wait for an ACK;
 * fall back to a full document navigation for an older app bundle that does
 * not know this message yet.
 */
async function focusAndNavigate(client, target) {
  let focused = client;
  try {
    focused = (await client.focus()) || client;
  } catch {
    // Navigation below may still work even if focus was rejected.
  }

  if (typeof MessageChannel !== "undefined") {
    const channel = new MessageChannel();
    const acknowledged = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 750);
      channel.port1.onmessage = (message) => {
        if (!message.data || message.data.handled !== true) return;
        clearTimeout(timer);
        resolve(true);
      };
    });
    try {
      client.postMessage(
        { type: "interns:notification-navigation", url: target },
        [channel.port2],
      );
      if (await acknowledged) return focused;
    } catch {
      // Older WebKit builds can reject transferable ports; use navigate.
    }
  }

  if ("navigate" in client) {
    try {
      const navigated = await client.navigate(target);
      if (navigated && new URL(navigated.url).href === target) return navigated.focus();
    } catch {
      // WebKit commonly lands here for an installed PWA.
    }
  }
  // This still carries notification-click user activation, so WebKit permits
  // openWindow even when navigating the existing standalone client failed.
  try {
    const opened = await self.clients.openWindow(target);
    if (opened) return opened.focus();
  } catch {
    // Last resort: the app is at least foregrounded rather than doing nothing.
  }
  return focused;
}
