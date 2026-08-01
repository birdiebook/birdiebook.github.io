/* markhojd.js — markens höjd i en punkt, utan raycast (UPPGRADERING_3D §U18).
 *
 * PROBLEMET DEN LÖSER. `hal3d.html` frågade förut efter markhöjden med en
 * nedåt-raycast mot hela markmeshen, en gång per punkt. Uppmätt 2026-08-01:
 * **6,3 ms per stråle som träffar** (en som missar kostar ~0 — det är därför
 * ett naivt riktmärke ljuger). Hållinjen densifieras var 4 m, så ett 531
 * m-hål betyder 133 strålar × 6,3 ms = 0,9 s. Per `input`-event, 60 gånger i
 * sekunden under ett drag.
 *
 * VARFÖR EN EGEN STRUKTUR OCH INTE EN BVH. Vi frågar aldrig om en godtycklig
 * stråle — vi frågar alltid RAKT NEDÅT. Det gör problemet 2,5-dimensionellt:
 * hitta triangeln som täcker (x, z) och interpolera y. Ett rutnät över XZ
 * räcker då, och det är både enklare och snabbare än en generell BVH — och
 * kostar inget nytt beroende.
 *
 * HÖJDEN LAGRAS UTAN ÖVERDRIFT. Anroparen bygger indexet ur marken vid
 * `scale.y = 1` och multiplicerar själv med överdriften vid uppslag. Då är ett
 * byte av överdriften gratis: samma index, ny faktor. Bakade vi in
 * överdriften skulle indexet behöva byggas om vid varje ryck i reglaget, och
 * då vore vi tillbaka där vi började.
 *
 * REN MODUL: inga sidoeffekter, inget THREE, ingen DOM. Den tar en
 * Float32Array med triangelhörn i världskoordinater och ger en funktion.
 */
"use strict";

const Markhojd = (() => {
  const CELL_M = 8;          // rutstorlek. Marken är ~1 m-DEM, så en ruta rymmer få trianglar.

  /* Bygg index ur `pos` = [x0,y0,z0, x1,y1,z1, ...], tre hörn per triangel.
     Returnerar null för tomt underlag — anroparen ska då falla tillbaka. */
  function bygg(pos, cellM) {
    if (!pos || pos.length < 9) return null;
    const cell = cellM || CELL_M;
    const antal = Math.floor(pos.length / 9);       // trianglar

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], z = pos[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);

    /* CSR-liknande uppläggning i stället för en array av arrayer: räkna först
       hur många trianglar varje ruta får, lägg sedan in dem. Två svep i stället
       för tiotusentals små arrayer — det är byggtiden som ska vara omärklig,
       annars har vi bara flyttat väntan till hålbytet. */
    const raknare = new Int32Array(nx * nz + 1);
    const cellFor = (v, min) => Math.floor((v - min) / cell);
    const spann = t => {
      const i = t * 9;
      const x0 = pos[i], z0 = pos[i + 2], x1 = pos[i + 3], z1 = pos[i + 5],
            x2 = pos[i + 6], z2 = pos[i + 8];
      return [
        Math.max(0, cellFor(Math.min(x0, x1, x2), minX)),
        Math.min(nx - 1, cellFor(Math.max(x0, x1, x2), minX)),
        Math.max(0, cellFor(Math.min(z0, z1, z2), minZ)),
        Math.min(nz - 1, cellFor(Math.max(z0, z1, z2), minZ)),
      ];
    };
    for (let t = 0; t < antal; t++) {
      const [cx0, cx1, cz0, cz1] = spann(t);
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) raknare[cz * nx + cx + 1]++;
    }
    for (let i = 1; i < raknare.length; i++) raknare[i] += raknare[i - 1];
    const start = raknare;                       // nu offsettabell
    const lista = new Int32Array(start[start.length - 1]);
    const skriv = Int32Array.from(start.subarray(0, nx * nz));
    for (let t = 0; t < antal; t++) {
      const [cx0, cx1, cz0, cz1] = spann(t);
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) lista[skriv[cz * nx + cx]++] = t;
    }

    /* Höjden i (x, z), eller null utanför marken.
       Flera trianglar kan täcka punkten (brant slänt, överlappande ytor). En
       nedåt-raycast returnerade den NÄRMASTE, alltså den högsta — samma val
       här, annars kan linjen dyka under marken i en sluttning. */
    function hojd(x, z) {
      const cx = cellFor(x, minX), cz = cellFor(z, minZ);
      if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return null;
      const c = cz * nx + cx;
      let basta = null;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const i = lista[k] * 9;
        const y = _iTriangel(x, z, pos, i);
        if (y !== null && (basta === null || y > basta)) basta = y;
      }
      return basta;
    }

    return { hojd, nx, nz, cell, trianglar: antal, minX, minZ,
             _celler: nx * nz, _poster: lista.length };
  }

  /* Barycentriskt: ligger (x, z) i triangeln, och vad är y där?
     Koordinaterna a/b/c är NORMALISERADE (de summerar till 1), så ett fast
     epsilon är redan en relativ tolerans — den betyder samma sak för en 0,5
     m-triangel i korridoren som för en 8 m-triangel i kjolen. Utan den lämnar
     flyttalsbruset springor i sömmarna mellan trianglar, och en punkt exakt på
     en kant skulle svara "utanför marken". */
  const EPS = 1e-9;
  function _iTriangel(x, z, p, i) {
    const x0 = p[i], y0 = p[i + 1], z0 = p[i + 2];
    const x1 = p[i + 3], y1 = p[i + 4], z1 = p[i + 5];
    const x2 = p[i + 6], y2 = p[i + 7], z2 = p[i + 8];
    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (d === 0) return null;                       // degenererad triangel
    const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
    const b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
    const c = 1 - a - b;
    if (a < -EPS || b < -EPS || c < -EPS) return null;
    return a * y0 + b * y1 + c * y2;
  }

  return { bygg, CELL_M, _iTriangel };
})();

if (typeof globalThis !== "undefined") globalThis.Markhojd = Markhojd;
if (typeof module !== "undefined" && module.exports) module.exports = Markhojd;
