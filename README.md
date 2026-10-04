# Jarðskjálftakort

Sækir jarðskjálftagögn frá [vedur.is](https://www.vedur.is/skjalftar-og-eldgos/jardskjalftar) á 5 mínútna fresti,
geymir þau í SQLite og birtir á korti, tímalínu, í 3D og í töflu.

- `src/server.ts`: Bun vefþjónn, API og reglubundin sókn
- `src/scrape.ts`: les skjálftagögn úr síðu Veðurstofunnar
- `src/db.ts`: SQLite geymsla (`bun:sqlite`), sameinar endurmetna skjálfta
- `src/regions.ts`: svæði (rammar) og örnefni fyrir 3D sýn
- `public/`: viðmót (Leaflet + Plotly frá CDN, engin bygging)

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

## Uppsetning á VM

Einu sinni, á VM:

```bash
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin quake
sudo mkdir -p /opt/quake
```

Af þinni vél (afritar kóða, `quake.service` þarf að setja upp í fyrsta skipti):

```bash
deploy/deploy.sh notandi@vm
ssh notandi@vm 'sudo cp /opt/quake/deploy/quake.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now quake'
```

Þjónninn hlustar aðeins á 127.0.0.1, settu reverse proxy fyrir framan, t.d. Caddy (`deploy/Caddyfile`) sem sér um HTTPS.

Annálar: `journalctl -u quake -f`. Afrit af gögnum: `sqlite3 /var/lib/quake/quakes.db ".backup quakes-backup.db"`.
