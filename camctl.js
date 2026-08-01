// Kamerakontroll för planeringsvyn — UPPGRADERING_3D.md §4 (etapp U1).
//
// Tillståndet är fyra tal, som i en kartapp: {target, range, heading, tilt}.
// Kamerapositionen HÄRLEDS ur dem varje bildruta. Det gör tee-vy, flyover och
// sparade hålvinklar till interpolationer i fyra tal i stället för
// matrisakrobatik — och det är därför OrbitControls (som äger positionen och
// härleder resten) inte dög.
//
// Gester (§4): ett finger panorerar i markplanet · nyp ändrar range · två
// fingrar vrider heading · två fingrar upp/ner ändrar tilt. Desktop: drag
// panorerar, hjul zoomar, Ctrl+drag roterar/tiltar.
//
// LÄXA som styr designen: under en pågående gest följer tillståndet indata
// EXAKT — ingen dämpning. Dämpning på den axel man just drar i är per
// definition eftersläpning (§2), och kravet är att markpunkten under fingret
// ligger kvar under fingret. Mjukhet hör hemma i flyTo(), inte i drag.
//
// Filen har MEDVETET noll imports: samma kod körs i webbläsaren och i
// tests/js/test_camctl.mjs utan three.js.

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export const LIMITS = {
  // U12: MODELLEN måste kunna stå rakt ovanifrån — det är vad 2D-vinkeln ÄR
  // (tilt = 0), och den är poserad, inte dragen. Samma uppdelning som taket
  // nedan: modellen tillåter mer än gesten. Golvet för en GEST ligger kvar på
  // 5° (tiltMinGesture) — utan det kan man dra sig till rakt ovanifrån, där
  // panoreringens riktning blir odefinierad.
  tiltMin: 0,
  tiltMinGesture: 5 * DEG,  // aldrig rakt ovanifrån med fingret
  // Över 90° betyder att MÅLET ligger ovanför ögat — man står i en sänka och
  // tittar upp. Det är inte ett feltillstånd utan ett uppförshål, och det är
  // vanligt: Burlöv blue 1 kräver 90,28° för en tee-vy i ögonhöjd, eftersom
  // green ligger högre än teen. Ett tak på 90° kan alltså inte uttrycka en
  // ärlig tee-vy — kameran lyfts i stället upp i luften (uppmätt: 3,88 m i
  // stället för 1,7 m). Taket skyddar mot att kameran vänder sig upp-och-ner,
  // inget annat.
  tiltMax: 95 * DEG,
  // Gestgränsen är HÅRDARE än modellgränsen, och det är avsiktligt.
  // Bortom ~85° fyller horisonten skärmen: panorering slutar fungera (strålen
  // missar marken) och vyn blir obrukbar. Ingen ska kunna DRA sig dit.
  // Men en POSERAD vy måste kunna gå längre — se tee-vyn ovan. Därför två
  // gränser: modellen tillåter, gesten inte.
  tiltMaxGesture: 85 * DEG,
  rangeMin: 20,
  rangeMax: 3000,
};

// Vridningens tecken är en känslofråga, inte en matematisk: vrider man
// fingrarna medsols ska scenen följa med. Byt tecken här om det känns bakvänt
// på telefonen — det är enda stället.
const TWIST_SIGN = -1;
// Hur brant tilten ändras av två fingrars gemensamma lodräta rörelse.
const TILT_PER_PX = 0.30 * DEG;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clampTilt = t => clamp(t, LIMITS.tiltMin, LIMITS.tiltMax);
/** Klampning för TILT som användaren drar fram — se LIMITS.tiltMaxGesture. */
export const clampTiltGesture = t => clamp(t, LIMITS.tiltMinGesture, LIMITS.tiltMaxGesture);
export const clampRange = r => clamp(r, LIMITS.rangeMin, LIMITS.rangeMax);

/** Heading normaliserad till [0, 2π). Wrappar över varvet i båda riktningarna.
 *
 * Ligger värdet redan i intervallet lämnas det ORÖRT. `((h % TAU) + TAU) % TAU`
 * ser oskyldigt ut men är inte exakt identitet i flyttal, och heading räknas om
 * vid varje pointermove — då blir det en drift som ackumuleras genom en hel
 * gest utan att någon bett om det. */
export function wrapHeading(h) {
  if (h >= 0 && h < TAU) return h;
  const w = ((h % TAU) + TAU) % TAU;
  return w === TAU ? 0 : w;
}

// ---------------------------------------------------------------- vektorer ---
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function norm(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Kamerans öga ur tillståndet.
 * heading 0 = blicken mot −Z (norr); tilt mäts från lodrätt ned, så tilt→0 är
 * rakt ovanifrån och tilt→90° är horisonten.
 */
export function poseFromState(s) {
  const horiz = s.range * Math.sin(s.tilt);
  const vert = s.range * Math.cos(s.tilt);
  return {
    x: s.target.x - Math.sin(s.heading) * horiz,
    y: s.target.y + vert,
    z: s.target.z + Math.cos(s.heading) * horiz,
  };
}

/* Under den här tilten räknas kameran som NADIR (rakt ovanifrån) och rollen
   måste komma ur heading. Se `screenUp` — de två uttrycken ger samma skärm-höger
   för varje tilt i (0°, 90°), så gränsen kan ligga var som helst där emellan
   utan att bilden hoppar. 20° är valt för att ligga långt från båda ändarna. */
const NADIR_TILT = 20 * DEG;

/**
 * Vad som ska peka UPPÅT på skärmen, uttryckt i världen.
 *
 * U12: 2D-vinkeln är `tilt = 0`, och där är den vanliga konstruktionen
 * degenererad — `cross(forward, (0,1,0))` blir nollvektorn när blicken är lodrät,
 * så både `basis()` och three.js:s `lookAt` tappar rollen. (Uppmätt symptom:
 * varje världspunkt projicerades till bildens mitt.)
 *
 * Gränsvärdet är dock känt och exakt. Ur `poseFromState` är skärm-höger
 * `(cos heading, 0, sin heading)` för VARJE tilt > 0 — oberoende av tilten. Den
 * up-vektor som ger samma höger vid nadir är `(sin heading, 0, −cos heading)`,
 * och den ger identisk roll ända upp till horisonten (där den i sin tur blir
 * degenererad — därför byter vi vid NADIR_TILT).
 */
export function screenUp(state) {
  return state.tilt < NADIR_TILT
    ? { x: Math.sin(state.heading), y: 0, z: -Math.cos(state.heading) }
    : { x: 0, y: 1, z: 0 };
}

/** Kamerans ortonormala bas: forward (mot target), right, up. */
function basis(eye, target, heading) {
  const f = norm(sub(target, eye));
  let r = cross(f, { x: 0, y: 1, z: 0 });
  if (Math.hypot(r.x, r.y, r.z) < 1e-9) {
    // Lodrät blick: krysset kollapsar. Använd gränsvärdet (se screenUp) i
    // stället för att ge upp — annars går 2D-vinkeln inte att mäta i.
    const h = heading || 0;
    r = { x: Math.cos(h), y: 0, z: Math.sin(h) };
  }
  r = norm(r);
  const u = cross(r, f);
  return { f, r, u };
}

/**
 * Var en skärmpunkt träffar ett vågrätt plan. ndc = {x, y} i [-1, 1] med y uppåt.
 * Returnerar null när strålen pekar bort från planet (t.ex. mot himlen).
 */
export function rayGroundHit(eye, target, ndc, fovDeg, aspect, planeY, heading) {
  const { f, r, u } = basis(eye, target, heading);
  const tanHalf = Math.tan(fovDeg * DEG / 2);
  const sx = ndc.x * tanHalf * aspect;
  const sy = ndc.y * tanHalf;
  const dir = norm({
    x: f.x + r.x * sx + u.x * sy,
    y: f.y + r.y * sx + u.y * sy,
    z: f.z + r.z * sx + u.z * sy,
  });
  const t = (planeY - eye.y) / dir.y;
  if (!Number.isFinite(t) || t <= 0) return null;
  return { x: eye.x + dir.x * t, y: planeY, z: eye.z + dir.z * t };
}

/**
 * Hur mycket target ska flyttas för att markpunkten under fingret ska ligga
 * kvar under fingret när fingret gått från ndcFrom till ndcTo.
 *
 * Båda träffpunkterna räknas mot SAMMA kamerapose (den vid greppets början).
 * Räknar man den andra mot en redan flyttad kamera blir det en iteration som
 * driver — och driften ser ut som eftersläpning.
 */
export function panTargetDelta(state, ndcFrom, ndcTo, fovDeg, aspect) {
  const eye = poseFromState(state);
  const a = rayGroundHit(eye, state.target, ndcFrom, fovDeg, aspect, state.target.y, state.heading);
  const b = rayGroundHit(eye, state.target, ndcTo, fovDeg, aspect, state.target.y, state.heading);
  if (!a || !b) return null;
  return { x: a.x - b.x, z: a.z - b.z };
}

/**
 * Projicera en världspunkt till skärmpixlar med samma bas som renderaren.
 * Detta är mätinstrumentet för §2.4: en DOM-etikett som lagts på world ska
 * hamna här, samma bildruta.  Returnerar null bakom kameran.
 */
export function screenOf(state, world, fovDeg, aspect, width, height) {
  const eye = poseFromState(state);
  const { f, r, u } = basis(eye, state.target, state.heading);
  const d = sub(world, eye);
  const zc = dot(d, f);
  if (zc <= 1e-6) return null;
  const tanHalf = Math.tan(fovDeg * DEG / 2);
  const ndcX = dot(d, r) / zc / (tanHalf * aspect);
  const ndcY = dot(d, u) / zc / tanHalf;
  return { x: (ndcX * 0.5 + 0.5) * width, y: (1 - (ndcY * 0.5 + 0.5)) * height };
}

const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Inversen av poseFromState: tillståndet som ger exakt denna öga/target-pose.
 * Behövs när något annat har styrt kameran (en flygning, en sparad hålvinkel)
 * och kontrollern ska ta över UTAN att scenen hoppar.
 */
export function stateFromEye(eye, target) {
  const dx = eye.x - target.x, dy = eye.y - target.y, dz = eye.z - target.z;
  const range = Math.hypot(dx, dy, dz) || 1;
  return {
    target: { x: target.x, y: target.y, z: target.z },
    range,
    heading: wrapHeading(Math.atan2(-dx, dz)),
    tilt: Math.acos(clamp(dy / range, -1, 1)),
  };
}

/** Kortaste vägen mellan två heading — går över varvet i stället för runt. */
export function shortestHeadingDelta(from, to) {
  let d = wrapHeading(to) - wrapHeading(from);
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * ÖVERBLICKEN: tillståndet som visar HELA hålet, i 3D-vinkelns lutning.
 *
 * Startvyn ska vara densamma i 2D och 3D — annars hoppar bilden varje gång man
 * byter vinkel eller hål, och det var precis vad den gjorde: 2D ramar in hålet
 * med `fitBounds(green + line + tee).pad(0.12)` medan 3D stod på en fast regel
 * (0,45·längden bakom teen, 0,18·längden upp) som varken följde hålets form,
 * skärmens format eller 2D:s ram.
 *
 * Här räknas ramen i stället ut som en INPASSNING, samma sak som Leaflets
 * fitBounds gör: sök det minsta avståndet där varje punkt i hålet projiceras
 * innanför bilden med `pad` av halva bilden fri runtom. Då fungerar den för ett
 * kort par-3 lika väl som för ett långt par-5, i stående som liggande format.
 *
 * Sökningen är en halvering, inte en formel: projektionen är perspektivisk och
 * marken lutar, så en sluten formel hade behövt anta att hålet är en rät linje
 * i ett plan. Predikatet "ryms vid avståndet R" är monotont i R (större R drar
 * allt mot bildens mitt), och 40 halveringar ger millimeter — det är billigt en
 * gång per hål.
 *
 * @param pts   hålets punkter i scenkoordinater, y REDAN överdriftsskalad
 * @param opts  {fovDeg, aspect, tilt, pad, rangeMax}
 */
export function overviewState(pts, opts = {}) {
  if (!pts || pts.length < 2) return null;
  const fovDeg = opts.fovDeg ?? 55;
  const aspect = opts.aspect || 1;
  const tilt = clampTilt(opts.tilt ?? 55 * DEG);
  const pad = opts.pad ?? 0.12;

  const a = pts[0], b = pts[pts.length - 1];
  /* Blicken går från tee mot green. Ur poseFromState är den vågräta
     framåtriktningen (sin h, −cos h) — lös ut h ur hålets riktning. */
  const heading = wrapHeading(Math.atan2(b.x - a.x, -(b.z - a.z)));

  let lo = Infinity, hi = -Infinity, target = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    target.x += p.x / pts.length;
    target.y += p.y / pts.length;
    target.z += p.z / pts.length;
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  /* Målpunktens HÖJD är hålets mitt i höjdled, inte medelhöjden av punkterna:
     en tät punktsvärm kring teen skulle annars dra ramen nedåt på ett hål som
     stiger, och greenen hamna utanför bild. */
  target.y = (lo + hi) / 2;

  const ryms = R => {
    const st = { target, range: R, heading, tilt };
    const graf = 1 - pad;
    for (const p of pts) {
      const s = screenOf(st, p, fovDeg, aspect, 2, 2);   // width/height 2 → ndc·(+1)
      if (!s) return false;                              // bakom kameran
      if (Math.abs(s.x - 1) > graf || Math.abs(s.y - 1) > graf) return false;
    }
    return true;
  };

  let hiR = Math.min(opts.rangeMax ?? LIMITS.rangeMax, LIMITS.rangeMax);
  if (!ryms(hiR)) return { target, range: hiR, heading, tilt };  // ryms inte ens längst bort
  let loR = LIMITS.rangeMin;
  for (let i = 0; i < 40; i++) {
    const mid = (loR + hiR) / 2;
    if (ryms(mid)) hiR = mid; else loR = mid;
  }
  return { target, range: clampRange(hiR), heading, tilt };
}

export class CameraController {
  /**
   * @param camera  three.js PerspectiveCamera (används bara via position.set /
   *                lookAt / fov / aspect — ingen import behövs)
   * @param dom     elementet som tar emot gesterna (canvasen)
   */
  constructor(camera, dom, opts = {}) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = true;
    this.state = {
      target: { x: 0, y: 0, z: 0 },
      range: opts.range ?? 300,
      heading: opts.heading ?? 0,
      tilt: opts.tilt ?? 55 * DEG,
    };
    this.onUserInput = opts.onUserInput || null;  // avbryter t.ex. en flygning
    this._pointers = new Map();
    this._grip = null;      // greppets baslinje, satt vid varje ändrat fingerantal
    this._anim = null;      // pågående flyTo
    this._bind();
    this.apply();
  }

  // ------------------------------------------------------------ tillstånd ---
  setState(s) {
    if (s.target) this.state.target = { ...s.target };
    if (s.range != null) this.state.range = clampRange(s.range);
    if (s.heading != null) this.state.heading = wrapHeading(s.heading);
    if (s.tilt != null) this.state.tilt = clampTilt(s.tilt);
    this._anim = null;
    this.apply();
  }

  /** Ta över efter något som styrt kameran direkt, utan hopp. */
  setFromEye(eye, target) {
    const s = stateFromEye(eye, target);
    this.state = { ...s, range: clampRange(s.range), tilt: clampTilt(s.tilt) };
    this._anim = null;
    this._regrip();
    this.apply();
  }

  /**
   * Skala tillståndets höjder med k. Används när scenens höjdöverdrift ändras:
   * marken flyttar sig lodrätt, och en kamera som står kvar hamnar plötsligt
   * under terrängen eller högt ovanför den.
   *
   * Bara `target.y` behöver röras — ögat härleds ur target + range/heading/tilt
   * och följer därför med av sig självt, med bibehållen blickvinkel.
   *
   * En PÅGÅENDE flyTo skalas också, annars rycker övergången tillbaka till den
   * gamla höjden i nästa bildruta.
   */
  scaleHeights(k) {
    if (!Number.isFinite(k) || k <= 0 || k === 1) return;
    this.state.target.y *= k;
    if (this._anim) {
      this._anim.from.target.y *= k;
      this._anim.goal.target.y *= k;
    }
    this.apply();
  }

  /** Skriver tillståndet till kameran. Anropas sist i samma tick som render. */
  apply() {
    const eye = poseFromState(this.state);
    this.camera.position.set(eye.x, eye.y, eye.z);
    // Rollen måste vara definierad även rakt ovanifrån (U12:s 2D-vinkel) — se
    // screenUp. Sätts FÖRE lookAt, som läser den.
    const up = screenUp(this.state);
    this.camera.up?.set?.(up.x, up.y, up.z);
    const t = this.state.target;
    this.camera.lookAt(t.x, t.y, t.z);
  }

  /** Mjuk övergång till ett nytt tillstånd. All mjukhet bor här, inte i drag. */
  flyTo(goal, ms = 800) {
    const from = {
      target: { ...this.state.target },
      range: this.state.range,
      heading: this.state.heading,
      tilt: this.state.tilt,
    };
    this._anim = {
      from,
      goal: {
        target: goal.target ? { ...goal.target } : from.target,
        range: goal.range != null ? clampRange(goal.range) : from.range,
        dHeading: goal.heading != null
          ? shortestHeadingDelta(from.heading, goal.heading) : 0,
        tilt: goal.tilt != null ? clampTilt(goal.tilt) : from.tilt,
      },
      t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      dur: Math.max(1, ms),
    };
  }

  /**
   * Mjuk övergång till en pose uttryckt som öga + blickpunkt. Bekvämare än
   * flyTo() när vyn definieras av VAR man står (tee-vy, sparade hålvinklar) i
   * stället för av hur långt bort man är.
   */
  flyToEye(eye, target, ms = 800) {
    this.flyTo(stateFromEye(eye, target), ms);
  }

  /** Anropas en gång per bildruta, FÖRE render. */
  update() {
    if (this._anim) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const raw = Math.min(1, (now - this._anim.t0) / this._anim.dur);
      const k = easeOutExpo(raw);
      const { from, goal } = this._anim;
      this.state.target = {
        x: from.target.x + (goal.target.x - from.target.x) * k,
        y: from.target.y + (goal.target.y - from.target.y) * k,
        z: from.target.z + (goal.target.z - from.target.z) * k,
      };
      this.state.range = from.range + (goal.range - from.range) * k;
      this.state.heading = wrapHeading(from.heading + goal.dHeading * k);
      this.state.tilt = from.tilt + (goal.tilt - from.tilt) * k;
      if (raw >= 1) this._anim = null;
    }
    this.apply();
  }

  // -------------------------------------------------------------- gester ---
  _ndc(p) {
    const r = this.dom.getBoundingClientRect();
    return {
      x: ((p.x - r.left) / r.width) * 2 - 1,
      y: -(((p.y - r.top) / r.height) * 2 - 1),
    };
  }

  _aspect() {
    const r = this.dom.getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 1;
  }

  /**
   * Nollställer greppets baslinje. Körs varje gång antalet fingrar ändras —
   * annars hoppar scenen när ett andra finger sätts ned eller lyfts.
   */
  _regrip() {
    const pts = [...this._pointers.values()];
    if (pts.length === 0) { this._grip = null; return; }
    const base = {
      state: {
        target: { ...this.state.target },
        range: this.state.range,
        heading: this.state.heading,
        tilt: this.state.tilt,
      },
      pts: pts.map(p => ({ ...p })),
    };
    if (pts.length >= 2) {
      const [a, b] = pts;
      base.dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      base.angle = Math.atan2(b.y - a.y, b.x - a.x);
      base.midY = (a.y + b.y) / 2;
    }
    this._grip = base;
  }

  _onDown = e => {
    if (!this.enabled) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // setPointerCapture kastar NotFoundError när pekaren inte är aktiv — t.ex.
    // för syntetiska händelser (?dbg=1-mätningen i §2.4) eller ett finger som
    // hunnit lyftas. Kastet får ALDRIG avbryta greppet: då blir _grip null,
    // gesten dör tyst, OCH pekaren ligger kvar i _pointers och räknas som ett
    // extra finger vid nästa beröring. Uppmätt i browsern 2026-07-30.
    try { this.dom.setPointerCapture?.(e.pointerId); } catch { /* ofarligt */ }
    this._anim = null;                    // användaren tar över
    this.onUserInput?.();
    this._regrip();
  };

  _onMove = e => {
    if (!this.enabled || !this._pointers.has(e.pointerId) || !this._grip) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...this._pointers.values()];

    if (pts.length === 1) {
      // Ctrl+drag på desktop roterar/tiltar i stället för att panorera.
      if (e.ctrlKey) this._orbit(pts[0]);
      else this._pan(pts[0]);
    } else if (pts.length >= 2) {
      this._pinchTwistTilt(pts);
    }
    this.apply();
  };

  _onUp = e => {
    this._pointers.delete(e.pointerId);
    try { this.dom.releasePointerCapture?.(e.pointerId); } catch { /* ofarligt */ }
    this._regrip();                       // kvarvarande finger får ny baslinje
  };

  _onWheel = e => {
    if (!this.enabled) return;
    e.preventDefault();
    this._anim = null;
    this.onUserInput?.();
    this.state.range = clampRange(this.state.range * Math.exp(e.deltaY * 0.0015));
    this.apply();
  };

  /** Ett finger: markpunkten under fingret ska ligga kvar under fingret. */
  _pan(now) {
    const g = this._grip;
    const d = panTargetDelta(
      g.state, this._ndc(g.pts[0]), this._ndc(now),
      this.camera.fov, this._aspect());
    if (!d) return;                       // strålen missade marken — rör inget
    this.state.target = {
      x: g.state.target.x + d.x,
      y: g.state.target.y,
      z: g.state.target.z + d.z,
    };
  }

  /** Ctrl+drag (desktop): vågrätt = heading, lodrätt = tilt. */
  _orbit(now) {
    const g = this._grip;
    const dx = now.x - g.pts[0].x, dy = now.y - g.pts[0].y;
    this.state.heading = wrapHeading(g.state.heading + dx * 0.005);
    this.state.tilt = clampTiltGesture(g.state.tilt - dy * TILT_PER_PX);
  }

  /**
   * Två fingrar är EN gest, inte tre: avstånd → range, vinkel → heading,
   * mittpunktens lodräta rörelse → tilt. Delas de upp i separata lyssnare
   * rycker panoreringen så fort två av dem sker samtidigt, vilket de alltid gör.
   */
  _pinchTwistTilt(pts) {
    const g = this._grip;
    if (g.dist == null) return;
    const [a, b] = pts;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const midY = (a.y + b.y) / 2;

    this.state.range = clampRange(g.state.range * (g.dist / dist));
    let dAng = angle - g.angle;
    if (dAng > Math.PI) dAng -= TAU;
    if (dAng < -Math.PI) dAng += TAU;
    this.state.heading = wrapHeading(g.state.heading + TWIST_SIGN * dAng);
    this.state.tilt = clampTiltGesture(g.state.tilt - (midY - g.midY) * TILT_PER_PX);
  }

  _bind() {
    const d = this.dom;
    d.style.touchAction = 'none';
    d.addEventListener('pointerdown', this._onDown);
    d.addEventListener('pointermove', this._onMove);
    d.addEventListener('pointerup', this._onUp);
    d.addEventListener('pointercancel', this._onUp);
    d.addEventListener('wheel', this._onWheel, { passive: false });
  }

  dispose() {
    const d = this.dom;
    d.removeEventListener('pointerdown', this._onDown);
    d.removeEventListener('pointermove', this._onMove);
    d.removeEventListener('pointerup', this._onUp);
    d.removeEventListener('pointercancel', this._onUp);
    d.removeEventListener('wheel', this._onWheel);
  }
}
