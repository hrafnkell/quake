import { expect, test } from 'bun:test';
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
    raw: expect.any(String),
  });
  // Allir reitir geymdir nema 'a' (aldur, breytist við hverja sókn)
  expect(JSON.parse(q[0].raw)).toEqual({
    lat: '63,652', lon: '-19,128', dep: '5,2', s: '0,8', q: '50,0', dL: '6,2', dD: 'ANA ', dR: 'Goðabungu', t: '2026,10-1,4,15,10,1',
  });
  expect(new Date(q[1].time * 1000).toISOString()).toBe('2026-01-31T23:59:59.000Z');
  expect(q[1].mag).toBe(-0.3);
});
