"use strict";
/* Redigera slag — fristående sida (bygger på MapCore, rör inte karta.html).
 *
 * Rättar slag i den osynkade rundan (localStorage sg-rundlogg-v1) INNAN den
 * synkas till analysen: flytta, radera (+ omnumrering) och lägg till (infoga +
 * omnumrering) slagpositioner. Interaktionsgrammatik: "välj i remsan, agera på
 * kartan" — kartan är positionsytan (tap-to-place), remsan är sekvens-kontrollern.
 *
 * Handsatt/flyttad punkt får {acc:null, manual:true, manual_kind}. På kartan
 * ritas den IDENTISKT med ett välloggat GPS-slag (colorForShot: acc:null → grön).
 */

const KEY = "sg-rundlogg-v1";
let map, layers, shotLayer;
let HOLES = [], byGlobal = {}, ROUND = [];
let hi = 0;                 // 0-baserat index i ROUND (spelarens hål = hi+1)
let sel = null;            // {type:"shot",i} | {type:"gap",i} | {type:"adj"} | null

// Tröskel för "glömt tee-slag": speglar SYNTH_MIN_M i src/course/lie.py (40.0 m).
// HÅLL I SYNK med PC-sidan (synth_tee_origin) om värdet ändras där.
const SYNTH_MIN_M = 40;

// ---- localStorage-modell (samma schema som Logga slag/karta skriver) ----
function loadLog() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
}
function keyN() { return String(hi + 1); }
function currentRec() { const l = loadLog(); return l && l.holes ? l.holes[keyN()] : null; }
// Mutera aktuellt håls post; skapar log/hål vid behov. fn kan returnera false → avbryt.
function mutate(fn) {
  let log = loadLog();
  if (!log) log = { startedAt: new Date().toISOString(), endedAt: null, current: hi + 1, holes: {} };
  if (!log.holes) log.holes = {};
  const k = keyN();
  if (!log.holes[k]) log.holes[k] = { shots: [], green: null, pin: null, putts: 0, pen: 0, adj: 0 };
  if (fn(log.holes[k], log) === false) return false;
  try { localStorage.setItem(KEY, JSON.stringify(log)); } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(15);
  return true;
}

// ---- rendering ----
// Handsatt slag (acc:null) ritas som ett säkert GPS-slag (grön) → oskiljbart.
function colorForShot(s) { return s.acc == null ? "#7ee2a8" : MapCore.accColor(s.acc); }

function drawShotsEdit() {
  MapCore.drawShots(shotLayer, currentRec(),
    { color: colorForShot, selected: (sel && sel.type === "shot") ? sel.i : null });
}

function drawHole() {
  const h = ROUND[hi];
  if (!h) return;
  layers.clearLayers();
  MapCore.drawHoleGeometry(layers, h);
  drawShotsEdit();
  MapCore.orientToHole(map, h);
  renderNotices();   // före frameHole: notis-höjden krymper #top → inramningsbandet
  frameHole();
  renderAll();
}

function frameHole() {
  const h = ROUND[hi];
  if (!h) return;
  const mapRect = document.getElementById("map").getBoundingClientRect();
  const topY = document.getElementById("top").getBoundingClientRect().bottom - mapRect.top + 8;
  const botY = document.getElementById("bottom").getBoundingClientRect().top - mapRect.top - 8;
  const framed = MapCore.fitHole(map, h, { topY, botY, width: mapRect.width, height: mapRect.height });
  if (!framed) {
    const pts = [...(h.green || []), h.pin, ...(h.tees || []).map(t => [t.lat, t.lon]), ...(h.line || [])].filter(Boolean);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15));
  }
  requestAnimationFrame(() => { if (map) map.invalidateSize({ pan: false }); });
}

function renderHeader() {
  const h = ROUND[hi];
  document.getElementById("hname").innerHTML =
    `Hål ${hi + 1} <small>Par ${h && h.par != null ? h.par : "–"}</small>`;
  document.getElementById("prev").disabled = hi <= 0;
  document.getElementById("next").disabled = hi >= ROUND.length - 1;
}

function renderScore() {
  const rec = currentRec();
  const shots = rec ? (rec.shots || []).length : 0;
  const adj = rec ? (rec.adj || 0) : 0;
  const total = shots + adj;
  document.getElementById("scoreline").textContent = adj
    ? `${shots} loggade ${adj > 0 ? "+" : "−"} ${Math.abs(adj)} justering = ${total} slag`
    : `${shots} slag`;
}

function renderStrip() {
  const rec = currentRec();
  const shots = rec ? (rec.shots || []) : [];
  const adj = rec ? (rec.adj || 0) : 0;
  const el = document.getElementById("strip");
  el.innerHTML = "";
  const gap = (i) => {
    const g = document.createElement("button");
    g.className = "gap" + (sel && sel.type === "gap" && sel.i === i ? " sel" : "");
    g.textContent = "+";
    g.onclick = () => select({ type: "gap", i });
    el.appendChild(g);
  };
  const chip = (i) => {
    const c = document.createElement("button");
    c.className = "chip" + (sel && sel.type === "shot" && sel.i === i ? " sel" : "");
    c.textContent = String(i + 1);
    c.onclick = () => select({ type: "shot", i });
    el.appendChild(c);
  };
  gap(0);
  for (let i = 0; i < shots.length; i++) { chip(i); gap(i + 1); }
  for (let k = 0; k < adj; k++) {         // positiva justeringar som urskiljbara ~-chip
    const a = document.createElement("button");
    a.className = "adj" + (sel && sel.type === "adj" ? " sel" : "");
    a.textContent = "~";
    a.onclick = () => select({ type: "adj" });
    el.appendChild(a);
  }
  if (rec && rec.green && rec.green.lat != null) ctx("green", "green");
  if (rec && rec.pin && rec.pin.lat != null) ctx("pin", "pin");
  function ctx(cls, txt) {
    const s = document.createElement("span");
    s.className = "ctx " + cls; s.textContent = txt; el.appendChild(s);
  }
}

function renderActions() {
  const el = document.getElementById("actions");
  el.innerHTML = "";
  if (sel && sel.type === "shot") {
    const d = document.createElement("button");
    d.className = "delbtn";
    d.textContent = `🗑 Radera slag ${sel.i + 1}`;
    d.onclick = () => deleteShot(sel.i);
    el.appendChild(d);
  }
}

function renderHint() {
  const el = document.getElementById("hint");
  el.classList.remove("flash");
  if (!sel) el.textContent = "Välj ett slag (flytta) eller en lucka + (lägg till) — tryck sedan på kartan.";
  else if (sel.type === "shot") el.textContent = `Slag ${sel.i + 1} valt — tryck på kartan för att flytta det.`;
  else if (sel.type === "gap") el.textContent = `Lucka vald — tryck på kartan för att lägga till slag ${sel.i + 1}.`;
  else if (sel.type === "adj") el.textContent = "Justering vald — tryck på kartan för att göra den till en riktig punkt.";
}

// ---- advisory-notiser (Fas B) ----
// Speglar PC-sidans checkar (icke-blockerande): glömt tee-slag (synth_tee_origin,
// lie.py), putt utan green-position (index:s noGreen), rök-test (import_warnings,
// mobile_source.py ~221-225). Skannar HELA rundan; per-hål-notiser är tryckbara →
// hoppar till hålet. Trösklarna hålls i synk med PC (SYNTH_MIN_M ovan).
function computeNotices() {
  const log = loadLog();
  const holes = (log && log.holes) ? log.holes : {};
  const out = [];
  let totalPresses = 0, finishedAny = false;
  for (let r = 1; r <= ROUND.length; r++) {
    const rec = holes[String(r)];
    if (!rec) continue;
    const shots = (rec.shots || []).filter(s => s && s.lat != null && s.lon != null);
    totalPresses += shots.length;
    const green = !!(rec.green && rec.green.lat != null);
    if (green || rec.holedOut) finishedAny = true;

    // 1) Glömt tee-slag: första loggade slaget > SYNTH_MIN_M från NÄRMASTE tee-box
    //    (samma princip som synth_tee_origin; fallback till spelarens valda tee).
    if (shots.length) {
      const h = ROUND[r - 1];
      const boxes = (h && h.tees && h.tees.length)
        ? h.tees.map(t => [t.lat, t.lon])
        : (h ? [MapCore.teePoint(h)].filter(Boolean) : []);
      if (boxes.length) {
        const near = Math.min(...boxes.map(b => MapCore.hav([shots[0].lat, shots[0].lon], b)));
        if (near > SYNTH_MIN_M)
          out.push({ hole: r, text: `Hål ${r}: första slaget ${Math.round(near)} m från tee — glömt tee-slag?` });
      }
    }

    // 2) Putt utan green-position (samma villkor som index:s noGreen-banner).
    if ((rec.putts || 0) > 0 && !green)
      out.push({ hole: r, text: `Hål ${r}: puttar noterade men ingen green-position — inspelet kommer uteslutas ur analysen.` });
  }

  // 3) Rök-test (rund-nivå): ≤1 slag totalt eller inga avslutade hål.
  if (totalPresses <= 1 || !finishedAny)
    out.push({ hole: null, text: "Ser ut som ett rök-test (för få slag eller inga avslutade hål) — kontrollera innan du litar på analysen." });

  return out;
}

function renderNotices() {
  const el = document.getElementById("notices");
  el.innerHTML = "";
  for (const n of computeNotices()) {
    const node = document.createElement(n.hole != null ? "button" : "div");
    node.className = "notice";
    node.textContent = "⚠ " + n.text;
    if (n.hole != null) node.onclick = () => goHole(n.hole);
    el.appendChild(node);
  }
}

function renderAll() { renderHeader(); renderScore(); renderStrip(); renderActions(); renderHint(); }
// Efter en dataändring: rita om slag + remsa/score/åtgärder + notiser, behåll kartvyn,
// och pusha score till ev. live-match (add/radera/adj ändrar totalen).
function refresh() {
  drawShotsEdit(); renderScore(); renderStrip(); renderActions(); renderHint(); renderNotices();
  livePushScore(hi + 1);
}

function select(next) {
  sel = next;
  drawShotsEdit();
  renderStrip(); renderActions(); renderHint();
}
function flashHint(msg) {
  const el = document.getElementById("hint");
  el.textContent = msg; el.classList.add("flash");
  setTimeout(() => renderHint(), 1600);
}

// ---- operationer (tap-to-place på kartan) ----
function onTap(e) {
  if (!sel) { flashHint("Välj först ett slag eller en lucka i remsan."); return; }
  const ll = e.latlng;
  if (sel.type === "shot") moveShot(sel.i, ll);
  else if (sel.type === "gap") addShot(sel.i, ll);
  else if (sel.type === "adj") convertAdj(ll);
}

function moveShot(i, ll) {
  const ok = mutate(rec => {
    const s = rec.shots[i];
    if (!s) return false;
    s.lat = ll.lat; s.lon = ll.lng; s.acc = null; s.manual = true;
    s.manual_kind = s.manual_kind === "added" ? "added" : "moved";   // added förblir added
  });
  if (ok) refresh();
}

function addShot(i, ll) {
  mutate(rec => {
    rec.shots.splice(i, 0, { lat: ll.lat, lon: ll.lng, acc: null, manual: true,
      manual_kind: "added", ts: new Date().toISOString() });
  });
  sel = { type: "shot", i };   // markera det nya slaget
  refresh();
}

function convertAdj(ll) {
  const ok = mutate(rec => {
    if (!(rec.adj > 0)) return false;
    rec.adj -= 1;
    rec.shots.push({ lat: ll.lat, lon: ll.lng, acc: null, manual: true,
      manual_kind: "added", ts: new Date().toISOString() });
  });
  if (ok) { sel = { type: "shot", i: (currentRec().shots.length - 1) }; refresh(); }
}

function deleteShot(i) {
  const rec = currentRec();
  if (!rec || !rec.shots[i]) return;
  // spärr: totalen (shots + adj) får aldrig bli negativ
  if ((rec.shots.length - 1) + (rec.adj || 0) < 0) {
    flashHint("Kan inte radera — skulle ge negativ score."); return;
  }
  if (!confirm(`Radera slag ${i + 1}? Resten numreras om.`)) return;
  mutate(r => { r.shots.splice(i, 1); });
  sel = null;
  refresh();
}

// ---- live-push ----
// Pusha aktuellt håls score till ev. live-match — identiskt med karta.html:s
// livePushScoreFromMap så en redigering håller leaderboarden i synk (add/radera/
// adj-konvertering ändrar strokes = shots + adj). Läser gameId ur sg-live-v1 och
// anropar SGLive direkt (pushHoleScore self-init:ar via initLive). Hålnr = spelarens
// hål (rel 1–18), samma nyckel som index/karta. Fire-and-forget: fel/offline sväljs,
// scoren finns kvar lokalt och molnet hinner ikapp. SGLive saknas → tyst no-op.
function livePushScore(rel) {
  let live = null;
  try { live = JSON.parse(localStorage.getItem("sg-live-v1")); } catch (e) {}
  if (!live || !live.gameId || typeof SGLive === "undefined") return;
  const rec = currentRecFor(rel);
  const strokes = (rec && rec.shots ? rec.shots.length : 0) + (rec && rec.adj ? rec.adj : 0);
  const putts = rec && rec.putts ? rec.putts : 0;
  const pen = rec && rec.pen ? rec.pen : 0;
  try { SGLive.pushHoleScore(live.gameId, rel, { strokes, putts, pen }).catch(e => SGLive.liveWarn && SGLive.liveWarn("score", e)); }
  catch (e) {}
}
function currentRecFor(rel) {
  const l = loadLog();
  return l && l.holes ? l.holes[String(rel)] : null;
}

// ---- hål-navigering ----
function goHole(rel) {
  if (rel < 1 || rel > ROUND.length) return;
  livePushScore(hi + 1);   // pusha hålet man LÄMNAR (som karta.html goToHole)
  hi = rel - 1; sel = null;
  try { localStorage.setItem("sg_hole", String(rel)); } catch (e) {}
  const log = loadLog();
  if (log) { log.current = rel; try { localStorage.setItem(KEY, JSON.stringify(log)); } catch (e) {} }
  drawHole();
}

// ---- init ----
async function init() {
  map = MapCore.createMap("map");
  MapCore.addOrthophoto(map);
  layers = L.layerGroup().addTo(map);
  shotLayer = L.layerGroup().addTo(map);
  map.setView([55.618, 13.07], 15);
  map.on("click", onTap);
  document.getElementById("prev").onclick = () => goHole(hi);       // rel = (hi+1)-1
  document.getElementById("next").onclick = () => goHole(hi + 2);   // rel = (hi+1)+1

  try {
    const course = await MapCore.loadCourse();
    HOLES = course.HOLES; byGlobal = course.byGlobal;
  } catch (e) {
    document.getElementById("hname").textContent = "Kunde ej ladda bandata";
    return;
  }
  ROUND = SGRound.ROUND_SEQ[SGRound.roundName()].map(g => byGlobal[g]).filter(Boolean);
  if (!ROUND.length) { document.getElementById("hname").textContent = "Ingen runda vald"; return; }

  // hål: ?hole=N (spelarens 1–18) har företräde, annars aktuellt (sg_hole).
  const params = new URLSearchParams(location.search);
  let rel = parseInt(params.get("hole"), 10);
  if (!(rel >= 1 && rel <= ROUND.length)) rel = SGRound.migrateSgHole();
  if (!(rel >= 1 && rel <= ROUND.length)) rel = 1;
  hi = rel - 1;
  drawHole();
}
init();
