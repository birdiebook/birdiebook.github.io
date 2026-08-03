"use strict";
/* STRATEGI — beslutet räknas i telefonen (SPELPLAN_PLAN.md §SP2, §SP4).
 *
 * Planeraren i `src/api/planner.py` gör två saker: bygger en VÄRDEYTA (4,8 s
 * per hål) och RANGORDNAR kandidater mot den (10 ms). SP1 skeppade ytan. Den
 * här modulen gör det andra — i telefonen, utan nät, utan server, för dagens
 * vind och dagens tee.
 *
 * TVÅ SVEP, precis som `plan_hole` har två grenar:
 *   `svep`   tee-slaget mot den skeppade V-ytan (hål med värdeyta)
 *   `inspel` slaget mot green mot W-rastret, som räknas HÄR (par 3, hål inom
 *            inspelsavstånd, och sista slaget i kedjan)
 * Skillnaden mellan dem är vad som skeppas: V kostar 4,8 s att bygga och kan
 * inte flytta sig, W är en baslinjeuppslagning per cell och räknas om varje
 * gång pinnen flyttas (SP4). Det är därför en flyttad pin ändrar inspelet
 * exakt och tee-slagets värdering approximativt.
 *
 * DEN BÄRANDE REGELN: modulen ska ge samma svar som `optimize_tee_v2`. Den är
 * därför skriven som en spegel av den funktionen, steg för steg och i samma
 * ordning, och `tests/test_strategi_paritet.py` kör BÅDA och jämför. Där de två
 * behöver samma tal — slagmönster, vindkonstanter, hinderplikter, rasterramar —
 * kommer talen UR den skeppade ytan i stället för att skrivas av här. Ett tal
 * som skrivs av på två ställen glider isär, och en plan som glidit ser exakt
 * lika trovärdig ut som en riktig.
 *
 * DETERMINISTISK SAMPLING, INTE SLUMP. Python drar n=800 slumpsampel per
 * kandidat med gemensamma slumptal. Vi kan inte återskapa numpys generator i JS
 * — och behöver inte: samma integral går att beräkna med ett LÅGDISKREPANT
 * gitter (Halton 2,3 genom invers normalfördelning). Det ger tre saker som
 * slumpen inte ger: samma plan varje gång för samma indata, mindre fel för
 * samma antal punkter, och inget behov av PRNG-paritet mellan språken (som
 * ändå vore omöjlig — `log` och `cos` är inte bitidentiska mellan V8 och
 * CPython, SPELPLAN_PLAN §4.6).
 *
 * REN och importfri (som planslag.js, vylage.js och spelprofil.js): ingen DOM,
 * ingen Store, inget fetch. Baslinjen skickas IN som en funktion — i appen
 * `SG.expectedStrokes`, i testet samma modul — så SG-modellen aldrig skrivs en
 * andra gång (APPSTORE_PLAN §3.2).
 */
const Strategi = (() => {
  const V_MODUL = 1;
  const R_JORD = 6371000.0;          // = api.strategy.R; kontrolleras mot ytan

  /* GPS-bufferten i banmodellens klassning (course.lie.BUFFER_DEG). Den finns
     för brus i LOGGADE slag, men planerarens raster ärver den — så varje hinder
     är ~5 m större i värderingen än på kartan. Vi speglar det med flit; om det
     är rätt modell är en öppen fråga (SPELPLAN_PLAN §8.6). */
  const BUFFER_DEG = 4.5e-5;

  /* Ordningen är course.lie.PRIORITY: mest specifik yta först. `water` är
     buntens korta namn för water_hazard (SP0). */
  const PRIORITET = ["green", "bunker", "water", "tee", "fairway",
                     "heavy_rough", "ob"];
  const TILL_PLANERARE = { water: "water_hazard" };

  /* ---- 1. Deterministisk sampling ------------------------------------- */

  /* Radikalinvers i given bas — Haltons byggsten. */
  function halton(i, bas) {
    let f = 1, r = 0;
    while (i > 0) { f /= bas; r += f * (i % bas); i = Math.floor(i / bas); }
    return r;
  }

  /* Invers normalfördelning (Acklam). Relativt fel < 1,15e-9 — tre
     storleksordningar under allt vi mäter, och helt deterministisk. */
  const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  function invNorm(p) {
    const pl = 0.02425;
    let q, r;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
             ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
    }
    if (p > 1 - pl) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
              ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
    }
    q = p - 0.5; r = q * q;
    return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q /
           (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }

  /* Punktmolnet: standardiserade (z_längd, z_sidled) för TRÄFFAR och för
     MISSTRÄFFAR var för sig, med vikter som summerar till 1.
     Stratifieringen är hela poängen: med slump avgör tärningen hur många
     missträffar just den här dragningen fick (vid p = 0,04 och n = 800 varierar
     antalet med ±5), och den variationen syns sedan som en skillnad mellan två
     kandidater som egentligen är lika. Här får svansen en EGEN budget och en
     exakt vikt. */
  function punktmoln(n, miss) {
    const p = (miss && miss.p) || 0;
    const nTraff = n;
    const nMiss = p > 0 ? Math.max(64, Math.round(n * p)) : 0;
    const z1 = new Float64Array(nTraff + nMiss);
    const z2 = new Float64Array(nTraff + nMiss);
    const vikt = new Float64Array(nTraff + nMiss);
    const arMiss = new Uint8Array(nTraff + nMiss);
    for (let i = 0; i < nTraff; i++) {
      z1[i] = invNorm(halton(i + 1, 2));
      z2[i] = invNorm(halton(i + 1, 3));
      vikt[i] = (1 - p) / nTraff;
    }
    for (let i = 0; i < nMiss; i++) {
      const j = nTraff + i;
      // Egen sekvens (förskjuten start) så svansens punkter inte är en delmängd
      // av kärnans — de ska täcka sitt eget område, inte upprepa det.
      z1[j] = invNorm(halton(i + 1 + 7919, 2));
      z2[j] = invNorm(halton(i + 1 + 7919, 3));
      vikt[j] = p / nMiss;
      arMiss[j] = 1;
    }
    return { z1, z2, vikt, arMiss, n: nTraff + nMiss };
  }

  /* ---- 2. Ramen: lat/lon <-> meter kring pinnen ------------------------ */

  function xy(lat, lon, lat0, lon0) {
    return [(lon - lon0) * Math.PI / 180 * Math.cos(lat0 * Math.PI / 180) * R_JORD,
            (lat - lat0) * Math.PI / 180 * R_JORD];
  }
  function invXy(e, n, lat0, lon0) {
    const lat = lat0 + (n / R_JORD) * 180 / Math.PI;
    return [lat, lon0 + (e / (R_JORD * Math.cos(lat0 * Math.PI / 180))) * 180 / Math.PI];
  }

  /* Cellindex — `Math.trunc` och inte `Math.floor`: numpys `.astype(int64)`
     kapar mot noll, och skillnaden syns för punkter strax utanför rastret. */
  const idx = (v, v0, step, n) => {
    const i = Math.trunc((v - v0) / step);
    return i < 0 ? 0 : (i >= n ? n - 1 : i);
  };

  /* ---- 3. Lägesklassning och rastrering -------------------------------- */

  function iPolygon(lat, lon, ring) {
    let inne = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const la = ring[i][0], lo = ring[i][1], la2 = ring[j][0], lo2 = ring[j][1];
      if ((la > lat) !== (la2 > lat) &&
          lon < lo + (lo2 - lo) * (lat - la) / (la2 - la)) inne = !inne;
    }
    return inne;
  }

  /* Är punkten inom `tol` från ringens kant? Ett PREDIKAT och inte ett avstånd:
     vi behöver aldrig veta hur långt bort den är, bara om den är nära — och då
     går det att hoppa över segment vars egen box redan ligger för långt bort
     och sluta vid första träff. Tillsammans med ringboxarna ovan är det
     skillnaden mellan oanvändbart och snabbt (uppmätt 2026-08-03, rastrering av
     ett hål): Black 1 2 650 → 98 → 23 ms, Blue 2 (18 000 celler, stora
     tjockruffytor) 984 → 36 ms. Python gör samma hål på 230 ms. */
  function naraRing(lat, lon, ring, tol) {
    const t2 = tol * tol;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if ((a[0] < lat - tol && b[0] < lat - tol) || (a[0] > lat + tol && b[0] > lat + tol)
          || (a[1] < lon - tol && b[1] < lon - tol) || (a[1] > lon + tol && b[1] > lon + tol)) {
        continue;                                   // segmentets box är för långt bort
      }
      const dx = b[1] - a[1], dy = b[0] - a[0];
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1,
        ((lon - a[1]) * dx + (lat - a[0]) * dy) / l2));
      const ex = lon - (a[1] + t * dx), ey = lat - (a[0] + t * dy);
      if (ex * ex + ey * ey <= t2) return true;
    }
    return false;
  }

  /* Hålets ytor, grupperade per typ, VAR OCH EN MED SIN BOX. Bunten (SP0) bär
     green och fairways under egna nycklar och resten som `hazards` + `lies`.

     Boxen är inte en optimering utan en förutsättning: utan den prövas varje
     cell mot varje ring i BÅDA passen, och det buffrade passet körs för nästan
     alla celler (de flesta är ruff). Uppmätt på Black 1: 2 650 ms utan boxar,
     under 200 ms med. Python har samma sak i sin STRtree. */
  function medBox(ring) {
    let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity;
    for (const [la, lo] of ring) {
      if (la < laMin) laMin = la;
      if (la > laMax) laMax = la;
      if (lo < loMin) loMin = lo;
      if (lo > loMax) loMax = lo;
    }
    return { ring, laMin, laMax, loMin, loMax };
  }

  function ytorFor(bandataHal) {
    const h = bandataHal || {};
    const ut = {
      green: h.green && h.green.length >= 3 ? [medBox(h.green)] : [],
      fairway: (h.fairways || []).filter(r => r && r.length >= 3).map(medBox),
    };
    for (const post of (h.hazards || []).concat(h.lies || [])) {
      if (!post || !post.poly || post.poly.length < 3) continue;
      (ut[post.type] = ut[post.type] || []).push(medBox(post.poly));
    }
    return ut;
  }

  /* Två pass, som course.lie.classify_lie: exakt träff vinner över buffrad.
     FAIRWAY deltar inte i det buffrade passet — planerarens raster kräver exakt
     träff i hålets egna fairways och gör allt annat till ruff (SPELPLAN_PLAN
     §SP0 fynd 3). Asymmetrin är inte vår, men den ska speglas. */
  function klassa(lat, lon, ytor) {
    for (const typ of PRIORITET) {
      for (const y of ytor[typ] || []) {
        if (lat < y.laMin || lat > y.laMax || lon < y.loMin || lon > y.loMax) continue;
        if (iPolygon(lat, lon, y.ring)) return TILL_PLANERARE[typ] || typ;
      }
    }
    for (const typ of PRIORITET) {
      if (typ === "fairway") continue;
      for (const y of ytor[typ] || []) {
        if (lat < y.laMin - BUFFER_DEG || lat > y.laMax + BUFFER_DEG
            || lon < y.loMin - BUFFER_DEG || lon > y.loMax + BUFFER_DEG) continue;
        if (naraRing(lat, lon, y.ring, BUFFER_DEG)) {
          return TILL_PLANERARE[typ] || typ;
        }
      }
    }
    return "rough";
  }

  /* Lie-rastret för ETT hål: samma celler som planeraren rastrerade (ramen kom
     med ytan), klassade ur banbuntens polygoner. ~0,2 s på PC — det billiga vi
     räknar själva i stället för att skeppa (SPELPLAN_PLAN §SP1). */
  function rastrera(hal, bandataHal, koder) {
    const ram = hal.lie, ytor = ytorFor(bandataHal);
    const ut = new Int8Array(ram.nx * ram.ny);
    const [plat, plon] = hal.pin;
    for (let iy = 0; iy < ram.ny; iy++) {
      const n = ram.y0 + (iy + 0.5) * ram.step;
      for (let ix = 0; ix < ram.nx; ix++) {
        const e = ram.x0 + (ix + 0.5) * ram.step;
        const [lat, lon] = invXy(e, n, plat, plon);
        ut[iy * ram.nx + ix] = koder[klassa(lat, lon, ytor)] ?? koder.rough;
      }
    }
    return ut;
  }

  /* ---- 4. Vinden — spegel av planner._wind_shift ----------------------- */

  function relativVind(baringGrader, ms, dirGrader) {
    const d = (dirGrader - baringGrader) * Math.PI / 180;
    const along = -ms * Math.cos(d);
    const right = -ms * Math.sin(d);
    // Python avrundar till två decimaler INNAN talen används (api.wind).
    // Avrundningen är alltså en del av modellen, inte av utskriften.
    return { along: Math.round(along * 100) / 100,
             cross: Math.round(Math.abs(right) * 100) / 100,
             sida: Math.abs(right) >= 0.05 ? (right > 0 ? "H" : "V") : null };
  }

  function vindskift(fwd, slaglangd, vind, k) {
    if (!vind || !vind.ms) return { along: 0, across: 0, sigma: 1 };
    const baring = ((Math.atan2(fwd[0], fwd[1]) * 180 / Math.PI) + 360) % 360;
    const rel = relativVind(baring, vind.ms, vind.dir);
    const skala = slaglangd / k.ref_m;
    const along = rel.along >= 0
      ? k.tail * rel.along * skala
      : -(k.head_lin * (-rel.along) + k.head_quad * rel.along * rel.along) * skala;
    const tecken = rel.sida === "H" ? 1 : rel.sida === "V" ? -1 : 0;
    return { along, across: k.cross * rel.cross * tecken * skala,
             sigma: 1 + k.sigma_per_ms * vind.ms };
  }

  /* ---- 4b. Höjden — spegel av planner._elev_shift_along ---------------- */

  /* Spellängdseffekten av en höjdskillnad. Asymmetrisk med flit: uppför
     kostar hela höjden, nedför ger bara 0,8 tillbaka (flackare infallsvinkel
     äts av rull). Faktorerna KOMMER UR YTAN (`konstanter.hojd`) och skrivs
     inte av här — telefonen har samma tal i `playas.js`, och två kopior av en
     konstant är precis det par §9:s läxa säger ska bindas ihop. */
  function lutningseffekt(dh, k) {
    return dh >= 0 ? k.upp * dh : k.ner * dh;
  }

  /* Δlängd (m) för ett slag from→to: uppför kortar räckvidden, nedför
     förlänger den. `dh(from, to)` injiceras (i appen ur hålets höjdprofil i
     `holes3d`, samma fil och samma algoritm som `api/elev.py` läser) och får
     svara null där höjden inte går att slå upp — då är termen 0, precis som
     Pythons `hole_elev=None`. */
  function hojdskift(fromLL, toLL, dh, k) {
    if (typeof dh !== "function" || !k) return 0;
    const d = dh(fromLL, toLL);
    return (d == null || !isFinite(d)) ? 0 : -lutningseffekt(d, k);
  }

  /* ---- 5. Ytan: läsning och validering --------------------------------- */

  function avkodaV(v) {
    const bin = typeof atob === "function"
      ? atob(v.b64)
      : Buffer.from(v.b64, "base64").toString("binary");
    const buf = new ArrayBuffer(bin.length);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    return new Int16Array(buf);
  }

  /* Ytan går ALDRIG att använda halvvägs. Fel modellversion, fel projektion
     eller en trasig ram ska ge ett kastat fel här och inte ett tal längre ner:
     en plan räknad mot fel yta ser precis lika rimlig ut som en riktig. */
  function laddaYta(json, planVersion) {
    const y = json || {};
    if (!y.holes || !y.menu || !y.konstanter) throw new Error("ytan saknar delar");
    if (planVersion != null && y.plan_version !== planVersion) {
      throw new Error(`ytan är räknad med PLAN_VERSION ${y.plan_version}, `
                      + `appen väntar ${planVersion}`);
    }
    if (y.ram && Math.abs(y.ram.R - R_JORD) > 1) {
      throw new Error("ytan använder en annan jordradie än modulen");
    }
    const koder = {};
    y.konstanter.lies.forEach((namn, i) => { koder[namn] = i; });
    const hal = new Map();
    for (const h of y.holes) {
      hal.set(h.loop + "|" + h.hole, { ...h, V: h.v ? avkodaV(h.v) : null });
    }
    return { ...y, koder, hal,
             hamta: (loop, nr) => hal.get(loop + "|" + nr) || null };
  }

  /* ---- 6. Svepet — spegel av planner.optimize_tee_v2 ------------------- */

  /* Uppslagsramen kring lie-rastret: allt de två svepen behöver för att slå
     upp ett läge och droppa ur ett hinder, samlat en gång i stället för att
     skickas som sex argument per sampel. */
  function rasterRam(yta, hal, koderRaster) {
    return { koder: koderRaster, ram: hal.lie, lies: yta.konstanter.lies,
             straff: yta.konstanter.hazard_penalty,
             steg: yta.konstanter.drop_step_m, max: yta.konstanter.drop_max_steps };
  }
  const lageVid = (R, e, n) => R.lies[
    R.koder[idx(n, R.ram.y0, R.ram.step, R.ram.ny) * R.ram.nx
            + idx(e, R.ram.x0, R.ram.step, R.ram.nx)]];

  /* Hinderdropp bakåt längs slagriktningen (planner._drop_hazard): en landning
     i vatten eller OB flyttas till första fria cell och betalar sin plikt.

     Skriver [e, n, plikt] i `ut` i stället för att returnera ett objekt. Det
     är inte mikrooptimering: funktionen körs en gång per sampel och kandidat
     (~25 000 gånger per hål och svep), och SP2:s mätning visade att det är i
     just den loopen skillnaden mellan 23 ms och oanvändbart ligger. */
  const SKRAP = new Float64Array(3);        // droppens utrymme, se `droppa`

  function droppa(ut, e, n, fwd, namn, R) {
    ut[0] = e; ut[1] = n; ut[2] = 0;
    if (R.straff[namn] == null) return ut;
    for (let s = 1; s <= R.max; s++) {
      const ce = e - fwd[0] * R.steg * s, cn = n - fwd[1] * R.steg * s;
      if (R.straff[lageVid(R, ce, cn)] == null) {
        ut[0] = ce; ut[1] = cn; ut[2] = R.straff[namn];
        return ut;
      }
    }
    return ut;
  }

  /* Punkt `s` meter längs polylinjen (planner._arc_point). */
  function bagePunkt(linje, s) {
    let acc = 0;
    for (let i = 0; i + 1 < linje.length; i++) {
      const a = linje[i], b = linje[i + 1];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + seg >= s && seg > 0) {
        const t = (s - acc) / seg;
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      }
      acc += seg;
    }
    return linje[linje.length - 1];
  }

  /* Ett (klubba, siktpunkt)-värde: E[1 + V(landning)] + andelar. */
  function utvarderaKandidat(ctx, klubba, aimXy) {
    const { yta, hal, koder, moln, vind, baslinje } = ctx;
    const teeXy = ctx.teeXy;
    const dv = [aimXy[0] - teeXy[0], aimXy[1] - teeXy[1]];
    const len = Math.hypot(dv[0], dv[1]) || 1;
    const fwd = [dv[0] / len, dv[1] / len];
    const right = [fwd[1], -fwd[0]];
    const w = vindskift(fwd, klubba.dist_med, vind, yta.konstanter.vind);
    /* Höjden justerar räckvidden mot den NOMINELLA landningen — klubbans egen
       längd längs siktlinjen, inte siktpunkten (som på ett dogleg ligger på ett
       annat avstånd). Samma val som Python gör, och av samma skäl som vinden
       räknas på `dist_med`: det är slaget som möter backen, inte målet. */
    const nomLand = [teeXy[0] + fwd[0] * klubba.dist_med,
                     teeXy[1] + fwd[1] * klubba.dist_med];
    const hSkift = hojdskift(invXy(teeXy[0], teeXy[1], hal.pin[0], hal.pin[1]),
                             invXy(nomLand[0], nomLand[1], hal.pin[0], hal.pin[1]),
                             ctx.dh, yta.konstanter.hojd);

    const alongMean = klubba.dist_med + w.along + hSkift;
    const acrossMean = klubba.across_bias + w.across;
    const sdAl = klubba.dist_sd * w.sigma, sdAc = klubba.across_sd * w.sigma;
    const miss = klubba.miss || { p: 0 };
    const nominal = Math.abs(klubba.dist_med);

    const vram = hal.v, R = ctx.R;
    const straff = yta.konstanter.hazard_penalty;
    let ev = 0, andel = {};
    for (let i = 0; i < moln.n; i++) {
      const m = moln.arMiss[i];
      const along = m
        ? alongMean - miss.along_frac * nominal + moln.z1[i] * sdAl * miss.along_mult
        : alongMean + moln.z1[i] * sdAl;
      const across = m
        ? acrossMean + moln.z2[i] * sdAc * miss.across_mult
        : acrossMean + moln.z2[i] * sdAc;
      const e0 = teeXy[0] + along * fwd[0] + across * right[0];
      const n0 = teeXy[1] + along * fwd[1] + across * right[1];

      // Rått läge (före dropp) — det är detta andelarna rapporteras på.
      const rattNamn = lageVid(R, e0, n0);
      andel[rattNamn] = (andel[rattNamn] || 0) + moln.vikt[i];

      const d = droppa(SKRAP, e0, n0, fwd, rattNamn, R);
      const e = d[0], n = d[1], plikt = d[2];
      const namn = lageVid(R, e, n);
      const dist = Math.hypot(e, n);
      let v;
      if (namn === "green") {
        v = baslinje("green", dist);
      } else {
        const vi = yta.konstanter.variant_idx[namn];
        const rå = hal.V[(idx(n, vram.y0, vram.step, vram.ny) * vram.nx
                          + idx(e, vram.x0, vram.step, vram.nx)) * hal.v.varianter.length + vi];
        v = rå === hal.v.saknas ? baslinje(namn, dist) : rå / hal.v.skala;
      }
      v += plikt;
      if (straff[namn] != null) v += straff[namn];   // droppen hittade inget fritt
      ev += moln.vikt[i] * v;
    }
    const pct = (namn) => Math.round(1000 * (andel[namn] || 0)) / 10;
    return {
      shot: klubba.name,
      expected_total: Math.round((1 + ev) * 1000) / 1000,
      fairway_pct: pct("fairway"),
      hazard_pct: Math.round(10 * (pct("bunker") + pct("water_hazard")
                                   + pct("heavy_rough"))) / 10,
      aim_latlon: invXy(aimXy[0], aimXy[1], hal.pin[0], hal.pin[1]),
      /* MEDELLANDNINGEN — där kedjan fortsätter, och därför den punkt som ska
         ritas i kartan. Den är inte siktpunkten: bias, vind och höjd skiljer
         dem åt, och att rita siktet som om bollen landade där hade lagt
         nästa slag på fel ställe. Samma uttryck som `plan_hole` använder för
         kedjans mittpunkt. */
      land_latlon: invXy(teeXy[0] + fwd[0] * alongMean + right[0] * acrossMean,
                         teeXy[1] + fwd[1] * alongMean + right[1] * acrossMean,
                         hal.pin[0], hal.pin[1]),
      hojd_m: Math.round(hSkift * 10) / 10,
      bearing_fwd: fwd,
    };
  }

  /* Hela svepet: klubba × sikt-offset, förankrat i HÅL-LINJEN vid klubbans
     räckvidd (dogleg-medvetet, som planeraren). */
  function svep(yta, hal, koderRaster, opt) {
    const o = opt || {};
    if (!hal || !hal.V) return null;         // inspelshål — ingen yta att svepa mot
    const [plat, plon] = hal.pin;
    const linje = hal.line.map(([la, lo]) => xy(la, lo, plat, plon));
    /* SP4: teen spelaren FAKTISKT spelar. Ytan är byggd från baktee (planerarens
       `tee_index` 0) och kan inte flytta sig — men rastret spänner hela hålet,
       så ett slag från en framflyttad tee landar i celler ytan redan värderat.
       Det som ändras är var slaget börjar, och det är hela skillnaden. */
    const tee = o.tee || hal.tee;
    const teeXy = xy(tee[0], tee[1], plat, plon);
    let bage = 0;
    for (let i = 0; i + 1 < linje.length; i++) {
      bage += Math.hypot(linje[i + 1][0] - linje[i][0], linje[i + 1][1] - linje[i][1]);
    }
    const n = o.n || 512;
    if (o.dh && !yta.konstanter.hojd) {
      throw new Error("ytan bär inga höjdkonstanter — byggd före SP4");
    }
    const ctx = { yta, hal, koderRaster, vind: o.vind || null, dh: o.dh || null,
                  baslinje: o.baslinje, teeXy, koder: yta.koder, moln: null,
                  R: rasterRam(yta, hal, koderRaster) };

    const ut = [];
    for (const klubba of yta.menu) {
      ctx.moln = punktmoln(n, klubba.miss);
      const ankare = bagePunkt(linje, Math.min(klubba.dist_med, bage - 10));
      const bf = [ankare[0] - teeXy[0], ankare[1] - teeXy[1]];
      const bl = Math.hypot(bf[0], bf[1]) || 1;
      const bRight = [bf[1] / bl, -bf[0] / bl];
      for (const off of yta.svep.offsets_m) {
        const aim = [ankare[0] + bRight[0] * off, ankare[1] + bRight[1] * off];
        const kand = utvarderaKandidat(ctx, klubba, aim);
        kand.offset_m = off;
        ut.push(kand);
      }
    }
    return ut;
  }

  /* ---- 6b. Inspelet — spegel av planner.optimize_approach_v2 ----------- */

  /* W-rastret: "hur många slag kostar det härifrån om bollen STANNAR här",
     per cell i lie-rastret. Spegel av `planner.strokes_after_grid`.

     Det här är ytan inspelet värderas mot, och till skillnad från V-rastret
     räknas det HÄR i stället för att skeppas — det är en baslinjeuppslagning
     per cell och inget mer (16 000 celler, några millisekunder). Att det är
     billigt är också vad som gör en flyttad pin meningsfull: avstånden i
     rastret mäts mot `pinXy`, så en pin som flyttas ger ett nytt W, medan den
     skeppade värdeytan är bakad kring bandatans pin och inte kan följa med. */
  function wRaster(yta, hal, koderRaster, baslinje, pinXy) {
    const ram = hal.lie, straff = yta.konstanter.hazard_penalty;
    const px = pinXy ? pinXy[0] : 0, py = pinXy ? pinXy[1] : 0;
    const W = new Float64Array(ram.nx * ram.ny);
    for (let iy = 0; iy < ram.ny; iy++) {
      const n = ram.y0 + (iy + 0.5) * ram.step;
      for (let ix = 0; ix < ram.nx; ix++) {
        const e = ram.x0 + (ix + 0.5) * ram.step;
        const i = iy * ram.nx + ix;
        const namn = yta.konstanter.lies[koderRaster[i]];
        const d = Math.hypot(e - px, n - py);
        // Vatten och OB får ruffens värde + plikten: det är fallbacken för när
        // droppen inte hittar land, precis som i Python.
        W[i] = straff[namn] != null ? baslinje("rough", d) + straff[namn]
                                    : baslinje(namn, d);
      }
    }
    return W;
  }

  /* Vilket inspelsmönster gäller på `d` meter? Kanterna kommer ur filen som
     TAL (SP4) — etiketterna bär ett tankstreck, och en avskriven sträng hade
     tyst gett "inget mönster" i stället för fel mönster. */
  function inspelsmonster(yta, d) {
    for (const m of ((yta.inspel && yta.inspel.monster) || [])) {
      if (m.hi == null || d < m.hi) return m;
    }
    return null;
  }

  /* Inspelet från en position: siktnätet kring pinnen → bästa siktet.
   *
   * `opt`: { fran: [lat,lon], lie, baslinje, W, pin: [lat,lon]|null, vind, n,
   *          dhGreen: fn([lat,lon]) -> m|null }
   *
   * `dhGreen` är Δh från positionen till GREEN och inte till pinnen — det är
   * den storhet Python slår upp (`hole_elev.dh_to_green`) när den väljer
   * avståndsbucket, och appen har exakt samma i `PlayAs.dh3dToGreen`. Att
   * använda pinnen i stället hade varit nästan samma tal och en annan modell.
   */
  function inspel(yta, hal, koderRaster, opt) {
    const o = opt || {};
    if (!o.fran || typeof o.baslinje !== "function") return null;
    const [plat, plon] = hal.pin;
    const pinXy = o.pin ? xy(o.pin[0], o.pin[1], plat, plon) : [0, 0];
    const franXy = xy(o.fran[0], o.fran[1], plat, plon);
    const pos = [franXy[0] - pinXy[0], franXy[1] - pinXy[1]];
    const d = Math.hypot(pos[0], pos[1]);
    if (!(d > 0)) return null;
    const dhG = typeof o.dhGreen === "function" ? o.dhGreen(o.fran) : null;
    const dEff = (dhG == null || !isFinite(dhG)) ? d
      : d + lutningseffekt(dhG, yta.konstanter.hojd);
    const pat = inspelsmonster(yta, dEff);
    if (!pat) return null;                 // inget mönster → planen tiger

    const fwd = [-pos[0] / d, -pos[1] / d];
    const right = [fwd[1], -fwd[0]];
    const mult = yta.inspel.sigma_mult[o.lie] != null
      ? yta.inspel.sigma_mult[o.lie] : 1.25;
    const w = vindskift(fwd, d, o.vind || null, yta.konstanter.vind);
    const sdAl = Math.max(pat.along_sd * mult * w.sigma, 1.0);
    const sdAc = Math.max(pat.across_sd * mult * w.sigma, 1.0);
    const R = rasterRam(yta, hal, koderRaster);
    const W = o.W || wRaster(yta, hal, koderRaster, o.baslinje, pinXy);
    // Ett moln för HELA nätet: samma punkter för varje sikte är Pythons
    // gemensamma slumptal (CRN), och det är det som gör att två sikten går att
    // jämföra på en skillnad som är mindre än bruset i vart och ett av dem.
    const moln = punktmoln(o.n || 512, pat.miss);
    const miss = pat.miss || { p: 0 };

    const svepet = [];
    for (const aa of yta.inspel.aims_along) {
      for (const ac of yta.inspel.aims_across) {
        const alongMean = aa + pat.along_bias + w.along;
        const acrossMean = ac + pat.across_bias + w.across;
        let ev = 0, andel = {};
        for (let i = 0; i < moln.n; i++) {
          const m = moln.arMiss[i];
          const along = m
            ? alongMean - miss.along_frac * d + moln.z1[i] * sdAl * miss.along_mult
            : alongMean + moln.z1[i] * sdAl;
          const across = m
            ? acrossMean + moln.z2[i] * sdAc * miss.across_mult
            : acrossMean + moln.z2[i] * sdAc;
          const e0 = pinXy[0] + along * fwd[0] + across * right[0];
          const n0 = pinXy[1] + along * fwd[1] + across * right[1];
          const rattNamn = lageVid(R, e0, n0);
          andel[rattNamn] = (andel[rattNamn] || 0) + moln.vikt[i];
          const dr = droppa(SKRAP, e0, n0, fwd, rattNamn, R);
          ev += moln.vikt[i] * (W[idx(dr[1], R.ram.y0, R.ram.step, R.ram.ny) * R.ram.nx
                                  + idx(dr[0], R.ram.x0, R.ram.step, R.ram.nx)] + dr[2]);
        }
        const pct = (namn) => Math.round(1000 * (andel[namn] || 0)) / 10;
        svepet.push({
          aim_along: aa, aim_across: ac,
          ev_after: ev,
          green_pct: pct("green"),
          hazard_pct: Math.round(10 * (pct("bunker") + pct("water_hazard")
                                       + pct("heavy_rough"))) / 10,
          aim_latlon: invXy(pinXy[0] + aa * fwd[0] + ac * right[0],
                            pinXy[1] + aa * fwd[1] + ac * right[1], plat, plon),
        });
      }
    }
    const bast = svepet.reduce((a, b) => (b.ev_after < a.ev_after ? b : a));
    const rakt = svepet.find(s => s.aim_along === 0 && s.aim_across === 0) || bast;
    return {
      kind: "inspel", bucket: pat.bucket, lie: o.lie || "rough",
      dist: Math.round(d * 10) / 10, dist_eff: Math.round(dEff * 10) / 10,
      pin: o.pin ? [o.pin[0], o.pin[1]] : [plat, plon],
      sweep: svepet, rekommenderad: bast, rakt,
      expected_total: Math.round((1 + bast.ev_after) * 1000) / 1000,
      sparat: Math.round((rakt.ev_after - bast.ev_after) * 1000) / 1000,
    };
  }

  /* ---- 7. Beslutet ----------------------------------------------------- */

  /* Golvet kommer ur vår egen approximation: en vindfri yta felar upp till
     0,069 slag på GAPET mellan alternativ (SPELPLAN_PLAN §3.3). Under det går
     en skillnad inte att skilja från metodens eget fel. */
  const GAP_GOLV = 0.10;

  /* Sidan om hål-linjen. Ett sikte är inte ett tal för spelaren utan ett av tre
     val: vänster om linjen, på den, eller höger. */
  const sidaFor = (off) => (off < 0 ? "V" : off > 0 ? "H" : "mitt");

  /* Rangordna svepet till BESLUT.
   *
   * Kandidaterna grupperas i VALBARA ALTERNATIV — klubba × sida (§5.1) — och
   * varje grupp företräds av sin bästa kandidat. Beslutet är gapet mellan de
   * två bästa GRUPPERNA, inte mellan de två bästa kandidaterna: 45 kandidater
   * är 45 punkter i en yta, medan en spelare kan välja "driver, höger om
   * linjen" eller "3-wood, mitt på" — och det är de valen ett beslut ska stå
   * mellan.
   *
   * SP2 hade i stället en avståndsregel (annan klubba, eller samma klubba minst
   * 12 m åt sidan). Den var en proxy för samma sak och gav systematiskt
   * MINDRE gap, eftersom grannkandidaten sex meter bort nästan alltid var näst
   * bäst: på Burlöv klarade 0 av 21 hål grinden med avståndsregeln mot 3 av 42
   * hål×vindar med grupperingen (uppmätt 2026-08-03). */
  function beslut(kandidater) {
    if (!kandidater || !kandidater.length) return null;
    const grupper = new Map();
    for (const k of kandidater) {
      const sida = sidaFor(k.offset_m);
      const namn = k.shot + "|" + sida;
      const nu = grupper.get(namn);
      if (!nu || k.expected_total < nu.expected_total) {
        grupper.set(namn, { ...k, grupp: namn, sida });
      }
    }
    const sorterad = [...grupper.values()]
      .sort((a, b) => a.expected_total - b.expected_total);
    const bast = sorterad[0];
    const alternativ = sorterad[1] || null;
    const gap = alternativ ? alternativ.expected_total - bast.expected_total : null;
    return {
      rekommenderad: bast,
      alternativ,
      alternativen: sorterad,
      gap: gap == null ? null : Math.round(gap * 1000) / 1000,
      // Tystnad är ett svar, och det vanligaste (SPELPLAN_PLAN §5.2). Ett hål
      // utan mätbart val ska INTE presenteras som ett val.
      harBeslut: gap != null && gap >= GAP_GOLV,
      golv: GAP_GOLV,
    };
  }

  return { V: V_MODUL, GAP_GOLV, BUFFER_DEG, R_JORD,
           halton, invNorm, punktmoln, xy, invXy, klassa, ytorFor, rastrera, naraRing,
           relativVind, vindskift, lutningseffekt, hojdskift, laddaYta, avkodaV,
           bagePunkt, svep, wRaster, inspelsmonster, inspel, beslut, sidaFor };
})();

if (typeof window !== "undefined") window.Strategi = Strategi;
else if (typeof globalThis !== "undefined") globalThis.Strategi = Strategi;
if (typeof module !== "undefined" && module.exports) module.exports = Strategi;
