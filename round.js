"use strict";
/* Delad rund-/hålnumrering för alla mobilsidor (index, karta, oversikt).
 *
 * Spelarens hålnummer (1–18 = positionen i vald runda) är den enda "valutan"
 * i UI:t och i localStorage-nyckeln sg_hole. De fasta globala numren
 * (Blå 1–9, Gul 10–18, Svart 19–27 för Burlöv) används bara internt mot
 * bandata och i exporten till analysen.
 *
 * B3: koden är inte längre hårdkodad mot Burlöv. GLOBAL_BASE/LOOP_SHORT/
 * ROUND_SEQ/HOLES härleds synkront ur AKTIV banas meta (cachad i
 * localStorage under sg_course_meta, aktiv slug under sg_course). Saknas
 * cache (första laddning, offline) faller vi tillbaka på en inbyggd
 * Burlöv-default som ger EXAKT samma värden som innan B3 — så beteendet är
 * oförändrat tills en användare aktivt väljer en annan bana. */
const SGRound = (() => {
  const BURLOV_META = {
    slug: "malmo_burlov",
    name: "Malmö Burlöv Golfklubb",
    mobile_json: "burlov.json",
    loops: [
      { name: "Blue Course", short: "Blå", holes: 9 },
      { name: "Yellow Course", short: "Gul", holes: 9 },
      { name: "Black Course", short: "Svart", holes: 9 },
    ],
    rounds: [
      { value: "1-18", label: "1–18", seq: Array.from({ length: 18 }, (_, i) => i + 1) },
      { value: "10-27", label: "10–27", seq: Array.from({ length: 18 }, (_, i) => i + 10) },
      { value: "19-9", label: "19–9",
        seq: [...Array.from({ length: 9 }, (_, i) => i + 19),
              ...Array.from({ length: 9 }, (_, i) => i + 1)] },
    ],
    tees: ["61", "57", "53", "48"],
  };

  let meta = null;      // aktiv banas meta-objekt (byggs av build())
  let GLOBAL_BASE = {}; // loop-namn → kumulativ offset
  let LOOP_SHORT = {};  // loop-namn → kort visningsnamn
  let ROUND_SEQ = {};   // rundvärde → sekvens av globala hålnummer
  let courseHoles = 18; // fallback: HELA banans hål, om vald runda saknar seq

  function readCachedMeta() {
    try {
      const raw = localStorage.getItem("sg_course_meta");
      if (!raw) return null;
      const m = JSON.parse(raw);
      if (m && Array.isArray(m.loops) && Array.isArray(m.rounds)) return m;
    } catch (e) {}
    return null;
  }

  /* Rena tabeller ur EN banas meta — utan att röra aktiv bana.
     Behövs för att läsa en HISTORISK runda: den bär sin egen `courseSlug` och
     `roundSeq` (APPSTORE_PLAN §9.1.3), och måste översättas med SIN banas
     slingoffset — inte den bana som råkar vara aktiv i appen nu. Samma sorts fel
     som frysningen av `global` i dokumentet stängde för exporten.

     Obs: `loop.name` är `null` för enslingebanor (Elisefarm, Falsterbo, …).
     Det är avsiktligt och funkar: JS stringifierar nyckeln, så `base[null]`
     skrivs och läses konsekvent, och bandatans hål bär samma `loop: null`. */
  function tablesFor(m) {
    const GB = {}, LS = {}, RS = {};
    let acc = 0;
    for (const loop of (m && m.loops) || []) {
      GB[loop.name] = acc;
      LS[loop.name] = loop.short;
      acc += loop.holes;
    }
    for (const r of (m && m.rounds) || []) RS[r.value] = r.seq;
    return { GLOBAL_BASE: GB, LOOP_SHORT: LS, ROUND_SEQ: RS, courseHoles: acc };
  }

  function build(m) {
    meta = m;
    const t = tablesFor(m);
    GLOBAL_BASE = t.GLOBAL_BASE;
    LOOP_SHORT = t.LOOP_SHORT;
    ROUND_SEQ = t.ROUND_SEQ;
    courseHoles = t.courseHoles;
  }

  build(readCachedMeta() || BURLOV_META);

  function activeSlug() {
    return (meta && meta.slug) || localStorage.getItem("sg_course") || BURLOV_META.slug;
  }
  function mobileJson() {
    return (meta && meta.mobile_json) || "burlov.json";
  }
  function courseName() {
    return (meta && meta.name) || BURLOV_META.name;
  }
  function setActiveCourse(newMeta) {
    if (!newMeta || !Array.isArray(newMeta.loops) || !Array.isArray(newMeta.rounds)) return;
    build(newMeta);
    try {
      localStorage.setItem("sg_course_meta", JSON.stringify(newMeta));
      localStorage.setItem("sg_course", newMeta.slug || "");
    } catch (e) {}
  }

  function roundName() {
    const n = localStorage.getItem("sg_round");
    if (ROUND_SEQ[n]) return n;
    // första rundan i aktiv banas meta som fallback (robust mot bytt bana)
    const first = meta && meta.rounds && meta.rounds[0] && meta.rounds[0].value;
    return first || "1-18";
  }
  function seq() { return ROUND_SEQ[roundName()]; }
  // Antal spelarhål i AKTIVT VALD runda, inte bara bygget vid build()-tillfället
  // — en runda kortare än courseHoles (t.ex. en 9-håls-slinga) ska begränsa
  // hålnavigeringen till sin egen längd, inte råka ärva en annan rundas.
  function holes() { const s = seq(); return (s && s.length) || courseHoles; }
  // spelarens hål (1–18) → globalt hålnummer, null om utanför rundan
  function relToGlobal(rel) { return seq()[rel - 1] || null; }
  // globalt hålnummer → spelarens hål (1–18), null om hålet inte ingår i rundan
  function globalToRel(g) { const i = seq().indexOf(g); return i >= 0 ? i + 1 : null; }
  // engångsmigrering: äldre versioner sparade globalt hålnummer i sg_hole
  function migrateSgHole() {
    const v = parseInt(localStorage.getItem("sg_hole"), 10);
    if (v > holes()) {
      const rel = globalToRel(v) || 1;
      try { localStorage.setItem("sg_hole", rel); } catch (e) {}
      return rel;
    }
    return v;
  }
  return {
    get meta() { return meta; },
    get GLOBAL_BASE() { return GLOBAL_BASE; },
    get LOOP_SHORT() { return LOOP_SHORT; },
    get ROUND_SEQ() { return ROUND_SEQ; },
    get HOLES() { return holes(); },
    roundName, seq, relToGlobal, globalToRel, migrateSgHole,
    mobileJson, activeSlug, setActiveCourse, courseName, tablesFor,
    BURLOV_DEFAULT: BURLOV_META,
  };
})();
if (typeof window !== "undefined") window.SGRound = SGRound;
else if (typeof globalThis !== "undefined") globalThis.SGRound = SGRound;
