"use strict";
/* SlopeOverlay — green-lutning som Leaflet-overlay (trogen heatmap + fallpilar).
 *
 * Utbrutet ur karta.html (PR0, PLANERA_RUNDA_PLAN.md) så hålkartan OCH plan-läget
 * (planera.html) delar samma rendering. Modulen äger sin egen slope-cache och
 * pil-state men INGA kartlager/kartor — anroparen skapar layers och skickar in
 * map/slopeLayer/arrowLayer/pos på varje anrop. pos får vara null (plan-läge utan
 * GPS) → alla pilar visas (som uppe vid greenen).
 *
 * Datat är green_slope.geojson (byggs av tools/build_green_slope.py --mobile):
 * 'fall'-features (korta LineStrings upp→ned, slope_pct + bearing) för pilarna +
 * ett tätt 'grids'-rutnät för heatmapen. Green-book-paletten (0–6 %, vit=platt)
 * speglar src/gis/visualize.py._BOOK_COLORS.
 *
 * Kräver MapCore (rad/hav) + Leaflet (L) laddade FÖRE denna fil.
 *
 * window.SlopeOverlay:
 *   load() -> Promise            // förladda + indexera green_slope.geojson (idempotent)
 *   show(map, slopeLayer, arrowLayer, h, pos, isCurrent?) -> Promise
 *   drawArrows(map, arrowLayer, pos)     // rita om pilarna (t.ex. vid zoom/flytt)
 *   hide(slopeLayer, arrowLayer)
 *   activeHole() -> h | null     // hålet vars lutning ritas just nu
 *   lastZoom() -> zoom | null    // zoom vid senaste pil-ritning
 *   arrowDist() -> m | null      // avstånd pos→green vid senaste pil-ritning
 *   slopeRGB(pct) -> [r,g,b] · slopeColor(pct) -> "rgb(...)"
 */
const SlopeOverlay = (() => {
  const rad = MapCore.rad, hav = MapCore.hav, bearing = MapCore.bearing;

  // Green-book-palett (0–6 %, vit=platt) — speglar src/gis/visualize.py._BOOK_COLORS.
  const SLOPE_STOPS = [[0.000,[255,255,255]],[0.167,[238,246,236]],[0.300,[191,224,178]],
    [0.450,[143,208,138]],[0.600,[233,221,110]],[0.740,[239,180,90]],
    [0.870,[224,123,69]],[1.000,[201,67,47]]];
  const SLOPE_VMAX = 6.0;   // %, fast skala (samma som greenbilderna)
  function slopeRGB(pct) {
    const t = Math.max(0, Math.min(1, pct / SLOPE_VMAX));
    let a = SLOPE_STOPS[0], b = SLOPE_STOPS[SLOPE_STOPS.length - 1];
    for (let i = 0; i < SLOPE_STOPS.length - 1; i++) {
      if (t >= SLOPE_STOPS[i][0] && t <= SLOPE_STOPS[i + 1][0]) { a = SLOPE_STOPS[i]; b = SLOPE_STOPS[i + 1]; break; }
    }
    const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    return [0, 1, 2].map(k => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f));
  }
  function slopeColor(pct) { const c = slopeRGB(pct); return `rgb(${c[0]},${c[1]},${c[2]})`; }

  // Destination-punkt (liten sträcka, ekvirektangulär approximation räcker på green).
  function destPoint(pt, brgDeg, dM) {
    const br = rad(brgDeg);
    return [pt[0] + (dM * Math.cos(br)) / 111320,
            pt[1] + (dM * Math.sin(br)) / (111320 * Math.cos(rad(pt[0])))];
  }

  // En fallpil: skaft upp→ned + pilspets i nedre (nedförs-)änden. lat/lon-geometri
  // (inte pixlar) så pilen roterar rätt med den roterade kartan.
  function drawArrow(a, b, color, weight, arrowLayer) {
    const len = hav(a, b);                       // pillängd (meter)
    const back = bearing(b, a);                  // tip→uppför (bakåt)
    const base = destPoint(b, back, len * 0.4);  // pilspetsens bas (liten spets)
    L.polyline([a, base], { color, weight: weight || 1.5, opacity: 0.95,
      lineCap: "round", interactive: false }).addTo(arrowLayer);
    const half = len * 0.17;                      // halva spetsbredden (smalare)
    L.polygon([b, destPoint(base, (back + 90) % 360, half), destPoint(base, (back + 270) % 360, half)],
      { color, weight: 0.6, fillColor: color, fillOpacity: 1, opacity: 1,
        lineJoin: "round", interactive: false }).addTo(arrowLayer);
  }

  // Meter per skärmpixel vid given latitud/zoom (web-mercator) — för skärmkonstant
  // pilstorlek: samma antal pixlar oavsett om man är nära eller 160 m bort.
  function metersPerPixel(lat, zoom) {
    return 40075016.686 * Math.cos(rad(lat)) / Math.pow(2, zoom + 8);
  }

  let SLOPE_IDX = null;     // "loop|hål" → [fall-features], laddas en gång
  let SLOPE_GRIDS = null;   // "loop|hål" → tätt slope-rutnät {ny,nx,lat0,lon0,dLat,dLon,slope[]}
  let slopeHole = null, slopeCells = null, lastArrowZoom = null;
  let slopeArrowDist = null;   // avstånd pos→green vid senaste pil-ritning (för 60 m-tröskeln)

  // Trogen lutnings-heatmap (green-book-stil) som imageOverlay, ur det TÄTA slope-
  // rutnätet (green_slope.geojson:s `grids`). Rutnätet är norr-upp lat/lon; en canvas
  // nx×ny målas cell-för-cell och klipps till green-polygonen.
  function slopeHeatOverlay(h) {
    const grid = SLOPE_GRIDS && SLOPE_GRIDS[h.loop + "|" + h.hole];
    if (!grid || !h.green || h.green.length < 3) return null;
    const nx = grid.nx, ny = grid.ny, sl = grid.slope;
    const latMax = grid.lat0, latMin = grid.lat0 - (ny - 1) * grid.dLat;
    const lonMin = grid.lon0, lonMax = grid.lon0 + (nx - 1) * grid.dLon;
    // Hög upplösning: bilinjär uppsampling av LUTNINGEN (inte RGB → rätt palettfärg
    // vid mellanvärden) och färglägg varje pixel.
    const S = Math.max(6, Math.round(420 / Math.max(nx, ny)));
    const cw = nx * S, ch = ny * S;
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
    const cx = cv.getContext("2d"), img = cx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      const gy = y / (ch - 1) * (ny - 1), j0 = Math.min(ny - 2, Math.floor(gy)), ty = gy - j0;
      for (let x = 0; x < cw; x++) {
        const gx = x / (cw - 1) * (nx - 1), i0 = Math.min(nx - 2, Math.floor(gx)), tx = gx - i0;
        const s = (sl[j0 * nx + i0] * (1 - tx) + sl[j0 * nx + i0 + 1] * tx) * (1 - ty)
                + (sl[(j0 + 1) * nx + i0] * (1 - tx) + sl[(j0 + 1) * nx + i0 + 1] * tx) * ty;
        const col = slopeRGB(s), o = (y * cw + x) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    cx.globalCompositeOperation = "destination-in";   // behåll bara insidan av greenen
    cx.beginPath();
    h.green.forEach((p, i) => {
      const X = (p[1] - lonMin) / (lonMax - lonMin) * cw, Y = (latMax - p[0]) / (latMax - latMin) * ch;
      i ? cx.lineTo(X, Y) : cx.moveTo(X, Y);
    });
    cx.closePath(); cx.fillStyle = "#000"; cx.fill();
    // Nästan opak → green-book-färgerna slår igenom rent (matchar datorbilden).
    return L.imageOverlay(cv.toDataURL(), [[latMin, lonMin], [latMax, lonMax]],
      { opacity: 0.95, interactive: false });
  }

  // Punkt i green-polygon (ray casting). poly = [[lat,lon], ...].
  function pointInGreen(poly, lat, lon) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  // Ladda green_slope.geojson EN gång och indexera fall-features på "loop|hål".
  // Saknas filen (offline/ej byggd) → tyst av, kartan funkar som förr.
  async function load() {
    if (SLOPE_IDX) return SLOPE_IDX;
    SLOPE_IDX = {};
    try {
      const fc = await (await fetch("./data/green_slope.geojson", { cache: "no-cache" })).json();
      for (const f of fc.features || []) {
        const p = f.properties || {};
        if (p.t !== "fall") continue;
        (SLOPE_IDX[p.loop + "|" + p.hole] ||= []).push(f);
      }
      SLOPE_GRIDS = fc.grids || {};
    } catch (e) { /* ingen slope-data → overlayen visas bara inte */ }
    return SLOPE_IDX;
  }

  // Rita green-lutningen för hålet h (rensar först). isCurrent() (valfri) låter
  // anroparen avbryta om hålet bytts medan geojson:en laddades.
  async function show(map, slopeLayer, arrowLayer, h, pos, isCurrent) {
    slopeLayer.clearLayers();
    if (!h) return;
    if (localStorage.getItem("sg_slope") === "off") return;   // avstängd på Logga slag-sidan
    const idx = await load();
    if (isCurrent && !isCurrent()) return;   // hål bytt medan vi laddade → skippa
    const feats = idx[h.loop + "|" + h.hole];
    if (!feats) return;
    // Green-book-stil: slät lutnings-heatmap under + mörka fallpilar över.
    const cells = feats.map(f => ({ lon: f.geometry.coordinates[0][0],
      lat: f.geometry.coordinates[0][1], s: f.properties.slope_pct,
      dx: Math.sin(rad(f.properties.bearing)), dy: Math.cos(rad(f.properties.bearing)) }));
    const heat = slopeHeatOverlay(h);   // trogen heatmap ur det täta slope-rutnätet
    if (heat) heat.addTo(slopeLayer);
    slopeHole = h; slopeCells = cells;   // cells = pilarnas riktning (IDW)
    drawArrows(map, arrowLayer, pos);
  }

  // Rita fallpilarna med SKÄRMKONSTANT storlek (pillängd + rut-avstånd i pixlar
  // via meter-per-pixel) så de syns lika bra på 160 m som uppe vid greenen. Ritas
  // om vid varje zoom. pos = null → dGreen 0 → alla pilar (som uppe vid greenen).
  function drawArrows(map, arrowLayer, pos) {
    arrowLayer.clearLayers();
    const h = slopeHole, cells = slopeCells;
    if (!h || !cells || !h.green || !h.green_center) return;
    const z = map.getZoom();
    lastArrowZoom = z;
    const mpp = metersPerPixel(h.green_center[0], z);
    const FALL_LEN_M = Math.max(0.7, 14 * mpp);   // ~14 px pil
    const FALL_FINE_M = Math.max(1.0, 18 * mpp);  // ~18 px mellan pilar
    // Avstånds-beroende lutningströskel: inom 60 m av green visas alla pilar (≥1.3 %);
    // utanför 60 m bara där det lutar tydligt (≥~3.2 %). (Distans från pos, ej zoom.)
    let dGreen = 0;
    if (pos && h.green_center) dGreen = hav(pos, h.green_center);
    slopeArrowDist = dGreen;
    const zt = Math.max(0, Math.min(1, (dGreen - 60) / 18));   // 0 inom 60 m → 1 vid ~78 m
    const FALL_MIN_SLOPE = 1.3 + zt * 1.9;        // 1.3 % inom 60 m → ~3.2 % utanför
    // Lutnings-MAGNITUD för tröskeln tas ur det TÄTA rutnätet (rätt även på platt
    // yta); riktningen tas ur fallcellernas IDW nedan.
    const grid = SLOPE_GRIDS && SLOPE_GRIDS[h.loop + "|" + h.hole];
    const gridSlope = (lat, lon) => {
      if (!grid) return null;
      const fc = (lon - grid.lon0) / grid.dLon, fr = (grid.lat0 - lat) / grid.dLat;
      const i0 = Math.max(0, Math.min(grid.nx - 2, Math.floor(fc))), tx = Math.max(0, Math.min(1, fc - i0));
      const j0 = Math.max(0, Math.min(grid.ny - 2, Math.floor(fr))), ty = Math.max(0, Math.min(1, fr - j0));
      const s = grid.slope, nx = grid.nx;
      return (s[j0 * nx + i0] * (1 - tx) + s[j0 * nx + i0 + 1] * tx) * (1 - ty)
           + (s[(j0 + 1) * nx + i0] * (1 - tx) + s[(j0 + 1) * nx + i0 + 1] * tx) * ty;
    };
    const mLat = 111320, mLon = 111320 * Math.cos(rad(h.green_center[0]));
    let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
    for (const p of h.green) {
      if (p[0] < latMin) latMin = p[0]; if (p[0] > latMax) latMax = p[0];
      if (p[1] < lonMin) lonMin = p[1]; if (p[1] > lonMax) lonMax = p[1];
    }
    const dLat = FALL_FINE_M / mLat, dLon = FALL_FINE_M / mLon;
    for (let lat = latMin + dLat / 2; lat < latMax; lat += dLat) {
      for (let lon = lonMin + dLon / 2; lon < lonMax; lon += dLon) {
        if (!pointInGreen(h.green, lat, lon)) continue;
        let sw = 0, ss = 0, ux = 0, uy = 0;
        for (const c of cells) {
          const ex = (lon - c.lon) * mLon, ny = (lat - c.lat) * mLat, d2 = ex * ex + ny * ny + 0.6;
          const w = 1 / (d2 * Math.sqrt(d2)); sw += w; ss += w * c.s; ux += w * c.dx; uy += w * c.dy;
        }
        const smag = grid ? gridSlope(lat, lon) : ss / sw;   // rätt lutning även på platt yta
        if (smag < FALL_MIN_SLOPE) continue;      // hoppa platt/vit + (på avstånd) svag lutning
        const brg = (Math.atan2(ux, uy) * 180 / Math.PI + 360) % 360;   // ux=öst(sin), uy=norr(cos)
        const mid = [lat, lon];   // centrera pilen på rutnätspunkten
        drawArrow(destPoint(mid, (brg + 180) % 360, FALL_LEN_M / 2),
                  destPoint(mid, brg, FALL_LEN_M / 2), "#14261b", 1.5, arrowLayer);
      }
    }
  }

  function hide(slopeLayer, arrowLayer) {
    slopeLayer.clearLayers(); arrowLayer.clearLayers();
    slopeHole = null; slopeCells = null;
  }

  return { load, show, drawArrows, hide,
           activeHole: () => slopeHole, lastZoom: () => lastArrowZoom,
           arrowDist: () => slopeArrowDist, slopeRGB, slopeColor };
})();
if (typeof window !== "undefined") window.SlopeOverlay = SlopeOverlay;
else if (typeof globalThis !== "undefined") globalThis.SlopeOverlay = SlopeOverlay;
