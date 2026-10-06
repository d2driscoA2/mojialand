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
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
  };
  for (const [k, v] of Object.entries({ ...base, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// In-memory PostgREST covering the calls the functions make.
export function fakeDb() {
  const db = { passes: [], stripe_events: [], devices: [], support_messages: [], admin_codes: [], admin_sessions: [], granted_checkouts: [], handoffs: [], pairings: [], plays_live: [], campaigns: [], analytics: [], campaignEvents: [], rpcData: {}, push_subs: [], alert_counts: [], alerts: [], pushes: [], pushStatus: 201, settings: [{ key: 'daily_minutes', value: 3, help: 'x' }, { key: 'daily_reset', value: '04:00', help: 'y' }], rate: new Map(), emails: [], calls: [], rateLimit: Infinity };
  const parseFilters = (qs) => {
    const f = [];
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (!v || ['select', 'limit', 'on_conflict', 'offset'].includes(k)) continue;
      if (v.startsWith('in.(')) { const set = decodeURIComponent(v.slice(4, -1)).split(','); f.push((r) => set.includes(String(r[k]))); continue; }
      if (k === 'or') { const parts = decodeURIComponent(v).replace(/^\(|\)$/g, '').split(',').map((x) => { const [col, op, ...rest] = x.split('.'); return { col, op, val: rest.join('.').replace(/\*/g, '').toLowerCase() }; });
        f.push((r) => parts.some((pt) => pt.op === 'ilike' && String(r[pt.col] || '').toLowerCase().includes(pt.val))); continue; }
      if (v.startsWith('neq.')) { f.push((r) => String(r[k]) !== decodeURIComponent(v.slice(4))); continue; }
      if (v.startsWith('ilike.')) { const needle = decodeURIComponent(v.slice(6)).replace(/\*/g, '').toLowerCase(); f.push((r) => String(r[k] || '').toLowerCase().includes(needle)); continue; }
      if (k === 'order') continue;
      if (v.startsWith('eq.')) f.push((r) => String(r[k]) === decodeURIComponent(v.slice(3)));
      else if (v === 'is.null') f.push((r) => r[k] == null);
      else if (v.startsWith('gte.')) f.push((r) => String(r[k]) >= decodeURIComponent(v.slice(4)));
    }
    return (r) => f.every((fn) => fn(r));
  };
  const reply = (status, body) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status });
  db.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    db.calls.push(method + ' ' + u);
    if (u.startsWith('https://web.push.apple.com/')) {
      db.pushes.push({ url: u, headers: opts.headers, body: Buffer.from(opts.body) });
      return reply(db.pushStatus);
    }
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
    // Release 1.1.1 #38: admin sign-in functions (same rules as supabase/release-1.1.1-38-admin.sql)
    if (table === 'rpc/admin_locked') return reply(200, !!db.adminLockAt && Date.now() - db.adminLockAt < 3600e3);
    if (table === 'rpc/admin_code_new') {
      if (db.adminLockAt && Date.now() - db.adminLockAt < 3600e3) return reply(200, false);
      db.admin_codes.forEach((r) => { if (!r.used) r.used = true; });
      db.admin_codes.push({ id: body.p_id, code_hash: body.p_hash, expires_at: body.p_expires, tries: 0, used: false });
      return reply(200, true);
    }
    if (table === 'rpc/admin_code_check') {
      if (db.adminLockAt && Date.now() - db.adminLockAt < 3600e3) return reply(200, 'locked');
      const r = db.admin_codes.find((x) => x.id === body.p_id && !x.used && x.tries < 5 && new Date(x.expires_at).getTime() > Date.now());
      if (r) { r.tries++; if (r.code_hash === body.p_hash) { r.used = true; return reply(200, 'ok'); } }
      db.adminFails = (db.adminFails || 0) + 1;
      if (db.adminFails > 20) { if (!db.adminLockAt) db.adminLockAt = Date.now(); db.admin_codes.forEach((x) => { x.used = true; }); return reply(200, db.adminFails === 21 ? 'lockednow' : 'locked'); }
      return reply(200, 'bad');
    }
    if (table === 'rpc/device_add') {
      if (db.devices.some((r) => r.pass_id === body.p_pass && r.device_id_hash === body.p_hash)) return reply(200, 'ok');
      if (db.devices.filter((r) => r.pass_id === body.p_pass).length >= body.p_limit) return reply(200, 'limit');
      db.devices.push({ id: crypto.randomUUID(), pass_id: body.p_pass, device_id_hash: body.p_hash });
      return reply(200, 'ok');
    }
    if (table === 'rpc/alert_add') { db.alerts.push(body); return reply(200, 1); }
    if (table === 'rpc/analytics_add') { db.analytics.push(body); return reply(204); }
    if (table === 'rpc/campaign_add') {
      const ok = db.campaigns.some((c) => c.label === body.p_label && c.active !== false);
      if (ok) db.campaignEvents.push(body);
      return reply(200, ok);
    }
    if (table === 'rpc/analytics_history' || table === 'rpc/campaign_stats') { db.rpcCalls = (db.rpcCalls || []).concat([[table, body]]); return reply(200, db.rpcData[table.slice(4)] || {}); }
    if (table === 'settings' && method === 'GET' && /key=eq\.alerts_mode/.test(qs)) return reply(200, db.settings.filter((r) => r.key === 'alerts_mode').map((r) => ({ value: r.value })));
    if (table === 'settings' && method === 'GET' && /select=value/.test(qs)) return reply(200, [{ value: 7 }]);
    const rows = db[table];
    if (!rows) throw new Error('unknown table ' + table);
    const match = parseFilters(qs);
    if (method === 'GET') {
      const lim = /(?:^|&)limit=(\d+)/.exec(qs);
      const sel = /(?:^|&)select=([^&]+)/.exec(qs);
      let hit = rows.filter(match);
      if (sel && sel[1] !== '*') { const cols = decodeURIComponent(sel[1]).split(','); hit = hit.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]))); }
      return reply(200, lim ? hit.slice(0, Number(lim[1])) : hit);
    }
    if (method === 'POST') {
      const uniq = table === 'passes' ? ['stripe_session_id', 'code_hash', 'id'] : table === 'stripe_events' ? ['event_id'] : table === 'admin_sessions' ? ['token_hash'] : table === 'handoffs' ? ['key_hash'] : table === 'granted_checkouts' ? ['session_id'] : [];
      if (table === 'handoffs' && prefer.includes('merge-duplicates')) { const i = rows.findIndex((r) => r.key_hash === body.key_hash); if (i >= 0) { Object.assign(rows[i], body); return reply(201); } }
      if ((table === 'push_subs' || table === 'settings') && prefer.includes('merge-duplicates')) { const k = table === 'push_subs' ? 'endpoint' : 'key'; const i = rows.findIndex((r) => r[k] === body[k]); if (i >= 0) { Object.assign(rows[i], body); return reply(201); } }
      const dupDevice = table === 'devices' && rows.some((r) => r.pass_id === body.pass_id && r.device_id_hash === body.device_id_hash);
      if (dupDevice || rows.some((r) => uniq.some((k) => body[k] != null && r[k] === body[k]))) {
        if (!prefer.includes('ignore-duplicates')) return reply(409, { message: 'duplicate' });
        return reply(prefer.includes('return=representation') ? 200 : 201, prefer.includes('return=representation') ? [] : undefined);
      }
      const row = table === 'passes' ? { id: crypto.randomUUID(), emailed_at: null, note: null, created_at: new Date().toISOString(), ...body }
        : table === 'admin_codes' ? { tries: 0, used: false, ...body }
        : table === 'support_messages' ? { id: crypto.randomUUID(), status: 'open', created_at: new Date().toISOString(), ...body } : { ...body };
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
      list: async (p) => { calls.promo.push(p); return { data: String(p.code).toUpperCase() === 'FRIENDS50' ? [{ id: 'promo_123', code: 'FRIENDS50', coupon: { percent_off: 50, amount_off: null, valid: true, name: 'Friends' } }] : [] }; },
    },
    refunds: { create: async (p) => { calls.refunds = calls.refunds || []; calls.refunds.push(p); return { id: 're_1', status: 'succeeded' }; } },
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
  headers: { host: 'mojialand.displayedux.com', origin: 'https://mojialand.displayedux.com', 'x-nf-client-connection-ip': '203.0.113.9', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  isBase64Encoded: false,
});
