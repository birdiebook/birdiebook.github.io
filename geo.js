"use strict";
/* GEO — positionskällan bakom ett lager (NATIVE_APP_PLAN.md §3.2, etapp N1).
 *
 * Modulen äger EN sak: den råa strömmen av fixar. Ringbufferten, `pickBest`,
 * medianfiltret och acc-vakten ligger kvar OVANFÖR lagret i spela.html — det
 * är just det som gör att webben och native-skalet delar all logik och bara
 * byter källa.
 *
 * VARFÖR TVÅ STRÖMMAR. Planens API-skiss (§3.2) har en enda ström
 * (`start`/`stop`/`onFix`). Koden behöver två: `collectFix` öppnar en EGEN
 * watch vid varje slagtryck, för att garantera färska fixar även när
 * huvudwatchen strypts i bakgrunden. Därför finns `watch()` bredvid `start()`.
 * Det är inte en komplikation utan hela poängen med lagret: på webben öppnar
 * `watch()` en riktig andra watch, medan native-grenen (N3) kan låta den vara
 * en ren PRENUMERATION på den ström som ändå hålls varm. Anroparen märker
 * ingen skillnad.
 *
 * FIXENS FORM är `{lat, lon, acc, ts}` — inte `{..., accuracy}` som §3.2:s
 * skiss skrev. Hela appen (pickBest, gpsChipHtml, capture, Store) talar redan
 * `acc`, och att döpa om fältet i lagret hade tvingat fram en översättning i
 * varje anropare utan att någon blev klokare.
 *
 * REN och importfri (som planslag.js och spelprofil.js): ingen Store, inget
 * fetch. Wake Lock hör INTE hit — den är apppolicy ("håll skärmen tänd medan en
 * runda pågår"), inte en egenskap hos positionskällan.
 *
 * ETT undantag från "ingen DOM": skärmläget. N3 stryper huvudströmmen när
 * skärmen är släckt, och VILKEN TAKT källan levererar i är en egenskap hos
 * källan — inte hos vyn (NATIVE_APP_PLAN §N3). Modulen lyssnar därför på
 * `visibilitychange` om ett `document` finns, och skalet kan säga samma sak
 * själv via `settSkarmlage()` när Capacitors app-state är sanningen.
 */
const Geo = (() => {

  /* Källan slås upp lat, inte vid laddning: i ett native-skal hinner
     Capacitor-bryggan inte alltid finnas när skriptet körs. `_useSource` finns
     för testerna (node har ingen navigator). */
  let injicerad = null;
  const source = () => {
    if (injicerad) return injicerad;
    const n = typeof navigator !== "undefined" ? navigator : null;
    return n && n.geolocation ? n.geolocation : null;
  };

  const available = () => source() !== null;

  /* Felen normaliseras HÄR därför att båda anroparna behöver exakt samma
     tolkning av `code`. Texterna är ordagrant de som låg i spela.html före
     N1 — en ändrad formulering hade varit en beteendeförändring, och N1:s
     kontrakt är att det inte finns någon. */
  const NEKAD = "GPS nekad — tillåt platsåtkomst i webbläsaren.";
  const INGEN_POS = "Fick ingen GPS-position, försök igen.";
  const INGEN_GPS = "Ingen GPS i webbläsaren.";

  function felAv(e) {
    const nekad = e && e.code === 1;
    const err = new Error(nekad ? NEKAD : INGEN_POS);
    err.denied = !!nekad;
    return err;
  }

  const fixAv = p => ({ lat: p.coords.latitude, lon: p.coords.longitude,
                        acc: p.coords.accuracy, ts: Date.now() });

  /* Samma optioner som före N1. `maximumAge: 0` på strömmarna är avsiktligt:
     en cachad fix från förra hålet är värdelös när man står vid bollen. */
  const STROM_OPT  = { enableHighAccuracy: true, maximumAge: 0 };
  const ENGANG_OPT = { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 };

  /* ---------- takten på huvudströmmen (N3) ---------- */

  /* Precisionen är maximal hela tiden; det är LEVERANSTAKTEN som sänks när
     skärmen är släckt (grundaren 2026-08-03). Ingen behöver en position per
     sekund mellan slagen — men chippet ska aldrig gå kallt.

     DETTA ÄR EN TIDSSTRYPNING, ALDRIG `distanceFilter`. Den detaljen är den enda
     i etappen som kan bli tyst fel: `distanceFilter` är ett AVSTÅNDSvillkor, så
     står man stilla levereras INGA uppdateringar alls — och att stå stilla vid
     bollen är exakt det ögonblick appen finns för. Med en tidsstrypning ovanpå
     den kontinuerliga strömmen är senaste fixen aldrig äldre än intervallet,
     oavsett om spelaren rör sig eller står still.

     Strypningen gäller BARA huvudströmmen. `watch()` (slagtrycket) får allt —
     det är fem sekunder per slag och hela poängen med att strömmen hålls varm. */
  const TAKT_SYNLIG = 1000;    // 1 Hz
  const TAKT_DOLD = 10000;     // 0,1 Hz

  let skarmSynlig = true;
  let sistUtskickad = 0;

  /* Noll = ingen strypning. Webben stryper inte alls: där finns ingen
     bakgrundsström att spara, webbläsaren fryser ändå sidan när den döljs, och
     att ändra takten hade varit en beteendeförändring utan vinst. Raden vänds
     av att `isBackgroundCapable()` blir sann, inte av något annat. */
  function takt() {
    if (!isBackgroundCapable()) return 0;
    return skarmSynlig ? TAKT_SYNLIG : TAKT_DOLD;
  }

  /* Skalet anropar denna när Capacitors app-state ändras; webben får samma sak
     ur `visibilitychange` nedan. Att sätta läget nollställer INTE klockan —
     annars hade en skärm som tänds och släcks upprepat kunnat pressa fram fixar
     tätare än takten. */
  function settSkarmlage(synlig) { skarmSynlig = !!synlig; }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange",
      () => settSkarmlage(!document.hidden));
  }

  /* ---------- huvudströmmen (en per app) ---------- */

  let huvudId = null;
  const lyssnare = new Set();

  function start() {
    if (huvudId !== null) return true;        // redan igång — idempotent
    const g = source();
    if (!g) return false;
    sistUtskickad = 0;                        // första fixen släpps alltid fram
    huvudId = g.watchPosition(
      p => {
        const f = fixAv(p);
        const t = takt();
        if (t && sistUtskickad && f.ts - sistUtskickad < t) return;
        sistUtskickad = f.ts;
        for (const cb of lyssnare) cb(f);
      },
      () => {},                                // tyst, som före N1
      STROM_OPT);
    return true;
  }

  function stop() {
    if (huvudId === null) return;
    const g = source();
    if (g) g.clearWatch(huvudId);
    huvudId = null;
  }

  const igang = () => huvudId !== null;

  /* Returnerar en avregistrerare — annars läcker en vy som byts ut. */
  function onFix(cb) {
    lyssnare.add(cb);
    return () => lyssnare.delete(cb);
  }

  /* ---------- egen ström (en per slagtryck) ---------- */

  /* På webben en RIKTIG andra watch. I native-skalet (N3) blir detta en
     prenumeration på den varma strömmen i stället — samma signatur, samma
     anropare, ingen ändring ovanför lagret. */
  function watch({ onFix: cbFix, onError } = {}) {
    const g = source();
    if (!g) {
      if (onError) onError(new Error(INGEN_GPS));
      return { stop() {} };
    }
    let id = g.watchPosition(
      p => { if (cbFix) cbFix(fixAv(p)); },
      e => { if (onError) onError(felAv(e)); },
      STROM_OPT);
    return {
      stop() { if (id !== null) { g.clearWatch(id); id = null; } },
    };
  }

  /* ---------- engångsfix ---------- */

  function current() {
    return new Promise((resolve, reject) => {
      const g = source();
      if (!g) return reject(new Error(INGEN_GPS));
      g.getCurrentPosition(p => resolve(fixAv(p)),
                           e => reject(felAv(e)),
                           ENGANG_OPT);
    });
  }

  /* ---------- native-sömmen ---------- */

  /* Falskt på webben, och det är hela skillnaden N3 ska vända. Anropare får
     använda den för att SÄGA något ärligt ("appen kan inte logga med skärmen
     släckt") och för att slippa webbkryckor som Wake Locken — aldrig för att
     räkna annorlunda på en position.

     Flaggan är en variabel och funktionen en konstant, inte tvärtom: exporteras
     funktionen i objektet nedan fryses värdet den hade DÅ, och en omvänd flagga
     hade synts inne i modulen men inte utanför. */
  let bakgrundsformaga = false;
  const isBackgroundCapable = () => bakgrundsformaga;

  return { available, start, stop, igang, onFix, watch, current,
           isBackgroundCapable, settSkarmlage,
           TEXT: { NEKAD, INGEN_POS, INGEN_GPS },
           TAKT: { SYNLIG: TAKT_SYNLIG, DOLD: TAKT_DOLD },
           _takt: takt,
           _useSource(g) {
             injicerad = g; huvudId = null; lyssnare.clear();
             skarmSynlig = true; sistUtskickad = 0;
           },
           /* Vänder native-sömmen. N3:s skal sätter den till true när pluginen
              är på plats; tills dess är det testerna som använder den för att
              kunna mäta strypningen innan skalet finns. */
           _settBackgroundCapable(v) { bakgrundsformaga = !!v; } };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Geo;
