// Service worker mínimo: só faz o navegador tratar o site como app instalável (PWA).
// Não guarda dados nem funciona offline; sempre busca a versão mais nova da rede.
const CACHE_NAME = 'fluxo-pf-shell-v2';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).catch(() => caches.match(e.request))); // sempre confere com o servidor: a versão nova aparece sem esperar o cache do navegador
});
