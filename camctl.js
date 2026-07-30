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
  tiltMin: 5 * DEG,        // aldrig rakt ovanifrån
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
export const clampTiltGesture = t => clamp(t, LIMITS.tiltMin, LIMITS.tiltMaxGesture);
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

/** Kamerans ortonormala bas: forward (mot target), right, up. */
function basis(eye, target) {
  const f = norm(sub(target, eye));
  const r = norm(cross(f, { x: 0, y: 1, z: 0 }));
  const u = cross(r, f);
  return { f, r, u };
}

/**
 * Var en skärmpunkt träffar ett vågrätt plan. ndc = {x, y} i [-1, 1] med y uppåt.
 * Returnerar null när strålen pekar bort från planet (t.ex. mot himlen).
 */
export function rayGroundHit(eye, target, ndc, fovDeg, aspect, planeY) {
  const { f, r, u } = basis(eye, target);
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
  const a = rayGroundHit(eye, state.target, ndcFrom, fovDeg, aspect, state.target.y);
  const b = rayGroundHit(eye, state.target, ndcTo, fovDeg, aspect, state.target.y);
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
  const { f, r, u } = basis(eye, state.target);
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
