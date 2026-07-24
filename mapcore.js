"use strict";
/* MapCore — delat kart-scaffolding för hålkartan (karta.html) och kommande
 * redigera-sidan. SPIKE-omfång: bara det som init + inramning behöver
 * (createMap, addOrthophoto, fitBand). Övriga delade delar (teePoint,
 * drawHoleGeometry, drawShots, colorForShot) flyttas i Fas 0 proper.
 *
 * Beroenden: globala L (Leaflet + leaflet-rotate) och CourseMap (coursemap.js).
 * Rena helpers (_rad/_hav) är privata så modulen är självbärande. */
const MapCore = (() => {
  const _R = 6371000;
  const _rad = d => d * Math.PI / 180;
  function _hav(a, b) {              // [lat,lon]-par → meter (samma som karta.html hav)
    const dphi = _rad(b[0] - a[0]), dl = _rad(b[1] - a[1]);
    const s = Math.sin(dphi / 2) ** 2
      + Math.cos(_rad(a[0])) * Math.cos(_rad(b[0])) * Math.sin(dl / 2) ** 2;
    return 2 * _R * Math.asin(Math.sqrt(s));
  }

  // Roterad Leaflet-karta, samma config som hålkartan alltid använt.
  // zoomSnap:0 = bråkdels-zoom (krävs för att fitBand ska bli exakt).
  function createMap(elId) {
    return L.map(elId, {
      zoomControl: false, attributionControl: false,
      zoomSnap: 0,
      rotate: true, touchRotate: true, shiftKeyRotate: true, rotateControl: false,
    });
  }

  // Lantmäteriets ortofoto (0,16 m/px) om tiles/ finns bredvid appen, annars
  // Esri-nödfallback. Läggs i standard-tilePane — en egen pane funkar INTE med
  // leaflet-rotate (pluginet flyttar bara standardpanerna in i rotatePane; en
  // createPane("imagery") hamnar i den oroterade mapPane och blir felplacerad).
  // detectRetina + tileSize:128/zoomOffset:1 = en nivå djupare redan som baslinje
  // → skarpare bild (utnyttjar ortofotots detalj), på bekostnad av fler rutor.
  function addOrthophoto(map) {
    const TILE_OPTS = { updateWhenIdle: false, keepBuffer: 6, detectRetina: true,
      tileSize: 128, zoomOffset: 1 };
    // Cappa native-zoom så URL-zoomen aldrig överstiger z19 (som finns) → annars 404.
    const deepMax = t => t.max_zoom - 1 - (L.Browser.retina ? 1 : 0);
    const esriFallback = () => CourseMap.esriLayer(TILE_OPTS).addTo(map);
    const slug = (typeof SGRound !== "undefined" && SGRound.activeSlug()) || "malmo_burlov";
    fetch(`tiles/${slug}/manifest.json`, { cache: "no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(t => {
        if (!t) { esriFallback(); return; }
        // esriLayer() aktiverade förr ljus/färg-filtret; nu måste vi kalla det själva (idempotent).
        CourseMap.applyImageFilter();
        L.tileLayer(`tiles/${slug}/{z}/{x}/{y}.webp`, {
          bounds: t.bounds, zIndex: 10,
          minNativeZoom: t.min_zoom, maxNativeZoom: deepMax(t),
          minZoom: t.min_zoom, maxZoom: 21,
          attribution: t.attribution,
          ...TILE_OPTS,
        }).addTo(map);
        // Golv på utzoomning = ortofotots lägsta nivå (ingen tom/blank vy).
        map.setMinZoom(t.min_zoom);
        // CC BY 4.0 kräver synlig attribution (attributionControl är av).
        const cred = document.createElement("div");
        cred.textContent = "Ortofoto © Lantmäteriet (CC BY 4.0)";
        cred.style.cssText = "position:absolute;right:4px;bottom:2px;z-index:800;"
          + "font-size:9px;color:#fff;text-shadow:0 0 3px #000;pointer-events:none;";
        document.getElementById("map").appendChild(cred);
      })
      .catch(esriFallback);   // lokala tiles otillgängliga → Esri räddar vyn
  }

  // Ren band-inramning (autozoom-planens computeFrame, generaliserad): zooma +
  // centrera så nedre ankaret (botPt) hamnar vid bandets nederkant och övre
  // ankaret (topPt) vid dess överkant, oavsett vilka UI-paneler som definierar
  // bandet. band = { topY, botY, width, height } i #map:s pixelkoordinater.
  // Web-mercator-skala + bråkdels-zoom (inte fitBounds, som snappar till helsteg).
  // Rotations-medveten centrering via containerPointToLatLng (oroterad pixelrymd).
  // Returnerar true om inramad, false om bandet är för smalt.
  // opts (valfritt): { maxZoom, animate, duration } — autozoom-planens follow-läge
  // clampar zoomen (skarp-bild-tak) och animerar mjukt. Utan opts = oförändrat
  // beteende (karta-overview + redigera-sidan): instant, inget tak.
  function fitBand(map, botPt, topPt, band, opts) {
    opts = opts || {};
    const availPx = band.botY - band.topY;
    if (availPx < 50) return false;
    const D = _hav(botPt, topPt);
    const midLat = (botPt[0] + topPt[0]) / 2;
    let z = Math.log2(40075016.686 * Math.cos(_rad(midLat)) * availPx / (256 * D));
    if (opts.maxZoom != null) z = Math.min(z, opts.maxZoom);
    // INSTANT tvåstegs-inramning (bevisad väg). Båda setView i samma synkrona
    // JS-tick → webbläsaren målar bara sluttillståndet, inget mellansteg syns.
    // OBS: leaflet-rotate (kartan är roterad) animerar INTE pålitligt — animerad
    // setView flög iväg → vi håller oss till instant. maxZoom-taket behålls.
    const cy = (band.topY + band.botY) / 2;
    map.setView([midLat, (botPt[1] + topPt[1]) / 2], z, { animate: false });
    map.setView(map.containerPointToLatLng([band.width / 2, band.height - cy]),
      z, { animate: false });
    return true;
  }

  // Bäring [lat,lon]→[lat,lon] i grader (0=N, 90=Ö).
  function bearing(a, b) {
    const p1 = _rad(a[0]), p2 = _rad(b[0]), dl = _rad(b[1] - a[1]);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // GPS-precisionsfärg — samma trösklar/färger som +-avståndet på Logga slag-sidan:
  // grön ±≤8, gul ±≤15, röd däröver. null = neutral grå (t.ex. handsatt slag).
  function accColor(acc) {
    return acc == null ? "#9fc4ae" : acc <= 8 ? "#7ee2a8" : acc <= 15 ? "#e8c34a" : "#e26a5a";
  }

  // tee-punkt för ett hål = den tee spelaren valde (sg_tee). RIGID mappning via
  // förberäknad punkttabell (tee_points.json, laddas i loadCourse). Fallback när
  // tabellen saknar hålet: fördela numren jämnt bakifrån (floor(rang·boxar/4)).
  const _TEE_RANK = ["61", "57", "53", "48"];
  let _TEE_POINTS = {};   // loop -> "hål" -> { teeNr: [lat,lon], _approx:[...] }
  function teePoint(h) {
    const tees = h.tees || [];
    if (!tees.length) return (h.line && h.line.length) ? h.line[0] : null;
    const sel = localStorage.getItem("sg_tee") || "";
    const pt = _TEE_POINTS[h.loop] && _TEE_POINTS[h.loop][h.hole] && _TEE_POINTS[h.loop][h.hole][sel];
    if (pt && pt.length === 2) return [pt[0], pt[1]];
    const r = _TEE_RANK.indexOf(sel);                     // fallback: rang·boxar/4
    let idx = r < 0 ? 0 : Math.floor(r * tees.length / _TEE_RANK.length);
    if (idx > tees.length - 1) idx = tees.length - 1;
    return [tees[idx].lat, tees[idx].lon];
  }
  // true om spelarens valda tee är en syntetisk punkt (OSM saknar boxen) — approx
  function teeIsApprox(h) {
    const sel = localStorage.getItem("sg_tee") || "";
    const m = _TEE_POINTS[h.loop] && _TEE_POINTS[h.loop][h.hole];
    return !!(m && m._approx && m._approx.indexOf(sel) >= 0);
  }

  // Ladda bandata (burlov.json) + förberäknad tee-tabell (tee_points.json, valfri).
  // Sätter h.global + byggd byGlobal via SGRound.GLOBAL_BASE. Kastar om bandatan
  // inte kan hämtas (anroparen fångar → "Kunde ej ladda bandata").
  async function loadCourse() {
    const data = await (await fetch("./data/" + SGRound.mobileJson(), { cache: "no-cache" })).json();
    const HOLES = data.holes;
    const byGlobal = {};
    const GB = SGRound.GLOBAL_BASE;
    for (const h of HOLES) { h.global = GB[h.loop] + h.hole; byGlobal[h.global] = h; }
    try { _TEE_POINTS = await (await fetch("./data/tee_points.json", { cache: "no-cache" })).json(); }
    catch (e) { _TEE_POINTS = {}; }
    return { HOLES, byGlobal };
  }

  // Rita reggade slag för ett hål ur rundloggen: bärnstensfärgad slagbana +
  // numrerade, precisionsfärgade punkter + ev. green-ring och pin. rec = hålets
  // rundlogg-post ({shots, green, pin}). layer rensas och ritas om.
  // opts (valfritt): { color: fn(shot)->css, selected: index }. Default = play-
  // beteendet (accColor på s.acc, ingen highlight) → karta.html:s 2-arg-anrop är
  // oförändrat. Redigera-sidan skickar egen färg (acc:null→grön) + valt slag.
  function drawShots(layer, rec, opts) {
    opts = opts || {};
    const colorFn = opts.color || (s => accColor(s.acc));
    const sel = (opts.selected == null) ? -1 : opts.selected;
    layer.clearLayers();
    if (!rec) return;
    const shots = (rec.shots || []).filter(s => s && s.lat != null && s.lon != null);
    if (!shots.length) return;
    const pts = shots.map(s => [s.lat, s.lon]);
    const path = [...pts];
    if (rec.green && rec.green.lat != null) path.push([rec.green.lat, rec.green.lon]);
    if (path.length > 1)
      L.polyline(path, { color: "#ffb703", weight: 3, opacity: .9 }).addTo(layer);
    shots.forEach((s, i) => {
      const isSel = i === sel;
      L.circleMarker([s.lat, s.lon], { radius: isSel ? 11 : 8, color: "#fff",
          weight: isSel ? 4 : 2, fillColor: colorFn(s), fillOpacity: 1 })
        .addTo(layer)
        .bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "shotlbl" });
    });
    if (rec.green && rec.green.lat != null)
      L.circleMarker([rec.green.lat, rec.green.lon], { radius: 5, color: "#fff",
        weight: 2, fillColor: "#7ee2a8", fillOpacity: 1 }).addTo(layer);
    if (rec.pin && rec.pin.lat != null)
      L.circleMarker([rec.pin.lat, rec.pin.lon], { radius: 5, color: "#fff",
        weight: 2, fillColor: "#e23b3b", fillOpacity: 1 }).addTo(layer);
  }

  // Rita hålets vita linje (start på vald tee) + pin. Sista segmentet byts ut mot
  // pinnen (slutpunkter < 8 m från pin tas bort) → rakt in i pricken utan dogleg-stubb.
  function drawHoleGeometry(layer, h) {
    if (h.line && h.line.length > 1) {
      const tee = teePoint(h);
      let path = tee ? [tee, ...h.line.slice(1)] : h.line.slice();
      if (h.pin) {
        while (path.length > 1 && _hav(path[path.length - 1], h.pin) < 8) path.pop();
        path = [...path, h.pin];
      }
      L.polyline(path, { color: "#fff", weight: 3, opacity: .9 }).addTo(layer);
    }
    L.circleMarker(h.pin, { radius: 4, color: "#fff", fillColor: "#fff", fillOpacity: 1, weight: 1 }).addTo(layer);
  }

  // Hålets riktning tee→green (grader, 0=N) + rotation så hålet pekar uppåt.
  function holeHeading(h) {
    const a = (h.line && h.line.length > 1) ? h.line[0]
      : (h.tees && h.tees.length) ? [h.tees[0].lat, h.tees[0].lon] : null;
    const b = h.green_center || h.pin;
    return (a && b) ? bearing(a, b) : null;
  }
  function orientToHole(map, h) {
    const hd = holeHeading(h);
    if (hd != null) map.setBearing(-hd);   // negativt = riktningen pekar uppåt
  }

  // Rama in hålet (tee→bortre green) i ett givet pixelband. Returnerar false om
  // tee/green saknas (anroparen faller till fitBounds). Samma ankrar som karta.html.
  function fitHole(map, h, band) {
    const teePt = (h.line && h.line.length) ? h.line[0]
      : (h.tees && h.tees.length) ? [h.tees[0].lat, h.tees[0].lon] : null;
    if (!teePt || !h.green || !h.green.length) return false;
    let farPt = h.green[0], farD = -1;
    for (const gp of h.green) { const d = _hav(teePt, gp); if (d > farD) { farD = d; farPt = gp; } }
    return fitBand(map, teePt, farPt, band);
  }

  return { createMap, addOrthophoto, fitBand, fitHole,
    rad: _rad, hav: _hav, bearing, accColor, holeHeading, orientToHole,
    teePoint, teeIsApprox, loadCourse, drawShots, drawHoleGeometry };
})();
