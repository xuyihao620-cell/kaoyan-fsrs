const CACHE_NAME = "kaoyan-fsrs-v147";
const AUDIO_CACHE = "kaoyan-5530-audio-v1";
const FONT_CACHE = "kaoyan-serif-font-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./icon-E.html",
  "./app-style.css?v=146",
  "./app-bundle.js?v=146",
  "./manifest.json",
  "./manifest-E.json",
  "./apple-touch-icon.png"
];

function fetchWithTimeout(req, timeoutMs) {
  if (typeof AbortController === "undefined") return fetch(req);
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(ASSETS.map(url => fetch(new Request(url, { cache: "no-cache" })).then(resp => {
        if (resp && resp.status === 200) return cache.put(url, resp);
      }).catch(() => {})))
    )
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== AUDIO_CACHE && k !== FONT_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.hostname === "api.github.com") {
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.loli.net" || url.hostname === "gstatic.loli.net") {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetchWithTimeout(event.request, 2000).then(resp => {
            if (resp && (resp.status === 200 || resp.type === "opaque")) {
              cache.put(event.request, resp.clone());
            }
            return resp;
          }).catch(() => new Response("", { status: 204 }));
        })
      )
    );
    return;
  }
  if (url.hostname === "dict.youdao.com" || (url.hostname === "ssl.gstatic.com" && url.pathname.includes("/dictionary/")) || url.hostname === "fanyi.baidu.com") {
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
  const isDoc = event.request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  const isCoreAsset = isDoc || url.pathname.endsWith(".css") || url.pathname.endsWith(".js");
  const reqTarget = (isCoreAsset && event.request.method === "GET")
    ? new Request(event.request.url, { cache: "no-store" })
    : event.request;
  event.respondWith(
    (isCoreAsset ? fetchWithTimeout(reqTarget, 2200) : fetch(reqTarget))
      .then(resp => {
        if (resp && resp.status === 200 && event.request.method === "GET") {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request).then(r => {
        if (r) return r;
        if (isDoc) return caches.match("./index.html");
        return Response.error();
      }))
  );
});

self.addEventListener("push", event => {
  const handlePush = async () => {
    let data = null;
    if (event.data) {
      try {
        data = event.data.json();
      } catch (e) {
        try {
          const txt = event.data.text();
          if (txt) data = { title: "📅 今日卡片待复习提醒", body: txt };
        } catch (e2) {}
      }
    }
    const title = (data && data.title) ? data.title : "📅 今日卡片待复习提醒";
    const body = (data && data.body) ? data.body : "今日考研卡片已到期，点击打开卡片盒开始复习";
    const tag = (data && data.tag) ? data.tag : "kaoyan-daily-reminder";
    const url = (data && data.url) ? data.url : "./";
    await self.registration.showNotification(title, {
      body,
      icon: "./apple-touch-icon.png",
      badge: "./apple-touch-icon.png",
      tag,
      renotify: true,
      data: { url }
    });
  };
  event.waitUntil(handlePush());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) {
          try { client.postMessage({ type: "OPEN_DUE_BELL" }); } catch (e) {}
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
