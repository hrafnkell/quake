import { mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fetchCatalog, windows } from './catalog';
import { QuakeStore } from './db';
import { encodeColumns, toRows } from './encode';
import { DEFAULT_REGION, PLACES, REGIONS } from './regions';
import { fetchFeed } from './scrape';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? 'data/quakes.db';
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 300);
// Samstilling við skjálftaskrá: síðustu CATALOG_SYNC_DAYS dagar á CATALOG_SYNC_HOURS fresti (0 = slökkt).
// Ein lítil beiðni á nokkurra klukkustunda fresti, svo yfirferð Veðurstofunnar skili sér þótt hún komi dögum síðar.
const CATALOG_SYNC_HOURS = Number(process.env.CATALOG_SYNC_HOURS ?? 6);
const CATALOG_SYNC_DAYS = Number(process.env.CATALOG_SYNC_DAYS ?? 14);
// Varaleið: þegar sókn á vedur.is bregst svona oft í röð er skjálftaskráin sótt í staðinn (síðustu 48 klst)
// í hverri sókn, þar til síðan svarar aftur. Heldur kortinu lifandi þótt síðan breytist eða hverfi.
const FEED_FALLBACK_AFTER = Number(process.env.FEED_FALLBACK_AFTER ?? 3);
const FALLBACK_HOURS = 48;
const PUBLIC_DIR = join(import.meta.dir, '..', 'public');

mkdirSync(dirname(DB_PATH), { recursive: true });
const store = new QuakeStore(DB_PATH);

const status = {
  lastPoll: null as number | null,
  lastOk: null as number | null,
  lastError: null as string | null,
  source: 'feed' as 'feed' | 'catalog', // hvaðan síðustu gögn komu
  feedFailures: 0, // misheppnaðar sóknir á vedur.is í röð
  // Breytist þegar ný gögn koma inn, viðmótið sækir þá aftur
  version: store.stats().lastChange ?? 0,
  catalog: { lastSync: null as number | null, lastError: null as string | null, nextSync: null as number | null },
};

let polling = false;

async function poll() {
  if (polling) return; // fyrri sókn (t.d. varaleið með endurtekningum) enn í gangi
  polling = true;
  try {
    const quakes = await fetchFeed();
    if (quakes.length === 0) throw new Error('Engir skjálftar fundust, er sniðið á vedur.is breytt?');
    const { inserted, updated, withdrawn } = store.upsert(quakes);
    if (inserted || updated || withdrawn) status.version = Date.now();
    status.lastOk = Date.now();
    status.lastError = null;
    if (status.source !== 'feed') console.log(`${new Date().toISOString()} vedur.is svarar aftur, hætt að nota varaleið`);
    status.source = 'feed';
    status.feedFailures = 0;
    console.log(`${new Date().toISOString()} ${quakes.length} í straumi, ${inserted} nýir, ${updated} uppfærðir, ${withdrawn} felldir út`);
  } catch (e) {
    status.lastError = e instanceof Error ? e.message : String(e);
    status.feedFailures++;
    console.error(`${new Date().toISOString()} Villa við sókn (${status.feedFailures}. í röð): ${status.lastError}`);
    if (status.feedFailures >= FEED_FALLBACK_AFTER) await pollCatalogFallback();
  } finally {
    status.lastPoll = Date.now();
    polling = false;
  }
}

// Skjálftaskráin í stað straumsins: sömu skjálftar (auk neikvæðra stærða), en yfirferð skilar sér seinna
// og örnefnalýsingu vantar. Fellir ekkert út sem straumurinn hefur sýnt, sjá UpsertOptions.
async function pollCatalogFallback() {
  const to = Math.floor(Date.now() / 1000);
  const from = to - FALLBACK_HOURS * 3600;
  try {
    let fetched = 0, inserted = 0, updated = 0, withdrawn = 0;
    for (const w of windows(from, to, Infinity)) {
      const quakes = await fetchCatalog(w.from, w.to, w.system);
      const r = store.upsert(quakes, undefined, { from: w.from, to: w.to, source: 'catalog' });
      fetched += quakes.length; inserted += r.inserted; updated += r.updated; withdrawn += r.withdrawn;
    }
    if (inserted || updated || withdrawn) status.version = Date.now();
    status.lastOk = Date.now();
    if (status.source !== 'catalog') console.log(`${new Date().toISOString()} Varaleið: sæki skjálftaskrána í stað vedur.is`);
    status.source = 'catalog';
    console.log(`${new Date().toISOString()} skjálftaskrá ${FALLBACK_HOURS} klst (varaleið): ${fetched} í skrá, ${inserted} nýir, ${updated} uppfærðir, ${withdrawn} felldir út`);
  } catch (e) {
    console.error(`${new Date().toISOString()} Varaleið brást líka: ${e instanceof Error ? e.message : e}`);
  }
}

async function syncCatalog() {
  const to = Math.floor(Date.now() / 1000);
  const from = to - CATALOG_SYNC_DAYS * 86400;
  try {
    let inserted = 0, updated = 0, fetched = 0;
    for (const w of windows(from, to, Infinity)) {
      const quakes = await fetchCatalog(w.from, w.to, w.system);
      const r = store.upsert(quakes, undefined, { from: w.from, to: w.to, source: 'catalog' });
      fetched += quakes.length; inserted += r.inserted; updated += r.updated;
    }
    if (inserted || updated) status.version = Date.now();
    status.catalog.lastSync = Date.now();
    status.catalog.lastError = null;
    console.log(`${new Date().toISOString()} skjálftaskrá ${CATALOG_SYNC_DAYS} d: ${fetched} í skrá, ${inserted} nýir, ${updated} uppfærðir`);
  } catch (e) {
    status.catalog.lastError = e instanceof Error ? e.message : String(e);
    console.error(`${new Date().toISOString()} Villa við samstillingu við skjálftaskrá: ${status.catalog.lastError}`);
  } finally {
    status.catalog.nextSync = CATALOG_SYNC_HOURS > 0 ? Date.now() + CATALOG_SYNC_HOURS * 3600e3 : null;
  }
}

poll();
setInterval(poll, POLL_SECONDS * 1000);
if (CATALOG_SYNC_HOURS > 0) {
  // Fyrsta samstilling skömmu eftir ræsingu (fyllir í eyður eftir niðritíma), svo reglulega
  setTimeout(() => {
    syncCatalog();
    setInterval(syncCatalog, CATALOG_SYNC_HOURS * 3600e3);
  }, 60_000);
  status.catalog.nextSync = Date.now() + 60_000;
}

function json(req: Request, data: unknown, httpStatus = 200) {
  const body = JSON.stringify(data);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (body.length > 1024 && req.headers.get('accept-encoding')?.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    return new Response(Bun.gzipSync(body), { status: httpStatus, headers });
  }
  return new Response(body, { status: httpStatus, headers });
}

function numParam(url: URL, key: string, fallback: number) {
  const v = url.searchParams.get(key);
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function quakes(req: Request, url: URL) {
  const region = REGIONS.find((r) => r.id === (url.searchParams.get('region') ?? DEFAULT_REGION));
  if (!region) return json(req, { error: 'Óþekkt svæði' }, 400);

  // Tímar í ms frá viðmóti, geymdir í sekúndum
  const now = Date.now();
  const from = numParam(url, 'from', now - 48 * 3600e3);
  const to = numParam(url, 'to', now);
  const minMag = numParam(url, 'minMag', -10);
  const maxMag = numParam(url, 'maxMag', 10);
  if ([from, to, minMag, maxMag].some(Number.isNaN)) return json(req, { error: 'Ógild færibreyta' }, 400);

  const rows = store.query({
    from: Math.floor(from / 1000), to: Math.ceil(to / 1000),
    lat: region.lat, lon: region.lon, minMag, maxMag,
  });
  // Dálkasnið sjálfgefið (sjá src/encode.ts), raðir með ?format=rows
  if (url.searchParams.get('format') === 'rows') return json(req, { version: status.version, quakes: toRows(rows) });
  return json(req, { version: status.version, ...encodeColumns(rows) });
}

// Útgáfunúmer (hash af innihaldi) á app.js og style.css í index.html. Cloudflare lætur vafra
// geyma .js/.css í 4 klst óháð Cache-Control frá okkur, svo ný slóð við hverja breytingu
// tryggir að uppfærslur skili sér strax og leyfir langa geymslu á skránum sjálfum.
async function buildIndex() {
  let html = await Bun.file(join(PUBLIC_DIR, 'index.html')).text();
  for (const asset of ['app.js', 'style.css']) {
    const hash = Bun.hash(await Bun.file(join(PUBLIC_DIR, asset)).arrayBuffer()).toString(36);
    html = html.replace(`"${asset}"`, `"${asset}?v=${hash}"`);
  }
  return html;
}
const indexHtml = await buildIndex();

async function staticFile(path: string, versioned: boolean) {
  if (path === '/' || path === '/index.html') {
    return new Response(indexHtml, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' } });
  }
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR + '/')) return new Response('Not found', { status: 404 });
  const f = Bun.file(file);
  if (!(await f.exists())) return new Response('Not found', { status: 404 });
  return new Response(f, { headers: { 'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache' } });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/api/quakes':
        return quakes(req, url);
      case '/api/regions':
        return json(req, { regions: REGIONS, places: PLACES, defaultRegion: DEFAULT_REGION });
      case '/api/status':
        return json(req, { ...status, pollSeconds: POLL_SECONDS, ...store.stats() });
      default:
        return staticFile(decodeURIComponent(url.pathname), url.searchParams.has('v'));
    }
  },
  error(e) {
    console.error(e);
    return new Response('Villa á netþjóni', { status: 500 });
  },
});

console.log(`Hlustar á http://${server.hostname}:${server.port}, gagnagrunnur ${DB_PATH}`);
