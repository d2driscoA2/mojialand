// Stripe webhook. Verifies the signature on the raw body, handles each event once.
import { guard } from './_lib/env.mjs';
import { json, fail, header, rawBody, originFromUrl, tail6 } from './_lib/http.mjs';
import { claimEvent, releaseEvent, patchPass, safeErr } from './_lib/db.mjs';
import { grantPass, isPaid } from './_lib/grant.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { buildEmail, sendEmail } from './_lib/email.mjs';
import { campaignHit } from './_lib/analytics.mjs';
import { friendPass } from './_lib/friend.mjs';

const REQUIRED = [
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER',
];
const enc = encodeURIComponent;

async function sessionForPaymentIntent(pi) {
  const id = typeof pi === 'string' ? pi : pi && pi.id;
  if (!id) return null;
  const list = await getStripe().checkout.sessions.list({ payment_intent: id, limit: 1 });
  return (list && list.data && list.data[0]) || null;
}

// Sends the code email once per purchase.
async function emailOnce(session, result) {
  const to = result.pass.email || (session.customer_details && session.customer_details.email);
  if (!to) return;
  const origin = originFromUrl(session.return_url);
  let release;
  if (result.plan === 'pass' || result.plan === 'life') {
    const rows = await patchPass('id=eq.' + enc(result.pass.id) + '&emailed_at=is.null', { emailed_at: new Date().toISOString() });
    if (!rows.length) return; // already sent
    release = () => patchPass('id=eq.' + enc(result.pass.id), { emailed_at: null });
  } else {
    if (!(await claimEvent('email:' + session.id, session.id))) return;
    release = () => releaseEvent('email:' + session.id);
  }
  try {
    const friend = (result.plan === 'pass' || result.plan === 'life') ? await friendPass(result.pass).catch(() => null) : null;
    await sendEmail(to, buildEmail({ plan: result.plan, pass: result.pass, code: result.code, origin, friend }));
  } catch (e) {
    await release().catch(() => {});
    throw e;
  }
}

async function setStatusForCharge(charge, status) {
  const session = await sessionForPaymentIntent(charge.payment_intent);
  if (!session) {
    console.log('stripe-webhook: no checkout session for charge');
    return;
  }
  const plan = session.metadata && session.metadata.plan;
  if (plan === 'add' || plan === 'up') {
    // The pass was bought earlier; flag it for the admin instead of ending it.
    const note = status + ' on ' + plan + ' session ' + session.id;
    await patchPass('id=eq.' + enc(session.metadata.pass_id), status === 'disputed' ? { status, note } : { note });
  } else {
    await patchPass('stripe_session_id=eq.' + enc(session.id), { status });
  }
  console.log('stripe-webhook: ' + status + ' for session ' + tail6(session.id));
}

export const handler = async (event) => {
  const stop = guard('stripe-webhook', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  let evt;
  try {
    evt = getStripe().webhooks.constructEvent(rawBody(event), header(event, 'stripe-signature') || '', process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    console.log('stripe-webhook: bad signature');
    return fail(400, 'Bad signature.');
  }

  const obj = evt.data && evt.data.object;
  try {
    if (!(await claimEvent(evt.id, obj && obj.object === 'checkout.session' ? obj.id : null))) {
      return json(200, { received: true, duplicate: true });
    }
  } catch {
    console.error('stripe-webhook: could not record ' + tail6(evt.id));
    return fail(500, 'Try again.');
  }

  try {
    if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
      if (isPaid(obj)) {
        let result;
        try { result = await grantPass(obj); } catch (e) {
          if (e && e.code === 'used') { console.log('stripe-webhook: checkout granted before, nothing new (' + tail6(evt.id) + ')'); return json(200, { received: true, used: true }); }
          throw e;
        }
        console.log('stripe-webhook: granted for session ' + tail6(obj.id) + ' (' + tail6(evt.id) + ')');
        await emailOnce(obj, result);
        const md = obj.metadata || {};
        if (md.camp) await campaignHit(md.camp, md.plan === 'life' || md.plan === 'up' ? 'forever' : 'pass48', {}, md.camp_days);
      }
    } else if (evt.type === 'charge.refunded') {
      if (obj.refunded) await setStatusForCharge(obj, 'refunded');
      else console.log('stripe-webhook: partial refund ' + tail6(evt.id));
    } else if (evt.type === 'charge.dispute.created') {
      await setStatusForCharge({ payment_intent: obj.payment_intent }, 'disputed');
    }
    return json(200, { received: true });
  } catch (e) {
    console.error('stripe-webhook: failed ' + tail6(evt.id) + ' (' + safeErr(e) + ')');
    await releaseEvent(evt.id); // Stripe retries; grantPass is idempotent
    return fail(500, 'Try again.');
  }
};
