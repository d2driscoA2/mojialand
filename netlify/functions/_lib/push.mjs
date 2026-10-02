// Phone alerts for the admin (Release 1.1 #23). Web push to the admin page saved on a Home Screen.
// No outside service: the phone's own push service (Apple, Google, Mozilla) carries the message.
// Alerts say what happened and nothing about who: no names, emails, devices, or places.
// Keys: VAPID_PUBLIC_KEY (65-byte point, base64url) and VAPID_PRIVATE_KEY (32 bytes, base64url).
import crypto from 'node:crypto';
import { rest, rateHit, safeErr } from './db.mjs';

const enc = encodeURIComponent;
export const MODES = ['each', 'daily', 'off'];
// Only real push services, so the admin page cannot make the server call any other address.
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];
const B64U = /^[A-Za-z0-9_-]+$/;
const HOURLY_CAP = 12;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

export function pushReady() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

// Checks a PushSubscription from the browser. Returns a clean row or null.
export function readSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  let u;
  try { u = new URL(String(sub.endpoint || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || String(sub.endpoint).length > 600) return null;
  if (!PUSH_HOSTS.some((re) => re.test(u.hostname))) return null;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || !B64U.test(k.p256dh.replace(/=+$/, '')) || !B64U.test(k.auth.replace(/=+$/, ''))) return null;
  if (unb64u(k.p256dh).length !== 65 || unb64u(k.auth).length !== 16) return null;
  return { endpoint: u.href, p256dh: k.p256dh.replace(/=+$/, ''), auth: k.auth.replace(/=+$/, '') };
}

function vapidKey() {
  const pub = unb64u(process.env.VAPID_PUBLIC_KEY);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: String(process.env.VAPID_PRIVATE_KEY) }, format: 'jwk' });
}

// VAPID (RFC 8292): a short signed note that says this server sent the push.
export function vapidAuth(endpoint, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  // Fixed public address (Release 1.1.1 #38): ADMIN_EMAIL is private and never leaves Mojialand.
  const sub = 'mailto:hello@mojialand.com';
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: vapidKey(), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + process.env.VAPID_PUBLIC_KEY;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Message encryption (RFC 8291, aes128gcm). Only the phone can read the alert.
export function encryptPayload(text, sub, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const e = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) e.generateKeys();
  const asPublic = e.getPublicKey();
  const shared = e.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one alert to one phone. Returns 'ok', 'gone' (the phone turned alerts off) or 'fail'.
export async function sendPush(sub, msg) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
      body: encryptPayload(JSON.stringify(msg), sub),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

// Sends to every saved phone. Drops phones whose push service says they are gone.
export async function pushAll(msg) {
  if (!pushReady()) return 0;
  const { data } = await rest('GET', 'push_subs?select=endpoint,p256dh,auth');
  let sent = 0;
  for (const s of Array.isArray(data) ? data : []) {
    const r = await sendPush(s, msg);
    if (r === 'ok') sent++;
    if (r === 'gone') await rest('DELETE', 'push_subs?endpoint=eq.' + enc(s.endpoint), { prefer: 'return=minimal' });
  }
  return sent;
}

export async function alertMode() {
  try {
    const { data } = await rest('GET', 'settings?key=eq.alerts_mode&select=value&limit=1');
    const v = Array.isArray(data) && data[0] ? data[0].value : 'each';
    return MODES.includes(v) ? v : 'each';
  } catch {
    return 'each';
  }
}

// The day in Michigan time, as YYYY-MM-DD. Daily totals follow Danny's day.
export function michiganDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function alertText(kind, label) {
  if (kind === 'player') return { title: 'New player', body: 'Mojialand opened on a new device.' };
  if (kind === 'gift') return { title: 'Gift code used', body: label ? 'Batch ' + label + '.' : 'A gift code turned on.' };
  return { title: 'Mojialand', body: 'Something new happened.' };
}

// One event: counts it for the daily summary and, in "each" mode, buzzes the phone.
// Never throws: an alert must never break a game ping or a code.
// At most 12 single alerts an hour; the rest wait for the daily summary.
export async function notify(kind, label = '') {
  try {
    const l = String(label || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
    await rest('POST', 'rpc/alert_add', { body: { p_day: michiganDay(), p_kind: kind, p_label: l } });
    if ((await alertMode()) !== 'each' || !pushReady()) return false;
    if (!(await rateHit('alerts', 'all', HOURLY_CAP, 3600))) return false;
    await pushAll({ ...alertText(kind, l), tag: kind });
    return true;
  } catch (e) {
    console.error('alerts: failed (' + safeErr(e) + ')');
    return false;
  }
}

// The evening summary: new players and gift codes for the day.
export function summaryText(rows) {
  let players = 0, gifts = 0;
  const by = {};
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.kind === 'player') players += n;
    if (r.kind === 'gift') { gifts += n; if (r.label) by[r.label] = (by[r.label] || 0) + n; }
  }
  const p = players ? players + ' new player' + (players === 1 ? '' : 's') : 'No new players';
  const labels = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', ');
  const g = gifts ? gifts + ' gift code' + (gifts === 1 ? '' : 's') + ' used' + (labels ? ' (' + labels + ')' : '') : 'no gift codes used';
  return { title: 'Today in Mojialand', body: p + ', ' + g + '.' };
}

export async function dailySummary(now = Date.now()) {
  if ((await alertMode()) === 'off' || !pushReady()) return false;
  const { data } = await rest('GET', 'alert_counts?day=eq.' + michiganDay(now) + '&select=kind,label,n');
  await pushAll({ ...summaryText(Array.isArray(data) ? data : []), tag: 'summary' });
  return true;
}
