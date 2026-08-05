"use strict";
/* MIN PLAN — rundplanens datamodell (UPPGRADERING_3D.md §GP3).
 *
 * Motorn finns i `src/api/planner.py` och orden i `src/api/plan_text.py`. Den
 * här modulen äger det som är kvar: planen som ett DOKUMENT spelaren äger — det
 * som går att generera, redigera, läsa offline och öppna igen efter omstart.
 *
 * TVÅ LÄGEN, ETT DOKUMENT. En genererad plan och en tom plan har exakt samma
 * form; skillnaden är att den tomma saknar `shots` och `malscore` tills spelaren
 * skrivit dem. Vore de två olika dokumenttyper hade varje vy behövt fråga vilken
 * sort den ritade, och den som glömde hade renderat halva planen.
 *
 * REDIGERINGEN LIGGER BREDVID, ALDRIG OVANPÅ. Spelarens text sparas i `egen`,
 * motorns svar står orört kvar i `shots`/`malscore`. Därför går en ändring att
 * ångra, och därför kan planen räknas om utan att anteckningarna följer med i
 * fallet. Det är också vad §GP3:s "ingen siffra i texten saknar motsvarighet i
 * planner.py-svaret" kräver: skulle spelarens egen text skriva över motorns vore
 * det inte längre sant om dokumentet.
 *
 * REN och importfri (som planslag.js, vylage.js och spelprofil.js): ingen Store,
 * ingen DOM, inget fetch. `node tests/js/test_plan.mjs` kör den utan webbläsare,
 * och sidan (`plan.html`) hämtar och sparar.
 */
const Plan = (() => {
  const V = 1;

  const klon = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const nu = () => new Date().toISOString();

  function uuid() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /* ---- hålkortet -------------------------------------------------------
     `kort` är API:ts svar (api/plan_text.hole_card) plus spelarens `egen`.
     Fälten som API:t inte fyllt är null och inte utelämnade: en tom plan och
     en genererad plan ska ha samma nycklar. */
  function tomtKort(rel, meta) {
    const m = meta || {};
    return {
      rel, hole_global: m.hole_global != null ? m.hole_global : null,
      loop: m.loop || null, hole_number: m.hole_number != null ? m.hole_number : null,
      par: m.par != null ? m.par : null,
      hole_dist: m.hole_dist != null ? m.hole_dist : null,
      expected_score: null, vs_par: null,
      rubrik: `Hål ${rel}` + (m.loop && m.hole_number ? ` · ${m.loop} ${m.hole_number}` : ""),
      fakta: m.par != null ? `Par ${m.par}` + (m.hole_dist != null ? ` · ${Math.round(m.hole_dist)} m` : "") : "",
      malscore: null, shots: [], i_spel: null, undvik: null, stil: null,
      tee_latlon: m.tee_latlon || null, pin_latlon: m.pin_latlon || null,
      egen: { anteckning: "", mal: null, slagtext: {} },
    };
  }

  /* Skelettet först, svaret ovanpå: ETT läge får aldrig sakna en nyckel det
     andra har. Utan det hade en vy kunnat läsa `kort.pin_latlon` och få
     `undefined` bara för att API:t inte skickade fältet den gången — och
     `undefined` är det tillstånd ingen kommer ihåg att hantera. */
  function normaliseraKort(k, rel) {
    const bas = tomtKort((k && k.rel) != null ? k.rel : rel, k || {});
    delete bas.egen;
    const o = Object.assign(bas, k || {});
    o.rel = o.rel != null ? o.rel : rel;
    o.shots = Array.isArray(o.shots) ? o.shots : [];
    const e = o.egen && typeof o.egen === "object" ? o.egen : {};
    o.egen = {
      anteckning: typeof e.anteckning === "string" ? e.anteckning : "",
      mal: Number.isFinite(+e.mal) && e.mal !== null && e.mal !== "" ? +e.mal : null,
      slagtext: (e.slagtext && typeof e.slagtext === "object") ? e.slagtext : {},
    };
    return o;
  }

  /* ---- dokumentet ------------------------------------------------------ */
  function normalisera(p) {
    const o = Object.assign({}, p || {});
    o.id = o.id || uuid();
    o.v = V;
    o.kind = o.kind === "tom" ? "tom" : "genererad";
    o.spec = o.spec || "1-18";
    o.course = o.course || null;
    o.courseName = o.courseName || null;
    o.profil = o.profil || null;
    o.summary = o.summary || null;
    o.totals = o.totals || null;
    o.createdAt = o.createdAt || nu();
    o.updatedAt = o.updatedAt || o.createdAt;
    o.holes = (Array.isArray(o.holes) ? o.holes : []).map((k, i) => normaliseraKort(k, i + 1));
    return o;
  }

  /* En TOM plan att fylla i själv. `holes` = bandatans hålmeta i spelordning
     ({loop, hole_number, par, hole_dist}) — planen hittar aldrig på ett hål,
     och saknas bandata blir listan tom i stället för påhittad. */
  function tom(opt) {
    const o = opt || {};
    return normalisera({
      kind: "tom", spec: o.spec, course: o.course, courseName: o.courseName,
      profil: o.profil || null,
      holes: (o.holes || []).map((m, i) => tomtKort(i + 1, m)),
    });
  }

  /* API:ts `/api/plan/kort`-svar → ett plandokument. `fore` = en tidigare plan
     vars redigeringar ska följa med (samma hål, samma spelordning): en spelare
     som räknar om planen efter att ha bytt tee ska inte tappa sina egna rader.
     Matchningen går på GLOBALT hålnummer och inte på plats i listan — byter
     spelaren slinga är hål 3 inte längre samma hål. */
  function franKort(svar, opt) {
    const s = svar || {}, o = opt || {};
    const gamla = new Map();
    for (const k of ((o.fore && o.fore.holes) || [])) {
      if (k && k.hole_global != null) gamla.set(String(k.hole_global), k.egen);
    }
    return normalisera({
      id: o.fore && o.fore.id ? o.fore.id : null,
      createdAt: o.fore ? o.fore.createdAt : null,
      updatedAt: nu(),
      kind: "genererad",
      spec: s.spec || o.spec,
      course: s.course || o.course, courseName: o.courseName,
      // `raknad`/`egen`: vilken yta svaret kom ur, när den inte var spelarens
      // egen (§SP3b). `drive/approach/baseline` är fortsatt SPELARENS — det är
      // dem `stammerMedProfil` jämför, och de får inte bytas mot kompromissens.
      profil: { drive: s.drive, approach: s.approach, baseline: s.baseline,
                raknad: s.profil_raknad || null,
                egen: s.profil_egen !== false,
                stil: s.stil || null, plan_version: s.plan_version || null },
      summary: s.summary || null, totals: s.totals || null,
      holes: (s.holes || []).map((k, i) => {
        const kort = normaliseraKort(k, i + 1);
        const egen = k && k.hole_global != null ? gamla.get(String(k.hole_global)) : null;
        if (egen) kort.egen = normaliseraKort({ egen }, i + 1).egen;
        return kort;
      }),
    });
  }

  /* ---- redigering ------------------------------------------------------
     Alla returnerar en NY plan (klon), av samma skäl som Planslag inte skriver:
     en vy som råkar mutera dokumentet den ritar är omöjlig att felsöka. */
  function _andra(p, rel, fn) {
    const ny = normalisera(klon(p));
    const k = ny.holes.find(x => x.rel === rel);
    if (!k) return ny;
    fn(k);
    ny.updatedAt = nu();
    return ny;
  }

  const sattAnteckning = (p, rel, txt) =>
    _andra(p, rel, k => { k.egen.anteckning = String(txt == null ? "" : txt); });

  /* Eget målscore. Tomt/ogiltigt återställer till motorns tal i stället för att
     spara ett skräpvärde — "inget eget mål" är ett giltigt läge. */
  const sattMal = (p, rel, v) => _andra(p, rel, k => {
    const n = parseInt(v, 10);
    k.egen.mal = Number.isFinite(n) && n >= 1 && n <= 15 ? n : null;
  });

  const sattSlagtext = (p, rel, nr, txt) => _andra(p, rel, k => {
    const t = String(txt == null ? "" : txt).trim();
    if (t) k.egen.slagtext[String(nr)] = t;
    else delete k.egen.slagtext[String(nr)];
  });

  /* Ta bort ALLT spelaren skrivit på ett hål — motorns svar står kvar. */
  const aterstall = (p, rel) => _andra(p, rel, k => {
    k.egen = { anteckning: "", mal: null, slagtext: {} };
  });

  /* ---- läsning ---------------------------------------------------------- */

  /* Målscore som ETT tal: spelarens eget om det finns, annars motorns förväntade
     score avrundad. Avrundningen är en rendering av planens tal och inget nytt
     påstående (samma regel som plan_text.py:s docstring beskriver) — och därför
     följer `kalla` med, så vyn kan säga vilket det är. */
  function mal(kort) {
    const k = kort || {};
    if (k.egen && k.egen.mal != null) return { value: k.egen.mal, kalla: "egen" };
    if (k.expected_score != null) return { value: Math.round(k.expected_score), kalla: "motor" };
    if (k.par != null) return { value: k.par, kalla: "par" };
    return { value: null, kalla: "saknas" };
  }

  /* Slagets text: spelarens egen om den finns, annars motorns. */
  function slagtext(kort, slag) {
    const egen = kort && kort.egen && kort.egen.slagtext[String(slag && slag.nr)];
    return egen ? { text: egen, kalla: "egen" } : { text: (slag && slag.text) || "", kalla: "motor" };
  }

  /* Länken som öppnar ETT slags siktepunkt i planeringsvyn (princip 4: samma
     punkt, sedd från den andra vinkeln). Saknas siktet finns ingen länk — en
     knapp som öppnar "ungefär där" vore värre än ingen knapp. */
  function siktLank(kort, slag) {
    const p = slag && slag.aim_latlon;
    if (!kort || !p || p.length !== 2) return null;
    const tal = n => Math.round(n * 1e6) / 1e6;
    return `planvy.html?hal=${kort.rel}&sikte=${tal(p[0])},${tal(p[1])}`;
  }

  /* Har spelaren skrivit något alls på hålet? Vyn markerar de hålen, så en
     redigerad plan går att känna igen utan att bläddra igenom den. */
  function harEget(kort) {
    const e = (kort && kort.egen) || {};
    return !!(e.anteckning || e.mal != null || Object.keys(e.slagtext || {}).length);
  }

  /* Stämmer planen med spelarens NUVARANDE profil? En plan räknad på en annan
     spridning är inte fel — men den är inte längre spelarens, och vyn ska säga
     det i stället för att låta talen se färska ut. */
  function stammerMedProfil(p, kombination) {
    const a = (p && p.profil) || null, b = kombination || null;
    if (!a || !b) return null;
    return a.drive === b.drive && a.approach === b.approach && a.baseline === b.baseline;
  }

  return { V, tom, franKort, normalisera, tomtKort,
           sattAnteckning, sattMal, sattSlagtext, aterstall,
           mal, slagtext, siktLank, harEget, stammerMedProfil };
})();

if (typeof window !== "undefined") window.Plan = Plan;
else if (typeof globalThis !== "undefined") globalThis.Plan = Plan;
if (typeof module !== "undefined" && module.exports) module.exports = Plan;
