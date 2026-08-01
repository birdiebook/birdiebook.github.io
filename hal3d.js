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
import { CameraController, screenOf,
         overviewState as camOverviewState } from './camctl.js';
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
/* Canvas-filtret ligger på HELA vyn — himmel, dis, träd, siktlinje, markörer.
   Det är därför det inte kan vara 2D-kartans filter: `brightness(1.60)
   sepia(0.05)` på dis-himlen bränner ut den och gulnar laserträdens
   vertexfärger. Strängen är oförändrad sedan U7 och ska så förbli; det som
   ändras är att MARKEN inte längre nöjer sig med den (se MARK_KORR). */
const FILTER_3D_CANVAS = "brightness(1.35) saturate(1.20) contrast(0.96)";
renderer.domElement.style.filter = FILTER_3D_CANVAS;
el('scen').appendChild(renderer.domElement);

const scene = new THREE.Scene();
/* U7 punkt 6: dis och djup.
 *
 * Dimman gjorde tidigare ett jobb den inte skulle: den dolde att scenen TOG
 * SLUT vid korridorens 50 m. Med U15:s kjol finns det terräng där ute, och då
 * kan dimman få göra sitt riktiga jobb — ge djup och låta horisonten tona ut
 * i stället för att klippas av.
 *
 * Tonen är inte vald fritt. Den ligger mellan himlens blå och gräsets ton
 * EFTER filtret (§9.1 mätte fairway till `#6d7f37` på Burlöv), lite ljusare än
 * marken och lite varmare än himlen, så horisonten inte blir ett kallt band
 * ovanför en varm bana. Avstånden är utdragna mot förut (600→1600 blev
 * 900→2600) därför att kjolen räcker längre än korridoren gjorde. */
const DIS_FARG = 0xa9c2c0;
scene.background = new THREE.Color(DIS_FARG);
scene.fog = new THREE.Fog(DIS_FARG, 900, 2600);

const himmelLjus = new THREE.HemisphereLight(0xdfeaf2, 0x3a4a38, 0.9);
scene.add(himmelLjus);
const sol = new THREE.DirectionalLight(0xfff2dd, 1.6);
sol.position.set(-0.5, 0.8, -0.6);                       // NV, som hillshaden
scene.add(sol);
scene.add(sol.target);

/* ---- U7 punkt 1: skuggor -------------------------------------------------
 *
 * Enskilt största lyftet i etappen, och skälet är inte att det är snyggt: en
 * skugga BINDER trädet till marken. Utan den svävar kronorna, och terrängens
 * höjdskillnader syns inte alls — det är samma information hillshaden bär i
 * 2D-kartan, fast i rätt riktning för klockslaget.
 *
 * PCFSoft + 2048 är valt för att en hård skuggkant på 1 m-DEM ser ut som ett
 * fel i datan snarare än som en skugga. Kameran spänns om per hål (spannUpp)
 * eftersom en fast frustum antingen missar långa hål eller slösar upplösning
 * på korta. */
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
sol.shadow.bias = -0.0009;          // mot akne på nästan plan fairway
sol.shadow.normalBias = 0.6;        // mot "peter panning" vid trädfötterna

/* U7 punkt 7: solens VERKLIGA position för datum, klockslag och latitud.
 *
 * Varför det är värt en formel i stället för ett fast ljus: skuggorna hamnar
 * åt rätt håll, och du ser om ett hål ligger i motljus vid din starttid — det
 * är spelinformation, inte dekor. NOAA:s lågprecisionsalgoritm räcker gott
 * (fel < 0,1° här), och den är liten nog att inte behöva ett bibliotek.
 *
 * Lågt kvällsljus är vackert men gör terrängen svårare att läsa, så läsläget
 * (det fasta NV-ljuset) går alltid att få tillbaka — se `sattSol`. */
/* Formeln bor i `mobile/sol.js` och testas av `tests/js/test_sol.mjs` — här
 * används den bara. En andra kopia här vore exakt den sortens spegel som
 * glider isär (jfr `sgColor` och bollbanans två implementationer). */

/* Läsläget är default. `sattSol(null)` = det fasta NV-ljuset; `sattSol(datum)`
 * = sann sol för banans position. Solen hålls ALLTID över ~12° höjd i
 * ljusstyrkan så scenen inte blir oläsbar vid soluppgång — riktningen är sann,
 * exponeringen är vår. */
/* Sann sol väljs med `?sol=<ISO-tid>` (t.ex. `?sol=2026-06-21T17:30`) eller
 * `?sol=nu`. Att det ännu inte finns en KNAPP är medvetet: knappen hör hemma
 * där starttiden bor — i planen (GP3) eller i rundan — och ett klockreglage i
 * verktygsraden vore en tredje plats att hålla i synk med den. */
function solUrParam() {
  const v = new URLSearchParams(location.search).get('sol');
  if (!v) return null;
  if (v === 'nu') return Date.now();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
let solLage = solUrParam();                // null = läsläge
function sattSol(datum) {
  solLage = datum;
  if (!datum || !meta || !meta.ll2xz) {
    sol.position.set(-0.5, 0.8, -0.6).normalize().multiplyScalar(1000);
    sol.color.setHex(0xfff2dd);
    sol.intensity = 1.6;
    himmelLjus.intensity = 0.9;
    return;
  }
  const [lon0, lat0] = meta.ll2xz;
  const { alt, az } = Sol.solriktning(datum, lat0, lon0);
  // Scenens +x = öst, -z = norr (samma ram som ll2xz), så azimut från norr
  // blir (sin az, -cos az) i xz-planet.
  const hojd = Math.max(alt, 12 * Math.PI / 180);
  const r = Math.cos(hojd);
  sol.position.set(Math.sin(az) * r, Math.sin(hojd), -Math.cos(az) * r)
     .multiplyScalar(1000);
  // Lågt stående sol är varmare och svagare; hemisfärljuset tar över.
  const lagt = 1 - Math.min(1, alt / (35 * Math.PI / 180));
  sol.color.setHSL(0.09, 0.35 + 0.25 * lagt, 0.62 - 0.06 * lagt);
  sol.intensity = 1.6 - 0.5 * lagt;
  himmelLjus.intensity = 0.9 + 0.35 * lagt;
}

/* Skuggkameran ska täcka hålet — inte mer (upplösning) och inte mindre
 * (avklippta skuggor). Spänns om när ett hål laddats och när överdriften
 * ändras, eftersom höjdskalan flyttar kronorna. */
function spannUpp() {
  if (!ground) return;
  const box = new THREE.Box3().setFromObject(ground);
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 60);
  sol.target.position.copy(c);
  sol.position.normalize().multiplyScalar(r * 2.5).add(c);
  const s = sol.shadow.camera;
  s.left = -r; s.right = r; s.top = r; s.bottom = -r;
  s.near = 1; s.far = r * 6;
  s.updateProjectionMatrix();
  sol.shadow.needsUpdate = true;
}

/* ---- ortofotot ska se LIKADANT ut i 2D och 3D (ORTOFOTO_FARG.md) ----------
 *
 * 2D-looken är tiles × `CourseMap.MAP_FILTER`. 3D-looken var textur ×
 * canvas-filtret ovan — två olika filter på samma ortofoto, alltså två looker
 * på samma gräs. Lösningen är inte att byta canvas-filtret (det rör hela
 * scenen) utan att låta MARKEN bära skillnaden: en korrigering i markens egen
 * shader, vald så att
 *
 *     canvasfilter( korrigering( markpixel ) )  ≈  MAP_FILTER( tilepixel )
 *
 * Allt annat i scenen går genom exakt samma canvas-filter som förut och ser
 * därför ut som förut. Korrigeringen räknas ut ur de två strängarna — ingen
 * handknådad andra uppsättning tal som kan glida ifrån 2D när MAP_FILTER
 * ändras. `tests/js/test_bildfilter.mjs` bevisar likheten numeriskt.
 *
 * Saknas `CourseMap` (en värdsida som inte laddat coursemap.js) hoppas
 * korrigeringen över: vyn blir dagens, utan konsolfel. */
const MAP_FILTER = typeof CourseMap !== 'undefined' ? CourseMap.MAP_FILTER : null;
const BF = typeof Bildfilter !== 'undefined' ? Bildfilter : null;
const MARK_KORR = (BF && MAP_FILTER)
  ? BF.correction(BF.parse(MAP_FILTER), BF.parse(FILTER_3D_CANVAS)) : null;

/* Träden: ORTOFOTO_FARG:s princip (mot rent grönt, inte mot gult) på
   laserkronorna. Kronfärgen kommer ur ortofotot och ärver dess varma ton; en
   liten ljushöjning och en vridning mot grönt gör dem lite ljusare gröna utan
   att lämna den mätta färgen. Ligger PÅ trädmaterialen, inte på canvasen —
   marken har sin egen korrigering och ska inte röras av den här. */
const TRAD_FILTER = "brightness(1.10) saturate(1.06) hue-rotate(6deg)";
const TRAD_OPS = BF ? BF.parse(TRAD_FILTER) : null;

/* Lägger en filterkedja i ett materials fragment-shader, EFTER
   <colorspace_fragment>. Där är gl_FragColor sRGB — samma färgrum som CSS-
   filtren verkar i — så matten blir identisk med webbläsarens. Läggs den före
   färgrumskonverteringen räknar den på linjärt ljus och ger fel ton. */
function filtrera(mat, ops, namn) {
  if (!mat || !ops || mat.userData.__bildfilter) return;
  mat.userData.__bildfilter = namn;
  const fn = BF.glsl(ops, namn);
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      `#include <colorspace_fragment>\n  gl_FragColor.rgb = ${namn}(gl_FragColor.rgb);`
    ).replace('void main() {', `${fn}\nvoid main() {`);
  };
  mat.needsUpdate = true;
}

const filtreraMark = obj => obj?.traverse(c => filtrera(c.material, MARK_KORR, 'markKorr'));
const filtreraTrad = obj => filtrera(obj?.material, TRAD_OPS, 'tradTon');

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
    // U7: bildfrekvens + rendererns egen räknare. `fps()` ger median och p95 på
    // bildrutetiden; `nollstallFps()` före en mätning så uppstarten inte räknas.
    fps: fpsStat, nollstallFps,
    /* Renderkostnad utan rAF. Behövs därför att en bakgrundsflik aldrig får en
     * bildruta (`document.hidden` → rAF pausas), och då är `fps()` alltid null
     * — precis läget i verifieringspanen. Det här tvingar N renderingar och
     * mäter tiden, vilket INTE är fps (ingen kompositering, ingen vsync) men är
     * ett jämförbart före/efter-tal på samma maskin och samma scen. Den riktiga
     * fps-siffran mäts med `fps()` på telefonen. */
    matRender: (n = 120) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) renderer.render(scene, camera);
      const ms = (performance.now() - t0) / n;
      return { n, ms_per_render: +ms.toFixed(2),
               teoretisk_fps: +(1000 / ms).toFixed(0),
               ...renderer.info.render };
    },
    render: () => ({ ...renderer.info.render, geometrier: renderer.info.memory.geometries,
                     texturer: renderer.info.memory.textures }),
    /* U7: scenens finish verifieras i scengrafen, inte i en skärmdump — en
     * skuggkarta som inte är påslagen och en skugga som faller åt fel håll ser
     * likadana ut i en pixelbild om man inte vet vad man letar efter. */
    finish: () => ({
      skuggkarta: { pa: renderer.shadowMap.enabled, typ: renderer.shadowMap.type,
                    storlek: [sol.shadow.mapSize.x, sol.shadow.mapSize.y] },
      sol: { pos: sol.position.toArray().map(v => +v.toFixed(1)),
             mal: sol.target.position.toArray().map(v => +v.toFixed(1)),
             farg: '#' + sol.color.getHexString(), styrka: +sol.intensity.toFixed(2),
             lage: solLage ? new Date(solLage).toISOString() : 'lasläge' },
      dis: { farg: '#' + scene.fog.color.getHexString(),
             nar: scene.fog.near, fjarran: scene.fog.far },
      trad: treeParts.map(o => ({
        typ: o.geometry?.type, antal: o.count ?? 1,
        material: o.material?.type,
        roughness: o.material?.roughness,
        kastar: o.castShadow, tar_emot: o.receiveShadow,
        trianglar: (o.geometry?.index ? o.geometry.index.count / 3
                    : (o.geometry?.attributes?.position?.count ?? 0) / 3) * (o.count ?? 1),
      })),
      mark: (() => {
        let n = 0, tar = 0, kastar = 0;
        ground?.traverse(c => { if (c.isMesh) { n++; if (c.receiveShadow) tar++; if (c.castShadow) kastar++; } });
        return { mesh: n, tar_emot: tar, kastar };
      })(),
    }),
    // U7: byt solläge utan att ladda om — så en verifiering kan jämföra
    // läsläget och en sann sol i SAMMA scen.
    sattSol: t => { sattSol(t); spannUpp(); return solLage; },
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
    slag: () => ({ visa: shotVisa, objekt: shotObjs.length, antal: KEDJA.length,
                   // U19: raderna ÄR beviset — samma tal som 2D-listan skriver ut.
                   kedja: KEDJA.map(r => ({ nr: r.nr, dist: Math.round(r.dist),
                     spelarSom: r.spelarSom, apex: r.traj ? +r.traj.apex.toFixed(2) : null,
                     andrad: r.andrad })),
                   punkter: meta && meta.ll2xz
                     ? [planTeeLL(), ...planLegs].filter(Boolean)
                         .map(ll => shotXZ(ll[0], ll[1]).map(v => Math.round(v)))
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

// -------------------------------------------------------- fly-through (PR4) ---
// FLYGNINGEN ÄR ETT VAL, INTE ETT STARTLÄGE. Den startade förut automatiskt vid
// varje hålbyte i plan-läget (`?from=plan`/inbäddad), och eftersom den skriver
// kamerans läge varje bildruta åt den upp posen som vinkelbytet just satt — så
// bilden "hoppade runt" i stället för att ligga still på överblicken. Numera
// startar bara verktygsradens Flyover-knapp den, på BÅDA sidorna; flaggan som
// skilde dem åt fyllde ingen annan funktion och är borta (den gjorde dessutom
// att avbryt-knappen aldrig kopplades in på den fristående sidan).
//
// Kameran glider längs meta.line (samma georef som scenen), blicken mot nästa
// punkt på linjen. Avbryts av knappen eller första pekar-/hjul-interaktionen.
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
// U21: var flygningen BÖRJAR. Förut satt kameran `R·cos(pitch)` bakom
// startpunkten redan vid u = 0, och `R` är det avstånd som krävs för att rymma
// FLY_HALF_W i bredd — på en telefon i porträtt blir det över 120 m bakom teen,
// alltså långt utanför banan och ofta bakom träd eller på en annan korridor.
// Beställningen är spelarens egen startbild: strax bakom bakre tee. Avståndet
// rampar därför in i stället för att gälla direkt.
const FLY_START_BACK_M = 12;           // m bakom bakre tee vid start
const FLY_BACK_RAMP = 0.8;             // andel av flygningen tills fullt kameraavstånd
// Taket: kameran får aldrig hamna längre bakom fokuspunkten än en dryg tredjedel
// av hålets längd. Utan det står den 123 m bakom en 100-metersgren — alltså
// längre från teen än greenen är, vilket varken ser ut som golf eller går att
// nå på den tid flygningen varar.
const FLY_BACK_MAX_FRAC = 0.38;
const FLY_TEE_MIN_M = 3;               // närmare hållinjens start än så = samma punkt

// mjuk 0→1-ramp (Hermite) mellan två kanter — ger klarning utan pop när träd tonas in/ut
function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* U21: BAKRE tee — den i `meta.tees` som spelar hålet längst.
 *
 * Det är inte samma sak som `meta.line[0]`: hållinjen börjar vid den tee hålets
 * export utgick från, och på flera hål ligger bakre tee en bra bit bakom den
 * (uppmätt på Burlöv: blue 7 hela 78 m, blue 4 32 m, blue 1 16 m). En flygning
 * som startar på hållinjen börjar alltså mitt i hålet på just de hål där
 * skillnaden syns mest.
 *
 * Och det är medvetet INTE spelarens valda tee: flygningen är en presentation
 * av hålet, inte av dagens spel. */
function flyBakreTee() {
  const t = meta && meta.tees;
  if (!t) return null;
  let bast = null;
  for (const v of Object.values(t))
    if (v && isFinite(v.x) && (!bast || (v.len || 0) > (bast.len || 0))) bast = v;
  return bast;
}

// Punkterna i sanna meter med höjd skalad av överdriften (markytan, ingen ögonhöjd).
// Ligger bakre tee bakom hållinjens start förlängs banan dit — annars börjar
// flygningen framför den tee den påstår sig starta vid (U21).
function flyGroundPts() {
  const pts = meta.line.map(([x, y, z]) => new THREE.Vector3(x, y * exag, z));
  const bak = flyBakreTee();
  if (bak) {
    const p0 = pts[0], gr = pts[pts.length - 1];
    const bakom = Math.hypot(bak.x - gr.x, bak.z - gr.z) > Math.hypot(p0.x - gr.x, p0.z - gr.z);
    const skilt = Math.hypot(bak.x - p0.x, bak.z - p0.z) > FLY_TEE_MIN_M;
    if (bakom && skilt) pts.unshift(new THREE.Vector3(bak.x, (bak.y || 0) * exag, bak.z));
  }
  return pts;
}

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
  const R = Math.min(Math.max(FLY_MIN_R, FLY_HALF_W / Math.tan(fovH / 2)),
                     FLY_BACK_MAX_FRAC * (curve.getLength() || 1));
  // U21: backningen rampar från "precis bakom bakre tee" till det avstånd som
  // rymmer hålets bredd. Höjden följer avståndet genom SAMMA pitch-vinkel, så
  // starten blir en låg blick ner för hålet i stället för ett fågelperspektiv —
  // och ingen knyck uppstår, för rampen är samma smoothstep som trädklarningen.
  const back = FLY_START_BACK_M
    + (R * Math.cos(FLY_PITCH) - FLY_START_BACK_M) * smoothstep(0, FLY_BACK_RAMP, u);
  const pos = L.clone().addScaledVector(fwd, -back);
  const baseY = L.y + back * Math.tan(FLY_PITCH);
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

function startFly() {
  if (!meta || !meta.line || meta.line.length < 2) return;
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
el('flyavbryt').addEventListener('click', stopFly);

// U4: verktygsraden. Flyover, Tee-vy och Höjd lever; Slaget lever sedan U17
// men är avstängd på hål utan loggade slag — en knapp som ser klickbar ut men
// inte gör något är sämre än en som ärligt visar varför den inte går att trycka.
el('vFlyover').addEventListener('click', () => {
  if (lage === 'flyover') { stopFly(); setLage(null); return; }
  setLage('flyover');
  startFly();
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
  const s = overviewState();
  if (s) controls.flyTo(s, 700);
  setLage('hojd');
});

// EN tick: flygning → kameratillstånd → render. Allt som hör till marken ska
// skrivas här, före render, aldrig i en händelselyssnare (UPPGRADERING_3D §2).
/* U7: bildfrekvensen mäts på riktiga bildrutor, inte gissas. Ringbufferten är
 * alltid på (två tal per tick, ingen mätbar kostnad) men läses bara via
 * `?dbg=1` — kravet i etappen är ≥ 30 fps på det tätaste hålet, och det går
 * inte att kontrollera i efterhand utan att ha mätt. */
const _fpsBuf = new Float32Array(180);
let _fpsI = 0, _fpsN = 0, _fpsSist = 0;
function _fpsTick(nu) {
  if (_fpsSist) {
    _fpsBuf[_fpsI] = nu - _fpsSist;
    _fpsI = (_fpsI + 1) % _fpsBuf.length;
    if (_fpsN < _fpsBuf.length) _fpsN++;
  }
  _fpsSist = nu;
}
function fpsStat() {
  if (_fpsN < 10) return null;
  const v = Array.from(_fpsBuf.slice(0, _fpsN)).sort((a, b) => a - b);
  const p = q => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { n: _fpsN, median: +(1000 / p(0.5)).toFixed(1),
           // p95 på BILDRUTETIDEN = den långsammaste rutan, alltså det som
           // känns som hack. Medelvärdet döljer precis det.
           p5_fps: +(1000 / p(0.95)).toFixed(1),
           varsta_ms: +v[v.length - 1].toFixed(1) };
}
function nollstallFps() { _fpsI = _fpsN = 0; _fpsSist = 0; }

function tick(nu) {
  _fpsTick(nu || performance.now());
  updateFly();
  if (!fly) controls.update();     // flygningen äger kameran medan den pågår
  updateHojdMarker();              // U6: markören härleds ur hojdS varje tick — aldrig i en lyssnare
  // U22: kompassen läser kamerans bäring i SAMMA tick som scenen ritas, aldrig
  // i en lyssnare på kamerakontrollen — §2:s ritregel gäller den precis som allt
  // annat som ska följa vyn utan eftersläpning.
  if (bildrutaPa) bildrutaPa();
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
                   ...shotObjs]) {
    if (!o) continue;
    scene.remove(o);
    o.traverse?.(c => { c.geometry?.dispose(); c.material?.map?.dispose?.(); c.material?.dispose?.(); });
  }
  ground = null; wide = null; lineObj = null; treeParts = []; markers = []; hojdMarker = null;
  markIndex = null;                       // hör till hålet, inte till vyn
  shotObjs = []; KEDJA = [];
  rensaSlope(); slopeHal = null;          // U13: lutningen hör till hålet
  // U11: planens kedja hör till hålet. Värdsidan sätter den nya direkt efter
  // laddningen; tills dess ska ingen gammal kedja stå kvar på ny mark.
  planTee = null; planLegs = []; planGreen = null; planSlagval = {};
  rensaHinder(); hinderData = [];
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
/* Kortaste avstånd (m) från en punkt i markplanet till hållinjen. Används av
 * U7:s LOD-delning; linjen ligger i metans lokala ram, samma som träden. */
function avstandTillLinje(x, z) {
  const L = meta && meta.line;
  if (!L || L.length < 2) return 0;
  let bast = Infinity;
  for (let i = 0; i < L.length - 1; i++) {
    const [x1, , z1] = L[i], [x2, , z2] = L[i + 1];
    const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2)) : 0;
    const d2 = (x - (x1 + t * dx)) ** 2 + (z - (z1 + t * dz)) ** 2;
    if (d2 < bast) bast = d2;
  }
  return Math.sqrt(bast);
}

function buildTrees() {
  for (const o of treeParts) scene.remove(o);
  treeParts = [];
  const trees = (meta.trees || []).map(t => t.length >= 12 ? t
    : [t[0], t[1], t[2], t[3], t[4], t[4], 0, 0.45, 0.5, 74, 103, 65]);
  if (!trees.length) return;
  const hulls = meta.hulls || [];
  // U7 punkt 5: gransen for "langt ut i sidled" (m fran hallinjen).
  const LOD_M = 120;

  /* --- kronhöljen → TVÅ sammanslagna mesh: nära hållinjen och fjärran ---
   *
   * U7 punkt 5: delningen finns för skuggpassets skull. Höljena är den stora
   * trädmassan, och låg de i ETT mesh skulle varenda krona ritas en gång till i
   * skuggkartan — även de 150 m ut i sidled, vars skugga aldrig hamnar i bild.
   * Två mesh kostar en extra draw call och gör hela den yttre skogen gratis i
   * skuggpasset. */
  const nara = { pos: [], col: [], idx: [], vOff: 0 };
  const fjarran = { pos: [], col: [], idx: [], vOff: 0 };
  const coneIdx = [], sphIdx = [];
  trees.forEach((t, i) => {
    const hull = hulls[i];
    if (!hull) { (t[8] < 0.33 ? coneIdx : sphIdx).push(i); return; }
    const [x, gy, z, , , , , , , r, g, b] = t;
    const hink2 = avstandTillLinje(x, z) > LOD_M ? fjarran : nara;
    const base = gy * exag;
    let hMin = Infinity, hMax = -Infinity;
    for (const v of hull.v) { if (v[1] < hMin) hMin = v[1]; if (v[1] > hMax) hMax = v[1]; }
    const span = Math.max(hMax - hMin, 0.5);
    const c = new THREE.Color();
    /* U7 punkt 4: bryt upp siluetten. Kronhöljena är släta konvexa skal, och
     * det är just den släta kanten som får en skog att se ut som klumpar
     * plast. Jittret läggs LÅNGS radien ut från trädets mittaxel (billigare än
     * riktiga normaler och ger samma effekt på siluetten), skalas med kronans
     * storlek, och är seedat per träd så samma träd ser likadant ut varje gång
     * — ett träd som ändrar form när man panorerar är värre än ett slätt. */
    let fro = (i * 2654435761) >>> 0;
    const brus = () => (((fro = (fro * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5);
    for (const [dx, hh, dz] of hull.v) {
      const rad = Math.hypot(dx, dz) || 1e-6;
      const amp = Math.min(0.35, 0.06 * rad + 0.05);
      const k2 = 1 + brus() * 2 * amp / rad;
      hink2.pos.push(x + dx * k2, base + hh + brus() * amp, z + dz * k2);
      const k = 0.72 + 0.28 * (hh - hMin) / span;   // mörkare undersida
      // sRGB → linjärt arbetsfärgrum (annars urtvättade kronor)
      c.setRGB(r / 255 * k, g / 255 * k, b / 255 * k, THREE.SRGBColorSpace);
      hink2.col.push(c.r, c.g, c.b);
    }
    for (const fi of hull.f) hink2.idx.push(hink2.vOff + fi);
    hink2.vOff += hull.v.length;
  });
  for (const [h, kastar, namn] of [[nara, true, 'kronor-nara'],
                                  [fjarran, false, 'kronor-fjarran']]) {
    if (!h.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(h.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(h.col, 3));
    geo.setIndex(h.idx);
    geo.computeVertexNormals();
    const hullMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, metalness: 0.0 }));
    hullMesh.name = namn;                 // scengraf-verifiering, ?dbg=1
    hullMesh.castShadow = kastar;
    hullMesh.receiveShadow = true;
    filtreraTrad(hullMesh);
    scene.add(hullMesh);
    treeParts.push(hullMesh);
  }

  const trunkG = new THREE.CylinderGeometry(1, 1, 1, 6);
  const trunks = new THREE.InstancedMesh(
    trunkG, new THREE.MeshStandardMaterial({ color: 0x5c4a37, roughness: 0.95 }),
    trees.length);
  trunks.castShadow = true;
  trunks.receiveShadow = true;

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
        yAxis = new THREE.Vector3(0, 1, 0),
        p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();

  /* U7 punkt 3: roughness-variation PER TRÄD. En InstancedMesh delar material,
   * så variationen kan inte ligga per instans utan en egen shader-attribut —
   * i stället delas träden i tre grovhetshinkar. Det ger den variation ögat
   * behöver (en skog där varje krona har exakt samma glans läser som en
   * texturkarta, inte som löv) till priset av två extra draw calls per kronform.
   * Vertexfärgerna ur laserdatan rörs INTE: de är artspecifika och det är de
   * som gör skogen levande. */
  const HINKAR = [0.72, 0.84, 0.94];
  const makeCrowns = (geo, idx, coneY, roughness, kastarSkugga = true) => {
    if (!idx.length) return null;
    const mesh = new THREE.InstancedMesh(
      geo, new THREE.MeshStandardMaterial({ roughness, metalness: 0.0 }),
      idx.length);
    mesh.castShadow = kastarSkugga;
    mesh.receiveShadow = true;
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
    filtreraTrad(mesh);          // kronorna, inte stammarna: bark ska inte bli grönare
    return mesh;
  };
  /* U7 punkt 5: LOD. Etappen skrev "billboards bortom 250 m", alltså ett
   * avstånd från KAMERAN — men det avståndet ändras varje bildruta, och att
   * bygga om instansbuffertarna per bildruta kostar mer än det sparar för de
   * här trädantalen (≤ 100 per hål). Det som faktiskt hotar budgeten är inte
   * trianglarna utan SKUGGPASSET, som ritar geometrin en gång till.
   *
   * Delningen görs därför på avstånd från HÅLLINJEN, en gång vid bygget:
   * kameran tittar praktiskt taget alltid längs korridoren, så träd långt ut i
   * sidled (U15:s kjol) är de som alltid är små i bild. De får grövre kronor
   * och kastar INGEN skugga — en skugga 150 m ut i sidled syns inte, men den
   * kostar lika mycket som en vid tee. Träd nära linjen är oförändrade. */
  const langtUt = ti => {
    const [x, , z] = trees[ti];
    return avstandTillLinje(x, z) > LOD_M;
  };
  const hink = ti => (ti * 2654435761 >>> 0) % HINKAR.length;
  const geoNara = { kon: new THREE.ConeGeometry(1, 1, 7),
                    sfar: new THREE.SphereGeometry(1, 8, 6) };
  const geoFjarran = { kon: new THREE.ConeGeometry(1, 1, 4),
                       sfar: new THREE.SphereGeometry(1, 5, 3) };
  const kronor = [];
  for (const fjarran of [false, true]) {
    const g = fjarran ? geoFjarran : geoNara;
    const rgh_hinkar = fjarran ? [HINKAR[1]] : HINKAR;   // fjärran: en hink räcker
    rgh_hinkar.forEach((rgh, h) => {
      const valj = (arr) => arr.filter(ti => langtUt(ti) === fjarran
                                       && (fjarran || hink(ti) === h));
      const k = makeCrowns(g.kon, valj(coneIdx), true, rgh, !fjarran);
      const s = makeCrowns(g.sfar, valj(sphIdx), false, rgh, !fjarran);
      kronor.push(k, s);
    });
  }

  const qi = new THREE.Quaternion();
  trees.forEach(([x, gy, z, h, , , , baseFrac], i) => {
    const base = gy * exag;
    const cb = Math.max(baseFrac * h, 0.3);
    const tr = Math.max(0.1, 0.05 * h);
    p.set(x, base + cb / 2, z); s.set(tr, cb, tr);
    trunks.setMatrixAt(i, m.compose(p, qi, s));
  });

  const parts = [trunks, ...kronor.filter(Boolean)];
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
const OMBYGG_ORDNING = ['trad', 'hinder', 'linje', 'slope', 'slag', 'sikte'];
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

// ------------------------------ U19: PLANENS slag på hålet, i 3D ------------
// Slagen här är de PLANERADE slagen och inga andra (§5 U19). Fram till U19 kom
// de ur `Store` — en gammal rundas loggade slag — och det var fel plats: i
// planeringsvyn är ett facit inte det man planerar, och ett facit med sex
// reglage under sig är den förfalskning U17 själv förbjöd. Loggade slag bor i
// analysen; jämförelsen plan mot utfall är PC_ANALYS_PLAN §P6:s jobb.
//
// FORMEN är oförändrad och fortfarande PC-vyns: en båge, inte ett streck på
// marken. Kartan ritade streck för att den bara har två dimensioner; i 3D finns
// höjdleden, och då är bågen det sanna svaret.
//
// Och TALEN räknas inte här. `Planslag` äger hela kedjan — sträcka, Δh, vind,
// "spelar som", apex, spridning — och den här filen ritar det den får. Det är
// hela skälet till att 2D-listan och 3D-bågen inte kan säga olika saker om
// samma slag (princip 4).
const PLAN_FARG = 0x37b06b;        // samma gröna som 2D-kartans plan-pins
const PLAN_FARG_HEX = '#37b06b';
let shotObjs = [], shotVisa = true;
let planTee = null, planLegs = [], planGreen = null;   // lat/lon, satt av värdsidan
let planSlagval = {};                                  // GP2: klubbval per slag, ur Vylage
let KEDJA = [];                    // Planslag-raderna som just ritades

function nummerSprite(n, hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = hex; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  // U8: konturen är MÖRK, inte vit. En vit ring runt en ljus bricka försvinner
  // mot sand och mot solblekt fairway — och det är precis där siffran behöver
  // läsas. Färgen är `--overlay-kontur`, samma som resten av lagret.
  g.lineWidth = 4; g.strokeStyle = OKONTUR(); g.stroke();
  g.fillStyle = '#0c2e22'; g.font = '700 34px -apple-system,Segoe UI,Roboto,sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(7, 7, 1);
  return s;
}

/* U8: overlay-lagrets konturfärg. Läses ur `tokens.css` via MapCore.token —
   en canvas-kontext tar inte `var(--x)` (samma fälla som Leaflets options,
   §U3), så tokenen måste slås upp och inte skrivas av. */
const OKONTUR = () => (typeof TOK === 'function' && TOK('--overlay-kontur')) || '#000';

/* U8: ett avståndschip PÅ segmentet — inte i en lista vid sidan.
   Mörk kontur runt både bricka och text, för samma skäl som numren ovan: chipet
   ska gå att läsa mot ljus sand i solljus. */
function chipSprite(text) {
  const pad = 10, h = 40;
  const matt = document.createElement('canvas').getContext('2d');
  matt.font = '700 26px -apple-system,Segoe UI,Roboto,sans-serif';
  const b = Math.ceil(matt.measureText(text).width) + pad * 2;
  const c = document.createElement('canvas');
  c.width = b; c.height = h + 8;
  const g = c.getContext('2d');
  const r = 9, y0 = 4, hh = h;
  g.beginPath();
  g.moveTo(r, y0); g.arcTo(b, y0, b, y0 + hh, r); g.arcTo(b, y0 + hh, 0, y0 + hh, r);
  g.arcTo(0, y0 + hh, 0, y0, r); g.arcTo(0, y0, b, y0, r); g.closePath();
  g.fillStyle = 'rgba(22,34,30,.78)'; g.fill();
  g.lineWidth = 3; g.strokeStyle = OKONTUR(); g.stroke();
  g.font = '700 26px -apple-system,Segoe UI,Roboto,sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 4; g.strokeStyle = OKONTUR();
  g.strokeText(text, b / 2, y0 + hh / 2 + 1);
  g.fillStyle = '#edf3f0';
  g.fillText(text, b / 2, y0 + hh / 2 + 1);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  // Skalan hålls i METER så chipet krymper med avståndet precis som marken —
  // ett chip i konstant skärmstorlek hade lossnat från segmentet det hör till.
  s.scale.set(b / 40 * 8, (h + 8) / 40 * 8, 1);
  return s;
}

/* U8: kryssmarkör i en nod. Siktlinjens noder var kulor, och en kula på marken
   säger "här ligger något" — ett kryss säger "HÄR", vilket är vad en siktepunkt
   betyder. Ritas platt på marken så den läses som en markering och inte som ett
   föremål. */
function kryssMarkor(x, z, farg, r) {
  const y = surfaceYAt(x, z, 0) + LINE_OFFSET;
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x - r, y, z), new THREE.Vector3(x + r, y, z),
    new THREE.Vector3(x, y, z - r), new THREE.Vector3(x, y, z + r),
  ]);
  return new THREE.LineSegments(g,
    new THREE.LineBasicMaterial({ color: farg, depthTest: false }));
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

/* ------------------------------------------- U8: hinderlagret --------------
 *
 * "Allt som behövs för att läsa hålet ligger på banan, inte i en sidopanel."
 * Hindren ritas som halvgenomskinlig fyllning MED KONTUR — konturen är det som
 * gör att ytan läses som ett lager och inte som en färgfläck i ortofotot, och
 * utan den försvinner en dammig bunker helt i det gråtonade fotot (§ORTOFOTO_FARG).
 *
 * DATAN KOMMER UR BANDATAN, INTE UR 3D-METAN. `holes3d/<hål>.json` bär ingen
 * hinderpolygon — men `data/burlov.json` gör det (`hazards: [{type, poly}]`,
 * lat/lon), och den laddar appen redan för 2D-kartan. Att i stället exportera
 * hindren en gång till i 3D-bunten hade gjort samma polygon till två filer som
 * kan glida isär, och krävt en pipeline-körning per bana för något som redan
 * finns. Värdsidan skickar in dem, som den skickar planen.
 */
let hinderObjs = [], hinderData = [];

const HINDER_FARG = { water: '--vatten', bunker: '--fara' };

function rensaHinder() {
  hinderObjs.forEach(o => {
    scene.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.();
  });
  hinderObjs = [];
}

function buildHinder() {
  rensaHinder();
  if (!meta || !meta.ll2xz || !hinderData.length) return;
  for (const [i, hz] of hinderData.entries()) {
    const poly = (hz && hz.poly) || [];
    if (poly.length < 3) continue;              // en yta behöver tre hörn
    const xz = poly.map(ll => planPunkt(ll));
    const tok = HINDER_FARG[hz.type] || '--fara';
    const farg = new THREE.Color(
      (typeof TOK === 'function' && TOK(tok)) || '#ff5a4d');

    // Fyllningen: triangulerad i markplanet och sedan LYFT PER HÖRN till
    // terrängen. En plan yta hade skurit genom en sluttning och sett ut som en
    // glasskiva, vilket är exakt fel intryck för något som ligger PÅ marken.
    const shape = new THREE.Shape(xz.map(p => new THREE.Vector2(p.x, p.z)));
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), z = pos.getY(v);
      pos.setXYZ(v, x, surfaceYAt(x, z, 0) + LINE_OFFSET * 0.5, z);
    }
    geo.computeVertexNormals();
    const yta = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: farg, transparent: true, opacity: 0.28,
      side: THREE.DoubleSide, depthWrite: false }));
    yta.name = `hinder-yta-${hz.type}-${i}`;
    scene.add(yta); hinderObjs.push(yta);

    // Konturen — hela poängen med etappen. Den ligger något högre än
    // fyllningen så den aldrig z-fightar med sin egen yta.
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(xz.map(p =>
        new THREE.Vector3(p.x, surfaceYAt(p.x, p.z, 0) + LINE_OFFSET, p.z))),
      new THREE.LineBasicMaterial({ color: farg, transparent: true, opacity: 0.95 }));
    ring.name = `hinder-kontur-${hz.type}-${i}`;
    scene.add(ring); hinderObjs.push(ring);
  }
}

const omHinder = () => schemalagg('hinder', buildHinder);


/* Värdsidan äger bandatan och skickar hindren hit — samma riktning som
   `sattPlanLegs`. Motorn slår aldrig upp en bana själv. */
function sattHinder(lista) {
  hinderData = Array.isArray(lista) ? lista.filter(h => h && Array.isArray(h.poly)) : [];
  buildHinder();
}

/* Kedjans punkter i scenens ram. `Planslag` arbetar i lat/lon (samma valuta som
   2D-kartan och som Vylage lagrar); scenen arbetar i hålets lokala meter. Här
   är ENDA stället som växlar mellan dem, via `hojdprofil.js` där affinen bor. */
function planPunkt(ll) {
  const [x, z] = HP.latLonToXz(meta.ll2xz, ll[0], ll[1]);
  return { x, z };
}

/* Tee-punkten för planen. Värdsidan skickar den (`MapCore.teePoint` — spelarens
   valda tee, T1:s sanning); saknas den faller vi tillbaka på hållinjens start,
   som är samma punkt hålets egen linje ritas från. Aldrig en gissning. */
function planTeeLL() {
  if (planTee) return planTee;
  if (!meta || !meta.line || !meta.line.length) return null;
  const t = meta.line[0];
  return xzLL(t[0], t[2]);
}

/* Vad `Planslag` behöver för att räkna: allt som rör omvärlden, injicerat.
   Höjden kommer ur markindexet (U18) och INTE ur `PlayAs.elev3dAt` — vi står i
   scenen och har den exakta ytan här; ett andra höjduppslag hade kunnat svara
   något annat om samma punkt. Överdriften delas bort: Δh ska vara sanna meter,
   inte ritade. */
function planDeps() {
  return {
    hav: MapCore.hav, bearing: MapCore.bearing,
    relWind: PlayAs.relWind, windAlongShift: PlayAs.windAlongShift,
    slopeEffect: PlayAs.slopeEffect,
    hojd: (lat, lon) => {
      const p = planPunkt([lat, lon]);
      const y = surfaceYAt(p.x, p.z, NaN);
      return isFinite(y) ? y / (exag || 1) : null;
    },
    spridning: dist => Spelprofil.spridning(Store.profile(), dist),
    // GP2: klubbvalets tal. Slås upp här och inte i Planslag, som ska förbli
    // ren — och genom SAMMA funktion som 2D-sidan använder, så en klubba inte
    // kan betyda olika i de två vinklarna.
    klubbslag: (dist, val) => Spelprofil.slagFor(Store.profile(), dist, val),
    effektiv: SlagJust.effektiv,
    bollbana: Bollbana, vind3d: Vind3D,
  };
}

/* Kedjan för en godtycklig uppsättning landningspunkter. Utan argument är det
   PLANEN som den står — det är den formen scenen ritar och 2D-listan skriver ut.
   Med `[]` blir det hålet som ett enda slag, tee→green, vilket är exakt frågan
   vyns rubrik ställer. Att rubriken går genom SAMMA funktion är hela poängen:
   den räknade förut själv och svarade 358 där listan sa 360. */
function planKedja(legsOverride) {
  if (!meta || !meta.ll2xz) return [];
  return Planslag.kedja(
    { tee: planTeeLL(), legs: legsOverride || planLegs, green: planGreen,
      vind: vindNu(), just: legsOverride ? {} : slagJust,
      // Ett override-anrop (rubrikens tee→green) är en ANNAN kedja än planens:
      // dess slag har inga val, precis som det inte har några justeringar.
      slagval: legsOverride ? {} : planSlagval }, planDeps());
}

function buildShots() {
  shotObjs.forEach(o => { scene.remove(o); o.geometry?.dispose?.();
    o.material?.map?.dispose?.(); o.material?.dispose?.(); });
  shotObjs = [];
  KEDJA = planKedja();
  el('slaginfo').hidden = !(shotVisa && KEDJA.length);
  el('slaginfo').textContent = KEDJA.length ? `${KEDJA.length} planerade slag` : '';
  if (!KEDJA.length || !shotVisa) {
    // U17: finns inga bågar finns inget valt slag — annars kan panelen stå kvar
    // och visa tal för ett slag som inte längre är ritat.
    valtSlag = null; slagTal = []; ritaSlagPanel(); ritaKedjeknapp();
    if (kedjaPa) kedjaPa(KEDJA);
    omSikte();
    return;
  }
  if (ground) ground.updateMatrixWorld(true);

  slagTal = [];
  for (const rad of KEDJA) {
    const i = rad.idx;
    const a = planPunkt(rad.a), b = planPunkt(rad.b);
    const langd = Math.hypot(b.x - a.x, b.z - a.z);
    if (langd < 1) continue;
    const y0 = surfaceYAt(a.x, a.z, 0) + LINE_OFFSET;
    const y1 = surfaceYAt(b.x, b.z, 0) + LINE_OFFSET;
    // Bågens höjd läggs på i SANNA meter ovanpå kordan mellan ändpunkterna, som
    // själva sitter på den överdrifts-skalade marken. Apex skalas alltså ALDRIG
    // med överdriften — samma princip som träden: en boll som gick 27 m upp gick
    // 27 m upp, hur mycket vi än överdriver terrängen.
    const arc = Bollbana.arcHeights(rad.dist, rad.traj);
    // W2: sidvinden. Bollen siktas uppvinds och drivs mot nedslaget, så
    // flygvägen ligger UPPVINDS om kordan — noll i båda ändar, störst i mitten.
    const vind = rad.vind;
    let sido = [0, 0];
    if (rad.drift && vind && vind.side) {
      const hoger = [-(b.z - a.z) / langd, (b.x - a.x) / langd];   // 90° medsols
      sido = vind.side === 'H' ? [-hoger[0], -hoger[1]] : hoger;   // uppvinds
    }
    const pts = arc.map((h, k) => {
      const t = k / (arc.length - 1);
      const off = rad.drift * Vind3D.crossBowShape(t);
      return new THREE.Vector3(a.x + (b.x - a.x) * t + sido[0] * off,
                               y0 + (y1 - y0) * t + h,
                               a.z + (b.z - a.z) * t + sido[1] * off);
    });
    // W3: byigheten gör nedslaget till en fördelning, inte en punkt.
    if (rad.gustE)
      ritaEllips(a, b, rad.gustE.aCross, rad.gustE.aAlong, 0x9fc4ae, 0.7, `slag-by-${i}`);
    // U17 + GP1: spridningsellipsen. Två olika saker med samma form, och de
    // får inte se likadana ut: profilens tal är en MODELL (spelprofilens hink),
    // spelarens egen siffra ett ANTAGANDE. Färgen och namnet i scengrafen
    // skiljer dem, och panelen skriver ut vilket det är.
    const eff = rad.eff;
    if (eff.sprCross > 0 || eff.sprAlong > 0)
      ritaEllips(a, b, eff.sprCross || 0.1, eff.sprAlong || 0.1,
                 eff.sprKalla === "egen" ? 0xffcf4d : 0x8fd6ff, 0.75,
                 `slag-spridning-${eff.sprKalla}-${i}`);
    // U17: ett ändrat slag ska SE ändrat ut (annars tror spelaren att den
    // skruvade bågen är modellens svar), och det valda ska synas som valt. Det
    // första är en ärlighetsregel, det andra bara UI — därför olika medel:
    // genomskinlighet för "ändrad", självlysning för "vald".
    const vald = valtSlag === i;
    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(PLAN_FARG),
      transparent: eff.andrad, opacity: eff.andrad ? 0.55 : 1,
      emissive: new THREE.Color(vald ? 0x445511 : 0x000000) });
    const ror = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32,
                             vald ? 0.7 : 0.4, 5), mat);
    ror.name = `slag-ror-${i}${eff.andrad ? '-andrad' : ''}${vald ? '-vald' : ''}`;
    ror.userData.slagIdx = i;
    scene.add(ror); shotObjs.push(ror);
    // Panelens tal kommer ur SAMMA rad som just ritade bågen — inte ur en
    // andra beräkning.
    slagTal[i] = { ...rad, apex: rad.traj.apex, launch: rad.vinklar.launch,
                   desc: rad.vinklar.desc, pts };

    /* U8: avståndet som ett chip PÅ segmentet, inte i en lista vid sidan.
       Talet är "spelar som" och inte den geometriska sträckan — det är det
       spelaren agerar på (samma val som U19 gjorde för 2D-listan och för
       panelens rubrik), och två olika tal om samma ben vore precis det
       princip 4 kallar värre än inget svar. Chipet sitter lågt över MARKEN
       mitt på benet och inte på bågens topp: det hör till sträckan, och en
       etikett som svävar högt läses som en höjd. */
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const chip = chipSprite(`${rad.spelarSom} m`);
    chip.position.set(mx, surfaceYAt(mx, mz, 0) + 4.5, mz);
    chip.name = `slag-chip-${i}`;
    scene.add(chip); shotObjs.push(chip);
  }

  // Punkterna: tee är slag 1 och kan inte flyttas; landningspunkterna är
  // spelarens egna. Samma numrering och samma gröna som 2D-kartans pins —
  // en punkt satt i den ena vinkeln ska vara igenkännlig i den andra.
  const punkter = [planTeeLL(), ...planLegs].filter(Boolean);
  punkter.forEach((ll, i) => {
    const p = planPunkt(ll);
    const y = surfaceYAt(p.x, p.z, 0);
    const kula = new THREE.Mesh(new THREE.SphereGeometry(valtSlag === i ? 2.4 : 1.7, 12, 10),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(PLAN_FARG),
        emissive: new THREE.Color(valtSlag === i ? 0x445511 : 0x000000) }));
    kula.position.set(p.x, y + LINE_OFFSET, p.z);
    kula.name = `plan-punkt-${i}`;
    kula.userData.slagIdx = i;    // kulan väljer slaget som slås DÄRIFRÅN
    scene.add(kula); shotObjs.push(kula);
    /* U8: kryss i noden. Kulan finns kvar som TRÄFFYTA — den är det man
       trycker på, och ett kryss av linjer är nästan omöjligt att träffa med en
       tumme. Krysset är markeringen: det säger "här", vilket är vad en
       siktepunkt betyder, medan en ensam kula säger "här ligger något". */
    const kryss = kryssMarkor(p.x, p.z, new THREE.Color(PLAN_FARG), 4.5);
    kryss.name = `plan-kryss-${i}`;
    scene.add(kryss); shotObjs.push(kryss);
    const nr = nummerSprite(i + 1, PLAN_FARG_HEX);
    nr.position.set(p.x, y + 7, p.z);
    nr.name = `plan-nummer-${i}`;
    scene.add(nr); shotObjs.push(nr);
  });

  ritaSlagPanel();     // U17: panelen läser slagTal som just fylldes i
  ritaKedjeknapp();
  if (kedjaPa) kedjaPa(KEDJA);   // U19: 2D-listan skriver om sig ur samma rader
  // U16 steg 4: siktet ärver apexen ur slagTal ovan — och U18:s kö garanterar
  // ordningen (linje → slag → sikte) och att det bara sker EN gång per ruta,
  // även när både linjen och slagen byggts om i samma bildruta.
  omSikte();
}

/* Slag-knappen speglar planen: finns en kedja går den att stänga av och på,
   annars står den avstängd med skälet utskrivet. En knapp som ser klickbar ut
   men inte gör något är sämre än en som ärligt visar varför (U4). */
function ritaKedjeknapp() {
  const knapp = el('vSlag');
  if (!knapp) return;
  const har = KEDJA.length > 0;
  knapp.disabled = !har;
  knapp.title = har ? `${KEDJA.length} planerade slag — tryck för att dölja`
                    : 'Ingen plan för hålet än — tappa en landningspunkt';
  knapp.setAttribute('aria-pressed', String(shotVisa && har));
  const slaget = el('vSlaget');
  if (slaget) {
    slaget.disabled = !har;
    slaget.title = har ? 'Välj ett slag och ändra apex, vind och spridning'
                       : 'Ingen plan för hålet än — tappa en landningspunkt';
  }
}


// -------------------------------------------- U13/U20: green-lutningen i 3D ---
/* Samma data och samma palett som 2D-kartan: heatmapens PIXLAR kommer ur
 * `SlopeOverlay.heatCanvas` (utbruten just för detta) och pilarna ur samma
 * `fall`-features. Två paletter kunde ha glidit isär och gett samma lutning två
 * färger i samma app (princip 4).
 *
 * DRAPERAD, inte platt. Ytan byggs som ett rutnät vars y kommer ur markens egen
 * höjd (`surfaceYAt`) plus en liten offset, så färgen ligger PÅ greenen och
 * följer överdriften. En platt matta hade sett rätt ut rakt uppifrån och legat i
 * luften så fort kameran sänktes — och det är i den sänkta vinkeln lutningen
 * betyder något.
 *
 * Pilarna är scenobjekt i världskoordinater (§2.2: då kan de inte släpa) och
 * har fast METERstorlek. 2D:s skärmkonstanta storlek är fel i perspektiv — en
 * pil 200 m bort ska se mindre ut, annars ljuger bilden om var man står.
 */
const SLOPE_LYFT = 0.25;      // m över marken: räcker för z-fighting, syns inte
const SLOPE_RUTA = 1.5;       // m mellan noder i det draperade rutnätet
const SLOPE_PIL_M = 1.6;      // m: pillängd, samma i hela scenen
let slopeObjs = [], slopeHal = null, slopeVisa = false;

function rensaSlope() {
  slopeObjs.forEach(o => { scene.remove(o); o.geometry?.dispose?.();
    o.material?.map?.dispose?.(); o.material?.dispose?.(); });
  slopeObjs = [];
}

/** Är lutningen ritbar för hålet? Utan data ska knappen inte ens finnas (U20). */
function harSlope(h) {
  return !!(h && typeof SlopeOverlay !== 'undefined' && SlopeOverlay.heatCanvas(h));
}

function ritaSlope() {
  rensaSlope();
  const h = slopeHal;
  if (!slopeVisa || !h || !meta || !meta.ll2xz) return;
  if (typeof SlopeOverlay === 'undefined') return;
  const c = SlopeOverlay.heatCanvas(h);
  if (!c) return;

  // --- heatmapen som draperat rutnät ---
  // Hörnen kommer ur canvasens lat/lon-ram; noderna läggs i scenens ram och får
  // markens höjd. UV:n är rutnätets egen (0..1), så texturen sitter fast i
  // marken och inte i kameran.
  const hornXZ = (lat, lon) => HP.latLonToXz(meta.ll2xz, lat, lon);
  const h00 = hornXZ(c.latMin, c.lonMin), h10 = hornXZ(c.latMin, c.lonMax),
        h01 = hornXZ(c.latMax, c.lonMin);
  const bredd = Math.hypot(h10[0] - h00[0], h10[1] - h00[1]);
  const hojd = Math.hypot(h01[0] - h00[0], h01[1] - h00[1]);
  const nx = Math.max(2, Math.min(140, Math.round(bredd / SLOPE_RUTA)));
  const nz = Math.max(2, Math.min(140, Math.round(hojd / SLOPE_RUTA)));
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++) {
    const fy = j / nz;
    for (let i = 0; i <= nx; i++) {
      const fx = i / nx;
      const lat = c.latMin + (c.latMax - c.latMin) * fy;
      const lon = c.lonMin + (c.lonMax - c.lonMin) * fx;
      const [x, z] = hornXZ(lat, lon);
      pos.push(x, surfaceYAt(x, z, 0) + SLOPE_LYFT, z);
      // Canvasens rad 0 är NORDLIGAST (latMax) — därför vänds v-axeln.
      uv.push(fx, fy);
    }
  }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const matta = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.95, depthWrite: false,
    side: THREE.DoubleSide }));
  matta.renderOrder = 2;
  matta.name = 'slope-heat';
  scene.add(matta); slopeObjs.push(matta);

  // --- fallpilarna ---
  // Riktningen är featurens `bearing` i SANNA grader; scenens ram bär SWEREF:s
  // gridnorr. Skillnaden är ~1,6° här och den ska inte ätas upp av en
  // approximation: pilspetsen räknas fram i lat/lon och växlas sedan över, precis
  // som allt annat som kommer utifrån.
  const fall = SlopeOverlay.fallFor(h) || [];
  const dest = (lat, lon, brg, m) => {
    const br = brg * Math.PI / 180;
    return [lat + (m * Math.cos(br)) / 111320,
            lon + (m * Math.sin(br)) / (111320 * Math.cos(lat * Math.PI / 180))];
  };
  const linjer = [];
  for (const f of fall) {
    const p = f.properties || {};
    if (!(p.slope_pct >= 1.3)) continue;      // samma tröskel som 2D nära green
    const lon0 = f.geometry.coordinates[0][0], lat0 = f.geometry.coordinates[0][1];
    const [lat1, lon1] = dest(lat0, lon0, p.bearing, SLOPE_PIL_M);
    const [x0, z0] = hornXZ(lat0, lon0), [x1, z1] = hornXZ(lat1, lon1);
    linjer.push(new THREE.Vector3(x0, surfaceYAt(x0, z0, 0) + SLOPE_LYFT + 0.05, z0));
    linjer.push(new THREE.Vector3(x1, surfaceYAt(x1, z1, 0) + SLOPE_LYFT + 0.05, z1));
    // Spetsen: två korta streck bakåt från nedförs-änden. Billigare än en mesh
    // per pil, och en green har hundratals.
    for (const v of [110, -110]) {
      const [lat2, lon2] = dest(lat1, lon1, p.bearing + v, SLOPE_PIL_M * 0.36);
      const [x2, z2] = hornXZ(lat2, lon2);
      linjer.push(new THREE.Vector3(x1, surfaceYAt(x1, z1, 0) + SLOPE_LYFT + 0.05, z1));
      linjer.push(new THREE.Vector3(x2, surfaceYAt(x2, z2, 0) + SLOPE_LYFT + 0.05, z2));
    }
  }
  if (linjer.length) {
    const pilar = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(linjer),
      new THREE.LineBasicMaterial({ color: 0x1b2b1f, transparent: true, opacity: 0.9 }));
    pilar.renderOrder = 3;
    pilar.name = 'slope-pilar';
    scene.add(pilar); slopeObjs.push(pilar);
  }
}

const omSlope = () => schemalagg('slope', ritaSlope);

/** Värdsidan slår på/av lutningen; `h` är 2D-hålet (green-polygonen bor där). */
function sattSlope(pa, h) {
  slopeVisa = !!pa;
  slopeHal = h || null;
  omSlope();
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
  // U19: rubriken bär det tal spelaren faktiskt ska agera på — "spelar som",
  // alltså sträckan med vind och höjd inräknad. Den geometriska står bredvid
  // när de skiljer sig; är de lika vore två siffror bara brus.
  const geo = Math.round(t.dist);
  el('slagnr').textContent = `Slag ${t.nr} · spelar som ${t.spelarSom} m`
    + (geo !== t.spelarSom ? ` (${geo} m)` : '');
  el('slagandrad').hidden = !t.andrad;
  el('slagtal').innerHTML =
    (t.dh != null && Math.abs(t.dh) >= 1
      ? `${t.dh > 0 ? '↗' : '↘'} <b>${Math.abs(t.dh).toFixed(0)} m</b> · ` : '') +
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
    e.sprKalla === 'klubba' ? `ur klubbtrappan (${t.klubba ? t.klubba.label : 'vald klubba'})`
    : e.sprKalla === 'profil' ? 'ur din spelprofil'
    : e.sprKalla === 'egen' ? 'ditt eget antagande'
    : 'ingen profil än — fyll i den under Profil';
  el('sAter').disabled = !t.andrad;
  el('sAterAlla').disabled = SlagJust.antalAndrade(slagJust) === 0;
  ritaKlubbval(t);
}

/* ------------------------------------------- GP2: panelens klubbval --------
 *
 * Listorna ritas ur `Spelprofil` och aldrig ur en egen tabell här: ett
 * alternativ som står i panelen men inte finns i modellen är ett löfte appen
 * inte kan hålla. Saknas klubbtrappan (offline första gången, eller
 * opublicerad tabell) göms hela avsnittet och skälet skrivs ut — hellre ingen
 * fråga än en fråga vars svar inte betyder något.
 */
function chip(txt, valt, onClick, titel) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = txt;
  b.setAttribute('aria-pressed', String(!!valt));
  if (titel) b.title = titel;
  b.addEventListener('click', onClick);
  return b;
}

/* En rad chips där `standard` är förvalt när spelaren inte svarat. Ett tryck
   på det redan valda tar bort svaret — samma beteende som GP1:s guide, av
   samma skäl: en felträffning ska gå att ångra utan att svara något annat. */
function ritaChiprad(id, lista, valt, standard, satt) {
  const box = el(id);
  box.innerHTML = '';
  for (const o of lista) {
    const aktiv = valt ? valt === o.id : o.id === standard;
    box.appendChild(chip(o.label, aktiv, () => satt(valt === o.id ? null : o.id)));
  }
}

const listNamn = (lista, id, standard) =>
  (lista.find(o => o.id === (id || standard)) || { label: '' }).label.toLowerCase();

function ritaKlubbval(t) {
  const listor = Spelprofil.valListor();
  const trappa = Spelprofil.klubbtrappa(Store.profile());
  const visa = !!(listor && trappa);
  for (const id of ['valKlubba', 'valForm', 'valAnsats', 'valHojd']) {
    const g = el(id) && el(id).closest('.valgrupp');
    if (g) g.hidden = !visa;
  }
  const rub = el('klubbtal'), prof = el('sProfil');
  if (!visa) {
    if (rub) rub.textContent =
      'Klubbtrappan saknas — fyll i Profil, eller ladda om när du har nät.';
    if (prof) prof.hidden = true;
    return;
  }
  if (prof) prof.hidden = false;

  const val = slagvalNu(t.idx);
  const k = t.klubba;          // slagets FAKTISKA rad (vald eller föreslagen)

  // Talen FÖRST. "Driver, full: 232 m, ±26 m sidled" — panelen ska säga vad
  // valet betyder innan den frågar efter nästa val (§GP2: aldrig en svart låda).
  if (rub && k) {
    rub.innerHTML =
      `<b>${k.label}</b>, ${listNamn(listor.ansats, val.ansats, 'full')}: ` +
      `<b>${Math.round(k.langd)} m</b> · ±${Math.round(k.cross)} m sidled` +
      (k.foreslagen ? ' <span style="opacity:.65">(föreslagen för avståndet)</span>' : '') +
      // Ett val som inte når fram är fortfarande ett giltigt val (lägg upp!) —
      // men planen får inte låtsas att bollen kommer fram.
      (k.racker ? ''
        : `<br><span class="varn">Når inte fram — ${Math.round(t.spelarSom)} m spelar som.</span>`);
  }

  // Klubbraden. Längden står PÅ chipen: frågan "vad slår du här?" går inte att
  // svara på utan att se hur långt klubborna går.
  const kl = el('valKlubba');
  kl.innerHTML = '';
  for (const c of trappa.klubbor) {
    const vald = val.klubba === c.id;
    kl.appendChild(chip(`${c.label} ${Math.round(c.langd)}`, vald,
      () => sattVal(t.idx, { klubba: vald ? null : c.id }),
      `${c.label}: ${Math.round(c.langd)} m, ±${Math.round(c.across_sd)} m sidled`));
  }
  // Rulla fram valet — annars ligger ett valt 9-järn utanför bild och panelen
  // ser ut att sakna svar.
  const aktiv = kl.querySelector('[aria-pressed="true"]')
    || (k && [...kl.children].find(b => b.textContent.startsWith(k.label)));
  if (aktiv) kl.scrollLeft = Math.max(
    0, aktiv.offsetLeft - kl.clientWidth / 2 + aktiv.offsetWidth / 2);

  ritaChiprad('valForm', listor.form, val.form, 'rakt', v => sattVal(t.idx, { form: v }));
  ritaChiprad('valAnsats', listor.ansats, val.ansats, 'full', v => sattVal(t.idx, { ansats: v }));
  ritaChiprad('valHojd', listor.hojd, val.hojd, 'normal', v => sattVal(t.idx, { hojd: v }));

  if (prof) prof.disabled = Object.keys(val).length === 0;
}

/* Valet ÄGS av planen (Vylage), inte av motorn — till skillnad från U17:s
   justeringar, som är ett visningslager och medvetet inte sparas. Skillnaden
   är avsiktlig: "jag slår 6-järn här" är ett beslut om hålet och ska finnas
   kvar nästa gång, "visa mig hur det ser ut med högre apex" är en fråga.
   Motorn bär därför bara en KOPIA (`planSlagval`) och skickar ändringen till
   värdsidan, som skriver — samma riktning som tapp-kontraktet (§5 U11). */
let slagvalPa = null;
const paSlagval = fn => { slagvalPa = fn; };
const slagvalNu = i => ({ ...(planSlagval[i] || {}) });

function sattVal(i, patch) {
  const nu = slagvalNu(i);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete nu[k]; else nu[k] = v;
  }
  if (Object.keys(nu).length) planSlagval[i] = nu; else delete planSlagval[i];
  if (slagvalPa) slagvalPa(i, Object.keys(nu).length ? nu : null);
  omSlag();          // §2: ellipsen ritas om i SAMMA bildruta som marken
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

/* GP2: `Återställ till min profil` tar bort HELA slagets val — klubba, form,
   ansats och höjd på en gång. Att bara nollställa ett fält i taget hade
   lämnat spelaren att gissa vilka som fortfarande avvek, och panelen markerar
   avvikelsen på slaget och inte per rad. */
el('sProfil').addEventListener('click', () => {
  if (valtSlag == null) return;
  delete planSlagval[valtSlag];
  if (slagvalPa) slagvalPa(valtSlag, null);
  omSlag();
});

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
  spannUpp();     // U7: höjdskalan flyttar kronorna → skuggkameran måste följa
  omTrad();
  omLinje();
  omHinder();        // U8: hinderytorna ligger PÅ marken → följer överdriften
  omSlope();         // lutningsmattan draperas på marken → likaså
  omSlag();          // planens slag ligger på marken → räknas om med den
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

/* ÖVERBLICKEN — startvyn, och SAMMA ram som 2D-kartan visar.
 *
 * Var: en fast regel (0,45·längden bakom teen, 0,18·längden upp) som gav tilt
 * ~79° — nästan från sidan — medan 2D ramade in hela hålet ovanifrån och ett
 * vinkelbyte landade på tilt 55°. Tre olika bilder av samma hål, och bytet
 * mellan dem syntes som ett hopp.
 *
 * Nu: `overviewState` passar in hålets punkter i bilden precis som Leaflets
 * `fitBounds(...).pad(0.12)` gör i 2D, med bytets egen lutning (55°). Samma
 * ram, samma lutning, oavsett hålets längd och skärmens format.
 *
 * Fortfarande utbruten ur placeCamera() så samma vy kan flygas till när U6:s
 * Höjd-läge slås på — hela hållinjen och profilens markör ska rymmas i bild.
 */
/* Lutningen ÄGS av Vybro (`TILT_3D` — den vinkelbytet sjunker ner till). Att
   skriva 55° här hade varit en andra kopia som kan glida ifrån bytet, och då
   landar man på en annan bild än den man startar i. */
const OVERBLICK_TILT = Vybro.TILT_3D;

function overviewState() {
  if (!meta || !meta.line || meta.line.length < 2) return null;
  const pts = meta.line.map(([x, y, z]) => ({ x, y: y * exag, z }));
  return camOverviewState(pts, {
    fovDeg: camera.fov, aspect: camera.aspect, tilt: OVERBLICK_TILT });
}

function placeCamera() {
  const s = overviewState();
  if (!s) return;
  // Uttryckt i kontrollerns fyra tal — så att en efterföljande gest utgår från
  // den och inte från något annat.
  controls.setState(s);
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
  // "· ungefärlig plats" (T1): tee:n är syntetisk — avståndet stämmer mot
  // scorekortet, men sidoläget är ärvt. Säg det hellre än att visa en gissad
  // punkt som ser exakt ut.
  el('hojdLangd').textContent = net.tee
    ? `vald tee ${net.tee} · ${net.len ?? meta.length_m} m`
      + (net.approx ? ' · ungefärlig plats' : '')
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

/** Kedjan som ska ritas. Anropas av planvy.html vid varje ändring i Vylage.
 *
 * U19: det som ritas är SLAGEN (bågar med vindens verkan), inte längre ett
 * platt streck på marken bredvid dem. Punkterna kommer in i lat/lon — samma
 * valuta som Vylage lagrar och som 2D-kartan använder — och räknas om med
 * hålets egen ll2xz-affin. Det är DEN som gör att en punkt satt i 2D hamnar på
 * exakt samma gräs i 3D.
 */
function sattPlanLegs(plan) {
  const o = plan || {};
  const ll = p => (Array.isArray(p) && p.length === 2) ? [+p[0], +p[1]] : null;
  planTee = ll(o.tee);
  planLegs = (o.legs || []).map(ll).filter(Boolean);
  planGreen = ll(o.green);
  // GP2: valen bor i Vylage (planen), inte här. Motorn får dem samma väg som
  // punkterna — en ägare, två skepnader (§5 U11).
  planSlagval = (o.slagval && typeof o.slagval === 'object') ? { ...o.slagval } : {};
  omSlag();
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
    // U7: marken TAR EMOT skuggor men kastar inga — den är en enda yta, så en
    // självskugga blir akne och inte relief. Reliefen kommer från solvinkeln.
    ground.traverse(c => { if (c.isMesh) { c.receiveShadow = true; c.castShadow = false; } });
    filtreraMark(ground);          // ortofotot ska matcha 2D-kartan
    scene.add(ground);
    byggMarkindex();     // U18: EN gång per hål, före första ombyggnaden
    applyExag();
    sattSol(solLage);    // U7: solen hör till banans position — sätt om per hål
    spannUpp();          // U7: skuggkameran spänns kring DET här hålet
    stopFly();
    placeCamera();       // startvyn = överblicken, aldrig en flygning
    buildHojdMarker();   // U6: ny grupp per hål (clearHole tog bort förra)
    buildHojdPanel();    // bygger om profil-SVG:n och nollställer hojdS
    fakta(`${fmtDh(meta.delta_h)} · ${meta.length_m} m`);
    status('');
    if (meta.wide) loadWide(meta.slug, meta.wide);   // U15, efter hålet
    laddaSpridning().then(buildShots);               // U19 + GP1, efter hålet
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
    // U7: kjolen tar emot skuggor (annars slutar terrängen få relief precis där
    // hålet tar slut, och sömmen syns som ett ljusbyte) men kastar inga.
    wide.traverse(c => { if (c.isMesh) { c.receiveShadow = true; c.castShadow = false; } });
    filtreraMark(wide);            // samma korrigering som hålets mark — annars syns sömmen som ett färgbyte
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

/* U19: 2D-sidan läser kedjan HÄRIFRÅN i stället för att räkna en egen. Det är
   hela mekanismen bakom "samma tal i båda vinklarna" — inte en synkronisering
   som kan glida, utan ett och samma svar hämtat på två ställen.
   `paKedja` säger till när raderna ändrats (vind hämtad, reglage draget) så
   2D-listan kan skriva om sig utan att fråga varje bildruta. */
let kedjaPa = null;
const paKedja = fn => { kedjaPa = fn; };
const kedjanNu = () => KEDJA;
/** Hålet räknat med andra landningspunkter — rubriken frågar efter `[]`. */
const kedjaFor = legs => planKedja(legs || []);
/* Vilket slag som är valt, och möjligheten att välja ett från 2D-sidan.
   Valet är alltså inte kamerans utan planens — därför överlever det ett
   vinkelbyte (§5 U19). */
const valtNu = () => valtSlag;
const valjFran2d = i => valjSlag(i);
/* Vindens ägare bor här (U16), och 2D-sidan frågar samma ägare — två
   vindhämtningar hade kunnat ge två svar om samma hål. */
const vindenNu = () => vindNu();

/* U22: den bäring som pekar UPPÅT i bild, i sanna grader. Räknas ur kamerans
   heading via `Vybro` — samma omräkning som vinkelbytet använder, inklusive
   gridnorr-termen. Utan den termen skulle kompassen peka 1,6° fel, vilket är
   litet men fel på precis det sätt en kompass inte får vara. */
function baringNu() {
  const k = konv();
  if (!k || typeof Vybro === 'undefined') return 0;
  return Kompass.vyBaringAvHeading(controls.state.heading, k.gridNorr, Vybro);
}
let bildrutaPa = null;
const paBildruta = fn => { bildrutaPa = fn; };

export { loadHole as laddaHal, sattExag, sattSynlig, setLage as sattLage,
         sattPlanLegs, posen, sattPosen, harIndex, paTapp, paExag, paLage,
         lageNu, metaNu, konv, markY, yRefPlan, flygTill, flygerNu, skarmAv, rita1,
         paKedja, kedjanNu, kedjaFor, valtNu, valjFran2d, vindenNu, sattSlope, harSlope,
         baringNu, paBildruta, paSlagval, sattHinder };

if (!EMBED) (async () => {
  let idx;
  try {
    idx = await (await fetch(`data/holes3d/index.${SGRound.activeSlug()}.json`)).json();
  } catch { status('inga 3D-hål exporterade än (tools/hole_gltf.py)'); return; }
  if (!idx.holes.length) { status('inga 3D-hål exporterade än'); return; }
  const sel = el('hal');
  /* U23: hålen listas i RUNDANS ordning och numreras 1–18 — samma numrering som
     resten av appen. Spelar man 10–27 är globalt hål 10 spelarens hål 1, och en
     utvecklarsida som säger "Gul 1" om samma hål säger något annat än
     planeringsvyn gör om samma hål.
     Bandatans namn står kvar som underrad; hål utanför vald runda listas inte.
     Saknar banan runddefinition (eller matchar inget) faller vi tillbaka på
     exportens ordning — och det står i etiketten, så listan aldrig påstår en
     numrering den inte har. */
  const bas = SGRound.GLOBAL_BASE || {};
  const relFor = h => (h.loop in bas) ? SGRound.globalToRel(bas[h.loop] + h.hole) : null;
  const iRunda = idx.holes.filter(h => relFor(h) != null)
                          .sort((a, b) => relFor(a) - relFor(b));
  const lista = iRunda.length ? iRunda : idx.holes;
  for (const h of lista) {
    const o = document.createElement('option');
    const rel = relFor(h);
    const namn = `${h.loop.replace(' Course', '')} ${h.hole}`;
    o.value = h.slug;
    o.textContent = (rel != null ? `Hål ${rel} · ${namn}` : `${namn} (utanför rundan)`)
      + `  (Δh ${h.delta_h >= 0 ? '+' : '−'}${Math.abs(h.delta_h)} m)`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => loadHole(sel.value));
  const want = new URLSearchParams(location.search).get('hal');
  if (want && idx.holes.some(h => h.slug === want)) sel.value = want;
  loadHole(sel.value);
})();
