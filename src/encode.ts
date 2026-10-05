import type { Quake } from './scrape';

// Dálkasnið fyrir /api/quakes: hver reitur er fylki yfir alla skjálfta, tölur heiltölur (tími sem
// mismunur frá fyrri skjálfta í sekúndum, hnit ×1000, dýpt og stærð ×10) og strengir sem vísar í
// sameiginlega orðabók. Gzip þjappar þessu í u.þ.b. helming af raðasniði og JSON.parse er helmingi
// fljótari, sem munar um þegar ár með tugþúsundum skjálfta er sótt. -1 þýðir „vantar“.
export type Columns = {
  n: number;
  t: number[]; // sekúndur, mismunur frá fyrri (fyrsti frá 0)
  lat: number[]; // ×1000
  lon: number[]; // ×1000
  depth: number[]; // ×10
  mag: number[]; // ×10
  q: (number | null)[];
  dist: number[]; // ×10, -1 = vantar
  dir: number[]; // vísir í strings, -1 = vantar
  ref: number[];
  region: number[];
  strings: string[];
};

export function encodeColumns(rows: Quake[]): Columns {
  const dict = new Map<string, number>();
  const idx = (s: string | null | undefined) => {
    if (s == null) return -1;
    let i = dict.get(s);
    if (i == null) dict.set(s, (i = dict.size));
    return i;
  };
  const c: Columns = { n: rows.length, t: [], lat: [], lon: [], depth: [], mag: [], q: [], dist: [], dir: [], ref: [], region: [], strings: [] };
  let prev = 0;
  for (const r of rows) {
    c.t.push(r.time - prev);
    prev = r.time;
    c.lat.push(Math.round(r.lat * 1000));
    c.lon.push(Math.round(r.lon * 1000));
    c.depth.push(Math.round(r.depth * 10));
    c.mag.push(Math.round(r.mag * 10));
    c.q.push(r.quality);
    c.dist.push(r.distKm == null ? -1 : Math.round(r.distKm * 10));
    c.dir.push(idx(r.direction));
    c.ref.push(idx(r.refPlace));
    c.region.push(idx(r.region));
  }
  c.strings = [...dict.keys()];
  return c;
}

// Sama snið og viðmótið notar (public/app.js, decodeColumns); hér til að prófa hringferðina
export type ClientQuake = { t: number; lat: number; lon: number; depth: number; mag: number; q: number | null; dist: number | null; dir: string | null; ref: string | null; region: string | null };

export function decodeColumns(c: Columns): ClientQuake[] {
  const out: ClientQuake[] = new Array(c.n);
  const str = (i: number) => (i < 0 ? null : c.strings[i]);
  let t = 0;
  for (let i = 0; i < c.n; i++) {
    t += c.t[i];
    out[i] = {
      t: t * 1000, lat: c.lat[i] / 1000, lon: c.lon[i] / 1000, depth: c.depth[i] / 10, mag: c.mag[i] / 10, q: c.q[i],
      dist: c.dist[i] < 0 ? null : c.dist[i] / 10, dir: str(c.dir[i]), ref: str(c.ref[i]), region: str(c.region[i]),
    };
  }
  return out;
}

// Raðasnið, eins og API skilaði áður (?format=rows)
export const toRows = (rows: Quake[]): ClientQuake[] => rows.map((q) => ({
  t: q.time * 1000, lat: q.lat, lon: q.lon, depth: q.depth, mag: q.mag,
  q: q.quality, dist: q.distKm, dir: q.direction, ref: q.refPlace, region: q.region ?? null,
}));
