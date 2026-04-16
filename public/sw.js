const CACHE_NAME = "snabchat-v2";
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET and API/chat requests — always go to network
  if (request.method !== "GET" || request.url.includes("/api/")) {
    return;
  }

  // Cache API rejects anything other than http(s). Browser extensions (Perplexity,
  // ad-blockers, etc.) inject chrome-extension:// / moz-extension:// requests
  // through the page's SW scope — ignore them.
  if (!request.url.startsWith("http:") && !request.url.startsWith("https:")) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for static assets
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => { /* cache rejected — ignore, response already returned */ });
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
