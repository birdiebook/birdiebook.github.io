"use strict";
/* Offline-banor (SERVICE_WORKER_PLAN.md Fas 3; APPSTORE_PLAN §2.1d).
 *
 * Förhämtar kartrutor till cachen `sg-tiles` — samma cache service workern
 * läser ur, så en runda på banan blir helt offline. Redan cachade rutor hoppas
 * över. Nedladdningen fortsätter även om vyn ritas om: tillståndet ligger på
 * modulnivå.
 *
 * OMSKRIVEN 2026-08-03 — från EN bana till ALLA.
 *
 * Modulen satt förut i spela.html:s uppsättningsvy och laddade ner "banan",
 * underförstått `SGRound.activeSlug()`. Det fungerade DÄR, bredvid banväljaren,
 * där vilken bana som avsågs var otvetydigt. När kortet flyttade till Profil
 * (§2.1d) följde antagandet med, och då betydde "banan" plötsligt "den bana du
 * senast råkade välja under Spela" — omöjligt att gissa för den som står i
 * Profil. Det var en regression, inte bara en saknad funktion.
 *
 * Nu listar vyn alla banor som HAR kartrutor, med läge och storlek per bana,
 * och man laddar ner respektive frigör var för sig. Det är också vad §2.1d
 * beskriver: "se vilka banor som finns nedladdade, hur mycket plats de tar,
 * ladda ned respektive frigöra".
 *
 * ÄRLIGHET OM SIFFRORNA (§2.1d: "storleken ska visas ärligt"). Antal rutor är
 * EXAKT — det räknas ur cachen. Megabyten är en SKATTNING: att summera tusentals
 * blobbar för att måla en lista tar sekunder och blockerar vyn, så storleken
 * härleds ur ett stickprov av verkliga rutor för banan. Därför står den med
 * "≈". En siffra som ser exakt ut men är gissad är värre än en som säger ifrån.
 */
(function () {
  if (!("caches" in window)) { window.SGOffline = { mount: function () {} }; return; }

  const TILES_CACHE = "sg-tiles";
  const CONCURRENCY = 8;
  const STICKPROV = 24;              // rutor som vägs för att skatta snittstorlek

  // ── slippy-tile-matte ────────────────────────────────────────────────────
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
    );
  };

  // bounds = [[södraLat, västraLon], [norraLat, östraLon]] (som manifestet).
  // Tiles är BANA-SCOPADE sedan V8b: tiles/<slug>/{z}/{x}/{y}.webp.
  function tileUrls(slug, bounds, minZoom, maxZoom) {
    const [[south, west], [north, east]] = bounds;
    const urls = [];
    for (let z = minZoom; z <= maxZoom; z++) {
      const xMin = lon2x(west, z), xMax = lon2x(east, z);
      const yMin = lat2y(north, z), yMax = lat2y(south, z); // norr = mindre y
      for (let x = xMin; x <= xMax; x++)
        for (let y = yMin; y <= yMax; y++) urls.push(SGAsset.tile(slug, z, x, y));
    }
    return urls;
  }

  const mb = (b) => (b / 1048576).toFixed(1);
  const esc = (s) => String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── vilka banor finns, och vilka har rutor ────────────────────────────────
  let banorP = null;
  function banor() {
    if (banorP) return banorP;
    banorP = (async () => {
      let lista = [];
      try {
        lista = await (await fetch("./data/courses.json", { cache: "no-cache" })).json();
      } catch (_) { return []; }
      if (!Array.isArray(lista)) return [];
      // En bana utan manifest har inga byggda tiles. Det är ett NORMALTILLSTÅND
      // (bara ett fåtal banor har ortofoto), inte ett fel — den utelämnas tyst.
      const med = await Promise.all(lista.map(async (c) => {
        try {
          const m = await (await fetch(SGAsset.tileManifest(c.slug),
                                       { cache: "no-cache" })).json();
          if (!m || !m.bounds) return null;
          return { slug: c.slug, namn: c.name || c.slug, manifest: m };
        } catch (_) { return null; }
      }));
      return med.filter(Boolean);
    })();
    return banorP;
  }

  /* Läget per bana, läst ur cachen. Antalet är exakt; byten skattas (se
     filhuvudet). Nycklarna hämtas EN gång och delas mellan banorna —
     cache.keys() på tiotusentals rutor är det dyra, inte filtreringen. */
  async function lagen(lista) {
    const cache = await caches.open(TILES_CACHE);
    const nycklar = await cache.keys();
    const perSlug = {};
    for (const req of nycklar) {
      const m = req.url.match(/\/tiles\/([^/]+)\//);
      if (m) (perSlug[m[1]] = perSlug[m[1]] || []).push(req);
    }
    const ut = {};
    for (const b of lista) {
      const träffar = perSlug[b.slug] || [];
      const full = tileUrls(b.slug, b.manifest.bounds,
                            b.manifest.min_zoom, b.manifest.max_zoom).length;
      let snitt = 0;
      if (träffar.length) {
        const prov = [];
        const steg = Math.max(1, Math.floor(träffar.length / STICKPROV));
        for (let i = 0; i < träffar.length && prov.length < STICKPROV; i += steg)
          prov.push(träffar[i]);
        let summa = 0, vägda = 0;
        for (const req of prov) {
          try {
            const res = await cache.match(req);
            if (res) { summa += (await res.blob()).size; vägda++; }
          } catch (_) { /* en oläsbar ruta ska inte fälla hela listan */ }
        }
        snitt = vägda ? summa / vägda : 0;
      }
      ut[b.slug] = { cachade: träffar.length, fulltAntal: full,
                     byte: Math.round(träffar.length * snitt) };
    }
    return ut;
  }

  async function frigor(slug) {
    const cache = await caches.open(TILES_CACHE);
    const nycklar = await cache.keys();
    let n = 0;
    for (const req of nycklar)
      if (req.url.indexOf(`/tiles/${slug}/`) >= 0) { await cache.delete(req); n++; }
    return n;
  }

  // ── nedladdning (en bana i taget) ─────────────────────────────────────────
  let running = null;                // slug som laddas just nu, eller null
  let cancel = false;
  let ui = null;                     // { host, rita } för monterad vy
  let progress = null;               // { slug, done, total, ... }

  function paint() {
    if (!ui || !progress) return;
    const rad = ui.host.querySelector(`[data-prog="${progress.slug}"]`);
    if (!rad) return;
    const p = progress;
    const bar = rad.querySelector(".dl-bar");
    if (bar) bar.style.width = ((p.done / p.total) * 100).toFixed(1) + "%";
    const st = rad.querySelector(".dl-status");
    if (st) st.textContent = `${p.done} / ${p.total} rutor · ${mb(p.bytes)} MB`
      + (p.skipped ? ` · ${p.skipped} fanns redan` : "")
      + (p.failed ? ` · ${p.failed} misslyckades` : "");
  }

  async function download(bana, minZoom, maxZoom) {
    running = bana.slug; cancel = false;
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
    const cache = await caches.open(TILES_CACHE);
    const urls = tileUrls(bana.slug, bana.manifest.bounds, minZoom, maxZoom);
    const total = urls.length;
    let done = 0, fetched = 0, skipped = 0, failed = 0, bytes = 0, idx = 0;
    progress = { slug: bana.slug, done, total, fetched, skipped, failed, bytes };
    if (ui) await ui.rita();
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
        progress = { slug: bana.slug, done, total, fetched, skipped, failed, bytes };
        paint();
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    running = null; progress = null;
    if (ui) await ui.rita();
  }

  // ── vyn ───────────────────────────────────────────────────────────────────
  /* SKALNING (ändrad 2026-08-03 efter granskning): listan visar BARA banor som
     är nedladdade — plus den bana som är vald just nu. Övriga når man genom att
     söka.
     Skälet: en rad per bana med två knappar rymdes när det fanns åtta banor. Vid
     lanseringsmålet 74 banor (§1 beslut 5) blir samma vy en vägg av knappar, och
     hela innehållet är dessutom irrelevant — man laddar ner en handfull banor,
     inte alla. Det som ska vara lätt är att se vad man HAR och att frigöra det;
     att lägga till en bana är en söksituation, inte en bläddersituation. */

  let sokterm = "";
  let oppen = null;                  // slug vars nedladdningsval är utfällt

  const norm = (s) => String(s || "").toLowerCase()
    .replace(/[àáâä]/g, "a").replace(/[èéêë]/g, "e").replace(/[öô]/g, "o");

  function lagesText(läge) {
    const { cachade, fulltAntal, byte } = läge;
    // 98 % räknas som klar: zoomkanterna kan ge en handfull rutor som aldrig
    // fanns att hämta, och en bana som säger "delvis" för alltid är brus.
    const klar = cachade > 0 && cachade >= fulltAntal * 0.98;
    return {
      klar, delvis: cachade > 0 && !klar,
      text: cachade ? `≈ ${mb(byte)} MB · ${cachade} rutor`
                    : `${fulltAntal} rutor att hämta`,
    };
  }

  function banaHtml(b, läge, aktivSlug) {
    const { klar, delvis, text } = lagesText(läge);
    const cachade = läge.cachade;
    const min = b.manifest.min_zoom, max = b.manifest.max_zoom;

    if (running === b.slug) {
      return `<div class="ob-rad" data-prog="${esc(b.slug)}">
        <div class="ob-namn">${esc(b.namn)}</div>
        <div class="ob-bar"><div class="dl-bar"></div></div>
        <p class="hint left dl-status" style="margin:6px 0 0"></p>
        <button class="ghost ob-knapp" data-avbryt="1" style="margin-top:8px">Avbryt</button>
      </div>`;
    }

    const märke = klar ? '<span class="ob-ok">nedladdad</span>'
      : delvis ? '<span class="ob-del">delvis</span>' : "";
    const aktiv = b.slug === aktivSlug ? ' <span class="ob-aktiv">vald</span>' : "";

    /* EN knapp per rad i normalläget. Valet mellan Lätt och Full är ovanligt
       och fälls ut på begäran — annars fördubblas radhöjden för alla, för en
       fråga de flesta ställer en gång. */
    const knapp = klar
      ? `<button class="ghost ob-knapp" data-fri="${esc(b.slug)}">Frigör</button>`
      : `<button class="ghost ob-knapp" data-oppna="${esc(b.slug)}">${
           cachade ? "Hämta resten" : "Ladda ner"}</button>`;

    const lite = tileUrls(b.slug, b.manifest.bounds, min, max - 1).length;
    const full = tileUrls(b.slug, b.manifest.bounds, min, max).length;
    const utfallt = oppen === b.slug ? `
      <div class="ob-val">
        <button class="ghost ob-knapp" data-dl="${esc(b.slug)}" data-lo="${min}" data-hi="${max - 1}">Lätt · ${lite} rutor</button>
        <button class="ghost ob-knapp" data-dl="${esc(b.slug)}" data-lo="${min}" data-hi="${max}">Full · ${full} rutor</button>
        ${cachade ? `<button class="ghost ob-knapp ob-fri" data-fri="${esc(b.slug)}">Frigör</button>` : ""}
      </div>` : "";

    return `<div class="ob-rad">
      <div class="ob-topp">
        <div class="ob-vanster">
          <div class="ob-namn">${esc(b.namn)}${aktiv} ${märke}</div>
          <div class="ob-meta">${text}</div>
        </div>
        ${knapp}
      </div>${utfallt}
    </div>`;
  }

  const CSS = `
.ob-rad { border-top:1px solid var(--line); padding:11px 0; }
.ob-rad:first-of-type { border-top:none; }
.ob-topp { display:flex; align-items:center; gap:10px; }
.ob-vanster { flex:1; min-width:0; }
.ob-namn { font-size:15px; font-weight:700; }
.ob-aktiv, .ob-ok, .ob-del { font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:.5px; }
.ob-aktiv { color:var(--accent); }
.ob-ok { color:var(--good); }
.ob-del { color:var(--dim); }
.ob-meta { color:var(--dim); font-size:12px; margin-top:2px; }
.ob-knapp { flex:0 0 auto; background:#1a4c38; color:var(--ink);
  border:1px solid var(--line); border-radius:10px; padding:9px 12px;
  font:600 13px inherit; min-height:38px; }
.ob-knapp[disabled] { opacity:.5; }
.ob-val { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.ob-val .ob-knapp { flex:1 1 auto; min-width:96px; }
.ob-sok { width:100%; background:#0e3326; color:var(--ink);
  border:1px solid var(--line); border-radius:10px; padding:10px 11px;
  font:600 15px inherit; margin:2px 0 6px; }
.ob-summa { color:var(--dim); font-size:12px; margin:0 0 8px; }
.ob-tom { color:var(--dim); font-size:13px; line-height:1.45; padding:10px 0; }
.ob-bar { height:8px; background:#0e3326; border-radius:6px; overflow:hidden;
  margin-top:8px; }
.ob-bar .dl-bar { height:100%; width:0; background:var(--accent);
  transition:width .2s; }
`;

  function injiceraCss() {
    if (document.getElementById("offline-banor-css")) return;
    const s = document.createElement("style");
    s.id = "offline-banor-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  async function mount(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    injiceraCss();
    host.innerHTML = '<label>Banor offline</label>'
      + '<p class="hint left" style="margin:2px 0 8px">Läser …</p>';

    const lista = await banor();
    let aktivSlug = null;
    try { aktivSlug = typeof SGRound !== "undefined" ? SGRound.activeSlug() : null; } catch (_) {}

    async function rita() {
      if (!lista.length) {
        host.innerHTML = '<label>Banor offline</label>'
          + '<p class="ob-tom">Ingen bana har byggda kartrutor än.</p>';
        return;
      }
      const läge = await lagen(lista);
      const totalByte = lista.reduce((s, b) => s + läge[b.slug].byte, 0);
      const nedladdade = lista.filter(b => läge[b.slug].cachade > 0);

      /* Utan sökterm: bara det man HAR (plus vald bana och en pågående
         nedladdning, så vyn aldrig döljer det som händer just nu).
         Med sökterm: banor som matchar, oavsett läge. */
      const q = norm(sokterm);
      const synliga = q
        ? lista.filter(b => norm(b.namn).indexOf(q) >= 0 || norm(b.slug).indexOf(q) >= 0)
        : lista.filter(b => läge[b.slug].cachade > 0 || b.slug === aktivSlug
                                                     || b.slug === running);

      const dolda = lista.length - synliga.length;
      const summa = nedladdade.length
        ? `${nedladdade.length} av ${lista.length} banor nedladdade · ≈ ${mb(totalByte)} MB`
        : `Ingen bana nedladdad än · ${lista.length} att välja bland`;

      const tomText = q
        ? `Ingen bana matchar “${esc(sokterm)}”.`
        : "Sök på en bana ovan för att spara den offline.";

      host.innerHTML = `<label>Banor offline</label>
        <p class="ob-summa">${summa}</p>
        <input class="ob-sok" id="ob-sok" type="search" autocomplete="off"
          placeholder="Sök bana att ladda ner …" value="${esc(sokterm)}">
        ${synliga.length
          ? synliga.map(b => banaHtml(b, läge[b.slug], aktivSlug)).join("")
          : `<p class="ob-tom">${tomText}</p>`}
        ${!q && dolda > 0 && synliga.length
          ? `<p class="ob-tom">${dolda} ${dolda === 1 ? "bana" : "banor"} till — sök för att lägga till.</p>`
          : ""}`;

      const sok = host.querySelector("#ob-sok");
      if (sok) {
        sok.oninput = () => { sokterm = sok.value; oppen = null; rita().then(() => {
          const f = host.querySelector("#ob-sok");
          // Fokus och markörläge överlever omritningen — annars tappar man
          // tangentbordet efter varje bokstav.
          if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
        }); };
      }
      host.querySelectorAll("[data-oppna]").forEach(btn => {
        btn.onclick = () => { oppen = oppen === btn.dataset.oppna ? null : btn.dataset.oppna; rita(); };
      });
      host.querySelectorAll("[data-dl]").forEach(btn => {
        btn.onclick = () => {
          if (running) return;
          const b = lista.find(x => x.slug === btn.dataset.dl);
          if (b) { oppen = null; download(b, +btn.dataset.lo, +btn.dataset.hi); }
        };
      });
      host.querySelectorAll("[data-fri]").forEach(btn => {
        btn.onclick = async () => {
          const b = lista.find(x => x.slug === btn.dataset.fri);
          if (!b) return;
          if (!confirm(`Frigör kartrutorna för ${b.namn}? De laddas ner igen vid behov.`)) return;
          btn.disabled = true;
          await frigor(b.slug);
          oppen = null;
          rita();
        };
      });
      const avbryt = host.querySelector("[data-avbryt]");
      if (avbryt) avbryt.onclick = () => { cancel = true; };
    }

    ui = { host, rita };
    await rita();
    if (progress) paint();
  }

  window.SGOffline = { mount, _intern: { tileUrls, lagen, frigor, banor } };
})();
