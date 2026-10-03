// Small response helpers. Same-origin only: no CORS headers, ever.
import crypto from 'node:crypto';

export function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(obj),
  };
}

export const fail = (statusCode, error) => json(statusCode, { error });

export function header(event, name) {
  const h = event.headers || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

export function clientIp(event) {
  const direct = header(event, 'x-nf-client-connection-ip');
  if (direct) return String(direct).trim();
  const fwd = header(event, 'x-forwarded-for');
  if (fwd) return String(fwd).split(',')[0].trim();
  return 'unknown';
}

export function rawBody(event) {
  if (event.body == null) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body);
}

export function readJson(event) {
  try {
    const body = rawBody(event);
    if (body.length > 4096) return null;
    const v = JSON.parse(body || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Return URLs only ever point at our own sites.
const HOSTS = new Set([
  'mojialand.com',
  'www.mojialand.com',
  'mojialand.displayedux.com',
  'mojialand-staging.netlify.app',
]);

export function originFromHost(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
  if (m) {
    if (HOSTS.has(m[1]) && !m[2]) return 'https://' + m[1];
    if (m[1] === 'localhost') return 'http://' + host;
  }
  return 'https://mojialand.com';
}

export function originFromUrl(url) {
  try {
    const u = new URL(url);
    return originFromHost(u.host);
  } catch {
    return 'https://mojialand.com';
  }
}

export const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export function maskEmail(email) {
  const e = String(email || '');
  const at = e.lastIndexOf('@');
  if (at < 1) return '';
  return e[0] + '•••' + e.slice(at);
}

// Release 1.1.1 #44 L3: logs carry only the last 6 characters of checkout,
// pass and event IDs. A full checkout ID plus confirm-session returns a code.
export function tail6(id) {
  const v = String(id || '');
  return v ? '…' + v.slice(-6) : '-';
}

// Release 1.1.1 #44 L5: admin requests must come from an admin page on the
// same site. Staging shares displayedux.com with other client sites, so a
// script on one of them could otherwise send admin requests from Danny's browser.
export function sameOrigin(event) {
  const want = originFromHost(header(event, 'host'));
  const origin = String(header(event, 'origin') || '');
  if (origin) return origin === want;
  return String(header(event, 'sec-fetch-site') || '') === 'same-origin';
}
