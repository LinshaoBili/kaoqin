/*
 * 离线外壳缓存。
 *
 * 目标：**首次打开之后，断网也能正常显示二维码**。
 * 做法是把整个页面（含二维码库、图标、manifest）在 install 阶段就存进 Cache Storage，
 * 之后 fetch 一律先看缓存——页面没有任何需要实时性的内容，缓存优先是最合适的策略。
 *
 * 两个细节值得留意：
 * 1. 用逐个 `add()` 而不是 `addAll()`：addAll 是「全成功或全失败」，
 *    只要清单里有一个文件 404，整个 Service Worker 就装不上，用户从此只能联网用。
 * 2. 安装时带 `cache: 'reload'`：绕过 HTTP 缓存，确保更新后拿到的是磁盘上的新文件
 *    （否则改了页面、SW 也更新了，用户看到的还是旧的 index.html）。
 *
 * 换版本时改下面的 CACHE 常量（发布脚本会自动写成本次版本号）。
 */
const CACHE = 'kaoqin-v0.3.4';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './qr-payload.js',
  './bind-store.js',
  './vendor/qrcode.js',
  './vendor/jsQR.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      return Promise.all(
        ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            // 单个文件缺失不该拖垮整个安装：少一个图标也要能离线出码
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 页面导航：缓存里的 index.html 优先，断网时绝不出现浏览器的"无法连接"页
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((hit) => {
        if (hit) return hit;
        return fetch(req).catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((resp) => {
          // 运行时补缓存：以后新增的文件也能在第一次访问后离线可用
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => hit);
    })
  );
});
