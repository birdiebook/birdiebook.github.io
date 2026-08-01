"use strict";
/* EFTERSLÄPNINGSMÄTNINGEN i 2D (UPPGRADERING_3D §2.4, etapp U2).
 *
 * VAD SOM MÄTS, OCH VARFÖR JUST DET. §2 lovar att allt som hör till marken
 * ritas i samma bildruta som marken. Det löftet går att kontrollera exakt,
 * för varje overlay har en MARKPUNKT (en lat/lon) och en SKÄRMPOSITION, och
 * kartan kan projicera markpunkten själv:
 *
 *     avvikelse = | overlayens ritade läge − map.projicering(dess markpunkt) |
 *
 * Är den noll ligger overlayen där marken ligger. Är den inte det släpar den,
 * och då spelar det ingen roll hur bra det ser ut i en skärmdump.
 *
 * TVÅ SORTER, TVÅ KRAV (§2.4): scengeometri 0 px, DOM-etiketter ≤ 1 px.
 * Skillnaden är inte godtycklig — en SVG-path ligger i `overlayPane` och får
 * pandes egen transform, alltså exakt samma som tiles; en DivIcon är ett eget
 * element som Leaflet positionerar i heltalspixlar, och en halv pixel
 * avrundning är fysik och inte slarv.
 *
 * MODULEN LÄSER, DEN RITAR INTE. Den rör aldrig kartan utom genom de
 * rörelser anroparen ber om i `svep`, och den lämnar kartan där den fann den.
 * Därför kan den ligga kvar i appen i stället för att vara en tillfällig krok:
 * en mätning som måste klistras in på nytt varje gång blir aldrig gjord igen.
 * Sidorna exponerar den bara under `?dbg=1`.
 */
const Laggmat = (() => {

  /* MÄTNINGEN SKER I SKÄRMKOORDINATER, och det var ett fynd att den måste.
     Första versionen läste path-ens `d` och jämförde mot
     `map.latLngToLayerPoint` — men Leaflets SVG-renderare räknar INTE om `d`
     vid panorering; den flyttar hela `<svg>`-behållaren och låter `d` stå kvar
     i sitt gamla lagerursprung. Jämförelsen mätte alltså hur långt kartan
     panorerats (2831 px över ett svep), inte hur mycket overlayen släpade.
     Ett mått som växer med rörelsen mäter rörelsen.

     Skärmläget är dessutom exakt det §2.4 ber om ("overlayens SKÄRMPOSITION")
     och det enda som är sant oavsett hur Leaflet råkar implementera sin
     renderare — `getScreenCTM` och `getBoundingClientRect` bär varenda
     transform på vägen, inklusive `leaflet-rotate`:s rotation av panen. */
  function skarmlage(path) {
    if (!path || typeof path.getPointAtLength !== "function") return null;
    let p;
    try { p = path.getPointAtLength(0); } catch (e) { return null; }
    const m = path.getScreenCTM();
    if (!m) return null;
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  /* Markpunktens skärmläge enligt KARTAN. `latLngToContainerPoint` är
     relativt kartbehållaren; rect-en lägger på behållarens eget läge så de
     två blir jämförbara i samma ram. */
  function projicerat(map, latlng) {
    const r = map.getContainer().getBoundingClientRect();
    const p = map.latLngToContainerPoint(latlng);
    return { x: r.left + p.x, y: r.top + p.y };
  }

  const avstand = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /* Leaflets latlngs kan vara nästlade (polygon = ringar av ringar). */
  function platta(v, ut) {
    ut = ut || [];
    for (const x of (Array.isArray(v) ? v : [v])) {
      if (Array.isArray(x)) platta(x, ut); else if (x && x.lat !== undefined) ut.push(x);
    }
    return ut;
  }

  /* Ett prov: alla overlays kartan bär just NU, jämförda mot projektionen.
     Returnerar { geometri, etiketter, antal: {geometri, etiketter} } där
     värdena är MAX-avvikelsen i px — max och inte medel, för §2.4 är ett tak
     och ett medelvärde döljer precis den ruta som glappade. */
  function prov(map) {
    let geo = 0, dom = 0, nGeo = 0, nDom = 0;
    map.eachLayer(lager => {
      // Scengeometri: polyline/polygon/circleMarker → en SVG-path.
      const latlngs = typeof lager.getLatLngs === "function" ? lager.getLatLngs() : null;
      // circleMarker: en path med EN markpunkt, aldrig klippt.
      if (lager._path && !latlngs && typeof lager.getLatLng === "function") {
        const r = lager._path.getBoundingClientRect();
        if (r.width || r.height) {
          geo = Math.max(geo, avstand({ x: r.left + r.width / 2, y: r.top + r.height / 2 },
                                      projicerat(map, lager.getLatLng())));
          nGeo++;
        }
        return;
      }
      if (lager._path && latlngs) {
        const punkter = platta(latlngs);
        /* KLIPPTA FORMER HOPPAS ÖVER, och det är inte att välja bort det
           svåra fallet. Leaflet klipper polyliner och polygoner mot vyn innan
           de ritas — sträcker sig formen utanför skärmen är det FÖRSTA RITADE
           hörnet en skärningspunkt med vykanten och inte första lat/lon.
           Att jämföra dem gav 2831 px efter tre zoomsteg, vilket inte var
           eftersläpning utan klippning: exakt det som ska hända, mätt som ett
           fel. En mätning som inte kan skilja avsikt från defekt är värdelös.
           Formen mäts alltså i de lägen där hela den syns, och det finns
           gott om dem i varje svep (antalet redovisas). */
        if (!punkter.length || !punkter.every(p => map.getBounds().contains(p))) return;
        const ritad = skarmlage(lager._path);
        if (ritad) {
          geo = Math.max(geo, avstand(ritad, projicerat(map, punkter[0])));
          nGeo++;
        }
        return;
      }
      // DOM-etiketter: markörer med ikon (DivIcon eller bild). Elementets
      // MITT är den jämförbara punkten — båda våra ikoner är centrerade på sin
      // markpunkt (legpin via `iconAnchor`, chipet via translate(-50%,-50%)).
      if (lager._icon && typeof lager.getLatLng === "function") {
        const r = lager._icon.getBoundingClientRect();
        if (r.width || r.height) {
          dom = Math.max(dom, avstand({ x: r.left + r.width / 2, y: r.top + r.height / 2 },
                                      projicerat(map, lager.getLatLng())));
          nDom++;
        }
      }
    });
    return { geometri: geo, etiketter: dom, antal: { geometri: nGeo, etiketter: nDom } };
  }

  /* Ett SVEP: panorering, zoom och rotation, ett prov per steg. Kartan
     återställs alltid till utgångsläget — även om något kastar, för en
     mätning som lämnar vyn förskjuten är värre än ingen mätning.

     `panBy`/`setZoom`/`setBearing` körs med `animate: false`. Det är inte att
     mäta det lätta fallet: animationen är en CSS-transform PÅ PANEN, och
     under den följer overlays med per definition (det är hela §2.3-poängen).
     Det som kan gå fel är sluttillståndet efter varje steg — det är där en
     JS-omplacering på `move` skulle synas, och det är därför just det mäts. */
  function svep(map, opt) {
    const o = opt || {};
    const steg = o.steg || 6;
    const start = { center: map.getCenter(), zoom: map.getZoom(),
                    bearing: typeof map.getBearing === "function" ? map.getBearing() : null };
    const varsta = { geometri: 0, etiketter: 0, prov: 0, antal: null };
    const notera = () => {
      const p = prov(map);
      varsta.geometri = Math.max(varsta.geometri, p.geometri);
      varsta.etiketter = Math.max(varsta.etiketter, p.etiketter);
      varsta.antal = p.antal;
      varsta.prov++;
    };
    try {
      notera();
      for (let i = 0; i < steg; i++) { map.panBy([37, 23], { animate: false }); notera(); }
      map.panBy([-37 * steg, -23 * steg], { animate: false });
      for (let i = 0; i < 3; i++) { map.setZoom(map.getZoom() + 1, { animate: false }); notera(); }
      for (let i = 0; i < 3; i++) { map.setZoom(map.getZoom() - 1, { animate: false }); notera(); }
      if (start.bearing !== null) {
        for (let i = 0; i < 4; i++) { map.setBearing(map.getBearing() + 37); notera(); }
      }
    } finally {
      map.setView(start.center, start.zoom, { animate: false });
      if (start.bearing !== null) map.setBearing(start.bearing);
    }
    return varsta;
  }

  /* Godkänt enligt §2.4. Gränserna står HÄR och inte hos anroparen, så två
     sidor inte kan råka mäta mot olika krav.

     MÄTGOLVET är inte en uppmjukning av kravet. §2.4 säger 0 px för
     scengeometri, och det är rätt krav — men `getScreenCTM` och
     `getBoundingClientRect` svarar med flyttal, så en overlay som ligger
     exakt rätt mäts upp till några tiotusendels pixel bredvid sig själv.
     Uppmätt: 9,7·10⁻⁵ px över ett helt svep. Att kräva bokstavlig nolla vore
     att kräva att flyttalsaritmetik inte finns, och testet hade då varit rött
     för alltid — vilket i praktiken är samma sak som inget test.
     Golvet ligger fyra tiopotenser under en pixel: allt som är ETT verkligt
     glapp, även ett på en hundradels pixel, faller fortfarande. */
  const MATGOLV_PX = 1e-3;
  const KRAV = { geometri: 0, etiketter: 1, matgolv: MATGOLV_PX };
  const godkant = r => r.geometri <= KRAV.geometri + MATGOLV_PX
                    && r.etiketter <= KRAV.etiketter;

  return { prov, svep, godkant, KRAV, _skarmlage: skarmlage, _projicerat: projicerat };
})();

if (typeof window !== "undefined") window.Laggmat = Laggmat;
else if (typeof globalThis !== "undefined") globalThis.Laggmat = Laggmat;
if (typeof module !== "undefined" && module.exports) module.exports = Laggmat;
