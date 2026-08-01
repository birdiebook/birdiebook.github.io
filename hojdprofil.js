// Höjdprofil — U6 (UPPGRADERING_3D.md §5). Rena funktioner för profilen och
// kopplingen mellan profilpanelen och 3D-markören.
//
// MEDVETET noll imports (samma mönster som camctl.js) — filen körs oförändrad
// i webbläsaren (hal3d.html) och i node (tests/js/test_hojdprofil.mjs) utan
// three.js. Geografiska/vind-beräkningar görs INTE här: PlayAs (playas.js)
// och MapCore (mapcore.js) är enda källan för det (princip 4, §1) — den här
// filen bara räknar fram argumenten (origin/target/Δh) och skickar dem
// vidare, injicerade som parametrar i stället för globaler så filen förblir
// testbar utan att ladda hela sidan.
//
// s = båglängd (meter) längs meta.line, från tee (s=0) mot green (s=sMax).
// Samma linje som tools/hole_gltf.py:georef_fields densifierar till
// meta.profile, så sMax(profile) === hela hållinjens längd.

/** Profilens sista s-värde = hela hållinjens längd (m). */
export function sMax(profile) {
  return profile && profile.length ? profile[profile.length - 1][0] : 0;
}

/** Klampar s till [0, sMax(profile)]. */
export function clampS(s, profile) {
  const max = sMax(profile);
  if (!Number.isFinite(s)) return 0;
  return s < 0 ? 0 : s > max ? max : s;
}

/**
 * s → (x, z): vandra meta.line-segmenten med båglängd tills s nås.
 * Motsatt riktning av playas.js:elev3dAt, som projicerar (x,z) → s (se
 * xzToS nedan för samma projektion, återanvänd för 3D → s).
 */
export function sToXZ(line, s) {
  if (!line || !line.length) return { x: 0, z: 0 };
  if (line.length === 1) return { x: line[0][0], z: line[0][2] };
  let acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, , az] = line[i], [bx, , bz] = line[i + 1];
    const segLen = Math.hypot(bx - ax, bz - az);
    const isLast = i === line.length - 2;
    if (s <= acc + segLen || isLast) {
      const t = segLen ? Math.max(0, Math.min(1, (s - acc) / segLen)) : 0;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
    }
    acc += segLen;
  }
  const last = line[line.length - 1];
  return { x: last[0], z: last[2] };
}

/**
 * (x, z) → s: projicera punkten mot varje segment av meta.line, som
 * playas.js:elev3dAt gör, och returnera båglängden till närmaste punkt.
 * Används för att låta en tryckning i 3D (på hållinjen) sätta samma skalär
 * `s` som profilpanelen drar i — RITREGELNS "åt andra hållet".
 */
export function xzToS(line, x, z) {
  if (!line || line.length < 2) return 0;
  let best = null, acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, , az] = line[i], [bx, , bz] = line[i + 1];
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const segLen = Math.sqrt(len2);
    const px = ax + t * dx, pz = az + t * dz;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    const s = acc + t * segLen;
    if (!best || d2 < best.d2) best = { d2, s };
    acc += segLen;
  }
  return best ? best.s : 0;
}

/**
 * s → sann höjd (m, tee-relativ) ur meta.profile — samma interpolation som
 * playas.js:elev3dAt använder på sin profil-uppslagning (linjär mellan de
 * omslutande 10 m-punkterna). exag rör INTE detta tal (§1 princip 4 /
 * UPPGRADERING_3D.md hal3d.html:318) — det är den sanna höjden.
 */
export function yAtS(profile, s) {
  const p = profile;
  if (!p || !p.length) return 0;
  const clamped = clampS(s, p);
  let i = 1;
  while (i < p.length - 1 && p[i][0] < clamped) i++;
  const [s0, y0] = p[i - 1], [s1, y1] = p[i];
  return s1 > s0 ? y0 + (y1 - y0) * (clamped - s0) / (s1 - s0) : y0;
}

/**
 * Invers av ll2local (playas.js): lokal (x, z) → [lat, lon] via samma
 * affin (ll2xz). Affinen är en 2×2-linjär avbildning + offset, så den går
 * att invertera exakt (determinanten är alltid ≠ 0 för en riktig georef).
 * Behövs för att kunna ge PlayAs.playAsRange RIKTIGA lat/lon-punkter för ett
 * godtyckligt läge längs profilen, så "spelar som" räknas av EXAKT samma
 * modell som rangefindern skulle för samma fysiska punkt.
 */
export function xzToLatLon(ll2xz, x, z) {
  const [lon0, lat0, a, b, c, d] = ll2xz;
  const det = a * d - b * c;
  const dlon = (d * x - b * z) / det;
  const dlat = (a * z - c * x) / det;
  return [lat0 + dlat, lon0 + dlon];
}

/**
 * Framåtriktningen: [lat, lon] → lokal (x, z) med samma `ll2xz`-affin
 * (`tools/hole_gltf.py` skriver den; formen är [lon0, lat0, a, b, c, d]).
 * Identisk med `ll2local` i playas.js, men den är privat där — och affinen
 * ska bo på ETT ställe, bredvid sin invers, så de inte kan glida isär.
 * Används av hal3d.html för att lägga loggade slag i 3D-scenen.
 */
export function latLonToXz(ll2xz, lat, lon) {
  const [lon0, lat0, a, b, c, d] = ll2xz;
  return [(lon - lon0) * a + (lat - lat0) * b,
          (lon - lon0) * c + (lat - lat0) * d];
}

/**
 * Nettohöjd tee→green att visa i panelen: vald tees dh om metan har den
 * tee:n (localStorage "sg_tee", samma konvention som playas.js:dh3dToGreen),
 * annars hålets delta_h. Båda fälten läses OFÖRÄNDRADE ur samma holes3d-JSON
 * tools/hole_gltf.py redan skrivit — ingen egen uträkning här.
 */
export function netHeight(meta, teeId) {
  const t = teeId && meta.tees ? meta.tees[teeId] : null;
  if (t && Number.isFinite(t.dh)) return { dh: t.dh, tee: teeId, len: t.len };
  return { dh: meta.delta_h, tee: null, len: meta.length_m };
}

/**
 * Greenens (lokala) position + sanna höjd: green_center om metan har den,
 * annars profilens sista punkt (samma fallback som src/api/elev.py:hole_elev
 * och playas.js:dh3dToGreen).
 */
function greenXYZ(meta) {
  if (meta.green_center) {
    const [x, y, z] = meta.green_center;
    return { x, y, z };
  }
  const last = meta.line[meta.line.length - 1];
  const y = meta.profile[meta.profile.length - 1][1];
  return { x: last[0], y, z: last[2] };
}

/**
 * "Spelar som" från läget vid `s` till green — MÅSTE komma från PlayAs
 * (window.PlayAs i webbläsaren), injicerad här som parameter så filen
 * förblir importfri/testbar. Med vind: forwardar RAKT AV till
 * PlayAs.playAsRange — bit-identiskt med vad rangefindern skulle visa för
 * samma origin/target/vind/slope. Utan vind (hal3d.html:s offline-läge,
 * §1 princip 3 — inget nät): playAsRange returnerar null (kräver vind), så
 * `mean` byggs i stället av geometriskt avstånd (MapCore.hav) + PlayAs.slopeEffect
 * — fortfarande PlayAs/MapCore som enda källa, ingen egen vind- eller
 * lutningsmodell.
 *
 * @param MapCore  window.MapCore (för `hav`)
 * @param PlayAs   window.PlayAs (för `slopeEffect`/`playAsRange`)
 */
export function playsAsAt(MapCore, PlayAs, meta, s, wind) {
  const { x, z } = sToXZ(meta.line, s);
  const yHere = yAtS(meta.profile, s);
  const g = greenXYZ(meta);
  const origin = xzToLatLon(meta.ll2xz, x, z);
  const target = xzToLatLon(meta.ll2xz, g.x, g.z);
  const dh = g.y - yHere;
  const slope = PlayAs.slopeEffect(dh);
  if (wind) {
    const r = PlayAs.playAsRange(origin, target, wind, slope);
    return { ...r, dh, windless: false };
  }
  const D = MapCore.hav(origin, target);
  return {
    mean: Math.round(D + slope), gust: null, along: null, label: null,
    side: null, cross: null, dh, windless: true,
  };
}
