'use strict';
(() => {
  const configured = String(window.MAZREN_CONFIG?.apiOrigin || '').replace(/\/+$/, '');
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (configured) {
    const u = new URL(configured);
    if (u.origin !== configured || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) throw new Error('Invalid backend origin');
  }
  const apiOrigin = configured || (location.hostname.endsWith('.github.io') ? '' : location.origin);
  const staticImages = new Set(["/dafprzod.jpg","/daftyl.jpg","/favicon.png","/logo.png","/manprzod.jpg","/mantyl.jpg","/mercedesprzod.jpg","/mercedestyl.jpg","/preview.png","/renaultprzod.jpg","/renaulttprzod.jpg","/renaultttyl.jpg","/renaulttyl.jpg","/scaniapgrprzod.jpg","/scaniapgrtyl.jpg","/scaniarprzod.jpg","/scaniartyl.jpg","/volvo1.png","/volvo2.png","/volvo4przod.jpg","/volvo4tyl.jpg","/volvoprzod.jpg","/volvotyl.jpg"]);
  const nativeFetch = window.fetch.bind(window);
  window.mazrenResourceUrl = value => {
    if (typeof value !== 'string') return value;
    if (staticImages.has(value)) return new URL('.' + value, document.baseURI).href;
    if (/^\/(api|uploads)\//.test(value)) return apiOrigin ? apiOrigin + value : '';
    return value;
  };
  function resources(value) {
    if (Array.isArray(value)) return value.map(resources);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, resources(v)]));
    return window.mazrenResourceUrl(value);
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, document.baseURI);
    const api = url.origin === location.origin && url.pathname.startsWith('/api/');
    if (!api) return nativeFetch(input, init);
    if (!apiOrigin) throw new Error('Backend nie jest skonfigurowany. Uzupełnij public/config.js.');
    const headers = new Headers(init.headers);
    headers.set('X-Mazren-Request', '1');
    const response = await nativeFetch(apiOrigin + url.pathname + url.search, { ...init, headers, credentials: 'include', mode: 'cors' });
    // API returns root-relative file links. Resolve them against the backend, including private photos.
    const json = response.json.bind(response);
    response.json = async () => resources(await json());
    return response;
  };
  document.addEventListener('DOMContentLoaded', () => {
    if (location.hostname.endsWith('.github.io') && !apiOrigin) {
      const notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#182334;color:white;padding:12px;text-align:center';
      notice.textContent = 'Podgląd strony: backend nie jest jeszcze podłączony. Logowanie i dane firmy będą dostępne po konfiguracji.';
      document.body.append(notice);
    }
  });
})();
