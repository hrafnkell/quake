import type { Quake } from './scrape';

// Skjálftaskrá Veðurstofunnar, sama heimild og skjalftalisa.vedur.is. Opin API, CC BY 4.0.
// Skjöl: https://api.vedur.is/quakes/
export const CATALOG_URL = 'https://api.vedur.is/quakes/events';

// 3. febrúar 2026 tók SeisComP við af SIL sem úrvinnslukerfi Veðurstofunnar. Skjálftalísa sækir
// eldri skjálfta úr SIL (nær aftur til 1991) og nýrri úr SeisComP; það sama er gert hér.
export const SIL_CUTOFF = Date.UTC(2026, 1, 3) / 1000;
export type CatalogSystem = 'sil' | 'seiscomp';
export const systemFor = (time: number): CatalogSystem => (time < SIL_CUTOFF ? 'sil' : 'seiscomp');

export type CatalogFeature = {
  geometry: { coordinates: [number, number] } | null;
  properties: {
    event_id: string;
    time: string;
    magnitude: number;
    depth: number;
    evaluation_mode: 'manual' | 'automatic';
    type?: string | null;
    region?: string | null;
    [k: string]: unknown;
  };
};

const round = (v: number, digits: number) => Number(v.toFixed(digits));

export function parseCatalog(features: CatalogFeature[], system: CatalogSystem): Quake[] {
  const out: Quake[] = [];
  for (const f of features) {
    const p = f.properties;
    // Yfirfarið og dæmt rangt: ekki skjálfti
    if (p.type === 'not existing') continue;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    const ms = Date.parse(p.time);
    if (lat == null || lon == null || !Number.isFinite(ms) || typeof p.magnitude !== 'number' || typeof p.depth !== 'number') continue;
    out.push({
      // Sama nákvæmni sem straumurinn á vedur.is (heilar sekúndur, 3 aukastafir, 1 aukastafur),
      // svo sami skjálfti úr báðum áttum beri sömu gildi og valdi ekki sífelldum uppfærslum
      time: Math.floor(ms / 1000),
      lat: round(lat, 3),
      lon: round(lon, 3),
      depth: round(p.depth, 1),
      mag: round(p.magnitude, 1),
      // Straumurinn gefur gæði 50 fyrir sjálfvirka staðsetningu og 99 fyrir yfirfarna
      quality: p.evaluation_mode === 'manual' ? 99 : 50,
      distKm: null,
      direction: null,
      refPlace: null,
      region: p.region ?? null,
      eventId: p.event_id,
      raw: JSON.stringify({ ...p, lat, lon, system }),
    });
  }
  return out;
}

const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 19) + 'Z';

export type CatalogWindow = { from: number; to: number; system: CatalogSystem };

// Skiptir tímabili [from, to) í búta sem hver kemur úr einu kerfi; skipt er við SIL/SeisComP mörkin
export function* windows(from: number, to: number, chunk: number, system?: CatalogSystem): Generator<CatalogWindow> {
  for (let t = from; t < to; ) {
    let end = Math.min(t + chunk, to);
    if (!system && t < SIL_CUTOFF && end > SIL_CUTOFF) end = SIL_CUTOFF;
    yield { from: t, to: end, system: system ?? systemFor(t) };
    t = end;
  }
}

const ATTEMPTS = 4;
const BACKOFF_MS = [5_000, 15_000, 45_000];

// Allir skjálftar á tímabilinu [from, to) í unix sekúndum. Skráin takmarkar dýpi við 0–50 km;
// sjálfgefin efri stærðarmörk hennar (7) eru hækkuð svo ekkert detti út.
// Farið er varlega gagnvart þjóninum: ein beiðni í einu, 429/5xx og tengivillur fá vaxandi bið
// (eða Retry-After ef gefið), aðrar villur eru ekki endurteknar.
export async function fetchCatalog(from: number, to: number, system: CatalogSystem): Promise<Quake[]> {
  const url = new URL(CATALOG_URL);
  url.search = new URLSearchParams({
    start_time: fmt(from), end_time: fmt(to), system,
    depth_min: '0', depth_max: '50', size_min: '-3', size_max: '10',
  }).toString();
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'quake-plot (personal earthquake map)', Accept: 'application/json' },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      if (attempt >= ATTEMPTS) throw new Error(`api.vedur.is næst ekki: ${e instanceof Error ? e.message : e}`);
      await Bun.sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (res.ok) {
      const body = await res.json();
      if (!Array.isArray(body?.features)) throw new Error('Óvænt svar frá api.vedur.is');
      return parseCatalog(body.features, system);
    }
    const detail = (await res.text()).slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await Bun.sleep(retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[attempt - 1]);
      continue;
    }
    throw new Error(`api.vedur.is svaraði ${res.status}: ${detail}`);
  }
}
