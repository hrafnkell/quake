# Jarðskjálftakort

Sækir jarðskjálftagögn frá [vedur.is](https://www.vedur.is/skjalftar-og-eldgos/jardskjalftar) á 5 mínútna fresti,
geymir þau í SQLite og birtir á korti, tímalínu, í 3D og í töflu.

- `src/server.ts`: Bun vefþjónn, API og reglubundin sókn
- `src/scrape.ts`: les skjálftagögn úr síðu Veðurstofunnar
- `src/db.ts`: SQLite geymsla (`bun:sqlite`), rekur endurmat og útfellingar Veðurstofunnar (sjá neðar)
- `src/catalog.ts`: les skjálftaskrá Veðurstofunnar (api.vedur.is/quakes, sama heimild og skjalftalisa.vedur.is)
- `src/backfill.ts`: bakfyllir grunninn úr skjálftaskránni, sjá neðar
- `src/regions.ts`: svæði (rammar) og örnefni fyrir 3D sýn
- `src/events.ts`: eldgos og stórir atburðir frá 1991, handskráðir; merki á tímalínu og korti og bókamerki
  („Atburðir“) sem stilla svæði og tímabil á aðdragandann. Bættu við eða lagaðu að vild
- `public/`: viðmót (Leaflet + Plotly frá CDN, engin bygging). Kortið teiknar skjálfta á canvas (tugþúsundir á
  ~100 ms), annaðhvort sem punkta eða þéttleika í sexhyrningum (lógaritmískur kvarði). Afspilun (▶ undir korti/3D,
  bilslá) birtir skjálfta tímabilsins í tímaröð á 30 s (stillanlegt). Festur skjálfti M ≥ 3 býður upp á
  eftirskjálftagreiningu: Omori-tíðnifall (p), Gutenberg–Richter (b, Mc) og stærsta eftirskjálfta (Båth)
- `public/iceland.json`: strandlína og jöklar fyrir 3D sýn, úr [Natural Earth](https://www.naturalearthdata.com/) 1:10m (public domain)

vedur.is sýnir aðeins u.þ.b. síðustu 48 klst, svo saga safnast upp frá því þjónninn fer í gang;
eldri saga fæst með bakfyllingu úr skjálftaskránni. Allt landið er geymt; svæði eru bara sía.

## Bakfylling úr skjálftaskrá

[Skjálftaskrá Veðurstofunnar](https://api.vedur.is/quakes/) (opin API, CC BY 4.0) er sama heimild og
skjalftalisa.vedur.is og nær aftur til janúar 1991. Sjálfvirkar staðsetningar eru þar með
`evaluation_mode=automatic` (gæði 50 hér) og yfirfarnar `manual` (gæði 99). Fram að 3. febrúar 2026 er
sótt úr SIL-kerfinu, eftir það úr SeisComP, eins og Skjálftalísa gerir.

```bash
bun run backfill 2026-09-01                 # frá dagsetningu til núna
bun run backfill 2026-09-01 2026-10-01      # tímabil [frá, til)
bun run backfill --days 30
ssh elmer 'cd ~/srv/quake && DB_PATH=data/quakes.db ~/.bun/bin/bun run backfill --days 30'
```

Sótt er í vikubútum með 2 s hléi milli beiðna (u.þ.b. 2–3 þúsund skjálftar á mánuði í rólegu ári, tugir
þúsunda í hrinum; 2020 til dagsins í dag eru ~300 beiðnir). Beiðnir eru ekki keyrðar samhliða, og 429/5xx
fá vaxandi bið. Óhætt er að keyra aftur og meðan þjónninn keyrir; ef hætt er vegna villu er sagt frá hvaða
dagsetningu skal halda áfram. Skjálftar sem eru þegar í grunni úr straumnum eru
uppfærðir með yfirförnum gildum og fá auðkenni skrárinnar (`event_id`) og svæðisheiti (`region`), en
fjarlægð/stefna/örnefni úr straumnum er haldið. Skráin getur verið á eftir straumnum eða vantað
stöku skjálfta sem hann sýnir, og sýnir aðra sem straumurinn sýnir ekki (t.d. neikvæða stærð), svo
hver heimild fellir aðeins út það sem hún ein hefur sýnt: straumurinn það sem hann hefur sýnt (`last_seen`),
skráin aðeins sjálfvirkar raðir sem straumurinn hefur aldrei sýnt (t.d. tvöfalda sjálfvirka lausn sem
hverfur við yfirferð). Sjálfvirk gildi yfirskrifa aldrei yfirfarin. Gildi eru námunduð að nákvæmni straumsins (heilar sekúndur, 3 og 1 aukastafur) svo sami
skjálfti úr báðum áttum valdi ekki sífelldum uppfærslum; full nákvæmni er í `raw`.

## Endurmat

Nýir skjálftar í straumnum eru sjálfvirkar staðsetningar (gæði 50). Veðurstofan yfirfer þá eftir á,
yfirleitt á virkum dögum: tími, staður, dýpi og stærð breytast (oft um sekúndur og kílómetra),
gæði verða 90+, og rangar sjálfvirkar greiningar eru felldar út. Grunnurinn rekur þetta í hverri sókn:

- Færsla sem er nánast eins og röð í grunni (±3 s, ~5 km) uppfærir hana.
- Ný færsla sem birtist um leið og röð hverfur úr straumnum, innan ±60 s og ~30 km, er sami skjálfti
  endurmetinn og uppfærir röðina frekar en að tvítaka hann.
- Röð sem hverfur úr straumnum án þess að nokkuð komi í staðinn fær `withdrawn_at` og birtist ekki
  í API; merkið er hreinsað ef hún kemur aftur. Raðir eldri en elsta færsla straumsins eru látnar í friði.

Allar útgáfur hverrar raðar eru geymdar í `revisions` (með `seen_at`), svo upprunalegu sjálfvirku gildin
glatast ekki og hægt er að skoða hvernig endurmat Veðurstofunnar lítur út:

```sql
SELECT q.id, datetime(r.seen_at,'unixepoch') seen, datetime(r.time,'unixepoch') t, r.lat, r.lon, r.depth, r.mag, r.quality
FROM revisions r JOIN quakes q ON q.id = r.quake_id
WHERE q.id IN (SELECT quake_id FROM revisions GROUP BY quake_id HAVING count(*) > 1) ORDER BY q.id, r.seen_at;
```

## Keyrsla

```bash
bun run dev     # http://localhost:3000, endurræsir við breytingar
bun test
```

Stillingar með umhverfisbreytum: `PORT` (3000), `HOST` (127.0.0.1), `DB_PATH` (`data/quakes.db`), `POLL_SECONDS` (300),
`CATALOG_SYNC_HOURS` (6, 0 slekkur) og `CATALOG_SYNC_DAYS` (14): þjónninn samstillir síðustu daga við skjálftaskrána
(sjá neðar) mínútu eftir ræsingu og svo reglulega, svo yfirferð Veðurstofunnar skili sér þótt hún komi dögum síðar.
`FEED_FALLBACK_AFTER` (3): bregðist sókn á vedur.is svona oft í röð (t.d. síðan breytt eða horfin) er skjálftaskráin
sótt í staðinn fyrir síðustu 48 klst í hverri sókn, þar til síðan svarar aftur; `/api/status` sýnir `source: "catalog"`
og viðmótið gul merki á meðan. `FEED_URL` yfirskrifar slóð síðunnar (til prófunar).

## API

- `GET /api/quakes?region=reykjanes&from=<ms>&to=<ms>&minMag=&maxMag=&minDepth=&maxDepth=` (dýpi í km): dálkasnið (sjá `src/encode.ts`): hver reitur
  er fylki, tími sem mismunur í sekúndum, hnit ×1000, dýpt/stærð ×10, strengir sem vísar í `strings`. Helmingi minna
  þjappað en raðir og fljótara að lesa. `&format=rows` skilar hlutum (`t` í ms, `lat`, `lon`, `depth`, `mag`, `q`, `dist`, `dir`, `ref`, `region`).
  Mest 100 000 skjálftar í svari; séu fleiri á tímabilinu eru þeir stærstu sendir og `total` segir heildarfjöldann.
  Tímabil má mest vera 366 dagar (stærri fyrirspurnir tóku 2–3 s og stöðvuðu þjóninn á meðan); notið hitakortið fyrir lengri tíma.
  `sus` = 1: óyfirfarin sjálfvirk stærð M4+ eldri en 30 daga, líklega röng (sjá `SUSPECT` í `src/db.ts`); viðmótið sýnir hana sem M4.
- `GET /api/heat?from=<ár>&to=<ár>`: hitakort, ~1 km reitir (`y` = ⌊breidd×100⌋, `x` = ⌊lengd×50⌋) með fjölda (`count`),
  samanlagðri orku sem jafngildri stærð ×100 (`meq`, log10(Σ10^(1,5·M))/1,5) og stærsta skjálfta ×10 (`mx`).
  Liðin ár eru reiknuð einu sinni og geymd í `heat_cells`; ár er reiknað aftur ef skjálfti á því breytist. Sjá `src/heat.ts`.
- `GET /api/heat/years?region=`: fjöldi og jafngild stærð hvers árs á svæðinu
- `GET /api/regions`: svæði, örnefni og atburðir
- `GET /api/status`: síðasta sókn, villur, fjöldi í grunni (`total` virkir, `withdrawn` felldir út), `catalog` (síðasta samstilling við skjálftaskrá)

## Uppsetning

Keyrir sem systemd **notendaþjónusta** á `elmer` í `~/srv/quake`, á porti 3060 (aðeins 127.0.0.1).

```bash
deploy/deploy.sh                 # sjálfgefið: elmer srv/quake
deploy/deploy.sh annar-hysill srv/quake
```

Skriftan afritar kóðann með rsync, setur `deploy/quake.service` í `~/.config/systemd/user/`,
og (endur)ræsir þjónustuna. `data/` (gagnagrunnurinn) og `.env` eru aldrei yfirskrifuð.
Stillingar má yfirskrifa í `~/srv/quake/.env` (t.d. `POLL_SECONDS=120`).

Krefst Bun í `~/.bun/bin/bun` og að linger sé virkt (`loginctl enable-linger`) svo þjónustan
keyri án innskráningar. Fyrir opinbera slóð, bæta `deploy/Caddyfile` við `/etc/caddy/Caddyfile`.

```bash
ssh elmer journalctl --user -u quake -f
ssh elmer 'sqlite3 ~/srv/quake/data/quakes.db ".backup quakes-backup.db"'
```
