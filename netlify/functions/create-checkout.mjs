// POST {plan, code?, promo?} -> {clientSecret, publishableKey}
// Prices come only from environment Price IDs. Never from the browser.
import { guard, envName } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, header, originFromHost, tail6 } from './_lib/http.mjs';
import { rateHit, getPassBy, getSetting } from './_lib/db.mjs';
import { codeHash } from './_lib/codes.mjs';
import { getStripe, PLANS } from './_lib/stripe.mjs';
import { LABEL_RE } from './_lib/analytics.mjs';
import { refuseBlocked } from './_lib/blocked.mjs';

const REQUIRED = [
  'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_PRICE_PASS_30D', 'STRIPE_PRICE_FOREVER', 'STRIPE_PRICE_UPGRADE', 'STRIPE_PRICE_UPGRADE_48H',
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER',
];
const DAY = 864e5;
const CANT_CHANGE = "That pass can't be changed. Pick a new pass.";
// Release 1.4 #14: when Stripe or the database is busy, the parent sees one calm line.
const TRY_AGAIN = 'Busy, try again soon.';

export const handler = async (event) => {
  const stop = guard('create-checkout', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  // Release 1.5 #66: blocked countries get 451 before anything else runs.
  const blocked = await refuseBlocked(event, 'create-checkout');
  if (blocked) return blocked;

  const input = readJson(event);
  const plan = input && input.plan;
  if (typeof plan !== 'string' || !Object.hasOwn(PLANS, plan)) return fail(400, 'Pick a pass.');

  if (!(await rateHit('create-checkout', clientIp(event), 5, 60))) {
    return fail(429, 'Busy, try again soon.');
  }

  try {
    const metadata = { plan, env: envName() };
    // Campaign credit: the event label from a QR card, and days since that open. No person is named.
    const camp = input.camp;
    if (camp && typeof camp === 'object' && typeof camp.l === 'string' && LABEL_RE.test(camp.l)) {
      const d = Number(camp.d);
      metadata.camp = camp.l;
      metadata.camp_days = String(Number.isFinite(d) && d >= 0 && d <= 7 ? Math.round(d * 10) / 10 : 0);
    }
    // Release 1.4 #58: the device started from a gift (yes or no only, for the Gifts tab count).
    if (input.from_gift === true) metadata.from_gift = '1';

    let priceEnv = PLANS[plan].env;
    if (plan === 'add' || plan === 'up') {
      const hash = typeof input.code === 'string' ? codeHash(process.env.RESTORE_CODE_PEPPER, input.code) : null;
      if (!hash) return fail(400, CANT_CHANGE);
      const pass = await getPassBy('code_hash', hash);
      const now = Date.now();
      const ends = pass && pass.ends_at ? new Date(pass.ends_at).getTime() : 0;
      let ok = false;
      if (pass && (pass.kind === '30d' || pass.kind === '48h')) {
        if (plan === 'add') ok = pass.status === 'active' && ends > now;
        else {
          const creditDays = await getSetting('credit_days', 7);
          ok = (pass.status === 'active' || pass.status === 'ended') && ends > 0 && now - ends <= creditDays * DAY;
        }
      }
      if (!ok) return fail(400, CANT_CHANGE);
      metadata.pass_id = pass.id;
      // Release 1.4 (Danny, October 12, choice B): Forever after an old 48-hour pass stays $13.49.
      if (plan === 'up' && pass.kind === '48h') priceEnv = 'STRIPE_PRICE_UPGRADE_48H';
    }

    const stripe = getStripe();
    const params = {
      mode: 'payment',
      ui_mode: 'embedded_page',
      line_items: [{ price: process.env[priceEnv], quantity: 1 }],
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
    console.log('create-checkout: session ' + tail6(session.id));
    return json(200, { clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
  } catch (e) {
    console.error('create-checkout: failed (' + (e && (e.type || e.name)) + ')');
    return fail(502, TRY_AGAIN);
  }
};
