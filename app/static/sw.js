/* Service Worker：首次在线打开后缓存应用外壳，断网刷新仍可采集 */
"use strict";

// 版本号随应用外壳内容变更而递增：激活时清除旧缓存，
// 确保各标签页拿到最新的采集页脚本（v2：多标签页队列自动同步）。
const CACHE = "forest-patrol-v2";
const SHELL = [
  "/",
  "/static/app.js",
  "/static/style.css",
  "/static/sample-photo.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);

  // 只接管本站 GET；POST（补传）直接走网络，离线时自然失败，
  // 由页面逻辑把记录保留在待传列表。
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // 已入库数据与照片必须实时，不缓存
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/photos/")) return;

  if (req.mode === "navigate") {
    // 页面：优先网络（在线拿最新），失败回退缓存（断网可用）
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return resp;
        })
        .catch(() =>
          caches.match(req).then(hit => hit || caches.match("/"))
        )
    );
    return;
  }

  // 静态资源：缓存优先，未命中再联网并补缓存
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return resp;
    }))
  );
});
