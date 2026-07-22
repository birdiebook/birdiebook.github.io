"use strict";
/* PlayAs — "spelar som"-avstånd (vind + höjd) + offline-höjddata ur 3D-metan.
 *
 * Utbrutet ur karta.html (PR0, PLANERA_RUNDA_PLAN.md) så hålkartan OCH plan-läget
 * (planera.html) delar EXAKT samma modell. Ren beräkning: modulen känner inga
 * globala pos/ROUND/hi och rör ingen UI — anroparen matar in origin/target/vind
 * och ritar själv. Håll denna i synk med planner.wind_along_shift (server).
 *
 * Kräver MapCore (rad/hav/bearing) laddad FÖRE denna fil.
 *
 * window.PlayAs:
 *   compass(deg) -> "NV" | ""
 *   relWind(shotBearing, ms, dirDeg) -> {along, cross, side, label}
 *   windAlongShift(alongMs, shotLen) -> meter (+ = bollen flyger längre)
 *   playAsRange(origin, target, wind, slope) -> {mean, gust, along, label, side, cross} | null
 *   fetchWind(lat, lon) -> Promise<{ms, dir, gust} | null>   (Open-Meteo)
 *   loadElev3d(h, onReady?)   // laddar hålets 3D-meta i cachen; onReady() när den landat
 *   meta(h) -> metaobjekt | null            // cachad 3D-meta (för fri-punktsmätning)
 *   ll2local(m, lat, lon) -> [x, z]
 *   elev3dAt(m, lat, lon) -> y (m över tee-marken) | null
 *   dh3dToGreen({fromTee, pt}, h) -> Δh m (+ = uppför) | null   (tee via sg_tee)
 *   slopeEffect(dh) -> spellängds-Δ (uppför 1:1, nedför 0,8:1)
 *   GUST_SPAN_MIN_M
 */
const PlayAs = (() => {
  const rad = MapCore.rad, hav = MapCore.hav, bearing = MapCore.bearing;

  // ---- vind (Open-Meteo, gratis; samma konvention som src/api/wind.py) ----
  const COMPASS = ["N", "NO", "O", "SO", "S", "SV", "V", "NV"];
  const compass = deg => deg == null ? "" : COMPASS[Math.round(deg / 45) % 8];
  function relWind(shotBearing, ms, dirDeg) {  // vinden kommer FRÅN dirDeg
    const d = rad(dirDeg - shotBearing);
    const along = -ms * Math.cos(d), right = -ms * Math.sin(d);
    return { along, cross: Math.abs(right), side: Math.abs(right) < 0.3 ? null : (right > 0 ? "H" : "V"),
             label: along >= 0 ? "medvind" : "motvind" };
  }

  // "Spelar som" — samma modell som planner.wind_along_shift (håll dem i synk):
  // motvind PROGRESSIV (lin + kvadrat — mer luftfart → mer lyft/drag, bollen
  // ballongar), medvind linjär. TrackMan-kalibrerad vid 230 m, skalas med avståndet.
  const WIND_HEAD_LIN = 2.0, WIND_HEAD_QUAD = 0.15, WIND_TAIL = 1.6, WIND_REF = 230;
  const GUST_SPAN_MIN_M = 3;   // visa spann först när byn flyttar ≥ så här många m
  function windAlongShift(alongMs, shotLen) {  // + = bollen flyger längre
    const sc = shotLen / WIND_REF;
    if (alongMs >= 0) return WIND_TAIL * alongMs * sc;
    const w = -alongMs;
    return -(WIND_HEAD_LIN * w + WIND_HEAD_QUAD * w * w) * sc;
  }

  async function fetchWind(lat, lon) {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
        + `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms`;
      const c = (await (await fetch(u)).json()).current;
      return { ms: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m };
    } catch (e) { return null; }
  }

  // --- Höjd ur 3D-metan (C1, SPELVARDE_3D_PLAN.md) -----------------------------
  // LM-DEM:ens höjder följer med holes3d-exporten: ll2xz-affinen lägger en
  // lat/lon i hålets lokala meterram (SWEREF-skevningen ~1,6° är inbakad — rak
  // grad-till-meter räcker inte), profile ger höjden längs hållinjen var 10:e m
  // och tees[].dh ger Δh tee→green per tee. PRIMÄR höjdkälla (offline, 1 m-nät).
  let ELEV3D = {};   // slug -> meta | null (null = laddar/saknas)
  function holeSlug(h) { return `${h.loop.replace(" Course", "").toLowerCase()}_${h.hole}`; }
  function loadElev3d(h, onReady) {
    const slug = holeSlug(h);
    if (ELEV3D[slug] !== undefined) return;
    ELEV3D[slug] = null;
    fetch(`data/holes3d/${slug}.json`).then(r => r.json()).then(m => {
      if (m && m.ll2xz && m.profile) { ELEV3D[slug] = m; if (onReady) onReady(); }
    }).catch(() => {});
  }
  function meta(h) { return ELEV3D[holeSlug(h)] || null; }
  function ll2local(m, lat, lon) {
    const [lon0, lat0, a, b, c, d] = m.ll2xz;
    return [(lon - lon0) * a + (lat - lat0) * b,
            (lon - lon0) * c + (lat - lat0) * d];
  }
  // lokal höjd (y, meter över tee-marken) för en lat/lon: projicera punkten på
  // hållinjen och interpolera profilen där. Fairway följer linjen — bra approx.
  function elev3dAt(m, lat, lon) {
    const [x, z] = ll2local(m, lat, lon);
    let best = null, acc = 0;
    for (let i = 0; i < m.line.length - 1; i++) {
      const [x1, , z1] = m.line[i], [x2, , z2] = m.line[i + 1];
      const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz);
      const t = L ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / (L * L))) : 0;
      const d2 = (x - (x1 + t * dx)) ** 2 + (z - (z1 + t * dz)) ** 2;
      if (!best || d2 < best.d2) best = { d2, s: acc + t * L };
      acc += L;
    }
    if (!best) return null;
    const p = m.profile, s = Math.max(0, Math.min(best.s, p[p.length - 1][0]));
    let i = 1;
    while (i < p.length - 1 && p[i][0] < s) i++;
    const [s0, y0] = p[i - 1], [s1, y1] = p[i];
    return s1 > s0 ? y0 + (y1 - y0) * (s - s0) / (s1 - s0) : y0;
  }
  // Δh (m, + = uppför) från mätpunkten till green för aktuellt hål, ur 3D-metan.
  // Från tee används vald tees förberäknade dh (spelarens GPS säger inget om tee).
  // null när metan inte (ännu) finns → anroparen faller tillbaka på Open-Meteo.
  function dh3dToGreen(o, h) {
    const m = ELEV3D[holeSlug(h)];
    if (!m) return null;
    if (o.fromTee) {
      const t = m.tees && m.tees[localStorage.getItem("sg_tee") || ""];
      return t ? t.dh : null;
    }
    const y = elev3dAt(m, o.pt[0], o.pt[1]);
    if (y == null) return null;
    const gy = m.green_center ? m.green_center[1] : m.profile[m.profile.length - 1][1];
    return gy - y;
  }
  // asymmetrisk spellängdseffekt: uppför spelar hela höjden, nedför ger inte
  // hela höjden tillbaka (flackare infallsvinkel äts av rull/carry-geometri)
  const SLOPE_DOWN_FACTOR = 0.8;
  function slopeEffect(dh) { return dh >= 0 ? dh : SLOPE_DOWN_FACTOR * dh; }

  // "spelas som"-avstånd till en punkt: geometriskt + vind (range medelvind–by)
  // + ev. slope. Returnerar null om vind eller utgångspunkt saknas. Byn antas
  // komma från samma håll som medelvinden → along skalas med gust/medel.
  function playAsRange(origin, target, wind, slope) {
    if (!origin || !wind) return null;
    const D = hav(origin, target);
    const rw = relWind(bearing(origin, target), wind.ms, wind.dir);
    const windShift = -windAlongShift(rw.along, D);
    const gustAlong = (wind.gust != null && wind.ms > 0) ? rw.along * wind.gust / wind.ms : rw.along;
    const gustShift = -windAlongShift(gustAlong, D);
    slope = slope || 0;
    return { mean: Math.round(D + windShift + slope), gust: Math.round(D + gustShift + slope),
             along: rw.along, label: rw.label, side: rw.side, cross: rw.cross };
  }

  return { compass, relWind, windAlongShift, playAsRange, fetchWind,
           loadElev3d, meta, ll2local, elev3dAt, dh3dToGreen, slopeEffect,
           GUST_SPAN_MIN_M };
})();
if (typeof window !== "undefined") window.PlayAs = PlayAs;
else if (typeof globalThis !== "undefined") globalThis.PlayAs = PlayAs;
