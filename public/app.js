'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TZ = 'Atlantic/Reykjavik';
const HOUR = 3600e3;
const PRESETS = { '24h': 24, '48h': 48, '7d': 168, '30d': 720, '1y': 8760, all: null };
const STATUS_EVERY = 60e3;

// Litur eftir aldri: nýtt = sterkt og heitt, gamalt = dauft. Sér skali fyrir dökkt þema.
const RAMPS = {
  light: ['#7f1d1d', '#c2410c', '#f59e0b', '#fcd9a0'],
  dark: ['#fff4c2', '#fbbf24', '#f97316', '#8a3a12'],
};

const state = {
  region: null, // sjálfgefið svæði kemur frá þjóni
  preset: '48h',
  from: null, // ms, aðeins fyrir 'custom'
  to: null,
  minMag: null,
  maxMag: null,
  view: 'map',
  brush: null, // [ms, ms] valið á tímalínu
};

let regions = [];
let defaultRegion = 'island';
let places = [];
let quakes = [];
let markers = [];
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

const place = (q) => (q.ref ? `${q.dist != null ? fmt1(q.dist) + ' km ' : ''}${q.dir ?? ''} af ${q.ref.replaceAll('_', ' ')}` : '');

// Íslenskur tími = UTC, svo ISO án tímabeltis er réttur tími fyrir Plotly og datetime-local
const isoLocal = (ms) => new Date(ms).toISOString().slice(0, 19);
const parseLocal = (s) => Date.parse(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rampColor(t) {
  const stops = RAMPS[dark() ? 'dark' : 'light'].map(hexToRgb);
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
}

// Tímagluggi sem litaskalinn spannar
function timeWindow() {
  const now = Date.now();
  if (state.preset === 'custom') return [state.from ?? now - 48 * HOUR, state.to ?? now];
  const h = PRESETS[state.preset];
  if (h == null) return [quakes.length ? quakes[0].t : now - 48 * HOUR, now];
  return [now - h * HOUR, now];
}

function style(q, win) {
  const t = (win[1] - q.t) / Math.max(win[1] - win[0], 1);
  const [r, g, b] = rampColor(t);
  return {
    fill: `rgb(${r},${g},${b})`,
    opacity: 0.92 - 0.45 * clamp(t, 0, 1),
    // Stærð eftir orku: þvermál tvöfaldast fyrir hverja stærðareiningu. Rétt orkukvörðun
    // (×32 á einingu) myndi láta M4 gleypa kortið, svo þetta er málamiðlun.
    radius: clamp(2.5 * 2 ** q.mag, 2.5, 48),
    recent: Date.now() - q.t < HOUR,
  };
}

// ---------- Slóð (URL) geymir síur svo hægt sé að deila ----------

function readUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('region')) state.region = p.get('region');
  if (p.has('range')) state.preset = p.get('range');
  if (!(state.preset in PRESETS) && state.preset !== 'custom') state.preset = '48h';
  if (p.has('from')) state.from = parseLocal(p.get('from'));
  if (p.has('to')) state.to = parseLocal(p.get('to'));
  const num = (k) => (p.has(k) && p.get(k) !== '' && Number.isFinite(+p.get(k)) ? +p.get(k) : null);
  state.minMag = num('min');
  state.maxMag = num('max');
  if (['map', '3d', 'table'].includes(p.get('view'))) state.view = p.get('view');
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
  if (state.view !== 'map') p.set('view', state.view);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ---------- Gögn ----------

async function loadQuakes({ quiet = false } = {}) {
  const seq = ++fetchSeq;
  const now = Date.now();
  let from, to;
  if (state.preset === 'custom') {
    from = state.from ?? now - 48 * HOUR;
    to = state.to ?? now;
  } else {
    const h = PRESETS[state.preset];
    from = h == null ? 0 : now - h * HOUR;
    to = now + 60e3;
  }
  const p = new URLSearchParams({ region: state.region, from, to });
  if (state.minMag != null) p.set('minMag', state.minMag);
  if (state.maxMag != null) p.set('maxMag', state.maxMag);

  if (!quiet) setStatus('Sæki…');
  try {
    const res = await fetch(`/api/quakes?${p}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    const data = await res.json();
    if (seq !== fetchSeq) return; // nýrri beiðni komin af stað
    quakes = data.quakes;
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
    if (s.lastError) {
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
  if (document.hidden || !$('#auto').checked) return;
  const s = await checkStatus();
  if (!s) return;
  // Sækja aftur ef ný gögn eru komin eða ef glugginn hreyfist (t.d. "síðustu 48 klst")
  const sliding = state.preset !== 'custom' && Date.now() - lastFetch > 5 * 60e3;
  if (s.version !== dataVersion || sliding) loadQuakes({ quiet: true });
}

function setStatus(text, kind = '') {
  $('#status-text').textContent = text;
  $('#status-dot').className = `dot ${kind}`;
}

// ---------- Teikning ----------

function visibleQuakes() {
  if (!state.brush) return quakes;
  const [a, b] = state.brush;
  return quakes.filter((q) => q.t >= a && q.t <= b);
}

function render() {
  const list = visibleQuakes();
  const win = timeWindow();
  renderStats(list);
  renderMap(list, win);
  renderLegend(win);
  if (state.view === '3d') render3d(list, win);
  if (state.view === 'table') renderTable(list, win);
  renderTimeline(win);
  renderBrushChip();
}

function renderStats(list) {
  const biggest = list.reduce((m, q) => (!m || q.mag > m.mag ? q : m), null);
  const latest = list[list.length - 1];
  const strong = list.filter((q) => q.mag >= 3).length;
  const tile = (k, v, d = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('#stats').innerHTML = [
    tile('Fjöldi skjálfta', list.length.toLocaleString('is-IS'), strong ? `${strong} af stærð 3 eða meira` : 'enginn af stærð 3 eða meira'),
    biggest ? tile('Stærsti', `M ${fmt1(biggest.mag)}`, `${esc(place(biggest))} · ${ago(biggest.t)}`) : tile('Stærsti', '–'),
    latest ? tile('Nýjasti', ago(latest.t), `M ${fmt1(latest.mag)} · ${esc(place(latest))}`) : tile('Nýjasti', '–'),
  ].join('');
}

function tooltipHtml(q) {
  return `<b>M ${fmt1(q.mag)}</b> <span class="muted">· dýpt ${fmt1(q.depth)} km</span><br>
    ${fmtDateTime.format(q.t)} <span class="muted">(${ago(q.t)})</span><br>
    ${esc(place(q))}${q.q != null ? `<br><span class="muted">Gæði ${fmt1(q.q)}</span>` : ''}`;
}

// --- Kort ---

let map, quakeLayer, baseLayers, legendControl;

function initMap() {
  map = L.map('map', { preferCanvas: true, zoomSnap: 0.25, scrollWheelZoom: false });
  // Skrunhjól þysjar aðeins eftir að smellt er á kortið, annars skrunar síðan
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout blur', () => map.scrollWheelZoom.disable());
  baseLayers = {
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
  baseLayers.Kort.addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  quakeLayer = L.layerGroup().addTo(map);

  legendControl = L.control({ position: 'bottomright' });
  legendControl.onAdd = () => L.DomUtil.create('div', 'legend');
  legendControl.addTo(map);
}

const ICELAND = { lat: [63.2, 66.6], lon: [-24.6, -13.4] };

// Svæði án ramma (allt landið) eru sýnd sem Ísland á kortinu
const bounds = (r) => (r.lat[1] - r.lat[0] > 30 ? ICELAND : r);

function fitRegion() {
  const r = regions.find((r) => r.id === state.region);
  if (!r) return;
  const b = bounds(r);
  map.fitBounds([[b.lat[0], b.lon[0]], [b.lat[1], b.lon[1]]]);
}

function renderMap(list, win) {
  quakeLayer.clearLayers();
  markers = new Map();
  // Stórir fyrst svo litlir skjálftar teiknist ofan á og hverfi ekki
  const sorted = [...list].sort((a, b) => b.mag - a.mag);
  const ring = css('--ink');
  for (const q of sorted) {
    const s = style(q, win);
    const m = L.circleMarker([q.lat, q.lon], {
      radius: s.radius,
      fillColor: s.fill,
      fillOpacity: s.opacity,
      color: s.recent ? ring : s.fill,
      weight: s.recent ? 2 : 1,
      opacity: s.recent ? 0.9 : Math.min(1, s.opacity + 0.1),
    }).bindTooltip(tooltipHtml(q), { className: 'quake-tip', direction: 'top', offset: [0, -s.radius] });
    m.addTo(quakeLayer);
    markers.set(q, m);
  }
}

function renderLegend(win) {
  const stops = RAMPS[dark() ? 'dark' : 'light'];
  const sizes = [1, 2, 3, 4].map((m) => {
    const d = 2 * clamp(2.5 * 2 ** m, 2.5, 48);
    return `<div><i style="width:${d}px;height:${d}px"></i>M${m}</div>`;
  });
  legendControl.getContainer().innerHTML = `
    <div>Aldur skjálfta</div>
    <div class="ramp" style="background:linear-gradient(to right, ${stops.join(',')})"></div>
    <div class="ends"><span>nýr</span><span>${spanLabel(win[1] - win[0])}</span></div>
    <div class="sizes">${sizes.join('')}</div>
    <div class="ends" style="margin-top:4px"><span>Útlína: síðasta klukkustund</span></div>`;
}

function focusQuake(q) {
  setView('map');
  const m = markers.get(q);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 11));
  m.openTooltip();
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
  const x = quakes.map((q) => isoLocal(q.t));
  const styles = quakes.map((q) => style(q, win));
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
    y: quakes.map((q) => q.mag),
    customdata: quakes.map((q) => [fmtDateTime.format(q.t), q.depth, place(q)]),
    hovertemplate: '<b>M %{y:.1f}</b> · dýpt %{customdata[1]:.1f} km<br>%{customdata[0]}<br>%{customdata[2]}<extra></extra>',
    marker: {
      size: styles.map((s) => clamp(s.radius * 1.1, 4, 30)),
      color: styles.map((s) => s.fill),
      opacity: 0.8,
      line: { width: 0 },
    },
  };

  const axis = { gridcolor: grid, zerolinecolor: grid, linecolor: grid };
  const layout = {
    margin: { l: 44, r: 12, t: 8, b: 32 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: plotFont(),
    showlegend: false,
    dragmode: 'zoom',
    bargap: 0.08,
    hovermode: 'closest',
    hoverlabel: { bgcolor: css('--surface'), bordercolor: grid, font: { color: css('--ink') } },
    // Halda vali á tímabili þegar gögn uppfærast sjálfkrafa
    uirevision: `${state.region}|${state.preset}|${state.from}|${state.to}|${state.minMag}|${state.maxMag}`,
    xaxis: { ...axis, type: 'date', range: state.brush ? undefined : [isoLocal(win[0]), isoLocal(win[1])] },
    yaxis: { ...axis, domain: [0, 0.68], title: { text: 'Stærð' }, fixedrange: true, rangemode: 'tozero' },
    yaxis2: { ...axis, domain: [0.76, 1], title: { text: 'Fjöldi' }, fixedrange: true, rangemode: 'tozero', tickformat: 'd', nticks: 3 },
  };
  Plotly.react('timeline', [counts, points], layout, { displaylogo: false, responsive: true, modeBarButtons: [['toImage']] });
  // Plotly bætir .on() við elementið við fyrstu teikningu
  if (!timelineBound) bindTimeline();
}

let timelineBound = false;

function bindTimeline() {
  timelineBound = true;
  const el = $('#timeline');
  el.on('plotly_relayout', (ev) => {
    if (ev['xaxis.range[0]'] != null) {
      state.brush = [parseLocal(ev['xaxis.range[0]']), parseLocal(ev['xaxis.range[1]'])];
    } else if (ev['xaxis.autorange']) {
      state.brush = null;
    } else return;
    const list = visibleQuakes();
    const win = timeWindow();
    renderStats(list);
    renderMap(list, win);
    if (state.view === '3d') render3d(list, win);
    if (state.view === 'table') renderTable(list, win);
    renderBrushChip();
  });
  el.on('plotly_click', (ev) => {
    const pt = ev.points.find((p) => p.data.type === 'scattergl');
    if (pt) focusQuake(quakes[pt.pointIndex]);
  });
}

function renderBrushChip() {
  $('#brush-chip').hidden = !state.brush;
  if (state.brush) {
    $('#brush-text').textContent = `Tímabil: ${fmtDateTime.format(state.brush[0])} – ${fmtDateTime.format(state.brush[1])}`;
  }
}

function clearBrush() {
  state.brush = null;
  Plotly.relayout('timeline', { 'xaxis.autorange': true });
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

function render3d(list, win) {
  const region = regions.find((r) => r.id === state.region);
  let r = bounds(region);
  if (r === ICELAND && list.length) {
    // Allt landið ásamt skjálftum utan við strönd
    const pad = (a, [lo, hi]) => [Math.min(lo, ...a.map((v) => v - 0.1)), Math.max(hi, ...a.map((v) => v + 0.1))];
    r = { lat: pad(list.map((q) => q.lat), ICELAND.lat), lon: pad(list.map((q) => q.lon), ICELAND.lon) };
  }
  const latMid = (r.lat[0] + r.lat[1]) / 2;
  const kmX = (r.lon[1] - r.lon[0]) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  const kmY = (r.lat[1] - r.lat[0]) * 111.32;
  const maxDepth = Math.max(10, ...list.map((q) => q.depth));
  const styles = list.map((q) => style(q, win));
  const grid = css('--line');
  const axis = { gridcolor: grid, zerolinecolor: grid, backgroundcolor: 'transparent', color: css('--ink-2') };

  const trace = {
    type: 'scatter3d',
    mode: 'markers',
    x: list.map((q) => q.lon),
    y: list.map((q) => q.lat),
    z: list.map((q) => q.depth),
    customdata: list.map((q) => [q.mag, fmtDateTime.format(q.t), place(q)]),
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
  Plotly.react('plot3d', [...mapLines, trace], {
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

function renderTable(list, win) {
  const rows = [...list].reverse().slice(0, TABLE_LIMIT);
  const body = rows.map((q, i) => `<tr data-i="${i}">
      <td>${fmtDateTime.format(q.t)}</td>
      <td class="num"><span class="swatch" style="background:${style(q, win).fill}"></span>${fmt1(q.mag)}</td>
      <td class="num">${fmt1(q.depth)} km</td>
      <td>${esc(place(q))}</td>
      <td class="num">${q.q != null ? fmt1(q.q) : ''}</td>
    </tr>`).join('');
  const more = list.length > TABLE_LIMIT ? `<caption>Sýni ${TABLE_LIMIT} nýjustu af ${list.length.toLocaleString('is-IS')}</caption>` : '';
  $('#table').innerHTML = `${more}<thead><tr><th>Tími</th><th class="num">Stærð</th><th class="num">Dýpt</th><th>Staðsetning</th><th class="num">Gæði</th></tr></thead><tbody>${body}</tbody>`;
  $('#table').onclick = (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) focusQuake(rows[+tr.dataset.i]);
  };
}

// ---------- Viðmót ----------

function setView(view) {
  state.view = view;
  for (const b of $$('.tabs [data-view]')) b.setAttribute('aria-selected', b.dataset.view === view);
  for (const id of ['map', '3d', 'table']) $(`#view-${id}`).hidden = id !== view;
  const list = visibleQuakes();
  const win = timeWindow();
  if (view === 'map') map.invalidateSize();
  if (view === '3d') render3d(list, win);
  if (view === 'table') renderTable(list, win);
  writeUrl();
}

function syncControls() {
  $('#region').value = state.region;
  for (const b of $$('#presets button')) b.setAttribute('aria-pressed', b.dataset.preset === state.preset);
  $('#custom-range').hidden = state.preset !== 'custom';
  $('#from').value = state.from ? isoLocal(state.from).slice(0, 16) : '';
  $('#to').value = state.to ? isoLocal(state.to).slice(0, 16) : '';
  $('#min-mag').value = state.minMag ?? '';
  $('#max-mag').value = state.maxMag ?? '';
  $('#region-name').textContent = regions.find((r) => r.id === state.region)?.name ?? '';
}

function filtersChanged() {
  state.brush = null;
  syncControls();
  writeUrl();
  loadQuakes();
}

function bindControls() {
  $('#region').onchange = (e) => {
    state.region = e.target.value;
    fitRegion();
    filtersChanged();
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
    state[key] = e.target.value ? parseLocal(e.target.value) : null;
    filtersChanged();
  };
  $('#from').onchange = dateInput('from');
  $('#to').onchange = dateInput('to');
  const magInput = (key) => (e) => {
    const v = e.target.value;
    state[key] = v === '' || !Number.isFinite(+v) ? null : +v;
    filtersChanged();
  };
  $('#min-mag').onchange = magInput('minMag');
  $('#max-mag').onchange = magInput('maxMag');

  $('.tabs').onclick = (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  };
  $('#brush-clear').onclick = clearBrush;
  $('#auto').onchange = () => {
    if ($('#auto').checked) tick();
    else checkStatus();
  };
  document.addEventListener('visibilitychange', () => !document.hidden && tick());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    render();
  });
}

async function init() {
  readUrl();
  initMap();
  const data = await (await fetch('/api/regions')).json();
  regions = data.regions;
  places = data.places;
  defaultRegion = data.defaultRegion;
  if (!regions.some((r) => r.id === state.region)) state.region = defaultRegion;
  $('#region').innerHTML = regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  syncControls();
  bindControls();
  fitRegion();
  setView(state.view);
  loadOutline();
  await loadQuakes();
  setInterval(tick, STATUS_EVERY);
}

init();
