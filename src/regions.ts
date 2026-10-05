export type Region = {
  id: string;
  name: string;
  lat: [number, number];
  lon: [number, number];
};

// Svæðin eru grófir rammar, breyttu að vild. Öll gögn eru geymd, svæði eru bara sía.
export const DEFAULT_REGION = 'island';

export const REGIONS: Region[] = [
  // Enginn rammi svo skjálftar á hryggjum utan við land skili sér líka
  { id: 'island', name: 'Allt landið', lat: [-90, 90], lon: [-180, 180] },
  { id: 'reykjanes', name: 'Reykjanesskagi', lat: [63.5, 64.5], lon: [-23.5, -21.0] },
  { id: 'hengill', name: 'Hengill', lat: [63.95, 64.2], lon: [-21.6, -21.0] },
  { id: 'katla', name: 'Mýrdalsjökull', lat: [63.45, 63.8], lon: [-19.6, -18.7] },
  { id: 'eyjafjoll', name: 'Eyjafjallajökull', lat: [63.5, 63.75], lon: [-19.95, -19.2] },
  { id: 'hekla', name: 'Hekla', lat: [63.85, 64.1], lon: [-20.0, -19.4] },
  { id: 'vatnajokull', name: 'Vatnajökull', lat: [63.95, 64.85], lon: [-18.2, -15.6] },
  { id: 'bardarbunga', name: 'Bárðarbunga og Holuhraun', lat: [64.5, 65.05], lon: [-17.9, -16.3] },
  { id: 'askja', name: 'Askja og Herðubreið', lat: [64.85, 65.35], lon: [-17.2, -16.0] },
  { id: 'nordurland', name: 'Tjörnesbrotabeltið', lat: [65.8, 66.8], lon: [-19.6, -16.4] },
];

// Örnefni fyrir 3D sýn (kortið sýnir örnefni sjálft)
export const PLACES: { name: string; lat: number; lon: number }[] = [
  { name: 'Grindavík', lat: 63.845, lon: -22.432 },
  { name: 'Þorbjörn', lat: 63.866, lon: -22.437 },
  { name: 'Bláa Lónið', lat: 63.879, lon: -22.447 },
  { name: 'Vogar', lat: 63.981, lon: -22.381 },
  { name: 'Fagradalsfjall', lat: 63.89, lon: -22.269 },
  { name: 'KEF', lat: 63.997, lon: -22.626 },
  { name: 'Kleifarvatn', lat: 63.925, lon: -21.979 },
  { name: 'Reykjanestá', lat: 63.8, lon: -22.701 },
  { name: 'Búrfell', lat: 64.032, lon: -21.831 },
  { name: 'Hveragerði', lat: 64.0, lon: -21.19 },
  { name: 'Katla', lat: 63.63, lon: -19.05 },
  { name: 'Eyjafjallajökull', lat: 63.63, lon: -19.62 },
  { name: 'Fimmvörðuháls', lat: 63.64, lon: -19.44 },
  { name: 'Hekla', lat: 63.98, lon: -19.7 },
  { name: 'Holuhraun', lat: 64.87, lon: -16.83 },
  { name: 'Bárðarbunga', lat: 64.64, lon: -17.53 },
  { name: 'Grímsvötn', lat: 64.42, lon: -17.33 },
  { name: 'Askja', lat: 65.05, lon: -16.75 },
  { name: 'Herðubreið', lat: 65.18, lon: -16.35 },
  { name: 'Húsavík', lat: 66.04, lon: -17.34 },
  { name: 'Grímsey', lat: 66.54, lon: -18.0 },
];
