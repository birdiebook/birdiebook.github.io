"use strict";
/* FÖRSLAGET — planens svar på ETT hål, färdigt att rita (SPELPLAN_PLAN §SP3/§SP4).
 *
 * `strategi.js` är motorn: den rangordnar kandidater mot den skeppade värdeytan
 * och svarar med tal. Den här modulen är lagret mellan motorn och hålvyn — den
 * vet vilken fil ytan ligger i, vilka delar som får cachas, vilken gren hålet
 * hör till, vilka punkter som ska ritas och VAD SOM FÅR SKRIVAS UT.
 *
 * Den sista punkten är inte kosmetik. §3.3 mätte att en vindfri yta felar
 * 0,04–0,23 slag på NIVÅN men ≤ 0,069 på SKILLNADEN mellan alternativ. Därför
 * får planen skriva "3-wood kostar 0,2 slag här" och får INTE skriva "förväntad
 * score 4,23" — och därför byggs texten här av BITAR med källa i motorns svar
 * (`bitar` nedan), inte av en mall som råkar innehålla siffror. Ett tal utan
 * motsvarighet i motorns svar ska inte gå att skriva av misstag; det är grinden
 * från GP3, flyttad till JS-sidan (SP5 ärver den).
 *
 * TYSTNAD ÄR ETT SVAR, och det vanligaste (§5.2). Ett hål där inget alternativ
 * klarar grinden får en rad om siktet — ingen analys.
 *
 * REN och importfri som `strategi.js`, `planslag.js` och `vylage.js`: ingen DOM,
 * ingen Store, inget globalt fetch. Hämtningen injiceras (`hamta`) och baslinjen
 * skickas in, så `node tests/js/test_forslag.mjs` kan köra hela modulen utan
 * nät — vilket är samma egenskap appen behöver på banan.
 */
const Forslag = (() => {
  const V_MODUL = 1;

  /* Ytans plats. EN källa: service-workern cachar exakt det här mönstret
     (`sw.js` fick sin rad i SP1), och en URL som byggs på två ställen är en
     fil som ligger i cachen under ett namn ingen frågar efter. */
  function url(slug, komb) {
    return `data/strategi/${slug}/${komb.drive}_${komb.approach}_${komb.baseline}.json`;
  }

  /* ---- Vad som får skrivas ut (§5.3) ------------------------------------
     Reglerna bor på MODULNIVÅ och inte inuti `skapa`, för de gäller varje text
     som byggs ur ett svar — hålvyns remsa OCH dokumentets rader (`planrunda.js`,
     SP5). Skulle dokumentet ha en egen uppsättning ord vore det två grindar,
     och den ena skulle förfalla. */

  /* Slag med EN decimal. Andra decimalen ligger under metodens eget fel och
     är därför inte ett tal utan en illusion av precision. */
  const slagText = (x) => Math.abs(x).toFixed(1).replace(".", ",");
  /* Andelar i steg om 5 procentenheter: standardfelet är ~1,8 pp vid n=800,
     så "49,0 %" är brus utskrivet som kunskap. */
  const andelText = (p) => `${Math.round(p / 5) * 5} %`;

  /* Texten byggs av BITAR av tre slag, och grinden är att ordna dem:
       ord()  ren prosa — får aldrig innehålla en siffra
       tal()  ett tal MED KÄLLA i motorns svar
       namn() ett värde ur svaret som råkar bära siffror (klubbnamn som
              "3-wood (modell)") — också med källa
     Delningen finns för att `tests/js/test_forslag.mjs` ska kunna kräva att
     VARJE siffra i den färdiga strängen kommer ur svaret. Utan `namn` hade
     trean i "3-wood" sett ut som ett påstående, och grinden hade antingen
     larmat falskt eller (värre) mjukats upp tills den slutade betyda något.

     `avrundning` är renderingens tillåtna avvikelse från källan (0,05 slag för
     en decimal, 2,5 pp för femstegen). Utan den kan grinden bara se ATT talet
     har en källa, inte att renderingen håller sig till den — och då är
     "fara 60 %" ur ett svar som säger 12 % ett fel ingen mäter. */
  const ord = (text) => ({ text });
  const tal = (varde, text, kalla, avrundning) => ({
    tal: varde, text, kalla,
    avrundning: avrundning == null ? 0.05 : avrundning });
  const namn = (text, kalla) => ({ text, kalla, namn: true });
  const bygg = (bitar) => bitar.map(b => b.text).join("");

  /* En andel som bit: femstegen är renderingen, råtalet är källan. */
  const andel = (p, kalla) => tal(p, andelText(p), kalla, 2.5);

  /* Siktet uttrycks som en PUNKT i bilden; texten kompletterar med hur långt
     åt sidan den ligger. Ordningen är avsiktlig — "30 m höger om hål-linjen"
     som ENDA form är förbjuden (§5.3), för hål-linjen syns inte från teen. */
  function siktbit(offset) {
    if (!offset) return [ord(" rakt på hål-linjen")];
    return [ord(" "), tal(Math.abs(offset), String(Math.abs(offset)),
                          "rekommenderad.offset_m", 0.5),
            ord(` m ${offset > 0 ? "höger" : "vänster"} om hål-linjen`)];
  }

  function teeText(b) {
    const bitar = [ord("Slå "), namn(b.rekommenderad.shot, "rekommenderad.shot"),
                   ord(" mot punkten —")]
      .concat(siktbit(b.rekommenderad.offset_m));
    if (!b.harBeslut) {
      // Tystnad: ingen analys, bara det som ändå gäller.
      bitar.push(ord("."));
      return bitar;
    }
    // Alternativet i SAMMA mening, så namnet aldrig behöver inledas med stor
    // bokstav — ett klubbnamn som skrivs om är inte längre motorns svar.
    bitar.push(ord("; "), namn(b.alternativ.shot, "alternativ.shot"),
               ord(" kostar "), tal(b.gap, slagText(b.gap), "gap"),
               ord(" slag här."));
    return bitar;
  }

  /* Inspelets sikte, uttryckt kring PINNEN. `pre` är sökvägen till inspelet i
     det svar bitarna hör till: hålvyns remsa läser `inspel.rekommenderad.*`,
     och dokumentets inspelsrad läser samma väg — grinden följer sökvägen, så
     den måste vara den anroparen faktiskt kan slå upp. */
  function siktePinBitar(r, pre) {
    const bitar = [];
    if (r.aim_along) {
      bitar.push(tal(Math.abs(r.aim_along), String(Math.abs(r.aim_along)),
                     pre + ".aim_along", 0.5),
                 ord(` m ${r.aim_along > 0 ? "förbi" : "kort om"} pinnen`));
    } else {
      bitar.push(ord("pinnens djup"));
    }
    if (r.aim_across) {
      bitar.push(ord(", "),
                 tal(Math.abs(r.aim_across), String(Math.abs(r.aim_across)),
                     pre + ".aim_across", 0.5),
                 ord(` m ${r.aim_across > 0 ? "höger" : "vänster"}`));
    }
    return bitar;
  }

  function inspelText(insp) {
    const bitar = [ord("Sikta mot punkten — ")]
      .concat(siktePinBitar(insp.rekommenderad, "inspel.rekommenderad"));
    bitar.push(ord("."));
    return bitar;
  }

  /* Vad förslaget är räknat FÖR. Bor här och inte i vyn: hålvyns remsa och
     dokumentets rad (SP5) ska säga exakt samma sak om samma svar — en
     formulering på två ställen glider isär, och den här är ett påstående om
     hur talen ska läsas. `streck` injiceras (Kompass) så modulen förblir
     importfri. */
  function villkorstext(f, opt) {
    const o = opt || {};
    const streck = o.streck
      || (typeof Kompass !== "undefined" ? Kompass.streck : (d => Math.round(d) + "°"));
    const v = (f && f.forutsattningar) || {};
    const delar = [`tee ${v.tee || "bakre"}`];
    delar.push(v.vind ? `vind ${Math.round(v.vind.ms)} m/s ${streck(v.vind.dir)}`
                      : "vindstilla");
    delar.push(v.pin === "flyttad" ? "din pin" : "bandatans pin");
    // Saknas höjdprofilen SÄGS det — ett förslag räknat platt på ett kuperat hål
    // ser precis lika säkert ut som ett räknat med backen.
    if (!v.hojd) delar.push("utan höjd");
    return "Räknat för " + delar.join(" · ");
  }

  /* Detaljerna bakom ett tryck (§SP3: "alternativet nås bakom ett tryck").
     Andelar rundas till 5 procentenheter — de är det svepet MÄTT, och
     precisionen är standardfelets, inte formateringens. */
  function detaljer(f) {
    if (!f) return [];
    const rad = (k, etikett) => ({
      etikett, klubba: k.shot,
      sikte: k.offset_m,
      fairway: andelText(k.fairway_pct), fara: andelText(k.hazard_pct),
    });
    const ut = [];
    if (f.rekommenderad) ut.push(rad(f.rekommenderad, "Planens linje"));
    if (f.alternativ) {
      ut.push({ ...rad(f.alternativ, "Alternativet"),
                kostar: f.gap == null ? null : slagText(f.gap) });
    }
    if (f.inspel) {
      ut.push({ etikett: "Inspelet", klubba: null, sikte: null,
                green: andelText(f.inspel.rekommenderad.green_pct),
                fara: andelText(f.inspel.rekommenderad.hazard_pct),
                bucket: f.inspel.bucket });
    }
    return ut;
  }

  function skapa(opt) {
    const o = opt || {};
    const S = o.strategi || (typeof Strategi !== "undefined" ? Strategi : null);
    if (!S) throw new Error("Forslag kräver Strategi");
    let yta = null;                       // laddad + validerad värdeyta
    let slugNu = null;
    const raster = new Map();             // "loop|hål" → Int8Array (lie-koder)
    const wCache = new Map();             // "loop|hål|pin" → Float64Array

    /* Rastret beror BARA på hålets polygoner — inte på vind, tee eller pin.
       Det är hela skälet att ett nytt förslag går på millisekunder: det dyra
       (23–36 ms) görs en gång per hål, det billiga (svepet, 17–22 ms) varje
       gång något ändras. */
    function koderFor(hal, bandataHal) {
      const nyckel = hal.loop + "|" + hal.hole;
      if (!raster.has(nyckel)) raster.set(nyckel, S.rastrera(hal, bandataHal, yta.koder));
      return raster.get(nyckel);
    }

    function wFor(hal, koder, baslinje, pinXy, pinNyckel) {
      const nyckel = hal.loop + "|" + hal.hole + "|" + pinNyckel;
      if (!wCache.has(nyckel)) {
        wCache.set(nyckel, S.wRaster(yta, hal, koder, baslinje, pinXy));
      }
      return wCache.get(nyckel);
    }

    /* Ytan hämtas EN gång per bana × profilkombination. Misslyckas den lever
       appen vidare utan förslag — planen är en hjälp, inte en förutsättning
       för att kunna spela hålet. Att svälja felet tyst vore däremot fel: den
       som frågar får `null` OCH ett skäl i `senasteFel`. */
    let senasteFel = null;
    async function ladda(arg) {
      const a = arg || {};
      const u = url(a.slug, a.kombination);
      if (yta && slugNu === u) return yta;
      const hamta = a.hamta || (typeof fetch === "function"
        ? (adress => fetch(adress).then(r => (r.ok ? r.json() : null))) : null);
      if (!hamta) { senasteFel = "ingen hämtare"; return null; }
      let json = null;
      try { json = await hamta(u); } catch (e) { senasteFel = e.message; return null; }
      if (!json) { senasteFel = "ytan saknas för " + u; return null; }
      try { yta = S.laddaYta(json, a.planVersion); } catch (e) {
        // En yta räknad med en annan modell är inte lite fel — den är ett
        // annat svar. Hellre inget förslag än ett från fel modell.
        yta = null; senasteFel = e.message; return null;
      }
      slugNu = u; senasteFel = null;
      raster.clear(); wCache.clear();
      return yta;
    }

    const laddad = () => !!yta;
    const felet = () => senasteFel;
    const halPost = (loop, nr) => (yta ? yta.hamta(loop, nr) : null);

    /* ---- Förslaget för ETT hål ----------------------------------------- */

    /* `indata`:
     *   loop, hole      hålets identitet i ytan
     *   bandataHal      hålets post i banbunten (polygonerna — SP0)
     *   tee             [lat, lon] spelarens tee (null = ytans egen, baktee)
     *   teeNamn         etikett att skriva i förutsättningsraden
     *   pin             [lat, lon] dagens pin (null = bandatans, som ytan är byggd kring)
     *   vind            {ms, dir} eller null
     *   baslinje        (lie, dist) → förväntade slag
     *   dh, dhGreen     höjduppslag (SP4) eller null
     *   n               sampel per kandidat
     */
    function forHal(indata) {
      const d = indata || {};
      const hal = halPost(d.loop, d.hole);
      if (!hal || typeof d.baslinje !== "function") return null;
      const t0 = (typeof performance !== "undefined") ? performance.now() : 0;
      const koder = koderFor(hal, d.bandataHal);
      const pin = d.pin || null;
      const pinXy = pin ? S.xy(pin[0], pin[1], hal.pin[0], hal.pin[1]) : [0, 0];
      const pinNyckel = pin ? pin[0].toFixed(6) + "," + pin[1].toFixed(6) : "bandata";
      // Vad grenarna räknar MED (funktioner och sampelantal) hålls isär från
      // vad de svarar. Baslinjen är en funktion och har inget i ett svar att
      // göra — ett svar ska gå att spara, jämföra och logga (SP7).
      const gemensamt = { vind: d.vind || null, baslinje: d.baslinje, n: d.n };
      const identitet = { loop: d.loop, hole: d.hole, par: hal.par,
                          vind: d.vind || null };

      let ut;
      if (hal.V) {
        ut = franTee(hal, koder, d, gemensamt, pin, pinXy, pinNyckel);
      } else {
        // Par 3 och hål inom inspelsavstånd: planeraren bygger ingen värdeyta,
        // för utslaget ÄR inspelet. Samma gren som `plan_hole` tar.
        ut = tillGreen(hal, koder, d, gemensamt, pin, pinXy, pinNyckel);
      }
      if (!ut) return null;
      Object.assign(ut, identitet);
      ut.forutsattningar = {
        tee: d.teeNamn || null,
        vind: d.vind && d.vind.ms ? { ms: d.vind.ms, dir: d.vind.dir } : null,
        pin: pin ? "flyttad" : "bandatans",
        hojd: !!(d.dh || d.dhGreen),
      };
      ut.ms = ((typeof performance !== "undefined") ? performance.now() : 0) - t0;
      return ut;
    }

    function lageVid(hal, koder, ll) {
      const [e, n] = S.xy(ll[0], ll[1], hal.pin[0], hal.pin[1]);
      const r = hal.lie;
      const ix = Math.min(r.nx - 1, Math.max(0, Math.trunc((e - r.x0) / r.step)));
      const iy = Math.min(r.ny - 1, Math.max(0, Math.trunc((n - r.y0) / r.step)));
      return yta.konstanter.lies[koder[iy * r.nx + ix]];
    }

    function franTee(hal, koder, d, gem, pin, pinXy, pinNyckel) {
      const kandidater = S.svep(yta, hal, koder, {
        vind: gem.vind, baslinje: gem.baslinje, n: gem.n,
        tee: d.tee || null, dh: d.dh || null,
      });
      const b = S.beslut(kandidater);
      if (!b) return null;
      const land = b.rekommenderad.land_latlon;
      // Inspelet räknas från MEDELLANDNINGEN, i det läge den hamnar i — samma
      // kedja som `plan_hole` bygger. Ligger den längre bort än inspelsbandet
      // är nästa slag en layup, och den frågan hör till SP6 ("vad nu?").
      const kvar = Math.hypot(...S.xy(land[0], land[1], pin ? pin[0] : hal.pin[0],
                                      pin ? pin[1] : hal.pin[1]));
      let insp = null;
      if (kvar <= yta.inspel.max_m) {
        insp = S.inspel(yta, hal, koder, {
          fran: land, lie: lageVid(hal, koder, land), baslinje: gem.baslinje,
          vind: gem.vind, n: gem.n, pin, dhGreen: d.dhGreen || null,
          W: wFor(hal, koder, gem.baslinje, pinXy, pinNyckel),
        });
      }
      return {
        gren: "tee",
        rekommenderad: b.rekommenderad, alternativ: b.alternativ,
        gap: b.gap, harBeslut: b.harBeslut, golv: b.golv,
        inspel: insp,
        // Kedjan spelaren kan ta emot: landningen. Inspelets sikte är ett MÅL
        // och inte en landning — läggs det som punkt blir greenen en
        // mellanstation (samma regel som planvy:s `planSikte` följer).
        punkter: [land],
        sikte: insp ? insp.rekommenderad.aim_latlon : null,
        bitar: teeText(b),
      };
    }

    function tillGreen(hal, koder, d, gem, pin, pinXy, pinNyckel) {
      const fran = d.tee || hal.tee;
      const insp = S.inspel(yta, hal, koder, {
        fran, lie: "tee", baslinje: gem.baslinje, vind: gem.vind, n: gem.n,
        pin, dhGreen: d.dhGreen || null,
        W: wFor(hal, koder, gem.baslinje, pinXy, pinNyckel),
      });
      if (!insp) return null;
      return {
        gren: "inspel",
        rekommenderad: null, alternativ: null, gap: null, harBeslut: false,
        inspel: insp,
        // Ett par 3 har ingen kedja att ta emot: siktet ÄR slaget. Punkten
        // ritas, men den skrivs inte som landningspunkt — det hade gjort
        // greenen till en mellanstation.
        punkter: [],
        sikte: insp.rekommenderad.aim_latlon,
        bitar: inspelText(insp),
      };
    }

    return {
      V: V_MODUL, ladda, laddad, felet, ytan: () => yta, halPost,
      forHal, detaljer, url,
      text: f => (f ? bygg(f.bitar) : ""),
      slagText, andelText,
      nollstall: () => { raster.clear(); wCache.clear(); },
    };
  }

  /* Ordreglerna är MODULENS, inte instansens: dokumentet (`planrunda.js`) bygger
     sina rader ur samma bitar och faller därmed under samma grind. */
  return { skapa, url, V: V_MODUL,
           ord, tal, namn, bygg, andel, slagText, andelText,
           siktbit, siktePinBitar, teeText, inspelText, detaljer, villkorstext };
})();

if (typeof window !== "undefined") window.Forslag = Forslag;
else if (typeof globalThis !== "undefined") globalThis.Forslag = Forslag;
if (typeof module !== "undefined" && module.exports) module.exports = Forslag;
