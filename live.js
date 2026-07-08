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

  return { initLive, createGame, joinGame, pushHoleScore, finishGame, subscribeLeaderboard };
})();
if (typeof window !== "undefined") window.SGLive = SGLive;
