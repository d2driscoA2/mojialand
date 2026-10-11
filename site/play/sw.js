/* Release 1.4 #14: offline play and cheap return visits for /play/.
   Scope /play/ only. Never touches /api/, /pass/, /r/, /g/, /admin/ or any function.
   The game page loads from the network first (so a new build always wins when online)
   and falls back to the saved copy offline. Fonts and logos load from the saved copy first.
   /play/build.json is never saved (the #49 update check needs the live answer).
   The build script stamps the build id below; a new build makes a new cache and drops the old one. */
'use strict';
var BUILD = '__MOJIA_BUILD__';
var CACHE = 'mojia-play-' + BUILD;
var PAGE = '/play/';
var STATIC = ['/fonts/nunito-latin.woff2', '/logo/logo-3d-1000.webp', '/logo/wordmark.png', '/logo/icon-180.png', '/logo/monogram-watermark.png', '/logo/icon-32.png', '/logo/favicon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.add(new Request(PAGE, { cache: 'reload' })).then(function () {
      return Promise.all(STATIC.map(function (u) { return c.add(u).catch(function () {}); }));
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('mojia-play-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isStatic(path) { return STATIC.indexOf(path) !== -1; }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  var p = url.pathname;
  if (p === PAGE || p === '/play/index.html') {
    // Network first. The address may carry ?restore=TOKEN; the saved copy is stored without it.
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(PAGE, copy); });
      }
      // Host busy or paused (5xx or 429): play from the saved copy when there is one.
      if (res && (res.status >= 500 || res.status === 429)) {
        return caches.match(PAGE, { ignoreSearch: true }).then(function (hit) { return hit || res; });
      }
      return res;
    }).catch(function () {
      return caches.match(PAGE, { ignoreSearch: true }).then(function (hit) { return hit || Response.error(); });
    }));
    return;
  }
  if (isStatic(p)) {
    e.respondWith(caches.match(p).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(p, copy); }); }
        return res;
      });
    }));
  }
  // Everything else (build.json, api calls, other pages) goes to the network untouched.
});
