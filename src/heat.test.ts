import { expect, test } from 'bun:test';
import { QuakeStore } from './db';
import { cellBox, HeatCache, meq } from './heat';
import type { Quake } from './scrape';

const NOW = Date.UTC(2026, 9, 5, 12);
const at = (iso: string) => Date.parse(iso) / 1000;

function quake(over: Partial<Quake>): Quake {
  const q = { time: at('2024-06-01T00:00:00Z'), lat: 63.889, lon: -22.371, depth: 4, mag: 1, quality: 99, distKm: null, direction: null, refPlace: null, ...over };
  return { ...q, raw: JSON.stringify(q) };
}

function setup(quakes: Quake[]) {
  const store = new QuakeStore(':memory:');
  const heat = new HeatCache(store, () => NOW);
  store.upsert(quakes, NOW / 1000, { source: 'catalog', from: 0, to: NOW / 1000 });
  return { store, heat };
}

test('energy is summed as equivalent magnitude per cell', () => {
  // Tveir M3 í sama reit: tvöföld orka M3 ≈ M3,2
  const { heat } = setup([quake({ mag: 3 }), quake({ mag: 3, time: at('2024-06-02T00:00:00Z') })]);
  const [c] = heat.cells(2024, 2024);
  expect(c.n).toBe(2);
  expect(meq(c.e)).toBeCloseTo(3 + Math.log10(2) / 1.5, 6);
  expect(c.mx).toBe(3);
});

test('old automatic magnitudes of M4+ count as M4', () => {
  const { heat } = setup([
    quake({ mag: 9.1, quality: 50 }), // óyfirfarin „M9,1“
    quake({ mag: 4.5, quality: 99, lat: 64.5, lon: -17.5, time: at('2024-07-01T00:00:00Z') }), // yfirfarin
  ]);
  const cells = heat.cells(2024, 2024).sort((a, b) => a.y - b.y);
  expect(cells[0].mx).toBe(4);
  expect(meq(cells[0].e)).toBeCloseTo(4, 6);
  expect(cells[1].mx).toBe(4.5);
});

test('recent automatic magnitudes are trusted until they are 30 days old', () => {
  const { heat } = setup([quake({ mag: 5, quality: 50, time: NOW / 1000 - 86400 })]);
  expect(heat.cells(2026, 2026)[0].mx).toBe(5);
});

test('past years are cached and recomputed when a quake in them changes', () => {
  const { store, heat } = setup([quake({ mag: 2 })]);
  expect(heat.isCached(2024)).toBe(false);
  expect(heat.cells(2024, 2024)[0].n).toBe(1);
  expect(heat.isCached(2024)).toBe(true);
  store.upsert([quake({ mag: 2.5, lat: 65.0, lon: -16.5, time: at('2024-09-01T00:00:00Z') })], NOW / 1000, { source: 'catalog', from: at('2024-09-01T00:00:00Z'), to: at('2024-09-02T00:00:00Z') });
  expect(heat.isCached(2024)).toBe(false);
  expect(heat.cells(2024, 2024).reduce((s, c) => s + c.n, 0)).toBe(2);
});

test('ranges ending in the current year add live cells to cached years', () => {
  const { store, heat } = setup([quake({ mag: 2 }), quake({ mag: 2, time: at('2026-03-01T00:00:00Z') })]);
  expect(heat.cells(2024, 2026)[0].n).toBe(2);
  store.upsert([quake({ mag: 1, time: at('2026-04-01T00:00:00Z') })], NOW / 1000, { source: 'catalog', from: at('2026-04-01T00:00:00Z'), to: at('2026-04-02T00:00:00Z') });
  expect(heat.cells(2024, 2026)[0].n).toBe(3);
  expect(heat.isCached(2024)).toBe(true);
});

test('year totals cover every year and respect the region box', () => {
  const { heat } = setup([
    quake({ mag: 2, time: at('2023-01-01T00:00:00Z') }),
    quake({ mag: 2, time: at('2025-01-01T00:00:00Z'), lat: 65.05, lon: -16.75 }), // Askja
  ]);
  const reykjanes = { lat: [63.5, 64.5] as [number, number], lon: [-23.5, -21.0] as [number, number] };
  expect(heat.years({ id: 'r', name: 'R', ...reykjanes }).map((y) => [y.year, y.n])).toEqual([[2023, 1], [2024, 0], [2025, 0], [2026, 0]]);
  expect(cellBox(reykjanes)).toEqual({ y0: 6350, y1: 6450, x0: -1175, x1: -1050 });
});
