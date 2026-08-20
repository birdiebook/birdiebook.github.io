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

// Versionen ägs av version.js — samma sträng som appen skickar med varje runda
// som `client.app_version` (MOLN_PLAN §6 V2). Bumpas DÄR, inte här: två
// versionssträngar hade kunnat glida isär utan att något går sönder synligt.
importScripts("version.js");
const VERSION = SG_APP_VERSION;

const SHELL_CACHE  = "sg-shell-v" + VERSION;
const DATA_CACHE   = "sg-data";
const TILES_CACHE  = "sg-tiles";
/* 3D-hålens cache är PERMANENT (cache-first, överlever en VERSION-bump) därför
 * att en glb är ~4 MB och aldrig ändras — så länge exporten inte ändras.
 *
 * U28 bröt det antagandet: hålen byggs om med ny korridorbredd och ny kjol under
 * SAMMA filnamn. En telefon som redan cachat blue_1.glb hade då fortsatt visa
 * den gamla geometrin för alltid, hur många deployer som helst — konstaterat
 * 2026-08-12 direkt efter att den nya filen låg på R2.
 *
 * Därför bär cachenamnet en EXPORTVERSION. Den bumpas när holes3d byggs om, och
 * BARA då: den hör till assets, inte till appen, så den får inte hänga på
 * `VERSION` (som bumpas vid varje deploy och då hade kastat ~300 MB glb varje
 * gång). `activate` städar gamla `sg-holes3d*`-cachar, inklusive den namnlösa
 * ursprungliga. */
const HOLES3D_EXPORT = "2026-08-12-u28";
const HOLES3D_CACHE = "sg-holes3d-" + HOLES3D_EXPORT;

// App-shell: allt som behövs för att sidorna ska rendera offline.
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
  // Kartan över en sparad rundas slagpositioner. Ska fungera på banan (man
  // tittar på gårdagens hål medan man står på dagens) — alltså i shell-cachen.
  "rundkarta.html",
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
  "rundkarta.js",
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
  // Klientvägen till servern (MOLN_PLAN §6 V2b). Saknas den offline kan
  // spela.html inte köra — samma skäl som konto.js och live.js ovan.
  "molnrunda.js",
  // Inbjudan på namn (sql/inbjudan.sql). Laddas synkront av grinden
  // (uppsattning.html) och inbjudan.js även av hubben — en saknad fil hade
  // tagit hela sidan, inte bara inbjudningarna. Samma skäl som live.js ovan.
  "inbjudan.js",
  "boll.js",
  // Banväljaren. Grinden kan inte rita ett enda val utan den, och spela.html
  // läser nivåvillkoret ur den i avslutsvyn.
  "banval.js",
  // Versionssträngen. Service workern importerar den redan vid start, men den
  // måste finnas i cachen också: annars dör SW:n vid nästa offline-start.
  "version.js",
  "offline-download.js",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/leaflet-rotate.js",
  // Supabase-klienten. Lag pa jsdelivr fram till 2026-08-10 och blockerade da
  // sju sidor: ett synkront <script> mot en doman som varken star i
  // WKAppBoundDomains eller finns nar tackningen ar dalig. Den maste ligga
  // har av samma skal som live.js - utan den kan sidorna inte kora offline.
  "vendor/supabase-js.js",
  "manifest.json",
  "data/courses.json",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "golfare.png",       // hubbens profil-ring (index.html) + entréns märke
  "entre.html",        // entrégrinden (MOLN_PLAN §S1)
];

// ── install: precacha shell ──────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Enskilda 404 ska inte spränga hela installen (t.ex. om en fil döps om).
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (res.ok) await cache.put(url, await utanOmdirigering(res));
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
      // U28: en gammal holes3d-cache bär gammal GEOMETRI under samma filnamn.
      // Den måste bort, annars ser en befintlig installation aldrig ombygget.
      if (k.startsWith("sg-holes3d") && k !== HOLES3D_CACHE) return caches.delete(k);
      return undefined; // sg-data och sg-tiles lämnas orörda
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

// Ett svar som FÖLJT en omdirigering bär flaggan `redirected`, och ett sådant
// svar får inte serveras på en navigering — webbläsaren vägrar med
// "Response served by service worker has redirections" och sidan dör helt.
//
// Det biter oss därför att Cloudflare serverar sidorna utan ändelse: precachen
// hämtar "karta.html", får 307 till "/karta", och lagrar ett märkt svar. Så
// länge navigering var network-first användes cachen aldrig och felet låg dolt.
//
// Lösningen är att bygga om svaret till ett rent 200 innan det sparas. Kroppen
// och rubrikerna följer med; bara omdirigeringshistoriken faller bort.
async function utanOmdirigering(res) {
  if (!res || !res.redirected) return res;
  const kropp = await res.blob();
  return new Response(kropp, {
    status: 200,
    statusText: res.statusText,
    headers: res.headers,
  });
}

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

  // Navigering (HTML): cachen först, uppdatering i bakgrunden.
  //
  // VAR network-first fram till 2026-08-10, och det gjorde varje sidbyte
  // beroende av ett nätverkssvar. Fallbacken till cachen låg bakom ett
  // catch — men en långsam mobiluppkoppling KASTAR inget, den dröjer. Den
  // gamla sidan blev därför kvar på skärmen tills svaret kom, och trycket
  // såg ut att inte ha tagit. Värst i det native skalet (TestFlight), där
  // bytet karta -> Logga slag hängde varje gång; hemskärms-PWA:n märkte det
  // knappt, vilket dolde felet.
  //
  // Att servera HTML ur cachen är inte mer riskabelt än det vi redan gör:
  // JS och CSS är cache-first sedan tidigare, och hela shell-cachen töms vid
  // VERSION-bump. Skillnaden är att sidan nu ritas direkt och den färska
  // versionen hämtas hem under tiden — den syns vid nästa navigering.
  if (req.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);

      // Cloudflare serverar sidorna UTAN ändelse (/karta), medan precachen
      // lagrar dem MED (karta.html) — se nav.js filnamn(). Utan den här
      // översättningen missar uppslaget varje gång och vi står kvar på nätet,
      // vilket var precis felet som skulle bort.
      let hit = await cache.match(req);
      if (!hit && !url.pathname.endsWith(".html")) {
        const sista = url.pathname.split("/").pop();
        if (sista) hit = await cache.match(sista + ".html");
        else hit = await cache.match("index.html");
      }

      // Uppdatera i bakgrunden. waitUntil håller service workern vid liv tills
      // den är klar, utan att sidan väntar på den.
      const fardsk = fetch(req)
        .then(async (res) => {
          if (res && res.ok) await cache.put(req, await utanOmdirigering(res.clone()));
          return res;
        })
        .catch(() => null);

      // En äldre cache kan bära märkta svar; serva dem inte råa.
      if (hit && !hit.redirected) { event.waitUntil(fardsk); return hit; }
      if (hit) { event.waitUntil(fardsk); return utanOmdirigering(hit); }

      // Inte cachad (t.ex. första besöket på en sida): då måste vi vänta.
      const svar = await fardsk;
      if (svar) return svar;
      return (await cache.match("index.html")) ||
             (await cache.match("./")) ||
             Response.error();
    })());
    return;
  }

  // Övriga same-origin-assets (JS, CSS, ikoner, vendor): cache-first.
  event.respondWith(cacheFirst(req, SHELL_CACHE).catch(() => caches.match(req)));
});
