// POST {code, device_id} -> {code, kind, ends_at, token, email_masked}
// Turns a pass on for one more device. Used by the email button (/r/CODE)
// and by "Have a code?" in Grown-ups. Codes are looked up by hash only.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, maskEmail, tail6 } from './_lib/http.mjs';
import { rateHit, getPassBy, patchPass, addDevice, safeErr, DEVICE_RE, rest } from './_lib/db.mjs';
import { sha256hex } from './_lib/http.mjs';
import { FRIEND_BATCH } from './_lib/friend.mjs';
import { normalizeCode, codeHash } from './_lib/codes.mjs';
import { makeTokenPayload, signToken } from './_lib/token.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { campaignHit, LABEL_RE } from './_lib/analytics.mjs';
import { notify } from './_lib/push.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY', 'STRIPE_SECRET_KEY'];
const PROMO_RE = /^[A-Za-z0-9_-]{2,40}$/;
const HOUR = 3600e3;
const NOT_FOUND = 'We could not find that code. Check each letter and try again.';

export const handler = async (event) => {
  const stop = guard('redeem-code', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  const input = readJson(event);
  const raw = String((input && input.code) || '').trim();
  const code = normalizeCode(raw);
  const device = input && input.device_id;
  // Not a pass code: maybe a Stripe promotion code (a discount at checkout).
  if (!code) {
    if (!PROMO_RE.test(raw)) return fail(400, NOT_FOUND);
    if (!(await rateHit('redeem-promo', clientIp(event), 10, 60))) return fail(429, 'Too many tries. Please wait a few minutes.');
    try {
      const list = await getStripe().promotionCodes.list({ code: raw, active: true, limit: 1, expand: ['data.coupon'] });
      const pc = list && list.data && list.data[0];
      const c = pc && pc.coupon;
      if (!pc || !c || c.valid === false) return fail(404, NOT_FOUND);
      return json(200, { discount: { code: pc.code, percent_off: c.percent_off || null, amount_off: c.amount_off || null, name: c.name || '' } });
    } catch (e) {
      console.error('redeem-code: promo lookup failed (' + safeErr(e) + ')');
      return fail(500, 'We could not check that code. Please try again in a minute.');
    }
  }
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
      if (pass.use_by && new Date(pass.use_by).getTime() < Date.now()) return fail(410, pass.batch === FRIEND_BATCH ? 'This friend pass has expired. Friend passes work for 30 days.' : 'This gift code has expired.');
      // Friend passes are for families new to Mojialand: never on a device that had a pass.
      if (pass.batch === FRIEND_BATCH) {
        const h = sha256hex((process.env.RESTORE_CODE_PEPPER || '') + ':dev:' + device);
        const { data: seen } = await rest('GET', 'devices?device_id_hash=eq.' + h + '&select=id&limit=1');
        if (Array.isArray(seen) && seen.length) return fail(403, 'Friend passes are for families new to Mojialand. This device had a pass before, so please share this one with a new friend.');
      }
      // Gift and support codes start on first use.
      const now = Date.now();
      const rows = await patchPass('id=eq.' + encodeURIComponent(pass.id) + '&status=eq.unused', {
        status: 'active',
        starts_at: new Date(now).toISOString(),
        ends_at: pass.kind === 'forever' ? null : new Date(now + 48 * HOUR).toISOString(),
      });
      pass = rows[0] || (await getPassBy('id', pass.id));
      // First use of a gift code from a QR campaign counts toward that event.
      if (rows[0] && pass.source === 'gift' && typeof input.camp === 'string' && LABEL_RE.test(input.camp)) await campaignHit(input.camp, 'gift');
      // Phone alert for the admin: which batch, never who (Release 1.1 #23).
      if (rows[0] && pass.source === 'gift') await notify('gift', pass.batch || '');
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
    console.log('redeem-code: pass ' + tail6(pass.id) + ' on a device');
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
