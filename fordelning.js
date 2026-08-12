"use strict";
/* FÖRDELNING — U26: konturerna ritas där fördelningen ligger, inte som en
 * ellips (UPPGRADERING_3D.md §5 U26).
 *
 * TVÅ FEL I DEN GAMLA BILDEN, BÅDA TYSTA: en 1σ-ellips rymmer bara 39 % av
 * nedslagen utan att säga det, och sedan M0c har fördelningen en tät kärna och
 * en tjock svans — en ellips ritad ovanpå ljuger om just den formen. Den här
 * modulen ersätter ellipsen med två HDR-konturer (Highest Density Region),
 * 50 % och 90 %: områden med högst täthet som tillsammans rymmer exakt den
 * andelen av massan, räknat ur SAMMA punktmoln som redan prissätter slaget i
 * `strategi.js` — inte en ny samplare.
 *
 * VARFÖR HDR OCH INTE RADIELLA KVANTILER: ett område byggt av kvantiler per
 * vinkelsektor ser rimligt ut men innehåller inte q av massan, och då hade
 * procenttalet i panelen varit en gissning i procentform. HDR är den enda
 * konstruktionen där "innanför konturen" och "andelen i panelen" är samma
 * påstående.
 *
 * REN modul, som strategi.js/planslag.js/slagjust.js: ingen DOM, inget fetch,
 * ingen Store. In: `{alongMean, acrossMean, alongSd, acrossSd, miss, n}` i
 * slagets lokala meter (along = längs slaget, across = tvärs). Ut:
 * `{konturer: [{q, segment: [[x0,y0,x1,y1], …]}]}` i SAMMA lokala meter —
 * ritkoden roterar in dem i scenen precis som `ritaEllips` gjorde.
 *
 * ALGORITMEN (specad i UPPGRADERING_3D §5 U26, steg för steg):
 *   1. Dra molnet med Strategi.punktmoln(n, miss), n = 2048.
 *   2. Lägg punkterna i ett viktat 64×64-histogram över ±(3,5 · bredaste
 *      spridning + |alongMean|), så svansen ryms i rutnätet.
 *   3. Jämna med ett 3×3-pass (annars blir konturen taggig av histogrambrus).
 *   4. Sortera cellerna efter täthet, ackumulera vikt tills q är passerad →
 *      det är nivån.
 *   5. Marching squares på nivån → linjesegment. Segmenten sys INTE ihop till
 *      en ring (se hal3d.js — de ritas som THREE.LineSegments).
 *
 * FACIT (analytiskt, `tests/js/test_fordelning.mjs`): med `miss.p = 0` och
 * `alongSd = acrossSd = σ` är HDR-regionen för en isotrop normalfördelning en
 * cirkel med radie σ·√(−2 ln(1−q)) — 1,177σ vid q = 0,5, 2,146σ vid q = 0,9.
 * Det följer direkt av dess täthet f(x,y) = 1/(2πσ²)·exp(−(x²+y²)/2σ²): en
 * HDR-region för en unimodal, radiellt avtagande täthet är alltid en
 * nivåmängd av tätheten, vilket här är en skiva, och P(R < r) = 1 −
 * exp(−r²/2σ²) ger radien rakt av.
 */
const Fordelning = (() => {
  const N = 64;                 // rutnätets sida (steg 2)
  const HALVBREDD_SIGMA = 3.5;   // hur många "bredaste sigma" nätet sträcker sig

  /* ---- 1+2. Molnet i ett viktat NxN-histogram --------------------------- */

  /* Halva rutnätets utsträckning, i meter, kring origo (INTE kring
     alongMean/acrossMean — alongMean kan ligga långt från 0 när profilen bär
     en bias, och nätet måste nå dit ändå, se §5 U26). */
  function halvbredd(alongMean, alongSd, acrossSd, miss) {
    const alongMult = (miss && miss.along_mult) || 1;
    const acrossMult = (miss && miss.across_mult) || 1;
    return HALVBREDD_SIGMA * Math.max(alongSd * alongMult, acrossSd * acrossMult)
           + Math.abs(alongMean || 0);
  }

  /* Punktmolnet (Strategi.punktmoln, standardiserat z1/z2) till FAKTISKA
     along/across-koordinater — samma uttryck som `utvarderaKandidat` i
     strategi.js använder för missträffskomponenten. `nominal` (klubbans
     obestörda räckvidd i strategi.js) finns inte i det här gränssnittet, så
     |alongMean| används som bästa tillgängliga proxy — se UPPGRADERING_3D
     §5 U26, avsnittet "beslut etapptexten inte täckte".

     VARJE PUNKT SPRIDS BILINJÄRT ÖVER DE FYRA NÄRMASTE CELLERNA (cloud-in-cell)
     i stället för att räknas in i en enda. Med n = 2048 mot 64×64 celler faller
     långt under en punkt per cell i svansen (~0,4 vid q = 0,9-nivån), och en
     hård "närmaste cell"-tilldelning gjorde konturen där kantig och radien upp
     till 4,5 % fel — utanför §5 U26:s facit-tolerans (3 %). Bilinjär spridning
     är samma histogram, bara utan den extra kvantiseringsbruset; uppmätt gav
     den 0,2–0,3 % fel vid samma n. */
  function histogram(moln, alongMean, acrossMean, alongSd, acrossSd, miss, half) {
    const grid = new Float64Array(N * N);
    const steg = (2 * half) / N;
    const m = miss || {};
    const alongFrac = m.along_frac || 0, alongMult = m.along_mult || 1,
          acrossMult = m.across_mult || 1;
    const nominal = Math.abs(alongMean || 0);
    const lagg = (ix, iy, vikt) => {
      if (ix >= 0 && ix < N && iy >= 0 && iy < N) grid[iy * N + ix] += vikt;
    };
    for (let i = 0; i < moln.n; i++) {
      const missad = moln.arMiss[i];
      const along = missad
        ? alongMean - alongFrac * nominal + moln.z1[i] * alongSd * alongMult
        : alongMean + moln.z1[i] * alongSd;
      const across = missad
        ? acrossMean + moln.z2[i] * acrossSd * acrossMult
        : acrossMean + moln.z2[i] * acrossSd;
      // Kontinuerlig cellkoordinat (0,5 = cellens mitt) och de fyra hörnens vikt.
      const fx = (along + half) / steg - 0.5, fy = (across + half) / steg - 0.5;
      const ix0 = Math.floor(fx), iy0 = Math.floor(fy);
      const tx = fx - ix0, ty = fy - iy0;
      const w = moln.vikt[i];
      lagg(ix0, iy0, w * (1 - tx) * (1 - ty));
      lagg(ix0 + 1, iy0, w * tx * (1 - ty));
      lagg(ix0, iy0 + 1, w * (1 - tx) * ty);
      lagg(ix0 + 1, iy0 + 1, w * tx * ty);
    }
    return { grid, steg };
  }

  /* ---- 3. Utjämning ------------------------------------------------------ */

  function jamna3x3(grid) {
    const ut = new Float64Array(N * N);
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        let sum = 0, ant = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const jy = iy + dy;
          if (jy < 0 || jy >= N) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            if (jx < 0 || jx >= N) continue;
            sum += grid[jy * N + jx]; ant++;
          }
        }
        ut[iy * N + ix] = ant ? sum / ant : 0;
      }
    }
    return ut;
  }

  /* ---- 4. Nivån för given q ----------------------------------------------
     Sorterar cellerna efter täthet (störst först) och ackumulerar vikt tills
     q är passerad — cellens eget värde där är nivån. Att sortera det UTJÄMNADE
     rutnätet (inte råhistogrammet) är avsiktligt: det är samma fält som
     marching squares sedan konturerar, så "nivån" och "vad som ritas vid den
     nivån" är alltid samma tal. */
  function nivaForQ(gladd, q) {
    const varden = Array.from(gladd).sort((a, b) => b - a);
    let total = 0;
    for (const v of varden) total += v;
    const mal = q * total;
    let acc = 0;
    for (const v of varden) {
      acc += v;
      if (acc >= mal) return v;
    }
    return varden.length ? varden[varden.length - 1] : 0;
  }

  /* ---- 5. Marching squares ------------------------------------------------
     Standardfallen (Wikipedias 16-fallstabell), bitordning NW=8 NE=4 SE=2 SW=1.
     Sadelfallen (5 och 10) löses med EN fast diagonal — konturen är en
     visualisering, inte en topologisk garanti, och U26 kräver uttryckligen
     INTE att segmenten syr ihop till en ring. */
  function punkt(ix, iy, half, steg) {
    return [-half + (ix + 0.5) * steg, -half + (iy + 0.5) * steg];
  }

  function kantpunkt(pa, pb, va, vb, niva) {
    const t = vb === va ? 0.5 : Math.max(0, Math.min(1, (niva - va) / (vb - va)));
    return [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
  }

  function marchingSquares(gladd, half, steg, niva) {
    const v = (ix, iy) => gladd[iy * N + ix];
    const segment = [];
    for (let iy = 0; iy < N - 1; iy++) {
      for (let ix = 0; ix < N - 1; ix++) {
        const vNW = v(ix, iy), vNE = v(ix + 1, iy),
              vSE = v(ix + 1, iy + 1), vSW = v(ix, iy + 1);
        let c = 0;
        if (vNW > niva) c |= 8;
        if (vNE > niva) c |= 4;
        if (vSE > niva) c |= 2;
        if (vSW > niva) c |= 1;
        if (c === 0 || c === 15) continue;

        const pNW = punkt(ix, iy, half, steg), pNE = punkt(ix + 1, iy, half, steg),
              pSE = punkt(ix + 1, iy + 1, half, steg), pSW = punkt(ix, iy + 1, half, steg);
        const eN = () => kantpunkt(pNW, pNE, vNW, vNE, niva);
        const eE = () => kantpunkt(pNE, pSE, vNE, vSE, niva);
        const eS = () => kantpunkt(pSW, pSE, vSW, vSE, niva);
        const eW = () => kantpunkt(pNW, pSW, vNW, vSW, niva);
        const lagg = (a, b) => segment.push([a[0], a[1], b[0], b[1]]);

        switch (c) {
          case 1: case 14: lagg(eW(), eS()); break;
          case 2: case 13: lagg(eS(), eE()); break;
          case 3: case 12: lagg(eW(), eE()); break;
          case 4: case 11: lagg(eN(), eE()); break;
          case 6: case 9: lagg(eN(), eS()); break;
          case 7: case 8: lagg(eN(), eW()); break;
          case 5: lagg(eN(), eE()); lagg(eS(), eW()); break;
          case 10: lagg(eN(), eW()); lagg(eS(), eE()); break;
        }
      }
    }
    return segment;
  }

  /* ---- Hela vägen: moln -> histogram -> nivåer -> konturer --------------- */

  /* `qs` går att styra för test/diagnos; appen använder alltid standardparet
     (50 % och 90 %, §5 U26). */
  function hdr(indata) {
    const o = indata || {};
    const alongMean = o.alongMean || 0, acrossMean = o.acrossMean || 0;
    const alongSd = Math.max(o.alongSd || 0, 1e-6), acrossSd = Math.max(o.acrossSd || 0, 1e-6);
    const miss = o.miss || null;
    const n = o.n || 2048;
    const qs = o.qs || [0.5, 0.9];

    const moln = Strategi.punktmoln(n, miss);
    const half = halvbredd(alongMean, alongSd, acrossSd, miss);
    const { grid, steg } = histogram(moln, alongMean, acrossMean, alongSd, acrossSd, miss, half);
    const gladd = jamna3x3(grid);

    const konturer = qs.map(q => ({
      q, segment: marchingSquares(gladd, half, steg, nivaForQ(gladd, q)),
    }));
    return { konturer, half, steg };
  }

  return { hdr, halvbredd, histogram, jamna3x3, nivaForQ, marchingSquares, N };
})();

if (typeof window !== "undefined") window.Fordelning = Fordelning;
else if (typeof globalThis !== "undefined") globalThis.Fordelning = Fordelning;
if (typeof module !== "undefined" && module.exports) module.exports = Fordelning;
