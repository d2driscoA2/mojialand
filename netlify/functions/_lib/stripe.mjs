// One Stripe client per function instance. Tests swap it with setStripe().
import Stripe from 'stripe';

let client = null;

export function getStripe() {
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 1, timeout: 15000 });
  return client;
}

export function setStripe(fake) {
  client = fake;
}

export const PLANS = {
  // Release 1.4 #32: the pass is 30 days ($4.99, STRIPE_PRICE_PASS_30D). STRIPE_PRICE_UPGRADE holds the $10.00 price;
  // STRIPE_PRICE_UPGRADE_48H holds $13.49 for Forever after an old 48-hour pass (create-checkout picks it).
  pass: { env: 'STRIPE_PRICE_PASS_30D', label: '30-day pass', description: 'Mojialand 30-day pass' },
  life: { env: 'STRIPE_PRICE_FOREVER', label: 'Forever', description: 'Mojialand Forever pass' },
  add: { env: 'STRIPE_PRICE_PASS_30D', label: 'Add 30 days', description: 'Mojialand 30 days added' },
  up: { env: 'STRIPE_PRICE_UPGRADE', label: 'Forever upgrade', description: 'Mojialand Forever upgrade' },
};
