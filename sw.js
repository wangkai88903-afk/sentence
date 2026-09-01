const CACHE = "lcs-checkin-v1";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.png"];

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
  // 导航请求：网络优先，失败回退缓存（保证更新能生效，离线也能开）
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) {
        var cp = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", cp); });
        return res;
      }).catch(function () { return caches.match("./index.html"); })
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
