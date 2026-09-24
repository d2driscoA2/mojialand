// POST {session_id} -> {code, kind, ends_at, token, email_masked, plan}
// Never trusts the browser: asks Stripe whether the session is paid.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, maskEmail } from './_lib/http.mjs';
import { rateHit } from './_lib/db.mjs';
import { grantPass } from './_lib/grant.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { makeTokenPayload, signToken } from './_lib/token.mjs';

const REQUIRED = [
  'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'RESTORE_CODE_PEPPER', 'PASS_SIGNING_PRIVATE_KEY',
];
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

export const handler = async (event) => {
  const stop = guard('confirm-session', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  const input = readJson(event);
  const sid = input && input.session_id;
  if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return fail(400, 'That payment link is not valid.');

  if (!(await rateHit('confirm-session', clientIp(event), 20, 60))) {
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
    if (session.payment_status !== 'paid') return json(402, { status: 'pending' });

    const { plan, pass, code } = await grantPass(session);
    if (pass.status !== 'active') return fail(409, 'This pass is not active. Please contact us.');
    const payload = makeTokenPayload(pass, envName());
    const token = signToken(payload, process.env.PASS_SIGNING_PRIVATE_KEY);
    console.log('confirm-session: session ' + session.id);
    return json(200, {
      code,
      kind: payload.k,
      ends_at: payload.e,
      token,
      email_masked: maskEmail(pass.email || (session.customer_details && session.customer_details.email)),
      plan,
    });
  } catch (e) {
    console.error('confirm-session: failed for ' + sid + ' (' + (e && (e.type || e.name)) + ')');
    return fail(500, 'We could not turn your pass on yet. Please try again.');
  }
};
