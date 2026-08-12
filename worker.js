/* WORKER — `POST /rundor`: ta emot en spelad runda (MOLN_PLAN.md §6 V2).
 *
 * Samma Cloudflare-projekt som appens statiska filer (`birdiebook`): en deploy,
 * en domän. `wrangler.jsonc` pekar ut denna fil som `main` och listar `/rundor`
 * i `assets.run_worker_first` — allt annat fortsätter servas ur assets-katalogen
 * utan att koden här ens vaknar.
 *
 * ==========================================================================
 * ALGORITMEN ÄR ES256, INTE HS256 — mätt, inte antaget (2026-08-05)
 * ==========================================================================
 * MOLN_PLAN skrevs på antagandet att Supabase signerar med HS256 mot projektets
 * delade JWT-secret. Det stämmer inte för det här projektet. Projektets JWKS,
 *
 *   GET https://pcwzxjbuydyuxufpzaxl.supabase.co/auth/v1/.well-known/jwks.json
 *
 * svarar 200 med EN nyckel: `{"alg":"ES256","kty":"EC","crv":"P-256", ...}`.
 * Det är den asymmetriska nyckelmodellen, vilket också är varför `live.js` bär
 * en nyckel i det NYA formatet (`sb_publishable_…`) och inte en legacy-anon-JWT.
 * Det finns alltså ingen delad hemlighet att verifiera emot, och en HS256-
 * verifierare hade avvisat varenda äkta token.
 *
 * ==========================================================================
 * ALGORITMFAMILJEN VÄLJS AV KONFIGURATIONEN, ALDRIG AV TOKENEN
 * ==========================================================================
 * Detta är modulens viktigaste rad, och skälet står i angreppet den stänger:
 *
 *   `alg: none`      — signaturen hoppas över helt. Klassikern.
 *   ALGORITMFÖRVIRRING — angriparen tar den PUBLIKA ES256-nyckeln (den ligger
 *     ju öppet i JWKS:en), byter `alg` till `HS256` och HMAC:ar tokenen med den
 *     publika nyckeln som hemlighet. En verifierare som läser `alg` ur headern
 *     och sedan "slår upp nyckeln" verifierar då glatt en token angriparen
 *     själv skrivit — med vilket `sub` som helst.
 *
 * Därför: `TILLATNA_ALG` är en konstant i koden. Headerns `alg` får bara
 * BEKRÄFTA den, aldrig välja den. `kid` får peka ut VILKEN nyckel inom den
 * redan låsta familjen — inget mer. Ingen HS-gren finns i filen att förvirra
 * sig till; det är avsiktligt att den saknas snarare än är avstängd.
 *
 * ==========================================================================
 * TVÅ OBEROENDE SPÄRRAR MOT SAMMA FRÅGA: "VEMS DATA ÄR DETTA?"
 * ==========================================================================
 * 1. Workern verifierar tokenen själv och tar uid:t ur `sub`. R2 har ingen RLS,
 *    så nyckeln `rounds/{uid}/{round_id}.json` MÅSTE byggas av det uid:t.
 * 2. Indexraden skrivs mot PostgREST med ANVÄNDARENS EGEN token i
 *    Authorization — inte med någon service_role-nyckel. Postgres verifierar
 *    alltså samma token en gång till, och `rounds_index`-policyn
 *    (`supabase/rundor.sql`) kräver `auth.uid() = uid`.
 *
 * Poängen med (2) är att de inte KAN divergera: skulle uid-utvinningen här ha
 * en bugg avvisar Postgres raden i stället för att lita på oss. En
 * service_role-nyckel i Workern hade tagit bort just den kontrollen — och lagt
 * en nyckel som kringgår all RLS på edgen. Den finns därför inte här.
 *
 * INGEN TYST GÄST-FALLBACK. En trasig, manipulerad eller saknad token ger 401
 * och ingenting skrivs. Att falla tillbaka på "någon anonym identitet" hade
 * gjort felet osynligt: rundor hade landat, bara hos fel ägare.
 */
"use strict";

/* Låst algoritmfamilj. Se filhuvudet — detta är inte en defaultinställning som
   får överridas av en miljövariabel, för då hade den kunnat sättas fel en gång
   och ingen märkt något förrän någon utnyttjade det. */
const TILLATNA_ALG = new Set(["ES256"]);

const JWKS_TTL_MS = 10 * 60 * 1000;   // normal omhämtning
const JWKS_SPARR_MS = 30 * 1000;      // min tid mellan hämtningar vid okänt kid
const KLOCKGLAPP_S = 60;              // telefonklockor går isär; 60 s är rundligt
const MAX_KROPP = 2 * 1024 * 1024;    // en runda är ~20 kB — 2 MB är redan absurt
/* Punkt är MEDVETET inte tillåten. Läsvägen (`lasRoundIdFranPath`) avvisar `.`
   för att `rounds/{uid}/{id}.json` annars går att peka om till en sha-suffixad
   nyckel som inte är ens egen. Tillät skrivvägen punkt kunde den alltså skapa
   en runda som läsvägen aldrig kan hämta hem — tyst, och först synligt när en
   tom telefon saknar just den rundan. Skrivaren smalnas hellre än läsaren
   vidgas. */
const ROUND_ID_MONSTER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/* ---------------------------------------------------------------- fel-typer */

/* AuthFel → 401 med en kort, fast text. `skal` loggas ALDRIG tillbaka till
   klienten: "fel signatur" och "utgången" är samma svar utåt, för skillnaden
   är bara användbar för den som petar på låset. */
class AuthFel extends Error {
  constructor(skal) { super(skal); this.name = "AuthFel"; this.skal = skal; }
}
/* KlientFel → 400. Här ÄR detaljen nyttig: det är användarens egen data som är
   trasig, och hen kan inte göra något åt "400". */
class KlientFel extends Error {
  constructor(text, status = 400) { super(text); this.name = "KlientFel"; this.status = status; }
}

/* ------------------------------------------------------------- base64url */

function b64urlTillBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new AuthFel("ogiltig base64url");
  }
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  let bin;
  try { bin = atob(b64); } catch (_) { throw new AuthFel("ogiltig base64url"); }
  const ut = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) ut[i] = bin.charCodeAt(i);
  return ut;
}

function b64urlTillJson(s) {
  let text;
  try { text = new TextDecoder().decode(b64urlTillBytes(s)); }
  catch (e) { if (e instanceof AuthFel) throw e; throw new AuthFel("ogiltig segment-kodning"); }
  let v;
  try { v = JSON.parse(text); } catch (_) { throw new AuthFel("ogiltig JSON i token"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AuthFel("token-segment är inte ett objekt");
  return v;
}

/* -------------------------------------------------------------- JWKS-cache */

/* Modulglobal och avsiktligt så: en Worker-isolat lever över många requests,
   och ett JWKS-anrop per runda hade varit en onödig latens och ett onödigt
   beroende. Nyckeln är JWKS-URL:en så att en felkonfigurerad SUPABASE_URL inte
   kan återanvända en cache som hämtats från en annan. */
const jwksCache = new Map();

function cacheFor(url) {
  let c = jwksCache.get(url);
  if (!c) { c = { nycklar: new Map(), hamtad: 0, pagaende: null }; jwksCache.set(url, c); }
  return c;
}

async function hamtaJwks(url, c) {
  /* Samlar samtidiga anrop på EN hämtning. Utan detta skickar en burst av
     rundor lika många JWKS-requests, vilket är både onödigt och en väg att
     använda oss som förstärkare mot Supabase. */
  if (c.pagaende) return c.pagaende;
  c.pagaende = (async () => {
    let svar;
    try { svar = await fetch(url, { headers: { accept: "application/json" } }); }
    catch (_) { throw new AuthFel("nådde inte JWKS"); }
    if (!svar.ok) throw new AuthFel("JWKS svarade " + svar.status);

    let doc;
    try { doc = await svar.json(); } catch (_) { throw new AuthFel("JWKS är inte JSON"); }
    if (!doc || !Array.isArray(doc.keys)) throw new AuthFel("JWKS saknar keys");

    const nya = new Map();
    for (const jwk of doc.keys) {
      /* Bara nycklar i den låsta familjen importeras över huvud taget. Skulle
         Supabase en dag lägga en HS- eller RS-nyckel i samma dokument blir den
         alltså inte plötsligt användbar här — familjebytet ska vara ett
         medvetet kodbyte, inte något som sker av sig självt. */
      if (!jwk || !TILLATNA_ALG.has(jwk.alg) || jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
      if (jwk.use && jwk.use !== "sig") continue;
      if (typeof jwk.kid !== "string" || !jwk.kid) continue;
      try {
        nya.set(jwk.kid, {
          alg: jwk.alg,
          key: await crypto.subtle.importKey(
            "jwk",
            { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          ),
        });
      } catch (_) { /* en trasig nyckel diskvalificerar inte de andra */ }
    }
    if (nya.size === 0) throw new AuthFel("JWKS innehöll ingen användbar nyckel");
    c.nycklar = nya;
    c.hamtad = Date.now();
    return nya;
  })().finally(() => { c.pagaende = null; });
  return c.pagaende;
}

/* Nyckelrotation utan omstart: ett okänt `kid` får utlösa EN omhämtning, men
   högst var 30:e sekund. Utan den spärren blir "skicka token med slumpmässigt
   kid" en gratis väg att få oss att hamra Supabases JWKS-endpoint. */
async function nyckelFor(url, kid) {
  const c = cacheFor(url);
  const farsk = Date.now() - c.hamtad < JWKS_TTL_MS;
  if (!farsk || c.nycklar.size === 0) await hamtaJwks(url, c);
  let n = c.nycklar.get(kid);
  if (!n && Date.now() - c.hamtad >= JWKS_SPARR_MS) { await hamtaJwks(url, c); n = c.nycklar.get(kid); }
  if (!n) throw new AuthFel("okänt kid");
  return n;
}

/* --------------------------------------------------------- JWT-verifiering */

/* Returnerar de verifierade claimsen. Kastar AuthFel vid ALLT annat.
   Ordningen är avsiktlig: form → algoritm → SIGNATUR → claims. Inget ur
   payloaden läses innan signaturen har hållit, för en overifierad payload är
   ren indata från angriparen. */
export async function verifieraToken(token, env) {
  if (typeof token !== "string" || token.length === 0) throw new AuthFel("ingen token");
  if (token.length > 8192) throw new AuthFel("token är orimligt lång");

  const delar = token.split(".");
  /* Exakt tre. En JWE har fem segment och är inte en signerad token alls; en
     tvådelad "token" är en osignerad JWT. Båda ska falla här. */
  if (delar.length !== 3) throw new AuthFel("token har inte tre segment");
  const [h64, p64, s64] = delar;
  if (!h64 || !p64 || !s64) throw new AuthFel("tomt token-segment");

  const header = b64urlTillJson(h64);

  /* `alg` får BEKRÄFTA den låsta familjen, inte välja den. `alg: "none"` faller
     här tillsammans med HS256, RS256 och allt annat. */
  if (!TILLATNA_ALG.has(header.alg)) throw new AuthFel("otillåten alg: " + String(header.alg));
  if (header.typ != null && String(header.typ).toUpperCase() !== "JWT") throw new AuthFel("fel typ");
  /* `crit` betyder "du MÅSTE förstå dessa tillägg". Vi förstår inga. */
  if (header.crit != null) throw new AuthFel("crit stöds inte");
  if (typeof header.kid !== "string" || !header.kid) throw new AuthFel("saknar kid");

  const jwksUrl = jwksUrlFor(env);
  const nyckel = await nyckelFor(jwksUrl, header.kid);
  if (nyckel.alg !== header.alg) throw new AuthFel("kid tillhör en annan alg");

  const signatur = b64urlTillBytes(s64);
  /* ES256:s JWS-signatur är råa r‖s, 32 + 32 byte — precis formatet WebCrypto
     vill ha. En DER-kodad signatur (som OpenSSL ger) är alltså INTE giltig här,
     och ska inte vara det. */
  if (signatur.length !== 64) throw new AuthFel("fel signaturlängd");

  const data = new TextEncoder().encode(h64 + "." + p64);
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, nyckel.key, signatur, data);
  } catch (_) { ok = false; }
  if (!ok) throw new AuthFel("signaturen stämmer inte");

  /* ---- först HÄR är payloaden något annat än angriparens indata ---- */
  const claims = b64urlTillJson(p64);
  const nu = Math.floor(Date.now() / 1000);

  /* `exp` är OBLIGATORISK. Saknas den är tokenen evig, och en läckt token blir
     en permanent nyckel till kontot. Supabase sätter den alltid; en token utan
     den är inte en vi ska befatta oss med. */
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new AuthFel("saknar exp");
  if (nu >= claims.exp + KLOCKGLAPP_S) throw new AuthFel("token har gått ut");

  if (claims.iat != null) {
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) throw new AuthFel("ogiltig iat");
    if (claims.iat > nu + KLOCKGLAPP_S) throw new AuthFel("iat ligger i framtiden");
  }
  if (claims.nbf != null) {
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) throw new AuthFel("ogiltig nbf");
    if (nu + KLOCKGLAPP_S < claims.nbf) throw new AuthFel("token gäller inte än");
  }

  /* `iss` binder tokenen till VÅRT Supabase-projekt. Utan den kontrollen
     duger en token från vilket Supabase-projekt som helst — och vem som helst
     kan skapa ett eget projekt på en minut och signera sig själv ett `sub`. */
  const vantadIss = supabaseUrl(env) + "/auth/v1";
  if (claims.iss !== vantadIss) throw new AuthFel("fel iss");

  /* `aud` och `role` skiljer en riktig användarsession från t.ex. en
     service-token. Gäster ÄR `authenticated` — anonyma sessioner har riktiga
     uid — så gästvägen omfattas av exakt samma kontroll. */
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes("authenticated")) throw new AuthFel("fel aud");
  if (claims.role !== "authenticated") throw new AuthFel("fel role");

  /* `sub` ÄR identiteten. Att kräva UUID-formen är inte kosmetika: uid:t går
     rakt in i en R2-nyckel, och ett `sub` som "../../annan" hade annars kunnat
     peka utanför sin egen mapp. */
  if (typeof claims.sub !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub)) {
    throw new AuthFel("sub är inte ett uid");
  }

  return claims;
}

/* ------------------------------------------------------------------- miljö */

function supabaseUrl(env) {
  const u = (env && env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new Error("SUPABASE_URL saknas eller är ogiltig");
  return u;
}
const jwksUrlFor = (env) => supabaseUrl(env) + "/auth/v1/.well-known/jwks.json";

/* ------------------------------------------------------------------ övrigt */

const enc = new TextEncoder();

async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const svar = (kropp, status, extra) =>
  new Response(JSON.stringify(kropp), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

function corsHuvuden(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const tillatna = (env.TILLATNA_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  /* Ingen lista konfigurerad = ingen CORS. Appen ligger på SAMMA origin som
     Workern (samma Cloudflare-projekt), så normalfallet behöver inget här —
     listan finns för lokal utveckling och för en framtida egen domän. */
  if (!tillatna.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

/* -------------------------------------------------------- kropp → indexrad */

/* ALLT utom uid är användarens egen uppgift om sin egen runda — den får ljuga
   om sin score utan att det angår någon annan. uid är det enda fältet som inte
   får komma härifrån, och det gör det inte heller: se `hanteraRunda`. */
function lasKuvert(kuvert) {
  if (!kuvert || typeof kuvert !== "object" || Array.isArray(kuvert)) {
    throw new KlientFel("Kroppen måste vara ett JSON-objekt.");
  }
  const payload = kuvert.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new KlientFel("Fältet 'payload' saknas eller är inte ett objekt.");
  }
  return payload;
}

/* Samma princip som `_upload_source_id` i src/api/app.py, inte samma kod (den
   är Python och kör inte i en Worker): ett STABILT id ur rundans startpunkt, så
   att ett dubbelskick ger samma id och därmed en rad och en blobb. `player`
   ingår inte längre — identiteten är uid:t, och det ligger redan i R2-nyckeln
   och i primärnyckeln. */
async function rundId(kuvert, payload) {
  if (kuvert.round_id != null) {
    const r = String(kuvert.round_id);
    if (!ROUND_ID_MONSTER.test(r)) throw new KlientFel("Ogiltigt round_id.");
    return r;
  }
  const start = payload.started_at;
  if (typeof start !== "string" || !start) {
    throw new KlientFel("Rundan saknar både 'round_id' och 'payload.started_at'.");
  }
  return "m" + (await sha256hex(start)).slice(0, 24);
}

/* ------------------------------------------------------------- huvudflödet */

async function hanteraRunda(request, env) {
  const auth = request.headers.get("Authorization") || "";
  /* Bara "Bearer <token>", skiftlägesokänsligt på schemat. Ingen token i
     query-parameter stöds — den hade hamnat i varje access-logg på vägen. */
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (!m) throw new AuthFel("ingen Bearer-header");

  const claims = await verifieraToken(m[1], env);

  /* EN utvinning, EN variabel. Både R2-nyckeln och indexraden nedan använder
     exakt denna — det finns ingen andra väg in för ett uid, och därmed inget
     ställe där de två kan börja peka på olika personer. */
  const uid = claims.sub;

  if (request.headers.get("content-length") &&
      Number(request.headers.get("content-length")) > MAX_KROPP) {
    throw new KlientFel("Rundan är för stor.", 413);
  }
  const rawtext = await request.text();
  if (rawtext.length > MAX_KROPP) throw new KlientFel("Rundan är för stor.", 413);

  let kuvert;
  try { kuvert = JSON.parse(rawtext); } catch (_) { throw new KlientFel("Kroppen är inte giltig JSON."); }
  const payload = lasKuvert(kuvert);
  const round_id = await rundId(kuvert, payload);
  const blobb = JSON.stringify({
    payload,
    client: kuvert.client && typeof kuvert.client === "object" ? kuvert.client : {},
    uploaded_at: new Date().toISOString(),
  });
  const sha = await sha256hex(JSON.stringify(payload));

  /* ---- 1. blobben till R2 ----
     Nyckeln byggs av det VERIFIERADE uid:t och ett round_id som passerat
     ROUND_ID_MONSTER. Inget av det kommer från en header eller ett fält
     klienten kan välja fritt. */
  const basnyckel = `rounds/${uid}/${round_id}.json`;
  let nyckel = basnyckel;
  const fanns = await env.RUNDOR.head(basnyckel);
  if (fanns) {
    const gammalSha = fanns.customMetadata && fanns.customMetadata.sha256;
    /* "Aldrig överskrivning på plats" (§2). Samma innehåll → gör ingenting alls,
       det är dubbelskicket. Ändrat innehåll → ny nyckel, och indexraden pekas
       om nedan; originalet står kvar orört. */
    if (gammalSha !== sha) nyckel = `rounds/${uid}/${round_id}.${sha.slice(0, 12)}.json`;
  }
  if (!fanns || nyckel !== basnyckel) {
    const finnsRedan = nyckel === basnyckel ? null : await env.RUNDOR.head(nyckel);
    if (!finnsRedan) {
      await env.RUNDOR.put(nyckel, blobb, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { sha256: sha, uid },
      });
    }
  }

  /* ---- 2. indexraden till Postgres ----
     Med ANVÄNDARENS token, inte service_role: Postgres verifierar samma token
     en gång till och `p_rounds_index_own` kräver `auth.uid() = uid`. Skulle
     uid:t ovan vara fel avvisas raden här — det är den andra spärren, och
     skälet till att den här funktionen aldrig får en nyckel som kringgår RLS. */
  const rad = {
    uid,
    round_id,
    started_at: typeof payload.started_at === "string" ? payload.started_at : null,
    course: typeof payload.course === "string" ? payload.course : null,
    loop: payload.loop == null ? null : String(payload.loop),
    total_score: Number.isFinite(payload.total_score) ? payload.total_score : null,
    total_sg: Number.isFinite(payload.total_sg_tee_to_green) ? payload.total_sg_tee_to_green : null,
    blob_key: nyckel,
    blob_sha: sha,
    app_version: kuvert.client && typeof kuvert.client.app_version === "string"
      ? kuvert.client.app_version : null,
    uploaded_at: new Date().toISOString(),
  };

  const rest = await fetch(supabaseUrl(env) + "/rest/v1/rounds_index", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY || "",
      Authorization: request.headers.get("Authorization"),
      /* Upsert på (uid, round_id) → dubbelskick ger EN rad. */
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([rad]),
  });

  if (!rest.ok) {
    /* Blobben ligger redan i R2. Det är avsiktligt den ordningen: en blobb utan
       indexrad är osynlig men ofarlig, och nästa försök städar upp den av sig
       självt (samma nyckel, samma sha → no-op). Omvänd ordning hade gett en
       indexrad som pekar på ingenting, vilket bryter läsvägen i V4.
       PostgREST-texten skickas INTE vidare till klienten — den kan innehålla
       schemadetaljer — men statuskoden skiljer på "din data" och "vårt fel". */
    if (rest.status === 401 || rest.status === 403) throw new AuthFel("Postgres avvisade tokenen");
    throw new Error("indexraden avvisades: " + rest.status);
  }

  return svar({ ok: true, round_id, blob_key: nyckel }, 200);
}

/* --------------------------------------------------------- GET /rundor/{id} */

/* Läsvägen (MOLN_PLAN.md §6 V4a). Hinken `birdiebook-rundor` har MEDVETET
 * ingen publik läsning, så Workern är enda vägen in — precis som skrivvägen
 * ovan, och med SAMMA JWT-verifiering.
 *
 * NYCKELN BYGGS AV UID UR TOKENEN + round_id UR SÖKVÄGEN. Klienten kan aldrig
 * skicka en `blob_key` — den finns inte i den här routen över huvud taget.
 * Skulle den göra det (t.ex. via en curl) vore det en läs-vem-som-helsts-
 * runda-knapp: `rounds/{uid}/{round_id}.json` är gissningsbar för den som
 * känner ett uid, vilket är exakt varför hinken är privat.
 *
 * round_id AVVISAS om den bär `/`, `.` eller `%` — INNAN den sätts ihop till
 * en nyckel. Utan det tar `..%2f` eller ett bokstavligt `.` sig ur den egna
 * uid-prefixen (`../{annans-uid}/x` eller en sha-suffixad nyckel som inte är
 * ens egen). Kontrollen körs på det AVKODADE segmentet, så en dubbelkodad
 * `%252f` inte smiter förbi. */
function lasRoundIdFranPath(rawSegment) {
  let round_id;
  try { round_id = decodeURIComponent(rawSegment); }
  catch (_) { throw new KlientFel("Ogiltigt round_id.", 400); }
  if (!round_id || round_id.length > 200 || /[\/.%]/.test(round_id)) {
    throw new KlientFel("Ogiltigt round_id.", 400);
  }
  return round_id;
}

async function hamtaRunda(request, env, rawSegment) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (!m) throw new AuthFel("ingen Bearer-header");
  const claims = await verifieraToken(m[1], env);
  const uid = claims.sub;

  const round_id = lasRoundIdFranPath(rawSegment);

  /* SENASTE versionen, inte basnyckeln. Skrivvägen skriver ALDRIG över en
     blobb på plats: ändras innehållet för samma round_id hamnar den nya
     versionen på `rounds/{uid}/{round_id}.{sha12}.json` och indexraden pekas
     om dit (§2, "aldrig överskrivning på plats"). Läste vi bara basnyckeln
     skulle en runda som rättats och skickats om hydreras som sin FÖRSTA
     version — tyst, och just i det läge V4a finns för: en tom telefon som
     hämtar hem allt. Det är precis flödet §6 V4a beskriver med "ändras den
     lokalt vinner den lokala versionen och laddas upp igen med samma
     round_id".

     Prefixet byggs av det VERIFIERADE uid:t, så listningen kan aldrig nå
     någon annans rundor — och klienten skickar fortfarande ingen nyckel. */
  const prefix = `rounds/${uid}/${round_id}.`;
  const lista = await env.RUNDOR.list({ prefix });
  let senast = null;
  for (const o of (lista && lista.objects) || []) {
    if (!o || !o.key) continue;
    if (!senast || new Date(o.uploaded || 0) >= new Date(senast.uploaded || 0)) senast = o;
  }

  /* Finns ingen blobb under DENNA uids prefix — vare sig rundan aldrig
     funnits eller den hör till någon annan — är svaret samma 404. Att skilja
     "din runda finns inte" från "det där är någon annans runda" hade läckt
     information om vilka round_id som är upptagna. */
  if (!senast) throw new KlientFel("Rundan hittades inte.", 404);

  const obj = await env.RUNDOR.get(senast.key);
  if (!obj) throw new KlientFel("Rundan hittades inte.", 404);

  const text = await obj.text();
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------------- entré */

export default {
  async fetch(request, env, ctx) {
    const cors = corsHuvuden(request, env);
    const url = new URL(request.url);

    const hamtaMatch = /^\/rundor\/([^/]+)$/.exec(url.pathname);

    try {
      if (url.pathname === "/rundor") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        if (request.method !== "POST") {
          return svar({ fel: "Använd POST." }, 405, { ...cors, allow: "POST, OPTIONS" });
        }
        const r = await hanteraRunda(request, env);
        for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
        return r;
      }

      if (hamtaMatch) {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        if (request.method !== "GET") {
          return svar({ fel: "Använd GET." }, 405, { ...cors, allow: "GET, OPTIONS" });
        }
        const r = await hamtaRunda(request, env, hamtaMatch[1]);
        for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
        return r;
      }

      /* `run_worker_first` ska bara skicka hit `/rundor` och `/rundor/{id}`.
         Kommer något annat hit är konfigurationen fel — säg det i stället för
         att gissa. */
      return svar({ fel: "Okänd väg." }, 404, cors);
    } catch (e) {
      if (e instanceof AuthFel) {
        /* EN text för alla auth-fel. Skälet står i AuthFel: skillnaden mellan
           "utgången" och "fel signatur" hjälper bara den som petar. Ingen
           gäst-fallback, ingen 500, ingen stacktrace. */
        return svar({ fel: "Sessionen gäller inte." }, 401,
                    { ...cors, "www-authenticate": 'Bearer realm="rundor"' });
      }
      if (e instanceof KlientFel) return svar({ fel: e.message }, e.status, cors);
      /* Allt annat är VÅRT fel. Meddelandet stannar i Workerns logg (som bara
         vi ser); klienten får en tom fras utan stacktrace, sökväg eller
         bindningsnamn. */
      try { console.error("[rundor] " + (e && e.stack || e)); } catch (_) {}
      return svar({ fel: "Något gick fel hos oss. Försök igen." }, 500, cors);
    }
  },
};
