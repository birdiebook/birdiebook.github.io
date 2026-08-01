/* 3D-hålvyn — motorn (UPPGRADERING_3D §5).
 *
 * Bruten ur hal3d.html i U11: samma kod ska driva BÅDA ingångarna, den fristående
 * 3D-sidan och planeringsvyns 3D-vinkel (planvy.html). Att i stället kopiera
 * scenen till den nya sidan hade gett två motorer som glider isär — precis det
 * U11 finns för att stoppa.
 *
 * Två körlägen, och skillnaden är BARA vem som väljer hål:
 *   fristående  hal3d.html — modulen äger hålväljaren och laddar själv
 *   inbäddad    planvy.html sätter window.__VY_EMBED = true FÖRE importen och
 *               driver `laddaHal()` ur Vylage; ingen hålväljare, ingen autostart
 *
 * Allt annat (scenen, lägena, panelerna, U6/U9/U15/U16/U17/U18) är oförändrat —
 * DOM-id:na är desamma i båda sidorna och elementen slås upp med `el()` som
 * förut. Saknas ett element i värdsidan är lyssnaren tyst utebliven, inte ett
 * krasch (se `pa()` nedan).
 */
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { CameraController, screenOf } from './camctl.js';
import * as HP from './hojdprofil.js';

const el = id => document.getElementById(id);
const status = t => { const e = el('status'); if (e) e.textContent = t || ''; };
/* Hålremsans Δh/längd finns bara på den fristående sidan — planeringsvyn har
   den i sitt eget hålnamn. Utan den här grinden kastade loadHole på `null`
   FÖRE sitt try, och 3D-vinkeln blev stående på "laddar…" utan felmeddelande
   (hittat vid verifieringen 2026-08-01). Skriv aldrig rakt på ett element som
   bara en av värdsidorna har. */
const fakta = t => { const e = el('fakta'); if (e) e.textContent = t; };

/* Inbäddad i planeringsvyn? Då äger Vylage hålvalet och den här modulen håller
   sig till scenen: ingen hålväljare, ingen autoladdning. Flaggan läses EN gång,
   före allt annat — den får inte kunna ändras halvvägs genom en session. */
const EMBED = !!(typeof window !== 'undefined' && window.__VY_EMBED);

// ---------------------------------------------------------------- scenen ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Samma ljus-filter som 2D-kartan (CourseMap.MAP_FILTER) på canvasen så
// ortofoto-marken i 3D matchar 2D:s ljusare/friskare look (rå textur = mörk).
renderer.domElement.style.filter = "brightness(1.35) saturate(1.20) contrast(0.96)";
el('scen').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec3d8);           // dis-himmel
scene.fog = new THREE.Fog(0x9ec3d8, 600, 1600);

scene.add(new THREE.HemisphereLight(0xdfeaf2, 0x3a4a38, 0.9));
const sol = new THREE.DirectionalLight(0xfff2dd, 1.6);   // NV, som hillshaden
sol.position.set(-0.5, 0.8, -0.6);
scene.add(sol);

const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
// U1: kartgester i stället för orbit — ett finger panorerar, nyp zoomar, två
// fingrar roterar/tiltar. Tillstånd och klampning bor i camctl.js.
const controls = new CameraController(camera, renderer.domElement, {
  onUserInput: () => { if (fly) stopFly(); },
});

// ?dbg=1 — mätinstrumentet för UPPGRADERING_3D §2.4 (eftersläpning) och för
// scengraf-verifiering. Detta är INTE en sådan tillfällig felsökningskrok som
// CLAUDE.md säger ska bort före commit: den är gated på flaggan och är själva
// sättet vi mäter att overlays inte släpar. Den ska ligga kvar.
if (new URLSearchParams(location.search).get('dbg') === '1') {
  window.__hal3d = {
    ctl: controls, camera, scene, renderer,
    // Var SKA en världspunkt hamna på skärmen denna bildruta? Jämförs med var
    // en DOM-etikett faktiskt står; skillnaden är eftersläpningen i px.
    screenOf: w => screenOf(controls.state, w, camera.fov,
                            innerWidth / innerHeight, innerWidth, innerHeight),
    // U9: slag-lagrets tillstånd. Samma skäl som `hojd` nedan — lagret ritas i
    // scenen, så det verifieras i scengrafen och inte i en skärmdump.
    // U16: vindens tillstånd — hämtad, egen, och vad bågarna faktiskt räknar på.
    vind: () => ({ hamtad: vindHamtad, egen: vindEgen, nu: vindNu(),
                   alder: vindAlderText() }),
    // U17: justeringslagret. `tal` är precis vad panelen visar, och `namn` är
    // scengrafens etiketter — det är DÄR beviset ligger för att ett ändrat slag
    // ser ändrat ut och att rundan aldrig rörs (jämför Store.export() omkring).
    slagjust: () => ({
      lage, valt: valtSlag, just: slagJust,
      andrade: SlagJust.antalAndrade(slagJust),
      tal: valtSlag != null ? slagTal[valtSlag] : null,
      namn: shotObjs.map(o => o.name).filter(Boolean),
    }),
    // U16 steg 4: siktet. Både texten spelaren läser och punkten i scenen —
    // ett teckenfel syns bara om man kan jämföra ordet med var strecket ligger.
    sikt: () => {
      const m = siktObjs.find(o => o.name === 'sikt-mal');
      return { text: (document.querySelector('.siktrad') || {}).textContent || '',
               namn: siktObjs.map(o => o.name),
               mal: m ? { x: m.position.x, z: m.position.z } : null };
    },
    // U18: ombyggnadskön. Det här ÄR instrumentet för etappens krav (< 16 ms
    // per bildruta) — samma skäl som `screenOf` finns för §2.4: ett krav som
    // inte går att mäta blir en åsikt. `ko` säger vad som väntar, `byggNu`
    // kör kön synkront och returnerar millisekunderna. (Kroken behövs också
    // för att rAF inte tickar i en dold browser-panel, se CLAUDE.md.)
    ombygg: () => ({ ko: [..._ombyggKo.keys()], markindex: !!markIndex }),
    byggNu: () => {
      const t = performance.now();
      for (const n of OMBYGG_ORDNING) if (_ombyggKo.has(n)) _ombyggKo.get(n)();
      _ombyggKo.clear();
      return +(performance.now() - t).toFixed(2);
    },
    // Höjduppslaget, för jämförelsen mot raycasten (U18:s < 5 cm-krav).
    yAt: (x, z) => surfaceYAt(x, z, NaN),
    yRay: (x, z) => {
      if (!ground) return NaN;
      _lineRay.set(new THREE.Vector3(x, 1e4, z), _lineDown);
      const h = _lineRay.intersectObject(ground, true);
      return h.length ? h[0].point.y : NaN;
    },
    valj: i => valjSlag(i),
    slag: () => ({ kalla: shotKalla, visa: shotVisa, objekt: shotObjs.length,
                   antal: shotRec ? (shotRec.shots || []).length : null,
                   punkter: shotRec && meta && meta.ll2xz
                     ? (shotRec.shots || []).filter(s => s && s.lat != null)
                         .map(s => shotXZ(s.lat, s.lon).map(v => Math.round(v)))
                     : null }),
    // U6: höjdprofilens tillstånd + möjligheten att driva EN tick för hand.
    // rAF tickar INTE i en dold browser-panel (läxa i §10), så utan detta går
    // kopplingen profil ↔ 3D-markör inte att verifiera automatiskt: att vänta
    // på requestAnimationFrame hänger panelen i 30 s i stället för att ge en
    // bildruta. `tick` gör exakt vad rAF-ticken gör med markören, inget mer.
    hojd: {
      get s() { return hojdS; },
      set: s => setHojdS(s),
      tick: () => updateHojdMarker(),
      marker: () => hojdMarker,
    },
  };
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// Inbäddad ÄR plan-läget — planvy.html är den plan-ingång ?from=plan pekade på.
const fromPlan = EMBED || new URLSearchParams(location.search).get('from') === 'plan';

// -------------------------------------------------------- fly-through (PR4) ---
// Gated helt på ?from=plan (hård invariant: utan den flaggan körs INGET av detta).
// Kameran glider längs meta.line (samma georef som scenen), blicken mot nästa
// punkt på linjen. Avbryts av användarens första pekar-/hjul-interaktion.
let fly = null; // { pts, cum, total, t0, dur } | null
// Blickpunkten flygningen just nu använder. Kontrollern tar över DEN när
// flygningen avbryts — annars hoppar scenen tillbaka till sitt gamla tillstånd.
const flyTarget = new THREE.Vector3();

// Kamera-tunables för fly-through (justeras vid visuell finslip):
const FLY_HALF_W = 32;                 // m: halva bredden som alltid ska rymmas (fairway + marginal)
const FLY_PITCH  = 22 * Math.PI / 180; // kameravinkel ned mot marken (högre = brantare uppifrån)
const FLY_LEAD   = 0.08;               // blicken riktas en aning framför fokuspunkten (0..1 av banan)
const FLY_MIN_R  = 45;                 // m: minsta kamera-avstånd (aldrig löjligt nära ens på bred skärm)
const FLY_CLEAR_IN  = 14;              // m: träd närmare än så ger FULL sikt-klarning
const FLY_CLEAR_OUT = 32;              // m: bortom så ingen inverkan (mjuk toning där emellan)
const FLY_CLEAR_MARGIN = 8;            // m: kameran läggs så här mycket över kronan den behöver klara

// mjuk 0→1-ramp (Hermite) mellan två kanter — ger klarning utan pop när träd tonas in/ut
function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Punkterna i sanna meter med höjd skalad av överdriften (markytan, ingen ögonhöjd).
function flyGroundPts() { return meta.line.map(([x, y, z]) => new THREE.Vector3(x, y * exag, z)); }

// Trädkronornas topp i världskoordinater (fot y_mark följer överdriften, höjden är sann)
// — används för att lyfta kameran över träd som annars skymmer hålet (t.ex. bakom teen).
function flyTreeTops() {
  return (meta.trees || []).map(t => ({ x: t[0], z: t[2], top: t[1] * exag + (t[3] || 0) }));
}

// Kamerapose vid flyktfraktion u (0=tee, 1=green): höjd chase-kamera bakom+över
// fokuspunkten. Position OCH riktning tas ur en Catmull-Rom-spline (curve) i stället
// för de grova linjesegmenten → mjuk kamera även i doglegs (inget hack vid svängar).
// Avståndet räknas ur horisontell FOV så ±FLY_HALF_W i bredd ryms (anpassas till
// porträtt/liggande via camera.aspect). Kameran lyfts vid behov över närliggande träd.
function flyPose(curve, u, treeTops) {
  const L = curve.getPointAt(u);
  const fwd = curve.getTangentAt(u); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const fovV = camera.fov * Math.PI / 180;
  const fovH = 2 * Math.atan(camera.aspect * Math.tan(fovV / 2));
  const R = Math.max(FLY_MIN_R, FLY_HALF_W / Math.tan(fovH / 2));
  const pos = L.clone().addScaledVector(fwd, -R * Math.cos(FLY_PITCH));
  const baseY = L.y + R * Math.sin(FLY_PITCH);
  // sikt-klarning: lyft kameran mjukt över träd nära den — varje träds inverkan
  // tonas in/ut med avståndet (smoothstep) så höjden inte poppar när träd passeras.
  let need = baseY;
  for (const t of treeTops) {
    const dx = t.x - pos.x, dz = t.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= FLY_CLEAR_OUT) continue;
    const w = 1 - smoothstep(FLY_CLEAR_IN, FLY_CLEAR_OUT, dist);
    const cand = baseY + w * Math.max(0, (t.top + FLY_CLEAR_MARGIN) - baseY);
    if (cand > need) need = cand;
  }
  pos.y = need;
  const target = curve.getPointAt(Math.min(1, u + FLY_LEAD));
  return { pos, target };
}

function startFly(opt = {}) {
  // Automatstarten vid hålbyte är fortfarande grindad på ?from=plan (PR4:s
  // invariant). Verktygsradens knapp tvingar fram den — det är ett medvetet
  // val av användaren, inte ett automatiskt beteende.
  if ((!fromPlan && !opt.force) || !meta || !meta.line || meta.line.length < 2) return;
  // centripetal Catmull-Rom: mjuk kurva genom grovpunkterna utan översläng i svängar
  const curve = new THREE.CatmullRomCurve3(flyGroundPts(), false, 'centripetal');
  const total = curve.getLength() || 1;
  const dur = Math.min(16000, Math.max(6000, total * 60));
  const treeTops = flyTreeTops();
  fly = { curve, treeTops, t0: performance.now(), dur };
  const p = flyPose(curve, 0, treeTops);   // starta direkt i den höga tee→green-överblicken
  camera.position.copy(p.pos); camera.lookAt(p.target); flyTarget.copy(p.target);
  el('flyavbryt').style.display = 'block';
}

function stopFly() {
  if (!fly) return;
  fly = null;
  if (lage === 'flyover') setLage(null);
  // Ta över exakt där flygningen stod. Utan detta ritar nasta bildruta
  // kontrollerns gamla tillstand och bilden hoppar.
  controls.setFromEye(camera.position, flyTarget);
  el('flyavbryt').style.display = 'none';
}

function updateFly() {
  if (!fly) return;
  const raw = Math.min(1, (performance.now() - fly.t0) / fly.dur);
  const u = raw * raw * (3 - 2 * raw);   // smoothstep: mjuk start & stopp
  const p = flyPose(fly.curve, u, fly.treeTops);
  camera.position.copy(p.pos);
  camera.lookAt(p.target);
  flyTarget.copy(p.target);
  if (raw >= 1) { stopFly(); placeCamera(); }
}

// Avbryt med knappen. Första pekar-/hjulinteraktionen avbryter också, via
// kontrollerns onUserInput — kontrollern lämnas PÅ under flygningen just för
// att den ska kunna ta emot det greppet och överta posen sömlöst.
if (fromPlan) el('flyavbryt').addEventListener('click', stopFly);

// U4: verktygsraden. Flyover, Tee-vy och Höjd lever; Slaget lever sedan U17
// men är avstängd på hål utan loggade slag — en knapp som ser klickbar ut men
// inte gör något är sämre än en som ärligt visar varför den inte går att trycka.
el('vFlyover').addEventListener('click', () => {
  if (lage === 'flyover') { stopFly(); setLage(null); return; }
  setLage('flyover');
  startFly({ force: true });
});
el('vTeevy').addEventListener('click', () => {
  if (lage === 'teevy') { setLage(null); placeCamera(); return; }
  teeView();
});
// U6: Höjd visar profilpanelen + 3D-markören (se buildHojdMarker/
// updateHojdMarker nedan). Flyger till översiktsposen så hela hållinjen
// ryms i bild — precis den vy meta.line/profile beskriver.
el('vHojd').addEventListener('click', () => {
  if (lage === 'hojd') { setLage(null); return; }
  stopFly();
  const p = overviewPose();
  if (p) controls.flyToEye(p.eye, p.target, 700);
  setLage('hojd');
});

// EN tick: flygning → kameratillstånd → render. Allt som hör till marken ska
// skrivas här, före render, aldrig i en händelselyssnare (UPPGRADERING_3D §2).
function tick() {
  updateFly();
  if (!fly) controls.update();     // flygningen äger kameran medan den pågår
  updateHojdMarker();              // U6: markören härleds ur hojdS varje tick — aldrig i en lyssnare
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(tick);

// ------------------------------------------------------- hål-innehållet ---
// Marken (glb) ligger i sanna meter och y-skalas med överdriften. Träden är
// SANN höjd oavsett överdrift (samma grepp som PC-vyn): deras instans-
// matriser räknas om — bara markfoten (groundY) följer skalan.
const loader = new GLTFLoader();
let ground = null, treeParts = [], lineObj = null, markers = [], hojdMarker = null;
let wide = null;              // U15 vidvinkeln: terrängen bortom korridoren
let meta = null;
let exag = 3;

const CROWN_GREENS = [0x4a6741, 0x587644, 0x405c3a, 0x62804e];

function clearHole() {
  for (const o of [ground, wide, lineObj, hojdMarker, ...treeParts, ...markers,
                   ...shotObjs, ...legObjs]) {
    if (!o) continue;
    scene.remove(o);
    o.traverse?.(c => { c.geometry?.dispose(); c.material?.map?.dispose?.(); c.material?.dispose?.(); });
  }
  ground = null; wide = null; lineObj = null; treeParts = []; markers = []; hojdMarker = null;
  markIndex = null;                       // hör till hålet, inte till vyn
  shotObjs = []; shotRec = null; shotKalla = '';
  // U11: planens kedja hör till hålet. Värdsidan sätter den nya direkt efter
  // laddningen; tills dess ska ingen gammal kedja stå kvar på ny mark.
  legObjs = []; legLL = []; legGreen = null;
  // U17: justeringarna hör till slagen på DET hålet. Nytt hål = tomt bord —
  // en apex-faktor från hål 5 får inte följa med till hål 6.
  slagJust = SlagJust.tom(); valtSlag = null; slagTal = [];
}

// Träd byggs ur meta-JSON:ens kompakta format (per hole_gltf.py):
//   trees[i] = [x, y_mark, z, höjd, rx, ry, yaw°, kronbas_frac, widest_frac, r, g, b]
//   hulls[i] = {v: [[dx, h, dz]...], f: [i0,i1,i2,...]} | null
// Kronan är trädets VERKLIGA siluett (kronhölje ur laserpunkterna, steg 3)
// när hull finns — ett gemensamt mesh med vertexfärger (ortofotots ton,
// mörkare undertill). Träd utan hölje faller tillbaka på kon (widest_frac
// < 0.33, gran-lik) eller tillplattad sfär som InstancedMesh.
// Höjden är SANN oavsett överdrift; bara markfoten (y_mark) följer exag.
function buildTrees() {
  for (const o of treeParts) scene.remove(o);
  treeParts = [];
  const trees = (meta.trees || []).map(t => t.length >= 12 ? t
    : [t[0], t[1], t[2], t[3], t[4], t[4], 0, 0.45, 0.5, 74, 103, 65]);
  if (!trees.length) return;
  const hulls = meta.hulls || [];

  // --- kronhöljen → ett sammanslaget mesh ---
  const pos = [], colArr = [], idxArr = [];
  let vOff = 0;
  const coneIdx = [], sphIdx = [];
  trees.forEach((t, i) => {
    const hull = hulls[i];
    if (!hull) { (t[8] < 0.33 ? coneIdx : sphIdx).push(i); return; }
    const [x, gy, z, , , , , , , r, g, b] = t;
    const base = gy * exag;
    let hMin = Infinity, hMax = -Infinity;
    for (const v of hull.v) { if (v[1] < hMin) hMin = v[1]; if (v[1] > hMax) hMax = v[1]; }
    const span = Math.max(hMax - hMin, 0.5);
    const c = new THREE.Color();
    for (const [dx, hh, dz] of hull.v) {
      pos.push(x + dx, base + hh, z + dz);
      const k = 0.72 + 0.28 * (hh - hMin) / span;   // mörkare undersida
      // sRGB → linjärt arbetsfärgrum (annars urtvättade kronor)
      c.setRGB(r / 255 * k, g / 255 * k, b / 255 * k, THREE.SRGBColorSpace);
      colArr.push(c.r, c.g, c.b);
    }
    for (const fi of hull.f) idxArr.push(vOff + fi);
    vOff += hull.v.length;
  });
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();
    const hullMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      vertexColors: true }));
    scene.add(hullMesh);
    treeParts.push(hullMesh);
  }

  const trunkG = new THREE.CylinderGeometry(1, 1, 1, 6);
  const trunks = new THREE.InstancedMesh(
    trunkG, new THREE.MeshLambertMaterial({ color: 0x5c4a37 }), trees.length);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
        yAxis = new THREE.Vector3(0, 1, 0),
        p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();

  const makeCrowns = (geo, idx, coneY) => {
    if (!idx.length) return null;
    const mesh = new THREE.InstancedMesh(
      geo, new THREE.MeshLambertMaterial(), idx.length);
    idx.forEach((ti, slot) => {
      const [x, gy, z, h, rx, ry, yawDeg, baseFrac, , r, g, b] = trees[ti];
      const base = gy * exag;                 // markfoten följer överdriften
      const cb = baseFrac * h;                // kronbas (sann höjd)
      const depth = Math.max(h - cb, 0.4);
      // (E,N)->(x,-z) i vyn speglar horisontalplanet → rotera −yaw kring y
      q.setFromAxisAngle(yAxis, -yawDeg * Math.PI / 180);
      p.set(x, base + cb + depth / 2, z);
      s.set(rx, coneY ? depth : depth / 2, ry);   // kon: höjd; sfär: radie
      mesh.setMatrixAt(slot, m.compose(p, q, s));
      col.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      mesh.setColorAt(slot, col);
    });
    mesh.instanceColor.needsUpdate = true;
    return mesh;
  };
  const cones = makeCrowns(new THREE.ConeGeometry(1, 1, 7), coneIdx, true);
  const sph = makeCrowns(new THREE.SphereGeometry(1, 8, 6), sphIdx, false);

  const qi = new THREE.Quaternion();
  trees.forEach(([x, gy, z, h, , , , baseFrac], i) => {
    const base = gy * exag;
    const cb = Math.max(baseFrac * h, 0.3);
    const tr = Math.max(0.1, 0.05 * h);
    p.set(x, base + cb / 2, z); s.set(tr, cb, tr);
    trunks.setMatrixAt(i, m.compose(p, qi, s));
  });

  const parts = [trunks];
  if (cones) parts.push(cones);
  if (sph) parts.push(sph);
  parts.forEach(o => scene.add(o));
  treeParts.push(...parts);
}

let markIndex = null;      // U18: höjduppslag i stället för raycast (per hål)
const _lineRay = new THREE.Raycaster();
const _lineDown = new THREE.Vector3(0, -1, 0);
const LINE_OFFSET = 0.6;   // m ovanför markytan
const LINE_STEP = 4;       // m: densifiera linjen så den följer terrängen mellan grovpunkterna

/* U18: markytans y i (x, z).
 *
 * Detta VAR en nedåt-raycast mot hela markmeshen. Uppmätt 2026-08-01: 6,3 ms
 * per stråle som träffar, och lagren frågar 40–130 gånger per ombyggnad — det
 * var hela orsaken till att reglagen hackade (905 ms per input-event på banans
 * längsta hål). `Markhojd` svarar på samma fråga ur ett XZ-rutnät över
 * trianglarna: 0,0006 ms per uppslag.
 *
 * Indexet bär höjden UTAN överdrift, så ett ryck i överdriftsreglaget bara
 * byter faktorn här — ingen ombyggnad av indexet, ingen ny sampling.
 *
 * Raycasten finns kvar som fallback när indexet inte kunde byggas (modulen
 * saknas, marken laddad men tom). Den är långsam men den är rätt, och en vy som
 * ritar linjen i luften vore värre än en seg vy. */
function surfaceYAt(x, z, fallback) {
  if (markIndex) {
    const y = markIndex.hojd(x, z);
    return y === null ? fallback : y * exag;
  }
  if (!ground) return fallback;
  _lineRay.set(new THREE.Vector3(x, 1e4, z), _lineDown);
  const hit = _lineRay.intersectObject(ground, true);
  return hit.length ? hit[0].point.y : fallback;
}

/* Bygger höjdindexet ur marken vid överdrift 1 — en gång per hål.
   `scale.y` nollställs tillfälligt: då är världskoordinaterna oskalade och
   indexet kan multipliceras med vilken överdrift som helst efteråt. Att i
   stället dividera bort skalan hade antagit att inget led i kedjan har en
   y-förskjutning, och det antagandet vill jag inte bära. */
function byggMarkindex() {
  markIndex = null;
  if (!ground || typeof Markhojd === 'undefined') return;
  const forra = ground.scale.y;
  ground.scale.y = 1;
  ground.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const arr = [];
  ground.traverse(o => {
    const g = o.isMesh && o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    const pos = g.attributes.position, idx = g.index;
    const antal = idx ? idx.count : pos.count;
    for (let i = 0; i < antal; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      arr.push(v.x, v.y, v.z);
    }
  });
  ground.scale.y = forra;
  ground.updateMatrixWorld(true);
  markIndex = arr.length ? Markhojd.bygg(new Float32Array(arr)) : null;
}

/* U18: en ombyggnad per BILDRUTA, inte per event.
 *
 * Ett drag i ett reglage skickar ~60 `input` i sekunden. Utan grind körde varje
 * event en full ombyggnad, och eftersom en ombyggnad tog längre tid än en
 * bildruta hann kön aldrig i kapp — det var det som kändes som hack. Grinden
 * behåller det SENASTE jobbet per namn och kör dem i fast ordning på nästa
 * ruta: linjen först (marken), sedan slagen som ligger på den, sist siktet som
 * läser slagens tal.
 *
 * Namnet är nyckeln: två `buildShots` under samma ruta blir ETT bygge. */
const OMBYGG_ORDNING = ['trad', 'linje', 'planlegs', 'slag', 'sikte'];
const _ombyggKo = new Map();
let _ombyggRaf = 0;
function schemalagg(namn, fn) {
  _ombyggKo.set(namn, fn);
  if (_ombyggRaf) return;
  _ombyggRaf = requestAnimationFrame(() => {
    _ombyggRaf = 0;
    const jobb = OMBYGG_ORDNING.filter(n => _ombyggKo.has(n)).map(n => _ombyggKo.get(n));
    _ombyggKo.clear();
    for (const j of jobb) j();
  });
}
/* Vyns fyra ombyggnader, schemalagda. Anropa DESSA från allt som kan trigga
   upprepat (reglage, gester); de direkta funktionerna används vid hålbyte där
   ordningen måste vara synkron. */
const omTrad  = () => schemalagg('trad', buildTrees);
const omLinje = () => schemalagg('linje', buildLine);
const omSlag  = () => schemalagg('slag', buildShots);
const omSikte = () => schemalagg('sikte', ritaSikte);
const omPlanLegs = () => schemalagg('planlegs', ritaPlanLegs);   // U11

function buildLine() {
  // U18: rensa RIKTIGT. Utan dispose läckte ett drag 60 geometrier i sekunden —
  // scene.remove() tar bort noden men lämnar buffertarna på grafikkortet.
  if (lineObj) { scene.remove(lineObj); lineObj.geometry?.dispose(); lineObj.material?.dispose(); }
  markers.forEach(o => { scene.remove(o); o.geometry?.dispose(); o.material?.dispose(); });
  if (ground) ground.updateMatrixWorld(true);   // färsk world-matris (exag-skala) före raycast
  // Densifiera linjen horisontellt och lägg varje punkt på den VERKLIGA ytan + offset,
  // så den aldrig dyker under mark när överdriften buktar terrängen mellan grovpunkterna.
  const raw = meta.line;
  const pts = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const [ax, ay, az] = raw[i], [bx, by, bz] = raw[i + 1];
    const segLen = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(segLen / LINE_STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const fallback = (ay + (by - ay) * t) * exag;
      pts.push(new THREE.Vector3(x, surfaceYAt(x, z, fallback) + LINE_OFFSET, z));
    }
  }
  const [lx, ly, lz] = raw[raw.length - 1];
  pts.push(new THREE.Vector3(lx, surfaceYAt(lx, lz, ly * exag) + LINE_OFFSET, lz));
  lineObj = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
  scene.add(lineObj);
  markers = [[pts[0], 0x1d2e22], [pts[pts.length - 1], 0xd21f1f]].map(([pt, c]) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 8),
                             new THREE.MeshLambertMaterial({ color: c }));
    s.position.copy(pt);
    scene.add(s);
    return s;
  });
  omSikte();     // siktet ligger på samma mark — ny linje, nytt sikte (U18: köad)
}

// -------------------------------------------- U9: dina slag på hålet i 3D ---
// Numrering och färg är 2D:s: `MapCore.accColor` — SAMMA funktion som
// `MapCore.drawShots` anropar, inte kopierade hex-koder, så vyerna inte kan
// glida isär (princip 4: en sanning per siffra).
//
// Men FORMEN är PC-vyns, inte kartans. Kartan ritar en rak linje mellan två
// loggade punkter för att den bara har två dimensioner; i 3D finns höjdleden,
// och då är en båge det sanna svaret. Modellen är `Bollbana` — speglad ur
// rundor3d.js och låst av tests/js/test_bollbana.mjs, så telefonen och skärmen
// visar samma slag med samma båge.
const SHOT_GREEN = 0x7ee2a8;
const SHOT_PIN = 0xe23b3b;
let shotObjs = [], shotRec = null, shotVisa = true, shotKalla = '';

function nummerSprite(n, hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = hex; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.lineWidth = 5; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#0c2e22'; g.font = '700 34px -apple-system,Segoe UI,Roboto,sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(7, 7, 1);
  return s;
}

// Slagen ligger i lat/lon (Store) och måste in i hålets lokala ram: samma
// ll2xz-affin som allt annat, via hojdprofil.js där inversen redan bor.
function shotXZ(lat, lon) { return HP.latLonToXz(meta.ll2xz, lat, lon); }
const xzLL = (x, z) => HP.xzToLatLon(meta.ll2xz, x, z);

// ------------------------------------------------- U16: vinden i bågen ---
// Beslut 2026-08-01: vindlagret får kräva nät (princip 3 gäller inte det), men
// en vindsiffra får ALDRIG se färskare ut än den är — därför bär panelen alltid
// åldern, och utan nät står det att vinden saknas.
//
// Modellen är `Vind3D` (spegel av PC-vyns W1–W3, låst av test_vind3d.mjs).
// Längdeffekten delegeras dit den redan bor: PlayAs.windAlongShift.
let vindHamtad = null;    // {ms, dir, gust, ts} från nätet
let vindEgen = null;      // spelarens override {ms, dir, gust}
const vindNu = () => vindEgen || vindHamtad;

function vindAlderText() {
  if (!vindHamtad) return 'ingen vind hämtad';
  if (vindEgen) return 'egen vind';
  const min = Math.round((Date.now() - vindHamtad.ts) / 60000);
  return min < 1 ? 'hämtad nyss' : `hämtad för ${min} min sedan`;
}

const KOMPASS = ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSV','SV','VSV','V','VNV','NV','NNV'];
const kompass = d => KOMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];

function ritaVindPanel() {
  const v = vindNu();
  el('vindNu').textContent = v
    ? `${v.ms.toFixed(1)} m/s från ${kompass(v.dir)}${v.gust ? ` · by ${v.gust.toFixed(1)}` : ''}`
    : 'vind saknas';
  el('vindalder').textContent = vindAlderText();
  if (v) {
    el('vMs').value = v.ms; el('vGust').value = v.gust || 0; el('vDir').value = Math.round(v.dir / 10) * 10;
  }
  el('vMsV').textContent = `${(+el('vMs').value).toFixed(1)} m/s`;
  el('vGustV').textContent = `${(+el('vGust').value).toFixed(1)} m/s`;
  el('vDirV').textContent = kompass(+el('vDir').value);
  el('vindater').disabled = !vindHamtad || !vindEgen;
  // U18: siktet ritas INTE härifrån. Varje vindändring kör ändå buildShots,
  // som avslutar med ritaSikte — den här raden gjorde alltså om samma arbete
  // en gång till per event (dubbelarbete infört i U16 steg 4). De två fall som
  // rör vinden UTAN att röra slagen (panelen öppnas) schemalägger siktet själva.
}

async function hamtaVind() {
  vindHamtad = null;
  if (!meta || !meta.ll2xz || !meta.line) { ritaVindPanel(); return; }
  const mitt = meta.line[Math.floor(meta.line.length / 2)];
  const [lat, lon] = xzLL(mitt[0], mitt[2]);
  try {
    const w = await PlayAs.fetchWind(lat, lon);
    if (w) vindHamtad = { ms: w.ms, dir: w.dir, gust: w.gust, ts: Date.now() };
  } catch { /* utan nät: vindHamtad förblir null och panelen säger det */ }
  ritaVindPanel();
  buildShots();
}

/* Slagets relativa vind: bäringen tas ur ändpunkternas lat/lon (MapCore.bearing)
   och inte ur de lokala koordinaterna — ll2xz bär SWEREF:s gridnorr, som avviker
   ~1,6° från sant norr här, och vinden kommer i sanna grader. */
function slagVind(a, b, v) {
  if (!v || !v.ms) return null;
  const A = xzLL(a.x, a.z), B = xzLL(b.x, b.z);
  const rel = PlayAs.relWind(MapCore.bearing(A, B), v.ms, v.dir);
  return { ...rel, ms: v.ms, gust: v.gust };
}

// ------------------------------------ U17: justeringar som visningslager ---
// `slagJust` är hela justeringstillståndet (SlagJust, ren modul) och `valtSlag`
// vilket slag panelen står på. Ingenting av detta tar vägen till Store: rundan
// är loggad data, och ett skruvat apex får inte kunna bli facit (§5 U17).
// `slagTal` är det panelen visar — fylls i av buildShots i samma svep som
// bågarna ritas, så talen ALDRIG kan säga något annat än det som står i scenen.
let slagJust = SlagJust.tom();
let valtSlag = null;
let slagTal = [];

/* En ellips på marken vid NEDSLAGET b, orienterad efter slagriktningen a→b:
   halvaxeln `aCross` tvärs banan, `aAlong` längs den. Bruten ur W3:s
   byellips när U17 behövde rita en andra (spelarens antagna spridning) —
   två ellipser med samma form ska inte ha två ritvägar som kan glida isär. */
function ritaEllips(a, b, aCross, aAlong, farg, opacity, namn) {
  const langd = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const fx = (b.x - a.x) / langd, fz = (b.z - a.z) / langd;   // framåt
  const kurva = new THREE.EllipseCurve(0, 0, aCross, aAlong, 0, 2 * Math.PI);
  const pts = kurva.getPoints(48).map(p => {
    const x = b.x + fx * p.y + (-fz) * p.x;
    const z = b.z + fz * p.y + (fx) * p.x;
    return new THREE.Vector3(x, surfaceYAt(x, z, 0) + LINE_OFFSET, z);
  });
  const ring = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: farg, transparent: true, opacity }));
  ring.name = namn;
  scene.add(ring); shotObjs.push(ring);
  return ring;
}

function buildShots() {
  shotObjs.forEach(o => { scene.remove(o); o.geometry?.dispose?.();
    o.material?.map?.dispose?.(); o.material?.dispose?.(); });
  shotObjs = [];
  el('slaginfo').hidden = !(shotVisa && shotRec && shotKalla);
  el('slaginfo').textContent = shotKalla;
  if (!meta || !meta.ll2xz || !shotRec || !shotVisa) {
    // U17: finns inga bågar finns inget valt slag — annars kan panelen stå kvar
    // och visa tal för ett slag som inte längre är ritat.
    valtSlag = null; slagTal = []; ritaSlagPanel(); omSikte();
    return;
  }
  if (ground) ground.updateMatrixWorld(true);
  const punkter = (shotRec.shots || [])
    .filter(s => s && s.lat != null && s.lon != null)
    .map(s => { const [x, z] = shotXZ(s.lat, s.lon); return { x, z, acc: s.acc }; });
  if (!punkter.length) { valtSlag = null; slagTal = []; ritaSlagPanel(); omSikte(); return; }

  const bana = [...punkter];
  if (shotRec.green && shotRec.green.lat != null) {
    const [x, z] = shotXZ(shotRec.green.lat, shotRec.green.lon);
    bana.push({ x, z, acc: null });
  }
  // Ett rör per slag, längs slagets BÅGE — inte en linje på marken. Formen
  // kommer ur `Bollbana`, som är PC-vyns modell (rundor3d.js, C2) speglad hit
  // och låst av tests/js/test_bollbana.mjs: apex-platån ~25–29 m, apex förbi
  // mitten, brantare landning än utgång. Samma slag ska se likadant ut i
  // telefonen som på skärmen.
  //
  // Bågens höjd läggs på i SANNA meter ovanpå kordan mellan ändpunkterna, som
  // själva sitter på den överdrifts-skalade marken. Apex skalas alltså ALDRIG
  // med överdriften — samma princip som träden: en boll som gick 27 m upp gick
  // 27 m upp, hur mycket vi än överdriver terrängen.
  slagTal = [];
  for (let i = 0; i < bana.length - 1; i++) {
    const a = bana[i], b = bana[i + 1];
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    if (dist < 1) continue;
    const y0 = surfaceYAt(a.x, a.z, 0) + LINE_OFFSET;
    const y1 = surfaceYAt(b.x, b.z, 0) + LINE_OFFSET;
    const traj = Bollbana.shotTrajectory(dist);
    // U17: slagets egen vind/apex vinner över hålets — utan justering ÄR
    // effektiv() basen, så raden nedan är oförändrad semantik för orörda slag.
    // GP1: profilens spridning är UTGÅNGSLÄGET för slagets ellips. Den slås
    // upp per avstånd (`Spelprofil.spridning`) och skickas IN i SlagJust, som
    // därmed förblir ren. Saknas profil eller tabell blir svaret null och
    // ellipsen är av — samma läge som före GP1, men nu av brist på svar och
    // inte av princip.
    const eff = SlagJust.effektiv(
      { vind: vindNu(), spr: Spelprofil.spridning(Store.profile(), dist) },
      SlagJust.get(slagJust, i));
    // W1: along-vinden formar bågen. Ändpunkterna är MÄTTA och rörs aldrig —
    // medvind plattar, motvind ballongar, men bollen landade där den landade.
    const vind = slagVind(a, b, eff.vind);
    if (vind) traj.apex *= Vind3D.windApexFactor(vind.along, dist);
    traj.apex = Math.max(0.4, traj.apex * eff.apexFaktor);
    const arc = Bollbana.arcHeights(dist, traj);
    // W2: sidvinden. Bollen siktades uppvinds och drevs till nedslaget, så
    // flygvägen ligger UPPVINDS om kordan — noll i båda ändar, störst i mitten.
    const drift = vind ? Vind3D.crossDrift(vind.cross, traj.apex) : 0;
    let sido = [0, 0];
    if (drift && vind.side) {
      const langd = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const hoger = [-(b.z - a.z) / langd, (b.x - a.x) / langd];   // 90° medsols
      // uppvinds = MOT den sida vinden trycker
      sido = vind.side === 'H' ? [-hoger[0], -hoger[1]] : hoger;
    }
    const pts = arc.map((h, k) => {
      const t = k / (arc.length - 1);
      const off = drift * Vind3D.crossBowShape(t);
      return new THREE.Vector3(a.x + (b.x - a.x) * t + sido[0] * off,
                               y0 + (y1 - y0) * t + h,
                               a.z + (b.z - a.z) * t + sido[1] * off);
    });
    // W3: byigheten gör nedslaget till en fördelning, inte en punkt.
    let gustE = null;
    if (vind && vind.gust) {
      const e = Vind3D.gustEllipse(vind.ms, vind.gust, vind.along, vind.cross,
                                   traj.apex, dist);
      if (e.gustDelta > 0.05 && (e.aCross > Vind3D.GPS_FLOOR_M + 0.2 ||
                                 e.aAlong > Vind3D.GPS_FLOOR_M + 0.2)) {
        gustE = e;
        ritaEllips(a, b, e.aCross, e.aAlong, 0x9fc4ae, 0.7, `slag-by-${i}`);
      }
    }
    // U17 + GP1: spridningsellipsen. Två olika saker med samma form, och de
    // får inte se likadana ut: profilens tal är en MODELL (spelprofilens hink),
    // spelarens egen siffra ett ANTAGANDE. Färgen och namnet i scengrafen
    // skiljer dem, och panelen skriver ut vilket det är.
    if (eff.sprCross > 0 || eff.sprAlong > 0)
      ritaEllips(a, b, eff.sprCross || 0.1, eff.sprAlong || 0.1,
                 eff.sprKalla === "egen" ? 0xffcf4d : 0x8fd6ff, 0.75,
                 `slag-spridning-${eff.sprKalla}-${i}`);
    // Färgen är START-punktens: bågen tillhör slaget som slogs DÄRIFRÅN, så
    // röret får samma färg som kulan det lämnar.
    // U17: ett ändrat slag ska SE ändrat ut (annars tror spelaren att den
    // skruvade bågen är den uppmätta), och det valda ska synas som valt. Det
    // första är en ärlighetsregel, det andra bara UI — därför olika medel:
    // genomskinlighet för "ändrad", självlysning för "vald".
    const vald = valtSlag === i;
    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(MapCore.accColor(a.acc)),
      transparent: eff.andrad, opacity: eff.andrad ? 0.55 : 1,
      emissive: new THREE.Color(vald ? 0x445511 : 0x000000) });
    const ror = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32,
                             vald ? 0.7 : 0.4, 5), mat);
    ror.name = `slag-ror-${i}${eff.andrad ? '-andrad' : ''}${vald ? '-vald' : ''}`;
    ror.userData.slagIdx = i;
    scene.add(ror); shotObjs.push(ror);
    // Panelens tal kommer HÄRIFRÅN, ur samma variabler som just ritade bågen.
    const vinklar = Bollbana.trajAngles(traj.apex, traj.fa, dist);
    slagTal[i] = { nr: i + 1, dist, apex: traj.apex, ...vinklar, vind, drift,
                   gustE, andrad: eff.andrad, eff, pts };
  }

  punkter.forEach((p, i) => {
    const y = surfaceYAt(p.x, p.z, 0);
    const hex = MapCore.accColor(p.acc);          // SAMMA färgfunktion som 2D
    const kula = new THREE.Mesh(new THREE.SphereGeometry(valtSlag === i ? 2.2 : 1.5, 12, 10),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(hex),
        emissive: new THREE.Color(valtSlag === i ? 0x445511 : 0x000000) }));
    kula.position.set(p.x, y + LINE_OFFSET, p.z);
    kula.name = `slag-kula-${i}`;
    kula.userData.slagIdx = i;    // kulan väljer slaget som slogs DÄRIFRÅN
    scene.add(kula); shotObjs.push(kula);
    const nr = nummerSprite(i + 1, hex);
    nr.position.set(p.x, y + 7, p.z);
    scene.add(nr); shotObjs.push(nr);
  });

  for (const [k, färg] of [['green', SHOT_GREEN], ['pin', SHOT_PIN]]) {
    const q = shotRec[k];
    if (!q || q.lat == null) continue;
    const [x, z] = shotXZ(q.lat, q.lon);
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 10),
      new THREE.MeshLambertMaterial({ color: färg }));
    m.position.set(x, surfaceYAt(x, z, 0) + LINE_OFFSET, z);
    scene.add(m); shotObjs.push(m);
  }
  ritaSlagPanel();     // U17: panelen läser slagTal som just fylldes i
  // U16 steg 4: siktet ärver apexen ur slagTal ovan — och U18:s kö garanterar
  // ordningen (linje → slag → sikte) och att det bara sker EN gång per ruta,
  // även när både linjen och slagen byggts om i samma bildruta.
  omSikte();
}

/* GP1: spridningstabellen (mobile/data/dispersion.json, genererad av
   tools/publish_mobile_dispersion.py). Laddas EN gång och är helt frivillig:
   saknas filen svarar `Spelprofil.spridning` null och ellipsen är av. En vy som
   kraschar för att en frivillig tabell fattas vore värre än en vy utan ellips. */
let spridningLaddad = null;
function laddaSpridning() {
  if (spridningLaddad) return spridningLaddad;
  spridningLaddad = fetch('./data/dispersion.json')
    .then(r => (r.ok ? r.json() : null))
    .then(t => { if (t) Spelprofil.sattSpridning(t); })
    .catch(() => { /* offline eller inte publicerad — ellipsen är bara av */ });
  return spridningLaddad;
}

// ------------------------------------------- U17: panelen SLAGET ------------
const fmtVind = t => {
  if (!t.vind) return 'ingen vind';
  const langs = t.vind.along >= 0 ? 'medvind' : 'motvind';
  const sido = t.vind.side ? ` · ${Math.abs(t.vind.cross).toFixed(1)} m/s från ${t.vind.side === 'H' ? 'höger' : 'vänster'}` : '';
  return `${langs} ${Math.abs(t.vind.along).toFixed(1)} m/s${sido}`;
};

function ritaSlagPanel() {
  const p = el('slagpanel');
  const t = valtSlag != null ? slagTal[valtSlag] : null;
  if (!t) { p.classList.add('dold'); return; }
  p.classList.remove('dold');
  el('slagnr').textContent = `Slag ${t.nr} · ${Math.round(t.dist)} m`;
  el('slagandrad').hidden = !t.andrad;
  el('slagtal').innerHTML =
    `apex <b>${t.apex.toFixed(1)} m</b> · ut <b>${t.launch.toFixed(0)}°</b> · ` +
    `ned <b>${t.desc.toFixed(0)}°</b><br>${fmtVind(t)}` +
    (t.drift ? ` · drift <b>${Math.abs(t.drift).toFixed(1)} m</b>` : '') +
    (t.gustE ? `<br>byellips ${t.gustE.aCross.toFixed(1)} × ${t.gustE.aAlong.toFixed(1)} m` : '');
  // Reglagen speglar det EFFEKTIVA läget: utan justering står de på modellens
  // och hålets värden, så en spelare som drar i dem börjar där bågen står.
  const e = t.eff;
  el('sApex').value = e.apexFaktor;
  el('sApexV').textContent = `×${e.apexFaktor.toFixed(2).replace('.', ',')}`;
  el('sMs').value = e.vind ? e.vind.ms : 0;
  el('sGust').value = e.vind ? (e.vind.gust || 0) : 0;
  el('sDir').value = e.vind ? Math.round(e.vind.dir / 10) * 10 : 0;
  el('sMsV').textContent = `${(+el('sMs').value).toFixed(1)} m/s`;
  el('sGustV').textContent = `${(+el('sGust').value).toFixed(1)} m/s`;
  el('sDirV').textContent = kompass(+el('sDir').value);
  el('sSprC').value = e.sprCross; el('sSprA').value = e.sprAlong;
  el('sSprCV').textContent = e.sprCross ? `${e.sprCross} m` : 'av';
  el('sSprAV').textContent = e.sprAlong ? `${e.sprAlong} m` : 'av';
  el('sprkalla').textContent =
    e.sprKalla === 'profil' ? 'ur din spelprofil'
    : e.sprKalla === 'egen' ? 'ditt eget antagande'
    : 'ingen profil än — fyll i den under Profil';
  el('sAter').disabled = !t.andrad;
  el('sAterAlla').disabled = SlagJust.antalAndrade(slagJust) === 0;
}

/* Alla reglage går samma väg: nytt tillstånd ur SlagJust → rita om scenen.
   Ingenting skrivs, ingenting sparas — därför räcker buildShots som "spara". */
function justera(patch) {
  if (valtSlag == null) return;
  slagJust = SlagJust.satt(slagJust, valtSlag, patch);
  omSlag();            // U18: reglagen drar 60 gånger i sekunden
}

el('sApex').addEventListener('input', () => justera({ apexFaktor: +el('sApex').value }));
el('sSprC').addEventListener('input', () => justera({ sprCross: +el('sSprC').value }));
el('sSprA').addEventListener('input', () => justera({ sprAlong: +el('sSprA').value }));
for (const id of ['sMs', 'sGust', 'sDir'])
  el(id).addEventListener('input', () => justera({
    vind: { ms: +el('sMs').value, gust: +el('sGust').value, dir: +el('sDir').value } }));

el('sAter').addEventListener('click', () => {
  if (valtSlag == null) return;
  slagJust = SlagJust.aterstall(slagJust, valtSlag);
  buildShots();
});
el('sAterAlla').addEventListener('click', () => {
  slagJust = SlagJust.aterstallAlla();
  buildShots();
});
el('slagstang').addEventListener('click', () => valjSlag(null));

// --------------------------------------- U16 steg 4: siktlinjen (W4) --------
// W1–W3 svarar på vart bollen tar vägen. Siktet svarar på spelarens fråga:
// vad måste JAG göra för att den ska landa där jag vill. Modellen är
// `Vind3D.aimAdvice` — PC-vyns W4 speglad och låst av test_vind3d.mjs, så
// telefonen och skärmen aldrig kan säga åt olika håll om samma slag.
//
// Siktet gäller ETT SLAG. Är ett slag valt (U17) gäller det slaget — med dess
// egen vind och dess justerade apex, alltså exakt den båge som står i scenen.
// Annars gäller hålets tee→pin-linje, men bara när den är kort nog att vara
// ett enda slag: en siktkorrigering för 480 m är inte fel i modellen, den är
// fel i FRÅGAN — ingen spelar hålet i ett slag, så talet skulle beskriva ett
// slag som aldrig slås.
const SIKT_ETT_SLAG_M = 280;   // längre hållinje ⇒ siktet kräver ett valt slag
const SIKT_MIN_M = 0.5;        // under en halvmeter är korrigeringen brus
const SIKT_FARG = 0x6fc9ff;
let siktObjs = [];

/* Vad siktet räknar på: start, mål, vind och apex. Apexen tas ur `slagTal` när
   ett slag är valt — samma tal som ritade bågen, inte en omräkning som kan
   glida ifrån den. */
function siktUnderlag() {
  if (valtSlag != null && slagTal[valtSlag] && slagTal[valtSlag].pts) {
    const t = slagTal[valtSlag], p = t.pts, sist = p[p.length - 1];
    return { a: { x: p[0].x, z: p[0].z }, b: { x: sist.x, z: sist.z },
             v: t.eff.vind, apex: t.apex, vad: `Slag ${t.nr}` };
  }
  if (!meta || !meta.line || meta.line.length < 2) return null;
  const f = meta.line[0], s = meta.line[meta.line.length - 1];
  return { a: { x: f[0], z: f[2] }, b: { x: s[0], z: s[2] },
           v: vindNu(), apex: null, vad: 'Hållinjen' };
}

/* Siktet skrivs i BÅDA panelerna: vindpanelen och slagpanelen delar
   bottenplats och visas aldrig samtidigt, så en enda rad hade varit osynlig i
   precis det läge där siktet betyder mest (ett valt slag). */
function siktText(html) {
  document.querySelectorAll('.siktrad').forEach(d => { d.innerHTML = html; });
}

function ritaSikte() {
  siktObjs.forEach(o => { scene.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.(); });
  siktObjs = [];
  const u = siktUnderlag();
  if (!u) { siktText(''); return; }
  // Två olika sanningar som inte får slås ihop: att vi INTE VET vad det blåser
  // är något annat än att det är vindstilla. Den första är en lucka i datan,
  // den andra ett svar på frågan.
  if (!u.v) { siktText('Ingen vind hämtad — inget sikte att visa.'); return; }
  if (!u.v.ms) { siktText('Vindstilla — ingen korrigering behövs.'); return; }
  const dist = Math.hypot(u.b.x - u.a.x, u.b.z - u.a.z);
  if (dist < 1) { siktText(''); return; }
  if (valtSlag == null && dist > SIKT_ETT_SLAG_M) {
    siktText(`Hållinjen är ${Math.round(dist)} m — längre än ett slag. ` +
             'Välj ett slag för att se siktet.');
    return;
  }
  const vind = slagVind(u.a, u.b, u.v);
  if (!vind) { siktText(''); return; }
  // Utan valt slag finns ingen ritad båge att ärva apexen ur — då är det
  // modellens egen apex för längden, med vindens W1-faktor på, precis som
  // buildShots räknar den.
  let apex = u.apex;
  if (apex == null)
    apex = Bollbana.shotTrajectory(dist).apex * Vind3D.windApexFactor(vind.along, dist);
  const adv = Vind3D.aimAdvice({ along_ms: vind.along, cross_ms: vind.cross, side: vind.side },
                               apex, dist);
  const across = Math.abs(adv.dAcross), along = Math.abs(adv.dAlong);
  if (across < SIKT_MIN_M && along < SIKT_MIN_M) {
    siktText(`${u.vad}: vinden kräver ingen korrigering att tala om.`);
    return;
  }
  // Uppvinds = MOT den sida vinden trycker. Samma härledning som bågens W2 —
  // om de två någonsin pekar åt olika håll är en av dem fel.
  const langd = Math.hypot(u.b.x - u.a.x, u.b.z - u.a.z);
  const hoger = [-(u.b.z - u.a.z) / langd, (u.b.x - u.a.x) / langd];
  const upp = vind.side === 'H' ? [-hoger[0], -hoger[1]]
            : vind.side === 'V' ? hoger : [0, 0];
  const mx = u.b.x + upp[0] * adv.dAcross, mz = u.b.z + upp[1] * adv.dAcross;

  // Streckad, så den aldrig förväxlas med hållinjen: den vita linjen är var
  // hålet går, den streckade är vart du ska sikta. Följer terrängen med samma
  // densifiering som buildLine, annars skär den genom kullar.
  const pts = [];
  const n = Math.max(2, Math.round(dist / LINE_STEP));
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = u.a.x + (mx - u.a.x) * t, z = u.a.z + (mz - u.a.z) * t;
    pts.push(new THREE.Vector3(x, surfaceYAt(x, z, 0) + LINE_OFFSET * 2, z));
  }
  const linje = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: SIKT_FARG, dashSize: 4, gapSize: 3,
                                   transparent: true, opacity: 0.95 }));
  linje.computeLineDistances();
  linje.name = 'sikt-linje';
  scene.add(linje); siktObjs.push(linje);

  const mal = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 10),
    new THREE.MeshLambertMaterial({ color: SIKT_FARG, emissive: 0x123a4d }));
  mal.position.set(mx, surfaceYAt(mx, mz, 0) + LINE_OFFSET * 2, mz);
  mal.name = 'sikt-mal';
  scene.add(mal); siktObjs.push(mal);

  // Metrarna OCH orden. Talen är för den som vill räkna, orden för den som står
  // på teen — och orden kommer ur samma `aimAdvice`, inte ur en egen if-sats.
  const delar = [];
  if (across >= SIKT_MIN_M && adv.lateralSide)
    delar.push(`sikta <b>${across.toFixed(1)} m ${adv.lateralSide}</b>`);
  if (along >= SIKT_MIN_M && adv.distWord)
    delar.push(`spela <b>${along.toFixed(1)} m ${adv.distWord}</b>`);
  siktText(`${u.vad} · ${Math.round(dist)} m: ${delar.join(' · ')}`);
}

/* Val och avmarkering. Samma slag igen = av — samma "andra trycket stänger"
   som verktygsradens lägen (U4). */
/* Vilket slag ligger under fingret? INTE en raycast mot röret: bågen är 0,4 m
   tjock och kan stå 400 m bort, alltså under en pixel bred — en raycast mot den
   kräver pixelprecision av en tumme. Vi mäter i stället avståndet PÅ SKÄRMEN
   till bågens punkter och tar närmaste inom en tumbredd. Samma tal (44 px) som
   en normal träffyta i appen. Ingen träff = avmarkering. */
const TAP_PX = 44;
const _proj = new THREE.Vector3();

function slagVidSkarm(px, py) {
  camera.updateMatrixWorld();
  let bast = null, bastD = TAP_PX;
  slagTal.forEach((t, i) => {
    if (!t || !t.pts) return;
    for (const p of t.pts) {
      _proj.copy(p).project(camera);
      if (_proj.z > 1) continue;                       // bakom kameran
      const d = Math.hypot((_proj.x + 1) / 2 * innerWidth - px,
                           (-_proj.y + 1) / 2 * innerHeight - py);
      if (d < bastD) { bastD = d; bast = i; }
    }
  });
  return bast;
}

function valjSlag(i) {
  valtSlag = (i === valtSlag) ? null : i;
  buildShots();
}

/* Vilken rundas slag? Aktiv runda först — det är vad 2D-kartan visar. Har den
   inget på hålet tas den SENASTE rundan i telefonen som har det, och då står
   datumet i vyn: att visa en gammal rundas slag utan att säga vilken vore
   samma fel som en cachad vindsiffra som ser färsk ut (§5c-familjen).
   Utan loggade slag alls står knappen avstängd med angiven anledning. */
async function hittaSlag() {
  shotRec = null; shotKalla = '';
  const knapp = el('vSlag');
  knapp.disabled = true;
  knapp.title = 'Inga loggade slag på det här hålet';
  // U17 delar grind med U9: utan loggade slag finns inget att skruva på.
  el('vSlaget').disabled = true;
  el('vSlaget').title = 'Inga loggade slag på det här hålet';
  if (!meta || typeof Store === 'undefined' || typeof SGRound === 'undefined') return;
  await Store.ready();          // rundorna hydreras ur IndexedDB först
  await laddaSpridning();       // GP1: profilens ellips (tyst om filen saknas)
  const bas = SGRound.GLOBAL_BASE || {};
  if (!(meta.loop in bas)) return;
  const rel = SGRound.globalToRel(bas[meta.loop] + meta.hole);
  if (!rel) return;
  const harSlag = r => r && (r.shots || []).some(s => s && s.lat != null);
  const aktiv = Store.holeIn(Store.active(), rel);
  if (harSlag(aktiv)) {
    shotRec = aktiv; shotKalla = 'denna runda';
  } else {
    for (const rad of await Store.list({ limit: 12 })) {
      if (Store.activeId() && rad.id === Store.activeId()) continue;
      const rec = Store.holeIn(await Store.get(rad.id), rel);
      if (harSlag(rec)) {
        shotRec = rec;
        shotKalla = String(rad.startedAt || '').slice(5, 10).replace('-', '/');
        break;
      }
    }
  }
  if (!shotRec) return;
  const n = (shotRec.shots || []).filter(s => s && s.lat != null).length;
  knapp.disabled = false;
  knapp.title = `${n} loggade slag (${shotKalla})`;
  knapp.setAttribute('aria-pressed', String(shotVisa));
  el('vSlaget').disabled = false;
  el('vSlaget').title = 'Välj ett slag och ändra apex, vind och spridning';
  shotKalla = `${n} slag · ${shotKalla}`;
}

// U17: Slaget-läget. Knappen slår bara PÅ valbarheten — panelen öppnas först
// när ett slag är valt, för en tom panel med sex reglage som inte gör något
// vore precis den avstängda-knapp-lögnen U4 ville bort ifrån.
el('vSlaget').addEventListener('click', () => {
  if (lage === 'slaget') { setLage(null); return; }
  if (!shotVisa) {          // slagen måste synas för att kunna väljas
    shotVisa = true;
    el('vSlag').setAttribute('aria-pressed', 'true');
    buildShots();
  }
  setLage('slaget');
  status('tryck på ett slag för att ändra det');
  setTimeout(() => { if (lage === 'slaget' && valtSlag === null) status(''); }, 2600);
});

el('vSlag').addEventListener('click', () => {
  shotVisa = !shotVisa;
  el('vSlag').setAttribute('aria-pressed', String(shotVisa));
  buildShots();
});

el('vVind').addEventListener('click', () => {
  const p = el('vindpanel'), oppen = p.classList.toggle('dold');
  el('vVind').setAttribute('aria-pressed', String(!oppen));
  if (!oppen) { ritaVindPanel(); omSikte(); }
});

for (const id of ['vMs', 'vGust', 'vDir'])
  el(id).addEventListener('input', () => {
    // Spelarens egen vind ersätter den hämtade tills hen återställer. Panelen
    // säger "egen vind" så ingen tror att siffran kommer från nätet.
    vindEgen = { ms: +el('vMs').value, gust: +el('vGust').value, dir: +el('vDir').value };
    ritaVindPanel();     // ren DOM, billig — får gå direkt så talen följer fingret
    omSlag();            // scenen kostar — en ombyggnad per bildruta (U18)
  });

el('vindater').addEventListener('click', () => {
  vindEgen = null;
  ritaVindPanel();
  omSlag();
});

function applyExag(forra) {
  if (!meta) return;
  // Skalningen och kameran är BILLIGA och måste följa fingret direkt — det är
  // de som gör att reglaget känns kopplat till bilden. Ombyggnaderna av linje,
  // träd och slag är dyra och schemaläggs till nästa bildruta (U18).
  if (ground) ground.scale.y = exag;
  if (wide) wide.scale.y = exag;      // kjolen följer marken, annars glider den
  omTrad();
  omLinje();
  omSlag();          // slagen ligger på marken → måste räknas om med den
  omPlanLegs();      // U11: och planens kedja ligger på samma mark
  if (!forra || forra === exag) return;
  // Marken flyttar sig lodrätt när överdriften ändras. Gör inte kameran samma
  // resa hamnar den under terrängen (eller svävande högt över den) utan att
  // användaren rört kameran. Höjderna i scenen är tee-relativa, så teen står
  // still — men allt annat rör sig, och ju längre från teen desto mer.
  //
  // TVÅ FALL, och de kräver olika svar:
  //
  // Tee-vyn är NITAD vid en plats: ögat står på teen, blicken på green. Den
  // måste räknas om ur den nya marken. Att i stället translatera hela riggen
  // stelt flyttar ögat med GREENS höjdändring — och eftersom teen ligger på 0
  // oavsett överdrift hamnar kameran då under marken (uppmätt: −0,5 m vid
  // överdrift 1).
  //
  // Den fria vyn är inte nitad någonstans. Där är stel translation rätt: ser
  // man på en punkt och marken under den stiger, ska kameran stiga lika mycket
  // och behålla samma vy av punkten.
  if (lage === 'teevy') {
    const p = teeViewPose();
    if (p) controls.setFromEye(p.eye, p.target);   // direkt, inte animerat: användaren drar i reglaget
  } else {
    controls.scaleHeights(exag / forra);
  }
  // En pågående flygning bär sin bana och sina trädtoppar från STARTEN. De
  // måste byggas om mot den nya marken, annars flyger kameran längs den gamla
  // terrängen. Framdriften (t0/dur) behålls så flygningen inte hoppar.
  if (fly) {
    fly.curve = new THREE.CatmullRomCurve3(flyGroundPts(), false, 'centripetal');
    fly.treeTops = flyTreeTops();
  }
}

// ----------------------------------------------------------- U5 tee-vy ---
// Kameran star PA teen i ogonhojd och tittar langs hallinjen. Marken ar
// y-skalad med overdriften, sa ogat maste folja den skalan for att sta pa
// gruset och inte sväva - men 1,7 m ar en riktig kroppslangd och skalas inte.
const EYE_H = 1.7;

function teeViewPose() {
  if (!meta || !meta.line || meta.line.length < 2) return null;
  const a = meta.line[0], b = meta.line[meta.line.length - 1];
  return {
    eye: { x: a[0], y: a[1] * exag + EYE_H, z: a[2] },
    target: { x: b[0], y: b[1] * exag, z: b[2] },
  };
}

// Aktivt lage: 'flyover' | 'teevy' | 'hojd' | null. Andra trycket pa en aktiv
// knapp gar tillbaka till fri vy (U4).
let lage = null;

function setLage(nytt) {
  lage = nytt;
  for (const [id, namn] of [['vFlyover', 'flyover'], ['vTeevy', 'teevy'],
                            ['vHojd', 'hojd'], ['vSlaget', 'slaget']])
    el(id).setAttribute('aria-pressed', String(lage === namn));
  // U17: lämnar man slag-läget lämnar man också det valda slaget (panelen
  // stängs av ritaSlagPanel när inget är valt). Justeringarna ligger kvar —
  // de hör till hålet, inte till läget, och rensas när hålet byts.
  if (lage !== 'slaget' && valtSlag !== null) valjSlag(null);
  if (lage === 'slaget') {
    el('vindpanel').classList.add('dold');       // de delar bottenplats
    el('vVind').setAttribute('aria-pressed', 'false');
  }
  // U6: panelen och 3D-markören visas bara i höjd-läget — enda stället som
  // styr synligheten, så de två aldrig kan hamna ur synk med knappen.
  const visarHojd = lage === 'hojd';
  el('hojdpanel').classList.toggle('dold', !visarHojd);
  if (hojdMarker) hojdMarker.visible = visarHojd;
  // U11: läget är en del av vy-tillståndet, och tillståndet har EN ägare. Utan
  // den här raden kunde verktygsraden stå på Höjd medan Vylage sa "inget läge" —
  // exakt den sortens andra kopia U11 finns för att ta bort.
  if (lagePa) lagePa(lage);
}

function teeView() {
  const p = teeViewPose();
  if (!p) return;
  stopFly();
  controls.flyToEye(p.eye, p.target, 800);
  setLage('teevy');
}

// Overblicksposen: lågt bakom teen, blick mot hålets mitt (som PC-vyn).
// Utbruten ur placeCamera() så samma pose kan användas ANIMERAT när U6:s
// Höjd-läge slås på (hela hållinjen + profilens markör ska rymmas i bild).
function overviewPose() {
  if (!meta || !meta.line || meta.line.length < 2) return null;
  const a = meta.line[0], b = meta.line[meta.line.length - 1];
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const L = Math.hypot(dx, dz) || 1;
  const ux = dx / L, uz = dz / L;
  const eye = { x: a[0] - ux * 0.45 * L, y: a[1] * exag + 4 + 0.18 * L,
                z: a[2] - uz * 0.45 * L };
  const target = { x: (a[0] + b[0]) / 2, y: ((a[1] + b[1]) / 2) * exag,
                   z: (a[2] + b[2]) / 2 };
  return { eye, target };
}

function placeCamera() {
  const p = overviewPose();
  if (!p) return;
  // Samma pose som förut, men uttryckt i kontrollerns fyra tal — så att en
  // efterföljande gest utgår från den och inte från något annat.
  controls.setFromEye(p.eye, p.target);
}

// ------------------------------------------------- U6 höjdprofil / markör ---
// Ritregeln (UPPGRADERING_3D §2): markören är ETT OBJEKT I SCENGRAFEN med
// världskoordinater, härlett ur skalären `hojdS` (meter längs meta.line från
// tee) i SAMMA rAF-tick som renderar (se renderer.setAnimationLoop ovan) —
// aldrig satt direkt av en pekar-/draghändelse. Kopplingen mellan profilen
// och 3D går båda vägarna: dra i #hojdsvg sätter hojdS (renderHojd), och ett
// tryck på hållinjen i 3D projicerar tillbaka till hojdS (se pekarlyssnaren
// på renderer.domElement nedan) — "profilen och hålet är samma sak sedd
// från två håll" (FORSLAG F4).
const HOJD_MARK_COLOR = 0xffcf4d;
let hojdS = 0;
// Offline (§1 princip 3): ingen vindkälla i hal3d.html. "Spelar som" bär då
// bara höjden (HP.playsAsAt faller tillbaka på geometriskt avstånd +
// PlayAs.slopeEffect) — null här, aldrig en påhittad vind.
const hojdWind = null;
let hojdYNorm = null;   // {sTot, yMin, padY, span} — satt av buildHojdPanel per hål

function buildHojdMarker() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 5, 8),
    new THREE.MeshBasicMaterial({ color: HOJD_MARK_COLOR }));
  pole.position.y = 2.5;
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 12, 8),
    new THREE.MeshBasicMaterial({ color: HOJD_MARK_COLOR }));
  ball.position.y = 5.3;
  g.add(pole, ball);
  g.visible = lage === 'hojd';
  scene.add(g);
  hojdMarker = g;
}

// Anropas EN gång per bildruta, före render (aldrig av en lyssnare) — se
// UPPGRADERING_3D §2.2. exag rör bara scen-y (g.position.y); den VISADE
// höjden i panelen kommer separat ur HP.yAtS (sann, oskalad).
function updateHojdMarker() {
  if (!hojdMarker || !meta) return;
  const { x, z } = HP.sToXZ(meta.line, hojdS);
  const yTrue = HP.yAtS(meta.profile, hojdS);
  if (ground) ground.updateMatrixWorld();
  hojdMarker.position.set(x, surfaceYAt(x, z, yTrue * exag) + LINE_OFFSET, z);
}

const fmtDh = dh => `${dh >= 0 ? '+' : '−'}${Math.abs(dh).toFixed(1)} m`;
const hojdTeeId = () => (localStorage.getItem('sg_tee') || '').trim();

// s → SVG-koordinat (viewBox 0..300 x 0..100), ur den normalisering
// buildHojdPanel räknade fram för aktuellt hål.
function hojdSvgXY(s, y) {
  const { sTot, yMin, padY, span } = hojdYNorm;
  return [sTot ? (s / sTot) * 300 : 0,
          100 - ((y - (yMin - padY)) / (span + padY * 2)) * 100];
}

function buildHojdPanel() {
  if (!meta || !meta.profile || meta.profile.length < 2 || !meta.line) return;
  hojdS = 0;
  const p = meta.profile;
  const sTot = HP.sMax(p);
  const ys = p.map(pt => pt[1]);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0);
  const span = Math.max(yMax - yMin, 1);   // undvik div/0 på ett helt platt hål
  hojdYNorm = { sTot, yMin, padY: span * 0.15, span };

  const poly = p.map(([s, y]) => hojdSvgXY(s, y).join(',')).join(' ');
  el('hojdsvg').innerHTML =
    `<polyline points="0,100 ${poly} 300,100" fill="#37b06b26" stroke="none"></polyline>` +
    `<polyline points="${poly}" fill="none" stroke="var(--accent)" stroke-width="2"></polyline>` +
    `<line id="hojdMarkLine" x1="0" y1="0" x2="0" y2="100" stroke="${'#' + HOJD_MARK_COLOR.toString(16)}" stroke-width="1.4" stroke-dasharray="2,2"></line>` +
    `<circle id="hojdMarkDot" r="3.6" fill="${'#' + HOJD_MARK_COLOR.toString(16)}" stroke="#0c2e22" stroke-width="1"></circle>`;

  const net = HP.netHeight(meta, hojdTeeId());
  el('hojdDelta').textContent = fmtDh(net.dh);
  el('hojdLangd').textContent = net.tee
    ? `vald tee ${net.tee} · ${net.len ?? meta.length_m} m`
    : `${meta.length_m} m`;

  renderHojd();
}

// Uppdaterar panelens (DOM/SVG) markör + livetext. Ren DOM-uppdatering — inte
// scengrafen (den härleds separat i updateHojdMarker, se ritregeln ovan) —
// så det är säkert att köra direkt i pekarhanterare.
function renderHojd() {
  if (!meta || !hojdYNorm) return;
  const yHere = HP.yAtS(meta.profile, hojdS);
  const [mx, my] = hojdSvgXY(hojdS, yHere);
  const svg = el('hojdsvg');
  svg.querySelector('#hojdMarkLine')?.setAttribute('x1', mx);
  svg.querySelector('#hojdMarkLine')?.setAttribute('x2', mx);
  const dot = svg.querySelector('#hojdMarkDot');
  if (dot) { dot.setAttribute('cx', mx); dot.setAttribute('cy', my); }

  const pa = HP.playsAsAt(MapCore, PlayAs, meta, hojdS, hojdWind);
  el('hojdlive').innerHTML =
    `${Math.round(hojdS)} m från tee · höjd ${fmtDh(yHere)} · till green ` +
    `<b>${pa.mean} m</b>${pa.windless ? ' (vind ej inräknad)' : ''}`;
}

function setHojdS(s) {
  if (!meta || !meta.profile) return;
  hojdS = HP.clampS(s, meta.profile);
  renderHojd();
}

// Dra i profilen (pekare, samma element hanterar mus + touch via Pointer
// Events) — sätter hojdS; scengrafens markör hämtar den nästa bildruta.
{
  const svg = el('hojdsvg');
  let dragging = false;
  const fracFromEvent = e => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  };
  svg.addEventListener('pointerdown', e => {
    dragging = true;
    try { svg.setPointerCapture(e.pointerId); } catch { /* ofarligt */ }
    if (meta) setHojdS(fracFromEvent(e) * HP.sMax(meta.profile));
  });
  svg.addEventListener('pointermove', e => {
    if (!dragging || !meta) return;
    setHojdS(fracFromEvent(e) * HP.sMax(meta.profile));
  });
  const slut = e => {
    dragging = false;
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ofarligt */ }
  };
  svg.addEventListener('pointerup', slut);
  svg.addEventListener('pointercancel', slut);
}

// Tryck (tap, inte drag) på hållinjen i 3D — motsatt riktning: 3D → hojdS.
// Egen, ADDITIV pekarlyssnare på canvasen (stör inte CameraControllers egna
// lyssnare på samma element — DOM tillåter flera lyssnare per händelse).
// Bara aktiv i höjd-läget, så en vanlig panorering aldrig av misstag flyttar
// markören.
{
  const _tapRay = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  renderer.domElement.addEventListener('pointerup', e => {
    const d0 = down; down = null;
    if (!d0 || !meta || !ground) return;
    // U11: i fri vy (inget läge) lägger ett tryck en landningspunkt, om
    // värdsidan har begärt det. Lägena vinner — höjd och slaget äger sitt tryck.
    const planTapp = tappPa && lage === null;
    if (lage !== 'hojd' && lage !== 'slaget' && !planTapp) return;
    const moved = Math.hypot(e.clientX - d0.x, e.clientY - d0.y);
    if (moved > 6 || performance.now() - d0.t > 600) return;   // det var en gest, inte ett tryck
    const ndc = new THREE.Vector2(
      (e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    _tapRay.setFromCamera(ndc, camera);
    if (planTapp) {
      // Marken FÖRST, kjolen sedan: en punkt satt på vidvinkelns decimerade
      // terräng är fortfarande en riktig plats på banan, men finmeshen är den
      // sannare av de två där den finns.
      const träff = _tapRay.intersectObject(ground, true);
      const yttre = träff.length ? träff : (wide ? _tapRay.intersectObject(wide, true) : []);
      if (!yttre.length) return;
      const p = yttre[0].point;
      tappPa(HP.xzToLatLon(meta.ll2xz, p.x, p.z));
      return;
    }
    // U17: i slag-läget träffar trycket ett SLAG (röret eller kulan), inte
    // marken. Bommar man allt betyder det avmarkering — samma "tryck utanför
    // stänger" som resten av appen.
    if (lage === 'slaget') { valjSlag(slagVidSkarm(e.clientX, e.clientY)); return; }
    const hit = _tapRay.intersectObject(ground, true);
    if (hit.length) setHojdS(HP.xzToS(meta.line, hit[0].point.x, hit[0].point.z));
  });
}

/* ------------------------------------- U11: planens slagkedja i 3D ---------
 *
 * Samma kedja som 2D-vyn ritar, ur samma `sg-plan-v1` via Vylage — men här som
 * objekt i scengrafen, på marken, ombyggda i samma bildruta som allt annat
 * (§2 noll eftersläpning). Punkterna kommer in i lat/lon och räknas om med
 * hålets egen ll2xz-affin: det är DEN som gör att en punkt satt i 2D hamnar på
 * exakt samma gräs i 3D.
 *
 * Formen är avsiktligt 2D-kartans: grön prick med nummer, heldragen linje
 * mellan de satta punkterna och streckad sista bit till green. Samma språk i
 * båda vinklarna, annars är det inte en vy.
 */
let legObjs = [], legLL = [], legGreen = null;

function ritaPlanLegs() {
  legObjs.forEach(o => { scene.remove(o); o.geometry?.dispose?.();
    o.material?.map?.dispose?.(); o.material?.dispose?.(); });
  legObjs = [];
  if (!meta || !meta.ll2xz || !meta.line) return;
  const xz = ([lat, lon]) => {
    const [x, z] = HP.latLonToXz(meta.ll2xz, lat, lon);
    return new THREE.Vector3(x, surfaceYAt(x, z, 0) + LINE_OFFSET, z);
  };
  // Tee är slag 1 och kommer ur hålets egen linje, inte ur kedjan — precis som
  // i 2D, där den är fast och varken kan flyttas eller tas bort.
  const teeRaw = meta.line[0];
  const tee = new THREE.Vector3(teeRaw[0],
    surfaceYAt(teeRaw[0], teeRaw[2], teeRaw[1] * exag) + LINE_OFFSET, teeRaw[2]);
  const punkter = [tee, ...legLL.map(xz)];

  punkter.forEach((p, i) => {
    const kula = new THREE.Mesh(new THREE.SphereGeometry(1.7, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0x37b06b }));
    kula.position.copy(p);
    kula.name = `plan-punkt-${i}`;
    scene.add(kula); legObjs.push(kula);
    const nr = nummerSprite(i + 1, '#37b06b');
    nr.position.set(p.x, p.y + 7, p.z);
    nr.name = `plan-nummer-${i}`;
    scene.add(nr); legObjs.push(nr);
  });
  const linje = (pts, dash) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const l = new THREE.Line(g, dash
      ? new THREE.LineDashedMaterial({ color: 0x37b06b, dashSize: 5, gapSize: 4 })
      : new THREE.LineBasicMaterial({ color: 0x37b06b }));
    if (dash) l.computeLineDistances();
    l.name = dash ? 'plan-linje-green' : 'plan-linje';
    scene.add(l); legObjs.push(l);
  };
  if (punkter.length > 1) linje(punkter, false);
  const sist = punkter[punkter.length - 1];
  const g = legGreen ? xz(legGreen)
    : (() => { const s = meta.line[meta.line.length - 1];
               return new THREE.Vector3(s[0], surfaceYAt(s[0], s[2], s[1] * exag) + LINE_OFFSET, s[2]); })();
  linje([sist, g], true);
}

/** Kedjan som ska ritas. Anropas av planvy.html vid varje ändring i Vylage. */
function sattPlanLegs(list, greenCenter) {
  legLL = (list || []).filter(p => Array.isArray(p) && p.length === 2);
  legGreen = greenCenter && greenCenter.length === 2 ? greenCenter : null;
  omPlanLegs();
}

/* Tapp-kontraktet, 3D-sidan: ett tryck på marken → lat/lon till värdsidan, som
   skickar det vidare till Vylage.laggPunkt — SAMMA funktion som Leaflet-tappet
   går igenom. Två skepnader in, en punkt ut (§5 U11). */
let tappPa = null;

async function loadHole(slug) {
  clearHole();
  status('laddar ' + slug.replace('_', ' ') + '…');
  fakta('');
  try {
    meta = await (await fetch(`data/holes3d/${slug}.json`)).json();
    const gltf = await loader.loadAsync(`data/holes3d/${meta.glb}`);
    ground = gltf.scene;
    ground.traverse(c => { if (c.material) { c.material.roughness = 1; c.material.metalness = 0; } });
    scene.add(ground);
    byggMarkindex();     // U18: EN gång per hål, före första ombyggnaden
    applyExag();
    placeCamera();
    stopFly();
    startFly();
    buildHojdMarker();   // U6: ny grupp per hål (clearHole tog bort förra)
    buildHojdPanel();    // bygger om profil-SVG:n och nollställer hojdS
    fakta(`${fmtDh(meta.delta_h)} · ${meta.length_m} m`);
    status('');
    if (meta.wide) loadWide(meta.slug, meta.wide);   // U15, efter hålet
    hittaSlag().then(buildShots);                    // U9, efter hålet
    hamtaVind();                                     // U16, kräver nät (§1 p3)
  } catch (e) {
    status('kunde inte ladda hålet — är det exporterat? (' + e.message + ')');
  }
}

// U15 vidvinkeln. Laddas EFTER hålets glb och inväntas aldrig: hålet ska vara
// synligt först (§2 noll eftersläpning), omgivningen fyller i sig. Saknas
// filen degraderar vyn rent till dagens korridor, utan fel i konsolen.
//
// Kjolen sänks INTE i geometrin utan med en konstant världsoffset, så steget
// mot finmeshen förblir 0,3 m oavsett höjdöverdrift (`scale.y = exag` skulle
// annars göra det till 0,9 m vid 3×). Delade noder har identisk höjd —
// decimeringen plockar finrutans sampel (tools/hole_gltf.py build_wide_glb).
const SKIRT_DROP_M = 0.3;

async function loadWide(slug, file) {
  try {
    const gltf = await loader.loadAsync(`data/holes3d/${file}`);
    if (!meta || meta.slug !== slug) return;      // användaren bytte hål under laddningen
    wide = gltf.scene;
    wide.name = 'u15-wide';                       // scengraf-verifiering, ?dbg=1
    wide.traverse(c => { if (c.material) { c.material.roughness = 1; c.material.metalness = 0; } });
    wide.scale.y = exag;
    wide.position.y = -SKIRT_DROP_M;
    scene.add(wide);
  } catch { /* ingen kjol för hålet — dagens vy gäller */ }
}

// ---------------------------------------------------------------- UI-yta ---
el('exag').addEventListener('input', ev => {
  const forra = exag;
  exag = parseFloat(ev.target.value);
  el('exagv').textContent = exag.toFixed(1).replace('.0', '') + '×';
  applyExag(forra);
  if (exagPa) exagPa(exag);        // U11: Vylage äger värdet, scenen speglar det
});

// ---------------------------------------------------- U11: värdsidans yta ---
// Allt nedan finns för planvy.html. Den fristående sidan rör ingenting av det
// och beter sig exakt som före U11.
let exagPa = null, lagePa = null;

/** Sätt överdriften utifrån (Vylage) utan att gå via reglaget. */
function sattExag(v) {
  const n = Math.max(1, Math.min(5, +v || 1));
  if (n === exag) return;
  const forra = exag;
  exag = n;
  const r = el('exag'), t = el('exagv');
  if (r) r.value = String(n);
  if (t) t.textContent = n.toFixed(1).replace('.0', '') + '×';
  applyExag(forra);
}

/* Dold vinkel ska inte rita. `setAnimationLoop(null)` stoppar rAF helt — annars
   renderar 3D:n i bakgrunden bakom Leaflet-kartan och äter batteri på en vy
   ingen tittar på. Vid återkomst tas loopen upp igen; scenen är oförändrad, så
   inget behöver byggas om. */
function sattSynlig(pa) {
  renderer.setAnimationLoop(pa ? tick : null);
  if (!pa && fly) stopFly();
}

/** Kameraläget som fyra tal (camctl:s tillstånd) — värdsidan sparar det per hål. */
const posen = () => ({
  target: { ...controls.state.target }, range: controls.state.range,
  heading: controls.state.heading, tilt: controls.state.tilt,
});
const sattPosen = p => { if (p && p.target) controls.setState(p); };

/** Finns hålet i 3D för aktiv bana? Värdsidan döljer 3D-knappen om inte. */
async function harIndex() {
  try {
    const r = await fetch(`data/holes3d/index.${SGRound.activeSlug()}.json`);
    if (!r.ok) return null;
    const idx = await r.json();
    return (idx.holes || []).length ? idx : null;
  } catch { return null; }
}

/* U12: det bron behöver av scenen.
 *
 * `konv` binder hålets ll2xz-affin till hojdprofil.js:s två funktioner — den
 * modul som ÄGER affinen. Bron får dem som argument i stället för att bära en
 * egen kopia (skälet står i vybro.js). `markY` är markens höjd MED överdriften
 * på, alltså den y en målpunkt faktiskt har i scenen just nu. */
const konv = () => (meta && meta.ll2xz ? {
  ll2xz: (lat, lon) => HP.latLonToXz(meta.ll2xz, lat, lon),
  xz2ll: (x, z) => HP.xzToLatLon(meta.ll2xz, x, z),
  // Scenens ram pekar mot GRIDNORR, Leaflets mot sant norr — se
  // HP.gridNorthOffset. Utan detta är sömmen en vridning på 1,6°.
  gridNorr: HP.gridNorthOffset(meta.ll2xz),
} : null);
const markY = (x, z) => surfaceYAt(x, z, 0);

/* Referensplanet för 2D-posen: hålets egen marknivå, som medel längs hållinjen.
   Det är DÄR innehållet ligger, och därför där skalan mot kartan ska stämma —
   skälet i sin helhet står i vybro.js:s poseFor2d. Följer överdriften, precis
   som marken gör. */
const yRefPlan = () => {
  if (!meta || !meta.line || !meta.line.length) return 0;
  let s = 0;
  for (const p of meta.line) s += p[1];
  return (s / meta.line.length) * exag;
};

/** Mjuk övergång i kamerans fyra tal. Avbryts av första gesten (camctl). */
const flygTill = (mal, ms) => controls.flyTo(mal, ms);
/** Pågår en kameraanimering? Värdsidan väntar inte på den, men vill veta. */
const flygerNu = () => !!controls._anim;

/* Var hamnar en världspunkt på skärmen denna bildruta? Samma funktion som
   §2.4-mätningen använder — sömmen mellan Leaflet och 3D mäts med den mot
   Leaflets `latLngToContainerPoint` (U12:s krav ≤ 2 px). */
const skarmAv = (x, y, z) => screenOf(controls.state, { x, y, z }, camera.fov,
                                      innerWidth / innerHeight, innerWidth, innerHeight);

/* En bildruta på begäran. rAF tickar inte i en dold browser-panel (§10), och
   utan detta går sömmen inte att MÄTA där — bara att tro på. */
const rita1 = () => tick();

const paTapp = fn => { tappPa = fn; };
const paExag = fn => { exagPa = fn; };
const paLage = fn => { lagePa = fn; };
const lageNu = () => lage;
const metaNu = () => meta;

export { loadHole as laddaHal, sattExag, sattSynlig, setLage as sattLage,
         sattPlanLegs, posen, sattPosen, harIndex, paTapp, paExag, paLage,
         lageNu, metaNu, konv, markY, yRefPlan, flygTill, flygerNu, skarmAv, rita1 };

if (!EMBED) (async () => {
  let idx;
  try {
    idx = await (await fetch(`data/holes3d/index.${SGRound.activeSlug()}.json`)).json();
  } catch { status('inga 3D-hål exporterade än (tools/hole_gltf.py)'); return; }
  const sel = el('hal');
  for (const h of idx.holes) {
    const o = document.createElement('option');
    o.value = h.slug;
    o.textContent = `${h.loop.replace(' Course', '')} ${h.hole}  (Δh ${h.delta_h >= 0 ? '+' : '−'}${Math.abs(h.delta_h)} m)`;
    sel.appendChild(o);
  }
  if (!idx.holes.length) { status('inga 3D-hål exporterade än'); return; }
  sel.addEventListener('change', () => loadHole(sel.value));
  const want = new URLSearchParams(location.search).get('hal');
  if (want && idx.holes.some(h => h.slug === want)) sel.value = want;
  loadHole(sel.value);
})();
