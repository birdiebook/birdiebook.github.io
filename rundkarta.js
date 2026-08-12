"use strict";
/* Rundkartan — modellen bakom rundkarta.html (karta över en SPARAD rundas slag).
 *
 * RENA funktioner, ingen DOM och ingen fetch — så node-testerna
 * (tests/js/test_rundkarta.mjs) kan köra exakt denna kod. Sidan gör DOM:en och
 * ritar med MapCore (samma drawShots som live-kartan använder), så en slagpunkt
 * ser likadan ut i historiken som den gjorde när den loggades.
 *
 * Rundan läses med SIN EGEN banas tabeller (samma regel som analys.html §9.3):
 * hålen bär sitt frysta `global`, och bandatan slås upp per rundans courseSlug —
 * aldrig via "aktiv bana".
 */
globalThis.Rundkarta = (() => {
  const R_M = 6371000;
  const rad = d => d * Math.PI / 180;

  // Punktnormalisering: bandatan lagrar [lat,lon], rundloggen {lat,lon}.
  function LL(p) {
    if (!p) return null;
    if (Array.isArray(p)) return p.length >= 2 && p[0] != null && p[1] != null
      ? { lat: p[0], lon: p[1] } : null;
    if (p.lat != null && p.lon != null) return { lat: p.lat, lon: p.lon };
    return null;
  }
  function hav(a, b) {
    const A = LL(a), B = LL(b);
    if (!A || !B) return null;
    const dphi = rad(B.lat - A.lat), dl = rad(B.lon - A.lon);
    const s = Math.sin(dphi / 2) ** 2
      + Math.cos(rad(A.lat)) * Math.cos(rad(B.lat)) * Math.sin(dl / 2) ** 2;
    return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  const positioned = rec => ((rec && rec.shots) || []).filter(s => s && s.lat != null && s.lon != null);
  const hasPositions = rec => positioned(rec).length > 0;

  /* Hålscore, samma komponenter som SGScore.components: slag + justering +
     puttar + plikt. Räknas här (i stället för att importera score.js) så modulen
     är självbärande i node-testet; formeln är EN rad och speglas av testet. */
  function score(rec) {
    if (!rec) return 0;
    return ((rec.shots || []).length) + (rec.adj || 0) + (rec.putts || 0) + (rec.pen || 0);
  }
  const played = rec => score(rec) > 0;

  /* Hålväljarens modell: en post per SPELAT hål i rundan, i spelordning.
     `byGlobal` = rundans banas hål-tabell (globalt hålnummer → hål), `loopShort`
     = SGRound.tablesFor(meta).LOOP_SHORT. Båda får saknas (offline utan bandata)
     — då står bara spelarens hålnummer, aldrig ett gissat slingnamn.

     `harPositioner` är skillnaden mellan ett hål som går att RITA och ett som
     bara har en inknappad score (nivå 1–2, eller ett hål man glömde logga).
     Vyn måste kunna säga det rakt ut i stället för att visa en tom karta. */
  function holeOptions(S, byGlobal, loopShort) {
    const holes = ((S && S.holes) || []).slice().sort((a, b) => a.n - b.n);
    const out = [];
    for (const h of holes) {
      if (!played(h) && !hasPositions(h)) continue;   // tomt hål = inget att visa
      const band = (byGlobal && byGlobal[h.global]) || null;
      const kort = band && loopShort ? (loopShort[band.loop] || "") : "";
      out.push({
        n: h.n,
        global: h.global,
        label: "Hål " + h.n,
        bandLabel: band ? (kort ? kort + " " + band.hole : String(band.hole)) : "",
        par: band && band.par != null ? band.par : null,
        score: score(h),
        harPositioner: hasPositions(h),
        antalSlag: positioned(h).length,
      });
    }
    return out;
  }

  /* Nästa/föregående hål i listan (cirkulärt), utifrån ett hålnummer.
     Returnerar null om listan är tom. */
  function stega(opts, n, steg) {
    if (!opts || !opts.length) return null;
    let i = opts.findIndex(o => o.n === n);
    if (i < 0) i = 0;
    const j = (i + steg + opts.length) % opts.length;
    return opts[j].n;
  }

  /* Slagraderna under kartan: ett slag per loggad position, med avståndet till
     NÄSTA punkt — nästa slags läge, eller (för sista slaget) pin/green om hålet
     har en markering. Saknas nästa punkt är `dist` null, inte 0: att skriva
     "0 m" om ett okänt avstånd är samma sorts osanning som en gissad par-summa. */
  function shotRows(rec) {
    const shots = positioned(rec);
    const mal = LL(rec && rec.pin) || LL(rec && rec.green) || null;
    return shots.map((s, i) => {
      const nasta = i + 1 < shots.length ? LL(shots[i + 1]) : mal;
      return {
        nr: i + 1,
        lat: s.lat, lon: s.lon,
        acc: s.acc == null ? null : s.acc,
        dist: nasta ? hav(s, nasta) : null,
        sist: i === shots.length - 1,
      };
    });
  }

  /* Punkterna kartan ska rama in för ett hål: slagen + ev. green/pin, och
     hålets tee/linje när bandatan finns (så första utslaget inte hamnar i
     kanten). [] om ingenting finns att visa. */
  function framePoints(rec, band) {
    const pts = positioned(rec).map(s => [s.lat, s.lon]);
    const g = LL(rec && rec.green), p = LL(rec && rec.pin);
    if (g) pts.push([g.lat, g.lon]);
    if (p) pts.push([p.lat, p.lon]);
    if (band) {
      if (band.pin) { const b = LL(band.pin); if (b) pts.push([b.lat, b.lon]); }
      if (band.line && band.line.length) {
        const t = LL(band.line[0]); if (t) pts.push([t.lat, t.lon]);
      }
    }
    return pts;
  }

  // "132 m" / "8,4 m" / "–"
  function fmtM(v) {
    if (v == null) return "–";
    return (v < 10 ? v.toFixed(1).replace(".", ",") : String(Math.round(v))) + " m";
  }

  return { hav, positioned, hasPositions, score, holeOptions, stega,
           shotRows, framePoints, fmtM };
})();

/* node-testbarhet: exportera även som CommonJS när modulen läses i node. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Rundkarta;
