/*
 * 考勤 · 网页版 离线外壳缓存。
 *
 * 与学生端网页版同样的策略：install 阶段把整个外壳（HTML / JS / 图标 / 扫码库）存进
 * Cache Storage，之后一律缓存优先——考勤数据本身在 localStorage，页面不需要实时内容，
 * 断网也要能点名。
 *
 * 换版本时改 CACHE 常量（发布脚本会同步写成本次版本号）。
 * 前缀 `kaoqin-web-`：与旧版本（`kaoqin-teacher-`）区分，activate 时一并清掉旧缓存。
 */
// 版本号不变但资源有改动时用 -rN 后缀强制老客户端换缓存（cache-first，不改名换不掉）
const CACHE = 'kaoqin-web-v0.3.8';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './logic.js',
  './manifest.webmanifest',
  '../vendor/jsQR.js',
  '../qr-payload.js',
  '../icons/icon-192.png',
  '../icons/icon-512.png',
  '../icons/apple-touch-icon.png'
];

const OLD_PREFIXES = ['kaoqin-web-', 'kaoqin-teacher-'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(
      ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))
    )).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE && OLD_PREFIXES.some((p) => k.indexOf(p) === 0))
        .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req).catch(() => caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => hit);
    })
  );
});
