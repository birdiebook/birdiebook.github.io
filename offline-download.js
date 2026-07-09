"use strict";
/* "Ladda ner banan för offline" (SERVICE_WORKER_PLAN.md, Fas 3).
 *
 * Förhämtar alla kartrutor inom banans bounds för valda zoomnivåer och lägger
 * dem i cachen `sg-tiles` (samma cache som service workern läser ur → runda på
 * banan blir helt offline, 0 MB för kartan). Kör på WiFi hemma.
 *
 * Rutorna är statiska (Lantmäteriets ortofoto 2024), så detta behöver bara
 * göras EN gång. Redan cachade rutor hoppas över (0 extra data).
 *
 * UI:t lever i #offline-tools (utanför #app) så det inte skrivs över när
 * oversikt.html:s render() ritar om #app.
 */
(function () {
  if (!("caches" in window)) return;

  const TILES_CACHE = "sg-tiles";
  const CONCURRENCY = 8;

  // ── slippy-tile-matte ────────────────────────────────────────────────────
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
    );
  };

  // Lista alla tile-URL:er inom bounds för [minZoom..maxZoom].
  // bounds = [[södraLat, västraLon], [norraLat, östraLon]] (som tiles/manifest.json).
  function tileUrls(bounds, minZoom, maxZoom) {
    const [[south, west], [north, east]] = bounds;
    const urls = [];
    for (let z = minZoom; z <= maxZoom; z++) {
      const xMin = lon2x(west, z), xMax = lon2x(east, z);
      const yMin = lat2y(north, z), yMax = lat2y(south, z); // norr = mindre y
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          urls.push(`./tiles/${z}/${x}/${y}.webp`);
        }
      }
    }
    return urls;
  }

  // ── nedladdning med progress ──────────────────────────────────────────────
  let running = false, cancel = false;

  async function download(bounds, minZoom, maxZoom, onProgress) {
    running = true; cancel = false;
    // Be webbläsaren att inte vräka cachen under lagringstryck (best effort).
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}

    const cache = await caches.open(TILES_CACHE);
    const urls = tileUrls(bounds, minZoom, maxZoom);
    const total = urls.length;
    let done = 0, fetched = 0, skipped = 0, failed = 0, bytes = 0;

    let idx = 0;
    async function worker() {
      while (idx < urls.length && !cancel) {
        const url = urls[idx++];
        try {
          if (await cache.match(url)) { skipped++; }
          else {
            const res = await fetch(url, { cache: "reload" });
            if (res && res.ok) {
              const buf = await res.clone().arrayBuffer();
              bytes += buf.byteLength;
              await cache.put(url, res);
              fetched++;
            } else { failed++; }
          }
        } catch (_) { failed++; }
        done++;
        onProgress({ done, total, fetched, skipped, failed, bytes });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    running = false;
    return { done, total, fetched, skipped, failed, bytes, cancelled: cancel };
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  const mb = (b) => (b / 1048576).toFixed(1);

  async function init() {
    const host = document.getElementById("offline-tools");
    if (!host) return;

    // Banans bounds/zoom från tiles-manifestet.
    let man;
    try { man = await (await fetch("./tiles/manifest.json", { cache: "no-cache" })).json(); }
    catch (_) { host.innerHTML = '<div class="card"><div class="hint left">Kunde inte läsa kartmanifestet.</div></div>'; return; }
    const bounds = man.bounds, MIN = man.min_zoom, MAX = man.max_zoom;

    const count = (lo, hi) => tileUrls(bounds, lo, hi).length;
    const fullN = count(MIN, MAX);
    const liteN = count(MIN, Math.max(MIN, MAX - 1)); // utan högsta zoomen (z19)

    host.innerHTML = `
      <div class="card" id="dl-card">
        <h2>📥 Ladda ner banan offline</h2>
        <p class="hint left">Spara alla kartrutor nu (på WiFi) så fungerar kartan
          helt utan täckning på banan. Görs en gång — rutorna sparas permanent.
          Redan nedladdade rutor hoppas över.</p>
        <div id="dl-buttons" style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
          <button class="dl-btn" data-lo="${MIN}" data-hi="${MAX - 1}">
            Lätt · z${MIN}–${MAX - 1} · ~${liteN} rutor (~25 MB)</button>
          <button class="dl-btn" data-lo="${MIN}" data-hi="${MAX}">
            Full skärpa · z${MIN}–${MAX} · ~${fullN} rutor (~70 MB)</button>
        </div>
        <div id="dl-progress" style="display:none;margin-top:10px">
          <div style="height:8px;background:#0e3326;border-radius:6px;overflow:hidden">
            <div id="dl-bar" style="height:100%;width:0;background:var(--accent);transition:width .2s"></div>
          </div>
          <p id="dl-status" class="hint left" style="margin-top:6px"></p>
          <button id="dl-cancel" class="dl-btn" style="background:var(--danger)">Avbryt</button>
        </div>
      </div>`;

    // knappstil (matchar appens accent-knappar)
    host.querySelectorAll(".dl-btn").forEach((b) => {
      b.style.cssText += ";background:" + (b.id === "dl-cancel" ? "var(--danger)" : "var(--accent)") +
        ";color:var(--accent-ink);font-weight:800;font-size:15px;padding:11px 16px;border:none;border-radius:12px;width:100%";
    });

    const buttons = host.querySelector("#dl-buttons");
    const prog = host.querySelector("#dl-progress");
    const bar = host.querySelector("#dl-bar");
    const status = host.querySelector("#dl-status");

    host.querySelectorAll("#dl-buttons .dl-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (running) return;
        const lo = +btn.dataset.lo, hi = +btn.dataset.hi;
        buttons.style.display = "none";
        prog.style.display = "block";
        status.textContent = "Startar …";
        const res = await download(bounds, lo, hi, (p) => {
          bar.style.width = ((p.done / p.total) * 100).toFixed(1) + "%";
          status.textContent = `${p.done} / ${p.total} rutor · ${mb(p.bytes)} MB hämtat` +
            (p.skipped ? ` · ${p.skipped} redan sparade` : "") +
            (p.failed ? ` · ${p.failed} misslyckades` : "");
        });
        status.textContent = res.cancelled
          ? `Avbrutet vid ${res.done}/${res.total}. Redan sparade rutor finns kvar.`
          : `✅ Klart! ${res.fetched} nya rutor (${mb(res.bytes)} MB), ${res.skipped} fanns redan` +
            (res.failed ? `, ${res.failed} misslyckades (försök igen med täckning)` : "") + ".";
        host.querySelector("#dl-cancel").textContent = "Klar";
      });
    });

    host.querySelector("#dl-cancel").addEventListener("click", () => {
      if (running) { cancel = true; }
      else { buttons.style.display = "flex"; prog.style.display = "none"; bar.style.width = "0"; }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
