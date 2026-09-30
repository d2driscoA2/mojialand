// Moji admin phone alerts (Release 1.1 #23). Shows each push; tapping one opens the admin.
// No fetch handler: the admin always loads fresh from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Mojialand').slice(0, 60), {
    body: String(d.body || '').slice(0, 200),
    icon: '/logo/icon-192.png',
    badge: '/logo/icon-192.png',
    data: { url: '/admin/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.indexOf('/admin/') >= 0 && 'focus' in c) return c.focus();
    return self.clients.openWindow('/admin/');
  }));
});
