import { Database } from 'bun:sqlite';
import type { Quake } from './scrape';

export type QuakeFilter = {
  from: number; // unix sekúndur
  to: number;
  lat: [number, number];
  lon: [number, number];
  minMag: number;
  maxMag: number;
  minDepth?: number; // km, sjálfgefið engin mörk
  maxDepth?: number;
};

export type Revision = Quake & { seenAt: number };

export type UpsertOptions = {
  // Tímabil sem færslurnar ná yfir, unix sekúndur [from, to). Raðir í grunni á tímabilinu sem vantar
  // í færslurnar teljast horfnar. Sjálfgefið frá elstu færslu og áfram (straumurinn á vedur.is).
  from?: number;
  to?: number;
  // Hver heimild fellir aðeins út það sem hún ein hefur sýnt:
  // 'feed' (sjálfgefið): straumurinn á vedur.is skráir last_seen og fellir út raðir sem hann hefur sýnt
  //   (last_seen) en vantar nú.
  // 'catalog': skjálftaskráin sýnir skjálfta sem straumurinn sýnir ekki (neikvæð stærð, tvöfaldar
  //   sjálfvirkar lausnir) og getur verið á eftir honum, svo hún snertir ekki last_seen og fellir aðeins
  //   út sjálfvirkar raðir sem straumurinn hefur aldrei sýnt. Yfirfarinn skjálfti úr skránni afturkallar útfellingu.
  source?: 'feed' | 'catalog';
};

const FIELDS = ['time', 'lat', 'lon', 'depth', 'mag', 'quality', 'distKm', 'direction', 'refPlace', 'region', 'eventId', 'raw'] as const;
const CORE = ['time', 'lat', 'lon', 'depth', 'mag', 'quality'] as const;
// Fjarlægð/stefna/örnefni koma aðeins úr straumnum, svæðisheiti aðeins úr skjálftaskrá; hvort tveggja
// er aðeins borið saman og skrifað þegar uppruninn gefur það, svo heimildirnar yfirskrifi ekki hver aðra.
const PLACE = ['distKm', 'direction', 'refPlace'] as const;
const REV_COLUMNS = 'time, lat, lon, depth, mag, quality, dist_km AS distKm, direction, ref_place AS refPlace, raw';
const COLUMNS = REV_COLUMNS.replace(', raw', ', region, event_id AS eventId, raw');
const QUERY_COLUMNS = COLUMNS.replace(', raw', '');
// Sjálfvirk (óyfirfarin) stærð M4+ sem er orðin eldri en 30 daga verður ekki yfirfarin héðan af og er
// oft röng: í gömlu SIL-skránni eru t.d. „M9,1“ 2003 og tugir M5,5–7,3 sumarið 2005, flestir á sjálfgefnu
// 5,2 km dýpi. Slíkir skjálftar eru sýndir og taldir, en stærðin ekki tekin trúanleg (kort, tölur, hitakort).
// Ekki er hægt að fella þá út: raunverulegi Ölfusskjálftinn 2008 er t.d. aðeins sjálfvirkur M6,1 í skránni.
export const SUSPECT = { mag: 4, ageDays: 30 };
export const suspectSql = (cutoff: string) => `(coalesce(quality, 0) < 90 AND mag >= ${SUSPECT.mag} AND time < ${cutoff})`;
export const suspectCutoff = (now = Date.now()) => Math.floor(now / 1000) - SUSPECT.ageDays * 86400;

// Hámark í einni fyrirspurn; sé meira á tímabilinu eru stærstu skjálftarnir sýndir (sjá query)
export const MAX_ROWS = 100_000;

// Sami skjálfti, lítillega endurmetinn (t.d. sjálfvirk endurstaðsetning þegar fleiri stöðvar skila gögnum).
// Þröngt, því í hrinu geta margir skjálftar verið á sama bletti með stuttu millibili.
const NEAR = { time: 3, lat: 0.05, lon: 0.1 };
// Yfirfarinn skjálfti (gæði 90+) sem birtist í sömu sókn og sjálfvirka staðsetningin (gæði 50) hverfur.
// Sjálfvirkri staðsetningu getur skeikað um tugi km og nokkrar sekúndur, svo hér er leitað víðar,
// en aðeins meðal raða sem hurfu úr straumnum í þessari sókn.
const REVISED = { time: 60, lat: 0.3, lon: 0.6 };

type Stats = { total: number; withdrawn: number; first: number | null; lastChange: number | null };
const STATS_TTL = 10 * 60e3;

type Row = Quake & { id: number; withdrawnAt: number | null; lastSeen: number | null; updatedAt: number };
const ROW_COLUMNS = `id, withdrawn_at AS withdrawnAt, last_seen AS lastSeen, updated_at AS updatedAt, ${COLUMNS}`;
// Útgáfa gagnaskipunar (PRAGMA user_version): 2 = revisions geymir aðeins eldri útgáfur, ekki þá núverandi
const SCHEMA_VERSION = 2;

export class QuakeStore {
  db: Database;
  // Kallað eftir hverja upsert með tímum (unix s) raða sem breyttust, birtust eða hurfu; sjá heat.ts
  onChange?: (times: number[]) => void;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    // Bakfylling og þjónn skrifa í sama grunn; bíða eftir hinum frekar en að fá "database is locked"
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quakes (
        id           INTEGER PRIMARY KEY,
        time         INTEGER NOT NULL,
        lat          REAL NOT NULL,
        lon          REAL NOT NULL,
        depth        REAL NOT NULL,
        mag          REAL NOT NULL,
        quality      REAL,
        dist_km      REAL,
        direction    TEXT,
        ref_place    TEXT,
        raw          TEXT,
        region       TEXT,
        event_id     TEXT,
        first_seen   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        last_seen    INTEGER,
        withdrawn_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS quakes_time ON quakes(time);
      CREATE TABLE IF NOT EXISTS revisions (
        id        INTEGER PRIMARY KEY,
        quake_id  INTEGER NOT NULL REFERENCES quakes(id),
        seen_at   INTEGER NOT NULL,
        time      INTEGER NOT NULL,
        lat       REAL NOT NULL,
        lon       REAL NOT NULL,
        depth     REAL NOT NULL,
        mag       REAL NOT NULL,
        quality   REAL,
        dist_km   REAL,
        direction TEXT,
        ref_place TEXT,
        raw       TEXT
      );
      CREATE INDEX IF NOT EXISTS revisions_quake ON revisions(quake_id);
    `);
    this.migrate();
  }

  private migrate() {
    const cols = this.db.query<{ name: string }, []>('PRAGMA table_info(quakes)').all().map((c) => c.name);
    if (!cols.includes('raw')) this.db.exec('ALTER TABLE quakes ADD COLUMN raw TEXT');
    if (!cols.includes('last_seen')) {
      this.db.exec('ALTER TABLE quakes ADD COLUMN last_seen INTEGER');
      this.db.exec('UPDATE quakes SET last_seen = updated_at');
    }
    if (!cols.includes('withdrawn_at')) this.db.exec('ALTER TABLE quakes ADD COLUMN withdrawn_at INTEGER');
    if (!cols.includes('region')) this.db.exec('ALTER TABLE quakes ADD COLUMN region TEXT');
    if (!cols.includes('event_id')) this.db.exec('ALTER TABLE quakes ADD COLUMN event_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS quakes_event ON quakes(event_id)');
    // Fram að útgáfu 2 var hver útgáfa geymd í revisions, líka sú núverandi, sem tvítók alla raðir;
    // nú er aðeins það sem hefur verið yfirskrifað geymt þar. Nýjasta útgáfan í revisions er sú núverandi.
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    if (version < 2) {
      this.db.exec('DELETE FROM revisions WHERE id IN (SELECT max(id) FROM revisions GROUP BY quake_id)');
    }
    if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // Straumurinn frá vedur.is er heildarlisti síðustu ~48 klst. Veðurstofan yfirfer sjálfvirkar
  // staðsetningar (gæði 50) eftir á: þá breytast tími, staður, dýpi og stærð, gæði verða 90+,
  // og rangar sjálfvirkar greiningar eru felldar út. Því er hver röð rakin á þrjá vegu:
  //  1. Færsla sem er nánast eins og röð í grunni uppfærir hana (smávægileg endurmat).
  //  2. Ný færsla sem birtist um leið og röð í grunni hverfur úr straumnum, nálægt í tíma og rúmi,
  //     er sami skjálfti endurmetinn: röðin er uppfærð frekar en að tvítaka skjálftann.
  //  3. Röð sem hverfur úr straumnum án þess að nokkuð komi í staðinn er merkt felld út
  //     (withdrawn_at) og birtist ekki, en merkið er hreinsað ef hún kemur aftur.
  // Yfirskrifaðar útgáfur eru geymdar í revisions (sjá history).
  // Færslur úr skjálftaskrá bera auðkenni (eventId) sem gengur fyrir nálægðarleit.
  upsert(quakes: Quake[], now = Math.floor(Date.now() / 1000), opts: UpsertOptions = {}) {
    const counts = { inserted: 0, updated: 0, withdrawn: 0 };
    if (quakes.length === 0) return counts;
    const changedTimes: number[] = [];
    const feed = (opts.source ?? 'feed') === 'feed';

    const byEvent = this.db.query<Row, [string]>(`SELECT ${ROW_COLUMNS} FROM quakes WHERE event_id = ?1`);
    const findNear = this.db.query<Row, [number, number, number]>(`
      SELECT ${ROW_COLUMNS} FROM quakes
      WHERE time BETWEEN ?1 - ${NEAR.time} AND ?1 + ${NEAR.time}
        AND abs(lat - ?2) < ${NEAR.lat} AND abs(lon - ?3) < ${NEAR.lon}
      ORDER BY abs(time - ?1) LIMIT 5`);
    const expected = this.db.query<Row, [number, number]>(`
      SELECT ${ROW_COLUMNS} FROM quakes WHERE time >= ?1 AND time < ?2 AND withdrawn_at IS NULL`);
    const insert = this.db.query<{ id: number }, Record<string, unknown>>(`
      INSERT INTO quakes (time, lat, lon, depth, mag, quality, dist_km, direction, ref_place, region, event_id, raw, first_seen, updated_at, last_seen)
      VALUES ($time, $lat, $lon, $depth, $mag, $quality, $distKm, $direction, $refPlace, $region, $eventId, $raw, $now, $now, $lastSeen)
      RETURNING id`);
    const update = this.db.query(`
      UPDATE quakes SET time = $time, lat = $lat, lon = $lon, depth = $depth, mag = $mag, quality = $quality,
        dist_km   = CASE WHEN $refPlace IS NULL THEN dist_km   ELSE $distKm    END,
        direction = CASE WHEN $refPlace IS NULL THEN direction ELSE $direction END,
        ref_place = COALESCE($refPlace, ref_place),
        region    = COALESCE($region, region),
        event_id  = COALESCE($eventId, event_id),
        raw = $raw, updated_at = $now,
        last_seen    = COALESCE($lastSeen, last_seen),
        withdrawn_at = CASE WHEN $lastSeen IS NOT NULL OR $quality >= 90 THEN NULL ELSE withdrawn_at END
      WHERE id = $id`);
    const touch = this.db.query('UPDATE quakes SET last_seen = $now, withdrawn_at = NULL WHERE id = $id');
    const withdraw = this.db.query('UPDATE quakes SET withdrawn_at = $now WHERE id = $id');
    // Útgáfan sem er verið að yfirskrifa, með tímanum sem hún var skráð
    const revision = this.db.query(`
      INSERT INTO revisions (quake_id, seen_at, time, lat, lon, depth, mag, quality, dist_km, direction, ref_place, raw)
      VALUES ($id, $seenAt, $time, $lat, $lon, $depth, $mag, $quality, $distKm, $direction, $refPlace, $raw)`);
    const supersede = (row: Row) => revision.run({
      $id: row.id, $seenAt: row.updatedAt, $time: row.time, $lat: row.lat, $lon: row.lon, $depth: row.depth, $mag: row.mag,
      $quality: row.quality, $distKm: row.distKm, $direction: row.direction, $refPlace: row.refPlace, $raw: row.raw,
    });

    const lastSeen = feed ? now : null;
    const params = (q: Quake) => ({ ...Object.fromEntries(FIELDS.map((k) => ['$' + k, q[k] ?? null])), $lastSeen: lastSeen });
    const changed = (row: Quake, q: Quake) =>
      CORE.some((k) => row[k] !== q[k]) ||
      (q.refPlace != null && PLACE.some((k) => row[k] !== q[k])) ||
      (q.region != null && row.region !== q.region);
    const downgrade = (row: Quake, q: Quake) => (row.quality ?? 0) >= 90 && (q.quality ?? 0) < 90;
    // Hver heimild fellir aðeins út það sem hún ein hefur sýnt, sjá UpsertOptions
    const canWithdraw = (r: Row) => (feed ? r.lastSeen != null : r.lastSeen == null && (r.quality ?? 0) < 90);
    const from = opts.from ?? quakes.reduce((m, q) => Math.min(m, q.time), Infinity);
    const to = opts.to ?? Number.MAX_SAFE_INTEGER;

    this.db.transaction(() => {
      const seen = new Set<number>();
      const fresh: Quake[] = [];
      for (const q of quakes) {
        // Tveir skjálftar í sömu færslum geta ekki verið sama röðin (tvíburar með 1–2 s millibili)
        let hit = q.eventId ? byEvent.get(q.eventId) : null;
        if (!hit || seen.has(hit.id)) hit = findNear.all(q.time, q.lat, q.lon).find((r) => !seen.has(r.id)) ?? null;
        if (!hit) {
          fresh.push(q);
          continue;
        }
        seen.add(hit.id);
        // Yfirfarin gildi víkja ekki fyrir sjálfvirkum: skjálftaskráin getur verið á eftir straumnum
        if (changed(hit, q) && !downgrade(hit, q)) {
          supersede(hit);
          update.run({ ...params(q), $now: now, $id: hit.id });
          counts.updated++;
          changedTimes.push(hit.time, q.time);
        } else if (feed) {
          touch.run({ $now: now, $id: hit.id });
          if (hit.withdrawnAt != null) changedTimes.push(hit.time);
        }
      }

      // Raðir á tímabilinu sem færslurnar náðu ekki til: endurmetnar undir öðrum tíma/stað, eða horfnar
      const gone = expected.all(from, to).filter((r) => !seen.has(r.id));
      for (const q of fresh.sort((a, b) => a.time - b.time)) {
        let best = -1;
        for (let i = 0; i < gone.length; i++) {
          const r = gone[i];
          if (downgrade(r, q)) continue;
          if (Math.abs(r.time - q.time) > REVISED.time || Math.abs(r.lat - q.lat) >= REVISED.lat || Math.abs(r.lon - q.lon) >= REVISED.lon) continue;
          if (best < 0 || Math.abs(r.time - q.time) < Math.abs(gone[best].time - q.time)) best = i;
        }
        if (best >= 0) {
          const [r] = gone.splice(best, 1);
          supersede(r);
          update.run({ ...params(q), $now: now, $id: r.id });
          counts.updated++;
          changedTimes.push(r.time, q.time);
        } else {
          insert.get({ ...params(q), $now: now });
          counts.inserted++;
          changedTimes.push(q.time);
        }
      }
      for (const r of gone) {
        if (!canWithdraw(r)) continue;
        withdraw.run({ $now: now, $id: r.id });
        counts.withdrawn++;
        changedTimes.push(r.time);
      }
    })();
    if (changedTimes.length) {
      this.statsMemo = null;
      this.onChange?.(changedTimes);
    }
    return counts;
  }

  // Skjálftar í tímaröð. Séu fleiri en MAX_ROWS á tímabilinu eru þeir stærstu teknir, svo stórar
  // hrinur séu sýndar í heild (minnstu skjálftarnir falla út) frekar en að elsti hlutinn vanti.
  query(f: QuakeFilter, now = Date.now()): { rows: Quake[]; total: number } {
    const where = `
      WHERE withdrawn_at IS NULL
        AND time BETWEEN $from AND $to
        AND lat BETWEEN $latMin AND $latMax AND lon BETWEEN $lonMin AND $lonMax
        AND mag BETWEEN $minMag AND $maxMag
        AND depth BETWEEN $minDepth AND $maxDepth`;
    const params = {
      $from: f.from, $to: f.to,
      $latMin: f.lat[0], $latMax: f.lat[1], $lonMin: f.lon[0], $lonMax: f.lon[1],
      $minMag: f.minMag, $maxMag: f.maxMag,
      $minDepth: f.minDepth ?? -1e6, $maxDepth: f.maxDepth ?? 1e6,
    };
    const total = this.db.query<{ n: number }, Record<string, number>>(`SELECT count(*) AS n FROM quakes ${where}`).get(params)!.n;
    const order = total > MAX_ROWS ? 'mag DESC, time DESC' : 'time';
    // raw er ekki sent í viðmótið og að sleppa því styttir stórar fyrirspurnir um þriðjung
    const rows = this.db.query<Quake, Record<string, number>>(
      `SELECT ${QUERY_COLUMNS}, ${suspectSql(String(suspectCutoff(now)))} AS suspect FROM quakes ${where} ORDER BY ${order} LIMIT ${MAX_ROWS}`,
    ).all(params);
    if (total > MAX_ROWS) rows.sort((a, b) => a.time - b.time);
    return { rows, total };
  }

  // Allar útgáfur skjálfta sem er nú með gefin gildi, elsta fyrst: yfirskrifaðar útgáfur úr revisions
  // (seen_at = hvenær sú útgáfa var skráð) og núverandi röð (seen_at = updated_at) síðast
  history(q: Pick<Quake, 'time' | 'lat' | 'lon'>): Revision[] {
    return this.db.query<Revision, [number, number, number]>(`
      WITH q AS (SELECT id FROM quakes WHERE time = ?1 AND lat = ?2 AND lon = ?3 ORDER BY withdrawn_at IS NOT NULL LIMIT 1)
      SELECT seen_at AS seenAt, ${REV_COLUMNS}, 0 AS cur, id AS ord FROM revisions WHERE quake_id = (SELECT id FROM q)
      UNION ALL
      SELECT updated_at AS seenAt, ${REV_COLUMNS}, 1 AS cur, 0 AS ord FROM quakes WHERE id = (SELECT id FROM q)
      ORDER BY cur, seenAt, ord`).all(q.time, q.lat, q.lon);
  }

  // Talning yfir alla raðir tekur ~0,5 s með 1,2 milljón skjálftum og /api/status kallar á þetta úr hverjum
  // opnum flipa á mínútu fresti, svo niðurstaðan er geymd þar til gögn breytast. Önnur ferli (bakfylling)
  // breyta grunninum án þess að þetta ferli viti, svo hún er líka endurnýjuð á STATS_TTL fresti.
  private statsMemo: { at: number; value: Stats } | null = null;

  stats(): Stats {
    if (this.statsMemo && Date.now() - this.statsMemo.at < STATS_TTL) return this.statsMemo.value;
    const value = this.db.query<Stats, []>(`
      SELECT count(*) FILTER (WHERE withdrawn_at IS NULL) AS total,
             count(*) FILTER (WHERE withdrawn_at IS NOT NULL) AS withdrawn,
             min(time) AS first, max(updated_at) AS lastChange
      FROM quakes`).get()!;
    this.statsMemo = { at: Date.now(), value };
    return value;
  }

  // Elsti skjálfti, um vísi (hratt, ólíkt stats)
  firstTime(): number | null {
    return this.db.query<{ t: number | null }, []>('SELECT min(time) AS t FROM quakes').get()!.t;
  }
}
