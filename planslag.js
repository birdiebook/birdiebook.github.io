"use strict";
/* PLANENS SLAG — en beräkning, två vinklar (UPPGRADERING_3D §5 U19).
 *
 * Före den här modulen räknade 2D-listan och 3D-bågen på samma slag var för
 * sig: kartan tog hålets vind ur `PlayAs.playAsRange` och ignorerade både
 * spelarens vindövertäckning och U17:s justering av det enskilda slaget, medan
 * 3D-scenen räknade med båda. Samma ben kunde alltså stå "148 m" i listan och
 * bära en båge byggd för 139 m — två svar på samma fråga, vilket princip 4
 * kallar värre än inget svar.
 *
 * Modulen äger därför HELA kedjan: tee → landningspunkter → green, ett objekt
 * per slag med sträcka, Δh, relativ vind, "spelar som", apex-faktor och
 * spridning. Vyerna ritar; de räknar inte.
 *
 * REN och importfri (som slagjust.js, markhojd.js och vybro.js): allt som rör
 * omvärlden — avstånd, bäring, vindmodell, höjduppslag, spelprofilens
 * spridningstabell — skickas IN. Därför kan `node tests/js/test_planslag.mjs`
 * köra den utan DOM, utan nät och utan Leaflet, och därför kan den inte skriva
 * något: en planeringssiffra ska aldrig kunna hamna i en loggad runda.
 */
const Planslag = (() => {

  /* Vad kedjan består av. Slag 1 slås ALLTID från teen, och sista slaget går
     alltid mot green_center — en plan utan avslut är inte en plan. Mellanliggande
     punkter är spelarens egna landningspunkter (Vylage.legs).

     Returnerar [] när något saknas i stället för att gissa: utan tee eller utan
     green finns ingen kedja att rita, och en påhittad ändpunkt hade sett ut som
     data. */
  function punkter(tee, legs, green) {
    if (!tee) return [];
    const ut = [tee];
    for (const p of (legs || [])) if (p && p.length === 2) ut.push(p);
    if (green && green.length === 2) ut.push(green);
    return ut.length >= 2 ? ut : [];
  }

  /* Höjdskillnaden a→b i meter, eller null när höjddata saknas för hålet.
     `hojd` är injicerad (i appen `PlayAs.elev3dAt` bunden till hålets meta). */
  function deltaH(a, b, hojd) {
    if (typeof hojd !== "function") return null;
    const y1 = hojd(a[0], a[1]), y2 = hojd(b[0], b[1]);
    return (y1 == null || y2 == null || !isFinite(y1) || !isFinite(y2)) ? null : y2 - y1;
  }

  /* "Spelar som" för ETT slag, med SLAGETS effektiva vind (som kan vara
     spelarens övertäckning för just det slaget, U17) och inte hålets.
     Formeln är `PlayAs.playAsRange`:s, medvetet återgiven med samma tecken och
     samma avrundning — men vinden kommer utifrån. Skulle de två någonsin behöva
     ändras är det på ETT ställe: `d.windAlongShift`. */
  function spelarSom(dist, bearing, vind, slope, d) {
    const s = slope || 0;
    if (!vind || !vind.ms) return { mean: Math.round(dist + s), gust: Math.round(dist + s), rel: null };
    const rel = d.relWind(bearing, vind.ms, vind.dir);
    const mean = dist - d.windAlongShift(rel.along, dist) + s;
    const gustAlong = (vind.gust != null && vind.ms > 0) ? rel.along * vind.gust / vind.ms : rel.along;
    const gust = dist - d.windAlongShift(gustAlong, dist) + s;
    return { mean: Math.round(mean), gust: Math.round(gust),
             rel: { ...rel, ms: vind.ms, gust: vind.gust } };
  }

  /* Slagets BANA — apex, vinklar, sidodrift och byellips.
   *
   * Detta räknades förut inne i 3D-ritkoden, och det var precis därför 2D inte
   * kunde visa samma tal: siffrorna fanns bara där bågen ritades. Nu ligger de
   * här, och 3D-scenen ritar dem i stället för att räkna ut dem. Modellerna är
   * oförändrade — `Bollbana` (formen) och `Vind3D` (vindens verkan) skickas in
   * som de är, och deras paritetstester mot PC-vyn gäller därför fortfarande.
   *
   * Ordningen är W1 → U17 → W2 → W3 och den är inte godtycklig: vindens
   * apex-faktor är en del av MODELLENS apex, och spelarens apex-skruv ska
   * verka på modellens svar — inte tvärtom. Drift och byellips läser sedan den
   * färdiga apexen, för det är hangtiden de beror på.
   */
  function bana(dist, rel, eff, d) {
    const B = d.bollbana, V = d.vind3d;
    if (!B || !V || !(dist > 0)) return { traj: null, vinklar: null, drift: 0, gustE: null };
    const traj = B.shotTrajectory(dist);
    if (rel) traj.apex *= V.windApexFactor(rel.along, dist);
    traj.apex = Math.max(0.4, traj.apex * eff.apexFaktor);
    const vinklar = B.trajAngles(traj.apex, traj.fa, dist);
    const drift = rel ? V.crossDrift(rel.cross, traj.apex) : 0;
    let gustE = null;
    if (rel && rel.gust) {
      const e = V.gustEllipse(rel.ms, rel.gust, rel.along, rel.cross, traj.apex, dist);
      // Under de här trösklarna är byellipsen inte information utan GPS-golvet
      // ritat som kunskap — samma villkor som W3 satte när den byggdes.
      if (e.gustDelta > 0.05 && (e.aCross > V.GPS_FLOOR_M + 0.2 ||
                                 e.aAlong > V.GPS_FLOOR_M + 0.2)) gustE = e;
    }
    return { traj, vinklar, drift, gustE };
  }

  /* Hela kedjan.
   *
   * `in` = { tee, legs, green, vind, just, slagval }
   *   vind    : hålets vind {ms, dir, gust} eller null (offline — princip 3)
   *   just    : SlagJust-tillståndet för hålet ({} = orörd plan)
   *   slagval : GP2:s klubbval per slag ur Vylage ({} = profilens default)
   *
   * `deps` = { hav, bearing, relWind, windAlongShift, slopeEffect, hojd,
   *            spridning, effektiv }
   *   hojd(lat, lon) -> meter | null
   *   spridning(dist) -> {cross, along, alongBias, miss} | null (GP1, spelprofilens tabell)
   *   effektiv(bas, ov) -> SlagJust.effektiv        (injiceras så modulen
   *                                                  förblir fri från beroenden)
   *   bollbana, vind3d -> modulerna själva          (formen och vindens verkan)
   *
   * Ut: en post per slag, i spelordning. `nr` är slagets nummer i planen
   * (1-baserat, som spelaren räknar), `idx` dess index i justeringstillståndet.
   */
  function kedja(indata, deps) {
    const o = indata || {}, d = deps || {};
    const pts = punkter(o.tee, o.legs, o.green);
    const ut = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dist = d.hav(a, b);
      const bearing = d.bearing(a, b);
      const dh = deltaH(a, b, d.hojd);
      // Nedförsbacke ger inte lika många meter tillbaka som uppförsbacke tar —
      // asymmetrin bor i PlayAs.slopeEffect och ska inte kopieras hit.
      const slope = dh != null ? d.slopeEffect(dh) : 0;
      /* GP2: slagets egna val (klubba/form/ansats/höjd) ersätter profilens
         avståndsbaserade spridning för just det slaget. Valet går IN som en
         färdigräknad rad — modulen slår inte upp någon klubbtrappa själv, av
         samma skäl som den inte känner Store: den ska förbli ren och testbar
         utan DOM och utan nät. `d.klubbslag(dist, val)` är injicerad och svarar
         {cross, along, bias, apex, langd, klubba} eller null. */
      const val = (o.slagval || {})[i] || null;
      // Klubban räknas ALLTID när trappan finns, även utan val — panelen ska
      // kunna säga "7-järn, full: 140 m" innan spelaren rört något (§GP2: ingen
      // svart låda), och rader i 2D-listan ska kunna visa förslaget. Men den
      // STYR bara spridningen när spelaren faktiskt valt: annars hade en tom
      // plan tyst bytt ellips den dagen klubbtrappan byggdes.
      const ks = typeof d.klubbslag === "function" ? d.klubbslag(dist, val) : null;
      // `alongBias` följer med båda vägarna: klubbvalet byter ellipsens BREDD,
      // och skulle det samtidigt tyst nollställa dess centrum vore ett klubbval
      // en osynlig modelländring.
      const bas = (ks && val) ? { cross: ks.cross, along: ks.along,
                                  alongBias: ks.alongBias, miss: ks.miss }
                     : (typeof d.spridning === "function" ? d.spridning(dist) : null);
      /* Höjdvalet är en apex-faktor och inget annat (§GP2). Den läggs som
         BASENS apex, så att U17:s manuella skruv fortfarande vinner: väljer man
         "låg" och sedan drar i apex-reglaget är det manuella svaret det som
         gäller — annars hade ett reglage tyst slutat betyda något. */
      const ov = { ...((o.just || {})[i] || {}) };
      if (val && ks && ks.apex != null && ov.apexFaktor === undefined) ov.apexFaktor = ks.apex;
      const eff = d.effektiv({ vind: o.vind || null, spr: bas },
                             Object.keys(ov).length ? ov : null);
      // Spridningens härkomst är nu tregradig: modellens klubbtrappa väger
      // tyngre än profilens avståndsbucket, och båda väger tyngre än en siffra
      // spelaren dragit fram själv. Panelen får inte påstå lika mycket om dem.
      if (val && ks && eff.sprKalla === "profil") eff.sprKalla = "klubba";
      eff.klubba = ks || null;
      const pa = spelarSom(dist, bearing, eff.vind, slope, d);
      const bn = bana(dist, pa.rel, eff, d);
      // Formen (fade/draw) flyttar MEDELBANAN i sidled — samma storhet som
      // vindens sidodrift, och därför samma fält. Att ge den ett eget fält hade
      // tvingat varje ritkod att komma ihåg att addera två tal, och den som
      // glömde hade ritat en fade som flög rakt.
      if (val && ks && ks.bias) bn.drift += ks.bias;
      ut.push({
        idx: i, nr: i + 1,
        a, b, dist, bearing, dh, slope,
        val, klubba: ks,
        // Sista slaget är inspelet: det är det enda som per definition slutar
        // på green, och vyerna ritar det streckat.
        tillGreen: i === pts.length - 2 && !!(o.green && o.green.length === 2),
        franTee: i === 0,
        vind: pa.rel, spelarSom: pa.mean, spelarSomBy: pa.gust,
        eff, andrad: eff.andrad || !!val,
        ...bn,
      });
    }
    return ut;
  }

  /* Meter kvar till green efter slag `nr` — listans högerkolumn. Geometriskt
     och inte "spelar som": det som är kvar är en sträcka, inte ett slag. */
  function kvarEfter(rad, green, d) {
    return (green && green.length === 2) ? Math.round(d.hav(rad.b, green)) : null;
  }

  return { kedja, punkter, spelarSom, deltaH, kvarEfter };
})();

if (typeof window !== "undefined") window.Planslag = Planslag;
else if (typeof globalThis !== "undefined") globalThis.Planslag = Planslag;
if (typeof module !== "undefined" && module.exports) module.exports = Planslag;
