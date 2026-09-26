// =====================================================================
// Service Worker der installierbaren Web-App (2026-09).
//
//   - offline nutzbar: die App-Huelle (index.html) und die gehashten
//     Build-Dateien werden beim ersten Besuch bzw. beim ersten Abruf
//     zwischengespeichert
//   - SPA-Routen: GitHub Pages liefert /destroy usw. ueber 404.html mit
//     Status 404 aus; Navigationen bekommen hier immer Status 200
//   - Android "Teilen": das geteilte Bild (POST an ./share-target) wird
//     lokal abgelegt und die App unter ./destroy?shared=1 geoeffnet
//
// Nichts davon verlaesst das Geraet: es gibt keinen Server-Endpunkt, die
// Caches liegen im Browser.
// =====================================================================

const SHELL = 'shell-v1';
const ASSETS = 'assets-v1';
const INBOX = 'share-inbox';
const MAX_ASSETS = 60;
const BASE = new URL('./', self.location).pathname;

function assetUrls(html) {
  const out = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)) {
    out.push(new URL(m[1], self.location).href);
  }
  return out;
}

// Navigationsantwort als 200-HTML (auch wenn GitHub Pages 404 meldet)
async function asShell(res) {
  const body = await res.blob();
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch(BASE, { cache: 'no-cache' });
      if (res.ok) {
        const html = await res.clone().text();
        await (await caches.open(SHELL)).put(BASE, await asShell(res));
        const assets = await caches.open(ASSETS);
        await Promise.all(assetUrls(html).map((u) => assets.add(u).catch(() => {})));
      }
    } catch {
      // offline beim Installieren: der naechste Besuch fuellt die Caches
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function trimAssets(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

async function navigation(request) {
  try {
    // Immer beim Server nachfragen (304 ist billig): GitHub Pages erlaubt
    // Browsern sonst 10 Minuten alte Seiten — neue Versionen kamen spaet an
    const res = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
    const html = (res.headers.get('Content-Type') || '').includes('text/html');
    if (res.ok || (res.status === 404 && html)) {
      const shell = await asShell(res);
      (await caches.open(SHELL)).put(BASE, shell.clone());
      return shell;
    }
    return res;
  } catch {
    const cached = await caches.match(BASE, { cacheName: SHELL });
    return cached || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    trimAssets(cache);
  }
  return res;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  const update = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit || Response.error());
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return update;
}

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.getAll('image').find((f) => f && typeof f !== 'string');
    if (file) {
      const inbox = await caches.open(INBOX);
      await inbox.put(BASE + 'shared-image', new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'geteilt'),
        },
      }));
    }
  } catch {
    // Ohne Datei oeffnet die App einfach die Upload-Seite
  }
  return Response.redirect(BASE + 'destroy?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  if (request.method === 'POST' && url.pathname === BASE + 'share-target') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
  } else if (url.pathname.startsWith(BASE + 'assets/')) {
    event.respondWith(cacheFirst(request));
  } else if (!url.search) {
    // Icons, Manifest, Test-Screenshots; Adressen mit Parametern
    // (z. B. die Weiterleitung nach dem Teilen) nicht zwischenspeichern
    event.respondWith(staleWhileRevalidate(request, event));
  }
});
