/* 홈 화면 앱용 서비스 워커: 화면 파일만 캐시. 게임 진행(WebSocket)은 캐시와 무관. */
const CACHE = 'holdem-v1';
const FILES = ['./', './index.html', './engine.js', './table.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                     // 폰트 CDN 등은 그대로
  // 네트워크 우선, 실패하면 캐시 (항상 최신 화면을 쓰되 오프라인에서도 열리게)
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
