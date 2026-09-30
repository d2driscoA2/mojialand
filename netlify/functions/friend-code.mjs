// POST {token} -> {code, link, use_by, state}
// Gives a pass holder their one friend pass. The signed pass token proves the
// caller holds the pass; nothing about the family is needed or stored.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, header, originFromHost } from './_lib/http.mjs';
import { rateHit, getPassBy, safeErr } from './_lib/db.mjs';
import { verifyToken } from './_lib/token.mjs';
import { friendPass } from './_lib/friend.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PUBLIC_JWK'];
const UUID = /^[0-9a-f-]{36}$/i;

export const handler = async (event) => {
  const stop = guard('friend-code', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  const input = readJson(event) || {};
  let jwk;
  try { jwk = JSON.parse(process.env.PASS_SIGNING_PUBLIC_JWK); } catch { return fail(500, 'Not set up.'); }
  const p = verifyToken(input.token, jwk);
  if (!p || p.env !== envName() || !UUID.test(String(p.p || ''))) return fail(403, 'This pass could not be checked. Open Mojialand again and try once more.');
  if (!(await rateHit('friend-code', clientIp(event), 20, 3600, { failOpen: true }))) return fail(429, 'Too many tries. Please wait a few minutes.');
  try {
    const parent = await getPassBy('id', p.p);
    const f = parent && (await friendPass(parent));
    if (!f) return fail(410, 'This pass has no friend pass to give.');
    console.log('friend-code: shown for a pass');
    return json(200, { code: f.code, link: originFromHost(header(event, 'host')) + f.path, use_by: f.use_by, state: f.state });
  } catch (e) {
    console.error('friend-code: failed (' + safeErr(e) + ')');
    return fail(500, 'We could not get the friend pass. Please try again in a minute.');
  }
};
