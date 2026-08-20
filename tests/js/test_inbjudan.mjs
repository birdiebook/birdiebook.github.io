/* Test för inbjudan.js — molnvägen bakom "bjud in på namn".
 *
 * Körs med `node tests/js/test_inbjudan.mjs`. Samma hållning som
 * tests/js/test_spelformer.mjs: ren node, inga beroenden.
 *
 * Supabase-klienten STUBBAS, men modulen körs på riktigt (via vm). Det testet
 * faktiskt kontrollerar är därför de saker som går sönder tyst i produktion:
 * att jokrar escapas innan de når ilike, att koden normaliseras, att upserten
 * är idempotent — och framför allt ORDNINGEN i `svara`: går joinGame fel får
 * statusen inte skrivas, annars är inbjudan borta ur mottagarens hub utan att
 * hen är med någonstans.
 *
 * `const Inbjudan = …` blir ingen egenskap på vm-kontexten (lexikal binding),
 * därför läses modulen ur `ctx.window.Inbjudan` — samma väg som webbläsaren. */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const kalla = fs.readFileSync(new URL("../../inbjudan.js", import.meta.url), "utf8");

/* Minimal supabase-stub: spelar in vad klienten faktiskt skickar, så testet
   kontrollerar riktig Inbjudan-kod och inte en attrapp av den. */
function bygg(svar) {
  const logg = [];
  const kedja = (tabell) => {
    const st = { tabell, op: null, filter: {}, data: null, opts: null };
    const self = {
      select(){ return self; },
      eq(k,v){ st.filter[k]=v; return self; },
      ilike(k,v){ st.filter["ilike:"+k]=v; return self; },
      order(){ return self; },
      limit(n){ st.limit=n; return klar(); },
      maybeSingle(){ return klar(); },
      single(){ return klar(); },
      upsert(d,o){ st.op="upsert"; st.data=d; st.opts=o; return self; },
      update(d){ st.op="update"; st.data=d; return self; },
      insert(d){ st.op="insert"; st.data=d; return self; },
      delete(){ st.op="delete"; return self; },
      then(res, rej){ return klar().then(res, rej); },
    };
    function klar(){
      logg.push(JSON.parse(JSON.stringify(st)));
      const f = svar[st.tabell + ":" + (st.op || "select")];
      return Promise.resolve(f ? f(st) : { data: null, error: null });
    }
    return self;
  };
  return { logg, klient: { from: kedja, channel: () => ({ on(){return this;}, subscribe(){return this;} }), removeChannel(){} } };
}

function kor(svar, uid = "MITT-UID") {
  const { logg, klient } = bygg(svar);
  const joins = [];
  const ctx = {
    console,
    SGLive: {
      client: () => klient,
      initLive: async () => ({ uid }),
      joinGame: async (kod, namn) => { joins.push({ kod, namn }); return { gameId: "GID" }; },
    },
    Store: { profile: () => ({ namn: "Johannes" }) },
    // finns() kräver att supabase-js är laddat — stubbas här, klienten
    // kommer ändå ur SGLive.client().
    window: { supabase: { createClient: () => ({}) } },
  };
  vm.createContext(ctx);
  vm.runInContext(kalla, ctx);
  return { I: ctx.window.Inbjudan, logg, joins };
}

let fel = 0;
const test = async (namn, fn) => {
  try { await fn(); console.log("  ok   " + namn); }
  catch (e) { fel++; console.log("  FEL  " + namn + "\n       " + e.message); }
};

console.log("Inbjudan:");

await test("sok escapar jokrar och filtrerar bort mig själv", async () => {
  const { I, logg } = kor({
    "spelare_katalog:select": () => ({ data: [
      { uid: "MITT-UID", namn: "Johannes" },
      { uid: "U2", namn: "Anders" }], error: null }),
  });
  const r = await I.sok("100%_and");
  assert.equal(logg[0].filter["ilike:namn"], "%100\\%\\_and%", "jokrar måste escapas");
  assert.equal(r.map(x => x.uid).join(","), "U2", "jag själv ska bort ur träfflistan");
});

await test("sok gör inget anrop under minsta söklängd", async () => {
  const { I, logg } = kor({});
  assert.equal((await I.sok("a")).length, 0);
  assert.equal(logg.length, 0, "en bokstav ska aldrig nå servern");
});

await test("synkaMig skriver inte en tom rad", async () => {
  const { I, logg } = kor({});
  assert.equal(await I.synkaMig({ namn: "   " }), null);
  assert.equal(logg.length, 0);
});

await test("skicka bygger raden med kod, status och unik-nyckel", async () => {
  const { I, logg } = kor({
    "spel_inbjudan:upsert": () => ({ data: { id: "INB1", status: "vantar" }, error: null }),
  });
  const r = await I.skicka({ gameId: "GID", kod: "k4rt", tillUid: "U2",
                             namn: "Anders", franNamn: "Johannes", bana: "Burlöv" });
  assert.equal(r.ok, true);
  const rad = logg[0].data;
  assert.equal(rad.kod, "K4RT", "koden ska normaliseras till versaler");
  assert.equal(rad.fran_uid, "MITT-UID");
  assert.equal(rad.status, "vantar");
  assert.equal(logg[0].opts.onConflict, "game_id,till_uid", "upsert måste vara idempotent");
});

await test("skicka utan match ger ett fel i klartext, inget anrop", async () => {
  const { I, logg } = kor({});
  const r = await I.skicka({ tillUid: "U2", namn: "Anders" });
  assert.equal(r.ok, false);
  assert.match(r.fel, /match/i);
  assert.equal(logg.length, 0);
});

await test("svara(ja) går med FÖRE statusen skrivs", async () => {
  const { I, logg, joins } = kor({
    "spel_inbjudan:select": () => ({ data: { id: "INB1", game_id: "GID", kod: "K4RT",
                                             namn: "Anders A", bana: "Burlöv" }, error: null }),
    "spel_inbjudan:update": () => ({ data: null, error: null }),
  });
  const r = await I.svara("INB1", true);
  assert.equal(r.ok, true);
  assert.equal(r.gameId, "GID");
  assert.equal(joins.length, 1, "joinGame måste ha körts");
  assert.equal(joins[0].namn, "Johannes", "mitt eget namn ur profilen, inte värdens etikett");
  const iUpd = logg.findIndex(l => l.op === "update");
  assert.ok(iUpd > 0, "statusen skrivs efter uppslaget");
  assert.equal(logg[iUpd].data.status, "med");
});

await test("svara(ja) som inte kan gå med lämnar inbjudan orörd", async () => {
  const { I, logg } = kor({
    "spel_inbjudan:select": () => ({ data: { id: "INB1", game_id: "GID", kod: "K4RT", namn: "A" }, error: null }),
  }, "MITT-UID");
  // joinGame kastar
  const kalla2 = kalla;
  const { klient, logg: l2 } = bygg({
    "spel_inbjudan:select": () => ({ data: { id: "INB1", game_id: "GID", kod: "K4RT", namn: "A" }, error: null }),
  });
  const ctx = { console, window: { supabase: { createClient: () => ({}) } },
    Store: { profile: () => ({ namn: "J" }) },
    SGLive: { client: () => klient, initLive: async () => ({ uid: "U" }),
              joinGame: async () => { throw new Error("nät"); } } };
  vm.createContext(ctx); vm.runInContext(kalla2, ctx);
  const r = await ctx.window.Inbjudan.svara("INB1", true);
  assert.equal(r.ok, false);
  assert.ok(!l2.some(x => x.op === "update"), "status får INTE skrivas när join misslyckats");
});

await test("svara(nej) markerar avböjd utan att gå med", async () => {
  const { I, logg, joins } = kor({
    "spel_inbjudan:select": () => ({ data: { id: "INB1", game_id: "GID", kod: "K4RT", namn: "A" }, error: null }),
    "spel_inbjudan:update": () => ({ data: null, error: null }),
  });
  const r = await I.svara("INB1", false);
  assert.equal(r.ok, true);
  assert.equal(joins.length, 0);
  assert.equal(logg.find(l => l.op === "update").data.status, "avbojd");
});

await test("mina hämtar bara obesvarade till mig", async () => {
  const { I, logg } = kor({ "spel_inbjudan:select": () => ({ data: [], error: null }) });
  await I.mina();
  assert.equal(logg[0].filter.till_uid, "MITT-UID");
  assert.equal(logg[0].filter.status, "vantar");
});

await test("serverfel ger tom lista, aldrig ett kast", async () => {
  const { I } = kor({ "spelare_katalog:select": () => ({ data: null, error: { message: "tabell saknas" } }) });
  assert.equal((await I.sok("Anders")).length, 0);
});

console.log(fel ? `\n${fel} test misslyckades` : "\nalla test gröna");
process.exit(fel ? 1 : 0);
