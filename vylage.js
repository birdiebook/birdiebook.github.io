"use strict";
/* Planeringsvyns TILLSTÅND — en ägare, två kameravinklar (UPPGRADERING_3D §5 U11).
 *
 * Före U11 fanns hålet, slagkedjan, slope-läget och överdriften i tre sidor med
 * var sin kopia: `planera-karta.html` ägde legs + slope, `hal3d.html` ägde exag
 * + läge + kamera, och hubben ägde hålvalet. Två av dem kunde stå på olika hål
 * samtidigt utan att någon märkte det. Den här modulen är hela skillnaden:
 * vy-sidan får INTE ha en egen kopia av något som står här.
 *
 * Importfri (som camctl.js och markhojd.js) så `node tests/js/test_vylage.mjs`
 * kan köra den utan DOM. Lagringen injiceras — i telefonen localStorage, i
 * testet ett vanligt objekt.
 *
 * Persistensen är MEDVETET oförändrad där den redan fanns:
 *   sg-plan-v1   { "<globaltHål>": { legs: [[lat,lon], …],
 *                                   slagval: { "<slagIdx>": {…} } }
 *                (PR2:s `legs` orörd; `slagval` tillkom i GP2 och är ADDITIV —
 *                 en plan sparad före GP2 saknar bara nyckeln)
 *   sg_plan_hole spelarens hål 1–18                              (hubben, rörs ej)
 * och två nya nycklar som bara hör till vyn:
 *   sg_plan_vy   { vinkel, slope, exag, lage, forslagVal, verktyg }
 *                (U27: `forslag` → `forslagVal`. Det gamla fältet skrevs av
 *                 varje sparning oavsett om spelaren rört knappen, så det gick
 *                 inte att skilja "valde på" från "hade default på". Gamla
 *                 poster läses alltså som "inget val", vilket är sanningen.)
 *   sg_plan_pose { "<globaltHål>": {target:{x,y,z}, range, heading, tilt} }
 *   sg_plan_pin  { "<globaltHål>": [lat, lon] }        (SP4: dagens pin)
 */
const Vylage = (() => {
  const PLAN_KEY = "sg-plan-v1";
  const HOLE_KEY = "sg_plan_hole";
  const VY_KEY   = "sg_plan_vy";
  const POSE_KEY = "sg_plan_pose";
  const PIN_KEY  = "sg_plan_pin";

  const VINKLAR = ["2d", "3d"];
  const LAGEN = ["flyover", "teevy", "hojd", "slaget"];
  const EXAG_MIN = 1, EXAG_MAX = 5;

  const klamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* Minneslagring: samma yta som localStorage, för test och för en webbläsare
     där lagringen är avstängd (privat läge kastar i setItem). */
  function minneslagring() {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
    };
  }

  function las(lagring, nyckel, fallback) {
    try {
      const raw = lagring.getItem(nyckel);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : fallback;
    } catch (e) { return fallback; }
  }
  function skriv(lagring, nyckel, varde) {
    try { lagring.setItem(nyckel, JSON.stringify(varde)); } catch (e) { /* full kvot: tillståndet lever ändå i minnet */ }
  }

  /* En landningspunkt är [lat, lon] och inget annat. Kontraktet nedan
     (`laggPunkt`) är enda vägen in, oavsett om trycket kom från Leaflets
     `latlng` eller från en raycast mot 3D-marken — annars kan de två skepnaderna
     glida isär och "samma punkt" bli två punkter. */
  function punkt(p) {
    if (!p) return null;
    const lat = Array.isArray(p) ? +p[0] : +(p.lat);
    const lon = Array.isArray(p) ? +p[1] : +(p.lon != null ? p.lon : p.lng);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  }

  function skapa(opt) {
    const o = opt || {};
    const lagring = o.lagring || (typeof localStorage !== "undefined" ? localStorage : minneslagring());
    const lyssnare = [];

    const vy = las(lagring, VY_KEY, {});
    const st = {
      rel: 1,
      global: null,
      vinkel: VINKLAR.includes(vy.vinkel) ? vy.vinkel : "2d",
      slope: !!vy.slope,
      exag: Number.isFinite(+vy.exag) ? klamp(+vy.exag, EXAG_MIN, EXAG_MAX) : 3,
      lage: LAGEN.includes(vy.lage) ? vy.lage : null,
      /* U27c: förslaget är AV tills spelaren ber om det (grundarens beslut
         2026-08-12). SP3 valde motsatsen — "en plan man måste be om är en plan
         man glömmer" — men konsekvensen var att vyn ALLTID öppnade med en
         intryckt knapp och en överritning på hålet, innan spelaren hunnit se
         banan.

         NYCKELN HETER `forslagVal` OCH INTE `forslag`, och det är hela skillnaden
         mellan att beslutet syns och att det inte gör det. `sparaVy` skriver
         HELA vy-posten varje gång vinkeln, lutningen, överdriften eller läget
         ändras — alltså skrev varje tidigare session `forslag: true` utan att
         spelaren valt något. Läste vi den nyckeln hade "sparat val gäller"
         betytt att alla befintliga installationer fortsatt öppna med Plan
         intryckt, och ändringen vore osynlig just för dem som redan använder
         appen (uppmätt i webbläsaren 2026-08-12). Under det nya namnet finns
         bara ett värde om spelaren FAKTISKT tryckt på knappen efter U27. */
      forslag: vy.forslagVal === true,
      // U27b: verktygsraden är utfälld tills spelaren fäller ihop den — den som
      // inte vet att knapparna finns ska se dem.
      verktyg: vy.verktyg !== false,
      legs: [],
      slagval: {},
    };
    let plan = las(lagring, PLAN_KEY, {});
    let poser = las(lagring, POSE_KEY, {});
    let pinnar = las(lagring, PIN_KEY, {});

    const sparaVy = () => skriv(lagring, VY_KEY,
      { vinkel: st.vinkel, slope: st.slope, exag: st.exag, lage: st.lage,
        forslagVal: st.forslag, verktyg: st.verktyg });
    const sparaPlan = () => skriv(lagring, PLAN_KEY, plan);

    let tyst = 0;
    function meddela(vad) {
      if (tyst) return;
      for (const fn of lyssnare) fn(vad, api);
    }

    /* Hålvalet. `global` är hålets identitet i lagringen (slagkedjan följer
       hålet, inte positionen i rundan); `rel` är spelarens 1–18 och det enda
       som visas. Båda sätts i ETT anrop just för att de inte ska kunna glida. */
    function sattHal(rel, global) {
      const r = parseInt(rel, 10);
      if (!(r >= 1)) return false;
      st.rel = r;
      st.global = global == null ? null : global;
      st.legs = lasLegs(st.global);
      st.slagval = lasSlagval(st.global);
      try { lagring.setItem(HOLE_KEY, String(r)); } catch (e) {}
      meddela("hal");
      return true;
    }

    function lasLegs(global) {
      const e = global == null ? null : plan[String(global)];
      return (e && Array.isArray(e.legs))
        ? e.legs.map(punkt).filter(Boolean) : [];
    }

    /* GP2: slagvalen (klubba/form/ansats/höjd) per SLAG i kedjan.
       De hör till PLANEN och inte till spelaren — ett trångt hål ska inte göra
       spelaren sämre överallt (§GP2). Därför bor de här bredvid `legs` och
       aldrig i profilen. */
    function lasSlagval(global) {
      const e = global == null ? null : plan[String(global)];
      const s = e && e.slagval;
      return s && typeof s === "object" ? { ...s } : {};
    }

    function sparaLegs() {
      if (st.global == null) return;
      // Bevarar allt annat som redan står på hålet: en gammal plan som saknar
      // `slagval` ska inte få nyckeln påtvingad, och en ny plan ska inte tappa
      // sina val bara för att en punkt flyttades.
      const e = plan[String(st.global)] || {};
      plan[String(st.global)] = { ...e, legs: st.legs.map(p => [p[0], p[1]]) };
      sparaPlan();
      meddela("legs");
    }

    function sparaSlagval() {
      if (st.global == null) return;
      const e = plan[String(st.global)] || {};
      if (Object.keys(st.slagval).length) e.slagval = { ...st.slagval };
      else delete e.slagval;
      plan[String(st.global)] = e;
      sparaPlan();
      meddela("slagval");
    }

    /* Kedjan ändrades — valen måste följa med SLAGET, inte med indexet.
       Slag `i` går från punkt `i` till punkt `i+1`. Tas landningspunkt `i` bort
       smälter slag `i` och `i+1` ihop till ett; det sammanslagna slaget är en
       ANNAN sträcka än båda de gamla, så dess val släpps i stället för att ärva
       ett av dem. Att låta valet ligga kvar hade gett ett 6-järn på ett slag som
       plötsligt är 90 m längre — en siffra som ser inmatad ut och är fel. */
    function skiftaSlagval(idx, delta) {
      const nytt = {};
      for (const [k, v] of Object.entries(st.slagval)) {
        const i = parseInt(k, 10);
        if (!isFinite(i)) continue;
        if (delta < 0) {
          if (i === idx || i === idx + 1) continue;      // det sammanslagna
          nytt[i > idx ? i + delta : i] = v;
        } else {
          nytt[i >= idx ? i + delta : i] = v;
        }
      }
      st.slagval = nytt;
      sparaSlagval();
    }

    // ---- tapp-kontraktet: EN väg in för en landningspunkt, oavsett vinkel ----
    function laggPunkt(p) {
      const q = punkt(p);
      if (!q || st.global == null) return false;
      // En ny punkt läggs SIST och delar det som var sista slaget i två. Valet
      // på det slaget gäller inte längre någon av halvorna.
      const delat = st.legs.length;
      st.legs.push(q);
      sparaLegs();
      if (st.slagval[delat] !== undefined) {
        delete st.slagval[delat];
        sparaSlagval();
      }
      return true;
    }
    function flyttaPunkt(i, p) {
      const q = punkt(p);
      if (!q || !(i >= 0 && i < st.legs.length)) return false;
      st.legs[i] = q;
      sparaLegs();
      return true;
    }
    function taBortPunkt(i) {
      if (!(i >= 0 && i < st.legs.length)) return false;
      st.legs.splice(i, 1);
      sparaLegs();
      skiftaSlagval(i, -1);
      return true;
    }

    /* Slagets val, eller {} — alltid ett objekt, så anroparen slipper fråga. */
    function slagval(i) {
      const v = st.slagval[i];
      return v && typeof v === "object" ? { ...v } : {};
    }
    function harSlagval(i) { return Object.keys(slagval(i)).length > 0; }
    function antalSlagval() {
      return Object.keys(st.slagval).filter(k => harSlagval(+k)).length;
    }

    /* Ett fält satt till null TAS BORT — så uttrycks "tillbaka till profilens
       default" per fält, och därför städas ett tomt slag bort helt: ett slag
       utan val ska inte kunna se ändrat ut. Samma kontrakt som SlagJust.satt,
       med avsikt: två närliggande begrepp som beter sig olika är en fälla. */
    function sattSlagval(i, patch) {
      if (!(i >= 0)) return false;
      const nu = { ...slagval(i) };
      for (const [k, v] of Object.entries(patch || {})) {
        if (v === null || v === undefined) delete nu[k];
        else nu[k] = v;
      }
      if (Object.keys(nu).length) st.slagval[i] = nu; else delete st.slagval[i];
      sparaSlagval();
      return true;
    }
    function aterstallSlagval(i) { delete st.slagval[i]; sparaSlagval(); return true; }
    function aterstallAllaSlagval() { st.slagval = {}; sparaSlagval(); return true; }
    function angra() { return taBortPunkt(st.legs.length - 1); }

    // ---- vinkel, slope, överdrift, läge ----
    function sattVinkel(v) {
      if (!VINKLAR.includes(v) || v === st.vinkel) return false;
      st.vinkel = v;
      // Lägena hör till 3D-kameran (flyover/tee-vy/höjd/slaget). Att bära med
      // ett aktivt läge in i 2D vore att påstå att knappen gör något där.
      if (v === "2d") st.lage = null;
      sparaVy();
      meddela("vinkel");
      return true;
    }
    function sattSlope(pa) {
      const b = !!pa;
      if (b === st.slope) return false;
      st.slope = b;
      sparaVy();
      meddela("slope");
      return true;
    }
    function sattExag(v) {
      const n = klamp(+v, EXAG_MIN, EXAG_MAX);
      if (!Number.isFinite(n) || n === st.exag) return false;
      st.exag = n;
      sparaVy();
      meddela("exag");
      return true;
    }
    /* Överdriften som scenen FAKTISKT ska rita med. Rakt ovanifrån är en
       perspektivkamera en likformig skalning av markplanet bara om marken är
       platt — med överdrift 3× förskjuts en punkt 5 m hög, 150 m ut, ~2,5 m
       (mätt, §5 U11). 2D-vinkeln tvingar därför 1, och reglaget döljs där.
       Spelarens val ligger kvar i `exag` och kommer tillbaka i 3D. */
    function effektivExag() { return st.vinkel === "2d" ? 1 : st.exag; }

    function sattLage(l) {
      const n = LAGEN.includes(l) ? l : null;
      if (n === st.lage) return false;
      if (n && st.vinkel !== "3d") return false;     // lägena finns bara i 3D
      st.lage = n;
      sparaVy();
      meddela("lage");
      return true;
    }

    // ---- kamerapose per hål ----
    /* En sparad pose ska vara en POSE NÅGON VALT i 3D — inget annat (U25).
     *
     * Vinkelbytet 2D→3D sätter kameran till kartans bild (tilt 0, range på
     * kilometern) och sänker den sedan till 3D. Byter spelaren hål under den
     * halvsekunden lades den PLATTA posen undan som hålets vinkel, och nästa
     * besök i 3D öppnade rakt ovanifrån och fem mil ut — uppmätt 2026-08-11:
     * hål 2 låg i telefonen med `{range: 1863, tilt: 0}`. Det överlevde en
     * omladdning, för det låg i localStorage.
     *
     * Gränserna är camctl:s (`LIMITS`) skrivna i klartext: den här modulen är
     * medvetet importfri, så den kan inte läsa dem. Ändras de där ska de
     * ändras här — men de har inte rört sig sedan U1, och en pose utanför dem
     * kan inte komma från en gest ändå.
     *
     * Provet görs vid BÅDA ändarna: `sattPose` vägrar lägga undan en orimlig
     * pose, och `pose` vägrar lämna ut en — annars fortsätter de som redan
     * ligger i telefonen att hoppa. */
    const TILT_MIN = 5 * Math.PI / 180;     // camctl LIMITS.tiltMinGesture
    const TILT_MAX = 95 * Math.PI / 180;    // camctl LIMITS.tiltMax
    const RANGE_MIN = 20, RANGE_MAX = 3000; // camctl LIMITS.rangeMin/rangeMax
    function rimligPose(p) {
      if (!p || !p.target) return false;
      const tal = [p.target.x, p.target.y, p.target.z, p.range, p.heading, p.tilt];
      if (!tal.every(v => Number.isFinite(+v))) return false;
      if (+p.range < RANGE_MIN || +p.range > RANGE_MAX) return false;
      return +p.tilt >= TILT_MIN && +p.tilt <= TILT_MAX;
    }
    function pose(global) {
      const g = global == null ? st.global : global;
      const p = g == null ? null : poser[String(g)];
      return rimligPose(p) ? p : null;
    }
    function sattPose(p, global) {
      const g = global == null ? st.global : global;
      if (g == null || !rimligPose(p)) return false;
      poser[String(g)] = {
        target: { x: +p.target.x, y: +p.target.y, z: +p.target.z },
        range: +p.range, heading: +p.heading, tilt: +p.tilt,
      };
      skriv(lagring, POSE_KEY, poser);
      return true;
    }

    // ---- SP3/SP4: förslaget och dagens pin ----
    function sattForslag(pa) {
      const b = !!pa;
      if (b === st.forslag) return false;
      st.forslag = b;
      sparaVy();
      meddela("forslag");
      return true;
    }

    /* U27b: är verktygsraden utfälld? Läget hör till VYN och inte till hålet —
       den som fällt ihop raden för att se banan vill ha den ihopfälld på nästa
       hål också. */
    function sattVerktyg(pa) {
      const b = !!pa;
      if (b === st.verktyg) return false;
      st.verktyg = b;
      sparaVy();
      meddela("verktyg");
      return true;
    }

    /* Dagens pin, per hål. Den hör till HÅLET och inte till vyn: en pin man
       flyttat ska ligga kvar när man byter vinkel eller går ett varv i rundan.
       `null` = bandatans pin, den som värdeytan är byggd kring — och det är
       skillnaden planen måste kunna säga (§SP4). */
    function pin(global) {
      const g = global == null ? st.global : global;
      const p = g == null ? null : punkt(pinnar[String(g)]);
      return p;
    }
    function sattPin(p) {
      const q = punkt(p);
      if (!q || st.global == null) return false;
      pinnar[String(st.global)] = q;
      skriv(lagring, PIN_KEY, pinnar);
      meddela("pin");
      return true;
    }
    function aterstallPin() {
      if (st.global == null || !pinnar[String(st.global)]) return false;
      delete pinnar[String(st.global)];
      skriv(lagring, PIN_KEY, pinnar);
      meddela("pin");
      return true;
    }

    /* Flera ändringar, EN avisering. Utan detta ritar vy-sidan om sig fyra
       gånger när ett hålbyte också byter legs, läge och pose. */
    function batch(fn) {
      tyst++;
      try { fn(api); } finally { tyst--; }
      meddela("batch");
    }

    const api = {
      pa: fn => { if (typeof fn === "function") lyssnare.push(fn); },
      get rel() { return st.rel; },
      get global() { return st.global; },
      get vinkel() { return st.vinkel; },
      get slope() { return st.slope; },
      get exag() { return st.exag; },
      get lage() { return st.lage; },
      get forslag() { return st.forslag; },
      get verktyg() { return st.verktyg; },
      legs: () => st.legs.map(p => [p[0], p[1]]),
      antalLegs: () => st.legs.length,
      slagval, harSlagval, antalSlagval, sattSlagval,
      aterstallSlagval, aterstallAllaSlagval,
      allaSlagval: () => ({ ...st.slagval }),
      sattHal, sattVinkel, sattSlope, sattExag, sattLage, sattForslag,
      sattVerktyg,
      effektivExag, laggPunkt, flyttaPunkt, taBortPunkt, angra,
      pose, sattPose, pin, sattPin, aterstallPin, batch,
      /* Startvärde för hålet: ?hal=<rel> vinner över det ihågkomna. */
      startRel: (fran, max) => {
        const q = parseInt(fran, 10);
        if (q >= 1 && (!max || q <= max)) return q;
        const s = parseInt(lagring.getItem(HOLE_KEY), 10);
        return s >= 1 && (!max || s <= max) ? s : 1;
      },
    };
    return api;
  }

  return { skapa, minneslagring, punkt, VINKLAR, LAGEN, EXAG_MIN, EXAG_MAX,
           NYCKLAR: { PLAN_KEY, HOLE_KEY, VY_KEY, POSE_KEY, PIN_KEY } };
})();
if (typeof window !== "undefined") window.Vylage = Vylage;
else if (typeof globalThis !== "undefined") globalThis.Vylage = Vylage;
