"use strict";
/* BANVALET — bana, slinga, tee och loggningsnivå som EN monterbar komponent.
 *
 * Bodde inline i `spela.html` fram till att uppsättningen flyttade ut ur
 * slagloggningen och blev en egen grind (`uppsattning.html`). Att kopiera
 * koden dit hade gett två banväljare som glider isär; att låta grinden importera
 * från spela.html gick inte, för det är en sida och inte en modul. Alltså en
 * modul — samma väg som `round.js`, `store.js` och `boll.js` redan gått.
 *
 * VAD SOM ÄR OFÖRÄNDRAT: allt beteende. Dropdownen öppnas på fokus och stängs
 * vid val/Esc/klick utanför, historiken ligger överst under "Senast spelad",
 * registryn hämtas async ovanpå ett synkront SGRound-state så listan inte
 * hoppar medan den laddar, och offline vid första besöket visar bara den
 * cachade banan. De besluten är uppmätta och flyttar med oförändrade.
 *
 * DEN ENDA RIKTIGA ÄNDRINGEN: modulen läser inte längre spela.html:s `S`
 * (utkastet/rundan). Tee-valets förval kommer ur `Store.active()` med
 * `sg_tee` som fallback — samma två källor som förut, bara utan mellanhanden.
 *
 * CSS:en bor kvar i värdsidan (`.cpick*`-reglerna): den delas med sidans övriga
 * fältformspråk och skulle bli en tredje uppsättning regler här. */
const SGBanval = (() => {

  const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- registryn ----------
     Hämtas async; synkront state (SGRound) är redan uppe (Burlöv-default eller
     cachad meta) så UI inte hoppar medan den laddar. Faller tyst tillbaka till
     bara aktiv/cachad bana om fetchen failar (offline vid första besöket). */
  let registry = null;                    // array | null (ej laddad än)
  function laddaRegistry() {
    if (registry) return Promise.resolve(registry);
    return fetch("./data/courses.json", { cache: "no-cache" }).then(r => r.json())
      .then(list => (registry = Array.isArray(list) && list.length ? list : null))
      .catch(() => null);
  }
  const metaBySlug = (list, slug) => (list || []).find(c => c.slug === slug) || null;

  /* ---------- bana-historik (senast spelade) ----------
     Ren hjälpfunktion: lägger `slug` främst, deduplicerar, cappar till MAX.
     Testbar utan DOM (tests/js/test_course_history.mjs). */
  const KEY_HIST = "sg_course_history";
  const HIST_MAX = 5;
  function pushHistorik(slug, list) {
    const out = [slug, ...(Array.isArray(list) ? list : []).filter(s => s !== slug)];
    return out.slice(0, HIST_MAX);
  }
  function lasHistorik() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY_HIST));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function sparaHistorik(list) {
    try { localStorage.setItem(KEY_HIST, JSON.stringify(list)); } catch (e) {}
  }
  /* Bekvämlighet för anropare: minns banan som just startades. */
  function minnsBana(slug) { sparaHistorik(pushHistorik(slug, lasHistorik())); }

  /* ---------- nivå 2 är PAUSAD (beslut 2026-07-29) ----------
     Hela nivå 2 finns byggd och testad (APPSTORE_PLAN §9.2) men är inte
     valbar: inmatningen — särskilt fairway/green träff-miss — behöver mer
     eftertanke kring användarupplevelsen innan den möter en riktig runda.
     Datamodellen (`fir`/`gir`), regeln att härlett vinner över observerat, och
     testerna ligger kvar orörda.

     ÅTERAKTIVERA: sätt NIVA2_PAUSAD = false. Inget annat behöver ändras.

     En runda som REDAN står på nivå 2 får fortsatt visa och behålla sin nivå —
     annars hade väljaren tappat spelarens eget val mitt i en runda. */
  const NIVA2_PAUSAD = true;
  function niva2Valbar() {
    if (!NIVA2_PAUSAD) return true;
    const d = (typeof Store !== "undefined" && Store.active) ? Store.active() : null;
    return !!(d && d.loggingLevel === 2);
  }

  /* ---------- markup ---------- */
  function html() {
    return `
      <label>Bana</label>
      <div class="cpick">
        <input type="text" class="field" id="courseSearch" placeholder="Sök bana …" autocomplete="off">
        <div class="cpick-list" id="courseList"></div>
      </div>
      <label>Vilken runda spelar du? <span style="color:var(--dim)">(för hålkartan)</span></label>
      <select class="field" id="round"></select>
      <label>Vilken tee spelar du från? <span style="color:var(--dim)">(för utslags-analys)</span></label>
      <select class="field" id="tee"></select>
      <label>Hur mycket vill du logga? <span style="color:var(--dim)">(går att ändra under rundan)</span></label>
      <select class="field" id="lvl">
        <option value="3">Full — GPS-position per slag (ger Strokes Gained)</option>
        ${niva2Valbar() ? `<option value="2">Score + statistik — puttar, fairway, green</option>` : ""}
        <option value="1">Bara score</option>
      </select>`;
  }

  /* ---------- montering ----------
     `el` ska redan innehålla markupen ur `html()`. Returnerar ett handtag med
     `las()` — det anroparen behöver när spelaren trycker starta. */
  function montera(el, opts) {
    opts = opts || {};
    const roundSel = el.querySelector("#round");
    const teeSel = el.querySelector("#tee");
    const lvlSel = el.querySelector("#lvl");
    const courseSearch = el.querySelector("#courseSearch");
    const courseList = el.querySelector("#courseList");
    if (!roundSel || !teeSel || !courseSearch || !courseList) return null;

    // Loggningsnivån minns valet från förra rundan (default full loggning).
    // Har spelaren nivå 2 sparad medan den är pausad faller vi tillbaka på full
    // loggning i stället för att låta <select> tyst välja första alternativet.
    if (lvlSel) {
      let sparad = localStorage.getItem("sg_level");
      if (sparad === "2" && !niva2Valbar()) sparad = "3";
      lvlSel.value = (sparad === "1" || sparad === "2") ? sparad : "3";
    }

    const aktivMeta = SGRound.meta || SGRound.BURLOV_DEFAULT;
    let valdSlug = aktivMeta.slug;

    function fyllRundaOchTee(meta) {
      const rounds = (meta && meta.rounds) || SGRound.BURLOV_DEFAULT.rounds;
      const tees = (meta && meta.tees) || SGRound.BURLOV_DEFAULT.tees;
      const sparadRunda = localStorage.getItem("sg_round");
      const rundVal = rounds.some(r => r.value === sparadRunda) ? sparadRunda : rounds[0].value;
      roundSel.innerHTML = rounds.map(r =>
        `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join("");
      roundSel.value = rundVal;
      localStorage.setItem("sg_round", rundVal);
      // tee-val (rundnivå): förvälj senast använda om den finns i banans
      // tee-lista; delas via 'sg_tee' så det ligger kvar mellan rundor.
      const doc = (typeof Store !== "undefined" && Store.active) ? Store.active() : null;
      const sparadTee = (doc && doc.tee) || localStorage.getItem("sg_tee") || "";
      teeSel.innerHTML = '<option value="">– välj tee –</option>' +
        tees.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
      teeSel.value = tees.includes(sparadTee) ? sparadTee : "";
    }

    roundSel.onchange = () => {
      localStorage.setItem("sg_round", roundSel.value);
      if (opts.onChange) opts.onChange(las());
    };
    teeSel.onchange = () => {
      localStorage.setItem("sg_tee", teeSel.value);
      if (opts.onChange) opts.onChange(las());
    };

    const norm = s => String(s || "").toLowerCase();
    const traffar = (c, q) => norm(c.name).includes(q) || norm(c.slug).includes(q);
    const radHtml = c => `<button type="button" class="cpick-row${
      c.slug === valdSlug ? " active" : ""}" data-slug="${esc(c.slug)}">${esc(c.name)}</button>`;

    function ritaLista() {
      const list = registry;
      if (!list) {
        // offline vid första besöket: visa bara aktiv/cachad bana
        courseList.innerHTML = radHtml(aktivMeta);
        return;
      }
      /* Fältet fylls med vald banas namn efter val — behandla det som TOMT sök
         (visa historik + alla, med den valda markerad) så "sök först, aldrig
         tomt" gäller även när man fokuserar fältet igen. Skriver man något
         annat filtreras listan. */
      const valdMeta = metaBySlug(list, valdSlug);
      const rått = courseSearch.value.trim();
      const q = (valdMeta && norm(rått) === norm(valdMeta.name)) ? "" : norm(rått);
      if (q) {
        const hits = list.filter(c => traffar(c, q));
        courseList.innerHTML = hits.length ? hits.map(radHtml).join("")
          : '<div class="cpick-empty">Inga banor matchar</div>';
        return;
      }
      const hist = lasHistorik().filter(slug => list.some(c => c.slug === slug));
      const histSet = new Set(hist);
      const rest = list.filter(c => !histSet.has(c.slug));
      let ut = "";
      if (hist.length) {
        ut += '<div class="cpick-sec">Senast spelad</div>';
        ut += hist.map(slug => radHtml(metaBySlug(list, slug))).join("");
      }
      ut += '<div class="cpick-sec">Alla banor</div>';
      ut += rest.length ? rest.map(radHtml).join("")
                        : '<div class="cpick-empty">Inga banor</div>';
      courseList.innerHTML = ut;
    }

    // Dropdownen öppnas bara när man vill välja bana (fokus/klick på fältet)
    // och stängs vid val, Esc eller klick utanför — så alla banor inte fyller
    // skärmen i vila (skalar till många banor).
    const oppna = () => { courseList.classList.add("open"); ritaLista(); kopplaRader(); };
    const stang = () => courseList.classList.remove("open");
    function kopplaRader() {
      courseList.querySelectorAll("[data-slug]").forEach(btn => btn.onclick = () => {
        const meta = metaBySlug(registry, btn.dataset.slug) ||
          (btn.dataset.slug === aktivMeta.slug ? aktivMeta : null);
        if (!meta) return;
        valdSlug = meta.slug;
        SGRound.setActiveCourse(meta);
        localStorage.removeItem("sg_round");   // nollställ till banans första runda
        courseSearch.value = meta.name;
        fyllRundaOchTee(meta);
        stang();
        courseSearch.blur();
        if (opts.onChange) opts.onChange(las());
      });
    }

    courseSearch.value = SGRound.courseName();   // visa aktiv bana i vila
    fyllRundaOchTee(aktivMeta);
    laddaRegistry().then(list => {
      if (!list) return;   // offline vid första besöket — behåll cachad bana
      if (courseList.classList.contains("open")) { ritaLista(); kopplaRader(); }
    });
    courseSearch.oninput = oppna;
    // fokus öppnar hela listan och markerar texten så första tangenttrycket
    // ersätter banans namn (i st.f. att söka på "namn"+bokstav).
    courseSearch.onfocus = () => { oppna(); courseSearch.select(); };
    courseSearch.onkeydown = e => { if (e.key === "Escape") { stang(); courseSearch.blur(); } };
    // stäng när fokus lämnar väljaren; liten fördröjning så ett rad-klick
    // hinner registreras innan vi fäller ihop.
    const cp = courseSearch.closest(".cpick");
    if (cp) cp.addEventListener("focusout", () => {
      setTimeout(() => { if (!cp.contains(document.activeElement)) stang(); }, 150);
    });

    function las() {
      const meta = metaBySlug(registry, valdSlug) || SGRound.meta || aktivMeta;
      return { slug: (meta && meta.slug) || SGRound.activeSlug(), meta,
               courseName: (meta && meta.name) || SGRound.courseName(),
               roundSeq: roundSel.value, tee: teeSel.value,
               niva: lvlSel ? +lvlSel.value : 3 };
    }
    return { las, ritaLista, stang };
  }

  return { html, montera, laddaRegistry, metaBySlug,
           pushHistorik, lasHistorik, sparaHistorik, minnsBana,
           niva2Valbar, NIVA2_PAUSAD };
})();
if (typeof window !== "undefined") window.SGBanval = SGBanval;
if (typeof module !== "undefined" && module.exports) module.exports = SGBanval;
