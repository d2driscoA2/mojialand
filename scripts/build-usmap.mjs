// Builds site/admin/usmap.json for the admin Analytics map: state outlines and
// city positions, projected to the same 975 x 610 US map. Run from any folder:
//   mkdir -p /tmp/usmap && cd /tmp/usmap && npm init -y && npm i all-the-cities@3.1.0 d3-geo@3.1.1 topojson-client@3.1.0 us-atlas@3.0.1
//   node <repo>/scripts/build-usmap.mjs <repo>/site/admin/usmap.json
import fs from 'fs';
import nodePath from 'path';
import { createRequire } from 'module';

const require2 = createRequire(nodePath.join(process.cwd(), 'x.js'));
const { feature } = require2('topojson-client');
const { geoPath, geoAlbersUsa } = await import(require2.resolve('d3-geo'));
const us = JSON.parse(fs.readFileSync(require2.resolve('us-atlas/states-albers-10m.json')));
const AB={Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE','District of Columbia':'DC',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY'};
const path = geoPath();
const r1 = s => s.replace(/(\d+\.\d)\d+/g,'$1');
const states = feature(us, us.objects.states).features.map(f=>{const ab=AB[f.properties.name]; if(!ab) throw new Error(f.properties.name); const c=path.centroid(f); return {n:f.properties.name, ab, c:[Math.round(c[0]),Math.round(c[1])], d:r1(path(f))}});
// small or odd-shaped states: nudge the label point
const nudge={MI:[18,40],FL:[20,10],LA:[-10,0],KY:[6,4],VA:[8,4],MD:[0,-2],NY:[6,4]};
states.forEach(s=>{const n=nudge[s.ab]; if(n){s.c=[s.c[0]+n[0],s.c[1]+n[1]]}});
const proj = geoAlbersUsa().scale(1300).translate([487.5,305]);
const cities={}, pop={};
for (const x of require2('all-the-cities')) {
  if (x.country!=='US' || !AB[Object.keys(AB).find(k=>AB[k]===x.adminCode)] ) continue;
  const p = proj(x.loc.coordinates); if(!p) continue;
  const keys=[x.adminCode+'|'+x.name]; if(x.altName) for(const a of String(x.altName).split(',')) if(a && /^[\p{L} .'-]+$/u.test(a)) keys.push(x.adminCode+'|'+a);
  for (const k of keys) if(!(k in cities) || x.population>pop[k]){ cities[k]=[Math.round(p[0]*10)/10,Math.round(p[1]*10)/10]; pop[k]=x.population; }
}
const OUT = process.argv[2] || 'usmap.json';
fs.writeFileSync(OUT, JSON.stringify({attribution:'State outlines: US Census Bureau via us-atlas (ISC). City locations: GeoNames (CC BY 4.0) via all-the-cities.', states, cities}));
console.log(Object.keys(cities).length, (fs.statSync(OUT).size/1024).toFixed(0)+' KB', cities['MI|Troy'], cities['MI|Royal Oak']);
