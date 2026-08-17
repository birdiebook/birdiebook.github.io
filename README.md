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

Cloudflare-deployen körs för hand, från datorn där källan ligger:

```
npx wrangler deploy
```

`publish.ps1` nämns i `boot.js` som det som speglar `mobile/` — den filen ligger
inte i det här repot, så kolla vilken kopia som är källa innan du ändrar här.

**Bumpa alltid `version.js`.** `sw.js` bygger `SHELL_CACHE` av
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
