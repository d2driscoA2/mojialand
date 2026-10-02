// Home Screen handoff. An iPhone Home Screen web app has its own storage, so a
// pass bought in Safari is invisible there. Safari parks the signed pass token
// here for 30 minutes under a scrambled key made from device traits both
// share. The Home Screen app claims it on its first open.
// POST {action:'offer', token, code?} -> {ok}
// POST {action:'claim', device_id}   -> {code, kind, ends_at, token, email_masked} or 404
import { guard } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, header, sha256hex } from './_lib/http.mjs';
import { rest, rateHit, getPassBy, addDevice, safeErr, DEVICE_RE } from './_lib/db.mjs';
import { verifyToken } from './_lib/token.mjs';
import { normalizeCode } from './_lib/codes.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PUBLIC_JWK'];
const MINUTES = 30;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,1500}\.[A-Za-z0-9_-]{80,100}$/;
const enc = encodeURIComponent;

// Same phone: device family and OS version from the user agent, plus traits
// the page reports (screen size, pixel ratio, time zone, language, cores).
// No network address: Safari and a Home Screen app on one iPhone often use
// different addresses (iCloud Private Relay, cellular rotation).
function handoffKey(event, traits) {
  const ua = String(header(event, 'user-agent') || '');
  const family = (/\((iPhone|iPad|Macintosh|Android|Linux|Windows)[^)]*\)/.exec(ua) || [])[1] || 'other';
  const os = (/OS (\d+_\d+)/.exec(ua) || /Android (\d+)/.exec(ua) || [])[1] || '';
  const t = String(traits || '').slice(0, 120);
  const pepper = process.env.ADMIN_PEPPER || process.env.RESTORE_CODE_PEPPER || '';
  return sha256hex(pepper + ':handoff:' + family + ':' + os + ':' + t);
}

export const handler = async (event) => {
  const stop = guard('handoff', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  const input = readJson(event) || {};
  const ip = clientIp(event);
  if (!(await rateHit('handoff', ip, 30, 3600))) return fail(429, 'Too many tries.');
  let jwk;
  try { jwk = JSON.parse(process.env.PASS_SIGNING_PUBLIC_JWK); } catch { return fail(500, 'Not set up.'); }

  try {
    if (input.action === 'offer') {
      const token = String(input.token || '');
      if (!TOKEN_RE.test(token) || !verifyToken(token, jwk)) return fail(400, 'Bad token.');
      const code = normalizeCode(input.code) || null;
      await rest('POST', 'handoffs?on_conflict=key_hash', {
        body: { key_hash: handoffKey(event, input.traits), token, code, expires_at: new Date(Date.now() + MINUTES * 60e3).toISOString() },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      return json(200, { ok: true });
    }
    if (input.action === 'claim') {
      const key = handoffKey(event, input.traits);
      const { data } = await rest('GET', 'handoffs?key_hash=eq.' + enc(key) + '&select=*&limit=1');
      const row = Array.isArray(data) && data[0];
      if (!row || new Date(row.expires_at).getTime() < Date.now()) return fail(404, 'Nothing waiting.');
      const payload = verifyToken(row.token, jwk);
      if (!payload) { await rest('DELETE', 'handoffs?key_hash=eq.' + enc(key)); return fail(404, 'Nothing waiting.'); }
      // Release 1.1.1 #40 (audit M2): a claim counts the device and stops at the limit.
      if (!DEVICE_RE.test(String(input.device_id || ''))) return fail(400, 'This device could not be checked.');
      const pass = payload.p ? await getPassBy('id', payload.p) : null;
      if (!pass) return fail(404, 'Nothing waiting.');
      const dev = await addDevice(pass, input.device_id);
      if (!dev.ok) return fail(403, 'This pass is on 5 devices already. Contact us to move it to a new device.');
      await rest('DELETE', 'handoffs?key_hash=eq.' + enc(key));
      console.log('handoff: claimed');
      return json(200, { code: row.code || '', kind: payload.k, ends_at: payload.e, token: row.token, email_masked: '' });
    }
    return fail(400, 'Unknown action.');
  } catch (e) {
    console.error('handoff: failed (' + safeErr(e) + ')');
    return fail(500, 'Try again in a minute.');
  }
};
