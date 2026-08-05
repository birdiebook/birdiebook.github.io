"use strict";
/* EN plats som äger VAR appens tunga filer bor (MOLN_PLAN §6 V0).
 *
 * Kartrutor och 3D-hål ska flytta till Cloudflare R2 — `mobile/tiles/` ensamt är
 * 25 646 filer och Cloudflare Pages tar max 20 000 per deploy, så koden kan inte
 * flytta förrän filerna gjort det. Den här modulen gör flytten till ETT
 * strängbyte i stället för en jakt genom fyra filer.
 *
 * `BAS = ""` betyder "bredvid appen" — exakt dagens beteende, byte för byte.
 * Sätts den till en R2-URL blir samma sökvägar absoluta mot den värden.
 *
 * SÖKVÄGSFORMEN ÄR ETT KONTRAKT, inte en tillfällighet: hinken måste spegla
 * `tiles/<slug>/{z}/{x}/{y}.webp` och `data/holes3d/**` precis som mappen gör.
 * `sw.js` känner igen filerna på PATHEN (inte på värden), så en spegling betyder
 * att offline-cachen fortsätter fungera utan att ett enda mönster ändras.
 *
 * Laddas både i sidor (<script>) och i service workern (importScripts), därför
 * `self` och inte `window`. */
const SGAsset = (() => {
  // Tom = relativt appen. R2 sätts som "https://<värd>/" — MED avslutande slash.
  const BAS = "https://pub-33b0042dbd1c4c7483414bf0ac910d1d.r2.dev/";

  const bas = () => BAS;
  const extern = () => BAS !== "";

  /* Värden filerna ligger på, eller null när de ligger bredvid appen.
     `sw.js` behöver den för att släppa in dem genom sin origin-grind. */
  function origin() {
    if (!BAS) return null;
    try { return new URL(BAS).origin; } catch (_) { return null; }
  }

  // "./tiles/x" och "tiles/x" ska ge samma sak — anropsställena skrev olika.
  const url = (p) => BAS + String(p == null ? "" : p).replace(/^\.?\//, "");

  const tiles        = (slug) => url(`tiles/${slug}`);
  const tileManifest = (slug) => url(`tiles/${slug}/manifest.json`);
  const tileTemplate = (slug) => url(`tiles/${slug}/{z}/{x}/{y}.webp`);
  const tile   = (slug, z, x, y) => url(`tiles/${slug}/${z}/${x}/${y}.webp`);
  const holes3d = (fil) => url(`data/holes3d/${fil}`);

  /* Leaflet: utan `crossOrigin` hämtas rutorna som vanliga <img> i no-cors-läge,
     och svaret blir OPAQUE. Ett opaque svar har `status 0` och `ok === false` —
     `cacheFirst` i sw.js sparar det därför ALDRIG, och offline-nedladdningen
     fyller tyst ingenting medan appen ser helt frisk ut online. Flaggan kostar
     ingenting när filerna ligger bredvid appen, så den sätts bara vid extern
     bas för att inte ändra dagens beteende i onödan. */
  const tileCors = () => extern();

  return { bas, extern, origin, url, tiles, tileManifest, tileTemplate, tile,
           holes3d, tileCors };
})();
if (typeof self !== "undefined") self.SGAsset = SGAsset;
if (typeof module !== "undefined" && module.exports) module.exports = SGAsset;
