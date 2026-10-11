// POST {token?, device_id, fv_end?} -> {gifts:[{code, link, state, use_by}], reward_days, cap, kind, token?}
// Release 1.4 #32 (Danny, October 6 and 11): every family gets 3 gifts of 7 free days.
// Called only after a grown-up taps Give a friend (behind the number check).
// With a pass token: the gifts belong to that pass.
// Without one (a family in its free week): the server makes one gift holder pass
// for this device, only on this tap. The holder has no email, no name and no
// child data: a random ID, kind holder, the free week end, and reward days.
// One holder per device. Its signed token comes back so the device can carry
// reward days and pick up new time through the normal pass check.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, header, originFromHost, sha256hex } from './_lib/http.mjs';
import { rateHit, getPassBy, addDevice, safeErr, DEVICE_RE, rest, switchOn } from './_lib/db.mjs';
import { verifyToken, makeTokenPayload, signToken } from './_lib/token.mjs';
import { gifts, givesGifts } from './_lib/friend.mjs';
import { randomCode, codeHash, codeLast4 } from './_lib/codes.mjs';
import { freeWeekEnd } from './_lib/kinds.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY', 'PASS_SIGNING_PUBLIC_JWK'];
const UUID = /^[0-9a-f-]{36}$/i;

async function holderForDevice(device) {
  const h = sha256hex((process.env.RESTORE_CODE_PEPPER || '') + ':dev:' + device);
  const { data } = await rest('GET', 'devices?device_id_hash=eq.' + h + '&select=pass_id&limit=20');
  const ids = (Array.isArray(data) ? data : []).map((d) => d.pass_id).filter((x) => UUID.test(String(x)));
  if (!ids.length) return null;
  const { data: rows } = await rest('GET', 'passes?id=in.(' + ids.join(',') + ')&kind=eq.holder&select=*&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function newHolder(device, fvEnd) {
  const pepper = process.env.RESTORE_CODE_PEPPER;
  const code = randomCode('MOJI'); // never shown or stored; the row needs a unique hash
  const now = Date.now();
  const { data } = await rest('POST', 'passes', {
    body: {
      code_hash: codeHash(pepper, code), code_last4: codeLast4(code), prefix: 'MOJI', kind: 'holder', source: 'free',
      status: 'active', starts_at: new Date(now).toISOString(), ends_at: new Date(freeWeekEnd(fvEnd, now)).toISOString(),
      device_limit: 1, gen: 0, note: 'gift holder (free week)',
    },
    prefer: 'return=representation',
  });
  const row = Array.isArray(data) && data[0];
  if (!row) throw new Error('holder insert failed');
  await addDevice(row, device);
  return row;
}

export const handler = async (event) => {
  const stop = guard('gifts', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  const input = readJson(event) || {};
  if (!DEVICE_RE.test(String(input.device_id || ''))) return fail(400, 'This device could not be checked.');
  if (!(await rateHit('gifts', clientIp(event), 30, 3600))) return fail(429, 'Too many tries. Please wait a few minutes.');
  let jwk;
  try { jwk = JSON.parse(process.env.PASS_SIGNING_PUBLIC_JWK); } catch { return fail(500, 'Not set up.'); }
  try {
    let pass = null, issue = false;
    if (input.token) {
      const p = verifyToken(input.token, jwk);
      if (!p || p.env !== envName() || !UUID.test(String(p.p || ''))) return fail(403, 'This pass could not be checked. Open Mojialand again and try once more.');
      pass = await getPassBy('id', p.p);
      if (!pass) return fail(410, 'This pass has no gifts to give.');
    } else {
      pass = await holderForDevice(input.device_id);
      if (!pass && (await switchOn('new_free_paused'))) return fail(503, 'Gifts are paused for a little while. Please try again later.');
      if (!pass) pass = await newHolder(input.device_id, input.fv_end);
      issue = true;
    }
    if (!givesGifts(pass)) return fail(410, 'This pass has no gifts to give.');
    // Release 1.4 #14: new gifts paused during a spike (gifts already made keep working).
    if (await switchOn('new_free_paused')) {
      const { data } = await rest('GET', 'passes?giver_id=eq.' + pass.id + '&select=id&limit=1');
      if (!Array.isArray(data) || !data.length) return fail(503, 'Gifts are paused for a little while. Please try again later.');
    }
    const g = await gifts(pass);
    if (!g) return fail(410, 'This pass has no gifts to give.');
    const origin = originFromHost(header(event, 'host'));
    const out = {
      kind: pass.kind,
      reward_days: g.reward_days,
      cap: g.cap,
      gifts: g.gifts.map((x) => ({ code: x.code, link: origin + x.path, state: x.state, use_by: x.use_by })),
    };
    if (issue || pass.kind === 'holder') {
      out.token = signToken(makeTokenPayload(pass, envName()), process.env.PASS_SIGNING_PRIVATE_KEY);
      out.ends_at = pass.ends_at ? new Date(pass.ends_at).getTime() : 0;
    }
    console.log('gifts: shown for a ' + pass.kind + ' pass');
    return json(200, out);
  } catch (e) {
    console.error('gifts: failed (' + safeErr(e) + ')');
    return fail(500, 'We could not get the gifts. Please try again in a minute.');
  }
};

export const config = { path: '/api/gifts' };
