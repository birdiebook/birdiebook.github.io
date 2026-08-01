/* spelprofil.js — spelarens profil som datastruktur (UPPGRADERING_3D §GP1).
 *
 * VARFÖR EN EGEN, REN MODUL: profilen ska bli EN sanning om spelaren, och den
 * sanningen läses snart av tre håll som i dag inte känner varandra —
 * spelformerna (course handicap), strategimotorn (spridningen) och U17:s
 * spridningsreglage. Ligger reglerna i en sida-fil blir de kopierade i stället
 * för delade, och då är vi tillbaka i det problem GP1 löste: två ställen som
 * säger olika om samma spelare.
 *
 * Modulen är därför REN: inga sidoeffekter, ingen Store, ingen localStorage,
 * ingen DOM. Den definierar hinkarna, vet vad de betyder i tal, och kan läsa
 * en gammal localStorage-profil. Persistensen bor i store.js, som är enda
 * stället som skriver.
 *
 * HINKARNA ÄR PRIORS, INTE SÄMRE TAL (§GP1). `11–15` är en fördelning över
 * handicap, inte ett påstående om 13. Därför bär varje hink både `mid` (det
 * bästa punktvärdet när något måste räknas NU) och `lo`/`hi` (bredden, som är
 * det M1:s shrinkage och GP1:s spridningsmappning behöver). Den som bara läser
 * `mid` kastar bort informationen — det är tillåtet, men ska vara ett val.
 *
 * OCH DE ÄR NÄMNBARA. Det är hinkarnas andra uppgift och den hårda
 * begränsningen bakom hela etappen: `data/plan_cache/` är förberäknad per
 * NAMNGIVEN profilkombination, så en spelare med en fritt flytande egen ellips
 * hade lämnat appen utan offline-plan ute på banan. En hink har ett namn; ett
 * tal har det inte.
 */
"use strict";

const Spelprofil = (() => {
  const V = 1;

  /* Hinkarna. `id` är det som sparas och som snart blir del av ett
     profilkombinations-namn — ändra ALDRIG ett id utan migrering, då tappar en
     sparad profil sitt svar. Etiketterna får ändras fritt. */
  const HCP = [
    { id: "scratch", label: "Scratch / 0–5", lo: 0, hi: 5, mid: 2.5 },
    { id: "6-10", label: "6–10", lo: 6, hi: 10, mid: 8 },
    { id: "11-15", label: "11–15", lo: 11, hi: 15, mid: 13 },
    { id: "16-20", label: "16–20", lo: 16, hi: 20, mid: 18 },
    { id: "21-25", label: "21–25", lo: 21, hi: 25, mid: 23 },
    { id: "26+", label: "26 eller mer", lo: 26, hi: 36, mid: 30 },
    // Utvägen. Den är inte "inget svar" — den är ett svar som betyder "räkna
    // med en bred prior", och den MÅSTE räcka för att generera en plan (§GP1).
    { id: "vet-inte", label: "Vet inte", lo: 0, hi: 36, mid: 18 },
  ];

  const DRIVER = [
    { id: "u180", label: "Under 180 m", lo: 140, hi: 180, mid: 165 },
    { id: "180-210", label: "180–210 m", lo: 180, hi: 210, mid: 195 },
    { id: "210-240", label: "210–240 m", lo: 210, hi: 240, mid: 225 },
    { id: "240-270", label: "240–270 m", lo: 240, hi: 270, mid: 255 },
    { id: "270+", label: "270 m eller mer", lo: 270, hi: 300, mid: 280 },
    { id: "ingen-driver", label: "Slår inte driver", lo: null, hi: null, mid: null },
  ];

  const JARN7 = [
    { id: "u110", label: "Under 110 m", lo: 85, hi: 110, mid: 100 },
    { id: "110-130", label: "110–130 m", lo: 110, hi: 130, mid: 120 },
    { id: "130-150", label: "130–150 m", lo: 130, hi: 150, mid: 140 },
    { id: "150-170", label: "150–170 m", lo: 150, hi: 170, mid: 160 },
    { id: "170+", label: "170 m eller mer", lo: 170, hi: 195, mid: 180 },
    { id: "vet-inte", label: "Vet inte", lo: 85, hi: 195, mid: 140 },
  ];

  /* Missen bär ETT TECKEN på across_bias (+ = höger om linjen) och en styrka.
     Den mappningen är GP1 del 3:s jobb att kalibrera; här står bara riktningen,
     för den är en egenskap hos missen och inte hos modellen. `null` = missen
     är inte en sidomiss (tunn/fet/kort/ojämn), och då ska ingen bias sättas. */
  const MISS = [
    { id: "slice", label: "Slice / höger", sida: +1 },
    { id: "hook", label: "Hook / vänster", sida: -1 },
    { id: "push", label: "Push (rakt höger)", sida: +1 },
    { id: "pull", label: "Pull (rakt vänster)", sida: -1 },
    { id: "tunn", label: "Tunn", sida: null },
    { id: "fet", label: "Fet", sida: null },
    { id: "kort", label: "Kort", sida: null },
    { id: "ojamn", label: "Ojämn — ingen tydlig miss", sida: null },
  ];

  const SVAGHET = [
    { id: "driver", label: "Driver" },
    { id: "langa-jarn", label: "Långa järn / hybrider" },
    { id: "inspel", label: "Inspel" },
    { id: "wedgar", label: "Wedgar" },
    { id: "bunkrar", label: "Bunkrar" },
    { id: "putt", label: "Putt" },
    { id: "strategi", label: "Banstrategi" },
  ];

  /* Spelstilen är REDAN byggd i motorn (M2: Säker = argmin CVaR₁₀,
     Aggressiv = argmax P(birdie+) med tak). Profilen väljer bara vilken —
     id:na är plannerns egna, så inget behöver översättas på vägen. */
  const STIL = [
    { id: "safe", label: "Säker" },
    { id: "balanced", label: "Balanserad" },
    { id: "aggressive", label: "Aggressiv" },
  ];

  /* Tee som PREFERENS, inte som teenamn. "61" betyder ingenting på en annan
     bana, och regeln "aldrig hårdkoda banan" ([[APPSTORE_PLAN]] §11) gäller
     profilen med. Vilken faktisk tee det blir slås upp per bana ur
     banregistrets `tees` — bak = längst, fram = kortast. */
  const TEE = [
    { id: "bak", label: "Bak" },
    { id: "mitten", label: "Mitten" },
    { id: "fram", label: "Fram" },
  ];

  const HINKAR = { hcp: HCP, driver: DRIVER, jarn7: JARN7 };

  const hink = (grupp, id) => (HINKAR[grupp] || []).find(b => b.id === id) || null;
  const finns = (lista, id) => lista.some(x => x.id === id);

  /* Ett handicap ur vad som helst — EN gång, för både inmatning och migrering.
     Decimalkomma är svenskt tangentbord, inte skräp: utan `replace` gör
     parseFloat("12,4") tyst om det till 12, alltså ett FEL handicap som ser
     inmatat ut och som netto sedan räknas på. Samma grepp som `addPlayer` i
     sallskap.html redan använder för medspelare. Låg det på två ställen skulle
     de kunna glida isär, och då gäller felet bara ibland. */
  function hcpTal(v) {
    const x = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    return isFinite(x) ? Math.round(x * 10) / 10 : null;
  }

  /* Tom profil: allt obesvarat. Att den går att skapa utan ett enda svar är
     inte bekvämlighet — det är kravet att guiden ska kunna avbrytas. */
  function tom() {
    return {
      v: V,
      namn: "",
      kon: null,          // "herr" | "dam" — behövs för rating-uppslag, inte för spridning
      hcpBucket: null,
      hcpExact: null,     // frivilligt (Avancerad). Se hcpForBerakning.
      driver: null,
      jarn7: null,
      miss: null,
      svaghet: null,
      stil: null,
      tee: null,
      updatedAt: null,
    };
  }

  /* Sanering: okända id:n tystas till null i stället för att bäras vidare.
     En profil som bär ett id ingen känner igen är värre än en tom — den ser
     besvarad ut. Rena fält (namn, tee) trimmas bara. */
  function normalisera(p) {
    // Bara KÄNDA fält överlever. Object.assign hade burit med sig allt som råkar
    // ligga i objektet — t.ex. `id`, som är store.js lagringsnyckel och inte en
    // egenskap hos spelaren. Samma skäl som att okända värden tystas: det som
    // ingen känner igen ska inte kunna resa vidare och se meningsfullt ut.
    const src = p || {}, o = tom();
    for (const k of Object.keys(o)) if (src[k] !== undefined) o[k] = src[k];
    o.v = V;
    o.namn = String(o.namn || "").trim();
    o.kon = o.kon === "herr" || o.kon === "dam" ? o.kon : null;
    o.hcpBucket = finns(HCP, o.hcpBucket) ? o.hcpBucket : null;
    o.driver = finns(DRIVER, o.driver) ? o.driver : null;
    o.jarn7 = finns(JARN7, o.jarn7) ? o.jarn7 : null;
    o.miss = finns(MISS, o.miss) ? o.miss : null;
    o.svaghet = finns(SVAGHET, o.svaghet) ? o.svaghet : null;
    o.stil = finns(STIL, o.stil) ? o.stil : null;
    o.tee = finns(TEE, o.tee) ? o.tee : null;
    o.hcpExact = hcpTal(o.hcpExact);
    return o;
  }

  /* Handicap för en UTRÄKNING (course handicap i spelformerna).
   *
   * Det exakta talet vinner när det finns; annars hinkens mitt. Men svaret bär
   * ALLTID `kalla`, och det är hela poängen med funktionen: en course handicap
   * härledd ur "11–15" får inte se lika säker ut som en inmatad 12,4. Anropare
   * som inte visar skillnaden ljuger med rätt siffra.
   *
   * `vet-inte` ger `null` och inte 18: en spelare som svarat "vet inte" har
   * inte påstått att hen är 18, och netto-uträkningen ska säga att den saknar
   * underlag i stället för att hitta på ett. Spridningen får däremot använda
   * hinkens bredd — där är "vet inte" ett användbart svar, för en bred prior
   * är fortfarande en prior.
   */
  function hcpForBerakning(p) {
    const o = normalisera(p);
    if (o.hcpExact != null) return { value: o.hcpExact, kalla: "exakt" };
    if (!o.hcpBucket || o.hcpBucket === "vet-inte") return { value: null, kalla: "saknas" };
    return { value: hink("hcp", o.hcpBucket).mid, kalla: "hink" };
  }

  /* Vilken hink rymmer ett exakt handicap? Används av migreringen och av
     Avancerad: skriver spelaren 12,4 ska hinken följa med, annars kan de två
     fälten börja säga olika om samma spelare. */
  function bucketForHcp(v) {
    const x = hcpTal(v);
    if (x == null) return null;
    for (const b of HCP) {
      if (b.id === "vet-inte") continue;
      if (x >= b.lo && x <= b.hi) return b.id;
    }
    return x < 0 ? "scratch" : "26+";
  }

  /* Migrering från AS4:s localStorage (`sg_hcp`, `sg_kon`). Rör inte nycklarna
     — den som skriver dem är store.js, och den raderar dem inte heller (samma
     säkerhetsnät som §9.1.10 punkt 5 gav rundorna). Ett exakt hcp som redan
     finns BEHÅLLS: spelaren har skrivit det, och att kasta det för en hink
     vore att göra profilen sämre än det den ersätter. */
  function franLegacy(hcpRaw, konRaw) {
    const p = tom();
    const v = hcpTal(hcpRaw);
    if (v != null) { p.hcpExact = v; p.hcpBucket = bucketForHcp(v); }
    if (konRaw === "herr" || konRaw === "dam") p.kon = konRaw;
    return normalisera(p);
  }

  /* ---- Profilens NAMN: sju svar → en cache-nyckel (GP1 del 3) ------------
     SPEGEL av `src/api/player_profile.py`; `tests/test_gp1_paritet.py` kör båda
     över ALLA kombinationer och kräver identiska strängar. Den bor här och inte
     bara i Python för att telefonen måste kunna räkna fram sitt eget namn UTAN
     NÄT — det är hela poängen med att planen är förberäknad och namngiven.
     Koderna är frusna: ändrar en av dem hittar appen aldrig igen den plan som
     redan ligger i cachen. */
  const HCP_BAS = {
    "scratch": "hcp2", "6-10": "hcp8", "11-15": "hcp13",
    "16-20": "hcp18", "21-25": "hcp23", "26+": "hcp30", "vet-inte": "hcpokand",
  };
  // "ingen-driver" har med avsikt ingen kod — se player_profile.py.
  const DRIVER_KOD = {
    "u180": "u180", "180-210": "180t210", "210-240": "210t240",
    "240-270": "240t270", "270+": "270p",
  };
  const MISS_SIDA = { slice: +1, push: +1, hook: -1, pull: -1,
                      tunn: null, fet: null, kort: null, ojamn: null };
  const BASELINE = "scratch";

  function kombination(p) {
    const o = normalisera(p);
    // Obesvarat handicap är inte samma sak som "vet inte", men båda ska ge en
    // plan — och den breda priorn är det ärliga svaret på båda.
    const bas = HCP_BAS[o.hcpBucket] || HCP_BAS["vet-inte"];
    const delar = [bas];
    if (DRIVER_KOD[o.driver]) delar.push("d" + DRIVER_KOD[o.driver]);
    const sida = MISS_SIDA[o.miss];
    if (sida) delar.push(sida > 0 ? "mh" : "mv");
    return { drive: delar.join("-"),
             approach: bas + (sida ? "-" + delar[delar.length - 1] : ""),
             baseline: BASELINE };
  }

  /* ---- Spridningen i telefonen (GP1 del 3) -------------------------------
     Tabellen kommer FÄRDIGRÄKNAD ur Python (`mobile/data/dispersion.json`, byggd
     av tools/publish_mobile_dispersion.py). Modulen räknar alltså inte fram
     någon spridning själv — den slår upp. Skulle koefficienterna speglas hit i
     stället skulle appen kunna rita en ellips som planeraren aldrig räknat på,
     och det är precis den sortens skillnad ingen upptäcker.

     `satt()` matas av sidan när tabellen laddats; utan den svarar `spridning`
     null, och anroparen får säga att den saknas i stället för att gissa. */
  let TAB = null;
  function sattSpridning(tab) { TAB = tab || null; }

  /* Vilken avståndsbucket hör d meter hemma i? Kanterna kommer ur tabellen —
     de är Pythons `dispersion.EDGES`, inte en kopia som kan glida. */
  function bucketFor(d) {
    if (!TAB || !TAB.bucket_edges || !TAB.bucket_edges.length) return null;
    const e = TAB.bucket_edges;
    if (d < e[0]) return "<" + e[0];
    for (let i = 0; i < e.length - 1; i++) if (d < e[i + 1]) return e[i] + "–" + e[i + 1];
    return e[e.length - 1] + "+";
  }

  /* Spelarens förväntade spridning för ett slag på `dist` meter, i meter:
     `{cross, along, profil, bucket}` — eller null när profilen inte räcker.

     BARA basprofilen (hcp-hinken) används. Driverhinken beskriver utslaget och
     missen är en RIKTNING, inte en bredd; att blanda in dem här skulle göra
     talet svårare att förklara utan att göra det sannare. Ellipsen som ritas är
     alltså "så brett hamnar dina inspel på det här avståndet", vilket är exakt
     vad U17:s reglage frågar efter. */
  function spridning(profil, dist) {
    if (!TAB || !TAB.profiler) return null;
    const bas = HCP_BAS[normalisera(profil).hcpBucket];
    const prof = bas && TAB.profiler[bas];
    const b = bucketFor(dist);
    const rad = prof && b && prof.approach ? prof.approach[b] : null;
    if (!rad) return null;
    return { cross: rad.across_sd, along: rad.along_sd, profil: bas, bucket: b };
  }

  /* Har spelaren svarat på något alls? Guiden (GP1 del 2) använder det för att
     veta om den ska visas, och Profil-fliken för att skilja "ny" från "tom". */
  function harSvar(p) {
    const o = normalisera(p);
    return !!(o.namn || o.kon || o.hcpBucket || o.hcpExact != null || o.driver ||
              o.jarn7 || o.miss || o.svaghet || o.stil || o.tee);
  }

  return { V, HCP, DRIVER, JARN7, MISS, SVAGHET, STIL, TEE,
           tom, normalisera, hink, hcpTal, hcpForBerakning, bucketForHcp,
           franLegacy, harSvar, kombination, HCP_BAS, DRIVER_KOD, MISS_SIDA,
           sattSpridning, spridning, bucketFor };
})();

if (typeof globalThis !== "undefined") globalThis.Spelprofil = Spelprofil;
if (typeof module !== "undefined" && module.exports) module.exports = Spelprofil;
