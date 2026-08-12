"use strict";
/* Strokes Gained i klienten (APPSTORE_PLAN.md §3.2, etapp AS5).
 *
 * DEN BÄRANDE REGELN: SG-modellen skrivs ALDRIG två gånger. Python producerar
 * tabellerna (`data/baseline/expected_strokes_*.csv` → `mobile/data/baseline.json`
 * via `tools/publish_mobile_baseline.py`); denna fil SLÅR UPP i dem och gör
 * aritmetik. Då finns en modell och två tunna läsare i stället för två modeller
 * som glider isär osynligt.
 *
 * Att det stämmer är inte en förhoppning: `tests/test_sg_golden.py` kör samma
 * (lie, distans) genom `src/sg/baseline.py` och genom denna fil och kräver
 * likhet på tredje decimalen. Ändrar någon semantiken på ett ställe blir testet
 * rött.
 *
 * ÄVEN UPPSLAGSREGLERNA KOMMER UR JSON:en — lie-alias, fallback-lie och
 * tjockruffens påslag. Hårdkodade här hade de varit en andra modell.
 *
 * RENA funktioner, ingen DOM och ingen fetch. Sidan (eller testet) laddar JSON
 * och kallar `SG.load(json)` en gång.
 *
 * VIKTIG BEGRÄNSNING — läs innan du litar på en SG-siffra per slag:
 * det som gör SG rätt är inte bara tabellen utan att LÄGET (lie) klassas som
 * PC-sidan gör det. Klienten kan i dag inte se `heavy_rough`, `ob` eller
 * tee-ytan, och kallar vattenhindret `water` där PC:n säger `water_hazard`.
 * Se APPSTORE_PLAN §9.5. Därför exponerar modulen `lieFromSurface()` som
 * ÖVERSÄTTER och `lieParityWarnings()` som säger vad som inte går att lita på.
 */
globalThis.SG = (() => {
  let D = null;                       // laddad baseline.json

  function load(json) {
    if (!json || !json.baselines) throw new Error("SG.load: ogiltig baseline.json");
    D = json;
    return D;
  }
  const loaded = () => !!D;
  const names = () => (D ? Object.keys(D.baselines) : []);
  const labels = () => (D && D.labels) || {};
  const defaultName = () => (D && D.default) || "scratch";

  /* Förväntat antal slag kvar från (lie, avstånd).
     Semantiken speglar `src/sg/baseline.py::expected_strokes` STEG FÖR STEG:
       1. tjockruffens påslag räknas ut FÖRE alias-mappningen (annars försvinner
          det, eftersom heavy_rough mappas till rough),
       2. alias,
       3. okänd lie → fallback,
       4. klampa utanför tabellens ändpunkter,
       5. linjär interpolation mellan omgivande punkter. */
  function expectedStrokes(lie, distanceM, baselineName) {
    if (!D) throw new Error("SG: baseline.json inte laddad");
    const tbl = D.baselines[baselineName || D.default];
    if (!tbl) return null;
    if (distanceM == null || !isFinite(distanceM)) return null;

    const extra = lie === "heavy_rough" ? D.heavyRoughCost : 0;
    let key = D.lieAliases[lie] || lie;
    if (!tbl[key]) key = D.fallbackLie;
    const pts = tbl[key];
    if (!pts || !pts.length) return null;

    if (distanceM <= pts[0][0]) return pts[0][1] + extra;
    if (distanceM >= pts[pts.length - 1][0]) return pts[pts.length - 1][1] + extra;
    // första punkten med distans >= den sökta (motsvarar Pythons bisect_left)
    let i = 0;
    while (i < pts.length && pts[i][0] < distanceM) i++;
    const [d0, s0] = pts[i - 1], [d1, s1] = pts[i];
    const t = (distanceM - d0) / (d1 - d0);
    return s0 + t * (s1 - s0) + extra;
  }

  /* Slagkategori — speglar `src/sg/strokes_gained.py::category`. */
  const AROUND_GREEN_M = 27.0;
  function category(startLie, startDistM) {
    if (startLie === "green") return "putting";
    if (startLie === "tee") return "off_the_tee";
    return startDistM <= AROUND_GREEN_M ? "around_green" : "approach";
  }

  /* SG för ETT slag: E(start) − E(slut) − 1 − plikt.
     Speglar `src/sg/strokes_gained.py::strokes_gained`. Holat slag → E(slut)=0. */
  function strokesGained(o) {
    const p = o || {};
    const eStart = expectedStrokes(p.startLie, p.startDist, p.baseline);
    if (eStart == null) return null;
    const eEnd = p.holed ? 0 : expectedStrokes(p.endLie, p.endDist, p.baseline);
    if (eEnd == null) return null;
    const pen = p.penalty || 0;
    return { sg: eStart - eEnd - 1 - pen,
             category: category(p.startLie, p.startDist),
             expectedStart: eStart, expectedEnd: eEnd };
  }

  /* ---------- puttning: den SG-siffra som INTE kräver lie-klassning ----------
     SG_putt = E(green, d0) − antal puttar, där d0 är avståndet från bollens
     läge på green till pinnen.

     Detta är den enda SG-delen som går att räkna helt säkert i klienten i dag:
     läget är `green` per definition (spelaren markerade bollen PÅ green), så
     ingen ytklassning behövs och §9.5:s paritetsgap rör den inte. Samma
     dekomposition som [[PUTTING_PLAN]] bygger sömmen på
     (SG_t2g + SG_putt = E(tee, d0) − antal slag).

     Returnerar null när underlaget saknas — aldrig 0, som hade sett ut som
     "puttade exakt förväntat". */
  function puttingGained(distToPinM, putts, baselineName) {
    if (distToPinM == null || !(putts > 0)) return null;
    const e = expectedStrokes("green", distToPinM, baselineName);
    if (e == null) return null;
    return e - putts;
  }

  /* ---------- lie-paritet mot PC:n (APPSTORE_PLAN §9.5) ----------
     Bandatans ytnamn är INTE samma som baslinjens lie-namn. Översättningen bor
     här, på ett ställe, i stället för i varje anropare.

     `water` → `water_hazard` är den viktiga: mobilbunten döper om hindret i
     exporten (`HAZARD_TYPE` i export_rangefinder.py), och utan denna rad hade
     `water` fallit på fallback-lie av en SLUMP — samma svar som PC:n får via
     sitt alias, men av fel skäl. En dag när aliaset ändras skiljer de sig. */
  const SURFACE_TO_LIE = { green: "green", bunker: "bunker", water: "water_hazard",
                           fairway: "fairway", rough: "rough", tee: "tee",
                           // Bunt v3 bär dem (SPELPLAN_PLAN §SP0, 2026-08-03).
                           // `Strategi.klassa()` returnerar redan baslinjens
                           // namn, så de här två är identiteter — de finns för
                           // att en anropare inte ska behöva veta vilken väg
                           // ytan kom.
                           heavy_rough: "heavy_rough", ob: "ob",
                           water_hazard: "water_hazard" };
  const lieFromSurface = surface => SURFACE_TO_LIE[surface] || null;

  /* ---------- vad som fortfarande INTE går att lita på ----------
     Listan var hårdkodad till ["heavy_rough", "ob", "recovery"]. Två av dem är
     inte längre sanna: banbunten bär `heavy_rough`, `ob` och `tee` sedan
     version 3, och `Strategi.klassa()` är PC:ns tvåpassade klassificerare i JS
     (99,48 % överensstämmelse på 10 800 punkter, tests/test_export_lie_lager.py).

     Men de är bara sanna för en bunt som FAKTISKT är v3. En telefon kan ha en
     äldre bunt liggande i offline-cachen, och då är ytorna osynliga igen utan
     att något går sönder — SG-siffran blir bara tyst fel. Varningarna räknas
     därför ur bunten när den skickas in, i stället för att stå i en lista här.

     `recovery` varnar vi alltid för: den finns i baslinjetabellen men klassas
     inte av någondera sidan. */
  const KLASSADE_YTOR = ["heavy_rough", "ob", "tee"];
  const ALLTID_OSYNLIGA = ["recovery"];

  /* `bandataHal` = ett hål ur banbunten (samma objekt `Strategi.ytorFor()` tar).
     Utelämnas den kan vi inte veta vad bunten bär — då varnas för allt, för
     tystnad ska aldrig vara defaultsvaret på en fråga vi inte ställt. */
  function lieParityWarnings(bandataHal) {
    const saknade = bandataHal === undefined
      ? KLASSADE_YTOR.slice()
      : KLASSADE_YTOR.filter(y => !ytaFinns(bandataHal, y));
    return saknade.concat(ALLTID_OSYNLIGA).map(y =>
      `${y}: PC-sidan klassar denna yta men bandatan i mobilen bär den inte` +
      (y === "heavy_rough" ? ` (${D ? D.heavyRoughCost : 0.55} slag skiljer)` : ""));
  }

  /* Bunt v3 lägger ytorna under `lies`; hazards låg där redan i v2. */
  function ytaFinns(hal, typ) {
    const h = hal || {};
    return (h.lies || []).concat(h.hazards || [])
      .some(p => p && p.type === typ && p.poly && p.poly.length >= 3);
  }

  return { load, loaded, names, labels, defaultName,
           expectedStrokes, category, strokesGained, puttingGained,
           lieFromSurface, lieParityWarnings, ytaFinns,
           AROUND_GREEN_M, SURFACE_TO_LIE, KLASSADE_YTOR, ALLTID_OSYNLIGA };
})();

/* node-testbarhet: exportera även som CommonJS när modulen läses i node. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.SG;
