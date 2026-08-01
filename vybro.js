"use strict";
/* BRON mellan Leaflets vy och kamerans fyra tal (UPPGRADERING_3D §5 U12).
 *
 * "2D" och "3D" är inte två vyer utan två poser av samma kamera: 2D är
 * `tilt = 0` och överdrift 1. För att bytet ska kunna kännas som EN vy måste de
 * två beskrivningarna av samma bild gå att räkna om till varandra exakt —
 * annars hoppar bilden i sömmen, och det syns.
 *
 * Fyra tal, fyra formler:
 *   center  ↔ target   hålets ll2xz-affin (injicerad, se nedan)
 *   zoom    ↔ range    mpp = 40075016.686·cos(lat)/2^(zoom+8), range = mpp·H/(2·tan(fov/2))
 *   bearing ↔ heading  heading = −bearing i radianer
 *   —         tilt     0 i 2D
 *
 * AFFINEN ÄGS INTE HÄR. `hojdprofil.js` bär `latLonToXz`/`xzToLatLon` med en
 * uttalad regel: affinen ska bo på ETT ställe, bredvid sin invers. Den här
 * modulen tar dem därför som argument (`konv`) i stället för att ha en egen
 * kopia — en andra kopia hade kunnat glida isär, och då ligger 3D-scenens punkt
 * och kartans punkt på olika gräs utan att något test märker det.
 *
 * Importfri (som camctl.js) så `node tests/js/test_vybro.mjs` kan köra den utan
 * DOM och utan three.js.
 */
const Vybro = (() => {
  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  // Jordens omkrets vid ekvatorn i web-mercator. SAMMA konstant som
  // SlopeOverlay.metersPerPixel — byts den ena måste den andra byta.
  const EQ_M = 40075016.686;
  const FOV_DEG = 55;          // samma som PerspectiveCamera i hal3d.js

  const rad = d => d * DEG;
  const deg = r => r / DEG;

  /** Meter per skärmpixel vid latitud och zoom (web-mercator). */
  function metersPerPixel(lat, zoom) {
    return EQ_M * Math.cos(rad(lat)) / Math.pow(2, zoom + 8);
  }

  /* Kameraavstånd som visar samma markbredd som Leaflets zoom.
   *
   * En perspektivkamera rakt ovanifrån ser `2·range·tan(fov/2)` meter över
   * bildens HÖJD. Leaflet visar `mpp · höjd_px`. Sätt dem lika och lös ut range.
   * Höjden (inte bredden) är rätt axel eftersom three.js:s `fov` är vertikal. */
  function rangeFromZoom(lat, zoom, heightPx, fovDeg) {
    const mpp = metersPerPixel(lat, zoom);
    return mpp * heightPx / (2 * Math.tan(rad(fovDeg == null ? FOV_DEG : fovDeg) / 2));
  }

  /** Inversen. Ingen klampning till heltalszoom — Leaflet tillåter bråkzoom. */
  function zoomFromRange(lat, range, heightPx, fovDeg) {
    const mpp = 2 * range * Math.tan(rad(fovDeg == null ? FOV_DEG : fovDeg) / 2) / heightPx;
    return Math.log2(EQ_M * Math.cos(rad(lat)) / mpp) - 8;
  }

  /* Leaflets bearing är grader medsols för hur kartan är VRIDEN; kamerans
     heading är radianer för vart blicken PEKAR. Tecknet är detsamma som
     `MapCore.orientToHole` använder (`setBearing(-hd)`) — därav minuset.

     GRIDNORR är den andra halvan, och den var inte gratis: Leaflets bearing
     räknas mot SANT norr, medan scenens ram kommer ur SWEREF och pekar mot
     GRIDNORR. Utan termen är sömmen mellan vinklarna en vridning på precis
     meridiankonvergensen (uppmätt 1,63–1,68° på Burlöv innan den lades till).
     Talet kommer ur hålets egen affin — `hojdprofil.gridNorthOffset` — och är
     alltså inte ett gradtal någon skrivit in. */
  function headingFromBearing(bearing, gridNorr) {
    return wrap(-rad(bearing) + (gridNorr || 0));
  }
  /** Tillbaka till Leaflet: grader i (−180, 180], som `setBearing` vill ha. */
  function bearingFromHeading(heading, gridNorr) {
    let b = -deg(wrap(heading - (gridNorr || 0)));
    if (b <= -180) b += 360;
    if (b > 180) b -= 360;
    return b;
  }
  function wrap(h) {
    if (h >= 0 && h < TAU) return h;
    const w = ((h % TAU) + TAU) % TAU;
    return w === TAU ? 0 : w;
  }

  const TILT_2D = 0;
  const TILT_3D = 55 * DEG;    // sänkningens slutläge

  /* Leaflets vy → kamerans tillstånd.
   *
   *   konv.ll2xz(lat, lon) -> [x, z]   (hojdprofil.latLonToXz, bunden till hålet)
   *   yAt(x, z) -> y | null            markens höjd i scenen, redan överdrifts-
   *                                    skalad; null/NaN → 0 (platt är en ärligare
   *                                    gissning än en påhittad höjd)
   */
  function poseFor2d(vy) {
    const [x, z] = vy.konv.ll2xz(vy.center[0], vy.center[1]);
    const y0 = vy.yAt ? vy.yAt(x, z) : 0;
    const y = Number.isFinite(y0) ? y0 : 0;
    /* REFERENSPLANET, och varför range inte bara är rangeFromZoom.
     *
     * Leaflets mpp gäller ett PLAN. En perspektivkamera rakt ovanifrån ger
     * samma skala bara i det plan vars avstånd till ögat är `rangeFromZoom` —
     * terräng ovanför planet blir större, under det mindre, med faktorn
     * ögonhöjd/(ögonhöjd − höjd).
     *
     * Ankrar man i MÅLPUNKTENS höjd blir skalan rätt precis där, alltså i
     * bildens mitt, där radien är noll och felet inte syns — och fel ute i
     * kanterna där det syns mest. Uppmätt på Burlöv blue 4: målpunkten låg
     * 2,28 m under hålets mark, och sömmen blev 3,9 px (+1,2 % skala) 290 px
     * ut, trots att hålets egen höjdvariation bara är 0,29 m.
     *
     * Därför ankras ögonhöjden i `yRef` — höjden där INNEHÅLLET ligger (hålets
     * mark) — och range räknas som avståndet därifrån ner till målpunkten. */
    const R0 = rangeFromZoom(vy.center[0], vy.zoom, vy.heightPx, vy.fovDeg);
    const yRef = Number.isFinite(vy.yRef) ? vy.yRef : 0;
    return {
      target: { x, y, z },
      range: R0 + yRef - y,
      heading: headingFromBearing(vy.bearing, vy.konv.gridNorr),
      tilt: TILT_2D,
    };
  }

  /* Kamerans tillstånd → Leaflets vy. Latituden zoomen ska räknas vid är
     MÅLPUNKTENS egen, inte hålets mitt: mpp beror på cos(lat), och tar man fel
     latitud blir zoomen fel i sista decimalen — vilket är precis den drift
     kravet på fem byten fram och tillbaka letar efter. */
  function view2dFor(vy) {
    const s = vy.state;
    const [lat, lon] = vy.konv.xz2ll(s.target.x, s.target.z);
    // Samma referensplan som poseFor2d ankrade i — annars är inte de två
    // funktionerna inverser, och fem byten fram och tillbaka driver i zoom.
    const yRef = Number.isFinite(vy.yRef) ? vy.yRef : 0;
    const R0 = s.range - yRef + s.target.y;
    return {
      center: [lat, lon],
      zoom: zoomFromRange(lat, R0, vy.heightPx, vy.fovDeg),
      bearing: bearingFromHeading(s.heading, vy.konv.gridNorr),
    };
  }

  return { metersPerPixel, rangeFromZoom, zoomFromRange,
           headingFromBearing, bearingFromHeading,
           poseFor2d, view2dFor, wrap,
           EQ_M, FOV_DEG, TILT_2D, TILT_3D };
})();
if (typeof window !== "undefined") window.Vybro = Vybro;
else if (typeof globalThis !== "undefined") globalThis.Vybro = Vybro;
