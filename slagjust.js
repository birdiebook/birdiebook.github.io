/* U17 — slagets justeringar: apex, vind och spridning för ETT valt slag.
 *
 * DEN BÄRANDE REGELN (UPPGRADERING_3D §5 U17): en justering är ett
 * VISNINGSLAGER, aldrig en skrivning. Rundan är loggad data — skruvar spelaren
 * upp apex på sitt utslag ska inte en byte av rundan ändras, annars förfalskas
 * facit och nästa analys räknar på en fantasi.
 *
 * Modulen är därför medvetet BYGGD så att regeln är svår att bryta: den är ren
 * (inga sidoeffekter, ingen Store, ingen localStorage), tillståndet är
 * oföränderligt (varje ändring ger ett NYTT objekt), och den känner inte till
 * ett enda fält ur en runda — bara slagets index i kedjan. Det som inte kan
 * skriva kan inte förfalska.
 *
 * Tillståndet: { [slagIndex]: { apexFaktor?, vind?, sprCross?, sprAlong? } }.
 * En nyckel som saknas betyder "som modellen/den hämtade vinden säger" — det
 * finns ingen kopia av basvärdet i tillståndet, så ett återställt slag kan inte
 * bli något annat än exakt det uppmätta.
 */
"use strict";

const SlagJust = (() => {
  // Klampar mot absurda former. Apex-faktorn är en faktor MOT modellens apex
  // (inklusive vindens W1-faktor), inte ett tal i meter: spelaren skruvar på
  // "högre/lägre än vad modellen tror", inte på en påhittad absolut höjd.
  const APEX_MIN = 0.4, APEX_MAX = 2.0;
  const SPR_MAX_M = 40;

  const klampa = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const tal = v => (typeof v === "number" && isFinite(v) ? v : null);

  function tom() { return {}; }

  /* Slagets egen justering, eller null. */
  function get(state, i) {
    const o = state && state[i];
    return o && Object.keys(o).length ? o : null;
  }

  function andrad(state, i) { return get(state, i) !== null; }

  function antalAndrade(state) {
    return Object.keys(state || {}).filter(i => andrad(state, i)).length;
  }

  /* Ny tillståndsbild med `patch` inlagt på slag `i`. Ett fält satt till null
     (eller undefined) TAS BORT — det är så "tillbaka till modellen" uttrycks
     per fält, och varför ett tomt slag städas bort helt: ett slag utan
     justeringar ska inte kunna se ändrat ut. */
  function satt(state, i, patch) {
    const nu = { ...(state && state[i] ? state[i] : {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined) { delete nu[k]; continue; }
      if (k === "apexFaktor") { const t = tal(v); if (t === null) { delete nu[k]; continue; } nu[k] = klampa(t, APEX_MIN, APEX_MAX); }
      // GP1: 0 är ett VÄRDE ("stäng av ellipsen"), inte ett saknat svar. Före
      // profilen fanns inget att falla tillbaka på och 0 kunde raderas som en
      // tom övertäckning — nu betyder en raderad nyckel "använd profilens tal",
      // och då kunde spelaren inte längre stänga av ellipsen alls: reglagets
      // vänstra ändläge tände profilens ellips igen. Vägen tillbaka till
      // profilen är Återställ, inte 0.
      else if (k === "sprCross" || k === "sprAlong") { const t = tal(v); if (t === null) { delete nu[k]; continue; } nu[k] = klampa(t, 0, SPR_MAX_M); }
      else if (k === "vind") nu[k] = { ms: +v.ms || 0, gust: +v.gust || 0, dir: ((+v.dir || 0) % 360 + 360) % 360 };
      else nu[k] = v;
    }
    const ut = { ...(state || {}) };
    if (Object.keys(nu).length) ut[i] = nu; else delete ut[i];
    return ut;
  }

  function aterstall(state, i) {
    const ut = { ...(state || {}) };
    delete ut[i];
    return ut;
  }

  function aterstallAlla() { return {}; }

  /* Vad slaget FAKTISKT ska ritas med. `bas` bär det uppmätta/hämtade:
       { vind }  — hålets vind (hämtad eller spelarens hål-override), får vara null.
       { spr }   — spelprofilens spridning för avståndet (GP1),
                   {cross, along, alongBias, miss} eller null. Skickas IN i stället för
                   att slås upp här: modulen ska förbli ren, och den ska inte
                   känna till vare sig Store eller spelprofilen.
     Returnerar alltid samma form, så ritkoden aldrig behöver fråga om det finns
     en justering: utan justering är svaret basen. */
  function effektiv(bas, ov) {
    const o = ov || {};
    const spr = (bas && bas.spr) || null;
    // Spelarens egen siffra vinner över profilens — men bara om hen SATT den.
    // `0` är ett svar ("stäng av ellipsen"), inte ett saknat värde, så testet
    // måste vara mot undefined och inte mot falsy.
    const sprCross = o.sprCross !== undefined ? o.sprCross : (spr ? spr.cross : 0);
    const sprAlong = o.sprAlong !== undefined ? o.sprAlong : (spr ? spr.along : 0);
    return {
      vind: o.vind !== undefined ? o.vind : ((bas && bas.vind) || null),
      apexFaktor: o.apexFaktor !== undefined ? o.apexFaktor : 1,
      sprCross, sprAlong,
      // Ellipsens CENTRUM längs slaget (− = kort). Kommer alltid ur basen och
      // aldrig ur `ov`: U17:s reglage är två BREDDER, och de säger ingenting om
      // var fördelningen ligger. Drar spelaren i dem betyder det "så här brett
      // sprider jag", inte "och jag har slutat komma kort" — så modellens
      // centrum står kvar även när källan blivit `egen`.
      sprBiasAlong: (spr && spr.alongBias) || 0,
      // U26: fördelningens FORM (missandel + riktad svans) — precis som
      // biasen kommer den ALLTID ur basen och aldrig ur `ov`. U17:s reglage är
      // två BREDDER; de skalar fördelningen, de byter inte formen (§5 U26).
      // `null` när ingen profil/klubbtrappa svarat — ritkoden faller då
      // tillbaka på en ren normalfördelning (miss.p = 0), samma bild som förut.
      miss: (spr && spr.miss) || null,
      // Varifrån spridningen kommer avgör vad panelen får PÅSTÅ: profilens tal
      // är en modell, spelarens är ett antagande. De får inte se lika säkra ut.
      sprKalla: (o.sprCross !== undefined || o.sprAlong !== undefined) ? "egen"
                : (spr ? "profil" : "ingen"),
      andrad: Object.keys(o).length > 0,
    };
  }

  return { tom, get, andrad, antalAndrade, satt, aterstall, aterstallAlla,
           effektiv, APEX_MIN, APEX_MAX, SPR_MAX_M };
})();

if (typeof globalThis !== "undefined") globalThis.SlagJust = SlagJust;
if (typeof module !== "undefined" && module.exports) module.exports = SlagJust;
