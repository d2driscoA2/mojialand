// Builds what the admin Analytics tab shows. Small places are folded into
// their county, state, province or country here, on the server, so the admin
// page never receives a place below the small-number rule.
import { rest } from './db.mjs';
import { GAMES, LABEL_RE } from './analytics.mjs';
import { NA, regionId, BLOCKED, BLOCKED_REGIONS } from './geo.mjs';
import UC from './uscounty.json' with { type: 'json' };

export const TZ = 'America/Detroit';
export const LIVE_MIN = 3; // a city shows with 3 or more games open
export const DAY_MIN = 5; // a city shows on days with 5 or more plays
export const CAMP_MIN = 5; // a campaign city shows with 5 or more opens
const BUCKET_MIN = [1, 3.5, 10, 20]; // middle of each play-length range
const SLOT = 5 * 60e3;
const gi = (g) => GAMES.indexOf(g);
const zeros = () => GAMES.map(() => 0);

// ---------- dates in the admin's time zone
function parts(t, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return o;
}
export function localDate(t, tz = TZ) {
  const o = parts(t, tz);
  return o.year + '-' + o.month + '-' + o.day;
}
function offsetMs(t, tz) {
  const o = parts(t, tz);
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(t / 1000) * 1000;
}
// UTC time of local midnight, `back` days before the day of `t`.
export function localMidnight(t, back = 0, tz = TZ) {
  const o = parts(t, tz);
  const guess = Date.UTC(+o.year, +o.month - 1, +o.day - back);
  return guess - offsetMs(guess, tz);
}
export function lastDays(n, now, tz = TZ) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(localDate(localMidnight(now, i, tz) + 12 * 3600e3, tz));
  return out;
}

// ---------- places: city, county, state. The small-number rule works at
// every level: a small city folds into its county, a small county into its state.
export function countyOf(st, ci) {
  return (ci && UC.cities[st + '|' + ci]) || '';
}
export const countyName = (id) => UC.names[id] || '';
const isUS = (r) => r.co === 'US' && !!r.st;
// Canada and Mexico: cities follow the same rule as US cities, with no county
// level. Their entries use the region id (CA-ON) in place of the state.
const isCAMX = (r) => (r.co === 'CA' || r.co === 'MX') && !!r.st;
const top = (by) => by.indexOf(Math.max(...by));
const addBy = (a, b) => { for (let i = 0; i < a.length; i++) a[i] += b[i] || 0; };
const oneGame = (g, n) => { const by = zeros(); by[gi(g)] = n; return by; };
const addHour = (o, k, h, v) => { (o[k] = o[k] || new Array(24).fill(0))[h] += v; };

// North America map: every play counts toward its state or province, like
// the US state totals. list: [{rid, co, n, by}]
function regionTotals(list) {
  const out = {};
  for (const e of list) {
    if (!out[e.rid]) out[e.rid] = { region: e.rid, country: e.co, total: 0, byGame: zeros() };
    out[e.rid].total += e.n;
    addBy(out[e.rid].byGame, e.by);
  }
  return Object.values(out).sort((a, b) => b.total - a.total);
}
// Shown Canadian and Mexican cities with their country and short code.
function naCities(list) {
  return list.map((c) => ({ ...c, country: c.state.slice(0, 2), code: c.state.slice(3) }));
}
// World view: a country shows once its total passes the rule; inside it a
// region shows once its total passes the rule. The rest adds up.
// list: [{co, rid, n, by, min}]. Countries blocked in Release 1.5 keep their
// earlier plays, tagged blocked.
export function worldFold(list, min) {
  const by = new Map();
  let unnamed = 0;
  for (const e of list) {
    if (!e.co) { unnamed += e.n; continue; }
    if (!by.has(e.co)) by.set(e.co, { co: e.co, total: 0, byGame: zeros(), minutes: 0, blocked: BLOCKED.has(e.co), regions: new Map() });
    const c = by.get(e.co);
    c.total += e.n; c.minutes += e.min || 0; addBy(c.byGame, e.by);
    const rid = e.rid || '';
    if (!c.regions.has(rid)) c.regions.set(rid, { id: rid, total: 0, byGame: zeros(), blocked: BLOCKED_REGIONS.has(rid) });
    const r = c.regions.get(rid);
    r.total += e.n; addBy(r.byGame, e.by);
  }
  const countries = [];
  let otherCountries = 0, otherCount = 0;
  for (const c of by.values()) {
    if (c.total < min) { otherCountries += c.total; otherCount++; continue; }
    const regions = [];
    let smaller = 0;
    for (const r of c.regions.values()) { if (r.id && r.total >= min) regions.push(r); else smaller += r.total; }
    regions.sort((a, b) => b.total - a.total);
    countries.push({ co: c.co, total: c.total, byGame: c.byGame, minutes: Math.round(c.minutes), blocked: c.blocked, regions, smaller });
  }
  countries.sort((a, b) => b.total - a.total);
  return { countries, otherCountries, otherCount, unnamed, rule: min };
}

// entries: [{st, ci, n, by}] for US places only. Returns shown cities,
// shown counties (what is left in them after shown cities) and state rolls.
export function foldPlaces(entries, min) {
  const cities = new Map();
  const rolls = {};
  const rollBy = {};
  for (const e of entries) {
    if (!e.ci) { rolls[e.st] = (rolls[e.st] || 0) + e.n; addBy((rollBy[e.st] = rollBy[e.st] || zeros()), e.by || []); continue; }
    const k = e.st + '|' + e.ci;
    if (!cities.has(k)) cities.set(k, { city: e.ci, state: e.st, county: countyOf(e.st, e.ci), total: 0, byGame: zeros(), minutes: 0 });
    const c = cities.get(k);
    c.total += e.n;
    addBy(c.byGame, e.by || []);
    c.minutes += e.min || 0;
  }
  const shown = [];
  const left = new Map();
  for (const c of cities.values()) {
    if (c.total >= min) { shown.push(c); continue; }
    if (!c.county) { rolls[c.state] = (rolls[c.state] || 0) + c.total; addBy((rollBy[c.state] = rollBy[c.state] || zeros()), c.byGame); continue; }
    if (!left.has(c.county)) left.set(c.county, { id: c.county, name: countyName(c.county), state: c.state, total: 0, byGame: zeros(), minutes: 0 });
    const k = left.get(c.county);
    k.total += c.total;
    addBy(k.byGame, c.byGame);
    k.minutes += c.minutes;
  }
  const counties = [];
  for (const k of left.values()) {
    if (k.total >= min) counties.push(k);
    else { rolls[k.state] = (rolls[k.state] || 0) + k.total; addBy((rollBy[k.state] = rollBy[k.state] || zeros()), k.byGame); }
  }
  shown.sort((a, b) => b.total - a.total);
  counties.sort((a, b) => b.total - a.total);
  return { cities: shown, counties, rolls, rollBy };
}
// Adds one fold result into a running total (used across days).
function mergeFold(acc, f) {
  for (const c of f.cities) {
    const k = c.state + '|' + c.city;
    if (!acc.cities.has(k)) acc.cities.set(k, { ...c, byGame: zeros(), total: 0, minutes: 0 });
    const x = acc.cities.get(k);
    x.total += c.total; x.minutes += c.minutes; addBy(x.byGame, c.byGame);
  }
  for (const c of f.counties) {
    if (!acc.counties.has(c.id)) acc.counties.set(c.id, { ...c, byGame: zeros(), total: 0, minutes: 0 });
    const x = acc.counties.get(c.id);
    x.total += c.total; x.minutes += c.minutes; addBy(x.byGame, c.byGame);
  }
  for (const [st, v] of Object.entries(f.rolls)) acc.rolls[st] = (acc.rolls[st] || 0) + v;
  for (const [st, v] of Object.entries(f.rollBy)) addBy((acc.rollBy[st] = acc.rollBy[st] || zeros()), v);
}
// State totals (everything, shown or not) for the state level of the map.
function stateTotals(entries) {
  const out = {};
  for (const e of entries) {
    if (!out[e.st]) out[e.st] = { state: e.st, total: 0, byGame: zeros() };
    out[e.st].total += e.n;
    addBy(out[e.st].byGame, e.by || []);
  }
  return Object.values(out).sort((a, b) => b.total - a.total);
}

// ---------- live
export async function liveView(now = Date.now()) {
  const asOf = Math.floor(now / SLOT) * SLOT - SLOT; // the last full slot: 5 minutes behind
  const since = new Date(asOf - 5 * SLOT).toISOString();
  const { data } = await rest('GET', 'plays_live?slot_start=gte.' + encodeURIComponent(since) + '&select=slot_start,country,state,city,game,n&limit=5000');
  const rows = (Array.isArray(data) ? data : []).map((r) => ({ t: new Date(r.slot_start).getTime(), co: r.country, st: r.state, ci: r.city, g: r.game, n: Number(r.n) || 0 }));
  const bySlot = new Map();
  for (const r of rows) {
    if (r.t > asOf || gi(r.g) < 0) continue;
    if (!bySlot.has(r.t)) bySlot.set(r.t, []);
    bySlot.get(r.t).push(r);
  }
  const slotView = (list) => {
    const byGame = zeros();
    let total = 0;
    let other = 0;
    const entries = [], naEntries = [], naReg = [], wl = [];
    for (const r of list) {
      total += r.n;
      byGame[gi(r.g)] += r.n;
      const by = oneGame(r.g, r.n);
      const rid = regionId(r.co, r.st);
      wl.push({ co: r.co, rid, n: r.n, by });
      if (NA.has(r.co) && rid) naReg.push({ rid, co: r.co, n: r.n, by });
      if (isCAMX(r)) naEntries.push({ st: rid, ci: r.ci, n: r.n, by });
      if (!isUS(r)) { other += r.n; continue; }
      entries.push({ st: r.st, ci: r.ci, n: r.n, by });
    }
    const f = foldPlaces(entries, LIVE_MIN);
    const nf = foldPlaces(naEntries, LIVE_MIN);
    const na = { cities: naCities(nf.cities), rolls: nf.rolls, regions: regionTotals(naReg) };
    return { total, byGame, other, ...f, states: stateTotals(entries), na, world: worldFold(wl, LIVE_MIN) };
  };
  const cur = slotView(bySlot.get(asOf) || []);
  delete cur.rollBy;
  const feed = [];
  for (const t of [...bySlot.keys()].sort((a, b) => b - a)) {
    const sv = slotView(bySlot.get(t));
    for (const c of sv.cities) feed.push({ t: new Date(t).toISOString(), city: c.city, state: c.state, country: 'US', game: GAMES[top(c.byGame)], n: c.total });
    for (const c of sv.na.cities) feed.push({ t: new Date(t).toISOString(), city: c.city, state: c.code, country: c.country, game: GAMES[top(c.byGame)], n: c.total });
  }
  cur.cities.forEach((c) => { c.countyName = countyName(c.county); delete c.minutes; });
  cur.counties.forEach((c) => { delete c.minutes; });
  cur.na.cities.forEach((c) => { delete c.minutes; delete c.county; });
  cur.world.countries.forEach((c) => { delete c.minutes; });
  return { asOf: new Date(asOf).toISOString(), games: GAMES, ...cur, feed: feed.slice(0, 8), rule: LIVE_MIN };
}

// ---------- history
export const RANGES = [1, 7, 30, 60, 90, 365];
const KEEP_DAYS = 400;
const minutesOf = (b) => b.reduce((a, v, i) => a + v * BUCKET_MIN[i], 0);

export async function historyView(range, now = Date.now()) {
  const n = RANGES.includes(Number(range)) ? Number(range) : 7;
  const from = localMidnight(now, n - 1);
  const { data } = await rest('POST', 'rpc/analytics_history', { body: { p_from: new Date(from).toISOString(), p_tz: TZ } });
  const days = lastDays(n, now);
  const dayIx = new Map(days.map((d, i) => [d, i]));
  const src = data && typeof data === 'object' ? data : {};
  const dayRows = (Array.isArray(src.days) ? src.days : []).filter((r) => dayIx.has(r.d) && gi(r.g) >= 0);

  const perDay = days.map(() => zeros());
  const perDayMinutes = days.map(() => 0);
  const byGame = zeros();
  const closes = zeros();
  const minutesGame = zeros();
  const buckets = [0, 0, 0, 0];
  let plays = 0;
  let app = 0;
  let other = 0;
  const dayEntries = days.map(() => []);
  const allEntries = [];
  const naDay = days.map(() => []);
  const naReg = [], wl = [];
  for (const r of dayRows) {
    const o = Number(r.o) || 0;
    const b = [r.b0, r.b1, r.b2, r.b3].map((v) => Number(v) || 0);
    const j = gi(r.g);
    const di = dayIx.get(r.d);
    perDay[di][j] += o;
    perDayMinutes[di] += minutesOf(b);
    byGame[j] += o;
    plays += o;
    if (r.m === 'app') app += o;
    b.forEach((v, i) => { buckets[i] += v; closes[j] += v; minutesGame[j] += v * BUCKET_MIN[i]; });
    const rid = regionId(r.co, r.st);
    const oneBy = oneGame(r.g, o);
    wl.push({ co: r.co, rid, n: o, by: oneBy, min: minutesOf(b) });
    if (NA.has(r.co) && rid) naReg.push({ rid, co: r.co, n: o, by: oneBy });
    if (isCAMX(r)) naDay[di].push({ st: rid, ci: r.ci || '', n: o, by: oneBy, min: minutesOf(b) });
    if (!isUS(r)) { other += o; continue; }
    const by = zeros();
    by[j] = o;
    const e = { st: r.st, ci: r.ci || '', n: o, by, min: minutesOf(b) };
    dayEntries[di].push(e);
    allEntries.push(e);
  }
  // The rule applies day by day, then the days add up.
  const acc = { cities: new Map(), counties: new Map(), rolls: {}, rollBy: {} };
  for (const list of dayEntries) mergeFold(acc, foldPlaces(list, DAY_MIN));
  const cityList = [...acc.cities.values()].sort((a, b) => b.total - a.total);
  cityList.forEach((c) => { c.minutes = Math.round(c.minutes); c.countyName = countyName(c.county); });
  const countyList = [...acc.counties.values()].sort((a, b) => b.total - a.total);
  countyList.forEach((c) => { c.minutes = Math.round(c.minutes); });
  const shownCity = new Set(cityList.map((c) => c.state + '|' + c.city));
  const shownCounty = new Set(countyList.map((c) => c.id));
  // Canada and Mexico: the same rule, day by day
  const naAcc = { cities: new Map(), counties: new Map(), rolls: {}, rollBy: {} };
  for (const list of naDay) mergeFold(naAcc, foldPlaces(list, DAY_MIN));
  const naList = naCities([...naAcc.cities.values()].sort((a, b) => b.total - a.total));
  naList.forEach((c) => { c.minutes = Math.round(c.minutes); delete c.county; });
  const naShown = new Set(naList.map((c) => c.state + '|' + c.city));
  const na = { cities: naList, rolls: naAcc.rolls, regions: regionTotals(naReg), cityHours: {}, rollHours: {}, regionHours: {} };
  const world = { ...worldFold(wl, DAY_MIN), countryHours: {} };

  // hours of the day (local): busiest hours, today's chart and the replay
  const hours = new Array(24).fill(0);
  const hoursGame = Array.from({ length: 24 }, zeros);
  const cityHours = {};
  const countyHours = {};
  const stateHours = {};
  for (const r of Array.isArray(src.hours) ? src.hours : []) {
    const h = Number(r.h);
    const o = Number(r.o) || 0;
    if (!(h >= 0 && h < 24) || gi(r.g) < 0) continue;
    hours[h] += o;
    hoursGame[h][gi(r.g)] += o;
    if (r.co) addHour(world.countryHours, r.co, h, o);
    const rid = regionId(r.co, r.st);
    if (NA.has(r.co) && rid) addHour(na.regionHours, rid, h, o);
    if (isCAMX(r)) {
      const nk = rid + '|' + (r.ci || '');
      if (r.ci && naShown.has(nk)) addHour(na.cityHours, nk, h, o);
      else addHour(na.rollHours, rid, h, o);
    }
    if (!isUS(r)) continue;
    const ck = r.st + '|' + (r.ci || '');
    const cty = countyOf(r.st, r.ci);
    if (r.ci && shownCity.has(ck)) (cityHours[ck] = cityHours[ck] || new Array(24).fill(0))[h] += o;
    else if (cty && shownCounty.has(cty)) (countyHours[cty] = countyHours[cty] || new Array(24).fill(0))[h] += o;
    else (stateHours[r.st] = stateHours[r.st] || new Array(24).fill(0))[h] += o;
  }

  // the period before, for the change figures (not for Today, and only inside the 400 days kept)
  let prev = null;
  if (n > 1 && 2 * n <= KEEP_DAYS) {
    const pDays = lastDays(2 * n, now).slice(0, n);
    const pIx = new Map(pDays.map((d, i) => [d, i]));
    const { data: pd } = await rest('POST', 'rpc/analytics_history', { body: { p_from: new Date(localMidnight(now, 2 * n - 1)).toISOString(), p_tz: TZ } });
    const pRows = (pd && Array.isArray(pd.days) ? pd.days : []).filter((r) => pIx.has(r.d) && gi(r.g) >= 0);
    prev = { days: pDays, perDay: pDays.map(() => 0), perDayMinutes: pDays.map(() => 0), plays: 0, minutes: 0 };
    for (const r of pRows) {
      const o = Number(r.o) || 0;
      const m = minutesOf([r.b0, r.b1, r.b2, r.b3].map((v) => Number(v) || 0));
      prev.perDay[pIx.get(r.d)] += o;
      prev.perDayMinutes[pIx.get(r.d)] += m;
      prev.plays += o;
      prev.minutes += m;
    }
    prev.minutes = Math.round(prev.minutes);
    prev.perDayMinutes = prev.perDayMinutes.map(Math.round);
  }

  const minutes = Math.round(minutesGame.reduce((a, b) => a + b, 0));
  const closed = buckets.reduce((a, b) => a + b, 0);
  const states = stateTotals(allEntries);
  return {
    range: n, tz: TZ, games: GAMES, days, perDay, perDayMinutes: perDayMinutes.map(Math.round), byGame,
    avgMinutes: minutesGame.map((m, i) => (closes[i] ? Math.round((m / closes[i]) * 10) / 10 : 0)),
    buckets, plays, minutes,
    minutesPerPlay: closed ? Math.round((minutes / closed) * 10) / 10 : 0,
    appShare: plays ? Math.round((app / plays) * 100) : 0,
    cities: cityList, counties: countyList, rolls: acc.rolls, rollBy: acc.rollBy, states, other, na, world,
    cityCount: cityList.length, stateCount: states.length,
    hours, hoursGame, cityHours, countyHours, stateHours, rule: DAY_MIN, prev,
    todayHour: Number(parts(now, TZ).hour),
  };
}

// ---------- campaigns
export async function campaignsView(now = Date.now()) {
  const { data } = await rest('POST', 'rpc/campaign_stats', { body: { p_tz: TZ } });
  const src = data && typeof data === 'object' ? data : {};
  const today = localDate(now);
  const list = (Array.isArray(src.campaigns) ? src.campaigns : []).map((c) => ({
    label: c.label, name: c.name, note: c.note || '', active: c.active !== false, created_at: c.created_at,
    start: localDate(new Date(c.created_at).getTime()),
    open: 0, play: 0, gift: 0, pass48: 0, forever: 0, daysSum: 0, daily: {}, places: [], naPlaces: [], wl: [], other: 0,
  }));
  const by = new Map(list.map((c) => [c.label, c]));
  for (const r of Array.isArray(src.days) ? src.days : []) {
    const c = by.get(r.l);
    if (!c || !(r.e in c)) continue;
    const nn = Number(r.n) || 0;
    c[r.e] += nn;
    if (r.e === 'pass48' || r.e === 'forever') c.daysSum += Number(r.ds) || 0;
    if (r.e === 'open') c.daily[r.d] = (c.daily[r.d] || 0) + nn;
  }
  for (const r of Array.isArray(src.places) ? src.places : []) {
    const c = by.get(r.l);
    if (!c) continue;
    const nn = Number(r.n) || 0;
    const rid = regionId(r.co, r.st);
    c.wl.push({ co: r.co, rid, n: nn, by: [] });
    if (isCAMX(r)) c.naPlaces.push({ st: rid, ci: r.ci || '', n: nn });
    if (!isUS(r)) c.other += nn;
    else c.places.push({ st: r.st, ci: r.ci || '', n: nn });
  }
  for (const c of list) {
    const f = foldPlaces(c.places, CAMP_MIN);
    c.cities = f.cities.map((x) => ({ city: x.city, state: x.state, county: x.county, countyName: countyName(x.county), n: x.total }));
    c.counties = f.counties.map((x) => ({ id: x.id, name: x.name, state: x.state, n: x.total }));
    c.rolls = f.rolls;
    delete c.places;
    const nf = foldPlaces(c.naPlaces, CAMP_MIN);
    c.na = { cities: nf.cities.map((x) => ({ city: x.city, state: x.state, country: x.state.slice(0, 2), code: x.state.slice(3), n: x.total })), rolls: nf.rolls };
    const w = worldFold(c.wl, CAMP_MIN);
    c.world = { countries: w.countries.map((x) => ({ co: x.co, n: x.total, blocked: x.blocked })), otherCountries: w.otherCountries, unnamed: w.unnamed };
    delete c.naPlaces;
    delete c.wl;
    const bought = c.pass48 + c.forever;
    c.avgDays = bought ? Math.round((c.daysSum / bought) * 10) / 10 : null;
    delete c.daysSum;
    const series = [];
    let t = Date.parse(c.start + 'T12:00:00Z');
    const end = Date.parse(today + 'T12:00:00Z');
    for (let i = 0; t <= end && i < 400; i++, t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      series.push({ d, n: c.daily[d] || 0 });
    }
    c.daily = series;
  }
  return { campaigns: list, rule: CAMP_MIN };
}

export async function createCampaign({ name, label, note }) {
  const nm = String(name || '').trim().slice(0, 60);
  const lb = String(label || '').trim().toLowerCase();
  if (!nm) throw new Error('add a name so you know which event this is');
  if (!LABEL_RE.test(lb)) throw new Error('use 2 to 24 lowercase letters, numbers or dashes for the label');
  const { data: have } = await rest('GET', 'campaigns?label=eq.' + encodeURIComponent(lb) + '&select=label&limit=1');
  if (Array.isArray(have) && have.length) throw new Error('that label is taken. Try adding a month, like -oct');
  await rest('POST', 'campaigns', { body: { label: lb, name: nm, note: String(note || '').trim().slice(0, 200) || null }, prefer: 'return=minimal' });
  return { label: lb };
}

export async function setCampaignActive({ label, active }) {
  const lb = String(label || '');
  if (!LABEL_RE.test(lb)) throw new Error('bad label');
  await rest('PATCH', 'campaigns?label=eq.' + encodeURIComponent(lb), { body: { active: !!active }, prefer: 'return=minimal' });
  return { ok: true };
}
