// Home Screen handoff with a pairing number (Release 1.1.1 #39, audit M1).
// An iPhone Home Screen web app has its own storage, so a pass bought in
// Safari is invisible there. Safari parks the signed pass token for 30 minutes
// with a 4-digit pairing number and shows the number in Grown-ups. The Home
// Screen app on the same phone asks the grown-up to type it.
// POST {action:'offer', token, traits}           -> {pin, expires_at}
// POST {action:'claim', traits, pin, device_id}  -> {kind, ends_at, token}
//   404 nothing waiting, 401 {left} wrong number, 403 pass full or off.
// A claim never returns the pass code. Nothing stores a plain code or number.
import crypto from 'node:crypto';
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, header, sha256hex } from './_lib/http.mjs';
import { rest, rateHit, getPassBy, addDevice, safeErr, DEVICE_RE } from './_lib/db.mjs';
import { verifyToken, makeTokenPayload, signToken } from './_lib/token.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY', 'PASS_SIGNING_PUBLIC_JWK'];
const MINUTES = 30;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,1500}\.[A-Za-z0-9_-]{80,100}$/;
const PIN_RE = /^\d{4}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const pepper = () => process.env.ADMIN_PEPPER || process.env.RESTORE_CODE_PEPPER || '';

// Same phone: device family and OS version from the user agent, plus traits
// the page reports (screen size, pixel ratio, time zone, language, cores).
// No network address: Safari and a Home Screen app on one iPhone often use
// different addresses (iCloud Private Relay, cellular rotation).
function handoffKey(event, traits) {
  const ua = String(header(event, 'user-agent') || '');
  const family = (/\((iPhone|iPad|Macintosh|Android|Linux|Windows)[^)]*\)/.exec(ua) || [])[1] || 'other';
  const os = (/OS (\d+_\d+)/.exec(ua) || /Android (\d+)/.exec(ua) || [])[1] || '';
  const t = String(traits || '').slice(0, 120);
  return sha256hex(pepper() + ':handoff:' + family + ':' + os + ':' + t);
}
const pinHash = (key, pin) => sha256hex(pepper() + ':pair:' + key + ':' + pin);
const passOn = (p) => p && p.status === 'active' && (p.kind === 'forever' || (p.ends_at && new Date(p.ends_at).getTime() > Date.now()));

export const handler = async (event) => {
  const stop = guard('handoff', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  const input = readJson(event) || {};
  const ip = clientIp(event);
  let jwk;
  try { jwk = JSON.parse(process.env.PASS_SIGNING_PUBLIC_JWK); } catch { return fail(500, 'Not set up.'); }

  try {
    if (input.action === 'offer') {
      if (!(await rateHit('handoff-offer', ip, 30, 3600))) return fail(429, 'Too many tries.');
      const token = String(input.token || '');
      const p = TOKEN_RE.test(token) && verifyToken(token, jwk);
      if (!p || p.env !== envName()) return fail(400, 'Bad token.');
      const key = handoffKey(event, input.traits);
      const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const expires = new Date(Date.now() + MINUTES * 60e3).toISOString();
      await rest('POST', 'pairings', { body: { key_hash: key, pin_hash: pinHash(key, pin), token, expires_at: expires }, prefer: 'return=minimal' });
      return json(200, { pin, expires_at: expires });
    }
    if (input.action === 'claim') {
      if (!(await rateHit('handoff-claim', ip, 20, 3600))) return fail(429, 'Too many tries. Please wait an hour.');
      const pin = String(input.pin || '').replace(/\s/g, '');
      if (!PIN_RE.test(pin)) return fail(400, 'Type the 4 numbers Safari shows.');
      if (!DEVICE_RE.test(String(input.device_id || ''))) return fail(400, 'This device could not be checked.');
      const key = handoffKey(event, input.traits);
      const { data } = await rest('POST', 'rpc/pair_claim', { body: { p_key: key, p_pin_hash: pinHash(key, pin) } });
      const res = String(data || 'none');
      if (res === 'none') return fail(404, 'No pairing number is waiting.');
      if (res.startsWith('bad:')) return json(401, { error: 'That number did not match.', left: Number(res.slice(4)) || 0 });
      const payload = verifyToken(res, jwk);
      const pass = payload && UUID.test(String(payload.p || '')) ? await getPassBy('id', payload.p) : null;
      if (!passOn(pass)) return fail(403, 'This pass is not on any more.');
      const dev = await addDevice(pass, input.device_id);
      if (!dev.ok) return fail(403, 'This pass is on 5 devices already. Contact us to move it to a new device.');
      const fresh = makeTokenPayload(pass, envName());
      console.log('handoff: paired');
      return json(200, { kind: fresh.k, ends_at: fresh.e, token: signToken(fresh, process.env.PASS_SIGNING_PRIVATE_KEY) });
    }
    return fail(400, 'Unknown action.');
  } catch (e) {
    console.error('handoff: failed (' + safeErr(e) + ')');
    return fail(500, 'Try again in a minute.');
  }
};
