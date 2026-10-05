self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* Gelen bildirimlerin kaydı: uygulama simgesindeki rozet ve uygulama içi "yeni bildirimlerin var" kartı için.
   Cache Storage hem servis worker'dan hem sayfadan okunabildiği için ortak depo olarak kullanılıyor. */
const BOX = 'duzen-inbox', BOXKEY = '/__inbox';
async function readBox() {
  try { const c = await caches.open(BOX); const r = await c.match(BOXKEY); return r ? await r.json() : { items: [], badge: 0 }; }
  catch (_) { return { items: [], badge: 0 }; }
}
async function writeBox(b) {
  try { const c = await caches.open(BOX); await c.put(BOXKEY, new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } })); }
  catch (_) { /* kayıt tutulamazsa bildirim yine de gösterilmiştir */ }
}
async function windows() {
  try { return await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); } catch (_) { return []; }
}

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const tag = d.tag || 'duzen';
  e.waitUntil((async () => {
    // Önce bildirimi göster (Safari, gösterilmeyen bildirimlerde izni geri alır)
    await self.registration.showNotification(d.title || 'Düzen', {
      body: d.body || '',
      tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: d.url || '/' }
    });
    try {
      const all = await windows();
      const visible = all.some(c => c.visibilityState === 'visible');   // kişi uygulamaya bakıyorsa rozet gerekmez
      const b = await readBox();
      b.items = [{ ts: Date.now(), title: d.title || 'Düzen', body: d.body || '', url: d.url || '/', tag, read: false }, ...(b.items || [])].slice(0, 50);
      if (!visible) b.badge = (b.badge || 0) + 1;
      await writeBox(b);
      if (!visible && 'setAppBadge' in self.navigator) await self.navigator.setAppBadge(b.badge);
      all.forEach(c => c.postMessage({ type: 'inbox' }));
    } catch (_) { /* rozet ayarlanamazsa bildirim yine de gösterilmiştir */ }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  const tag = e.notification.tag;
  e.waitUntil((async () => {
    try {   // dokunulan bildirim "kaçırılmış" sayılmasın
      const b = await readBox(); let ch = false;
      (b.items || []).forEach(i => { if (!i.read && i.tag === tag) { i.read = true; ch = true; } });
      if (ch) await writeBox(b);
    } catch (_) { /* önemsiz */ }
    const all = await windows();
    for (const c of all) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'nav', url }); return; }
    }
    return self.clients.openWindow(url);
  })());
});

self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const all = await windows();
    all.forEach(c => c.postMessage({ type: 'resub' }));
  })());
});
