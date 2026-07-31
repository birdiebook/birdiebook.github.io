"use strict";
/* Regelkärnan för spelformer (APPSTORE_PLAN.md §6, etapp AS4).
 *
 * RENA funktioner, ingen DOM, ingen lagring, ingen tid — så node-testerna
 * (tests/js/test_spelformer.mjs) kör exakt denna kod. Samma uppdelning som
 * analys-core.js/analys-lista.js.
 *
 * METODEN (§6): bygg SEX AXLAR, inte 30 specialfall. Ett format är en
 * KONFIGURATION av axlarna, och konfigurationerna ligger i FORMAT nedan som
 * data. Wolf blir då ett lagvalssteg plus en konfiguration, inte 400 rader.
 *
 *   1. Enhet                  hål · 9 · 18 · säsong
 *   2. Score-transform        brutto → netto (allowance) → poäng (tabell)
 *   3. Rangfördelning per hål poängpott efter inbördes rang (Köpenhamnare 6p)
 *   4. Lagaggregering         bästa · n:te bästa · summa · alternerande
 *   5. Jämförelse             mot par · mot motståndare per hål · mot fältet
 *   6. Pott & lika            carryover · halvering · countback
 *
 * TVÅ REGLER SOM HÅLLER KÄRNAN ÄRLIG
 *
 *  A. Saknas slagindex på banan går NETTO inte att räkna. Då returneras
 *     `strokes: null` och formatet får säga "netto går inte att räkna på den
 *     här banan" — aldrig gissa fram en slagfördelning. (export_rangefinder
 *     skickar med `index: null` just för att mobilen ska kunna säga det.)
 *  B. Poängtabeller och fördelningstabeller är DATA, aldrig kod (§6.3):
 *     lokala varianter förekommer. Varje pott-tabell VALIDERAS mot potten —
 *     en tabell som inte summerar rätt är en tyst pengabugg.
 *
 * PENGAR: kärnan räknar och visar uträkningen. Den hanterar aldrig betalning
 * (§6.4).
 *
 * Beroende: `SGScore` (score.js) — men BARA i adaptern `fromRound()` längst ner.
 * Axlarna och `run()` är helt fristående.
 */
globalThis.Spelformer = (() => {

  /* ================= AXEL 2a: slagfördelning =================
     Det här är stället där de flesta appar fuskar (§6.4).

     Slag fördelas efter hålens SLAGINDEX — men efter deras RANG bland de hål
     som faktiskt spelas, inte efter det råa indexvärdet. Det spelar roll:
     en 9-hålsslinga lagras i BASFORM med den UDDA serien 1, 3, …, 17
     (APPSTORE_PLAN §7.1). Ett spelhandicap på 9 ska ge ett slag på varje hål
     i den slingan; hade vi jämfört `index <= 9` hade bara fem hål fått slag.

     Plus-handicap (negativt spelhandicap) ger slag TILLBAKA, och då från det
     LÄTTASTE hålet och bakåt. */

  // Rang 1..N efter slagindex (lägst index = svårast = rang 1).
  // null om något spelat hål saknar index — se regel A.
  function strokeRanks(holes) {
    const hs = (holes || []).filter(h => h && h.n != null);
    if (!hs.length) return null;
    if (hs.some(h => h.index == null)) return null;
    const order = hs.slice().sort((a, b) =>
      a.index - b.index || a.n - b.n);            // hålnummer bryter lika
    const out = {};
    order.forEach((h, i) => { out[h.n] = i + 1; });
    return out;
  }

  /* Slag på ETT hål givet spelhandicap och hålets rang. */
  function strokesOnRank(php, rank, nHoles) {
    if (!nHoles || !rank) return 0;
    if (!php) return 0;
    if (php > 0) {
      const base = Math.floor(php / nHoles);
      const rest = php - base * nHoles;
      return base + (rank <= rest ? 1 : 0);
    }
    const give = -php;                            // plus-handicap
    const base = Math.floor(give / nHoles);
    const rest = give - base * nHoles;
    return -(base + (rank > nHoles - rest ? 1 : 0));
  }

  /* Hela fördelningen: hålnummer → slag. null när banan saknar slagindex. */
  function allocate(php, holes) {
    const ranks = strokeRanks(holes);
    if (!ranks) return null;
    const n = Object.keys(ranks).length;
    const out = {};
    for (const h of holes) out[h.n] = strokesOnRank(php, ranks[h.n], n);
    return out;
  }

  /* ================= AXEL 2b: handicap =================
     Course Handicap = round(HCP-index × slope/113 + (CR − par)).
     Spelhandicap = round(Course Handicap × allowance).

     CR och slope kommer ur banans ratings-data per KOMBINATION × TEE × KÖN
     (APPSTORE_PLAN §7). Saknas de går netto inte att räkna — regel A. */
  function courseHandicap(o) {
    if (!o || o.hcpIndex == null || o.slope == null) return null;
    const cr = o.cr, par = o.par;
    const raw = o.hcpIndex * (o.slope / 113) +
                (cr != null && par != null ? cr - par : 0);
    return Math.round(raw);
  }
  function playingHandicap(ch, allowance) {
    if (ch == null) return null;
    return Math.round(ch * (allowance == null ? 1 : allowance));
  }

  /* WHS-allowances per format (§6.4). DATA, och medvetet inte inbakad i
     formaten nedan: allowance är en tävlingsinställning.

     OBEKRÄFTAD TABELL — kontrollera mot SGF:s/WHS:s officiella
     allowance-tabell innan den används i en tävling eller där pengar står på
     spel. Värdena här är de vanligt spridda; att de STÅR i en tabell är
     poängen (de går att rätta utan att röra kod), inte att de är verifierade. */
  const ALLOWANCE = {
    slagspel_individuell: 0.95,
    match_singel: 1.00,
    match_fyrboll: 0.90,
    slagspel_fyrboll: 0.85,
    foursome: 0.50,               // av KOMBINERAT handicap
    scramble_4: [0.25, 0.20, 0.15, 0.10],
    _obekraftad: true,
  };

  /* ================= AXEL 2c: score-transform ================= */

  // Poängbogey (Stableford). Standard: netto dubbelbogey el. sämre = 0.
  // Tabellen är data — modifierad Stableford är samma mekanik, annan tabell.
  // Nyckeln är UNDER PAR (par − netto): 1 = birdie, 0 = par, −1 = bogey.
  // Standard-Stableford: par ger 2 poäng, netto dubbelbogey eller sämre ger 0.
  const POANGTABELL = {
    stableford: { 4: 6, 3: 5, 2: 4, 1: 3, 0: 2, "-1": 1, sämre: 0 },
    // Modifierad Stableford (vanlig variant): albatross 8, eagle 5, birdie 2,
    // par 0, bogey −1, dubbel eller sämre −3.
    modifierad: { 3: 8, 2: 5, 1: 2, 0: 0, "-1": -1, sämre: -3 },
  };

  /* poäng ur netto mot par. `tabell` slås upp på (par − netto), dvs. hur många
     under par hålet spelades; allt utanför tabellen faller på `sämre`. */
  function points(net, par, tabell) {
    const T = tabell || POANGTABELL.stableford;
    if (net == null || par == null) return null;
    const under = par - net;
    const key = String(under);
    if (Object.prototype.hasOwnProperty.call(T, key)) return T[key];
    // bättre än tabellens bästa rad → använd bästa raden (aldrig 0)
    const rader = Object.keys(T).filter(k => k !== "sämre").map(Number);
    const bäst = Math.max.apply(null, rader);
    if (under > bäst) return T[String(bäst)];
    return T.sämre;
  }

  /* ================= AXEL 3: rangfördelning per hål =================
     Köpenhamnare är referensimplementationen (§6.3): 3 spelare, 6 poäng per
     hål fördelade efter inbördes hålresultat.

     Fördelningen beskrivs av en TABELL nycklad på lika-mönstret — gruppernas
     storlekar i resultatordning. För tre spelare:
        "1,1,1" alla olika        "2,1" två delar bästa
        "1,2"   två delar andra   "3"   alla lika

     Värdena är belopp PER GRUPP, inte per spelare: `"2,1": [3, 0]` betyder att
     VAR AV de två som delar bästa får 3, och den ensamma sista får 0. Summan
     blir då 2×3 + 1×0 = 6 = potten, vilket validateRangpott kräver. */
  const RANGPOTT = {
    kopenhamnare: { pot: 6, shares: { "1,1,1": [4, 2, 0], "2,1": [3, 0],
                                      "1,2": [4, 1], "3": [2] } },
    nio_poang:    { pot: 9, shares: { "1,1,1": [5, 3, 1], "2,1": [4, 1],
                                      "1,2": [5, 2], "3": [3] } },
  };

  /* Validera en pott-tabell mot potten. En rad som inte summerar till potten
     skapar eller förstör poäng ur tomma luften — det ska aldrig gå att shippa.
     Returnerar [] när allt stämmer, annars felmeddelanden. */
  function validateRangpott(cfg) {
    const fel = [];
    if (!cfg || cfg.pot == null || !cfg.shares) return ["saknar pot/shares"];
    for (const key of Object.keys(cfg.shares)) {
      const grupper = key.split(",").map(Number);
      const andelar = cfg.shares[key];
      if (grupper.length !== andelar.length) {
        fel.push(`${key}: ${grupper.length} grupper men ${andelar.length} andelar`);
        continue;
      }
      const summa = grupper.reduce((s, storlek, i) => s + storlek * andelar[i], 0);
      if (summa !== cfg.pot)
        fel.push(`${key}: summerar till ${summa}, potten är ${cfg.pot}`);
    }
    return fel;
  }

  /* Fördela potten på ett hål. `entries` = [{id, score}] där LÄGRE score är
     bättre (netto eller brutto — kallaren avgör). null-score = spelade inte
     hålet och får ingenting. */
  function distributeByRank(entries, cfg) {
    const spelade = (entries || []).filter(e => e && e.score != null);
    const out = {};
    for (const e of entries || []) out[e.id] = 0;
    if (!spelade.length || !cfg) return out;

    // gruppera på score, bäst först
    const sorted = spelade.slice().sort((a, b) => a.score - b.score);
    const grupper = [];
    for (const e of sorted) {
      const sista = grupper[grupper.length - 1];
      if (sista && sista[0].score === e.score) sista.push(e);
      else grupper.push([e]);
    }
    const key = grupper.map(g => g.length).join(",");
    const andelar = cfg.shares[key];
    if (!andelar) return out;              // mönstret finns inte i tabellen
    grupper.forEach((g, i) => { for (const e of g) out[e.id] = andelar[i]; });
    return out;
  }

  /* ================= AXEL 4: lagaggregering ================= */
  const AGG = {
    // bästa bollen
    basta: xs => (xs.length ? Math.min.apply(null, xs) : null),
    // n:te bästa (n = 2 → näst bästa); kräver att så många spelat
    nte: (xs, n) => {
      const s = xs.slice().sort((a, b) => a - b);
      return s.length >= n ? s[n - 1] : null;
    },
    // summa (t.ex. "total score of two")
    summa: xs => (xs.length ? xs.reduce((a, b) => a + b, 0) : null),
    // bästa TVÅ summerade
    basta2: xs => {
      const s = xs.slice().sort((a, b) => a - b);
      return s.length >= 2 ? s[0] + s[1] : null;
    },
  };
  function aggregateTeam(scores, how, n) {
    const xs = (scores || []).filter(v => v != null);
    if (!xs.length) return null;
    if (how === "nte") return AGG.nte(xs, n || 2);
    const fn = AGG[how || "basta"];
    return fn ? fn(xs) : null;
  }

  /* ================= AXEL 6: pott & lika ================= */

  /* Skins: en pott per hål, lägst score vinner. Lika → carryover (potten
     följer med till nästa hål) eller halvering (delas). `validering` = en skin
     måste vinnas rakt, annars rullar den vidare även vid delad seger. */
  function skins(holes, scoresByPlayer, opts) {
    const o = opts || {};
    const carry = o.carryover !== false;
    const perHole = o.perHole == null ? 1 : o.perHole;
    const ids = Object.keys(scoresByPlayer || {});
    const total = {}; ids.forEach(id => { total[id] = 0; });
    const rader = [];
    let pott = 0;
    for (const h of holes || []) {
      pott += perHole;
      const entries = ids.map(id => ({ id, score: (scoresByPlayer[id] || {})[h.n] }))
        .filter(e => e.score != null);
      if (!entries.length) { rader.push({ hole: h.n, vinnare: [], pott, utfall: "inget spelat" }); continue; }
      const bäst = Math.min.apply(null, entries.map(e => e.score));
      const vinnare = entries.filter(e => e.score === bäst).map(e => e.id);
      if (vinnare.length === 1) {
        total[vinnare[0]] += pott;
        rader.push({ hole: h.n, vinnare, pott, utfall: "vunnen" });
        pott = 0;
      } else if (!carry) {
        const del = pott / vinnare.length;
        vinnare.forEach(id => { total[id] += del; });
        rader.push({ hole: h.n, vinnare, pott, utfall: "delad" });
        pott = 0;
      } else {
        rader.push({ hole: h.n, vinnare, pott, utfall: "carryover" });
      }
    }
    return { total, rader, kvarIPott: pott };
  }

  /* Countback (SGF/WHS-praxis): jämför sista 9, sista 6, sista 3, sista hålet.
     Används för att skilja lika totaler. Returnerar <0 om a är bättre. */
  function countback(aScores, bScores, holes) {
    const svansar = [9, 6, 3, 1];
    const hs = (holes || []).slice().sort((x, y) => x.n - y.n);
    for (const k of svansar) {
      const del = hs.slice(Math.max(0, hs.length - k));
      const sum = S => del.reduce((acc, h) => acc + (S[h.n] == null ? 0 : S[h.n]), 0);
      const d = sum(aScores) - sum(bScores);
      if (d !== 0) return d;
    }
    return 0;
  }

  /* ================= AXEL 5: jämförelse =================
     Matchspel hål för hål: +1 vunnet, 0 delat, −1 förlorat, ur A:s synvinkel.
     Avgjord när ledningen är större än antalet återstående hål. */
  function matchPlay(holes, aScores, bScores) {
    const hs = (holes || []).slice().sort((x, y) => x.n - y.n);
    let ställning = 0, spelade = 0, avgjord = null;
    const rader = [];
    hs.forEach((h, i) => {
      const a = aScores[h.n], b = bScores[h.n];
      if (a == null || b == null) { rader.push({ hole: h.n, utfall: null, ställning }); return; }
      spelade++;
      const d = a < b ? 1 : a > b ? -1 : 0;
      ställning += d;
      rader.push({ hole: h.n, utfall: d, ställning });
      const kvar = hs.length - i - 1;
      if (avgjord == null && Math.abs(ställning) > kvar) {
        // Standardnotation: "3&2" = tre upp med två hål kvar. Avgörs matchen
        // först på sista hålet finns inget "&0" — då heter det bara "1 upp".
        avgjord = { hole: h.n, ställning, kvar,
                    text: kvar > 0 ? `${Math.abs(ställning)}&${kvar}`
                                   : `${Math.abs(ställning)} upp` };
      }
    });
    return { ställning, spelade, avgjord, rader };
  }

  /* ================= Wolf =================
     "Wolf blir en konfiguration plus ett lagvalssteg" (§6.1).

     Per hål utses en varg (rotation), som efter utslagen väljer partner eller
     spelar ensam ("lone wolf"). Vargsidans bästa boll möts mot de övrigas
     bästa boll. Poängen är DATA — varianterna är många.

     `val[holeN] = {partner: <id>|null, lone: true|false}`. Saknas valet
     hoppas hålet över: att gissa att vargen spelade ensam vore att hitta på
     ett spelbeslut som ingen tog. */
  const WOLF = { vinst: 1, loneVinst: 3, lonePerMotstandare: true, forlust: 1, lika: 0 };

  function wolfOrder(players, holeN) {
    const n = (players || []).length;
    if (!n) return null;
    return players[(holeN - 1) % n].id;
  }

  function wolf(holes, players, scoresByPlayer, val, cfg) {
    const C = Object.assign({}, WOLF, cfg || {});
    const ids = players.map(p => p.id);
    const total = {}; ids.forEach(id => { total[id] = 0; });
    const rader = [];
    for (const h of holes || []) {
      const wolfId = wolfOrder(players, h.n);
      const v = (val || {})[h.n];
      if (!v) { rader.push({ hole: h.n, wolfId, utfall: "inget val" }); continue; }
      const lag = v.lone || !v.partner ? [wolfId] : [wolfId, v.partner];
      const mot = ids.filter(id => lag.indexOf(id) < 0);
      const sc = id => (scoresByPlayer[id] || {})[h.n];
      const lagB = aggregateTeam(lag.map(sc), "basta");
      const motB = aggregateTeam(mot.map(sc), "basta");
      if (lagB == null || motB == null) { rader.push({ hole: h.n, wolfId, utfall: "ofullständigt" }); continue; }

      let utfall;
      if (lagB < motB) {
        utfall = "vargsidan vann";
        if (v.lone) {
          // Ensam varg som vinner: loneVinst PER motståndare i den vanligaste
          // varianten (3 motståndare × 3 = 9). Sätt lonePerMotstandare: false
          // för varianten där det är en fast klumpsumma.
          total[wolfId] += C.lonePerMotstandare ? C.loneVinst * mot.length : C.loneVinst;
        } else {
          lag.forEach(id => { total[id] += C.vinst; });
        }
      } else if (lagB > motB) {
        utfall = "motståndarna vann";
        mot.forEach(id => { total[id] += C.forlust; });
      } else {
        utfall = "delat";
        ids.forEach(id => { total[id] += C.lika; });
      }
      rader.push({ hole: h.n, wolfId, lag, mot, lagB, motB, lone: !!v.lone, utfall });
    }
    return { total, rader };
  }

  /* ================= FORMATKATALOG =================
     Ett format är en konfiguration av axlarna. `scoring` säger hur ett hål
     värderas, `resultat` hur hålen summeras. Katalogen är data — nya format
     läggs till här, inte som ny kod. */
  const FORMAT = {
    slagspel_brutto: { namn: "Slagspel brutto", netto: false, enhet: 18,
                       scoring: "brutto", resultat: "summa", lagre_bast: true },
    slagspel_netto:  { namn: "Slagspel netto", netto: true, enhet: 18,
                       allowance: "slagspel_individuell",
                       scoring: "netto", resultat: "summa", lagre_bast: true },
    poangbogey:      { namn: "Poängbogey", netto: true, enhet: 18,
                       allowance: "slagspel_individuell",
                       scoring: "poang", tabell: "stableford",
                       resultat: "summa", lagre_bast: false },
    kopenhamnare:    { namn: "Köpenhamnare", netto: true, enhet: "hal", spelare: 3,
                       allowance: "match_singel",
                       scoring: "netto", resultat: "rangpott", pott: "kopenhamnare",
                       lagre_bast: false },
    nio_poang:       { namn: "Nio poäng", netto: true, enhet: "hal", spelare: 3,
                       allowance: "match_singel",
                       scoring: "netto", resultat: "rangpott", pott: "nio_poang",
                       lagre_bast: false },
    skins:           { namn: "Skins", netto: true, enhet: "hal",
                       allowance: "match_singel",
                       scoring: "netto", resultat: "skins", lagre_bast: false },
    match_singel:    { namn: "Singelmatch", netto: true, enhet: 18, spelare: 2,
                       allowance: "match_singel",
                       scoring: "netto", resultat: "match", lagre_bast: false },
    wolf:            { namn: "Wolf", netto: true, enhet: "hal", spelare: 4,
                       allowance: "match_fyrboll",
                       scoring: "netto", resultat: "wolf", lagre_bast: false },
  };

  /* ---------- körning ----------
     Räknar ut ett format för en runda.

     ctx = { holes:   [{n, par, index}],           // spelarens hål, med slagindex
             players: [{id, name,
                        playingHandicap?,          // helst detta, färdigräknat
                        courseHandicap?,           // annars detta + allowance
                        hcpIndex?, slope?, cr?}],  // annars räknas ch härifrån
             scores:  {playerId: {holeN: brutto}},
             par?,                                 // banans par för kombinationen
                                                   // (ur registrets ratings), krävs
                                                   // bara när ch räknas ur hcpIndex
             allowance?,                           // override av formatets
             val?,                                 // Wolf: {holeN: {partner|lone}}
             skins?, wolf? }                       // konfiguration per format

     Returnerar alltid `netto: {ok, orsak}` så en vy kan säga RAKT UT varför
     netto inte gick att räkna, i stället för att visa brutto som om det var
     netto (regel A). */
  function run(formatKey, ctx) {
    const F = FORMAT[formatKey];
    if (!F) return { fel: "okänt format: " + formatKey };
    const holes = (ctx.holes || []).slice().sort((a, b) => a.n - b.n);
    const players = ctx.players || [];
    const scores = ctx.scores || {};

    // --- netto: allowance → spelhandicap → slagfördelning ---
    const allowance = ctx.allowance != null ? ctx.allowance
                    : (F.allowance ? ALLOWANCE[F.allowance] : 1);
    const strokes = {};                 // playerId → {holeN: slag} | null
    let nettoOk = F.netto;
    const orsaker = [];                 // ALLA hinder, inte bara det sista

    /* Banans slagindex kontrolleras FÖRE spelarna. Det hindret gäller alla och
       är den mer grundläggande orsaken; en saknad handicap är per spelare.
       Förut skrevs `orsak` om i spelar-loopen, så vilket skäl som råkade
       redovisas berodde på spelarordningen — och en vy som säger "Bo saknar
       handicap" när banan saknar slagindex skickar dig att felsöka fel sak. */
    const banGrind = F.netto && strokeRanks(holes) == null
      ? "banan saknar slagindex — netto går inte att räkna" : null;
    if (!F.netto) orsaker.push("formatet spelas brutto");
    if (banGrind) { nettoOk = false; orsaker.push(banGrind); }

    for (const p of players) {
      if (!F.netto || banGrind) { strokes[p.id] = null; continue; }
      let php = p.playingHandicap;
      if (php == null) {
        const ch = p.courseHandicap != null ? p.courseHandicap
                 : courseHandicap({ hcpIndex: p.hcpIndex, slope: p.slope, cr: p.cr,
                                    par: ctx.par });
        php = playingHandicap(ch, allowance);
      }
      if (php == null) {
        strokes[p.id] = null; nettoOk = false;
        orsaker.push(`${p.name || p.id}: spelhandicap saknas (hcp-index eller course rating/slope)`);
        continue;
      }
      strokes[p.id] = allocate(php, holes);
    }

    // --- per hål: brutto → netto → poäng ---
    const per = {};                     // playerId → {holeN: värde}
    const brutto = {}, netto = {};
    for (const p of players) {
      per[p.id] = {}; brutto[p.id] = {}; netto[p.id] = {};
      for (const h of holes) {
        const g = (scores[p.id] || {})[h.n];
        if (g == null) continue;
        brutto[p.id][h.n] = g;
        const s = strokes[p.id] ? (strokes[p.id][h.n] || 0) : 0;
        const nt = nettoOk ? g - s : null;
        if (nt != null) netto[p.id][h.n] = nt;
        const bas = F.scoring === "brutto" || !nettoOk ? g : nt;
        per[p.id][h.n] = F.scoring === "poang"
          ? points(bas, h.par, POANGTABELL[F.tabell || "stableford"])
          : bas;
      }
    }

    const out = { format: F.namn, formatKey, enhet: F.enhet,
                  netto: { ok: nettoOk, orsak: nettoOk ? null : orsaker[0] || null,
                           orsaker, allowance },
                  spelhandicap: {}, slag: strokes, brutto, nettoPerHal: netto,
                  perHal: per, lagreBast: F.lagre_bast };
    for (const p of players) {
      out.spelhandicap[p.id] = strokes[p.id]
        ? Object.keys(strokes[p.id]).reduce((s, k) => s + strokes[p.id][k], 0) : null;
    }

    // --- resultat ---
    if (F.resultat === "summa") {
      out.total = {}; out.spelade = {};
      for (const p of players) {
        const vs = holes.map(h => per[p.id][h.n]).filter(v => v != null);
        out.total[p.id] = vs.reduce((a, b) => a + b, 0);
        // Per spelare, inte ett tal för hela rundan: i ett sällskap kan en
        // spelare ha hoppat över hål, och en total över olika många hål är
        // inte jämförbar utan att man ser det.
        out.spelade[p.id] = vs.length;
      }
      out.ställning = rankTotals(out.total, F.lagre_bast, per, holes);
    } else if (F.resultat === "rangpott") {
      const cfg = RANGPOTT[F.pott];
      const fel = validateRangpott(cfg);
      if (fel.length) return { fel: "ogiltig pott-tabell: " + fel.join("; ") };
      out.pott = cfg.pot;
      out.total = {}; players.forEach(p => { out.total[p.id] = 0; });
      out.ofullstandiga = 0;
      out.rader = holes.map(h => {
        const entries = players.map(p => ({ id: p.id, score: per[p.id][h.n] }));
        // Ett hål där någon saknar score fördelas INTE. Rangfördelning bygger
        // på allas inbördes resultat; att låta den som inte spelade räknas som
        // sämst vore att hitta på ett resultat. Hålet redovisas i stället som
        // ofullständigt så en vy kan säga det.
        const komplett = entries.every(e => e.score != null);
        const del = {}; players.forEach(p => { del[p.id] = 0; });
        if (komplett) Object.assign(del, distributeByRank(entries, cfg));
        else out.ofullstandiga++;
        for (const id of Object.keys(del)) out.total[id] += del[id];
        return { hole: h.n, del, komplett };
      });
      out.ställning = rankTotals(out.total, false, per, holes);
    } else if (F.resultat === "skins") {
      const s = skins(holes, per, ctx.skins);
      out.total = s.total; out.rader = s.rader; out.kvarIPott = s.kvarIPott;
      out.ställning = rankTotals(out.total, false, per, holes);
    } else if (F.resultat === "match") {
      if (players.length !== 2) return { fel: "singelmatch kräver exakt två spelare" };
      const m = matchPlay(holes, per[players[0].id], per[players[1].id]);
      out.match = m;
      out.ställning = [{ id: players[0].id, värde: m.ställning },
                       { id: players[1].id, värde: -m.ställning }];
    } else if (F.resultat === "wolf") {
      const w = wolf(holes, players, per, ctx.val, ctx.wolf);
      out.total = w.total; out.rader = w.rader;
      out.ställning = rankTotals(out.total, false, per, holes);
    }
    return out;
  }

  /* Ställning ur totaler. `lagreBast` = lägre total är bättre (slagspel).
     Lika skiljs med countback på det som hålen faktiskt gav (§6.1 pott & lika),
     och `delad: true` sätts när countback inte heller skilde dem. */
  function rankTotals(total, lagreBast, per, holes) {
    const ids = Object.keys(total || {});
    const rows = ids.map(id => ({ id, värde: total[id] }));
    rows.sort((a, b) => {
      const d = lagreBast ? a.värde - b.värde : b.värde - a.värde;
      if (d !== 0) return d;
      const cb = countback(per[a.id] || {}, per[b.id] || {}, holes);
      return lagreBast ? cb : -cb;
    });
    let plats = 0, förraVärde = null;
    rows.forEach((r, i) => {
      // Delad plats bara när VARKEN totalen NI countbacken skiljer dem.
      const likaFöregående = i > 0 && r.värde === förraVärde &&
        countback(per[r.id] || {}, per[rows[i - 1].id] || {}, holes) === 0;
      if (!likaFöregående) plats = i + 1;
      r.plats = plats;
      r.delad = likaFöregående;
      if (likaFöregående) rows[i - 1].delad = true;
      förraVärde = r.värde;
    });
    return rows;
  }

  /* ================= ADAPTER: runda + match → körbar kontext =================
     Kärnan ovan vet ingenting om lagring. Detta är det ENDA stället som känner
     både runddokumentets form (§9.1.3) och `run()`:s kontrakt, så formen finns
     på ett ställe i stället för i varje vy.

     Beroende: `SGScore.components` för hålscoren. Det är avsiktligt — score.js
     är EN sanning för score-härledning (samma skäl som `store.js` använder den
     i `indexRow`). Att räkna om `shots + adj + putts + pen` här hade skapat en
     andra definition som glider isär vid nästa regeländring.

     o = { doc,           runddokumentet (Store.active() eller Store.get())
           match,         matchobjektet (markörspelare + format + wolf-val)
           seq,           rundans globala hålnummer, i spelordning
           byGlobal,      globalt hålnummer → bandatans hål (par + index)
           ratings,       banregistrets ratings-block för banan (kan saknas)
           me }           { name?, hcpIndex?, kon? } — ditt eget, ur localStorage

     Returnerar { ctx, players, saknar } där `saknar` säger PER SPELARE vad som
     hindrar netto. Vyn kan då skriva "Bo saknar handicap" i stället för att
     tysta falla tillbaka på brutto. */
  function fromRound(o) {
    const doc = (o && o.doc) || null;
    const match = (o && o.match) || null;
    const seq = (o && o.seq) || [];
    const byGlobal = (o && o.byGlobal) || {};
    const me = (o && o.me) || {};
    const ratingsForSeq = ((o && o.ratings) || {})[doc && doc.roundSeq] || null;
    const banPar = ratingsForSeq ? ratingsForSeq.par : null;

    const holes = seq.map((g, i) => {
      const b = byGlobal[g] || null;
      return { n: i + 1, global: g,
               par: b && b.par != null ? b.par : null,
               index: b && b.index != null ? b.index : null };
    });

    const markers = ((match && match.participants) || []).filter(p => p && p.marker);
    const players = [{ id: "me", name: (me.name || (doc && doc.player) || "Du"),
                       hcpIndex: me.hcpIndex != null ? me.hcpIndex : null,
                       tee: (doc && doc.tee) || null, kon: me.kon || null,
                       jag: true }]
      .concat(markers.map(p => ({ id: p.id, name: p.name, hcpIndex: p.hcpIndex,
                                  tee: p.tee, kon: p.kon, jag: false })));

    // Slå upp CR/slope per spelare (kombination × tee × kön) och räkna
    // course handicap. Saknas något lämnas det tomt — regel A tar hand om det.
    const saknar = {};
    for (const p of players) {
      const brist = [];
      if (p.hcpIndex == null) brist.push("handicap");
      if (!p.tee) brist.push("tee");
      if (!p.kon) brist.push("kön");
      let r = null;
      if (ratingsForSeq && p.kon && p.tee)
        r = (ratingsForSeq[p.kon] || {})[p.tee] || null;
      if (!r && !brist.length) brist.push("course rating för " + p.tee);
      if (r) { p.slope = r.slope; p.cr = r.cr; }
      if (brist.length) saknar[p.id] = brist;
    }

    // Scores: dina ur runddokumentet, markörernas ur matchen.
    const scores = {};
    scores.me = {};
    for (const h of (doc && doc.holes) || []) {
      const c = SGScore.components(h);
      if (c.played) scores.me[h.n] = c.total;
    }
    for (const p of markers) {
      const s = {};
      for (const k of Object.keys(p.scores || {})) {
        const v = p.scores[k];
        if (v != null && v > 0) s[Number(k)] = v;
      }
      scores[p.id] = s;
    }

    return {
      players, saknar,
      ctx: { holes, players, scores, par: banPar,
             val: (match && match.wolf) || {} },
    };
  }

  /* Vilka format som går att spela med så här många spelare. `FORMAT[x].spelare`
     är ett KRAV på antal, inte en övre gräns — Köpenhamnare ÄR ett trespel. */
  function availableFormats(nPlayers) {
    return Object.keys(FORMAT).filter(k => {
      const krav = FORMAT[k].spelare;
      return krav == null || krav === nPlayers;
    });
  }

  return {
    // adapter + katalogfrågor
    fromRound, availableFormats,
    // axlar
    strokeRanks, strokesOnRank, allocate,
    courseHandicap, playingHandicap, points,
    distributeByRank, validateRangpott, aggregateTeam,
    skins, countback, matchPlay, wolf, wolfOrder, rankTotals,
    // data
    ALLOWANCE, POANGTABELL, RANGPOTT, FORMAT, WOLF,
    // körning
    run,
  };
})();

/* node-testbarhet: exportera även som CommonJS när modulen läses i node. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Spelformer;
