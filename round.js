"use strict";
/* Delad rund-/hålnumrering för alla mobilsidor (index, karta, oversikt).
 *
 * Spelarens hålnummer (1–18 = positionen i vald runda) är den enda "valutan"
 * i UI:t och i localStorage-nyckeln sg_hole. De fasta globala numren
 * (Blå 1–9, Gul 10–18, Svart 19–27) används bara internt mot bandata och i
 * exporten till analysen. Byt GLOBAL_BASE om klubben numrerar slingorna
 * annorlunda. */
const SGRound = (() => {
  const GLOBAL_BASE = { "Blue Course": 0, "Yellow Course": 9, "Black Course": 18 };
  const LOOP_SHORT = { "Blue Course": "Blå", "Yellow Course": "Gul", "Black Course": "Svart" };
  const ROUND_SEQ = {
    "1-18":  Array.from({ length: 18 }, (_, i) => i + 1),
    "10-27": Array.from({ length: 18 }, (_, i) => i + 10),
    "19-9":  [...Array.from({ length: 9 }, (_, i) => i + 19),
              ...Array.from({ length: 9 }, (_, i) => i + 1)],
  };
  const HOLES = 18;

  function roundName() {
    const n = localStorage.getItem("sg_round");
    return ROUND_SEQ[n] ? n : "1-18";
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
  return { GLOBAL_BASE, LOOP_SHORT, ROUND_SEQ, HOLES,
           roundName, seq, relToGlobal, globalToRel, migrateSgHole };
})();
