// Supabase through PostgREST, with the service key. Only functions call this.
// Uses globalThis.fetch so tests can swap it.
import { sha256hex } from './http.mjs';

export class DbError extends Error {}

export async function rest(method, path, { body, prefer } = {}) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  // Legacy service_role keys are JWTs and go in both headers. New
  // sb_secret_ keys are not JWTs and go only in the apikey header.
  const headers = { apikey: key, Accept: 'application/json' };
  if (String(key || '').startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  let res;
  try {
    res = await globalThis.fetch(base + '/rest/v1/' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new DbError('db unreachable');
  }
  const text = await res.text();
  if (!res.ok) throw new DbError('db ' + method + ' ' + path.split('?')[0] + ' ' + res.status);
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { status: res.status, data };
}

const enc = encodeURIComponent;

// Rate limit. The key is a hash; raw addresses are never stored.
// Returns true when the call is allowed. Fails closed if the database is down,
// unless failOpen is set (for calls that must still work in an outage).
export async function rateHit(fnName, ip, limit, windowSeconds, { failOpen = false } = {}) {
  const salt = process.env.RATE_SALT || process.env.RESTORE_CODE_PEPPER || '';
  const key = sha256hex(salt + ip + ':' + fnName);
  try {
    const { data } = await rest('POST', 'rpc/rate_hit', {
      body: { p_key: key, p_window_seconds: windowSeconds, p_limit: limit },
    });
    return data === true;
  } catch {
    console.error(fnName + ': rate limit check failed');
    return failOpen;
  }
}

export async function getPassBy(field, value) {
  const { data } = await rest('GET', 'passes?' + field + '=eq.' + enc(value) + '&select=*&limit=1');
  return Array.isArray(data) && data.length ? data[0] : null;
}

// Inserts a row into stripe_events. Returns true only if this call inserted it.
export async function claimEvent(eventId, sessionId) {
  const { data } = await rest('POST', 'stripe_events?on_conflict=event_id', {
    body: { event_id: eventId, session_id: sessionId || null },
    prefer: 'resolution=ignore-duplicates,return=representation',
  });
  return Array.isArray(data) && data.length > 0;
}

export async function releaseEvent(eventId) {
  try {
    await rest('DELETE', 'stripe_events?event_id=eq.' + enc(eventId));
  } catch {
    console.error('could not release idempotency row');
  }
}

export async function patchPass(filter, patch) {
  const { data } = await rest('PATCH', 'passes?' + filter, { body: patch, prefer: 'return=representation' });
  return Array.isArray(data) ? data : [];
}

export async function getSetting(key, fallback) {
  try {
    const { data } = await rest('GET', 'settings?key=eq.' + enc(key) + '&select=value&limit=1');
    if (Array.isArray(data) && data.length) {
      const n = Number(data[0].value);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* fall back */
  }
  return fallback;
}

// Devices per pass. Stores only a hash of the random device value.
export const DEVICE_RE = /^[0-9a-f]{32}$/;

export async function addDevice(pass, deviceId) {
  if (!DEVICE_RE.test(String(deviceId || ''))) return { ok: true, counted: false };
  const pepper = process.env.RESTORE_CODE_PEPPER || '';
  const h = sha256hex(pepper + ':dev:' + deviceId);
  const pid = enc(pass.id);
  const { data: mine } = await rest('GET', 'devices?pass_id=eq.' + pid + '&device_id_hash=eq.' + h + '&select=id&limit=1');
  if (Array.isArray(mine) && mine.length) return { ok: true, counted: true };
  const { data: all } = await rest('GET', 'devices?pass_id=eq.' + pid + '&select=id');
  const limit = Number(pass.device_limit) || 5;
  if (Array.isArray(all) && all.length >= limit) return { ok: false, limit };
  await rest('POST', 'devices?on_conflict=pass_id,device_id_hash', {
    body: { pass_id: pass.id, device_id_hash: h },
    prefer: 'resolution=ignore-duplicates,return=minimal',
  });
  return { ok: true, counted: true };
}

export async function addSupportMessage(row) {
  await rest('POST', 'support_messages', { body: row, prefer: 'return=minimal' });
}

// A short, safe description of an error for the logs. Never includes env values.
export function safeErr(e) {
  if (!e) return 'unknown';
  const kind = e.type || e.name || 'Error';
  const msg = String(e.message || '').replace(/(sk|rk|pk|whsec|re|sb_secret)_[A-Za-z0-9_]+/g, '[key]').slice(0, 140);
  return kind + (msg ? ': ' + msg : '');
}
