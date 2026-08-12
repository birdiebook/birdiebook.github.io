"use strict";
/* Trend över rundhistoriken (ANALYS_MOBIL_V1_BRIEF.md §10, A5).
 *
 * RENA funktioner, ingen DOM och ingen Store/fetch — så node-testerna
 * (tests/js/test_trend.mjs) kan köra exakt denna kod. Samma uppdelning som
 * analys-core.js/analys-lista.js: den här modulen vet vad en trend ÄR, analys.html
 * gör DOM:en och står för cachningen mot Store (mobile/store.js §A5).
 *
 * Datavägen (bindande, se briefen): rundlistan läser bara indexrader (§9.1.5),
 * men trenden behöver mer (GIR, fairway, puttar, SG putt) — mått som kräver att
 * hela runddokumentet öppnas och räknas om. Lösningen är EN härledd rundsam-
 * manfattning per runda, cachad i Store (mobile/store.js, lagret `trendSummaries`,
 * skrivet/läst via Store.trendSummary()/Store.setTrendSummary()). summaryFromAggregate()
 * här är den RENA delen av den cachningen: given en redan beräknad
 * AnalysCore.aggregate()-summa (+ SG-puttresultatet), vilken rad ska skrivas.
 * Själva öppnandet av dokumentet och Store-anropen sker i analys.html — de är
 * inte rena (async, IndexedDB) och hör därför inte hemma här.
 */
globalThis.AnalysTrend = (() => {
  // Ändras fälten i en cachad rad måste CACHE_VERSION bumpas — annars lever en
  // gammal siffra vidare osynligt (briefens uttryckliga krav). En rad vars `v`
  // inte matchar ignoreras av anroparen (analys.html) och räknas om.
  const CACHE_VERSION = 1;
  // "Under tre rundor med data finns ingen trend" — en linje mellan två punkter
  // är alltid rak och ser ut som ett besked (briefen, §10).
  const MIN_ROUNDS = 3;
  // "Rullande 5-rundorssnitt" — samma fönster för alla fem serierna.
  const ROLLING_WINDOW = 5;

  /* En cache-rad ur en redan beräknad rundas aggregat. Ren transform:
     A         = AnalysCore.aggregate(...) för rundan
     meta      = { id, startedAt, courseName, roundSeq }  (ur runddokumentet/indexraden)
     sgPutt    = { total, n } | null                       (puttSGForRound(), analys.html)

     `nHal` = A.nPlayed, buret genom raden så trendens seriebyggare kan avgöra
     vilka rundor som är LÄNGDMÄSSIGT jämförbara (§10: 9- mot 18-hålsrundor ska
     inte ligga i samma score-serie). En runda utan känt par (banans data saknas
     offline) ger toPar=null — den bidrar då till serierna som TÅL det (GIR,
     fairway, puttar, SG putt) men inte till score-mot-par. */
  function summaryFromAggregate(meta, A, sgPutt) {
    const m = meta || {};
    const nHal = A && A.nPlayed ? A.nPlayed : 0;
    const toPar = A && A.nPlayed && A.totPar ? A.totScore - A.totPar : null;
    return {
      id: m.id,
      v: CACHE_VERSION,
      startedAt: m.startedAt || null,
      courseName: m.courseName || "",
      roundSeq: m.roundSeq || "",
      nHal,
      score: A && A.nPlayed ? A.totScore : null,
      toPar,
      gir: A && A.gir && A.gir.known ? A.gir.pct : null,
      fir: A && A.tee && A.tee.known ? A.tee.hitPct : null,
      putts: A && A.nPlayed && A.putts ? A.putts.total / A.nPlayed : null,
      sgPutt: sgPutt && sgPutt.n ? sgPutt.total : null,
    };
  }

  // Rullande snitt (trailing), fönster ROLLING_WINDOW — men aldrig fler
  // punkter än vad som finns hittills (ingen "titta framåt i tiden").
  function withRollingAverage(points, window) {
    const w = window || ROLLING_WINDOW;
    return points.map((p, i) => {
      const from = Math.max(0, i - w + 1);
      const slice = points.slice(from, i + 1);
      const avg = slice.reduce((s, q) => s + q.value, 0) / slice.length;
      return Object.assign({}, p, { rollingAvg: avg });
    });
  }

  // En serie ur `rows` (redan sorterade kronologiskt): plocka de rundor där
  // `pick(row)` inte är null, filtrera ev. på `groupFilter` (score-serien),
  // och bifoga det rullande snittet. `enough` styr om vyn ritar en linje
  // (§10: en linje mellan under tre punkter är ett falskt besked).
  function seriesFrom(rowsSorted, pick, groupFilter) {
    const pts = rowsSorted
      .filter(r => pick(r) != null && (groupFilter == null || r.nHal === groupFilter))
      .map(r => ({ id: r.id, startedAt: r.startedAt, courseName: r.courseName,
                   roundSeq: r.roundSeq, value: pick(r) }));
    return { points: withRollingAverage(pts), n: pts.length, enough: pts.length >= MIN_ROUNDS };
  }

  /* Den vanligaste rundlängden bland raderna som HAR en känd längd — score-
     serien jämför bara rundor inom den gruppen (§10 "bara jämförbart jämförs").
     Lika antal → den grupp som senast spelades vinner (mest relevant just nu). */
  function dominantHoleGroup(rowsSorted) {
    const counts = {};
    for (const r of rowsSorted) if (r.nHal) counts[r.nHal] = (counts[r.nHal] || 0) + 1;
    const keys = Object.keys(counts);
    if (!keys.length) return null;
    let best = null, bestCount = -1;
    for (let i = rowsSorted.length - 1; i >= 0; i--) {
      const g = rowsSorted[i].nHal;
      if (!g) continue;
      const c = counts[g];
      if (c > bestCount) { bestCount = c; best = g; }
    }
    return best;
  }

  /* Bygg alla fem serierna ur en lista med cachade rundsammanfattningar (valfri
     ordning — sorteras här). Detta är serie-byggaren som Klart-när-kravet pekar
     på: rena rundor in, serier ut, inget DOM/nätverk.

     Returnerar { ready:false, total, minRequired } under MIN_ROUNDS (§10 —
     vyn visar då "Trend visas när tre rundor är loggade — du har N" i stället
     för serierna), annars { ready:true, total, minRequired, group, series }. */
  function buildSeries(rows) {
    const sorted = (rows || []).filter(r => r && r.id && r.startedAt)
      .slice().sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const total = sorted.length;
    if (total < MIN_ROUNDS) return { ready: false, total, minRequired: MIN_ROUNDS };

    const group = dominantHoleGroup(sorted);
    return {
      ready: true, total, minRequired: MIN_ROUNDS, group,
      series: {
        // Score mot par — bara den dominanta rundlängden (9 mot 18 hål blandas inte).
        scoreToPar: seriesFrom(sorted, r => r.toPar, group),
        // Per-hål-mått tål blandade rundlängder — de är redan normaliserade.
        gir: seriesFrom(sorted, r => r.gir, null),
        fairway: seriesFrom(sorted, r => r.fir, null),
        puttsPerHole: seriesFrom(sorted, r => r.putts, null),
        sgPutt: seriesFrom(sorted, r => r.sgPutt, null),
      },
    };
  }

  return { CACHE_VERSION, MIN_ROUNDS, ROLLING_WINDOW,
           summaryFromAggregate, withRollingAverage, buildSeries };
})();

/* node-testbarhet: exportera även som CommonJS när modulen läses i node. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.AnalysTrend;
