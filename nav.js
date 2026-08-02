"use strict";
/* Appens navigation (APPSTORE_PLAN.md §2.1, §2.8.1, §2.8.3).
 *
 * STEG 1 gjorde flikraden till EN komponent i stället för sju kopior.
 * STEG 3 bytte ut vad komponenten RITAR, och det är den större ändringen:
 *
 *   FÖRE  fem jämbördiga flikar på varje sida
 *         ⛳ Logga slag · 🗺 Karta · 📋 Översikt · 📊 Analys · 👤 Profil
 *
 *   EFTER en hub med tre val (index.html) och, inuti spelläget, en
 *         segmentkontroll mellan rundans tre vyer:
 *         ⛳ Logga slag · 🗺 Karta · 📋 Översikt
 *
 * VARFÖR: appen har tre syften vid tre olika tider på dygnet (§2.0) — planera
 * kvällen innan, spela på banan, analysera efteråt. Man byter sällan läge mitt
 * i, så en permanent flikrad som visar "Analys" mitt under rundan är brus. Fyra
 * av de fem gamla flikarna var dessutom vyer av samma sak: den pågående rundan.
 *
 * TRE SORTERS SIDOR:
 *   1. hubben          index.html — ingen navigation, den ÄR navigationen
 *   2. rundans vyer    spela/karta/oversikt — segmentkontroll + väg hem
 *   3. övriga lägen    planera*, analys, profil, uppsattning — bara vägen hem
 *
 * Sidan lämnar en platshållare och laddar denna fil:
 *     <nav class="tabs" id="tabs"></nav>
 *     <script src="./nav.js"></script>
 * Vad som ritas avgörs av sidans filnamn — sidan behöver inte veta något.
 *
 * CSS:en bor här (inte i en .css-fil) därför att bara karta.html länkar
 * tokens.css; övriga sidor bär sina variabler inline och saknar ankarpunkt för
 * en <link>. Reglerna injiceras som FÖRSTA barn i <head> så sidans egna
 * överskrivningar vinner, precis som före steg 1. Kända avvikelser står kvar
 * lokalt i respektive sida, med kommentar.
 */
(function () {
  // Rundans vyer — segmentkontrollen inuti spelläget, vänster till höger.
  const SPELA = [
    { fil: "spela.html",    ikon: "⛳", text: "Logga slag" },
    { fil: "karta.html",    ikon: "🗺", text: "Karta" },
    { fil: "oversikt.html", ikon: "📋", text: "Översikt" },
  ];

  /* Sidor som hör till ett läge utan att vara lägets huvudvy markerar sin
     hemvist, så användaren ser var i appen hen står i stället för ingenting. */
  const HOR_UNDER = {
    // Uppsättningen är ett steg före rundläget (§2.1 beslut 1).
    "uppsattning.html": "spela.html",
    "redigera.html": "spela.html",
    "oversikt-analys.html": "oversikt.html",
  };

  const HUB = "index.html";

  const BAS_CSS = `
.tabs { position:fixed; left:0; right:0; bottom:0; z-index:1200;
  display:flex; gap:4px; align-items:stretch;
  background:var(--card); border-top:1px solid var(--line);
  padding:6px 10px calc(env(safe-area-inset-bottom) + 6px); }
.tabs a { flex:1; text-align:center; text-decoration:none; color:var(--dim);
  font-size:11px; font-weight:600; padding:5px 0 3px; border-radius:10px; }
.tabs a .ico { display:block; font-size:20px; }
.tabs a.active { color:var(--ink); background:#1a4c38; }
/* Vägen hem är en UTGÅNG, inte ett val i samma serie som rundans vyer —
   därför smalare, så den inte konkurrerar med dem om ögat eller tummen. */
.tabs a.hem { flex:0 0 56px; }
`;

  function filnamn(sokvag) {
    // "/mobile/karta.html" → "karta.html"; "/" och "/mobile/" → hubben
    const sista = String(sokvag || "").split("/").pop();
    return sista && sista.endsWith(".html") ? sista : HUB;
  }

  /* Vilken av rundans vyer som ska markeras, eller null om sidan inte hör till
     spelläget alls. */
  function aktivFil(sokvag) {
    const fil = filnamn(sokvag);
    const mappad = HOR_UNDER[fil] || fil;
    return SPELA.some(s => s.fil === mappad) ? mappad : null;
  }

  // Smal när den står BREDVID rundans segment — den är en utgång, inte ett val
  // i samma serie.
  const HEM_SMAL = '<a href="./index.html" class="hem" aria-label="Till start">'
    + '<span class="ico">⌂</span>Start</a>';
  // Ensam på sidan får den däremot hela bredden: en 56 px knapp i en tom rad
  // ser ut som ett misstag, och är dessutom onödigt svår att träffa.
  const HEM_BRED = '<a href="./index.html"><span class="ico">⌂</span>Till start</a>';

  function html(aktiv) {
    const segment = SPELA.map(s => {
      const klass = s.fil === aktiv ? ' class="active"' : "";
      return `<a href="./${s.fil}"${klass}><span class="ico">${s.ikon}</span>${s.text}</a>`;
    }).join("\n  ");
    return HEM_SMAL + "\n  " + segment;
  }

  /* Sidor utanför spelläget (analys, profil, planera …) får bara vägen hem.
     De nås från hubben och ska inte bära rundans segment. */
  function htmlEnbartHem() { return HEM_BRED; }

  function injiceraCss() {
    if (typeof document === "undefined") return;
    if (document.getElementById("nav-bas-css")) return;
    const s = document.createElement("style");
    s.id = "nav-bas-css";
    s.textContent = BAS_CSS;
    document.head.insertBefore(s, document.head.firstChild);
  }

  function mount(el) {
    injiceraCss();
    const nav = el || document.getElementById("tabs");
    if (!nav) return null;
    // Hubben ÄR navigationen — den ska inte bära en till.
    if (filnamn(location.pathname) === HUB) {
      nav.innerHTML = "";
      nav.style.display = "none";
      return nav;
    }
    const aktiv = aktivFil(location.pathname);
    nav.innerHTML = aktiv ? html(aktiv) : htmlEnbartHem();
    return nav;
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => mount());
    } else {
      mount();
    }
  }

  const SGNav = { SPELA, HOR_UNDER, HUB, BAS_CSS, filnamn, aktivFil, html,
                  htmlEnbartHem, mount };
  if (typeof window !== "undefined") window.SGNav = SGNav;
  if (typeof module !== "undefined" && module.exports) module.exports = SGNav;
})();
