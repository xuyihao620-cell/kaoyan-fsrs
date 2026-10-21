const CACHE_NAME = "kaoyan-5530-fsrs-v11";
const AUDIO_CACHE = "kaoyan-5530-audio-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== AUDIO_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.hostname === "api.github.com") {
    return;
  }
  if (url.hostname === "dict.youdao.com") {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(resp => {
            if (resp && (resp.status === 200 || resp.type === "opaque")) {
              cache.put(event.request, resp.clone());
            }
            return resp;
          });
        })
      )
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.status === 200 && event.request.method === "GET") {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match("./index.html")))
  );
});
