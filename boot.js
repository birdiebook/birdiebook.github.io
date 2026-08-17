/* Registrerar service workern (sw.js) på alla sidor. Delad snutt — inkluderas
 * i index/karta/oversikt/oversikt-analys. Se SERVICE_WORKER_PLAN.md.
 *
 * updateViaCache:'none' → SW-skriptet fastnar aldrig i HTTP-cachen, så en ny
 * VERSION i sw.js upptäcks alltid (boten mot "gammal kod på hemskärmen").
 *
 * scope './' → SW:n ligger i site-roten och täcker alla sidor + tiles/.
 * Exponerar window.SGReloadOnUpdate: en engångsflagga så en aktiverad ny SW
 * kan ladda om sidan (av som default för att inte störa mitt i en runda).
 */
(function () {
  "use strict";

  /* ---------- flytten från Pages (MOLN_PLAN §6 V4b) ----------
     Appen bor på Cloudflare sedan V0. Pages-kopian ligger kvar och ser fullt
     frisk ut — men runduppladdningen är SAME-ORIGIN (Workern har medvetet ingen
     CORS-lista), så en runda spelad här laddas ALDRIG upp. Inget felmeddelande,
     inget trasigt: rundan ligger kvar lokalt och försvinner den dag telefonen
     rensas. Det är därför bannern säger vad som faktiskt är fel, inte bara
     "vi har flyttat".

     Samma kodbas serverar båda värdarna (publish.ps1 speglar `mobile/`), så
     detta måste vara ett VÄRDVILLKOR och inte en egen fil.

     PAGES DEPLOYAS INTE LÄNGRE AUTOMATISKT (2026-08-17). Push-triggern i
     .github/workflows/pages.yml är borta därför att den gjorde `main` till en
     falsk mållinje: en grön deploy pekade på den här frusna värden medan appen
     låg oförändrad kvar på Cloudflare. Den frusna kopian uppdateras nu bara när
     någon kör workflowen för hand — alltså i praktiken bara när bannern här
     nedanför ändras. Byter `MAL` adress måste du komma ihåg det, annars pekar
     bannern på en värd som inte längre finns. */
  var MAL = "https://birdiebook.johlsson-j.workers.dev";
  var frusen = /(^|\.)github\.io$/i.test(location.hostname);
  window.SGFlytt = { frusen: function () { return frusen; }, mal: MAL };

  if (frusen) {
    /* SERVICE WORKERN MÅSTE BORT, inte bara lämnas oregistrerad. Den serverar
       app-skalet cache-first — en telefon som redan har appen på hemskärmen
       hade fortsatt få den GAMLA HTML:en, utan banner, hur många gånger vi än
       publicerar. Det är exakt den fällan som en gång gjorde att "gamla kartan
       låg kvar" (mobile/CLAUDE.md). */
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        rs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (ks) {
        ks.forEach(function (k) { caches.delete(k); });
      }).catch(function () {});
    }

    var visa = function () {
      if (document.getElementById("sg-flyttbanner")) return;
      var d = document.createElement("div");
      d.id = "sg-flyttbanner";
      d.setAttribute("role", "alert");
      d.style.cssText = "position:sticky;top:0;z-index:99999;background:#e8c34a;" +
        "color:#1a1a1a;padding:12px 14px;font:15px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;" +
        "text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35)";
      d.innerHTML = '<b>Appen har flyttat.</b><br>' +
        'Rundor som spelas här sparas <b>inte</b> i molnet. ' +
        '<a href="' + MAL + '" style="color:#1a1a1a;font-weight:700">Öppna nya appen →</a>';
      if (document.body) document.body.insertBefore(d, document.body.firstChild);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", visa);
    } else { visa(); }
    return;   // ingen SW-registrering på den frusna värden
  }

  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", function () {
    navigator.serviceWorker
      .register("sw.js", { scope: "./", updateViaCache: "none" })
      .catch(function (err) {
        // Ingen SW = appen funkar som förr (bara ingen offline-cache).
        console.warn("[boot] SW-registrering misslyckades:", err);
      });
  });
})();
