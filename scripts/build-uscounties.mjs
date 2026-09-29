// Builds the county data for the admin Analytics map and for the server:
//   site/admin/counties/<ST>.json       county outlines, label points, names per state (admin map)
//   netlify/functions/_lib/uscounty.json city to county lookup (server fold)
// Same folder and packages as scripts/build-usmap.mjs. Run from that folder:
//   node <repo>/scripts/build-uscounties.mjs <repo>
// County comes from which county outline holds each city point (us-atlas, same
// 975 x 610 projection as the state map). Netlify reports no county.
import fs from 'fs';
import nodePath from 'path';
import { createRequire } from 'module';

const REPO = process.argv[2] || '.';
const require2 = createRequire(nodePath.join(process.cwd(), 'x.js'));
const { feature } = require2('topojson-client');
const { geoPath, geoAlbersUsa } = await import(require2.resolve('d3-geo'));
const us = JSON.parse(fs.readFileSync(require2.resolve('us-atlas/counties-albers-10m.json')));
const AB = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };
const path = geoPath();
const r1 = (s) => s.replace(/(\d+\.\d)\d+/g, '$1');
const counties = feature(us, us.objects.counties).features
  .filter((f) => AB[String(f.id).slice(0, 2)])
  .map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const b = path.bounds(f);
    const c = path.centroid(f);
    return { id: String(f.id), st: AB[String(f.id).slice(0, 2)], n: f.properties.name, d: r1(path(f)), c: [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10], b: b.flat().map((v) => Math.round(v * 10) / 10), polys };
  });

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function contains(cty, x, y) {
  const [x0, y0, x1, y1] = cty.b;
  if (x < x0 - 0.2 || x > x1 + 0.2 || y < y0 - 0.2 || y > y1 + 0.2) return false;
  let inside = false;
  for (const poly of cty.polys) for (const ring of poly) if (inRing(x, y, ring)) inside = !inside;
  return inside;
}

const byState = {};
for (const c of counties) (byState[c.st] = byState[c.st] || []).push(c);
const proj = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const lookup = {};
let nearest = 0;
for (const x of require2('all-the-cities')) {
  if (x.country !== 'US' || !byState[x.adminCode]) continue;
  const p = proj(x.loc.coordinates);
  if (!p) continue;
  const list = byState[x.adminCode];
  let hit = list.find((c) => contains(c, p[0], p[1]));
  if (!hit) {
    nearest++;
    hit = list.reduce((a, c) => (Math.hypot(c.c[0] - p[0], c.c[1] - p[1]) < Math.hypot(a.c[0] - p[0], a.c[1] - p[1]) ? c : a));
  }
  const keys = [x.adminCode + '|' + x.name];
  if (x.altName) for (const a of String(x.altName).split(',')) if (a && /^[\p{L} .'-]+$/u.test(a)) keys.push(x.adminCode + '|' + a);
  for (const k of keys) if (!(k in lookup) || x.population > lookup[k][1]) lookup[k] = [hit.id, x.population];
}
const cityCounty = Object.fromEntries(Object.entries(lookup).map(([k, v]) => [k, v[0]]));
const names = Object.fromEntries(counties.map((c) => [c.id, c.n]));

const adminDir = nodePath.join(REPO, 'site/admin/counties');
fs.mkdirSync(adminDir, { recursive: true });
const fnOut = nodePath.join(REPO, 'netlify/functions/_lib/uscounty.json');
let adminBytes = 0;
for (const [st, list] of Object.entries(byState)) {
  const f = nodePath.join(adminDir, st + '.json');
  fs.writeFileSync(f, JSON.stringify({ state: st, counties: list.map(({ id, n, d, c, b }) => ({ id, n, d, c, b })) }));
  adminBytes += fs.statSync(f).size;
}
fs.writeFileSync(fnOut, JSON.stringify({ cities: cityCounty, names }));
console.log(counties.length + ' counties, ' + Object.keys(cityCounty).length + ' cities, ' + nearest + ' by nearest centroid');
console.log('admin ' + Object.keys(byState).length + ' state files, ' + (adminBytes / 1024).toFixed(0) + ' KB, MI ' + (fs.statSync(nodePath.join(adminDir, 'MI.json')).size / 1024).toFixed(0) + ' KB, server ' + (fs.statSync(fnOut).size / 1024).toFixed(0) + ' KB');
console.log('MI|Troy -> ' + cityCounty['MI|Troy'] + ' ' + names[cityCounty['MI|Troy']] + ', MI|Ann Arbor -> ' + names[cityCounty['MI|Ann Arbor']] + ', OH|Columbus -> ' + names[cityCounty['OH|Columbus']]);
