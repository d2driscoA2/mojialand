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
  pass: { env: 'STRIPE_PRICE_PASS_48H', label: '48-hour pass', description: 'Mojialand 48-hour pass' },
  life: { env: 'STRIPE_PRICE_FOREVER', label: 'Forever', description: 'Mojialand Forever pass' },
  add: { env: 'STRIPE_PRICE_PASS_48H', label: 'Add 48 hours', description: 'Mojialand 48 hours added' },
  up: { env: 'STRIPE_PRICE_UPGRADE', label: 'Forever upgrade', description: 'Mojialand Forever upgrade' },
};
