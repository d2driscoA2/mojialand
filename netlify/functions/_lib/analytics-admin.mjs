// Builds what the admin Analytics tab shows. Small places are folded into
// their state here, on the server, so the admin page never receives a city
// count below the small-number rule.
import { rest } from './db.mjs';
import { GAMES, LABEL_RE } from './analytics.mjs';

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

// US city rows keep their city; everything else becomes state-only or "other".
function placeKey(r) {
  if (r.co !== 'US' || !r.st) return null;
  return r.st + '|' + (r.ci || '');
}
const top = (by) => by.indexOf(Math.max(...by));

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
  const fold = (list) => {
    const cities = new Map();
    const rolls = {};
    const byGame = zeros();
    let total = 0;
    let other = 0;
    for (const r of list) {
      total += r.n;
      byGame[gi(r.g)] += r.n;
      const k = placeKey(r);
      if (!k) { other += r.n; continue; }
      if (!r.ci) { rolls[r.st] = (rolls[r.st] || 0) + r.n; continue; }
      if (!cities.has(k)) cities.set(k, { city: r.ci, state: r.st, total: 0, byGame: zeros() });
      const c = cities.get(k);
      c.total += r.n;
      c.byGame[gi(r.g)] += r.n;
    }
    const shown = [];
    for (const c of cities.values()) {
      if (c.total >= LIVE_MIN) shown.push(c);
      else rolls[c.state] = (rolls[c.state] || 0) + c.total;
    }
    shown.sort((a, b) => b.total - a.total);
    return { total, byGame, cities: shown, rolls, other };
  };
  const cur = fold(bySlot.get(asOf) || []);
  const feed = [];
  for (const t of [...bySlot.keys()].sort((a, b) => b - a)) {
    for (const c of fold(bySlot.get(t)).cities) feed.push({ t: new Date(t).toISOString(), city: c.city, state: c.state, game: GAMES[top(c.byGame)], n: c.total });
  }
  return { asOf: new Date(asOf).toISOString(), games: GAMES, ...cur, feed: feed.slice(0, 8), rule: LIVE_MIN };
}

// ---------- history
export async function historyView(range, now = Date.now()) {
  const n = [1, 7, 30].includes(Number(range)) ? Number(range) : 7;
  const from = localMidnight(now, n - 1);
  const { data } = await rest('POST', 'rpc/analytics_history', { body: { p_from: new Date(from).toISOString(), p_tz: TZ } });
  const days = lastDays(n, now);
  const dayIx = new Map(days.map((d, i) => [d, i]));
  const src = data && typeof data === 'object' ? data : {};
  const dayRows = (Array.isArray(src.days) ? src.days : []).filter((r) => dayIx.has(r.d) && gi(r.g) >= 0);

  const perDay = days.map(() => zeros());
  const byGame = zeros();
  const closes = zeros();
  const minutesGame = zeros();
  const buckets = [0, 0, 0, 0];
  let plays = 0;
  let app = 0;
  let other = 0;
  // city-day totals decide who shows
  const cityDay = new Map();
  for (const r of dayRows) {
    const o = Number(r.o) || 0;
    const b = [r.b0, r.b1, r.b2, r.b3].map((v) => Number(v) || 0);
    const j = gi(r.g);
    perDay[dayIx.get(r.d)][j] += o;
    byGame[j] += o;
    plays += o;
    if (r.m === 'app') app += o;
    b.forEach((v, i) => { buckets[i] += v; closes[j] += v; minutesGame[j] += v * BUCKET_MIN[i]; });
    const k = placeKey(r);
    if (!k) { other += o; continue; }
    const ck = k + '|' + r.d;
    if (!cityDay.has(ck)) cityDay.set(ck, { k, st: r.st, ci: r.ci, o: 0, by: zeros(), min: 0 });
    const c = cityDay.get(ck);
    c.o += o;
    c.by[j] += o;
    c.min += b.reduce((a, v, i) => a + v * BUCKET_MIN[i], 0);
  }
  const cities = new Map();
  const rolls = {};
  const shownKeys = new Set();
  for (const c of cityDay.values()) {
    if (c.ci && c.o >= DAY_MIN) {
      shownKeys.add(c.k);
      if (!cities.has(c.k)) cities.set(c.k, { city: c.ci, state: c.st, total: 0, byGame: zeros(), minutes: 0 });
      const x = cities.get(c.k);
      x.total += c.o;
      c.by.forEach((v, i) => { x.byGame[i] += v; });
      x.minutes += c.min;
    } else if (c.o > 0) rolls[c.st] = (rolls[c.st] || 0) + c.o;
  }
  const cityList = [...cities.values()].sort((a, b) => b.total - a.total);
  cityList.forEach((c) => { c.minutes = Math.round(c.minutes); });

  // hours of the day (local): for busiest hours, today's chart, and the replay
  const hours = new Array(24).fill(0);
  const hoursGame = Array.from({ length: 24 }, zeros);
  const cityHours = {};
  const stateHours = {};
  for (const r of Array.isArray(src.hours) ? src.hours : []) {
    const h = Number(r.h);
    const o = Number(r.o) || 0;
    if (!(h >= 0 && h < 24) || gi(r.g) < 0) continue;
    hours[h] += o;
    hoursGame[h][gi(r.g)] += o;
    const k = placeKey(r);
    if (!k) continue;
    if (shownKeys.has(k)) (cityHours[k] = cityHours[k] || new Array(24).fill(0))[h] += o;
    else (stateHours[r.st] = stateHours[r.st] || new Array(24).fill(0))[h] += o;
  }
  const minutes = Math.round(minutesGame.reduce((a, b) => a + b, 0));
  const states = new Set([...cityList.map((c) => c.state), ...Object.keys(rolls)]);
  return {
    range: n, tz: TZ, games: GAMES, days, perDay, byGame,
    avgMinutes: minutesGame.map((m, i) => (closes[i] ? Math.round((m / closes[i]) * 10) / 10 : 0)),
    buckets, plays, minutes,
    minutesPerPlay: buckets.reduce((a, b) => a + b, 0) ? Math.round((minutes / buckets.reduce((a, b) => a + b, 0)) * 10) / 10 : 0,
    appShare: plays ? Math.round((app / plays) * 100) : 0,
    cities: cityList, rolls, other, cityCount: cityList.length, stateCount: states.size,
    hours, hoursGame, cityHours, stateHours, rule: DAY_MIN,
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
    open: 0, play: 0, gift: 0, pass48: 0, forever: 0, daysSum: 0, daily: {}, cities: [], rolls: {}, other: 0,
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
    if (r.co !== 'US' || !r.st) c.other += nn;
    else if (r.ci && nn >= CAMP_MIN) c.cities.push({ city: r.ci, state: r.st, n: nn });
    else c.rolls[r.st] = (c.rolls[r.st] || 0) + nn;
  }
  for (const c of list) {
    c.cities.sort((a, b) => b.n - a.n);
    const bought = c.pass48 + c.forever;
    c.avgDays = bought ? Math.round((c.daysSum / bought) * 10) / 10 : null;
    delete c.daysSum;
    // opens per day from the start day to today
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
