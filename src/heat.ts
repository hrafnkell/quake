import { suspectCutoff, suspectSql, SUSPECT, type QuakeStore } from './db';
import type { Region } from './regions';

// Hitakort: samanlögð orka og fjöldi skjálfta í ~1 km reitum, fyrir hvert ár.
//
// Orka skjálfta vex um ×32 á hverja stærðareiningu (E ∝ 10^(1,5·M)), svo í hverjum reit er summan
// Σ 10^(1,5·M) geymd og birt sem „jafngild stærð“ M = log10(Σ) / 1,5: einn skjálfti af þeirri stærð
// losar jafn mikla orku og allir skjálftar reitsins saman. Fjöldi og orka leggjast saman, svo hvert ár
// er reiknað einu sinni, geymt í heat_cells og lagt saman fyrir lengri tímabil. Ár er reiknað aftur ef
// skjálfti á því breytist (onChange í QuakeStore). Yfirstandandi ár er reiknað í minni og endurnýjað
// þegar ný gögn koma.

// Reitir á gráðu: 0,01° breidd × 0,02° lengd ≈ 1,1 × 1,0 km á 64°N
export const CELLS_PER_DEG = { lat: 100, lon: 50 };

export type Cell = { y: number; x: number; n: number; e: number; mx: number };
export type YearTotal = { year: number; n: number; e: number };

const yearStart = (year: number) => Date.UTC(year, 0, 1) / 1000;
const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();

export class HeatCache {
  private store: QuakeStore;
  private now: () => number;
  // Yfirstandandi ár, reiknað þegar beðið er um það eftir breytingu
  private live: { year: number; cells: Cell[] } | null = null;
  // Summur liðinna ára (dýrar, ~1 s fyrir öll ár) í minni; hreinsaðar aðeins þegar liðið ár breytist,
  // ekki við hvern nýjan skjálfta á yfirstandandi ári
  private past = new Map<string, Cell[] | YearTotal[]>();
  // Hækkar við hverja breytingu, viðmót og minni nota það til að vita hvort eitthvað sé úrelt
  version = 0;

  constructor(store: QuakeStore, now = () => Date.now()) {
    this.store = store;
    this.now = now;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS heat_cells (
        year INTEGER NOT NULL,
        y    INTEGER NOT NULL,
        x    INTEGER NOT NULL,
        n    INTEGER NOT NULL,
        e    REAL NOT NULL,
        mx   REAL NOT NULL,
        PRIMARY KEY (year, y, x)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS heat_years (year INTEGER PRIMARY KEY, computed_at INTEGER NOT NULL);
    `);
    store.onChange = (times) => this.invalidate(times);
  }

  currentYear() {
    return new Date(this.now()).getUTCFullYear();
  }

  firstYear() {
    const first = this.store.firstTime();
    return first == null ? this.currentYear() : yearOf(first);
  }

  // Bakfylling keyrir í öðru ferli og hreinsar ár beint úr heat_years; þá eru summur í minni úreltar.
  // Fyrirspurnin er á töflu með einni röð á ári, svo hún kostar ekkert.
  private stamp() {
    return this.store.db.query<{ stamp: string }, []>(
      "SELECT count(*) || ':' || coalesce(sum(computed_at), 0) AS stamp FROM heat_years").get()!.stamp;
  }
  private checkPastStamp() {
    const s = this.stamp();
    if (s !== this.pastStamp) {
      this.past.clear();
      this.pastStamp = s;
      this.version++;
    }
  }
  private pastStamp = '';

  // Reitir á tímabilinu [from, to). Grunsamleg stærð (sjá SUSPECT) telst M4 svo röng „M9“ yfirgnæfi ekki allt.
  private aggregate(from: number, to: number): Cell[] {
    return this.store.db.query<Cell, Record<string, number>>(`
      SELECT CAST(floor(lat * ${CELLS_PER_DEG.lat}) AS INTEGER) AS y, CAST(floor(lon * ${CELLS_PER_DEG.lon}) AS INTEGER) AS x,
             count(*) AS n, sum(pow(10, 1.5 * m)) AS e, max(m) AS mx
      FROM (
        SELECT lat, lon, CASE WHEN ${suspectSql('$cutoff')} THEN ${SUSPECT.mag} ELSE mag END AS m
        FROM quakes WHERE withdrawn_at IS NULL AND time >= $from AND time < $to
      )
      GROUP BY y, x`).all({ $from: from, $to: to, $cutoff: suspectCutoff(this.now()) });
  }

  isCached(year: number) {
    return this.store.db.query('SELECT 1 FROM heat_years WHERE year = ?').get(year) != null;
  }

  // Reiknar liðið ár og geymir, ef það er ekki þegar til
  ensureYear(year: number) {
    if (year >= this.currentYear()) throw new Error(`${year} er ekki liðið`);
    if (this.isCached(year)) return;
    const cells = this.aggregate(yearStart(year), yearStart(year + 1));
    const db = this.store.db;
    const insert = db.query('INSERT INTO heat_cells (year, y, x, n, e, mx) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      db.query('DELETE FROM heat_cells WHERE year = ?').run(year);
      for (const c of cells) insert.run(year, c.y, c.x, c.n, c.e, c.mx);
      db.query('INSERT OR REPLACE INTO heat_years (year, computed_at) VALUES (?, ?)').run(year, Math.floor(this.now() / 1000));
    })();
    // Okkar eigin viðbót: summur sem þegar eru í minni innihalda ekki þetta ár og eru því enn réttar
    this.pastStamp = this.stamp();
  }

  private liveCells(): Cell[] {
    const year = this.currentYear();
    if (this.live?.year !== year) this.live = { year, cells: this.aggregate(yearStart(year), yearStart(year + 1)) };
    return this.live.cells;
  }

  invalidate(times: number[]) {
    const current = this.currentYear();
    const years = new Set(times.map(yearOf));
    const db = this.store.db;
    for (const y of years) {
      if (y >= current) this.live = null;
      else {
        db.query('DELETE FROM heat_years WHERE year = ?').run(y);
        db.query('DELETE FROM heat_cells WHERE year = ?').run(y);
        this.past.clear();
      }
    }
    this.version++;
  }

  // Reitir fyrir árin [fromYear, toYear], lögð saman
  cells(fromYear: number, toYear: number): Cell[] {
    this.checkPastStamp();
    const current = this.currentYear();
    const lastPast = Math.min(toYear, current - 1);
    const key = `cells:${fromYear}:${lastPast}`;
    let past = this.past.get(key) as Cell[] | undefined;
    if (!past) {
      for (let y = fromYear; y <= lastPast; y++) this.ensureYear(y);
      past = lastPast >= fromYear
        ? this.store.db.query<Cell, [number, number]>(`
            SELECT y, x, sum(n) AS n, sum(e) AS e, max(mx) AS mx FROM heat_cells
            WHERE year BETWEEN ?1 AND ?2 GROUP BY y, x`).all(fromYear, lastPast)
        : [];
      this.past.set(key, past);
    }
    if (toYear < current) return past;
    // Bæta yfirstandandi ári við
    const merged = new Map<number, Cell>();
    const cellKey = (c: Cell) => c.y * 100_000 + c.x;
    for (const c of past) merged.set(cellKey(c), { ...c });
    for (const c of this.liveCells()) {
      const m = merged.get(cellKey(c));
      if (!m) merged.set(cellKey(c), { ...c });
      else {
        m.n += c.n;
        m.e += c.e;
        if (c.mx > m.mx) m.mx = c.mx;
      }
    }
    return [...merged.values()];
  }

  // Fjöldi og orka hvers árs innan svæðis, fyrir súlurit
  years(region: Region): YearTotal[] {
    this.checkPastStamp();
    const current = this.currentYear();
    const first = this.firstYear();
    const box = cellBox(region);
    const inBox = (c: Cell) => c.y >= box.y0 && c.y <= box.y1 && c.x >= box.x0 && c.x <= box.x1;
    const key = `years:${box.y0}:${box.y1}:${box.x0}:${box.x1}:${first}:${current}`;
    let past = this.past.get(key) as YearTotal[] | undefined;
    if (!past) {
      for (let y = first; y < current; y++) this.ensureYear(y);
      past = this.store.db.query<YearTotal, Record<string, number>>(`
        SELECT year, sum(n) AS n, sum(e) AS e FROM heat_cells
        WHERE y BETWEEN $y0 AND $y1 AND x BETWEEN $x0 AND $x1
        GROUP BY year ORDER BY year`).all({ $y0: box.y0, $y1: box.y1, $x0: box.x0, $x1: box.x1 });
      this.past.set(key, past);
    }
    const live = { year: current, n: 0, e: 0 };
    for (const c of this.liveCells()) if (inBox(c)) { live.n += c.n; live.e += c.e; }
    // Ár án skjálfta á svæðinu fá núll svo súluritið sé samfellt
    const byYear = new Map(past.map((p) => [p.year, p]));
    const out: YearTotal[] = [];
    for (let y = first; y < current; y++) out.push(byYear.get(y) ?? { year: y, n: 0, e: 0 });
    out.push(live);
    return out;
  }

  // Reiknar þau ár sem vantar, eitt í einu með hléum, svo fyrsta heimsókn í hitakortið bíði ekki
  async warm(pauseMs = 200) {
    const current = this.currentYear();
    for (let y = this.firstYear(); y < current; y++) {
      if (this.isCached(y)) continue;
      this.ensureYear(y);
      await Bun.sleep(pauseMs);
    }
  }
}

// Reitir sem svæðið nær yfir (svæði án ramma ná yfir allt)
export function cellBox(r: Pick<Region, 'lat' | 'lon'>) {
  return {
    y0: Math.floor(r.lat[0] * CELLS_PER_DEG.lat), y1: Math.floor(r.lat[1] * CELLS_PER_DEG.lat),
    x0: Math.floor(r.lon[0] * CELLS_PER_DEG.lon), x1: Math.floor(r.lon[1] * CELLS_PER_DEG.lon),
  };
}

// Dálkasnið fyrir /api/heat: jafngild stærð (log10(e)/1,5) ×100 og stærsta stærð ×10 sem heiltölur
export function encodeCells(cells: Cell[]) {
  const out = { n: cells.length, y: [] as number[], x: [] as number[], count: [] as number[], meq: [] as number[], mx: [] as number[] };
  for (const c of cells) {
    out.y.push(c.y);
    out.x.push(c.x);
    out.count.push(c.n);
    out.meq.push(Math.round((Math.log10(c.e) / 1.5) * 100));
    out.mx.push(Math.round(c.mx * 10));
  }
  return out;
}

export const meq = (e: number) => (e > 0 ? Math.log10(e) / 1.5 : null);
