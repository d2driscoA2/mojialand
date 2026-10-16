// Builds the admin Analytics maps outside the US (Admin 1, #62):
//   site/admin/namap.json   North America: US states, Canadian provinces and
//                           territories and Mexican states on one 975 x 610 map.
//   site/admin/nacities/<CA-ON>.json  City positions in one province or state
//                           of Canada or Mexico, read when the map zooms in.
//   site/admin/world.json   Countries on one 975 x 500 world map.
//   site/admin/regions.json Region names by code ("AU-NSW": "New South Wales"),
//                           read when a country is opened in the world view.
// Sources: Natural Earth (public domain) admin-1 provinces and states,
// world-atlas (ISC, Natural Earth) countries, us-atlas (ISC) states, GeoNames
// (CC BY 4.0) city points via all-the-cities, i18n-iso-countries (MIT) names.
// Run from a scratch folder (never inside the repo):
//   mkdir -p /tmp/geo && cd /tmp/geo && npm init -y
//   npm i d3-geo@3.1.1 topojson-client@3.1.0 topojson-server@3.0.1 topojson-simplify@3.0.3 us-atlas@3.0.1 world-atlas@2.0.2 i18n-iso-countries@7.14.0 all-the-cities@3.1.0
//   curl -L -o admin1.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
//   node <repo>/scripts/build-geo.mjs <repo> admin1.geojson
import fs from 'fs';
import nodePath from 'path';
import { createRequire } from 'module';

const REPO = process.argv[2] || '.';
const ADMIN1 = process.argv[3] || 'admin1.geojson';
const require2 = createRequire(nodePath.join(process.cwd(), 'x.js'));
const { feature } = require2('topojson-client');
const { topology } = require2('topojson-server');
const { presimplify, simplify, quantile } = require2('topojson-simplify');
const d3 = await import(require2.resolve('d3-geo'));
const countries = require2('i18n-iso-countries');
countries.registerLocale(require2('i18n-iso-countries/langs/en.json'));
const r1 = (s) => s.replace(/(\d+\.\d)\d+/g, '$1');
const rnd = (v) => Math.round(v * 10) / 10;
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const write = (rel, obj) => {
  const f = nodePath.join(REPO, rel);
  fs.writeFileSync(f, JSON.stringify(obj));
  return (fs.statSync(f).size / 1024).toFixed(0) + ' KB';
};

// ---------- names
// Mexico City: Natural Earth keeps the old code DIF; the network sends CMX.
const NAME_FIX = { 'MX-DIF': ['MX-CMX', 'Ciudad de México'], 'MX-MEX': ['MX-MEX', 'Estado de México'] };
const admin1 = JSON.parse(fs.readFileSync(ADMIN1, 'utf8'));
const regionNames = {};
for (const f of admin1.features) {
  const p = f.properties;
  let code = String(p.iso_3166_2 || '');
  if (!/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code)) continue;
  let name = p.name || p.name_en || '';
  if (NAME_FIX[code]) [code, name] = NAME_FIX[code];
  if (name) regionNames[code] = name;
}

// Region codes the network sends that Natural Earth splits into smaller parts
Object.assign(regionNames, { 'GB-ENG': 'England', 'GB-SCT': 'Scotland', 'GB-WLS': 'Wales', 'GB-NIR': 'Northern Ireland' });

// ---------- North America
const US_AB = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY' };
const usTopo = JSON.parse(fs.readFileSync(require2.resolve('us-atlas/states-10m.json')));
const usFeats = feature(usTopo, usTopo.objects.states).features
  .filter((f) => US_AB[f.properties.name])
  .map((f) => ({ type: 'Feature', properties: { id: 'US-' + US_AB[f.properties.name], co: 'US', n: f.properties.name }, geometry: f.geometry }));
const naFeats = admin1.features
  .filter((f) => (f.properties.iso_a2 === 'CA' || f.properties.iso_a2 === 'MX') && /^[A-Z]{2}-[A-Z]{2,3}$/.test(f.properties.iso_3166_2 || ''))
  .map((f) => {
    let id = f.properties.iso_3166_2;
    if (NAME_FIX[id]) id = NAME_FIX[id][0];
    return { type: 'Feature', properties: { id, co: f.properties.iso_a2, n: regionNames[id] || f.properties.name }, geometry: f.geometry };
  });
// simplify the detailed outlines (Alaska and the Arctic islands are huge)
const topo = presimplify(topology({ na: { type: 'FeatureCollection', features: [...usFeats, ...naFeats] } }, 1e5));
const all = feature(simplify(topo, quantile(topo, 0.05)), topo.objects.na).features;
const W = 975, H = 610;
const naProj = d3.geoConicEqualArea().parallels([20, 60]).rotate([100, 0]).fitExtent([[8, 8], [W - 8, H - 8]], { type: 'FeatureCollection', features: all.filter((f) => f.properties.id !== 'US-HI') });
const naPath = d3.geoPath(naProj);
const nudge = { 'US-MI': [8, 12], 'US-FL': [6, 4], 'CA-NU': [0, 40], 'CA-NT': [-6, 20], 'CA-NL': [10, 14], 'US-AK': [10, 12] };
const regions = all.map((f) => {
  const c = naPath.centroid(f);
  const n = nudge[f.properties.id] || [0, 0];
  const b = naPath.bounds(f);
  return { id: f.properties.id, co: f.properties.co, n: f.properties.n, d: r1(naPath(f) || ''), c: [Math.round(c[0] + n[0]), Math.round(c[1] + n[1])], b: b.flat().map(rnd) };
}).filter((r) => r.d);
// Canadian and Mexican city points: the province or state that holds each one
const naOrig = admin1.features.filter((f) => f.properties.iso_a2 === 'CA' || f.properties.iso_a2 === 'MX');
// names the network uses that GeoNames spells another way
const ALIAS = { 'CA|Québec': ['Quebec City'], 'MX|Mexico City': ['Ciudad de México', 'Ciudad de Mexico', 'CDMX'] };
const cities = {};
const pop = {};
let placed = 0, missed = 0;
for (const x of require2('all-the-cities')) {
  if (x.country !== 'CA' && x.country !== 'MX') continue;
  const ll = x.loc.coordinates;
  // a city on a river or coast can sit just outside the outline: take the nearest province
  const mine = naOrig.filter((f) => f.properties.iso_a2 === x.country);
  let hit = mine.find((f) => d3.geoContains(f, ll));
  for (const r of [0.03, 0.06, 0.12]) {
    if (hit) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { hit = mine.find((f) => d3.geoContains(f, [ll[0] + dx * r, ll[1] + dy * r])); if (hit) break; }
  }
  if (!hit) { missed++; hit = mine.reduce((a, f) => (d3.geoDistance(ll, d3.geoCentroid(f)) < d3.geoDistance(ll, d3.geoCentroid(a)) ? f : a)); }
  let rid = hit.properties.iso_3166_2;
  if (NAME_FIX[rid]) rid = NAME_FIX[rid][0];
  const p = naProj(ll);
  if (!p) continue;
  placed++;
  const names = new Set([x.name, strip(x.name), ...(ALIAS[x.country + '|' + x.name] || [])]);
  if (x.altName) for (const a of String(x.altName).split(',')) if (a && /^[\p{L} .'-]+$/u.test(a)) { names.add(a); names.add(strip(a)); }
  for (const nm of names) {
    const k = rid + '|' + nm;
    if (!(k in cities) || x.population > pop[k]) { cities[k] = [rnd(p[0]), rnd(p[1])]; pop[k] = x.population; }
  }
}
const attribution = 'Province and state outlines: Natural Earth (public domain) and US Census Bureau via us-atlas (ISC). Country outlines: Natural Earth (public domain) via world-atlas (ISC). City locations: GeoNames (CC BY 4.0) via all-the-cities.';
const byRegion = {};
for (const [k, p] of Object.entries(cities)) { const [rid, nm] = k.split('|'); (byRegion[rid] = byRegion[rid] || {})[nm] = p; }
fs.rmSync(nodePath.join(REPO, 'site/admin/nacities'), { recursive: true, force: true });
fs.mkdirSync(nodePath.join(REPO, 'site/admin/nacities'), { recursive: true });
let cityBytes = 0;
for (const [rid, list] of Object.entries(byRegion)) { write('site/admin/nacities/' + rid + '.json', { region: rid, cities: list }); cityBytes += fs.statSync(nodePath.join(REPO, 'site/admin/nacities/' + rid + '.json')).size; }
console.log('namap', regions.length, 'regions,', write('site/admin/namap.json', { vb: [0, 0, W, H], attribution, regions }) + ';', placed, 'cities,', missed, 'by nearest province,', Object.keys(byRegion).length, 'city files', (cityBytes / 1024).toFixed(0) + ' KB');

// ---------- world
const WW = 975, WH = 500;
const wTopo = JSON.parse(fs.readFileSync(require2.resolve('world-atlas/countries-110m.json')));
const wTopo50 = JSON.parse(fs.readFileSync(require2.resolve('world-atlas/countries-50m.json')));
const a2 = (f) => {
  const id = String(f.id || '');
  if (/^\d+$/.test(id)) return countries.numericToAlpha2(id.padStart(3, '0')) || '';
  if (f.properties.name === 'Kosovo') return 'XK';
  if (f.properties.name === 'N. Cyprus') return '';
  return '';
};
const wFeats = feature(wTopo, wTopo.objects.countries).features.filter((f) => f.id !== '010');
const wProj = d3.geoEqualEarth().fitExtent([[8, 8], [WW - 8, WH - 8]], { type: 'FeatureCollection', features: wFeats });
const wPath = d3.geoPath(wProj);
// Short everyday country names where the standard name is long
const SHORT = { US: 'United States', RU: 'Russia', IR: 'Iran', CZ: 'Czechia', TW: 'Taiwan', TZ: 'Tanzania', MD: 'Moldova', SY: 'Syria', LA: 'Laos', BN: 'Brunei', FM: 'Micronesia', VA: 'Vatican City', PS: 'Palestine', MK: 'North Macedonia', KR: 'South Korea', KP: 'North Korea', CD: 'DR Congo', CG: 'Republic of the Congo', VE: 'Venezuela', BO: 'Bolivia', VN: 'Vietnam', XK: 'Kosovo' };
const cname = (co, fallback) => SHORT[co] || String(countries.getName(co, 'en') || fallback || co).split(',')[0];
const seen = new Set();
const wList = [];
for (const f of wFeats) {
  const co = a2(f);
  if (!co || seen.has(co)) continue;
  seen.add(co);
  const c = wPath.centroid(f);
  wList.push({ co, n: cname(co, f.properties.name), d: r1(wPath(f) || ''), c: [Math.round(c[0]), Math.round(c[1])], b: wPath.bounds(f).flat().map(rnd) });
}
// small countries missing from the 110m map still get a dot position
for (const f of feature(wTopo50, wTopo50.objects.countries).features) {
  const co = a2(f);
  if (!co || seen.has(co)) continue;
  seen.add(co);
  const c = wPath.centroid(f);
  if (!isFinite(c[0])) continue;
  wList.push({ co, n: cname(co, f.properties.name), d: '', c: [Math.round(c[0]), Math.round(c[1])], b: [c[0] - 4, c[1] - 4, c[0] + 4, c[1] + 4].map(rnd) });
}
// Fix the US, Canada and Mexico label points onto their main land
const wNudge = { US: [10, 8], CA: [0, 18], FR: [12, -10], NO: [-8, 10] };
for (const w of wList) { const n = wNudge[w.co]; if (n) w.c = [w.c[0] + n[0], w.c[1] + n[1]]; }
console.log('world', wList.length, 'countries,', write('site/admin/world.json', { vb: [0, 0, WW, WH], attribution, countries: wList }));
console.log('regions', Object.keys(regionNames).length, 'names,', write('site/admin/regions.json', regionNames));
console.log('checks:', cities['CA-ON|Toronto'], cities['CA-QC|Quebec City'], cities['CA-QC|Québec'], cities['MX-CMX|Mexico City'], cities['MX-NLE|Monterrey'], regionNames['MX-CMX'], regionNames['CA-QC'], regionNames['GB-ENG']);
