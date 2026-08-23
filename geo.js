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
 * STRÖMMENS LIVSLÄNGD ligger däremot här, och det är inte samma sak som
 * apppolicy: VEM som får starta strömmen är rundans fråga (spela.html startar
 * bara med aktiv runda), men att en startad ström aldrig får bli kvar efter
 * sidan som startade den är en egenskap hos källan. I native-skalet överlever
 * den nämligen webbvyn — se städningen vid `beforeunload` nedan.
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

  /* ---------- native-källan (N3) ----------
     Adaptern presenterar `navigator.geolocation`s gränssnitt
     (`watchPosition`/`clearWatch`/`getCurrentPosition`) med
     BackgroundGeolocation under. Skälet att adaptera i stället för att greina
     i `start()`/`watch()`/`current()`: strypningen, lyssnarhanteringen och
     felnormaliseringen ska finnas i EN uppsättning kod. Tre grenar hade blivit
     tre beteenden som glider isär, och den som glider tyst är den som bara kör
     på riktig hårdvara — alltså den ingen ser förrän på banan.

     `distanceFilter: 0` är inte en slump utan HELA poängen (N3): ett
     avståndsfilter levererar inga uppdateringar när spelaren står still, vilket
     är exakt ögonblicket vid bollen. Takten sänks i stället med tid, i `takt()`
     ovan. Rör aldrig den nollan.

     `backgroundMessage` är det som faktiskt slår på bakgrundsläget i pluginen —
     utan den blir det en vanlig förgrundswatch och hela etappen är verkningslös
     utan att något går sönder. */
  const BG_OPT = {
    backgroundMessage: "Birdiebook loggar din position under rundan.",
    backgroundTitle: "Runda pågår",
    requestPermissions: true,
    stale: false,
    distanceFilter: 0,
  };

  function bgPlugin() {
    const w = typeof window !== "undefined" ? window : null;
    const C = w && w.Capacitor;
    if (!C || typeof C.isNativePlatform !== "function" || !C.isNativePlatform()) return null;
    const P = (C.Plugins && C.Plugins.BackgroundGeolocation) || w.BackgroundGeolocation;
    return P && typeof P.addWatcher === "function" ? P : null;
  }

  /* Pluginens position → samma form som `navigator.geolocation` ger, så
     `fixAv()` ovan inte behöver veta var fixen kom ifrån. */
  const somPosition = l => ({ coords: {
    latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy } });

  function nativeAdapter(P) {
    const vakter = new Map();      // vårt id → pluginens id (en Promise)
    let nasta = 1;
    return {
      _native: true,
      watchPosition(ok, fel, _opt) {
        const id = nasta++;
        vakter.set(id, P.addWatcher(BG_OPT, (plats, err) => {
          if (err) {
            /* Pluginen säger NOT_AUTHORIZED där webben säger code 1. Vi
               översätter till webbens form, för `felAv()` är det enda stället
               som får tolka ett fel. */
            if (fel) fel({ code: err.code === "NOT_AUTHORIZED" ? 1 : 2 });
            return;
          }
          if (plats && ok) ok(somPosition(plats));
        }));
        return id;
      },
      clearWatch(id) {
        const p = vakter.get(id);
        if (!p) return;
        vakter.delete(id);
        Promise.resolve(p)
          .then(pid => P.removeWatcher({ id: pid }))
          .catch(() => {});
      },
      /* En engångsfix är en watch som stängs vid första svaret. Pluginen har
         ingen egen getCurrentPosition, och att falla tillbaka på
         `navigator.geolocation` här hade gett en fix ur en ANNAN mottagarsession
         än strömmen — med annan noggrannhet och annan ålder. */
      getCurrentPosition(ok, fel, _opt) {
        let klar = false;
        const id = this.watchPosition(
          p => { if (klar) return; klar = true; this.clearWatch(id); if (ok) ok(p); },
          e => { if (klar) return; klar = true; this.clearWatch(id); if (fel) fel(e); });
      },
    };
  }

  let nativeKalla = null;
  const source = () => {
    if (injicerad) return injicerad;
    if (nativeKalla) return nativeKalla;
    const P = bgPlugin();
    if (P) {
      nativeKalla = nativeAdapter(P);
      /* FLAGGAN VÄNDS HÄR, inte av ett anrop skalet måste komma ihåg. Ett
         glömt `_settBackgroundCapable(true)` hade gett en app som ser hel ut
         men kör webbens beteende: ingen strypning och en Wake Lock som håller
         skärmen vaken hela rundan — den dyraste posten i batterikalkylen (§N4).
         Att härleda förmågan ur att pluginen FAKTISKT svarar är det enda som
         inte kan glömmas bort. */
      bakgrundsformaga = true;
      return nativeKalla;
    }
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

  /* Levande handtag från `watch()`. Finns bara för städningen nedan: en ström
     som ingen hann stänga är på webben en glömd watch, men i native-skalet en
     bakgrundssession som ligger kvar utanför rundan. */
  const egnaStrommar = new Set();

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
    const h = {
      stop() {
        egnaStrommar.delete(h);
        if (id !== null) { g.clearWatch(id); id = null; }
      },
    };
    egnaStrommar.add(h);
    return h;
  }

  /* ---------- städning när sidan lämnas ----------

     Appen är sidor, inte en enda vy: varje flikbyte river JS-kontexten. På
     webben spelar det ingen roll — webbläsaren stänger sina egna watchar med
     dokumentet. I native-skalet lever strömmen NEDANFÖR webbvyn: pluginen har
     fått ett `addWatcher` och håller en bakgrundssession tills någon säger
     `removeWatcher`. Ingen säger det när kontexten dör, och id:t vi hade
     behövt dör med den — nästa sidladdning KAN ALLTSÅ INTE städa upp efter den
     förra. Enda tillfället att säga stopp är innan vi går.

     Det är den här raden som gör "GPS bara under runda" till något mer än en
     avsikt: utan den räcker det att spelaren avslutar rundan och navigerar
     vidare för att telefonen ska fortsätta ligga i bakgrundsläge — utan runda,
     utan sida, och utan något kvar i appen som kan stänga av den.

     `beforeunload`, INTE `pagehide`: det förra fyras bara när dokumentet
     faktiskt lämnas, det senare även när systemet fryser sidan för att appen
     gick i bakgrunden. Att stänga strömmen just då vore att stänga av precis
     det etappen finns för (N3, skärmen släckt mitt i rundan) — ett fel som är
     osynligt vid datorn och upptäcks på banan.

     `pageshow` med `persisted` är vägen tillbaka: kommer spelaren bakåt till
     en sida ur bfcachen lever kontexten och lyssnarna vidare, och då ska
     strömmen starta om av sig själv. */

  let stoppadAvSidbyte = false;

  function slappVidSidbyte() {
    stoppadAvSidbyte = igang();
    stop();
    for (const h of [...egnaStrommar]) h.stop();
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeunload", slappVidSidbyte);
    window.addEventListener("pageshow", e => {
      if (e && e.persisted && stoppadAvSidbyte) { stoppadAvSidbyte = false; start(); }
    });
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
             egnaStrommar.clear(); stoppadAvSidbyte = false;
             nativeKalla = null;   // annars läcker en tidigare adapter in i nästa prov
           },
           /* Bara för testerna: tvinga om-uppslaget av native-källan så ett prov
              kan sätta upp en attrapp-plugin på `window.Capacitor` och se att
              adaptern faktiskt väljs. */
           _glomNativeKalla() { nativeKalla = null; },
           /* Vänder native-sömmen. N3:s skal sätter den till true när pluginen
              är på plats; tills dess är det testerna som använder den för att
              kunna mäta strypningen innan skalet finns. */
           _settBackgroundCapable(v) { bakgrundsformaga = !!v; } };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Geo;
