const CACHE = "lcs-checkin-v2";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).catch(function () {}));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  // 导航请求：优先返回缓存的 App Shell，避免 Render 休眠时长时间白屏/显示默认页；同时后台尝试网络刷新缓存
  if (req.mode === "navigate") {
    e.respondWith(
      caches.match("./index.html").then(function (cached) {
        var network = fetch(req).then(function (res) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put("./index.html", cp); });
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }
  // 其他静态资源：缓存优先
  e.respondWith(
    caches.match(req).then(function (m) {
      if (m) return m;
      return fetch(req).then(function (res) {
        if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
        return res;
      }).catch(function () { return m; });
    })
  );
});
