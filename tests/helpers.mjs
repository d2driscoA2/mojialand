// Test helpers: environment, an in-memory PostgREST, a fake Stripe client.
import crypto from 'node:crypto';
import Stripe from 'stripe';

export function testKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    jwk: publicKey.export({ format: 'jwk' }),
  };
}

export const KEYS = testKeys();

export function setEnv(extra = {}) {
  const base = {
    MOJIA_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_secret',
    STRIPE_PRICE_PASS_48H: 'price_48h',
    STRIPE_PRICE_FOREVER: 'price_forever',
    STRIPE_PRICE_UPGRADE: 'price_upgrade',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SERVICE_KEY: 'service-key',
    EMAIL_API_KEY: 're_fake',
    EMAIL_FROM: 'Mojialand <hello@mojialand.com>',
    ADMIN_EMAIL: 'admin@example.test',
    PASS_SIGNING_PRIVATE_KEY: KEYS.pem,
    PASS_SIGNING_PUBLIC_JWK: JSON.stringify(KEYS.jwk),
    RESTORE_CODE_PEPPER: 'pepper-for-tests',
  };
  for (const [k, v] of Object.entries({ ...base, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// In-memory PostgREST covering the calls the functions make.
export function fakeDb() {
  const db = { passes: [], stripe_events: [], devices: [], support_messages: [], rate: new Map(), emails: [], calls: [], rateLimit: Infinity };
  const parseFilters = (qs) => {
    const f = [];
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (!v || ['select', 'limit', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('neq.')) { f.push((r) => String(r[k]) !== decodeURIComponent(v.slice(4))); continue; }
      if (v.startsWith('eq.')) f.push((r) => String(r[k]) === decodeURIComponent(v.slice(3)));
      else if (v === 'is.null') f.push((r) => r[k] == null);
    }
    return (r) => f.every((fn) => fn(r));
  };
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  db.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    db.calls.push(method + ' ' + u);
    if (u.startsWith('https://api.resend.com/')) {
      db.emails.push(JSON.parse(opts.body));
      return reply(200, { id: 'email_1' });
    }
    const m = /^https:\/\/db\.example\.test\/rest\/v1\/([a-z_/]+)\??(.*)$/.exec(u);
    if (!m) throw new Error('unexpected fetch ' + u);
    const [, table, qs] = m;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const prefer = (opts.headers && opts.headers.Prefer) || '';
    if (db.down) return reply(503, { message: 'down' });
    if (table === 'rpc/rate_hit') {
      const n = (db.rate.get(body.p_key) || 0) + 1;
      db.rate.set(body.p_key, n);
      return reply(200, n <= Math.min(body.p_limit, db.rateLimit));
    }
    if (table === 'settings') return reply(200, [{ value: 7 }]);
    const rows = db[table];
    if (!rows) throw new Error('unknown table ' + table);
    const match = parseFilters(qs);
    if (method === 'GET') {
      const lim = /(?:^|&)limit=(\d+)/.exec(qs);
      const hit = rows.filter(match);
      return reply(200, lim ? hit.slice(0, Number(lim[1])) : hit);
    }
    if (method === 'POST') {
      const uniq = table === 'passes' ? ['stripe_session_id', 'code_hash', 'id'] : table === 'stripe_events' ? ['event_id'] : [];
      const dupDevice = table === 'devices' && rows.some((r) => r.pass_id === body.pass_id && r.device_id_hash === body.device_id_hash);
      if (dupDevice || rows.some((r) => uniq.some((k) => body[k] != null && r[k] === body[k]))) {
        if (!prefer.includes('ignore-duplicates')) return reply(409, { message: 'duplicate' });
        return reply(prefer.includes('return=representation') ? 200 : 201, prefer.includes('return=representation') ? [] : undefined);
      }
      const row = table === 'passes' ? { id: crypto.randomUUID(), emailed_at: null, note: null, ...body } : { ...body };
      rows.push(row);
      return reply(201, prefer.includes('return=representation') ? [row] : undefined);
    }
    if (method === 'PATCH') {
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, body));
      return reply(200, hit);
    }
    if (method === 'DELETE') {
      db[table] = rows.filter((r) => !match(r));
      return reply(204);
    }
    throw new Error('unhandled ' + method);
  };
  return db;
}

// Real webhook helpers, fake network calls.
export function fakeStripe(overrides = {}) {
  const real = new Stripe('sk_test_fake');
  const calls = { create: [], promo: [], retrieve: [], list: [] };
  const sessions = new Map();
  const fake = {
    calls,
    sessions,
    webhooks: real.webhooks,
    checkout: {
      sessions: {
        create: async (p) => { calls.create.push(p); return { id: 'cs_test_created123', client_secret: 'cs_test_created123_secret_abc' }; },
        retrieve: async (id) => {
          calls.retrieve.push(id);
          if (!sessions.has(id)) { const e = new Error('No such session'); e.statusCode = 404; throw e; }
          return sessions.get(id);
        },
        list: async (p) => { calls.list.push(p); return { data: [...sessions.values()].filter((s) => s.payment_intent === p.payment_intent) }; },
      },
    },
    promotionCodes: {
      list: async (p) => { calls.promo.push(p); return { data: p.code === 'FRIENDS50' ? [{ id: 'promo_123', code: 'FRIENDS50' }] : [] }; },
    },
    ...overrides,
  };
  return fake;
}

export function paidSession(id, plan, extra = {}) {
  return {
    id,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    amount_total: plan === 'life' ? 1499 : plan === 'up' ? 1349 : 150,
    customer_details: { email: 'parent@example.com' },
    payment_intent: 'pi_' + id,
    return_url: 'https://mojialand.displayedux.com/pass/done/?session_id={CHECKOUT_SESSION_ID}',
    metadata: { plan, env: 'staging', ...extra },
  };
}

export const ev = (body, headers = {}, method = 'POST') => ({
  httpMethod: method,
  headers: { host: 'mojialand.displayedux.com', 'x-nf-client-connection-ip': '203.0.113.9', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  isBase64Encoded: false,
});
