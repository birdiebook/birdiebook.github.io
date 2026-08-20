"use strict";
/* INBJUDAN PÅ NAMN — spelarkatalogen och inbjudningarna (sql/inbjudan.sql).
 *
 * Ren datamodul: ingen DOM, ingen rendering. `boll.js` (värdens sida) och
 * hubben (mottagarens sida) är de två vyerna som använder den.
 *
 * VAD DEN ERSÄTTER. Spelkoden var enda vägen in i en match: någon läste upp
 * fyra tecken på första tee och alla skrev in dem. Koden finns kvar — den är
 * RLS-barriären och enda vägen in för den som inte har konto — men den behöver
 * inte längre skrivas av en människa. En inbjudan BÄR koden, och ett ja kör
 * samma `SGLive.joinGame(kod)` som förut.
 *
 * TRE REGLER SOM BÄR MODULEN
 *
 * 1. ALLT FÅR MISSLYCKAS. Samma hållning som konto.js regel 3: en spelare utan
 *    täckning på parkeringen ska aldrig blockeras. Varje funktion returnerar
 *    ett tomt/negativt svar i stället för att kasta, och `tillganglig()` säger
 *    om vägen finns alls. Saknas den visar vyerna spelkoden i stället — den
 *    fungerar utan den här filen.
 *
 * 2. INGET SKRIVS I FÖRTID. En inbjudan skapar INGEN rad i `game_players`.
 *    Först när mottagaren svarar ja går hen med, under sitt EGET namn. Skulle
 *    värden reservera platsen i förväg får man två rader när Anders går med
 *    som "Anders A" — samma dubblettbugg som `display_name` alltid har bjudit
 *    in till (live.js:107).
 *
 * 3. KATALOGEN ÄR ETT VAL. `sokbar` bor i databasen, inte i ett klientfilter,
 *    och den som stängt av sig går inte att hitta. En katalog man hamnar i av
 *    bara farten är ett publicerat medlemsregister.
 *
 * Beroende: `SGLive` (live.js) för den delade supabase-klienten och för
 * `joinGame`. Aldrig `createClient` här — två klienter skriver över varandras
 * token-förnyelser (se live.js sista kommentaren). */
const Inbjudan = (() => {

  const MIN_SOK = 2;          // under två tecken är träfflistan hela katalogen
  const MAX_TRAFF = 8;

  const finns = () => typeof SGLive !== "undefined" && !!SGLive.client &&
                      typeof window !== "undefined" &&
                      !!(window.supabase && window.supabase.createClient);

  function db() { return SGLive.client(); }

  /* Tyst logg. Medvetet INTE `SGLive.liveWarn`: den ritar en röd banner för
     serverfel, och det första någon skulle se efter en deploy där SQL:en ännu
     inte körts vore en varning om en tabell hen inte vet finns. Fel som
     användaren KAN göra något åt (sökningen gick inte) bärs som returvärde och
     skrivs i vyn där hen står. */
  function tyst(var_, e) {
    try { console.warn("[Inbjudan] " + var_, e); } catch (_) {}
    return null;
  }

  /* Sessionen. Anonym duger: ett gäst-uid är ett riktigt uid (konto.js regel 2)
     och gästen ska kunna både bjuda in och bli inbjuden. Skillnaden mot ett
     konto är att gästen inte kommer åt matchen från en annan telefon. */
  async function uid() {
    if (!finns()) return null;
    try { return (await SGLive.initLive()).uid; }
    catch (e) { return tyst("ingen session", e); }
  }

  const tillganglig = () => finns();

  /* ---------- katalogen ---------- */

  /* Lägg/uppdatera MIN rad. Anropas när en sida som kan bjuda in öppnas, inte
     vid varje tangenttryck: namnet ändras i profilen, och profilen är den
     enda sanningen om vad jag heter (§GP1 beslut 1).

     Tomt namn skriver INGENTING. En rad som heter "" är sökbar på varje query
     och skulle ligga överst i alla träfflistor. */
  async function synkaMig(p) {
    const u = await uid();
    if (!u) return null;
    const namn = String((p && p.namn) || "").trim();
    if (!namn) return null;
    const rad = { uid: u, namn, klubb: (p && p.klubb) || null,
                  updated_at: new Date().toISOString() };
    const { error } = await db().from("spelare_katalog")
      .upsert(rad, { onConflict: "uid" });
    if (error) return tyst("kunde inte synka katalogen", error);
    return rad;
  }

  /* Min egen rad — vyn i profilen behöver veta om jag är sökbar. */
  async function minKatalograd() {
    const u = await uid();
    if (!u) return null;
    const { data, error } = await db().from("spelare_katalog")
      .select("uid, namn, klubb, sokbar").eq("uid", u).maybeSingle();
    if (error) return tyst("kunde inte läsa katalogen", error);
    return data || null;
  }

  async function sattSokbar(pa) {
    const u = await uid();
    if (!u) return false;
    const { error } = await db().from("spelare_katalog")
      .update({ sokbar: !!pa, updated_at: new Date().toISOString() }).eq("uid", u);
    if (error) { tyst("kunde inte ändra sökbarheten", error); return false; }
    return true;
  }

  /* Sök på namn. Returnerar ALLTID en lista — tom vid fel, för en vy som ritar
     en träfflista ska inte behöva skilja på "inga träffar" och "molnet svarade
     inte"; det senare syns på att spelkoden fortfarande erbjuds.

     Jag själv filtreras bort. Att kunna bjuda in sig själv är inte ett
     kantfall man löser med ett felmeddelande. */
  async function sok(q) {
    const fraga = String(q || "").trim();
    if (fraga.length < MIN_SOK || !finns()) return [];
    const u = await uid();
    // `%` och `_` är jokrar i ilike: en spelare som söker på "_" skulle annars
    // få hela katalogen. Escapas med backslash, som PostgREST förstår.
    const sakert = fraga.replace(/[\\%_]/g, c => "\\" + c);
    const { data, error } = await db().from("spelare_katalog")
      .select("uid, namn, klubb")
      .ilike("namn", "%" + sakert + "%")
      .limit(MAX_TRAFF + 1);
    if (error) { tyst("sökningen gick inte", error); return []; }
    return (data || []).filter(r => r && r.uid !== u).slice(0, MAX_TRAFF);
  }

  /* ---------- inbjudningarna ---------- */

  /* Bjud in. `namn` är vad VÄRDEN kallar platsen (katalognamnet), så bollen kan
     visa "Anders — väntar…" innan Anders rört sin telefon.

     Upsert på (game_id, till_uid): bjuder man in samma person igen ska den
     gamla raden väckas, inte dubbleras. Det gör också "ångra avböjt" gratis. */
  async function skicka(o) {
    o = o || {};
    if (!finns()) return { ok: false, fel: "Molnet är inte tillgängligt just nu." };
    const u = await uid();
    if (!u) return { ok: false, fel: "Ingen session — prova igen om en stund." };
    if (!o.gameId || !o.kod || !o.tillUid) {
      return { ok: false, fel: "Matchen är inte skapad ännu." };
    }
    const rad = {
      game_id: o.gameId, kod: String(o.kod).toUpperCase(),
      fran_uid: u, fran_namn: String(o.franNamn || "").trim() || "En spelare",
      till_uid: o.tillUid, namn: String(o.namn || "").trim() || "Spelare",
      bana: o.bana || null, tee_time: o.teeTime || null,
      status: "vantar", skapad: new Date().toISOString(), svarad: null,
    };
    const { data, error } = await db().from("spel_inbjudan")
      .upsert(rad, { onConflict: "game_id,till_uid" })
      .select("id, till_uid, namn, status").single();
    if (error) {
      tyst("inbjudan gick inte att skicka", error);
      return { ok: false, fel: "Inbjudan gick inte fram. Dela spelkoden i stället." };
    }
    return { ok: true, inbjudan: data };
  }

  /* Statusen för dem JAG bjudit in till ett spel. Bollen ritar "väntar…" /
     "avböjde" ur den här. */
  async function forSpel(gameId) {
    if (!gameId || !finns()) return [];
    const { data, error } = await db().from("spel_inbjudan")
      .select("id, till_uid, namn, status, skapad").eq("game_id", gameId);
    if (error) { tyst("kunde inte läsa spelets inbjudningar", error); return []; }
    return data || [];
  }

  async function taBort(id) {
    if (!id || !finns()) return false;
    const { error } = await db().from("spel_inbjudan").delete().eq("id", id);
    if (error) { tyst("kunde inte ta bort inbjudan", error); return false; }
    return true;
  }

  /* ---------- mottagarens sida ---------- */

  /* Mina obesvarade inbjudningar, nyast först. Hubben ritar dem som kort. */
  async function mina() {
    if (!finns()) return [];
    const u = await uid();
    if (!u) return [];
    const { data, error } = await db().from("spel_inbjudan")
      .select("id, game_id, kod, fran_namn, namn, bana, tee_time, status, skapad")
      .eq("till_uid", u).eq("status", "vantar")
      .order("skapad", { ascending: false });
    if (error) { tyst("kunde inte hämta inbjudningar", error); return []; }
    return data || [];
  }

  /* Svara. JA gör två saker i ordning, och ordningen spelar roll: gå med FÖRST,
     markera sedan. Skulle statusen skrivas först och `joinGame` falla på ett
     nät som dog i samma sekund vore inbjudan borta ur hubben och spelaren inte
     med någonstans — hen hade fått börja om, utan att veta vad som gick fel.
     Tvärtom är ofarligt: hen är med i matchen och kortet ligger kvar tills
     nästa svar går igenom. */
  async function svara(id, ja) {
    if (!finns()) return { ok: false, fel: "Molnet är inte tillgängligt just nu." };
    const u = await uid();
    if (!u) return { ok: false, fel: "Ingen session — prova igen om en stund." };
    const { data: inb, error: e1 } = await db().from("spel_inbjudan")
      .select("id, game_id, kod, namn, bana, tee_time").eq("id", id).maybeSingle();
    if (e1 || !inb) return { ok: false, fel: "Inbjudan finns inte längre." };

    let gameId = null;
    if (ja) {
      // Mitt EGET namn ur profilen — aldrig `inb.namn`. Det är vad värden
      // kallade platsen, och en gissning på hur jag stavar mitt namn ska inte
      // bli mitt namn på scorekortet.
      const p = (typeof Store !== "undefined" && Store.profile && Store.profile()) || {};
      const mittNamn = String(p.namn || "").trim() || inb.namn;
      try {
        const r = await SGLive.joinGame(inb.kod, mittNamn);
        gameId = r.gameId;
      } catch (e) {
        tyst("kunde inte gå med", e);
        return { ok: false, fel: "Kunde inte gå med i matchen. Prova igen." };
      }
    }
    const { error: e2 } = await db().from("spel_inbjudan")
      .update({ status: ja ? "med" : "avbojd", svarad: new Date().toISOString() })
      .eq("id", id);
    if (e2) tyst("svaret kunde inte sparas", e2);   // se kommentaren ovan
    return { ok: true, gameId, kod: inb.kod, bana: inb.bana, teeTime: inb.tee_time };
  }

  /* Realtid: kortet ska dyka upp medan telefonen ligger på bordet. Vyerna
     hämtar ALLTID vid sidvisning också — den här är en förbättring, aldrig
     den enda vägen (samma hållning som subscribePins i live.js). */
  function prenumerera(cb) {
    if (!finns()) return () => {};
    let ch = null;
    uid().then(u => {
      if (!u) return;
      ch = db().channel("inbjudan:" + u)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "spel_inbjudan",
              filter: "till_uid=eq." + u },
            () => { try { cb(); } catch (_) {} })
        .subscribe();
    });
    return () => { if (ch) try { db().removeChannel(ch); } catch (_) {} };
  }

  return { tillganglig, synkaMig, minKatalograd, sattSokbar, sok,
           skicka, forSpel, taBort, mina, svara, prenumerera, MIN_SOK };
})();
if (typeof window !== "undefined") window.Inbjudan = Inbjudan;
