"use strict";
/* MOLN — skickar OCH hämtar hem spelade rundor (MOLN_PLAN.md §6 V2/V2b/V4a).
 *
 * Servern (`mobile/worker.js`, `POST /rundor`) är klar, deployad och skarpt
 * verifierad sedan 2026-08-05 — se MOLN_PLAN.md §6 V2 för mätningarna. Denna
 * modul bygger bara klientvägen dit.
 *
 * KÖN ÄR RUNDORNA SJÄLVA. Ingen separat kö-store byggs — en avslutad runda
 * som inte lyckats skickas ligger kvar precis där den redan låg (IndexedDB,
 * via `store.js`), märkt med sitt eget `moln`-fält:
 *
 *   doc.moln = { sant: <ISO>|null, forsok: <n>, sistFel: <text>|null }
 *
 * `sant` sätts först när servern svarat 200. Alla andra utfall lämnar den
 * `null` — rundan är alltså fortfarande komplett och synlig i appen, den är
 * bara inte uppladdad än. En egen kö hade kunnat komma ur fas med rundorna
 * och blivit ett andra ställe att felsöka (§6 V2's resonemang för att
 * `inflight`/reconciliation-svep aldrig byggs).
 *
 * IDEMPOTENSEN LIGGER I SERVERN, INTE HÄR. Samma `round_id` skickad två
 * gånger ger samma R2-blob och EN indexrad (mätt i produktion). Klienten får
 * därför vara dum: skicka om vid minsta tveksamhet, det kan inte bli
 * dubbletter. Det är hela skälet att svepet nedan är så enkelt.
 *
 * ETT UNDANTAG: 400/413 betyder att KROPPEN är trasig eller för stor — att
 * försöka igen är meningslöst, inte bara onödigt. En sådan runda märks
 * `moln.nekad = true` så att `svep()` slutar försöka på den. Det fältet
 * ligger utanför den `{sant, forsok, sistFel}`-form MOLN_PLAN.md §6 V2b
 * räknar upp — lagt till här för att göra "köar inte i evighet" sant utan
 * att hitta på en separat kö. 401/500/nätfel räknas som övergående och
 * lämnar rundan köad (`sant` förblir null, ingen `nekad`-flagga).
 */
const Moln = (() => {

  const RUNDOR_URL = "/rundor";   // samma Cloudflare-projekt som appens filer

  function harMoln() {
    return typeof Store !== "undefined" &&
           typeof Konto !== "undefined" && Konto.tillganglig() &&
           typeof SGLive !== "undefined" && !!SGLive.client;
  }

  async function hamtaToken() {
    await Konto.redo();
    const c = SGLive.client();
    const { data: { session } } = await c.auth.getSession();
    return session ? session.access_token : null;
  }

  function markera(id, patch) {
    if (typeof Store === "undefined" || !Store.mutateDoc) return;
    try {
      Store.mutateDoc(id, d => {
        d.moln = Object.assign({ sant: null, forsok: 0, sistFel: null }, d.moln, patch);
      });
    } catch (e) { /* tyst — se filhuvudet, § punkt 3 i konto.js gäller även här */ }
  }

  function appVersion() {
    try { return (typeof SG_APP_VERSION !== "undefined" && SG_APP_VERSION) || null; }
    catch (e) { return null; }
  }

  /* Skickar EN runda. Returnerar {gjort, round_id?, fel?}:
     "sant"  — servern tog emot den, moln.sant satt.
     "koad"  — övergående fel (nät, 401, 500 …). Kvar i kön, svep() tar den igen.
     "nekad" — kroppen godtogs aldrig (400/413) eller kunde inte byggas alls. */
  async function skicka(doc) {
    if (!doc || !doc.id) return { gjort: "nekad", fel: "Ingen runda att skicka." };
    if (!harMoln()) {
      markera(doc.id, { forsok: ((doc.moln && doc.moln.forsok) || 0) + 1,
                        sistFel: "Molnet är inte tillgängligt just nu." });
      return { gjort: "koad", fel: "Molnet är inte tillgängligt just nu." };
    }

    let payload, kropp;
    try {
      payload = Store.export(doc);
      // round_id skickas EXPLICIT: Store-dokumentets id är redan en UUID och
      // gör att appens id och molnets id blir samma sak (§6 V2b). uid skickas
      // ALDRIG — Workern tar det ur Authorization-tokenen; ett uid i kroppen
      // vore vilseledande (det skulle aldrig litas på av servern ändå).
      kropp = JSON.stringify({ round_id: doc.id, payload, client: { app_version: appVersion() } });
    } catch (e) {
      const fel = "Rundan kunde inte paketeras: " + ((e && e.message) || e);
      markera(doc.id, { nekad: true, forsok: ((doc.moln && doc.moln.forsok) || 0) + 1, sistFel: fel });
      return { gjort: "nekad", fel };
    }

    let token;
    try { token = await hamtaToken(); }
    catch (e) { token = null; }
    if (!token) {
      const fel = "Ingen session — hämta ny inloggning och försök igen.";
      markera(doc.id, { forsok: ((doc.moln && doc.moln.forsok) || 0) + 1, sistFel: fel });
      return { gjort: "koad", fel };
    }

    let r;
    try {
      r = await fetch(RUNDOR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: kropp,
      });
    } catch (e) {
      // Inget nät. Det är det VANLIGA fallet — flygplansläge på banan — inte
      // ett undantag att larma om.
      const fel = (e && e.message) || "Nådde inte servern.";
      markera(doc.id, { forsok: ((doc.moln && doc.moln.forsok) || 0) + 1, sistFel: fel });
      return { gjort: "koad", fel };
    }

    let svar = null;
    try { svar = await r.json(); } catch (e) { /* tomt/trasigt svar hanteras nedan */ }

    if (r.ok) {
      markera(doc.id, { sant: new Date().toISOString(), sistFel: null });
      return { gjort: "sant", round_id: (svar && svar.round_id) || doc.id };
    }

    const felText = (svar && svar.fel) || ("HTTP " + r.status);
    if (r.status === 400 || r.status === 413) {
      // Meningslöst att försöka igen — märk nekad så svep() slutar plocka upp den.
      markera(doc.id, { nekad: true, forsok: ((doc.moln && doc.moln.forsok) || 0) + 1, sistFel: felText });
      return { gjort: "nekad", fel: felText };
    }
    // 401 (sessionen duger inte), 500 och allt annat: övergående — köad.
    markera(doc.id, { forsok: ((doc.moln && doc.moln.forsok) || 0) + 1, sistFel: felText });
    return { gjort: "koad", fel: felText };
  }

  /* Går igenom alla rundor och skickar det som är klart men osänt. Tyst vid
     fel — det är precis vad `skicka()` redan är, svep() lägger bara en
     loop ovanpå. Utlöses vid finishRound, vid appstart (efter Store.ready())
     och på window "online" — inget pollande, ingen timer (§6 V2b). */
  async function svep() {
    if (typeof Store === "undefined") return;
    let rows;
    try { rows = await Store.list({ limit: 200 }); }
    catch (e) { return; }
    for (const row of rows || []) {
      if (!row || row.status !== "finished") continue;
      if (row.moln && (row.moln.sant || row.moln.nekad)) continue;
      try {
        const d = await Store.get(row.id);
        if (!d || (d.moln && (d.moln.sant || d.moln.nekad))) continue;
        await skicka(d);
      } catch (e) { /* tyst — nästa svep tar den igen */ }
    }
  }

  /* ================================================================
   * LÄSVÄGEN (MOLN_PLAN.md §6 V4a) — svepets spegelbild.
   *
   * Designbeslutet: hydrera hela historiken som VANLIGA lokala rundor, bygg
   * ingen parallell "molnrad" i gränssnittet. `rounds_index` bär bara det
   * Postgres behöver för sökbarhet (started_at, course, loop, total_score,
   * total_sg, blob_key, blob_sha, app_version, uploaded_at) — INTE det
   * rundlistan renderar (player, loggingLevel, holesPlayed, strokes, tee …).
   * En hämtad blobb återskapar hela det lokala dokumentet, så listan,
   * analysen och 3D fungerar oförändrat på den — det finns bara en sorts
   * runda. En hel säsong är ~200 kB (§6 V4a mätningen), så priset för att
   * hämta hem allt i stället för att bredda indexraden är litet.
   * ================================================================ */

  /* Indexraderna läses DIREKT ur Supabase via SGLive.client() — inte genom
     Workern. RLS-policyn `p_rounds_index_own` (supabase/rundor.sql) gör redan
     exakt rätt jobb (`auth.uid() = uid`); en Worker-route hade bara varit ett
     andra ställe att få fel på. */
  async function indexrader() {
    if (typeof SGLive === "undefined" || !SGLive.client) return [];
    const c = SGLive.client();
    const { data, error } = await c.from("rounds_index")
      .select("round_id, started_at, course, loop, total_score, total_sg, uploaded_at")
      .order("started_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /* Hämtar EN runda genom Workerns läsroute. Nyckeln byggs på SERVERN av
     tokenens uid + round_id ur sökvägen — klienten skickar aldrig en
     blob_key, den finns inte i det här anropet över huvud taget. Returnerar
     wire-payloaden (samma form som `Store.export` producerar) eller `null`
     vid 404/401/nätfel — molnsvepets "tyst vid fel"-hållning gäller läsvägen
     lika mycket som skrivvägen. */
  async function hamtaBlob(round_id, token) {
    let r;
    try {
      r = await fetch(RUNDOR_URL + "/" + encodeURIComponent(round_id), {
        headers: { Authorization: "Bearer " + token },
      });
    } catch (e) { return null; }
    if (!r.ok) return null;
    let kuvert;
    try { kuvert = await r.json(); } catch (e) { return null; }
    // Blobben lagras som {payload, client, uploaded_at} (samma form som
    // worker.js skriver till R2, §6 V2) — vi vill åt payloaden, inte kuvertet.
    return kuvert && typeof kuvert === "object" ? (kuvert.payload || null) : null;
  }

  /* Går igenom molnets indexrader, hoppar över allt som redan finns lokalt,
     och hydrerar resten. Tyst vid fel, precis som `svep()`. Utlöses vid
     appstart (efter Store.ready(), samma ställe som `svep()`) och efter
     lyckad inloggning i konto.js — inget pollande, ingen timer (samma regel
     som §6 V2b). */
  async function hamta() {
    if (!harMoln()) return { hamtade: 0 };
    let token;
    try { token = await hamtaToken(); } catch (e) { token = null; }
    if (!token) return { hamtade: 0 };

    let rader;
    try { rader = await indexrader(); } catch (e) { return { hamtade: 0 }; }

    let hamtade = 0;
    for (const rad of rader || []) {
      const round_id = rad && rad.round_id;
      if (!round_id) continue;
      try {
        const lokal = await Store.get(round_id);
        if (lokal) continue;   // local-first: rör aldrig en runda som redan finns

        const wire = await hamtaBlob(round_id, token);
        if (!wire) continue;

        const res = await Store.import(round_id, wire);
        if (!res || !res.skrevs) continue;

        // Sätt moln.sant DIREKT på det hydrerade dokumentet, med uploaded_at
        // från indexraden. Utan det ser nästa svep() en avslutad runda utan
        // moln.sant och laddar upp den igen — serverns idempotens gör det
        // ofarligt men det är onödig trafik varje appstart, och
        // forsok-räknaren skulle ticka i onödan för en runda som redan låg
        // säkert i molnet.
        markera(round_id, { sant: rad.uploaded_at || new Date().toISOString(), sistFel: null });
        hamtade++;
      } catch (e) { /* tyst — nästa hamta()-anrop försöker igen */ }
    }
    return { hamtade };
  }

  return { skicka, svep, hamta };
})();

if (typeof window !== "undefined") window.Moln = Moln;
if (typeof module !== "undefined" && module.exports) module.exports = Moln;
