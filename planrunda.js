"use strict";
/* RUNDANS PLAN, RÄKNAD I TELEFONEN (SPELPLAN_PLAN §SP5).
 *
 * `forslag.js` svarar på ETT hål. Den här modulen gör 18 sådana svar till ett
 * DOKUMENT i exakt den form `/api/plan/kort` hade — samma nycklar, samma
 * hålkort — så `plan.js` kan ta emot det med `franKort` utan en rad ändrad.
 * Det är hela poängen: spelarens `egen`-lager och matchningen på GLOBALT
 * hålnummer är det som gör en plan redigerbar och omräkningsbar, och den koden
 * ska inte skrivas om bara för att svaret numera kommer inifrån telefonen.
 *
 * DOKUMENTET ÄR BESLUTSFÖRST. §5.2 mätte att tystnad är normaltillståndet: på
 * Burlöv ställer 1 hål av 21 en fråga vindstilla. En plan som ändå ger alla 18
 * hål lika mycket plats säger att alla 18 är lika viktiga, vilket är osant och
 * dessutom oläsbart på en teebox. Korten bär därför `beslut` (bool) och `gap`,
 * och sidan sorterar på dem.
 *
 * VAD SOM INTE FÅR STÅ HÄR (§5.3). Absolut förväntad score är förbjuden — en
 * vindfri yta är 0,04–0,23 slag optimistisk på NIVÅN. Därför är `expected_score`
 * och `malscore` med avsikt null i ett lokalt kort: målscore blir spelarens eget
 * tal eller par, aldrig motorns nivå. Det som FÅR skrivas är skillnaden mellan
 * alternativ (≤ 0,069 slags fel) och andelar i femsteg.
 *
 * GRINDEN FÖLJER MED. Varje rad byggs av BITAR ur `Forslag` (ord/tal/namn med
 * källa i svaret), aldrig av en mall som råkar innehålla siffror — samma grind
 * som `tests/test_plan_text.py` höll på Python-sidan, nu i JS
 * (`tests/js/test_planrunda.mjs`). Undantagna är `rubrik` och `fakta`, som bär
 * STRUKTURTAL ur bandatan (hålets nummer, par, längd) och inga påståenden om
 * spelet — samma undantag som plan_text.py:s docstring skriver ut.
 *
 * REN och importfri (som planslag.js, plan.js och vylage.js): ingen DOM, ingen
 * Store, inget fetch, ingen egen aritmetik. Sidan hämtar och räknar förslagen;
 * modulen sätter ihop dokumentet. `node tests/js/test_planrunda.mjs` kör den
 * utan webbläsare.
 */
const Planrunda = (() => {
  const V = 1;

  const F = () => (typeof Forslag !== "undefined" ? Forslag
                   : (typeof globalThis !== "undefined" ? globalThis.Forslag : null));

  const rundaTal = (v) => (v == null ? null : Math.round(v));

  /* ---- slagraderna ------------------------------------------------------
     Formen speglar `plan_text.py:_shot_card`: nr, kind, rubrik, text,
     aim_latlon. `bitar` är nytt och är grindens fäste — texten är summan av
     dem, aldrig en sträng byggd vid sidan om. */
  function slagkort(nr, kind, rubrik, bitar, aim) {
    const f = F();
    return { nr, kind, rubrik: `Slag ${nr} · ${rubrik}`, text: f.bygg(bitar),
             bitar, aim_latlon: aim || null };
  }

  /* Utslaget mot värdeytan: klubba, siktlinje och vad svepet mätte. */
  function teeSlag(f, nr) {
    const M = F();
    const r = f.rekommenderad;
    const bitar = [M.namn(r.shot, "rekommenderad.shot"), M.ord(" — sikta")]
      .concat(M.siktbit(r.offset_m))
      .concat([M.ord(". Fairway "), M.andel(r.fairway_pct, "rekommenderad.fairway_pct"),
               M.ord(", fara "), M.andel(r.hazard_pct, "rekommenderad.hazard_pct"),
               M.ord(".")]);
    // Punkten i kartan är MEDELLANDNINGEN och inte siktet: det är den som blir
    // en `leg` när spelaren tar emot planen, och den som nästa slag utgår från.
    return slagkort(nr, "tee", "Utslag", bitar, f.punkter[0] || null);
  }

  /* Inspelet. `forsta` = hålet ÄR ett inspel (par 3) — då är utslaget slaget,
     och rubriken ska säga det i stället för att låtsas om en kedja. */
  function inspelSlag(f, nr, forsta) {
    const M = F();
    const insp = f.inspel, r = insp.rekommenderad;
    const bitar = [M.ord(forsta ? "Utslag mot green, " : "Inspel från "),
                   M.tal(insp.dist, String(Math.round(insp.dist)), "inspel.dist", 0.5),
                   M.ord(" m — sikta ")]
      .concat(M.siktePinBitar(r, "inspel.rekommenderad"))
      .concat([M.ord(". Green "), M.andel(r.green_pct, "inspel.rekommenderad.green_pct"),
               M.ord(", fara "), M.andel(r.hazard_pct, "inspel.rekommenderad.hazard_pct"),
               M.ord(".")]);
    return slagkort(nr, "inspel", forsta ? "Utslag mot green" : "Inspel",
                    bitar, f.sikte || null);
  }

  /* ---- raderna vid sidan av slagen -------------------------------------- */

  // Under den här andelen är faran inte i spel utan brus i rullningen — samma
  // gräns som `plan_text.FARA_MIN_PCT`, av samma skäl.
  const FARA_MIN_PCT = 5;

  function rader(f) {
    const M = F();
    const ut = [];
    // BESLUTET, när det finns. Tystnaden är normaltillståndet (§5.2) och ska
    // synas som tystnad: ett hål utan beslut får ingen rad alls här.
    if (f.harBeslut && f.alternativ && f.gap != null) {
      ut.push({ sort: "alternativ", bitar: [
        M.ord("Alternativet "), M.namn(f.alternativ.shot, "alternativ.shot"),
        M.ord(" kostar "), M.tal(f.gap, M.slagText(f.gap), "gap"),
        M.ord(" slag här.")] });
    }
    // Faran för DEN HÄR spelarens spridning — inte hålets faror i allmänhet.
    const kalla = f.gren === "tee" ? "rekommenderad" : "inspel.rekommenderad";
    const k = f.gren === "tee" ? f.rekommenderad
                               : (f.inspel && f.inspel.rekommenderad);
    if (k && k.hazard_pct >= FARA_MIN_PCT) {
      ut.push({ sort: "risk", bitar: [
        M.ord("I spel för din spridning: fara "),
        M.andel(k.hazard_pct, kalla + ".hazard_pct"), M.ord(".")] });
    }
    return ut.map(r => ({ ...r, text: M.bygg(r.bitar) }));
  }

  /* ---- hålkortet --------------------------------------------------------
     `meta` är hålets rader ur BANDATAN (rel, globalt nummer, loop, par, längd)
     — planen hittar aldrig på ett hål. `f` är motorns svar, eller null när
     hålet saknas i värdeytan; då blir kortet tomt men fullständigt, för en
     tom plats i listan ska se ut som ett hål utan plan och inte som ett fel. */
  function kort(f, meta, opt) {
    const M = F(), m = meta || {}, o = opt || {};
    const rel = m.rel;
    const bas = {
      hole_global: m.hole_global != null ? m.hole_global : null,
      rel, loop: m.loop || null,
      hole_number: m.hole_number != null ? m.hole_number : null,
      par: m.par != null ? m.par : null,
      hole_dist: m.hole_dist != null ? m.hole_dist : null,
      // §5.3: motorns NIVÅ får inte skrivas ut. Fälten finns kvar (formen är
      // API:ts) men står null, och `Plan.mal` faller då tillbaka på par.
      expected_score: null, vs_par: null, malscore: null,
      rubrik: `Hål ${rel}` + (m.loop && m.hole_number ? ` · ${m.loop} ${m.hole_number}` : ""),
      fakta: (m.par != null ? `Par ${m.par}` : "")
        + (m.hole_dist != null ? `${m.par != null ? " · " : ""}${rundaTal(m.hole_dist)} m` : ""),
      shots: [], rader: [], i_spel: null, undvik: null, stil: null,
      beslut: false, gap: null, gren: null, villkor: null,
      punkter: [], sikte: null,
      tee_latlon: m.tee_latlon || null, pin_latlon: m.pin_latlon || null,
    };
    if (!f) return { ...bas, saknas: true };

    const slag = [];
    if (f.gren === "tee") {
      slag.push(teeSlag(f, 1));
      if (f.inspel) slag.push(inspelSlag(f, 2, false));
    } else if (f.inspel) {
      slag.push(inspelSlag(f, 1, true));
    }
    const rad = rader(f);
    const risk = rad.find(r => r.sort === "risk");
    return {
      ...bas,
      shots: slag,
      rader: rad,
      i_spel: risk ? risk.text : null,
      beslut: !!f.harBeslut, gap: f.gap != null ? f.gap : null, gren: f.gren,
      villkor: M.villkorstext(f, { streck: o.streck }),
      punkter: f.punkter || [], sikte: f.sikte || null,
      pin_latlon: m.pin_latlon || null,
      saknas: false,
    };
  }

  /* ---- dokumentet -------------------------------------------------------
     Svaret har `/api/plan/kort`:s form. Inget nytt fält är obligatoriskt för
     `plan.js` — de som tillkommit (`beslut`, `gap`, `villkor`, `rader`) läses
     av sidan och överlever `normaliseraKort` eftersom den kopierar hela
     kortet över sitt skelett. */
  function bygg(o) {
    const a = o || {};
    const komb = a.kombination || {};
    const holes = (a.hal || []).map((h, i) =>
      kort(h.f || null, { rel: i + 1, ...(h.meta || {}) }, a));
    const beslut = holes.filter(k => k.beslut).length;
    return {
      spec: a.spec || "1-18",
      course: a.course || null,
      drive: komb.drive || null, approach: komb.approach || null,
      baseline: komb.baseline || null,
      stil: a.stil || null,
      plan_version: a.planVersion || null,
      // SP5: planen räknas i telefonen. Fältet finns för att en läsare (och ett
      // test) ska kunna se VAR ett dokument kommer ifrån — en plan hämtad från
      // PC:n och en räknad på banan är inte samma sorts påstående.
      kalla: "telefonen",
      summary: sammanfattning(holes.length, beslut),
      totals: { hal: holes.length, beslut },
      holes,
    };
  }

  /* Rundnivåns rad. Talen är STRUKTUR (antal hål, antal beslut) och inga
     påståenden om spelet — samma undantag som rubrikerna har. Den viktiga
     meningen är den andra: tystnad är ett svar, och planen ska säga det rakt
     ut i stället för att se tom ut. */
  function sammanfattning(antal, beslut) {
    if (!antal) return null;
    if (!beslut) {
      return `${antal} hål · inget hål ställer en fråga i dag — planen är `
        + `klubba och siktpunkt.`;
    }
    return `${antal} hål · ${beslut} ställer en fråga. Resten är klubba och `
      + `siktpunkt.`;
  }

  /* Hålen i LÄSORDNING: besluten först (störst gap överst), resten i
     spelordning. Ordningen är en LÄSNING och ändrar inte dokumentet — planen
     lagras alltid i spelordning, för det är den ordningen hålen spelas i. */
  function beslutForst(holes) {
    const lista = Array.isArray(holes) ? holes : [];
    const b = lista.filter(k => k.beslut)
      .sort((x, y) => (y.gap || 0) - (x.gap || 0));
    const r = lista.filter(k => !k.beslut);
    return { beslut: b, ovriga: r };
  }

  /* Länken som öppnar hålets FÖRSLAG i planeringsvyn — landningarna som legs
     och siktet sist, precis den form `planvy.html:planSikte` läser (§GP3).
     Saknas punkter finns ingen länk: en knapp som öppnar "ungefär där" är
     värre än ingen knapp. */
  function planvyLank(kort) {
    const p = [...((kort && kort.punkter) || [])];
    if (kort && kort.sikte) p.push(kort.sikte);
    if (!p.length) return null;
    const tal = n => Math.round(n * 1e6) / 1e6;
    return `planvy.html?hal=${kort.rel}&sikte=`
      + p.map(q => `${tal(q[0])},${tal(q[1])}`).join(";");
  }

  return { V, bygg, kort, rader, beslutForst, planvyLank, sammanfattning,
           FARA_MIN_PCT };
})();

if (typeof window !== "undefined") window.Planrunda = Planrunda;
else if (typeof globalThis !== "undefined") globalThis.Planrunda = Planrunda;
if (typeof module !== "undefined" && module.exports) module.exports = Planrunda;
