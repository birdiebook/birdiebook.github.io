"use strict";
/* Delad score-härledning — EN sanning för lokalt scorekort och live-leaderboard.
 * Ren funktion, ingen DOM, inget localStorage. (LIVE_SCORING_SPEC.md §6)
 *
 * Hål-objektet är samma som rundloggen/översikten sparar i S.holes[n]:
 *   { shots: [...], putts, pen, adj?, holedOut? }
 * strokes = fulla slag (loggade GPS-slag + manuell rättning), UTAN putt/plikt.
 * total   = strokes + putts + pen.  */
const SGScore = (() => {
  function components(h) {
    if (!h) return { strokes: 0, putts: 0, pen: 0, total: 0, played: false };
    const strokes = (h.shots ? h.shots.length : 0) + (h.adj || 0);
    const putts = h.putts || 0;
    const pen = h.pen || 0;
    const total = strokes + putts + pen;
    return { strokes, putts, pen, total, played: total > 0 };
  }
  return { components };
})();
if (typeof window !== "undefined") window.SGScore = SGScore;
