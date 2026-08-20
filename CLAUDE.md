# Arbetsregler för det här repot

Läs README.md för vad appen är och var den bor. Det här dokumentet handlar bara
om **hur arbetet flyter mellan sessioner** — och det finns för att den frågan en
gång kostade tre dagars arbete som låg och glappade på var sin gren.

## Regel 1: börja på `origin/main`, sluta på `origin/main`

Uppgifterna kommer ofta från en telefon. Den som skriver dem ser inte vilka
grenar som finns och kan inte kontrollera var du står. **Det ansvaret är ditt.**

Vid start:

```
git fetch --all --prune
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin \
           | grep -v 'HEAD\|/master$'); do          # master: se sista stycket
  n=$(git rev-list --count origin/main..$b)
  [ "$n" != 0 ] && echo "$n commits utanför main: $b"
done
```

Fråga inte "vilken gren är nyast" — en mergad gren ligger kvar med samma datum
som `main` och ser nyare ut än den är. Frågan är vad som ligger **utanför**
`main`. Får du träffar har en tidigare session inte städat efter sig: **säg det
till användaren innan du börjar bygga**, annars bygger du på en gammal bas och
skapar nästa konflikt.

När arbetet är klart: merga till `main` och pusha `main`. Att lämna arbetet
enbart på en sessionsgren är att gömma det. Nästa session klonar `main` och ser
det inte, och grenarna glider isär tills någon får betala för det i konflikter.

Det här är inget som kräver pull requests — repot har en utvecklare, och en PR
som ingen granskar är bara ett extra steg mellan arbetet och trunken. Merga.

## Regel 2: bumpa `version.js`, sist

`sw.js` bygger `SHELL_CACHE` av `SG_APP_VERSION`. Utan bump serverar
servicearbetaren gammal kod cache-first, och deployen syns aldrig på telefonen —
ett fel som är osynligt vid datorn och upptäcks på banan. Samma sträng följer
med som `client.app_version` på varje uppladdad runda och är enda sättet att
veta vilken app en runda kom ifrån.

Formen är `ÅÅÅÅ-MM-DD-kort-slug`. **Bumpa i sista commiten**, inte den första —
då blir raden inte en konfliktmagnet mitt i arbetet. Konfliktar den ändå vid en
merge: bygget är varken den ena grenens sträng eller den andras utan ett nytt,
så skriv en ny som beskriver det samlade bygget.

## Regel 3: en merge till `main` deployar ingenting

Appen bor på `https://birdiebook.johlsson-j.workers.dev` och deployas **för
hand**, från datorn där källan ligger:

```
npx wrangler deploy
```

`pages.yml` är avsiktligt bara manuell, och `birdiebook.github.io` är en frusen
kopia som enbart visar flyttbannern. Säg alltså aldrig "nu är det live" efter en
push. Det du kan säga är att koden ligger på `main` och väntar på en deploy.

En gren (`claude/golf-app-3d-colors-m7k241`) innehåller ett förslag på
`deploy.yml` som gör push-till-main till en riktig deploy. Den är **inte**
mergad, kräver två hemligheter i repot, och är ett beslut användaren ska ta
medvetet — merga den inte i förbifarten.

## Så verifierar du

Chromium finns i miljön, så appen går att köra på riktigt. Gör det — den här
kodbasen är sidor med inline-script där en trasig referens ger en vit skärm som
inga tester fångar.

```
python3 -m http.server 8000          # serve.ps1 är samma sak, för Windows
node --check <fil>.js                # kör på allt du rört
node tests/js/test_inbjudan.mjs      # och övriga tests/js/*.mjs
```

## Sådant som biter om man inte vet det

- **`master` delar ingen historik med `main`.** Egen rot-commit, 8674 filer,
  noll gemensamma commits — det är projektets första liv ("SG Rundlogg", juli).
  Merga den inte, radera den inte.
- **Tunga assets ligger på R2**, inte i deployen: kartrutor och 3D-hål.
  `assetbas.js` äger adressen, och sökvägsformen (`tiles/<slug>/{z}/{x}/{y}.webp`,
  `data/holes3d/**`) är ett kontrakt som `sw.js` känner igen på pathen.
- **Nya sidor och skript måste in i `sw.js`:s precache-lista**, annars finns de
  inte offline — och offline är normalläget på en golfbana.
- **SQL-filer under `sql/` körs för hand i Supabase.** En mergad `.sql` är inte
  en körd `.sql`; säg till användaren när något kräver det.
- **Koden är på svenska** — kommentarer, commit-meddelanden, variabelnamn i
  domänen (hål, slag, boll, runda). Skriv i samma språk som filen du ändrar.
  Kommentarerna här förklarar *varför*, inte *vad*. Håll den vanan.
