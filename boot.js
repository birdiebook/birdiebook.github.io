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
