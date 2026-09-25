// POST {code, device_id} -> {code, kind, ends_at, token, email_masked}
// Turns a pass on for one more device. Used by the email button (/r/CODE)
// and by "Have a code?" in Grown-ups. Codes are looked up by hash only.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, maskEmail } from './_lib/http.mjs';
import { rateHit, getPassBy, patchPass, addDevice, safeErr, DEVICE_RE } from './_lib/db.mjs';
import { normalizeCode, codeHash } from './_lib/codes.mjs';
import { makeTokenPayload, signToken } from './_lib/token.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY'];
const HOUR = 3600e3;
const NOT_FOUND = 'We could not find that code. Check each letter and try again.';

export const handler = async (event) => {
  const stop = guard('redeem-code', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  const input = readJson(event);
  const code = normalizeCode(input && input.code);
  const device = input && input.device_id;
  if (!code) return fail(400, NOT_FOUND);
  if (typeof device !== 'string' || !DEVICE_RE.test(device)) return fail(400, 'This browser could not be counted. Please try again.');

  // Slow guessing: 10 tries a minute and 60 an hour per network.
  const ip = clientIp(event);
  if (!(await rateHit('redeem-code', ip, 10, 60)) || !(await rateHit('redeem-code-h', ip, 60, 3600))) {
    return fail(429, 'Too many tries. Please wait a few minutes.');
  }

  try {
    let pass = await getPassBy('code_hash', codeHash(process.env.RESTORE_CODE_PEPPER, code));
    if (!pass) return fail(404, NOT_FOUND);
    if (pass.status === 'refunded' || pass.status === 'disputed') {
      return fail(403, 'This code no longer works. Contact us if this looks wrong.');
    }
    if (pass.status === 'unused') {
      if (pass.use_by && new Date(pass.use_by).getTime() < Date.now()) return fail(410, 'This gift code has expired.');
      // Gift and support codes start on first use.
      const now = Date.now();
      const rows = await patchPass('id=eq.' + encodeURIComponent(pass.id) + '&status=eq.unused', {
        status: 'active',
        starts_at: new Date(now).toISOString(),
        ends_at: pass.kind === 'forever' ? null : new Date(now + 48 * HOUR).toISOString(),
      });
      pass = rows[0] || (await getPassBy('id', pass.id));
    }
    const ended = pass.kind !== 'forever' && pass.ends_at && new Date(pass.ends_at).getTime() <= Date.now();
    if (pass.status === 'ended' || ended) return fail(410, 'This 48-hour pass has ended. A grown-up can get a new pass in Mojialand.');
    if (pass.status !== 'active') return fail(403, 'This code does not work right now. Please contact us.');

    const dev = await addDevice(pass, device);
    if (!dev.ok) {
      return fail(409, 'This code is on ' + dev.limit + ' devices already. Contact us to move it to a new device.');
    }
    const payload = makeTokenPayload(pass, envName());
    const token = signToken(payload, process.env.PASS_SIGNING_PRIVATE_KEY);
    console.log('redeem-code: pass ' + pass.id + ' on a device');
    return json(200, {
      code,
      kind: payload.k,
      ends_at: payload.e,
      token,
      email_masked: maskEmail(pass.email),
    });
  } catch (e) {
    console.error('redeem-code: failed (' + safeErr(e) + ')');
    return fail(500, 'We could not turn the pass on yet. Please try again in a minute.');
  }
};
