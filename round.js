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
  let HOLES = 18;       // antal spelarhål totalt (summan av en runda-seq)

  function readCachedMeta() {
    try {
      const raw = localStorage.getItem("sg_course_meta");
      if (!raw) return null;
      const m = JSON.parse(raw);
      if (m && Array.isArray(m.loops) && Array.isArray(m.rounds)) return m;
    } catch (e) {}
    return null;
  }

  function build(m) {
    meta = m;
    GLOBAL_BASE = {};
    let acc = 0;
    for (const loop of m.loops) {
      GLOBAL_BASE[loop.name] = acc;
      acc += loop.holes;
    }
    LOOP_SHORT = {};
    for (const loop of m.loops) LOOP_SHORT[loop.name] = loop.short;
    ROUND_SEQ = {};
    for (const r of m.rounds) ROUND_SEQ[r.value] = r.seq;
    HOLES = (m.rounds[0] && m.rounds[0].seq.length) || acc;
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
  // spelarens hål (1–18) → globalt hålnummer, null om utanför rundan
  function relToGlobal(rel) { return seq()[rel - 1] || null; }
  // globalt hålnummer → spelarens hål (1–18), null om hålet inte ingår i rundan
  function globalToRel(g) { const i = seq().indexOf(g); return i >= 0 ? i + 1 : null; }
  // engångsmigrering: äldre versioner sparade globalt hålnummer i sg_hole
  function migrateSgHole() {
    const v = parseInt(localStorage.getItem("sg_hole"), 10);
    if (v > HOLES) {
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
    get HOLES() { return HOLES; },
    roundName, seq, relToGlobal, globalToRel, migrateSgHole,
    mobileJson, activeSlug, setActiveCourse, courseName,
    BURLOV_DEFAULT: BURLOV_META,
  };
})();
if (typeof window !== "undefined") window.SGRound = SGRound;
else if (typeof globalThis !== "undefined") globalThis.SGRound = SGRound;
