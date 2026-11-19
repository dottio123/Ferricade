// ferricade's service worker exists so browsers offer to install the console as an app.
// It caches nothing: navigations go to the network as usual, and every other request
// (the admin API, the live event stream, assets) is not intercepted at all.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request))
})
