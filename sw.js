// sw.js — cachea sólo el "shell" de la app (HTML/CSS/JS propios) para que
// abra offline. Las llamadas a la API de IA siempre necesitan red y nunca
// se cachean aquí.
const CACHE = 'pts-studio-v10';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/utils.js',
  './js/canonGuard.js',
  './js/retrieval.js',
  './js/generation.js',
  './js/memoryEngine.js',
  './js/providers/base.js',
  './js/providers/gemini.js',
  './js/providers/openai.js',
  './js/providers/openrouter.js',
  './js/providers/index.js',
  './js/ui/write.js',
  './js/ui/chapters.js',
  './js/ui/characters.js',
  './js/ui/documents.js',
  './js/ui/memory.js',
  './js/ui/settings.js',
  './js/ui/appearance.js',
  './icons/icon.svg',
  './icons/black-cat.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Nunca interceptar llamadas a APIs externas de IA.
  if (url.origin !== self.location.origin) return;

  // Actualizaciones visibles: intentar la red primero; si no hay red, usar shell guardado.
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(new Request(event.request, { cache: 'no-store' })).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.match(event.request)) || Response.error())
  );
});
