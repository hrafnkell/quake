# Jarðskjálftakort

Sækir jarðskjálftagögn frá [vedur.is](https://www.vedur.is/skjalftar-og-eldgos/jardskjalftar) á 5 mínútna fresti,
geymir þau í SQLite og birtir á korti, tímalínu, í 3D og í töflu.

- `src/server.ts`: Bun vefþjónn, API og reglubundin sókn
- `src/scrape.ts`: les skjálftagögn úr síðu Veðurstofunnar
- `src/db.ts`: SQLite geymsla (`bun:sqlite`), sameinar endurmetna skjálfta
- `src/regions.ts`: svæði (rammar) og örnefni fyrir 3D sýn
- `public/`: viðmót (Leaflet + Plotly frá CDN, engin bygging)
- `public/iceland.json`: strandlína og jöklar fyrir 3D sýn, úr [Natural Earth](https://www.naturalearthdata.com/) 1:10m (public domain)

vedur.is sýnir aðeins u.þ.b. síðustu 48 klst, svo saga safnast upp frá því þjónninn fer í gang.
Allt landið er geymt; svæði eru bara sía.

## Keyrsla

```bash
bun run dev     # http://localhost:3000, endurræsir við breytingar
bun test
```

Stillingar með umhverfisbreytum: `PORT` (3000), `HOST` (127.0.0.1), `DB_PATH` (`data/quakes.db`), `POLL_SECONDS` (300).

## API

- `GET /api/quakes?region=reykjanes&from=<ms>&to=<ms>&minMag=&maxMag=`
- `GET /api/regions`
- `GET /api/status`: síðasta sókn, villur, fjöldi í grunni

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
