import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { KEYS, setEnv, fakeDb, fakeStripe, paidSession, ev } from './helpers.mjs';
import { ALPHABET, deriveCode, normalizeCode, codeHash, codeLast4, randomCode } from '../netlify/functions/_lib/codes.mjs';
import { makeTokenPayload, signToken, verifyToken } from '../netlify/functions/_lib/token.mjs';
import { grantPass } from '../netlify/functions/_lib/grant.mjs';
import { setStripe } from '../netlify/functions/_lib/stripe.mjs';
import { originFromHost, maskEmail } from '../netlify/functions/_lib/http.mjs';
import { handler as createCheckout } from '../netlify/functions/create-checkout.mjs';
import { handler as confirmSession } from '../netlify/functions/confirm-session.mjs';
import { handler as webhook } from '../netlify/functions/stripe-webhook.mjs';
import { handler as redeem } from '../netlify/functions/redeem-code.mjs';
import { handler as contact } from '../netlify/functions/contact.mjs';

let db, stripe;
beforeEach(() => {
  setEnv();
  db = fakeDb();
  globalThis.fetch = db.fetch;
  stripe = fakeStripe();
  setStripe(stripe);
});

const CODE_RE = new RegExp('^MOJI-[' + ALPHABET + ']{4}-[' + ALPHABET + ']{4}-[' + ALPHABET + ']{4}$');

test('codes: same session gives the same code; format and alphabet', () => {
  const a = deriveCode('pep', 'cs_test_abc'), b = deriveCode('pep', 'cs_test_abc');
  assert.equal(a, b);
  assert.match(a, CODE_RE);
  assert.notEqual(a, deriveCode('pep', 'cs_test_abd'));
  assert.notEqual(a, deriveCode('other', 'cs_test_abc'));
  for (let i = 0; i < 500; i++) assert.match(deriveCode('pep', 'cs_' + i), CODE_RE);
  for (let i = 0; i < 200; i++) assert.match(randomCode(), CODE_RE);
  assert.equal(ALPHABET.length, 31);
  for (const c of '01OIL') assert.ok(!ALPHABET.includes(c));
});

test('codes: normalize and hash', () => {
  const code = deriveCode('pep', 'cs_test_1');
  const messy = ' ' + code.toLowerCase().replace(/-/g, ' ') + ' ';
  assert.equal(normalizeCode(messy), code);
  assert.equal(normalizeCode(code.replace(/-/g, '')), code);
  assert.equal(codeHash('pep', messy), codeHash('pep', code));
  assert.equal(codeHash('pep', code), crypto.createHash('sha256').update('pep' + code).digest('hex'));
  assert.notEqual(codeHash('pep', code), codeHash('pep2', code));
  assert.equal(codeLast4(code), code.slice(-4));
  assert.equal(normalizeCode('MOJI-0000-1111-2222'), null);
  assert.equal(normalizeCode('hello'), null);
  assert.equal(codeHash('pep', 'nope'), null);
});

test('token: sign and verify round trip; tampering fails', () => {
  const pass = { id: crypto.randomUUID(), kind: '48h', ends_at: new Date(Date.now() + 3600e3).toISOString() };
  const payload = makeTokenPayload(pass, 'staging');
  const tok = signToken(payload, KEYS.pem);
  assert.deepEqual(verifyToken(tok, KEYS.jwk), payload);
  const [body, sig] = tok.split('.');
  assert.equal(Buffer.from(sig, 'base64url').length, 64, 'P1363 signature is 64 bytes');
  const forged = Buffer.from(JSON.stringify({ ...payload, k: 'forever', e: 0 })).toString('base64url');
  assert.equal(verifyToken(forged + '.' + sig, KEYS.jwk), null);
  const flip = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1);
  assert.equal(verifyToken(flip + '.' + sig, KEYS.jwk), null);
  assert.equal(verifyToken(tok, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })), null);
  const fp = makeTokenPayload({ id: 'x', kind: 'forever', ends_at: null }, 'live');
  assert.equal(fp.k, 'forever'); assert.equal(fp.e, 0);
});

test('startup guard: wrong-mode keys and missing vars refuse to run', async () => {
  setEnv({ MOJIA_ENV: 'staging', STRIPE_SECRET_KEY: 'sk_live_x' });
  let r = await createCheckout(ev({ plan: 'pass' }));
  assert.equal(r.statusCode, 500); assert.equal(JSON.parse(r.body).error, 'Checkout is not set up yet.');
  setEnv({ MOJIA_ENV: 'staging', STRIPE_SECRET_KEY: 'rk_live_x' });
  assert.equal((await webhook(ev('{}'))).statusCode, 500);
  setEnv({ MOJIA_ENV: 'staging', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_abcdefghij' }))).statusCode, 500);
  setEnv({ MOJIA_ENV: undefined, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
  assert.equal((await createCheckout(ev({ plan: 'pass' }))).statusCode, 500);
  setEnv({ MOJIA_ENV: undefined, STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x' });
  assert.equal((await createCheckout(ev({ plan: 'pass' }))).statusCode, 500);
  setEnv({ MOJIA_ENV: undefined, STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
  assert.equal((await createCheckout(ev({ plan: 'pass' }))).statusCode, 200);
  setEnv({ STRIPE_PRICE_FOREVER: undefined });
  r = await createCheckout(ev({ plan: 'pass' }));
  assert.equal(r.statusCode, 500); assert.equal(r.body, JSON.stringify({ error: 'Checkout is not set up yet.' }));
  setEnv({ PASS_SIGNING_PRIVATE_KEY: undefined });
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_abcdefghij' }))).statusCode, 500);
  assert.equal(db.calls.filter((c) => !c.includes('rate_hit')).length, 0);
});

test('create-checkout: input validation', async () => {
  for (const bad of [{}, { plan: 'free' }, { plan: 'toString' }, { plan: ['pass'] }, { plan: '__proto__' }]) {
    const r = await createCheckout(ev(bad));
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await createCheckout(ev('not json'))).statusCode, 400);
  assert.equal((await createCheckout(ev({ plan: 'pass' }, {}, 'GET'))).statusCode, 405);
  assert.equal((await createCheckout(ev({ plan: 'add' }))).statusCode, 400);
  const r = await createCheckout(ev({ plan: 'up', code: 'MOJI-AAAA-BBBB-CCCC' }));
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).error, "That pass can't be changed. Pick a new pass.");
  assert.equal(stripe.calls.create.length, 0);
});

test('create-checkout: builds an embedded session from env prices only', async () => {
  const r = await createCheckout(ev({ plan: 'life', price: 1 }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { clientSecret: 'cs_test_created123_secret_abc', publishableKey: 'pk_test_fake' });
  assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
  const p = stripe.calls.create[0];
  assert.equal(p.ui_mode, 'embedded_page');
  assert.equal(p.mode, 'payment');
  assert.deepEqual(p.line_items, [{ price: 'price_forever', quantity: 1 }]);
  assert.equal(p.return_url, 'https://mojialand.displayedux.com/pass/done/?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.allow_promotion_codes, true);
  assert.equal(p.discounts, undefined);
  assert.deepEqual(p.metadata, { plan: 'life', env: 'staging' });
  assert.equal(p.customer_creation, undefined);
  // promo
  const r2 = await createCheckout(ev({ plan: 'pass', promo: 'FRIENDS50' }, { host: 'evil.example' }));
  assert.equal(r2.statusCode, 200);
  const p2 = stripe.calls.create[1];
  assert.deepEqual(p2.discounts, [{ promotion_code: 'promo_123' }]);
  assert.equal(p2.allow_promotion_codes, undefined);
  assert.ok(p2.return_url.startsWith('https://mojialand.com/'));
  assert.equal((await createCheckout(ev({ plan: 'pass', promo: 'NOPE' }))).statusCode, 400);
  assert.equal(originFromHost('localhost:8888'), 'http://localhost:8888');
  assert.equal(originFromHost('mojialand.com.evil.io'), 'https://mojialand.com');
});

test('create-checkout: add and up check the pass', async () => {
  const pep = process.env.RESTORE_CODE_PEPPER;
  const code = deriveCode(pep, 'cs_test_orig');
  const id = crypto.randomUUID();
  db.passes.push({ id, code_hash: codeHash(pep, code), kind: '48h', status: 'active', ends_at: new Date(Date.now() + 3600e3).toISOString() });
  let r = await createCheckout(ev({ plan: 'add', code: code.toLowerCase() }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stripe.calls.create.at(-1).metadata, { plan: 'add', env: 'staging', pass_id: id });
  assert.deepEqual(stripe.calls.create.at(-1).line_items, [{ price: 'price_48h', quantity: 1 }]);
  // ended 3 days ago: add refused, up allowed
  db.passes[0].status = 'ended'; db.passes[0].ends_at = new Date(Date.now() - 3 * 864e5).toISOString();
  assert.equal((await createCheckout(ev({ plan: 'add', code }))).statusCode, 400);
  r = await createCheckout(ev({ plan: 'up', code }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stripe.calls.create.at(-1).line_items, [{ price: 'price_upgrade', quantity: 1 }]);
  // ended 8 days ago: up refused
  db.passes[0].ends_at = new Date(Date.now() - 8 * 864e5).toISOString();
  assert.equal((await createCheckout(ev({ plan: 'up', code }))).statusCode, 400);
});

test('create-checkout: rate limit 5 per minute', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await createCheckout(ev({ plan: 'pass' }))).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  assert.ok([...db.rate.keys()].every((k) => /^[0-9a-f]{64}$/.test(k)), 'rate keys are hashes');
});

test('grantPass: idempotent for pass, life, add, up', async () => {
  const s = paidSession('cs_test_one', 'pass');
  const a = await grantPass(s), b = await grantPass(s);
  assert.equal(db.passes.length, 1);
  assert.equal(a.code, b.code);
  assert.equal(a.pass.id, b.pass.id);
  assert.equal(db.passes[0].code_hash, codeHash(process.env.RESTORE_CODE_PEPPER, a.code));
  assert.equal(db.passes[0].code_last4, a.code.slice(-4));
  assert.equal(db.passes[0].kind, '48h');
  assert.ok(!JSON.stringify(db.passes).includes(a.code), 'code itself never stored');
  const ends0 = new Date(db.passes[0].ends_at).getTime();
  const add = paidSession('cs_test_add', 'add', { pass_id: a.pass.id });
  await grantPass(add); await grantPass(add);
  assert.equal(new Date(db.passes[0].ends_at).getTime(), ends0 + 48 * 3600e3);
  const up = paidSession('cs_test_up', 'up', { pass_id: a.pass.id });
  const u1 = await grantPass(up), u2 = await grantPass(up);
  assert.equal(u1.pass.kind, 'forever'); assert.equal(u2.pass.kind, 'forever');
  assert.equal(db.passes[0].ends_at, null); assert.equal(u1.code, a.code, 'upgrade keeps the same code');
  const life = await grantPass(paidSession('cs_test_life', 'life'));
  assert.equal(life.pass.kind, 'forever'); assert.equal(db.passes.length, 2);
  await assert.rejects(grantPass({ ...s, payment_status: 'unpaid' }));
});

test('confirm-session: pending, paid, bad ids', async () => {
  assert.equal((await confirmSession(ev({ session_id: 'nope' }))).statusCode, 400);
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_missing1' }))).statusCode, 404);
  stripe.sessions.set('cs_test_pending1', { ...paidSession('cs_test_pending1', 'pass'), payment_status: 'unpaid', status: 'open' });
  let r = await confirmSession(ev({ session_id: 'cs_test_pending1' }));
  assert.equal(r.statusCode, 402); assert.deepEqual(JSON.parse(r.body), { status: 'pending' });
  stripe.sessions.set('cs_test_paid0001', paidSession('cs_test_paid0001', 'pass'));
  r = await confirmSession(ev({ session_id: 'cs_test_paid0001' }));
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.code, deriveCode(process.env.RESTORE_CODE_PEPPER, 'cs_test_paid0001'));
  assert.equal(d.kind, '48h'); assert.equal(d.plan, 'pass'); assert.equal(d.email_masked, 'p•••@example.com');
  const payload = verifyToken(d.token, KEYS.jwk);
  assert.ok(payload); assert.equal(payload.e, d.ends_at); assert.equal(payload.env, 'staging');
  r = await confirmSession(ev({ session_id: 'cs_test_paid0001' }));
  assert.equal(JSON.parse(r.body).code, d.code);
  assert.equal(db.passes.length, 1);
  stripe.sessions.set('cs_test_livex1', { ...paidSession('cs_test_livex1', 'pass'), metadata: { plan: 'pass', env: 'live' } });
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_livex1' }))).statusCode, 400);
  assert.equal(maskEmail('abc'), '');
});

function signed(evt, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(evt);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return ev(payload, { 'stripe-signature': sig });
}

test('webhook: bad signatures are rejected with 400 and grant nothing', async () => {
  const evt = { id: 'evt_1', type: 'checkout.session.completed', data: { object: paidSession('cs_test_wh1', 'pass') } };
  assert.equal((await webhook(signed(evt, 'whsec_wrong'))).statusCode, 400);
  assert.equal((await webhook(ev(JSON.stringify(evt), { 'stripe-signature': 't=1,v1=abc' }))).statusCode, 400);
  assert.equal((await webhook(ev(JSON.stringify(evt)))).statusCode, 400);
  const good = signed(evt);
  good.body = good.body.replace('"pass"', '"life"');
  assert.equal((await webhook(good)).statusCode, 400);
  assert.equal(db.passes.length, 0);
});

test('webhook: completed grants once and emails once; base64 body; refund; dispute', async () => {
  const s = paidSession('cs_test_wh2', 'pass');
  stripe.sessions.set(s.id, s);
  const evt = { id: 'evt_2', type: 'checkout.session.completed', data: { object: s } };
  const req = signed(evt);
  req.body = Buffer.from(req.body).toString('base64'); req.isBase64Encoded = true;
  assert.equal((await webhook(req)).statusCode, 200);
  const dup = await webhook(signed(evt));
  assert.equal(dup.statusCode, 200); assert.equal(JSON.parse(dup.body).duplicate, true);
  assert.equal((await webhook(signed({ ...evt, id: 'evt_2b' }))).statusCode, 200);
  assert.equal(db.passes.length, 1);
  assert.equal(db.emails.length, 1);
  const m = db.emails[0];
  const code = deriveCode(process.env.RESTORE_CODE_PEPPER, s.id);
  assert.equal(m.subject, 'Mojialand: your 48-hour pass');
  assert.deepEqual(m.to, ['parent@example.com']);
  assert.equal(m.reply_to, 'hello@mojialand.com');
  assert.ok(m.html.includes(code) && m.text.includes(code));
  assert.ok(m.text.includes('https://mojialand.displayedux.com/r/' + code.replace(/-/g, '')));
  assert.ok(m.text.includes('Open this email on each phone or tablet where you want Mojialand, then tap the button.'));
  assert.ok(m.html.includes('Turn on Mojialand') && m.html.includes('/logo/email-logo.png'));
  assert.ok(!m.html.includes('mailto:'), 'no mailto links');
  assert.ok(!/\u2014/.test(m.html + m.text), 'no em dashes');
  assert.ok(m.html.includes('https://displayedux.com'));
  assert.ok(/E[DS]T/.test(m.text), 'Detroit time');
  assert.ok(!/danny/i.test(m.html + m.text));
  assert.ok(db.passes[0].emailed_at);
  // add: separate email
  const add = paidSession('cs_test_wh3', 'add', { pass_id: db.passes[0].id });
  await webhook(signed({ id: 'evt_3', type: 'checkout.session.completed', data: { object: add } }));
  await webhook(signed({ id: 'evt_3b', type: 'checkout.session.completed', data: { object: add } }));
  assert.equal(db.emails.length, 2);
  assert.equal(db.emails[1].subject, 'Mojialand: 48 hours added');
  assert.ok(db.emails[1].text.includes('/r/' + code.replace(/-/g, '')), 'add email carries the same code link');
  // refund
  await webhook(signed({ id: 'evt_4', type: 'charge.refunded', data: { object: { object: 'charge', refunded: true, payment_intent: s.payment_intent } } }));
  assert.equal(db.passes[0].status, 'refunded');
  // dispute on a life pass
  const life = paidSession('cs_test_wh5', 'life');
  stripe.sessions.set(life.id, life);
  await webhook(signed({ id: 'evt_5', type: 'checkout.session.completed', data: { object: life } }));
  await webhook(signed({ id: 'evt_6', type: 'charge.dispute.created', data: { object: { object: 'dispute', payment_intent: life.payment_intent } } }));
  assert.equal(db.passes.find((p) => p.stripe_session_id === life.id).status, 'disputed');
  assert.equal(db.emails.at(-1).subject, 'Mojialand: your Forever pass');
});

test('webhook: email skipped without EMAIL_API_KEY', async () => {
  setEnv({ EMAIL_API_KEY: undefined });
  const s = paidSession('cs_test_wh7', 'life');
  assert.equal((await webhook(signed({ id: 'evt_7', type: 'checkout.session.completed', data: { object: s } }))).statusCode, 200);
  assert.equal(db.passes.length, 1);
  assert.equal(db.emails.length, 0);
});

const DEV = (n) => String(n).repeat(32).slice(0, 32);

test('confirm-session: paid but database down gives 202 paid_pending; counts the device', async () => {
  stripe.sessions.set('cs_test_grace01', paidSession('cs_test_grace01', 'pass'));
  db.down = true;
  let r = await confirmSession(ev({ session_id: 'cs_test_grace01', device_id: DEV('a') }));
  assert.equal(r.statusCode, 202); assert.deepEqual(JSON.parse(r.body), { status: 'paid_pending' });
  db.down = false;
  r = await confirmSession(ev({ session_id: 'cs_test_grace01', device_id: DEV('a') }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.devices.length, 1);
  await confirmSession(ev({ session_id: 'cs_test_grace01', device_id: DEV('a') }));
  assert.equal(db.devices.length, 1, 'same device counts once');
  assert.ok(!JSON.stringify(db.devices).includes(DEV('a')), 'device value stored only as a hash');
});

test('redeem-code: turns a pass on, counts devices, limit 5, refunds stop it', async () => {
  const s = paidSession('cs_test_red01', 'pass');
  const { code } = await grantPass(s);
  const plain = code.replace(/-/g, '').toLowerCase();
  let r = await redeem(ev({ code: plain, device_id: DEV('1') }));
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.code, code); assert.equal(d.kind, '48h');
  assert.ok(verifyToken(d.token, KEYS.jwk));
  for (const n of ['2', '3', '4', '5']) assert.equal((await redeem(ev({ code, device_id: DEV(n) }))).statusCode, 200);
  assert.equal((await redeem(ev({ code, device_id: DEV('1') }))).statusCode, 200, 'a counted device can come back');
  r = await redeem(ev({ code, device_id: DEV('6') }));
  assert.equal(r.statusCode, 409); assert.match(JSON.parse(r.body).error, /5 devices/);
  assert.equal((await redeem(ev({ code: 'MOJI-AAAA-BBBB-CCCC', device_id: DEV('1') }))).statusCode, 404);
  assert.equal((await redeem(ev({ code: 'hello', device_id: DEV('1') }))).statusCode, 400);
  assert.equal((await redeem(ev({ code, device_id: 'x' }))).statusCode, 400);
  db.passes[0].status = 'refunded';
  assert.equal((await redeem(ev({ code, device_id: DEV('1') }))).statusCode, 403);
  db.passes[0].status = 'active'; db.passes[0].ends_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await redeem(ev({ code, device_id: DEV('1') }))).statusCode, 410);
});

test('redeem-code: gift code starts on first use; rate limit', async () => {
  const code = randomCode('GIFT');
  db.passes.push({ id: crypto.randomUUID(), code_hash: codeHash(process.env.RESTORE_CODE_PEPPER, code), code_last4: codeLast4(code), prefix: 'GIFT', kind: '48h', source: 'gift', status: 'unused', device_limit: 5, ends_at: null });
  const r = await redeem(ev({ code, device_id: DEV('7') }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.passes[0].status, 'active');
  assert.ok(Math.abs(new Date(db.passes[0].ends_at).getTime() - Date.now() - 48 * 3600e3) < 5000);
  db.rateLimit = 0;
  assert.equal((await redeem(ev({ code, device_id: DEV('7') }))).statusCode, 429);
});

test('contact: validates, saves, emails support with reply-to; works when the database is down', async () => {
  assert.equal((await contact(ev({ email: 'bad', message: 'hi there' }))).statusCode, 400);
  assert.equal((await contact(ev({ email: 'a@b.co', message: '' }))).statusCode, 400);
  let r = await contact(ev({ email: 'parent@example.com', topic: 'pass', message: 'My pass is missing', session_id: 'cs_test_abc' }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.support_messages.length, 1);
  assert.ok(db.support_messages[0].message.includes('cs_test_abc'));
  const m = db.emails.at(-1);
  assert.deepEqual(m.to, ['hello@mojialand.com']); assert.equal(m.reply_to, 'parent@example.com');
  assert.ok(m.subject.startsWith('Mojialand:'));
  // a pass code identifies the pass even when the contact email differs from the paid email
  const { code, pass } = await grantPass(paidSession('cs_test_ct1', 'pass'));
  r = await contact(ev({ email: 'other@example.com', topic: 'pass', message: 'Code not working', code: code.toLowerCase() }));
  assert.equal(r.statusCode, 200);
  const saved = db.support_messages.at(-1).message;
  assert.ok(saved.includes('pass ' + pass.id) && saved.includes('paid with parent@example.com') && saved.includes('cs_test_ct1'), saved);
  assert.ok(!saved.includes(code) && !saved.includes(code.replace(/-/g, '')), 'full code never stored');
  assert.ok(db.emails.at(-1).text.includes('pass ' + pass.id));
  r = await contact(ev({ email: 'other@example.com', message: 'Lost it', code: 'MOJI-AAAA-BBBB-CCCC' }));
  assert.ok(db.support_messages.at(-1).message.includes('no pass found'));
  db.down = true;
  r = await contact(ev({ email: 'parent@example.com', topic: 'weird', message: 'Still here' }));
  assert.equal(r.statusCode, 200, 'email still goes out');
});
