// POST {token, device_id} -> {state:'on', kind, ends_at, token} or {state:'off', reason}
// Release 1.1.1 #28 with #42 (audit M4). The game asks at most once an hour,
// when it opens or returns to the front. It sends only what it already sends
// today: the signed pass token and the device id. The answer carries a fresh
// signed copy of the pass, so Add 48 hours and Forever from admin reach the
// device, and End, Refund and chargebacks turn the pass off.
// An expired Forever token (x passed) still identifies its pass, so a device
// offline for more than 30 days turns back on at its next check.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp } from './_lib/http.mjs';
import { rateHit, getPassBy, addDevice, safeErr, DEVICE_RE } from './_lib/db.mjs';
import { verifyToken, makeTokenPayload, signToken } from './_lib/token.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY', 'PASS_SIGNING_PUBLIC_JWK'];
const UUID = /^[0-9a-f-]{36}$/i;

export const handler = async (event) => {
  const stop = guard('pass-check', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  const input = readJson(event) || {};
  let jwk;
  try { jwk = JSON.parse(process.env.PASS_SIGNING_PUBLIC_JWK); } catch { return fail(500, 'Not set up.'); }
  const p = verifyToken(input.token, jwk);
  if (!p || p.env !== envName() || !UUID.test(String(p.p || ''))) return fail(403, 'This pass could not be checked.');
  if (!DEVICE_RE.test(String(input.device_id || ''))) return fail(400, 'This device could not be checked.');
  if (!(await rateHit('pass-check', clientIp(event), 60, 3600, { failOpen: true }))) return fail(429, 'Too many checks.');
  try {
    const pass = await getPassBy('id', p.p);
    if (!pass) return json(200, { state: 'off', reason: 'gone' });
    if (pass.status === 'refunded' || pass.status === 'disputed') return json(200, { state: 'off', reason: pass.status });
    const ended = pass.status === 'ended' || (pass.kind !== 'forever' && (!pass.ends_at || new Date(pass.ends_at).getTime() <= Date.now()));
    if (pass.status !== 'active' || ended) {
      return json(200, { state: 'off', reason: 'ended', ends_at: pass.ends_at ? new Date(pass.ends_at).getTime() : 0 });
    }
    const dev = await addDevice(pass, input.device_id);
    if (!dev.ok) return json(200, { state: 'off', reason: 'devices' });
    const payload = makeTokenPayload(pass, envName());
    return json(200, { state: 'on', kind: payload.k, ends_at: payload.e, token: signToken(payload, process.env.PASS_SIGNING_PRIVATE_KEY) });
  } catch (e) {
    console.error('pass-check: failed (' + safeErr(e) + ')');
    return fail(500, 'Try again later.');
  }
};
