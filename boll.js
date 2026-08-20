"use strict";
/* BOLLEN — vilka som spelar, och när ni går ut.
 *
 * Monteras i uppsättningsvyn (`spela.html`) och ERSÄTTER live-scoring-kortet.
 * Det kortet ställde fel fråga: "vill du använda live-scoring?" är ett tekniskt
 * val, och svaret på det är alltid ja när man ändå spelar tillsammans. Frågan
 * spelaren faktiskt har är "vilka är med?" — och matchen i molnet är svaret på
 * DEN frågan, inte ett eget beslut.
 *
 * DÄRFÖR SKAPAS MOLNMATCHEN IMPLICIT. Första gången du bjuder in någon körs
 * `SGLive.createGame` och koden dyker upp i kortets fot. Lägger du bara till
 * folk utan appen sker inget serveranrop alls, och hela uppsättningen fungerar
 * offline precis som förut. Ingen "Skapa match"-knapp finns kvar; det var en
 * knapp som bad användaren utföra en implementationsdetalj.
 *
 * SPELKODEN ÄR INTE BORTA, den är BEFORDRAD TILL RESERV. MOLN_PLAN §0.5 gäller
 * ("kod, aldrig magisk länk"): koden är RLS-barriären och enda vägen in för
 * den som inte har konto eller inte går att hitta i katalogen. Men den behöver
 * inte längre skrivas av en människa — en inbjudan bär den (se inbjudan.js).
 *
 * FYRA PLATSER, för det är vad ett scorekort har. Spelar du ensam ritas bara
 * din rad och en knapp — tre tomma rutor varje gång du startar en solorunda
 * vore brus i det klart vanligaste fallet. Så fort ni är två fälls hela fyran
 * ut, och då är bilden den ett scorekort redan lärt varje golfare att läsa.
 *
 * VAD MODULEN INTE GÖR: spelform. Den bor kvar i `uppsattning.html` och rörs
 * inte här — poäng och netto räknas som förut, av samma `spelformer.js`. Den
 * enda kopplingen är att en INBJUDEN spelare ännu inte syns i sidospelet:
 * `Spelformer.fromRound` filtrerar på `marker` (spelformer.js:605), och att
 * väva in molnets `hole_scores` där är ett eget steg. Markörspelare fungerar
 * oförändrat.
 *
 * CSS:en är scopad under .boll, av samma skäl som sidospel.js: värdsidan har
 * egna .card- och .row-regler och de får inte skrivas över. */
const Boll = (() => {

  const PLATSER = 4;

  const CSS = `
.boll .bhead { display:flex; align-items:center; justify-content:space-between;
  gap:10px; margin:0 0 10px; }
.boll .bhead h2 { font-size:13px; font-weight:600; text-transform:uppercase;
  letter-spacing:.6px; color:var(--dim); margin:0; }
.boll .bhead h2 span { font-weight:400; letter-spacing:0; text-transform:none; }
.boll .tid { background:#1a4c38; color:var(--ink); border:1px solid var(--line);
  border-radius:99px; padding:7px 14px; font-size:14px; font-weight:700;
  font-variant-numeric:tabular-nums; flex:none; }
.boll .tid.tom { color:var(--dim); font-weight:600; }
.boll .pl { display:flex; align-items:center; gap:12px; width:100%;
  padding:11px 0; border-bottom:1px solid var(--line); text-align:left;
  background:none; color:var(--ink); border-radius:0; }
.boll .pl:last-child { border-bottom:none; }
.boll .pl .nr { flex:none; width:22px; color:var(--dim); font-size:13px;
  font-weight:700; font-variant-numeric:tabular-nums; }
.boll .pl .nm { flex:1; min-width:0; }
.boll .pl .nm b { font-size:16px; font-weight:700; display:block;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.boll .pl .nm span { display:block; color:var(--dim); font-size:12px; margin-top:2px; }
.boll .pl.tom .nm { color:var(--dim); font-size:15px; }
.boll .pl.led .nm { color:var(--accent); font-weight:700; font-size:15px; }
.boll .pl .plus { flex:none; color:var(--accent); font-size:22px; font-weight:700;
  line-height:1; padding:0 4px; }
.boll .pl .x { flex:none; background:none; border:0; color:var(--danger);
  font-size:18px; padding:6px 6px; }
.boll .st { flex:none; font-size:11px; font-weight:700; text-transform:uppercase;
  letter-spacing:.5px; color:var(--dim); }
.boll .st.du { color:var(--accent); }
.boll .st.vantar { color:var(--miss, #e0a64e); }
.boll .st.avbojd { color:var(--danger); }
.boll .panel { border-top:1px solid var(--line); margin-top:4px; padding-top:12px; }
.boll .panel label { display:block; color:var(--dim); font-size:13px;
  font-weight:600; margin:10px 0 5px; }
.boll .panel label:first-child { margin-top:0; }
.boll .fald { width:100%; background:#0e3326; color:var(--ink);
  border:1px solid var(--line); border-radius:11px; padding:11px 12px;
  font-size:16px; font-family:inherit; }
.boll .traff { display:flex; align-items:center; gap:10px; padding:10px 0;
  border-bottom:1px solid var(--line); }
.boll .traff:last-child { border-bottom:none; }
.boll .traff .nm { flex:1; min-width:0; font-size:15px; }
.boll .traff .nm span { display:block; color:var(--dim); font-size:12px; margin-top:2px; }
.boll .mini { flex:none; background:var(--accent); color:var(--accent-ink);
  border:0; border-radius:10px; padding:9px 14px; font-size:14px; font-weight:700; }
.boll .mini[disabled] { opacity:.5; }
.boll .ghost { background:#1a4c38; color:var(--ink); border:1px solid var(--line);
  border-radius:11px; padding:11px 14px; font-size:15px; font-weight:600;
  font-family:inherit; }
.boll .lank { display:block; width:100%; background:none; border:0;
  color:var(--dim); font-size:14px; text-decoration:underline; padding:10px 0;
  text-align:left; font-family:inherit; }
.boll .chip { background:#0e3326; color:var(--dim); border:1px solid var(--line);
  border-radius:99px; padding:9px 14px; font-size:14px; font-weight:600;
  font-family:inherit; flex:none; }
.boll .chip.on { background:var(--accent); color:var(--accent-ink);
  border-color:var(--accent); }
.boll .rad { display:flex; gap:8px; align-items:center; }
.boll .rad > .fald { flex:1; }
.boll .not { color:var(--dim); font-size:13px; line-height:1.45; margin:10px 0 0; }
.boll .not b { color:var(--ink); letter-spacing:2px; font-size:16px; }
.boll .fel { color:var(--danger); font-size:13px; line-height:1.45; margin:8px 0 0; }
`;

  function injiceraCss() {
    if (typeof document === "undefined") return;
    if (document.getElementById("boll-css")) return;
    const s = document.createElement("style");
    s.id = "boll-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const komma = v => String(v).replace(".", ",");

  /* ---------- vy-tillstånd ----------
     Lever i modulen och inte i DOM:en: kortet ritas om vid varje ändring, och
     ett halvskrivet sökord ska inte försvinna för att någon svarade långsamt. */
  let panel = null;            // null | "sok" | "utanapp" | "kod" | "tid"
  let sokord = "";
  let traffar = [];
  let soker = false;
  let meddelande = "";         // fel, i klartext, där handlingen gjordes
  let sokTimer = null;
  let bjudna = {};             // uid → status ur molnet

  const mittNamn = () => {
    const p = (typeof Store !== "undefined" && Store.profile && Store.profile()) || {};
    return String(p.namn || "").trim();
  };
  const molnFinns = () => typeof SGLive !== "undefined" &&
                          typeof Inbjudan !== "undefined" && Inbjudan.tillganglig();

  /* ---------- tee-tid ----------
     `<input type="time">` med flit: iOS ger sin egen rullväljare, som är bättre
     än allt vi kan bygga och som spelaren redan kan. Datumet väljs med två
     chips i stället för en datumväljare — en tee-tid är i praktiken alltid idag
     eller imorgon, och en kalender för det vore tre tryck för noll nytta. */
  function tidDelar(iso) {
    if (!iso) return { hhmm: "", imorgon: false };
    const d = new Date(iso);
    if (isNaN(d)) return { hhmm: "", imorgon: false };
    const idag = new Date();
    const samma = d.toDateString() === idag.toDateString();
    const p = n => String(n).padStart(2, "0");
    return { hhmm: p(d.getHours()) + ":" + p(d.getMinutes()), imorgon: !samma };
  }
  function byggIso(hhmm, imorgon) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    if (!m) return null;
    const d = new Date();
    if (imorgon) d.setDate(d.getDate() + 1);
    d.setHours(+m[1], +m[2], 0, 0);
    return d.toISOString();
  }
  function tidEtikett(iso) {
    const t = tidDelar(iso);
    if (!t.hhmm) return null;
    return t.imorgon ? t.hhmm + " imorgon" : t.hhmm;
  }

  /* ---------- spelarna ----------
     EN lista, precis som §9.1.4 kräver: jag först, sedan matchens deltagare i
     den ordning de lades till. Statusen är det enda som skiljer raderna åt. */
  function spelare() {
    const m = (typeof Store !== "undefined" && Store.match && Store.match()) || null;
    const p = (typeof Store !== "undefined" && Store.profile && Store.profile()) || {};
    const jag = { id: "me", jag: true, name: mittNamn() || "Du",
                  status: "du", hcpIndex: null, tee: null, kon: p.kon || null };
    const h = (typeof Store !== "undefined" && Store.hcpForBerakning)
      ? Store.hcpForBerakning() : { value: null, kalla: "saknas" };
    jag.hcpIndex = h.value;
    jag.uppskattat = h.kalla === "hink";
    jag.tee = (Store.active() && Store.active().tee) || p.tee || null;
    const andra = ((m && m.participants) || []).map(x => ({
      id: x.id, jag: false, uid: x.uid || null, marker: !!x.marker,
      name: x.name, hcpIndex: x.hcpIndex, tee: x.tee, kon: x.kon,
      status: x.status || (x.marker ? "utan-app" : "med"),
    }));
    return [jag].concat(andra);
  }

  const STATUSTEXT = { du: "Du", vantar: "väntar…", avbojd: "avböjde",
                       med: "med", "utan-app": "utan app" };

  function radHtml(p, nr) {
    // Mitt hcp kan vara HÄRLETT ur profilens hink (§GP1 beslut 3) — tilde och
    // ordet, aldrig en naken siffra som ser inmatad ut. Samma regel som
    // sidospel.js playersHtml följer.
    const hcp = p.hcpIndex == null ? null
      : "hcp " + (p.uppskattat ? "~" + komma(p.hcpIndex) : komma(p.hcpIndex));
    const meta = [hcp, p.tee ? "tee " + esc(p.tee) : null].filter(Boolean).join(" · ");
    const st = STATUSTEXT[p.status] || "";
    const stKlass = p.status === "du" ? "du"
      : p.status === "vantar" ? "vantar"
      : p.status === "avbojd" ? "avbojd" : "";
    return `<div class="pl">
      <span class="nr">${nr}</span>
      <span class="nm"><b>${esc(p.name)}</b>${meta ? `<span>${meta}</span>` : ""}</span>
      <span class="st ${stKlass}">${esc(st)}</span>
      ${p.jag ? "" : `<button class="x" data-del="${esc(p.id)}" aria-label="Ta bort ${esc(p.name)}">✕</button>`}
    </div>`;
  }

  function platserHtml(lista) {
    const rader = lista.slice(0, PLATSER).map((p, i) => radHtml(p, i + 1));
    const kvar = PLATSER - rader.length;
    if (kvar > 0) {
      rader.push(`<button type="button" class="pl led" id="addP">
        <span class="nr">${rader.length + 1}</span>
        <span class="nm">Lägg till spelare</span>
        <span class="plus">+</span></button>`);
      // Resten av platserna ritas bara när bollen faktiskt är en boll. Ensam
      // spelare möts av sin rad och en knapp — inget annat.
      if (lista.length > 1) {
        for (let i = 1; i < kvar; i++) {
          rader.push(`<div class="pl tom"><span class="nr">${rader.length + 1}</span>
            <span class="nm">Tom plats</span></div>`);
        }
      }
    }
    return rader.join("");
  }

  /* ---------- panelerna ---------- */

  function sokPanelHtml() {
    if (!molnFinns()) {
      return `<div class="panel">
        <p class="not">Molnet är inte tillgängligt just nu, så du kan inte söka
          på namn. Du kan fortfarande lägga till någon som spelar utan appen —
          då för du deras score.</p>
        <button class="ghost" id="visaUtanApp" style="width:100%;margin-top:10px">Spelar utan appen</button>
        <button class="lank" id="stang">Stäng</button>
      </div>`;
    }
    const rader = traffar.map(t => `<div class="traff">
      <span class="nm">${esc(t.namn)}${t.klubb ? `<span>${esc(t.klubb)}</span>` : ""}</span>
      <button class="mini" data-bjud="${esc(t.uid)}" data-namn="${esc(t.namn)}">Bjud in</button>
    </div>`).join("");
    let lista;
    if (soker) lista = `<p class="not">Söker …</p>`;
    else if (sokord.trim().length < (Inbjudan.MIN_SOK || 2))
      lista = `<p class="not">Skriv minst två bokstäver ur namnet.</p>`;
    else if (!traffar.length)
      lista = `<p class="not">Ingen med det namnet går att hitta. Hen kanske inte
        har appen än, eller har stängt av sökbarheten i sin profil — då fungerar
        spelkoden.</p>`;
    else lista = rader;
    return `<div class="panel">
      <label>Bjud in någon som har appen</label>
      <input class="fald" id="sok" type="text" autocomplete="off"
        placeholder="Sök på namn …" value="${esc(sokord)}">
      <div style="margin-top:6px">${lista}</div>
      ${meddelande ? `<p class="fel">${esc(meddelande)}</p>` : ""}
      <button class="lank" id="visaUtanApp">Spelar utan appen ›</button>
      <button class="lank" id="visaKod">Har du fått en spelkod? ›</button>
      <button class="lank" id="stang">Stäng</button>
    </div>`;
  }

  /* Formuläret för den som inte har appen. Detta ERSÄTTER fyra `prompt()` i
     rad (sidospel.js wireUppsattning): avbröt man på fråga tre var de två
     första borta, och i hemskärmsläget ser en prompt ut som ett systemfel
     snarare än som appen. Bara namnet krävs — hcp, tee och kön behövs för
     netto, och saknas de säger sidospelets egen lista redan det. */
  function utanAppPanelHtml() {
    const tees = ((SGRound && SGRound.meta) || {}).tees ||
                 (SGRound && SGRound.BURLOV_DEFAULT ? SGRound.BURLOV_DEFAULT.tees : []) || [];
    const doc = Store.active();
    const förvald = (doc && doc.tee) || "";
    return `<div class="panel">
      <label>Namn</label>
      <input class="fald" id="uNamn" type="text" autocomplete="off" placeholder="Förnamn">
      <label>Handicap-index <span style="font-weight:400">(för netto — kan lämnas tomt)</span></label>
      <!-- type=text, inte number: ett number-fält slänger "8,7" tyst och
           svenskt tangentbord ger komma. Samma val som hcp-fältet i
           sidospel.js meHtml, av samma uppmätta skäl. -->
      <input class="fald" id="uHcp" type="text" inputmode="decimal" placeholder="t.ex. 18,4">
      <label>Tee</label>
      <select class="fald" id="uTee">
        <option value="">– välj –</option>
        ${tees.map(t => `<option value="${esc(t)}"${t === förvald ? " selected" : ""}>${esc(t)}</option>`).join("")}
      </select>
      <label>Kön <span style="font-weight:400">(course rating slås upp per tee och kön)</span></label>
      <div class="rad">
        <button type="button" class="chip" data-kon="herr">Herr</button>
        <button type="button" class="chip" data-kon="dam">Dam</button>
      </div>
      ${meddelande ? `<p class="fel">${esc(meddelande)}</p>` : ""}
      <button class="ghost" id="uSpara" style="width:100%;margin-top:14px">Lägg till i bollen</button>
      <button class="lank" id="stang">Avbryt</button>
    </div>`;
  }

  function kodPanelHtml() {
    return `<div class="panel">
      <label>Gå med i en match</label>
      <p class="not" style="margin:0 0 8px">Har någon gett dig en spelkod skriver du in
        den här. Blir du inbjuden i appen behöver du den inte — inbjudan dyker
        upp på startsidan.</p>
      <div class="rad">
        <input class="fald" id="kod" type="text" autocomplete="off"
          autocapitalize="characters" placeholder="T.EX. K4RT" style="text-transform:uppercase">
        <button class="mini" id="gaMed">Gå med</button>
      </div>
      ${meddelande ? `<p class="fel">${esc(meddelande)}</p>` : ""}
      <button class="lank" id="stang">Stäng</button>
    </div>`;
  }

  function tidPanelHtml() {
    const m = Store.match();
    const t = tidDelar(m && m.teeTime);
    return `<div class="panel">
      <label>Tee-tid</label>
      <div class="rad">
        <input class="fald" id="tt" type="time" value="${esc(t.hhmm)}">
        <button type="button" class="chip${t.imorgon ? "" : " on"}" data-dag="0">Idag</button>
        <button type="button" class="chip${t.imorgon ? " on" : ""}" data-dag="1">Imorgon</button>
      </div>
      <p class="not">Tiden följer med inbjudan, så den du bjuder in ser när ni går ut.</p>
      ${t.hhmm ? `<button class="lank" id="ttRensa">Ta bort tee-tiden</button>` : ""}
      <button class="lank" id="stang">Klart</button>
    </div>`;
  }

  /* ---------- kortet ---------- */

  function kortHtml() {
    const lista = spelare();
    const m = Store.match();
    const tid = tidEtikett(m && m.teeTime);
    const antal = lista.length;
    const paneler = { sok: sokPanelHtml, utanapp: utanAppPanelHtml,
                      kod: kodPanelHtml, tid: tidPanelHtml };
    return `<div class="card">
      <div class="bhead">
        <h2>Bollen ${antal > 1 ? `<span>· ${antal} av ${PLATSER}</span>` : ""}</h2>
        <button type="button" class="tid${tid ? "" : " tom"}" id="teetid">${
          tid ? esc(tid) : "Sätt tee-tid"}</button>
      </div>
      ${platserHtml(lista)}
      ${panel && paneler[panel] ? paneler[panel]() : ""}
      ${foterHtml(m)}
    </div>`;
  }

  /* Foten. Två lägen, och de utesluter varandra: är du INTE med i en match är
     det enda som kan behöva sägas att en kod finns som väg in. Är du med är det
     koden att dela vidare — plus vägen ut.

     Lämna/avsluta bodde i live-scoring-kortet och måste ha ett hem: "lämna
     matchen" är sällsynt men inte valfritt, och en funktion som bara går att nå
     genom att radera appdata är ingen funktion. Här ligger de diskret, under
     spelarna, som en följd av att man ÄR i en match. */
  function foterHtml(m) {
    if (!m || !m.gameId) {
      return panel ? "" :
        `<button class="lank" id="visaKod">Har du fått en spelkod?</button>`;
    }
    return `<p class="not">Spelkod <b>${esc(m.code || "")}</b> — för den som inte
        går att hitta på namn.</p>
      <div class="rad" style="margin-top:10px">
        <button class="ghost" id="lamna" style="flex:1">Lämna matchen</button>
        <button class="ghost" id="avsluta" style="flex:1">Avsluta för alla</button>
      </div>`;
  }

  /* ---------- molnet ----------
     Molnmatchen skapas i det ögonblick den FÖRSTA inbjudan skickas, aldrig
     tidigare. En spelare som lägger till två markörer och går ut ensam med dem
     ska inte ha rört servern en enda gång. */
  async function sakraSpel() {
    Store.ensureMatch();
    const m = Store.match();
    if (m && m.gameId) return m;
    const namn = mittNamn() || "Värden";
    const { gameId, code } = await SGLive.createGame({
      course: SGRound.courseName(), roundSeq: SGRound.roundName(), displayName: namn });
    // Sprid över den BEFINTLIGA matchen: deltagare som redan lagts till lokalt
    // ska inte försvinna för att matchen fick ett gameId.
    await Store.setMatch(Object.assign({}, Store.match() || {},
                                       { gameId, code, displayName: namn }));
    return Store.match();
  }

  /* Hämta hem status för dem jag bjudit in och skriv in den lokalt, så
     renderingen har EN källa att läsa. Tyst vid fel: en boll som inte kan visa
     "väntar…" är fortfarande en användbar boll. */
  async function hamtaStatus() {
    const m = Store.match();
    if (!m || !m.gameId || !molnFinns()) return false;
    const rader = await Inbjudan.forSpel(m.gameId);
    if (!rader.length) return false;
    bjudna = {};
    rader.forEach(r => { bjudna[r.till_uid] = r.status; });
    let andrat = false;
    for (const p of (m.participants || [])) {
      if (!p || !p.uid) continue;
      const s = bjudna[p.uid];
      if (s && s !== p.status && Store.setPlayerStatus(p.id, s)) andrat = true;
    }
    return andrat;
  }

  /* ---------- wiring ---------- */

  function wire(el, rita) {
    const q = id => el.querySelector("#" + id);
    const on = (id, ev, fn) => { const e = q(id); if (e) e[ev] = fn; };
    const oppna = p => { panel = p; meddelande = ""; rita(); };

    on("teetid", "onclick", () => oppna(panel === "tid" ? null : "tid"));
    on("addP", "onclick", () => oppna("sok"));
    on("stang", "onclick", () => oppna(null));
    on("visaUtanApp", "onclick", () => oppna("utanapp"));
    on("visaKod", "onclick", () => oppna("kod"));

    el.querySelectorAll("[data-del]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.del;
        const p = ((Store.match() || {}).participants || []).find(x => x.id === id);
        if (!p) return;
        const varning = p.marker
          ? `Ta bort ${p.name}? Deras score försvinner.`
          : `Ta bort ${p.name} ur bollen?`;
        if (!confirm(varning)) return;
        // Inbjudan tas bort i molnet också — annars ligger kortet kvar i
        // mottagarens hub och bjuder in till en plats som inte finns.
        if (p.inbjudanId && molnFinns()) Inbjudan.taBort(p.inbjudanId);
        Store.removePlayer(id);
        rita();
      };
    });

    /* --- sök på namn --- */
    const sokFalt = q("sok");
    if (sokFalt) {
      // Fokus återställs efter omritning: kortet ritas om vid varje träfflista,
      // och ett fält som tappar markören mitt i ett namn är oanvändbart.
      sokFalt.focus();
      try { sokFalt.setSelectionRange(sokord.length, sokord.length); } catch (_) {}
      sokFalt.oninput = e => {
        sokord = e.target.value;
        meddelande = "";
        if (sokTimer) clearTimeout(sokTimer);
        // 250 ms: en sökning per ord, inte en per bokstav. Under det blir det
        // ett anrop i sekunden på ett 4G-nät som redan är dåligt på en golfbana.
        sokTimer = setTimeout(async () => {
          const q0 = sokord;
          soker = true; rita();
          const r = await Inbjudan.sok(q0);
          if (q0 !== sokord) return;      // svaret gäller ett gammalt sökord
          traffar = r; soker = false; rita();
        }, 250);
      };
    }

    el.querySelectorAll("[data-bjud]").forEach(b => {
      b.onclick = async () => {
        const uid = b.dataset.bjud, namn = b.dataset.namn;
        b.disabled = true; b.textContent = "Bjuder in …";
        try {
          const m = await sakraSpel();
          const r = await Inbjudan.skicka({
            gameId: m.gameId, kod: m.code, tillUid: uid, namn,
            franNamn: mittNamn(), bana: SGRound.courseName(),
            teeTime: m.teeTime || null });
          if (!r.ok) { meddelande = r.fel; rita(); return; }
          Store.addInvited({ uid, name: namn, status: "vantar",
                             inbjudanId: r.inbjudan && r.inbjudan.id });
          panel = null; sokord = ""; traffar = []; meddelande = "";
          rita();
        } catch (e) {
          meddelande = (e && e.message) || "Inbjudan gick inte fram just nu.";
          rita();
        }
      };
    });

    /* --- utan appen --- */
    let konVal = null;
    el.querySelectorAll("[data-kon]").forEach(b => {
      b.onclick = () => {
        konVal = b.dataset.kon;
        el.querySelectorAll("[data-kon]").forEach(x =>
          x.classList.toggle("on", x === b));
      };
    });
    on("uSpara", "onclick", () => {
      const namn = (q("uNamn").value || "").trim();
      if (!namn) { meddelande = "Skriv ett namn."; rita(); return; }
      const rå = (q("uHcp").value || "").trim();
      const hcp = rå === "" ? null
        : (typeof Spelprofil !== "undefined" ? Spelprofil.hcpTal(rå)
                                             : parseFloat(rå.replace(",", ".")));
      Store.addPlayer({ name: namn, hcpIndex: hcp == null || isNaN(hcp) ? null : hcp,
                        tee: q("uTee").value || null, kon: konVal });
      panel = null; meddelande = "";
      rita();
    });

    on("lamna", "onclick", () => {
      if (!confirm("Lämna matchen? Din runda och din score påverkas inte.")) return;
      // Rör BARA matchen (§1 beslut 2): rundan lever vidare oförändrad. Det är
      // hela skälet att matchen är ett eget objekt.
      Store.removeMatch().then(rita);
    });
    on("avsluta", "onclick", async () => {
      if (!confirm("Avsluta matchen för alla? Ingen mer live-score tas emot.")) return;
      const m = Store.match();
      if (m && m.gameId && typeof SGLive !== "undefined") {
        try { await SGLive.finishGame(m.gameId); } catch (_) {}
      }
      await Store.removeMatch();
      rita();
    });

    /* --- spelkod (reservvägen) --- */
    on("gaMed", "onclick", async e => {
      const kod = (q("kod").value || "").trim();
      if (!kod) { meddelande = "Skriv in spelkoden."; rita(); return; }
      if (typeof SGLive === "undefined") {
        meddelande = "Molnet är inte tillgängligt just nu."; rita(); return;
      }
      const knapp = e.currentTarget;
      knapp.disabled = true; knapp.textContent = "Går med …";
      try {
        const namn = mittNamn() || "Spelare";
        const { gameId } = await SGLive.joinGame(kod, namn);
        await Store.setMatch(Object.assign({}, Store.match() || {},
          { gameId, code: kod.toUpperCase(), displayName: namn }));
        panel = null; meddelande = "";
        rita();
      } catch (err) {
        meddelande = (err && err.message) || "Kunde inte gå med.";
        rita();
      }
    });

    /* --- tee-tid --- */
    const tt = q("tt");
    const dagVald = () => {
      const p = el.querySelector('[data-dag="1"]');
      return !!(p && p.classList.contains("on"));
    };
    if (tt) tt.onchange = () => { Store.setTeeTime(byggIso(tt.value, dagVald())); rita(); };
    el.querySelectorAll("[data-dag]").forEach(b => {
      b.onclick = () => {
        el.querySelectorAll("[data-dag]").forEach(x => x.classList.toggle("on", x === b));
        const f = q("tt");
        if (f && f.value) Store.setTeeTime(byggIso(f.value, b.dataset.dag === "1"));
        rita();
      };
    });
    on("ttRensa", "onclick", () => { Store.setTeeTime(null); panel = null; rita(); });
  }

  /* ---------- monteringspunkt ----------
     Samma form som `Sidospel.uppsattning(el)`: värdsidan äger elementet, vi
     äger innehållet. Returnerar antalet spelare så värdsidan kan skriva sin
     egen undertext utan att räkna om listan. */
  async function kort(el) {
    injiceraCss();
    if (!el) return null;
    el.classList.add("boll");
    const rita = () => { el.innerHTML = kortHtml(); wire(el, rita); };
    rita();
    // Statusen hämtas EFTER första ritningen: kortet ska stå på skärmen direkt,
    // inte vänta på ett nätanrop som mycket väl kan ta fem sekunder på banan.
    hamtaStatus().then(andrat => { if (andrat) rita(); }).catch(() => {});
    return { players: spelare().length };
  }

  return { kort, _intern: { tidDelar, byggIso, tidEtikett, platserHtml, spelare } };
})();
if (typeof window !== "undefined") window.Boll = Boll;
