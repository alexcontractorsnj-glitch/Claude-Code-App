// ============================================================================
//  sw.js — Corefield service worker. Makes the field app installable and
//  usable with no signal: the app shell is precached (cache-first), the last
//  schedule read is cached for offline boot (network-first w/ cache fallback),
//  and write requests are never cached — the app's outbox handles those.
// ============================================================================
/* eslint-env serviceworker */

const VERSION = 'corefield-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './store.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  '../src/mobile/core.js',
  '../src/js/seed.js',
  '../src/js/utils.js',
  '../src/js/punch.js',
  '../src/js/fieldreports.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // writes go straight to network/outbox
  const url = new URL(req.url);

  // GET /api/state — network-first so we get fresh data, cache for offline read.
  if (url.pathname === '/api/state') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('cf-state', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('cf-state').then((r) => r || new Response('{}', { headers: { 'Content-Type': 'application/json' } }))),
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return;     // other API calls: let them hit the network

  // App shell + assets — cache-first, fall back to network and warm the cache.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
