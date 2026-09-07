/*
 * Service worker: caches the whole app on first visit so it opens with no
 * signal at all, which on a riverbank is the normal condition.
 *
 * Cache-first for the app shell; the version string is bumped by the build so
 * a new deploy replaces the old cache instead of sitting behind it.
 */
var VERSION = 'nymph-v2';
var SHELL = [
  './3d.html',
  './index.html',
  './manifest.webmanifest',
  './src/style.css',
  './src/audio.js',
  './src/river.js',
  './src/rig.js',
  './src/fish.js',
  './src/game.js',
  './src/render.js',
  './src/render3d.js',
  './src/main.js',
  './vendor/three.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(e.request).then(function (res) {
      if (res && res.ok && new URL(e.request.url).origin === self.location.origin) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    });
  }));
});
