"use strict";
/* "Ladda ner banan för offline" (SERVICE_WORKER_PLAN.md, Fas 3).
 *
 * Förhämtar alla kartrutor inom banans bounds för valda zoomnivåer och lägger
 * dem i cachen `sg-tiles` (samma cache som service workern läser ur → runda på
 * banan blir helt offline, 0 MB för kartan). Redan cachade rutor hoppas över.
 *
 * Monteras av startsidan (index.html renderSetup) via window.SGOffline.mount(id).
 * Nedladdningen fortsätter även om vyn ritas om — state ligger på modulnivå.
 */
(function () {
  if (!("caches" in window)) { window.SGOffline = { mount: function () {} }; return; }

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

  // bounds = [[södraLat, västraLon], [norraLat, östraLon]] (som tiles/manifest.json)
  function tileUrls(bounds, minZoom, maxZoom) {
    const [[south, west], [north, east]] = bounds;
    const urls = [];
    for (let z = minZoom; z <= maxZoom; z++) {
      const xMin = lon2x(west, z), xMax = lon2x(east, z);
      const yMin = lat2y(north, z), yMax = lat2y(south, z); // norr = mindre y
      for (let x = xMin; x <= xMax; x++)
        for (let y = yMin; y <= yMax; y++) urls.push(`./tiles/${z}/${x}/${y}.webp`);
    }
    return urls;
  }

  // ── modultillstånd (överlever omritning av vyn) ───────────────────────────
  let manifest = null;               // { bounds, min_zoom, max_zoom }
  let running = false, cancel = false, lastProgress = null, lastResult = null;
  let ui = null;                     // { bar, status, buttons, prog, cancelBtn } för monterad vy

  const mb = (b) => (b / 1048576).toFixed(1);

  function paint(p) {
    if (!ui) return;
    ui.buttons.style.display = "none";
    ui.prog.style.display = "block";
    ui.bar.style.width = ((p.done / p.total) * 100).toFixed(1) + "%";
    ui.status.textContent = `${p.done} / ${p.total} rutor · ${mb(p.bytes)} MB` +
      (p.skipped ? ` · ${p.skipped} fanns redan` : "") +
      (p.failed ? ` · ${p.failed} misslyckades` : "");
  }
  function paintDone(r) {
    if (!ui) return;
    ui.status.textContent = r.cancelled
      ? `Avbrutet vid ${r.done}/${r.total}. Sparade rutor finns kvar.`
      : `✅ Klart! ${r.fetched} nya rutor (${mb(r.bytes)} MB), ${r.skipped} fanns redan` +
        (r.failed ? `, ${r.failed} misslyckades` : "") + ".";
    ui.cancelBtn.textContent = "Klar";
  }

  async function download(bounds, minZoom, maxZoom) {
    running = true; cancel = false;
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
    const cache = await caches.open(TILES_CACHE);
    const urls = tileUrls(bounds, minZoom, maxZoom);
    const total = urls.length;
    let done = 0, fetched = 0, skipped = 0, failed = 0, bytes = 0, idx = 0;
    async function worker() {
      while (idx < urls.length && !cancel) {
        const url = urls[idx++];
        try {
          if (await cache.match(url)) skipped++;
          else {
            const res = await fetch(url, { cache: "reload" });
            if (res && res.ok) {
              bytes += (await res.clone().arrayBuffer()).byteLength;
              await cache.put(url, res); fetched++;
            } else failed++;
          }
        } catch (_) { failed++; }
        done++;
        lastProgress = { done, total, fetched, skipped, failed, bytes };
        paint(lastProgress);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    running = false;
    lastResult = { done, total, fetched, skipped, failed, bytes, cancelled: cancel };
    paintDone(lastResult);
  }

  // ── montering i valfri container (anropas av renderSetup) ──────────────────
  async function mount(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    if (!manifest) {
      try { manifest = await (await fetch("./tiles/manifest.json", { cache: "no-cache" })).json(); }
      catch (_) { host.innerHTML = '<div class="hint">Kunde inte läsa kartmanifestet.</div>'; return; }
    }
    const bounds = manifest.bounds, MIN = manifest.min_zoom, MAX = manifest.max_zoom;
    const liteN = tileUrls(bounds, MIN, MAX - 1).length;
    const fullN = tileUrls(bounds, MIN, MAX).length;

    host.innerHTML = `
      <label>Ladda ner banan offline</label>
      <p class="hint left" style="margin:2px 0 8px">Spara alla kartrutor nu (på WiFi) så fungerar kartan helt utan täckning på banan.</p>
      <div id="dl-buttons" style="display:flex;flex-direction:column;gap:8px">
        <button class="ghost" data-lo="${MIN}" data-hi="${MAX - 1}">Lätt · ~${liteN} rutor (~25 MB)</button>
        <button class="ghost" data-lo="${MIN}" data-hi="${MAX}">Full · ~${fullN} rutor (~70 MB)</button>
      </div>
      <div id="dl-progress" style="display:none;margin-top:8px">
        <div style="height:8px;background:#0e3326;border-radius:6px;overflow:hidden">
          <div id="dl-bar" style="height:100%;width:0;background:var(--accent);transition:width .2s"></div>
        </div>
        <p id="dl-status" class="hint left" style="margin-top:6px"></p>
        <button class="ghost" id="dl-cancel" style="margin-top:4px">Avbryt</button>
      </div>`;

    ui = {
      buttons: host.querySelector("#dl-buttons"),
      prog: host.querySelector("#dl-progress"),
      bar: host.querySelector("#dl-bar"),
      status: host.querySelector("#dl-status"),
      cancelBtn: host.querySelector("#dl-cancel"),
    };

    host.querySelectorAll("#dl-buttons button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (running) return;
        download(bounds, +btn.dataset.lo, +btn.dataset.hi);
      });
    });
    ui.cancelBtn.addEventListener("click", () => {
      if (running) cancel = true;
      else { ui.buttons.style.display = "flex"; ui.prog.style.display = "none"; ui.bar.style.width = "0"; }
    });

    // återspegla pågående/klar nedladdning om vyn monterats om mitt i
    if (running && lastProgress) paint(lastProgress);
    else if (!running && lastResult) paintDone(lastResult);
  }

  window.SGOffline = { mount };
})();
