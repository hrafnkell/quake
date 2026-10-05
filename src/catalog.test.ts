import { expect, test } from 'bun:test';
import { parseCatalog, systemFor, windows, SIL_CUTOFF } from './catalog';

const FEATURES = [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-19.240908, 63.709034] },
    properties: { event_id: 'IMO2026tloqyo', time: '2026-10-03T10:02:10.740929Z', magnitude: 0.895782, depth: 14.126914, region: 'Mýrdalsjökull', type: 'earthquake', evaluation_mode: 'manual', updated_time: '2026-10-03T10:36:06.6165Z' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-18.72, 66.672] },
    properties: { event_id: 'IMO2026abcdef', time: '2026-10-02T21:11:50.999Z', magnitude: -0.25, depth: 3.74, region: 'Norðurland', type: null, evaluation_mode: 'automatic' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-21.577656, 65.229668] },
    properties: { event_id: 'IMO2026rlydkf', time: '2026-09-05T06:55:27.403477Z', magnitude: 1.215657, depth: 0, region: 'Vestfirðir', type: 'not existing', evaluation_mode: 'manual' } },
] as any;

test('maps catalogue features to feed precision and quality', () => {
  const q = parseCatalog(FEATURES, 'seiscomp');
  expect(q).toHaveLength(2); // 'not existing' sleppt
  expect(q[0]).toMatchObject({
    time: Date.UTC(2026, 9, 3, 10, 2, 10) / 1000, lat: 63.709, lon: -19.241, depth: 14.1, mag: 0.9, quality: 99,
    distKm: null, direction: null, refPlace: null, region: 'Mýrdalsjökull', eventId: 'IMO2026tloqyo',
  });
  expect(JSON.parse(q[0].raw)).toMatchObject({ event_id: 'IMO2026tloqyo', lat: 63.709034, lon: -19.240908, system: 'seiscomp' });
  // Brot úr sekúndu er skorið af eins og í straumnum
  expect(q[1]).toMatchObject({ time: Date.UTC(2026, 9, 2, 21, 11, 50) / 1000, mag: -0.3, depth: 3.7, quality: 50 });
});

test('picks the system by date and splits chunks at the SIL cutoff', () => {
  expect(systemFor(SIL_CUTOFF - 1)).toBe('sil');
  expect(systemFor(SIL_CUTOFF)).toBe('seiscomp');
  const c = [...windows(SIL_CUTOFF - 86400, SIL_CUTOFF + 10 * 86400, 7 * 86400)];
  expect(c.map((x) => [x.system, (x.to - x.from) / 86400])).toEqual([['sil', 1], ['seiscomp', 7], ['seiscomp', 3]]);
  expect([...windows(0, 86400, 7 * 86400, 'seiscomp')]).toEqual([{ from: 0, to: 86400, system: 'seiscomp' }]);
});
