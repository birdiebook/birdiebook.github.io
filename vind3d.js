/* Vindens FORM på bollbanan i 3D — apex, sidled-drift och byellips.
 *
 * URSPRUNG: PC-vyn (`src/api/static/rundor3d.js`, W1–W3 i VIND_3D_PLAN).
 * Speglad hit av samma skäl som `bollbana.js`: samma slag i samma vind ska se
 * likadant ut i telefonen som på skärmen. `tests/js/test_vind3d.mjs` kör båda
 * implementationerna över ett svep och kräver identiska tal.
 *
 * EN SAK ÄR MEDVETET INTE SPEGLAD: längdeffekten (`windLenShift`). Den finns
 * redan i mobilen som `PlayAs.windAlongShift` — samma formel, samma konstanter,
 * samma Trackman-kalibrering vid 230 m — och den driver rangefinderns "spelar
 * som". Att kopiera den hit hade gett mobilen TVÅ vindlängdsmodeller, och då
 * kan rangefindern och 3D-vyn säga olika om samma slag. Modulen delegerar
 * därför dit, och paritetstestet bevisar att `PlayAs.windAlongShift` är
 * numeriskt identisk med PC-vyns `windLenShift`.
 *
 * Källan för alla koefficienter är `src/api/planner.py` — det är plannern som
 * äger vindmodellen; JS ritar bara det den redan räknar med.
 */
"use strict";

const Vind3D = (() => {
  // --- W1: along i bågen -----------------------------------------------------
  // Ren faktor på apex ur along-komponenten (+ = medvind), längdskalad som
  // planner-modellen. För LOGGADE slag ändras aldrig längd/nedslag (mätt
  // slutpunkt) — bara bågens FORM.
  const WIND_APEX_REF_M = 230;      // = planner.WIND_REF_M
  const WIND_APEX_PER_MS = 0.03;    // apex-ändring per m/s along vid referensen
  function windApexFactor(alongMs, len) {
    if (alongMs == null || !len) return 1;
    const f = 1 - WIND_APEX_PER_MS * alongMs * (len / WIND_APEX_REF_M);
    return Math.max(0.6, Math.min(1.6, f));   // clamp mot absurda former
  }

  // --- W2: sidled-drift (kärnan) --------------------------------------------
  // Magnituden skalas med HANGTID (∝√apex), inte med längden: det är flygtiden
  // som styr driften, så ett HÖGT KORT slag driver som ett LÅGT LÅNGT.
  // Normaliserad till drive-apex-platån så plannerns koefficient återanvänds.
  const WIND_CROSS_M_PER_MS = 1.6;   // = planner.WIND_CROSS_M_PER_MS
  const WIND_CROSS_APEX_REF_M = 28;  // drive-apex-platån (hangtid-referens)
  function crossDrift(crossMs, apex) {
    if (!crossMs || apex == null || apex <= 0.15) return 0;
    return WIND_CROSS_M_PER_MS * crossMs * Math.sqrt(apex / WIND_CROSS_APEX_REF_M);
  }

  // Historik (kända ändpunkter): bollen siktades uppvinds och drevs till T, så
  // flygvägen ligger UPPvinds om kordan — 0 i ändarna, topp 0,25·Δacross i mitten.
  function crossBowShape(t) { return t - t * t; }

  // --- längdeffekten: DELEGERAD, se filhuvudet ------------------------------
  function windLenShift(alongMs, len) {
    if (alongMs == null || !len) return 0;
    if (typeof PlayAs === "undefined" || !PlayAs.windAlongShift)
      throw new Error("Vind3D kräver playas.js (PlayAs.windAlongShift)");
    return PlayAs.windAlongShift(alongMs, len);
  }

  // --- W3: byigheten gör nedslaget till en fördelning ------------------------
  // GPS_FLOOR = ärlig minsta-osäkerhet: lova aldrig en exakt punkt.
  const GPS_FLOOR_M = 2.5, GUST_SKEW = 0.4;
  function gustEllipse(windMs, gustMs, alongMs, crossMs, apex, len) {
    const gd = (windMs && gustMs) ? Math.max(0, gustMs - windMs) : 0;
    const frac = windMs ? gd / windMs : 0;
    const driftGust = Math.abs(crossDrift(crossMs, apex)) * frac;
    return {
      aAlong: GPS_FLOOR_M + Math.abs(windLenShift((alongMs || 0) * frac, len)),
      aCross: GPS_FLOOR_M + driftGust,
      skew: GUST_SKEW * driftGust,
      gustDelta: gd,
    };
  }

  // --- W4: siktet — inversen av allt ovanför ---------------------------------
  // W1–W3 svarar på "vart tar bollen vägen". Siktet svarar på den fråga
  // spelaren faktiskt står med: vad måste JAG göra för att bollen ska landa
  // där jag vill. Det är samma modell baklänges — driva bollen Δacross
  // nedvinds betyder sikta Δacross UPPvinds, och en medvind som bär Δalong
  // längre betyder spela Δalong kortare.
  //
  // `rel` är slagets relativa vind mot MÅL-riktningen och bär PC-vyns
  // fältnamn (`along_ms`, `cross_ms`, `side`) — inte `PlayAs.relWind`:s
  // (`along`, `cross`, `side`). Skillnaden är avsiktlig: paritetstestet matar
  // BÅDA implementationerna samma objekt, och då måste formen vara PC:ns.
  //
  // Orden är en del av svaret, inte en garnering. "sikta 5 m höger" är vad en
  // spelare kan använda på teen; 5,2 m är vad en modell kan säga.
  function aimAdvice(rel, apex, dist) {
    if (!rel) return null;
    const dAcross = crossDrift(rel.cross_ms, apex);      // så mycket driver vinden
    const dAlong = windLenShift(rel.along_ms, dist);     // + = bollen flyger längre
    return {
      dAcross, dAlong,
      // Sidan är motsatt den vinden trycker mot: trycker den höger (H) siktar man vänster.
      lateralSide: rel.side === 'H' ? 'vänster' : rel.side === 'V' ? 'höger' : null,
      distWord: dAlong < 0 ? 'längre' : dAlong > 0 ? 'kortare' : null,
    };
  }

  return { windApexFactor, crossDrift, crossBowShape, windLenShift, gustEllipse,
           aimAdvice,
           WIND_APEX_REF_M, WIND_APEX_PER_MS, WIND_CROSS_M_PER_MS,
           WIND_CROSS_APEX_REF_M, GPS_FLOOR_M, GUST_SKEW };
})();

if (typeof globalThis !== "undefined") globalThis.Vind3D = Vind3D;
if (typeof module !== "undefined" && module.exports) module.exports = Vind3D;
