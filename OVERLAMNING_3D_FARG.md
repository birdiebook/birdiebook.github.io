# Överlämning: 3D-vyns färg

Skriven för en Claude Code-session på grundarens PC. Arbetet gjordes i en
webbsession som **aldrig kunde köra koden** — all verifiering nedan är numerisk
simulering av shaderkedjan plus statisk läsning av `vendor/three.module.min.js`.
Det som återstår kräver en browser, en telefon och wrangler-inloggning.

Radera den här filen när allt i checklistan är avbockat.

---

## Läget

| | |
|---|---|
| `main` | `249264d1` — färggreppet + deploy-tydligheten |
| `claude/golf-app-3d-colors-m7k241` | `a99402ca` — Cloudflare-workflowen, **ej mergad** |
| Produktion (`birdiebook.johlsson-j.workers.dev`) | **Oförändrad sedan 12 aug.** Inget av detta är live. |

Ingen har sett bilden. Det är hela poängen med överlämningen.

---

## 1. Gör detta FÖRST: spegelriktningen

`boot.js` säger att `publish.ps1` speglar `mobile/`. Den filen finns inte i det
här repot, så webbsessionen kunde inte avgöra vilken kopia som är källa.

**Om PC-repots `mobile/` är källan** skrivs allt nedan över nästa gång
`publish.ps1` körs. Kolla då att `mobile/hal3d.js`, `mobile/boot.js`,
`mobile/version.js`, `mobile/README.md` och `mobile/.github/workflows/` matchar
det som ligger i det här repot, och committa i PC-repot innan något annat.

Fungerar den nya deploy-workflowen (steg 4) blir `publish.ps1` överflödig — då
är GitHub källan och deployen automatisk. Bekräfta innan du slutar använda den.

---

## 2. Vad ändringen gör

Ortofotot bär redan den sol som sken när flygbilden togs. Att belysa det en
andra gång skuggade bilden två gånger, och `F2` fanns för att räkna bort den
dubbelskuggningen igen — en återkoppling som bara gällde i exakt det ljus den
mättes i. Ljuset stod inte still (`spannUpp` vred solen uppåt vid varje drag i
överdriften), så kvoten svarade på en fråga som inte längre ställdes.

Sanningen ligger nu i ljusriggen, på två regler:

1. **Ljuset är grått.** Varm sol mot kall himmel var mekanismen bakom det gula
   draget. All färg kommer från ortofotot.
2. **Plan, oskuggad mark får exakt π i irradians.** three.js diffusa term är
   `irradians × albedo / π`, så plan mark renderas som sin egen textur —
   oavsett solhöjd, klockslag eller överdrift.

Följden: `canvas(markKorr(tonlyft(textur)))` är 2D-looken av konstruktion, och
`F2` behövdes inte längre. Mätapparaten finns kvar som prov under `?dbg=1`.

Detaljerna står i kodkommentarerna i `hal3d.js` — sök på `LJUSET ÄR EN LÄSHJÄLP`
och `MÄTNINGEN ÄR ETT PROV`.

---

## 3. Verifiera (kräver browser + telefon)

Öppna planeringsvyn med `?dbg=1` och ett hål laddat.

```js
__hal3d.ljus()
// kvot: 1.0000            <- invarianten. Allt annat = greppet håller inte.
// solandel: 0.63
// riktning: [-0.447, 0.716, -0.537]

// dra överdriftsreglaget hela vägen upp och ner, kör igen:
__hal3d.ljus()             // ska vara IDENTISK. riktning.y fick förut krypa mot 1,0.

__hal3d.mark()
// { mark: { mal: [96.8, 109.9, 61.6], ar: [~97, ~110, ~62], fel: [~0, ~0, ~0] },
//   kjol: { ...samma... } }
// mark och kjol ska ligga lika — annars syns sömmen mellan hål och omgivning.

await __hal3d.matExag()    // hysteres ska vara 0 i alla tre skepnaderna
```

**Med ögat, på hål 6 (blue_6, par 3, 151 m — samma hål som grundarens
skärmbilder):** växla 2D ↔ 3D. Bytet ska kännas som en kameraflytt, inte ett
filterbyte. Dra sedan överdriften till 5× och tillbaka till 1× — bilden ska
hamna exakt där den började.

### Om `kvot` inte är 1.0000

Då har webbsessionen läst three.js fel, och talet säger var. Kolla i ordning:

1. `renderer.toneMapping` — ska vara `NoToneMapping`. Är någon annan satt är
   hela normaliseringen fel premiss.
2. Att `THREE.ColorManagement.enabled` är sant, så ljusfärgerna tolkas som sRGB
   och konverteras till linjärt arbetsrum.
3. Att `BRDF_Lambert` fortfarande är `RECIPROCAL_PI * diffuseColor` i den
   vendorade versionen — det är den π som `sattLjusniva()` normaliserar mot.

Rättningen ligger i så fall i `sattLjusniva()` i `hal3d.js`, ingen annanstans.
Lägg **inte** tillbaka en mätande återkoppling — det var den som gick sönder.

---

## 4. Slutför deployen

1. Lägg `CLOUDFLARE_API_TOKEN` och `CLOUDFLARE_ACCOUNT_ID` som repo-secrets
   (Settings → Secrets and variables → Actions). Detaljer står överst i
   `.github/workflows/deploy.yml`.
2. Merga `claude/golf-app-3d-colors-m7k241` till `main` (ren fast-forward).
   **Den pushen deployar skarpt** till produktionen och därmed till TestFlight.
3. Efter första gröna körningen: **pinna wrangler** i `deploy.yml`
   (`npx --yes wrangler@<major> deploy`). Den är opinnad tills det är känt
   vilken major som fungerar mot `compatibility_date` i `wrangler.jsonc`.

`version.js` är redan bumpad till `2026-08-17-nivalast-ljus`, så
servicearbetaren byter cache-namn och telefonen hämtar ny kod.

---

## 5. Öppna beslut — vänta på att grundaren sett bilden

| Fråga | Läge idag | Rekommendation |
|---|---|---|
| **Överlagren** | Plan-pins, siktmarkör och spridningsellips renderas nu som sina deklarerade färger i stället för ~1,8× mörkare. Siktmarkören landar på `133·250·250` och tappar kulör. | Medvetet orörda. Vill han dämpa dem: ändra **färgkonstanterna**, aldrig ljuset. |
| **Reliefstyrkan** | `SOL_ANDEL = 0.63`, exakt gamla riggens andel. | Kan nu skruvas fritt — nivå och nyans påverkas inte längre. Enda knappen för "ser jag terrängen?". |
| **Träden** | Kronorna ärver markens mätta gain. Solbelyst krona ~`56·84·43` mot 2D-skogens `49·73·32`. | Räcker troligen. Vill han tätare match: mät mot en frusen skogston, knåda inte. |
| **Kvällsljuset** | `?sol=` ger sann riktning men ingen värme. | Följer kodens egen policy. Vill han ha värmen tillbaka: lägg den som ett låst filter, inte i ljuset — annars är nyansdriften tillbaka. |

---

## 6. Gör inte

- **Återinför ingen mätande återkoppling** i renderingsvägen. `F2` mätte rätt
  och räknade rätt, och gick ändå sönder — därför att den var en återkoppling.
  Mätning hör hemma som prov under `?dbg=1`.
- **Knåda inga färgkonstanter på känsla** för att kompensera något. Varje tal i
  kedjan är antingen mätt eller härlett; det är hela skälet till att den går att
  resonera om.
- **Deploya inte förbi workflowen** när den väl fungerar. Lokal `wrangler deploy`
  betyder att bara den som körde den vet vad som ligger uppe.

---

## Bakgrund

Full inventering med alla mätvärden, fynden och hur de mättes:
`https://claude.ai/code/artifact/5a020257-a1da-4732-846c-bd6f92ffca37`

Commits: `3dd11f5d` (färggreppet), `249264d1` (deploy-tydligheten),
`a99402ca` (Cloudflare-workflowen).
