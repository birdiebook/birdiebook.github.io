# GPS-exakthet i rundlogg.html — implementationsplan

> **STATUS 2026-07-11: implementerat i `mobile/index.html`** (GPS-blocket).
> Åtgärd #1–#3 (Wake Lock, bästa-fix, median) infört. OBS: `rundlogg.html` är arkiverad
> (`mobile/_arkiv/`); aktiv källa = `index.html`, speglas live via `tools/publish.ps1`.
>
> **OMVÄRDERING (2026-07-11, efter användarfeedback):** Faktiskt arbetssätt = skärmen
> SLÄCKS och mobilen ligger i fickan mellan slag. Då släpps Wake Lock och sidan fryser →
> GPS somnar → kall fix vid VARJE slag. Det slår ut premissen för #1 OCH tömmer bufferten
> som #2/#3 läser ur. Wake Lock är därför i praktiken moot (harmlös no-op; hjälper bara om
> mobilen sitter i vagnhållare med skärmen på).
>
> **Den fix som matchar fick-arbetssättet (infört):** endast **LOGGA SLAG** samlar GPS-
> fixar i ~5 s EFTER trycket (`collectFix`, egen watch + `CAPTURE_COLLECT_MS`) och väljer
> bästa/median-positionen ur fönstret via `pickBest` — så en kall mottagare ur fickan
> hinner konvergera. **Sömlöst: ingen synlig nedräkning** (vibrationen vid retur = kvittot).
> **Green/pin använder `quickFix`** (bästa ur bufferten direkt, ingen 5 s-väntan) — där
> lämnar man platsen snabbt. `capture(label, collect)`: `true` = slag, utelämnat = quick.
> Acc-vakt (>25 m → bekräfta) kvar. Fysisk gräns: kall TTFF ~5–20 s fångas bara delvis.
> Kvar: skarpt test på banan.

**Mål:** maxa GPS-exaktheten i det ögonblick man trycker SLAG (stående över bollen),
utan att lämna webbläsaren / bli en native-app. Loggmodellen är tryck-per-slag =
appen är i förgrunden vid varje logg, så förgrunds-GPS är det avgörande.

**Bakgrund/beslut (2026-07-03):**
- Native-app (iOS/Apple Watch) valdes BORT — kräver Apple Developer ~1000 kr/år,
  TestFlight/90-dagars utgång, klockan saknar webbläsare. Android APK vore gratis
  men löser inte iPhone.
- Apple Watch-träningspass → GPX ger bakgrunds-GPS men bara ett kontinuerligt spår
  (härledda slag, brusigt) — uppfyller INTE "logga stående vid bollen". Bortvalt.
- Slutsats: webbappen är rätt verktyg. Bakgrunds-GPS är omöjligt i webbläsare
  (medvetet spärrat) — men behövs inte, eftersom man loggar i förgrunden.

## Tre åtgärder (i prioordning)

### 1. Screen Wake Lock — störst effekt
Håll skärmen tänd medan appen är öppen → GPS-chippet förblir varmt hela rundan,
ingen kall 14–19 m-uppvärmning om varje hål.
- `navigator.wakeLock.request("screen")` när en runda är aktiv.
- Åter-begär på `visibilitychange` (wake-lock släpps när man byter flik/låser).
- Släpp när rundan avslutas/exporteras. Fallback: gör inget om API saknas (äldre iOS).
- Not: kostar batteri — acceptabelt under runda. Ev. liten på/av-toggle i UI.

### 2. Bästa fixen, inte senaste — gratis, riskfritt
Idag sparar `capture()` det SENASTE watch-värdet; GPS-brus gör att senaste inte är
bäst.
- Håll en kort ringbuffer av watch-fixar (senaste ~4–6 s).
- Vid tryck: välj fixen med lägst `accuracy` inom fönstret (istället för senaste).
- Behåll nuvarande acc-vakt (>25 m → bekräfta).

### 3. Medelvärde när man står stilla — bonus, någon meter
- Filtrera bufferten till fixar inom ~4 s OCH inom ~rimlig spridning (kastar outliers).
- Ta median (robustare än medel) av lat/lon för de kvarvarande.
- Rapportera acc = bästa/median-acc i bufferten.
- Endast om ≥N fixar finns, annars faller tillbaka på #2.

## Filer att röra
- `rundlogg.html` (KÄLLAN) — GPS-sektionen ~rad 115–161 (`startWatch`, `getFix`,
  `capture`, `updateGpsChip`).
- Kopiera om till `deploy/index.html` efter ändring (`cp rundlogg.html deploy/index.html`).
- Inga nya beroenden, filen förblir fristående.

## Verifiering
- Preview-panel: kolla att wake-lock inte kastar fel där API saknas.
- På banan (skarpt): bekräfta att acc-chippen håller sig låg (~4–6 m) mellan hål
  utan ny uppvärmning, och att tryck-fixen är den bästa i fönstret.

## Ärlig gräns
Mobil-GPS toppar ~3–5 m oavsett (multipath/atmosfär). Vi minskar brus och slipper
kall-starter — men trollar inte fram centimeterprecision. Samma brusnivå som S20:n.
