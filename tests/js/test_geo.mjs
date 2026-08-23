/* Test för geo.js — strömmens LIVSLÄNGD, inte dess innehåll.
 *
 * Körs med `node tests/js/test_geo.mjs`. Ren node, inga beroenden, samma
 * hållning som tests/js/test_inbjudan.mjs: modulen körs på riktigt (via vm)
 * med en attrapp-källa under sig.
 *
 * Det som provas är precis det som gick sönder tyst i produktion: i
 * native-skalet är en watch en BAKGRUNDSSESSION som överlever webbvyn, så en
 * ström som ingen stänger fortsätter logga position utan runda och utan sida.
 * Provet nedan kontrollerar därför tre saker och inget mer:
 *
 *   1. stop() stänger det som start() öppnade (avslutad runda),
 *   2. sidbytet stänger både huvudströmmen och en collectFix-ström som var
 *      mitt i sitt fönster,
 *   3. en SLÄCKT SKÄRM stänger ingenting — det är hela poängen med N3, och
 *      den regressionen syns inte vid datorn utan först på banan.
 */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const kalla = fs.readFileSync(new URL("../../geo.js", import.meta.url), "utf8");

/* Attrapp-källa med `navigator.geolocation`s gränssnitt. Räknar öppna watchar
   — det är det enda talet hela testet handlar om. */
function bygg() {
  const oppna = new Map();
  let nasta = 1;
  return {
    oppna,
    kalla: {
      watchPosition(ok, fel) { const id = nasta++; oppna.set(id, { ok, fel }); return id; },
      clearWatch(id) { oppna.delete(id); },
      getCurrentPosition(ok) { ok({ coords: { latitude: 1, longitude: 2, accuracy: 5 } }); },
    },
  };
}

/* Laddar geo.js i en egen kontext med attrapper för window/document, och
   plockar ut de lyssnare modulen registrerar (det är genom dem sidbytet
   kommer i webbläsaren). */
function ladda() {
  const lyssnare = { window: {}, document: {} };
  const mk = mal => (namn, fn) => { (mal[namn] = mal[namn] || []).push(fn); };
  const ctx = {
    console,
    window: { addEventListener: mk(lyssnare.window) },
    document: { addEventListener: mk(lyssnare.document), hidden: false },
    navigator: {},
    module: { exports: {} },
  };
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(kalla + "\n;globalThis.__Geo = Geo;", ctx);
  const fyra = (mal, namn, ev) => (lyssnare[mal][namn] || []).forEach(fn => fn(ev));
  return { Geo: ctx.__Geo, ctx, fyra };
}

/* 1. Rundan tar slut → strömmen tar slut. */
{
  const { Geo } = ladda();
  const { oppna, kalla: g } = bygg();
  Geo._useSource(g);
  assert.equal(Geo.start(), true);
  assert.equal(oppna.size, 1, "start() ska öppna exakt en watch");
  assert.equal(Geo.start(), true);
  assert.equal(oppna.size, 1, "start() är idempotent — inte en watch per anrop");
  Geo.stop();
  assert.equal(oppna.size, 0, "stop() ska stänga huvudströmmen");
  assert.equal(Geo.igang(), false);
}

/* 2. Sidbytet städar allt — även slagets egen ström mitt i fönstret. */
{
  const { Geo, fyra } = ladda();
  const { oppna, kalla: g } = bygg();
  Geo._useSource(g);
  Geo.start();
  Geo.watch({ onFix() {} });                       // collectFix mitt i sina 5 s
  assert.equal(oppna.size, 2);
  fyra("window", "beforeunload", {});
  assert.equal(oppna.size, 0,
    "sidbytet ska inte lämna kvar någon watch — i skalet är den en bakgrundssession");
  assert.equal(Geo.igang(), false);
}

/* 2b. Tillbaka ur bfcachen: kontexten lever, strömmen ska starta om. */
{
  const { Geo, fyra } = ladda();
  const { oppna, kalla: g } = bygg();
  Geo._useSource(g);
  Geo.start();
  fyra("window", "beforeunload", {});
  fyra("window", "pageshow", { persisted: false });
  assert.equal(oppna.size, 0, "en vanlig sidladdning ska inte återuppliva strömmen");
  fyra("window", "pageshow", { persisted: true });
  assert.equal(oppna.size, 1, "bakåt ur bfcachen ska starta om strömmen");
}

/* 2c. En ström som anroparen redan stängt ska inte återupplivas av bakåtvägen. */
{
  const { Geo, fyra } = ladda();
  const { oppna, kalla: g } = bygg();
  Geo._useSource(g);
  Geo.start();
  Geo.stop();                                       // rundan avslutades
  fyra("window", "beforeunload", {});
  fyra("window", "pageshow", { persisted: true });
  assert.equal(oppna.size, 0, "avslutad runda ska förbli avslutad");
}

/* 3. Släckt skärm stryper takten — men stänger ingenting. */
{
  const { Geo, ctx, fyra } = ladda();
  const { oppna, kalla: g } = bygg();
  Geo._useSource(g);
  Geo._settBackgroundCapable(true);
  Geo.start();
  ctx.document.hidden = true;
  fyra("document", "visibilitychange", {});
  assert.equal(oppna.size, 1,
    "bakgrunden får ALDRIG stänga strömmen — det är det N3 finns för");
  assert.equal(Geo._takt(), Geo.TAKT.DOLD, "takten ska sänkas i stället");
  ctx.document.hidden = false;
  fyra("document", "visibilitychange", {});
  assert.equal(Geo._takt(), Geo.TAKT.SYNLIG);
  Geo._settBackgroundCapable(false);
}

console.log("geo: alla prov gröna");
