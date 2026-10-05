import { REGIONS } from './regions';

// Eldgos og stórir atburðir frá 1991 (upphaf skjálftaskrárinnar), handskráð. Tímar UTC; þar sem
// klukkan er ekki þekkt er miðað við miðnætti. Lagaðu og bættu við að vild: viðmótið sýnir þetta
// sem merki á tímalínu og korti og sem bókamerki sem stilla svæði og tímabil á aðdragandann.
export type QuakeEvent = {
  id: string;
  name: string;
  kind: 'eruption' | 'earthquake' | 'intrusion';
  start: string; // ISO, UTC
  end?: string; // ISO, UTC; eldgos: goslok
  lat: number;
  lon: number;
  region: string; // svæði fyrir bókamerki, sjá regions.ts
  view?: [number, number]; // dagar fyrir og eftir upphaf sem bókamerkið sýnir, sjálfgefið 30 og 7
  note?: string;
};

export const EVENTS: QuakeEvent[] = [
  { id: 'hekla-1991', name: 'Hekla 1991', kind: 'eruption', start: '1991-01-17T17:00:00Z', end: '1991-03-11', lat: 63.98, lon: -19.70, region: 'hekla', view: [10, 7] },
  { id: 'gjalp-1996', name: 'Gjálp 1996', kind: 'eruption', start: '1996-09-30T22:00:00Z', end: '1996-10-13', lat: 64.52, lon: -17.38, region: 'vatnajokull', note: 'Undir Vatnajökli, hlaup á Skeiðarársandi 5. nóv' },
  { id: 'grimsvotn-1998', name: 'Grímsvötn 1998', kind: 'eruption', start: '1998-12-18T09:20:00Z', end: '1998-12-28', lat: 64.42, lon: -17.33, region: 'vatnajokull' },
  { id: 'hekla-2000', name: 'Hekla 2000', kind: 'eruption', start: '2000-02-26T18:19:00Z', end: '2000-03-08', lat: 63.98, lon: -19.70, region: 'hekla', view: [10, 7] },
  { id: 'sudurland-2000', name: 'Suðurlandsskjálftar 2000', kind: 'earthquake', start: '2000-06-17T15:40:41Z', end: '2000-06-21T00:51:47Z', lat: 63.97, lon: -20.37, region: 'island', view: [7, 14], note: 'M6,5 17. júní og M6,4 21. júní' },
  { id: 'grimsvotn-2004', name: 'Grímsvötn 2004', kind: 'eruption', start: '2004-11-01T22:00:00Z', end: '2004-11-06', lat: 64.42, lon: -17.33, region: 'vatnajokull' },
  { id: 'olfus-2008', name: 'Ölfusskjálfti 2008', kind: 'earthquake', start: '2008-05-29T15:45:58Z', lat: 63.97, lon: -21.07, region: 'hengill', view: [7, 14], note: 'M6,3' },
  { id: 'fimmvorduhals-2010', name: 'Fimmvörðuháls 2010', kind: 'eruption', start: '2010-03-20T23:30:00Z', end: '2010-04-12', lat: 63.64, lon: -19.44, region: 'eyjafjoll', view: [60, 7] },
  { id: 'eyjafjallajokull-2010', name: 'Eyjafjallajökull 2010', kind: 'eruption', start: '2010-04-14T01:00:00Z', end: '2010-05-22', lat: 63.63, lon: -19.62, region: 'eyjafjoll', view: [14, 14] },
  { id: 'grimsvotn-2011', name: 'Grímsvötn 2011', kind: 'eruption', start: '2011-05-21T19:00:00Z', end: '2011-05-28', lat: 64.42, lon: -17.33, region: 'vatnajokull' },
  { id: 'bardarbunga-2014', name: 'Kvikugangur Bárðarbungu 2014', kind: 'intrusion', start: '2014-08-16T02:00:00Z', end: '2014-08-31', lat: 64.64, lon: -17.53, region: 'bardarbunga', view: [7, 21], note: 'Gangurinn gekk 45 km til norðausturs á tveimur vikum' },
  { id: 'holuhraun-2014', name: 'Holuhraun 2014', kind: 'eruption', start: '2014-08-31T04:15:00Z', end: '2015-02-27', lat: 64.87, lon: -16.83, region: 'bardarbunga', view: [21, 14], note: 'Lítið gos 29. ágúst, aðalgosið hófst 31. ágúst' },
  { id: 'fagradalsfjall-2021', name: 'Fagradalsfjall 2021', kind: 'eruption', start: '2021-03-19T20:45:00Z', end: '2021-09-18', lat: 63.89, lon: -22.27, region: 'reykjanes', view: [30, 7] },
  { id: 'meradalir-2022', name: 'Meradalir 2022', kind: 'eruption', start: '2022-08-03T13:18:00Z', end: '2022-08-21', lat: 63.90, lon: -22.25, region: 'reykjanes', view: [10, 7] },
  { id: 'litli-hrutur-2023', name: 'Litli-Hrútur 2023', kind: 'eruption', start: '2023-07-10T16:40:00Z', end: '2023-08-05', lat: 63.92, lon: -22.22, region: 'reykjanes', view: [10, 7] },
  { id: 'grindavik-2023', name: 'Kvikugangur Grindavík 2023', kind: 'intrusion', start: '2023-11-10T18:00:00Z', end: '2023-11-11', lat: 63.89, lon: -22.40, region: 'reykjanes', view: [14, 7], note: 'Grindavík rýmd, M5,2 kl. 18:46' },
  { id: 'sundhnukur-2023-12', name: 'Sundhnúkur des. 2023', kind: 'eruption', start: '2023-12-18T22:17:00Z', end: '2023-12-21', lat: 63.89, lon: -22.37, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2024-01', name: 'Sundhnúkur jan. 2024', kind: 'eruption', start: '2024-01-14T07:57:00Z', end: '2024-01-16', lat: 63.86, lon: -22.40, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2024-02', name: 'Sundhnúkur feb. 2024', kind: 'eruption', start: '2024-02-08T06:02:00Z', end: '2024-02-09', lat: 63.89, lon: -22.38, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2024-03', name: 'Sundhnúkur mars 2024', kind: 'eruption', start: '2024-03-16T20:23:00Z', end: '2024-05-09', lat: 63.89, lon: -22.37, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2024-05', name: 'Sundhnúkur maí 2024', kind: 'eruption', start: '2024-05-29T12:46:00Z', end: '2024-06-22', lat: 63.89, lon: -22.37, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2024-08', name: 'Sundhnúkur ágúst 2024', kind: 'eruption', start: '2024-08-22T21:26:00Z', end: '2024-09-05', lat: 63.90, lon: -22.35, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2024-11', name: 'Sundhnúkur nóv. 2024', kind: 'eruption', start: '2024-11-20T23:14:00Z', end: '2024-12-08', lat: 63.88, lon: -22.40, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2025-04', name: 'Sundhnúkur apríl 2025', kind: 'eruption', start: '2025-04-01T09:45:00Z', end: '2025-04-02', lat: 63.89, lon: -22.38, region: 'reykjanes', view: [14, 5] },
  { id: 'sundhnukur-2025-07', name: 'Sundhnúkur júlí 2025', kind: 'eruption', start: '2025-07-16T03:56:00Z', end: '2025-08-05', lat: 63.89, lon: -22.36, region: 'reykjanes', view: [14, 5] },
];

export function validateEvents(events = EVENTS, regions = REGIONS) {
  const ids = new Set<string>();
  for (const e of events) {
    if (ids.has(e.id)) throw new Error(`Tvítekið auðkenni: ${e.id}`);
    ids.add(e.id);
    if (!regions.some((r) => r.id === e.region)) throw new Error(`${e.id}: óþekkt svæði ${e.region}`);
    const start = Date.parse(e.start), end = e.end ? Date.parse(e.end) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error(`${e.id}: ógildir tímar`);
  }
  return events;
}
