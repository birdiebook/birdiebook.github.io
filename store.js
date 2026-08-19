"use strict";
/* store.js — lagringslagret för rundor och matcher (APPSTORE_PLAN.md §9.1).
 *
 * ERSÄTTER localStorage-nycklarna sg-rundlogg-v1 / sg-rundlogg-sist / sg-live-v1.
 * Ingen annan fil får läsa eller skriva dem — allt går genom Store.
 *
 * Laddordning på varje sida:  round.js → score.js → store.js → sidans skript,
 * och sidan startar sin första rendering i Store.ready().then(...).
 *
 * Två egenskaper är hela poängen med modulen:
 *
 *  1. AKTIV RUNDA LÄSES SYNKRONT. Dokumentet hydreras ur IndexedDB en gång vid
 *     boot och lever sedan i minnet, så renderingsvägar kan fortsätta vara
 *     synkrona (Store.active() där det förut stod JSON.parse(localStorage…)).
 *     Skrivningar går async till IndexedDB, coalescerade.
 *  2. INDEXRAD + BLOB. Varje runda lagras som en liten indexrad (listvyer) och
 *     ett fullt dokument (bloben). Samma uppdelning som molnet kräver enligt
 *     APPSTORE_PLAN §4.2 villkor 1, så AS6:s synk blir en kopiering och inte en
 *     transformation.
 *
 * Beroenden: SGRound (hålnumrering) och SGScore (score-härledning). Båda är
 * fristående moduler utan egna beroenden.  */
const Store = (() => {
  // DB_VER 2 (GP1): lagret `profile` tillkom. DB_VER 3 (GP3): `plans`.
  // DB_VER 4 (A5): `trendSummaries` tillkom — cachen trendvyn läser i stället
  // för att öppna varje runddokument.
  // onupgradeneeded skapar bara det som saknas, så en telefon med en äldre
  // databas får de nya lagren utan att rundorna rörs.
  const DB_NAME = "golfsg", DB_VER = 4;
  const ROUNDS = "rounds", DOCS = "roundDocs", MATCHES = "matches";
  const PROFILE = "profile", PLANS = "plans", TREND = "trendSummaries";
  // Profilen är EN post. Id:t är konstant med avsikt: GP1 beslutade att
  // profilen ska sparas som ett enda serialiserbart objekt, så AS6:s
  // enhetssynk blir en kopiering och inte en omskrivning.
  const PROFILE_ID = "me";

  // Gamla nycklar: läses vid migrering, skrivs ALDRIG mer, raderas ALDRIG här.
  const LEGACY_ACTIVE = "sg-rundlogg-v1";
  const LEGACY_LAST = "sg-rundlogg-sist";
  const LEGACY_LIVE = "sg-live-v1";
  const MIGRATED_FLAG = "sg-store-migrated";
  // AS4 la spelarens hcp/kön direkt i localStorage. GP1 äger dem nu; nycklarna
  // läses en gång och lämnas kvar som säkerhetsnät.
  const LEGACY_HCP = "sg_hcp", LEGACY_KON = "sg_kon";
  const PROFILE_MIGRATED = "sg-profil-migrerad";

  const DOC_VERSION = 2;

  /* ---------- små hjälpare ---------- */
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const nowIso = () => new Date().toISOString();
  function uuid() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    // Fallback (äldre iOS): duger som lokalt id, inte kryptografiskt.
    return "r-" + Date.now().toString(36) + "-" +
           Math.random().toString(36).slice(2, 10);
  }
  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- backend ----------
     IndexedDB när den finns, annars minne. Minnesläget är inte bara för
     testerna: nekas IndexedDB (privat läge, hårdare ITP-lägen) ska appen köra
     vidare på samma API i stället för att vitna. Datan är då lika flyktig som
     förut — inte sämre. */
  function memoryBackend() {
    const m = { [ROUNDS]: new Map(), [DOCS]: new Map(), [MATCHES]: new Map(),
                [PROFILE]: new Map(), [PLANS]: new Map(), [TREND]: new Map() };
    return {
      kind: "memory",
      get: (s, k) => Promise.resolve(clone(m[s].get(k)) || null),
      put: (s, v) => { m[s].set(v.id, clone(v)); return Promise.resolve(); },
      del: (s, k) => { m[s].delete(k); return Promise.resolve(); },
      all: s => Promise.resolve(Array.from(m[s].values()).map(clone)),
    };
  }

  function idbBackend(db) {
    const tx = (store, mode, fn) => new Promise((res, rej) => {
      let out;
      const t = db.transaction(store, mode);
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
    });
    return {
      kind: "idb",
      get: (s, k) => tx(s, "readonly", o => o.get(k)).then(v => v || null),
      put: (s, v) => tx(s, "readwrite", o => o.put(clone(v))),
      del: (s, k) => tx(s, "readwrite", o => o.delete(k)),
      all: s => tx(s, "readonly", o => o.getAll()).then(v => v || []),
    };
  }

  function openIdb() {
    return new Promise((res, rej) => {
      if (typeof indexedDB === "undefined" || !indexedDB) return rej(new Error("ingen IndexedDB"));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ROUNDS)) {
          const s = db.createObjectStore(ROUNDS, { keyPath: "id" });
          s.createIndex("startedAt", "startedAt");
          s.createIndex("status", "status");
        }
        if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(MATCHES)) db.createObjectStore(MATCHES, { keyPath: "id" });
        if (!db.objectStoreNames.contains(PROFILE)) db.createObjectStore(PROFILE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(PLANS)) db.createObjectStore(PLANS, { keyPath: "id" });
        // A5: nyckeln är rundans id. `v` i varje rad (inte lagrets version) styr
        // om en rad är giltig — se trendSummary()/setTrendSummary() nedan.
        if (!db.objectStoreNames.contains(TREND)) db.createObjectStore(TREND, { keyPath: "id" });
      };
      req.onsuccess = () => res(idbBackend(req.result));
      req.onerror = () => rej(req.error);
    });
  }

  /* ---------- state ---------- */
  let be = null;          // backend
  let doc = null;         // AKTIVT runddokument (synkront läsbart)
  let match = null;       // aktiv match | null
  let profil = null;      // spelarens profil (synkront läsbar, som doc)
  let readyP = null;
  let dirty = false, flushing = null;

  /* ---------- dokumentmodell ---------- */
  function newDoc(opts) {
    const o = opts || {};
    return {
      id: uuid(),
      v: DOC_VERSION,
      courseSlug: o.courseSlug || SGRound.activeSlug(),
      courseName: o.courseName || SGRound.courseName(),
      roundSeq: o.roundSeq || SGRound.roundName(),
      tee: o.tee != null ? o.tee : (lsGet("sg_tee") || ""),
      player: o.player || "",
      startedAt: o.startedAt || nowIso(),
      endedAt: null,
      status: "active",
      loggingLevel: o.loggingLevel || 3,
      current: 1,
      matchId: null,
      holes: [],
      sync: { uploadedAt: null, serverRoundId: null },
    };
  }

  function newHole(n, level) {
    let g = null;
    try { g = SGRound.relToGlobal(n); } catch (e) {}
    // fir/gir = OBSERVERAD fairway-/greenträff (nivå 2, §9.2.1). null = inte
    // angivet, INTE "miss". På nivå 3 härleds de ur positionerna i stället.
    return { n, global: g || n, level: level || 3, shots: [], green: null,
             pin: null, putts: 0, pen: 0, adj: 0, holedOut: false,
             fir: null, gir: null, events: [] };
  }

  const hasPosition = h => !!(h && h.shots && h.shots.some(s => s && s.lat != null));

  /* Har hålet POSITIONSDATA — det SG faktiskt kräver?
     Skilj detta från `h.level`: ett hål kan bära nivå 3 (rundans deklarerade
     nivå) utan en enda position, nämligen när spelaren bara knappade in scoren
     på just det hålet. Räknas nivån i stället för datan säger täckningen "fullt
     underlag på 18 av 18" när bara 13 hål har det — samma sorts osanning som
     §9.1.13 stängde för TOMMA hål, men för spelade.
     Green-/pinmarkering räknas med: den är positionsdata och bär GIR även utan
     loggade slag. */
  const hasLevel3Data = h => hasPosition(h) || !!(h && (h.green || h.pin));

  /* Invarianter på ETT ställe, körs före varje skrivning:
     - hålen sorterade på spelarens hålnummer
     - fält finns
     - nivån speglar VERKLIGHETEN och kan bara gå uppåt (§9.1 beslut E): ett hål
       med loggad position är nivå 3 oavsett vad rundan deklarerade. */
  function normalize(d) {
    if (!d) return d;
    d.holes = (d.holes || []).filter(Boolean).sort((a, b) => a.n - b.n);
    for (const h of d.holes) {
      h.shots = h.shots || [];
      h.events = h.events || [];
      h.putts = h.putts || 0;
      h.pen = h.pen || 0;
      h.adj = h.adj || 0;
      h.holedOut = !!h.holedOut;
      if (h.fir === undefined) h.fir = null;    // observerad träff (nivå 2)
      if (h.gir === undefined) h.gir = null;
      if (h.global == null) {
        let g = null;
        try { g = SGRound.relToGlobal(h.n); } catch (e) {}
        h.global = g || h.n;
      }
      const lvl = hasPosition(h) ? 3 : (h.level || d.loggingLevel || 3);
      h.level = Math.max(h.level || 0, lvl);
    }
    return d;
  }

  /* Indexraden HÄRLEDS alltid ur dokumentet — skrivs aldrig för hand. En
     avvikelse mellan rad och blob vore en bugg, inte ett tillstånd. */
  function indexRow(d) {
    let strokes = 0, played = 0, sg3 = 0;
    for (const h of d.holes || []) {
      const c = SGScore.components(h);
      strokes += c.total;
      if (c.played) played++;
      // Täckningen räknar SPELADE hål SOM HAR POSITIONSDATA. Två fällor, båda
      // funna i webbläsaren och inte av testerna: ett tomt hål ärver rundans
      // deklarerade nivå, och ett spelat hål som bara fick en inknappad score
      // gör det också. Båda skulle blåsa upp "SG för N av 18 hål".
      if (c.played && hasLevel3Data(h)) sg3++;
    }
    return {
      id: d.id, courseSlug: d.courseSlug, courseName: d.courseName,
      roundSeq: d.roundSeq, tee: d.tee, player: d.player,
      startedAt: d.startedAt, endedAt: d.endedAt, status: d.status,
      loggingLevel: d.loggingLevel, holesPlayed: played, holesLevel3: sg3,
      strokes, matchId: d.matchId || null, sync: d.sync || null,
      moln: d.moln || null,
    };
  }

  /* Dokument → wire-format (`payload` i molnkuvertet, MOLN_PLAN §6 V2).
     FÅR INTE ÄNDRAS. Nyckelordningen är signifikant: JSON.stringify följer
     insättningsordning, och tests/js/test_store.mjs kräver byte-identitet med
     den exportData() som låg i index.html före §9.1. */
  function toWire(d, endedAtFallback) {
    const holes = (d.holes || []).slice().sort((a, b) => a.n - b.n)
      .filter(h => SGScore.components(h).played)
      .map(h => ({
        hole: h.global || h.n,
        shots: h.shots,
        green: h.green,
        pin: h.pin,
        putts: h.putts,
        penalties: h.pen,
        holed_out: h.putts === 0 && h.shots.length > 0,
        score_adjust: h.adj || 0,
      }));
    // Totalpoängen molnindexet (`rounds_index.total_score`, worker.js) läser
    // ur denna payload — summerad HÄR av samma skäl som `indexRow()` ovan
    // (SGScore.components är EN sanning), inte i worker.js som inte har
    // SGScore tillgängligt. Lagd SIST: nyckelordningen ovanför är låst av
    // test_store.mjs byte-identitet, den här raden är ett tillägg, inte en
    // ändring av den.
    const total_score = holes.reduce((sum, h) =>
      sum + h.shots.length + h.score_adjust + h.putts + h.penalties, 0);
    return {
      format: "golf-sg-mobil", version: 1,
      player: (d.player || "").trim(),
      course: (d.courseName || "").trim(),
      // Rundans EGEN sekvens, inte SGRound.roundName(). Före §9.1 lästes den
      // globala inställningen vid exporttillfället — bytte man bana eller runda
      // efter spelet exporterades fel hålnummer.
      round: d.roundSeq,
      tee: d.tee || null,
      started_at: d.startedAt,
      ended_at: d.endedAt || endedAtFallback || nowIso(),
      holes,
      total_score,
    };
  }

  /* Wire → dokument (INVERSEN av `toWire`, MOLN_PLAN.md §6 V4a). Samma form
     som `docFromLegacyWire` nedan bygger ur den gamla `sg-rundlogg-sist`-
     nyckeln — wire-formatet är samma sedan §9.1 — men med `id` GIVET av
     anroparen i stället för ett nytt slumpat id. Wire-kuvertet bär inget eget
     id (bara metadata om spelet); molnets läsväg känner round_id från
     indexraden LÅNGT innan blobben hämtas, och det är DET id:t dokumentet ska
     få — annars vore en hydrerad runda och dess R2-nyckel två olika saker. */
  function docFromWire(id, W) {
    const d = newDoc({
      player: W.player || "", tee: W.tee || "", courseName: W.course || undefined,
      roundSeq: W.round || undefined, startedAt: W.started_at || nowIso(),
      loggingLevel: 3,
    });
    d.id = id;
    d.endedAt = W.ended_at || nowIso();
    d.status = "finished";
    d.holes = (W.holes || []).map((h, i) => {
      let rel = null;
      try { rel = SGRound.globalToRel(h.hole); } catch (e) {}
      const rec = newHole(rel || i + 1, 3);
      rec.global = h.hole;
      rec.shots = h.shots || [];
      rec.green = h.green || null;
      rec.pin = h.pin || null;
      rec.putts = h.putts || 0;
      rec.pen = h.penalties || 0;
      rec.adj = h.score_adjust || 0;
      rec.holedOut = !!h.holed_out;
      rec.level = hasPosition(rec) ? 3 : 2;
      return rec;
    });
    /* Nivån HÄRLEDS ur hålen, sätts inte till 3 på förhand. Wire-formatet bär
       ingen `loggingLevel` (§9.1), och en runda loggad på score-nivå har inga
       positioner — antog vi 3 skulle den hydrerade rundan visa badgen "Full"
       och analysvyerna räkna täckning på ett underlag som inte finns. Det är
       precis den sortens siffra §9.2.3 finns för att förhindra: en runda ska
       säga vad den faktiskt vet. */
    d.loggingLevel = d.holes.length ? Math.max(...d.holes.map(h => h.level || 2)) : 1;
    return normalize(d);
  }

  /* Skriver en hämtad runda från molnet, om den inte redan finns lokalt.
     LOCAL-FIRST (§1): en runda som redan finns skrivs ALDRIG över — den
     lokala versionen är förstahandskällan, molnet är bara kopian. Ändras
     rundan lokalt efter att den hydrerats vinner den lokala ändringen; nästa
     `Moln.skicka` laddar upp den igen med samma round_id (§6 V4a "vad som
     INTE byggs"). Returnerar vad som hände så `Moln.hamta()` kan räkna och
     veta om den ska sätta `moln.sant` på det nyskrivna dokumentet. */
  async function importera(id, wire) {
    if (!id || !wire || typeof wire !== "object" || Array.isArray(wire)) {
      return { skrevs: false, skal: "ogiltig indata" };
    }
    await ready();
    const befintlig = await get(id);
    if (befintlig) return { skrevs: false, skal: "finns redan lokalt", id };
    const d = docFromWire(id, wire);
    await write(d);
    return { skrevs: true, id };
  }

  /* ---------- migrering (en gång, i ready()) ---------- */
  function docFromLegacyActive(S) {
    const d = newDoc({
      player: S.player || "", tee: S.tee != null ? S.tee : "",
      courseName: S.course || undefined, startedAt: S.startedAt || nowIso(),
      loggingLevel: 3,
    });
    d.current = S.current || 1;
    d.endedAt = S.endedAt || null;
    d.status = S.endedAt ? "finished" : "active";
    const src = S.holes || {};
    d.holes = Object.keys(src).map(Number).filter(n => n > 0).sort((a, b) => a - b)
      .map(n => {
        const h = src[String(n)] || {};
        const rec = newHole(n, hasPosition(h) ? 3 : 2);
        rec.shots = h.shots || [];
        rec.green = h.green || null;
        rec.pin = h.pin || null;
        rec.putts = h.putts || 0;
        rec.pen = h.pen || 0;
        rec.adj = h.adj || 0;
        rec.holedOut = !!h.holedOut;
        return rec;
      });
    return normalize(d);
  }

  // sg-rundlogg-sist låg i WIRE-format (array, globala hålnummer) — inte i
  // samma form som den aktiva rundan. Därav en egen väg in.
  function docFromLegacyWire(W) {
    const d = newDoc({
      player: W.player || "", tee: W.tee || "", courseName: W.course || undefined,
      roundSeq: W.round || undefined, startedAt: W.started_at || nowIso(),
      loggingLevel: 3,
    });
    d.endedAt = W.ended_at || nowIso();
    d.status = "finished";
    d.holes = (W.holes || []).map((h, i) => {
      let rel = null;
      try { rel = SGRound.globalToRel(h.hole); } catch (e) {}
      const rec = newHole(rel || i + 1, 3);
      rec.global = h.hole;
      rec.shots = h.shots || [];
      rec.green = h.green || null;
      rec.pin = h.pin || null;
      rec.putts = h.putts || 0;
      rec.pen = h.penalties || 0;
      rec.adj = h.score_adjust || 0;
      rec.holedOut = !!h.holed_out;
      rec.level = hasPosition(rec) ? 3 : 2;
      return rec;
    });
    return normalize(d);
  }

  function matchFromLegacy(L, roundId) {
    return { id: uuid(), gameId: L.gameId, code: L.code || null,
             displayName: L.displayName || "", format: null,
             myRoundId: roundId || null, participants: [],
             createdAt: nowIso(), endedAt: null };
  }

  /* Kör migreringen. Rör ALDRIG de gamla nycklarna — de lämnas som säkerhetsnät
     i minst en release (§9.1.10 punkt 5). */
  async function migrate() {
    if (lsGet(MIGRATED_FLAG)) return;
    let active = null;
    try {
      const raw = lsGet(LEGACY_ACTIVE);
      const S = raw ? JSON.parse(raw) : null;
      if (S && S.holes) { active = docFromLegacyActive(S); await write(active); }
    } catch (e) { console.warn("[Store] migrering av aktiv runda misslyckades", e); }
    try {
      const raw = lsGet(LEGACY_LAST);
      const W = raw ? JSON.parse(raw) : null;
      if (W && W.holes) await write(docFromLegacyWire(W));
    } catch (e) { console.warn("[Store] migrering av föregående runda misslyckades", e); }
    try {
      const raw = lsGet(LEGACY_LIVE);
      const L = raw ? JSON.parse(raw) : null;
      if (L && L.gameId) {
        const m = matchFromLegacy(L, active && active.id);
        await be.put(MATCHES, m);
        if (active) { active.matchId = m.id; await write(active); }
      }
    } catch (e) { console.warn("[Store] migrering av match misslyckades", e); }
    lsSet(MIGRATED_FLAG, "1");
  }

  /* ---------- profilen (GP1) ----------
     Spelprofil är den RENA modulen: den äger hinkarna och vet vad de betyder.
     Store äger bara persistensen. Saknas modulen (en sida som inte laddar den)
     körs appen vidare utan profil i stället för att vitna — samma hållning som
     minnesbackenden. */
  const harProfilmodul = () => typeof Spelprofil !== "undefined" && Spelprofil;

  /* Migrering av AS4:s `sg_hcp`/`sg_kon`. Körs en gång och rör aldrig
     nycklarna. Villkoret är avsiktligt "finns ingen profil ÄN": har spelaren
     redan svarat i guiden ska ett gammalt localStorage-värde inte kunna skriva
     över svaret vid nästa boot. */
  async function migreraProfil() {
    if (!harProfilmodul() || lsGet(PROFILE_MIGRATED)) return;
    try {
      const fanns = await be.get(PROFILE, PROFILE_ID);
      if (!fanns) {
        const hcp = lsGet(LEGACY_HCP), kon = lsGet(LEGACY_KON);
        if ((hcp && hcp.trim() !== "") || kon) {
          const p = Spelprofil.franLegacy(hcp, kon);
          p.updatedAt = nowIso();
          await be.put(PROFILE, Object.assign({ id: PROFILE_ID }, p));
        }
      }
    } catch (e) { console.warn("[Store] migrering av profilen misslyckades", e); }
    lsSet(PROFILE_MIGRATED, "1");
  }

  /* ---------- persistens ---------- */
  function write(d) {
    normalize(d);
    return be.put(DOCS, d).then(() => be.put(ROUNDS, indexRow(d)));
  }

  // Skriv aktivt dokument. Coalescerar: flera mutationer under en flush blir en
  // extra skrivning, inte en kö. Ingen fördröjning — ett loggat slag ska ligga
  // på disk innan telefonen hinner dö.
  function flush() {
    // Invarianterna måste gälla för den SYNKRONA läsaren omedelbart, inte först
    // när skrivningen landat — därför normaliseras det levande dokumentet här,
    // före klonen som går ner i backend.
    if (doc) normalize(doc);
    dirty = true;
    if (flushing) return flushing;
    flushing = (async () => {
      while (dirty) {
        dirty = false;
        if (!doc) break;
        try { await write(clone(doc)); }
        catch (e) { console.warn("[Store] skrivning misslyckades", e); }
      }
      flushing = null;
    })();
    return flushing;
  }

  /* ---------- publikt API ---------- */
  function ready() {
    if (readyP) return readyP;
    readyP = (async () => {
      try { be = await openIdb(); }
      catch (e) {
        console.warn("[Store] IndexedDB otillgänglig — kör i minnesläge", e);
        be = memoryBackend();
      }
      try { await migrate(); }
      catch (e) { console.warn("[Store] migrering hoppades över", e); }
      // hydrera aktiv runda (senast påbörjade med status active)
      try {
        const rows = (await be.all(ROUNDS)).filter(r => r.status === "active")
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        if (rows.length) doc = await be.get(DOCS, rows[0].id);
        if (doc) normalize(doc);
        if (doc && doc.matchId) match = await be.get(MATCHES, doc.matchId);
        // Match UTAN runda (AS-IA steg 2, §2.8.2): sällskapet ska gå att sätta
        // upp kvällen innan, innan någon runda finns. En sådan match nåddes
        // förut BARA via doc.matchId — den skrevs alltså till IndexedDB och
        // blev omöjlig att hitta igen efter en omladdning, så uppsättningen såg
        // sparad ut och var borta nästa gång sidan öppnades. Id:t läggs därför
        // undan separat och plockas upp här när ingen runda pekar ut en match.
        if (!match) {
          const vantande = lasVantandeMatch();
          if (vantande) match = await be.get(MATCHES, vantande);
        }
        // RÄDDNING. `setMatch` skrev inte pekaren förrän 2026-08-19, och
        // live-kortet bor på SETUP-vyn — som per definition bara syns när ingen
        // runda finns. Varje live-match skapades alltså utan runda OCH utan
        // pekare: den överlevde bara i minnet, och ett sidbyte (Karta, Översikt)
        // före "Starta rundan" räckte för att tappa den. Matchraden ligger kvar
        // i IndexedDB, oadopterad — vilket är exakt vad pekaren skulle ha pekat
        // ut. Fönstret finns för att en kvarglömd match från förra veckan inte
        // ska dyka upp mitt i en ny runda.
        if (!match) match = await hittaOadopterad();
        // Rundan har tagit över matchen → glöm det lösa id:t, annars kan en
        // gammal uppsättning dyka upp igen efter att rundan avslutats.
        if (match && doc && doc.matchId === match.id) glomVantandeMatch();
        /* Adoption vid hydrering — samma regel som `startRound()`: en match som
           aldrig hängts på en runda hör hemma i den aktiva. startRound täcker
           bara matcher som ligger i MINNET när rundan startar; en match som
           skapades i en tidigare sidsession nådde aldrig hit. */
        else if (match && doc && !match.myRoundId) {
          match.myRoundId = doc.id;
          doc.matchId = match.id;
          glomVantandeMatch();
          await writeMatch();
          flush();
        }
      } catch (e) { console.warn("[Store] kunde inte hydrera aktiv runda", e); }
      // Profilen hydreras som rundan: läses en gång, lever synkront. Sidor som
      // renderar i Store.ready() ska kunna fråga efter den utan await.
      try {
        await migreraProfil();
        const rad = await be.get(PROFILE, PROFILE_ID);
        if (rad && harProfilmodul()) profil = Spelprofil.normalisera(rad);
      } catch (e) { console.warn("[Store] kunde inte hydrera profilen", e); }
      return true;
    })();
    return readyP;
  }

  const active = () => doc;
  const activeId = () => (doc ? doc.id : null);

  function startRound(opts) {
    doc = newDoc(opts);
    /* En uppsättning gjord FÖRE rundan (AS-IA steg 2) ska följa med in i den —
       annars hade kvällens sällskap och spelform tyst försvunnit i det ögonblick
       spelaren tryckte på starta. Rundan adopterar matchen; pekaren behövs inte
       längre eftersom doc.matchId nu hittar den. */
    if (match && !match.myRoundId) {
      match.myRoundId = doc.id;
      doc.matchId = match.id;
      glomVantandeMatch();
      writeMatch();
    }
    flush();
    return doc;
  }

  // Skapar en aktiv runda om ingen finns. Ersätter de sex inline-fallbackarna i
  // karta.html, som alla skapade en runda UTAN spelare/bana/tee.
  function ensureRound() {
    if (!doc) startRound({});
    return doc;
  }

  function finishRound() {
    if (!doc) return Promise.resolve(null);
    doc.status = "finished";
    doc.endedAt = doc.endedAt || nowIso();
    const d = doc;
    doc = null;
    return write(clone(d)).then(() => d);
  }

  // Avsluta pågående runda (den blir kvar i historiken) och börja en ny.
  function newRound(opts) {
    return finishRound().then(() => startRound(opts || {}));
  }

  function mutate(fn) {
    if (!doc) return false;
    if (fn(doc) === false) return false;
    flush();
    return true;
  }

  /* Mutera ETT dokument via id, oavsett om det råkar vara den aktiva rundan
     eller en tidigare avslutad. `mutate()` ovan kan bara nå `doc` — men en
     avslutad runda slutar vara `doc` i samma ögonblick `finishRound()`
     returnerar (§ finishRound), och molnsvepet (MOLN_PLAN §6 V2b) behöver
     ändå kunna sätta `moln`-fältet på gamla, redan avslutade rundor. Ingen ny
     lagringsplats: samma DOCS/ROUNDS-lager som `write()` alltid skrivit till. */
  async function mutateDoc(id, fn) {
    if (doc && doc.id === id) return mutate(fn);
    await ready();
    const d = await get(id);
    if (!d) return false;
    if (fn(d) === false) return false;
    await write(d);
    return true;
  }

  // Anropare som muterar dokumentet direkt (index.html håller det i sin egen
  // S-variabel) säger till om det med touch() i stället för att gå via mutate.
  const touch = () => { if (doc) flush(); };

  function hole(n) {
    ensureRound();
    let h = doc.holes.find(x => x.n === n);
    if (!h) {
      h = newHole(n, doc.loggingLevel);
      doc.holes.push(h);
      doc.holes.sort((a, b) => a.n - b.n);
    }
    return h;
  }

  // Läs ett håls post UTAN att skapa den. Läsarna (analys, översikt, kartan) ska
  // aldrig behöva veta att holes är en array.
  const holeIn = (d, n) => ((d && d.holes) || []).find(h => h.n === n) || null;

  // Har hålet något loggat alls? Avgör om ett nivåbyte får röra dess nivå.
  const hasData = h => !!(h && (h.shots.length || h.putts || h.pen || h.adj ||
                                h.fir != null || h.gir != null || h.events.length));

  /* Byt rundans loggningsnivå, även mitt i rundan (§9.2.2).
     Hål som redan har data BEHÅLLER sin nivå — den beskriver vad som faktiskt
     loggades där. Tomma hål får den nya nivån, annars skulle ett hål som
     skapades på nivå 3 och sedan fylldes med bara en score räknas som
     SG-underlag. */
  function setLevel(n) {
    if (!doc || !(n >= 1 && n <= 3)) return false;
    doc.loggingLevel = n;
    for (const h of doc.holes) if (!hasData(h)) h.level = n;
    flush();
    return true;
  }

  // Muterar ett håls post. fn(hålet, dokumentet); returnera false för att avbryta
  // utan skrivning (samma konvention som redigera.js hade).
  function mutateHole(n, fn) {
    ensureRound();
    const h = hole(n);
    if (fn(h, doc) === false) return false;
    flush();
    return true;
  }

  function setCurrent(n) {
    if (!doc || doc.current === n) return false;
    doc.current = n;
    flush();
    return true;
  }

  function addShot(n, shot) { return mutateHole(n, h => { h.shots.push(shot); }); }

  // Hålhändelser: bara OBSERVERADE lagras (§9.1 beslut D). Tre-putt och sandsave
  // härleds ur slaglistan och får aldrig skrivas hit — de kan då motsäga en
  // senare rättning i redigera.js.
  const DERIVABLE = ["three_putt", "sandsave"];
  function addEvent(n, type, value) {
    if (DERIVABLE.indexOf(type) >= 0) {
      console.warn("[Store] härledd händelse lagras inte:", type);
      return false;
    }
    return mutateHole(n, h => { h.events.push({ type, ts: nowIso(), value: value == null ? null : value }); });
  }

  /* ---------- historik ---------- */
  function list(opts) {
    const limit = (opts && opts.limit) || 50;
    return be.all(ROUNDS).then(rows => rows
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit));
  }
  const get = id => be.get(DOCS, id).then(d => (d ? normalize(d) : null));
  function remove(id) {
    if (doc && doc.id === id) doc = null;
    // Trendcachen (A5) är en biprodukt av dokumentet — en raderad runda ska
    // inte lämna ett spöke kvar där (den skulle aldrig läsas igen, men det är
    // skräp och kan förvirra vid felsökning).
    return Promise.all([be.del(DOCS, id), be.del(ROUNDS, id), be.del(TREND, id)]).then(() => true);
  }

  /* ---------- trendcache (A5, ANALYS_MOBIL_V1_BRIEF §10) ----------
     Rundlistan läser BARA indexrader (§9.1.5) — den räcker inte till trenden,
     som behöver GIR/fairway/puttar/SG putt, mått som kräver att hela dokumentet
     öppnas och räknas. Lösningen är en härledd rundsammanfattning som cachas
     HÄR första gången rundan öppnas i trendvyn, och läses därefter i stället för
     att öppna dokumentet igen. Nyckeln bär `v` (AnalysTrend.CACHE_VERSION,
     mobile/analys-trend.js) — ändras måtten byts `v` och den gamla raden
     ignoreras (inte tas bort; den skrivs bara över nästa gång rundan öppnas). */
  const trendSummary = id => ready().then(() => be.get(TREND, id));
  function setTrendSummary(row) {
    if (!row || !row.id) return Promise.resolve(false);
    return ready().then(() => be.put(TREND, clone(row))).then(() => true);
  }

  /* ---------- match ----------
     Enkelriktat: matchen pekar på rund-id. Att ta bort matchen rör ALDRIG
     rundan (APPSTORE_PLAN §1 beslut 2). */
  const currentMatch = () => match;

  /* Molnets fält (gameId, code, displayName) läggs PÅ den match som redan
     finns — den ersätts inte. Förut byggdes ett helt nytt objekt med nytt id
     och tomma `participants`, så ett tryck på "Skapa ny match" nollställde
     kvällens uppsättning: medspelarna, spelformen och vargens val försvann, och
     den gamla matchraden blev kvar föräldralös i IndexedDB. Sällskapet och
     live-matchen är två EGENSKAPER hos samma match, inte två matcher. */
  function setMatch(m) {
    if (!m) return removeMatch();
    match = Object.assign(match || { id: uuid(), createdAt: nowIso(),
                                     participants: [], format: null, wolf: {},
                                     endedAt: null },
                          m);
    if (doc) { match.myRoundId = match.myRoundId || doc.id; doc.matchId = match.id; flush(); }
    // Ingen runda att hänga den på ännu — och live-matchen skapas ALLTID så,
    // eftersom live-kortet bor på setup-vyn. Utan pekaren är matchen omöjlig
    // att hitta igen efter nästa sidladdning (se räddningen i ready()).
    else minnsVantandeMatch(match.id);
    return be.put(MATCHES, clone(match)).then(() => match);
  }
  function removeMatch() {
    const id = match && match.id;
    match = null;
    glomVantandeMatch();                       // annars pekar den på ett raderat id
    if (doc) { doc.matchId = null; flush(); }   // rundan lever vidare oförändrad
    return id ? be.del(MATCHES, id).then(() => true) : Promise.resolve(true);
  }

  /* ---------- markörspelare och spelform (AS4, APPSTORE_PLAN §2.4, §9.4.6) ----------

     §2.4: "Markörspelare är obligatoriskt i v1. Värden måste kunna lägga till
     medspelare som inte har appen, med bara score." Det är också det som gör
     Köpenhamnare (3 spelare) och Wolf (4) möjliga innan molnet finns: utan
     medspelares score går de formaten inte att räkna alls.

     De bor på MATCHEN, inte på rundan. Rundan är ETT dokument för EN spelare
     (§9.1.3) och ska förbli det — en markörspelares score är inte din runda.
     De läggs i `participants`, samma lista som molnspelare hamnar i (§9.1.4),
     med `marker: true` och sin egen `scores`-tabell. EN lista, så frågan "vem
     är med i det här spelet" aldrig får två svar när AS6 kommer: en markör som
     senare installerar appen får ett `uid` och en `roundId`, och slutar bära
     egna scores.

     Matchen kan vara HELT LOKAL: ingen `gameId`, ingen server. `live.js` och
     `oversikt.html` kollar `gameId` innan de gör något, så en lokal match
     stör inte live-scoringen. */

  /* En match utan runda kan inte hittas via `doc.matchId` — därför en egen,
     pytteliten pekare i localStorage. Den är BARA en pekare: matchen själv bor
     kvar i IndexedDB som alla andra. Se hydreringen i `ready()`. */
  const VANTANDE_MATCH = "sg_vantande_match";
  function lasVantandeMatch() {
    try { return localStorage.getItem(VANTANDE_MATCH) || null; } catch (_) { return null; }
  }
  function minnsVantandeMatch(id) {
    try { localStorage.setItem(VANTANDE_MATCH, id); } catch (_) {}
  }
  function glomVantandeMatch() {
    try { localStorage.removeItem(VANTANDE_MATCH); } catch (_) {}
  }

  function writeMatch() {
    return match ? be.put(MATCHES, clone(match)) : Promise.resolve();
  }

  /* Nyaste matchen som aldrig hängts på en runda och inte är avslutad. En
     sådan rad kan bara ha uppstått på ett sätt: den skapades utan runda och
     ingen pekare skrevs. Avslutade och lämnade matcher raderas av
     `removeMatch`, så de kan aldrig dyka upp här. */
  const OADOPTERAD_FONSTER = 24 * 3600 * 1000;   // ett dygn täcker "kvällen innan"
  async function hittaOadopterad() {
    try {
      const nu = Date.now();
      const rader = (await be.all(MATCHES)).filter(m =>
        m && !m.myRoundId && !m.endedAt &&
        nu - Date.parse(m.createdAt || "") < OADOPTERAD_FONSTER);
      rader.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return rader[0] || null;
    } catch (e) {
      console.warn("[Store] kunde inte leta efter en oadopterad match", e);
      return null;
    }
  }

  // Skapa en lokal match om ingen finns. Kräver ingen server och inget nät.
  function ensureMatch() {
    if (match) return match;
    match = { id: uuid(), local: true, gameId: null, code: null, displayName: "",
              format: null, wolf: {}, myRoundId: doc ? doc.id : null,
              participants: [], createdAt: nowIso(), endedAt: null };
    if (doc) { doc.matchId = match.id; flush(); }
    else minnsVantandeMatch(match.id);   // ingen runda att hänga den på ännu
    writeMatch();
    return match;
  }

  const markers = () => ((match && match.participants) || []).filter(p => p && p.marker);

  /* ---------- profilens API (GP1) ----------
     `profile()` är synkron av samma skäl som `active()`: renderingsvägar ska
     inte behöva bli async för att fråga vem spelaren är. Returnerar alltid ett
     helt objekt — en tom profil är ett giltigt svar, `null` vore ett tredje
     tillstånd som varje anropare skulle behöva hantera. */
  function profile() {
    if (profil) return clone(profil);
    return harProfilmodul() ? Spelprofil.tom() : null;
  }

  /* Patch, inte ersättning: guiden sparar ett steg i taget, och Profil-fliken
     ett fält i taget. Normaliseringen körs på HELA resultatet, så ett okänt
     värde aldrig kan smyga in via en delvis skrivning. */
  function setProfile(patch) {
    if (!harProfilmodul()) return null;
    const nu = Spelprofil.normalisera(Object.assign(profile(), patch || {}));
    nu.updatedAt = nowIso();
    profil = nu;
    const rad = Object.assign({ id: PROFILE_ID }, nu);
    /* INVÄNTA BACKEND-EN. `Promise.resolve().then(() => be.put(…))` såg ut att
       göra det men gjorde det inte: `be` är null tills `ready()` valt backend,
       och en microtask hinner före. En profil satt strax efter sidladdning
       försvann därför TYST — den låg kvar i minnet, så allt såg rätt ut ända
       tills sidan laddades om, och enda spåret var en console.warn.
       Uppmätt 2026-08-01 i browsern: `TypeError: … reading 'put'`, och
       `profile`-lagret tomt medan `Store.profile()` svarade fullt. Att GP1:s
       egen mätning inte såg det är logiskt — en människa hinner aldrig trycka
       i guiden lika fort efter en sidladdning som ett skript gör. */
    ready()
      .then(() => be.put(PROFILE, rad))
      .catch(e => console.warn("[Store] kunde inte spara profilen", e));
    return clone(nu);
  }

  /* Handicap för netto — med sin källa. Genvägen finns för att varje anropare
     annars måste komma ihåg att fråga Spelprofil om skillnaden mellan ett
     inmatat och ett härlett tal, och den som glömmer visar en gissning som ett
     mätvärde (§GP1 beslut 3). */
  function hcpForBerakning() {
    return harProfilmodul() ? Spelprofil.hcpForBerakning(profile())
                            : { value: null, kalla: "saknas" };
  }

  /* ---------- rundplanens API (GP3) ----------
     Planerna är till skillnad från profilen INTE synkront läsbara: de är en
     lista, de kan vara många, och ingen renderingsväg behöver dem för att rita
     ett slag. De läses med await när plan-vyn öppnas, precis som rundlistan.

     `plans` är ett eget objektlager och inte ett fält på rundan, av samma skäl
     som `matches` är det: en plan lever FÖRE rundan och kan användas om igen.
     Formen är ETT serialiserbart dokument (Plan.normalisera), så AS6:s synk
     blir en kopiering — samma villkor som §GP1 beslut 2 satte för profilen. */
  const harPlanmodul = () => typeof Plan !== "undefined" && Plan;

  function plans() {
    if (!harPlanmodul()) return Promise.resolve([]);
    return ready()
      .then(() => be.all(PLANS))
      .then(rows => (rows || [])
        .map(r => Plan.normalisera(r))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))))
      .catch(e => { console.warn("[Store] kunde inte läsa planerna", e); return []; });
  }

  function plan(id) {
    if (!harPlanmodul() || !id) return Promise.resolve(null);
    return ready()
      .then(() => be.get(PLANS, id))
      .then(r => (r ? Plan.normalisera(r) : null))
      .catch(e => { console.warn("[Store] kunde inte läsa planen", e); return null; });
  }

  /* Sparar och returnerar det normaliserade dokumentet SYNKRONT, medan
     skrivningen går async — samma kontrakt som setProfile, och med samma
     `ready()`-väntan: `be` är null tills backend valts, och en plan sparad
     strax efter sidladdning försvann annars tyst (§GP1 del 1:s mätning). */
  function savePlan(p) {
    if (!harPlanmodul()) return null;
    const doc = Plan.normalisera(p);
    doc.updatedAt = nowIso();
    ready()
      .then(() => be.put(PLANS, clone(doc)))
      .catch(e => console.warn("[Store] kunde inte spara planen", e));
    return doc;
  }

  function removePlan(id) {
    if (!id) return Promise.resolve(false);
    return ready().then(() => be.del(PLANS, id)).then(() => true)
      .catch(e => { console.warn("[Store] kunde inte ta bort planen", e); return false; });
  }

  /* Lägg till en markörspelare. `tee` och `kon` behövs för NETTO: course rating
     och slope slås upp per kombination × tee × kön (§7.1-notan: slå aldrig upp
     rating utan att veta kön). Saknas de går netto inte att räkna för spelaren,
     och regelkärnan säger det i stället för att gissa. */
  function addPlayer(p) {
    const m = ensureMatch();
    const spelare = { id: uuid(), marker: true, name: (p && p.name) || "Medspelare",
                      hcpIndex: p && p.hcpIndex != null ? p.hcpIndex : null,
                      tee: (p && p.tee) || null, kon: (p && p.kon) || null,
                      scores: {} };
    m.participants.push(spelare);
    writeMatch();
    return spelare;
  }

  function updatePlayer(id, fn) {
    const p = markers().find(x => x.id === id);
    if (!p) return false;
    if (fn(p) === false) return false;
    writeMatch();
    return true;
  }

  function removePlayer(id) {
    if (!match || !match.participants) return false;
    const i = match.participants.findIndex(p => p && p.id === id);
    if (i < 0) return false;
    match.participants.splice(i, 1);
    // Wolf-val som pekar på en borttagen spelare skulle ge ett lag med en
    // partner som inte finns — släpp dem i stället för att räkna fel.
    for (const h of Object.keys(match.wolf || {}))
      if (match.wolf[h] && match.wolf[h].partner === id) delete match.wolf[h];
    writeMatch();
    return true;
  }

  /* Markörspelarens BRUTTO på ett hål. null/tomt raderar (ospelat hål ska vara
     frånvaro av värde, inte 0 — en nolla skulle räknas som en spelad hålscore). */
  function setPlayerScore(id, holeN, brutto) {
    return updatePlayer(id, p => {
      if (brutto == null || brutto === "" || !(brutto > 0)) delete p.scores[holeN];
      else p.scores[holeN] = Math.round(brutto);
    });
  }

  function setFormat(key, config) {
    const m = ensureMatch();
    m.format = key ? { key, config: config || null } : null;
    writeMatch();
    return m.format;
  }
  const format = () => (match && match.format) || null;

  /* Wolf: vem vargen valde på ett hål. `null` raderar valet — och ett raderat
     val betyder "inget val loggat", vilket kärnan hoppar över (den gissar
     aldrig att vargen spelade ensam). */
  function setWolfChoice(holeN, val) {
    const m = ensureMatch();
    m.wolf = m.wolf || {};
    if (!val) delete m.wolf[holeN];
    else m.wolf[holeN] = { partner: val.partner || null, lone: !!val.lone };
    writeMatch();
    return m.wolf;
  }
  const wolfChoices = () => (match && match.wolf) || {};

  /* ---------- beständighet ----------
     Att byta till IndexedDB löser storleken, inte nödvändigtvis vräkningen:
     iOS rensar script-skrivbar lagring för sajter som inte används. Be om
     persistens vid en användargest (rundstart), aldrig i onboardingen. */
  function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) return navigator.storage.persist();
    } catch (e) {}
    return Promise.resolve(false);
  }
  /* Lagringsläget, för att kunna redovisas ÄRLIGT i UI:t (§9.1.11).
     `persisted` är den viktiga: false betyder att iOS får vräka rundorna om
     appen inte används på länge. null = webbläsaren svarar inte på frågan —
     det får inte presenteras som ett nej. */
  function storageInfo() {
    const out = { usage: null, quota: null, persisted: null,
                  backend: be ? be.kind : null };
    const st = (typeof navigator !== "undefined" && navigator.storage) || null;
    const jobs = [];
    if (st && st.estimate) {
      jobs.push(st.estimate().then(est => { out.usage = est.usage; out.quota = est.quota; },
                                   () => {}));
    }
    if (st && st.persisted) {
      jobs.push(Promise.resolve().then(() => st.persisted())
        .then(v => { out.persisted = !!v; }, () => {}));
    }
    return Promise.all(jobs).then(() => out, () => out);
  }

  return {
    ready, active, activeId, startRound, ensureRound, finishRound, newRound,
    mutate, mutateDoc, touch, hole, holeIn, hasData, mutateHole, setCurrent, setLevel,
    addShot, addEvent,
    list, get, remove, export: toWire, import: importera,
    // trendcache (A5)
    trendSummary, setTrendSummary,
    profile, setProfile, hcpForBerakning,
    // rundplaner (GP3)
    plans, plan, savePlan, removePlan,
    // Sammanfattning av ETT dokument (samma form som indexraden) — det vyerna
    // använder för ärlig täckningsredovisning.
    summary: indexRow,
    match: currentMatch, setMatch, removeMatch,
    // markörspelare + spelform (AS4)
    ensureMatch, markers, addPlayer, updatePlayer, removePlayer, setPlayerScore,
    setFormat, format, setWolfChoice, wolfChoices,
    requestPersist, storageInfo,
    // interna, för tester (tests/js/test_store.mjs)
    _indexRow: indexRow, _normalize: normalize, _newDoc: newDoc,
    _docFromLegacyActive: docFromLegacyActive, _docFromLegacyWire: docFromLegacyWire,
    _memoryBackend: memoryBackend,
    _setBackend(b) { be = b; readyP = Promise.resolve(true); },
    _setActive(d) { doc = d; },
    _flush: flush,
  };
})();
if (typeof window !== "undefined") window.Store = Store;
else if (typeof globalThis !== "undefined") globalThis.Store = Store;
