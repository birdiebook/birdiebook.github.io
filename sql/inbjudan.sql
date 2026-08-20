-- INBJUDAN PÅ NAMN — spelarkatalog + inbjudningar (ersätter spelkoden som
-- primär väg in i en match).
--
-- Körs för hand i Supabase (SQL Editor). Filen ligger i repot för att schemat
-- ska gå att läsa tillsammans med koden som använder det — `inbjudan.js` är
-- skriven mot EXAKT dessa kolumnnamn.
--
-- VARFÖR KODEN FINNS KVAR. MOLN_PLAN §0.5 säger "kod, aldrig magisk länk", och
-- den regeln gäller fortfarande: koden är barriären (RLS Fas 1) och den enda
-- vägen in för någon utan konto. Det inbjudan gör är att BÄRA koden åt
-- mottagaren, så ingen behöver läsa upp fyra tecken på första tee. Accepterar
-- man en inbjudan kör klienten samma `joinGame(kod)` som förut.
--
-- Misslyckas allt det här (tabellen saknas, ingen täckning) ska appen bete sig
-- exakt som före den här filen: koden går att skriva in för hand. Klienten är
-- byggd så — se `Inbjudan.tillganglig()`.

-- ── 1. KATALOGEN ────────────────────────────────────────────────────────────
-- Den enda plats i molnet där ett uid har ett läsbart namn. Utan den går det
-- inte att bjuda in någon "på namn": `game_players.display_name` skrivs först
-- när någon redan gått med, alltså för sent.
create table if not exists spelare_katalog (
  uid        uuid primary key references auth.users(id) on delete cascade,
  namn       text not null,
  klubb      text,
  -- Sökbarheten är ett VAL, inte en bieffekt av att ha ett konto. Default true
  -- för att en app där ingen hittar någon är oanvändbar från dag ett, men
  -- profilen har en strömbrytare (profil.html) och den ska fungera.
  sokbar     boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Sökningen är `ilike '%q%'` på ett fåtal tusen rader — index på lower(namn)
-- hjälper bara prefixsökning, men kostar nästan inget och gör förnamnssök
-- (det vanliga) snabb. Räcker inte det när katalogen växer är pg_trgm + GIN
-- nästa steg, inte en omskrivning av klienten.
create index if not exists spelare_katalog_namn_idx on spelare_katalog (lower(namn));

alter table spelare_katalog enable row level security;

-- LÄSA: bara sökbara rader, och alltid sin egen. Att kunna läsa hela katalogen
-- vore att publicera medlemsregistret — `sokbar` måste gälla i databasen, inte
-- i klientens filter, annars är den en dekoration.
drop policy if exists katalog_las on spelare_katalog;
create policy katalog_las on spelare_katalog
  for select to authenticated
  using (sokbar or uid = auth.uid());

-- SKRIVA: bara sin egen rad. `with check` på BÅDA operationerna — utan den på
-- update kan en rad skrivas om till någon annans uid.
drop policy if exists katalog_skriv on spelare_katalog;
create policy katalog_skriv on spelare_katalog
  for insert to authenticated with check (uid = auth.uid());
drop policy if exists katalog_uppdatera on spelare_katalog;
create policy katalog_uppdatera on spelare_katalog
  for update to authenticated using (uid = auth.uid()) with check (uid = auth.uid());
drop policy if exists katalog_radera on spelare_katalog;
create policy katalog_radera on spelare_katalog
  for delete to authenticated using (uid = auth.uid());

-- ── 2. INBJUDNINGARNA ───────────────────────────────────────────────────────
-- En inbjudan är ett ERBJUDANDE, inte en plats i matchen. Först när mottagaren
-- svarar ja körs `joinGame` och raden i `game_players` skapas. Det är därför
-- `namn` finns här: värden ska se "Anders — väntar…" i bollen direkt, utan att
-- något skrivits i game_players i förtid. (Skulle värden reservera platsen där
-- får man två rader när Anders går med under sitt eget namn — den vanligaste
-- buggen i den här sortens flöde.)
create table if not exists spel_inbjudan (
  id        uuid primary key default gen_random_uuid(),
  game_id   uuid not null references games(id) on delete cascade,
  -- Koden följer med inbjudan så mottagaren aldrig behöver skriva den. Den
  -- ligger DENORMALISERAD med flit: mottagaren har ingen läsrätt att slå upp
  -- games-raden innan hen gått med.
  kod       text not null,
  fran_uid  uuid not null references auth.users(id) on delete cascade,
  fran_namn text not null,
  till_uid  uuid not null references auth.users(id) on delete cascade,
  namn      text not null,
  bana      text,
  tee_time  timestamptz,
  -- vantar | med | avbojd
  status    text not null default 'vantar',
  skapad    timestamptz not null default now(),
  svarad    timestamptz,
  -- En person bjuds in EN gång till samma spel. Utan detta ger tre tryck på
  -- "Bjud in" tre kort i mottagarens hub.
  unique (game_id, till_uid)
);

create index if not exists spel_inbjudan_till_idx
  on spel_inbjudan (till_uid, status);
create index if not exists spel_inbjudan_spel_idx
  on spel_inbjudan (game_id);

alter table spel_inbjudan enable row level security;

-- LÄSA: avsändaren (för att se status i bollen) och mottagaren (för att se
-- kortet på hubben). Ingen annan — inbjudan bär spelkoden.
drop policy if exists inbjudan_las on spel_inbjudan;
create policy inbjudan_las on spel_inbjudan
  for select to authenticated
  using (fran_uid = auth.uid() or till_uid = auth.uid());

-- SKICKA: bara i eget namn.
drop policy if exists inbjudan_skicka on spel_inbjudan;
create policy inbjudan_skicka on spel_inbjudan
  for insert to authenticated with check (fran_uid = auth.uid());

-- SVARA: båda får uppdatera (mottagaren svarar, avsändaren kan dra tillbaka),
-- men ingen får flytta inbjudan till någon annan — därför upprepas villkoret
-- i `with check`.
drop policy if exists inbjudan_svara on spel_inbjudan;
create policy inbjudan_svara on spel_inbjudan
  for update to authenticated
  using (till_uid = auth.uid() or fran_uid = auth.uid())
  with check (till_uid = auth.uid() or fran_uid = auth.uid());

drop policy if exists inbjudan_avbryt on spel_inbjudan;
create policy inbjudan_avbryt on spel_inbjudan
  for delete to authenticated using (fran_uid = auth.uid());

-- ── 3. REALTID ──────────────────────────────────────────────────────────────
-- Utan detta måste mottagaren ladda om hubben för att se en inbjudan. Klienten
-- klarar båda (den hämtar alltid vid sidvisning) men kortet ska helst dyka upp
-- medan telefonen ligger på bordet.
alter publication supabase_realtime add table spel_inbjudan;
