/* Service worker för SG Rundlogg — offline-cache av mobilappen.
 *
 * Se SERVICE_WORKER_PLAN.md. Kärnidé: kartrutorna (tiles/**) är statiska
 * (Burlöv, Lantmäteriets ortofoto 2024) → varje ruta laddas ner EN gång
 * någonsin och sparas permanent i en egen cache (sg-tiles) som ALDRIG rensas
 * vid koduppdateringar. Runda 2+ = ~0 MB för kartan, fungerar offline.
 *
 * Fyra cachar:
 *   sg-shell-v<VERSION>  app-shell (HTML, JS, vendor, ikoner). Rensas vid ny VERSION.
 *   sg-data              bandata (burlov.json, tiles/manifest.json). Network-first.
 *   sg-tiles             kartrutor. PERMANENT — överlever alla VERSION-byten.
 *   sg-holes3d           3D-hålens glb/meta. PERMANENT, av samma skäl som tiles.
 *
 * sg-holes3d kom med U11 (UPPGRADERING_3D §5). Hålens glb är ~4 MB styck (72
 * hål, 291 MB) och föll förut på sista raden i routern → SHELL_CACHE, som töms
 * vid VARJE VERSION-bump. Så länge 3D var en sällan-vy märktes det inte; när
 * den blev ett tryck bort i planeringsvyn hade varje publicering kostat 4 MB
 * per hål om. Filerna är statiska (exporterade av tools/hole_gltf.py) — byts en
 * export ut, byt cache-namnet, precis som för ortofotot.
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

// Var de tunga filerna bor (MOLN_PLAN §6 V0). Samma modul som sidorna laddar,
// så service workern och appen kan aldrig få olika uppfattning om saken.
importScripts("assetbas.js");

// Bumpas per deploy för att slå igenom ny kod. Kan sättas för hand eller
// injiceras av ett publiceringsskript (ersätt strängen med kort commit-sha).
const VERSION = "2026-08-05-assetbas";

const SHELL_CACHE  = "sg-shell-v" + VERSION;
const DATA_CACHE   = "sg-data";
const TILES_CACHE  = "sg-tiles";
const HOLES3D_CACHE = "sg-holes3d";

// App-shell: allt som behövs för att sidorna ska rendera offline.
// (Supabase-js laddas från CDN och faller tyst tillbaka offline — ingår ej.)
const SHELL_ASSETS = [
  "./",
  // index.html är HUBBEN sedan AS-IA steg 3 (§2.8.0) — appens rot och
  // offline-fallbackens mål. Slagloggningen bor i spela.html; saknas DEN i
  // listan fungerar appen online men inte på banan, vilket är hela poängen.
  "index.html",
  "spela.html",
  "karta.html",
  "planera.html",
  "planvy.html",
  "plan.html",
  "planera-karta.html",
  "redigera.html",
  "oversikt.html",
  "oversikt-analys.html",
  "analys.html",
  "uppsattning.html",
  "profil.html",
  "tokens.css",
  "boot.js",
  // Flikraden är delad sedan AS-IA steg 1 (APPSTORE_PLAN §2.8.1). Utan den
  // här raden renderar sidorna offline UTAN navigation — alltså på banan.
  "nav.js",
  // Sidospelets vyer är delade mellan Översikt (rundhalvan) och uppsattning.html
  // sedan AS-IA steg 2 (§2.8.2). Saknas filen offline tappar Översikt ställningen.
  "sidospel.js",
  "round.js",
  "analys-core.js",
  "analys-lista.js",
  "spelformer.js",
  "sg.js",
  "coursemap.js",
  "bildfilter.js",
  "mapcore.js",
  "playas.js",
  "sol.js",
  "laggmat.js",
  "slopeoverlay.js",
  "redigera.js",
  "score.js",
  // Positionskällan bakom ett lager sedan N1 (NATIVE_APP_PLAN §3.2). Saknas
  // filen offline kan spela.html inte logga ett enda slag — alltså på banan.
  "geo.js",
  "markhojd.js",
  "spelprofil.js",
  "vylage.js",
  "plan.js",
  // SP2–SP4: planens förslag räknas i telefonen. Utan de här tre raderna
  // fungerar planeringsvyn online men står utan förslag på banan — alltså
  // precis där den ska svara utan nät (SPELPLAN_PLAN §1).
  "strategi.js",
  "forslag.js",
  // SP5: dokumentet räknas också i telefonen. Utan raden kan "Min plan" inte
  // byggas på banan, vilket är precis där en plan behövs.
  "planrunda.js",
  "vybro.js",
  "planslag.js",
  "kompass.js",
  "store.js",
  // Var kartrutor och 3D-hål bor. Laddas av sidorna OCH av denna fil
  // (importScripts ovan) — utan den i shell-cachen skulle en installation
  // offline få en service worker som inte kan starta.
  "assetbas.js",
  "live.js",
  // Identiteten (MOLN_PLAN §6 V1). Måste finnas offline av samma skäl som
  // live.js: profil.html laddar den, och en saknad fil hade tagit hela sidan.
  "konto.js",
  "offline-download.js",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/leaflet-rotate.js",
  "manifest.json",
  "data/courses.json",
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
      return undefined; // sg-data, sg-tiles och sg-holes3d lämnas orörda
    }));
    await self.clients.claim();
  })());
});

// ── hjälpare ───────────────────────────────────────────────────────────────
// tiles/<slug>/{z}/{x}/{y}.webp (V8b — bana-scopad, se tools/build_imagery_tiles.py --mobile)
const isTile = (url) => /\/tiles\/[^/]+\/\d+\/\d+\/\d+\.webp$/.test(url.pathname);
// data/holes3d/** — hålens glb + meta-json. Statiska per export (U11).
const isHole3d = (url) => /\/data\/holes3d\//.test(url.pathname);
// Bandata för VALFRI bana (t.ex. data/burlov.json, data/ven.json) — network-first
// så senaste versionen alltid vinner online, med cache-fallback offline. Ingen
// bana hårdkodad här: mönstret matchar "<slug/mobile_json>.json" generellt.
// courses.json (registryn) räknas som app-shell (precachas, se SHELL_ASSETS ovan).
// FÖLJDEN, värd att veta: registryn serveras därför CACHE-FIRST och uppdateras
// bara när VERSION byts. Ändrar du mobile/data/courses.json (t.ex. via
// tools/publish_mobile_ratings.py) måste du bumpa VERSION ovan, annars kör
// telefonerna kvar på den gamla registryn — inklusive gamla CR/slope, vilket
// tyst ger fel netto. Bandata per bana (<slug>.json) är network-first och har
// inte det problemet.
// green_slope.<slug>.geojson (V4b — bana-scopad, se tools/build_green_slope.py)
// matchas generellt likadant, ingen bana hårdkodad.
// data/strategi/<bana>/<profilkombination>.json (SP1, SPELPLAN_PLAN) — värdeytan
// planen föreslår spel ur. Ligger en katalognivå djupare än övrig bandata och
// föll därför utanför mönstret ovan: utan den här raden hämtades den från nätet
// varje gång och fanns inte alls på banan, vilket är just var den behövs.
const isData = (url) =>
  (/\/data\/[^/]+\.json$/.test(url.pathname) && !/\/data\/courses\.json$/.test(url.pathname)) ||
  /\/data\/strategi\/[^/]+\/[^/]+\.json$/.test(url.pathname) ||
  /\/data\/green_slope\.[^/]+\.geojson$/.test(url.pathname) ||
  /\/tiles\/[^/]+\/manifest\.json$/.test(url.pathname);

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
  // Cross-origin (Supabase, Open-Meteo) släpps förbi orört — MED UNDANTAG för
  // värden som bär kartrutor och 3D-hål. Utan undantaget slutar allt nedan
  // gälla i samma sekund som filerna flyttar till R2 (MOLN_PLAN §6 V0):
  // ingenting cachas, offline-nedladdningen fyller tomt, och appen ser frisk ut
  // så länge man har täckning. Det är den tystaste tänkbara regressionen.
  // SGAsset.origin() är null tills basen pekar bort, så raden är en no-op idag.
  const assetOrigin = (typeof SGAsset !== "undefined" && SGAsset.origin()) || null;
  if (url.origin !== self.location.origin && url.origin !== assetOrigin) return;

  // Kartrutor: cache-first, permanent i sg-tiles (ALDRIG rensad).
  if (isTile(url)) {
    event.respondWith(cacheFirst(req, TILES_CACHE));
    return;
  }

  // 3D-hål: cache-first, permanent i sg-holes3d (överlever VERSION-bump).
  // Före bandata-regeln, så en meta-json under holes3d/ inte hamnar i sg-data.
  if (isHole3d(url)) {
    event.respondWith(cacheFirst(req, HOLES3D_CACHE));
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
