import { expect, test } from 'bun:test';
import { QuakeStore } from './db';
import { parseFeed } from './scrape';

const SAMPLE = `var q = [
{'t':new Date(2026,10-1,4,15,10,1),'a':'0.08328','lat':'63,652','lon':'-19,128','dep':'5,2','s':'0,8','q':'50,0','dL':'6,2','dD':'ANA ','dR':'Goðabungu'},
{'t':new Date(2026,1-1,31,23,59,59),'lat':'63,866','lon':'-22,437','dep':'12,0','s':'-0,3','q':'90,0','dL':'1,0','dD':'N','dR':'Grindavík'},
{'foo':'bar'}
];`;

test('parses vedur.is quake objects', () => {
  const q = parseFeed(SAMPLE);
  expect(q).toHaveLength(2);
  expect(q[0]).toEqual({
    time: Date.UTC(2026, 9, 4, 15, 10, 1) / 1000,
    lat: 63.652, lon: -19.128, depth: 5.2, mag: 0.8, quality: 50,
    distKm: 6.2, direction: 'ANA', refPlace: 'Goðabungu',
  });
  expect(new Date(q[1].time * 1000).toISOString()).toBe('2026-01-31T23:59:59.000Z');
  expect(q[1].mag).toBe(-0.3);
});

test('upsert dedupes revised quakes', () => {
  const store = new QuakeStore(':memory:');
  const [a] = parseFeed(SAMPLE);
  expect(store.upsert([a])).toEqual({ inserted: 1, updated: 0 });
  expect(store.upsert([a])).toEqual({ inserted: 0, updated: 0 });
  // Endurmetinn: aðeins færður og stærð breytt
  expect(store.upsert([{ ...a, lat: a.lat + 0.01, mag: 1.1, time: a.time + 1 }])).toEqual({ inserted: 0, updated: 1 });
  const rows = store.query({ from: 0, to: 2e9, lat: [60, 70], lon: [-30, 0], minMag: -10, maxMag: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0].mag).toBe(1.1);
});
