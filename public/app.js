'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TZ = 'Atlantic/Reykjavik';
const HOUR = 3600e3;
const PRESETS = { '24h': 24, '48h': 48, '7d': 168, '30d': 720, '1y': 8760 };
// Lengsta tímabil sem er sótt í einu, sama og þjónninn leyfir (MAX_SPAN_DAYS í server.ts)
const MAX_SPAN = 366 * 24 * HOUR;

// Lykkjur frekar en Math.min(...fylki): Safari leyfir mest 65.536 viðföng og kastar villu umfram það
const minOf = (a, init = Infinity) => a.reduce((m, v) => (v < m ? v : m), init);
const maxOf = (a, init = -Infinity) => a.reduce((m, v) => (v > m ? v : m), init);
const STATUS_EVERY = 60e3;

// Litur eftir aldri: nýtt = sterkt og heitt, gamalt = dauft. Sér skali fyrir dökkt þema.
const RAMPS = {
  light: ['#7f1d1d', '#c2410c', '#f59e0b', '#fcd9a0'],
  dark: ['#fff4c2', '#fbbf24', '#f97316', '#8a3a12'],
};
// Þéttleiki: fáir = ljóst, margir = dökkt (ljóst þema), öfugt í dökku
const DENSITY_RAMPS = {
  light: ['#fde68a', '#f59e0b', '#c2410c', '#7f1d1d'],
  dark: ['#5b2a06', '#d97706', '#fde68a', '#fff7cc'],
};
const HEX = 11; // px frá miðju í horn

const state = {
  region: null, // sjálfgefið svæði kemur frá þjóni
  preset: '48h',
  from: null, // ms, aðeins fyrir 'custom'
  to: null,
  minMag: null,
  maxMag: null,
  minDepth: null, // km
  maxDepth: null,
  view: 'map',
  layer: 'dots', // 'dots' | 'density' (þéttleiki í sexhyrningum)
  brush: null, // [ms, ms] valið á tímalínu
  event: null, // valinn atburður (id), sjá applyEvent; hreinsast þegar svæði/tímabil nær ekki lengur yfir hann
  heatMetric: 'energy', // hitakort: 'energy' | 'count'
  heatFrom: null, // hitakort: ár, sjálfgefið fyrsta ár í grunni
  heatTo: null,
};

let regions = [];
let defaultRegion = 'island';
let places = [];
let events = []; // eldgos og stórir atburðir, úr /api/regions
let quakes = [];
let quakesTotal = 0; // fjöldi á tímabilinu; meiri en quakes.length ef þjónninn sýndi aðeins þá stærstu
let dataFirst = null; // elsti skjálfti í grunni, ms (úr /api/status)
let dataVersion = null;
let lastFetch = 0;
let fetchSeq = 0;

// ---------- Hjálparföll ----------

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt1 = (v) => v.toLocaleString('is-IS', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDateTime = new Intl.DateTimeFormat('is-IS', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtDate = new Intl.DateTimeFormat('is-IS', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const fmtClock = new Intl.DateTimeFormat('is-IS', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function ago(ms) {
  const min = (Date.now() - ms) / 60e3;
  if (min < 1) return 'rétt í þessu';
  if (min < 60) return `fyrir ${Math.round(min)} mín`;
  const h = min / 60;
  if (h < 48) return `fyrir ${Math.round(h)} klst`;
  const d = h / 24;
  if (d < 60) return `fyrir ${Math.round(d)} dögum`;
  return fmtDate.format(ms);
}

function spanLabel(ms) {
  const h = ms / HOUR;
  if (h < 48) return `${Math.round(h)} klst`;
  if (h < 24 * 60) return `${Math.round(h / 24)} dagar`;
  return `${Math.round(h / 24 / 30)} mán`;
}

// Skjálftar úr skjálftaskrá (bakfylling) hafa aðeins svæðisheiti, ekki fjarlægð frá örnefni
const place = (q) => (q.ref ? `${q.dist != null ? fmt1(q.dist) + ' km ' : ''}${q.dir ?? ''} af ${q.ref.replaceAll('_', ' ')}` : q.region ?? '');

// Íslenskur tími = UTC, svo ISO án tímabeltis er réttur tími fyrir Plotly og datetime-local
const isoLocal = (ms) => new Date(ms).toISOString().slice(0, 19);
const isoMs = (ms) => new Date(ms).toISOString().slice(0, 23); // með millisekúndum, fyrir ásbil
const parseLocal = (s) => Date.parse(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rampColor(t, ramps = RAMPS) {
  const stops = ramps[dark() ? 'dark' : 'light'].map(hexToRgb);
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
}

// Sérsniðið tímabil lengra en MAX_SPAN: hinn endinn (move) er færður að
function limitCustomSpan(move) {
  if (state.from == null || state.to == null || state.to - state.from <= MAX_SPAN) return;
  if (move === 'to') state.to = state.from + MAX_SPAN;
  else state.from = state.to - MAX_SPAN;
}

// Tímagluggi sem litaskalinn spannar
function timeWindow() {
  const now = Date.now();
  if (state.preset === 'custom') {
    const to = state.to ?? now;
    return [Math.max(state.from ?? now - 48 * HOUR, to - MAX_SPAN), to];
  }
  return [now - PRESETS[state.preset] * HOUR, now];
}

// Stærð eftir orku: þvermál tvöfaldast fyrir hverja stærðareiningu. Rétt orkukvörðun
// (×32 á einingu) myndi láta M4 gleypa kortið, svo þetta er málamiðlun.
const radiusFor = (mag) => clamp(2.5 * 2 ** mag, 2.5, 48);
// Óyfirfarin sjálfvirk stærð M4+ eldri en 30 daga er oft röng (t.d. „M9,1“ 2003); þjónninn merkir hana
// (sus, sjá SUSPECT í db.ts) og hún er sýnd sem M4 og aldrei talin stærsti skjálftinn
const SUSPECT_MAG = 4;
const shownMag = (q) => (q.sus ? SUSPECT_MAG : q.mag);
const trusted = (q) => !q.sus;

// 'at' er viðmiðunartími fyrir aldur (afspilun); sjálfgefið endi gluggans / núna
function style(q, win, at) {
  const t = ((at ?? win[1]) - q.t) / Math.max(win[1] - win[0], 1);
  const [r, g, b] = rampColor(t);
  return {
    fill: `rgb(${r},${g},${b})`,
    opacity: 0.92 - 0.45 * clamp(t, 0, 1),
    radius: radiusFor(shownMag(q)),
    recent: (at ?? Date.now()) - q.t < HOUR,
  };
}

// ---------- Slóð (URL) geymir síur svo hægt sé að deila ----------

function readUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('region')) state.region = p.get('region');
  if (p.has('range')) state.preset = p.get('range');
  if (!(state.preset in PRESETS) && state.preset !== 'custom') state.preset = '48h';
  // Ógild dagsetning í slóð verður sjálfgefin frekar en NaN sem þjónninn hafnar
  const date = (k) => (p.has(k) && Number.isFinite(parseLocal(p.get(k))) ? parseLocal(p.get(k)) : null);
  state.from = date('from');
  state.to = date('to');
  limitCustomSpan('to');
  const num = (k) => (p.has(k) && p.get(k) !== '' && Number.isFinite(+p.get(k)) ? +p.get(k) : null);
  state.minMag = num('min');
  state.maxMag = num('max');
  state.minDepth = num('dmin');
  state.maxDepth = num('dmax');
  if (['map', '3d', 'table', 'heat'].includes(p.get('view'))) state.view = p.get('view');
  state.event = p.get('event') || null; // staðfest þegar atburðir hafa verið sóttir
  if (p.get('metric') === 'count') state.heatMetric = 'count';
  const years = /^(\d{4})-(\d{4})$/.exec(p.get('years') ?? '');
  if (years) [state.heatFrom, state.heatTo] = [+years[1], +years[2]];
  if (p.get('layer') === 'density') state.layer = 'density';
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.region !== defaultRegion) p.set('region', state.region);
  if (state.preset !== '48h') p.set('range', state.preset);
  if (state.preset === 'custom') {
    if (state.from) p.set('from', isoLocal(state.from).slice(0, 16));
    if (state.to) p.set('to', isoLocal(state.to).slice(0, 16));
  }
  if (state.minMag != null) p.set('min', state.minMag);
  if (state.maxMag != null) p.set('max', state.maxMag);
  if (state.minDepth != null) p.set('dmin', state.minDepth);
  if (state.maxDepth != null) p.set('dmax', state.maxDepth);
  if (state.event) p.set('event', state.event);
  if (state.view !== 'map') p.set('view', state.view);
  if (state.layer !== 'dots') p.set('layer', state.layer);
  if (state.view === 'heat') {
    if (state.heatMetric !== 'energy') p.set('metric', state.heatMetric);
    if (state.heatFrom != null) p.set('years', `${state.heatFrom}-${state.heatTo}`);
  }
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ---------- Gögn ----------

// Dálkasnið þjónsins (sjá src/encode.ts) í hluti: tími í ms, hnit, dýpt, stærð, gæði, staðarlýsing
function decodeColumns(c) {
  const out = new Array(c.n);
  const str = (i) => (i < 0 ? null : c.strings[i]);
  let t = 0;
  for (let i = 0; i < c.n; i++) {
    t += c.t[i];
    out[i] = {
      t: t * 1000, lat: c.lat[i] / 1000, lon: c.lon[i] / 1000, depth: c.depth[i] / 10, mag: c.mag[i] / 10, q: c.q[i],
      dist: c.dist[i] < 0 ? null : c.dist[i] / 10, dir: str(c.dir[i]), ref: str(c.ref[i]), region: str(c.region[i]),
      sus: c.sus?.[i] === 1,
    };
  }
  return out;
}

async function loadQuakes({ quiet = false } = {}) {
  const seq = ++fetchSeq;
  const now = Date.now();
  let from, to;
  if (state.preset === 'custom') {
    to = state.to ?? now;
    from = Math.max(state.from ?? now - 48 * HOUR, to - MAX_SPAN);
  } else {
    from = now - PRESETS[state.preset] * HOUR;
    to = now + 60e3;
  }
  // Allt landið, svo hægt sé að færa kortið; svæðaval þysjar aðeins (sjá Sýnilegt svæði)
  const p = new URLSearchParams({ region: 'island', from, to });
  if (state.minMag != null) p.set('minMag', state.minMag);
  if (state.maxMag != null) p.set('maxMag', state.maxMag);
  if (state.minDepth != null) p.set('minDepth', state.minDepth);
  if (state.maxDepth != null) p.set('maxDepth', state.maxDepth);

  if (!quiet) setStatus('Sæki…');
  try {
    const res = await fetch(`/api/quakes?${p}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    const data = await res.json();
    if (seq !== fetchSeq) return; // nýrri beiðni komin af stað
    // Sjálfvirk uppfærsla sem lendir í miðri afspilun er látin bíða: dataVersion helst óbreytt, svo
    // næsta athugun eftir afspilun sækir aftur. Beiðnir notandans (síur, tímalína) stöðva afspilun.
    if (quiet && player.active) return;
    quakes = decodeColumns(data);
    quakesTotal = data.total ?? quakes.length;
    dataVersion = data.version;
    lastFetch = Date.now();
    render();
    await checkStatus();
  } catch (e) {
    if (seq === fetchSeq) setStatus(`Villa: ${e.message}`, 'bad');
  }
}

async function checkStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.first) dataFirst = s.first * 1000;
    if (s.source === 'catalog') {
      // Varaleið: vedur.is svarar ekki en skjálftaskráin heldur kortinu lifandi
      setStatus(`Uppfært kl ${fmtClock.format(s.lastOk)} úr skjálftaskrá · vedur.is svarar ekki`, 'warn');
    } else if (s.lastError) {
      setStatus(`Villa við sókn til vedur.is: ${s.lastError}`, 'bad');
    } else {
      const auto = $('#auto').checked;
      setStatus(`Uppfært kl ${fmtClock.format(lastFetch)}${auto ? ' · í beinni' : ''}`, auto ? 'ok' : '');
    }
    return s;
  } catch {
    setStatus('Næ ekki sambandi við netþjón', 'bad');
    return null;
  }
}

async function tick() {
  if (document.hidden || !$('#auto').checked || player.active) return;
  const s = await checkStatus();
  if (!s) return;
  if (state.view === 'heat') {
    // Aðeins yfirstandandi ár breytist að jafnaði; liðin ár eru geymd á þjóni
    if (s.version !== heat.statusVersion && state.heatTo === heat.years.at(-1)?.year) {
      heat.statusVersion = s.version;
      loadHeatYears().then(() => loadHeat({ quiet: true })).catch(() => {});
    }
    return;
  }
  // Sækja aftur ef ný gögn eru komin eða ef glugginn hreyfist (t.d. "síðustu 48 klst")
  const sliding = state.preset !== 'custom' && Date.now() - lastFetch > 5 * 60e3;
  if (s.version !== dataVersion || sliding) loadQuakes({ quiet: true });
}

function setStatus(text, kind = '') {
  $('#status-text').textContent = text;
  $('#status-dot').className = `dot ${kind}`;
}

// ---------- Teikning ----------

// ---------- Sýnilegt svæði ----------
// Gögn eru alltaf sótt fyrir allt landið, svo hægt sé að færa kortið og skoða nágrennið; svæðaval og
// atburðir þysja aðeins kortið. Tölur, tímalína, tafla, 3D og afspilun sýna það sem er innan sýnilega
// kortsins (focus), uppfært þegar kortið stöðvast. Kortið sjálft teiknar allt.
let focus = null; // { lat: [s, n], lon: [w, e] }, null = allt
let areaCache = null;

function setFocus(f) {
  focus = f;
  areaCache = null;
}

const inFocus = (q) => q.lat >= focus.lat[0] && q.lat <= focus.lat[1] && q.lon >= focus.lon[0] && q.lon <= focus.lon[1];

// Skjálftar innan sýnilega svæðisins, óháð tímavali á tímalínu
function areaQuakes() {
  if (areaCache?.quakes !== quakes || areaCache.focus !== focus) {
    areaCache = { quakes, focus, list: focus ? quakes.filter(inFocus) : quakes };
  }
  return areaCache.list;
}

function brushed(list) {
  if (!state.brush) return list;
  const [a, b] = state.brush;
  return list.filter((q) => q.t >= a && q.t <= b);
}

// Tölur, tafla, 3D og afspilun: sýnilegt svæði og tímaval
const visibleQuakes = () => brushed(areaQuakes());
// Kortið: allt landið innan tímavals
const mapQuakes = () => brushed(quakes);

// Kortið stöðvaðist eftir færslu eða þysjun: nýtt sýnilegt svæði
function onMapMoved() {
  if (state.view !== 'map') return; // falið kort hefur enga stærð; fitRegion setur svæðið þá
  const b = map.getBounds();
  setFocus({ lat: [b.getSouth(), b.getNorth()], lon: [b.getWest(), b.getEast()] });
  if (!player.active) renderArea();
}

// Allt sem fer eftir sýnilega svæðinu (kortið sjálft breytist ekki)
function renderArea() {
  const list = visibleQuakes();
  const win = timeWindow();
  renderStats(list);
  renderTimeline(win);
  if (state.view === '3d') render3d(list, win);
  if (state.view === 'table') renderTable(list, win);
}

function render() {
  if (player.active) exitPlayback({ rerender: false });
  const list = visibleQuakes();
  const win = timeWindow();
  renderStats(list);
  renderMap(mapQuakes(), win);
  renderEvents(win);
  renderLegend(win);
  if (state.view === '3d') render3d(list, win);
  if (state.view === 'table') renderTable(list, win);
  renderTimeline(win);
  renderBrushChip();
  updatePlaybackUi();
  if (aftershockMain) {
    // Nýir hlutir eftir endurhleðslu: finna sama skjálfta aftur, annars loka
    const m = quakes.find((q) => q.t === aftershockMain.t && q.lat === aftershockMain.lat && q.lon === aftershockMain.lon);
    m ? ((aftershockMain = m), renderAftershocks()) : closeAftershocks();
  }
}

// ---------- Atburðir: eldgos og stórir skjálftar ----------

const KIND_LABEL = { eruption: 'Eldgos', earthquake: 'Skjálfti', intrusion: 'Kvikuhlaup' };
const KIND_GROUP = { eruption: 'Eldgos', earthquake: 'Skjálftar og kvikuhlaup', intrusion: 'Skjálftar og kvikuhlaup' };

// Atburðir sem snerta tímagluggann
const eventsIn = (win) => events.filter((e) => e.startMs <= win[1] && e.endMs >= win[0]);

function eventTitle(e) {
  const when = e.endMs > e.startMs + 86400e3 ? `${fmtDate.format(e.startMs)} – ${fmtDate.format(e.endMs)}` : fmtDateTime.format(e.startMs);
  return `${KIND_LABEL[e.kind]}: ${esc(e.name)}<br><span class="muted">${when}${e.note ? ' · ' + esc(e.note) : ''}</span>`;
}

function renderEventOptions() {
  const groups = {};
  for (const e of [...events].reverse()) (groups[KIND_GROUP[e.kind]] ??= []).push(e);
  $('#events').innerHTML = '<option value="">Veldu atburð…</option>' + Object.entries(groups).map(([g, list]) =>
    `<optgroup label="${esc(g)}">${list.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</optgroup>`).join('');
}

// Bókamerki: svæði atburðarins og tímabil sem nær yfir aðdragandann og fyrstu dagana
function applyEvent(id) {
  const e = events.find((x) => x.id === id);
  if (!e) return;
  const [before, after] = e.view ?? [30, 7];
  state.region = regions.some((r) => r.id === e.region) ? e.region : defaultRegion;
  state.preset = 'custom';
  state.from = e.startMs - before * 86400e3;
  state.to = Math.min(e.startMs + after * 86400e3, Date.now());
  state.brush = null;
  state.event = e.id;
  if (state.view === 'table') setView('map');
  fitRegion();
  filtersChanged();
}

const eventRegion = (e) => (regions.some((r) => r.id === e.region) ? e.region : defaultRegion);

// Valinn atburður meðan hann er enn á skjánum: sama svæði og upphafið innan tímabilsins. Smá tilfærsla
// á tímalínu eða stærðarsía heldur honum; annað svæði eða tímabil án upphafsins hreinsar valið.
function selectedEvent() {
  const e = events.find((x) => x.id === state.event);
  if (!e || state.region !== eventRegion(e)) return null;
  const win = timeWindow();
  return e.startMs >= win[0] && e.startMs <= win[1] ? e : null;
}

function renderEventCard() {
  const card = $('#event-card');
  const e = selectedEvent();
  card.hidden = !e;
  if (!e) return;
  const glyph = e.kind === 'eruption' ? '▲' : e.kind === 'intrusion' ? '◆' : '✶';
  const ongoing = e.kind === 'eruption' && e.endMs > e.startMs + 86400e3;
  const when = e.endMs > e.startMs + 3600e3
    ? `${fmtDateTime.format(e.startMs)} – ${fmtDate.format(e.endMs)}${ongoing ? ` (${Math.round((e.endMs - e.startMs) / 86400e3)} dagar)` : ''}`
    : fmtDateTime.format(e.startMs);
  const win = timeWindow();
  const days = (ms) => Math.round(ms / 86400e3);
  card.innerHTML = `
    <span class="glyph" aria-hidden="true">${glyph}</span>
    <div class="body">
      <div class="kind">${KIND_LABEL[e.kind]} · ${esc(regions.find((r) => r.id === eventRegion(e))?.name ?? '')}</div>
      <div class="name">${esc(e.name)}</div>
      <div class="when">${when}</div>
      ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
      <div class="span">Tímabilið sýnir ${days(e.startMs - win[0])} daga aðdraganda og ${days(win[1] - e.startMs)} daga eftir upphaf</div>
    </div>
    <button type="button" class="close" id="event-clear" aria-label="Hreinsa atburð" title="Hreinsa atburð">✕</button>`;
  $('#event-clear').onclick = () => {
    state.event = null;
    syncControls();
    writeUrl();
    renderEvents(timeWindow());
    Plotly.relayout('timeline', timelineShapes());
  };
}

let eventLayer;

function renderEvents(win) {
  eventLayer ??= L.layerGroup().addTo(map);
  eventLayer.clearLayers();
  for (const e of eventsIn(win)) {
    const glyph = e.kind === 'eruption' ? '▲' : e.kind === 'intrusion' ? '◆' : '✶';
    L.marker([e.lat, e.lon], {
      icon: L.divIcon({ className: `event-icon${e.id === state.event ? ' selected' : ''}`, html: `<span>${glyph}</span>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
      zIndexOffset: e.id === state.event ? 1000 : 0,
      interactive: true,
      keyboard: false,
    }).bindTooltip(eventTitle(e), { className: 'quake-tip', direction: 'top', offset: [0, -10] }).addTo(eventLayer);
  }
}

// Lóðréttar línur (og skyggt bil meðan eldgos stendur) á tímalínunni, með nafni efst
function eventShapes(win) {
  const color = css('--event');
  const shapes = [], annotations = [];
  for (const e of eventsIn(win)) {
    const x0 = isoMs(e.startMs);
    shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color, width: 1.5, dash: e.kind === 'eruption' ? 'solid' : 'dot' } });
    if (e.endMs > e.startMs + 3600e3) {
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0, x1: isoMs(e.endMs), y0: 0, y1: 1, fillcolor: color, opacity: 0.08, line: { width: 0 }, layer: 'below' });
    }
    annotations.push({
      x: x0, xref: 'x', y: 1, yref: 'paper', yanchor: 'bottom', xanchor: 'left', yshift: 2, showarrow: false,
      text: e.id === state.event ? `<b>${esc(e.name)}</b>` : esc(e.name), font: { color, size: e.id === state.event ? 12 : 11 },
      hovertext: eventTitle(e).replace(/<[^>]+>/g, ' '),
    });
  }
  return { shapes, annotations };
}

// Allar formlínur tímalínunnar: atburðir og afspilunarhausinn
function timelineShapes(win = timeWindow()) {
  const ev = eventShapes(win);
  return { shapes: [...ev.shapes, ...playheadShapes()], annotations: ev.annotations };
}

function renderStats(list) {
  const biggest = list.reduce((m, q) => (trusted(q) && (!m || q.mag > m.mag) ? q : m), null);
  const latest = list[list.length - 1];
  const strong = list.filter((q) => q.mag >= 3).length;
  const tile = (k, v, d = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  // Þjónninn sýnir stærstu skjálftana þegar tímabilið er of stórt; segja frá því og hvar mörkin liggja
  const thinned = quakesTotal > quakes.length && quakes.length;
  const minShown = thinned ? minOf(quakes.map((q) => q.mag)) : null;
  const countNote = thinned
    ? `${quakes.length.toLocaleString('is-IS')} stærstu sýndir af ${quakesTotal.toLocaleString('is-IS')} (≥ M ${fmt1(minShown)})`
    : strong ? `${strong} af stærð 3 eða meira` : 'enginn af stærð 3 eða meira';
  $('#stats').innerHTML = [
    tile('Fjöldi skjálfta', list.length.toLocaleString('is-IS'), countNote),
    biggest ? tile('Stærsti', `M ${fmt1(biggest.mag)}`, `${esc(place(biggest))} · ${ago(biggest.t)}`) : tile('Stærsti', '–'),
    latest ? tile('Nýjasti', ago(latest.t), `M ${fmt1(latest.mag)} · ${esc(place(latest))}`) : tile('Nýjasti', '–'),
  ].join('');
}

function tooltipHtml(q, pinned = false) {
  return `<b>M ${fmt1(q.mag)}</b> <span class="muted">· dýpt ${fmt1(q.depth)} km</span><br>
    ${fmtDateTime.format(q.t)} <span class="muted">(${ago(q.t)})</span><br>
    ${esc(place(q))}${q.q != null ? `<br><span class="muted">Gæði ${fmt1(q.q)}</span>` : ''}${
    q.sus ? `<br><span class="muted">Óyfirfarin sjálfvirk stærð, líklega röng. Sýnd sem M${SUSPECT_MAG}.</span>` : ''}${
    pinned && trusted(q) && q.mag >= AFTERSHOCK_MIN_MAG ? `<br><a href="#" class="aftershocks-link">Eftirskjálftar →</a>` : ''}`;
}

function binTooltipHtml(b) {
  return `<b>${b.n.toLocaleString('is-IS')} skjálftar</b><br><span class="muted">stærsti M ${fmt1(b.maxMag)}</span>`;
}

// --- Kort ---

let map, quakeLayer, baseLayers, legendControl;
const byMagDesc = (a, b) => b.mag - a.mag;

function initMap() {
  map = L.map('map', { preferCanvas: true, zoomSnap: 0.25, scrollWheelZoom: false });
  // Skrunhjól þysjar aðeins eftir að smellt er á kortið, annars skrunar síðan
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout blur', () => map.scrollWheelZoom.disable());
  baseLayers = makeBaseLayers();
  baseLayers.Kort.addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  quakeLayer = new QuakeCanvas().addTo(map);
  map.on('moveend', onMapMoved);
  initMapControls();
}

// Ný eintök fyrir hvert kort: Leaflet-lag getur aðeins verið á einu korti í einu
function makeBaseLayers() {
  return {
    Kort: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'osm-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    Landslag: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenStreetMap, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    }),
    Loftmynd: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Tiles &copy; Esri',
    }),
  };
}

function initMapControls() {
  legendControl = L.control({ position: 'bottomright' });
  legendControl.onAdd = () => L.DomUtil.create('div', 'legend');
  legendControl.addTo(map);
  quakeLayer.onDensityMax = () => renderLegend(player.active ? player.range : timeWindow());

  const toggle = L.control({ position: 'topleft' });
  toggle.onAdd = () => {
    const div = L.DomUtil.create('div', 'layer-toggle');
    div.innerHTML = `<button type="button" data-layer="dots">Punktar</button><button type="button" data-layer="density">Þéttleiki</button>`;
    L.DomEvent.disableClickPropagation(div);
    div.onclick = (e) => {
      const b = e.target.closest('[data-layer]');
      if (b) setLayer(b.dataset.layer);
    };
    return div;
  };
  toggle.addTo(map);
  syncLayerToggle();
}

function syncLayerToggle() {
  for (const b of $$('.layer-toggle [data-layer]')) b.setAttribute('aria-pressed', b.dataset.layer === state.layer);
}

function setLayer(layer) {
  state.layer = layer;
  syncLayerToggle();
  writeUrl();
  quakeLayer.setMode(layer);
  renderLegend(timeWindow());
}

const ICELAND = { lat: [63.2, 66.6], lon: [-24.6, -13.4] };

// Svæði án ramma (allt landið) eru sýnd sem Ísland á kortinu
const bounds = (r) => (r.lat[1] - r.lat[0] > 30 ? ICELAND : r);

function fitRegion(m = map) {
  const r = regions.find((r) => r.id === state.region);
  if (!r) return;
  const b = bounds(r);
  // Falið kort (3D, tafla) hefur enga stærð og lætur ekki vita af færslu: svæðið sjálft er þá sýnilega svæðið,
  // og allt landið nær líka yfir skjálfta utan við strönd
  if (m === map && state.view !== 'map') {
    setFocus(b === ICELAND ? null : { lat: [...b.lat], lon: [...b.lon] });
    mapFitPending = true; // þysjað þegar kortið birtist aftur
    return;
  }
  m.fitBounds([[b.lat[0], b.lon[0]], [b.lat[1], b.lon[1]]]);
}
let mapFitPending = false;

function renderMap(list, win) {
  quakeLayer.setStatic(list, win);
}

// Skjálftar eru teiknaðir á canvas í stað Leaflet-merkja: tugþúsundir teiknast á ~100 ms í stað sekúndna.
// Grunnlag með öllum skjálftum (stórir fyrst svo litlir hverfi ekki undir þá) og rist í skjáhnitum til
// að finna skjálfta undir músinni fyrir ábendingu. Afspilun notar sömu canvas, sjá Afspilun neðar.
const CELL = 48; // px, ≥ stærsta radíus svo nágrannareitir dugi
const QuakeCanvas = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    const pane = map.getPanes().overlayPane;
    this._base = L.DomUtil.create('canvas', 'leaflet-zoom-hide quake-canvas', pane);
    this._top = L.DomUtil.create('canvas', 'leaflet-zoom-hide quake-canvas', pane);
    this._list = [];
    this._grid = new Map();
    this._pending = [];
    this._lastBase = 0;
    map.on('moveend zoomend resize', this._reset, this);
    map.on('mousemove', this._onMove, this);
    map.on('mouseout', this._clearHover, this);
    map.on('click', this._onClick, this);
    this._reset();
  },
  onRemove(map) {
    map.off('moveend zoomend resize', this._reset, this);
    map.off('mousemove', this._onMove, this);
    map.off('mouseout', this._clearHover, this);
    map.off('click', this._onClick, this);
    this._base.remove();
    this._top.remove();
  },
  _reset() {
    const size = this._map.getSize();
    this._origin = this._map.containerPointToLayerPoint([0, 0]);
    this._dpr = devicePixelRatio || 1;
    for (const c of [this._base, this._top]) {
      L.DomUtil.setPosition(c, this._origin);
      c.width = size.x * this._dpr;
      c.height = size.y * this._dpr;
      c.style.width = `${size.x}px`;
      c.style.height = `${size.y}px`;
    }
    this._size = size;
    if (player.active) this.redrawAll();
    else this.drawStatic();
  },
  // Punktar í canvas-hnitum = lagpunktar frá uppruna canvas; haldast réttir meðan dregið er
  _point(q) {
    const p = this._map.latLngToLayerPoint([q.lat, q.lon]);
    return [p.x - this._origin.x, p.y - this._origin.y];
  },
  _ctx(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this._size.x, this._size.y);
    return ctx;
  },
  _visible(x, y, r) {
    return x >= -r * 4 && y >= -r * 4 && x <= this._size.x + r * 4 && y <= this._size.y + r * 4;
  },
  // Einn skjálfti: fylltur hringur, útlína ef hann er innan klukkustundar frá viðmiðunartíma,
  // og í „poppinu“ (p frá 0 til 1) yfirstærð sem skreppur saman ásamt hring sem þenst út og dofnar
  // hollow: óyfirfarin stærð (sus), teiknuð sem brotinn hringur án fyllingar svo hún líti ekki út fyrir að vera raunveruleg
  _circle(ctx, x, y, r, color, alpha, recent, p = 1, hollow = false) {
    const ease = 1 - (1 - p) ** 3;
    ctx.beginPath();
    ctx.arc(x, y, r * (1 + 1.4 * (1 - ease)), 0, Math.PI * 2);
    if (!hollow) {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fill();
    }
    ctx.lineWidth = recent || hollow ? 2 : 1;
    ctx.strokeStyle = recent ? this._ink : color;
    ctx.globalAlpha = recent ? 0.9 : Math.min(1, alpha + 0.1);
    if (hollow) ctx.setLineDash([4, 3]);
    ctx.stroke();
    if (hollow) ctx.setLineDash([]);
    if (p < 1) {
      ctx.beginPath();
      ctx.arc(x, y, r * (1 + 2.5 * ease) + 2, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = (1 - ease) * 0.9;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },

  setMode(mode) {
    this._mode = mode;
    this.unpin();
    if (player.active) this.redrawAll();
    else this.drawStatic();
  },
  // Sexhyrningar í skjáhnitum (oddur upp): punktur -> ásahnit (q, r), námundað
  _hexKey(x, y) {
    const qf = ((Math.sqrt(3) / 3) * x - y / 3) / HEX, rf = ((2 / 3) * y) / HEX;
    let q = Math.round(qf), r = Math.round(rf), s = Math.round(-qf - rf);
    const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - (-qf - rf));
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return [q, r];
  },
  _hexCenter(q, r) {
    return [HEX * Math.sqrt(3) * (q + r / 2), HEX * 1.5 * r];
  },
  // Þéttleiki: fjöldi í hverjum sexhyrningi, litur á lógaritmískum kvarða svo hrinur drekki ekki allt
  _drawDensity(ctx, quakes) {
    const bins = new Map();
    for (const q of quakes) {
      const [x, y] = this._point(q);
      if (!this._visible(x, y, HEX)) continue;
      const [hq, hr] = this._hexKey(x, y);
      const key = hq * 65536 + hr;
      let b = bins.get(key);
      if (!b) {
        const [cx, cy] = this._hexCenter(hq, hr);
        bins.set(key, (b = { n: 0, maxMag: -Infinity, x: cx, y: cy }));
      }
      b.n++;
      if (shownMag(q) > b.maxMag) b.maxMag = shownMag(q);
    }
    let max = 1;
    for (const b of bins.values()) if (b.n > max) max = b.n;
    this._bins = bins;
    // Hámarkið breytist við þysjun, færslu og afspilun; skýringin þarf þá að fylgja
    const changed = max !== this._binMax;
    this._binMax = max;
    if (changed) this.onDensityMax?.();
    const lut = Array.from({ length: 33 }, (_, i) => `rgb(${rampColor(i / 32, DENSITY_RAMPS).join(',')})`);
    ctx.globalAlpha = 0.85;
    for (const b of bins.values()) {
      ctx.fillStyle = lut[Math.round((Math.log1p(b.n) / Math.log1p(max)) * 32)];
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 30);
        const px = b.x + (HEX - 0.5) * Math.cos(a), py = b.y + (HEX - 0.5) * Math.sin(a);
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  _hitBin(x, y) {
    if (!this._bins) return null;
    const [q, r] = this._hexKey(x, y);
    return this._bins.get(q * 65536 + r) ?? null;
  },
  densityMax() {
    return this._mode === 'density' ? this._binMax ?? 0 : 0;
  },

  // --- Kyrrstæð sýn ---
  setStatic(list, win) {
    this._list = [...list].sort(byMagDesc);
    this._win = win;
    // Festur skjálfti lifir af endurhleðslu gagna ef hann er enn í listanum (nýir hlutir, sama gildi)
    if (this._pinned) {
      const p = this._pinned;
      const same = list.find((q) => q.t === p.t && q.lat === p.lat && q.lon === p.lon);
      same ? this.pin(same) : this.unpin();
    }
    this.drawStatic();
  },
  drawStatic() {
    this._ink = css('--ink');
    this._clearHover();
    this._drawPinned();
    const ctx = this._ctx(this._base);
    const grid = (this._grid = new Map());
    this._bins = null;
    if (!this._win) return;
    if (this._mode === 'density') return this._drawDensity(ctx, this._list);
    const [a, b] = this._win;
    const span = Math.max(b - a, 1);
    const ramp = makeRamp();
    const now = Date.now();
    for (const q of this._list) {
      const [x, y] = this._point(q);
      const r = radiusFor(shownMag(q));
      if (!this._visible(x, y, r)) continue;
      const age = clamp((b - q.t) / span, 0, 1);
      this._circle(ctx, x, y, r, ramp(age), 0.92 - 0.45 * age, now - q.t < HOUR, 1, q.sus);
      const key = Math.floor(x / CELL) * 65536 + Math.floor(y / CELL);
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push({ q, x, y, r });
    }
  },
  // Skjálftinn undir punkti (canvas-hnit): sá minnsti sem hittir, því hann er teiknaður ofan á
  _hit(x, y) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let best = null;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const e of this._grid.get(i * 65536 + j) ?? []) {
          if (Math.hypot(e.x - x, e.y - y) <= e.r + 1.5 && (!best || e.r < best.r)) best = e;
        }
      }
    }
    return best;
  },
  _onMove(e) {
    if (player.active) return;
    const p = e.layerPoint;
    const x = p.x - this._origin.x, y = p.y - this._origin.y;
    if (this._mode === 'density') {
      const bin = this._hitBin(x, y);
      if (bin !== this._hover?.bin) {
        this._clearHover();
        if (bin) {
          this._tip = L.tooltip({ className: 'quake-tip', direction: 'top', offset: [0, -HEX] }).setLatLng(e.latlng).setContent(binTooltipHtml(bin));
          this._map.openTooltip(this._tip);
          this._hover = { bin };
        }
      } else if (bin && this._tip) this._tip.setLatLng(e.latlng);
      return;
    }
    const hit = this._hit(x, y);
    if (hit?.q !== this._hover?.q) hit ? this.showTip(hit.q) : this._clearHover();
    this._map.getContainer().style.cursor = hit ? 'pointer' : '';
  },
  _onClick(e) {
    if (player.active || this._mode === 'density') return;
    // Smellur á tengil í festri ábendingu á ekki að losa hana
    if (e.originalEvent?.target?.closest?.('.leaflet-tooltip')) return;
    const p = e.layerPoint;
    const hit = this._hit(p.x - this._origin.x, p.y - this._origin.y);
    hit ? this.pin(hit.q) : this.unpin();
  },
  _tooltip(q, pinned = false) {
    return L.tooltip({ className: 'quake-tip', direction: 'top', offset: [0, -radiusFor(shownMag(q))], interactive: pinned })
      .setLatLng([q.lat, q.lon]).setContent(tooltipHtml(q, pinned));
  },
  // Ábending við músina; hverfur þegar músin fer af skjálftanum
  showTip(q) {
    this._clearHover();
    if (q === this._pinned) return; // festa ábendingin er þegar uppi
    this._tip = this._tooltip(q);
    this._map.openTooltip(this._tip);
    this._hover = { q };
  },
  _clearHover() {
    if (this._tip) this._map.closeTooltip(this._tip);
    this._tip = null;
    this._hover = null;
  },
  // Festur skjálfti (valinn í töflu, tímalínu eða með smelli): auðkenndur með hring og ábendingin
  // helst uppi þótt kortið hreyfist eða músin fari annað, þar til smellt er annars staðar eða Esc
  pin(q) {
    this.unpin();
    this._pinned = q;
    this._pinTip = this._tooltip(q, true);
    this._map.openTooltip(this._pinTip);
    this._clearHover();
    this._drawPinned();
  },
  unpin() {
    if (this._pinTip) this._map.closeTooltip(this._pinTip);
    this._pinTip = null;
    this._pinned = null;
    if (this._size) this._ctx(this._top);
  },
  _drawPinned() {
    const ctx = this._ctx(this._top);
    const q = this._pinned;
    if (!q || player.active) return;
    const [x, y] = this._point(q);
    const r = radiusFor(shownMag(q));
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = css('--accent');
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 7;
    ctx.strokeStyle = css('--surface');
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = css('--accent');
    ctx.stroke();
  },

  // --- Afspilun: grunnlag með settum skjálftum, topplag með nýbirtum ---
  // Grunnlag: allir settir skjálftar, litur eftir aldri miðað við afspilunartímann
  redrawAll(now = performance.now()) {
    this._ink = css('--ink');
    this._grid = new Map();
    const span = Math.max(player.range[1] - player.range[0], 1);
    const ramp = makeRamp();
    const ctx = this._ctx(this._base);
    if (this._mode === 'density') {
      const settled = [];
      for (const q of player.byMag) {
        const shownAt = player.shown.get(q);
        if (shownAt != null && now - shownAt >= POP_MS) settled.push(q);
      }
      this._drawDensity(ctx, settled);
    } else {
      for (const q of player.byMag) {
        const shownAt = player.shown.get(q);
        if (shownAt != null && now - shownAt >= POP_MS) this._drawAt(ctx, q, ramp, span);
      }
    }
    this._lastBase = now;
    this._pending = this._pending.filter((q) => now - player.shown.get(q) < POP_MS);
    this._ctx(this._top);
  },
  _drawAt(ctx, q, ramp, span, p = 1) {
    const [x, y] = this._point(q);
    const r = radiusFor(shownMag(q));
    if (!this._visible(x, y, r)) return;
    const age = clamp((player.t - q.t) / span, 0, 1);
    this._circle(ctx, x, y, r, ramp(age), 0.92 - 0.45 * age, player.t - q.t < HOUR, p, q.sus);
  },
  // Hver rammi: grunnlag með millibili sem vex með fjölda, topplag með öllu sem grunnlagið nær ekki enn til
  draw(now, fresh) {
    this._pending.push(...fresh);
    const interval = clamp(player.shown.size / 25, 16, 500);
    if (now - this._lastBase >= interval) this.redrawAll(now);
    const span = Math.max(player.range[1] - player.range[0], 1);
    const ramp = makeRamp();
    const ctx = this._ctx(this._top);
    for (const q of this._pending) this._drawAt(ctx, q, ramp, span, clamp((now - player.shown.get(q)) / POP_MS, 0, 1));
  },
});

function renderLegend(win) {
  if (state.layer === 'density') {
    const stops = DENSITY_RAMPS[dark() ? 'dark' : 'light'];
    const max = quakeLayer.densityMax();
    legendControl.getContainer().innerHTML = `
      <div>Skjálftar í reit</div>
      <div class="ramp" style="background:linear-gradient(to right, ${stops.join(',')})"></div>
      <div class="ends"><span>1</span><span>${Math.max(1, Math.round(Math.sqrt(max))).toLocaleString('is-IS')}</span><span>${max.toLocaleString('is-IS')}</span></div>
      <div class="ends" style="margin-top:4px"><span>Lógaritmískur kvarði</span></div>`;
    return;
  }
  const stops = RAMPS[dark() ? 'dark' : 'light'];
  const sizes = [1, 2, 3, 4].map((m) => {
    const d = 2 * radiusFor(m);
    return `<div><i style="width:${d}px;height:${d}px"></i>M${m}</div>`;
  });
  legendControl.getContainer().innerHTML = `
    <div>Aldur skjálfta</div>
    <div class="ramp" style="background:linear-gradient(to right, ${stops.join(',')})"></div>
    <div class="ends"><span>nýr</span><span>${spanLabel(win[1] - win[0])}</span></div>
    <div class="sizes">${sizes.join('')}</div>
    <div class="ends" style="margin-top:4px"><span>Útlína: síðasta klukkustund</span></div>${
    quakes.some((q) => q.sus) ? '<div class="ends"><span>Brotinn hringur: óyfirfarin stærð, sýnd sem M4</span></div>' : ''}`;
}

function focusQuake(q) {
  setView('map');
  if (player.active) exitPlayback();
  map.setView([q.lat, q.lon], Math.max(map.getZoom(), 11));
  quakeLayer.pin(q);
}

// --- Tímalína ---

function binSize(span) {
  if (span <= 3 * 24 * HOUR) return HOUR;
  if (span <= 21 * 24 * HOUR) return 6 * HOUR;
  if (span <= 180 * 24 * HOUR) return 24 * HOUR;
  return 7 * 24 * HOUR;
}

function plotFont() {
  return { family: getComputedStyle(document.body).fontFamily, color: css('--ink-2'), size: 12 };
}

function renderTimeline(win) {
  const tl = (timelineList = areaQuakes());
  const x = tl.map((q) => isoLocal(q.t));
  const styles = tl.map((q) => style(q, win));
  const grid = css('--line');
  const bin = binSize(win[1] - win[0]);

  const counts = {
    type: 'histogram',
    x,
    xbins: { size: bin },
    yaxis: 'y2',
    marker: { color: css('--bar') },
    hovertemplate: '%{y} skjálftar<extra></extra>',
  };
  const points = {
    type: 'scattergl',
    mode: 'markers',
    x,
    y: tl.map(shownMag), // grunsamleg stærð teygir annars ásinn upp í „M9“
    customdata: tl.map((q) => [fmtDateTime.format(q.t), q.depth, esc(place(q)), q.sus ? ` (skráð M ${fmt1(q.mag)}, óyfirfarin)` : '']),
    hovertemplate: '<b>M %{y:.1f}</b>%{customdata[3]} · dýpt %{customdata[1]:.1f} km<br>%{customdata[0]}<br>%{customdata[2]}<extra></extra>',
    // Jafnstórir punktar; stærðin er á y-ásnum og misstórir punktar gera þétta tímalínu ólæsilega
    marker: {
      size: 5,
      color: styles.map((s) => s.fill),
      opacity: 0.7,
      line: { width: 0 },
    },
  };

  const axis = { gridcolor: grid, zerolinecolor: grid, linecolor: grid };
  const layout = {
    // Pláss efst fyrir nöfn atburða þegar þeir eru í glugganum
    margin: { l: 44, r: 12, t: eventsIn(win).length ? 26 : 8, b: 32 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: plotFont(),
    showlegend: false,
    // Dregið færir tímalínuna; það sem sést er það sem kortið sýnir. Þysjun með skrunhjóli
    // (eftir smell), hnöppum í stikunni, eða með því að velja kassaþysjun þar.
    dragmode: 'pan',
    bargap: 0.08,
    hovermode: 'closest',
    hoverlabel: { bgcolor: css('--surface'), bordercolor: grid, font: { color: css('--ink') } },
    // Halda vali á tímabili þegar gögn uppfærast sjálfkrafa
    uirevision: `${state.region}|${state.preset}|${state.from}|${state.to}|${state.minMag}|${state.maxMag}|${state.minDepth}|${state.maxDepth}`,
    ...timelineShapes(win),
    // Alltaf skýrt bil: án þess sýnir Plotly öll gögn þegar uirevision breytist en kortið er síað á valið
    xaxis: { ...axis, type: 'date', range: (state.brush ?? win).map(isoLocal) },
    yaxis: { ...axis, domain: [0, 0.68], title: { text: 'Stærð' }, fixedrange: true, rangemode: 'tozero' },
    yaxis2: { ...axis, domain: [0.76, 1], title: { text: 'Fjöldi' }, fixedrange: true, rangemode: 'tozero', tickformat: 'd', nticks: 3 },
  };
  Plotly.react('timeline', [counts, points], layout, {
    displaylogo: false,
    responsive: true,
    scrollZoom: false, // eigin skrunþysjun, aðeins virk eftir smell svo síðan skruni annars
    doubleClick: false, // eigin tvísmellur: Plotly færi annars í fyrsta bilið sem það sá, ekki núverandi glugga
    modeBarButtons: [['pan2d', 'zoom2d'], ['zoomIn2d', 'zoomOut2d'], ['autoScale2d'], ['toImage']],
  });
  // Plotly bætir .on() við elementið við fyrstu teikningu
  if (!timelineBound) bindTimeline();
}

let timelineBound = false;
let timelineList = []; // skjálftarnir sem tímalínan sýnir, í sömu röð (fyrir smell á punkt)

// Bil haldið innan marka, með sömu lengd ef hægt er; aldrei lengra en MAX_SPAN (þysjað um miðjuna)
function clampRange(a, b, lim) {
  if (b - a > MAX_SPAN) {
    const c = (a + b) / 2;
    [a, b] = [c - MAX_SPAN / 2, c + MAX_SPAN / 2];
  }
  const span = Math.min(b - a, lim[1] - lim[0]);
  a = clamp(a, lim[0], lim[1] - span);
  return [a, a + span];
}

// Ystu mörk sem hægt er að draga tímalínuna um: frá elsta skjálfta í grunni til núna
function dataLimits(win) {
  return [Math.min(dataFirst ?? win[0], win[0]), Math.max(Date.now(), win[1])];
}

// Dregið eða þysjað út fyrir sótt gögn: tímabilið verður sérsniðið og jafnt því sem sést, og gögnin sótt.
// Beðið augnablik svo margar hreyfingar í röð (skrunhjól) verði ein sókn.
let extendTimer = 0;
function extendWindow(a, b) {
  state.preset = 'custom';
  state.from = a;
  state.to = b;
  state.brush = null;
  syncControls();
  writeUrl();
  renderBrushChip();
  clearTimeout(extendTimer);
  extendTimer = setTimeout(() => loadQuakes(), 350);
}

const showWindow = (win) => Plotly.relayout('timeline', { 'xaxis.range': [isoMs(win[0]), isoMs(win[1])] });

function bindTimeline() {
  timelineBound = true;
  const el = $('#timeline');
  el.on('plotly_relayout', (ev) => {
    const r0 = ev['xaxis.range[0]'] ?? ev['xaxis.range']?.[0];
    const r1 = ev['xaxis.range[1]'] ?? ev['xaxis.range']?.[1];
    const near = (x, y) => Math.abs(x - y) < 1000;
    if (r0 != null) {
      const win = timeWindow();
      const [a, b] = clampRange(parseLocal(r0), parseLocal(r1), dataLimits(win));
      if (a < win[0] - 1000 || b > win[1] + 1000) {
        // Út fyrir sótt gögn: stækka gluggann og sækja, nema ekkert sé að sækja (við ystu mörk)
        if (near(a, win[0]) && near(b, win[1])) showWindow(win);
        else extendWindow(a, b);
        return;
      }
      if (near(a, win[0]) && near(b, win[1])) {
        // Allur glugginn sýnilegur: ekkert val
        if (!near(a, parseLocal(r0)) || !near(b, parseLocal(r1))) showWindow(win);
        state.brush = null;
      } else {
        state.brush = [a, b];
      }
    } else if (ev['xaxis.autorange']) {
      // Tvísmellur: sýna allan sótta gluggann (kallar þetta aftur með bilinu)
      state.brush = null;
      showWindow(timeWindow());
      return;
    } else return;
    if (player.active) exitPlayback({ rerender: false });
    const list = visibleQuakes();
    const win = timeWindow();
    renderStats(list);
    renderMap(mapQuakes(), win);
    if (state.view === '3d') render3d(list, win);
    if (state.view === 'table') renderTable(list, win);
    renderBrushChip();
  });
  el.on('plotly_click', (ev) => {
    const pt = ev.points.find((p) => p.data.type === 'scattergl');
    if (pt) focusQuake(timelineList[pt.pointIndex]);
  });
  bindTimelineWheel(el);
  el.addEventListener('dblclick', clearBrush);
}

// Skrunhjól þysjar um bendilinn, en aðeins eftir að smellt hefur verið á tímalínuna (eins og kortið),
// annars skrunar síðan. Mörg skrunatvik í röð eru sameinuð í eina endurteiknun per ramma.
function bindTimelineWheel(el) {
  let armed = false;
  let factor = 1;
  let frac = 0.5;
  let raf = 0;
  el.addEventListener('mousedown', () => (armed = true));
  el.addEventListener('click', () => (armed = true));
  // Plotly leggur gagnsæja hulu yfir síðuna meðan músarhnappi er haldið; það telst ekki að yfirgefa tímalínuna
  el.addEventListener('mouseleave', (e) => {
    if (!e.relatedTarget?.classList?.contains('dragcover')) armed = false;
  });
  el.addEventListener('wheel', (e) => {
    if (!armed) return;
    const xa = el._fullLayout?.xaxis;
    if (!xa) return;
    e.preventDefault();
    const x = e.clientX - el.getBoundingClientRect().left - xa._offset;
    frac = clamp(x / xa._length, 0, 1);
    factor *= e.deltaY > 0 ? 1.2 : 1 / 1.2;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const win = timeWindow();
      const [a, b] = state.brush ?? win;
      const c = a + frac * (b - a);
      const [na, nb] = clampRange(c - (c - a) * factor, c + (b - c) * factor, dataLimits(win));
      factor = 1;
      if (nb - na < 60e3) return; // ekki þysja nær en mínútu
      Plotly.relayout('timeline', { 'xaxis.range': [isoMs(na), isoMs(nb)] });
    });
  }, { passive: false });
}

function renderBrushChip() {
  $('#brush-chip').hidden = !state.brush;
  if (state.brush) {
    $('#brush-text').textContent = `Tímabil: ${fmtDateTime.format(state.brush[0])} – ${fmtDateTime.format(state.brush[1])}`;
  }
}

function clearBrush() {
  state.brush = null;
  showWindow(timeWindow());
  render();
}

// --- 3D ---

// Strandlína og jöklar (Natural Earth 1:10m) til að átta sig í 3D sýn
let outline = null;

function loadOutline() {
  fetch('iceland.json')
    .then((r) => r.json())
    .then((d) => {
      outline = d;
      if (state.view === '3d') render3d(visibleQuakes(), timeWindow());
    })
    .catch(() => {});
}

// Línur á yfirborði (dýpt 0). Punktar utan rammans eru felldir burt en nágrannar
// punkta innan hans haldnir svo línan nái að brún; Plotly klippir afganginn við ásana.
function outlineTrace(rings, r, color, width) {
  const inside = (p) => p && p[0] >= r.lon[0] && p[0] <= r.lon[1] && p[1] >= r.lat[0] && p[1] <= r.lat[1];
  const x = [], y = [];
  const gap = () => x.length && x[x.length - 1] !== null && (x.push(null), y.push(null));
  for (const ring of rings) {
    ring.forEach((p, i) => {
      if (inside(p) || inside(ring[i - 1]) || inside(ring[i + 1])) {
        x.push(p[0]);
        y.push(p[1]);
      } else gap();
    });
    gap();
  }
  return {
    type: 'scatter3d', mode: 'lines', x, y, z: x.map((v) => (v === null ? null : 0)),
    line: { color, width }, hoverinfo: 'skip', showlegend: false, connectgaps: false,
  };
}

// 'shown' er sá hluti listans sem er teiknaður (afspilun); ásar og rammi miðast við allan listann
function render3d(list, win, shown = list, at) {
  const region = regions.find((r) => r.id === state.region);
  let r = focus ?? bounds(region);
  if (!focus && r === ICELAND && list.length) {
    // Allt landið ásamt skjálftum utan við strönd
    const pad = (a, [lo, hi]) => [minOf(a, lo + 0.1) - 0.1, maxOf(a, hi - 0.1) + 0.1];
    r = { lat: pad(list.map((q) => q.lat), ICELAND.lat), lon: pad(list.map((q) => q.lon), ICELAND.lon) };
  }
  const latMid = (r.lat[0] + r.lat[1]) / 2;
  const kmX = (r.lon[1] - r.lon[0]) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  const kmY = (r.lat[1] - r.lat[0]) * 111.32;
  const maxDepth = maxOf(list.map((q) => q.depth), 10);
  const styles = shown.map((q) => style(q, win, at));
  const grid = css('--line');
  const axis = { gridcolor: grid, zerolinecolor: grid, backgroundcolor: 'transparent', color: css('--ink-2') };

  const trace = {
    type: 'scatter3d',
    mode: 'markers',
    x: shown.map((q) => q.lon),
    y: shown.map((q) => q.lat),
    z: shown.map((q) => q.depth),
    customdata: shown.map((q) => [shownMag(q), fmtDateTime.format(q.t), esc(place(q))]),
    hovertemplate: '<b>M %{customdata[0]:.1f}</b><br>Dýpt: %{z:.1f} km<br>%{customdata[1]}<br>%{customdata[2]}<extra></extra>',
    marker: {
      size: styles.map((s) => clamp(s.radius * 0.9, 2, 30)),
      color: styles.map((s) => s.fill),
      opacity: 0.75,
      line: { width: 0 },
    },
  };
  const inRegion = places.filter((p) => p.lat > r.lat[0] && p.lat < r.lat[1] && p.lon > r.lon[0] && p.lon < r.lon[1]);
  const mapLines = outline
    ? [outlineTrace(outline.glaciers, r, css('--glacier'), 2), outlineTrace(outline.coast, r, css('--ink-2'), 3)]
    : [];
  // Upptök á yfirborði (dýpt 0) svo sjáist hvar skjálftinn er óháð sjónarhorni
  const epicenters = {
    type: 'scatter3d',
    mode: 'markers',
    x: trace.x,
    y: trace.y,
    z: shown.map(() => 0),
    marker: { size: 3.5, color: css('--ink-2'), opacity: 0.7, line: { width: 0 } },
    hoverinfo: 'skip',
  };
  Plotly.react('plot3d', [...mapLines, epicenters, trace], {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    showlegend: false,
    paper_bgcolor: 'transparent',
    font: plotFont(),
    uirevision: state.region,
    hoverlabel: { bgcolor: css('--surface'), bordercolor: grid, font: { color: css('--ink') } },
    scene: {
      xaxis: { ...axis, title: 'Lengdargráða', range: r.lon, ticksuffix: '°' },
      yaxis: { ...axis, title: 'Breiddargráða', range: r.lat, ticksuffix: '°' },
      zaxis: { ...axis, title: 'Dýpt', range: [maxDepth, 0], ticksuffix: ' km' },
      aspectmode: 'manual',
      aspectratio: { x: kmX / kmY, y: 1, z: 0.4 },
      camera: { eye: { x: 0, y: -1.6, z: 1.1 } },
      annotations: inRegion.map((p) => ({
        x: p.lon, y: p.lat, z: 0, text: p.name, showarrow: true, arrowhead: 0, arrowcolor: css('--ink-3'),
        font: { color: css('--ink'), size: 11 },
      })),
    },
  }, { displaylogo: false, responsive: true });
}

// --- Tafla ---

const TABLE_LIMIT = 1000;
// Röðun með smelli á dálkheiti; sjálfgefið nýjasti fyrst
const tableSort = { key: 't', desc: true };
const SORT_KEYS = { t: 'Tími', mag: 'Stærð', depth: 'Dýpt' };

function renderTable(list, win) {
  const { key, desc } = tableSort;
  const rows = [...list].sort((a, b) => (desc ? b[key] - a[key] : a[key] - b[key]) || b.t - a.t).slice(0, TABLE_LIMIT);
  const th = (k, cls = '') => {
    const active = k === tableSort.key;
    return `<th class="sortable ${cls}" data-sort="${k}" aria-sort="${active ? (desc ? 'descending' : 'ascending') : 'none'}">${SORT_KEYS[k]}<span class="sort-arrow">${active ? (desc ? '▼' : '▲') : ''}</span></th>`;
  };
  const body = rows.map((q, i) => `<tr data-i="${i}">
      <td>${fmtDateTime.format(q.t)}</td>
      <td class="num"><span class="swatch" style="background:${style(q, win).fill}"></span>${fmt1(q.mag)}</td>
      <td class="num">${fmt1(q.depth)} km</td>
      <td>${esc(place(q))}</td>
      <td class="num">${q.q != null ? fmt1(q.q) : ''}</td>
    </tr>`).join('');
  const more = list.length > TABLE_LIMIT ? `<caption>Sýni ${TABLE_LIMIT} af ${list.length.toLocaleString('is-IS')} eftir röðun</caption>` : '';
  $('#table').innerHTML = `${more}<thead><tr>${th('t')}${th('mag', 'num')}${th('depth', 'num')}<th>Staðsetning</th><th class="num">Gæði</th></tr></thead><tbody>${body}</tbody>`;
  $('#table').onclick = (e) => {
    const h = e.target.closest('th[data-sort]');
    if (h) {
      tableSort.desc = h.dataset.sort === tableSort.key ? !tableSort.desc : true;
      tableSort.key = h.dataset.sort;
      renderTable(list, win);
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (tr) focusQuake(rows[+tr.dataset.i]);
  };
}

// ---------- Afspilun ----------
// Skjálftar tímabilsins birtast í þeirri röð sem þeir urðu, allt tímabilið á `duration` ms (30 s sjálfgefið).
// Á kortinu teiknar QuakeCanvas grunnlag með „settum“ skjálftum, endurteiknað með aðlöguðu millibili
// (litur kólnar með aldri miðað við afspilunartímann), og topplag með nýbirtum skjálftum sem skreppa
// saman úr yfirstærð með hring sem þenst út, teiknað í hverjum ramma.

const POP_MS = 700;
const UI_EVERY = 100; // sleði, tími, tímalína
const STATS_EVERY = 250; // tölur og 3D

const player = {
  active: false, // afspilunarlag í stað merkja
  playing: false,
  t: 0, // afspilunartími, ms
  duration: 30e3,
  range: null, // [ms, ms]
  list: [], // skjálftar tímabilsins í tímaröð
  cursor: 0, // fyrsti skjálfti sem er ekki enn birtur
  shown: new Map(), // skjálfti -> performance.now() þegar hann birtist
  lastFrame: 0,
  lastUi: 0,
  lastStats: 0,
  raf: 0,
};

const playRange = () => state.brush ?? timeWindow();

const durationLabel = (ms) => (ms < 60e3 ? `${ms / 1000} s` : `${ms / 60e3} mín`);

// Litaskali sem fall af aldri (0 = nýr, 1 = jafngamall tímabilinu), flýtiminni fyrir hverja teikningu
function makeRamp() {
  const lut = Array.from({ length: 65 }, (_, i) => `rgb(${rampColor(i / 64).join(',')})`);
  return (t) => lut[Math.round(clamp(t, 0, 1) * 64)];
}

function playheadShapes() {
  if (!player.active) return [];
  const x = isoLocal(player.t);
  return [{ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color: css('--accent'), width: 2 } }];
}

function enterPlayback() {
  player.active = true;
  player.range = playRange();
  player.list = visibleQuakes();
  player.byMag = [...player.list].sort((a, b) => b.mag - a.mag);
  player.t = player.range[0];
  player.cursor = 0;
  player.shown = new Map();
  quakeLayer.unpin();
  quakeLayer.redrawAll();
  updatePlaybackUi();
}

function exitPlayback({ rerender = true } = {}) {
  player.playing = false;
  cancelAnimationFrame(player.raf);
  player.active = false;
  Plotly.relayout('timeline', timelineShapes());
  const list = visibleQuakes();
  const win = timeWindow();
  renderMap(mapQuakes(), win); // kyrrstæð sýn aftur á canvasið
  if (rerender) {
    renderStats(list);
    if (state.view === '3d') render3d(list, win);
  }
  updatePlaybackUi();
}

function startPlayback() {
  if (!player.active) enterPlayback();
  if (player.t >= player.range[1]) seekPlayback(0);
  player.playing = true;
  player.lastFrame = performance.now();
  player.raf = requestAnimationFrame(playbackFrame);
  updatePlaybackUi();
}

function pausePlayback() {
  player.playing = false;
  cancelAnimationFrame(player.raf);
  updatePlaybackUi();
}

function togglePlayback() {
  if (player.playing) pausePlayback();
  else startPlayback();
}

function playbackFrame(now) {
  if (!player.playing) return;
  const span = player.range[1] - player.range[0];
  player.t = Math.min(player.range[1], player.t + ((now - player.lastFrame) * span) / player.duration);
  player.lastFrame = now;
  const fresh = [];
  while (player.cursor < player.list.length && player.list[player.cursor].t <= player.t) {
    const q = player.list[player.cursor++];
    player.shown.set(q, now);
    fresh.push(q);
  }
  quakeLayer.draw(now, fresh);
  const done = player.t >= player.range[1];
  if (done || now - player.lastUi >= UI_EVERY) {
    player.lastUi = now;
    updatePlaybackUi();
  }
  if (done || now - player.lastStats >= STATS_EVERY) {
    player.lastStats = now;
    renderStats(player.list.slice(0, player.cursor));
    if (state.view === '3d') renderPlayback3d();
  }
  if (done) pausePlayback();
  else player.raf = requestAnimationFrame(playbackFrame);
}

// Hoppa á stað (0–1): allt fram að staðnum telst sett, engin popp
function seekPlayback(frac) {
  if (!player.active) enterPlayback();
  player.t = player.range[0] + frac * (player.range[1] - player.range[0]);
  player.shown = new Map();
  player.cursor = 0;
  while (player.cursor < player.list.length && player.list[player.cursor].t <= player.t) {
    player.shown.set(player.list[player.cursor++], -Infinity);
  }
  quakeLayer.redrawAll();
  renderStats(player.list.slice(0, player.cursor));
  if (state.view === '3d') renderPlayback3d();
  updatePlaybackUi();
}

function renderPlayback3d() {
  render3d(player.list, player.range, player.list.slice(0, player.cursor), player.t);
}

function updatePlaybackUi() {
  const [a, b] = player.active ? player.range : playRange();
  $('#play').textContent = player.playing ? '❙❙' : '▶';
  $('#play').setAttribute('aria-label', player.playing ? 'Hlé' : 'Spila');
  $('#play').setAttribute('aria-pressed', player.playing);
  $('#play-stop').hidden = !player.active;
  if (player.active) {
    $('#scrub').value = Math.round(((player.t - a) / Math.max(b - a, 1)) * 1000);
    $('#play-time').textContent = fmtDateTime.format(player.t);
    Plotly.relayout('timeline', timelineShapes());
  } else {
    $('#scrub').value = 0;
    $('#play-time').textContent = `${spanLabel(b - a)} á ${durationLabel(player.duration)}`;
  }
}

function bindPlayback() {
  $('#play').onclick = togglePlayback;
  $('#play-stop').onclick = () => exitPlayback();
  $('#scrub').oninput = (e) => seekPlayback(e.target.value / 1000);
  $('#play-duration').onchange = (e) => {
    player.duration = +e.target.value;
    updatePlaybackUi();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return player.active ? exitPlayback() : quakeLayer.unpin();
    // Bilslá í reit eða á hnappi hefur sína eigin merkingu
    if (e.key !== ' ' || state.view === 'table') return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, button, [contenteditable]')) return;
    e.preventDefault();
    togglePlayback();
  });
}

// ---------- Eftirskjálftar ----------
// Fyrir fastan skjálfta (M ≥ 3): skjálftar á eftir honum innan radíuss sem vex með stærð, út sótt tímabil.
// Omori: tíðni n(t) ∝ t^-p, p metið með aðhvarfi í log-log á lógaritmískum tímabilum.
// Gutenberg–Richter: log10 N(≥M) = a − bM, b metið með hámarkslíkindum ofan heildarmarks Mc
// (algengasta stærðin). Båth: stærsti eftirskjálfti er að jafnaði ~1,2 stærðarstigum minni.

const AFTERSHOCK_MIN_MAG = 3;
let aftershockMain = null;

// Radíus í km: um 3 km fyrir M3, 5 fyrir M4, 12 fyrir M5, 34 fyrir M6
const aftershockRadiusKm = (mag) => 2 + 10 ** (0.5 * mag - 1.5);

const distKm = (a, b) => {
  const dy = (b.lat - a.lat) * 111.32;
  const dx = (b.lon - a.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
};

// Línulegt aðhvarf y = a + b·x
function fitLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

function analyzeAftershocks(main) {
  const r = aftershockRadiusKm(main.mag);
  const end = Math.min(timeWindow()[1], Date.now());
  const list = quakes.filter((q) => q !== main && q.t > main.t && q.t <= end && distKm(main, q) <= r).sort((a, b) => a.t - b.t);
  const hours = (end - main.t) / 3600e3;

  // Omori: lógaritmísk tímabil frá 10 mín, 6 á hverja tíund
  const edges = [];
  for (let e = Math.log10(1 / 6); e <= Math.log10(Math.max(hours, 1)) + 1e-9; e += 1 / 6) edges.push(10 ** e);
  if (edges[edges.length - 1] < hours) edges.push(hours);
  const rate = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const n = list.filter((q) => { const h = (q.t - main.t) / 3600e3; return h >= edges[i] && h < edges[i + 1]; }).length;
    if (n > 0) rate.push({ t: Math.sqrt(edges[i] * edges[i + 1]), n: n / (edges[i + 1] - edges[i]) });
  }
  const omori = rate.length >= 3 ? fitLine(rate.map((p) => Math.log10(p.t)), rate.map((p) => Math.log10(p.n))) : null;

  // Gutenberg–Richter
  const mags = list.map((q) => Math.round(q.mag * 10) / 10);
  const hist = new Map();
  for (const m of mags) hist.set(m, (hist.get(m) ?? 0) + 1);
  let mc = null, best = 0;
  for (const [m, n] of hist) if (n > best || (n === best && m < mc)) { best = n; mc = m; }
  const above = mags.filter((m) => m >= mc);
  const bValue = above.length >= 10 ? Math.log10(Math.E) / (above.reduce((s, m) => s + m, 0) / above.length - (mc - 0.05)) : null;
  const steps = [];
  if (mags.length) {
    const min = minOf(mags), max = maxOf(mags);
    for (let m = min; m <= max + 1e-9; m += 0.1) {
      const mm = Math.round(m * 10) / 10;
      steps.push({ m: mm, n: mags.filter((x) => x >= mm - 1e-9).length });
    }
  }
  const largest = list.reduce((m, q) => (trusted(q) && (!m || q.mag > m.mag) ? q : m), null);
  return { list, r, hours, rate, omori, mc, bValue, steps, largest };
}

function openAftershocks(main) {
  aftershockMain = main;
  renderAftershocks();
  $('#aftershocks').hidden = false;
  $('#aftershocks').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeAftershocks() {
  aftershockMain = null;
  $('#aftershocks').hidden = true;
}

function renderAftershocks() {
  const main = aftershockMain;
  if (!main) return;
  const a = analyzeAftershocks(main);
  $('#aftershocks-title').textContent = `Eftirskjálftar · M ${fmt1(main.mag)} ${place(main)} ${fmtDateTime.format(main.t)}`;
  const parts = [`${a.list.length.toLocaleString('is-IS')} innan ${fmt1(a.r)} km á ${spanLabel(a.hours * HOUR)}`];
  if (a.largest) parts.push(`stærsti M ${fmt1(a.largest.mag)} (Δ ${fmt1(main.mag - a.largest.mag)}, Båth ≈ 1,2)`);
  if (a.omori) parts.push(`Omori p = ${fmt1(-a.omori.b)}`);
  if (a.bValue) parts.push(`b = ${fmt1(a.bValue)} (Mc ${fmt1(a.mc)})`);
  $('#aftershocks-summary').textContent = parts.join(' · ');
  $('#aftershocks-note').textContent = a.list.length < 20
    ? 'Fáir eftirskjálftar í sóttum gögnum; stækkaðu tímabilið eða svæðið til að fá betra mat.'
    : a.hours < 24 * 7 ? 'Sótt tímabil nær skemur en viku eftir skjálftann; lengra tímabil gefur betra mat á p.' : '';

  const grid = css('--line');
  const accent = css('--accent');
  const axis = { gridcolor: grid, zerolinecolor: grid, linecolor: grid };
  const traces = [
    { type: 'scatter', mode: 'markers', x: a.rate.map((p) => p.t), y: a.rate.map((p) => p.n), name: 'Tíðni', marker: { color: css('--bar'), size: 8 },
      hovertemplate: '%{x:.2f} klst eftir: %{y:.2f} á klst<extra></extra>' },
    { type: 'scatter', mode: 'markers', x: a.steps.map((s) => s.m), y: a.steps.map((s) => s.n), name: 'N(≥M)', xaxis: 'x2', yaxis: 'y2', marker: { color: css('--bar'), size: 7 },
      hovertemplate: '%{y} skjálftar ≥ M %{x:.1f}<extra></extra>' },
  ];
  if (a.omori && a.rate.length) {
    const xs = [a.rate[0].t, a.rate[a.rate.length - 1].t];
    traces.push({ type: 'scatter', mode: 'lines', x: xs, y: xs.map((t) => 10 ** (a.omori.a + a.omori.b * Math.log10(t))), name: `p = ${fmt1(-a.omori.b)}`, line: { color: accent, width: 2 }, hoverinfo: 'skip' });
  }
  if (a.bValue && a.steps.length) {
    const nMc = a.steps.find((s) => s.m >= a.mc - 1e-9)?.n ?? 1;
    const xs = [a.mc, a.steps[a.steps.length - 1].m];
    traces.push({ type: 'scatter', mode: 'lines', x: xs, y: xs.map((m) => nMc * 10 ** (-a.bValue * (m - a.mc))), name: `b = ${fmt1(a.bValue)}`, xaxis: 'x2', yaxis: 'y2', line: { color: accent, width: 2 }, hoverinfo: 'skip' });
  }
  Plotly.react('aftershocks-plot', traces, {
    margin: { l: 56, r: 12, t: 28, b: 40 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: plotFont(), showlegend: false,
    hoverlabel: { bgcolor: css('--surface'), bordercolor: grid, font: { color: css('--ink') } },
    annotations: [
      { text: 'Tíðni eftirskjálfta (Omori)', xref: 'paper', yref: 'paper', x: 0, xanchor: 'left', y: 1.08, showarrow: false, font: { size: 12 } },
      { text: 'Stærðardreifing (Gutenberg–Richter)', xref: 'paper', yref: 'paper', x: 0.55, xanchor: 'left', y: 1.08, showarrow: false, font: { size: 12 } },
    ],
    xaxis: { ...axis, type: 'log', domain: [0, 0.45], title: { text: 'Klst eftir skjálftann' } },
    yaxis: { ...axis, type: 'log', title: { text: 'Skjálftar á klst' } },
    xaxis2: { ...axis, domain: [0.55, 1], title: { text: 'Stærð M' } },
    yaxis2: { ...axis, type: 'log', anchor: 'x2', title: { text: 'Fjöldi ≥ M' } },
  }, { displaylogo: false, responsive: true, modeBarButtons: [['toImage']] });
}

// ---------- Hitakort ----------
// Samanlögð orka eða fjöldi skjálfta í ~1 km reitum yfir heil ár, reiknað og geymt á þjóni (src/heat.ts).
// Orka er sýnd sem jafngild stærð: einn skjálfti af þeirri stærð losar jafn mikla orku og allir í reitnum
// saman (E ∝ 10^(1,5·M)), svo stórir skjálftar vega eins og þeir eiga að gera en þúsundir smárra telja líka.

const HEAT_CELLS = { lat: 100, lon: 50 }; // reitir á gráðu, sama og CELLS_PER_DEG í heat.ts
const HEAT_MIN_PX = 6; // reitir sameinaðir (2×2, 4×4…) þar til hver er a.m.k. þetta stór á skjá
const HEAT_SPAN = 4; // orka: litaskalinn nær 4 stærðareiningar niður frá þeim mesta (milljónfaldur orkumunur)

const heat = { map: null, layer: null, legend: null, cells: [], years: [], seq: 0, yearsSeq: 0, statusVersion: null, anchor: null };

function decodeHeat(c) {
  const out = new Array(c.n);
  for (let i = 0; i < c.n; i++) {
    out[i] = { y: c.y[i], x: c.x[i], n: c.count[i], e: 10 ** ((1.5 * c.meq[i]) / 100), mx: c.mx[i] / 10 };
  }
  return out;
}

const heatYearsLabel = () => (state.heatFrom === state.heatTo ? `${state.heatFrom}` : `${state.heatFrom}–${state.heatTo}`);

function heatTooltipHtml(b, k) {
  return `<b>${b.n.toLocaleString('is-IS')} ${b.n === 1 ? 'skjálfti' : 'skjálftar'}</b><br>
    samanlögð orka ≈ M ${fmt1(Math.log10(b.e) / 1.5)}<br>
    <span class="muted">stærsti M ${fmt1(b.mx)} · ${heatYearsLabel()} · reitur ~${k} km</span>`;
}

// Reitir teiknaðir á canvas í skjáhnitum og endurteiknaðir eftir hverja hreyfingu
const HeatLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'heat-canvas leaflet-zoom-hide');
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend zoomend resize', this._redraw, this);
    map.on('mousemove', this._hover, this);
    map.on('mouseout', this._unhover, this);
    this._redraw();
  },
  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend resize', this._redraw, this);
    map.off('mousemove', this._hover, this);
    map.off('mouseout', this._unhover, this);
  },
  setData(cells, metric) {
    this._cells = cells;
    this._metric = metric;
    this._redraw();
  },
  _redraw() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const c = this._canvas;
    c.width = size.x * dpr;
    c.height = size.y * dpr;
    c.style.width = `${size.x}px`;
    c.style.height = `${size.y}px`;
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (!this._cells?.length) {
      this._blocks = null;
      renderHeatLegend(null);
      return;
    }

    // Hversu margir reitir sameinast: hæð eins reits á skjá við miðju kortsins
    const mid = map.getCenter();
    const px = Math.abs(map.latLngToContainerPoint(mid).y - map.latLngToContainerPoint([mid.lat + 1 / HEAT_CELLS.lat, mid.lng]).y);
    let k = 1;
    while (px * k < HEAT_MIN_PX && k < 256) k *= 2;

    // Fjöldi og orka leggjast saman, stærsti skjálfti er hámark
    const blocks = new Map();
    for (const cell of this._cells) {
      const by = Math.floor(cell.y / k), bx = Math.floor(cell.x / k);
      const key = by * 1e6 + bx;
      let b = blocks.get(key);
      if (!b) blocks.set(key, (b = { by, bx, n: 0, e: 0, mx: -Infinity }));
      b.n += cell.n;
      b.e += cell.e;
      if (cell.mx > b.mx) b.mx = cell.mx;
    }
    const metric = this._metric;
    const value = metric === 'count' ? (b) => Math.log10(b.n) : (b) => Math.log10(b.e) / 1.5;
    let hi = -Infinity;
    for (const b of blocks.values()) hi = Math.max(hi, value(b));
    const lo = metric === 'count' ? 0 : hi - HEAT_SPAN;
    const lut = Array.from({ length: 65 }, (_, i) => `rgb(${rampColor(i / 64, DENSITY_RAMPS).join(',')})`);

    const view = map.getBounds().pad(0.05);
    const [s, n, w, e] = [view.getSouth(), view.getNorth(), view.getWest(), view.getEast()];
    const dLat = k / HEAT_CELLS.lat, dLon = k / HEAT_CELLS.lon;
    for (const b of blocks.values()) {
      const lat0 = b.by * dLat, lon0 = b.bx * dLon;
      if (lat0 + dLat < s || lat0 > n || lon0 + dLon < w || lon0 > e) continue;
      const p0 = map.latLngToContainerPoint([lat0 + dLat, lon0]);
      const p1 = map.latLngToContainerPoint([lat0, lon0 + dLon]);
      const t = clamp((value(b) - lo) / Math.max(hi - lo, 1e-9), 0, 1);
      // Veikir reitir nær gegnsæir svo kortið sjáist og strjálir smáskjálftar þeki ekki allt
      ctx.globalAlpha = 0.08 + 0.87 * t ** 0.7;
      ctx.fillStyle = lut[Math.round(t * 64)];
      ctx.fillRect(p0.x, p0.y, Math.max(p1.x - p0.x, 1), Math.max(p1.y - p0.y, 1));
    }
    ctx.globalAlpha = 1;
    this._blocks = blocks;
    this._k = k;
    renderHeatLegend({ metric, lo, hi, k });
    if (this._tipLatLng) this._hover({ latlng: this._tipLatLng });
  },
  _hover(e) {
    if (!this._blocks) return;
    const k = this._k;
    const by = Math.floor((e.latlng.lat * HEAT_CELLS.lat) / k), bx = Math.floor((e.latlng.lng * HEAT_CELLS.lon) / k);
    const b = this._blocks.get(by * 1e6 + bx);
    if (!b) return this._unhover();
    this._tipLatLng = e.latlng;
    this._tip ??= L.tooltip({ className: 'quake-tip', direction: 'top', offset: [0, -8] });
    this._tip.setLatLng([(by + 1) * (k / HEAT_CELLS.lat), (bx + 0.5) * (k / HEAT_CELLS.lon)]).setContent(heatTooltipHtml(b, k));
    this._map.openTooltip(this._tip);
  },
  _unhover() {
    this._tipLatLng = null;
    if (this._tip) this._map.closeTooltip(this._tip);
  },
});

function renderHeatLegend(d) {
  const el = heat.legend?.getContainer();
  if (!el) return;
  if (!d) {
    el.innerHTML = '<div>Engir skjálftar á tímabilinu</div>';
    return;
  }
  const stops = DENSITY_RAMPS[dark() ? 'dark' : 'light'];
  const ends = d.metric === 'count'
    ? ['1', Math.round(10 ** d.hi).toLocaleString('is-IS')]
    : [`≤ M ${fmt1(d.lo)}`, `M ${fmt1(d.hi)}`];
  el.innerHTML = `
    <div>${d.metric === 'count' ? 'Fjöldi skjálfta í reit' : 'Samanlögð orka í reit'}</div>
    <div class="ramp" style="background:linear-gradient(to right, ${stops.join(',')})"></div>
    <div class="ends"><span>${ends[0]}</span><span>${ends[1]}</span></div>
    <div class="ends" style="margin-top:4px"><span>${d.metric === 'count'
      ? 'Lógaritmískur kvarði'
      : 'Sem stærð eins skjálfta'} · reitir ~${d.k} km</span></div>`;
}

function initHeatMap() {
  const m = (heat.map = L.map('heatmap', { zoomSnap: 0.25, scrollWheelZoom: false, zoomAnimation: false }));
  m.on('click focus', () => m.scrollWheelZoom.enable());
  m.on('mouseout blur', () => m.scrollWheelZoom.disable());
  const base = makeBaseLayers();
  base.Kort.addTo(m);
  L.control.layers(base, null, { position: 'topright' }).addTo(m);
  L.control.scale({ imperial: false }).addTo(m);
  heat.layer = new HeatLayer().addTo(m);
  heat.legend = L.control({ position: 'bottomright' });
  heat.legend.onAdd = () => L.DomUtil.create('div', 'legend');
  heat.legend.addTo(m);
  fitRegion(m);
}

async function loadHeatYears() {
  const seq = ++heat.yearsSeq;
  const res = await fetch(`/api/heat/years?region=${encodeURIComponent(state.region)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  const data = await res.json();
  if (seq !== heat.yearsSeq) return false;
  heat.years = data.years;
  const first = heat.years[0].year, last = heat.years[heat.years.length - 1].year;
  const options = heat.years.map((y) => `<option value="${y.year}">${y.year}</option>`).join('');
  if ($('#heat-from').options.length !== heat.years.length) {
    $('#heat-from').innerHTML = options;
    $('#heat-to').innerHTML = options;
  }
  state.heatFrom = clamp(state.heatFrom ?? first, first, last);
  state.heatTo = clamp(state.heatTo ?? last, first, last);
  if (state.heatFrom > state.heatTo) [state.heatFrom, state.heatTo] = [state.heatTo, state.heatFrom];
  syncHeatControls();
  renderHeatYears();
  return true;
}

async function loadHeat({ quiet = false } = {}) {
  const seq = ++heat.seq;
  if (!quiet) setStatus('Sæki hitakort…');
  try {
    const res = await fetch(`/api/heat?from=${state.heatFrom}&to=${state.heatTo}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    const data = await res.json();
    if (seq !== heat.seq) return;
    heat.cells = decodeHeat(data);
    heat.layer.setData(heat.cells, state.heatMetric);
    renderHeatSummary();
    const s = await checkStatus();
    if (s) heat.statusVersion = s.version;
  } catch (e) {
    if (seq === heat.seq) setStatus(`Villa: ${e.message}`, 'bad');
  }
}

async function showHeat() {
  if (!heat.map) initHeatMap();
  heat.map.invalidateSize();
  try {
    if (await loadHeatYears()) await loadHeat();
  } catch (e) {
    setStatus(`Villa: ${e.message}`, 'bad');
  }
}

function renderHeatSummary() {
  const inRange = heat.years.filter((y) => y.year >= state.heatFrom && y.year <= state.heatTo);
  const n = inRange.reduce((s, y) => s + y.n, 0);
  const regionName = regions.find((r) => r.id === state.region)?.name ?? '';
  $('#heat-summary').textContent = `${n.toLocaleString('is-IS')} skjálftar · ${regionName} · ${heatYearsLabel()}`;
}

function syncHeatControls() {
  $('#heat-from').value = state.heatFrom ?? '';
  $('#heat-to').value = state.heatTo ?? '';
  for (const b of $$('#heat-metric [data-metric]')) b.setAttribute('aria-pressed', b.dataset.metric === state.heatMetric);
}

// Súlur eftir árum á völdu svæði: orka sem jafngild stærð eða fjöldi. Valin ár dekkri.
function renderHeatYears() {
  const ys = heat.years;
  if (!ys.length) return;
  const energy = state.heatMetric === 'energy';
  const values = ys.map((d) => (energy ? d.meq : d.n));
  // Stærð er lógaritmísk og hefur ekkert eðlilegt núll, svo súlurnar byrja aðeins neðan við minnsta gildi
  const base = energy ? Math.floor(minOf(values.filter((v) => v != null), 9)) - 0.5 : 0;
  const grid = css('--line');
  const axis = { gridcolor: grid, zerolinecolor: grid, linecolor: grid, fixedrange: true };
  Plotly.react('heat-years', [{
    type: 'bar',
    x: ys.map((d) => d.year),
    y: values.map((v) => (v == null ? 0 : v - base)),
    base,
    customdata: ys.map((d) => (energy
      ? d.meq == null ? 'engir skjálftar' : `samanlagt ≈ M ${fmt1(d.meq)} · ${d.n.toLocaleString('is-IS')} skjálftar`
      : `${d.n.toLocaleString('is-IS')} skjálftar`)),
    hovertemplate: '<b>%{x}</b>: %{customdata}<extra></extra>',
    marker: { color: ys.map((d) => (d.year >= state.heatFrom && d.year <= state.heatTo ? css('--ink-2') : css('--bar'))) },
  }], {
    margin: { l: 48, r: 12, t: 8, b: 28 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: plotFont(),
    showlegend: false,
    bargap: 0.15,
    dragmode: false,
    hovermode: 'closest',
    hoverlabel: { bgcolor: css('--surface'), bordercolor: grid, font: { color: css('--ink') } },
    xaxis: { ...axis, tickformat: 'd' },
    yaxis: { ...axis, title: { text: energy ? 'Orka (M)' : 'Fjöldi' }, tickformat: energy ? '.0f' : '~s' },
  }, { displaylogo: false, responsive: true, displayModeBar: false });
  if (!heat.yearsBound) bindHeatYears();
}

function bindHeatYears() {
  heat.yearsBound = true;
  const el = $('#heat-years');
  el.on('plotly_click', (ev) => {
    const year = ev.points?.[0]?.x;
    if (year == null) return;
    if (ev.event?.shiftKey && heat.anchor != null) setHeatYears(Math.min(heat.anchor, year), Math.max(heat.anchor, year));
    else {
      heat.anchor = year;
      setHeatYears(year, year);
    }
  });
  el.on('plotly_doubleclick', () => {
    heat.anchor = null;
    setHeatYears(heat.years[0].year, heat.years[heat.years.length - 1].year);
  });
}

function setHeatYears(from, to) {
  if (from > to) [from, to] = [to, from];
  state.heatFrom = from;
  state.heatTo = to;
  syncHeatControls();
  writeUrl();
  renderHeatYears();
  loadHeat();
}

function setHeatMetric(metric) {
  state.heatMetric = metric;
  syncHeatControls();
  writeUrl();
  heat.layer?.setData(heat.cells, metric);
  renderHeatYears();
}

function bindHeatControls() {
  $('#heat-from').onchange = (e) => setHeatYears(+e.target.value, state.heatTo);
  $('#heat-to').onchange = (e) => setHeatYears(state.heatFrom, +e.target.value);
  $('#heat-metric').onclick = (e) => {
    const b = e.target.closest('[data-metric]');
    if (b) setHeatMetric(b.dataset.metric);
  };
}

// ---------- Viðmót ----------

function setView(view) {
  if (view === 'heat' && player.active) exitPlayback();
  state.view = view;
  for (const b of $$('.tabs [data-view]')) b.setAttribute('aria-selected', b.dataset.view === view);
  for (const id of ['map', '3d', 'table', 'heat']) $(`#view-${id}`).hidden = id !== view;
  // Hitakort hefur eigin ársval; síur og spjöld sem eiga við staka skjálfta eru falin (.point-only)
  document.body.classList.toggle('heat-mode', view === 'heat');
  if (view === 'heat') {
    showHeat();
    writeUrl();
    return;
  }
  $('#playbar').hidden = view === 'table';
  const list = visibleQuakes();
  const win = timeWindow();
  if (view === 'map') {
    map.invalidateSize();
    // Svæði valið meðan kortið var falið, annars sýnilega svæðið eins og það er
    if (mapFitPending) {
      mapFitPending = false;
      fitRegion();
    } else onMapMoved();
  }
  if (view === '3d') render3d(list, win);
  if (view === '3d' && player.active) renderPlayback3d();
  if (view === 'table') renderTable(list, win);
  writeUrl();
}

function syncControls() {
  if (state.event && !selectedEvent()) state.event = null;
  $('#events').value = state.event ?? '';
  renderEventCard();
  $('#region').value = state.region;
  for (const b of $$('#presets button')) b.setAttribute('aria-pressed', b.dataset.preset === state.preset);
  $('#custom-range').hidden = state.preset !== 'custom';
  $('#from').value = state.from ? isoLocal(state.from).slice(0, 16) : '';
  $('#to').value = state.to ? isoLocal(state.to).slice(0, 16) : '';
  $('#min-mag').value = state.minMag ?? '';
  $('#max-mag').value = state.maxMag ?? '';
  $('#min-depth').value = state.minDepth ?? '';
  $('#max-depth').value = state.maxDepth ?? '';
  $('#region-name').textContent = regions.find((r) => r.id === state.region)?.name ?? '';
}

function filtersChanged() {
  state.brush = null;
  syncControls();
  writeUrl();
  loadQuakes();
}

function bindControls() {
  // Svæði þysjar aðeins kortið; gögnin eru fyrir allt landið og þarf ekki að sækja aftur
  $('#region').onchange = (e) => {
    state.region = e.target.value;
    syncControls();
    writeUrl();
    fitRegion();
    if (heat.map) fitRegion(heat.map);
    if (state.view === 'heat') loadHeatYears().then(renderHeatSummary).catch((err) => setStatus(`Villa: ${err.message}`, 'bad'));
    else if (state.view !== 'map') renderArea(); // kortið kallar sjálft á renderArea þegar það stöðvast
  };
  $('#events').onchange = (e) => {
    if (e.target.value) applyEvent(e.target.value);
    else {
      state.event = null;
      syncControls();
      writeUrl();
      render();
    }
  };
  $('#presets').onclick = (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    state.preset = b.dataset.preset;
    if (state.preset === 'custom' && !state.from) {
      const [a, z] = [Date.now() - 7 * 24 * HOUR, Date.now()];
      state.from = a;
      state.to = z;
    }
    filtersChanged();
  };
  const dateInput = (key) => (e) => {
    const v = e.target.value ? parseLocal(e.target.value) : null;
    state[key] = Number.isFinite(v) ? v : null;
    limitCustomSpan(key === 'from' ? 'to' : 'from');
    filtersChanged();
  };
  $('#from').onchange = dateInput('from');
  $('#to').onchange = dateInput('to');
  const numInput = (key) => (e) => {
    const v = e.target.value;
    state[key] = v === '' || !Number.isFinite(+v) ? null : +v;
    filtersChanged();
  };
  $('#min-mag').onchange = numInput('minMag');
  $('#max-mag').onchange = numInput('maxMag');
  $('#min-depth').onchange = numInput('minDepth');
  $('#max-depth').onchange = numInput('maxDepth');

  $('.tabs').onclick = (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  };
  $('#brush-clear').onclick = clearBrush;
  bindPlayback();
  bindHeatControls();
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.aftershocks-link');
    if (!a) return;
    e.preventDefault();
    if (quakeLayer._pinned) openAftershocks(quakeLayer._pinned);
  });
  $('#aftershocks-close').onclick = closeAftershocks;
  $('#auto').onchange = () => {
    if ($('#auto').checked) tick();
    else checkStatus();
  };
  document.addEventListener('visibilitychange', () => !document.hidden && tick());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    render();
    if (heat.map) {
      heat.layer.setData(heat.cells, state.heatMetric);
      renderHeatYears();
    }
  });
}

async function init() {
  readUrl();
  initMap();
  const data = await (await fetch('/api/regions')).json();
  regions = data.regions;
  places = data.places;
  events = (data.events ?? []).map((e) => ({ ...e, startMs: Date.parse(e.start), endMs: e.end ? Date.parse(e.end) : Date.parse(e.start) }));
  defaultRegion = data.defaultRegion;
  if (!regions.some((r) => r.id === state.region)) state.region = defaultRegion;
  $('#region').innerHTML = regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  renderEventOptions();
  syncControls();
  bindControls();
  fitRegion();
  setView(state.view);
  quakeLayer.setMode(state.layer);
  loadOutline();
  await loadQuakes();
  setInterval(tick, STATUS_EVERY);
}

init();
