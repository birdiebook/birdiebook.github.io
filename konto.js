"use strict";
/* KONTO — identitet och profil i molnet (MOLN_PLAN.md §4, §5, §6 V1).
 *
 * Halva denna etapp fanns redan: `live.js` skapar sedan live-scoringen en
 * ANONYM Supabase-session med ett riktigt uid. Det som saknades var vägen
 * uppåt — e-post på samma uid — och profilen som följer med till en ny telefon.
 *
 * TRE REGLER SOM BÄR MODULEN:
 *
 * 1. EN KLIENT. Modulen lånar `SGLive.client()` och ropar aldrig
 *    `createClient` själv. Två klienter delar storage-nyckel men har var sin
 *    GoTrue-instans som skriver över varandras token-förnyelser; felet visar
 *    sig som sessioner som tappas slumpmässigt, långt från orsaken.
 *
 * 2. UID:T ÄR SAMMA FÖRE OCH EFTER. Supabase behåller user-id vid uppgradering
 *    från anonym till e-post. Därför behöver ingen data flyttas när ett konto
 *    skapas — profilen, rundorna och matcherna är redan nycklade rätt från
 *    första gäst-sessionen. Detta är hela skälet att bygga entrén gäst-först
 *    även i alfan, när ingen ännu har ett konto: det är gratis nu och dyrt att
 *    införa i efterhand.
 *
 * 3. INLOGGNING ÄR ALDRIG ETT KRAV. Appen loggar rundor lokalt och räknar allt
 *    i klienten. Molnet är backup och delning. Varje funktion här får därför
 *    misslyckas tyst — en spelare utan täckning på banan ska aldrig blockeras
 *    av att en profilsynk inte gick igenom.
 *
 * KOD, ALDRIG MAGISK LÄNK. En länk öppnas i Safari, inte i den installerade
 * appen eller i skalets webview, och sessionen hamnar då i fel kontext.
 * Sexsiffrig kod skrivs in där man står. (MOLN_PLAN §0.5, §9.1.)
 */
const Konto = (() => {

  const lyssnare = new Set();
  let cache = { uid: null, gast: true, epost: null };

  function db() {
    if (typeof SGLive === "undefined" || !SGLive.client) {
      throw new Error("live.js måste laddas före konto.js.");
    }
    return SGLive.client();
  }

  const finns = () => typeof SGLive !== "undefined" &&
                      typeof window !== "undefined" &&
                      !!(window.supabase && window.supabase.createClient);

  function satt(user) {
    cache = user
      ? { uid: user.id, gast: !user.email, epost: user.email || null }
      : { uid: null, gast: true, epost: null };
    for (const cb of lyssnare) { try { cb(status()); } catch (e) {} }
    return status();
  }

  const status = () => ({ uid: cache.uid, gast: cache.gast, epost: cache.epost,
                          inloggad: !!cache.uid });

  /* LÄSER en befintlig session. Skapar ALDRIG en.
     Skillnaden mot `redo()` är inte teknisk finess utan en hållning: en
     molnidentitet ska präglas när spelaren gör något som behöver molnet, inte
     när hen råkar öppna en inställningssida. Att visa "du spelar som gäst" är
     just en sådan sida — den frågan går att besvara utan att skapa något.
     (Mätt 2026-08-03: utan denna delning skapade ett besök på profil.html en
     riktig anonym användare i projektet. Gäst-först betyder gäst UTAN
     formulär, inte ett konto åt var och en som tittar.) */
  async function lasSession() {
    if (!finns()) return status();
    const { data: { session } } = await db().auth.getSession();
    return satt(session ? session.user : null);
  }

  /* Säkrar en session — anonym om ingen finns. Anropas av handlingar som
     FAKTISKT behöver molnet (skicka kod, spara profil, synka). Samma kontrakt
     som `SGLive.initLive()`, och avsiktligt utbytbart med den: den som kommer
     först vinner, den andra hittar sessionen. */
  async function redo() {
    if (!finns()) return status();
    const c = db();
    let { data: { session } } = await c.auth.getSession();
    if (!session) {
      const { data, error } = await c.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    return satt(session.user);
  }

  /* Steg 1. Två vägar, och VALET MELLAN DEM är det som gör att både en ny
     användare och en gäst med spelade rundor får rätt utfall:

     - Finns en GÄSTSESSION → `updateUser` → uid BEHÅLLS, och gästens rundor
       och profil följer med utan att någon data flyttas.
     - Finns INGEN session → `signInWithOtp` → skapar konto ELLER loggar in på
       ett befintligt. Supabase skiljer inte på de två, och det är rätt här:
       användaren skriver sin e-post och får en kod, oavsett om hen varit med
       förut.

     Vi LÄSER sessionen, vi skapar den aldrig här. Första versionen anropade
     `redo()` överst, vilket präglade en gäst innan valet gjordes — så vägen
     blev ALLTID "uppgradera gäst". För en ny användare vars e-post redan fanns
     nekades uppgraderingen, och hen stod kvar som gäst med ett felmeddelande,
     när hon bara ville logga in. (Rättat 2026-08-03 när entrén öppnades för
     andra än grundaren.)

     `tvingaInloggning` är vägen ut ur det kantfallet: logga ut gästen och gå
     inloggningsvägen i stället. */
  async function skickaKod(epost, opt) {
    const c = db();
    await lasSession();

    if (opt && opt.tvingaInloggning && cache.uid) {
      await c.auth.signOut();
      satt(null);
    }

    if (cache.gast && cache.uid) {
      const { error } = await c.auth.updateUser({ email: epost });
      if (error) throw fel(error);
      return { lage: "uppgradering" };
    }
    const { error } = await c.auth.signInWithOtp({ email: epost });
    if (error) throw fel(error);
    return { lage: "inloggning" };
  }

  /* Steg 2. `type` MÅSTE spegla steg 1: en gäst som lägger till e-post
     verifieras som `email_change`, en vanlig inloggning som `email`. Fel typ
     ger "Token has expired or is invalid" på en kod som är alldeles färsk —
     ett fel som är omöjligt att gissa sig till från meddelandet. */
  async function verifiera(epost, kod, lage) {
    const c = db();
    const type = lage === "uppgradering" ? "email_change" : "email";
    const { data, error } = await c.auth.verifyOtp({
      email: epost, token: String(kod).trim(), type });
    if (error) throw fel(error);
    const user = (data && data.user) || (data && data.session && data.session.user);
    return satt(user);
  }

  async function loggaUt() {
    if (!finns()) return status();
    await db().auth.signOut();
    return satt(null);
  }

  /* Kantfallet ur MOLN_PLAN §5.3: e-posten tillhör redan ett konto, så
     `updateUser` nekas. Vi översätter det till något en människa kan agera på
     i stället för att visa Supabases engelska råtext. */
  function fel(e) {
    const m = String((e && e.message) || e || "");
    if (/already been registered|already registered|already exists/i.test(m)) {
      const err = new Error(
        "E-posten hör redan till ett konto. Vill du logga in på det i stället? " +
        "Rundorna du spelat på den här telefonen ligger kvar lokalt.");
      err.taget = true;   // UI:t erbjuder inloggningsvägen på denna flagga
      return err;
    }
    if (/rate limit|too many/i.test(m)) {
      return new Error("För många försök. Vänta en minut och prova igen.");
    }
    if (/expired|invalid/i.test(m)) {
      return new Error("Koden stämde inte, eller har gått ut. Begär en ny.");
    }
    return new Error(m || "Något gick fel. Försök igen.");
  }

  function onAndrad(cb) { lyssnare.add(cb); return () => lyssnare.delete(cb); }

  /* ---------- profilen ---------- */

  /* Hela Spelprofil-strukturen som en jsonb-blobb. `spelprofil.js` äger formen;
     databasen lagrar och skyddar den (se supabase/profil.sql). */
  async function sparaProfil(profil) {
    if (!finns() || !profil) return false;
    await redo();
    if (!cache.uid) return false;
    const { error } = await db().from("profiles").upsert(
      { id: cache.uid, data: profil, updated_at: new Date().toISOString() });
    if (error) { varna("sparaProfil", error); return false; }
    return true;
  }

  async function hamtaProfil() {
    if (!finns()) return null;
    await redo();
    if (!cache.uid) return null;
    const { data, error } = await db().from("profiles")
      .select("data, updated_at").eq("id", cache.uid).maybeSingle();
    if (error) { varna("hamtaProfil", error); return null; }
    return data ? { profil: data.data, updatedAt: data.updated_at } : null;
  }

  /* Senast skrivna vinner, och LOKALT vinner vid lika. Skälet är asymmetrin i
     vad ett fel kostar: en molnprofil som skriver över en nyss ändrad lokal
     profil raderar något spelaren just gjort, medan det omvända bara betyder
     att en synk får köras igen. `updatedAt` sätts av `Store.setProfile`. */
  async function synkaProfil() {
    if (!finns()) return { gjort: "inget" };
    const lokal = (typeof Store !== "undefined" && Store.profile) ? Store.profile() : null;
    const fjarr = await hamtaProfil();
    const tid = x => (x && x.updatedAt ? Date.parse(x.updatedAt) : 0);
    const tLokal = tid(lokal), tFjarr = fjarr ? Date.parse(fjarr.updatedAt) : 0;

    if (fjarr && tFjarr > tLokal) {
      if (typeof Store !== "undefined" && Store.setProfile) Store.setProfile(fjarr.profil);
      return { gjort: "hamtade" };
    }
    if (lokal && tLokal > 0) {
      const ok = await sparaProfil(lokal);
      return { gjort: ok ? "sparade" : "inget" };
    }
    return { gjort: "inget" };
  }

  function varna(var_, e) {
    try { console.warn("[Konto] " + var_ + ":", (e && e.message) || e); } catch (_) {}
  }

  return { redo, lasSession, status, uid: () => cache.uid, arGast: () => cache.gast,
           epost: () => cache.epost, skickaKod, verifiera, loggaUt, onAndrad,
           sparaProfil, hamtaProfil, synkaProfil, _fel: fel, _satt: satt,
           tillganglig: finns };
})();

if (typeof window !== "undefined") window.Konto = Konto;
if (typeof module !== "undefined" && module.exports) module.exports = Konto;
