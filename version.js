"use strict";
/* EN plats som Ã¤ger appens versionsstrÃ¤ng.
 *
 * TvÃ¥ konsumenter, och det Ã¤r hela skÃ¤let att filen finns:
 *
 * 1. `sw.js` bygger sina cache-namn av den â€” bumpas den inte slÃ¥r ny kod inte
 *    igenom pÃ¥ telefonerna (cache-first, se mobile/CLAUDE.md).
 * 2. `molnrunda.js` skickar den som `client.app_version` till servern, dÃ¤r den
 *    hamnar i `rounds_index` (MOLN_PLAN Â§6 V2). NÃ¤r en testare sÃ¤ger "det
 *    buggade i lÃ¶rdags" Ã¤r den raden enda sÃ¤ttet att veta VILKEN app rundan
 *    kom ifrÃ¥n.
 *
 * LÃ¥g de tvÃ¥ pÃ¥ var sitt stÃ¤lle skulle de glida isÃ¤r â€” och just den glidningen
 * vore osynlig: appen fungerar, indexraden ljuger bara om vilken version som
 * skrev den. Bumpa HÃ„R vid varje deploy, ingen annanstans.
 *
 * Laddas bÃ¥de i sidor (<script>) och i service workern (importScripts), dÃ¤rfÃ¶r
 * `self` och inte `window` â€” samma mÃ¶nster som assetbas.js. */
const SG_APP_VERSION = "2026-08-12-u28-blue1";
if (typeof self !== "undefined") self.SG_APP_VERSION = SG_APP_VERSION;
if (typeof module !== "undefined" && module.exports) module.exports = SG_APP_VERSION;
