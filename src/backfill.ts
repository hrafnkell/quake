// Bakfyllir grunninn úr skjálftaskrá Veðurstofunnar (api.vedur.is/quakes), sömu heimild og skjalftalisa.vedur.is.
//
//   bun run backfill 2026-09-01                  # frá dagsetningu til núna
//   bun run backfill 2026-09-01 2026-10-01       # tímabil [frá, til)
//   bun run backfill --days 30                   # síðustu 30 dagar
//   bun run backfill 1991-01-07 2020-01-01 --chunk 30   # 30 daga bútar (sjálfgefið 7) fyrir rólegri ár
//
// Óhætt að keyra aftur og meðan þjónninn keyrir (WAL). Skjálftar sem eru þegar í grunni úr straumnum
// eru uppfærðir með yfirförnum gildum og fá auðkenni skrárinnar; fjarlægð/stefna/örnefni úr straumnum
// er haldið. Ekkert er fellt út, því skráin getur vantað skjálfta sem straumurinn sýnir.
// Umhverfisbreytur: DB_PATH (data/quakes.db), CATALOG_SYSTEM (sil|seiscomp; sjálfgefið eftir dagsetningu).
import { fetchCatalog, windows, type CatalogSystem } from './catalog';
import { QuakeStore } from './db';

const DB_PATH = process.env.DB_PATH ?? 'data/quakes.db';
const DEFAULT_CHUNK_DAYS = 7;
// Hlé milli beiðna; sex ár eru ~300 beiðnir, svo þetta skiptir þjóninn litlu en tryggir að við hömrum ekki
const PAUSE_MS = 2_000;

function parseDate(s: string) {
  const t = Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s);
  if (!Number.isFinite(t)) throw new Error(`Ógild dagsetning: ${s}`);
  return Math.floor(t / 1000);
}

function parseArgs(argv: string[]) {
  const now = Math.floor(Date.now() / 1000);
  let chunk = DEFAULT_CHUNK_DAYS * 86400;
  const i = argv.indexOf('--chunk');
  if (i >= 0) {
    const d = Number(argv[i + 1]);
    if (!Number.isFinite(d) || d <= 0) throw new Error('--chunk þarf jákvæða tölu daga');
    chunk = d * 86400;
    argv = [...argv.slice(0, i), ...argv.slice(i + 2)];
  }
  if (argv[0] === '--days') {
    const d = Number(argv[1]);
    if (!Number.isFinite(d) || d <= 0) throw new Error('--days þarf jákvæða tölu');
    return { from: now - d * 86400, to: now, chunk };
  }
  if (!argv[0]) throw new Error('Notkun: bun run backfill <frá> [til] | --days <n>  [--chunk <dagar>]');
  return { from: parseDate(argv[0]), to: argv[1] ? parseDate(argv[1]) : now, chunk };
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

if (import.meta.main) {
  const { from, to, chunk } = parseArgs(process.argv.slice(2));
  const forced = process.env.CATALOG_SYSTEM as CatalogSystem | undefined;
  if (forced && forced !== 'sil' && forced !== 'seiscomp') throw new Error('CATALOG_SYSTEM þarf að vera sil eða seiscomp');
  const store = new QuakeStore(DB_PATH);
  const total = { fetched: 0, inserted: 0, updated: 0 };
  console.log(`Bakfylli ${iso(from)} – ${iso(to)} í ${DB_PATH}`);
  for (const c of windows(from, to, chunk, forced)) {
    let quakes;
    try {
      quakes = await fetchCatalog(c.from, c.to, c.system);
    } catch (e) {
      console.error(`${iso(c.from)} – ${iso(c.to)} ${c.system}: ${e instanceof Error ? e.message : e}`);
      console.error(`Hætt. Keyra aftur frá ${iso(c.from)} þegar þjónninn svarar.`);
      process.exit(1);
    }
    const r = store.upsert(quakes, undefined, { from: c.from, to: c.to, source: 'catalog' });
    total.fetched += quakes.length; total.inserted += r.inserted; total.updated += r.updated;
    console.log(`${iso(c.from)} – ${iso(c.to)} ${c.system}: ${quakes.length} í skrá, ${r.inserted} nýir, ${r.updated} uppfærðir`);
    await Bun.sleep(PAUSE_MS);
  }
  console.log(`Samtals: ${total.fetched} í skrá, ${total.inserted} nýir, ${total.updated} uppfærðir. Í grunni: ${store.stats().total}`);
}

export { parseArgs };
