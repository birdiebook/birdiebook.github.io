/* Bildfilter — CSS-filtrets matematik, delad mellan 2D och 3D (U15:s
 * filterfråga, se ORTOFOTO_FARG.md).
 *
 * VARFÖR den finns: 2D-kartans ortofoto visas som tiles × ett CSS-filter
 * (`CourseMap.MAP_FILTER`), 3D-vyn visar samma ortofoto som en bakad textur
 * under ETT ANNAT filter lagt på hela canvasen. Samma gräs fick alltså två
 * looker. Ekvationen som ska lösas är `filter_3d(textur) ≈ filter_2d(tile)`,
 * och den löses här: modulen räknar filtren som funktioner, kan komponera och
 * INVERTERA dem, och kan skriva ut resultatet som GLSL så marken i 3D kan bära
 * sin egen korrigering.
 *
 * Var noga med färgrummet: de korta CSS-filtren (brightness/saturate/…) verkar
 * i **sRGB**, inte linjärt ljus. Allt här räknar därför på sRGB-värden 0..1, och
 * GLSL:en är avsedd att läggas EFTER `<colorspace_fragment>` i three.js — då är
 * gl_FragColor redan sRGB och semantiken blir densamma som webbläsarens.
 *
 * Klampningen är inte kosmetik: varje filterprimitiv klipper till [0,1] innan
 * nästa körs (SVG-filterkedjan gör det), och `brightness(1.60)` bränner ut på
 * riktigt. Räknar man kedjan som en enda matris utan klamp hamnar ljusa
 * gräspixlar fel.
 *
 * Global: window.Bildfilter (vanligt script, som mapcore.js/vind3d.js).
 */
"use strict";

(function (root) {
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

  // --- filterprimitiverna som 3x3-matris + offset (filter-effects §8) -------
  // Alla uttrycks som {m: [9 tal radvis], o: [3 tal]} → ut = klamp(m·in + o).
  const I = () => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] });

  const LUM = [0.213, 0.715, 0.072];

  function brightness(b) {
    return { m: [b, 0, 0, 0, b, 0, 0, 0, b], o: [0, 0, 0] };
  }

  function contrast(c) {
    const t = 0.5 - 0.5 * c;
    return { m: [c, 0, 0, 0, c, 0, 0, 0, c], o: [t, t, t] };
  }

  function saturate(s) {
    const [lr, lg, lb] = LUM;
    return { m: [
      lr + (1 - lr) * s, lg - lg * s,       lb - lb * s,
      lr - lr * s,       lg + (1 - lg) * s, lb - lb * s,
      lr - lr * s,       lg - lg * s,       lb + (1 - lb) * s,
    ], o: [0, 0, 0] };
  }

  function grayscale(a) { return saturate(1 - a); }

  const SEPIA = [0.393, 0.769, 0.189,
                 0.349, 0.686, 0.168,
                 0.272, 0.534, 0.131];
  function sepia(a) {
    const id = I().m;
    return { m: id.map((v, i) => v * (1 - a) + SEPIA[i] * a), o: [0, 0, 0] };
  }

  function hueRotate(deg) {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return { m: [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ], o: [0, 0, 0] };
  }

  const PRIMITIVES = { brightness, contrast, saturate, grayscale, sepia,
                       "hue-rotate": hueRotate };

  /* Parsar en CSS-filtersträng till en lista av steg. Procent och deg stöds
     (`saturate(144%)` == `saturate(1.44)`), okänd funktion är ett FEL och inte
     en tyst no-op — ett tyst bortfall här ger fel färg utan spår. */
  function parse(str) {
    const ops = [];
    const re = /([a-z-]+)\(\s*([-0-9.]+)\s*(%|deg)?\s*\)/gi;
    let mm, tail = String(str || "").replace(/\s+/g, " ").trim();
    let consumed = 0;
    while ((mm = re.exec(tail)) !== null) {
      const name = mm[1].toLowerCase();
      const fn = PRIMITIVES[name];
      if (!fn) throw new Error("Bildfilter: okänd filterfunktion " + name);
      let v = parseFloat(mm[2]);
      if (mm[3] === "%") v /= 100;
      ops.push({ name, v, ...fn(v) });
      consumed += mm[0].length;
    }
    if (!ops.length && tail && tail !== "none")
      throw new Error("Bildfilter: kunde inte tolka filtret: " + str);
    return ops;
  }

  // --- referensutvärdering (används av tester och kalibrering) -------------
  function step(op, rgb) {
    const [r, g, b] = rgb, m = op.m, o = op.o;
    return [
      clamp01(m[0] * r + m[1] * g + m[2] * b + o[0]),
      clamp01(m[3] * r + m[4] * g + m[5] * b + o[1]),
      clamp01(m[6] * r + m[7] * g + m[8] * b + o[2]),
    ];
  }

  /** Kör en filterkedja på en sRGB-färg 0..1. `ops` är parse()-utdata. */
  function apply(ops, rgb) {
    let c = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
    for (const op of ops) c = step(op, c);
    return c;
  }

  // --- algebra: komponera och invertera ------------------------------------
  function mul(a, b) {                 // a∘b, alltså a(b(x)) — matris + offset
    const A = a.m, B = b.m, out = new Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    const o = [0, 1, 2].map(r =>
      A[r * 3] * b.o[0] + A[r * 3 + 1] * b.o[1] + A[r * 3 + 2] * b.o[2] + a.o[r]);
    return { m: out, o };
  }

  function inv(op) {
    const m = op.m;
    const d = m[0] * (m[4] * m[8] - m[5] * m[7])
            - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(d) < 1e-9) throw new Error("Bildfilter: filtret går inte att invertera");
    const a = [
      (m[4] * m[8] - m[5] * m[7]) / d, (m[2] * m[7] - m[1] * m[8]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
      (m[5] * m[6] - m[3] * m[8]) / d, (m[0] * m[8] - m[2] * m[6]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
      (m[3] * m[7] - m[4] * m[6]) / d, (m[1] * m[6] - m[0] * m[7]) / d, (m[0] * m[4] - m[1] * m[3]) / d,
    ];
    const o = [0, 1, 2].map(r =>
      -(a[r * 3] * op.o[0] + a[r * 3 + 1] * op.o[1] + a[r * 3 + 2] * op.o[2]));
    return { m: a, o };
  }

  /** Slår ihop en kedja till EN affin operation (utan mellanklamp). */
  function collapse(ops) {
    let acc = I();
    for (const op of ops) acc = mul(op, acc);
    return acc;
  }

  /**
   * Korrigeringen som får `yttre(korr(x))` att ge samma sak som `mal(x)`.
   * Det är precis vad 3D-marken behöver: canvas-filtret ligger kvar och rör
   * himmel/träd/overlays som förut, medan marken bär skillnaden mot 2D.
   * Returnerar en enstegskedja (en affin op) som kan köras med apply()/glsl().
   */
  function correction(malOps, yttreOps) {
    return [{ name: "korr", v: 0, ...mul(inv(collapse(yttreOps)), collapse(malOps)) }];
  }

  // --- GLSL ----------------------------------------------------------------
  const f = x => {
    const s = Number(x).toFixed(6);
    return s.indexOf(".") < 0 ? s + ".0" : s;
  };

  /** GLSL-funktion `vec3 <namn>(vec3 c)` som kör kedjan, klamp mellan stegen. */
  function glsl(ops, namn) {
    const rader = ops.map(op =>
      `  c = clamp(mat3(${f(op.m[0])}, ${f(op.m[3])}, ${f(op.m[6])}, ` +
      `${f(op.m[1])}, ${f(op.m[4])}, ${f(op.m[7])}, ` +
      `${f(op.m[2])}, ${f(op.m[5])}, ${f(op.m[8])}) * c + ` +
      `vec3(${f(op.o[0])}, ${f(op.o[1])}, ${f(op.o[2])}), 0.0, 1.0);`);
    return `vec3 ${namn}(vec3 cin) {\n  vec3 c = clamp(cin, 0.0, 1.0);\n` +
           rader.join("\n") + `\n  return c;\n}`;
  }

  root.Bildfilter = { parse, apply, glsl, correction, collapse, mul, inv,
                      clamp01, PRIMITIVES };
})(typeof window !== "undefined" ? window : globalThis);
