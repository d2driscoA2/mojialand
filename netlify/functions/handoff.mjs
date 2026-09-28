// Home Screen handoff. An iPhone Home Screen web app has its own storage, so a
// pass bought in Safari is invisible there. Safari parks the signed pass token
// here for 30 minutes under a scrambled key (network address plus browser
// type). The Home Screen app claims it on its first open.
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

// Same phone, same browser family. The user agent of Safari and of a Home
// Screen app differ, so only the iOS version and device family are kept.
function handoffKey(event) {
  const ua = String(header(event, 'user-agent') || '');
  const family = (/\((iPhone|iPad|Macintosh|Android|Linux|Windows)[^)]*\)/.exec(ua) || [])[1] || 'other';
  const os = (/OS (\d+_\d+)/.exec(ua) || /Android (\d+)/.exec(ua) || [])[1] || '';
  const pepper = process.env.ADMIN_PEPPER || process.env.RESTORE_CODE_PEPPER || '';
  return sha256hex(pepper + ':handoff:' + clientIp(event) + ':' + family + ':' + os);
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
        body: { key_hash: handoffKey(event), token, code, expires_at: new Date(Date.now() + MINUTES * 60e3).toISOString() },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      return json(200, { ok: true });
    }
    if (input.action === 'claim') {
      const key = handoffKey(event);
      const { data } = await rest('GET', 'handoffs?key_hash=eq.' + enc(key) + '&select=*&limit=1');
      const row = Array.isArray(data) && data[0];
      if (!row || new Date(row.expires_at).getTime() < Date.now()) return fail(404, 'Nothing waiting.');
      const payload = verifyToken(row.token, jwk);
      if (!payload) { await rest('DELETE', 'handoffs?key_hash=eq.' + enc(key)); return fail(404, 'Nothing waiting.'); }
      await rest('DELETE', 'handoffs?key_hash=eq.' + enc(key));
      const pass = payload.p ? await getPassBy('id', payload.p) : null;
      if (pass && DEVICE_RE.test(String(input.device_id || ''))) {
        try { await addDevice(pass, input.device_id); } catch (e) { console.error('handoff: device count failed (' + safeErr(e) + ')'); }
      }
      console.log('handoff: claimed');
      return json(200, { code: row.code || '', kind: payload.k, ends_at: payload.e, token: row.token, email_masked: '' });
    }
    return fail(400, 'Unknown action.');
  } catch (e) {
    console.error('handoff: failed (' + safeErr(e) + ')');
    return fail(500, 'Try again in a minute.');
  }
};
