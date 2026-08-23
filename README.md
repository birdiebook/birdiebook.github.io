# Birdiebook — webbappen

Statisk PWA + en liten Worker för runduppladdningen. Det här dokumentet finns av
ett enda skäl: **repots namn ljuger om var appen körs.**

## Var appen bor

| | Adress | Vad den är |
|---|---|---|
| **Produktion** | `https://birdiebook.johlsson-j.workers.dev` | Cloudflare Worker + assets. Det är hit TestFlight-appen laddar. |
| Frusen kopia | `https://birdiebook.github.io` | Ligger kvar **bara** för att visa flyttbannern i `boot.js`. |

`birdiebook.github.io` är alltså inte en testmiljö. `boot.js` känner igen värden
på hostnamnet och gör tre saker där: visar bannern, avregistrerar
servicearbetaren och raderar cacherna — så att en telefon med den gamla URL:en
på hemskärmen inte fortsätter köra en app vars rundor aldrig kan laddas upp
(Workern är same-origin och har medvetet ingen CORS-lista).

**En merge till `main` gör alltså ingenting live.** Pages-workflowen är sedan
2026-08-17 manuell just därför — dess gröna bock såg ut som en deploy men pekade
på den frusna värden. Se kommentaren i `.github/workflows/pages.yml`.

## Deploya

**Inte härifrån.** Det här repot deployar ingenting, och kan inte göra det.
Appens källa är `mobile/` i **`birdiebook/Golf-sg`**, och det är den mappens
`.github/workflows/deploy.yml` som kör `wrangler deploy` mot produktionen — med
hemligheterna på det repot. Läs `mobile/CLAUDE.md` där.

Det stod länge något annat här, och det kostade en hel session (2026-08-23):
en fix för bakgrunds-GPS:en byggdes och mergades i DET HÄR repot, som då hade
en egen kopia av `deploy.yml`. Den kunde aldrig gå grön — hemligheterna ligger
på `Golf-sg` och går inte att läsa härifrån — så koden låg på `main` i två
dygn utan att någonsin nå telefonen, medan felsökningen letade efter en
saknad nyckel i stället för efter fel hus. Kopian är borttagen nu. Skulle den
gå grön vore det värre än att den är röd: två repon som deployar samma värd
är precis den tvåvägsdelning som en gång gjorde att en grön bock kunde peka
på fel produktion.

**Ändringar i appen hör alltså hemma i `Golf-sg/mobile/`, inte här.** Det som
ligger i det här repot är en frusen spegel av hur `mobile/` såg ut när Pages
stängdes av; filerna har divergerat sedan dess. En ändring gjord här måste
porteras för hand för att bli verklig, och den porteringen är inte gratis.

**Bumpa alltid `version.js`.** Deployen stoppar dig om du glömmer det när
frontendfiler ändrats (nödutgång: `[no-bump]` i commit-meddelandet). `sw.js`
bygger `SHELL_CACHE` av
`SG_APP_VERSION`; utan bump serverar servicearbetaren gammal kod cache-first och
deployen syns inte på telefonen, hur grön den än var. Samma sträng följer med
som `client.app_version` på varje uppladdad runda, så den är också enda sättet
att veta vilken app en runda kom ifrån.

Tunga filer — kartrutor och 3D-hål — ligger på R2 och deployas **inte** med
appen. `assetbas.js` äger den adressen; sökvägsformen
(`tiles/<slug>/{z}/{x}/{y}.webp`, `data/holes3d/**`) är ett kontrakt som `sw.js`
känner igen på pathen.

## Testa lokalt

```
powershell -ExecutionPolicy Bypass -File serve.ps1   # http://localhost:8000
```

`?dbg=1` på 3D-vyerna öppnar `window.__hal3d` med mätkrokarna — `ljus()` för
ljusriggens invariant, `mark()` för om 3D visar samma gräs som 2D-kartan,
`fps()` och `matExag()` för prestanda och överdrift.
