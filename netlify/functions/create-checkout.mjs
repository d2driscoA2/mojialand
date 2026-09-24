// POST {plan, code?, promo?} -> {clientSecret, publishableKey}
// Prices come only from environment Price IDs. Never from the browser.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, header, originFromHost } from './_lib/http.mjs';
import { rateHit, getPassBy, getSetting } from './_lib/db.mjs';
import { codeHash } from './_lib/codes.mjs';
import { getStripe, PLANS } from './_lib/stripe.mjs';

const REQUIRED = [
  'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_PRICE_PASS_48H', 'STRIPE_PRICE_FOREVER', 'STRIPE_PRICE_UPGRADE',
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER',
];
const DAY = 864e5;
const CANT_CHANGE = "That pass can't be changed. Pick a new pass.";
const TRY_AGAIN = 'Checkout could not start. Please try again.';

export const handler = async (event) => {
  const stop = guard('create-checkout', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  const input = readJson(event);
  const plan = input && input.plan;
  if (typeof plan !== 'string' || !Object.hasOwn(PLANS, plan)) return fail(400, 'Pick a pass.');

  if (!(await rateHit('create-checkout', clientIp(event), 5, 60))) {
    return fail(429, 'Too many tries. Please wait a minute.');
  }

  try {
    const metadata = { plan, env: envName() };

    if (plan === 'add' || plan === 'up') {
      const hash = typeof input.code === 'string' ? codeHash(process.env.RESTORE_CODE_PEPPER, input.code) : null;
      if (!hash) return fail(400, CANT_CHANGE);
      const pass = await getPassBy('code_hash', hash);
      const now = Date.now();
      const ends = pass && pass.ends_at ? new Date(pass.ends_at).getTime() : 0;
      let ok = false;
      if (pass && pass.kind === '48h') {
        if (plan === 'add') ok = pass.status === 'active' && ends > now;
        else {
          const creditDays = await getSetting('credit_days', 7);
          ok = (pass.status === 'active' || pass.status === 'ended') && ends > 0 && now - ends <= creditDays * DAY;
        }
      }
      if (!ok) return fail(400, CANT_CHANGE);
      metadata.pass_id = pass.id;
    }

    const stripe = getStripe();
    const params = {
      mode: 'payment',
      ui_mode: 'embedded_page',
      line_items: [{ price: process.env[PLANS[plan].env], quantity: 1 }],
      return_url: originFromHost(header(event, 'host')) + '/pass/done/?session_id={CHECKOUT_SESSION_ID}',
      payment_intent_data: { description: PLANS[plan].description, metadata },
      metadata,
    };

    const promo = input.promo;
    if (promo !== undefined && promo !== null && promo !== '') {
      if (typeof promo !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(promo)) return fail(400, "That discount code didn't work.");
      const found = await stripe.promotionCodes.list({ code: promo, active: true, limit: 1 });
      const pc = found && found.data && found.data[0];
      if (!pc) return fail(400, "That discount code didn't work.");
      params.discounts = [{ promotion_code: pc.id }];
    } else {
      params.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(params);
    console.log('create-checkout: session ' + session.id);
    return json(200, { clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
  } catch (e) {
    console.error('create-checkout: failed (' + (e && (e.type || e.name)) + ')');
    return fail(502, TRY_AGAIN);
  }
};
