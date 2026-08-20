"use strict";
/* Sidospelets vyer (APPSTORE_PLAN.md §2.1c + §2.8.2, AS-IA steg 2).
 *
 * FÖRE: allt låg i sallskap.html — en sida som var TVÅ sidor. Sömmen gick rakt
 * igenom filen och förklarade varför den aldrig fick en flikplats: den svarade
 * mot två olika ögonblick i rundan och passade därför i ingetdera.
 *
 *   uppsättning (FÖRE rundan)      rundan (UNDER rundan)
 *   ---------------------------    ---------------------------
 *   meHtml       ditt handicap     standingsHtml    ställning
 *   playersHtml  medspelare        breakdownHtml    hål för hål
 *   formatHtml   spelform          scoreEntryHtml   inmatning
 *   nettoVarning                   wolfPickerHtml   vargens val
 *
 * EFTER: halvorna monteras på var sitt ställe —
 *   Sidospel.uppsattning(el)  → uppsattning.html, fungerar UTAN aktiv runda
 *   Sidospel.runda(el)        → oversikt.html, bara när sällskapet är fler än en
 *
 * TVÅ REGLER SOM HÖLL UNDER DELNINGEN
 *
 * 1. spelformer.js är ORÖRD. All aritmetik bodde redan där (sallskap.html var
 *    "BARA DOM"); gick något inte att flytta utan att röra kärnan hade
 *    delningen gjorts på fel ställe. Båda halvorna går genom samma
 *    `Spelformer.fromRound` → `Spelformer.run`, så ett sidospel kan aldrig
 *    räknas olika beroende på vilken vy som råkade rita det.
 *
 * 2. `doc` får vara null. Uppsättningen ska gå att göra kvällen innan, utan
 *    startad runda (§2.1b: planera är oberoende av rundan). `fromRound` tålde
 *    redan det — `doc && doc.tee`, `(doc && doc.holes) || []` — och
 *    `Store.ensureMatch` likaså (`myRoundId: doc ? doc.id : null`). Ingen av
 *    dem behövde ändras; det var därför delningen blev billig.
 *
 * CSS:EN ÄR SCOPAD UNDER .sidospel, och det är inte kosmetik: värdsidan
 * oversikt.html har egna .card-, .hint- och table-regler för live-scorekortet.
 * Injiceras dessa oscopade slås scorekortet sönder. Wrappern ger dem högre
 * specificitet inuti sidospelet och noll påverkan utanför.
 */
(function () {
  const CSS = `
.sidospel h2 { font-size:13px; font-weight:600; text-transform:uppercase;
  letter-spacing:.6px; color:var(--dim); margin:0 0 12px; }
.sidospel .card { background:var(--card); border:1px solid var(--line);
  border-radius:16px; padding:14px 16px; margin:12px 0; }
.sidospel label { display:block; color:var(--dim); font-size:13px; font-weight:600;
  margin:12px 0 5px; }
.sidospel label:first-child { margin-top:0; }
.sidospel .field, .sidospel select, .sidospel input { width:100%; background:#0e3326;
  color:var(--ink); border:1px solid var(--line); border-radius:11px;
  padding:11px 12px; font-size:16px; font-family:inherit; }
.sidospel button { font-family:inherit; }
.sidospel .ghost { background:#1a4c38; color:var(--ink); border:1px solid var(--line);
  border-radius:11px; padding:10px 14px; font-size:14px; font-weight:600; }
.sidospel .row { display:flex; gap:8px; align-items:center; }
.sidospel .hint { color:var(--dim); font-size:13px; line-height:1.45; text-align:left; }
.sidospel .warn { background:#3a2a12; border:1px solid #6b4a1c; border-radius:12px;
  padding:11px 13px; color:#f0d9a8; font-size:13px; line-height:1.45; margin:10px 0; }
.sidospel .pl { display:flex; align-items:center; gap:10px; padding:10px 0;
  border-bottom:1px solid var(--line); }
.sidospel .pl:last-child { border-bottom:none; }
.sidospel .pl .nm { flex:1; min-width:0; }
.sidospel .pl .nm b { font-size:15px; font-weight:700; }
.sidospel .pl .nm span { display:block; color:var(--dim); font-size:12px; margin-top:2px; }
.sidospel .pl .x { background:none; border:0; color:var(--danger); font-size:20px;
  padding:4px 8px; }
.sidospel .me { color:var(--accent); font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:.5px; }
.sidospel table { width:100%; border-collapse:collapse; font-size:15px;
  font-variant-numeric:tabular-nums; }
.sidospel th, .sidospel td { text-align:right; padding:8px 4px;
  border-bottom:1px solid var(--line); }
.sidospel th:first-child, .sidospel td:first-child { text-align:left; }
.sidospel th { color:var(--dim); font-weight:600; font-size:12px;
  text-transform:uppercase; letter-spacing:.4px; }
.sidospel .lead td { font-weight:700; color:var(--good); }
.sidospel td.dimc { color:var(--dim); }
.sidospel .hstep { display:flex; align-items:center; justify-content:space-between;
  margin-bottom:12px; }
.sidospel .hstep button { background:#1a4c38; color:var(--ink);
  border:1px solid var(--line); border-radius:11px; width:46px; height:42px;
  font-size:20px; font-weight:700; }
.sidospel .hstep .lbl { font-size:17px; font-weight:700; }
.sidospel .hstep .lbl span { display:block; color:var(--dim); font-size:12px;
  font-weight:600; text-align:center; margin-top:2px; }
.sidospel .sc { display:flex; align-items:center; gap:8px; padding:9px 0;
  border-bottom:1px solid var(--line); }
.sidospel .sc:last-child { border-bottom:none; }
.sidospel .sc .nm { flex:1; font-size:15px; }
.sidospel .sc .stepper { display:flex; align-items:center; gap:6px; }
.sidospel .sc .stepper button { background:#1a4c38; color:var(--ink);
  border:1px solid var(--line); border-radius:10px; width:40px; height:38px;
  font-size:19px; font-weight:700; }
.sidospel .sc .v { min-width:34px; text-align:center; font-size:19px;
  font-weight:700; font-variant-numeric:tabular-nums; }
.sidospel .sc .v.tom { color:var(--dim); font-weight:400; }
.sidospel .seg { display:flex; gap:6px; margin-top:6px; flex-wrap:wrap; }
.sidospel .seg button { flex:1; min-width:70px; background:#0e3326; color:var(--dim);
  border:1px solid var(--line); border-radius:10px; padding:9px 6px;
  font-size:13px; font-weight:600; }
.sidospel .seg button.on { background:var(--accent); color:var(--accent-ink);
  border-color:var(--accent); }
`;

  function injiceraCss() {
    if (typeof document === "undefined") return;
    if (document.getElementById("sidospel-css")) return;
    const s = document.createElement("style");
    s.id = "sidospel-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) { return String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  const KON = { herr: "herr", dam: "dam" };
  const komma = v => String(v).replace(".", ",");   // svensk text, svenskt decimaltecken

  /* Mitt eget spelarunderlag till regelkärnan — EN väg, så adaptern aldrig kan
     få olika svar beroende på vilken kodväg som råkade anropa den.
     `hcpForBerakning` bär med sig KÄLLAN: ett tal ur en hink är en härledning
     och får inte presenteras som en inmatad siffra (§GP1 beslut 3). */
  function migHcp() { return Store.hcpForBerakning(); }
  function mig() {
    const p = Store.profile() || {};
    /* Namnet följer med sedan bollkortet (boll.js) började skriva ut det: förut
       skickades det inte, och `fromRound` föll då tillbaka på "Du" — så samma
       spelare hette olika saker på två skärmar som ligger ett tryck isär.
       Profilen är den enda sanningen om vad jag heter (§GP1 beslut 1). */
    return { name: p.namn || null, hcpIndex: migHcp().value, kon: p.kon || null };
  }

  let visatHal = null;             // hålnummer i poäng-inmatningen

  /* ---------- banans data (samma väg som analys.html: rundans EGEN bana) ---------- */
  let registryP = null;
  function loadRegistry() {
    if (registryP) return registryP;
    registryP = fetch("./data/courses.json", { cache: "no-cache" })
      .then(r => r.json()).then(l => (Array.isArray(l) ? l : [])).catch(() => []);
    return registryP;
  }
  let banaP = null;
  function bana(doc) {
    if (banaP) return banaP;
    banaP = (async () => {
      const slug = (doc && doc.courseSlug) || SGRound.activeSlug();
      let meta = SGRound.meta;
      if (slug !== SGRound.activeSlug())
        meta = (await loadRegistry()).find(c => c.slug === slug) || null;
      const tables = SGRound.tablesFor(meta || {});
      const seq = tables.ROUND_SEQ[(doc && doc.roundSeq) || ""] || SGRound.seq() || [];
      let data = null;
      if (meta && meta.mobile_json) {
        data = await fetch("./data/" + meta.mobile_json, { cache: "no-cache" })
          .then(r => r.json()).catch(() => null);
      }
      const byGlobal = {};
      for (const h of (data && data.holes) || []) {
        const b = tables.GLOBAL_BASE[h.loop];
        if (b != null) byGlobal[b + h.hole] = h;
      }
      return { meta, tables, seq, byGlobal, ratings: (meta && meta.ratings) || {} };
    })();
    return banaP;
  }

  function adapter(B, doc) {
    return Spelformer.fromRound({
      doc, match: Store.match(), seq: B.seq, byGlobal: B.byGlobal,
      ratings: B.ratings, me: mig(),
    });
  }

  /* ---------- körning ---------- */
  function körFormat(B, doc) {
    const f = Store.format();
    if (!f) return null;
    const a = adapter(B, doc);
    return { adapter: a, resultat: Spelformer.run(f.key, a.ctx), formatKey: f.key };
  }

  /* ---------- uppsättning: spelare + format ---------- */
  function playersHtml(a) {
    const rader = a.players.map(p => {
      const brist = a.saknar[p.id];
      // MITT hcp kan vara HÄRLETT ur en hink (§GP1 beslut 3). Står det bara
      // "hcp 23" i listan ser uppskattningen ut som ett inmatat index — samma
      // sorts osanning som en cachad vindsiffra utan ålder. Tilde + ordet säger
      // vad det är. Medspelares hcp är alltid inmatade och märks inte.
      const uppskattat = p.jag && migHcp().kalla === "hink";
      const hcpText = p.hcpIndex == null ? null
        : "hcp " + (uppskattat ? "~" + komma(p.hcpIndex) + " (uppskattat)"
                               : komma(p.hcpIndex));
      const meta = [p.tee ? "tee " + esc(p.tee) : null, hcpText,
                    p.kon ? esc(p.kon) : null].filter(Boolean).join(" · ");
      return `<div class="pl">
        <span class="nm"><b>${esc(p.name)}</b>${p.jag ? ' <span class="me">du</span>' : ""}
          <span>${meta || "inget angivet"}${brist ? " — saknar " + brist.map(esc).join(", ") : ""}</span></span>
        ${p.jag ? "" : `<button class="x" data-del="${esc(p.id)}" aria-label="Ta bort">✕</button>`}
      </div>`;
    }).join("");
    return `<div class="card"><h2>Spelare (${a.players.length})</h2>${rader}
      <button class="ghost" id="addP" style="margin-top:12px;width:100%">+ Lägg till medspelare</button>
      <p class="hint" style="margin-top:10px">Medspelare behöver inte appen — du för
        deras score. Handicap, tee och kön behövs bara för netto.</p>
    </div>`;
  }

  function formatHtml(a) {
    const n = a.players.length;
    const möjliga = Spelformer.availableFormats(n);
    const f = Store.format();
    const opts = möjliga.map(k =>
      `<option value="${k}"${f && f.key === k ? " selected" : ""}>${esc(Spelformer.FORMAT[k].namn)}</option>`).join("");
    // Format som kräver ett annat antal spelare — visa VARFÖR de inte går.
    const spärrade = Object.keys(Spelformer.FORMAT)
      .filter(k => möjliga.indexOf(k) < 0)
      .map(k => `${Spelformer.FORMAT[k].namn} (${Spelformer.FORMAT[k].spelare} spelare)`);
    return `<div class="card">
      <label>Spelform</label>
      <select class="field" id="fmt"><option value="">— ingen —</option>${opts}</select>
      ${spärrade.length ? `<p class="hint" style="margin-top:8px">Kräver annat antal
        spelare: ${esc(spärrade.join(" · "))}.</p>` : ""}
    </div>`;
  }

  /* Kortet läser profilen och skriver till den. Det som fältet visar är det
     EXAKTA talet — aldrig hinkens mitt, för då skulle en härledning se ut som en
     inmatning så fort spelaren öppnar sidan, och nästa gång hen sparar vore
     gissningen plötsligt ett svar. Hinken syns i stället som text under. */
  function meHtml() {
    const p = Store.profile() || {};
    const h = migHcp();
    const kon = p.kon || "";
    const hinkNamn = p.hcpBucket
      ? (Spelprofil.hink("hcp", p.hcpBucket) || {}).label : null;
    let rad;
    if (h.kalla === "exakt") {
      rad = `Netto räknas på <b>${komma(h.value)}</b>.`;
    } else if (h.kalla === "hink") {
      rad = `Du har svarat <b>${esc(hinkNamn)}</b> i profilen. Netto räknas på
        hinkens mitt, <b>${komma(h.value)}</b> — en uppskattning, inte ditt hcp.
        Skriv in det exakta talet om du vet det.`;
    } else {
      rad = hinkNamn
        ? `Du har svarat <b>${esc(hinkNamn)}</b>, och då går netto inte att räkna.
           Skriv in ditt hcp-index.`
        : "Utan handicap går netto inte att räkna.";
    }
    return `<div class="card"><h2>Ditt handicap</h2>
      <div class="row">
        <!-- type=text, inte number: ett number-falt SLANGER "8,7" tyst (value blir
             tom strang), och svenskt tangentbord ger komma. Uppmatt i webblasaren
             2026-08-01. inputmode=decimal ger anda sifferknappsatsen pa telefon,
             och Spelprofil.hcpTal ager tolkningen av bade komma och punkt. -->
        <input class="field" id="myHcp" type="text" inputmode="decimal"
          placeholder="hcp-index" value="${p.hcpExact != null ? p.hcpExact : ""}">
        <select class="field" id="myKon" style="flex:0 0 44%">
          <option value="">kön —</option>
          <option value="herr"${kon === "herr" ? " selected" : ""}>herr</option>
          <option value="dam"${kon === "dam" ? " selected" : ""}>dam</option>
        </select>
      </div>
      <p class="hint" style="margin-top:8px">${rad}</p>
      <p class="hint" style="margin-top:6px">Kön behövs också: course rating och slope
        slås upp per tee OCH kön.
        <a href="./profil.html" style="color:var(--dim)">Öppna profilen</a> för resten
        av dina uppgifter.</p></div>`;
  }

  /* ---------- rundan: ställning ---------- */
  function nettoVarning(R) {
    if (!R || R.resultat.netto.ok) return "";
    const o = R.resultat.netto.orsaker || [];
    if (R.formatKey === "slagspel_brutto") return "";
    return `<div class="warn"><b>Räknas som brutto.</b> Netto går inte att räkna:
      ${esc(o.join("; "))}.</div>`;
  }

  function standingsHtml(R, a) {
    const r = R.resultat;
    if (r.fel) return `<div class="warn">${esc(r.fel)}</div>`;
    const namn = {};
    a.players.forEach(p => { namn[p.id] = p.name; });

    if (R.formatKey === "match_singel" && r.match) {
      const m = r.match;
      const txt = m.ställning === 0 ? "Lika (all square)"
        : `${esc(namn[a.players[m.ställning > 0 ? 0 : 1].id])} ${Math.abs(m.ställning)} upp`;
      return `<div class="card"><h2>${esc(r.format)}</h2>
        <p style="font-size:19px;font-weight:700;margin:0">${txt}</p>
        <p class="hint" style="margin-top:6px">${m.spelade} hål spelade${
          m.avgjord ? ` · avgjord på hål ${m.avgjord.hole} (${esc(m.avgjord.text)})` : ""}</p>
      </div>`;
    }

    const rader = (r.ställning || []).map(s => `<tr${s.plats === 1 ? ' class="lead"' : ""}>
      <td>${s.plats}${s.delad ? " =" : ""} ${esc(namn[s.id] || s.id)}</td>
      <td>${s.värde}</td>
      ${r.spelhandicap ? `<td class="dimc">${r.spelhandicap[s.id] == null ? "–" : r.spelhandicap[s.id]}</td>` : ""}
    </tr>`).join("");
    const enhet = r.formatKey === "skins" ? "skins"
      : r.lagreBast ? "slag" : "poäng";
    const extra = [];
    if (r.kvarIPott) extra.push(`${r.kvarIPott} kvar i potten`);
    if (r.ofullstandiga) extra.push(`${r.ofullstandiga} hål utan fullt sällskap räknas inte`);
    // "spelhcp" och inte "slag": kolumnen är TILLDELADE slag (spelhandicap), och
    // "slag" hade lästs som antal slagna slag i en tabell som annars visar score.
    return `<div class="card"><h2>${esc(r.format)}</h2>
      <table><tr><th>Spelare</th><th>${enhet}</th>${r.spelhandicap ? "<th>spelhcp</th>" : ""}</tr>
        ${rader}</table>
      ${extra.length ? `<p class="hint" style="margin-top:10px">${esc(extra.join(" · "))}</p>` : ""}
    </div>`;
  }

  /* Uträkningen per hål — §6.4: visa uträkningen, hantera aldrig pengar. */
  function breakdownHtml(R, a) {
    const r = R.resultat;
    const namn = {};
    a.players.forEach(p => { namn[p.id] = p.name; });
    const ids = a.players.map(p => p.id);
    let rader = [];

    if (r.rader && (R.formatKey === "kopenhamnare" || R.formatKey === "nio_poang")) {
      rader = r.rader.filter(x => x.komplett).map(x =>
        `<tr><td>${x.hole}</td>${ids.map(id => `<td>${x.del[id]}</td>`).join("")}</tr>`);
    } else if (r.rader && R.formatKey === "skins") {
      rader = r.rader.filter(x => x.utfall !== "inget spelat").map(x =>
        `<tr><td>${x.hole}</td><td colspan="${ids.length}">${
          x.utfall === "carryover" ? "delat → rullar vidare"
          : esc(x.vinnare.map(i => namn[i]).join(", ")) + ` (${x.pott})`}</td></tr>`);
    } else if (r.rader && R.formatKey === "wolf") {
      rader = r.rader.filter(x => x.lag).map(x =>
        `<tr><td>${x.hole}</td><td colspan="${ids.length}">${esc(namn[x.wolfId])}${
          x.lone ? " ensam" : " + " + esc(x.lag.slice(1).map(i => namn[i]).join(", "))
        } — ${esc(x.utfall)}</td></tr>`);
    }
    if (!rader.length) return "";
    return `<div class="card"><h2>Hål för hål</h2>
      <table><tr><th>Hål</th>${
        R.formatKey === "kopenhamnare" || R.formatKey === "nio_poang"
          ? ids.map(id => `<th>${esc((namn[id] || "").slice(0, 4))}</th>`).join("")
          : `<th>utfall</th>`}</tr>
        ${rader.join("")}</table></div>`;
  }

  /* ---------- rundan: poäng-inmatning per hål ---------- */
  function scoreEntryHtml(R, a, doc) {
    const N = (a.ctx.holes || []).length;
    if (!N) return "";
    const h = visatHal || (doc && doc.current) || 1;
    const hål = a.ctx.holes[h - 1];
    const markers = a.players.filter(p => !p.jag);
    const rader = markers.map(p => {
      const v = (a.ctx.scores[p.id] || {})[h];
      return `<div class="sc"><span class="nm">${esc(p.name)}</span>
        <span class="stepper">
          <button data-sc="${esc(p.id)}" data-d="-1">−</button>
          <span class="v${v == null ? " tom" : ""}">${v == null ? "–" : v}</span>
          <button data-sc="${esc(p.id)}" data-d="1">+</button>
        </span></div>`;
    }).join("");
    const min = (a.ctx.scores.me || {})[h];
    return `<div class="card">
      <div class="hstep">
        <button id="hPrev" ${h <= 1 ? "disabled" : ""}>‹</button>
        <span class="lbl">Hål ${h}<span>${hål && hål.par ? "par " + hål.par : "par okänt"}${
          hål && hål.index ? " · index " + hål.index : ""}</span></span>
        <button id="hNext" ${h >= N ? "disabled" : ""}>›</button>
      </div>
      <div class="sc"><span class="nm">${esc(a.players[0].name)} <span class="me">du</span></span>
        <span class="v${min == null ? " tom" : ""}">${min == null ? "–" : min}</span></div>
      ${rader}
      <p class="hint" style="margin-top:10px">Din score kommer ur rundan — ändra den
        under Logga slag. Här matar du in medspelarnas.</p>
      ${wolfPickerHtml(R, a, h)}
    </div>`;
  }

  /* Wolf är det enda formatet med ett SPELBESLUT som måste matas in (§9.4.6).
     Loggas inget val hoppas hålet över — kärnan gissar aldrig att vargen
     spelade ensam. */
  function wolfPickerHtml(R, a, h) {
    if (!R || R.formatKey !== "wolf") return "";
    const varg = Spelformer.wolfOrder(a.players, h);
    const namn = {};
    a.players.forEach(p => { namn[p.id] = p.name; });
    const val = Store.wolfChoices()[h] || null;
    const knapp = (label, data, on) =>
      `<button class="${on ? "on" : ""}" data-wolf="${data}">${esc(label)}</button>`;
    const partners = a.players.filter(p => p.id !== varg)
      .map(p => knapp(p.name, p.id, !!(val && val.partner === p.id)));
    return `<label style="margin-top:14px">Varg på hål ${h}: ${esc(namn[varg] || "?")}</label>
      <div class="seg">${knapp("Ensam varg", "__lone", !!(val && val.lone))}${partners.join("")}
        ${knapp("Inget val", "__none", !val)}</div>`;
  }

  /* ---------- wiring ---------- */
  function wireUppsattning(el, a, doc, rita) {
    const on = (id, ev, fn) => { const e = el.querySelector("#" + id); if (e) e[ev] = fn; };
    /* Skriver till PROFILEN, inte till localStorage. Hinken följer med det
       exakta talet: annars kan de två börja säga olika om samma spelare, och
       spridningsmodellen (GP1 del 3) läser hinken. */
    on("myHcp", "onchange", e => {
      const v = Spelprofil.hcpTal(e.target.value);
      Store.setProfile(v == null ? { hcpExact: null }
                                 : { hcpExact: v, hcpBucket: Spelprofil.bucketForHcp(v) });
      rita();
    });
    on("myKon", "onchange", e => {
      Store.setProfile({ kon: e.target.value || null }); rita();
    });
    on("addP", "onclick", () => {
      const namn = prompt("Medspelarens namn?");
      if (!namn) return;
      const hcpRaw = prompt(`${namn}s handicap-index? (lämna tomt om okänt)`);
      const hcp = hcpRaw == null || hcpRaw.trim() === "" ? null : parseFloat(hcpRaw.replace(",", "."));
      const tee = prompt(`Vilken tee spelar ${namn} från?`,
                         (doc && doc.tee) || "") || null;
      const kon = (prompt(`Kön för rating-uppslag (herr/dam)?`, "herr") || "").toLowerCase();
      Store.addPlayer({ name: namn.trim(), hcpIndex: isNaN(hcp) ? null : hcp,
                        tee: tee && tee.trim() ? tee.trim() : null,
                        kon: KON[kon] || null });
      rita();
    });
    el.querySelectorAll("[data-del]").forEach(b => {
      b.onclick = () => {
        const p = a.players.find(x => x.id === b.dataset.del);
        if (!confirm(`Ta bort ${p ? p.name : "spelaren"}? Deras score försvinner.`)) return;
        Store.removePlayer(b.dataset.del); rita();
      };
    });
    on("fmt", "onchange", e => { Store.setFormat(e.target.value || null); rita(); });
  }

  function wireRunda(el, a, doc, rita) {
    const on = (id, ev, fn) => { const e = el.querySelector("#" + id); if (e) e[ev] = fn; };
    const N = (a.ctx.holes || []).length;
    const h = visatHal || (doc && doc.current) || 1;
    on("hPrev", "onclick", () => { visatHal = Math.max(1, h - 1); rita(); });
    on("hNext", "onclick", () => { visatHal = Math.min(N, h + 1); rita(); });
    el.querySelectorAll("[data-sc]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.sc, d = +b.dataset.d;
        const nu = (a.ctx.scores[id] || {})[h];
        const par = (a.ctx.holes[h - 1] || {}).par || 4;
        // Första trycket sätter PAR (åt vilket håll man än trycker) — därefter
        // justerar +/−. Att låta första + ge par+1 hade gjort par onåbart utan
        // två tryck, och par är den vanligaste scoren på hålet.
        const nytt = nu == null ? par : nu + d;
        Store.setPlayerScore(id, h, nytt < 1 ? null : nytt);
        visatHal = h; rita();
      };
    });
    el.querySelectorAll("[data-wolf]").forEach(b => {
      b.onclick = () => {
        const v = b.dataset.wolf;
        Store.setWolfChoice(h, v === "__none" ? null
          : v === "__lone" ? { lone: true } : { partner: v });
        visatHal = h; rita();
      };
    });
  }

  /* ---------- monteringspunkter ---------- */

  /* Uppsättningen: ditt handicap, medspelarna, spelformen.
     Fungerar UTAN aktiv runda — doc får vara null (se filhuvudet). */
  async function uppsattning(el, opts) {
    injiceraCss();
    if (!el) return;
    opts = opts || {};
    el.classList.add("sidospel");
    const doc = Store.active();
    const B = await bana(doc);
    const a = adapter(B, doc);
    const R = körFormat(B, doc);
    /* `baraFormat` ritar ENBART spelformsvalet, för Översikt.
       Bakgrund: uppsättningen som helhet — ditt handicap, spelarlistan,
       spelformen — flyttade eller försvann 2026-08-20. Handicapet bor i
       profilen (för den som har appen) och i bollen (för den som inte har den);
       spelarlistan ÄR bollen. Kvar utan hemvist blev spelformen, och den hör
       hemma där ställningen syns: i Översikt. Att bara sluta rita den hade
       tagit bort funktionen i smyg — `Store.setFormat` anropas ingen
       annanstans än härifrån.

       Utelämnas flaggan ritas hela kortet som förut. Ingen anropar det så i
       dag, men formen är oförändrad och testerna vilar på den. */
    el.innerHTML = (opts.baraFormat ? "" : meHtml() + playersHtml(a))
                 + formatHtml(a) + nettoVarning(R);
    wireUppsattning(el, a, doc, () => uppsattning(el, opts));
    return { players: a.players.length };
  }

  /* Rundhalvan: ställning, hål för hål, inmatning av medspelarnas score.
     Ritar INGENTING när sällskapet är en enda spelare (§2.5) — då är sidospelet
     inte igång och ett tomt kort vore brus i rundvyn. */
  async function runda(el) {
    injiceraCss();
    if (!el) return null;
    const doc = Store.active();
    if (!doc) { el.innerHTML = ""; return null; }
    const B = await bana(doc);
    const a = adapter(B, doc);
    if (a.players.length < 2) { el.innerHTML = ""; return null; }
    el.classList.add("sidospel");
    const R = körFormat(B, doc);
    el.innerHTML = (R ? nettoVarning(R) + standingsHtml(R, a) + breakdownHtml(R, a) : "")
      + scoreEntryHtml(R, a, doc);
    wireRunda(el, a, doc, () => runda(el));
    return { players: a.players.length, format: R ? R.formatKey : null };
  }

  const Sidospel = {
    uppsattning, runda,
    // exponerade för test och för värdsidor som vill fatta egna beslut
    _intern: { esc, mig, migHcp, bana, adapter, körFormat, meHtml, playersHtml,
               formatHtml, nettoVarning, standingsHtml, breakdownHtml,
               scoreEntryHtml, wolfPickerHtml, CSS },
  };
  if (typeof window !== "undefined") window.Sidospel = Sidospel;
  if (typeof module !== "undefined" && module.exports) module.exports = Sidospel;
})();
