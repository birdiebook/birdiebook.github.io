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
     sidospel.js redan använder för medspelare. Låg det på två ställen skulle
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

  /* ---- Kombinationen som NAMN, och hur nära två namn ligger varandra -------
   *
   * Bakgrunden är en mätning, inte en smak: en bana har 126 möjliga
   * kombinationer och appen skeppar i dag EN (≈83 kB gzip styck —
   * [[SPELPLAN_PLAN]] §8.3). Alla utom den spelare ytan byggdes för fick
   * därför "Ingen plan är byggd för din spelprofil", vilket är sant och
   * oanvändbart. Grundarens beslut 2026-08-04: räkna hellre mot NÄRMASTE
   * skeppade profil och SÄG det i förutsättningsraden.
   *
   * Rangordningen bor här och inte i `forslag.js` av samma skäl som
   * `kombination` gör det: det är hinkarna som vet vilka profiler som ligger
   * nära varandra. `forslag.js` ska bara veta vilken fil den ska hämta.
   */
  const namnFor = (k) => `${k.drive}_${k.approach}_${k.baseline}`;

  // Hinkarnas mittpunkter under sina FRUSNA koder — härledda ur listorna ovan,
  // aldrig avskrivna. Byts en hinks mid följer avståndsmåttet med av sig självt.
  const HCP_MID = {};
  for (const b of HCP) HCP_MID[HCP_BAS[b.id]] = b.mid;
  const DRIVER_MID = {};
  for (const d of DRIVER) if (DRIVER_KOD[d.id]) DRIVER_MID[DRIVER_KOD[d.id]] = d.mid;

  /* Ett kombinationsnamn tillbaka till sina delar, eller null om det inte är
     ett namn den här koden har byggt. `drive` är `hcpX[-dKOD][-mh|-mv]`. */
  function tolkaKombination(namn) {
    const bitar = String(namn || "").split("_");
    if (bitar.length !== 3) return null;
    const [drive, approach, baseline] = bitar;
    const delar = drive.split("-");
    const bas = delar[0];
    if (HCP_MID[bas] == null) return null;
    let driver = null, sida = null;
    for (const d of delar.slice(1)) {
      if (d === "mh") sida = +1;
      else if (d === "mv") sida = -1;
      else if (d[0] === "d") driver = d.slice(1);
    }
    return { namn, drive, approach, baseline, bas, driver, sida };
  }

  /* Hur långt ifrån varandra två profiler ligger. Handicap dominerar med
     avsikt — det är den storhet ytan är byggd kring (spridningen per avstånd);
     driverlängden skalas till samma storleksordning (15 m ≈ ett slag i den här
     jämförelsen) och missens sida är ett steg. En annan BASLINJE är inte ett
     avstånd utan ett annat mått, och diskvalificerar. */
  function kombAvstand(a, b) {
    if (!a || !b || a.baseline !== b.baseline) return Infinity;
    let d = Math.abs(HCP_MID[a.bas] - HCP_MID[b.bas]);
    const da = DRIVER_MID[a.driver], db = DRIVER_MID[b.driver];
    // Utan driverhink gäller basprofilens längd, och den går inte att jämföra i
    // meter. Skillnaden kostar då en fast liten avgift i stället för ett
    // påhittat tal — samma princip som att `spridning` svarar null hellre än
    // gissar.
    d += (da != null && db != null) ? Math.abs(da - db) / 15
                                    : (a.driver === b.driver ? 0 : 1.5);
    if (a.sida !== b.sida) d += 2;
    return d;
  }

  /* Tillgängliga kombinationsnamn, ordnade efter hur nära de ligger den
     önskade. Det önskade namnet självt tas bort — anroparen har redan provat
     det. Lika avstånd bryts på namnet, så samma app alltid väljer samma yta
     (en plan som byter profil mellan två sidladdningar vore omöjlig att lita
     på). */
  function narmasteKombinationer(onskat, tillgangliga) {
    const mal = tolkaKombination(onskat);
    if (!mal) return [];
    return (tillgangliga || [])
      .filter(n => n && n !== onskat)
      .map(n => ({ n, d: kombAvstand(mal, tolkaKombination(n)) }))
      .filter(x => Number.isFinite(x.d))
      .sort((a, b) => (a.d - b.d) || (a.n < b.n ? -1 : 1))
      .map(x => x.n);
  }

  /* Kombinationen i klartext, för förutsättningsraden. "hcp8-d240t270-mv" är
     ett filnamn; spelaren ska läsa "hcp 8 · 240–270 m · miss vänster". */
  function kombinationsetikett(namn) {
    const k = tolkaKombination(namn);
    if (!k) return String(namn || "");
    const hcpId = Object.keys(HCP_BAS).find(id => HCP_BAS[id] === k.bas);
    const hcpH = hcpId && hink("hcp", hcpId);
    const delar = [hcpId === "vet-inte" ? "hcp okänt"
                   : hcpH ? `hcp ${hcpH.label.replace("Scratch / ", "")}` : k.bas];
    const drvId = Object.keys(DRIVER_KOD).find(id => DRIVER_KOD[id] === k.driver);
    const drv = drvId && hink("driver", drvId);
    if (drv) delar.push(drv.label.toLowerCase());
    if (k.sida) delar.push(k.sida > 0 ? "miss höger" : "miss vänster");
    return delar.join(" · ");
  }

  /* Har spelaren svarat på det PLANEN frågar efter?
   *
   * `harSvar` duger inte till den frågan och det gav en riktig återvändsgränd:
   * den är sann så fort ett NAMN finns, och namnet sätts när kontot skapas. En
   * spelare som bara hade sitt namn ifyllt fick därför "Ingen plan är byggd
   * för din spelprofil" — ett meddelande utan väg framåt — i stället för
   * "Planen behöver din spelprofil", som pekar på frågan som faktiskt saknar
   * svar. Ytan namnges av handicap, driverlängd och miss; det är de som räknas
   * här. "Vet inte" ÄR ett svar (§GP1) och räknas som ett. */
  function harPlanSvar(p) {
    const o = normalisera(p);
    return !!(o.hcpBucket || o.hcpExact != null || o.driver || o.miss);
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

  /* ---- Klubbtrappan (GP2) -------------------------------------------------
     "Vad slår du här?" kräver att en klubba har ett svar på hur långt och hur
     brett. Modellen ägs av `src/api/klubbtrappa.py` och dess KONSTANTER kommer
     med i `dispersion.json` (`klubbtrappa`-blocket) — trappans rader, de tre
     modifierarna, och basprofilernas inspelsmönster som en rät linje i
     avståndet.

     FORMELN räknas här och inte i Python, av samma skäl som `kombination`
     speglas: telefonen måste kunna svara UTAN NÄT, och en full uppräkning av
     alla kombinationer hade varit ~200 kB app-shell för något som är en formel
     med tolv rader indata. `tests/test_klubbtrappa_paritet.py` kör Python och
     den här koden över alla kombinationer och kräver identiska tal — repots
     etablerade sätt att ha samma logik på två språk utan att de glider isär.

     Utan tabell svarar allt null i stället för att gissa: en klubblängd appen
     hittat på är värre än ingen klubblista alls. */
  const KT = () => (TAB && TAB.klubbtrappa) || null;

  /* Spelarens två ankare i meter + varifrån de kom. Speglar `_ankare`. */
  function ankare(profil) {
    const k = KT();
    if (!k) return null;
    const o = normalisera(profil);
    const bas = k.hcp_bas[o.hcpBucket] || k.hcp_bas["vet-inte"];
    const prof = TAB.profiler && TAB.profiler[bas];
    if (!prof || !prof.drive) return null;
    const hink = k.driver_hink[o.driver];
    // "Slår inte driver" och obesvarat ger båda basprofilens längd — den säger
    // hur långt spelaren slår sitt längsta slag, vilket är vad trappan behöver.
    const D = hink ? (hink[0] + hink[1]) / 2 : prof.drive.dist_med;
    const j7 = k.jarn7_mid[o.jarn7];
    // Utan eget järnsvar hålls bagens PROPORTION (se klubbtrappa.py) — annars
    // fick en kortslående spelare en trappa utan steg.
    let S = j7 != null ? j7 : D * (k.referens.S0 / k.referens.D0);
    let kS = j7 != null ? "svar" : "profil";
    // Ankarna får motsäga varandra (två oberoende hinkfrågor) och gör då
    // trappan icke-monoton — se klubbtrappa.py. Klampa, och SÄG att det
    // gjordes: appen ska inte tyst rätta spelaren.
    const kvot = S / D;
    if (kvot > k.referens.KVOT_MAX) { S = D * k.referens.KVOT_MAX; kS = "justerad"; }
    else if (kvot < k.referens.KVOT_MIN) { S = D * k.referens.KVOT_MIN; kS = "justerad"; }
    return { D, S, bas, kalla: { driver: hink ? "svar" : "profil", jarn7: kS } };
  }

  /* EN avrundningsregel för både JS och Python: halvt BORT FRÅN NOLL.
     Varken språkets egen räcker — Pythons `round` är bankers-avrundning
     (−5,95 → −6,0), JS `Math.round` är halvt mot +∞ (−5,95 → −5,9). Samma
     formel gav alltså olika tal i sista decimalen, uppmätt på along_bias och
     across_bias. Speglar `klubbtrappa.rund`. */
  function avrunda(v, n) {
    const p = 10 ** n;
    return Math.floor(Math.abs(v) * p + 0.5) / p * (v >= 0 ? 1 : -1) + 0;
  }

  function langder(D, S) {
    const k = KT(), ut = {};
    for (const c of k.klubbor) {
      ut[c.id] = avrunda(c.L0 * (D / k.referens.D0) ** c.w
                                * (S / k.referens.S0) ** (1 - c.w), 1);
    }
    return ut;
  }

  /* Linjen utvärderad vid L, klampad utanför spannet — samma klampning som
     Python gör mot ytterbuckets. */
  function linjeVid(linje, L) {
    const x = Math.min(Math.max(L, linje.L_min), linje.L_max);
    return { along_bias: linje.along_bias[0] * x + linje.along_bias[1],
             along_sd: linje.along_sd[0] * x + linje.along_sd[1],
             across_sd: linje.across_sd[0] * x + linje.across_sd[1] };
  }

  /* Hela trappan för en profil: {ankare, klubbor:[{id,label,langd,…}]}. */
  function klubbtrappa(profil) {
    const k = KT(), a = ankare(profil);
    if (!k || !a) return null;
    const d = TAB.profiler[a.bas].drive;
    const linje = k.approach_linje[a.bas];
    if (!linje) return null;
    const L = langder(a.D, a.S);
    return {
      ankare: { driver: avrunda(a.D, 1), jarn7: avrunda(a.S, 1),
                kalla: a.kalla, bas: a.bas },
      klubbor: k.klubbor.map(c => {
        const v = linjeVid(linje, L[c.id]);
        return {
          id: c.id, label: c.label, langd: L[c.id],
          // Drive-mönstret har ingen along_bias — den tonas ut med w.
          along_bias: avrunda((1 - c.w) * v.along_bias, 1),
          along_sd: avrunda(c.w * d.dist_sd + (1 - c.w) * v.along_sd, 1),
          across_sd: avrunda(c.w * d.across_sd + (1 - c.w) * v.across_sd, 1),
        };
      }),
    };
  }

  /* Vilken klubba trappan föreslår för `dist` meter — panelens default.
     Närmast i LÄNGD, inte närmast uppåt (se klubbtrappa.py). */
  function valjKlubba(profil, dist) {
    const t = klubbtrappa(profil);
    if (!t || !(dist > 0)) return null;
    let b = null, bd = Infinity;
    for (const c of t.klubbor) {
      const d = Math.abs(c.langd - dist);
      if (d < bd) { bd = d; b = c.id; }
    }
    return b;
  }

  /* Trappans rad + de tre modifierarna → slagets faktiska tal.
     `apex` matas rakt in i SlagJust.apexFaktor: GP2 skriver ingen egen
     bollbanemodell, den skruvar på den som W-etapperna kalibrerade. */
  function applicera(rad, val) {
    const k = KT();
    if (!k || !rad) return null;
    const v = val || {};
    const f = k.form[v.form] || k.form.rakt;
    const a = k.ansats[v.ansats] || k.ansats.full;
    const h = k.hojd[v.hojd] || k.hojd.normal;
    const across = rad.across_sd * a.sigma;
    return {
      langd: avrunda(rad.langd * f.langd * a.langd * h.langd, 1),
      along_sd: avrunda(rad.along_sd * a.sigma, 1),
      across_sd: avrunda(across, 1),
      // Biasen räknas på den MODIFIERADE spridningen: en kontrollerad fade
      // kröker mindre än en full fade — det är hela poängen med att slå den.
      across_bias: avrunda(f.bias_andel * across, 1),
      apex: h.apex,
    };
  }

  /* Ett SLAG med GP2-val: trappans rad + modifierarna, i den form
     `Planslag.kedja` vill ha den ({cross, along, bias, apex, langd, …}).

     Klubban kommer ur valet när spelaren gjort ett, annars ur trappans förslag
     för avståndet. Att den ALLTID finns är avsiktligt: panelen ska kunna visa
     "Driver, full: 232 m, ±26 m sidled" innan spelaren rört något, så det
     aldrig är en svart låda (§GP2). */
  function slagFor(profil, dist, val) {
    const t = klubbtrappa(profil);
    if (!t) return null;
    const v = val || {};
    const kid = v.klubba || valjKlubba(profil, dist);
    const rad = t.klubbor.find(c => c.id === kid);
    if (!rad) return null;
    const a = applicera(rad, v);
    return { klubba: rad.id, label: rad.label, langd: a.langd,
             cross: a.across_sd, along: a.along_sd,
             bias: a.across_bias, apex: a.apex,
             // Räcker klubban till? En plan som tyst låter spelaren "slå"
             // 210 m med ett 8-järn är inte en plan.
             racker: !(dist > 0) || a.langd >= dist - a.along_sd,
             foreslagen: !v.klubba };
  }

  /* Valen panelen får erbjuda. Listorna kommer ur tabellen så ett alternativ
     aldrig kan stå i panelen utan att modellen känner det. */
  function valListor() {
    const k = KT();
    if (!k) return null;
    const lista = o => Object.entries(o).map(([id, v]) => ({ id, label: v.label }));
    return { form: lista(k.form), ansats: lista(k.ansats), hojd: lista(k.hojd) };
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
           franLegacy, harSvar, harPlanSvar, kombination,
           namnFor, tolkaKombination, kombAvstand, narmasteKombinationer,
           kombinationsetikett, HCP_BAS, DRIVER_KOD, MISS_SIDA,
           sattSpridning, spridning, bucketFor,
           klubbtrappa, valjKlubba, applicera, valListor, ankare, slagFor };
})();

if (typeof globalThis !== "undefined") globalThis.Spelprofil = Spelprofil;
if (typeof module !== "undefined" && module.exports) module.exports = Spelprofil;
