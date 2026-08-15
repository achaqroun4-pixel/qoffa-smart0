const CACHE_NAME = 'qoffa-smart-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/products.html',
  '/product-detail.html',
  '/bundles.html',
  '/order.html',
  '/about.html',
  '/contact.html',
  '/terms.html',
  '/return-policy.html',
  '/manifest.json',
  '/assets/js/api-client.js',
  '/assets/js/main.js',
  '/assets/js/confirmation-modal.js',
  '/assets/js/reorder-popup.js',
  '/assets/js/reorder-popup-init.js',
  '/assets/js/image-optimizer.js',
  '/assets/js/home.js',
  '/assets/js/about.js',
  '/assets/js/contact.js',
  '/assets/js/order.js',
  '/assets/js/blog.js',
  '/assets/js/baserow-fix.js',
  '/assets/js/free-shipping-promo.js',
  '/assets/js/global-reorder-init.js',
  '/assets/js/last-order-tracker.js',
  '/assets/js/paniers-script.js',
  '/assets/js/header-product-search-v1.js',
  '/assets/images/logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => undefined))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((name) => name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

function blockedBaserowResponse() {
  return new Response(JSON.stringify({ error: 'Direct Baserow access is blocked' }), {
    status: 403,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never allow or cache direct browser-to-Baserow requests.
  if (url.hostname === 'api.baserow.io') {
    event.respondWith(Promise.resolve(blockedBaserowResponse()));
    return;
  }

  // API and non-GET requests must always use the network. Do not cache
  // orders, contact forms, inventory mutations, or backend responses.
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    event.respondWith(fetch(request));
    return;
  }

  const isStatic = url.pathname === '/'
    || url.pathname.endsWith('.html')
    || url.pathname.startsWith('/assets/')
    || url.pathname === '/manifest.json';

  if (!isStatic) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'error') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
