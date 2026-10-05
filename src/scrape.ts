export type Quake = {
  time: number; // unix sekúndur, UTC
  lat: number;
  lon: number;
  depth: number; // km
  mag: number;
  quality: number | null;
  distKm: number | null;
  direction: string | null;
  refPlace: string | null;
  region?: string | null; // skjálftasvæði úr skjálftaskrá (api.vedur.is), ekki í straumnum
  eventId?: string | null; // auðkenni í skjálftaskrá, ekki í straumnum
  raw: string; // allir reitir eins og uppruninn gefur þá, sem JSON
};

// FEED_URL má yfirskrifa til prófunar (t.d. ónýt slóð til að reyna varaleiðina)
const URL = process.env.FEED_URL ?? 'https://www.vedur.is/skjalftar-og-eldgos/jardskjalftar';

export async function fetchFeed(): Promise<Quake[]> {
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'quake-plot (personal earthquake map)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`vedur.is svaraði ${res.status}`);
  return parseFeed(await res.text());
}

const num = (s: string | undefined) => {
  if (s == null || s.trim() === '') return null;
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};

// 'a' er aldur skjálftans í dögum og breytist við hverja sókn, svo honum er sleppt
const rest = ({ a, ...f }: Record<string, string>) => f;

// "10-1" -> 9, "4" -> 4
const evalInt = (s: string) => s.split('-').map(Number).reduce((a, b) => a - b);

// Síðan inniheldur JS hluti á borð við
// {'t':new Date(2026,10-1,4,15,10,1),'lat':'63,652','lon':'-19,128','dep':'5,2','s':'0,8','q':'50,0','dL':'6,2','dD':'ANA ','dR':'Goðabungu'}
export function parseFeed(html: string): Quake[] {
  const out: Quake[] = [];
  for (const [, body] of html.matchAll(/\{([^{}]*'dep'[^{}]*)\}/g)) {
    const f = Object.fromEntries(Array.from(body.matchAll(/'(\w+)':'([^']*)'/g), (m) => [m[1], m[2]]));
    const d = body.match(/'t':new Date\(([^)]*)\)/);
    if (!d) continue;
    const [y, mo, day, h, mi, s] = d[1].split(',').map(evalInt);
    // Íslenskur tími er UTC allt árið, mánuðir eru 0-indexed eins og í JS
    const time = Date.UTC(y, mo, day, h, mi, s) / 1000;

    const lat = num(f.lat), lon = num(f.lon), depth = num(f.dep), mag = num(f.s);
    if (lat == null || lon == null || depth == null || mag == null || !Number.isFinite(time)) continue;

    out.push({
      time, lat, lon, depth, mag,
      quality: num(f.q),
      distKm: num(f.dL),
      direction: f.dD?.trim() || null,
      refPlace: f.dR?.trim() || null,
      raw: JSON.stringify({ ...rest(f), t: d[1] }),
    });
  }
  return out;
}
