import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { QuakeStore } from './db';
import type { Quake } from './scrape';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tímabundin mappa fyrir próf sem þurfa grunn á diski (flutningur á eldri gagnaskipun)
const tmp = mkdtempSync(join(tmpdir(), 'quake-test-'));

const T0 = Date.UTC(2026, 9, 4, 15, 10, 1) / 1000;
const ALL = { from: 0, to: 2e9, lat: [60, 70] as [number, number], lon: [-30, 0] as [number, number], minMag: -10, maxMag: 10 };

function quake(over: Partial<Quake> = {}): Quake {
  const q = { time: T0, lat: 63.652, lon: -19.128, depth: 5.2, mag: 0.8, quality: 50, distKm: 6.2, direction: 'ANA', refPlace: 'Goðabungu', ...over };
  return { ...q, raw: JSON.stringify(q) };
}

test('upsert dedupes slightly revised quakes', () => {
  const store = new QuakeStore(':memory:');
  const a = quake();
  expect(store.upsert([a], 1000)).toEqual({ inserted: 1, updated: 0, withdrawn: 0 });
  expect(store.upsert([a], 1300)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  // Endurmetinn: aðeins færður og stærð breytt
  expect(store.upsert([quake({ lat: a.lat + 0.01, mag: 1.1, time: a.time + 1 })], 1600)).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  const rows = store.query(ALL).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].mag).toBe(1.1);
  expect(store.history(rows[0]).map((r) => [r.seenAt, r.mag])).toEqual([[1000, 0.8], [1600, 1.1]]);
});

test('reviewed quake replaces the automatic one it supersedes', () => {
  const store = new QuakeStore(':memory:');
  const older = quake({ time: T0 - 3600, lat: 64.0, lon: -21.0 }); // annar skjálfti, helst óbreyttur
  const auto = quake();
  store.upsert([older, auto], 1000);
  // Yfirfarinn: 14 s fyrr, 12 km í burtu, 4 km dýpra, 0.5 stærri, gæði 99. Sjálfvirka hvarf úr straumnum.
  const reviewed = quake({ time: T0 - 14, lat: 63.76, lon: -19.19, depth: 9.3, mag: 1.3, quality: 99 });
  expect(store.upsert([older, reviewed], 1300)).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  const rows = store.query(ALL).rows;
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ time: T0 - 14, mag: 1.3, quality: 99 });
  expect(store.history(rows[1]).map((r) => r.quality)).toEqual([50, 99]);
});

test('automatic detection deleted by the office is withdrawn, and restored if it comes back', () => {
  const store = new QuakeStore(':memory:');
  const older = quake({ time: T0 - 3600, lat: 64.0, lon: -21.0 });
  const bogus = quake();
  store.upsert([older, bogus], 1000);
  expect(store.upsert([older], 1300)).toEqual({ inserted: 0, updated: 0, withdrawn: 1 });
  expect(store.query(ALL).rows).toHaveLength(1);
  expect(store.stats()).toMatchObject({ total: 1, withdrawn: 1 });
  // Kom aftur (t.d. tímabundin bilun í straumnum): engin tvítekning og röðin birtist aftur
  expect(store.upsert([older, bogus], 1600)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows).toHaveLength(2);
});

test('rows older than the feed window are not withdrawn', () => {
  const store = new QuakeStore(':memory:');
  const old = quake({ time: T0 - 50 * 3600 });
  const recent = quake();
  store.upsert([old, recent], 1000);
  // Straumurinn nær ekki lengur yfir gamla skjálftann
  expect(store.upsert([recent], 1300)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows).toHaveLength(2);
});

test('twin quakes seconds apart stay separate rows', () => {
  const store = new QuakeStore(':memory:');
  const a = quake();
  const b = quake({ time: T0 + 2, mag: 0.3 });
  expect(store.upsert([a, b], 1000)).toEqual({ inserted: 2, updated: 0, withdrawn: 0 });
  expect(store.upsert([a, b], 1300)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows.map((q) => q.mag)).toEqual([0.8, 0.3]);
});

test('a genuinely new quake far from any vanished row is inserted', () => {
  const store = new QuakeStore(':memory:');
  const older = quake({ time: T0 - 3600, lat: 64.0, lon: -21.0 });
  const bogus = quake();
  store.upsert([older, bogus], 1000);
  const elsewhere = quake({ time: T0 + 30, lat: 66.2, lon: -17.0 });
  expect(store.upsert([older, elsewhere], 1300)).toEqual({ inserted: 1, updated: 0, withdrawn: 1 });
});

test('migrates a database from before revisions were tracked', () => {
  const path = `${tmp}/migrate.db`;
  const old = new Database(path, { create: true });
  old.exec(`
    CREATE TABLE quakes (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, depth REAL NOT NULL,
      mag REAL NOT NULL, quality REAL, dist_km REAL, direction TEXT, ref_place TEXT, first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL, raw TEXT);
    INSERT INTO quakes (time, lat, lon, depth, mag, quality, first_seen, updated_at) VALUES (${T0}, 63.652, -19.128, 5.2, 0.8, 50, 900, 950)`);
  old.close();
  const store = new QuakeStore(path);
  const [row] = store.query(ALL).rows;
  expect(row.mag).toBe(0.8);
  expect(store.history(row).map((r) => [r.seenAt, r.quality])).toEqual([[950, 50]]);
  // Keyrist aftur án þess að breyta sögunni
  new QuakeStore(path);
  expect(store.history(row)).toHaveLength(1);
  expect(store.upsert([quake({ mag: 1.0, quality: 99 })], 1300)).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  expect(store.history(store.query(ALL).rows[0])).toHaveLength(2);
});

const catalog = (over: Partial<Quake> = {}): Quake => quake({ quality: 99, distKm: null, direction: null, refPlace: null, region: 'Mýrdalsjökull', eventId: 'IMO2026tloqyo', ...over });

test('catalogue import revises a feed row, keeps its place text and records the event id', () => {
  const store = new QuakeStore(':memory:');
  store.upsert([quake()], 1000);
  // Yfirfarinn í skránni: 9 s fyrr, færður, stærri. Bakfylling fellir ekkert út.
  const other = catalog({ time: T0 - 7200, lat: 65, lon: -17, eventId: 'IMO2026other' });
  const r = store.upsert([other, catalog({ time: T0 - 9, lat: 63.70, lon: -19.20, mag: 1.4 })], 1300, { from: T0 - 86400, to: T0 + 86400, source: 'catalog' });
  expect(r).toEqual({ inserted: 1, updated: 1, withdrawn: 0 });
  const [, row] = store.query(ALL).rows;
  expect(row).toMatchObject({ time: T0 - 9, mag: 1.4, quality: 99, distKm: 6.2, direction: 'ANA', refPlace: 'Goðabungu', region: 'Mýrdalsjökull', eventId: 'IMO2026tloqyo' });
  // Næsta sókn úr straumnum með sömu gildi (án svæðis/auðkennis) breytir engu
  expect(store.upsert([quake({ time: T0 - 9, lat: 63.70, lon: -19.20, mag: 1.4, quality: 99 })], 1600)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows[1]).toMatchObject({ region: 'Mýrdalsjökull', eventId: 'IMO2026tloqyo' });
  expect(store.history(store.query(ALL).rows[1])).toHaveLength(2);
});

test('catalogue rows are matched by event id even when relocated far', () => {
  const store = new QuakeStore(':memory:');
  store.upsert([catalog()], 1000, { source: 'catalog' });
  expect(store.upsert([catalog({ time: T0 + 90, lat: 64.5, lon: -18.0, mag: 2.0 })], 1300, { source: 'catalog' })).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  expect(store.query(ALL).rows).toHaveLength(1);
  // Straumurinn sér sama skjálfta síðar og bætir við örnefni
  expect(store.upsert([quake({ time: T0 + 90, lat: 64.5, lon: -18.0, mag: 2.0, quality: 99, refPlace: 'Bárðarbungu' })], 1600)).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  expect(store.query(ALL).rows[0]).toMatchObject({ refPlace: 'Bárðarbungu', region: 'Mýrdalsjökull', eventId: 'IMO2026tloqyo' });
});

test('the catalogue never withdraws rows the feed has shown', () => {
  const store = new QuakeStore(':memory:');
  store.upsert([quake({ time: T0 - 3600 }), quake()], 1000);
  expect(store.upsert([catalog({ time: T0 - 3600 })], 1300, { from: T0 - 86400, to: T0 + 86400, source: 'catalog' })).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  expect(store.query(ALL).rows).toHaveLength(2);
});

test('the catalogue withdraws its own automatic rows that vanish, e.g. a duplicate solution', () => {
  const store = new QuakeStore(':memory:');
  const win = { from: T0 - 86400, to: T0 + 86400, source: 'catalog' as const };
  store.upsert([catalog({ quality: 50, eventId: 'IMO2026dupA' }), catalog({ time: T0 + 1, lat: 63.60, quality: 50, mag: -0.2, eventId: 'IMO2026dupB' })], 1000, win);
  expect(store.query(ALL).rows).toHaveLength(2);
  // Yfirferð sameinar lausnirnar: A yfirfarin, B hverfur úr skránni
  expect(store.upsert([catalog({ quality: 99, eventId: 'IMO2026dupA' })], 1300, win)).toEqual({ inserted: 0, updated: 1, withdrawn: 1 });
  expect(store.query(ALL).rows.map((q) => q.eventId)).toEqual(['IMO2026dupA']);
  // Yfirfarin röð sem hverfur úr skránni er látin í friði (skráin getur vantað skjálfta)
  expect(store.upsert([], 1600, win)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.upsert([catalog({ time: T0 - 7200, lat: 65, lon: -17, eventId: 'IMO2026other' })], 1900, win)).toEqual({ inserted: 1, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows).toHaveLength(2);
});

test('automatic data never overwrites a reviewed row', () => {
  const store = new QuakeStore(':memory:');
  store.upsert([quake({ quality: 99, mag: 1.2 })], 1000);
  // Skráin er á eftir og hefur enn sjálfvirku gildin
  expect(store.upsert([catalog({ quality: 50, mag: 0.8 })], 1300, { source: 'catalog' })).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows[0]).toMatchObject({ quality: 99, mag: 1.2 });
  // Yfirfarin gildi úr skránni uppfæra hins vegar
  expect(store.upsert([catalog({ quality: 99, mag: 1.3 })], 1600, { source: 'catalog' })).toEqual({ inserted: 0, updated: 1, withdrawn: 0 });
  expect(store.query(ALL).rows[0]).toMatchObject({ quality: 99, mag: 1.3, eventId: 'IMO2026tloqyo' });
});

test('catalogue-only rows inside the feed window are not withdrawn by the feed', () => {
  const store = new QuakeStore(':memory:');
  const feedQuake = quake({ time: T0 - 600 });
  store.upsert([feedQuake], 1000);
  // Skráin hefur skjálfta með neikvæða stærð sem straumurinn sýnir aldrei
  store.upsert([catalog({ mag: -0.3, quality: 50, eventId: 'IMO2026tiny' })], 1300, { source: 'catalog' });
  expect(store.upsert([feedQuake], 1600)).toEqual({ inserted: 0, updated: 0, withdrawn: 0 });
  expect(store.query(ALL).rows).toHaveLength(2);
  // Straumurinn fellir út það sem hann sýndi sjálfur, en ekki skjálfta skrárinnar á sama tímabili
  expect(store.upsert([quake({ time: T0 - 900, lat: 65, lon: -17 })], 1900)).toEqual({ inserted: 1, updated: 0, withdrawn: 1 });
  expect(store.query(ALL).rows.map((q) => q.mag)).toEqual([0.8, -0.3]);
});

test('a reviewed catalogue entry restores a withdrawn row, an automatic one does not', () => {
  const store = new QuakeStore(':memory:');
  const anchor = quake({ time: T0 - 600, lat: 65, lon: -17 });
  store.upsert([anchor, quake()], 1000);
  expect(store.upsert([anchor], 1300)).toEqual({ inserted: 0, updated: 0, withdrawn: 1 });
  store.upsert([catalog({ quality: 50, mag: 0.9 })], 1600, { source: 'catalog' });
  expect(store.query(ALL).rows).toHaveLength(1);
  store.upsert([catalog({ quality: 99, mag: 0.9 })], 1900, { source: 'catalog' });
  expect(store.query(ALL).rows).toHaveLength(2);
});

test('schema v1 databases drop the duplicated current revision once', () => {
  const path = `${tmp}/v1.db`;
  const v1 = new QuakeStore(path);
  v1.db.exec('PRAGMA user_version = 1');
  v1.upsert([quake()], 1000);
  v1.upsert([quake({ mag: 1.1 })], 1300);
  // Gamla lagið: hver útgáfa í revisions, líka sú núverandi
  v1.db.exec(`INSERT INTO revisions (quake_id, seen_at, time, lat, lon, depth, mag, quality, raw)
    SELECT id, updated_at, time, lat, lon, depth, mag, quality, raw FROM quakes`);
  expect(v1.db.query('SELECT count(*) n FROM revisions').get()).toEqual({ n: 2 });
  v1.db.close();
  const v2 = new QuakeStore(path);
  expect(v2.db.query('SELECT count(*) n FROM revisions').get()).toEqual({ n: 1 });
  expect(v2.history(v2.query(ALL).rows[0]).map((r) => [r.seenAt, r.mag])).toEqual([[1000, 0.8], [1300, 1.1]]);
  expect(v2.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(2);
});

test('query thins by magnitude when a period has more than MAX_ROWS quakes', () => {
  const store = new QuakeStore(':memory:');
  const many = Array.from({ length: 30 }, (_, i) => quake({ time: T0 + i * 60, mag: (i % 10) / 10, eventId: 'IMO' + i }));
  store.upsert(many, 1000, { source: 'catalog' });
  const { rows, total } = store.query(ALL);
  expect(total).toBe(30);
  expect(rows).toHaveLength(30);
  // Lítið hámark til prófunar
  const { MAX_ROWS } = require('./db');
  expect(MAX_ROWS).toBeGreaterThan(30);
});

test('query filters by depth', () => {
  const store = new QuakeStore(':memory:');
  store.upsert([quake({ depth: 2 }), quake({ time: T0 + 600, lat: 64.5, lon: -17.5, depth: 12 })], 1000);
  expect(store.query({ ...ALL, maxDepth: 5 }).rows.map((r) => r.depth)).toEqual([2]);
  expect(store.query({ ...ALL, minDepth: 5 }).rows.map((r) => r.depth)).toEqual([12]);
  expect(store.query(ALL).rows).toHaveLength(2);
});
