import { Database } from 'bun:sqlite';
import type { Quake } from './scrape';

export type QuakeFilter = {
  from: number; // unix sekúndur
  to: number;
  lat: [number, number];
  lon: [number, number];
  minMag: number;
  maxMag: number;
};

const COLUMNS = 'time, lat, lon, depth, mag, quality, dist_km AS distKm, direction, ref_place AS refPlace, raw';
export const MAX_ROWS = 50_000;

export class QuakeStore {
  db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quakes (
        id         INTEGER PRIMARY KEY,
        time       INTEGER NOT NULL,
        lat        REAL NOT NULL,
        lon        REAL NOT NULL,
        depth      REAL NOT NULL,
        mag        REAL NOT NULL,
        quality    REAL,
        dist_km    REAL,
        direction  TEXT,
        ref_place  TEXT,
        first_seen INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quakes_time ON quakes(time);
    `);
    const cols = this.db.query<{ name: string }, []>('PRAGMA table_info(quakes)').all().map((c) => c.name);
    if (!cols.includes('raw')) this.db.exec('ALTER TABLE quakes ADD COLUMN raw TEXT');
  }

  // Veðurstofan endurmetur skjálfta (staðsetning/stærð breytist lítillega), svo sami
  // skjálfti er fundinn eftir nálægð í tíma og rúmi frekar en nákvæmri samsvörun.
  upsert(quakes: Quake[]) {
    const find = this.db.query<Quake & { id: number }, [number, number, number]>(`
      SELECT id, ${COLUMNS} FROM quakes
      WHERE time BETWEEN ?1 - 3 AND ?1 + 3 AND abs(lat - ?2) < 0.05 AND abs(lon - ?3) < 0.1
      ORDER BY abs(time - ?1) LIMIT 1`);
    const insert = this.db.query(`
      INSERT INTO quakes (time, lat, lon, depth, mag, quality, dist_km, direction, ref_place, raw, first_seen, updated_at)
      VALUES ($time, $lat, $lon, $depth, $mag, $quality, $distKm, $direction, $refPlace, $raw, $now, $now)`);
    const update = this.db.query(`
      UPDATE quakes SET time = $time, lat = $lat, lon = $lon, depth = $depth, mag = $mag, quality = $quality,
        dist_km = $distKm, direction = $direction, ref_place = $refPlace, raw = $raw, updated_at = $now
      WHERE id = $id`);

    const fields = ['time', 'lat', 'lon', 'depth', 'mag', 'quality', 'distKm', 'direction', 'refPlace', 'raw'] as const;
    let inserted = 0, updated = 0;
    const now = Math.floor(Date.now() / 1000);

    this.db.transaction(() => {
      for (const q of quakes) {
        const params = Object.fromEntries(fields.map((k) => ['$' + k, q[k]]));
        const existing = find.get(q.time, q.lat, q.lon);
        if (!existing) {
          insert.run({ ...params, $now: now });
          inserted++;
        } else if (fields.some((k) => existing[k] !== q[k])) {
          update.run({ ...params, $now: now, $id: existing.id });
          updated++;
        }
      }
    })();
    return { inserted, updated };
  }

  query(f: QuakeFilter): Quake[] {
    return this.db.query<Quake, Record<string, number>>(`
      SELECT ${COLUMNS} FROM quakes
      WHERE time BETWEEN $from AND $to
        AND lat BETWEEN $latMin AND $latMax AND lon BETWEEN $lonMin AND $lonMax
        AND mag BETWEEN $minMag AND $maxMag
      ORDER BY time DESC LIMIT ${MAX_ROWS}`).all({
      $from: f.from, $to: f.to,
      $latMin: f.lat[0], $latMax: f.lat[1], $lonMin: f.lon[0], $lonMax: f.lon[1],
      $minMag: f.minMag, $maxMag: f.maxMag,
    }).reverse();
  }

  stats() {
    return this.db.query<{ total: number; first: number | null; lastChange: number | null }, []>(
      'SELECT count(*) AS total, min(time) AS first, max(updated_at) AS lastChange FROM quakes').get()!;
  }
}
