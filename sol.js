"use strict";
/* Sol — solens position för en tid och en plats (U7 punkt 7, UPPGRADERING_3D §5).
 *
 * VARFÖR den finns: 3D-scenens ljus var fast från nordväst, valt för att matcha
 * hillshaden. Det ser bra ut men ljuger — skuggorna pekar åt fel håll, och du
 * kan inte se om ett hål ligger i motljus vid din starttid. Det är
 * spelinformation, inte dekor: motljus på ett inspel över vatten är en riktig
 * svårighet.
 *
 * Algoritmen är NOAA:s lågprecisionsformel. Felet är under 0,1° för vår
 * latitud och vårt tidsspann, vilket är långt under vad en skuggriktning i en
 * 3D-vy behöver — och den är liten nog att inte dra in ett bibliotek.
 *
 * Konventioner (viktiga, de har olika definitioner i olika källor):
 *   alt  radianer över horisonten; negativ = under (natt)
 *   az   radianer från NORR, medurs (öst = π/2). Samma som en kompassbäring.
 *
 * Global: window.Sol (vanligt script, som mapcore.js) + ESM-export för test.
 */
(function (root) {
  const RAD = Math.PI / 180;

  function solriktning(datum, lat, lon) {
    const t = datum instanceof Date ? datum.getTime() : datum;
    const d = (t - Date.UTC(2000, 0, 1, 12)) / 86400000;      // dagar sedan J2000
    const M = (357.5291 + 0.98560028 * d) * RAD;              // medelanomali
    const L = (280.459 + 0.98564736 * d) * RAD;               // medellängd
    // Mittpunktsekvationen: jordbanan är en ellips, så sann längd släpar/leder
    // medellängden med upp till ~2°.
    const lam = L + (1.915 * Math.sin(M) + 0.020 * Math.sin(2 * M)) * RAD;
    const eps = (23.439 - 0.00000036 * d) * RAD;              // ekliptikans lutning
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));     // deklination
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24; // Greenwich-stjärntid, h
    const h = gmst * 15 * RAD + lon * RAD - ra;               // lokal timvinkel
    const la = lat * RAD;
    const alt = Math.asin(Math.sin(la) * Math.sin(dec)
                          + Math.cos(la) * Math.cos(dec) * Math.cos(h));
    // atan2-grenen ger azimut mätt från SÖDER; +π flyttar den till norr.
    const az = Math.atan2(Math.sin(h),
                          Math.cos(h) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) + Math.PI;
    return { alt, az: ((az % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) };
  }

  /* Riktningen som en enhetsvektor i scenens ram: +x = öst, -z = norr (samma
   * ram som `ll2xz` bygger, se hole_gltf.py). Den som placerar ljuset ska inte
   * behöva göra om den här översättningen — gör man den på två ställen blir den
   * fel på ett av dem. */
  function solvektor(datum, lat, lon) {
    const { alt, az } = solriktning(datum, lat, lon);
    const r = Math.cos(alt);
    return { x: Math.sin(az) * r, y: Math.sin(alt), z: -Math.cos(az) * r, alt, az };
  }

  const api = { solriktning, solvektor, RAD };
  if (root) root.Sol = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})(typeof window !== "undefined" ? window : null);
