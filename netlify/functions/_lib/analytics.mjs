// Analytics counting. Counts only: a city, a state, a game, a number.
// No IP address, device, session, ZIP code or coordinates is ever stored.
import { rest, rateHit, safeErr } from './db.mjs';

export const GAMES = ['pattern', 'bounce', 'match', 'parade', 'draw'];
export const LABEL_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
const EVENTS = ['open', 'beat', 'close', 'camp'];

// City and state from Netlify's geo data. Everything else is dropped here.
export function placeFromGeo(geo) {
  const g = geo && typeof geo === 'object' ? geo : {};
  const clean = (s, max) => String(s || '').replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const country = clean(g.country && g.country.code, 2).toUpperCase();
  const state = clean(g.subdivision && g.subdivision.code, 3).toUpperCase();
  const city = clean(g.city, 60);
  return { country, state, city };
}

// Checks a ping body. Returns a clean object or null.
export function readPing(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const e = body.e;
  if (!EVENTS.includes(e)) return null;
  const out = { e };
  if (e === 'camp') {
    if (typeof body.c !== 'string' || !LABEL_RE.test(body.c)) return null;
    out.c = body.c;
    return out;
  }
  if (!GAMES.includes(body.g)) return null;
  out.g = body.g;
  out.m = body.m === 'app' ? 'app' : 'web';
  if (e === 'close') {
    const b = Number(body.b);
    if (!Number.isInteger(b) || b < 0 || b > 3) return null;
    out.b = b;
  }
  if (e === 'open' && typeof body.c === 'string' && LABEL_RE.test(body.c) && body.cp === 1) out.c = body.c;
  return out;
}

// Adds one campaign event. Never throws: counting must not break a purchase.
export async function campaignHit(label, event, place = {}, days = 0) {
  if (typeof label !== 'string' || !LABEL_RE.test(label)) return false;
  const d = Number(days);
  try {
    const { data } = await rest('POST', 'rpc/campaign_add', {
      body: {
        p_label: label,
        p_country: place.country || '',
        p_state: place.state || '',
        p_city: place.city || '',
        p_event: event,
        p_days: Number.isFinite(d) && d >= 0 && d <= 7 ? Math.round(d * 10) / 10 : 0,
      },
    });
    return data === true;
  } catch (e) {
    console.error('analytics: campaign count failed (' + safeErr(e) + ')');
    return false;
  }
}

// Records one ping. Returns an HTTP status number.
export async function recordPing(raw, geo, ip) {
  const p = readPing(raw);
  if (!p) return 400;
  // A classroom on one network opens many games; 300 pings per 10 minutes is plenty.
  if (!(await rateHit('ping', ip, 300, 600))) return 429;
  const place = placeFromGeo(geo);
  if (p.e === 'camp') {
    await campaignHit(p.c, 'open', place);
    return 204;
  }
  await rest('POST', 'rpc/analytics_add', {
    body: {
      p_country: place.country,
      p_state: place.state,
      p_city: place.city,
      p_game: p.g,
      p_mode: p.m,
      p_open: p.e === 'open' ? 1 : 0,
      p_live: p.e === 'beat' ? 1 : 0,
      p_bucket: p.e === 'close' ? p.b : -1,
    },
  });
  if (p.c) await campaignHit(p.c, 'play', place);
  return 204;
}
