/* Bollbanans form — apex, apex-läge och bågens höjder. RENA funktioner.
 *
 * URSPRUNG: detta är PC-vyns modell (`src/api/static/rundor3d.js`, C2 i
 * SPELVARDE_3D_PLAN). Den byggdes där först, och mobilen ska inte hitta på en
 * andra bollbana — en spelare som ser samma slag i telefonen och på skärmen ska
 * se samma båge. Modellen är alltså SPEGLAD hit, och `tests/js/test_bollbana.mjs`
 * kör BÅDA implementationerna över ett svep av längder och lägen och kräver
 * identiska tal. Glider de isär blir testet rött.
 *
 * (Varför spegel och inte en delad fil: PC-vyn serveras ur `src/api/static/`
 * av API-servern, mobilen ur `mobile/` till Pages. En gemensam fil kräver att
 * servern exponerar mobilmappen — samma mönster finns för `/holes3d` och
 * `/vendor3d`, så det GÅR, men det rör `api/app.py`. Spegel + paritetstest är
 * repots etablerade grepp för just detta, se `sgColor` i static/app.js mot
 * rundor3d.js och `tests/js/test_players_sgcolor.mjs`.)
 *
 * Förankringen (oförändrad från PC-vyn): Trackman "PGA Tour Averages" i meter.
 * apex ~25–29 m är en nästan konstant PLATÅ över alla fulla slag (inte "högre
 * ju längre"); apex ligger FÖRBI mitten och landningen är brantare än utgången
 * (backspin). En ritbar båge kan inte samtidigt matcha Trackmans ABSOLUTA
 * utgångsvinkel — den kräver en aerodynamisk lyftmodell. Vi behåller
 * apex-platån + asymmetrin, och vinklarna blir bågens egna.
 */
"use strict";

const D2R = Math.PI / 180;

// m — apex per slaglängd (platån är avsiktlig, se ovan)
const TRAJ_APEX = [[0, 0], [20, 5], [50, 13], [90, 22], [124, 27], [160, 28],
                   [210, 28], [260, 29]];
// ° — asymmetrikällor: Trackmans utgång och landning
const TRAJ_LAUNCH = [[0, 0], [20, 28], [60, 27], [124, 24], [160, 17],
                     [194, 11], [260, 11]];
const TRAJ_DESC = [[0, 0], [20, 50], [50, 54], [124, 52], [167, 50],
                   [194, 46], [260, 38]];

function interpTab(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  const last = tab[tab.length - 1];
  if (x >= last[0]) return last[1];
  let i = 1;
  while (i < tab.length && tab[i][0] < x) i++;
  const [x0, v0] = tab[i - 1], [x1, v1] = tab[i];
  return v0 + (v1 - v0) * (x - x0) / (x1 - x0);
}

/* apex (m) + apex-LÄGE fa∈(0,1). fa väljs så att bågens LANDNINGSvinkel matchar
   Trackman-descent vid baslinjen: fa = 1 − 2·apex/(tanβ·L). Då matchar TVÅ av
   tre Trackman-tal (apex-platån + den branta landningen) och UTGÅNGSvinkeln blir
   bågens härledda (konsistenta) tangent. */
function shotTrajectory(len, startLie) {
  if (startLie === 'green') return { apex: 0.1, fa: 0.5 };   // putt: rullar → platt
  let apex = interpTab(TRAJ_APEX, len);
  const td = Math.tan(interpTab(TRAJ_DESC, len) * D2R);
  let fa = td ? 1 - 2 * apex / (td * len) : 0.6;
  fa = Math.max(0.55, Math.min(0.8, fa));
  if (startLie === 'bunker') { apex *= 1.15; fa = Math.min(fa + 0.03, 0.82); }
  return { apex: Math.max(0.4, apex), fa };
}

/* Bågens FAKTISKA vinklar ur geometrin (parabelhalvornas tangenter) — alltid
   konsistenta med apex; större apex ⇒ större BÅDA vinklar. */
function trajAngles(apex, fa, len) {
  if (apex <= 0.15 || len < 1) return { launch: 0, desc: 0 };   // putt
  return {
    launch: Math.atan(2 * apex / (fa * len)) / D2R,
    desc: Math.atan(2 * apex / ((1 - fa) * len)) / D2R,
  };
}

/* Bågens höjd i SANNA meter över kordan S→T längs t∈[0,1]: parabeltopp = apex
   vid t=fa, noll i ändarna. Höjden skalas ALDRIG med höjdöverdriften — samma
   princip som träden: en boll som gick 27 m upp gick 27 m upp. */
function arcHeights(len, traj, n = 28) {
  const { apex, fa } = traj;
  if (apex <= 0.15 || len < 1) return Array.from({ length: n + 1 }, () => 0);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = t <= fa ? (t - fa) / fa : (t - fa) / (1 - fa);
    out.push(apex * (1 - u * u));
  }
  return out;
}

const Bollbana = { TRAJ_APEX, TRAJ_LAUNCH, TRAJ_DESC, interpTab,
                   shotTrajectory, trajAngles, arcHeights };

if (typeof globalThis !== "undefined") globalThis.Bollbana = Bollbana;
/* node-testbarhet, samma grepp som sg.js */
if (typeof module !== "undefined" && module.exports) module.exports = Bollbana;
