import { expect, test } from 'bun:test';
import { decodeColumns, encodeColumns, toRows } from './encode';
import type { Quake } from './scrape';

const rows: Quake[] = [
  { time: 1791190000, lat: 63.652, lon: -19.128, depth: 5.2, mag: 0.8, quality: 50, distKm: 6.2, direction: 'ANA', refPlace: 'Goðabungu', region: null, raw: '' },
  { time: 1791190007, lat: 63.7, lon: -19.0, depth: 0, mag: -0.3, quality: 99, distKm: null, direction: null, refPlace: null, region: 'Mýrdalsjökull', raw: '' },
  { time: 1791193600, lat: 66.001, lon: -18.5, depth: 12.3, mag: 3.1, quality: null, distKm: 1.0, direction: 'N', refPlace: 'Goðabungu', region: 'Mýrdalsjökull', raw: '' },
];

test('columns round-trip to the row format', () => {
  const c = encodeColumns(rows);
  expect(c.n).toBe(3);
  expect(c.t).toEqual([1791190000, 7, 3593]);
  expect(c.lat).toEqual([63652, 63700, 66001]);
  expect(c.mag).toEqual([8, -3, 31]);
  expect(c.strings).toEqual(['ANA', 'Goðabungu', 'Mýrdalsjökull', 'N']);
  expect(c.dist).toEqual([62, -1, 10]);
  expect(decodeColumns(c)).toEqual(toRows(rows));
  expect(decodeColumns(encodeColumns([]))).toEqual([]);
});
