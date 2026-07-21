"use strict";
/* Analys-motor för "efter rundan"-fliken (analys.html). RENA funktioner, ingen
 * DOM — så node-testerna (tests/js/test_analys.mjs) kan köra exakt denna kod via
 * node:vm mot riktig burlov.json (inga kopior). Se ANALYS_MOBIL_V1_BRIEF.md §4.
 *
 * All geometri i lokal ENU-projektion (meter) runt ett hål-nära centrum — undviker
 * lat/lon-vinkelfel. Tecken-konvention för missar (sett längs siktlinjen mot pin):
 *   along > 0 = LÅNG (bortom pin), along < 0 = KORT
 *   cross > 0 = HÖGER,             cross < 0 = VÄNSTER
 * Fairway-sidled: lateral > 0 = HÖGER om hålets mittlinje (tee→green).
 */
globalThis.AnalysCore = (() => {
  const R_M = 111320;                 // meter per grad (lat); lon skalas med cos(lat)
  const D2R = Math.PI / 180;

  // Normalisera en punkt: burlov lagrar [lat,lon], rundloggen {lat,lon}.
  function LL(p) {
    if (!p) return null;
    if (Array.isArray(p)) return { lat: p[0], lon: p[1] };
    if (p.lat != null && p.lon != null) return { lat: p.lat, lon: p.lon };
    return null;
  }
  // ENU-meter (x=öst, y=nord) runt centrum c ({lat,lon}).
  function enu(p, c) {
    return { x: (p.lon - c.lon) * Math.cos(c.lat * D2R) * R_M,
             y: (p.lat - c.lat) * R_M };
  }
  function hav(a, b) {
    const A = LL(a), B = LL(b);
    if (!A || !B) return Infinity;
    const dLat = (B.lat - A.lat) * D2R, dLon = (B.lon - A.lon) * D2R;
    const la = A.lat * D2R, lb = B.lat * D2R;
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Punkt i polygon (ray-casting) i ENU runt centrum c. ring = [[lat,lon], …].
  function pointInPoly(pt, ring, c) {
    const P = LL(pt); if (!P || !ring || ring.length < 3) return false;
    const cc = LL(c) || P;
    const q = enu(P, cc);
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = enu(LL(ring[i]), cc), b = enu(LL(ring[j]), cc);
      const hit = (a.y > q.y) !== (b.y > q.y) &&
        q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x;
      if (hit) inside = !inside;
    }
    return inside;
  }

  // Missriktning: landning relativt pin, projicerad på siktlinjen start→pin.
  // Returnerar {along, cross, dist} i meter, eller null om indata saknas.
  function classifyMiss(landing, pin, start) {
    const La = LL(landing), Pi = LL(pin), St = LL(start);
    if (!La || !Pi || !St) return null;
    const L = enu(La, Pi), S = enu(St, Pi);          // pin i origo
    let ux = -S.x, uy = -S.y;                          // riktning start→pin
    const n = Math.hypot(ux, uy);
    if (n < 1e-6) return null;
    ux /= n; uy /= n;
    return {
      along: L.x * ux + L.y * uy,                      // + lång, − kort
      cross: L.x * uy - L.y * ux,                      // + höger, − vänster
      dist: Math.hypot(L.x, L.y),
    };
  }

  // Signerad sidled mot en polyline (tee→green). + = höger om linjen. Meter.
  function lateralToLine(pt, line) {
    const P = LL(pt); if (!P || !line || line.length < 2) return null;
    const c = LL(line[0]);
    const q = enu(P, c);
    let best = null;
    for (let i = 0; i < line.length - 1; i++) {
      const a = enu(LL(line[i]), c), b = enu(LL(line[i + 1]), c);
      const dx = b.x - a.x, dy = b.y - a.y;
      const seg2 = dx * dx + dy * dy; if (seg2 < 1e-9) continue;
      let t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / seg2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      const dist = Math.hypot(q.x - px, q.y - py);
      if (!best || dist < best.dist) {
        // korsprodukt segment × (q−a): >0 vänster, <0 höger → höger positiv
        const crossz = dx * (q.y - a.y) - dy * (q.x - a.x);
        best = { dist, right: crossz < 0 ? dist : -dist };
      }
    }
    return best ? best.right : null;
  }

  // Vilket slag (1-baserat) nådde green först? null om aldrig registrerat på green.
  function strokeOnGreen(shots, greenMark, greenRing, greenCenter) {
    if (greenRing && greenRing.length >= 3) {
      for (let i = 0; i < shots.length; i++)
        if (pointInPoly(shots[i], greenRing, greenCenter)) return i + 1;
    }
    if (greenMark) {                                   // fallback: närmast green-markören
      let best = -1, bd = Infinity;
      for (let i = 0; i < shots.length; i++) {
        const d = hav(shots[i], greenMark);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) return best + 1;
    }
    return null;
  }

  /* Per-hål-analys. hole = rundloggens hål {shots, green, pin, putts, pen, adj};
   * band = burlov-hålet {par, pin, line, green (polygon), green_center, tees}.
   * Alla härledda mått med ärlighetsflaggor (se brief §4). */
  function holeAnalysis(hole, band) {
    const shots = (hole && hole.shots) || [];
    const putts = (hole && hole.putts) || 0;
    const pen = (hole && hole.pen) || 0;
    const adj = (hole && hole.adj) || 0;
    const par = band && band.par != null ? band.par : null;
    const nShots = shots.length + adj;
    const score = nShots + putts + pen;
    const played = score > 0;

    const out = { par, played, score, shots: nShots, putts, pen, adj,
      girKnown: false, gir: false, scrambleElig: false, scramble: false,
      precClean: pen === 0 && adj === 0,
      approach: null, teeLateral: null };
    if (!played || par == null) return out;

    const pin = LL(hole && hole.pin) || LL(band && band.pin);
    const greenRing = band && band.green;
    const greenCenter = LL(band && band.green_center) || pin;
    const reg = par - 2;                               // regulationsslag till green

    // ---- GIR (strikt par−2) ----
    if (greenRing && greenRing.length >= 3 && reg >= 1) {
      const sOG = strokeOnGreen(shots, hole && hole.green, greenRing, greenCenter);
      if (sOG != null) { out.girKnown = true; out.gir = sOG <= reg; }
      else if (shots.length >= reg) { out.girKnown = true; out.gir = false; }
      // annars: för få loggade slag + aldrig på green → okänt (datagap), lämna false/known=false
    }
    // ---- Scrambling: bara när GIR missades ----
    if (out.girKnown && !out.gir) {
      out.scrambleElig = true;
      out.scramble = score <= par;
    }

    // ---- Inspelets missriktning (slag nr par−2) ----
    if (reg >= 1 && pin && out.precClean) {
      const landing = shots[reg - 1];                  // inspelets landning
      let start = null;
      if (reg >= 2) start = shots[reg - 2];            // slaget före inspelet
      else if (band && band.line && band.line.length)  // par 3: siktlinje från tee
        start = band.line[0];
      if (landing && start) {
        const cls = classifyMiss(landing, pin, start);
        if (cls) {
          const onGreen = greenRing ? pointInPoly(landing, greenRing, greenCenter) : false;
          out.approach = { along: cls.along, cross: cls.cross, dist: cls.dist, onGreen };
        }
      }
    }

    // ---- Utslagets sidled (par 4/5, mot mittlinjen) ----
    if (par >= 4 && out.precClean && band && band.line && shots.length) {
      const lat = lateralToLine(shots[0], band.line);
      if (lat != null) out.teeLateral = lat;
    }
    return out;
  }

  const med = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /* Aggregat över en rundas per-hål-resultat (från holeAnalysis). */
  function aggregate(holes) {
    const played = holes.filter(h => h.played);
    const A = {
      nPlayed: played.length,
      totScore: 0, totPutts: 0, totPar: 0, totPen: 0,
      gir: { hit: 0, known: 0, pct: null },
      scramble: { ok: 0, elig: 0, pct: null },
      putts: { total: 0, three: 0, one: 0, girPutts: [], perGir: null },
      approach: { short: 0, long: 0, left: 0, right: 0, onGreen: 0, n: 0,
                  medAlong: null, medCross: null, pts: [] },
      tee: { left: 0, right: 0, n: 0, pts: [] },
      dist: { birdie: 0, par: 0, bogey: 0, dbl: 0 },
      byPar: {}, worstHole: null,
      precExcluded: 0,
    };
    const alongs = [], crosses = [];
    played.forEach((h, idx) => {
      A.totScore += h.score; A.totPutts += h.putts; A.totPen += h.pen;
      if (h.par != null) A.totPar += h.par;
      A.putts.total += h.putts;
      if (h.putts >= 3) A.putts.three++;
      if (h.putts === 1) A.putts.one++;
      if (h.girKnown) { A.gir.known++; if (h.gir) { A.gir.hit++; A.putts.girPutts.push(h.putts); } }
      if (h.scrambleElig) { A.scramble.elig++; if (h.scramble) A.scramble.ok++; }
      if (!h.precClean) A.precExcluded++;
      if (h.approach) {
        const a = h.approach; A.approach.n++;
        A.approach.pts.push({ along: a.along, cross: a.cross, onGreen: a.onGreen });
        if (a.onGreen) A.approach.onGreen++;
        else {
          if (a.along < -2) A.approach.short++; else if (a.along > 2) A.approach.long++;
          if (a.cross < -2) A.approach.left++; else if (a.cross > 2) A.approach.right++;
        }
        alongs.push(a.along); crosses.push(a.cross);
      }
      if (h.teeLateral != null) {
        A.tee.n++; A.tee.pts.push(h.teeLateral);
        if (h.teeLateral < -3) A.tee.left++; else if (h.teeLateral > 3) A.tee.right++;
      }
      if (h.par != null) {
        const d = h.score - h.par;
        if (d <= -1) A.dist.birdie++; else if (d === 0) A.dist.par++;
        else if (d === 1) A.dist.bogey++; else A.dist.dbl++;
        const bp = A.byPar[h.par] || (A.byPar[h.par] = { sum: 0, n: 0 });
        bp.sum += h.score; bp.n++;
        if (!A.worstHole || d > A.worstHole.d) A.worstHole = { i: idx + 1, d };
      }
    });
    if (A.gir.known) A.gir.pct = A.gir.hit / A.gir.known * 100;
    if (A.scramble.elig) A.scramble.pct = A.scramble.ok / A.scramble.elig * 100;
    if (A.putts.girPutts.length)
      A.putts.perGir = A.putts.girPutts.reduce((s, v) => s + v, 0) / A.putts.girPutts.length;
    A.approach.medAlong = med(alongs);
    A.approach.medCross = med(crosses);
    return A;
  }

  return { LL, enu, hav, pointInPoly, classifyMiss, lateralToLine,
           strokeOnGreen, holeAnalysis, aggregate };
})();

/* node-testbarhet: exportera även som CommonJS när modulen läses i node. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.AnalysCore;
