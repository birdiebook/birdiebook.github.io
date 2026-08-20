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
  /* Ikonerna är inline-SVG i samma familj som hubbens (index.html): tunna
     streck, runda ändar, en enda färg via currentColor. Emoji ritas av
     SYSTEMET — de blev olika på iOS och Android, kom i färg mot en enfärgad
     design, och gick inte att göra tunnare. Bytet gjordes 2026-08-07 när
     hubben fick sitt utseende.

     `ikon` är därför markup och inte ett tecken. Den enda regeln en ny ikon
     måste följa: viewBox 0 0 24 24 och `currentColor`, så aktiv/inaktiv flik
     får sin färg av .tabs a-reglerna nedan. */
  const svg = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    + ' aria-hidden="true">' + d + '</svg>';

  // Rundans vyer — segmentkontrollen inuti spelläget, vänster till höger.
  const SPELA = [
    // Flaggan är samma vimpel-över-green som hubbens "Spela".
    { fil: "spela.html", text: "Logga slag",
      ikon: svg('<path d="M9.4 19.6 10 4.2"/>'
        + '<path d="M10 4.6c2.2 1.6 4.5.7 6.3 1.7-1.4 1.3-1.8 2.9-1.6 4.6'
        + '-2-1-3.4-.2-5.1-1.2z" fill="currentColor" stroke-width="1.3"/>'
        + '<ellipse cx="9.3" cy="19.8" rx="5.4" ry="1.9"'
        + ' fill="currentColor" fill-opacity=".22"/>') },
    // Vikt karta: två veck, inte en jordglob — det är hålkartan, inte världen.
    { fil: "karta.html", text: "Karta",
      ikon: svg('<path d="M9 4.6 3.6 6.8v12.6L9 17.2l6 2.2 5.4-2.2V4.6L15 6.8z"/>'
        + '<path d="M9 4.6v12.6M15 6.8v12.6"/>') },
    // Översikt = scorekortet: rader med värden, inte ett urklipp.
    { fil: "oversikt.html", text: "Översikt",
      ikon: svg('<rect x="3.6" y="4.4" width="16.8" height="15.2" rx="3"/>'
        + '<path d="M3.6 9.2h16.8M9.4 9.2v10.4"/>') },
  ];

  /* Sidor som hör till ett läge utan att vara lägets huvudvy markerar sin
     hemvist, så användaren ser var i appen hen står i stället för ingenting. */
  const HOR_UNDER = {
    /* uppsattning.html stod här och pekade på spela.html så länge den var ett
       STEG i spelläget. Sedan 2026-08-20 är den en GRIND före flikarna: den ska
       inte tända "Logga slag" i flikraden, för då säger navigationen att man
       står i rundan när man står före den. Den får därför bara vägen hem —
       samma som planera och analys. */
    "redigera.html": "spela.html",
    "oversikt-analys.html": "oversikt.html",
  };

  const HUB = "index.html";

  /* Bottenpaddingen bär INGEN safe-area-term (ändrat 2026-08-10). Den gjorde
     att flikraden flöt upp ~34 px från skärmkanten i det native skalet och
     lämnade en tom remsa under knapparna — synligt först när skalet blev
     riktigt fullskärm (contentInset: never). Kartan hade redan tagit bort
     termen lokalt, och det är den layouten som ser rätt ut; nu gäller samma
     för alla sidor. Priset är känt och accepterat sedan kartans beslut:
     etiketterna hamnar nära home-indikatorn i hemskärmsläget. */
  const BAS_CSS = `
.tabs { position:fixed; left:0; right:0; bottom:0; z-index:1200;
  display:flex; gap:4px; align-items:stretch;
  background:var(--card); border-top:1px solid var(--line);
  padding:6px 10px 8px; }
.tabs a { flex:1; text-align:center; text-decoration:none; color:var(--dim);
  font-size:11px; font-weight:600; padding:5px 0 3px; border-radius:10px; }
.tabs a .ico { display:block; font-size:20px; }
/* SVG-ikonerna: en fast storlek i stället för teckengrad, och centrerade i
   flikens bredd. margin-bottom ger samma luft till etiketten som emojins
   radhöjd gjorde, så flikradens höjd är oförändrad. */
.tabs a .ico svg { display:block; width:23px; height:23px; margin:0 auto 2px; }
.tabs a.active { color:var(--ink); background:#1a4c38; }
/* Vägen hem är en UTGÅNG, inte ett val i samma serie som rundans vyer —
   därför smalare, så den inte konkurrerar med dem om ögat eller tummen. */
.tabs a.hem { flex:0 0 56px; }
`;

  function filnamn(sokvag) {
    // "/mobile/karta.html" → "karta.html"; "/" och "/mobile/" → hubben.
    // Cloudflares statiska tillgångar strippar ".html" som standard
    // (/karta.html -> /karta, se mobile/wrangler.jsonc) — utan fallbacken
    // trodde varje rundvy att den var hubben och gömde hela navigationsraden
    // (läxa 2026-08-05). Bar filändelselös sista-del antas alltså vara samma
    // sida med ".html" tillagt, precis som GitHub Pages redan serverar den.
    const sista = String(sokvag || "").split("/").pop();
    if (!sista) return HUB;
    return sista.endsWith(".html") ? sista : sista + ".html";
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
  const HUS = svg('<path d="M4 10.4 12 4l8 6.4V19a1.4 1.4 0 0 1-1.4 1.4H5.4'
    + 'A1.4 1.4 0 0 1 4 19z"/><path d="M9.6 20.4v-6h4.8v6"/>');
  const HEM_SMAL = '<a href="./index.html" class="hem" aria-label="Till start">'
    + '<span class="ico">' + HUS + '</span>Start</a>';
  // Ensam på sidan får den däremot hela bredden: en 56 px knapp i en tom rad
  // ser ut som ett misstag, och är dessutom onödigt svår att träffa.
  const HEM_BRED = '<a href="./index.html"><span class="ico">' + HUS + '</span>Till start</a>';

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
