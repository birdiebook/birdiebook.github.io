"use strict";
/* Rundlistan i Analys-fliken (APPSTORE_PLAN.md §2.6, §9.3).
 *
 * RENA funktioner, ingen DOM och ingen fetch — så node-testerna
 * (tests/js/test_rundlista.mjs) kan köra exakt denna kod. analys.html gör DOM:en.
 * Samma uppdelning som analys-core.js/analys.html redan har.
 *
 * Listan läser BARA indexrader (Store.list()), aldrig runddokumenten. Det är ett
 * bindande designval från §9.1.5: vid 100 rundor är skillnaden ~20 KB mot flera
 * MB per listrendering. Allt som visas i en rad måste därför gå att härleda ur
 * indexraden — eller ur banans lilla metadata, som i parToPar() nedan.
 */
globalThis.AnalysLista = (() => {
  /* Loggningsnivåerna (§5). `short` är badgen i listan, `long` den ärliga
     texten som skrivs ut i detaljvyn. */
  const LEVELS = {
    1: { short: "Score", long: "bara score" },
    2: { short: "Statistik", long: "score + statistik" },
    3: { short: "Full", long: "full loggning" },
  };
  const levelInfo = n => LEVELS[n] || { short: String(n || "?"), long: String(n || "okänd") };

  const MONTHS = ["jan", "feb", "mars", "april", "maj", "juni",
                  "juli", "aug", "sep", "okt", "nov", "dec"];

  // "2026-07-30T08:00:00Z" → {y,m,d} i LOKAL tid (rundan spelades lokalt).
  function ymd(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return null;
    return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
  }
  const sameDay = (a, b) => !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;

  /* Datumetikett relativt `now`: "Idag" / "Igår" / "30 juli" / "30 juli 2025".
     `now` skickas in (aldrig läst ur klockan här) så testerna blir determinis-
     tiska — samma mönster som resten av de rena modulerna. */
  function dateLabel(iso, now) {
    const a = ymd(iso);
    if (!a) return "";
    const n = ymd(now);
    if (n) {
      if (sameDay(a, n)) return "Idag";
      const y = new Date(new Date(now).getTime() - 864e5);
      if (sameDay(a, ymd(y.toISOString()))) return "Igår";
    }
    const base = `${a.d} ${MONTHS[a.m]}`;
    return n && a.y === n.y ? base : `${base} ${a.y}`;
  }

  /* Summan av par för en HEL runda-sekvens, ur banans hål-tabell (globalt
     hålnummer → hål). null om något hål saknar par — då visas ingen ±par alls
     i stället för en summa som ser komplett ut men inte är det. */
  function parForSeq(byGlobal, seq) {
    if (!byGlobal || !Array.isArray(seq) || !seq.length) return null;
    let sum = 0;
    for (const g of seq) {
      const h = byGlobal[g];
      if (!h || h.par == null) return null;
      sum += h.par;
    }
    return sum;
  }

  /* Bygg hål-tabellen (globalt hålnummer → hål) ur en banas mobil-json.
     `tables` = SGRound.tablesFor(meta) för SAMMA bana. Hål vars slinga inte
     finns i metan hoppas över — hellre saknad par-summa än ett gissat offset. */
  function byGlobalFrom(courseData, tables) {
    const out = {};
    const base = (tables && tables.GLOBAL_BASE) || {};
    for (const h of (courseData && courseData.holes) || []) {
      const b = base[h.loop];
      if (b == null) continue;
      out[b + h.hole] = h;
    }
    return out;
  }

  /* En listrad ur en indexrad.
     opts: { now, par }  — `par` = par-summan för rundans hela sekvens, eller
     null/undefined om den inte är känd (annan bana, offline, eller ofullständig
     runda). ±par visas BARA när rundan är komplett: `holesPlayed` måste matcha
     sekvensens längd, annars jämför man en halv runda med ett helt par. */
  function rowModel(r, opts) {
    const o = opts || {};
    const lvl = levelInfo(r.loggingLevel);
    const played = r.holesPlayed || 0;
    const seqLen = o.seqLength || 0;
    const complete = !!(seqLen && played === seqLen);
    const par = o.par != null && complete ? o.par : null;
    const toPar = par != null && r.strokes ? r.strokes - par : null;

    // Ärlig täckning (§5 regel 2): säg när färre hål har fullt underlag än
    // spelade. Bara meningsfullt på nivå 3 — nivå 1–2 SKA sakna positioner.
    const lvl3 = r.holesLevel3 || 0;
    const coverage = r.loggingLevel === 3 && played && lvl3 < played
      ? `fullt underlag på ${lvl3} av ${played} hål` : null;

    return {
      id: r.id,
      active: r.status === "active",
      dateLabel: dateLabel(r.startedAt, o.now),
      courseName: r.courseName || "",
      courseSlug: r.courseSlug || "",
      roundSeq: r.roundSeq || "",
      tee: r.tee || "",
      player: r.player || "",
      strokes: r.strokes || 0,
      holesPlayed: played,
      complete,
      toPar,
      level: r.loggingLevel,
      levelShort: lvl.short,
      levelLong: lvl.long,
      coverage,
      // En runda utan ett enda spelat hål är ett tomt utkast — värd att visa
      // (den går att radera) men inte att räkna som runda.
      empty: played === 0,
      moln: molnStatus(r),
    };
  }

  /* Molnstatus per runda (MOLN_PLAN §7).

     §7 avfärdar den kvarvarande risken i molnvägen med orden "en runda kan
     ligga oskickad i telefonen, och det är synligt och ofarligt". Den var inte
     synlig: `Store.list()` har burit fältet sedan V2b, men ingen vy läste det,
     så efter avslutningsskärmen fanns ingen väg tillbaka till svaret "kom den
     fram?". En runda som fastnat såg exakt ut som en som låg tryggt i R2.

     Ersätter `uploaded` (byggd på `sync.uploadedAt` — PC-tunnelns status, död
     sedan 2026-08-06 och aldrig renderad).

     En PÅGÅENDE runda får ingen status: den är inte skickad än, med flit
     (svepet tar bara `finished`), och en "väntar"-stämpel på den man just nu
     spelar hade varit en uppmaning att göra något åt en sak som inte är fel. */
  function molnStatus(r) {
    if (!r || r.status === "active") return null;
    const m = r.moln || null;
    if (m && m.sant)  return { lage: "sakrad", text: "säkrad", nar: m.sant, fel: null };
    // `nekad` sätts bara vid 400/413 (V2b): kroppen duger inte, och att försöka
    // igen är meningslöst. Det är det enda läget som kräver något av användaren.
    if (m && m.nekad) return { lage: "nekad", text: "ej säkrad", nar: null,
                               fel: (m && m.sistFel) || null };
    // Inkluderar rundor som är äldre än molnvägen (`moln` saknas helt) — de är
    // faktiskt oskickade, och svepet tar dem när nätet finns.
    return { lage: "vantar", text: "väntar på nät", nar: null,
             fel: (m && m.sistFel) || null };
  }

  const rowModels = (rows, optsFor) =>
    (rows || []).map(r => rowModel(r, typeof optsFor === "function" ? optsFor(r) : optsFor));

  /* Sortering: nyast först, och en PÅGÅENDE runda alltid överst. Store.list()
     sorterar redan på startedAt, men en pågående runda som startades före en
     avslutad (spelaren glömde avsluta) ska ändå ligga först — den är det man
     faktiskt håller på med. */
  function sortRows(rows) {
    return (rows || []).slice().sort((a, b) => {
      const aa = a.status === "active", ba = b.status === "active";
      if (aa !== ba) return aa ? -1 : 1;
      return String(b.startedAt).localeCompare(String(a.startedAt));
    });
  }

  const fmtToPar = d => (d == null ? null : d === 0 ? "E" : d > 0 ? "+" + d : String(d));

  return { LEVELS, levelInfo, dateLabel, parForSeq, byGlobalFrom,
           rowModel, rowModels, sortRows, fmtToPar, molnStatus };
})();

/* node-testbarhet: exportera även som CommonJS när modulen läses i node. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.AnalysLista;
