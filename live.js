"use strict";
/* Live-scoring-klient (LIVE_SCORING_SPEC.md §7).
 *
 * Kräver att @supabase/supabase-js är laddad FÖRE denna fil, t.ex.:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="./live.js"></script>
 *
 * Exponerar window.SGLive med:
 *   initLive()                                   -> { uid }   (säkrar anonym session)
 *   createGame({course, roundSeq, displayName?}) -> { gameId, code }
 *   joinGame(code, displayName)                  -> { gameId }
 *   pushHoleScore(gameId, hole, {strokes,putts,pen})
 *   subscribeLeaderboard(gameId, cb, {par}?)     -> unsubscribe()
 *   finishGame(gameId)
 *
 * Identitet = anonym Supabase-session (stabilt uid). Ingen inloggning, ingen
 * e-post. RLS Fas 1 (permissiv) — spelkoden är barriären. */
const SGLive = (() => {
  const URL = "https://pcwzxjbuydyuxufpzaxl.supabase.co";
  const KEY = "sb_publishable_w2Vfqc5zLUJ-VTP3ePTbcQ_sAaAGk6m"; // publishable → OK i frontend

  // spelkod: versaler+siffror utan lättförväxlade tecken (O/0, I/1, L)
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  // Diskret engångs-varning när molnet NEKAR en push (servern svarade fel — t.ex.
  // saknad tabell/policy, som gjorde att delad pin var helt tyst innan game_pins
  // fanns). Offline/nätverksfel förblir tysta (by design: score/pin finns kvar
  // lokalt och molnet hinner ikapp). Visas en gång per sidladdning som en liten
  // banner längst ner; console.warn alltid. Kallas från pusharnas .catch.
  let _warned = false;
  function liveWarn(where, e) {
    if (!e) return;
    const code = e.code || e.status || "";
    try { console.warn("[SGLive] " + where + " nekades:", code, e.message || e); } catch (_) {}
    // bara serversvar (kod/status) surfar; offline/nätverk = tyst
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!code || !online || _warned || typeof document === "undefined") return;
    _warned = true;
    try {
      const d = document.createElement("div");
      d.textContent = "Live-synk fel (" + code + ") — sparas lokalt. Tryck för att stänga.";
      d.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;"
        + "background:#b23b3b;color:#fff;font:13px/1.4 system-ui,sans-serif;"
        + "padding:8px 10px;border-radius:8px;box-shadow:0 2px 8px #0007;text-align:center";
      d.onclick = () => d.remove();
      document.body.appendChild(d);
      setTimeout(() => { if (d.parentNode) d.remove(); }, 8000);
    } catch (_) {}
  }

  let client = null;
  function db() {
    if (!client) {
      if (!window.supabase || !window.supabase.createClient) {
        throw new Error("supabase-js är inte laddat (lägg <script>-taggen före live.js).");
      }
      client = window.supabase.createClient(URL, KEY);
    }
    return client;
  }

  function genCode(len) {
    let s = "";
    for (let i = 0; i < (len || 4); i++) {
      s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return s;
  }

  // ── session ──────────────────────────────────────────────────────────
  async function initLive() {
    const c = db();
    let { data: { session } } = await c.auth.getSession();
    if (!session) {
      const { data, error } = await c.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    return { uid: session.user.id };
  }

  // ── match ────────────────────────────────────────────────────────────
  async function createGame(opts) {
    opts = opts || {};
    await initLive();
    const c = db();
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = genCode(4);
      const { data, error } = await c.from("games")
        .insert({ code, course: opts.course || null, round_seq: opts.roundSeq || null })
        .select("id, code").single();
      if (!error) {
        if (opts.displayName) await joinGame(code, opts.displayName);
        return { gameId: data.id, code: data.code };
      }
      if (error.code !== "23505") throw error; // 23505 = unik-krock → generera om
    }
    throw new Error("Kunde inte skapa en unik spelkod, försök igen.");
  }

  async function joinGame(code, displayName) {
    const { uid } = await initLive();
    const c = db();
    const { data: game, error: e1 } = await c.from("games")
      .select("id").eq("code", String(code).toUpperCase().trim()).maybeSingle();
    if (e1) throw e1;
    if (!game) throw new Error("Ingen match med den koden.");
    const { error: e2 } = await c.from("game_players")
      .upsert({ game_id: game.id, uid, display_name: displayName },
              { onConflict: "game_id,uid" });
    if (e2) throw e2;
    return { gameId: game.id };
  }

  async function pushHoleScore(gameId, hole, sc) {
    const { uid } = await initLive();
    const c = db();
    const { error } = await c.from("hole_scores").upsert({
      game_id: gameId, uid, hole,
      strokes: sc.strokes || 0, putts: sc.putts || 0, pen: sc.pen || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "game_id,uid,hole" });
    if (error) throw error;
  }

  async function finishGame(gameId) {
    const c = db();
    const { error } = await c.from("games").update({ status: "finished" }).eq("id", gameId);
    if (error) throw error;
  }

  // ── delad pin (PIN_SHARING_SPEC.md) ────────────────────────────────────
  // Pin per (game_id, hole=globalt hålnr). Last-write-wins via upsert. Alla i
  // matchen kan flytta (RLS Fas 1 permissiv, spelkod = barriär).
  async function pushPin(gameId, hole, p) {
    const { uid } = await initLive();
    const c = db();
    const { error } = await c.from("game_pins").upsert({
      game_id: gameId, uid, hole,
      lat: p.lat, lon: p.lon, acc: p.acc == null ? null : p.acc,
      updated_at: new Date().toISOString(),
    }, { onConflict: "game_id,hole" });
    if (error) throw error;
  }

  // Engångshämtning av matchens pins (samma karta som subscribePins ger, utan
  // realtidskanal). Används av mobilappen vid uppladdning för att väva in andras
  // markerade pins i den egna rundan (PIN_SHARING_SPEC: delad pin → allas analys).
  async function fetchPins(gameId) {
    const c = db();
    const { data, error } = await c.from("game_pins")
      .select("hole, lat, lon, acc").eq("game_id", gameId);
    if (error) throw error;
    const m = {};
    (data || []).forEach(r => { m[r.hole] = { lat: r.lat, lon: r.lon, acc: r.acc }; });
    return m;
  }

  // Prenumerera på matchens pins. cb får en karta { [globaltHålnr]: {lat,lon,acc} }.
  function subscribePins(gameId, cb) {
    const c = db();
    async function refresh() {
      const { data } = await c.from("game_pins")
        .select("hole, lat, lon, acc").eq("game_id", gameId);
      const m = {};
      (data || []).forEach(r => { m[r.hole] = { lat: r.lat, lon: r.lon, acc: r.acc }; });
      cb(m);
    }
    const ch = c.channel("pins:" + gameId)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "game_pins", filter: "game_id=eq." + gameId },
          refresh)
      .subscribe();
    refresh();   // första fyllning direkt
    return () => c.removeChannel(ch);
  }

  // ── leaderboard ──────────────────────────────────────────────────────
  // Bygger en färdig modell (sorterad). par = valfri { hole: par } för mot-par;
  // utelämnas den blir toPar 0 och vyn kan räkna mot par själv ur holes.
  function buildLeaderboard(players, scores, par) {
    const byUid = {};
    (players || []).forEach(p => {
      byUid[p.uid] = { uid: p.uid, name: p.display_name, total: 0, thru: 0, toPar: 0, holes: {} };
    });
    (scores || []).forEach(s => {
      const row = byUid[s.uid] ||
        (byUid[s.uid] = { uid: s.uid, name: "—", total: 0, thru: 0, toPar: 0, holes: {} });
      const t = (s.strokes || 0) + (s.putts || 0) + (s.pen || 0);
      if (t > 0) {
        row.holes[s.hole] = t;
        row.total += t;
        row.thru += 1;
        if (par && par[s.hole] != null) row.toPar += t - par[s.hole];
      }
    });
    return Object.values(byUid).sort((a, b) => (a.toPar - b.toPar) || (a.total - b.total));
  }

  function subscribeLeaderboard(gameId, cb, opts) {
    const c = db();
    const par = opts && opts.par;
    async function refresh() {
      const [{ data: players }, { data: scores }] = await Promise.all([
        c.from("game_players").select("uid, display_name").eq("game_id", gameId),
        c.from("hole_scores").select("uid, hole, strokes, putts, pen").eq("game_id", gameId),
      ]);
      cb(buildLeaderboard(players, scores, par));
    }
    const channel = c.channel("lb:" + gameId)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "hole_scores", filter: "game_id=eq." + gameId },
          refresh)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "game_players", filter: "game_id=eq." + gameId },
          refresh)
      .subscribe();
    refresh(); // första fyllning direkt
    return () => c.removeChannel(channel);
  }

  return { initLive, createGame, joinGame, pushHoleScore, finishGame,
           subscribeLeaderboard, pushPin, subscribePins, fetchPins, liveWarn };
})();
if (typeof window !== "undefined") window.SGLive = SGLive;
