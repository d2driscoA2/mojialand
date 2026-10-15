// Release 1.5 #66: the server check for blocked countries and regions.
// Every public function calls refuseBlocked() first. A blocked request answers 451
// and adds one to the blocked count (country, region, kind, hour). Nothing else is stored:
// no IP address, no city, no device.
import { blockedFor, geoOverride } from './blocked-list.mjs';
import { rest, rateHit, switchOn, safeErr } from './db.mjs';
import { header, clientIp } from './http.mjs';

const STAGING = () => String(process.env.MOJIA_ENV || '').toLowerCase() === 'staging';

// Kinds the count accepts. "page" is an open of the blocked page.
export const BLOCKED_KINDS = ['page', 'create-checkout', 'confirm-session', 'pass-check', 'redeem-code', 'gifts', 'friend-code', 'ping', 'contact', 'settings'];

// Netlify geo data for handler-style functions: the x-nf-geo header (base64 JSON),
// then the x-country header. Modern functions pass context.geo instead.
export function geoFromEvent(event) {
  const raw = header(event, 'x-nf-geo');
  if (raw) {
    try {
      const g = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      if (g && typeof g === 'object') return g;
    } catch { /* fall through */ }
  }
  const c = header(event, 'x-country');
  return c ? { country: { code: c } } : null;
}

// Returns { country, region } when blocked, otherwise null.
export function blockedPlace(geo, cookieHeader) {
  if (STAGING()) {
    const o = geoOverride(cookieHeader);
    if (o) return blockedFor(o.country, o.sub);
  }
  const g = geo && typeof geo === 'object' ? geo : {};
  return blockedFor(g.country && g.country.code, g.subdivision && g.subdivision.code);
}

// Adds one blocked count. Never throws. The Stop play counts switch pauses it,
// and one network adds at most 60 counts in 10 minutes.
export async function recordBlocked(place, kind, ip) {
  if (!place || !BLOCKED_KINDS.includes(kind)) return false;
  try {
    if (await switchOn('play_counts_off')) return false;
    if (!(await rateHit('blocked', ip || 'unknown', 60, 600, { failOpen: false }))) return false;
    await rest('POST', 'rpc/blocked_add', { body: { p_country: place.country, p_region: place.region || '', p_kind: kind } });
    return true;
  } catch (e) {
    console.error('blocked: count failed (' + safeErr(e) + ')');
    return false;
  }
}

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export const BLOCKED_BODY = JSON.stringify({ error: 'Mojialand is not available in your country.' });

// For handler-style functions: returns a 451 response when blocked, otherwise null.
export async function refuseBlocked(event, kind) {
  const place = blockedPlace(geoFromEvent(event), header(event, 'cookie'));
  if (!place) return null;
  await recordBlocked(place, kind, clientIp(event));
  return { statusCode: 451, headers: NO_STORE, body: BLOCKED_BODY };
}
