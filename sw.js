/* NEON VOID · 霓虹虚空 — Service Worker（唯一的附加文件）
   单文件游戏的离线缓存：stale-while-revalidate，hash 参数不影响命中（# 不发往网络）
   [FIX-SW1] 每次发版必须递增 CACHE 版本号：activate 清掉旧缓存，已打开的旧标签页
   下一次请求即换新版本，避免修复后的代码被旧缓存持续顶住（白屏旧案复发通道） */
const CACHE = 'neon-void-v5'; // v1.3.0 收尾：manifest/图标落地为同源文件，随 CORE 预缓存（发版必递增）
const CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => {}); // 配额满时不产生 unhandled rejection
        }
        return res;
      })
        .catch(() => hit ||
          // [FIX-SW1] 命中与直连都失败（install 期缓存被吞/配额清理）时降级回首页缓存，
          // 离线首启不再落到浏览器错误页
          caches.match('./', { ignoreSearch: true }).then((fb) => fb || Response.error()));
      return hit || net;
    })
  );
});
