"use strict";
/* KOMPASSEN — norr och vinden, uppe till höger (UPPGRADERING_3D §5 U22).
 *
 * Två saker som ofta blandas ihop och därför ser olika ut här:
 *   NORR  är en egenskap hos världen. Ringens N.
 *   VINDEN är en mätning som kan saknas. Nålen.
 * En vindpil utan norr går inte att kontrollera mot verkligheten — man ser att
 * den pekar någonstans, men inte om den pekar rätt. Och utan nät finns ingen
 * vind (§1 princip 3, undantaget): då visar kompassen norr och SÄGER att vinden
 * saknas, i stället för att låta en gammal nål se färsk ut.
 *
 * Vinklarna är den enda svåra biten, och de är rena funktioner här så att
 * `node tests/js/test_kompass.mjs` kan kontrollera dem utan DOM:
 *
 *   vyBaring   Leaflets `bearing` är hur KARTAN är vriden; det som pekar UPPÅT
 *              på skärmen är motsatsen. Samma tecken som `Vybro`.
 *   norr       ligger på −vyBäring: tittar man rakt österut (90°) hamnar N till
 *              vänster, alltså på −90°.
 *   vind       kommer FRÅN `dir` och blåser alltså mot `dir + 180`. Nålen ritar
 *              den riktning bollen trycks åt, för det är den spelaren ska
 *              agera på.
 *
 * Alla vinklar ut är grader medsols från skärmens upp-riktning — precis vad en
 * CSS/SVG-rotation vill ha.
 */
const Kompass = (() => {

  const norm = g => ((g % 360) + 360) % 360;

  /** Leaflet-bearing (kartans vridning) → den bäring som pekar uppåt i bild. */
  function vyBaringAvLeaflet(bearing) { return norm(-(bearing || 0)); }

  /** Kamerans heading (radianer, via Vybro) → samma sak i grader. */
  function vyBaringAvHeading(heading, gridNorr, vybro) {
    return vyBaringAvLeaflet(vybro.bearingFromHeading(heading, gridNorr));
  }

  /* Ringens och nålens rotation för en given vy och vind.
     `vindDir` = grader vinden kommer FRÅN, eller null när den saknas. */
  function vinklar(vyBaring, vindDir) {
    const b = norm(vyBaring);
    return {
      norr: norm(-b),
      vind: vindDir == null ? null : norm(vindDir + 180 - b),
      // Vindens riktning relativt vyn, i ord: används av etiketten och är det
      // enda kompassen PÅSTÅR om spelet. "medvind" när den blåser bort från
      // betraktaren, alltså uppåt i bild.
      langs: vindDir == null ? null : Math.cos((norm(vindDir + 180 - b)) * Math.PI / 180),
    };
  }

  const NAMN = ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSV','SV','VSV','V','VNV','NV','NNV'];
  /** Vindriktning i ord — samma 16-strecks-tabell som vindpanelen använder. */
  const streck = d => (d == null ? '' : NAMN[Math.round(norm(d) / 22.5) % 16]);

  return { vinklar, vyBaringAvLeaflet, vyBaringAvHeading, streck, norm, NAMN };
})();

if (typeof window !== "undefined") window.Kompass = Kompass;
else if (typeof globalThis !== "undefined") globalThis.Kompass = Kompass;
if (typeof module !== "undefined" && module.exports) module.exports = Kompass;
