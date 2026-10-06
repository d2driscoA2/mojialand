// POST {session_id, device_id?} -> {code, kind, ends_at, token, email_masked, plan}
// Never trusts the browser: asks Stripe whether the session is paid.
// Paid but our side failed -> 202 {status:'paid_pending'}. The page then gives
// free minutes and keeps retrying; the webhook also retries the grant.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, maskEmail, tail6 } from './_lib/http.mjs';
import { rateHit, addDevice, safeErr, DEVICE_RE } from './_lib/db.mjs';
import { grantPass, isPaid } from './_lib/grant.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { makeTokenPayload, signToken } from './_lib/token.mjs';

const REQUIRED = [
  'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY',
];
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;
// Release 1.1.1 #40 (Danny, October 1): a checkout link works for 7 days, the
// same as the game's payment retry. Later restores use the code link.
export const CHECKOUT_DAYS = 7;
export const LIMIT_MSG = 'This pass is on 5 devices already. Contact us to move it to a new device.';
export const OLD_MSG = 'This payment link is more than 7 days old. Tap the button in your pass email, or type your code under Grown-ups, Have a code?';

export const handler = async (event) => {
  const stop = guard('confirm-session', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  const input = readJson(event);
  const sid = input && input.session_id;
  if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return fail(400, 'That payment link is not valid.');
  if (!DEVICE_RE.test(String(input.device_id || ''))) return fail(400, 'This device could not be checked. Reload the page and try again.');

  if (!(await rateHit('confirm-session', clientIp(event), 20, 60, { failOpen: true }))) {
    return fail(429, 'Too many tries. Please wait a minute.');
  }

  try {
    let session;
    try {
      session = await getStripe().checkout.sessions.retrieve(sid);
    } catch (e) {
      if (e && e.statusCode === 404) return fail(404, 'We could not find that payment.');
      throw e;
    }
    if (session.metadata && session.metadata.env && session.metadata.env !== envName()) {
      return fail(400, 'That payment link is not valid.');
    }
    if (!isPaid(session)) return json(402, { status: 'pending' });
    if (Number(session.created) && Date.now() - Number(session.created) * 1000 > CHECKOUT_DAYS * 86400e3) return fail(410, OLD_MSG);

    let granted;
    try {
      granted = await grantPass(session);
    } catch (e) {
      if (e && e.code === 'used') return fail(410, OLD_MSG);
      console.error('confirm-session: grant failed for ' + tail6(session.id) + ' (' + safeErr(e) + ')');
      return json(202, { status: 'paid_pending' });
    }
    const { plan, pass, code } = granted;
    if (pass.status !== 'active') return fail(409, 'This pass is not active. Please contact us.');
    let dev;
    try {
      dev = await addDevice(pass, input.device_id);
    } catch (e) {
      console.error('confirm-session: device count failed (' + safeErr(e) + ')');
      return json(202, { status: 'paid_pending' });
    }
    if (!dev.ok) return fail(403, LIMIT_MSG);
    const payload = makeTokenPayload(pass, envName());
    const token = signToken(payload, process.env.PASS_SIGNING_PRIVATE_KEY);
    console.log('confirm-session: session ' + tail6(session.id));
    return json(200, {
      code,
      kind: payload.k,
      ends_at: payload.e,
      token,
      email_masked: maskEmail(pass.email || (session.customer_details && session.customer_details.email)),
      plan,
    });
  } catch (e) {
    console.error('confirm-session: failed for ' + tail6(sid) + ' (' + safeErr(e) + ')');
    return fail(500, 'We could not turn your pass on yet. Please try again.');
  }
};
