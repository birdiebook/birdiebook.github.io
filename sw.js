/* Service worker för SG Rundlogg — offline-cache av mobilappen.
 *
 * Se SERVICE_WORKER_PLAN.md. Kärnidé: kartrutorna (tiles/**) är statiska
 * (Burlöv, Lantmäteriets ortofoto 2024) → varje ruta laddas ner EN gång
 * någonsin och sparas permanent i en egen cache (sg-tiles) som ALDRIG rensas
 * vid koduppdateringar. Runda 2+ = ~0 MB för kartan, fungerar offline.
 *
 * Tre cachar:
 *   sg-shell-v<VERSION>  app-shell (HTML, JS, vendor, ikoner). Rensas vid ny VERSION.
 *   sg-data              bandata (burlov.json, tiles/manifest.json). Network-first.
 *   sg-tiles             kartrutor. PERMANENT — överlever alla VERSION-byten.
 *
 * KILL-SWITCH: om en SW-bugg låser användare, ersätt HELA denna fil med:
 *     self.addEventListener('install', () => self.skipWaiting());
 *     self.addEventListener('activate', async () => {
 *       await self.registration.unregister();
 *       const keys = await caches.keys();
 *       await Promise.all(keys.map(k => caches.delete(k)));
 *       const cs = await self.clients.matchAll();
 *       cs.forEach(c => c.navigate(c.url));
 *     });
 * ...publicera, låt alla klienter öppna appen en gång (avregistrerar + rensar),
 * återställ sedan denna fil.
 *
 * Byts ortofotot någon gång: byt TILES_CACHE-namnet (t.ex. "sg-tiles-2024b") så
 * gamla rutor slängs och nya hämtas.
 */
"use strict";

// Bumpas per deploy för att slå igenom ny kod. Kan sättas för hand eller
// injiceras av ett publiceringsskript (ersätt strängen med kort commit-sha).
const VERSION = "2026-07-21b";

const SHELL_CACHE = "sg-shell-v" + VERSION;
const DATA_CACHE  = "sg-data";
const TILES_CACHE = "sg-tiles";

// App-shell: allt som behövs för att sidorna ska rendera offline.
// (Supabase-js laddas från CDN och faller tyst tillbaka offline — ingår ej.)
const SHELL_ASSETS = [
  "./",
  "index.html",
  "karta.html",
  "redigera.html",
  "oversikt.html",
  "oversikt-analys.html",
  "analys.html",
  "boot.js",
  "round.js",
  "analys-core.js",
  "coursemap.js",
  "mapcore.js",
  "redigera.js",
  "score.js",
  "live.js",
  "offline-download.js",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/leaflet-rotate.js",
  "manifest.json",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
];

// ── install: precacha shell ──────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Enskilda 404 ska inte spränga hela installen (t.ex. om en fil döps om).
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (res.ok) await cache.put(url, res);
      } catch (_) { /* offline vid install — fylls lazy vid nästa online-besök */ }
    }));
    await self.skipWaiting();
  })());
});

// ── activate: rensa gamla shell-cachar (behåll data + tiles) ──────────────
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k.startsWith("sg-shell-v") && k !== SHELL_CACHE) return caches.delete(k);
      return undefined; // sg-data och sg-tiles lämnas orörda
    }));
    await self.clients.claim();
  })());
});

// ── hjälpare ───────────────────────────────────────────────────────────────
const isTile = (url) => /\/tiles\/\d+\/\d+\/\d+\.webp$/.test(url.pathname);
const isData = (url) =>
  /\/data\/burlov\.json$/.test(url.pathname) ||
  /\/data\/green_slope\.geojson$/.test(url.pathname) ||
  /\/tiles\/manifest\.json$/.test(url.pathname);

// cache-first: serva ur cache, annars nät + spara. Används för tiles + shell-assets.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

// network-first: färskt från nät (och uppdatera cache), fallback till cache offline.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

// ── fetch-router ─────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                 // bara GET cachas

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // cross-origin (Supabase, Open-Meteo) släpps förbi orört

  // Kartrutor: cache-first, permanent i sg-tiles (ALDRIG rensad).
  if (isTile(url)) {
    event.respondWith(cacheFirst(req, TILES_CACHE));
    return;
  }

  // Bandata: network-first, fallback cache i sg-data.
  if (isData(url)) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // Navigering (HTML): network-first → alltid senaste koden online (fixar
  // "gammal HTML"-buggen), fallback till cachad shell offline.
  if (req.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith((async () => {
      try {
        return await networkFirst(req, SHELL_CACHE);
      } catch (_) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(req)) ||
               (await cache.match("index.html")) ||
               (await cache.match("./")) ||
               Response.error();
      }
    })());
    return;
  }

  // Övriga same-origin-assets (JS, CSS, ikoner, vendor): cache-first.
  event.respondWith(cacheFirst(req, SHELL_CACHE).catch(() => caches.match(req)));
});
